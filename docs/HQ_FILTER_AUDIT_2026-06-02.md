# VieForce HQ — Page / Chart / Filter-Responsiveness Audit

Date: 2026-06-02
Method: static source audit of `app.html` (8,794 lines) + all `api/*` endpoints, 5 parallel agents, line-level evidence.
Deployed commit: `d03d538` (Vercel app.html 200, Cloud Run API 200, CI green).

---

## How the header filter actually works (the "filter spine")

The topbar has **6 controls**, not 4. State vars: `PD` period, `CMP` compare, `UT` unit, `VF_REF_MONTH` month, `RG` region, `SEG` segment. Every change calls `loadPage(PG)` and re-runs the current page's loader.

| Control | UI values | How it reaches data | Responsive means |
|---|---|---|---|
| Period | 7D · MTD · QTD · YTD | sent to API via `vfApiParams()` | loader uses `vfApiParams()` AND endpoint reads `period` |
| As-of month | Live + last 24 months | sent as `ref_month` | loader uses `vfApiParams()` AND endpoint reads `ref_month` |
| Region | All/Luzon/Visayas/Mindanao/Other | sent as `region` | loader uses `vfApiParams()` AND endpoint reads `region` |
| Segment | All/DIST/KA/PET | sent as `segment` | loader uses `vfApiParams()` AND endpoint reads `segment` |
| Compare | **vs PP · vs LY** | **NOT sent to backend** | render code branches on `CMP` (API returns both `delta_pct` + `delta_pct_ly`) |
| Unit | **MT · Bags** | **NOT sent to backend** | render code branches on `UT` (API returns both `volume_mt` + `volume_bags`) |

Notes that change the user's mental model:
- The comparator labelled in the brief as "vs PY" is implemented as **vs LY** (`vs_ly`). There is no separate vs-PY.
- The unit toggle is **MT / Bags** (no "Kg"). 1 bag ≈ derived from `NumInSale`.
- `vfApiParams()` (app.html:3964) sends only `period, region, segment, ref_month`. Compare and Unit are pure client-side re-renders.

---

## Dashboard map (15 pages, 5 groups)

```
HOME & ROLE COCKPITS
  pg-home         National Overview        loadHome 4484        /api/dashboard
  pg-evp-home     EVP Executive Overview   loadEvpHome (js/evp-home.js)
  pg-rsm-home     RSM Regional             loadRsmHome (js/rsm-home.js)
  pg-dsm-home     DSM District             loadDsmHome (js/dsm-home.js) /api/dsm-home

COMMERCIAL
  pg-sales        Sales                    loadSales 4765       /api/sales (+/api/speed)
  pg-speed        Speed Monitor            loadSpeed 5347       /api/speed

FINANCE / OPS SNAPSHOTS
  pg-ar           Accounts Receivable      loadAR 5012          /api/ar
  pg-inv          Inventory                loadInv 5162         /api/inventory

CUSTOMERS
  pg-customers    Customer List            loadCust 5533        /api/customers
  pg-custdetail   Customer 360             openCust 5569        /api/customer (+/api/customer/soa)

INTELLIGENCE & PLANNING
  pg-margin       Margin Guardrails        loadMargin 5829      /api/margin
  pg-insights     Customer Intelligence    loadIntelligence 6231 + loadDeeperAnalytics 6433
                                                                /api/intelligence + /api/analytics-*
  pg-team         Sales Team               loadTeam 6777        /api/team
  pg-budget       Budget & P&L             loadBudget 6945      /api/budget
  pg-itemized     Itemized Sales           loadItemized 7090    /api/itemized (own local controls)
```

---

## Master page × filter matrix

Legend: ● fully responsive · ◐ partial / live-data-but-blocked · ○ control ignored · — N/A by design · 🔴 has static/proxy/dead blocks masquerading as live.

| Page | 7D/MTD/QTD/YTD | As-of month | vs PP/LY | MT/Bags | Region | Segment | Data integrity |
|---|---|---|---|---|---|---|---|
| Home | ● core KPIs · ○ charts/DSO/PO | ● core · ○ charts | ● | ◐ only headline Volume | ● | ● | 🔴 ticker + "shipping days" footer static; monthly/quarterly charts calendar-fixed |
| EVP Home | ◐ only P&L card | ○ | ● P&L card only | ○ | 🔴 **never sent** | 🔴 **never sent** | 🔴 Opportunity Radar + District line hardcoded; Regional ach% = fixed weights |
| RSM Home | ◐ hero only | ◐ hero only | ● hero | ○ | ◐ forced to session region | ○ | 🔴 District %, DSM scores, conversions, whitespace = name-hash/arithmetic proxies; Vet Mission + Strategic Decisions static |
| DSM Home | 🔴 **backend hardcodes MTD** | ○ | ● | ○ | — (SlpName scope) | — | live SAP but topbar-inert; target = 110%×prior (proxy); conversions = 0 |
| Sales | ● 7 KPIs + rankings + PO | ● | ● | ◐ KPIs + rankings | ● | ● | 🔴 2 dead charts (`salesTrendChart`,`gmGroupChart`); GM/Ton matrix, BU split, 4 "vs Y-1" panels all hardcoded |
| Speed | ● hero/KPIs/chart/tables | ● | ● pullout | ○ MT only | ● | ● | 🔴 weekly matrix ignores period/month (trailing-6wk off GETDATE); sparkline dead; "vs Last Month" headers show share%, not delta; **7D = 7 days here vs 8 elsewhere** |
| AR | — snapshot | — | ○ chip dropped | — | ○ chip dropped (region is a row dim) | ○ | live; correct as snapshot but topbar RG/CMP silently inert |
| Inventory | — snapshot | — | — | ● (page-local toggle, not global UT) | drilldown (hash, not topbar) | — | live; 🔴 By-Sales-Group MT mode zeroes 3 of 5 columns |
| Customers | — T12M list | — | — | ○ MT label fixed | ● | ● | live; 🔴 no pagination (top-50 only); "Sort" header non-functional; 8 mock rows in static HTML |
| Customer 360 | — (one customer) | — | — | — | — | — | 🔴 **AR Aging card + Account Info card hardcoded for every customer**; Top Products/Recent Orders/Growth = field-name mismatch → 0/blank; `custSalesGmChart` dead |
| Margin | ● KPIs + tables | ● | — (no PP/LY deltas) | ○ GM/Ton ₱/MT only | ● (table collapses to 1 row when filtered) | ● | 🔴 hero narrative banner static; GP% heatmap static; `marginRegionChart` dead; critical-card SKU sublists ignore `sku_breakdown` |
| Insights (upper) | — 120-day universe | ● | — | ○ | ● | ● | live; Win-Back Builder = "Coming in v1.1" |
| Insights (deeper) | — T12M | 🔴 **ref_month ignored** (GETDATE) | — | ◐ heatmap only | ● | ● | manual-load (no longer stuck-loading); cache keys omit ref_month + user; BU + all upside = proxy |
| Team | 🔴 **loader cache ignores params** | 🔴 cache | ● | ○ MT | 🔴 cache | 🔴 cache | endpoint is filter-ready but `DC['pg-team']` static cache defeats it; **RSM/DSM targets = 0** → ach% 0/all-red; L10, Perf Matrix, Volume-by-BU static |
| Budget | ● hero + wired tables | ● | — (vs paced budget) | ○ MT | 🔴 RG pill not read (role/warehouse only) | 🔴 not read | 🔴 Budgeted-Volume table, Sales P&L, GM-by-region all static (API returns the data, loader only console.logs it); still on own constants, **not** using new `budget_2026.js` |
| Itemized | — (own controls) | — | ● local vs-LY | ● local MT/Bags | — | — | cleanest; live national, non-national = zeros + `district_mapping_pending` banner (correct) |

---

## Findings by severity

### 🔴 P0 — looks live, is fake (decision risk)
1. **Customer 360 AR Aging + Account Info cards** are hardcoded (₱28.4M, "Roberto Tan") — identical for every customer. (app.html:2588-2604, 2630-2636)
2. **RSM Home** District %, DSM scorecards, conversions, whitespace are derived from name strings / fixed factors — not data. (js/rsm-home.js:304,326,352,396)
3. **EVP Home** Opportunity Radar + top District performer are hardcoded literals; Regional achievement uses fixed weights not real targets. (js/evp-home.js:167,264,303)
4. **Team** RSM/DSM YTD targets are hardcoded 0 → every achievement% = 0, all rows red, budget bars empty. (api/team.js:553-554,605-606)
5. **Sales** GM/Ton matrix, BU split, and all four "vs Y-1" ranking panels are static HTML with a false "SAP · OINV" badge. (app.html:1859-1962)

### 🟠 P1 — live data, but a filter silently does nothing
6. **Team loader cache** `DC['pg-team']` has no params → period/region/segment/month never re-fetch in a session (endpoint supports them). (app.html:6781)
7. **DSM Home** backend hard-codes `getPeriodDates('MTD')` and frontend sends no params → period + month inert. (api/dsm-home.js:117)
8. **EVP Home** loader drops region & segment → those topbar pills do nothing on the whole page. (js/evp-home.js:57)
9. **Budget** RG/SEG pills not read (uses session role + warehouse CASE). (api/budget.js:107,172-191)
10. **Deeper Analytics** ref_month ignored (all 3 endpoints query `GETDATE()`); cache keys omit ref_month and user → cross-user shared. (analytics-sku-matrix.js:63,85)
11. **Speed weekly matrix** ignores period/month (trailing-6wk off server clock); desyncs under any As-of month. (api/speed.js:305)

### 🟡 P2 — dead canvases & endpoint data thrown away
12. Dead/never-rendered charts: `salesTrendChart`, `gmGroupChart` (Sales), `speedSparkline` (Speed), `marginRegionChart` (Margin), `custSalesGmChart` (Customer 360). Several have live API data available but unused (`monthly_trend`, `sku_breakdown`).
13. **Budget**: `budgeted_volume`, `pl_summary`, `gm_by_region` fetched then only `console.log`'d; the visible tables are static.
14. **Team**: `performance_matrix` computed by API, rendered as static HTML grid instead.
15. **Customer 360**: Top Products (`p.vol`/`p.name` vs `volume`/`item_name`), Recent Orders (`o.revenue`/`o.volume` vs `DocTotal`/`total_qty`), Growth insight (`m.cy_volume` vs `cy_vol[]`) — field-name mismatches → silent 0/blank.

### 🟢 Correct-by-design (not defects)
- AR, Inventory, Customers, Insights-upper, Customer-360 intentionally ignore Period (snapshots / T12M / single-customer). Flagged — not bugs.
- Itemized intentionally uses its own local District/Year/Unit/Compare controls instead of the topbar spine.

### Consistency bugs
- **7D means 7 days in Speed but 8 days everywhere else** (`shipping_days.getPeriodBounds` vs `_auth.getPeriodDates`). Still unfixed. (api/lib/shipping_days.js:96)
- **Unit toggle is barely wired** — only Home headline Volume, Sales KPIs/rankings, and Itemized honor MT/Bags. Most volume figures are MT-only.
- **`budget_2026.js` consolidation incomplete** — only `team.js` consumes it; `budget.js` still has its own near-duplicate constants with at least one divergent April figure.
- Many cards labelled "MTD" actually follow the selected period; several "vs Last Month" headers show share %, not a delta.

---

## Bottom line
The **live spine works** on the pages that matter most for daily use — Home core KPIs, Sales, Speed, Margin, Budget hero, Insights, Itemized — across Period, As-of month, Region, Segment, Compare. The gaps cluster in: (a) the **role cockpits** (EVP/RSM/DSM) which are largely proxy/static, (b) **Team** (real data, defeated by a cache bug + missing targets), and (c) scattered **hardcoded cards and dead charts** that look live. None of this blocks the beta, but the P0 items are decision-risk: a user could read fabricated AR/target numbers as real.
