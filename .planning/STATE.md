---
milestone: v1.0 Beta
milestone_name: HQ Desktop deployment-ready
status: ready-for-uat
progress:
  phases_total: 4
  phases_done: 4
  requirements_done: 14
---

# Project state

## Current Position

Phase: **All roadmap phases — artifacts complete in-repo**  
Plan: `.planning/ROADMAP.md`  
Status: Requirements checklist satisfied (see `REQUIREMENTS.md`). Remaining human steps: run **`ADMIN_VALIDATION_CHECKLIST`** on staging; **`npm run smoke`** against prod/staging URL; Patrol owner acknowledges **`PATROL_HQ_CONTRACT.md`**.  
Last activity: 2026-05-03 — Vercel Git connected; Cloud Run deploy workflow on `master`; smoke, Patrol contract, README

## Accumulated context

- HQ production git branch: **`master`**. Vercel auto-deploys from Git; Cloud Run uses `.github/workflows/deploy-cloud-run.yml` once **`GCP_SA_KEY`** is set.
- Patrol (`vieforce-patrol` v3.1.0-beta.1) developed in parallel — coordinate API contract changes.

## Blockers

(None recorded — add here when execution starts.)

## Working assumptions

- Beta targets **controlled user group** (internal + pilot DSM/TSR), not open internet scale.
