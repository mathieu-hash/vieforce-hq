# Margin Explorer — Phased Implementation Plan

Date: 2026-06-05 · Project: VieForce HQ · Author: Claude (synthesizer)
Spec: `docs/superpowers/specs/2026-06-05-margin-explorer-design.md` (approved in concept)
BOM/COGS sub-spec: `docs/superpowers/specs/2026-06-05-margin-explorer-bom-cogs-decomposition.md`

**Status: planning. No shared files edited. SAP (`analytics.vienovo.ph:4444`) intermittently UNREACHABLE — every SQL block is a DRAFT to validate later; do not run live SQL until reachable.**

---

## 0. Ground truth at plan time (verified on disk)

- **Bridge library is BUILT and GREEN:** `api/lib/margin_bridge.js` + `tests/margin_bridge.test.js` — 88/88 tests pass (79 pre-existing + 9 new). Exports `bridgeGP`, `bridgeGMperKg`, `ingredientContribution`. Hard invariant `volume + mix + price + cost_total === delta_gp` proven across 200k random trials (max err ~2e-12).
- **A draft endpoint already exists** at `api/margin-explorer.js` (FLAT path), requiring `./lib/margin_bridge` defensively, with whitelisted `group_by` fragments and `meta.sap_validated=false` mock fallback. **This conflicts with the INTEGRATION research**, which proposes the NESTED path `api/margin/explorer.js` (to match `api/cnc/customers.js`, `api/auth/login.js`) so Vercel's filesystem convention maps it to `/api/margin/explorer`. **DECISION GATE D0 below resolves which path wins before any server.js / frontend wiring.**
- **The existing Margin tab is untouched** and stays: `pg-margin` page (`app.html` 2634–2830), `/api/margin` (`api/margin.js`, mounted `server.js:35` per actual file; integration research cited :74 — confirm exact line at wire time), `loadMargin()` (`app.html:5878`).
- **`_margin_audit/` lives at `C:/VienovoDev/_margin_audit/` (parent dir), NOT in-repo.** The headline reconciliation target and `extract_margin.py` canonical model live there. SQL drafts reference it; the verify step (Phase V) reconciles against it.
- **Canonical model facts (locked, from SQL research):** Revenue = `INV1.LineTotal`; GP = `INV1.GrssProfit`; **volume kg = `INV1.InvQty`** (NOT `Quantity*NumInSale` — that is the legacy `api/margin.js` path); `OINV.CANCELED='N'`; join on `DocEntry` never `DocNum`; scope `OITM.ItmsGrpCod IN (103,105,102)`; returns netted negative via `ORIN/RIN1`.

### D0 — Endpoint path decision (resolve FIRST, blocks all integration)
Two scaffolds disagree. Pick ONE:
- **Option A (recommended): nested `api/margin/explorer.js`** → clean Vercel mapping to `/api/margin/explorer`, matches existing nested-handler precedent, integration map's `server.js` insertion points apply verbatim. Migrate the logic from the existing `api/margin-explorer.js` into the new file, then delete the flat draft.
- **Option B: keep flat `api/margin-explorer.js`** → serves as `/api/margin-explorer` (hyphen, not slash). Requires the frontend `api.js` call + nav loader to target `margin-explorer`, and an explicit Express route. Simpler diff but diverges from the URL the spec/frontend assume (`margin/explorer`).
- Verify: grep both paths; exactly one endpoint file exists after the decision; `js/api.js` client string matches the served path.

---

## 1. What the scaffolds already delivered

| Deliverable | File(s) | State | Verify |
|---|---|---|---|
| PVM(C) bridge library | `api/lib/margin_bridge.js`, `tests/margin_bridge.test.js` | DONE, 88/88 green | `node --test tests/margin_bridge.test.js` |
| Endpoint draft (skeleton) | `api/margin-explorer.js` (flat — see D0) | DRAFT, route NOT registered, mock fallback | reads at load; returns `meta.sap_validated=false` |
| Canonical SQL building blocks | SQL research output (base CTE, returns overlay, dimension joins, per-kg guards) | DRAFT, all `VALIDATE-VS-SAP` | smoke vs `_margin_audit` headline |
| BOM/COGS decomposition design | `docs/.../2026-06-05-margin-explorer-bom-cogs-decomposition.md` | DESIGN, all SQL `VALIDATE-VS-SAP` | §8 open confirmations |
| Frontend build plan | FRONTEND research (recommends NEW module `js/app-margin-explorer.js`, not inline) | PLAN only, no file written | — |
| Integration map | INTEGRATION research (file:line insertion points) | MAP only, no edits | — |

**Not yet built:** `api/lib/cogs_classification.js`, the BOM-rollup helper, the per-period cost-component snapshot job, `js/app-margin-explorer.js`, the page markup, and all shared-file wiring.

---

## 2. SAP-GATED tasks (blocked until `analytics.vienovo.ph:4444` reachable)

Run these the moment SAP is up. Each must pass before the matching feature ships. **Do not fabricate, scale-fudge, or substitute current values for historical ones.**

### 2.1 Validate every `VALIDATE-VS-SAP` SQL block (Phase 1 gate)
- **Goal:** confirm the base fact CTE returns the canonical model and reconciles to the headline.
- **Files:** SQL drafts → finalize into the endpoint chosen in D0.
- **Confirmation query (headline reconciliation, Jan–May 2026):**
  ```sql
  -- VALIDATE-VS-SAP — must reconcile to ₱2,686M rev · 525.9M GP · 81,830 t · 19.6% · ₱6.43/kg
  SELECT
    SUM(T1.LineTotal)                               AS revenue,
    SUM(T1.GrssProfit)                              AS gp,
    SUM(T1.InvQty)/1000.0                           AS tons,
    SUM(T1.GrssProfit)/NULLIF(SUM(T1.LineTotal),0)  AS gp_pct,
    SUM(T1.GrssProfit)/NULLIF(SUM(T1.InvQty),0)     AS gp_per_kg
  FROM OINV T0
  JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry          -- DocEntry, never DocNum
  JOIN OITM T2 ON T2.ItemCode = T1.ItemCode
  WHERE T0.CANCELED = 'N'
    AND T0.DocDate >= '2026-01-01' AND T0.DocDate < '2026-06-01'
    AND T2.ItmsGrpCod IN (103,105,102);
  ```
- **Verify:** five outputs within rounding of the headline. If `gp_per_kg` ≠ ₱6.43, confirm the `InvQty<=0` service-line exclusion is applied to the per-kg denominator only (two volume sums: weighted vs all). Add the `ORIN/RIN1` negative overlay and re-check (delta < 0.1%).
- **Then:** confirm each dimension join resolves (`OCRD.GroupCode→OCRG` BU; `INV1.OcrCode2→OOCR` region L-/V-/M-; `OITM.U_brands/U_SPECIE/U_SALES_GROUP/U_SSG`; `OSLP` DSM). Validate one matrix row per `group_by` whitelist key against a hand total.

### 2.2 Confirm RM / Packaging / Feedtag item-group codes (Phase 2 gate)
- **Goal:** replace the PLACEHOLDER codes in `cogs_classification.js` (`110/111/112` RM, `120/121` PKG, `130` FEEDTAG) with real `ItmsGrpCod` values, and decide group-key vs UDF/prefix secondary key.
- **Confirmation query (from BOM sub-spec §3.2):**
  ```sql
  -- VALIDATE-VS-SAP — item groups appearing as BOM components, with evidence
  SELECT CI.ItmsGrpCod AS grp_code, G.ItmsGrpNam AS grp_name,
         COUNT(DISTINCT C.Code) AS distinct_components, COUNT(*) AS bom_line_count,
         AVG(CI.AvgPrice) AS avg_component_price,
         MIN(CI.ItemName) AS sample_1, MAX(CI.ItemName) AS sample_2
  FROM ITT1 C
  JOIN OITT H  ON H.Code = C.Father AND H.TreeType = 'P'   -- VALIDATE: production BOM
  JOIN OITM CI ON CI.ItemCode = C.Code
  LEFT JOIN OITB G ON G.ItmsGrpCod = CI.ItmsGrpCod
  WHERE C.Type = 4                                         -- VALIDATE: inventory-line enum
  GROUP BY CI.ItmsGrpCod, G.ItmsGrpNam
  ORDER BY bom_line_count DESC;
  ```
- **Plus** the BOM-rollup reconciliation (sub-spec §2.2, gate |rel_diff| ≤ 5%), the no-BOM fallback detector (§6), and the open confirmations in sub-spec §8: `TreeType`/`Type` enums, `ITT1.Quantity` normalization vs `OITT.Qauntity` yield, UoM/currency consistency (`NumInSale` if any per-bag RM), max BOM depth, period-0 cost source.
- **Verify:** placeholder map replaced with confirmed codes + `ItmsGrpNam` comments; `UNKNOWN` bucket near-empty; BOM coverage % recorded as the day-one split expectation.

### 2.3 Period-0 cost-history caveat (blocks the ingredient Δ-drill, not the class split)
- `OITM.AvgPrice` is current-only. The ingredient price-delta drill REQUIRES the per-period snapshot job (§5 option 1) or an `OINM` backfill. Until snapshots accumulate, **suppress the Δ-attribution with a note** (mirror the LY-suppression honesty pattern) and show current-period class split only. Using current AvgPrice as period-0 is forbidden (silently zeros the price effect).

---

## 3. SEQUENCED integration tasks (shared files — STRICTLY ONE AT A TIME, NEVER PARALLEL)

These touch `server.js` and `app.html`, which the parent agent reserves and sequences separately. **Do not dispatch these as parallel agents** — shared-worktree commit races scramble the audit trail (see Mat's standing rule). Each task lands, builds, and is verified before the next starts. Line numbers are from the INTEGRATION research; re-confirm each at edit time (file drifts).

> Precondition: D0 resolved. The insertion points below assume **Option A (nested `api/margin/explorer.js` → `/api/margin/explorer`)**. If Option B was chosen, substitute the hyphen path consistently.

**S1 — Register the endpoint in `server.js`** (after D0, after 2.1 at least drafted)
- Require: at `server.js` after the existing `const marginHandler = require('./api/margin')`, add `const marginExplorerHandler = require('./api/margin/explorer')`.
- Route: after `app.get('/api/margin', marginHandler)`, add `app.get('/api/margin/explorer', marginExplorerHandler)`.
- Files: `server.js` (require line + route line only).
- Verify: `node -e "require('./server.js')"` loads without throwing; `curl localhost:<port>/api/margin/explorer` returns the skeleton JSON with `meta.sap_validated=false` (not 404). Vercel needs no route edit (filesystem convention); confirm `vercel.json` `connect-src` already whitelists the Cloud Run origin — no CSP change.

**S2 — Add the `api.js` client one-liner**
- Add `function getMarginExplorerData(params){ return apiFetch('margin/explorer', params); }` next to the existing `getMarginData` in `js/api.js`.
- Files: `js/api.js` only.
- Verify: `getMarginExplorerData` is a global; manual `getMarginExplorerData({period:'YTD'})` in console hits the endpoint.

**S3 — Add the new module `js/app-margin-explorer.js` + one `<script>` tag**
- Create `js/app-margin-explorer.js` (ES5 global-function style, matching `evp-home.js`/`dsm-home.js`): module-level `ME` state, `loadMarginExplorer()`, render fns, charts namespaced `charts.me_*`, DOM ids `me-*`. Reuse globals `vfApiParams`, `DC`, `sel/sett/seth`, `fc/fcn/esc`, `showError/clearError`, `pulseRefresh`.
- Add ONE `<script src="js/app-margin-explorer.js">` tag near the other page modules (`app.html` ~3931–3934).
- Files: NEW `js/app-margin-explorer.js` (free to write); `app.html` (one script tag).
- Verify: page loads, no console error, `typeof loadMarginExplorer === 'function'`.

**S4 — Add nav item + page section + loader route + page-title (all in `app.html`)**
- Nav item: insert at `app.html:1052` (after the `pg-margin` nav block) — the `navTo('pg-margin-explorer',this)` block with 🧭 icon + NEW badge.
- Page section: insert the `<div class="page" id="pg-margin-explorer">…</div>` at **`app.html:2830`** (immediately before `pg-insights` at 2831; `pg-margin` spans 2634–2830 and stays untouched). Use an existing page section as the structural template; inner content driven by `js/app-margin-explorer.js`.
- Loader route: add `case 'pg-margin-explorer': loadMarginExplorer(); break;` in `loadPage()` at `app.html:4439` (after the `pg-margin` case).
- Page-title registry: add `'pg-margin-explorer':['Margin Explorer','Price · Volume · Mix · Cost — live'],` at `app.html:4300`.
- (Optional) Manual-refresh + silence-drawer parity: add `pg-margin-explorer` branches at `app.html:7887` and `7989`.
- Files: `app.html` only.
- Verify: nav shows "Margin Explorer" with NEW badge; clicking routes to the page, calls `loadMarginExplorer()`, renders skeleton; existing Margin tab still works (regression check).

**Sequencing rule:** S1 → S2 → S3 → S4, each committed and verified independently. If any step needs a rollback, it is one isolated commit.

---

## 4. Phase 1 vs Phase 2 task split (built in PARALLEL per Mat, decision §10.2)

Phase 1 and Phase 2 are independent enough to build concurrently **on separate non-shared files** (NOT on the shared `server.js`/`app.html`, which remain sequenced in §3). Parallelism is across the two feature tracks, not across shared-file edits.

### Phase 1 — Gross-Margin Explorer (no BOM). Live from SAP today once 2.1 passes.
- **P1-a — Endpoint core:** finalize the base fact CTE + dimension joins + whitelisted `group_by`/`drill_path`; produce matrix rows, hero KPIs (Net Sales · GP ₱ · GP% · GM/ton with vs-PP/LY), leaks strip data. Files: chosen endpoint. Verify: 2.1 reconciliation.
- **P1-b — Bridge wiring:** feed per-item rows into `bridgeGP`/`bridgeGMperKg`/`ingredientContribution` (already built). For Phase 1, `cost_rm/cost_pkg/cost_feedtag` collapse into a single COGS-total bucket (pass total as one class or zero the splits and use `cost_total`). Verify: endpoint bridge sums match `delta_gp`.
- **P1-c — 12-mo trend + scope-break honesty:** trend series GM/ton; suppress LY at customer/SKU/region across the 2026 boundary, keep it at category level (Sales Group/Species/SSG). Verify: SKU-level LY suppressed with note; category-level LY present.
- **P1-d — Frontend render:** matrix, hero KPIs, leaks chips (clickable→filter), bridge waterfall (Chart.js v4 floating bars `[[min,max]]`), trend, mix movers, unit toggle (`₱/kg·₱/ton·GP%·₱GP`), gap-analysis mode. In `js/app-margin-explorer.js`. Verify: drill Region→BU→DSM→SKU recomputes bridge.

### Phase 2 — Forensic COGS layer. Gated on 2.2/2.3 (SAP reachable).
- **P2-a — `api/lib/cogs_classification.js`:** the `GROUP_TO_CLASS` config (placeholder until 2.2). NEW file. Verify: `classifyComponent()` unit test.
- **P2-b — BOM-rollup helper + reconciliation:** sub-spec §2.1 rollup via `query`/`queryH`, §2.2 tolerance gate (±5%). NEW file. Verify: rolled cost ≈ `OITM.AvgPrice` within tolerance on covered SKUs.
- **P2-c — Per-period cost-component snapshot job:** the precompute (parent §6, sub-spec §5 option 1), keyed `(period, sku)` storing `{comp_item, class, qty_per_fg, avg_price_frozen}`. This is what makes the period-0 ingredient drill possible. Verify: snapshot writes per period close; period-0 readable.
- **P2-d — RM/Pkg/Feedtag split + ingredient drill:** wire class-split Cost effect (sub-spec §4.1) and `IngredientContribution_g` (§4.2) into the endpoint + frontend, with fallback (§6) "unsplit COGS (no BOM)" residual and coverage meta. Verify: `Σ IngredientContribution_g === cost_rm` (unit-tested); fallback SKUs show `n/a` not zero; GP totals unaffected.

---

## 5. Test / verify checklist

**Unit (offline, runnable now):**
- [ ] `node --test tests/margin_bridge.test.js` → 88/88 green (already passing; re-run as regression after any endpoint change that touches the lib).
- [ ] Mix-effect sign sanity + pure-price / pure-mix isolated fixtures (covered).
- [ ] Phase 2: `classifyComponent()` map test; BOM rollup ≈ moving-avg within tolerance on a fixture; `Σ IngredientContribution_g === cost_rm`.

**SQL smoke (SAP-gated — §2):**
- [ ] Headline reconciliation Jan–May 2026: **₱2,686M rev · 525.9M GP · 81,830 t · 19.6% · ₱6.43/kg** (query in §2.1) within rounding.
- [ ] Each `group_by` matrix total = hand total for that dimension.
- [ ] `ORIN/RIN1` negative overlay shifts totals < 0.1%.
- [ ] BOM coverage % recorded; reconciliation gate passes for covered SKUs.

**E2E (after §3 wiring):**
- [ ] Existing Margin tab unchanged (regression).
- [ ] Drill Region→BU→DSM→SKU updates bridge + trend + movers.
- [ ] LY suppressed at SKU level (note shown), present at category level.
- [ ] Leaks chips apply the matching filter.
- [ ] Unit toggle switches ₱/kg · ₱/ton · GP% · ₱GP.
- [ ] SAP-unreachable → "data source offline" state (not blank/zeros); empty slice → explicit empty state.

---

## Summary

The plan sequences a Margin Explorer build where the hard math is already done and green: `api/lib/margin_bridge.js` (88/88 tests, invariant proven) plus a draft endpoint and full SQL/BOM/frontend research. The critical unresolved item is **D0 — the endpoint path collision** (existing flat `api/margin-explorer.js` vs the integration map's nested `api/margin/explorer.js`); it must be decided before any shared-file wiring. Everything that touches SAP (every `VALIDATE-VS-SAP` SQL block, the RM/Pkg/Feedtag group codes, and the period-0 ingredient drill) is gated behind the DB coming back and reconciling to the `_margin_audit` headline (₱2,686M / 525.9M GP / 81,830 t / ₱6.43/kg). The three shared-file integration steps (S1 server.js → S2 api.js → S3 module → S4 app.html nav/page/loader) are explicitly one-at-a-time, never parallel, with file:line insertion points; Phase 1 (gross-margin) and Phase 2 (forensic BOM/COGS) build in parallel on their own non-shared files.

Plan written to: `C:/VienovoDev/vieforce-hq/docs/superpowers/plans/2026-06-05-margin-explorer-plan.md`
