// api/lib/margin_bridge_v2.js
//
// GM/ton bridge — v2. Replaces bridgeCanonicalGMperTon for the Margin Explorer
// dissection panel. Same Bennet indicator core (still additively exact), but four
// defects of v1 are fixed:
//
//   1. MIX SPLIT IS ORDER-NEUTRAL. v1 computed customer mix from an independent
//      cube and took product mix as the RESIDUAL, so the whole customer×product
//      interaction landed in "Product Mix" and the split depended entirely on
//      which dimension went first. Measured on 2026-08 that choice moved the
//      customer bar from -251 to +3 PHP/t. v2 computes BOTH orderings and reports
//      the symmetric (Shapley) mean as the headline, plus the full range so the
//      reader can see how much of the split is a modelling choice.
//
//   2. CHURN IS SEPARATED FROM WEIGHT SHIFT. A customer×SKU cell present in only
//      one window has no price to compare, so 100% of its weight lands in Mix. In
//      a partial month that is mostly "hasn't ordered yet", not commerce. v2
//      reports mix_detail.{continuing, entering, exiting} so a mix bar dominated
//      by one-sided cells is visibly not a structural finding.
//
//   3. COMPOSITION LENSES ARE MEASURED, NOT ALLOCATED. v1's product_mix_by_ssg
//      spread each customer's mix across SSGs by average within-customer volume
//      fraction — an allocation, not an identity. Four of eight SSG signs were
//      wrong against a direct measurement. v2 drops it and instead reports a clean
//      one-dimensional Bennet share-shift PER DIMENSION (ssg/bu/region/customer/
//      sku). Each lens is internally exact. Lenses DO NOT sum to each other or to
//      the mix bar — they are alternative views of the same composition effect,
//      and the payload says so.
//
//   4. THE COST SPLIT IS LABELLED AS ESTIMATED. RM was derived as
//      dRm = dc - dPkg - dFt against a YTD-average production ratio priced at
//      OITM.LastPurPrc (a current snapshot, not a per-period price). That is an
//      estimate carrying a measured bar's authority. v2 tags it estimated:true.
//
// HARD INVARIANT (unit-tested): price + cost + customer_mix + product_mix === delta
//
// Bennet identity per cell, s = tonnage share, m = unit margin PHP/ton:
//   s1*m1 - s0*m0 = sbar*dm + mbar*ds        (exact, no residual)
//     sbar*dm -> Rate  = Price (sbar*dp) + Cost (-sbar*dc)
//     mbar*ds -> Mix   = composition
// One-sided cells: no rate term (nothing to compare), full move into Mix.

'use strict'

const num = (v) => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : 0 }

// Aggregate rows to a key. Returns { m: Map<key,{kg,revenue,gp,attrs}>, Q, dropped }.
// Cells whose NET kg <= 0 (returns exceeding shipments) cannot carry a share and are
// dropped — but counted and reported rather than silently vanishing as in v1.
function agg(rows, keyFn) {
  const m = new Map()
  for (const r of rows || []) {
    const k = keyFn(r)
    const o = m.get(k) || {
      kg: 0, revenue: 0, gp: 0,
      ssg: r.ssg == null || r.ssg === '' ? 'UNSPEC' : String(r.ssg),
      bu: r.bu == null || r.bu === '' ? 'UNSPEC' : String(r.bu),
      region: r.region == null || r.region === '' ? 'UNSPEC' : String(r.region),
      sku: r.sku, cust: r.cust, name: r.name, custname: r.custname,
    }
    o.kg += num(r.kg); o.revenue += num(r.revenue); o.gp += num(r.gp)
    m.set(k, o)
  }
  let Q = 0, dropped = 0, droppedGp = 0
  for (const [k, o] of m) {
    if (o.kg > 0) Q += o.kg
    else { dropped++; droppedGp += o.gp; m.delete(k) }
  }
  return { m, Q, dropped, droppedGp }
}

// Per-cell metrics against a window total Q (kg). null when the cell is absent.
function metr(o, Q) {
  if (!o || o.kg <= 0 || Q <= 0) return null
  const t = o.kg / 1000
  return { s: o.kg / Q, p: o.revenue / t, c: (o.revenue - o.gp) / t, m: o.gp / t }
}

// One-dimensional Bennet mix term over an arbitrary key: SUM (mbar - center)*ds.
//
// CENTERING IS NOT COSMETIC. Because SUM(ds) = 0 over any complete dimension, the
// TOTAL is identical with or without `center` — but the PER-ROW attribution is not,
// and uncentered rows are economically backwards. Example, Jul->Aug 2026: LAYER gains
// 4.9pp of share at 4,718 PHP/t against a book average of ~6,577. Uncentered that
// prints +232 (it added gross profit); centered it prints -92 (it diluted unit margin,
// which is what a GM/TON bridge is measuring). A GM/ton bridge must value a share
// shift against the AVERAGE margin, otherwise every growing category looks accretive
// and every shrinking one looks dilutive regardless of its economics.
//
// `center` should be the symmetric blended margin (gm0 + gm1) / 2.
function mixByDim(rows0, rows1, keyFn, labelFn, center) {
  const A = agg(rows0, keyFn), B = agg(rows1, keyFn)
  const keys = new Set([...A.m.keys(), ...B.m.keys()])
  const M = num(center)
  let total = 0
  const detail = []
  for (const k of keys) {
    const a = metr(A.m.get(k), A.Q), b = metr(B.m.get(k), B.Q)
    let v = 0
    if (a && b) v = ((a.m + b.m) / 2 - M) * (b.s - a.s)
    else if (b) v = (b.m - M) * b.s
    else if (a) v = (a.m - M) * (-a.s)
    total += v
    const src = B.m.get(k) || A.m.get(k)
    detail.push({
      key: labelFn ? labelFn(k, src) : k,
      value: v,
      share0: a ? a.s : 0,
      share1: b ? b.s : 0,
      share_shift_pp: ((b ? b.s : 0) - (a ? a.s : 0)) * 100,
      gm_ton0: a ? a.m : null,
      gm_ton1: b ? b.m : null,
      tons0: A.m.get(k) ? A.m.get(k).kg / 1000 : 0,
      tons1: B.m.get(k) ? B.m.get(k).kg / 1000 : 0,
    })
  }
  detail.sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
  return { total, detail }
}

/**
 * Exact GM/ton bridge at customer x SKU.
 *
 * rows0 / rows1: [{ cust, sku, ssg, bu, region, name, kg, revenue, gp }]
 * opts.costRatio: { [sku]: { pkg, ft } } — OPTIONAL. When supplied the Cost bar is
 *   split into RM/Packaging/Feedtag. The split is an ESTIMATE (production-order
 *   ratio at a snapshot price) and is flagged as such in the return.
 * opts.lensDims: which composition lenses to compute. Default all five.
 */
function bridgeExactGMperTon(rows0, rows1, opts) {
  opts = opts || {}
  const costRatio = opts.costRatio || null
  const lensDims = opts.lensDims || ['ssg', 'bu', 'region', 'customer', 'sku']

  const cellKey = (r) => (r.cust == null ? '' : String(r.cust)) + '|' + (r.sku == null ? '' : String(r.sku))
  const custKey = (r) => (r.cust == null ? '' : String(r.cust))
  const skuKey = (r) => (r.sku == null ? '' : String(r.sku))

  const C0 = agg(rows0, cellKey), C1 = agg(rows1, cellKey)
  if (C0.Q <= 0 || C1.Q <= 0) {
    return { available: false, reason: 'no volume in one or both windows' }
  }

  const gm0 = [...C0.m.values()].reduce((s, o) => s + o.gp, 0) / (C0.Q / 1000)
  const gm1 = [...C1.m.values()].reduce((s, o) => s + o.gp, 0) / (C1.Q / 1000)

  // Every mix term is valued against the blended average margin. SUM(ds)=0 so this
  // leaves all totals identical, but it makes each component answer the right
  // question: "did this shift dilute or enrich unit margin?" rather than "did it add
  // gross profit?". See mixByDim for why the uncentered form is backwards.
  const MBAR = (gm0 + gm1) / 2

  // ---- cell pass: Price, Cost, total Mix, and the churn split ----
  const keys = new Set([...C0.m.keys(), ...C1.m.keys()])
  let price = 0, cost = 0, cellMix = 0
  let mixContinuing = 0, mixEntering = 0, mixExiting = 0
  let costRm = 0, costPkg = 0, costFt = 0
  let kgBoth1 = 0

  for (const k of keys) {
    const A = C0.m.get(k), B = C1.m.get(k)
    const a = metr(A, C0.Q), b = metr(B, C1.Q)
    if (a && b) {
      const sbar = (a.s + b.s) / 2
      price += sbar * (b.p - a.p)
      cost += -sbar * (b.c - a.c)
      const v = ((a.m + b.m) / 2 - MBAR) * (b.s - a.s)
      cellMix += v; mixContinuing += v
      kgBoth1 += B.kg
      if (costRatio) {
        const r = costRatio[(B && B.sku) || (A && A.sku)] || { pkg: 0, ft: 0 }
        const dc = b.c - a.c
        const dPkg = dc * (r.pkg || 0), dFt = dc * (r.ft || 0)
        costPkg += -sbar * dPkg; costFt += -sbar * dFt; costRm += -sbar * (dc - dPkg - dFt)
      }
    } else if (b) {
      const v = (b.m - MBAR) * b.s; cellMix += v; mixEntering += v
    } else if (a) {
      const v = (a.m - MBAR) * (-a.s); cellMix += v; mixExiting += v
    }
  }

  // ---- mix split, both orderings, then symmetric mean ----
  // Customer-first: customer term measured at customer grain, product = remainder.
  // Product-first:  product term measured at SKU grain, customer = remainder.
  // Each remainder absorbs the interaction; averaging them is the Shapley value for
  // a two-player attribution and is order-neutral by construction.
  const custOnly = mixByDim(rows0, rows1, custKey, null, MBAR).total
  const skuOnly = mixByDim(rows0, rows1, skuKey, null, MBAR).total

  const orderA = { customer: custOnly, product: cellMix - custOnly }   // customer first (v1's choice)
  const orderB = { customer: cellMix - skuOnly, product: skuOnly }     // product first
  const customerMix = (orderA.customer + orderB.customer) / 2
  const productMix = (orderA.product + orderB.product) / 2             // sums to cellMix exactly

  // ---- composition lenses: each internally exact, none summing to another ----
  const lensSpec = {
    ssg: (r) => (r.ssg == null || r.ssg === '' ? 'UNSPEC' : String(r.ssg)),
    bu: (r) => (r.bu == null || r.bu === '' ? 'UNSPEC' : String(r.bu)),
    region: (r) => (r.region == null || r.region === '' ? 'UNSPEC' : String(r.region)),
    customer: custKey,
    sku: skuKey,
  }
  const lenses = {}
  for (const d of lensDims) {
    if (!lensSpec[d]) continue
    const label = d === 'sku'
      ? (k, src) => (src && src.name) || k
      : d === 'customer'
        ? (k, src) => (src && src.custname) || k
        : null
    const L = mixByDim(rows0, rows1, lensSpec[d], label, MBAR)
    lenses[d] = { total: L.total, rows: L.detail }
  }

  const delta = gm1 - gm0
  const residual = delta - (price + cost + customerMix + productMix)

  // Share of the mix bar that comes from cells present in only one window. Above
  // ~40% the mix bar is mostly churn/timing and should not be read as a shift.
  const grossOneSided = Math.abs(mixEntering) + Math.abs(mixExiting)
  const grossMix = grossOneSided + Math.abs(mixContinuing)
  const oneSidedShare = grossMix > 0 ? grossOneSided / grossMix : 0
  const matchedKgShare = C1.Q > 0 ? kgBoth1 / C1.Q : 0
  // Two independent ways the mix bar can be timing rather than commerce: the effect is
  // mostly one-sided cells, OR a large slice of current tonnage has no prior-period
  // counterpart to compare against. Either alone is enough to suppress a headline.
  const churnDominated = oneSidedShare > 0.4 || matchedKgShare < 0.85

  return {
    available: true,
    gm0_per_ton: gm0, gm1_per_ton: gm1, delta,
    price, cost,
    customer_mix: customerMix, product_mix: productMix, mix_total: cellMix,

    // How much of the customer/product split is a modelling choice rather than a
    // measurement. If the two orderings straddle zero, do not quote the split.
    mix_ordering: {
      customer_first: orderA,
      product_first: orderB,
      customer_range: [Math.min(orderA.customer, orderB.customer), Math.max(orderA.customer, orderB.customer)],
      product_range: [Math.min(orderA.product, orderB.product), Math.max(orderA.product, orderB.product)],
      sign_stable: (orderA.customer >= 0) === (orderB.customer >= 0),
    },

    mix_detail: {
      continuing: mixContinuing,
      entering: mixEntering,
      exiting: mixExiting,
      one_sided_share: oneSidedShare,
      matched_kg_share: matchedKgShare,
      churn_dominated: churnDominated,
      cells_both: C0.m.size + C1.m.size - keys.size,
      cells_only_prior: keys.size - C1.m.size,
      cells_only_current: keys.size - C0.m.size,
      kg_matched_current: kgBoth1,
      kg_current: C1.Q,
    },

    lenses,

    cost_components: costRatio ? {
      rm: costRm, packaging: costPkg, feedtag: costFt,
      estimated: true,
      basis: 'production-order class ratio (OWOR/WOR1 x OITM.LastPurPrc, YTD avg) applied to booked COGS; RM is the remainder. LastPurPrc is a current snapshot, not a per-period price.',
    } : null,

    dropped_cells: { prior: C0.dropped, current: C1.dropped, gp_prior: C0.droppedGp, gp_current: C1.droppedGp },

    reconciles: Math.abs(residual) < 1e-6,
    residual,
  }
}

/**
 * Significance band. Feeds the bridge's delta against the distribution of the same
 * statistic over historical windows of the same length, so the UI can say whether a
 * move clears normal variation instead of implying every wiggle is a finding.
 *
 * samples: array of historical GM/ton deltas computed the same way.
 */
function significance(delta, samples) {
  const xs = (samples || []).filter((x) => Number.isFinite(x))
  if (xs.length < 5) return { available: false, reason: 'need >= 5 historical windows' }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1))
  const z = sd > 0 ? (delta - mean) / sd : 0
  const sorted = [...xs].sort((a, b) => a - b)
  const pct = sorted.filter((x) => x <= delta).length / sorted.length
  return {
    available: true, n: xs.length, mean, sd, z, percentile: pct,
    band: [sorted[Math.floor(0.05 * (sorted.length - 1))], sorted[Math.floor(0.95 * (sorted.length - 1))]],
    // Below 1 sd a single window cannot distinguish the move from ordinary noise.
    verdict: Math.abs(z) >= 2 ? 'signal' : Math.abs(z) >= 1 ? 'weak' : 'noise',
  }
}

module.exports = { bridgeExactGMperTon, significance, mixByDim }
