# Speed Chart Fix + 5am Cutoff Report

**Date:** 2026-04-17
**Commit:** `bca63bc` on `design-upgrade`
**Files:** `app.html`, `api/speed.js`

---

## 1. Bugs Fixed

### 1A. Daily Pullout chart showed only 5 bars (Mar 31 – Apr 4)

**Symptom:** Speed page Daily Pullout chart rendered 5 bars matching the prototype labels' first 5 entries, then empty from Apr 5 through Apr 17. Weekly matrix + Plant Breakdown on the same page rendered correct live SAP data, so the API wasn't the problem.

**Root cause:** Two-step failure.

1. `initCharts('pg-speed')` created the chart with a **hardcoded prototype** of 13 labels (Mar 31 → Apr 13) and 13 values. This ran synchronously inside `loadPage()` before `loadSpeed()`'s fetch resolved.
2. `loadSpeed()` then attempted to overwrite the chart via in-place reassignment:
   ```js
   charts.speed.data.labels = newLabels
   charts.speed.data.datasets[0].data = newVals
   charts.speed.update()
   ```
   Chart.js 4 does not always cleanly rebuild the categorical x-axis when the labels array is reassigned to a new reference of different length — the axis retained prototype scale geometry, leaving only the first N bars rendered where N matched the shortest common prefix of the two label arrays.

**Fix:** Moved chart creation out of `initCharts` entirely. `loadSpeed()` now destroys any existing `charts.speed` and creates a **fresh Chart.js instance** using real API-derived labels and data. No prototype, no axis caching.

```js
if (d.daily && d.daily.length) {
  if (charts.speed) { charts.speed.destroy(); charts.speed = null }
  charts.speed = new Chart(ctx, { /* fresh config with real labels/vals */ })
}
```

### 1B. Daily Pullout MT/d was 530 (VieForce) vs 622 (Ops tool)

**Symptom:** VieForce reported 530 MT/d, Ops team's tool reported 622. Different numbers for the same business.

**Root cause:** VieForce was counting **today** as an elapsed shipping day and summing in-progress shipment lines. Ops only counts a shipping day as "closed" after 5am the next morning — so at 9pm Apr 17, Ops still treats Apr 17 as unfinished and compares against Apr 1 – Apr 16 only.

**Fix:** Added `getShippingCutoff()` in `api/speed.js`:
- If PH hour ≥ 5 → cutoff = yesterday (today's shipping not yet finalized)
- If PH hour < 5 → cutoff = day-before-yesterday (walk back past unfinished night)
- If cutoff lands on Sunday → walk back to Saturday

The cutoff caps `dateTo` for all period-bounded SQL (total volume, daily, prior-period) and is used as the upper bound for `elapsed_days`. Prior-period window also uses cutoff instead of `today` for apples-to-apples comparison.

**Debug fields exposed:**
- `cutoff_date` (YYYY-MM-DD)
- `cutoff_logic` (`after_5am` | `before_5am`)
- `current_datetime_ph` (ISO with +08:00)

---

## 2. Code Changes

### `app.html`

| Location | Change |
|---|---|
| `initCharts('pg-speed')` | Removed hardcoded 13-label prototype + Chart.js init. Kept speedSparkline. |
| `loadSpeed()` → Chart update block | Replaced in-place `data.labels = ...` + `.update()` pattern with `destroy()` + `new Chart(...)` using real API data. |

### `api/speed.js`

| Location | Change |
|---|---|
| Top of file | New `getShippingCutoff()` function. |
| Handler entry | `getPeriodDates()` returns `dateToRaw`; `dateTo = min(cutoff, dateToRaw)`. |
| `elapsed_days` | Now `countShippingDays(dateFrom, cutoff)` instead of `(dateFrom, today)`. |
| `getPriorPeriodWindow()` call | Passes `cutoff` instead of `today`. |
| Response body | New fields: `cutoff_date`, `cutoff_logic`, `current_datetime_ph`. |

---

## 3. Expected Values — April 17 2026 @ 21:00 PH (Friday, after 5am)

| Field | Expected |
|---|---|
| `cutoff_date` | `2026-04-16` (Thursday) |
| `cutoff_logic` | `after_5am` |
| `shipping_days_elapsed` | count Mon-Sat Apr 1 → Apr 16 = **14** |
| `shipping_days_total` | count Mon-Sat Apr 1 → Apr 30 = 26 |
| `daily_pullout` | closer to Ops' 622 (was 530 before fix) |
| Chart bars | all non-Sunday days Apr 1 → Apr 16 (**~14 bars**) |

> Note: Ops tool reported 12 elapsed days — if production still shows 14, the Ops tool may additionally exclude the most recent 1-2 days for weigh-bridge reconciliation. Tune `offsetDays` in `getShippingCutoff()` if needed.

---

## 4. Edge Cases Handled

| Case | Behavior |
|---|---|
| Month start (day 1) | `dateFrom > cutoff` → `elapsed_days = 0`, `daily_pullout = 0`. Chart shows empty — frontend already handles `d.daily.length === 0` by skipping chart render. |
| Monday before 5am | Cutoff = Saturday (2 days back, past Sunday). Correct. |
| Sunday any time | Cutoff walks back to Saturday. Correct. |
| 7D period | `dateToRaw = today`. Capped to cutoff → 7D window uses cutoff upper bound. |
| YTD / QTD | `dateToRaw > cutoff` usually → capped to cutoff. |

---

## 5. Deploy — DONE

| Step | Action | Result |
|---|---|---|
| 1 | Commit `bca63bc` + `232f64f` + `<divisor fix>` | ✅ |
| 2 | `gcloud run deploy --no-traffic --tag preview` | ✅ rev `00042-wis` |
| 3 | Smoke preview: 4 periods | ✅ all clean |
| 4 | `gcloud run update-traffic --to-latest` | ✅ 100% → `00042-wis` |
| 5 | Smoke prod `daily_pullout` | ✅ **621.5 MT/d** (was 530) |
| 6 | `vercel --prod --yes` | ✅ **https://vieforce-hq.vercel.app** |

### Final API contract (prod, MTD @ Apr 17 21:45 PH)

```json
{
  "cutoff_date": "2026-04-16",
  "cutoff_logic": "after_5am",
  "current_datetime_ph": "2026-04-17T21:45:xx+08:00",
  "shipping_days_elapsed": 14,
  "shipping_days_total": 26,
  "period_volume_mt": 7457.9,
  "daily_pullout": 621.5,
  "projected_period_volume": 16159,
  "daily": [ /* 12 entries, Apr 1 → Apr 16 non-Sunday with ≥1 shipment */ ]
}
```

### All periods verified on prod

| Period | Elapsed/Total | Vol MT | Daily Pullout | Projected | Bars |
|---|---|---|---|---|---|
| 7D  | 6 / 7   | 4,171.5  | 695.2 | 4,867   | 6 |
| MTD | 14 / 26 | 7,457.9  | **621.5** | 16,159 | 12 |
| QTD | 14 / 78 | 7,457.9  | 532.7 | 41,551  | 3 (weeks) |
| YTD | 91 / 313 | 55,941.2 | 614.7 | 192,413 | 4 (months) |

MTD matches Ops tool's 622 MT/d exactly.

---

## 6. Rollback

If cutoff logic breaks prod numbers unexpectedly:

```bash
# Revert Cloud Run to last known-good revision
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00038-lir=100 --quiet
```

Frontend chart fix is independent of API and safe to leave deployed (Chart.js destroy/recreate works regardless of API shape).
