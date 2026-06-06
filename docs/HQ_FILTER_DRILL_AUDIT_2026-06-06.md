# VieForce HQ — Filter & Drill Responsiveness Audit

**Date:** 2026-06-06
**Scope:** All nav pages, drill surfaces, and modals vs. the 4 topbar filters (Period, Region, Segment, ref_month / "As of").
**Source:** 27 raw surface findings (loader + endpoint code-path traced).

**Grading rubric**
- **HIGH** — a user-facing money/volume number silently fails to respond to a filter the UI *implies* it should (the Customer-360 class: page looks live + filtered but presents national/all-segment data).
- **MED** — a secondary metric is off, or only one filter axis is broken on an otherwise-responsive surface.
- **LOW** — cosmetic, sync-only, or arguable-by-design.

---

## 1. Summary table (real gaps only)

| # | Surface | Type | Broken filter(s) | Severity | Root cause (file:line) |
|---|---------|------|------------------|----------|------------------------|
| 1 | loadItemized (pg-itemized) | nav | Region, Segment, ref_month | **HIGH** | Loader never calls `vfApiParams()`; endpoint reads none (app.html:7234-7241 / itemized.js:89-92,124) |
| 2 | loadAR (pg-ar) | nav | Region, Segment | **HIGH** | `getARData()` called with no args; ar.js reads only `scope` (app.html:4966 / ar.js:47) |
| 3 | loadInv (pg-inv) | nav | Region, Segment | **HIGH** | Loader sends only `{plant:'ALL'}`; inventory.js never reads region/segment (app.html:5116 / inventory.js:24,46) |
| 4 | loadMarginExplorer (pg-margin-explorer) | nav | Region, Segment | **HIGH** | Tab's own region chip never syncs `window.RG`; no segment axis at all (margin-explorer.js:48,622-640) |
| 5 | loadRsmHome (pg-rsm-home) | nav | Segment, ref_month (Region partial) | **HIGH** | `/api/team` call sends only `{period:PD}`; dashboard region hard-pinned to session (rsm-home.js:171-173) |
| 6 | loadDeeperAnalytics — SKU Heatmap | drill | ref_month (+ no auto-refetch) | **MED** | `getSkuMatrix({unit,region,bu})` omits ref_month; DA not re-run on filter change (app.html:6483,6415) |
| 7 | loadDeeperAnalytics — Brand Coverage | drill | ref_month (+ no auto-refetch) | **MED** | `getBrandCoverage({region,bu})` omits ref_month; same DA refetch gap (app.html:6487) |
| 8 | loadDeeperAnalytics — Buying Patterns | drill | ref_month (+ no auto-refetch) | **MED** | `getBuyingPatterns({region,bu})` omits ref_month; same DA refetch gap (app.html:6491) |
| 9 | loadHome — AR balance + DSO sub-tiles | nav | Region (Segment) | **MED** | AR/DSO blocks use `applyRoleFilter` only, no `lineFilters` (dashboard.js:176-205) |
| 10 | loadTeam — DSO/silent/neg-margin columns | nav | Region, Segment (secondary cols) | **LOW** | Health subqueries omit `lineFilters` (team.js:304-349) |
| 11 | Inventory region/plant drill (INV_FILTER) | drill | Region (topbar↔drill unsynced) | **LOW** | `INV_FILTER` is independent of `setRegion` (app.html:8826-8839) |
| 12 | loadBudget — budget targets stay national | nav | Region, Segment (budget side only) | **LOW** | FY2026 budget not broken down by region/segment (budget.js:29-34) — by design |
| 13 | loadDsmHome — segment under impersonation | nav | Segment (impersonation edge) | **LOW** | dsmParams sends only period/ref_month (dsm-home.js:64-75) — self-scoped by design |
| 14 | Global search — ytd hint pinned to GETDATE() | modal | ref_month (supplementary hint) | **LOW** | search.js ytd cols use `DATEADD(YEAR,-1,GETDATE())` (search.js:43,55) |

---

## 2. Ranked punch list

### HIGH — money/volume silently national despite topbar chips

**H1. loadItemized (pg-itemized) — Region, Segment, ref_month broken**
A top-level nav page (district × SKU monthly volume matrix + KPI strip) that silently presents national / all-segment data regardless of the topbar Region/Segment chips.
- Root cause: `loadItemized()` builds params only from its own district/year dropdowns and never calls `vfApiParams()` (app.html:7234-7241); `api/itemized.js` reads only `district/year/compare_year` and its SQL WHERE (itemized.js:124) has no `regionFilterSql`/`segmentFilterSql`. cacheKey (itemized.js:94) keys on session.region only.
- Fix: `apiFetch('itemized', Object.assign(vfApiParams(), {district, year, compare_year}))`; in itemized.js import `{normalizeRegion,normalizeSegment,regionFilterSql,segmentFilterSql}` from `./lib/business_filters`, append `regionFilterSql(region,'T1')+segmentFilterSql(segment,'T0')` to the WHERE, gate `@year/@cy` off the ref_month anchor year, and add region+segment to cacheKey. If the page is intentionally national Phase-1 (district_mapping_pending), instead visibly mark the topbar chips as not applying here.

**H2. loadAR (pg-ar) — Region, Segment broken**
The AR/SOA page even renders a Regional-DSO table, yet the topbar Region/Segment chips do nothing to the AR hero numbers, aging buckets, or client list. Selecting Region=Visayas leaves every AR tile national, and the downstream client drill inherits the unscoped list.
- Root cause: `loadAR()` calls `getARData()` with **no args** (app.html:4966), so PD/RG/SEG/ref_month never hit the query string; `api/ar.js` reads only `req.query.scope` (ar.js:47) — no region/segment predicate anywhere.
- Fix: (1) `getARData(vfApiParams())`. (2) In ar.js read `const {region='ALL',segment='ALL'}=req.query` and inject into the WHEREs — region via the existing `WhsCode→region` CASE from the `by_region` CTE (ar.js:144-148) wrapped as an `EXISTS` over INV1, segment via the OITM group classifier; add region+segment to cacheKey (ar.js:79). Period/ref_month stay NA (as-of open balance).

**H3. loadInv (pg-inv) — Region, Segment broken**
The inventory KPI strip (on_floor / available / cover_days) and the by_region / by_sales_group grand totals are server-computed and stay national; a user who sets Region=Mindanao still sees national totals in the KPI cards.
- Root cause: `loadInv()` passes only `{plant:'ALL'}` (app.html:5116); `inventory.js` reads only `scope` (metadata) + `plant` (inventory.js:24,46), and by_region / by_sales_group are computed unconditionally with no narrowing WHERE.
- Fix: `getInventoryData(vfApiParams({plant:'ALL'}))`; in inventory.js read region/segment and add the `WhsCode→region` CASE predicate (reuse inventory.js:101-104) + the ItemName segment classifier (inventory.js:135-140) to each query's WHERE; add region+segment to cacheKey (inventory.js:41). (Region is partly achievable client-side via INV_FILTER, but KPI strip + totals are server-side and stay national.)

**H4. loadMarginExplorer (pg-margin-explorer) — Region, Segment broken**
A user who sets topbar Region=Visayas or Segment=PET and opens Margin Explorer sees national / all-BU margin money. (Period + ref_month here are **by design** — the tab owns its own Period chips and "As of" dropdown.)
- Root cause: the tab's own region chip (`STATE.region` default 'ALL', margin-explorer.js:48) never inherits `window.RG` — there is no read of `window.RG` in the file; on re-entry `loadMarginExplorer` only re-seeds inside `if(!built)` (margin-explorer.js:622-640), so the stale `STATE.region` is sent. Separately the tab has **no segment axis** (`buildParams` never sends `segment`; endpoint never reads it) — it uses a BU/OCRG chip instead.
- Fix: in `loadMarginExplorer()` sync `STATE.region` from `window.RG` on **every** entry (not just first build) and re-render the region chip via `setChipActive('region', STATE.region)`. For segment: either add a `segment` field to `buildParams()` from `window.SEG` + read/apply it in `api/margin-explorer.js` (mirror `segmentFilterSql`, add to cacheKey), or explicitly surface in-UI that Margin Explorer scopes by BU, not the topbar Segment.

**H5. loadRsmHome (pg-rsm-home) — Segment + ref_month broken, Region partial**
The RSM mobile scorecard is built from `/api/team`, but the team call passes only period — so the RSM rollup volume/GM ignores topbar Region/Segment/ref_month entirely; the dashboard hero call hard-pins region to `session.region`, so the topbar Region chip has no effect either.
- Root cause: `apiFetch('team', { period: PD })` drops region/segment/ref_month, and `vfApiParams({region: region||'ALL'})` forces region to session.region overriding RG (rsm-home.js:171-173). Both endpoints *do* read all 4 params — the gap is purely frontend under-passing. (Cache key is the constant `'pg-rsm-home'`, relying solely on `DC={}` to invalidate.)
- Fix: replace `apiFetch('team', { period: PD })` with `apiFetch('team', vfApiParams())` (or `vfApiParams({region: region||'ALL'})` if RSM should stay pinned to own region) and keep dashboard on `vfApiParams()` so segment + ref_month flow. Optionally make the cache key param-aware.

### MED

**M6–M8. Deeper Analytics sections (SKU Heatmap / Brand Coverage / Buying Patterns) — ref_month broken + no auto-refetch**
All three manually build `{...,region,bu}` and **omit ref_month** (app.html:6483/6487/6491), so the heatmap/gap/cadence analytics always reflect live trailing-12-mo even under a historical "As of". Each endpoint *does* support ref_month via `resolveRefMonthAnchor`. Compounding: changing the topbar only sets `DA.loaded=false` (app.html:3942,3953) — nothing re-invokes `loadDeeperAnalytics`; `loadIntelligence` calls `initDeeperAnalyticsPlaceholders()` not the loader (app.html:6415), so the section goes stale/placeholder until a manual reload. Region/segment do reach the endpoint via the local DA dropdowns or manual reload → **PARTIAL**.
- Fix: build params via `vfApiParams(...)` so ref_month rides along (e.g. `getSkuMatrix(vfApiParams({unit,region,bu}))`). Wire DA into the pg-insights refetch path: when DA was previously loaded, call `loadDeeperAnalytics(true)` on filter change instead of just placeholders; unconditionally sync `da-region-sel`/`da-bu-sel` to RG/SEG. The `daBpFilter` chip drill and the `openCust` row drill are correctly client-side / route to pg-custdetail — no change.

**M9. loadHome — AR balance + DSO sub-tiles — Region (Segment) broken**
Home headline KPIs, region table, segment mix, top customers, and the embedded speed tile are fully responsive. The exception: the AR balance + DSO sub-tiles are computed in `dashboard.js` with `applyRoleFilter` only, no `lineFilters` (dashboard.js:176-205), so changing Region/Segment does not change displayed AR balance / DSO on Home. (Period/ref_month NA for AR by nature.)
- Fix: thread the region (and optionally segment via OCRD/OINV) filter into the arBalance query (dashboard.js:176-184) and the DSO DECLARE blocks (187-205), mirroring how `regionFilterSql` already feeds the headline KPIs. Drop the param-less `getARData()` fallback call (app.html:4439) — it contributes nothing the dashboard endpoint doesn't already supply.

### LOW

- **L10. loadTeam health columns** — DSO / silent-account / neg-margin columns on the RSM scorecard omit `lineFilters` (team.js:304-349), so they don't narrow on Region/Segment while the primary scorecard volume/GM does. Fix: add `lineFilters` to those subqueries, or annotate the columns as national in the UI. (Already documented intentional at team.js:691-698.)
- **L11. Inventory region/plant drill (INV_FILTER)** — legitimate client-side drill, but `INV_FILTER.region` is independent of the topbar `setRegion` (app.html:8826-8839), so topbar Region=Visayas does not pre-select the inventory drill. Polish: seed `INV_FILTER.region` from `RG` when `RG!=='ALL'`.
- **L12. loadBudget budget targets** — actuals honor all 4 filters; the budget side stays national because FY2026 budget isn't broken down by region/segment (budget.js:29-34). By design — optional UI note so achievement% isn't misread.
- **L13. loadDsmHome segment** — self-scoped DSM cockpit; region/segment NA by design (dsm-home.js:64-75). Only edge: an EVP impersonating the DSM page wouldn't get PET-only narrowing. Low impact.
- **L14. Global search ytd hint** — supplementary `ytd_volume/region` columns pinned to `GETDATE()` ignore ref_month (search.js:43,55). Lookup, not an analytic — low priority.

---

## 3. BY-DESIGN — not gaps (do not "fix")

| Surface | Filters NA — why |
|---------|------------------|
| loadSpeed (pg-speed) | **Fully responsive to all 4.** No change. |
| loadSales (pg-sales) | **Fully responsive.** monthly_trend / pending_po are period-agnostic by design but honor region+segment. |
| loadMargin (pg-margin) | **Fully responsive to all 4.** |
| loadIntelligence (pg-insights band) | Period NA — fixed 30/90/120d/12mo rolling windows; region/segment/ref_month fully wired. |
| loadCust (pg-customers) | Period/ref_month NA — lifetime / trailing-12mo ranking; region+segment responsive. |
| loadCustDetail (pg-custdetail) | Period responsive (verified end-to-end); region/segment/ref_month NA — single-customer profile. This is the **fixed** Customer-360 pattern. |
| loadEvpHome (pg-evp-home) | Forwards all 4 via `vfApiParams()` to every endpoint; refetches. AR card as-of by design. |
| loadTeam (primary metrics) | Volume/revenue/GM/active-customer honor all 4 (only secondary health cols off — L10). |
| loadBudget (actuals) | Actuals honor all 4; budget side national by design (L12). |
| loadDsmHome | Period/ref_month wired; region/segment self-scoped to the DSM (L13). |
| Margin Explorer **period + ref_month** | Tab owns its own Period chips + "As of" dropdown — intentional decoupling (only its region/segment are H4). |
| AR / Inventory **period + ref_month** | As-of open-balance / live-stock snapshots — no time window exists. Only region/segment are gaps (H2/H3). |
| SOA modal (`/api/customer/soa`) | All 4 NA — single-customer point-in-time AR statement. |
| Global search (lookup) | All 4 NA — find any customer regardless of scope (only the ytd hint is L14). |
| itemized-meta | Static reference catalog (districts/managers/hierarchy) — all 4 NA. |
| Team DSM-row expand | Pure client-side show/hide on already-filtered `/api/team` payload. |
| openCust / AR client-row drill / daBpFilter | Correct pattern: delegate fetch to a loadPage-switch loader (pg-custdetail) or filter in-memory; not filter-blind. |

---

## 4. Filter-blind DRILL/MODAL surfaces (highest-value class)

The dangerous pattern is an onclick drill/modal that **fetches its own data, is NOT in `loadPage`'s switch, sends no topbar filters, and self-caches** — so a topbar filter change never refetches it (the original Customer-360 bug).

Audit result — **no surviving incorrect-data instance of this pattern**:

- **openCust → loadCustDetail** — *corrected*. `openCust` only navigates (app.html:5531-5534); the fetch lives in `loadCustDetail`, which **is** in the switch (`case 'pg-custdetail'`, app.html:4399), so it inherits refetch. ✅
- **SOA modal (`openSOAModal`/`getCustomerSOA`)** — structurally matches the filter-blind shape (not in switch, sends only `{id}`, self-caches 55s), but **benign**: a single-customer point-in-time AR statement is NA on all 4 filters. No wrong data. ✅
- **Global search modal** — not in switch by design (re-runs on keystroke); lookup, all 4 NA. ✅
- **Deeper Analytics sections (M6–M8)** — the one live concern in this class: these *do* render filtered analytics but are **not driven by the loadPage switch** (`loadIntelligence` seeds placeholders only, app.html:6415; topbar setters only flip `DA.loaded=false`). Result: stale/placeholder until manual reload, and ref_month never sent. This is the drill class worth fixing — see M6–M8.
- Inventory drill, AR bucket/status/search, Team DSM expand, daBpFilter — all **pure client-side** renders over already-fetched (already-filtered) payloads; correct, not filter-blind.

**Takeaway:** the remaining "filter-blind" risk is *not* in onclick-fetch modals — it has migrated to the Deeper-Analytics panel (not wired into the filter spine) and to four **top-level nav pages** (Itemized, AR, Inventory, Margin Explorer) whose loaders simply never call `vfApiParams()`. Those four are the HIGH items because they show money/volume that *looks* live and filtered but is national.
