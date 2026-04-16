const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache check
  const cacheKey = `dashboard_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD', region = 'ALL' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

    // --- Revenue, Volume, GM/T ---
    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const filteredWhere = applyRoleFilter(session, baseWhere)

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

    // --- AR Balance (all unpaid invoices, same role filter) ---
    const arWhere = `WHERE T0.CANCELED = 'N' AND T0.DocTotal > T0.PaidToDate`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const arFilteredWhere = applyRoleFilter(session, arWhere)

    const arBalance = await query(`
      SELECT ISNULL(SUM(T0.DocTotal - T0.PaidToDate), 0) AS ar_balance
      FROM OINV T0
      ${arFilteredWhere}
    `)

    // --- Pending PO (open sales orders from ORDR + RDR1) ---
    const pendingPO = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS total_mt
      FROM ORDR T0
      INNER JOIN RDR1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocStatus = 'O' AND T0.CANCELED = 'N'
    `)

    // --- Region performance ---
    const regionPerf = await query(`
      SELECT
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
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

    const result = {
      revenue:      kpis[0]?.revenue || 0,
      volume_bags:  kpis[0]?.volume_bags || 0,
      volume_mt:    kpis[0]?.volume_mt || 0,
      gross_margin: kpis[0]?.gross_margin || 0,
      gm_per_bag:   kpis[0]?.gm_per_bag || 0,
      gmt:          kpis[0]?.gmt || 0,
      ar_balance: arBalance[0]?.ar_balance || 0,
      pending_po: { total_mt: Math.round((pendingPO[0]?.total_mt || 0) * 10) / 10 },
      region_performance: regionPerf,
      top_customers: topCust,
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
