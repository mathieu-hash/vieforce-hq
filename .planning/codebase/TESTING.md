---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: quality
---

# Testing — VieForce HQ Desktop

## Unit / integration tests (Node)

- **Runner:** `node --test` (Node 18+ built-in test runner).
- **Command:** `npm test` → `node scripts/run-tests.mjs` — discovers all `tests/*.test.js` (cross-platform; fixes Windows where `node --test tests/` failed because `tests` was not a valid module path).  
- **Client scan:** `node scripts/ci-scan-client.mjs` — ensures no `SUPABASE_SERVICE_ROLE_KEY` in `js/` or root HTML (also runs in CI).
- **Location:** `tests/*.test.js` — 10 files covering:
  - `scope.test.js` — scope resolution and SQL builder meta
  - `admin-*.test.js` — admin API contracts (upsert, remove, reset-pin, sap-reps)
  - `*-scope.test.js` — AR, customer(s), inventory, speed scope behavior

## Status

- **65 tests** passing as of 2026-05-03 (local run on Windows after `run-tests.mjs` fix).
- Tests mock Supabase / SAP where needed; no live DB required for the suite.

## E2E

- **Playwright** specs under `tests/e2e/*.spec.ts` — project has `e2e` config; not wired into `npm test` (Patrol uses Playwright as primary e2e; HQ should document `npx playwright test` if adopted in CI).

## Gaps for Beta

- [ ] Add CI workflow (GitHub Actions / Cloud Build) running `npm test` on push.
- [ ] Wire Playwright or smoke tests against staging API URL.
- [ ] Contract tests for Patrol ↔ HQ **service token + scope** headers (some logic mirrored in Patrol unit tests).
