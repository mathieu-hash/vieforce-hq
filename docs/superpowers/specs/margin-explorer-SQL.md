# Margin Explorer — SQL Draft Set

Date: 2026-06-05 · Project: VieForce HQ · Status: **DRAFT — partially validated 2026-06-05**

> ## ⚠ CORRECTION (verified live against SAP 2026-06-05) — COGS decomposition source
> The Phase-2 COGS block below uses production **BOMs (`OITT`/`ITT1`) — but those are EMPTY (`OITT`=0)**. Do NOT use them.
> The real RM/packaging/feedtag build-up is in **PRODUCTION ORDERS**: `OWOR` (7,978) → `WOR1` (135,130 component issues). **241 group-103 finished goods have 2026 production orders.**
> - Classify components by item group (confirmed `OITB`): **RM = 101 RAW MATERIALS + 102 BASEMIX · PACKAGING = 104**, within which **FEEDTAG = items coded `FT%`** (e.g. FT000165 "FT POWERBOOST STAG DEVELOPER…"). Sold items in **105 TRADING-IMPORT** have no production order → COGS stays moving-avg, split = n/a.
> - **Cost field caveat:** component cost is NOT `OITM.AvgPrice` (returned 0 in `Vienovo_Live`). Use the **goods-issue line cost** (`IGE1` StockPrice/LineTotal) tied to the production order, or the production-order issue cost — confirm field during build.
> - Multi-level: premixes are produced then consumed by the finished feed's order → explode the production tree for ultimate-ingredient contribution.
> - Link sold line `INV1` → finished-good `OWOR`/`WOR1` → component group sums → apply RM/Pkg/Feedtag ratio to the invoice-line moving-avg COGS.



> SAP (`analytics.vienovo.ph:4444`) is intermittently unreachable. Every block below is a
> draft to validate later. Each query carries an inline `/* VALIDATE-VS-SAP */` marker on
> the lines whose column names, UDF aliases, or group-code constants are assumed and must
> be confirmed live before the endpoint is wired to real data.
>
> These blocks are inlined verbatim in `api/margin-explorer.js`. This file is the canonical
> reviewable copy + the validation checklist.

---

## 0. Conventions

- Facts per `INV1` line: Revenue = `INV1.LineTotal`; GP = `INV1.GrssProfit`; volume kg = `INV1.Quantity * ISNULL(I.NumInSale,1)` (base UoM kg; tons = `/1000`).
- **MUST** `OINV.CANCELED='N'`; join `OINV → INV1` on `DocEntry` (never `DocNum`).
- Scope (external sellable): `OITM.ItmsGrpCod IN (103,105,102)` — FINISHED GOODS / TRADING-IMPORT / BASEMIX. **Group codes assumed — VALIDATE.**
- Date dispatch via `queryDateRange(sql, params, dateFrom, dateTo)` so the 2025/2026 cutoff is handled outside SQL. SQL references `@dateFrom` / `@dateTo` only.
- `group_by` selects ONE of the dimension expressions in §1; the same expression appears in both `SELECT` and `GROUP BY` (injected, never user-string — whitelisted key → fixed SQL fragment).

---

## 1. Dimension expressions (group_by → SQL fragment)

All UDF aliases below are **assumed** and must be confirmed against `CUFD` / live `OITM`/`OCRD` row inspection.

```sql
-- group_by = 'region'   (Dim-2; 2026+ only)
INV1.OcrCode2                                                   /* VALIDATE-VS-SAP: OcrCode2 is Dim-2 region; prefix L-/V-/M- */

-- group_by = 'bu'       (real BU via OCRD.GroupCode -> OCRG)
G.GroupName                                                     /* VALIDATE-VS-SAP: OCRD.GroupCode -> OCRG.GroupCode/GroupName; codes 100/114/115/116 */

-- group_by = 'dsm'
S.SlpName                                                       /* VALIDATE-VS-SAP: OSLP rollup; reuse team.js hierarchy */

-- group_by = 'brand'
I.U_brands                                                      /* VALIDATE-VS-SAP: OITM UDF U_brands / [@OITMBRAND] */

-- group_by = 'species'
I.U_SPECIE                                                      /* VALIDATE-VS-SAP: OITM UDF U_SPECIE / [@OITMSPCS] */

-- group_by = 'sales_group'
I.U_SALES_GROUP                                                 /* VALIDATE-VS-SAP: OITM UDF U_SALES_GROUP / [@OITMSG] */

-- group_by = 'ssg'
I.U_SSG                                                         /* VALIDATE-VS-SAP: OITM UDF U_SSG / [@OITMSSG] PIGLET/PIG/BROILER/LAYER/GAMEBIRD/PET */

-- group_by = 'customer'
T0.CardCode, T0.CardName                                        -- stable; no UDF

-- group_by = 'sku'
T1.ItemCode, T1.Dscription                                     -- stable; no UDF
```

Drill path (`drill_path`) is the same set of fragments applied as additional `WHERE` predicates for the parent slice, then the child dimension becomes the new `group_by`.

---

## 2. Slice aggregation by chosen group_by dimension

Feeds: matrix rows + hero KPI totals (sum of rows). `@dimExpr` is the whitelisted fragment from §1.

```sql
/* VALIDATE-VS-SAP: ItmsGrpCod scope (103/105/102), UDF aliases, OcrCode2, OCRG join */
SELECT
  {{DIM_SELECT}}                                                AS dim,            /* VALIDATE-VS-SAP */
  ISNULL(SUM(T1.LineTotal), 0)                                  AS sales,
  ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS vol,
  ISNULL(SUM(T1.GrssProfit), 0)                                 AS gp,
  CASE WHEN SUM(T1.LineTotal) > 0
    THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
    ELSE 0 END                                                   AS gp_pct,
  CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
    THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
    ELSE 0 END                                                   AS gm_ton
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry                  -- DocEntry, never DocNum
LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
LEFT JOIN OCRD C ON T0.CardCode = C.CardCode                     /* VALIDATE-VS-SAP: only needed for bu group_by */
LEFT JOIN OCRG G ON C.GroupCode = G.GroupCode                    /* VALIDATE-VS-SAP: OCRG GroupName */
LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo
  AND T0.CANCELED = 'N'
  AND I.ItmsGrpCod IN (103, 105, 102)                            /* VALIDATE-VS-SAP: external-sellable group codes */
  {{ROLE_FILTER}} {{REGION_FILTER}} {{SEGMENT_FILTER}} {{DRILL_FILTER}} {{DIM_FILTER}}
GROUP BY {{DIM_GROUP}}                                           /* VALIDATE-VS-SAP */
HAVING SUM(T1.LineTotal) > 0
ORDER BY gp DESC
```

Returns overlay (net, optional — UNION negatives from `ORIN`/`RIN1`, tiny <0.1%):

```sql
/* VALIDATE-VS-SAP: ORIN/RIN1 mirror OINV/INV1; GrssProfit sign already negative on credit memo */
UNION ALL
SELECT
  {{DIM_SELECT}}                                                AS dim,
  -ISNULL(SUM(R1.LineTotal), 0)                                 AS sales,
  -ISNULL(SUM(R1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0,0) AS vol,
  -ISNULL(SUM(R1.GrssProfit), 0)                                AS gp,
  0 AS gp_pct, 0 AS gm_ton
FROM ORIN R0
INNER JOIN RIN1 R1 ON R0.DocEntry = R1.DocEntry
LEFT JOIN OITM I ON R1.ItemCode = I.ItemCode
WHERE R0.DocDate BETWEEN @dateFrom AND @dateTo
  AND R0.CANCELED = 'N'
  AND I.ItmsGrpCod IN (103, 105, 102)                            /* VALIDATE-VS-SAP */
```

---

## 3. Per-item rows (feeds the PVM bridge → `lib/margin_bridge`)

Two recordsets — current period (1) and comparison period (0) — same shape. The bridge module
consumes per-item `{ sku, P (rev/kg), C (cost/kg), M (gp/kg), Q (kg) }` for both periods and
returns Volume / Mix / Price / Cost effects with the reconciliation invariant.

```sql
/* VALIDATE-VS-SAP: per-item P/C/M/Q for one slice + one period window */
SELECT
  T1.ItemCode                                                   AS sku,
  T1.Dscription                                                 AS sku_name,
  SUM(T1.Quantity * ISNULL(I.NumInSale, 1))                     AS qty_kg,           -- Q
  SUM(T1.LineTotal)                                             AS revenue,
  SUM(T1.GrssProfit)                                            AS gp,
  -- cost = revenue - gp ; P = revenue/Q ; C = cost/Q ; M = gp/Q  (derived in JS bridge)
  (SUM(T1.LineTotal) - SUM(T1.GrssProfit))                      AS cogs
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
LEFT JOIN OCRD C ON T0.CardCode = C.CardCode
LEFT JOIN OCRG G ON C.GroupCode = G.GroupCode
LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo
  AND T0.CANCELED = 'N'
  AND I.ItmsGrpCod IN (103, 105, 102)                            /* VALIDATE-VS-SAP */
  {{ROLE_FILTER}} {{REGION_FILTER}} {{SEGMENT_FILTER}} {{DRILL_FILTER}} {{DIM_FILTER}}
GROUP BY T1.ItemCode, T1.Dscription
HAVING SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) <> 0
```

The comparison-period query is identical with `@dateFrom0` / `@dateTo0`. For `compare=pp`
the window is the immediately-preceding period of equal length; for `compare=ly` the same
window one year prior (gated by the §6 LY-comparability rule).

---

## 4. 12-month trend (GM/ton series, LY-gated) — STUB

```sql
/* VALIDATE-VS-SAP: monthly GM/ton for the selected slice; 2025 ghost only where codes reconcile */
SELECT
  FORMAT(T0.DocDate, 'yyyy-MM')                                 AS month,
  ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS vol,
  ISNULL(SUM(T1.GrssProfit), 0)                                 AS gp,
  CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
    THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
    ELSE 0 END                                                   AS gm_ton
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
WHERE T0.DocDate >= @trendFrom AND T0.DocDate <= @trendTo
  AND T0.CANCELED = 'N'
  AND I.ItmsGrpCod IN (103, 105, 102)                            /* VALIDATE-VS-SAP */
  {{ROLE_FILTER}} {{REGION_FILTER}} {{SEGMENT_FILTER}} {{DRILL_FILTER}} {{DIM_FILTER}}
GROUP BY FORMAT(T0.DocDate, 'yyyy-MM')
ORDER BY month ASC
```

LY series is **suppressed** when the slice crosses the Jan-2026 consolidation at customer/SKU/region
level (0% customer overlap, ~98% SKU recode, region only from 2026). Only category-level
(`sales_group`/`species`/`ssg`) LY is trustworthy.

---

## 5. Top margin movers (mix-contribution) — STUB

Derived in JS from the §3 per-item rows (`Mix effect` per item, ranked); no separate query.
If a SQL pre-rank is preferred later, draft:

```sql
/* VALIDATE-VS-SAP: per-item mix contribution rank — currently computed in lib/margin_bridge */
-- (placeholder; movers come from the bridge decomposition over §3 rows)
```

---

## 6. COGS decomposition (Phase 2 — BOM rollup) — DRAFT, blocked on live SAP

```sql
/* VALIDATE-VS-SAP: OITT/ITT1 BOM rollup; component classification by ItmsGrpCod */
SELECT
  H.Code                                                        AS finished_good,
  L.Code                                                        AS component,
  L.Quantity                                                    AS qty_per,           /* VALIDATE-VS-SAP: ITT1.Quantity = qty per parent */
  CI.AvgPrice                                                   AS comp_avg_price,     /* VALIDATE-VS-SAP: OITM.AvgPrice moving avg */
  CI.ItmsGrpCod                                                 AS comp_grp,
  CASE                                                          /* VALIDATE-VS-SAP: RM/Pkg/Feedtag group-code map UNKNOWN */
    WHEN CI.ItmsGrpCod IN (/* RM groups */)       THEN 'RM'
    WHEN CI.ItmsGrpCod IN (/* packaging groups */) THEN 'PKG'
    WHEN CI.ItmsGrpCod IN (/* feedtag groups */)   THEN 'FEEDTAG'
    ELSE 'OTHER'
  END                                                           AS comp_class
FROM OITT H
INNER JOIN ITT1 L ON H.Code = L.Father                          /* VALIDATE-VS-SAP: ITT1.Father -> ITT1.Code */
LEFT JOIN OITM CI ON L.Code = CI.ItemCode
WHERE H.Code IN ( /* finished goods in current slice */ )
-- Multi-level (FG -> basemix/premix -> RM): recurse one level where present.
-- Fallback: SKU without BOM -> COGS stays single moving-avg number; RM/Pkg/Feedtag = "n/a".
```

---

## VALIDATE-VS-SAP CHECKLIST

| # | Item to confirm live | Used in | Status |
|---|----------------------|---------|--------|
| 1 | `OITM.ItmsGrpCod` codes for FINISHED GOODS=103 / TRADING-IMPORT=105 / BASEMIX=102 | §0,2,3,4,6 | ⬜ unverified |
| 2 | `INV1.OcrCode2` is the Dim-2 region with L-/V-/M- prefix | §1,2 region | ⬜ unverified |
| 3 | `OCRD.GroupCode → OCRG.GroupCode/GroupName`; codes 100/114/115/116 | §1,2 bu | ⬜ unverified |
| 4 | OITM UDF alias `U_brands` (`[@OITMBRAND]`) | §1 brand | ⬜ unverified |
| 5 | OITM UDF alias `U_SPECIE` (`[@OITMSPCS]`) | §1 species | ⬜ unverified |
| 6 | OITM UDF alias `U_SALES_GROUP` (`[@OITMSG]`) | §1 sales_group | ⬜ unverified |
| 7 | OITM UDF alias `U_SSG` (`[@OITMSSG]`) values PIGLET/PIG/BROILER/LAYER/GAMEBIRD/PET | §1 ssg | ⬜ unverified |
| 8 | `INV1.GrssProfit` is net-of-line-discount GP (= rev − moving-avg COGS) | §2,3 | ⬜ unverified |
| 9 | `INV1.NumInSale` base UoM = kg (tons = /1000) | all vol | ⬜ unverified |
| 10 | `OINV.CANCELED='N'` removes the cancelled double-booked GP pairs | all | ⬜ unverified |
| 11 | `ORIN/RIN1` returns mirror OINV/INV1; GrssProfit sign on credit memo | §2 returns | ⬜ unverified |
| 12 | `OITT`/`ITT1` BOM: `ITT1.Father → ITT1.Code`, `ITT1.Quantity` = qty-per | §6 | ⬜ unverified |
| 13 | `OITM.AvgPrice` = moving-average component cost | §6 | ⬜ unverified |
| 14 | RM / Packaging / Feedtag `ItmsGrpCod` group-code map | §6 | ⬜ unknown |
| 15 | OSLP rollup matches `team.js` DSM hierarchy | §1 dsm | ⬜ unverified |
| 16 | Smoke totals reconcile to `_margin_audit` headline (Jan–May 2026: ₱2,686M rev · 525.9M GP · 81,830 t · 19.6% · ₱6.43/kg) | §2 | ⬜ unverified |
