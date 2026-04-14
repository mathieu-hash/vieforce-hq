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
        W.WhsCode                                   AS plant_code,
        W.WhsName                                   AS plant_name,
        ISNULL(SUM(IW.OnHand), 0)                   AS total_on_hand,
        ISNULL(SUM(IW.IsCommited), 0)               AS total_committed,
        ISNULL(SUM(IW.OnOrder), 0)                  AS total_on_order,
        ISNULL(SUM(IW.OnHand - IW.IsCommited), 0)   AS total_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      WHERE W.Inactive = 'N'
        ${plantFilter}
      GROUP BY W.WhsCode, W.WhsName
      ORDER BY W.WhsCode
    `, { plant })

    // --- Item-level detail ---
    const items = await query(`
      SELECT
        W.WhsCode                            AS plant_code,
        W.WhsName                            AS plant_name,
        IW.ItemCode                          AS item_code,
        I.ItemName                           AS item_name,
        ISNULL(IW.OnHand, 0)                AS qty_on_hand,
        ISNULL(IW.IsCommited, 0)            AS qty_committed,
        ISNULL(IW.OnOrder, 0)               AS qty_on_order,
        ISNULL(IW.OnHand - IW.IsCommited, 0) AS qty_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      INNER JOIN OITM I  ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        ${plantFilter}
      ORDER BY W.WhsCode, I.ItemName
    `, { plant })

    const result = { plants, items }

    cache.set(cacheKey, result, 900)
    res.json(result)
  } catch (err) {
    console.error('API error [inventory]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
