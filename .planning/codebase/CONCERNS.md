---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: concerns
---

# Concerns — VieForce HQ Desktop

## P0 — Security & trust boundaries

| Concern | Evidence | Risk |
|---------|----------|------|
| **`/api/diag` exposure** | Was anonymously callable — **now gated** (`api/lib/require-diag-access.js`); set `DISABLE_DIAG=1` to hard-off | Resolved for Beta path — verify Cloud Run env after deploy |
| **`applyRoleFilter` pass-through** | `api/_auth.js` — roles admin→tsr return **unfiltered** `baseWhere` | Users may see national SAP data inconsistent with org role |
| **Session transport** | `x-session-id` = raw user UUID; login comments note **no JWT yet** | Session fixation / theft if XSS or leak — shorter TTL + signed token recommended |
| **Service role power** | Login + `_scope` reads use service role key on server | Correct pattern if keys never ship to browser — verify env hygiene in deploy |

## P1 — Reliability & ops

| Concern | Notes |
|---------|--------|
| **Rate limit** | Login rate limit is per-process memory — weak under horizontal scale |
| **Dual auth models** | `_scope.js` vs `applyRoleFilter` divergence increases bug surface |
| **Branch hygiene** | Development on `design-upgrade` vs `master` — risk merging wrong config (`js/api.js` embeds production API URL) |

## P2 — Product / completeness (Beta scope)

- Reports called out in platform audit as **partial**: Pivot, Customer Plotting, Team hierarchy, Budget P&L, Itemized district mapping nuances — confirm which block Beta vs post-Beta.
- **Audit trail / self-service PIN reset** — enterprise expectation for Beta may require Supabase functions or admin UX beyond current portal.

## P3 — Technical debt

- TODO in `api/_auth.js`: region/district filtering via OSLP join — scheduled “Phase 3” in comments.
- Client-side Supabase usage in `js/supabase.js` — ensure no sensitive reads remain after RLS lockdown.

## Patrol coordination (other agent)

- **Do not duplicate Patrol work** — session signing, offline queue, RLS alignment live primarily in `vieforce-patrol`. HQ must preserve **contract stability** for Patrol’s HQ client (`HQ_SERVICE_TOKEN`, scope query param, JSON shapes).
