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

    res.json({
      oitm_weight_columns: oitmCols,
      inv1_weight_columns: inv1Cols,
      sample_items: sampleItems,
      odln_check: odlnCheck,
      daily_speed: dailySpeed
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
