# VieForce HQ — Handover / Resume Prompt (2026-07-05)

You are picking up work on **VieForce HQ**, a Sales Intelligence & BI dashboard for
Vienovo Philippines Inc. (VPI), an animal-feed manufacturer. It pulls **live SAP B1
(MSSQL)** data and shows sales / AR / inventory / margin / speed to CEO/EVP/RSM/DSM
roles. This is a **PROFESSIONAL** project — root `C:\VienovoDev\vieforce-hq`. (Do
NOT touch anything personal / `C:\MatDev` / Madame G without explicit approval — see
HARD RULE in the global CLAUDE.md.)

## Architecture (know this first)
- **Frontend**: vanilla JS in one 519KB `app.html` (16 pages, inline JS) + `js/*.js`
  modules + `css/*.css`. Deployed on **Vercel** (static host only). Chart.js 4.4.1.
- **Backend**: `server.js` (Express) mounts `api/*.js` "Vercel-style" handlers on
  **Cloud Run** (`asia-southeast1`, project `vieforce-vpi`). Push to `master` →
  GitHub Action `deploy-cloud-run.yml` **auto-deploys to production**.
- **Data**: SAP B1 MSSQL at `analytics.vienovo.ph:4444`, **dual DB** —
  `Vienovo_Live` (2026+) and `Vienovo_Old` (pre-2026-01-01). `api/_db.js` exposes
  `query` / `queryH` / `queryBoth` / `queryDateRange` (date-aware split at the
  2026-01-01 cutoff). Also **Supabase** (`yolxcmeoovztuindrglk`, shared with the
  sibling app **VieForce Patrol** at `C:\VienovoDev\vieforce-patrol`) for auth/users.
- **Auth**: `x-session-id` header = a Supabase `users.id` UUID (`api/_auth.js
  verifySession`). Patrol S2S uses a Bearer service token (`HQ_SERVICE_TOKEN`,
  `verifyServiceToken`). PINs are **plaintext** in `users.pin_hash` (see open item).
- Repo is its own git (remote `github.com/mathieu-hash/vieforce-hq`), branches
  `master` + `design-upgrade`.

## CRITICAL: how to verify live data (SAP is VPN-gated)
`analytics.vienovo.ph:4444` is **only reachable from Cloud Run** (Azure VPN). Your
laptop and the Hermes VM CANNOT reach it. **The deployed Cloud Run API IS the wire
to SAP** and is reachable over public HTTPS. To read live numbers:
```
TOKEN=$(grep -E "^HQ_SERVICE_TOKEN=" .env.local | cut -d= -f2- | tr -d '\r\n')
BASE=https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/speed?period=MTD"   # 200
```
NOTE: service token works on `speed, ar, customers, customer, inventory` (they have
the Patrol S2S path). `dashboard, margin, itemized, team, budget` are
`verifySession`-only → use a real user's `x-session-id`. Get one via the Supabase
service-role key (in `.env.local`) — e.g. Mat's exec id
`b3bb7fc6-8e8d-4529-9166-db11b2c78b61`. To view the UI: run `node server.js` locally,
open `localhost:8080/app.html`, and in the console set
`localStorage.vf_api_base` = the Cloud Run `…/api` URL + inject a `vf_session`
`{id:<exec uuid>,role:'exec',...}` so it pulls live data. Live-login test creds
`09170000100/2026` do NOT work.

## What was done this session (all DEPLOYED, 164/164 tests pass)
Commits on `master`: `193b711` (hardening+accuracy), `c4ba4e1` (region base-code),
`d094bc6` (badge cleanup). Full detail in `HARDENING_2026-07-03.md`.
- **Security/reliability**: centralized `serverError()` helper (`api/lib/http.js`) —
  no more raw DB errors to the browser; bounded+swept in-memory cache with a
  `keyableUrl()` that strips the `_t` cache-buster (was 100% miss); `_db.js` pool
  connect-promise memoization; login limiter = **failures-only + per-phone lockout +
  XFF-spoof-safe IP**; `server.js` deny-guard blocks static exposure of API source/
  backups/mock; **git history scrubbed** of the old SAP password (force-pushed).
- **Region map** (`api/lib/region-map.js` = single source of truth): confirmed
  **BAC→Visayas, ALAE→Mindanao**; matches on the **base plant code** (strips
  `-<suffix>` bins like HOREB-IT/BAC-QA) in both SQL (`regionCaseSql`) and JS
  (`regionOfWhs`); swept every backend consumer + `app.html`'s `plantRegionOf`.
  Live-verified: inventory "Other" bucket → 0.
- **Speed** (`api/speed.js`): run-rate now excludes **today** (uses completed
  shipping days, `asOf = yesterday`, dedicated `completed_mt` query); `period_volume_mt`
  still includes today; prior/LY windows anchored to `asOf`. Speed + Itemized "vs
  last year" now route to the historical DB (were ~0).
- **Data accuracy**: margin national GM% + alert counts from an **un-truncated**
  aggregate (were biased low from a TOP-500 slice; now match Home); inventory "On
  Production" scoped to region/segment; team.js holiday-aware shipping days;
  customer volume-rank excludes house/CE accounts; EVP-mobile GM% arrow/label fixes;
  dropped the always-blank margin-matrix Δ column; customer-chart ghost + budget
  first-load mock-race fixes.
- **UX**: disabled the review-only "TABLE #N" debug badges in production.
- **Verified live in a browser**: all charts render correct data; filters
  (period/region/segment) drive the whole dashboard.

## OPEN ITEMS (parked — Mat's call / not started)
1. **Rotate the SAP `gsheet` password** — Mat is doing this. History already scrubbed;
   set the new value only in Cloud Run env, never in a file.
2. **PIN hashing** — DO NOT hash `users.pin_hash` unilaterally: Patrol's
   `supabase/functions/verify-pin/index.ts` does a **plaintext** compare
   (`user.pin_hash === pin`) and a prior bcrypt attempt was reverted → hashing breaks
   BOTH apps' login. Safe path = make both verifiers dual-mode (bcrypt-or-plaintext),
   deploy Patrol's edge function FIRST, then switch HQ + admin write paths, then
   migrate. Needs a Supabase edge-function deploy token (not in this env).
3. **Enable role scoping**: implemented but gated OFF via env `SCOPE_USER_SESSIONS`.
   Before enabling, backfill `sap_slpcode` for the ~13 active field users missing it
   (list in `HARDENING_2026-07-03.md`), then set `SCOPE_USER_SESSIONS=1` on Cloud Run.
   Security note already shipped: user sessions never trust a client `?scope=` param.
4. **Margin Explorer filter consolidation** — that page shows filters 3× (top chips +
   applied-pill row + a full filter panel). Real space win but it's a layout refactor
   on the approved design + live filter wiring; get Mat's OK, verify in browser.
5. **UNTAGGED GM/ton anomaly** — Sales → GM/ton-by-group "UNTAGGED" row shows a
   ~₱27.5M GM/ton (tiny-denominator artifact in the unclassified SKU bucket). Classify
   those SKUs or cap the display.

## Gotchas
- This repo has CRLF line endings; edits may warn "LF will be replaced by CRLF" —
  harmless. A prior git-scrub patch round-trip silently dropped 2 files' fixes once —
  after any history rewrite, re-verify with `git diff`/tests.
- Run tests with `npm test` (node:test, 164 pass). No live SAP needed for tests
  (they mock `_db`). Scratch artifacts (`_verify_*.png`, `.playwright-mcp/`) are
  gitignored.
- `applyRoleFilter` in `_auth.js` is a dead no-op TODO — real scoping now lives in
  `_scope.js resolveRequestScope`; only `margin-explorer.js` still calls the old one.

## Unrelated background noise (ignore unless asked)
An `[Auto-watcher] Athena booking_status production-trace poll` cron fires
periodically (Madame G / PERSONAL — a separate concern). If count is 0 it wants the
one line `booking_status watch: still 0 real turns.` and stop. Don't fold it into HQ work.

---
*Start-here docs: this file + `HARDENING_2026-07-03.md`. Ask Mat before any prod
deploy that changes displayed ₱ numbers, and do a live-API spot-check after deploys.*
