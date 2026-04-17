# DOM RENDER REPORT — Agent 3.5: DOM Renderer

**Date:** 2026-04-16
**Agent:** Agent 3.5 — DOM Renderer

---

## 1. Per-Page Injection Summary

### PAGE 1 — HOME (`pg-home`)
**Endpoint:** `/api/dashboard` + `/api/sales` + `/api/ar` + `/api/speed`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Net Sales | `hk-sales` | `d.revenue` | WIRED |
| Volume | `hk-vol` | `d.volume_mt` | WIRED |
| Gross Margin | `hk-gm` | `d.gross_margin` or `d.gmt * d.volume_mt` | WIRED |
| GM/Ton | `hk-gmt` | `d.gmt` | WIRED |
| DSO | `hk-dso` | `ar.dso` | WIRED |
| Speed | `hk-speed` | `sp.speed_per_day` | WIRED |
| Pending PO | `hk-pending` | `d.pending_po.total_mt` | WIRED |
| Margin alert strip | `hm-critical/warning/watch/growing` | `d.margin_alerts` | WIRED |
| Region table | `home-region-tbody` | `d.region_performance[]` | WIRED — rebuilds tbody |
| Top 5 Customers | `home-topcust` | `d.top_customers[]` | WIRED — rebuilds list-rows |
| Budget vs Actual strip | — | Not in dashboard API | FALLBACK (prototype values) |
| BU Split bars | — | Not in dashboard API | FALLBACK (prototype values) |
| Monthly chart | `homeMonthlyChart` | API monthly_trend available via sales API | KEPT PROTOTYPE — needs region-split data |
| Quarterly chart | `homeQuarterlyChart` | Not returned by any API | KEPT PROTOTYPE |

### PAGE 2 — SALES (`pg-sales`)
**Endpoint:** `/api/sales`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| MTD Volume | `sk-vol` | `d.volume_mt` | WIRED |
| YTD Volume | `sk-ytdvol` | `d.ytd_volume_mt` | WIRED |
| MTD Sales | `sk-sales` | `d.revenue` | WIRED |
| Avg GM/Ton | `sk-gmt` | `d.gmt` | WIRED |
| Pending PO | `sk-pending` | `d.pending_po.summary.total_mt` | WIRED |
| Customer Rankings | `sales-rankings-tbody` | `d.top_customers[]` | WIRED — rebuilds 10 rows |
| Monthly Trend chart | `salesTrendChart` | `d.monthly_trend` | LOGGED — chart uses region-split, API returns national |
| GM/Ton matrix | — | Not in API | FALLBACK (prototype values) |
| 4-panel rankings (Brand/Product/Customer/District) | — | Partially in `by_brand`/`top_customers` | FALLBACK (prototype values) |
| Pending PO section | — | `d.pending_po.by_brand/by_region/top_customers` | FALLBACK — complex sub-tables kept as prototype |

### PAGE 3 — AR (`pg-ar`)
**Endpoint:** `/api/ar`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Total AR | `ar-total` | `d.total_balance` | WIRED |
| Clients count | `ar-clients` | `d.clients.length` | WIRED |
| Over Limit | `ar-overlimit` | Computed from `d.clients` | WIRED |
| DSO gauge | `ar-dso-val/ring/status` | `d.dso` | WIRED — ring, value, color, status text |
| Aging bar | — | `d.buckets` available | FALLBACK |
| AR by Region | — | Not in API | FALLBACK |
| Collections list | — | Not in API | FALLBACK |

### PAGE 4 — INVENTORY (`pg-inv`)
**Endpoint:** `/api/inventory`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| 6 KPIs (On Floor, PO, Prod, Avail, Cover, Neg) | querySelectorAll | `d.summary` | WIRED |
| By Region table | — | `d.by_region[]` | LOGGED |
| By Plant table | — | `d.plants[]` | LOGGED |
| By Sales Group | — | Not in API | FALLBACK |
| Product SKU table | — | `d.items[]` | LOGGED |

### PAGE 5 — SPEED (`pg-speed`)
**Endpoint:** `/api/speed`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Shipping Days | `sp-elapsed` | `d.elapsed_days` | WIRED |
| Remaining | `sp-remain` | `d.remaining_days` | WIRED |
| Avg Pullout | `sp-pullout` | `d.speed_per_day` | WIRED |
| Avg Speed | `sp-avgspeed` | `d.projected_mt` | WIRED |
| Today MT | `spk-today` | `d.daily[last].daily_mt` | WIRED |
| MTD Total | `spk-mtd` | `d.actual_mt` | WIRED |
| MTD Avg | `spk-avg` | `d.speed_per_day` | WIRED |
| Projected | `spk-proj` | `d.projected_mt` | WIRED |
| Daily chart | `speedChart` | `d.daily[]` | WIRED — chart.update() |
| Weekly matrix | — | `d.weekly_matrix` | LOGGED |
| Plant matrix | — | `d.plant_breakdown` | LOGGED |
| RSM Speed table | — | `d.rsm_speed[]` | LOGGED |
| Feed Type table | — | `d.feed_type_speed[]` | LOGGED |

### PAGE 6 — CUSTOMERS (`pg-customers`)
**Endpoint:** `/api/customers`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Customer table | `cust-tbody` | `d.customers[]` | WIRED — full table rebuild |
| Search | `global-search` | `loadCust(query)` | WIRED |
| Region filter | `fltCust()` | Clears cache, refetches | WIRED |

### PAGE 7 — CUSTOMER DETAIL (`pg-custdetail`)
**Endpoint:** `/api/customer?id=`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Hero name/meta | querySelector | `d.info.CardName/CardCode/City/rsm` | WIRED |
| Breadcrumb | querySelector | `d.info.CardName` | WIRED |
| YTD Vol/Sales KPIs | querySelectorAll | `d.ytd_sales.volume/revenue` | WIRED |
| GM/Ton, DSO KPIs | querySelectorAll | `d.gmt`, `d.dso` | WIRED |
| CY vs LY chart | `custVolBarChart` | `d.cy_vs_ly[]` | WIRED — chart.update() |
| Monthly breakdown table | — | `d.monthly_table` | LOGGED |
| Insight cards | — | Not in API | FALLBACK |
| Products list | — | `d.product_breakdown[]` | LOGGED |
| Recent orders | — | `d.recent_orders[]` | LOGGED |

### PAGE 8 — MARGIN ALERTS (`pg-margin`)
**Endpoint:** `/api/margin`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Hero GP exposure | querySelector | `d.hero.negative_gp_total` | WIRED |
| Hero revenue at risk | querySelector | `d.hero.revenue_at_risk` | WIRED |
| Hero CRITICAL/WARNING badges | querySelector | `d.hero.critical_count/warning_count` | WIRED |
| 8 KPIs | querySelectorAll | `d.kpis.*` | WIRED |
| 3 Critical account cards | `.margin-card.critical` | `d.critical[]` (name, code, sales, vol, GP) | WIRED |
| Sidebar badge count | `.nav-item .b-red` | `d.kpis.critical` | WIRED |
| Warning accounts table | — | `d.warning[]` | LOGGED |
| 6 dimension tables | — | `d.by_region/by_brand/worst_skus` | LOGGED |
| GM/Ton trend chart | `marginRegionChart` | — | KEPT PROTOTYPE |
| GP% heatmap | — | Not in API | FALLBACK |

### PAGE 9 — CUSTOMER INTELLIGENCE (`pg-insights`)
**Endpoint:** `/api/intelligence`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Hero (whitespace, at-risk, health) | querySelector | `d.hero.*` | WIRED |
| 8 KPIs (signal counts) | querySelectorAll | `d.kpis.*` | WIRED |
| Brand Coverage table | — | `d.brand_coverage[]` | LOGGED |
| Growth Vectors | — | `d.horizontal_targets[]` | LOGGED |
| Buying Patterns | — | `d.buying_patterns[]` | LOGGED |
| SKU Penetration Matrix | — | `d.sku_penetration_matrix` | FALLBACK |

### PAGE 10 — SALES TEAM (`pg-team`)
**Endpoint:** `/api/team`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| EVP Hero | — | `d.evp` | LOGGED |
| L10 Scorecard | — | NOT IN API | FALLBACK — needs `/api/l10` endpoint (Agent 4) |
| RSM Scorecard | — | `d.rsms[]` | LOGGED |
| Performance Matrix | — | `d.performance_matrix` | LOGGED |
| Account Health by RSM | — | `d.account_health[]` | LOGGED |

### PAGE 11 — BUDGET & P&L (`pg-budget`)
**Endpoint:** `/api/budget`

| Field | ID | Source | Status |
|-------|-----|--------|--------|
| Hero (FY target, YTD, achievement) | — | `d.hero.*` | LOGGED |
| Volume History chart | `budgetHistoryChart` | `d.volume_history[]` | WIRED — chart.update() |
| Monthly Actual vs Budget chart | `budgetMonthlyChart` | `d.monthly_actual_vs_budget` | WIRED — chart.update() |
| Achievement by Region | — | `d.achievement_by_region[]` | LOGGED |
| P&L Summary table | — | `d.pl_summary` | LOGGED |

---

## 2. Charts Updated

| Chart | Page | Canvas ID | Update Method | Status |
|-------|------|-----------|---------------|--------|
| Daily Speed | Speed | `speedChart` | `chart.data.datasets[0].data = vals; chart.update()` | WIRED |
| CY vs LY Volume | Customer Detail | `custVolBarChart` | Update both datasets from `cy_vs_ly` | WIRED |
| Budget History | Budget | `budgetHistoryChart` | `chart.data.labels/datasets[0].data` from `volume_history` | WIRED |
| Monthly vs Budget | Budget | `budgetMonthlyChart` | Both actual/budget datasets from `monthly_actual_vs_budget` | WIRED |
| Monthly Volume & GM | Home | `homeMonthlyChart` | Not updated — API returns national, chart needs region-split | PROTOTYPE |
| Quarterly Volume & GM | Home | `homeQuarterlyChart` | Not in API | PROTOTYPE |
| Sales Trend | Sales | `salesTrendChart` | API returns national trend, chart uses region bars | PROTOTYPE |
| GM/Ton by Group | Sales | `gmGroupChart` | Not in API | PROTOTYPE |
| Speed Sparkline | Speed | `speedSparkline` | Not updated — data available but low priority | PROTOTYPE |
| Margin Trend | Margin | `marginRegionChart` | Not in API | PROTOTYPE |
| Sales & GM trend | Customer | `custSalesGmChart` | Not updated | PROTOTYPE |

---

## 3. Tables Rebuilt (Dynamic Row Generation)

| Table | Page | Container ID | Source | Rows |
|-------|------|-------------|--------|------|
| Region Performance | Home | `home-region-tbody` | `d.region_performance[]` | 3 regions + national total |
| Top Customers | Home | `home-topcust` | `d.top_customers[]` | Up to 5 |
| Customer Rankings | Sales | `sales-rankings-tbody` | `d.top_customers[]` | Up to 10 |
| Customer List | Customers | `cust-tbody` | `d.customers[]` | Up to 50 |

---

## 4. Fields API Doesn't Return (Backend Follow-Up)

| Page | Field Needed | Suggestion |
|------|-------------|------------|
| Home | Budget vs Actual strip (5 cards) | Add `ytd_budget` fields to `/api/dashboard` or pull from `/api/budget` |
| Home | BU Split (DIST/KA/PET breakdown) | Add `bu_split[]` to `/api/dashboard` |
| Home | Monthly chart region-split data | Return `monthly_trend` per region from `/api/sales` |
| Sales | GM/Ton monthly matrix (7 months × 9 groups) | New field `gm_matrix` in `/api/sales` |
| Sales | 4-panel rankings (Brand/Product/Customer/District with vs Y-1) | Already partially in `by_brand[]`, needs `vs_ly` field added |
| AR | Aging bar breakdown (4 bucket amounts) | Add `bucket_amounts` array to `/api/ar` |
| AR | AR by Region table | Add `by_region[]` to `/api/ar` |
| AR | Collections list | New endpoint or new field in `/api/ar` |
| Inventory | By Sales Group table | Add `by_sales_group[]` to `/api/inventory` |
| Speed | Weekly matrix (weeks × plants) | `d.weekly_matrix` exists but needs rendering wired |
| Speed | RSM/Feed Type tables | `d.rsm_speed/feed_type_speed` exist but need rendering wired |
| Customer Detail | Insight cards (Growth Signal, SKU Mix, Credit Watch, Opportunity) | AI-generated — needs new `/api/customer-insights` |
| Customer Detail | Monthly breakdown table | `d.monthly_table` exists but needs rendering wired |
| Customer Detail | Products list & Recent orders | Data exists (`product_breakdown`, `recent_orders`) but needs rendering wired |
| Margin | Warning accounts table rebuild | `d.warning[]` available but not wired into table |
| Margin | 6 dimension tables (region/group/brand/BU/plant/worst SKUs) | Data partially available (`by_region`, `by_brand`, `worst_skus`) |
| Intelligence | Brand Coverage table, Buying Patterns, SKU Penetration rebuild | Data available but complex table structures need careful wiring |
| Team | L10 Scorecard | Needs new `/api/l10` endpoint |
| Team | RSM Scorecard table, Rankings, Performance Matrix rebuild | `d.rsms[]` and `d.performance_matrix` available but need rendering |
| Budget | Hero KPIs, P&L table, Achievement by Region table rebuild | `d.hero`, `d.pl_summary`, `d.achievement_by_region` available but need rendering |

---

## 5. Loading State Implementation

- **Pattern:** Each `loadXxx()` starts with `clearError(pageId)` and ends with error banner on failure
- **Error banner:** Red-bordered div inserted at top of page: "Unable to load live data — showing cached values"
- **Fallback:** Prototype hardcoded values remain visible when API fails — no blanking
- **No skeleton implementation:** Skeleton placeholders were considered but not added to avoid touching the visual design. Data swaps are instant when API responds.

---

## 6. Error Handling

| Scenario | Behavior |
|----------|----------|
| API returns 401 | `apiFetch()` calls `logout()` — redirects to login |
| API returns 500 | Error caught, `showError()` displays banner, prototype values stay |
| Network timeout | Error caught, banner shown, prototype values stay |
| Missing field in response | `console.warn('[DOM] Missing #id')` logged, prototype value preserved |
| Null/undefined in response | Guarded by `if(field!=null)` checks — skips update |
| Partial data | Each field updated independently — what arrives gets rendered |

---

## 7. Utility Functions Added

```javascript
fd(pct)        — Delta formatter: "▲ 8.3%" or "▼ 1.2%"
dc(pct)        — Delta CSS class: "up" or "down"
fcn(n)         — Comma-formatted number: "54,446"
sel(id)        — document.getElementById shorthand
sett(id, val)  — Safe textContent setter with console.warn on missing element
seth(id, val)  — Safe innerHTML setter with console.warn on missing element
showError(pgId, msg) — Inserts error banner at top of page
clearError(pgId)     — Removes error banner
```

---

## 8. Testing

**Method:** JavaScript syntax validated via `new Function()` — no parse errors.
**Server:** Starts cleanly (port binding confirmed, env vars loaded).
**Local testing limitations:** SAP B1 unreachable from localhost → all API calls will 500 → error banners will appear → prototype values remain visible → no JavaScript crashes.

### Expected behavior when browsing locally:
1. Login via Supabase PIN → redirected to app.html
2. Each page navigation triggers `loadXxx()` → API call → 500 error
3. Error banner appears: "Unable to load live data — showing cached values"
4. All prototype hardcoded values remain visible (no blank screens)
5. Console shows `[PAGE] Rendering:` logs or error messages
6. Charts retain prototype data

### Expected behavior on Cloud Run (SAP accessible):
1. API calls succeed → data flows into DOM
2. KPIs update with live numbers
3. Tables rebuild with live data
4. Charts update with live data arrays
5. Error banners do not appear

---

## 9. Recommended Next Steps

### Priority 1 — Complete Remaining Table Rendering (Agent 4)
The following tables have API data available but are currently logged, not rendered:
- Speed: RSM table, Feed Type table, Weekly matrix, Plant matrix
- Margin: Warning table, 6 dimension tables
- Intelligence: Brand Coverage, Buying Patterns, SKU Penetration
- Team: RSM Scorecard, Performance Matrix
- Budget: Hero KPIs, P&L table, Achievement by Region

### Priority 2 — API Enrichment
- Add `bu_split`, `budget_vs_actual`, `monthly_trend_by_region` to `/api/dashboard`
- Add `gm_matrix`, `vs_ly` fields to `/api/sales`
- Add `bucket_amounts`, `by_region`, `collections` to `/api/ar`
- Create `/api/l10` for L10 Scorecard data

### Priority 3 — RBAC
- Implement `applyRoleFilter()` so DSMs see only their district data
- Requires `SlpCode → user` mapping from Mat

---

*Generated by Agent 3.5 — DOM Renderer — 2026-04-16*
