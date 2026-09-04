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
 * opts.fullBaseMonth: OPT-OUT of the truncation — keep the WHOLE base month against
 *   the elapsed compare window. Asked for deliberately ("how does my current run-rate
 *   price/cost compare against all of last month?"), and legitimate for the Price and
 *   Cost bars, which compare the same customer x SKU cells either way. It is NOT
 *   legitimate for the Mix bars: against 26 base days, a customer that simply has not
 *   ordered yet reads as an exit and its entire weight lands in Mix. Callers must
 *   surface meta.base_mode / meta.mix_comparable rather than print the mix silently.
 *
 * Returns { b0, b1, c0, c1, meta }. b1/c1 are EXCLUSIVE upper bounds.
 */
async function resolveLikeForLike(runner, scopeSql, scopeParams, baseMonth, cmpMonth, opts) {
  const fullBase = Boolean(opts && opts.fullBaseMonth)
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
  // the whole month when it is complete — or when the caller explicitly asked for the
  // full prior month. When the compare month is complete the two modes coincide.
  const b0 = firstOf(baseMonth)
  const bMonthEnd = lastOf(baseMonth)
  const truncated = partial && !fullBase
  const bEnd = truncated ? nthShippingDay(baseMonth, cShipDays) : bMonthEnd
  const bShipDays = countShippingDays(b0, bEnd)

  return {
    b0, b1: addDays(bEnd, 1),
    c0, c1: addDays(cEnd, 1),
    meta: {
      base_month: baseMonth,
      compare_month: cmpMonth,
      compare_partial: partial,
      base_mode: fullBase ? 'full_prior_month' : 'like_for_like',
      like_for_like: truncated ? bShipDays === cShipDays : !partial,
      // Price/Cost compare matched customer x SKU cells and survive an unequal window.
      // Mix is a share shift and does not: unmatched days become phantom entries/exits.
      mix_comparable: !(partial && fullBase),
      base_window: [fmt(b0), fmt(bEnd)],
      compare_window: [fmt(c0), fmt(cEnd)],
      base_shipping_days: bShipDays,
      compare_shipping_days: cShipDays,
      compare_shipping_days_full_month: cShipDaysFull,
      month_progress_pct: cShipDaysFull > 0 ? Math.round((cShipDays / cShipDaysFull) * 1000) / 10 : null,
      last_posted_date: fmt(cEnd),
      last_posted_source: probeOk ? 'MAX(DocDate) in scope' : 'fallback: month end (probe failed)',
      note: !partial
        ? 'Both windows are complete months.'
        : truncated
          ? `Base month truncated to the same ${cShipDays} shipping days as the elapsed compare window. Both sides exclude Sundays and PH holidays.`
          : `FULL PRIOR MONTH: all ${bShipDays} shipping days of ${baseMonth} against the ${cShipDays} elapsed shipping days of ${cmpMonth}. Price and Cost stay valid (same customer + same SKU either way). The Mix bars do NOT — a customer that has simply not ordered yet this month reads as an exit against a full base month, so mix is inflated by timing.`,
    },
  }
}

function fmt(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Walk BACKWARD from `end` until `n` shipping days have been consumed. Returns the
// first day of that run (so [result, end] contains exactly n shipping days).
function walkShippingDaysBack(end, n) {
  const cur = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  if (n <= 0) return cur
  let count = 0, last = cur
  for (let guard = 0; guard < 400; guard++) {
    if (!isClosed(cur)) {
      count++
      last = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate())
      if (count >= n) return last
    }
    cur.setDate(cur.getDate() - 1)
  }
  return last
}

/**
 * Window pair for a ROLLING period (7D) — the case the month-anchored resolver above
 * cannot express at all.
 *
 * THE BUG THIS FIXES: the dissection bridge derived its anchors from the calendar
 * months the selected window happens to touch, then dropped the running month as
 * "partial". On 7D that reduced Aug 29 -> Sep 4 to the month pair Jul -> Aug: the
 * panel silently answered a question nobody asked, with a full-month bridge sitting
 * under a 7-day header. Nothing in the payload said the window had been replaced.
 *
 * THE RULE: compare window = the selected range, clipped to the last date that has
 * actually posted in scope. Base window = the equal number of SHIPPING days
 * immediately preceding it. Shipping days, not calendar days, so a Sunday inside one
 * side does not quietly buy the other side an extra trading day.
 *
 * Same { b0, b1, c0, c1, meta } contract as resolveLikeForLike. b1/c1 EXCLUSIVE.
 */
async function resolveTrailingWindow(runner, scopeSql, scopeParams, dateFrom, dateTo) {
  const c0 = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), dateFrom.getDate())
  const selEnd = new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate())

  // Same data-driven end as the month resolver: posting lag means `dateTo` (today) is
  // usually ahead of the last invoice actually in scope.
  let cEnd = selEnd
  let probeOk = false
  try {
    const r = await runner(scopeSql, { ...scopeParams, c0, c1: addDays(selEnd, 1) })
    const d = r && r[0] && r[0].d ? new Date(r[0].d) : null
    if (d && !isNaN(d)) {
      const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      if (dd < cEnd) cEnd = dd
      probeOk = true
    }
  } catch (e) {
    probeOk = false
  }
  if (cEnd < c0) cEnd = c0

  const cShipDays = countShippingDays(c0, cEnd)
  const bEnd = addDays(c0, -1)
  const b0 = walkShippingDaysBack(bEnd, cShipDays)
  const bShipDays = countShippingDays(b0, bEnd)

  return {
    b0, b1: addDays(bEnd, 1),
    c0, c1: addDays(cEnd, 1),
    meta: {
      base_month: null,
      compare_month: null,
      compare_partial: cEnd < selEnd,
      base_mode: 'trailing_window',
      like_for_like: bShipDays === cShipDays,
      mix_comparable: bShipDays === cShipDays,
      base_window: [fmt(b0), fmt(bEnd)],
      compare_window: [fmt(c0), fmt(cEnd)],
      base_shipping_days: bShipDays,
      compare_shipping_days: cShipDays,
      compare_shipping_days_full_month: null,
      month_progress_pct: null,
      last_posted_date: fmt(cEnd),
      last_posted_source: probeOk ? 'MAX(DocDate) in scope' : 'fallback: selected range end (probe failed)',
      note: `Rolling window: the ${cShipDays} shipping days ending ${fmt(cEnd)} against the ${bShipDays} shipping days immediately before them. Both sides exclude Sundays and PH holidays.`,
    },
  }
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

module.exports = { resolveLikeForLike, resolveTrailingWindow, nthShippingDay, walkShippingDays, walkShippingDaysBack, priorPeriodWindow, firstOf, lastOf, nextMonthOf, addDays, fmt }
