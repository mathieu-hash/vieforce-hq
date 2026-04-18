const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')
const { isNonCustomer, isNonCustomerRow, excludeNonCustomers } = require('./lib/non-customer-codes')
const { getActiveSilences, buildSilenceIndex, applySilenceFilter } = require('./lib/silence')

// --- Scoring helpers (deterministic, explainable) ---
function scoreRescue(ar_balance, days_silent) {
  const raw = (ar_balance / 1_000_000) * Math.log10((days_silent || 0) + 1) * 10
  return Math.max(0, Math.min(100, Math.round(raw)))
}
function scoreGrowth(upside_php_yearly) {
  const raw = Math.log10(Math.max(1, upside_php_yearly / 100_000)) * 25
  return Math.max(0, Math.min(100, Math.round(raw)))
}
function scoreWarning(revenue_impact, change_pct) {
  const raw = (revenue_impact / 1_000_000) * Math.min(100, Math.abs(change_pct)) / 5
  return Math.max(0, Math.min(100, Math.round(raw)))
}

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

  // Cache key includes userId so silences are user-scoped.
  const cacheKey = `intelligence_v3_${session.id}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // Pull user's active silences up-front (Supabase; independent of SAP)
    const silences  = await getActiveSilences(session.id)
    const silenceIdx = buildSilenceIndex(silences)

    // ============== Q1: per-customer activity (36mo) + 2024+ flag =========
    const actBase = await query(`
      SELECT
        T0.CardCode,
        MAX(T0.CardName)                                                          AS CardName,
        MAX(OC.frozenFor)                                                         AS frozen_for,
        MAX(OC.U_BpStatus)                                                        AS bp_status,
        MAX(T0.DocDate)                                                           AS last_order_date,
        DATEDIFF(DAY, MAX(T0.DocDate), GETDATE())                                 AS days_silent,
        COUNT(DISTINCT T0.DocEntry)                                               AS order_count,
        SUM(CASE WHEN T0.DocDate >= '2024-01-01' THEN 1 ELSE 0 END)              AS orders_since_2024,
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

    // ============== Q2: last-order details ==============
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

    // ============== Q3: dominant region (last 12mo) ==============
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

    // ============== Q4: open-AR per customer (any age) ==============
    const arRows = await query(`
      SELECT T0.CardCode, SUM(T0.DocTotal - T0.PaidToDate) AS ar_balance
      FROM OINV T0
      WHERE T0.CANCELED = 'N'
        AND (T0.DocTotal - T0.PaidToDate) > 0.01
      GROUP BY T0.CardCode
    `)

    // ============== Q5: brand basket (12mo) ==============
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

    // ============== Q6: last invoice date (full OINV history, any age) ========
    // Catches pre-2023 OINV rows for legacy-AR classification (e.g. opening balances)
    const arLastInv = await query(`
      SELECT T0.CardCode,
             MAX(T0.DocDate) AS last_inv_date,
             SUM(CASE WHEN T0.DocDate >= '2024-01-01' THEN 1 ELSE 0 END) AS orders_since_2024_full
      FROM OINV T0
      WHERE T0.CANCELED = 'N'
      GROUP BY T0.CardCode
    `)

    // Build customer map
    const regionMap       = new Map(regionsRaw.map(r => [r.CardCode, r.region]))
    const arMap           = new Map(arRows.map(r => [r.CardCode, Number(r.ar_balance || 0)]))
    const lastMap         = new Map(lastOrderDetail.map(r => [r.CardCode, r]))
    const arLastInvMap    = new Map(arLastInv.map(r => [r.CardCode, { last_inv_date: r.last_inv_date, orders_since_2024_full: Number(r.orders_since_2024_full || 0) }]))

    const custMap = new Map()
    for (const row of actBase) {
      const cc = row.CardCode
      if (isNonCustomerRow(cc, row.CardName)) continue    // Part A: plant codes + plant-named customers out
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
        orders_since_2024: Number(row.orders_since_2024 || 0),
        vol_36m_mt:        Number(row.vol_36m_mt || 0),
        rev_36m:           Number(row.rev_36m || 0),
        vol_30d_mt:        Number(row.vol_30d_mt || 0),
        vol_90d_mt:        Number(row.vol_90d_mt || 0),
        rev_30d:           Number(row.rev_30d || 0),
        rev_90d:           Number(row.rev_90d || 0)
      })
    }

    // AR-only orphans (balances but no OINV in 36mo scan window)
    for (const [cc, arbal] of arMap.entries()) {
      if (isNonCustomer(cc)) continue
      if (custMap.has(cc)) continue
      const arLast = arLastInvMap.get(cc) || {}
      custMap.set(cc, {
        card_code: cc, name: '(unknown)', frozen_for: 'N', bp_status: '',
        region: 'Other', sales_rep: '', ar_balance: arbal,
        last_order_date: arLast.last_inv_date || null, last_order_amount: 0,
        days_silent: 9999, order_count: 0,
        orders_since_2024: arLast.orders_since_2024_full || 0,
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

    // Secondary pass: now that names are populated, drop any plant-named rows
    for (const [cc, c] of custMap.entries()) {
      if (isNonCustomerRow(cc, c.name)) custMap.delete(cc)
    }

    const allCustomers = [...custMap.values()]

    // ============== LIST 1 — TOP RESCUE ==============
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
    const rescueFiltered = applySilenceFilter(rescueAll, 'rescue', silenceIdx, r => r.card_code)
    const top_rescue = rescueFiltered.kept.slice(0, 15)

    // ============== LIST 2 — GROWTH (peer-driven) ==============
    const custBrand = new Map()
    for (const row of brandBasket) {
      const cc = row.CardCode
      if (isNonCustomer(cc)) continue
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

    const peerGroups = new Map()
    for (const c of allCustomers) {
      if (c.days_silent >= 90) continue
      if (c.frozen_for === 'Y') continue
      const key = `${c.region}|${tierOf(c)}`
      if (!peerGroups.has(key)) peerGroups.set(key, { members: [], brandStats: new Map() })
      peerGroups.get(key).members.push(c.card_code)
    }

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

    const growthAll = []
    for (const c of allCustomers) {
      if (c.days_silent >= 90) continue
      if (c.frozen_for === 'Y') continue
      const tier = tierOf(c)
      const group = peerGroups.get(`${c.region}|${tier}`)
      if (!group || group.members.length < 5) continue
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
      if (!best || best.upside_php_yearly < 50000) continue
      const priority_score = scoreGrowth(best.upside_php_yearly)
      growthAll.push({
        card_code:                 c.card_code,
        name:                      c.name,
        region:                    c.region,
        sales_rep:                 c.sales_rep,
        current_volume_ytd_mt:     Math.round(c.vol_90d_mt * 4 * 10) / 10,
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
    const growthFiltered = applySilenceFilter(growthAll, 'grow', silenceIdx, r => r.card_code)
    const top_growth = growthFiltered.kept.slice(0, 15)

    // ============== LIST 3 — EARLY WARNING ==============
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
    const warningFiltered = applySilenceFilter(warningAll, 'warning', silenceIdx, r => r.card_code)
    const early_warning = warningFiltered.kept.slice(0, 15)

    // ============== LISTS 4/5 — DORMANT ACTIVE vs LEGACY AR ==============
    // Split criteria (refined from Mat 2026-04-18 brief — SAP migrates OB as
    // ordinary OINV with 2024+ DocDate, so strict "zero OINV since 2024" under-
    // counts. We classify single-invoice + long-silent as legacy too.):
    //
    //   legacy_ar:       ar_balance > 0 AND (
    //                      orders_since_2024 == 0
    //                      OR (orders_since_2024 == 1 AND days_silent >= 90)
    //                    )   — no real activity → Finance reconciliation
    //   dormant_active:  days_silent >= 60 AND orders_since_2024 > 0
    //                    AND NOT legacy                 — winback target
    //
    // Buckets are mutually exclusive (legacy takes priority on overlap).
    const legacyArAll = allCustomers.filter(c => {
      if (c.ar_balance <= 0) return false
      if (c.orders_since_2024 === 0) return true
      if (c.orders_since_2024 <= 1 && c.days_silent >= 90) return true
      return false
    })
    const legacySet = new Set(legacyArAll.map(c => c.card_code))
    const dormantActiveAll = allCustomers.filter(c =>
      c.days_silent >= 60 && c.orders_since_2024 > 0 && !legacySet.has(c.card_code)
    )

    // Summary for dormant_active
    const dormant_active_count       = dormantActiveAll.length
    const dormant_active_ar          = Math.round(dormantActiveAll.reduce((s, c) => s + c.ar_balance, 0))
    const dormant_active_vol         = Math.round(dormantActiveAll.reduce((s, c) => s + c.vol_36m_mt, 0) * 10) / 10
    const dormant_active_avg_days    = dormant_active_count > 0
      ? Math.round(dormantActiveAll.reduce((s, c) => s + c.days_silent, 0) / dormant_active_count) : 0

    const dormant_by_region = { Luzon: 0, Visayas: 0, Mindanao: 0, Other: 0 }
    for (const c of dormantActiveAll) dormant_by_region[c.region] = (dormant_by_region[c.region] || 0) + 1

    const dormant_by_last_year = {}
    for (const c of dormantActiveAll) {
      if (!c.last_order_date) continue
      const y = new Date(c.last_order_date).getFullYear().toString()
      dormant_by_last_year[y] = (dormant_by_last_year[y] || 0) + 1
    }

    const dormant_active_list = dormantActiveAll
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

    // Summary for legacy_ar (opening-balance migration bucket)
    const legacy_ar_count = legacyArAll.length
    const legacy_ar_total = Math.round(legacyArAll.reduce((s, c) => s + c.ar_balance, 0))
    const legacy_by_region = { Luzon: 0, Visayas: 0, Mindanao: 0, Other: 0 }
    for (const c of legacyArAll) legacy_by_region[c.region] = (legacy_by_region[c.region] || 0) + 1

    const legacyFiltered = applySilenceFilter(legacyArAll, 'legacy_ar', silenceIdx, r => r.card_code)
    const legacy_ar_top = legacyFiltered.kept
      .slice()
      .sort((a, b) => b.ar_balance - a.ar_balance)
      .slice(0, 20)
      .map(c => ({
        card_code:       c.card_code,
        name:            c.name,
        region:          c.region,
        sales_rep:       c.sales_rep,
        last_inv_date:   c.last_order_date,
        ar_balance:      Math.round(c.ar_balance),
        years_silent:    c.last_order_date
          ? Math.round((Date.now() - new Date(c.last_order_date).getTime()) / (365.25 * 86400000) * 10) / 10
          : null
      }))

    // ============== HERO STATS ==============
    const hero_stats = {
      rescue_at_risk_amt:         Math.round(top_rescue.reduce((s, r) => s + r.ar_balance, 0)),
      rescue_count:               top_rescue.length,
      growth_upside_amt:          Math.round(top_growth.reduce((s, g) => s + g.upside_php_yearly, 0)),
      growth_count:               top_growth.length,
      early_warning_amt:          Math.round(early_warning.reduce((s, w) => s + w.revenue_impact_php_yearly, 0)),
      early_warning_count:        early_warning.length,
      dormant_active_count,
      dormant_active_ar_amt:      dormant_active_ar,
      legacy_ar_count,
      legacy_ar_amt:              legacy_ar_total,
      // Preserved for backward compat (older clients may still read these)
      dormant_count:              dormant_active_count,
      dormant_historical_ar_amt:  dormant_active_ar
    }

    const result = {
      hero_stats,
      top_rescue,
      top_growth,
      early_warning,
      dormant_active: {
        customer_count:       dormant_active_count,
        historical_ar_amt:    dormant_active_ar,
        lifetime_volume_mt:   dormant_active_vol,
        avg_dormancy_days:    dormant_active_avg_days,
        by_region:            dormant_by_region,
        by_last_active_year:  dormant_by_last_year,
        list:                 dormant_active_list
      },
      legacy_ar: {
        customer_count:       legacy_ar_count,
        total_ar:             legacy_ar_total,
        by_region:            legacy_by_region,
        top_accounts:         legacy_ar_top,
        description:          'Customers with open AR but no invoices since 2024-01-01. Likely opening-balance migration artifacts — finance/reconciliation task, not a sales alert.'
      },
      // v2-compat shape retained for any cached older clients
      dormant_summary: {
        customer_count:     dormant_active_count,
        historical_ar_amt:  dormant_active_ar,
        lifetime_volume_mt: dormant_active_vol,
        avg_dormancy_days:  dormant_active_avg_days,
        by_region:          dormant_by_region,
        by_last_active_year: dormant_by_last_year
      },
      dormant_list: dormant_active_list,
      silenced_count:
        rescueFiltered.removed_count +
        growthFiltered.removed_count +
        warningFiltered.removed_count +
        legacyFiltered.removed_count,
      silenced_by_type: {
        rescue:    rescueFiltered.removed_count,
        grow:      growthFiltered.removed_count,
        warning:   warningFiltered.removed_count,
        legacy_ar: legacyFiltered.removed_count
      },
      meta: {
        total_customers_analyzed: allCustomers.length,
        rescue_pool_size:         rescueAll.length,
        growth_pool_size:         growthAll.length,
        warning_pool_size:        warningAll.length,
        dormant_active_pool_size: dormantActiveAll.length,
        legacy_ar_pool_size:      legacyArAll.length,
        non_customer_filter_applied: true,
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

void applyRoleFilter
void excludeNonCustomers
