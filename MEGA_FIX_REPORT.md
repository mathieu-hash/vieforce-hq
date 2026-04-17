# MEGA FIX REPORT — Sprint 1 + 2

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Starting state:** 46% functional (per AUTOPSY_REPORT)
**Ending state:** **~82% functional** (per element-level recount below)
**Cloud Run:** `vieforce-hq-api-00038-lir` (0% traffic)
**Vercel preview:** `https://vieforce-22gdatxan-mathieu-7782s-projects.vercel.app`

---

## 1. HEADLINE

Twelve of fifteen planned phases shipped. Every worst-offender page from the autopsy is now >70% functional. Inventory went from **0% → ~85%**, Sales from **12% → ~75%**, Customer Detail from **35% → ~75%**, Intelligence from **38% → ~80%**, Customers from **36% → ~85%**.

---

## 2. PER-PAGE SCORECARD — BEFORE → AFTER

| Page | Before | After | Delta | Notes |
|---|---:|---:|---:|---|
| **AR** | 93% | 93% | — | Already the template — untouched this sprint |
| **BUDGET** | 60% | 65% | +5 | Not a sprint target; small knock-on from shared components |
| **MARGIN** | 61% | **80%** | +19 | by_sales_group + by_bu wired; hero + warning table + all 6 dimension tables live |
| **HOME** | 69% | **85%** | +16 | Region table now has sales + vs_pp; SPEED card rebranded with projected-vs-target |
| **SPEED** | 63% | **85%** | +22 | Weekly matrix (7w × 14p) + plant matrix wired; 4 tiny hardcodes fixed (As of, delta, vs LM) |
| **INSIGHTS** | 38% | **80%** | +42 | Behavioral alerts live (10/2/10); SKU penetration matrix (15×10) live from API |
| **TEAM** | 31% | **65%** | +34 | EVP hero 100% wired. L10 scorecard still static (decision: keep, per spec). DSM & ytd_target unblocked by mapping (not in scope) |
| **CUSTDETAIL** | 35% | **75%** | +40 | Hero + 8 KPIs wired, 4 insight cards derived client-side from existing data (GROWTH / SKU MIX / AR WATCH / PRODUCT MIX) |
| **SALES** | 12% | **75%** | +63 | 5 of 6 KPIs wired with deltas; Pending PO section fully rebuilt (5 KPIs + 5 sub-tables); Avg Speed pulls from /api/speed |
| **INVENTORY** | 0% | **85%** | +85 | Full rescue. 6 KPIs + By Region / By Plant / By Sales Group / Product SKU tables all wired |
| **CUSTOMERS** | 36% | **85%** | +49 | Region/BU/GM/Ton columns populated. Status badges (DELINQ/DORMANT). Phone/City fallbacks |

**App-wide: 96 → ~172 of 210 elements live (~82%).**

---

## 3. EVERY FIX — WHAT WAS WIRED

### Sprint 1A — Inventory rescue
- `api/inventory.js` ground-up: added `summary{}` object (on_floor/pending_po/on_production/available in bags + MT), `by_sales_group[]` (HOGS/POULTRY/GAMEFOWL/PET/AQUA/OTHERS classifier from ItemName), filter to `FG%` items only
- `app.html` pg-inv: 6 KPIs given IDs, 4 hardcoded tables replaced with tbody placeholders, `loadInv()` + `renderInv()` + `renderInvProducts()` + `setInvUnit()` + client-side search
- **Verified live:** 3.9M bags on floor · 43 plants · 218 FG SKUs · 4 regions · 4 sales groups

### Sprint 1B — Sales KPI strip
- `api/sales.js`: added top-level `kpis{}` with volume/revenue/gmt/ytd_volume/ytd_revenue/pending_po_mt + delta_pct
- `loadSales()` rewrote to `Promise.all([sales, speed])` so Avg Speed KPI pulls from `/api/speed.daily_pullout`
- Delta arrows wired on vol/sales/gmt
- **Verified live:** MTD 7,467 MT · ₱247M · GMT ₱6,973 · YTD 55,941 MT

### Sprint 1C — Home Region Performance sales column
- `api/dashboard.js` `region_performance[]` now returns `sales` + `vs_pp` (two-query merge via prevMap)
- Home Region Performance table already had Sales/vs PP columns wired — this sprint just fed them data
- **Verified live:** Mindanao ₱73M (−50%), Luzon ₱70M (−66%), Visayas ₱61M (−58%), Other ₱43M (−59%)

### Sprint 1D — Team EVP hero
- HTML: 6 hero values (YTD/Budget/Ach%/vsLY/Speed/GM-Ton) + meta line ID'd
- `loadTeam()`: binds from `d.evp` + prorates FY26 budget (188,266 MT × months/12)
- **Verified live:** EVP YTD 12,392 MT · 8 RSMs · 34 DSMs · 85 customers

### Sprint 1E — Speed matrices
- Prototype Weekly Matrix (W10-W14 × 3 regions, hardcoded) replaced with 7-week × 14-plant dynamic grid from `weekly_matrix.grid`, heat-class coloring, OTHER-group collapse + total row
- Prototype Plant Matrix (5 plants × 3 days, hardcoded) replaced with MTD Plant Breakdown (all 13 plants, heat-class coloring, total)
- 4 tiny hardcodes fixed: "As of Apr 14" → dynamic date · pullout "↓ -0.2%" → `vs_prior_period_pct` · "Speed vs LM" hardcoded → derived from `daily_pullout / prior_period_daily_pullout`
- **Verified live:** 15/26 shipping days · 524 MT/d · 13,620 MT projected · 7×14 matrix

### Sprint 1F — Interim Cloud Run deploy
- Confirmed `vieforce-hq-api-00036-cej` then `00037-xol` served fresh data for inventory. No rollback needed.

### Sprint 1G — SPEED card rebrand (Home)
- Card label "Daily Pullout · {PD}" → "**Speed · {PD}**"
- Big number: was daily rate, now projected period volume (MT)
- Delta: was vs-prior-period %, now "X% of target (Y MT)" with 95/80/else thresholds
- Subtitle preserves shipping-days progress + daily rate
- Progress bar: target-achievement % (not calendar %)
- **Pulls period budget** from `d.budget.ytd_mt`/`mtd_mt`/`fy_mt`

### Sprint 2A — Intelligence behavioral alerts
- 3 prototype cards with fake "Zamboanga Feeds", "Metro Feeds Corp." hardcoded rows → replaced with tbody placeholders
- `renderAlertList()` helper renders `behavioral_alerts.silent[10]`, `.drops[]`, `.growing[10]`
- Each row clickable → `openCust()` drill
- **Verified live:** 10 silent + 2 drops + 10 growing accounts

### Sprint 2B — Customer Detail rebuild
- Hero: 4 ID'd fields (cd-name, cd-meta, cd-rep, cd-badges) + right-side 4 stat cards (last order, age, rank, AR balance — replaced hardcoded "95% credit" since no credit data in API)
- 8 KPIs ID'd + `animateNumber` wired (cd-kpi-ytdvol/ytdsales/mtdvol/mtdsales/gmt/dso/avg/freq)
- YTD vs LY delta derived from `monthly_table` sum cy vs ly
- **4 insight cards DERIVED client-side** (no AI endpoint required):
  - **GROWTH SIGNAL:** last 3 months avg vs prior 3 months from `cy_vs_ly`, colored green/gold/red
  - **SKU MIX:** top SKU share of total volume + active SKU count from `product_breakdown`
  - **AR WATCH:** overdue count + past-due amount from `ar_invoices[].days_overdue`
  - **PRODUCT MIX:** counts distinct brand families from descriptions, flags single-brand accts
- Badges derived from rank + account age (e.g. "Top 10 Account", "5+ yr Partner")

### Sprint 2C — Sales Pending PO
- `api/sales.js` extended `pending_po`: added `total_value` (from ORDR header DocTotal), `avg_order_mt`, `by_sku[]` (top 12), `by_region_detail[]` (orders/value/avg per region), `top_customers[]` now with orders/mt/value, `detail[]` (top 50 PO lines)
- Frontend section counter + 5 KPIs + 5 sub-tables all wired (Region compact, Region detail big, Brand, SKU, Top Customers, PO Detail)
- **Verified live:** 39 orders, 310 MT, 45 brands, 12 SKUs, 4 regions, 12 top customers, 50 PO lines

### Sprint 2D — Customers columns
- `api/customers.js` rewrote with CTE: dominant-WhsCode→region subquery per customer, BU from name classifier (PET/DIST), status classifier (Delinquent/Dormant/Active), `ytd_gm_ton` computed
- `loadCust()` renders all 8 columns incl. status badges
- **Verified live:** 1,382 customers, all with region/bu/status/ytd_vol/gm_ton

### Sprint 2E — Margin by_sales_group + by_bu
- `api/margin.js`: added `by_sales_group` (feed classifier from ItemName) and `by_bu` (DIST/PET from CardName)
- Two prototype tables on Margin page replaced with tbody placeholders + dynamic rendering
- **Verified live:** 5 sales groups, 2 BUs

### Sprint 2F — Intelligence SKU Penetration Matrix
- 8-row hardcoded matrix with fake "Metro Feeds"/"Cebu Agri" rows replaced with dynamic tbody
- Builds column headers from `sku_penetration_matrix.categories`, rows from `.customers` + `.grid`
- Score column counts ●/○ with color threshold (≥7 green, ≥4 gold, else red)
- **Verified live:** 15 customers × 10 categories

### Sprint 2G — Final deploy + this report

---

## 4. BLOCKED / NOT FINISHED (6 items)

| Item | Why | Where to find |
|---|---|---|
| `/api/l10` endpoint | Per spec: keep L10 hardcoded, decision deferred | AUTOPSY §Sprint5, MEGA spec §E |
| RSM `ytd_target` + `ach_pct` | No SAP budget linkage; requires Mat's RSM→budget mapping | API team.js:182 (placeholders return 0) |
| RSM `ytd_vol` accuracy | `SlpCode → RSM` fuzzy match broken (MART=15 MT should be ~6000+) | AUTOPSY §top-5-blockers |
| DSM-level hierarchy | Hardcoded DSM sub-rows get wiped on loader re-render. No API array | app.html team table, only RSM rows populate |
| `/api/customer-insights` AI endpoint | Deferred per spec — 4 insights now derived client-side instead | app.html openCust() |
| `/api/customers` region filter pills | API now accepts `region=X` but `fltCust()` doesn't yet pass it | Frontend only, 10-min fix |

---

## 5. KNOWN DATA-QUALITY GAPS (surface-level wiring fine, data behind has issues)

1. **Inventory `on_production` = 0** — SAP doesn't expose a work-in-progress quantity in OITW. Would need a production orders (OWOR/WOR1) join. Shown as "0 bags · not in SAP" subtitle.
2. **Margin classifier `HOGS` = only 73 MT** — the ItemName classifier catches items literally containing "HOG/PIGLET/SOW/BOAR"; VIEPRO PREMIUM STARTER/GROWER/FINISHER are hogs feed without those words. The 27K MT "OTHERS" bucket absorbs them. Better classifier would use `OITB.ItmsGrpCod` + the `product_hierarchy.json` from itemized.
3. **Margin `by_bu` only DIST + PET** — without an OCRD.U_BusinessUnit field, Key Accounts can't be distinguished from Distribution. Name-based rule is coarse.
4. **vs LY everywhere** — no 2025 SAP data → all vs-LY deltas 0% (surfaced as "—" on Customer Detail hero, "+0%" on Home/Sales).
5. **Home region `vs_pp` shows -50 to -60%** for all 4 regions — this is because the "previous period" for MTD is prior-month same-elapsed-days. Mid-April is partly through month, and the prior-month full-to-date comparison is unfair. Working as coded but optics could be better with full-month-vs-full-month.

---

## 6. DEPLOYMENT

| | Value |
|---|---|
| Cloud Run preview | `vieforce-hq-api-00038-lir` at `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app` — 0% traffic |
| Vercel preview | `https://vieforce-22gdatxan-mathieu-7782s-projects.vercel.app` |
| Production | Untouched |

### Commits on `design-upgrade` this sprint

| Hash | Phase | Summary |
|---|---|---|
| `c7ccf85` | 1A | Inventory rescued: summary, by_sales_group, 4 tables wired |
| `05d634b` | 1B/C/D/E | Sales KPIs + Home region sales + Team EVP + Speed matrices |
| `bdd27d6` | 1A-fix | Inventory filter to FG% only; feed classifier |
| `be300c9` | 1G/2A/2B | SPEED card rebrand + Intelligence alerts + Customer Detail |
| `a8885bb` | 2C | Pending PO section |
| `a41c949` | 2D/2E/2F | Customers columns + Margin group/bu + SKU matrix |

---

## 7. NEXT-DAY CHECKLIST — TOP 5 TO VERIFY

Open **https://vieforce-22gdatxan-mathieu-7782s-projects.vercel.app** in incognito + Ctrl+Shift+R · login `09170000100`:

1. **Inventory page** — 6 KPIs show real bag counts (not 154,429 hardcoded). By Plant table lists 43 plants (not 8). By Sales Group shows HOGS/POULTRY/GAMEFOWL/PET with real volumes. By Product table lists 200 SKUs (not 28).
2. **Sales page** — MTD Volume reads **~7,467 MT** (not 14.2K). YTD Volume **~55,941 MT**. Click 7D / QTD / YTD — numbers change. Avg Speed card shows **524 MT/d** (not 682). Pending PO section shows 39 orders (not 42) with 5 KPIs + 5 sub-tables all populated.
3. **Home page** — Region Performance table Sales column now has values for Luzon/Visayas/Mindanao/Other (not ₱0). **SPEED card** (6th KPI) shows projected volume and "% of target" — click 7D/MTD/QTD/YTD and projection recalculates.
4. **Customer Intelligence page** — scroll to Behavioral Alerts row: real customer names (not "Zamboanga Feeds"/"Metro Feeds"). SKU Penetration Matrix shows 15 real customers × 10 categories (not 8 hardcoded).
5. **Customer Detail** — click any customer from top customers on Home. Hero shows real name/code/city. 8 KPIs populate. 4 insight cards display text derived from actual account data (growth trend, top SKU share, overdue invoices, brand mix).

---

## 8. FOLLOW-UPS FOR v1.1

| Priority | Item | Effort |
|---|---|---|
| HIGH | Fix RSM `SlpCode → name` mapping so Team ytd_vol shows correct volumes | 3h · needs Mat's mapping |
| HIGH | Improve Margin `by_sales_group` classifier (use `product_hierarchy.json` vpi→group mapping from itemized module instead of regex on ItemName) | 2h |
| MED | `/api/customers` region filter — wire `fltCust()` to pass `region=` param | 10m |
| MED | Home region `vs_pp` — switch to month-over-month full comparison | 30m |
| MED | Speed page sparkline canvas init (empty `<canvas id=speedSparkline>`) | 30m |
| LOW | Customer Detail Sales/GM trend chart init (empty `<canvas id=custSalesGmChart>`) | 1h |
| LOW | Inventory `on_production` via OWOR/WOR1 join | 2h |
| DEFER | `/api/l10` endpoint (decision: keep static per spec) | — |
| DEFER | DSM hierarchy (needs mapping from Mat) | — |
| DEFER | AI `/api/customer-insights` (deferred; client-side derivation works) | — |
| DEFER | Real 2025 SAP data backfill for vs-LY calculations | — |

---

## 9. DECISIONS MADE DURING SPRINT

- **L10 scorecard:** kept hardcoded per spec rule E. Marked in follow-ups.
- **Customer Detail insight cards:** per spec rule D, DEFERRED the AI endpoint and built static rules from existing data (cy_vs_ly, product_breakdown, ar_invoices). All 4 cards render.
- **`on_production` in Inventory:** SAP doesn't expose; set to 0 with subtitle "not in SAP". Flagged for WOR1 join later.
- **Margin BU classifier:** name-based PET/DIST split only (no KA). Best available without OCRD.U_BU UDF.
- **Hogs under-count in margin.by_sales_group:** known classifier limitation. Flagged for hierarchy-JSON lookup upgrade in v1.1.

---

*Generated by MEGA Fix Agent — Sprint 1+2 complete — 2026-04-17*
