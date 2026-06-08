// margin_cube.js — Margin Dissection cube + pure compute functions.
//
// Faithful port of _margin_audit/gen_payload2.py + METHODOLOGY.md (finished-feed GM/ton).
// Scope is FEED-ONLY: Vienovo_Live group 103, Vienovo_Old groups 103+104 (104≈70% of 2025).
// 2025 region from INV1.WhsCode map; 2026 region from INV1.OcrCode2 prefix. Returns netted
// via ORIN/RIN1. SSG via [@OITMSSG].Name on OITM.U_SSG. All money PHP; tons = kg/1000.
//
// The PURE functions (trajectory/ssgBridge/mixBridge/ingredientContribution) take plain
// rows and are unit-tested without SAP. buildCube() runs the live cross-DB SQL.

// ---- 2025 (Vienovo_Old) shipping-warehouse → region map (gen_payload2 reg2025) ----
const OLD_REGION = {
  MIND: new Set(['BUKID', 'SOUTH', 'CAG', 'ALAE']),
  VIS: new Set(['HOREB', 'BAC', 'ARGAO']),
  LUZ104: new Set(['AC', 'PFMCIS'])
}
function region2025(grp, whs) {
  if (Number(grp) === 103) return 'Luzon'
  const w = String(whs || '').trim()
  if (OLD_REGION.MIND.has(w)) return 'Mindanao'
  if (OLD_REGION.VIS.has(w)) return 'Visayas'
  if (OLD_REGION.LUZ104.has(w)) return 'Luzon'
  return 'Visayas'
}

// ============================================================================
// PURE COMPUTE — operate on rows [{month:'YYYY-MM', ssg, rev, gp, kg}]
// ============================================================================

function aggByMonth(rows) {
  const m = {}
  for (const r of rows) {
    const o = m[r.month] || (m[r.month] = { rev: 0, gp: 0, kg: 0 })
    o.rev += +r.rev || 0; o.gp += +r.gp || 0; o.kg += +r.kg || 0
  }
  return m
}

// Panels 1 & 2 — per-month GM/ton + revenue/ton over an ordered month list.
function trajectory(rows, months) {
  const m = aggByMonth(rows)
  return months.map(mo => {
    const o = m[mo] || { rev: 0, gp: 0, kg: 0 }
    const t = o.kg / 1000
    return {
      month: mo,
      tons: Math.round(t),
      rev_per_ton: t > 0 ? Math.round(o.rev / t) : 0,
      gm_per_ton: t > 0 ? Math.round(o.gp / t) : 0,
      cogs_per_ton: t > 0 ? Math.round((o.rev - o.gp) / t) : 0,
      gm_pct: o.rev > 0 ? Math.round(o.gp / o.rev * 1000) / 10 : 0
    }
  })
}

// {ssg: {rev,gp,kg}} for a single month
function bySsg(rows, month) {
  const m = {}
  for (const r of rows) {
    if (r.month !== month) continue
    const o = m[r.ssg] || (m[r.ssg] = { rev: 0, gp: 0, kg: 0 })
    o.rev += +r.rev || 0; o.gp += +r.gp || 0; o.kg += +r.kg || 0
  }
  return m
}
const sumKg = obj => Object.values(obj).reduce((s, o) => s + o.kg, 0)
const sumGp = obj => Object.values(obj).reduce((s, o) => s + o.gp, 0)

// Panel 3 — SSG-level GM/ton bridge (METHODOLOGY §3). Stable across the 2025→2026 break.
function ssgBridge(rows, baseMonth, cmpMonth) {
  const B = bySsg(rows, baseMonth), C = bySsg(rows, cmpMonth)
  const tB = sumKg(B) / 1000, tC = sumKg(C) / 1000
  if (tB <= 0 || tC <= 0) return { available: false, reason: 'No feed volume in base or compare month.' }
  const gmtB = sumGp(B) / tB, gmtC = sumGp(C) / tC
  const gmBaseOverall = gmtB
  const ssgs = new Set([...Object.keys(B), ...Object.keys(C)])
  let price = 0, cost = 0, mix = 0
  for (const s of ssgs) {
    const b = B[s], c = C[s]
    const tb = b ? b.kg / 1000 : 0, tc = c ? c.kg / 1000 : 0
    const wb = tb / tB, wc = tc / tC
    const pb = tb > 0 ? b.rev / tb : 0, pc = tc > 0 ? c.rev / tc : 0
    const kb = tb > 0 ? (b.rev - b.gp) / tb : 0, kc = tc > 0 ? (c.rev - c.gp) / tc : 0
    const gb = tb > 0 ? b.gp / tb : gmBaseOverall            // §3: fallback to base overall GM/ton
    price += wb * (pc - pb)                                   // price move at base mix
    cost += -wb * (kc - kb)                                   // cost move at base mix (cost↑ ⇒ GM↓)
    mix += (wc - wb) * gb                                     // mix shift valued at base margins
  }
  const delta = gmtC - gmtB
  const interaction = delta - (price + mix + cost)            // explicit residual
  return {
    available: true,
    base: Math.round(gmtB), compare: Math.round(gmtC),
    price: Math.round(price), mix: Math.round(mix), cost: Math.round(cost),
    interaction: Math.round(interaction), delta: Math.round(delta),
    base_month: baseMonth, compare_month: cmpMonth
  }
}

// Panel 5 — product-mix bridge: decompose the Mix bar by SSG (METHODOLOGY §5).
// Σ contribution = ssgBridge.mix (exact reconciliation).
function mixBridge(rows, baseMonth, cmpMonth, topN = 10) {
  const B = bySsg(rows, baseMonth), C = bySsg(rows, cmpMonth)
  const tB = sumKg(B) / 1000, tC = sumKg(C) / 1000
  if (tB <= 0 || tC <= 0) return { available: false, items: [] }
  const gmBaseOverall = sumGp(B) / tB
  const ssgs = new Set([...Object.keys(B), ...Object.keys(C)])
  const items = []
  for (const s of ssgs) {
    const b = B[s], c = C[s]
    const tb = b ? b.kg / 1000 : 0, tc = c ? c.kg / 1000 : 0
    const wb = tb / tB, wc = tc / tC
    const gb = tb > 0 ? b.gp / tb : gmBaseOverall
    items.push({ ssg: s, contribution: Math.round((wc - wb) * gb) })
  }
  items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return {
    available: true,
    items: items.slice(0, topN),
    total: items.reduce((s, i) => s + i.contribution, 0)
  }
}

// Panel 4 — recipe-weighted ingredient cost contribution (METHODOLOGY §4).
// intensity = {ssg: {ing: kg_per_kg_feed}} ; basket = {month: {ing: price_per_kg}}.
// A price MOVE is only attributed when a real purchase price exists in BOTH months;
// if one month has no purchase, the other month's price is carried forward so only
// the recipe/mix effect remains (carried:true on the item). Otherwise a partial month
// with few POs books every unpurchased ingredient's full cost as a fake "decrease".
function ingredientContribution(rows, intensity, basket, baseMonth, cmpMonth, topN = 10) {
  // kg of ingredient `ing` per ton of feed in month `mo`, given the selection's SSG tonnage mix.
  function inclPerTon(mo) {
    // tons per SSG in this month (dimensional; recipe only exists for SSGs with intensity)
    const t = {}
    for (const r of rows) { if (r.month === mo) t[r.ssg] = (t[r.ssg] || 0) + (+r.kg || 0) / 1000 }
    let recipeTons = 0
    for (const s of Object.keys(t)) { if (intensity[s]) recipeTons += t[s] }
    if (recipeTons <= 0) return {}
    const blended = {}   // kg ingredient per (sum over recipe SSGs)
    for (const s of Object.keys(t)) {
      const intab = intensity[s]; if (!intab) continue
      for (const ing of Object.keys(intab)) blended[ing] = (blended[ing] || 0) + t[s] * intab[ing]
    }
    const out = {}
    for (const ing of Object.keys(blended)) out[ing] = blended[ing] / recipeTons  // kg per ton of feed
    return out
  }
  const iB = inclPerTon(baseMonth), iC = inclPerTon(cmpMonth)
  const pB = basket[baseMonth] || {}, pC = basket[cmpMonth] || {}
  const ings = new Set([...Object.keys(iB), ...Object.keys(iC)])
  const items = []
  for (const ing of ings) {
    const hasB = pB[ing] != null, hasC = pC[ing] != null
    if (!hasB && !hasC) continue                            // never priced — nothing honest to show
    const effB = hasB ? pB[ing] : pC[ing]                   // carry-forward across the missing month
    const effC = hasC ? pC[ing] : pB[ing]
    const cB = (iB[ing] || 0) * effB * 1000                 // ₱/ton of feed
    const cC = (iC[ing] || 0) * effC * 1000
    const contribution = cC - cB                            // +ve = costlier (margin headwind)
    if (contribution !== 0) {
      items.push({
        name: ing,
        contribution: Math.round(contribution * 10) / 10,
        cost_now: Math.round(cC * 10) / 10,
        carried: hasB !== hasC                              // price carried from the other month (no purchase)
      })
    }
  }
  items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return {
    available: items.length > 0,
    items: items.slice(0, topN),
    net: Math.round(items.reduce((s, i) => s + i.contribution, 0) * 10) / 10,
    note: 'Recipe-weighted at market purchase price; booked COGS lags by ~the inventory holding period. Ingredients without a purchase in one month carry the other month’s price (recipe effect only).'
  }
}

// ============================================================================
// LIVE CROSS-DB CUBE BUILDER  (deps = { query (Live), queryH (Old) })
// ============================================================================

const REGION_PREFIX = { Luzon: 'L-%', Visayas: 'V-%', Mindanao: 'M-%' }

function cleanIng(s) {
  s = String(s || '').trim()
  return s.length > 26 ? s.slice(0, 26) : s
}

// Build the monthly SSG cube + recipe intensity + ingredient basket for a selection.
// opts: { region:'ALL'|Luzon|Visayas|Mindanao, bu:'ALL'|name, customer:null|str, ssg:null|name }
async function buildCube({ query, queryH }, opts = {}) {
  const region = opts.region && opts.region !== 'ALL' ? opts.region : null
  const bu = opts.bu && opts.bu !== 'ALL' ? opts.bu : null
  const customer = opts.customer || null
  const ssg = opts.ssg || null

  // shared optional predicates (BU / customer / SSG identical across both books)
  const commonWhere = (p) => {
    let w = ''
    if (bu) { w += ` AND G.GroupName=@bu`; p.bu = bu }
    if (customer) { w += ` AND (T0.CardCode=@cust OR T0.CardName LIKE @custl)`; p.cust = customer; p.custl = '%' + customer + '%' }
    if (ssg) { w += ` AND S.Name=@ssg`; p.ssg = ssg }
    return w
  }

  // ---- 2025 (Vienovo_Old): feed = 103+104; net returns; carry grp+whs for region derivation ----
  const oldParams = {}
  const oldCommon = commonWhere(oldParams)
  const OLD_SQL = `
    SELECT mo, ssg, grp, whs, SUM(rev) rev, SUM(gp) gp, SUM(kg) kg FROM (
      SELECT MONTH(T0.DocDate) mo, ISNULL(S.Name,'UNSPEC') ssg, T2.ItmsGrpCod grp, ISNULL(T1.WhsCode,'') whs,
        T1.LineTotal rev, T1.GrssProfit gp, T1.InvQty kg
      FROM OINV T0 JOIN INV1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
      LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
      LEFT JOIN [@OITMSSG] S ON S.Code=T2.U_SSG
      WHERE T0.CANCELED='N' AND T1.InvQty>0 AND T2.ItmsGrpCod IN (103,104)
        AND T0.DocDate BETWEEN '2025-09-01' AND '2025-12-31' ${oldCommon}
      UNION ALL
      SELECT MONTH(T0.DocDate) mo, ISNULL(S.Name,'UNSPEC') ssg, T2.ItmsGrpCod grp, ISNULL(T1.WhsCode,'') whs,
        -T1.LineTotal rev, -T1.GrssProfit gp, -T1.InvQty kg
      FROM ORIN T0 JOIN RIN1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
      LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
      LEFT JOIN [@OITMSSG] S ON S.Code=T2.U_SSG
      WHERE T0.CANCELED='N' AND T1.InvQty>0 AND T2.ItmsGrpCod IN (103,104)
        AND T0.DocDate BETWEEN '2025-09-01' AND '2025-12-31' ${oldCommon}
    ) X GROUP BY mo, ssg, grp, whs`
  const oldRaw = await queryH(OLD_SQL, oldParams).catch(e => { console.warn('[margin_cube] old failed:', e.message); return [] })

  // collapse Old → (month, ssg) with JS-derived region + region filter
  const rowMap = {}
  const addRow = (month, ssgName, rev, gp, kg) => {
    const k = month + '|' + ssgName
    const o = rowMap[k] || (rowMap[k] = { month, ssg: ssgName, rev: 0, gp: 0, kg: 0 })
    o.rev += rev; o.gp += gp; o.kg += kg
  }
  for (const r of oldRaw) {
    const reg = region2025(r.grp, r.whs)
    if (region && reg !== region) continue
    const month = '2025-' + String(r.mo).padStart(2, '0')
    addRow(month, r.ssg || 'UNSPEC', Number(r.rev) || 0, Number(r.gp) || 0, Number(r.kg) || 0)
  }

  // ---- 2026 (Vienovo_Live): feed = 103; region via OcrCode2; net returns ----
  const liveParams = {}
  const liveCommon = commonWhere(liveParams)
  let liveReg = ''
  if (region) {
    if (region === 'Other') liveReg = ` AND T1.OcrCode2 NOT LIKE 'L-%' AND T1.OcrCode2 NOT LIKE 'V-%' AND T1.OcrCode2 NOT LIKE 'M-%'`
    else { liveReg = ` AND T1.OcrCode2 LIKE @rpref`; liveParams.rpref = REGION_PREFIX[region] }
  }
  const LIVE_SQL = `
    SELECT ym, ssg, SUM(rev) rev, SUM(gp) gp, SUM(kg) kg FROM (
      SELECT FORMAT(T0.DocDate,'yyyy-MM') ym, ISNULL(S.Name,'UNSPEC') ssg,
        T1.LineTotal rev, T1.GrssProfit gp, T1.InvQty kg
      FROM OINV T0 JOIN INV1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
      LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
      LEFT JOIN [@OITMSSG] S ON S.Code=T2.U_SSG
      WHERE T0.CANCELED='N' AND T1.InvQty>0 AND T2.ItmsGrpCod=103 AND T0.DocDate>='2026-01-01' ${liveReg} ${liveCommon}
      UNION ALL
      SELECT FORMAT(T0.DocDate,'yyyy-MM') ym, ISNULL(S.Name,'UNSPEC') ssg,
        -T1.LineTotal rev, -T1.GrssProfit gp, -T1.InvQty kg
      FROM ORIN T0 JOIN RIN1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
      LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
      LEFT JOIN [@OITMSSG] S ON S.Code=T2.U_SSG
      WHERE T0.CANCELED='N' AND T1.InvQty>0 AND T2.ItmsGrpCod=103 AND T0.DocDate>='2026-01-01' ${liveReg} ${liveCommon}
    ) X GROUP BY ym, ssg`
  const liveRaw = await query(LIVE_SQL, liveParams).catch(e => { console.warn('[margin_cube] live failed:', e.message); return [] })
  for (const r of liveRaw) addRow(r.ym, r.ssg || 'UNSPEC', Number(r.rev) || 0, Number(r.gp) || 0, Number(r.kg) || 0)

  const rows = Object.values(rowMap)
  const months = [...new Set(rows.map(r => r.month))].sort()

  // ---- recipe intensity + ingredient basket (Live 2026 production + purchases) ----
  let intensity = {}, basket = {}
  try {
    const [intRows, fgRows, bkRows] = await Promise.all([
      query(`SELECT ISNULL(S.Name,'UNSPEC') ssg, CI.ItemName ing, SUM(C.IssuedQty) issued
             FROM OWOR P JOIN WOR1 C ON C.DocEntry=P.DocEntry
             JOIN OITM FI ON FI.ItemCode=P.ItemCode JOIN OITM CI ON CI.ItemCode=C.ItemCode
             LEFT JOIN [@OITMSSG] S ON S.Code=FI.U_SSG
             WHERE P.PostDate>='2026-01-01' AND FI.ItmsGrpCod=103 AND CI.ItmsGrpCod=101 AND C.IssuedQty>0
             GROUP BY S.Name, CI.ItemName`, {}),
      query(`SELECT ISNULL(S.Name,'UNSPEC') ssg, SUM(P.CmpltQty) fg
             FROM OWOR P JOIN OITM FI ON FI.ItemCode=P.ItemCode LEFT JOIN [@OITMSSG] S ON S.Code=FI.U_SSG
             WHERE P.PostDate>='2026-01-01' AND FI.ItmsGrpCod=103 GROUP BY S.Name`, {}),
      query(`SELECT FORMAT(T0.DocDate,'yyyy-MM') ym, T2.ItemName ing, SUM(T1.LineTotal) spend, SUM(T1.Quantity) qty
             FROM OPCH T0 JOIN PCH1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
             WHERE T0.CANCELED='N' AND T2.ItmsGrpCod=101 AND T0.DocDate>='2026-01-01'
             GROUP BY FORMAT(T0.DocDate,'yyyy-MM'), T2.ItemName`, {})
    ])
    const fg = {}; fgRows.forEach(r => { fg[r.ssg] = Number(r.fg) || 0 })
    intRows.forEach(r => {
      const f = fg[r.ssg]; if (!f || f <= 0) return
      const s = r.ssg || 'UNSPEC', ing = cleanIng(r.ing)
      ;(intensity[s] || (intensity[s] = {}))[ing] = (intensity[s][ing] || 0) + (Number(r.issued) || 0) / f
    })
    bkRows.forEach(r => {
      const q = Number(r.qty) || 0; if (q <= 0) return
      const mo = r.ym, ing = cleanIng(r.ing)
      ;(basket[mo] || (basket[mo] = {}))[ing] = (Number(r.spend) || 0) / q
    })
  } catch (e) { console.warn('[margin_cube] intensity/basket failed:', e.message) }

  return { rows, months, intensity, basket }
}

module.exports = {
  region2025, OLD_REGION, buildCube,
  trajectory, ssgBridge, mixBridge, ingredientContribution,
  // internals exported for tests
  _aggByMonth: aggByMonth, _bySsg: bySsg
}
