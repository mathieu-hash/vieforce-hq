/* ============================================================================
 * mexp2-panel-insight.js — Margin Explorer v2 · WHAT MOVED MARGIN, AND WHERE TO LOOK (MEXP2.panel "insight")
 * ----------------------------------------------------------------------------
 * WHAT THIS PANEL SHOWS
 *   Four findings, each a short heading, one or two sentences and an optional
 *   mini-table (max 5 rows). NO model call, NO fetch: every sentence is
 *   computed from blocks already on the wire, and every sentence ends with a
 *   muted source tag naming the block it was computed from. A block the wire
 *   does not carry produces NO sentence — never a blank, never a placeholder
 *   number.
 *
 *   1. REALISED vs REPORTED   net_bridge.vs_reported + net_bridge.discount +
 *                             discount_overlay. The headline. The sentence is
 *                             THE SAME RULE the g2n panel prints
 *                             (MEXP2.rules.reportedVsRealised, exported by
 *                             mexp2-panel-g2n.js) — reused, never duplicated.
 *   2. WHO DROVE IT           net_bridge.lenses.customer / .ssg: the three
 *                             largest |value| rows per lens with value, share
 *                             shift and GM/t before -> after. Gated by T1
 *                             (mix_ordering.sign_stable false -> composition
 *                             is not quoted) and prefixed by the backend
 *                             WARNING when T2 (churn_dominated).
 *   3. CATEGORIES OFF TREND   dissection.category_trend: per category with
 *                             >= 6 usable complete cells, mean and sample sd of
 *                             gm_ton over the COMPLETE months; the latest
 *                             complete month is flagged at |z| >= 1.5. Cells
 *                             under TINY_TONS MT are skipped and counted (the
 *                             v1 "Untagged at PHP 4.5M/t" artefact is a per-ton
 *                             ratio on near-zero tonnage).
 *   4. COST PASS-THROUGH      bridge.ingredients + ingredients_meta (phase A,
 *                             per ton of feed PRODUCED, national) against the
 *                             canonical_bridge Price and Cost bars (phase B,
 *                             finished feed 103 per ton SOLD). Different
 *                             universes; quoted side by side, never reconciled.
 *                             feed_basis is printed verbatim; the issued-kg
 *                             proxy is called an estimate; a region/BU filter
 *                             prints the "National — not filtered by region/BU"
 *                             caveat verbatim.
 *
 * TINY-TONNAGE GUARD
 *   A per-ton figure on near-zero tonnage is a ratio on noise. Category cells
 *   under TINY_TONS MT are skipped (and the skip is counted in prose); lens
 *   GM/t figures on a window under TINY_TONS MT are withheld with the tonnage
 *   in the tooltip.
 *
 * RULES THIS FILE OBEYS
 *   - Lifecycle per C.PANEL_LIFECYCLE. render() reads only its vm; renderStale()
 *     paints prev.diss / prev.core and PRINTS prev.label (header + gold banner).
 *   - phase "diss": the controller reads store.statusFor("diss"). Empty-scope
 *     and unavailable render ONE sentence and nothing else.
 *   - Every number through MEXP2.fmt; every colour via --mx2-* in CSS; status
 *     chrome is CSS off [data-mx2-status]; show/hide by DOM membership. All
 *     classes .mx2-*. No console.*, no fetch, no store mutation, no state
 *     carried between renders.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-panel-insight: mexp2-contract.js must load before this file.");

  var PANEL_ID = "insight";
  var DASH = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var PER_TON = (C.NUM && C.NUM.PER_TON) || "/t";
  var ARROW = " → ";
  var TINY_TONS = 5;          // MT — below this a per-ton figure is a ratio on noise
  var MIN_CELLS = 6;          // complete, usable cells a category needs before it has "its own trend"
  var Z_FLAG = 1.5;           // |z| at or above this flags the latest complete month
  var TOP_N = 3;              // rows quoted per lens / ingredients
  var GATES = C.TRUST_GATES || {};
  var COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five"];

  // Source block names — the muted tag at the end of every sentence.
  var SRC = {
    vs: "net_bridge.vs_reported · net_bridge.discount",
    overlay: "discount_overlay",
    lensCustomer: "net_bridge.lenses.customer",
    lensSsg: "net_bridge.lenses.ssg",
    mixOrdering: "net_bridge.mix_ordering.sign_stable",
    churn: "net_bridge.mix_detail.churn_dominated · net_bridge.note",
    catTrend: "dissection.category_trend",
    ingMeta: "bridge.ingredients_meta",
    ingredients: "bridge.ingredients",
    canonical: "canonical_bridge.price · canonical_bridge.cost",
    feedBasis: "bridge.ingredients_meta.feed_basis",
    applied: "meta.applied_filters"
  };

  var COPY = {
    title: "What moved margin, and where to look",
    method: "Every sentence is computed from blocks already on the wire — no model, no fetch. The muted tag after each sentence names its source block; a block the wire lacks produces no sentence.",
    anchorsPrefix: "Anchors ",
    completeOnly: "complete months only",
    partialA: "compare month is partial — ",
    anchorsWhy: "Month-pair anchors: the first and last complete months inside the selected period — never the period itself (the running month is excluded).",
    universe: "Findings 1–3 are dissection figures: finished feed (103) only, credit notes netted. Finding 4 pairs a phase-A procurement lens (per ton of feed PRODUCED, national) with the dissection bridge bars — different universes, never reconciled.",
    h1: "1 · Realised vs reported",
    h2: "2 · Who drove it",
    h3: "3 · Categories off their own trend",
    h4: "4 · Cost pass-through",
    // 1
    ovA: "Off-invoice discount is ", ovB: " of reported GM/kg this window (", ovC: " reported, ", ovD: " net of discount).",
    ovNoPct: "Off-invoice discount share undefined this window — reported GM/kg ≤ 0.",
    ruleMissing: "The reported-vs-realised rule is not loaded (mexp2-panel-g2n.js) — the headline sentence is withheld rather than re-implemented here.",
    colReported: "Reported", colNet: "Net", colGap: "Gap",
    rowDelta: "Δ GM/t", rowPrice: "Price",
    // 2
    unstable: "Customer/product split is unstable this window (T1) — composition effects are not quoted.",
    custA: " explain ", custB: " of the ", custC: " customer-mix effect (customer lens, top ", custD: " of ", custE: " rows).",
    ssgC: " product-mix effect (SSG lens, top ",
    custWord: ["customers", "customer"], ssgWord: ["categories", "category"],
    lensNote: "A lens is a one-dimensional share-shift over that dimension alone; its total is over all rows and is not the Customer / Product mix bar.",
    colKey: "Key", colEffect: "Effect", colShare: "Share", colGm: "GM/t",
    thin: " — under " , thinB: " in that window; per-ton figure withheld",
    entering: "not present in the base window",
    exiting: "not present in the compare window",
    // 3
    flagA: " sit", flagA1: " sits", flagB: " more than ", flagC: " sd from ", flagC1: "its", flagCn: "their", flagD: " own trailing mean in ",
    noFlag: "No category is more than 1.5 sd from its own trailing mean.",
    qualA: " of ", qualB: " categories have at least ", qualC: " complete months with volume; the latest complete month is ",
    skipA: " cell", skipB: " skipped for thin volume (under ", skipC: ") — a per-ton figure on that little tonnage is a ratio on noise.",
    noLatest: "No complete month on the wire to test against.",
    colCat: "Category", colLatest: "Latest GM/t", colMean: "12-mo mean", colZ: "z",
    // 4
    rmA: "Purchased RM cost moved ", rmB: " of feed (national, recipe-weighted); price recovered ", rmC: " in this scope.",
    rmTop: "sum over the listed ingredients (top 12 by |Δ|) — ingredients_meta absent",
    costBarA: "The bridge Cost bar reads ", costBarB: " (GP impact, finished feed 103 per ton sold) — a different universe and window from the procurement lens; not reconciled.",
    priceMissing: "The canonical bridge is not on the wire for this window, so no price recovery is quoted against it.",
    basisA: "Per-ton denominator: ", basisEst: " — the denominator is ESTIMATED; treat the per-ton level as indicative only.",
    national: "National — not filtered by region/BU",
    nationalB: " — the procurement lens covers every plant; the active ",
    nationalC: " filter does not apply to it.",
    colIng: "Ingredient", colDelta: "Δ cost/t feed", colPriceEff: "of which price", colInclEff: "of which inclusion", colPrice: "Price/kg",
    newIng: "new — not issued prior",
    // states
    nothing: "Nothing on the wire to explain for this scope.",
    emptyOne: "No rows in this scope — nothing to explain.",
    unavailOne: "Not available for this selection",
    noPrev: "No dissection had loaded for the previous scope.",
    loadingNote: "Phase B (dissection) still in flight — the hero above is already current.",
    stalePrefix: "Showing previous scope: "
  };

  /* -------------------------------------------------------------------------
   * helpers
   * ---------------------------------------------------------------------- */
  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level]("insight: " + msg, data); } catch (e) { /* silent */ }
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
  function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function num(v) { var f = F(); return f ? f.toNum(v) : ((v == null || v === "") ? null : (isFinite(+v) ? +v : null)); }
  function signedTon(v) { var f = F(); return v === null ? DASH : f.signed(v, 0) + PER_TON; }
  function ton(v) { var f = F(); return v === null ? DASH : f.perTon(v) + PER_TON; }
  function countWord(n) { return (n >= 0 && n < COUNT_WORDS.length) ? COUNT_WORDS[n] : String(n); }
  function plural(n, words) { return words[n === 1 ? 1 : 0]; }
  function untag(s) { return s === "UNSPEC" ? "Untagged" : (s == null ? "" : String(s)); }
  // The WARNING sentence the backend appends to note when churn-dominated (T2).
  function warningOf(note) {
    var s = (note == null) ? "" : String(note), i = s.indexOf("WARNING:");
    return i >= 0 ? s.slice(i) : "";
  }
  // The reported-vs-realised rule, resolved at render time so load order does
  // not matter. Exported by mexp2-panel-g2n.js; falls back to that panel's
  // own probe. Never re-implemented here.
  function ruleFn() {
    if (NS.rules && typeof NS.rules.reportedVsRealised === "function") return NS.rules.reportedVsRealised;
    var g = (typeof NS.panel === "function") ? NS.panel("g2n") : null;
    if (g && typeof g._sentence === "function") return g._sentence;
    return null;
  }
  // A sentence: text + its source tag. Pure data.
  function S(text, src) { return { text: text, src: src }; }

  // The anchors sentence (C.ANCHORS.panel_rule): base -> compare, verbatim.
  function anchorsOf(src) {
    var base = src && src.base_month, comp = src && src.compare_month, out = { pair: "", line: "", partial: false };
    if (!base && !comp) return out;
    out.pair = String(base || DASH) + ARROW + String(comp || DASH);
    out.partial = !!(src && src.compare_partial === true);
    out.line = out.pair + " · " + (out.partial ? COPY.partialA + (C.ANCHORS.partial_copy || "") : COPY.completeOnly);
    return out;
  }

  // Is a region / BU filter active? The applied_filters echo on the payload is
  // the honest source (it travels with a stale prev payload too); vm.scope is
  // the fallback when meta is absent.
  function sliceOf(core, scope) {
    var af = core && core.meta && core.meta.applied_filters, out = { active: false, parts: [] };
    var region = null, bu = null;
    if (isObj(af)) { region = af.region; bu = af.bu; }
    else if (isObj(scope)) { region = scope.region; bu = scope.bu; }
    if (region != null && String(region).toUpperCase() !== "ALL") out.parts.push("Region " + String(region));
    if (bu != null && String(bu).toUpperCase() !== "ALL") out.parts.push("BU " + String(bu));
    out.active = out.parts.length > 0;
    return out;
  }

  /* -------------------------------------------------------------------------
   * finding 1 — realised vs reported
   * ---------------------------------------------------------------------- */
  function findingRealised(nb, ov) {
    var f = F(), out = { id: "realised", heading: COPY.h1, sentences: [], table: null }, rule, vs, disc;
    var dr, dn, gap, pr, pn, pg, dd, pct;
    if (isObj(nb) && nb.available === true && isObj(nb.vs_reported)) {
      vs = nb.vs_reported; disc = isObj(nb.discount) ? nb.discount : {};
      dr = num(vs.delta_reported); dn = num(vs.delta_net); gap = num(vs.gap);
      pr = num(vs.price_reported); pn = num(vs.price_net); pg = num(vs.price_gap);
      dd = num(disc.delta_per_ton);
      rule = ruleFn();
      if (rule) out.sentences.push(S(String(rule(dr, dn, gap, dd)), SRC.vs));
      else out.sentences.push(S(COPY.ruleMissing, SRC.vs));
      out.table = {
        cols: ["", COPY.colReported, COPY.colNet, COPY.colGap],
        titles: ["", C.BASIS_SUFFIX.reported + " · dissection.canonical_bridge", C.BASIS_SUFFIX.net + " · dissection.net_bridge", "gap = net − reported · net_bridge.vs_reported"],
        rows: [
          [{ t: COPY.rowDelta, dim: true }, { v: dr, t: signedTon(dr), title: "net_bridge.vs_reported.delta_reported" }, { v: dn, t: signedTon(dn), title: "net_bridge.vs_reported.delta_net", strong: true }, { v: gap, t: signedTon(gap), title: "net_bridge.vs_reported.gap" }],
          [{ t: COPY.rowPrice, dim: true }, { v: pr, t: signedTon(pr), title: "net_bridge.vs_reported.price_reported" }, { v: pn, t: signedTon(pn), title: "net_bridge.vs_reported.price_net", strong: true }, { v: pg, t: signedTon(pg), title: "net_bridge.vs_reported.price_gap" }]
        ]
      };
    }
    if (isObj(ov)) {
      pct = num(ov.discount_pct_of_reported_gm);
      if (pct === null) out.sentences.push(S(COPY.ovNoPct, SRC.overlay));
      else out.sentences.push(S(COPY.ovA + f.pct(pct) + COPY.ovB + f.perKg(ov.gm_per_kg_reported) + "/kg" + COPY.ovC + f.perKg(ov.gm_per_kg_net_of_discount) + "/kg" + COPY.ovD, SRC.overlay));
    }
    return out.sentences.length ? out : null;
  }

  /* -------------------------------------------------------------------------
   * finding 2 — who drove it
   * ---------------------------------------------------------------------- */
  function lensCell(gm, tons, absentCopy) {
    var f = F(), t = num(tons), g = num(gm);
    if (g === null) return { v: null, t: DASH, title: absentCopy };
    if (t !== null && t < TINY_TONS) return { v: null, t: DASH, title: f.mt(t) + COPY.thin + f.mt(TINY_TONS) + COPY.thinB };
    return { v: g, t: ton(g), title: t === null ? "" : f.mt(t) };
  }
  function lensBlock(lens, words, midCopy, srcName) {
    var f = F(), rows, i, r, n, sum = 0, total, keys = [], table, tr;
    if (!isObj(lens) || !isArr(lens.rows) || !lens.rows.length) return null;
    rows = lens.rows.slice(0);
    rows.sort(function (a, b) { return Math.abs(num(b.value) || 0) - Math.abs(num(a.value) || 0); });
    n = Math.min(TOP_N, rows.length);
    for (i = 0; i < n; i++) { r = rows[i]; if (num(r.value) !== null) sum += num(r.value); keys.push(r.key); }
    total = num(lens.total);
    table = { cols: [COPY.colKey, COPY.colEffect, COPY.colShare, COPY.colGm], titles: ["", "value · PHP/ton", "share0_pct → share1_pct (share_shift_pp)", "gm_ton0 → gm_ton1 · withheld under " + f.mt(TINY_TONS)], rows: [] };
    for (i = 0; i < n; i++) {
      r = rows[i];
      tr = [{ t: String(r.key), dim: true }];
      tr.push({ v: num(r.value), t: signedTon(num(r.value)), title: srcName + ".rows[].value" });
      tr.push({ v: 0, t: f.pct(r.share0_pct) + ARROW + f.pct(r.share1_pct) + " (" + f.pp(r.share_shift_pp) + ")", title: srcName + ".rows[].share0_pct / share1_pct / share_shift_pp", plain: true });
      tr.push({ v: 0, plain: true, pair: [lensCell(r.gm_ton0, r.tons0, COPY.entering), lensCell(r.gm_ton1, r.tons1, COPY.exiting)], title: srcName + ".rows[].gm_ton0 → gm_ton1" });
      table.rows.push(tr);
    }
    return {
      sentence: S(countWord(n) + " " + plural(n, words) + COPY.custA + signedTon(sum) + COPY.custB + signedTon(total) + midCopy + n + COPY.custD + rows.length + COPY.custE, srcName),
      table: table
    };
  }
  function findingDrivers(nb) {
    var out = { id: "drivers", heading: COPY.h2, sentences: [], tables: [] }, mo, md, lenses, cust, ssg, warn;
    if (!isObj(nb) || nb.available !== true) return null;
    mo = nb.mix_ordering; md = nb.mix_detail; lenses = isObj(nb.lenses) ? nb.lenses : {};
    if (isObj(md) && md.churn_dominated === true) {
      warn = warningOf(nb.note) || (GATES.MIX_CHURN && GATES.MIX_CHURN.copy) || "";
      if (warn) out.sentences.push(S(warn, SRC.churn));
    }
    if (isObj(mo) && mo.sign_stable === false) {
      out.sentences.push(S(COPY.unstable, SRC.mixOrdering));
      return out;
    }
    cust = lensBlock(lenses.customer, COPY.custWord, COPY.custC, SRC.lensCustomer);
    ssg = lensBlock(lenses.ssg, COPY.ssgWord, COPY.ssgC, SRC.lensSsg);
    if (cust) { out.sentences.push(cust.sentence); out.tables.push(cust.table); }
    if (ssg) { out.sentences.push(ssg.sentence); out.tables.push(ssg.table); }
    if (cust || ssg) out.note = COPY.lensNote;
    return out.sentences.length ? out : null;
  }

  /* -------------------------------------------------------------------------
   * finding 3 — categories off their own trend
   * ---------------------------------------------------------------------- */
  // Pure statistics over one category's cells. Returns null when the category
  // has no "own trend" (fewer than MIN_CELLS usable complete cells) or no
  // usable latest cell; `skipped` counts thin-volume cells across every call.
  function categoryStat(cat, partialMonth, latestMonth, acc) {
    var cells = isArr(cat.cells) ? cat.cells : [], i, c, g, t, xs = [], latest = null, sum = 0, ss = 0, mean, sd, n;
    for (i = 0; i < cells.length; i++) {
      c = cells[i]; if (!isObj(c)) continue;
      if (partialMonth && c.month === partialMonth) continue;
      g = num(c.gm_ton); t = num(c.tons);
      if (g === null) continue;
      if (t !== null && t < TINY_TONS) { acc.skipped++; continue; }
      xs.push(g); sum += g;
      if (c.month === latestMonth) latest = g;
    }
    n = xs.length;
    if (n < MIN_CELLS) return null;
    acc.qualified++;
    if (latest === null) return null;
    mean = sum / n;
    for (i = 0; i < n; i++) ss += (xs[i] - mean) * (xs[i] - mean);
    sd = Math.sqrt(ss / (n - 1));
    if (!(sd > 0)) return null;
    return { ssg: untag(cat.ssg), latest: latest, mean: mean, sd: sd, z: (latest - mean) / sd, n: n };
  }
  function findingCategories(ct) {
    var f = F(), out = { id: "categories", heading: COPY.h3, sentences: [], table: null }, months, latestMonth = null, cats, i, st, acc = { skipped: 0, qualified: 0 }, flagged = [], tr;
    if (!isObj(ct) || ct.available !== true || !isArr(ct.categories) || !ct.categories.length) return null;
    months = isArr(ct.months) ? ct.months : [];
    for (i = months.length - 1; i >= 0; i--) { if (months[i] !== ct.partial_month) { latestMonth = months[i]; break; } }
    if (latestMonth === null) { out.sentences.push(S(COPY.noLatest, SRC.catTrend)); return out; }
    cats = ct.categories;
    for (i = 0; i < cats.length; i++) {
      if (!isObj(cats[i])) continue;
      st = categoryStat(cats[i], ct.partial_month, latestMonth, acc);
      if (st && Math.abs(st.z) >= Z_FLAG) flagged.push(st);
    }
    flagged.sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); });
    if (flagged.length) {
      out.sentences.push(S(countWord(flagged.length) + " " + plural(flagged.length, COPY.ssgWord) + (flagged.length === 1 ? COPY.flagA1 : COPY.flagA) + COPY.flagB + f.signed(Z_FLAG, 1).replace(/^\+/, "") + COPY.flagC + (flagged.length === 1 ? COPY.flagC1 : COPY.flagCn) + COPY.flagD + latestMonth + ".", SRC.catTrend));
      out.table = { cols: [COPY.colCat, COPY.colLatest, COPY.colMean, COPY.colZ], titles: ["", "gm_ton of " + latestMonth, "mean of gm_ton over the complete months (n)", "(latest − mean) / sample sd"], rows: [] };
      for (i = 0; i < flagged.length && i < 5; i++) {
        st = flagged[i];
        tr = [{ t: st.ssg, dim: true }];
        tr.push({ v: st.latest, t: ton(st.latest), title: SRC.catTrend + ".categories[].cells[" + latestMonth + "].gm_ton", plain: true });
        tr.push({ v: st.mean, t: ton(st.mean) + " (n " + st.n + ")", title: "mean over " + st.n + " complete months with volume", plain: true });
        tr.push({ v: st.z, t: f.signed(st.z, 1), title: "sd " + ton(st.sd) });
        table_push(out.table, tr);
      }
    } else {
      out.sentences.push(S(COPY.noFlag, SRC.catTrend));
    }
    out.sentences.push(S(acc.qualified + COPY.qualA + cats.length + COPY.qualB + MIN_CELLS + COPY.qualC + latestMonth + "." +
      (acc.skipped > 0 ? " " + acc.skipped + COPY.skipA + (acc.skipped === 1 ? "" : "s") + COPY.skipB + f.mt(TINY_TONS) + COPY.skipC : ""), SRC.catTrend));
    return out;
  }
  function table_push(table, tr) { table.rows.push(tr); }

  /* -------------------------------------------------------------------------
   * finding 4 — cost pass-through
   * ---------------------------------------------------------------------- */
  function findingCost(br, cb, slice) {
    var f = F(), out = { id: "cost", heading: COPY.h4, sentences: [], table: null }, items, meta, i, a = null, aSrc, price = null, cost = null, rows, r, tr, basis, basisCopy;
    if (!isObj(br) || br.available !== true || !isArr(br.ingredients) || !br.ingredients.length) return null;
    items = br.ingredients; meta = isObj(br.ingredients_meta) ? br.ingredients_meta : null;
    if (meta && num(meta.sum_perton_delta) !== null) { a = num(meta.sum_perton_delta); aSrc = SRC.ingMeta + ".sum_perton_delta"; }
    else {
      a = 0; for (i = 0; i < items.length; i++) if (num(items[i].perton_delta) !== null) a += num(items[i].perton_delta);
      aSrc = SRC.ingredients + " (" + COPY.rmTop + ")";
    }
    if (isObj(cb) && cb.available === true) { price = num(cb.price); cost = num(cb.cost); }
    if (price !== null) out.sentences.push(S(COPY.rmA + signedTon(a) + COPY.rmB + signedTon(price) + COPY.rmC, aSrc + " · canonical_bridge.price"));
    else out.sentences.push(S(COPY.rmA + signedTon(a) + COPY.rmB + DASH + COPY.rmC + " " + COPY.priceMissing, aSrc));
    if (cost !== null) out.sentences.push(S(COPY.costBarA + signedTon(cost) + COPY.costBarB, "canonical_bridge.cost"));

    rows = items.slice(0);
    rows.sort(function (x, y) { return Math.abs(num(y.perton_delta) || 0) - Math.abs(num(x.perton_delta) || 0); });
    out.table = { cols: [COPY.colIng, COPY.colDelta, COPY.colPriceEff, COPY.colInclEff, COPY.colPrice], titles: ["", "perton_delta · PHP/ton feed", "price_effect", "inclusion_effect", "price_prior → price_now · PHP/kg"], rows: [] };
    for (i = 0; i < rows.length && i < TOP_N; i++) {
      r = rows[i];
      tr = [{ t: String(r.name), dim: true }];
      tr.push({ v: num(r.perton_delta), t: signedTon(num(r.perton_delta)), title: SRC.ingredients + "[].perton_delta" });
      tr.push({ v: num(r.price_effect), t: signedTon(num(r.price_effect)), title: SRC.ingredients + "[].price_effect" });
      tr.push({ v: num(r.inclusion_effect), t: signedTon(num(r.inclusion_effect)), title: SRC.ingredients + "[].inclusion_effect" });
      tr.push({ v: 0, plain: true, t: (num(r.price_prior) === null ? COPY.newIng : f.perKg(r.price_prior) + ARROW + f.perKg(r.price_now)), title: SRC.ingredients + "[].price_prior → price_now" });
      out.table.rows.push(tr);
    }
    if (meta && meta.feed_basis != null) {
      basis = String(meta.feed_basis);
      basisCopy = (GATES.FEED_BASIS && GATES.FEED_BASIS.copy) ? GATES.FEED_BASIS.copy[basis] : null;
      out.sentences.push(S(COPY.basisA + basis + (/proxy/i.test(basis) ? COPY.basisEst : (basisCopy ? " — " + basisCopy : ".")), SRC.feedBasis));
    }
    if (slice && slice.active) out.sentences.push(S(COPY.national + COPY.nationalB + slice.parts.join(" · ") + COPY.nationalC, SRC.applied));
    return out;
  }

  /* -------------------------------------------------------------------------
   * model — pure: reads one dissection + one core, returns everything to paint
   * ---------------------------------------------------------------------- */
  function modelFor(diss, core, scope) {
    var M = { ok: false, findings: [], anchors: anchorsOf(null), unavailableReason: null, hasDiss: false };
    var ok = isObj(diss) && diss.available === true, nb, cb, ct, br, ov, fnd;
    if (isObj(diss) && diss.available === false) { M.unavailableReason = diss.reason == null ? "" : String(diss.reason); return M; }
    if (!ok) return M;
    M.hasDiss = true;
    M.anchors = anchorsOf(diss);
    nb = diss.net_bridge; cb = diss.canonical_bridge; ct = diss.category_trend;
    br = core ? core.bridge : null; ov = core ? core.discount_overlay : null;
    fnd = findingRealised(nb, ov); if (fnd) M.findings.push(fnd);
    fnd = findingDrivers(nb); if (fnd) M.findings.push(fnd);
    fnd = findingCategories(ct); if (fnd) M.findings.push(fnd);
    fnd = findingCost(br, cb, sliceOf(core, scope)); if (fnd) M.findings.push(fnd);
    M.ok = M.findings.length > 0;
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
    R.anchors = el("div", "mx2-panel-st mx2-in-anchors", "");
    R.anchors.setAttribute("title", COPY.anchorsWhy);
    R.method = el("div", "mx2-panel-st mx2-in-method", COPY.method);
    col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.anchors); col.appendChild(R.method);
    R.pill = el("span", "mx2-pill");
    R.pill.appendChild(el("span", "mx2-pill-dot"));
    R.pillText = el("span", "", "");
    R.pill.appendChild(R.pillText);
    head.appendChild(col); head.appendChild(R.pill);

    R.banner = el("div", "mx2-stale-banner", COPY.stalePrefix);
    R.bannerLabel = el("span", "mx2-stale-label", "");
    R.banner.appendChild(R.bannerLabel);

    R.body = el("div", "mx2-dimmable mx2-in-body");
    R.grid = el("div", "mx2-in-grid");
    R.nothing = el("div", "mx2-note mx2-in-nothing", COPY.nothing);
    R.noPrev = el("div", "mx2-note", COPY.noPrev);
    R.body.appendChild(R.grid);

    R.universe = el("div", "mx2-note mx2-in-universe", COPY.universe + " " + COPY.anchorsWhy);

    R.skel = el("div", "mx2-in-skel mx2-skel-rows"); R.skel.setAttribute("data-mx2-for", C.STATE.LOADING_FIRST);
    R.skel.appendChild(el("div", "mx2-skel mx2-skel-lg"));
    R.skel.appendChild(el("div", "mx2-skel mx2-skel-block"));
    R.skel.appendChild(el("div", "mx2-note", C.STATE_COPY[C.STATE.LOADING_FIRST] + " " + COPY.loadingNote));
    // Empty-scope / unavailable: ONE sentence and nothing else.
    R.empty = oneLine(C.STATE.EMPTY_SCOPE, COPY.emptyOne);
    R.unavail = oneLine(C.STATE.UNAVAILABLE_FOR_SCOPE, COPY.unavailOne + ".");
    R.unavailLine = R.unavail.firstChild;
    R.errored = oneLine(C.STATE.ERRORED, C.STATE_COPY[C.STATE.ERRORED]);
    R.erroredLine = R.errored.firstChild;

    hostEl.appendChild(head);
    hostEl.appendChild(R.body);
    hostEl.appendChild(R.universe);
    hostEl.appendChild(R.skel);
    hostEl.appendChild(R.empty);
    hostEl.appendChild(R.unavail);
    hostEl.appendChild(R.errored);
    R.head = head;
  }
  function oneLine(state, text) {
    var b = el("div", "mx2-msg mx2-in-one"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", text));
    return b;
  }

  function numCell(td, cell) {
    var span, i;
    if (cell.pair) {
      for (i = 0; i < cell.pair.length; i++) {
        if (i > 0) td.appendChild(el("span", "mx2-in-arrow", ARROW));
        span = el("span", "mx2-in-gm", cell.pair[i].t);
        cls(span, "mx2-null", cell.pair[i].v === null);
        span.setAttribute("title", cell.pair[i].title || "");
        td.appendChild(span);
      }
      td.setAttribute("title", cell.title || "");
      return;
    }
    setText(td, cell.t == null ? DASH : cell.t);
    cls(td, "mx2-null", cell.v === null);
    if (!cell.plain) {
      cls(td, "mx2-neg", cell.v !== null && cell.v < 0);
      cls(td, "mx2-pos", cell.v !== null && cell.v > 0);
    }
    cls(td, "mx2-in-strong", !!cell.strong);
    td.setAttribute("title", cell.title || "");
  }
  function buildTable(T, caption) {
    var wrap = el("div", "mx2-in-tblwrap"), table = el("table", "mx2-tbl mx2-in-tbl"), thead = el("thead"), tr = el("tr"), tbody = el("tbody"), i, j, th, td, row;
    table.appendChild(el("caption", "mx2-sr", caption));
    for (i = 0; i < T.cols.length; i++) {
      th = el("th", i === 0 ? "" : "mx2-num", T.cols[i]); th.setAttribute("scope", "col");
      if (T.titles && T.titles[i]) th.setAttribute("title", T.titles[i]);
      tr.appendChild(th);
    }
    thead.appendChild(tr); table.appendChild(thead);
    for (i = 0; i < T.rows.length && i < 5; i++) {
      row = T.rows[i]; tr = el("tr");
      for (j = 0; j < row.length; j++) {
        if (row[j].dim) { td = el("td", "mx2-dim-col", row[j].t); }
        else { td = el("td", "mx2-num"); numCell(td, row[j]); }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  function sentenceNode(s) {
    var p = el("div", "mx2-in-s");
    p.appendChild(el("span", "mx2-in-text", s.text));
    p.appendChild(el("span", "mx2-in-src", s.src));
    return p;
  }
  function findingNode(fnd) {
    var box = el("section", "mx2-in-find"), i, tables;
    box.setAttribute("data-mx2-find", fnd.id);
    box.appendChild(el("div", "mx2-in-h", fnd.heading));
    for (i = 0; i < fnd.sentences.length; i++) box.appendChild(sentenceNode(fnd.sentences[i]));
    tables = fnd.tables || (fnd.table ? [fnd.table] : []);
    for (i = 0; i < tables.length; i++) box.appendChild(buildTable(tables[i], fnd.heading));
    if (fnd.note) box.appendChild(el("div", "mx2-note mx2-in-note", fnd.note));
    return box;
  }

  // Paint one dissection + core. `label` is vm.label, or prev.label when stale.
  // Idempotent: the grid is rebuilt from the model on every call.
  function paint(diss, core, scope, label, stale, status) {
    if (!R || !host) return;
    var M = modelFor(diss, core, scope), effective = status, i;

    // header
    setText(R.sub, stale ? COPY.stalePrefix + label : label);
    setText(R.anchors, M.anchors.line ? COPY.anchorsPrefix + M.anchors.line : "");
    cls(host, "mx2-is-stale", stale);
    setText(R.bannerLabel, stale ? label : "");
    show(host, R.banner, stale, R.body);

    // body — rebuilt; the optional lines re-attached in ONE fixed order
    R.grid.innerHTML = "";
    show(R.body, R.noPrev, false); show(R.body, R.nothing, false);
    show(R.body, R.noPrev, stale && !isObj(diss), R.grid);
    for (i = 0; i < M.findings.length; i++) R.grid.appendChild(findingNode(M.findings[i]));
    show(R.body, R.nothing, M.hasDiss && !M.ok, R.grid);

    // state-line copy that depends on the payload
    setText(R.erroredLine, (stale || isObj(diss)) ? C.STATE_COPY["errored-stale"] : C.STATE_COPY[C.STATE.ERRORED]);
    setText(R.unavailLine, COPY.unavailOne + ".");
    if (M.unavailableReason !== null) {
      setText(R.unavailLine, COPY.unavailOne + (M.unavailableReason ? ": " + M.unavailableReason : "."));
      if (status === C.STATE.FRESH || status == null) effective = C.STATE.UNAVAILABLE_FOR_SCOPE;
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
      cls(host, "mx2-panel-insight", true);
      build(host);
      dbg("info", "mounted");
    },

    render: function (vm) {
      if (!R || !host) return;
      vm = vm || {};
      paint(vm.diss || null, vm.core || null, vm.scope || null, vm.label || "", false, host.getAttribute("data-mx2-status") || null);
    },

    renderStale: function (prev, vm) {
      if (!R || !host) return;
      vm = vm || {};
      if (!prev) { def.render(vm); return; }   // contract says never call with null; degrade honestly
      paint(prev.diss || null, prev.core || null, null, prev.label || "", true, host.getAttribute("data-mx2-status") || null);
    },

    setStatus: function (state) {
      if (!R || !host) return;
      if (!C.STATE_RULES[state]) state = C.STATE.FRESH;
      host.setAttribute("data-mx2-status", state);   // CSS does every treatment off this attribute
      setText(R.pillText, C.pillText(state));
    },

    destroy: function () {
      if (host) {
        cls(host, "mx2-is-stale", false);
        cls(host, "mx2-panel-insight", false);
        host.innerHTML = "";
      }
      host = null; R = null;
    },

    // test probes — not used by the controller
    _model: modelFor,
    _realised: findingRealised,
    _drivers: findingDrivers,
    _categories: findingCategories,
    _cost: findingCost,
    _categoryStat: categoryStat,
    _slice: sliceOf,
    TINY_TONS: TINY_TONS,
    MIN_CELLS: MIN_CELLS,
    Z_FLAG: Z_FLAG,
    TOP_N: TOP_N,
    COPY: COPY,
    SRC: SRC
  };

  NS.panel(PANEL_ID, def);
})();
