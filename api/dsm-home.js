// GET /api/dsm/home — Mobile DSM dashboard aggregation.
//
// Blends SAP (Vienovo_Live OINV/OCRD) and Patrol (Supabase users/stores/visits).
// Scope: the calling DSM's own data — filtered by OSLP.SlpName ~ session.name.
//
// Returns:
//   {
//     dsm: { id, name, district, region, tsr_count, distributor_count },
//     sales: { mtd_revenue, mtd_volume_mt, prev_period_revenue, vs_pp_pct,
//              target, target_pct, ytd_revenue, ytd_volume_mt },
//     ar: { total_open, overdue_amount, overdue_count },
//     distributors: [ {code, name, mtd_revenue, mtd_volume_mt, ar_overdue, trend_pct} ],
//     tsrs: [ {id, name, phone, visits_today, total_stores} ],
//     conversions_mtd: 0,     // Patrol not yet tracking conversion events
//     coaching:        { urgent: [], positive: [], push: [] },
//     critical:        { ar_overdue: [], at_risk_stores: [], idle_tsrs: [],
//                        negative_margin_customers: [] },
//     meta: { sap_matched_rows, patrol_available, generated_at }
//   }

const { query } = require('./_db')
const { verifySession, getPeriodDates } = require('./_auth')
const cache = require('../lib/cache')
const { isNonCustomerRow } = require('./lib/non-customer-codes')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

function todayISO() {
  // Asia/Manila midnight as ISO. Patrol visits stored as TIMESTAMPTZ;
  // comparing to midnight PH is close enough for "today" counts.
  const now = new Date()
  const ph = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }))
  ph.setHours(0, 0, 0, 0)
  return ph.toISOString()
}

/**
 * Read all Patrol-side data for this DSM in a single bundle.
 * If any table is missing (pre-migration project), return empty shape
 * rather than 500 — the UI will render zero-state gracefully.
 */
async function loadPatrolForDsm(dsmId) {
  const empty = { tsrs: [], visits_today_map: {}, stores_map: {}, error: null }
  if (!dsmId) return empty
  try {
    // TSRs that report to this DSM (manager_id FK from sprint-a-hierarchy migration)
    const { data: tsrs, error: eU } = await supabase
      .from('users')
      .select('id, name, phone, is_active, role, region, district, territory')
      .eq('manager_id', dsmId)
      .eq('is_active', true)

    if (eU) {
      // Table / column missing -> non-fatal
      if (/does not exist|schema cache/i.test(eU.message || '')) {
        return { ...empty, error: 'Patrol users table or manager_id column missing' }
      }
      console.warn('[dsm-home] users query error:', eU.message)
      return { ...empty, error: eU.message }
    }

    const tsrList = (tsrs || []).filter(u => (u.role || '').toLowerCase() === 'tsr')
    const tsrIds  = tsrList.map(t => t.id)

    const visits_today_map = {}
    const stores_map = {}
    if (tsrIds.length) {
      const today = todayISO()
      // Fetch today's visits for all TSRs in one call
      const { data: vRows, error: eV } = await supabase
        .from('visits')
        .select('tsr_id')
        .in('tsr_id', tsrIds)
        .gte('visited_at', today)
      if (!eV && vRows) {
        for (const r of vRows) visits_today_map[r.tsr_id] = (visits_today_map[r.tsr_id] || 0) + 1
      }
      // Stores assigned per TSR
      const { data: sRows, error: eS } = await supabase
        .from('stores')
        .select('assigned_tsr')
        .in('assigned_tsr', tsrIds)
      if (!eS && sRows) {
        for (const r of sRows) stores_map[r.assigned_tsr] = (stores_map[r.assigned_tsr] || 0) + 1
      }
    }

    return { tsrs: tsrList, visits_today_map, stores_map, error: null }
  } catch (e) {
    console.warn('[dsm-home] patrol load failed:', e.message)
    return { ...empty, error: e.message }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const dsmName     = session.name || ''
  const dsmDistrict = session.district || ''
  const dsmRegion   = session.region || ''

  const cacheKey = `dsm_home_${session.id}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { dateFrom: mtdStart, dateTo: today } = getPeriodDates('MTD')
    // Prior month-to-date equivalent window
    const prev = new Date(mtdStart); prev.setMonth(prev.getMonth() - 1)
    const prevEnd = new Date(today);  prevEnd.setMonth(prevEnd.getMonth() - 1)
    const ytdStart = new Date(today.getFullYear(), 0, 1)

    // SlpName match: UPPER(LIKE) over session.name. If a DSM sign-on uses a
    // short first name ("RICO") it will still hit "RICO ABANTE". Null-safe.
    const nameTrim = String(dsmName).trim()
    const dsmFilter = nameTrim
      ? `INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
         WHERE UPPER(S.SlpName) LIKE '%' + UPPER(@dsmName) + '%'
           AND T0.CANCELED = 'N'`
      : `WHERE T0.CANCELED = 'N' AND 1=0`   // no name → no data (rather than national)

    // ---------- 1. MTD sales for this DSM ----------
    const mtdRows = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)    AS volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                   AS gm,
        COUNT(DISTINCT T0.CardCode)                                     AS distinct_customers
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
      ${dsmFilter}
        AND T0.DocDate BETWEEN @mtdStart AND @today
    `, { mtdStart, today, dsmName: nameTrim })

    // ---------- 2. Prior period same-days-elapsed ----------
    const prevRows = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)    AS volume_mt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
      ${dsmFilter}
        AND T0.DocDate BETWEEN @prev AND @prevEnd
    `, { prev, prevEnd, dsmName: nameTrim })

    // ---------- 3. YTD sales ----------
    const ytdRows = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)    AS volume_mt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
      ${dsmFilter}
        AND T0.DocDate >= @ytdStart
    `, { ytdStart, dsmName: nameTrim })

    // ---------- 4. Top 5 distributors (MTD) ----------
    const distRaw = await query(`
      SELECT TOP 20
        T0.CardCode                                                     AS code,
        MAX(T0.CardName)                                                AS name,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS mtd_revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)    AS mtd_volume_mt,
        ISNULL(SUM(T1.GrssProfit), 0)                                   AS mtd_gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
      ${dsmFilter}
        AND T0.DocDate BETWEEN @mtdStart AND @today
      GROUP BY T0.CardCode
      ORDER BY mtd_revenue DESC
    `, { mtdStart, today, dsmName: nameTrim })
    const distCleaned = (distRaw || []).filter(r => !isNonCustomerRow(r.code, r.name))
    const top_distributors = distCleaned.slice(0, 5)

    // ---------- 5. AR open per-customer ----------
    const arAll = await query(`
      SELECT
        T0.CardCode                                                     AS code,
        MAX(T0.CardName)                                                AS name,
        ISNULL(SUM(T0.DocTotal - T0.PaidToDate), 0)                     AS open_amount,
        ISNULL(SUM(CASE WHEN T0.DocDueDate < GETDATE()
            THEN T0.DocTotal - T0.PaidToDate ELSE 0 END), 0)            AS overdue_amount,
        MAX(CASE WHEN T0.DocDueDate < GETDATE()
            THEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) ELSE 0 END)    AS days_overdue
      FROM OINV T0
      INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE UPPER(S.SlpName) LIKE '%' + UPPER(@dsmName) + '%'
        AND T0.CANCELED = 'N'
        AND T0.DocTotal > T0.PaidToDate
      GROUP BY T0.CardCode
    `, { dsmName: nameTrim }).catch(e => { console.warn('[dsm-home] AR query:', e.message); return [] })
    const arClean = (arAll || []).filter(r => !isNonCustomerRow(r.code, r.name))
    const ar_total_open      = arClean.reduce((s, r) => s + Number(r.open_amount || 0), 0)
    const ar_overdue_amount  = arClean.reduce((s, r) => s + Number(r.overdue_amount || 0), 0)
    const ar_overdue_count   = arClean.filter(r => Number(r.overdue_amount || 0) > 0).length
    const arMap = new Map(arClean.map(r => [r.code, Number(r.overdue_amount || 0)]))
    // Enrich distributors with per-customer overdue
    for (const d of top_distributors) d.ar_overdue = Math.round(arMap.get(d.code) || 0)

    // Critical AR list (top 5 overdue)
    const ar_critical_list = arClean
      .filter(r => Number(r.overdue_amount || 0) > 0)
      .sort((a, b) => Number(b.overdue_amount || 0) - Number(a.overdue_amount || 0))
      .slice(0, 5)
      .map(r => ({
        code:           r.code,
        name:           r.name || r.code,
        overdue_amount: Math.round(Number(r.overdue_amount || 0)),
        days_overdue:   Number(r.days_overdue || 0)
      }))

    // Total distinct distributors YTD (for KPI)
    const distinctYtdRow = await query(`
      SELECT COUNT(DISTINCT T0.CardCode) AS c
      FROM OINV T0
      INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE UPPER(S.SlpName) LIKE '%' + UPPER(@dsmName) + '%'
        AND T0.CANCELED = 'N'
        AND T0.DocDate >= @ytdStart
    `, { ytdStart, dsmName: nameTrim }).catch(() => [])
    const distributor_count = Number(distinctYtdRow[0]?.c || 0)

    // Negative-margin customers MTD (small list)
    const negMargin = await query(`
      SELECT TOP 5
        T0.CardCode                                                     AS code,
        MAX(T0.CardName)                                                AS name,
        ISNULL(SUM(T1.GrssProfit), 0)                                   AS gp,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100 ELSE 0 END  AS gp_pct
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      INNER JOIN OSLP S  ON T0.SlpCode = S.SlpCode
      WHERE UPPER(S.SlpName) LIKE '%' + UPPER(@dsmName) + '%'
        AND T0.CANCELED = 'N'
        AND T0.DocDate BETWEEN @mtdStart AND @today
      GROUP BY T0.CardCode
      HAVING SUM(T1.GrssProfit) < 0
      ORDER BY gp ASC
    `, { mtdStart, today, dsmName: nameTrim }).catch(() => [])

    // ---------- 6. Patrol data (TSRs / visits / stores) ----------
    const patrol = await loadPatrolForDsm(session.id)
    const tsrs = (patrol.tsrs || []).map(t => ({
      id:           t.id,
      name:         t.name || '(unnamed)',
      phone:        t.phone || '',
      district:     t.district || dsmDistrict,
      territory:    t.territory || '',
      visits_today: patrol.visits_today_map[t.id] || 0,
      total_stores: patrol.stores_map[t.id] || 0,
      active_today: (patrol.visits_today_map[t.id] || 0) > 0
    }))
    const active_tsrs = tsrs.filter(t => t.active_today).length
    const total_tsrs  = tsrs.length
    const idle_tsrs   = tsrs.filter(t => !t.active_today && t.total_stores > 0)
      .slice(0, 5)
      .map(t => ({ id: t.id, name: t.name, total_stores: t.total_stores }))

    // ---------- 7. Coaching moments (heuristic v1) ----------
    const urgent = []
    const positive = []
    const push = []
    for (const t of tsrs) {
      if (!t.active_today && t.total_stores >= 3)
        urgent.push({ tsr_id: t.id, tsr_name: t.name, message: 'No visits logged today' })
      if (t.visits_today >= 5)
        positive.push({ tsr_id: t.id, tsr_name: t.name, message: `${t.visits_today} visits today — strong field day` })
      if (t.total_stores === 0)
        push.push({ tsr_id: t.id, tsr_name: t.name, message: 'No stores assigned yet' })
    }

    // ---------- 8. Sales KPI + target ----------
    const sales_mtd     = Math.round(Number(mtdRows[0]?.revenue || 0))
    const sales_prev    = Math.round(Number(prevRows[0]?.revenue || 0))
    const sales_vs_pp   = sales_prev > 0
      ? Math.round(((sales_mtd - sales_prev) / sales_prev) * 1000) / 10 : 0
    const volume_mtd_mt = Math.round(Number(mtdRows[0]?.volume_mt || 0) * 10) / 10
    const volume_prev_mt= Math.round(Number(prevRows[0]?.volume_mt || 0) * 10) / 10
    const ytd_revenue   = Math.round(Number(ytdRows[0]?.revenue || 0))
    const ytd_volume_mt = Math.round(Number(ytdRows[0]?.volume_mt || 0) * 10) / 10
    // v1 target: 110% of prior period (deliberate stretch). DSM-level budgets
    // will come later via an upload once RBAC is enforced.
    const target        = Math.round(sales_prev * 1.1)
    const target_pct    = target > 0 ? Math.round((sales_mtd / target) * 1000) / 10 : 0

    const result = {
      dsm: {
        id:       session.id,
        name:     dsmName,
        district: dsmDistrict,
        region:   dsmRegion,
        tsr_count: total_tsrs,
        distributor_count
      },
      sales: {
        mtd_revenue:         sales_mtd,
        mtd_volume_mt:       volume_mtd_mt,
        prev_period_revenue: sales_prev,
        prev_period_volume_mt: volume_prev_mt,
        vs_pp_pct:           sales_vs_pp,
        target,
        target_pct,
        ytd_revenue,
        ytd_volume_mt
      },
      kpis: {
        distributors_count: distributor_count,
        active_tsrs,
        total_tsrs,
        ar_overdue_amount:  Math.round(ar_overdue_amount),
        ar_overdue_count,
        conversions_mtd:    0     // Patrol does not yet track conversion events
      },
      ar: {
        total_open:      Math.round(ar_total_open),
        overdue_amount:  Math.round(ar_overdue_amount),
        overdue_count:   ar_overdue_count
      },
      distributors: top_distributors.map(d => ({
        code:          d.code,
        name:          d.name,
        mtd_revenue:   Math.round(Number(d.mtd_revenue || 0)),
        mtd_volume_mt: Math.round(Number(d.mtd_volume_mt || 0) * 10) / 10,
        mtd_gm:        Math.round(Number(d.mtd_gm || 0)),
        ar_overdue:    Math.round(Number(d.ar_overdue || 0))
      })),
      tsrs,
      conversions_mtd: 0,
      coaching: { urgent, positive, push },
      critical: {
        ar_overdue:                ar_critical_list,
        at_risk_stores:            [],       // populated in v1.1 from Patrol store health
        idle_tsrs,
        negative_margin_customers: (negMargin || []).map(r => ({
          code:    r.code,
          name:    r.name,
          gp:      Math.round(Number(r.gp || 0)),
          gp_pct:  Math.round(Number(r.gp_pct || 0) * 10) / 10
        }))
      },
      meta: {
        sap_matched_rows:  Number(mtdRows[0]?.distinct_customers || 0),
        patrol_available:  !patrol.error,
        patrol_error:      patrol.error || null,
        generated_at:      new Date().toISOString()
      }
    }

    cache.set(cacheKey, result, 120)     // 2 min — DSM home is high-touch
    res.json(result)
  } catch (err) {
    console.error('API error [dsm-home]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
