# HOME PAGE FIX REPORT — Apr 18 (Track 3)

**Date:** 2026-04-18
**Branch:** `design-upgrade`
**Cloud Run:** revision **`vieforce-hq-api-00051-roq`** @ 100% traffic
**Vercel prod:** https://vieforce-hq.vercel.app

---

## 1 · Bug 1 — Volume / GM/Ton data source audit

### Audit result

Read every SQL query in `api/dashboard.js` and checked the `FROM` clause:

| Query | Source | Status |
|---|---|---|
| `kpis` (revenue / volume_mt / gross_margin / gmt) | **OINV + INV1** | ✅ invoiced |
| `prevKpis` (MoM delta) | **OINV + INV1** | ✅ invoiced |
| `lyKpis` (vs LY) | **OINV + INV1** | ✅ invoiced |
| `ytdKpis` | **OINV + INV1** | ✅ invoiced |
| `arBalance` | OINV (open AR) | ✅ |
| `dsoRow` | OINV | ✅ |
| `pendingPO` | ORDR + RDR1 (open orders — intentional, PO backlog ≠ revenue) | ✅ |
| `regionPerfCur` + `regionPerfPrev` | **OINV + INV1** | ✅ invoiced |
| `topCust` | **OINV + INV1** | ✅ invoiced |
| `marginCounts` | **OINV + INV1** | ✅ invoiced |

**No ODLN references anywhere in the dashboard endpoint.** The 7.6K (Home) vs 8.1K (Speed Monitor) is working as designed — they report two different metrics:

- **Home / `/api/dashboard`**: `volume_mt` = MT **invoiced** (OINV headers). Financial reporting number.
- **Speed / `/api/speed`**: `period_volume_mt` = MT **shipped** (ODLN delivery notes). Operational reality.

Lag between them = customer takes DR today, gets invoiced 1–3 days later. Normal.

### Change applied

No SQL change needed — dashboard was already OINV-only. Added UI clarifier:

```diff
- <div class="kpi kpi-sm kpi-enr">
-   <div class="kpi-label">Volume</div>
+ <div class="kpi kpi-sm kpi-enr" title="Based on invoiced data (OINV). Delivery volume may differ — see Speed Monitor for operational MT shipped.">
+   <div class="kpi-label">Volume <span style="font-size:9px;color:var(--text4);font-weight:500">(INVOICED)</span></div>
```

### Verification (prod rev `00051-roq`, MTD)

```
volume_mt:         7,640.7 MT   ← Home Volume KPI (OINV invoiced)
region_sum_vol:    7,640.7 MT   ← sum of region_performance[].vol
revenue:           ₱252.8M
gross_margin:       ₱53.1M
gmt:               ₱6,955 / MT   ← invoiced GM ÷ invoiced volume
```

Volume KPI now **matches the Region table sum exactly** (both from OINV).

---

## 2 · Bug 2 — Monthly / Quarterly Performance charts empty

### Root cause

`renderHomeCombos()` was shipping **hardcoded mock data** (Oct-Apr 9.1K–14.2K MT, Q1-Q4 29.6K–40.2K MT). Called from `initCharts('pg-home')` at page load but never fed API data. The charts rendered with fake numbers — which from far away looks empty/wrong/broken.

```js
// BEFORE — ship-with-mock version
function renderHomeCombos(){
  var mCY = [9100,10100,10400,10200,11400,12500,14200];   // literal mock
  var mGM = [60,66,68,67,75,82,93];                         // literal mock
  buildHomeComboChart('homeMonthlyChart', ...);
}
```

### Backend — api/dashboard.js

Added two response fields, both **OINV-only**:

```sql
-- monthly_perf: last 7 months, CY + same month LY
SELECT YEAR(T0.DocDate) AS y, MONTH(T0.DocDate) AS m,
       ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS volume_mt,
       ISNULL(SUM(T1.GrssProfit), 0)                                AS gross_margin
FROM OINV T0
  INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
  LEFT JOIN  OITM I  ON T1.ItemCode = I.ItemCode
WHERE T0.DocDate >= DATEADD(MONTH, -19, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
  AND T0.CANCELED = 'N'
GROUP BY YEAR(T0.DocDate), MONTH(T0.DocDate)
```

Node pairs CY with same-month LY:

```json
"monthly_perf": [
  { "month":"Oct","year":2025,"cy_volume":    0,"ly_volume":0,"cy_gm":         0,"ly_gm":0 },
  { "month":"Nov","year":2025,"cy_volume":    0,"ly_volume":0,"cy_gm":         0,"ly_gm":0 },
  { "month":"Dec","year":2025,"cy_volume":    0,"ly_volume":0,"cy_gm":         0,"ly_gm":0 },
  { "month":"Jan","year":2026,"cy_volume":16117,"ly_volume":0,"cy_gm": 107042816,"ly_gm":0 },
  { "month":"Feb","year":2026,"cy_volume":14217,"ly_volume":0,"cy_gm":  88396000,"ly_gm":0 },
  { "month":"Mar","year":2026,"cy_volume":18140,"ly_volume":0,"cy_gm": 112500000,"ly_gm":0 },
  { "month":"Apr","year":2026,"cy_volume": 7641,"ly_volume":0,"cy_gm":  53135892,"ly_gm":0 }
]
```

```json
"quarterly_perf": [
  { "quarter":"Q1","cy_volume":48473,"ly_volume":0,"cy_gm":307938816,"ly_gm":0 },
  { "quarter":"Q2","cy_volume": 7641,"ly_volume":0,"cy_gm": 53135892,"ly_gm":0 },
  { "quarter":"Q3","cy_volume":    0,"ly_volume":0,"cy_gm":        0,"ly_gm":0 },
  { "quarter":"Q4","cy_volume":    0,"ly_volume":0,"cy_gm":        0,"ly_gm":0 }
]
```

Q1 CY = 48,473 ≈ Jan 16,117 + Feb 14,217 + Mar 18,140 = 48,474 ✓
LY = 0 across the board because **no 2025 SAP data loaded** (MEGA §5 known gap).

### Frontend — app.html

`renderHomeCombos()` now accepts API data and caches it globally for theme-toggle rebuilds:

```js
var HOME_COMBO_DATA = null;
function renderHomeCombos(apiData){
  if(apiData) HOME_COMBO_DATA = apiData;
  var src = HOME_COMBO_DATA || {};
  var mp = Array.isArray(src.monthly_perf)   ? src.monthly_perf   : [];
  var qp = Array.isArray(src.quarterly_perf) ? src.quarterly_perf : [];
  var toM = v => Math.round((+v||0)/1000000);  // PHP → ₱M for right axis
  // …build arrays + buildHomeComboChart(...) for each series…
}
```

`loadHome()` fires it once dashboard data resolves:

```js
if(d && (d.monthly_perf || d.quarterly_perf)){
  try { renderHomeCombos({ monthly_perf: d.monthly_perf || [], quarterly_perf: d.quarterly_perf || [] }); }
  catch(e){ console.error('[HOME] combo charts:', e); }
}
```

`buildHomeComboChart()` already uses destroy-then-create — switching periods / themes gives a clean chart instance (no categorical-axis caching).

---

## 3 · Deploy

| Step | Action | Result |
|---|---|---|
| 1 | `git commit` | ✅ |
| 2 | `gcloud run deploy --no-traffic --tag preview` | ✅ rev **`00051-roq`** |
| 3 | Preview smoke — `/api/dashboard?period=MTD` | ✅ volume=7640.7 == region_sum=7640.7, 7 monthly entries, 4 quarterly entries |
| 4 | `gcloud run update-traffic --to-latest` | ✅ 100% → `00051-roq` |
| 5 | Prod smoke — same endpoint | ✅ identical numbers |
| 6 | `vercel --prod --yes` | ✅ https://vieforce-hq.vercel.app |

### Rollback

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00049-fof=100 --quiet
```
(`00049-fof` = last Track 2 revision before this Home fix)

---

## 4 · Manual browser verification

Open **https://vieforce-hq.vercel.app** incognito + Ctrl+Shift+R · login `09170000100`.

1. Home → Volume KPI label reads **"Volume (INVOICED)"** · hover the card → tooltip: *"Based on invoiced data (OINV). Delivery volume may differ — see Speed Monitor for operational MT shipped."*
2. Volume value = **7,641 MT** (matches Region National row and sum of Luzon + Mindanao + Visayas + Other).
3. Scroll down to **Monthly Performance** card → 7 month bars (Oct25 → Apr26). Jan/Feb/Mar 2026 bars ~14–18K MT, Apr (current month partial) ~7.6K MT. Green GM line traces at ~₱50–112M. LY bars hidden (zero).
4. **Quarterly Performance** card → 4 quarter bars. Q1 ≈ 48K MT, Q2 ≈ 7.6K MT (April only), Q3/Q4 = 0.
5. Period toggle (7D/MTD/QTD/YTD) does not affect the combo charts — intentional: they're calendar trend charts.

---

## 5 · Scope note

Touched only the Home-allowed surface area:
- `api/dashboard.js` — added `monthly_perf` + `quarterly_perf`, nothing else
- `app.html` — `pg-home` Volume KPI label, `loadHome()` wire, `renderHomeCombos()` signature

Did NOT touch:
- `api/intelligence.js`
- `pg-insights` page section

(per parallel-agent boundary with Agent-Intelligence)

---

*Generated by Home-Fix Agent — 2026-04-18*
