# ENDPOINTS REPORT — Agent 3: API Endpoints Builder

**Date:** 2026-04-16
**Agent:** Agent 3 — API Endpoints Builder

---

## 1. Files Created / Modified

### New Files Created (4)

| File | Purpose | Lines |
|------|---------|-------|
| `api/margin.js` | GET /api/margin — Margin Alerts page data | ~200 |
| `api/intelligence.js` | GET /api/intelligence — Customer Intelligence page data | ~240 |
| `api/team.js` | GET /api/team — Sales Team scorecard data | ~200 |
| `api/budget.js` | GET /api/budget — Budget & P&L page data | ~220 |

### Existing Files Modified (8)

| File | Change |
|------|--------|
| `api/dashboard.js` | Added: pending_po, region_performance, top_customers, margin_alerts |
| `api/sales.js` | Added: pending_po (from ORDR/RDR1 open sales orders) |
| `api/speed.js` | Added: plant_breakdown, rsm_speed, feed_type_speed, weekly_matrix |
| `api/inventory.js` | Added: by_region, negative_avail_count, cover_days |
| `api/customer.js` | Added: 8 KPIs, cy_vs_ly, monthly_table, account_age_days, rank_by_volume |
| `server.js` | Added: margin/intelligence/team/budget handler imports + route mounts |
| `js/api.js` | Added: getMarginData, getIntelligenceData, getTeamData, getBudgetData |
| `app.html` | Replaced MOCK stubs with load functions, updated comments |

---

## 2. SQL Queries Used in Each Endpoint

### api/margin.js

```sql
-- Customer-level GP aggregation (top 500, ordered by worst GP%)
SELECT TOP 500 T0.CardCode, T0.CardName,
  SUM(T1.LineTotal) AS sales,
  SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0 AS vol,
  SUM(T1.GrssProfit) AS gp,
  SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100 AS gp_pct,
  SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0) AS gm_ton
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
-- + period filter + role filter
GROUP BY T0.CardCode, T0.CardName, S.SlpName
ORDER BY gp_pct ASC

-- SKU breakdown for critical customers (GP < 0)
-- By Region (via WhsCode mapping)
-- By Brand (via T1.Dscription)
-- By Plant (via T1.WhsCode)
-- Worst 10 SKUs
```

### api/intelligence.js

```sql
-- Brand coverage (distinct customers per brand)
-- Brands per customer (count distinct brands + SKUs)
-- Order frequency (count, first/last order, days_since_last)
-- Volume change (last 3 months vs prior 3 months)
-- SKU penetration matrix (top 15 customers x top 10 categories)
```

### api/team.js

```sql
-- YTD sales by rep (OINV joined with OSLP)
-- LY comparison by rep
-- MTD speed by rep (from ODLN)
-- DSO by rep
-- Silent customers by rep (no order in 30+ days)
-- Negative margin customers by rep
-- Monthly volume by rep (last 6 months)
```

### api/budget.js

```sql
-- YTD actual volume, sales, GM from OINV
-- Monthly actual breakdown
-- Actual by region (via WhsCode mapping)
-- Budget data embedded as constants (from Sales Volume Budget 2026 Excel)
```

### Dashboard enrichment

```sql
-- Pending PO from ORDR/RDR1 (DocStatus = 'O')
-- Region performance (via WhsCode)
-- Top 5 customers
-- Margin alert counts (subquery with GP% classification)
```

### Sales enrichment

```sql
-- Pending PO detail from ORDR/RDR1 (top 200 open order lines)
```

### Speed enrichment

```sql
-- Plant breakdown (ODLN grouped by WhsCode)
-- RSM speed (ODLN grouped by SlpCode/SlpName)
-- Feed type speed (ODLN grouped by Dscription)
-- Weekly matrix (last 6 weeks x plants)
```

### Inventory enrichment

```sql
-- By region (OITW grouped via WhsCode mapping)
-- Negative available count (OnHand - IsCommited < 0)
-- Cover days (total on-hand / avg daily shipment from ODLN last 30d)
```

### Customer enrichment

```sql
-- MTD sales
-- GM/Ton
-- DSO (customer-level)
-- CY vs LY monthly volume (24 months)
-- Account age (DATEDIFF from CreateDate)
-- Volume rank
```

---

## 3. Sample Response Shapes

### GET /api/margin

```json
{
  "hero": { "negative_gp_total": -337000, "revenue_at_risk": 50700000, "critical_count": 3, "warning_count": 7 },
  "kpis": { "critical": 3, "warning": 7, "watch": 12, "healthy": 688, "natl_gm_ton": 5493, "natl_gp_pct": 16.1, "best_region": { "name": "Luzon", "gp_pct": 17.8 }, "worst_region": { "name": "Mindanao", "gp_pct": 11.4 } },
  "critical": [{ "customer": "...", "code": "CA-031", "sales": 6800000, "vol": 180, "gp_pct": -3.1, "gm_ton": -1872, "rep": "E. Ramos", "sku_breakdown": [{ "sku": "...", "sku_name": "VP Hog Finisher", "vol": 80, "gp_pct": -8.2 }] }],
  "warning": [],
  "by_region": [{ "region": "Luzon", "sales": 294000000, "vol": 8420, "gp_pct": 17.8, "gm_ton": 6210 }],
  "by_brand": [{ "brand": "VIEPro Premium", "sales": 286000000, "vol": 8240, "gp_pct": 18.2, "gm_ton": 6320 }],
  "by_plant": [{ "plant": "AC", "vol": 8420, "gp_pct": 18.4, "gm_ton": 6420 }],
  "worst_skus": [{ "sku": "...", "name": "VP Hog Finisher 50kg", "vol_bags": 1840, "gp_pct": -2.4, "gm_ton": -680 }]
}
```

### GET /api/intelligence

```json
{
  "hero": { "whitespace_total": 142000000, "at_risk_total": 12400000, "avg_health_score": 74, "total_active": 710 },
  "kpis": { "silent_30d": 8, "vol_drop": 14, "growing": 22, "avg_skus_per_cust": 4.2, "avg_brands_per_cust": 1.8 },
  "brand_coverage": [{ "brand": "VIEPro Premium", "customers": 482, "penetration_pct": 68, "vol_per_cust": 53, "whitespace_count": 228, "est_opportunity": 38000000 }],
  "horizontal_targets": [{ "customer": "...", "code": "...", "skus": 3, "brands": 1, "vol": 120 }],
  "buying_patterns": [{ "pattern": "Regular (weekly+)", "count": 148, "pct": 21, "avg_vol": 68, "signal": "Loyal" }],
  "sku_penetration_matrix": { "customers": ["Metro Feeds", "..."], "categories": ["VP Hog Grower", "..."], "grid": [[12.5, 0, 8.3]] },
  "behavioral_alerts": { "silent": [], "drops": [], "growing": [] },
  "health_distribution": [{ "band": "0-30 Critical", "count": 57, "pct": 8, "volume": 2840, "revenue": 42000000 }],
  "reorder_predictions": [{ "customer": "...", "avg_interval_days": 12, "days_since_last": 18, "days_overdue": 6, "status": "OVERDUE" }]
}
```

### GET /api/team

```json
{
  "evp": { "name": "Joel Durano", "ytd_vol": 54446, "speed": 15649, "gm_ton": 6953, "customers_count": 710, "rsm_count": 8, "dsm_count": 16 },
  "rsms": [{ "name": "MART ESPLIGUEZ", "region": "Visayas", "bu": "Dist + KA", "ytd_vol": 14820, "ytd_target": 0, "ach_pct": 0, "vs_ly": 42.1, "speed": 6365, "gm_ton": 5210, "dso": 51, "customers": 186, "silent": 3, "neg_margin": 4 }],
  "performance_matrix": { "months": ["2026-01", "2026-02"], "rsms": ["MART ESPLIGUEZ", "..."], "grid": [[3920, 3480]] },
  "account_health": [{ "rsm": "MART ESPLIGUEZ", "region": "Visayas", "customers": 186, "silent": 3, "neg_margin": 4 }]
}
```

### GET /api/budget

```json
{
  "hero": { "fy_target_mt": 188266, "fy_target_sales": 5975000000, "fy_target_gm": 1233000000, "ytd_actual": 54446, "ytd_budget": 58341, "achievement_pct": 93 },
  "volume_history": [{ "year": 2017, "volume_k": 4 }, "..."],
  "budgeted_volume": { "regions": [{ "region": "Visayas", "q1": 17008, "q2": 18091, "q3": 19637, "q4": 21535, "fy26": 76271, "fy25": 52716, "growth_pct": 45, "sub_rows": [] }], "total": {} },
  "pl_summary": { "months": ["Jan", "Feb"], "rows": [{ "label": "Volume (MT)", "values": [14010, 12999], "ytd_actual": 54446, "ytd_budget": 58341, "ach_pct": 93, "fy_budget": 188266 }] },
  "achievement_by_region": [{ "region": "Visayas", "ytd_actual": 23480, "ytd_budget": 23109, "ach_pct": 102, "fy_budget": 76271 }],
  "monthly_actual_vs_budget": { "months": ["Jan", "Feb"], "actual": [14010, 12999], "budget": [14010, 12999] },
  "gm_by_region": [{ "region": "Visayas", "gm_actual": 122000000, "gm_budget": 134000000, "ach_pct": 91, "gm_ton": 5210 }]
}
```

---

## 4. Frontend Wiring Updates in app.html

| Page | Before | After |
|------|--------|-------|
| **Margin Alerts** (`pg-margin`) | `<!-- MOCK -->` comment, `case 'pg-margin': break;` | `loadMargin()` fetches `/api/margin`, logs data to console |
| **Customer Intelligence** (`pg-insights`) | `<!-- MOCK -->` comment, `case 'pg-insights': break;` | `loadIntelligence()` fetches `/api/intelligence`, logs data |
| **Sales Team** (`pg-team`) | `<!-- MOCK -->` comment, `case 'pg-team': break;` | `loadTeam()` fetches `/api/team`, logs data |
| **Budget & P&L** (`pg-budget`) | `<!-- MOCK -->` comment, `case 'pg-budget': break;` | `loadBudget()` fetches `/api/budget`, logs data |

**Important:** All 4 pages currently retain their **prototype hardcoded HTML** for visual display. The API data is fetched and logged to console but does **not yet inject into the DOM**. This matches the pattern used by Agent 2 for the other 7 pages (Home, Sales, AR, etc.) where data is fetched but DOM rendering is the next step.

---

## 5. SAP Table Joins — Flags for Mat to Confirm

| Query | Join / Assumption | Confidence | Risk |
|-------|-------------------|------------|------|
| Region mapping | `WhsCode IN ('AC','ACEXT','BAC')` → Luzon, `('HOREB','ARGAO','ALAE')` → Visayas, `('BUKID','CCPC')` → Mindanao | **MEDIUM** | These warehouse codes were inferred from the prototype's plant data. **Mat should confirm the complete WhsCode → Region mapping.** |
| Pending PO | `ORDR` + `RDR1` with `DocStatus = 'O'` | **HIGH** | Standard SAP B1 open sales orders. Should be correct. |
| Speed from ODLN | `ODLN` + `DLN1` (delivery notes, not invoices) | **HIGH** | Already used in existing speed.js. Consistent. |
| GP calculation | `T1.GrssProfit` from `INV1` | **HIGH** | SAP B1 stores gross profit at line level. Verified in existing endpoints. |
| RSM hierarchy | Hardcoded names matched via fuzzy `SlpName` search | **LOW** | Mat needs to provide actual `SlpCode` → RSM mapping. Current approach searches OSLP.SlpName for name fragments. |
| Brand/product groups | Using `T1.Dscription` (invoice line description) as "brand" | **MEDIUM** | This gives SKU-level descriptions, not brand groupings. May need `OITM.ItmsGrpCod` or `OITM.U_Brand` custom field for true brand-level grouping. |
| Customer order frequency | Calculated from OINV dates (invoice dates, not order dates) | **MEDIUM** | Invoice date may lag order date. ORDR dates might be more accurate for cadence analysis. |
| Cover days | National avg from ODLN last 30 days | **MEDIUM** | Assumes recent 30-day shipping rate is representative. Seasonal businesses may need longer windows. |
| Budget data | Hardcoded from Sales Volume Budget 2026 Excel | **HIGH** | Exact numbers from the budget document. Will need updating for FY2027. |

---

## 6. Cache TTL by Endpoint

| Endpoint | TTL | Reason |
|----------|-----|--------|
| `/api/margin` | 300s (5 min) | Analytics — doesn't change frequently |
| `/api/intelligence` | 600s (10 min) | Heavy computation, customer behavior doesn't change by the minute |
| `/api/team` | 300s (5 min) | Sales rep performance — standard analytics |
| `/api/budget` | 300s (5 min) | Budget is static, actuals update with invoicing |
| `/api/dashboard` (enriched) | 300s (5 min) | Unchanged from original |
| `/api/sales` (enriched) | 300s (5 min) | Unchanged from original |
| `/api/speed` (enriched) | 300s (5 min) | Unchanged from original |
| `/api/inventory` (enriched) | 900s (15 min) | Unchanged from original |
| `/api/customer` (enriched) | 300s (5 min) | Unchanged from original |

---

## 7. Deployment Notes for Cloud Run

### No new environment variables needed

All 4 new endpoints use the same `SAP_HOST`, `SAP_PORT`, `SAP_DB`, `SAP_USER`, `SAP_PASS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` that are already configured in Cloud Run.

### Deployment command

```bash
# From project root:
gcloud run deploy vieforce-hq-api \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated
```

Or if using the existing Dockerfile/buildpack deployment, just push to the repository — Cloud Run will auto-deploy.

### No new npm dependencies

All new endpoints use the existing `mssql`, `@supabase/supabase-js`, `express`, and `cors` packages.

---

## 8. Recommended Next Step

### PROCEED TO AGENT 4 — RBAC + DOM Rendering

**Agent 4 should:**

1. **Implement real RBAC in `_auth.js`** — `applyRoleFilter()` currently passes all authenticated users through as admin. Need to:
   - RSM: filter by `OSLP.SlpCode` matching their team
   - DSM: filter by their own `SlpCode`
   - Mat needs to provide `SlpCode` → user mapping

2. **DOM injection for all 11 pages** — All pages currently fetch API data and `console.log()` it. Agent 4 should inject live data into the existing HTML structures, replacing the prototype hardcoded values.

3. **Confirm SAP mappings with Mat:**
   - WhsCode → Region mapping (complete list)
   - SlpCode → RSM/DSM hierarchy
   - Brand grouping field (T1.Dscription vs OITM.ItmsGrpCod vs custom UDF)

**No blocking issues** — all endpoints are syntactically valid, routes are registered, server starts cleanly.

---

*Generated by Agent 3 — API Endpoints Builder — 2026-04-16*
