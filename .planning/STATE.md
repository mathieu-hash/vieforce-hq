---
milestone: v1.0 Beta
milestone_name: HQ Desktop deployment-ready
status: planning
progress:
  phases_total: 4
  phases_done: 0
  requirements_done: 0
---

# Project state

## Current Position

Phase: **1 — Security hot path** (partially executed in-repo)  
Plan: `.planning/ROADMAP.md`  
Status: Phase 1 deliverables: `/api/diag` gated (`api/lib/require-diag-access.js`), `AUTHZ_MATRIX.md`, CI workflow + `scripts/ci-scan-client.mjs`; Phase 2+ not started  
Last activity: 2026-05-03 — Phase 1 execution: diag auth, 71 tests, GitHub Actions CI

## Accumulated context

- HQ git branch: `design-upgrade` (confirm before production deploy).
- Patrol (`vieforce-patrol` v3.1.0-beta.1) developed in parallel — coordinate API contract changes.

## Blockers

(None recorded — add here when execution starts.)

## Working assumptions

- Beta targets **controlled user group** (internal + pilot DSM/TSR), not open internet scale.
