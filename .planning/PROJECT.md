# VieForce HQ Desktop

## What This Is

VieForce HQ is the **sales intelligence and BI web desktop** for Vienovo: executive and field-leadership dashboards backed by **SAP Business One** (via `mssql`) and **Supabase** for identity and hierarchy. A companion **Patrol** mobile app (`vieforce-patrol`) consumes the same HQ API using a service token and user scope parameters.

## Core Value

**Trustworthy, role-appropriate visibility into national and territory sales reality** — without exposing SAP or credentials to browsers, and without shipping Beta until authz and diagnostics match deployment reality.

## Requirements

### Validated

- ✓ Server-side PIN login path (`api/auth/login.js`) replacing client-side PIN exposure — `migrations/lock-users-rls.sql` direction.
- ✓ SAP dual-database queries with migration cutoff (`api/_db.js`).
- ✓ Patrol proxy consumption via `HQ_SERVICE_TOKEN` + `api/_scope.js` resolution.
- ✓ Automated regression suite for scope + admin APIs (`npm test` — 71+ tests; CI on Ubuntu + Windows).
- ✓ Milestone v1.0 Beta planning artifacts: session strategy, Beta scope, runbook, Patrol contract, smoke + admin checklists (see `.planning/`).

### Active (Current Milestone: v1.0 Beta)

In-repo requirements are **closed** in `REQUIREMENTS.md` — remaining work is **human UAT** (admin checklist, stakeholder sign-off, deploy gated API to Cloud Run, Patrol acknowledgment of `PATROL_HQ_CONTRACT.md`).

### Out of Scope (this Beta)

- Full Pivot builder self-service (unless promoted from roadmap).
- Full Messenger / push notification platform — decision deferred; coordinate with Patrol.
- Replacing SAP — **not** in scope.

## Context

- HQ API deploy target: **Google Cloud Run**; static UI: **Vercel** (see `js/api.js`, `vercel.json`).
- Working branch is often **`design-upgrade`** — align release promotion with `master` before Beta tag.
- Parallel effort: **Patrol** agent owns mobile app + offline; HQ owns browser desktop + shared API contract.

## Constraints

- **Security:** `/api/diag` is gated in code — **deploy** to Cloud Run to replace legacy open 200; optional `DISABLE_DIAG=1` for hard-off.
- **SAP:** Query timeouts and pool sizes tuned for internal concurrency (`api/_db.js`).
- **Compliance:** Session upgrade path should avoid long-lived opaque UUID sessions for external auditors.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Express monolith for API | Fast iteration, shared SAP pools | ✓ Good for Beta |
| `_scope.js` for Patrol | Explicit SAP filters per field user | ✓ Good |
| `applyRoleFilter` legacy path | Pre-scope-era SQL | ⚠️ Revisit — converges with Beta hardening |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**

1. Requirements invalidated? → Move to Out of Scope with reason  
2. Requirements validated? → Move to Validated with phase reference  
3. New requirements emerged? → Add to Active  
4. Decisions to log? → Add to Key Decisions  
5. "What This Is" still accurate? → Update if drifted  

**After each milestone:**

1. Full review of all sections  
2. Core Value check  
3. Audit Out of Scope  
4. Update Context with current state  

---

## Current Milestone: v1.0 Beta — HQ Desktop deployment-ready

**Goal:** Ship a **strong working Beta** of VieForce HQ desktop: hardened trust boundaries, green CI, staged rollout checklist — without blocking on Patrol deliverables except shared API contracts.

**Target features:**

- Lock down or remove public **diag** risk; admin-only or env-gated diagnostics.  
- **Reconcile authorization:** `applyRoleFilter` vs `_scope.js` — documented matrix + tests for each endpoint class.  
- **Session hardening path:** document JWT/signed-session roadmap; mitigate UUID session risk for Beta (TTL, HTTPS-only, CSP already in `vercel.json`).  
- **CI + npm test** on every PR; optional smoke to staging API.  
- **Beta readiness checklist:** env vars, Cloud Run min instances, Supabase RLS verification, rollback plan.

---

*Last updated: 2026-05-03 — Milestone v1.0 Beta initialized + codebase map*
