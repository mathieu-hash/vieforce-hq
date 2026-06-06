// ============================================================================
// MARGIN EXPLORER — page controller
// Owns the DOM inside #pg-margin-explorer. Exposes window.loadMarginExplorer().
//
// Contract (per build brief):
//   - Data via apiFetch('margin-explorer', state)  (global, async, parsed JSON)
//   - Matrix rendered by window.MEXP_renderMatrix(el, matrix, opts)
//   - Bridge rendered by window.MEXP_renderBridge(canvas, bridge)
//   - Trend  rendered by window.MEXP_renderTrend(canvas, trend)
//   - Helpers fc/fcn/esc are global (guarded if absent).
//
// This file builds ONLY the page shell + filter state + orchestration.
// Matrix/bridge/trend rendering lives in their own sibling files.
// ============================================================================

(function () {
  'use strict';

  // --- Safe global helper shims (guard if app helpers absent) ----------------
  function _fc(n) {
    if (typeof window.fc === 'function') return window.fc(n);
    if (n == null || isNaN(n)) return '₱0';
    n = +n;
    if (Math.abs(n) >= 1e6) return '₱' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '₱' + (n / 1e3).toFixed(0) + 'K';
    return '₱' + n.toFixed(0);
  }
  function _fcn(n) {
    if (typeof window.fcn === 'function') return window.fcn(n);
    if (n == null || isNaN(n)) return '0';
    return (+n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function _esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function $(id) { return document.getElementById(id); }

  // --- Filter state ----------------------------------------------------------
  var STATE = {
    period:   (typeof window.PD === 'string' && window.PD) ? window.PD : 'YTD',
    ref_month: (typeof window.VF_REF_MONTH === 'string' &&
                /^\d{4}-\d{2}$/.test(window.VF_REF_MONTH)) ? window.VF_REF_MONTH : undefined,
    region:   'ALL',
    bu:       'ALL',
    customer: undefined,
    group_by: 'bu',
    compare:  'pp',
    unit:     'kg'
  };

  // Last fetched payload — kept so unit toggle can re-render matrix without refetch.
  var LAST = { matrix: null, fetchSeq: 0 };
  var built = false;

  // --- Config tables for chips ----------------------------------------------
  var REGIONS = [
    { v: 'ALL',      l: 'All' },
    { v: 'Luzon',    l: 'Luzon' },
    { v: 'Visayas',  l: 'Visayas' },
    { v: 'Mindanao', l: 'Mindanao' }
  ];
  var BUS = [
    { v: 'ALL',          l: 'All' },
    { v: 'DISTRIBUTION', l: 'Distribution' },
    { v: 'KEY ACCOUNTS', l: 'Key Accounts' },
    { v: 'PET CARE',     l: 'Pet Care' }
  ];
  var UNITS = [
    { v: 'kg',   l: '₱/kg' },
    { v: 'ton',  l: '₱/ton' },
    { v: 'gp_pct', l: 'GP%' },
    { v: 'gp',   l: '₱ GP' }
  ];
  var PERIODS = [
    { v: '7D',  l: '7D' },
    { v: 'MTD', l: 'MTD' },
    { v: 'QTD', l: 'QTD' },
    { v: 'YTD', l: 'YTD' }
  ];
  // Build "As of" options: Live + trailing 18 months as YYYY-MM.
  function asOfOptions() {
    var out = [{ v: 'live', l: 'Live' }];
    var now = new Date();
    for (var i = 0; i < 18; i++) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
      var lab = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      out.push({ v: key, l: lab });
    }
    return out;
  }
  var GROUP_BYS = [
    { v: 'bu',          l: 'BU' },
    { v: 'region',      l: 'Region' },
    { v: 'dsm',         l: 'DSM' },
    { v: 'brand',       l: 'Brand' },
    { v: 'species',     l: 'Species' },
    { v: 'sales_group', l: 'Sales Group' },
    { v: 'ssg',         l: 'SSG' },
    { v: 'customer',    l: 'Customer' },
    { v: 'sku',         l: 'SKU' }
  ];
  // group_bys whose row-click re-scopes a filter (the actual drill)
  var DRILL_FILTER = { region: 'region', bu: 'bu', customer: 'customer' };

  // =========================================================================
  // STYLE + SKELETON (injected once)
  // =========================================================================
  var STYLE = [
    '<style id="mexp-style">',
    '.mexp-wrap{padding:18px 20px 40px;color:var(--text)}',
    '.mexp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}',
    '.mexp-title{font-size:20px;font-weight:900;letter-spacing:-.3px;color:var(--text)}',
    '.mexp-sub{font-size:11px;color:var(--text3);margin-top:3px;font-weight:600}',
    '.mexp-clear{border:1px solid var(--glass-border);background:rgba(255,255,255,.035);color:var(--text2);font-size:10px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:6px 11px;border-radius:8px;cursor:pointer}',
    '.mexp-clear:hover{border-color:var(--glass-border-hover);color:var(--text)}',
    // filter bar
    '.mexp-filters{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--glass-border);border-radius:var(--r-lg);background:var(--surface);margin-bottom:16px}',
    '.mexp-fgroup{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.mexp-flabel{font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--text3);margin-right:2px}',
    '.mexp-chip{border:1px solid var(--glass-border);background:rgba(255,255,255,.035);color:var(--text2);font-size:11px;font-weight:800;padding:5px 11px;border-radius:8px;cursor:pointer;transition:all .12s;white-space:nowrap}',
    '.mexp-chip:hover{border-color:var(--glass-border-hover);color:var(--text)}',
    '.mexp-chip.active{background:var(--blue);border-color:var(--blue);color:#fff}',
    '.mexp-search{padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;min-width:170px}',
    '.mexp-search::placeholder{color:var(--text3)}',
    '.mexp-divider{width:1px;align-self:stretch;background:var(--glass-border);margin:0 2px}',
    // hero
    '.mexp-hero{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}',
    '.mexp-kpi{border:1px solid var(--glass-border);border-radius:var(--r-lg);background:var(--surface);padding:14px 16px}',
    '.mexp-kpi-l{font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:var(--text3)}',
    '.mexp-kpi-v{font-size:26px;font-weight:900;letter-spacing:-.5px;margin-top:7px;font-family:var(--mono,inherit);color:var(--text)}',
    '.mexp-kpi-d{font-size:11px;font-weight:800;margin-top:5px}',
    '.mexp-kpi-d.up{color:var(--green)}',
    '.mexp-kpi-d.down{color:var(--red)}',
    '.mexp-kpi-d.flat{color:var(--text3)}',
    // 2-col body
    '.mexp-body{display:grid;grid-template-columns:1.55fr 1fr;gap:16px;align-items:start}',
    '.mexp-panel{border:1px solid var(--glass-border);border-radius:var(--r-lg);background:var(--surface);padding:14px 16px}',
    '.mexp-panel-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
    '.mexp-panel-t{font-size:12px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}',
    '.mexp-canvas-wrap{position:relative;width:100%;min-height:170px}',
    '.mexp-canvas-wrap canvas{width:100%!important;display:block}',
    '.mexp-note{font-size:10px;color:var(--text3);font-weight:600;margin-top:10px;line-height:1.5}',
    '.mexp-coming{font-size:11px;color:var(--text3);font-weight:700;padding:18px 8px;text-align:center;border:1px dashed var(--glass-border);border-radius:10px;margin-top:12px}',
    // states
    '.mexp-loading{padding:36px 8px;text-align:center;color:var(--text3);font-size:12px;font-weight:700}',
    '.mexp-error{padding:18px;border:1px solid var(--red);border-radius:10px;background:rgba(255,80,80,.06);color:var(--red);font-size:12px;font-weight:700}',
    '.mexp-skel{height:10px;border-radius:4px;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.12),rgba(255,255,255,.05));background-size:200% 100%;animation:mexpsk 1.2s infinite}',
    '@keyframes mexpsk{0%{background-position:200% 0}100%{background-position:-200% 0}}',
    '@media(max-width:980px){.mexp-hero{grid-template-columns:repeat(2,1fr)}.mexp-body{grid-template-columns:1fr}}',
    '</style>'
  ].join('');

  function chipRow(groupKey, items, currentVal) {
    return items.map(function (it) {
      var on = (it.v === currentVal) ? ' active' : '';
      return '<button class="mexp-chip' + on + '" data-mexp-group="' + groupKey +
        '" data-mexp-val="' + _esc(it.v) + '">' + _esc(it.l) + '</button>';
    }).join('');
  }

  function asOfSelect() {
    var cur = STATE.ref_month || 'live';
    var opts = asOfOptions().map(function (o) {
      var sel = (o.v === cur) ? ' selected' : '';
      return '<option value="' + _esc(o.v) + '"' + sel + '>' + _esc(o.l) + '</option>';
    }).join('');
    return '<select id="mexp-asof" class="mexp-search" style="min-width:120px">' + opts + '</select>';
  }

  function groupBySelect() {
    var opts = GROUP_BYS.map(function (g) {
      var sel = (g.v === STATE.group_by) ? ' selected' : '';
      return '<option value="' + _esc(g.v) + '"' + sel + '>' + _esc(g.l) + '</option>';
    }).join('');
    return '<select id="mexp-groupby" class="mexp-search" style="min-width:120px">' + opts + '</select>';
  }

  function buildSkeleton() {
    var root = $('pg-margin-explorer');
    if (!root) { console.warn('[MEXP] #pg-margin-explorer not found'); return false; }

    var html = STYLE +
      '<div class="mexp-wrap">' +
        '<div class="mexp-head">' +
          '<div>' +
            '<div class="mexp-title">Margin Explorer</div>' +
            '<div class="mexp-sub" id="mexp-window">Loading window…</div>' +
          '</div>' +
          '<button class="mexp-clear" id="mexp-clear">Clear filters</button>' +
        '</div>' +

        // ---- period control row (tab-owned; no longer depends on global topbar) ----
        '<div class="mexp-filters">' +
          '<div class="mexp-fgroup"><span class="mexp-flabel">Period</span>' +
            chipRow('period', PERIODS, STATE.period) + '</div>' +
          '<div class="mexp-divider"></div>' +
          '<div class="mexp-fgroup"><span class="mexp-flabel">As of</span>' +
            asOfSelect() + '</div>' +
        '</div>' +

        // ---- quick-filter bar ----
        '<div class="mexp-filters">' +
          '<div class="mexp-fgroup"><span class="mexp-flabel">Region</span>' +
            chipRow('region', REGIONS, STATE.region) + '</div>' +
          '<div class="mexp-divider"></div>' +
          '<div class="mexp-fgroup"><span class="mexp-flabel">BU</span>' +
            chipRow('bu', BUS, STATE.bu) + '</div>' +
          '<div class="mexp-divider"></div>' +
          '<div class="mexp-fgroup">' +
            '<input id="mexp-customer" class="mexp-search" type="search" placeholder="Customer…"' +
              ' value="' + _esc(STATE.customer || '') + '"></div>' +
          '<div class="mexp-divider"></div>' +
          '<div class="mexp-fgroup"><span class="mexp-flabel">Compare</span>' +
            chipRow('compare', [{ v: 'pp', l: 'vs PP' }, { v: 'ly', l: 'vs LY' }], STATE.compare) + '</div>' +
          '<div class="mexp-divider"></div>' +
          '<div class="mexp-fgroup"><span class="mexp-flabel">Unit</span>' +
            chipRow('unit', UNITS, STATE.unit) + '</div>' +
        '</div>' +

        // ---- hero KPIs ----
        '<div class="mexp-hero">' +
          heroCard('net',   'Net Sales') +
          heroCard('gp',    'Gross Profit') +
          heroCard('gppct', 'GP %') +
          heroCard('gmkg',  'GM / kg') +
        '</div>' +
        '<div class="mexp-note" id="mexp-hero-note" style="display:none"></div>' +

        // ---- 2-col body ----
        '<div class="mexp-body">' +
          '<div class="mexp-panel">' +
            '<div class="mexp-panel-h">' +
              '<span class="mexp-panel-t">Drill Matrix</span>' +
            '</div>' +
            '<div id="mexp-matrix"><div class="mexp-loading">Loading…</div></div>' +
          '</div>' +
          '<div class="mexp-panel">' +
            '<div class="mexp-panel-h"><span class="mexp-panel-t">GM Bridge</span></div>' +
            '<div class="mexp-canvas-wrap"><canvas id="mexp-bridge"></canvas></div>' +
            '<div class="mexp-panel-h" style="margin-top:16px"><span class="mexp-panel-t">Trend</span></div>' +
            '<div class="mexp-canvas-wrap" style="min-height:140px"><canvas id="mexp-trend"></canvas></div>' +
            '<div class="mexp-coming" id="mexp-movers">Movers &amp; gap analysis — coming in Phase 2</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    root.innerHTML = html;
    wireEvents();
    return true;
  }

  function heroCard(key, label) {
    return '<div class="mexp-kpi">' +
      '<div class="mexp-kpi-l">' + _esc(label) + '</div>' +
      '<div class="mexp-kpi-v" id="mexp-hero-' + key + '">—</div>' +
      '<div class="mexp-kpi-d flat" id="mexp-hero-' + key + '-d">—</div>' +
    '</div>';
  }

  // =========================================================================
  // EVENT WIRING
  // =========================================================================
  function wireEvents() {
    var root = $('pg-margin-explorer');
    if (!root) return;

    // chip clicks (region / bu / compare / unit) via delegation
    root.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.mexp-chip') : null;
      if (!chip || !root.contains(chip)) return;
      var group = chip.getAttribute('data-mexp-group');
      var val = chip.getAttribute('data-mexp-val');
      if (!group) return;
      onChip(group, val);
    });

    var clear = $('mexp-clear');
    if (clear) clear.addEventListener('click', clearFilters);

    var gb = $('mexp-groupby');
    if (gb) gb.addEventListener('change', function () {
      STATE.group_by = gb.value;
      fetchAndRender();
    });

    var asof = $('mexp-asof');
    if (asof) asof.addEventListener('change', function () {
      // 'live' clears ref_month so the API anchors on real today.
      STATE.ref_month = (asof.value && asof.value !== 'live') ? asof.value : undefined;
      fetchAndRender();
    });

    var cust = $('mexp-customer');
    if (cust) {
      var t = null;
      cust.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var v = cust.value.trim();
          STATE.customer = v || undefined;
          fetchAndRender();
        }, 450);
      });
    }
  }

  function setChipActive(group, val) {
    var root = $('pg-margin-explorer');
    if (!root) return;
    var chips = root.querySelectorAll('.mexp-chip[data-mexp-group="' + group + '"]');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      if (c.getAttribute('data-mexp-val') === String(val)) c.classList.add('active');
      else c.classList.remove('active');
    }
  }

  function onChip(group, val) {
    if (group === 'unit') {
      // display-only — no refetch
      if (STATE.unit === val) return;
      STATE.unit = val;
      setChipActive('unit', val);
      renderMatrixOnly();
      return;
    }
    if (group === 'period') {
      if (STATE.period === val) return;
      STATE.period = val;
      setChipActive('period', val);
      fetchAndRender();
      return;
    }
    if (group === 'region') { STATE.region = val; setChipActive('region', val); }
    else if (group === 'bu') { STATE.bu = val; setChipActive('bu', val); }
    else if (group === 'compare') { STATE.compare = val; setChipActive('compare', val); }
    else return;
    fetchAndRender();
  }

  function clearFilters() {
    STATE.region = 'ALL';
    STATE.bu = 'ALL';
    STATE.customer = undefined;
    STATE.compare = 'pp';
    // unit + group_by are view prefs — keep them.
    setChipActive('region', 'ALL');
    setChipActive('bu', 'ALL');
    setChipActive('compare', 'pp');
    var cust = $('mexp-customer'); if (cust) cust.value = '';
    fetchAndRender();
  }

  // =========================================================================
  // FETCH + RENDER
  // =========================================================================
  function buildParams() {
    var p = {
      period:   STATE.period,
      region:   STATE.region,
      bu:       STATE.bu,
      group_by: STATE.group_by,
      compare:  STATE.compare,
      include:  'bridge,trend,movers,gap'
    };
    if (STATE.ref_month) p.ref_month = STATE.ref_month;
    if (STATE.customer)  p.customer = STATE.customer;
    return p;
  }

  function showMatrixLoading() {
    var m = $('mexp-matrix');
    if (m) m.innerHTML = '<div class="mexp-loading">Loading margin data…</div>';
  }
  function showError(msg) {
    var m = $('mexp-matrix');
    if (m) m.innerHTML = '<div class="mexp-error">Could not load margin data.<br>' + _esc(msg) + '</div>';
  }

  async function fetchAndRender() {
    if (typeof window.apiFetch !== 'function') {
      showError('apiFetch unavailable.');
      return;
    }
    var seq = ++LAST.fetchSeq;
    showMatrixLoading();

    var data;
    try {
      data = await window.apiFetch('margin-explorer', buildParams());
    } catch (err) {
      if (seq !== LAST.fetchSeq) return; // stale
      console.error('[MEXP] fetch error:', err);
      showError((err && err.message) ? err.message : 'Request failed.');
      return;
    }
    if (seq !== LAST.fetchSeq) return; // a newer request superseded this one
    if (!data) { showError('Empty response.'); return; }

    LAST.matrix = data.matrix || null;

    try { renderWindow(data.meta); } catch (e) { console.error('[MEXP] window:', e); }
    try { renderHero(data.hero); }   catch (e) { console.error('[MEXP] hero:', e); }
    try { renderMatrixOnly(); }      catch (e) { console.error('[MEXP] matrix:', e); }
    try { renderBridge(data.bridge); } catch (e) { console.error('[MEXP] bridge:', e); }
    try { renderTrend(data.trend); }   catch (e) { console.error('[MEXP] trend:', e); }
    try { renderMovers(data.movers, data.gap, data.bridge && data.bridge.ingredients, data.bridge && data.bridge.ingredients_meta); } catch (e) { console.error('[MEXP] movers:', e); }
  }

  function renderWindow(meta) {
    var el = $('mexp-window');
    if (!el) return;
    var w = meta && meta.window;
    var bits = [];
    if (w && w.from && w.to) bits.push(_esc(w.from) + ' → ' + _esc(w.to));
    bits.push(STATE.period);
    if (meta && meta.sap_validated) bits.push('SAP validated');
    el.textContent = bits.join('  ·  ');
  }

  function renderHero(hero) {
    if (!hero) return;
    setHero('net',   hero.net_sales,    'php',  hero.net_sales && hero.net_sales.delta_pct, 'pct');
    setHero('gp',    hero.gross_profit, 'php',  hero.gross_profit && hero.gross_profit.delta_pct, 'pct');
    setHero('gppct', hero.gp_pct,       'pct0', hero.gp_pct && hero.gp_pct.delta_pp, 'pp');
    setHero('gmkg',  hero.gm_per_kg,    'kg',   hero.gm_per_kg && hero.gm_per_kg.delta, 'abs');
    var noteEl = $('mexp-hero-note');
    if (noteEl) {
      if (hero.compare_note) { noteEl.textContent = (hero.ly_comparable === false ? '⚠ ' : 'ⓘ ') + hero.compare_note; noteEl.style.display = 'block'; }
      else { noteEl.style.display = 'none'; }
    }
  }

  function setHero(key, obj, valFmt, delta, deltaFmt) {
    var v = obj && (obj.value != null) ? obj.value : null;
    var vEl = $('mexp-hero-' + key);
    var dEl = $('mexp-hero-' + key + '-d');
    if (vEl) {
      var txt;
      if (v == null) txt = '—';
      else if (valFmt === 'php') txt = _fc(v);
      else if (valFmt === 'pct0') txt = (+v).toFixed(1) + '%';
      else if (valFmt === 'kg') txt = '₱' + (+v).toFixed(2);
      else txt = _fcn(v);
      // animate when helper present and numeric
      if (typeof window.animateNumber === 'function' && v != null && valFmt === 'php') {
        window.animateNumber(vEl, v, _fc, 600);
      } else {
        vEl.textContent = txt;
      }
    }
    if (dEl) {
      if (delta == null || isNaN(delta)) {
        dEl.textContent = '—';
        dEl.className = 'mexp-kpi-d flat';
      } else {
        var arrow = delta > 0 ? '▲' : (delta < 0 ? '▼' : '•');
        var cls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
        var label;
        if (deltaFmt === 'pct') label = Math.abs(delta).toFixed(1) + '%';
        else if (deltaFmt === 'pp') label = Math.abs(delta).toFixed(1) + 'pp';
        else label = Math.abs(delta).toFixed(2);
        var basis = STATE.compare === 'ly' ? ' vs LY' : ' vs PP';
        dEl.textContent = arrow + ' ' + label + basis;
        dEl.className = 'mexp-kpi-d ' + cls;
      }
    }
  }

  function renderMatrixOnly() {
    var el = $('mexp-matrix');
    if (!el) return;
    if (!LAST.matrix) { el.innerHTML = '<div class="mexp-loading">No data.</div>'; return; }
    if (typeof window.MEXP_renderMatrix !== 'function') {
      el.innerHTML = '<div class="mexp-error">Matrix renderer unavailable.</div>';
      return;
    }
    window.MEXP_renderMatrix(el, LAST.matrix, {
      unit: STATE.unit,
      selectedDim: selectedDimFor(),
      onRowClick: onRowClick,
      onGroupByChange: onGroupByChange
    });
  }

  // The currently "selected" dim is whichever filter the active group_by maps to.
  function selectedDimFor() {
    var f = DRILL_FILTER[STATE.group_by];
    if (f === 'region') return STATE.region !== 'ALL' ? STATE.region : null;
    if (f === 'bu')     return STATE.bu !== 'ALL' ? STATE.bu : null;
    if (f === 'customer') return STATE.customer || null;
    return null;
  }

  function onGroupByChange(newGroupBy) {
    if (!newGroupBy || newGroupBy === STATE.group_by) return;
    STATE.group_by = newGroupBy;
    var gb = $('mexp-groupby');
    if (gb) gb.value = newGroupBy;
    fetchAndRender();
  }

  function onRowClick(row) {
    if (!row || row.dim == null) return;
    var filterKey = DRILL_FILTER[STATE.group_by];
    if (!filterKey) {
      // deeper drill = Phase 2; matrix renderer handles highlight itself.
      return;
    }
    // Set the matching filter to the clicked dim and re-scope hero+bridge.
    if (filterKey === 'region') { STATE.region = row.dim; setChipActive('region', row.dim); }
    else if (filterKey === 'bu') { STATE.bu = row.dim; setChipActive('bu', row.dim); }
    else if (filterKey === 'customer') {
      STATE.customer = row.dim;
      var cust = $('mexp-customer'); if (cust) cust.value = row.dim;
    }
    fetchAndRender();
  }

  function renderBridge(bridge) {
    var c = $('mexp-bridge');
    if (!c) return;
    if (typeof window.MEXP_renderBridge === 'function') {
      window.MEXP_renderBridge(c, bridge);
    } else {
      placeholderCanvas(c, 'Bridge renderer unavailable');
    }
  }

  function renderTrend(trend) {
    var c = $('mexp-trend');
    if (!c) return;
    if (typeof window.MEXP_renderTrend === 'function') {
      window.MEXP_renderTrend(c, trend);
    } else if (!trend || !trend.series || !trend.series.length) {
      placeholderCanvas(c, 'Trend — coming in Phase 2');
    } else {
      placeholderCanvas(c, 'Trend renderer unavailable');
    }
  }

  function renderMovers(movers, gap, ingredients, ingMeta) {
    var el = $('mexp-movers');
    if (!el) return;
    // Ingredient cost — now-vs-prior table (raw ₱/kg price move + inclusion% + ₱/ton-of-feed Δ).
    if (ingredients && ingredients.length) {
      var es = window.esc || function (x) { return x; };
      var nz = function (n) { return n == null ? null : (+n || 0); };
      var fkg = function (n) { if (n == null) return '—'; return (Math.round((+n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      var fpct = function (n) { if (n == null) return '—'; var v = +n || 0; return (v < 1 ? (Math.round(v * 100) / 100) : (Math.round(v * 10) / 10)); };
      var fpt = function (n) { return '₱' + Math.round(+n || 0).toLocaleString(); };
      var fdt = function (n) { n = +n || 0; var s = '₱' + Math.round(Math.abs(n)).toLocaleString(); return n > 0 ? '▲ +' + s : (n < 0 ? '▼ −' + s : '·'); };
      var f1 = function (n) { return (Math.round((+n || 0) * 10) / 10).toLocaleString(); };
      var rows = ingredients.slice(0, 12).map(function (i) {
        var rose = i.perton_delta > 0, fell = i.perton_delta < 0;
        var dCol = rose ? 'var(--red)' : (fell ? 'var(--green)' : 'var(--text3)');
        var pNow = nz(i.price_now), pPri = nz(i.price_prior);
        var pUp = pPri != null && pNow > pPri, pDn = pPri != null && pNow < pPri;
        var pCol = pUp ? 'var(--red)' : (pDn ? 'var(--green)' : 'var(--text)');
        var pArr = pUp ? ' ▲' : (pDn ? ' ▼' : '');
        var priceCell = (pPri == null ? '<span style="color:var(--gold)">new</span> ' : '<span style="color:var(--text3)">' + fkg(pPri) + '</span> → ')
          + '<b style="color:' + pCol + '">' + fkg(pNow) + '</b>' + pArr;
        var inclCell = (i.incl_prior_pct == null ? '' : '<span style="color:var(--text3)">' + fpct(i.incl_prior_pct) + '</span>→') + fpct(i.incl_now_pct);
        // price vs recipe split kept on hover (the decomposition)
        var tip = 'price ' + (i.price_effect > 0 ? '+' : (i.price_effect < 0 ? '−' : '')) + '₱' + f1(Math.abs(i.price_effect)) + '/t  ·  recipe ' + (i.inclusion_effect > 0 ? '+' : (i.inclusion_effect < 0 ? '−' : '')) + '₱' + f1(Math.abs(i.inclusion_effect)) + '/t';
        return '<tr>' +
          '<td class="ing-nm" title="' + es(i.name) + '">' + es(i.name) + '</td>' +
          '<td class="num">' + priceCell + '</td>' +
          '<td class="num">' + inclCell + '</td>' +
          '<td class="num">' + fpt(i.perton_cost) + '</td>' +
          '<td class="num" style="color:' + dCol + ';font-weight:600;cursor:help" title="' + tip + '">' + fdt(i.perton_delta) + '</td>' +
          '</tr>';
      }).join('');
      var sub = (ingMeta && ingMeta.note) ? es(ingMeta.note) : '';
      el.innerHTML = '<div class="mexp-panel-h"><span class="mexp-panel-t">Ingredient Cost / Ton of Feed</span></div>' +
        '<style>' +
        '.mexp-ing-tbl{width:100%;border-collapse:collapse;font-size:11px}' +
        '.mexp-ing-tbl th,.mexp-ing-tbl td{padding:3px 6px;border-bottom:1px solid var(--surface2,#1b2940)}' +
        '.mexp-ing-tbl th{color:var(--text3);font-size:9px;text-transform:uppercase;letter-spacing:.04em;text-align:right;font-weight:600;white-space:nowrap}' +
        '.mexp-ing-tbl th:first-child{text-align:left}' +
        '.mexp-ing-tbl td.num{text-align:right;font-family:var(--mono,monospace);white-space:nowrap}' +
        '.mexp-ing-tbl td.ing-nm{color:var(--text2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '</style>' +
        '<div style="font-size:9px;color:var(--text3);margin:-2px 0 6px;line-height:1.4">' + sub + '</div>' +
        '<table class="mexp-ing-tbl"><thead><tr>' +
        '<th>Ingredient</th><th>₱/kg was→now</th><th>incl %</th><th>₱/t feed</th><th>Δ ₱/t</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="font-size:9px;color:var(--text3);margin-top:6px;line-height:1.4">▲ red = cost rose · ▼ green = cost fell · hover Δ for price vs recipe split. Short windows (early MTD) have few purchase invoices — use QTD/YTD for a stable price read.</div>';
      el.style.display = 'block';
      return;
    }
    var hasGap = gap && gap.available;
    el.textContent = hasGap ? 'Gap analysis — coming in Phase 2' : 'Ingredient & gap analysis — select MTD/QTD to see per-ton ingredient cost';
  }

  // Lightweight placeholder painted directly on the canvas when a renderer
  // is absent or data is stubbed, so the panel never looks broken.
  function placeholderCanvas(canvas, msg) {
    try {
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return;
      var w = canvas.clientWidth || canvas.width || 280;
      var h = canvas.clientHeight || canvas.height || 150;
      canvas.width = w; canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      var cs = getComputedStyle(document.documentElement);
      ctx.fillStyle = (cs.getPropertyValue('--text3') || '#789').trim() || '#789';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, w / 2, h / 2);
    } catch (e) { /* canvas painting is best-effort */ }
  }

  // =========================================================================
  // PUBLIC ENTRY
  // =========================================================================
  window.loadMarginExplorer = function loadMarginExplorer() {
    if (!built) {
      // Seed the INITIAL default from the global topbar only on first build.
      // After that the tab owns its own Period / As-of controls and no longer
      // tracks the global topbar (so it works without the user setting it).
      // The GM bridge + ingredient decomposition need a like-for-like prior period
      // WITHIN 2026; YTD/7D priors cross the Jan-2026 consolidation (no bridge). So land
      // on QTD (fully populated: bridge + ingredients + trend) rather than inherit a YTD
      // topbar that would open with two empty panels. The user can still switch period.
      var seedP = (typeof window.PD === 'string' && window.PD) ? window.PD : 'QTD';
      STATE.period = (seedP === 'YTD' || seedP === '7D') ? 'QTD' : seedP;
      if (typeof window.VF_REF_MONTH === 'string' && /^\d{4}-\d{2}$/.test(window.VF_REF_MONTH)) {
        STATE.ref_month = window.VF_REF_MONTH;
      }
      built = buildSkeleton();
      if (!built) return;
    }
    // H4: on EVERY entry, inherit the topbar region window so the tab's own
    // region chip stays in sync with window.RG (set elsewhere). Only when RG
    // is a non-empty string; reflect it on the chip like period/region do.
    if (typeof window.RG === 'string' && window.RG) {
      STATE.region = window.RG;
      setChipActive('region', STATE.region);
    }
    fetchAndRender();
  };
})();
