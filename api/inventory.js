const { query } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { scopeForUser } = require('./_scope')
const cache = require('../lib/cache')
const { normalizeRegion, normalizeSegment, regionFilterSql } = require('./lib/business_filters')

// Inventory has no customer/doc alias (no OINV/OCRD), so segment can only be
// narrowed by ItemName. Of the commercial segments (DIST/KA/PET), only PET is
// derivable from the product name — KA vs DIST is a customer attribute that
// inventory stock rows don't carry. So PET narrows; KA/DIST/ALL = no narrowing
// (returns '' → byte-identical to today). Mirrors the by_sales_group PET classifier.
function segmentItemFilter(segment, itemAlias = 'I') {
  const s = normalizeSegment(segment)
  if (s !== 'PET') return ''
  const nameExpr = `UPPER(${itemAlias}.ItemName)`
  return ` AND (${nameExpr} LIKE '%KEOS%' OR ${nameExpr} LIKE '%PLAISIR%' OR ${nameExpr} LIKE '%NOVOPET%')`
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — service-token first (Patrol S2S), fall back to user session.
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Parse optional scope=user:<uuid>. Resolved for response metadata ONLY —
  // inventory is plant-based (WhsCode), not customer-based (CardCode/SlpCode),
  // so every caller sees the full national dataset regardless of scope.
  // No zero-state short-circuit on is_empty: a DSM without sap_slpcode still
  // needs inventory visibility to check stock before promising customers.
  // Field-rep region scoping (Luzon DSM → Luzon plants only) is deferred
  // until a field rep complains; not in this phase.
  let scope = null
  const scopeParam = req.query.scope
  if (scopeParam && typeof scopeParam === 'string' && scopeParam.startsWith('user:')) {
    const uuid = scopeParam.slice(5).trim()
    if (uuid) {
      try {
        scope = await scopeForUser(uuid)
      } catch (err) {
        console.error('[inventory] scope resolve failed:', err.message)
        scope = { userId: uuid, error: 'scope_resolve_failed', is_empty: true,
                  slpCodes: [], districtCodes: [] }
      }
    }
  }

  // Cache key includes req.url (which encodes the scope param) so a scoped
  // call and an unscoped call get separate envelopes — prevents the scope
  // meta field from leaking into / out of the cached response incorrectly.
  const reqRegion = normalizeRegion(req.query.region)
  const reqSegment = normalizeSegment(req.query.segment)
  const cacheKey = `inventory_v2_${req.url}_${reqRegion}_${reqSegment}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { plant = 'ALL' } = req.query
    const plantFilter = plant === 'ALL' ? '' : 'AND W.WhsCode = @plant'

    // Topbar Region/Segment narrowing (ADD-only; ALL/ALL = byte-identical to before).
    // Region keys off the WhsCode line alias 'W' (OWHS). Segment keys off ItemName 'I'
    // (OITM) since inventory carries no customer/doc alias. regionFilterSql / segmentItemFilter
    // both return '' for the ALL case, so we only ever append.
    const region = reqRegion
    const segment = reqSegment
    const regionFilter = regionFilterSql(region, 'W')      // ' AND <case> = @region' or ''
    const segmentFilter = segmentItemFilter(segment, 'I')  // ' AND <ItemName preds>' or ''
    const narrowFilters = regionFilter + segmentFilter
    const params = { plant, region }

    // --- Plant-level summary (bags + MT) ---
    // UoM facts (SAP-verified): OITW.OnHand is in KILO for weight-UoM items
    // (OITM.InvntryUom='KILO'). MT = OnHand/1000. Bags = OnHand/NumInSale (kg per
    // 50KG/BAG sales unit). The MT aggregates are guarded to KILO items only so
    // piece/vial SKUs (vet/additives) don't pollute tonnage; bag counts include
    // all FG rows but divide by the item's own NumInSale.
    const plants = await query(`
      SELECT
        W.WhsCode                                                              AS plant_code,
        W.WhsName                                                              AS plant_name,
        ISNULL(SUM(IW.OnHand / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)                     AS on_hand_bags,
        ISNULL(SUM(IW.IsCommited / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)                 AS committed_bags,
        ISNULL(SUM(IW.OnOrder / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)                    AS on_order_bags,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)   AS available_bags,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnHand END) / 1000.0, 0)                  AS total_on_hand,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.IsCommited END) / 1000.0, 0)              AS total_committed,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnOrder END) / 1000.0, 0)                 AS total_on_order,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN (IW.OnHand - IW.IsCommited) END) / 1000.0, 0) AS total_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND UPPER(IW.ItemCode) LIKE 'FG%'   -- FINISHED GOODS only (match itemized classifier)
        ${plantFilter}
        ${narrowFilters}
      GROUP BY W.WhsCode, W.WhsName
      ORDER BY W.WhsCode
    `, params)

    // --- Item-level detail ---
    const items = await query(`
      SELECT
        W.WhsCode                                                       AS plant_code,
        W.WhsName                                                       AS plant_name,
        IW.ItemCode                                                     AS item_code,
        I.ItemName                                                      AS item_name,
        ISNULL(IW.OnHand / NULLIF(ISNULL(I.NumInSale, 1), 0), 0)                  AS on_hand_bags,
        ISNULL(IW.IsCommited / NULLIF(ISNULL(I.NumInSale, 1), 0), 0)              AS committed_bags,
        ISNULL(IW.OnOrder / NULLIF(ISNULL(I.NumInSale, 1), 0), 0)                 AS on_order_bags,
        ISNULL((IW.OnHand - IW.IsCommited) / NULLIF(ISNULL(I.NumInSale, 1), 0), 0) AS available_bags,
        ISNULL(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnHand / 1000.0 ELSE 0 END, 0)                  AS qty_on_hand,
        ISNULL(CASE WHEN I.InvntryUom = 'KILO' THEN IW.IsCommited / 1000.0 ELSE 0 END, 0)              AS qty_committed,
        ISNULL(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnOrder / 1000.0 ELSE 0 END, 0)                 AS qty_on_order,
        ISNULL(CASE WHEN I.InvntryUom = 'KILO' THEN (IW.OnHand - IW.IsCommited) / 1000.0 ELSE 0 END, 0) AS qty_available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      INNER JOIN OITM I  ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        AND UPPER(IW.ItemCode) LIKE 'FG%'
        ${plantFilter}
        ${narrowFilters}
      ORDER BY W.WhsCode, I.ItemName
    `, params)

    // --- By region (bags + MT) ---
    const by_region = await query(`
      SELECT
        CASE
          WHEN W.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN W.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN W.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(IW.OnHand / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)                AS on_hand_bags,
        ISNULL(SUM(IW.IsCommited / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)            AS committed_bags,
        ISNULL(SUM(IW.OnOrder / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)              AS on_order_bags,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0) AS available_bags,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnHand END) / 1000.0, 0)                  AS on_hand,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.IsCommited END) / 1000.0, 0)              AS committed,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnOrder END) / 1000.0, 0)                 AS on_order,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN (IW.OnHand - IW.IsCommited) END) / 1000.0, 0) AS available
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND UPPER(IW.ItemCode) LIKE 'FG%'
        ${segmentFilter}
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
        ISNULL(SUM(IW.OnHand / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)                AS on_hand_bags,
        ISNULL(SUM(IW.IsCommited / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)            AS committed_bags,
        ISNULL(SUM(IW.OnOrder / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0)              AS on_order_bags,
        ISNULL(SUM((IW.OnHand - IW.IsCommited) / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0) AS available_bags,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnHand END) / 1000.0, 0)                  AS on_hand_mt,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.OnOrder END) / 1000.0, 0)                 AS on_order_mt,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN IW.IsCommited END) / 1000.0, 0)              AS committed_mt,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN (IW.OnHand - IW.IsCommited) END) / 1000.0, 0) AS available_mt
      FROM OWHS W
      INNER JOIN OITW IW ON W.WhsCode = IW.WhsCode
      LEFT JOIN OITM I ON IW.ItemCode = I.ItemCode
      WHERE W.Inactive = 'N'
        AND UPPER(IW.ItemCode) LIKE 'FG%'
        ${narrowFilters}
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
    `, { region })

    // --- Negative available count ---
    const negRow = await query(`
      SELECT COUNT(*) AS negative_count
      FROM OITW IW
      INNER JOIN OWHS W ON IW.WhsCode = W.WhsCode
      WHERE W.Inactive = 'N'
        AND IW.OnHand > 0
        AND (IW.OnHand - IW.IsCommited) < 0
        AND UPPER(IW.ItemCode) LIKE 'FG%'
        ${regionFilter}
    `, { region })

    // --- ON PRODUCTION (OWOR work orders, Status='R' = Released/in-progress) ---
    // Split into REAL (DueDate within 30 days) vs STALE (DueDate > 30 days ago — abandoned).
    // Status codes: P=Planned, R=Released (active), L=Closed, C=Cancelled. VPI uses 'R' only.
    // Per-plant, per-region merge uses REAL production only (stale shown as a global badge).
    const production = await query(`
      SELECT
        W.Warehouse                                        AS plant_code,
        CASE WHEN W.DueDate >= DATEADD(DAY, -30, GETDATE()) THEN 'real' ELSE 'stale' END AS bucket,
        COUNT(*)                                           AS wo_count,
        ISNULL(SUM((W.PlannedQty - W.CmpltQty) / NULLIF(ISNULL(I.NumInSale, 1), 0)), 0) AS bags,
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN (W.PlannedQty - W.CmpltQty) END) / 1000.0, 0) AS mt,
        MIN(W.DueDate)                                     AS oldest_due_date
      FROM OWOR W
      LEFT JOIN OITM I ON W.ItemCode = I.ItemCode
      WHERE W.Status = 'R'
        AND UPPER(W.ItemCode) LIKE 'FG%'
        AND W.PlannedQty > W.CmpltQty
      GROUP BY W.Warehouse, CASE WHEN W.DueDate >= DATEADD(DAY, -30, GETDATE()) THEN 'real' ELSE 'stale' END
    `).catch(e => { console.warn('[inventory] OWOR query failed:', e.message); return [] })

    const prodMap = {}   // plant_code -> { bags, mt }  (REAL only, for card merge)
    let totalInProductionBags = 0, totalInProductionMt = 0
    let staleBags = 0, staleMt = 0, staleCount = 0, oldestStaleDays = 0
    const now = Date.now()
    for (const row of production) {
      const bags = Number(row.bags || 0), mt = Number(row.mt || 0)
      if (row.bucket === 'real') {
        prodMap[row.plant_code] = { bags, mt }
        totalInProductionBags += bags
        totalInProductionMt   += mt
      } else {
        staleBags  += bags
        staleMt    += mt
        staleCount += Number(row.wo_count || 0)
        if (row.oldest_due_date) {
          const ageDays = Math.floor((now - new Date(row.oldest_due_date).getTime()) / 86400000)
          if (ageDays > oldestStaleDays) oldestStaleDays = ageDays
        }
      }
    }
    // Merge REAL production into each plant row
    for (const p of plants) {
      const prod = prodMap[p.plant_code] || { bags: 0, mt: 0 }
      p.in_production_bags = Math.round(prod.bags)
      p.in_production_mt   = Math.round(prod.mt * 10) / 10
    }
    // Merge REAL production into by_region
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
    const productionSummary = {
      on_production_bags: Math.round(totalInProductionBags),
      on_production_mt:   Math.round(totalInProductionMt * 10) / 10,
      stale_wo_bags:      Math.round(staleBags),
      stale_wo_mt:        Math.round(staleMt * 10) / 10,
      stale_wo_count:     staleCount,
      oldest_stale_days:  oldestStaleDays
    }

    // --- Cover days (total on-hand / avg daily shipment last 30d) ---
    // Narrow the denominator to the same Region/Segment scope as the on-hand
    // numerator so cover_days stays coherent when scoped. DLN1 line alias 'T1'
    // carries WhsCode (region); OITM 'I' carries ItemName (segment).
    const shipRegionFilter = regionFilterSql(region, 'T1')
    const shipSegmentFilter = segmentItemFilter(segment, 'I')
    const dailyShip = await query(`
      SELECT
        ISNULL(SUM(CASE WHEN I.InvntryUom = 'KILO' THEN T1.Quantity END) / 1000.0 / 30.0, 0) AS avg_daily
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(DAY, -30, GETDATE()) AND T0.CANCELED = 'N'
        ${shipRegionFilter}
        ${shipSegmentFilter}
    `, { region })

    // --- Summary totals (for KPI strip) ---
    const totalOnHand    = plants.reduce((s, p) => s + Number(p.total_on_hand || 0), 0)
    const totalOnHandBags= plants.reduce((s, p) => s + Number(p.on_hand_bags || 0), 0)
    const totalPoBags    = plants.reduce((s, p) => s + Number(p.on_order_bags || 0), 0)
    const totalAvailBags = plants.reduce((s, p) => s + Number(p.available_bags || 0), 0)
    const avgDaily       = dailyShip[0]?.avg_daily || 1
    const nationalCoverDays = Math.round(totalOnHand / avgDaily)
    const plantsNegative = plants.filter(p => Number(p.available_bags || 0) < 0).length

    // Grand-total available is a REAL signed number — committed can exceed on-hand
    // for some SKUs, so a negative aggregate is a genuine shortage signal, not an
    // error. Do NOT clamp to 0 (that masked the live available total as 0).
    const aggAvailBags = Math.round(totalAvailBags)
    const aggAvailMt   = Math.round(plants.reduce((s, p) => s + Number(p.total_available || 0), 0) * 10) / 10
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
      production: productionSummary,
      plants,
      items,
      by_region,
      by_sales_group,
      negative_avail_count: negRow[0]?.negative_count || 0,
      cover_days: { national: nationalCoverDays },
      last_updated: new Date().toISOString()
    }
    // Scope meta — only when the caller passed ?scope=user:<uuid>. The
    // `scope_applied: false` flag is EXPLICIT so Patrol can surface
    // "Showing national inventory" context in the UI. Web dashboard (session
    // auth, no scope param) sees a byte-identical response shape.
    if (scope) {
      result.scope = {
        userId: scope.userId,
        role: scope.role || null,
        is_empty: !!scope.is_empty,
        scope_applied: false,
        scope_applied_reason: 'inventory is national — plant-based, not customer-based'
      }
    }

    cache.set(cacheKey, result, 900)
    res.json(result)
  } catch (err) {
    console.error('API error [inventory]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
