/*
 * margin-explorer-dissection.js — Finished-Feed Dissection panels for the Margin Explorer.
 *
 * Renders the 4 Margin-Dissection-Analyser panels from the endpoint's `dissection` block:
 *   1. GM/ton + revenue/ton trajectory (cross-DB Sep-2025 -> now; partial month dashed)
 *   2. SSG GM/ton bridge (Price / Mix / Cost / Interaction waterfall)
 *   3. Product-mix bridge (top SSG contributions to the Mix bar)
 *   4. Ingredient cost contribution (recipe-weighted, top movers)
 * + a server-proxied "AI read" button (POST /api/margin-ai).
 *
 * Self-contained: injects its own <section> into #pg-margin-explorer on first render.
 * Exposes window.MEXP_renderDissection(dissection).
 */
(function () {
  'use strict';
  function cssVar(n, f) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v || '').trim() || f; } catch (e) { return f; } }
  function P() {
    return {
      navy: cssVar('--blue', '#00AEEF'), green: cssVar('--green', '#7BB52E'),
      gold: cssVar('--gold', '#FFC72C'), teal: '#00A8CC', red: cssVar('--red', '#E53935'),
      text: cssVar('--text', '#F0F4FA'), text3: cssVar('--text3', 'rgba(240,244,250,0.4)'),
      grid: 'rgba(255,255,255,0.05)', grey: 'rgba(240,244,250,0.28)'
    };
  }
  function esc(s) { return window.esc ? window.esc(s) : String(s == null ? '' : s); }
  function pt(n) { return '₱' + Math.round(+n || 0).toLocaleString(); }
  function ptS(n) { n = +n || 0; var s = '₱' + Math.round(Math.abs(n)).toLocaleString(); return n > 0 ? '+' + s : (n < 0 ? '−' + s : s); }
  function kill(c) { if (c && c._ch) { try { c._ch.destroy(); } catch (e) {} c._ch = null; } if (window.Chart && Chart.getChart) { var e = Chart.getChart(c); if (e) { try { e.destroy(); } catch (x) {} } } }

  // ---- one-time DOM ----
  function ensure() {
    var host = document.getElementById('pg-margin-explorer'); if (!host) return null;
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
      '</style>' +
      '<div class="dh"><div><div class="dt">Finished-Feed Dissection <span style="font-size:10px;color:var(--gold)">GM/ton</span></div>' +
      '<div class="dsub" id="diss-sub">—</div></div><button class="aibtn" id="diss-ai">✦ AI read</button></div>' +
      '<div class="dgrid">' +
      '<div class="dp"><h4>GM/ton &amp; Revenue/ton trajectory</h4><div class="cw"><canvas id="diss-traj"></canvas></div></div>' +
      '<div class="dp"><h4 id="diss-bridge-h">GM/ton bridge</h4><div class="cw"><canvas id="diss-bridge"></canvas></div></div>' +
      '</div>' +
      '<div class="dgrid2">' +
      '<div class="dp"><h4>Product-mix bridge (by SSG)</h4><div class="cw"><canvas id="diss-mix"></canvas></div></div>' +
      '<div class="dp"><h4>Ingredient cost contribution (recipe-weighted) <span style="font-weight:400;font-size:9px;opacity:.75">* = no purchase in one month — price carried, recipe effect only</span></h4><div class="cw"><canvas id="diss-ing"></canvas></div></div>' +
      '</div>' +
      '<div class="aiout" id="diss-aiout"></div>';
    host.appendChild(sec);
    document.getElementById('diss-ai').addEventListener('click', runAi);
    return sec;
  }

  var LAST = null;

  window.MEXP_renderDissection = function (d) {
    var sec = ensure(); if (!sec) return;
    LAST = d || null;
    if (!d || d.available === false) {
      document.getElementById('diss-sub').textContent = (d && d.reason) || 'No finished-feed data for this selection.';
      ['diss-traj', 'diss-bridge', 'diss-mix', 'diss-ing'].forEach(function (id) { kill(document.getElementById(id)); });
      return;
    }
    var cmpLbl = d.compare_month + (d.compare_partial ? ' (' + (d.compare_days || '') + 'd partial — early read, noisy)' : '');
    document.getElementById('diss-sub').textContent =
      'Finished feed (Live 103 / Old 103+104) · bridge ' + d.base_month + ' → ' + cmpLbl;
    var bh = document.getElementById('diss-bridge-h');
    if (bh) bh.textContent = 'GM/ton bridge · ' + d.base_month + ' → ' + cmpLbl;
    renderTraj(d.trajectory || []);
    renderBridge(d.bridge || {});
    renderDiverging('diss-mix', (d.mix_bridge && d.mix_bridge.items) || [], 'ssg', true);
    renderDiverging('diss-ing', (d.ingredients && d.ingredients.items) || [], 'name', false);
  };

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

  function renderBridge(b) {
    var c = document.getElementById('diss-bridge'); if (!c || !window.Chart) return; kill(c);
    var p = P();
    if (b.available === false) { return; }
    var steps = [
      { l: 'Base', v: b.base, anc: 1 },
      { l: 'Price', d: b.price }, { l: 'Mix', d: b.mix }, { l: 'Cost', d: b.cost }, { l: 'Interac.', d: b.interaction },
      { l: 'Compare', v: b.compare, anc: 1 }
    ];
    var run = b.base, labels = [], ranges = [], colors = [], lab = [];
    steps.forEach(function (s) {
      labels.push(s.l);
      if (s.anc) { ranges.push([0, s.v]); colors.push(s.l === 'Base' ? p.grey : p.navy); lab.push(pt(s.v)); run = s.v; }
      else { var st = run, en = run + (s.d || 0); ranges.push([Math.min(st, en), Math.max(st, en)]); colors.push((s.d || 0) >= 0 ? p.green : p.red); lab.push(ptS(s.d)); run = en; }
    });
    var plug = {
      id: 'dbl', afterDatasetsDraw: function (ch) {
        var ct = ch.ctx, m = ch.getDatasetMeta(0); ct.save(); ct.font = '700 9px system-ui'; ct.fillStyle = p.text; ct.textAlign = 'center';
        m.data.forEach(function (bar, i) { ct.fillText(lab[i], bar.x, bar.y - 4); });
        ct.restore();
      }
    };
    c._ch = new Chart(c.getContext('2d'), {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: ranges, backgroundColor: colors, borderRadius: 3, barPercentage: .82 }] },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (i) { return lab[i.dataIndex]; } } } },
        scales: { y: { grid: { color: p.grid }, ticks: { color: p.text3, font: { size: 9 }, callback: function (v) { return '₱' + (v / 1000).toFixed(0) + 'k'; } } }, x: { grid: { display: false }, ticks: { color: p.text3, font: { size: 9 } } } }
      }), plugins: [plug]
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

  // ---- AI read (server-proxied) ----
  async function runAi() {
    if (!LAST || LAST.available === false) return;
    var btn = document.getElementById('diss-ai'), out = document.getElementById('diss-aiout');
    btn.disabled = true; var old = btn.textContent; btn.textContent = '✦ reading…'; out.textContent = '';
    try {
      var sess = JSON.parse(localStorage.getItem('vf_session') || '{}');
      var base = window.API_BASE || '';
      var digest = {
        scope: LAST.scope, base_month: LAST.base_month, compare_month: LAST.compare_month,
        trajectory: LAST.trajectory, bridge: LAST.bridge, mix_bridge: LAST.mix_bridge, ingredients: LAST.ingredients
      };
      var r = await fetch(base + '/margin-ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': sess.id || '' },
        body: JSON.stringify({ digest: digest })
      });
      if (!r.ok) { out.textContent = 'AI read unavailable (' + r.status + ').'; return; }
      var j = await r.json();
      out.textContent = j.text || 'No response.';
    } catch (e) { out.textContent = 'AI read failed: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = old; }
  }
})();
