const { query } = require('./_db')
const { verifySession } = require('./_auth')
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

  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'Missing required parameter: id' })

  // Cache check
  const cacheKey = `customer_${id}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // --- Customer info from OCRD ---
    const infoRows = await query(`
      SELECT
        T0.CardCode,
        T0.CardName,
        T0.Phone1,
        T0.Phone2,
        T0.Cellular,
        T0.E_Mail    AS email,
        T0.City,
        T0.Address,
        T0.SlpCode,
        S.SlpName    AS rsm
      FROM OCRD T0
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      WHERE T0.CardCode = @id
        AND T0.CardType = 'C'
    `, { id })

    if (!infoRows.length) {
      return res.status(404).json({ error: 'Customer not found' })
    }

    const info = infoRows[0]

    // --- YTD Sales summary ---
    const ytdRows = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0)  AS revenue,
        ISNULL(SUM(T1.Quantity), 0)   AS volume,
        COUNT(DISTINCT T0.DocEntry)   AS orders_count
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
    `, { id })

    const ytd_sales = {
      revenue:      ytdRows[0]?.revenue || 0,
      volume:       ytdRows[0]?.volume || 0,
      orders_count: ytdRows[0]?.orders_count || 0
    }

    // --- AR: unpaid invoices ---
    const ar_invoices = await query(`
      SELECT
        T0.DocNum,
        T0.DocDate,
        T0.DocDueDate,
        T0.DocTotal,
        T0.PaidToDate,
        T0.DocTotal - T0.PaidToDate                    AS balance,
        DATEDIFF(DAY, T0.DocDueDate, GETDATE())        AS days_overdue
      FROM OINV T0
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
        AND T0.DocTotal > T0.PaidToDate
      ORDER BY T0.DocDueDate ASC
    `, { id })

    // --- Product breakdown (YTD by item) ---
    const product_breakdown = await query(`
      SELECT
        T1.ItemCode,
        T1.Dscription                     AS item_name,
        ISNULL(SUM(T1.Quantity), 0)       AS volume,
        ISNULL(SUM(T1.LineTotal), 0)      AS revenue,
        ISNULL(AVG(T1.GrssProfit / NULLIF(T1.Quantity, 0)), 0) AS gmt
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
      GROUP BY T1.ItemCode, T1.Dscription
      ORDER BY volume DESC
    `, { id })

    // --- Recent orders (last 10) ---
    const recent_orders = await query(`
      SELECT TOP 10
        T0.DocNum,
        T0.DocDate,
        T0.DocTotal,
        T0.DocStatus,
        T0.PaidToDate,
        (SELECT ISNULL(SUM(T1.Quantity), 0) FROM INV1 T1 WHERE T1.DocEntry = T0.DocEntry) AS total_qty
      FROM OINV T0
      WHERE T0.CardCode = @id
        AND T0.CANCELED = 'N'
      ORDER BY T0.DocDate DESC
    `, { id })

    const result = {
      info,
      ytd_sales,
      ar_invoices,
      product_breakdown,
      recent_orders
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [customer]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
