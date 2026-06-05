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
      grey:  'rgba(240,244,250,0.28)'
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
    ctx.fillStyle = p.text3;
    ctx.font = '500 12px system-ui, -apple-system, Segoe UI, sans-serif';
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
    var lh = 18, startY = h / 2 - ((lines.length - 1) * lh) / 2;
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
    var steps = [
      { label: 'Prior GP', value: prior, kind: 'anchor', color: p.grey },
      { label: 'Price', delta: +bridge.price || 0, kind: 'delta' },
      { label: 'Volume', delta: +bridge.volume || 0, kind: 'delta' },
      { label: 'Mix', delta: +bridge.mix || 0, kind: 'delta' }
    ];

    // COGS split — render up to three cost segments. For costs, a NEGATIVE delta
    // means cost rose (hurts GP) -> red; POSITIVE means cost fell (helps GP) -> green.
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

    steps.push({ label: 'Current GP', value: current, kind: 'anchor', color: p.blue });

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
        dataLabels.push(money(s.value));
        running = s.value; // reset running to the anchor's absolute level
      } else {
        var d = s.delta || 0;
        var start = running;
        var end = running + d;
        ranges.push([Math.min(start, end), Math.max(start, end)]);
        // Color: revenue-style drivers green when +, red when −.
        // Cost segments: delta sign already encodes GP impact (− = cost rose).
        barColors.push(d >= 0 ? p.green : p.red);
        stepDeltas.push(d);
        dataLabels.push(signedMoney(d));
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
                  return money(r[1]);
                }
                return signedMoney(d);
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
              callback: function (v) { return money(v); }
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

    // series items may be {label/month/period, value} — normalise.
    var labels = series.map(function (s) {
      return s.label != null ? s.label : (s.month != null ? s.month : (s.period != null ? s.period : ''));
    });
    var values = series.map(function (s) {
      return s.value != null ? +s.value : (s.y != null ? +s.y : 0);
    });

    destroyExisting(canvasEl);
    var ctx = canvasEl.getContext('2d');

    var fmt = (unit === 'gp_pct')
      ? function (v) { return (+v).toFixed(1) + '%'; }
      : function (v) { return money(v); };

    var chart = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          borderColor: p.blue,
          backgroundColor: 'rgba(0,174,239,0.10)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: p.blue,
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
