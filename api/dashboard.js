const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// 2026 Budget targets (mirrors api/speed.js + api/budget.js)
const BUDGET_2026 = {
  annual_mt:      188266,
  annual_sales:   5975000000,
  annual_gm:      1233000000,
  monthly_mt: [
    13933, 13933, 13934,   // Q1 Jan, Feb, Mar
    15061, 15061, 15062,   // Q2 Apr, May, Jun
    16463, 16463, 16463,   // Q3 Jul, Aug, Sep
    17298, 17298, 17297    // Q4 Oct, Nov, Dec
  ]
}
const ACTIVE_PREDICATE = `(ISNULL(C.frozenFor,'N') <> 'Y' AND C.U_BpStatus = 'Active')`

function monthRange(year, monthIdx) {
  return { from: new Date(year, monthIdx, 1), to: new Date(year, monthIdx + 1, 0) }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `dashboard_v2_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD', region = 'ALL' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

    const now = new Date()
    const year = now.getFullYear()
    const monthIdx = now.getMonth()
    const ytdFrom = new Date(year, 0, 1)
    const prev = monthRange(year, monthIdx - 1)

    // YTD budget = sum of monthly budgets Jan through current month (inclusive)
    const ytd_budget_mt = BUDGET_2026.monthly_mt.slice(0, monthIdx + 1).reduce((a, b) => a + b, 0)
    const ytd_budget_sales = Math.round((ytd_budget_mt / BUDGET_2026.annual_mt) * BUDGET_2026.annual_sales)
    const ytd_budget_gm = Math.round((ytd_budget_mt / BUDGET_2026.annual_mt) * BUDGET_2026.annual_gm)
    const mtd_budget_mt = BUDGET_2026.monthly_mt[monthIdx]

    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- Current period KPIs ---
    const kpis = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                               AS revenue,
        ISNULL(SUM(T1.Quantity), 0)                                                AS volume_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)             AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                              AS gross_margin,
        CASE WHEN SUM(T1.Quantity) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.Quantity)
          ELSE 0 END                                                                AS gm_per_bag,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                                AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
    `, { dateFrom, dateTo })

    // --- Previous period KPIs (for MoM delta) ---
    const prevKpis = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                               AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)             AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                              AS gross_margin,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                                AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @prevFrom AND @prevTo AND T0.CANCELED = 'N'
    `, { prevFrom: prev.from, prevTo: prev.to })

    // --- Same period last year (for vs LY compare) ---
    const lyFrom = new Date(dateFrom); lyFrom.setFullYear(lyFrom.getFullYear() - 1)
    const lyTo   = new Date(dateTo);   lyTo.setFullYear(lyTo.getFullYear() - 1)
    const lyKpis = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                               AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)             AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                              AS gross_margin,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                                AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lyFrom AND @lyTo AND T0.CANCELED = 'N'
    `, { lyFrom, lyTo })

    // --- YTD actuals ---
    const ytdKpis = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                               AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)             AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                              AS gross_margin,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                                AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @ytdFrom AND @today AND T0.CANCELED = 'N'
    `, { ytdFrom, today: now })

    // --- AR Balance (total + active) ---
    const arWhere = `WHERE T0.CANCELED = 'N' AND T0.DocTotal > T0.PaidToDate`
    const arFilteredWhere = applyRoleFilter(session, arWhere)
    const arBalance = await query(`
      SELECT
        ISNULL(SUM(T0.DocTotal - T0.PaidToDate), 0) AS total_balance,
        ISNULL(SUM(CASE WHEN ${ACTIVE_PREDICATE} THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS active_balance,
        ISNULL(SUM(CASE WHEN NOT ${ACTIVE_PREDICATE} THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS delinquent_balance
      FROM OINV T0
      INNER JOIN OCRD C ON T0.CardCode = C.CardCode
      ${arFilteredWhere}
    `)

    // --- DSO (active + total) — trailing 90-day formula calibrated to Finance Dashboard ---
    const dsoRow = await query(`
      DECLARE @ar_active DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE_PREDICATE});
      DECLARE @ar_total  DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate);
      DECLARE @s90_active DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) AND ${ACTIVE_PREDICATE});
      DECLARE @s90_total  DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()));
      SELECT
        CASE WHEN @s90_active > 0 THEN @ar_active / (@s90_active/90.0) ELSE 0 END AS dso_active,
        CASE WHEN @s90_total  > 0 THEN @ar_total  / (@s90_total /90.0) ELSE 0 END AS dso_total
    `)

    // --- Pending PO (open sales orders) + oldest age ---
    const pendingPO = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS total_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                   AS total_value,
        COUNT(DISTINCT T0.DocEntry)                                    AS total_orders,
        ISNULL(MAX(DATEDIFF(DAY, T0.DocDate, GETDATE())), 0)           AS oldest_days
      FROM ORDR T0
      INNER JOIN RDR1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocStatus = 'O' AND T0.CANCELED = 'N'
    `)

    // --- Region performance (current period + previous period for vs_pp delta) ---
    const regionPerfCur = await query(`
      SELECT
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS sales,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END
      ORDER BY vol DESC
    `, { dateFrom, dateTo })

    // Previous period for vs_pp
    const regionPerfPrev = await query(`
      SELECT
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @ppFrom AND @ppTo AND T0.CANCELED='N'
      GROUP BY
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END
    `, { ppFrom: prev.from, ppTo: prev.to })

    const prevMap = Object.fromEntries(regionPerfPrev.map(r => [r.region, r.vol]))
    const regionPerf = regionPerfCur.map(r => ({
      ...r,
      vs_pp: prevMap[r.region] > 0
        ? Math.round(((r.vol - prevMap[r.region]) / prevMap[r.region]) * 1000) / 10
        : null
    }))

    // --- Top 5 customers ---
    const topCust = await query(`
      SELECT TOP 5
        T0.CardName                                                     AS name,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS vol,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T0.CardName
      ORDER BY vol DESC
    `, { dateFrom, dateTo })

    // --- Monthly performance (last 7 months, CY + LY volume + GM) — OINV only ---
    const monthlyRaw = await query(`
      SELECT
        YEAR(T0.DocDate)                                                  AS y,
        MONTH(T0.DocDate)                                                 AS m,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS gross_margin
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(MONTH, -19, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
        AND T0.CANCELED = 'N'
      GROUP BY YEAR(T0.DocDate), MONTH(T0.DocDate)
    `)

    const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const monthlyMap = {}  // 'YYYY-MM' -> { volume_mt, gm }
    for (const r of monthlyRaw) {
      const k = `${r.y}-${String(r.m).padStart(2,'0')}`
      monthlyMap[k] = { volume_mt: Number(r.volume_mt||0), gm: Number(r.gross_margin||0) }
    }
    // Build last 7 months ending with current month (descending-build, reversed to ascending order)
    const monthly_perf = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(year, monthIdx - i, 1)
      const cyKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
      const lyKey = `${d.getFullYear()-1}-${String(d.getMonth()+1).padStart(2,'0')}`
      const cy = monthlyMap[cyKey] || { volume_mt: 0, gm: 0 }
      const ly = monthlyMap[lyKey] || { volume_mt: 0, gm: 0 }
      monthly_perf.push({
        month:     monthShort[d.getMonth()],
        year:      d.getFullYear(),
        cy_volume: Math.round(cy.volume_mt),
        ly_volume: Math.round(ly.volume_mt),
        cy_gm:     Math.round(cy.gm),
        ly_gm:     Math.round(ly.gm)
      })
    }

    // --- Quarterly performance (CY 4 quarters + LY same 4) — OINV only ---
    const quarterlyRaw = await query(`
      SELECT
        YEAR(T0.DocDate)                                                  AS y,
        DATEPART(QUARTER, T0.DocDate)                                     AS q,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS gross_margin
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEFROMPARTS(YEAR(GETDATE()) - 1, 1, 1)
        AND T0.CANCELED = 'N'
      GROUP BY YEAR(T0.DocDate), DATEPART(QUARTER, T0.DocDate)
    `)

    const qMap = {}
    for (const r of quarterlyRaw) {
      qMap[`${r.y}-Q${r.q}`] = { volume_mt: Number(r.volume_mt||0), gm: Number(r.gross_margin||0) }
    }
    const quarterly_perf = []
    for (let q = 1; q <= 4; q++) {
      const cy = qMap[`${year}-Q${q}`]     || { volume_mt: 0, gm: 0 }
      const ly = qMap[`${year-1}-Q${q}`]   || { volume_mt: 0, gm: 0 }
      quarterly_perf.push({
        quarter:   `Q${q}`,
        cy_volume: Math.round(cy.volume_mt),
        ly_volume: Math.round(ly.volume_mt),
        cy_gm:     Math.round(cy.gm),
        ly_gm:     Math.round(ly.gm)
      })
    }

    // --- Margin alert counts ---
    const marginCounts = await query(`
      SELECT
        SUM(CASE WHEN gp_pct < 0 THEN 1 ELSE 0 END)                     AS critical,
        SUM(CASE WHEN gp_pct >= 0 AND gp_pct < 10 THEN 1 ELSE 0 END)    AS warning,
        SUM(CASE WHEN gp_pct >= 10 AND gp_pct < 15 THEN 1 ELSE 0 END)   AS watch,
        SUM(CASE WHEN gp_pct >= 15 THEN 1 ELSE 0 END)                    AS healthy
      FROM (
        SELECT T0.CardCode,
          CASE WHEN SUM(T1.LineTotal) > 0
            THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
            ELSE 0 END AS gp_pct
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        ${filteredWhere}
        GROUP BY T0.CardCode
      ) sub
    `, { dateFrom, dateTo })

    const d = kpis[0] || {}, p = prevKpis[0] || {}, y = ytdKpis[0] || {}, ly = lyKpis[0] || {}

    // Delta vs previous period (pct)
    const delta = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : 0)

    const result = {
      revenue:      d.revenue || 0,
      volume_bags:  d.volume_bags || 0,
      volume_mt:    d.volume_mt || 0,
      gross_margin: d.gross_margin || 0,
      gm_per_bag:   d.gm_per_bag || 0,
      gmt:          d.gmt || 0,

      previous_period: {
        revenue:      p.revenue || 0,
        volume_mt:    p.volume_mt || 0,
        gross_margin: p.gross_margin || 0,
        gmt:          p.gmt || 0
      },
      last_year: {
        revenue:      ly.revenue || 0,
        volume_mt:    ly.volume_mt || 0,
        gross_margin: ly.gross_margin || 0,
        gmt:          ly.gmt || 0
      },
      delta_pct: {
        revenue:      delta(d.revenue, p.revenue),
        volume_mt:    delta(d.volume_mt, p.volume_mt),
        gross_margin: delta(d.gross_margin, p.gross_margin),
        gmt:          delta(d.gmt, p.gmt)
      },
      delta_pct_ly: {
        revenue:      delta(d.revenue, ly.revenue),
        volume_mt:    delta(d.volume_mt, ly.volume_mt),
        gross_margin: delta(d.gross_margin, ly.gross_margin),
        gmt:          delta(d.gmt, ly.gmt)
      },
      ytd: {
        revenue:      y.revenue || 0,
        volume_mt:    y.volume_mt || 0,
        gross_margin: y.gross_margin || 0,
        gmt:          y.gmt || 0
      },
      budget: {
        fy_mt:         BUDGET_2026.annual_mt,
        fy_sales:      BUDGET_2026.annual_sales,
        fy_gm:         BUDGET_2026.annual_gm,
        mtd_mt:        mtd_budget_mt,
        ytd_mt:        ytd_budget_mt,
        ytd_sales:     ytd_budget_sales,
        ytd_gm:        ytd_budget_gm,
        months_elapsed: monthIdx + 1
      },

      ar_balance:           arBalance[0]?.total_balance || 0,
      ar_active_balance:    arBalance[0]?.active_balance || 0,
      ar_delinquent_balance: arBalance[0]?.delinquent_balance || 0,
      dso_total:            Math.round(dsoRow[0]?.dso_total || 0),
      dso_active:           Math.round(dsoRow[0]?.dso_active || 0),

      pending_po: {
        total_mt:     Math.round((pendingPO[0]?.total_mt || 0) * 10) / 10,
        total_value:  pendingPO[0]?.total_value || 0,
        total_orders: pendingPO[0]?.total_orders || 0,
        oldest_days:  pendingPO[0]?.oldest_days || 0
      },
      region_performance: regionPerf,
      top_customers: topCust,
      monthly_perf,
      quarterly_perf,
      margin_alerts: {
        critical: marginCounts[0]?.critical || 0,
        warning: marginCounts[0]?.warning || 0,
        watch: marginCounts[0]?.watch || 0,
        healthy: marginCounts[0]?.healthy || 0
      }
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [dashboard]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
