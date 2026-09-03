/* ============================================================================
 * mexp2-contract.js — Margin Explorer v2 · THE FROZEN PANEL CONTRACT (MEXP2.C)
 * ----------------------------------------------------------------------------
 * What PANELS consume: the view-model shape, the six render states, the panel
 * lifecycle, the seven action shapes, the waterfall and bullet specs, the
 * Escape rule, and every tuned constant with its one-line why.
 *
 * The RAW WIRE SHAPE lives in mexp2-wire.js (MEXP2.WIRE) and nowhere else.
 * The REASONING behind every decision lives in CONTRACT.md. This file states
 * decisions; it does not argue them.
 *
 * Rules this file obeys: no DOM, no fetch, no mutable state, no logging, never
 * touches margin-explorer*.js, never defines --border or --surface2.
 * Theme: dark is data-theme="" (empty), light is data-theme="light". Full dark
 * palette on bare :root; light under :root[data-theme="light"] only.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});

  // The only executable code here besides TOLERANCE and pillText. Downstream
  // files cannot mutate the contract and silently desync each other.
  function deepFreeze(o) {
    if (o === null || typeof o !== "object") return o;
    var k;
    for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) deepFreeze(o[k]); }
    return Object.freeze(o);
  }

  var C = {};

  // ---- identity -------------------------------------------------------------
  C.VERSION = "2.1.0";                        // re-derived from the real backend
  C.CONTRACT_SOURCE = "mexp2-wire.js (MEXP2.WIRE) for the wire; CONTRACT.md for the why";
  C.NAMESPACE = "MEXP2";
  C.ROOT_ID = "pg-margin-explorer-2";         // never #pg-margin-explorer (v1)
  C.STYLE_ID = "mexp2-style";                 // never "mexp-style"
  C.ENDPOINT = "margin-explorer";             // same endpoint as v1, via global apiFetch
  C.INCLUDE_CORE = "bridge,trend,movers,gap"; // phase A
  C.INCLUDE_DISS = "dissection";              // phase B
  C.THEME = { ATTR: "data-theme", DARK_VALUE: "", LIGHT_VALUE: "light" }; // app.html:7822-7824

  // ---- basis: the one label rule -------------------------------------------
  // sales-derived figures are GROSS of the off-invoice discount (WIRE.BASIS).
  C.BASIS_SUFFIX = {
    reported: "gross of off-invoice discount",
    net: "net of off-invoice discount",
    per_ton: "PHP/ton",
    per_kg: "PHP/kg"
  };
  C.BASIS = {
    rule: "Any figure from WIRE.BASIS.GROSS_FIELDS carries C.BASIS_SUFFIX.reported; any from NET_FIELDS carries .net.",
    honest_figure: "core.discount_overlay.gm_per_kg_net_of_discount — always present when the overlay is; show it beside the reported tile, never instead of it.",
    per_ton_misnamed: "core.bridge.prior_gp/current_gp/delta_gp are PHP/ton — suffix '/t', never format as a peso total."
  };

  // ---- universes and anchors: what a panel must PRINT --------------------------
  C.UNIVERSES = {
    hero: "finished feed + trading-import + basemix (103,105,102) · credit notes not netted",
    dissection: "finished feed only (103) · credit notes netted",
    rule: "Never draw a connector, delta or shared axis between a hero figure and a dissection figure.",
    copy: "Hero KPIs cover finished feed + trading-import + basemix (103,105,102). The dissection bridge covers finished feed only (103) and nets credit notes. Different universes — GM/kg will not match."
  };
  C.ANCHORS = {
    kind: "month_pair",
    panel_rule: "Every dissection panel prints diss.base_month and diss.compare_month verbatim in its subtitle. A heading that says only 'YTD' is a defect.",
    partial_copy: "Like-for-like: both months truncated to the same elapsed shipping days."
  };
  C.TONNAGE = {
    source: "SUM(core.matrix.rows[].kg) / 1000",
    rule: "Never sum rows[].tons (integer MT, loses up to 0.5 t per row). Aggregate over ALL rows before C.ROW_CAP."
  };

  // ---- scope vocabulary ----------------------------------------------------------
  C.PERIODS = ["7D", "MTD", "QTD", "YTD"];
  C.REGIONS = ["ALL", "Luzon", "Visayas", "Mindanao"];
  C.BUS = ["ALL", "DISTRIBUTION", "KEY ACCOUNTS", "PET CARE"];
  C.UNITS = ["kg", "ton", "gp_pct", "gp"];
  C.COMPARES = ["pp", "ly"];
  C.GROUP_BYS = ["region", "bu", "dsm", "brand", "species", "sales_group", "ssg", "customer", "sku"];
  C.GROUP_BY_DEFAULT_SERVER = "sales_group";  // unknown group_by silently falls back to this
  C.LABELS = {
    groupBy: { bu: "Business Unit", region: "Region", dsm: "DSM", brand: "Brand", species: "Species",
               sales_group: "Sales Group", ssg: "SSG", customer: "Customer", sku: "SKU" },
    unit: { kg: "GM / kg", ton: "GM / ton", gp_pct: "GP %", gp: "GP PHP" },
    compare: { pp: "vs PP", ly: "vs LY" },
    period: { "7D": "7D", MTD: "MTD", QTD: "QTD", YTD: "YTD" }
  };
  // group_by values whose row-click re-scopes a real filter. Others only highlight.
  C.DRILL_FILTER = { region: "region", bu: "bu", customer: "customer" };
  // vm.key composition, in this order. NOT unit, NOT sort (display-only, never refetch).
  C.scopeKeyFields = ["period", "refMonth", "region", "bu", "customer", "groupBy", "compare", "drill"];
  C.KEY_SEP = "|";
  C.KEY_DRILL_SEP = ">";
  // QTD: the most fully populated cut (SKU bridge + ingredients + trend all present).
  C.DEFAULT_SCOPE = {
    period: "QTD", refMonth: null, region: "ALL", bu: "ALL", customer: null,
    groupBy: "bu", unit: "kg", compare: "pp", drill: [], sort: { col: "gp", dir: "desc" }
  };

  // ---- phase presence (C15) ----------------------------------------------------
  C.PHASE_PRESENCE = {
    always: ["meta", "hero", "discount_overlay", "matrix"],
    phase_a_only: ["bridge", "trend", "movers", "gap"],
    phase_b_only: ["dissection"],
    absent_value: "null (key present)",
    rule: "A phase-B response is a FULL core payload plus dissection. Store may refresh hero/matrix/overlay from it; last write wins by seq. Never treat their presence as a violation."
  };

  // ---- the view model ----------------------------------------------------------------
  C.VM_SHAPE = {
    scope: { period: "string", refMonth: "string|null", region: "string", bu: "string",
             customer: "string|null", groupBy: "string", unit: "string", compare: "string",
             drill: "array<{dim,value,label}>", sort: "{col:string,dir:'asc'|'desc'}" },
    key: "string",
    label: "string",
    status: "C.STATE.*",
    core: "null|{meta,hero,discount_overlay,matrix,bridge,trend,movers,gap} — WIRE.ENVELOPE minus dissection, produced by MEXP2.api.mapCore: C5-EXACT (a key the wire leaves absent is UNDEFINED, never null-filled; unavailable forms carry exactly their wire keys; an include-gated block is null), numerics through toNum()",
    diss: "null|WIRE.DISSECTION, produced by MEXP2.api.mapDissection under the same C5-exact rule; {available:false, reason} carries NO other key",
    prev: "null|{key:string,label:string,core,diss}",
    error: "null|{kind:C.ERROR_KIND.*,message:string}"
  };

  // ONE normaliser (D1). The store's normalizeCore/normalizeDiss delegate to
  // these; no second mapping exists, so a panel reads exactly what the wire
  // mappers produce. Guard with `v == null` (C.NUM.UNDEFINED_RULE).
  C.NORMALISER = { owner: "mexp2-api.js", core: "MEXP2.api.mapCore(body)", diss: "MEXP2.api.mapDissection(block)",
                   rule: "vm.core / vm.diss are C5-exact: absent wire keys are UNDEFINED, not null." };

  // A vm with every slot present and empty. Status is LOADING-FIRST, not fresh:
  // a vm whose core is null has never had data (A6). scope is a FROZEN reference
  // — deep-copy scope, scope.sort and scope.drill before use (A7).
  C.EMPTY_VM = { scope: C.DEFAULT_SCOPE, key: "", label: "", status: "loading-first", core: null, diss: null, prev: null, error: null };
  C.EMPTY_VM_CLONE = {
    required_deep_copies: ["scope", "scope.sort", "scope.drill"],
    recipe: "cloneScope(s): copy every scalar; drill = s.drill.map(copy {dim,value,label}); sort = {col:s.sort.col, dir:s.sort.dir}"
  };

  // ---- the six render states ------------------------------------------------------
  C.STATE = {
    FRESH: "fresh",                            // current, complete data; full contrast
    LOADING_FIRST: "loading-first",            // nothing ever painted; skeletons allowed here ONLY
    LOADING_REFRESH: "loading-refresh",        // refetch in flight; keep last good, dim, pill
    EMPTY_SCOPE: "empty-scope",                // HTTP 200 with zero matrix rows; em dash, never PHP 0
    UNAVAILABLE_FOR_SCOPE: "unavailable-for-scope", // 200 + available:false + reason; an answer, full contrast
    ERRORED: "errored"                         // transport/parse failure; only state with an error affordance
  };
  C.STATE_LIST = [C.STATE.FRESH, C.STATE.LOADING_FIRST, C.STATE.LOADING_REFRESH,
                  C.STATE.EMPTY_SCOPE, C.STATE.UNAVAILABLE_FOR_SCOPE, C.STATE.ERRORED];
  // `pill` is a KEY into C.STATE_COPY or null (A9). Resolve with C.pillText(state).
  C.STATE_RULES = {
    "fresh":                 { dim: false, pill: null,            skeleton: false, preservePrior: false, fullContrastZero: true },
    "loading-first":         { dim: false, pill: null,            skeleton: true,  preservePrior: false, fullContrastZero: false },
    "loading-refresh":       { dim: true,  pill: "pill-updating", skeleton: false, preservePrior: true,  fullContrastZero: true },
    "empty-scope":           { dim: false, pill: null,            skeleton: false, preservePrior: false, fullContrastZero: false },
    "unavailable-for-scope": { dim: false, pill: null,            skeleton: false, preservePrior: true,  fullContrastZero: false },
    "errored":               { dim: false, pill: "pill-errored",  skeleton: false, preservePrior: true,  fullContrastZero: false }
  };
  C.STATE_COPY = {
    "pill-updating": "Updating",
    "pill-errored": "Update failed",
    "empty-scope": "No rows in this scope.",
    "empty-scope-hint": "Widen the period, or clear Region / BU / Customer.",
    "unavailable-for-scope": "Not available for this selection.",
    "errored": "Could not load margin data.",
    "errored-stale": "Couldn’t refresh just now — showing last good data.",
    "loading-first": "Loading margin data…",
    "zero-placeholder": "—"
  };
  C.pillText = function pillText(state) {
    var rule = C.STATE_RULES[state];
    if (!rule || !rule.pill) return "";
    return C.STATE_COPY[rule.pill] || "";
  };

  // ZERO ROWS IS THE WHOLE TEST (A3). Tonnage is derived FROM the rows and hero
  // carries no volume, so "zero rows but non-zero tonnage" cannot exist on the
  // wire. There is no data-fault branch. matrix.rows is never truncated, so an
  // empty array really is an empty scope.
  C.EMPTY_SCOPE_TEST = { requires: ["http 200", "matrix.rows.length === 0"], tonnage_source: C.TONNAGE.source };

  C.ERROR_KIND = {
    NETWORK: "network",       // fetch threw
    HTTP: "http",             // non-2xx
    PARSE: "parse",           // 2xx but not the JSON we expect
    EMPTY_BODY: "empty-body", // 2xx, valid JSON, null/undefined payload
    UNKNOWN: "unknown"        // renderer or store threw
  };

  // ---- the panel lifecycle --------------------------------------------------------
  C.PANEL_LIFECYCLE = {
    methods: ["mount", "render", "renderStale", "setStatus", "destroy"],
    mount:       { signature: "mount(hostEl)", contract: "Once. Build DOM, cache refs. No vm, no fetch. Window-level listeners are registered HERE, never at module load." },
    render:      { signature: "render(vm)", contract: "Idempotent: same vm twice = identical DOM. No state from a previous vm; the previous scope is vm.prev, owned by the store." },
    renderStale: { signature: "renderStale(prev, vm)", contract: "The only way stale data reaches the screen. Paint prev.core/prev.diss dimmed and PRINT prev.label. Never call with prev === null." },
    setStatus:   { signature: "setStatus(state)", contract: "Chrome only per C.STATE_RULES: dim class, pill via C.pillText, skeleton. Touches no data node. Safe to repeat." },
    destroy:     { signature: "destroy()", contract: "Destroy every Chart.js instance, remove every listener (window-level included), empty host. Safe before mount and safe twice." },
    order: "mount -> (setStatus | render | renderStale)* -> destroy"
  };

  // ---- the seven action shapes ---------------------------------------------------------
  C.ACTION = {
    SCOPE: "SCOPE",     // scope changed -> new key -> refetch
    VIEW: "VIEW",       // display-only (unit, sort) -> NO refetch, no seq
    DATA: "DATA",       // a phase landed
    ERROR: "ERROR",     // a phase failed
    LOADING: "LOADING", // a phase started
    STALE: "STALE",     // promote current -> prev before a scope change
    RESET: "RESET"      // back to C.DEFAULT_SCOPE, drop caches
  };
  C.ACTION_LIST = [C.ACTION.SCOPE, C.ACTION.VIEW, C.ACTION.DATA, C.ACTION.ERROR, C.ACTION.LOADING, C.ACTION.STALE, C.ACTION.RESET];
  // seq is bumped ONLY on a real key change (A2). A same-key SCOPE must not
  // advance it, or valid in-flight work is dropped and the panel hangs.
  C.SEQ_RULE = { owner: "store", invariant: "seq advances iff the scope KEY changes", corollary: "unit/sort go through VIEW, never SCOPE",
                 controller_rule: "Controllers route unit/sort through store.dispatch(VIEW), never api.applyScope; applyScope dispatches STALE only when the prospective key differs (D2)." };
  C.ACTION_EXAMPLES = {
    SCOPE:   { type: "SCOPE",   payload: { patch: { region: "Visayas", drill: [] }, seq: 17 } },
    VIEW:    { type: "VIEW",    payload: { unit: "ton", sort: { col: "gm_per_kg", dir: "desc" } } },
    DATA:    { type: "DATA",    payload: { phase: "core", key: "QTD|2026-08|Visayas|ALL||bu|pp|", seq: 17, data: "raw endpoint payload, pre-normalisation" } },
    ERROR:   { type: "ERROR",   payload: { phase: "diss", key: "QTD|2026-08|Visayas|ALL||bu|pp|", seq: 17, kind: "http", message: "API error: 504 upstream timeout" } },
    LOADING: { type: "LOADING", payload: { phase: "core", key: "QTD|2026-08|Visayas|ALL||bu|pp|", seq: 17, first: false } },
    STALE:   { type: "STALE",   payload: { key: "QTD|2026-08|Luzon|ALL||bu|pp|", label: "Luzon · All BUs · QTD" } },
    RESET:   { type: "RESET",   payload: { keepView: true } }
  };

  // ---- waterfall spec ----------------------------------------------------------------
  // Fully resolved, render-ready. The chart file draws and computes nothing.
  C.WATERFALL_SPEC_SHAPE = {
    title: "string", subtitle: "string|null", unit: "'php_per_ton'|'php'|'pp'",
    anchorStart: "{label:string,value:number}", anchorEnd: "{label:string,value:number}",
    // lever = saturated pos/neg (real action) · mix = muted (composition) ·
    // resid = the Unexplained bar, only if over tolerance · est = hatched (C12 cost split ONLY) ·
    // placeholder = a NAMED driver the wire does not carry: value null, `tag` says why (C.WATERFALL_PLACEHOLDER)
    steps: "array<{label:string,value:number|null,role:'lever'|'mix'|'resid'|'est'|'placeholder',tag?:string,drill:null|array<{label,value,role?}>}>",
    reconciles: "boolean", residual: "number", tolerance: "number",
    basisNote: "string|null",   // C.BASIS_SUFFIX.reported or .net — REQUIRED
    anchorsNote: "string|null", // 'base_month -> compare_month' — REQUIRED (C.ANCHORS)
    footnote: "string|null"
  };
  // A placeholder step is an outlined, unfilled, zero-width mark at the running
  // level, labelled with `tag` text. It NEVER carries a fabricated value, it is
  // ignored by the closure check, and it is not a "dropped driver". Use it for a
  // driver that is backend work (line discount, credit memos, settled rebates).
  C.WATERFALL_PLACEHOLDER = {
    role: "placeholder", tag: "not on the wire",
    rule: "value is null and stays null; the tag names why the wire lacks it; closure ignores the step; never draw a number for it."
  };
  // Visayas, 2026-07 -> 2026-08: 5,180 +182 -96 -41 +23 = 5,248. Residual 0.
  C.WATERFALL_EXAMPLE = {
    title: "GM/ton Bridge — 2026-07 → 2026-08",
    subtitle: "Finished feed (103) · exact Bennet (customer×SKU) · Price & Cost are real levers, Mix is composition",
    unit: "php_per_ton",
    anchorStart: { label: "Prior GM/t", value: 5180 },
    anchorEnd: { label: "Current GM/t", value: 5248 },
    steps: [
      { label: "Price", value: 182, role: "lever", drill: null },
      { label: "Cost", value: -96, role: "lever", drill: [
        { label: "Raw materials (est.)", value: -118, role: "est" },
        { label: "Packaging (est.)", value: 14, role: "est" },
        { label: "Feedtag (est.)", value: 8, role: "est" } ] },
      { label: "Customer/BU Mix", value: -41, role: "mix", drill: null },
      { label: "Product Mix", value: 23, role: "mix", drill: [
        { label: "Broiler Starter", value: 31 }, { label: "Layer Grower", value: -12 }, { label: "Swine Finisher", value: 4 } ] }
    ],
    reconciles: true, residual: 0, tolerance: 3,
    basisNote: "gross of off-invoice discount",
    anchorsNote: "2026-07 → 2026-08 (complete months)",
    footnote: "Cost split is an estimate"   // a passing closure draws NOTHING — no tick, no badge (C13)
  };

  // ---- bullet spec -------------------------------------------------------------------
  C.BULLET_SPEC_SHAPE = {
    label: "string", value: "number|null", unit: "'php_per_ton'|'php_per_kg'|'gp_pct'|'php'",
    comparator: "number|null", comparatorLabel: "string|null",
    bands: "null|{good:number,warn:number,dir:'higher-is-better'}", // null = no verified threshold
    domain: "{min:number,max:number,mode:'p95-clamp'|'banded'}",
    domainLabel: "'relative'|'absolute'",
    status: "'good'|'warn'|'bad'|'relative'"
  };
  // A relative bullet has no verdict: word AND colour both come from 'relative' (A5).
  C.BULLET_STATUS_RULE = {
    recipe: "var st = (spec.domainLabel === 'relative') ? 'relative' : spec.status; use st for BOTH the text and statusColor(st).",
    colour: "'relative' resolves to var(--mx2-mix)"
  };
  // Banded example (A8): region has verified bands, so mode is "banded" and status is real.
  C.BULLET_EXAMPLE = {
    label: "Visayas", value: 5248, unit: "php_per_ton", comparator: 5180, comparatorLabel: "Prior QTD",
    bands: { good: 5000, warn: 4000, dir: "higher-is-better" },
    domain: { min: 0, max: 6400, mode: "banded" },   // 0 .. max(good*1.25, observed max)
    domainLabel: "absolute", status: "good"
  };
  // Counter-example: a cut with NO verified bands is peer-relative and says so.
  C.BULLET_EXAMPLE_RELATIVE = {
    label: "Broiler Starter", value: 6120, unit: "php_per_ton", comparator: 5980, comparatorLabel: "Prior QTD",
    bands: null, domain: { min: 0, max: 6400, mode: "p95-clamp" }, domainLabel: "relative", status: "relative"
  };

  // ---- tuned constants, each with its why ------------------------------------------
  // TOLERANCE is a ROUNDING-DRIFT bound, not a decomposition test (C13). The
  // Bennet canonical bridge is exact by construction; the client re-sum of four
  // rounded bars and two rounded anchors can miss by up to 6 x 0.5 = 3 PHP/ton.
  // Phase A: server accepts 0.01 PHP/kg (10/t) plus 3 rounded bars -> 12 PHP/ton.
  // Gate the Unexplained bar on this bound, NEVER on reconciles===false.
  C.TOLERANCE_PHP_T = { canonical: 3, phase_a: 12 };
  C.TOLERANCE_FLOOR_PHP_T = 3;   // canonical default under the old name
  C.TOLERANCE_SLOPE = 0;         // drift scales with BAR COUNT, not driver magnitude
  C.TOLERANCE_BASIS = "rounding_drift";
  // `drivers` accepted and ignored (backward-compatible signature). kind "phase_a" for the per-kg bridge.
  C.TOLERANCE = function TOLERANCE(drivers, kind) {
    if (kind === "phase_a") return C.TOLERANCE_PHP_T.phase_a;
    return C.TOLERANCE_PHP_T.canonical;
  };
  C.MATERIALITY_PHP_T = 25;      // 0.5% of a ~5,000/t anchor: below a bar label's width and early-read noise; fold into "Other"
  C.ROW_CAP = 300;               // client RENDER cap only (rows arrive complete); layout cost past ~300; "+N more" footer
  C.ROW_CAP_NOTE = "Client render cap only. Aggregate first, cap second.";
  C.TABLE_MAX_H = 520;           // px; ~18 rows, keeps table scroll inside the panel on a 900px laptop
  C.CACHE_MAX = 8;               // 4 periods x 2 compares, or a region sweep + drills, without pinning memory
  C.CACHE_TTL_MS = 120000;       // = server cache TTL (me:933); a longer client TTL would serve older data than the server
  C.SERVER_CACHE_TTL_S = 120;
  C.STALENESS_NOTE = "meta.data_quality.snapshot_at is the only as-of and can be up to 120s behind; say 'up to 2 min'.";
  C.CUSTOMER_DEBOUNCE_MS = 450;  // v1's proven value: <350 fires per keystroke on the heaviest filter, >600 feels broken
  C.BULLET_DOMAIN = "p95-clamp"; // axis 0..p95 of peers, overflow clamped with a caret, so one PHP 19,000/t outlier cannot crush the strip
  C.BULLET_P95 = 0.95;
  C.BULLET_MODES = ["p95-clamp", "banded"];

  // BANDS: only region has thresholds that exist in the shipped app and could be
  // verified (app.html:7127 gm_ton 5000/4000; app.html:5913 gp_pct 15/10). Every
  // other cut is null ON PURPOSE and renders relative. kg is null even for region:
  // the verified numbers are per TON. Thresholds are on the REPORTED basis — never
  // apply them to net-of-discount figures.
  C.BANDS = {
    region:      { kg: null, ton: { good: 5000, warn: 4000, dir: "higher-is-better" }, gp_pct: { good: 15, warn: 10, dir: "higher-is-better" }, gp: null },
    bu:          { kg: null, ton: null, gp_pct: null, gp: null },
    dsm:         { kg: null, ton: null, gp_pct: null, gp: null },
    brand:       { kg: null, ton: null, gp_pct: null, gp: null },
    species:     { kg: null, ton: null, gp_pct: null, gp: null },
    sales_group: { kg: null, ton: null, gp_pct: null, gp: null },
    ssg:         { kg: null, ton: null, gp_pct: null, gp: null },
    customer:    { kg: null, ton: null, gp_pct: null, gp: null },
    sku:         { kg: null, ton: null, gp_pct: null, gp: null }
  };
  C.BANDS_BASIS = "reported (gross of off-invoice discount)";
  C.BAND_LABELS = { absolute: "vs target", relative: "relative" };

  // ---- trust gates: what a panel DOES with each backend signal (T1-T3 + two) ----
  C.TRUST_GATES = {
    MIX_ORDERING: { field: "mix_ordering.sign_stable", on_false: "Render Customer Mix + Product Mix as ONE 'Composition' bar valued at mix_total; show customer_range/product_range as the reason.",
      copy: "The customer / product split is not determinate for this window — the two decomposition orderings disagree in sign. Shown as a single composition effect." },
    MIX_CHURN: { field: "mix_detail.churn_dominated", on_true: "Mute the mix bars, attach the warning, never let mix be the largest labelled driver in a headline; show one_sided_share_pct and matched_kg_share_pct.",
      copy: "Most of this composition effect comes from customer x SKU cells present in only one window. That is timing, not a commercial shift." },
    SIGNIFICANCE: { field: "canonical_bridge.significance", copy: {
      unavailable: "Not enough history to say whether this move is unusual.",
      noise: "Within normal month-to-month variation.",       // demote the headline; no win/loss colour
      weak: "Larger than usual, but inside the historical range.",
      signal: null },                                          // headline it with n and the band
      format: "z 1dp, percentile whole %, band integer PHP/ton — never print the raw floats" },
    FEED_BASIS: { field: "bridge.ingredients_meta.feed_basis", copy: {
      "CmpltQty": null,
      "PlannedQty (CmpltQty unavailable)": "Per-ton figures use PLANNED production quantity — completed quantity was unavailable for this window.",
      "issued-kg proxy (no completed/planned qty)": "Per-ton denominator is an ISSUED-KG PROXY. Treat the per-ton level as indicative only." } },
    COST_ESTIMATE: { field: "cost_components.estimated", rule: "Render hatched / lighter / sub-strip, labelled 'estimated', visually distinct from the measured Price and Cost bars (C12)." },
    LENSES: { rule: "Iterate WIRE.LENS_DIMS, never Object.keys(lenses): canonical lenses.note is a string. Skip any value that is not an object with a rows array; null is a legal lens. Label lists 'top N', never 'all'." }
  };

  // ---- the Escape precedence rule ---------------------------------------------------
  // ONE document-level keydown handler, owned by the controller. Rule 3 must not
  // preventDefault or stopPropagation, or v2 swallows Escape for the whole shell.
  C.ESCAPE = {
    OWNER: "controller", SINGLE_HANDLER: true, KEY: "Escape", LEGACY_KEY: "Esc",
    PRECEDENCE: [
      { when: "drawerOpen",             action: "closeDrawer", stopPropagation: true,  preventDefault: true },
      { when: "scope.drill.length > 0", action: "popDrillOne", stopPropagation: true,  preventDefault: true },
      { when: "otherwise",              action: "none",        stopPropagation: false, preventDefault: false }
    ]
  };

  // beforeunload disqualifies the WHOLE APP from bfcache merely by being registered (A1).
  C.WINDOW_LISTENERS = { FORBIDDEN: ["beforeunload", "unload"], ALLOWED_FOR_TEARDOWN: ["pagehide"], REGISTER_IN: "mount", UNREGISTER_IN: "destroy" };

  // ---- numeric safety ----------------------------------------------------------------
  C.NUM = {
    NULL_TEXT: "—", ZERO_TEXT_EMPTY_SCOPE: "—", PESO: "₱", PER_TON: "/t", PER_KG: "/kg",
    RULE: "toNum(v) -> (v == null || v === '') ? null : (n = +v, (n === n && n !== Infinity && n !== -Infinity) ? n : null)",
    UNDEFINED_RULE: "Guard with `v == null` (loose): many wire fields are UNDEFINED, not null."
  };

  // ---- debug ring: the only diagnostic channel (A4) ----------------------------------
  C.DEBUG = {
    ENABLED: true, RING_SIZE: 200, LEVELS: ["trace", "info", "warn", "error"], CONSOLE_FORBIDDEN: true,
    PUSH_SIGNATURE: "push(level, msg, data)",                       // exactly three parameters
    API: ["push", "dump", "clear", "trace", "info", "warn", "fail"], // exported by the store on MEXP2.debug
    WRAPPER_SIGNATURE: "trace(msg, data) | info(msg, data) | warn(msg, data) | fail(msg, data)",
    CALLER_RULE: "If MEXP2.debug or the method is absent, silent no-op in try/catch. d.log / d.record do not exist."
  };

  // ---- CSS tokens: reconciled against css/mexp2.css ------------------------------------
  C.TOKENS = {
    SEMANTIC: ["--mx2-pos", "--mx2-neg", "--mx2-resid", "--mx2-mix", "--mx2-stale", "--mx2-error"],
    SEMANTIC_SOFT: ["--mx2-pos-soft", "--mx2-neg-soft", "--mx2-resid-soft", "--mx2-mix-soft", "--mx2-stale-soft", "--mx2-error-soft"],
    SEMANTIC_BORDER: ["--mx2-pos-border", "--mx2-neg-border", "--mx2-resid-border", "--mx2-mix-border", "--mx2-stale-border", "--mx2-error-border"],
    CHROME: ["--mx2-bg", "--mx2-surface", "--mx2-surface2", "--mx2-surface3", "--mx2-surface-solid", "--mx2-sunken", "--mx2-border", "--mx2-border-strong", "--mx2-divider",
             "--mx2-accent", "--mx2-accent-fg", "--mx2-accent-soft", "--mx2-accent-border", "--mx2-brand-green", "--mx2-focus", "--mx2-focus-shadow", "--mx2-skel-a", "--mx2-skel-b"],
    TEXT: ["--mx2-text", "--mx2-text2", "--mx2-text3", "--mx2-text4", "--mx2-dim"],
    CHART: ["--mx2-axis", "--mx2-axis-title", "--mx2-grid", "--mx2-grid-zero", "--mx2-legend", "--mx2-tooltip-bg", "--mx2-tooltip-fg", "--mx2-tooltip-border"],
    BULLET: ["--mx2-bullet-track", "--mx2-bullet-value", "--mx2-bullet-marker", "--mx2-band-good", "--mx2-band-warn", "--mx2-band-bad", "--mx2-band-rel"],
    LAYOUT: ["--mx2-r", "--mx2-r-sm", "--mx2-r-lg", "--mx2-gap", "--mx2-gap-sm", "--mx2-gap-xs", "--mx2-pad", "--mx2-font", "--mx2-mono", "--mx2-ease", "--mx2-table-max-h", "--mx2-z-drawer"],
    // HISTORICAL: a previous build of mexp2-charts.js read these ten names,
    // which css/mexp2.css has never defined (undefined custom properties
    // inherit, so the bars silently took the shell's lime). No js file
    // references them any more. They must STAY undefined; the build check
    // (charts-test K8) asserts no file under js/ references any of them.
    UNDEFINED_DO_NOT_USE: ["--mx2-amber", "--mx2-blue", "--mx2-cyan", "--mx2-gold", "--mx2-green", "--mx2-green2", "--mx2-grey", "--mx2-muted", "--mx2-red", "--mx2-red2"],
    ROLE_MAP: { lever_positive: "--mx2-pos", lever_negative: "--mx2-neg", mix: "--mx2-mix", resid: "--mx2-resid",
                estimated: "--mx2-mix", relative: "--mx2-mix", neutral: "--mx2-text3" },
    CHECK: "Build check: every --mx2-* referenced under js/ must appear in css/mexp2.css."
  };

  // Freezing C makes the property slots immutable; TOLERANCE and pillText stay callable.
  NS.C = deepFreeze(C);
})();
