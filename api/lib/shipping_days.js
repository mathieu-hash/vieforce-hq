const calendar = require('../data/shipping_calendar_ph.json')

// Format a Date as YYYY-MM-DD in local (server) time zone — avoids the 1-day shift
// that toISOString() can cause when server is in a timezone other than PH.
function fmtISO(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Return current date in Asia/Manila time zone as a Date object at 00:00 local.
 * Works regardless of server TZ because we derive from UTC + 8h offset.
 */
function getManilaToday() {
  const nowUtc = new Date()
  const nowPH = new Date(nowUtc.getTime() + 8 * 3600 * 1000)
  return new Date(nowPH.getUTCFullYear(), nowPH.getUTCMonth(), nowPH.getUTCDate())
}

/**
 * Anchor date in Manila for dashboard/speed when ?ref_month=YYYY-MM is set.
 * - Past month: last day of that month (full month view).
 * - Current month: min(today, month end) in Manila.
 * - Future month: real today (no lookahead).
 */
function resolveRefMonthAnchor(refMonth) {
  const realToday = getManilaToday()
  if (!refMonth || typeof refMonth !== 'string' || !/^\d{4}-\d{2}$/.test(refMonth.trim())) {
    return realToday
  }
  const raw = refMonth.trim()
  const y = parseInt(raw.slice(0, 4), 10)
  const mo = parseInt(raw.slice(5, 7), 10) - 1
  if (mo < 0 || mo > 11) return realToday
  const monthStart = new Date(y, mo, 1)
  const monthEnd = new Date(y, mo + 1, 0)
  if (realToday < monthStart) return realToday
  if (realToday > monthEnd) return monthEnd
  return realToday
}

function isClosed(date) {
  if (date.getDay() === 0) return true  // Sunday
  return Boolean(calendar.closed_dates[fmtISO(date)])
}

/**
 * Count shipping days (inclusive) between two dates.
 * Sundays and calendar.closed_dates are excluded.
 */
function countShippingDays(startDate, endDate) {
  if (startDate > endDate) return 0
  let count = 0
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
  while (cursor <= end) {
    if (!isClosed(cursor)) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

/**
 * List holidays that fall within [startDate, endDate] inclusive.
 * Does not include Sundays.
 */
function listHolidaysInPeriod(startDate, endDate) {
  const out = []
  const startIso = fmtISO(startDate)
  const endIso = fmtISO(endDate)
  for (const [iso, name] of Object.entries(calendar.closed_dates)) {
    if (iso >= startIso && iso <= endIso) {
      out.push({ date: iso, name })
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

/**
 * Period start/end bounds for the four periods used by /api/speed.
 * `today` is the Manila "today" Date.
 *   7D: rolling 7 days, window starts 6 days before today
 *   MTD: month start → today
 *   QTD: quarter start → today
 *   YTD: year start → today
 */
function getPeriodBounds(period, today) {
  const y = today.getFullYear()
  const m = today.getMonth()
  let start
  switch (period) {
    case '7D':
      // Intended 7-day semantics: a true rolling 7-day window is [today-6 .. today]
      // INCLUSIVE (6 prior days + today = 7 calendar days). This deliberately differs
      // from _auth.getPeriodDates, whose historical 7D start was one day earlier
      // (an 8-day inclusive span). Do NOT "align" _auth to this — /api/speed depends
      // on this 7-day window while other endpoints rely on _auth's wider span.
      start = new Date(y, m, today.getDate() - 6)
      break
    case 'QTD':
      start = new Date(y, Math.floor(m / 3) * 3, 1)
      break
    case 'YTD':
      start = new Date(y, 0, 1)
      break
    case 'MTD':
    default:
      start = new Date(y, m, 1)
      break
  }
  return { start, end: today }
}

/**
 * Period end bound — the last day of the period (for shipping_days_total).
 */
function getPeriodEndBound(period, today) {
  const y = today.getFullYear()
  const m = today.getMonth()
  switch (period) {
    case '7D':
      return today  // 7D total = rolling 7 (elapsed == total at end of rolling window)
    case 'QTD':
      return new Date(y, Math.floor(m / 3) * 3 + 3, 0)
    case 'YTD':
      return new Date(y, 11, 31)
    case 'MTD':
    default:
      return new Date(y, m + 1, 0)
  }
}

module.exports = {
  calendar,
  fmtISO,
  getManilaToday,
  resolveRefMonthAnchor,
  isClosed,
  countShippingDays,
  listHolidaysInPeriod,
  getPeriodBounds,
  getPeriodEndBound
}
