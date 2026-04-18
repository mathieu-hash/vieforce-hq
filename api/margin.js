const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')
const { isNonCustomer } = require('./lib/non-customer-codes')
const { getActiveSilences, buildSilenceIndex, applySilenceFilter } = require('./lib/silence')

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache key includes userId so silence filter is user-scoped.
  const cacheKey = `margin_v3_${session.id}_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'YTD' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

    // Silence index for this user (used on critical/warning lists below)
    const silences   = await getActiveSilences(session.id)
    const silenceIdx = buildSilenceIndex(silences)

    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- Customer-level GP aggregation ---
    const custMargin = await query(`
      SELECT TOP 500
        T0.CardCode                                                   AS code,
        T0.CardName                                                   AS customer,
        ISNULL(SUM(T1.LineTotal), 0)                                  AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS vol,
        ISNULL(SUM(T1.GrssProfit), 0)                                 AS gp,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                   AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                   AS gm_ton,
        S.SlpName                                                      AS rep
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName, S.SlpName
      HAVING SUM(T1.LineTotal) > 0
      ORDER BY gp_pct ASC
    `, { dateFrom, dateTo })

    // Drop warehouse/internal-transfer codes before classifying
    const custMarginClean = custMargin.filter(c => !isNonCustomer(c.code))

    // Classify customers (operate on cleaned list)
    const criticalRaw = custMarginClean.filter(c => c.gp_pct < 0)
    const warningRaw  = custMarginClean.filter(c => c.gp_pct >= 0 && c.gp_pct < 10)
    const watch       = custMarginClean.filter(c => c.gp_pct >= 10 && c.gp_pct < 15)
    const healthy     = custMarginClean.filter(c => c.gp_pct >= 15)

    // Apply per-user silence filter
    const criticalFiltered = applySilenceFilter(criticalRaw, 'margin_critical', silenceIdx, r => r.code)
    const warningFiltered  = applySilenceFilter(warningRaw,  'margin_warning',  silenceIdx, r => r.code)
    const critical = criticalFiltered.kept
    const warning  = warningFiltered.kept

    const negative_gp_total = critical.reduce((s, c) => s + c.gp, 0)
    const revenue_at_risk = [...critical, ...warning].reduce((s, c) => s + c.sales, 0)
    const totalSales = custMargin.reduce((s, c) => s + c.sales, 0)
    const totalVol = custMargin.reduce((s, c) => s + c.vol, 0)
    const totalGP = custMargin.reduce((s, c) => s + c.gp, 0)

    // --- SKU-level breakdown for critical customers ---
    const critCodes = critical.slice(0, 10).map(c => c.code)
    let critSKUs = []
    if (critCodes.length > 0) {
      const inList = critCodes.map((_, i) => `@cc${i}`).join(',')
      const skuParams = { dateFrom, dateTo }
      critCodes.forEach((c, i) => { skuParams[`cc${i}`] = c })

      critSKUs = await query(`
        SELECT TOP 100
          T0.CardCode                                                   AS code,
          T1.ItemCode                                                   AS sku,
          T1.Dscription                                                 AS sku_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS vol,
          CASE WHEN SUM(T1.LineTotal) > 0
            THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
            ELSE 0 END                                                   AS gp_pct
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo
          AND T0.CANCELED = 'N'
          AND T0.CardCode IN (${inList})
        GROUP BY T0.CardCode, T1.ItemCode, T1.Dscription
        HAVING SUM(T1.GrssProfit) < 0
        ORDER BY SUM(T1.GrssProfit) ASC
      `, skuParams)
    }

    // Attach SKU breakdown to critical customers
    const criticalWithSKU = critical.map(c => ({
      ...c,
      sku_breakdown: critSKUs.filter(s => s.code === c.code)
    }))

    // --- By Region ---
    const by_region = await query(`
      SELECT
        CASE
          WHEN W.WhsName LIKE '%Luzon%' OR W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsName LIKE '%Visayas%' OR W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsName LIKE '%Mindanao%' OR W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                              AS region,
        ISNULL(SUM(T1.LineTotal), 0)                                     AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS vol,
        ISNULL(SUM(T1.GrssProfit), 0)                                    AS gp,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                      AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                      AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OWHS W ON T1.WhsCode = W.WhsCode
      ${filteredWhere}
      GROUP BY
        CASE
          WHEN W.WhsName LIKE '%Luzon%' OR W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsName LIKE '%Visayas%' OR W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsName LIKE '%Mindanao%' OR W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END
      ORDER BY gp_pct ASC
    `, { dateFrom, dateTo })

    // --- By Brand ---
    const by_brand = await query(`
      SELECT TOP 20
        T1.Dscription                                                    AS brand,
        ISNULL(SUM(T1.LineTotal), 0)                                     AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS vol,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                      AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                      AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T1.Dscription
      ORDER BY gm_ton ASC
    `, { dateFrom, dateTo })

    // --- By Plant ---
    const by_plant = await query(`
      SELECT TOP 20
        T1.WhsCode                                                       AS plant,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS vol,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                      AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                      AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T1.WhsCode
      ORDER BY gm_ton ASC
    `, { dateFrom, dateTo })

    // --- By Sales Group (feed classifier from ItemName keywords) ---
    const by_sales_group = await query(`
      SELECT
        CASE
          WHEN UPPER(I.ItemName) LIKE '%HOG%' OR UPPER(I.ItemName) LIKE '%PIGLET%' OR UPPER(I.ItemName) LIKE '%SOW%' OR UPPER(I.ItemName) LIKE '%BOAR%' THEN 'HOGS'
          WHEN UPPER(I.ItemName) LIKE '%LAYER%' OR UPPER(I.ItemName) LIKE '%BROILER%' OR UPPER(I.ItemName) LIKE '%CHICK%' OR UPPER(I.ItemName) LIKE '%POULTRY%' OR UPPER(I.ItemName) LIKE '%DUCK%' THEN 'POULTRY'
          WHEN UPPER(I.ItemName) LIKE '%GAMEFOWL%' OR UPPER(I.ItemName) LIKE '%MUSCLY%' THEN 'GAMEFOWL'
          WHEN UPPER(I.ItemName) LIKE '%KEOS%' OR UPPER(I.ItemName) LIKE '%PLAISIR%' OR UPPER(I.ItemName) LIKE '%NOVOPET%' THEN 'PET'
          WHEN UPPER(I.ItemName) LIKE '%VANA%' OR UPPER(I.ItemName) LIKE '%SHRIMP%' THEN 'AQUA'
          ELSE 'OTHERS'
        END                                                                AS sales_group,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                       AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY
        CASE
          WHEN UPPER(I.ItemName) LIKE '%HOG%' OR UPPER(I.ItemName) LIKE '%PIGLET%' OR UPPER(I.ItemName) LIKE '%SOW%' OR UPPER(I.ItemName) LIKE '%BOAR%' THEN 'HOGS'
          WHEN UPPER(I.ItemName) LIKE '%LAYER%' OR UPPER(I.ItemName) LIKE '%BROILER%' OR UPPER(I.ItemName) LIKE '%CHICK%' OR UPPER(I.ItemName) LIKE '%POULTRY%' OR UPPER(I.ItemName) LIKE '%DUCK%' THEN 'POULTRY'
          WHEN UPPER(I.ItemName) LIKE '%GAMEFOWL%' OR UPPER(I.ItemName) LIKE '%MUSCLY%' THEN 'GAMEFOWL'
          WHEN UPPER(I.ItemName) LIKE '%KEOS%' OR UPPER(I.ItemName) LIKE '%PLAISIR%' OR UPPER(I.ItemName) LIKE '%NOVOPET%' THEN 'PET'
          WHEN UPPER(I.ItemName) LIKE '%VANA%' OR UPPER(I.ItemName) LIKE '%SHRIMP%' THEN 'AQUA'
          ELSE 'OTHERS'
        END
      HAVING SUM(T1.LineTotal) > 0
      ORDER BY sales DESC
    `, { dateFrom, dateTo })

    // --- By BU (customer-level classifier) ---
    const by_bu = await query(`
      SELECT
        CASE
          WHEN UPPER(T0.CardName) LIKE '%PET%' OR UPPER(T0.CardName) LIKE '%KEOS%' THEN 'PET'
          ELSE 'DIST'
        END                                                                AS bu,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                       AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY
        CASE
          WHEN UPPER(T0.CardName) LIKE '%PET%' OR UPPER(T0.CardName) LIKE '%KEOS%' THEN 'PET'
          ELSE 'DIST'
        END
      HAVING SUM(T1.LineTotal) > 0
      ORDER BY sales DESC
    `, { dateFrom, dateTo })

    // --- Worst SKUs (bottom 10) ---
    const worst_skus = await query(`
      SELECT TOP 10
        T1.ItemCode                                                      AS sku,
        T1.Dscription                                                    AS name,
        ISNULL(SUM(T1.Quantity), 0)                                      AS vol_bags,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                      AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                      AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T1.ItemCode, T1.Dscription
      HAVING SUM(T1.Quantity) > 0
      ORDER BY gp_pct ASC
    `, { dateFrom, dateTo })

    // --- National KPIs ---
    const natl_gm_ton = totalVol > 0 ? totalGP / totalVol : 0
    const natl_gp_pct = totalSales > 0 ? (totalGP / totalSales) * 100 : 0
    const bestRegion = by_region.length > 0 ? by_region[by_region.length - 1] : null
    const worstRegion = by_region.length > 0 ? by_region[0] : null

    const result = {
      hero: {
        negative_gp_total: Math.round(negative_gp_total),
        revenue_at_risk: Math.round(revenue_at_risk),
        critical_count: critical.length,
        warning_count: warning.length
      },
      kpis: {
        critical: critical.length,
        warning: warning.length,
        watch: watch.length,
        healthy: healthy.length,
        natl_gm_ton: Math.round(natl_gm_ton),
        natl_gp_pct: Math.round(natl_gp_pct * 10) / 10,
        best_region: bestRegion ? { name: bestRegion.region, gp_pct: Math.round(bestRegion.gp_pct * 10) / 10 } : null,
        worst_region: worstRegion ? { name: worstRegion.region, gp_pct: Math.round(worstRegion.gp_pct * 10) / 10 } : null
      },
      critical: criticalWithSKU,
      warning,
      by_region,
      by_brand,
      by_plant,
      by_sales_group,
      by_bu,
      worst_skus,
      silenced_count: criticalFiltered.removed_count + warningFiltered.removed_count,
      silenced_by_type: {
        margin_critical: criticalFiltered.removed_count,
        margin_warning:  warningFiltered.removed_count
      },
      non_customer_filter_applied: true
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [margin]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
