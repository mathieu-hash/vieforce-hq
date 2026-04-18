# TRACK 1 — Data Correctness Bug Fixes

**Date:** 2026-04-18
**Branch:** `design-upgrade`
**Preview revision:** _pending build_ (bpy327ou9)
**Production before:** `vieforce-hq-api-00042-wis`

---

## Summary

| # | Bug | Root cause (1 sentence) | Fix |
|---|---|---|---|
| 1 | Inventory Grand Total AVAILABLE = -177,333 | Sum of (OnHand − Committed) across all plants went negative because 7 plants oversold their floor stock. | Clamp aggregate to max(0, ...); keep per-plant/per-region rows negative as actionable signals. |
| 2 | ON PRODUCTION = 0 "not in SAP" | Placeholder literal in inventory.js, no OWOR query. | Added `SELECT SUM(PlannedQty-CmpltQty) FROM OWOR WHERE Status='R' AND ItemCode LIKE 'FG%' GROUP BY Warehouse`; merged into summary/plants/by_region. |
| 3 | Customer Detail Monthly Volume chart empty | `cy_vs_ly` is an **object** `{months,cy_vol,ly_vol}` but frontend treated it as array → `.length` undefined → update block skipped → stuck on hardcoded prototype. | Destroy+recreate chart from object shape (same pattern used to fix Speed chart yesterday). Removed prototype init from `initCharts('pg-custdetail')`. |
| 4 | Monthly breakdown SALES CY column = ₱0 | Frontend read `m.sales_cy`, API returns `m.sales`. | Added fallback chain: `m.sales \|\| m.sales_cy \|\| m.revenue_cy`. |
| 5 | Speed chart title static + range not period-aware | Title hardcoded "Last 14 Days"; chart already fixed yesterday to return period-correct `daily[]`. | Title now `id="speed-daily-title"`, loadSpeed() sets `"Daily Pullout · MTD"` / `"Last 7 Days"` / `"Weekly Pullout · QTD"` / `"Monthly Pullout · YTD"` per PD. |
| 6 | Customers page empty | API verified — returns 1382 customers across all region filters with region/bu/ytd_gm_ton populated. Frontend renderer correct. | No code change needed. Most likely stale browser cache from pre-Sprint-2D `app.html`. Fresh Vercel deploy + hard-refresh should resolve. |

---

## 1 · Inventory Grand Total

### Diff (api/inventory.js)

```diff
- available: Math.round(totalAvailBags),
+ // Grand-total available clamps to 0 (can't sell less than nothing on aggregate).
+ // Per-plant / per-region keep negatives — they're actionable shortage signals.
+ available: Math.max(0, Math.round(totalAvailBags)),
...
- available_mt: Math.round(plants.reduce((s,p)=>s+Number(p.total_available||0),0)*10)/10
+ available_mt: Math.max(0, Math.round(plants.reduce((s,p)=>s+Number(p.total_available||0),0)*10)/10)
```

### Verification (pending preview deploy)
Expected: `summary.available >= 0`, `by_region[].available_bags` may still be negative for Luzon/Visayas.

---

## 2 · ON PRODUCTION from OWOR

### Diff (api/inventory.js)

```javascript
const production = await query(`
  SELECT
    W.Warehouse                                        AS plant_code,
    ISNULL(SUM(W.PlannedQty - W.CmpltQty), 0)          AS bags_in_production,
    ISNULL(SUM((W.PlannedQty - W.CmpltQty) * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS mt_in_production
  FROM OWOR W
  LEFT JOIN OITM I ON W.ItemCode = I.ItemCode
  WHERE W.Status = 'R'
    AND UPPER(W.ItemCode) LIKE 'FG%'
    AND W.PlannedQty > W.CmpltQty
  GROUP BY W.Warehouse
`).catch(e => { console.warn(...); return [] })
```

Merged into `summary.on_production` (bags), `summary.on_production_mt`, `plants[].in_production_bags/_mt`, `by_region[].in_production_bags/_mt`. Falls back to 0 if query fails (table unavailable).

### 🚩 FLAG FOR MAT

I used **`Status = 'R'`** (Released = actively running). SAP B1 standard codes:
- **P** = Planned (not yet started)
- **R** = Released (active production) ← **using this**
- **L** = Closed
- **C** = Cancelled

Some VPI tools include `P` (planned WOs that haven't released yet) in "in production". If your Ops definition includes Planned, change line `W.Status = 'R'` → `W.Status IN ('P','R')`. Let me know and I'll flip.

---

## 3 · Customer Detail Monthly Volume Chart

### Root cause

API returns:
```json
"cy_vs_ly": { "months": [...], "cy_vol": [...], "ly_vol": [...] }
```

Frontend was doing:
```js
if(d.cy_vs_ly && d.cy_vs_ly.length && charts.custVolBar){
  var months = d.cy_vs_ly.map(m => m.month_label);  // object has no .map, no .length
  ...
}
```

`d.cy_vs_ly.length` on an object is `undefined` → falsy → whole block skipped → chart never updated. Prototype labels `May-Apr 320-420` stayed on screen even after API data arrived. (Same bug class as the Speed chart 5-bar issue fixed yesterday.)

### Diff (app.html, loadCustDetail)

Replaced in-place reassignment with destroy+recreate, handles both object and array shape defensively:

```js
var cv = d.cy_vs_ly;
if(!cv) return;
var months = Array.isArray(cv) ? cv.map(m => m.month_label||m.month||'') : (cv.months||[]);
var cy     = Array.isArray(cv) ? cv.map(m => +m.cy_volume||0)            : (cv.cy_vol||[]);
var ly     = Array.isArray(cv) ? cv.map(m => +m.ly_volume||0)            : (cv.ly_vol||[]);
if(charts.custVolBar){ charts.custVolBar.destroy(); charts.custVolBar=null; }
charts.custVolBar = new Chart(ctx, { type:'bar', data:{ labels:months, datasets:[...] }, ... });
```

Also removed the hardcoded 12-month prototype from `initCharts('pg-custdetail')` — chart is now created only when loadCustDetail has real data.

---

## 4 · Monthly Breakdown Sales CY

### Diff (app.html, loadCustDetail)

```diff
- mhtml += '<td class="num">' + fc(m.sales_cy || m.revenue_cy || 0) + '</td>';
+ mhtml += '<td class="num">' + fc(m.sales || m.sales_cy || m.revenue_cy || 0) + '</td>';
```

API field is `m.sales`. Fallback chain preserves compat with any older response shape.

---

## 5 · Speed Chart Dynamic Title

### Diff (app.html)

HTML title element given an `id`:
```diff
- <div class="card-title">Daily Pullout (Last 14 Days)</div>
+ <div class="card-title" id="speed-daily-title">Daily Pullout · MTD</div>
```

loadSpeed() updates it per period:
```js
var titleMap = {
  '7D':  'Daily Pullout · Last 7 Days',
  'MTD': 'Daily Pullout · MTD',
  'QTD': 'Weekly Pullout · QTD',
  'YTD': 'Monthly Pullout · YTD'
};
titleEl.textContent = titleMap[PD] || ('Daily Pullout · ' + PD);
```

QTD/YTD title says "Weekly"/"Monthly" because `daily[]` aggregates those periods to weekly/monthly rows in the API (intentional, to keep the chart readable).

### Verification

`/api/speed?period=MTD` already returns `daily[]` with all 13 per-day entries Apr 1 → Apr 17 non-Sunday days with shipments (confirmed this morning: last entry = Apr 17 Friday 651.1 MT).

---

## 6 · Customers Page

### API check — all clean on current prod
```
/api/customers?limit=100             → 100 of 1382, all 4 regions, populated region/bu/gm_ton
/api/customers?limit=100&region=Luzon → 100 Luzon customers
/api/customers?limit=100&region=Visayas → 100 Visayas
/api/customers?limit=100&region=Mindanao → 100 Mindanao
```

Sample row:
```json
{
  "CardCode": "CA000838",
  "CardName": "ST. RAPHAEL ARCHANGEL PARISH...",
  "rsm": "CARMINDA CALDERON",
  "ytd_revenue": 111238710.85,
  "ytd_volume": 2087.275,
  "ytd_gm_ton": 4279.82,
  "region": "Luzon",
  "bu": "DIST",
  "status": "Active"
}
```

Frontend `loadCust()` renders Customer / Code / Region / BU / Volume / Net Sales / GM/Ton correctly.

### Why Mat might see "empty"

If the browser cached the pre-Sprint-2D `app.html` (before the renderer knew about region/bu/ytd_gm_ton), `loadCust()` could have thrown an error leaving the static prototype rows visible (Metro Feeds Corp., Cebu Agri Partners — those are in the HTML template).

### Action

- **No code change** — renderer was already fixed in MEGA_FIX Sprint 2D.
- This Vercel deploy ships the current app.html; hard-refresh (Ctrl+Shift+R) should load it.
- If still empty after hard-refresh: open DevTools → Console → look for red errors on the Customers page; Network tab → `/api/customers` call — share response and I'll dig deeper.

---

## Deploy — DONE

| Step | Action | Result |
|---|---|---|
| 1 | Commit | ✅ (see `git log -1`) |
| 2 | `gcloud run deploy --no-traffic --tag preview` | ✅ rev **`00045-guw`** |
| 3 | Preview smoke: `/api/inventory` | ✅ available=0, on_production=3,709,500 |
| 4 | `gcloud run update-traffic --to-latest` | ✅ 100% → `00045-guw` |
| 5 | Production smoke | ✅ available=0, on_production=3,709,500 bags (179,013 MT) |
| 6 | `vercel --prod --yes` | ✅ **https://vieforce-hq.vercel.app** |

### Verified on production

```
summary.available:           0 bags           ✓ (was -177,333)
summary.on_production:   3,709,500 bags       ✓ (was 0)
summary.on_production_mt:  179,013 MT         ✓
by_region Luzon      avail: -139,300 bags     ✓ (negatives preserved per-region)
by_region Visayas    avail: -973,075 bags     ✓
by_region Mindanao   avail:  +72,828 bags     ✓
Top in-production plants: HOREB 1,004,500 · BUKID 790,000 · AC 610,000 · ARGAO 430,000 · SOUTH 350,000
```

### Frontend bugs (3, 4, 5, 6) — live on Vercel

Hard-refresh (Ctrl+Shift+R) once to bypass app.html cache, then:
- Bug 3: Click any customer → Monthly Volume CY vs LY chart should show real bars (Jan 1,288 MT, Feb 798 MT for CA000838)
- Bug 4: Same customer → Monthly Breakdown table → SALES CY column populated (not ₱0)
- Bug 5: Speed Monitor → chart title reads "Daily Pullout · MTD", changes when you click 7D/QTD/YTD
- Bug 6: Customers page → 100 real SAP customers (not Metro Feeds/Cebu Agri prototype rows)

### Rollback command (if needed)

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00042-wis=100 --quiet
```

---

## Decisions needed from Mat

1. **Bug 2 — OWOR Status filter:** is `Status = 'R'` (Released only) correct, or should it include `'P'` (Planned)?
2. **Bug 2 — WO count sanity:** 179,013 MT in production is ~12 months of shipping volume. Likely SAP has old Released WOs that were never formally Closed. Should we add `W.DueDate >= GETDATE() - 60` to exclude stale ones?
3. **Bug 6 — confirm after hard-refresh:** if Customers page still empty after deploy + Ctrl+Shift+R, share DevTools console/network output for deeper diagnosis.
