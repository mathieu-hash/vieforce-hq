# Margin Explorer — Design Spec
Date: 2026-06-05 · Project: VieForce HQ · Author: Mat + Claude (brainstorm)
Status: **Design approved in concept (layout, dimensions, bridge mechanics). Pending written-spec review.**

---

## 1. Goal
Replace the current flat Margin tab with a **dynamic, intuitive gross-margin analysis cockpit** ("Margin Explorer"). One consistent analytical language everywhere: every number, drill, and gap explains itself as **Price / Volume / Mix / RM(formula) / Packaging / Feedtag**, live from SAP B1, for whatever slice the user has filtered to.

Anchored on the AGM-2026 forensic GM deck Mat built before — but **live and dynamic** instead of a static deck.

## 2. Core concept — "Explorer" (chosen over Cockpit / Story)
A **drill matrix is the spine**. Select any row → a context panel recomputes its **bridge + 12-month trend + top movers** for that exact slice. Everything obeys the topbar filters.

### Dimension model (the "per anything")
Each dimension can be used three ways: **Group-by** (matrix rows), **Filter** (scope everything), or a **Drill level** (expand into it):
- **Region** (Luzon/Visayas/Mindanao, 2026+ only)
- **BU** — real SAP `OCRD.GroupCode → OCRG` (100 KEY ACCOUNTS · 114 DISTRIBUTION · 115 PET CARE · 116 EMPLOYEES). *Not* the current proxy classifier.
- **DSM** — OSLP hierarchy (reuse team.js rollup)
- **Brand** (`OITM.U_brands`), **Species** (`U_SPECIE`), **Sales Group** (`U_SALES_GROUP`), **Sub-Sales Group** (`U_SSG`: PIGLET/PIG/BROILER/LAYER/GAMEBIRD/PET)
- **Customer**, **SKU**

Default landing: **TBD with Mat** (BU vs Region). Drill path is re-orderable.

## 3. Layout (top → bottom)
1. **Topbar** — existing filters (Period 7D/MTD/QTD/YTD · As-of month · Region · Segment) **+ a new unit toggle**: `₱/kg` · `₱/ton` · `GP%` · `₱ GP` (and `revenue/kg` view).
2. **Margin-leaks strip** — clickable red/amber chips (below-cost SKUs · thin KA · GP concentration · poultry/layer thin). Clicking applies the matching filter.
3. **Hero KPIs (4)** — Net Sales · Gross Profit ₱ · GP % · GM/ton, each with vs-PP/LY delta.
4. **Drill matrix** (left, ~1.4fr) — Group-by selector + expandable rows with GP ₱ / GM-ton / GP% / volume / % of GP / Δ.
5. **Context trio** (right, ~1fr) — for the selected row:
   - **GM bridge** (waterfall, section 5)
   - **12-month trend** (GM/ton; 2025 ghost shown only where codes reconcile)
   - **Top margin movers** (mix-contribution bars)
6. **Gap-analysis mode** — toggle that reframes the selected slice as a gap vs a reference (blended rate / budget / prior), decomposed in the same driver language.

## 4. Data layer (SAP B1, read-only)
Connection: `analytics.vienovo.ph,4444` · `Vienovo_Live` (2026) + `Vienovo_Old` (2025). Reuse `api/_db.js` (query / queryDateRange).

### Gross-margin facts (per INV1 line)
- Revenue = `INV1.LineTotal`; GP = `INV1.GrssProfit` (already net of line discount, = revenue − moving-avg COGS); volume kg = `INV1.InvQty` (base UoM = kg; tons = /1000).
- **MUST** filter `OINV.CANCELED='N'` (cancelled pairs double-book same-signed GP). Join on `DocEntry`, never `DocNum`.
- Scope (external sellable): `OITM.ItmsGrpCod IN (103 FINISHED GOODS, 105 TRADING-IMPORT, 102 BASEMIX)`.
- Net returns overlay: UNION ORIN/RIN1 as negatives (tiny <0.1%).

### Dimensions
- BU = `OCRD.GroupCode → OCRG`. Region = `INV1.OcrCode2` (Dim-2, `OOCR`; prefix L-/V-/M-). Category = OITM UDFs (`U_brands/[@OITMBRAND]`, `U_SPECIE/[@OITMSPCS]`, `U_SALES_GROUP/[@OITMSG]`, `U_SSG/[@OITMSSG]`). DSM = OSLP.
- Freight (region net overlay, optional): GL only — `JDT1.(Debit-Credit)` by `OcrCode2` on delivery-expense accounts. Rebates: tables empty → margin is pre-rebate.

### COGS decomposition (the forensic layer) — **build fresh**
SAP stores only the *final* moving-average item cost as one number. To split it into **RM (formula) + Packaging + Feedtag** and down to **ingredient contribution**, roll up the **production BOM**:
- Finished good → components via `OITT` (BOM header) / `ITT1` (`Father` → `Code`, `Quantity` = qty-per).
- Component cost = `OITM.AvgPrice` (moving avg) × qty-per. Classify each component into **RM / Packaging / Feedtag** by its item group (`ItmsGrpCod`) — exact group codes to confirm live (SAP currently unreachable).
- Per-SKU COGS = Σ component costs; **ingredient (RM) contribution** = per-ingredient `Δ(AvgPrice) × inclusion × volume`.
- Multi-level BOMs (FG → basemix/premix → RM): recurse one level where present.
- **Fallback:** SKUs without a maintained BOM → COGS stays the single moving-avg number, RM/Pkg/Feedtag split flagged "not available" for that SKU (no fabrication).

### Scope-break honesty (Jan-2026 consolidation)
0% customer-code overlap, ~98% SKU recode, region only from 2026. So **vs-LY / trailing-12-month are trustworthy only at category level** (Sales Group / Species / SSG — codes identical). At customer / SKU / region across the boundary: suppress the LY series and show a "not comparable pre-2026" note rather than a misleading year-ago number.

## 5. The bridge math — Price/Volume/Mix/Cost decomposition
For a slice, comparing current period (1) vs comparison period (0). Per item i: P=rev/kg, C=cost/kg, M=GP/kg=P−C, Q=kg.
- **Volume effect** = (ΣQ1 − ΣQ0) × M0_blended  *(only in the ₱-GP bridge)*
- **Mix effect** = Σ[(Q1_i/ΣQ1 − Q0_i/ΣQ0) × M0_i] × ΣQ1
- **Price effect** = Σ[(P1_i − P0_i) × Q1_i]
- **Cost effect** = −Σ[(C1_i − C0_i) × Q1_i], split by component class into **RM / Packaging / Feedtag**; RM further → per-ingredient contribution.
- **Reconciliation invariant:** Volume + Mix + Price + Cost = ΔGP (must hold exactly — unit-tested).
- **GM/ton bridge** = same, per-unit (drop Volume): Δ(blended GP/kg) = Price/kg + Mix + Cost/kg(RM+Pkg+Feedtag).
- **Gap analysis** = same decomposition of (slice rate − reference rate).

## 6. Backend
New endpoint **`/api/margin/explorer`** (or extend `api/margin.js`):
- Query: `period, ref_month, region, segment, bu, group_by, drill_path, dim filters, compare(pp|ly), unit, include(bridge,trend,movers,gap)`.
- Returns: matrix rows for current group/drill level, hero KPIs, bridge decomposition for the selected slice, 12-mo trend (LY-gated), top movers, optional gap.
- Auth: `verifySession`/service token; **role filter must include exec/director/marketing** (already fixed in `_auth.js`).
- Caching: keyed by ALL params (incl. bu/group_by/drill); short TTL.
- Heavy BOM rollup: precompute a per-SKU cost-component table per period (cache), not per-request join.

## 7. Phasing
- **Phase 1 — Gross-Margin Explorer (no BOM):** dimension model, drill matrix, hero KPIs, leaks strip, **Price/Volume/Mix/COGS-total** bridge, 12-mo trend (cat-safe LY), mix movers, gap analysis, unit toggle. Fully live from SAP today.
- **Phase 2 — Forensic COGS layer:** BOM rollup → RM/Packaging/Feedtag split + **ingredient contribution** drill. Needs SAP reachable to confirm item-group codes + BOM coverage.
- (Optional Phase 3 — freight-net + EBITDA/ton if a costing source for opex/overhead is provided.)

## 8. Error handling
- SAP unreachable → graceful "data source offline" state, not blank/zeros.
- Empty slice → explicit empty state (not stuck "Loading…").
- LY not comparable → suppressed series + note (never a misleading number).
- SKU without BOM → COGS split "n/a" for that SKU, totals still correct from moving-avg.
- Cancelled-doc / DocNum pitfalls handled in SQL (CANCELED='N', join on DocEntry).

## 9. Testing
- Unit: PVM reconciliation invariant (Vol+Mix+Price+Cost = ΔGP) on fixtures; mix-effect sign sanity; BOM rollup = moving-avg cost within tolerance.
- SQL smoke: totals reconcile to the existing `_margin_audit` headline (Jan–May 2026: ₱2,686M rev · 525.9M GP · 81,830 t · 19.6% · ₱6.43/kg).
- E2E: drill Region→BU→DSM→SKU updates bridge; LY suppressed at SKU level; leaks chips filter.

## 10. Open decisions (for Mat)
1. **Default landing dimension** — BU or Region?
2. **Phase 1 ship first** (live now) then Phase 2 BOM, or wait and ship together?
3. Confirm the **item-group codes** for RM vs Packaging vs Feedtag once SAP is back.
4. Keep it as the **Margin tab** replacement, or a new **"Margin Explorer"** tab alongside the current one during transition?
