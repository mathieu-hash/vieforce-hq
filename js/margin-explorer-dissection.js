/*
 * margin-explorer-dissection.js — Finished-Feed Dissection panels for the Margin Explorer.
 *
 * Renders the Margin-Dissection-Analyser panels from the endpoint's `dissection` block:
 *   1. GM/ton + revenue/ton trajectory (cross-DB Sep-2025 -> now; partial month dashed),
 *      both series on ONE shared ₱/ton axis
 *   2. Ingredient cost contribution (recipe-weighted, top movers)
 * + a server-proxied "AI read" button (POST /api/margin-ai).
 *
 * The 12-month category margin table that used to sit at the top of this block
 * is now the Drill Matrix box of the page (js/mexp2-panel-trendmatrix.js).
 *
 * Self-contained: injects its own <section> into the page's .mexp-wrap on first render.
 * Exposes window.MEXP_renderDissection(dissection, scopeLabel) and
 *         window.MEXP_resetDissection() — called by the controller on scope change.
 *
 * Staleness: a good render is kept only for the scope it was painted for. Same
 * scope, refresh failed (transport) → dim + "source busy — showing <scope>". A
 * determinate available:false is the answer for the scope and replaces the
 * charts: "No finished-feed dissection for <scope> — <reason>". Never hides.
 * Charts are rebuilt from the cached payload when the shell flips data-theme.
 */
(function () {
  'use strict';
  function cssVar(n, f) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v || '').trim() || f; } catch (e) { return f; } }
  function P() {
    return {
      navy: cssVar('--blue', '#00AEEF'), green: cssVar('--green', '#7BB52E'),
      gold: cssVar('--gold', '#FFC72C'), teal: '#00A8CC', red: cssVar('--red', '#E53935'),
      text: cssVar('--text', '#F0F4FA'), text3: cssVar('--text3', 'rgba(240,244,250,0.4)'),
      // grid / grey from the theme tokens — hardcoded white-ish rgba vanished on light
      grid: cssVar('--glass-border', 'rgba(255,255,255,0.07)'), grey: cssVar('--text4', 'rgba(240,244,250,0.42)')
    };
  }
  function pt(n) { return '₱' + Math.round(+n || 0).toLocaleString(); }
  function ptS(n) { n = +n || 0; var s = '₱' + Math.round(Math.abs(n)).toLocaleString(); return n > 0 ? '+' + s : (n < 0 ? '−' + s : s); }
  function kill(c) { if (c && c._ch) { try { c._ch.destroy(); } catch (e) {} c._ch = null; } if (window.Chart && Chart.getChart) { var e = Chart.getChart(c); if (e) { try { e.destroy(); } catch (x) {} } } }

  // ---- one-time DOM ----
  function ensure() {
    var page = document.getElementById('pg-margin-explorer'); if (!page) return null;
    // mount inside .mexp-wrap so the block inherits the page padding
    var host = page.querySelector('.mexp-wrap') || page;
    var sec = document.getElementById('mexp-diss'); if (sec) return sec;
    sec = document.createElement('div'); sec.id = 'mexp-diss';
    sec.innerHTML =
      '<style>' +
      '#mexp-diss{margin-top:18px}' +
      '#mexp-diss .dh{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:6px 0 10px}' +
      '#mexp-diss .dt{font-size:15px;font-weight:900;letter-spacing:-.2px;color:var(--text)}' +
      '#mexp-diss .dsub{font-size:10px;color:var(--text3);font-weight:600}' +
      '#mexp-diss .dgrid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}' +
      '#mexp-diss .dp{border:1px solid var(--glass-border);border-radius:var(--r-lg);background:var(--surface);padding:12px 14px}' +
      '#mexp-diss .dp h4{margin:0 0 8px;font-size:11px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}' +
      '#mexp-diss .cw{position:relative;width:100%;height:230px}' +
      '#mexp-diss .cw canvas{width:100%!important}' +
      '#mexp-diss .aibtn{border:1px solid var(--gold);background:rgba(255,199,44,.12);color:var(--gold);font-size:11px;font-weight:800;padding:6px 12px;border-radius:8px;cursor:pointer}' +
      '#mexp-diss .aibtn:disabled{opacity:.5;cursor:default}' +
      '#mexp-diss .aiout{font-size:12px;line-height:1.55;color:var(--text2);margin-top:10px;white-space:pre-wrap}' +
      '</style>' +
      '<div class="dh"><div><div class="dt">Finished-Feed Dissection <span style="font-size:10px;color:var(--gold)">GM/ton</span></div>' +
      '<div class="dsub" id="diss-sub">—</div></div><button class="aibtn" id="diss-ai">✦ AI read</button></div>' +
      '<div class="dgrid2">' +
      '<div class="dp"><h4>GM/ton &amp; Revenue/ton trajectory</h4><div class="cw"><canvas id="diss-traj"></canvas></div></div>' +
      '<div class="dp"><h4>Ingredient cost contribution (recipe-weighted) <span style="font-weight:400;font-size:9px;opacity:.75">* = no purchase in one month — price carried, recipe effect only</span></h4><div class="cw"><canvas id="diss-ing"></canvas></div></div>' +
      '</div>' +
      '<div class="aiout" id="diss-aiout"></div>';
    host.appendChild(sec);
    document.getElementById('diss-ai').addEventListener('click', runAi);
    return sec;
  }

  var LAST = null;
  var HAD_GOOD = false;    // true once a good dissection has painted FOR THE CURRENT SCOPE
                           // (guards against a transient unavailable refresh wiping good charts;
                           // reset by MEXP_resetDissection on every scope change)
  var GOOD_SCOPE = '';     // label of the scope HAD_GOOD describes
  var SCOPE_LABEL = 'this scope';

  // Scope changed: nothing from the previous scope may survive as "last good".
  window.MEXP_resetDissection = function () {
    HAD_GOOD = false; GOOD_SCOPE = ''; LAST = null;
    var sec = document.getElementById('mexp-diss');
    if (sec) sec.classList.remove('mexp-stale');
  };

  // Subtle "updating" state for the dissection block during phase B (set by controller).
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
      if (subEl) subEl.textContent = ((d && d.error) ? '⚠ Dissection could not be loaded for ' : 'ⓘ No finished-feed dissection for ') + SCOPE_LABEL + ' — ' + reason;
      ['diss-traj', 'diss-ing'].forEach(function (id) { kill(document.getElementById(id)); });
      return;
    }
    sec.classList.remove('mexp-stale');
    LAST = d;
    HAD_GOOD = true;
    GOOD_SCOPE = SCOPE_LABEL;
    var cmpLbl = d.compare_month + (d.compare_partial ? ' (' + (d.compare_days || '') + 'd partial — early read, noisy)' : '');
    if (subEl) subEl.textContent =
      'Finished feed (Live 103 / Old 103+104) · ' + d.base_month + ' → ' + cmpLbl + ' · ' + SCOPE_LABEL;
    paintCharts(d);
  };

  function paintCharts(d) {
    renderTraj(d.trajectory || []);
    renderDiverging('diss-ing', (d.ingredients && d.ingredients.items) || [], 'name', false);
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

  function renderTraj(series) {
    var c = document.getElementById('diss-traj'); if (!c || !window.Chart) return; kill(c);
    var p = P();
    var labels = series.map(function (s) { return s.month.slice(2); });
    var gm = series.map(function (s) { return s.gm_per_ton; });
    var rev = series.map(function (s) { return s.rev_per_ton; });
    var partIdx = series.map(function (s, i) { return s.partial ? i : -1; }).filter(function (i) { return i >= 0; });
    c._ch = new Chart(c.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels, datasets: [
          // Both series are ₱/ton — ONE shared axis, so the gap between them is
          // the real COGS/ton and not an artefact of two auto-scaled axes.
          { label: 'GM/ton', data: gm, yAxisID: 'y', borderColor: p.green, backgroundColor: 'rgba(123,181,46,.12)', borderWidth: 3, fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: p.green, segment: { borderDash: function (ctx) { return partIdx.indexOf(ctx.p1DataIndex) >= 0 ? [5, 4] : undefined; } } },
          { label: 'Rev/ton', data: rev, yAxisID: 'y1', borderColor: p.navy, borderWidth: 2, borderDash: [4, 3], fill: false, tension: .3, pointRadius: 0 }
        ]
      },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: true, labels: { color: p.text3, font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: function (i) { return i.dataset.label + ': ' + pt(i.parsed.y) + '/t'; } } } },
        scales: {
          y: { position: 'left', grid: { color: p.grid }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return '₱' + (v / 1000).toFixed(0) + 'k'; } } },
          y1: { position: 'right', grid: { display: false }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return '₱' + (v / 1000).toFixed(0) + 'k'; } } },
          x: { grid: { display: false }, ticks: { color: p.text3, font: { size: 9 } } }
        }
      })
    });
  }

  // diverging horizontal bars; costUpRed=true → +contribution red (cost rose); for mix +green
  function renderDiverging(id, items, key, mixMode) {
    var c = document.getElementById(id); if (!c || !window.Chart) return; kill(c);
    var p = P();
    if (!items.length) return;
    var labels = items.map(function (i) { return (i[key] || '').slice(0, 18) + (i.carried ? ' *' : ''); });
    var vals = items.map(function (i) { return i.contribution; });
    // mix: +contribution = richer mix (good) → green ; ingredient: +contribution = costlier → red
    var colors = vals.map(function (v) { return mixMode ? (v >= 0 ? p.green : p.red) : (v > 0 ? p.red : p.green); });
    c._ch = new Chart(c.getContext('2d'), {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 3 }] },
      options: Object.assign(baseOpts(), {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (i) { return ptS(i.parsed.x) + '/t'; } } } },
        scales: { x: { grid: { color: p.grid }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return ptS(v); } } }, y: { grid: { display: false }, ticks: { color: p.text3, font: { size: 9 } } } }
      })
    });
  }

  // ---- AI read (server-proxied POST /api/margin-ai) ----
  // Goes through the shell's API client (window.apiPost: session header, 401 →
  // logout) instead of a bare fetch. apiFetch is GET-only, hence apiPost.
  // The digest is what is on screen: the controller's MEXP_aiDigest (hero, both
  // bridges with their trust flags, the category table, the ingredient movers)
  // when it is available, else this block's own dissection payload.
  function runAi() {
    if (!LAST || LAST.available === false) return;
    var btn = document.getElementById('diss-ai'), out = document.getElementById('diss-aiout');
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '✦ reading…'; out.textContent = '';
    function done() { btn.disabled = false; btn.textContent = old; }
    if (typeof window.apiPost !== 'function') { out.textContent = 'AI read unavailable (API client not loaded).'; done(); return; }
    var digest = null;
    if (typeof window.MEXP_aiDigest === 'function') { try { digest = window.MEXP_aiDigest(); } catch (e) { digest = null; } }
    if (!digest) {
      digest = {
        scope: LAST.scope, base_month: LAST.base_month, compare_month: LAST.compare_month,
        trajectory: LAST.trajectory, bridge: LAST.bridge, mix_bridge: LAST.mix_bridge, ingredients: LAST.ingredients,
        price_drill: LAST.price_drill
      };
    }
    var p;
    try { p = Promise.resolve(window.apiPost('margin-ai', { digest: digest })); }
    catch (e) { p = Promise.reject(e); }
    p.then(function (j) {
      // null = 401 handled by the client (logout already triggered)
      out.textContent = j ? (j.text || 'No response.') : 'AI read unavailable (session expired).';
      done();
    }, function (e) {
      out.textContent = 'AI read failed: ' + ((e && e.message) || 'request failed');
      done();
    });
  }
})();
