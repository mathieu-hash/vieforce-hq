# VieForce HQ — Live Bug Punch-List (from screenshots 2026-06-02)

Context: filters set to **Period=QTD, Compare=vs PP, Unit=MT, As of=Jun 2026** in most shots.
Severity: 🔴 P0 blocker · 🟠 P1 major · 🟡 P2 polish. Each item: page · evidence · suspected cause.

---

## 🔴 P0 — SYSTEMIC (kills the financial layer)

- [ ] **B1. All peso & margin metrics show ₱0 while volume works.** Net Sales=₱0, Gross Margin=₱0, GM/Ton=₱0, GP%=0.0% on **Home, Sales, Team, Margin**; but Volume=34,125 MT populates. Region rows: volume present, Net Sales/GM/Ton all ₱0. → OINV sales/GM aggregation is broken for the `QTD + ref_month=Jun 2026` anchor while ODLN volume query succeeds. Screenshots: Dashboard 141456, Sales 141526, Team 142447, Margin 142339. **Root-cause first — this likely explains B2/B3/B6 too.**

- [ ] **B2. Margin sub-tables stuck on "Loading…" indefinitely.** GM/Ton by Region, by Sales Group, by Brand, by Business Unit, by Plant, and Worst-Performing SKUs all show "Loading…" and never resolve. → render throws/returns early when the period payload is empty/undefined (no empty-state fallback). Screenshots: Margin 142407, 142339.

- [ ] **B3. Margin hero + KPI band all zero.** Negative GP Exposure=₱0K, Revenue at Risk=₱0, Critical/Warning/Watch/Healthy=0, Nat'l GM/T=₱0, Nat'l GP%=0, "0 warning accounts / No warning accounts". Same root as B1. Screenshots: Margin 142339, 142407.

---

## 🟠 P1 — MAJOR (wrong/broken data that looks real)

- [ ] **B4. Speed hero shows "Invalid Date"** as the big As-of date. → `sp-asof` date parse fails (falls back to bad value) under ref_month anchor. Screenshot: Speed 141756.

- [ ] **B5. Speed "vs Last Month +1400.0%"** — absurd KPI value. → divide-by-near-zero / prior-month base wrong for current partial month. Screenshot: Speed 141756.

- [ ] **B6. Inventory "In Production = −3,888,355"** (negative, red). Production should never be negative. → OWOR aggregation sign/availability math error. Screenshot: Inventory 141739.

- [ ] **B7. Inventory "Available = 0"** everywhere (KPI + column). → confirmed MT-mode zeroing bug (app.html:5276-5278 zeroes PO/Committed/Available in MT); also drives implausible **Cover Days = 336**. Screenshot: Inventory 141739.

- [ ] **B8. Team RSM/DSM Target column = ₱0 and Achievement = 0** for every row → all bars empty, all red. (confirmed api/team.js:553-554,605-606 hardcoded 0). Screenshot: Team 142447.

- [ ] **B9. Team EVP hero internally inconsistent** — shows GM/Ton ₱6,521 here while Home/Sales show ₱0 for the same period; vs PP = −46.3% (partial-period comparison artifact). Reconcile after B1. Screenshot: Team 142447.

- [ ] **B10. Customer 360 — AR Aging card hardcoded** ₱28.4M / Credit ₱30M / 95% / fixed buckets, identical for every customer. (app.html:2588-2604). Screenshot: CustDetail 142229.

- [ ] **B11. Customer 360 — Account Info card hardcoded** ("Roberto Tan / Pasig / J. Santos") for every customer. (app.html:2630-2636).

- [ ] **B12. Customer 360 — Growth insight "Insufficient history to compute trend"** even with full monthly data → field-name mismatch `m.cy_volume` vs API `cy_vol[]` (app.html:5663). Screenshot: CustDetail 142229.

- [ ] **B13. Customer 360 — Top Products / Recent Orders show 0 / blank** → field-name mismatches `p.vol`/`p.name`→`volume`/`item_name`, `o.revenue`/`o.volume`→`DocTotal`/`total_qty` (app.html:5795-5818).

- [ ] **B14. Customer 360 — Monthly Volume CY-vs-LY chart blank** and `custSalesGmChart` never drawn. Screenshot: CustDetail 142229.

- [ ] **B15. Sales — Customer Rankings "Region" column blank** → query returns no region/City field (app.html:4909). Screenshot: Sales 141526.

---

## 🟡 P2 — STATIC / DEAD / POLISH (looks live, isn't)

- [ ] **B16. Sales — Monthly Volume Trend chart empty** (`salesTrendChart` dead; API returns `monthly_trend` unused). Screenshot: Sales 141526.
- [ ] **B17. Sales — GM/Ton by Group chart `gmGroupChart` dead.**
- [ ] **B18. Sales — GM-per-Ton matrix, BU split, all four "Volume Rankings vs Y-1" panels are static HTML** with false "SAP·OINV" badge (app.html:1859-1962). Screenshot: Sales 141526.
- [ ] **B19. Margin — GM/Ton Trend by Region (6mo) chart `marginRegionChart` never drawn** (empty panel). Screenshot: Margin 142407.
- [ ] **B20. Margin — GP% Heatmap (Region×Group) fully hardcoded** static matrix. Screenshot: Margin 142407.
- [ ] **B21. Margin — hero narrative banner static** ("₱337K…Mindanao…3.2% vs 16.1%") regardless of filters. Screenshot: Margin 142339.
- [ ] **B22. Margin — critical-card negative-SKU sublists static** (API `sku_breakdown` ignored). Screenshot: Margin 142339.
- [ ] **B23. Speed — "26 Days in month" static; sparkline dead with hardcoded 40K/0 axis; "vs Last Month" tables show Share%, not a delta.** Screenshot: Speed 141756.
- [ ] **B24. Team — L10 Scorecard, Performance Matrix, Volume-by-BU×Region are static HTML** (Perf Matrix data computed by API but discarded). Screenshot: Team 142447.
- [ ] **B25. Budget — Budgeted-Volume table, Sales P&L, GM-by-region static** (API returns data, loader only console.logs). (not screenshotted, from code audit.)
- [ ] **B26. Customers — no pagination (top-50 only); "Sort" header non-functional.** (from code audit.)

---

## 🟠 P1 — FILTER WIRING (a control silently does nothing)

- [ ] **B27. Team loader cache `DC['pg-team']` has no params** → period/region/segment/month never re-fetch in-session (endpoint supports them). app.html:6781.
- [ ] **B28. DSM Home backend hardcodes `getPeriodDates('MTD')`** + frontend sends no params → period & month inert. api/dsm-home.js:117.
- [ ] **B29. EVP Home loader drops region & segment** → those pills do nothing on the whole page. js/evp-home.js:57.
- [ ] **B30. Budget ignores Region/Segment pills** (uses session role + warehouse CASE). api/budget.js:107,172-191.
- [ ] **B31. Deeper Analytics ignores As-of month** (all 3 endpoints query GETDATE()); cache keys omit ref_month + user (cross-user shared). analytics-sku-matrix.js:63,85.
- [ ] **B32. "7D" = 7 days in Speed but 8 days everywhere else** (shipping_days.js:96 vs _auth.getPeriodDates). Inconsistent windows.
- [ ] **B33. Unit (MT/Bags) barely wired** — only Home headline Volume, Sales KPIs/rankings, Itemized honor it; most volume figures MT-only.
- [ ] **B34. `budget_2026.js` consolidation incomplete** — only team.js consumes it; budget.js still has its own near-duplicate constants (one divergent April figure).

---

## To verify
- [ ] **V1. FY target year label** — Dashboard shows "FY2027" target? Confirm it should be FY2026. Screenshot: Dashboard 141456.
- [ ] **V2. Customer 360 YTD Sales ₱162.2M** for one coop — confirm real vs inflated. Screenshot: CustDetail 142229.
- [ ] **V3. AR "DSO 7-day variation 278"** — confirm DSO value is sane. Screenshot: AR 141655.
- [ ] **V4. Is B1 reproducible at MTD/Live too, or only QTD + As-of Jun 2026?** Toggle Period=Live to isolate whether it's the ref_month anchor or the OINV query itself.
