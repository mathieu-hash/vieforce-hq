# PP/LY compare audit — VieForce HQ
**Date:** 2026-05-09
**Cross-reference:** [`CURSOR_SESSION_LOG_2026-05-09.md`](./CURSOR_SESSION_LOG_2026-05-09.md) — period-filter audit + honesty fix sprint addendum

---

UI labels: **vs PP** / **vs LY** — same idea as "comparison period."

## How the toggle actually works

| Piece | Behavior |
|--------|----------|
| **State** | `CMP` = `vs_pp` \| `vs_ly`, from `localStorage['vf_compare']`, default `vs_pp` (`app.html:3918`). |
| **UI** | Top bar `setCmp()` → updates chip + `CMP` → `loadPage(PG)` **without refetch** (`app.html:4262–4271`). |
| **Design assumption** | Comment in code: *"data already has both delta_pct and delta_pct_ly"* — client only **re-picks** which object to show. |
| **API param** | **None.** Compare mode is **not** sent to the server. |

So anything that only returns **one** comparison (or no `%`) can **never** follow the toggle until the payload gains a second series or the client computes both.

## Backend: who ships **both** PP and LY deltas?

| Endpoint | `delta_pct` (vs PP) | `delta_pct_ly` / LY analog | Notes |
|----------|---------------------|----------------------------|--------|
| **`api/dashboard.js`** | Yes (revenue, volume ODLN, GM, GM/T) | Yes (same shape) | **`region_performance[]`** has **`vs_pp` and `vs_ly`** per region. |
| **`api/sales.js`** | Yes (vol, revenue, gmt) | Yes (+ **YTD** vol/revenue in `delta_pct_ly`) | **No `gross_margin`** in either delta object (unlike dashboard). |
| **`api/speed.js`** | **`vs_prior_period_pct`** (prior window) | **`vs_last_month_pct`** (calendar LM) | **No "vs LY" for pullout** — cannot mirror dashboard semantics without new SQL. |
| **`api/team.js`** | **No** national/RSM `% vs PP` | **`vs_ly` / `vs_ly_pct`** only | Scorecard is **YTD vs LY-style** only; no prior-period column in payload. |
| **`api/dsm-home.js`** | **`vs_pp_pct`** on sales | No symmetric `vs_ly` in the grep path | DSM hero is **PP-only**. |
| **`api/itemized.js`** | N/A (calendar year grid) | **`vs_ly_pct`** per SKU / district | Separate model from global `CMP`. |
| **`api/customer.js`** | Not exposed as headline delta | Monthly **CY vs LY**; insight math **prior 3 mo** | Detail page hardcodes **"vs LY"** for YTD delta. |
| **AR / Margin / Inventory / Budget / Intelligence / analytics-*** | Mostly **no** PP/LY toggle concept | Some internal `%`s | Not wired to top-bar `CMP`. |

## Frontend: what **honors** `CMP`?

### Working

| Surface | Evidence |
|---------|----------|
| **Home — KPI row** (Sales ₱, Volume, GM ₱, GM/Ton) | `app.html:4390–4425` picks `dp` from `delta_pct` vs `delta_pct_ly`. |
| **Sales — KPI deltas** (vol / sales / gmt) | `app.html:4627–4637` same `dp` pattern. |

### Broken or misleading vs toggle

| Surface | Problem |
|---------|---------|
| **Home — Region table** | Always renders **`r.vs_pp`**; **`r.vs_ly` ignored**. Header stays **"vs PP"** (static HTML). `app.html:4461–4466` |
| **Home — BU Split card** | Only **`home-bu-title`** gets period text; **bars / "vs PP" footer look like prototype** — not driven by `CMP` or live deltas in `loadHome`. |
| **Sales — Avg speed delta** | **`sk-speed-d`** always **`sp.vs_prior_period_pct`** → **always PP-shaped**, ignores `CMP`. `app.html:4640–4643` |
| **Speed tab** | **`vs_prior_period_pct`**, **`vs_last_month_pct`** — neither keyed off `CMP`; no LY pullout % in API. `app.html:5196–5209` |
| **EVP home** | **`js/evp-home.js`** uses **`dash.delta_pct` only**; label hardcoded **"vs PP"**. `js/evp-home.js:123–128` |
| **DSM home** | **`vs_pp_pct` only**, copy says **vs PP**. `js/dsm-home.js:124–128` |
| **RSM home** | Hero trend uses **`rsm.vs_ly`** — **LY semantics**, not toggle-aware (no `vs_pp` branch). `js/rsm-home.js:251–254` |
| **Team tab** | **`vs_ly` / `vs_ly_pct` only** — no PP alternative in API/UI. `app.html:6576–6608` |
| **Customer 360** | YTD volume delta **always "vs LY"** from monthly rollups. `app.html:5444–5456` |
| **Itemized** | Own **`compare_year`** + **vs LY %**; **independent** of `CMP`. |
| **Intelligence + Deeper Analytics** | **`delta_pct`** etc. are **domain metrics** (e.g. cadence), not dashboard compare mode — **not linked** to `CMP`. `app.html:6485–6498` |
| **`vieforce-hq-desktop.html`** | Chips call **`setCmp` that only toggles CSS** — **does not set `CMP` or `localStorage`**. `vieforce-hq-desktop.html:2951` |

### N/A (no comparison % tied to global toggle)

AR, Inventory, Margin tables, Customers list, Budget achievement charts — **no** top-bar PP/LY behavior (correct to classify as **out of scope** unless product wants them linked).

## Top issues (ranked)

1. **Region performance table** — Data includes **`vs_ly`**; UI **always shows PP** → toggle feels broken on the row users read next to KPIs.
2. **Sales speed delta** — Mixed semantics: KPIs follow `CMP`, **speed line does not**.
3. **EVP / DSM / RSM role homes** — Each picks **PP or LY ad hoc**; **none** read `CMP`.
4. **Team scorecard** — **LY-only**; toggling **vs LY** globally **cannot** switch those columns to PP without **`vs_pp` (or similar) in `api/team.js`**.
5. **`speed.js`** — No **LY-equivalent** for daily pullout delta; **cannot** honor **vs LY** without backend work.
6. **Desktop HTML** — Compare chips **cosmetic** (same class of bug as period chips there).
