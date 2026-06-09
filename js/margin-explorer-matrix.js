/* margin-explorer-matrix.js — Margin Explorer drill matrix (self-contained, no fetch)
 * Exposes: window.MEXP_renderMatrix(containerEl, matrix, opts)
 *   matrix = { group_by, total_gp, rows:[ {dim,sales,kg,tons,gp,gp_pct,gm_per_kg,pct_of_gp,expandable}, ... ] }
 *   opts   = { unit:'kg'|'ton'|'gp_pct'|'gp', selectedDim:string|null,
 *              onRowClick(dimValue,row), onGroupByChange(groupByKey) }
 */
(function () {
  'use strict';

  // --- local guards for app globals (use if present, fall back otherwise) ---
  var _fc  = (typeof fc  === 'function') ? fc  : function (n) {
    if (n == null || isNaN(n)) return '₱0';
    n = +n;
    if (Math.abs(n) >= 1e6) return '₱' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '₱' + (n / 1e3).toFixed(0) + 'K';
    return '₱' + n.toFixed(0);
  };
  var _esc = (typeof esc === 'function') ? esc : function (s) {
    if (s == null) return '';
    var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
  };
  var _fcn = (typeof fcn === 'function') ? fcn : function (n) {
    if (n == null || isNaN(n)) return '0';
    return (+n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  var GROUP_BY_OPTIONS = [
    { key: 'region',      label: 'Region' },
    { key: 'bu',          label: 'Business Unit' },
    { key: 'dsm',         label: 'DSM' },
    { key: 'brand',       label: 'Brand' },
    { key: 'species',     label: 'Species' },
    { key: 'sales_group', label: 'Sales Group' },
    { key: 'ssg',         label: 'SSG' },
    { key: 'customer',    label: 'Customer' },
    { key: 'sku',         label: 'SKU' }
  ];

  // Unit-dependent primary column config
  var UNIT_CFG = {
    kg:     { header: 'GM / kg',  field: 'gm_per_kg', scale: 1,    fmt: fmtMoney2, colorize: true  },
    ton:    { header: 'GM / ton', field: 'gm_per_kg', scale: 1000, fmt: fmtMoney0, colorize: true  },
    gp_pct: { header: 'GP %',     field: 'gp_pct',    scale: 1,    fmt: fmtPct,    colorize: true  },
    gp:     { header: 'GP ₱', field: 'gp',        scale: 1,    fmt: function (v) { return _fc(v); }, colorize: false }
  };

  function fmtMoney2(v) {
    if (v == null || isNaN(v)) return '—';
    return '₱' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney0(v) {
    if (v == null || isNaN(v)) return '—';
    return '₱' + (+v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return '—';
    return (+v).toFixed(1) + '%';
  }
  function fmtTons(v) {
    if (v == null || isNaN(v)) return '—';
    return (+v).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' t';
  }
  function fmtDelta(v, isPct) {
    if (v == null || isNaN(v)) return '—';
    var n = +v;
    var sign = n > 0 ? '+' : '';
    return sign + n.toFixed(1) + (isPct ? '%' : '');
  }

  // Green-ish positive / red negative color for a primary value.
  function valueColor(v) {
    if (v == null || isNaN(v)) return 'var(--text3)';
    return (+v) < 0 ? 'var(--red)' : 'var(--green)';
  }
  function deltaColor(v) {
    if (v == null || isNaN(v)) return 'var(--text3)';
    if (+v > 0) return 'var(--green)';
    if (+v < 0) return 'var(--red)';
    return 'var(--text3)';
  }

  // Inject scoped styles once.
  function ensureStyles() {
    if (document.getElementById('mexp-matrix-styles')) return;
    var css = '' +
      '.mexp-matrix-wrap{display:flex;flex-direction:column;gap:14px}' +
      '.mexp-matrix-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.mexp-matrix-toolbar label{font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}' +
      '.mexp-groupby{background:var(--surface);color:var(--text);border:1px solid var(--border);' +
        'border-radius:8px;padding:7px 30px 7px 11px;font-size:13px;font-weight:600;cursor:pointer;' +
        'appearance:none;-webkit-appearance:none;outline:none;' +
        'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'><path d=\'M0 0l5 6 5-6z\' fill=\'%23888\'/></svg>");' +
        'background-repeat:no-repeat;background-position:right 11px center}' +
      '.mexp-groupby:hover{border-color:var(--glass-border-hover)}' +
      // table-layout:fixed → even, professional columns (no content-driven jitter)
      '.mexp-matrix-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}' +
      '.mexp-matrix-table th{text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;' +
        'letter-spacing:.04em;color:var(--text3);padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.mexp-matrix-table th.mexp-c-dim{text-align:left}' +
      // first (label) column gets a fixed share; the rest distribute evenly under fixed layout
      '.mexp-matrix-table col.mexp-col-dim{width:26%}' +
      '.mexp-matrix-table td{text-align:right;padding:7px 10px;border-bottom:1px solid var(--glass-border);' +
        'color:var(--text2);white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}' +
      '.mexp-matrix-table td.mexp-c-dim{text-align:left;color:var(--text);font-weight:700}' +
      '.mexp-row{cursor:pointer;transition:background .12s}' +
      '.mexp-row:hover{background:rgba(255,255,255,0.03)}' +
      '.mexp-row.mexp-sel{background:rgba(0,196,232,0.10);box-shadow:inset 3px 0 0 var(--cyan)}' +
      '.mexp-row.mexp-sel td.mexp-c-dim{color:var(--cyan)}' +
      '.mexp-dim-chevron{color:var(--text3);margin-left:6px;font-size:11px;opacity:.7}' +
      '.mexp-primary{font-weight:700}' +
      '.mexp-share{display:flex;align-items:center;gap:8px;justify-content:flex-end}' +
      '.mexp-share-bar{position:relative;width:64px;height:6px;border-radius:4px;background:var(--glass-border);overflow:hidden;flex:0 0 auto}' +
      '.mexp-share-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:var(--cyan)}' +
      '.mexp-share-num{color:var(--text3);font-size:12px;min-width:42px;text-align:right}' +
      '.mexp-foot td{border-top:2px solid var(--border);border-bottom:none;font-weight:700;color:var(--text);' +
        'padding-top:11px;font-variant-numeric:tabular-nums}' +
      '.mexp-foot td.mexp-c-dim{text-transform:uppercase;letter-spacing:.04em;font-size:12px}' +
      '.mexp-empty{padding:34px 16px;text-align:center;color:var(--text3);' +
        'border:1px dashed var(--border);border-radius:var(--r-lg);font-size:13px}';
    var st = document.createElement('style');
    st.id = 'mexp-matrix-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildToolbar(groupBy, onGroupByChange) {
    var wrap = document.createElement('div');
    wrap.className = 'mexp-matrix-toolbar';

    var lbl = document.createElement('label');
    lbl.textContent = 'Group by';
    lbl.setAttribute('for', 'mexp-groupby-sel');
    wrap.appendChild(lbl);

    var selEl = document.createElement('select');
    selEl.className = 'mexp-groupby';
    selEl.id = 'mexp-groupby-sel';
    GROUP_BY_OPTIONS.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.key;
      opt.textContent = o.label;
      if (o.key === groupBy) opt.selected = true;
      selEl.appendChild(opt);
    });
    selEl.addEventListener('change', function () {
      if (typeof onGroupByChange === 'function') onGroupByChange(selEl.value);
    });
    wrap.appendChild(selEl);
    return wrap;
  }

  window.MEXP_renderMatrix = function (containerEl, matrix, opts) {
    if (!containerEl) return;
    ensureStyles();
    opts = opts || {};
    matrix = matrix || {};
    var rows = Array.isArray(matrix.rows) ? matrix.rows : [];
    var unit = UNIT_CFG[opts.unit] ? opts.unit : 'kg';
    var cfg = UNIT_CFG[unit];
    var selectedDim = (opts.selectedDim != null) ? opts.selectedDim : null;
    var groupBy = matrix.group_by || 'bu';

    containerEl.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'mexp-matrix-wrap';
    wrap.appendChild(buildToolbar(groupBy, opts.onGroupByChange));

    // Empty state
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'mexp-empty';
      empty.textContent = 'No rows for the current selection.';
      wrap.appendChild(empty);
      containerEl.appendChild(wrap);
      return;
    }

    var totalGp = (matrix.total_gp != null)
      ? +matrix.total_gp
      : rows.reduce(function (s, r) { return s + (+r.gp || 0); }, 0);
    var maxShare = rows.reduce(function (m, r) {
      var p = (r.pct_of_gp != null) ? +r.pct_of_gp : (totalGp ? (+r.gp || 0) / totalGp * 100 : 0);
      return p > m ? p : m;
    }, 0) || 1;

    var isPctDelta = (unit === 'gp_pct' || unit === 'kg' || unit === 'ton');

    var table = document.createElement('table');
    table.className = 'mexp-matrix-table';

    // colgroup: fixed label column + 5 even numeric columns
    var colg = document.createElement('colgroup');
    colg.innerHTML = '<col class="mexp-col-dim">' + '<col><col><col><col><col>';
    table.appendChild(colg);

    // Header
    var thead = document.createElement('thead');
    thead.innerHTML =
      '<tr>' +
      '<th class="mexp-c-dim">' + _esc(labelForGroup(groupBy)) + '</th>' +
      '<th>' + _esc(cfg.header) + '</th>' +
      '<th>GP ₱</th>' +
      '<th>% of GP</th>' +
      '<th>Vol (t)</th>' +
      '<th>Δ</th>' +
      '</tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      tbody.appendChild(buildRow(r, cfg, totalGp, maxShare, selectedDim, isPctDelta, opts.onRowClick));
    });
    table.appendChild(tbody);

    // Footer total
    table.appendChild(buildFooter(rows, cfg, totalGp, unit));

    wrap.appendChild(table);
    containerEl.appendChild(wrap);
  };

  function labelForGroup(key) {
    for (var i = 0; i < GROUP_BY_OPTIONS.length; i++) {
      if (GROUP_BY_OPTIONS[i].key === key) return GROUP_BY_OPTIONS[i].label;
    }
    return key || 'Dimension';
  }

  function buildRow(r, cfg, totalGp, maxShare, selectedDim, isPctDelta, onRowClick) {
    var tr = document.createElement('tr');
    tr.className = 'mexp-row' + (r.dim === selectedDim ? ' mexp-sel' : '');

    // primary value (unit-dependent)
    var rawPrimary = r[cfg.field];
    var primaryVal = (rawPrimary == null || isNaN(rawPrimary)) ? null : (+rawPrimary * cfg.scale);
    var primaryColor = cfg.colorize ? valueColor(primaryVal) : 'var(--text)';

    // share
    var share = (r.pct_of_gp != null) ? +r.pct_of_gp
      : (totalGp ? (+r.gp || 0) / totalGp * 100 : 0);
    var fillPct = Math.max(0, Math.min(100, (share / maxShare) * 100));

    // delta
    var deltaRaw = (r.delta != null) ? r.delta
      : (r.delta_pct != null ? r.delta_pct
      : (r.delta_pp != null ? r.delta_pp : null));

    var chevron = r.expandable ? '<span class="mexp-dim-chevron">›</span>' : '';

    tr.innerHTML =
      '<td class="mexp-c-dim" title="' + _esc(r.dim) + '">' + _esc(r.dim) + chevron + '</td>' +
      '<td class="mexp-primary" style="color:' + primaryColor + '">' +
        (primaryVal == null ? '—' : _esc(cfg.fmt(primaryVal))) + '</td>' +
      '<td>' + _esc(_fc(r.gp)) + '</td>' +
      '<td>' + share.toFixed(1) + '%</td>' +
      '<td>' + _esc(fmtTons(r.tons)) + '</td>' +
      '<td style="color:' + deltaColor(deltaRaw) + '">' + _esc(fmtDelta(deltaRaw, isPctDelta)) + '</td>';

    tr.addEventListener('click', function () {
      if (typeof onRowClick === 'function') onRowClick(r.dim, r);
    });
    return tr;
  }

  function buildFooter(rows, cfg, totalGp, unit) {
    var tfoot = document.createElement('tfoot');
    var tr = document.createElement('tr');
    tr.className = 'mexp-foot';

    var sumGp = rows.reduce(function (s, r) { return s + (+r.gp || 0); }, 0);
    var sumTons = rows.reduce(function (s, r) { return s + (+r.tons || 0); }, 0);
    var sumKg = rows.reduce(function (s, r) { return s + (+r.kg || 0); }, 0);
    var gpTotal = (totalGp != null) ? +totalGp : sumGp;

    // Weighted primary for the total row.
    var primaryStr = '—';
    if (unit === 'gp') {
      primaryStr = _fc(gpTotal);
    } else if (unit === 'gp_pct') {
      var sumSales = rows.reduce(function (s, r) { return s + (+r.sales || 0); }, 0);
      if (sumSales) primaryStr = cfg.fmt(sumGp / sumSales * 100);
    } else {
      // kg / ton: weighted GM per kg = total GP / total kg, scaled
      if (sumKg) primaryStr = cfg.fmt(gpTotal / sumKg * cfg.scale);
    }

    tr.innerHTML =
      '<td class="mexp-c-dim">Total</td>' +
      '<td class="mexp-primary">' + _esc(primaryStr) + '</td>' +
      '<td>' + _esc(_fc(gpTotal)) + '</td>' +
      '<td>100.0%</td>' +
      '<td>' + _esc(fmtTons(sumTons)) + '</td>' +
      '<td></td>';
    tfoot.appendChild(tr);
    return tfoot;
  }
})();
