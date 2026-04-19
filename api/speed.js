const { query } = require('./_db')
const { verifySession, verifyServiceToken, applyRoleFilter } = require('./_auth')
const { scopeForUser } = require('./_scope')
const cache = require('../lib/cache')
const {
  countShippingDays,
  listHolidaysInPeriod,
  getPeriodBounds,
  getPeriodEndBound,
  getManilaToday,
  fmtISO
} = require('./lib/shipping_days')

// Speed scope filter = ODLN.SlpCode IN (...) direct.
// Design decision locked: attribution follows the delivery's own SlpCode, not
// the customer's home rep (OCRD.SlpCode). Aligns with Finance commission and
// handles leave-coverage correctly. No district filtering — ODLN has no
// U_districtName column.
function buildSpeedScopeFilter(scope, alias = 'T0') {
  if (!scope)                       return { sql: '', isEmpty: false }
  if (scope.slpCodes === 'ALL')     return { sql: '', isEmpty: false }
  if (scope.is_empty)               return { sql: '', isEmpty: true }
  const raw = scope.slpCodes || []
  if (!Array.isArray(raw) || raw.length === 0) return { sql: '', isEmpty: true }
  // Integer whitelist — defense against SQL injection from a malformed scope.
  const safe = raw.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== 1)
  if (safe.length === 0)            return { sql: '', isEmpty: true }
  return { sql: ` AND ${alias}.SlpCode IN (${safe.join(',')})`, isEmpty: false }
}

function emptySpeedPayload(period, todayPH, dateFrom, periodEnd, scope) {
  return {
    period,
    current_date_ph: fmtISO(todayPH),
    period_start:    fmtISO(dateFrom),
    period_end:      fmtISO(periodEnd),
    holidays_in_period: listHolidaysInPeriod(dateFrom, periodEnd),
    period_volume_mt: 0,
    shipping_days_elapsed: 0, shipping_days_total: 0, shipping_days_remaining: 0,
    daily_pullout: 0, projected_period_volume: 0, vs_prior_period_pct: 0,
    prior_period_volume_mt: 0, prior_period_daily_pullout: 0,
    mtd_actual: 0, days_elapsed: 0, days_total: 0, days_remaining: 0, projected_mtd: 0,
    last_month_full_mt: 0, last_month_same_day_mt: 0,
    vs_last_month_volume: 0, vs_last_month_pct: 0,
    actual_mt: 0, speed_per_day: 0, elapsed_days: 0, total_days: 0,
    remaining_days: 0, projected_mt: 0,
    target_mt: 0, pct_of_target: 0,
    daily: [],
    plant_breakdown: [],
    rsm_speed: [],
    feed_type_speed: [],
    weekly_matrix: { weeks: [], plants: [], grid: [] },
    scope: {
      userId: scope.userId,
      role: scope.role || null,
      is_empty: true,
      slpCodes_count: 0,
      attribution: 'ODLN.SlpCode'
    }
  }
}

// 2026 Budget targets (from Sales Volume Budget 2026)
// Annual: 188,266 MT | Q1: 41,800 | Q2: 45,184 | Q3: 49,389 | Q4: 51,893
const BUDGET_2026 = {
  annual: 188266,
  quarterly: [41800, 45184, 49389, 51893],  // Q1, Q2, Q3, Q4
  monthly: [
    13933, 13933, 13934,   // Q1: Jan, Feb, Mar (41,800 / 3)
    15061, 15061, 15062,   // Q2: Apr, May, Jun (45,184 / 3)
    16463, 16463, 16463,   // Q3: Jul, Aug, Sep (49,389 / 3)
    17298, 17298, 17297    // Q4: Oct, Nov, Dec (51,893 / 3)
  ]
}

function getTarget(period) {
  const now = new Date()
  const month = now.getMonth()      // 0-11
  const quarter = Math.floor(month / 3) // 0-3

  switch (period) {
    case '7D':  return Math.round(BUDGET_2026.monthly[month] * 7 / 30)
    case 'MTD': return BUDGET_2026.monthly[month]
    case 'QTD': return BUDGET_2026.quarterly[quarter]
    case 'YTD': return BUDGET_2026.annual
    default:    return BUDGET_2026.monthly[month]
  }
}

// countShippingDays / getPeriodBounds / getPeriodEndBound / getManilaToday
// are imported from ./lib/shipping_days (calendar-aware: Sundays + PH holidays).

/**
 * Prior period window (same shape as current, shifted one period back).
 * Used for vs_prior_period_pct on Daily Pullout.
 */
function getPriorPeriodWindow(period, currentFrom, today) {
  const day = 86400000
  switch (period) {
    case '7D': {
      return {
        from: new Date(currentFrom.getTime() - 7 * day),
        to:   new Date(today.getTime() - 7 * day)
      }
    }
    case 'MTD': {
      // Previous month, from day 1 through same day-of-month (clamped to month length)
      const from = new Date(currentFrom.getFullYear(), currentFrom.getMonth() - 1, 1)
      const lastDayPrev = new Date(today.getFullYear(), today.getMonth(), 0).getDate()
      const to = new Date(currentFrom.getFullYear(), currentFrom.getMonth() - 1,
                          Math.min(today.getDate(), lastDayPrev))
      return { from, to }
    }
    case 'QTD': {
      // Previous quarter, from Q start through same elapsed days count (calendar)
      const pq = Math.floor(currentFrom.getMonth() / 3) - 1
      const pyear = pq < 0 ? currentFrom.getFullYear() - 1 : currentFrom.getFullYear()
      const pqMonthStart = pq < 0 ? 9 : pq * 3
      const from = new Date(pyear, pqMonthStart, 1)
      const elapsedMs = today.getTime() - currentFrom.getTime()
      const to = new Date(from.getTime() + elapsedMs)
      return { from, to }
    }
    case 'YTD': {
      return {
        from: new Date(currentFrom.getFullYear() - 1, 0, 1),
        to:   new Date(today.getFullYear() - 1, today.getMonth(), today.getDate())
      }
    }
    default:
      return { from: currentFrom, to: today }
  }
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { period = 'MTD' } = req.query

  // Period bounds computed early so zero-state + cache key share them.
  const todayPH = getManilaToday()
  const { start: dateFrom, end: dateTo } = getPeriodBounds(period, todayPH)
  const periodEnd = getPeriodEndBound(period, todayPH)

  // Parse optional scope=user:<uuid>. Resolve once; each ODLN query gets its
  // own filter fragment via buildSpeedScopeFilter (always alias T0 — every
  // ODLN query in this file aliases it that way).
  let scope = null
  const scopeParam = req.query.scope
  if (scopeParam && typeof scopeParam === 'string' && scopeParam.startsWith('user:')) {
    const uuid = scopeParam.slice(5).trim()
    if (uuid) {
      try {
        scope = await scopeForUser(uuid)
      } catch (err) {
        console.error('[speed] scope resolve failed:', err.message)
        scope = { userId: uuid, error: 'scope_resolve_failed', is_empty: true,
                  slpCodes: [], districtCodes: [] }
      }
    }
  }
  const speedFilter = buildSpeedScopeFilter(scope, 'T0')

  // Zero-state short-circuit — no ODLN reads, no division math, no NaN risk.
  if (speedFilter.isEmpty) {
    return res.json(emptySpeedPayload(period, todayPH, dateFrom, periodEnd, scope))
  }

  // Cache key includes scope user so user A's rows cannot serve user B.
  const scopeKey = scope ? `_u:${scope.userId}:${scope.role || 'unknown'}` : ''
  const cacheKey = `speed_${req.url}_${session.role}_${session.region || 'ALL'}${scopeKey}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // Actual MT shipped (from ODLN delivery notes, NOT OINV invoices).
    // applyRoleFilter kept as a no-op pass-through for symmetry; the scope
    // filter (speedFilter.sql) is where real scoping happens now.
    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    const filteredWhere = baseWhere + speedFilter.sql

    const totalRow = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS actual_mt
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
    `, { dateFrom, dateTo })

    // Breakdown — daily for 7D/MTD, weekly for QTD, monthly for YTD
    let daily
    if (period === 'YTD') {
      daily = await query(`
        SELECT
          FORMAT(T0.DocDate, 'yyyy-MM')                                     AS ship_date,
          'Month'                                                           AS day_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS daily_mt
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${speedFilter.sql}
        GROUP BY FORMAT(T0.DocDate, 'yyyy-MM')
        ORDER BY ship_date ASC
      `, { dateFrom, dateTo })
    } else if (period === 'QTD') {
      daily = await query(`
        SELECT
          'W' + CAST(DATEPART(ISO_WEEK, T0.DocDate) AS VARCHAR)             AS ship_date,
          'Week'                                                            AS day_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS daily_mt
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${speedFilter.sql}
        GROUP BY DATEPART(ISO_WEEK, T0.DocDate)
        ORDER BY MIN(T0.DocDate) ASC
      `, { dateFrom, dateTo })
    } else {
      daily = await query(`
        SELECT
          CONVERT(VARCHAR(10), T0.DocDate, 120)                             AS ship_date,
          DATENAME(WEEKDAY, T0.DocDate)                                     AS day_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS daily_mt
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${speedFilter.sql}
        GROUP BY CONVERT(VARCHAR(10), T0.DocDate, 120), DATENAME(WEEKDAY, T0.DocDate)
        ORDER BY ship_date ASC
      `, { dateFrom, dateTo })
    }

    const actual_mt = totalRow[0]?.actual_mt || 0
    const today = todayPH

    // Calendar-aware shipping day counters. Today (Manila) counts as a shipping day.
    // Sundays + PH holidays (api/data/shipping_calendar_ph.json) are excluded.
    const elapsed_days = countShippingDays(dateFrom, today)
    const total_days = countShippingDays(dateFrom, periodEnd)
    const holidays_in_period = listHolidaysInPeriod(dateFrom, periodEnd)

    const speed_per_day = elapsed_days > 0 ? actual_mt / elapsed_days : 0
    const projected_mt = elapsed_days > 0
      ? Math.round(speed_per_day * total_days)
      : 0

    const target_mt = getTarget(period)
    const pct_of_target = target_mt > 0
      ? Math.round((projected_mt / target_mt) * 100)
      : 0

    // --- Plant breakdown (MTD from ODLN) ---
    const plant_breakdown = await query(`
      SELECT
        T1.WhsCode                                                       AS plant,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS mtd
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${speedFilter.sql}
      GROUP BY T1.WhsCode
      ORDER BY mtd DESC
    `, { dateFrom, dateTo })

    // --- RSM speed (by SlpCode) ---
    const rsm_speed = await query(`
      SELECT TOP 20
        S.SlpName                                                        AS rsm,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS current_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${speedFilter.sql}
      GROUP BY S.SlpName
      ORDER BY current_vol DESC
    `, { dateFrom, dateTo })

    // --- Feed type speed (by brand/description) ---
    const feed_type_speed = await query(`
      SELECT TOP 15
        T1.Dscription                                                    AS brand,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS current_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${speedFilter.sql}
      GROUP BY T1.Dscription
      ORDER BY current_vol DESC
    `, { dateFrom, dateTo })

    // --- Weekly matrix (last 6 weeks by plant) ---
    const weekly_raw = await query(`
      SELECT
        'W' + CAST(DATEPART(ISO_WEEK, T0.DocDate) AS VARCHAR)           AS week,
        T1.WhsCode                                                      AS plant,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(WEEK, -6, GETDATE()) AND T0.CANCELED = 'N'${speedFilter.sql}
      GROUP BY DATEPART(ISO_WEEK, T0.DocDate), T1.WhsCode
      ORDER BY MIN(T0.DocDate) ASC
    `)

    const weeks = [...new Set(weekly_raw.map(r => r.week))].sort()
    const plants = [...new Set(weekly_raw.map(r => r.plant))].sort()
    const weekly_matrix = {
      weeks,
      plants,
      grid: plants.map(p => weeks.map(w => {
        const match = weekly_raw.find(r => r.plant === p && r.week === w)
        return match ? Math.round(match.vol * 10) / 10 : 0
      }))
    }

    // Last month comparison (same-day-of-month window) — kept for legacy
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0)
    const lastMonthSameDay = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())
    const lastMonthRow = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mt_full,
        ISNULL(SUM(CASE WHEN T0.DocDate <= @lmSameDay THEN T1.Quantity * ISNULL(I.NumInSale, 1) ELSE 0 END) / 1000.0, 0) AS mt_to_same_day
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lmStart AND @lmEnd AND T0.CANCELED='N'${speedFilter.sql}
    `, { lmStart: lastMonthStart, lmEnd: lastMonthEnd, lmSameDay: lastMonthSameDay })

    const lm_full = lastMonthRow[0]?.mt_full || 0
    const lm_same = lastMonthRow[0]?.mt_to_same_day || 0
    const vs_lm_volume = actual_mt - lm_same
    const vs_lm_pct = lm_same > 0 ? Math.round(((actual_mt - lm_same) / lm_same) * 1000) / 10 : 0

    // ---- vs prior period (same shape, shifted back) for dynamic Daily Pullout ----
    const prior = getPriorPeriodWindow(period, dateFrom, today)
    const priorRow = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mt
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @pFrom AND @pTo AND T0.CANCELED='N'${speedFilter.sql}
    `, { pFrom: prior.from, pTo: prior.to })

    const prior_period_volume = priorRow[0]?.mt || 0
    const prior_elapsed_days = countShippingDays(prior.from, prior.to)
    const prior_daily_pullout = prior_elapsed_days > 0 ? prior_period_volume / prior_elapsed_days : 0
    const vs_prior_period_pct = prior_daily_pullout > 0
      ? Math.round(((speed_per_day - prior_daily_pullout) / prior_daily_pullout) * 1000) / 10
      : 0

    const result = {
      period,
      // ---- Calendar debug (PH shipping calendar — Sundays + holidays excluded) ----
      current_date_ph:     fmtISO(today),
      period_start:        fmtISO(dateFrom),
      period_end:          fmtISO(periodEnd),
      holidays_in_period,
      // ---- Canonical period-aware fields (prefer these) ----
      period_volume_mt:          Math.round(actual_mt * 10) / 10,
      shipping_days_elapsed:     elapsed_days,
      shipping_days_total:       total_days,
      shipping_days_remaining:   total_days - elapsed_days,
      daily_pullout:             Math.round(speed_per_day * 10) / 10,
      projected_period_volume:   projected_mt,
      vs_prior_period_pct:       vs_prior_period_pct,
      prior_period_volume_mt:    Math.round(prior_period_volume * 10) / 10,
      prior_period_daily_pullout:Math.round(prior_daily_pullout * 10) / 10,
      // ---- Back-compat aliases (retain for older code paths) ----
      mtd_actual:     Math.round(actual_mt * 10) / 10,
      days_elapsed:   elapsed_days,
      days_total:     total_days,
      days_remaining: total_days - elapsed_days,
      projected_mtd:  projected_mt,
      last_month_full_mt:      Math.round(lm_full * 10) / 10,
      last_month_same_day_mt:  Math.round(lm_same * 10) / 10,
      vs_last_month_volume:    Math.round(vs_lm_volume * 10) / 10,
      vs_last_month_pct:       vs_lm_pct,
      // Legacy names kept for back-compat with existing pages
      actual_mt:     Math.round(actual_mt * 10) / 10,
      speed_per_day: Math.round(speed_per_day * 10) / 10,
      elapsed_days,
      total_days,
      remaining_days: total_days - elapsed_days,
      projected_mt,
      target_mt,
      pct_of_target,
      daily,
      plant_breakdown,
      rsm_speed,
      feed_type_speed,
      weekly_matrix,
      ...(scope ? { scope: {
        userId: scope.userId,
        role: scope.role || null,
        is_empty: !!scope.is_empty,
        slpCodes_count: scope.slpCodes === 'ALL' ? 'ALL' : (scope.slpCodes || []).length,
        attribution: 'ODLN.SlpCode'
      }} : {})
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [speed]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
