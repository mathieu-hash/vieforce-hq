# VieForce HQ — Architecture Scout Report

**Generated:** 2026-04-18 · branch `design-upgrade` @ `fdb061e`
**Author:** Scout Agent
**Purpose:** Master-orchestration reference. Single source of truth for HQ architecture as of this commit.

---

## 1 · Pages & Routes

Single-page app. All pages are `<div class="page" id="pg-*">` blocks inside `app.html`; no client-side router — `navTo(id)` toggles `.active` and calls `loadPage(id)` → dedicated loader.

| Route (page div id) | Sidebar label | Loader | Primary API | Detail level |
|---|---|---|---|---|
| `pg-home`          | Home                  | `loadHome()`          | `/api/dashboard` + `/api/sales` + `/api/ar` + `/api/speed` | 7 KPI cards, Region Perf, BU Split, Top Customers, Monthly + Quarterly combo charts, Ticker |
| `pg-sales`         | Sales                 | `loadSales()`         | `/api/sales` + `/api/speed` | 6 KPIs, Brand chart, Top customers, GM/T table, Monthly trend, Pending PO (5 KPIs + 5 tables) |
| `pg-ar`            | Accounts Receivable   | `loadAR()`            | `/api/ar` | Aging buckets, AR chart, Client list (search + bucket filter), SOA button → modal |
| `pg-inv`           | Inventory             | `loadInv()`           | `/api/inventory` | 6 KPIs (On Floor / Pending PO / On Production / Available / Cover Days / Neg), By Region, By Plant, By Sales Group, By Product. Drill-down via region/plant pills + URL hash |
| `pg-speed`         | Speed Monitor         | `loadSpeed()`         | `/api/speed` | Hero banner, 5 KPIs, Daily Pullout chart (dynamic title per period), Weekly matrix, Plant breakdown, RSM speed, Feed type speed |
| `pg-customers`     | Customers             | `loadCust()`          | `/api/customers` | Filter pills (ALL/Luzon/Visayas/Mindanao), Customer table (Code / Region / BU / Volume / Net Sales / GM/Ton / Status badge) |
| `pg-custdetail`    | Customer Detail (nav via `openCust(code)` or Top Customers click) | `openCust()` → inline | `/api/customer?id=` | Hero, 8 KPIs, CY vs LY bar chart, Monthly breakdown table, Product breakdown, AR invoices, Recent orders, 4 derived insight cards (Growth / SKU Mix / AR Watch / Product Mix) |
| `pg-insights`      | Customer Intelligence (NEW) | `loadIntelligence()` | `/api/intelligence` | Behavioral alerts (silent/drops/growing), SKU Penetration Matrix — **under rebuild by Agent-Intelligence** |
| `pg-margin`        | Margin Alerts         | `loadMargin()`        | `/api/margin` | Hero, warning table, 6 dimension tables (by region/BU/sales group/brand/customer) |
| `pg-team`          | Sales Team            | `loadTeam()`          | `/api/team` | EVP hero, L10 scorecard (static), RSM table (8 rows), silent/negative margin tables |
| `pg-budget`        | Budget & P&L          | `loadBudget()`        | `/api/budget` | FY2026 vs actual, monthly breakdown |
| `pg-itemized`      | Itemized Sales        | `loadItemized()`      | `/api/itemized` + `/api/itemized/meta` | National + 47-district product table with Excel export |

**Modal overlays:**
- `#soa-backdrop` — SOA PDF/Excel generation dialog (Track 2), opens from `pg-custdetail` Issue SOA button.
- `.gs-dropdown` — global search autocomplete, anchored to topbar `#global-search`.

---

## 2 · Navigation Structure

```
Sidebar (collapsible, var(--sidebar-w) 240px / collapsed 64px)
├── BRAND                  [shield logo + "VieForce HQ / Sales Intelligence"]
├── DASHBOARD
│   ├── Home               🏠  navTo('pg-home')      · active by default
│   ├── Sales              📊  navTo('pg-sales')
│   ├── Accounts Receivable 💰 navTo('pg-ar')
│   ├── Inventory          📦  navTo('pg-inv')
│   └── Speed Monitor LIVE ⚡  navTo('pg-speed')
├── INTELLIGENCE
│   ├── Customers          👥  navTo('pg-customers')
│   ├── Customer Intellig NEW 🧠 navTo('pg-insights')
│   ├── Margin Alerts (N)  ⚠   navTo('pg-margin')
│   └── Sales Team         🏆  navTo('pg-team')
├── REPORTS
│   ├── Budget & P&L (FY26) 📑 navTo('pg-budget')
│   ├── Sales Pivot         📐 (tile only, no page yet)
│   ├── Customer Plotting   🗺  (tile only, no page yet)
│   └── Itemized Sales      📄 navTo('pg-itemized')
├── SAP STATUS bar         [live/stale indicator]
└── USER BLOCK             [avatar / name / role · region · click to logout]

Topbar
├── Title + subtitle (set by pageTitles[id])
├── Period chips           [7D | MTD (default) | QTD | YTD]        → setPd(el)
├── Compare chips          [vs PP (default) | vs LY]                → setCmp(el)
├── Unit toggle            [MT (default) | Bags]                    → setU(el)
├── Global search          🔍 #global-search + .gs-dropdown          → gsOnInput
├── Clock #clock (H:MM:SS)
├── Refresh button ⟳       → refreshNow() (clears DC cache + reloads current page)
└── Theme toggle 🌙/☀️      → toggleTheme()
```

**State globals (app.html top of script):**
```js
var PD='MTD', RG='ALL', CMP='vs_pp', PG='pg-home', DC={}, charts={};
// DC = page-level cache. setPd/setCmp clear DC and re-call loadPage(PG).
// Auto-refresh: setInterval(() => { DC={}; loadPage(PG) }, 60000);
```

---

## 3 · Authentication & Session Model

**Provider:** Supabase (shared `users` table with VieForce Patrol · same PIN flow).

**Flow:**
```
index.html (login screen)
  └── login(phone, pin)
        └── supabaseClient.from('users').select(...).eq('phone',cleaned).single()
              ├── pin_hash literal comparison (plaintext in v1 — spec debt)
              ├── is_active flag enforced
              └── localStorage.setItem('vf_session', { id, name, role, region,
                                                        district, territory,
                                                        loggedInAt, expiresAt:+24h })
  └── redirect → app.html
```

**Session TTL:** 24 hours hard expiry (`getSession()` returns null + clears storage past `expiresAt`).

**Session key:** `vf_session` in localStorage (isolated from Patrol's key).

**Request auth:** every `/api/*` call includes header `x-session-id: <session.id>` (the UUID from Supabase users). Server-side `verifySession(req)` re-queries Supabase to fetch role/region — no JWT, no signing. Session ID is effectively a bearer token valid 24h client-side but infinitely server-side (no expiry check on API).

**401 handling:** `apiFetch()` in `js/api.js` detects 401 → calls `logout()` → clears localStorage → redirects to `index.html`.

---

## 4 · Design System

### Color tokens (CSS custom properties, `app.html` `:root` + `[data-theme=light]`)

**Dark mode (default):**
```
--bg         #00293A    base background (Deep Navy)
--bg2        #003347    panel bg
--bg3        #004058    elevated
--bg4        #004A64    brand surface
--navy       #004A64    Vienovo corporate navy
--blue       #00AEEF    Vienovo Corporate Blue (primary accent)
--green      #97D700    Vienovo Growth Green (positive deltas, budget OK)
--gold       #FFC72C    Vienovo Gold (warnings, watch states)
--red        #EF4444    critical, negative deltas
--text       #F0F4FA    primary text
--text2..4   muted hierarchy
--surface    rgba(0,50,72,0.55)   glass card
--divider    rgba(255,255,255,0.06)
--glow-blue  rgba(0,174,239,0.08)
--glow-green rgba(151,215,0,0.08)
--glow-gold  rgba(255,199,44,0.1)
--glow-red   rgba(239,68,68,0.08)
```

**Light mode (`[data-theme=light]`):** slightly shifted for print-friendly contrast
```
--bg #F5F5F5 · --green #7AB800 · --red #DC2626 · --gold #D7AB26 · --text #1A1A1A
```

### Typography
- **Headline / body:** `Montserrat` (400/500/600/700/800), Google Fonts via `<link>` in both `index.html` + `app.html`.
- **Monospace / numbers:** `Source Code Pro` (400/500/700). Tabular numerics via `font-variant-numeric: tabular-nums` on `.tbl .num` / `.big-num`.

### Component primitives (class inventory)

| Class | Purpose |
|---|---|
| `.kpi` / `.kpi-sm` / `.kpi-enr` | KPI card (compact, enriched with YTD progress) |
| `.kpi-val` / `.kpi-label` / `.kpi-delta` / `.kpi-enr-prog` / `.kpi-enr-status` | KPI internals |
| `.card` / `.card-hdr` / `.card-title` / `.card-body` | Generic section card |
| `.chart-wrap` | Chart container (height locked) |
| `.tbl` / `.tbl .num` / `.tbl .big-num` / `.tbl .total` | Data table (zebra, tabular-nums) |
| `.badge b-red / b-gold / b-green / b-blue` | Status pills |
| `.rank rank-1/2/3/n` | Top-N rank chips (gradient gold, blue, etc.) |
| `.filter-bar` + `.filter-chip` / `.filter-chip.active` | Secondary filter row per page |
| `.tb-chip` / `.tb-compare-chip` / `.tb-toggle-btn` | Topbar period / compare / unit chips |
| `.topbar` / `.tb-search` / `.tb-clock` / `.theme-btn` / `.refresh-btn` | Topbar row |
| `.sidebar` / `.sidebar.collapsed` / `.nav-item` / `.nav-item.active` | Side nav |
| `.brand` / `.brand-logo` / `.brand-text` | Brand block (shield logo) |
| `.list-row` | Flex row used in Top Customers, product breakdowns |
| `.stagger` | Entrance animation container (cards fade-in sequentially) |
| `.heat-0..4` / `.gm-matrix` / `.aging-bar` / `.pen-y/hot/n` | Heatmap / matrix cells |
| `.export-btn` | Auto-injected Export to xlsx button on any card with a table |
| `.soa-backdrop` / `.gs-dropdown` / `.drill-active` / `.inv-filter-bar` | Track 2 additions |

### Assets (`/assets/`)

```
vieforce-logo.png     1141×1166 master (transparent, 1.4 MB)
vieforce-logo-md.png  501×512 login screen
vieforce-logo-sm.png  250×256 sidebar brand
icon-512/192/64.png · apple-touch-icon.png (180) · favicon-32/16.png · favicon.ico (multi-res)
manifest.webmanifest  PWA install (theme #00293A, standalone)
```

### Chart library
- **Chart.js 4.4.1** (+ `chartjs-plugin-datalabels` 2.x) — CDN, all chart pages use it.
- Home Monthly/Quarterly: custom combo (dual-axis bar+line, data-label pills, delta badges plugin).
- Speed Daily Pullout: single bar chart, dynamic title per period, destroy+recreate on data update.
- Customer Detail CY vs LY: bar chart, destroy+recreate from `cy_vs_ly` object.

### Export libraries (Track 2)
- `xlsx-js-style@1.2.0` — full cell styling (replaced plain xlsx)
- `jspdf@2.5.1` + `jspdf-autotable@3.8.1` — SOA PDF generation

---

## 5 · Deployment

| Layer | URL | Notes |
|---|---|---|
| Frontend (Vercel) | **https://vieforce-hq.vercel.app** | aliased prod. Static `index.html` + `app.html` + `js/` + `css/` + `/assets/` + `/manifest.webmanifest`. `/api/` served by Cloud Run (called from `js/api.js` directly). |
| API (Cloud Run) | `https://vieforce-hq-api-1057619753074.asia-southeast1.run.app` | Canonical prod URL. Project `vieforce-vpi`, region `asia-southeast1`. |
| Cloud Run revision | **`vieforce-hq-api-00051-roq`** at 100% traffic | Latest: Home combo charts + OINV audit (Apr 18) |
| Previous prod revisions (rollback candidates) | `00049-fof` (Track 2) · `00047-yar` (OWOR split) · `00045-guw` (Track 1) · `00042-wis` (speed cutoff) · `00038-lir` (MEGA_FIX) | — |
| Branch | `design-upgrade` @ `fdb061e` | Never merged to main — prod deploys go from this branch |

**Deploy commands (established workflow):**
```bash
# API (Cloud Run, source-based Docker build)
gcloud run deploy vieforce-hq-api --source . --region asia-southeast1 --no-traffic --tag preview --quiet
gcloud run services update-traffic vieforce-hq-api --region asia-southeast1 --to-latest --quiet

# Frontend (Vercel)
vercel --prod --yes   # aliases to vieforce-hq.vercel.app automatically
```

**`.vercelignore` excludes** `api/`, `server.js`, `Dockerfile`, `scripts/`, `docs/`, `node_modules/`, `.autopsy/`, `*.backup`, `*.md`. Ensures Vercel stays under Hobby's 12-function limit (frontend-only; API is on Cloud Run).

---

## 6 · Tech Stack

| Layer | Choice | Version | Role |
|---|---|---|---|
| Frontend | Vanilla HTML/CSS/JS — **no framework** | — | Preserves original prototype design, zero build step |
| Charts | Chart.js + chartjs-plugin-datalabels | 4.4.1 | All visualisations |
| Export | xlsx-js-style · jspdf + autotable | 1.2 / 2.5 / 3.8 | SOA PDF/Excel + per-table xlsx exports |
| Backend | Express 4.22.1 on Node.js 20-slim (Docker) | — | Cloud Run container (`Dockerfile`) |
| DB driver | `mssql` (node-mssql) | 10.0.1 | Pooled connection to SAP B1 |
| DB | Microsoft SQL Server — SAP Business One `Vienovo_Live` | — | Read-only queries, never INSERT/UPDATE/DELETE |
| Auth | `@supabase/supabase-js` | 2.39 | Shared `users` table with Patrol, PIN login |
| In-memory cache | `lib/cache.js` (Map + TTL) | — | Per-instance cache, 30s–15min per endpoint |
| Config | `dotenv` | 17.4.2 | `.env.local` for SAP + Supabase creds |
| CORS | `cors` middleware | 2.8.6 | Allows `*.vercel.app` / `*.run.app` / `localhost:*` |
| Hosting API | Google Cloud Run | — | `asia-southeast1`, 512 MB / 30s timeout |
| Hosting frontend | Vercel Hobby | — | Static + PWA manifest |
| CI/CD | None formal — manual `gcloud` + `vercel` from dev machine | — | — |
| Version control | Git + GitHub | — | `vienovoph/` org (per user memory) |

**Node handler pattern:** each `api/*.js` is a Vercel-style `module.exports = async (req, res) => { ... }`, mounted via `server.js` using `app.get('/api/<n>', handler)`. Same code works in Vercel Serverless Functions or Cloud Run without modification.

---

## 7 · API Endpoints

All `GET` only. Require `x-session-id` header. Query params optional. All money in PHP (₱), volumes in MT (1000 bags = 1 MT via `OITM.NumInSale`).

| Endpoint | Params | Cache TTL | Returns |
|---|---|---|---|
| `GET /` | — | — | `{status:'ok', service, version}` |
| `GET /api/diag` | — | — | SAP schema probe: OITM column list, ODLN/daily_speed sample rows (SAP connectivity check) |
| `GET /api/dashboard` | `period`, `region` | 300s | `{revenue, volume_mt, gross_margin, gmt, gm_per_bag, previous_period, last_year, delta_pct, delta_pct_ly, ytd, budget, ar_balance, ar_active_balance, ar_delinquent_balance, dso_total, dso_active, pending_po, region_performance[], top_customers[], monthly_perf[7], quarterly_perf[4], margin_alerts}` — **Home page hub** |
| `GET /api/sales` | `period`, `region`, `groupBy` | 300s | `{kpis, top_customers, by_brand, by_district, by_category, monthly_trend, pending_po{...5 sub-tables}}` |
| `GET /api/ar` | `region`, `status` | 300s | `{buckets, chart_data, clients[]}` — aging + client list |
| `GET /api/inventory` | `plant` | 900s | `{summary, production{real+stale split}, plants[], items[], by_region[], by_sales_group[], negative_avail_count, cover_days}` |
| `GET /api/speed` | `period` | 300s | `{period, current_date_ph, period_start, period_end, holidays_in_period[], shipping_days_elapsed/total/remaining, period_volume_mt, daily_pullout, projected_period_volume, vs_prior_period_pct, daily[], plant_breakdown[], rsm_speed[], feed_type_speed[], weekly_matrix{weeks,plants,grid}}` — PH holiday-aware |
| `GET /api/customers` | `search`, `region`, `limit`, `page` | 600s | `{total, page, pages, customers[{CardCode, CardName, rsm, ytd_volume, ytd_gm_ton, region, bu, status, ...}]}` |
| `GET /api/customer` | `id` | 300s | `{info, ytd_sales, kpis, ar_invoices[], product_breakdown[], recent_orders[], cy_vs_ly{months,cy_vol,ly_vol}, monthly_table[{month, vol_cy, vol_ly, vs_ly_pct, sales, gm_ton}], account_age_days, rank_by_volume}` |
| `GET /api/customer/soa` | `id` | 60s | `{customer, last_payment, open_invoices[], aging{current,1-30,...,over_1y}, dso}` — Track 2 |
| `GET /api/margin` | `period`, `region` | 300s | `{summary, alerts[], by_region[], by_bu[], by_sales_group[], by_brand[], by_customer[]}` |
| `GET /api/intelligence` | `period` | 600s | `{brand_coverage[], brands_per_customer[], order_frequency[], volume_change[], sku_penetration_matrix{customers,categories,grid}, behavioral_alerts{silent,drops,growing}}` — **under rebuild** |
| `GET /api/team` | — | 300s | `{evp, rsm_scorecard[], silent_customers[], negative_margin_customers[], monthly_by_rep[]}` |
| `GET /api/budget` | — | 300s | `{fy2026_targets, ytd_actuals, monthly_breakdown[], by_region[]}` |
| `GET /api/itemized` | `district`, `year` | 600s | `{national{...}, district_rows[47], year_columns}` — 224 SKU × district matrix |
| `GET /api/itemized/meta` | — | — | `{districts[48], years[], skus[224]}` |
| `GET /api/search` | `q`, `type=customer` | 30s | `{results[≤8]{code,name,region,ytd_volume,sales_rep}, query, type, count}` — Track 2 global search |

**Shared helpers (`api/_auth.js`, `api/lib/shipping_days.js`):**
- `verifySession(req)` → `{id, name, role, region, district, territory}` or `null`
- `getPeriodDates(period)` → `{dateFrom, dateTo}` for `7D/MTD/QTD/YTD`
- `applyRoleFilter(session, baseWhere)` — **currently returns baseWhere unchanged for authenticated users** (RBAC scaffolded, not enforced)
- `countShippingDays(from, to)` — Mon-Sat excluding PH holidays (`api/data/shipping_calendar_ph.json`)
- `getShippingCutoff()` — legacy 5am rule helper (superseded by calendar)
- `listHolidaysInPeriod(from, to)` — for `holidays_in_period` debug field

---

## 8 · Database Schema (SAP B1 · `Vienovo_Live` · MSSQL)

**Connection:**
```
host     analytics.vienovo.ph
port     4444
database Vienovo_Live
user     gsheet (read-only intended; not yet dedicated)
driver   mssql — encrypt:false, trustServerCertificate:true, pool{max:10}
```

**Tables touched (read-only, SAP B1 standard):**

| Table | Alias | Key columns used | Used by |
|---|---|---|---|
| `OINV` | T0 / OINV | DocEntry, DocNum, DocDate, DocDueDate, CardCode, CardName, DocTotal, PaidToDate, SlpName, U_Region, CANCELED, ObjType, NumAtCard | dashboard, sales, ar, customers, customer, customer-soa, margin, intelligence, team, budget, itemized |
| `INV1` | T1 | DocEntry, ItemCode, Dscription, Quantity, LineTotal, GrssProfit, WhsCode | same |
| `ORCT` | — | DocEntry, DocNum, DocDate, DocTotal, CardCode, CardName, Canceled | customer-soa (last_payment) |
| `ODLN` | T0 | DocEntry, DocDate, CardCode, CardName, SlpCode, CANCELED | speed, dashboard (shipping rate), inventory (daily avg) |
| `DLN1` | T1 | DocEntry, ItemCode, Dscription, Quantity, WhsCode | same |
| `ORDR` | T0 | DocEntry, DocStatus (O=open), DocDate, CardCode, DocTotal, CANCELED | dashboard.pending_po, sales.pending_po |
| `RDR1` | T1 | DocEntry, ItemCode, Quantity, LineTotal, WhsCode | same |
| `OCRD` | C / T0 | CardCode, CardName, CardType (C=customer), Phone1, City, Address, GroupCode, SlpCode, frozenFor, U_BpStatus ('Active'/'Inactive'), CreditLine, U_BusinessUnit(?), E_Mail | customers, customer, customer-soa, intelligence, search, ar |
| `OITM` | I | ItemCode, ItemName, NumInSale (bags→MT conversion), ItmsGrpCod | all volume/revenue queries — join for MT conversion |
| `OITW` | IW | ItemCode, WhsCode, OnHand, IsCommited, OnOrder | inventory |
| `OWHS` | W | WhsCode, WhsName, Inactive | inventory (plants) |
| `OWOR` | W | DocEntry, Warehouse, ItemCode, PlannedQty, CmpltQty, Status ('R'=Released active), DueDate | inventory.production (Track 1 Bug 2) |
| `OSLP` | S | SlpCode, SlpName | speed.rsm_speed, customer, customer-soa (sales_rep), customers (rsm) |
| `OCTG` | — | PymntGroup | customer-soa (payment_terms) |
| `OITB` | — | ItmsGrpCod, ItmsGrpNam | (reference only; current margin classifier uses ItemName regex not OITB) |

**Region mapping (hardcoded CASE in dashboard/inventory/customers/speed/margin):**
```sql
CASE
  WHEN WhsCode IN ('AC','ACEXT','BAC')        THEN 'Luzon'
  WHEN WhsCode IN ('HOREB','ARGAO','ALAE')    THEN 'Visayas'
  WHEN WhsCode IN ('BUKID','CCPC')            THEN 'Mindanao'
  ELSE 'Other'
END
```
**Gotcha:** "Other" absorbs ~30+ unmapped plant codes (e.g. SOUTH, CCPC-BRANCH variants) — their volume shows under Other rather than its true region.

**Active-customer predicate (used by dashboard.dso, ar.active_balance):**
```sql
(ISNULL(C.frozenFor,'N') <> 'Y' AND C.U_BpStatus = 'Active')
```

**PH shipping calendar** — `api/data/shipping_calendar_ph.json`:
- Sundays excluded automatically.
- 2025 + 2026 holidays listed (New Year, Holy Week, Araw ng Kagitingan, Labor Day, Independence, Heroes, All Saints, Bonifacio, Immaculate Conception, Christmas, Rizal).
- **Known gap (flagged for Mat):** VPI Ops counts 12 shipping days Apr 1–16, this calendar produces 10 — likely VPI ships on Maundy Thursday + Black Saturday. Mat to confirm.

**Data-quality gaps (from MEGA §5):**
1. `OITW.on_production` not in standard — now sourced from OWOR (Track 1 Bug 2).
2. Margin HOGS classifier undercounts VIEPRO PREMIUM items (missing "HOG" keyword).
3. No 2025 OINV in DB → `vs LY` everywhere returns 0 / "—".
4. RSM `SlpCode → name` mapping broken → Team YTD volumes low; needs Mat's mapping.

---

## 9 · RBAC Model

**Current state:** Scaffolded, **NOT enforced**.

```js
// api/_auth.js
function applyRoleFilter(session, baseWhere) {
  if (!session) return baseWhere + ' AND 1=0'
  switch (session.role) {
    case 'admin': case 'ceo': case 'evp':
    case 'rsm':   case 'dsm': case 'tsr':
      return baseWhere  // ALL authenticated users see ALL data
    default:
      return baseWhere + ' AND 1=0'
  }
}
```

**Planned rules (from CLAUDE.md §11 / not implemented):**
- `rsm` → `AND T0.U_Region = '{session.region}'`
- `dsm` → `AND T0.SlpName = '{session.name}'` (via `SlpCode → OSLP` join)
- `ceo/evp/admin` → no filter

**Roles in Supabase `users` table:** `admin, ceo, evp, rsm, dsm, tsr` + `is_active` flag.

**Follow-up risk:** until RBAC filters ship, a DSM logging in sees national data (incl. other districts' customers/AR). Acceptable for current beta (Mat, Joel, Rico); must be closed before external RSM/DSM rollout.

---

## 10 · Known Issues (Recent Fixes)

| # | Date | Source | Bug | Status |
|---|---|---|---|---|
| 1 | Apr 17 | Prod | Speed Daily Pullout chart showed only Mar 31 – Apr 4 bars | ✅ Fixed: destroy+recreate Chart.js instance from API labels (`a8885bb`) |
| 2 | Apr 17 | Prod | `daily_pullout` = 530 MT/d (VF) vs 622 (Ops tool) | ✅ Fixed: divide by `days_with_shipments` for 7D/MTD; Mon-Sat for QTD/YTD (`bca63bc`) |
| 3 | Apr 17 | Prod | `daily_pullout` overcounted today (in-progress shipments) | ⚙️ Initially fixed with 5am cutoff (`00042-wis`), then **replaced** by PH shipping calendar (`00044-beg`) — today-counts with Sundays+holidays excluded. Calendar still awaiting Mat's confirmation on Maundy Thu + Black Saturday — **currently holds REAL=11 days, Ops shows 12**. |
| 4 | Apr 17 | — | Branding / logo / favicon | ✅ Shipped shield logo + manifest.webmanifest + app icons (`9ea43db`) |
| 5 | Apr 18 | Ops | Dashboard not auto-refreshing when tab backgrounded | ✅ Manual ⟳ refresh button in topbar (`9599814`); 60s auto-refresh retained. |
| 6 | Apr 18 | Track 1 | Inventory Grand Total available = -177,333 bags | ✅ Clamped aggregate to `max(0, ...)`; per-plant/region keep negatives (`00045-guw`) |
| 7 | Apr 18 | Track 1 | `on_production = 0` placeholder | ✅ OWOR `Status='R'` + `DueDate >= -30d` query; split into real/stale with gold badge on card (`00047-yar`). All current WOs are "real" — stale_count = 0. |
| 8 | Apr 18 | Track 1 | Customer Detail monthly volume chart blank | ✅ API returns `cy_vs_ly` object (not array); frontend was treating as array → guard failed. Rewrote to destroy+recreate from `{months,cy_vol,ly_vol}` shape. |
| 9 | Apr 18 | Track 1 | Customer Detail monthly breakdown SALES CY = ₱0 | ✅ Frontend read `m.sales_cy`, API returns `m.sales`. Fallback chain. |
| 10 | Apr 18 | Track 1 | Speed chart title "Last 14 Days" hardcoded | ✅ Dynamic per period via `#speed-daily-title`. |
| 11 | Apr 18 | Track 1 | Customers page appeared empty | ✅ Root cause was stale browser cache; current app.html renders 100 / 1382 customers with region/BU/gm-ton populated. |
| 12 | Apr 18 | Track 2 | No SOA generation for AR | ✅ `api/customer-soa.js` + PDF (jsPDF) + Excel (xlsx-js-style) modal from `pg-custdetail` (`00049-fof`). |
| 13 | Apr 18 | Track 2 | No global search | ✅ `api/search.js` + topbar dropdown with debounce + keyboard nav. v1 is customer-only. |
| 14 | Apr 18 | Track 2 | Inventory could not drill by region/plant | ✅ Client-side filter with URL-hash persistence. |
| 15 | Apr 18 | Track 3 | Home Monthly/Quarterly Performance charts rendered mock data | ✅ Added `/api/dashboard.monthly_perf[7]` + `quarterly_perf[4]` from OINV; `renderHomeCombos(apiData)` wired in `loadHome()` (`00051-roq`). LY bars remain 0 until 2025 data loaded. |
| 16 | Apr 18 | Track 3 | Home Volume 7.6K vs Speed 8.1K discrepancy confused users | ✅ Dashboard audit confirmed OINV-only; added "(INVOICED)" tag + tooltip to Volume KPI. |

---

## 11 · Gap Analysis — Working vs Hardcoded

### ✅ Fully working (API-wired, real SAP data)

| Page / Feature | Evidence |
|---|---|
| Home KPI row × 7 | loadHome → /api/dashboard, animateNumber, deltas |
| Home Region Performance | region_performance[] sorted vol desc |
| Home BU Split | derived from /api/dashboard |
| Home Top Customers (MTD) | top_customers[] × 5 |
| Home Monthly Performance chart | monthly_perf[7] (Apr 18 fix) |
| Home Quarterly Performance chart | quarterly_perf[4] (Apr 18 fix) |
| Sales 6 KPIs + brand chart + top customers + GM/T + monthly trend + Pending PO (5 tabs) | sales.kpis + pending_po full sub-object |
| AR aging buckets + client list + search + bucket-tap filter | /api/ar |
| AR SOA button → PDF + Excel | /api/customer/soa (Track 2) |
| Inventory 6 KPIs + all 4 sub-tables | /api/inventory (with ON PRODUCTION fix Track 1) |
| Inventory Region/Plant drill + URL hash (Track 2) | INV_FILTER state + loadInvFromHash |
| Speed hero + 5 KPIs + daily chart (dynamic title) + weekly matrix + plant breakdown + RSM + feed type | /api/speed + holiday calendar |
| Customers table (1,382 rows) with region/BU/gm-ton/status | /api/customers |
| Customer Detail hero + 8 KPIs + CY vs LY chart + monthly table + product breakdown + AR invoices + recent orders + 4 derived insight cards | /api/customer + client-side derivation |
| Margin hero + 6 dimension tables | /api/margin |
| Team EVP hero + RSM table + silent + negative-margin tables | /api/team |
| Itemized Sales district × SKU matrix + Excel export | /api/itemized |
| Global search top-bar dropdown | /api/search (Track 2) |
| Topbar period / compare / unit / refresh ⟳ / theme / clock / shield logo | Established |
| PWA install + favicon + shield logo | manifest.webmanifest + assets/ |

### 🟡 Partially wired (live data but gaps)

| Feature | Gap |
|---|---|
| `vs LY` deltas everywhere | Returns 0 / "—" because no 2025 OINV in DB. Works the day data is backfilled. |
| Home region `vs_pp` | Shows -47% to -65% — math correct, compares mid-period to full prior month (optics bug, not data bug). |
| Margin by_sales_group HOGS | Undercounted because ItemName regex misses VIEPRO PREMIUM variants lacking "HOG". |
| Margin by_bu | Only DIST vs PET — no KA classifier (no `OCRD.U_BU` field). |
| Team RSM `ytd_vol` | Low (e.g. MART=15 MT) because `SlpCode → RSM` fuzzy match broken. Needs Mat's mapping. |
| Team RSM `ytd_target` / `ach_pct` | Placeholders (0). Requires RSM→budget linkage. |
| Customer Intelligence (`pg-insights`) | **Under rebuild by Agent-Intelligence** — current state: SKU matrix all zeros, reorder line is plain text, 268 dormants buried, no clickable names. |

### 🔴 Hardcoded prototype remnants

| Location | What's fake | Blocker |
|---|---|---|
| Home **ticker** (`<div class="ticker">`) | "25 customers over credit limit ₱763.8M", "8 critical silent", "3 negative margins", "MTD 14,200 MT" — all literal strings | No endpoint for headline insights. Low priority (cosmetic). |
| Home **SPEED KPI tile badge counters** ("● 3 Critical · 7 Warning · 19 Watch · 331 Healthy") | Hardcoded numbers in HTML | Hook to `/api/dashboard.margin_alerts` — small win. |
| **Team L10 scorecard** | Static per MEGA spec rule E — decision was to keep hardcoded | Intentional. |
| **Team DSM sub-rows** | Wiped on loader render; only RSM rows populate | No DSM hierarchy in API. Needs Mat's mapping. |
| Customer Detail **Sales/GM trend line chart** (`#custSalesGmChart`) | Empty canvas, never initialised | Low priority — volume chart covers same insight. |
| Speed **sparkline** (`#speedSparkline`) | Empty canvas | Low priority cosmetic. |
| Sales page **sales trend bar chart** | Hardcoded Luzon/Visayas/Mindanao monthly mock (lines 5641-5644) | Not yet wired to `/api/sales.monthly_trend`. |
| `loadCust` **prototype rows** in HTML (Metro Feeds Corp, Cebu Agri, etc.) | Visible only on first paint before JS hydrates | Benign — replaced by real rows on mount. |

### ⛔ Deferred / decisions made

- `/api/l10` endpoint (keep static — spec decision)
- `/api/customer-insights` AI endpoint (replaced by client-side derived cards)
- OITW on_production via OWOR/WOR1 — **now shipped** (Track 1 Bug 2)
- Region filter pills on Customers — `fltCust()` passes `region=` correctly as of Sprint 2D
- 2025 SAP backfill — external ask to Finance team
- RBAC enforcement — pending Mat's RSM→region mapping

---

## Appendix A · File Map

```
vieforce-hq/
├── CLAUDE.md                         project brief (v1 plan, ref only)
├── package.json                      deps: express, mssql, supabase-js, cors, dotenv
├── server.js                         Express mount of all api/*.js handlers
├── Dockerfile                        node:20-slim → `node server.js`
├── vercel.json                       security headers only (CSP frame-options etc.)
├── manifest.webmanifest              PWA install
├── .vercelignore                     excludes api/, scripts/, docs/, *.md
├── index.html                        Login screen
├── app.html                          Single-page app (~6000 lines, all pages)
├── css/hq.css                        extracted CSS (light use — most styles inline in app.html)
├── js/
│   ├── supabase.js                   client init
│   ├── auth.js                       login / logout / getSession / requireAuth
│   └── api.js                        apiFetch + per-endpoint wrappers + getCustomerSOA + searchGlobal
├── api/
│   ├── _auth.js                      verifySession + getPeriodDates + applyRoleFilter
│   ├── _db.js                        mssql pool
│   ├── dashboard.js  sales.js  ar.js  inventory.js  speed.js
│   ├── customers.js  customer.js  customer-soa.js  search.js
│   ├── margin.js     intelligence.js  team.js  budget.js
│   ├── itemized.js   itemized-meta.js  diag.js
│   ├── data/
│   │   ├── shipping_calendar_ph.json  (Sundays + PH 2025/2026 holidays)
│   │   ├── district_list.json         (47 districts for itemized)
│   │   ├── district_managers.json
│   │   └── product_hierarchy.json     (224 FG SKUs)
│   └── lib/
│       └── shipping_days.js          countShippingDays, getPeriodBounds, getManilaToday
├── lib/cache.js                      Map-based TTL cache
├── assets/                           shield logo + PWA icons + favicon
└── docs/
    ├── reference/                    (existing)
    └── HQ_ARCHITECTURE_SCOUT.md      (this file)
```

---

## Appendix B · Key Dates / Session Artefacts

| Date | Commit | Revision | Milestone |
|---|---|---|---|
| Apr 16 | — | 00019-foq | Prior prod before design-upgrade merged |
| Apr 17 AM | `48ce3c7` | 00031-jud | Dynamic Daily Pullout + 4 anim layers |
| Apr 17 PM | `a41c949` → `bdd27d6` | 00037-xol / 00038-lir | MEGA_FIX Sprint 1+2 (46% → 82%) |
| Apr 17 PM | `c75d37f` / `47378b3` / `ccec42a` | 00038-lir | Production deploy |
| Apr 17 evening | `bca63bc` / `232f64f` | 00042-wis | Speed chart fix + 5am cutoff |
| Apr 17 evening | `9ea43db` | — | Shield logo + favicon + PWA manifest |
| Apr 18 | `bfe84e7` | 00044-beg | PH shipping calendar (awaiting Mat confirmation) |
| Apr 18 | `63cc7ce` | 00045-guw | Track 1 bug fixes |
| Apr 18 | `7afaad6` | 00047-yar | OWOR real/stale split |
| Apr 18 | `7686bac` / `c9bd190` | 00049-fof | Track 2 (SOA + search + drill) |
| Apr 18 | `9599814` | — | Topbar refresh button |
| Apr 18 | `ec7aca0` / `fdb061e` | **00051-roq** | Track 3 — Home OINV audit + monthly/quarterly charts wired |

---

*End of scout report — 2026-04-18*
