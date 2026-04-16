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

  // Cache check
  const cacheKey = `customers_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { search = '', region = 'ALL', page = '1', limit = '50' } = req.query

    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50))
    const offset = (pageNum - 1) * limitNum

    // Build WHERE clause
    let baseWhere = `WHERE T0.CardType = 'C'`
    if (search) {
      baseWhere += ` AND T0.CardName LIKE '%' + @search + '%'`
    }
    // SAFETY: applyRoleFilter uses session data from Supabase (not user input)
    // Note: role filter references T0 which here is OCRD — the applyRoleFilter
    // checks U_Region on OCRD and SlpName on OSLP via join
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- Count total ---
    const countRows = await query(`
      SELECT COUNT(*) AS total
      FROM OCRD T0
      ${filteredWhere}
    `, { search })

    const total = countRows[0]?.total || 0
    const pages = Math.ceil(total / limitNum)

    // --- Customer list with YTD aggregates ---
    const customers = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        T0.Phone1,
        T0.City,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS ytd_revenue,
        ISNULL(SUM(T1.Quantity), 0)                                       AS ytd_bags,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS ytd_volume,
        MAX(TI.DocDate)                                                    AS last_order_date
      FROM OCRD T0
      LEFT JOIN OINV TI ON TI.CardCode = T0.CardCode
        AND TI.DocDate >= DATEADD(YEAR, -1, GETDATE())
        AND TI.CANCELED = 'N'
      LEFT JOIN INV1 T1 ON T1.DocEntry = TI.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY T0.CardCode, T0.CardName, T0.Phone1, T0.City
      ORDER BY ytd_revenue DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, { search, offset, limit: limitNum })

    const result = {
      customers,
      total,
      page: pageNum,
      pages
    }

    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [customers]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
