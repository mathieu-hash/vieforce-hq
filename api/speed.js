const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// Target MT per period — hardcoded for now, configurable later via env/config table
const TARGET_MT = 1500

/**
 * Count Mon-Sat workdays between two dates (inclusive).
 * Sunday (0) is excluded.
 */
function countWorkdays(from, to) {
  let count = 0
  const d = new Date(from)
  while (d <= to) {
    const dow = d.getDay()
    if (dow !== 0) count++ // Mon=1 through Sat=6
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
    case 'MTD': return new Date(y, m + 1, 0) // last day of current month
    case 'QTD': {
      const qEnd = Math.floor(m / 3) * 3 + 3
      return new Date(y, qEnd, 0)
    }
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

  // Cache check
  const cacheKey = `speed_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { period = 'MTD' } = req.query
    const { dateFrom, dateTo } = getPeriodDates(period)

    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    const filteredWhere = applyRoleFilter(session, baseWhere)

    const rows = await query(`
      SELECT ISNULL(SUM(T1.Quantity), 0) AS actual_mt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      ${filteredWhere}
    `, { dateFrom, dateTo })

    const actual_mt = rows[0]?.actual_mt || 0
    const today = new Date()
    const periodEnd = getPeriodEnd(period)

    const elapsed_days = countWorkdays(dateFrom, today)
    const total_days = countWorkdays(dateFrom, periodEnd)

    const projected_mt = elapsed_days > 0
      ? Math.round((actual_mt / elapsed_days) * total_days)
      : 0

    const target_mt = TARGET_MT
    const pct_of_target = target_mt > 0
      ? Math.round((projected_mt / target_mt) * 100)
      : 0

    const result = {
      actual_mt,
      elapsed_days,
      total_days,
      projected_mt,
      target_mt,
      pct_of_target
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [speed]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
