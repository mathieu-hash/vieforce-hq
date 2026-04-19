const { query, queryH, queryBoth } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { scopeForUser } = require('./_scope')
const { toHistoricalCode } = require('./lib/customer-map')
const cache = require('../lib/cache')

// Whitelist a list of numeric IDs for safe SQL inlining.
// scope.slpCodes / districtCodes originate from our own Supabase users table
// but we still integer-filter defensively (buildScopeWhere uses the same guard).
function intList(arr, { excludeOne = false } = {}) {
  return (arr || [])
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0 && (!excludeOne || n !== 1))
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — try service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'Missing required parameter: id' })

  // Parse optional scope=user:<uuid>. When present, resolve to SlpCode / district
  // whitelist and enforce access control BEFORE running the 360° query.
  let scope = null
  const scopeParam = req.query.scope
  if (scopeParam && typeof scopeParam === 'string' && scopeParam.startsWith('user:')) {
    const uuid = scopeParam.slice(5).trim()
    if (uuid) {
      try {
        scope = await scopeForUser(uuid)
      } catch (err) {
        console.error('[customer] scope resolve failed:', err.message)
        scope = { userId: uuid, error: 'scope_resolve_failed', is_empty: true,
                  slpCodes: [], districtCodes: [] }
      }
    }
  }

  // Access control — short-circuit with 404 (privacy: never leak existence)
  if (scope) {
    // 1. No sap_slpcode mapped yet → the user has no scope → sees nothing
    if (scope.is_empty) {
      return res.status(404).json({ error: 'Customer not found' })
    }
    // 2. Scope is bounded (not exec/ceo/service 'ALL') → verify cardcode falls in it
    if (scope.slpCodes !== 'ALL') {
      const slps  = intList(scope.slpCodes, { excludeOne: true })
      const dists = intList(scope.districtCodes)
      if (!slps.length && !dists.length) {
        return res.status(404).json({ error: 'Customer not found' })
      }
      const orClauses = []
      if (slps.length)  orClauses.push(`T.SlpCode IN (${slps.join(',')})`)
      if (dists.length) orClauses.push(`T.U_districtName IN (${dists.join(',')})`)
      const accessRows = await query(`
        SELECT 1 AS in_scope
        FROM OCRD T
        WHERE T.CardCode = @id
          AND T.validFor = 'Y'
          AND T.CardType = 'C'
          AND T.CardCode NOT LIKE 'CE%'
          AND T.SlpCode <> 1
          AND (${orClauses.join(' OR ')})
      `, { id })
      if (!accessRows.length) {
        return res.status(404).json({ error: 'Customer not found' })
      }
    }
  }

  // Cache key MUST include the resolved scope user — otherwise user A's cached
  // response could leak to user B on the next request with a different scope.
  const scopeKey = scope ? `_u:${scope.userId}:${scope.role || 'unknown'}` : ''
  const cacheKey = `customer_${id}_${session.role}_${session.region || 'ALL'}${scopeKey}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // --- Customer info from OCRD ---
    // Exclude employee self-invoicing (CE%) and SlpCode=1 (VPI house account)
    // defensively — these should never appear in the UI customer list, so a
    // direct request for one is almost certainly a mistake or probing.
    const infoRows = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        T0.Phone1,
        T0.Phone2,
        T0.Cellular,
        T0.E_Mail    AS email,
        T0.City,
        T0.Address,
        T0.SlpCode,
        S.SlpName    AS rsm
      FROM OCRD T0
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE T0.CardCode = @id
        AND T0.CardType = 'C'
        AND T0.CardCode NOT LIKE 'CE%'
        AND T0.SlpCode <> 1
    `, { id })

    if (!infoRows.length) {
      return res.status(404).json({ error: 'Customer not found' })
    }

    const info = infoRows[0]

    // --- YTD Sales summary ---
    const ytdRows = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue,
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume,
        COUNT(DISTINCT T0.DocEntry)                                        AS orders_count
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
    `, { id })

    const ytd_sales = {
      revenue:      ytdRows[0]?.revenue || 0,
      volume_bags:  ytdRows[0]?.volume_bags || 0,
      volume:       ytdRows[0]?.volume || 0,
      orders_count: ytdRows[0]?.orders_count || 0
    }

    // --- AR: unpaid invoices ---
    const ar_invoices = await query(`
      SELECT
        T0.DocNum,
        T0.DocDate,
        T0.DocDueDate,
        T0.DocTotal,
        T0.PaidToDate,
        T0.DocTotal - T0.PaidToDate                    AS balance,
        DATEDIFF(DAY, T0.DocDueDate, GETDATE())        AS days_overdue
      FROM OINV T0
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
        AND T0.DocTotal > T0.PaidToDate
      ORDER BY T0.DocDueDate ASC
    `, { id })

    // --- Product breakdown (YTD by item) ---
    const product_breakdown = await query(`
      SELECT
        T1.ItemCode,
        T1.Dscription                                                       AS item_name,
        ISNULL(SUM(T1.Quantity), 0)                                         AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)      AS volume,
        ISNULL(SUM(T1.LineTotal), 0)                                        AS revenue,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                         AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
      GROUP BY T1.ItemCode, T1.Dscription
      ORDER BY volume DESC
    `, { id })

    // --- Recent orders (last 10) ---
    const recent_orders = await query(`
      SELECT TOP 10
        T0.DocNum,
        T0.DocDate,
        T0.DocTotal,
        T0.DocStatus,
        T0.PaidToDate,
        (SELECT ISNULL(SUM(T1.Quantity), 0) FROM INV1 T1 WHERE T1.DocEntry = T0.DocEntry) AS total_qty
      FROM OINV T0
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
      ORDER BY T0.DocDate DESC
    `, { id })

    // --- MTD sales ---
    const mtdStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const mtdRows = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mtd_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS mtd_sales
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
        AND T0.DocDate >= @mtdStart
    `, { id, mtdStart })

    // --- GM/Ton ---
    const gmRow = await query(`
      SELECT
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
    `, { id })

    // --- DSO for this customer ---
    const dsoRow = await query(`
      SELECT
        CASE WHEN SUM(T0.DocTotal) > 0
          THEN SUM(CASE WHEN T0.DocTotal > T0.PaidToDate THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) /
               (SUM(T0.DocTotal) / 365.0)
          ELSE 0 END AS dso
      FROM OINV T0
      WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
    `, { id })

    // --- CY vs LY monthly volume (last 24 months) — spans 2026-01-01 cutoff ---
    // The Jan 2026 SAP migration RE-KEYED every CardCode (CL00xxx → CA000xxx).
    // We must look up the historical CardCode by name before querying historical.
    const histId = await toHistoricalCode(id).catch(() => null)
    const CY_LY_SQL = `
      SELECT
        MONTH(T0.DocDate)                                                AS month_num,
        FORMAT(T0.DocDate, 'MMM')                                        AS month_name,
        YEAR(T0.DocDate)                                                 AS yr,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)), 0)             AS kg,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS gp
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(MONTH, -24, GETDATE())
      GROUP BY MONTH(T0.DocDate), FORMAT(T0.DocDate, 'MMM'), YEAR(T0.DocDate)
    `
    const [cyRaw, lyRaw] = await Promise.all([
      query(CY_LY_SQL, { id }),
      histId
        ? queryH(CY_LY_SQL, { id: histId }).catch(() => [])
        : Promise.resolve([])
    ])
    const cyLyRaw = [...cyRaw, ...lyRaw]

    // Sum across DBs by (yr, month_num) — defensive against migration-period overlap
    const cyLyMap = {}
    for (const r of cyLyRaw) {
      const k = `${r.yr}-${r.month_num}`
      const cur = cyLyMap[k] || { month_num: r.month_num, month_name: r.month_name, yr: r.yr, vol: 0, sales: 0, kg: 0, gp: 0 }
      cur.vol   += Number(r.vol   || 0)
      cur.sales += Number(r.sales || 0)
      cur.kg    += Number(r.kg    || 0)
      cur.gp    += Number(r.gp    || 0)
      cyLyMap[k] = cur
    }
    const cyLy = Object.values(cyLyMap).map(r => ({
      ...r,
      gm_ton: r.kg > 0 ? r.gp / (r.kg / 1000.0) : 0
    })).sort((a, b) => (a.yr - b.yr) || (a.month_num - b.month_num))

    const currentYear = new Date().getFullYear()
    const lastYear = currentYear - 1
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    const cy_vol = months.map((_, i) => {
      const m = cyLy.find(r => r.yr === currentYear && r.month_num === i + 1)
      return m ? Math.round(m.vol * 10) / 10 : 0
    })
    const ly_vol = months.map((_, i) => {
      const m = cyLy.find(r => r.yr === lastYear && r.month_num === i + 1)
      return m ? Math.round(m.vol * 10) / 10 : 0
    })

    // --- 12-month table ---
    const monthly_table = months.map((name, i) => {
      const cy = cyLy.find(r => r.yr === currentYear && r.month_num === i + 1)
      const ly = cyLy.find(r => r.yr === lastYear && r.month_num === i + 1)
      const cyVol = cy ? cy.vol : 0
      const lyVol = ly ? ly.vol : 0
      return {
        month: name,
        vol_cy: Math.round(cyVol * 10) / 10,
        vol_ly: Math.round(lyVol * 10) / 10,
        vs_ly_pct: lyVol > 0 ? Math.round(((cyVol - lyVol) / lyVol) * 100) : 0,
        sales: cy ? Math.round(cy.sales) : 0,
        gm_ton: cy ? Math.round(cy.gm_ton) : 0
      }
    })

    // --- Account age ---
    // CreateDate from current DB shows the SAP record creation; use the earlier of
    // (current_OCRD.CreateDate, historical_first_invoice_date) to capture true tenure
    // for customers established before the 2026 migration.
    const ageRow = await query(`
      SELECT DATEDIFF(DAY, T0.CreateDate, GETDATE()) AS age_days,
             T0.CreateDate AS create_date
      FROM OCRD T0
      WHERE T0.CardCode = @id
    `, { id })

    const histFirst = histId
      ? await queryH(`
          SELECT MIN(T0.DocDate) AS first_inv_date
          FROM OINV T0
          WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
        `, { id: histId }).catch(() => [{ first_inv_date: null }])
      : [{ first_inv_date: null }]

    const histFirstDate = histFirst[0]?.first_inv_date
    const createDate = ageRow[0]?.create_date
    let trueFirstDate = createDate
    if (histFirstDate && (!createDate || new Date(histFirstDate) < new Date(createDate))) {
      trueFirstDate = histFirstDate
    }
    const trueAgeDays = trueFirstDate
      ? Math.floor((Date.now() - new Date(trueFirstDate).getTime()) / 86400000)
      : (ageRow[0]?.age_days || 0)

    // --- Volume rank ---
    const rankRow = await query(`
      SELECT COUNT(*) + 1 AS rank_num
      FROM (
        SELECT T0.CardCode, SUM(T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0) AS vol
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CANCELED = 'N' AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
        GROUP BY T0.CardCode
        HAVING SUM(T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0) > @custVol
      ) sub
    `, { id, custVol: ytd_sales.volume })

    // 8 enriched KPIs
    const kpis = {
      ytd_vol: Math.round(ytd_sales.volume * 10) / 10,
      mtd_vol: Math.round((mtdRows[0]?.mtd_vol || 0) * 10) / 10,
      ytd_sales: Math.round(ytd_sales.revenue),
      mtd_sales: Math.round(mtdRows[0]?.mtd_sales || 0),
      gm_ton: Math.round(gmRow[0]?.gm_ton || 0),
      dso: Math.round(dsoRow[0]?.dso || 0),
      avg_order: ytd_sales.orders_count > 0 ? Math.round(ytd_sales.revenue / ytd_sales.orders_count) : 0,
      frequency: ytd_sales.orders_count
    }

    const result = {
      info,
      ytd_sales,
      kpis,
      ar_invoices,
      product_breakdown,
      recent_orders,
      cy_vs_ly: { months, cy_vol, ly_vol },
      monthly_table,
      account_age_days: trueAgeDays,
      first_order_date: trueFirstDate,
      rank_by_volume: rankRow[0]?.rank_num || 0
    }
    // Optional scope meta — only present when the caller passed ?scope=user:<uuid>.
    // Omitted entirely on the no-scope path so the existing web dashboard response
    // shape is byte-identical to pre-migration behavior.
    if (scope) {
      result.scope = {
        userId: scope.userId,
        role: scope.role || null,
        is_empty: !!scope.is_empty,
        access_granted: true
      }
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [customer]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
