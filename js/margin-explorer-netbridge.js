// js/margin-explorer-netbridge.js
//
// The NET GM/ton bridge — same Bennet decomposition as the headline bridge, but on
// margin NET of the off-invoice trade discount (OINV.DiscSum), which is excluded from
// INV1.LineTotal and therefore from GrssProfit.
//
// Why this panel exists: on the reported (line) basis a list-price cut paired with a
// rebate cut reads as pure price erosion. Net of the rebate it can be flat or positive.
// The August 2026 distributor repricing is exactly that case — reported Price −38/t,
// net Price +31/t. Without this panel the dashboard cannot tell the two apart.
//
// Renders into #mexp-net-body. Read-only; no fetches of its own.
(function () {
  'use strict';

  var esc = window.esc || function (s) { return String(s == null ? '' : s); };

  function pt(n) {
    n = Math.round(+n || 0);
    var s = '₱' + Math.abs(n).toLocaleString() + '/t';
    return n > 0 ? '+' + s : (n < 0 ? '−' + s : s);
  }
  function cls(n) { return (+n > 0 ? 'pos' : (+n < 0 ? 'neg' : '')); }
  function pp(n) { n = +n || 0; return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + 'pp'; }

  // Horizontal waterfall: prior -> four bars -> current.
  function waterfall(nb) {
    var steps = [
      { label: 'Price', v: nb.price },
      { label: 'Cost', v: nb.cost },
      { label: 'Customer/BU Mix', v: nb.customer_mix },
      { label: 'Product Mix', v: nb.product_mix }
    ];
    var maxAbs = Math.max.apply(null, steps.map(function (s) { return Math.abs(+s.v || 0); }).concat([1]));
    var bars = steps.map(function (s) {
      var v = +s.v || 0;
      var w = Math.round(Math.abs(v) / maxAbs * 46);           // % of half-width
      var neg = v < 0;
      return '<div class="mnb-row">' +
        '<div class="mnb-lbl">' + esc(s.label) + '</div>' +
        '<div class="mnb-track">' +
          '<div class="mnb-mid"></div>' +
          '<div class="mnb-bar ' + (neg ? 'neg' : 'pos') + '" style="' +
            (neg ? 'right:50%;' : 'left:50%;') + 'width:' + w + '%"></div>' +
        '</div>' +
        '<div class="mnb-val ' + cls(v) + '">' + pt(v) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="mnb-wf">' +
      '<div class="mnb-end"><span>Prior GM/t</span><b>₱' + (+nb.prior_gm_ton).toLocaleString() + '</b></div>' +
      bars +
      '<div class="mnb-end tot"><span>Current GM/t</span><b>₱' + (+nb.current_gm_ton).toLocaleString() + '</b>' +
        '<i class="' + cls(nb.delta) + '">' + pt(nb.delta) + '</i></div>' +
    '</div>';
  }

  // Reported vs net, side by side — the whole point of the panel.
  function comparison(nb) {
    var v = nb.vs_reported || {};
    var d = nb.discount || {};
    var flip = (+v.price_reported < 0 && +nb.price > 0);
    var rows = [
      ['Δ GM/ton', v.delta_reported, v.delta_net],
      ['Price', v.price_reported, nb.price],
      ['Off-invoice discount', null, d.delta_per_ton]
    ].map(function (r) {
      return '<tr><td class="mnb-k">' + esc(r[0]) + '</td>' +
        '<td class="mnb-v ' + (r[1] == null ? '' : cls(r[1])) + '">' + (r[1] == null ? '<span class="mnb-blind">not visible</span>' : pt(r[1])) + '</td>' +
        '<td class="mnb-v ' + cls(r[2]) + '">' + pt(r[2]) + '</td></tr>';
    }).join('');
    return '<div class="mnb-cmp">' +
      '<table class="mnb-tbl"><thead><tr><th></th><th>Reported<br><small>line basis</small></th><th>Net<br><small>realised</small></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="mnb-wedge">Discount wedge ' + pt(d.prior_per_ton) + ' → ' + pt(d.current_per_ton) +
        ' <b class="' + cls(d.delta_per_ton) + '">' + pt(d.delta_per_ton) + '</b></div>' +
      (flip
        ? '<div class="mnb-flag">⚑ <b>Price flips sign.</b> Reported ' + pt(v.price_reported) +
          ' vs net ' + pt(nb.price) + '. A list-price cut was paired with a rebate cut — the reported bridge reads this as erosion; realised margin says otherwise. Do not call this price erosion.</div>'
        : '') +
    '</div>';
  }

  // Trust signals: is this window comparable, and is the mix split a measurement?
  function trust(nb) {
    var w = nb.window || {}, md = nb.mix_detail || {}, mo = nb.mix_ordering || {};
    var items = [];
    items.push(w.like_for_like
      ? { ok: true, t: 'Like-for-like windows — ' + w.base_window.join(' … ') + ' vs ' + w.compare_window.join(' … ') +
          ', ' + w.base_shipping_days + ' vs ' + w.compare_shipping_days + ' shipping days' }
      : { ok: false, t: 'Windows are NOT like-for-like — ' + w.base_shipping_days + ' vs ' + w.compare_shipping_days + ' shipping days' });
    if (w.compare_partial) {
      items.push({ ok: null, t: 'Compare month is ' + w.month_progress_pct + '% elapsed (last posted ' + w.last_posted_date + ') — this is an early read' });
    }
    items.push(mo.sign_stable
      ? { ok: true, t: 'Customer/Product split is stable across decomposition order' }
      : { ok: false, t: 'Customer/Product split is NOT order-stable (customer bar ranges ' +
          pt(mo.customer_range[0]) + ' … ' + pt(mo.customer_range[1]) + ') — quote the combined mix, not the split' });
    items.push(md.churn_dominated
      ? { ok: false, t: 'Mix is churn-dominated — ' + md.one_sided_share_pct + '% comes from customer×SKU pairs present in only one window; matched pairs cover ' + md.matched_kg_share_pct + '% of current tonnage. That is timing, not a commercial shift.' }
      : { ok: true, t: 'Mix is driven by continuing customers (matched pairs cover ' + md.matched_kg_share_pct + '% of current tonnage)' });
    return '<div class="mnb-trust">' + items.map(function (i) {
      var ic = i.ok === true ? '✓' : (i.ok === false ? '⚠' : 'ⓘ');
      var c = i.ok === true ? 'ok' : (i.ok === false ? 'warn' : 'info');
      return '<div class="mnb-ti ' + c + '"><span>' + ic + '</span>' + esc(i.t) + '</div>';
    }).join('') + '</div>';
  }

  // Composition lenses — each a standalone one-dimensional share-shift.
  function lens(title, L, n) {
    if (!L || !L.rows || !L.rows.length) return '';
    var rows = L.rows.slice(0, n || 6).map(function (r) {
      return '<tr><td class="mnb-k" title="' + esc(r.key) + '">' + esc(r.key) + '</td>' +
        '<td class="mnb-v ' + cls(r.value) + '">' + pt(r.value) + '</td>' +
        '<td class="mnb-s">' + (+r.share0_pct).toFixed(1) + '% → ' + (+r.share1_pct).toFixed(1) + '% <i>' + pp(r.share_shift_pp) + '</i></td>' +
        '<td class="mnb-s">' + (r.gm_ton0 == null ? '—' : '₱' + (+r.gm_ton0).toLocaleString()) + ' → ' +
          (r.gm_ton1 == null ? '—' : '₱' + (+r.gm_ton1).toLocaleString()) + '</td></tr>';
    }).join('');
    return '<div class="mnb-lens"><div class="mnb-lh">' + esc(title) + ' <b class="' + cls(L.total) + '">' + pt(L.total) + '</b></div>' +
      '<table class="mnb-tbl"><thead><tr><th></th><th>effect</th><th>share</th><th>GM/ton</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function styles() {
    if (document.getElementById('mexp-net-style')) return;
    var s = document.createElement('style');
    s.id = 'mexp-net-style';
    s.textContent = [
      '.mexp-net-panel .mnb-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:18px;align-items:start}',
      '@media(max-width:1100px){.mexp-net-panel .mnb-grid{grid-template-columns:1fr}}',
      '.mnb-wf{display:flex;flex-direction:column;gap:6px}',
      '.mnb-row{display:grid;grid-template-columns:130px 1fr 92px;align-items:center;gap:10px}',
      '.mnb-lbl{font-size:11px;color:var(--text2);text-align:right}',
      '.mnb-track{position:relative;height:18px;background:var(--surface2,rgba(255,255,255,.04));border-radius:4px;overflow:hidden}',
      '.mnb-mid{position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--glass-border,rgba(255,255,255,.18))}',
      '.mnb-bar{position:absolute;top:3px;bottom:3px;border-radius:3px}',
      '.mnb-bar.pos{background:#22c55e}.mnb-bar.neg{background:#ef4444}',
      '.mnb-val{font-size:12px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}',
      '.mnb-val.pos,.mnb-v.pos,.mnb-lh b.pos,.mnb-wedge b.pos{color:#22c55e}',
      '.mnb-val.neg,.mnb-v.neg,.mnb-lh b.neg,.mnb-wedge b.neg{color:#ef4444}',
      '.mnb-end{display:flex;align-items:baseline;gap:8px;font-size:11px;color:var(--text2);padding:4px 0}',
      '.mnb-end b{font-size:15px;color:var(--text);font-variant-numeric:tabular-nums}',
      '.mnb-end.tot{border-top:1px solid var(--glass-border,rgba(255,255,255,.14));margin-top:4px;padding-top:8px}',
      '.mnb-end i{font-style:normal;font-weight:600;font-size:12px}',
      '.mnb-tbl{width:100%;border-collapse:collapse;font-size:11px}',
      '.mnb-tbl th{text-align:right;color:var(--text3);font-weight:500;padding:2px 6px;font-size:10px}',
      '.mnb-tbl th:first-child{text-align:left}',
      '.mnb-tbl td{padding:3px 6px;border-top:1px solid var(--glass-border,rgba(255,255,255,.07))}',
      '.mnb-k{color:var(--text2);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mnb-v{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.mnb-s{text-align:right;color:var(--text3);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.mnb-s i{font-style:normal;color:var(--text2)}',
      '.mnb-blind{color:var(--text3);font-weight:400;font-style:italic}',
      '.mnb-wedge{margin-top:8px;font-size:11px;color:var(--text2)}',
      '.mnb-flag{margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(241,177,29,.10);border:1px solid rgba(241,177,29,.35);font-size:11px;line-height:1.5;color:var(--text2)}',
      '.mnb-trust{display:flex;flex-direction:column;gap:5px;margin-top:14px}',
      '.mnb-ti{display:flex;gap:7px;font-size:11px;line-height:1.45;color:var(--text2)}',
      '.mnb-ti span{flex:0 0 12px}',
      '.mnb-ti.ok span{color:#22c55e}.mnb-ti.warn span{color:#f1b11d}.mnb-ti.info span{color:var(--text3)}',
      '.mnb-lenses{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}',
      '@media(max-width:900px){.mexp-net-panel .mnb-lenses{grid-template-columns:1fr}}',
      '.mnb-lh{font-size:11px;font-weight:600;color:var(--text2);margin-bottom:3px;display:flex;justify-content:space-between}',
      '.mnb-foot{margin-top:14px;font-size:10.5px;line-height:1.55;color:var(--text3)}'
    ].join('');
    document.head.appendChild(s);
  }

  window.MEXP_renderNetBridge = function (nb) {
    var panel = document.getElementById('mexp-net-panel');
    var body = document.getElementById('mexp-net-body');
    if (!panel || !body) return;
    if (!nb || nb.available === false) {
      panel.style.display = 'none';
      return;
    }
    styles();
    var recon = nb.reconciles ? '<span class="mexp-recon">reconciles ✓</span>' : '';
    body.innerHTML =
      '<div class="mnb-grid">' +
        '<div>' + waterfall(nb) + trust(nb) + '</div>' +
        '<div>' + comparison(nb) + '</div>' +
      '</div>' +
      '<div class="mnb-lenses">' +
        lens('Category (SSG)', nb.lenses && nb.lenses.ssg, 7) +
        lens('Business unit', nb.lenses && nb.lenses.bu, 5) +
        lens('Region', nb.lenses && nb.lenses.region, 4) +
        lens('Customer', nb.lenses && nb.lenses.customer, 7) +
      '</div>' +
      '<div class="mnb-foot">' + esc(nb.note || '') + ' ' + recon +
        '<br>Lenses are standalone one-dimensional share-shifts valued against the average margin — each is internally exact, but they do not sum to each other or to the Mix bars.</div>';
    panel.style.display = '';
  };
})();
