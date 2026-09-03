/* ============================================================================
 * mexp2-panel-g2n.js — Margin Explorer v2 · FROM REPORTED TO REALISED MARGIN (MEXP2.panel "g2n")
 * ----------------------------------------------------------------------------
 * WHAT THIS PANEL SHOWS
 *   The walk from the REPORTED GM/t (invoice-line basis, gross of the document
 *   discount) to the REALISED GM/t (net of OINV.DiscSum) for the CURRENT window
 *   of the dissection month pair, and what the reported month-pair bridge gets
 *   wrong because it cannot see the discount.
 *
 *   LEFT (2/3)  MEXP2.svg.waterfall, PHP/ton:
 *     anchorStart  Reported GM/t (invoice line basis)   = canonical_bridge.current_gm_ton
 *     placeholder  Line discount (list -> invoice price)  backend: PriceBefDi not read
 *     lever        Off-invoice document discount          = -net_bridge.discount.current_per_ton
 *     placeholder  Credit memos (ORIN)                    backend: netted in, not broken out
 *     anchorEnd    Realised GM/t, net of off-invoice discount = net_bridge.current_gm_ton
 *     placeholder  Settled rebates / post-invoice trade spend (after the realised anchor)
 *                                                         not in SAP data the API reads — owner to confirm
 *     A placeholder (C.WATERFALL_PLACEHOLDER) is an outlined, unfilled, zero-
 *     width mark with a "not on the wire" tag. It NEVER carries a value: these
 *     three are BACKEND work, and this panel does not invent them. The closure
 *     check ignores them. The list under the chart repeats each tag in prose.
 *
 *   RIGHT (1/3) "What the reported view gets wrong this window": a table from
 *     net_bridge.vs_reported — Δ GM/t, Price, Off-invoice discount — columns
 *     Reported | Net | Gap — then ONE deterministic sentence chosen by rule on
 *     C.MATERIALITY_PHP_T, then the discount trend line from discount_overlay
 *     (share now, min–max over the trailing series).
 *
 * WHY (WIRE.BASIS, CONTRACT.md §1)
 *   INV1.GrssProfit excludes OINV.DiscSum, so the line basis overstates margin
 *   by the discount per ton, and — worse — a list-price cut paired with a rebate
 *   cut reads as erosion on the reported bridge when realised margin is flat.
 *   Observed Jul->Aug 2026: reported Δ −202/t, net +8/t; reported price −19,
 *   net +163; wedge 974 -> 764/t. This panel exists so nobody calls that erosion.
 *
 * UNIVERSES (T5)
 *   The waterfall and the table are dissection figures: finished feed (103),
 *   credit notes netted, month-pair anchors. The trend line is the hero-universe
 *   discount_overlay (103,105,102). They are labelled separately; no connector,
 *   delta or shared axis is ever drawn between them.
 *
 * TINY-TONNAGE GUARD
 *   A per-ton figure on near-zero tonnage is a ratio on noise (v1 prints
 *   Untagged at PHP 4.5M/t on the Old DB). The compare month's tonnage is read
 *   from diss.trajectory; under TINY_TONS MT every per-ton figure here is
 *   flagged as indicative, and at zero it is withheld.
 *
 * RULES THIS FILE OBEYS
 *   - Lifecycle per C.PANEL_LIFECYCLE. render() reads only its vm; renderStale()
 *     paints prev.diss / prev.core and PRINTS prev.label (header + gold banner).
 *   - phase "diss": the controller reads store.statusFor("diss") for this panel.
 *     A net_bridge that is itself {available:false, reason} inside an available
 *     dissection is surfaced here as unavailable-for-scope with the reason.
 *   - Every number through MEXP2.fmt; every colour via --mx2-* (svg primitive or
 *     CSS); status chrome is CSS off [data-mx2-status]; show/hide by DOM
 *     membership. All classes .mx2-*. Every number carries its source block name
 *     in a title tooltip. No console.*, no fetch, no store mutation.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-panel-g2n: mexp2-contract.js must load before this file.");

  var PANEL_ID = "g2n";
  var UNIT = "php_per_ton";
  var DASH = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var PER_TON = (C.NUM && C.NUM.PER_TON) || "/t";
  var ARROW = " → ";
  var MATERIALITY = (typeof C.MATERIALITY_PHP_T === "number") ? C.MATERIALITY_PHP_T : 25;
  var TINY_TONS = 5;                                   // MT — below this a per-ton figure is a ratio on noise
  var PH = C.WATERFALL_PLACEHOLDER || { role: "placeholder", tag: "not on the wire" };

  // Source block names — every number's title tooltip names where it came from.
  var SRC = {
    reportedCur: "dissection.canonical_bridge.current_gm_ton",
    netCur: "dissection.net_bridge.current_gm_ton",
    discCur: "dissection.net_bridge.discount.current_per_ton",
    discPrior: "dissection.net_bridge.discount.prior_per_ton",
    discDelta: "dissection.net_bridge.discount.delta_per_ton",
    discTotal: "dissection.net_bridge.discount.current_total",
    vs: "dissection.net_bridge.vs_reported.",
    ovPct: "discount_overlay.discount_pct_of_reported_gm",
    ovSeries: "discount_overlay.series[] (discount_per_kg / gm_per_kg_reported)",
    trajTons: "dissection.trajectory[].tons"
  };

  var COPY = {
    title: "From reported to realised margin",
    basisLine: "Line-level GrssProfit excludes the document discount, so the reported view overstates realised margin. Discount allocated to lines pro-rata on LineTotal.",
    universe: "Waterfall and table: finished feed (103) only, credit notes netted — dissection universe. Trend line: discount_overlay on the hero universe (103,105,102). Different universes; no figure here ties to the hero tiles.",
    anchorsPrefix: "Anchors ",
    currentWindow: "current window = ",
    completeMonth: " (complete month)",
    partialMonth: " (partial — like-for-like)",
    anchorsWhy: "Month-pair anchors: the first and last complete months inside the selected period. This walk is drawn for the CURRENT window (the compare month).",
    anchorStart: "Reported GM/t (invoice line basis)",
    anchorEnd: "Realised GM/t, net of off-invoice discount",
    stepDisc: "Off-invoice document discount (OINV.DiscSum)",
    phLine: "Line discount (list → invoice price)",
    phLineTag: "backend: PriceBefDi not read",
    phCredit: "Credit memos (ORIN)",
    phCreditTag: "backend: netted in, not broken out",
    phRebate: "Settled rebates / post-invoice trade spend",
    phRebateChart: "Settled rebates / trade spend",   // the chart slot is two 10px lines wide; the list carries the full label
    phRebateTag: "not in SAP data the API reads — owner to confirm",
    phRebateAfter: " · after the realised anchor",
    missingHead: "Not on the wire — backend work, never estimated here:",
    rightTitle: "What the reported view gets wrong this window",
    colReported: "Reported", colNet: "Net", colGap: "Gap",
    rowDelta: "Δ GM/t", rowPrice: "Price", rowDisc: "Off-invoice discount",
    discInvisible: "invisible on the invoice-line basis — GrssProfit does not carry OINV.DiscSum",
    discNetTitle: "GP effect of the wedge change (sign flipped: a smaller discount lifts realised GM) · ",
    gapTitle: "gap = net − reported · ",
    wedgeA: "Discount wedge ", wedgeB: " (Δ ", wedgeC: ")",
    wedgeTotal: " · ",
    wedgeTotalSuffix: " in the current window",
    sNoVs: "Reported-vs-realised comparison is not on the wire for this window.",
    sFlipA: "Reported says ", sFlipB: "; realised says ", sFlipC: ". A list-price change was offset by a discount change of ",
    sFlipD: ". Do not call this ", sErosion: "erosion", sGain: "gain", sNothing: "a non-event", sDown: "down ", sUp: "up ", sFlat: "flat ",
    sFlipB2: "; realised is ",
    sSameA: "Both agree on direction; the reported view ", sOver: "overstates", sUnder: "understates", sSameB: " the move by ", sSameC: " of discount change.",
    sAgreeA: "Reported and realised agree this window (gap ", sAgreeB: ").",
    trendA: "Off-invoice discount is ", trendB: " of reported GM", trendC: " (range ", trendD: " over ", trendE: " months)",
    trendOne: " month)",
    trendNoPct: "Off-invoice discount share undefined this window — reported GM/kg ≤ 0.",
    ovNull: "discount_overlay not computed for this window (query threw or no volume) — no discount trend is shown.",
    tinyA: "Compare month ", tinyB: " carries ", tinyC: " — per-ton figures on tonnage this thin are unstable; read as indicative only.",
    zeroTons: " — no volume; per-ton figures withheld.",
    noPrev: "No dissection had loaded for the previous scope.",
    loadingNote: "Phase B (dissection) still in flight — the hero above is already current.",
    stalePrefix: "Showing previous scope: ",
    notePrefix: "net_bridge: "
  };

  /* -------------------------------------------------------------------------
   * helpers
   * ---------------------------------------------------------------------- */
  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level]("g2n: " + msg, data); } catch (e) { /* silent */ }
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
  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
  // "PHP X/t" of a magnitude, through fmt.perTon (never a local toFixed).
  function absTon(v) { var f = F(); return v === null ? DASH : f.perTon(Math.abs(v)) + PER_TON; }
  function signedTon(v) { var f = F(); return v === null ? DASH : f.signed(v, 0) + PER_TON; }
  function tol() {
    var t = (typeof C.TOLERANCE === "function") ? num(C.TOLERANCE(null, "canonical")) : null;
    return (t === null || !(t > 0)) ? 3 : t;
  }

  /* -------------------------------------------------------------------------
   * model — pure: reads one dissection + one core, returns everything to paint
   * ---------------------------------------------------------------------- */

  // The anchors line (C.ANCHORS.panel_rule): base -> compare verbatim, then
  // which of the two this walk is drawn for.
  function anchorsOf(src) {
    var base = src && src.base_month, comp = src && src.compare_month, out = { pair: "", line: "", partial: false };
    if (!base && !comp) return out;
    out.pair = String(base || DASH) + ARROW + String(comp || DASH);
    out.partial = !!(src && src.compare_partial === true);
    out.line = out.pair + " · " + COPY.currentWindow + String(comp || DASH) + (out.partial ? COPY.partialMonth : COPY.completeMonth);
    return out;
  }

  // Tonnage of the compare month from the trajectory — the only volume the
  // dissection carries per month. Null when the month is not in the trajectory.
  function compareTons(diss, month) {
    var t = diss && diss.trajectory, i;
    if (!month || !t || typeof t.length !== "number") return null;
    for (i = 0; i < t.length; i++) if (t[i] && t[i].month === month) return num(t[i].tons);
    return null;
  }

  // The ONE deterministic sentence, chosen by rule on C.MATERIALITY_PHP_T.
  //   1. opposite signs, both material            -> "Do not call this erosion/gain."
  //   1b. opposite signs (or one side ~0), one side material, gap material
  //                                               -> same sentence, the immaterial side
  //                                                  worded "flat" (the real Jul->Aug
  //                                                  2026 case: −202 reported vs +8 net)
  //   2. same direction, gap material             -> "over/understates the move"
  //   3. otherwise                                -> "agree (gap X)"
  function sentenceFor(dr, dn, gap, wedgeDelta) {
    if (dr === null || dn === null) return COPY.sNoVs;
    var z = (wedgeDelta !== null) ? wedgeDelta : gap;
    var zt = absTon(z);
    var matR = Math.abs(dr) >= MATERIALITY, matN = Math.abs(dn) >= MATERIALITY;
    var opposite = sign(dr) !== sign(dn);
    var gapMat = gap !== null && Math.abs(gap) >= MATERIALITY;
    if (opposite && matR && matN) {
      return COPY.sFlipA + (dr < 0 ? COPY.sDown : COPY.sUp) + absTon(dr) +
        COPY.sFlipB + (dn < 0 ? COPY.sDown : COPY.sUp) + absTon(dn) +
        COPY.sFlipC + zt + COPY.sFlipD + (dr < 0 ? COPY.sErosion : COPY.sGain) + ".";
    }
    if (opposite && (matR || matN) && gapMat) {
      return COPY.sFlipA + (matR ? (dr < 0 ? COPY.sDown : COPY.sUp) + absTon(dr) : COPY.sFlat + "(" + signedTon(dr) + ")") +
        COPY.sFlipB2 + (matN ? (dn < 0 ? COPY.sDown : COPY.sUp) + absTon(dn) : COPY.sFlat + "(" + signedTon(dn) + ")") +
        COPY.sFlipC + zt + COPY.sFlipD + (matR ? (dr < 0 ? COPY.sErosion : COPY.sGain) : COPY.sNothing) + ".";
    }
    if (!opposite && gapMat) {
      return COPY.sSameA + (Math.abs(dr) > Math.abs(dn) ? COPY.sOver : COPY.sUnder) + COPY.sSameB + zt + COPY.sSameC;
    }
    return COPY.sAgreeA + (gap === null ? DASH : absTon(gap)) + COPY.sAgreeB;
  }

  // The discount trend line from discount_overlay: share now, min–max over the
  // trailing series (share per point = discount_per_kg / gm_per_kg_reported).
  function trendFor(ov) {
    var f = F(), out = { text: "", title: "", ok: false };
    if (ov == null) { out.text = COPY.ovNull; return out; }
    var pct = num(ov.discount_pct_of_reported_gm), s = ov.series || [], i, rep, d, r, lo = null, hi = null, n = 0;
    for (i = 0; i < s.length; i++) {
      rep = num(s[i] && s[i].gm_per_kg_reported); d = num(s[i] && s[i].discount_per_kg);
      if (rep === null || d === null || !(rep > 0)) continue;
      r = f.ratio(d * 100, rep);
      if (r === null) continue;
      n++;
      if (lo === null || r < lo) lo = r;
      if (hi === null || r > hi) hi = r;
    }
    if (pct === null) { out.text = COPY.trendNoPct; out.title = SRC.ovPct; return out; }
    out.ok = true;
    out.text = COPY.trendA + f.pct(pct) + COPY.trendB;
    if (n > 0) out.text += COPY.trendC + f.pct(lo) + "–" + f.pct(hi) + COPY.trendD + n + (n === 1 ? COPY.trendOne : COPY.trendE);
    out.title = SRC.ovPct + (n > 0 ? " · range from " + SRC.ovSeries : "");
    return out;
  }

  function modelFor(diss, core) {
    var f = F();
    var M = { ok: false, spec: null, unavailableReason: null, anchors: anchorsOf(null), rows: [], wedge: null, sentence: "", trend: null, missing: [], notes: [], note: "", hasDiss: false };
    var ok = isObj(diss) && diss.available === true;
    var nb = ok ? diss.net_bridge : null, cb = ok ? diss.canonical_bridge : null;
    M.hasDiss = ok;
    M.trend = trendFor(core ? core.discount_overlay : null);
    if (!isObj(nb)) return M;
    if (nb.available !== true) { M.unavailableReason = (nb.reason == null) ? "" : String(nb.reason); M.anchors = anchorsOf(diss); return M; }
    M.ok = true;
    M.anchors = anchorsOf(nb);
    M.note = nb.note == null ? "" : String(nb.note);

    var disc = isObj(nb.discount) ? nb.discount : {}, vs = isObj(nb.vs_reported) ? nb.vs_reported : {};
    var reported = (isObj(cb) && cb.available === true) ? num(cb.current_gm_ton) : null;
    var net = num(nb.current_gm_ton);
    var dCur = num(disc.current_per_ton), dPrior = num(disc.prior_per_ton), dDelta = num(disc.delta_per_ton), dTotal = num(disc.current_total);
    var tons = compareTons(diss, nb.compare_month);
    var tiny = (tons !== null && tons < TINY_TONS);

    // TINY-TONNAGE GUARD: at zero tons every per-ton figure is withheld; under
    // TINY_TONS it is drawn but flagged as indicative.
    if (tons !== null && tons <= 0) {
      M.notes.push({ kind: "tiny", text: COPY.tinyA + String(nb.compare_month) + COPY.zeroTons, title: SRC.trajTons });
      reported = null; net = null; dCur = null;
    } else if (tiny) {
      M.notes.push({ kind: "tiny", text: COPY.tinyA + String(nb.compare_month) + COPY.tinyB + f.mt(tons) + COPY.tinyC, title: SRC.trajTons });
    }
    M.tiny = tiny; M.tons = tons;

    // LEFT — the walk. Placeholders never carry a value (C.WATERFALL_PLACEHOLDER).
    M.missing = [
      { label: COPY.phLine, tag: COPY.phLineTag },
      { label: COPY.phCredit, tag: COPY.phCreditTag },
      { label: COPY.phRebate, tag: COPY.phRebateTag, after: true }
    ];
    M.spec = {
      title: "",
      subtitle: null,
      unit: UNIT,
      anchorStart: { label: COPY.anchorStart, value: reported },
      anchorEnd: { label: COPY.anchorEnd, value: net },
      steps: [
        { label: COPY.phLine, value: null, role: PH.role, tag: COPY.phLineTag, drill: null },
        { label: COPY.stepDisc, value: dCur === null ? null : -dCur, role: "lever",
          drill: dPrior === null ? null : [{ label: "prior window " + f.perTon(dPrior) + PER_TON + " · current " + (dCur === null ? DASH : f.perTon(dCur) + PER_TON), value: null }] },
        { label: COPY.phCredit, value: null, role: PH.role, tag: COPY.phCreditTag, drill: null },
        { label: COPY.phRebateChart, value: null, role: PH.role, tag: COPY.phRebate + COPY.phRebateAfter + " — " + COPY.phRebateTag, drill: null }
      ],
      reconciles: (nb.reconciles === true || nb.reconciles === false) ? nb.reconciles : null,
      residual: 0,
      tolerance: tol(),
      toleranceKind: "canonical",
      basisNote: C.BASIS_SUFFIX.reported + ARROW + C.BASIS_SUFFIX.net,
      anchorsNote: M.anchors.line || null,
      footnote: null
    };

    // RIGHT — the table (Reported | Net | Gap) from vs_reported + the wedge.
    var dr = num(vs.delta_reported), dn = num(vs.delta_net), gap = num(vs.gap);
    var pr = num(vs.price_reported), pn = num(vs.price_net), pg = num(vs.price_gap);
    M.rows = [
      { label: COPY.rowDelta,
        rep: { v: dr, text: signedTon(dr), title: SRC.vs + "delta_reported" },
        net: { v: dn, text: signedTon(dn), title: SRC.vs + "delta_net" },
        gap: { v: gap, text: signedTon(gap), title: COPY.gapTitle + SRC.vs + "gap" } },
      { label: COPY.rowPrice,
        rep: { v: pr, text: signedTon(pr), title: SRC.vs + "price_reported" },
        net: { v: pn, text: signedTon(pn), title: SRC.vs + "price_net" },
        gap: { v: pg, text: signedTon(pg), title: COPY.gapTitle + SRC.vs + "price_gap" } },
      { label: COPY.rowDisc,
        rep: { v: null, text: DASH, title: COPY.discInvisible },
        net: { v: dDelta === null ? null : -dDelta, text: signedTon(dDelta === null ? null : -dDelta), title: COPY.discNetTitle + SRC.discDelta },
        gap: { v: dDelta === null ? null : -dDelta, text: signedTon(dDelta === null ? null : -dDelta), title: COPY.discNetTitle + SRC.discDelta } }
    ];
    M.wedge = (dPrior === null && dCur === null) ? null : {
      text: COPY.wedgeA + (dPrior === null ? DASH : f.perTon(dPrior) + PER_TON) + ARROW + (dCur === null ? DASH : f.perTon(dCur) + PER_TON) +
        COPY.wedgeB + signedTon(dDelta) + COPY.wedgeC + (dTotal === null ? "" : COPY.wedgeTotal + f.php(dTotal) + COPY.wedgeTotalSuffix),
      title: SRC.discPrior + " → " + SRC.discCur + " · Δ " + SRC.discDelta + (dTotal === null ? "" : " · total " + SRC.discTotal)
    };
    M.sentence = sentenceFor(dr, dn, gap, dDelta);
    M.sentenceTitle = "rule on " + SRC.vs + "{delta_reported, delta_net, gap} and " + SRC.discDelta + " · materiality " + f.perTon(MATERIALITY) + PER_TON;
    return M;
  }

  /* -------------------------------------------------------------------------
   * the panel
   * ---------------------------------------------------------------------- */
  var host = null, R = null;

  function build(hostEl) {
    var head = el("div", "mx2-panel-h"), col = el("div", "mx2-panel-hcol");
    R = {};
    R.title = el("div", "mx2-panel-t", COPY.title);
    R.sub = el("div", "mx2-panel-st", "");
    R.anchors = el("div", "mx2-panel-st mx2-g2n-anchors", "");
    R.anchors.setAttribute("title", COPY.anchorsWhy);
    R.basis = el("div", "mx2-panel-st mx2-g2n-basis", COPY.basisLine);
    col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.anchors); col.appendChild(R.basis);
    R.pill = el("span", "mx2-pill");
    R.pill.appendChild(el("span", "mx2-pill-dot"));
    R.pillText = el("span", "", "");
    R.pill.appendChild(R.pillText);
    head.appendChild(col); head.appendChild(R.pill);

    R.banner = el("div", "mx2-stale-banner", COPY.stalePrefix);
    R.bannerLabel = el("span", "mx2-stale-label", "");
    R.banner.appendChild(R.bannerLabel);

    R.body = el("div", "mx2-dimmable mx2-g2n-body");
    R.grid = el("div", "mx2-g2n-grid");
    // LEFT
    R.left = el("div", "mx2-g2n-left");
    R.chart = el("div", "mx2-g2n-chart");
    R.chart.setAttribute("aria-label", "Reported to realised GM per ton waterfall");
    R.missing = el("div", "mx2-g2n-missing");
    R.left.appendChild(R.chart);
    R.left.appendChild(R.missing);
    // RIGHT
    R.right = el("div", "mx2-g2n-right");
    R.rightTitle = el("div", "mx2-g2n-rt", COPY.rightTitle);
    R.tableWrap = el("div", "mx2-g2n-tblwrap");
    R.table = null;
    R.wedge = el("div", "mx2-note mx2-g2n-wedge", "");
    R.sentence = el("div", "mx2-g2n-verdict", "");
    R.trend = el("div", "mx2-note mx2-g2n-trend", "");
    R.right.appendChild(R.rightTitle);
    R.right.appendChild(R.tableWrap);
    R.right.appendChild(R.sentence);
    R.right.appendChild(R.trend);
    R.grid.appendChild(R.left); R.grid.appendChild(R.right);
    R.notes = el("div", "mx2-g2n-notes");
    R.noPrev = el("div", "mx2-note", COPY.noPrev);
    R.wireNote = el("div", "mx2-note mx2-g2n-wirenote", "");
    R.body.appendChild(R.grid);
    R.body.appendChild(R.wireNote);

    R.universe = el("div", "mx2-note mx2-g2n-universe", COPY.universe + " " + COPY.anchorsWhy);

    R.skel = el("div", "mx2-g2n-skel mx2-skel-rows"); R.skel.setAttribute("data-mx2-for", C.STATE.LOADING_FIRST);
    R.skel.appendChild(el("div", "mx2-skel mx2-skel-lg"));
    R.skel.appendChild(el("div", "mx2-skel mx2-skel-block"));
    R.skel.appendChild(el("div", "mx2-note", C.STATE_COPY[C.STATE.LOADING_FIRST] + " " + COPY.loadingNote));
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

  function dropSvg() {
    if (!R || !NS.svg || typeof NS.svg.destroy !== "function") return;
    try { NS.svg.destroy(R.chart); } catch (e) { /* silent */ }
  }

  // The placeholder list under the chart: each missing driver with its tag,
  // in prose, so the "why" is readable without a hover.
  function paintMissing(M) {
    var i, row, m;
    R.missing.innerHTML = "";
    if (!M.missing.length) { show(R.left, R.missing, false); return; }
    R.missing.appendChild(el("div", "mx2-g2n-missing-h", COPY.missingHead));
    for (i = 0; i < M.missing.length; i++) {
      m = M.missing[i];
      row = el("div", "mx2-g2n-missing-row");
      row.appendChild(el("span", "mx2-g2n-ph-glyph", ""));
      row.appendChild(el("span", "mx2-g2n-ph-label", m.label + (m.after ? COPY.phRebateAfter : "")));
      row.appendChild(el("span", "mx2-g2n-ph-tag", PH.tag + " · " + m.tag));
      R.missing.appendChild(row);
    }
    show(R.left, R.missing, true);
  }

  function numCell(td, cell) {
    setText(td, cell.text == null ? DASH : cell.text);
    cls(td, "mx2-null", cell.v === null);
    cls(td, "mx2-neg", cell.v !== null && cell.v < 0);
    cls(td, "mx2-pos", cell.v !== null && cell.v > 0);
    td.setAttribute("title", cell.title || "");
  }

  function buildTable(M) {
    var table = el("table", "mx2-tbl mx2-g2n-tbl"), thead = el("thead"), tr = el("tr"), tbody = el("tbody"), i, r, th, td;
    table.appendChild(el("caption", "mx2-sr", COPY.rightTitle + " — reported, net and gap per ton"));
    th = el("th", "", ""); th.setAttribute("scope", "col"); tr.appendChild(th);
    th = el("th", "mx2-num", COPY.colReported); th.setAttribute("scope", "col"); th.setAttribute("title", C.BASIS_SUFFIX.reported + " · dissection.canonical_bridge"); tr.appendChild(th);
    th = el("th", "mx2-num", COPY.colNet); th.setAttribute("scope", "col"); th.setAttribute("title", C.BASIS_SUFFIX.net + " · dissection.net_bridge"); tr.appendChild(th);
    th = el("th", "mx2-num", COPY.colGap); th.setAttribute("scope", "col"); th.setAttribute("title", "gap = net − reported · dissection.net_bridge.vs_reported"); tr.appendChild(th);
    thead.appendChild(tr); table.appendChild(thead);
    for (i = 0; i < M.rows.length; i++) {
      r = M.rows[i];
      tr = el("tr");
      td = el("td", "mx2-dim-col", r.label); tr.appendChild(td);
      td = el("td", "mx2-num"); numCell(td, r.rep); tr.appendChild(td);
      td = el("td", "mx2-num mx2-g2n-net"); numCell(td, r.net); tr.appendChild(td);
      td = el("td", "mx2-num"); numCell(td, r.gap); tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  function paintNotes(M) {
    var i, n;
    R.notes.innerHTML = "";
    for (i = 0; i < M.notes.length; i++) {
      n = el("div", "mx2-note mx2-g2n-note");
      n.setAttribute("data-mx2-note", M.notes[i].kind);
      n.setAttribute("title", M.notes[i].title || "");
      n.appendChild(el("span", "mx2-warnglyph", "⚠"));
      n.appendChild(el("span", "", M.notes[i].text));
      R.notes.appendChild(n);
    }
    show(R.body, R.notes, R.notes.childNodes.length > 0, R.wireNote);
  }

  // Paint one dissection + core. `label` is vm.label, or prev.label when stale.
  // Idempotent: every node is rewritten; the svg instance is torn down and
  // re-attached (the primitive does the same on its own host).
  function paint(diss, core, label, stale, status) {
    if (!R || !host) return;
    var M = modelFor(diss, core), effective = status;

    // header
    setText(R.sub, stale ? COPY.stalePrefix + label : label);
    setText(R.anchors, M.anchors.line ? COPY.anchorsPrefix + M.anchors.line : "");
    cls(host, "mx2-is-stale", stale);
    setText(R.bannerLabel, stale ? label : "");
    show(host, R.banner, stale, R.body);

    // body — detached, then re-attached in ONE fixed order ahead of R.wireNote
    dropSvg();
    show(R.body, R.noPrev, false); show(R.body, R.grid, false); show(R.body, R.notes, false);
    show(R.body, R.noPrev, stale && !isObj(diss), R.wireNote);
    show(R.body, R.grid, M.ok, R.wireNote);
    if (M.ok) {
      if (NS.svg && typeof NS.svg.waterfall === "function") NS.svg.waterfall(R.chart, M.spec);
      paintMissing(M);
      if (R.table && R.table.parentNode === R.tableWrap) R.tableWrap.removeChild(R.table);
      R.table = buildTable(M);
      R.tableWrap.appendChild(R.table);
      show(R.right, R.wedge, !!M.wedge, R.sentence);
      if (M.wedge) { setText(R.wedge, M.wedge.text); R.wedge.setAttribute("title", M.wedge.title); }
      setText(R.sentence, M.sentence);
      R.sentence.setAttribute("title", M.sentenceTitle || "");
    } else {
      R.missing.innerHTML = "";
      if (R.table && R.table.parentNode === R.tableWrap) R.tableWrap.removeChild(R.table);
      R.table = null;
      setText(R.sentence, ""); R.sentence.removeAttribute("title");
    }
    // the trend line reads the CORE overlay and is drawn whenever the grid is
    setText(R.trend, M.trend ? M.trend.text : "");
    R.trend.setAttribute("title", (M.trend && M.trend.title) || "");
    cls(R.trend, "mx2-g2n-trend-off", !(M.trend && M.trend.ok));
    paintNotes(M);
    setText(R.wireNote, M.note ? COPY.notePrefix + M.note : "");

    // state-block copy that depends on the payload
    setText(R.erroredTitle, (stale || isObj(diss)) ? C.STATE_COPY["errored-stale"] : C.STATE_COPY[C.STATE.ERRORED]);
    setText(R.unavailHint, "");
    if (isObj(diss) && diss.available === false) setText(R.unavailHint, diss.reason == null ? "" : String(diss.reason));
    // A net_bridge that is itself the two-key unavailable form inside an
    // available dissection (C5): the store reports FRESH because the block is
    // present; this panel surfaces the state itself, reason verbatim.
    if (M.unavailableReason !== null && (status === C.STATE.FRESH || status == null)) {
      effective = C.STATE.UNAVAILABLE_FOR_SCOPE;
      setText(R.unavailHint, M.unavailableReason);
    }
    if (effective && effective !== status) def.setStatus(effective);
  }

  var def = {
    slot: "body",
    phase: "diss",

    mount: function (hostEl) {
      if (!hostEl) return;
      if (host && host !== hostEl) def.destroy();
      host = hostEl;
      cls(host, "mx2-panel-g2n", true);
      build(host);
      dbg("info", "mounted");
    },

    render: function (vm) {
      if (!R || !host) return;
      vm = vm || {};
      paint(vm.diss || null, vm.core || null, vm.label || "", false, host.getAttribute("data-mx2-status") || null);
    },

    renderStale: function (prev, vm) {
      if (!R || !host) return;
      vm = vm || {};
      if (!prev) { def.render(vm); return; }   // contract says never call with null; degrade honestly
      paint(prev.diss || null, prev.core || null, prev.label || "", true, host.getAttribute("data-mx2-status") || null);
    },

    setStatus: function (state) {
      if (!R || !host) return;
      if (!C.STATE_RULES[state]) state = C.STATE.FRESH;
      host.setAttribute("data-mx2-status", state);   // CSS does every treatment off this attribute
      setText(R.pillText, C.pillText(state));
    },

    destroy: function () {
      dropSvg();
      if (host) {
        cls(host, "mx2-is-stale", false);
        cls(host, "mx2-panel-g2n", false);
        host.innerHTML = "";
      }
      host = null; R = null;
    },

    // test probes — not used by the controller
    _model: modelFor,
    _sentence: sentenceFor,
    _trend: trendFor,
    _anchors: anchorsOf,
    MATERIALITY: MATERIALITY,
    TINY_TONS: TINY_TONS,
    COPY: COPY,
    SRC: SRC
  };

  // THE ONE reported-vs-realised rule, exported so mexp2-panel-insight.js can
  // print the same sentence from the same inputs. Never duplicated there.
  NS.rules = NS.rules || {};
  NS.rules.reportedVsRealised = sentenceFor;

  NS.panel(PANEL_ID, def);
})();
