const { query } = require('./_db')
const { verifySession, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `customers_v2_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { search = '', region = 'ALL', page = '1', limit = '50', sort = 'revenue' } = req.query
    const pageNum  = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50))
    const offset   = (pageNum - 1) * limitNum

    let baseWhere = `WHERE T0.CardType = 'C'`
    if (search) baseWhere += ` AND T0.CardName LIKE '%' + @search + '%'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // Region filter applied on derived region column
    const regionFilter = region && region !== 'ALL' ? ` AND dom_region = @region` : ''

    // Main query — one row per customer, with derived region (dominant WhsCode across YTD invoices),
    // BU classification (inferred from OCRD.GroupCode UDF or CardName prefix), and YTD gm_ton.
    const customers = await query(`
      WITH CustomerYTD AS (
        SELECT
          T0.CardCode,
          T0.CardName,
          T0.Phone1,
          T0.City,
          MAX(C.U_BpStatus)                                                   AS bp_status,
          MAX(C.frozenFor)                                                    AS frozen_for,
          MAX(S.SlpName)                                                      AS rsm,
          ISNULL(SUM(T1.LineTotal), 0)                                        AS ytd_revenue,
          ISNULL(SUM(T1.Quantity), 0)                                         AS ytd_bags,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)       AS ytd_volume,
          ISNULL(SUM(T1.GrssProfit), 0)                                       AS ytd_gm,
          MAX(TI.DocDate)                                                      AS last_order_date,
          -- Dominant WhsCode (most-invoiced plant) → region
          (SELECT TOP 1
            CASE
              WHEN T2.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
              WHEN T2.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
              WHEN T2.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
              ELSE 'Other'
            END
           FROM OINV TI2
           INNER JOIN INV1 T2 ON T2.DocEntry = TI2.DocEntry
           WHERE TI2.CardCode = T0.CardCode AND TI2.CANCELED = 'N'
             AND TI2.DocDate >= DATEADD(YEAR, -1, GETDATE())
           GROUP BY
             CASE
              WHEN T2.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
              WHEN T2.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
              WHEN T2.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
              ELSE 'Other'
             END
           ORDER BY SUM(T2.LineTotal) DESC
          ) AS dom_region
        FROM OCRD T0
        LEFT JOIN OINV TI ON TI.CardCode = T0.CardCode
          AND TI.DocDate >= DATEADD(YEAR, -1, GETDATE())
          AND TI.CANCELED = 'N'
        LEFT JOIN INV1 T1 ON T1.DocEntry = TI.DocEntry
        LEFT JOIN OITM I  ON T1.ItemCode = I.ItemCode
        LEFT JOIN OSLP S  ON TI.SlpCode = S.SlpCode
        LEFT JOIN OCRD C  ON T0.CardCode = C.CardCode
        ${filteredWhere}
        GROUP BY T0.CardCode, T0.CardName, T0.Phone1, T0.City
      )
      SELECT
        CardCode, CardName, Phone1, City, bp_status, frozen_for, rsm,
        ytd_revenue, ytd_bags, ytd_volume,
        CASE WHEN ytd_volume > 0 THEN ytd_gm / ytd_volume ELSE 0 END AS ytd_gm_ton,
        last_order_date,
        ISNULL(dom_region, 'Other') AS region,
        -- BU classifier: PET if name contains pet brand; else DIST (default)
        CASE
          WHEN UPPER(CardName) LIKE '%PET%' OR UPPER(CardName) LIKE '%KEOS%' THEN 'PET'
          ELSE 'DIST'
        END AS bu,
        -- Status classifier
        CASE
          WHEN frozen_for = 'Y' OR bp_status IN ('Delinquent','InActive') THEN 'Delinquent'
          WHEN ytd_revenue = 0 THEN 'Dormant'
          ELSE 'Active'
        END AS status
      FROM CustomerYTD
      WHERE 1=1 ${regionFilter}
      ORDER BY
        CASE WHEN @sort = 'revenue' THEN ytd_revenue END DESC,
        CASE WHEN @sort = 'volume'  THEN ytd_volume  END DESC,
        CASE WHEN @sort = 'name'    THEN CardName    END ASC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, { search, region, sort, offset, limit: limitNum })

    const countRows = await query(`
      SELECT COUNT(*) AS total
      FROM OCRD T0
      LEFT JOIN OCRD C ON T0.CardCode = C.CardCode
      ${filteredWhere}
    `, { search })
    const total = countRows[0]?.total || 0
    const pages = Math.ceil(total / limitNum)

    const result = { customers, total, page: pageNum, pages, limit: limitNum }
    cache.set(cacheKey, result, 600)
    res.json(result)
  } catch (err) {
    console.error('API error [customers]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
