// GET /api/analytics/sku-matrix?unit=volume|revenue&region=ALL|Luzon|...&bu=ALL|DIST|KA|PET
//
// Returns the customer × brand-family heatmap that powers the SKU Penetration
// section of Customer Intelligence (Deeper Analytics block).
//
// Strategy:
//   1. Pull per-(customer, item) YTD aggregates from OINV+INV1 across both
//      Live and Old DBs (queryBoth) — historical rows are re-keyed via the
//      customer-map so they merge into current CardCode space.
//   2. In Node, classify each line into a brand family (api/lib/brand-family.js)
//      and aggregate by (CardCode, family).
//   3. Top 30 customers by YTD total (after region/BU filter) become rows.
//      All 16 families surface; UI shows top 15.
//   4. Whitespace callouts: for each family, find customers in the top-30 set
//      that don't buy it; estimate addressable upside using peer-average
//      volume × conservative 0.4 ramp factor × avg PHP/kg.
//
// CRITICAL: per Mat's rule, we do NOT exclude any CardCode (no isNonCustomerRow
// call). CCPC and similar codes are real customers — Joel needs to see them.

const { query, queryH } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { rekeyHistoricalRows } = require('./lib/customer-map')
const cache = require('../lib/cache')
const { classify, FAMILIES } = require('./lib/brand-family')

const REGION_CASE = `
  CASE
    WHEN T1.WhsCode IN ('AC','ACEXT','BAC')      THEN 'Luzon'
    WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE')  THEN 'Visayas'
    WHEN T1.WhsCode IN ('BUKID','CCPC')          THEN 'Mindanao'
    ELSE 'Other'
  END`

// SlpCodes assigned to Key Accounts (Vienovo-internal taxonomy):
//   2  MATHIEU GUILLAUME — National Direct/KA
//   7  CARMINDA CALDERON — Visayas KA
//   24 KA - NL           — KA national
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

  const unit   = (req.query.unit   === 'revenue') ? 'revenue' : 'volume'
  const region = (req.query.region || 'ALL').toString()
  const bu     = (req.query.bu     || 'ALL').toString().toUpperCase()

  const cacheKey = `analytics_sku_matrix_${unit}_${region}_${bu}_${session.role}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // Per-line aggregate (last 12 months, FG only). Returns one row per
    // (CardCode, item description). Both DBs unioned + re-keyed.
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

    // 12-month window crosses 2026-01-01 cutoff. Run on each pool explicitly
    // so we can re-key historical CardCodes (CL00xxx → CA000xxx) before merging.
    const [curRows, histRows] = await Promise.all([
      query(SQL).catch(e => { console.warn('[sku-matrix] current failed:', e.message); return [] }),
      queryH(SQL).catch(e => { console.warn('[sku-matrix] historical failed:', e.message); return [] })
    ])
    const histKeyed = await rekeyHistoricalRows(histRows, 'CardCode').catch(() => [])
    const merged = [...curRows, ...histKeyed]

    // Aggregate by (CardCode, family) — also collect per-family avg price PHP/kg
    const byCust = new Map()    // CardCode → { name, region (most-recent), totalsByFamily }
    const familyAggregate = new Map()  // family → { sumKg, sumRev, buyers:Set, sumVolMt }

    for (const r of merged) {
      const cc = r.CardCode
      if (!cc) continue
      const fam = classify(r.dscription)
      const vol = Number(r.vol_mt || 0)
      const rev = Number(r.revenue || 0)
      const kg  = Number(r.kg || 0)

      if (!byCust.has(cc)) {
        byCust.set(cc, {
          card_code: cc,
          name: r.CardName || cc,
          slp_code: r.slp_code || null,
          region: r.region || 'Other',
          regionVotes: { Luzon: 0, Visayas: 0, Mindanao: 0, Other: 0 },
          totalsByFamily: new Map(),
          ytd_volume: 0,
          ytd_revenue: 0
        })
      }
      const c = byCust.get(cc)
      c.regionVotes[r.region || 'Other'] = (c.regionVotes[r.region || 'Other'] || 0) + vol
      c.ytd_volume += vol
      c.ytd_revenue += rev
      const prev = c.totalsByFamily.get(fam) || { vol: 0, rev: 0, kg: 0 }
      c.totalsByFamily.set(fam, { vol: prev.vol + vol, rev: prev.rev + rev, kg: prev.kg + kg })

      const f = familyAggregate.get(fam) || { sumVol: 0, sumRev: 0, sumKg: 0, buyers: new Set() }
      f.sumVol += vol; f.sumRev += rev; f.sumKg += kg
      f.buyers.add(cc)
      familyAggregate.set(fam, f)
    }

    // Resolve dominant region per customer (highest vol across regions)
    for (const c of byCust.values()) {
      let best = 'Other', bestVol = -1
      for (const [reg, vol] of Object.entries(c.regionVotes)) {
        if (vol > bestVol) { best = reg; bestVol = vol }
      }
      c.region = best
      c.bu = buClassifier(c.name, c.slp_code)
    }

    // Apply region/BU filter, sort, top 30
    let customers = [...byCust.values()]
    if (region !== 'ALL') customers = customers.filter(c => c.region === region)
    if (bu     !== 'ALL') customers = customers.filter(c => c.bu === bu)
    customers.sort((a, b) =>
      (unit === 'revenue' ? b.ytd_revenue - a.ytd_revenue : b.ytd_volume - a.ytd_volume)
    )
    const top30 = customers.slice(0, 30)

    // Pick top brands within filtered set (rank by total volume across top30)
    const filteredFamilyTotals = new Map()
    for (const c of top30) {
      for (const [fam, t] of c.totalsByFamily.entries()) {
        const cur = filteredFamilyTotals.get(fam) || 0
        filteredFamilyTotals.set(fam, cur + (unit === 'revenue' ? t.rev : t.vol))
      }
    }
    const brandsRanked = [...filteredFamilyTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([fam]) => fam)
    const brands = brandsRanked.slice(0, 15)

    // Build matrix
    const matrix = {}
    for (const c of top30) {
      const row = {}
      for (const fam of brands) {
        const t = c.totalsByFamily.get(fam)
        row[fam] = t ? Math.round((unit === 'revenue' ? t.rev : t.vol) * 10) / 10 : 0
      }
      matrix[c.card_code] = row
    }

    // Whitespace callouts: for each brand, customers in top30 NOT buying it.
    // Conservative upside = peer-avg vol per buyer × 0.4 ramp × avg PHP/kg × 1000.
    const callouts = []
    for (const fam of brands) {
      const f = familyAggregate.get(fam) || { sumKg: 0, sumRev: 0, sumVol: 0, buyers: new Set() }
      const avgPriceKg = f.sumKg > 0 ? f.sumRev / f.sumKg : 0
      const avgVolPerBuyer = f.buyers.size > 0 ? f.sumVol / f.buyers.size : 0
      const missingTargets = top30
        .filter(c => !c.totalsByFamily.has(fam))
        .map(c => ({
          card_code: c.card_code,
          name: c.name,
          region: c.region,
          customer_size_factor: top30[0].ytd_volume > 0 ? c.ytd_volume / top30[0].ytd_volume : 0
        }))
      // Estimate per-target upside, then keep top 5 by upside
      const targetsScored = missingTargets.map(t => {
        const upside_mt = avgVolPerBuyer * Math.max(0.3, t.customer_size_factor) * 0.4
        const upside_php = upside_mt * 1000 * avgPriceKg
        return { ...t, upside_mt: Math.round(upside_mt * 10) / 10, upside_php: Math.round(upside_php) }
      }).sort((a, b) => b.upside_php - a.upside_php)
      const totalUpside = targetsScored.reduce((s, t) => s + t.upside_php, 0)

      callouts.push({
        brand: fam,
        customers_missing_count: missingTargets.length,
        peer_avg_volume_mt: Math.round(avgVolPerBuyer * 10) / 10,
        peer_avg_php_per_kg: Math.round(avgPriceKg * 100) / 100,
        est_upside_php_yearly: totalUpside,
        top_targets: targetsScored.slice(0, 5)
      })
    }
    callouts.sort((a, b) => b.est_upside_php_yearly - a.est_upside_php_yearly)
    const whitespace_callouts = callouts.slice(0, 3)

    const result = {
      meta: {
        unit, region, bu,
        period: 'Trailing 12 months',
        generated_at: new Date().toISOString(),
        total_customers_in_filter: customers.length
      },
      customers: top30.map(c => ({
        card_code: c.card_code,
        name: c.name,
        region: c.region,
        bu: c.bu,
        ytd_total: Math.round((unit === 'revenue' ? c.ytd_revenue : c.ytd_volume) * 10) / 10
      })),
      brands,
      matrix,
      whitespace_callouts,
      brand_stats: brands.map(fam => {
        const f = familyAggregate.get(fam)
        return {
          brand: fam,
          national_buyers: f ? f.buyers.size : 0,
          national_volume_mt: f ? Math.round(f.sumVol * 10) / 10 : 0,
          national_revenue: f ? Math.round(f.sumRev) : 0,
          avg_php_per_kg: f && f.sumKg > 0 ? Math.round(f.sumRev / f.sumKg * 100) / 100 : 0
        }
      })
    }

    cache.set(cacheKey, result, 1800)
    res.json(result)
  } catch (err) {
    console.error('API error [analytics/sku-matrix]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
