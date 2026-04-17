# VieForce HQ Pages 5-7 Audit Report
**Audit Date:** 2026-04-17
**Scope:** Pages 5 (Speed Monitor), 6 (Customers), 7 (Customer Detail)
**API Version:** rev 00031-jud (Cloud Run, all endpoints HTTP 200)

---

## PAGE 5 — SPEED MONITOR

**DOM range:** lines 1804–1939  
**Loader:** `loadSpeed()` at line 3743  
**Endpoint:** `/api/speed`

| Element | DOM id | Status | Issue | Field | Fix |
|---|---|---|---|---|---|
| Days Elapsed | #sp-elapsed | 🟢 | None | days_elapsed | — |
| Days Remaining | #sp-remain | 🟢 | None | days_remaining | — |
| Avg Pullout | #sp-pullout | 🟢 | None | daily_pullout | — |
| Projected | #sp-avgspeed | 🟠 | Label override at 3761-3762 | projected_mtd | Low |
| Today MT | #spk-today | 🟢 | None | daily[last].daily_mt | — |
| MTD Total | #spk-mtd | 🟢 | Fallback chain | mtd_actual | — |
| MTD Avg | #spk-avg | 🟢 | None | daily_pullout | — |
| vs Last Month % | #spk-vslm | 🟢 | Color conditional | vs_last_month_pct | — |
| Speed vs LM | #spk-speedlm | 🔴 | Hardcoded "-0.2%", never updated | NOT IN API | High |
| Daily Chart | #speedChart | 🟢 | Dynamic colors | daily[] | — |
| Sparkline | #speedSparkline | 🔴 | No Chart.js init | NOT WIRED | High |
| Weekly Matrix | table | 🔴 | Hardcoded W10-W14; API has W10-W16 | NOT WIRED | High |
| Plant Matrix | table | 🔴 | Hardcoded 5 plants; API has 13 | NOT WIRED | High |
| RSM Speed | #speed-rsm-tbody | 🟢 | Dynamic % calc | rsm_speed[] | — |
| Feed Type | #speed-feed-tbody | 🟢 | Dynamic % calc | feed_type_speed[] | — |

**Key Issues:**
- API response valid (all fields present in speed.json)
- Sparkline canvas exists but zero JS binding
- Weekly/plant matrices hardcoded—do not reflect API data or dynamic dates
- Speed vs LM KPI shows hardcoded value despite API providing field

---

## PAGE 6 — CUSTOMERS

**DOM range:** lines 1942–1970  
**Loader:** `loadCust(search)` at line 3838  
**Endpoint:** `/api/customers`

| Element | DOM id | Status | Issue | Field | Fix |
|---|---|---|---|---|---|
| Filter Pills | .filter-chip | 🔴 | No region in API | API MISSING | High |
| Sort Dropdown | text label | 🔴 | Not functional | NOT WIRED | High |
| Table Rows | #cust-tbody | 🟢 | Dynamic render | customers[] | — |
| Row: Name | CardName | 🟢 | API field | CardName | — |
| Row: Code | CardCode | 🟢 | API field | CardCode | — |
| Row: Region | City or region | 🔴 | City NULL; region missing | API MISSING | High |
| Row: BU | c.bu | 🔴 | Not in API | API MISSING | High |
| Row: Volume | ytd_volume | 🟢 | With bags fallback | ytd_volume | — |
| Row: Sales | ytd_revenue | 🟢 | Currency format | ytd_revenue | — |
| Row: GM/Ton | c.gmt | 🔴 | Not in API | API MISSING | High |
| Search Box | (not found) | 🔴 | No UI element | NOT IMPLEMENTED | High |

**Critical Issues:**
- API missing: region, bu, gm_ton, status
- City field NULL for all 50 customers
- Region filter pills exist but filter fails silently
- Search function expects param but no UI

---

## PAGE 7 — CUSTOMER DETAIL

**DOM range:** lines 1973–2179  
**Loader:** `openCust(code)` at line 3866  
**Endpoint:** `/api/customer?id=...`

| Element | DOM id | Status | Issue | Field | Fix |
|---|---|---|---|---|---|
| Hero: Name | h1 | 🟢 | None | info.CardName | — |
| Hero: Meta | .detail-meta | 🟢 | Code, City, RSM | info.* | — |
| Hero: Rep/Credit/Terms | .detail-sub | 🔴 | 100% hardcoded | PARTIAL | High |
| Hero: Badges | .badges | 🔴 | No compute logic | NOT IN API | High |
| Hero: Last Order | text | 🔴 | Hardcoded "Apr 11" | NOT IN DETAIL | Medium |
| KPI: YTD Vol | kpis[0] | 🟢 | None | ytd_sales.volume | — |
| KPI: YTD Sales | kpis[1] | 🟢 | None | ytd_sales.revenue | — |
| KPI: MTD Vol | kpis[2] | 🔴 | Schema mismatch | SCHEMA MISMATCH | Medium |
| KPI: MTD Sales | kpis[3] | 🔴 | Schema mismatch | SCHEMA MISMATCH | Medium |
| KPI: GM/Ton | kpis[4] | 🟢 | Fallback chain | kpis.gm_ton | — |
| KPI: DSO | kpis[5] | 🟢 | Fallback chain | kpis.dso | — |
| KPI: Avg Order | kpis[6] | 🔴 | Never populated | INCOMPLETE | Low |
| KPI: Frequency | kpis[7] | 🔴 | Never populated | INCOMPLETE | Low |
| Insight: Growth | card | 🔴 | Hardcoded "+14%" | NOT IN API | High |
| Insight: SKU Mix | card | 🔴 | Hardcoded "22%-31%" | NOT IN API | High |
| Insight: Credit | card | 🔴 | Hardcoded "95%" | NOT IN API | High |
| Insight: Opportunity | card | 🔴 | Hardcoded "₱2.4M" | NOT IN API | High |
| CY vs LY Chart | #custVolBarChart | 🟢 | Dynamic render | cy_vs_ly[] | — |
| Monthly Table | #cust-monthly-tbody | 🟢 | Dynamic render | monthly_table[] | — |
| Sales/GM Chart | #custSalesGmChart | 🔴 | No Chart init | NOT WIRED | High |
| AR Total | text | 🔴 | Hardcoded "₱28.4M" | NOT IN API | High |
| AR Credit Line | text | 🔴 | Hardcoded "₱30.0M" | NOT IN API | High |
| AR Bucket Bars | .aging-bar | 🔴 | Hardcoded 65/20/10/5 | NOT COMPUTED | High |
| Products List | #cust-products-list | 🟢 | product_breakdown[0:6] | product_breakdown[] | — |
| Recent Orders | #cust-orders-list | 🟢 | recent_orders[0:10] | recent_orders[] | — |

**Critical Issues:**
- Hero section 100% hardcoded (lines 1981-2016)
- Four insight cards require ML/time-series—not in API
- custSalesGmChart canvas orphaned with zero JS
- AR section assumes credit model not returned by API
- Product breakdown polluted with 100+ zero-volume opening balances

---

## CORRECTION — ORIGINAL "SHOWSTOPPER" CLAIM IS FALSE

The original audit claimed `getSpeedData/getCustomersData/getCustomerProfile` were undefined.
**This is wrong.** They are defined in `js/api.js` (lines 50-52), which is loaded in `app.html` line 3002:
`<script src="js/api.js"></script>`

All three functions exist as `function getXxxData(params){ return apiFetch('xxx', params); }`.
No ReferenceError occurs at runtime. The pages load and execute their loaders.

---

## FINDINGS SUMMARY

| Page | Wired | Partial | Broken | Hardcoded | % Functional |
|---|---|---|---|---|---|
| Page 5 (Speed) | 10 | 2 | 4 | 3 | 60% |
| Page 6 (Customers) | 5 | 0 | 6 | 2 | 45% |
| Page 7 (Customer Detail) | 8 | 1 | 13 | 9 | 40% |
| **AVERAGE** | **23** | **3** | **23** | **14** | **48%** |

### TOP 5 BLOCKERS

1. **API Client Functions Undefined** (CRITICAL)
   - getSpeedData, getCustomersData, getCustomerProfile never defined
   - Pages throw ReferenceError on load
   - Fix: Implement API client

2. **API Schema Gaps in /api/customers** (HIGH)
   - Missing: region, bu, gm_ton, status
   - City NULL for all records
   - Fix: Endpoint redesign

3. **Static Mock Overlays Real Data** (HIGH)
   - Weekly matrix, plant matrix hardcoded
   - Blocks dynamic rendering even if API works
   - Fix: Remove hardcoded tables

4. **Insight Cards Not Computable** (HIGH)
   - 4 insight cards require ML not in API
   - All hardcoded example text
   - Fix: New /api/customer/insights endpoint

5. **Charts Missing Initialization** (MEDIUM-HIGH)
   - speedSparkline: no Chart.js init
   - custSalesGmChart: no data binding
   - Fix: Add chart init logic

---

**Report:** 2026-04-17 · VieForce HQ Pages 5-7 Audit Complete
