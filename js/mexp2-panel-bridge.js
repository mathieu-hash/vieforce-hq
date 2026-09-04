/* ============================================================================
 * mexp2-panel-bridge.js — Margin Explorer v2 · THE GM/TON BRIDGES
 *   MEXP2.panel "bridge"     — REPORTED: diss.canonical_bridge (gross of the
 *                              off-invoice discount)
 *   MEXP2.panel "netbridge"  — REALISED: diss.net_bridge (net of the off-invoice
 *                              discount)
 * ----------------------------------------------------------------------------
 * ONE implementation, two registrations: makeBridge(opts) closes over its own
 * host / refs, so the reported and the realised bridge are the same code with
 * a different source block. Both draw MEXP2.svg.waterfall (delta-framed axis,
 * numeral-only anchor strip) with the backend's trust signals as badges INLINE
 * at the top-right of the chart.
 *
 * ONE SCALE (the owner's ask)
 *   Each variant computes its own spec AND the other variant's spec from the
 *   same dissection, unions the two cumulative-delta extents through
 *   MEXP2.svg.waterfallDomain and passes the union as spec.domain. Both panels
 *   therefore draw on the identical axis, and the subtitle says so. When the
 *   other bridge is unavailable for the scope the panel says "own scale".
 *   The reported->realised walk (mexp2-panel-g2n.js) is a level gap, not a
 *   month-pair move, and keeps its own axis.
 *
 * TRUST BADGES (T1-T3, C.TRUST_GATES) — both variants
 *   - mix_ordering.sign_stable === false  -> "mix split unstable": the customer /
 *     product bars are MERGED into one "Mix" bar valued at mix_total. The split
 *     is not quoted anywhere, not even greyed; the two ranges are the reason.
 *   - mix_detail.churn_dominated === true -> "churn-dominated", the backend's
 *     WARNING sentence (appended to canonical_bridge.note) in the tooltip.
 *   - significance (canonical only)       -> the verdict word (noise / weak /
 *     signal), z in the tooltip. No badge at all when unavailable.
 *
 * CLOSURE (C13)
 *   residual = (current - prior) - sum(drawn bars). Under C.TOLERANCE(_,
 *   "canonical") (3 PHP/ton of rounding drift) NOTHING is drawn — no tick, no
 *   badge. Above it an "Unexplained (rounding drift)" bar is pushed as a step,
 *   role resid, so the label names it honestly. The server's `reconciles` flag
 *   is printed ONLY when it disagrees with the client closure.
 *
 * RECONCILING DRILLS (reported variant only, under the chart)
 *   Two small tables tied to their parent bar: Cost -> RM / Packaging / Feedtag
 *   (cost_components: ALWAYS an estimate — production-order class ratio, RM is
 *   the remainder; labelled "estimated", basis in the tooltip) and Product mix
 *   -> by category (product_mix_by_ssg, the ssg lens with zero rows dropped).
 *   Each footer prints the parent bar; when the rows do not re-sum to it within
 *   rounding (max(1.5, N) PHP/ton for N rounded rows) the footer says by how
 *   much. A passing tie draws nothing (C13). The product-mix drill is withheld
 *   when the split is merged (T1) — there is no Product mix bar to tie to.
 *
 * ANCHOR HONESTY (C.ANCHORS)
 *   The anchors are base_month -> compare_month — the first and last COMPLETE
 *   months inside the selected period, never the period itself. Printed
 *   verbatim in the header and as the chart subtitle with "complete months
 *   only"; when compare_partial the like-for-like copy replaces it.
 *
 * UNIVERSE (T5)
 *   Finished feed (103) only; nets credit notes. Does not tie to the hero.
 *   No connector, delta or shared axis is ever drawn to a hero figure.
 *
 * RULES THIS FILE OBEYS
 *   - Lifecycle per C.PANEL_LIFECYCLE. render() reads only its vm; renderStale()
 *     paints prev.diss and PRINTS prev.label (header + gold banner).
 *   - phase "diss": the controller reads store.statusFor("diss") for this
 *     panel. A bridge block that is itself {available:false, reason} inside
 *     an available dissection is surfaced by this panel as unavailable-for-
 *     scope with the reason verbatim (the store cannot see inside the block).
 *   - Every number through MEXP2.fmt; every colour via --mx2-* inside the svg
 *     primitive or CSS; status chrome is CSS off [data-mx2-status]; show/hide
 *     by DOM membership. All classes .mx2-*. No console.*, no fetch, no store
 *     mutation.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-panel-bridge: mexp2-contract.js must load before this file.");

  var UNIT = "php_per_ton";
  var DASH = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var PER_TON = (C.NUM && C.NUM.PER_TON) || "/t";
  var ARROW = " → ";
  var DRILL_TOP = 5;            // product_mix_by_ssg rows carried into the Product mix tooltip
  var GATES = C.TRUST_GATES || {};

  var COPY = {
    universe: "Finished feed (103) only; nets credit notes. Does not tie to the hero.",
    anchorsPrefix: "Anchors ",
    completeOnly: "complete months only",
    partialA: "compare month is partial — ",
    shippingDays: " shipping days",
    ofMonth: " of the month",
    anchorsWhy: "Month-pair anchors: the first and last complete months inside the selected period — never the period itself (the running month is excluded).",
    prior: "Prior GM/t", current: "Current GM/t",
    price: "Price", cost: "Cost", custMix: "Customer mix", prodMix: "Product mix",
    mixMerged: "Mix",
    mixMergedNote: "customer + product merged — the split is not determinate for this window",
    unexplained: "Unexplained (rounding drift)",
    rm: "Raw materials", packaging: "Packaging", feedtag: "Feedtag",
    costEst: "(est.)",
    badgeMix: "mix split unstable",
    badgeChurn: "churn-dominated",
    prodDrillNote: "top " + DRILL_TOP + " by |value| · ssg lens, does not sum to the bar",
    rangeA: " Customer range ", rangeB: " · product range ",
    churnA: " One-sided share ", churnB: " · matched kg share ",
    sigSignal: "Unusual: outside the historical range of month-pair moves.",
    sigZ: "z ", sigPct: " · percentile ", sigBand: " · band ", sigN: " · n ",
    reconA: "Server reconciles flag is ", reconB: " but the rounded bars ",
    reconClose: "close", reconOpen: "do not close", reconC: " within ±", reconD: " — reported only because the two disagree.",
    noPrevBridge: "No bridge had loaded for the previous scope.",
    loadingNote: "Phase B (dissection) still in flight — the hero above is already current.",
    stalePrefix: "Showing previous scope: ",
    methodPrefix: "Method: ",
    scaleShared: "Scale shared with the ", scaleOwn: "Own scale — the ", scaleOwnB: " bridge is unavailable for this scope",
    reportedName: "reported", realisedName: "realised",
    drillCostH: "Cost", drillCostSub: "→ RM / Packaging / Feedtag · estimated",
    drillCostTip: "cost_components: production-order class ratio priced at OITM.LastPurPrc (YTD average) — always an estimate; RM is the remainder and absorbs every error in the other two.",
    drillMixH: "Product mix", drillMixSub: "→ by category (SSG)",
    drillMixTip: "product_mix_by_ssg: the ssg lens rows with zero values dropped; 'UNSPEC' is Untagged.",
    drillMixMerged: "Product mix by category is withheld: the customer / product split is not determinate for this window (T1).",
    drillFootA: "= ", drillFootB: " bar",
    drillOff: " · rows differ from the bar by ",
    drillShare: "share of |Σ|",
    wedgeA: "Discount wedge ", wedgeB: " (Δ ", wedgeC: ")"
  };

  /* -------------------------------------------------------------------------
   * helpers
   * ---------------------------------------------------------------------- */
  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level]("bridge: " + msg, data); } catch (e) { /* silent */ }
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
  function tol() {
    var t = (typeof C.TOLERANCE === "function") ? num(C.TOLERANCE(null, "canonical")) : null;
    return (t === null || !(t > 0)) ? 3 : t;
  }
  // A plain count / whole percent through the fmt guard (no local toFixed):
  // fmt.signed(n, 0) with its leading "+" dropped. Null -> the dash.
  function whole(v) { var f = F(), s = f.signed(v, 0); return s === f.NULL_TEXT ? s : s.replace(/^\+/, ""); }
  function rangeText(r) {
    var f = F();
    if (!r || r.length !== 2) return DASH;
    return f.signed(r[0], 0) + "…" + f.signed(r[1], 0) + PER_TON;
  }
  function signedTon(v) { var f = F(); return v === null ? DASH : f.signed(v, 0) + PER_TON; }
  // The WARNING sentence the backend appends to note when churn-dominated (T2).
  function warningOf(note) {
    var s = (note == null) ? "" : String(note), i = s.indexOf("WARNING:");
    return i >= 0 ? s.slice(i) : "";
  }
  function stateBlock(state, title, hint) {
    var b = el("div", "mx2-msg"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", title));
    b.appendChild(el("div", "mx2-msg-h", hint || ""));
    return b;
  }

  /* -------------------------------------------------------------------------
   * model — pure: reads one bridge block, returns everything to paint
   * ---------------------------------------------------------------------- */

  // The anchors sentence (C.ANCHORS.panel_rule): base -> compare, verbatim,
  // plus "complete months only" or the like-for-like copy when partial.
  function anchorsOf(src) {
    var f = F(), base = src && src.base_month, comp = src && src.compare_month, win = src && src.window, out = { pair: "", line: "", partial: false };
    if (!base && !comp) return out;
    out.pair = String(base || DASH) + ARROW + String(comp || DASH);
    out.partial = !!(src && src.compare_partial === true);
    if (!out.partial) { out.line = out.pair + " · " + COPY.completeOnly; return out; }
    out.line = out.pair + " · " + COPY.partialA + (C.ANCHORS.partial_copy || "");
    if (isObj(win)) {
      if (num(win.compare_shipping_days) !== null) out.line += " (" + whole(win.compare_shipping_days) + COPY.shippingDays;
      if (num(win.month_progress_pct) !== null) out.line += (num(win.compare_shipping_days) !== null ? ", " : " (") + f.pct(win.month_progress_pct) + COPY.ofMonth;
      if (num(win.compare_shipping_days) !== null || num(win.month_progress_pct) !== null) out.line += ")";
    }
    return out;
  }

  function significanceOf(sig) {
    var f = F(), copy = (GATES.SIGNIFICANCE && GATES.SIGNIFICANCE.copy) || {}, out = { badge: null, note: "" };
    if (!isObj(sig) || sig.available !== true) {
      out.note = (copy.unavailable || "") + (isObj(sig) && sig.reason ? " (" + String(sig.reason) + ")" : "");
      return out;
    }
    var v = String(sig.verdict || ""), z = num(sig.z), p = num(sig.percentile), band = sig.band, n = num(sig.n);
    var zt = z === null ? DASH : f.signed(z, 1);
    var detail = COPY.sigZ + zt + COPY.sigPct + (p === null ? DASH : whole(Math.round(p * 100)) + "%") +
      COPY.sigBand + rangeText(band && band.length === 2 ? [num(band[0]), num(band[1])] : null) + COPY.sigN + whole(n);
    var sentence = (v === "signal") ? COPY.sigSignal : (copy[v] || "");
    out.badge = { text: v || DASH, tone: "neutral", title: (sentence ? sentence + " " : "") + detail };
    out.note = (sentence ? sentence + " " : "") + detail;
    return out;
  }

  // `source` "canonical" | "net". Both blocks share the bridge core (WIRE.
  // NET_BRIDGE.SAME_AS_CANONICAL); significance and cost_components are
  // canonical-only and simply absent on the net block.
  function modelFor(cb, source) {
    var f = F(), M = { ok: false, spec: null, drills: null, badges: [], notes: [], anchors: anchorsOf(cb), method: "", note: "", unavailableReason: null, wedge: "" };
    if (!isObj(cb)) return M;
    if (cb.available !== true) { M.unavailableReason = (cb.reason == null) ? "" : String(cb.reason); return M; }
    M.ok = true;
    M.method = cb.method == null ? "" : String(cb.method);
    M.note = cb.note == null ? "" : String(cb.note);

    var prior = num(cb.prior_gm_ton), current = num(cb.current_gm_ton);
    var price = num(cb.price), cost = num(cb.cost), cm = num(cb.customer_mix), pm = num(cb.product_mix), mixTotal = num(cb.mix_total);
    var mo = cb.mix_ordering, md = cb.mix_detail, cc = cb.cost_components, sig = (source === "net") ? { badge: null, note: "" } : significanceOf(cb.significance);
    var unstable = !!(isObj(mo) && mo.sign_stable === false);
    var churn = !!(isObj(md) && md.churn_dominated === true);
    var steps = [], sum = 0, i, drill, rows;

    // levers
    drill = null;
    if (isObj(cc)) {
      drill = [
        { label: COPY.rm, value: num(cc.rm), role: "est" },
        { label: COPY.packaging, value: num(cc.packaging), role: "est" },
        { label: COPY.feedtag, value: num(cc.feedtag), role: "est" }
      ];
    }
    steps.push({ label: COPY.price, value: price, role: "lever", drill: null });
    steps.push({ label: COPY.cost, value: cost, role: "lever", drill: drill });

    // composition — T1: merged when the split is a modelling artefact
    if (unstable) {
      if (mixTotal === null && cm !== null && pm !== null) mixTotal = cm + pm;
      steps.push({ label: COPY.mixMerged, value: mixTotal, role: "mix", drill: [{ label: COPY.mixMergedNote, value: null }] });
      M.badges.push({ text: COPY.badgeMix, tone: "warn",
        title: (GATES.MIX_ORDERING && GATES.MIX_ORDERING.copy) || COPY.badgeMix });
      M.notes.push({ kind: "mix", text: ((GATES.MIX_ORDERING && GATES.MIX_ORDERING.copy) || "") +
        COPY.rangeA + rangeText(mo.customer_range) + COPY.rangeB + rangeText(mo.product_range) + "." });
    } else {
      rows = cb.product_mix_by_ssg;
      drill = null;
      if (rows && rows.length) {
        drill = [];
        for (i = 0; i < rows.length && i < DRILL_TOP; i++) drill.push({ label: rows[i].ssg, value: num(rows[i].value) });
        drill.push({ label: COPY.prodDrillNote, value: null });
      }
      steps.push({ label: COPY.custMix, value: cm, role: "mix", drill: null });
      steps.push({ label: COPY.prodMix, value: pm, role: "mix", drill: drill });
    }
    if (churn) {
      M.badges.push({ text: COPY.badgeChurn, tone: "warn", title: warningOf(cb.note) || (GATES.MIX_CHURN && GATES.MIX_CHURN.copy) || COPY.badgeChurn });
      M.notes.push({ kind: "churn", text: ((GATES.MIX_CHURN && GATES.MIX_CHURN.copy) || "") +
        COPY.churnA + f.pct(md.one_sided_share_pct) + COPY.churnB + f.pct(md.matched_kg_share_pct) + "." });
    }
    if (sig.badge) M.badges.push(sig.badge);
    if (source !== "net") M.notes.push({ kind: "sig", text: sig.note });

    // closure (C13): our own residual against the rounding-drift bound
    for (i = 0; i < steps.length; i++) if (steps[i].value !== null) sum += steps[i].value;
    var delta = (prior !== null && current !== null) ? current - prior : null;
    var residual = delta === null ? null : delta - sum;
    var bound = tol();
    var showResid = residual !== null && Math.abs(residual) > bound;
    if (showResid) steps.push({ label: COPY.unexplained, value: residual, role: "resid", drill: null });
    var ours = residual === null ? null : !showResid;
    var server = (cb.reconciles === true || cb.reconciles === false) ? cb.reconciles : null;
    if (server !== null && ours !== null && server !== ours) {
      M.notes.push({ kind: "recon", text: COPY.reconA + String(server) + COPY.reconB + (ours ? COPY.reconClose : COPY.reconOpen) +
        COPY.reconC + f.perTon(bound) + PER_TON + COPY.reconD });
    }
    M.residual = residual; M.showResid = showResid; M.tolerance = bound; M.ours = ours; M.server = server;
    M.unstable = unstable; M.churn = churn;

    M.spec = {
      title: "",                                         // the panel header carries the title; the svg's top band holds the DOM badges
      subtitle: null,                                    // the svg prints anchorsNote on the subtitle line
      unit: UNIT,
      anchorStart: { label: COPY.prior + (cb.base_month ? " · " + cb.base_month : ""), value: prior },
      anchorEnd: { label: COPY.current + (cb.compare_month ? " · " + cb.compare_month : ""), value: current },
      steps: steps,
      reconciles: server,
      residual: residual === null ? 0 : residual,
      tolerance: bound,
      toleranceKind: "canonical",
      basisNote: (source === "net") ? C.BASIS_SUFFIX.net : C.BASIS_SUFFIX.reported,
      anchorsNote: M.anchors.line || null,
      footnote: null,
      badges: null,                                      // T1-T3 badges are DOM pills in the chart's top band (paintBadges), never dropped for width
      domain: null                                       // filled by the paint with the union of both bridges
    };

    // The realised bridge carries the discount wedge it walked through.
    if (source === "net" && isObj(cb.discount)) {
      var dp = num(cb.discount.prior_per_ton), dc = num(cb.discount.current_per_ton), dd = num(cb.discount.delta_per_ton);
      if (dp !== null || dc !== null) {
        M.wedge = COPY.wedgeA + (dp === null ? DASH : f.perTon(dp) + PER_TON) + ARROW + (dc === null ? DASH : f.perTon(dc) + PER_TON) +
          COPY.wedgeB + signedTon(dd) + COPY.wedgeC;
      }
    }

    // Reconciling drills (reported variant): each table tied to its parent bar.
    if (source !== "net") {
      M.drills = [];
      if (isObj(cc)) {
        M.drills.push({
          kind: "cost", head: COPY.drillCostH, sub: COPY.drillCostSub, tip: (cc.basis == null ? COPY.drillCostTip : String(cc.basis)),
          rows: [
            { label: COPY.rm + " " + COPY.costEst, value: num(cc.rm) },
            { label: COPY.packaging + " " + COPY.costEst, value: num(cc.packaging) },
            { label: COPY.feedtag + " " + COPY.costEst, value: num(cc.feedtag) }
          ],
          bar: cost, barLabel: COPY.cost
        });
      }
      rows = cb.product_mix_by_ssg;
      if (unstable) {
        M.drills.push({ kind: "mix", head: COPY.drillMixH, sub: COPY.drillMixSub, tip: COPY.drillMixTip, rows: [], bar: pm, barLabel: COPY.prodMix, withheld: COPY.drillMixMerged });
      } else if (rows && rows.length) {
        var mrows = [];
        for (i = 0; i < rows.length; i++) mrows.push({ label: rows[i].ssg == null ? "" : String(rows[i].ssg), value: num(rows[i].value) });
        M.drills.push({ kind: "mix", head: COPY.drillMixH, sub: COPY.drillMixSub, tip: COPY.drillMixTip, rows: mrows, bar: pm, barLabel: COPY.prodMix });
      }
    }
    return M;
  }

  // The union of two waterfall extents — the sanctioned way to put the reported
  // and the realised bridge on ONE scale (mexp2-svg.js waterfallDomain).
  function unionDomain(specA, specB) {
    if (!NS.svg || typeof NS.svg.waterfallDomain !== "function") return null;
    var a, b;
    try { a = NS.svg.waterfallDomain(specA); b = NS.svg.waterfallDomain(specB); } catch (e) { return null; }
    if (!a || !b) return null;
    return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
  }

  /* -------------------------------------------------------------------------
   * the panel factory
   * ---------------------------------------------------------------------- */
  function makeBridge(opts) {
    var PANEL_ID = opts.id, SOURCE = opts.source, OTHER = (SOURCE === "net") ? "canonical" : "net";
    var host = null, R = null, def;

    function blockOf(diss, source) {
      if (!isObj(diss) || diss.available !== true) return null;
      return (source === "net") ? diss.net_bridge : diss.canonical_bridge;
    }

    function build(hostEl) {
      var head = el("div", "mx2-panel-h"), col = el("div", "mx2-panel-hcol");
      R = {};
      R.title = el("div", "mx2-panel-t", opts.title);
      R.sub = el("div", "mx2-panel-st", "");
      R.anchors = el("div", "mx2-panel-st mx2-br-anchors", "");
      R.anchors.setAttribute("title", COPY.anchorsWhy);
      R.basis = el("div", "mx2-panel-st", opts.basis + " · " + C.UNIVERSES.dissection);
      R.scale = el("div", "mx2-panel-st mx2-br-scale", "");
      col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.anchors); col.appendChild(R.basis); col.appendChild(R.scale);
      R.pill = el("span", "mx2-pill");
      R.pill.appendChild(el("span", "mx2-pill-dot"));
      R.pillText = el("span", "", "");
      R.pill.appendChild(R.pillText);
      head.appendChild(col); head.appendChild(R.pill);

      R.banner = el("div", "mx2-stale-banner", COPY.stalePrefix);
      R.bannerLabel = el("span", "mx2-stale-label", "");
      R.banner.appendChild(R.bannerLabel);

      R.body = el("div", "mx2-dimmable mx2-br-body");
      // The svg primitive clears its host on every paint, so the badge band is a
      // sibling above the host inside one wrapper: pills top-right, never dropped.
      R.chartWrap = el("div", "mx2-br-chartwrap");
      R.badges = el("div", "mx2-br-badges");
      R.badges.setAttribute("aria-label", "Trust signals");
      R.chart = el("div", "mx2-br-chart");
      R.chart.setAttribute("aria-label", opts.title + " waterfall");
      R.chartWrap.appendChild(R.chart);
      R.notes = el("div", "mx2-br-notes");
      R.wedge = el("div", "mx2-note mx2-note-strong mx2-br-wedge", "");
      R.drills = el("div", "mx2-duo mx2-br-drills");
      R.noPrev = el("div", "mx2-note", COPY.noPrevBridge);
      R.method = el("div", "mx2-note mx2-br-method", "");
      R.wireNote = el("div", "mx2-note mx2-br-wirenote", "");
      R.body.appendChild(R.chartWrap);
      R.body.appendChild(R.method);
      R.body.appendChild(R.wireNote);

      R.universe = el("div", "mx2-note mx2-br-universe", COPY.universe + " " + COPY.anchorsWhy);

      R.skel = el("div", "mx2-br-skel mx2-skel-rows"); R.skel.setAttribute("data-mx2-for", C.STATE.LOADING_FIRST);
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

    function dropSvg() {
      if (!R || !NS.svg || typeof NS.svg.destroy !== "function") return;
      try { NS.svg.destroy(R.chart); } catch (e) { /* silent */ }
    }

    // T1-T3 pills, top-right of the chart, by DOM membership. Tone and colour
    // are CSS off [data-mx2-tone]; the tooltip is the native title.
    function paintBadges(M) {
      var i, b, p;
      R.badges.innerHTML = "";
      for (i = 0; i < M.badges.length; i++) {
        b = M.badges[i];
        p = el("span", "mx2-br-badge", b.text);
        p.setAttribute("data-mx2-tone", b.tone === "warn" ? "warn" : "neutral");
        p.setAttribute("title", b.title || b.text);
        R.badges.appendChild(p);
      }
      cls(R.chartWrap, "mx2-has-badges", M.badges.length > 0);
      show(R.chartWrap, R.badges, M.badges.length > 0, R.chart);
    }

    function paintNotes(M) {
      var i, n;
      R.notes.innerHTML = "";
      for (i = 0; i < M.notes.length; i++) {
        if (!M.notes[i].text) continue;
        n = el("div", "mx2-note mx2-br-note");
        n.setAttribute("data-mx2-note", M.notes[i].kind);
        if (M.notes[i].kind !== "sig") n.appendChild(el("span", "mx2-warnglyph", "⚠"));
        n.appendChild(el("span", "", M.notes[i].text));
        R.notes.appendChild(n);
      }
      show(R.body, R.notes, R.notes.childNodes.length > 0, R.method);
    }

    // One reconciling drill table: rows (value, share of |Σ|) and a footer that
    // prints the parent bar. A tie within rounding draws nothing extra (C13);
    // a miss says by how much.
    function drillTable(D) {
      var f = F(), box = el("div", "mx2-br-drill"), h = el("div", "mx2-br-drill-h"), t, tb, tr, td, i, r, gross = 0, sum = 0, n = 0, share, tie, off, foot;
      h.appendChild(el("b", "", D.head));
      h.appendChild(document.createTextNode(" " + D.sub));
      h.setAttribute("title", D.tip || "");
      box.appendChild(h);
      if (D.withheld) { box.appendChild(el("div", "mx2-note", D.withheld)); return box; }
      for (i = 0; i < D.rows.length; i++) { r = D.rows[i]; if (r.value === null) continue; gross += Math.abs(r.value); sum += r.value; n++; }
      t = el("table", "mx2-tbl mx2-br-drill-tbl"); tb = el("tbody");
      t.appendChild(el("caption", "mx2-sr", D.head + " " + D.sub));
      for (i = 0; i < D.rows.length; i++) {
        r = D.rows[i];
        if (r.value === null || Math.round(r.value) === 0) continue;
        tr = el("tr");
        td = el("td", "mx2-dim-col", r.label); td.setAttribute("title", r.label); tr.appendChild(td);
        td = el("td", "mx2-num", signedTon(r.value)); cls(td, "mx2-neg", r.value < 0); cls(td, "mx2-pos", r.value > 0); tr.appendChild(td);
        share = gross > 0 ? f.pct(Math.abs(r.value) / gross * 100) : DASH;
        td = el("td", "mx2-num mx2-br-drill-share", share); td.setAttribute("title", COPY.drillShare); tr.appendChild(td);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      // footer: the parent bar, and the miss when the rows do not re-sum to it
      tie = (D.bar === null) ? null : (Math.abs(sum - D.bar) <= Math.max(1.5, n));
      off = (D.bar === null) ? null : sum - D.bar;
      foot = el("tfoot"); tr = el("tr", "mx2-br-drill-foot");
      td = el("td", "mx2-dim-col", COPY.drillFootA + D.barLabel + COPY.drillFootB); tr.appendChild(td);
      td = el("td", "mx2-num", signedTon(D.bar)); cls(td, "mx2-neg", D.bar !== null && D.bar < 0); cls(td, "mx2-pos", D.bar !== null && D.bar > 0); tr.appendChild(td);
      td = el("td", "mx2-num mx2-br-drill-share", ""); tr.appendChild(td);
      foot.appendChild(tr); t.appendChild(foot);
      box.appendChild(t);
      // The miss is a sentence under the table, not a nowrap cell in a 46px
      // column (which overflowed the grid column into the neighbouring panel).
      if (tie === false) box.appendChild(el("div", "mx2-note mx2-br-drill-off", COPY.drillOff.replace(/^ · /, "") + signedTon(off)));
      return box;
    }
    function paintDrills(M) {
      var i;
      R.drills.innerHTML = "";
      if (!M.drills || !M.drills.length) { show(R.body, R.drills, false); return; }
      for (i = 0; i < M.drills.length; i++) R.drills.appendChild(drillTable(M.drills[i]));
      show(R.body, R.drills, true, R.method);
    }

    // Paint one dissection block. `label` is vm.label, or prev.label when stale.
    // Idempotent: every node is rewritten from `diss`; the svg instance is torn
    // down and re-attached (the primitive does the same on its own host).
    function paint(diss, label, stale, status) {
      if (!R || !host) return;
      var mine = blockOf(diss, SOURCE), other = blockOf(diss, OTHER);
      var M = modelFor(mine, SOURCE), A = M.anchors.pair ? M.anchors : anchorsOf(isObj(diss) ? diss : null);
      var effective = status, O = null, dom = null, otherName = (SOURCE === "net") ? COPY.reportedName : COPY.realisedName;

      // ONE SCALE: union this bridge's extents with the other bridge's.
      if (M.ok) {
        O = modelFor(other, OTHER);
        if (O.ok) dom = unionDomain(M.spec, O.spec);
        if (dom) M.spec.domain = dom;
      }

      // header
      setText(R.sub, stale ? COPY.stalePrefix + label : label);
      setText(R.anchors, A.line ? COPY.anchorsPrefix + A.line : "");
      setText(R.scale, M.ok ? (dom ? COPY.scaleShared + otherName + " bridge" : COPY.scaleOwn + otherName + COPY.scaleOwnB) : "");
      cls(host, "mx2-is-stale", stale);
      setText(R.bannerLabel, stale ? label : "");
      show(host, R.banner, stale, R.body);

      // chart + notes + wedge + drills. The optional blocks are detached, then
      // re-attached in ONE fixed order ahead of R.method (always in the DOM), so
      // the layout is identical whichever blocks a payload switches on.
      dropSvg();
      show(R.body, R.noPrev, false); show(R.body, R.chartWrap, false); show(R.body, R.notes, false); show(R.body, R.wedge, false); show(R.body, R.drills, false);
      show(R.body, R.noPrev, stale && !isObj(diss), R.method);
      show(R.body, R.chartWrap, M.ok, R.method);
      paintBadges(M);
      if (M.ok && NS.svg && typeof NS.svg.waterfall === "function") NS.svg.waterfall(R.chart, M.spec);
      paintNotes(M);
      show(R.body, R.wedge, !!M.wedge, R.method);
      setText(R.wedge, M.wedge);
      paintDrills(M);
      setText(R.method, M.method ? COPY.methodPrefix + M.method : "");
      setText(R.wireNote, M.note);

      // state-block copy that depends on the payload
      setText(R.erroredTitle, (stale || isObj(diss)) ? C.STATE_COPY["errored-stale"] : C.STATE_COPY[C.STATE.ERRORED]);
      setText(R.unavailHint, "");
      if (isObj(diss) && diss.available === false) setText(R.unavailHint, diss.reason == null ? "" : String(diss.reason));
      // A bridge block that is itself the two-key unavailable form inside an
      // available dissection (C5): the store reports FRESH because the block is
      // present; this panel is the only place that can see inside it, so it
      // surfaces the state itself and prints the reason verbatim.
      if (M.unavailableReason !== null && (status === C.STATE.FRESH || status == null)) {
        effective = C.STATE.UNAVAILABLE_FOR_SCOPE;
        setText(R.unavailHint, M.unavailableReason);
      }
      if (effective && effective !== status) def.setStatus(effective);
    }

    def = {
      slot: "body",
      phase: "diss",

      mount: function (hostEl) {
        if (!hostEl) return;
        if (host && host !== hostEl) def.destroy();
        host = hostEl;
        cls(host, "mx2-panel-bridge", true);
        cls(host, "mx2-panel-" + PANEL_ID, true);
        build(host);
        dbg("info", "mounted " + PANEL_ID);
      },

      render: function (vm) {
        if (!R || !host) return;
        vm = vm || {};
        paint(vm.diss || null, vm.label || "", false, host.getAttribute("data-mx2-status") || null);
      },

      renderStale: function (prev, vm) {
        if (!R || !host) return;
        vm = vm || {};
        if (!prev) { def.render(vm); return; }   // contract says never call with null; degrade honestly
        paint(prev.diss || null, prev.label || "", true, host.getAttribute("data-mx2-status") || null);
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
          cls(host, "mx2-panel-bridge", false);
          cls(host, "mx2-panel-" + PANEL_ID, false);
          host.innerHTML = "";
        }
        host = null; R = null;
      },

      // test probes — not used by the controller
      _model: function (cb) { return modelFor(cb, SOURCE); },
      _anchors: anchorsOf,
      _significance: significanceOf,
      _union: unionDomain,
      SOURCE: SOURCE,
      COPY: COPY
    };
    return def;
  }

  NS.panel("bridge", makeBridge({
    id: "bridge", source: "canonical",
    title: "GM/ton bridge — reported",
    basis: C.BASIS_SUFFIX.reported + " · exact Bennet at customer×SKU · Price and Cost are levers, Mix is composition"
  }));
  NS.panel("netbridge", makeBridge({
    id: "netbridge", source: "net",
    title: "GM/ton bridge — realised",
    basis: C.BASIS_SUFFIX.net + " · same decomposition on rows with OINV.DiscSum subtracted from revenue and GP"
  }));
})();
