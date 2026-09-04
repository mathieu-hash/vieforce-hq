// Axiom tests for the v2 GM/ton bridge. Run: node api/lib/__tests__/margin_bridge_v2.test.js
'use strict'
const { bridgeExactGMperTon, significance } = require('../margin_bridge_v2')
const { priorPeriodWindow, nthShippingDay, walkShippingDays, walkShippingDaysBack, resolveLikeForLike, resolveTrailingWindow } = require('../margin_window')

let fails = 0
const ok = (name, cond, extra) => {
  if (cond) console.log('  PASS  ' + name)
  else { fails++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')) }
}
const close = (a, b, tol) => Math.abs(a - b) < (tol == null ? 1e-6 : tol)

// helper: build a row
const R = (cust, sku, ssg, kg, pricePerTon, marginPerTon, bu, region) => ({
  cust, sku, ssg, bu: bu || 'DISTRIBUTION', region: region || 'Luzon',
  kg, revenue: (kg / 1000) * pricePerTon, gp: (kg / 1000) * marginPerTon,
})

console.log('\n== exactness ==')
{
  const b = [R('A', 'X', 'PIG', 100000, 34000, 7000), R('B', 'Y', 'LAYER', 50000, 28000, 4500)]
  const c = [R('A', 'X', 'PIG', 90000, 34500, 7200), R('B', 'Y', 'LAYER', 70000, 28000, 4400), R('C', 'Z', 'BROILER', 20000, 39000, 5500)]
  const r = bridgeExactGMperTon(b, c)
  const sum = r.price + r.cost + r.customer_mix + r.product_mix
  ok('four bars sum to delta', close(sum, r.delta), `sum=${sum} delta=${r.delta}`)
  ok('reconciles flag set', r.reconciles === true)
  ok('mix bars sum to mix_total', close(r.customer_mix + r.product_mix, r.mix_total))
}

console.log('\n== axiom: proportional growth changes nothing ==')
{
  const b = [R('A', 'X', 'PIG', 100000, 34000, 7000), R('B', 'Y', 'LAYER', 50000, 28000, 4500)]
  const c = b.map(r => ({ ...r, kg: r.kg * 2.5, revenue: r.revenue * 2.5, gp: r.gp * 2.5 }))
  const r = bridgeExactGMperTon(b, c)
  ok('delta = 0', close(r.delta, 0, 1e-9))
  ok('price = 0', close(r.price, 0, 1e-9))
  ok('cost = 0', close(r.cost, 0, 1e-9))
  ok('customer_mix = 0', close(r.customer_mix, 0, 1e-9))
  ok('product_mix = 0', close(r.product_mix, 0, 1e-9))
}

console.log('\n== axiom: a pure same-cell price move lands 100% in Price ==')
{
  const b = [R('A', 'X', 'PIG', 100000, 34000, 7000), R('B', 'Y', 'LAYER', 50000, 28000, 4500)]
  // +500/ton price on cell A only; volumes and costs identical
  const c = [R('A', 'X', 'PIG', 100000, 34500, 7500), R('B', 'Y', 'LAYER', 50000, 28000, 4500)]
  const r = bridgeExactGMperTon(b, c)
  ok('price carries the whole delta', close(r.price, r.delta, 1e-9), `price=${r.price} delta=${r.delta}`)
  ok('cost = 0', close(r.cost, 0, 1e-9))
  ok('mix = 0', close(r.mix_total, 0, 1e-9))
}

console.log('\n== axiom: a pure same-cell cost move lands 100% in Cost ==')
{
  const b = [R('A', 'X', 'PIG', 100000, 34000, 7000)]
  const c = [R('A', 'X', 'PIG', 100000, 34000, 7300)]   // price flat, margin up => cost down
  const r = bridgeExactGMperTon(b, c)
  ok('cost carries the whole delta', close(r.cost, r.delta, 1e-9), `cost=${r.cost} delta=${r.delta}`)
  ok('price = 0', close(r.price, 0, 1e-9))
}

console.log('\n== the v1 defect: mix split must be order-neutral ==')
{
  // Two customers x two SKUs, weights shifting on BOTH dimensions at once. This is the
  // configuration where v1's residual split swings wildly with ordering.
  const b = [
    R('A', 'X', 'PIG', 100000, 34000, 8000), R('A', 'Y', 'LAYER', 50000, 28000, 4000),
    R('B', 'X', 'PIG', 60000, 33000, 6000), R('B', 'Y', 'LAYER', 90000, 27500, 3500),
  ]
  const c = [
    R('A', 'X', 'PIG', 40000, 34000, 8000), R('A', 'Y', 'LAYER', 120000, 28000, 4000),
    R('B', 'X', 'PIG', 30000, 33000, 6000), R('B', 'Y', 'LAYER', 150000, 27500, 3500),
  ]
  const r = bridgeExactGMperTon(b, c)
  const A = r.mix_ordering.customer_first, B = r.mix_ordering.product_first
  ok('symmetric customer = mean of both orderings', close(r.customer_mix, (A.customer + B.customer) / 2))
  ok('symmetric product = mean of both orderings', close(r.product_mix, (A.product + B.product) / 2))
  ok('split still sums to mix_total', close(r.customer_mix + r.product_mix, r.mix_total))
  ok('ordering range is reported', Array.isArray(r.mix_ordering.customer_range) && r.mix_ordering.customer_range.length === 2)
  console.log(`        (customer bar: ${A.customer.toFixed(1)} customer-first vs ${B.customer.toFixed(1)} product-first -> symmetric ${r.customer_mix.toFixed(1)})`)
}

console.log('\n== churn separation ==')
{
  const b = [R('A', 'X', 'PIG', 100000, 34000, 7000), R('GONE', 'X', 'PIG', 100000, 34000, 9000)]
  const c = [R('A', 'X', 'PIG', 100000, 34000, 7000), R('NEW', 'X', 'PIG', 20000, 34000, 3000)]
  const r = bridgeExactGMperTon(b, c)
  ok('exiting cell detected', r.mix_detail.exiting !== 0)
  ok('entering cell detected', r.mix_detail.entering !== 0)
  ok('flagged churn-dominated', r.mix_detail.one_sided_share > 0.4)
  ok('continuing + entering + exiting = mix_total', close(r.mix_detail.continuing + r.mix_detail.entering + r.mix_detail.exiting, r.mix_total))
}

console.log('\n== lenses are internally exact and independent ==')
{
  const b = [
    R('A', 'X', 'PIG', 100000, 34000, 8000, 'DISTRIBUTION', 'Luzon'),
    R('B', 'Y', 'LAYER', 100000, 28000, 4000, 'KEY ACCOUNTS', 'Visayas'),
  ]
  const c = [
    R('A', 'X', 'PIG', 60000, 34000, 8000, 'DISTRIBUTION', 'Luzon'),
    R('B', 'Y', 'LAYER', 140000, 28000, 4000, 'KEY ACCOUNTS', 'Visayas'),
  ]
  const r = bridgeExactGMperTon(b, c)
  // With one SKU per SSG per customer per BU, every lens sees the same shift.
  ok('ssg lens rows sum to its total', close(r.lenses.ssg.rows.reduce((s, x) => s + x.value, 0), r.lenses.ssg.total))
  ok('bu lens rows sum to its total', close(r.lenses.bu.rows.reduce((s, x) => s + x.value, 0), r.lenses.bu.total))
  ok('customer lens rows sum to its total', close(r.lenses.customer.rows.reduce((s, x) => s + x.value, 0), r.lenses.customer.total))
  ok('ssg lens equals mix_total here (1:1 mapping)', close(r.lenses.ssg.total, r.mix_total, 1e-9))
  ok('share shift reported in pp', Math.abs(r.lenses.ssg.rows[0].share_shift_pp) > 1)
}

console.log('\n== net-negative cells are dropped AND reported ==')
{
  const b = [R('A', 'X', 'PIG', 100000, 34000, 7000)]
  const c = [R('A', 'X', 'PIG', 100000, 34000, 7000), { cust: 'RET', sku: 'X', ssg: 'PIG', kg: -500, revenue: -17000, gp: -3500 }]
  const r = bridgeExactGMperTon(b, c)
  ok('dropped cell counted', r.dropped_cells.current === 1, JSON.stringify(r.dropped_cells))
  ok('still reconciles', r.reconciles === true)
}

console.log('\n== window: prior period is the prior MONTH, not a trailing window ==')
{
  // MTD anchored 2026-08-10 -> prior window must start 2026-07-01, NOT 2026-07-23.
  const w = priorPeriodWindow('MTD', new Date(2026, 7, 1), new Date(2026, 7, 8))
  ok('prior window starts on the 1st of the prior month', w.from.getMonth() === 6 && w.from.getDate() === 1,
    `got ${w.from.toDateString()}`)
  ok('prior window is truncated, not the whole month', w.to.getMonth() === 6 && w.to.getDate() < 31, `got ${w.to.toDateString()}`)
  ok('equal elapsed shipping days on both sides', w.elapsed_shipping_days === w.prior_shipping_days,
    `${w.elapsed_shipping_days} vs ${w.prior_shipping_days}`)
  console.log(`        (Aug 1-8 = ${w.elapsed_shipping_days} shipping days -> Jul 1-${w.to.getDate()})`)
}
{
  const w = priorPeriodWindow('7D', new Date(2026, 7, 4), new Date(2026, 7, 10))
  ok('7D stays a trailing window', w.to.getMonth() === 7 && w.to.getDate() === 3, `got ${w.to.toDateString()}`)
}
{
  const w = priorPeriodWindow('QTD', new Date(2026, 6, 1), new Date(2026, 7, 8))
  ok('QTD prior window starts at the prior quarter', w.from.getMonth() === 3 && w.from.getDate() === 1, `got ${w.from.toDateString()}`)
}

console.log('\n== shipping-day walker skips Sundays ==')
{
  // 2026-08-01 is a Saturday; 08-02 Sunday. 7 shipping days from Aug 1 = Aug 8.
  const d = walkShippingDays(new Date(2026, 7, 1), 7, new Date(2026, 7, 31))
  ok('7 shipping days from Aug 1 lands on Aug 8', d.getDate() === 8, `got ${d.toDateString()}`)
  ok('nthShippingDay agrees', nthShippingDay('2026-08', 7).getDate() === 8)
}

console.log('\n== significance band ==')
{
  const s = significance(-292, [-440, -26, 703, -679, -144, 650, 119])
  ok('band available', s.available === true)
  ok('a sub-sigma move is called noise', s.verdict === 'noise', `z=${s.z && s.z.toFixed(2)}`)
  const s2 = significance(-3000, [-440, -26, 703, -679, -144, 650, 119])
  ok('a large move is called signal', s2.verdict === 'signal', `z=${s2.z && s2.z.toFixed(2)}`)
  ok('too few samples degrades gracefully', significance(1, [1, 2]).available === false)
}

console.log('\n== bridge base window: like-for-like vs full prior month ==')
// The probe stands in for MAX(DocDate) in scope.
const probeSep4 = async () => [{ d: new Date(2026, 8, 4) }]
const probeAugDone = async () => [{ d: new Date(2026, 7, 31) }]

async function windowTests() {
  {
    const W = await resolveLikeForLike(probeSep4, '', {}, '2026-08', '2026-09')
    ok('lfl truncates the base month', W.meta.base_window[1] === '2026-08-05', `got ${W.meta.base_window[1]}`)
    ok('lfl matches shipping days', W.meta.base_shipping_days === W.meta.compare_shipping_days)
    ok('lfl mix is comparable', W.meta.mix_comparable === true)
    ok('lfl mode reported', W.meta.base_mode === 'like_for_like')
  }
  {
    const W = await resolveLikeForLike(probeSep4, '', {}, '2026-08', '2026-09', { fullBaseMonth: true })
    ok('full keeps the whole base month', W.meta.base_window[1] === '2026-08-31', `got ${W.meta.base_window[1]}`)
    ok('full is NOT like-for-like', W.meta.like_for_like === false)
    ok('full flags mix as not comparable', W.meta.mix_comparable === false)
    ok('full leaves the compare side untouched', W.meta.compare_window[1] === '2026-09-04')
    ok('full mode reported', W.meta.base_mode === 'full_prior_month')
  }
  {
    // A CLOSED compare month: the two modes must resolve to identical windows.
    const a = await resolveLikeForLike(probeAugDone, '', {}, '2026-07', '2026-08')
    const b = await resolveLikeForLike(probeAugDone, '', {}, '2026-07', '2026-08', { fullBaseMonth: true })
    ok('closed month: modes coincide',
      a.meta.base_window.join() === b.meta.base_window.join() &&
      a.meta.compare_window.join() === b.meta.compare_window.join())
    ok('closed month: both stay like-for-like', a.meta.like_for_like === true && b.meta.like_for_like === true)
  }

  console.log('\n== bridge base window: 7D rolling ==')
  {
    // Selected 7D window 2026-08-29 -> 2026-09-04. Aug 30 is a Sunday and Aug 31 a
    // holiday, so the compare side is 5 shipping days: Aug 29 + Sep 1,2,3,4.
    const W = await resolveTrailingWindow(probeSep4, '', {}, new Date(2026, 7, 29), new Date(2026, 8, 4))
    ok('rolling keeps the selected window', W.meta.compare_window.join() === '2026-08-29,2026-09-04', `got ${W.meta.compare_window.join()}`)
    ok('rolling counts 5 shipping days', W.meta.compare_shipping_days === 5, `got ${W.meta.compare_shipping_days}`)
    ok('rolling base is the run immediately before', W.meta.base_window.join() === '2026-08-24,2026-08-28', `got ${W.meta.base_window.join()}`)
    ok('rolling sides are equal length', W.meta.base_shipping_days === W.meta.compare_shipping_days)
    ok('rolling never anchors on a month', W.meta.base_month === null && W.meta.compare_month === null)
    ok('rolling mode reported', W.meta.base_mode === 'trailing_window')
  }
  {
    // Posting lag: nothing posted after Sep 2 -> both sides shrink to 3 shipping days.
    const lag = async () => [{ d: new Date(2026, 8, 2) }]
    const W = await resolveTrailingWindow(lag, '', {}, new Date(2026, 7, 29), new Date(2026, 8, 4))
    ok('lag clips the compare side', W.meta.compare_window[1] === '2026-09-02', `got ${W.meta.compare_window[1]}`)
    ok('lag shrinks the base to match', W.meta.base_shipping_days === 3 && W.meta.compare_shipping_days === 3,
      `base=${W.meta.base_shipping_days} cmp=${W.meta.compare_shipping_days}`)
    ok('lag is flagged partial', W.meta.compare_partial === true)
  }
  {
    // The backward walker must skip Sundays exactly as the forward one does.
    const d = walkShippingDaysBack(new Date(2026, 7, 28), 5)
    ok('5 shipping days back from Aug 28 lands on Aug 24', d.getDate() === 24, `got ${d.toDateString()}`)
  }

  console.log(fails === 0 ? '\nALL TESTS PASSED\n' : `\n${fails} TEST(S) FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}

windowTests()
