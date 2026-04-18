const { query, queryH } = require('./_db')
const { getCustomerMap, toHistoricalCode } = require('./lib/customer-map')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // LY sanity: end-to-end demonstrates the mapping actually resolves to real LY numbers.
  if (req.query.ly_sanity === '1') {
    try {
      const custCode = req.query.code || 'CA000196'
      const histCode = await toHistoricalCode(custCode)
      const map = await getCustomerMap()

      const curThis = await query(`
        SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol,
               ISNULL(SUM(T1.LineTotal), 0) AS ytd_sales,
               COUNT(DISTINCT T0.DocEntry) AS invoices
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
          AND T0.DocDate >= DATEFROMPARTS(YEAR(GETDATE()), 1, 1)
      `, { id: custCode })

      const histLy = histCode ? await queryH(`
        SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol,
               ISNULL(SUM(T1.LineTotal), 0) AS ytd_sales,
               COUNT(DISTINCT T0.DocEntry) AS invoices
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
          AND T0.DocDate BETWEEN @lyStart AND @lyEnd
      `, {
        id: histCode,
        lyStart: new Date(new Date().getFullYear() - 1, 0, 1),
        lyEnd: new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate())
      }) : null

      const histFullYr = histCode ? await queryH(`
        SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS fy_vol,
               ISNULL(SUM(T1.LineTotal), 0) AS fy_sales
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
          AND YEAR(T0.DocDate) = YEAR(DATEADD(YEAR,-1,GETDATE()))
      `, { id: histCode }) : null

      return res.json({
        _mode: 'ly_sanity_check',
        map_stats: map.counts,
        queried_current_code: custCode,
        resolved_historical_code: histCode,
        current_ytd: curThis[0] || null,
        historical_ly_ytd: histLy ? histLy[0] : null,
        historical_ly_full_year: histFullYr ? histFullYr[0] : null,
        vs_ly_pct: histLy && histLy[0] && Number(histLy[0].ytd_vol) > 0
          ? Math.round(((Number(curThis[0].ytd_vol) - Number(histLy[0].ytd_vol)) / Number(histLy[0].ytd_vol)) * 1000) / 10
          : null
      })
    } catch (err) {
      return res.status(500).json({ error: err.message, stack: err.stack })
    }
  }

  // Customer-mapping probe — investigates whether CardCodes match across DBs
  if (req.query.cust_map === '1') {
    try {
      // Count exact-code overlap
      const overlap = await query(`
        SELECT COUNT(*) AS n
        FROM OCRD CUR
        WHERE CUR.CardType = 'C'
          AND CUR.CardCode IN (SELECT CardCode FROM OPENROWSET(
            'SQLNCLI', 'Server=(local);Trusted_Connection=yes;', 'SELECT CardCode FROM Vienovo_Old.dbo.OCRD'
          ) X)
      `).catch(() => null)

      // Simpler: pull both customer lists and intersect in Node
      const cur = await query(`SELECT CardCode, CardName, CreateDate FROM OCRD WHERE CardType='C'`)
      const hist = await queryH(`SELECT CardCode, CardName, CreateDate FROM OCRD WHERE CardType='C'`)

      const histByCode = new Map(hist.map(r => [r.CardCode, r]))
      const histByName = new Map()
      for (const r of hist) {
        const k = (r.CardName || '').trim().toUpperCase()
        if (k) histByName.set(k, r)
      }

      let codeMatch = 0, nameOnlyMatch = 0, noMatch = 0
      const sampleRekeyed = []   // current code differs from historical code (matched by name)
      const sampleOrphans = []   // current code with no name match in history either
      const fixedMar = []         // when CreateDate >= 2025-12-01 (likely migration-created)
      const oldOnlyCount = hist.length - cur.length  // very rough

      for (const c of cur) {
        if (histByCode.has(c.CardCode)) {
          codeMatch++
          continue
        }
        const k = (c.CardName || '').trim().toUpperCase()
        const h = k ? histByName.get(k) : null
        if (h) {
          nameOnlyMatch++
          if (sampleRekeyed.length < 30) {
            sampleRekeyed.push({
              current_code: c.CardCode, historical_code: h.CardCode,
              name: c.CardName, current_create: c.CreateDate, historical_create: h.CreateDate
            })
          }
        } else {
          noMatch++
          if (sampleOrphans.length < 20) {
            sampleOrphans.push({
              current_code: c.CardCode, name: c.CardName, current_create: c.CreateDate
            })
          }
        }
        if (c.CreateDate && new Date(c.CreateDate) >= new Date('2025-12-01')) fixedMar.push(c.CardCode)
      }

      // Check: how many "active" customers (with 2026 invoices) fall into each bucket?
      const activeCodes = await query(`
        SELECT DISTINCT CardCode FROM OINV
        WHERE CANCELED='N' AND DocDate >= '2026-01-01'
      `)
      const activeSet = new Set(activeCodes.map(r => r.CardCode))
      let activeCodeMatch = 0, activeRekeyed = 0, activeOrphan = 0
      for (const c of cur) {
        if (!activeSet.has(c.CardCode)) continue
        if (histByCode.has(c.CardCode)) { activeCodeMatch++; continue }
        const k = (c.CardName || '').trim().toUpperCase()
        if (k && histByName.get(k)) activeRekeyed++
        else activeOrphan++
      }

      // FALCOR by name in historical
      const falcorHist = await queryH(`
        SELECT CardCode, CardName, CreateDate, Balance
        FROM OCRD WHERE CardName LIKE '%FALCOR%'
      `).catch(() => [])

      return res.json({
        _mode: 'customer_code_mapping_audit',
        totals: {
          current_customers: cur.length,
          historical_customers: hist.length
        },
        all_current_customers: {
          code_match_with_historical: codeMatch,
          name_match_only_rekeyed:    nameOnlyMatch,
          no_match_at_all:            noMatch,
          new_in_2025_12_or_later:    fixedMar.length
        },
        active_2026_customers: {
          total_active:              activeSet.size,
          code_match:                activeCodeMatch,
          rekeyed_name_match:        activeRekeyed,
          no_historical_match:       activeOrphan
        },
        sample_rekeyed_customers: sampleRekeyed,
        sample_no_match: sampleOrphans,
        falcor_in_historical: falcorHist
      })
    } catch (err) {
      return res.status(500).json({ error: err.message, stack: err.stack })
    }
  }

  // Historical DB probe — verifies Vienovo_Old connection, schema parity,
  // yearly volumes, customer continuity with Vienovo_Live
  if (req.query.hist === '1') {
    try {
      const current_db = await query(`SELECT DB_NAME() AS db, @@VERSION AS ver`)
      const historical_db = await queryH(`SELECT DB_NAME() AS db, @@VERSION AS ver`)

      // Schema parity — check key tables exist in historical
      const tables = await queryH(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_NAME IN ('OINV','INV1','OCRD','OITM','ODLN','DLN1','OSLP','OCTG','ORCT','ORDR','RDR1','OWOR','OWHS')
        ORDER BY TABLE_NAME
      `)

      // Invoice counts + revenue per year, 2015-2026
      const perYear = await queryH(`
        SELECT YEAR(DocDate) AS yr,
               COUNT(*) AS invoices,
               COUNT(DISTINCT CardCode) AS customers,
               ISNULL(SUM(DocTotal), 0) AS revenue
        FROM OINV
        WHERE CANCELED = 'N' AND DocDate >= '2015-01-01'
        GROUP BY YEAR(DocDate)
        ORDER BY yr
      `)

      // Volume per year (MT)
      const volPerYear = await queryH(`
        SELECT YEAR(T0.DocDate) AS yr,
               ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS mt
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CANCELED = 'N' AND T0.DocDate >= '2015-01-01'
        GROUP BY YEAR(T0.DocDate)
        ORDER BY yr
      `)

      // Customer overlap
      const histCust = await queryH(`SELECT COUNT(DISTINCT CardCode) AS n FROM OCRD WHERE CardType='C'`)
      const currCust = await query(`SELECT COUNT(DISTINCT CardCode) AS n FROM OCRD WHERE CardType='C'`)

      // CA000196 spot-check (FALCOR MARKETING)
      const spotHist = await queryH(`
        SELECT TOP 1 CardCode, CardName, CreateDate, validFor
        FROM OCRD WHERE CardCode = 'CA000196'
      `).catch(e => ({ error: e.message }))
      const spotCurr = await query(`
        SELECT TOP 1 CardCode, CardName, CreateDate, validFor
        FROM OCRD WHERE CardCode = 'CA000196'
      `).catch(e => ({ error: e.message }))

      // Oct 2025 MT spot (should be non-zero in historical)
      const oct2025 = await queryH(`
        SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS mt,
               COUNT(DISTINCT T0.DocEntry) AS invoices
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CANCELED = 'N'
          AND T0.DocDate >= '2025-10-01' AND T0.DocDate < '2025-11-01'
      `)

      // CA000196 volume history in old DB
      const ca196Hist = await queryH(`
        SELECT YEAR(T0.DocDate) AS yr,
               ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS mt,
               ISNULL(SUM(T1.LineTotal), 0) AS revenue
        FROM OINV T0
        INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        WHERE T0.CardCode = 'CA000196' AND T0.CANCELED = 'N'
        GROUP BY YEAR(T0.DocDate)
        ORDER BY yr
      `)

      // First-ever order date per DB (for account age)
      const firstHist = await queryH(`SELECT MIN(DocDate) AS first_date FROM OINV WHERE CANCELED='N'`)
      const firstCurr = await query(`SELECT MIN(DocDate) AS first_date FROM OINV WHERE CANCELED='N'`)

      return res.json({
        _mode: 'historical_db_probe',
        current: { db: current_db[0]?.db, first_invoice: firstCurr[0]?.first_date },
        historical: { db: historical_db[0]?.db, first_invoice: firstHist[0]?.first_date },
        schema_parity: {
          expected: ['OINV','INV1','OCRD','OITM','ODLN','DLN1','OSLP','OCTG','ORCT','ORDR','RDR1','OWOR','OWHS'],
          found_in_historical: tables.map(t => t.TABLE_NAME)
        },
        yearly_invoices_historical: perYear,
        yearly_volume_historical_mt: volPerYear,
        customers: {
          historical_distinct: histCust[0]?.n || 0,
          current_distinct: currCust[0]?.n || 0
        },
        spot_check_CA000196: {
          historical: spotHist[0] || spotHist,
          current: spotCurr[0] || spotCurr,
          code_match: (spotHist[0]?.CardCode === 'CA000196') && (spotCurr[0]?.CardCode === 'CA000196'),
          historical_yearly: ca196Hist
        },
        oct_2025_sanity: {
          historical_mt: oct2025[0]?.mt || 0,
          historical_invoices: oct2025[0]?.invoices || 0,
          expected: 'non-zero — FY2025 pre-migration data'
        }
      })
    } catch (err) {
      return res.status(500).json({ error: err.message, stack: err.stack })
    }
  }

  try {
    // Check what weight columns exist on OITM
    const oitmCols = await query(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'OITM'
        AND (COLUMN_NAME LIKE '%eight%' OR COLUMN_NAME LIKE '%Wght%' OR COLUMN_NAME LIKE '%Weight%'
             OR COLUMN_NAME LIKE '%Factor%' OR COLUMN_NAME LIKE '%NumIn%' OR COLUMN_NAME LIKE '%Uom%'
             OR COLUMN_NAME LIKE '%UnitMsr%' OR COLUMN_NAME LIKE '%SalUnit%' OR COLUMN_NAME LIKE '%InvntryUom%')
      ORDER BY COLUMN_NAME
    `)

    // Check INV1 weight columns
    const inv1Cols = await query(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'INV1'
        AND (COLUMN_NAME LIKE '%eight%' OR COLUMN_NAME LIKE '%Wght%' OR COLUMN_NAME LIKE '%Weight%'
             OR COLUMN_NAME LIKE '%UnitMsr%' OR COLUMN_NAME LIKE '%Factor%')
      ORDER BY COLUMN_NAME
    `)

    // Sample: check weight values for top 5 items by volume this month
    const sampleItems = await query(`
      SELECT TOP 10
        I.ItemCode,
        I.ItemName,
        I.SWeight1,
        I.BWeight1,
        I.SWght1Unit,
        I.BWght1Unit,
        I.NumInSale,
        I.NumInBuy,
        I.InvntryUom,
        I.SalUnitMsr,
        I.BuyUnitMsr,
        I.SalFactor1,
        I.SalFactor2,
        SUM(T1.Quantity) AS total_qty
      FROM INV1 T1
      INNER JOIN OINV T0 ON T0.DocEntry = T1.DocEntry
      INNER JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(MONTH, -1, GETDATE())
        AND T0.CANCELED = 'N'
      GROUP BY I.ItemCode, I.ItemName, I.SWeight1, I.BWeight1, I.SWght1Unit, I.BWght1Unit,
               I.NumInSale, I.NumInBuy, I.InvntryUom, I.SalUnitMsr, I.BuyUnitMsr, I.SalFactor1, I.SalFactor2
      ORDER BY total_qty DESC
    `)

    // Check ODLN (delivery notes) for speed calc
    const odlnCheck = await query(`
      SELECT TOP 5
        T0.DocDate, T0.DocNum, T0.CardName,
        SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0 AS mt
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(DAY, -7, GETDATE())
        AND T0.CANCELED = 'N'
      GROUP BY T0.DocDate, T0.DocNum, T0.CardName
      ORDER BY T0.DocDate DESC
    `)

    // TEMP: ItemCode probe for itemized endpoint
    const itemProbe = await query(`
      SELECT TOP 20 T1.ItemCode, MAX(T1.Dscription) AS desc1, SUM(T1.Quantity) AS qty
      FROM INV1 T1 INNER JOIN OINV T0 ON T0.DocEntry = T1.DocEntry
      WHERE T0.CANCELED = 'N' AND YEAR(T0.DocDate) = 2026
      GROUP BY T1.ItemCode
      ORDER BY qty DESC
    `)
    const itemCount = await query(`
      SELECT COUNT(DISTINCT T1.ItemCode) AS total_distinct,
             SUM(CASE WHEN UPPER(T1.ItemCode) LIKE 'VPI%' THEN 1 ELSE 0 END) AS vpi_matches
      FROM INV1 T1 INNER JOIN OINV T0 ON T0.DocEntry = T1.DocEntry
      WHERE T0.CANCELED = 'N' AND YEAR(T0.DocDate) = 2026
    `)

    // Daily speed (last 14 days from ODLN)
    const dailySpeed = await query(`
      SELECT
        CONVERT(VARCHAR(10), T0.DocDate, 120) AS ship_date,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS daily_mt
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= DATEADD(DAY, -14, GETDATE())
        AND T0.CANCELED = 'N'
      GROUP BY CONVERT(VARCHAR(10), T0.DocDate, 120)
      ORDER BY ship_date ASC
    `)

    // === TEMP: DSO FORMULA CALIBRATION (retained for future tuning, behind flag) ===
    if (req.query.dso !== '1') {
      return res.json({
        oitm_weight_columns: oitmCols,
        inv1_weight_columns: inv1Cols,
        sample_items: sampleItems,
        odln_check: odlnCheck,
        daily_speed: dailySpeed,
        _item_probe: itemProbe,
        _item_count: itemCount
      })
    }
    const ACTIVE = `(ISNULL(C.frozenFor,'N')<>'Y' AND C.U_BpStatus='Active')`

    // Status distributions — confirm counts
    const statusCounts = await query(`
      SELECT
        SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END) AS active_all,
        SUM(CASE WHEN C.U_BpStatus='Delinquent' THEN 1 ELSE 0 END) AS delinq_all,
        SUM(CASE WHEN C.U_BpStatus='InActive' THEN 1 ELSE 0 END) AS inactive_all,
        SUM(CASE WHEN C.CardType='C' THEN 1 ELSE 0 END) AS total_customers
      FROM OCRD C
      WHERE C.CardType='C'
    `)

    // Customers with activity in last year (Finance may only count these)
    const activeRecent = await query(`
      SELECT
        COUNT(DISTINCT CASE WHEN ${ACTIVE} THEN O.CardCode END) AS active_recent,
        COUNT(DISTINCT CASE WHEN C.U_BpStatus='Delinquent' THEN O.CardCode END) AS delinq_recent,
        COUNT(DISTINCT CASE WHEN C.U_BpStatus='InActive' THEN O.CardCode END) AS inactive_recent
      FROM OCRD C
      INNER JOIN OINV O ON O.CardCode = C.CardCode
      WHERE C.CardType='C' AND O.CANCELED='N' AND O.DocDate >= DATEADD(YEAR,-1,GETDATE())
    `)

    // AR totals using different sources
    const arSources = await query(`
      SELECT
        -- OINV open invoices (what we use now)
        (SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
         FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
         WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE}) AS ar_oinv_active,
        -- OINV open invoices net of ORIN credit memos
        (SELECT ISNULL(SUM(O.DocTotal - O.PaidToDate),0)
         FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
         WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE}) -
        (SELECT ISNULL(SUM(R.DocTotal - R.PaidToDate),0)
         FROM ORIN R INNER JOIN OCRD C ON R.CardCode=C.CardCode
         WHERE R.CANCELED='N' AND R.DocTotal > R.PaidToDate AND ${ACTIVE}) AS ar_oinv_net_orin_active,
        -- OCRD.Balance (SAP-maintained running balance for active customers)
        (SELECT ISNULL(SUM(C.Balance),0)
         FROM OCRD C
         WHERE C.CardType='C' AND ${ACTIVE} AND C.Balance > 0) AS ar_ocrd_balance_active_positive,
        -- OCRD.Balance for all customers (active + delinq + inactive) positive only
        (SELECT ISNULL(SUM(C.Balance),0)
         FROM OCRD C
         WHERE C.CardType='C' AND C.Balance > 0) AS ar_ocrd_all_positive
    `)

    // Sales window helpers
    const salesWindows = await query(`
      SELECT
        (SELECT ISNULL(SUM(O.DocTotal),0) FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
          WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-30,GETDATE()) AND ${ACTIVE}) AS active_30d,
        (SELECT ISNULL(SUM(O.DocTotal),0) FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
          WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-60,GETDATE()) AND ${ACTIVE}) AS active_60d,
        (SELECT ISNULL(SUM(O.DocTotal),0) FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
          WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) AND ${ACTIVE}) AS active_90d,
        (SELECT ISNULL(SUM(O.DocTotal),0) FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
          WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-180,GETDATE()) AND ${ACTIVE}) AS active_180d,
        (SELECT ISNULL(SUM(O.DocTotal),0) FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
          WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(YEAR,-1,GETDATE()) AND ${ACTIVE}) AS active_365d
    `)

    // DSO FORMULAS
    const ar_oinv_active   = arSources[0].ar_oinv_active || 0
    const ar_ocrd_active   = arSources[0].ar_ocrd_balance_active_positive || 0
    const ar_ocrd_all      = arSources[0].ar_ocrd_all_positive || 0
    const s30  = salesWindows[0].active_30d  || 0
    const s60  = salesWindows[0].active_60d  || 0
    const s90  = salesWindows[0].active_90d  || 0
    const s180 = salesWindows[0].active_180d || 0
    const s365 = salesWindows[0].active_365d || 0

    const dsoFormulas = {
      // A — Standard DSO: AR / (Sales window / days)
      A_oinv_trail30d:   s30  > 0 ? Math.round(ar_oinv_active / (s30 / 30))   : 0,
      A_oinv_trail60d:   s60  > 0 ? Math.round(ar_oinv_active / (s60 / 60))   : 0,
      A_oinv_trail90d:   s90  > 0 ? Math.round(ar_oinv_active / (s90 / 90))   : 0,
      A_oinv_trail180d:  s180 > 0 ? Math.round(ar_oinv_active / (s180 / 180)) : 0,
      A_oinv_trail365d:  s365 > 0 ? Math.round(ar_oinv_active / (s365 / 365)) : 0,

      // Using OCRD.Balance (SAP canonical)
      B_ocrd_trail30d:   s30  > 0 ? Math.round(ar_ocrd_active / (s30 / 30))   : 0,
      B_ocrd_trail60d:   s60  > 0 ? Math.round(ar_ocrd_active / (s60 / 60))   : 0,
      B_ocrd_trail90d:   s90  > 0 ? Math.round(ar_ocrd_active / (s90 / 90))   : 0,
      B_ocrd_trail180d:  s180 > 0 ? Math.round(ar_ocrd_active / (s180 / 180)) : 0,
      B_ocrd_trail365d:  s365 > 0 ? Math.round(ar_ocrd_active / (s365 / 365)) : 0
    }

    // Count-back DSO (iterate backwards from today, accumulate sales, stop when AR matched)
    const dailySales = await query(`
      SELECT TOP 400
        CAST(O.DocDate AS DATE) AS dt,
        SUM(O.DocTotal) AS daily_sales
      FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
      WHERE O.CANCELED='N' AND O.DocDate <= GETDATE() AND ${ACTIVE}
      GROUP BY CAST(O.DocDate AS DATE)
      ORDER BY dt DESC
    `)
    let remaining = ar_oinv_active, daysCountback = 0
    for (const row of dailySales) {
      if (remaining <= 0) break
      remaining -= (row.daily_sales || 0)
      daysCountback++
    }
    dsoFormulas.C_countback_oinv = daysCountback

    let remaining2 = ar_ocrd_active, daysCountback2 = 0
    for (const row of dailySales) {
      if (remaining2 <= 0) break
      remaining2 -= (row.daily_sales || 0)
      daysCountback2++
    }
    dsoFormulas.C_countback_ocrd = daysCountback2

    // Aging buckets — 7 buckets matching Finance Dashboard
    const aging7 = await query(`
      SELECT
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) <= 0 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS current_amt,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 1 AND 30 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d1_30,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 31 AND 60 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d31_60,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 61 AND 90 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d61_90,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 91 AND 120 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d91_120,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) BETWEEN 121 AND 365 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS d121_365,
        ISNULL(SUM(CASE WHEN DATEDIFF(DAY,O.DocDueDate,GETDATE()) > 365 THEN O.DocTotal - O.PaidToDate ELSE 0 END),0) AS over_1y
      FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
      WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND ${ACTIVE}
    `)

    res.json({
      oitm_weight_columns: oitmCols,
      inv1_weight_columns: inv1Cols,
      sample_items: sampleItems,
      odln_check: odlnCheck,
      daily_speed: dailySpeed,
      _dso_calibration: {
        target_finance: { dso: 32, active_customers: 545, delinquent: 126, inactive: 2, total_ar_pesos: 507000000 },
        status_counts_all:    statusCounts[0],
        status_counts_recent: activeRecent[0],
        ar_sources: arSources[0],
        sales_windows: salesWindows[0],
        dso_formulas: dsoFormulas,
        aging_7_buckets: aging7[0]
      }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
