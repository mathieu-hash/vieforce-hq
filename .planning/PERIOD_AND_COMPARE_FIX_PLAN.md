# Period filter + PP/LY compare — unified fix plan (2026-05-09)

Single source of truth for what's left after today's audits + honesty sprint.
Both audits (period + compare) are persisted in their own files — this plan
references them rather than duplicating their content.

## Status snapshot

### What's done

- **Honesty sprint** for period filter — six atomic commits on `master` ending at `49aad46`:
  - `3555ddc` — RSM Home period wiring (dashboard fetch now uses selected `PD`, not hardcoded MTD)
  - `d42ff1d` — strip misleading `?period` from `loadIntelligence()` fetch (backend was no-op)
  - `79a9098` — fixed-window labels added (Intelligence "T36M" / "90-day dormancy"; AR "snapshot"; Team `MTD ODLN` column header)
  - `44459fc` — dead `getPeriodDates` import removed from `api/budget.js`
  - `35e4fac` — prototype `Chart.js` demos removed from `initCharts()` for sales / BU GM / speed sparkline / customer / margin
  - `474b0de` — cosmetic period chips hidden on `vieforce-hq-desktop.html`
- **Audits captured:** see `CURSOR_SESSION_LOG_2026-05-09.md` (period) and `AUDIT_COMPARE_PP_LY.md` (compare).

### What's left

- **Period filter:** backend wiring for Intelligence / AR / Deeper Analytics / `monthly_trend` / Budget; client-side `vfApiParams()` plumbing for `loadAR()` / `loadCust()` / `loadBudget()`; several label-vs-implement decisions; empty canvases on real-data tabs.
- **PP/LY compare toggle:** Home Region table + 3 role homes ignore `CMP`; Sales speed delta + Speed tab use prior-window only; Team / DSM / Customer 360 backends ship only one side of the comparison; `vieforce-hq-desktop.html` compare chips are cosmetic.

## Architecture note (critical context)

Period filter and PP/LY compare are **two independent mechanisms** that look similar in the UI but live on opposite sides of the wire:

- **Period filter** = **server-side** concern. Changing the chip changes the SQL `BETWEEN` window. Caches must include `period` in the cache key. Fixing a "period is ignored" gap requires backend SQL work.
- **PP/LY compare** = **pure client-side render** concern. `setCmp()` does not refetch — it just re-picks `delta_pct` vs `delta_pct_ly` from a payload that should already contain both series.

**Implication:** every gap in the compare toggle resolves to one of two shapes:
- **(a)** Payload already has both series → the fix is **client conditional logic** (Tier 1 — fast).
- **(b)** Payload has only one side → backend must add the missing field first, then client switches on `CMP` (Tier 2 — slower).

This is why the Region table fix on `app.html` is 30 minutes but the Team scorecard fix is half a day.

## Remaining work

> Tiers are ordered by **user-visible damage**, not by ease.
> Items already closed by commits `3555ddc`, `d42ff1d`, `79a9098`, `44459fc`, `35e4fac`, `474b0de` are excluded.

### Tier 1 — Quick wins (client-side, payload already has both sides)

| # | Item | Files | Effort | Recommended action |
|---|------|-------|--------|--------------------|
| 1.1 | **Home region table ignores `CMP`** — always renders `r.vs_pp`; header static "vs PP". `dashboard.region_performance[]` already ships both `vs_pp` and `vs_ly`. | `app.html:4461–4466` + header cell in static markup | 30min | Pick `r.vs_pp` vs `r.vs_ly` based on `CMP`; swap the static header cell to a dynamic span (`#home-region-cmp-label`) that mirrors KPI behavior. **Highest visible-damage compare bug** — sits next to KPIs that DO toggle. |
| 1.2 | **EVP home compare hardcoded to PP** — `dash.delta_pct` only; label hardcoded "vs PP". `dashboard` payload has `delta_pct_ly`. | `js/evp-home.js:123–128` | 30min | Switch on `CMP` (mirror the `dp` pattern from `app.html:4390–4425`); make label dynamic. |
| 1.3 | **RSM home hero trend uses `vs_ly` only** (separate concern from the period MTD fix in `3555ddc`). Code reads `rsm.vs_ly` from team payload, but `regionRow` is already pulled from `dash.region_performance` two lines earlier — that row has **both** `vs_pp` and `vs_ly`. | `js/rsm-home.js:251–264` | 30min | Replace `rsm.vs_ly` with `regionRow ? regionRow[CMP === 'vs_ly' ? 'vs_ly' : 'vs_pp'] : 0`; update arrow/label accordingly. |
| 1.4 | **`loadAR()` / `loadCust()` / `loadBudget()` don't pass `vfApiParams()`** — period chip is silently dropped at the client even though the backend definition is undecided. | `app.html:4828` (AR), and the corresponding `loadCust` / `loadBudget` call sites | 1hr (all three) | Pass `vfApiParams()`. Pair with Tier 2.6 / 2.7 / 2.8 backend definitions — until then param is a no-op but at least the client is honest about intent. **Defer** if Tier 2 backends won't ship in the same batch (otherwise ship breaks: chip changes do nothing visible, looks broken). |

### Tier 2 — Backend additions (payload missing one side of the toggle)

| # | Item | Files | Payload field to add | Client wiring | Effort |
|---|------|-------|----------------------|---------------|--------|
| 2.1 | **`api/team.js` has no `vs_pp` series** — scorecard is YTD-vs-LY-only; toggle cannot switch Team tab. | `api/team.js` (national + RSM rows) | `vs_pp`, `vs_pp_pct` (mirror existing `vs_ly` / `vs_ly_pct` shape) | `app.html:6576–6608` — pick by `CMP`; dynamic column header | half-day |
| 2.2 | **`api/dsm-home.js` is PP-only** — no LY analog for hero. | `api/dsm-home.js` | `vs_ly_pct` to mirror `vs_pp_pct` | `js/dsm-home.js:124–128` — switch on `CMP` | half-day |
| 2.3 | **`api/sales.js` delta objects missing `gross_margin`** — dashboard has it, sales doesn't (audit table footnote). | `api/sales.js` | `gross_margin` inside `delta_pct` and `delta_pct_ly` | `app.html:4627–4637` (already toggles, just gains a field) | 1hr |
| 2.4 | **Sales `sk-speed-d` always `sp.vs_prior_period_pct`** — ignores `CMP`; `api/speed.js` has no LY-equivalent for pullout. | `api/speed.js` (SQL: add LY-window pullout %); `app.html:4640–4643` | `vs_last_year_pct` (or similar) on speed payload | Switch on `CMP` | half-day |
| 2.5 | **Speed tab — `vs_prior_period_pct` / `vs_last_month_pct` not keyed off `CMP`** | same as 2.4 | (covered by 2.4) | `app.html:5196–5209` | included in 2.4 |
| 2.6 | **`api/intelligence.js` — period chip is a no-op** (top-1 period bug from session log; client param already stripped in `d42ff1d`). | `api/intelligence.js` | period applied to SQL window; **must** add `period` to cache key (`intelligence_v4_${session.id}_${refMonthKey}_...`) | Restore `vfApiParams()` in `loadIntelligence()` once backend is real | half-day |
| 2.7 | **`api/ar.js` — period-blind** (called parameterless from Home / EVP / AR page). | `api/ar.js` + `js/evp-home.js:63` + `app.html:4361, 4828` | Define what "period" means for AR (cutoff date for aging? invoice issue date window?) → wire it | Pair with Tier 1.4 client param plumbing | half-day (plus 30min decision) |
| 2.8 | **`api/budget.js` — period-blind** (calendar YTD only; `getPeriodDates` was imported then never used → already removed by `44459fc`). | `api/budget.js` | period-scoped achievement window | Pair with Tier 1.4 | half-day |

### Tier 3 — Decisions needed (label-only vs wire-through)

> Each gets one recommendation, not options.

| # | Question | Recommendation | Rationale |
|---|----------|----------------|-----------|
| 3.1 | **Home BU Split card** — bars + "vs PP" footer look like prototype; not driven by `CMP` or live deltas. Wire it through, or replace with honest static? | **Wire-through** in same batch as Tier 1.1 | Card sits in the Home hero band — leaving it as a prototype while neighbors react to `CMP` reads as a polish bug to the EVP. Underlying `dashboard` payload already has the pieces. |
| 3.2 | **Deeper Analytics widgets** — `analytics-sku-matrix.js:84`, `analytics-brand-coverage.js:55+`, `analytics-buying-patterns.js:64` are hardcoded `DATEADD(MONTH,-12,GETDATE())`. Wire to period or relabel "Trailing 12 months"? | **Label "Trailing 12 months"** (1 line each) | The analytical premise of these widgets requires a long stable window; period-scaling them produces unstable signal at MTD/QTD. Honesty over feature-creep. |
| 3.3 | **Sales `monthly_trend`** (`api/sales.js:102`) — last 12 months hardcoded. Scale to period or relabel? | **Label "Last 12 months"** | Same logic as 3.2; a 7D/MTD line chart is meaningless. Scaling adds backend work for negative product value. |
| 3.4 | **Customers `ytd_revenue`** rolling-year — period-scope or rename? | **Rename to `revenue_t12m`** (or add a tooltip) | Customers list is a discovery surface, not a period scorecard. Renaming is a 5-minute refactor; period-scoping is a backend redesign. |
| 3.5 | **Customer 360 YTD delta** — hardcoded "vs LY" (`app.html:5444–5456`). Honor `CMP` or lock the label? | **Lock as "vs LY"** | Customer-detail comparison semantics are calendar-year by domain convention (sales-rep mental model). Don't fragment per-customer comparison logic for a global toggle that's noisy at this granularity. |
| 3.6 | **Itemized** — uses its own `compare_year` and `vs LY %`, independent of `CMP`. Link to global toggle? | **Leave independent** | Itemized is a calendar-year grid by construction; `compare_year` is a richer control than a 2-state PP/LY chip. |
| 3.7 | **Intelligence + Deeper Analytics `delta_pct`** — these are domain metrics (cadence, etc.), not dashboard compare mode. Link to `CMP`? | **Leave independent** + add a one-liner subtitle clarifying "domain metric" if a reviewer flags it | Overloading `CMP` would change the semantic meaning of the field. |

### Tier 4 — Cleanup / low-priority

| # | Item | Files | Effort |
|---|------|-------|--------|
| 4.1 | **`vieforce-hq-desktop.html` — `setCmp` is cosmetic** (only toggles CSS class; no `CMP`, no `localStorage`, no `loadPage`). Same class of bug as the period chips already hidden by `474b0de`. | `vieforce-hq-desktop.html:2951` | 15min — hide compare chips block too (mirror the `474b0de` approach), or 1hr to wire fully |
| 4.2 | **`vieforce-hq-desktop.html` `initCharts()` paths still hold prototype data** (only the topbar chip row is hidden). | `vieforce-hq-desktop.html` (the unchanged `initCharts` block) | 30min to delete; longer if real wiring desired. Recommend delete (matches `35e4fac` posture for `app.html`). |
| 4.3 | **Empty canvases on real-data tabs** — `#salesTrendChart`, `#gmGroupChart`, `#speedSparkline`, `#custSalesGmChart`, `#marginRegionChart` may render blank until real Chart.js wiring exists. | `app.html` chart init paths + corresponding API shapes | 1–2hr per chart, depending on payload shape readiness |

## Proposed execution order

> Five batches. Each one ships independently and atomically.

1. **Batch A — Compare quick wins on Home / role pages** (Tier 1.1 + 1.2 + 1.3 + 3.1)
   *Why first:* highest user-visible damage, all client-side, no backend coordination, payloads already have both sides. Single deploy makes the toggle feel real where users look first.

2. **Batch B — Backend parity for compare toggle** (Tier 2.1 + 2.2 + 2.3 + 2.4/2.5)
   *Why second:* unblocks the rest of the dashboard's compare semantics. Each endpoint addition is independent — can be parallelized but ship as one batch so the client switch lands once with all four endpoints ready.

3. **Batch C — Period-filter Tier 3 decisions (label sweep)** (Tier 3.2 + 3.3 + 3.4)
   *Why third:* zero-risk label PRs that close the period audit's "Decisions needed" tier without backend work. Buys time before committing to Batch D scope.

4. **Batch D — Period filter backend wiring** (Tier 2.6 + 2.7 + 2.8 + 1.4 client plumbing)
   *Why fourth:* the heaviest tier. Should ship together: client param plumbing without backend gives a broken-feeling toggle on AR/Cust/Budget. The AR semantics decision (Tier 2.7) is the gating sub-step.

5. **Batch E — Cleanup + remaining label decisions** (Tier 3.5 + 3.6 + 3.7 + 4.1 + 4.2 + 4.3)
   *Why last:* polish + low-traffic surfaces. Empty canvases (4.3) only matter when someone notices; review-only desktop file (4.1, 4.2) is cosmetic.

## Out of scope / explicitly deferred

| Item | Reason for deferring |
|------|----------------------|
| AR / Inventory / Margin tables / Customers list / Budget achievement charts — wiring PP/LY toggle | Audit explicitly classified these as **N/A** for the global toggle. None ship a comparison `%` tied to `CMP` and there's no product ask to add one. Tracked here only so it doesn't get rediscovered as a "missed bug." |
| Itemized linkage to global `CMP` | See Tier 3.6 — its own `compare_year` is a richer control. |
| Customer 360 PP delta | See Tier 3.5 — calendar-year semantics are correct for that surface. |
| `vieforce-hq-desktop.html` full wire-through (vs hide) | Review surface only; mirroring `474b0de` (hide) is the cheaper honest move. |
| Patrol e2e regression for stale-session OAuth bug | Lives in sibling `vieforce-patrol` repo (per session log). Not in scope here. |
| `gsheet → vieforce_hq_ro` SAP user swap | Tracked in session log under "Decisions"; pre-launch checklist task, not a fix-plan item. |

## References

- [`CURSOR_SESSION_LOG_2026-05-09.md`](./CURSOR_SESSION_LOG_2026-05-09.md) — period audit (top section) + fix sprint addendum (bottom section)
- [`AUDIT_COMPARE_PP_LY.md`](./AUDIT_COMPARE_PP_LY.md) — PP/LY compare audit (file:line evidence for every Tier 1/2/3 item above)
