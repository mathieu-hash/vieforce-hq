const test = require('node:test')
const assert = require('node:assert/strict')
const M = require('../api/lib/margin_preview')
const { createHandler, SQL } = require('../api/margin-preview')
const row = (date, customer, sku, kg, revenue, gp, extra = {}) => ({ date, customer, customer_name: customer, sku, sku_name: sku, ssg: 'PIG', ssg_name: 'Pig feed', region: 'Luzon', bu: '114', bu_name: 'Distribution', dsm: '12', dsm_name: 'Rep A', brand: '1', warehouse: 'AC', kg, revenue, gp, disc: revenue * .03, ...extra })
const rows = [row('2026-08-03', 'C1', 'S1', 1000, 30000, 5000), row('2026-08-04', 'C2', 'S1', 3000, 96000, 18000), row('2026-08-28', 'C3', 'S2', 100, 5000, 1000), row('2026-09-02', 'C1', 'S1', 1500, 46500, 8250), row('2026-09-04', 'C2', 'S1', 2000, 64000, 10000)]
const opts = { asof: '2026-09', base: '2026-08', current: '2026-09', mode: 'same', group: 'customer', filters: {}, basis: 'reported' }
test('Monthly totals are weighted and include signed credit memos', () => {
  const p = M.build([...rows, row('2026-08-05', 'C1', 'S1', -100, -3000, -500)], opts, '2026-09-05')
  assert.equal(p.totals.cells['2026-08'].kg, 4000)
  assert.equal(p.totals.cells['2026-08'].gm, 5875)
  assert.equal(p.rows.reduce((s, r) => s + r.total.gp, 0), p.totals.total.gp)
  assert.equal(p.months.length, 12)
  assert.equal(p.totals.cells['2025-12'], undefined)
})
test('Exact filters do not match substrings and comparison dates stay fixed while drilling', () => {
  const root = M.build(rows, opts, '2026-09-05')
  const child = M.build(rows, { ...opts, filters: { customer: 'C1' }, group: 'sku' }, '2026-09-05')
  assert.deepEqual(child.window, root.window)
  assert.equal(child.rows.length, 1)
  assert.equal(child.totals.current.kg, 1500)
  assert.equal(M.build(rows, { ...opts, filters: { customer: 'C' } }, '2026-09-05').rows.length, 0)
})
test('Contributor rows exactly reconcile to canonical bridge on both bases', () => {
  for (const basis of ['reported', 'net']) {
    const p = M.build(rows, { ...opts, basis }, '2026-09-05')
    assert.equal(p.bridge.reconciles, true)
    for (const k of ['price', 'cost']) assert.ok(Math.abs(p.contributors.reduce((s, r) => s + r[k], 0) - p.bridge[k]) < 1e-6)
    assert.ok(Math.abs(p.contributors.reduce((s, r) => s + r.value, 0) - p.bridge.delta) < 1e-6)
  }
})
test('Partial full-month comparison flags mix; monthly history remains whole', () => {
  const p = M.build(rows, { ...opts, mode: 'full' }, '2026-09-05')
  assert.equal(p.window.mix_comparable, false)
  assert.equal(p.window.base[1], '2026-08-31')
  const same = M.build(rows, opts, '2026-09-05')
  assert.ok(same.totals.prior.kg < same.totals.cells['2026-08'].kg)
})
test('Four component drills reconcile with underlying rates and explicit shared interaction', () => {
  const data = [...rows, row('2026-08-04', 'C1', 'S2', 800, 40000, 12000), row('2026-09-03', 'C2', 'S2', 1600, 75000, 19000)]
  for (const basis of ['reported', 'net']) {
    const p = M.build(data, { ...opts, basis }, '2026-09-05')
    for (const key of ['customer_mix', 'product_mix']) {
      const drill = p.component_drills[key]
      assert.ok(Math.abs(drill.rows.reduce((s, r) => s + r.value, 0) + drill.adjustment - p.bridge[key]) < 1e-6)
      assert.ok(drill.rows.every(r => r.id && r.name && Number.isFinite(r.share_shift_pp)))
    }
    assert.ok(Math.abs(p.component_drills.customer_mix.adjustment - p.component_drills.product_mix.adjustment) < 1e-6)
    for (const r of p.contributors.filter(r => r.matched)) {
      assert.ok(Math.abs((r.price1 - r.price0) * (r.share0 + r.share1) / 2 - r.price) < 1e-6)
      assert.ok(Math.abs(-(r.cost1 - r.cost0) * (r.share0 + r.share1) / 2 - r.cost) < 1e-6)
    }
  }
})
test('Non-positive net-volume cells are disclosed by bridge', () => {
  const p = M.build([...rows, row('2026-09-03', 'RET', 'BAD', -100, -3000, -500)], opts, '2026-09-05')
  assert.equal(p.bridge.dropped_cells.current, 1)
})
test('Opportunities require material volume, disclose peers and do not add overlapping alternatives', () => {
  const a = [row('2026-08-03', 'C1', 'S1', 100000, 3000000, 500000), row('2026-08-04', 'C2', 'S1', 100000, 3400000, 900000), row('2026-08-04', 'C3', 'S1', 100000, 3400000, 900000), row('2026-09-02', 'C1', 'S1', 20000, 600000, 60000)]
  a.push(row('2026-09-03', 'C2', 'S1', 20000, 680000, 180000), row('2026-09-03', 'C3', 'S1', 20000, 680000, 180000))
  const p = M.build(a, opts, '2026-09-05'), o = p.opportunities.find(r => r.customer === 'C1')
  assert.equal(o.peers.length, 2)
  assert.equal(o.tons, 100)
  assert.ok(Math.abs(o.uplift - 4) < 1e-10)
  assert.equal(p.opportunities.filter(r => r.customer === 'C1').length, 1)
  assert.equal(o.sizing_month, '2026-08')
})
test('Invalid dimensions, months and array filters are rejected', () => {
  assert.throws(() => M.validate({ ...opts, group: 'DROP TABLE', filters: '{}' }, '2026-09'))
  assert.throws(() => M.validate({ ...opts, filters: '[]' }, '2026-09'))
  assert.throws(() => M.validate({ ...opts, base: '2025-12', filters: '{}' }, '2026-09'))
})
async function request(role, query = {}) {
  let called = 0, body, status = 200
  const handler = createHandler({ authenticate: async () => role ? ({ id: 'test-' + role, role }) : null, query: async () => { called++; return rows }, today: () => '2026-09-05', noCache: true })
  const res = { setHeader() {}, status(s) { status = s; return this }, json(x) { body = x; return this } }
  await handler({ method: 'GET', query, headers: {} }, res)
  return { status, called, body }
}
test('Unauthenticated and field roles cannot query national preview; executive access works', async () => {
  for (const role of [null, 'dsm', 'rsm', 'tsr']) { const r = await request(role); assert.equal(r.called, 0); assert.equal(r.status, role ? 403 : 401) }
  const r = await request('exec'); assert.equal(r.status, 200); assert.equal(r.called, 1); assert.equal(r.body.bridge.reconciles, true)
})
test('SQL is fixed read-only, parameterized and allocates discount against whole documents', () => {
  assert.match(SQL, /T0.DocDate>=@start AND T0.DocDate<@end/)
  assert.match(SQL, /FROM INV1 L WHERE L.DocEntry=T0.DocEntry/)
  assert.match(SQL, /FROM RIN1 L WHERE L.DocEntry=T0.DocEntry/)
  assert.match(SQL, /ORIN/)
  assert.doesNotMatch(SQL, /\b(INSERT|UPDATE|DELETE|EXEC|MERGE)\b/)
})
const { rawMaterialImpact } = require('../api/lib/margin_preview_rm')
test('Every segment lens keeps exact identities and sums before rounding', () => {
 const p=M.build(rows,opts,'2026-09-05'); assert.equal(Object.keys(p.segment_drills).length,8)
 for(const lens of Object.values(p.segment_drills))assert.ok(Math.abs(lens.rows.reduce((s,r)=>s+r.value,0)-lens.total)<1e-8)
 assert.deepEqual(p.segment_drills.customer.rows.map(r=>r.id).sort(),['C1','C2'])
})
test('RM fixed recipe denominator counted once, basemix separate and missing origins not inferred',()=>{
 const sales=[row('2026-08-03','C1','S1',1000,30000,5000)]
 const recipes=[{DocEntry:1,FG:'S1',Warehouse:'AC-PD',PostDate:'2026-08-01',CmpltQty:1000,ItemCode:'RM',ItemName:'Corn',grp:101,IssuedQty:600},{DocEntry:1,FG:'S1',Warehouse:'AC-PD',PostDate:'2026-08-01',CmpltQty:1000,ItemCode:'BM',ItemName:'Premix',grp:102,IssuedQty:100}]
 const issues=['2026-08','2026-09'].flatMap((ym,i)=>[{ym,ItemCode:'RM',Warehouse:'AC-PD',outq:100,outval:1000+i*200},{ym,ItemCode:'BM',Warehouse:'AC-PD',outq:100,outval:2000-i*100}])
 const p=rawMaterialImpact(sales,recipes,issues,opts)
 assert.equal(p.rm_effect,-1200);assert.equal(p.premix_effect,100);assert.equal(p.total_effect,-1100);assert.equal(p.full_price_coverage,1)
 assert.equal(rawMaterialImpact(sales.map(r=>({...r,warehouse:'BAC'})),recipes,issues,opts).available,false)
 const missing=rawMaterialImpact(sales,recipes,issues.filter(r=>!(r.ItemCode==='RM'&&r.ym==='2026-09')),opts)
 assert.equal(missing.rm_effect,0);assert.equal(missing.full_price_coverage,0);assert.equal(missing.missing.length,1)
})
