const { query, queryBoth, queryDateRange } = require('./_db')
const { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — try service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache check
  const cacheKey = `sales_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD', region = 'ALL' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const filteredWhere = applyRoleFilter(session, baseWhere)

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
    `, { dateFrom, dateTo })

    // --- Top 20 Customers ---
    const top_customers = await query(`
      SELECT TOP 20
        T0.CardCode                                                     AS customer_code,
        T0.CardName                                                     AS customer_name,
        ISNULL(SUM(T1.Quantity), 0)                                     AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY volume_mt DESC
    `, { dateFrom, dateTo })

    // --- Monthly Trend (last 12 months, ignores period filter) ---
    const trendWhere = `WHERE T0.DocDate >= DATEADD(MONTH, -12, GETDATE()) AND T0.CANCELED = 'N'`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const trendFiltered = applyRoleFilter(session, trendWhere)

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
    `)
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

    // --- Pending PO detail (open sales orders) ---
    const pendingPO = await query(`
      SELECT TOP 200
        T0.DocNum,
        T0.DocDate,
        T0.CardCode                                                     AS customer_code,
        T0.CardName                                                     AS customer_name,
        T1.Dscription                                                   AS brand,
        T1.ItemCode                                                     AS sku,
        T1.WhsCode                                                      AS plant,
        ISNULL(T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0, 0)        AS qty_mt,
        ISNULL(T1.LineTotal, 0)                                         AS amount,
        DATEDIFF(DAY, T0.DocDate, GETDATE())                            AS age_days
      FROM ORDR T0
      INNER JOIN RDR1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocStatus = 'O' AND T0.CANCELED = 'N'
      ORDER BY T0.DocDate ASC
    `)

    // Also get PO headers (for amount + status count — DocStatus='O' then per-line detail above)
    const pendingPOHeaders = await query(`
      SELECT TOP 500
        T0.DocNum, T0.DocDate, T0.CardCode, T0.CardName,
        ISNULL(T0.DocTotal, 0) AS amount,
        T0.Confirmed,
        ISNULL(T0.SlpCode, 0) AS slp
      FROM ORDR T0
      WHERE T0.DocStatus='O' AND T0.CANCELED='N'
      ORDER BY T0.DocDate DESC
    `)

    const po_total_mt = pendingPO.reduce((s, p) => s + p.qty_mt, 0)
    const po_total_value = pendingPOHeaders.reduce((s, p) => s + (p.amount || 0), 0)
    const po_by_brand = {}
    const po_by_region = {}
    const po_by_sku = {}
    const po_by_region_detail = {}  // { region: { orders:Set, mt, value, statuses:{confirmed, credit_hold, awaiting} } }
    const po_by_customer = {}        // { code: { name, orders:Set, mt, value, statuses:[] } }
    pendingPO.forEach(p => {
      po_by_brand[p.brand] = (po_by_brand[p.brand] || 0) + p.qty_mt
      const region = ['AC','ACEXT','BAC'].includes(p.plant) ? 'Luzon'
        : ['HOREB','ARGAO','ALAE'].includes(p.plant) ? 'Visayas'
        : ['BUKID','CCPC'].includes(p.plant) ? 'Mindanao' : 'Other'
      po_by_region[region] = (po_by_region[region] || 0) + p.qty_mt
      po_by_sku[p.sku] = po_by_sku[p.sku] || { sku: p.sku, name: p.brand, mt: 0 }
      po_by_sku[p.sku].mt += p.qty_mt
      if(!po_by_region_detail[region]) po_by_region_detail[region] = { region, orders: new Set(), mt: 0, value: 0 }
      po_by_region_detail[region].orders.add(p.DocNum)
      po_by_region_detail[region].mt += p.qty_mt
      // approx line value from header allocation (per PO split by line mt share) — quick proxy:
      po_by_region_detail[region].value += p.amount || 0
      if(!po_by_customer[p.customer_code]) po_by_customer[p.customer_code] = { customer: p.customer_name, code: p.customer_code, orders: new Set(), mt: 0, value: 0 }
      po_by_customer[p.customer_code].orders.add(p.DocNum)
      po_by_customer[p.customer_code].mt += p.qty_mt
      po_by_customer[p.customer_code].value += p.amount || 0
    })

    const top_po_customers = Object.values(po_by_customer)
      .map(c => ({ customer: c.customer, code: c.code, orders: c.orders.size, mt: Math.round(c.mt * 10) / 10, value: c.value, status: 'Open' }))
      .sort((a, b) => b.mt - a.mt).slice(0, 12)

    const pending_po = {
      summary: {
        total_mt: Math.round(po_total_mt * 10) / 10,
        total_value: Math.round(po_total_value),
        total_orders: new Set(pendingPO.map(p => p.DocNum)).size,
        customers_count: new Set(pendingPO.map(p => p.customer_code)).size,
        avg_order_mt: pendingPOHeaders.length > 0 ? Math.round(po_total_mt / pendingPOHeaders.length) : 0,
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
        amount: p.amount,
        age_days: p.age_days
      }))
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
    `, { dateFrom, dateTo })

    // Previous-period (one period back, same length) for delta
    const prevFrom = new Date(dateFrom); prevFrom.setTime(prevFrom.getTime() - (dateTo - dateFrom))
    const prevTo   = new Date(dateFrom); prevTo.setDate(prevTo.getDate() - 1)
    const kpiPrev = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @pFrom AND @pTo AND T0.CANCELED='N'
    `, { pFrom: prevFrom, pTo: prevTo })

    // YTD (Jan 1 → today)
    const ytdFrom = new Date(new Date().getFullYear(), 0, 1)
    const kpiYtd = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= @ytdFrom AND T0.CANCELED='N'
    `, { ytdFrom })

    // LY same period (current period -1y) and LY YTD — pulls from historical when pre-cutoff
    const lyFrom = new Date(dateFrom); lyFrom.setFullYear(lyFrom.getFullYear() - 1)
    const lyTo   = new Date(dateTo);   lyTo.setFullYear(lyTo.getFullYear() - 1)
    const kpiLy = await queryDateRange(`
      SELECT
        ISNULL(SUM(T1.Quantity), 0)                                       AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'
    `, {}, lyFrom, lyTo)

    const ytdLyFrom = new Date(new Date().getFullYear() - 1, 0, 1)
    const ytdLyTo   = new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate())
    const kpiYtdLy = await queryDateRange(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'
    `, {}, ytdLyFrom, ytdLyTo)

    const sumRows = (rows, ...cols) => {
      const acc = Object.fromEntries(cols.map(c => [c, 0]))
      for (const r of rows) for (const c of cols) acc[c] += Number(r[c] || 0)
      return acc
    }
    const cur = kpiCurrent[0] || {}, prv = kpiPrev[0] || {}, yt = kpiYtd[0] || {}
    const ly  = sumRows(kpiLy, 'volume_bags', 'volume_mt', 'revenue')
    if (kpiLy.length === 1) ly.gmt = kpiLy[0].gmt || 0   // single-DB short-circuit
    const ytdLy = sumRows(kpiYtdLy, 'volume_mt', 'revenue')

    const pct = (a, b) => b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : 0

    const kpis = {
      volume_mt:     Math.round((cur.volume_mt || 0) * 10) / 10,
      volume_bags:   Math.round(cur.volume_bags || 0),
      revenue:       Math.round(cur.revenue || 0),
      gross_margin:  Math.round(cur.gross_margin || 0),
      gmt:           Math.round(cur.gmt || 0),
      ytd_volume_mt: Math.round((yt.volume_mt || 0) * 10) / 10,
      ytd_volume_bags: Math.round(yt.volume_bags || 0),
      ytd_revenue:   Math.round(yt.revenue || 0),
      pending_po_mt: Math.round((po_total_mt) * 10) / 10,
      delta_pct: {
        volume_mt: pct(cur.volume_mt, prv.volume_mt),
        revenue:   pct(cur.revenue,   prv.revenue),
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
        ytd_volume_mt: pct(yt.volume_mt, ytdLy.volume_mt),
        ytd_revenue:   pct(yt.revenue,   ytdLy.revenue)
      }
    }

    const result = { kpis, by_brand, top_customers, monthly_trend, pending_po,
                     volume_mt: kpis.volume_mt, volume_bags: kpis.volume_bags,
                     revenue: kpis.revenue, gmt: kpis.gmt,
                     ytd_volume_mt: kpis.ytd_volume_mt, ytd_revenue: kpis.ytd_revenue }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [sales]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
