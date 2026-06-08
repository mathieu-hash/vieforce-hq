// Unit tests for api/lib/margin_cube.js — Margin Dissection pure compute.
// Run: node --test tests/margin_cube.test.js
//
// Pure JS, no SAP. Proves METHODOLOGY.md invariants:
//   - ssgBridge: Price + Mix + Cost + Interaction === ΔGM/ton
//   - mixBridge total === ssgBridge.mix (product-mix decomposition reconciles)
//   - trajectory GM/ton = Σgp/Σtons
//   - ingredientContribution: contribution = cost/ton(c) − cost/ton(b)

const test = require('node:test')
const assert = require('node:assert/strict')
const { trajectory, ssgBridge, mixBridge, ingredientContribution, priceDrill, categoryTrend, region2025 } =
  require('../api/lib/margin_cube.js')

// rows: {month, ssg, rev, gp, kg}
const ROWS = [
  // base month 2026-01
  { month: '2026-01', ssg: 'PIG', rev: 10_000_000, gp: 2_000_000, kg: 1_000_000 },   // 1000 t, p=10000, gm/t=2000
  { month: '2026-01', ssg: 'BROILER', rev: 6_000_000, gp: 900_000, kg: 600_000 },     // 600 t,  p=10000, gm/t=1500
  // compare month 2026-05 — price up on PIG, mix shifts toward PIG, cost up on BROILER
  { month: '2026-05', ssg: 'PIG', rev: 13_300_000, gp: 2_660_000, kg: 1_300_000 },    // 1300 t, p~10231, gm/t=2046
  { month: '2026-05', ssg: 'BROILER', rev: 4_000_000, gp: 480_000, kg: 400_000 }      // 400 t,  p=10000, gm/t=1200
]

test('trajectory computes GM/ton and revenue/ton per month', () => {
  const tr = trajectory(ROWS, ['2026-01', '2026-05'])
  const jan = tr.find(t => t.month === '2026-01')
  // Σgp=2.9M, Σtons=1600 → gm/ton=1812.5→1813(rounded); Σrev=16M → rev/ton=10000
  assert.equal(jan.tons, 1600)
  assert.equal(jan.gm_per_ton, 1813)
  assert.equal(jan.rev_per_ton, 10000)
})

test('ssgBridge reconciles: price + mix + cost + interaction === delta', () => {
  const b = ssgBridge(ROWS, '2026-01', '2026-05')
  assert.equal(b.available, true)
  const lhs = b.price + b.mix + b.cost + b.interaction
  assert.ok(Math.abs(lhs - b.delta) <= 2, `bridge must reconcile: ${lhs} vs ${b.delta}`)
  // delta = compare GM/ton − base GM/ton (±1 from independent rounding of each anchor)
  assert.ok(Math.abs(b.delta - (b.compare - b.base)) <= 1)
})

test('mixBridge total reconciles to ssgBridge.mix', () => {
  const b = ssgBridge(ROWS, '2026-01', '2026-05')
  const m = mixBridge(ROWS, '2026-01', '2026-05', 20)
  assert.equal(m.available, true)
  assert.ok(Math.abs(m.total - b.mix) <= 2, `mix bridge ${m.total} should equal bridge mix ${b.mix}`)
})

test('pure price rise (no mix/cost change) lands entirely in Price', () => {
  const rows = [
    { month: 'b', ssg: 'PIG', rev: 10_000_000, gp: 2_000_000, kg: 1_000_000 },
    { month: 'c', ssg: 'PIG', rev: 11_000_000, gp: 3_000_000, kg: 1_000_000 } // +1000/t price, cost flat
  ]
  const b = ssgBridge(rows, 'b', 'c')
  assert.equal(b.price, 1000)   // (11M-10M)/1000t
  assert.equal(b.mix, 0)        // single SSG, share unchanged
  assert.equal(b.cost, 0)       // cost/ton unchanged (8000 both)
})

test('ingredientContribution = cost/ton(compare) − cost/ton(base)', () => {
  const rows = [
    { month: 'b', ssg: 'PIG', rev: 1, gp: 0, kg: 1_000_000 }, // 1000 t feed
    { month: 'c', ssg: 'PIG', rev: 1, gp: 0, kg: 1_000_000 }
  ]
  const intensity = { PIG: { Corn: 0.6, SBM: 0.3 } }            // 0.9 kg/kg
  const basket = { b: { Corn: 20, SBM: 30 }, c: { Corn: 25, SBM: 30 } } // Corn +5/kg
  const ic = ingredientContribution(rows, intensity, basket, 'b', 'c')
  const corn = ic.items.find(i => i.name === 'Corn')
  // inclusion of Corn per ton feed = 0.6 (recipeTons==tons since single recipe SSG)
  // cost/ton base = 0.6*20*1000=12000 ; compare = 0.6*25*1000=15000 → contribution +3000
  assert.equal(corn.contribution, 3000)
})

test('ingredientContribution carries price forward when one month has no purchase', () => {
  const rows = [
    { month: 'b', ssg: 'PIG', rev: 1, gp: 0, kg: 1_000_000 },
    { month: 'c', ssg: 'PIG', rev: 1, gp: 0, kg: 1_000_000 }
  ]
  const intensity = { PIG: { Corn: 0.6, Bakery: 0.1 } }
  // Bakery has NO compare-month purchase: must NOT book -0.1*15*1000 = -1500 as a fake decrease.
  const basket = { b: { Corn: 20, Bakery: 15 }, c: { Corn: 25 } }
  const ic = ingredientContribution(rows, intensity, basket, 'b', 'c')
  const bakery = ic.items.find(i => i.name === 'Bakery')
  // identical inclusion both months + carried price → contribution 0 → item filtered out entirely
  assert.equal(bakery, undefined)
  const corn = ic.items.find(i => i.name === 'Corn')
  assert.equal(corn.contribution, 3000)      // real both-month price move still attributed
  assert.equal(corn.carried, false)
  assert.equal(ic.net, 3000)                  // net excludes the unpurchased ingredient
})

test('ingredientContribution carried price still shows recipe-shift effect', () => {
  // Bakery price only exists in base month; inclusion rises because the SSG mix
  // shifts toward the bakery-heavy recipe → only the recipe effect is shown, flagged carried.
  const rows = [
    { month: 'b', ssg: 'PIG', rev: 1, gp: 0, kg: 500_000 }, { month: 'b', ssg: 'LAYER', rev: 1, gp: 0, kg: 500_000 },
    { month: 'c', ssg: 'PIG', rev: 1, gp: 0, kg: 900_000 }, { month: 'c', ssg: 'LAYER', rev: 1, gp: 0, kg: 100_000 }
  ]
  const intensity = { PIG: { Bakery: 0.2 }, LAYER: { Corn: 0.5 } }
  const basket = { b: { Bakery: 10, Corn: 20 }, c: { Corn: 20 } }
  const ic = ingredientContribution(rows, intensity, basket, 'b', 'c')
  const bakery = ic.items.find(i => i.name === 'Bakery')
  // inclusion b = (500*0.2)/1000 = 0.1 kg/kg→100kg/t ; c = (900*0.2)/1000 = 0.18 → 180kg/t
  // carried price 10 ⇒ contribution = (0.18-0.1)*10*1000 = +800 (recipe effect only)
  assert.equal(bakery.contribution, 800)
  assert.equal(bakery.carried, true)
})

test('categoryTrend pivots SSG x month with volume-weighted AVG row', () => {
  const rows = [
    { month: '2026-05', ssg: 'PIG', rev: 1000000, gp: 200000, kg: 100000 },  // 100t, GM/t=2000, GM%=20
    { month: '2026-05', ssg: 'LAYER', rev: 1000000, gp: 100000, kg: 100000 },// 100t, GM/t=1000, GM%=10
    { month: '2026-06', ssg: 'PIG', rev: 500000, gp: 150000, kg: 50000 }     // 50t, GM/t=3000
  ]
  const ct = categoryTrend(rows, ['2026-05', '2026-06'])
  assert.equal(ct.available, true)
  assert.deepEqual(ct.months, ['2026-05', '2026-06'])
  const pig = ct.categories.find(c => c.ssg === 'PIG')
  assert.equal(pig.cells[0].gm_ton, 2000)
  assert.equal(pig.cells[0].gm_pct, 20)
  assert.equal(pig.cells[1].gm_ton, 3000)
  // PIG ordered before LAYER (more total volume: 150t vs 100t)
  assert.equal(ct.categories[0].ssg, 'PIG')
  // AVG May = (200+100)gp / (200t) = 1500/t  (volume-weighted, NOT mean of 2000 & 1000)
  assert.equal(ct.avg[0].gm_ton, 1500)
  // last month flagged partial when it is the cube's latest month
  assert.equal(ct.partial_month, '2026-06')
})

test('categoryTrend maps UNSPEC to Untagged and keeps last 12 months', () => {
  const months = Array.from({ length: 14 }, (_, i) => '2025-' + String(i + 1).padStart(2, '0')).slice(0, 14)
  const rows = months.map(m => ({ month: m, ssg: 'UNSPEC', rev: 100, gp: 10, kg: 10000 }))
  const ct = categoryTrend(rows, months)
  assert.equal(ct.months.length, 12)               // trailing 12 only
  assert.equal(ct.categories[0].ssg, 'Untagged')   // UNSPEC display-mapped
})

test('region2025 maps shipping warehouses correctly', () => {
  assert.equal(region2025(103, 'ANYTHING'), 'Luzon')   // grp 103 = Luzon in Old
  assert.equal(region2025(104, 'BUKID'), 'Mindanao')
  assert.equal(region2025(104, 'HOREB'), 'Visayas')
  assert.equal(region2025(104, 'AC'), 'Luzon')
  assert.equal(region2025(104, 'UNKNOWN'), 'Visayas')  // default
})

// ---------------------------------------------------------------------------
// priceDrill — decompose the Price bar into true price vs customer/SKU mix.
// drill row helper: tons at ₱/ton → {ssg, sku, name, cust, rev, kg}
const dr = (ssg, sku, cust, tons, pricePerTon) =>
  ({ ssg, sku, name: sku, cust, rev: tons * pricePerTon, kg: tons * 1000 })

test('priceDrill: pure customer composition shows zero true price, full customer mix, 100% held', () => {
  // 1 SKU, 2 customers, prices UNCHANGED, volume shifts toward the higher-price account.
  const rowsB = [dr('PIG', 'K1', 'A', 600, 10000), dr('PIG', 'K1', 'B', 400, 12000)]
  const rowsC = [dr('PIG', 'K1', 'A', 300, 10000), dr('PIG', 'K1', 'B', 700, 12000)]
  const pd = priceDrill(rowsB, rowsC)
  assert.equal(pd.available, true)
  // SKU-level p: base 10,800 → compare 11,400 ⇒ bar +600 entirely composition
  assert.ok(Math.abs(pd.total - 600) < 1e-9)
  assert.ok(Math.abs(pd.true_price) < 1e-9, `true_price must be ~0, got ${pd.true_price}`)
  assert.ok(Math.abs(pd.customer_mix - 600) < 1e-9, `customer_mix must carry the bar, got ${pd.customer_mix}`)
  assert.ok(Math.abs(pd.sku_mix) < 1e-9)
  assert.equal(pd.price_held_pct, 100)
  const row = pd.top_rows[0]
  assert.equal(row.sku, 'K1')
  assert.ok(Math.abs(row.true_price) < 1e-9)
  assert.equal(row.held_pct, 100)
})

test('priceDrill: pure price cut lands fully in true_price with zero customer mix', () => {
  // Same customers + volumes both months; customer A's price drops ₱1,000/t.
  const rowsB = [dr('PIG', 'K1', 'A', 500, 10000), dr('PIG', 'K1', 'B', 500, 12000)]
  const rowsC = [dr('PIG', 'K1', 'A', 500, 9000), dr('PIG', 'K1', 'B', 500, 12000)]
  const pd = priceDrill(rowsB, rowsC)
  assert.ok(Math.abs(pd.total - (-500)) < 1e-9)
  assert.ok(Math.abs(pd.true_price - (-500)) < 1e-9, `true_price must carry the cut, got ${pd.true_price}`)
  assert.ok(Math.abs(pd.customer_mix) < 1e-9, `customer_mix must be ~0, got ${pd.customer_mix}`)
  assert.ok(Math.abs(pd.sku_mix) < 1e-9)
  // B (500t of 1,000t matched) held its price; A moved -10%
  assert.ok(Math.abs(pd.price_held_pct - 50) < 1e-9)
})

test('priceDrill: total reconciles to Σ ssg contributions and to component sum (1e-9)', () => {
  // Mixed fixture: price moves + customer shifts + a new SKU + exited/new customers.
  const rowsB = [
    dr('PIG', 'K1', 'A', 600, 10000), dr('PIG', 'K1', 'B', 400, 12000),
    dr('PIG', 'K2', 'A', 200, 15000),
    dr('BROILER', 'K3', 'D', 300, 9000), dr('BROILER', 'K3', 'E', 100, 9500)   // E exits
  ]
  const rowsC = [
    dr('PIG', 'K1', 'A', 300, 10100), dr('PIG', 'K1', 'B', 700, 12000),
    dr('PIG', 'K2', 'A', 250, 14500),
    dr('PIG', 'K4', 'C', 100, 20000),                                          // new SKU
    dr('BROILER', 'K3', 'D', 350, 9000), dr('BROILER', 'K3', 'F', 50, 8000)    // F new
  ]
  const pd = priceDrill(rowsB, rowsC)
  // independent Σ_s w_b(s)·(P_c(s)−P_b(s))
  const agg = rows => rows.reduce((m, r) => {
    const o = m[r.ssg] || (m[r.ssg] = { rev: 0, kg: 0 }); o.rev += r.rev; o.kg += r.kg; return m
  }, {})
  const B = agg(rowsB), C = agg(rowsC)
  const kgB = Object.values(B).reduce((a, o) => a + o.kg, 0)
  let expected = 0
  for (const s of Object.keys(B)) {
    const Pb = B[s].rev / (B[s].kg / 1000)
    const Pc = C[s] ? C[s].rev / (C[s].kg / 1000) : 0
    expected += (B[s].kg / kgB) * (Pc - Pb)
  }
  assert.ok(Math.abs(pd.total - expected) < 1e-9, `total ${pd.total} vs Σ ssg ${expected}`)
  const parts = pd.true_price + pd.customer_mix + pd.sku_mix + pd.residual
  assert.ok(Math.abs(pd.total - parts) < 1e-9, `components must sum to total: ${parts} vs ${pd.total}`)
  // and ≈ the ssgBridge Price bar (rounded ₱/ton) on the same data
  const month = (rows, mo) => Object.entries(agg(rows)).map(([ssg, o]) =>
    ({ month: mo, ssg, rev: o.rev, gp: o.rev * 0.2, kg: o.kg }))
  const b = ssgBridge([...month(rowsB, 'b'), ...month(rowsC, 'c')], 'b', 'c')
  assert.ok(Math.abs(pd.total - b.price) <= 1, `drill total ${pd.total} vs bridge Price bar ${b.price}`)
})

test('priceDrill: SKU-mix shift (same SKU prices) lands in sku_mix', () => {
  // Volume migrates from cheap SKU to expensive SKU; every SKU price unchanged.
  const rowsB = [dr('PIG', 'CHEAP', 'A', 800, 10000), dr('PIG', 'EXP', 'A', 200, 14000)]
  const rowsC = [dr('PIG', 'CHEAP', 'A', 200, 10000), dr('PIG', 'EXP', 'A', 800, 14000)]
  const pd = priceDrill(rowsB, rowsC)
  // P_b = 10,800 → P_c = 13,200 ⇒ +2,400 all composition between SKUs
  assert.ok(Math.abs(pd.total - 2400) < 1e-9)
  assert.ok(Math.abs(pd.sku_mix - 2400) < 1e-9, `sku_mix must carry the bar, got ${pd.sku_mix}`)
  assert.ok(Math.abs(pd.true_price) < 1e-9)
  assert.ok(Math.abs(pd.customer_mix) < 1e-9)
  assert.equal(pd.price_held_pct, 100)
})
