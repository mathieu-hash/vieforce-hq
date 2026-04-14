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
        ISNULL(SUM(T1.LineTotal), 0)                                   AS revenue,
        ISNULL(SUM(T1.Quantity), 0)                                    AS volume_mt,
        ISNULL(AVG(T1.GrssProfit / NULLIF(T1.Quantity, 0)), 0)        AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
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

    const result = {
      revenue:    kpis[0]?.revenue || 0,
      volume_mt:  kpis[0]?.volume_mt || 0,
      gmt:        kpis[0]?.gmt || 0,
      ar_balance: arBalance[0]?.ar_balance || 0
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [dashboard]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
