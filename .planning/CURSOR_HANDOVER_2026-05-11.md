# VieForce HQ — agent handover (2026-05-11)

Use this file to onboard a fresh Cursor agent. Sibling repo: **`C:\VienovoDev\vieforce-patrol`**.

---

## Repo & deploy

| Item | Value |
|------|--------|
| **Path** | `C:\VienovoDev\vieforce-hq` |
| **Branch** | `master` (tracks `origin/master`) |
| **HEAD** | `7e7c5e8` — `feat(admin): include region/district/territory on linked Supabase user in /api/admin/sap-reps` |
| **Production URL** | https://vieforce-hq.vercel.app |
| **Deploy** | Push to `master` → Vercel auto-deploy. Do **not** use `git-master` preview alias for OAuth (team SSO / redirect issues). |
| **Tests** | `npm test` → **76 pass** (no build step) |
| **Supabase project** | `yolxcmeoovztuindrglk` (HQ + Patrol share) |

**Conventions:** ES5 `var` in `app.html` (no arrows in inline scripts). Serverless API in `/api/`. Parameterized `mssql` only. Conventional Commits. **Only commit when Mat asks.**

---

## What Mat is doing

- **EVP review** of deployed HQ with numbered tables (`js/table-numbers.js`). Expect feedback like “Table #17 — column X should be Y”.
- **Patrol coordination** — contract changes go through HQ APIs; Patrol consumes them (see Patrol handoff below).

---

## Architecture you must not confuse

1. **Period chip (7D / MTD / QTD / YTD)** — **server-side**. `PD` in `app.html`, `vfApiParams()` → `?period=` → `getPeriodDates()` in `api/_auth.js`. Cache keys must include `period` when response varies.
2. **Compare chip (vs PP / vs LY)** — **client-side only**. `CMP`, `setCmp()` does **not** refetch; UI picks `delta_pct` vs `delta_pct_ly` (or `vs_pp` vs `vs_ly` on tables).

---

## Completed work (this sprint)

### Honesty sprint + audits (early May)
- Period + PP/LY audits: `.planning/CURSOR_SESSION_LOG_2026-05-09.md`, `.planning/AUDIT_COMPARE_PP_LY.md`
- Unified plan: `.planning/PERIOD_AND_COMPARE_FIX_PLAN.md` (plan text is **stale** on “what’s left” — use **this handover** + git log)

### Batches A–D + Patrol API (commits `df17059` → `7e7c5e8`)

| Batch | Status | Summary |
|-------|--------|---------|
| **A** | Done | Home region table, EVP/RSM compare, BU split prototype footer removed |
| **B** | Done | `api/team.js`, `dsm-home.js`, `sales.js`, `speed.js` PP/LY parity + client wiring |
| **GM fix** | Done | Separate **GM/Ton** (`dp.gmt`) and **GM %** (`dp.gross_margin`) chips on Sales |
| **C** | Done | Labels: Deeper Analytics T12M, Sales monthly trend T12M, Customers T12M tooltip |
| **D** | Done | Insights **120-day** active universe (`intelligence_v5` cache); Budget **period-paced** actuals; AR/Customers **period N/A** subtitles |
| **Patrol** | Done | `/api/admin/sap-reps` → `linked_supabase_user` now includes `region`, `district`, `territory` |

### Mat’s product decisions (do not re-litigate without asking)

| Surface | Decision |
|---------|----------|
| **AR** | Always YTD snapshot as-of today. Period chip **does not apply**. |
| **Customers list** | T12M revenue. Period chip **does not apply**. |
| **Budget** | Annual budget figure is **static**; **actual + pacing** follow period chip. |
| **Insights** | Active universe = last purchase within **120 days**; older = lost (excluded). **Legacy AR** stays activity-agnostic. Period chip **does not apply**. |
| **Deeper Analytics / Sales monthly trend** | Fixed 12-month windows; labeled honestly. |

---

## Remaining work

### Batch E — not started (cleanup / low priority)

From `.planning/PERIOD_AND_COMPARE_FIX_PLAN.md` Tier 4 + locked Tier 3 items:

| # | Item |
|---|------|
| 3.5 | Customer 360 — lock delta as “vs LY” (don’t wire global `CMP`) |
| 3.6 | Itemized — leave `compare_year` independent |
| 3.7 | Intelligence domain metrics — leave independent; optional subtitle |
| 4.1 | `vieforce-hq-desktop.html` — hide cosmetic compare chips (mirror period hide `474b0de`) |
| 4.2 | `vieforce-hq-desktop.html` — remove prototype `initCharts` data |
| 4.3 | Empty Chart.js canvases on real-data tabs (wire or remove) |

**Also update** `.planning/PERIOD_AND_COMPARE_FIX_PLAN.md` status section — it still lists Batch D as pending.

### EVP-driven (primary queue)

- Apply table-numbered comments from EVP review iteratively.

### Pre-launch / UAT (human + optional agent)

- `.planning/phases/04-beta-uat/4-UAT.md` — admin flows A1–A6 largely `[pending]`
- `.planning/ADMIN_VALIDATION_CHECKLIST.md`
- **SAP user swap:** replace `gsheet` with read-only `vieforce_hq_ro` before public beta (session log; not coded)
- **Optional:** Patrol e2e for stale-session OAuth bug (Patrol repo)

### Known footgun (not fixed)

- `js/pg-admin-team.js` hardcodes `API_BASE` to **Cloud Run** while HQ also deploys on **Vercel**. Admin team page may hit wrong host depending on env.

---

## Key files

| Area | Files |
|------|--------|
| Main UI | `app.html` (loaders, `PD`/`CMP`, `vfApiParams`, `setPd`, `setCmp`) |
| EVP desktop | `vieforce-hq-desktop.html` (cosmetic chips mostly hidden) |
| Auth | `js/auth.js`, `scripts/patch-supabase-auth-url.mjs` |
| Period helper | `api/_auth.js` (`getPeriodDates`) |
| Budget pacing | `api/budget.js`, `api/lib/shipping_days.js` (Mon–Sat) |
| Insights | `api/intelligence.js` (cache `intelligence_v5_*`) |
| Patrol SAP reps | `api/admin/sap-reps.js` |
| Admin team UI | `pg-admin-team.html`, `js/pg-admin-team.js` |
| Tests | `tests/` (incl. `oauth-redirect-contract.test.js`, sap-reps shape) |

---

## Message for Patrol (already shipped)

`/api/admin/sap-reps` → `linked_supabase_user` now includes `region`, `district`, `territory` (null when unset). No client change required if they read those keys. Live on prod.

---

## Full conversation transcript

`C:\Users\Mathi\.cursor\projects\c-VienovoDev-vieforce-hq\agent-transcripts\12135d63-c598-4719-9e4f-d2a2bd91c164\12135d63-c598-4719-9e4f-d2a2bd91c164.jsonl`

Search keywords: `period`, `CMP`, `Batch`, `EVP`, `sap-reps`, `120-day`, `budget pacing`.

---

## Suggested first prompt for the new agent

```
Continue VieForce HQ at C:\VienovoDev\vieforce-hq.
Read .planning/CURSOR_HANDOVER_2026-05-11.md first.
Mat is in EVP review — apply table feedback when he provides it.
Optional: run Batch E from PERIOD_AND_COMPARE_FIX_PLAN.md if Mat asks.
Do not commit unless Mat asks. npm test must stay at 76+ pass.
```
