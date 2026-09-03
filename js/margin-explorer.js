// ============================================================================
// MARGIN EXPLORER — page controller
// Owns the DOM inside #pg-margin-explorer. Exposes window.loadMarginExplorer()
// and the read-only window.MEXP_state().
//
// PAGE ORDER inside .mexp-wrap (the owner's decision, 2026-09):
//   1. SCOPE BAR (sticky)  period · as-of · region · BU · customer · compare ·
//                          unit, the drill breadcrumb (Escape pops one crumb),
//                          the as-of stamp and a manual refresh. ONE scope
//                          object (STATE) for the whole page.
//   2. HERO                mexp2-panel-trendmatrix (months x product category)
//                          with its filter rail. A second tab on the same frame,
//                          "Snapshot", holds the single-period drill matrix
//                          (margin-explorer-matrix.js, footer on ONE base).
//   3. HEADLINE            mexp2-panel-kpi — reported vs realised GM/kg, the
//                          discount, the four KPIs with basis and baseline
//                          window, the discount-overlay series.
//   4. BRIDGES ON ONE SCALE  reported (canonical_bridge) | reported->realised
//                          (g2n) | realised (net_bridge), all MEXP2.svg
//                          waterfalls; the two bridges share one domain
//                          (mexp2-panel-bridge.js unions them). Reconciling
//                          drills (cost components, product mix by SSG) sit
//                          under the reported bridge.
//   5. DRIVERS             the net-bridge lenses (margin-explorer-netbridge.js).
//   6. COST                the ingredient cost table (phase A, national) and
//                          the trajectory chart (margin-explorer-dissection.js)
//                          with one shared axis and an index-to-100 toggle.
//   7. INSIGHT             mexp2-panel-insight, then the AI read whose digest
//                          is built from the view model on screen.
//
// DATA FLOW (unchanged from v1): apiFetch('margin-explorer', params) in two
// phases — A (core: hero, matrix, discount_overlay, bridge ingredients) then B
// (dissection) under the same fetch sequence, so a newer scope abandons both.
// The mexp2 panels consume a view model built by MEXP2.adapter.vmFromV1 from
// the raw payloads; the v1 panels (Drivers, Cost) are fed the raw blocks and
// keep v1's own staleness policy (reset guards on scope change, dim + name the
// scope on a same-scope refresh failure).
//
// THE ONE SCOPE MECHANISM: applyScope(patch) — installed on MEXP2.adapter as
// applyScope so the trendmatrix rail, the Snapshot row click, the breadcrumb
// and Escape all go through the same function. patch uses the contract's
// scope names (region, bu, customer, refMonth, period, compare, unit, groupBy,
// drill). unit / groupBy-only changes never refetch (VIEW); anything that
// changes the server scope refetches.
//
// ENTRY POLICY (loadMarginExplorer): on FIRST entry the scope is seeded from
// the shell globals (window.PD, window.VF_REF_MONTH, window.RG). On RE-ENTRY
// every filter the user set on this tab is sticky — region, BU, customer,
// period, as-of, compare — and window.RG is adopted ONLY while the user has
// not touched the region control here (TOUCHED.region). v1 re-read RG on every
// entry and silently overwrote a user-set region while leaving BU/customer as
// they were; the rule is now the same for all three filters.
// ============================================================================

(function () {
  'use strict';

  // --- Safe global helper shims (guard if app helpers absent) ----------------
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
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }

  // --- THE scope object ---------------------------------------------------------
  var STATE = {
    period:   'QTD',
    ref_month: undefined,
    region:   'ALL',
    bu:       'ALL',
    customer: undefined,
    group_by: 'bu',
    compare:  'pp',
    unit:     'kg',
    drill:    []            // [{dim, value, label}] — the breadcrumb path
  };
  // Which controls the user has touched on THIS tab (entry policy above).
  var TOUCHED = { region: false };

  // Last fetched payloads and fetch bookkeeping.
  // fetchSeq   ONE sequence for both phases; an older phase A or B is abandoned.
  // coreSig    scope signature of the in-flight / last phase-A fetch (dedupe).
  // core/diss  RAW phase-A envelope and RAW phase-B dissection block, each with
  //            the signature it was fetched for and its last failure message.
  var LAST = { matrix: null, matrixLabel: '', fetchSeq: 0, hasCore: false, coreSig: null, coreInFlight: false,
               core: null, coreDataSig: null, coreErr: null,
               diss: null, dissSig: null, dissErr: null, dissInFlight: false,
               fetchedAt: null, snapshotAt: null };
  // The view model the mexp2 panels currently show, and the last good vm for a
  // DIFFERENT scope (what renderStaleAll prints while the new scope loads).
  var VM = null, VM_HINTS = null, PREV = null;
  var PANELS = [];          // MEXP2.adapter.panels() after mount
  var built = false, escBound = false;
  var TAB = 'trend';        // hero frame tab: 'trend' | 'snapshot'

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
  var GROUP_BY_LABEL = { region: 'Region', bu: 'BU', dsm: 'DSM', brand: 'Brand', species: 'Species',
                         sales_group: 'Sales Group', ssg: 'SSG', customer: 'Customer', sku: 'SKU' };
  // group_bys whose row-click re-scopes a SERVER filter (the API accepts region /
  // bu / customer only — WIRE.PARAMS). Every other dim is a client-side crumb.
  var DRILL_FILTER = { region: 'region', bu: 'bu', customer: 'customer' };
  // Build "As of" options: Live + trailing 18 months as YYYY-MM.
  function asOfOptions() {
    var out = [{ v: 'live', l: 'Live' }];
    var now = new Date();
    for (var i = 0; i < 18; i++) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      var lab = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      out.push({ v: key, l: lab });
    }
    return out;
  }

  // =========================================================================
  // STYLE + SKELETON (injected once). Page chrome only — the mexp2 panels carry
  // their own --mx2-* tokens in css/mexp2.css. Semantic colour comes from
  // --mx2-pos / --mx2-neg (distinct from the brand lime); numerals are tabular.
  // =========================================================================
  var STYLE = [
    '<style id="mexp-style">',
    '.mexp-wrap{padding:18px 20px 40px;color:var(--text);display:flex;flex-direction:column;gap:16px;font-variant-numeric:tabular-nums}',
    '.mexp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
    '.mexp-head-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.mexp-title{font-size:20px;font-weight:900;letter-spacing:-.3px;color:var(--text);display:flex;align-items:center;gap:10px}',
    '.mexp-sub{font-size:11px;color:var(--text3);margin-top:3px;font-weight:600;line-height:1.5}',
    // updating pill (non-destructive refresh hint) + dim state
    '.mexp-pill{display:none;align-items:center;gap:6px;font-size:9px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:var(--mx2-stale,var(--gold));background:var(--mx2-stale-soft,rgba(241,177,29,.12));border:1px solid var(--mx2-stale-border,rgba(241,177,29,.35));padding:3px 9px;border-radius:999px}',
    '.mexp-pill .mexp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:mexppulse 1s infinite}',
    '@keyframes mexppulse{0%,100%{opacity:.35}50%{opacity:1}}',
    '#pg-margin-explorer .mexp-dim{opacity:.6;transition:opacity .15s}',
    // stale state (same scope failed to refresh): dimmed but still readable/clickable;
    // the panel's own label names the scope it is showing.
    '#pg-margin-explorer .mexp-stale{opacity:.55;transition:opacity .15s}',
    '#pg-margin-explorer .mexp-stale-note{font-size:10px;font-weight:700;color:var(--mx2-stale,var(--gold));line-height:1.5}',
    '.mexp-btn{border:1px solid var(--mx2-border,var(--glass-border));background:var(--mx2-surface2,rgba(255,255,255,.035));color:var(--text2);font-size:10px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:6px 11px;border-radius:8px;cursor:pointer;white-space:nowrap}',
    '.mexp-btn:hover{border-color:var(--mx2-border-strong,var(--glass-border-hover));color:var(--text)}',
    '.mexp-btn:disabled{opacity:.5;cursor:default}',
    '.mexp-asof{font-size:10px;font-weight:700;color:var(--text3);white-space:nowrap}',
    // ---- 1. scope bar (sticky inside the shell's .content scroller) ----
    '.mexp-scope{position:sticky;top:-24px;z-index:5;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--mx2-border,var(--glass-border));border-radius:var(--r-lg);background:var(--mx2-surface-solid,var(--bg2,var(--surface)))}',
    '.mexp-filters{display:flex;flex-wrap:wrap;align-items:center;gap:12px}',
    '.mexp-fgroup{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.mexp-flabel{font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--text3);margin-right:2px}',
    '.mexp-chip{border:1px solid var(--mx2-border,var(--glass-border));background:var(--mx2-surface2,rgba(255,255,255,.035));color:var(--text2);font-size:11px;font-weight:800;padding:5px 11px;border-radius:8px;cursor:pointer;transition:all .12s;white-space:nowrap}',
    '.mexp-chip:hover{border-color:var(--mx2-border-strong,var(--glass-border-hover));color:var(--text)}',
    '.mexp-chip.active{background:var(--mx2-accent,var(--blue));border-color:var(--mx2-accent,var(--blue));color:var(--mx2-accent-fg,#fff)}',
    '.mexp-search{padding:6px 10px;border-radius:8px;border:1px solid var(--mx2-border,var(--glass-border));background:var(--mx2-surface2,var(--surface));color:var(--text);font-size:12px;font-weight:600;min-width:170px}',
    '.mexp-search::placeholder{color:var(--text3)}',
    '.mexp-divider{width:1px;align-self:stretch;background:var(--mx2-border,var(--glass-border));margin:0 2px}',
    // breadcrumb of the drill path
    '.mexp-crumbs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;font-weight:700;color:var(--text3)}',
    '.mexp-crumb{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--mx2-border,var(--glass-border));background:var(--mx2-surface2,rgba(255,255,255,.035));color:var(--text2);font-size:10.5px;font-weight:800;padding:4px 9px;border-radius:999px;cursor:pointer}',
    '.mexp-crumb:hover{color:var(--text);border-color:var(--mx2-border-strong,var(--glass-border-hover))}',
    '.mexp-crumb-sep{color:var(--text4,var(--text3));font-weight:900}',
    '.mexp-crumb-tag{font-size:8.5px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:var(--mx2-mix,var(--text3));border:1px solid var(--mx2-mix-border,var(--glass-border));border-radius:6px;padding:1px 5px}',
    '.mexp-crumb-hint{margin-left:auto;font-weight:600}',
    // ---- sections + panels (v1-owned: Drivers, Cost, AI) ----
    '.mexp-sec{display:flex;flex-direction:column;gap:16px;min-width:0}',
    '.mexp-sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.mexp-sec-t{font-size:12px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}',
    '.mexp-sec-st{font-size:9.5px;font-weight:700;color:var(--text3);line-height:1.45}',
    '.mexp-panel{border:1px solid var(--mx2-border,var(--glass-border));border-radius:var(--r-lg);background:var(--mx2-surface,var(--surface));padding:14px 16px;min-width:0}',
    '.mexp-panel-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap}',
    '.mexp-panel-t{font-size:12px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;color:var(--text2)}',
    '.mexp-panel-st{font-size:9.5px;font-weight:700;color:var(--text3);letter-spacing:.2px;margin-top:3px;line-height:1.45}',
    '.mexp-panel-hcol{display:flex;flex-direction:column;gap:0;min-width:0}',
    // ---- 2. hero frame tabs (the trendmatrix panel is the frame; Snapshot is its second tab) ----
    '.mexp-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--mx2-divider,var(--glass-border));padding-bottom:8px;margin-bottom:2px}',
    '.mexp-tab{border:1px solid transparent;background:transparent;color:var(--text3);font-size:10.5px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;padding:6px 12px;border-radius:8px;cursor:pointer}',
    '.mexp-tab:hover{color:var(--text)}',
    '.mexp-tab.on{color:var(--text);background:var(--mx2-surface2,rgba(255,255,255,.05));border-color:var(--mx2-border,var(--glass-border))}',
    '.mexp-tab-eyebrow{font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--text3);margin-right:6px}',
    '.mexp-snapshot{display:none;flex-direction:column;gap:10px;min-width:0}',
    '.mx2-panel.mexp-tab-snapshot > *:not(.mexp-tabs):not(.mexp-snapshot){display:none!important}',
    '.mx2-panel.mexp-tab-snapshot > .mexp-snapshot{display:flex}',
    '.mexp-snapshot-sub{font-size:9.5px;font-weight:700;color:var(--text3);line-height:1.45}',
    '.mexp-snapshot-note{font-size:10px;font-weight:700;color:var(--mx2-mix,var(--text3));border:1px solid var(--mx2-mix-border,var(--glass-border));background:var(--mx2-mix-soft,transparent);border-radius:8px;padding:5px 10px}',
    // ---- 4. bridges: three up, equal columns so all three take the same waterfall form ----
    '.mexp-bridges{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}',
    '.mexp-bridges>.mx2-panel{min-width:0}',
    '.mexp-bridges .mx2-g2n-grid{grid-template-columns:1fr}',
    '@media(max-width:1280px){.mexp-bridges{grid-template-columns:1fr}}',
    // ---- 6. cost: ingredient table (phase A) ----
    '.mexp-natl-tag{font-size:9px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);border:1px solid var(--mx2-border,var(--glass-border));border-radius:6px;padding:2px 7px;white-space:nowrap}',
    '.mexp-note{font-size:10px;color:var(--text3);font-weight:600;margin-top:10px;line-height:1.5}',
    '.mexp-coming{font-size:11px;color:var(--text3);font-weight:700;padding:18px 8px;text-align:center;border:1px dashed var(--mx2-border,var(--glass-border));border-radius:10px}',
    '.mexp-ing-tbl{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}',
    '.mexp-ing-tbl th,.mexp-ing-tbl td{padding:3px 6px;border-bottom:1px solid var(--mx2-divider,var(--glass-border))}',
    '.mexp-ing-tbl th{color:var(--text3);font-size:9px;text-transform:uppercase;letter-spacing:.04em;text-align:right;font-weight:600;white-space:nowrap}',
    '.mexp-ing-tbl th:first-child{text-align:left}',
    '.mexp-ing-tbl td.num{text-align:right;font-family:var(--mono,monospace);white-space:nowrap}',
    '.mexp-ing-tbl td.ing-nm{color:var(--text2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mexp-ing-tbl .rose{color:var(--mx2-neg,var(--red))}.mexp-ing-tbl .fell{color:var(--mx2-pos,var(--green))}.mexp-ing-tbl .newi{color:var(--mx2-stale,var(--gold))}.mexp-ing-tbl .was{color:var(--text3)}',
    // ---- 7. AI read ----
    '.mexp-aibtn{border:1px solid var(--mx2-stale,var(--gold));background:var(--mx2-stale-soft,rgba(255,199,44,.12));color:var(--mx2-stale,var(--gold));font-size:11px;font-weight:800;padding:6px 12px;border-radius:8px;cursor:pointer}',
    '.mexp-aibtn:disabled{opacity:.5;cursor:default}',
    '.mexp-aiout{font-size:12px;line-height:1.55;color:var(--text2);margin-top:10px;white-space:pre-wrap}',
    // states
    '.mexp-loading{padding:36px 8px;text-align:center;color:var(--text3);font-size:12px;font-weight:700}',
    '.mexp-error{padding:18px;border:1px solid var(--mx2-neg,var(--red));border-radius:10px;background:var(--mx2-neg-soft,rgba(255,80,80,.06));color:var(--mx2-neg,var(--red));font-size:12px;font-weight:700}',
    '@media(max-width:980px){.mexp-scope{position:static}}',
    '</style>'
  ].join('');

  function chipRow(groupKey, items, currentVal) {
    return items.map(function (it) {
      var on = (it.v === currentVal) ? ' active' : '';
      return '<button type="button" class="mexp-chip' + on + '" data-mexp-group="' + groupKey +
        '" data-mexp-val="' + _esc(it.v) + '">' + _esc(it.l) + '</button>';
    }).join('');
  }

  function asOfSelect() {
    var cur = STATE.ref_month || 'live';
    var opts = asOfOptions().map(function (o) {
      var sel = (o.v === cur) ? ' selected' : '';
      return '<option value="' + _esc(o.v) + '"' + sel + '>' + _esc(o.l) + '</option>';
    }).join('');
    return '<select id="mexp-asof" class="mexp-search" style="min-width:120px" aria-label="As of">' + opts + '</select>';
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
          '<div class="mexp-head-r">' +
            '<span class="mexp-asof" id="mexp-asof-stamp"></span>' +
            '<button type="button" class="mexp-btn" id="mexp-refresh" title="Fetch again now (the server caches each scope for up to 2 minutes)">Refresh</button>' +
            '<button type="button" class="mexp-btn" id="mexp-clear">Clear filters</button>' +
          '</div>' +
        '</div>' +

        // ---- 1. SCOPE BAR ----
        '<div class="mexp-scope" id="mexp-scope">' +
          '<div class="mexp-filters">' +
            '<div class="mexp-fgroup"><span class="mexp-flabel">Period</span>' + chipRow('period', PERIODS, STATE.period) + '</div>' +
            '<div class="mexp-fgroup"><span class="mexp-flabel">As of</span>' + asOfSelect() + '</div>' +
            '<div class="mexp-divider"></div>' +
            '<div class="mexp-fgroup"><span class="mexp-flabel">Region</span>' + chipRow('region', REGIONS, STATE.region) + '</div>' +
            '<div class="mexp-divider"></div>' +
            '<div class="mexp-fgroup"><span class="mexp-flabel">BU</span>' + chipRow('bu', BUS, STATE.bu) + '</div>' +
            '<div class="mexp-divider"></div>' +
            '<div class="mexp-fgroup"><input id="mexp-customer" class="mexp-search" type="search" placeholder="Customer…" aria-label="Customer"' +
              ' value="' + _esc(STATE.customer || '') + '"></div>' +
            '<div class="mexp-divider"></div>' +
            '<div class="mexp-fgroup"><span class="mexp-flabel">Compare</span>' +
              chipRow('compare', [{ v: 'pp', l: 'vs PP' }, { v: 'ly', l: 'vs LY' }], STATE.compare) + '</div>' +
            '<div class="mexp-divider"></div>' +
            '<div class="mexp-fgroup"><span class="mexp-flabel">Unit</span>' + chipRow('unit', UNITS, STATE.unit) + '</div>' +
          '</div>' +
          '<nav class="mexp-crumbs" id="mexp-crumbs" aria-label="Drill path"></nav>' +
        '</div>' +

        // ---- 2. HERO (trendmatrix + Snapshot tab) ----
        '<div class="mexp-sec" id="mexp-hero-host"></div>' +
        // ---- 3. HEADLINE (kpi) ----
        '<div class="mexp-sec" id="mexp-headline-host"></div>' +
        // ---- 4. BRIDGES ON ONE SCALE ----
        '<div class="mexp-sec">' +
          '<div class="mexp-sec-h"><div><div class="mexp-sec-t">GM/ton bridges — one scale</div>' +
            '<div class="mexp-sec-st">Reported (invoice-line basis, gross of off-invoice discount) · the walk from reported to realised · realised (net of off-invoice discount). ' +
            'Finished feed (103) only, credit notes netted, month-pair anchors — a different universe from the headline tiles.</div></div></div>' +
          '<div class="mexp-bridges" id="mexp-bridges"></div>' +
        '</div>' +
        // ---- 5. DRIVERS (net-bridge lenses) ----
        '<div class="mexp-panel" id="mexp-drivers">' +
          '<div class="mexp-panel-h"><div class="mexp-panel-hcol">' +
            '<span class="mexp-panel-t">Drivers — composition lenses, realised basis</span>' +
            '<span class="mexp-panel-st" id="mexp-drivers-sub">Net of off-invoice discount · each lens is a standalone one-dimensional share-shift; lenses do not sum to each other or to the mix bars</span>' +
          '</div></div>' +
          '<div id="mexp-drivers-body"><div class="mexp-loading">Loading…</div></div>' +
        '</div>' +
        // ---- 6. COST ----
        '<div class="mexp-panel" id="mexp-cost">' +
          '<div id="mexp-movers"><div class="mexp-coming">Ingredient cost — loading…</div></div>' +
          '<div id="mexp-cost-host"></div>' +
        '</div>' +
        // ---- 7. INSIGHT + AI read ----
        '<div class="mexp-sec" id="mexp-insight-host"></div>' +
        '<div class="mexp-panel" id="mexp-ai">' +
          '<div class="mexp-panel-h"><div class="mexp-panel-hcol">' +
            '<span class="mexp-panel-t">AI read</span>' +
            '<span class="mexp-panel-st">Server-proxied (POST /api/margin-ai). The digest is built from what is on screen: the scope, the headline, both bridges with their trust flags, the category table and the ingredient movers.</span>' +
          '</div><button type="button" class="mexp-aibtn" id="mexp-ai-btn" disabled>✦ AI read</button></div>' +
          '<div class="mexp-aiout" id="mexp-ai-out"></div>' +
        '</div>' +
      '</div>';

    root.innerHTML = html;
    mountPanels();
    wireEvents();
    return true;
  }

  // Mount the mexp2 panels into their hosts, then graft the Snapshot tab onto
  // the hero panel's frame.
  function mountPanels() {
    var ns = M2();
    if (!ns || !ns.adapter || typeof ns.adapter.mountPanels !== 'function') {
      var h = $('mexp-hero-host'); if (h) h.innerHTML = '<div class="mexp-error">Margin Explorer modules (MEXP2) are not loaded.</div>';
      return;
    }
    // THE scope mechanism, installed on the adapter seam the panels dispatch through.
    ns.adapter.applyScope = applyScope;
    var bridges = $('mexp-bridges');
    PANELS = ns.adapter.mountPanels({
      trendmatrix: $('mexp-hero-host'),
      kpi: $('mexp-headline-host'),
      bridge: bridges, g2n: bridges, netbridge: bridges,
      insight: $('mexp-insight-host')
    }, ['trendmatrix', 'kpi', 'bridge', 'g2n', 'netbridge', 'insight']);
    graftSnapshotTab();
  }

  function panelHost(id) {
    for (var i = 0; i < PANELS.length; i++) if (PANELS[i].id === id) return PANELS[i].host;
    return null;
  }

  // The Snapshot tab: same frame as the hero table, second tab. The tab strip
  // goes first in the panel, the snapshot body last; CSS hides the panel's own
  // children while the snapshot is on.
  function graftSnapshotTab() {
    var sec = panelHost('trendmatrix');
    if (!sec) return;
    var tabs = document.createElement('div');
    tabs.className = 'mexp-tabs';
    tabs.innerHTML = '<span class="mexp-tab-eyebrow">Hero</span>' +
      '<button type="button" class="mexp-tab on" data-mexp-tab="trend">By month · product category</button>' +
      '<button type="button" class="mexp-tab" data-mexp-tab="snapshot">Snapshot · selected period</button>';
    sec.insertBefore(tabs, sec.firstChild);
    var snap = document.createElement('div');
    snap.className = 'mexp-snapshot';
    snap.id = 'mexp-snapshot';
    snap.innerHTML = '<div class="mexp-snapshot-sub" id="mexp-snapshot-sub">Single-period drill matrix · finished feed + trading-import + basemix (103,105,102) · gross of off-invoice discount · footer sums the rows on screen</div>' +
      '<div id="mexp-matrix"><div class="mexp-loading">Loading…</div></div>';
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

  // =========================================================================
  // EVENT WIRING
  // =========================================================================
  function wireEvents() {
    var root = $('pg-margin-explorer');
    if (!root) return;

    // chip clicks (period / region / bu / compare / unit) via delegation
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
    var refresh = $('mexp-refresh');
    if (refresh) refresh.addEventListener('click', function () { fetchAndRender(true); });

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
        t = setTimeout(function () { applyScope({ customer: cust.value.replace(/^\s+|\s+$/g, '') || null }); }, 450);
      });
    }

    var crumbs = $('mexp-crumbs');
    if (crumbs) crumbs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mexp-depth]') : null;
      if (!b) return;
      applyScope({ drill: STATE.drill.slice(0, +b.getAttribute('data-mexp-depth')) });
    });

    var ai = $('mexp-ai-btn');
    if (ai) ai.addEventListener('click', runAi);

    // THE ONE document-level Escape handler (C.ESCAPE): a drill crumb pops;
    // otherwise nothing — no preventDefault, no stopPropagation, so the shell's
    // own Escape handling (modals, global search) still runs.
    if (!escBound) {
      escBound = true;
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' && ev.key !== 'Esc' && ev.keyCode !== 27) return;
        var page = $('pg-margin-explorer');
        if (!page || !page.classList.contains('active')) return;
        if (!STATE.drill.length) return;
        ev.stopPropagation(); ev.preventDefault();
        applyScope({ drill: STATE.drill.slice(0, STATE.drill.length - 1) });
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
    if (group === 'unit') { applyScope({ unit: val }); return; }
    if (group === 'period') { applyScope({ period: val }); return; }
    if (group === 'region') { applyScope({ region: val, drill: [] }); return; }
    if (group === 'bu') { applyScope({ bu: val, drill: [] }); return; }
    if (group === 'compare') { applyScope({ compare: val }); return; }
  }

  function clearFilters() {
    // unit + group_by + period + as-of are view / period prefs — keep them.
    applyScope({ region: 'ALL', bu: 'ALL', customer: null, compare: 'pp', drill: [] });
  }

  // Reflect STATE on every control (chips, inputs, breadcrumb).
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
    renderCrumbs();
  }

  function renderCrumbs() {
    var el = $('mexp-crumbs');
    if (!el) return;
    var html = '<button type="button" class="mexp-crumb" data-mexp-depth="0" title="Clear the drill path">All</button>';
    for (var i = 0; i < STATE.drill.length; i++) {
      var c = STATE.drill[i], server = !!DRILL_FILTER[c.dim];
      html += '<span class="mexp-crumb-sep">›</span>' +
        '<button type="button" class="mexp-crumb" data-mexp-depth="' + (i + 1) + '" title="' +
          (server ? 'Re-scopes the server: every panel follows this crumb' : 'Client-side row filter on the Snapshot only; server-computed panels show the server scope') + '">' +
          _esc((GROUP_BY_LABEL[c.dim] || c.dim) + ': ' + (c.label == null ? c.value : c.label)) +
          (server ? '' : ' <span class="mexp-crumb-tag">client-side</span>') +
        '</button>';
    }
    html += '<span class="mexp-crumb-hint">' + (STATE.drill.length ? 'Esc pops one level' : 'Click a Snapshot row or a category row to drill · Esc pops one level') + '</span>';
    el.innerHTML = html;
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
    var before = scopeSig(), viewOnly = true, i, c, old, next, prevCrumb, gone;

    if (hasOwn(patch, 'period') && inList(PERIODS, patch.period)) STATE.period = patch.period;
    if (hasOwn(patch, 'refMonth')) STATE.ref_month = isYM(patch.refMonth) ? patch.refMonth : undefined;
    if (hasOwn(patch, 'region')) { STATE.region = normRegion(patch.region); TOUCHED.region = true; }
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
        if (c.dim === 'region') { STATE.region = 'ALL'; TOUCHED.region = true; }
        else if (c.dim === 'bu') STATE.bu = 'ALL';
        else if (c.dim === 'customer') STATE.customer = undefined;
      }
      // crumbs that entered the path: set the filter they name
      for (i = 0; i < next.length; i++) {
        c = next[i]; if (!DRILL_FILTER[c.dim]) continue;
        prevCrumb = crumbOf(old, c.dim);
        if (prevCrumb && prevCrumb.value === c.value) continue;
        if (c.dim === 'region') { STATE.region = normRegion(c.value); TOUCHED.region = true; }
        else if (c.dim === 'bu') STATE.bu = c.value;
        else if (c.dim === 'customer') STATE.customer = c.value;
      }
      STATE.drill = next;
    }
    reflectControls();
    if (scopeSig() !== before) viewOnly = false;
    if (viewOnly) { renderView(); return true; }
    fetchAndRender();
    return true;
  }

  // A display-only change (unit, drill path on the same server scope): repaint
  // the Snapshot and hand the mexp2 panels the same data under the new scope.
  function renderView() {
    renderMatrixOnly();
    var ns = M2();
    if (!ns || !ns.adapter || !VM) return;
    buildVm({ coreLoading: LAST.coreInFlight, dissLoading: LAST.dissInFlight, coreError: LAST.coreErr, dissError: LAST.dissErr });
    // Only a phase whose data for THIS scope has landed is repainted: a phase
    // still in flight keeps its stale render (or skeleton) untouched.
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
  // ingredients / ingredients_meta feed the Ingredient Cost table and the insight
  // panel. "trend" has no renderer on this page, so it is not requested.
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
  // Stable signature of the SERVER scope (ignores _t cache-buster, include, unit
  // and client-side crumbs) so a duplicate phase-A fetch is detected.
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
  // Scope changed: forget every v1 "last good" so the new scope is judged on its own.
  function resetStaleGuards() {
    if (typeof window.MEXP_resetDissection === 'function') { try { window.MEXP_resetDissection(); } catch (e) {} }
    if (typeof window.MEXP_resetNetBridge === 'function') { try { window.MEXP_resetNetBridge(); } catch (e) {} }
  }

  // -- View model -------------------------------------------------------------
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
  // Non-drillAware mexp2 panels say so when a client-side crumb is active: they
  // show the server scope. Text only, by DOM membership, at the top of the card.
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
      txt += ' — a client-side filter on the Snapshot only; this panel shows the server scope';
      b.textContent = txt;
    }
  }

  // -- Loading-state helpers (non-destructive) -------------------------------
  function setUpdating(on) {
    var pill = $('mexp-updating');
    var snap = $('mexp-snapshot');
    var diss = $('mexp-diss');
    if (pill) {
      // showError() may have replaced the pill text with "⚠ update failed" (and
      // destroyed the dot) — rebuild the markup every time it goes back on.
      if (on) pill.innerHTML = '<span class="mexp-dot"></span>Updating';
      pill.style.display = on ? 'inline-flex' : 'none';
    }
    var els = [snap, diss, $('mexp-drivers-body'), $('mexp-movers')];
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
    // Only clobber the Snapshot with an error if there is nothing good to keep.
    if (m && !LAST.hasCore) m.innerHTML = '<div class="mexp-error">Could not load margin data.<br>' + _esc(msg) + '</div>';
    var pill = $('mexp-updating');
    if (pill) { pill.textContent = '⚠ update failed'; pill.style.display = 'inline-flex'; }
  }

  // Public entry for any scope change. Bumps ONE sequence that supersedes BOTH
  // phases of any in-flight load, then kicks off phase A (which chains phase B).
  // `force` (the Refresh button) re-fetches an identical scope.
  function fetchAndRender(force) {
    if (typeof window.apiFetch !== 'function') { showError('apiFetch unavailable.'); return; }
    var ns = M2(), A = ns && ns.adapter, C = ns && ns.C;

    var sig = scopeSig();
    // Double-invocation guard: identical scope already fetching phase A → no-op.
    if (LAST.coreInFlight && LAST.coreSig === sig && !force) return;

    var changed = (LAST.coreSig !== null && LAST.coreSig !== sig);
    if (changed) {
      // Scope changed → no v1 panel may keep a "last good" from the previous scope,
      // and the mexp2 panels keep the previous scope's data ONLY through renderStale.
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

  // ---- Phase A: fast core (hero, window, matrix, discount overlay, ingredients) ----
  // (promise chains, not async/await — the page is ES5 like the shell.)
  function fetchCore(seq) {
    var p;
    try { p = Promise.resolve(window.apiFetch('margin-explorer', coreParams())); }
    catch (e) { p = Promise.reject(e); }
    p.then(function (data) {
      if (seq !== LAST.fetchSeq) return;              // stale — abandon silently
      LAST.coreInFlight = false;
      // apiFetch returns null on a 401 (logout already triggered) — nothing to paint.
      if (!data) { LAST.coreErr = 'Empty response.'; setUpdating(false); showError('Empty response (session may have expired).'); markErrored('core'); return; }

      LAST.matrix = data.matrix || null;
      LAST.matrixLabel = scopeLabel();
      LAST.core = data; LAST.coreDataSig = LAST.coreSig; LAST.coreErr = null;
      LAST.fetchedAt = new Date();
      LAST.snapshotAt = (data.meta && data.meta.data_quality && data.meta.data_quality.snapshot_at) || null;

      try { renderWindow(data.hero); } catch (e) { console.error('[MEXP] window:', e); }
      try { renderStamp(); } catch (e) { console.error('[MEXP] stamp:', e); }
      try { renderMatrixOnly(); }      catch (e) { console.error('[MEXP] matrix:', e); }
      try { renderMovers(data.movers, data.gap, data.bridge && data.bridge.ingredients, data.bridge && data.bridge.ingredients_meta); } catch (e) { console.error('[MEXP] movers:', e); }

      LAST.hasCore = true;
      setUpdating(false);

      // The mexp2 CORE-phase panels paint now; the dissection-phase panels keep
      // their stale / loading state until phase B lands.
      var ns = M2();
      if (ns && ns.adapter) {
        buildVm({ dissLoading: true });
        try { ns.adapter.renderAll(VM, VM_HINTS, 'core'); } catch (e) { console.error('[MEXP] renderAll (core):', e); }
        badgePanels();
      }
      var ai = $('mexp-ai-btn'); if (ai) ai.disabled = false;

      // Chain phase B (slow) under the SAME seq, so a newer phase A abandons it.
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

  // ---- Phase B: lazy dissection (bridges, drivers, cost charts, category table, insight) ----
  function fetchDissection(seq) {
    // subtle updating state on the cost block only (core already painted)
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

  // Fan phase B out: the v1 panels (Drivers, Cost) get the raw block; the mexp2
  // panels get a rebuilt view model. `diss` may be null (fetch failed → errMsg
  // set, or the server returned no dissection block) or { available:false, reason }.
  function renderPhaseB(diss, errMsg) {
    var label = scopeLabel();
    var unavailable = null;
    if (errMsg) unavailable = { available: false, reason: errMsg, error: true };
    else if (!diss) unavailable = { available: false, reason: 'No dissection block returned for this scope.' };
    else if (diss.available === false) unavailable = { available: false, reason: diss.reason || 'No finished-feed data for this selection.' };

    // 5. DRIVERS — the net-bridge lenses.
    try {
      if (typeof window.MEXP_renderNetBridge === 'function') {
        window.MEXP_renderNetBridge(unavailable || diss.net_bridge || { available: false, reason: 'No net bridge returned for this scope.' }, label);
      }
    } catch (e) { console.error('[MEXP] drivers:', e); }
    // 6. COST — trajectory + ingredient contribution.
    try { if (typeof window.MEXP_renderDissection === 'function') window.MEXP_renderDissection(unavailable || diss, label); } catch (e) { console.error('[MEXP] cost:', e); }

    // 2/4/7. the mexp2 panels
    var ns = M2();
    if (!ns || !ns.adapter) return;
    if (errMsg) { buildVm({ dissError: errMsg }); markErrored('diss'); return; }
    buildVm({});
    try { ns.adapter.renderAll(VM, VM_HINTS); } catch (e) { console.error('[MEXP] renderAll:', e); }
    badgePanels();
  }

  // The head line: the period and its explicit baseline. hero.compare_window is
  // TZ-safe; meta.window is not and is never printed.
  function renderWindow(hero) {
    var el = $('mexp-window');
    if (!el) return;
    var cw = hero && hero.compare_window;
    var bits = [scopeLabel()];
    if (cw && cw.from && cw.to) bits.push('baseline ' + cw.from + ' → ' + cw.to + (cw.basis ? ' (' + cw.basis + ')' : ''));
    if (hero && hero.compare_note) bits.push((hero.ly_comparable === false ? '⚠ ' : 'ⓘ ') + hero.compare_note);
    el.textContent = bits.join('  ·  ');
  }
  function renderStamp() {
    var el = $('mexp-asof-stamp');
    if (!el) return;
    var s = '';
    if (LAST.fetchedAt) s += 'Fetched ' + hhmm(LAST.fetchedAt);
    if (LAST.snapshotAt) {
      var d = new Date(LAST.snapshotAt);
      s += (s ? ' · ' : '') + 'snapshot ' + (isNaN(d.getTime()) ? String(LAST.snapshotAt) : hhmm(d)) + ' (up to 2 min behind)';
    }
    el.textContent = s;
  }

  // The Snapshot tab: the single-period drill matrix, with client-side crumbs
  // applied when their dim is the current group_by.
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
      note = 'Filtered client-side to ' + (GROUP_BY_LABEL[gb] || gb) + ': ' + crumb.label + ' — ' + kept.length + ' of ' + rows.length + ' rows; the server scope is unchanged.';
      m = { group_by: gb, total_gp: m.total_gp, rows: kept };
    }
    var sub = $('mexp-snapshot-sub');
    if (sub) sub.textContent = (LAST.matrixLabel || scopeLabel()) + ' · single-period drill matrix · finished feed + trading-import + basemix (103,105,102) · gross of off-invoice discount · footer sums the rows on screen';
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

  // A Snapshot row click drills: a crumb on the row's dim. Region / BU / Customer
  // re-scope the server through the crumb rule; every other dim is a client-side
  // crumb (the trendmatrix explains it, the other panels carry the badge). A
  // second click on the selected row clears that crumb.
  function onRowClick(row) {
    if (!row || row.dim == null) return;
    var dim = STATE.group_by, val = String(row.dim), cur = crumbOf(STATE.drill, dim), next = [], i;
    for (i = 0; i < STATE.drill.length; i++) if (STATE.drill[i].dim !== dim) next.push(STATE.drill[i]);
    if (!(cur && cur.value === val)) next.push({ dim: dim, value: val, label: val });
    applyScope({ drill: next });
  }

  // 6. COST — Ingredient cost: now-vs-prior table (raw ₱/kg price move + inclusion% +
  // ₱/ton-of-feed Δ). Phase A, per ton of feed PRODUCED, national — not filtered.
  function renderMovers(movers, gap, ingredients, ingMeta) {
    var el = $('mexp-movers');
    if (!el) return;
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
        var dCls = rose ? 'rose' : (fell ? 'fell' : '');
        var pNow = nz(i.price_now), pPri = nz(i.price_prior);
        var pUp = pPri != null && pNow > pPri, pDn = pPri != null && pNow < pPri;
        var pCls = pUp ? 'rose' : (pDn ? 'fell' : '');
        var pArr = pUp ? ' ▲' : (pDn ? ' ▼' : '');
        var priceCell = (pPri == null ? '<span class="newi">new</span> ' : '<span class="was">' + fkg(pPri) + '</span> → ')
          + '<b class="' + pCls + '">' + fkg(pNow) + '</b>' + pArr;
        var inclCell = (i.incl_prior_pct == null ? '' : '<span class="was">' + fpct(i.incl_prior_pct) + '</span>→') + fpct(i.incl_now_pct);
        // price vs recipe split kept on hover (the decomposition)
        var tip = 'price ' + (i.price_effect > 0 ? '+' : (i.price_effect < 0 ? '−' : '')) + '₱' + f1(Math.abs(i.price_effect)) + '/t  ·  recipe ' + (i.inclusion_effect > 0 ? '+' : (i.inclusion_effect < 0 ? '−' : '')) + '₱' + f1(Math.abs(i.inclusion_effect)) + '/t';
        return '<tr>' +
          '<td class="ing-nm" title="' + es(i.name) + '">' + es(i.name) + '</td>' +
          '<td class="num">' + priceCell + '</td>' +
          '<td class="num">' + inclCell + '</td>' +
          '<td class="num">' + fpt(i.perton_cost) + '</td>' +
          '<td class="num ' + dCls + '" style="font-weight:600;cursor:help" title="' + tip + '">' + fdt(i.perton_delta) + '</td>' +
          '</tr>';
      }).join('');
      var sub = (ingMeta && ingMeta.note) ? es(ingMeta.note) : '';
      var basis = (ingMeta && ingMeta.feed_basis) ? ' · per-ton denominator: ' + es(ingMeta.feed_basis) : '';
      el.innerHTML = '<div class="mexp-panel-h"><div class="mexp-panel-hcol"><span class="mexp-panel-t">Cost — Ingredient cost / MT of feed</span>' +
        '<span class="mexp-panel-st">Phase A procurement lens, per MT of feed PRODUCED' + basis + '</span></div>' +
        '<span class="mexp-natl-tag" title="Production lens — recipe-weighted national ingredient cost. Does not respond to the Region/BU filter.">National — not filtered by Region/BU</span></div>' +
        '<div style="font-size:9px;color:var(--text3);margin:-2px 0 6px;line-height:1.4">' + sub + '</div>' +
        '<table class="mexp-ing-tbl"><thead><tr>' +
        '<th>Ingredient</th><th>₱/kg was→now</th><th>incl %</th><th>₱/MT feed</th><th>Δ ₱/MT</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="font-size:9px;color:var(--text3);margin-top:6px;line-height:1.4">▲ = cost rose · ▼ = cost fell · hover Δ for price vs recipe split. Short windows (early MTD) have few purchase invoices — use QTD/YTD for a stable price read.</div>';
      el.style.display = 'block';
      return;
    }
    var hasGap = gap && gap.available;
    el.innerHTML = '<div class="mexp-panel-h"><div class="mexp-panel-hcol"><span class="mexp-panel-t">Cost — Ingredient cost / MT of feed</span></div>' +
      '<span class="mexp-natl-tag">National — not filtered by Region/BU</span></div>' +
      '<div class="mexp-coming">' + (hasGap ? 'Gap analysis — coming in Phase 2' : 'Ingredient cost is not available for this window — select MTD/QTD to see per-MT ingredient cost (RM purchase history starts Jan-2026)') + '</div>';
  }

  // ---- 7. AI read (server-proxied POST /api/margin-ai) ----
  // Goes through the shell's API client (window.apiPost: session header, 401 →
  // logout) instead of a bare fetch. The digest is built from the view model on
  // screen — never from a payload the panels are not showing.
  function pick(o, keys) {
    var out = {}, i;
    if (!o || typeof o !== 'object') return null;
    for (i = 0; i < keys.length; i++) if (o[keys[i]] !== undefined) out[keys[i]] = o[keys[i]];
    return out;
  }
  function aiDigest() {
    var vm = VM || {}, core = vm.core || null, diss = (vm.diss && vm.diss.available === true) ? vm.diss : null;
    var hero = core && core.hero, ov = core && core.discount_overlay, br = core && core.bridge;
    var cb = diss && diss.canonical_bridge, nb = diss && diss.net_bridge, ct = diss && diss.category_trend;
    var BR = ['base_month', 'compare_month', 'compare_partial', 'like_for_like', 'prior_gm_ton', 'current_gm_ton', 'delta', 'price', 'cost', 'customer_mix', 'product_mix', 'mix_total', 'note'];
    var d = {
      scope: vm.label, drill: copyCrumbs(STATE.drill),
      applied_filters: core && core.meta && core.meta.applied_filters,
      basis: 'sales / GP figures are gross of the off-invoice document discount (OINV.DiscSum); "realised" = net of that discount. Hero universe (103,105,102) and dissection universe (103, credit notes netted) do not tie out.',
      headline: hero ? {
        baseline: hero.compare_window, compare_basis: hero.compare_basis,
        net_sales: hero.net_sales, gross_profit: hero.gross_profit, gp_pct: hero.gp_pct, gm_per_kg_reported: hero.gm_per_kg,
        discount_overlay: pick(ov, ['gm_per_kg_reported', 'gm_per_kg_net_of_discount', 'discount_per_kg', 'discount_total', 'discount_pct_of_reported_gm', 'delta_reported', 'delta_net_of_discount'])
      } : null,
      anchors: diss ? { base_month: diss.base_month, compare_month: diss.compare_month, compare_partial: diss.compare_partial, window: diss.window } : null,
      bridge_reported: (cb && cb.available === true) ? pick(cb, BR) : null,
      bridge_realised: (nb && nb.available === true) ? pick(nb, BR.concat(['discount', 'vs_reported'])) : null,
      trust: (cb && cb.available === true) ? {
        sign_stable: cb.mix_ordering && cb.mix_ordering.sign_stable, mix_ranges: cb.mix_ordering && pick(cb.mix_ordering, ['customer_range', 'product_range']),
        churn_dominated: cb.mix_detail && cb.mix_detail.churn_dominated, mix_detail: pick(cb.mix_detail, ['one_sided_share_pct', 'matched_kg_share_pct']),
        significance: cb.significance
      } : null,
      lenses_realised: (nb && nb.available === true && nb.lenses) ? { customer: nb.lenses.customer, ssg: nb.lenses.ssg } : null,
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
        'Ingredient figures are per MT of feed PRODUCED, national, and do not reconcile to the sales-based bridges.',
        'Category-trend per-ton figures on cells under 5 MT are noise.'
      ]
    };
    return d;
  }
  function runAi() {
    var btn = $('mexp-ai-btn'), out = $('mexp-ai-out');
    if (!btn || !out) return;
    if (!VM || !VM.core) { out.textContent = 'Nothing on screen to read yet.'; return; }
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '✦ reading…'; out.textContent = '';
    function done() { btn.disabled = false; btn.textContent = old; }
    if (typeof window.apiPost !== 'function') { out.textContent = 'AI read unavailable (API client not loaded).'; done(); return; }
    var p;
    try { p = Promise.resolve(window.apiPost('margin-ai', { digest: aiDigest() })); }
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

  // =========================================================================
  // PUBLIC ENTRY
  // =========================================================================
  // Read-only snapshot for tests and the adapter: the raw phase-A payload and
  // phase-B dissection block LAST holds, each tagged with the scope signature it
  // belongs to, plus the current scope, its signature and its label.
  window.MEXP_state = function MEXP_state() {
    return {
      sig: scopeSig(),
      label: scopeLabel(),
      scope: scopeForVm(),
      core: LAST.core, coreSig: LAST.coreDataSig, coreErr: LAST.coreErr, coreInFlight: LAST.coreInFlight,
      diss: LAST.diss, dissSig: LAST.dissSig, dissErr: LAST.dissErr, dissInFlight: LAST.dissInFlight,
      vm: VM, prev: PREV
    };
  };
  window.loadMarginExplorer = function loadMarginExplorer() {
    if (!built) {
      // FIRST ENTRY: seed from the shell globals. Land on QTD unless the topbar
      // says MTD: QTD is the most fully populated view (SKU-level bridge +
      // ingredient decomposition); YTD renders a category-level bridge across
      // the Jan-2026 consolidation with no ingredient panel. The user can switch.
      var seedP = (typeof window.PD === 'string' && window.PD) ? window.PD : 'QTD';
      STATE.period = (seedP === 'YTD' || seedP === '7D') ? 'QTD' : seedP;
      if (typeof window.VF_REF_MONTH === 'string' && isYM(window.VF_REF_MONTH)) STATE.ref_month = window.VF_REF_MONTH;
      if (typeof window.RG === 'string' && window.RG) STATE.region = normRegion(window.RG);
      built = buildSkeleton();
      if (!built) return;
    } else if (typeof window.RG === 'string' && window.RG && !TOUCHED.region) {
      // RE-ENTRY: region follows the topbar ONLY while the user has not set it on
      // this tab; once touched it is as sticky as BU / customer / period / as-of.
      STATE.region = normRegion(window.RG);
    }
    reflectControls();
    fetchAndRender();
  };
})();
