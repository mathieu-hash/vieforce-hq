// api/lib/margin_window.js
//
// Like-for-like window resolution for the Margin Explorer bridge.
//
// THE BUG THIS FIXES: the dissection bridge anchored on full calendar months. When
// the compare month is the running one, that compares (say) 7 posted days of August
// against all 23 posting days of July, while labelling it "compare month partial".
// The label was cosmetic — nothing was truncated. The distortion is not neutral:
// a customer x SKU that simply has not shipped yet is a cell EXIT, and an exit's
// entire weight lands in Mix and can never touch Price or Cost. So the method is
// structurally biased toward "it's mix".
//
// THE FIX: truncate the base month to the same number of SHIPPING DAYS that have
// actually elapsed in the compare month, where "elapsed" comes from MAX(DocDate) in
// the data — never from the server clock (v1 used `new Date().getDate()-1`, which
// drifts with server TZ and ignores posting lag).
//
// Shipping days (not calendar days) because Sundays and PH holidays carry no
// invoicing; matching calendar days would silently compare 6 working days against 8.

'use strict'

const { countShippingDays, isClosed } = require('./shipping_days')

const firstOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1) }
const nextMonthOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 1) }
const lastOf = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0) }
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x }

// Walk forward from the 1st until `target` shipping days have been consumed.
// Returns the date of the target-th shipping day, clamped to month end.
function nthShippingDay(ym, target) {
  const end = lastOf(ym)
  if (target <= 0) return firstOf(ym)
  let count = 0
  const cur = firstOf(ym)
  while (cur <= end) {
    if (!isClosed(cur)) {
      count++
      if (count >= target) return new Date(cur.getFullYear(), cur.getMonth(), cur.getDate())
    }
    cur.setDate(cur.getDate() + 1)
  }
  return end
}

/**
 * Resolve a comparable [base, compare] window pair.
 *
 * runner: async (sql, params) => rows      — the endpoint's `query`
 * scopeSql: a SELECT returning MAX(DocDate) AS d for the compare month, with
 *           @c0 / @c1 bound. Must apply the SAME scope + filters as the bridge,
 *           otherwise the elapsed window is measured on a different universe.
 * scopeParams: extra bound params the scope SQL needs (region prefix, bu, cust).
 *
 * Returns { b0, b1, c0, c1, meta }. b1/c1 are EXCLUSIVE upper bounds.
 */
async function resolveLikeForLike(runner, scopeSql, scopeParams, baseMonth, cmpMonth) {
  const c0 = firstOf(cmpMonth)
  const cMonthEnd = lastOf(cmpMonth)
  const cNext = nextMonthOf(cmpMonth)

  // Data-driven end of the compare window: the last date that actually has posted
  // invoices in scope. Falls back to month end if the probe returns nothing.
  let cEnd = cMonthEnd
  let probeOk = false
  try {
    const r = await runner(scopeSql, { ...scopeParams, c0, c1: cNext })
    const d = r && r[0] && r[0].d ? new Date(r[0].d) : null
    if (d && !isNaN(d)) { cEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate()); probeOk = true }
  } catch (e) {
    // Probe failure must not break the bridge — fall back to full month and say so.
    probeOk = false
  }
  if (cEnd > cMonthEnd) cEnd = cMonthEnd

  const cShipDays = countShippingDays(c0, cEnd)
  const cShipDaysFull = countShippingDays(c0, cMonthEnd)
  const partial = cShipDays < cShipDaysFull

  // Base window: same elapsed shipping days when the compare month is partial;
  // the whole month when it is complete.
  const b0 = firstOf(baseMonth)
  const bMonthEnd = lastOf(baseMonth)
  const bEnd = partial ? nthShippingDay(baseMonth, cShipDays) : bMonthEnd
  const bShipDays = countShippingDays(b0, bEnd)

  return {
    b0, b1: addDays(bEnd, 1),
    c0, c1: addDays(cEnd, 1),
    meta: {
      base_month: baseMonth,
      compare_month: cmpMonth,
      compare_partial: partial,
      like_for_like: partial ? bShipDays === cShipDays : true,
      base_window: [fmt(b0), fmt(bEnd)],
      compare_window: [fmt(c0), fmt(cEnd)],
      base_shipping_days: bShipDays,
      compare_shipping_days: cShipDays,
      compare_shipping_days_full_month: cShipDaysFull,
      month_progress_pct: cShipDaysFull > 0 ? Math.round((cShipDays / cShipDaysFull) * 1000) / 10 : null,
      last_posted_date: fmt(cEnd),
      last_posted_source: probeOk ? 'MAX(DocDate) in scope' : 'fallback: month end (probe failed)',
      note: partial
        ? `Base month truncated to the same ${cShipDays} shipping days as the elapsed compare window. Both sides exclude Sundays and PH holidays.`
        : 'Both windows are complete months.',
    },
  }
}

function fmt(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Walk forward from `start` until `n` shipping days have been consumed, never past
// `hardEnd`. Returns the date of the n-th shipping day.
function walkShippingDays(start, n, hardEnd) {
  if (n <= 0) return new Date(start.getFullYear(), start.getMonth(), start.getDate())
  let count = 0
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  let last = cur
  while (cur <= hardEnd) {
    if (!isClosed(cur)) {
      count++
      last = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate())
      if (count >= n) return last
    }
    cur.setDate(cur.getDate() + 1)
  }
  return last
}

/**
 * Prior-period window for the hero tiles, aligned to the bridge.
 *
 * v1 used "the same-length window immediately before dateFrom", so MTD on 10 Aug
 * compared against 23–31 Jul — the highest-margin stretch of the month — while the
 * bridge next to it compared against ALL of July. Two different baselines under one
 * "vs PP" label, and a ~50% difference in the headline delta.
 *
 * The rule here: vs PP = the SAME period one step back, truncated to the same number
 * of elapsed shipping days. MTD -> prior month days 1..N. QTD -> prior quarter. YTD ->
 * prior year. 7D stays a trailing rolling window, which is what 7D means.
 */
function priorPeriodWindow(period, dateFrom, effectiveEnd) {
  const p = String(period || 'MTD').toUpperCase()
  const y = dateFrom.getFullYear(), m = dateFrom.getMonth()

  if (p === '7D') {
    const to = addDays(dateFrom, -1)
    const from = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), dateFrom.getDate())
    from.setTime(from.getTime() - (effectiveEnd - dateFrom))
    return { from, to, basis: 'trailing window of equal length (7D is a rolling period)' }
  }

  const elapsed = countShippingDays(dateFrom, effectiveEnd)
  let from, hardEnd, label
  if (p === 'QTD') {
    const q = Math.floor(m / 3)
    from = new Date(y, (q - 1) * 3, 1); hardEnd = new Date(y, q * 3, 0)
    label = 'prior quarter'
  } else if (p === 'YTD') {
    from = new Date(y - 1, 0, 1); hardEnd = new Date(y - 1, 11, 31)
    label = 'prior year'
  } else {
    from = new Date(y, m - 1, 1); hardEnd = new Date(y, m, 0)
    label = 'prior month'
  }
  const to = walkShippingDays(from, elapsed, hardEnd)
  return {
    from, to, basis: `${label}, truncated to the same ${elapsed} elapsed shipping days`,
    elapsed_shipping_days: elapsed,
    prior_shipping_days: countShippingDays(from, to),
  }
}

module.exports = { resolveLikeForLike, nthShippingDay, walkShippingDays, priorPeriodWindow, firstOf, lastOf, nextMonthOf, fmt }
