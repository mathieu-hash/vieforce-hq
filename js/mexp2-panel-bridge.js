/* ============================================================================
 * mexp2-panel-bridge.js — Margin Explorer v2 · THE GM/TON BRIDGES
 *   MEXP2.panel "bridge"     — REPORTED: diss.canonical_bridge (gross of the
 *                              off-invoice discount). The right box of the page
 *                              body; the host page grafts v1's two reconciling
 *                              drill tables (Cost, Product Mix by SSG) under it.
 *   MEXP2.panel "netbridge"  — REALISED: diss.net_bridge (net of the off-invoice
 *                              discount). The bottom section of the page: the
 *                              net waterfall beside a three-number strip
 *                              (Δ reported · Δ off-invoice discount · Δ realised)
 *                              and the four composition lenses (Category · BU · Region · Customer).
 * ----------------------------------------------------------------------------
 * ONE implementation, two registrations: makeBridge(opts) closes over its own
 * host / refs, so the reported and the realised bridge are the same code with
 * a different source block. Both draw MEXP2.svg.waterfall (delta-framed axis,
 * numeral-only anchor strip "Prior GM/t · base -> Current GM/t · compare").
 *
 * ONE SCALE (the owner's ask)
 *   sharedDomain(diss) computes the union of both bridges' cumulative-delta
 *   extents ONCE per dissection object (MEXP2.svg.waterfallDomain over both
 *   specs, memoised on the diss reference the adapter hands every panel) and
 *   both panels pass that union as spec.domain. When the other bridge is
 *   unavailable for the scope the subtitle says "own scale".
 *
 * THREE BADGES, ONE DETAILS TOGGLE (the owner's ③)
 *   Under the chart, and nothing else in small print:
 *     "partial · N of M days"  compare_partial, shipping days from window
 *     "mix unstable"           mix_ordering.sign_stable === false (T1) or
 *                              mix_detail.churn_dominated === true (T2)
 *     "reconciled"             the CLIENT closure — the rounded bars re-sum to
 *                              the anchor delta within C.TOLERANCE — passes
 *   A small "details" toggle reveals the full text: v1's paragraph (the
 *   backend note, the partial flag, the server reconciles flag), the trust
 *   sentences with their ranges / shares, the significance verdict (reported
 *   only), the method, the universe and anchor rules.
 *
 * T1 IN THE CHART
 *   sign_stable === false merges the customer / product bars into one "Mix"
 *   bar valued at mix_total; the split is not quoted anywhere.
 *
 * CLOSURE (C13)
 *   residual = (current - prior) - sum(drawn bars). Under C.TOLERANCE(_,
 *   "canonical") (3 PHP/ton of rounding drift) the "reconciled" badge is shown
 *   and no bar is drawn. Above it an "Unexplained (rounding drift)" bar is
 *   pushed as a step, role resid. The server's `reconciles` flag is quoted in
 *   the details only.
 *
 * NET VARIANT EXTRAS
 *   - the strip reads net_bridge.vs_reported (delta_reported, delta_net) and
 *     net_bridge.discount.delta_per_ton; when the reported and realised deltas
 *     (or the reported and realised price) disagree in sign one line says so.
 *   - the drivers table reads net_bridge.lenses through a selector Category |
 *     BU | Region | Customer (WIRE.LENS_DIMS, never Object.keys): top 7 rows by
 *     |effect|, columns effect · share before -> after · GM/t before -> after.
 *     The BU option is hidden while the page BU filter is a single BU. When
 *     sign_stable is false the table is withheld and the T1 sentence stands.
 *
 * ANCHOR HONESTY (C.ANCHORS)
 *   base_month -> compare_month — the first and last COMPLETE months inside
 *   the selected period — are printed on the anchor strip and the chart
 *   subtitle, never the period itself.
 *
 * RULES THIS FILE OBEYS
 *   - Lifecycle per C.PANEL_LIFECYCLE. render() reads only its vm; renderStale()
 *     paints prev.diss and PRINTS prev.label (header + gold banner).
 *   - phase "diss". A bridge block that is itself {available:false, reason}
 *     inside an available dissection is surfaced as unavailable-for-scope with
 *     the reason verbatim; while a refresh is in flight the same reason is
 *     printed inline so the box always carries a state.
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
  var DRIVER_ROWS = 7;          // the drivers table: top N by |effect|
  var GATES = C.TRUST_GATES || {};
  var LENS_DIMS = ["ssg", "bu", "region", "customer"];
  var LENS_LABEL = { ssg: "Category", bu: "BU", region: "Region", customer: "Customer" };
  var LENS_TITLE = { ssg: "Category · SSG", bu: "Business unit", region: "Region", customer: "Customer" };
  var LENS_FILTER = { bu: "bu", region: "region", customer: "customer" };   // the three server filters; ssg is not one

  var COPY = {
    universe: "Finished feed (103) only; nets credit notes. Does not tie to the hero.",
    anchorsWhy: "Month-pair anchors: the first and last complete months inside the selected period — never the period itself (the running month is excluded).",
    completeOnly: "complete months only",
    partialA: "compare month is partial — ",
    shippingDays: " shipping days",
    ofMonth: " of the month",
    prior: "Prior GM/t", current: "Current GM/t",
    price: "Price", cost: "Cost", custMix: "Customer mix", prodMix: "Product mix",
    mixMerged: "Mix",
    mixMergedNote: "customer + product merged — the split is not determinate for this window",
    unexplained: "Unexplained (rounding drift)",
    rm: "Raw materials", packaging: "Packaging", feedtag: "Feedtag",
    badgePartial: "partial", badgePartialOf: " of ", badgePartialDays: " days",
    badgePartialTip: "The compare month is still running: an early read.",
    badgeMix: "mix unstable",
    badgeRecon: "reconciled",
    badgeReconTip: "The rounded bars re-sum to the anchor delta within ±",
    badgeReconTipB: " (the rounding-drift bound).",
    detailsOpen: "details", detailsClose: "hide details",
    partialV1: "(partial — early read) ",
    serverRecon: " · server reconciles ✓",
    likeA: "Like-for-like windows — ", likeB: " vs ", likeC: ", ", likeD: " shipping days.",
    notLike: "Windows are NOT like-for-like — ",
    progressA: "Compare month is ", progressB: " elapsed (last posted ", progressC: ") — this is an early read.",
    splitStable: "Customer / product split is stable across decomposition order.",
    rangeA: " Customer range ", rangeB: " · product range ",
    churnOk: "Mix is driven by continuing customers (matched pairs cover ", churnOkB: " of current tonnage).",
    churnA: " One-sided share ", churnB: " · matched kg share ",
    closureOk: "Closure: the rounded bars re-sum to the anchor delta within ±",
    closureOff: "Closure: the rounded bars miss the anchor delta by ",
    closureOffB: " — drawn as the Unexplained bar (rounding drift beyond ±", closureOffC: ").",
    sigSignal: "Unusual: outside the historical range of month-pair moves.",
    sigZ: "z ", sigPct: " · percentile ", sigBand: " · band ", sigN: " · n ",
    reconA: "Server reconciles flag is ", reconB: " but the rounded bars ",
    reconClose: "close", reconOpen: "do not close", reconC: " within ±", reconD: " — reported only because the two disagree.",
    noPrevBridge: "No bridge had loaded for the previous scope.",
    noBridgeA: "No bridge for ", noBridgeB: " — ",
    loadingNote: "Phase B (dissection) still in flight — the hero above is already current.",
    stalePrefix: "Showing previous scope: ",
    methodPrefix: "Method: ",
    scaleShared: "scale shared with the ", scaleOwn: "own scale — the ", scaleOwnB: " bridge is unavailable for this scope",
    reportedName: "reported", realisedName: "realised",
    wedgeA: "Discount wedge ", wedgeB: " (Δ ", wedgeC: ")",
    // net strip
    stripReported: "Δ reported", stripDiscount: "Δ discount", stripNet: "Δ realised",
    stripReportedB: "GM/t, gross of discount", stripDiscountB: "off-invoice (OINV.DiscSum) per ton", stripNetB: "GM/t, net of discount",
    stripDiscountTip: "A positive discount change lowers realised margin by the same amount.",
    // net composition lenses
    lensEyebrow: "Composition lenses", lensTitle: "Where the mix moved",
    lensSub: "Standalone one-dimensional share-shifts, net of discount · sorted by |effect| · lenses do not sum to each other nor to the Mix bars",
    lensRows: " rows", lensTotalB: "net effect", lensNone: "No rows in this lens for the window.",
    lensOf: " of ", lensCov: " of tonnage",
    lensFilterTip: "Click to filter the page on ",
    lensFoot: "top " + DRIVER_ROWS + " by |effect| · ₱/t vs prior window",
    lensNew: "new", lensGone: "gone", lensNewTip: "Present in the compare window only", lensGoneTip: "Present in the base window only",
    thEffect: "effect ₱/t", thShare: "share of tonnage", thGm: "GM/t",
    shiftTip: "share shift "
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
  function isArr(v) { return isObj(v) && typeof v.length === "number"; }
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
  function tonOrDash(v) { var f = F(); return v === null ? DASH : f.perTon(v); }
  function stateBlock(state, title, hint) {
    var b = el("div", "mx2-msg"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", title));
    b.appendChild(el("div", "mx2-msg-h", hint || ""));
    return b;
  }
  function blockOf(diss, source) {
    if (!isObj(diss) || diss.available !== true) return null;
    return (source === "net") ? diss.net_bridge : diss.canonical_bridge;
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
    var f = F(), copy = (GATES.SIGNIFICANCE && GATES.SIGNIFICANCE.copy) || {}, out = { verdict: "", note: "" };
    if (!isObj(sig) || sig.available !== true) {
      out.note = (copy.unavailable || "") + (isObj(sig) && sig.reason ? " (" + String(sig.reason) + ")" : "");
      return out;
    }
    var v = String(sig.verdict || ""), z = num(sig.z), p = num(sig.percentile), band = sig.band, n = num(sig.n);
    var zt = z === null ? DASH : f.signed(z, 1);
    var detail = COPY.sigZ + zt + COPY.sigPct + (p === null ? DASH : whole(Math.round(p * 100)) + "%") +
      COPY.sigBand + rangeText(band && band.length === 2 ? [num(band[0]), num(band[1])] : null) + COPY.sigN + whole(n);
    var sentence = (v === "signal") ? COPY.sigSignal : (copy[v] || "");
    out.verdict = v;
    out.note = "Significance: " + (v || DASH) + " — " + (sentence ? sentence + " " : "") + detail;
    return out;
  }

  // The like-for-like / partial sentences from the window block (v1's trust lines).
  function windowLines(cb) {
    var f = F(), w = cb.window, out = [];
    if (!isObj(w)) return out;
    if (isArr(w.base_window) && isArr(w.compare_window)) {
      out.push(w.like_for_like
        ? COPY.likeA + w.base_window.join(" … ") + COPY.likeB + w.compare_window.join(" … ") + COPY.likeC + whole(w.base_shipping_days) + COPY.likeB + whole(w.compare_shipping_days) + COPY.likeD
        : COPY.notLike + whole(w.base_shipping_days) + COPY.likeB + whole(w.compare_shipping_days) + COPY.likeD);
    }
    if (w.compare_partial === true || cb.compare_partial === true) {
      out.push(COPY.progressA + (num(w.month_progress_pct) === null ? DASH : f.pct(w.month_progress_pct)) + COPY.progressB + (w.last_posted_date == null ? DASH : String(w.last_posted_date)) + COPY.progressC);
    }
    return out;
  }

  // `source` "canonical" | "net". Both blocks share the bridge core (WIRE.
  // NET_BRIDGE.SAME_AS_CANONICAL); significance and cost_components are
  // canonical-only, discount / vs_reported are net-only.
  function modelFor(cb, source) {
    var f = F(), M = { ok: false, spec: null, badges: [], details: [], anchors: anchorsOf(cb), unavailableReason: null, strip: null, lenses: null, unstable: false, churn: false, current: null };
    if (!isObj(cb)) return M;
    if (cb.available !== true) { M.unavailableReason = (cb.reason == null) ? "" : String(cb.reason); return M; }
    M.ok = true;
    var method = cb.method == null ? "" : String(cb.method);
    var note = cb.note == null ? "" : String(cb.note);

    var prior = num(cb.prior_gm_ton), current = num(cb.current_gm_ton);
    M.current = current;
    var price = num(cb.price), cost = num(cb.cost), cm = num(cb.customer_mix), pm = num(cb.product_mix), mixTotal = num(cb.mix_total);
    var mo = cb.mix_ordering, md = cb.mix_detail, cc = cb.cost_components, win = cb.window;
    var sig = (source === "net") ? null : significanceOf(cb.significance);
    var unstable = !!(isObj(mo) && mo.sign_stable === false);
    var churn = !!(isObj(md) && md.churn_dominated === true);
    var partial = (cb.compare_partial === true);
    var steps = [], sum = 0, i, drill, rows;

    // levers — the cost split rides in the Cost bar's tooltip (the drill
    // TABLES are v1's, grafted under the reported box by the host page)
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
    } else {
      rows = cb.product_mix_by_ssg;
      drill = null;
      if (isArr(rows) && rows.length) {
        drill = [];
        for (i = 0; i < rows.length && i < 5; i++) drill.push({ label: rows[i].ssg, value: num(rows[i].value) });
      }
      steps.push({ label: COPY.custMix, value: cm, role: "mix", drill: null });
      steps.push({ label: COPY.prodMix, value: pm, role: "mix", drill: drill });
    }

    // closure (C13): our own residual against the rounding-drift bound
    for (i = 0; i < steps.length; i++) if (steps[i].value !== null) sum += steps[i].value;
    var delta = (prior !== null && current !== null) ? current - prior : null;
    var residual = delta === null ? null : delta - sum;
    var bound = tol();
    var showResid = residual !== null && Math.abs(residual) > bound;
    if (showResid) steps.push({ label: COPY.unexplained, value: residual, role: "resid", drill: null });
    var ours = residual === null ? null : !showResid;
    var server = (cb.reconciles === true || cb.reconciles === false) ? cb.reconciles : null;
    M.residual = residual; M.showResid = showResid; M.tolerance = bound; M.ours = ours; M.server = server;
    M.unstable = unstable; M.churn = churn; M.partial = partial;

    // ---- the three badges ------------------------------------------------
    if (partial) {
      var days = isObj(win) ? num(win.compare_shipping_days) : null, full = isObj(win) ? num(win.compare_shipping_days_full_month) : null;
      M.badges.push({ kind: "partial", tone: "warn",
        text: COPY.badgePartial + ((days !== null && full !== null) ? " · " + whole(days) + COPY.badgePartialOf + whole(full) + COPY.badgePartialDays : ""),
        title: COPY.badgePartialTip + " " + (C.ANCHORS.partial_copy || "") });
    }
    if (unstable || churn) {
      M.badges.push({ kind: "mix", tone: "warn", text: COPY.badgeMix,
        title: (unstable ? ((GATES.MIX_ORDERING && GATES.MIX_ORDERING.copy) || "") + " " : "") + (churn ? ((GATES.MIX_CHURN && GATES.MIX_CHURN.copy) || "") : "") });
    }
    if (ours === true) {
      M.badges.push({ kind: "recon", tone: "ok", text: COPY.badgeRecon, title: COPY.badgeReconTip + f.perTon(bound) + PER_TON + COPY.badgeReconTipB });
    }

    // ---- the details: v1's paragraph first, then every sentence the badges compress ----
    M.details.push((partial ? COPY.partialV1 : "") + note + (server === true ? COPY.serverRecon : ""));
    M.details = M.details.concat(windowLines(cb));
    M.details.push(unstable
      ? ((GATES.MIX_ORDERING && GATES.MIX_ORDERING.copy) || "") + COPY.rangeA + rangeText(mo.customer_range) + COPY.rangeB + rangeText(mo.product_range) + "."
      : COPY.splitStable);
    if (isObj(md)) {
      M.details.push(churn
        ? ((GATES.MIX_CHURN && GATES.MIX_CHURN.copy) || "") + COPY.churnA + f.pct(md.one_sided_share_pct) + COPY.churnB + f.pct(md.matched_kg_share_pct) + "."
        : COPY.churnOk + f.pct(md.matched_kg_share_pct) + COPY.churnOkB);
    }
    if (sig && sig.note) M.details.push(sig.note);
    if (ours === true) M.details.push(COPY.closureOk + f.perTon(bound) + PER_TON + ".");
    else if (showResid) M.details.push(COPY.closureOff + signedTon(residual) + COPY.closureOffB + f.perTon(bound) + PER_TON + COPY.closureOffC);
    if (server !== null && ours !== null && server !== ours) {
      M.details.push(COPY.reconA + String(server) + COPY.reconB + (ours ? COPY.reconClose : COPY.reconOpen) + COPY.reconC + f.perTon(bound) + PER_TON + COPY.reconD);
    }
    if (source === "net" && isObj(cb.discount)) {
      var dp = num(cb.discount.prior_per_ton), dc = num(cb.discount.current_per_ton), dd = num(cb.discount.delta_per_ton);
      if (dp !== null || dc !== null) {
        M.details.push(COPY.wedgeA + (dp === null ? DASH : f.perTon(dp) + PER_TON) + ARROW + (dc === null ? DASH : f.perTon(dc) + PER_TON) + COPY.wedgeB + signedTon(dd) + COPY.wedgeC);
      }
    }
    if (method) M.details.push(COPY.methodPrefix + method);
    M.details.push(COPY.universe + " " + COPY.anchorsWhy);

    M.spec = {
      title: "",                                         // the panel header carries the title
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
      badges: null,                                      // the badges are DOM pills under the chart, never dropped for width
      domain: null                                       // filled by the paint with the union of both bridges
    };

    // ---- net-only: the three-number strip and the lenses ------------------
    if (source === "net") {
      var vs = isObj(cb.vs_reported) ? cb.vs_reported : {}, disc = isObj(cb.discount) ? cb.discount : {};
      var dr = num(vs.delta_reported), dn = num(vs.delta_net), gap = num(vs.gap);
      var dDisc = num(disc.delta_per_ton);
      if (dDisc === null && gap !== null) dDisc = -gap;              // gap = net - reported = -(discount change)
      if (dn === null && dr !== null && dDisc !== null) dn = dr - dDisc;
      M.strip = { reported: dr, discount: dDisc, net: dn };
      M.lenses = lensesOf(cb.lenses);
    }
    return M;
  }

  // Iterate LENS_DIMS, never Object.keys (canonical lenses carry a note string).
  // Rows sorted by |value| desc and cut to DRIVER_ROWS; `n` is the server's row
  // count, `total` the lens total over ALL rows.
  function lensesOf(L) {
    var out = {}, i, j, dim, lens, rows, r, v, list;
    if (!isObj(L)) return out;
    for (i = 0; i < LENS_DIMS.length; i++) {
      dim = LENS_DIMS[i]; lens = L[dim];
      if (!isObj(lens) || !isArr(lens.rows)) continue;
      rows = lens.rows; list = [];
      for (j = 0; j < rows.length; j++) {
        r = rows[j]; if (!isObj(r)) continue;
        v = num(r.value); if (v === null) continue;
        list.push({ key: r.key == null ? "" : String(r.key), value: v, share0: num(r.share0_pct), share1: num(r.share1_pct),
          shift: num(r.share_shift_pp), gm0: num(r.gm_ton0), gm1: num(r.gm_ton1), tons0: num(r.tons0), tons1: num(r.tons1) });
      }
      list.sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); });
      var kept = list.slice(0, DRIVER_ROWS), cov = 0, k;
      for (k = 0; k < kept.length; k++) if (kept[k].share1 !== null) cov += kept[k].share1;
      out[dim] = { total: num(lens.total), n: list.length, rows: kept, coverage: kept.length ? cov : null };
    }
    return out;
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
  // Computed ONCE per dissection object: the adapter hands both panels the same
  // vm.diss (or prev.diss) reference, so the second panel reads the memo.
  var DOMAIN_MEMO = { diss: null, dom: null };
  function sharedDomain(diss) {
    if (!isObj(diss)) return null;
    if (DOMAIN_MEMO.diss === diss) return DOMAIN_MEMO.dom;
    var A = modelFor(blockOf(diss, "canonical"), "canonical"), B = modelFor(blockOf(diss, "net"), "net"), dom = null;
    if (A.ok && B.ok) dom = unionDomain(A.spec, B.spec);
    DOMAIN_MEMO.diss = diss; DOMAIN_MEMO.dom = dom;
    return dom;
  }

  /* -------------------------------------------------------------------------
   * the panel factory
   * ---------------------------------------------------------------------- */
  function makeBridge(opts) {
    var PANEL_ID = opts.id, SOURCE = opts.source, NET = (SOURCE === "net");
    var host = null, R = null, def;
    var detailsOpen = false;          // the details toggle, kept across repaints

    function build(hostEl) {
      var head = el("div", "mx2-panel-h"), col = el("div", "mx2-panel-hcol");
      R = {};
      R.title = el("div", "mx2-panel-t", opts.title);
      R.sub = el("div", "mx2-panel-st", "");
      R.basis = el("div", "mx2-panel-st mx2-br-basis", "");
      col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.basis);
      R.pill = el("span", "mx2-pill");
      R.pill.appendChild(el("span", "mx2-pill-dot"));
      R.pillText = el("span", "", "");
      R.pill.appendChild(R.pillText);
      head.appendChild(col); head.appendChild(R.pill);

      R.banner = el("div", "mx2-stale-banner", COPY.stalePrefix);
      R.bannerLabel = el("span", "mx2-stale-label", "");
      R.banner.appendChild(R.bannerLabel);

      R.body = el("div", "mx2-dimmable mx2-br-body");
      // The net box is a grid: the waterfall column and the strip / drivers column.
      if (NET) {
        R.grid = el("div", "mx2-nb-grid");
        R.main = el("div", "mx2-nb-col mx2-nb-main");
        R.side = el("div", "mx2-nb-col mx2-nb-side");
        R.grid.appendChild(R.main); R.grid.appendChild(R.side);
        R.body.appendChild(R.grid);
      } else {
        R.main = R.body;
      }
      // The svg primitive clears its host on every paint, so the chart sits in
      // its own wrapper and the badge row is a sibling under it.
      R.chartWrap = el("div", "mx2-br-chartwrap");
      R.chart = el("div", "mx2-br-chart");
      R.chart.setAttribute("aria-label", opts.title + " waterfall");
      R.chartWrap.appendChild(R.chart);
      R.noBridge = el("div", "mx2-note mx2-note-strong mx2-br-nobridge", "");
      R.noPrev = el("div", "mx2-note", COPY.noPrevBridge);
      R.badgeRow = el("div", "mx2-br-badgerow");
      R.badges = el("div", "mx2-br-badges");
      R.badges.setAttribute("aria-label", "Trust signals");
      R.detailsBtn = el("button", "mx2-btn mx2-btn-quiet mx2-br-details-btn", COPY.detailsOpen);
      R.detailsBtn.setAttribute("type", "button");
      R.detailsBtn.setAttribute("aria-expanded", "false");
      R.detailsBtn.addEventListener("click", onDetails);
      R.badgeRow.appendChild(R.badges); R.badgeRow.appendChild(R.detailsBtn);
      R.details = el("div", "mx2-br-details");
      R.main.appendChild(R.chartWrap);
      R.main.appendChild(R.badgeRow);

      if (NET) {
        R.strip = el("div", "mx2-nb-strip");
        R.stripCells = {
          reported: stripCell(COPY.stripReported, COPY.stripReportedB, ""),
          discount: stripCell(COPY.stripDiscount, COPY.stripDiscountB, COPY.stripDiscountTip),
          net: stripCell(COPY.stripNet, COPY.stripNetB, "")
        };
        R.strip.appendChild(R.stripCells.reported.box); R.strip.appendChild(R.stripCells.discount.box); R.strip.appendChild(R.stripCells.net.box);
        R.side.appendChild(R.strip);

        // The four composition lenses: one full-width section under the grid.
        R.lenses = el("section", "mx2-lens-sec");
        R.lenses.setAttribute("aria-label", COPY.lensEyebrow);
        var lh = el("div", "mx2-lens-sech"), lhl = el("div", "mx2-lens-sechl");
        lhl.appendChild(el("div", "mx2-lens-eyebrow", COPY.lensEyebrow));
        lhl.appendChild(el("div", "mx2-lens-title", COPY.lensTitle));
        lhl.appendChild(el("div", "mx2-lens-sub", COPY.lensSub));
        R.lensWin = el("div", "mx2-lens-win", "");
        lh.appendChild(lhl); lh.appendChild(R.lensWin);
        R.lensGrid = el("div", "mx2-lens-grid");
        R.lenses.appendChild(lh); R.lenses.appendChild(R.lensGrid);
        R.body.appendChild(R.lenses);
      }

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
      hostEl.appendChild(R.skel);
      hostEl.appendChild(R.empty);
      hostEl.appendChild(R.unavail);
      hostEl.appendChild(R.errored);
      R.head = head;
    }

    function stripCell(label, basis, tip) {
      var box = el("div", "mx2-nb-stat"), v = el("div", "mx2-nb-stat-v", DASH);
      box.appendChild(el("div", "mx2-nb-stat-l", label));
      box.appendChild(v);
      box.appendChild(el("div", "mx2-nb-stat-b", basis));
      if (tip) box.setAttribute("title", tip);
      return { box: box, v: v };
    }

    function dropSvg() {
      if (!R || !NS.svg || typeof NS.svg.destroy !== "function") return;
      try { NS.svg.destroy(R.chart); } catch (e) { /* silent */ }
    }

    function onDetails() {
      detailsOpen = !detailsOpen;
      paintDetails();
    }
    function paintDetails() {
      if (!R) return;
      R.detailsBtn.setAttribute("aria-expanded", detailsOpen ? "true" : "false");
      setText(R.detailsBtn, detailsOpen ? COPY.detailsClose : COPY.detailsOpen);
      show(R.main, R.details, detailsOpen && R.details.childNodes.length > 0);
    }

    // The three pills under the chart, by DOM membership. Tone and colour are
    // CSS off [data-mx2-tone]; the tooltip is the native title.
    function paintBadges(M) {
      var i, b, p;
      R.badges.innerHTML = "";
      for (i = 0; i < M.badges.length; i++) {
        b = M.badges[i];
        p = el("span", "mx2-br-badge", b.text);
        p.setAttribute("data-mx2-tone", b.tone || "neutral");
        p.setAttribute("data-mx2-badge", b.kind);
        p.setAttribute("title", b.title || b.text);
        R.badges.appendChild(p);
      }
      R.details.innerHTML = "";
      for (i = 0; i < M.details.length; i++) {
        if (!M.details[i]) continue;
        R.details.appendChild(el("div", "mx2-note mx2-br-detail", M.details[i]));
      }
      // The badges (and the details behind them) are shown ONCE, on the reported
      // box; the net box repeats neither — its strip and drivers are its content.
      show(R.main, R.badgeRow, M.ok && !NET);
      paintDetails();
    }

    // ---- net only: the strip ----------------------------------------------
    function paintStrip(M) {
      var s = M.strip || { reported: null, discount: null, net: null }, c = R.stripCells;
      setText(c.reported.v, signedTon(s.reported)); cls(c.reported.v, "mx2-pos", s.reported !== null && s.reported > 0); cls(c.reported.v, "mx2-neg", s.reported !== null && s.reported < 0);
      setText(c.discount.v, signedTon(s.discount));
      setText(c.net.v, signedTon(s.net)); cls(c.net.v, "mx2-pos", s.net !== null && s.net > 0); cls(c.net.v, "mx2-neg", s.net !== null && s.net < 0);
    }

    // ---- net only: the drivers table --------------------------------------
    function lensAvailable(M, dim, scope) {
      if (dim === "bu" && scope && scope.bu && String(scope.bu).toUpperCase() !== "ALL") return false;   // a single BU: the lens has one row
      return !!(M.lenses && M.lenses[dim]);
    }
    // ---- composition lenses -------------------------------------------------
    // Initials for the avatar: first letters of the first two words, else the
    // first two letters. "KEY ACCOUNTS" -> KA, "Luzon" -> LU, "J & B AGRIVET" -> JB.
    function initials(key) {
      var words = String(key || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/), out = "", i;
      for (i = 0; i < words.length && out.length < 2; i++) if (words[i]) out += words[i].charAt(0);
      if (out.length < 2 && words[0]) out = words[0].slice(0, 2);
      return out || "?";
    }
    function lensRow(r, i, maxAbs, dim) {
      var f = F(), row = el("tr", "mx2-lens-row"), ident, av, name, tag, eff, track, bar, val, sh, txt, gm, pct, sf, td, fkey = LENS_FILTER[dim];
      row.setAttribute("data-mx2-i", String(i));
      if (fkey && scopeFn()) {
        row.className += " is-link";
        row.setAttribute("title", COPY.lensFilterTip + r.key);
        row.setAttribute("tabindex", "0");
        row.addEventListener("click", function () { var patch = {}; patch[fkey] = r.key; scopeFn()(patch); });
        row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.keyCode === 13) { var patch = {}; patch[fkey] = r.key; scopeFn()(patch); } });
      }
      // identity
      ident = el("div", "mx2-lens-id");
      av = el("span", "mx2-lens-av", initials(r.key)); av.setAttribute("aria-hidden", "true");
      name = el("span", "mx2-lens-name", r.key); name.setAttribute("title", r.key);
      ident.appendChild(av); ident.appendChild(name);
      if (r.gm0 === null && r.gm1 !== null) { tag = el("span", "mx2-lens-tag is-new", COPY.lensNew); tag.setAttribute("title", COPY.lensNewTip); ident.appendChild(tag); }
      else if (r.gm1 === null && r.gm0 !== null) { tag = el("span", "mx2-lens-tag is-gone", COPY.lensGone); tag.setAttribute("title", COPY.lensGoneTip); ident.appendChild(tag); }
      td = el("td", "mx2-lens-td-id"); td.appendChild(ident); row.appendChild(td);
      // effect: a signed bar from a centred zero axis, on the scale shared by all four lenses
      eff = el("div", "mx2-lens-eff");
      track = el("div", "mx2-lens-track");
      bar = el("span", "mx2-lens-bar " + (r.value < 0 ? "is-neg" : "is-pos"));
      pct = maxAbs > 0 ? Math.max(1.5, Math.abs(r.value) / maxAbs * 50) : 0;
      bar.style.width = pct.toFixed(2) + "%";
      bar.style.animationDelay = (i * 40) + "ms";
      track.appendChild(bar);
      val = el("span", "mx2-lens-val " + (r.value < 0 ? "mx2-neg" : (r.value > 0 ? "mx2-pos" : "")), signedTon(r.value));
      eff.appendChild(track); eff.appendChild(val);
      td = el("td", "mx2-lens-td-eff"); td.appendChild(eff); row.appendChild(td);
      // share: before → after, and the shift as a quiet pill (share is not a judgement: no colour)
      sh = el("div", "mx2-lens-sh");
      txt = el("span", "mx2-lens-sh-t");
      txt.appendChild(el("span", "mx2-lens-sh-b", r.share0 === null ? DASH : f.pct(r.share0)));
      txt.appendChild(el("span", "mx2-lens-sh-a", ARROW));
      txt.appendChild(el("span", "mx2-lens-sh-c", r.share1 === null ? DASH : f.pct(r.share1)));
      sh.appendChild(txt);
      if (r.shift !== null) { sf = el("span", "mx2-lens-shift", f.pp(r.shift)); sf.setAttribute("title", COPY.shiftTip + f.pp(r.shift)); sh.appendChild(sf); }
      td = el("td", "mx2-lens-td-sh"); td.appendChild(sh); row.appendChild(td);
      // GM/t pair
      gm = el("div", "mx2-lens-gm");
      gm.appendChild(el("span", "mx2-lens-gm-b", tonOrDash(r.gm0)));
      gm.appendChild(el("span", "mx2-lens-gm-a", ARROW));
      gm.appendChild(el("span", "mx2-lens-gm-c", tonOrDash(r.gm1)));
      td = el("td", "mx2-lens-td-gm"); td.appendChild(gm); row.appendChild(td);
      return row;
    }
    function lensCard(dim, L, maxAbs) {
      var card = el("article", "mx2-lens"), head = el("div", "mx2-lens-h"), left = el("div", "mx2-lens-hl"), right = el("div", "mx2-lens-hr"), tbl, thead, cap, body, i, f = F();
      card.setAttribute("data-mx2-lens", dim);
      left.appendChild(el("span", "mx2-lens-name-h", LENS_TITLE[dim] || LENS_LABEL[dim]));
      left.appendChild(el("span", "mx2-lens-n", (L.n > L.rows.length ? whole(L.rows.length) + COPY.lensOf + whole(L.n) : whole(L.n)) + COPY.lensRows + (L.coverage !== null ? " · " + f.pct(L.coverage) + COPY.lensCov : "")));
      right.appendChild(el("div", "mx2-lens-total " + (L.total !== null && L.total < 0 ? "mx2-neg" : (L.total !== null && L.total > 0 ? "mx2-pos" : "")), signedTon(L.total)));
      right.appendChild(el("div", "mx2-lens-total-b", COPY.lensTotalB));
      head.appendChild(left); head.appendChild(right);
      card.appendChild(head);
      if (!L.rows.length) { card.appendChild(el("div", "mx2-note", COPY.lensNone)); return card; }
      tbl = el("table", "mx2-lens-tbl");
      tbl.appendChild(el("caption", "mx2-sr", (LENS_TITLE[dim] || LENS_LABEL[dim]) + " " + COPY.lensEyebrow));
      thead = el("thead"); cap = el("tr", "mx2-lens-cap");
      cap.appendChild(el("th", "mx2-lens-td-id", LENS_LABEL[dim]));
      cap.appendChild(el("th", "mx2-lens-td-eff", COPY.thEffect));
      cap.appendChild(el("th", "mx2-lens-td-sh", COPY.thShare));
      cap.appendChild(el("th", "mx2-lens-td-gm", COPY.thGm));
      thead.appendChild(cap); tbl.appendChild(thead);
      body = el("tbody", "mx2-lens-rows");
      for (i = 0; i < L.rows.length; i++) body.appendChild(lensRow(L.rows[i], i, maxAbs, dim));
      tbl.appendChild(body);
      card.appendChild(tbl);
      card.appendChild(el("div", "mx2-lens-foot", COPY.lensFoot));
      return card;
    }
    function paintLenses(M, scope) {
      var i, j, dim, L, maxAbs = 0, any = false;
      R.lensGrid.innerHTML = "";
      setText(R.lensWin, M.anchors && M.anchors.pair ? M.anchors.pair : "");
      if (M.unstable) {
        // T1: the split is a modelling artefact: the sentence stands, no lenses
        R.lensGrid.appendChild(el("div", "mx2-note mx2-note-strong mx2-lens-span", (GATES.MIX_ORDERING && GATES.MIX_ORDERING.copy) || COPY.badgeMix));
        return;
      }
      // one effect scale across the four lenses: same unit, so short bars are information
      for (i = 0; i < LENS_DIMS.length; i++) {
        dim = LENS_DIMS[i]; if (!lensAvailable(M, dim, scope)) continue;
        L = M.lenses[dim];
        for (j = 0; j < L.rows.length; j++) if (Math.abs(L.rows[j].value) > maxAbs) maxAbs = Math.abs(L.rows[j].value);
      }
      for (i = 0; i < LENS_DIMS.length; i++) {
        dim = LENS_DIMS[i]; if (!lensAvailable(M, dim, scope)) continue;
        R.lensGrid.appendChild(lensCard(dim, M.lenses[dim], maxAbs)); any = true;
      }
      if (!any) R.lensGrid.appendChild(el("div", "mx2-note mx2-lens-span", COPY.lensNone));
    }

    // Paint one dissection block. `label` is vm.label, or prev.label when stale.
    // Idempotent: every node is rewritten from `diss`; the svg instance is torn
    // down and re-attached (the primitive does the same on its own host).
    function paint(diss, label, stale, status, scope) {
      if (!R || !host) return;
      var mine = blockOf(diss, SOURCE);
      var M = modelFor(mine, SOURCE);
      var effective = status, dom = null, otherName = NET ? COPY.reportedName : COPY.realisedName;

      // ONE SCALE: the union of both bridges' extents, computed once per dissection.
      if (M.ok) {
        dom = sharedDomain(diss);
        if (dom) M.spec.domain = dom;
      }

      // header: scope line, then the basis + scale line
      setText(R.sub, stale ? COPY.stalePrefix + label : label);
      setText(R.basis, opts.basis + " · " + C.UNIVERSES.dissection +
        (M.ok ? " · " + (dom ? COPY.scaleShared + otherName + " bridge" : COPY.scaleOwn + otherName + COPY.scaleOwnB) : ""));
      cls(host, "mx2-is-stale", stale);
      setText(R.bannerLabel, stale ? label : "");
      show(host, R.banner, stale, R.body);

      // chart, the always-there state line, badges, details — one fixed order
      dropSvg();
      show(R.main, R.noPrev, false); show(R.main, R.noBridge, false); show(R.main, R.chartWrap, false); show(R.main, R.badgeRow, false); show(R.main, R.details, false);
      show(R.main, R.noPrev, stale && !isObj(diss), R.badgeRow);
      show(R.main, R.chartWrap, M.ok, R.badgeRow);
      if (M.ok && NS.svg && typeof NS.svg.waterfall === "function") NS.svg.waterfall(R.chart, M.spec);
      // A bridge block that is itself unavailable is a state of its own: while the
      // panel status is not unavailable-for-scope (a refresh in flight over a
      // stale paint, say) the reason is printed inline so the box is never blank.
      setText(R.noBridge, M.unavailableReason !== null ? COPY.noBridgeA + label + COPY.noBridgeB + M.unavailableReason : "");
      show(R.main, R.noBridge, M.unavailableReason !== null, R.badgeRow);
      paintBadges(M);
      if (NET) { paintStrip(M); paintLenses(M, scope); show(R.body, R.grid, true); }

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
        paint(vm.diss || null, vm.label || "", false, host.getAttribute("data-mx2-status") || null, vm.scope || null);
      },

      renderStale: function (prev, vm) {
        if (!R || !host) return;
        vm = vm || {};
        if (!prev) { def.render(vm); return; }   // contract says never call with null; degrade honestly
        paint(prev.diss || null, prev.label || "", true, host.getAttribute("data-mx2-status") || null, vm.scope || null);
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
      _sharedDomain: sharedDomain,
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
    title: "GM/ton bridge — net of off-invoice discount",
    basis: C.BASIS_SUFFIX.net + " · line GP less the document trade discount (OINV.DiscSum, excluded from GrssProfit) · same decomposition"
  }));
})();
