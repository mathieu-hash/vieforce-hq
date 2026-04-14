# VieForce HQ — Master Project Plan
## Claude Code Project Brief · Vienovo Philippines Inc.

---

## 1. PROJECT OVERVIEW

**Product:** VieForce HQ — Sales Intelligence & BI Dashboard
**Company:** Vienovo Philippines Inc. (VPI) — Animal feed manufacturer, Philippines
**Purpose:** Real-time sales, AR, inventory, and speed intelligence dashboard for CEO, EVP, RSM, and DSM roles. Pulls live data directly from SAP B1 (Microsoft SQL Server). Field visit data from VieForce Patrol (Supabase) will be integrated in Phase 2 (CRM 360° merge).

**Current State:**
- Working HTML prototype: `vieforce-hq-desktop.html` — single file, hardcoded mock data
- Deployed separately on Vercel
- No backend, no real data connection

**Goal:** Connect prototype to live SAP B1 data via Vercel Serverless Functions (Node.js). Keep existing UI/UX intact. Add real auth, role-based data filtering, and live KPIs.

---

## 2. SAP B1 CONNECTION

```
Host:     analytics.vienovo.ph
Port:     4444
Database: Vienovo_Live
User:     gsheet
Password: [SET VIA VERCEL ENV — never hardcode]
Type:     Microsoft SQL Server (mssql)
```

**CRITICAL SECURITY RULES:**
- Never hardcode credentials in any file
- All credentials via Vercel environment variables only
- Create a dedicated read-only SQL user for HQ before go-live (do not use `gsheet` in production)
- Never commit `.env` to git

**Node.js driver:** `mssql` npm package
```javascript
const sql = require('mssql')
const config = {
  server:   process.env.SAP_HOST,
  port:     parseInt(process.env.SAP_PORT),
  database: process.env.SAP_DB,
  user:     process.env.SAP_USER,
  password: process.env.SAP_PASS,
  options: {
    encrypt: false,           // internal network, no TLS required
    trustServerCertificate: true,
    connectionTimeout: 15000,
    requestTimeout: 30000
  },
  pool: {
    max: 10, min: 0, idleTimeoutMillis: 30000
  }
}
```

---

## 3. TECH STACK

```
Frontend:   Vanilla HTML/CSS/JS (existing prototype — do NOT migrate to React)
            Fetch API for all data calls
            Chart.js (already in prototype)

Backend:    Vercel Serverless Functions (/api/* routes)
            Node.js + mssql driver
            Response caching (Vercel Edge Cache)

Auth:       Supabase (shared with Patrol — same users table)
            PIN-based login via Supabase Edge Function verify-pin
            JWT session stored in localStorage

Database:   SAP B1 — Microsoft SQL Server
            Database: Vienovo_Live
            Read-only queries only — NO INSERT/UPDATE/DELETE ever

Hosting:    Vercel
```

**Environment Variables (Vercel Dashboard → Settings → Environment Variables):**
```
SAP_HOST=analytics.vienovo.ph
SAP_PORT=4444
SAP_DB=Vienovo_Live
SAP_USER=gsheet
SAP_PASS=340$Uuxwp7Mcxo7Khy
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

---

## 4. REPO STRUCTURE

```
vieforce-hq/
├── CLAUDE.md                     ← this file
├── .env.local                    ← local dev only, git-ignored
├── .gitignore                    ← must include .env*
├── vercel.json                   ← routing config
├── package.json                  ← mssql, @supabase/supabase-js
├── index.html                    ← login screen
├── app.html                      ← main dashboard (from prototype)
├── js/
│   ├── supabase.js               ← Supabase client (shared config)
│   ├── auth.js                   ← login, session, requireAuth
│   ├── api.js                    ← all fetch() calls to /api/*
│   └── charts.js                 ← Chart.js chart init functions
├── css/
│   └── hq.css                    ← extracted from prototype
├── api/                          ← Vercel Serverless Functions
│   ├── _db.js                    ← shared MSSQL connection pool
│   ├── sales.js                  ← GET /api/sales
│   ├── ar.js                     ← GET /api/ar
│   ├── inventory.js              ← GET /api/inventory
│   ├── speed.js                  ← GET /api/speed
│   ├── customers.js              ← GET /api/customers
│   ├── customer.js               ← GET /api/customer?id=
│   └── dashboard.js              ← GET /api/dashboard (home KPIs)
└── lib/
    └── cache.js                  ← simple in-memory cache layer
```

---

## 5. VERCEL CONFIGURATION

### `vercel.json`
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" }
  ],
  "functions": {
    "api/*.js": {
      "memory": 512,
      "maxDuration": 30
    }
  }
}
```

### `package.json`
```json
{
  "name": "vieforce-hq",
  "version": "1.0.0",
  "dependencies": {
    "mssql": "^10.0.1",
    "@supabase/supabase-js": "^2.39.0"
  }
}
```

---

## 6. SHARED DB CONNECTION — `api/_db.js`

```javascript
const sql = require('mssql')

const config = {
  server:   process.env.SAP_HOST,
  port:     parseInt(process.env.SAP_PORT) || 4444,
  database: process.env.SAP_DB,
  user:     process.env.SAP_USER,
  password: process.env.SAP_PASS,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15000,
    requestTimeout: 30000
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
}

let pool = null

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config)
  }
  return pool
}

async function query(sqlText, params = {}) {
  const p = await getPool()
  const request = p.request()
  Object.entries(params).forEach(([k, v]) => request.input(k, v))
  const result = await request.query(sqlText)
  return result.recordset
}

module.exports = { query, sql }
```

---

## 7. API ENDPOINTS & SAP B1 SQL QUERIES

All endpoints:
- Accept `GET` only
- Read query params: `period` (MTD/QTD/YTD/7D), `region`, `role`, `user_id`
- Return JSON
- Cache responses for 5 minutes (SAP data doesn't need sub-minute refresh)
- Require valid session token in `Authorization` header

### 7.1 `api/dashboard.js` — Home KPIs

```javascript
// GET /api/dashboard?period=MTD&region=ALL
// Returns: MTD sales, volume, AR balance, GM/T, speed projection

const { query } = require('./_db')

module.exports = async (req, res) => {
  // Auth check (see Section 8)
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { period = 'MTD', region = 'ALL' } = req.query
  const { dateFrom, dateTo } = getPeriodDates(period)
  const regionFilter = region === 'ALL' ? '' : `AND T0.U_Region = @region`

  const kpis = await query(`
    SELECT
      SUM(T1.LineTotal)                           AS revenue,
      SUM(T1.Quantity)                            AS volume_mt,
      AVG(T1.GrossProfit / NULLIF(T1.Quantity,0)) AS gmt
    FROM OINV T0
    INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
    WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo
      AND T0.CANCELED = 'N'
      ${regionFilter}
  `, { dateFrom, dateTo, region })

  const arBalance = await query(`
    SELECT SUM(T0.DocTotal - T0.PaidToDate) AS ar_balance
    FROM OINV T0
    WHERE T0.CANCELED = 'N'
      AND T0.DocTotal > T0.PaidToDate
  `)

  res.json({
    revenue:    kpis[0]?.revenue || 0,
    volume_mt:  kpis[0]?.volume_mt || 0,
    gmt:        kpis[0]?.gmt || 0,
    ar_balance: arBalance[0]?.ar_balance || 0
  })
}
```

### 7.2 `api/sales.js` — Sales Intelligence

```javascript
// GET /api/sales?period=MTD&region=ALL&groupBy=brand|customer|district|category

// Key queries:

// Volume + Revenue by Brand
SELECT
  T1.Dscription  AS brand,
  T1.ItemCode    AS sku,
  SUM(T1.Quantity)   AS volume_mt,
  SUM(T1.LineTotal)  AS revenue,
  SUM(T1.GrossProfit / NULLIF(T1.Quantity,0)) AS gmt
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo
  AND T0.CANCELED = 'N'
GROUP BY T1.Dscription, T1.ItemCode
ORDER BY volume_mt DESC

// Top customers ranking
SELECT TOP 20
  T0.CardCode    AS customer_code,
  T0.CardName    AS customer_name,
  SUM(T1.Quantity)   AS volume_mt,
  SUM(T1.LineTotal)  AS revenue
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo
  AND T0.CANCELED = 'N'
GROUP BY T0.CardCode, T0.CardName
ORDER BY volume_mt DESC

// Monthly trend (last 12 months)
SELECT
  FORMAT(T0.DocDate, 'yyyy-MM') AS month,
  SUM(T1.Quantity)              AS volume_mt,
  SUM(T1.LineTotal)             AS revenue
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
WHERE T0.DocDate >= DATEADD(MONTH, -12, GETDATE())
  AND T0.CANCELED = 'N'
GROUP BY FORMAT(T0.DocDate, 'yyyy-MM')
ORDER BY month ASC
```

### 7.3 `api/ar.js` — Accounts Receivable

```javascript
// GET /api/ar?region=ALL

// AR aging buckets
SELECT
  T0.CardCode,
  T0.CardName,
  T0.DocTotal - T0.PaidToDate      AS balance,
  DATEDIFF(DAY, T0.DocDueDate, GETDATE()) AS days_overdue,
  CASE
    WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) <= 0  THEN 'current'
    WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) <= 30 THEN '1_30'
    WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) <= 60 THEN '31_60'
    WHEN DATEDIFF(DAY, T0.DocDueDate, GETDATE()) <= 90 THEN '61_90'
    ELSE '90plus'
  END AS bucket,
  T0.SlpName AS rsm
FROM OINV T0
WHERE T0.CANCELED = 'N'
  AND T0.DocTotal > T0.PaidToDate
ORDER BY days_overdue DESC

// DSO calculation
SELECT
  SUM(T0.DocTotal - T0.PaidToDate) /
  NULLIF(SUM(T0.DocTotal) / 365.0, 0) AS dso
FROM OINV T0
WHERE T0.CANCELED = 'N'
  AND T0.DocDate >= DATEADD(YEAR, -1, GETDATE())
```

### 7.4 `api/inventory.js` — Inventory by Plant

```javascript
// GET /api/inventory?plant=ALL

// Stock by plant (warehouse)
SELECT
  T0.WhsCode  AS plant_code,
  T0.WhsName  AS plant_name,
  T1.ItemCode AS sku,
  T1.ItemName AS product,
  T0.OnHand   AS qty_on_hand,
  T0.IsCommited AS qty_committed,
  T0.OnOrder  AS qty_on_order,
  T0.OnHand - T0.IsCommited AS qty_available
FROM OWHS T0
INNER JOIN OITW T1 ON T0.WhsCode = T1.WhsCode  -- corrected join
-- Note: adjust table/column names to match your exact SAP B1 schema
WHERE T0.Inactive = 'N'
ORDER BY T0.WhsCode, T1.ItemCode
```

### 7.5 `api/speed.js` — Sales Speed (Run-Rate Projection)

```javascript
// GET /api/speed?period=MTD
// Speed = (Actual MT ÷ elapsed Mon–Sat workdays) × total Mon–Sat workdays in period

// Actual MT this period
SELECT SUM(T1.Quantity) AS actual_mt
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
WHERE T0.DocDate BETWEEN @monthStart AND @today
  AND T0.CANCELED = 'N'

// Target is stored in env var or config table
// Workday calculation done in JS (not SQL)
```

### 7.6 `api/customers.js` + `api/customer.js`

```javascript
// GET /api/customers?search=&region=&status=
// Returns paginated customer list with AR status

SELECT
  T0.CardCode,
  T0.CardName,
  T0.Phone1,
  T0.City,
  T0.SlpName   AS rsm,
  SUM(T1.LineTotal)  AS ytd_revenue,
  SUM(T1.Quantity)   AS ytd_mt,
  MAX(T0.DocDate)    AS last_order_date
FROM OCRD T0
LEFT JOIN OINV TI ON TI.CardCode = T0.CardCode
  AND TI.DocDate >= DATEADD(YEAR, -1, GETDATE())
  AND TI.CANCELED = 'N'
LEFT JOIN INV1 T1 ON T1.DocEntry = TI.DocEntry
WHERE T0.CardType = 'C'
GROUP BY T0.CardCode, T0.CardName, T0.Phone1, T0.City, T0.SlpName
ORDER BY ytd_revenue DESC

// GET /api/customer?id=C-0041
// Full customer profile: orders, AR invoices, product breakdown
```

---

## 8. AUTH MIDDLEWARE

All `/api/*` functions import and call this before running queries:

```javascript
// api/_auth.js
const { createClient } = require('@supabase/supabase-js')

async function verifySession(req) {
  const token = req.headers['x-session-id']
  if (!token) return null

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  )

  // Validate session ID against Supabase users table
  const { data: user } = await supabase
    .from('users')
    .select('id, name, role, region, district, territory')
    .eq('id', token)
    .eq('is_active', true)
    .single()

  return user || null
}

function getPeriodDates(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()

  switch(period) {
    case '7D':  return { dateFrom: new Date(y,m,d-7), dateTo: now }
    case 'MTD': return { dateFrom: new Date(y,m,1),   dateTo: now }
    case 'QTD': return { dateFrom: new Date(y, Math.floor(m/3)*3, 1), dateTo: now }
    case 'YTD': return { dateFrom: new Date(y,0,1),   dateTo: now }
    default:    return { dateFrom: new Date(y,m,1),   dateTo: now }
  }
}

module.exports = { verifySession, getPeriodDates }
```

---

## 9. FRONTEND API CLIENT — `js/api.js`

```javascript
// All dashboard data calls go through this module

const BASE = '/api'

function getHeaders() {
  const session = JSON.parse(localStorage.getItem('vf_session') || '{}')
  return {
    'Content-Type': 'application/json',
    'x-session-id': session.id || ''
  }
}

async function apiFetch(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}/${endpoint}${qs ? '?' + qs : ''}`
  const res = await fetch(url, { headers: getHeaders() })
  if (res.status === 401) { logout(); return null }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// Named exports used by dashboard screens
export const getDashboard  = (p) => apiFetch('dashboard',  p)
export const getSales      = (p) => apiFetch('sales',      p)
export const getAR         = (p) => apiFetch('ar',         p)
export const getInventory  = (p) => apiFetch('inventory',  p)
export const getSpeed      = (p) => apiFetch('speed',      p)
export const getCustomers  = (p) => apiFetch('customers',  p)
export const getCustomer   = (p) => apiFetch('customer',   p)
```

---

## 10. CACHING STRATEGY — `lib/cache.js`

SAP B1 is not a real-time system. Cache aggressively to protect the DB.

```javascript
// Simple in-memory cache for Vercel serverless
// Note: each Vercel function instance has its own memory
// For production scale, replace with Vercel KV or Redis

const store = new Map()

function get(key) {
  const item = store.get(key)
  if (!item) return null
  if (Date.now() > item.expiry) { store.delete(key); return null }
  return item.value
}

function set(key, value, ttlSeconds = 300) {
  store.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 })
}

module.exports = { get, set }
```

**Cache TTLs by endpoint:**
```
/api/dashboard   → 5 min   (KPIs)
/api/sales       → 5 min
/api/ar          → 10 min  (AR doesn't change by the minute)
/api/inventory   → 15 min
/api/speed       → 5 min
/api/customers   → 10 min
/api/customer    → 5 min
```

---

## 11. ROLE-BASED DATA FILTERING

Every API endpoint filters data based on the session role:

```javascript
function applyRoleFilter(session, baseQuery) {
  switch(session.role) {
    case 'ceo':
    case 'evp':
    case 'admin':
      return baseQuery  // no filter — all regions

    case 'rsm':
      // Filter by RSM's region
      return baseQuery + ` AND T0.U_Region = '${session.region}'`

    case 'dsm':
      // Filter by DSM's district / assigned sales person code
      return baseQuery + ` AND T0.SlpName = '${session.name}'`

    default:
      return baseQuery + ` AND 1=0`  // no data for unknown roles
  }
}
```

---

## 12. FRONTEND SCREENS TO WIRE UP

Replace all hardcoded mock data in the prototype with live API calls:

### Home / Dashboard
```javascript
// On page load:
const data = await getDashboard({ period: currentPeriod, region: currentRegion })
document.getElementById('kpi-revenue').textContent = formatCurrency(data.revenue)
document.getElementById('kpi-volume').textContent = formatNumber(data.volume_mt) + ' MT'
document.getElementById('kpi-ar').textContent = formatCurrency(data.ar_balance)
// Speed KPI: computed client-side using data.volume_mt + workday calc
```

### Sales Page
```javascript
const data = await getSales({ period, region, groupBy: 'brand' })
renderBrandChart(data.by_brand)
renderCustomerRankings(data.top_customers)
renderGMTTable(data.by_category)
renderMonthlyTrend(data.monthly_trend)
```

### AR / SOA Page
```javascript
const data = await getAR({ region })
renderAgingBuckets(data.buckets)
renderARChart(data.chart_data)
renderClientList(data.clients)  // filterable by search + bucket tap
```

### Customers Page + Client 360
```javascript
// List
const data = await getCustomers({ search, region })
renderClientList(data.customers)

// Profile (on tap)
const profile = await getCustomer({ id: cardCode })
renderClient360(profile)  // all 5 tabs: overview, AR, sales, visits, AI intel
```

### Speed Page
```javascript
const data = await getSpeed({ period: 'MTD' })
// data.actual_mt + client-side workday calc = projection
renderSpeedCard(data)
```

### Inventory Page
```javascript
const data = await getInventory({ plant: 'ALL' })
renderPlantCards(data.by_plant)
```

---

## 13. SAP B1 TABLE REFERENCE (Vienovo_Live)

Key tables used — verify exact column names against your schema:

```
OINV   → Sales invoices (header)
INV1   → Sales invoice lines (items)
OCRD   → Business partners (customers)
OITM   → Items / products master
OITW   → Item warehouse info (inventory by location)
OWHS   → Warehouses / plants
OSLP   → Sales persons (RSM/DSM mapping)
```

**IMPORTANT:** Before running any query, verify column names:
```sql
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'OINV'
ORDER BY ORDINAL_POSITION
```

---

## 14. BUILD ORDER (Claude Code execution sequence)

```
Phase 1 — Foundation
  [ ] 1.  npm init + install mssql, @supabase/supabase-js
  [ ] 2.  Create .env.local with SAP + Supabase credentials
  [ ] 3.  Create api/_db.js — MSSQL connection pool
  [ ] 4.  Create api/_auth.js — session verify + period utils
  [ ] 5.  Test DB connection: node -e "require('./api/_db').query('SELECT 1')"
  [ ] 6.  Create js/auth.js — reuse same Supabase PIN auth as Patrol
  [ ] 7.  Create js/api.js — fetch wrapper
  [ ] 8.  Wire login screen → auth → redirect to app.html

Phase 2 — Live Data, screen by screen
  [ ] 9.  api/dashboard.js → wire Home KPIs
  [ ] 10. api/sales.js → wire Sales page (brand chart, rankings, GM/T table)
  [ ] 11. api/ar.js → wire AR page (aging buckets, client list, search)
  [ ] 12. api/speed.js → wire Speed KPI on Home
  [ ] 13. api/customers.js + api/customer.js → wire Customers + Client 360
  [ ] 14. api/inventory.js → wire Inventory page

Phase 3 — Role filtering
  [ ] 15. Apply applyRoleFilter() to all endpoints
  [ ] 16. Test: login as DSM → only see own district data
  [ ] 17. Test: login as CEO → see all regions

Phase 4 — Performance
  [ ] 18. Add lib/cache.js to all endpoints
  [ ] 19. Add loading skeletons to all data sections
  [ ] 20. Add error states (SAP unreachable → show cached data)

Phase 5 — Beta
  [ ] 21. Deploy to Vercel
  [ ] 22. Test with Joel (EVP) + 2 RSMs
  [ ] 23. Verify all SAP column names match real data
  [ ] 24. Fix any query issues from real data validation
  [ ] 25. Create read-only SAP SQL user to replace gsheet
```

---

## 15. KEY DECISIONS & CONSTRAINTS

| Decision | Choice | Reason |
|---|---|---|
| Backend | Vercel Serverless Functions | No separate server, deploys with frontend, scales automatically |
| SQL driver | mssql (node-mssql) | Best MSSQL driver for Node.js, connection pooling built in |
| Auth | Shared Supabase users table with Patrol | Single user management, same PIN login across both apps |
| Caching | In-memory (Vercel) → Vercel KV later | Start simple, upgrade when needed |
| Data | Read-only SAP queries | Never write to SAP from HQ — read only, always |
| Framework | Vanilla JS | Keep prototype intact, fast load, no build step |
| Queries | Parameterized only | Prevent SQL injection — never string-concatenate user input into SQL |

---

## 16. NOTES FOR CLAUDE CODE

- **Preserve the existing UI/UX exactly.** The prototype design is approved. Do not redesign.
- **Vienovo brand colors:** Navy `#004D71`, Blue `#00A6CE`, Green `#95C93D`, Gold `#F1B11D`
- **Never write to SAP B1.** All SQL is SELECT only. No INSERT, UPDATE, DELETE, EXEC ever.
- **Always parameterize queries.** Never concatenate user input into SQL strings.
- **SAP table names are uppercase** (OINV, INV1, OCRD etc.) — match exactly.
- **Verify column names** against real schema before finalizing queries — SAP B1 column names vary by version and customization.
- **Test DB connection first** (Step 5) before building any API endpoints.
- **Role filter is mandatory** — a DSM must never see another district's data.
- **Credentials via env vars only** — never hardcode in any file.
- **The `gsheet` user** should be replaced with a dedicated read-only user before go-live.

---

## 17. FUTURE: CRM 360° MERGE (Phase 2)

When both Patrol and HQ are in beta, the merge into CRM 360° works as follows:

```
vienovo-crm360/
├── (Patrol frontend modules) → /js/patrol/*
├── (HQ frontend modules)     → /js/hq/*
├── (shared auth)             → /js/auth.js  (same Supabase users)
├── api/                      → all HQ Vercel functions (unchanged)
└── (unified shell)           → role-based nav renders correct modules

Data sources in CRM 360°:
  SAP B1    → sales, AR, inventory, customers (via HQ API layer)
  Supabase  → store visits, POS mapping, field activity (via Patrol)

Client 360° profile in merged app pulls from BOTH:
  → SAP: revenue, AR balance, invoices, product mix
  → Supabase: visit history, SOV, competitor intel, photos
```

The shared Supabase `users` table means **one login works across both apps and the merged app** — no migration needed.

---

*Document version: 1.0 · April 2026 · Vienovo Philippines Inc.*
*Prepared for Claude Code (VS Code extension) project initialization*
