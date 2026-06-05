# Margin Explorer — BOM / COGS Decomposition Design (Forensic Layer)

Date: 2026-06-05 · Project: VieForce HQ · Author: Claude (BOM/COGS decomposition designer subagent)
Parent spec: `2026-06-05-margin-explorer-design.md` (§4 COGS decomposition, §5 bridge math, Phase 2)
Status: **DRAFT — all SQL marked VALIDATE-VS-SAP. SAP (`analytics.vienovo.ph:4444`) was UNREACHABLE at authoring time; no live query was run. Every assumption about item-group codes, BOM coverage, and AvgPrice semantics must be confirmed against the live product master before this ships.**

---

## 0. Why this layer exists

SAP B1 stores only the **final moving-average item cost** for a finished good — a single number on `OITM.AvgPrice`. `INV1.GrssProfit` is already `LineTotal − (AvgPrice × Quantity)` net of line discount. That number cannot, by itself, answer "how much of my margin compression is corn vs soy vs packaging vs feedtag." To get that, we reconstruct the cost from the **production BOM** (`OITT` / `ITT1`), roll component costs up from `OITM.AvgPrice`, and classify each component into **RM (formula) / PACKAGING / FEEDTAG** by its item group.

This is a **decomposition for attribution**, not a replacement for the SAP cost of record. The SKU-level COGS the dashboard reports for GP stays the SAP moving-average number (so GP reconciles to SAP exactly). The BOM rollup is used only to *split* that number into driver classes and down to ingredient contribution — and only for SKUs whose BOM rollup reconciles to the moving-average within tolerance. SKUs without a usable BOM keep moving-avg COGS and show their split as `n/a` (see §6 fallback).

---

## 1. Schema assumptions (VALIDATE-VS-SAP)

Standard SAP B1 production-BOM tables. Column names below are the SAP B1 defaults; confirm against live (the parent CLAUDE.md warns SAP B1 column names vary by version/customization).

| Table | Role | Key columns used |
|---|---|---|
| `OITT` | BOM header (one per parent item that has a BOM) | `Code` (= parent ItemCode), `Qauntity` (base qty the BOM yields — **note SAP's misspelling `Qauntity`**), `TreeType` (`P`=production, `S`=sales/assembly, `T`=template) |
| `ITT1` | BOM lines (components) | `Father` (parent ItemCode → joins `OITT.Code`), `Code` (component ItemCode), `Quantity` (qty-per relative to header yield), `Type` (item vs text/resource), `Warehouse`, `IssueMthd` |
| `OITM` | Item master (parent + each component) | `ItemCode`, `AvgPrice`, `ItmsGrpCod`, `InvntItem`, `U_brands`, `U_SPECIE`, `U_SALES_GROUP`, `U_SSG` |
| `OITB` | Item-group master (names for `ItmsGrpCod`) | `ItmsGrpCod`, `ItmsGrpNam` |

**Assumptions to confirm live:**
1. `OITT.TreeType = 'P'` is the production BOM we want (vs `'S'` sales kit / `'T'` template). Manufacturing of feed = production BOM. **CONFIRM** no SKUs rely on a sales BOM for their real recipe.
2. `ITT1.Quantity` is **qty-per relative to the header yield `OITT.Qauntity`**, not per-1-unit. Per-unit qty = `ITT1.Quantity / NULLIF(OITT.Qauntity,0)`. **CONFIRM** whether yields are normalized to 1 (common) or to a batch size (e.g. 1000 kg). If normalized to 1, the division is a no-op but harmless.
3. `OITM.AvgPrice` is in the **same currency (PHP)** and **same UoM** as the BOM `Quantity`. Feed RM is typically priced/kg and BOM qty is kg → consistent. **CONFIRM** no component priced per-bag while consumed per-kg (would need `NumInSale`-style conversion, mirroring the sales-side `T1.Quantity * ISNULL(I.NumInSale,1)` pattern already in `margin.js`).
4. `ITT1.Type` distinguishes inventory components from text/labor/resource lines. We roll up **only inventory items** (`Type = 4` / "Item" in SAP B1 BOM line type, OR `Code` exists in `OITM`). Labor/overhead BOM lines (if any) are excluded from the RM/Pkg/Feedtag split and noted. **CONFIRM** line-type enum.

---

## 2. Deliverable (a) — BOM rollup SQL (VALIDATE-VS-SAP)

Goal: per finished-good SKU, list its components with classified cost contribution, recursing **one level** (FG → basemix/premix → RM) where a component is itself a manufactured item with its own BOM.

Design choices, matching existing `_db.js` / `margin.js` conventions:
- Parameterized only (no string-concatenated user input).
- Runs on the **current** pool (`query`) for a live snapshot; for a historical period snapshot, run the same SQL via `queryH`. `AvgPrice` is a *current* point-in-time value in `OITM` (SAP keeps only the latest moving average, no per-period history in the master), so the per-SKU cost-component table must be **precomputed and cached per period at ingest time** (parent spec §6: "precompute a per-SKU cost-component table per period"). We cannot retroactively get last-March's AvgPrice from `OITM` — see §5 note.
- One-level recursion expressed as an explicit 2-level UNION (clearer + cheaper than a recursive CTE for a fixed depth, and avoids `MAXRECURSION` surprises). If profiling later shows BOMs deeper than 2 levels matter, swap to a recursive CTE capped at the confirmed max depth.

### 2.1 Level-0 + Level-1 flattened component rollup

```sql
-- VALIDATE-VS-SAP — BOM cost-component rollup, one level of recursion (FG -> basemix/premix -> RM)
-- Param: @parent  (finished-good ItemCode). For batch precompute, drop the @parent filter
--        and add a WHERE on FG.ItmsGrpCod IN (<FG/TRADING/BASEMIX groups>) instead.
WITH
-- Direct components of the finished good (level 1 of the tree, "depth 0" of recursion)
L0 AS (
  SELECT
    H.Code                                   AS fg_item,        -- finished good
    C.Code                                   AS comp_item,      -- direct component
    -- per-unit-of-FG quantity of this component
    C.Quantity / NULLIF(H.Qauntity, 0)       AS qty_per_fg,
    0                                        AS depth
  FROM OITT H
  INNER JOIN ITT1 C ON C.Father = H.Code
  WHERE H.TreeType = 'P'              -- VALIDATE-VS-SAP: production BOM
    AND C.Type = 4                    -- VALIDATE-VS-SAP: inventory-item BOM line (exclude text/labor/resource)
    AND H.Code = @parent
),
-- Explode any direct component that is ITSELF a manufactured item with a BOM
-- (basemix / premix). qty_per_fg of the grandchild = qty_per_fg(parent comp) * qty-per of grandchild.
L1 AS (
  SELECT
    L0.fg_item                               AS fg_item,
    GC.Code                                  AS comp_item,      -- grandchild raw material
    L0.qty_per_fg * (GC.Quantity / NULLIF(SUBH.Qauntity, 0)) AS qty_per_fg,
    1                                        AS depth
  FROM L0
  INNER JOIN OITT SUBH ON SUBH.Code = L0.comp_item AND SUBH.TreeType = 'P'
  INNER JOIN ITT1 GC   ON GC.Father = SUBH.Code AND GC.Type = 4
),
-- Keep a level-0 component ONLY if it is a leaf (no sub-BOM); if it had a sub-BOM
-- it is replaced by its exploded children in L1 (avoid double-counting the basemix
-- as both a line item AND its constituents).
L0_LEAF AS (
  SELECT L0.*
  FROM L0
  WHERE NOT EXISTS (
    SELECT 1 FROM OITT SUBH
    WHERE SUBH.Code = L0.comp_item AND SUBH.TreeType = 'P'
  )
),
FLAT AS (
  SELECT fg_item, comp_item, qty_per_fg, depth FROM L0_LEAF
  UNION ALL
  SELECT fg_item, comp_item, qty_per_fg, depth FROM L1
)
SELECT
  F.fg_item,
  F.comp_item,
  CI.ItemName                                AS comp_name,
  CI.ItmsGrpCod                              AS comp_grp_code,
  G.ItmsGrpNam                               AS comp_grp_name,
  F.qty_per_fg,
  CI.AvgPrice                                AS comp_avg_price,           -- VALIDATE-VS-SAP: PHP, per BOM UoM
  F.qty_per_fg * CI.AvgPrice                 AS comp_cost_per_fg_unit,    -- ₱ cost of this component per 1 unit of FG
  F.depth
FROM FLAT F
INNER JOIN OITM CI ON CI.ItemCode = F.comp_item
LEFT  JOIN OITB G  ON G.ItmsGrpCod = CI.ItmsGrpCod
ORDER BY F.fg_item, comp_cost_per_fg_unit DESC;
```

### 2.2 Reconciliation query — BOM-rolled cost vs SAP moving-average (gate for trustworthiness)

```sql
-- VALIDATE-VS-SAP — does the BOM rollup reconcile to OITM.AvgPrice of the finished good?
-- Only SKUs within tolerance get a RM/Pkg/Feedtag split; others fall back (see §6).
SELECT
  R.fg_item,
  FG.AvgPrice                          AS sap_moving_avg_cost,   -- cost of record
  SUM(R.comp_cost_per_fg_unit)         AS bom_rolled_cost,
  SUM(R.comp_cost_per_fg_unit) - FG.AvgPrice                       AS abs_diff,
  CASE WHEN FG.AvgPrice > 0
    THEN (SUM(R.comp_cost_per_fg_unit) - FG.AvgPrice) / FG.AvgPrice
    ELSE NULL END                      AS rel_diff               -- tolerance gate, e.g. |rel_diff| <= 0.05
FROM ( /* the rollup from 2.1, run for all FG SKUs */ ) R
INNER JOIN OITM FG ON FG.ItemCode = R.fg_item
GROUP BY R.fg_item, FG.AvgPrice;
```

Tolerance default: **|rel_diff| ≤ 5%** (covers rounding + overhead/labor BOM lines we excluded). Make it a config constant. SKUs outside tolerance → split flagged `n/a` (do **not** scale-fudge to force a match; that would fabricate ingredient attribution).

---

## 3. Deliverable (b) — Classification config (RM / PACKAGING / FEEDTAG)

A JS object mapping `OITM.ItmsGrpCod` → class. **The group codes below are PLACEHOLDERS.** The parent spec already confirms the *finished-good-side* groups (`103 FINISHED GOODS`, `105 TRADING-IMPORT`, `102 BASEMIX`); the **component-side** groups (raw materials, packaging materials, feed tags/labels) are NOT yet confirmed and must be read from the live product master via the query in §3.2.

### 3.1 Config object (drop in `api/lib/cogs_classification.js` when building)

```js
// api/lib/cogs_classification.js
// COGS component classification for the Margin Explorer forensic layer.
// Maps OITM.ItmsGrpCod -> { class: 'RM' | 'PACKAGING' | 'FEEDTAG' }.
//
// !!! PLACEHOLDER CODES — CONFIRM AGAINST LIVE SAP PRODUCT MASTER (see confirm query below) !!!
// Known/confirmed FG-side groups from parent spec: 103 FINISHED GOODS, 105 TRADING-IMPORT, 102 BASEMIX.
// Component-side codes (RM / PACKAGING / FEEDTAG) are guesses until the OITB dump is reviewed.

const COGS_CLASS = {
  RM:        'RM',         // raw-material formula ingredients (corn, soya, oils, premix actives, AAs, vitamins/minerals)
  PACKAGING: 'PACKAGING',  // sacks, bags, PP woven, liners, thread, labels-as-packaging
  FEEDTAG:   'FEEDTAG',    // regulatory feed tags / hangtags (BAI feed-tag requirement, PH)
  UNKNOWN:   'UNKNOWN'     // component group not in map -> surfaced, counted in COGS total, excluded from clean split
}

// ItmsGrpCod -> class. PLACEHOLDER NUMBERS.
const GROUP_TO_CLASS = {
  // --- RAW MATERIALS (formula) ---  PLACEHOLDER
  110: COGS_CLASS.RM,        // e.g. "RM - MACRO" (corn, soya, rice bran, copra, molasses)
  111: COGS_CLASS.RM,        // e.g. "RM - MICRO / PREMIX ACTIVES" (vitamins, minerals, AAs, additives)
  112: COGS_CLASS.RM,        // e.g. "RM - FATS & OILS"
  102: COGS_CLASS.RM,        // BASEMIX (confirmed group) consumed as a component = RM-class contribution
  // --- PACKAGING ---  PLACEHOLDER
  120: COGS_CLASS.PACKAGING, // e.g. "PACKAGING - SACKS/BAGS"
  121: COGS_CLASS.PACKAGING, // e.g. "PACKAGING - THREAD/LINER/CONSUMABLES"
  // --- FEEDTAG ---  PLACEHOLDER
  130: COGS_CLASS.FEEDTAG    // e.g. "FEED TAGS / HANGTAGS"
}

/**
 * Classify a component by its item-group code.
 * Unknown groups return UNKNOWN (counted in total COGS, flagged out of the clean split).
 */
function classifyComponent(itmsGrpCod) {
  return GROUP_TO_CLASS[Number(itmsGrpCod)] || COGS_CLASS.UNKNOWN
}

module.exports = { COGS_CLASS, GROUP_TO_CLASS, classifyComponent }
```

**Design note on keying by item group vs UDF:** classifying by `ItmsGrpCod` is the cleanest single key IF the master is disciplined (every sack is in a packaging group, every tag in a feedtag group). If RM/packaging/feedtag are NOT cleanly separated by group (e.g. packaging and tags share one "indirect materials" group), fall back to a secondary key — a UDF on the component (`OITM.U_*`) or an itemcode-prefix rule. The confirm query in §3.2 surfaces exactly which is true before we commit to group-keying. **This is a decision gate, not a silent assumption.**

### 3.2 Documented CONFIRM query — read real group codes from the product master (VALIDATE-VS-SAP)

Run this the moment SAP is reachable. It dumps every item group that actually appears as a **BOM component**, with sample items and average price, so the placeholders above can be replaced with real codes and the group-vs-UDF decision can be made on evidence.

```sql
-- VALIDATE-VS-SAP — enumerate item groups that appear as BOM components, with evidence
-- to (1) replace placeholder codes in cogs_classification.js and
--    (2) decide whether ItmsGrpCod alone cleanly separates RM / PACKAGING / FEEDTAG.
SELECT
  CI.ItmsGrpCod                          AS grp_code,
  G.ItmsGrpNam                           AS grp_name,
  COUNT(DISTINCT C.Code)                 AS distinct_components,
  COUNT(*)                               AS bom_line_count,
  AVG(CI.AvgPrice)                       AS avg_component_price,
  MIN(CI.ItemName)                       AS sample_item_1,
  MAX(CI.ItemName)                       AS sample_item_2
FROM ITT1 C
INNER JOIN OITT H  ON H.Code = C.Father AND H.TreeType = 'P'
INNER JOIN OITM CI ON CI.ItemCode = C.Code
LEFT  JOIN OITB G  ON G.ItmsGrpCod = CI.ItmsGrpCod
WHERE C.Type = 4                          -- inventory-item lines only
GROUP BY CI.ItmsGrpCod, G.ItmsGrpNam
ORDER BY bom_line_count DESC;

-- Companion: list ALL item groups (even non-BOM) so FG/TRADING/BASEMIX scope and
-- any UDF-based secondary key can be eyeballed against group names.
SELECT ItmsGrpCod AS grp_code, ItmsGrpNam AS grp_name
FROM OITB
ORDER BY ItmsGrpCod;

-- Companion: if groups do NOT cleanly separate packaging/feedtag, check whether a UDF does.
-- (Replace U_MATTYPE with whatever material-type UDF the confirm step reveals, if any.)
-- SELECT TOP 200 ItemCode, ItemName, ItmsGrpCod, U_brands, U_SPECIE
-- FROM OITM WHERE ItemCode IN (SELECT DISTINCT Code FROM ITT1 WHERE Type = 4);
```

After running: replace `GROUP_TO_CLASS` numbers with the confirmed codes, move any `UNKNOWN`-heavy group into its right class, and record the confirmed mapping (with `ItmsGrpNam`) inline as a comment so it is self-documenting.

---

## 4. Deliverable (c) — Ingredient-contribution formula

This plugs into the parent spec §5 **Cost effect**, splitting it by component class and, within RM, down to each ingredient. Notation matches parent: comparing current period (1) vs comparison period (0); per finished-good item *i*; volume `Q_i` in kg; cost/kg `C_i`.

### 4.1 Component-class cost effect (RM / PACKAGING / FEEDTAG)

For finished good *i*, decompose its cost/kg into per-class cost/kg using the rollup:

```
C_i              = Σ_components(c in i) cost_c_per_kg(i)
C_i^RM           = Σ_{c in i, class(c)=RM}        cost_c_per_kg(i)
C_i^PACKAGING    = Σ_{c in i, class(c)=PACKAGING}  cost_c_per_kg(i)
C_i^FEEDTAG      = Σ_{c in i, class(c)=FEEDTAG}    cost_c_per_kg(i)

where cost_c_per_kg(i) = qty_per_fg(c in i) * AvgPrice_c   (from §2.1, expressed per kg of FG)
```

Cost effect of a class K over the slice (negative = cost up = margin down), mirroring parent §5 Cost effect `−Σ[(C1_i − C0_i) × Q1_i]`:

```
CostEffect^K = − Σ_i [ ( C1_i^K − C0_i^K ) × Q1_i ]      for K in {RM, PACKAGING, FEEDTAG, UNKNOWN}

and   CostEffect_total = CostEffect^RM + CostEffect^PACKAGING + CostEffect^FEEDTAG + CostEffect^UNKNOWN
```

`CostEffect_total` here **must equal** the parent §5 single-number Cost effect for the SAME slice **restricted to BOM-covered SKUs**. For SKUs without a usable BOM, their cost effect stays in the moving-average single-number Cost bucket and is reported as the `n/a`/"unsplit COGS" residual (see §6) — so the grand Cost effect across all SKUs still reconciles, but only the BOM-covered portion is class-split.

### 4.2 Per-ingredient (RM) contribution — the drill

Parent spec §5: *ingredient (RM) contribution = per-ingredient `Δ(AvgPrice) × inclusion × volume`*. Made precise:

For a single raw-material ingredient *g* (e.g. corn), summed across the finished goods *i* in the slice that contain *g*:

```
inclusion_{g,i}   = qty_per_fg(g in i)                  -- kg of ingredient g per 1 kg of FG i (units: kg/kg)
Δ AvgPrice_g      = AvgPrice1_g − AvgPrice0_g           -- ₱/kg change in the ingredient's moving-avg price

IngredientContribution_g
   = − Σ_i [ Δ AvgPrice_g × inclusion_{g,i} × Q1_i ]    -- ₱ margin impact of ingredient g's price move
                                                         --   (negative = ingredient got pricier = margin down)
```

Notes:
- This is the **price-of-ingredient** component of the cost effect. A second, smaller term — change in *inclusion* (recipe reformulation: `Δinclusion × AvgPrice0`) — can be added if reformulation between periods is material. **Default: hold inclusion at the current recipe** (`inclusion_{g,i}` from period-1 BOM) and attribute cost change to ingredient price moves, because SAP keeps only the current BOM (no per-period recipe history in `OITT`/`ITT1`). This is the same limitation as AvgPrice history — call it out in the UI tooltip.
- Σ over all RM ingredients *g* of `IngredientContribution_g` = `CostEffect^RM` (the RM class total from §4.1), within rounding. This is the **internal reconciliation invariant for the ingredient drill** and must be unit-tested on fixtures (parent spec §9).
- "Top margin movers" (parent §3 Context trio) at the ingredient level = the ranked `IngredientContribution_g` values.

### 4.3 Reconciliation chain (all unit-tested, parent §9)

```
ΔGP (slice)  =  Volume + Mix + Price + CostEffect_total          [parent §5 invariant — exact]
CostEffect_total (BOM-covered) = CostEffect^RM + ^PACKAGING + ^FEEDTAG + ^UNKNOWN
CostEffect^RM = Σ_g IngredientContribution_g
bom_rolled_cost_i ≈ OITM.AvgPrice_i   within tolerance          [§2.2 gate]
```

---

## 5. AvgPrice-history caveat (critical, VALIDATE-VS-SAP)

`OITM.AvgPrice` is a **single current** moving-average value — SAP B1 does **not** retain per-period AvgPrice history in the item master. Consequences for the period-0 (comparison) side of every cost effect above:

- **Cannot** be reconstructed retroactively from `OITM` alone.
- Sources for a true period-0 component cost, in order of fidelity (CONFIRM which exists/is feasible):
  1. **Precomputed snapshot table** — the parent spec's "per-SKU cost-component table per period (cache)". If the Margin Explorer ingest job writes the §2.1 rollup (with AvgPrice frozen) at each period close, period-0 = that snapshot. **This is the intended design — build the snapshot job in Phase 2.** Until snapshots accumulate, period-0 ingredient prices are unavailable and the ingredient drill must show "baseline unavailable for periods before snapshotting began."
  2. **`OINM`** (inventory transaction journal) — holds `CalcPrice` / `TransValue`/`InQty` per inventory move; a period-0 moving-avg can be approximated from the last move on/before the period-0 close. Heavier; **CONFIRM** columns and that it covers RM items. Candidate for a more accurate backfill.
  3. **`OITT`/`ITT1` recipe** is assumed stable across periods (see §4.2 inclusion note).

Do not silently use *current* AvgPrice as the period-0 price — that would zero out the ingredient price effect and mislead. Gate the ingredient drill on snapshot availability; otherwise show component **class split** (current period, no Δ) and suppress the Δ-attribution with a note. This mirrors the parent spec's LY-suppression honesty pattern.

---

## 6. Deliverable (d) — Fallback for SKUs lacking a BOM

Explicit, no fabrication. A finished-good SKU falls back when **any** of:
- No `OITT` row with `TreeType='P'` for the SKU (no production BOM maintained), OR
- Rollup reconciliation fails the §2.2 tolerance (|rel_diff| > 5%), OR
- BOM contains only non-inventory lines (all labor/text — nothing to classify), OR
- A component is missing `AvgPrice` (NULL/0) such that the rollup is incomplete.

Fallback behavior:
- **COGS for GP stays the SAP moving-average** (`AvgPrice × Quantity`, exactly as `INV1.GrssProfit` already reflects). GP totals and the Price/Volume/Mix/Cost-**total** bridge are unaffected — they never depended on the BOM.
- The **RM / PACKAGING / FEEDTAG split** for that SKU is reported as `n/a` (null), not zero. Its cost effect is aggregated into an explicit **"unsplit COGS (no BOM)"** residual line in the class breakdown, so the class bars + the single-number Cost effect always reconcile.
- The **ingredient drill** for that SKU is empty with reason `no_bom` / `reconcile_fail` / `missing_avgprice` / `non_inventory_only`.
- Surface coverage as a meta field so the UI can be honest: e.g. `{ bom_coverage_pct, skus_split, skus_fallback, unsplit_cogs_share_pct }`. If a slice is mostly fallback SKUs, the class split is labeled low-confidence.

Fallback detection query (VALIDATE-VS-SAP):

```sql
-- VALIDATE-VS-SAP — which in-scope finished goods have NO usable production BOM
SELECT
  I.ItemCode, I.ItemName, I.ItmsGrpCod, I.AvgPrice,
  CASE WHEN H.Code IS NULL THEN 'no_production_bom'
       ELSE 'has_bom' END AS bom_status
FROM OITM I
LEFT JOIN OITT H ON H.Code = I.ItemCode AND H.TreeType = 'P'
WHERE I.ItmsGrpCod IN (103, 105, 102)   -- FG / TRADING-IMPORT / BASEMIX (parent §4 scope) — CONFIRM
  AND I.InvntItem = 'Y'
ORDER BY bom_status, I.AvgPrice DESC;
```

---

## 7. Integration handoff (out of scope to implement here)

Per task constraints I did **not** edit `app.html` or `api/margin.js` (shared, sequenced separately). When the integration agent wires this in:
- New module `api/lib/cogs_classification.js` (config from §3.1) + a BOM-rollup helper using `query`/`queryH` from `_db.js`.
- The per-period cost-component snapshot job (§5 option 1) is the precompute the parent spec §6 calls for — keyed by `(period, sku)`, storing `{comp_item, class, qty_per_fg, avg_price_frozen}`.
- The bridge endpoint (`/api/margin/explorer`) consumes the snapshot + sales facts to produce class-split Cost effect (§4.1) and the ingredient drill (§4.2).
- Reuse the bags→kg convention already in `margin.js` (`Quantity * ISNULL(NumInSale,1)`) if any BOM component is priced/consumed per-bag (§1 assumption 3).

---

## 8. Open confirmations (block Phase 2 ship until resolved)

1. Real `ItmsGrpCod` values for RM / PACKAGING / FEEDTAG (§3.2 query) — and whether group alone cleanly separates them (else add UDF/prefix secondary key).
2. `OITT.TreeType` filter correctness + `ITT1.Type` inventory-line enum (§1).
3. `ITT1.Quantity` normalization (per-1 vs per-batch) and `OITT.Qauntity` yield basis (§1.2).
4. Component UoM/currency consistency with `AvgPrice` (§1.3) — any per-bag RM needs `NumInSale`.
5. Max BOM depth — is one level of recursion enough? (FG→basemix→RM assumed sufficient.)
6. Period-0 cost source: build the snapshot job (preferred) vs `OINM` backfill (§5).
7. BOM coverage % across the in-scope FG universe (§6 query) — sets expectation for how much of COGS can be split day one.
```
