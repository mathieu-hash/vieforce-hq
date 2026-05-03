---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: arch
---

# Architecture — VieForce HQ Desktop

## Pattern

**Thin Express API + static SPA-like HTML pages.** Each route file under `api/` exports a single handler `(req, res) => {}` usable both from `server.js` and (historically) serverless adapters. Business logic lives mostly inline in route modules with shared primitives:

- **`api/_auth.js`** — Session verification (`x-session-id`), service bearer auth, period helpers, **`applyRoleFilter`** for legacy SQL string building.
- **`api/_scope.js`** — Resolution of Supabase user → SAP territory (`slpCodes`, `districtCodes`) for Patrol and granular HQ endpoints.
- **`api/_db.js`** — SAP connection pooling and parameterized queries.

## Trust boundaries (critical)

1. **Browser → HQ API:** End-user calls carry `x-session-id`. Session is validated against Supabase `users` row (`verifySession`).
2. **Patrol → HQ API:** Service token path bypasses end-user session but must pair with **`scope`** resolution so SAP queries are not universally national for field roles.
3. **`applyRoleFilter` vs `_scope.js`:** `_auth.applyRoleFilter` still returns **unscoped SAP visibility** for roles `admin`, `ceo`, `evp`, `rsm`, `dsm`, `tsr` (TODO in code — intended Phase 3). Many endpoints instead use **`api/_scope.js`** + explicit SQL predicates — **two parallel authorization stories**. Beta hardening must reconcile or clearly partition endpoints.

## Data flow (typical dashboard request)

1. User opens static HTML → `js/auth.js` restores session → `js/api.js` calls Cloud Run base URL with `x-session-id`.
2. Express handler runs `verifySession` or rejects.
3. Handler builds SAP SQL with period filters; scope-aware routes merge `_scope.js` output into WHERE clauses.
4. JSON returned to browser; `js/charts.js` / role-specific home modules render.

## Entry points

| Entry | Purpose |
|-------|---------|
| `server.js` | Mounts all `/api/*` routes; local and container runtime |
| `index.html` / `app.html` / `vieforce-hq-desktop.html` | Primary UX surfaces |
| `pg-admin-team.html` | Admin portal for user lifecycle |

## Admin flows

- **`api/admin/upsert-user.js`**, **`remove-user.js`**, **`reset-pin.js`**, **`sap-reps.js`** — Executive/admin-gated mutations touching Supabase Auth + `public.users` with transactional semantics (see tests).

## Diagnostics

- **`api/diag.js`** — Large diagnostic surface (mapping probes, SQL sanity). **High sensitivity for production** — must be gated or disabled outside trusted environments.
