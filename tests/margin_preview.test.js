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
