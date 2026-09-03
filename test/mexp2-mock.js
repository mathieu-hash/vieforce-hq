/* ============================================================================
 * mexp2-mock.js -- Margin Explorer v2 . FIXTURE LOADER + DETERMINISTIC RAW-WIRE MOCK
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   1. A FIXTURE LOADER. When a recorded real response exists at
 *        <fixtureBase>/<scope>-a.json   (phase A, include=bridge,trend,movers,gap)
 *        <fixtureBase>/<scope>-b.json   (phase B, include=dissection)
 *      it is served UNCHANGED, so it goes through the same normalise() the live
 *      response does. <scope> is nameFor(params) -- see fixtures/README.md.
 *      A missing scope falls back to default-a.json / default-b.json, then to
 *      the synthetic scenario. Fixtures are tried only in a browser.
 *   2. SIX synthetic scenarios emitting the RAW WIRE SHAPE per mexp2-wire.js
 *      (MEXP2.WIRE 2.1.0), re-derived from api/margin-explorer.js@8012e00:
 *        happy              everything present, exact Bennet closure
 *        empty-scope        200, zero rows, hero literally 0, discount_overlay null
 *        malformed          200, valid JSON, every top-level type wrong
 *        bridge-unavailable phase-A {available:false,level:null,reason} and
 *                           canonical/net {available:false,reason} -- two-key form
 *        rounding-drift     reconciles TRUE, bars re-sum 2 PHP/ton off the anchors
 *        trust-signals      sign_stable false + churn_dominated + significance noise
 *                           + feed_basis issued-kg proxy
 *   3. The activation flags (?mx2mock=1 / localStorage) and a promise-returning
 *      fetch() with apiFetch's resolve semantics.
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never normalise. Everything here is the raw endpoint body.
 *   - Never touch the DOM, inject styles, call console.*, patch window.apiFetch,
 *     or touch v1. The v2 transport ASKS this module for a body.
 *   - Never use Date.now / Math.random. The clock is frozen at CLOCK.
 *   - Never emit NaN, Infinity or undefined inside a payload. Keys that the
 *     server leaves ABSENT are absent here too (never null in their place).
 *
 * WIRE FACTS THIS FILE ENCODES (C1-C23, T1-T5 -- see CONTRACT.md)
 *   - matrix.rows is the full population, ORDER BY gp DESC; tons = round(kg/1000)
 *     INTEGER; gm_per_kg 2dp; gp_pct/pct_of_gp 1dp; a zero-kg row carries
 *     gm_per_kg 0 and gp_pct 0-or-real, NEVER null (C1, C6).
 *   - `sales` is GROSS of OINV.DiscSum; the honest figure is discount_overlay,
 *     ALWAYS computed in both phases, nullable only on kg<=0 (C2, C3).
 *   - phase B is a FULL envelope: hero/matrix/discount_overlay populated (C15).
 *   - bridge.prior_gp/current_gp/delta_gp are PHP PER TON (C7); trend points are
 *     {month, gm_per_ton} only (C8); movers.items always []; gap never available (C9).
 *   - dissection.scope is the STRING "finished_feed" (C10); anchors are a month
 *     PAIR of complete months, not the selected period.
 *   - canonical_bridge is EXACT by construction: residual is emitted raw and
 *     reconciles is effectively always true; client drift comes from rounding (C13).
 *   - bridge.true_basis is "customer\u00D7SKU" with U+00D7 MULTIPLICATION SIGN (C23).
 *   - meta.window reproduces the backend's toISOString TIMEZONE BUG on purpose
 *     (one day early), so a panel that renders it is visibly wrong (T4).
 *
 * THEME: this file emits no CSS. Dark is data-theme="" (empty); light is "light".
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var W = NS.WIRE || null;   // optional; literals below are copies of W.LITERALS
  var C = NS.C || {};

  // ---- literals (copied from mexp2-wire.js; overridden by W.LITERALS when loaded)
  var LIT = {
    TRUE_BASIS: "customer\u00D7SKU",
    DISCOUNT_BASIS: "OINV.DiscSum allocated to lines pro-rata on LineTotal",
    HERO_SCOPE: "ItmsGrpCod IN (103,105,102) \u2014 finished feed + trading-import + basemix",
    DISS_SCOPE: "finished_feed",
    BRIDGE_SCOPE: "finished_feed_103",
    SCOPE_HERO: "(103,105,102)",
    SCOPE_DISS: "(103)"
  };
  (function () {
    var k;
    if (!W || !W.LITERALS) return;
    for (k in W.LITERALS) {
      if (Object.prototype.hasOwnProperty.call(W.LITERALS, k)) LIT[k] = W.LITERALS[k];
    }
  })();
  var PESO_TON = "\u20B1/ton";
  var DISS_BASIS = "Live 103 / Old 103+104 \u00B7 " + PESO_TON;
  var GROUP_BYS = (W && W.GROUP_BYS) || ["region", "bu", "dsm", "brand", "species", "sales_group", "ssg", "customer", "sku"];
  var LENS_CAPS = (W && W.LENS_ROW_CAPS) || { ssg: 12, bu: 8, region: 8, customer: 15, sku: 15 };
  var DEFAULT_INCLUDE = "bridge,trend,movers,gap";

  // ---- the frozen clock: the running PH month is 2026-08, last posting 21 Aug.
  var CLOCK = { y: 2026, m: 8, day: 21, lastPosted: "2026-08-21", cutoffYm: "2026-01", snapshot: "2026-08-21T14:32:07.000Z" };

  // =========================================================================
  // 1. DETERMINISTIC PSEUDO-RANDOM (FNV-1a seed + 32-bit LCG; no Math.imul)
  // =========================================================================
  function hashSeed(s) {
    var h = 2166136261, i;
    s = String(s == null ? "" : s);
    for (i = 0; i < s.length; i++) { h = h ^ s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  }
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function span(rng, lo, hi) { return lo + (hi - lo) * rng(); }
  // Round to d decimals; never NaN/Infinity (0 instead, and that is a bug to find).
  function r(n, d) {
    var v = +n, p;
    if (v !== v || v === Infinity || v === -Infinity) return 0;
    p = Math.pow(10, d || 0);
    return Math.round(v * p) / p;
  }
  function ri(n) { return Math.round(+n || 0); }
  function isArr(a) { return Object.prototype.toString.call(a) === "[object Array]"; }

  // =========================================================================
  // 2. VOCABULARY -- Philippine feed-miller reality
  // =========================================================================
  var SSG_LIST = ["Hog Grower", "Hog Finisher", "Hog Starter", "Broiler Starter", "Broiler Finisher",
    "Layer Layer", "Layer Grower", "Gamefowl Conditioner", "Aqua Tilapia", "Aqua Bangus",
    "Pet Dog Adult", "UNSPEC"];
  var CUSTOMERS = ["SAN MIGUEL FOODS INC", "BOUNTY AGRO VENTURES INC", "CEBU AGRO-INDUSTRIAL DEV",
    "DAVAO LIVESTOCK VENTURES", "ILOILO FEEDS TRADING", "PAMPANGA HOG RAISERS COOP",
    "NEGROS POULTRY SUPPLY", "CAGAYAN DE ORO AGRIVET", "BATANGAS PIGGERY CORP", "LEYTE FARM SUPPLY",
    "GENERAL SANTOS AQUAFARM", "BULACAN LAYER FARMS INC", "ZAMBOANGA FEED CENTER",
    "TARLAC AGRI ENTERPRISES", "BOHOL LIVESTOCK TRADING", "PALAWAN AGRIVET SUPPLY",
    "NUEVA ECIJA GRAINS CORP", "SORSOGON FARM DEALER", "MISAMIS POULTRY VENTURES",
    "LAGUNA PET SUPPLY HOUSE", "CAVITE HOG CENTER", "SAMAR AGRI TRADING", "BUKIDNON RANCH SUPPLY",
    "QUEZON PROVINCE FEEDS"];
  var DSMS = ["R. Bautista", "M. Delos Santos", "J. Ocampo", "A. Villanueva", "C. Mendoza", "L. Sarmiento", "E. Panganiban", "G. Tolentino"];
  var BRANDS = ["Vitarich", "Nutri-Max", "Sarimanok", "Harvest King", "PetPro", "AquaVie"];
  var SPECIES = ["Hog", "Broiler", "Layer", "Gamefowl", "Aqua", "Pet"];
  var SALES_GROUPS = ["Commercial Feeds", "Contract Growing", "Institutional", "Retail Dealer", "Export"];
  var INGREDIENTS = ["Yellow Corn", "Soybean Meal 46%", "Rice Bran D1", "Copra Meal", "Fish Meal 60%",
    "Wheat Pollard", "Cassava Meal", "Limestone", "Monocalcium Phosphate", "Soya Oil",
    "L-Lysine HCl", "DL-Methionine", "Molasses", "Vit-Min Premix"];
  // 340 SKUs: over C.ROW_CAP (300) so the "+N more" client footer is exercised.
  var SKUS = (function () {
    var stages = ["Starter", "Pre-Starter", "Grower", "Finisher", "Booster", "Conditioner", "Breeder", "Layer", "Developer", "Maintenance"];
    var packs = ["25kg", "50kg", "10kg", "5kg"], forms = ["Crumble", "Mash", "Pellet"];
    var out = [], i, j, k, m, code = 1000;
    for (i = 0; i < SPECIES.length; i++) for (j = 0; j < stages.length; j++)
      for (k = 0; k < packs.length; k++) for (m = 0; m < forms.length; m++) {
        if (out.length >= 340) return out;
        out.push(SPECIES[i].substring(0, 2).toUpperCase() + "-" + (code++) + " " + SPECIES[i] + " " + stages[j] + " " + forms[m] + " " + packs[k]);
      }
    return out;
  })();
  var DIMS = { bu: ["DISTRIBUTION", "KEY ACCOUNTS", "PET CARE"], region: ["Luzon", "Visayas", "Mindanao", "Other"],
    dsm: DSMS, brand: BRANDS, species: SPECIES, sales_group: SALES_GROUPS, ssg: SSG_LIST, customer: CUSTOMERS, sku: SKUS };
  var REGION_SHARE = { Luzon: 0.52, Visayas: 0.27, Mindanao: 0.20, Other: 0.01 };
  var BU_SHARE = { DISTRIBUTION: 0.62, "KEY ACCOUNTS": 0.30, "PET CARE": 0.08 };
  var MONTHLY_TONS = 18600;   // national finished feed + trading + basemix, MT/month

  // =========================================================================
  // 3. SCENARIO REGISTRY
  // =========================================================================
  var SCENARIOS = [
    { id: "happy", n: 1, label: "Happy path",
      desc: "Every block present on the real wire shape. Canonical bridge closes exactly (integer bars, residual 0). discount_overlay shows the ~12% overstatement." },
    { id: "empty-scope", n: 2, label: "Empty scope (200, zero rows)",
      desc: "HTTP 200, matrix.rows [], total_gp 0, every hero value literally 0 with null deltas, discount_overlay null, phase-A bridge 3-key unavailable, dissection 2-key unavailable. Zero rows IS the whole test (A3)." },
    { id: "malformed", n: 3, label: "Malformed payload",
      desc: "Valid JSON, HTTP 200, every type wrong: meta a string, hero an array, matrix.rows an object; dissection.trajectory an object. Must be caught by shape validation, never by a swallowed TypeError." },
    { id: "bridge-unavailable", n: 4, label: "Bridges unavailable (C5 minimal forms)",
      desc: "Phase-A bridge is EXACTLY {available:false, level:null, reason}. canonical_bridge / net_bridge / price_drill are EXACTLY {available:false, reason}; dissection.window null. Other keys UNDEFINED, not null (C5)." },
    { id: "rounding-drift", n: 5, label: "Rounding drift (reconciles true)",
      desc: "The thing that CAN happen: reconciles true, residual ~1e-14 raw, yet the four rounded bars re-sum 2 PHP/ton short of the rounded anchors. Under C.TOLERANCE_PHP_T.canonical (3): no Unexplained bar. significance unavailable." },
    { id: "trust-signals", n: 6, label: "Trust signals (T1+T2+T3)",
      desc: "mix_ordering.sign_stable false (customer bar -251 vs +3 by ordering), mix_detail.churn_dominated true with WARNING appended to note, significance verdict noise, phase-A feed_basis is the issued-kg proxy." }
  ];
  var SCENARIO_BY_ID = (function () { var m = {}, i; for (i = 0; i < SCENARIOS.length; i++) m[SCENARIOS[i].id] = SCENARIOS[i]; return m; })();
  var DEFAULT_SCENARIO = "happy";
  var LATENCY = { _default: [140, 520] };
  function latencyFor(id) { var L = LATENCY[id] || LATENCY._default; return [+L[0] || 0, +L[1] || 0]; }

  // =========================================================================
  // 4. CALENDAR -- all strings built by hand; never toISOString (T4)
  // =========================================================================
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function ym(y, m) { return y + "-" + pad2(m); }
  function ymd(y, m, d) { return y + "-" + pad2(m) + "-" + pad2(d); }
  function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
  function parseYm(s) { return { y: +s.slice(0, 4), m: +s.slice(5, 7) }; }
  function ymAdd(s, k) {
    var p = parseYm(s), t = p.y * 12 + (p.m - 1) + k;
    return ym(Math.floor(t / 12), (t % 12) + 1);
  }
  function fmtDate(dt) { return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()); }
  function toDate(s) { return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function dayAdd(s, k) { var d = toDate(s); d.setDate(d.getDate() + k); return fmtDate(d); }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000) + 1; }
  // Shipping days: every day but Sunday (the mill ships Saturdays).
  function shippingDays(a, b) {
    var d = toDate(a), e = toDate(b), n = 0;
    while (d <= e) { if (d.getDay() !== 0) n++; d.setDate(d.getDate() + 1); }
    return n;
  }
  var RUNNING_YM = ym(CLOCK.y, CLOCK.m);

  // The current reporting window for period + ref_month (server: margin_window).
  function currentWindow(sp) {
    var live = (sp.ref_month === "live");
    var a = live ? { y: CLOCK.y, m: CLOCK.m } : parseYm(sp.ref_month);
    var running = (ym(a.y, a.m) === RUNNING_YM);
    var endDay = running ? CLOCK.day : lastDay(a.y, a.m);
    var to = ymd(a.y, a.m, endDay), from, q;
    if (sp.period === "7D") from = dayAdd(to, -6);
    else if (sp.period === "QTD") { q = a.m - ((a.m - 1) % 3); from = ymd(a.y, q, 1); }
    else if (sp.period === "YTD") from = ymd(a.y, 1, 1);
    else from = ymd(a.y, a.m, 1);   // MTD and anything unrecognised
    return { from: from, to: to };
  }
  // vs PP: same period one step back, truncated to the same elapsed days.
  function priorWindow(sp, cur) {
    var f = toDate(cur.from), t = toDate(cur.to), len;
    if (sp.period === "7D") { len = daysBetween(cur.from, cur.to); return { from: dayAdd(cur.from, -len), to: dayAdd(cur.to, -len) }; }
    if (sp.period === "YTD") return { from: ymd(f.getFullYear() - 1, 1, 1), to: ymd(t.getFullYear() - 1, t.getMonth() + 1, Math.min(t.getDate(), lastDay(t.getFullYear() - 1, t.getMonth() + 1))) };
    if (sp.period === "QTD") {
      var qf = ymAdd(ym(f.getFullYear(), f.getMonth() + 1), -3), qt = ymAdd(ym(t.getFullYear(), t.getMonth() + 1), -3), pt = parseYm(qt);
      return { from: qf + "-01", to: ymd(pt.y, pt.m, Math.min(t.getDate(), lastDay(pt.y, pt.m))) };
    }
    var pm = parseYm(ymAdd(ym(t.getFullYear(), t.getMonth() + 1), -1));
    return { from: ym(pm.y, pm.m) + "-01", to: ymd(pm.y, pm.m, Math.min(t.getDate(), lastDay(pm.y, pm.m))) };
  }
  function lyWindow(cur) {
    var f = toDate(cur.from), t = toDate(cur.to);
    return { from: ymd(f.getFullYear() - 1, f.getMonth() + 1, f.getDate()), to: ymd(t.getFullYear() - 1, t.getMonth() + 1, Math.min(t.getDate(), lastDay(t.getFullYear() - 1, t.getMonth() + 1))) };
  }
  // Dissection anchors: first and last COMPLETE months in range; one complete
  // month steps the base back one; zero complete months (live MTD/7D) compares
  // the running month like-for-like. The last case is the mock's reading of
  // win:resolveLikeForLike and is flagged unverified in the build report.
  function anchorsFor(sp, cur) {
    var a = cur.from.slice(0, 7), b = cur.to.slice(0, 7), complete = [], s = a;
    while (s <= b) { if (s !== RUNNING_YM || sp.ref_month !== "live") complete.push(s); s = ymAdd(s, 1); }
    if (complete.length >= 2) return { base: complete[0], compare: complete[complete.length - 1], partial: false };
    if (complete.length === 1) return { base: ymAdd(complete[0], -1), compare: complete[0], partial: false };
    return { base: ymAdd(RUNNING_YM, -1), compare: RUNNING_YM, partial: true };
  }
  // WINDOW_META (win:meta) for a month pair.
  function windowMeta(an) {
    var cp = parseYm(an.compare), bp = parseYm(an.base);
    var cFrom = an.compare + "-01", cTo = an.partial ? CLOCK.lastPosted : ymd(cp.y, cp.m, lastDay(cp.y, cp.m));
    var bFrom = an.base + "-01", bFull = ymd(bp.y, bp.m, lastDay(bp.y, bp.m)), bTo = bFull;
    var cDays = shippingDays(cFrom, cTo), cFull = shippingDays(cFrom, ymd(cp.y, cp.m, lastDay(cp.y, cp.m)));
    var bDays, d;
    if (an.partial) {   // truncate the base month to the same elapsed shipping days
      d = toDate(bFrom); bDays = 0;
      while (bDays < cDays && d <= toDate(bFull)) { if (d.getDay() !== 0) bDays++; if (bDays < cDays) d.setDate(d.getDate() + 1); }
      bTo = fmtDate(d);
    } else bDays = shippingDays(bFrom, bTo);
    return {
      base_month: an.base, compare_month: an.compare, compare_partial: an.partial,
      like_for_like: true,
      base_window: [bFrom, bTo], compare_window: [cFrom, cTo],
      base_shipping_days: bDays, compare_shipping_days: cDays, compare_shipping_days_full_month: cFull,
      month_progress_pct: cFull > 0 ? r(cDays / cFull * 100, 1) : null,
      last_posted_date: cTo, last_posted_source: "MAX(DocDate) in scope",
      note: an.partial
        ? "Compare month is the running month: base truncated to " + cDays + " elapsed shipping days (from MAX(DocDate), not the server clock)."
        : "Both months complete; no truncation applied."
    };
  }

  // =========================================================================
  // 5. PARAMS -- normalised exactly the way the server does it (W.PARAMS)
  // =========================================================================
  function upper(s) { return String(s == null ? "" : s).toUpperCase(); }
  function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }
  function readParams(params) {
    var p = params || {}, region = trim(p.region), bu = trim(p.bu), cust = trim(p.customer), gb = trim(p.group_by || p.groupBy);
    var inc = String(p.include == null ? DEFAULT_INCLUDE : p.include).toLowerCase().split(","), list = [], i, seen = {};
    var rl = region.toLowerCase();
    region = (rl === "luzon") ? "Luzon" : (rl === "visayas") ? "Visayas" : (rl === "mindanao") ? "Mindanao" : (rl === "other") ? "Other" : "ALL";
    for (i = 0; i < inc.length; i++) { inc[i] = trim(inc[i]); if (inc[i] && !seen[inc[i]]) { seen[inc[i]] = 1; list.push(inc[i]); } }
    var gbOk = false; for (i = 0; i < GROUP_BYS.length; i++) if (GROUP_BYS[i] === gb) gbOk = true;
    return {
      period: upper(p.period) || "YTD",
      ref_month: /^\d{4}-\d{2}$/.test(String(p.ref_month || p.refMonth || "")) ? String(p.ref_month || p.refMonth) : "live",
      region: region,
      bu: (!bu || upper(bu) === "ALL") ? "ALL" : bu,
      customer: cust || null,
      group_by: gbOk ? gb : "sales_group",     // unknown SILENTLY falls back (me:39)
      compare: (String(p.compare || "").toLowerCase() === "ly") ? "ly" : "pp",
      include: list
    };
  }
  function has(sp, block) { var i; for (i = 0; i < sp.include.length; i++) if (sp.include[i] === block) return true; return false; }
  function scopeSeed(scn, sp) { return [scn, sp.period, sp.ref_month, sp.region, sp.bu, sp.customer || "", sp.group_by, sp.compare].join("|"); }
  function rngFor(scn, sp, block) { return makeRng(hashSeed(scopeSeed(scn, sp) + "#" + block)); }
  function sliceFactor(sp) {
    var f = 1;
    if (sp.region !== "ALL") f *= REGION_SHARE[sp.region] || 0.01;
    if (sp.bu !== "ALL") f *= BU_SHARE[sp.bu] || 0.05;
    if (sp.customer) f *= 0.035;
    return f;
  }
  function isSliced(sp) { return sp.region !== "ALL" || sp.bu !== "ALL" || !!sp.customer; }

  // =========================================================================
  // 6. META (C22, T4)
  // =========================================================================
  function buildMeta(sp, cur) {
    return {
      endpoint: "margin-explorer", sap_validated: true, data_source: "sap_b1",
      // THE TIMEZONE BUG, reproduced: toISOString on a PH-local midnight lands a day early.
      window: { from: dayAdd(cur.from, -1), to: dayAdd(cur.to, -1) },
      applied_filters: { period: sp.period, ref_month: sp.ref_month, region: sp.region, bu: sp.bu, customer: sp.customer,
        group_by: sp.group_by, compare: sp.compare, include: sp.include.slice(0) },
      // BACKEND LITERALS, verbatim from api/margin-explorer.js:909-921 (H2).
      // Five notes, exactly these strings; nothing invented.
      data_quality: {
        volume_basis: "INV1.InvQty (kg)",
        region_basis: "OcrCode2 (sales dim-2)",
        bu_basis: "OCRD.GroupCode->OCRG (real)",
        scope_hero: LIT.SCOPE_HERO, scope_dissection_bridge: LIT.SCOPE_DISS,
        snapshot_at: CLOCK.snapshot,
        notes: [
          "Pre-rebate gross profit.",
          "Hero KPIs cover finished feed + trading-import + basemix (103,105,102); the dissection bridge covers finished feed only (103). The two are different universes \u2014 GM/kg will not match exactly.",
          "vs-PP = same period one step back, truncated to equal elapsed shipping days (Sundays and PH holidays excluded).",
          "MTD figures move as invoices post; every number is a snapshot \u2014 see snapshot_at.",
          "vs-LY at customer/SKU not comparable across Jan-2026 consolidation; bridge falls back to category (SSG) level when the comparison crosses the cutoff (national only)."
        ]
      }
    };
  }

  // =========================================================================
  // 7. MATRIX + HERO + DISCOUNT OVERLAY -- one scope-seeded universe (C1, C2, C3, C6)
  // =========================================================================
  function dimsFor(sp) {
    if (sp.group_by === "region" && sp.region !== "ALL") return [sp.region];
    if (sp.group_by === "bu" && sp.bu !== "ALL") return [sp.bu];
    return DIMS[sp.group_by] || DIMS.sales_group;
  }
  // Raw (unrounded) universe: rows with float sales/kg/gp. Shared by hero and matrix.
  function buildUniverse(scn, sp, cur) {
    var rng = rngFor(scn, sp, "universe");
    var dims = dimsFor(sp), kgTotal = MONTHLY_TONS * 1000 * (daysBetween(cur.from, cur.to) / 30.4) * sliceFactor(sp);
    var rows = [], w = [], sumW = 0, i, kg, price, gm, d;
    for (i = 0; i < dims.length; i++) { w[i] = Math.exp(span(rng, -1.3, 1.3)); sumW += w[i]; }
    for (i = 0; i < dims.length; i++) {
      d = dims[i];
      kg = kgTotal * w[i] / sumW;
      price = (sp.bu === "PET CARE" || d === "PET CARE" || d === "Pet" || d === "PetPro" || /^Pet /.test(d) || /^PE-/.test(d)) ? span(rng, 88, 104) : span(rng, 29, 37);
      gm = price * span(rng, 0.125, 0.195);
      rows.push({ dim: d, sales: kg * price, kg: kg, gp: kg * gm });
    }
    // A weightless line (service / trading item with no kg) on the wide cuts:
    // sales <> 0 so HAVING keeps it; kg 0 so gm_per_kg is ZERO, never null (C6).
    if (scn === "happy" && dims.length > 4 && sp.group_by !== "sku") {
      rows.push({ dim: "(none)", sales: 48500 * sliceFactor(sp), kg: 0, gp: 6208 * sliceFactor(sp) });
    }
    var S = 0, K = 0, G = 0;
    for (i = 0; i < rows.length; i++) { S += rows[i].sales; K += rows[i].kg; G += rows[i].gp; }
    return { rows: rows, sales: S, kg: K, gp: G, priorFactor: span(rng, 0.93, 1.07), priorGmFactor: span(rng, 0.94, 1.05), discPerKg: span(rng, 0.74, 0.90) };
  }
  function buildMatrix(sp, U) {
    var rows = [], i, x, tot = 0, sorted;
    for (i = 0; i < U.rows.length; i++) tot += U.rows[i].gp;
    for (i = 0; i < U.rows.length; i++) {
      x = U.rows[i];
      rows.push({
        dim: x.dim, sales: ri(x.sales), kg: ri(x.kg), tons: ri(x.kg / 1000), gp: ri(x.gp),
        gp_pct: x.sales > 0 ? r(x.gp / x.sales * 100, 1) : 0,
        gm_per_kg: x.kg > 0 ? r(x.gp / x.kg, 2) : 0,
        pct_of_gp: tot !== 0 ? r(x.gp / tot * 100, 1) : 0,
        expandable: sp.group_by !== "sku"
      });
    }
    sorted = rows.slice(0);
    sorted.sort(function (a, b) { return b.gp - a.gp; });
    return { group_by: sp.group_by, total_gp: ri(tot), rows: sorted };
  }
  function buildHero(sp, U, cur, cmpWin, empty) {
    var lySliced = (sp.compare === "ly" && isSliced(sp));
    var nullDeltas = empty || lySliced;
    var pS = U.sales * U.priorFactor, pK = U.kg * U.priorFactor, pG = U.gp * U.priorFactor * U.priorGmFactor;
    var gpPct = U.sales > 0 ? U.gp / U.sales * 100 : 0, pGpPct = pS > 0 ? pG / pS * 100 : 0;
    var gmKg = U.kg > 0 ? U.gp / U.kg : 0, pGmKg = pK > 0 ? pG / pK : 0;
    var cw = { from: cmpWin.from, to: cmpWin.to, basis: sp.compare === "ly" ? "same dates last year" : "prior period, truncated to the same elapsed shipping days" };
    if (sp.compare === "pp") cw.current_last_posted = empty ? null : cur.to;
    return {
      net_sales: { value: ri(U.sales), delta_pct: nullDeltas ? null : r((U.sales / pS - 1) * 100, 1) },
      gross_profit: { value: ri(U.gp), delta_pct: nullDeltas ? null : r((U.gp / pG - 1) * 100, 1) },
      gp_pct: { value: r(gpPct, 1), delta_pp: nullDeltas ? null : r(gpPct - pGpPct, 1) },
      gm_per_kg: { value: r(gmKg, 2), delta: nullDeltas ? null : r(gmKg - pGmKg, 2) },
      compare_basis: sp.compare, compare_window: cw, scope: LIT.HERO_SCOPE,
      ly_comparable: !lySliced,
      compare_note: lySliced ? "LY comparison across the Jan-2026 consolidation is national-only; deltas suppressed for this region/BU/customer slice." : null
    };
  }
  // ALWAYS computed, both phases; null only when kg <= 0 (C3).
  function buildOverlay(scn, sp, U, cur) {
    if (!(U.kg > 0)) return null;
    var rng = rngFor(scn, sp, "overlay");
    var rep = U.gp / U.kg, disc = U.discPerKg, net = rep - disc;
    var pRep = rep / U.priorGmFactor, pDisc = disc * span(rng, 0.9, 1.1);
    var series = [], s = ymAdd(cur.to.slice(0, 7), -11), last = cur.to.slice(0, 7), m, rp, dp;
    if (s < CLOCK.cutoffYm) s = CLOCK.cutoffYm;   // clamped to the migration cutoff
    for (m = s; m <= last; m = ymAdd(m, 1)) {
      rp = rep * span(rng, 0.9, 1.1); dp = disc * span(rng, 0.85, 1.15);
      series.push({ month: m, gm_per_kg_reported: r(rp, 3), discount_per_kg: r(dp, 3), gm_per_kg_net: r(rp - dp, 3), partial: m === RUNNING_YM && sp.ref_month === "live" });
    }
    return {
      available: true,
      discount_per_kg: r(disc, 3), discount_total: ri(disc * U.kg),
      gm_per_kg_reported: r(rep, 3), gm_per_kg_net_of_discount: r(net, 3),
      discount_pct_of_reported_gm: rep > 0 ? r(disc / rep * 100, 1) : null,
      delta_reported: sp.compare === "ly" ? null : r(rep - pRep, 3),
      delta_net_of_discount: sp.compare === "ly" ? null : r((rep - disc) - (pRep - pDisc), 3),
      series: series,
      chart_hint: "Separate panel below the headline: two lines (gm_per_kg_reported, gm_per_kg_net) with discount_per_kg as the wedge; never replace the reported headline.",
      basis: LIT.DISCOUNT_BASIS,
      note: "Reported GM/kg is gross of the document-level trade discount (OINV.DiscSum). gm_per_kg_net_of_discount is the realised figure. Shown alongside, not instead of, the reported headline."
    };
  }

  // =========================================================================
  // 8. PHASE A: BRIDGE (C7, C20, C21, C23), TREND (C8), MOVERS/GAP (C9)
  // =========================================================================
  function buildIngredientsA(rng, proxy) {
    var items = [], i, pNow, pPrior, iNow, iPrior, pe, ie, sumD = 0, sumP = 0, sumI = 0, both = 0;
    for (i = 0; i < 12; i++) {
      pNow = r(span(rng, 9, 52), 2); iNow = r(span(rng, 0.4, 42), 2);
      if (i === 11) { pPrior = null; iPrior = null; pe = 0; ie = r(pNow * iNow * 10 * 0.5, 1); }   // new ingredient: not issued prior
      else {
        pPrior = r(pNow * span(rng, 0.9, 1.12), 2); iPrior = r(iNow * span(rng, 0.92, 1.08), 2); both++;
        pe = r((pNow - pPrior) * ((iNow + iPrior) / 2) * 10, 1);
        ie = r((iNow - iPrior) * ((pNow + pPrior) / 2) * 10, 1);
      }
      items.push({ name: INGREDIENTS[i], price_now: pNow, price_prior: pPrior, incl_now_pct: iNow, incl_prior_pct: iPrior,
        perton_cost: r(pNow * iNow * 10, 1), perton_delta: r(pe + ie, 1), price_effect: pe, inclusion_effect: ie });
      sumD += pe + ie; sumP += pe; sumI += ie;
    }
    items.sort(function (a, b) { return Math.abs(b.perton_delta) - Math.abs(a.perton_delta); });
    return { items: items, meta: {
      unit: "php_per_ton_of_feed",
      feed_tons_current: ri(span(rng, 9000, 16000)), feed_tons_prior: ri(span(rng, 9000, 16000)),
      feed_basis: proxy ? "issued-kg proxy (no completed/planned qty)" : "CmpltQty",
      price_source: "PCH1 weighted-average landed price per window (OPCH/PCH1)",
      items_priced_both_windows: both,
      sum_perton_delta: r(sumD, 1), sum_price_effect: r(sumP, 1), sum_inclusion_effect: r(sumI, 1),
      note: "Per ton of feed PRODUCED (OWOR/WOR1). Not reconciled to the sales-based GM/ton bridge."
    } };
  }
  function buildBridgeA(scn, sp, U, cmpWin) {
    var rng = rngFor(scn, sp, "bridgeA");
    // Scenario 4: the phase-A three-key form EXACTLY as me:289-291 emits it
    // (level:null present, every other key absent). Reason text verbatim.
    if (scn === "bridge-unavailable") {
      return { available: false, level: null,
        reason: "Bridge unavailable for a region/BU/customer slice across the Jan-2026 consolidation — 2025 used a different customer/SKU/region coding. Clear filters for the national category-level bridge." };
    }
    if (!(U.kg > 0)) return { available: false, level: null, reason: "no volume in the current window" };
    if (sp.compare === "ly" && isSliced(sp)) return { available: false, level: null, reason: "comparison crosses the Jan-2026 consolidation with a region/BU/customer slice; SSG fallback is national-only" };
    var ssgLevel = (sp.compare === "ly");
    var gm1 = U.gp / U.kg, gm0 = gm1 / U.priorGmFactor;
    var delta = (gm1 - gm0) * 1000;
    var price = delta * span(rng, 0.4, 1.4), mix = delta * span(rng, -0.3, 0.3), cost = delta - price - mix;
    var out = {
      available: true, level: ssgLevel ? "ssg" : "sku",
      basis: (sp.compare === "ly" ? "vs last year" : "vs prior period") + " \u00B7 " + PESO_TON, unit: "php_per_ton",
      prior_gp: ri(gm0 * 1000), current_gp: ri(gm1 * 1000), delta_gp: ri(gm1 * 1000) - ri(gm0 * 1000),
      price: ri(price), mix: ri(mix)
    };
    out.cost = ssgLevel ? { total: ri(cost) } : { total: ri(cost), rm: ri(cost * 0.86), packaging: ri(cost * 0.11), feedtag: ri(cost) - ri(cost * 0.86) - ri(cost * 0.11) };
    out.reconciles = true;
    out.cogs_split = !ssgLevel;
    if (ssgLevel) {
      out.ingredients = []; out.ingredients_meta = null;
      out.note = "Comparison crosses the Jan-2026 consolidation: SSG-level fallback, national only, cost not split.";
      return out;
    }
    var ing = buildIngredientsA(rng, scn === "trust-signals");
    out.ingredients = ing.items; out.ingredients_meta = ing.meta;
    out.note = "SKU-level per-kg decomposition x1000 " + cmpWin.from + " \u2192 " + cmpWin.to + " vs current window. price is SKU-blended (customer mix leaks in) \u2014 see true_price.";
    out.true_price = ri(price * span(rng, 0.7, 0.95));
    out.true_cost = ri(cost);
    out.customer_mix = ri(price) - out.true_price + ri(mix * 0.4);
    out.product_mix = out.delta_gp - out.true_price - out.true_cost - out.customer_mix;
    out.true_basis = LIT.TRUE_BASIS;
    out.true_note = "customer\u00D7SKU pair pass: true_price holds customer AND SKU constant; product_mix includes the pair interaction residual.";
    return out;
  }
  function buildTrend(scn, sp, U, cur) {
    var rng = rngFor(scn, sp, "trend"), series = [], s, last, m, gm = U.kg > 0 ? U.gp / U.kg * 1000 : 0;
    if (U.kg > 0) {
      s = ymAdd(cur.to.slice(0, 7), -11); last = cur.to.slice(0, 7);
      if (s < CLOCK.cutoffYm) s = CLOCK.cutoffYm;
      for (m = s; m <= last; m = ymAdd(m, 1)) series.push({ month: m, gm_per_ton: ri(gm * span(rng, 0.9, 1.1)) });
    }
    return { unit: "gm_per_ton", ly_comparable: false, ly_suppressed_reason: "pre_2026_not_comparable", series: series };
  }
  function buildMovers() { return { basis: "mix_contribution", items: [] }; }
  function buildGap() { return { available: false, note: "Phase 1: gap analysis pending" }; }

  // =========================================================================
  // 9. PHASE B: DISSECTION (C10, C11, C12, C13, C16-C19, T1-T3)
  // =========================================================================
  function cubeMonths() { var out = [], k; for (k = 11; k >= 0; k--) out.push(ymAdd(RUNNING_YM, -k)); return out; }
  function buildTrajectory(rng, months) {
    var out = [], i, tons, rev, gm, p;
    for (i = 0; i < months.length; i++) {
      tons = ri(span(rng, 14000, 19500) * (months[i] === RUNNING_YM ? CLOCK.day / 31 : 1));
      rev = ri(span(rng, 31500, 34500)); gm = ri(rev * span(rng, 0.13, 0.19));
      p = { month: months[i], tons: tons, rev_per_ton: rev, gm_per_ton: gm, cogs_per_ton: rev - gm, gm_pct: r(gm / rev * 100, 1) };
      if (months[i] === RUNNING_YM) p.partial = true;   // key ABSENT elsewhere (C17)
      out.push(p);
    }
    return out;
  }
  function buildSsgBridge(rng, an, prior, delta) {
    var price = ri(delta * span(rng, 0.5, 1.2)), cost = ri(delta * span(rng, -0.6, 0.3)), mix = ri(delta * span(rng, -0.3, 0.3));
    var d = ri(delta);
    return { available: true, base: ri(prior), compare: ri(prior) + d, price: price, mix: mix, cost: cost,
      interaction: d - price - mix - cost, delta: d, base_month: an.base, compare_month: an.compare };
  }
  function buildMixBridge(rng, total) {
    var items = [], i, sum = 0, v;
    for (i = 0; i < SSG_LIST.length; i++) { v = ri(span(rng, -60, 60)); items.push({ ssg: SSG_LIST[i], contribution: v }); sum += v; }
    items.sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
    return { available: true, items: items.slice(0, 10), total: sum };
  }
  function buildDissIngredients(rng) {
    var items = [], i, v, net = 0;
    for (i = 0; i < INGREDIENTS.length; i++) {
      v = r(span(rng, -140, 140), 1); net += v;
      items.push({ name: INGREDIENTS[i], contribution: v, cost_now: r(span(rng, 40, 9800), 1), carried: (i % 5 === 4) });
    }
    items.sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
    return { available: true, items: items.slice(0, 10), net: r(net, 1),
      note: "Recipe-weighted ingredient cost per ton of feed sold, base vs compare month; carried = price carried from the other month. Not reconciled to the GM/ton bridge." };
  }
  function buildPriceDrill(rng, an, ssgPrice) {
    var truep = ri(ssgPrice * span(rng, 0.55, 0.9)), cm = ri(ssgPrice * span(rng, -0.2, 0.2)), skum = ssgPrice - truep - cm, rows = [], i, tb, tc, rb, held;
    for (i = 0; i < 10; i++) {
      tb = ri(span(rng, 40, 900)); tc = ri(tb * span(rng, 0.6, 1.4)); rb = ri(span(rng, 29000, 36000)); held = (i % 4 === 3) ? null : ri(span(rng, 40, 100));
      rows.push({ ssg: SSG_LIST[i % SSG_LIST.length], sku: SKUS[i * 7], name: SKUS[i * 7].slice(8), tons_b: tb, tons_c: tc, rev_ton_b: rb, rev_ton_c: ri(rb * span(rng, 0.96, 1.05)),
        true_price: ri(span(rng, -90, 90)), customer_mix: ri(span(rng, -40, 40)), held_pct: held });
    }
    return { available: true, unit: "php_per_ton", total: ssgPrice, true_price: truep, customer_mix: cm, sku_mix: skum, residual: 0,
      price_held_pct: r(span(rng, 55, 92), 1), top_rows: rows,
      note: "Splits the SSG bridge Price bar " + an.base + " \u2192 " + an.compare + " at base-month weights; total equals the SSG bridge price term, not the canonical bridge." };
  }
  function buildLens(rng, keys, cap) {
    var rows = [], i, v, total = 0, s0, s1, t0, t1, entering;
    for (i = 0; i < keys.length; i++) {
      v = ri(span(rng, -70, 70)); total += v;
      entering = (i === 3);   // absent in the base window: gm_ton0 null, tons0 0
      s0 = entering ? 0 : r(span(rng, 1, 18), 1); s1 = r(span(rng, 1, 18), 1);
      t0 = entering ? 0 : ri(span(rng, 80, 2600)); t1 = ri(span(rng, 80, 2600));
      rows.push({ key: keys[i], value: v, share0_pct: s0, share1_pct: s1, share_shift_pp: r(s1 - s0, 2),
        gm_ton0: entering ? null : ri(span(rng, 3800, 6800)), gm_ton1: ri(span(rng, 3800, 6800)), tons0: t0, tons1: t1 });
    }
    rows.sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); });
    return { total: total, rows: rows.slice(0, cap) };
  }
  function buildLenses(rng, withNote) {
    var L = {
      ssg: buildLens(rng, SSG_LIST, LENS_CAPS.ssg), bu: buildLens(rng, DIMS.bu, LENS_CAPS.bu),
      region: buildLens(rng, DIMS.region.slice(0, 3), LENS_CAPS.region), customer: buildLens(rng, CUSTOMERS, LENS_CAPS.customer),
      sku: buildLens(rng, SKUS.slice(0, 40), LENS_CAPS.sku)
    };
    if (withNote) L.note = "Each lens is a standalone one-dimensional Bennet share-shift over that dimension; lenses do not sum to each other nor to the Customer/Product Mix bars.";
    return L;
  }
  function significanceFor(rng, scn, delta) {
    if (scn === "rounding-drift") return { available: false, reason: "need >= 5 historical windows" };
    var n = 7, mean = span(rng, -20, 30), sd = (scn === "trust-signals") ? span(rng, 300, 420) : span(rng, 22, 40);
    var z = (delta - mean) / sd, pct = 1 / (1 + Math.exp(-1.7 * z));
    return { available: true, n: n, mean: mean, sd: sd, z: z, percentile: pct, band: [mean - 1.645 * sd, mean + 1.645 * sd],
      verdict: Math.abs(z) >= 2 ? "signal" : Math.abs(z) >= 1 ? "weak" : "noise" };
  }
  // The raw (unrounded) decomposition every bridge on this dissection shares.
  function rawDecomp(rng, scn) {
    var d = {};
    if (scn === "rounding-drift") {
      // Hand-picked: raw closure exact, rounded bars 66, rounded anchors 5180 -> 5248 (68). Drift 2.
      d.prior = 5180.49; d.price = 182.49; d.cost = -95.51; d.cm = -41.51; d.pm = 22.49;
      d.cf = { customer: -38.2, product: 19.2 }; d.pf = { customer: -44.8, product: 25.8 };
    } else if (scn === "trust-signals") {
      d.prior = ri(span(rng, 4900, 5500)); d.price = ri(span(rng, -140, 200)); d.cost = ri(span(rng, -160, 120));
      // The ordering choice moves the customer bar from -251 to +3: the split is an artefact (T1).
      d.cf = { customer: -251, product: 0 }; d.pf = { customer: 3, product: 0 };
      d.cm = (d.cf.customer + d.pf.customer) / 2;
      var mt = ri(span(rng, -60, -20)); d.pm = mt - d.cm;
      d.cf.product = mt - d.cf.customer; d.pf.product = mt - d.pf.customer;
    } else if (scn === "happy") {
      // The REAL Jul->Aug 2026 reported bridge (v1 live page): delta -202/t,
      // price -19/t. buildNet pairs it with the -210/t wedge cut, so the net
      // view reads +8/t, +163/t: a list-price cut offset by a rebate cut. The
      // sign-flip headline ("do not call this erosion") fires on the happy path.
      d.prior = 5450; d.price = -19; d.cost = -140; d.cm = -30; d.pm = -13;
      d.cf = { customer: d.cm - 3, product: d.pm + 3 }; d.pf = { customer: d.cm + 3, product: d.pm - 3 };
    } else {
      // others: integer raw bars, so closure is exact even after rounding.
      d.prior = ri(span(rng, 4900, 5500)); d.price = ri(span(rng, -140, 220)); d.cost = ri(span(rng, -160, 120));
      d.cm = ri(span(rng, -60, 60)); d.pm = ri(span(rng, -40, 50));
      d.cf = { customer: d.cm - 3, product: d.pm + 3 }; d.pf = { customer: d.cm + 3, product: d.pm - 3 };
    }
    d.delta = d.price + d.cost + d.cm + d.pm;
    d.current = d.prior + d.delta;
    d.mixTotal = d.cm + d.pm;
    return d;
  }
  function buildCanonical(rng, scn, an, win, d) {
    var churn = (scn === "trust-signals"), oneSided = churn ? 47.3 : r(span(rng, 8, 30), 1), matched = churn ? 71.2 : r(span(rng, 88, 97), 1);
    var cost = ri(d.cost), pack = ri(cost * 0.12), ft = ri(cost * 0.03), sig = significanceFor(rng, scn, d.delta);
    var lenses = buildLenses(rng, true), pmBySsg = [], i, row;
    for (i = 0; i < lenses.ssg.rows.length; i++) {
      row = lenses.ssg.rows[i];
      if (row.value !== 0) pmBySsg.push({ ssg: row.key === "UNSPEC" ? "Untagged" : row.key, value: row.value });
    }
    var note = "Exact Bennet decomposition at customer\u00D7SKU cells, " + an.base + " \u2192 " + an.compare +
      (an.partial ? " (like-for-like, " + win.compare_shipping_days + " shipping days)" : " (complete months)") +
      ". Price and Cost hold the cell constant; Customer/Product Mix is the Shapley mean of both orderings.";
    if (churn) note += " WARNING: mix is churn-dominated (one-sided share " + oneSided + "%, matched kg share " + matched + "%): most of the composition effect comes from customer\u00D7SKU cells present in only one window.";
    return {
      available: true, unit: "php_per_ton", scope: LIT.BRIDGE_SCOPE,
      method: "Bennet indicator at customer\u00D7SKU (s1*m1 - s0*m0 = sbar*dm + mbar*ds); mix split = Shapley mean of both orderings",
      window: win, base_month: an.base, compare_month: an.compare, compare_partial: an.partial, like_for_like: true,
      prior_gm_ton: ri(d.prior), current_gm_ton: ri(d.current), delta: ri(d.delta),
      price: ri(d.price), cost: cost, customer_mix: ri(d.cm), product_mix: ri(d.pm), mix_total: ri(d.mixTotal),
      mix_ordering: {
        customer_first: { customer: ri(d.cf.customer), product: ri(d.cf.product) },
        product_first: { customer: ri(d.pf.customer), product: ri(d.pf.product) },
        customer_range: [ri(Math.min(d.cf.customer, d.pf.customer)), ri(Math.max(d.cf.customer, d.pf.customer))],
        product_range: [ri(Math.min(d.cf.product, d.pf.product)), ri(Math.max(d.cf.product, d.pf.product))],
        sign_stable: (d.cf.customer >= 0) === (d.pf.customer >= 0)
      },
      mix_detail: {
        continuing: ri(d.mixTotal * (churn ? 0.2 : 0.8)), entering: ri(d.mixTotal * (churn ? 0.9 : 0.15)),
        exiting: ri(d.mixTotal) - ri(d.mixTotal * (churn ? 0.2 : 0.8)) - ri(d.mixTotal * (churn ? 0.9 : 0.15)),
        one_sided_share_pct: oneSided, matched_kg_share_pct: matched,
        cells_only_prior: ri(span(rng, 40, 300)), cells_only_current: ri(span(rng, 40, 300)),
        churn_dominated: churn
      },
      lenses: lenses,
      cost_components: { rm: cost - pack - ft, packaging: pack, feedtag: ft, estimated: true,
        basis: "production-order class ratio (OWOR/WOR1 x OITM.LastPurPrc, YTD avg) applied to the Cost bar; RM is the remainder" },
      significance: sig,
      dropped_cells: { prior: ri(span(rng, 0, 12)), current: ri(span(rng, 0, 12)), gp_prior: span(rng, 0, 90000), gp_current: span(rng, 0, 90000) },
      reconciles: true,
      residual: (scn === "rounding-drift") ? 7.105427357601002e-15 : 0,
      product_mix_by_ssg: pmBySsg,
      note: note
    };
  }
  function buildNet(rng, scn, an, win, d, discKg, tons0, tons1) {
    var dPrior = ri(discKg * span(rng, 0.93, 1.0) * 1000), dCur = ri(discKg * 1000), dd;
    // happy: the observed 2026-08-01 repricing — wedge cut 210/t (974 -> 764/t
    // on the live page), so reported -202/t becomes net +8/t (see rawDecomp).
    if (scn === "happy") dPrior = dCur + 210;
    dd = dCur - dPrior;
    var prior = d.prior - dPrior, current = d.current - dCur, delta = d.delta - dd, price = d.price - dd;
    var churn = (scn === "trust-signals"), cb = buildCanonical(rng, scn, an, win, d);   // reuse the shape, then narrow it
    var lenses = buildLenses(rng, false), pmBySsg = [], i, row;
    for (i = 0; i < lenses.ssg.rows.length; i++) { row = lenses.ssg.rows[i]; if (row.value !== 0) pmBySsg.push({ ssg: row.key === "UNSPEC" ? "Untagged" : row.key, value: row.value }); }
    return {
      available: true, unit: "php_per_ton", scope: LIT.BRIDGE_SCOPE,
      method: cb.method + "; revenue and GP net of OINV.DiscSum allocated pro-rata on LineTotal",
      window: win, base_month: an.base, compare_month: an.compare, compare_partial: an.partial, like_for_like: true,
      prior_gm_ton: ri(prior), current_gm_ton: ri(current), delta: ri(delta),
      price: ri(price), cost: cb.cost, customer_mix: cb.customer_mix, product_mix: cb.product_mix, mix_total: cb.mix_total,
      mix_ordering: { customer_range: cb.mix_ordering.customer_range, product_range: cb.mix_ordering.product_range, sign_stable: cb.mix_ordering.sign_stable },
      mix_detail: { continuing: cb.mix_detail.continuing, entering: cb.mix_detail.entering, exiting: cb.mix_detail.exiting,
        one_sided_share_pct: cb.mix_detail.one_sided_share_pct, matched_kg_share_pct: cb.mix_detail.matched_kg_share_pct, churn_dominated: churn },
      lenses: lenses,
      discount: { prior_per_ton: dPrior, current_per_ton: dCur, delta_per_ton: dd, prior_total: ri(dPrior * tons0), current_total: ri(dCur * tons1) },
      vs_reported: { delta_reported: ri(d.delta), delta_net: ri(delta), gap: ri(delta) - ri(d.delta),
        price_reported: ri(d.price), price_net: ri(price), price_gap: ri(price) - ri(d.price) },
      reconciles: true,
      residual: (scn === "rounding-drift") ? -3.552713678800501e-15 : 0,
      product_mix_by_ssg: pmBySsg,
      note: "Same decomposition net of the off-invoice discount (" + LIT.DISCOUNT_BASIS + "). The discount wedge moved " + dd + " " + PESO_TON + " between the anchors." +
        (churn ? " WARNING: mix is churn-dominated." : "")
    };
  }
  function buildCategoryTrend(rng, months, happy) {
    var cats = [], avg = [], i, j, cells, tons, gm, rev, tot, sumT, sumGm, sumRev, ssg, lastComplete = months.length - 2;
    var bucket = []; for (j = 0; j < months.length; j++) bucket[j] = { t: 0, gm: 0, rev: 0 };
    for (i = 0; i < 9; i++) {
      ssg = SSG_LIST[i === 8 ? 11 : i]; cells = []; tot = 0;
      for (j = 0; j < months.length; j++) {
        tons = (i === 7 && j < 4) ? 0 : ri(span(rng, 300, 4200) * (months[j] === RUNNING_YM ? CLOCK.day / 31 : 1));   // Aqua Bangus: no volume before May
        rev = ri(span(rng, 30000, 36000)); gm = ri(rev * span(rng, 0.11, 0.2));
        // happy only: Hog Grower's latest COMPLETE month sits well off its own
        // trailing mean (|z| >= 1.5), and UNSPEC carries three cells on 2 MT at
        // the v1 "Untagged PHP 4.5M/t" level — a per-ton ratio on near-zero
        // tonnage that the insight panel must skip, never quote.
        if (happy && i === 0 && j === lastComplete) gm = ri(rev * 0.28);
        if (happy && i === 8 && j < 3) { tons = 2; gm = 4519296; }
        tot += tons;
        cells.push({ month: months[j], gm_ton: tons > 0 ? gm : null, gm_pct: tons > 0 ? r(gm / rev * 100, 1) : null, tons: tons });   // NULL on zero tons (C19)
        if (tons > 0) { bucket[j].t += tons; bucket[j].gm += gm * tons; bucket[j].rev += rev * tons; }
      }
      cats.push({ ssg: ssg, total_tons: tot, cells: cells });
    }
    cats.sort(function (a, b) { return b.total_tons - a.total_tons; });
    for (j = 0; j < months.length; j++) {
      sumT = bucket[j].t; sumGm = bucket[j].gm; sumRev = bucket[j].rev;
      avg.push({ month: months[j], gm_ton: sumT > 0 ? ri(sumGm / sumT) : null, gm_pct: sumRev > 0 ? r(sumGm / sumRev * 100, 1) : null, tons: sumT });
    }
    return { available: true, months: months.slice(0), partial_month: RUNNING_YM, categories: cats, avg: avg,
      note: "GM/ton by SSG over the last 12 cube months; avg row is volume-weighted; UNSPEC = untagged SKUs." };
  }
  function buildDissection(scn, sp, U, cur) {
    var rng = rngFor(scn, sp, "dissection");
    if (!(U.kg > 0)) return { available: false, reason: "no finished-feed rows in the selected range" };
    var an = anchorsFor(sp, cur), months = cubeMonths(), unavailable = (scn === "bridge-unavailable");
    if (unavailable) { an = { base: "2025-12", compare: an.compare, partial: false }; }
    var win = unavailable ? null : windowMeta(an);
    var d = rawDecomp(rng, scn), traj = buildTrajectory(rng, months);
    var ssg = buildSsgBridge(rng, an, d.prior, d.delta);
    var out = {
      available: true, scope: LIT.DISS_SCOPE, basis: DISS_BASIS,
      base_month: an.base, compare_month: an.compare, compare_partial: an.partial,
      compare_days: win ? win.compare_shipping_days : null,
      window: win, months: months, trajectory: traj,
      bridge: ssg, mix_bridge: buildMixBridge(rng, ssg.mix), ingredients: buildDissIngredients(rng)
    };
    if (unavailable) {
      out.price_drill = { available: false, reason: "pre-2026 anchor" };
      out.canonical_bridge = { available: false, reason: "pre-2026 anchor: base month 2025-12 is in the Old book; the customer\u00D7SKU drill needs both months live" };
      out.net_bridge = { available: false, reason: "pre-2026 anchor" };
    } else {
      out.price_drill = buildPriceDrill(rng, an, ssg.price);
      out.canonical_bridge = buildCanonical(rng, scn, an, win, d);
      out.net_bridge = buildNet(rng, scn, an, win, d, U.discPerKg, traj[months.length - 2].tons, traj[months.length - 1].tons);
    }
    out.category_trend = buildCategoryTrend(rng, months, scn === "happy");
    return out;
  }

  // =========================================================================
  // 10. MALFORMED (scenario 3)
  // =========================================================================
  function malformedCore() {
    return { meta: "not-an-object", hero: [1, 2, 3], discount_overlay: "0.82", matrix: { group_by: 7, total_gp: "lots", rows: { dim: "x" } },
      bridge: "unavailable", trend: { unit: "gm_per_ton", series: "2026-08" }, movers: 1, gap: false, dissection: null };
  }
  function malformedDiss() {
    return { meta: 42, hero: null, discount_overlay: [], matrix: { rows: "none" }, bridge: null, trend: null, movers: null, gap: null,
      dissection: { available: "yes", scope: { id: 103 }, trajectory: { month: "2026-08" }, ingredients: "corn", category_trend: [], canonical_bridge: 5180, net_bridge: "n/a" } };
  }

  // =========================================================================
  // 11. ENVELOPE ASSEMBLY -- keys ALWAYS present; gated blocks null (W.ENVELOPE)
  // =========================================================================
  // Ring-log a warning through MEXP2.debug (C.DEBUG.CALLER_RULE): the store's
  // warn(msg, data) when present, else push(level, msg, data), else silence.
  // Never console.
  function ringWarn(msg, data) {
    try {
      var d = NS.debug;
      if (!d) return;
      if (typeof d.warn === "function") d.warn(msg, data);
      else if (typeof d.push === "function") d.push("warn", msg, data);
    } catch (e) {}
  }
  // The scenario to serve for an id. An UNKNOWN id is never served silently:
  // it falls back to the default AND leaves a ring entry saying so (H2c).
  function resolveScenario(id) {
    if (SCENARIO_BY_ID[id]) return id;
    if (id !== null && id !== undefined && id !== "") {
      ringWarn("mock: unknown scenario id — serving the default", { requested: String(id), served: DEFAULT_SCENARIO });
    }
    return DEFAULT_SCENARIO;
  }
  function rawEnvelope(scenarioId, params) {
    var scn = resolveScenario(scenarioId);
    var sp = readParams(params), cur = currentWindow(sp);
    var wantDiss = has(sp, "dissection");
    if (scn === "malformed") return wantDiss ? malformedDiss() : malformedCore();
    var empty = (scn === "empty-scope");
    var U = empty ? { rows: [], sales: 0, kg: 0, gp: 0, priorFactor: 1, priorGmFactor: 1, discPerKg: 0 } : buildUniverse(scn, sp, cur);
    var cmpWin = sp.compare === "ly" ? lyWindow(cur) : priorWindow(sp, cur);
    return {
      meta: buildMeta(sp, cur),
      hero: buildHero(sp, U, cur, cmpWin, empty),
      discount_overlay: buildOverlay(scn, sp, U, cur),
      matrix: buildMatrix(sp, U),
      bridge: has(sp, "bridge") ? buildBridgeA(scn, sp, U, cmpWin) : null,
      trend: has(sp, "trend") ? buildTrend(scn, sp, U, cur) : null,
      dissection: wantDiss ? buildDissection(scn, sp, U, cur) : null,
      movers: has(sp, "movers") ? buildMovers() : null,
      gap: has(sp, "gap") ? buildGap() : null
    };
  }
  function withInclude(params, inc) {
    var out = {}, k, p = params || {};
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
    if (out.include == null) out.include = inc;
    return out;
  }
  function rawCore(scenarioId, params) { return rawEnvelope(scenarioId, withInclude(params, DEFAULT_INCLUDE)); }
  function rawDiss(scenarioId, params) { return rawEnvelope(scenarioId, withInclude(params, "dissection")); }

  // =========================================================================
  // 12. ACTIVATION FLAGS
  // =========================================================================
  function qs(name) {
    var m, s;
    try {
      s = (typeof window.location === "object" && window.location && window.location.search) ? window.location.search : "";
      m = new RegExp("[?&]" + name + "=([^&#]*)").exec(s);
      return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
    } catch (e) { return null; }
  }
  function lsGet(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (window.localStorage) window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { if (window.localStorage) window.localStorage.removeItem(k); return true; } catch (e) { return false; } }
  var LS_ON = "mexp2_mock", LS_SCENARIO = "mexp2_mock_scenario", LS_FIXTURES = "mexp2_mock_fixtures";

  function isEnabled() {
    var q = qs("mx2mock"), v;
    if (q != null) return q === "1" || q === "true" || q === "yes";
    v = lsGet(LS_ON);
    return v === "1" || v === "true";
  }
  function scenarioId() {
    var q = qs("mx2scenario") || qs("mx2mockScenario"), v;
    if (q) return resolveScenario(q);            // unknown -> default + ring warning
    v = lsGet(LS_SCENARIO);
    if (v) return resolveScenario(v);
    return DEFAULT_SCENARIO;
  }
  function setScenario(id) { if (!SCENARIO_BY_ID[id]) return false; return lsSet(LS_SCENARIO, id); }
  function setEnabled(on) { return on ? lsSet(LS_ON, "1") : lsDel(LS_ON); }

  // =========================================================================
  // 13. FIXTURE LOADER -- recorded real responses, served unchanged
  // =========================================================================
  // Base URL: the directory of this script's <script src>, plus ../fixtures/.
  // Resolved at load; overridable with setFixtureBase().
  var FIXTURE_BASE = (function () {
    var scripts, i, src;
    try {
      if (typeof document !== "object" || !document) return "fixtures/";
      if (document.currentScript && document.currentScript.src) src = document.currentScript.src;
      else {
        scripts = document.getElementsByTagName("script");
        for (i = scripts.length - 1; i >= 0; i--) { if (/mexp2-mock\.js/.test(scripts[i].src || "")) { src = scripts[i].src; break; } }
      }
      if (!src) return "fixtures/";
      return src.replace(/[^\/]*$/, "") + "../fixtures/";
    } catch (e) { return "fixtures/"; }
  })();
  function setFixtureBase(p) { if (typeof p === "string" && p) FIXTURE_BASE = /\/$/.test(p) ? p : p + "/"; return FIXTURE_BASE; }
  function fixturesEnabled() {
    var q = qs("mx2fixtures");
    if (q != null) return !(q === "0" || q === "false" || q === "no");
    return lsGet(LS_FIXTURES) !== "0";
  }
  function setFixturesEnabled(on) { return on ? lsDel(LS_FIXTURES) : lsSet(LS_FIXTURES, "0"); }
  function slug(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  // The fixture stem for a params object: period_region_bu_groupby_compare,
  // then _ref<YYYY-MM> when ref_month is set and _cust-<slug> when customer is.
  function nameFor(params) {
    var sp = readParams(params);
    var n = [sp.period, sp.region, sp.bu, sp.group_by, sp.compare].join("_").toLowerCase();
    if (sp.ref_month !== "live") n += "_ref" + sp.ref_month;
    if (sp.customer) n += "_cust-" + slug(sp.customer);
    return n;
  }
  function phaseOf(params) { return has(readParams(params), "dissection") ? "diss" : "core"; }
  function urlFor(params, phase) { return FIXTURE_BASE + nameFor(params) + (phase === "diss" ? "-b" : "-a") + ".json"; }
  var FIXTURE_CACHE = {};
  function clearFixtureCache() { FIXTURE_CACHE = {}; }
  // GET url -> Promise<{ok, body|why}>. Never rejects; a miss is a value.
  function xhrJson(url) {
    if (FIXTURE_CACHE[url]) return FIXTURE_CACHE[url];
    FIXTURE_CACHE[url] = new Promise(function (resolve) {
      var x;
      try {
        x = new XMLHttpRequest();
        x.open("GET", url, true);
        x.onreadystatechange = function () {
          if (x.readyState !== 4) return;
          if (x.status >= 200 && x.status < 300) {
            try { resolve({ ok: true, url: url, body: JSON.parse(x.responseText) }); }
            catch (e) { resolve({ ok: false, url: url, why: "not JSON" }); }
          } else resolve({ ok: false, url: url, why: "http " + x.status });
        };
        x.send(null);
      } catch (e) { resolve({ ok: false, url: url, why: "xhr threw" }); }
    });
    return FIXTURE_CACHE[url];
  }
  // Resolve with the recorded body for this scope+phase, else null.
  function loadFixture(params, phase) {
    var ph = phase || phaseOf(params);
    if (typeof XMLHttpRequest !== "function" && typeof XMLHttpRequest !== "object") return Promise.resolve(null);
    return xhrJson(urlFor(params, ph)).then(function (res) {
      if (res.ok) return res.body;
      return xhrJson(FIXTURE_BASE + "default" + (ph === "diss" ? "-b" : "-a") + ".json").then(function (d) { return d.ok ? d.body : null; });
    });
  }
  var lastSource = null;   // "fixture:<url>" | "synthetic:<id>" -- for the test page

  // Promise-returning stand-in for apiFetch('margin-explorer', params).
  // Resolves with the parsed body; never resolves with undefined. `override`
  // forces a scenario id and skips fixtures (the test pages dump every scenario).
  function mockFetch(endpoint, params, override) {
    var id = override ? resolveScenario(override) : scenarioId();
    var phase = phaseOf(params), lat = latencyFor(id), delay = phase === "diss" ? lat[1] : lat[0];
    function synthetic() {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var body;
          try { body = rawEnvelope(id, withInclude(params, phase === "diss" ? "dissection" : DEFAULT_INCLUDE)); }
          catch (e) { reject(new Error("API error: 500 mock generator fault: " + (e && e.message))); return; }
          lastSource = "synthetic:" + id;
          resolve(body);
        }, delay);
      });
    }
    if (override || !fixturesEnabled()) return synthetic();
    return loadFixture(params, phase).then(function (body) {
      if (body === null) return synthetic();
      lastSource = "fixture:" + nameFor(params) + (phase === "diss" ? "-b" : "-a");
      return body;
    });
  }

  // =========================================================================
  // 14. EXPORT
  // =========================================================================
  NS.mock = {
    VERSION: "2.1.0",
    SCENARIOS: SCENARIOS, DEFAULT_SCENARIO: DEFAULT_SCENARIO,
    get: function (id) { return SCENARIO_BY_ID[id] || null; },
    isEnabled: isEnabled, setEnabled: setEnabled, scenarioId: scenarioId, setScenario: setScenario,
    rawCore: rawCore, rawDiss: rawDiss, raw: rawEnvelope,
    fetch: mockFetch, latency: latencyFor,
    readParams: readParams, CLOCK: CLOCK,
    lastSource: function () { return lastSource; },
    fixtures: {
      base: function () { return FIXTURE_BASE; }, setBase: setFixtureBase,
      enabled: fixturesEnabled, setEnabled: setFixturesEnabled,
      nameFor: nameFor, urlFor: urlFor, load: loadFixture, clearCache: clearFixtureCache
    }
  };
})();
