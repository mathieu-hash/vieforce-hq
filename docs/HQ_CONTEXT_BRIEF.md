# VieForce HQ — Context Brief

**2026-04-18** · branch `design-upgrade` @ `2613013` · prod rev `vieforce-hq-api-00051-roq`

---

## 1 · Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS (single `app.html` + `index.html`, **no framework**, no build step). Chart.js 4.4.1 + chartjs-plugin-datalabels + xlsx-js-style + jsPDF loaded from CDN.
- **Backend:** Node.js 20 + Express 4 on **Google Cloud Run** (Docker, `asia-southeast1`, 512 MB / 30s). Each handler is a Vercel-style `module.exports = async (req, res) => {}` mounted in `server.js`.
- **Database:** **SAP Business One direct** — Microsoft SQL Server `Vienovo_Live` at `analytics.vienovo.ph:4444` via `mssql` pool (read-only). No BI cube, no replica. Session / user table in **Supabase** (separate Postgres).
- **Deployment:** Frontend on **Vercel** (static), API on **GCP Cloud Run**. Both deploy manually from `design-upgrade` branch (no CI). `.vercelignore` keeps Vercel under the 12-function Hobby limit (frontend-only there).

---

## 2 · Authentication

- **Login:** phone number + 6-digit PIN on `index.html`. No Google SSO, no email/password, no OAuth.
- **Users table:** Supabase `users` (shared with VieForce Patrol). Columns: `id, phone, pin_hash, name, role, region, district, territory, is_active`. `pin_hash` is currently plaintext comparison (spec debt).
- **Session:** localStorage `vf_session` = `{id, name, role, region, district, territory, expiresAt:+24h}`. Every API call sends `x-session-id: <user.id>` header. Server-side `verifySession()` re-queries Supabase per request. 24h client-side expiry; no server-side expiry enforcement.
- **RBAC:** **Scaffolded, NOT enforced.** `applyRoleFilter()` currently returns unfiltered WHERE for all authenticated roles (`admin/ceo/evp/rsm/dsm/tsr`). Region/district filtering pending Mat's RSM→region mapping. Until shipped, a DSM sees national data.

---

## 3 · Deployment URL

- **Production (testing here):** https://vieforce-hq.vercel.app
- **API canonical:** https://vieforce-hq-api-1057619753074.asia-southeast1.run.app
- **Test login:** phone `09170000100` (Rico Abante TSR, session `4bc1c7c0-213b-49cc-9b88-1730b2906bbd`)

---

## 4 · Navigation + Pages

SPA with client-side page toggles (no HTTP router). Routes below are the `navTo('pg-*')` anchors — all served from `/app.html`. Status reflects Apr 18 post-fixes state.

| Anchor | Purpose | Data source | Status |
|---|---|---|---|
| `pg-home`        | National dashboard: 7 KPIs, region perf, BU split, top customers, Monthly + Quarterly combo charts, ticker | `GET /api/dashboard` + `/api/sales` + `/api/ar` + `/api/speed` | 🟢 ~95% |
| `pg-sales`       | Sales KPIs, brand chart, top customers, GM/T, monthly trend, Pending PO (5 sub-tables) | `GET /api/sales` + `/api/speed` | 🟢 ~80% |
| `pg-ar`          | AR aging buckets + client list (search + bucket filter) + SOA generator (PDF/Excel) | `GET /api/ar` + `/api/customer/soa` | 🟢 ~95% |
| `pg-inv`         | Inventory: on-floor/PO/production/available KPIs, By Region, By Plant, By Sales Group, By Product, region/plant drill + URL-hash persistence | `GET /api/inventory` | 🟢 ~90% |
| `pg-speed`       | Shipping Speed Monitor: hero + 5 KPIs, Daily Pullout chart (dynamic title), 7-week × 14-plant matrix, plant/RSM/feed-type tables, PH holiday calendar | `GET /api/speed` | 🟢 ~95% |
| `pg-customers`   | Customer master: 1,382 rows · region / BU / volume / net sales / GM-ton / status badges, filter pills | `GET /api/customers` | 🟢 ~85% |
| `pg-custdetail`  | Customer 360: hero + 8 KPIs + CY vs LY bar + monthly breakdown + product breakdown + AR invoices + recent orders + 4 derived insight cards + SOA modal | `GET /api/customer?id=` | 🟢 ~85% |
| `pg-insights`    | Customer Intelligence (behavioral alerts, SKU penetration matrix, whitespace) | `GET /api/intelligence` | 🔴 under rebuild by Agent-Intelligence — SKU matrix all zeros, 268 dormants buried, no clickable names |
| `pg-margin`      | Margin Alerts: hero, warning table, 6 dimension tables (region/BU/sales group/brand/customer) | `GET /api/margin` | 🟡 ~80% — HOGS classifier undercounts, BU only DIST/PET |
| `pg-team`        | Sales Team: EVP hero, L10 scorecard (static), RSM table, silent / negative-margin tables | `GET /api/team` | 🟡 ~65% — RSM `ytd_vol` low (SlpCode→RSM broken), no DSM hierarchy |
| `pg-budget`      | Budget & P&L: FY2026 vs actuals, monthly, by region | `GET /api/budget` | 🟡 ~65% |
| `pg-itemized`    | District × SKU sales matrix (47 districts × 224 SKUs) with Excel export | `GET /api/itemized` + `/api/itemized/meta` | 🟢 ~85% |

**Cross-page features:** topbar period chips (7D/MTD/QTD/YTD), compare (vs PP / vs LY), unit (MT/Bags), global customer search dropdown (debounced, keyboard-nav), manual refresh button (⟳), theme toggle (dark/light), auto-refresh every 60s.

**Known empty shells (blocked by data/spec, not bugs):**
- `vs LY` deltas everywhere → 0 / "—" because no 2025 OINV in DB.
- Team DSM sub-rows → no DSM-level API (needs Mat's mapping).
- L10 scorecard → intentionally static per spec.
- Speed sparkline + Customer Detail Sales/GM trend line → empty canvases, low-priority cosmetic.
