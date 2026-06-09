// Unit tests for api/lib/margin_bridge.js — Price/Volume/Mix/Cost decomposition.
// Run: node --test tests/margin_bridge.test.js
//
// Pure JS, no SAP, no network. Proves the spec §5 reconciliation invariant
//   volume + mix + price + cost_total === delta_gp
// plus isolated-driver sanity (pure price change, pure mix shift) and the
// COGS component split (cost_rm + cost_pkg + cost_feedtag === cost_total).

const test = require('node:test')
const assert = require('node:assert/strict')

const { bridgeGP, bridgeGMperKg, bridgeGMperKgBySsg, bridgeGMperTonByPair, ingredientContribution } =
  require('../api/lib/margin_bridge.js')

test('bridgeGMperTonByPair: same cust+SKU price cut lands in true_price, not mix', () => {
  // one customer, one SKU, identical tons; only the price drops. Pure true price.
  const b = [{ cust: 'A', sku: 'X', kg: 100000, revenue: 3500000, gp: 700000 }] // 100t, 35000/t, gm 7000/t
  const c = [{ cust: 'A', sku: 'X', kg: 100000, revenue: 3400000, gp: 600000 }] // price 34000/t, gm 6000/t
  const r = bridgeGMperTonByPair(b, c)
  assert.ok(Math.abs(r.true_price - (-1000)) < 1e-6, 'true_price = -1000/t')
  assert.ok(Math.abs(r.customer_mix) < 1e-6 && Math.abs(r.product_mix) < 1e-6, 'no mix')
  assert.ok(Math.abs((r.true_price + r.true_cost + r.customer_mix + r.product_mix + r.interaction) - r.delta) < 1e-6, 'reconciles')
})

test('bridgeGMperTonByPair: customer-mix shift (same SKU, unchanged prices) → customer_mix, true_price≈0', () => {
  // SKU X, two customers at DIFFERENT prices, both prices unchanged; volume shifts to the dearer one.
  const b = [
    { cust: 'A', sku: 'X', kg: 100000, revenue: 3000000, gp: 500000 }, // 30000/t gm5000
    { cust: 'B', sku: 'X', kg: 100000, revenue: 4000000, gp: 900000 }  // 40000/t gm9000
  ]
  const c = [
    { cust: 'A', sku: 'X', kg: 50000, revenue: 1500000, gp: 250000 },  // same 30000/t
    { cust: 'B', sku: 'X', kg: 150000, revenue: 6000000, gp: 1350000 } // same 40000/t
  ]
  const r = bridgeGMperTonByPair(b, c)
  assert.ok(Math.abs(r.true_price) < 1e-6, 'no real price move')
  assert.ok(Math.abs(r.product_mix) < 1e-6, 'single SKU ⇒ no product mix')
  assert.ok(r.customer_mix > 0, 'richer-customer shift lands in customer_mix')
  assert.ok(Math.abs((r.true_price + r.true_cost + r.customer_mix + r.product_mix + r.interaction) - r.delta) < 1e-6, 'reconciles')
})

test('bridgeGMperTonByPair: product-mix shift (different SKUs, unchanged prices) → product_mix', () => {
  // two SKUs, one customer, prices unchanged; volume shifts between SKUs of different margin.
  const b = [
    { cust: 'A', sku: 'X', kg: 100000, revenue: 3000000, gp: 400000 }, // gm4000
    { cust: 'A', sku: 'Y', kg: 100000, revenue: 3000000, gp: 800000 }  // gm8000
  ]
  const c = [
    { cust: 'A', sku: 'X', kg: 50000, revenue: 1500000, gp: 200000 },
    { cust: 'A', sku: 'Y', kg: 150000, revenue: 4500000, gp: 1200000 }
  ]
  const r = bridgeGMperTonByPair(b, c)
  assert.ok(Math.abs(r.true_price) < 1e-6, 'no real price move')
  assert.ok(r.product_mix > 0, 'shift to higher-margin SKU lands in product_mix')
  assert.ok(Math.abs(r.customer_mix) < 1e-6, 'single customer ⇒ no customer mix')
  assert.ok(Math.abs((r.true_price + r.true_cost + r.customer_mix + r.product_mix + r.interaction) - r.delta) < 1e-6, 'reconciles')
})

test('bridgeGMperTonByPair: mixed fixture reconciles exactly', () => {
  const b = [
    { cust: 'A', sku: 'X', kg: 80000, revenue: 2400000, gp: 400000 },
    { cust: 'B', sku: 'X', kg: 120000, revenue: 4200000, gp: 900000 },
    { cust: 'A', sku: 'Y', kg: 60000, revenue: 2100000, gp: 600000 }
  ]
  const c = [
    { cust: 'A', sku: 'X', kg: 50000, revenue: 1550000, gp: 250000 }, // small price move
    { cust: 'B', sku: 'X', kg: 150000, revenue: 5250000, gp: 1150000 },
    { cust: 'C', sku: 'Y', kg: 90000, revenue: 3240000, gp: 950000 }  // new customer+pair
  ]
  const r = bridgeGMperTonByPair(b, c)
  assert.ok(r.available, 'available')
  assert.ok(Math.abs((r.true_price + r.true_cost + r.customer_mix + r.product_mix + r.interaction) - r.delta) < 1e-6, 'all terms reconcile to delta')
})

const TOL = 1e-9

// Build a per-item row from per-kg primitives so fixtures read naturally.
// cost split (rm/pkg/feedtag) must sum to total cost/kg.
function row(item, kg, price, rm, pkg, feedtag) {
  const cost = rm + pkg + feedtag
  return {
    item,
    kg,
    revenue: price * kg,
    gp: (price - cost) * kg,
    cost_rm: rm * kg,
    cost_pkg: pkg * kg,
    cost_feedtag: feedtag * kg,
  }
}

function totalGP(rows) {
  return rows.reduce((s, r) => s + r.gp, 0)
}

// ── Reconciliation invariant (the hard one) ──────────────────────────────────

test('bridgeGP_reconciles_volume_mix_price_cost_to_delta_gp', () => {
  // Two periods, overlapping items, every driver moving at once:
  // volume up, mix shifting, prices up, costs (each component) moving.
  const p0 = [
    row('STARTER', 100, 30, 18, 3, 1), // P=30 C=22 M=8
    row('GROWER', 200, 26, 15, 2.5, 1), // P=26 C=18.5 M=7.5
    row('LAYER', 150, 24, 14, 2, 0.8), // P=24 C=16.8 M=7.2
  ]
  const p1 = [
    row('STARTER', 140, 31, 18.5, 3.1, 1.05), // grew, price up, costs up
    row('GROWER', 180, 27, 15.2, 2.6, 1.0),
    row('LAYER', 220, 24.5, 14.3, 2.05, 0.82),
  ]

  const b = bridgeGP(p0, p1)

  // The invariant.
  const sum = b.volume + b.mix + b.price + b.cost_total
  assert.ok(
    Math.abs(sum - b.delta_gp) < TOL,
    `vol+mix+price+cost (${sum}) must equal delta_gp (${b.delta_gp})`
  )

  // delta_gp is actually ΣGP1 − ΣGP0.
  assert.ok(
    Math.abs(b.delta_gp - (totalGP(p1) - totalGP(p0))) < TOL,
    'delta_gp equals total GP1 minus total GP0'
  )

  // Component cost split sums to total cost effect.
  assert.ok(
    Math.abs(b.cost_rm + b.cost_pkg + b.cost_feedtag - b.cost_total) < TOL,
    'cost components sum to cost_total'
  )
})

test('bridgeGP_reconciles_with_entering_and_exiting_items', () => {
  // PET enters in period 1; TRADING exits after period 0.
  const p0 = [
    row('STARTER', 100, 30, 18, 3, 1),
    row('TRADING', 80, 40, 30, 4, 0), // exits
  ]
  const p1 = [
    row('STARTER', 120, 31, 18.2, 3, 1),
    row('PET', 60, 55, 35, 8, 0), // enters
  ]

  const b = bridgeGP(p0, p1)
  const sum = b.volume + b.mix + b.price + b.cost_total
  assert.ok(
    Math.abs(sum - b.delta_gp) < TOL,
    `invariant holds across item-set changes: ${sum} vs ${b.delta_gp}`
  )
})

// ── Pure price change ────────────────────────────────────────────────────────

test('pure_price_change_lands_entirely_in_price_term', () => {
  // Identical volumes, identical mix, identical costs. Only price moves: +2/kg
  // on STARTER (100kg) and +1/kg on GROWER (200kg).
  const p0 = [
    row('STARTER', 100, 30, 18, 3, 1),
    row('GROWER', 200, 26, 15, 2.5, 1),
  ]
  const p1 = [
    row('STARTER', 100, 32, 18, 3, 1),
    row('GROWER', 200, 27, 15, 2.5, 1),
  ]

  const b = bridgeGP(p0, p1)

  // Expected price effect = 2*100 + 1*200 = 400.
  assert.ok(Math.abs(b.price - 400) < TOL, `price effect = 400, got ${b.price}`)
  assert.ok(Math.abs(b.volume) < TOL, 'no volume effect')
  assert.ok(Math.abs(b.mix) < TOL, 'no mix effect')
  assert.ok(Math.abs(b.cost_total) < TOL, 'no cost effect')
  assert.ok(Math.abs(b.delta_gp - 400) < TOL, 'all delta is price')
  assert.ok(
    Math.abs(b.volume + b.mix + b.price + b.cost_total - b.delta_gp) < TOL
  )
})

// ── Pure mix shift ───────────────────────────────────────────────────────────

test('pure_mix_shift_lands_in_mix_term_with_no_price_or_cost', () => {
  // Total volume held constant (300kg both periods) and every item's per-kg
  // price + cost unchanged, but the high-margin item's share rises. This must
  // surface as a positive Mix effect, zero Price, zero Cost, zero Volume.
  //
  // STARTER M0=8/kg, GROWER M0=7.5/kg. Shift 50kg from GROWER into STARTER.
  const p0 = [
    row('STARTER', 100, 30, 18, 3, 1), // M=8
    row('GROWER', 200, 26, 15, 2.5, 1), // M=7.5
  ]
  const p1 = [
    row('STARTER', 150, 30, 18, 3, 1), // same rates, more share
    row('GROWER', 150, 26, 15, 2.5, 1),
  ]

  const b = bridgeGP(p0, p1)

  // Hand-computed mix: Σ(share1-share0)*M0 * ΣQ1
  //   STARTER: (150/300 - 100/300)=+1/6 ; *8
  //   GROWER : (150/300 - 200/300)=-1/6 ; *7.5
  //   sum = (8-7.5)/6 = 0.5/6 ; *300 = 25
  assert.ok(Math.abs(b.mix - 25) < TOL, `mix effect = 25, got ${b.mix}`)
  assert.ok(Math.abs(b.volume) < TOL, 'total volume unchanged -> no volume effect')
  assert.ok(Math.abs(b.price) < TOL, 'no price effect')
  assert.ok(Math.abs(b.cost_total) < TOL, 'no cost effect')
  assert.ok(Math.abs(b.delta_gp - 25) < TOL, 'all delta is mix')

  // The mover panel must attribute the full mix to the two items.
  const movers = ingredientContribution(p0, p1)
  const moverSum = movers.reduce((s, m) => s + m.contribution, 0)
  assert.ok(Math.abs(moverSum - b.mix) < TOL, 'mover contributions sum to mix')
  // STARTER (gaining share, higher margin) is the top positive mover.
  assert.equal(movers[0].item, 'STARTER')
  assert.ok(movers[0].contribution > 0)
})

// ── COGS split ───────────────────────────────────────────────────────────────

test('cogs_split_attributes_cost_to_rm_pkg_feedtag', () => {
  // Hold price, volume and mix constant; move ONLY costs, each component by a
  // known per-kg amount, so the cost effect decomposes cleanly.
  //   STARTER 100kg: rm +0.5, pkg +0.2, feedtag +0.1 per kg
  //   GROWER  200kg: rm -0.3, pkg  0.0, feedtag +0.05 per kg
  const p0 = [
    row('STARTER', 100, 30, 18, 3, 1),
    row('GROWER', 200, 26, 15, 2.5, 1),
  ]
  const p1 = [
    row('STARTER', 100, 30, 18.5, 3.2, 1.1),
    row('GROWER', 200, 26, 14.7, 2.5, 1.05),
  ]

  const b = bridgeGP(p0, p1)

  // Cost effect is NEGATIVE of cost increase, valued at period-1 volume.
  //   RM:      -(0.5*100 + (-0.3)*200) = -(50 - 60) = +10
  //   PKG:     -(0.2*100 + 0*200)      = -20
  //   FEEDTAG: -(0.1*100 + 0.05*200)   = -(10 + 10) = -20
  assert.ok(Math.abs(b.cost_rm - 10) < TOL, `cost_rm = +10, got ${b.cost_rm}`)
  assert.ok(Math.abs(b.cost_pkg + 20) < TOL, `cost_pkg = -20, got ${b.cost_pkg}`)
  assert.ok(
    Math.abs(b.cost_feedtag + 20) < TOL,
    `cost_feedtag = -20, got ${b.cost_feedtag}`
  )
  assert.ok(
    Math.abs(b.cost_total - (10 - 20 - 20)) < TOL,
    `cost_total = -30, got ${b.cost_total}`
  )

  // No other driver moved.
  assert.ok(Math.abs(b.price) < TOL, 'no price effect')
  assert.ok(Math.abs(b.mix) < TOL, 'no mix effect')
  assert.ok(Math.abs(b.volume) < TOL, 'no volume effect')
  assert.ok(Math.abs(b.delta_gp - -30) < TOL, 'all delta is cost (-30)')

  // Invariant still holds.
  assert.ok(
    Math.abs(b.volume + b.mix + b.price + b.cost_total - b.delta_gp) < TOL
  )
})

// ── GM-per-kg bridge ─────────────────────────────────────────────────────────

test('bridgeGMperKg_reconciles_mix_price_cost_to_delta_gm_perkg', () => {
  const p0 = [
    row('STARTER', 100, 30, 18, 3, 1),
    row('GROWER', 200, 26, 15, 2.5, 1),
    row('LAYER', 150, 24, 14, 2, 0.8),
  ]
  const p1 = [
    row('STARTER', 140, 31, 18.5, 3.1, 1.05),
    row('GROWER', 180, 27, 15.2, 2.6, 1.0),
    row('LAYER', 220, 24.5, 14.3, 2.05, 0.82),
  ]

  const k = bridgeGMperKg(p0, p1)

  // Per-kg bridge drops Volume; mix+price+cost == Δ(GP/kg).
  const sum = k.mix + k.price + k.cost_total
  assert.ok(
    Math.abs(sum - k.delta_gm_perkg) < TOL,
    `mix+price+cost (${sum}) must equal delta_gm_perkg (${k.delta_gm_perkg})`
  )

  // delta_gm_perkg equals blended GP/kg difference.
  const sQ0 = p0.reduce((s, r) => s + r.kg, 0)
  const sQ1 = p1.reduce((s, r) => s + r.kg, 0)
  const gm0 = totalGP(p0) / sQ0
  const gm1 = totalGP(p1) / sQ1
  assert.ok(Math.abs(k.delta_gm_perkg - (gm1 - gm0)) < TOL)

  // Cost components still sum to total cost effect.
  assert.ok(
    Math.abs(k.cost_rm + k.cost_pkg + k.cost_feedtag - k.cost_total) < TOL
  )
})

// ── Edge cases ───────────────────────────────────────────────────────────────

test('empty_period0_treats_all_period1_as_new_volume', () => {
  // No comparison baseline -> delta_gp is just period-1 GP. Invariant must
  // still hold (no NaN, no divide-by-zero blowup).
  const p1 = [row('STARTER', 100, 30, 18, 3, 1)]
  const b = bridgeGP([], p1)
  assert.ok(Number.isFinite(b.volume))
  assert.ok(Number.isFinite(b.mix))
  assert.ok(Number.isFinite(b.price))
  assert.ok(Number.isFinite(b.cost_total))
  assert.ok(
    Math.abs(b.volume + b.mix + b.price + b.cost_total - b.delta_gp) < TOL
  )
  assert.ok(Math.abs(b.delta_gp - totalGP(p1)) < TOL)
})

test('both_empty_yields_all_zero', () => {
  const b = bridgeGP([], [])
  assert.equal(b.volume, 0)
  assert.equal(b.mix, 0)
  assert.equal(b.price, 0)
  assert.equal(b.cost_total, 0)
  assert.equal(b.delta_gp, 0)
})

// ── SSG-level fallback bridge (cross-consolidation: YTD / vs-LY) ─────────────
// rows: { ssg, kg, revenue, gp }. Single Cost bucket (revenue − gp); the
// RM/Pkg/Feedtag split is not computable across the Jan-2026 cutoff.

// Build an SSG row from per-kg primitives (price, margin per kg).
function srow(ssg, kg, price, margin) {
  return { ssg, kg, revenue: price * kg, gp: margin * kg }
}

test('bridgeGMperKgBySsg_reconciles_price_mix_cost_to_delta_gm_perkg', () => {
  // Every driver moving at once across the cutoff: prices up, costs up, mix
  // shifting toward HOG, BROILER shrinking, LAYER entering.
  const p0 = [
    srow('HOG', 1_000_000, 30, 8),     // 1000 t
    srow('BROILER', 600_000, 26, 6.5), // 600 t
  ]
  const p1 = [
    srow('HOG', 1_300_000, 31.5, 8.4),
    srow('BROILER', 400_000, 26.8, 6.1),
    srow('LAYER', 200_000, 24, 7.0),   // enters post-cutoff
  ]

  const k = bridgeGMperKgBySsg(p0, p1)

  // THE invariant: components sum EXACTLY to ΔGM/kg (no hidden residual).
  const sum = k.mix + k.price + k.cost_total
  assert.ok(
    Math.abs(sum - k.delta_gm_perkg) < TOL,
    `mix+price+cost (${sum}) must equal delta_gm_perkg (${k.delta_gm_perkg})`
  )

  // ΔGM/kg equals the blended GP/kg difference of the raw rows.
  const gp = (rows) => rows.reduce((s, r) => s + r.gp, 0)
  const kg = (rows) => rows.reduce((s, r) => s + r.kg, 0)
  const gm0 = gp(p0) / kg(p0)
  const gm1 = gp(p1) / kg(p1)
  assert.ok(Math.abs(k.delta_gm_perkg - (gm1 - gm0)) < TOL)
  assert.ok(Math.abs(k.gm0_perkg - gm0) < TOL)
  assert.ok(Math.abs(k.gm1_perkg - gm1) < TOL)
})

test('bridgeGMperKgBySsg_pure_price_change_lands_in_price_term', () => {
  // Same volumes, same mix, same cost/kg — only price moves (+1/kg on HOG).
  const p0 = [srow('HOG', 100, 30, 8), srow('BROILER', 200, 26, 6.5)]
  const p1 = [srow('HOG', 100, 31, 9), srow('BROILER', 200, 26, 6.5)]

  const k = bridgeGMperKgBySsg(p0, p1)
  // Price effect per kg = (1 × 100) / 300.
  assert.ok(Math.abs(k.price - 100 / 300) < TOL, `price = 1/3, got ${k.price}`)
  assert.ok(Math.abs(k.mix) < TOL, 'no mix effect')
  assert.ok(Math.abs(k.cost_total) < TOL, 'no cost effect')
  assert.ok(Math.abs(k.mix + k.price + k.cost_total - k.delta_gm_perkg) < TOL)
})

test('bridgeGMperKgBySsg_pure_mix_shift_lands_in_mix_term', () => {
  // Constant total kg and constant per-kg rates per SSG; share shifts toward
  // the higher-margin HOG. Mirrors the SKU pure-mix fixture: ₱ mix = 25, so
  // per-kg mix = 25 / 300.
  const p0 = [srow('HOG', 100, 30, 8), srow('BROILER', 200, 26, 7.5)]
  const p1 = [srow('HOG', 150, 30, 8), srow('BROILER', 150, 26, 7.5)]

  const k = bridgeGMperKgBySsg(p0, p1)
  assert.ok(Math.abs(k.mix - 25 / 300) < TOL, `mix = 25/300, got ${k.mix}`)
  assert.ok(Math.abs(k.price) < TOL, 'no price effect')
  assert.ok(Math.abs(k.cost_total) < TOL, 'no cost effect')
  assert.ok(Math.abs(k.mix + k.price + k.cost_total - k.delta_gm_perkg) < TOL)
})

test('bridgeGMperKgBySsg_pure_cost_change_lands_in_single_cost_bucket', () => {
  // Price held, mix held; cost/kg rises 0.5 on HOG (margin 8 → 7.5).
  const p0 = [srow('HOG', 100, 30, 8), srow('BROILER', 200, 26, 6.5)]
  const p1 = [srow('HOG', 100, 30, 7.5), srow('BROILER', 200, 26, 6.5)]

  const k = bridgeGMperKgBySsg(p0, p1)
  // Cost effect per kg = −(0.5 × 100) / 300 (cost rose ⇒ GM down).
  assert.ok(Math.abs(k.cost_total + 50 / 300) < TOL, `cost = -50/300, got ${k.cost_total}`)
  assert.ok(Math.abs(k.price) < TOL, 'no price effect')
  assert.ok(Math.abs(k.mix) < TOL, 'no mix effect')
  assert.ok(Math.abs(k.mix + k.price + k.cost_total - k.delta_gm_perkg) < TOL)
})

test('bridgeGMperKgBySsg_handles_entering_and_exiting_ssgs', () => {
  // TRADING exists only pre-cutoff; PET only post-cutoff. Invariant must hold
  // (finite, exact) across the category-set change.
  const p0 = [srow('HOG', 100, 30, 8), srow('TRADING', 80, 40, 10)]
  const p1 = [srow('HOG', 120, 31, 8.2), srow('PET', 60, 55, 20)]

  const k = bridgeGMperKgBySsg(p0, p1)
  assert.ok(Number.isFinite(k.mix))
  assert.ok(Number.isFinite(k.price))
  assert.ok(Number.isFinite(k.cost_total))
  assert.ok(Math.abs(k.mix + k.price + k.cost_total - k.delta_gm_perkg) < TOL)
})

test('bridgeGMperKgBySsg_matches_item_keyed_engine_with_single_cost_bucket', () => {
  // The SSG bridge is the same decomposition with SSG as the key and COGS in
  // one bucket — must equal bridgeGMperKg on equivalently keyed rows.
  const p0 = [srow('HOG', 1000, 30, 8), srow('BROILER', 600, 26, 6.5)]
  const p1 = [srow('HOG', 1300, 31.5, 8.4), srow('BROILER', 400, 26.8, 6.1)]
  const asItems = (rows) => rows.map((r) => ({
    item: r.ssg, kg: r.kg, revenue: r.revenue, gp: r.gp,
    cost_rm: r.revenue - r.gp, cost_pkg: 0, cost_feedtag: 0,
  }))

  const a = bridgeGMperKgBySsg(p0, p1)
  const b = bridgeGMperKg(asItems(p0), asItems(p1))
  assert.ok(Math.abs(a.mix - b.mix) < TOL)
  assert.ok(Math.abs(a.price - b.price) < TOL)
  assert.ok(Math.abs(a.cost_total - b.cost_total) < TOL)
  assert.ok(Math.abs(a.delta_gm_perkg - b.delta_gm_perkg) < TOL)
})

test('bridgeGMperKgBySsg_null_or_blank_ssg_buckets_to_UNSPEC_and_aggregates', () => {
  // Old-book rows with missing SSG and a blank-string SSG must merge into one
  // UNSPEC bucket, identical to a pre-aggregated UNSPEC row.
  const messy0 = [
    { ssg: null, kg: 40, revenue: 1200, gp: 320 },
    { ssg: '  ', kg: 60, revenue: 1800, gp: 480 },
  ]
  const clean0 = [{ ssg: 'UNSPEC', kg: 100, revenue: 3000, gp: 800 }]
  const p1 = [{ ssg: 'UNSPEC', kg: 120, revenue: 3720, gp: 960 }]

  const a = bridgeGMperKgBySsg(messy0, p1)
  const b = bridgeGMperKgBySsg(clean0, p1)
  assert.ok(Math.abs(a.price - b.price) < TOL)
  assert.ok(Math.abs(a.mix - b.mix) < TOL)
  assert.ok(Math.abs(a.cost_total - b.cost_total) < TOL)
  assert.ok(Math.abs(a.delta_gm_perkg - b.delta_gm_perkg) < TOL)
})

test('bridgeGMperKgBySsg_both_empty_yields_all_zero', () => {
  const k = bridgeGMperKgBySsg([], [])
  assert.equal(k.mix, 0)
  assert.equal(k.price, 0)
  assert.equal(k.cost_total, 0)
  assert.equal(k.delta_gm_perkg, 0)
})

test('duplicate_item_rows_are_aggregated', () => {
  // Same item split across two rows must aggregate to one logical item.
  const split = [
    row('STARTER', 40, 30, 18, 3, 1),
    row('STARTER', 60, 30, 18, 3, 1),
  ]
  const single = [row('STARTER', 100, 30, 18, 3, 1)]
  const p1 = [row('STARTER', 120, 31, 18, 3, 1)]

  const a = bridgeGP(split, p1)
  const c = bridgeGP(single, p1)
  assert.ok(Math.abs(a.delta_gp - c.delta_gp) < TOL)
  assert.ok(Math.abs(a.price - c.price) < TOL)
  assert.ok(Math.abs(a.volume - c.volume) < TOL)
})
