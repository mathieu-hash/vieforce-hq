const { query, queryH } = require('./_db')
const { verifySession, verifyServiceToken, applyRoleFilter } = require('./_auth')
const { scopeForUser, buildScopeWhere } = require('./_scope')
const cache = require('../lib/cache')
const { isNonCustomerRow } = require('./lib/non-customer-codes')
const { rekeyHistoricalRows } = require('./lib/customer-map')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — try service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Parse pagination / filter params up front so zero-state can echo them back.
  const { search = '', region = 'ALL', page = '1', limit = '50', sort = 'revenue' } = req.query
  const pageNum  = Math.max(1, parseInt(page) || 1)
  const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50))
  const offset   = (pageNum - 1) * limitNum

  // Parse optional scope=user:<uuid>. Same pattern as /api/sales + /api/customer.
  let scope = null
  const scopeParam = req.query.scope
  if (scopeParam && typeof scopeParam === 'string' && scopeParam.startsWith('user:')) {
    const uuid = scopeParam.slice(5).trim()
    if (uuid) {
      try {
        scope = await scopeForUser(uuid)
      } catch (err) {
        console.error('[customers] scope resolve failed:', err.message)
        scope = { userId: uuid, error: 'scope_resolve_failed', is_empty: true,
                  slpCodes: [], districtCodes: [] }
      }
    }
  }

  // EXISTS-based WHERE fragment that restricts to the caller's SlpCodes +
  // districts. '' when scope is 'ALL' or no scope param was passed.
  const scopeFilter = buildScopeWhere(scope, 'T0')

  // Zero-state short-circuit — no SQL, shape matches normal response so
  // Patrol renders a consistent "no data" view without branching.
  if (scopeFilter.isEmpty) {
    return res.json({
      customers: [],
      total: 0,
      page: 1,
      pages: 0,
      limit: limitNum,
      non_customer_excluded: 0,
      scope: scope ? {
        userId: scope.userId,
        role: scope.role || null,
        is_empty: true,
        slpCodes_count: 0
      } : undefined
    })
  }

  // Cache key includes scope so user A's cached rows can't leak to user B.
  const scopeKey = scope ? `_u:${scope.userId}:${scope.role || 'unknown'}` : ''
  const cacheKey = `customers_v2_${req.url}_${session.role}_${session.region || 'ALL'}${scopeKey}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // Build base WHERE. CE% + SlpCode=1 exclusions are defense-in-depth: they
    // apply to BOTH scoped and session-auth paths so employee self-invoicing
    // accounts and the VPI house account never leak into the list for anyone.
    let baseWhere = `WHERE T0.CardType = 'C' AND T0.CardCode NOT LIKE 'CE%' AND T0.SlpCode <> 1`
    if (search) baseWhere += ` AND T0.CardName LIKE '%' + @search + '%'`
    // applyRoleFilter kept as a no-op pass-through for symmetry with other
    // endpoints; swap to scopeFilter.sql when a scope was resolved.
    const filteredWhere = baseWhere + (scopeFilter.sql || '')

    // Region filter applied on derived region column
    const regionFilter = region && region !== 'ALL' ? ` AND dom_region = @region` : ''

    // Main query — one row per customer, with derived region (dominant WhsCode across YTD invoices),
    // BU classification (inferred from OCRD.GroupCode UDF or CardName prefix), and YTD gm_ton.
    const customers = await query(`
      WITH CustomerYTD AS (
        SELECT
          T0.CardCode,
          T0.CardName,
          T0.Phone1,
          T0.City,
          MAX(C.U_BpStatus)                                                   AS bp_status,
          MAX(C.frozenFor)                                                    AS frozen_for,
          MAX(S.SlpName)                                                      AS rsm,
          ISNULL(SUM(T1.LineTotal), 0)                                        AS ytd_revenue,
          ISNULL(SUM(T1.Quantity), 0)                                         AS ytd_bags,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)       AS ytd_volume,
          ISNULL(SUM(T1.GrssProfit), 0)                                       AS ytd_gm,
          MAX(TI.DocDate)                                                      AS last_order_date,
          -- Dominant WhsCode (most-invoiced plant) → region
          (SELECT TOP 1
            CASE
              WHEN T2.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
              WHEN T2.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
              WHEN T2.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
              ELSE 'Other'
            END
           FROM OINV TI2
           INNER JOIN INV1 T2 ON T2.DocEntry = TI2.DocEntry
           WHERE TI2.CardCode = T0.CardCode AND TI2.CANCELED = 'N'
             AND TI2.DocDate >= DATEADD(YEAR, -1, GETDATE())
           GROUP BY
             CASE
              WHEN T2.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
              WHEN T2.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
              WHEN T2.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
              ELSE 'Other'
             END
           ORDER BY SUM(T2.LineTotal) DESC
          ) AS dom_region
        FROM OCRD T0
        LEFT JOIN OINV TI ON TI.CardCode = T0.CardCode
          AND TI.DocDate >= DATEADD(YEAR, -1, GETDATE())
          AND TI.CANCELED = 'N'
        LEFT JOIN INV1 T1 ON T1.DocEntry = TI.DocEntry
        LEFT JOIN OITM I  ON T1.ItemCode = I.ItemCode
        LEFT JOIN OSLP S  ON TI.SlpCode = S.SlpCode
        LEFT JOIN OCRD C  ON T0.CardCode = C.CardCode
        ${filteredWhere}
        GROUP BY T0.CardCode, T0.CardName, T0.Phone1, T0.City
      )
      SELECT
        CardCode, CardName, Phone1, City, bp_status, frozen_for, rsm,
        ytd_revenue, ytd_bags, ytd_volume,
        CASE WHEN ytd_volume > 0 THEN ytd_gm / ytd_volume ELSE 0 END AS ytd_gm_ton,
        last_order_date,
        ISNULL(dom_region, 'Other') AS region,
        -- BU classifier: PET if name contains pet brand; else DIST (default)
        CASE
          WHEN UPPER(CardName) LIKE '%PET%' OR UPPER(CardName) LIKE '%KEOS%' THEN 'PET'
          ELSE 'DIST'
        END AS bu,
        -- Status classifier
        CASE
          WHEN frozen_for = 'Y' OR bp_status IN ('Delinquent','InActive') THEN 'Delinquent'
          WHEN ytd_revenue = 0 THEN 'Dormant'
          ELSE 'Active'
        END AS status
      FROM CustomerYTD
      WHERE 1=1 ${regionFilter}
      ORDER BY
        CASE WHEN @sort = 'revenue' THEN ytd_revenue END DESC,
        CASE WHEN @sort = 'volume'  THEN ytd_volume  END DESC,
        CASE WHEN @sort = 'name'    THEN CardName    END ASC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, { search, region, sort, offset, limit: limitNum })

    const countRows = await query(`
      SELECT COUNT(*) AS total
      FROM OCRD T0
      LEFT JOIN OCRD C ON T0.CardCode = C.CardCode
      ${filteredWhere}
    `, { search })
    const total = countRows[0]?.total || 0
    const pages = Math.ceil(total / limitNum)

    // --- LY per-customer volume + YTD-rank (from historical DB) ---
    // LY YTD = 2025-01-01 → same (month, day) of 2025.
    // Full-year 2025 rank is used for rank_change (#N LY → #M this year).
    const lyYtdFrom = new Date(new Date().getFullYear() - 1, 0, 1)
    const lyYtdTo   = new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate())
    const lyRows = await queryH(`
      SELECT
        T0.CardCode                                                     AS code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS ly_volume,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS ly_revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CANCELED = 'N'
        AND T0.DocDate BETWEEN @lyFrom AND @lyTo
      GROUP BY T0.CardCode
    `, { lyFrom: lyYtdFrom, lyTo: lyYtdTo }).catch(e => {
      console.warn('[customers] LY YTD query failed:', e.message); return []
    })

    const lyFullYearRows = await queryH(`
      SELECT
        T0.CardCode                                                     AS code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS ly_fy_volume
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.CANCELED = 'N'
        AND YEAR(T0.DocDate) = YEAR(DATEADD(YEAR,-1,GETDATE()))
      GROUP BY T0.CardCode
    `).catch(e => {
      console.warn('[customers] LY full-year query failed:', e.message); return []
    })

    // Translate historical CardCodes back to current CardCodes via the name-based map.
    // Rows whose historical code has no current equivalent are dropped (e.g. dormant
    // pre-2026 customers not carried over — they can't be compared YoY in any case).
    const lyRowsMapped = await rekeyHistoricalRows(lyRows, 'code').catch(() => [])
    const lyFullYearMapped = await rekeyHistoricalRows(lyFullYearRows, 'code').catch(() => [])

    const lyYtdMap = Object.fromEntries(lyRowsMapped.map(r => [r.code, r]))
    const lyFyMap = Object.fromEntries(lyFullYearMapped.map(r => [r.code, Number(r.ly_fy_volume || 0)]))

    // Rank by LY full-year volume (using translated current codes)
    const lyRanked = [...lyFullYearMapped].sort((a, b) => b.ly_fy_volume - a.ly_fy_volume)
    const lyRankByCode = {}
    lyRanked.forEach((r, i) => { lyRankByCode[r.code] = i + 1 })

    // Filter out warehouse/internal CardCodes before returning
    const customersClean = customers
      .filter(c => !isNonCustomerRow(c.CardCode, c.CardName))
      .map(c => {
        const ly = lyYtdMap[c.CardCode] || {}
        const lyVol = Number(ly.ly_volume || 0)
        const cyVol = Number(c.ytd_volume || 0)
        return {
          ...c,
          ly_volume: Math.round(lyVol * 10) / 10,
          ly_revenue: Math.round(Number(ly.ly_revenue || 0)),
          vs_ly_pct: lyVol > 0 ? Math.round(((cyVol - lyVol) / lyVol) * 1000) / 10 : null,
          ly_rank: lyRankByCode[c.CardCode] || null
        }
      })

    // Current-year rank (by ytd_volume, within the filtered set)
    const cyRanked = [...customersClean].sort((a, b) => Number(b.ytd_volume || 0) - Number(a.ytd_volume || 0))
    const cyRankByCode = {}
    cyRanked.forEach((c, i) => { cyRankByCode[c.CardCode] = i + 1 })
    for (const c of customersClean) {
      c.cy_rank = cyRankByCode[c.CardCode] || null
      c.rank_change = c.ly_rank && c.cy_rank ? c.ly_rank - c.cy_rank : null  // positive = moved up
    }

    const excluded = customers.length - customersClean.length
    const result = {
      customers: customersClean,
      total: Math.max(0, total - excluded),
      page: pageNum, pages, limit: limitNum,
      non_customer_excluded: excluded
    }
    // Scope meta — only when caller passed ?scope=user:<uuid>. Web dashboard
    // (session auth, no scope) sees a byte-identical response.
    if (scope) {
      result.scope = {
        userId: scope.userId,
        role: scope.role || null,
        is_empty: !!scope.is_empty,
        slpCodes_count: scope.slpCodes === 'ALL' ? 'ALL' : (scope.slpCodes || []).length
      }
    }
    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [customers]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
