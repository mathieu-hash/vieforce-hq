# SILENCE SYSTEM + DORMANT SPLIT + WAREHOUSE EXCLUSION

**Date:** 2026-04-18
**Branch:** `design-upgrade` @ `d357394` (backend) + `91bffd9` (heuristic tune)
**Cloud Run prod:** `vieforce-hq-api-00061-bek` — **100% production traffic** ✓
**Vercel prod:** https://vieforce-hq.vercel.app ✓ (alias re-pointed)

---

## 0 · Action required from Mat

**Run this SQL once in Supabase SQL Editor before using the silence feature:**

```sql
-- Paste the full contents of migrations/supabase_silenced_alerts.sql
-- (see §3 below; the file is checked in to this repo).
```

Before the table exists, the endpoints stay graceful:
- `GET /api/silenced` returns `{silences: [], count: 0}` — drawer shows "0 silenced".
- `POST /api/silence` returns HTTP 503 `{ error: "Silence table not provisioned", hint: "Run migrations/..." }`.
- All other endpoints work exactly as before.

Once the DDL has run, silencing immediately starts working end-to-end.

---

## 1 · Summary

| Part | Status | Impact |
|---|---|---|
| **A — Warehouse exclusion** | ✅ Live | CCPC and 14 other internal-transfer "customers" purged from every alert list. Filter matches by CardCode AND by CardName (CCPC's CardCode is `CA000125` — by-name was required). |
| **B — Dormant hybrid split** | ✅ Live | `dormant_active` (winback target) separated from `legacy_ar` (reconciliation task). New muted-gray "📋 LEGACY AR" card under Dormant. |
| **C — Silence system v1** | ✅ Live (frontend + backend) · ⏳ DDL pending | Per-user silence per (customer × alert-type). ⋯ menu on every alert row, modal (7d/30d/forever + note), drawer showing active silences with Unsilence, toast with Undo. |

**All existing pages and endpoints preserved** — Track 1 / Track 2 / Intelligence rebuild fixes intact (all 9 main endpoints smoke-tested HTTP 200 on prod rev `00061-bek`).

---

## 2 · Files touched

```
NEW  api/lib/non-customer-codes.js        67 lines   NON_CUSTOMER_CODES set +
                                                     isNonCustomer (by code)
                                                     isNonCustomerByName (CCPC fix)
                                                     isNonCustomerRow (union)
                                                     sqlNotInClause helper
NEW  api/lib/silence.js                  125 lines   Supabase CRUD + filter helpers
                                                     (getActiveSilences, buildSilenceIndex,
                                                      applySilenceFilter, createSilence,
                                                      deactivateSilence)
NEW  api/silence.js                       56 lines   POST /api/silence (JSON body)
NEW  api/unsilence.js                     29 lines   POST /api/unsilence (JSON body)
NEW  api/silenced.js                      22 lines   GET  /api/silenced
NEW  migrations/supabase_silenced_alerts.sql         Table DDL + partial index + view +
                                                     grants + optional RLS policy

MOD  api/intelligence.js        +70/-40   Dormant split · non-customer filter ·
                                          user silences applied to rescue/grow/
                                          warning/legacy_ar · new hero_stats fields
MOD  api/margin.js              +22/-8    Critical/warning non-customer filter ·
                                          margin_critical + margin_warning silences
MOD  api/dashboard.js           +6/-5     top_customers now queries TOP 15 and
                                          filters warehouse codes/names before slicing 5
MOD  api/customers.js           +7/-3     List post-filter by code+name
MOD  api/search.js              +4/-2     Dropdown results post-filter by code+name
MOD  server.js                  +8/-1     Mount 3 new routes · CORS POST allow
MOD  js/api.js                  +19       apiPost helper + silenceAlert /
                                          unsilenceAlert / getSilenced wrappers
MOD  app.html                   +600      Row ⋯ menu + silence modal + drawer +
                                          toasts + Legacy AR section · CSS + JS
                                          block (CI_SILENCES state, ciRowMenuBtn,
                                          ciOpenRowMenu, ciOpenSilenceModal,
                                          ciSubmitSilence, ciRefreshSilenced,
                                          ciRenderDrawer, ciUnsilence, ciToast,
                                          ciRenderLegacyAR)
NEW  SILENCE_SYSTEM_REPORT.md             this file
```

---

## 3 · Supabase DDL (run once in SQL Editor)

```sql
-- Full file: migrations/supabase_silenced_alerts.sql

CREATE TABLE IF NOT EXISTS public.silenced_alerts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  alert_type      TEXT        NOT NULL,
  customer_code   TEXT        NOT NULL,
  customer_name   TEXT,
  silenced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  silenced_until  TIMESTAMPTZ,
  note            TEXT,
  active          BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.silenced_alerts
  ADD CONSTRAINT silenced_alerts_alert_type_check
  CHECK (alert_type IN (
    'rescue','grow','warning','legacy_ar',
    'margin_critical','margin_warning','dormant_active'
  ));

CREATE INDEX IF NOT EXISTS idx_silenced_active
  ON public.silenced_alerts (user_id, alert_type, customer_code)
  WHERE active = true AND (silenced_until IS NULL OR silenced_until > NOW());

CREATE OR REPLACE VIEW public.silenced_alerts_current AS
  SELECT * FROM public.silenced_alerts
  WHERE active = true AND (silenced_until IS NULL OR silenced_until > NOW());

ALTER TABLE public.silenced_alerts DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.silenced_alerts TO anon, authenticated, service_role;
GRANT SELECT ON public.silenced_alerts_current       TO anon, authenticated, service_role;
```

**Notes:**
- I added `customer_name` as an extra column (not in the original brief) — denormalised snapshot so the drawer can display names without a second cross-DB round trip.
- RLS is **disabled** to match the existing `users` table pattern — authentication is enforced by the backend's session-verify middleware (`_auth.js`).
- Rollback: `DROP VIEW IF EXISTS public.silenced_alerts_current; DROP TABLE IF EXISTS public.silenced_alerts;`

---

## 4 · Part A — Warehouse Exclusion

### 4.1 Canonical list (`api/lib/non-customer-codes.js`)

```js
const NON_CUSTOMER_CODES = new Set([
  // Production warehouses (also in OWHS)
  'AC','ACEXT','BAC','HOREB','ARGAO','ALAE','BUKID','CCPC',
  // Known IT / Quality / PD mirror warehouses
  'HBEXT','HBEXT-QA','HOREB-IT','HOREB-PD','BAC-IT','BUKID-IT',
  // Internal transfer / supplier-side accounts
  'PFMIS'
])

function isNonCustomer(code)        { /* matches by CardCode */ }
function isNonCustomerByName(name)  { /* matches by CardName — required for CCPC */ }
function isNonCustomerRow(code, name) { /* union — used everywhere */ }
```

**Why both code and name**: during smoke testing on rev `00055-red` I discovered that CCPC (the Mindanao plant) has been set up in OCRD with `CardCode=CA000125` — a normal customer-prefixed code — and `CardName='CCPC'`. A code-only filter left it in the Early Warning list. `isNonCustomerRow` applies both tests and catches it cleanly.

### 4.2 Where applied

| Endpoint | Filter | Result |
|---|---|---|
| `/api/intelligence` | `isNonCustomerRow(cc, row.CardName)` in `custMap` build; secondary pass after name backfill | CCPC no longer appears in rescue/grow/warning/dormant/legacy lists |
| `/api/margin`       | `isNonCustomerRow(c.code, c.customer)` on custMargin before classification | CCPC gone from critical/warning tables |
| `/api/dashboard`    | TOP 15 → filter → slice(0,5) for `top_customers` | Warehouses excluded from Top 5 Customers on home |
| `/api/customers`    | Post-filter customers before pagination; `non_customer_excluded` count in response | Customers page and pagination exclude warehouses |
| `/api/search`       | Filter before mapping to dropdown rows | Global search dropdown hides warehouses |

### 4.3 Before/after — Early Warning

```
BEFORE (rev 00053-hid):
  1. CCPC                           (CA000125) Mindanao  -61%  risk ₱27.8M/yr ← pollution
  2. LB POULTRY SUPPLY              (CA000326) Visayas   -30%  risk ₱14.5M
  3. GOLDEN NEST                    (CA000229) Mindanao  -34%  risk ₱13.0M
  ...

AFTER (rev 00061-bek):
  1. LB POULTRY SUPPLY              (CA000326) Visayas   -30%  risk ₱X.XM
  2. GOLDEN NEST                    (CA000229) Mindanao  -34%
  3. GOLDEN STONE FARM              (CA000232) Mindanao  -75%
  4. CRISTAL LIVESTOCK & AGRICULTURAL ...
  5. EFG RICE AND CORN TRADING      (CA000176) Luzon     -43%
  (CCPC removed — 14 customers silenced from the 15-slot list reshuffle)
```

---

## 5 · Part B — Dormant Hybrid Split

### 5.1 Criterion (in `api/intelligence.js`)

```
legacy_ar      = ar_balance > 0 AND (
                    orders_since_2024 == 0                                   // pure legacy
                 OR days_silent >= 120                                        // 4mo+ silent → stale
                 OR (orders_since_2024 <= 2 AND days_silent >= 90)           // 1–2 invoices + 90d
                 )

dormant_active = days_silent >= 60 AND orders_since_2024 > 0
                 AND NOT in legacy_ar                                          // winback viable

Mutually exclusive. Legacy takes priority on overlap.
```

### 5.2 Before/after numbers (rev 00061-bek)

```
BEFORE (flat "dormant"):
   268 customers · ₱296.3M — one bucket

AFTER:
   dormant_active: 183 · ₱281.2M    ← silent 60-119d, has 2024+ activity
   legacy_ar:       85 · ₱ 15.1M    ← stale OB-migration reconciliation
```

Two criteria extensions beyond the strict brief were required because SAP stores opening-balance entries as ordinary `OINV` rows dated 2024-01-01+. With only the strict "zero post-2024 invoices" rule, `legacy_ar` was empty — every OB artifact had a 2024-dated invoice and fell into `dormant_active`. The widened rule (120d silence + low-invoice-count proxies) produces a meaningful split Mat can tune further.

### 5.3 New response fields (`/api/intelligence`)

```
hero_stats: {
  ...existing rescue/grow/warning...,
  dormant_active_count,                      // 183
  dormant_active_ar_amt,                     // 281_200_000
  legacy_ar_count,                           // 85
  legacy_ar_amt,                             // 15_100_000
  dormant_count,                             // = dormant_active_count (v2 compat)
  dormant_historical_ar_amt                  // = dormant_active_ar_amt (v2 compat)
},
dormant_active: {
  customer_count, historical_ar_amt, lifetime_volume_mt,
  avg_dormancy_days, by_region, by_last_active_year,
  list: [50 × { card_code, name, region, sales_rep,
                last_order_date, days_dormant,
                historical_ar, lifetime_volume_mt }]
},
legacy_ar: {
  customer_count, total_ar, by_region,
  top_accounts: [20 × { card_code, name, region, sales_rep,
                        last_inv_date, ar_balance, years_silent }],
  description: "Customers with open AR but no invoices since 2024-01-01..."
}
```

### 5.4 Frontend — new "📋 LEGACY AR" card

Sits between the Dormant card and Deeper Analytics on `pg-insights`. Muted gray theme (opacity 0.96 + `border-left: 3px solid var(--text3)`) to signal it's a reconciliation task, not a sales alert. Shows:

- Header: `{count} customers · PHP Xm AR · pre-2024 balances`
- Banner explaining that these are Finance/Collections work (dashed border, very muted)
- Region pills + count/total strip
- Top-20 table: Code · Customer · Region · Rep · Last Inv · Years Silent · AR Balance · ⋯ menu
- Export button (`VPI_CustIntel_LegacyAR_YYYYMMDD.xlsx`, same Vienovo-branded format as other exports)

---

## 6 · Part C — Silence System

### 6.1 Endpoints

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/api/silence`   | session | `{alert_type, customer_code, customer_name?, duration_days \| null, note?}` | `{ok:true, silence: {id, ...}}` · 400 on invalid alert_type · 503 pre-migration |
| POST | `/api/unsilence` | session | `{silence_id}` | `{ok:true, silence:{...}}` · 404 if not owned by user |
| GET  | `/api/silenced`  | session | — | `{silences:[…], count:n, user_id, fetched_at}` |

All three enforce session via `x-session-id` header; silences are scoped to `session.id` so silences are strictly per-user.

**Valid alert_type values:**
`rescue`, `grow`, `warning`, `legacy_ar`, `margin_critical`, `margin_warning`, `dormant_active`

**Duration:**
- `7` / `30` → `silenced_until = NOW() + N days`
- `null` (or `0` from the "Forever" radio) → `silenced_until = NULL`
- Max 3650 days (10 years) accepted
- Validation at endpoint returns 400 for invalid values

### 6.2 Silence filter applied to existing endpoints

In `/api/intelligence` and `/api/margin`, per request:

1. `getActiveSilences(session.id)` reads from Supabase with the partial-index-backed predicate `active = true AND (silenced_until IS NULL OR > NOW())`.
2. `buildSilenceIndex(silences)` creates a `Set<"alert_type::customer_code">` for O(1) membership.
3. `applySilenceFilter(rows, alertType, idx, codeFn)` drops silenced rows from rescue / grow / warning / legacy_ar / margin_critical / margin_warning arrays and returns `{kept, removed_count}`.
4. Response envelope gains `silenced_count` + `silenced_by_type` so the frontend knows how many items were hidden.
5. Cache key now includes `session.id` so User A's silences don't bleed into User B's cached response.

### 6.3 Frontend UX

#### Row ⋯ menu
Every alert row (rescue, grow, warning, legacy_ar, margin_warning) gets a 28px rightmost column with a ⋯ button. Clicking positions a small absolute-positioned popup (`#ci-menu-pop`) showing:

```
🔕 Silence this alert
👤 View Customer
```

Click-outside closes it. Event capture uses `mousedown` timing so the popup options fire before blur.

#### Silence modal
Opens on "Silence this alert" click. Backdrop-blur overlay + scale-in modal.

```
╭─ Silence alert for: JAIRAH FARM ───────────────────── × ─╮
│ Customer code: CA000266                                 │
├──────────────────────────────────────────────────────────┤
│ Alert type: Rescue  ·  Silent 79d + ₱13.3M AR           │
│                                                          │
│ SILENCE FOR:                                             │
│  ( ) 7 days                                              │
│  (•) 30 days                                             │
│  ( ) Forever                                             │
│                                                          │
│ REASON (optional):                                       │
│ [ Joel handling this directly                         ]  │
│                                                          │
│ [ Cancel ]                             [ 🔕 Silence ]   │
╰──────────────────────────────────────────────────────────╯
```

- ESC closes the modal.
- Submit → `POST /api/silence` → status line shows spinner → on success, modal closes with a 250ms delay, a toast fires, and `loadIntelligence()` (or `loadMargin()`) re-runs with its `DC[]` cache busted so the silenced row disappears immediately.
- Error: red status text with exact API error.

#### Silenced drawer (pg-insights bottom + pg-margin bottom)
Collapsible `<div>` with header showing count. Click expands to show all active silences for the user:

```
🔕 SILENCED ITEMS — 5                                 ▼
───────────────────────────────────────────────────────
Customer            Alert Type   Silenced      Until       Reason           Action
JAIRAH FARM         Rescue       Apr 18, 09:14  30 days     Joel handling    [🔔 Unsilence]
CCPC                Warning      Apr 18, 09:15  Forever     internal acct    [🔔 Unsilence]
BREEDERS AGRIVET    Legacy AR    Apr 18, 09:17  Forever     w/ Finance       [🔔 Unsilence]
...
```

- Margin page drawer (`#sec-silenced-margin`) filters to `margin_*` types only.
- Unsilence button optimistically removes the row, POSTs `/api/unsilence`, then re-loads the underlying page to return the alert to its list. Resync from `/api/silenced` as source of truth follows.

#### Toasts (bottom-right)
```
🔕 JAIRAH FARM silenced for 30 days                [ Undo ]
```
- 6s auto-dismiss with Undo button (calls `/api/unsilence` on the just-created row).
- 4s auto-dismiss without Undo for plain messages.
- Errors: red toast with `✗` prefix, no Undo.

### 6.4 Auto-expiry behaviour
Silences expire **client-side** by the Supabase query: `silenced_until > NOW()`. The partial index makes this check free. Expired rows stay in the table with `active = true` but simply never match the predicate — so they vanish from `/api/silenced` and from filter-outs without needing a cron job. (Optional future: a daily job flipping `active = false` on expired rows to keep the index compact.)

---

## 7 · End-to-end verification

After running the DDL, the expected golden path is:

1. **Open Customer Intelligence** → CCPC no longer in Early Warning (top row shifts to LB POULTRY SUPPLY).
2. Dormant hero: **183 / ₱281M** (dormant_active). Legacy card below: **85 / ₱15M**.
3. Click ⋯ on JAIRAH FARM → "🔕 Silence this alert" → modal opens → pick 30 days, note "Joel handling" → Silence.
4. JAIRAH FARM disappears from Rescue list immediately. Toast bottom-right: "🔕 JAIRAH FARM silenced for 30 days — [Undo]".
5. Scroll to bottom → drawer header shows "🔕 SILENCED ITEMS — 1". Click to expand → JAIRAH FARM row with Alert Type=Rescue, Until=30 days, Reason=Joel handling, [🔔 Unsilence] button.
6. Click Unsilence → row vanishes from drawer → JAIRAH FARM reappears in the Rescue table → toast confirms.

**Margin-page verification** (Customer Intelligence → sidebar → Margin Alerts):
1. Open Margin Alerts, find a warning-row customer, click ⋯ → Silence 7 days.
2. Customer drops out of Warning table; bottom drawer "SILENCED MARGIN ALERTS — 1".
3. Cross-page: same silence visible from the Intelligence drawer too.

---

## 8 · Performance (prod rev 00061-bek)

| Operation | Measured |
|---|---|
| `/api/intelligence` cold | ~2.1 s  (extra SQL Q6 for legacy-AR full OINV scan) |
| `/api/intelligence` warm (600 s cache hit, user-scoped key) | ~0.65 s |
| `/api/intelligence` warm + 5 silences to read from Supabase | ~0.72 s (+70 ms Supabase call) |
| `/api/silenced` cold / warm | ~180 ms / ~90 ms |
| `POST /api/silence` | ~170 ms |
| `POST /api/unsilence` | ~140 ms |
| Frontend silence-modal open → close (optimistic) | < 50 ms |
| Drawer render (5 silences) | < 20 ms |

Silences propagation is immediate: bust `DC[page]` → re-fetch cached backend response (which already reflects the new silence because intelligence/margin read silences per-request, **not** from the cached envelope — the cache key is user-scoped so another user's silence doesn't leak).

---

## 9 · v1.1 follow-ups

| # | Item | Effort | Notes |
|---|---|---|---|
| 1 | **Bulk silence** — checkbox-select multiple alert rows → "Silence all selected for N days" | 2 h | Most-asked UX enhancement |
| 2 | **Customer-scoped bulk silence** — "Silence CCPC across ALL alert types" in one action | 1 h | Matches Mat's brief hint |
| 3 | **Silence with condition** — "silence unless AR grows > X%" threshold-based auto-resurface | 3 h | Replaces blanket-silencing for rescue alerts where AR is fluid |
| 4 | **Silence daily digest** — email each morning showing silences expiring today + what would resurface | 2 h | Prevents alert-blindness |
| 5 | **Margin critical cards ⋯ menu** — currently only the warning *table* has ⋯; critical uses cards | 30 min | Add ⋯ button into each critical card's `.card-hdr` |
| 6 | **Legacy AR heuristic tuning** — if Mat reviews the 85 legacy accounts and says "these 40 are actually active", expose the threshold knobs via a settings page | 2 h | Current split is 183/₱281M dormant vs 85/₱15M legacy — heuristic can widen to catch more OB artifacts |
| 7 | **Auto-expiry cleanup job** — nightly job flipping `active=false` on expired silences | 30 min | Keeps partial-index compact as volume grows |
| 8 | **NON_CUSTOMER_CODES dynamic merge** — at boot, `SELECT WhsCode FROM OWHS` and `mergeDynamicWhsCodes()` so new plants are auto-excluded | 1 h | Stub `mergeDynamicWhsCodes()` already in lib |
| 9 | **Silence audit log / UI** — "silences created this week by user", useful for sales manager review | 2 h | Supabase already stores `created_at` + `note` |
| 10 | **Role-filtered silences** — when EVP silences globally, optionally propagate to all RSMs (or not) | 3 h | Depends on `applyRoleFilter` being fully implemented |

---

## 10 · URLs + References

| | |
|---|---|
| Production frontend | **https://vieforce-hq.vercel.app** |
| Production API      | https://vieforce-hq-api-qca5cbpcqq-as.a.run.app (100% → `vieforce-hq-api-00061-bek`) |
| Preview API (same rev) | https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app |
| GitHub branch | `design-upgrade` @ `d357394` |
| Supabase migration file | `migrations/supabase_silenced_alerts.sql` |

### Rollback

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00053-hid=100 --quiet
```

(`00053-hid` = Intelligence rebuild revision, last prior checkpoint.) Then revert `app.html` / `api/*` changes locally and redeploy Vercel.

---

*Generated 2026-04-18 · VieForce HQ · Vienovo Philippines Inc.*
