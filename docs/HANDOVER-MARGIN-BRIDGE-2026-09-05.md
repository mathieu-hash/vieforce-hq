# Handover — Margin Explorer GM/ton bridge

**Repo** `C:\VienovoDev\vieforce-hq` · **Branch** `master` · **HEAD at handover** `8f34979` (deployed, CI green)
**Written** 2026-09-05 · **Audience** an incoming coding agent with no prior context

---

## 0. Read this first — the one thing that will bite you

**The bridge and the KPI tiles on the same screen measure different universes, on purpose.**

| | Scope | Unit |
|---|---|---|
| Hero tiles (Net Sales / GP / GP% / GM per kg) | `OITM.ItmsGrpCod IN (103, 105, 102)` — finished feed **+ trading-import + basemix** | ₱/kg |
| GM/ton bridge (dissection panel) | `ItmsGrpCod = 103` — **finished feed only** | ₱/ton |

They will never tie, and that is correct. `meta.data_quality.notes` says so in every response. Do not
"fix" this by aligning them without asking — the bridge is deliberately narrower because a Bennet
decomposition across trading goods and basemix is not interpretable.

Second trap: **`GrssProfit` excludes `OINV.DiscSum`** (off-invoice discount). The reported bridge is
therefore *pre-discount*. `net_bridge` in the same payload is the same decomposition net of allocated
`DiscSum` and is the one that tells the truth about price actions. Both are returned; the UI shows
both in separate panels.

---

## 1. What this system is

VieForce HQ — a sales/AR/inventory/margin dashboard for **Vienovo Philippines Inc.** (animal feed
manufacturer, PH). Reads **live SAP B1 (MSSQL)**. Roles: CEO / EVP / RSM / DSM, with row-level scoping.

- **Front-end** — vanilla JS (no framework, no build step), Chart.js 4.4.1. Deployed on **Vercel**.
- **Back-end** — `server.js` (Express) mounting Vercel-style handlers from `api/*.js`, on **Cloud Run**
  (`asia-southeast1`, project `vieforce-vpi`, service `vieforce-hq-api`).
- **Data** — SAP B1 MSSQL, dual database: `Vienovo_Live` (2026+) and `Vienovo_Old` (pre-2026).
  `api/_db.js` exposes `query` / `queryH` / `queryDateRange`, splitting at `MIGRATION_CUTOFF`
  (2026-01-01).
- **Never write to SAP.** SELECT only, always parameterised. This is a hard rule in `CLAUDE.md`.

### The Jan-2026 consolidation

Customer and SKU codes were **fully re-coded** on 2026-01-01, and item-group numbering changed
(`Vienovo_Old` finished feed = 103+104; `Vienovo_Live` = 103 alone). **Any customer×SKU comparison
that crosses that date is meaningless.** The bridge refuses rather than guesses — see the
`pre-2026 anchor` and `base window crosses the Jan-2026 consolidation` guards in
`api/margin-explorer.js`.

---

## 2. What the bridge actually computes

A **Bennet indicator** decomposition of the change in gross margin per ton, at **customer × SKU**
granularity, over finished feed.

Per cell, with `s` = tonnage share and `m` = unit margin ₱/ton:

```
s₁·m₁ − s₀·m₀  =  s̄·Δm  +  m̄·Δs        ← exact, no residual
                  └ Rate ┘   └ Mix ┘
   s̄·Δm  →  Price (s̄·Δp)  +  Cost (−s̄·Δc)
   m̄·Δs  →  composition
```

**HARD INVARIANT, unit-tested:** `price + cost + customer_mix + product_mix === delta`.
`reconciles: true` and `residual` are in every payload. If you change the maths and the residual
stops being ~1e-12, you have broken it.

Four design decisions that are easy to undo by accident — all documented at the top of
`api/lib/margin_bridge_v2.js`, read that header before touching the file:

1. **The mix split is order-neutral.** Customer-first and product-first orderings give different
   answers (measured: the customer bar moved from −251 to +3 ₱/t on 2026-08). The headline is the
   **symmetric (Shapley) mean**; `mix_ordering` carries the full range and `sign_stable`.
2. **Mix is centred on the blended margin** `(gm₀+gm₁)/2`. Centring does not change the total
   (`Σ Δs = 0`) but it is what makes per-row attribution economically right. Uncentred, every growing
   category looks accretive regardless of its margin.
3. **Churn is separated from weight shift.** A cell present in only one window has no price to
   compare, so 100% of its weight lands in Mix. `mix_detail.{one_sided_share_pct, matched_kg_share_pct,
   churn_dominated}` exist so a mix bar made of timing is visibly not a finding.
4. **The RM/packaging/feedtag cost split is an ESTIMATE** (`cost_components.estimated: true`) — a YTD
   production-order ratio priced at `OITM.LastPurPrc`, a current snapshot, not a per-period price.
   Do not promote it to a measured bar.

---

## 3. The window system — the part that changed on 2026-09-04

This is where the two most recent bugs lived. Both are fixed; understand the model before editing.

The bridge always compares a **base window** against a **compare window**. Three modes, all in
`api/lib/margin_window.js`:

| Mode | `base_mode` | When | Base window |
|---|---|---|---|
| Like-for-like | `like_for_like` | MTD/QTD/YTD, default | Prior month truncated to the **same elapsed shipping days** as the compare month |
| Full prior month | `full_prior_month` | MTD/QTD/YTD, `?bridge_base=full` | The **whole** prior month |
| Rolling | `trailing_window` | `period=7D`, automatic | The equal run of shipping days **immediately before** the selected range |

**Shipping days, not calendar days.** Sundays and PH holidays are excluded via
`api/data/shipping_calendar_ph.json` + `api/lib/shipping_days.js`. Matching calendar days would
silently compare 6 working days against 8.

**The elapsed window comes from `MAX(DocDate)` in scope, never the server clock.** v1 used
`new Date().getDate()-1`, which drifted with server timezone and ignored posting lag. The probe SQL
must apply the *same* scope and filters as the bridge, or the window is measured on a different
universe.

### Why `full` mode is dangerous and how that is handled

With a full base month against a partial compare month, **Price and Cost stay valid** — they compare
matched customer×SKU cells either way. **Mix does not**: a customer who simply has not ordered yet
this month reads as a cell exit and its entire weight lands in Mix.

`meta.mix_comparable` is `false` in that mode and the panel note says it in plain language. If you
add UI for this, de-emphasise the mix bars when `mix_comparable === false` — do not delete them,
the Bennet identity still needs all four to sum.

### Why the rolling mode had to exist

Before 2026-09-04, `period=7D` derived anchors from whichever calendar months the selected range
touched, then dropped the running month as "partial". Selecting *29 Aug → 4 Sep* returned a
**full-month July → August bridge** under a 7-day header, with nothing in the payload disclosing the
substitution. Verified against the live API before the fix.

Two changes made it work:

- `resolveTrailingWindow()` for rolling periods.
- **Drill rows are tagged by window (`'B'` / `'C'`), not by month key.** A month key cannot express a
  rolling pair — both sides can sit inside one month, or straddle two — and it dropped *every row*
  once the windows stopped being whole months. This is the single most important line in the change:

  ```sql
  SELECT CASE WHEN T0.DocDate>=@c0 AND T0.DocDate<@c1 THEN 'C' ELSE 'B' END win, ...
  ```

`base_month` / `compare_month` are **null** on a rolling bridge. Use `base_label` / `compare_label`
(e.g. `"24 Aug – 28 Aug"`) and `window.base_window` / `window.compare_window`. Emitting a
plausible-looking month key for a window that is not a month is exactly how the panel misled before.

**QTD and YTD are still month-anchored.** That is deliberate, not an oversight — switching them to
window-based would silently change what those views mean. If a stakeholder asks for
"this quarter vs last quarter", that is a new decision, not a bug fix.

---

## 4. File map

| File | What lives there |
|---|---|
| `api/margin-explorer.js` | The endpoint. Hero, matrix, trend, dissection, both bridges. ~950 lines. |
| `api/lib/margin_bridge_v2.js` | The Bennet maths. Pure, no I/O. **Read its header comment.** |
| `api/lib/margin_window.js` | Window resolution — all three modes. |
| `api/lib/margin_cube.js` | Cross-DB month cube, trajectory, `priceDrill`, ingredients. Month-based by design. |
| `api/lib/shipping_days.js` + `api/data/shipping_calendar_ph.json` | PH shipping calendar. |
| `api/_db.js` | Dual-DB pools, `MIGRATION_CUTOFF`. |
| `js/margin-explorer.js` | Page controller: filter state, 2-phase fetch, bridge panel render. |
| `js/margin-explorer-bridge.js` | Chart.js waterfall renderers. |
| `js/margin-explorer-dissection.js` / `-netbridge.js` / `-matrix.js` | The other panels. |
| `api/lib/__tests__/margin_bridge_v2.test.js` | 60 assertions: exactness, lenses, windows, significance. |
| `docs/MARGIN-BRIDGE-V2.md` | Why v2 replaced v1, with the placebo test. Read after this doc. |
| `ROLLBACK-2026-09-04.md` | Rollback procedure + verified reference numbers. |

Key anchors: `api/margin-explorer.js:73` (`bridgeBase` param), `:623` (`rollingBridge`),
`:657` (window selection), `:672` (`DRILL_SQL`), `:703` (window-tag filter).
`api/lib/margin_window.js:65` (`resolveLikeForLike`), `:166` (`resolveTrailingWindow`).
`js/margin-explorer.js:87` (`BRIDGE_BASES`), `:562` (`refetchBridgeOnly`), `:744` (header labels).

### Two-phase fetch — don't collapse it

Phase A (`include=bridge,trend,movers,gap`) is fast and paints hero + matrix. Phase B
(`include=dissection`) runs the heavy cross-DB cube and paints the bridges. `LAST.fetchSeq` supersedes
both. `bridge_base` is sent **only** on phase B (`dissectionParams()`), so toggling it re-runs phase B
alone and phase A keeps one cache entry. If you add a knob that affects only one phase, follow that
pattern.

---

## 5. How to verify anything — SAP is VPN-gated

**`analytics.vienovo.ph:4444` is reachable only from Cloud Run.** Your laptop cannot connect
(`Failed to connect ... in 15000ms`). Local gcloud also cannot refresh non-interactively — Workspace
reauth needs a TTY. Neither is a blocker; **the deployed API is the wire to SAP**:

```bash
TOK=$(grep '^HQ_SERVICE_TOKEN=' .env.local | cut -d= -f2- | tr -d '\r')
API=https://vieforce-hq-api-1057619753074.asia-southeast1.run.app
curl -s -H "Authorization: Bearer $TOK" \
  "$API/api/margin-explorer?period=MTD&ref_month=2026-09&include=dissection" | jq .
```

Never print the token. `scripts/smoke-margin-explorer.mjs` calls the handler in-process but needs SAP
reachability, so it is useless from the laptop — use curl.

Useful query params: `period` (7D/MTD/QTD/YTD), `ref_month=YYYY-MM`, `region`, `bu`, `customer`,
`group_by`, `compare` (pp/ly), `bridge_base` (lfl/full), `include`.

### Regression baseline — verified against live SAP, 2026-09-04

Capture these before and after any change to the window or drill logic.

| Case | Base window | Compare window | GM/t | Bars |
|---|---|---|---|---|
| MTD `lfl` (default) | 2026-08-01 → 08-05 (4d) | 2026-09-01 → 09-04 (4d) | 6,348 → 6,255 | price +241, cost −269, custmix −107, prodmix +43 |
| MTD `full` | 2026-08-01 → 08-31 (25d) | 2026-09-01 → 09-04 (4d) | 6,458 → 6,255 | price +207, cost −205, custmix −141, prodmix −64 |
| 7D rolling | 2026-08-24 → 08-28 (5d) | 2026-08-29 → 09-04 (5d) | 6,604 → 6,546 | price +31, cost −33, custmix −70, prodmix +14 |

Two independent cross-checks that should still hold:

- MTD `lfl` must be **bar-for-bar identical** to the pre-2026-09-04 behaviour — the drill-query rewrite
  changed nothing about the existing answer.
- `full` mode's prior bar (**6,458 ₱/t**) equals the full-August finished-feed GM/t taken from
  `dissection.trajectory`, a different code path. If those diverge, the truncation logic is wrong.

Context for reading these: full-month August on the *hero* scope was ₱6.46/kg (₱602.2M net sales,
₱115.3M GP, 19.1%). July finished feed was ₱6,728/t.

### Tests

```bash
npm test                                        # 164 assertions, whole repo
node api/lib/__tests__/margin_bridge_v2.test.js # 60, bridge + windows
node scripts/ci-scan-client.mjs                 # client-bundle secret scan (CI gate)
```

Offline SQL validation, since you cannot run the query: parse the generated `DRILL_SQL` with
`node-sql-parser` (`transactsql` dialect), substituting `[@OITMSSG]` → `OITMSSG` and keeping `@params`
as-is. That catches syntax and GROUP BY mistakes before a deploy.

---

## 6. Deploy and rollback

**Push to `master` IS the deploy.** `.github/workflows/deploy-cloud-run.yml` builds and routes traffic
to latest; Vercel auto-deploys the front-end from the same push. `ci.yml` runs tests on the same
trigger.

> `DEPLOY_RECON.md` section 1 says "no CI/CD pipeline exists". **That section is stale** — the banner
> at the top of that same file corrects it. Do not treat expired local gcloud as a deploy blocker;
> that mistake has already been made twice.

There is no staging environment, and the workflow routes traffic immediately. **Every push to
`master` ships to the CEO's dashboard, including a docs-only commit.** Batch doc changes with code.

Rollback is a traffic switch, not a rebuild — full procedure in `ROLLBACK-2026-09-04.md`:

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 --project vieforce-vpi \
  --to-revisions vieforce-hq-api-00164-95z=100     # pre-2026-09-04 production
```

Front-end: Vercel → project `vieforce-hq` → Deployments → `vieforce-oazickg9t` → Promote to Production.
Git rollback point: tag `rollback/2026-09-04-pre-bridge-windows` → `548dd3d`.

---

## 7. Open items, ranked

**1 — `significance` scores against the wrong band.** It compares the delta to *full-month*
month-over-month deltas even when the current window is a 4-day truncation. It should score against
same-truncation historical windows. Currently suppressed entirely for 7D (a 7-day move would read as
"noise" by construction), which is a stopgap, not a fix.

**2 — Concentrates pollute scope 103.** 13 VIETOP 2%/5% SKUs sell at 137–252 ₱/kg with 68–180 ₱/kg
margin — 0.2–0.6% of tons but up to 4.2% of GP. One customer (CCPC, ~22 t/month) swings the headline
by 50–180 ₱/t on its order date alone. Proposed: an `?exclude_concentrates=1` flag plus a standing
`concentrate_impact` figure so the number is visible before anyone fences them out. **Not implemented
— it changes reported numbers and is a business call, not an engineering one.**

**3 — Front-end under-uses the payload.** The API returns `mix_ordering`, `mix_detail`, `lenses`,
`significance`, `window`. The bridge panel now shows window labels and the churn warning in the note,
but still does not **suppress the customer/product split when `sign_stable === false`**, and does not
visually de-emphasise mix bars when `mix_comparable === false`. `js/margin-explorer-netbridge.js:94`
already reads `sign_stable` — follow that pattern.

**4 — Sunday asymmetry.** Shipping-day counting treats Sundays as closed, but SAP has occasional
Sunday invoices (2026-07-05: 79.8 t, ~1.8% of that window). Truncation is symmetric so the bias is
small; a data-driven "posting days with volume" match would be tighter.

**5 — Cosmetic wart.** `js/margin-explorer.js:769` hardcodes a `'June '` prefix on the partial-read
badge when the compare month is June — a leftover from a debugging session. Harmless (with
`compare_month` now null on 7D it cannot fire spuriously) but it should go.

---

## 8. House rules that are not negotiable

- **`C:\VienovoDev` is the professional root.** `C:\MatDev` is personal and must never be read,
  quoted, or mixed in without Mat's explicit per-instance approval. No OneDrive paths.
- **No writes to SAP, ever.** SELECT only, parameterised only.
- **Never hardcode credentials.** Env vars only; `.env.local` is git-ignored.
- **Never auto-deploy without confirmation** — and remember that on this repo, pushing to `master`
  *is* deploying.
- **Surgical changes.** Match surrounding style; don't refactor what isn't broken; mention unrelated
  dead code rather than deleting it.
- **Separate design from implementation** when reporting. If something is built but not deployed, or
  computed but not verified, say so.
- Commits: imperative mood, specific. Not "update" or "fix".

---

## 9. Suggested first move

Re-run the three regression cases in §5 against the live API and confirm they still match. That
exercises the whole path — auth, dual-DB, window resolution, the drill query, the Bennet maths and
the reconciliation invariant — in about a minute, and tells you the system is healthy before you
change anything.
