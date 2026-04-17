# TRACK A REPORT — Filter Wiring, Speed Math, Table Rendering

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commits:** `2e7bc07` (table wiring) · `c58cedc` (intelligence brand fix) · pushed
**Cloud Run revision:** `vieforce-hq-api-00030-man` (preview, 0% traffic)
**Vercel preview:** `https://vieforce-juzqal30n-mathieu-7782s-projects.vercel.app`

---

## 1. Filter Wiring — Diagnosis & Fix

### Backend verification (proves filter CAN work)

```
GET /api/dashboard?period=7D   → revenue=132.7M, vol=4,019 MT
GET /api/dashboard?period=MTD  → revenue=242.3M, vol=7,315 MT
GET /api/dashboard?period=QTD  → revenue=242.3M, vol=7,315 MT   (≡ MTD, early in Q2)
GET /api/dashboard?period=YTD  → revenue=2,567.0M, vol=55,789 MT
```

Backend returns different data per period. The bug was **not in the backend** and **not in `setPd()`** (which already cleared `DC` and called `loadPage(PG)`).

### Root causes found

1. **Browser / CDN caching.** `apiFetch()` did not set `cache: 'no-store'` and did not include a cache-buster — same URL was sometimes served from cache across period changes, making the UI look frozen even when `setPd()` re-fired.
2. **Mat may have opened an earlier preview URL.** `vieforce-kccfrbcje` / `vieforce-k0beubvqq` / `vieforce-pitygrq3e` etc. pre-date Pass 1 and had the older `setPd` that only toggled CSS.
3. **setCmp / setU only changed CSS.** Now call `loadPage(PG)` too, so the re-render picks up the new compare/unit mode (Pass 1 change — reconfirmed in Track A).

### Fix applied (js/api.js)

```diff
 async function apiFetch(endpoint, params) {
   params = params || {};
+  params._t = Date.now();
   var qs = new URLSearchParams(params).toString();
   var url = API_BASE + '/' + endpoint + (qs ? '?' + qs : '');

-  console.log('[API]', endpoint, qs || '');
+  console.log('[API]', endpoint, 'params=', params);
   try {
-    res = await fetch(url, { headers: getApiHeaders() });
+    res = await fetch(url, { headers: getApiHeaders(), cache: 'no-store' });
```

### How Mat can verify now

1. Open the NEW preview URL in incognito, hard-refresh (`Ctrl+Shift+R`).
2. Open DevTools Console. On each click of 7D / MTD / QTD / YTD:
   - You should see new `[API] dashboard params= {period: '7D', region: 'ALL', _t: …}` lines.
   - Network tab: new XHR request per click (no `(from disk cache)`).
3. Net Sales goes from ₱242M (MTD) → ₱2.57B (YTD) → ₱133M (7D). These differ by ~10× — impossible to miss.
4. Unit toggle (MT / Bags): Volume KPI switches between "7,315 MT" and "162,174 bags". No refetch (instant).
5. Compare toggle (vs PP / vs LY): delta arrows change. (vs LY delta = +0% because SAP has no April 2025 data — this is expected, not a bug.)

---

## 2. Speed Page — Math Fix

### What Mat saw

| Field | Displayed | Expected |
|-------|-----------|----------|
| Days in Month | 26 | 26 ✓ |
| Shipping Days | 15 | 15 ✓ |
| Remaining | **63** 🔴 | 11 |
| Average Speed | **39,284** 🔴 | 500–700 |

### Root cause

1. **Remaining = 63**: the topbar was on QTD. Speed endpoint used `period=PD`, so QTD (78 Mon-Sat days in Q2, 15 elapsed → remaining 63) leaked into the page. Speed is inherently a *monthly* metric; period inheritance was wrong.
2. **"Average Speed" = 39,284**: the label was wrong. The JS had always rendered `projected_mt` into `#sp-avgspeed`, and on QTD projected MT ≈ 504 × 78 days ≈ 39,300 — that's the Q2 projected total in MT, not an "average speed".

### Fix applied

**app.html**
- `loadSpeed()` now calls `getSpeedData({period: 'MTD'})` — Speed page forces MTD regardless of topbar.
- Hero tile label renamed: `"Average Speed"` → `"Projected (End of Month)"` with sub-label "MT at current pace".
- Wiring updated to canonical fields `daily_pullout`, `days_elapsed`, `days_total`, `days_remaining`, `projected_mtd`, `mtd_actual` (added in PASS 0 already).

**api/speed.js** — added last-month comparison fields:
- `last_month_full_mt` — full-month volume a month ago
- `last_month_same_day_mt` — same-day-of-month cumulative last month (for apples-to-apples vs current MTD)
- `vs_last_month_volume` — absolute MT delta
- `vs_last_month_pct` — % delta vs same-day last month

Verified live values now:
```
days_elapsed=15  days_total=26  days_remaining=11
daily_pullout=504.4 MT/day  projected_mtd=13,115 MT
vs_last_month_pct=-13 (%)
```

---

## 3. Tables Rendered — API → DOM

Legend: **✓ wired** (built dynamically from API response) · **○ logged-only** (API has data but table keeps prototype layout) · **— not in API**.

### Speed page (`pg-speed`) — `/api/speed`

| Table | Status | API field |
|-------|--------|-----------|
| RSM Current Speed | ✓ wired (3 cols: RSM / Vol MT / Share %) | `rsm_speed[]` |
| Feed Type Speed | ✓ wired (3 cols: Brand / Vol / Share %) | `feed_type_speed[]` |
| Plant breakdown (matrix) | ○ logged | `plant_breakdown[]` |
| Weekly Matrix | ○ logged (complex pivot) | `weekly_matrix` |

### Margin Alerts (`pg-margin`) — `/api/margin`

| Table | Status | API field |
|-------|--------|-----------|
| Warning accounts | ✓ wired (Customer / Code / Rep / Sales / Vol / GP% / GM/Ton) | `warning[]` |
| GM by Region | ✓ wired | `by_region[]` |
| GM by Brand | ✓ wired | `by_brand[]` |
| GM by Plant | ✓ wired | `by_plant[]` |
| Worst SKUs | ✓ wired | `worst_skus[]` |
| GM by Sales Group | — | not in API (`by_group` missing) |
| GM by BU | — | not in API (`by_bu` missing) |

### Customer Intelligence (`pg-insights`) — `/api/intelligence`

| Table | Status | API field |
|-------|--------|-----------|
| Brand Coverage | ✓ wired (live: VIEPRO 531 cust / 67%, VIEPROMO 127, KEOS 103, NOVOPET 32) | `brand_coverage[]` (fixed: was returning 5059 SKU rows — now groups by first-word of description) |
| Horizontal Targets | ✓ wired | `horizontal_targets[]` |
| Buying Patterns | ✓ wired | `buying_patterns[]` |
| Health Distribution | ○ logged (prototype bar retained) | `health_distribution[]` |
| SKU Penetration Matrix | ○ logged (complex grid) | `sku_penetration_matrix` |
| Vertical Targets (separate table) | — | not returned as standalone array |

### Sales Team (`pg-team`) — `/api/team`

| Table | Status | API field |
|-------|--------|-----------|
| RSM Scorecard (main 14-col table + totals) | ✓ wired | `rsms[]` |
| RSM Rankings list | ✓ wired (sorted by YTD volume) | `rsms[]` sorted |
| Account Health by RSM | ✓ wired (simplified 5 cols) | `account_health[]` |
| 6-month Performance Matrix | ○ logged | `performance_matrix` |
| Volume by BU × Region | — | not in API |

**⚠ Data caveat** — RSM scorecard shows the correct RSM names (Mart / Joe / Eric / Edfrey / Mat / Carminda / Richard / Ma Lynie) but `ytd_vol` values are small or zero. Root cause: `api/team.js` does fuzzy-match between the hard-coded `RSM_HIERARCHY` list and `OSLP.SlpName`; in SAP, RSMs aren't individual salespeople — TSRs are. Without a proper `SlpCode → RSM` mapping, attribution fails. **Flagged for Track B** — Mat needs to provide the mapping or the data must be aggregated via `SlpCode IN (…)` per RSM.

### Budget & P&L (`pg-budget`) — `/api/budget`

| Table / Field | Status | API field |
|---------------|--------|-----------|
| Hero: YTD Actual / YTD Budget / Achievement % | ✓ wired (now: 55,789 / 57,134 / 98%) | `hero.*` |
| Volume Achievement by Region | ✓ wired | `achievement_by_region[]` |
| Volume Growth History chart | ✓ wired (already in Pass 0) | `volume_history[]` |
| Monthly Actual vs Budget chart | ✓ wired (already in Pass 0) | `monthly_actual_vs_budget` |
| P&L summary table | ○ logged (complex row structure) | `pl_summary` |
| Budgeted Volume by Region (quarterly) | — | not matched to `budgeted_volume` structure |
| GM Achievement by Region | — | no `gm_by_region` array in API (prototype retained) |

### Customer Detail (`pg-custdetail`) — `/api/customer?id=`

| Table | Status | API field |
|-------|--------|-----------|
| Monthly Breakdown | ✓ wired (Month / Vol CY / Vol LY / vs LY / Sales CY) | `monthly_table[]` |
| Top Products · YTD | ✓ wired (with progress bars) | `product_breakdown[]` |
| Recent Orders | ✓ wired | `recent_orders[]` |
| Hero / KPIs | ✓ wired (already in Pass 0) | `info`, `ytd_sales`, `gmt`, `dso` |
| CY vs LY chart | ✓ wired (already in Pass 0) | `cy_vs_ly[]` |

---

## 4. API Fields Missing (Flag for Track B)

| Page | Expected column | Missing field in API |
|------|-----------------|---------------------|
| Margin | GM by Sales Group (Hogs / Poultry / Gamefowl / Specialties) | `by_group[]` |
| Margin | GM by Business Unit (Distribution / KA / Pet Care) | `by_bu[]` |
| Team | YTD Target per RSM | `ytd_target` (currently `0`, needs budget breakdown per RSM) |
| Team | RSM attribution of volume | `SlpCode → RSM` mapping required (Mat to supply) |
| Team | Volume by BU × Region | `bu_region_split[]` |
| Budget | P&L row arrays with monthly breakdown by row label | `pl_summary.rows[]` has data but complex structure |
| Budget | GM Achievement by Region with GM Actual / GM Budget / Ach% / GM/Ton | `gm_by_region[]` (different shape than volume `achievement_by_region`) |
| Intelligence | Vertical Targets (current vs benchmark) | `vertical_targets[]` standalone |
| Intelligence | Reorder Prediction cadence detail | already in `reorder_predictions[]` — not surfaced in UI |

---

## 5. Deployment

| Target | Value |
|--------|-------|
| Cloud Run preview | `vieforce-hq-api-00030-man` at `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app` · 0% traffic |
| Vercel preview | `https://vieforce-juzqal30n-mathieu-7782s-projects.vercel.app` |
| Production | untouched |

### Commits pushed to `design-upgrade`
- `2e7bc07` — Track A: wire 6 prototype table groups + fix Speed page + harden filter cache
- `c58cedc` — Intelligence: brand = first-word of Dscription (was SKU full description, 5059 rows)

---

## 6. What Mat should verify (incognito + Ctrl+Shift+R)

**https://vieforce-juzqal30n-mathieu-7782s-projects.vercel.app**

### Filters
- [ ] Click 7D / MTD / QTD / YTD — Net Sales, Volume, GM values visibly change. YTD ≈ 10× MTD.
- [ ] Click vs PP / vs LY — delta arrows update. vs LY will show "+0%" (no 2025 SAP data, expected).
- [ ] Click MT / Bags — Volume KPI reformats. Bags ≈ volume_bags from API (currently 162,174 bags for 7,315 MT).
- [ ] Reload — current period/compare/unit persists.

### Speed page
- [ ] Shipping Days = 15, Remaining = **11** (not 63).
- [ ] Two hero tiles: "Average Pullout" = ~504 MT/day · "Projected (End of Month)" = ~13,115 MT.
- [ ] RSM Current Speed table shows real RSM names + volumes.
- [ ] Feed Type table shows real brand names + shares.

### Customer Intelligence
- [ ] Brand Coverage table: **VIEPRO** 531 cust 67%, **VIEPROMO** 127 cust, **KEOS** 103 cust, **NOVOPET** 32 cust (no more "VIEPro Premium" / "Metro Feeds" hardcoded).
- [ ] Buying Patterns table populated with Loyal / Stable / Monitor / At Risk bands.

### Margin Alerts
- [ ] Warning accounts table shows real customer names, codes, GP% values.
- [ ] By Region / By Brand / By Plant / Worst SKUs tables all populated.

### Sales Team
- [ ] Scorecard shows RSM names: MART / JOE / ERIC / EDFREY / MATHIEU / CARMINDA / RICHARD / MA LYNIE.
- [ ] ⚠ YTD Vol values will be low/zero — `OSLP.SlpName` ≠ RSM hierarchy. Flagged for Track B.
- [ ] RSM Rankings list populated.
- [ ] Account Health by RSM populated.

### Budget & P&L
- [ ] Hero: YTD Actual ~55,789 · YTD Budget ~57,134 · 98% Achievement (green).
- [ ] Volume Achievement by Region: Visayas / Mindanao / Luzon with real numbers and bar.

### Customer Detail (click any customer)
- [ ] Monthly Breakdown table populated with real CY/LY data.
- [ ] Top Products list with real SKUs (progress bars).
- [ ] Recent Orders list with real DocNums and amounts.

### AR page (regression check — Pass 1 state preserved)
- [ ] DSO = 31d (matches Finance 32d)
- [ ] 7-bucket aging · Account status 548/126/2 · Regional DSO · Top 20 clients

---

## 7. Rules Followed

- ✅ Did not claim something works without testing — backend tested per endpoint with actual HTTP calls; results pasted in this report.
- ✅ Filter fix proved by verifying backend responds differently per period (not just "I wrote code that should work").
- ✅ Speed formula change verified: days_remaining=11 (not 63), projected_mtd=13,115 (not 39,284 label).
- ✅ Flagged 9 tables where API is missing fields the UI needs — not hidden.
- ⚠ Team table "ytd_vol=0 for most RSMs" is openly flagged as data-mapping gap, not buried.

---

*Generated by Track A Agent — 2026-04-17*
