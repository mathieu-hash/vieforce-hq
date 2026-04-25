const { query, queryH } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { scopeForUser, buildScopeWhere } = require('./_scope')
const cache = require('../lib/cache')

// Finance-matching definitions (calibrated against Looker Studio dashboard 2026-04-17)
const ACTIVE      = `(ISNULL(C.frozenFor,'N')<>'Y' AND C.U_BpStatus='Active')`
const DELINQ_PRED = `(C.frozenFor='Y' OR C.U_BpStatus IN ('Delinquent','InActive'))`

// Empty-state AR payload — same shape as the populated response so Patrol can
// render a consistent zero-state view without branching.
function emptyArPayload(scope) {
  return {
    dso: 0, dso_active: 0, dso_total: 0, dso_7d_ago: 0, dso_variation: 0,
    total_balance: 0, active_balance: 0, delinquent_balance: 0,
    ar_7d_ago: 0, ar_variation: 0,
    ar_ly: 0, ar_ly_variation: 0, ar_ly_variation_pct: 0, overdue_ly: 0,
    account_status: { active: 0, delinquent: 0, inactive: 0 },
    active_customer_count: 0, delinquent_customer_count: 0,
    buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0,
               d91_120: 0, d121_365: 0, over_1y: 0 },
    by_region: [],
    clients: [],
    formula: { dso: '', active: '', delinq: '' },
    scope: {
      userId: scope.userId,
      role: scope.role || null,
      is_empty: true,
      slpCodes_count: 0,
      ly_unscoped: true
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Parse optional scope=user:<uuid>. Same pattern as /api/sales + /api/customers.
  let scope = null
  const scopeParam = req.query.scope
  if (scopeParam && typeof scopeParam === 'string' && scopeParam.startsWith('user:')) {
    const uuid = scopeParam.slice(5).trim()
    if (uuid) {
      try {
        scope = await scopeForUser(uuid)
      } catch (err) {
        console.error('[ar] scope resolve failed:', err.message)
        scope = { userId: uuid, error: 'scope_resolve_failed', is_empty: true,
                  slpCodes: [], districtCodes: [] }
      }
    }
  }

  // Zero-state short-circuit — caller has no SlpCodes/districts assigned yet.
  if (scope && scope.is_empty) {
    return res.json(emptyArPayload(scope))
  }

  // Per-query filter builder.
  //   bounded scope → EXISTS+CE%+SlpCode<>1 from buildScopeWhere
  //   unbounded / no scope → defense-in-depth CE%+SlpCode<>1 inline
  // Both variants append to an existing WHERE clause and never stand alone.
  const scopeIsBounded = !!(scope && scope.slpCodes !== 'ALL' && !scope.is_empty)
  const filterFor = (alias) => {
    if (scopeIsBounded) return buildScopeWhere(scope, alias).sql
    return ` AND ${alias}.CardCode NOT LIKE 'CE%'` +
           ` AND EXISTS (SELECT 1 FROM OCRD SC WHERE SC.CardCode = ${alias}.CardCode AND SC.SlpCode <> 1)`
  }

  // Cache key includes the resolved scope so user A's rows can't leak to user B.
  const scopeKey = scope ? `_u:${scope.userId}:${scope.role || 'unknown'}` : ''
  const cacheKey = `ar_v3_${req.url}_${session.role}_${session.region || 'ALL'}${scopeKey}`
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
        ${filterFor('C')}
    `)

    // -------------------- 2. AR + DSO --------------------
    // Trailing-90d formula (calibrated to Finance Dashboard: 32d)
    const arDso = await query(`
      DECLARE @ar_active DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE} ${filterFor('O')});
      DECLARE @ar_total DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate ${filterFor('O')});
      DECLARE @ar_delinq DECIMAL(18,2) = @ar_total - @ar_active;
      DECLARE @sales_90d_active DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) AND ${ACTIVE} ${filterFor('O')});
      DECLARE @sales_90d_total DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O
        WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) ${filterFor('O')});

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
        ${filterFor('O')}
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
          ${filterFor('O')}
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
          ${filterFor('O')}
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
      ORDER BY a.ar_share DESC
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
        ${filterFor('T0')}
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY balance DESC
    `)

    // -------------------- 6. 7-DAY COMPARISON (as of 7 days ago) --------------------
    // Current-period comparison — scoped so a DSM's "DSO 7 days ago" reflects
    // their own book, not national. LY snapshot (queryH below) stays unscoped.
    const comparison = await query(`
      DECLARE @ar_7d_ago DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N'
          AND O.DocDate <= DATEADD(DAY,-7,GETDATE())
          AND O.DocTotal > O.PaidToDate
          AND ${ACTIVE}
          ${filterFor('O')});
      DECLARE @sales_90d_7ago DECIMAL(18,2) = (
        SELECT ISNULL(SUM(O.DocTotal),0)
        FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
        WHERE O.CANCELED='N'
          AND O.DocDate BETWEEN DATEADD(DAY,-97,GETDATE()) AND DATEADD(DAY,-7,GETDATE())
          AND ${ACTIVE}
          ${filterFor('O')});
      SELECT
        @ar_7d_ago AS ar_7d_ago,
        CASE WHEN @sales_90d_7ago > 0 THEN @ar_7d_ago / (@sales_90d_7ago/90.0) ELSE 0 END AS dso_7d_ago
    `)

    // -------------------- 7. AR SNAPSHOT 1 YEAR AGO (historical DB) --------------------
    // Rebuild the same "as-of-date" calculation against Vienovo_Old: open AR as of LY-today.
    const arLyRows = await queryH(`
      SELECT
        ISNULL(SUM(O.DocTotal - O.PaidToDate), 0) AS ar_ly,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,DATEADD(YEAR,-1,GETDATE())) > 0
                         THEN O.DocTotal - O.PaidToDate ELSE 0 END), 0) AS overdue_ly
      FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
      WHERE O.CANCELED='N'
        AND O.DocDate <= DATEADD(YEAR,-1,GETDATE())
        AND O.DocTotal > O.PaidToDate
    `).catch(e => { console.warn('[ar] LY snapshot failed:', e.message); return [{}] })

    const d = arDso[0], s = statusCounts[0], a = aging[0], cmp = comparison[0]
    const lyAr = arLyRows[0] || {}

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
      ar_ly:          lyAr.ar_ly || 0,
      ar_ly_variation: (d?.total_balance || 0) - (lyAr.ar_ly || 0),
      ar_ly_variation_pct: lyAr.ar_ly > 0
        ? Math.round((((d?.total_balance || 0) - lyAr.ar_ly) / lyAr.ar_ly) * 1000) / 10
        : null,
      overdue_ly:     lyAr.overdue_ly || 0,

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
    // Scope meta — only when the caller passed ?scope=user:<uuid>. Web dashboard
    // (session auth, no scope) sees a byte-identical response shape.
    // ly_unscoped=true flags that the Vienovo_Old historical snapshot stays
    // national even when the current-period data is scoped — CardCodes were
    // re-keyed during the Jan 2026 migration and perfect LY filtering would
    // require name-based translation (deferred per spec).
    if (scope) {
      result.scope = {
        userId: scope.userId,
        role: scope.role || null,
        is_empty: !!scope.is_empty,
        slpCodes_count: scope.slpCodes === 'ALL' ? 'ALL' : (scope.slpCodes || []).length,
        ly_unscoped: true
      }
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [ar]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
