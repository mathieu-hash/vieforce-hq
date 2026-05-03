---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: tech
---

# Stack — VieForce HQ Desktop

## Languages & runtime

- **Runtime:** Node.js (CommonJS `require` throughout).
- **Language:** JavaScript (`.js` server + browser bundles loaded as classic scripts in HTML).

## Application shape

- **API:** Express application in `server.js` (local dev / Cloud Run–style single process). Routes mirror one handler module per HTTP endpoint under `api/`.
- **Frontend:** Static HTML shells (`index.html`, `app.html`, `vieforce-hq-desktop.html`, `pg-admin-team.html`) plus `js/*.js` clients. API base URL is configured in `js/api.js` (production Cloud Run endpoint embedded).

## Dependencies (`package.json`)

| Package | Role |
|---------|------|
| `express` | HTTP server and routing |
| `@supabase/supabase-js` | Supabase client for users/session lookups (`api/_auth.js`, `api/_scope.js`, login flow) |
| `mssql` | SAP Business One SQL Server access (`api/_db.js`) |
| `cors` | Cross-origin policy for Vercel previews + localhost + Cloud Run |
| `dotenv` | Loads `.env.local` at startup (`server.js`) |

## Configuration & secrets

- **SAP:** `SAP_HOST`, `SAP_PORT`, `SAP_USER`, `SAP_PASS`, `SAP_DB` (current), `SAP_DB_HISTORICAL`, `SAP_MIGRATION_CUTOFF` — see `api/_db.js`.
- **Supabase:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` (session verification), `SUPABASE_SERVICE_ROLE_KEY` (login + scope reads that bypass RLS).
- **Internal integration:** `HQ_SERVICE_TOKEN` — bearer auth for Patrol/service callers (`api/_auth.js` `verifyServiceToken`).
- **Port:** `PORT` (default `8080`).

## Hosting / deploy assumptions

- **`vercel.json`:** Security headers + CSP for static frontend hosting on Vercel.
- **API:** Comments and `js/api.js` reference Google Cloud Run (`*.run.app`) for the Node API; CORS allows `.vercel.app`, `.run.app`, localhost.

## Scripts

| Script | Command |
|--------|---------|
| `npm start` | `node server.js` |
| `npm test` | `node scripts/run-tests.mjs` (runs all `tests/*.test.js`) |

## Related assets

- SQL migrations under `migrations/` (e.g. `lock-users-rls.sql`).
- Optional Playwright specs under `tests/e2e/` (TypeScript).
