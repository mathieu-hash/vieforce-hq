const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// Finance-matching definitions (calibrated against Looker Studio dashboard 2026-04-17)
const ACTIVE      = `(ISNULL(C.frozenFor,'N')<>'Y' AND C.U_BpStatus='Active')`
const DELINQ_PRED = `(C.frozenFor='Y' OR C.U_BpStatus IN ('Delinquent','InActive'))`

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `ar_v3_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // -------------------- 1. ACCOUNT STATUS COUNTS --------------------
    const statusCounts = await query(`
      SELECT
        SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END) AS active_with_ar,
        SUM(CASE WHEN C.U_BpStatus='Delinquent' OR C.frozenFor='Y' THEN 1 ELSE 0 END) AS delinquent_with_ar,
        SUM(CASE WHEN C.U_BpStatus='InActive' THEN 1 ELSE 0 END) AS inactive_with_ar
      FROM (SELECT DISTINCT CardCode FROM OINV WHERE CANCELED='N' AND DocTotal > PaidToDate) S
      INNER JOIN OCRD C ON S.CardCode = C.CardCode
      WHERE C.CardType='C'
    `)

    // -------------------- 2. AR + DSO --------------------
    // Trailing-90d formula (calibrated to Finance Dashboard: 32d)
    const arDso = await query(`
      DECLARE @ar_active DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE});
      DECLARE @ar_total DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate);
      DECLARE @ar_delinq DECIMAL(18,2) = @ar_total - @ar_active;
      DECLARE @sales_90d_active DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) AND ${ACTIVE});
      DECLARE @sales_90d_total DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O
        WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()));

      SELECT
        @ar_active  AS active_balance,
        @ar_total   AS total_balance,
        @ar_delinq  AS delinquent_balance,
        CASE WHEN @sales_90d_active > 0 THEN @ar_active / (@sales_90d_active/90.0) ELSE 0 END AS dso_active,
        CASE WHEN @sales_90d_total  > 0 THEN @ar_total  / (@sales_90d_total /90.0) ELSE 0 END AS dso_total
    `)

    // -------------------- 3. 7-BUCKET AGING (active only) --------------------
    const aging = await query(`
      SELECT
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) <= 0 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS current_amt,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 1 AND 30 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d1_30,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 31 AND 60 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d31_60,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 61 AND 90 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d61_90,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 91 AND 120 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d91_120,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 121 AND 365 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d121_365,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) > 365 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS over_1y
      FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
      WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE}
    `)

    // -------------------- 4. REGIONAL DSO --------------------
    const byRegion = await query(`
      WITH ar_by_region AS (
        SELECT
          CASE
            WHEN INV.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
            WHEN INV.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
            WHEN INV.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
            ELSE 'Other' END AS region,
          SUM(ISNULL(INV.LineTotal,0) * (O.DocTotal - O.PaidToDate) / NULLIF(O.DocTotal,0)) AS ar_share,
          COUNT(DISTINCT O.DocEntry) AS inv_count
        FROM OINV O
        INNER JOIN OCRD C ON O.CardCode = C.CardCode
        INNER JOIN INV1 INV ON INV.DocEntry = O.DocEntry
        WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE}
        GROUP BY
          CASE
            WHEN INV.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
            WHEN INV.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
            WHEN INV.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
            ELSE 'Other' END
      ),
      sales_by_region AS (
        SELECT
          CASE
            WHEN INV.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
            WHEN INV.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
            WHEN INV.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
            ELSE 'Other' END AS region,
          SUM(INV.LineTotal) AS sales_90d
        FROM OINV O
        INNER JOIN OCRD C ON O.CardCode = C.CardCode
        INNER JOIN INV1 INV ON INV.DocEntry = O.DocEntry
        WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) AND ${ACTIVE}
        GROUP BY
          CASE
            WHEN INV.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
            WHEN INV.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
            WHEN INV.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
            ELSE 'Other' END
      )
      SELECT
        a.region,
        a.ar_share AS ar,
        ISNULL(s.sales_90d,0) AS sales_90d,
        CASE WHEN s.sales_90d > 0 THEN CAST(a.ar_share / (s.sales_90d/90.0) AS INT) ELSE 0 END AS dso
      FROM ar_by_region a
      LEFT JOIN sales_by_region s ON a.region = s.region
      ORDER BY a.ar DESC
    `)

    // -------------------- 5. CLIENT-LEVEL with terms + per-client DSO --------------------
    const clients = await query(`
      SELECT
        T0.CardCode, T0.CardName,
        MAX(C.U_BpStatus)    AS bp_status,
        MAX(C.frozenFor)     AS frozen_for,
        CASE WHEN MAX(CASE WHEN ${DELINQ_PRED} THEN 1 ELSE 0 END)=1 THEN 1 ELSE 0 END AS is_delinquent,
        MAX(PT.PymntGroup)   AS terms,
        SUM(T0.DocTotal - T0.PaidToDate) AS balance,
        SUM(CASE WHEN DATEDIFF(DAY,T0.DocDueDate,GETDATE()) <= 0 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) AS current_amt,
        SUM(CASE WHEN DATEDIFF(DAY,T0.DocDueDate,GETDATE()) BETWEEN 1 AND 7 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) AS new_overdue,
        SUM(CASE WHEN DATEDIFF(DAY,T0.DocDueDate,GETDATE()) BETWEEN -7 AND 0 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) AS falling_due,
        SUM(CASE WHEN DATEDIFF(DAY,T0.DocDueDate,GETDATE()) > 0 THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) AS overdue,
        MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) AS days_overdue,
        CASE
          WHEN MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) <= 0 THEN 'current'
          WHEN MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) <= 30 THEN '1_30'
          WHEN MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) <= 60 THEN '31_60'
          WHEN MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) <= 90 THEN '61_90'
          WHEN MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) <= 120 THEN '91_120'
          WHEN MAX(DATEDIFF(DAY,T0.DocDueDate,GETDATE())) <= 365 THEN '121_365'
          ELSE 'over_1y'
        END AS bucket
      FROM OINV T0
      INNER JOIN OCRD C ON T0.CardCode = C.CardCode
      LEFT JOIN OCTG PT ON C.GroupNum = PT.GroupNum
      WHERE T0.CANCELED='N' AND T0.DocTotal > T0.PaidToDate
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY balance DESC
    `)

    // -------------------- 6. 7-DAY COMPARISON (as of 7 days ago) --------------------
    const comparison = await query(`
      DECLARE @ar_7d_ago DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N'
          AND O.DocDate <= DATEADD(DAY,-7,GETDATE())
          AND O.DocTotal > O.PaidToDate
          AND ${ACTIVE});
      DECLARE @sales_90d_7ago DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N'
          AND O.DocDate BETWEEN DATEADD(DAY,-97,GETDATE()) AND DATEADD(DAY,-7,GETDATE())
          AND ${ACTIVE});
      SELECT
        @ar_7d_ago AS ar_7d_ago,
        CASE WHEN @sales_90d_7ago > 0 THEN @ar_7d_ago / (@sales_90d_7ago/90.0) ELSE 0 END AS dso_7d_ago
    `)

    const d = arDso[0], s = statusCounts[0], a = aging[0], cmp = comparison[0]

    const result = {
      // --- Hero numbers (Home + AR page) ---
      dso:            Math.round(d?.dso_active || 0),
      dso_active:     Math.round(d?.dso_active || 0),
      dso_total:      Math.round(d?.dso_total  || 0),
      dso_7d_ago:     Math.round(cmp?.dso_7d_ago || 0),
      dso_variation:  Math.round((d?.dso_active || 0) - (cmp?.dso_7d_ago || 0)),

      total_balance:      d?.total_balance || 0,
      active_balance:     d?.active_balance || 0,
      delinquent_balance: d?.delinquent_balance || 0,
      ar_7d_ago:      cmp?.ar_7d_ago || 0,
      ar_variation:   (d?.active_balance || 0) - (cmp?.ar_7d_ago || 0),

      // Account status (matches Finance Dashboard tiles)
      account_status: {
        active:      s?.active_with_ar || 0,
        delinquent:  s?.delinquent_with_ar || 0,
        inactive:    s?.inactive_with_ar || 0
      },
      active_customer_count:     s?.active_with_ar || 0,
      delinquent_customer_count: s?.delinquent_with_ar || 0,

      // 7-bucket aging
      buckets: {
        current:  a?.current_amt || 0,
        d1_30:    a?.d1_30 || 0,
        d31_60:   a?.d31_60 || 0,
        d61_90:   a?.d61_90 || 0,
        d91_120:  a?.d91_120 || 0,
        d121_365: a?.d121_365 || 0,
        over_1y:  a?.over_1y || 0
      },

      by_region: byRegion,
      clients,

      formula: {
        dso:    'Active AR / (Active 90d sales / 90)',
        active: `frozenFor <> 'Y' AND U_BpStatus = 'Active'`,
        delinq: `frozenFor = 'Y' OR U_BpStatus IN ('Delinquent','InActive')`
      }
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [ar]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
