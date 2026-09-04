/*
 * margin-explorer-dissection.js — COST: the finished-feed trajectory and the
 * ingredient cost contribution, from the endpoint's `dissection` block.
 *
 *   1. GM/ton · revenue/ton · COGS/ton trajectory (cross-DB Sep-2025 -> now; the
 *      running month dashed). ONE shared ₱/ton axis, so the gap between the
 *      lines is the real COGS/ton, plus an INDEX-TO-100 toggle (each series
 *      over its own first complete month with volume) so a cost move and a
 *      price move can be compared as rates.
 *   2. Ingredient cost contribution (recipe-weighted, top movers; per ton of
 *      feed — national, not reconciled to the sales-based bridges).
 *
 * Mounts its own block into #mexp-cost-host (the controller's Cost panel).
 * Exposes window.MEXP_renderDissection(dissection, scopeLabel),
 *         window.MEXP_resetDissection() — called by the controller on scope change,
 *         window.MEXP_setDissectionUpdating(on) — dim during phase B.
 *
 * The monthly category table and the AI read that used to live here are gone:
 * the table is the page's hero (mexp2-panel-trendmatrix.js) and the AI read is
 * the controller's, built from the view model on screen.
 *
 * Staleness: a good render is kept only for the scope it was painted for. Same
 * scope, refresh failed → dim + "source busy — showing <scope>". New scope with
 * nothing → "No finished-feed trajectory for <scope> — <reason>". Never hides.
 * Charts are rebuilt from the cached payload when the shell flips data-theme.
 */
(function () {
  'use strict';
  function cssVar(n, f) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v || '').trim() || f; } catch (e) { return f; } }
  // Semantic tokens from css/mexp2.css (dark on :root, light under [data-theme="light"]);
  // the shell tokens are the fallback so the chart never paints without colour.
  function P() {
    return {
      pos: cssVar('--mx2-pos', cssVar('--green', '#22C58B')), neg: cssVar('--mx2-neg', cssVar('--red', '#FF6F61')),
      accent: cssVar('--mx2-accent', cssVar('--blue', '#00AEEF')), text3: cssVar('--mx2-text3', cssVar('--text3', 'rgba(240,244,250,0.4)')),
      grid: cssVar('--mx2-grid', cssVar('--glass-border', 'rgba(255,255,255,0.07)')), zero: cssVar('--mx2-grid-zero', cssVar('--text4', 'rgba(240,244,250,0.42)')),
      posSoft: cssVar('--mx2-pos-soft', 'rgba(34,197,139,.12)')
    };
  }
  function esc(s) { return window.esc ? window.esc(s) : String(s == null ? '' : s); }
  function pt(n) { return '₱' + Math.round(+n || 0).toLocaleString(); }
  function ptS(n) { n = +n || 0; var s = '₱' + Math.round(Math.abs(n)).toLocaleString(); return n > 0 ? '+' + s : (n < 0 ? '−' + s : s); }
  function kill(c) { if (c && c._ch) { try { c._ch.destroy(); } catch (e) {} c._ch = null; } if (window.Chart && Chart.getChart) { var e = Chart.getChart(c); if (e) { try { e.destroy(); } catch (x) {} } } }

  // ---- one-time DOM ----
  function ensure() {
    var page = document.getElementById('pg-margin-explorer'); if (!page) return null;
    // mount inside the controller's Cost panel; fall back to the page wrap
    var host = document.getElementById('mexp-cost-host') || page.querySelector('.mexp-wrap') || page;
    var sec = document.getElementById('mexp-diss'); if (sec) return sec;
    sec = document.createElement('div'); sec.id = 'mexp-diss';
    sec.innerHTML =
      '<style>' +
      '#mexp-diss{margin-top:16px;padding-top:14px;border-top:1px solid var(--mx2-divider,var(--glass-border))}' +
      '#mexp-diss .dh{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 10px;flex-wrap:wrap}' +
      '#mexp-diss .dt{font-size:12px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}' +
      '#mexp-diss .dsub{font-size:9.5px;color:var(--text3);font-weight:700;line-height:1.45;margin-top:3px}' +
      '#mexp-diss .dgrid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}' +
      '@media(max-width:1100px){#mexp-diss .dgrid2{grid-template-columns:1fr}}' +
      '#mexp-diss .dp{border:1px solid var(--mx2-border,var(--glass-border));border-radius:var(--r-lg);background:var(--mx2-surface2,var(--surface));padding:12px 14px;min-width:0}' +
      '#mexp-diss .dp h4{margin:0 0 8px;font-size:11px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}' +
      '#mexp-diss .dp h4 small{font-weight:600;font-size:9px;opacity:.8;text-transform:none;letter-spacing:0}' +
      '#mexp-diss .cw{position:relative;width:100%;height:230px}' +
      '#mexp-diss .cw canvas{width:100%!important}' +
      '#mexp-diss .ctoggle{display:inline-flex;border:1px solid var(--mx2-border,var(--glass-border));border-radius:8px;overflow:hidden}' +
      '#mexp-diss .ctoggle button{background:transparent;border:0;color:var(--text3);font-size:10px;font-weight:800;letter-spacing:.3px;padding:5px 11px;cursor:pointer;text-transform:none}' +
      '#mexp-diss .ctoggle button.on{background:var(--mx2-accent,var(--blue));color:var(--mx2-accent-fg,#fff)}' +
      '#mexp-diss .dnote{font-size:9.5px;color:var(--text3);font-weight:600;line-height:1.45;margin-top:6px}' +
      '</style>' +
      '<div class="dh"><div><div class="dt">Cost — Finished-feed trajectory <span style="font-size:9px;color:var(--text3);letter-spacing:0;text-transform:none">₱/MT · gross of off-invoice discount · finished feed only (103), credit notes netted</span></div>' +
      '<div class="dsub" id="diss-sub">—</div></div></div>' +
      '<div class="dgrid2">' +
      '<div class="dp"><h4><span>GM/MT · Revenue/MT · COGS/MT</span>' +
        '<span class="ctoggle" id="diss-traj-toggle"><button type="button" data-mode="abs" class="on" title="One shared ₱/MT axis: the gap between the lines is the real COGS/MT">₱/MT</button>' +
        '<button type="button" data-mode="index" title="Each series over its own first complete month with volume = 100, so a cost move and a price move compare as rates">Index = 100</button></span></h4>' +
        '<div class="cw"><canvas id="diss-traj"></canvas></div><div class="dnote" id="diss-traj-note"></div></div>' +
      '<div class="dp"><h4><span>Ingredient cost contribution</span><small>recipe-weighted · ₱/MT of feed · * = no purchase in one month, price carried (recipe effect only)</small></h4><div class="cw"><canvas id="diss-ing"></canvas></div>' +
        '<div class="dnote" id="diss-ing-note"></div></div>' +
      '</div>';
    host.appendChild(sec);
    // ₱/MT ↔ index toggle (re-renders from the cached payload, no refetch)
    var tog = document.getElementById('diss-traj-toggle');
    if (tog) tog.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
      if (!b) return;
      var m = b.getAttribute('data-mode');
      if (m === TRAJ_MODE) return;
      TRAJ_MODE = m;
      Array.prototype.forEach.call(tog.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-mode') === m);
      });
      if (LAST && LAST.available !== false) renderTraj(LAST.trajectory || []);
    });
    return sec;
  }

  var LAST = null;
  var HAD_GOOD = false;    // true once a good dissection has painted FOR THE CURRENT SCOPE
                           // (guards against a transient unavailable refresh wiping good charts;
                           // reset by MEXP_resetDissection on every scope change)
  var GOOD_SCOPE = '';     // label of the scope HAD_GOOD describes
  var TRAJ_MODE = 'abs';   // 'abs' = ₱/MT on one shared axis | 'index' = each series indexed to 100
  var SCOPE_LABEL = 'this scope';

  // Scope changed: nothing from the previous scope may survive as "last good".
  window.MEXP_resetDissection = function () {
    HAD_GOOD = false; GOOD_SCOPE = ''; LAST = null;
    var sec = document.getElementById('mexp-diss');
    if (sec) sec.classList.remove('mexp-stale');
  };

  // Subtle "updating" state for the cost block during phase B (set by controller).
  window.MEXP_setDissectionUpdating = function (on) {
    var sec = document.getElementById('mexp-diss'); if (!sec) return;
    if (on) sec.classList.add('mexp-dim'); else sec.classList.remove('mexp-dim');
  };

  // Shape gate: a 200 whose dissection block has the wrong types (malformed
  // payload) is routed to unavailable with a reason, never rendered as
  // "undefined -> undefined" or caught as a TypeError in a chart loop.
  function dissShapeOk(d) {
    if (!d || typeof d !== 'object') return false;
    if (typeof d.base_month !== 'string' || typeof d.compare_month !== 'string') return false;
    if (d.trajectory != null && !(typeof d.trajectory === 'object' && typeof d.trajectory.length === 'number')) return false;
    if (d.ingredients != null && d.ingredients.items != null && !(typeof d.ingredients.items === 'object' && typeof d.ingredients.items.length === 'number')) return false;
    return true;
  }

  window.MEXP_renderDissection = function (d, label) {
    var sec = ensure(); if (!sec) return;
    SCOPE_LABEL = label || SCOPE_LABEL;
    var subEl = document.getElementById('diss-sub');

    if (d && d.available !== false && !dissShapeOk(d)) {
      d = { available: false, reason: 'the dissection block failed the shape check (base_month / compare_month / trajectory) — treated as unavailable.' };
    }
    if (!d || d.available === false) {
      var reason = (d && d.reason) || 'No finished-feed data for this selection.';
      // Only a TRANSPORT failure (error:true) keeps the last good charts: a
      // determinate available:false is the answer for this scope and replaces them.
      if (HAD_GOOD && d && d.error) {
        // same scope, refresh failed: keep charts, dim, name the scope shown
        sec.classList.add('mexp-stale');
        if (subEl) subEl.textContent = '⚠ source busy — could not refresh; showing ' + (GOOD_SCOPE || SCOPE_LABEL) + ' (' + reason + ')';
        return;
      }
      // nothing to keep for this scope: an empty scope is an answer, not an outage
      HAD_GOOD = false; GOOD_SCOPE = '';
      sec.classList.remove('mexp-stale');
      LAST = null;
      if (subEl) subEl.textContent = ((d && d.error) ? '⚠ Trajectory could not be loaded for ' : 'ⓘ No finished-feed trajectory for ') + SCOPE_LABEL + ' — ' + reason;
      ['diss-traj', 'diss-ing'].forEach(function (id) { kill(document.getElementById(id)); });
      return;
    }
    sec.classList.remove('mexp-stale');
    LAST = d;
    HAD_GOOD = true;
    GOOD_SCOPE = SCOPE_LABEL;
    var cmpLbl = d.compare_month + (d.compare_partial ? ' (' + (d.compare_days || '') + 'd partial — early read, noisy)' : '');
    if (subEl) subEl.textContent =
      'Finished feed (Live 103 / Old 103+104) · anchors ' + d.base_month + ' → ' + cmpLbl + ' (first and last complete months in the period) · ' + SCOPE_LABEL;
    paintCharts(d);
  };

  function paintCharts(d) {
    renderTraj(d.trajectory || []);
    renderDiverging('diss-ing', (d.ingredients && d.ingredients.items) || [], 'name', false);
    var n = document.getElementById('diss-ing-note');
    if (n) n.textContent = (d.ingredients && d.ingredients.note) ? d.ingredients.note + (d.ingredients.net != null ? ' · net over all items ' + ptS(d.ingredients.net) + '/MT' : '') : '';
  }

  // Re-theme: colours are resolved from CSS variables at build time, so rebuild
  // the charts from the cached payload when the shell flips <html data-theme>.
  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    try {
      new MutationObserver(function () {
        if (!LAST || LAST.available === false) return;
        if (!document.getElementById('diss-traj')) return;
        try { paintCharts(LAST); } catch (e) {}
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
  }

  function baseOpts() {
    return { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, plugins: { legend: { display: false } } };
  }

  // Index base: the first complete month with volume (a zero-tons month carries
  // 0 on the wire and would divide by zero; the running month is never the base).
  function indexBase(series) {
    for (var i = 0; i < series.length; i++) {
      var s = series[i];
      if (s.partial) continue;
      if ((+s.tons || 0) > 0 && (+s.gm_per_ton || 0) !== 0 && (+s.rev_per_ton || 0) > 0) return s;
    }
    return null;
  }

  function renderTraj(series) {
    var c = document.getElementById('diss-traj'); if (!c || !window.Chart) return; kill(c);
    var p = P();
    var note = document.getElementById('diss-traj-note');
    var labels = series.map(function (s) { return s.month.slice(2); });
    var partIdx = series.map(function (s, i) { return s.partial ? i : -1; }).filter(function (i) { return i >= 0; });
    var idx = (TRAJ_MODE === 'index');
    var base = idx ? indexBase(series) : null;
    if (idx && !base) { idx = false; }
    // COGS/ton EXISTS on the wire: read it, never derive it (WIRE.TRAJECTORY_POINT).
    function val(s, k) {
      var v = +s[k] || 0;
      if (!idx) return v;
      var b = +base[k] || 0;
      return b ? Math.round(v / b * 1000) / 10 : null;
    }
    var gm = series.map(function (s) { return (+s.tons || 0) > 0 ? val(s, 'gm_per_ton') : null; });
    var rev = series.map(function (s) { return (+s.tons || 0) > 0 ? val(s, 'rev_per_ton') : null; });
    var cogs = series.map(function (s) { return (+s.tons || 0) > 0 ? val(s, 'cogs_per_ton') : null; });
    var unit = idx ? '' : '/MT';
    function fmtY(v) { return idx ? (Math.round(v * 10) / 10) : pt(v) + unit; }
    c._ch = new Chart(c.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels, datasets: [
          // All three series are ₱/MT on ONE shared axis (or all indexed to 100),
          // so the gap between Revenue and COGS is the real GM/MT and not an
          // artefact of two auto-scaled axes.
          { label: idx ? 'GM/MT (index)' : 'GM/MT', data: gm, borderColor: p.pos, backgroundColor: p.posSoft, borderWidth: 3, fill: !idx, tension: .3, pointRadius: 3, pointBackgroundColor: p.pos, spanGaps: false, segment: { borderDash: function (ctx) { return partIdx.indexOf(ctx.p1DataIndex) >= 0 ? [5, 4] : undefined; } } },
          { label: idx ? 'Revenue/MT (index)' : 'Revenue/MT', data: rev, borderColor: p.accent, borderWidth: 2, borderDash: [4, 3], fill: false, tension: .3, pointRadius: 0, spanGaps: false },
          { label: idx ? 'COGS/MT (index)' : 'COGS/MT', data: cogs, borderColor: p.neg, borderWidth: 1.5, borderDash: [2, 3], fill: false, tension: .3, pointRadius: 0, spanGaps: false }
        ]
      },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: true, labels: { color: p.text3, font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: function (i) { return i.dataset.label + ': ' + (i.parsed.y == null ? '—' : fmtY(i.parsed.y)); } } } },
        scales: {
          y: { position: 'left', beginAtZero: !idx, grid: { color: function (ctx) { return (idx && ctx.tick && ctx.tick.value === 100) ? p.zero : p.grid; } }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return idx ? v : '₱' + (v / 1000).toFixed(0) + 'k'; } } },
          x: { grid: { display: false }, ticks: { color: p.text3, font: { size: 9 } } }
        }
      })
    });
    if (note) {
      note.textContent = idx
        ? ('Index: each series over its own ' + base.month + ' value (first complete month with volume) = 100. A zero-volume month is left blank; the running month is dashed.')
        : 'One shared ₱/MT axis — the gap between Revenue/MT and COGS/MT is GM/MT. Zero-volume months are left blank (the wire carries 0, not a margin); the running month is dashed.';
    }
  }

  // diverging horizontal bars; costUpRed=true → +contribution red (cost rose); for mix +green
  function renderDiverging(id, items, key, mixMode) {
    var c = document.getElementById(id); if (!c || !window.Chart) return; kill(c);
    var p = P();
    if (!items.length) return;
    var labels = items.map(function (i) { return (i[key] || '').slice(0, 18) + (i.carried ? ' *' : ''); });
    var vals = items.map(function (i) { return i.contribution; });
    // mix: +contribution = richer mix (good) → pos ; ingredient: +contribution = costlier → neg
    var colors = vals.map(function (v) { return mixMode ? (v >= 0 ? p.pos : p.neg) : (v > 0 ? p.neg : p.pos); });
    c._ch = new Chart(c.getContext('2d'), {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 3 }] },
      options: Object.assign(baseOpts(), {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (i) { return ptS(i.parsed.x) + '/MT'; } } } },
        scales: { x: { grid: { color: p.grid }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return ptS(v); } } }, y: { grid: { display: false }, ticks: { color: p.text3, font: { size: 9 } } } }
      })
    });
  }
})();
