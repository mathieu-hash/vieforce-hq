// GET /api/analytics/brand-coverage
//
// National vs regional vs BU brand-mix analysis. Powers the "Brand Coverage
// Gaps" section of Customer Intelligence.
//
// Returns:
//   national_mix: { brand → % of national volume }
//   by_region:    { Luzon: { brand → % }, Visayas:..., Mindanao:..., Other:... }
//   gap_analysis: rows where (region_pct − national_pct) crosses ±5 pp
//   by_bu:        avg distinct brands per customer per BU
//   insight_callouts: top 3 biggest under-representations with targetable customers
//
// CRITICAL: no customer exclusion. CCPC included.

const { query, queryH } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { rekeyHistoricalRows } = require('./lib/customer-map')
const cache = require('../lib/cache')
const { classify, FAMILIES } = require('./lib/brand-family')

const REGIONS = ['Luzon', 'Visayas', 'Mindanao', 'Other']
const REGION_CASE = `
  CASE
    WHEN T1.WhsCode IN ('AC','ACEXT','BAC')      THEN 'Luzon'
    WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE')  THEN 'Visayas'
    WHEN T1.WhsCode IN ('BUKID','CCPC')          THEN 'Mindanao'
    ELSE 'Other'
  END`

// Same KA SlpCode set as analytics-sku-matrix
const KA_SLPCODES = new Set([2, 7, 24])

function buClassifier(name, slpCode) {
  const n = String(name || '').toUpperCase()
  if (n.includes('PET') || n.includes('KEOS') || n.includes('NOVOPET')) return 'PET'
  if (slpCode != null && KA_SLPCODES.has(Number(slpCode))) return 'KA'
  if (n.includes(' KA ') || n.startsWith('KA ') || n.endsWith(' KA')) return 'KA'
  return 'DIST'
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `analytics_brand_coverage_${session.role}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // Per-line aggregate by (Customer, Item, Region) — last 12 months, FG only.
    const SQL = `
      SELECT
        T0.CardCode,
        MAX(T0.CardName)                                                AS CardName,
        MAX(T0.SlpCode)                                                 AS slp_code,
        T1.Dscription                                                   AS dscription,
        ${REGION_CASE}                                                   AS region,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS vol_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)), 0)            AS kg
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      INNER JOIN OITM I  ON I.ItemCode = T1.ItemCode
      WHERE T0.CANCELED = 'N'
        AND UPPER(T1.ItemCode) LIKE 'FG%'
        AND T0.DocDate >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY T0.CardCode, T1.Dscription, ${REGION_CASE}
    `

    const [curRows, histRows] = await Promise.all([
      query(SQL).catch(() => []),
      queryH(SQL).catch(() => [])
    ])
    const histKeyed = await rekeyHistoricalRows(histRows, 'CardCode').catch(() => [])
    const merged = [...curRows, ...histKeyed]

    // Aggregations
    const national = new Map()                                 // family → vol
    const byRegion = Object.fromEntries(REGIONS.map(r => [r, new Map()]))  // region → family → vol
    const byRegionTotal = Object.fromEntries(REGIONS.map(r => [r, 0]))
    let nationalTotal = 0
    const familyKgRev = new Map()                              // family → { kg, rev, buyers:Set }

    // Per-customer brand sets (for BU stats + targetable lists)
    const custMeta = new Map()
    const custBrands = new Map()                               // CardCode → Set of families
    const custVol = new Map()                                  // CardCode → vol total

    for (const r of merged) {
      const cc = r.CardCode
      if (!cc) continue
      const fam = classify(r.dscription)
      const reg = REGIONS.includes(r.region) ? r.region : 'Other'
      const vol = Number(r.vol_mt || 0)
      const rev = Number(r.revenue || 0)
      const kg  = Number(r.kg || 0)

      national.set(fam, (national.get(fam) || 0) + vol)
      byRegion[reg].set(fam, (byRegion[reg].get(fam) || 0) + vol)
      byRegionTotal[reg] += vol
      nationalTotal += vol

      const fk = familyKgRev.get(fam) || { kg: 0, rev: 0, buyers: new Set() }
      fk.kg += kg; fk.rev += rev; fk.buyers.add(cc)
      familyKgRev.set(fam, fk)

      if (!custMeta.has(cc)) custMeta.set(cc, { name: r.CardName || cc, slp_code: r.slp_code || null, region: reg })
      else {
        // Track most-recent region (last seen wins; could be improved but adequate)
        const m = custMeta.get(cc)
        if (vol > 0) m.region = reg
        if (r.slp_code != null && m.slp_code == null) m.slp_code = r.slp_code
      }

      if (!custBrands.has(cc)) custBrands.set(cc, new Set())
      custBrands.get(cc).add(fam)
      custVol.set(cc, (custVol.get(cc) || 0) + vol)
    }

    // Choose top 13 brands for the analysis (+ 'OTHER' bucket)
    const sortedBrands = [...national.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
    const TOP_BRANDS = sortedBrands.slice(0, 13)

    function pct(num, den) {
      if (!den || den <= 0) return 0
      return Math.round((num / den) * 1000) / 10
    }

    const national_mix = {}
    for (const fam of TOP_BRANDS) {
      national_mix[fam] = pct(national.get(fam) || 0, nationalTotal)
    }

    const region_mix = {}
    for (const reg of REGIONS) {
      region_mix[reg] = {}
      for (const fam of TOP_BRANDS) {
        region_mix[reg][fam] = pct(byRegion[reg].get(fam) || 0, byRegionTotal[reg])
      }
    }

    // Gap analysis: brand × region rows with gap_pp from national
    const gap_analysis = []
    for (const fam of TOP_BRANDS) {
      const natPct = national_mix[fam]
      for (const reg of REGIONS) {
        const regPct = region_mix[reg][fam]
        const gap_pp = Math.round((regPct - natPct) * 10) / 10
        // Estimate upside if region matched national: missing % × region total × avg PHP/MT
        const fk = familyKgRev.get(fam) || { kg: 0, rev: 0 }
        const avgPhpPerMt = fk.kg > 0 ? (fk.rev / fk.kg) * 1000 : 0
        const upsideMt = gap_pp < 0 ? Math.abs(gap_pp) / 100 * byRegionTotal[reg] : 0
        const upside_php_yearly = Math.round(upsideMt * avgPhpPerMt)

        gap_analysis.push({
          brand: fam,
          region: reg,
          national_pct: natPct,
          region_pct: regPct,
          gap_pp,
          status: gap_pp <= -5 ? 'under' : gap_pp >= 5 ? 'over' : 'aligned',
          upside_mt_yearly: Math.round(upsideMt * 10) / 10,
          upside_php_yearly
        })
      }
    }

    // BU stats: avg distinct brands per customer
    const buGroups = { DIST: [], KA: [], PET: [] }
    for (const [cc, brands] of custBrands.entries()) {
      const meta = custMeta.get(cc) || {}
      const bu = buClassifier(meta.name, meta.slp_code)
      if (buGroups[bu]) buGroups[bu].push(brands.size)
    }
    const by_bu = {}
    for (const [bu, sizes] of Object.entries(buGroups)) {
      const customers = sizes.length
      const avg_brands = customers > 0
        ? Math.round((sizes.reduce((s, n) => s + n, 0) / customers) * 10) / 10
        : 0
      by_bu[bu] = { customers, avg_brands_per_customer: avg_brands }
    }

    // Insight callouts: top 3 biggest under-representations
    const undergaps = gap_analysis
      .filter(g => g.status === 'under' && g.upside_php_yearly > 0)
      .sort((a, b) => b.upside_php_yearly - a.upside_php_yearly)

    function topTargetableCustomersFor(brand, region, n = 5) {
      // Customers in region NOT buying brand, ranked by their YTD volume
      const targets = []
      for (const [cc, brands] of custBrands.entries()) {
        const meta = custMeta.get(cc)
        if (!meta || meta.region !== region) continue
        if (brands.has(brand)) continue
        targets.push({ card_code: cc, name: meta.name, ytd_volume_mt: Math.round((custVol.get(cc) || 0) * 10) / 10 })
      }
      targets.sort((a, b) => b.ytd_volume_mt - a.ytd_volume_mt)
      return targets.slice(0, n)
    }

    const insight_callouts = undergaps.slice(0, 3).map(g => ({
      brand: g.brand,
      region: g.region,
      national_pct: g.national_pct,
      region_pct: g.region_pct,
      gap_pp: g.gap_pp,
      upside_php_yearly: g.upside_php_yearly,
      upside_mt_yearly: g.upside_mt_yearly,
      targetable_customers: topTargetableCustomersFor(g.brand, g.region, 5)
    }))

    const result = {
      meta: {
        period: 'Trailing 12 months',
        national_volume_mt: Math.round(nationalTotal * 10) / 10,
        brands_analyzed: TOP_BRANDS,
        generated_at: new Date().toISOString()
      },
      national_mix,
      by_region: region_mix,
      region_totals_mt: Object.fromEntries(REGIONS.map(r => [r, Math.round(byRegionTotal[r] * 10) / 10])),
      gap_analysis,
      by_bu,
      insight_callouts
    }

    cache.set(cacheKey, result, 1800)
    res.json(result)
  } catch (err) {
    console.error('API error [analytics/brand-coverage]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
