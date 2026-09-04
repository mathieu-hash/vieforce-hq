// ============================================================================
// MARGIN EXPLORER — page controller
// Owns the DOM inside #pg-margin-explorer. Exposes window.loadMarginExplorer().
//
// Contract (per build brief):
//   - Data via apiFetch('margin-explorer', state)  (global, async, parsed JSON)
//   - Matrix (Snapshot tab) rendered by window.MEXP_renderMatrix(el, matrix, opts)
//   - Category-by-month matrix, the reported GM/ton bridge and the NET bridge
//     section are the mexp2 panels "trendmatrix", "bridge" and "netbridge"
//     (js/mexp2-panel-*.js), fed a view model built by MEXP2.adapter.vmFromV1
//     from the raw phase-A / phase-B payloads.
//   - Dissection rendered by MEXP_renderDissection
//   - Helpers fc/fcn/esc are global (guarded if absent).
//
// This file builds ONLY the page shell + filter state + orchestration.
// Matrix/bridge/dissection rendering lives in their own sibling files.
//
// PAGE ORDER (v1, unchanged): head · period bar · filter bar · hero KPIs ·
// 2-col body (Drill Matrix box | GM/ton Bridge box) · ingredient table ·
// NET bridge section · finished-feed dissection block (self-mounted by
// margin-explorer-dissection.js, which also carries the AI read button).
// Three boxes are mexp2 panels: the Drill Matrix box is the category-by-month
// table with the old single-period matrix as its "Snapshot" tab; the Bridge
// box is the SVG waterfall with v1's two reconciling drill tables (Cost,
// Product Mix by SSG) under it; the NET bridge section is the same SVG on the
// same scale beside its three-number strip and drivers table.
//
// THE ONE SCOPE MECHANISM: applyScope(patch) — installed on MEXP2.adapter as
// applyScope so the category table's row / cell clicks, the Snapshot row click
// and the page's own controls all go through the same function. patch uses the
// contract's scope names (region, bu, customer, refMonth, period, compare,
// unit, groupBy, drill). unit-only changes never refetch; anything that changes
// the server scope refetches. `drill` carries the category-table crumbs: a
// region / bu / customer crumb re-scopes the server, any other dim (ssg, dsm)
// is a client-side row filter on the Snapshot only.
//
// Staleness policy (shared by bridge drills and dissection): a panel
// keeps its last good render ONLY for the scope it was painted for. When the
// scope changes every "had good" flag is reset, so an empty or unavailable
// scope is shown as exactly that — never as "source busy". When the SAME scope
// fails to refresh, the panel dims and its label names the scope it is still
// showing. The mexp2 panels do the same through renderStale / setStatus.
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
  function M2() { return window.MEXP2 || null; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isYM(s) { return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s); }

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
    unit:     'kg',
    drill:    []            // [{dim, value, label}] — category-table crumbs (see header)
  };

  // Last fetched payloads — kept so unit toggle can re-render matrix without refetch.
  // hasCore = at least one successful phase-A render has painted (controls first-load
  // vs. non-destructive refresh). coreSig = param signature of the in-flight/last phase-A
  // fetch, used to suppress duplicate invocations for identical params.
  // core/diss = RAW phase-A envelope and RAW phase-B dissection block, each with the
  // signature it was fetched for and its last failure message (the mexp2 view model
  // is built from them). drillsGood = v1's bridge drill tables have painted FOR THE
  // CURRENT SCOPE (reset on scope change).
  var LAST = { matrix: null, fetchSeq: 0, hasCore: false, coreSig: null, coreInFlight: false,
               core: null, coreDataSig: null, coreErr: null,
               diss: null, dissSig: null, dissErr: null, dissInFlight: false,
               drillsGood: false };
  // The view model the mexp2 panels currently show, and the last good vm for a
  // DIFFERENT scope (what renderStaleAll prints while the new scope loads).
  var VM = null, VM_HINTS = null, PREV = null;
  var PANELS = [];          // MEXP2.adapter.panels() after mount
  var built = false, escBound = false;
  var TAB = 'trend';        // Drill Matrix box tab: 'trend' (by month) | 'snapshot'

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
  var GROUP_BY_LABEL = { bu: 'BU', region: 'Region', dsm: 'DSM', brand: 'Brand', species: 'Species',
                         sales_group: 'Sales Group', ssg: 'SSG', customer: 'Customer', sku: 'SKU' };
  // group_bys whose row-click re-scopes a filter (the actual drill)
  var DRILL_FILTER = { region: 'region', bu: 'bu', customer: 'customer' };

  // =========================================================================
  // STYLE + SKELETON (injected once)
  // =========================================================================
  var STYLE = [
    '<style id="mexp-style">',
    '.mexp-wrap{padding:18px 20px 40px;color:var(--text)}',
    '.mexp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}',
    '.mexp-title{font-size:20px;font-weight:900;letter-spacing:-.3px;color:var(--text);display:flex;align-items:center;gap:10px}',
    '.mexp-sub{font-size:11px;color:var(--text3);margin-top:3px;font-weight:600}',
    // updating pill (non-destructive refresh hint) + dim state
    '.mexp-pill{display:none;align-items:center;gap:6px;font-size:9px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:var(--gold);background:rgba(241,177,29,.12);border:1px solid rgba(241,177,29,.35);padding:3px 9px;border-radius:999px}',
    '.mexp-pill .mexp-dot{width:6px;height:6px;border-radius:50%;background:var(--gold);animation:mexppulse 1s infinite}',
    '@keyframes mexppulse{0%,100%{opacity:.35}50%{opacity:1}}',
    '#pg-margin-explorer .mexp-dim{opacity:.6;transition:opacity .15s;pointer-events:none}',
    // stale state (same scope failed to refresh): dimmed but still readable/clickable;
    // the panel's own label names the scope it is showing.
    '#pg-margin-explorer .mexp-stale{opacity:.55;transition:opacity .15s}',
    '#pg-margin-explorer .mexp-stale-note{font-size:10px;font-weight:700;color:var(--gold);line-height:1.5}',
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
    // 2-col body — Drill Matrix | Bridge, stretched to equal height so neither column
    // leaves a dead blank region; ingredient table sits full-width below. Each column
    // is a host: the mexp2 panel section (.mx2-panel, css/mexp2.css) is the box.
    '.mexp-body{display:grid;grid-template-columns:1.5fr 1fr;gap:16px;align-items:stretch;margin-bottom:16px}',
    '.mexp-host{min-width:0;display:flex;flex-direction:column}',
    '.mexp-host>.mx2-panel{flex:1 1 auto}',
    '.mexp-net-host{margin-top:16px}',
    '.mexp-panel{border:1px solid var(--glass-border);border-radius:var(--r-lg);background:var(--surface);padding:14px 16px}',
    '.mexp-ing-panel{margin-top:0}',
    '.mexp-panel-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
    '.mexp-panel-t{font-size:12px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}',
    '.mexp-panel-st{font-size:9.5px;font-weight:700;color:var(--text3);letter-spacing:.2px;margin-top:3px;line-height:1.45}',
    '.mexp-panel-hcol{display:flex;flex-direction:column;gap:0}',
    // --- Drill Matrix box tabs: "By month" (the mexp2 category table) | "Snapshot"
    // (v1's single-period matrix). The tab strip is the first child of the panel
    // section; while Snapshot is on, the panel's own children are hidden.
    '.mexp-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--glass-border);padding-bottom:8px;margin-bottom:2px}',
    '.mexp-tab{border:1px solid transparent;background:transparent;color:var(--text3);font-size:10.5px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;padding:6px 12px;border-radius:8px;cursor:pointer}',
    '.mexp-tab:hover{color:var(--text)}',
    '.mexp-tab.on{color:var(--text);background:rgba(255,255,255,.05);border-color:var(--glass-border)}',
    '.mexp-snapshot{display:none;flex-direction:column;gap:10px;min-width:0;flex:1 1 auto}',
    '.mx2-panel.mexp-tab-snapshot>*:not(.mexp-tabs):not(.mexp-snapshot){display:none!important}',
    '.mx2-panel.mexp-tab-snapshot>.mexp-snapshot{display:flex}',
    '.mexp-snapshot-note{font-size:10px;font-weight:700;color:var(--text3);border:1px solid var(--glass-border);border-radius:8px;padding:5px 10px}',
    // --- reconciling drill tables under the bridge (Cost components + Product Mix by SSG) ---
    // Two compact tables, side-by-side, each tied to its parent bar. tabular-nums,
    // thin separators, negatives red. Footer line proves Σ === the bridge bar.
    '#pg-margin-explorer .mexp-drills{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px;padding-top:12px;border-top:1px solid var(--glass-border)}',
    '#pg-margin-explorer .mexp-drill{min-width:0}',
    '#pg-margin-explorer .mexp-drill-h{font-size:9px;font-weight:900;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);margin-bottom:6px;display:flex;align-items:center;gap:5px}',
    '#pg-margin-explorer .mexp-drill-h b{color:var(--text2);font-weight:900}',
    '#pg-margin-explorer .mexp-drill-tbl{width:100%;border-collapse:collapse;font-size:10.5px;font-variant-numeric:tabular-nums}',
    '#pg-margin-explorer .mexp-drill-tbl td{padding:2.5px 0;border-bottom:1px solid rgba(255,255,255,.045);white-space:nowrap}',
    '#pg-margin-explorer .mexp-drill-tbl td.mexp-dl{text-align:left;color:var(--text2);font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis}',
    '#pg-margin-explorer .mexp-drill-tbl td.mexp-dv{text-align:right;color:var(--text);font-weight:700;padding-left:10px}',
    '#pg-margin-explorer .mexp-drill-tbl td.mexp-dv.neg{color:var(--red)}',
    '#pg-margin-explorer .mexp-drill-tbl td.mexp-dv.pos{color:var(--green)}',
    '#pg-margin-explorer .mexp-drill-tbl td.mexp-ds{text-align:right;color:var(--text3);font-weight:600;padding-left:10px;width:42px}',
    '#pg-margin-explorer .mexp-drill-tbl tr.mexp-drill-foot td{border-top:1px solid var(--glass-border);border-bottom:none;padding-top:5px;font-weight:900;color:var(--text)}',
    '#pg-margin-explorer .mexp-drill-tbl tr.mexp-drill-foot td.mexp-dl{color:var(--text2);text-transform:uppercase;letter-spacing:.3px;font-size:9px}',
    '#pg-margin-explorer .mexp-drill-tbl tr.mexp-drill-foot td .mexp-tick{color:var(--green);margin-left:5px}',
    '@media(max-width:1180px){#pg-margin-explorer .mexp-drills{grid-template-columns:1fr}}',
    // national tag on the ingredient table (production lens — not filtered by region/bu)
    '.mexp-natl-tag{font-size:9px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);border:1px solid var(--glass-border);border-radius:6px;padding:2px 7px;white-space:nowrap}',
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

  function buildSkeleton() {
    var root = $('pg-margin-explorer');
    if (!root) { console.warn('[MEXP] #pg-margin-explorer not found'); return false; }

    var html = STYLE +
      '<div class="mexp-wrap">' +
        '<div class="mexp-head">' +
          '<div>' +
            '<div class="mexp-title">Margin Explorer' +
              '<span class="mexp-pill" id="mexp-updating"><span class="mexp-dot"></span>Updating</span>' +
            '</div>' +
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

        // ---- hero KPIs (four cards; the fifth slot, "GM / kg net of discount",
        //      is filled in a later phase and stays hidden until then) ----
        '<div class="mexp-hero">' +
          heroCard('net',   'Net Sales') +
          heroCard('gp',    'Gross Profit') +
          heroCard('gppct', 'GP %') +
          heroCard('gmkg',  'GM / kg') +
          '<div class="mexp-kpi" id="mexp-hero-gmkgnet-card" style="display:none"></div>' +
        '</div>' +
        '<div class="mexp-note" id="mexp-hero-note" style="display:none"></div>' +

        // ---- 2-col body: Drill Matrix box | GM Bridge box (balanced heights) ----
        // Each column hosts one mexp2 panel section (mounted by mountPanels).
        '<div class="mexp-body">' +
          '<div class="mexp-host" id="mexp-matrix-host"></div>' +
          '<div class="mexp-host" id="mexp-bridge-host"></div>' +
        '</div>' +
        // ---- ingredient cost / movers — full width below (5-col table reads better wide) ----
        '<div class="mexp-panel mexp-ing-panel">' +
          '<div class="mexp-coming" id="mexp-movers">Movers &amp; gap analysis — coming in Phase 2</div>' +
        '</div>' +
        // ---- NET bridge section — the mexp2 "netbridge" panel (same SVG, same
        //      scale as the reported bridge, strip + drivers), mounted by mountPanels ----
        '<div class="mexp-host mexp-net-host" id="mexp-net-host"></div>' +
      '</div>';

    root.innerHTML = html;
    mountPanels();
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
  // THE TWO mexp2 BOXES
  // =========================================================================
  // Mount the category-by-month table into the left column, the reported
  // bridge into the right one and the net bridge into the bottom section, then
  // graft the v1 pieces onto their frames: the Snapshot tab (single-period
  // matrix) on the left, the two reconciling drill tables under the bridge on
  // the right.
  function mountPanels() {
    var ns = M2();
    if (!ns || !ns.adapter || typeof ns.adapter.mountPanels !== 'function') {
      var h = $('mexp-matrix-host'); if (h) h.innerHTML = '<div class="mexp-error">Margin Explorer modules (MEXP2) are not loaded.</div>';
      return;
    }
    // THE scope mechanism, installed on the adapter seam the panels dispatch through.
    ns.adapter.applyScope = applyScope;
    PANELS = ns.adapter.mountPanels({ trendmatrix: $('mexp-matrix-host'), bridge: $('mexp-bridge-host'), netbridge: $('mexp-net-host') }, ['trendmatrix', 'bridge', 'netbridge']);
    graftSnapshotTab();
    graftBridgeDrills();
  }

  function panelHost(id) {
    for (var i = 0; i < PANELS.length; i++) if (PANELS[i].id === id) return PANELS[i].host;
    return null;
  }

  // The Snapshot tab: same box as the category table, second tab. The tab strip
  // goes first in the panel, the snapshot body last; CSS hides the panel's own
  // children while the snapshot is on.
  function graftSnapshotTab() {
    var sec = panelHost('trendmatrix');
    if (!sec) return;
    var tabs = document.createElement('div');
    tabs.className = 'mexp-tabs';
    tabs.innerHTML = '<button type="button" class="mexp-tab on" data-mexp-tab="trend">By month</button>' +
      '<button type="button" class="mexp-tab" data-mexp-tab="snapshot">Snapshot</button>';
    sec.insertBefore(tabs, sec.firstChild);
    var snap = document.createElement('div');
    snap.className = 'mexp-snapshot';
    snap.id = 'mexp-snapshot';
    snap.innerHTML = '<div id="mexp-matrix"><div class="mexp-loading">Loading…</div></div>';
    sec.appendChild(snap);
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mexp-tab]') : null;
      if (!b) return;
      setTab(b.getAttribute('data-mexp-tab'));
    });
  }
  function setTab(t) {
    var sec = panelHost('trendmatrix');
    if (!sec) return;
    TAB = (t === 'snapshot') ? 'snapshot' : 'trend';
    if (TAB === 'snapshot') sec.classList.add('mexp-tab-snapshot'); else sec.classList.remove('mexp-tab-snapshot');
    var bs = sec.querySelectorAll('.mexp-tab');
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].getAttribute('data-mexp-tab') === TAB) bs[i].classList.add('on'); else bs[i].classList.remove('on');
    }
  }

  // v1's two reconciling drill tables, appended at the bottom of the bridge box.
  function graftBridgeDrills() {
    var sec = panelHost('bridge');
    if (!sec) return;
    var box = document.createElement('div');
    box.id = 'mexp-bridge-drills';
    box.className = 'mexp-drills';
    box.style.display = 'none';
    sec.appendChild(box);
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

    var asof = $('mexp-asof');
    if (asof) asof.addEventListener('change', function () {
      // 'live' clears ref_month so the API anchors on real today.
      applyScope({ refMonth: (asof.value && asof.value !== 'live') ? asof.value : null });
    });

    var cust = $('mexp-customer');
    if (cust) {
      var t = null;
      cust.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var v = cust.value.replace(/^\s+|\s+$/g, '');
          applyScope({ customer: v || null });
        }, 450);
      });
    }

    // ONE document-level Escape handler, for one thing only: clearing the
    // category table's client-side crumbs (ssg / dsm — the matrix-local filter).
    // Server-tier crumbs and the page filters are untouched; when there is
    // nothing to clear the event is left alone for the shell.
    if (!escBound) {
      escBound = true;
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' && ev.key !== 'Esc' && ev.keyCode !== 27) return;
        var page = $('pg-margin-explorer');
        if (!page || !page.classList.contains('active')) return;
        var keep = [], i;
        for (i = 0; i < STATE.drill.length; i++) if (DRILL_FILTER[STATE.drill[i].dim]) keep.push(STATE.drill[i]);
        if (keep.length === STATE.drill.length) return;
        ev.stopPropagation(); ev.preventDefault();
        applyScope({ drill: keep });
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
    if (group === 'unit') { applyScope({ unit: val }); return; }          // display-only — no refetch
    if (group === 'period') { applyScope({ period: val }); return; }
    if (group === 'region') { applyScope({ region: val, drill: [] }); return; }
    if (group === 'bu') { applyScope({ bu: val, drill: [] }); return; }
    if (group === 'compare') { applyScope({ compare: val }); return; }
  }

  function clearFilters() {
    // unit + group_by are view prefs — keep them.
    applyScope({ region: 'ALL', bu: 'ALL', customer: null, compare: 'pp', drill: [] });
  }

  // Reflect STATE on every control (chips, inputs).
  function reflectControls() {
    setChipActive('period', STATE.period);
    setChipActive('region', STATE.region);
    setChipActive('bu', STATE.bu);
    setChipActive('compare', STATE.compare);
    setChipActive('unit', STATE.unit);
    var cust = $('mexp-customer');
    if (cust && document.activeElement !== cust) cust.value = STATE.customer || '';
    var asof = $('mexp-asof');
    if (asof) asof.value = STATE.ref_month || 'live';
  }

  // =========================================================================
  // THE ONE SCOPE MECHANISM
  // =========================================================================
  function copyCrumbs(list) {
    var out = [], i, c;
    if (!list || typeof list.length !== 'number') return out;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (!c || c.dim == null || c.value == null) continue;
      out.push({ dim: String(c.dim), value: String(c.value), label: c.label == null ? String(c.value) : String(c.label) });
    }
    return out;
  }
  function crumbOf(list, dim) { for (var i = 0; i < list.length; i++) if (list[i].dim === dim) return list[i]; return null; }
  function normRegion(v) {
    var s = String(v == null ? '' : v);
    for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].v.toLowerCase() === s.toLowerCase()) return REGIONS[i].v;
    return 'ALL';
  }
  function inList(items, v) { for (var i = 0; i < items.length; i++) if (items[i].v === v) return true; return false; }

  // applyScope(patch): contract-named fields -> STATE. A server-tier crumb
  // (region / bu / customer) that enters the path sets its filter; one that
  // leaves the path resets it. Refetch only when the server scope changed.
  function applyScope(patch) {
    patch = patch || {};
    var before = scopeSig(), i, c, old, next, prevCrumb, gone;

    if (hasOwn(patch, 'period') && inList(PERIODS, patch.period)) STATE.period = patch.period;
    if (hasOwn(patch, 'refMonth')) STATE.ref_month = isYM(patch.refMonth) ? patch.refMonth : undefined;
    if (hasOwn(patch, 'region')) STATE.region = normRegion(patch.region);
    if (hasOwn(patch, 'bu')) STATE.bu = (patch.bu == null || String(patch.bu).toUpperCase() === 'ALL') ? 'ALL' : String(patch.bu);
    if (hasOwn(patch, 'customer')) STATE.customer = (patch.customer == null || patch.customer === '') ? undefined : String(patch.customer);
    if (hasOwn(patch, 'compare')) STATE.compare = (patch.compare === 'ly') ? 'ly' : 'pp';
    if (hasOwn(patch, 'groupBy') && GROUP_BY_LABEL[patch.groupBy]) STATE.group_by = patch.groupBy;
    if (hasOwn(patch, 'unit') && inList(UNITS, patch.unit)) STATE.unit = patch.unit;
    if (hasOwn(patch, 'drill')) {
      old = STATE.drill; next = copyCrumbs(patch.drill);
      // crumbs that left the path: reset the server filter they carried
      for (i = 0; i < old.length; i++) {
        c = old[i]; if (!DRILL_FILTER[c.dim]) continue;
        gone = !crumbOf(next, c.dim) || crumbOf(next, c.dim).value !== c.value;
        if (!gone) continue;
        if (c.dim === 'region') STATE.region = 'ALL';
        else if (c.dim === 'bu') STATE.bu = 'ALL';
        else if (c.dim === 'customer') STATE.customer = undefined;
      }
      // crumbs that entered the path: set the filter they name
      for (i = 0; i < next.length; i++) {
        c = next[i]; if (!DRILL_FILTER[c.dim]) continue;
        prevCrumb = crumbOf(old, c.dim);
        if (prevCrumb && prevCrumb.value === c.value) continue;
        if (c.dim === 'region') STATE.region = normRegion(c.value);
        else if (c.dim === 'bu') STATE.bu = c.value;
        else if (c.dim === 'customer') STATE.customer = c.value;
      }
      STATE.drill = next;
    }
    reflectControls();
    if (scopeSig() !== before) { fetchAndRender(); return true; }
    // display-only: the Snapshot repaints; the mexp2 panels only when the crumbs moved
    renderMatrixOnly();
    if (hasOwn(patch, 'drill')) renderPanelsView();
    return true;
  }

  // Same data, new crumbs: hand the mexp2 panels the view model again. Only a
  // phase whose data for THIS scope has landed is repainted: a phase still in
  // flight keeps its stale render (or skeleton) untouched.
  function renderPanelsView() {
    var ns = M2();
    if (!ns || !ns.adapter || !VM) return;
    buildVm({ coreLoading: LAST.coreInFlight, dissLoading: LAST.dissInFlight, coreError: LAST.coreErr, dissError: LAST.dissErr });
    var hasCore = VM.core != null, hasDiss = VM.diss != null;
    try {
      if (hasCore && hasDiss) ns.adapter.renderAll(VM, VM_HINTS);
      else if (hasCore) ns.adapter.renderAll(VM, VM_HINTS, 'core');
      else if (hasDiss) ns.adapter.renderAll(VM, VM_HINTS, 'diss');
    } catch (e) { console.error('[MEXP] renderAll (view):', e); }
    badgePanels();
  }

  // =========================================================================
  // FETCH + RENDER
  // =========================================================================
  // Phase-A (fast core) and phase-B (slow dissection) share these scope params.
  // include is appended per-phase so the heavy cross-DB cube only loads in phase B.
  function baseParams() {
    var p = {
      period:   STATE.period,
      region:   STATE.region,
      bu:       STATE.bu,
      group_by: STATE.group_by,
      compare:  STATE.compare
    };
    if (STATE.ref_month) p.ref_month = STATE.ref_month;
    if (STATE.customer)  p.customer = STATE.customer;
    return p;
  }
  // "bridge" stays in the include list: the phase-A bridge is not drawn, but its
  // ingredients / ingredients_meta feed the Ingredient Cost table. "trend" has
  // no renderer on this page, so it is not requested.
  function coreParams() {
    var p = baseParams();
    p.include = 'bridge,movers,gap';
    return p;
  }
  function dissectionParams() {
    var p = baseParams();
    p.include = 'dissection';
    return p;
  }
  // Stable signature of the scope (ignores _t cache-buster + include) so we can
  // detect a duplicate phase-A fetch for params already in flight / just rendered.
  function scopeSig() {
    var b = baseParams();
    return [b.period, b.region, b.bu, b.group_by, b.compare, b.ref_month || '', b.customer || ''].join('|');
  }
  // Human label of the current scope — printed by every panel that keeps a stale
  // render, so "showing X" always names X. e.g. "QTD · Luzon · Distribution".
  function scopeLabel() {
    var bits = [STATE.period];
    if (STATE.ref_month) bits.push('as of ' + STATE.ref_month);
    bits.push(STATE.region !== 'ALL' ? STATE.region : 'All regions');
    if (STATE.bu !== 'ALL') bits.push(STATE.bu);
    if (STATE.customer) bits.push('customer "' + STATE.customer + '"');
    return bits.join(' · ');
  }
  // The scope in the contract's names, for the view model.
  function scopeForVm() {
    return { period: STATE.period, ref_month: STATE.ref_month || null, region: STATE.region, bu: STATE.bu,
             customer: STATE.customer || null, group_by: STATE.group_by, compare: STATE.compare, unit: STATE.unit,
             drill: copyCrumbs(STATE.drill) };
  }
  // Scope changed: forget every "last good" so the new scope is judged on its own.
  function resetStaleGuards() {
    LAST.drillsGood = false;
    var box = $('mexp-bridge-drills');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    if (typeof window.MEXP_resetDissection === 'function') { try { window.MEXP_resetDissection(); } catch (e) {} }
  }

  // -- View model for the two mexp2 boxes -------------------------------------
  function buildVm(h) {
    var ns = M2(), sig = scopeSig();
    if (!ns || !ns.adapter) return null;
    var core = (LAST.core && LAST.coreDataSig === sig) ? LAST.core : null;
    var diss = (LAST.diss && LAST.dissSig === sig) ? LAST.diss : null;
    VM_HINTS = { coreLoading: !!h.coreLoading, dissLoading: !!h.dissLoading,
                 coreError: h.coreError || null, dissError: h.dissError || null,
                 scope: scopeForVm(), prev: PREV };
    VM = ns.adapter.vmFromV1(core, diss, sig, scopeLabel(), VM_HINTS);
    return VM;
  }
  // A panel that cannot apply a client-side crumb (the bridge) says so at the
  // top of its box: it shows the server scope. Text only, by DOM membership.
  function badgePanels() {
    var client = [], i, p, b, txt;
    for (i = 0; i < STATE.drill.length; i++) if (!DRILL_FILTER[STATE.drill[i].dim]) client.push(STATE.drill[i]);
    for (i = 0; i < PANELS.length; i++) {
      p = PANELS[i];
      b = p.host.querySelector(':scope > .mx2-unscoped');
      if (!client.length || (p.inst && p.inst.drillAware === true)) { if (b) p.host.removeChild(b); continue; }
      if (!b) { b = document.createElement('div'); b.className = 'mx2-unscoped'; p.host.insertBefore(b, p.host.firstChild); }
      txt = 'Not scoped to ';
      txt += client.map(function (c) { return (GROUP_BY_LABEL[c.dim] || c.dim) + ': ' + c.label; }).join(', ');
      txt += ' — a client-side filter on the category table and the Snapshot only; this panel shows the server scope';
      b.textContent = txt;
    }
  }

  // -- Loading-state helpers (non-destructive) -------------------------------
  // First load (no prior render): show the big loader in the matrix slot.
  // Refilter (prior render exists): keep the last good content, dim the v1 parts
  // and flip on a small "updating…" pill in the header — never blank good data.
  // (The two mexp2 boxes carry their own loading chrome through setStatusAll.)
  function setUpdating(on) {
    var pill = $('mexp-updating');
    var els = [$('mexp-matrix'), $('mexp-bridge-drills'), $('mexp-diss')];
    if (pill) {
      // showError() may have replaced the pill text with "⚠ update failed" (and
      // destroyed the dot) — rebuild the markup every time it goes back on.
      if (on) pill.innerHTML = '<span class="mexp-dot"></span>Updating';
      pill.style.display = on ? 'inline-flex' : 'none';
    }
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      if (on) els[i].classList.add('mexp-dim'); else els[i].classList.remove('mexp-dim');
    }
  }
  function showFirstLoad() {
    var m = $('mexp-matrix');
    if (m) m.innerHTML = '<div class="mexp-loading">Loading margin data…</div>';
  }
  function showError(msg) {
    var m = $('mexp-matrix');
    // Only clobber the matrix with an error if there is nothing good to keep.
    if (m && !LAST.hasCore) m.innerHTML = '<div class="mexp-error">Could not load margin data.<br>' + _esc(msg) + '</div>';
    else {
      var pill = $('mexp-updating');
      if (pill) { pill.textContent = '⚠ update failed'; pill.style.display = 'inline-flex'; }
    }
  }

  // Public entry for any filter change. Bumps ONE sequence that supersedes BOTH
  // phases of any in-flight load, then kicks off phase A (which chains phase B).
  function fetchAndRender() {
    if (typeof window.apiFetch !== 'function') { showError('apiFetch unavailable.'); return; }
    var ns = M2(), A = ns && ns.adapter, C = ns && ns.C;

    var sig = scopeSig();
    // Double-invocation guard: identical scope already fetching phase A → no-op.
    if (LAST.coreInFlight && LAST.coreSig === sig) return;

    var changed = (LAST.coreSig !== null && LAST.coreSig !== sig);
    if (changed) {
      // Scope changed → no v1 panel may keep a "last good" from the previous scope,
      // and the mexp2 boxes keep the previous scope's data ONLY through renderStale.
      resetStaleGuards();
      if (VM && VM.core) PREV = { key: VM.key, label: VM.label, core: VM.core, diss: VM.diss };
    }

    var seq = ++LAST.fetchSeq;     // supersedes any older phase A AND phase B
    LAST.coreSig = sig;
    LAST.coreInFlight = true;

    if (LAST.hasCore) setUpdating(true);   // keep prior render, show subtle hint
    else showFirstLoad();                  // very first paint — big loader ok

    if (A && C) {
      buildVm({ coreLoading: true, dissLoading: true });
      try {
        if (changed && PREV) { A.renderStaleAll(PREV, VM); A.setStatusAll(C.STATE.LOADING_REFRESH); }
        else if (VM && VM.core) A.setStatusAll(C.STATE.LOADING_REFRESH);
        else A.setStatusAll(C.STATE.LOADING_FIRST);
      } catch (e) { console.error('[MEXP] stale/loading paint:', e); }
    }
    fetchCore(seq);
  }

  // ---- Phase A: fast core (hero, window, matrix, bridge ingredients, movers) ----
  // (promise chains, not async/await — the page is ES5 like the shell.)
  function fetchCore(seq) {
    var p;
    try { p = Promise.resolve(window.apiFetch('margin-explorer', coreParams())); }
    catch (e) { p = Promise.reject(e); }
    p.then(function (data) {
      if (seq !== LAST.fetchSeq) return;              // stale — abandon silently
      LAST.coreInFlight = false;
      if (!data) { LAST.coreErr = 'Empty response.'; setUpdating(false); showError('Empty response.'); markErrored('core'); return; }

      LAST.matrix = data.matrix || null;
      LAST.core = data; LAST.coreDataSig = LAST.coreSig; LAST.coreErr = null;

      try { renderWindow(data.meta); } catch (e) { console.error('[MEXP] window:', e); }
      try { renderHero(data.hero); }   catch (e) { console.error('[MEXP] hero:', e); }
      try { renderMatrixOnly(); }      catch (e) { console.error('[MEXP] matrix:', e); }
      // The ONE bridge is canonical_bridge (phase B). Phase A no longer paints a
      // competing bridge — the bridge box keeps its loading state until phase B lands.
      try { renderMovers(data.movers, data.gap, data.bridge && data.bridge.ingredients, data.bridge && data.bridge.ingredients_meta); } catch (e) { console.error('[MEXP] movers:', e); }

      LAST.hasCore = true;
      setUpdating(false);

      // Both mexp2 boxes are phase B: they keep their stale / loading state
      // until the dissection lands. Chain phase B (slow) under the SAME seq,
      // so a newer phase A abandons it.
      fetchDissection(seq);
    }, function (err) {
      if (seq !== LAST.fetchSeq) return;            // a newer action superseded us
      LAST.coreInFlight = false;
      LAST.coreErr = (err && err.message) ? err.message : 'Request failed.';
      console.error('[MEXP] core fetch error:', err);
      setUpdating(false);
      showError(LAST.coreErr);
      markErrored('core');
    });
  }

  // ---- Phase B: lazy dissection (bridge, net bridge, category table, dissection) ----
  function fetchDissection(seq) {
    // subtle updating state on the dissection block only (core already painted)
    if (typeof window.MEXP_setDissectionUpdating === 'function') {
      try { window.MEXP_setDissectionUpdating(true); } catch (e) {}
    }
    var p;
    LAST.dissInFlight = true;
    try { p = Promise.resolve(window.apiFetch('margin-explorer', dissectionParams())); }
    catch (e) { p = Promise.reject(e); }
    p.then(function (data) {
      if (seq !== LAST.fetchSeq) return;              // a newer phase A started — abandon
      LAST.dissInFlight = false;
      LAST.diss = (data && data.dissection) || null; LAST.dissSig = LAST.coreSig; LAST.dissErr = null;
      if (typeof window.MEXP_setDissectionUpdating === 'function') {
        try { window.MEXP_setDissectionUpdating(false); } catch (e) {}
      }
      renderPhaseB(data && data.dissection, null);
    }, function (err) {
      if (seq !== LAST.fetchSeq) return;            // superseded
      LAST.dissInFlight = false;
      LAST.dissErr = (err && err.message) ? err.message : 'Request failed.';
      console.error('[MEXP] dissection fetch error:', err);
      if (typeof window.MEXP_setDissectionUpdating === 'function') {
        try { window.MEXP_setDissectionUpdating(false); } catch (e) {}
      }
      // A failed request is a real outage: every phase-B panel gets to say so
      // (dim + "source busy — showing <scope>" if it has this scope, else the error).
      renderPhaseB(null, LAST.dissErr);
    });
  }

  // On error: status chrome only — never wipe the current-key content.
  function markErrored(phase) {
    var ns = M2();
    if (!ns || !ns.adapter || !ns.C) return;
    try { ns.adapter.setStatusAll(ns.C.STATE.ERRORED, phase === 'diss' ? 'diss' : undefined); } catch (e) {}
  }

  // Fan phase B out: the v1 panels get the raw block; the two mexp2 boxes get a
  // rebuilt view model. `diss` may be null (fetch failed → errMsg set, or the
  // server returned no dissection block) or { available:false, reason }.
  function renderPhaseB(diss, errMsg) {
    var label = scopeLabel();
    var unavailable = null;
    if (errMsg) unavailable = { available: false, reason: errMsg, error: true };
    else if (!diss) unavailable = { available: false, reason: 'No dissection block returned for this scope.' };
    else if (diss.available === false) unavailable = { available: false, reason: diss.reason || 'No finished-feed data for this selection.' };

    // The reconciling drills under the bridge — fed by phase B's canonical_bridge.
    try { renderCanonicalDrills(unavailable || diss.canonical_bridge || { available: false, reason: 'No exact bridge returned for this scope.' }); }
    catch (e) { console.error('[MEXP] bridge drills:', e); }
    try { if (typeof window.MEXP_renderDissection === 'function') window.MEXP_renderDissection(unavailable || diss, label); } catch (e) { console.error('[MEXP] dissection:', e); }

    // the three mexp2 boxes (bridge, net bridge section, category table)
    var ns = M2();
    if (!ns || !ns.adapter) return;
    if (errMsg) { buildVm({ dissError: errMsg }); markErrored('diss'); return; }
    buildVm({});
    try { ns.adapter.renderAll(VM, VM_HINTS); } catch (e) { console.error('[MEXP] renderAll:', e); }
    badgePanels();
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

  // The Snapshot tab: the single-period drill matrix, with the category table's
  // client-side crumb applied when its dim is the current group_by.
  function renderMatrixOnly() {
    var el = $('mexp-matrix');
    if (!el) return;
    if (!LAST.matrix) { el.innerHTML = '<div class="mexp-loading">No data.</div>'; return; }
    if (typeof window.MEXP_renderMatrix !== 'function') {
      el.innerHTML = '<div class="mexp-error">Matrix renderer unavailable.</div>';
      return;
    }
    var m = LAST.matrix, rows = m.rows || [], gb = m.group_by || STATE.group_by, crumb = null, i, note = '';
    for (i = 0; i < STATE.drill.length; i++) if (!DRILL_FILTER[STATE.drill[i].dim] && STATE.drill[i].dim === gb) crumb = STATE.drill[i];
    if (crumb) {
      var kept = [];
      for (i = 0; i < rows.length; i++) if (String(rows[i].dim) === crumb.value) kept.push(rows[i]);
      note = 'Filtered client-side to ' + (GROUP_BY_LABEL[gb] || gb) + ': ' + crumb.label + ' — ' + kept.length + ' of ' + rows.length + ' rows; the server scope is unchanged. Esc clears.';
      m = { group_by: gb, total_gp: m.total_gp, rows: kept };
    }
    el.innerHTML = '';
    if (note) { var n = document.createElement('div'); n.className = 'mexp-snapshot-note'; n.textContent = note; el.appendChild(n); }
    var box = document.createElement('div');
    el.appendChild(box);
    window.MEXP_renderMatrix(box, m, {
      unit: STATE.unit,
      selectedDim: selectedDimFor(),
      onRowClick: onRowClick,
      onGroupByChange: onGroupByChange
    });
  }

  // The currently "selected" dim is whichever filter the active group_by maps to,
  // or the client-side crumb on that group_by.
  function selectedDimFor() {
    var f = DRILL_FILTER[STATE.group_by], c;
    if (f === 'region') return STATE.region !== 'ALL' ? STATE.region : null;
    if (f === 'bu')     return STATE.bu !== 'ALL' ? STATE.bu : null;
    if (f === 'customer') return STATE.customer || null;
    c = crumbOf(STATE.drill, STATE.group_by);
    return c ? c.value : null;
  }

  function onGroupByChange(newGroupBy) {
    if (!newGroupBy || newGroupBy === STATE.group_by) return;
    applyScope({ groupBy: newGroupBy });
  }

  function onRowClick(row) {
    if (!row || row.dim == null) return;
    var filterKey = DRILL_FILTER[STATE.group_by];
    if (!filterKey) {
      // deeper drill = Phase 2; matrix renderer handles highlight itself.
      return;
    }
    // Set the matching filter to the clicked dim and re-scope hero+bridge.
    var patch = {};
    patch[filterKey] = row.dim;
    applyScope(patch);
  }

  // ---- The reconciling drills under the bridge (phase B). Staleness policy:
  // good drills are kept only for the scope they were drawn for (LAST.drillsGood
  // is reset on every scope change). Same scope, refresh failed → keep them.
  // New scope, nothing → hidden (the bridge box itself prints the reason). ----
  function renderCanonicalDrills(cb) {
    if (!cb) cb = { available: false };
    if (cb.available === false) {
      if (LAST.drillsGood && cb.error) return;      // same scope, transport failure: keep
      LAST.drillsGood = false;
      renderBridgeDrills(null);
      return;
    }
    renderBridgeDrills(cb);
    LAST.drillsGood = true;
  }

  // Reconciling drills under the bridge: Cost → RM/Packaging/Feedtag (Σ === Cost bar)
  // and Product Mix → by SSG (Σ === Product Mix bar). Each footer proves the tie.
  function renderBridgeDrills(cb) {
    var box = $('mexp-bridge-drills');
    if (!box) return;
    if (!cb || cb.available === false) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var fmtD = function (n) { n = Math.round(+n || 0); var s = '₱' + Math.abs(n).toLocaleString() + '/t'; return n > 0 ? '+' + s : (n < 0 ? '−' + s : s); };
    var cls = function (n) { return (+n > 0 ? 'pos' : (+n < 0 ? 'neg' : '')); };
    var rows = function (items) {
      // share of GROSS contribution (Σ|value|) so mixed +/− categories read sensibly
      // (a net bar of −77 can have individual gross moves far larger than 77).
      var t = items.reduce(function (s, x) { return s + Math.abs(+x.value || 0); }, 0) || 1;
      return items.map(function (it) {
        var v = +it.value || 0, sh = Math.round(Math.abs(v) / t * 100);
        return '<tr><td class="mexp-dl" title="' + _esc(it.label) + '">' + _esc(it.label) + '</td>' +
          '<td class="mexp-dv ' + cls(v) + '">' + fmtD(v) + '</td>' +
          '<td class="mexp-ds">' + sh + '%</td></tr>';
      }).join('');
    };
    var foot = function (label, val, items, barTotal) {
      // tolerance scales with item count — each row is rounded to ₱1, so N rows can
      // drift up to ~N from the (also-rounded) bar total without being a real break.
      var tie = Math.abs(items.reduce(function (s, x) { return s + (+x.value || 0); }, 0) - (+barTotal || 0)) <= Math.max(1.5, items.length);
      return '<tr class="mexp-drill-foot"><td class="mexp-dl">= ' + label + '</td>' +
        '<td class="mexp-dv ' + cls(val) + '">' + fmtD(val) + (tie ? '<span class="mexp-tick">✓</span>' : '') + '</td>' +
        '<td class="mexp-ds"></td></tr>';
    };
    var html = '';
    if (cb.cost_components) {
      var cc = cb.cost_components;
      var citems = [
        { label: 'Raw materials', value: cc.rm },
        { label: 'Packaging', value: cc.packaging },
        { label: 'Feedtag', value: cc.feedtag }
      ].filter(function (x) { return Math.round(+x.value || 0) !== 0; });
      if (citems.length) {
        html += '<div class="mexp-drill"><div class="mexp-drill-h"><b>Cost</b> → RM / Packaging / Feedtag</div>' +
          '<table class="mexp-drill-tbl"><tbody>' + rows(citems) +
          foot('Cost', cb.cost, citems, cb.cost) + '</tbody></table></div>';
      }
    }
    if (cb.product_mix_by_ssg && cb.product_mix_by_ssg.length) {
      var pitems = cb.product_mix_by_ssg.map(function (x) { return { label: x.ssg, value: x.value }; });
      html += '<div class="mexp-drill"><div class="mexp-drill-h"><b>Product Mix</b> → by category (SSG)</div>' +
        '<table class="mexp-drill-tbl"><tbody>' + rows(pitems) +
        foot('Product Mix', cb.product_mix, pitems, cb.product_mix) + '</tbody></table></div>';
    }
    if (html) { box.innerHTML = html; box.style.display = 'grid'; }
    else { box.style.display = 'none'; box.innerHTML = ''; }
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
      el.innerHTML = '<div class="mexp-panel-h"><span class="mexp-panel-t">Ingredient Cost / Ton of Feed</span>' +
        '<span class="mexp-natl-tag" title="Production lens — recipe-weighted national ingredient cost. Does not respond to the Region/BU filter.">National — not filtered by Region/BU</span></div>' +
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

  // ---- AI read digest: what is on screen (the view model the two boxes show,
  // plus the raw phase-B blocks the v1 panels show). Consumed by the AI read
  // button in the dissection block (margin-explorer-dissection.js). ----
  function pick(o, keys) {
    var out = {}, i;
    if (!o || typeof o !== 'object') return null;
    for (i = 0; i < keys.length; i++) if (o[keys[i]] !== undefined) out[keys[i]] = o[keys[i]];
    return out;
  }
  window.MEXP_aiDigest = function MEXP_aiDigest() {
    var vm = VM || {}, core = vm.core || null, diss = (vm.diss && vm.diss.available === true) ? vm.diss : null;
    if (!core) return null;
    var hero = core.hero, ov = core.discount_overlay, br = core.bridge;
    var cb = diss && diss.canonical_bridge, nb = diss && diss.net_bridge, ct = diss && diss.category_trend;
    var BR = ['base_month', 'compare_month', 'compare_partial', 'like_for_like', 'prior_gm_ton', 'current_gm_ton', 'delta', 'price', 'cost', 'customer_mix', 'product_mix', 'mix_total', 'note'];
    return {
      scope: vm.label, drill: copyCrumbs(STATE.drill),
      applied_filters: core.meta && core.meta.applied_filters,
      basis: 'sales / GP figures are gross of the off-invoice document discount (OINV.DiscSum); "net" = net of that discount. Hero universe (103,105,102) and dissection universe (103, credit notes netted) do not tie out.',
      headline: hero ? {
        baseline: hero.compare_window, compare_basis: hero.compare_basis,
        net_sales: hero.net_sales, gross_profit: hero.gross_profit, gp_pct: hero.gp_pct, gm_per_kg_reported: hero.gm_per_kg,
        discount_overlay: pick(ov, ['gm_per_kg_reported', 'gm_per_kg_net_of_discount', 'discount_per_kg', 'discount_total', 'discount_pct_of_reported_gm', 'delta_reported', 'delta_net_of_discount'])
      } : null,
      anchors: diss ? { base_month: diss.base_month, compare_month: diss.compare_month, compare_partial: diss.compare_partial, window: diss.window } : null,
      bridge_reported: (cb && cb.available === true) ? pick(cb, BR.concat(['cost_components', 'product_mix_by_ssg'])) : null,
      bridge_net: (nb && nb.available === true) ? pick(nb, BR.concat(['discount', 'vs_reported'])) : null,
      trust: (cb && cb.available === true) ? {
        sign_stable: cb.mix_ordering && cb.mix_ordering.sign_stable, mix_ranges: cb.mix_ordering && pick(cb.mix_ordering, ['customer_range', 'product_range']),
        churn_dominated: cb.mix_detail && cb.mix_detail.churn_dominated, mix_detail: pick(cb.mix_detail, ['one_sided_share_pct', 'matched_kg_share_pct']),
        significance: cb.significance
      } : null,
      lenses_net: (nb && nb.available === true && nb.lenses) ? { customer: nb.lenses.customer, ssg: nb.lenses.ssg } : null,
      category_trend: (ct && ct.available === true) ? {
        months: ct.months, partial_month: ct.partial_month, note: ct.note,
        categories: (ct.categories || []).map(function (c) { return { ssg: c.ssg, total_tons: c.total_tons, cells: c.cells }; }),
        avg: ct.avg
      } : null,
      trajectory: diss ? diss.trajectory : null,
      ingredients: (br && br.available === true) ? { items: br.ingredients, meta: br.ingredients_meta } : null,
      caveats: [
        'Bridge mix bars are composition, not a price action; if sign_stable is false the customer/product split is a modelling artefact — quote only the combined mix.',
        'If churn_dominated is true most of the mix comes from customer×SKU pairs present in only one window — timing, not a commercial shift.',
        'Ingredient figures are per ton of feed PRODUCED, national, and do not reconcile to the sales-based bridges.',
        'Category-trend per-ton figures on cells under 5 MT are noise.'
      ]
    };
  };

  // =========================================================================
  // PUBLIC ENTRY
  // =========================================================================
  window.loadMarginExplorer = function loadMarginExplorer() {
    if (!built) {
      // Seed the INITIAL default from the global topbar only on first build.
      // After that the tab owns its own Period / As-of controls and no longer
      // tracks the global topbar (so it works without the user setting it).
      // Land on QTD: it is the most fully populated view (SKU-level bridge +
      // ingredient decomposition + trend). YTD now renders a category (SSG) level
      // bridge across the Jan-2026 consolidation, but its ingredient panel is still
      // unavailable (RM purchase history starts Jan-2026). The user can switch period.
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
