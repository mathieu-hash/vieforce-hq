const { query, queryBoth, queryDateRange } = require('./_db')
const { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter } = require('./_auth')
const { scopeForUser, buildScopeWhere, emptySalesPayload, scopeResponseMeta } = require('./_scope')
const cache = require('../lib/cache')
const { normalizeRegion, normalizeSegment, regionFilterSql, regionCaseSql, segmentFilterSql, filterMeta } = require('./lib/business_filters')

// Canonical plant (WhsCode) → region map — aligned with api/lib/margin_cube.js.
// BAC = BACOLOD (Visayas), ALAE/SOUTH/CAG = Mindanao, PFMIS/PFMCIS = Isabela (Luzon).
const PO_PLANT_REGION = {
  AC: 'Luzon', ACEXT: 'Luzon', PFMIS: 'Luzon', PFMCIS: 'Luzon',
  HOREB: 'Visayas', HBEXT: 'Visayas', 'HBEXT-QA': 'Visayas', BAC: 'Visayas', ARGAO: 'Visayas',
  BUKID: 'Mindanao', SOUTH: 'Mindanao', CAG: 'Mindanao', ALAE: 'Mindanao', CCPC: 'Mindanao'
}
function plantRegion(plant) { return PO_PLANT_REGION[plant] || 'Other' }

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — try service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Parse optional scope=user:<uuid> — Patrol passes this to get user-scoped data.
  // When absent, behavior is identical to the pre-scope implementation.
  let scope = null
  const scopeParam = req.query.scope
  if (scopeParam && typeof scopeParam === 'string' && scopeParam.startsWith('user:')) {
    const uuid = scopeParam.slice(5).trim()
    if (uuid) {
      scope = await scopeForUser(uuid).catch(err => {
        console.warn('[sales] scopeForUser failed:', err.message)
        return { userId: uuid, error: 'scope_resolve_failed', is_empty: true, slpCodes: [], districtCodes: [] }
      })
    }
  }

  const scopeFilter = buildScopeWhere(scope, 'T0')

  // Short-circuit: empty scope returns zero-state payload so Patrol UI can
  // render a consistent "no data" view without branching on error paths.
  if (scopeFilter.isEmpty) {
    return res.json(emptySalesPayload(scopeResponseMeta(scope)))
  }

  // Cache check — include scope in key so user A's cached rows don't leak to user B.
  const scopeKey = scope ? `_scope:${scope.userId}:${scope.role}` : ''
  const refMonthKey = (typeof req.query.ref_month === 'string' && /^\d{4}-\d{2}$/.test(req.query.ref_month.trim()))
    ? req.query.ref_month.trim()
    : 'live'
  const reqRegion = normalizeRegion(req.query.region)
  const reqSegment = normalizeSegment(req.query.segment)
  // v3: added gm_by_group SSG×12mo matrix — bumped so v2 payloads (no matrix) don't serve.
  const cacheKey = `sales_v3_${refMonthKey}_${req.query.period || 'MTD'}_${reqRegion}_${reqSegment}_${session.role}_${session.region || 'ALL'}${scopeKey}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD' } = req.query
    const region = reqRegion
    const segment = reqSegment
    const periodOpts = refMonthKey !== 'live' ? { refMonth: refMonthKey } : {}
    const { dateFrom, dateTo } = getPeriodDates(period, periodOpts)

    // Patrol-only opt-in blocks. Web dashboard never sends include= so its response
    // stays byte-identical. Patrol passes ?include=whitespace,at_risk.
    const includeRaw = typeof req.query.include === 'string' ? req.query.include : ''
    const include = new Set(includeRaw.split(',').map(s => s.trim()).filter(Boolean))
    const wantWhitespace = include.has('whitespace')
    const wantAtRisk     = include.has('at_risk')

    const scopeSql = scopeFilter.sql    // '' when ALL or no scope
    const lineFilters = regionFilterSql(region, 'T1') + segmentFilterSql(segment, 'T0')
    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'` + scopeSql
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const filteredWhere = applyRoleFilter(session, baseWhere) + lineFilters

    // --- By Brand ---
    const by_brand = await query(`
      SELECT
        T1.Dscription                                                           AS brand,
        ISNULL(SUM(T1.Quantity), 0)                                             AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)          AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                            AS revenue,
        CASE WHEN SUM(T1.Quantity) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.Quantity)
          ELSE 0 END                                                             AS gm_per_bag,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                             AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T1.Dscription
      ORDER BY volume_mt DESC
    `, { dateFrom, dateTo, region })

    // --- Top 20 Customers ---
    const top_customers = await query(`
      SELECT TOP 20
        T0.CardCode                                                     AS customer_code,
        T0.CardName                                                     AS customer_name,
        ISNULL(SUM(T1.Quantity), 0)                                     AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue,
        (SELECT TOP 1 ${regionCaseSql('L')}
           FROM INV1 L
           INNER JOIN OINV H ON L.DocEntry = H.DocEntry
           WHERE H.CardCode = T0.CardCode AND H.DocDate BETWEEN @dateFrom AND @dateTo AND H.CANCELED = 'N'
           GROUP BY ${regionCaseSql('L')}
           ORDER BY SUM(L.Quantity) DESC)                               AS region
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY volume_mt DESC
    `, { dateFrom, dateTo, region })

    // --- Monthly Trend (last 12 months, ignores period filter) ---
    const trendWhere = `WHERE T0.DocDate >= DATEADD(MONTH, -12, GETDATE()) AND T0.CANCELED = 'N'` + scopeSql
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const trendFiltered = applyRoleFilter(session, trendWhere) + lineFilters

    // 12-month trend crosses 2026-01-01 cutoff → union historical + current.
    // After concat, sum by month-key (in case of overlap) and re-sort.
    const monthlyRaw = await queryBoth(`
      SELECT
        FORMAT(T0.DocDate, 'yyyy-MM')                                   AS month,
        ISNULL(SUM(T1.Quantity), 0)                                     AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${trendFiltered}
      GROUP BY FORMAT(T0.DocDate, 'yyyy-MM')
      ORDER BY month ASC
    `, { region })
    const trendByMonth = {}
    for (const r of monthlyRaw) {
      const k = r.month
      const cur = trendByMonth[k] || { month: k, volume_bags: 0, volume_mt: 0, revenue: 0 }
      cur.volume_bags += Number(r.volume_bags || 0)
      cur.volume_mt   += Number(r.volume_mt   || 0)
      cur.revenue     += Number(r.revenue     || 0)
      trendByMonth[k] = cur
    }
    const monthly_trend = Object.values(trendByMonth).sort((a, b) => a.month.localeCompare(b.month))

    // --- GM ₱/ton by SSG group × trailing-12-calendar-month matrix ---
    // Live replacement for the old hardcoded "GM per Ton by Group" table.
    // Scope: finished feed (OITM.ItmsGrpCod=103). Tons = InvQty/1000 (InvQty is KG, per margin model).
    // Window crosses the 2026-01 consolidation cutoff → queryBoth (historical + current) then merge by SSG+month.
    // Respects the SAME region+segment line filters as the rest of the page (lineFilters).
    const gmStart = new Date(); gmStart.setDate(1); gmStart.setMonth(gmStart.getMonth() - 11)
    gmStart.setHours(0, 0, 0, 0)
    // 12 calendar-month keys ending at the current month (chronological).
    const gmMonths = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i)
      gmMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }
    const curYm = gmMonths[gmMonths.length - 1]
    const gmWhere = `WHERE T0.DocDate >= @gmStart AND T0.CANCELED = 'N' AND T1.InvQty > 0 AND I.ItmsGrpCod = 103` + scopeSql
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const gmFiltered = applyRoleFilter(session, gmWhere) + lineFilters
    const gmRaw = await queryBoth(`
      SELECT
        ISNULL(S.Name, 'UNSPEC')                                        AS ssg,
        FORMAT(T0.DocDate, 'yyyy-MM')                                   AS ym,
        ISNULL(SUM(T1.GrssProfit), 0)                                   AS gp,
        ISNULL(SUM(T1.InvQty) / 1000.0, 0)                              AS tons
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      INNER JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN [@OITMSSG] S ON S.Code = I.U_SSG
      ${gmFiltered}
      GROUP BY ISNULL(S.Name, 'UNSPEC'), FORMAT(T0.DocDate, 'yyyy-MM')
    `, { gmStart, region })
    // Merge (historical + current books may both return rows for the cutover month).
    const gmAgg = {}    // ssg → { ssg, total_tons, cells: { ym → { gp, tons } } }
    const gmTot = {}    // ym → { gp, tons }  (volume-weighted avg row)
    for (const r of gmRaw) {
      const ssg = (r.ssg === 'UNSPEC' || !r.ssg) ? 'Untagged' : r.ssg
      const ym = r.ym
      if (!gmMonths.includes(ym)) continue   // guard: ignore stray edge rows
      const gp = Number(r.gp || 0), tons = Number(r.tons || 0)
      if (!gmAgg[ssg]) gmAgg[ssg] = { ssg, total_tons: 0, cells: {} }
      const c = gmAgg[ssg].cells[ym] || { gp: 0, tons: 0 }
      c.gp += gp; c.tons += tons
      gmAgg[ssg].cells[ym] = c
      gmAgg[ssg].total_tons += tons
      const t = gmTot[ym] || { gp: 0, tons: 0 }
      t.gp += gp; t.tons += tons
      gmTot[ym] = t
    }
    // ₱/ton per cell = SUM(GrssProfit) / SUM(tons), where tons already = kg/1000.
    const gmGroups = Object.values(gmAgg)
      .sort((a, b) => b.total_tons - a.total_tons)
      .map(g => ({
        ssg: g.ssg,
        cells: gmMonths.map(ym => {
          const c = g.cells[ym]
          if (!c || c.tons <= 0) return { ym, gm_ton: null, tons: 0 }
          return { ym, gm_ton: Math.round(c.gp / c.tons), tons: Math.round(c.tons * 10) / 10 }
        })
      }))
    const gm_by_group = {
      months: gmMonths,
      current_month: curYm,
      groups: gmGroups,
      avg: gmMonths.map(ym => {
        const t = gmTot[ym]
        if (!t || t.tons <= 0) return { ym, gm_ton: null, tons: 0 }
        return { ym, gm_ton: Math.round(t.gp / t.tons), tons: Math.round(t.tons * 10) / 10 }
      })
    }

    // --- Pending PO detail (open sales orders — OPEN lines only, residual qty/value) ---
    // OpenQty = undelivered remainder. Full T1.Quantity/LineTotal would overstate by the
    // already-delivered portion, and the old TOP 200 truncated aggregates to the 200 oldest
    // lines. TOP 5000 is a payload guard only (~1.6k open lines live as of 2026-06).
    const pendingPO = await query(`
      SELECT TOP 5000
        T0.DocNum,
        T0.DocDate,
        T0.CardCode                                                     AS customer_code,
        T0.CardName                                                     AS customer_name,
        T1.Dscription                                                   AS brand,
        T1.ItemCode                                                     AS sku,
        T1.WhsCode                                                      AS plant,
        ISNULL(T1.OpenQty * ISNULL(I.NumInSale, 1) / 1000.0, 0)         AS qty_mt,
        ISNULL(T1.OpenQty * T1.Price, 0)                                AS open_value,
        DATEDIFF(DAY, T0.DocDate, GETDATE())                            AS age_days
      FROM ORDR T0
      INNER JOIN RDR1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocStatus = 'O' AND T0.CANCELED = 'N'
        AND T1.LineStatus = 'O' AND T1.OpenQty > 0${scopeSql}${lineFilters}
      ORDER BY T0.DocDate ASC
    `, { region })

    const poOrderCount = new Set(pendingPO.map(p => p.DocNum)).size
    const po_total_mt = pendingPO.reduce((s, p) => s + p.qty_mt, 0)
    // Use open line value (OpenQty * Price) so region/segment filters stay consistent with the detail rows.
    const po_total_value = pendingPO.reduce((s, p) => s + (p.open_value || 0), 0)
    const po_by_brand = {}
    const po_by_region = {}
    const po_by_sku = {}
    const po_by_region_detail = {}  // { region: { orders:Set, mt, value, statuses:{confirmed, credit_hold, awaiting} } }
    const po_by_customer = {}        // { code: { name, orders:Set, mt, value, statuses:[] } }
    pendingPO.forEach(p => {
      po_by_brand[p.brand] = (po_by_brand[p.brand] || 0) + p.qty_mt
      const region = plantRegion(p.plant)
      po_by_region[region] = (po_by_region[region] || 0) + p.qty_mt
      po_by_sku[p.sku] = po_by_sku[p.sku] || { sku: p.sku, name: p.brand, mt: 0 }
      po_by_sku[p.sku].mt += p.qty_mt
      if(!po_by_region_detail[region]) po_by_region_detail[region] = { region, orders: new Set(), mt: 0, value: 0 }
      po_by_region_detail[region].orders.add(p.DocNum)
      po_by_region_detail[region].mt += p.qty_mt
      po_by_region_detail[region].value += p.open_value || 0
      if(!po_by_customer[p.customer_code]) po_by_customer[p.customer_code] = { customer: p.customer_name, code: p.customer_code, orders: new Set(), mt: 0, value: 0 }
      po_by_customer[p.customer_code].orders.add(p.DocNum)
      po_by_customer[p.customer_code].mt += p.qty_mt
      po_by_customer[p.customer_code].value += p.open_value || 0
    })

    const top_po_customers = Object.values(po_by_customer)
      .map(c => ({ customer: c.customer, code: c.code, orders: c.orders.size, mt: Math.round(c.mt * 10) / 10, value: c.value, status: 'Open' }))
      .sort((a, b) => b.mt - a.mt).slice(0, 12)

    const pending_po = {
      summary: {
        total_mt: Math.round(po_total_mt * 10) / 10,
        total_value: Math.round(po_total_value),
        total_orders: poOrderCount,
        customers_count: new Set(pendingPO.map(p => p.customer_code)).size,
        avg_order_mt: poOrderCount > 0 ? Math.round(po_total_mt / poOrderCount) : 0,
        oldest_days: pendingPO.length > 0 ? Math.max(...pendingPO.map(p => p.age_days)) : 0
      },
      by_brand: Object.entries(po_by_brand).map(([brand, mt]) => ({ brand, mt: Math.round(mt * 10) / 10 })).sort((a, b) => b.mt - a.mt),
      by_region: Object.entries(po_by_region).map(([region, mt]) => ({ region, mt: Math.round(mt * 10) / 10 })).sort((a, b) => b.mt - a.mt),
      by_sku:    Object.values(po_by_sku).map(s => ({ sku: s.sku, name: (s.name || '').slice(0, 40), mt: Math.round(s.mt * 10) / 10 })).sort((a, b) => b.mt - a.mt).slice(0, 12),
      by_region_detail: Object.values(po_by_region_detail).map(r => ({
        region: r.region,
        orders: r.orders.size,
        mt: Math.round(r.mt * 10) / 10,
        value: Math.round(r.value),
        avg_size_mt: r.orders.size > 0 ? Math.round((r.mt / r.orders.size) * 10) / 10 : 0
      })).sort((a, b) => b.mt - a.mt),
      top_customers: top_po_customers,
      detail: pendingPO.slice(0, 50).map(p => ({
        doc_num: p.DocNum,
        date: p.DocDate,
        customer: p.customer_name,
        code: p.customer_code,
        brand: p.brand,
        sku: p.sku,
        plant: p.plant,
        mt: Math.round(p.qty_mt * 10) / 10,
        amount: p.open_value,        // frontend reads `amount` — value is OpenQty * Price
        open_value: p.open_value,
        age_days: p.age_days
      }))
    }

    // --- Patrol-only: whitespace (BPs in scope with no invoices in period) ---
    let whitespace = []
    if (wantWhitespace) {
      // Only meaningful for SlpCode-scoped callers (DSMs/RSMs). For ALL/region
      // scope, returning every empty BP nationally is too noisy — skip.
      if (scope && Array.isArray(scope.slpCodes) && scope.slpCodes.length > 0) {
        // SAFETY: scope.slpCodes comes from Supabase users table (server-side),
        // not user input. Safe to interpolate as comma-joined ints.
        const slpList = scope.slpCodes.map(n => parseInt(n, 10)).filter(Number.isFinite).join(',')
        if (slpList) {
          const wsRows = await query(
            `SELECT TOP 10
               c.CardCode,
               c.CardName,
               c.Phone1
             FROM OCRD c
             WHERE c.SlpCode IN (${slpList})
               AND c.validFor = 'Y'
               AND c.CardCode NOT IN (
                 SELECT DISTINCT T0.CardCode FROM OINV T0
                 WHERE T0.SlpCode IN (${slpList})
                   AND T0.CANCELED = 'N'
                   AND T0.DocDate BETWEEN @dateFrom AND @dateTo
               )
             ORDER BY c.CardName`,
            { dateFrom, dateTo }
          )
          whitespace = wsRows.map(r => ({
            cardcode: r.CardCode,
            name: r.CardName,
            phone: r.Phone1 || null
          }))
        }
      }
    }

    // --- Patrol-only: at_risk (BPs in scope with last order > 14 days ago) ---
    let at_risk = []
    if (wantAtRisk) {
      if (scope && Array.isArray(scope.slpCodes) && scope.slpCodes.length > 0) {
        const slpList = scope.slpCodes.map(n => parseInt(n, 10)).filter(Number.isFinite).join(',')
        if (slpList) {
          const arRows = await query(
            `SELECT TOP 10
               c.CardCode,
               c.CardName,
               li.last_date,
               DATEDIFF(day, li.last_date, GETDATE()) AS days_since
             FROM OCRD c
             LEFT JOIN (
               SELECT CardCode, MAX(DocDate) AS last_date
               FROM OINV
               WHERE SlpCode IN (${slpList})
                 AND CANCELED = 'N'
               GROUP BY CardCode
             ) li ON li.CardCode = c.CardCode
             WHERE c.SlpCode IN (${slpList})
               AND c.validFor = 'Y'
               AND (li.last_date IS NULL OR DATEDIFF(day, li.last_date, GETDATE()) > 14)
             ORDER BY days_since DESC`
          )
          const tier = (d) => {
            if (d == null) return 'no_history'
            if (d > 30)    return 'at_risk'
            if (d >= 15)   return 'slowing'
            return 'healthy'
          }
          at_risk = arRows.map(r => {
            const days = r.days_since == null ? null : Number(r.days_since)
            return {
              cardcode: r.CardCode,
              name: r.CardName,
              last_date: r.last_date ? new Date(r.last_date).toISOString().slice(0, 10) : null,
              days_since_last_order: days,
              tier: tier(days)
            }
          })
        }
      }
    }

    // --- Top-level summary KPIs for Sales hero strip ---
    const kpiCurrent = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS gross_margin,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
    `, { dateFrom, dateTo, region })

    // Previous-period (one period back, same length) for delta
    const prevFrom = new Date(dateFrom); prevFrom.setTime(prevFrom.getTime() - (dateTo - dateFrom))
    const prevTo   = new Date(dateFrom); prevTo.setDate(prevTo.getDate() - 1)
    const kpiPrev = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS gross_margin,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @pFrom AND @pTo AND T0.CANCELED='N'${scopeSql}${lineFilters}
    `, { pFrom: prevFrom, pTo: prevTo, region })

    // YTD (Jan 1 → anchor end) — anchor respects ref_month
    const anchorEnd = new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate())
    const ytdFrom = new Date(anchorEnd.getFullYear(), 0, 1)
    const kpiYtd = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @ytdFrom AND @ytdEnd AND T0.CANCELED='N'${scopeSql}${lineFilters}
    `, { ytdFrom, ytdEnd: anchorEnd, region })

    // LY same period (current period -1y) and LY YTD — pulls from historical when pre-cutoff
    const lyFrom = new Date(dateFrom); lyFrom.setFullYear(lyFrom.getFullYear() - 1)
    const lyTo   = new Date(dateTo);   lyTo.setFullYear(lyTo.getFullYear() - 1)
    const kpiLy = await queryDateRange(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS gross_margin,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'${scopeSql}${lineFilters}
    `, { region }, lyFrom, lyTo)

    const ytdLyFrom = new Date(anchorEnd.getFullYear() - 1, 0, 1)
    const ytdLyTo   = new Date(anchorEnd.getFullYear() - 1, anchorEnd.getMonth(), anchorEnd.getDate())
    const kpiYtdLy = await queryDateRange(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'${scopeSql}${lineFilters}
    `, { region }, ytdLyFrom, ytdLyTo)

    const sumRows = (rows, ...cols) => {
      const acc = Object.fromEntries(cols.map(c => [c, 0]))
      for (const r of rows) for (const c of cols) acc[c] += Number(r[c] || 0)
      return acc
    }
    const cur = kpiCurrent[0] || {}, prv = kpiPrev[0] || {}, yt = kpiYtd[0] || {}
    const ly  = sumRows(kpiLy, 'volume_bags', 'volume_mt', 'revenue', 'gross_margin')
    if (kpiLy.length === 1) ly.gmt = kpiLy[0].gmt || 0   // single-DB short-circuit
    const lyGmtForDelta = (kpiLy.length >= 1 && kpiLy[0].gmt != null) ? kpiLy[0].gmt : (ly.gmt || 0)
    const ytdLy = sumRows(kpiYtdLy, 'volume_mt', 'revenue')

    const pct = (a, b) => b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : 0

    const kpis = {
      volume_mt:     Math.round((cur.volume_mt || 0) * 10) / 10,
      volume_bags:   Math.round(cur.volume_bags || 0),
      revenue:       Math.round(cur.revenue || 0),
      gross_margin:  Math.round(cur.gross_margin || 0),
      gross_margin_pct: cur.revenue > 0 ? Math.round((cur.gross_margin / cur.revenue) * 1000) / 10 : 0,
      gmt:           Math.round(cur.gmt || 0),
      ytd_volume_mt: Math.round((yt.volume_mt || 0) * 10) / 10,
      ytd_volume_bags: Math.round(yt.volume_bags || 0),
      ytd_revenue:   Math.round(yt.revenue || 0),
      pending_po_mt: Math.round((po_total_mt) * 10) / 10,
      delta_pct: {
        volume_mt: pct(cur.volume_mt, prv.volume_mt),
        revenue:   pct(cur.revenue,   prv.revenue),
        gross_margin: pct(cur.gross_margin, prv.gross_margin || 0),
        gmt:       pct(cur.gmt,       prv.gmt)
      },
      // Last-year comparators (period-matched + YTD)
      last_year: {
        volume_mt: Math.round(ly.volume_mt * 10) / 10,
        volume_bags: Math.round(ly.volume_bags),
        revenue: Math.round(ly.revenue),
        ytd_volume_mt: Math.round(ytdLy.volume_mt * 10) / 10,
        ytd_revenue: Math.round(ytdLy.revenue)
      },
      delta_pct_ly: {
        volume_mt: pct(cur.volume_mt, ly.volume_mt),
        revenue:   pct(cur.revenue,   ly.revenue),
        gross_margin: pct(cur.gross_margin, ly.gross_margin || 0),
        gmt:       pct(cur.gmt, lyGmtForDelta),
        ytd_volume_mt: pct(yt.volume_mt, ytdLy.volume_mt),
        ytd_revenue:   pct(yt.revenue,   ytdLy.revenue)
      }
    }

    const result = { meta: {
                       applied_filters: {
                         period: String(period || 'MTD').toUpperCase(),
                         ...filterMeta(region, segment),
                         ref_month: refMonthKey
                       },
                       source: {
                         volume: 'OINV',
                         sales: 'OINV',
                         gross_margin: 'OINV',
                         pending_po: 'ORDR/RDR1'
                       },
                       data_quality: {
                         contains_proxy: false,
                         proxy_fields: [],
                         notes: ['Sales page invoice volume uses OINV; shipped-speed cards come from /api/speed.',
                                 'Pending PO uses open-line residuals (RDR1.OpenQty × Price).']
                       }
                     },
                     kpis, by_brand, top_customers, monthly_trend, pending_po, gm_by_group,
                     volume_mt: kpis.volume_mt, volume_bags: kpis.volume_bags,
                     revenue: kpis.revenue, gmt: kpis.gmt,
                     ytd_volume_mt: kpis.ytd_volume_mt, ytd_revenue: kpis.ytd_revenue }

    if (wantWhitespace) result.whitespace = whitespace
    if (wantAtRisk)     result.at_risk    = at_risk

    // Include scope metadata only when the caller asked for it.
    // Keeps the existing no-scope response shape byte-identical for web dashboard.
    if (scope) result.scope = scopeResponseMeta(scope)

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [sales]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}

// Exposed for unit tests (tests/pending-po-openqty.test.js)
module.exports.plantRegion = plantRegion
