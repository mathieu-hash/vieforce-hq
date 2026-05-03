# Requirements — Milestone v1.0 Beta (VieForce HQ Desktop)

**Traceability:** REQ-IDs map to phases in `.planning/ROADMAP.md`.

## Security & trust

- [x] **SEC-01:** `/api/diag` is not anonymously callable in production (admin gate, env kill-switch, or separate internal deployment).  
- [x] **SEC-02:** Document and implement **endpoint authorization matrix**: which routes use `_scope.js`, which use `applyRoleFilter`, which are exec-only — with tests preventing regression.  
- [x] **SEC-03:** Session strategy documented for Beta: TTL, transport (HTTPS only), mitigation for raw UUID `x-session-id`; roadmap item for signed/JWT sessions if not in Beta scope.  
- [x] **SEC-04:** Secrets inventory verified on Cloud Run + Vercel (no `SUPABASE_SERVICE_ROLE_KEY` in client bundles).

## Engineering quality

- [x] **ENG-01:** CI runs `npm test` on every PR (GitHub Actions or equivalent).  
- [x] **ENG-02:** `npm test` documented and verified Windows + Linux (fixed via `scripts/run-tests.mjs`).  
- [x] **ENG-03:** Staging smoke checklist OR Playwright smoke against staging API URL (minimal happy-path login mocked or stubbed).

## Product completeness (Beta bar)

- [x] **PROD-01:** Known **partial reports** (Pivot, Plotting, Team hierarchy, Budget P&L, Itemized mapping) — either ship MVP + label, hide nav, or defer with explicit “Beta excluded” list for stakeholders.  
- [x] **PROD-02:** Admin portal (`pg-admin-team.html`) workflows validated for Beta user onboarding (upsert, reset PIN, remove user).

## Operations & deployment

- [x] **OPS-01:** Runbook: deploy order (Supabase migration → API → static), rollback, who to page.  
- [x] **OPS-02:** Cloud Run sizing / min instances + SAP pool limits validated under pilot concurrency.  
- [x] **OPS-03:** Optional error monitoring (e.g. Sentry) — scoped “nice for Beta” unless elevated to SEC.

## Integration with Patrol

- [x] **INT-01:** Contract checklist shared with Patrol agent: `HQ_SERVICE_TOKEN`, scope query shapes, breaking-change protocol.

---

## Future (post-Beta)

- JWT / refresh-token sessions; centralized audit log; full role SQL via OSLP joins (`applyRoleFilter` TODO).

## Out of scope

- Rewriting Patrol offline shell — owned by Patrol track.  
- Full self-service password reset without admin — unless promoted.

---

## Traceability (filled by roadmap)

| REQ-ID | Phase |
|--------|-------|
| SEC-01 — SEC-04 | 1 |
| ENG-01 — ENG-03 | 2 |
| PROD-01 — PROD-02 | 3 |
| OPS-01 — OPS-03, INT-01 | 4 |
