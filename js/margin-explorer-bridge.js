/*
 * margin-explorer-bridge.js — Margin Explorer chart components for VieForce HQ
 *
 * Self-contained. Assumes Chart.js is global (window.Chart) and is already loaded.
 * Optionally uses global helpers fc(n) / fcn(n) if present (graceful fallback otherwise).
 *
 * Exposes two globals:
 *   window.MEXP_renderBridge(canvasEl, bridge)  — GM waterfall (floating bars)
 *   window.MEXP_renderTrend(canvasEl, trend)    — small line chart (or Phase 2 placeholder)
 *
 * DEMO:
 *   const r = await apiFetch('margin-explorer', { period:'MTD', group_by:'bu', include:'bridge,trend' });
 *   MEXP_renderBridge(document.getElementById('mexp-bridge'), r.bridge);
 *   MEXP_renderTrend(document.getElementById('mexp-trend'), r.trend);
 */
(function () {
  'use strict';

  // ---- palette (mirror of dark-theme CSS vars; resolved live so light-theme works too) ----
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  function pal() {
    return {
      green: cssVar('--green', '#97D700'),
      red:   cssVar('--red', '#FF5C5C'),
      blue:  cssVar('--blue', '#00AEEF'),
      gold:  cssVar('--gold', '#FFC72C'),
      text:  cssVar('--text', '#F0F4FA'),
      text3: cssVar('--text3', 'rgba(240,244,250,0.4)'),
      grid:  'rgba(255,255,255,0.05)',
      grey:  'rgba(240,244,250,0.28)',
      // composition (mix) bars — muted desaturated blue so they read as
      // "not a price action" vs. the saturated green/red real levers.
      muted: 'rgba(0,174,239,0.42)'
    };
  }

  // ---- money formatting (prefer app globals) ----
  function money(n) {
    if (typeof window.fc === 'function') return window.fc(n);
    if (n == null || isNaN(n)) return '₱0';
    n = +n;
    if (Math.abs(n) >= 1e6) return '₱' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '₱' + (n / 1e3).toFixed(0) + 'K';
    return '₱' + n.toFixed(0);
  }
  function signedMoney(n) {
    var s = money(Math.abs(n));
    if (n > 0) return '+' + s;
    if (n < 0) return '−' + s; // minus sign
    return s;
  }

  // ---- destroy any existing chart bound to this canvas ----
  function destroyExisting(canvasEl) {
    if (!canvasEl) return;
    if (canvasEl._mexpChart) {
      try { canvasEl._mexpChart.destroy(); } catch (e) {}
      canvasEl._mexpChart = null;
    }
    // Chart.js v3+ helper, if available
    if (window.Chart && typeof window.Chart.getChart === 'function') {
      var existing = window.Chart.getChart(canvasEl);
      if (existing) { try { existing.destroy(); } catch (e) {} }
    }
  }

  // ---- render a centered note (used for unavailable bridge / errors) ----
  function renderNote(canvasEl, msg) {
    if (!canvasEl) return;
    destroyExisting(canvasEl);
    var ctx = canvasEl.getContext && canvasEl.getContext('2d');
    if (!ctx) return;
    var p = pal();
    var w = canvasEl.width = canvasEl.clientWidth || canvasEl.width || 300;
    var h = canvasEl.height = canvasEl.clientHeight || canvasEl.height || 160;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.fillStyle = p.text;   // full-contrast (was text3 @40% — read as blank)
    ctx.font = '600 13px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // simple word-wrap
    var words = String(msg || '').split(/\s+/);
    var line = '', lines = [], maxW = w - 40;
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; }
      else { line = test; }
    }
    if (line) lines.push(line);
    var lh = 20, startY = h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach(function (ln, idx) { ctx.fillText(ln, w / 2, startY + idx * lh); });
    ctx.restore();
  }

  // ===========================================================================
  // BRIDGE — floating-bar waterfall
  // ===========================================================================
  window.MEXP_renderBridge = function (canvasEl, bridge) {
    if (!canvasEl) return null;
    if (!window.Chart) { renderNote(canvasEl, 'Chart library not loaded.'); return null; }

    if (!bridge || bridge.available === false) {
      renderNote(canvasEl, (bridge && bridge.reason) || 'Bridge not available for this selection.');
      return null;
    }

    var p = pal();
    var prior = +bridge.prior_gp || 0;
    var current = +bridge.current_gp || 0;

    // Build ordered steps. Each: { label, delta, kind }
    // kind 'anchor' = absolute bar from 0; 'delta' = floating bar.
    var cost = bridge.cost || {};
    var perTon = bridge.unit === 'php_per_ton';
    function fmtV(n){ if(perTon) return '₱'+Math.round(+n||0).toLocaleString()+'/t'; return money(n); }
    function fmtD(n){ if(perTon){ var s='₱'+Math.round(Math.abs(+n||0)).toLocaleString()+'/t'; return n>0?'+'+s:(n<0?'−'+s:s);} return signedMoney(n); }
    // ---- TRUE-PRICE decomposition (preferred when present) -------------------
    // When the SKU-level bridge carries the customer×SKU true-price split, render
    //   Prior → True Price → Customer Mix → Product Mix → Cost → Current
    // True Price + Cost are REAL levers (green/red). Customer/Product Mix are
    // composition — a muted blue so they read as "not a price action".
    var hasTrue = (bridge.true_price != null) && !!bridge.true_basis;
    var steps;
    if (hasTrue) {
      steps = [
        { label: perTon ? 'Prior GM/t' : 'Prior GP', value: prior, kind: 'anchor', color: p.grey },
        { label: 'True Price',   delta: +bridge.true_price || 0,   kind: 'delta' },
        { label: 'Customer Mix', delta: +bridge.customer_mix || 0, kind: 'delta', muted: true },
        { label: 'Product Mix',  delta: +bridge.product_mix || 0,  kind: 'delta', muted: true },
        { label: 'Cost',         delta: +bridge.true_cost || 0,    kind: 'delta' },
        { label: perTon ? 'Current GM/t' : 'Current GP', value: current, kind: 'anchor', color: p.blue }
      ];
    } else {
    steps = [
      { label: perTon ? 'Prior GM/t' : 'Prior GP', value: prior, kind: 'anchor', color: p.grey },
      { label: 'Price', delta: +bridge.price || 0, kind: 'delta' },
      { label: 'Mix', delta: +bridge.mix || 0, kind: 'delta' }
    ];
    // Per-unit (GM/ton) bridge has NO volume effect; only the ₱-GP bridge shows Volume.
    if (!perTon) steps.splice(2, 0, { label: 'Volume', delta: +bridge.volume || 0, kind: 'delta' });

    // COGS split — render up to three cost segments. For costs, a NEGATIVE delta
    // means cost rose (hurts GP) -> red; POSITIVE means cost fell (helps GP) -> green.
    // SSG (category) level bridge carries a SINGLE Cost bucket — the RM/Pkg/Feedtag
    // split is not computable across the Jan-2026 consolidation, so render one
    // honest "Cost" bar instead of faking the split.
    if (bridge.level === 'ssg') {
      steps.push({ label: 'Cost', delta: +cost.total || 0, kind: 'delta' });
    } else {
      var rm = +cost.rm || 0;
      var pkg = +cost.packaging || 0;
      var ft = +cost.feedtag || 0;
      // If split not populated but a total exists, fall back to total as RM bucket.
      if (rm === 0 && pkg === 0 && ft === 0 && cost.total != null) rm = +cost.total || 0;

      var costSegs = [
        { label: 'RM cost', delta: rm },
        { label: 'Packaging', delta: pkg },
        { label: 'Feedtag', delta: ft }
      ];
      costSegs.forEach(function (c) {
        // always push so the bar is reserved; non-zero requirement honoured by rendering
        if (c.delta !== 0 || true) steps.push({ label: c.label, delta: c.delta, kind: 'delta' });
      });
    }

    steps.push({ label: perTon ? 'Current GM/t' : 'Current GP', value: current, kind: 'anchor', color: p.blue });
    }

    // Compute floating [base, top] ranges along a running total.
    var running = prior;
    var labels = [];
    var ranges = [];         // [bottom, top] per bar
    var barColors = [];
    var stepDeltas = [];     // signed delta per bar (for tooltip/label); anchors carry absolute
    var dataLabels = [];     // text drawn above/inside each bar

    steps.forEach(function (s, idx) {
      labels.push(s.label);
      if (s.kind === 'anchor') {
        ranges.push([0, s.value]);
        barColors.push(s.color);
        stepDeltas.push(null);
        dataLabels.push(fmtV(s.value));
        running = s.value; // reset running to the anchor's absolute level
      } else {
        var d = s.delta || 0;
        var start = running;
        var end = running + d;
        ranges.push([Math.min(start, end), Math.max(start, end)]);
        // Color: revenue-style drivers green when +, red when −.
        // Cost segments: delta sign already encodes GP impact (− = cost rose).
        // Composition (mix) bars: muted blue regardless of sign — not a price action.
        barColors.push(s.muted ? p.muted : (d >= 0 ? p.green : p.red));
        stepDeltas.push(d);
        dataLabels.push(fmtD(d));
        running = end;
      }
    });

    destroyExisting(canvasEl);
    var ctx = canvasEl.getContext('2d');

    // plugin: draw signed value labels above each bar
    var labelPlugin = {
      id: 'mexpBarLabels',
      afterDatasetsDraw: function (chart) {
        var c = chart.ctx;
        var meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data) return;
        c.save();
        c.font = '700 10px system-ui, -apple-system, Segoe UI, sans-serif';
        c.textAlign = 'center';
        c.fillStyle = p.text;
        meta.data.forEach(function (bar, i) {
          if (!bar) return;
          var txt = dataLabels[i];
          if (!txt) return;
          var top = bar.y; // top pixel of the floating bar
          // place label just above the bar
          c.textBaseline = 'bottom';
          c.fillText(txt, bar.x, top - 4);
        });
        c.restore();
      }
    };

    var chart = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: ranges,
          backgroundColor: barColors,
          hoverBackgroundColor: barColors,
          borderRadius: 3,
          borderSkipped: false,
          barPercentage: 0.72,
          categoryPercentage: 0.85
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return items[0] ? items[0].label : ''; },
              label: function (item) {
                var i = item.dataIndex;
                var d = stepDeltas[i];
                if (d == null) {
                  // anchor bar — show absolute
                  var r = ranges[i];
                  return fmtV(r[1]);
                }
                return fmtD(d);
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: p.grid },
            ticks: {
              color: p.text3,
              font: { size: 9 },
              callback: function (v) { return fmtV(v); }
            }
          },
          x: {
            grid: { display: false },
            ticks: { color: p.text3, font: { size: 9 }, maxRotation: 0, autoSkip: false }
          }
        }
      },
      plugins: [labelPlugin]
    });

    canvasEl._mexpChart = chart;
    return chart;
  };

  // ===========================================================================
  // CANONICAL BRIDGE — the ONE authoritative GM/ton waterfall (phase B)
  //   Prior GM/ton → Price → Cost → Customer/BU Mix → Product Mix → Current
  // Price & Cost are the REAL levers (green/red). Customer/BU Mix & Product Mix
  // are composition → muted blue. price+cost+customer_mix+product_mix === delta.
  // ===========================================================================
  window.MEXP_renderCanonicalBridge = function (canvasEl, cb) {
    if (!canvasEl) return null;
    if (!window.Chart) { renderNote(canvasEl, 'Chart library not loaded.'); return null; }
    if (!cb || cb.available === false) {
      renderNote(canvasEl, (cb && cb.note) || (cb && cb.reason) || 'Exact bridge not available for this anchor.');
      return null;
    }

    var p = pal();
    var prior = +cb.prior_gm_ton || 0;
    var current = +cb.current_gm_ton || 0;
    function fmtV(n) { return '₱' + Math.round(+n || 0).toLocaleString() + '/t'; }
    function fmtD(n) { var s = '₱' + Math.round(Math.abs(+n || 0)).toLocaleString() + '/t'; return n > 0 ? '+' + s : (n < 0 ? '−' + s : s); }

    var steps = [
      { label: 'Prior GM/t', value: prior, kind: 'anchor', color: p.grey },
      { label: 'Price', delta: +cb.price || 0, kind: 'delta' },
      { label: 'Cost', delta: +cb.cost || 0, kind: 'delta' },
      { label: 'Customer/BU Mix', delta: +cb.customer_mix || 0, kind: 'delta', muted: true },
      { label: 'Product Mix', delta: +cb.product_mix || 0, kind: 'delta', muted: true },
      { label: 'Current GM/t', value: current, kind: 'anchor', color: p.blue }
    ];

    var running = prior;
    var labels = [], ranges = [], barColors = [], stepDeltas = [], dataLabels = [];
    steps.forEach(function (s) {
      labels.push(s.label);
      if (s.kind === 'anchor') {
        ranges.push([0, s.value]);
        barColors.push(s.color);
        stepDeltas.push(null);
        dataLabels.push(fmtV(s.value));
        running = s.value;
      } else {
        var d = s.delta || 0;
        var start = running, end = running + d;
        ranges.push([Math.min(start, end), Math.max(start, end)]);
        barColors.push(s.muted ? p.muted : (d >= 0 ? p.green : p.red));
        stepDeltas.push(d);
        dataLabels.push(fmtD(d));
        running = end;
      }
    });

    destroyExisting(canvasEl);
    var ctx = canvasEl.getContext('2d');
    var labelPlugin = {
      id: 'mexpCanonLabels',
      afterDatasetsDraw: function (chart) {
        var c = chart.ctx;
        var meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data) return;
        c.save();
        c.font = '700 10px system-ui, -apple-system, Segoe UI, sans-serif';
        c.textAlign = 'center';
        c.fillStyle = p.text;
        c.textBaseline = 'bottom';
        meta.data.forEach(function (bar, i) {
          if (!bar) return;
          var txt = dataLabels[i];
          if (txt) c.fillText(txt, bar.x, bar.y - 4);
        });
        c.restore();
      }
    };

    var chart = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: ranges,
          backgroundColor: barColors,
          hoverBackgroundColor: barColors,
          borderRadius: 3,
          borderSkipped: false,
          barPercentage: 0.72,
          categoryPercentage: 0.85
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return items[0] ? items[0].label : ''; },
              label: function (item) {
                var i = item.dataIndex;
                var d = stepDeltas[i];
                if (d == null) { return fmtV(ranges[i][1]); }
                return fmtD(d);
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: p.grid },
            ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return fmtV(v); } }
          },
          x: {
            grid: { display: false },
            ticks: { color: p.text3, font: { size: 9 }, maxRotation: 0, autoSkip: false }
          }
        }
      },
      plugins: [labelPlugin]
    });

    canvasEl._mexpChart = chart;
    return chart;
  };

  // ===========================================================================
  // TREND — small line chart (or Phase 2 placeholder)
  // ===========================================================================
  window.MEXP_renderTrend = function (canvasEl, trend) {
    if (!canvasEl) return null;
    if (!window.Chart) { renderNote(canvasEl, 'Chart library not loaded.'); return null; }

    var series = (trend && trend.series) || [];
    if (!series.length) {
      renderNote(canvasEl, 'Trend coming in Phase 2.');
      return null;
    }

    var p = pal();
    var unit = (trend && trend.unit) || 'gm_per_kg';

    // series items may be {label/month/period, gm_per_ton|value|y} — normalise.
    var labels = series.map(function (s) {
      return s.label != null ? s.label : (s.month != null ? s.month : (s.period != null ? s.period : ''));
    });
    var values = series.map(function (s) {
      if (s.gm_per_ton != null) return +s.gm_per_ton;
      return s.value != null ? +s.value : (s.y != null ? +s.y : 0);
    });

    destroyExisting(canvasEl);
    var ctx = canvasEl.getContext('2d');

    var fmt;
    if (unit === 'gp_pct') {
      fmt = function (v) { return (+v).toFixed(1) + '%'; };
    } else if (unit === 'gm_per_ton') {
      // GM per ton — full peso value (e.g. ₱6,430/t), not abbreviated.
      fmt = function (v) { return '₱' + Math.round(+v || 0).toLocaleString() + '/t'; };
    } else {
      fmt = function (v) { return money(v); };
    }

    var chart = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          borderColor: p.green,
          backgroundColor: 'rgba(151,215,0,0.12)',
          borderWidth: 3,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: p.green,
          pointBorderColor: p.green,
          tension: 0.32,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (item) { return fmt(item.parsed.y); } } }
        },
        scales: {
          y: {
            grid: { color: p.grid },
            ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return fmt(v); } }
          },
          x: {
            grid: { display: false },
            ticks: { color: p.text3, font: { size: 9 }, maxRotation: 0 }
          }
        }
      }
    });

    canvasEl._mexpChart = chart;
    return chart;
  };

})();
