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

    const monthly_trend = await query(`
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

    const po_total_mt = pendingPO.reduce((s, p) => s + p.qty_mt, 0)
    const po_by_brand = {}
    const po_by_region = {}
    pendingPO.forEach(p => {
      po_by_brand[p.brand] = (po_by_brand[p.brand] || 0) + p.qty_mt
      const region = ['AC','ACEXT','BAC'].includes(p.plant) ? 'Luzon'
        : ['HOREB','ARGAO','ALAE'].includes(p.plant) ? 'Visayas'
        : ['BUKID','CCPC'].includes(p.plant) ? 'Mindanao' : 'Other'
      po_by_region[region] = (po_by_region[region] || 0) + p.qty_mt
    })

    const pending_po = {
      summary: {
        total_mt: Math.round(po_total_mt * 10) / 10,
        total_orders: new Set(pendingPO.map(p => p.DocNum)).size,
        customers_count: new Set(pendingPO.map(p => p.customer_code)).size,
        oldest_days: pendingPO.length > 0 ? Math.max(...pendingPO.map(p => p.age_days)) : 0
      },
      by_brand: Object.entries(po_by_brand).map(([brand, mt]) => ({ brand, mt: Math.round(mt * 10) / 10 })).sort((a, b) => b.mt - a.mt),
      by_region: Object.entries(po_by_region).map(([region, mt]) => ({ region, mt: Math.round(mt * 10) / 10 })).sort((a, b) => b.mt - a.mt),
      top_customers: [...new Map(pendingPO.map(p => [p.customer_code, { customer: p.customer_name, code: p.customer_code }])).values()].slice(0, 10)
    }

    const result = { by_brand, top_customers, monthly_trend, pending_po }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [sales]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
