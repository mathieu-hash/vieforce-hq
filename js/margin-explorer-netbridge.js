// js/margin-explorer-netbridge.js
//
// DRIVERS — the composition lenses of the NET GM/ton bridge (net_bridge.lenses):
// customer / category (SSG) / business unit / region, each a standalone
// one-dimensional Bennet share-shift on margin NET of the off-invoice trade
// discount (OINV.DiscSum), plus the window / mix trust prose.
//
// The realised waterfall itself is drawn by mexp2-panel-bridge.js ("netbridge",
// on the same scale as the reported bridge) and the reported-vs-net comparison
// by mexp2-panel-g2n.js — neither is rendered here any more.
//
// Renders into #mexp-drivers-body. Read-only; no fetches of its own.
//
// T1: when mix_ordering.sign_stable is false the customer / product split is a
// modelling artefact; the lenses are the split, so this panel prints the T1
// sentence with the two ranges and NO lens tables.
//
// Staleness: v1 policy, same as the Cost block. A good render is kept only for
// the scope it was painted for (the controller calls MEXP_resetNetBridge on
// every scope change). Same scope, refresh failed → the panel dims and names
// the scope it is showing. Nothing to keep → the panel stays visible and prints
// the server's reason. It never hides itself.
(function () {
  'use strict';

  var esc = window.esc || function (s) { return String(s == null ? '' : s); };

  var NET_GOOD = false;    // a real lens set has painted for the CURRENT scope
  var NET_SCOPE = '';      // label of the scope that render describes
  window.MEXP_resetNetBridge = function () { NET_GOOD = false; NET_SCOPE = ''; };

  function staleNote(panel, body, text) {
    var n = document.getElementById('mexp-drivers-stale');
    if (!text) { if (n && n.parentNode) n.parentNode.removeChild(n); return; }
    if (!n) {
      n = document.createElement('div');
      n.id = 'mexp-drivers-stale';
      n.className = 'mexp-stale-note';
      panel.insertBefore(n, body);
    }
    n.textContent = text;
  }

  function pt(n) {
    n = Math.round(+n || 0);
    var s = '₱' + Math.abs(n).toLocaleString() + '/t';
    return n > 0 ? '+' + s : (n < 0 ? '−' + s : s);
  }
  function cls(n) { return (+n > 0 ? 'pos' : (+n < 0 ? 'neg' : '')); }
  function pp(n) { n = +n || 0; return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + 'pp'; }
  function mt(n) { if (n == null || isNaN(n)) return '—'; return (+n).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' MT'; }
  function gates() { var ns = window.MEXP2; return (ns && ns.C && ns.C.TRUST_GATES) || {}; }

  // Trust signals: is this window comparable, and is the mix split a measurement?
  // A percentage the wire left absent prints as a dash, never "undefined%".
  function pctOr(v) { return (typeof v === 'number' && isFinite(v)) ? v : '—'; }
  function trust(nb) {
    var w = nb.window || {}, md = nb.mix_detail || {}, mo = nb.mix_ordering || {};
    var items = [];
    if (w.base_window && w.compare_window) {
      items.push(w.like_for_like
        ? { ok: true, t: 'Like-for-like windows — ' + w.base_window.join(' … ') + ' vs ' + w.compare_window.join(' … ') +
            ', ' + w.base_shipping_days + ' vs ' + w.compare_shipping_days + ' shipping days' }
        : { ok: false, t: 'Windows are NOT like-for-like — ' + w.base_shipping_days + ' vs ' + w.compare_shipping_days + ' shipping days' });
    }
    if (w.compare_partial) {
      items.push({ ok: null, t: 'Compare month is ' + pctOr(w.month_progress_pct) + '% elapsed (last posted ' + (w.last_posted_date || '—') + ') — this is an early read' });
    }
    items.push(mo.sign_stable
      ? { ok: true, t: 'Customer/Product split is stable across decomposition order' }
      : { ok: false, t: 'Customer/Product split is NOT order-stable (customer bar ranges ' +
          pt(mo.customer_range ? mo.customer_range[0] : 0) + ' … ' + pt(mo.customer_range ? mo.customer_range[1] : 0) + ') — quote the combined mix, not the split' });
    items.push(md.churn_dominated
      ? { ok: false, t: 'Mix is churn-dominated — ' + pctOr(md.one_sided_share_pct) + '% comes from customer×SKU pairs present in only one window; matched pairs cover ' + pctOr(md.matched_kg_share_pct) + '% of current tonnage. That is timing, not a commercial shift.' }
      : { ok: true, t: 'Mix is driven by continuing customers (matched pairs cover ' + pctOr(md.matched_kg_share_pct) + '% of current tonnage)' });
    return '<div class="mnb-trust">' + items.map(function (i) {
      var ic = i.ok === true ? '✓' : (i.ok === false ? '⚠' : 'ⓘ');
      var c = i.ok === true ? 'ok' : (i.ok === false ? 'warn' : 'info');
      return '<div class="mnb-ti ' + c + '"><span>' + ic + '</span>' + esc(i.t) + '</div>';
    }).join('') + '</div>';
  }

  // Composition lenses — each a standalone one-dimensional share-shift. The
  // rows are the server's top N by |value| (WIRE.LENS_ROW_CAPS); the total is
  // over ALL rows, so the listed rows do not sum to it — labelled as such.
  function lens(title, L, n) {
    if (!L || !L.rows || !L.rows.length) return '';
    var rows = L.rows.slice(0, n || 6).map(function (r) {
      return '<tr><td class="mnb-k" title="' + esc(r.key) + '">' + esc(r.key) + '</td>' +
        '<td class="mnb-v ' + cls(r.value) + '">' + pt(r.value) + '</td>' +
        '<td class="mnb-s">' + (+r.share0_pct).toFixed(1) + '% → ' + (+r.share1_pct).toFixed(1) + '% <i>' + pp(r.share_shift_pp) + '</i></td>' +
        '<td class="mnb-s" title="' + esc(mt(r.tons0) + ' → ' + mt(r.tons1)) + '">' + (r.gm_ton0 == null ? '—' : '₱' + (+r.gm_ton0).toLocaleString()) + ' → ' +
          (r.gm_ton1 == null ? '—' : '₱' + (+r.gm_ton1).toLocaleString()) + '</td></tr>';
    }).join('');
    var shown = Math.min(n || 6, L.rows.length);
    return '<div class="mnb-lens"><div class="mnb-lh">' + esc(title) + ' <span class="mnb-topn">top ' + shown + ' of ' + L.rows.length + ' listed · total over all rows</span> <b class="' + cls(L.total) + '">' + pt(L.total) + '</b></div>' +
      '<table class="mnb-tbl"><thead><tr><th></th><th>effect</th><th>share</th><th>GM/ton</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function styles() {
    if (document.getElementById('mexp-net-style')) return;
    var s = document.createElement('style');
    s.id = 'mexp-net-style';
    s.textContent = [
      '#mexp-drivers .mnb-tbl{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}',
      '#mexp-drivers .mnb-tbl th{text-align:right;color:var(--text3);font-weight:500;padding:2px 6px;font-size:10px}',
      '#mexp-drivers .mnb-tbl th:first-child{text-align:left}',
      '#mexp-drivers .mnb-tbl td{padding:3px 6px;border-top:1px solid var(--mx2-divider,var(--glass-border,rgba(255,255,255,.07)))}',
      '#mexp-drivers .mnb-k{color:var(--text2);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#mexp-drivers .mnb-v{text-align:right;font-weight:600;white-space:nowrap}',
      '#mexp-drivers .mnb-v.pos,#mexp-drivers .mnb-lh b.pos{color:var(--mx2-pos,var(--green))}',
      '#mexp-drivers .mnb-v.neg,#mexp-drivers .mnb-lh b.neg{color:var(--mx2-neg,var(--red))}',
      '#mexp-drivers .mnb-s{text-align:right;color:var(--text3);white-space:nowrap}',
      '#mexp-drivers .mnb-s i{font-style:normal;color:var(--text2)}',
      '#mexp-drivers .mnb-trust{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}',
      '#mexp-drivers .mnb-ti{display:flex;gap:7px;font-size:11px;line-height:1.45;color:var(--text2)}',
      '#mexp-drivers .mnb-ti span{flex:0 0 12px}',
      '#mexp-drivers .mnb-ti.ok span{color:var(--mx2-pos,var(--green))}#mexp-drivers .mnb-ti.warn span{color:var(--mx2-stale,var(--gold))}#mexp-drivers .mnb-ti.info span{color:var(--text3)}',
      '#mexp-drivers .mnb-lenses{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
      '@media(max-width:900px){#mexp-drivers .mnb-lenses{grid-template-columns:1fr}}',
      '#mexp-drivers .mnb-lh{font-size:11px;font-weight:600;color:var(--text2);margin-bottom:3px;display:flex;justify-content:space-between;gap:8px;align-items:baseline}',
      '#mexp-drivers .mnb-topn{font-size:9px;font-weight:600;color:var(--text3);margin-left:auto}',
      '#mexp-drivers .mnb-t1{padding:10px 12px;border-radius:8px;border:1px solid var(--mx2-mix-border,var(--glass-border));background:var(--mx2-mix-soft,transparent);color:var(--text2);font-size:11.5px;line-height:1.5}',
      '#mexp-drivers .mnb-foot{margin-top:14px;font-size:10.5px;line-height:1.55;color:var(--text3)}',
      '#mexp-drivers .mnb-unavail{font-size:12px;font-weight:600;color:var(--text);padding:14px 2px;line-height:1.5}'
    ].join('');
    document.head.appendChild(s);
  }

  window.MEXP_renderNetBridge = function (nb, label) {
    var panel = document.getElementById('mexp-drivers');
    var body = document.getElementById('mexp-drivers-body');
    var sub = document.getElementById('mexp-drivers-sub');
    if (!panel || !body) return;
    styles();
    label = label || 'this scope';
    // Shape gate: a malformed net_bridge (wrong types on a 200) is routed to
    // unavailable with a reason, never printed as "undefined → undefined".
    if (nb && nb.available !== false && !(typeof nb.base_month === 'string' && typeof nb.compare_month === 'string')) {
      nb = { available: false, reason: 'the net bridge block failed the shape check (base_month / compare_month) — treated as unavailable.' };
    }
    if (!nb || nb.available === false) {
      var reason = (nb && nb.reason) || 'not available for this anchor.';
      // Only a TRANSPORT failure (error:true) keeps the last good render: a
      // determinate available:false is the answer for this scope and replaces it.
      if (NET_GOOD && nb && nb.error) {
        // same scope, refresh failed: keep the render, dim it, name the scope shown
        panel.classList.add('mexp-stale');
        staleNote(panel, body, '⚠ source busy — could not refresh; showing ' + (NET_SCOPE || label) + ' (' + reason + ')');
      } else {
        // nothing to keep: an unsupported / empty scope is an answer — print it
        NET_GOOD = false; NET_SCOPE = '';
        panel.classList.remove('mexp-stale');
        staleNote(panel, body, '');
        // the subtitle must not keep a previous payload's anchors
        if (sub) sub.textContent = 'Net of off-invoice discount · ' + label + ' · each lens is a standalone one-dimensional share-shift; lenses do not sum to each other or to the mix bars';
        body.innerHTML = '<div class="mnb-unavail">' +
          ((nb && nb.error) ? '⚠ Drivers could not be loaded for ' : 'ⓘ No net-bridge lenses for ') +
          esc(label) + ' — ' + esc(reason) + '</div>';
      }
      panel.style.display = '';
      return;
    }
    panel.classList.remove('mexp-stale');
    staleNote(panel, body, '');
    var mo = nb.mix_ordering || {}, G = gates();
    var lensesHtml;
    if (mo.sign_stable === false) {
      // T1: the split is a modelling artefact — no lens tables.
      var t1 = (G.MIX_ORDERING && G.MIX_ORDERING.copy) || 'The customer / product split is not determinate for this window — the two decomposition orderings disagree in sign. Shown as a single composition effect.';
      lensesHtml = '<div class="mnb-t1">' + esc(t1) + ' Customer range ' + pt(mo.customer_range ? mo.customer_range[0] : 0) + ' … ' + pt(mo.customer_range ? mo.customer_range[1] : 0) +
        ' · product range ' + pt(mo.product_range ? mo.product_range[0] : 0) + ' … ' + pt(mo.product_range ? mo.product_range[1] : 0) +
        '. Combined mix ' + pt(nb.mix_total) + '. The lenses are that split, so none is quoted.</div>';
    } else {
      lensesHtml = '<div class="mnb-lenses">' +
        lens('Customer', nb.lenses && nb.lenses.customer, 7) +
        lens('Category (SSG)', nb.lenses && nb.lenses.ssg, 7) +
        lens('Business unit', nb.lenses && nb.lenses.bu, 5) +
        lens('Region', nb.lenses && nb.lenses.region, 4) +
      '</div>';
    }
    if (sub) sub.textContent = 'Net of off-invoice discount · ' + nb.base_month + ' → ' + nb.compare_month + (nb.compare_partial ? ' (partial — like-for-like)' : ' (complete months)') + ' · ' + label +
      ' · each lens is a standalone one-dimensional share-shift; lenses do not sum to each other or to the mix bars';
    body.innerHTML = trust(nb) + lensesHtml +
      '<div class="mnb-foot">' + esc(nb.note || '') +
        '<br>Lenses are standalone one-dimensional share-shifts valued against the average margin — each is internally exact, but they do not sum to each other or to the Mix bars. Rows are the server\'s top N by |effect|; the total is over all rows.</div>';
    panel.style.display = '';
    NET_GOOD = true;
    NET_SCOPE = label;
  };
})();
