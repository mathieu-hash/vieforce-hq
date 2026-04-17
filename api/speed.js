const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

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

/**
 * Count Mon-Sat shipping days between two dates (inclusive).
 * Sunday (getDay()===0) is excluded.
 */
function countShippingDays(from, to) {
  let count = 0
  const d = new Date(from)
  while (d <= to) {
    if (d.getDay() !== 0) count++ // Mon=1 through Sat=6
    d.setDate(d.getDate() + 1)
  }
  return count
}

/**
 * Compute the shipping cutoff based on 5am Philippines rule.
 * Ops counts today's shipping as "closed" only after 5am the next morning.
 *   - If current PH hour >= 5 → cutoff = yesterday (today's shipping not yet finalized)
 *   - If current PH hour  < 5 → cutoff = day-before-yesterday (walk back past unfinished night)
 * If the resulting cutoff lands on Sunday, walk back one more day (Sat).
 * Returns { cutoff: Date@00:00 local, nowPH: Date, logic: 'after_5am' | 'before_5am' }.
 */
function getShippingCutoff() {
  const nowUtc = new Date()
  // Philippines = UTC+8, no DST
  const nowPH = new Date(nowUtc.getTime() + 8 * 3600 * 1000)
  const phHour = nowPH.getUTCHours()
  const offsetDays = phHour >= 5 ? 1 : 2
  const logic = phHour >= 5 ? 'after_5am' : 'before_5am'
  // Build cutoff from PH calendar date minus offset, at 00:00 local (server time)
  const y = nowPH.getUTCFullYear()
  const m = nowPH.getUTCMonth()
  const d = nowPH.getUTCDate()
  const cutoff = new Date(y, m, d - offsetDays)
  // Walk past Sunday (shouldn't count Sunday as shipping day)
  while (cutoff.getDay() === 0) cutoff.setDate(cutoff.getDate() - 1)
  return { cutoff, nowPH, logic }
}

/**
 * Get the last day of the period.
 */
function getPeriodEnd(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()

  switch (period) {
    case '7D':  return new Date(y, m, now.getDate())
    case 'MTD': return new Date(y, m + 1, 0)
    case 'QTD': return new Date(y, Math.floor(m / 3) * 3 + 3, 0)
    case 'YTD': return new Date(y, 11, 31)
    default:    return new Date(y, m + 1, 0)
  }
}

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
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache
  const cacheKey = `speed_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD' } = req.query
    const { dateFrom, dateTo: dateToRaw } = getPeriodDates(period)

    // 5am shipping cutoff rule — caps dateTo so volume/days only include finalized shipping days.
    // Applied to period-bounded queries (actual, daily, plant, rsm, feed_type, weekly_matrix, prior-period).
    const { cutoff, nowPH, logic: cutoffLogic } = getShippingCutoff()
    const dateTo = cutoff < dateToRaw ? cutoff : dateToRaw  // use cutoff unless period ends earlier

    // Actual MT shipped (from ODLN delivery notes, NOT OINV invoices)
    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

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
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
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
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
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
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
        GROUP BY CONVERT(VARCHAR(10), T0.DocDate, 120), DATENAME(WEEKDAY, T0.DocDate)
        ORDER BY ship_date ASC
      `, { dateFrom, dateTo })
    }

    const actual_mt = totalRow[0]?.actual_mt || 0
    const today = new Date()
    const periodEnd = getPeriodEnd(period)

    // elapsed_days respects the 5am cutoff (only count finalized shipping days)
    const elapsed_days = dateFrom > cutoff ? 0 : countShippingDays(dateFrom, cutoff)
    const total_days = countShippingDays(dateFrom, periodEnd)

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
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
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
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
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
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
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
      WHERE T0.DocDate >= DATEADD(WEEK, -6, GETDATE()) AND T0.CANCELED = 'N'
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
      WHERE T0.DocDate BETWEEN @lmStart AND @lmEnd AND T0.CANCELED='N'
    `, { lmStart: lastMonthStart, lmEnd: lastMonthEnd, lmSameDay: lastMonthSameDay })

    const lm_full = lastMonthRow[0]?.mt_full || 0
    const lm_same = lastMonthRow[0]?.mt_to_same_day || 0
    const vs_lm_volume = actual_mt - lm_same
    const vs_lm_pct = lm_same > 0 ? Math.round(((actual_mt - lm_same) / lm_same) * 1000) / 10 : 0

    // ---- vs prior period (same shape, shifted back) for dynamic Daily Pullout ----
    // Use cutoff (not today) so the prior window shares the same 5am-finalized shape.
    const prior = getPriorPeriodWindow(period, dateFrom, cutoff)
    const priorRow = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mt
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @pFrom AND @pTo AND T0.CANCELED='N'
    `, { pFrom: prior.from, pTo: prior.to })

    const prior_period_volume = priorRow[0]?.mt || 0
    const prior_elapsed_days = countShippingDays(prior.from, prior.to)
    const prior_daily_pullout = prior_elapsed_days > 0 ? prior_period_volume / prior_elapsed_days : 0
    const vs_prior_period_pct = prior_daily_pullout > 0
      ? Math.round(((speed_per_day - prior_daily_pullout) / prior_daily_pullout) * 1000) / 10
      : 0

    const fmtDate = (d) => d.toISOString().slice(0, 10)
    const result = {
      period,
      // ---- Cutoff debug (5am shipping rule) ----
      cutoff_date:         fmtDate(cutoff),
      cutoff_logic:        cutoffLogic,
      current_datetime_ph: nowPH.toISOString().replace('Z', '+08:00'),
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
      weekly_matrix
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [speed]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
