const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
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
  const cacheKey = `ar_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const baseWhere = `WHERE T0.CANCELED = 'N' AND T0.DocTotal > T0.PaidToDate`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- Total AR Balance ---
    const totalRow = await query(`
      SELECT ISNULL(SUM(T0.DocTotal - T0.PaidToDate), 0) AS total_balance
      FROM OINV T0
      ${filteredWhere}
    `)

    // --- DSO (Days Sales Outstanding) ---
    const dsoWhere = `WHERE T0.CANCELED = 'N' AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const dsoFiltered = applyRoleFilter(session, dsoWhere)

    const dsoRow = await query(`
      SELECT
        ISNULL(
          SUM(CASE WHEN T0.DocTotal > T0.PaidToDate THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) /
          NULLIF(SUM(T0.DocTotal) / 365.0, 0),
        0) AS dso
      FROM OINV T0
      ${dsoFiltered}
    `)

    // --- Aging Buckets ---
    const bucketsRow = await query(`
      SELECT
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) <= 0  THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS current_amt,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) BETWEEN 1 AND 30  THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d1_30,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) BETWEEN 31 AND 60 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d31_60,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) BETWEEN 61 AND 90 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d61_90,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) > 90 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d90plus
      FROM OINV T0
      ${filteredWhere}
    `)

    // --- Client-level detail ---
    const clients = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        SUM(T0.DocTotal - T0.PaidToDate)                   AS balance,
        MAX(DATEDIFF(DAY, T0.DocDueDate, GETDATE()))       AS days_overdue,
        CASE
          WHEN MAX(DATEDIFF(DAY, T0.DocDueDate, GETDATE())) <= 0  THEN 'current'
          WHEN MAX(DATEDIFF(DAY, T0.DocDueDate, GETDATE())) <= 30 THEN '1_30'
          WHEN MAX(DATEDIFF(DAY, T0.DocDueDate, GETDATE())) <= 60 THEN '31_60'
          WHEN MAX(DATEDIFF(DAY, T0.DocDueDate, GETDATE())) <= 90 THEN '61_90'
          ELSE '90plus'
        END AS bucket
      FROM OINV T0
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY balance DESC
    `)

    const result = {
      total_balance: totalRow[0]?.total_balance || 0,
      dso:           Math.round(dsoRow[0]?.dso || 0),
      buckets: {
        current: bucketsRow[0]?.current_amt || 0,
        d1_30:   bucketsRow[0]?.d1_30 || 0,
        d31_60:  bucketsRow[0]?.d31_60 || 0,
        d61_90:  bucketsRow[0]?.d61_90 || 0,
        d90plus: bucketsRow[0]?.d90plus || 0
      },
      clients
    }

    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [ar]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
