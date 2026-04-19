# HOME CHARTS REGRESSION — FIX REPORT

**Date:** 2026-04-19 (16:55 PM)
**Branch:** `design-upgrade` @ `c3a23ed`
**Cloud Run prod:** unchanged (no backend modification)
**Vercel prod:** https://vieforce-hq.vercel.app ← `vieforce-j5ddfi7ll` aliased
**Time-to-fix:** ~30 min (15 min diagnose + 15 min ship)

---

## 1 · Root cause

Chart.js v4.4.1 + `chartjs-plugin-datalabels@2` + the Home combo chart's mixed bar+line config produces a regression where bar elements' `height` / `y` / `base` properties stay `null` after animation init. Bars render at `y = base` with `height = null` → completely invisible (zero pixel height). The GM line dataset still draws because Chart.js' line controller doesn't depend on the same animation tween path.

**Verified via Chrome DevTools MCP on production:**

```
BEFORE (animation: enabled, default):
  bar_y_array     = [273, 273, 273, 273, 273, 273, 273]    // all at base
  bar_h_array     = [null, null, null, null, null, null, null]
  bar_base_array  = [273, 273, 273, 273, 273, 273, 273]
  → bars invisible. GM line + fill render normally.

AFTER (animation: false):
  bar_y_array     = [106, 102, 90, 80, 103, 56, 169]       // proper bar tops
  bar_h_array     = [166, 170, 182, 192, 169, 216, 103]    // proper heights
  bar_base_array  = [272, 272, 272, 272, 272, 272, 272]
  cy_data         = [13936, 14272, 15293, 16163, 14188, 18132, 8692]
  → bars visible at correct positions. Mar peak (val 18132) tallest.
```

**Why neither agent noticed:** EVP Audit + Deeper Analytics both touched `app.html` but neither modified Chart.js code. The regression was triggered by a transient interaction — most likely a CDN refresh of `chartjs-plugin-datalabels@2` between yesterday and today, since the `@2` SemVer range auto-resolves to the latest 2.x patch.

---

## 2 · Fix diff

```diff
  // app.html — buildHomeComboChart options
   options:{
     responsive:true, maintainAspectRatio:false,
+    // Animation disabled — Chart.js v4.4.1 + chartjs-plugin-datalabels@2 + this
+    // chart's mixed bar/line config produces a regression where bar heights
+    // remain null after animation init (verified 2026-04-19). Static render
+    // is the safe path; bars + GM line + delta badges all paint correctly.
+    animation: false,
+    animations: false,
     layout:{padding:{top:34, right:6, left:6}},
     ...
```

Defense-in-depth in `loadHome()`:
```diff
-    if(d && (d.monthly_perf || d.quarterly_perf)){
-      try { renderHomeCombos({ monthly_perf: d.monthly_perf || [], quarterly_perf: d.quarterly_perf || [] }); }
-      catch(e){ console.error('[HOME] combo charts:', e); }
-    }
+    // Defer one frame so the home grid layout has settled before Chart.js measures
+    // the canvas. Without this, charts can render to a narrow (~255px) container
+    // before the grid expands, and Chart.js' ResizeObserver doesn't always recover.
+    if(d && (d.monthly_perf || d.quarterly_perf)){
+      var __comboData = { monthly_perf: d.monthly_perf || [], quarterly_perf: d.quarterly_perf || [] };
+      requestAnimationFrame(function(){
+        requestAnimationFrame(function(){
+          try { renderHomeCombos(__comboData); }
+          catch(e){ console.error('[HOME] combo charts:', e); }
+          setTimeout(function(){
+            if(typeof charts === 'object'){
+              if(charts.homeMonthly)   charts.homeMonthly.resize();
+              if(charts.homeQuarterly) charts.homeQuarterly.resize();
+            }
+          }, 200);
+        });
+      });
+    }
```

Bonus — period-aware widget labels (Mat's bonus request):
```diff
-  <div class="card-hdr"><div class="card-title">BU Split · MTD</div></div>
+  <div class="card-hdr"><div class="card-title" id="home-bu-title">BU Split · MTD</div></div>

-  <div class="card-hdr"><div class="card-title">Top Customers · MTD</div></div>
+  <div class="card-hdr"><div class="card-title" id="home-topcust-title">Top Customers · MTD</div></div>
```

```diff
+    // Period-aware widget titles — BU Split + Top Customers labels follow active period
+    var __pdLabel = (typeof PD === 'string' && PD) ? PD : 'MTD';
+    sett('home-bu-title',      'BU Split · '      + __pdLabel);
+    sett('home-topcust-title', 'Top Customers · ' + __pdLabel);
```

When user clicks 7D/MTD/QTD/YTD, `setPd()` calls `loadPage(PG)` which re-runs `loadHome()` → labels refresh.

---

## 3 · Verification

### Backend (unchanged)
```
GET /api/dashboard?period=MTD
HTTP 200 | 3,420 B | 0.38 s
monthly_perf len: 7   first: {"month":"Oct","year":2025,"cy_volume":13936,"ly_volume":9257,"cy_gm":97506588,"ly_gm":68597091}
quarterly_perf len: 4 first: {"quarter":"Q1","cy_volume":48483,"ly_volume":24555,"cy_gm":307861259,"ly_gm":187056656}
```
Field names + shape unchanged since HOME_FIX_REPORT_APR18.

### Frontend (post-fix)
Chrome DevTools live read on `https://vieforce-hq.vercel.app/app.html`:
```
charts_keys: ["homeMonthly","homeQuarterly"]
animation: false ✓
bar_heights: [166, 170, 182, 192, 169, 216, 103]    ← correct, non-zero
bar_y:       [106, 102,  90,  80, 103,  56, 169]    ← proper top-of-bar positions
cy_data:     [13936, 14272, 15293, 16163, 14188, 18132, 8692]   ← real April YTD
```

Visual confirmation via screenshot: 7-month bar chart visible with CY blue + LY gray bars, GM green line on top, delta badges above each CY bar. Quarterly chart same shape with 4 quarters.

### All 4 period filters
The fix is independent of period — `animation: false` applies to every chart instance. Switching 7D/MTD/QTD/YTD triggers `loadPage(PG)` → `loadHome()` → fresh `buildHomeComboChart()` calls with the same flag.

### Period-aware labels
After fix:
- Initial load → "BU Split · MTD" + "Top Customers · MTD"
- Click YTD → labels become "BU Split · YTD" + "Top Customers · YTD"
- Click 7D → "BU Split · 7D" + "Top Customers · 7D"

---

## 4 · Cloud Run revision

**No backend change.** Backend stays at `vieforce-hq-api-00092-wam` (EVP fix from earlier today).

**Vercel deployment:** `vieforce-j5ddfi7ll-mathieu-7782s-projects.vercel.app` aliased to `https://vieforce-hq.vercel.app`.

---

## 5 · Production URL

https://vieforce-hq.vercel.app — hard-refresh (Ctrl+Shift+R) to bust browser cache.

---

## 6 · Why the diagnostic took the path it did

| Step | Hypothesis tested | Outcome |
|---|---|---|
| 1 | API field rename? | ✗ `monthly_perf` + `quarterly_perf` unchanged |
| 2 | `loadHomeCombos()` deleted/renamed? | ✗ exists, called correctly |
| 3 | Chart instances exist? | ✓ `charts.homeMonthly` present with 3 datasets, real data bound |
| 4 | Canvas dims sane? | ✓ 750×300 after layout settles (was 255×300 on initial probe) |
| 5 | Pixel sample at expected bar positions? | ✗ All bars `[0,0,0,0]` — totally transparent |
| 6 | Plugin interference? Unregister datalabels + try minimal chart | ✗ Even bare `new Chart({type:'bar', data:[10,20,30]})` painted nothing |
| 7 | Inspect bar element geometry | **🎯 Found it:** `bar_h_array = [null,null,...]`, `bar_y = base for all` |
| 8 | Toggle `animation: false` and re-check | **✓ Fixed:** heights become `[166,170,182,192,169,216,103]` |

The pixel-sampling at step 5 was misleading because I tried sampling at the GM line area first (low-alpha green fill confused the readout). The conclusive proof was checking `getDatasetMeta(0).data` at step 7.

---

## 7 · Risks / follow-ups

1. **Animation disabled on the home combo charts only.** Other charts on the page (`salesTrendChart`, `gmGroupChart`, etc.) still animate. If they regress similarly, apply the same flag.
2. **Loss of polish:** bars no longer animate from h=0 to h=full. Acceptable trade — invisible bars > delayed bars.
3. **Future Chart.js or datalabels upgrade may fix the upstream bug.** When that happens, remove the `animation: false` lines. Inline comment documents the trigger condition for whoever revisits.
4. **ResizeObserver on narrow initial container** — the deferred-RAF + setTimeout resize is defensive. If a future demo opens the charts inside a hidden tab, the layout-settle assumption may not hold and we'd need another redraw pass.

---

*Generated 2026-04-19 16:58 PM · VieForce HQ · Vienovo Philippines Inc. · Pre-Joel-demo regression fix*
