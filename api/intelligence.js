const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
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

  // Cache check (10 min — heavy computation)
  const cacheKey = `intelligence_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const baseWhere = `WHERE T0.DocDate >= DATEADD(MONTH, -12, GETDATE()) AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- Brand coverage per customer (last 12 months) ---
    // Brand = first word of SKU description (e.g. "VIEPRO MUSCLY..." -> "VIEPRO")
    const brandCoverage = await query(`
      SELECT TOP 20
        CASE
          WHEN CHARINDEX(' ', T1.Dscription) > 0
          THEN LEFT(T1.Dscription, CHARINDEX(' ', T1.Dscription) - 1)
          ELSE T1.Dscription
        END                                                              AS brand,
        COUNT(DISTINCT T0.CardCode)                                      AS customers,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS total_vol
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY
        CASE
          WHEN CHARINDEX(' ', T1.Dscription) > 0
          THEN LEFT(T1.Dscription, CHARINDEX(' ', T1.Dscription) - 1)
          ELSE T1.Dscription
        END
      HAVING SUM(T1.Quantity) > 50
      ORDER BY total_vol DESC
    `)

    // Total active customers
    const activeRow = await query(`
      SELECT COUNT(DISTINCT T0.CardCode) AS total_active
      FROM OINV T0
      ${filteredWhere}
    `)
    const totalActive = activeRow[0]?.total_active || 1

    const brand_coverage = brandCoverage.map(b => ({
      brand: b.brand,
      customers: b.customers,
      penetration_pct: Math.round((b.customers / totalActive) * 100),
      vol_per_cust: Math.round((b.total_vol / b.customers) * 10) / 10,
      whitespace_count: totalActive - b.customers,
      est_opportunity: Math.round((totalActive - b.customers) * (b.total_vol / b.customers) * 0.5 * 31.735)
    }))

    // --- Brands per customer ---
    const brandsPerCust = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        COUNT(DISTINCT T1.Dscription)                                    AS brand_count,
        COUNT(DISTINCT T1.ItemCode)                                      AS sku_count,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS total_vol
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName
      ORDER BY total_vol DESC
    `)

    const horizontal_targets = brandsPerCust
      .filter(c => c.brand_count < 2)
      .slice(0, 20)
      .map(c => ({
        customer: c.CardName,
        code: c.CardCode,
        skus: c.sku_count,
        brands: c.brand_count,
        vol: Math.round(c.total_vol * 10) / 10
      }))

    // --- Buying patterns by order frequency ---
    const orderFreq = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        COUNT(DISTINCT T0.DocEntry)                                      AS order_count,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS total_vol,
        MIN(T0.DocDate)                                                  AS first_order,
        MAX(T0.DocDate)                                                  AS last_order,
        DATEDIFF(DAY, MAX(T0.DocDate), GETDATE())                        AS days_since_last
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName
    `)

    // Classify by cadence
    const patterns = { regular: [], biweekly: [], monthly: [], sporadic: [], dormant: [] }
    orderFreq.forEach(c => {
      const span = Math.max(1, Math.round((new Date(c.last_order) - new Date(c.first_order)) / (1000 * 60 * 60 * 24)))
      const freq = span > 0 ? c.order_count / (span / 30) : 0

      if (c.days_since_last > 60) patterns.dormant.push(c)
      else if (freq >= 4) patterns.regular.push(c)
      else if (freq >= 2) patterns.biweekly.push(c)
      else if (freq >= 1) patterns.monthly.push(c)
      else patterns.sporadic.push(c)
    })

    const buying_patterns = [
      { pattern: 'Regular (weekly+)', count: patterns.regular.length, pct: Math.round((patterns.regular.length / totalActive) * 100), avg_vol: Math.round(patterns.regular.reduce((s, c) => s + c.total_vol, 0) / Math.max(1, patterns.regular.length)), signal: 'Loyal' },
      { pattern: 'Bi-weekly', count: patterns.biweekly.length, pct: Math.round((patterns.biweekly.length / totalActive) * 100), avg_vol: Math.round(patterns.biweekly.reduce((s, c) => s + c.total_vol, 0) / Math.max(1, patterns.biweekly.length)), signal: 'Stable' },
      { pattern: 'Monthly', count: patterns.monthly.length, pct: Math.round((patterns.monthly.length / totalActive) * 100), avg_vol: Math.round(patterns.monthly.reduce((s, c) => s + c.total_vol, 0) / Math.max(1, patterns.monthly.length)), signal: 'Monitor' },
      { pattern: 'Sporadic (>30d gaps)', count: patterns.sporadic.length, pct: Math.round((patterns.sporadic.length / totalActive) * 100), avg_vol: Math.round(patterns.sporadic.reduce((s, c) => s + c.total_vol, 0) / Math.max(1, patterns.sporadic.length)), signal: 'At Risk' },
      { pattern: 'Dormant (>60d)', count: patterns.dormant.length, pct: Math.round((patterns.dormant.length / totalActive) * 100), avg_vol: 0, signal: 'Lost?' }
    ]

    // --- Behavioral alerts ---
    const silent = orderFreq
      .filter(c => c.days_since_last >= 30 && c.days_since_last < 90)
      .sort((a, b) => b.days_since_last - a.days_since_last)
      .slice(0, 10)
      .map(c => ({ customer: c.CardName, code: c.CardCode, days_ago: c.days_since_last, ytd_vol: Math.round(c.total_vol * 10) / 10 }))

    // Volume drops: compare last 3 months vs prior 3 months
    const volChanges = await query(`
      SELECT TOP 100
        T0.CardCode,
        T0.CardName,
        ISNULL(SUM(CASE WHEN T0.DocDate >= DATEADD(MONTH, -3, GETDATE())
          THEN T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0 ELSE 0 END), 0) AS recent_vol,
        ISNULL(SUM(CASE WHEN T0.DocDate < DATEADD(MONTH, -3, GETDATE())
          AND T0.DocDate >= DATEADD(MONTH, -6, GETDATE())
          THEN T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0 ELSE 0 END), 0) AS prior_vol
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(MONTH, -6, GETDATE()) AND T0.CANCELED = 'N'
      GROUP BY T0.CardCode, T0.CardName
      HAVING SUM(CASE WHEN T0.DocDate < DATEADD(MONTH, -3, GETDATE())
        AND T0.DocDate >= DATEADD(MONTH, -6, GETDATE())
        THEN T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0 ELSE 0 END) > 10
      ORDER BY (SUM(CASE WHEN T0.DocDate >= DATEADD(MONTH, -3, GETDATE())
        THEN T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0 ELSE 0 END) -
        SUM(CASE WHEN T0.DocDate < DATEADD(MONTH, -3, GETDATE())
        AND T0.DocDate >= DATEADD(MONTH, -6, GETDATE())
        THEN T1.Quantity * ISNULL(I.NumInSale, 1) / 1000.0 ELSE 0 END)) ASC
    `)

    const drops = volChanges
      .filter(c => c.prior_vol > 0 && ((c.recent_vol - c.prior_vol) / c.prior_vol) < -0.3)
      .slice(0, 10)
      .map(c => ({
        customer: c.CardName,
        code: c.CardCode,
        recent_vol: Math.round(c.recent_vol),
        prior_vol: Math.round(c.prior_vol),
        change_pct: Math.round(((c.recent_vol - c.prior_vol) / c.prior_vol) * 100)
      }))

    const growing = volChanges
      .filter(c => c.prior_vol > 0 && ((c.recent_vol - c.prior_vol) / c.prior_vol) > 0.25)
      .sort((a, b) => ((b.recent_vol - b.prior_vol) / b.prior_vol) - ((a.recent_vol - a.prior_vol) / a.prior_vol))
      .slice(0, 10)
      .map(c => ({
        customer: c.CardName,
        code: c.CardCode,
        recent_vol: Math.round(c.recent_vol),
        prior_vol: Math.round(c.prior_vol),
        change_pct: Math.round(((c.recent_vol - c.prior_vol) / c.prior_vol) * 100)
      }))

    // --- Account health score distribution ---
    // Simple composite: order frequency + volume trend + brand count
    const healthBands = [
      { band: '0-30 Critical', min: 0, max: 30, count: 0, volume: 0, revenue: 0 },
      { band: '31-50 Warning', min: 31, max: 50, count: 0, volume: 0, revenue: 0 },
      { band: '51-70 Stable', min: 51, max: 70, count: 0, volume: 0, revenue: 0 },
      { band: '71-85 Strong', min: 71, max: 85, count: 0, volume: 0, revenue: 0 },
      { band: '86-100 Champion', min: 86, max: 100, count: 0, volume: 0, revenue: 0 }
    ]

    let healthScoreSum = 0
    orderFreq.forEach(c => {
      // Frequency score (0-25): weekly=25, biweekly=20, monthly=15, sporadic=8, dormant=0
      const span = Math.max(1, Math.round((new Date(c.last_order) - new Date(c.first_order)) / (1000 * 60 * 60 * 24)))
      const freq = c.order_count / (span / 30)
      const freqScore = freq >= 4 ? 25 : freq >= 2 ? 20 : freq >= 1 ? 15 : c.days_since_last > 60 ? 0 : 8

      // Recency score (0-20): <7d=20, <14d=16, <30d=10, <60d=5, >60d=0
      const recencyScore = c.days_since_last < 7 ? 20 : c.days_since_last < 14 ? 16 : c.days_since_last < 30 ? 10 : c.days_since_last < 60 ? 5 : 0

      // Volume score (0-25): top quartile = 25, etc.
      const avgVol = orderFreq.reduce((s, x) => s + x.total_vol, 0) / totalActive
      const volRatio = avgVol > 0 ? c.total_vol / avgVol : 0
      const volScore = volRatio >= 2 ? 25 : volRatio >= 1 ? 20 : volRatio >= 0.5 ? 15 : volRatio >= 0.2 ? 8 : 3

      // Brand diversity (0-15)
      const bc = brandsPerCust.find(b => b.CardCode === c.CardCode)
      const brandScore = bc ? Math.min(15, (bc.brand_count / Math.max(1, brandCoverage.length)) * 15 * 5) : 5

      // Payment (0-15): placeholder — would need ORCT or PaidToDate analysis
      const payScore = 10

      const score = Math.min(100, Math.round(freqScore + recencyScore + volScore + brandScore + payScore))
      healthScoreSum += score

      const band = healthBands.find(b => score >= b.min && score <= b.max)
      if (band) {
        band.count++
        band.volume += c.total_vol
      }
    })

    const health_distribution = healthBands.map(b => ({
      band: b.band,
      count: b.count,
      pct: Math.round((b.count / Math.max(1, totalActive)) * 100),
      volume: Math.round(b.volume),
      revenue: Math.round(b.volume * 31735)
    }))

    // --- SKU penetration matrix (top 15 customers x top categories) ---
    const top15 = brandsPerCust.slice(0, 15)
    const topCategories = brandCoverage.slice(0, 10).map(b => b.brand)

    let sku_penetration_matrix = { customers: [], categories: topCategories, grid: [] }
    if (top15.length > 0 && topCategories.length > 0) {
      const custCodes = top15.map(c => c.CardCode)
      const matrixParams = {}
      custCodes.forEach((c, i) => { matrixParams[`mc${i}`] = c })
      const mcList = custCodes.map((_, i) => `@mc${i}`).join(',')

      const matrixData = await query(`
        SELECT
          T0.CardCode,
          T1.Dscription AS category,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS vol
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate >= DATEADD(MONTH, -3, GETDATE())
          AND T0.CANCELED = 'N'
          AND T0.CardCode IN (${mcList})
        GROUP BY T0.CardCode, T1.Dscription
      `, matrixParams)

      sku_penetration_matrix.customers = top15.map(c => c.CardName)
      sku_penetration_matrix.grid = top15.map(cust => {
        return topCategories.map(cat => {
          const match = matrixData.find(m => m.CardCode === cust.CardCode && m.category === cat)
          return match ? Math.round(match.vol * 10) / 10 : 0
        })
      })
    }

    // --- Reorder predictions (overdue based on avg frequency) ---
    const reorder_predictions = orderFreq
      .filter(c => c.order_count >= 3 && c.days_since_last > 0)
      .map(c => {
        const span = Math.max(1, Math.round((new Date(c.last_order) - new Date(c.first_order)) / (1000 * 60 * 60 * 24)))
        const avgInterval = span / Math.max(1, c.order_count - 1)
        const daysOverdue = c.days_since_last - avgInterval
        return {
          customer: c.CardName,
          code: c.CardCode,
          avg_interval_days: Math.round(avgInterval),
          days_since_last: c.days_since_last,
          days_overdue: Math.round(daysOverdue),
          est_vol: Math.round(c.total_vol / Math.max(1, c.order_count) * 10) / 10,
          status: daysOverdue > 5 ? 'OVERDUE' : daysOverdue > 0 ? 'DUE' : 'On track'
        }
      })
      .filter(c => c.days_overdue > -3)
      .sort((a, b) => b.days_overdue - a.days_overdue)
      .slice(0, 15)

    const whitespace_total = brand_coverage.reduce((s, b) => s + b.est_opportunity, 0)
    const at_risk_rev = [...silent, ...drops].reduce((s, c) => s + (c.ytd_vol || c.recent_vol || 0) * 31735, 0)
    const avg_health_score = totalActive > 0 ? Math.round(healthScoreSum / totalActive) : 0

    const result = {
      hero: {
        whitespace_total: Math.round(whitespace_total),
        at_risk_total: Math.round(at_risk_rev),
        avg_health_score,
        total_active: totalActive
      },
      kpis: {
        silent_30d: silent.length,
        vol_drop: drops.length,
        growing: growing.length,
        avg_skus_per_cust: Math.round(brandsPerCust.reduce((s, c) => s + c.sku_count, 0) / Math.max(1, totalActive) * 10) / 10,
        avg_brands_per_cust: Math.round(brandsPerCust.reduce((s, c) => s + c.brand_count, 0) / Math.max(1, totalActive) * 10) / 10
      },
      brand_coverage,
      horizontal_targets,
      buying_patterns,
      sku_penetration_matrix,
      behavioral_alerts: { silent, drops, growing },
      health_distribution,
      reorder_predictions
    }

    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [intelligence]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
