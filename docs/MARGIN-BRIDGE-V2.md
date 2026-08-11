# Margin Explorer bridge — v2

**Date:** 2026-08-10 · **Scope:** `api/margin-explorer.js`, `api/lib/margin_bridge_v2.js`, `api/lib/margin_window.js`
**Trigger:** the 2026-08 MTD screen reported GM/kg −0.43 with a Customer/BU Mix bar of −250 PHP/t.
A five-agent SAP audit (`C:\VienovoDev\_margin_mix_aug2026\SYNTHESIS.md`) found the arithmetic sound
but the *window*, the *mix split* and the *SSG panel* unreliable. This is the fix.

`margin_bridge.js` v1 is untouched and still exported — v2 is additive, so rollback is a one-line
revert of the `bridgeV2.bridgeExactGMperTon` call site.

---

## What was wrong

| # | Defect | Where | Effect on the 2026-08 screen |
|---|---|---|---|
| 1 | Hero tile compared against a **trailing equal-length window**; the bridge compared against a **full calendar month**. Two baselines, one "vs PP" label. | `margin-explorer.js:75-76` vs `:483-486` | Tile said −0.43/kg (baseline Jul 23–31, the month's best stretch); bridge said −0.29/kg (baseline full July). ~50% inflation. |
| 2 | **No truncation.** "(compare month partial)" was a cosmetic string; `compare_days` read the *server clock* (`new Date().getDate()-1`) and was never used to trim. | `margin-explorer.js:503-504, 607` | 7 posted days of August vs 23 posting days of July. 264 of 484 July customers (25% of tonnage) had no August counterpart and were booked as cell exits — and an exit's whole weight lands in Mix, never Price or Cost. Structurally biased toward "it's mix". |
| 3 | **Product Mix was a residual** (`cellMix − customerMix`), so the entire customer×product interaction landed in it and the split depended on which dimension went first. | `margin_bridge.js:486` | Customer bar = −258 customer-first, **+5 product-first**. The displayed ranking was a modelling choice, not a measurement. |
| 4 | **SSG panel allocated rather than measured** — each customer's mix spread across SSGs by average within-customer volume fraction. | `margin_bridge.js:467-484` | 4 of 8 categories carried the wrong sign. "OTHERS +55" is arithmetically impossible from a +0.08pp share move. |
| 5 | **Cost split presented as measured** when RM was a residual against a YTD-average production ratio priced at `OITM.LastPurPrc` (a current snapshot, not a per-period price). | `margin_bridge.js:443` | "Raw materials +122 / Packaging +2" carried a measured bar's authority. |

---

## What v2 does

### 1. Like-for-like windows, driven by data (`margin_window.js`)

`resolveLikeForLike()` finds the compare window's real end from **`MAX(DocDate)` in scope**, counts the
**shipping days** elapsed (Sundays and PH holidays excluded, via the existing
`data/shipping_calendar_ph.json`), and truncates the base month to the same count.

`priorPeriodWindow()` redefines the hero's vs-PP as *the same period one step back, truncated to equal
elapsed shipping days* — so tile and bridge finally share one baseline. MTD → prior month days 1..N;
QTD → prior quarter; YTD → prior year; 7D stays a trailing rolling window, which is what 7D means.
The current window's end is also re-derived from `MAX(DocDate)` so posting lag does not make the
current period look artificially short.

On 2026-08-10 this turns *Aug 1–8 (7 shipping days) vs all of July* into *Aug 1–8 vs Jul 1–8*.

### 2. Order-neutral mix split

Both orderings are computed and the **symmetric (Shapley) mean** is the headline; the full range is
published in `mix_ordering` so the reader can see how much of the split is a modelling choice.
`sign_stable: false` means the bar changes sign depending on ordering — do not quote it.

### 3. Centered mix — the subtle one

Every mix term is now valued as `(m̄ − M̄)·Δs`, not `m̄·Δs`. Since `Σ Δs = 0` the **totals are
identical**, but per-row attribution is not, and the uncentered form is economically backwards:
LAYER gaining 4.9pp of share at 4,718 PHP/t against a ~6,577 book average printed **+232** uncentered
(it added gross profit) versus **−93** centered (it diluted unit margin — which is what a GM/*ton*
bridge measures). Centering also cut the partial-window artifact materially: on the placebo below, the
fabricated customer-mix bar fell from +152 to +63 with no other change.

### 4. Churn separated from weight shift

`mix_detail` reports `continuing / entering / exiting`, the one-sided share of the mix effect, and what
fraction of current tonnage has a prior-period counterpart. `churn_dominated` fires when the effect is
>40% one-sided **or** matched cells cover <85% of current tonnage. On 2026-08 both windows fire.

### 5. Composition lenses replace the allocated SSG panel

`lenses.{ssg,bu,region,customer,sku}` — each a clean one-dimensional Bennet share-shift, internally
exact, with share, share-shift in pp, tonnage and GM/ton per row. Lenses are alternative views of the
same composition effect and **do not sum to each other or to the mix bars**; the payload says so.
`product_mix_by_ssg` is retained for the existing front-end panel but is now the *measured* SSG lens.

### 6. Honest labelling

`cost_components.estimated: true` with the basis spelled out. `significance` scores the delta against
historical month-over-month variation and returns `signal` / `weak` / `noise`. Scope difference between
hero `(103,105,102)` and bridge `(103)` is stated in `meta.data_quality`, along with `snapshot_at`.

---

## Verification

`node api/lib/__tests__/margin_bridge_v2.test.js` — 38 assertions, all passing:

- **Exactness**: `price + cost + customer_mix + product_mix === delta`, zero residual.
- **Axioms**: proportional volume growth → every bar 0. A pure same-cell price move → 100% Price.
  A pure same-cell cost move → 100% Cost.
- **Order-neutrality**: symmetric split = mean of both orderings, still sums to `mix_total`.
- **Churn**: `continuing + entering + exiting === mix_total`; flags fire on a churn-heavy fixture.
- **Windows**: MTD prior window starts on the 1st of the prior month (not day 23), is truncated, and
  carries equal shipping days on both sides. 7 shipping days from Aug 1 lands on Aug 8.
- **Degradation**: net-negative cells dropped *and* counted; significance needs ≥5 samples.

**Real-data replay** (`_margin_mix_aug2026/replay_bridge.js`, 4,157 / 1,675 / 1,350 real SAP rows):

| | v1 | v2 |
|---|---:|---:|
| Price | −70.1 | −70.1 |
| Cost | +125.7 | +125.7 |
| Customer/BU Mix | −257.6 | **−126.8** |
| Product Mix | −98.7 | **−229.4** |
| sum vs delta (−300.6) | exact | exact |

v2 reproduces Price and Cost to the peso and independently matches the Python audit built on a
separate stack: SSG lens total −200.6 (audit −201.1), BU lens −87.3 (−86.2), JEFPHERLYN −86.2 (−88.0),
CCPC −50.5 (−50.2).

**Placebo** — decomposing July against *its own first 8 days*, where nothing changed and every output
is by construction an artifact:

| | v1 | v2 |
|---|---:|---:|
| customer mix | **+152.1** | +63.3 |
| product mix | −29.9 | +58.9 |
| guard fired | none | `sign_stable: false` |

No decomposition can make a partial-window artifact vanish. v2 halves it and, critically, *labels* it.

---

## Still open

- **Concentrates pollute scope 103.** 13 VIETOP 2%/5% SKUs sell at 137–252 PHP/kg with 68–180 PHP/kg
  margin — 0.2–0.6% of tons but up to 4.2% of GP. One customer (CCPC, ~22 t/month) swings the headline
  by 50–180 PHP/t on its order date alone. Recommend an `?exclude_concentrates=1` flag plus a standing
  `concentrate_impact` figure in the payload, so the number is visible before anyone decides to fence
  them out. **Not implemented — it changes reported numbers and is a business call.**
- **Front-end.** The API now returns `mix_ordering`, `mix_detail`, `lenses`, `significance` and
  `window`. The panel still renders the four bars and `product_mix_by_ssg` only. It should surface the
  baseline dates, the churn warning, and suppress the customer/product split when
  `sign_stable === false`.
- **Sunday asymmetry.** Shipping-day counting treats Sundays as closed, but SAP shows occasional Sunday
  invoices (Jul 5 2026: 79.8 t, ~1.8% of that window). Truncation is symmetric so the bias is small,
  but a data-driven "posting days with volume" match would be tighter.
- **`significance`** currently scores against full-month deltas. It should score against
  same-truncation historical windows for a partial month.
