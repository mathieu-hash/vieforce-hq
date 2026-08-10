// Smoke test for the v2 Margin Explorer bridge against LIVE SAP.
// Calls the endpoint module directly with a mock req/res (no HTTP, no Vercel).
//   node scripts/smoke-margin-explorer.mjs
// Requires .env with SAP_* and HQ_SERVICE_TOKEN. Never prints the token.
import dotenv from 'dotenv'
import { createRequire } from 'module'
dotenv.config({ path: new URL('../.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
const require = createRequire(import.meta.url)
const handler = require('../api/margin-explorer.js')

const token = process.env.HQ_SERVICE_TOKEN
if (!token) { console.error('HQ_SERVICE_TOKEN not set in .env — cannot smoke test'); process.exit(1) }

function call(query) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', query, headers: { authorization: 'Bearer ' + token } }
    const res = {
      _status: 200,
      setHeader() {}, status(c) { this._status = c; return this }, end() { resolve({ status: this._status }) },
      json(body) { resolve({ status: this._status, body }) },
    }
    handler(req, res).catch(reject)
  })
}

const money = (x) => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + String(x))

const r = await call({ period: 'MTD', compare: 'pp', include: 'bridge,dissection', group_by: 'bu' })
if (r.status !== 200) { console.error('HTTP ' + r.status, r.body); process.exit(1) }
const d = r.body

console.log('\n=== META ===')
console.log('window          ', d.meta.window.from, '->', d.meta.window.to)
console.log('scope hero      ', d.meta.data_quality.scope_hero, ' bridge', d.meta.data_quality.scope_dissection_bridge)
console.log('snapshot        ', d.meta.data_quality.snapshot_at)

console.log('\n=== HERO (tile) ===')
console.log('net sales       ', d.hero.net_sales.value.toLocaleString(), ' delta%', d.hero.net_sales.delta_pct)
console.log('GM/kg           ', d.hero.gm_per_kg.value, ' delta', d.hero.gm_per_kg.delta)
console.log('compare window  ', d.hero.compare_window.from, '->', d.hero.compare_window.to)
console.log('  basis         ', d.hero.compare_window.basis)
console.log('  cur last post ', d.hero.compare_window.current_last_posted)

console.log('\n=== DISCOUNT OVERLAY (new) ===')
const o = d.discount_overlay
if (!o) console.log('  unavailable')
else {
  console.log('  GM/kg reported          ', o.gm_per_kg_reported)
  console.log('  off-invoice discount/kg ', o.discount_per_kg, `(${o.discount_pct_of_reported_gm}% of reported GM)`)
  console.log('  GM/kg NET of discount   ', o.gm_per_kg_net_of_discount)
  console.log('  discount total PHP      ', o.discount_total.toLocaleString())
  console.log('  delta reported          ', o.delta_reported)
  console.log('  delta NET of discount   ', o.delta_net_of_discount)
}

console.log('\n=== CANONICAL BRIDGE v2 ===')
const cb = d.dissection && d.dissection.canonical_bridge
if (!cb || !cb.available) { console.log('  unavailable:', cb && cb.reason); process.exit(1) }
console.log('  method        ', cb.method)
console.log('  windows       ', cb.window.base_window.join('..'), ' vs ', cb.window.compare_window.join('..'))
console.log('  shipping days ', cb.window.base_shipping_days, 'vs', cb.window.compare_shipping_days,
  '| like_for_like =', cb.window.like_for_like, '| month', cb.window.month_progress_pct + '% elapsed')
console.log('  last posted   ', cb.window.last_posted_date, '(' + cb.window.last_posted_source + ')')
console.log('')
console.log('  prior GM/t', cb.prior_gm_ton, ' current', cb.current_gm_ton, ' delta', money(cb.delta))
console.log('    Price            ', money(cb.price))
console.log('    Cost             ', money(cb.cost))
console.log('    Customer/BU Mix  ', money(cb.customer_mix))
console.log('    Product Mix      ', money(cb.product_mix))
console.log('    RECONCILES       ', cb.reconciles, ' residual', cb.residual)

console.log('\n  mix ordering (is the split a measurement or a choice?)')
console.log('    customer range', cb.mix_ordering.customer_range.map(money).join(' .. '),
  '| sign_stable =', cb.mix_ordering.sign_stable)
console.log('    product range ', cb.mix_ordering.product_range.map(money).join(' .. '))

console.log('\n  churn')
console.log('    continuing', money(cb.mix_detail.continuing), ' entering', money(cb.mix_detail.entering),
  ' exiting', money(cb.mix_detail.exiting))
console.log('    one-sided', cb.mix_detail.one_sided_share_pct + '%',
  ' matched tonnage', cb.mix_detail.matched_kg_share_pct + '%',
  ' churn_dominated =', cb.mix_detail.churn_dominated)

console.log('\n  significance:', cb.significance.available
  ? `z=${cb.significance.z.toFixed(2)} sd=${cb.significance.sd.toFixed(0)} -> ${cb.significance.verdict.toUpperCase()}`
  : cb.significance.reason)

console.log('\n  SSG lens (measured, centered):')
cb.lenses.ssg.rows.slice(0, 6).forEach((x) =>
  console.log(`    ${String(x.key).padEnd(14)} ${money(x.value).padStart(7)}   ${x.share0_pct}% -> ${x.share1_pct}% (${x.share_shift_pp >= 0 ? '+' : ''}${x.share_shift_pp}pp)  GM/t ${x.gm_ton0} -> ${x.gm_ton1}`))
console.log('  BU lens:')
cb.lenses.bu.rows.slice(0, 4).forEach((x) =>
  console.log(`    ${String(x.key).padEnd(14)} ${money(x.value).padStart(7)}   ${x.share0_pct}% -> ${x.share1_pct}% (${x.share_shift_pp >= 0 ? '+' : ''}${x.share_shift_pp}pp)`))

console.log('\n  cost components:', cb.cost_components
  ? `RM ${money(cb.cost_components.rm)} Pkg ${money(cb.cost_components.packaging)} FT ${money(cb.cost_components.feedtag)} (estimated=${cb.cost_components.estimated})`
  : 'none')

const okBars = Math.abs((cb.price + cb.cost + cb.customer_mix + cb.product_mix) - cb.delta) <= 2
console.log('\n' + (okBars && cb.reconciles ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED'))
process.exit(okBars && cb.reconciles ? 0 : 1)
