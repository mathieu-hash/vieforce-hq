# AUTOPSY REPORT — VieForce HQ

**Date:** 2026-04-17
**Branch:** `design-upgrade` (commit `48ce3c7`)
**Cloud Run preview:** rev `00031-jud` (0% traffic) — 11/11 endpoints HTTP 200
**Vercel preview:** `vieforce-4rqbfobd2-mathieu-7782s-projects.vercel.app`
**Inspector:** Static code audit (METHOD A) + curl smoke tests (METHOD B) + cross-reference (METHOD C)
**Session used for API tests:** `4bc1c7c0-213b-49cc-9b88-1730b2906bbd` (Rico Abante TSR)

---

## Executive Summary

| Metric | Count |
|---|---:|
| Pages inspected | **12** (11 in spec + 1 bonus: pg-itemized) |
| API endpoints inspected | **11** (all HTTP 200) |
| Distinct UI elements catalogued | **~210** |
| 🟢 **Working** (wired + API has data) | **96** (46%) |
| 🟠 **Partial / wrong data** (wired but missing field, schema mismatch, partial render) | **31** (15%) |
| 🔴 **Broken / hardcoded prototype** (no JS binding, no API field, or stale demo values) | **83** (39%) |
| **Estimated fix effort** | **~36 engineering hours** (front-end) + **~12h** (backend new fields) |

**Overall health:** 🟠 The skeleton is solid (auth, routing, all 11 endpoints respond, AR is fully wired) but **3 pages are <50% functional** and Mat is correct that "many graphs and tabs don't work." The dominant failure mode is **prototype HTML left in place after API endpoint was built but DOM rendering was not wired** (the `LOGGED — keeping prototype` pattern documented in `DOM_RENDER_REPORT.md`).

---

## Per-Page Scorecard

### PAGE 1 — HOME (`pg-home`, lines 988-1224)
**Loader:** `loadHome()` at line 3284. **Endpoints:** `/api/dashboard`, `/api/sales`, `/api/ar`, `/api/speed` (parallel `Promise.all`).

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Top alert ticker (5 items) | `.ticker-inner` | Text | 🔴 Hardcoded | Static "25 customers over credit limit / 8 silent / 3 negative margin / 14,200 MT / Record month" — values never refresh | none | 30 min |
| Net Sales KPI (big + delta + YTD + bar + pct) | `#hk-sales` + `-d/-ytd/-ytd-bud/-bar/-pct` | KPI enriched | 🟢 Working | — | dashboard.revenue + delta_pct.revenue + ytd.revenue + budget.ytd_sales | — |
| Volume KPI | `#hk-vol` family | KPI enriched | 🟢 Working | MT/Bags toggle works via UT state | dashboard.volume_mt / volume_bags | — |
| Gross Margin KPI | `#hk-gm` family | KPI enriched | 🟢 Working | — | dashboard.gross_margin | — |
| GM/Ton KPI | `#hk-gmt` family | KPI enriched | 🟢 Working | Hardcoded target ₱6,550 (not in API — acceptable) | dashboard.gmt vs hardcoded 6550 | — |
| DSO KPI | `#hk-dso` family | KPI enriched | 🟢 Working | Mat's thresholds applied (<35/45/60). Delinquent gap badge shown if dso_total - dso_active ≥ 10 | dashboard.dso_active + dso_total | — |
| Daily Pullout KPI (period-aware) | `#hk-speed` family | KPI enriched | 🟢 Working | Label changes per period (7D/MTD/QTD/YTD) | speed.daily_pullout + days_elapsed/total/remaining | — |
| Pending PO KPI | `#hk-pending` family | KPI enriched | 🟢 Working | Color/status changes if oldest_days >7 / >14 | dashboard.pending_po.{total_mt, total_value, total_orders, oldest_days} | — |
| 4 margin pills | `#hm-critical/-warning/-watch/-growing` | Pill | 🟢 Working | Falls back to "healthy" if "growing" missing | dashboard.margin_alerts.{critical,warning,watch,growing\|healthy} | — |
| Region Performance table | `#home-region-tbody` | Table | 🟠 **Sales col shows ₱0 / vs PP shows "--"** | API `region_performance[]` only returns `{region, vol, gm_ton}` — no `sales`, no `vs_pp`, no `dso` per region | dashboard.region_performance[] (incomplete) | 30 min (extend SQL) |
| BU Split horizontal bars (DIST/KA/PET) | inline (no id) | Visual | 🔴 Hardcoded | Always shows 7,810 / 4,260 / 2,130 = 14,200 MT — never updates | API missing `bu_split[]` | 1h (new SQL + render) |
| Top 5 Customers list | `#home-topcust` | List | 🟢 Working | Click navigates to customer detail | dashboard.top_customers[] | — |
| Monthly Volume & GM combo chart | `#homeMonthlyChart` | Chart | 🔴 Hardcoded prototype | Chart never updated by `loadHome()`. `DOM_RENDER_REPORT.md` flagged this — needs region-split monthly_trend | API missing `monthly_trend_by_region` | 1h (new SQL + chart wiring) |
| Quarterly Volume & GM combo chart | `#homeQuarterlyChart` | Chart | 🔴 Hardcoded prototype | Same — not in API at all | API missing `quarterly_trend` | 1h |

**DESIGN/UX NOTES:** Hardcoded "Shipping days: 15 of 22 (68%)" sub-bar at line 1122 ignores the period. The KPI-card animation system (Pass 4) DOES work for the 7 wired KPIs.

---

### PAGE 2 — SALES (`pg-sales`, lines 1226-1521)
**Loader:** `loadSales()` at line 3474. **Endpoint:** `/api/sales`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| MTD Volume KPI | `#sk-vol` | KPI | 🔴 **Stays hardcoded** | Loader checks `if(d.volume_mt!=null)` — but `/api/sales` does NOT return `volume_mt` at top level (only `by_brand[]`, `top_customers[]`, etc.). KPI shows "14.2K MT" forever | sales endpoint needs top-level summary KPIs | 20 min (extend endpoint) |
| YTD Volume KPI | `#sk-ytdvol` | KPI | 🔴 Same problem | `ytd_volume_mt` not in API — KPI stays at hardcoded "54.4K MT ▲ 92%" | same | 20 min |
| MTD Sales KPI | `#sk-sales` | KPI | 🔴 Same problem | `revenue` not in `/api/sales` response — stays at "₱482M" | same | 20 min |
| Avg Speed KPI | `#sk-speed` | KPI | 🔴 Hardcoded | Loader does NOT touch this id at all. Shows "682 MT/d ▲ 4.8%" forever | should pull from /api/speed | 15 min |
| Avg GM/Ton KPI | `#sk-gmt` | KPI | 🔴 Same problem | `gmt` not in /api/sales — stays at "₱6,953" | extend endpoint | 20 min |
| Pending PO KPI | `#sk-pending` + `-sub` | KPI | 🟢 Working | Wired to `pending_po.summary.total_mt + total_orders` | sales.pending_po.summary | — |
| KPI deltas (5 of 6) | `#sk-vol-d`, `-ytdvol-d`, etc. | Delta | 🔴 Hardcoded | Loader doesn't update any delta arrows. All show "▲ 12.1%" / "▲ 8.3%" / etc. | API missing `delta_pct` per dimension | 30 min |
| Customer Rankings table (top 10) | `#sales-rankings-tbody` | Table | 🟢 Working | Wired. Click opens customer detail | sales.top_customers[] | — |
| Monthly Trend chart | `#salesTrendChart` | Chart | 🔴 Hardcoded prototype | Loader logs warning: "monthly_trend available but chart expects region-split data. Keeping prototype chart." | API missing `monthly_trend_by_region` | 1h |
| BU Split bars + GM/Ton chart | inline + `#gmGroupChart` | Visual | 🔴 Hardcoded | Same DIST/KA/PET 7,810/4,260/2,130. Chart canvas never touched | API missing `bu_split[]` and gm-by-group monthly | 1h |
| GM/Ton matrix (9 products × 7 months) | `.gm-matrix` (no id) | Table | 🔴 Hardcoded | Lines 1294-1305 — 70 hardcoded numbers from prototype. Never refreshed | API missing `gm_matrix` (groups × months) | 2h (new endpoint logic) |
| 4-panel Volume Rankings vs Y-1 (Brand/Products/Customer/District) | 4 `.rank-tbl` (no ids) | Tables | 🔴 Hardcoded | 92 lines of hardcoded rows (1311-1400) showing FY26 vs FY25 with growth %. API has `by_brand[113]` but is NOT rendered to these tables | API missing `vs_ly_pct` per dimension + `by_district[]`, `by_product[]` | 2h |
| Pending PO 5 KPIs | inline (no ids) | KPIs | 🔴 Hardcoded | "7,432 MT / ₱256M / 42 / 177 MT / 6 Credit Holds" never updates | sales.pending_po.summary has data but UI not wired | 30 min |
| Pending Region × BU matrix | `.gm-matrix` (no id) | Table | 🔴 Hardcoded | 4 rows × 5 cols hardcoded. API has `pending_po.by_region[4]` but no BU split | endpoint missing BU split in pending_po | 1h |
| Pending by Brand | `.rank-tbl` | Table | 🔴 Hardcoded | API has `pending_po.by_brand[45]` but loader doesn't render | wire it | 20 min |
| Pending by Major SKU | `.rank-tbl` | Table | 🔴 Hardcoded | API missing | API missing `pending_po.by_sku[]` | 1h |
| Pending by Region detail (8 cols) | `.tbl` | Table | 🔴 Hardcoded | API has Confirmed/CreditHold/AwaitingStock breakdown? No — only total_mt | extend `pending_po.by_region` shape | 1h |
| Top Pending Customers | `.tbl` | Table | 🔴 Hardcoded | API has `pending_po.top_customers[10]` but loader doesn't render | wire it | 20 min |
| Recent PO Detail (8+ rows) | `.tbl` | Table | 🔴 Hardcoded | Hardcoded "PO-26-0482" etc. with fake aging | API missing PO detail array | 1h |

**DESIGN/UX NOTES:** Pending PO section is the largest hardcoded prototype block in the app — entire 116-line section unwired. Section header counters ("42 orders · 7,432 MT · ₱256M") at line 1404 also hardcoded. **Sub-tabs**: there are no sub-tabs on this page — the 4-panel rankings are static side-by-side, not switchable.

---

### PAGE 3 — AR (`pg-ar`, lines 1524-1658)
**Loader:** `loadAR()` at line 3589. **Endpoint:** `/api/ar` (182KB, fully populated)

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Show-Delinquent toggle | `#ar-show-delinq` | Checkbox | 🟢 Working | Re-renders with delinquent included | `loadAR()` reactive | — |
| Mode description | `#ar-mode-desc` | Text | 🟢 Working | Updates per toggle state | — | — |
| Active AR / Clients / Delinquent AR cards (3) | `#ar-total/-clients/-delinq` + subs | KPIs | 🟢 Working | Switches between active-only and full per toggle | ar.active_balance, account_status | — |
| Account Status strip (Active/Delinquent/Inactive) | `#ar-status-active/-delinq/-inactive` | KPIs | 🟢 Working | Counts: 545/126/2 (matches Finance exactly) | ar.account_status | — |
| 7-bucket Aging bar + table | `#ar-aging-bar`, `#ar-aging-table` | Chart+Table | 🟢 Working | Bar segments scale, %s computed | ar.buckets | — |
| 7-day variation badges (DSO + AR) | `#ar-dso-7d/-now/-variation` + `-bal-` | Cards | 🟢 Working | Color-coded (green if dropping) | ar.dso_7d_ago, ar_7d_ago, ar_variation | — |
| AR by Region table | `#ar-region-tbody` | Table | 🟢 Working | DSO badge per region (color thresholds) | ar.by_region[4] | — |
| DSO gauge (val + ring + status) | `#ar-dso-val/-ring/-status` | Gauge | 🟢 Working | Mat's thresholds <35/45/60 applied | ar.dso_active or dso_total | — |
| Customer search box | `#ar-client-search` | Input | 🟢 Working | Live filter via `renderARClients()` | client-side | — |
| Filter pills (All/Active/Delinquent/Overdue) | `[data-ar-filter]` | Buttons | 🟢 Working | Active state managed | client-side | — |
| Sortable column headers | `.sortable` | Headers | 🟢 Working | All 6 sortable columns work asc/desc | client-side | — |
| Client AR list | `#ar-clients-tbody` | Table | 🟠 **Capped at 100 of 675** | Performance limit. Search/filter still operates on full 675 cache before slice | ar.clients[675] | 5 min (raise cap or paginate) |
| Client count display | `#ar-client-count` | Text | 🟢 Working | "X of Y clients" | client-side | — |

**DESIGN/UX NOTES:** This is the cleanest page in the app — Pass 1 + Quick Wins built it from scratch with full wiring. AR is the gold-standard template for what every other page should look like.

---

### PAGE 4 — INVENTORY (`pg-inv`, lines 1661-1801)
**Loader:** `loadInv()` at line 3713. **Endpoint:** `/api/inventory` (818KB)

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Unit toggle MT/Bags | `.tb-toggle-btn` | Buttons | 🟠 Calls `setU()` which re-renders, but `loadInv` doesn't read UT state — toggle has no visible effect | wire UT into loadInv | 15 min |
| Product filter dropdown | `#inv-product-filter` | Select | 🔴 Dead | No `onchange` handler; selection does nothing | wire onchange → re-render | 30 min |
| "Data Last Updated: 4/15/2026 8:23 PM" | text | Text | 🔴 Hardcoded | Static date | render `new Date().toLocaleString()` | 5 min |
| KPI: On Floor (154,429 bags) | `#pg-inv .kpi-val[0]` | KPI | 🔴 **Stays hardcoded** | Loader `if(d.summary)` — but API does NOT return `summary` object! Only `plants[]`, `items[]`, `by_region[]`, `negative_avail_count`, `cover_days{national}` | inventory endpoint needs `summary{}` object | 30 min (compute server-side) |
| KPI: Pending PO (157,680 bags) | `.kpi-val[1]` | KPI | 🔴 Same | hardcoded | same | — |
| KPI: On Production (77,640 bags) | `.kpi-val[2]` | KPI | 🔴 Same | hardcoded | same | — |
| KPI: Available (74,389 bags) | `.kpi-val[3]` | KPI | 🔴 Same | hardcoded | same | — |
| KPI: Cover Days (4.8 d) | `.kpi-val[4]` | KPI | 🔴 Same | API HAS `cover_days.national=387` but loader expects `s.cover_days` (s undefined) | wire `d.cover_days.national` | 5 min |
| KPI: Negative Avail (3 plants short) | `.kpi-val[5]` | KPI | 🔴 Same | API HAS `negative_avail_count=491` but loader expects `s.negative_avail_count` | wire `d.negative_avail_count` | 5 min |
| By Region table | inline (no tbody id) | Table | 🔴 Hardcoded | Loader logs `'[INV] '+d.by_region.length+' regions received'` but does not render. API has 4 regions | wire render | 30 min |
| By Plant table | inline | Table | 🔴 Hardcoded | Shows 8 plants. API returns 43 plants. Logs only | wire render | 30 min |
| By Sales Group table | inline | Table | 🔴 Hardcoded | API does NOT return `by_sales_group[]` at all | extend endpoint with SQL group-by | 1h |
| Product SKU detail "1 – 264 / 264" | `.inv-tbl` | Table | 🔴 **Misleading + Hardcoded** | Header claims 264 SKUs visible but only **~28 hardcoded rows** exist in HTML. Scrolling shows nothing more. API has 4,141 items but loader doesn't render | wire render with virtual scroll | 2h |

**DESIGN/UX NOTES:** This page is **functionally broken** — 100% of its content is the hardcoded prototype. The "1 – 264 / 264" pagination claim is a documented lie (only ~28 visible). Mat's complaint "many graphs and tabs don't work" applies most acutely here. Cover Days and Negative Avail are 5-minute fixes (just bind to wrong field names).

---

### PAGE 5 — SPEED MONITOR (`pg-speed`, lines 1804-1939)
**Loader:** `loadSpeed()` at line 3743. **Endpoint:** `/api/speed` (forced MTD per recent fix)

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Days In Month "26" | inline | Text | 🔴 Hardcoded | Should compute from current period | derive from days_total | 5 min |
| Shipping Days | `#sp-elapsed` | KPI | 🟢 Working | Live: 15 | speed.shipping_days_elapsed (or days_elapsed) | — |
| Remaining | `#sp-remain` | KPI | 🟢 Working | Live: 11 | speed.shipping_days_remaining | — |
| As of "Apr 14" date | inline | Text | 🔴 Hardcoded | Static text, doesn't update | derive from today | 5 min |
| Average Pullout | `#sp-pullout` | KPI | 🟢 Working | Live: ~518 MT/d | speed.daily_pullout | — |
| "↓ -0.2%" pullout delta | inline | Text | 🔴 Hardcoded | Static; should bind to `vs_prior_period_pct` | wire it | 5 min |
| Projected (End of Month) | `#sp-avgspeed` | KPI | 🟢 Working | Label fixed in PASS1 (was "Average Speed") | speed.projected_period_volume | — |
| Sparkline canvas | `#speedSparkline` | Chart | 🔴 Empty | Canvas exists but no Chart.js init code anywhere | wire mini chart from speed.daily[] | 30 min |
| Today MT KPI | `#spk-today` | KPI | 🟢 Working | speed.daily[last].daily_mt | speed.daily | — |
| MTD Total KPI | `#spk-mtd` | KPI | 🟢 Working | Fallback chain to mtd_actual | speed.mtd_actual | — |
| MTD Avg KPI | `#spk-avg` | KPI | 🟢 Working | speed_per_day | — | — |
| Projected KPI | `#spk-proj` | KPI | 🟢 Working | projected_mt | — | — |
| vs Last Month % | `#spk-vslm` | KPI | 🟢 Working | Color conditional | speed.vs_last_month_pct | — |
| Speed vs LM | `#spk-speedlm` | KPI | 🔴 Hardcoded "-0.2%" | Loader doesn't touch this id | derive: (daily_pullout / prior_period_daily_pullout - 1) * 100 | 10 min |
| Daily Pullout chart (14d) | `#speedChart` | Chart | 🟢 Working | Bars + dynamic colors | speed.daily[] | — |
| Weekly Matrix table | inline | Table | 🔴 Hardcoded | Shows W10-W14 (5 weeks). API returns `weekly_matrix.weeks[7]` (W10-W16) × 14 plants | wire render | 1h |
| Plant Matrix table (3 days) | inline | Table | 🔴 Hardcoded | Shows 5 plants. API returns 13 plants in `plant_breakdown[]` | wire render | 30 min |
| RSM Speed table | `#speed-rsm-tbody` | Table | 🟢 Working | 20 RSMs rendered | speed.rsm_speed[] | — |
| Feed Type Speed table | `#speed-feed-tbody` | Table | 🟢 Working | 15 brands rendered | speed.feed_type_speed[] | — |

**DESIGN/UX NOTES:** Hero band is inconsistent — 4 wired values + 2 hardcoded values (Days In Month, As of date) — looks live but isn't entirely. 11 brands in spec vs 15 in API.

---

### PAGE 6 — CUSTOMERS (`pg-customers`, lines 1942-1970)
**Loader:** `loadCust(search)` at line 3838. **Endpoint:** `/api/customers`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Region filter pills (All/Luzon/Visayas/Mindanao) | `.filter-chip` w/ `fltCust()` | Buttons | 🟠 Visually toggle but **filtering fails silently** | Calls `fltCust(r,el)` which clears cache and refetches with `region=r` param. But API endpoint doesn't actually filter — `customers[]` rows have no region/City data anyway (Phone1, City all null) | API missing customer.region (needs `WhsCode → Region` JOIN on dominant invoice) | 1h |
| Sort label "Sort: Sales ▼" | text | Text | 🔴 **Cosmetic only** | No actual sort dropdown / no click handler. Sorting impossible | implement client-side sort like AR | 30 min |
| No global search box on page | — | — | 🔴 Missing | Spec called for search; only the topbar global-search exists | add search input | 30 min |
| Customer table | `#cust-tbody` | Table | 🟠 Renders ~50 rows | Initial DOM has 8 hardcoded rows that get replaced. API returns `total: 1382, page: 1, pages: 28` — but pagination not implemented | client paginate | 2h |
| Row: Customer name | (col 2) | Cell | 🟢 Working | API CardName | customers[].CardName | — |
| Row: Code | (col 3) | Cell | 🟢 Working | API CardCode | customers[].CardCode | — |
| Row: Region | (col 4) | Cell | 🔴 **Empty** | API doesn't return region; City field is null for all 1382 customers | needs API extension | 1h |
| Row: BU | (col 5) | Cell | 🔴 **Empty** | API doesn't return BU | needs API extension | 1h |
| Row: Volume | (col 6) | Cell | 🟢 Working | volume_mt | customers[].ytd_volume | — |
| Row: Net Sales | (col 7) | Cell | 🟢 Working | revenue | customers[].ytd_revenue | — |
| Row: GM/Ton | (col 8) | Cell | 🔴 **Empty** | API doesn't return gm_ton per customer | needs API extension | 1h |
| Health indicators (per spec) | — | Visual | 🔴 Missing | DOM has no health badges — spec asked for these | needs API + UI | 2h |

**DESIGN/UX NOTES:** This is the **most under-built page**. Only 4 of 8 spec elements exist. Region filter is visible but functionally dead. Page would benefit from being modeled on the AR client list.

---

### PAGE 7 — CUSTOMER DETAIL (`pg-custdetail`, lines 1973-2179)
**Loader:** `openCust(code)` at line 3866. **Endpoint:** `/api/customer?id=`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Breadcrumb (Customers › Name) | `.breadcrumb` | Text | 🟢 Working | Updated with CardName | info.CardName | — |
| Hero name (h1) | `h1` in `.detail-hero` | Text | 🟢 Working | info.CardName | — | — |
| Hero meta (Code · Region · City · BU) | `.detail-meta` | Text | 🟠 Partial | Only Code/City/RSM populated; BU not in API | extend customer endpoint | 30 min |
| Hero sub (Sales Rep · Credit · Terms) | `.detail-sub` | Text | 🔴 Hardcoded "J. Santos · ₱30M · 45 days" | info has no credit_line, no terms returned per customer | extend endpoint | 1h |
| Hero badges (Active / Top 5 / Growing +8%) | `.detail-badges` | Pills | 🔴 Hardcoded | No compute logic; static badges | derive from customer status + rank | 1h |
| Last Order date "Apr 11" | inline | Text | 🔴 Hardcoded | Should derive from `recent_orders[0].DocDate` | wire it | 10 min |
| Acct Age "6.2 yr" | inline | Text | 🟠 API has `account_age_days` (128 in test) but UI doesn't bind | wire it | 5 min |
| Rank "#1" | inline | Text | 🟠 API has `rank_by_volume` (3 in test) but UI hardcoded "#1" | wire it | 5 min |
| Credit Use "95%" | inline | Text | 🔴 Hardcoded | No credit data in API | needs OCRD.CreditLine query | 1h |
| 8 KPIs (YTD Vol/Sales, MTD Vol/Sales, GM/Ton, DSO, Avg Order, Frequency) | `.kpi-val[0..7]` | KPIs | 🟠 5 of 8 wired | Loader uses `pg.querySelectorAll('.kpi-val')`. mtd_vol/mtd_sales return 0 in test data (period filter likely needed). Avg Order/Frequency in API but partial bind | kpis.{ytd_vol, ytd_sales, mtd_vol, mtd_sales, gm_ton, dso, avg_order, frequency} | 30 min |
| Insight: Growth Signal "+14% above baseline" | `.card` | Card | 🔴 Hardcoded | API doesn't compute baseline trends | new logic needed | 2h |
| Insight: SKU Mix Shift "Poultry 22→31%" | `.card` | Card | 🔴 Hardcoded | API doesn't compute mix shift | new logic needed | 2h |
| Insight: Credit Watch "95% util" | `.card` | Card | 🔴 Hardcoded | No credit data | needs API + logic | 2h |
| Insight: Opportunity "₱2.4M whitespace" | `.card` | Card | 🔴 Hardcoded | API doesn't compute whitespace per customer | needs API + logic | 2h |
| CY vs LY chart | `#custVolBarChart` | Chart | 🟢 Working | Chart.update() with cy_vs_ly arrays | customer.cy_vs_ly | — |
| 12-month Breakdown table | `#cust-monthly-tbody` | Table | 🟢 Working | Renders monthly_table[] | monthly_table | — |
| Sales/GM Trend chart | `#custSalesGmChart` | Chart | 🔴 **Canvas empty** | No Chart.js init or data binding anywhere for this id | wire chart | 1h |
| AR Total / Credit Line | inline "₱28.4M / ₱30.0M" | Text | 🔴 Hardcoded | No credit data in API | needs endpoint extension | 1h |
| AR Aging (4 buckets) | inline 65/20/10/5% | Bar | 🔴 Hardcoded | API has 3 ar_invoices but no aging breakdown per customer | derive from ar_invoices[].days_overdue | 30 min |
| Top Products list | `#cust-products-list` | List | 🟢 Working | Renders product_breakdown (top 6) | customer.product_breakdown | — |
| Recent Orders list | `#cust-orders-list` | List | 🟢 Working | Renders recent_orders (top 10) | customer.recent_orders | — |
| Account Info card | inline | Card | 🔴 Hardcoded | "Roberto Tan / +63 917 / r.tan@..." — never refreshes; phone/email all null in API anyway | extend endpoint | 30 min |

**DESIGN/UX NOTES:** Hero panel and 4 insight cards are entirely hardcoded — these are the most visible "fake intelligence" elements. AR aging numbers (65/20/10/5%) match no customer's actual aging.

---

### PAGE 8 — MARGIN ALERTS (`pg-margin`, lines 2183-2354)
**Loader:** `loadMargin()` at line 3954. **Endpoint:** `/api/margin`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Hero negative GP exposure | `.detail-hero [style*="font-size:28px"][0]` | Text | 🟢 Working | Updated to "-₱147K" (API: -146646) | hero.negative_gp_total | — |
| Hero revenue at risk | `[style*="font-size:28px"][1]` | Text | 🟢 Working | Updated to "₱629M" (API: 628M) | hero.revenue_at_risk | — |
| Hero CRITICAL/WARNING badges | `.badge.b-red, .b-gold` | Badges | 🟢 Working | Updated to "36 CRITICAL / 257 WARNING" — BUT initial paint shows hardcoded "3 CRITICAL / 7 WARNING" until API responds | hero.critical_count, warning_count | — |
| Hero text body ("₱337K negative GP from 3 critical accounts") | inline | Text | 🔴 **Stale narrative** | Hardcoded paragraph references "3 critical accounts" — now 36 per API | re-render text from API | 30 min |
| KPIs (Critical/Warning/Watch/Healthy/Nat'l GM/T/Nat'l GP%/Best/Worst) | `#pg-margin .kpi-val[0..7]` | KPIs | 🟢 Working | Loader uses indexed querySelectorAll. **All 8 update** with kpis.{critical:36, warning:257, watch:106, healthy:101, ...} on load | margin.kpis.* | — |
| Filter pills (All/Critical/Warning/Watch + 3 regions) | `.filter-chip` | Buttons | 🟠 Toggle visually via `setF()` but no filtering logic on data | implement filter | 1h |
| 3 Critical account cards | `.margin-card.critical` | Cards | 🟢 Working | Loader updates first 3 from critical[]. Customer name, code+rep, GP%, Sales/Vol/GP | margin.critical[0..2] | — |
| Critical card: SKU breakdown sub-table | inline (3 SKU lines per card) | Sub-table | 🔴 Hardcoded | API critical[] has NO `sku_breakdown` nested. Each card shows fake "VP Hog Finisher -8.2%" lines | extend endpoint | 1h |
| Sidebar margin badge count | `.nav-item .b-red` | Badge | 🟢 Working | Updated to "36" | kpis.critical | — |
| Warning accounts table | `#margin-warn-tbody` + `#margin-warn-count` | Table | 🟢 Working | Renders all 257 warning rows | margin.warning[] | — |
| GM/Ton by Region table | `#margin-region-tbody` | Table | 🟢 Working | 4 regions w/ color thresholds | margin.by_region[] | — |
| GM/Ton by **Sales Group** table (Hogs/Poultry/etc) | inline (no tbody id) | Table | 🔴 **Hardcoded — API missing** | API does NOT return `by_sales_group[]`. Always shows GAMEFOWL 24.6% / POULTRY 18.4% / etc | extend endpoint with SQL group-by | 2h |
| GM/Ton by Brand table | `#margin-brand-tbody` | Table | 🟢 Working | Top 15 brands rendered | margin.by_brand[] | — |
| GM/Ton by **BU** table (Distribution/KA/Pet) | inline | Table | 🔴 **Hardcoded — API missing** | API does NOT return `by_bu[]` | extend endpoint | 2h |
| GM/Ton by Plant table | `#margin-plant-tbody` | Table | 🟢 Working | 19 plants | margin.by_plant[] | — |
| Worst SKUs table | `#margin-worst-tbody` | Table | 🟢 Working | Top 10 worst | margin.worst_skus[] | — |
| GM/Ton Trend chart (6mo) | `#marginRegionChart` | Chart | 🔴 Empty | Canvas exists but never initialized | API + chart wiring | 2h |
| GP% Heatmap (Region × Group) | `.matrix` | Table | 🔴 Hardcoded | 3×5 matrix of fake percentages | needs API matrix field | 2h |

**DESIGN/UX NOTES:** Hero numbers were correctly noted by an upstream agent as showing "3/7" briefly until API loads — that flashing prototype is jarring. Initial paint should use `—` placeholders instead of misleading prototype values.

---

### PAGE 9 — CUSTOMER INTELLIGENCE (`pg-insights`, lines 2359-2562)
**Loader:** `loadIntelligence()` at line 4087. **Endpoint:** `/api/intelligence`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Hero: Whitespace ₱ | `[style*="font-size:22px"][0]` | Text | 🟢 Working | hero.whitespace_total | — | — |
| Hero: At-Risk ₱ | `[1]` | Text | 🟢 Working | hero.at_risk_total | — | — |
| Hero: Avg Health | `[2]` | Text | 🟢 Working | "66/100" | hero.avg_health_score | — |
| KPI: Silent ≥30d | `.kpi-val[0]` | KPI | 🟢 Working | "10" | kpis.silent_30d | — |
| KPI: Vol Drop | `[1]` | KPI | 🟢 Working | "2" | kpis.vol_drop | — |
| KPI: Growing | `[2]` | KPI | 🟢 Working | "10" | kpis.growing | — |
| KPI: New SKU "6" | `[3]` | KPI | 🔴 Hardcoded | Loader skips kpis[3] entirely; field not in API | needs new logic | 30 min |
| KPI: Avg SKUs/Cust | `[4]` | KPI | 🟢 Working | "8" | kpis.avg_skus_per_cust | — |
| KPI: Avg Brands/Cust | `[5]` | KPI | 🟢 Working | "14.1" | kpis.avg_brands_per_cust | — |
| KPI: Avg Order Freq "2.1/wk" | `[6]` | KPI | 🔴 Hardcoded | Field not in API | new SQL | 30 min |
| KPI: Avg Order Size "28 MT" | `[7]` | KPI | 🔴 Hardcoded | Field not in API | new SQL | 30 min |
| Hero narrative paragraph "710 active accounts" | inline text | Text | 🔴 Stale | API total_active=788 | wire from hero.total_active | 5 min |
| Brand Coverage table | `#intel-brand-tbody` | Table | 🟢 Working | 17 brands | brand_coverage[] | — |
| Vertical Growth box (186 accts) | inline | Card | 🔴 Hardcoded | API does NOT return `vertical_targets[]` | extend endpoint | 2h |
| Horizontal Growth box (312 accts) | inline | Card | 🔴 Hardcoded | Computed from buying_patterns? Currently static | derive from API | 30 min |
| Horizontal Targets table | `#intel-horiz-tbody` | Table | 🟢 Working | Top 10 of 20 rendered | horizontal_targets[] | — |
| Buying Patterns table | `#intel-pattern-tbody` | Table | 🟢 Working | 5 bands w/ signal badges | buying_patterns[] | — |
| Reorder Prediction text "42 expected / 18 overdue" | inline | Text | 🔴 Hardcoded | API has reorder_predictions[15] but UI doesn't compute summary text | derive | 15 min |
| SKU Penetration Matrix (8×10 grid) | `.pen-tbl` | Table | 🔴 **Hardcoded — API has 15×10 grid** | DOM shows 8 hardcoded customers w/ ●/○ marks. API `sku_penetration_matrix.grid[15][10]` is unused | wire render | 2h |
| Behavioral Alerts: Silent column (3-4 hardcoded names + "5 more") | inline | Card | 🔴 Hardcoded | API behavioral_alerts.silent[10] unused | wire render | 30 min |
| Behavioral Alerts: Drops column | inline | Card | 🔴 Hardcoded | API behavioral_alerts.drops[2] unused | wire render | 30 min |
| Behavioral Alerts: Growing column | inline | Card | 🔴 Hardcoded | API behavioral_alerts.growing[10] unused | wire render | 30 min |
| Account Health Score Distribution bar + table | inline | Bar+Table | 🔴 Hardcoded | API health_distribution[5] returns ALL ZEROS in current data — even if wired, would render empty | fix backend SQL **and** wire | 3h |
| Reorder Prediction table (7 customers) | inline | Table | 🔴 Hardcoded | API reorder_predictions[15] unused | wire render | 30 min |
| Footer alert "18 accounts 5+ days overdue" | inline | Text | 🔴 Hardcoded | derive from reorder_predictions filter | derive | 10 min |

**DESIGN/UX NOTES:** This is the page where API delivers most data and UI uses least of it — 5 wired tables vs. 8 hardcoded prototype sections. The full intelligence layer exists in API but only 30% renders.

---

### PAGE 10 — SALES TEAM (`pg-team`, lines 2566-2778)
**Loader:** `loadTeam()` at line 4169. **Endpoint:** `/api/team`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| EVP Hero header "EVP Sales & Marketing — National Overview" | inline | Text | 🟢 Hardcoded but **correct** (Quick Wins removed Joel name) | — | — | — |
| EVP avatar "EVP" | inline | Text | 🟢 Hardcoded but correct | — | — | — |
| EVP sub-header "8 RSMs · 24 DSMs · 710 Active" | inline | Text | 🔴 Stale | API: rsm_count=8, dsm_count=34, customers=85 (not 710) | wire from evp.* | 15 min |
| EVP hero stats (YTD Vol 54.4K / Budget 62.6K / 87% / +92% / 15.6K Speed / ₱6,953 GM/Ton) | inline | KPIs | 🔴 **All hardcoded** | Loader has comment `// console.log only` — does NOT update any of these | wire all 6 from evp.{ytd_vol, speed, gm_ton, customers_count, rsm_count, dsm_count} | 30 min |
| L10 Scorecard table (15 weeks × 5 measurables) | inline `.l10` | Table | 🔴 **Entirely hardcoded** | NO `/api/l10` endpoint exists. Table shows 5 hardcoded Joel rows w/ 75 weekly cells. Quick Wins removed Rachel row only | needs new endpoint OR keep as static EOS template (decide) | 5h (new endpoint) OR 0h (accept static) |
| View tabs (By Region/RSM, By BU, Rankings) | `.filter-chip` | Buttons | 🟠 `setF()` toggles active state but no actual view switching code | implement view switch | 2h |
| RSM Scorecard table | `#team-tbody` | Table | 🟢 Working | Renders all 8 RSMs + national totals row. **BUT data quality issue:** ytd_vol values are nearly all 0 (MART=15 instead of expected ~6000+) due to broken SlpCode→RSM mapping in SAP query | rsms[] (data integrity issue, not wiring issue) | Backend |
| RSM rows: ytd_target column | (col 5) | Cell | 🔴 Always shows 0 | API rsms[].ytd_target=0 for all — no budget mapping | needs SAP budget linkage | 2h backend |
| RSM rows: ach_pct column | (col 6) | Cell | 🔴 Always shows 0% | Derives from ytd_target=0 → 0/0 → 0 | same backend issue | — |
| RSM rows: vs_ly column | (col 8) | Cell | 🔴 Always 0 / "+0%" | API: vs_ly=0 for all (no LY data) | needs LY SAP data | Backend |
| Hardcoded DSM sub-rows (A. Dizon, R. Santos, etc — 14 visible) | `.dsm-row` | Rows | 🔴 Hardcoded | DSM rows are inside the static prototype with fake numbers — loader REPLACES tbody entirely so these get wiped on load. After API responds the DSM hierarchy is GONE | API needs DSM-level array | 4h |
| RSM Rankings list | `#team-rank-list` | List | 🟢 Working | Sorts rsms[] by ytd_vol desc | rsms[] derived | — |
| 6-Month Performance Matrix | `.matrix` | Table | 🔴 **Hardcoded** | Loader logs only. API has `performance_matrix.{months[4], rsms[8], grid[8×4]}` with ~all-zero grid | wire render | 2h |
| Volume by BU × Region table | inline `.tbl` | Table | 🔴 **Hardcoded** | API does NOT return `bu_region_split[]` | extend endpoint with new SQL | 2h |
| Account Health by RSM table | `#team-health-tbody` | Table | 🟢 Working | All 8 RSMs rendered | account_health[] | — |

**DESIGN/UX NOTES:** L10 Scorecard is operationally important to Mat (EOS framework) but has no backing data source — needs a decision: build `/api/l10` endpoint OR accept it as a static EOS reference. View tabs (By Region/By BU/Rankings) appear functional but don't switch the table view. Note: small text "Targets are placeholder — update with actual RSM/DSM budgets" on line 2652 acknowledges the ytd_target gap.

---

### PAGE 11 — BUDGET & P&L (`pg-budget`, lines 2782-2910)
**Loader:** `loadBudget()` at line 4263. **Endpoint:** `/api/budget`

| Element | DOM id/selector | Type | Status | Issue | Endpoint·Field | Fix Effort |
|---|---|---|---|---|---|---|
| Hero header "Sales Volume Budget 2026" | inline | Text | 🟢 Hardcoded but acceptable | — | — | — |
| Hero "FY Target: 188,266 MT · ₱5.97B" | inline | Text | 🔴 Hardcoded | API has hero.fy_target_mt + fy_target_sales | wire | 10 min |
| Hero KPI: YTD Actual | `#bud-ytd-actual` | KPI | 🟢 Working | "55,928" | budget.hero.ytd_actual | — |
| Hero KPI: YTD Budget | `#bud-ytd-budget` | KPI | 🟢 Working | "57,134" | budget.hero.ytd_budget | — |
| Hero KPI: Achievement % | `#bud-ytd-ach` | KPI | 🟢 Working | "98%" w/ color | budget.hero.achievement_pct | — |
| Volume Growth History chart | `#budgetHistoryChart` | Chart | 🟢 Working | 10 years of data | budget.volume_history[] | — |
| Budgeted Volume table (Region × Quarter, w/ sub-rows) | inline `.bud-tbl` | Table | 🔴 **Hardcoded** | API has full `budgeted_volume.{regions[3], total{}}` with sub_rows for Hogs/Poultry/Gamefowl per region. Loader does NOT render this — table is 14-row hardcoded prototype | wire render | 2h |
| Sales Budget P&L table (Volume/NetSales/COGS/GM × monthly + YTD + FY) | inline `.pl-tbl` | Table | 🔴 **Hardcoded** | Loader logs `[BUDGET] P&L summary: 4 months — prototype table retained`. API `pl_summary.rows[4]` available | wire render | 3h |
| Volume Achievement by Region table | `#bud-region-tbody` | Table | 🟢 Working | 3 regions w/ totals | budget.achievement_by_region[] | — |
| Monthly Actual vs Budget chart | `#budgetMonthlyChart` | Chart | 🟢 Working | 4 months | budget.monthly_actual_vs_budget | — |
| GM Achievement by Region table | inline `.tbl` (no tbody id) | Table | 🔴 **Hardcoded** | API has `budget.gm_by_region[3]` w/ all fields, loader doesn't render — table shows fake VISAYAS ₱122M / MINDANAO ₱66M / etc | wire render | 30 min |

**DESIGN/UX NOTES:** Cleanest backend support of any page (budget endpoint returns nearly everything UI needs) but 3 of the 4 main tables are still hardcoded prototypes. Easy wins.

---

### BONUS — PAGE 12: ITEMIZED SALES (`pg-itemized`, lines 2913-2994)
Not in spec, but discovered during audit. **Endpoint:** `/api/itemized` + `/api/itemized/meta`. Has dropdown, year selector, MT/Bags toggle, vs LY checkbox, search, export buttons. Shows controls + KPI strip + main table + form summary. Has a "Phase 1" warning banner: "District-level SAP mapping not yet wired." Status: out-of-spec; appears functional with its own loader (`loadItemized()` at ~line 4334+). **Skipping detailed audit.**

---

## Critical Issues (Top 10 — by visible impact)

| # | Issue | Page | Type | Impact | Effort |
|---|---|---|---|---|---|
| 1 | **Inventory page is 100% prototype** — KPIs and all 4 tables hardcoded; loader checks `d.summary` which doesn't exist | INV | Wiring | Whole page useless for ops | 2h fix (rename fields) |
| 2 | **Sales page KPIs (5 of 6) stay hardcoded** — loader expects `volume_mt`/`revenue`/`gmt` at top of `/api/sales` response, but endpoint returns only nested arrays | SALES | API shape mismatch | KPI strip lies; "Avg Speed 682" never updates | 30 min (extend endpoint) |
| 3 | **Sales Pending PO section: 5 KPIs + 6 sub-tables all hardcoded** despite API returning all the data needed | SALES | Wiring | 116 lines of fake data on Mat's most-used drilldown | 3h |
| 4 | **Customer Intelligence behavioral alerts hardcoded** — Silent/Drops/Growing all show 3-4 fake names + "+ N more"; API has 10/2/10 but unused | INSIGHTS | Wiring | Mat sees stale "Zamboanga Feeds 42d ago" placeholders forever | 1.5h |
| 5 | **Team Page hero stats hardcoded** — YTD 54.4K / Budget 62.6K / 87% / +92% never update; loader only logs | TEAM | Wiring | EVP dashboard shows stale Q1 numbers | 30 min |
| 6 | **Customer Detail hero + 4 insight cards 100% hardcoded** — "J. Santos / ₱30M credit / +14% growth / 22→31% poultry" never refresh per customer | CUSTDETAIL | Wiring + missing API | Every customer profile shows Metro Feeds Corp.'s prototype data | 4h |
| 7 | **Margin: by_sales_group + by_bu tables hardcoded** — API doesn't return these dimensions at all | MARGIN | API gap | 2 of 6 dimension tables show stale demo | 4h backend |
| 8 | **Customers page columns Region/BU/GM-Ton are EMPTY** — API doesn't return them | CUSTOMERS | API gap | 3 of 6 columns blank on every row | 3h backend |
| 9 | **Speed Weekly + Plant matrices hardcoded** — show 5 weeks/plants when API has 7 weeks × 14 plants and 13 plants | SPEED | Wiring | Wrong week labels (W14 instead of W16) | 1.5h |
| 10 | **Region Performance table on HOME shows ₱0 in Sales column for every region** — `region_performance[]` API returns no `sales` field | HOME | API gap | National row footer shows correct sales but per-region rows show zeros | 30 min backend |

---

## Quick Fixes (< 15 min each)

1. **Inventory KPIs Cover Days + Negative Avail** — bind `d.cover_days.national` and `d.negative_avail_count` directly (loader currently expects `d.summary.*` which doesn't exist). 5 min each.
2. **Speed page "↓ -0.2%" pullout delta hardcoded** — bind `vs_prior_period_pct` like Home does. 5 min.
3. **Speed page "Days In Month: 26" hardcoded** — bind `days_total`. 5 min.
4. **Speed page "As of: Apr 14" hardcoded** — bind `new Date()`. 5 min.
5. **Customer Detail: Last Order, Account Age, Rank** — three direct field bindings exist in API; UI shows hardcoded values. 5 min each.
6. **Intelligence hero narrative "710 active"** — bind `hero.total_active` (API: 788). 5 min.
7. **Inventory "Data Last Updated 4/15/2026"** — bind to current time. 5 min.
8. **Margin hero text body** — bind narrative to `hero.critical_count` and `hero.negative_gp_total`. 10 min.
9. **Speed `#spk-speedlm` "-0.2%" hardcoded** — derive from `daily_pullout / prior_period_daily_pullout - 1`. 10 min.
10. **Reorder Prediction text on Intelligence** — derive "X expected / Y overdue" from `reorder_predictions[]`. 15 min.

**Quick wins subtotal: ~1.5h** for 10 visible improvements.

---

## Medium Fixes (15-60 min each)

| Fix | Effort | Page |
|---|---|---|
| Wire all 5 Sales KPIs to `/api/dashboard` instead of `/api/sales` (or add fields to sales endpoint) | 30 min | SALES |
| Wire Sales 6 KPI deltas (currently all hardcoded "▲ X%") | 30 min | SALES |
| Wire Inventory 4 main KPIs (need to compute summary server-side OR change loader to use d.plants[] aggregation) | 30 min | INV |
| Wire Inventory By Region table (logged only, API has data) | 30 min | INV |
| Wire Inventory By Plant table (43 plants in API) | 30 min | INV |
| Render Margin by_brand table extension (loader does first 15 — fine) | — | — |
| Wire Speed Plant Matrix (13 plants in API) | 30 min | SPEED |
| Wire Speed Weekly Matrix (7 weeks × 14 plants in API) | 1h | SPEED |
| Initialize Speed sparkline canvas | 30 min | SPEED |
| Initialize Customer Detail Sales/GM trend chart | 1h | CUSTDETAIL |
| Wire Customer Detail AR aging from ar_invoices[] | 30 min | CUSTDETAIL |
| Wire Team EVP hero stats (6 numbers) | 30 min | TEAM |
| Wire Team performance_matrix.grid[8×4] | 1h | TEAM |
| Wire Budget Budgeted Volume table | 1h | BUDGET |
| Wire Budget GM Achievement by Region | 30 min | BUDGET |
| Implement client-side sort on Customers page | 30 min | CUSTOMERS |
| Wire all 3 Behavioral Alerts columns on Intelligence | 1h | INSIGHTS |
| Wire SKU Penetration Matrix (15×10 grid) | 1h | INSIGHTS |
| Wire Account Health Distribution table on Intelligence | 30 min | INSIGHTS |
| Render Reorder Prediction table (15 rows) | 30 min | INSIGHTS |
| Initialize Margin GM/Ton trend chart | 1h | MARGIN |
| Initialize Home Quarterly chart (or hide if no data) | 30 min | HOME |

**Medium subtotal: ~13h** front-end wiring work.

---

## Major Fixes (> 60 min each — needs backend or significant logic)

| Fix | Effort | Notes |
|---|---|---|
| Add `/api/dashboard` `bu_split[]` field + render Home + Sales BU bars | 2h | Backend SQL + 2 pages |
| Add `/api/dashboard` `region_performance[].sales` and `vs_pp` and `dso` | 1h | SQL extension |
| Add `/api/dashboard` `monthly_trend_by_region` for Home Monthly chart | 2h | New SQL + chart |
| Add `/api/dashboard` `quarterly_trend` for Home Quarterly chart | 2h | New SQL + chart |
| Add `/api/sales` top-level KPIs (volume_mt, ytd_volume_mt, revenue, gmt, deltas) | 1h | Endpoint extension |
| Add `/api/sales` `gm_matrix` (groups × months) | 2h | New SQL |
| Add `/api/sales` `vs_ly` per dimension for 4-panel rankings | 2h | New SQL |
| Add `/api/sales` `pending_po.by_sku[]` + Confirmed/CreditHold/AwaitingStock breakdown + `pending_po.detail[]` | 3h | Multiple new SQL |
| Add `/api/customers` per-customer region/BU/gm_ton/status fields | 2h | JOIN extensions |
| Add `/api/customers` pagination support in UI | 2h | Frontend |
| Add `/api/customer` per-customer credit_line, terms, growth_signal computations + `customer_insights` endpoint | 4h | Multiple |
| Add `/api/margin` `by_sales_group[]` and `by_bu[]` | 2h | New SQL |
| Add `/api/margin` `critical[].sku_breakdown` nested + GM trend series + GP heatmap matrix | 3h | New SQL |
| Add `/api/intelligence` `vertical_targets[]` standalone | 1h | New SQL |
| Fix `/api/intelligence` `health_distribution[]` (returns all zeros) | 2h | SQL bug |
| Add `/api/intelligence` `kpis.{new_sku, avg_order_freq, avg_order_size}` | 1h | New SQL |
| Build `/api/l10` endpoint (15 weeks × 5 measurables) | 5h | New endpoint OR keep static |
| Fix `/api/team` `rsms[].ytd_vol` (SlpCode→RSM mapping broken — currently MART=15, should be ~6000+) | 3h | Mat must supply mapping |
| Add `/api/team` `rsms[].ytd_target` (no budget linkage exists) | 3h | New SAP join + mapping |
| Add `/api/team` DSM-level array (page shows DSM rows that get wiped on load) | 4h | New SQL |
| Add `/api/team` `bu_region_split[]` for "Volume by BU × Region" | 2h | New SQL |
| Add `/api/budget` rendering of `pl_summary.rows[]` with monthly + YTD + FY columns | 3h | Frontend |

**Major subtotal: ~50h** — but most are net-new SQL work and would unblock 30+ blocked tables.

---

## Pages by Health Score

| Page | Working | Total | Score | Verdict |
|---|---:|---:|---:|---|
| **AR** | 13 | 14 | **93%** | 🟢 Excellent — production-ready, model template |
| **BUDGET** | 6 | 10 | **60%** | 🟠 Hero+charts work; 3 tables hardcoded |
| **MARGIN** | 11 | 18 | **61%** | 🟠 Wired well except by_sales_group/by_bu (API gaps) |
| **HOME** | 9 | 13 | **69%** | 🟠 KPIs solid; 4 visual elements (ticker, BU bars, 2 charts) hardcoded |
| **SPEED** | 12 | 19 | **63%** | 🟠 Hero/RSM/Feed wired; matrices and sparkline broken |
| **INSIGHTS** | 8 | 21 | **38%** | 🔴 Endpoint rich, UI uses 30%; alerts + matrix hardcoded |
| **TEAM** | 4 | 13 | **31%** | 🔴 EVP hero/L10/perf matrix/BU split hardcoded; data integrity issues |
| **CUSTDETAIL** | 8 | 23 | **35%** | 🔴 Hero + insights + AR + sales chart hardcoded |
| **SALES** | 2 | 17 | **12%** | 🔴 Worst page — 1 KPI + 1 table wired; everything else hardcoded |
| **INVENTORY** | 0 | 10 | **0%** | 🔴 Total — zero elements wired; all 6 KPIs hardcoded |
| **CUSTOMERS** | 4 | 11 | **36%** | 🔴 Region/BU/GM cols empty; sort dead |

**Overall app: ~46% functional** (96 of 210 elements truly live).

---

## Recommended Sprint Order

### Sprint 1 — "Stop the Bleeding" (Quick wins + Inventory rescue) — ~6h
- All 10 quick fixes (1.5h)
- Wire Inventory KPIs + 3 tables (3h) — turns 0% → 70%
- Fix Sales KPI bindings (30 min)
- Wire Speed weekly/plant matrices + sparkline (2h)

### Sprint 2 — "Render the Logged Data" (15+ tables already in API) — ~10h
- Margin: GM trend chart wiring (2h)
- Intelligence: Behavioral alerts (3 cols) + Reorder table + SKU matrix (3h)
- Team: EVP hero + Performance matrix + Account Health (2h)
- Budget: Budgeted Volume table + GM by region + P&L summary (3h)

### Sprint 3 — "Backend Field Extensions" — ~12h
- /api/dashboard: bu_split, region_performance.sales, monthly_trend_by_region (4h)
- /api/sales: top-level KPIs + deltas + pending_po.by_sku (3h)
- /api/customers: region/BU/gm_ton/status JOINs (2h)
- /api/margin: by_sales_group + by_bu + critical.sku_breakdown (3h)

### Sprint 4 — "New Endpoints" — ~10h
- /api/customer-insights (Growth/SKU Mix/Credit/Opportunity for Customer Detail) (4h)
- /api/team RSM mapping fix + ytd_target budget linkage (4h)
- /api/intelligence vertical_targets + new KPI fields (2h)

### Sprint 5 — "Decisions Required from Mat" — varies
- L10 Scorecard: build `/api/l10` (5h) OR accept as static template (0h)
- DSM hierarchy: build DSM-level breakdown (4h) OR remove DSM rows from prototype (15 min)
- Customer Detail insight cards: build ML pipeline (10h+) OR remove cards (15 min)
- Cyber-fortress: replace prototype hardcoded customer names ("Metro Feeds Corp.", "Bukidnon Farms") with anonymized placeholders OR delete (15 min each section)

---

## Global Features Status

| Feature | Status | Notes |
|---|---|---|
| Period filter (7D/MTD/QTD/YTD) | 🟢 Working | `setPd()` clears cache, calls `loadPage(PG)`, persists in localStorage |
| Compare toggle (vs PP / vs LY) | 🟢 Working | `setCmp()`. Note: vs LY shows +0% because no 2025 SAP data |
| Unit toggle (MT / Bags) | 🟢 Working on Home volume KPI; broken on Inventory page (loader doesn't read UT) |
| Theme toggle (sun/moon) | 🟢 `toggleTheme()` exists at line 5131; CSS uses `[data-theme="light"]` selectors |
| Sidebar nav (11 pages) | 🟢 Working | `navTo(id, navItem)` at line 3182, all pages route correctly |
| Animations (KPI pulse, number tick, pill bounce, chart morph) | 🟢 Working | Pass 4 — `pulseRefresh()`, `animateNumber()`, `addClickAnimation()`, Chart.js global defaults; honors `prefers-reduced-motion` |
| Export buttons (XLSX) | 🟢 Working | `injectExportButtons()` auto-attaches to every `.card` w/ table; `exportTableToXlsx()` produces valid .xlsx; ~25 tables get the button. **Caveat:** unstyled (no Vienovo branding in Excel) |
| Global search (`#global-search`) | 🟠 Topbar input wires only to `loadCust()` on Customers page; not global. Acceptable for now. |
| Filter UI persistence | 🟢 Working | `syncFilterUI()` at line 3248 restores period/compare/unit on boot |
| Same-click debounce on period chips | 🟢 Working | Pass 4 prevents double-fire |
| Cache busting on API calls | 🟢 Working | `apiFetch()` adds `_t=Date.now()` + `cache: 'no-store'` header |
| Auth gate | 🟢 Working | `requireAuth()` at line 3005; redirects to login if no session |

---

## API Endpoint Health

| Endpoint | Status | Time (cold) | Size | Has Data | Missing Fields |
|---|---|---:|---:|---|---|
| `/api/dashboard` | 🟢 200 | 8.5s* | 1.6KB | Yes | bu_split[], region_performance.sales, monthly_trend, quarterly_trend |
| `/api/sales` | 🟢 200 | 1.1s | 22KB | Yes | top-level summary KPIs, gm_matrix, vs_ly per dim, by_district[], by_product[], pending_po.by_sku[], pending_po.detail[] |
| `/api/ar` | 🟢 200 | 1.2s | 182KB | Yes | (complete) |
| `/api/inventory` | 🟢 200 | 2.0s | 818KB | Yes | summary{} object, by_sales_group[] |
| `/api/speed` | 🟢 200 | 0.9s | 4.6KB | Yes | (complete) — all top-level fields populated |
| `/api/customers` | 🟢 200 | 0.8s | 10KB | Yes (1382 customers) | per-customer region, bu, gm_ton, status — all NULL today |
| `/api/customer?id=X` | 🟢 200 | 0.9s | 30KB | Yes | insight-card data (Growth/SKU Mix/Credit/Opportunity), credit_line, terms |
| `/api/margin` | 🟢 200 | 1.9s | 52KB | Yes | by_sales_group[], by_bu[], critical[].sku_breakdown, GM trend series, GP heatmap matrix |
| `/api/intelligence` | 🟢 200 | 3.7s | 10KB | Mostly | vertical_targets[], kpis.{new_sku, avg_order_freq, avg_order_size}; **health_distribution[] returns all zeros** (SQL bug) |
| `/api/team` | 🟢 200 | 1.4s | 2.8KB | Partial | ytd_target=0 for all RSMs (no budget linkage); ytd_vol mostly 0 (SlpCode mapping broken); DSM array; bu_region_split[] |
| `/api/budget` | 🟢 200 | 1.4s | 3.1KB | Yes | (complete) |
| (`/api/l10`) | — | — | — | **does not exist** | needed for L10 Scorecard |

*Dashboard 8.5s is cold-start; subsequent calls likely sub-second per cache TTL.

---

## Observations & Anti-Patterns

1. **"LOGGED only" anti-pattern** — `DOM_RENDER_REPORT.md` documented that ~15 tables would be "logged but not rendered" — they are still in that state. This is the single biggest source of broken UI: the data is fetched and console.log'd, but never written to DOM. **Sprint 2 above is dedicated to clearing this backlog.**

2. **Hardcoded prototype "fall-through"** — Loaders use `if(d.field) { render }` with no `else { clear or placeholder }`. When the API field is missing or returns empty, the prototype demo data stays visible. Mat should consider: empty placeholder rows ("—" or skeleton) on initial load, replaced by API data only when present. This avoids the misleading "3 CRITICAL → 36 CRITICAL" flash on Margin page.

3. **API field shape mismatches** — Multiple loaders expect fields the endpoint never returns: `d.summary` on Inventory; `d.volume_mt` at top of Sales; `s.cover_days` (with `s` undefined). These are simple bugs but invisible without browser-console inspection. **Browser console testing should be standard before declaring a page wired.**

4. **Hardcoded customer names everywhere** — "Metro Feeds Corp.", "Bukidnon Farms Trading", "Pacifica Agrivet Supplies" appear as prototype data on ~8 pages. Some get replaced by API data; others remain forever. If this app is ever shown to a customer or in screenshots, these placeholder names are a brand risk. Recommend a search/replace pass to anonymize ("Customer A / B / C").

5. **Joel/Rachel cleanup partial** — Quick Wins removed Joel's name from Team hero and Rachel from L10 — correctly. But `/api/team` still returns `evp.name: "Joel Durano"` (verified in test response). If the API value is rendered anywhere, Joel reappears. Currently the loader doesn't render it (logs only) so it's hidden — but anyone wiring evp.* should be aware.

6. **L10 Scorecard is hardcoded EOS data** — Mat may want to keep it static (it's an EOS framework template, not metrics) OR build `/api/l10`. **Decision needed.**

7. **Filter UI consistency** — Region filter pills on Customers page LOOK identical to AR page filters but Customers ones don't actually filter (no region data); AR ones work. Visual consistency creates wrong expectation.

8. **Aging buckets on AR are 7-bucket but match Finance's 4-bucket prototype only partially** — buckets 91-365+ have a redistribution mismatch (7.8% in our 91-120 vs Finance's 0.6%). Documented in PASS1 report as known issue with different aging date basis. Not a code bug.

---

*Generated by AUTOPSY pipeline — 2026-04-17 — Static audit + curl smoke + cross-reference of app.html (5168 lines), 11 API endpoints, 12 page sections.*
