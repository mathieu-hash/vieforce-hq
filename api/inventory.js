const { query } = require('./_db')
const { verifySession } = require('./_auth')
const cache = require('../lib/cache')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `inventory_v2_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { plant = 'ALL' } = req.query
    const plantFilter = plant === 'ALL' ? '' : 'AND W.WhsCode = @plant'

    // --- Plant-level summary (bags + MT) ---
    const plants = await query(`
      SELECT
        W.WhsCode                                                              AS plant_code,
        W.WhsName                                                              AS plant_name,
        ISNULL(SUM(IW.OnHand), 0)                                              AS on_hand_bags,
        ISNULL(SUM(IW.IsCommited), 0)                                          AS committed_bags,
        ISNULL(SUM(IW.OnOrder), 0)                                             AS on_order_bags,
        ISNULL(SUM(IW.OnHand - IW.IsCommited), 0)                              AS available_bags,
        ISNULL(SUM(IW.OnHand * ISNULL(I.NumInSale, 1)) / 1000.0, 0)            AS total_on_hand,
        ISNULL(SUM(IW.IsCommited * ISNULL(I.NumInSale, 1)) / 1000.0, 0)        AS total_committed,
        ISNULL(SUM(IW.OnOrder * ISNULL(I.NumInSale, 1)) / 1000.0, 0)           AS total_on_order,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS total_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND UPPER(IW.ItemCode) LIKE 'FG%'   -- FINISHED GOODS only (match itemized classifier)
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
        ISNULL(IW.OnHand, 0)                                            AS on_hand_bags,
        ISNULL(IW.IsCommited, 0)                                        AS committed_bags,
        ISNULL(IW.OnOrder, 0)                                           AS on_order_bags,
        ISNULL(IW.OnHand - IW.IsCommited, 0)                            AS available_bags,
        ISNULL(IW.OnHand * ISNULL(I.NumInSale, 1) / 1000.0, 0)          AS qty_on_hand,
        ISNULL(IW.IsCommited * ISNULL(I.NumInSale, 1) / 1000.0, 0)      AS qty_committed,
        ISNULL(IW.OnOrder * ISNULL(I.NumInSale, 1) / 1000.0, 0)         AS qty_on_order,
        ISNULL((IW.OnHand - IW.IsCommited) * ISNULL(I.NumInSale, 1) / 1000.0, 0) AS qty_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      INNER JOIN OITM I  ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        AND UPPER(IW.ItemCode) LIKE 'FG%'
        ${plantFilter}
      ORDER BY W.WhsCode, I.ItemName
    `, { plant })

    // --- By region (bags + MT) ---
    const by_region = await query(`
      SELECT
        CASE
          WHEN W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(IW.OnHand), 0)                                          AS on_hand_bags,
        ISNULL(SUM(IW.IsCommited), 0)                                      AS committed_bags,
        ISNULL(SUM(IW.OnOrder), 0)                                         AS on_order_bags,
        ISNULL(SUM(IW.OnHand - IW.IsCommited), 0)                          AS available_bags,
        ISNULL(SUM(IW.OnHand * ISNULL(I.NumInSale, 1)) / 1000.0, 0)       AS on_hand,
        ISNULL(SUM(IW.IsCommited * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS committed,
        ISNULL(SUM(IW.OnOrder * ISNULL(I.NumInSale, 1)) / 1000.0, 0)      AS on_order,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND UPPER(IW.ItemCode) LIKE 'FG%'
      GROUP BY
        CASE
          WHEN W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END
      ORDER BY region
    `)

    // --- By sales group (based on ItemName first-word for feed segmentation) ---
    // SAP OITB groups are organisational (FINISHED GOODS / RAW MATERIALS) not feed-ops
    // (HOGS/POULTRY/GAMEFOWL). Group by ItemName prefix instead.
    const by_sales_group = await query(`
      SELECT
        CASE
          WHEN UPPER(I.ItemName) LIKE '%HOG%' OR UPPER(I.ItemName) LIKE '%PIGLET%' OR UPPER(I.ItemName) LIKE '%SOW%' OR UPPER(I.ItemName) LIKE '%BOAR%' THEN 'HOGS'
          WHEN UPPER(I.ItemName) LIKE '%LAYER%' OR UPPER(I.ItemName) LIKE '%BROILER%' OR UPPER(I.ItemName) LIKE '%CHICK%' OR UPPER(I.ItemName) LIKE '%POULTRY%' OR UPPER(I.ItemName) LIKE '%DUCK%' THEN 'POULTRY'
          WHEN UPPER(I.ItemName) LIKE '%GAMEFOWL%' OR UPPER(I.ItemName) LIKE '%MUSCLY%' THEN 'GAMEFOWL'
          WHEN UPPER(I.ItemName) LIKE '%KEOS%' OR UPPER(I.ItemName) LIKE '%PLAISIR%' OR UPPER(I.ItemName) LIKE '%NOVOPET%' THEN 'PET'
          WHEN UPPER(I.ItemName) LIKE '%VANA%' OR UPPER(I.ItemName) LIKE '%SHRIMP%' THEN 'AQUA'
          ELSE 'OTHERS'
        END                                                                AS group_name,
        ISNULL(SUM(IW.OnHand), 0)                                          AS on_hand_bags,
        ISNULL(SUM(IW.IsCommited), 0)                                      AS committed_bags,
        ISNULL(SUM(IW.OnOrder), 0)                                         AS on_order_bags,
        ISNULL(SUM(IW.OnHand - IW.IsCommited), 0)                          AS available_bags,
        ISNULL(SUM(IW.OnHand * ISNULL(I.NumInSale, 1)) / 1000.0, 0)       AS on_hand_mt
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND UPPER(IW.ItemCode) LIKE 'FG%'
      GROUP BY
        CASE
          WHEN UPPER(I.ItemName) LIKE '%HOG%' OR UPPER(I.ItemName) LIKE '%PIGLET%' OR UPPER(I.ItemName) LIKE '%SOW%' OR UPPER(I.ItemName) LIKE '%BOAR%' THEN 'HOGS'
          WHEN UPPER(I.ItemName) LIKE '%LAYER%' OR UPPER(I.ItemName) LIKE '%BROILER%' OR UPPER(I.ItemName) LIKE '%CHICK%' OR UPPER(I.ItemName) LIKE '%POULTRY%' OR UPPER(I.ItemName) LIKE '%DUCK%' THEN 'POULTRY'
          WHEN UPPER(I.ItemName) LIKE '%GAMEFOWL%' OR UPPER(I.ItemName) LIKE '%MUSCLY%' THEN 'GAMEFOWL'
          WHEN UPPER(I.ItemName) LIKE '%KEOS%' OR UPPER(I.ItemName) LIKE '%PLAISIR%' OR UPPER(I.ItemName) LIKE '%NOVOPET%' THEN 'PET'
          WHEN UPPER(I.ItemName) LIKE '%VANA%' OR UPPER(I.ItemName) LIKE '%SHRIMP%' THEN 'AQUA'
          ELSE 'OTHERS'
        END
      ORDER BY on_hand_bags DESC
    `)

    // --- Negative available count ---
    const negRow = await query(`
      SELECT COUNT(*) AS negative_count
      FROM OITW IW
      INNER JOIN OWHS W ON IW.WhsCode = W.WhsCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        AND (IW.OnHand - IW.IsCommited) < 0
        AND UPPER(IW.ItemCode) LIKE 'FG%'
    `)

    // --- ON PRODUCTION (from OWOR work orders, Status = 'R' = Released/in-progress) ---
    // OWOR.Warehouse is the target warehouse where FG will be deposited.
    // bags_in_production = PlannedQty - CmpltQty for each open work order.
    // Status: P=Planned (not yet started), R=Released (active), L=Closed, C=Cancelled.
    // We count only 'R' (actively running). If Mat wants to include 'P' (Planned), flip below.
    const production = await query(`
      SELECT
        W.Warehouse                                        AS plant_code,
        ISNULL(SUM(W.PlannedQty - W.CmpltQty), 0)          AS bags_in_production,
        ISNULL(SUM((W.PlannedQty - W.CmpltQty) * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mt_in_production
      FROM OWOR W
      LEFT JOIN OITM I ON W.ItemCode = I.ItemCode
      WHERE W.Status = 'R'
        AND UPPER(W.ItemCode) LIKE 'FG%'
        AND W.PlannedQty > W.CmpltQty
      GROUP BY W.Warehouse
    `).catch(e => { console.warn('[inventory] OWOR query failed:', e.message); return [] })

    const prodMap = {}
    for (const row of production) {
      prodMap[row.plant_code] = {
        bags: Number(row.bags_in_production || 0),
        mt:   Number(row.mt_in_production || 0)
      }
    }
    // Merge production into each plant row
    for (const p of plants) {
      const prod = prodMap[p.plant_code] || { bags: 0, mt: 0 }
      p.in_production_bags = Math.round(prod.bags)
      p.in_production_mt   = Math.round(prod.mt * 10) / 10
    }
    // Merge production into by_region
    const regionOf = (wh) => {
      if (['AC','ACEXT','BAC'].includes(wh)) return 'Luzon'
      if (['HOREB','ARGAO','ALAE'].includes(wh)) return 'Visayas'
      if (['BUKID','CCPC'].includes(wh)) return 'Mindanao'
      return 'Other'
    }
    const regionProdMap = {}
    for (const [wh, v] of Object.entries(prodMap)) {
      const r = regionOf(wh)
      regionProdMap[r] = regionProdMap[r] || { bags: 0, mt: 0 }
      regionProdMap[r].bags += v.bags
      regionProdMap[r].mt   += v.mt
    }
    for (const r of by_region) {
      const prod = regionProdMap[r.region] || { bags: 0, mt: 0 }
      r.in_production_bags = Math.round(prod.bags)
      r.in_production_mt   = Math.round(prod.mt * 10) / 10
    }
    const totalInProductionBags = Object.values(prodMap).reduce((s, v) => s + v.bags, 0)
    const totalInProductionMt   = Object.values(prodMap).reduce((s, v) => s + v.mt, 0)

    // --- Cover days (national: total on-hand / avg daily shipment last 30d) ---
    const dailyShip = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0 / 30.0, 0) AS avg_daily
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(DAY, -30, GETDATE()) AND T0.CANCELED = 'N'
    `)

    // --- Summary totals (for KPI strip) ---
    const totalOnHand    = plants.reduce((s, p) => s + Number(p.total_on_hand || 0), 0)
    const totalOnHandBags= plants.reduce((s, p) => s + Number(p.on_hand_bags || 0), 0)
    const totalPoBags    = plants.reduce((s, p) => s + Number(p.on_order_bags || 0), 0)
    const totalAvailBags = plants.reduce((s, p) => s + Number(p.available_bags || 0), 0)
    const avgDaily       = dailyShip[0]?.avg_daily || 1
    const nationalCoverDays = Math.round(totalOnHand / avgDaily)
    const plantsNegative = plants.filter(p => Number(p.available_bags || 0) < 0).length

    // Grand-total available clamps to 0 (can't sell less than nothing on aggregate).
    // Per-plant / per-region keep negatives — they're actionable shortage signals.
    const aggAvailBags = Math.max(0, Math.round(totalAvailBags))
    const aggAvailMt   = Math.max(0, Math.round(plants.reduce((s, p) => s + Number(p.total_available || 0), 0) * 10) / 10)
    const summary = {
      // Bags (the UI's default display unit)
      on_floor:        Math.round(totalOnHandBags),
      pending_po:      Math.round(totalPoBags),
      on_production:   Math.round(totalInProductionBags),
      available:       aggAvailBags,
      cover_days:      nationalCoverDays,
      negative_avail_count: plantsNegative,
      // MT equivalents for unit toggle
      on_floor_mt:     Math.round(totalOnHand * 10) / 10,
      pending_po_mt:   Math.round(plants.reduce((s, p) => s + Number(p.total_on_order || 0), 0) * 10) / 10,
      on_production_mt:Math.round(totalInProductionMt * 10) / 10,
      available_mt:    aggAvailMt
    }

    const result = {
      summary,
      plants,
      items,
      by_region,
      by_sales_group,
      negative_avail_count: negRow[0]?.negative_count || 0,
      cover_days: { national: nationalCoverDays },
      last_updated: new Date().toISOString()
    }

    cache.set(cacheKey, result, 900)
    res.json(result)
  } catch (err) {
    console.error('API error [inventory]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
