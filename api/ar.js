const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// Active customer = frozenFor <> 'Y' AND U_BpStatus = 'Active'
// Delinquent     = frozenFor = 'Y' OR U_BpStatus IN ('Delinquent','InActive')
const ACTIVE_PREDICATE = `(ISNULL(C.frozenFor,'N') <> 'Y' AND C.U_BpStatus = 'Active')`
const DELINQ_PREDICATE = `(C.frozenFor = 'Y' OR C.U_BpStatus IN ('Delinquent','InActive'))`

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `ar_v2_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const baseWhere = `WHERE T0.CANCELED = 'N' AND T0.DocTotal > T0.PaidToDate`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- Totals (active vs total) ---
    const balances = await query(`
      SELECT
        ISNULL(SUM(T0.DocTotal - T0.PaidToDate), 0) AS total_balance,
        ISNULL(SUM(CASE WHEN ${ACTIVE_PREDICATE} THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS active_balance,
        ISNULL(SUM(CASE WHEN ${DELINQ_PREDICATE} THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS delinquent_balance,
        COUNT(DISTINCT CASE WHEN ${DELINQ_PREDICATE} THEN T0.CardCode END) AS delinquent_customer_count,
        COUNT(DISTINCT CASE WHEN ${ACTIVE_PREDICATE} THEN T0.CardCode END) AS active_customer_count
      FROM OINV T0
      INNER JOIN OCRD C ON T0.CardCode = C.CardCode
      ${filteredWhere}
    `)

    // --- DSO (active vs total) ---
    const dsoBase = `WHERE T0.CANCELED = 'N' AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())`
    const dsoFiltered = applyRoleFilter(session, dsoBase)

    const dsoRow = await query(`
      SELECT
        ISNULL(
          (SELECT SUM(T0.DocTotal - T0.PaidToDate)
           FROM OINV T0 INNER JOIN OCRD C ON T0.CardCode = C.CardCode
           ${filteredWhere}) /
          NULLIF((SELECT SUM(T0.DocTotal)/365.0 FROM OINV T0 INNER JOIN OCRD C ON T0.CardCode = C.CardCode ${dsoFiltered}), 0),
        0) AS dso_total,
        ISNULL(
          (SELECT SUM(T0.DocTotal - T0.PaidToDate)
           FROM OINV T0 INNER JOIN OCRD C ON T0.CardCode = C.CardCode
           ${filteredWhere} AND ${ACTIVE_PREDICATE}) /
          NULLIF(
            (SELECT SUM(T0.DocTotal)/365.0
             FROM OINV T0 INNER JOIN OCRD C ON T0.CardCode = C.CardCode
             ${dsoFiltered} AND ${ACTIVE_PREDICATE}), 0),
        0) AS dso_active
    `)

    // --- Aging Buckets (active only) ---
    const bucketsRow = await query(`
      SELECT
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) <= 0  THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS current_amt,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) BETWEEN 1 AND 30  THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d1_30,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) BETWEEN 31 AND 60 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d31_60,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) BETWEEN 61 AND 90 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d61_90,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) > 90 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0) AS d90plus
      FROM OINV T0
      INNER JOIN OCRD C ON T0.CardCode = C.CardCode
      ${filteredWhere} AND ${ACTIVE_PREDICATE}
    `)

    // --- Client-level detail (all customers, flagged) ---
    const clients = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        MAX(C.U_BpStatus) AS bp_status,
        MAX(C.frozenFor)  AS frozen_for,
        CASE WHEN MAX(CASE WHEN ${DELINQ_PREDICATE} THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS is_delinquent,
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
      INNER JOIN OCRD C ON T0.CardCode = C.CardCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY balance DESC
    `)

    const result = {
      total_balance:             balances[0]?.total_balance || 0,
      active_balance:            balances[0]?.active_balance || 0,
      delinquent_balance:        balances[0]?.delinquent_balance || 0,
      delinquent_customer_count: balances[0]?.delinquent_customer_count || 0,
      active_customer_count:     balances[0]?.active_customer_count || 0,
      dso:        Math.round(dsoRow[0]?.dso_active || 0),   // back-compat: `dso` now = active DSO
      dso_active: Math.round(dsoRow[0]?.dso_active || 0),
      dso_total:  Math.round(dsoRow[0]?.dso_total  || 0),
      buckets: {
        current: bucketsRow[0]?.current_amt || 0,
        d1_30:   bucketsRow[0]?.d1_30 || 0,
        d31_60:  bucketsRow[0]?.d31_60 || 0,
        d61_90:  bucketsRow[0]?.d61_90 || 0,
        d90plus: bucketsRow[0]?.d90plus || 0
      },
      clients,
      filter_definition: {
        active:     `frozenFor <> 'Y' AND U_BpStatus = 'Active'`,
        delinquent: `frozenFor = 'Y' OR U_BpStatus IN ('Delinquent','InActive')`
      }
    }

    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [ar]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
