/* ============================================================================
 * mexp2-panel-bridge.js — Margin Explorer v2 · THE GM/TON BRIDGE (MEXP2.panel "bridge")
 * ----------------------------------------------------------------------------
 * WHAT THIS PANEL SHOWS
 *   diss.canonical_bridge (phase B, WIRE.CANONICAL_BRIDGE): the exact Bennet
 *   decomposition of GM/ton between a MONTH PAIR — prior_gm_ton -> current_gm_ton
 *   through price, cost, customer_mix, product_mix — drawn by MEXP2.svg.waterfall
 *   (delta-framed axis, numeral-only anchor strip, hatched estimates), with the
 *   backend's three trust signals as badges INLINE at the top-right of the chart.
 *
 * TRUST BADGES (T1-T3, C.TRUST_GATES)
 *   - mix_ordering.sign_stable === false  -> "mix split unstable": the customer /
 *     product bars are MERGED into one "Mix" bar valued at mix_total. The split
 *     is not quoted anywhere, not even greyed; the two ranges are the reason.
 *   - mix_detail.churn_dominated === true -> "churn-dominated", the backend's
 *     WARNING sentence (appended to canonical_bridge.note) in the tooltip.
 *   - significance.available === true     -> the verdict word (noise / weak /
 *     signal), z in the tooltip. No badge at all when unavailable.
 *
 * CLOSURE (C13)
 *   residual = (current - prior) - sum(drawn bars). Under C.TOLERANCE(_,
 *   "canonical") (3 PHP/ton of rounding drift) NOTHING is drawn — no tick, no
 *   badge. Above it an "Unexplained (rounding drift)" bar is pushed as a step,
 *   role resid, so the label names it honestly. The server's `reconciles` flag
 *   is printed ONLY when it disagrees with the client closure.
 *
 * COST SPLIT (C12)
 *   cost_components (rm / packaging / feedtag) are ALWAYS an estimate. They are
 *   the Cost bar's drill (tooltip) AND a hatched sub-strip under the chart —
 *   role "est" on every step, the basis string in the sub-strip's tooltip.
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
 *     panel. A canonical_bridge that is itself {available:false, reason} inside
 *     an available dissection is surfaced by this panel as unavailable-for-
 *     scope with the reason verbatim (the store cannot see inside the block).
 *   - Every number through MEXP2.fmt; every colour via --mx2-* inside the svg
 *     primitive; status chrome is CSS off [data-mx2-status]; show/hide by DOM
 *     membership. All classes .mx2-*. No console.*, no fetch, no store mutation.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-panel-bridge: mexp2-contract.js must load before this file.");

  var PANEL_ID = "bridge";
  var UNIT = "php_per_ton";
  var DASH = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var PER_TON = (C.NUM && C.NUM.PER_TON) || "/t";
  var ARROW = " → ";
  var DRILL_TOP = 5;            // product_mix_by_ssg rows carried into the Product mix tooltip
  var GATES = C.TRUST_GATES || {};

  var COPY = {
    title: "GM/ton bridge",
    subtitle: "Exact Bennet at customer×SKU · Price and Cost are levers, Mix is composition",
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
    costSplitTitle: "Cost bar split — estimated",
    costSplitSub: "production-order class ratio; RM is the remainder and absorbs every error",
    afterCost: "After Cost",
    costFoot: "Cost split is an estimate",
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
    methodPrefix: "Method: "
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
  // The WARNING sentence the backend appends to note when churn-dominated (T2).
  function warningOf(note) {
    var s = (note == null) ? "" : String(note), i = s.indexOf("WARNING:");
    return i >= 0 ? s.slice(i) : "";
  }

  /* -------------------------------------------------------------------------
   * model — pure: reads one canonical bridge, returns everything to paint
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

  function modelFor(cb) {
    var f = F(), M = { ok: false, spec: null, cost: null, badges: [], notes: [], anchors: anchorsOf(cb), method: "", note: "", unavailableReason: null };
    if (!isObj(cb)) return M;
    if (cb.available !== true) { M.unavailableReason = (cb.reason == null) ? "" : String(cb.reason); return M; }
    M.ok = true;
    M.method = cb.method == null ? "" : String(cb.method);
    M.note = cb.note == null ? "" : String(cb.note);

    var prior = num(cb.prior_gm_ton), current = num(cb.current_gm_ton);
    var price = num(cb.price), cost = num(cb.cost), cm = num(cb.customer_mix), pm = num(cb.product_mix), mixTotal = num(cb.mix_total);
    var mo = cb.mix_ordering, md = cb.mix_detail, cc = cb.cost_components, sig = significanceOf(cb.significance);
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
    M.notes.push({ kind: "sig", text: sig.note });

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
      basisNote: C.BASIS_SUFFIX.reported,
      anchorsNote: M.anchors.line || null,
      footnote: isObj(cc) ? COPY.costFoot : null,
      badges: null                                       // T1-T3 badges are DOM pills in the chart's top band (paintBadges), never dropped for width
    };

    // C12: the hatched sub-strip — a walk from the prior level through the
    // three estimated components to prior + cost. rm is the remainder, so it
    // closes by construction; the svg's own drift gate covers any rounding.
    if (isObj(cc) && cost !== null && prior !== null) {
      M.cost = {
        basis: cc.basis == null ? "" : String(cc.basis),
        spec: {
          title: COPY.costSplitTitle,
          subtitle: COPY.costSplitSub,
          unit: UNIT,
          orientation: "horizontal",
          anchorStart: { label: COPY.prior, value: prior },
          anchorEnd: { label: COPY.afterCost, value: prior + cost },
          steps: [
            { label: COPY.rm, value: num(cc.rm), role: "est", drill: null },
            { label: COPY.packaging, value: num(cc.packaging), role: "est", drill: null },
            { label: COPY.feedtag, value: num(cc.feedtag), role: "est", drill: null }
          ],
          toleranceKind: "canonical",
          basisNote: C.BASIS_SUFFIX.reported,
          anchorsNote: M.anchors.pair || null,
          footnote: cc.basis == null ? null : String(cc.basis)
        }
      };
    }
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
    R.anchors = el("div", "mx2-panel-st mx2-br-anchors", "");
    R.anchors.setAttribute("title", COPY.anchorsWhy);
    R.basis = el("div", "mx2-panel-st", C.BASIS_SUFFIX.reported + " · " + C.UNIVERSES.dissection);
    col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.anchors); col.appendChild(R.basis);
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
    R.chart.setAttribute("aria-label", "GM per ton bridge waterfall");
    R.chartWrap.appendChild(R.chart);
    R.notes = el("div", "mx2-br-notes");
    R.costWrap = el("div", "mx2-br-cost");
    R.costHost = el("div", "mx2-br-cost-chart");
    R.costWrap.appendChild(R.costHost);
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
  function stateBlock(state, title, hint) {
    var b = el("div", "mx2-msg"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", title));
    b.appendChild(el("div", "mx2-msg-h", hint || ""));
    return b;
  }

  function dropSvg() {
    if (!R || !NS.svg || typeof NS.svg.destroy !== "function") return;
    try { NS.svg.destroy(R.chart); } catch (e) { /* silent */ }
    try { NS.svg.destroy(R.costHost); } catch (e2) { /* silent */ }
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

  // Paint one dissection block. `label` is vm.label, or prev.label when stale.
  // Idempotent: every node is rewritten from `diss`; the svg instances are
  // torn down and re-attached (the primitive does the same on its own host).
  function paint(diss, label, stale, status) {
    if (!R || !host) return;
    var cb = (isObj(diss) && diss.available === true) ? diss.canonical_bridge : null;
    var M = modelFor(cb), A = M.anchors.pair ? M.anchors : anchorsOf(isObj(diss) ? diss : null);
    var effective = status;

    // header
    setText(R.sub, stale ? COPY.stalePrefix + label : label);
    setText(R.anchors, A.line ? COPY.anchorsPrefix + A.line : "");
    cls(host, "mx2-is-stale", stale);
    setText(R.bannerLabel, stale ? label : "");
    show(host, R.banner, stale, R.body);

    // chart + notes + cost sub-strip. The optional blocks are detached, then
    // re-attached in ONE fixed order ahead of R.method (always in the DOM), so
    // the layout is identical whichever blocks a payload switches on.
    dropSvg();
    show(R.body, R.noPrev, false); show(R.body, R.chartWrap, false); show(R.body, R.notes, false); show(R.body, R.costWrap, false);
    show(R.body, R.noPrev, stale && !isObj(diss), R.method);
    show(R.body, R.chartWrap, M.ok, R.method);
    paintBadges(M);
    if (M.ok && NS.svg && typeof NS.svg.waterfall === "function") NS.svg.waterfall(R.chart, M.spec);
    paintNotes(M);
    show(R.body, R.costWrap, !!M.cost, R.method);
    if (M.cost) {
      R.costWrap.setAttribute("title", M.cost.basis);
      if (NS.svg && typeof NS.svg.waterfall === "function") NS.svg.waterfall(R.costHost, M.cost.spec);
    } else {
      R.costWrap.removeAttribute("title");
    }
    setText(R.method, M.method ? COPY.methodPrefix + M.method : "");
    setText(R.wireNote, M.note);

    // state-block copy that depends on the payload
    setText(R.erroredTitle, (stale || isObj(diss)) ? C.STATE_COPY["errored-stale"] : C.STATE_COPY[C.STATE.ERRORED]);
    setText(R.unavailHint, "");
    if (isObj(diss) && diss.available === false) setText(R.unavailHint, diss.reason == null ? "" : String(diss.reason));
    // A canonical_bridge that is itself the two-key unavailable form inside an
    // available dissection (C5): the store reports FRESH because the block is
    // present; this panel is the only place that can see inside it, so it
    // surfaces the state itself and prints the reason verbatim.
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
      cls(host, "mx2-panel-bridge", true);
      build(host);
      dbg("info", "mounted");
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
        host.innerHTML = "";
      }
      host = null; R = null;
    },

    // test probes — not used by the controller
    _model: modelFor,
    _anchors: anchorsOf,
    _significance: significanceOf,
    COPY: COPY
  };

  NS.panel(PANEL_ID, def);
})();
