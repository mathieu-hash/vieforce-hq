---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: tech
---

# Integrations — VieForce HQ Desktop

## SAP Business One (SQL Server)

- **Driver:** `mssql` with connection pools for **current** DB (`Vienovo_Live` by default) and **historical** DB (`Vienovo_Old`).
- **Module:** `api/_db.js` exports `query`, `queryH`, `queryBoth`, date cutoff helpers. Migration cutoff `SAP_MIGRATION_CUTOFF` routes time-bound analytics across databases.
- **Consumers:** Nearly all `api/*.js` handlers that return sales, AR, inventory, margins, diagnostics, itemized exports, etc.

## Supabase (Postgres + Auth)

- **Session model:** `x-session-id` header holds **user UUID** from `public.users`. Verified in `api/_auth.js` `verifySession` (anon key, RLS-respecting read of active user).
- **Admin / login:** `api/auth/login.js` uses **service role** to verify PIN server-side and avoid exposing `pin_hash` to browsers. Comment block documents RLS hardening with `migrations/lock-users-rls.sql`.
- **User scope graph:** `api/_scope.js` resolves hierarchy (exec/rsm/dsm/tsr) into SAP `SlpCode` and district filters for **scoped** endpoints — critical for Patrol proxy flows (`?scope=user:<uuid>`).

## VieForce Patrol (mobile)

- **Patrol → HQ:** Calls HQ API with `Authorization: Bearer <HQ_SERVICE_TOKEN>` plus optional `scope` query param. `_auth.js` synthesizes a `service` session with national SAP visibility; actual row limits are enforced via `_scope.js` when scope param present.
- **Version:** Patrol repo is separate (`vieforce-patrol`, v3.1.0-beta.1); HQ must stay contract-compatible with Patrol’s SAP proxy helpers and scope tests.

## CORS & browsers

- **`server.js`:** Allows no-origin, `*.vercel.app`, `*.run.app`, `http://localhost:*`. Headers whitelisted include `x-session-id`, `authorization`, `content-type`.
- **Static site CSP:** `vercel.json` locks down scripts/styles/fonts and allows Supabase + configured Cloud Run API in `connect-src`.

## Outbound surface summary

| System | Direction | Notes |
|--------|-----------|--------|
| SAP | HQ → SQL Server | Primary BI data |
| Supabase | HQ ↔ Postgres | Users, sessions, admin mutations |
| Patrol | Patrol → HQ API | Bearer service token + user scope |
| Vercel | Browser ↔ static | Frontend hosting |
