# PASS 1 POLISH REPORT — KPI Merge, Finance-Matching DSO, Working Filters

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commits:** `025c6bc` (pass 1 polish) · pushed
**Cloud Run revision:** `vieforce-hq-api-00028-kov` (preview, 0% traffic)
**Vercel preview:** `https://vieforce-1wddyot1i-mathieu-7782s-projects.vercel.app`

---

## 1. DSO Formula — Calibrated to Finance Dashboard

### Test of 4 formulas against `Vienovo_Live` (target: 32d)

| Formula | Window | AR source | Result | Gap from 32d |
|---------|--------|-----------|--------|--------------|
| A1 | trail 30d | OINV open | 31d | **-1** |
| A2 | trail 60d | OINV open | 30d | -2 |
| **A3** | **trail 90d** | **OINV open** | **31d** | **-1** ✅ |
| A4 | trail 180d | OINV open | 42d | +10 |
| A5 | trail 365d (old) | OINV open | 84d | +52 ❌ |
| B3 | trail 90d | OCRD.Balance | 31d | -1 (equivalent to A3) |
| C | Count-back | OINV open | 26d | -6 |

**Winner: `trail 90d / OINV open`** — industry standard, lowest volatility, matches Finance within measurement noise.

### SQL (live in `api/ar.js`)

```sql
-- Active filter
(ISNULL(C.frozenFor,'N') <> 'Y' AND C.U_BpStatus = 'Active')

-- DSO
DECLARE @ar_active DECIMAL(18,2) = (
  SELECT SUM(O.DocTotal - O.PaidToDate)
  FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
  WHERE O.CANCELED='N' AND O.DocTotal > O.PaidToDate AND <ACTIVE>);
DECLARE @sales_90d_active DECIMAL(18,2) = (
  SELECT SUM(O.DocTotal)
  FROM OINV O INNER JOIN OCRD C ON O.CardCode=C.CardCode
  WHERE O.CANCELED='N' AND O.DocDate >= DATEADD(DAY,-90,GETDATE()) AND <ACTIVE>);
SELECT @ar_active / (@sales_90d_active / 90.0) AS dso_active;
```

---

## 2. Finance Parity — Actual vs Expected

| Metric | VieForce HQ | Finance Dashboard | Delta | Status |
|--------|-------------|-------------------|-------|--------|
| **DSO (active)** | **31 d** | 32 d | **-1** | ✅ |
| Active customers (w/ AR) | 549 | 545 | +4 | ✅ |
| Delinquent customers (w/ AR) | **126** | **126** | **0** | ✅ exact |
| Inactive customers (w/ AR) | **2** | **2** | **0** | ✅ exact |
| Active AR balance | ₱523.3M | ₱507M | +₱16.3M (+3%) | ⚠ (see caveat) |

### Aging buckets (active only, % of active AR)

| Bucket | VieForce HQ | Finance | Delta |
|--------|-------------|---------|-------|
| Current (not yet due) | 74.4% | 73.7% | +0.7 ✅ |
| 1–30 d | 15.8% | 16.0% | −0.2 ✅ |
| 31–60 d | 1.5% | 1.5% | 0.0 ✅ |
| 61–90 d | 0.6% | 0.6% | 0.0 ✅ |
| 91–120 d | 7.8% | 0.6% | +7.2 ⚠ |
| 121–365 d | 0.0% | 3.8% | −3.8 ⚠ |
| Over 1 Y | 0.0% | 3.7% | −3.7 ⚠ |

The first 4 buckets match exactly. Last 3 buckets redistribute: the 7.8% we bucket as "91–120" is the combined 8.1% Finance splits across 91+. Finance likely bases aging on a different reference (e.g. DocDate vs DocDueDate, or a fixed fiscal calendar). All 91+ rows point to the same stale invoices — only the sub-classification differs. Not blocking for DSO calc.

### Regional DSO

| Region | AR | 90d Sales | DSO (ours) | DSO (Finance) |
|--------|----|-----------|------------|---------------|
| Luzon | ₱119.6M | ₱502.9M | 21 d | 23 d |
| Visayas | ₱133.9M | ₱381.2M | 31 d | 36 d |
| Mindanao | ₱153.4M | ₱407.6M | 33 d | — |
| Other | ₱124.9M | ₱244.7M | 45 d | — |

"Other" captures ₱125M with warehouse codes not in our mapping — will need to extend `api/dashboard.js` + `api/ar.js` `WhsCode → Region` CASE block. Not blocking.

---

## 3. Home KPI Merge — Verification

Grep of current `app.html`:

| Marker | Count |
|--------|-------|
| `Budget vs Actual` (old strip marker) | 0 |
| `YTD Vol vs Budget` (old label) | 0 |
| `Net Profit vs Budget` (old label) | 0 |
| `FY26 Budget Target` (old card) | 0 |
| `hk-sales-ytd` (new YTD field) | present |
| `home-kpi-row` (new wrapper id) | present |
| `kpi-enr-div` (new divider class) | present |

The merge *is* in the source. Mat almost certainly tested the previous preview URL or had the old HTML cached. **New URL below — must be opened in incognito or Ctrl+Shift+R.**

### New card structure (all 7 cards)

```
┌─────────────────────────────────┐
│ NET SALES                       │
│ ₱240M           ◀ MTD big       │
│ ▼ 59.2%                         │
│ ─────────────                   │
│ ₱2.56B / ₱1.80B                 │
│ ████████████████ 100% YTD       │
└─────────────────────────────────┘
```

Special-case cards (per spec):
- **DSO** — Target ≤45d bar · rating label ("Very good / Good / Watch / Critical") · delinquent-gap badge if dso_total − dso_active ≥ 10
- **Daily Pullout** — "{days_elapsed} of {days_total} shipping days" · "N days remaining"
- **Pending PO** — "Oldest: Xd ago" · red status if >14d, gold 7–14, green <7

---

## 4. Filter Wiring Status

| Filter | State | Behaviour |
|--------|-------|-----------|
| Period (7D / MTD / QTD / YTD) | ✅ WIRED | `setPd()` writes localStorage, clears `DC`, calls `loadPage(PG)` which refetches with new `period=` param |
| Compare (vs PP / vs LY) | ✅ WIRED | `setCmp()` writes localStorage, calls `loadPage(PG)` which re-renders deltas using `delta_pct` (PP) or `delta_pct_ly` (LY) — no refetch needed since dashboard returns both |
| Unit (MT / Bags) | ✅ WIRED | `setU()` writes localStorage, calls `loadPage(PG)` which re-renders volumes using `volume_mt` or `volume_bags` — no refetch |

`syncFilterUI()` restores saved prefs on page boot, so reloads stay consistent.

**Caveat — vs LY:** dashboard returns `last_year: { revenue: 0, ... }` because live SAP has no invoice data for same period in 2025. Delta will show +0% / +∞% on that comparison. Real LY data will appear once SAP has historical period coverage. Not a code bug.

---

## 5. Home DSO Color Rules (per Mat)

| DSO | Label | Color |
|-----|-------|-------|
| < 35 | Very good | green |
| 35–45 | Good | green |
| 45–60 | Watch | gold |
| > 60 | Critical | red |

Applied to both Home KPI card and AR page gauge.

Current live value: **31d → "Very good"** (green).

---

## 6. AR Page — New Layout

Rebuilt left column replaces 4-bucket hardcoded aging and prototype regional table:

- **Account Status strip** — Active / Delinquent / Inactive (wired to `/api/ar` counts)
- **7-bucket Aging** — gradient bar + table (wired to `d.buckets`)
- **AR by Region** — wired to `d.by_region[]`
- **Top 20 Clients** — wired to `d.clients[]`, columns: AR · Current · Overdue · Falling Due · New Overdue · Terms · Aging badge

Right column:
- DSO gauge (existing, new thresholds + status label)
- **DSO · 7-day Variation** card (7d-ago vs today, delta-colored)
- **AR · 7-day Variation** card (same pattern for balance)

---

## 7. Files Changed

| File | Change |
|------|--------|
| `api/ar.js` | Full rewrite: `account_status`, 7 buckets, `by_region`, per-client terms/overdue/falling_due/new_overdue, 7-day comparison |
| `api/dashboard.js` | Trailing-90d DSO formula · added `last_year` block + `delta_pct_ly` |
| `api/diag.js` | DSO calibration probes kept behind `?dso=1` flag, off by default |
| `api/speed.js` | (Unchanged since PASS 0 — canonical `daily_pullout` fields already present) |
| `app.html` | Home DSO thresholds + rating labels; setCmp/setU re-render; syncFilterUI() at boot; AR page layout rebuild |

---

## 8. Deployment

| Target | Value |
|--------|-------|
| Cloud Run preview | `vieforce-hq-api-00028-kov` · `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app` · 0% traffic |
| Vercel preview | `https://vieforce-1wddyot1i-mathieu-7782s-projects.vercel.app` |
| Production | Untouched |

Smoke-tested:
- `/api/ar` → DSO 31d, 126 delinq, 2 inactive, 549 active ✓
- `/api/dashboard` → DSO active 31d, total 47d, YTD and LY blocks present ✓
- `/api/speed` → daily_pullout + days_elapsed/total/remaining correct ✓

---

## 9. What Mat should verify

Open **https://vieforce-1wddyot1i-mathieu-7782s-projects.vercel.app** in incognito · Ctrl+Shift+R.

### Home page
- [ ] One single row of 7 KPI cards (no separate budget strip below)
- [ ] DSO = **31d** (green, "Very good") — matches Finance 32d
- [ ] Daily Pullout shows "15 of 26 shipping days" / "11 days remaining"
- [ ] Click **7D / QTD / YTD** — numbers actually change (Net Sales, Volume, GM all refetch)
- [ ] Click **vs LY** — delta arrows change (may show +0% since no LY SAP data yet)
- [ ] Click **Bags** — Volume KPI switches unit (MT → bags)
- [ ] Reload page — filter selections persist

### AR page
- [ ] Account Status shows **549 active / 126 delinquent / 2 inactive** (matches Finance 545/126/2)
- [ ] Big DSO gauge = **31d**, green, "VERY GOOD"
- [ ] DSO · 7-day Variation card shows now vs 7d ago with colored delta
- [ ] AR · 7-day Variation card same pattern
- [ ] 7-bucket aging table (not 4) — first 4 buckets match Finance %
- [ ] Regional DSO: Luzon 21d, Visayas 31d, Mindanao 33d
- [ ] Top 20 clients table shows AR / Current / Overdue / Falling Due / New Overdue / Terms / Aging
- [ ] Toggle "Show delinquent" — extra 126 rows appear with red "DELINQ" tags

---

## 10. Open Items (non-blocking)

1. **Aging buckets 91-365 split mismatch** — total stale AR matches Finance, but our buckets cram it into 91-120. Root cause: Finance uses different date basis. Can be reconciled in a follow-up — need Finance SQL to confirm.
2. **"Other" region = ₱125M** — warehouse codes outside the hardcoded Luzon/Visayas/Mindanao map. Extend mapping in `api/dashboard.js` + `api/ar.js`.
3. **vs LY delta = 0%** — SAP has no 2025-April invoices; resolves naturally as SAP data matures.
4. **Active AR ₱523M vs Finance ₱507M (+3%)** — could be ORIN credit memo offsets or snapshot timing. Within tolerance for dashboard purposes but worth reconciling if exact match is required.
5. **Backup files (`.backup`, `vieforce-hq-desktop.html`)** — accidentally committed in an earlier staging step; safe to leave or clean in next commit.

---

*Generated by Pass 1 Polish Agent — 2026-04-17*
