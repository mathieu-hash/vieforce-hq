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
const { trajectory, ssgBridge, mixBridge, ingredientContribution, region2025 } =
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

test('region2025 maps shipping warehouses correctly', () => {
  assert.equal(region2025(103, 'ANYTHING'), 'Luzon')   // grp 103 = Luzon in Old
  assert.equal(region2025(104, 'BUKID'), 'Mindanao')
  assert.equal(region2025(104, 'HOREB'), 'Visayas')
  assert.equal(region2025(104, 'AC'), 'Luzon')
  assert.equal(region2025(104, 'UNKNOWN'), 'Visayas')  // default
})
