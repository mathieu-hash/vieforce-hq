// api/lib/margin_bridge.js
//
// Price / Volume / Mix / Cost(RM+Packaging+Feedtag) gross-margin decomposition.
// Pure JS, no SAP, no deps. Implements the bridge math from the Margin Explorer
// design spec (2026-06-05), section 5.
//
// Input: two arrays of per-item rows for the comparison period (0) and current
// period (1). Each row:
//   { item, kg, revenue, gp, cost_rm, cost_pkg, cost_feedtag }
//
// Per item i (per-kg quantities are blended over that item's kg in the period):
//   Q = kg
//   P = revenue / kg          (price per kg)
//   C = (revenue - gp) / kg   (total cost per kg; = cost_rm+cost_pkg+cost_feedtag per kg)
//   M = gp / kg = P - C       (margin per kg)
//
// HARD INVARIANT (unit-tested):
//   volume + mix + price + cost_total === delta_gp   (within float tolerance)
//   cost_rm + cost_pkg + cost_feedtag === cost_total
//
// Bridge effects (spec §5):
//   Volume = (ΣQ1 − ΣQ0) × M0_blended         where M0_blended = ΣGP0 / ΣQ0
//   Mix    = Σ[(Q1_i/ΣQ1 − Q0_i/ΣQ0) × M0_i] × ΣQ1
//   Price  = Σ[(P1_i − P0_i) × Q1_i]
//   Cost   = −Σ[(C1_i − C0_i) × Q1_i]          (split by component class)
//
// Items present in only one period are handled via the item union with Q=0 on
// the absent side; absent-side per-kg rates drop out because they multiply Q=0.

'use strict'

// ── helpers ─────────────────────────────────────────────────────────────────

// Per-kg rate; 0 when the period has no volume for that item (rate is then
// irrelevant because every effect term multiplies it by that period's Q).
function perKg(numerator, kg) {
  return kg > 0 ? numerator / kg : 0
}

// Index an array of rows by `item`, aggregating duplicates (defensive: SAP may
// return one row per item already, but a slice may pre-aggregate or not).
function indexRows(rows) {
  const map = new Map()
  for (const r of rows || []) {
    const key = r.item
    const prev = map.get(key) || {
      item: key,
      kg: 0,
      revenue: 0,
      gp: 0,
      cost_rm: 0,
      cost_pkg: 0,
      cost_feedtag: 0,
    }
    prev.kg += num(r.kg)
    prev.revenue += num(r.revenue)
    prev.gp += num(r.gp)
    prev.cost_rm += num(r.cost_rm)
    prev.cost_pkg += num(r.cost_pkg)
    prev.cost_feedtag += num(r.cost_feedtag)
    map.set(key, prev)
  }
  return map
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function sumKg(map) {
  let s = 0
  for (const r of map.values()) s += r.kg
  return s
}

function sumGp(map) {
  let s = 0
  for (const r of map.values()) s += r.gp
  return s
}

// ── core decomposition ──────────────────────────────────────────────────────

// Shared engine that computes every effect on the item union. Returns both the
// ₱-GP bridge components and the per-item rate context the per-kg view needs.
function decompose(rows0, rows1) {
  const m0 = indexRows(rows0)
  const m1 = indexRows(rows1)

  const items = new Set([...m0.keys(), ...m1.keys()])

  const sQ0 = sumKg(m0)
  const sQ1 = sumKg(m1)
  const sGP0 = sumGp(m0)
  const sGP1 = sumGp(m1)

  const M0blend = sQ0 > 0 ? sGP0 / sQ0 : 0

  let mix = 0
  let price = 0
  let cost_rm = 0
  let cost_pkg = 0
  let cost_feedtag = 0

  for (const item of items) {
    const a = m0.get(item) || ZERO(item) // period 0
    const b = m1.get(item) || ZERO(item) // period 1

    const Q0 = a.kg
    const Q1 = b.kg

    const P0 = perKg(a.revenue, Q0)
    const P1 = perKg(b.revenue, Q1)
    const M0 = perKg(a.gp, Q0)

    // Mix: share shift valued at period-0 margin, scaled by total period-1 kg.
    const share1 = sQ1 > 0 ? Q1 / sQ1 : 0
    const share0 = sQ0 > 0 ? Q0 / sQ0 : 0
    mix += (share1 - share0) * M0

    // Price: per-kg price change valued at period-1 volume.
    price += (P1 - P0) * Q1

    // Cost: per-kg cost change (negated) valued at period-1 volume, split by
    // component class. Total-cost effect = sum of the three component effects.
    const rm0 = perKg(a.cost_rm, Q0)
    const rm1 = perKg(b.cost_rm, Q1)
    const pkg0 = perKg(a.cost_pkg, Q0)
    const pkg1 = perKg(b.cost_pkg, Q1)
    const ft0 = perKg(a.cost_feedtag, Q0)
    const ft1 = perKg(b.cost_feedtag, Q1)

    cost_rm += -(rm1 - rm0) * Q1
    cost_pkg += -(pkg1 - pkg0) * Q1
    cost_feedtag += -(ft1 - ft0) * Q1
  }

  mix *= sQ1

  const volume = (sQ1 - sQ0) * M0blend
  const cost_total = cost_rm + cost_pkg + cost_feedtag
  const delta_gp = sGP1 - sGP0

  return {
    items,
    m0,
    m1,
    sQ0,
    sQ1,
    sGP0,
    sGP1,
    M0blend,
    components: {
      volume,
      mix,
      price,
      cost_total,
      cost_rm,
      cost_pkg,
      cost_feedtag,
      delta_gp,
    },
  }
}

function ZERO(item) {
  return {
    item,
    kg: 0,
    revenue: 0,
    gp: 0,
    cost_rm: 0,
    cost_pkg: 0,
    cost_feedtag: 0,
  }
}

// ── public API ──────────────────────────────────────────────────────────────

// ₱-GP bridge: full waterfall including the Volume effect.
//   volume + mix + price + cost_total === delta_gp
function bridgeGP(rows0, rows1) {
  return decompose(rows0, rows1).components
}

// GM-per-kg bridge: same decomposition expressed per blended kg. Volume drops
// out (it is the level effect, not a rate effect). The invariant becomes:
//   mix_perkg + price_perkg + cost_total_perkg === delta_gm_perkg
// where delta_gm_perkg = (ΣGP1/ΣQ1) − (ΣGP0/ΣQ0).
//
// We divide the ₱ Mix/Price/Cost effects by ΣQ1 (period-1 kg), which is exactly
// the denominator that makes price/cost per-kg terms collapse to the standard
// per-unit form and keeps the algebra reconciling.
function bridgeGMperKg(rows0, rows1) {
  const d = decompose(rows0, rows1)
  const { sQ0, sQ1, sGP0, sGP1 } = d
  const c = d.components

  const denom = sQ1 // period-1 kg
  const scale = (x) => (denom > 0 ? x / denom : 0)

  const gm0 = sQ0 > 0 ? sGP0 / sQ0 : 0
  const gm1 = sQ1 > 0 ? sGP1 / sQ1 : 0

  return {
    mix: scale(c.mix),
    price: scale(c.price),
    cost_total: scale(c.cost_total),
    cost_rm: scale(c.cost_rm),
    cost_pkg: scale(c.cost_pkg),
    cost_feedtag: scale(c.cost_feedtag),
    delta_gm_perkg: gm1 - gm0,
    gm0_perkg: gm0,
    gm1_perkg: gm1,
  }
}

// Per-item mix-contribution (the "top margin movers" panel, spec §3/§5).
// Each item's signed contribution to the Mix effect of the ₱-GP bridge:
//   contribution_i = (Q1_i/ΣQ1 − Q0_i/ΣQ0) × M0_i × ΣQ1
// Sum of contributions === bridgeGP(...).mix (within tolerance).
//
// `comp0` / `comp1` are the same per-item row arrays passed to bridgeGP.
function ingredientContribution(comp0, comp1) {
  const m0 = indexRows(comp0)
  const m1 = indexRows(comp1)
  const items = new Set([...m0.keys(), ...m1.keys()])

  const sQ0 = sumKg(m0)
  const sQ1 = sumKg(m1)

  const out = []
  for (const item of items) {
    const a = m0.get(item) || ZERO(item)
    const b = m1.get(item) || ZERO(item)
    const share1 = sQ1 > 0 ? b.kg / sQ1 : 0
    const share0 = sQ0 > 0 ? a.kg / sQ0 : 0
    const M0 = perKg(a.gp, a.kg)
    const contribution = (share1 - share0) * M0 * sQ1
    out.push({ item, contribution, share0, share1, m0_perkg: M0 })
  }

  // Largest absolute movers first.
  out.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
  return out
}

// SSG-level GM-per-kg bridge — fallback when SKU codes are NOT comparable
// across the Jan-2026 consolidation (customer/SKU codes were ~fully recoded,
// but SSG names ([@OITMSSG]) are stable across both books).
//
// rows: { ssg, kg, revenue, gp }. COGS is carried as a SINGLE bucket
// (revenue − gp) because the RM/Pkg/Feedtag production-ratio split is not
// computable across the cutoff — never fake the split.
//
// Same exact-reconciliation invariant as bridgeGMperKg (unit-tested):
//   mix + price + cost_total === delta_gm_perkg   (within float tolerance)
function bridgeGMperKgBySsg(rows0, rows1) {
  const adapt = (rows) =>
    (rows || []).map((r) => {
      const revenue = num(r.revenue)
      const gp = num(r.gp)
      const ssg = r.ssg == null || String(r.ssg).trim() === '' ? 'UNSPEC' : String(r.ssg).trim()
      return {
        item: ssg,
        kg: num(r.kg),
        revenue,
        gp,
        cost_rm: revenue - gp, // single Cost bucket — no split across the cutoff
        cost_pkg: 0,
        cost_feedtag: 0,
      }
    })
  const k = bridgeGMperKg(adapt(rows0), adapt(rows1))
  return {
    mix: k.mix,
    price: k.price,
    cost_total: k.cost_total,
    delta_gm_perkg: k.delta_gm_perkg,
    gm0_perkg: k.gm0_perkg,
    gm1_perkg: k.gm1_perkg,
  }
}

// ── TRUE-price GM/ton bridge at customer×SKU granularity ──────────────────────
// The SKU-level bridge above blends customers WITHIN each SKU, so a shift in WHICH
// customers bought (at their different deal prices) leaks into the "Price" bar.
// This decomposition keys on (customer, SKU) pairs so the Price bar reflects ONLY
// a real price move for the SAME customer buying the SAME SKU. Everything else is
// composition, split into Customer Mix (within-SKU customer shift) and Product Mix
// (between-SKU shift). All terms are ₱/ton at base weights.
//
// rows = [{ cust, sku, kg, revenue, gp }]   (per customer×SKU per window)
// HARD INVARIANT (unit-tested):
//   true_price + true_cost + customer_mix + product_mix + interaction === delta   (₱/ton)
function bridgeGMperTonByPair(rows0, rows1) {
  const idx = (rows) => {
    const m = new Map()
    for (const r of rows || []) {
      const cust = r.cust == null ? '' : String(r.cust)
      const sku = r.sku == null ? '' : String(r.sku)
      const key = cust + '|' + sku
      const o = m.get(key) || { cust, sku, kg: 0, revenue: 0, gp: 0 }
      o.kg += num(r.kg); o.revenue += num(r.revenue); o.gp += num(r.gp)
      m.set(key, o)
    }
    return m
  }
  const B = idx(rows0), C = idx(rows1)
  const tB = [...B.values()].reduce((s, o) => s + o.kg, 0) / 1000
  const tC = [...C.values()].reduce((s, o) => s + o.kg, 0) / 1000
  if (tB <= 0 || tC <= 0) {
    return { available: false, gm0_per_ton: 0, gm1_per_ton: 0, true_price: 0, true_cost: 0, customer_mix: 0, product_mix: 0, interaction: 0, delta: 0, n_pairs_both: 0 }
  }
  const gmB = [...B.values()].reduce((s, o) => s + o.gp, 0) / tB  // ₱/ton base overall
  const gmC = [...C.values()].reduce((s, o) => s + o.gp, 0) / tC
  const perTon = (numr, kg) => (kg > 0 ? numr * 1000 / kg : 0)

  // pair-level true price & true cost (same cust+SKU present in BOTH windows)
  let truePrice = 0, trueCost = 0, nBoth = 0
  for (const [k, b] of B) {
    const c = C.get(k); if (!c) continue
    const wB = (b.kg / 1000) / tB
    const pB = perTon(b.revenue, b.kg), pC = perTon(c.revenue, c.kg)
    const kB = perTon(b.revenue - b.gp, b.kg), kC = perTon(c.revenue - c.gp, c.kg)
    truePrice += wB * (pC - pB)
    trueCost += -wB * (kC - kB)          // cost ↑ ⇒ GM ↓
    nBoth++
  }
  // total mix = Σ(wC − wB)·gBar  (base pair GM/ton; base-overall for new pairs)
  const keys = new Set([...B.keys(), ...C.keys()])
  let mixTotal = 0
  for (const k of keys) {
    const b = B.get(k), c = C.get(k)
    const wB = b ? (b.kg / 1000) / tB : 0
    const wC = c ? (c.kg / 1000) / tC : 0
    const gBar = b && b.kg > 0 ? perTon(b.gp, b.kg) : gmB
    mixTotal += (wC - wB) * gBar
  }
  // product mix = SKU-level weight shift at base SKU GM/ton (sums customers within a SKU)
  const bySku = (map) => {
    const m = new Map()
    for (const o of map.values()) {
      const s = m.get(o.sku) || { kg: 0, gp: 0 }
      s.kg += o.kg; s.gp += o.gp; m.set(o.sku, s)
    }
    return m
  }
  const SB = bySku(B), SC = bySku(C)
  const skus = new Set([...SB.keys(), ...SC.keys()])
  let productMix = 0
  for (const s of skus) {
    const b = SB.get(s), c = SC.get(s)
    const wB = b ? (b.kg / 1000) / tB : 0
    const wC = c ? (c.kg / 1000) / tC : 0
    const gBar = b && b.kg > 0 ? perTon(b.gp, b.kg) : gmB
    productMix += (wC - wB) * gBar
  }
  const customerMix = mixTotal - productMix          // within-SKU customer shift = remainder
  const delta = gmC - gmB
  const interaction = delta - (truePrice + trueCost + mixTotal)
  return {
    available: true,
    gm0_per_ton: gmB, gm1_per_ton: gmC,
    true_price: truePrice, true_cost: trueCost,
    customer_mix: customerMix, product_mix: productMix,
    interaction, delta, n_pairs_both: nBoth,
  }
}

// ── CANONICAL GM/ton bridge — Bennet (Bennet–Bowley) indicator decomposition ──
// The ONE authoritative bridge. Additively EXACT (zero residual by construction),
// symmetric average weights, passes the index-number axioms:
//   • a pure same-cell price change lands 100% in Price
//   • proportional volume growth leaves GM/ton unchanged (all terms 0)
//   • a pure customer-share shift lands in Customer/BU Mix; SKU shift in Product Mix
//
// GM/ton = Σ sᵢ·mᵢ   (sᵢ = tonnage share of cell i, mᵢ = unit margin ₱/ton)
// Bennet identity per cell:  s₁m₁ − s₀m₀ = s̄·Δm + m̄·Δs   (exact)
//   s̄·Δm  → Rate effect = Price (s̄·Δp) + Cost (−s̄·Δc)
//   m̄·Δs  → Mix effect, split hierarchically: Customer/BU Mix (between customers)
//            + Product Mix (within-customer SKU shift = total mix − customer mix)
// Entering/exiting cells: rate=0 (no price to compare), full move into Mix.
//
// rows = [{ cust, sku, ssg, kg, revenue, gp }]   (one window). cust carries the "who"
// dimension (BU is a customer attribute → customer-level mix captures BU mix).
// opts.costRatio = { sku: { pkg, ft } } production cost-share per SKU → splits the
// Cost bar into RM/Packaging/Feedtag that reconciles to it. ssg → Product Mix by SSG.
//
// Returns, additionally to the four exact bars:
//   cost_components  = { rm, packaging, feedtag }   (Σ === cost)   [if costRatio given]
//   product_mix_by_ssg = [{ ssg, value }] sorted    (Σ === product_mix)
function bridgeCanonicalGMperTon(rows0, rows1, opts) {
  opts = opts || {}
  const costRatio = opts.costRatio || null
  const agg = (rows, keyFn) => {
    const m = new Map(); let Q = 0
    for (const r of rows || []) {
      const kg = num(r.kg); if (kg <= 0) continue
      const k = keyFn(r)
      const o = m.get(k) || { kg: 0, revenue: 0, gp: 0, ssg: (r.ssg == null || r.ssg === '' ? 'UNSPEC' : String(r.ssg)), sku: r.sku }
      o.kg += kg; o.revenue += num(r.revenue); o.gp += num(r.gp); m.set(k, o)
      Q += kg
    }
    return { m, Q }
  }
  const cellKey = (r) => (r.cust == null ? '' : String(r.cust)) + '|' + (r.sku == null ? '' : String(r.sku))
  const custKey = (r) => (r.cust == null ? '' : String(r.cust))

  const C0 = agg(rows0, cellKey), C1 = agg(rows1, cellKey)
  if (C0.Q <= 0 || C1.Q <= 0) {
    return { available: false, gm0_per_ton: 0, gm1_per_ton: 0, delta: 0, price: 0, cost: 0, customer_mix: 0, product_mix: 0, mix_total: 0, cost_components: { rm: 0, packaging: 0, feedtag: 0 }, product_mix_by_ssg: [] }
  }
  const gm0 = [...C0.m.values()].reduce((s, o) => s + o.gp, 0) / (C0.Q / 1000)
  const gm1 = [...C1.m.values()].reduce((s, o) => s + o.gp, 0) / (C1.Q / 1000)

  const metr = (o, Q) => {
    if (!o || o.kg <= 0) return null
    const t = o.kg / 1000
    return { s: o.kg / Q, p: o.revenue / t, c: (o.revenue - o.gp) / t, m: o.gp / t }
  }

  // ---- cell-level pass: bars + per-cell mix (tagged by SSG) + cost components ----
  const keys = new Set([...C0.m.keys(), ...C1.m.keys()])
  let price = 0, cost = 0, cellMix = 0
  let costRm = 0, costPkg = 0, costFt = 0
  const cellMixBySsg = {}            // ssg -> Σ cell mix contribution
  for (const k of keys) {
    const A = C0.m.get(k), B = C1.m.get(k)
    const a = metr(A, C0.Q), b = metr(B, C1.Q)
    const ssg = (B && B.ssg) || (A && A.ssg) || 'UNSPEC'
    const sku = (B && B.sku) || (A && A.sku)
    let mixContrib = 0
    if (a && b) {
      const sbar = (a.s + b.s) / 2
      price += sbar * (b.p - a.p)
      cost += -sbar * (b.c - a.c)
      mixContrib = ((a.m + b.m) / 2) * (b.s - a.s)
      if (costRatio) {
        const r = costRatio[sku] || { pkg: 0, ft: 0 }
        const dc = b.c - a.c
        const dPkg = dc * (r.pkg || 0), dFt = dc * (r.ft || 0), dRm = dc - dPkg - dFt
        costPkg += -sbar * dPkg; costFt += -sbar * dFt; costRm += -sbar * dRm
      }
    } else if (b) { mixContrib = b.m * b.s }
    else if (a) { mixContrib = a.m * (-a.s) }
    cellMix += mixContrib
    cellMixBySsg[ssg] = (cellMixBySsg[ssg] || 0) + mixContrib
  }

  // ---- customer-level mix (between customers) + attribute it to SSG by volume share ----
  const K0 = agg(rows0, custKey), K1 = agg(rows1, custKey)
  const custKeys = new Set([...K0.m.keys(), ...K1.m.keys()])
  // per-(cust,ssg) kg in each window, for fraction attribution
  const csKey = (r) => (r.cust == null ? '' : String(r.cust)) + '|' + (r.ssg == null || r.ssg === '' ? 'UNSPEC' : String(r.ssg))
  const CS0 = agg(rows0, csKey), CS1 = agg(rows1, csKey)
  let customerMix = 0
  const custMixBySsg = {}
  for (const k of custKeys) {
    const a = metr(K0.m.get(k), K0.Q), b = metr(K1.m.get(k), K1.Q)
    let mc = 0
    if (a && b) mc = ((a.m + b.m) / 2) * (b.s - a.s)
    else if (b) mc = b.m * b.s
    else if (a) mc = a.m * (-a.s)
    customerMix += mc
    // split this customer's mix across its SSGs by avg within-customer volume fraction
    const kg0 = K0.m.get(k) ? K0.m.get(k).kg : 0
    const kg1 = K1.m.get(k) ? K1.m.get(k).kg : 0
    const ssgs = new Set()
    for (const ck of CS0.m.keys()) if (ck.indexOf(k + '|') === 0) ssgs.add(ck.slice((k + '|').length))
    for (const ck of CS1.m.keys()) if (ck.indexOf(k + '|') === 0) ssgs.add(ck.slice((k + '|').length))
    let fracSum = 0; const fr = {}
    for (const g of ssgs) {
      const g0 = CS0.m.get(k + '|' + g) ? CS0.m.get(k + '|' + g).kg : 0
      const g1 = CS1.m.get(k + '|' + g) ? CS1.m.get(k + '|' + g).kg : 0
      const f0 = kg0 > 0 ? g0 / kg0 : 0, f1 = kg1 > 0 ? g1 / kg1 : 0
      const f = (kg0 > 0 && kg1 > 0) ? (f0 + f1) / 2 : (kg1 > 0 ? f1 : f0)
      fr[g] = f; fracSum += f
    }
    for (const g of ssgs) {
      const w = fracSum > 0 ? fr[g] / fracSum : 0
      custMixBySsg[g] = (custMixBySsg[g] || 0) + mc * w
    }
  }
  const productMix = cellMix - customerMix

  // Product mix by SSG = cell-mix(g) − customer-mix(g). Σ === productMix (exact).
  const ssgSet = new Set([...Object.keys(cellMixBySsg), ...Object.keys(custMixBySsg)])
  const product_mix_by_ssg = [...ssgSet]
    .map(g => ({ ssg: g === 'UNSPEC' ? 'Untagged' : g, value: (cellMixBySsg[g] || 0) - (custMixBySsg[g] || 0) }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

  return {
    available: true,
    gm0_per_ton: gm0, gm1_per_ton: gm1, delta: gm1 - gm0,
    price: price, cost: cost,
    customer_mix: customerMix, product_mix: productMix, mix_total: cellMix,
    cost_components: { rm: costRm, packaging: costPkg, feedtag: costFt },
    product_mix_by_ssg,
  }
}

module.exports = {
  bridgeGP,
  bridgeGMperKg,
  bridgeGMperKgBySsg,
  bridgeGMperTonByPair,
  bridgeCanonicalGMperTon,
  ingredientContribution,
}
