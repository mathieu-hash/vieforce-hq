# CHART REDESIGN REPORT — Home Monthly + Quarterly Combo Charts

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commit:** `2c45f15` — "Home chart redesign: Blue CY vs Slate Grey LY, grouped bars, area-fill GM line, delta badges, premium pill labels"
**Vercel preview:** `https://vieforce-a5o4g73gi-mathieu-7782s-projects.vercel.app`

---

## 1. Color Palette (confirmed)

### Dark mode
| Element | Value | Notes |
|---------|-------|-------|
| CY Volume bars | `rgba(0,174,239,0.95)` | Corporate Blue, near-solid |
| CY Volume hover | `rgba(0,174,239,1)` | full Corporate Blue |
| LY Volume bars | `rgba(120,135,155,0.45)` | **muted slate grey — NOT blue** |
| LY Volume hover | `rgba(120,135,155,0.65)` | slightly more opaque |
| GM line | `#97D700` | Growth Green |
| GM line area fill | `rgba(151,215,0,0.08)` | very faint gradient |
| GM point halo | `#0A1420` (chart bg) | ring around pins |
| GM label pill bg | `rgba(0,42,58,0.92)` | Deep Navy pill |
| GM label pill text | `#97D700` | Growth Green |
| GM label pill border | `rgba(151,215,0,0.3)` | 1px |
| Ticks / axis titles | `rgba(255,255,255,0.35)` / `rgba(255,255,255,0.28)` | neutral muted — no colour tint |
| Grid (left y only) | `rgba(255,255,255,0.05)` | barely visible |
| Tooltip bg | `rgba(6,11,20,0.97)` | deep with subtle border |

### Light mode
| Element | Value | Notes |
|---------|-------|-------|
| CY Volume bars | `rgba(0,74,100,0.92)` | Deep Navy |
| LY Volume bars | `rgba(155,165,180,0.55)` | light grey |
| GM line | `#7AB800` | darker green, readable on white |
| GM line area fill | `rgba(122,184,0,0.10)` | very faint |
| GM point halo | `#ffffff` | white halo |
| GM label pill bg | `rgba(255,255,255,0.95)` | white pill |
| GM label pill text | `#005F33` | deep green |
| GM label pill border | `rgba(151,215,0,0.5)` | 1px Growth Green |
| Ticks / axis titles | `rgba(0,0,0,0.5)` / `rgba(0,0,0,0.4)` | muted black |
| Grid (left y only) | `rgba(0,0,0,0.04)` | barely visible |

---

## 2. Custom Delta Badge Plugin

```js
var deltaBadgePlugin = {
  id: 'deltaBadges',
  afterDatasetsDraw: function(chart){
    var opts = (chart.config.options.plugins || {}).deltaBadges;
    if(!opts || !opts.enabled) return;
    var ctx = chart.ctx;
    var cyMeta = chart.getDatasetMeta(opts.cyIndex);
    var cyData = chart.data.datasets[opts.cyIndex].data;
    var lyData = chart.data.datasets[opts.lyIndex].data;
    if(!cyMeta || cyMeta.hidden) return;
    var light = opts.light;
    cyMeta.data.forEach(function(bar, i){
      var cy = cyData[i], ly = lyData[i];
      if(cy == null || ly == null || !ly) return;
      var pct = (cy - ly) / ly * 100;
      var label = (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%';
      // Threshold → fill / stroke / text color
      var fill, stroke, text;
      if(pct >= 10){
        fill = 'rgba(151,215,0,0.92)'; stroke = '#97D700'; text = '#0A1420';  // Growth Green filled
      } else if(pct >= 0){
        fill = 'transparent'; stroke = light ? '#7AB800' : '#97D700';         // outline green
        text = light ? '#005F33' : '#97D700';
      } else if(pct >= -5){
        fill = 'rgba(255,199,44,0.85)'; stroke = '#FFC72C'; text = '#0A1420';  // gold
      } else {
        fill = 'rgba(239,68,68,0.9)'; stroke = '#EF4444'; text = '#fff';       // red
      }
      // draw rounded rect + text centred above CY bar
      ctx.save();
      ctx.font = 'bold 10px Montserrat';
      var pad = 5, h = 16;
      var w = Math.ceil(ctx.measureText(label).width) + pad * 2;
      var x = bar.x - w/2, y = bar.y - h - 4;
      // ...rounded-rect path + fill + stroke + fillText...
      ctx.restore();
    });
  }
};
Chart.register(deltaBadgePlugin);
```

Enabled per-chart via `plugins.deltaBadges: { enabled: true, cyIndex: 0, lyIndex: 1, light: HC.light }`. Pixel-perfect positioning directly above each CY bar using Chart.js meta coordinates.

---

## 3. Before → After (description)

### Before
- **CY vs LY bars both Deep Navy** at 0.8α vs 0.2α — the eye sees a single dark colour at two opacity levels, easy to confuse at a glance.
- **GM line** 2.5px, no area fill, simple dots.
- **Data labels** were custom canvas `fillText` — raw green numbers ("₱93M") drifting above the line, colliding with the right-axis label strip.
- **Right axis** labels tinted Growth Green (`rgba(151,215,0,0.5)`) — the eye mistook the tinted axis for another line.
- **Grid** drawn under BOTH axes — visual noise.
- **Legend** a tiny custom HTML row of four words; chart title plain "Monthly — Volume & Gross Margin".
- **Tooltip** showed raw numeric values only.

### After
- **CY bars:** bright Corporate Blue (`rgba(0,174,239,0.95)`). **LY bars:** muted slate grey (`rgba(120,135,155,0.45)`) — a completely different hue, so the eye instantly separates the two years. Bars are also now truly *grouped* (`categoryPercentage:0.7`, `barPercentage:0.85`) rather than stacked on top of each other at different opacities.
- **GM line:** 3.5px, tension 0.35, smooth curve. Points are 5px Growth Green with a 2px halo in the chart-background colour (dark navy / white) — looks like a floating pearl.
- **Subtle area fill** under the line at 8% Growth Green alpha — adds premium depth without visual weight.
- **Data-label pills:** chartjs-plugin-datalabels with Deep Navy background (dark) / white (light), 1px Growth-Green border, Source Code Pro bold 11px, Growth-Green text. Positioned `align:'top'` with `offset:6` and `clip:false`. `layout.padding.top:34` reserves space so nothing clips.
- **Delta pills above each CY bar:** `+12%`, `+9%`, `-3%`, etc. Green / outline-green / gold / red per thresholds. Custom Chart.js plugin draws rounded rects + text using meta coords.
- **Right axis:** same neutral muted colour as left axis, no Growth-Green tint. `grid.drawOnChartArea: false` so only the left axis shows grid lines. `border.display:false` removes the solid axis rules.
- **Custom HTML legend** above chart:
  ```
  ● FY2026 Volume    ● FY2025 Volume    ▬ Gross Margin
  ```
  Corporate Blue dot / slate grey dot / Growth-Green line with a soft box-shadow glow. Font 12px / 600 / muted text2.
- **Chart title:**
  - `h3` "Monthly Performance" — 15px / 800 / tight letter-spacing
  - Subtitle — "Volume (bars, MT) · Gross Margin (line, ₱M) · Last 7 months" — 10px / 500 / muted
- **Enhanced tooltip** (index mode, all 3 values at once):
  ```
  Apr
  FY2026 Vol: 14,200 MT  (+20% vs LY)
  FY2025 Vol: 11,800 MT
  Gross Margin: ₱93M  (vs ₱75M LY, +24%)
  ```
  Deep-Navy background, 1px subtle border, Montserrat, 12px padding, 6px radius.

### Cognitive outcome
- **Separation:** you instantly see CY vs LY because the hue differs (blue vs grey), not just the opacity.
- **Focus:** GM line is now the visual hero — green, glowing, labelled, smoothly curved.
- **Narrative:** each CY bar tells a story (+20%, +15%, +20%) without hovering.
- **Cleanliness:** no more colour-coded axis. Just data.

---

## 4. Chart.js Limitations Hit

1. **Theme-toggle live repaint** — because the new design bakes colours into every dataset, plugin option, and tooltip-callback closure, a simple `chart.update('none')` does not refresh them. **Workaround:** `toggleTheme()` now calls `renderHomeCombos()`, which `.destroy()`s and rebuilds both charts. Trade-off: a tiny redraw flash (<100ms). Acceptable.
2. **`chartjs-plugin-datalabels` + `fill:true` line** — the line's filled area was overlapping with the datalabel pill if `offset` was too small. **Workaround:** `offset:6` + `layout.padding.top:34` guarantees the pill floats clearly above the line + any stray fill.
3. **Delta badges clipping** — if a CY bar is at the top of the plot area, the badge would clip. **Workaround:** `layout.padding.top:34` plus the badge's own `y = bar.y - 20` offset place it safely inside the padding.
4. **`datalabels.clip:false`** — on by default clips labels at plot edges. Setting `clip:false` fixed disappearing ₱M labels on the leftmost/rightmost points.
5. **Point halo effect** — achieved by setting `pointBorderColor` to the chart background colour (Deep Navy dark / white light). Chart.js doesn't expose a true "shadow" for points, so the border trick is the cleanest route.

No limitation was blocking. All 10 spec items landed.

---

## 5. Light vs Dark parity

Light mode **matches quality** of dark mode:
- CY bars in Deep Navy (`#004A64`) vs LY in warm light grey — equivalent hue separation.
- GM line in `#7AB800` (darker green) readable against white.
- GM pill: white background, `#005F33` text, Growth-Green border.
- Axis ticks / titles in `rgba(0,0,0,0.5)`/0.4 — softly muted black.
- Point halos in white to pop the dot against the line.
- Delta badges: same thresholds, same Growth-Green fill — identical visual rhythm.

Tested by flipping `data-theme="light"` locally. Both modes look intentionally designed, not "the other mode with colours inverted."

---

## 6. Files Changed

| File | Change |
|------|--------|
| `app.html` | CSS: `.chart-header`, `.chart-title`, `.chart-sub`, `.chart-legend` + dot/line swatch classes with theme overrides. HTML: both Home chart card headers replaced with title + custom HTML legend. JS: new `fmtMillions()`, `gmDataLabels()`, `deltaBadgePlugin`, `homeComboTooltip()`, `buildHomeComboChart()`, `renderHomeCombos()`. `initCharts('pg-home')` now calls `renderHomeCombos()`. `toggleTheme()` rebuilds the combo charts so palette swaps cleanly. |

No backend changes. No `_auth.js` / `_db.js` touched.

---

## 7. Deployment

| Target | Value |
|--------|-------|
| Vercel preview | `https://vieforce-a5o4g73gi-mathieu-7782s-projects.vercel.app` |
| Cloud Run | Unchanged (`vieforce-hq-api-00030-man`) — frontend-only |

---

## 8. What Mat should see

Open **https://vieforce-a5o4g73gi-mathieu-7782s-projects.vercel.app** in incognito · Ctrl+Shift+R.

Scroll to the two bottom Home charts and check:

- [ ] CY bars are bright **Corporate Blue** (or Deep Navy in light mode)
- [ ] LY bars are **muted slate grey** — not a faded blue, visibly a different colour
- [ ] Bars sit **side-by-side** in each month/quarter, not overlapping
- [ ] A **smooth Growth Green curve** with a faint green area fill underneath it
- [ ] Each point on the GM line has a **₱60M / ₱66M / ₱93M pill** floating just above
- [ ] **Above each CY bar**: a small `+12%` / `-3%` / etc. pill (green filled / gold / red based on vs-LY delta)
- [ ] Right axis ticks are the **same muted colour** as the left — no green tint
- [ ] Only the left axis has faint grid lines
- [ ] Card header is **two-line**: bold "Monthly Performance" + small grey subtitle + right-side legend with coloured dots
- [ ] Hover → tooltip shows all 3 metrics at once with vs-LY deltas
- [ ] Toggle theme (🌙 / ☀️ button) — charts repaint cleanly in the other palette

Both the **Monthly** (7 months) and **Quarterly** (4 quarters) charts follow the same treatment.

---

*Generated by Chart Redesign Agent — 2026-04-17*
