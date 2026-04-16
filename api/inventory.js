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

  // Cache check
  const cacheKey = `inventory_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { plant = 'ALL' } = req.query

    // --- Plant-level summary ---
    const plantFilter = plant === 'ALL' ? '' : 'AND W.WhsCode = @plant'

    const plants = await query(`
      SELECT
        W.WhsCode                                                              AS plant_code,
        W.WhsName                                                              AS plant_name,
        ISNULL(SUM(IW.OnHand * ISNULL(I.NumInSale, 1)) / 1000.0, 0)            AS total_on_hand,
        ISNULL(SUM(IW.IsCommited * ISNULL(I.NumInSale, 1)) / 1000.0, 0)        AS total_committed,
        ISNULL(SUM(IW.OnOrder * ISNULL(I.NumInSale, 1)) / 1000.0, 0)           AS total_on_order,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS total_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        ${plantFilter}
      GROUP BY W.WhsCode, W.WhsName
      ORDER BY W.WhsCode
    `, { plant })

    // --- Item-level detail ---
    const items = await query(`
      SELECT
        W.WhsCode                                                       AS plant_code,
        W.WhsName                                                       AS plant_name,
        IW.ItemCode                                                     AS item_code,
        I.ItemName                                                      AS item_name,
        ISNULL(IW.OnHand * ISNULL(I.NumInSale, 1) / 1000.0, 0)          AS qty_on_hand,
        ISNULL(IW.IsCommited * ISNULL(I.NumInSale, 1) / 1000.0, 0)      AS qty_committed,
        ISNULL(IW.OnOrder * ISNULL(I.NumInSale, 1) / 1000.0, 0)         AS qty_on_order,
        ISNULL((IW.OnHand - IW.IsCommited) * ISNULL(I.NumInSale, 1) / 1000.0, 0) AS qty_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      INNER JOIN OITM I  ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        ${plantFilter}
      ORDER BY W.WhsCode, I.ItemName
    `, { plant })

    // --- By region ---
    const by_region = await query(`
      SELECT
        CASE
          WHEN W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(IW.OnHand * ISNULL(I.NumInSale, 1)) / 1000.0, 0)       AS on_hand,
        ISNULL(SUM(IW.IsCommited * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS committed,
        ISNULL(SUM(IW.OnOrder * ISNULL(I.NumInSale, 1)) / 1000.0, 0)      AS on_order,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
      GROUP BY
        CASE
          WHEN W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END
      ORDER BY region
    `)

    // --- Negative available count ---
    const negRow = await query(`
      SELECT COUNT(*) AS negative_count
      FROM OITW IW
      INNER JOIN OWHS W ON IW.WhsCode = W.WhsCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        AND (IW.OnHand - IW.IsCommited) < 0
    `)

    // --- Cover days (national avg: total on-hand / avg daily shipment from ODLN last 30d) ---
    const dailyShip = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0 / 30.0, 0) AS avg_daily
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(DAY, -30, GETDATE()) AND T0.CANCELED = 'N'
    `)

    const totalOnHand = plants.reduce((s, p) => s + p.total_on_hand, 0)
    const avgDaily = dailyShip[0]?.avg_daily || 1
    const national_cover_days = Math.round(totalOnHand / avgDaily)

    const result = {
      plants,
      items,
      by_region,
      negative_avail_count: negRow[0]?.negative_count || 0,
      cover_days: { national: national_cover_days }
    }

    cache.set(cacheKey, result, 900)
    res.json(result)
  } catch (err) {
    console.error('API error [inventory]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
