// GET /api/analytics/buying-patterns
//
// Per-customer ordering-cadence classifier. Powers the Buying Pattern
// section of Customer Intelligence.
//
// Strategy:
//   1. Pull DISTINCT (CardCode, DocDate) from OINV for the last 12 months
//      across both Vienovo_Live and Vienovo_Old (with re-keying).
//   2. For each customer with ≥3 orders, compute interval stats:
//        avg_interval_days, stddev, recent_3mo_avg_interval, prior_9mo_avg_interval
//   3. Classify into one of 5 patterns:
//        REGULAR     avg ≤ 10d AND stddev/avg < 0.4
//        MONTHLY     avg 11–35d AND stddev/avg < 0.5
//        LUMPY       stddev/avg ≥ 0.5
//        DECLINING   recent_3mo_avg > prior_9mo_avg × 1.5
//        ERRATIC     everything else (no clear pattern)
//   4. Return summary + sorted customers (DECLINING first, then revenue desc).
//
// CRITICAL: no customer exclusion. CCPC included.

const { query, queryH } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { rekeyHistoricalRows } = require('./lib/customer-map')
const cache = require('../lib/cache')

const REGION_CASE = `
  CASE
    WHEN T1.WhsCode IN ('AC','ACEXT','BAC')      THEN 'Luzon'
    WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE')  THEN 'Visayas'
    WHEN T1.WhsCode IN ('BUKID','CCPC')          THEN 'Mindanao'
    ELSE 'Other'
  END`

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `analytics_buying_patterns_${session.role}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // 1. Order-level rows (one per CardCode × DocDate) for cadence
    const SQL_DATES = `
      SELECT
        T0.CardCode,
        MAX(T0.CardName)                                   AS CardName,
        T0.DocDate                                         AS doc_date,
        ISNULL(SUM(T1.LineTotal), 0)                       AS day_revenue,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS day_vol,
        MAX(${REGION_CASE})                                 AS region,
        MAX(S.SlpName)                                     AS sales_rep
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      INNER JOIN OITM I  ON I.ItemCode = T1.ItemCode
      LEFT JOIN OSLP S   ON T0.SlpCode = S.SlpCode
      WHERE T0.CANCELED = 'N'
        AND UPPER(T1.ItemCode) LIKE 'FG%'
        AND T0.DocDate >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY T0.CardCode, T0.DocDate
    `

    const [curRows, histRows] = await Promise.all([
      query(SQL_DATES).catch(e => { console.warn('[patterns] current failed:', e.message); return [] }),
      queryH(SQL_DATES).catch(e => { console.warn('[patterns] historical failed:', e.message); return [] })
    ])
    const histKeyed = await rekeyHistoricalRows(histRows, 'CardCode').catch(() => [])
    const merged = [...curRows, ...histKeyed]

    // Group rows by CardCode
    const byCust = new Map()
    for (const r of merged) {
      const cc = r.CardCode
      if (!cc) continue
      if (!byCust.has(cc)) byCust.set(cc, {
        card_code: cc,
        name: r.CardName || cc,
        region: r.region || 'Other',
        sales_rep: r.sales_rep || '',
        orders: [],
        revenue: 0,
        volume: 0
      })
      const c = byCust.get(cc)
      c.orders.push({ date: new Date(r.doc_date), revenue: Number(r.day_revenue || 0), vol: Number(r.day_vol || 0) })
      c.revenue += Number(r.day_revenue || 0)
      c.volume  += Number(r.day_vol || 0)
      if (r.region) c.region = r.region
      if (r.sales_rep) c.sales_rep = r.sales_rep
    }

    const today = new Date()
    const cut3mo = new Date(today.getTime() - 90 * 86400000)

    function classifyPattern(orders) {
      if (orders.length < 3) {
        return { pattern: 'erratic', avg_interval: null, stddev: null,
                 recent_avg: null, prior_avg: null, delta_pct: null,
                 cv: null, last_order: orders[orders.length - 1]?.date || null }
      }
      orders.sort((a, b) => a.date - b.date)
      const intervals = []
      for (let i = 1; i < orders.length; i++) {
        const days = (orders[i].date - orders[i - 1].date) / 86400000
        intervals.push(days)
      }
      const avg = intervals.reduce((s, x) => s + x, 0) / intervals.length
      const variance = intervals.reduce((s, x) => s + (x - avg) ** 2, 0) / intervals.length
      const stddev = Math.sqrt(variance)
      const cv = avg > 0 ? stddev / avg : 0    // coefficient of variation

      // Recent vs prior intervals (split by start-of-window)
      const recentIntervals = []
      const priorIntervals = []
      for (let i = 1; i < orders.length; i++) {
        const days = (orders[i].date - orders[i - 1].date) / 86400000
        if (orders[i].date >= cut3mo) recentIntervals.push(days)
        else priorIntervals.push(days)
      }
      const recent_avg = recentIntervals.length > 0
        ? recentIntervals.reduce((s, x) => s + x, 0) / recentIntervals.length
        : null
      const prior_avg = priorIntervals.length > 0
        ? priorIntervals.reduce((s, x) => s + x, 0) / priorIntervals.length
        : null
      const delta_pct = (recent_avg && prior_avg)
        ? Math.round(((recent_avg - prior_avg) / prior_avg) * 1000) / 10
        : null

      // Pattern decision tree (DECLINING wins over LUMPY/MONTHLY).
      // Daily-orderer guard: don't flag DECLINING when recent_avg is still under
      // 7 days — they're still healthy, the % shift is statistically noise.
      let pattern
      if (recent_avg && prior_avg && recent_avg > prior_avg * 1.5 && recent_avg >= 7) pattern = 'declining'
      else if (avg <= 10 && cv < 0.4) pattern = 'regular'
      else if (avg > 10 && avg <= 35 && cv < 0.5) pattern = 'monthly'
      else if (cv >= 0.5) pattern = 'lumpy'
      else pattern = 'erratic'

      return {
        pattern,
        avg_interval: Math.round(avg * 10) / 10,
        stddev: Math.round(stddev * 10) / 10,
        recent_avg: recent_avg != null ? Math.round(recent_avg * 10) / 10 : null,
        prior_avg: prior_avg != null ? Math.round(prior_avg * 10) / 10 : null,
        delta_pct,
        cv: Math.round(cv * 100) / 100,
        last_order: orders[orders.length - 1].date
      }
    }

    const customers = []
    for (const c of byCust.values()) {
      const cls = classifyPattern(c.orders)
      // Only count "active" — at least one order in last 90 days
      const recent_orders = c.orders.filter(o => o.date >= cut3mo).length
      const days_since_last = cls.last_order
        ? Math.floor((today - cls.last_order) / 86400000)
        : 9999

      // Revenue impact for declining = projected loss vs prior cadence
      let revenue_impact_php = 0
      let reason = ''
      let action = ''
      if (cls.pattern === 'declining' && cls.prior_avg && cls.recent_avg) {
        const slowdown = (cls.recent_avg - cls.prior_avg) / cls.prior_avg
        revenue_impact_php = Math.round(c.revenue * slowdown * -1)  // negative means loss
        reason = `Was ${cls.prior_avg}d interval prior 9mo, now ${cls.recent_avg}d (+${cls.delta_pct}%)`
        action = 'Schedule rep visit within 1 week — investigate slowdown'
      } else if (cls.pattern === 'regular') {
        reason = `Steady ${cls.avg_interval}d cadence (CV ${cls.cv})`
        action = 'Maintain current service level'
      } else if (cls.pattern === 'monthly') {
        reason = `Monthly cadence ${cls.avg_interval}d ± ${cls.stddev}d`
        action = 'Light-touch monthly check-in'
      } else if (cls.pattern === 'lumpy') {
        reason = `High variance (CV ${cls.cv}) — likely project-based or hoarding`
        action = 'Map order triggers; align inventory holds'
      } else {
        reason = c.orders.length < 3 ? 'Insufficient orders' : 'No clear cadence'
        action = 'Re-engage; assess account health'
      }

      customers.push({
        card_code: c.card_code,
        name: c.name,
        region: c.region,
        sales_rep: c.sales_rep,
        pattern: cls.pattern,
        order_count: c.orders.length,
        recent_orders,
        avg_interval: cls.avg_interval,
        stddev: cls.stddev,
        recent_avg_interval: cls.recent_avg,
        prior_avg_interval: cls.prior_avg,
        delta_pct: cls.delta_pct,
        days_since_last,
        revenue_php: Math.round(c.revenue),
        volume_mt: Math.round(c.volume * 10) / 10,
        revenue_impact_php,
        reason,
        action
      })
    }

    // Sort: DECLINING first (most-impactful first), then by revenue desc
    const patternOrder = { declining: 0, lumpy: 1, regular: 2, monthly: 3, erratic: 4 }
    customers.sort((a, b) => {
      const p = patternOrder[a.pattern] - patternOrder[b.pattern]
      if (p !== 0) return p
      if (a.pattern === 'declining') return Math.abs(b.revenue_impact_php) - Math.abs(a.revenue_impact_php)
      return b.revenue_php - a.revenue_php
    })

    // Summary buckets
    const summary = {
      regular:   { count: 0, total_revenue_php: 0, total_volume_mt: 0, avg_interval_d: null },
      monthly:   { count: 0, total_revenue_php: 0, total_volume_mt: 0, avg_interval_d: null },
      lumpy:     { count: 0, total_revenue_php: 0, total_volume_mt: 0, avg_interval_d: null },
      declining: { count: 0, total_revenue_php: 0, total_volume_mt: 0, avg_interval_d: null },
      erratic:   { count: 0, total_revenue_php: 0, total_volume_mt: 0, avg_interval_d: null }
    }
    const intervalSums = { regular: [], monthly: [], lumpy: [], declining: [], erratic: [] }
    for (const c of customers) {
      const s = summary[c.pattern]
      s.count += 1
      s.total_revenue_php += c.revenue_php
      s.total_volume_mt   += c.volume_mt
      if (c.avg_interval != null) intervalSums[c.pattern].push(c.avg_interval)
    }
    for (const [pat, ints] of Object.entries(intervalSums)) {
      summary[pat].avg_interval_d = ints.length
        ? Math.round(ints.reduce((s, x) => s + x, 0) / ints.length * 10) / 10
        : null
      summary[pat].total_volume_mt = Math.round(summary[pat].total_volume_mt * 10) / 10
    }

    const result = {
      meta: {
        period: 'Trailing 12 months',
        cutoff_for_declining: '90-day vs prior 9 months, +50% slowdown threshold',
        generated_at: new Date().toISOString(),
        total_customers_analyzed: customers.length
      },
      summary,
      customers
    }

    cache.set(cacheKey, result, 1800)
    res.json(result)
  } catch (err) {
    console.error('API error [analytics/buying-patterns]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
