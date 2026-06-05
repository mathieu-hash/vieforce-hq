# VieForce HQ — VERIFIED Master Audit (definitive)
Date: 2026-06-02 · Method: 30-agent two-pass workflow (inventory → adversarial verify) checked against **32 live API snapshots** in `_audit_snapshots/`. Every verdict cites snapshot field + source line. This supersedes the screenshot-based punch-list where they disagree.

Live commit: d03d538 (Vercel + Cloud Run green).

---

## 0. Three claims the verification OVERTURNED (don't act on the old ones)
1. **"₱0 is one systemic OINV bug"** — FALSE. `sales.js` returns correct money (₱1.13B/Q2). The zeros are in **dashboard.js, margin.js, budget.js** specifically.
2. **"OINV has no Q2 data yet"** — FALSE. Same dashboard payload's `quarterly_perf` returns Q2 cy_gm=**₱220.8M** (it uses `queryBoth`); the current-period KPIs use a plain `query()` and return 0. It's a query/DB-routing bug, not an empty period.
3. **"Team cache defeats filters"** — FALSE. `setRegion/setSegment/setPeriod/setRefMonth` all run `DC={}` then `loadPage`, so Team **does** refetch. Team's real bugs are targets=0 and orphaned static blocks.

---

## 1. THE OINV-ZERO FAMILY (P0 — one likely root cause, three endpoints)
All three return correct **volume (ODLN)** but **₱0 for OINV-derived money**, while `sales.js` (same OINV/INV1 join) works:

| Endpoint | Symptom (verified in snapshot) | Agent's root-cause lead |
|---|---|---|
| `dashboard.js` | revenue=0, gross_margin=0, gmt=0 at MTD/QTD/YTD; region rows sales=0/gm_ton=0 (vol correct) | current-period KPI CTE uses single-DB `query()` (lines 59-75) while `quarterly_perf` uses `queryBoth` and returns ₱220.8M. Fix: route current-period OINV through the same path `sales.js`/`quarterly_perf` use. |
| `margin.js` | **entire payload empty** — hero/kpis all 0, all 9 arrays `[]`, both QTD **and** YTD | YTD (widest window) empty too → not a date bug. Suspect `GrssProfit` column name in INV1, or `applyRoleFilter` emitting `1=0` for this role. |
| `budget.js` | hero.ytd_actual=0, achievement=0, monthly actual `[0,0,0,0,0,0]`, region actuals 0 (budgets correct) | SAP `periodActual` OINV query returns 0 — same family. |

**Action:** investigate together using the SAP B1 MCP (query OINV/INV1 for 2026 directly to confirm which DB the invoices live in and whether `GrssProfit` is the right column), fix `sales.js`'s working pattern into all three. One root cause probably clears Home, Margin, and Budget money at once.

Plus a related backend crash:
- **`/api/dashboard?region=<X>` → HTTP 500** `Must declare the scalar variable "@region"` — region filter builds SQL with `@region` but never binds it. Selecting any region crashes Home.

---

## 2. Verified per-page status

| Page | Live core | Verdict | Headline issues (verified) |
|---|---|---|---|
| **Home** | KPIs vol/DSO/speed/PO + region vol + segment + top-cust + both charts | 🔴 | revenue/GM/GM-Ton ₱0 (OINV family); region filter 500; NATIONAL DSO hardcoded "47d"; ticker + shipping-days footer static; margin-alert 4th pill mislabels "Growing"→"Healthy" |
| **EVP Home** | Journey YTD, Volume, Top Region | 🔴 | revenue/GM ₱0; GM% **broken binding** (reads `margin.national_gp_pct`, real path `margin.kpis.natl_gp_pct`); Risk-Radar AR aging **broken binding** (`b['61_90']` vs snapshot `d61_90`); loader drops region+segment; Opportunity Radar + District line hardcoded; ach% = fixed weights |
| **RSM Home** | name, vol KPI, Patrol (Supabase), audit flags | 🔴 | District% + DSM scorecards + conversions + whitespace = **name-hash/arithmetic proxies**; hero region never matches (team rows lack `region` field — **one-line backend fix lights up hero**); AR is national not regional; compare toggle dead; Vet-Mission + Strategic-Decisions static |
| **DSM Home** | sales hero, distributors, AR, critical-AR | 🟠 | backend hardcodes `getPeriodDates('MTD')` → period/month inert; target = 110%×prior (proxy, clamped to 150%); conversions=0 hardcoded; Patrol blocked (`permission denied for table users`) |
| **Sales** | 7 KPIs (incl. revenue ₱1.13B), rankings, full Pending-PO | 🟠 | **GM% KPI renders the peso GM (220,861,954) as "220861954.0%"** (broken binding — no GM% field exists); rankings Region col blank; `salesTrendChart`+`gmGroupChart` dead; GM matrix + BU split + 4 "vs Y-1" panels static |
| **AR** | everything | 🟢 | Clean live snapshot. Only minor toggle quirks (variation "today" ignores delinquent toggle). |
| **Inventory** | all tables/KPIs live SAP | 🟠 | Available=0 is an intentional `Math.max(0,…)` clamp (national net negative); By-Sales-Group **MT mode zeros PO/Committed/Available** (no MT cols in SQL); label bugs ("floor − PO" actually committed; "OWOR+WOR1" only OWOR) |
| **Speed** | hero, KPIs, daily chart, matrices | 🟠 | As-of "**Invalid Date**" (QTD `ship_date='W23'`→`new Date` fails); **vs-Last-Month +3490%/+8586%** (backend compares full period vs single last-month day); chart x-axis renders "Invalid Date" per QTD bar; sparkline dead; many "MTD"/"vs LM" mislabels; weekly matrix ignores period (trailing-6wk) |
| **Customers** | table fully live | 🟠 | **No pagination** (limit:50 hardcoded; total=872, 18 pages); "Sort" header non-functional; region/bu are inferred PROXY; 8 mock rows in static HTML (overwritten) |
| **Customer 360** | hero, KPIs, AR total, CY-vs-LY chart, SOA | 🔴 | **AR Aging card + Account Info card hardcoded** for every customer; Top Products + Recent Orders **broken binding** (`p.vol`→`volume`, `o.revenue`→`DocTotal`) → 0/blank; Growth insight `.length` on object → always "insufficient"; `custSalesGmChart` dead; Avg-Order/Frequency mislabeled (peso shown as MT; raw count as /wk) |
| **Margin** | (nothing — empty payload) | 🔴 | Backend empty (OINV family); **6 tables freeze on "Loading…"** (no empty-state else); guarded cards show **stale fake data** (Bukidnon −₱210K, "Luzon 17.8%", heatmap, "₱337K" banner) indistinguishable from live; `marginRegionChart` dead; GP% heatmap static; critical-card SKU sublists ignore `sku_breakdown` |
| **Insights** | all upper bands + all deeper analytics | 🟢 | Genuinely live & filter-responsive (region/segment; heatmap unit vol/rev). Win-Back modal is **hybrid** (live count/amt + static "v1.1" body) — earlier "placeholder only" was stale. Upper bands period-N/A by design. Deeper analytics ignores ref_month (trailing-12M). |
| **Team** | EVP hero, RSM scorecard, rankings, account-health | 🟠 | RSM/DSM **target=0, ach%=0** (backend hardcoded) → all red, empty bars; **Performance Matrix static while API returns `performance_matrix.grid`** (orphaned live data, loader only console.logs); Volume-by-BU + L10 static; Account-Health header badge hardcoded **"12 silent/13 neg"** vs real **346/9** |
| **Budget** | hero pacing, history chart, region table, monthly chart | 🟠 | hero actual ₱0 (OINV family); **Budgeted-Volume + Sales-P&L + GM-by-region tables static** while API returns the data (orphaned); GM-by-region static table has a **fabricated "PET CARE" row** not from API; compare pill dead; still own-constants not `budget_2026.js` |
| **Itemized** | national fully live | 🟢 | Cleanest. National live (CY); LY layer all 0 (2025 returns no rows — backend data absence, binding correct); non-national = `district_mapping_pending` (correct). Minor: collapse-key typo `itm_collapse`/`itm-collapse`; Excel ignores unit toggle |

---

## 3. Execution phases (fix order)
**P0 — financial truth & crashes**
1. OINV-zero family: dashboard.js + margin.js + budget.js (root-cause via SAP MCP, apply sales.js pattern). [Tasks #1, #13, #14]
2. dashboard `@region` 500 crash. [#12]
3. Margin frontend: empty-state `else` on 6 tables + stop showing stale fake cards on empty. [#2]

**P1 — broken bindings & wrong math (live data shown wrong)**
4. Sales GM% peso-as-percent; rankings region. [#7]
5. Customer 360 hardcoded cards + field mismatches + dead chart + mislabels. [#6]
6. Speed Invalid-Date + vs-LM math + chart labels. [#3]
7. EVP/RSM/DSM home broken bindings + RSM region backend field + proxy honesty. [#15]
8. Team targets=0 + wrong account-health badge; misc stale static badges (NATIONAL DSO "47d", ticker, shipping-days). [#5, #16]

**P2 — orphaned data, static→live, filter breadth**
9. Wire orphaned live data the API already returns: Team Performance Matrix, Budget Budgeted-Volume/P&L/GM-by-region. [#9]
10. Dead charts (salesTrend, gmGroup, speedSparkline, custSalesGm, marginRegion) — wire or remove. [#7/#8/#9]
11. Filter wiring: DSM MTD hardcode, EVP region/segment, Budget region/segment+compare, deeper-analytics ref_month, 7D window parity, unit-toggle breadth, budget_2026 consolidation. [#10]
12. Inventory MT-mode zeroing + label fixes; Customers pagination + sort. [#4, plus Customers]

**Verify after each:** re-hit the affected endpoint snapshot, confirm non-zero/correct, `npm test`, deploy, re-screenshot.
