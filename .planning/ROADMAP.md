# Roadmap — Milestone v1.0 Beta (VieForce HQ Desktop)

**Milestone:** v1.0 Beta — HQ Desktop deployment-ready  
**Phases:** 4 | **Requirements:** 14 mapped  

---

## Phase 1 — Security hot path

**Goal:** Remove or gate production diagnostic exposure; establish authoritative authz story for SAP endpoints.

**Status (2026-05-03):** Implemented in codebase — `/api/diag` requires exec-level session or optional service token (`DIAG_ALLOW_SERVICE_TOKEN=1`); `DISABLE_DIAG=1` hard-disables; `.planning/AUTHZ_MATRIX.md`; GitHub Actions runs `npm test` + `scripts/ci-scan-client.mjs`. **Ops:** set env on Cloud Run before calling Beta “done.”

| REQ-IDs | Success criteria (observable) |
|---------|-------------------------------|
| SEC-01, SEC-02, SEC-04 | `/api/diag` returns 403 or 404 on public staging without admin; matrix doc exists in `.planning/` or `docs/`; no service role in browser bundle (grep CI check). |

**Exit:** Stakeholder sign-off that national data cannot leak via diag or mis-classified endpoints.

---

## Phase 2 — Engineering confidence

**Goal:** Every PR runs tests; standardized developer workflow.

| REQ-IDs | Success criteria |
|---------|------------------|
| ENG-01, ENG-02 | CI green on sample PR; `npm test` passes clean checkout Win + Linux. |
| ENG-03 | Documented smoke steps OR automated smoke job artifact attached to release checklist. |

---

## Phase 3 — Beta product cut

**Goal:** UX honesty + admin readiness — no silent partial reports.

| REQ-IDs | Success criteria |
|---------|------------------|
| PROD-01 | Written Beta scope statement: which tabs are GA vs beta vs hidden. |
| PROD-02 | Admin flows exercised against staging Supabase + SAP read-only clone or safe fixtures. |

---

## Phase 4 — Ops + Patrol handshake

**Goal:** Deploy safely; coordinate with Patrol agent.

| REQ-IDs | Success criteria |
|---------|------------------|
| OPS-01 — OPS-03 | Runbook reviewed; pilot load settings documented; monitoring decision recorded. |
| INT-01 | Short contract doc committed; Patrol agent acknowledges breaking-change process. |

---

## Requirement coverage

All active REQ-IDs in `REQUIREMENTS.md` map to exactly one phase above (100% coverage).

---

*Generated: 2026-05-03*
