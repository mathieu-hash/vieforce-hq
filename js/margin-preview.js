/* Separate executive preview. All business data comes from the authenticated endpoint. */
function mountMarginExplorerV2(root, prefix) {
  'use strict';
  var $ = function (s) { return document.getElementById((prefix || '') + s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var n = function (v, digits) { return v == null ? '—' : Number(v).toLocaleString('en-PH', { maximumFractionDigits: digits == null ? 0 : digits }); };
  var money = function (v) { return v == null ? '—' : '₱' + n(v); };
  var fixed = function (v, d) { return v == null ? '—' : Number(v).toLocaleString('en-PH', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  var signedMoney = function (v) { return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + '₱' + n(Math.abs(v)); };
  var signed = function (v) { return v == null ? '—' : (v > 0 ? '+' : '') + n(v); };
  var month = function (s) { return new Date(s + '-01T12:00:00').toLocaleDateString('en', { month: 'short', year: '2-digit' }); };
  var now = new Date(), ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).format(now);
  if (!/^\d{4}-\d{2}$/.test(ym)) ym = now.toISOString().slice(0, 7);
  var previous = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 2, 1);
  var S = { asof: ym, current: ym, base: previous.getFullYear() + '-' + String(previous.getMonth() + 1).padStart(2, '0'), mode: 'same', basis: 'reported', group: 'ssg', filters: {} };
  var drillExpanded = new Set(), lastComponent = null;
  var D = null, sequence = 0, sort = 'total', direction = -1, expanded = new Map(), back = [], rowLookup = new Map();
  function params(overrides) { return Object.assign({}, S, { filters: JSON.stringify(S.filters) }, overrides || {}); }
  async function fetchData(p) { return apiFetch('margin-preview', p); }
  function controls() { ['asof', 'current', 'base', 'mode', 'basis'].forEach(function (k) { $(k).value = S[k]; }); }
  function format(v, metric) { return v == null ? '—' : metric === 'pct' ? n(v, 1) + '%' : metric === 'tons' ? n(v, 1) : n(v); }
  function status(text, error) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
  async function load() {
    var seq = ++sequence; drillExpanded.clear(); $('rm-content').textContent = ''; $('load-rm').disabled = false;
    $('apply').disabled = true; $('preview-app').setAttribute('aria-busy', 'true');
    ['history', 'opportunities', 'compare', 'kpis', 'waterfall', 'contributors'].forEach(function (id) { $(id).classList.add('loading'); });
    status('Updating selection…');
    try {
      var result = await fetchData(params());
      if (seq !== sequence || !result) return;
      D = result; expanded.clear(); render();
      status((D.source_label || 'HQ · read-only SAP') + ' · refreshed ' + new Date(D.fetched_at).toLocaleString() + ' · last posting ' + (D.window.cutoff || 'none'));
    } catch (e) { if (seq === sequence) { status('Could not load this selection. Previous results are hidden. ' + e.message, true); D = null; ['matrix', 'kpis', 'waterfall', 'contributors', 'opportunity-table', 'cross-table', 'rm-content'].forEach(function (id) { $(id).textContent = 'Data unavailable for this selection.'; }); } }
    finally { if (seq === sequence) { $('apply').disabled = false; $('preview-app').removeAttribute('aria-busy'); ['history', 'opportunities', 'compare', 'kpis', 'waterfall', 'contributors'].forEach(function (id) { $(id).classList.remove('loading'); }); } }
  }
  function dimensionOptions(select, fallback) {
    var old = select.value || fallback;
    select.innerHTML = Object.entries(D.dimensions).map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join('');
    select.value = old;
  }
  function render() {
    dimensionOptions($('group'), S.group); $('group').value = S.group;
    dimensionOptions($('next'), S.group === 'ssg' ? 'region' : 'customer'); dimensionOptions($('cross'), 'region');
    dimensionOptions($('segment'), 'customer'); $('region-filter').innerHTML = '<option value="">All regions</option>' + (D.regions || []).map(function(r){return '<option value="'+esc(r.id)+'">'+esc(r.name)+'</option>';}).join(''); $('region-filter').value=S.filters.region||''; breadcrumbs(); kpis(); matrix(); bridge(); contributors(); opportunities();
    $('definitions').textContent = D.note;
    var title;
    if ((title = $('history-title'))) title.textContent = 'Twelve months by ' + D.dimensions[S.group].toLowerCase();
    if ((title = $('opps-title'))) title.textContent = 'Pricing opportunities · sized on ' + month(S.base);
    $('cross-table').textContent = 'Choose columns and build the comparison for the current selection.';
  }
  function breadcrumbs() {
    $('breadcrumbs').innerHTML = '<button id="' + (prefix || '') + 'back" ' + (!back.length ? 'disabled' : '') + '>← Back</button><button id="' + (prefix || '') + 'clear">All finished feed</button>' + Object.entries(S.filters).map(function (x) { return '<span>›</span><button data-remove="' + x[0] + '">' + esc(D.dimensions[x[0]]) + ': ' + esc((S.labels || {})[x[0]] || x[1]) + ' ×</button>'; }).join('') + '<button id="' + (prefix || '') + 'save-view">Save this view</button><button id="' + (prefix || '') + 'restore-view">Restore saved view</button>';
    $('back').onclick = function () { if (back.length) { S = back.pop(); controls(); load(); } };
    $('clear').onclick = function () { remember(); S.filters = {}; S.labels = {}; load(); };
    $('breadcrumbs').querySelectorAll('[data-remove]').forEach(function (b) { b.onclick = function () { remember(); delete S.filters[b.dataset.remove]; load(); }; });
    $('save-view').onclick = function () { localStorage.setItem('vf_margin_preview_view', JSON.stringify(S)); status('View saved on this device.'); };
    $('restore-view').onclick = function () { try { var saved = JSON.parse(localStorage.getItem('vf_margin_preview_view')); if (saved) { remember(); S = saved; controls(); load(); } else status('No saved view on this device yet.'); } catch (_) { status('Saved view could not be restored.', true); } };
  }
  function remember() { back.push(JSON.parse(JSON.stringify(S))); }
  function focus(filters, labels) { remember(); S.filters = Object.assign({}, S.filters, filters); S.labels = Object.assign({}, S.labels, labels || {}); load(); }
  function kpis() {
    var c = D.totals.current, p = D.totals.prior, metric = S.basis === 'net' ? 'net' : 'gm';
    var gp = c.gp - (S.basis === 'net' ? c.disc : 0), gpPrior = p.gp - (S.basis === 'net' ? p.disc : 0);
    var delta = function (v, text) { return v == null ? '<small>No comparison window</small>' : '<small class="' + (v > 0 ? 'up' : v < 0 ? 'down' : '') + '">' + text + ' vs comparison window</small>'; };
    $('kpis').innerHTML = [
      [S.basis === 'net' ? 'After document discounts / t' : 'Reported margin / t', money(c[metric]), delta(c[metric] == null || p[metric] == null ? null : c[metric] - p[metric], signed(c[metric] - p[metric]) + ' /t')],
      ['Gross profit · ' + (S.basis === 'net' ? 'after discounts' : 'reported'), money(gp), delta(gp - gpPrior, signedMoney(gp - gpPrior))],
      ['Volume · tons', n(c.tons, 1), delta(c.tons - p.tons, signed(c.tons - p.tons) + ' t')],
      ['Document discounts', money(c.disc), '<small>' + money(c.kg > 0 ? c.disc / c.kg * 1000 : null) + ' /t · GL rebates excluded</small>']
    ].map(function (k) { return '<div class="kpi"><div class="label">' + k[0] + '</div><div class="value">' + k[1] + '</div>' + k[2] + '</div>'; }).join('');
  }
  function matrix() {
    if (!D) return;
    var metric = $('metric').value, search = $('search').value.toLowerCase(), heat = $('heat').checked;
    var rows = D.rows.filter(function (r) { return (r.name + ' ' + r.id).toLowerCase().includes(search); });
    function value(r) { if (sort === 'name') return r.name; if (sort === 'delta') return r.current[metric] == null || r.prior[metric] == null ? -Infinity : r.current[metric] - r.prior[metric]; return (sort === 'total' ? r.total : r.cells[sort] || {})[metric] ?? -Infinity; }
    rows.sort(function (a, b) { return direction * (typeof value(a) === 'string' ? value(a).localeCompare(value(b)) : value(a) - value(b)); });
    rowLookup.clear();
    // Months with no posted data anywhere in the selection (pre-2026 history) go to the footnote, not to a column of dashes.
    var months = D.months.filter(function (m) { return D.totals.cells[m] || D.rows.some(function (r) { return r.cells[m]; }); });
    if (!months.length) months = D.months;
    var hidden = D.months.filter(function (m) { return months.indexOf(m) < 0; });
    var isAmount = metric === 'gp' || metric === 'tons', upGood = metric !== 'cost';
    var day = function (s) { return new Date(s + 'T12:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short' }); };
    var span = function (w) { return w && w.length === 2 ? (w[0].slice(0, 7) === w[1].slice(0, 7) ? day(w[0]) + '–' + w[1].slice(8).replace(/^0/, '') : day(w[0]) + '–' + day(w[1])) : ''; };
    var windows = D.window.base && D.window.current ? span(D.window.base) + ' → ' + span(D.window.current) : '';
    var head = '<thead><tr><th data-sort="name">' + esc(D.dimensions[S.group]) + '</th><th class="spark">Trend</th>' + months.map(function (m) { return '<th data-sort="' + m + '" class="' + (m === D.window.cutoff.slice(0, 7) && D.window.partial ? 'partial' : '') + '">' + month(m) + (m === S.current && D.window.partial ? '<small>MTD · to ' + day(D.window.cutoff) + '</small>' : '') + '</th>'; }).join('') + '<th data-sort="total" class="summary" title="Period total for amounts; weighted average for rates">' + (isAmount ? 'Total' : 'Wtd avg') + '<small>' + months.length + ' months</small></th><th data-sort="delta" class="summary" title="Change over the selected bridge windows">Change<small>' + esc(windows) + '</small></th></tr></thead>';
    // Word-sized line of the row across the shown months; gaps break the line, the dashed rule is the row average, the dot is the latest month.
    function spark(cells) {
      var pts = months.map(function (m) { return (cells[m] || {})[metric]; }), vals = pts.filter(function (x) { return x != null; });
      if (vals.length < 2) return '';
      var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length, W = 84, H = 24, pad = 3;
      var x = function (i) { return (pad + i * (W - 2 * pad) / Math.max(1, months.length - 1)).toFixed(1); }, y = function (v) { return (max === min ? H / 2 : H - pad - (v - min) / (max - min) * (H - 2 * pad)).toFixed(1); };
      var d = [], last = -1; pts.forEach(function (v, i) { if (v == null) { d.push(null); return; } d.push((d.length && d[d.length - 1] !== null ? 'L' : 'M') + x(i) + ' ' + y(v)); last = i; });
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><line x1="0" x2="' + W + '" y1="' + y(mean) + '" y2="' + y(mean) + '"/><path d="' + d.filter(Boolean).join(' ') + '"/><circle cx="' + x(last) + '" cy="' + y(pts[last]) + '" r="2.5"/></svg>';
    }
    function changeCell(cur, prior) { var v = cur == null || prior == null ? null : cur - prior; return '<td class="summary change ' + (v > 0 ? 'positive' : v < 0 ? 'negative' : '') + '">' + signed(v) + '</td>'; }
    function row(r, group, filters, child) {
      var key = 'row' + rowLookup.size; rowLookup.set(key, { r: r, group: group, filters: filters });
      var vals = months.map(function (m) { return (r.cells[m] || {})[metric]; }).filter(function (x) { return x != null; });
      var mean = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0, spread = Math.max.apply(null, vals.map(function (v) { return Math.abs(v - mean); }).concat(0));
      return '<tr class="' + (child ? 'child' : '') + '"><td>' + (!child ? '<button class="expand" data-expand="' + key + '" aria-label="Expand ' + esc(r.name) + '">' + (expanded.has(r.id) ? '−' : '+') + '</button>' : '<span class="child-mark" aria-hidden="true">↳</span>') + '<button class="row-name" data-focus="' + key + '">' + esc(r.name) + '</button><small>' + (r.id === r.name ? '' : esc(r.id) + ' · ') + n(r.total.tons, 0) + ' t</small></td><td class="spark">' + spark(r.cells) + '</td>' + months.map(function (m) {
        var v = (r.cells[m] || {})[metric], style = '';
        // Diverging shade against the row's own average: green when the month is better than the row's norm, red when worse (cost inverts).
        if (heat && v != null && spread > 0) style = ' style="background:color-mix(in oklab,var(--' + ((v >= mean) === upGood ? 'green' : 'red') + ') ' + Math.round(Math.abs(v - mean) / spread * 28) + '%,transparent)"';
        return '<td' + style + ' class="' + (v < 0 ? 'negative' : '') + '"><button class="cell" data-cell="' + key + '" data-month="' + m + '">' + format(v, metric) + '</button></td>';
      }).join('') + '<td class="summary">' + format(r.total[metric], metric) + '</td>' + changeCell(r.current[metric], r.prior[metric]) + '</tr>';
    }
    var body = rows.map(function (r) {
      var html = row(r, S.group, {}, false), children = expanded.get(r.id);
      if (children) children.rows.forEach(function (c) { var parent = {}; parent[S.group] = r.id; html += row(c, children.group, parent, true); });
      return html;
    }).join('');
    $('matrix').innerHTML = '<table>' + head + '<tbody>' + (body || '<tr><td colspan="' + (months.length + 4) + '">No matching rows.</td></tr>') + '</tbody><tfoot><tr><td>Selection total · all rows</td><td class="spark">' + spark(D.totals.cells) + '</td>' + months.map(function (m) { return '<td>' + format((D.totals.cells[m] || {})[metric], metric) + '</td>'; }).join('') + '<td class="summary">' + format(D.totals.total[metric], metric) + '</td>' + changeCell(D.totals.current[metric], D.totals.prior[metric]) + '</tr></tfoot></table>';
    var sortedHead = $('matrix').querySelector('th[data-sort="' + sort + '"]');
    if (sortedHead) { sortedHead.classList.add('sorted'); sortedHead.setAttribute('aria-sort', direction < 0 ? 'descending' : 'ascending'); var sub = sortedHead.querySelector('small'); (sub || sortedHead).insertAdjacentHTML(sub ? 'beforebegin' : 'beforeend', '<span class="sort-arrow" aria-hidden="true">' + (direction < 0 ? '▼' : '▲') + '</span>'); }
    $('table-note').textContent = rows.length + ' rows · Columns show posted monthly actuals. ' + (hidden.length ? month(hidden[0]) + (hidden.length > 1 ? '–' + month(hidden[hidden.length - 1]) : '') + ' not shown: no posted data in this selection' + (hidden[0] < '2026-01' ? ' (pre-2026 history is unavailable, not zero)' : '') + '. ' : '') + 'Change follows the bridge dates, not necessarily the full month. Rates are weighted from pesos and tons. ' + (heat ? 'Shading compares each month with its own row average' + (upGood ? '' : '; lower cost shades green') + '. ' : '') + 'Search does not change selection totals.';
    $('matrix').querySelectorAll('[data-sort]').forEach(function (b) { b.onclick = function () { direction = sort === b.dataset.sort ? -direction : -1; sort = b.dataset.sort; matrix(); }; });
    $('matrix').querySelectorAll('[data-focus]').forEach(function (b) { b.onclick = function () { var x = rowLookup.get(b.dataset.focus), f = Object.assign({}, x.filters), l = {}; f[x.group] = x.r.id; l[x.group] = x.r.name; focus(f, l); }; });
    $('matrix').querySelectorAll('[data-expand]').forEach(function (b) { b.onclick = async function () {
      var x = rowLookup.get(b.dataset.expand), next = $('next').value;
      if (expanded.has(x.r.id)) { expanded.delete(x.r.id); matrix(); return; }
      if (next === S.group) { status('Choose a different dimension in “Expand into”.'); return; }
      var seq = sequence, filters = Object.assign({}, S.filters); filters[S.group] = x.r.id; b.disabled = true;
      try { var child = await fetchData(params({ group: next, filters: JSON.stringify(filters) })); if (seq === sequence) { expanded.set(x.r.id, { rows: child.rows, group: next }); matrix(); } } catch (e) { status(e.message, true); b.disabled = false; }
    }; });
    $('matrix').querySelectorAll('[data-cell]').forEach(function (b) { b.onclick = function () { var x = rowLookup.get(b.dataset.cell); detail(x.r, b.dataset.month, x.group, x.filters); }; });
  }
  function detail(r, m, group, filters) {
    var c = r.cells[m];
    $('detail-body').innerHTML = '<p class="eyebrow">MONTHLY EVIDENCE</p><h2>' + esc(r.name) + '</h2><p>' + month(m) + ' · ' + esc(r.id) + '</p>' + (!c ? '<p>No comparable posted data for this cell.</p>' : '<div class="detail-metrics">' + [['Tons', n(c.tons, 1)], ['Reported GM/t', money(c.gm)], ['After-discount GM/t', money(c.net)], ['Selling price/t', money(c.price)], ['COGS/t', money(c.cost)], ['Total GP', money(c.gp)]].map(function (x) { return '<div><small>' + x[0] + '</small>' + x[1] + '</div>'; }).join('') + '</div>') + '<p class="callout">Monthly aggregates, not invoice evidence. Use Focus to dissect this business further. The current bridge comparison remains fixed.</p><button class="primary" id="' + (prefix || '') + 'detail-focus">Focus this business</button>';
    $('detail-focus').onclick = function () { var f = Object.assign({}, filters), labels = {}; f[group] = r.id; labels[group] = r.name; $('detail').close(); focus(f, labels); };
    var evidenceButton = document.createElement('button'); evidenceButton.textContent = 'Show invoice evidence';
    var evidencePanel = document.createElement('div'); evidencePanel.className = 'table-scroll'; evidencePanel.style.marginTop = '18px';
    $('detail-body').appendChild(evidenceButton); $('detail-body').appendChild(evidencePanel);
    evidenceButton.onclick = async function () {
      var f = Object.assign({}, S.filters, filters); f[group] = r.id; evidenceButton.disabled = true; evidencePanel.textContent = 'Loading invoice evidence…';
      try {
        var e = await fetchData(params({ filters: JSON.stringify(f), evidence: m }));
        evidencePanel.innerHTML = '<p class="footnote">' + (e.has_more ? 'Latest 100 lines; narrow the selection for more detail.' : e.rows.length + ' lines.') + '</p><table><thead><tr><th>Document / SKU</th><th>Date</th><th>Kg</th><th>Revenue</th><th>COGS</th><th>GP</th><th>Doc discount</th></tr></thead><tbody>' + e.rows.map(function (x) { return '<tr><td>' + esc(x.type + ' ' + x.DocNum + ' / line ' + x.LineNum) + '<small>' + esc(x.sku + ' · ' + x.customer + ' · Entry ' + x.DocEntry) + '</small></td><td>' + esc(x.date) + '</td><td>' + n(x.kg, 1) + '</td><td>' + money(x.revenue) + '</td><td>' + money(x.revenue - x.gp) + '</td><td>' + money(x.gp) + '</td><td>' + money(x.disc) + '</td></tr>'; }).join('') + '</tbody></table>';
      } catch (e) { evidencePanel.textContent = 'Evidence unavailable. ' + e.message; } finally { evidenceButton.disabled = false; }
    };
    $('detail').showModal();
  }
  function bridge() {
    var b = D.bridge;
    $('waterfall').style.height = b.available ? '' : 'auto';
    $('bridge-title').textContent = 'Why margin per ton changed';
    $('windows').textContent = D.window.base.join(' → ') + ' compared with ' + D.window.current.join(' → ') + ' · ' + (S.basis === 'net' ? 'after document discounts' : 'reported GP') + ' · PHP/t';
    if (!b.available) { $('waterfall').textContent = b.reason; $('reconciles').textContent = 'Insufficient volume'; $('reconciles').className = 'pill warn'; $('bridge-note').textContent = 'Both comparison windows need positive volume.'; return; }
    var stable = b.mix_ordering.sign_stable;
    var vals = [{ label: 'Base', value: b.gm0_per_ton, total: true }, { label: 'Price', value: b.price, driver: 'price' }, { label: 'Cost', value: b.cost, driver: 'cost' }];
    if (stable) vals.push({ label: 'Customer mix', value: b.customer_mix, driver: 'customer_mix' }, { label: 'Product mix', value: b.product_mix, driver: 'product_mix' }); else vals.push({ label: 'Combined mix', value: b.mix_total, driver: 'mix' });
    vals.push({ label: 'Current', value: b.gm1_per_ton, total: true });
    var running = 0; vals.forEach(function (v) { v.bottom = v.total ? Math.min(0, v.value) : Math.min(running, running + v.value); v.top = v.total ? Math.max(0, v.value) : Math.max(running, running + v.value); running = v.total ? v.value : running + v.value; });
    // The axis starts below the lowest level reached, not at zero: on a 6,000 PHP/t base a 250 PHP/t
    // effect is otherwise a hairline. Total bars are cut at the floor and the floor is printed.
    var levels = vals.map(function (v) { return v.total ? v.value : v.bottom; }).concat(vals.map(function (v) { return v.top; }));
    var lowest = Math.min.apply(null, levels), highest = Math.max.apply(null, levels), span = Math.max(1, highest - lowest);
    var lo = lowest > 0 ? Math.max(0, lowest - span * 0.6) : Math.min(0, lowest), hi = highest + span * 0.05, range = Math.max(1, hi - lo);
    vals.forEach(function (v) { if (v.total) v.bottom = lo; });
    $('waterfall').innerHTML = vals.map(function (v) { var height = (v.top - v.bottom) / range * 160, bottom = (v.bottom - lo) / range * 160; return '<div class="bar-col"><span class="bar-value" style="bottom:' + (bottom + height + 8) + 'px">' + (v.total ? money(v.value) : signed(v.value)) + '</span><button title="' + esc(v.label) + ': ' + n(v.value) + ' PHP/t" ' + (v.driver ? 'data-driver="' + v.driver + '"' : '') + ' class="bar ' + (v.total ? '' : v.value >= 0 ? 'up' : 'down') + '" style="height:' + height + 'px;bottom:' + bottom + 'px"></button><span class="bar-label">' + v.label + '</span></div>'; }).join('') + (lo > 0 ? '<span class="axis-note">axis from ' + money(lo) + '/t</span>' : '');
    $('reconciles').textContent = b.reconciles ? '✓ Reconciles' : 'Reconciliation failed';
    $('reconciles').className = 'pill ' + (b.reconciles ? 'ok' : 'warn');
    var notes = [D.window.note, 'Matched cells: ' + n(b.mix_detail.matched_kg_share * 100, 1) + '% of current tons.'];
    if (!stable) notes.push('Customer/product split changes sign with ordering; combined mix is shown.');
    if (!D.window.mix_comparable || b.mix_detail.churn_dominated) notes.push('Interpret mix cautiously: unequal windows or one-sided orders can reflect timing, not churn.');
    if (b.dropped_cells.prior || b.dropped_cells.current) notes.push('Bridge excludes ' + (b.dropped_cells.prior + b.dropped_cells.current) + ' non-positive-volume cells; its endpoints may differ from the table.');
    if (D.company_contribution != null && Object.keys(S.filters).length) notes.push('Selected customer/SKU contribution to national change: ' + signed(D.company_contribution) + ' PHP/t (fixed company denominator).');
    $('bridge-note').textContent = notes.join(' ');
    $('waterfall').querySelectorAll('[data-driver]').forEach(function (b) { b.onclick = function () { $('driver').value = b.dataset.driver; contributors(); $('contributors').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }; });
  }
  function shareMarkers(r) {
    var a=Math.max(0,Math.min(100,r.share0*100)), b=Math.max(0,Math.min(100,r.share1*100));
    return '<span class="share-track" aria-hidden="true"><i style="left:'+Math.min(a,b)+'%;width:'+Math.abs(b-a)+'%"></i><b style="left:'+a+'%"></b><b class="after" style="left:'+b+'%"></b></span>'+n(r.share0*100,1)+'% → '+n(r.share1*100,1)+'% <strong>'+((r.share1-r.share0)>0?'+':'')+n((r.share1-r.share0)*100,1)+' pp</strong>';
  }
  function componentTable() {
    var driver=$('driver').value, isMix=driver==='customer_mix'||driver==='product_mix'||driver==='mix';
    if(lastComponent!==driver){drillExpanded.clear();if(isMix)$('segment').value=driver==='customer_mix'?'customer':'sku';lastComponent=driver;}
    $('rm-module').hidden=driver!=='cost'; $('drill-group-label').hidden=isMix; $('segment-label').hidden=!isMix||driver==='mix';
    var definitions={price:'Price',cost:'Cost',customer_mix:'Customer mix',product_mix:'Product mix'};
    $('component-tabs').innerHTML=Object.entries(definitions).map(function(x){return '<button data-component="'+x[0]+'" class="'+(driver===x[0]?'active':'')+'"><span>'+x[1]+'</span><strong>'+signed(D.bridge.available?D.bridge[x[0]]:null)+' <small>PHP/t</small></strong></button>';}).join('');
    $('component-tabs').querySelectorAll('[data-component]').forEach(function(b){b.onclick=function(){$('driver').value=b.dataset.component;contributors();};});
    if(!D.bridge.available){$('component-note').textContent='';$('contributors').textContent='Both windows need positive volume to explain this component.';return;}
    if(isMix){segmentDrill();return;}
    var rate=driver, cells=D.contributors.filter(function(r){return r.matched;}), by=$('drill-group').value, lookup=[], max=0;
    function group(list,dim,path){var map=new Map();list.forEach(function(r){var id=String(r[dim]||'UNKNOWN');if(!map.has(id))map.set(id,{id:id,name:r[dim+'_name']||id,dim:dim,rows:[],path:path.concat(id)});map.get(id).rows.push(r);});return [...map.values()].map(function(g){g.effect=g.rows.reduce(function(v,r){return v+r[driver];},0);g.tons0=g.rows.reduce(function(v,r){return v+r.tons0;},0);g.tons1=g.rows.reduce(function(v,r){return v+r.tons1;},0);g.before=g.rows.reduce(function(v,r){return v+r[rate+'0']*r.tons0;},0)/g.tons0;g.after=g.rows.reduce(function(v,r){return v+r[rate+'1']*r.tons1;},0)/g.tons1;return g;}).sort(function(a,b){return Math.abs(b.effect)-Math.abs(a.effect);});}
    var roots=group(cells,by,[]), top=$('segment-all').checked?roots:roots.slice(0,7);
    function gather(gs){gs.forEach(function(g){max=Math.max(max,Math.abs(g.effect));if(g.dim!=='sku'&&drillExpanded.has(JSON.stringify(g.path))){g.children=group(g.rows,g.dim==='ssg'?'customer':'sku',g.path);gather(g.children);}});}gather(top);
    function draw(gs,depth){return gs.map(function(g){var index=lookup.length;lookup.push(g);var open=drillExpanded.has(JSON.stringify(g.path));return '<tr class="'+(depth?'child':'')+'"><td style="padding-left:'+(12+depth*24)+'px">'+(g.dim!=='sku'?'<button class="expand" data-drill-expand="'+index+'" aria-expanded="'+open+'" aria-label="'+(open?'Collapse ':'Expand ')+esc(g.name)+'">'+(open?'−':'+')+'</button>':'')+'<button class="row-name" data-drill-focus="'+index+'">'+esc(g.name)+'</button><small>'+esc(g.id)+'</small></td><td><div class="effect-cell">'+effectBar(g.effect,max)+'</div></td><td>'+money(g.before)+' → <strong>'+money(g.after)+'</strong></td><td>'+n(g.tons0,1)+' → '+n(g.tons1,1)+'</td></tr>'+(g.children?draw(g.children,depth+1):'');}).join('');}
    var sum=roots.reduce(function(v,g){return v+g.effect;},0);
    $('contributors').innerHTML='<table class="visual-drill"><thead><tr><th>'+ (by==='ssg'?'Feed category → Customer → SKU':'Customer → SKU')+'</th><th>Margin effect PHP/t</th><th>'+definitions[driver]+' /t before → after</th><th>Matched tons before → after</th></tr></thead><tbody>'+draw(top,0)+(!top.length?'<tr><td colspan="4">No matched customer/SKU cells.</td></tr>':'')+'</tbody><tfoot><tr><td>Other · '+(roots.length-top.length)+' groups</td><td>'+signed(roots.slice(top.length).reduce(function(v,g){return v+g.effect;},0))+'/t</td><td colspan="2">Children explain their parent; do not add both</td></tr><tr><td>'+definitions[driver]+' bridge total</td><td>'+signed(D.bridge[driver])+'/t</td><td colspan="2">'+(Math.abs(sum-D.bridge[driver])<1e-6?'✓ reconciles before rounding':'Reconciliation unavailable')+'</td></tr></tfoot></table>';
    $('component-note').textContent='Expand + to see the rows behind each impact; click a name to focus the whole analysis. Effects sum matched customer × SKU contributions on the fixed selected-scope denominator. Parent rates are weighted averages and can change with the SKU mix; their difference is not the isolated '+rate+' effect. '+(driver==='cost'?'Higher cost reduces margin.':'Selling prices follow the selected margin basis.');
    $('contributors').querySelectorAll('[data-drill-expand]').forEach(function(b){b.onclick=function(){var k=JSON.stringify(lookup[+b.dataset.drillExpand].path);if(drillExpanded.has(k))drillExpanded.delete(k);else drillExpanded.add(k);contributors();};});
    $('contributors').querySelectorAll('[data-drill-focus]').forEach(function(b){b.onclick=function(){var g=lookup[+b.dataset.drillFocus],f={},l={},dims=by==='ssg'?['ssg','customer','sku']:['customer','sku'];g.path.forEach(function(id,i){f[dims[i]]=id;l[dims[i]]=g.rows[0][dims[i]+'_name']||id;});focus(f,l);};});
  }
  function contributors(){if(D)componentTable();}
  function opportunities() {
    if (!D) return;
    var rows = D.opportunities.filter(function (r) { return r.php >= Number($('minimum').value); });
    $('opportunity-table').innerHTML = '<table><thead><tr><th>Customer / SKU</th><th>Evidence</th><th>Base tons</th><th>Current price/kg</th><th>Net GM/kg</th><th>Indicative +/kg</th><th>GP / base month</th><th>Company PHP/t</th></tr></thead><tbody>' + rows.map(function (r, i) { return '<tr><td><button class="row-name" data-opportunity="' + i + '">' + esc(r.customer_name) + '</button><small>' + esc(r.sku + ' · ' + r.sku_name) + '</small></td><td class="text">' + esc(r.reason) + '</td><td>' + n(r.tons, 1) + '</td><td>' + fixed(r.price, 2) + '</td><td>' + fixed(r.net, 2) + '</td><td>' + fixed(r.uplift, 2) + '</td><td>' + money(r.php) + '</td><td>' + fixed(r.impact, 1) + '</td></tr>'; }).join('') + (!rows.length ? '<tr><td colspan="8">No candidates clear the volume and evidence thresholds for this selection.</td></tr>' : '') + '</tbody></table>';
    $('opportunity-table').querySelectorAll('[data-opportunity]').forEach(function (b) { b.onclick = function () { opportunityDetail(rows[+b.dataset.opportunity]); }; });
  }
  function opportunityDetail(r) {
    $('detail-body').innerHTML = '<p class="eyebrow">PRICING OPPORTUNITY · FOR COMMERCIAL REVIEW</p><h2>' + esc(r.customer_name) + '</h2><p>' + esc(r.sku + ' · ' + r.sku_name) + '</p><p class="callout">' + esc(r.caveat) + '</p><p>' + esc(r.reason) + ' · ' + esc(r.evidence) + ' · peers from ' + month(r.peer_month) + ' · sized on ' + month(r.sizing_month) + '</p><div class="table-scroll"><table><thead><tr><th>Peers · same period</th><th>Tons</th><th>Net price/kg</th></tr></thead><tbody>' + r.peers.map(function (p) { return '<tr><td>' + esc(p.name) + '<small>' + esc(p.customer) + '</small></td><td>' + n(p.tons, 1) + '</td><td>' + fixed(p.net_price, 2) + '</td></tr>'; }).join('') + (!r.peers.length ? '<tr><td colspan="3">Cost-drift candidate; no qualified direct peer set.</td></tr>' : '') + '</tbody></table></div><h3>Test a full-month scenario</h3><div class="scenario"><label>Price increase · PHP/kg<input id="' + (prefix || '') + 'scenario-uplift" type="number" step="0.05" min="0" value="' + r.uplift.toFixed(2) + '"></label><label>Assumed volume loss · %<input id="' + (prefix || '') + 'scenario-loss" type="number" min="0" max="100" value="0"></label></div><p id="' + (prefix || '') + 'scenario-result" class="callout"></p><p class="muted">Fixed company base tons for comparability. Assumes booked cost/kg is avoidable on lost volume; overhead and customer replacement are not modelled. A sensitivity, not a forecast.</p><button class="primary" id="' + (prefix || '') + 'opportunity-focus">Explore this customer and SKU</button>';
    function scenario() { var u = Math.max(0, Number($('scenario-uplift').value) || 0), loss = Math.max(0, Math.min(100, Number($('scenario-loss').value) || 0)) / 100, kg = r.tons * 1000, reported = kg * ((1 - loss) * u - loss * (r.price - r.cost)), net = kg * ((1 - loss) * u * (1 - r.discount_rate) - loss * r.net); $('scenario-result').textContent = 'Change in reported GP: ' + money(reported) + ' / month · after discounts: ' + money(net) + ' · company impact at fixed base volume: ' + signed(D.national_base_tons ? reported / D.national_base_tons : null) + ' PHP/t.'; }
    $('scenario-uplift').oninput = scenario; $('scenario-loss').oninput = scenario; scenario();
    $('opportunity-focus').onclick = function () { $('detail').close(); focus({ customer: r.customer, sku: r.sku }, { customer: r.customer_name, sku: r.sku_name }); };
    $('detail').showModal();
  }
  async function cross() {
    if (!D) return;
    var col = $('cross').value, metric = $('metric').value, seq = sequence, rows = D.rows.slice(0, 30);
    if (col === S.group) { $('cross-table').textContent = 'Choose a column dimension different from the row dimension.'; return; }
    $('build-cross').disabled = true; $('cross-table').textContent = 'Building comparison…';
    try {
      // Bounded batches avoid flooding the read-only API with parallel requests.
      var data = [];
      for (var i = 0; i < rows.length; i += 4) { var chunk = await Promise.all(rows.slice(i, i + 4).map(function (r) { var f = Object.assign({}, S.filters); f[S.group] = r.id; return fetchData(params({ group: col, filters: JSON.stringify(f) })); })); data.push.apply(data, chunk); if (seq !== sequence) return; }
      var cols = new Map(); data.forEach(function (d) { d.rows.forEach(function (r) { cols.set(r.id, r.name); }); });
      var columns = [...cols].slice(0, 20);
      $('cross-table').innerHTML = '<p class="footnote">Up to 30 rows × 20 columns · ' + esc(D.dimensions[S.group]) + ' × ' + esc(D.dimensions[col]) + ' · comparison window actuals. Additional rows remain available in Monthly explorer.</p><table><thead><tr><th>' + esc(D.dimensions[S.group]) + '</th>' + columns.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (r, i) { return '<tr><td>' + esc(r.name) + '</td>' + columns.map(function (c, j) { var cell = data[i].rows.find(function (x) { return x.id === c[0]; }); return '<td><button class="cell" data-cross-row="' + i + '" data-cross-col="' + j + '">' + format(cell ? cell.current[metric] : null, metric) + '</button></td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
      $('cross-table').querySelectorAll('[data-cross-row]').forEach(function (b) { b.onclick = function () { var r = rows[+b.dataset.crossRow], c = columns[+b.dataset.crossCol], f = {}, l = {}; f[S.group] = r.id; f[col] = c[0]; l[S.group] = r.name; l[col] = c[1]; focus(f, l); }; });
    } catch (e) { if (seq === sequence) $('cross-table').textContent = 'Comparison unavailable. ' + e.message; } finally { $('build-cross').disabled = false; }
  }

  function effectBar(v, max) {
    var width = max > 0 ? Math.min(50, Math.abs(v) / max * 50) : 0;
    return '<span class="effect-track" aria-hidden="true"><i class="' + (v < 0 ? 'loss' : 'gain') + '" style="left:' + (v < 0 ? 50-width : 50) + '%;width:' + width + '%"></i></span><strong class="' + (v < 0 ? 'negative' : 'positive') + '">' + signed(v) + '/t</strong>';
  }
  function segmentDrill() {
    if(!D)return;
    var dim=$('segment').value,driver=$('driver').value,combined=driver==='mix',drill=(D.segment_drills||{})[dim]; if(combined)drill={center:(D.bridge.gm0_per_ton+D.bridge.gm1_per_ton)/2,total:D.bridge.mix_total,rows:D.contributors.map(function(r){return Object.assign({},r,{id:r.customer+' · '+r.sku,name:r.customer_name+' · '+r.sku_name,value:r.mix,gm_ton0:r.tons0?r.price0-r.cost0:null,gm_ton1:r.tons1?r.price1-r.cost1:null});})};
    if(!drill){$('contributors').textContent='Both windows need positive volume.';return;}
    var canonical=combined||(driver==='customer_mix'&&dim==='customer')||(driver==='product_mix'&&dim==='sku'),adjustment=canonical&&!combined?D.component_drills[driver].adjustment:0;
    var all=drill.rows.slice().sort(function(a,b){return Math.abs(b.value)-Math.abs(a.value);}),top=$('segment-all').checked?all:all.slice(0,7),max=Math.max.apply(null,all.map(function(r){return Math.abs(r.value);}));
    $('component-note').textContent='Centred share effects against '+money(drill.center)+'/t. Open marker = before; blue = after. '+(combined?'Customer × SKU share effects reconcile to combined mix.':canonical?'The shared interaction adjustment reconciles this view to the selected bridge component.':'Alternative segment view: its total is not the selected bridge component, and must not be added to other segment views.')+' New/absent in a window may reflect timing. '+(!D.bridge.mix_ordering.sign_stable?'The customer/product split changes sign with ordering; interpret combined mix instead. ':'')+(!D.window.mix_comparable?'Windows are not comparable for interpreting mix.':'');
    $('contributors').innerHTML='<table class="visual-drill"><thead><tr><th>'+(combined?'Customer · SKU':esc(D.dimensions[dim]))+'</th><th>Share effect PHP/t</th><th>Volume share before → after</th><th>GM/t before → after</th></tr></thead><tbody>'+top.map(function(r,i){return '<tr><td><button class="row-name" data-segment-row="'+i+'">'+esc(r.name)+'</button>'+(!r.tons0?'<span class="tag">New to window</span>':!r.tons1?'<span class="tag">Absent this window</span>':'')+'<small>'+esc(r.id)+'</small></td><td><div class="effect-cell">'+effectBar(r.value,max)+'</div></td><td>'+shareMarkers(r)+'</td><td>'+money(r.gm_ton0)+' → <strong>'+money(r.gm_ton1)+'</strong></td></tr>';}).join('')+'</tbody><tfoot><tr><td>Other · '+(all.length-top.length)+' rows</td><td>'+signed(all.slice(top.length).reduce(function(v,r){return v+r.value;},0))+'/t</td><td colspan="2">Ranked by absolute effect</td></tr>'+(canonical&&!combined?'<tr><td>Shared customer–product interaction</td><td>'+signed(adjustment)+'/t</td><td colspan="2">Not assigned to individual rows</td></tr>':'')+'<tr><td>'+(canonical?(combined?'Combined mix':driver==='customer_mix'?'Customer mix':'Product mix')+' bridge total':esc(D.dimensions[dim])+' share effect')+'</td><td>'+signed(drill.total+adjustment)+'/t</td><td colspan="2">'+(canonical?'✓ reconciles before rounding':'Alternative view within selected scope')+'</td></tr></tfoot></table>';
    $('contributors').querySelectorAll('[data-segment-row]').forEach(function(b){b.onclick=function(){var r=top[+b.dataset.segmentRow],f={},l={};if(combined){f={customer:r.customer,sku:r.sku};l={customer:r.customer_name,sku:r.sku_name};}else{f[dim]=r.id;l[dim]=r.name;}focus(f,l);};});
  }
  async function rmDrill() {
    var seq=sequence;$('load-rm').disabled=true;$('rm-content').textContent='Loading recipes and issue-price evidence…';
    try {
      var data=await fetchData(params({rm:'1'}));if(seq!==sequence)return;
      if(!data.available){$('rm-content').textContent=data.reason;return;}
      var max=Math.max.apply(null,data.rows.map(function(r){return Math.abs(r.effect);}));
      $('rm-content').innerHTML='<p class="callout">ESTIMATE · '+esc(data.base)+' full-month basket → '+esc(data.current)+' issue prices (MTD if partial). Direct RM: <strong>'+signed(data.rm_effect)+'/t</strong> · Basemix/premix: <strong>'+signed(data.premix_effect)+'/t</strong>. Not a reconciliation to the invoice Cost bar.</p><p>Recipe coverage: <strong>'+n(data.recipe_coverage*100,1)+'%</strong> of base sales. Fully priced recipes: <strong>'+n(data.full_price_coverage*100,1)+'%</strong>. Matched component quantity: '+n(data.component_price_coverage*100,1)+'%. Base basket: '+n(data.base_tons,1)+' t.</p><div class="table-scroll"><table class="visual-drill"><thead><tr><th>Ingredient · click for SKU / plant</th><th>Estimated effect</th><th>Issue PHP/kg before → after</th><th>Equivalent kg / selected feed ton</th></tr></thead><tbody>'+data.rows.map(function(r,i){return '<tr><td><button class="row-name" data-rm-row="'+i+'">'+esc(r.name)+'</button><small>'+esc(r.code)+' · '+(r.group===101?'Direct RM':'Basemix / premix')+'</small></td><td><div class="effect-cell">'+effectBar(r.effect,max)+'</div></td><td>'+n(r.price0,2)+' → '+n(r.price1,2)+'</td><td>'+n(r.inclusion_kg_t,1)+'</td></tr>';}).join('')+'</tbody></table></div><p class="footnote">'+esc(data.method)+'</p><p class="footnote">'+esc(data.limitations)+'</p><details><summary>Coverage gaps · '+data.missing.length+' records (tonnage not additive)</summary>'+data.missing.map(function(r){return '<p>'+esc(r.sku+' · '+r.plant+' · '+(r.ingredient||'')+' — '+r.reason)+'</p>';}).join('')+'</details>';
      $('rm-content').querySelectorAll('[data-rm-row]').forEach(function(b){b.onclick=function(){var r=data.rows[+b.dataset.rmRow];$('detail-body').innerHTML='<h2>'+esc(r.name)+'</h2><p>Fixed base recipe and sales basket · estimated selected-scope effect</p><div class="table-scroll"><table><thead><tr><th>SKU / plant</th><th>Base tons</th><th>Recipe kg/t</th><th>PHP/kg before → after</th><th>Effect PHP/t</th></tr></thead><tbody>'+r.details.map(function(d){return '<tr><td>'+esc(d.sku_name)+'<small>'+esc(d.sku+' · '+d.plant)+'</small></td><td>'+n(d.tons,1)+'</td><td>'+n(d.inclusion_kg_t,1)+'</td><td>'+n(d.price0,2)+' → '+n(d.price1,2)+'</td><td>'+signed(d.effect)+'</td></tr>';}).join('')+'</tbody></table></div>';$('detail').showModal();};});
    }catch(e){if(seq===sequence)$('rm-content').textContent='RM detail unavailable. '+e.message;}finally{if(seq===sequence)$('load-rm').disabled=false;}
  }
  function exportTable() {
    if (!D) return;
    var metric = $('metric').value;
    function csv(v) { var x = String(v == null ? '' : v); if (/^[=+@-]/.test(x) && typeof v !== 'number') x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; }
    var rows = [['Finished feed 103; credit memos netted', metric, JSON.stringify(S.filters), 'Base', ...D.window.base, 'Current', ...D.window.current], [D.dimensions[S.group], 'Code', ...D.months, 'Period total or weighted rate']];
    D.rows.forEach(function (r) { rows.push([r.name, r.id, ...D.months.map(function (m) { return (r.cells[m] || {})[metric]; }), r.total[metric]]); });
    rows.push(['Selection total', '', ...D.months.map(function (m) { return (D.totals.cells[m] || {})[metric]; }), D.totals.total[metric]]);
    var url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(function (r) { return r.map(csv).join(','); }).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = 'margin-' + S.group + '-' + S.asof + '.csv'; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  $('segment').onchange=segmentDrill; $('segment-all').onchange=contributors; $('drill-group').onchange=function(){drillExpanded.clear();contributors();}; $('region-filter').onchange=function(){remember();S.labels=S.labels||{};if(this.value){S.filters.region=this.value;S.labels.region=this.value;}else{delete S.filters.region;delete S.labels.region;}load();}; $('load-rm').onclick=rmDrill;
  controls();
  $('apply').onclick = function () { remember(); ['asof', 'base', 'current', 'mode', 'basis'].forEach(function (k) { S[k] = $(k).value; }); load(); };
  $('group').onchange = function () { remember(); S.group = this.value; load(); };
  ['metric', 'heat'].forEach(function (id) { $(id).onchange = matrix; }); $('search').oninput = matrix;
  $('next').onchange = function () { expanded.clear(); matrix(); };
  $('driver').onchange = contributors; $('minimum').oninput = opportunities; $('build-cross').onclick = cross; $('export').onclick = exportTable;
  $('detail').querySelector('.close').onclick = function () { $('detail').close(); };
  root.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { root.querySelectorAll('[data-view]').forEach(function (x) { x.classList.toggle('active', x === b); }); ['history', 'opportunities', 'compare'].forEach(function (v) { $(v).hidden = v !== b.dataset.view; }); }; });
  // Endpoint remains authoritative for authentication; an expired session produces an explicit error.
  load();
  return { refresh: load };
}
if (document.getElementById('preview-app')) mountMarginExplorerV2(document.body, '');

