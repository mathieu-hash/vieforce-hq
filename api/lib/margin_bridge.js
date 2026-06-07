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

module.exports = {
  bridgeGP,
  bridgeGMperKg,
  bridgeGMperKgBySsg,
  ingredientContribution,
}
