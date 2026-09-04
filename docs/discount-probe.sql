-- ============================================================================
-- VieForce HQ — DISCOUNT TAXONOMY PROBE (read-only)
-- Run against Vienovo_Live in SQL Server Management Studio (or any read-only
-- client). Every statement is a SELECT. No PII: aggregates and schema only.
-- Paste the eight result grids back; they answer which discount types exist
-- and whether SAP can tell them apart.
-- ============================================================================
USE Vienovo_Live;
SET NOCOUNT ON;
DECLARE @from DATE = '2026-01-01', @to DATE = '2026-08-31';

-- 1. USER-DEFINED FIELDS on the four marketing-document tables.
--    A discount REASON or TYPE, if one exists, lives here.
SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, f.Descr AS UDF_Description
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN CUFD f ON f.TableID = c.TABLE_NAME AND f.AliasID = SUBSTRING(c.COLUMN_NAME, 3, 200)
WHERE c.TABLE_NAME IN ('OINV','INV1','ORIN','RIN1')
  AND c.COLUMN_NAME LIKE 'U[_]%'
ORDER BY c.TABLE_NAME, c.COLUMN_NAME;

-- 2. HEADER (document) discount: is it a fixed scheme % or scattered amounts?
SELECT ROUND(DiscPrcnt, 2)           AS header_disc_pct,
       COUNT(*)                       AS invoices,
       SUM(DiscSum)                   AS disc_sum_php,
       SUM(DocTotal)                  AS doc_total_php
FROM OINV
WHERE DocDate BETWEEN @from AND @to AND CANCELED = 'N'
GROUP BY ROUND(DiscPrcnt, 2)
ORDER BY invoices DESC;

-- 3. LINE discount: how much revenue is given away at line level, and at what rates?
--    (LineTotal is already net of this; the dashboard never sees it.)
SELECT ROUND(T1.DiscPrcnt, 1)                              AS line_disc_pct,
       COUNT(*)                                            AS lines,
       SUM(T1.Quantity * T1.PriceBefDi)                    AS gross_at_list_php,
       SUM(T1.LineTotal)                                   AS net_of_line_disc_php,
       SUM(T1.Quantity * T1.PriceBefDi) - SUM(T1.LineTotal) AS line_discount_php
FROM INV1 T1 JOIN OINV T0 ON T0.DocEntry = T1.DocEntry
WHERE T0.DocDate BETWEEN @from AND @to AND T0.CANCELED = 'N'
GROUP BY ROUND(T1.DiscPrcnt, 1)
ORDER BY lines DESC;

-- 4. CREDIT MEMOS by kind: item (physical return) vs service (financial: rebate,
--    promo, price correction). The dashboard currently drops every service memo.
SELECT T0.DocType                     AS memo_kind_I_item_S_service,
       COUNT(*)                       AS memos,
       SUM(T0.DocTotal)               AS doc_total_php,
       SUM(T0.DiscSum)                AS header_disc_php
FROM ORIN T0
WHERE T0.DocDate BETWEEN @from AND @to AND T0.CANCELED = 'N'
GROUP BY T0.DocType;

-- 5. CREDIT MEMO LINES by origin and whether they carry quantity.
--    BaseType 13 = based on an invoice, 16 = based on a return, -1 = standalone.
SELECT T1.BaseType,
       CASE WHEN T1.Quantity > 0 THEN 'qty>0' ELSE 'qty=0' END AS has_qty,
       CASE WHEN T1.ItemCode IS NULL THEN 'no item' ELSE 'item' END AS has_item,
       COUNT(*)                       AS lines,
       SUM(T1.LineTotal)              AS line_total_php,
       SUM(T1.GrssProfit)             AS grss_profit_php
FROM RIN1 T1 JOIN ORIN T0 ON T0.DocEntry = T1.DocEntry
WHERE T0.DocDate BETWEEN @from AND @to AND T0.CANCELED = 'N'
GROUP BY T1.BaseType,
         CASE WHEN T1.Quantity > 0 THEN 'qty>0' ELSE 'qty=0' END,
         CASE WHEN T1.ItemCode IS NULL THEN 'no item' ELSE 'item' END
ORDER BY line_total_php DESC;

-- 6. WHICH GL ACCOUNTS the financial credit memos hit — this is the closest
--    thing to a "reason" SAP holds without a UDF.
SELECT TOP 25 T1.AcctCode, A.AcctName,
       COUNT(*) AS lines, SUM(T1.LineTotal) AS line_total_php
FROM RIN1 T1 JOIN ORIN T0 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OACT A ON A.AcctCode = T1.AcctCode
WHERE T0.DocDate BETWEEN @from AND @to AND T0.CANCELED = 'N'
  AND (T1.Quantity = 0 OR T1.ItemCode IS NULL OR T0.DocType = 'S')
GROUP BY T1.AcctCode, A.AcctName
ORDER BY line_total_php DESC;

-- 7. EARLY-PAYMENT discount actually taken at collection (financing, not GM).
SELECT COUNT(*) AS receipts_with_discount, SUM(R2.DcntSum) AS cash_discount_php
FROM RCT2 R2 JOIN ORCT R0 ON R0.DocNum = R2.DocNum
WHERE R0.DocDate BETWEEN @from AND @to AND R0.Canceled = 'N' AND R2.DcntSum <> 0;

-- 8. FREIGHT billed to customers (memo line for the bridge; not netted into GM).
SELECT COUNT(*) AS invoices_with_freight, SUM(TotalExpns) AS freight_billed_php
FROM OINV
WHERE DocDate BETWEEN @from AND @to AND CANCELED = 'N' AND TotalExpns <> 0;
