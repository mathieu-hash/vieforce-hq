# PULLOUT + ANIMATION REPORT

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commit:** `48ce3c7` — "Dynamic Daily Pullout per period + 4 subtle animation layers"
**Cloud Run revision:** `vieforce-hq-api-00031-jud` · `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app`
**Vercel preview:** `https://vieforce-4rqbfobd2-mathieu-7782s-projects.vercel.app`

---

## 1. Daily Pullout — Verified Values per Period

Live SAP data, pulled from `/api/speed?period={P}` on revision `00031-jud` today:

| Period | daily_pullout | shipping_days (elapsed / total / remaining) | period_volume_mt | projected_period_volume | vs_prior_period_pct |
|--------|--------------:|---------------------------------------------|-----------------:|------------------------:|--------------------:|
| **7D**  | 632.5 MT/d | 7 / 7 / 0   | 4,428 MT  | 4,428 MT   | **+33.1%** |
| **MTD** | 514.3 MT/d | 15 / 26 / 11 | 7,714 MT  | 13,371 MT  | **−17.2%** |
| **QTD** | 514.3 MT/d | 15 / 78 / 63 | 7,714 MT  | 40,114 MT  | **−8.8%** |
| **YTD** | 610.8 MT/d | 92 / 313 / 221 | 56,198 MT | 191,194 MT | **+0.0%** (no 2025 SAP data) |

**Shipping days** excludes Sundays only (VPI Mon-Sat). Calculated in JS with `countShippingDays(from, to)` which iterates calendar days and skips `getDay() === 0`.

**Prior period window** (via `getPriorPeriodWindow`):
- 7D → days -14 through -7
- MTD → previous month day 1 through same day-of-month
- QTD → previous quarter day 1 through same elapsed-days offset
- YTD → last year Jan 1 through same day-of-year

All four match Mat's expected shape:
- 7D: shipping days = 7 of 7, 0 remaining ✓
- MTD: 15 of 26, 11 remaining (matches the spec example exactly) ✓
- QTD: 78 total shipping days (matches ~78) ✓
- YTD: 106 expected by Mat, we got 92 — discrepancy is expected because our shipping-day count uses calendar days excluding Sundays. 106 was a rough estimate. Actual 92 is correct (106 days from Jan 1 minus ~15 Sundays = 91–92 shipping days) ✓

---

## 2. Animation Layer 1 — `pulseRefresh`

**CSS** (added near top of stylesheet, right after `.kpi-sm`):

```css
.kpi{transition:box-shadow 400ms ease-out}
.kpi.refreshing{animation:kpi-pulse 600ms ease-out}
@keyframes kpi-pulse{
  0%   { box-shadow: 0 0 0 0   rgba(0,174,239,0);   }
  30%  { box-shadow: 0 0 0 3px rgba(0,174,239,0.4); }
  100% { box-shadow: 0 0 0 0   rgba(0,174,239,0);   }
}
[data-theme="light"] .kpi.refreshing{animation:kpi-pulse-light 600ms ease-out}
@keyframes kpi-pulse-light{
  0%   { box-shadow: 0 0 0 0   rgba(0,74,100,0);   }
  30%  { box-shadow: 0 0 0 3px rgba(0,74,100,0.3); }
  100% { box-shadow: 0 0 0 0   rgba(0,74,100,0);   }
}
```

Reused existing `.kpi` class rather than inventing a new one — selector matches all dashboard cards.

**JS helper:**

```js
function pulseRefresh(pageId){
  if(PREFERS_REDUCED_MOTION) return;
  var pg = document.getElementById(pageId); if(!pg) return;
  pg.querySelectorAll('.kpi').forEach(function(c){
    c.classList.remove('refreshing');
    void c.offsetWidth;                 // reflow trick — restarts animation cleanly
    c.classList.add('refreshing');
    setTimeout(function(){ c.classList.remove('refreshing'); }, 650);
  });
}
```

**Wired at the end of every page-loader** (just before the `catch`): `loadHome`, `loadSales`, `loadAR`, `loadInv`, `loadSpeed`, `openCust` (Customer Detail), `loadMargin`, `loadIntelligence`, `loadTeam`, `loadBudget`. 10 pages total.

Only fires on successful renders — errors in the catch branch don't trigger the pulse.

---

## 3. Animation Layer 2 — `animateNumber`

**JS helper** (honours `prefers-reduced-motion`, ease-out cubic, 500ms):

```js
function animateNumber(el, newValue, formatter, duration){
  if(!el) return;
  duration = duration || 500;
  var oldVal = parseFloat(el.dataset.rawValue);
  if(isNaN(oldVal)) oldVal = 0;
  el.dataset.rawValue = String(newValue);
  if(PREFERS_REDUCED_MOTION || Math.abs(oldVal - newValue) < 0.01){
    el.innerHTML = formatter(newValue); return;
  }
  var start = performance.now();
  var diff  = newValue - oldVal;
  function step(now){
    var t = Math.min((now - start) / duration, 1);
    var eased = 1 - Math.pow(1 - t, 3);      // ease-out cubic
    el.innerHTML = formatter(oldVal + diff * eased);
    if(t < 1) requestAnimationFrame(step);
    else el.innerHTML = formatter(newValue);
  }
  requestAnimationFrame(step);
}
```

**Uses `innerHTML`, not `textContent`**, because our KPI cells embed unit `<span>` suffixes (e.g., `"504<span> MT/d</span>"`). `textContent` would wipe them.

**Applied to Home hero KPIs** (7 cards):

| Prefix | Cell | Formatter |
|--------|------|-----------|
| `sales` | `#hk-sales` | `fc` (₱M / ₱K) |
| `vol` | `#hk-vol` | `fn` or `n+' bags'` based on UT toggle |
| `gm` | `#hk-gm` | `fc` |
| `gmt` | `#hk-gmt` | `'₱'+fcn(Math.round(n))` |
| — | `#hk-dso` | `Math.round(v)+'<span>d</span>'` |
| — | `#hk-speed` | `fcn(Math.round(v))+'<span> MT/d</span>'` |
| — | `#hk-pending` | `fcn(Math.round(v))+'<span> MT</span>'` |

Wired via an edit to `setCard()` (which handles the first 4) plus direct `animateNumber(sel(...), v, formatter)` calls for DSO, Daily Pullout, and Pending PO.

**Not applied to** (per spec): table cells, labels, dates, chart values. Chart numbers handled by Layer 4.

**Other pages**: currently use `textContent`/`innerHTML` directly in render helpers. Their KPI cards still get the Layer-1 pulse glow and Layer-4 chart morph, so the "alive" feel is covered. Migrating their big-number writes to `animateNumber` is a straightforward follow-up when/if desired — no API change, pure client refactor.

---

## 4. Animation Layer 3 — Filter pill click feedback

Discovered classes in the codebase:
- `.tb-chip` — topbar period chips (7D / MTD / QTD / YTD)
- `.tb-compare-chip` — topbar compare chips (vs PP / vs LY)
- `.tb-toggle-btn` — topbar unit toggle (MT / Bags) + inventory unit toggle
- `.filter-chip` — in-page region / mode filter pills

**CSS:**
```css
.tb-chip, .tb-compare-chip, .tb-toggle-btn, .filter-chip{transition:transform 120ms ease-out}
.tb-chip:active, .tb-compare-chip:active, .tb-toggle-btn:active, .filter-chip:active{transform:scale(0.94)}
.tb-chip.just-clicked, .tb-compare-chip.just-clicked, .tb-toggle-btn.just-clicked, .filter-chip.just-clicked{
  animation:pill-click 200ms ease-out
}
@keyframes pill-click{
  0% { transform: scale(1); }
  50%{ transform: scale(0.96); }
  100%{ transform: scale(1); }
}
```

**JS helper:**
```js
function addClickAnimation(btn){
  if(!btn || PREFERS_REDUCED_MOTION) return;
  btn.classList.remove('just-clicked');
  void btn.offsetWidth;
  btn.classList.add('just-clicked');
  setTimeout(function(){ btn.classList.remove('just-clicked'); }, 220);
}
```

**Handlers updated:** `setPd`, `setCmp`, `setU`, `setF`, `fltCust`, `setARFilter` — all call `addClickAnimation(el)` at the top.

**Same-click debounce** on `setPd`: if the already-active chip is re-clicked within 250ms, the whole handler is skipped — no refetch, no re-animation. Prevents the double-fire Mat flagged in the rules.

---

## 5. Animation Layer 4 — Chart.js smooth morphs

**Single global hook** at Chart registration (no per-chart edits needed):

```js
Chart.defaults.font.family = 'Montserrat';
Chart.defaults.animation  = { duration: 800, easing: 'easeOutQuart' };
Chart.defaults.transitions = {
  active: { animation: { duration: 400 } },
  resize: { animation: { duration: 0   } }
};
if(PREFERS_REDUCED_MOTION){
  Chart.defaults.animation  = { duration: 0 };
  Chart.defaults.transitions = { active:{ animation:{ duration: 0 } } };
}
```

**Affected charts** (inherit automatically — zero option changes in their configs):
- `homeMonthlyChart`, `homeQuarterlyChart` (the redesigned combo charts)
- `speedChart` (Daily Pullout 14-day bars)
- `custVolBarChart` (Customer Detail CY vs LY)
- `budgetHistoryChart` (Volume Growth history)
- `budgetMonthlyChart` (Monthly Actual vs Budget)
- `salesTrendChart` · `gmGroupChart` (Sales page)
- `marginRegionChart` (Margin page)

When `chart.update()` runs after a data refresh, bars/lines morph over 800ms with `easeOutQuart`. Hover + dataset toggles animate at 400ms.

---

## 6. Accessibility — `prefers-reduced-motion`

Runtime detection + CSS guard:

```js
var PREFERS_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

```css
@media (prefers-reduced-motion: reduce){
  .kpi.refreshing, .tb-chip.just-clicked, .tb-compare-chip.just-clicked,
  .tb-toggle-btn.just-clicked, .filter-chip.just-clicked { animation:none !important; }
  * { animation-duration:0.01ms !important; transition-duration:0.01ms !important; }
}
```

`animateNumber` / `addClickAnimation` / `pulseRefresh` all early-return when `PREFERS_REDUCED_MOTION` is true. Chart.js defaults switch to `duration: 0`.

Users with OS-level reduced motion enabled get instant updates with no motion at all.

---

## 7. Deployment

| Target | Value |
|--------|-------|
| Cloud Run preview | `vieforce-hq-api-00031-jud` · 0% traffic · `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app` |
| Vercel preview | `https://vieforce-4rqbfobd2-mathieu-7782s-projects.vercel.app` |
| Production | Untouched |

Git: `48ce3c7` pushed to `design-upgrade`.

---

## 8. What Mat should see (incognito + Ctrl+Shift+R)

**https://vieforce-4rqbfobd2-mathieu-7782s-projects.vercel.app**

### Dynamic Daily Pullout
- [ ] Home → 6th KPI card label reads **"Daily Pullout · MTD"**.
- [ ] Click **7D** chip → label flips to **"Daily Pullout · 7D"**, big number changes to ~**633 MT/d**, "7 of 7 shipping days · 0 remaining", delta pill shows **▲ 33.1% vs prior 7D**.
- [ ] Click **MTD** → label "Daily Pullout · MTD", ~**514 MT/d**, "15 of 26 · 11 remaining", **▼ 17.2% vs prior MTD**.
- [ ] Click **QTD** → "Daily Pullout · QTD", ~**514 MT/d**, "15 of 78 · 63 remaining", **▼ 8.8% vs prior QTD**.
- [ ] Click **YTD** → "Daily Pullout · YTD", ~**611 MT/d**, "92 of 313 · 221 remaining". (vs-LY delta +0% because SAP has no 2025 data yet.)
- [ ] Navigate to Speed Monitor page → numbers now match whatever period is selected in topbar (not forced MTD).

### Animations
- [ ] Click any topbar chip → the chip briefly scales 0.96 → 1 (bounce).
- [ ] Within ~300ms of the chip click, each KPI card on the page gets a **3px blue glow ring pulse**.
- [ ] The 7 Home hero numbers **tick up/down** over ~500ms instead of snapping.
- [ ] Home Monthly + Quarterly charts: bars and the green line **morph smoothly** over ~800ms when period changes.
- [ ] Click MT ↔ Bags → Volume value ticks between units.
- [ ] Turn on OS-level "reduce motion" (Windows: Settings → Accessibility → Visual effects → turn off animation) → reload → all animations disabled, numbers snap instantly.

Pages feel alive but not distracting — total refresh feel <1s on every click.

---

*Generated by Pullout + Animations Agent — 2026-04-17*
