const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// RSM hierarchy — hardcoded until Mat provides real SlpCode mappings
const RSM_HIERARCHY = [
  { name: 'Mart Espliguez', region: 'Visayas', bu: 'Dist + KA' },
  { name: 'Joe Eyoy', region: 'Mindanao', bu: 'Dist + KA' },
  { name: 'Eric Salazar', region: 'Luzon', bu: 'Dist + KA' },
  { name: 'Edfrey Buenaventura', region: 'Mindanao', bu: 'Distribution' },
  { name: 'Mathieu Guillaume', region: 'National', bu: 'Direct / KA' },
  { name: 'Carminda Calderon', region: 'Visayas', bu: 'Distribution' },
  { name: 'Richard Lagdaan', region: 'Mindanao', bu: 'Distribution' },
  { name: 'Ma Lynie Gasingan', region: 'Visayas', bu: 'Pet Care' }
]

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
  const cacheKey = `team_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // --- Sales reps from OSLP ---
    const reps = await query(`
      SELECT SlpCode, SlpName, Active
      FROM OSLP
      WHERE Active = 'Y'
      ORDER BY SlpName
    `)

    // --- YTD sales by rep (OINV) ---
    const ytdStart = new Date(new Date().getFullYear(), 0, 1)
    const baseWhere = `WHERE T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    const repSales = await query(`
      SELECT
        T0.SlpCode,
        S.SlpName,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS ytd_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS ytd_sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS ytd_gm,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                       AS gm_ton,
        COUNT(DISTINCT T0.CardCode)                                        AS customers
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      ${filteredWhere}
      GROUP BY T0.SlpCode, S.SlpName
      ORDER BY ytd_vol DESC
    `, { ytdStart })

    // --- LY comparison ---
    const lyStart = new Date(new Date().getFullYear() - 1, 0, 1)
    const lyEnd = new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate())

    const repSalesLY = await query(`
      SELECT
        T0.SlpCode,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS ly_vol
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'
      GROUP BY T0.SlpCode
    `, { lyStart, lyEnd })

    // --- Speed by rep (current month, from ODLN) ---
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const repSpeed = await query(`
      SELECT
        T0.SlpCode,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mtd_speed
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= @monthStart AND T0.CANCELED = 'N'
      GROUP BY T0.SlpCode
    `, { monthStart })

    // --- DSO by rep ---
    const repDSO = await query(`
      SELECT
        T0.SlpCode,
        CASE WHEN SUM(T0.DocTotal) > 0
          THEN SUM(CASE WHEN T0.DocTotal > T0.PaidToDate THEN T0.DocTotal - T0.PaidToDate ELSE 0 END) /
               (SUM(T0.DocTotal) / 365.0)
          ELSE 0 END AS dso
      FROM OINV T0
      WHERE T0.CANCELED = 'N' AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
      GROUP BY T0.SlpCode
    `)

    // --- Silent customers by rep (no order in 30+ days) ---
    const repSilent = await query(`
      SELECT
        T0.SlpCode,
        COUNT(*) AS silent_count
      FROM (
        SELECT T0.CardCode, T0.SlpCode, MAX(T0.DocDate) AS last_order
        FROM OINV T0
        WHERE T0.CANCELED = 'N' AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
        GROUP BY T0.CardCode, T0.SlpCode
        HAVING DATEDIFF(DAY, MAX(T0.DocDate), GETDATE()) >= 30
      ) T0
      GROUP BY T0.SlpCode
    `)

    // --- Negative margin customers by rep ---
    const repNegMargin = await query(`
      SELECT
        T0.SlpCode,
        COUNT(DISTINCT T0.CardCode) AS neg_margin_count
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      WHERE T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'
      GROUP BY T0.SlpCode, T0.CardCode
      HAVING SUM(T1.GrssProfit) < 0
    `, { ytdStart })

    const negByRep = {}
    repNegMargin.forEach(r => {
      negByRep[r.SlpCode] = (negByRep[r.SlpCode] || 0) + r.neg_margin_count
    })

    // --- Monthly volume by rep (last 6 months) ---
    const monthlyByRep = await query(`
      SELECT
        T0.SlpCode,
        S.SlpName,
        FORMAT(T0.DocDate, 'yyyy-MM')                                     AS month,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS vol
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE T0.DocDate >= DATEADD(MONTH, -6, GETDATE()) AND T0.CANCELED = 'N'
      GROUP BY T0.SlpCode, S.SlpName, FORMAT(T0.DocDate, 'yyyy-MM')
      ORDER BY month ASC
    `)

    // Build RSM scorecard by matching SlpName patterns to hierarchy
    const rsms = RSM_HIERARCHY.map(rsm => {
      // Find matching sales data (fuzzy match on name)
      const nameParts = rsm.name.toLowerCase().split(' ')
      const match = repSales.find(r => {
        if (!r.SlpName) return false
        const rName = r.SlpName.toLowerCase()
        return nameParts.some(p => rName.includes(p))
      })

      const slpCode = match ? match.SlpCode : null
      const lyMatch = slpCode ? repSalesLY.find(r => r.SlpCode === slpCode) : null
      const speedMatch = slpCode ? repSpeed.find(r => r.SlpCode === slpCode) : null
      const dsoMatch = slpCode ? repDSO.find(r => r.SlpCode === slpCode) : null
      const silentMatch = slpCode ? repSilent.find(r => r.SlpCode === slpCode) : null

      const ytd_vol = match ? Math.round(match.ytd_vol) : 0
      const ly_vol = lyMatch ? lyMatch.ly_vol : 0
      const vs_ly = ly_vol > 0 ? Math.round(((ytd_vol - ly_vol) / ly_vol) * 1000) / 10 : 0

      return {
        name: rsm.name.toUpperCase(),
        region: rsm.region,
        bu: rsm.bu,
        slp_code: slpCode,
        ytd_vol,
        ytd_target: 0,  // Placeholder — Mat will provide real targets
        ach_pct: 0,
        vs_ly,
        speed: speedMatch ? Math.round(speedMatch.mtd_speed) : 0,
        gm_ton: match ? Math.round(match.gm_ton) : 0,
        dso: dsoMatch ? Math.round(dsoMatch.dso) : 0,
        customers: match ? match.customers : 0,
        silent: silentMatch ? silentMatch.silent_count : 0,
        neg_margin: slpCode ? (negByRep[slpCode] || 0) : 0
      }
    })

    // Build performance matrix (RSM x last 6 months)
    const allMonths = [...new Set(monthlyByRep.map(m => m.month))].sort()
    const recentMonths = allMonths.slice(-6)

    const performance_matrix = {
      months: recentMonths,
      rsms: rsms.map(r => r.name),
      grid: rsms.map(rsm => {
        return recentMonths.map(month => {
          const match = monthlyByRep.find(m => m.SlpCode === rsm.slp_code && m.month === month)
          return match ? Math.round(match.vol) : 0
        })
      })
    }

    // EVP totals
    const totalYTD = rsms.reduce((s, r) => s + r.ytd_vol, 0)
    const totalSpeed = rsms.reduce((s, r) => s + r.speed, 0)
    const totalGMTon = repSales.length > 0
      ? Math.round(repSales.reduce((s, r) => s + r.ytd_gm, 0) / Math.max(1, repSales.reduce((s, r) => s + r.ytd_vol, 0)))
      : 0
    const totalCustomers = rsms.reduce((s, r) => s + r.customers, 0)

    // Account health per RSM
    const account_health = rsms.map(r => ({
      rsm: r.name,
      region: r.region,
      customers: r.customers,
      silent: r.silent,
      neg_margin: r.neg_margin
    }))

    const result = {
      evp: {
        name: 'Joel Durano',
        ytd_vol: totalYTD,
        speed: totalSpeed,
        gm_ton: totalGMTon,
        customers_count: totalCustomers,
        rsm_count: rsms.length,
        dsm_count: repSales.length - rsms.length
      },
      rsms,
      performance_matrix,
      account_health
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [team]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
