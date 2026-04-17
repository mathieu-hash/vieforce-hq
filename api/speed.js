const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// 2026 Budget targets (from Sales Volume Budget 2026)
// Annual: 188,266 MT | Q1: 41,800 | Q2: 45,184 | Q3: 49,389 | Q4: 51,893
const BUDGET_2026 = {
  annual: 188266,
  quarterly: [41800, 45184, 49389, 51893],  // Q1, Q2, Q3, Q4
  monthly: [
    13933, 13933, 13934,   // Q1: Jan, Feb, Mar (41,800 / 3)
    15061, 15061, 15062,   // Q2: Apr, May, Jun (45,184 / 3)
    16463, 16463, 16463,   // Q3: Jul, Aug, Sep (49,389 / 3)
    17298, 17298, 17297    // Q4: Oct, Nov, Dec (51,893 / 3)
  ]
}

function getTarget(period) {
  const now = new Date()
  const month = now.getMonth()      // 0-11
  const quarter = Math.floor(month / 3) // 0-3

  switch (period) {
    case '7D':  return Math.round(BUDGET_2026.monthly[month] * 7 / 30)
    case 'MTD': return BUDGET_2026.monthly[month]
    case 'QTD': return BUDGET_2026.quarterly[quarter]
    case 'YTD': return BUDGET_2026.annual
    default:    return BUDGET_2026.monthly[month]
  }
}

/**
 * Count Mon-Sat shipping days between two dates (inclusive).
 * Sunday (getDay()===0) is excluded.
 */
function countShippingDays(from, to) {
  let count = 0
  const d = new Date(from)
  while (d <= to) {
    if (d.getDay() !== 0) count++ // Mon=1 through Sat=6
    d.setDate(d.getDate() + 1)
  }
  return count
}

/**
 * Get the last day of the period.
 */
function getPeriodEnd(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()

  switch (period) {
    case '7D':  return new Date(y, m, now.getDate())
    case 'MTD': return new Date(y, m + 1, 0)
    case 'QTD': return new Date(y, Math.floor(m / 3) * 3 + 3, 0)
    case 'YTD': return new Date(y, 11, 31)
    default:    return new Date(y, m + 1, 0)
  }
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache
  const cacheKey = `speed_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

    // Actual MT shipped (from ODLN delivery notes, NOT OINV invoices)
    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    const totalRow = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS actual_mt
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
    `, { dateFrom, dateTo })

    // Breakdown — daily for 7D/MTD, weekly for QTD, monthly for YTD
    let daily
    if (period === 'YTD') {
      daily = await query(`
        SELECT
          FORMAT(T0.DocDate, 'yyyy-MM')                                     AS ship_date,
          'Month'                                                           AS day_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS daily_mt
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
        GROUP BY FORMAT(T0.DocDate, 'yyyy-MM')
        ORDER BY ship_date ASC
      `, { dateFrom, dateTo })
    } else if (period === 'QTD') {
      daily = await query(`
        SELECT
          'W' + CAST(DATEPART(ISO_WEEK, T0.DocDate) AS VARCHAR)             AS ship_date,
          'Week'                                                            AS day_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS daily_mt
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
        GROUP BY DATEPART(ISO_WEEK, T0.DocDate)
        ORDER BY MIN(T0.DocDate) ASC
      `, { dateFrom, dateTo })
    } else {
      daily = await query(`
        SELECT
          CONVERT(VARCHAR(10), T0.DocDate, 120)                             AS ship_date,
          DATENAME(WEEKDAY, T0.DocDate)                                     AS day_name,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS daily_mt
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
        GROUP BY CONVERT(VARCHAR(10), T0.DocDate, 120), DATENAME(WEEKDAY, T0.DocDate)
        ORDER BY ship_date ASC
      `, { dateFrom, dateTo })
    }

    const actual_mt = totalRow[0]?.actual_mt || 0
    const today = new Date()
    const periodEnd = getPeriodEnd(period)

    const elapsed_days = countShippingDays(dateFrom, today)
    const total_days = countShippingDays(dateFrom, periodEnd)

    const speed_per_day = elapsed_days > 0 ? actual_mt / elapsed_days : 0
    const projected_mt = elapsed_days > 0
      ? Math.round(speed_per_day * total_days)
      : 0

    const target_mt = getTarget(period)
    const pct_of_target = target_mt > 0
      ? Math.round((projected_mt / target_mt) * 100)
      : 0

    // --- Plant breakdown (MTD from ODLN) ---
    const plant_breakdown = await query(`
      SELECT
        T1.WhsCode                                                       AS plant,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS mtd
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
      GROUP BY T1.WhsCode
      ORDER BY mtd DESC
    `, { dateFrom, dateTo })

    // --- RSM speed (by SlpCode) ---
    const rsm_speed = await query(`
      SELECT TOP 20
        S.SlpName                                                        AS rsm,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS current_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
      GROUP BY S.SlpName
      ORDER BY current_vol DESC
    `, { dateFrom, dateTo })

    // --- Feed type speed (by brand/description) ---
    const feed_type_speed = await query(`
      SELECT TOP 15
        T1.Dscription                                                    AS brand,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS current_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'
      GROUP BY T1.Dscription
      ORDER BY current_vol DESC
    `, { dateFrom, dateTo })

    // --- Weekly matrix (last 6 weeks by plant) ---
    const weekly_raw = await query(`
      SELECT
        'W' + CAST(DATEPART(ISO_WEEK, T0.DocDate) AS VARCHAR)           AS week,
        T1.WhsCode                                                      AS plant,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)  AS vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(WEEK, -6, GETDATE()) AND T0.CANCELED = 'N'
      GROUP BY DATEPART(ISO_WEEK, T0.DocDate), T1.WhsCode
      ORDER BY MIN(T0.DocDate) ASC
    `)

    const weeks = [...new Set(weekly_raw.map(r => r.week))].sort()
    const plants = [...new Set(weekly_raw.map(r => r.plant))].sort()
    const weekly_matrix = {
      weeks,
      plants,
      grid: plants.map(p => weeks.map(w => {
        const match = weekly_raw.find(r => r.plant === p && r.week === w)
        return match ? Math.round(match.vol * 10) / 10 : 0
      }))
    }

    const result = {
      period,
      // Canonical (new) names — prefer these on the frontend
      mtd_actual:     Math.round(actual_mt * 10) / 10,
      daily_pullout:  Math.round(speed_per_day * 10) / 10,
      days_elapsed:   elapsed_days,
      days_total:     total_days,
      days_remaining: total_days - elapsed_days,
      projected_mtd:  projected_mt,
      // Legacy names (kept for back-compat with existing pages)
      actual_mt:     Math.round(actual_mt * 10) / 10,
      speed_per_day: Math.round(speed_per_day * 10) / 10,
      elapsed_days,
      total_days,
      remaining_days: total_days - elapsed_days,
      projected_mt,
      target_mt,
      pct_of_target,
      daily,
      plant_breakdown,
      rsm_speed,
      feed_type_speed,
      weekly_matrix
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [speed]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
