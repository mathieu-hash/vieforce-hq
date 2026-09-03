/* ============================================================================
 * mexp2-panel-kpi.js — Margin Explorer v2 · THE HERO PANEL (MEXP2.panel "kpi")
 * ----------------------------------------------------------------------------
 * THE THESIS OF v2.0, ON SCREEN
 *   The live page overstates margin by ~12%: `sales` is GROSS of the document-
 *   level trade discount (OINV.DiscSum), so hero.gm_per_kg, hero.net_sales,
 *   hero.gross_profit and hero.gp_pct are all higher than what was realised.
 *   The honest figure is in EVERY response as discount_overlay
 *   .gm_per_kg_net_of_discount (WIRE.DISCOUNT_OVERLAY, C3); v1 never reads it.
 *   This panel puts the two numbers side by side, same size, with the net
 *   figure carrying the primary visual weight — beside the reported tile,
 *   never instead of it (CONTRACT.md §1: changing the headline is a CFO call).
 *
 * LAYOUT
 *   ROW 1  [ GM/kg reported ] [ GM/kg NET of off-invoice discount ] [ discount /kg · % of reported GM ]
 *   ROW 2  [ Volume MT ] [ Net Sales ] [ Gross Profit ] [ GP % ]     (all GROSS basis, labelled)
 *   CHART  discount_overlay.series — reported vs net, wedge shaded, partial month dashed
 *   NOTE   C.UNIVERSES.copy (T5): hero is (103,105,102); the bridge below is 103 only.
 *
 * RULES THIS FILE OBEYS
 *   - Lifecycle per C.PANEL_LIFECYCLE: mount(host) / render(vm) / renderStale(prev, vm)
 *     / setStatus(state) / destroy(). render() is idempotent and reads only its vm;
 *     renderStale() paints prev.core and PRINTS prev.label in the panel header.
 *   - Every number through MEXP2.fmt. Tonnage = MEXP2.store.scopeTons(core), i.e.
 *     SUM(rows[].kg)/1000 (C1) — never rows[].tons, never a hero field (hero has none).
 *   - A null delta is a dash with its reason ("n/a vs LY" on compare=ly — the overlay
 *     computes no prior on ly, me:227), never a blank and never 0. A null overlay
 *     renders "not computed for this window", never zero. Every delta prints its
 *     baseline from hero.compare_window (C14).
 *   - Empty scope: every card is the em dash, one sentence from C.STATE_COPY.
 *     hero.* is literally 0 on the wire in that case (mock scenario 2) and must not
 *     reach the screen as PHP 0.
 *   - Status chrome is CSS off [data-mx2-status]; this file never writes opacity or
 *     display. Show/hide is by DOM membership only. All classes .mx2-*.
 *   - The chart is drawn by MEXP2.charts.discountOverlay (rebuilds on theme flip);
 *     nothing here is a colour.
 *   - No console.*, no fetch, no store mutation, nothing named margin-explorer*.js.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-panel-kpi: mexp2-contract.js must load before this file.");

  var PANEL_ID = "kpi";
  var CHART_ID = "kpi-overlay";
  var DASH = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var PER_KG = (C.NUM && C.NUM.PER_KG) || "/kg";
  var ARROW = " → ";
  var SNAPSHOT_NOTE = "up to 2 min behind";

  var COPY = {
    title: "Margin per kg — reported vs realised",
    reported: "GM/kg reported",
    net: "GM/kg net of off-invoice discount",
    discount: "Off-invoice discount",
    volume: "Volume",
    netSales: "Net Sales",
    gp: "Gross Profit",
    gpPct: "GP %",
    notComputed: "not computed for this window",
    naLy: "n/a vs LY",
    naNoPrior: "n/a · no prior window",
    naNoPriorKg: "n/a · prior window has no volume",
    volumeNote: "from matrix rows · SUM(kg) / 1000",
    volumeDelta: "no prior-window tonnage on the wire",
    reportedNote: "GrssProfit / InvQty kg",
    reportedFallback: "from hero.gm_per_kg · overlay not computed",
    gpNote: "pre-rebate",
    ofReported: " of reported GM/kg",
    totalInWindow: " total in window",
    pctUndefined: "share undefined — reported GM/kg ≤ 0",
    chartHead: "GM/kg, trailing months · reported vs net of off-invoice discount · shaded gap = discount given away · partial month dashed",
    stalePrefix: "Showing previous scope: ",
    baselineNone: "Baseline window not on the wire",
    postedThrough: "current posted through "
  };

  /* -------------------------------------------------------------------------
   * helpers
   * ---------------------------------------------------------------------- */
  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level]("kpi: " + msg, data); } catch (e) { /* silent */ }
  }
  function F() { return NS.fmt; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function setText(node, text) { if (node) node.textContent = (text == null) ? "" : String(text); }
  // DOM membership is the only show/hide mechanism (CSS owns display/opacity).
  function show(parent, node, yes, before) {
    if (!parent || !node) return;
    var inDom = node.parentNode === parent;
    if (yes && !inDom) {
      if (before && before.parentNode === parent) parent.insertBefore(node, before);
      else parent.appendChild(node);
    } else if (!yes && inDom) {
      parent.removeChild(node);
    }
  }
  function cls(node, name, on) {
    if (!node || !node.classList) return;
    if (on) node.classList.add(name); else node.classList.remove(name);
  }
  function isObj(v) { return !!v && typeof v === "object"; }
  function num(v) { var f = F(); return f ? f.toNum(v) : ((v == null || v === "") ? null : (isFinite(+v) ? +v : null)); }

  function isEmptyScope(core) {
    if (NS.store && typeof NS.store.isEmptyScope === "function") return NS.store.isEmptyScope(core);
    return !!(core && core.matrix && core.matrix.rows && core.matrix.rows.length === 0);
  }
  function scopeTons(core) {
    if (NS.store && typeof NS.store.scopeTons === "function") return NS.store.scopeTons(core);
    var rows = (core && core.matrix && core.matrix.rows) || [], i, v, sum = 0, any = false;
    for (i = 0; i < rows.length; i++) { v = num(rows[i] && rows[i].kg); if (v !== null) { sum += v; any = true; } }
    return any ? sum / 1000 : null;
  }

  /* -------------------------------------------------------------------------
   * card primitive
   * ---------------------------------------------------------------------- */
  function makeCard(label, opts) {
    opts = opts || {};
    var root = el("div", "mx2-kpi" + (opts.primary ? " mx2-kpi-primary" : ""));
    var v = el("div", "mx2-kpi-v" + (opts.money ? " mx2-kpi-v-money" : ""));
    var numEl = el("span", "mx2-kpi-num", DASH);
    var unitEl = el("span", "mx2-kpi-unit", "");
    v.appendChild(numEl); v.appendChild(unitEl);
    var d = el("div", "mx2-kpi-d mx2-flat", "");
    var n = el("div", "mx2-kpi-note", "");
    root.appendChild(el("div", "mx2-kpi-l", label));
    root.appendChild(v);
    root.appendChild(d);
    root.appendChild(n);
    return { root: root, v: v, num: numEl, unit: unitEl, delta: d, note: n };
  }

  // spec = { value: string|null, unit: string, delta: string, tone: 'pos'|'neg'|'flat', note: string }
  // value null -> the dash, muted (never PHP 0).
  function setCard(card, spec) {
    var isNull = (spec.value == null);
    setText(card.num, isNull ? DASH : spec.value);
    setText(card.unit, isNull ? "" : (spec.unit || ""));
    cls(card.num, "mx2-null", isNull);
    setText(card.delta, spec.delta == null ? "" : spec.delta);
    card.delta.className = "mx2-kpi-d " + toneClass(spec.tone);
    setText(card.note, spec.note == null ? "" : spec.note);
  }
  function toneClass(t) {
    if (t === "pos") return "mx2-pos";
    if (t === "neg") return "mx2-neg";
    return "mx2-flat";
  }
  function toneOf(v) { return v > 0 ? "pos" : (v < 0 ? "neg" : "flat"); }

  /* -------------------------------------------------------------------------
   * derivations — pure, read the vm, return strings
   * ---------------------------------------------------------------------- */

  // The explicit baseline (C14). hero.compare_window is TZ-safe (mwin.fmt);
  // meta.window is not and is never printed here.
  function baselineOf(hero) {
    var cw = hero && hero.compare_window, out = { short: "", line: COPY.baselineNone, ly: false };
    if (!hero) { out.line = ""; return out; }
    out.ly = (hero.compare_basis === "ly");
    if (!isObj(cw) || !cw.from || !cw.to) return out;
    out.short = cw.from + ARROW + cw.to;
    out.line = "Baseline " + out.short + (cw.basis ? " · " + cw.basis : "");
    if (cw.current_last_posted) out.line += " · " + COPY.postedThrough + cw.current_last_posted;
    return out;
  }

  // A delta line: signed magnitude + " vs " + baseline, or its reason for being absent.
  function deltaText(v, render, base, absentWhy) {
    if (v == null) return { text: base.ly ? COPY.naLy : (absentWhy || COPY.naNoPrior), tone: "flat" };
    return { text: render(v) + (base.short ? " vs " + base.short : ""), tone: toneOf(v) };
  }

  // Build every card spec from one core payload. `empty` forces dashes.
  function specsFor(core, empty) {
    var f = F(), hero = core && core.hero, ov = core && core.discount_overlay, base = baselineOf(hero);
    var S = {}, t, v, d, pct;
    // No hero at all (never painted) reads like an empty scope: dashes, no delta copy.
    var blank = empty || !hero;
    var repBasis = C.BASIS_SUFFIX.reported, netBasis = C.BASIS_SUFFIX.net;
    var discBasis = (ov && ov.basis) || (NS.WIRE && NS.WIRE.LITERALS && NS.WIRE.LITERALS.DISCOUNT_BASIS) || "";

    function perKgSigned(x) { return f.signed(x, 2) + PER_KG; }
    function pctSigned(x) { return f.signed(x, 1) + "%"; }

    // ROW 1 — the honest comparison -------------------------------------------
    if (!empty && ov) {
      v = num(ov.gm_per_kg_reported);
      d = deltaText(v === null ? null : num(ov.delta_reported), perKgSigned, base, COPY.naNoPriorKg);
      S.reported = { value: v === null ? null : f.perKg(v), unit: PER_KG, delta: d.text, tone: d.tone, note: repBasis + " · " + COPY.reportedNote };

      v = num(ov.gm_per_kg_net_of_discount);
      d = deltaText(v === null ? null : num(ov.delta_net_of_discount), perKgSigned, base, COPY.naNoPriorKg);
      S.net = { value: v === null ? null : f.perKg(v), unit: PER_KG, delta: d.text, tone: d.tone, note: netBasis + (discBasis ? " · " + discBasis : "") };

      v = num(ov.discount_per_kg); pct = num(ov.discount_pct_of_reported_gm); t = num(ov.discount_total);
      S.discount = {
        value: v === null ? null : f.perKg(v), unit: PER_KG,
        delta: pct === null ? COPY.pctUndefined : f.pct(pct) + COPY.ofReported,
        tone: pct === null ? "flat" : "neg",
        note: (t === null ? "" : f.php0(t) + COPY.totalInWindow + " · ") + "OINV.DiscSum"
      };
    } else {
      // Overlay null (query threw / window kg<=0) or empty scope: the reported
      // card falls back to hero.gm_per_kg (same figure, 2dp); net and discount
      // say why they are absent. Nothing here is a zero.
      v = (!empty && hero) ? num(hero.gm_per_kg && hero.gm_per_kg.value) : null;
      d = deltaText(v === null ? null : num(hero.gm_per_kg.delta), perKgSigned, base);
      S.reported = { value: v === null ? null : f.perKg(v), unit: PER_KG, delta: blank ? "" : d.text, tone: d.tone,
                     note: repBasis + " · " + (empty ? COPY.reportedNote : COPY.reportedFallback) };
      S.net = { value: null, unit: PER_KG, delta: COPY.notComputed, tone: "flat", note: netBasis + (discBasis ? " · " + discBasis : "") };
      S.discount = { value: null, unit: PER_KG, delta: COPY.notComputed, tone: "flat", note: "OINV.DiscSum" };
    }

    // ROW 2 — the gross-basis totals, labelled as such ---------------------------
    v = empty ? null : scopeTons(core);
    S.volume = { value: v === null ? null : f.mt(v), unit: "", delta: blank ? "" : COPY.volumeDelta, tone: "flat", note: COPY.volumeNote };

    v = (!empty && hero) ? num(hero.net_sales && hero.net_sales.value) : null;
    d = deltaText(v === null ? null : num(hero.net_sales.delta_pct), pctSigned, base);
    S.netSales = { value: v === null ? null : f.php0(v), unit: "", delta: blank ? "" : d.text, tone: d.tone, note: repBasis };

    v = (!empty && hero) ? num(hero.gross_profit && hero.gross_profit.value) : null;
    d = deltaText(v === null ? null : num(hero.gross_profit.delta_pct), pctSigned, base);
    S.gp = { value: v === null ? null : f.php0(v), unit: "", delta: blank ? "" : d.text, tone: d.tone, note: repBasis + " · " + COPY.gpNote };

    v = (!empty && hero) ? num(hero.gp_pct && hero.gp_pct.value) : null;
    d = deltaText(v === null ? null : num(hero.gp_pct.delta_pp), function (x) { return f.pp(x); }, base);
    S.gpPct = { value: v === null ? null : f.pct(v), unit: "", delta: blank ? "" : d.text, tone: d.tone, note: repBasis };

    S.baseline = base;
    return S;
  }

  /* -------------------------------------------------------------------------
   * the panel
   * ---------------------------------------------------------------------- */
  var host = null, R = null;   // R = node refs; both null when unmounted

  function build(hostEl) {
    var head = el("div", "mx2-panel-h"), col = el("div", "mx2-panel-hcol");
    R = {};
    R.title = el("div", "mx2-panel-t", COPY.title);
    R.sub = el("div", "mx2-panel-st", "");
    R.baseline = el("div", "mx2-panel-st", "");
    R.snapshot = el("div", "mx2-panel-st", "");
    R.cmpNote = el("div", "mx2-note");
    R.cmpNote.appendChild(el("span", "mx2-warnglyph", "⚠"));
    R.cmpNoteText = el("span", "", "");
    R.cmpNote.appendChild(R.cmpNoteText);
    col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.baseline); col.appendChild(R.snapshot);
    R.pill = el("span", "mx2-pill");
    R.pill.appendChild(el("span", "mx2-pill-dot"));
    R.pillText = el("span", "", "");
    R.pill.appendChild(R.pillText);
    head.appendChild(col); head.appendChild(R.pill);

    R.banner = el("div", "mx2-stale-banner", COPY.stalePrefix);
    R.bannerLabel = el("span", "mx2-stale-label", "");
    R.banner.appendChild(R.bannerLabel);

    R.body = el("div", "mx2-dimmable mx2-kpi-body");
    var row1 = el("div", "mx2-kpi-row mx2-kpi-row-hero");
    R.reported = makeCard(COPY.reported);
    R.net = makeCard(COPY.net, { primary: true });
    R.discount = makeCard(COPY.discount);
    row1.appendChild(R.reported.root); row1.appendChild(R.net.root); row1.appendChild(R.discount.root);
    var row2 = el("div", "mx2-kpi-row mx2-kpi-row-base");
    R.volume = makeCard(COPY.volume);
    R.netSales = makeCard(COPY.netSales, { money: true });
    R.gp = makeCard(COPY.gp, { money: true });
    R.gpPct = makeCard(COPY.gpPct);
    row2.appendChild(R.volume.root); row2.appendChild(R.netSales.root); row2.appendChild(R.gp.root); row2.appendChild(R.gpPct.root);
    R.chartHead = el("div", "mx2-note mx2-kpi-chart-head", COPY.chartHead);
    R.chartWrap = el("div", "mx2-canvas-wrap mx2-kpi-chart");
    R.canvas = el("canvas");
    R.chartWrap.appendChild(R.canvas);
    R.body.appendChild(row1); R.body.appendChild(row2); R.body.appendChild(R.chartHead); R.body.appendChild(R.chartWrap);

    R.universe = el("div", "mx2-note mx2-kpi-universe", C.UNIVERSES.copy);

    // state blocks — CSS shows exactly one per [data-mx2-status]
    R.skel = el("div", "mx2-kpi-skel"); R.skel.setAttribute("data-mx2-for", C.STATE.LOADING_FIRST);
    var sk = el("div", "mx2-kpi-row mx2-kpi-row-hero"), i;
    for (i = 0; i < 3; i++) sk.appendChild(el("div", "mx2-skel mx2-skel-lg"));
    R.skel.appendChild(sk);
    sk = el("div", "mx2-kpi-row mx2-kpi-row-base");
    for (i = 0; i < 4; i++) sk.appendChild(el("div", "mx2-skel mx2-skel-lg"));
    R.skel.appendChild(sk);
    R.skel.appendChild(el("div", "mx2-skel mx2-skel-block"));
    R.skel.appendChild(el("div", "mx2-note", C.STATE_COPY[C.STATE.LOADING_FIRST]));
    R.empty = stateBlock(C.STATE.EMPTY_SCOPE, C.STATE_COPY[C.STATE.EMPTY_SCOPE], C.STATE_COPY["empty-scope-hint"]);
    R.unavail = stateBlock(C.STATE.UNAVAILABLE_FOR_SCOPE, C.STATE_COPY[C.STATE.UNAVAILABLE_FOR_SCOPE], "");
    R.unavailHint = R.unavail.lastChild;
    R.errored = stateBlock(C.STATE.ERRORED, C.STATE_COPY[C.STATE.ERRORED], "");
    R.erroredTitle = R.errored.firstChild;

    hostEl.appendChild(head);
    hostEl.appendChild(R.body);
    hostEl.appendChild(R.universe);
    hostEl.appendChild(R.skel);
    hostEl.appendChild(R.empty);
    hostEl.appendChild(R.unavail);
    hostEl.appendChild(R.errored);
    R.head = head;
  }
  function stateBlock(state, title, hint) {
    var b = el("div", "mx2-msg"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", title));
    b.appendChild(el("div", "mx2-msg-h", hint || ""));
    return b;
  }

  // Paint one payload. `label` is the scope label to print (vm.label, or
  // prev.label when stale). Idempotent: every node is rewritten from `core`.
  function paint(core, label, stale, status) {
    if (!R) return;
    var empty = isEmptyScope(core), S = specsFor(core, empty), hero = core && core.hero, meta = core && core.meta;
    var snap = meta && meta.data_quality && meta.data_quality.snapshot_at;

    // header
    setText(R.sub, stale ? COPY.stalePrefix + label : label);
    setText(R.baseline, (core && hero) ? S.baseline.line : "");
    setText(R.snapshot, snap ? "Snapshot " + snap + " · " + SNAPSHOT_NOTE : "");
    show(R.head.firstChild, R.cmpNote, !!(hero && hero.ly_comparable === false && hero.compare_note));
    setText(R.cmpNoteText, (hero && hero.compare_note) || "");

    // stale chrome (the gold rail + banner that names the previous scope)
    cls(host, "mx2-is-stale", stale);
    setText(R.bannerLabel, stale ? label : "");
    show(host, R.banner, stale, R.body);

    // cards
    setCard(R.reported, S.reported);
    setCard(R.net, S.net);
    setCard(R.discount, S.discount);
    setCard(R.volume, S.volume);
    setCard(R.netSales, S.netSales);
    setCard(R.gp, S.gp);
    setCard(R.gpPct, S.gpPct);

    // chart — the 12-month series, or an explicit note on the canvas
    drawChart(core && core.discount_overlay, empty);

    // state-block copy that depends on the payload
    setText(R.erroredTitle, (stale || core) ? C.STATE_COPY["errored-stale"] : C.STATE_COPY[C.STATE.ERRORED]);
    setText(R.unavailHint, "");
    if (status === C.STATE.UNAVAILABLE_FOR_SCOPE && core && core.reason) setText(R.unavailHint, core.reason);
  }

  function drawChart(ov, empty) {
    var ch = NS.charts, series = ov && ov.series, n = (series && series.length) || 0;
    if (!R || !ch) return;
    setText(R.chartHead, COPY.chartHead + (n ? " · " + n + (n === 1 ? " month to " : " months to ") + series[n - 1].month : ""));
    R.chartWrap.setAttribute("aria-label", "Discount overlay: GM per kg reported versus net of off-invoice discount, " + (n ? n + " months" : "no series"));
    if (empty || ov == null) {
      // charts.discountOverlay(null) paints its own "not available" note;
      // in an empty scope the whole chart slot is hidden by CSS.
      if (typeof ch.discountOverlay === "function") ch.discountOverlay(CHART_ID, R.canvas, null);
      return;
    }
    if (typeof ch.discountOverlay === "function") ch.discountOverlay(CHART_ID, R.canvas, ov);
  }

  var def = {
    slot: "hero",
    phase: "core",

    mount: function (hostEl) {
      if (!hostEl) return;
      if (host && host !== hostEl) def.destroy();
      host = hostEl;
      cls(host, "mx2-panel-kpi", true);
      build(host);
      dbg("info", "mounted");
    },

    render: function (vm) {
      if (!R) return;
      vm = vm || {};
      paint(vm.core || null, vm.label || "", false, vm.status);
    },

    renderStale: function (prev, vm) {
      if (!R) return;
      vm = vm || {};
      if (!prev) { def.render(vm); return; }   // contract says never call with null; degrade honestly
      paint(prev.core || null, prev.label || "", true, vm.status);
    },

    setStatus: function (state) {
      if (!R || !host) return;
      if (!C.STATE_RULES[state]) state = C.STATE.FRESH;
      host.setAttribute("data-mx2-status", state);   // CSS does every treatment off this attribute
      setText(R.pillText, C.pillText(state));
    },

    destroy: function () {
      try { if (NS.charts && typeof NS.charts.destroy === "function") NS.charts.destroy(CHART_ID); } catch (e) { dbg("warn", "chart destroy threw", e && e.message); }
      if (host) {
        cls(host, "mx2-is-stale", false);
        cls(host, "mx2-panel-kpi", false);
        host.innerHTML = "";
      }
      host = null; R = null;
    },

    // test probes — not used by the controller
    _specs: specsFor,
    _baseline: baselineOf,
    CHART_ID: CHART_ID
  };

  NS.panel(PANEL_ID, def);
})();
