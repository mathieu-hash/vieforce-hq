// Lightweight customer typeahead for the C&C Portal.
// Returns customers with open AR balance only — name, code, email, balance.
// Auth: service-token only (HQ_SERVICE_TOKEN). Caller (cc-portal) is the
// internal trust boundary; no user-scope filtering applied here.
const { query } = require('../_db')
const { serverError } = require('../lib/http')
const { verifyServiceToken } = require('../_auth')
const cache = require('../../lib/cache')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifyServiceToken(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const q = (req.query.q || '').toString().trim()
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))

  const cacheKey = `cnc_customers_${q}_${limit}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const search = `%${q}%`
    const rows = await query(`
      SELECT TOP (@limit)
        C.CardCode AS cardCode,
        C.CardName AS cardName,
        C.E_Mail   AS email,
        C.Balance  AS balancePhp
      FROM OCRD C
      WHERE C.CardType = 'C'
        AND C.validFor = 'Y'
        AND C.CardCode NOT LIKE 'CE%'
        AND C.SlpCode <> 1
        AND C.Balance > 0
        AND (@q = '%%' OR C.CardName LIKE @q OR C.CardCode LIKE @q)
      ORDER BY C.CardName
    `, { q: search, limit })

    const customers = rows.map(r => ({
      cardCode:   String(r.cardCode || ''),
      cardName:   String(r.cardName || ''),
      email:      r.email ? String(r.email) : null,
      balancePhp: Number(r.balancePhp || 0)
    }))

    const result = { customers }
    cache.set(cacheKey, result, 60)
    res.json(result)
  } catch (err) {
    return serverError(res, err, 'cnc-customers')
  }
}
