const { query } = require('./_db')
const { verifySession } = require('./_auth')
const cache = require('../lib/cache')
const hierarchy = require('./data/product_hierarchy.json')
const districtManagers = require('./data/district_managers.json')
const districtList = require('./data/district_list.json')

// Normalise display names / lookups
function canonDistrict(s){
  if (!s) return 'TOTAL NATIONAL'
  return String(s).trim().toUpperCase().replace(/[_-]+/g, ' ')
}

// Form classification — keywords from the SKU name
const FORM_NAMES = ['Pellets', 'Crumbles', 'Mash', 'Extruded', 'Grains', 'Ready Mix', 'Wet Products']
function classifyForm(name){
  if (!name) return 'Ready Mix'
  const n = name.toUpperCase()
  if (/PELLET/.test(n))          return 'Pellets'
  if (/CRUMBLE/.test(n))         return 'Crumbles'
  if (/MASH/.test(n))            return 'Mash'
  if (/EXTRUDED|\bDRY\b/.test(n)) return 'Extruded'
  if (/GRAIN|CORN|SOYA|MAIZE|SOY BEAN/.test(n)) return 'Grains'
  if (/TERRINE|CHUNK|WET|GRAVY/.test(n)) return 'Wet Products'
  return 'Ready Mix'
}

// Group classification — maps SAP ItemName description to Excel hierarchy.
// SAP ItemCodes are FG000xxx (not vpi000xxx like the Excel) — match by description.
// Returns { group, sub_group } or null if the item should be skipped.
function classifyGroup(name){
  if (!name) return null
  const n = name.toUpperCase()

  // PET FOOD
  if (/\bKEOS\+\s*DOG\b|\bKEOS\+\s*-\s*DOG\b/.test(n)) return { group:'PET FOOD', sub_group:'KEOS+ - DOG' }
  if (/\bKEOS\+\s*CAT\b/.test(n))                     return { group:'PET FOOD', sub_group:'KEOS+ - CAT' }
  if (/\bKEOS\+/.test(n))                             return { group:'PET FOOD', sub_group:'KEOS+' }
  if (/\bKEOS\s+DOG\b|\bKEOS\s*-\s*DOG\b/.test(n))     return { group:'PET FOOD', sub_group:'KEOS - DOG' }
  if (/\bKEOS\s+CAT\b|\bKEOS\s*-\s*CAT\b/.test(n))     return { group:'PET FOOD', sub_group:'KEOS - CAT' }
  if (/\bKEOS\b/.test(n))                             return { group:'PET FOOD', sub_group:'KEOS' }
  if (/\bNOVOPET\b/.test(n))                          return { group:'PET FOOD', sub_group:'NOVOPET' }
  if (/\bPLAISIR\b|\bPLAISER\b/.test(n)){
    if (/\bCAT\b|TERRINE W\/\s*(SALMON|TUNA|TROUT)/.test(n)) return { group:'PET FOOD', sub_group:'PLAISIR - CAT' }
    return { group:'PET FOOD', sub_group:'PLAISIR - DOG' }
  }

  // AQUA
  if (/\bVANA\b|\bSHRIMP\b|\bPRAWN\b|\bAQUA\b/.test(n)) return { group:'AQUA', sub_group:'VANA' }

  // PRIVATE LABEL
  if (/PRIVATE LABEL|\bPL\s|\bPL-|^PL /.test(n))      return { group:'PRIVATE LABEL', sub_group:null }

  // PROBOOST
  if (/PROBOOST/.test(n))                             return { group:'PROBOOST', sub_group:null }

  // POULTRY sub-groups
  if (/VIEPRO\s*(MUSCLY|BROILER)|HBFI|BROILER/.test(n))return { group:'POULTRY', sub_group:'VIEPRO - BROILER' }
  if (/LAYER/.test(n))                                 return { group:'POULTRY', sub_group:'VIEPRO - LAYER' }

  // OTHERS — PDP / GAMEFOWL
  if (/\bPDP\b/.test(n))                              return { group:'OTHERS', sub_group:'PDP' }
  if (/GAMEFOWL|GAME FOWL/.test(n))                    return { group:'OTHERS', sub_group:'GAMEFOWL' }

  // VIEPRO tier branches
  if (/VIEPROMO/.test(n))                             return { group:'VIEPRO PROMO', sub_group:null }
  if (/VIETOP/.test(n))                               return { group:'VIETOP', sub_group:null }
  if (/VIEPRO\s*PRIME/.test(n))                       return { group:'VIEPRO PRIME', sub_group:null }
  if (/VIEPRO/.test(n))                               return { group:'VIEPRO', sub_group:null }

  // Raw materials / packaging — skip
  if (/SOY BEAN MEAL|USED SACKS|SACK|PACKAGING|SCRAP|TESTING|SAMPLE|CASH|VARIOUS/.test(n)) return null

  // Catch-all
  return { group:'OTHERS', sub_group:'OTHERS' }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const startMs = Date.now()

  const districtRaw   = req.query.district || 'TOTAL NATIONAL'
  const district      = canonDistrict(districtRaw)
  const year          = parseInt(req.query.year) || new Date().getFullYear()
  const compareYear   = parseInt(req.query.compare_year) || (year - 1)

  const cacheKey = `itemized_v1_${district}_${year}_${compareYear}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) {
    res.setHeader('X-Query-Cached', '1')
    return res.json(cached)
  }

  try {
    // ---- PHASE 1 scope rule ----
    // Only TOTAL NATIONAL pulls real SAP data. Other districts/KAs return the full
    // product structure with zero values + a `district_mapping_pending` flag.
    const isTotalNational = /^TOTAL NATIONAL/i.test(district) || district === 'TOTAL NATIONAL'
    let rawByItemMonth = []  // [{item_code, month, year, bags, mt}]
    let queryMs = 0

    if (isTotalNational) {
      const qStart = Date.now()
      rawByItemMonth = await query(`
        SELECT
          T1.ItemCode                                                           AS item_code,
          MAX(I.ItemName)                                                       AS item_name,
          MAX(I.SWeight1)                                                       AS weight_per_bag_kg,
          MAX(I.NumInSale)                                                      AS num_in_sale,
          MONTH(T0.DocDate)                                                     AS month,
          YEAR(T0.DocDate)                                                      AS year,
          ISNULL(SUM(T1.Quantity), 0)                                           AS bags,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)         AS mt
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
        WHERE T0.CANCELED = 'N'
          AND YEAR(T0.DocDate) IN (@year, @cy)
          AND UPPER(T1.ItemCode) LIKE 'FG%'
        GROUP BY T1.ItemCode, MONTH(T0.DocDate), YEAR(T0.DocDate)
      `, { year, cy: compareYear })
      queryMs = Date.now() - qStart
    }

    // ---- Pivot rows → per-SKU monthly vectors, keyed by SAP ItemCode ----
    const skuMap = {}
    rawByItemMonth.forEach(r => {
      const code = String(r.item_code).trim()
      if (!skuMap[code]) {
        skuMap[code] = {
          item_code: code,
          name: r.item_name || code,
          bag_size_kg: r.num_in_sale != null ? Number(r.num_in_sale) : (r.weight_per_bag_kg || null),
          monthly_bags_cy: new Array(12).fill(0),
          monthly_bags_ly: new Array(12).fill(0),
          monthly_mt_cy:   new Array(12).fill(0),
          monthly_mt_ly:   new Array(12).fill(0)
        }
      }
      const m = (r.month || 1) - 1
      if (r.year === year) {
        skuMap[code].monthly_bags_cy[m] += Number(r.bags) || 0
        skuMap[code].monthly_mt_cy[m]   += Number(r.mt)   || 0
      } else if (r.year === compareYear) {
        skuMap[code].monthly_bags_ly[m] += Number(r.bags) || 0
        skuMap[code].monthly_mt_ly[m]   += Number(r.mt)   || 0
      }
    })

    function finaliseSku(s, classification){
      const sum = arr => arr.reduce((a, b) => a + b, 0)
      const totalBagsCy = sum(s.monthly_bags_cy)
      const totalBagsLy = sum(s.monthly_bags_ly)
      const totalMtCy   = sum(s.monthly_mt_cy)
      const totalMtLy   = sum(s.monthly_mt_ly)
      const vs_ly_pct   = totalMtLy > 0 ? ((totalMtCy - totalMtLy) / totalMtLy) * 100 : null
      return {
        item_code:       s.item_code,
        name:            s.name,
        bag_size_kg:     s.bag_size_kg,
        group:           classification ? classification.group : null,
        sub_group:       classification ? classification.sub_group : null,
        form:            classifyForm(s.name),
        monthly_bags_cy: s.monthly_bags_cy.map(v => Math.round(v)),
        monthly_bags_ly: s.monthly_bags_ly.map(v => Math.round(v)),
        monthly_mt_cy:   s.monthly_mt_cy.map(v   => Math.round(v * 10) / 10),
        monthly_mt_ly:   s.monthly_mt_ly.map(v   => Math.round(v * 10) / 10),
        total_bags_cy:   Math.round(totalBagsCy),
        total_bags_ly:   Math.round(totalBagsLy),
        total_mt_cy:     Math.round(totalMtCy * 10) / 10,
        total_mt_ly:     Math.round(totalMtLy * 10) / 10,
        vs_ly_pct:       vs_ly_pct == null ? null : Math.round(vs_ly_pct * 10) / 10
      }
    }

    // ---- Bucket SAP items into top-level groups via classifyGroup ----
    // Always emit the 10 top-level groups in Excel order, even if empty.
    const GROUP_ORDER = ['VIEPRO','VIEPRO PRIME','VIEPRO PROMO','VIETOP','POULTRY','OTHERS','PROBOOST','PRIVATE LABEL','AQUA','PET FOOD']
    const groupMap = {}
    GROUP_ORDER.forEach((g, i) => { groupMap[g] = { name: g, order: i+1, skus: [], sub_groups: {} } })

    Object.values(skuMap).forEach(s => {
      const cl = classifyGroup(s.name)
      if (!cl) return
      const g = groupMap[cl.group]; if (!g) return
      const finalized = finaliseSku(s, cl)
      if (cl.sub_group){
        if (!g.sub_groups[cl.sub_group]) g.sub_groups[cl.sub_group] = { name: cl.sub_group, skus: [] }
        g.sub_groups[cl.sub_group].skus.push(finalized)
      } else {
        g.skus.push(finalized)
      }
    })

    const groups = GROUP_ORDER.map(name => {
      const g = groupMap[name]
      const subs = Object.values(g.sub_groups).map(sg => {
        sg.skus.sort((a,b) => b.total_mt_cy - a.total_mt_cy)
        return sg
      })
      g.skus.sort((a,b) => b.total_mt_cy - a.total_mt_cy)
      return {
        name: g.name,
        order: g.order,
        is_parent: subs.length > 0,
        skus: g.skus,
        sub_groups: subs.length ? subs : undefined
      }
    })

    // ---- District total (all SKUs summed) ----
    function sumVectors(vectors){ const out = new Array(12).fill(0); vectors.forEach(v => v.forEach((x, i) => { out[i] += x })); return out }
    const allSkus = []
    groups.forEach(g => {
      (g.skus || []).forEach(s => allSkus.push(s));
      (g.sub_groups || []).forEach(sg => (sg.skus || []).forEach(s => allSkus.push(s)))
    })
    const district_total = {
      monthly_bags_cy: sumVectors(allSkus.map(s => s.monthly_bags_cy)),
      monthly_bags_ly: sumVectors(allSkus.map(s => s.monthly_bags_ly)),
      monthly_mt_cy:   sumVectors(allSkus.map(s => s.monthly_mt_cy)).map(v => Math.round(v * 10) / 10),
      monthly_mt_ly:   sumVectors(allSkus.map(s => s.monthly_mt_ly)).map(v => Math.round(v * 10) / 10),
      total_bags_cy:   allSkus.reduce((a, s) => a + s.total_bags_cy, 0),
      total_bags_ly:   allSkus.reduce((a, s) => a + s.total_bags_ly, 0),
      total_mt_cy:     Math.round(allSkus.reduce((a, s) => a + s.total_mt_cy, 0) * 10) / 10,
      total_mt_ly:     Math.round(allSkus.reduce((a, s) => a + s.total_mt_ly, 0) * 10) / 10
    }
    district_total.vs_ly_pct = district_total.total_mt_ly > 0
      ? Math.round(((district_total.total_mt_cy - district_total.total_mt_ly) / district_total.total_mt_ly) * 1000) / 10
      : null

    // ---- Form summary ----
    const formAgg = {}
    FORM_NAMES.forEach(f => {
      formAgg[f] = {
        form: f,
        monthly_bags_cy: new Array(12).fill(0),
        monthly_mt_cy:   new Array(12).fill(0),
        total_bags_cy:   0,
        total_mt_cy:     0
      }
    })
    allSkus.forEach(s => {
      const f = s.form
      if (!formAgg[f]) return
      s.monthly_bags_cy.forEach((v, i) => formAgg[f].monthly_bags_cy[i] += v)
      s.monthly_mt_cy.forEach((v, i) => formAgg[f].monthly_mt_cy[i] += v)
      formAgg[f].total_bags_cy += s.total_bags_cy
      formAgg[f].total_mt_cy   += s.total_mt_cy
    })
    const form_summary = FORM_NAMES.map(f => ({
      form: f,
      monthly_bags_cy: formAgg[f].monthly_bags_cy.map(v => Math.round(v)),
      monthly_mt_cy:   formAgg[f].monthly_mt_cy.map(v   => Math.round(v * 10) / 10),
      total_bags_cy:   Math.round(formAgg[f].total_bags_cy),
      total_mt_cy:     Math.round(formAgg[f].total_mt_cy * 10) / 10
    }))

    const result = {
      district,
      district_manager: districtManagers[district] || null,
      district_mapping_pending: !isTotalNational,
      year,
      compare_year: compareYear,
      active_sku_count: allSkus.filter(s => s.total_bags_cy > 0 || s.total_bags_ly > 0).length,
      total_sku_count: allSkus.length,
      groups,
      form_summary,
      district_total,
      query_ms: queryMs,
      total_ms: Date.now() - startMs
    }

    cache.set(cacheKey, result, 600)
    res.setHeader('X-Query-Ms', String(queryMs))
    res.setHeader('X-Total-Ms', String(Date.now() - startMs))
    res.json(result)
  } catch (err) {
    console.error('API error [itemized]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}

// Expose hierarchy + district list as helpers for the /api/itemized/meta endpoint.
module.exports.getMeta = () => ({
  districts: districtList,
  district_managers: districtManagers,
  groups: hierarchy.structure.map(g => ({ name: g.name, order: g.order, is_parent: !!g.is_parent }))
})
