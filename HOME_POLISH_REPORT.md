# HOME POLISH REPORT — KPI Merge + Daily Pullout + Active DSO

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commit:** `989a65e` — Home KPI polish: merge strips, Daily Pullout rename, Active DSO (U_BpStatus filter)

---

## 1. SAP Delinquent Flag — Field Identified

### Discovery Process
Mat's rule: don't use a time-based heuristic (180d stale) — use the actual SAP flag. Discovery query ran against `Vienovo_Live` via a temp-extended `/api/diag` endpoint (now reverted).

### Candidates Found

| Field | Values | Distribution | DSO Impact (excl delinquent) | AR Trapped |
|-------|--------|--------------|------------------------------|------------|
| `OCRD.frozenFor` (SAP native) | `'Y'` / `'N'` | 30 / 1352 | 111.6d → 110.8d (-0.8d) | ₱8.4M |
| `OCRD.U_BpStatus` (custom UDF) | `Active` / `Delinquent` / `InActive` | 1230 / 144 / 8 | 111.6d → 82.4d (-29d) | ₱261M |

### Decision — Option C (confirmed by Mat)

**Active customer = `frozenFor <> 'Y' AND U_BpStatus = 'Active'`**
**Delinquent     = `frozenFor = 'Y' OR U_BpStatus IN ('Delinquent','InActive')`**

Centralised in `api/ar.js` + `api/dashboard.js` as `ACTIVE_PREDICATE` and `DELINQ_PREDICATE` constants.

### Live SAP Results (as of 2026-04-17)

```
Total AR balance         : ₱782,332,836
  └─ Active              : ₱521,433,210   (548 customers)
  └─ Delinquent          : ₱260,899,626   (128 customers trapped)

DSO total (all customers): 113 d
DSO active (new main KPI):  84 d
Delinquent drag          : +29 d → shown as badge on Home
```

**Note on 45d target:** Even with delinquent exclusion, live DSO lands at **84d**, not the ~45d Mat estimated. Additional drag comes from active accounts with 31-60-90d aging buckets. No extra time-based filter was stacked (per Mat's rule against time heuristics).

---

## 2. Home KPI Layout — Before / After

### Before

```
Row 1 (7 cards, thin):  Net Sales | Volume | GM | GM/Ton | DSO | Speed | Pending PO
Row 2 (5 cards, thick): YTD Vol vs Budget | YTD Sales vs Budget | GM vs Budget | Net Profit vs Budget | FY26 Target
                        (hardcoded 93% values — never lived in API)
```

### After — Single enriched row of 7 cards

```
┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│ Net Sales   │ Volume      │ Gross Margin│ GM/Ton      │ DSO         │ Daily       │ Pending PO  │
│ ₱237M       │ 7.2K MT     │ ₱50M        │ ₱7,013      │ 84d         │ Pullout     │ 6,633 MT    │
│ ▼ 59.5%     │ ▼ 60.5%     │ ▼ 55.3%     │ ▲ 13.1%     │ Active      │ 499 MT/d    │ ₱221M · 502 │
│ ─────────── │ ─────────── │ ─────────── │ ─────────── │ ─────────── │ ─────────── │ ─────────── │
│ YTD ₱2.56B  │ YTD 55.6K   │ YTD ₱358M   │ YTD ₱6,436  │ TARGET ≤45d │ 15 of 26    │ OLDEST 90d  │
│ / ₱1.80B    │ / 56.9K MT  │ / ₱372M     │ YTD avg     │             │ shipping d. │ ago         │
│ ██████████  │ █████████▊  │ █████████▉  │ █████████▉  │ ▓▓░░░░░░░░  │ █████▊░░░░  │ ██████████  │
│ 100% YTD    │ 98% YTD     │ 96% YTD     │ 100% YTD    │ 39d over    │ 11d left    │ Review POs  │
│   (green)   │   (green)   │   (green)   │   (green)   │    (red)    │   (blue)    │    (red)    │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
           +29d from delinquent accounts   ←  badge when dso_total > dso_active + 10
```

### Rules applied per card

| Card | Delta | YTD/Context | Progress Bar | Status color |
|------|-------|-------------|--------------|--------------|
| Net Sales | vs prev period % | YTD actual / YTD budget | YTD achievement % | green ≥95 / gold 80-94 / red <80 |
| Volume | same | same (MT) | same | same |
| Gross Margin | same | same (₱) | same | same |
| GM/Ton | same | YTD avg (no budget) | 100% (static) | always green |
| DSO | label only (`Active accounts`) | Target ≤45d | 45/DSO scale (filled if under) | green if ≤45, red if over |
| Daily Pullout | vs prev period % | "{elapsed} of {total} shipping days" | days_elapsed/days_total | always blue (time progression) |
| Pending PO | ₱ · orders | Oldest: Xd ago | 0-20d scaled | green <7d, gold 7-14d, red >14d |

Removed: stand-alone FY26 Budget Target card. FY context now available via the YTD lines + `/pg-budget` nav button.

---

## 3. Formulas — New DSO & Daily Pullout

### DSO (live)
```sql
-- Active DSO (exposed as .dso and .dso_active)
SELECT
  SUM(CASE WHEN inv unpaid THEN DocTotal - PaidToDate END) /
  NULLIF(SUM(CASE WHEN inv in last 365d THEN DocTotal END) / 365.0, 0)
FROM OINV
INNER JOIN OCRD ON OINV.CardCode = OCRD.CardCode
WHERE OINV.CANCELED = 'N'
  AND (ISNULL(OCRD.frozenFor,'N') <> 'Y' AND OCRD.U_BpStatus = 'Active')
```

| Metric | Preview value | Production value | Delta |
|--------|---------------|------------------|-------|
| `dso_total` (old DSO) | 113 d | 112 d | +1 |
| `dso_active` (new) | **84 d** | — | new |
| `delinquent_ar_balance` | ₱260.9M | — | new |
| `delinquent_customer_count` | 128 | — | new |

### Daily Pullout (live)
```
daily_pullout  = mtd_actual / days_elapsed      (MT/day from ODLN deliveries, Mon-Sat)
days_elapsed   = Mon-Sat count from month-start through today
days_total     = Mon-Sat count for full calendar month
days_remaining = days_total - days_elapsed
projected_mtd  = daily_pullout × days_total
```

| Field | Value |
|-------|-------|
| `mtd_actual` | 7,484.8 MT |
| `daily_pullout` | 499 MT/d |
| `days_elapsed` | 15 |
| `days_total` | 26 |
| `days_remaining` | 11 |
| `projected_mtd` | 12,974 MT |

(Calculation unchanged from prior `speed_per_day` — only the field names are now explicit. Legacy names kept for back-compat with other pages.)

---

## 4. AR Page — Delinquent Toggle

- **Default state:** OFF → dashboard shows only Active AR (₱521M), active customer count (548), and DSO = 84d
- **Toggle ON** → shows Total AR (₱782M), all customers (676), DSO = 113d
- Separate **Delinquent AR** card always visible with red border showing ₱261M / 128 customers frozen
- Toggle re-runs `loadAR()` (data already in cache, no re-fetch)

---

## 5. Files Changed

| File | Change |
|------|--------|
| `api/ar.js` | Rewrite: Active/Total DSO, delinquent balance + count, buckets limited to active, per-client delinquent flag |
| `api/dashboard.js` | Rewrite: + previous_period, + ytd, + budget (FY/MTD/YTD derived from BUDGET_2026), + dso_active/total, + pending_po.oldest_days, + ar_active_balance/ar_delinquent_balance |
| `api/speed.js` | + canonical `daily_pullout` / `days_elapsed` / `days_total` / `days_remaining` / `projected_mtd` / `mtd_actual` (legacy fields retained) |
| `api/diag.js` | Reverted to pre-discovery state |
| `app.html` | Merged 7+5 KPI strips → 1 enriched 7-card row; renamed Speed→Daily Pullout; added DSO target bar + delinquent badge; added Pending PO oldest-age bar; added AR page toggle + Delinquent AR card |

---

## 6. Deployment

| Target | URL / Revision | Status |
|--------|----------------|--------|
| Cloud Run preview | `vieforce-hq-api-00025-veg` at `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app` | 0% traffic, ✅ |
| Vercel preview | `https://vieforce-1063fhj1e-mathieu-7782s-projects.vercel.app` | Ready, ✅ |
| Production | Untouched | — |

Smoke-tested all 3 updated endpoints against Cloud Run preview with CEO session token — all return 200 with the new fields.

---

## 7. What Mat should check

Open this URL in incognito, Ctrl+Shift+R to bypass cache:

**https://vieforce-1063fhj1e-mathieu-7782s-projects.vercel.app**

Login: phone `09170000100` + your PIN.

Verify on Home:
- [ ] Single row of 7 enriched cards (no separate budget strip below)
- [ ] "Daily Pullout" instead of "Speed", showing "15 of 26 shipping days" + "11 days remaining"
- [ ] DSO card shows **84d** (not 112d) with red bar + "39d over target" + badge "+29d from delinquent accounts"
- [ ] Pending PO card shows oldest = 90d ago with red "Review stale POs" status
- [ ] YTD progress bars filled ~95-100% on sales/volume/GM cards

Verify on AR page:
- [ ] "Show delinquent" toggle at top (default OFF)
- [ ] Shows Active AR (~₱521M), 548 clients, separate red Delinquent AR card with ₱261M / 128 customers
- [ ] DSO gauge reads 84d
- [ ] Toggle ON → switches to Total AR (₱782M) and DSO reads 113d

---

## 8. Known Caveats

1. **DSO 84d ≠ 45d target.** Mat estimated ~45d for Operating DSO, but excluding delinquent accounts only brings it down to 84d. The remaining gap is from active customers aging in the 31-60-90d buckets — these are real late payments on active accounts, not a filtering artefact. Additional time-based filtering was explicitly not applied per Mat's rule.
2. **Pending PO oldest = 90 days.** One or more open ORDR records haven't been delivered in 90+ days — may warrant cleanup in SAP.
3. **Budget strip semantics changed.** Old strip showed Net Sales/Ton and other derived metrics that aren't replicated. If any of those are needed back, they can re-appear below the enriched strip without replacing it.
4. **Customer counts:** `ar_active_customer_count` now reports only customers with open AR (548), not full active roster (1230 in OCRD). Same for delinquent (128 with AR vs 152 delinquent total).

---

*Generated by Home Polish Agent — 2026-04-17*
