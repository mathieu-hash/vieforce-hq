# Cursor session log — resume here (2026-05-09)

Use this file to pick up after the **EVP review prep + period-filter audit** session without re-reading the chat. Pairs with `CURSOR_SESSION_LOG_2026-05-03.md` (still valid for Patrol/SAP/MCP context).

---

## What's deployed right now

| Item | Value |
|------|-------|
| Production commit | `9b8d509` (master HEAD; remote in sync, working tree clean) |
| Vercel deployment | `dpl_7BGExmHcbNP72J7hxiT8SstMyqdU` — ● Ready, built 4s |
| **EVP review URL (canonical, public)** | `https://vieforce-hq.vercel.app` |
| Immutable build URL | `https://vieforce-mj1hrjjik-mathieu-7782s-projects.vercel.app` |
| Vercel SSO-gated alias (do **not** share externally) | `https://vieforce-hq-git-master-mathieu-7782s-projects.vercel.app` ← returns 401 to anyone outside the Vercel team |
| HQ tests | 76/76 pass |
| Patrol tests | 113/113 pass (separate repo) |

**OAuth landing behavior:** Supabase `site_url` is hardcoded to `https://vieforce-hq.vercel.app` (`scripts/patch-supabase-auth-url.mjs:59`). Any OAuth flow returns to this URL regardless of which Vercel preview/alias the user started on. **This is correct behavior** — don't try to "fix" by changing `site_url` per-deployment.

---

## What shipped today (5 commits, all on `master`)

| SHA | Scope |
|-----|-------|
| `0f6d27e` | `fix(auth)` — block patrol redirect on HQ Google OAuth + lock with contract test (`tests/oauth-redirect-contract.test.js`) |
| `385a601` | `feat(ui)` — auto-stamp `Table #N` pills via `js/table-numbers.js` + `css/table-numbers.css`, wired into `app.html`, `vieforce-hq-desktop.html`, `pg-admin-team.html`. Disable: `localStorage.setItem('hq_table_numbers','off')` |
| `e4c50cb` | `refactor(evp)` — removed mock decision cards from `js/evp-home.js` (`renderEvpDecisions()` deleted); simplified Customer Intelligence in `app.html` (Rescue 10→7 cols, Grow 9→6, Early Warning 11→6, Dormant 8→5, Legacy AR 8→5; region+rep folded into meta line; Priority col dropped; section titles shortened) |
| `c41fbfb` | `feat(api)` — `ref_month` point-in-time anchor across `dashboard/intelligence/sales/speed/team/margin` via shared `resolveRefMonthAnchor` in `api/lib/shipping_days.js` |
| `9b8d509` | `docs(planning)` — UAT session log + STATE/RUNBOOK/PATROL_HQ_CONTRACT notes |

---

## Active wait state

**Mat is reviewing HQ with the EVP.** Expecting feedback in the form of `Table #N — column X should be Y` notes. Apply iteratively, one atomic commit per change, push to deploy.

`js/table-numbers.js` numbers tables in **DOM order** at page render. To locate the source of a referenced `Table #N`, search the wired pages (`app.html`, `vieforce-hq-desktop.html`, `pg-admin-team.html`) — start with `app.html` since it's the main dashboard.

---

## Decisions made (and rejected) this session

| Decision | Outcome | Rationale |
|----------|---------|-----------|
| Write a UAT execution helper script | **Rejected** | One-pass UAT run — 30 min to save 10 min is negative ROI. Manual click-through is fine. |
| Open `.planning/PRELAUNCH_CHECKLIST.md` to track `gsheet → vieforce_hq_ro` SAP user swap | **Recommended, not yet written** | The `gsheet` swap is mentioned twice in `CLAUDE.md` but not tracked anywhere actionable in `.planning/`. Easy 5-min fix to prevent it being forgotten between Beta sign-off and prod cutover. **Pick this up if Mat confirms — agent rotated before doing it.** |
| Patrol e2e regression for stale-session OAuth bug | **Parked (optional)** | Lives in `vieforce-patrol`, not this repo. Bug already fixed in code; test would lock it in. |
| Collapse-by-default the 3 Deeper Analytics sections in `pg-insights` | **Parked (only if EVP signals)** | Wait for review feedback before refactoring. |

---

## Period filter audit (run 2026-05-09) — DO NOT redo, reference here

**Headline:** 7D / MTD / QTD / YTD chip works on **roughly half** the dashboard. Main KPI pipeline (Home, EVP Home, Sales, Speed, Margin, Team) honors it. **AR, Inventory, Customers, Customer Detail, Budget, Itemized, DSM Home, the entire Insights tab, and the 3 Deeper Analytics widgets silently ignore it.**

### Architecture (so the next agent doesn't re-derive)

- Global state in `app.html`: `PD` = active period (default `MTD`, `localStorage['vf_period']`), `VF_REF_MONTH` = anchor month, `vfApiParams()` injects both into fetches.
- `setPd()` (line 4249–4260) clears `DC` cache and calls `loadPage(PG)` for the active tab only.
- Backend chain: `req.query.period` → `getPeriodDates(period, { refMonth })` from `api/_auth.js` → `dateFrom`/`dateTo` in SQL `BETWEEN`.
- Period **must be in cache key** for chip changes to invalidate (verified in `dashboard.js`, `sales.js`, `speed.js`, `team.js`, `margin.js`; **missing in `intelligence.js`** which is one of the bugs).

### Top 5 bugs ranked by user-visible damage

1. **`api/intelligence.js` — sends `?period` but doesn't read it.** Cache key is `intelligence_v4_${session.id}_${refMonthKey}_...` — period not in key. Worst kind of bug: looks wired, isn't.
2. **AR page — completely period-blind.** `getARData()` called with no params from `app.html:4828`, also Home `:4361` and EVP `js/evp-home.js:63`. `api/ar.js` doesn't read period.
3. **Deeper Analytics — 3 widgets, all 12-month hardcoded.** `analytics-sku-matrix.js:84`, `analytics-brand-coverage.js:55+`, `analytics-buying-patterns.js:64` use `DATEADD(MONTH,-12,GETDATE())`. Either wire period or relabel as "Trailing 12 months."
4. **`js/rsm-home.js:171–172` forces `period: 'MTD'` on dashboard call** regardless of chip. One-line fix.
5. **`api/sales.js:102` — `monthly_trend` always last 12 months.** Comment in code admits it. Either scale window to period or label explicitly.

### Sneaky issues worth eyeballing

- `initCharts()` in `app.html:7367+` still has prototype hardcoded data for `pg-sales`, `pg-speed`, `pg-margin`, `pg-custdetail` — leftover from the original mockup. Renders alongside real API data.
- `api/team.js:91–93, 179–190` — selected period for revenue, hardcoded MTD for ODLN side column. Probably intentional, label needs to make this clear.
- `api/budget.js:2` — `getPeriodDates` imported but never called. Dead code from someone who started wiring period and stopped. Currently calendar YTD only.
- `vieforce-hq-desktop.html` period chips are **purely cosmetic** — `setPd()` only toggles a CSS class (line 2950), no `localStorage`, no `loadPage`, no fetch. If EVP reviews from here he's looking at static design.

### Recommended sprint (after EVP review surfaces real priorities)

**Quick wins (1–2 hrs, client-side):**
- Pass `vfApiParams()` from `loadAR()`, `loadCust()`, `loadBudget()`
- Fix `js/rsm-home.js` MTD hardcode (1-line)
- Strip misleading `vfApiParams()` from `loadIntelligence()` until backend is fixed (so it doesn't *look* wired)

**Backend wiring (half-day each):**
- `api/intelligence.js` — add period support, include in cache key
- `api/ar.js` — define what "period" means for AR (cutoff date for aging? invoice issue date?), then wire it
- `api/budget.js` — finish what someone started

**Decisions needed (label vs implement):**
- Deeper Analytics — wire period or relabel
- Sales `monthly_trend` — period-scaled or relabel
- Customers `ytd_revenue` — period-scoped or rename to make the rolling year explicit

---

## Sibling repo note — Patrol

A cross-account OAuth bug (Mat ended up logged in as Windel because `vieforce-patrol/index.html` short-circuited on stale `patrol_session` before processing OAuth `?code=`) was **fixed in code** in `vieforce-patrol` during the same session. **Status of that fix in the Patrol repo is unknown to this agent** — verify with `git status` in `C:\VienovoDev\vieforce-patrol` before assuming it's deployed. Patrol tests are 113/113.

---

## Suggested resume actions (in priority order)

1. **If EVP feedback has arrived:** apply table-numbered comments iteratively; one atomic commit per change; push to deploy.
2. **If no feedback yet:** write `.planning/PRELAUNCH_CHECKLIST.md` (5-min task) — see "Decisions" section above for scope.
3. **If feedback drains and Mat wants to proactively close items:** start the period-filter sprint with the "Quick wins" tier above. They're all 1-line client-side changes that don't require backend coordination.
4. **Always:** verify `git status` is clean before pushing; the Vercel git-integration auto-deploys on `master` push but the alias `vieforce-hq.vercel.app` updates automatically — no manual `vercel alias set` needed for git-pushed deploys (only needed for `vercel deploy --prod` from CLI).

---

## How to update this log

Append a dated section when closing the session, or supersede with a new `CURSOR_SESSION_LOG_<date>.md`. Move stale logs to `.planning/archive/` if `.planning/` gets noisy.
