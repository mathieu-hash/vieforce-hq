# VieForce HQ & Patrol — Situation audit (2026-05-03)

**Scope:** Read-only consolidation for leadership + agents. **HQ desktop** = `C:\VienovoDev\vieforce-hq`. **Patrol** = `C:\VienovoDev\vieforce-patrol` (separate agent owns execution).

## Executive summary

| Dimension | HQ Desktop | Patrol mobile |
|-----------|------------|----------------|
| **Role** | Executive / leadership BI, admin portal, SAP-backed APIs | Field TSR/DSM workflow, offline queue, visits |
| **Runtime** | Node + Express + static HTML/JS on Vercel; API on Cloud Run | HTML/JS app + Playwright + Supabase CLI |
| **Version / branch** | `package.json` 1.0.0; branch `design-upgrade` | `package.json` 3.1.0-beta.1; `main` |
| **Tests** | 65 Node tests (scope + admin + SAP SQL fixtures) after `run-tests.mjs` fix | Unit + Playwright (`npm test` / `playwright test`) |
| **Top risk** | `/api/diag` + legacy `applyRoleFilter` national visibility | Session / RLS / offline — tracked by Patrol agent |

**Overall:** Product-market fit is strong; **trust boundaries** must be closed before calling Beta “open.” HQ and Patrol share the **HQ API contract** — coordinate changes.

## VieForce HQ desktop — current strengths

- **Server-side PIN login** (`api/auth/login.js`) with rate limiting and timing-safe compare; service role used server-only.  
- **Dual SAP DB** routing with migration cutoff (`api/_db.js`).  
- **Explicit scope engine** for hierarchy (`api/_scope.js`) — foundation for correct territory filtering when used consistently.  
- **Solid automated tests** for scope behaviors and admin mutations.  
- **Security headers + CSP** on static hosting (`vercel.json`).

## VieForce HQ desktop — gaps for “strong Beta v1”

1. **P0:** `api/diag.js` — diagnostic power must not be public in production.  
2. **P0:** `applyRoleFilter` in `api/_auth.js` — still **full SAP visibility** for many roles (TODO acknowledges Phase 3 OSLP joins). Many routes use `_scope.js` instead — **two models** = verification burden.  
3. **P1:** Session is still **opaque user UUID** in header — short TTL + HTTPS + future signed token per login comments.  
4. **P1:** `npm test` was broken on Windows (`node --test tests/`); **fixed** via `scripts/run-tests.mjs`.  
5. **P2:** Partial report surfaces (Pivot, plotting, team hierarchy, budget, itemized mapping) — decide **ship / hide / label** for Beta.

## VieForce Patrol — snapshot (other agent)

- **Focus:** Mobile UX, Supabase alignment, offline queue, Playwright coverage — **do not duplicate here**.  
- **Integration point:** Patrol calls HQ with **`HQ_SERVICE_TOKEN`** and **`scope=user:<uuid>`** — HQ `_scope.js` must stay stable.  
- **Version label:** `3.1.0-beta.1` signals aligned beta era with HQ.

## Coordination rules

1. **API breaking changes:** Require dual PR or explicit version negotiation — update **INT-01** checklist.  
2. **Security fixes that touch both:** Prefer HQ server changes first (authz, diag), then Patrol client if contract changes.

## Artifacts produced this session (HQ repo)

- `.planning/codebase/*.md` — full stack/architecture map (GSD map-codebase style).  
- `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `MILESTONES.md` — Beta milestone package.  
- `scripts/run-tests.mjs` + `package.json` test script fix.

---

*Next step for implementation:* Phase 1 in `ROADMAP.md` — diag gate + authz matrix + secret grep CI.
