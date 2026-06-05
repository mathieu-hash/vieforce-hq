# VieForce HQ — MASTER PLAN & Element Inventory
Date: 2026-06-02 · Commit: d03d538 (live) · Single source of truth.
Supersedes/links: `HQ_FILTER_AUDIT_2026-06-02.md` (filter matrix), `HQ_PUNCHLIST_2026-06-02.md` (34 bugs), TODO tasks #1–#11.

Counts below are **mechanically extracted from app.html**, not estimated.

---

## 1. Verified element inventory (15 pages)

| # | Page | Charts | Tables | KPI tiles | Sections | Status |
|---|------|:--:|:--:|:--:|:--:|---|
| 1 | Home | 2 | 1 | 7 | 5 | 🟠 KPIs ₱0 (B1); 2 charts live; ticker+footer static |
| 2 | EVP Home | 0 | 0 | (card grid) | 5 | 🔴 mostly proxy/static; region/seg pills dead |
| 3 | RSM Home | 0 | 0 | 17 | 8 | 🔴 district%/DSM scores = name-hash proxy |
| 4 | DSM Home | 0 | 0 | 17 | 4 | 🟠 live but period/month inert (backend MTD) |
| 5 | Sales | 2 | 12 | 12 | 15 | 🔴 KPIs ₱0; 2 dead charts; 4 static "vs Y-1" panels |
| 6 | AR | 0 | 3 | 6 | 5 | 🟢 live snapshot (period N/A by design) |
| 7 | Inventory | 0 | 4 | 6 | 4 | 🟠 negative production; Available=0 (MT bug) |
| 8 | Speed | 2 | 4 | 6 | 5 | 🟠 "Invalid Date"; +1400% KPI; 1 dead chart |
| 9 | Customers | 0 | 1 | 0 | 0 | 🟠 live but no pagination (top-50) |
| 10 | Customer 360 | 2 | 2 | 8 | 7 | 🔴 2 hardcoded cards; field-mismatch zeros; 1 dead chart |
| 11 | Margin | 1 | 9 | 8 | 9 | 🔴 tables stuck "Loading…"; hero ₱0; 1 dead chart; static heatmap |
| 12 | Insights | 0 | 9 | 0 | 10 | 🟠 upper live; deeper ignores ref_month; Win-Back "v1.1" |
| 13 | Team | 0 | 5 | 0 | 6 | 🔴 targets=0; cache ignores filters; 3 static blocks |
| 14 | Budget | 2 | 4 | 0 | 5 | 🟠 2 charts live; 3 tables static (API data discarded) |
| 15 | Itemized | 0 | 3 | 4 | 3 | 🟢 cleanest; national live, districts pending-flagged |
| | **TOTAL** | **11** | **57** | **~110** | **88** | |

Page line ranges (for editing): Home 1149 · EVP 1387 · RSM 1488 · DSM 1693 · Sales 1790 · AR 2054 · Inv 2192 · Speed 2285 · Customers 2416 · Cust360 2448 · Margin 2646 · Insights 2843 · Team 3443 · Budget 3663 · Itemized 3795–4436.

---

## 2. Chart canvas inventory (11 total — 6 live, 5 DEAD)

| Page | Canvas id | Line | State |
|------|-----------|:--:|---|
| Home | homeMonthlyChart | 1365 | ✅ rendered |
| Home | homeQuarterlyChart | 1381 | ✅ rendered |
| Sales | **salesTrendChart** | 1821 | 🔴 DEAD (API `monthly_trend` unused) |
| Sales | **gmGroupChart** | 1832 | 🔴 DEAD |
| Speed | **speedSparkline** | 2322 | 🔴 DEAD |
| Speed | speedChart | 2342 | ✅ rendered |
| Customer 360 | custVolBarChart | 2554 | ✅ rendered |
| Customer 360 | **custSalesGmChart** | 2571 | 🔴 DEAD |
| Margin | **marginRegionChart** | 2792 | 🔴 DEAD |
| Budget | budgetHistoryChart | 3688 | ✅ rendered |
| Budget | budgetMonthlyChart | 3776 | ✅ rendered |

**5 dead canvases to wire or remove:** salesTrendChart, gmGroupChart, speedSparkline, custSalesGmChart, marginRegionChart.

---

## 3. Static-but-look-live blocks (API data exists, UI throws it away)
- Sales: GM-per-Ton matrix, BU split, 4× "Volume Rankings vs Y-1" (app.html:1859-1962).
- Margin: GP% heatmap (2794-2807), hero narrative banner (2659-2663), critical-card SKU sublists.
- Team: L10 Scorecard (3491), Performance Matrix (3613, API computes it), Volume-by-BU×Region (3631).
- Budget: Budgeted-Volume table (3708), Sales P&L (3750), GM-by-region (3783) — loader only console.logs the data.
- Customer 360: AR Aging card (2588), Account Info card (2630) — hardcoded per customer.

---

## 4. Fix roadmap (sequenced; maps to TODO tasks #1–#11)

**PHASE 0 — Root cause (do first, unblocks the rest)**
- T#1 ₱0 systemic OINV sales/margin bug (Home/Sales/Team/Margin). Verify T#11/V4 first (reproduce at Live vs QTD+Jun) to isolate ref_month anchor vs query. Expected to also clear T#2 (margin "Loading…") and Margin hero zeros.

**PHASE 1 — Broken live data (P0/P1)**
- T#2 Margin empty-states · T#3 Speed Invalid-Date + 1400% · T#4 Inventory negative-production/Available · T#6 Customer 360 cards+fields+charts · T#7 Sales blank-Region.

**PHASE 2 — Filter wiring (P1)**
- T#10 Team cache, DSM/EVP/Budget params, deeper-analytics ref_month, 7D window, unit toggle, budget_2026 consolidation.
- T#5 Team real RSM/DSM targets (needs budget source decision).

**PHASE 3 — Static→live / dead charts (P2)**
- T#7/#8/#9 wire 5 dead canvases + replace static panels on Sales/Margin/Team/Budget, or label as sample.

**PHASE 4 — Verify & close**
- T#11 sanity checks (FY2027 label, ₱162M customer, DSO 278) · re-run audit · UAT.

**Cadence:** each fix = atomic commit, `npm test` green, push (auto-deploys Vercel+Cloud Run), re-screenshot to confirm. Phase 0 alone should visibly restore the financial layer.

---

## 5. Honesty notes (completeness limits)
- Counts (charts/tables/canvases) are exact (grep over source). KPI-tile count is approximate where role-home pages use different card markup (EVP/Team/Budget/Insights show 0 "kpi" tiles because they use `.card`/custom grids — their metrics ARE counted under Sections).
- Per-block live/static/responsive status came from 5 parallel subagents + my own filter-spine read + your 10 screenshots. High confidence on screenshotted pages (Home/Sales/Speed/Inv/AR/Margin/Team/Cust360); medium on non-screenshotted (EVP/RSM/DSM/Customers/Insights/Budget/Itemized) — those should be live-clicked during UAT.
