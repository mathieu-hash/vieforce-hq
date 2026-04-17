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
// Matches the Form Summary rows in the reference sheet.
const FORM_NAMES = ['Pellets', 'Crumbles', 'Mash', 'Extruded', 'Grains', 'Ready Mix', 'Wet Products']
function classifyForm(name){
  if (!name) return 'Ready Mix'
  const n = name.toUpperCase()
  if (/PELLET/.test(n))         return 'Pellets'
  if (/CRUMBLE/.test(n))        return 'Crumbles'
  if (/MASH/.test(n))           return 'Mash'
  if (/EXTRUDED|\bDRY\b/.test(n)) return 'Extruded'
  if (/GRAIN|CORN|SOYA|MAIZE/.test(n)) return 'Grains'
  if (/TERRINE|CHUNK|WET|GRAVY/.test(n)) return 'Wet Products'
  return 'Ready Mix'
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
          MONTH(T0.DocDate)                                                     AS month,
          YEAR(T0.DocDate)                                                      AS year,
          ISNULL(SUM(T1.Quantity), 0)                                           AS bags,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)        AS mt
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
        WHERE T0.CANCELED = 'N'
          AND YEAR(T0.DocDate) IN (@year, @cy)
          AND T1.ItemCode LIKE 'vpi%'
        GROUP BY T1.ItemCode, MONTH(T0.DocDate), YEAR(T0.DocDate)
      `, { year, cy: compareYear })
      queryMs = Date.now() - qStart
    }

    // ---- Pivot the rows into per-SKU monthly_bags_cy / monthly_mt_cy / ... ----
    const skuMap = {}   // item_code → { monthly_bags_cy:[12], monthly_bags_ly, monthly_mt_cy, monthly_mt_ly }
    rawByItemMonth.forEach(r => {
      const code = String(r.item_code).trim()
      if (!skuMap[code]) {
        skuMap[code] = {
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

    // ---- Build a SKU object merging hierarchy metadata + data ----
    function buildSku(code){
      const meta = hierarchy.skus[code] || { item_code: code, name: code, bag_size_kg: null, group: null, sub_group: null }
      const s    = skuMap[code] || {
        monthly_bags_cy: new Array(12).fill(0),
        monthly_bags_ly: new Array(12).fill(0),
        monthly_mt_cy:   new Array(12).fill(0),
        monthly_mt_ly:   new Array(12).fill(0)
      }
      const sum = arr => arr.reduce((a, b) => a + b, 0)
      const totalBagsCy = sum(s.monthly_bags_cy)
      const totalBagsLy = sum(s.monthly_bags_ly)
      const totalMtCy   = sum(s.monthly_mt_cy)
      const totalMtLy   = sum(s.monthly_mt_ly)
      const vs_ly_pct   = totalMtLy > 0 ? ((totalMtCy - totalMtLy) / totalMtLy) * 100 : null
      return {
        item_code:       code,
        name:            meta.name,
        bag_size_kg:     meta.bag_size_kg,
        group:           meta.group,
        sub_group:       meta.sub_group,
        form:            classifyForm(meta.name),
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

    // ---- Build groups using hierarchy.structure ----
    const groups = hierarchy.structure.map(g => {
      const groupObj = {
        name:  g.name,
        order: g.order,
        is_parent: !!g.is_parent,
        skus:  (g.skus || []).map(buildSku)
      }
      if (g.sub_groups && g.sub_groups.length){
        groupObj.sub_groups = g.sub_groups.map(sg => ({
          name: sg.name,
          skus: (sg.skus || []).map(buildSku)
        }))
      }
      return groupObj
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
