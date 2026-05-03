# Authorization matrix — VieForce HQ API

**Date:** 2026-05-03  
**Purpose:** SEC-02 — single reference for how each class of route enforces access. Update when adding endpoints.

## Legend

| Mechanism | Description |
|-----------|-------------|
| **Session** | `x-session-id` → `verifySession` → `public.users` row (`api/_auth.js`) |
| **Service token** | `Authorization: Bearer <HQ_SERVICE_TOKEN>` → synthetic `service` session (`api/_auth.js`) |
| **applyRoleFilter** | Legacy SQL fragment helper — **national visibility** for many roles until OSLP work completes (`api/_auth.js`) |
| **scope / _scope.js** | `scope=user:<uuid>` query param — resolves user → `slpCodes` / districts for SAP WHERE clauses (`api/_scope.js`) |
| **requireAdmin** | `service` \| `ceo` \| `admin` (Sales Admin) \| `evp` (EV Sales) \| `marketing` (Marketing Manager) — **not** `exec` (`api/admin/_admin.js`) |
| **requireDiagAccess** | `exec` \| `ceo` \| `admin` \| `evp` \| `director` OR optional service token if `DIAG_ALLOW_SERVICE_TOKEN=1`; **DISABLE_DIAG=1** → 404 (`api/lib/require-diag-access.js`) |

## Matrix by route group

| Group | Routes (examples) | Auth | Data scoping notes |
|-------|---------------------|------|---------------------|
| **Diagnostics** | `GET /api/diag` | **requireDiagAccess** | Full SAP probe — **gated**; not anonymous |
| **Core dashboards** | `/api/dashboard`, `/api/sales`, … | Session + per-handler logic | Many use `applyRoleFilter` and/or `_scope` — verify handler source |
| **Scoped list/detail** | `/api/customers`, `/api/customer`, `/api/ar`, `/api/speed`, `/api/inventory` | Session | **`_scope.js`** predicates when `scope` used (Patrol); HQ browser often national for exec |
| **Admin portal** | `/api/admin/*`, `POST /api/auth/login` | **requireAdmin** or login-specific | Service role server-side only |
| **Silence** | `POST /api/silence`, etc. | Session | See each handler |

## Patrol ↔ HQ

- Patrol calls with **Bearer** service token for routes that support it; user-specific filtering uses **`scope=user:<uuid>`** so SAP rows match the field user.
- **Do not** widen `applyRoleFilter` national behavior without matching product intent.

## Hardening backlog (post Phase 1)

- Converge **applyRoleFilter** with territory reality (OSLP / SlpCode) per `_auth.js` TODO.
- Replace opaque UUID session header with signed/JWT sessions when ready (`api/auth/login.js` comments).
