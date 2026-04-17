const { query } = require('./_db')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()

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
        daily_speed: dailySpeed
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
