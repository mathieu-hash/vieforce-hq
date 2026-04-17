# Speed Formula — Holiday Calendar Fix Report

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Preview revision:** `vieforce-hq-api-00044-beg` (0% traffic)
**Production (unchanged):** `vieforce-hq-api-00042-wis` (100% traffic, 5am cutoff logic)
**Status:** ⚠️ NOT PROMOTED — numbers don't match Ops tool. Needs Mat's calendar confirmation first.

---

## 1. Deliverables

| # | Deliverable | Status |
|---|---|---|
| 1 | Holiday calendar JSON | ✅ `api/data/shipping_calendar_ph.json` (2025 + 2026 covered) |
| 2 | Shipping-day helper module | ✅ `api/lib/shipping_days.js` |
| 3 | `api/speed.js` rewired | ✅ cutoff removed, calendar-aware counting, today counts |
| 4 | `/api/speed` includes `holidays_in_period` | ✅ (plus `current_date_ph`, `period_start`, `period_end`) |
| 5 | Verification vs Ops tool | ❌ **mismatch** (see §4) |
| 6 | Daily chart full period | ✅ daily[] returns Apr 1 → Apr 17 (13 per-day bars for MTD) |
| 7 | Deployment | ✅ preview deployed, **production NOT touched** |
| 8 | Flag for Mat | ⚠️ see §5 |

---

## 2. Files Changed

### `api/data/shipping_calendar_ph.json` (new)
Philippine shipping calendar. Lists dates where plants are CLOSED. Sundays are excluded automatically and are NOT listed in the file.

2026 entries (all treated as closed per Mat's spec):
- Jan 1 — New Year's Day
- Jan 29 — Chinese New Year
- Apr 2 — Maundy Thursday
- Apr 3 — Good Friday
- Apr 4 — Black Saturday
- Apr 9 — Araw ng Kagitingan
- May 1 — Labor Day
- Jun 12 — Independence Day
- Aug 31 — National Heroes Day
- Nov 1 — All Saints Day
- Nov 30 — Bonifacio Day
- Dec 8 — Immaculate Conception
- Dec 25 — Christmas Day
- Dec 30 — Rizal Day

### `api/lib/shipping_days.js` (new)

Exports:
- `getManilaToday()` — TZ-safe today in Asia/Manila at 00:00 local
- `countShippingDays(start, end)` — inclusive; excludes Sundays + calendar.closed_dates
- `listHolidaysInPeriod(start, end)` — returns `[{date, name}, ...]`
- `getPeriodBounds(period, today)` — returns `{start, end}` for 7D/MTD/QTD/YTD
- `getPeriodEndBound(period, today)` — returns end of full period (for `shipping_days_total`)
- `fmtISO(date)` — TZ-safe `YYYY-MM-DD` (avoids `toISOString()` off-by-one when server TZ ≠ PH)

### `api/speed.js` (rewired)

Removed:
- `countShippingDays()` (old Mon-Sat-only version, now imported from lib)
- `getShippingCutoff()` (5am cutoff logic — superseded by today-counts rule)
- `getPeriodEnd()` (duplicate of `getPeriodEndBound`)
- `days_with_shipments` divisor (replaced by calendar-aware `elapsed_days`)
- `cutoff_date`, `cutoff_logic`, `current_datetime_ph` response fields (replaced)

Changed:
- `dateFrom / dateTo` now from `getPeriodBounds(period, todayPH)` — today counts
- `elapsed_days = countShippingDays(dateFrom, today)` — calendar-aware
- `total_days = countShippingDays(dateFrom, periodEnd)` — calendar-aware
- Volume SQL `WHERE DocDate BETWEEN @dateFrom AND @dateTo` — includes today's shipments
- `daily_pullout = period_volume / elapsed_days`
- `projected_period_volume = daily_pullout * total_days`

Added to response:
```json
{
  "current_date_ph": "2026-04-17",
  "period_start":    "2026-04-01",
  "period_end":      "2026-04-30",
  "holidays_in_period": [
    { "date": "2026-04-02", "name": "Maundy Thursday" },
    { "date": "2026-04-03", "name": "Good Friday" },
    { "date": "2026-04-04", "name": "Black Saturday" },
    { "date": "2026-04-09", "name": "Araw ng Kagitingan" }
  ],
  "shipping_days_elapsed": 11,
  "shipping_days_total":   22,
  "shipping_days_remaining": 11,
  ...
}
```

All prior fields retained — backward compatible.

---

## 3. Preview Smoke Results — all 4 periods (Apr 17, 2026 @ 21:50 PH)

| Period | Range | Elapsed/Total | Remaining | Volume MT | Daily Pullout | Projected | Bars |
|---|---|---|---|---|---|---|---|
| 7D  | Apr 11 → Apr 17 | 6 / 6    | 0  | 4,003.9  | 667.3 | 4,004   | 6 |
| MTD | Apr 1  → Apr 30 | **11 / 22** | 11 | 8,010.0  | **728.2** | 16,020 | 13 |
| QTD | Apr 1  → Jun 30 | 11 / 72  | 61 | 8,010.0  | 728.2 | 52,429  | 3 (weeks) |
| YTD | Jan 1  → Dec 31 | 86 / 300 | 214 | 56,493.3 | 656.9 | 197,070 | 4 (months) |

Chart range: **13 per-day bars** for MTD (Apr 1 → Apr 17 excluding 2 Sundays + 4 holidays = 11 open days + 2 zero-shipment open days shown in chart). Chart bug from prior task stays fixed.

---

## 4. ⚠️ Mismatch vs Ops Tool

| Metric | Ops (Mat, as of Apr 16) | VieForce preview (Apr 17) | Delta |
|---|---|---|---|
| `shipping_days_elapsed` | **12** (Apr 1–16) | 10 (Apr 1–16) / **11** (Apr 1–17 incl today) | −2 / −1 |
| `daily_pullout` (MT/d) | **622** | 728.2 (MTD incl today) | +106 |
| `projected_mtd` (MT) | **16,183** | 16,020 | −163 |

Volume through today (Apr 17, 21:50 PH): **8,010 MT**. Ops volume through Apr 16: **7,457.9 MT** (my data from earlier cutoff deploy). Today added ~552 MT.

---

## 5. 🚩 FLAG FOR MAT — Calendar Confirmation

The 2026 PH holidays I used (per Mat's spec, sourced from Proclamation No. 727) close **4 days in April**: Apr 2, 3, 4, 9. This produces **11 shipping days** for Apr 1-17 (including today).

Mat's Ops tool shows **12 shipping days** for Apr 1-16. Reverse-engineering: if Ops closes only **2 April holidays** (not 4), the math works out:

> Apr 1–16 = 16 cal days − 2 Sundays (Apr 5, 12) − **2 holidays** = 12.

The 2 most likely-closed holidays (based on common PH manufacturing practice): **Good Friday (Apr 3)** and **Araw ng Kagitingan (Apr 9)**. Many manufacturers operate on Maundy Thursday and Black Saturday.

**Please confirm:**

1. Does VPI ship on **Maundy Thursday** (Apr 2)? _____
2. Does VPI ship on **Black Saturday** (Apr 4)? _____
3. If yes to both → we remove them from `shipping_calendar_ph.json`, elapsed becomes 12 Apr 1–16 / 13 Apr 1–17.

Also need confirmation for the rest of the 2026 calendar — e.g. does VPI ship on Labor Day (May 1)? Independence Day (Jun 12)? These default to CLOSED right now.

A second question: **Does Ops include today's volume in its MTD calc?** If Ops is still yesterday-cutoff (volume through Apr 16, not 17), then daily_pullout = 7,457.9 / 12 = 621.5 — which was the 5am cutoff behavior I just replaced. The new spec says "today counts", but Mat's own Ops number (622) seems to exclude today.

---

## 6. Deploy Commands

### Preview (done — zero traffic)
```bash
gcloud run deploy vieforce-hq-api \
  --source . --region asia-southeast1 --no-traffic --tag preview --quiet
# Revision: vieforce-hq-api-00044-beg
# URL: https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app
```

### Smoke test
```bash
curl "https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app/api/speed?period=MTD" \
  -H "x-session-id: 4bc1c7c0-213b-49cc-9b88-1730b2906bbd" \
  | python -c "import json,sys; d=json.load(sys.stdin); print(d['shipping_days_elapsed'], d['daily_pullout'], [h['date']+' '+h['name'] for h in d['holidays_in_period']])"
```

### If Mat approves calendar → promote
```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 --to-latest --quiet
```

### Rollback (to current prod 5am-cutoff logic)
```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00042-wis=100 --quiet
```

---

## 7. What's Live on Production Right Now

Current prod (`00042-wis`) uses the **5am cutoff** logic from the earlier task — not the new calendar. Frontend chart fix (destroy+recreate pattern) is also live. The calendar fix is ready and smoke-tested on the preview URL, waiting for Mat's calendar confirmation before promoting.
