const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache check
  const cacheKey = `margin_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'YTD' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

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

    // Classify customers
    const critical = custMargin.filter(c => c.gp_pct < 0)
    const warning = custMargin.filter(c => c.gp_pct >= 0 && c.gp_pct < 10)
    const watch = custMargin.filter(c => c.gp_pct >= 10 && c.gp_pct < 15)
    const healthy = custMargin.filter(c => c.gp_pct >= 15)

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
      worst_skus
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [margin]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
