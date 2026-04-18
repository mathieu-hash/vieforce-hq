const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// --- Scoring helpers (deterministic, explainable) ---
function scoreRescue(ar_balance, days_silent) {
  // priority = (AR_millions) × log10(days_silent+1) × 10 · clamped 0–100
  const raw = (ar_balance / 1_000_000) * Math.log10((days_silent || 0) + 1) * 10
  return Math.max(0, Math.min(100, Math.round(raw)))
}
function scoreGrowth(upside_php_yearly) {
  // priority = log10(upside/100K) × 25 · clamped 0–100
  const raw = Math.log10(Math.max(1, upside_php_yearly / 100_000)) * 25
  return Math.max(0, Math.min(100, Math.round(raw)))
}
function scoreWarning(revenue_impact, change_pct) {
  // priority = (impact_millions × |Δ%|) / 5 · clamped 0–100
  const raw = (revenue_impact / 1_000_000) * Math.min(100, Math.abs(change_pct)) / 5
  return Math.max(0, Math.min(100, Math.round(raw)))
}

// Brand token = first two words of INV1.Dscription (e.g. "VIEPRO LAYER 1 Crumble" → "VIEPRO LAYER")
function extractBrandToken(dscription) {
  if (!dscription) return 'UNKNOWN'
  const parts = String(dscription).trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0] + ' ' + parts[1]).toUpperCase()
  return (parts[0] || 'UNKNOWN').toUpperCase()
}

function fmtPhpShort(n) {
  if (!n) return '₱0'
  const a = Math.abs(n)
  if (a >= 1e6) return '₱' + (n / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return '₱' + Math.round(n / 1e3) + 'K'
  return '₱' + Math.round(n)
}

function tierOf(c) {
  // Volume tier = average monthly MT over last 90 days (or lifetime if no recent vol)
  const monthly = c.vol_90d_mt > 0 ? c.vol_90d_mt / 3 : (c.vol_36m_mt || 0) / 36
  if (monthly < 50) return 'Small'
  if (monthly < 200) return 'Medium'
  return 'Large'
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `intelligence_v2_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // ============== QUERY 1: per-customer activity (36mo window) ==============
    const actBase = await query(`
      SELECT
        T0.CardCode,
        MAX(T0.CardName)                                                          AS CardName,
        MAX(OC.frozenFor)                                                         AS frozen_for,
        MAX(OC.U_BpStatus)                                                        AS bp_status,
        MAX(T0.DocDate)                                                           AS last_order_date,
        DATEDIFF(DAY, MAX(T0.DocDate), GETDATE())                                 AS days_silent,
        COUNT(DISTINCT T0.DocEntry)                                               AS order_count,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)              AS vol_36m_mt,
        ISNULL(SUM(T1.LineTotal), 0)                                              AS rev_36m,
        ISNULL(SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-30,GETDATE())
            THEN T1.Quantity * ISNULL(I.NumInSale,1) ELSE 0 END) / 1000.0, 0)      AS vol_30d_mt,
        ISNULL(SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-90,GETDATE())
            THEN T1.Quantity * ISNULL(I.NumInSale,1) ELSE 0 END) / 1000.0, 0)      AS vol_90d_mt,
        ISNULL(SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-30,GETDATE())
            THEN T1.LineTotal ELSE 0 END), 0)                                      AS rev_30d,
        ISNULL(SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-90,GETDATE())
            THEN T1.LineTotal ELSE 0 END), 0)                                      AS rev_90d
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
      LEFT JOIN OCRD OC  ON T0.CardCode = OC.CardCode
      WHERE T0.DocDate >= DATEADD(MONTH, -36, GETDATE())
        AND T0.CANCELED = 'N'
      GROUP BY T0.CardCode
    `)

    // ============== QUERY 2: last-order details (date, amount, sales rep) ==============
    const lastOrderDetail = await query(`
      WITH Ranked AS (
        SELECT
          T0.CardCode,
          T0.DocDate,
          T0.DocEntry,
          T0.DocTotal,
          S.SlpName,
          ROW_NUMBER() OVER (
            PARTITION BY T0.CardCode
            ORDER BY T0.DocDate DESC, T0.DocEntry DESC
          ) AS rn
        FROM OINV T0
        LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
        WHERE T0.DocDate >= DATEADD(MONTH, -36, GETDATE())
          AND T0.CANCELED = 'N'
      )
      SELECT CardCode, DocDate AS last_order_date, DocTotal AS last_order_amount, SlpName AS sales_rep
      FROM Ranked
      WHERE rn = 1
    `)

    // ============== QUERY 3: dominant region per customer (last 12mo) ==============
    const regionsRaw = await query(`
      WITH RegAgg AS (
        SELECT
          T0.CardCode,
          CASE
            WHEN T1.WhsCode IN ('AC','ACEXT','BAC')      THEN 'Luzon'
            WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE')  THEN 'Visayas'
            WHEN T1.WhsCode IN ('BUKID','CCPC')          THEN 'Mindanao'
            ELSE 'Other'
          END AS region,
          SUM(T1.LineTotal) AS region_rev
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        WHERE T0.DocDate >= DATEADD(MONTH, -12, GETDATE())
          AND T0.CANCELED = 'N'
        GROUP BY
          T0.CardCode,
          CASE
            WHEN T1.WhsCode IN ('AC','ACEXT','BAC')      THEN 'Luzon'
            WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE')  THEN 'Visayas'
            WHEN T1.WhsCode IN ('BUKID','CCPC')          THEN 'Mindanao'
            ELSE 'Other'
          END
      ),
      Ranked AS (
        SELECT CardCode, region,
               ROW_NUMBER() OVER (PARTITION BY CardCode ORDER BY region_rev DESC) AS rn
        FROM RegAgg
      )
      SELECT CardCode, region FROM Ranked WHERE rn = 1
    `)

    // ============== QUERY 4: open-AR balance per customer (any age) ==============
    const arRows = await query(`
      SELECT T0.CardCode, SUM(T0.DocTotal - T0.PaidToDate) AS ar_balance
      FROM OINV T0
      WHERE T0.CANCELED = 'N'
        AND (T0.DocTotal - T0.PaidToDate) > 0.01
      GROUP BY T0.CardCode
    `)

    // ============== QUERY 5: per-customer × per-SKU basket (12mo), brand-token built in JS ==============
    const brandBasket = await query(`
      SELECT
        T0.CardCode,
        T1.Dscription                                                AS dscription,
        SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0            AS vol_mt,
        SUM(T1.LineTotal)                                            AS revenue,
        SUM(T1.Quantity * ISNULL(I.NumInSale,1))                     AS kg
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(MONTH, -12, GETDATE())
        AND T0.CANCELED = 'N'
      GROUP BY T0.CardCode, T1.Dscription
    `)

    // ============== Build customer map ==============
    const regionMap = new Map(regionsRaw.map(r => [r.CardCode, r.region]))
    const arMap     = new Map(arRows.map(r => [r.CardCode, Number(r.ar_balance || 0)]))
    const lastMap   = new Map(lastOrderDetail.map(r => [r.CardCode, r]))

    const custMap = new Map()
    for (const row of actBase) {
      const cc = row.CardCode
      const last = lastMap.get(cc) || {}
      custMap.set(cc, {
        card_code:         cc,
        name:              row.CardName,
        frozen_for:        row.frozen_for || 'N',
        bp_status:         row.bp_status || '',
        region:            regionMap.get(cc) || 'Other',
        sales_rep:         last.sales_rep || '',
        ar_balance:        arMap.get(cc) || 0,
        last_order_date:   last.last_order_date || row.last_order_date,
        last_order_amount: Number(last.last_order_amount || 0),
        days_silent:       Number(row.days_silent || 0),
        order_count:       Number(row.order_count || 0),
        vol_36m_mt:        Number(row.vol_36m_mt || 0),
        rev_36m:           Number(row.rev_36m || 0),
        vol_30d_mt:        Number(row.vol_30d_mt || 0),
        vol_90d_mt:        Number(row.vol_90d_mt || 0),
        rev_30d:           Number(row.rev_30d || 0),
        rev_90d:           Number(row.rev_90d || 0)
      })
    }

    // Include customers with open AR but no OINV in 36mo (orphaned dormant balances)
    for (const [cc, arbal] of arMap.entries()) {
      if (custMap.has(cc)) continue
      custMap.set(cc, {
        card_code: cc, name: '(unknown)', frozen_for: 'N', bp_status: '',
        region: 'Other', sales_rep: '', ar_balance: arbal,
        last_order_date: null, last_order_amount: 0,
        days_silent: 9999, order_count: 0,
        vol_36m_mt: 0, rev_36m: 0,
        vol_30d_mt: 0, vol_90d_mt: 0, rev_30d: 0, rev_90d: 0
      })
    }

    // Backfill names for AR-only orphans
    const unknowns = [...custMap.values()].filter(c => c.name === '(unknown)').map(c => c.card_code)
    for (let i = 0; i < unknowns.length; i += 100) {
      const chunk = unknowns.slice(i, i + 100)
      const params = {}
      chunk.forEach((cc, j) => { params['uc' + j] = cc })
      const placeholders = chunk.map((_, j) => '@uc' + j).join(',')
      const rows = await query(
        `SELECT CardCode, CardName, frozenFor, U_BpStatus FROM OCRD WHERE CardCode IN (${placeholders})`,
        params
      ).catch(() => [])
      for (const r of rows) {
        const c = custMap.get(r.CardCode)
        if (!c) continue
        c.name = r.CardName || r.CardCode
        c.frozen_for = r.frozenFor || 'N'
        c.bp_status = r.U_BpStatus || ''
      }
    }

    const allCustomers = [...custMap.values()]

    // ============== LIST 1 — TOP RESCUE ==============
    // Active (not frozen/delinquent), AR > 0, silent 30–90 days.
    const rescueAll = allCustomers
      .filter(c => {
        if (c.frozen_for === 'Y') return false
        if (c.bp_status === 'Delinquent' || c.bp_status === 'InActive') return false
        if (c.ar_balance <= 0) return false
        if (c.days_silent < 30 || c.days_silent > 90) return false
        return true
      })
      .map(c => {
        const priority_score = scoreRescue(c.ar_balance, c.days_silent)
        const reason = `Silent ${c.days_silent}d + ${fmtPhpShort(c.ar_balance)} AR`
        let suggested_action
        if      (priority_score >= 80) suggested_action = 'Personal call by RSM this week'
        else if (priority_score >= 50) suggested_action = 'Phone follow-up within 3 days'
        else                           suggested_action = 'SMS/email check-in'
        return {
          card_code:          c.card_code,
          name:               c.name,
          region:             c.region,
          sales_rep:          c.sales_rep,
          ar_balance:         Math.round(c.ar_balance),
          last_order_date:    c.last_order_date,
          last_order_amount:  Math.round(c.last_order_amount),
          days_silent:        c.days_silent,
          reason,
          priority_score,
          suggested_action
        }
      })
      .sort((a, b) => b.priority_score - a.priority_score)
    const top_rescue = rescueAll.slice(0, 15)

    // ============== LIST 2 — TOP GROWTH (peer-driven cross-sell) ==============
    // Build per-customer brand basket from SKU aggregate
    const custBrand = new Map()  // cc → Map(brand → {vol_mt, revenue, kg})
    for (const row of brandBasket) {
      const cc = row.CardCode
      const brand = extractBrandToken(row.dscription)
      if (!custBrand.has(cc)) custBrand.set(cc, new Map())
      const bm = custBrand.get(cc)
      const prev = bm.get(brand) || { vol_mt: 0, revenue: 0, kg: 0 }
      bm.set(brand, {
        vol_mt:  prev.vol_mt  + Number(row.vol_mt  || 0),
        revenue: prev.revenue + Number(row.revenue || 0),
        kg:      prev.kg      + Number(row.kg      || 0)
      })
    }

    // Peer groups keyed by region|tier; members = active customers (silent < 90d, not frozen)
    const peerGroups = new Map()
    for (const c of allCustomers) {
      if (c.days_silent >= 90) continue
      if (c.frozen_for === 'Y') continue
      const key = `${c.region}|${tierOf(c)}`
      if (!peerGroups.has(key)) peerGroups.set(key, { members: [], brandStats: new Map() })
      peerGroups.get(key).members.push(c.card_code)
    }

    // Aggregate brand stats within each peer group
    for (const [, group] of peerGroups.entries()) {
      const raw = new Map()
      for (const cc of group.members) {
        const basket = custBrand.get(cc)
        if (!basket) continue
        for (const [brand, st] of basket.entries()) {
          const cur = raw.get(brand) || { buyers: 0, vol_mt: 0, revenue: 0, kg: 0 }
          cur.buyers  += 1
          cur.vol_mt  += st.vol_mt
          cur.revenue += st.revenue
          cur.kg      += st.kg
          raw.set(brand, cur)
        }
      }
      const size = group.members.length
      const final = new Map()
      for (const [brand, s] of raw.entries()) {
        final.set(brand, {
          penetration:          size > 0 ? s.buyers / size : 0,
          avg_vol_mt:           s.buyers > 0 ? s.vol_mt / s.buyers : 0,
          avg_price_php_per_kg: s.kg > 0 ? s.revenue / s.kg : 0,
          buyers:               s.buyers,
          group_size:           size
        })
      }
      group.brandStats = final
    }

    // For each active customer, pick the single best missing brand (highest PHP upside)
    const growthAll = []
    for (const c of allCustomers) {
      if (c.days_silent >= 90) continue
      if (c.frozen_for === 'Y') continue
      const tier = tierOf(c)
      const group = peerGroups.get(`${c.region}|${tier}`)
      if (!group || group.members.length < 5) continue   // peer group too small for signal
      const basket = custBrand.get(c.card_code) || new Map()
      const currentBrands = [...basket.keys()].sort()

      let best = null
      for (const [brand, stats] of group.brandStats.entries()) {
        if (basket.has(brand)) continue
        if (stats.penetration < 0.70) continue
        const upside_mt_yearly  = stats.avg_vol_mt * 0.6
        const upside_php_yearly = upside_mt_yearly * 1000 * stats.avg_price_php_per_kg
        if (!best || upside_php_yearly > best.upside_php_yearly) {
          best = {
            brand,
            peer_avg_volume_mt:  Math.round(stats.avg_vol_mt * 10) / 10,
            peer_penetration:    Math.round(stats.penetration * 100),
            upside_mt_yearly:    Math.round(upside_mt_yearly),
            upside_php_yearly:   Math.round(upside_php_yearly),
            peer_group_size:     stats.group_size
          }
        }
      }
      if (!best || best.upside_php_yearly < 50000) continue   // skip trivial
      const priority_score = scoreGrowth(best.upside_php_yearly)
      growthAll.push({
        card_code:                 c.card_code,
        name:                      c.name,
        region:                    c.region,
        sales_rep:                 c.sales_rep,
        current_volume_ytd_mt:     Math.round(c.vol_90d_mt * 4 * 10) / 10,  // 90d annualised
        current_brands:            currentBrands,
        missing_brands:            [best.brand],
        peer_avg_volume_mt:        best.peer_avg_volume_mt,
        upside_mt_yearly:          best.upside_mt_yearly,
        upside_php_yearly:         best.upside_php_yearly,
        cross_sell_recommendation: best.brand,
        reason:                    `${best.peer_penetration}% of ${c.region} ${tier} peers buy ${best.brand}`,
        priority_score,
        suggested_action:          `Pitch ${best.brand} trial order at next visit`
      })
    }
    growthAll.sort((a, b) => b.upside_php_yearly - a.upside_php_yearly)
    const top_growth = growthAll.slice(0, 15)

    // ============== LIST 3 — EARLY WARNING ==============
    // Active (< 30d silent), vol_30d < 70% of (vol_90d/3), meaningful size.
    const warningAll = []
    for (const c of allCustomers) {
      if (c.days_silent >= 30) continue
      if (c.frozen_for === 'Y') continue
      if (c.vol_90d_mt <= 5) continue
      const avg_30d_from_90d = c.vol_90d_mt / 3
      if (avg_30d_from_90d <= 0) continue
      const change_pct = ((c.vol_30d_mt - avg_30d_from_90d) / avg_30d_from_90d) * 100
      if (change_pct >= -30) continue

      const monthly_gap = avg_30d_from_90d - c.vol_30d_mt
      // php per MT from trailing 90d revenue ÷ 90d volume (MT)
      const php_per_mt = c.vol_90d_mt > 0 ? c.rev_90d / c.vol_90d_mt : 0
      const revenue_impact_php_yearly = Math.max(0, Math.round(monthly_gap * 12 * php_per_mt))
      if (revenue_impact_php_yearly < 50000) continue

      const priority_score = scoreWarning(revenue_impact_php_yearly, change_pct)
      warningAll.push({
        card_code:                  c.card_code,
        name:                       c.name,
        region:                     c.region,
        sales_rep:                  c.sales_rep,
        avg_90d_mt:                 Math.round(avg_30d_from_90d * 10) / 10,
        last_30d_mt:                Math.round(c.vol_30d_mt * 10) / 10,
        change_pct:                 Math.round(change_pct),
        revenue_impact_php_yearly,
        reason:                     `Volume down ${Math.round(Math.abs(change_pct))}% in last 30d vs 90d avg`,
        priority_score,
        suggested_action:           priority_score >= 70
          ? 'Schedule visit within 1 week'
          : 'Schedule check-in within 2 weeks'
      })
    }
    warningAll.sort((a, b) => b.revenue_impact_php_yearly - a.revenue_impact_php_yearly)
    const early_warning = warningAll.slice(0, 15)

    // ============== LIST 4 — DORMANT ==============
    const dormantAll = allCustomers.filter(c => c.days_silent >= 60)
    const dormant_count = dormantAll.length
    const historical_ar_amt = Math.round(dormantAll.reduce((s, c) => s + c.ar_balance, 0))
    const lifetime_volume_mt = Math.round(dormantAll.reduce((s, c) => s + c.vol_36m_mt, 0) * 10) / 10
    const avg_dormancy_days = dormant_count > 0
      ? Math.round(dormantAll.reduce((s, c) => s + c.days_silent, 0) / dormant_count)
      : 0

    const by_region = { Luzon: 0, Visayas: 0, Mindanao: 0, Other: 0 }
    for (const c of dormantAll) by_region[c.region] = (by_region[c.region] || 0) + 1

    const by_last_active_year = {}
    for (const c of dormantAll) {
      if (!c.last_order_date) continue
      const y = new Date(c.last_order_date).getFullYear().toString()
      by_last_active_year[y] = (by_last_active_year[y] || 0) + 1
    }

    const dormant_list = dormantAll
      .slice()
      .sort((a, b) => (b.ar_balance - a.ar_balance) || (b.vol_36m_mt - a.vol_36m_mt))
      .slice(0, 50)
      .map(c => ({
        card_code:          c.card_code,
        name:               c.name,
        region:             c.region,
        sales_rep:          c.sales_rep,
        last_order_date:    c.last_order_date,
        days_dormant:       c.days_silent,
        historical_ar:      Math.round(c.ar_balance),
        lifetime_volume_mt: Math.round(c.vol_36m_mt * 10) / 10
      }))

    // ============== HERO STATS ==============
    const hero_stats = {
      rescue_at_risk_amt:         Math.round(top_rescue.reduce((s, r) => s + r.ar_balance, 0)),
      rescue_count:               top_rescue.length,
      growth_upside_amt:          Math.round(top_growth.reduce((s, g) => s + g.upside_php_yearly, 0)),
      growth_count:               top_growth.length,
      early_warning_amt:          Math.round(early_warning.reduce((s, w) => s + w.revenue_impact_php_yearly, 0)),
      early_warning_count:        early_warning.length,
      dormant_count,
      dormant_historical_ar_amt:  historical_ar_amt
    }

    const result = {
      hero_stats,
      top_rescue,
      top_growth,
      early_warning,
      dormant_summary: {
        customer_count:       dormant_count,
        historical_ar_amt,
        lifetime_volume_mt,
        avg_dormancy_days,
        by_region,
        by_last_active_year
      },
      dormant_list,
      meta: {
        total_customers_analyzed: allCustomers.length,
        rescue_pool_size:         rescueAll.length,
        growth_pool_size:         growthAll.length,
        warning_pool_size:        warningAll.length,
        dormant_pool_size:        dormantAll.length,
        generated_at:             new Date().toISOString()
      }
    }

    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [intelligence]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}

// Acknowledge unused imports for future role-based filtering
void applyRoleFilter
