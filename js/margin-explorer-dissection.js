/*
 * margin-explorer-dissection.js — Finished-Feed Dissection panels for the Margin Explorer.
 *
 * Renders the 4 Margin-Dissection-Analyser panels from the endpoint's `dissection` block:
 *   1. GM/ton + revenue/ton trajectory (cross-DB Sep-2025 -> now; partial month dashed)
 *   2. SSG GM/ton bridge (Price / Mix / Cost / Interaction waterfall)
 *   3. Product-mix bridge (top SSG contributions to the Mix bar)
 *   4. Ingredient cost contribution (recipe-weighted, top movers)
 *   5. Price bar decomposition (true price vs customer/SKU mix, from `price_drill`)
 * + a server-proxied "AI read" button (POST /api/margin-ai).
 *
 * Self-contained: injects its own <section> into the page's .mexp-wrap on first render.
 * Exposes window.MEXP_renderDissection(dissection, scopeLabel) and
 *         window.MEXP_resetDissection() — called by the controller on scope change.
 *
 * Staleness: a good render is kept only for the scope it was painted for. Same
 * scope, refresh failed → dim + "source busy — showing <scope>". New scope with
 * nothing → "No finished-feed dissection for <scope> — <reason>". Never hides.
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
  function esc(s) { return window.esc ? window.esc(s) : String(s == null ? '' : s); }
  function pt(n) { return '₱' + Math.round(+n || 0).toLocaleString(); }
  // "2026-05" -> "May'26"
  function monLbl(ym) {
    if (!ym || ym.length < 7) return ym || '';
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var y = ym.slice(2, 4), m = parseInt(ym.slice(5, 7), 10);
    return (MON[m - 1] || '') + "'" + y;
  }
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
      '#mexp-diss .dgrid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start}' +
      '#mexp-diss .dgrid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;margin-top:16px}' +
      '#mexp-diss .dp{border:1px solid var(--glass-border);border-radius:var(--r-lg);background:var(--surface);padding:12px 14px}' +
      '#mexp-diss .dp h4{margin:0 0 8px;font-size:11px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}' +
      '#mexp-diss .cw{position:relative;width:100%;height:230px}' +
      '#mexp-diss .cw canvas{width:100%!important}' +
      '#mexp-diss .aibtn{border:1px solid var(--gold);background:rgba(255,199,44,.12);color:var(--gold);font-size:11px;font-weight:800;padding:6px 12px;border-radius:8px;cursor:pointer}' +
      '#mexp-diss .aibtn:disabled{opacity:.5;cursor:default}' +
      '#mexp-diss .aiout{font-size:12px;line-height:1.55;color:var(--text2);margin-top:10px;white-space:pre-wrap}' +
      '#mexp-diss .dpfull{margin-top:16px}' +
      '#mexp-diss .phead{font-size:11.5px;font-weight:700;color:var(--text2);line-height:1.5;margin:2px 0 8px}' +
      '#mexp-diss .ptbl{width:100%;border-collapse:collapse;font-size:10.5px}' +
      '#mexp-diss .ptbl th{text-align:right;font-weight:700;color:var(--text3);padding:3px 10px 4px 0;border-bottom:1px solid var(--glass-border);text-transform:uppercase;font-size:9px;letter-spacing:.3px}' +
      '#mexp-diss .ptbl th:first-child,#mexp-diss .ptbl td:first-child{text-align:left}' +
      '#mexp-diss .ptbl td{text-align:right;padding:3px 10px 3px 0;border-bottom:1px solid rgba(255,255,255,0.05);color:var(--text2);white-space:nowrap}' +
      // ---- 12-month category margin table ----
      '#mexp-diss .ctwrap{overflow-x:auto}' +
      '#mexp-diss .cthd{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}' +
      '#mexp-diss .ctnote{font-size:9.5px;color:var(--text3);font-weight:600;margin:6px 0 10px;line-height:1.45}' +
      '#mexp-diss .ctoggle{display:inline-flex;border:1px solid var(--glass-border);border-radius:8px;overflow:hidden}' +
      '#mexp-diss .ctoggle button{background:transparent;border:0;color:var(--text3);font-size:10px;font-weight:800;letter-spacing:.3px;padding:5px 11px;cursor:pointer}' +
      '#mexp-diss .ctoggle button.on{background:var(--blue);color:#fff}' +
      // clean financial table — no heat fills; thin separators; tabular nums.
      '#mexp-diss table.ctbl{width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums}' +
      '#mexp-diss table.ctbl th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;color:var(--text3);padding:5px 10px;border-bottom:1px solid var(--glass-border);text-align:right;white-space:nowrap}' +
      '#mexp-diss table.ctbl th.ctrow,#mexp-diss table.ctbl td.ctrow{text-align:left;font-weight:700;color:var(--text2);white-space:nowrap;position:sticky;left:0;background:var(--surface);z-index:1}' +
      '#mexp-diss table.ctbl th.ctpartial{color:var(--text3)}' +
      // plain transparent cells, right-aligned, thin row separator only
      '#mexp-diss table.ctbl td{padding:4px 10px;text-align:right;background:transparent;color:var(--text);white-space:nowrap;border-bottom:1px solid rgba(255,255,255,0.04)}' +
      // negatives: red text only (no fill)
      '#mexp-diss table.ctbl td.ctneg{color:var(--red)}' +
      // partial month column: muted text + thin dashed left border (no loud gold fill)
      '#mexp-diss table.ctbl th.ctpartial,#mexp-diss table.ctbl td.ctpartial{border-left:1px dashed var(--glass-border)}' +
      '#mexp-diss table.ctbl td.ctnull{color:var(--text3)}' +
      '#mexp-diss table.ctbl tr.ctavg td{border-top:2px solid var(--glass-border);font-weight:900;color:var(--text);padding-top:7px}' +
      '#mexp-diss table.ctbl tr.ctavg td.ctneg{color:var(--red)}' +
      '#mexp-diss table.ctbl tr.ctavg td.ctrow{text-transform:uppercase;letter-spacing:.3px;font-size:10px}' +
      '#mexp-diss table.ctbl tr.ctzero td.ctrow{color:var(--text3);font-weight:600;font-style:italic}' +
      '#mexp-diss .ctt{font-size:8.5px;font-weight:700;color:var(--text3);opacity:.65;margin-left:4px}' +
      '</style>' +
      '<div class="dh"><div><div class="dt">Finished-Feed Dissection <span style="font-size:10px;color:var(--gold)">GM/ton</span></div>' +
      '<div class="dsub" id="diss-sub">—</div></div><button class="aibtn" id="diss-ai">✦ AI read</button></div>' +
      // ---- 12-month category margin table (headline trend artifact) ----
      '<div class="dp dpfull" id="diss-cat" style="margin-top:0">' +
        '<div class="cthd">' +
          '<div class="dp-h" style="display:flex;flex-direction:column;gap:2px">' +
            '<h4 style="margin:0">Category margin · trailing 12 months</h4>' +
            '<span style="font-size:9.5px;color:var(--text3);font-weight:600">Finished feed · GM by SSG category · biggest-volume first · inherits Region/BU/Customer filter</span>' +
          '</div>' +
          '<div class="ctoggle" id="diss-cat-toggle">' +
            '<button data-mode="ton" class="on">₱/ton</button>' +
            '<button data-mode="pct">GM%</button>' +
          '</div>' +
        '</div>' +
        '<div class="ctnote" id="diss-cat-note"></div>' +
        '<div class="ctwrap"><div id="diss-cat-body"></div></div>' +
      '</div>' +
      '<div class="dgrid2">' +
      '<div class="dp"><h4>GM/ton &amp; Revenue/ton trajectory</h4><div class="cw"><canvas id="diss-traj"></canvas></div></div>' +
      '<div class="dp"><h4>Ingredient cost contribution (recipe-weighted) <span style="font-weight:400;font-size:9px;opacity:.75">* = no purchase in one month — price carried, recipe effect only</span></h4><div class="cw"><canvas id="diss-ing"></canvas></div></div>' +
      '</div>' +
      '<div class="aiout" id="diss-aiout"></div>';
    host.appendChild(sec);
    document.getElementById('diss-ai').addEventListener('click', runAi);
    // category-table ₱/ton ↔ GM% toggle (re-renders from cached payload, no refetch)
    var tog = document.getElementById('diss-cat-toggle');
    if (tog) tog.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
      if (!b) return;
      var m = b.getAttribute('data-mode');
      if (m === CAT_MODE) return;
      CAT_MODE = m;
      Array.prototype.forEach.call(tog.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-mode') === m);
      });
      renderCategoryTable(LAST_CT);
    });
    return sec;
  }

  var LAST = null;
  var HAD_GOOD = false;    // true once a good dissection has painted FOR THE CURRENT SCOPE
                           // (guards against a transient unavailable refresh wiping good charts;
                           // reset by MEXP_resetDissection on every scope change)
  var GOOD_SCOPE = '';     // label of the scope HAD_GOOD describes
  var LAST_CT = null;      // cached category_trend payload (for toggle re-render); reset with scope
  var CAT_MODE = 'ton';    // 'ton' = GM ₱/ton (default) | 'pct' = GM%
  var SCOPE_LABEL = 'this scope';

  // Scope changed: nothing from the previous scope may survive as "last good".
  window.MEXP_resetDissection = function () {
    HAD_GOOD = false; GOOD_SCOPE = ''; LAST = null; LAST_CT = null;
    var sec = document.getElementById('mexp-diss');
    if (sec) sec.classList.remove('mexp-stale');
  };

  // Subtle "updating" state for the dissection block during phase B (set by controller).
  window.MEXP_setDissectionUpdating = function (on) {
    var sec = document.getElementById('mexp-diss'); if (!sec) return;
    if (on) sec.classList.add('mexp-dim'); else sec.classList.remove('mexp-dim');
  };

  window.MEXP_renderDissection = function (d, label) {
    var sec = ensure(); if (!sec) return;
    SCOPE_LABEL = label || SCOPE_LABEL;
    var subEl = document.getElementById('diss-sub');
    // Category table: re-render when the new payload carries one. A SAME-scope
    // transient unavailable must not wipe a good table (LAST_CT survives); after a
    // scope change LAST_CT is null, so an absent table is shown as absent.
    var newCT = (d && d.category_trend) || null;
    if (newCT) { LAST_CT = newCT; renderCategoryTable(LAST_CT); }
    else if (!LAST_CT) renderCategoryTable(null);

    if (!d || d.available === false) {
      var reason = (d && d.reason) || 'No finished-feed data for this selection.';
      if (HAD_GOOD) {
        // same scope, refresh failed: keep charts + table, dim, name the scope shown
        sec.classList.add('mexp-stale');
        if (subEl) subEl.textContent = '⚠ source busy — could not refresh; showing ' + (GOOD_SCOPE || SCOPE_LABEL) + ' (' + reason + ')';
        return;
      }
      // nothing to keep for this scope: an empty scope is an answer, not an outage
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
    var partIdx = series.map(function (s, i) { return s.partial ? i : -1 }).filter(function (i) { return i >= 0; });
    c._ch = new Chart(c.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels, datasets: [
          // Both series are ₱/ton — ONE shared axis, so the gap between them is
          // the real COGS/ton and not an artefact of two auto-scaled axes.
          { label: 'GM/ton', data: gm, yAxisID: 'y', borderColor: p.green, backgroundColor: 'rgba(123,181,46,.12)', borderWidth: 3, fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: p.green, segment: { borderDash: function (ctx) { return partIdx.indexOf(ctx.p1DataIndex) >= 0 ? [5, 4] : undefined; } } },
          { label: 'Rev/ton', data: rev, yAxisID: 'y', borderColor: p.navy, borderWidth: 2, borderDash: [4, 3], fill: false, tension: .3, pointRadius: 0 }
        ]
      },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: true, labels: { color: p.text3, font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: function (i) { return i.dataset.label + ': ' + pt(i.parsed.y) + '/t'; } } } },
        scales: {
          y: { position: 'left', beginAtZero: true, grid: { color: p.grid }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return '₱' + (v / 1000).toFixed(0) + 'k'; } } },
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

  // =========================================================================
  // 12-MONTH CATEGORY MARGIN TABLE
  // Rows = SSG categories (biggest-volume first, API order), cols = months.
  // Cell = GM ₱/ton (default) or GM% (toggle). Clean financial table — no heat
  // fills; negatives in red text only. Bottom = volume-weighted AVG row.
  // =========================================================================
  function fmtTon(v) { return v == null ? '—' : '₱' + Math.round(+v).toLocaleString(); }
  function fmtPct(v) { return v == null ? '—' : ((+v).toFixed(1) + '%'); }

  function renderCategoryTable(ct) {
    var body = document.getElementById('diss-cat-body');
    var noteEl = document.getElementById('diss-cat-note');
    var panel = document.getElementById('diss-cat');
    if (!body) return;
    if (!ct || ct.available === false || !ct.months || !ct.months.length) {
      // never hide: an unavailable table is an answer — print it, named to the scope
      if (panel) panel.style.display = '';
      body.textContent = '';
      var m = document.createElement('div');
      m.style.cssText = 'font-size:11px;color:var(--text);font-weight:600;padding:10px 2px';
      m.textContent = 'ⓘ No category trend for ' + SCOPE_LABEL + ((ct && ct.note) ? ' — ' + ct.note : '.');
      body.appendChild(m);
      if (noteEl) noteEl.textContent = '';
      return;
    }
    if (panel) panel.style.display = '';
    var mode = CAT_MODE;
    var fmt = mode === 'pct' ? fmtPct : fmtTon;
    var months = ct.months;
    var partial = ct.partial_month || null;

    var tbl = document.createElement('table');
    tbl.className = 'ctbl';

    // header
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    var th0 = document.createElement('th');
    th0.className = 'ctrow';
    th0.textContent = 'Category';
    hr.appendChild(th0);
    months.forEach(function (ym) {
      var th = document.createElement('th');
      var isP = (ym === partial);
      th.className = isP ? 'ctpartial' : '';
      th.textContent = monLbl(ym);
      if (isP) {
        var s = document.createElement('span');
        s.className = 'ctt';
        s.textContent = '(part.)';
        th.appendChild(s);
      }
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    // body rows
    var tb = document.createElement('tbody');
    (ct.categories || []).forEach(function (cat) {
      var isZero = (+cat.total_tons || 0) <= 0;
      var tr = document.createElement('tr');
      if (isZero) tr.className = 'ctzero';
      var td0 = document.createElement('td');
      td0.className = 'ctrow';
      td0.textContent = cat.ssg;
      if (!isZero) {
        var vol = document.createElement('span');
        vol.className = 'ctt';
        vol.textContent = Math.round(+cat.total_tons || 0).toLocaleString() + 't';
        td0.appendChild(vol);
      }
      tr.appendChild(td0);
      // index cells by month for safe alignment
      var byMonth = {};
      (cat.cells || []).forEach(function (c) { byMonth[c.month] = c; });
      months.forEach(function (ym) {
        var c = byMonth[ym];
        var v = c ? (mode === 'pct' ? c.gm_pct : c.gm_ton) : null;
        var td = document.createElement('td');
        if (ym === partial) td.className = 'ctpartial';
        if (v == null || isNaN(v)) {
          td.className = (td.className ? td.className + ' ' : '') + 'ctnull';
          td.textContent = '—';
        } else {
          td.textContent = fmt(v);
          // clean table: no heat fills. Negatives = red text only.
          // Zero-tonnage rows (meaningless ₱/ton) stay muted.
          if (isZero) td.style.color = 'var(--text3)';
          else if (+v < 0) td.className = (td.className ? td.className + ' ' : '') + 'ctneg';
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);

    // AVG row (volume-weighted) — bold, separated
    var tf = document.createElement('tbody');
    var avgByMonth = {};
    (ct.avg || []).forEach(function (c) { avgByMonth[c.month] = c; });
    var ar = document.createElement('tr');
    ar.className = 'ctavg';
    var a0 = document.createElement('td');
    a0.className = 'ctrow';
    a0.textContent = mode === 'pct' ? 'AVG GM%' : 'AVG GM/T';
    ar.appendChild(a0);
    months.forEach(function (ym) {
      var c = avgByMonth[ym];
      var v = c ? (mode === 'pct' ? c.gm_pct : c.gm_ton) : null;
      var td = document.createElement('td');
      if (ym === partial) td.className = 'ctpartial';
      if (v == null || isNaN(v)) { td.textContent = '—'; td.style.color = 'var(--text3)'; }
      else {
        td.textContent = fmt(v);
        if (+v < 0) td.className = (td.className ? td.className + ' ' : '') + 'ctneg';
      }
      ar.appendChild(td);
    });
    tf.appendChild(ar);
    tbl.appendChild(tf);

    body.textContent = '';
    body.appendChild(tbl);
    if (noteEl) {
      noteEl.textContent = (ct.note || '') +
        (partial ? '  ·  ' + monLbl(partial) + ' is a partial month (dashed) — month-to-date only.' : '');
    }
  }

  // ---- AI read (server-proxied POST /api/margin-ai) ----
  // Goes through the shell's API client (window.apiPost: session header, 401 →
  // logout) instead of a bare fetch. apiFetch is GET-only, hence apiPost.
  function runAi() {
    if (!LAST || LAST.available === false) return;
    var btn = document.getElementById('diss-ai'), out = document.getElementById('diss-aiout');
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '✦ reading…'; out.textContent = '';
    function done() { btn.disabled = false; btn.textContent = old; }
    if (typeof window.apiPost !== 'function') { out.textContent = 'AI read unavailable (API client not loaded).'; done(); return; }
    var digest = {
      scope: LAST.scope, base_month: LAST.base_month, compare_month: LAST.compare_month,
      trajectory: LAST.trajectory, bridge: LAST.bridge, mix_bridge: LAST.mix_bridge, ingredients: LAST.ingredients,
      price_drill: LAST.price_drill
    };
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
