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
        T1.Dscription                                        AS brand,
        ISNULL(SUM(T1.Quantity), 0)                          AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)                         AS revenue,
        ISNULL(AVG(T1.GrssProfit / NULLIF(T1.Quantity, 0)), 0) AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      ${filteredWhere}
      GROUP BY T1.Dscription
      ORDER BY volume_mt DESC
    `, { dateFrom, dateTo })

    // --- Top 20 Customers ---
    const top_customers = await query(`
      SELECT TOP 20
        T0.CardCode                       AS customer_code,
        T0.CardName                       AS customer_name,
        ISNULL(SUM(T1.Quantity), 0)       AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)      AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
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
        FORMAT(T0.DocDate, 'yyyy-MM')     AS month,
        ISNULL(SUM(T1.Quantity), 0)       AS volume_mt,
        ISNULL(SUM(T1.LineTotal), 0)      AS revenue
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      ${trendFiltered}
      GROUP BY FORMAT(T0.DocDate, 'yyyy-MM')
      ORDER BY month ASC
    `)

    const result = { by_brand, top_customers, monthly_trend }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [sales]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
