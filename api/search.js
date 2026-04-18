const { query } = require('./_db')
const { verifySession } = require('./_auth')
const cache = require('../lib/cache')
const { isNonCustomer } = require('./lib/non-customer-codes')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { q = '', type = 'customer' } = req.query
  const clean = String(q).trim()
  if (clean.length < 2) return res.json({ results: [], query: clean, type })

  const cacheKey = `search_${type}_${clean.toLowerCase()}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    if (type !== 'customer') {
      return res.json({ results: [], query: clean, type, note: 'Only type=customer supported in v1' })
    }

    // TOP 8 customer matches with region + ytd volume + sales rep.
    // Region via dominant-WhsCode subquery; ytd_volume via YTD invoice sum.
    // NOTE: parameterised LIKE is safe; wrapping with '%' concatenated via SQL string builder.
    const rows = await query(`
      SELECT TOP 8
        C.CardCode,
        C.CardName,
        S.SlpName AS sales_rep,
        ISNULL((
          SELECT SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0
          FROM OINV T0
          INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
          LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
          WHERE T0.CardCode = C.CardCode
            AND T0.CANCELED = 'N'
            AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
        ), 0) AS ytd_volume,
        (SELECT TOP 1
          CASE
            WHEN T2.WhsCode IN ('AC','ACEXT','BAC')   THEN 'Luzon'
            WHEN T2.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
            WHEN T2.WhsCode IN ('BUKID','CCPC')        THEN 'Mindanao'
            ELSE 'Other'
          END
         FROM OINV TI2
         INNER JOIN INV1 T2 ON T2.DocEntry = TI2.DocEntry
         WHERE TI2.CardCode = C.CardCode AND TI2.CANCELED = 'N'
           AND TI2.DocDate >= DATEADD(YEAR, -1, GETDATE())
         GROUP BY
           CASE
             WHEN T2.WhsCode IN ('AC','ACEXT','BAC')   THEN 'Luzon'
             WHEN T2.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
             WHEN T2.WhsCode IN ('BUKID','CCPC')        THEN 'Mindanao'
             ELSE 'Other'
           END
         ORDER BY SUM(T2.LineTotal) DESC
        ) AS region
      FROM OCRD C
      LEFT JOIN OSLP S ON C.SlpCode = S.SlpCode
      WHERE C.CardType = 'C'
        AND (UPPER(C.CardCode) LIKE '%' + UPPER(@q) + '%'
          OR UPPER(C.CardName) LIKE '%' + UPPER(@q) + '%')
      ORDER BY
        CASE WHEN UPPER(C.CardCode) = UPPER(@q) THEN 0
             WHEN UPPER(C.CardName) LIKE UPPER(@q) + '%' THEN 1
             ELSE 2 END,
        C.CardName
    `, { q: clean })

    const results = rows
      .filter(r => !isNonCustomer(r.CardCode))
      .map(r => ({
        code:       r.CardCode,
        name:       r.CardName,
        region:     r.region || 'Other',
        ytd_volume: Math.round(Number(r.ytd_volume || 0) * 10) / 10,
        sales_rep:  r.sales_rep || ''
      }))

    const payload = { results, query: clean, type, count: results.length }
    cache.set(cacheKey, payload, 30)
    res.json(payload)
  } catch (err) {
    console.error('API error [search]:', err.message)
    res.status(500).json({ error: 'Search error', detail: err.message })
  }
}
