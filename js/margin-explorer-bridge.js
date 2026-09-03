/*
 * margin-explorer-bridge.js — Margin Explorer chart components for VieForce HQ
 *
 * Self-contained. Assumes Chart.js is global (window.Chart) and is already loaded.
 *
 * Exposes ONE global:
 *   window.MEXP_renderCanonicalBridge(canvasEl, canonical_bridge)
 *     — the exact Bennet GM/ton waterfall from the phase-B `dissection.canonical_bridge`
 *       block (Prior → Price → Cost → Customer/BU Mix → Product Mix → Current).
 *
 * The chart is rebuilt (from the last payload) whenever the shell flips
 * data-theme, because every colour is resolved from CSS variables at build time.
 */
(function () {
  'use strict';

  // ---- palette (resolved live from the CSS variables so light-theme works) ----
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
      // grid + anchor grey come from the theme tokens, never a hardcoded white-ish
      // rgba (which vanished on the light theme).
      grid:  cssVar('--glass-border', 'rgba(255,255,255,0.07)'),
      grey:  cssVar('--text4', 'rgba(240,244,250,0.42)'),
      // composition (mix) bars — muted desaturated blue so they read as
      // "not a price action" vs. the saturated green/red real levers.
      muted: 'rgba(0,174,239,0.42)'
    };
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

  // Last successful render — replayed on theme change (see observer below).
  var LAST_CANON = null;   // { canvas, cb }

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
      LAST_CANON = null;
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
    // running-cumulative envelope — the y axis brackets THIS, not zero, so the
    // driver bars (tens of ₱/t on a ~5,000 ₱/t anchor) stay legible.
    var lo = prior, hi = prior;
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
      if (running < lo) lo = running;
      if (running > hi) hi = running;
    });
    var span = hi - lo;
    if (span < Math.abs(hi) * 0.04) span = Math.abs(hi) * 0.04;   // flat bridge: still show ~4% of level
    if (!span) span = 1;
    var sugMin = lo - span * 0.15;
    var sugMax = hi + span * 0.15;
    if (lo >= 0 && sugMin < 0) sugMin = 0;

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
            suggestedMin: sugMin,
            suggestedMax: sugMax,
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
    LAST_CANON = { canvas: canvasEl, cb: cb };
    return chart;
  };

  // ---- re-theme: the shell flips <html data-theme>; colours are baked in at
  // build time, so rebuild the last bridge from its cached payload. ----
  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    try {
      new MutationObserver(function () {
        if (!LAST_CANON || !LAST_CANON.canvas) return;
        if (!document.body || !document.body.contains(LAST_CANON.canvas)) return;
        try { window.MEXP_renderCanonicalBridge(LAST_CANON.canvas, LAST_CANON.cb); } catch (e) {}
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
  }

})();
