# WIRING REPORT — Frontend Swap & Data Wiring

**Date:** 2026-04-16
**Agent:** Agent 2 — Frontend Swap + Data Wiring

---

## Step 1 — Backups

| File | Backup |
|------|--------|
| `app.html` | `app.html.backup` (622 lines, old wired version) |
| `index.html` | `index.html.backup` (231 lines, login page) |

---

## Step 2 — Frontend Swap

- `vieforce-hq-desktop.html` (3287 lines, Montserrat/Source Code Pro fonts, Vienovo brand colors, light/dark theme) copied to `app.html`
- Mock login overlay **removed** — auth handled by `index.html` → Supabase PIN login → redirect to `app.html`
- Supabase CDN script added to `<head>`
- `js/supabase.js`, `js/auth.js`, `js/api.js` scripts included before main `<script>` block
- Auth gate (`requireAuth()`) added — redirects to `index.html` if no valid session
- Vercel routing (`vercel.json`) unchanged — `app.html` remains at same path

---

## Step 3 — Pages Wired to Live Data

| Page | Endpoint(s) | Status |
|------|-------------|--------|
| **Home** (`pg-home`) | `GET /api/dashboard` + `GET /api/sales` + `GET /api/ar` + `GET /api/speed` | WIRED — data fetched, logged to console |
| **Sales** (`pg-sales`) | `GET /api/sales` | WIRED — data fetched, logged to console |
| **Accounts Receivable** (`pg-ar`) | `GET /api/ar` | WIRED — data fetched, logged to console |
| **Inventory** (`pg-inv`) | `GET /api/inventory` | WIRED — data fetched, logged to console |
| **Speed Monitor** (`pg-speed`) | `GET /api/speed` | WIRED — data fetched, logged to console |
| **Customers** (`pg-customers`) | `GET /api/customers` | WIRED — data fetched, filter buttons wired, search wired |
| **Customer Detail** (`pg-custdetail`) | `GET /api/customer?id=` | WIRED — `openCust(code)` function calls API |

---

## Step 4 — Pages Still Using Mock Data

| Page | Mock Comment | Needed Endpoint |
|------|-------------|----------------|
| **Margin Alerts** (`pg-margin`) | `<!-- MOCK: needs /api/margin endpoint -->` | `GET /api/margin` — GP analysis by customer, region, brand, plant |
| **Customer Intelligence** (`pg-insights`) | `<!-- MOCK: needs /api/intelligence endpoint -->` | `GET /api/intelligence` — whitespace, buying patterns, health scores |
| **Sales Team** (`pg-team`) | `<!-- MOCK: needs /api/team endpoint -->` | `GET /api/team` — OSLP-based RSM/DSM scorecard, L10 matrix |
| **Budget & P&L** (`pg-budget`) | `<!-- MOCK: needs /api/budget endpoint -->` | `GET /api/budget` — FY26 budget vs actual, P&L breakdown |
| **Sales Pivot** (sidebar nav only) | No page built | `GET /api/sales-pivot` |
| **Customer Plotting** (sidebar nav only) | No page built | `GET /api/customer-plotting` |
| **Itemized Sales** (sidebar nav only) | No page built | `GET /api/itemized-sales` |

---

## Step 5 — API Shape Observations

### Known field mappings (from working `app.html.backup`):

| Endpoint | API Returns | UI Expects |
|----------|-------------|------------|
| `/api/dashboard` | `revenue, volume_mt, volume_bags, gross_margin, gmt, gm_per_bag, ar_balance` | Matches — used in old app |
| `/api/sales` | `top_customers[{customer_code, customer_name, volume_mt, volume_bags, revenue}], by_brand[{brand, volume_mt, revenue, gmt}], monthly_trend[{month, volume_mt, volume_bags, revenue}]` | Matches — used in old app |
| `/api/ar` | `total_balance, dso, buckets{current, d1_30, d31_60, d61_90, d90plus}, clients[{CardCode, CardName, balance, days_overdue, bucket}]` | Matches — used in old app |
| `/api/inventory` | `plants[{plant_code, plant_name, total_on_hand, total_committed, total_on_order, total_available}]` | Matches — used in old app |
| `/api/speed` | `actual_mt, speed_per_day, projected_mt, target_mt, pct_of_target, elapsed_days, total_days, remaining_days, daily[{ship_date, daily_mt, day_name}]` | Matches — used in old app |
| `/api/customers` | `total, customers[{CardCode, CardName, ytd_volume, ytd_bags, ytd_revenue, last_order_date}]` | Matches — used in old app |
| `/api/customer?id=` | `info{CardCode, CardName, City, rsm, Phone1}, ytd_sales{volume, revenue, orders_count}, ar_invoices[], product_breakdown[], recent_orders[]` | Matches — used in old app |

### Potential mismatches in new prototype UI:

The new prototype displays richer data than the API currently returns:

1. **Home page** — Prototype shows 7 KPIs (Net Sales, Volume, GM, GM/T, DSO, Speed, **Pending PO**). API has no pending PO data.
2. **Home page** — Region performance table, BU Split card, Budget vs Actual strip — none available from current endpoints.
3. **Sales page** — GM/T monthly matrix (7 months × 9 product groups) — not returned by `/api/sales`.
4. **Sales page** — 4-panel volume rankings by brand/product/customer/district with vs Y-1 — partially covered by `by_brand` and `top_customers`.
5. **Sales page** — Pending PO section — no endpoint.
6. **Speed page** — Hero banner with average pullout/speed, weekly/plant matrices, RSM speed table, brand speed table — API returns summary but not breakdowns.
7. **Inventory page** — By region, by plant, by sales group, by product (SKU-level) — API returns `plants[]` only.
8. **Customer Detail** — 8 KPIs, AI insight cards, CY vs LY chart, monthly breakdown table, account info — API returns basic profile.

---

## Features Added

- **Auth gate** — `requireAuth()` redirects to login if session expired/missing
- **x-session-id header** — sent on every API call via `js/api.js` `getApiHeaders()`
- **Theme toggle** — persists to `localStorage('vf_theme')`, restores on page load
- **Auto-refresh** — every 60 seconds, clears cache and reloads current page data
- **Period selector** — 7D/MTD/QTD/YTD buttons wired to `setPd()`, triggers API refetch
- **Customer search** — Enter key in global search triggers customer search API
- **Customer filter** — Region filter buttons (All/Luzon/Visayas/Mindanao) wired to API
- **Clock** — Live clock in topbar, updates every second

---

## Files Modified

| File | Change |
|------|--------|
| `app.html` | **Replaced** with prototype design + API wiring |
| `app.html.backup` | Backup of previous working version |
| `index.html.backup` | Backup of login page (unchanged) |

## Files NOT Modified

- `api/*` — All API handlers untouched
- `api/_db.js` — MSSQL connection untouched
- `js/api.js` — API client untouched
- `js/auth.js` — Auth module untouched
- `js/supabase.js` — Supabase client untouched
- `vercel.json` — Routing config untouched
- `server.js` — Express server untouched
- `index.html` — Login page untouched

---

## Next Steps for Agent 3

Build the missing API endpoints marked `<!-- MOCK -->`:

1. `GET /api/margin` — GM analysis with GP% by customer, region, brand, plant, SKU
2. `GET /api/intelligence` — Customer health scores, buying patterns, whitespace analysis
3. `GET /api/team` — OSLP-based RSM/DSM performance scorecard
4. `GET /api/budget` — FY26 budget vs actual, P&L breakdown
5. Enrich existing endpoints to return all fields the prototype UI expects (delta %, vs PP/LY, region breakdowns, pending PO)
