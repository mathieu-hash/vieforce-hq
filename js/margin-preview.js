/* Separate executive preview. All business data comes from the authenticated endpoint. */
(function () {
  'use strict';
  var $ = function (s) { return document.getElementById(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var n = function (v, digits) { return v == null ? '—' : Number(v).toLocaleString('en-PH', { maximumFractionDigits: digits == null ? 0 : digits }); };
  var money = function (v) { return v == null ? '—' : '₱' + n(v); };
  var signed = function (v) { return v == null ? '—' : (v > 0 ? '+' : '') + n(v); };
  var month = function (s) { return new Date(s + '-01T12:00:00').toLocaleDateString('en', { month: 'short', year: '2-digit' }); };
  var now = new Date(), ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).format(now);
  if (!/^\d{4}-\d{2}$/.test(ym)) ym = now.toISOString().slice(0, 7);
  var previous = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 2, 1);
  var S = { asof: ym, current: ym, base: previous.getFullYear() + '-' + String(previous.getMonth() + 1).padStart(2, '0'), mode: 'same', basis: 'reported', group: 'ssg', filters: {} };
  var D = null, sequence = 0, sort = 'total', direction = -1, expanded = new Map(), back = [], rowLookup = new Map();
  function params(overrides) { return Object.assign({}, S, { filters: JSON.stringify(S.filters) }, overrides || {}); }
  async function fetchData(p) { return apiFetch('margin-preview', p); }
  function controls() { ['asof', 'current', 'base', 'mode', 'basis'].forEach(function (k) { $(k).value = S[k]; }); }
  function format(v, metric) { return v == null ? '—' : metric === 'pct' ? n(v, 1) + '%' : metric === 'tons' ? n(v, 1) : n(v); }
  function status(text, error) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
  async function load() {
    var seq = ++sequence;
    $('apply').disabled = true; $('preview-app').setAttribute('aria-busy', 'true');
    ['history', 'opportunities', 'compare', 'kpis', 'waterfall', 'contributors'].forEach(function (id) { $(id).classList.add('loading'); });
    status('Updating selection…');
    try {
      var result = await fetchData(params());
      if (seq !== sequence || !result) return;
      D = result; expanded.clear(); render();
      status((D.source_label || 'HQ · read-only SAP') + ' · refreshed ' + new Date(D.fetched_at).toLocaleString() + ' · last posting ' + (D.window.cutoff || 'none'));
    } catch (e) { if (seq === sequence) { status('Could not load this selection. Previous results are hidden. ' + e.message, true); D = null; ['matrix', 'kpis', 'waterfall', 'contributors', 'opportunity-table', 'cross-table'].forEach(function (id) { $(id).textContent = 'Data unavailable for this selection.'; }); } }
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
    breadcrumbs(); kpis(); matrix(); bridge(); contributors(); opportunities();
    $('definitions').textContent = D.note;
    $('cross-table').textContent = 'Choose columns and build the comparison for the current selection.';
  }
  function breadcrumbs() {
    $('breadcrumbs').innerHTML = '<button id="back" ' + (!back.length ? 'disabled' : '') + '>← Back</button><button id="clear">All finished feed</button>' + Object.entries(S.filters).map(function (x) { return '<span>›</span><button data-remove="' + x[0] + '">' + esc(D.dimensions[x[0]]) + ': ' + esc((S.labels || {})[x[0]] || x[1]) + ' ×</button>'; }).join('') + '<button id="save-view">Save this view</button><button id="restore-view">Restore saved view</button>';
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
    var gp = c.gp - (S.basis === 'net' ? c.disc : 0);
    $('kpis').innerHTML = [
      [S.basis === 'net' ? 'After document discounts / t' : 'Reported margin / t', money(c[metric]), signed(c[metric] == null || p[metric] == null ? null : c[metric] - p[metric]) + ' /t vs comparison'],
      ['Gross profit · selected basis', money(gp), 'Always read profit alongside unit margin'],
      ['Volume · tons', n(c.tons, 1), signed(c.tons - p.tons) + ' tons vs comparison'],
      ['Document discounts', money(c.disc), money(c.kg > 0 ? c.disc / c.kg * 1000 : null) + ' /t · GL rebates excluded']
    ].map(function (k) { return '<div class="kpi"><div class="label">' + k[0] + '</div><div class="value">' + k[1] + '</div><small>' + k[2] + '</small></div>'; }).join('');
  }
  function matrix() {
    if (!D) return;
    var metric = $('metric').value, search = $('search').value.toLowerCase(), heat = $('heat').checked;
    var rows = D.rows.filter(function (r) { return (r.name + ' ' + r.id).toLowerCase().includes(search); });
    function value(r) { if (sort === 'name') return r.name; if (sort === 'delta') return r.current[metric] == null || r.prior[metric] == null ? -Infinity : r.current[metric] - r.prior[metric]; return (sort === 'total' ? r.total : r.cells[sort] || {})[metric] ?? -Infinity; }
    rows.sort(function (a, b) { return direction * (typeof value(a) === 'string' ? value(a).localeCompare(value(b)) : value(a) - value(b)); });
    rowLookup.clear();
    var head = '<thead><tr><th data-sort="name">' + esc(D.dimensions[S.group]) + '</th>' + D.months.map(function (m) { return '<th data-sort="' + m + '" class="' + (m === D.window.cutoff.slice(0, 7) && D.window.partial ? 'partial' : '') + '">' + month(m) + (m === S.current && D.window.partial ? ' · MTD' : '') + '</th>'; }).join('') + '<th data-sort="total">Period total / weighted</th><th data-sort="delta">Window Δ</th></tr></thead>';
    function row(r, group, filters, child) {
      var key = 'row' + rowLookup.size; rowLookup.set(key, { r: r, group: group, filters: filters });
      var vals = D.months.map(function (m) { return (r.cells[m] || {})[metric]; }).filter(function (x) { return x != null; });
      var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      return '<tr class="' + (child ? 'child' : '') + '"><td>' + (!child ? '<button class="expand" data-expand="' + key + '" aria-label="Expand ' + esc(r.name) + '">' + (expanded.has(r.id) ? '−' : '+') + '</button>' : '↳ ') + '<button class="row-name" data-focus="' + key + '">' + esc(r.name) + '</button><small>' + esc(r.id) + ' · ' + n(r.total.tons, 1) + ' t</small></td>' + D.months.map(function (m) {
        var v = (r.cells[m] || {})[metric], style = heat && v != null && max > min ? ' style="background:rgba(0,166,206,' + (0.03 + .16 * (v - min) / (max - min)) + ')"' : '';
        return '<td' + style + ' class="' + (v < 0 ? 'negative' : '') + '"><button class="cell" data-cell="' + key + '" data-month="' + m + '">' + format(v, metric) + '</button></td>';
      }).join('') + '<td>' + format(r.total[metric], metric) + '</td><td>' + signed(r.current[metric] == null || r.prior[metric] == null ? null : r.current[metric] - r.prior[metric]) + '</td></tr>';
    }
    var body = rows.map(function (r) {
      var html = row(r, S.group, {}, false), children = expanded.get(r.id);
      if (children) children.rows.forEach(function (c) { var parent = {}; parent[S.group] = r.id; html += row(c, children.group, parent, true); });
      return html;
    }).join('');
    $('matrix').innerHTML = '<table>' + head + '<tbody>' + (body || '<tr><td colspan="15">No matching rows.</td></tr>') + '</tbody><tfoot><tr><td>Selection total · all rows</td>' + D.months.map(function (m) { return '<td>' + format((D.totals.cells[m] || {})[metric], metric) + '</td>'; }).join('') + '<td>' + format(D.totals.total[metric], metric) + '</td><td>' + signed(D.totals.current[metric] == null || D.totals.prior[metric] == null ? null : D.totals.current[metric] - D.totals.prior[metric]) + '</td></tr></tfoot></table>';
    $('table-note').textContent = rows.length + ' rows · Columns show posted monthly actuals. Window Δ follows the bridge dates, not necessarily the full month. Rates are weighted from pesos and tons. Pre-2026 cells are unavailable, not zero. Search does not change selection totals.';
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
    $('detail-body').innerHTML = '<p class="eyebrow">MONTHLY EVIDENCE</p><h2>' + esc(r.name) + '</h2><p>' + month(m) + ' · ' + esc(r.id) + '</p>' + (!c ? '<p>No comparable posted data for this cell.</p>' : '<div class="detail-metrics">' + [['Tons', n(c.tons, 1)], ['Reported GM/t', money(c.gm)], ['After-discount GM/t', money(c.net)], ['Selling price/t', money(c.price)], ['COGS/t', money(c.cost)], ['Total GP', money(c.gp)]].map(function (x) { return '<div><small>' + x[0] + '</small>' + x[1] + '</div>'; }).join('') + '</div>') + '<p class="callout">Monthly aggregates, not invoice evidence. Use Focus to dissect this business further. The current bridge comparison remains fixed.</p><button class="primary" id="detail-focus">Focus this business</button>';
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
    $('bridge-title').textContent = 'Why this selection’s margin changed';
    $('windows').textContent = D.window.base.join(' → ') + ' compared with ' + D.window.current.join(' → ') + ' · ' + (S.basis === 'net' ? 'after document discounts' : 'reported GP') + ' · PHP/t';
    if (!b.available) { $('waterfall').textContent = b.reason; $('reconciles').textContent = 'Insufficient volume'; $('bridge-note').textContent = 'Both comparison windows need positive volume.'; return; }
    var stable = b.mix_ordering.sign_stable;
    var vals = [{ label: 'Base', value: b.gm0_per_ton, total: true }, { label: 'Price', value: b.price, driver: 'price' }, { label: 'Cost', value: b.cost, driver: 'cost' }];
    if (stable) vals.push({ label: 'Customer mix', value: b.customer_mix, driver: 'customer_mix' }, { label: 'Product mix', value: b.product_mix, driver: 'product_mix' }); else vals.push({ label: 'Combined mix', value: b.mix_total, driver: 'mix' });
    vals.push({ label: 'Current', value: b.gm1_per_ton, total: true });
    var running = 0; vals.forEach(function (v) { v.bottom = v.total ? Math.min(0, v.value) : Math.min(running, running + v.value); v.top = v.total ? Math.max(0, v.value) : Math.max(running, running + v.value); running = v.total ? v.value : running + v.value; });
    var lo = Math.min(0, ...vals.map(function (v) { return v.bottom; })), hi = Math.max(1, ...vals.map(function (v) { return v.top; })), range = hi - lo;
    $('waterfall').innerHTML = vals.map(function (v) { var height = (v.top - v.bottom) / range * 160, bottom = (v.bottom - lo) / range * 160; return '<div class="bar-col"><span class="bar-value" style="bottom:' + (bottom + height + 8) + 'px">' + signed(v.value) + '</span><button title="' + esc(v.label) + ': ' + n(v.value) + ' PHP/t" ' + (v.driver ? 'data-driver="' + v.driver + '"' : '') + ' class="bar ' + (v.total ? '' : v.value >= 0 ? 'up' : 'down') + '" style="height:' + height + 'px;bottom:' + bottom + 'px"></button><span class="bar-label">' + v.label + '</span></div>'; }).join('');
    $('reconciles').textContent = b.reconciles ? '✓ Reconciles' : 'Reconciliation failed';
    var notes = [D.window.note, 'Matched cells: ' + n(b.mix_detail.matched_kg_share * 100, 1) + '% of current tons.'];
    if (!stable) notes.push('Customer/product split changes sign with ordering; combined mix is shown.');
    if (!D.window.mix_comparable || b.mix_detail.churn_dominated) notes.push('Interpret mix cautiously: unequal windows or one-sided orders can reflect timing, not churn.');
    if (b.dropped_cells.prior || b.dropped_cells.current) notes.push('Bridge excludes ' + (b.dropped_cells.prior + b.dropped_cells.current) + ' non-positive-volume cells; its endpoints may differ from the table.');
    if (D.company_contribution != null && Object.keys(S.filters).length) notes.push('Selected customer/SKU contribution to national change: ' + signed(D.company_contribution) + ' PHP/t (fixed company denominator).');
    $('bridge-note').textContent = notes.join(' ');
    $('waterfall').querySelectorAll('[data-driver]').forEach(function (b) { b.onclick = function () { $('driver').value = b.dataset.driver; contributors(); $('contributors').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }; });
  }
  function componentTable() {
    var driver = $('driver').value;
    var definitions = { price: 'Price', cost: 'Cost', customer_mix: 'Customer mix', product_mix: 'Product mix' };
    $('component-tabs').innerHTML = Object.entries(definitions).map(function (x) { return '<button data-component="' + x[0] + '" class="' + (driver === x[0] ? 'active' : '') + '"><span>' + x[1] + '</span><strong>' + signed(D.bridge.available ? D.bridge[x[0]] : null) + ' <small>PHP/t</small></strong></button>'; }).join('');
    $('component-tabs').querySelectorAll('[data-component]').forEach(function (b) { b.onclick = function () { $('driver').value = b.dataset.component; contributors(); }; });
    $('component-note').textContent = '';
    if (!definitions[driver]) return false;
    if (!D.bridge.available) { $('contributors').textContent = 'Both windows need positive volume to explain this component.'; return true; }
    var isMix = driver === 'customer_mix' || driver === 'product_mix';
    var drill = isMix ? (D.component_drills || {})[driver] : null;
    if (isMix && !drill) { $('contributors').textContent = 'Refresh to load the new mix drill data.'; return true; }
    var rows = isMix ? drill.rows.slice() : D.contributors.filter(function (r) { return r.matched; }).slice();
    var impact = function (r) { return isMix ? r.value : r[driver]; };
    rows.sort(function (a, b) { return Math.abs(impact(b)) - Math.abs(impact(a)); });
    var top = rows.slice(0, 15), other = rows.slice(15).reduce(function (s, r) { return s + impact(r); }, 0);
    var rate = driver === 'price' ? 'price' : 'cost';
    var headers = isMix ? ['Base tons', 'Current tons', 'Base share', 'Current share', 'Share Δ · pp', 'Base GM/t', 'Current GM/t', 'Share effect · PHP/t'] : ['Base tons', 'Current tons', 'Base ' + rate + '/t', 'Current ' + rate + '/t', 'Rate Δ /t', 'Avg share', 'Effect · PHP/t'];
    var html = '<table><thead><tr><th>' + (isMix ? driver === 'customer_mix' ? 'Customer' : 'Product / SKU' : 'Customer · SKU') + '</th>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    top.forEach(function (r, i) {
      var values = isMix ? [n(r.tons0, 1), n(r.tons1, 1), n(r.share0 * 100, 2) + '%', n(r.share1 * 100, 2) + '%', (r.share_shift_pp > 0 ? '+' : '') + n(r.share_shift_pp, 2), money(r.gm_ton0), money(r.gm_ton1)] : [n(r.tons0, 1), n(r.tons1, 1), money(r[rate + '0']), money(r[rate + '1']), signed(r[rate + '1'] - r[rate + '0']), n((r.share0 + r.share1) * 50, 2) + '%'];
      var name = isMix ? r.name : r.customer_name, code = isMix ? r.id : r.customer + ' · ' + r.sku + ' · ' + r.sku_name;
      html += '<tr><td><button class="row-name" data-component-row="' + i + '">' + esc(name) + '</button><small>' + esc(code) + '</small></td>' + values.map(function (v) { return '<td>' + v + '</td>'; }).join('') + '<td class="' + (impact(r) < 0 ? 'negative' : 'positive') + '">' + signed(impact(r)) + '</td></tr>';
    });
    if (!top.length) html += '<tr><td colspan="' + (headers.length + 1) + '">No matched contributors in these windows.</td></tr>';
    html += '</tbody><tfoot><tr><td>Other · ' + Math.max(0, rows.length - top.length) + ' rows</td><td colspan="' + headers.length + '">' + signed(other) + ' PHP/t</td></tr>';
    if (isMix) html += '<tr><td>Shared customer–product interaction<small>Explicit adjustment; not assigned to individual rows</small></td><td colspan="' + headers.length + '">' + signed(drill.adjustment) + ' PHP/t</td></tr>';
    html += '<tr><td>' + definitions[driver] + ' bridge total</td><td colspan="' + headers.length + '">' + signed(D.bridge[driver]) + ' PHP/t · ' + (Math.abs(rows.reduce(function (s, r) { return s + impact(r); }, 0) + (isMix ? drill.adjustment : 0) - D.bridge[driver]) < 1e-6 ? '✓ reconciles before rounding' : 'reconciliation unavailable') + '</td></tr></tfoot></table>';
    $('contributors').innerHTML = html;
    var note = isMix ? 'Rows show centred share effects at ' + (driver === 'customer_mix' ? 'customer' : 'SKU') + ' level. The explicit interaction adjustment reconciles that view to the bridge’s symmetric split; it is not a further commercial lever. One-sided orders may reflect timing.' : 'Same customer × SKU only. Effect = average tonnage share × change in ' + rate + ', ' + (driver === 'cost' ? 'with cost increases reducing margin.' : 'on the selected reported / after-discount basis.') + ' Click a row to focus; the dates stay fixed.';
    if (isMix && !D.bridge.mix_ordering.sign_stable) note += ' Exploratory only: the customer/product split changes sign with ordering; the waterfall therefore shows combined mix.';
    if (isMix && !D.window.mix_comparable) note += ' These windows are not comparable for interpreting mix.';
    $('component-note').textContent = note;
    $('contributors').querySelectorAll('[data-component-row]').forEach(function (b) { b.onclick = function () { var r = top[+b.dataset.componentRow]; if (isMix) { var f = {}, l = {}; f[drill.dimension] = r.id; l[drill.dimension] = r.name; focus(f, l); } else focus({ customer: r.customer, sku: r.sku }, { customer: r.customer_name, sku: r.sku_name }); }; });
    return true;
  }
  function contributors() {
    if (!D) return;
    if (componentTable()) return;
    var driver = $('driver').value, rows = D.contributors.slice().sort(function (a, b) { return Math.abs(b[driver]) - Math.abs(a[driver]); }), top = rows.slice(0, 15), other = rows.slice(15).reduce(function (s, r) { return s + r[driver]; }, 0);
    $('contributors').innerHTML = '<table><thead><tr><th>Customer · SKU</th><th>Price</th><th>Cost</th><th>Mix</th><th>Total PHP/t</th></tr></thead><tbody>' + top.map(function (r, i) { return '<tr><td><button class="row-name" data-contributor="' + i + '">' + esc(r.customer_name) + '</button><small>' + esc(r.customer + ' · ' + r.sku + ' · ' + r.sku_name) + '</small></td>' + ['price', 'cost', 'mix', 'value'].map(function (k) { return '<td class="' + (r[k] < 0 ? 'negative' : 'positive') + '">' + signed(r[k]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody><tfoot><tr><td>Other · selected driver</td><td colspan="4">' + signed(other) + ' PHP/t</td></tr></tfoot></table>';
    $('contributors').querySelectorAll('[data-contributor]').forEach(function (b) { b.onclick = function () { var r = top[+b.dataset.contributor]; focus({ customer: r.customer, sku: r.sku }, { customer: r.customer_name, sku: r.sku_name }); }; });
  }
  function opportunities() {
    if (!D) return;
    var rows = D.opportunities.filter(function (r) { return r.php >= Number($('minimum').value); });
    $('opportunity-table').innerHTML = '<table><thead><tr><th>Customer / SKU</th><th>Evidence</th><th>Base tons</th><th>Current price/kg</th><th>Net GM/kg</th><th>Indicative +/kg</th><th>GP / base month</th><th>Company PHP/t</th></tr></thead><tbody>' + rows.map(function (r, i) { return '<tr><td><button class="row-name" data-opportunity="' + i + '">' + esc(r.customer_name) + '</button><small>' + esc(r.sku + ' · ' + r.sku_name) + '</small></td><td>' + esc(r.reason) + '</td><td>' + n(r.tons, 1) + '</td><td>' + n(r.price, 2) + '</td><td>' + n(r.net, 2) + '</td><td>' + n(r.uplift, 2) + '</td><td>' + money(r.php) + '</td><td>' + n(r.impact, 1) + '</td></tr>'; }).join('') + (!rows.length ? '<tr><td colspan="8">No candidates clear the volume and evidence thresholds for this selection.</td></tr>' : '') + '</tbody></table>';
    $('opportunity-table').querySelectorAll('[data-opportunity]').forEach(function (b) { b.onclick = function () { opportunityDetail(rows[+b.dataset.opportunity]); }; });
  }
  function opportunityDetail(r) {
    $('detail-body').innerHTML = '<p class="eyebrow">PRICING OPPORTUNITY · FOR COMMERCIAL REVIEW</p><h2>' + esc(r.customer_name) + '</h2><p>' + esc(r.sku + ' · ' + r.sku_name) + '</p><p class="callout">' + esc(r.caveat) + '</p><p>' + esc(r.reason) + ' · ' + esc(r.evidence) + ' · peers from ' + month(r.peer_month) + ' · sized on ' + month(r.sizing_month) + '</p><div class="table-scroll"><table><thead><tr><th>Peers · same period</th><th>Tons</th><th>Net price/kg</th></tr></thead><tbody>' + r.peers.map(function (p) { return '<tr><td>' + esc(p.name) + '<small>' + esc(p.customer) + '</small></td><td>' + n(p.tons, 1) + '</td><td>' + n(p.net_price, 2) + '</td></tr>'; }).join('') + (!r.peers.length ? '<tr><td colspan="3">Cost-drift candidate; no qualified direct peer set.</td></tr>' : '') + '</tbody></table></div><h3>Test a full-month scenario</h3><div class="scenario"><label>Price increase · PHP/kg<input id="scenario-uplift" type="number" step="0.05" min="0" value="' + r.uplift.toFixed(2) + '"></label><label>Assumed volume loss · %<input id="scenario-loss" type="number" min="0" max="100" value="0"></label></div><p id="scenario-result" class="callout"></p><p class="muted">Fixed company base tons for comparability. Assumes booked cost/kg is avoidable on lost volume; overhead and customer replacement are not modelled. A sensitivity, not a forecast.</p><button class="primary" id="opportunity-focus">Explore this customer and SKU</button>';
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
  controls();
  $('apply').onclick = function () { remember(); ['asof', 'base', 'current', 'mode', 'basis'].forEach(function (k) { S[k] = $(k).value; }); load(); };
  $('group').onchange = function () { remember(); S.group = this.value; load(); };
  ['metric', 'heat'].forEach(function (id) { $(id).onchange = matrix; }); $('search').oninput = matrix;
  $('next').onchange = function () { expanded.clear(); matrix(); };
  $('driver').onchange = contributors; $('minimum').oninput = opportunities; $('build-cross').onclick = cross; $('export').onclick = exportTable;
  $('detail').querySelector('.close').onclick = function () { $('detail').close(); };
  document.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { document.querySelectorAll('[data-view]').forEach(function (x) { x.classList.toggle('active', x === b); }); ['history', 'opportunities', 'compare'].forEach(function (v) { $(v).hidden = v !== b.dataset.view; }); }; });
  // Endpoint remains authoritative for authentication; an expired session produces an explicit error.
  load();
})();

