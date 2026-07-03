# VieForce HQ — Hardening Pass (2026-07-03)

Full audit + fix pass over the API layer, DB access, auth, caching, and server.
Four parallel auditors (architecture, security, quality/reliability, feature gaps)
read the entire codebase; fixes below were applied and the test suite grew from
136 → 149 passing.

---

## Fixed in this pass (code changes, tests green)

| # | Severity | Issue | Fix | Files |
|---|----------|-------|-----|-------|
| B1 | High | Server cache never hit — client appends `_t=Date.now()`, and 3 handlers keyed on `req.url`, so every 60s refresh re-ran heavy SAP SQL | Added `cache.keyableUrl()` that strips `_t` + sorts params; wired into the 3 handlers | `lib/cache.js`, `api/ar.js`, `api/customers.js`, `api/inventory.js` |
| A3 | High | In-memory cache grew unbounded → Cloud Run OOM risk | Bounded to `MAX_ENTRIES=2000` w/ oldest-first eviction + 5-min sweep timer (unref'd) | `lib/cache.js` |
| A1/A2 | High | `getHistoricalPool()` cached a never-connected pool on cold-start failure (LY data silently 0 for days); cold-start connect race | Memoize the *connect promise*, null it on rejection so it retries, add `pool.on('error')` to drop a dead pool | `api/_db.js` |
| D1 | High | ~22 endpoints echoed raw DB error text (and diag returned `err.stack`) to the browser — leaked SQL, table/column names, `Login failed for user 'gsheet'` | New `serverError(res, err, tag)` helper: logs full error server-side w/ a ref id, returns generic `{error:'Server error', ref}` | `api/lib/http.js` + ~22 handlers |
| F1 | High | `/api/speed` "vs last year" queried Vienovo_Live (2026+ only) for 2025 data → always ≈0 | Route the LY window through `queryDateRange` (dispatches to Vienovo_Old) | `api/speed.js` |
| F2 | High | `/api/itemized` LY comparison structurally 0 (same wrong-DB bug) + non-sargable `YEAR()` scan | Split into two `queryDateRange` calls (current + compare year) with sargable `DocDate BETWEEN` | `api/itemized.js` |
| H1 | High | Login rate-limiter bypassable by spoofing `X-Forwarded-For`; 4-digit PIN, default `1234` | Derive client IP from the platform-appended rightmost hop (`TRUSTED_PROXY_HOPS`); add per-phone lockout (10/15min) that holds across IP rotation. **Counts FAILURES only + clears on success** so the ~40 users behind the shared office NAT can't lock each other out | `api/auth/login.js` |
| — | Medium | Whole repo served publicly by `express.static` — API handler **source** (`/api/_db.js` etc.), backups, and the retired mock dashboard were fetchable from Cloud Run | Deny middleware before static serving (404s `/api/*`, `/server.js`, `*.backup`, mock, `/scripts`, `/migrations`, `/tests`); tightened `.dockerignore` | `server.js`, `.dockerignore` |
| C1 | Critical (partial) | Live SAP password committed in `CLAUDE.md` | Scrubbed the value from the working tree → placeholder. **History + rotation still required — see below.** | `CLAUDE.md` |
| K1 | Low | Service-token auth logged full request URL (query string) | Log path only | `api/_auth.js` |

New tests: `tests/cache.test.js` (keyableUrl, eviction, sweep), `tests/login-ratelimit.test.js` (XFF hardening, per-key lockout, timing-safe compare).

---

## Speed run-rate — today no longer counted as a delivered day ✅ (2026-07-03)
`/api/speed` counted **today** as a full elapsed shipping day, but today is still
in progress (its ODLN deliveries aren't all posted yet), so the daily pullout was
divided by one too many days and the projection read low. Fixed: the run-rate now
uses **completed shipping days only** — anchored to the last completed day
(yesterday), with a dedicated `completed_mt` query for the rate numerator. The
page still shows today's shipped volume as the factual period total, and the
prior-period / last-year comparison windows were shifted to the same basis so the
percentages stay apples-to-apples. Covered by `tests/speed-today-excluded.test.js`.

## Data authenticity — what's REAL vs PLACEHOLDER (honest inventory)
**Real, live from SAP B1 / Supabase:** Home KPIs, Sales (brand/customers/trend/
pending-PO/GM-by-group), AR (aging/DSO/clients), Inventory by plant, Speed
(ODLN), Margin + Margin Explorer, Customers / Client 360, Intelligence, Budget
actuals. Region attribution and the speed/itemized "vs last year" numbers were
wrong and are now fixed this session.

**NOT real — hardcoded / placeholder (still in the code):**
- **L10 Scorecard** (`app.html:3314`, `:3344`) — entirely fake weekly numbers
  ("Meeting Score: 10.0", 65%/128%/89%…). No data source.
- **Team page RSM/DSM targets** (`api/team.js:614`) — `ytd_target: 0` hardcoded,
  so the achievement % columns are always meaningless (blocked on you providing
  RSM/DSM-level budgets — not in SAP).
- **Cosmetic:** the red "3" Margin-Alerts nav badge (`app.html:1051`), the footer
  "SAP B1 Live · 30s refresh" claim (`:1078`), the default "Mathieu Guillaume /
  CEO" identity before login hydrates (`:1083`).
- **Dead nav items:** "Sales Pivot" and "Customer Plotting" (`:1066`, `:1069`) —
  visible but do nothing.
- **Data-trust caveat:** ~45 endpoints use `.catch(() => [])`, so if SAP hiccups a
  number can silently read **0** instead of erroring — a displayed 0 isn't always a
  real 0. Adding a `partial: true` flag is a recommended follow-up.

## REQUIRES YOUR ACTION — not safe to auto-fix

These are real and rated Critical/High but need a decision, a secret rotation, a
schema migration coordinated with VieForce Patrol (shared `users` table), or live
SAP verification. Do not treat them as done.

### 1. Rotate the SAP password — CRITICAL (still yours) · history scrub DONE ✅ (2026-07-03)
- **History scrub — DONE.** Purged the old SAP password from ALL of git history
  with `git filter-repo --replace-text` (both `master` and `design-upgrade`),
  force-pushed to `github.com/mathieu-hash/vieforce-hq`. Verified: zero commits on
  either remote branch contain the value. A `.git` mirror + patch backup are in
  the session scratchpad. CAVEAT: GitHub keeps *unreferenced* commits reachable by
  direct SHA for a while — they age out of GC, or you can ask GitHub Support to
  purge immediately; any existing clones/forks/old PRs still hold the value. Since
  you're rotating the password, that residue becomes worthless.
- **Rotate — STILL YOURS (you said you'd do it).** Change the SAP `gsheet` password
  (or cut to the dedicated read-only SQL user), set the new value only in Cloud Run
  env. Until rotated, treat the old value as compromised.

### 2. PINs stored/compared in plaintext — BLOCKED on a coordinated Patrol change (do NOT hash unilaterally)
Investigated and stopped short on purpose. Hashing the shared `users.pin_hash`
column would **lock every sales user out of BOTH apps**, because VieForce Patrol's
`supabase/functions/verify-pin/index.ts` does a plaintext compare
(`user.pin_hash === pin`) and its own comment records that a **prior bcrypt
migration was already tried and reverted** ("Legacy bcrypt values will not match —
reset PIN in Sales Admin once"). So this is not a one-repo change.

Safe path (needs your go — it touches the Patrol repo + a Supabase Edge Function
deploy, which is why I didn't just run it):
1. Make BOTH verifiers dual-mode: if `pin_hash` looks like bcrypt (`$2...`) use
   `bcrypt.compare`, else plaintext. Deploy Patrol's `verify-pin` FIRST.
2. Then switch HQ `login.js` + both apps' admin write paths (`reset-pin`,
   `upsert-user`) to write bcrypt hashes.
3. Migrate remaining plaintext rows; drop the default `1234`; force first-login
   change. No big-bang — PINs convert as they're reset.
I can implement all the code across both repos on your word; the only step I can't
safely self-serve is the Patrol edge-function deploy (no deploy token in this env).

### 3. RLS on `public.users` — VERIFIED SAFE ✅ (2026-07-03), no action needed
Tested empirically with the public anon key: `SELECT ... FROM users` returns
**`permission denied for table users` (HTTP 401)**. The anon role has no table-level
SELECT grant, which overrides any leftover `users_public_read` policy — so the
"anon key can read plaintext PINs" exposure is **not live**. Nothing to change.
(You could still `DROP POLICY users_public_read` for tidiness, but it's inert.)

### 4. Role-based data scoping — IMPLEMENTED (flag-gated OFF) + security hole closed ✅ (2026-07-03)
Two things shipped:
- **Client scope-tampering closed (ships live, no flag).** Added
  `resolveRequestScope()` in `api/_scope.js`, now the single decision point for
  "whose data does this caller see". The Patrol **service token** still honors
  `?scope=user:<uuid>`; a **user session never trusts a client scope param** (the
  old M1 hole where a low-priv user could pass someone else's UUID). Wired into
  `sales`, `ar`, `customers`, `customer`, `speed` (replacing 5 copy-pasted parse
  blocks). 7 new tests in `tests/resolve-scope.test.js` incl. two that assert a
  user session cannot widen via the param.
- **Session scoping (rsm/dsm/tsr → own book) behind `SCOPE_USER_SESSIONS`,
  default OFF.** Managers (exec/evp/ceo/director/admin/marketing) always see
  national. Kept OFF because **13 active field users have no `sap_slpcode`** — with
  it ON they'd see a blank dashboard. Populate those, then set
  `SCOPE_USER_SESSIONS=1` on Cloud Run to enable.

  Users missing `sap_slpcode` (blockers to enabling; several look like demo/seed
  accounts — clean those up via `migrations/cleanup-fake-test-users.sql` first):
  DSM — ARC DEIL ARRADAZA, Jake Santos, Maria Cruz, Marvin Dela Cruz;
  RSM — Carlos Reyes, "RSM Luzon";
  TSR — Aileen Villanueva, Ben Tolentino, Junjun Garcia, Manny dela Cruz, and
  "Demo TSR Alpha/Beta/Gamma".

  (`api/_auth.js applyRoleFilter` remains a no-op — the real scoping now lives in
  `_scope.js`; that dead TODO can be deleted once `margin-explorer`, the only
  remaining `applyRoleFilter` caller, is moved onto `resolveRequestScope` too.)

### 5. Region attribution — FIXED ✅ (2026-07-03, confirmed by Mat: BAC→Visayas, ALAE→Mindanao)
Centralized into one canonical module `api/lib/region-map.js` (single source of
truth: `regionCaseSql(alias)` for SQL + `regionOfWhs(code)` for JS, derived from
one `PLANT_REGION` object so SQL and JS can't drift). Swept every consumer onto it
— 19 inline SQL `CASE` blocks + JS lookups across 12 files (`ar`, `budget`,
`customers`, `intelligence`, `inventory`, `search`, `sales`, `margin`, the 3
`analytics-*`, and `business_filters`). `margin.js` keeps its `WhsName LIKE`
fallback but with corrected codes; the historical `margin_cube.js` 2025 map is a
separate group-aware map and was left as-is. Result: **BAC/ALAE now attribute
consistently everywhere**, and plant codes the old map dropped into "Other"
(HBEXT, SOUTH, CAG, PFMIS, PFMCIS) are now placed correctly. Tests updated to the
confirmed map (not weakened); 157/157 pass. NOTE: headline regional ₱ shifted as
expected — Bacolod volume moved Luzon→Visayas, ALAE Visayas→Mindanao.

---
#### Original finding (for the record)
Investigated in full. There are **two maps**, and the evidence says the *minority*
one is correct:
- **~11 files (all hero views** — dashboard, AR, budget, customers, inventory,
  intelligence, analytics**) use: BAC→Luzon, ALAE→Visayas** — and this map is also
  **missing several live plant codes** (HBEXT, SOUTH, CAG, PFMIS, PFMCIS → silently
  bucketed as "Other").
- **`sales.js` + `margin_cube.js` use: BAC→Visayas, ALAE→Mindanao** — explicitly
  documented (`// BAC = BACOLOD (Visayas)`), geographically correct, **complete**,
  and covered by the `sales_plant_region_map_canonical` test.

**Recommendation: adopt the `sales.js`/`margin_cube` map everywhere** and centralize
it in one module. I did **not** apply it autonomously because it re-attributes
headline regional ₱ (Bacolod Luzon→Visayas, ALAE Visayas→Mindanao) across every
KPI — a money change that needs your sign-off. Couldn't verify against live SAP
`OWHS` (it's behind the Azure VPN, unreachable from the laptop). Once you confirm,
it's a ~20-site mechanical sweep onto the canonical module.

### 6. Session token = raw `users.id` UUID, no server-side expiry — HIGH
A leaked `x-session-id` grants permanent impersonation (only client-side 24h TTL).
Proper fix is a signed, expiring, revocable session token — a real change to the
auth flow, best done alongside #2.

---

## Recommended follow-ups (Medium, safe but not done here)

- **E1 — stale-fetch "wipe" race in `app.html`**: filter changes clear `DC={}` then
  reload; an in-flight response from the *previous* filter can resolve later and
  repopulate with stale data (page shows ALL-region data under a region chip). The
  fix already exists in `js/margin-explorer.js` (the `fetchSeq` generation guard) —
  port it into `loadPage`. Left out of this pass because it's front-end surgery in
  the 519KB monolith that should be verified in a browser.
- **CORS**: handlers hard-set `Access-Control-Allow-Origin: *`, overriding the
  `server.js` allow-list. Low real risk (bearer-header auth, no cookies) but the
  `*.vercel.app` trust is broad — pin an explicit HQ origin list.
- **`.catch(() => [])` masks SAP outages as zero** (~45 sites): add a `partial:true`
  flag to responses when a sub-query fails so the UI can distinguish "0" from "down".
- **Dead weight**: ~30 `*_REPORT.md`, `app.html.backup`, `index.html.backup`,
  `js/charts.js` (unreferenced), and `vieforce-hq-desktop.html` (frozen mock, 39
  commits behind app.html) — safe to delete; excluded from the image now.
- **Desktop dashboard**: `vieforce-hq-desktop.html` is a frozen mock with 0 data
  wiring and 5 views missing vs `app.html`. `app.html` is already desktop-first —
  the honest path is to retire the mock, not patch it.
