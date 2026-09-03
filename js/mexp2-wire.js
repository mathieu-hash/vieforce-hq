/* ============================================================================
 * mexp2-wire.js — Margin Explorer v2 · THE RAW WIRE SHAPE (window.MEXP2.WIRE)
 * ----------------------------------------------------------------------------
 * Derived from the BACKEND SOURCE, not from the v1 client and not from memory:
 *   api/margin-explorer.js      @ master, SHA 8012e00 (938 lines)   -> (me:NNN)
 *   api/lib/margin_bridge_v2.js @ master, SHA 0c26611               -> (bv2)
 *   api/lib/margin_cube.js      @ master, SHA dee8422               -> (cube:fn)
 *   api/lib/margin_window.js    @ master, SHA 1efc842               -> (win:fn)
 * This file is the ONLY place the wire shape is described. Panels consume
 * MEXP2.C (mexp2-contract.js); reasoning lives in CONTRACT.md.
 *
 * FIELD LEGEND — every leaf is { t, u, dp, n, ph, ref }:
 *   t   type as it arrives         u   unit ("" = none)
 *   dp  decimals the SERVER rounds to (null = raw/unrounded, "-" = not numeric)
 *   n   nullability: "never" | condition under which it is null
 *   ph  phase(s) carrying it: "AB" always, "A" include=bridge,trend,movers,gap,
 *       "B" include=dissection            ref  backend line / function
 * "?" after a type means the KEY MAY BE ABSENT (undefined), never null.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});

  function deepFreeze(o) {
    if (o === null || typeof o !== "object") return o;
    var k;
    for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) deepFreeze(o[k]); }
    return Object.freeze(o);
  }

  var W = {};

  W.VERSION = "2.1.0";
  W.SOURCE = "api/margin-explorer.js@8012e00 + margin_bridge_v2@0c26611 + margin_cube@dee8422 + margin_window@1efc842";
  W.ENDPOINT = "margin-explorer";
  W.PHASE = { A: "bridge,trend,movers,gap", B: "dissection" };

  // ---------------------------------------------------------------------------
  // BASIS — stated once. Every peso figure that descends from `sales` is NET of
  // the line discount and GROSS of OINV.DiscSum (document-level trade discount).
  // ---------------------------------------------------------------------------
  W.BASIS = {
    SALES: "SUM(INV1.LineTotal) — net of line discount, GROSS of off-invoice discount (OINV.DiscSum). me:126, proof me:199-207 (10,555/10,555 invoices).",
    GP: "SUM(INV1.GrssProfit) — same basis as SALES, and pre-rebate (meta.data_quality.notes[0]).",
    VOLUME: "SUM(INV1.InvQty) kg, SAP base UoM. tons = kg/1000. me:127",
    DISCOUNT: "OINV.DiscSum allocated to lines pro-rata on LineTotal. me:215, me:654",
    NET_ALTERNATIVE: "discount_overlay (AB) and dissection.net_bridge (B) carry the SAME figures net of the trade discount.",
    GROSS_FIELDS: ["hero.net_sales", "hero.gross_profit", "hero.gp_pct", "hero.gm_per_kg", "matrix.*", "bridge.*", "trend.*", "dissection.canonical_bridge", "dissection.bridge", "dissection.trajectory", "dissection.category_trend", "dissection.price_drill"],
    NET_FIELDS: ["discount_overlay.gm_per_kg_net_of_discount", "discount_overlay.series[].gm_per_kg_net", "dissection.net_bridge"],
    LABEL_RULE: "Every label derived from GROSS_FIELDS must be able to carry 'gross of off-invoice discount'.",
    MISNAMED: "hero.net_sales is NOT net. bridge.prior_gp/current_gp/delta_gp are PHP PER TON, not gross profit (me:323, me:523, me:526)."
  };

  // ---------------------------------------------------------------------------
  // REQUEST PARAMS (me:61-68) — how the server normalises each one.
  // ---------------------------------------------------------------------------
  W.PARAMS = {
    period:    { t: "string", norm: "uppercased; server default 'YTD' (me:61); pp window treats anything but 7D/QTD/YTD as MTD (win:priorPeriodWindow)" },
    ref_month: { t: "string", norm: "/^\\d{4}-\\d{2}$/ honoured, else 'live' (me:62)" },
    region:    { t: "string", norm: "Luzon|Visayas|Mindanao|Other (case-insensitive), else 'ALL' (me:50)" },
    bu:        { t: "string", norm: "trimmed; 'ALL' any case = no filter (me:64)" },
    customer:  { t: "string", norm: "free text: CardCode = x OR CardName LIKE %x% (me:96); null when blank" },
    group_by:  { t: "string", norm: "one of GROUP_BYS, unknown SILENTLY -> 'sales_group' (me:39, me:66); read meta.applied_filters.group_by back" },
    compare:   { t: "string", norm: "'pp'|'ly', else 'pp' (me:67)" },
    include:   { t: "string", norm: "comma list, lower-cased, deduped; default 'bridge,trend,movers,gap' (me:68)" },
    IGNORED:   ["ssg", "scope"],
    IGNORED_NOTE: "ssg is never read; cube is called with ssg:null (me:583). Neither echoes in applied_filters."
  };
  W.GROUP_BYS = ["region", "bu", "dsm", "brand", "species", "sales_group", "ssg", "customer", "sku"];

  // ---------------------------------------------------------------------------
  // ENVELOPE (me:904-932). Keys ALWAYS present; gated blocks are null when not
  // included. Phase B is a FULL envelope: hero/discount_overlay/matrix populated.
  // ---------------------------------------------------------------------------
  W.ENVELOPE = {
    meta:             { t: "META",                       n: "never",                      ph: "AB", ref: "me:905" },
    hero:             { t: "HERO",                       n: "never",                      ph: "AB", ref: "me:924" },
    discount_overlay: { t: "DISCOUNT_OVERLAY|null",      n: "query threw or window kg<=0", ph: "AB", ref: "me:925, me:225, me:259" },
    matrix:           { t: "MATRIX",                     n: "never",                      ph: "AB", ref: "me:926" },
    bridge:           { t: "BRIDGE_A|null",              n: "null unless include=bridge",  ph: "A",  ref: "me:927" },
    trend:            { t: "TREND|null",                 n: "null unless include=trend",   ph: "A",  ref: "me:928" },
    dissection:       { t: "DISSECTION|null",            n: "null unless include=dissection", ph: "B", ref: "me:929" },
    movers:           { t: "{basis:'mix_contribution',items:[]}|null", n: "null unless include=movers; items ALWAYS []", ph: "A", ref: "me:930" },
    gap:              { t: "{available:false,note:'Phase 1: gap analysis pending'}|null", n: "null unless include=gap; available NEVER true", ph: "A", ref: "me:931" }
  };
  W.CACHE = { server_ttl_s: 120, note: "whole payload cached per scope (me:933); snapshot_at can be up to 120s stale" };

  // ---------------------------------------------------------------------------
  W.META = {
    endpoint:       { t: "'margin-explorer'", dp: "-", n: "never", ph: "AB", ref: "me:906" },
    sap_validated:  { t: "true", dp: "-", n: "never", ph: "AB", ref: "me:906 — hard-coded constant, not a verdict" },
    data_source:    { t: "'sap_b1'", dp: "-", n: "never", ph: "AB", ref: "me:906" },
    window:         { t: "{from:'YYYY-MM-DD',to:'YYYY-MM-DD'}", dp: "-", n: "never", ph: "AB", ref: "me:907 — TIMEZONE BUG (toISOString): may be one day early on UTC+8. NOT authoritative." },
    applied_filters:{ t: "{period,ref_month,region,bu,customer:string|null,group_by,compare,include:string[]}", dp: "-", n: "never", ph: "AB", ref: "me:908 — THE real scope echo; group_by reports the fallback" },
    data_quality:   { t: "{volume_basis,region_basis,bu_basis,scope_hero:'(103,105,102)',scope_dissection_bridge:'(103)',snapshot_at:ISO8601,notes:string[5]}", dp: "-", n: "never", ph: "AB", ref: "me:909-922" },
    ABSENT: ["api_version", "request_id", "generated_at"]
  };

  // ---------------------------------------------------------------------------
  W.HERO = {
    net_sales:      { t: "{value:number,delta_pct:number|null}", u: "PHP", dp: "value 0 / delta_pct 1", n: "delta_pct null when prior=0", ph: "AB", ref: "me:172-180 — GROSS of off-invoice discount" },
    gross_profit:   { t: "{value:number,delta_pct:number|null}", u: "PHP", dp: "value 0 / delta_pct 1", n: "delta_pct null when prior=0", ph: "AB", ref: "me:181" },
    gp_pct:         { t: "{value:number,delta_pp:number|null}", u: "%", dp: 1, n: "value 0 when sales<=0; delta_pp null when either sales<=0", ph: "AB", ref: "me:182" },
    gm_per_kg:      { t: "{value:number,delta:number|null}", u: "PHP/kg", dp: 2, n: "value 0 when kg<=0; delta null when prior kg=0", ph: "AB", ref: "me:183" },
    compare_basis:  { t: "'pp'|'ly'", dp: "-", n: "never", ph: "AB", ref: "me:184" },
    compare_window: { t: "{from,to,basis:string,current_last_posted?:string|null}", dp: "-", n: "never; current_last_posted key ONLY when pp (null if refine failed), ABSENT when ly", ph: "AB", ref: "me:187-189 — the explicit baseline label, built with mwin.fmt (TZ-safe)" },
    scope:          { t: "string", dp: "-", n: "never", ph: "AB", ref: "me:190 'ItmsGrpCod IN (103,105,102) — finished feed + trading-import + basemix'" },
    ly_comparable:  { t: "boolean", dp: "-", n: "never", ph: "AB", ref: "me:191 false only for compare=ly, pre-cutoff, with a region/bu/customer slice" },
    compare_note:   { t: "string|null", dp: "-", n: "null unless compare=ly and pre-cutoff", ph: "AB", ref: "me:192-196" },
    ABSENT: ["volume", "kg", "tons"],
    TONNAGE: "hero carries NO volume. Scope tonnage = SUM(matrix.rows[].kg)/1000, exact (same FROM/WHERE, me:143-144). Never SUM(rows[].tons)."
  };

  // ---------------------------------------------------------------------------
  W.DISCOUNT_OVERLAY = {
    available:                   { t: "true", dp: "-", n: "never (block is null instead)", ph: "AB", ref: "me:261" },
    discount_per_kg:             { t: "number", u: "PHP/kg", dp: 3, n: "never", ph: "AB", ref: "me:262" },
    discount_total:              { t: "number", u: "PHP", dp: 0, n: "never", ph: "AB", ref: "me:263" },
    gm_per_kg_reported:          { t: "number", u: "PHP/kg", dp: 3, n: "never", ph: "AB", ref: "me:264 — gross basis" },
    gm_per_kg_net_of_discount:   { t: "number", u: "PHP/kg", dp: 3, n: "never", ph: "AB", ref: "me:265 — THE honest figure" },
    discount_pct_of_reported_gm: { t: "number|null", u: "%", dp: 1, n: "null when reported GM/kg<=0", ph: "AB", ref: "me:266" },
    delta_reported:              { t: "number|null", u: "PHP/kg", dp: 3, n: "NULL whenever compare=ly, or prior window kg<=0", ph: "AB", ref: "me:227, me:267" },
    delta_net_of_discount:       { t: "number|null", u: "PHP/kg", dp: 3, n: "NULL whenever compare=ly, or prior window kg<=0", ph: "AB", ref: "me:268" },
    series:                      { t: "SERIES_POINT[]", dp: "-", n: "never; [] when the series query threw", ph: "AB", ref: "me:233-257 trailing 12 months, clamped to migration cutoff, months with kg=0 excluded" },
    chart_hint:                  { t: "string", dp: "-", n: "never", ph: "AB", ref: "me:270 — render as a SEPARATE panel below the headline" },
    basis:                       { t: "'OINV.DiscSum allocated to lines pro-rata on LineTotal'", dp: "-", n: "never", ph: "AB", ref: "me:271" },
    note:                        { t: "string", dp: "-", n: "never", ph: "AB", ref: "me:272" },
    SERIES_POINT: {
      month:              { t: "'YYYY-MM'", dp: "-", n: "never", ref: "me:250" },
      gm_per_kg_reported: { t: "number", u: "PHP/kg", dp: 3, n: "never (0 on kg<=0)", ref: "me:251" },
      discount_per_kg:    { t: "number", u: "PHP/kg", dp: 3, n: "never", ref: "me:252" },
      gm_per_kg_net:      { t: "number", u: "PHP/kg", dp: 3, n: "never", ref: "me:253" },
      partial:            { t: "boolean", dp: "-", n: "never (true/false on every point)", ref: "me:254 — true only for the anchor month" }
    }
  };

  // ---------------------------------------------------------------------------
  W.MATRIX = {
    group_by: { t: "string", dp: "-", n: "never", ph: "AB", ref: "me:926 — the APPLIED group_by" },
    total_gp: { t: "number", u: "PHP", dp: 0, n: "never", ph: "AB", ref: "me:131, me:926 round(SUM raw gp); differs from SUM(rows[].gp) by sub-peso rounding only" },
    rows:     { t: "MATRIX_ROW[]", dp: "-", n: "never; [] = empty scope", ph: "AB", ref: "me:124-130 NOT truncated (no TOP/LIMIT), ORDER BY gp DESC, HAVING SUM(LineTotal)<>0" },
    ROW: {
      dim:        { t: "string", dp: "-", n: "never ('(none)' when null)", ref: "me:135" },
      sales:      { t: "number", u: "PHP", dp: 0, n: "never", ref: "me:135 — GROSS of off-invoice discount" },
      kg:         { t: "number", u: "kg", dp: 0, n: "never", ref: "me:135 — THE tonnage source" },
      tons:       { t: "number", u: "MT", dp: 0, n: "never", ref: "me:135 round(kg/1000): rows under 500 kg print 0" },
      gp:         { t: "number", u: "PHP", dp: 0, n: "never", ref: "me:136" },
      gp_pct:     { t: "number", u: "%", dp: 1, n: "never — 0 when sales<=0", ref: "me:136" },
      gm_per_kg:  { t: "number", u: "PHP/kg", dp: 2, n: "never — 0 when kg<=0; test row.kg===0, not null", ref: "me:137" },
      pct_of_gp:  { t: "number", u: "%", dp: 1, n: "never — 0 when total_gp===0", ref: "me:138" },
      expandable: { t: "boolean", dp: "-", n: "never", ref: "me:138 group_by!=='sku'" }
    }
  };

  // ---------------------------------------------------------------------------
  // Phase-A bridge (me:284-548). Per-KG decomposition x1000. NO volume field.
  // ---------------------------------------------------------------------------
  W.BRIDGE_A = {
    UNAVAILABLE: { t: "{available:false,level:null,reason:string}", n: "EXACTLY 3 keys; others undefined", ref: "me:289-291 slice + cross-cutoff" },
    available:        { t: "true", dp: "-", ph: "A", ref: "me:321, me:522" },
    level:            { t: "'sku'|'ssg'", dp: "-", ph: "A", ref: "me:321 ssg = comparison crosses Jan-2026 cutoff (national only)" },
    basis:            { t: "string", dp: "-", ph: "A", ref: "me:322/522 e.g. 'vs prior period · ₱/ton'" },
    unit:             { t: "'php_per_ton'", dp: "-", ph: "A", ref: "me:322" },
    prior_gp:         { t: "number", u: "PHP/ton", dp: 0, ph: "A", ref: "me:323/523 MISNOMER: round(gm0_perkg*1000)" },
    current_gp:       { t: "number", u: "PHP/ton", dp: 0, ph: "A", ref: "me:323/523 MISNOMER" },
    delta_gp:         { t: "number", u: "PHP/ton", dp: 0, ph: "A", ref: "me:326/526 MISNOMER" },
    price:            { t: "number", u: "PHP/ton", dp: 0, ph: "A", ref: "me:324/524 SKU-blended (customer mix leaks in)" },
    mix:              { t: "number", u: "PHP/ton", dp: 0, ph: "A", ref: "me:324/524" },
    cost:             { t: "{total:number,rm?:number,packaging?:number,feedtag?:number}", u: "PHP/ton", dp: 0, ph: "A", ref: "me:325 level ssg = {total} ONLY (rm/packaging/feedtag UNDEFINED); me:525 sku = all four" },
    reconciles:       { t: "boolean", dp: "-", ph: "A", ref: "me:327/527 |price+mix+cost-delta| < 0.01 PHP/kg (= 10 PHP/ton slack), pre-rounding" },
    cogs_split:       { t: "boolean", dp: "-", ph: "A", ref: "me:328 false at ssg; me:528 true when a production ratio resolved" },
    ingredients:      { t: "INGREDIENT_A[]", dp: "-", ph: "A", ref: "me:501 top 12 by |perton_delta|; [] at ssg level or on failure" },
    ingredients_meta: { t: "INGREDIENTS_META|null", dp: "-", ph: "A", ref: "me:506 null at ssg level, when feed tons<=0, or on failure" },
    note:             { t: "string", dp: "-", ph: "A", ref: "me:329, me:529-531" },
    true_price:       { t: "number?", u: "PHP/ton", dp: 0, ph: "A", ref: "me:541 ONLY when level sku AND pair pass succeeded; else ABSENT" },
    true_cost:        { t: "number?", u: "PHP/ton", dp: 0, ph: "A", ref: "me:542" },
    customer_mix:     { t: "number?", u: "PHP/ton", dp: 0, ph: "A", ref: "me:543" },
    product_mix:      { t: "number?", u: "PHP/ton", dp: 0, ph: "A", ref: "me:544 includes the pair interaction residual" },
    true_basis:       { t: "'customer×SKU'?", dp: "-", ph: "A", ref: "me:545 U+00D7 MULTIPLICATION SIGN — test truthiness, never equality" },
    true_note:        { t: "string?", dp: "-", ph: "A", ref: "me:546" },
    ABSENT: ["volume"],
    INGREDIENT_A: {
      name:             { t: "string", dp: "-", ref: "me:489" },
      price_now:        { t: "number", u: "PHP/kg", dp: 2, n: "never (0 when not issued now)", ref: "me:490" },
      price_prior:      { t: "number|null", u: "PHP/kg", dp: 2, n: "null = not issued to production in the prior window (new ingredient)", ref: "me:491" },
      incl_now_pct:     { t: "number", u: "% of feed mass", dp: 2, n: "never", ref: "me:492" },
      incl_prior_pct:   { t: "number|null", u: "% of feed mass", dp: 2, n: "null together with price_prior", ref: "me:493" },
      perton_cost:      { t: "number", u: "PHP/ton feed", dp: 1, n: "never", ref: "me:494" },
      perton_delta:     { t: "number", u: "PHP/ton feed", dp: 1, n: "never; + = cost rose", ref: "me:495" },
      price_effect:     { t: "number", u: "PHP/ton feed", dp: 1, n: "never; 0 unless priced in BOTH windows", ref: "me:496" },
      inclusion_effect: { t: "number", u: "PHP/ton feed", dp: 1, n: "never", ref: "me:497" },
      IDENTITY: "perton_delta === price_effect + inclusion_effect within 1dp rounding (me:470-478)"
    },
    INGREDIENTS_META: {
      unit:                      { t: "'php_per_ton_of_feed'", dp: "-", ref: "me:507" },
      feed_tons_current:         { t: "number", u: "MT", dp: 0, ref: "me:508" },
      feed_tons_prior:           { t: "number", u: "MT", dp: 0, ref: "me:509" },
      feed_basis:                { t: "'CmpltQty'|'PlannedQty (CmpltQty unavailable)'|'issued-kg proxy (no completed/planned qty)'", dp: "-", ref: "me:432-434 — the per-ton DENOMINATOR; the proxy is a guess" },
      price_source:              { t: "string", dp: "-", ref: "me:511" },
      items_priced_both_windows: { t: "number", dp: 0, ref: "me:512" },
      sum_perton_delta:          { t: "number", u: "PHP/ton feed", dp: 1, ref: "me:513 sum over ALL built items, not just the top 12" },
      sum_price_effect:          { t: "number", u: "PHP/ton feed", dp: 1, ref: "me:514" },
      sum_inclusion_effect:      { t: "number", u: "PHP/ton feed", dp: 1, ref: "me:515" },
      note:                      { t: "string", dp: "-", ref: "me:516 'not reconciled to the sales-based GM/ton bridge'" }
    }
  };

  // ---------------------------------------------------------------------------
  W.TREND = {
    unit:                 { t: "'gm_per_ton'", dp: "-", ph: "A", ref: "me:552" },
    ly_comparable:        { t: "false", dp: "-", ph: "A", ref: "me:552 always false" },
    ly_suppressed_reason: { t: "'pre_2026_not_comparable'", dp: "-", ph: "A", ref: "me:552" },
    series:               { t: "{month:'YYYY-MM',gm_per_ton:number}[]", u: "PHP/ton", dp: 0, ph: "A", ref: "me:571-574 ONLY two keys per point; no partial; [] on failure; trailing 12 months clamped to cutoff; months with kg=0 excluded" }
  };

  // ---------------------------------------------------------------------------
  // DISSECTION (me:578-902). Universe: finished feed 103 (Old 103+104), credit
  // notes NETTED (cube LIVE_SQL/OLD_SQL). Anchors are a MONTH PAIR (me:591-601).
  // ---------------------------------------------------------------------------
  W.DISSECTION = {
    UNAVAILABLE:     { t: "{available:false,reason:string}", n: "EXACTLY 2 keys", ref: "me:899 no feed rows; me:901 threw" },
    available:       { t: "true", dp: "-", ph: "B", ref: "me:881" },
    scope:           { t: "'finished_feed'", dp: "-", ph: "B", ref: "me:881 — a STRING, not a scope object; real echo is meta.applied_filters" },
    basis:           { t: "'Live 103 / Old 103+104 · ₱/ton'", dp: "-", ph: "B", ref: "me:881" },
    base_month:      { t: "'YYYY-MM'", dp: "-", ph: "B", ref: "me:600 FIRST complete month in range (running PH month excluded); single month -> steps back one (me:601)" },
    compare_month:   { t: "'YYYY-MM'", dp: "-", ph: "B", ref: "me:600 LAST complete month in range" },
    compare_partial: { t: "boolean", dp: "-", ph: "B", ref: "me:886 from window meta when present, else compare_month===running month" },
    compare_days:    { t: "number|null", u: "shipping days", dp: 0, n: "null when window is null", ph: "B", ref: "me:887" },
    window:          { t: "WINDOW_META|null", dp: "-", n: "null when either anchor is pre-2026 or the drill block threw before resolving", ph: "B", ref: "me:615, me:643, me:888" },
    months:          { t: "string[]", dp: "-", ph: "B", ref: "me:888 every month in the cube, ascending" },
    trajectory:      { t: "TRAJECTORY_POINT[]", dp: "-", ph: "B", ref: "me:602 one per cube month, running month included" },
    bridge:          { t: "SSG_BRIDGE", dp: "-", ph: "B", ref: "me:890 cube:ssgBridge — legacy, has an explicit interaction residual" },
    mix_bridge:      { t: "MIX_BRIDGE", dp: "-", ph: "B", ref: "me:891 cube:mixBridge" },
    ingredients:     { t: "DISS_INGREDIENTS", dp: "-", ph: "B", ref: "me:892 cube:ingredientContribution" },
    price_drill:     { t: "PRICE_DRILL", dp: "-", ph: "B", ref: "me:893" },
    canonical_bridge:{ t: "CANONICAL_BRIDGE", dp: "-", ph: "B", ref: "me:894 gross basis" },
    net_bridge:      { t: "NET_BRIDGE", dp: "-", ph: "B", ref: "me:895 net of off-invoice discount" },
    category_trend:  { t: "CATEGORY_TREND", dp: "-", ph: "B", ref: "me:896 cube:categoryTrend" }
  };

  W.WINDOW_META = {
    base_month:                       { t: "'YYYY-MM'", dp: "-", ref: "win:resolveLikeForLike" },
    compare_month:                    { t: "'YYYY-MM'", dp: "-" },
    compare_partial:                  { t: "boolean", dp: "-" },
    like_for_like:                    { t: "boolean", dp: "-", ref: "true when complete, or base truncated to equal shipping days" },
    base_window:                      { t: "['YYYY-MM-DD','YYYY-MM-DD']", dp: "-", ref: "inclusive, mwin.fmt (TZ-safe)" },
    compare_window:                   { t: "['YYYY-MM-DD','YYYY-MM-DD']", dp: "-" },
    base_shipping_days:               { t: "number", dp: 0 },
    compare_shipping_days:            { t: "number", dp: 0 },
    compare_shipping_days_full_month: { t: "number", dp: 0 },
    month_progress_pct:               { t: "number|null", u: "%", dp: 1, n: "null when full-month shipping days = 0" },
    last_posted_date:                 { t: "'YYYY-MM-DD'", dp: "-", ref: "MAX(DocDate) in scope, never the server clock" },
    last_posted_source:               { t: "'MAX(DocDate) in scope'|'fallback: month end (probe failed)'", dp: "-" },
    note:                             { t: "string", dp: "-" }
  };

  W.TRAJECTORY_POINT = {
    month:        { t: "'YYYY-MM'", dp: "-", ref: "cube:trajectory" },
    tons:         { t: "number", u: "MT", dp: 0, n: "never" },
    rev_per_ton:  { t: "number", u: "PHP/ton", dp: 0, n: "never — 0 on zero tons" },
    gm_per_ton:   { t: "number", u: "PHP/ton", dp: 0, n: "never — 0 on zero tons" },
    cogs_per_ton: { t: "number", u: "PHP/ton", dp: 0, n: "never — EXISTS on the wire, read it, do not derive it" },
    gm_pct:       { t: "number", u: "%", dp: 1, n: "never — 0 when rev<=0" },
    partial:      { t: "true?", dp: "-", n: "key ABSENT except on the LAST point when it is the running PH month (me:603); never false" }
  };

  W.DISS_INGREDIENTS = {
    available: { t: "boolean", dp: "-", ref: "cube:ingredientContribution items.length>0" },
    items:     { t: "{name:string,contribution:number,cost_now:number,carried:boolean}[]", u: "PHP/ton feed", dp: 1, ref: "top 10 by |contribution|; + = costlier; carried = price carried from the other month" },
    net:       { t: "number", u: "PHP/ton feed", dp: 1, ref: "sum over ALL items, not just top 10" },
    note:      { t: "string", dp: "-" }
  };

  W.CATEGORY_TREND = {
    available:     { t: "boolean", dp: "-", ref: "cube:categoryTrend categories.length>0" },
    months:        { t: "string[]", dp: "-", ref: "column spine, last 12 cube months" },
    partial_month: { t: "'YYYY-MM'|null", dp: "-", n: "null unless the last column is the cube's last month" },
    categories:    { t: "{ssg:string,total_tons:number,cells:CELL[]}[]", dp: "-", ref: "sorted by total kg desc; 'UNSPEC' shown as 'Untagged'" },
    avg:           { t: "CELL[]", dp: "-", ref: "VOLUME-WEIGHTED row, one cell per month" },
    note:          { t: "string", dp: "-" },
    CELL: {
      month:  { t: "'YYYY-MM'", dp: "-" },
      gm_ton: { t: "number|null", u: "PHP/ton", dp: 0, n: "NULL on zero tons (contrast MATRIX.ROW)" },
      gm_pct: { t: "number|null", u: "%", dp: 1, n: "NULL when rev<=0 or cell absent" },
      tons:   { t: "number", u: "MT", dp: 0, n: "never" }
    }
  };

  W.SSG_BRIDGE = {
    UNAVAILABLE: { t: "{available:false,reason:string}", ref: "cube:ssgBridge" },
    available: { t: "true", dp: "-" },
    base: { t: "number", u: "PHP/ton", dp: 0 }, compare: { t: "number", u: "PHP/ton", dp: 0 },
    price: { t: "number", u: "PHP/ton", dp: 0 }, mix: { t: "number", u: "PHP/ton", dp: 0 }, cost: { t: "number", u: "PHP/ton", dp: 0 },
    interaction: { t: "number", u: "PHP/ton", dp: 0, ref: "explicit residual — this bridge is NOT exact" },
    delta: { t: "number", u: "PHP/ton", dp: 0 },
    base_month: { t: "'YYYY-MM'", dp: "-" }, compare_month: { t: "'YYYY-MM'", dp: "-" }
  };

  W.MIX_BRIDGE = {
    UNAVAILABLE: { t: "{available:false,items:[]}", ref: "cube:mixBridge — NO reason key" },
    available: { t: "true", dp: "-" },
    items: { t: "{ssg:string,contribution:number}[]", u: "PHP/ton", dp: 0, ref: "top 10 by |contribution|" },
    total: { t: "number", u: "PHP/ton", dp: 0, ref: "sum over ALL items" }
  };

  W.PRICE_DRILL = {
    UNAVAILABLE: { t: "{available:false,reason:string}", ref: "me:617 pre-2026 anchor; me:876 threw; cube:priceDrill no volume" },
    available:      { t: "true", dp: "-", ref: "me:858" },
    unit:           { t: "'php_per_ton'", dp: "-" },
    total:          { t: "number", u: "PHP/ton", dp: 0, ref: "= SSG_BRIDGE price bar term" },
    true_price:     { t: "number", u: "PHP/ton", dp: 0 },
    customer_mix:   { t: "number", u: "PHP/ton", dp: 0 },
    sku_mix:        { t: "number", u: "PHP/ton", dp: 0 },
    residual:       { t: "number", u: "PHP/ton", dp: 0, ref: "~0 by construction" },
    price_held_pct: { t: "number|null", u: "%", dp: 1, n: "null when no matched kg" },
    top_rows:       { t: "ROW[]", dp: "-", ref: "top 10 by |impact| (impact itself is NOT emitted)" },
    note:           { t: "string", dp: "-" },
    ROW: {
      ssg: { t: "string", dp: "-" }, sku: { t: "string", dp: "-" }, name: { t: "string", dp: "-" },
      tons_b: { t: "number", u: "MT", dp: 0 }, tons_c: { t: "number", u: "MT", dp: 0 },
      rev_ton_b: { t: "number", u: "PHP/ton", dp: 0 }, rev_ton_c: { t: "number", u: "PHP/ton", dp: 0 },
      true_price: { t: "number", u: "PHP/ton", dp: 0 }, customer_mix: { t: "number", u: "PHP/ton", dp: 0 },
      held_pct: { t: "number|null", u: "%", dp: 0, n: "null when no matched kg" }
    }
  };

  // ---------------------------------------------------------------------------
  // CANONICAL (gross) and NET bridges — bv2:bridgeExactGMperTon. Bennet, EXACT.
  // ---------------------------------------------------------------------------
  W.CANONICAL_BRIDGE = {
    UNAVAILABLE:     { t: "{available:false,reason:string}", n: "EXACTLY 2 keys", ref: "me:613 pre-2026 anchor; me:855 no volume" },
    available:       { t: "true", dp: "-", ref: "me:732" },
    unit:            { t: "'php_per_ton'", dp: "-" },
    scope:           { t: "'finished_feed_103'", dp: "-" },
    method:          { t: "string", dp: "-", ref: "me:733" },
    window:          { t: "WINDOW_META", dp: "-", ref: "me:734" },
    base_month:      { t: "'YYYY-MM'", dp: "-" }, compare_month: { t: "'YYYY-MM'", dp: "-" },
    compare_partial: { t: "boolean", dp: "-" },   like_for_like: { t: "boolean", dp: "-" },
    prior_gm_ton:    { t: "number", u: "PHP/ton", dp: 0, ref: "me:737" },
    current_gm_ton:  { t: "number", u: "PHP/ton", dp: 0 },
    delta:           { t: "number", u: "PHP/ton", dp: 0, ref: "me:738 EXISTS" },
    price:           { t: "number", u: "PHP/ton", dp: 0, ref: "me:739 real lever: same customer + same SKU" },
    cost:            { t: "number", u: "PHP/ton", dp: 0, ref: "sign = GP impact (cost up = negative)" },
    customer_mix:    { t: "number", u: "PHP/ton", dp: 0, ref: "me:740 composition; Shapley mean of both orderings" },
    product_mix:     { t: "number", u: "PHP/ton", dp: 0 },
    mix_total:       { t: "number", u: "PHP/ton", dp: 0, ref: "me:741 = customer_mix + product_mix pre-rounding" },
    mix_ordering:    { t: "MIX_ORDERING_FULL", dp: "-", ref: "me:744-750" },
    mix_detail:      { t: "MIX_DETAIL_FULL", dp: "-", ref: "me:753-762" },
    lenses:          { t: "LENSES_CANONICAL", dp: "-", ref: "me:765-769 — carries a `note` STRING among the lens objects" },
    cost_components: { t: "COST_COMPONENTS|null", dp: "-", n: "null when no production ratio resolved", ref: "me:771-777" },
    significance:    { t: "SIGNIFICANCE", dp: "-", ref: "me:779" },
    dropped_cells:   { t: "{prior:number,current:number,gp_prior:number,gp_current:number}", dp: null, ref: "me:780 counts are ints; gp_* are RAW floats" },
    reconciles:      { t: "boolean", dp: "-", ref: "me:781 |residual|<1e-6 on UNROUNDED values — effectively always true" },
    residual:        { t: "number", u: "PHP/ton", dp: null, ref: "me:782 RAW while every bar is rounded" },
    product_mix_by_ssg: { t: "{ssg:string,value:number}[]", u: "PHP/ton", dp: 0, ref: "me:786-788 = ssg lens rows, zero values dropped, 'UNSPEC'->'Untagged'" },
    note:            { t: "string", dp: "-", ref: "me:790-793 ends with ' WARNING: mix is churn-dominated ...' when mix_detail.churn_dominated" },
    IDENTITY: "price + cost + customer_mix + product_mix === delta, exact pre-rounding (bv2 HARD INVARIANT). Client re-sum of rounded bars may drift up to 3 PHP/ton."
  };

  W.NET_BRIDGE = {
    UNAVAILABLE:  { t: "{available:false,reason:string}", n: "EXACTLY 2 keys", ref: "me:614 'pre-2026 anchor' (also when canonical unavailable or net threw)" },
    SAME_AS_CANONICAL: ["available", "unit", "scope", "method", "window", "base_month", "compare_month", "compare_partial", "like_for_like", "prior_gm_ton", "current_gm_ton", "delta", "price", "cost", "customer_mix", "product_mix", "mix_total", "product_mix_by_ssg", "reconciles", "residual", "note"],
    mix_ordering: { t: "MIX_ORDERING_NET", dp: "-", ref: "me:817-821 NARROWER: no customer_first/product_first" },
    mix_detail:   { t: "MIX_DETAIL_NET", dp: "-", ref: "me:822-827 NARROWER: no cells_only_prior/cells_only_current" },
    lenses:       { t: "LENSES_NET", dp: "-", ref: "me:828-831 NO note key" },
    discount:     { t: "{prior_per_ton,current_per_ton,delta_per_ton,prior_total,current_total}", u: "PHP/ton and PHP", dp: 0, ref: "me:833-838 the wedge" },
    vs_reported:  { t: "{delta_reported,delta_net,gap,price_reported,price_net,price_gap}", u: "PHP/ton", dp: 0, ref: "me:839-844 gap = net - reported" },
    ABSENT: ["cost_components", "significance", "dropped_cells", "lenses.note", "mix_ordering.customer_first", "mix_ordering.product_first", "mix_detail.cells_only_prior", "mix_detail.cells_only_current"]
  };

  W.MIX_ORDERING_FULL = {
    customer_first: { t: "{customer:number,product:number}", u: "PHP/ton", dp: 0 },
    product_first:  { t: "{customer:number,product:number}", u: "PHP/ton", dp: 0 },
    customer_range: { t: "[number,number]", u: "PHP/ton", dp: 0 },
    product_range:  { t: "[number,number]", u: "PHP/ton", dp: 0 },
    sign_stable:    { t: "boolean", dp: "-", ref: "bv2: (orderA.customer>=0)===(orderB.customer>=0); FALSE => the split is a modelling artefact (T1)" }
  };
  W.MIX_ORDERING_NET = { customer_range: W.MIX_ORDERING_FULL.customer_range, product_range: W.MIX_ORDERING_FULL.product_range, sign_stable: W.MIX_ORDERING_FULL.sign_stable };

  W.MIX_DETAIL_FULL = {
    continuing:           { t: "number", u: "PHP/ton", dp: 0 },
    entering:             { t: "number", u: "PHP/ton", dp: 0 },
    exiting:              { t: "number", u: "PHP/ton", dp: 0 },
    one_sided_share_pct:  { t: "number", u: "%", dp: 1 },
    matched_kg_share_pct: { t: "number", u: "%", dp: 1 },
    cells_only_prior:     { t: "number", dp: 0, ref: "canonical only" },
    cells_only_current:   { t: "number", dp: 0, ref: "canonical only" },
    churn_dominated:      { t: "boolean", dp: "-", ref: "bv2: one_sided_share>0.4 OR matched_kg_share<0.85 (T2)" }
  };
  W.MIX_DETAIL_NET = { continuing: W.MIX_DETAIL_FULL.continuing, entering: W.MIX_DETAIL_FULL.entering, exiting: W.MIX_DETAIL_FULL.exiting, one_sided_share_pct: W.MIX_DETAIL_FULL.one_sided_share_pct, matched_kg_share_pct: W.MIX_DETAIL_FULL.matched_kg_share_pct, churn_dominated: W.MIX_DETAIL_FULL.churn_dominated };

  W.LENS_DIMS = ["ssg", "bu", "region", "customer", "sku"];
  W.LENS_ROW_CAPS = { ssg: 12, bu: 8, region: 8, customer: 15, sku: 15 };
  W.LENS = {
    total: { t: "number", u: "PHP/ton", dp: 0, ref: "me:704 over ALL rows, so listed rows do not sum to it" },
    rows:  { t: "LENS_ROW[]", dp: "-", ref: "me:705 server-truncated to LENS_ROW_CAPS, sorted by |value| desc" },
    LENS_ROW: {
      key:            { t: "string", dp: "-", ref: "SKU name / customer name / dim value" },
      value:          { t: "number", u: "PHP/ton", dp: 0 },
      share0_pct:     { t: "number", u: "%", dp: 1 },
      share1_pct:     { t: "number", u: "%", dp: 1 },
      share_shift_pp: { t: "number", u: "pp", dp: 2 },
      gm_ton0:        { t: "number|null", u: "PHP/ton", dp: 0, n: "null when absent in base window" },
      gm_ton1:        { t: "number|null", u: "PHP/ton", dp: 0, n: "null when absent in compare window" },
      tons0:          { t: "number", u: "MT", dp: 0, ref: "me:712" },
      tons1:          { t: "number", u: "MT", dp: 0 }
    }
  };
  W.LENSES_CANONICAL = { ssg: "LENS|null", bu: "LENS|null", region: "LENS|null", customer: "LENS|null", sku: "LENS|null", note: "string — NOT a lens; iterate LENS_DIMS, never Object.keys" };
  W.LENSES_NET = { ssg: "LENS|null", bu: "LENS|null", region: "LENS|null", customer: "LENS|null", sku: "LENS|null" };
  W.LENS_NULL = "a lens is null when bv2 produced no rows for that dimension (me:703)";

  W.COST_COMPONENTS = {
    rm:        { t: "number", u: "PHP/ton", dp: 0, ref: "me:772 remainder — absorbs every error in the other two" },
    packaging: { t: "number", u: "PHP/ton", dp: 0 },
    feedtag:   { t: "number", u: "PHP/ton", dp: 0 },
    estimated: { t: "true", dp: "-", ref: "me:775 always true when the block exists" },
    basis:     { t: "string", dp: "-", ref: "bv2 'production-order class ratio (OWOR/WOR1 x OITM.LastPurPrc, YTD avg) ...'" }
  };

  W.SIGNIFICANCE = {
    UNAVAILABLE: { t: "{available:false,reason:string}", ref: "me:719 'not computed'; bv2 'need >= 5 historical windows'" },
    available:  { t: "true", dp: "-" },
    n:          { t: "number", dp: 0, ref: ">= 5" },
    mean:       { t: "number", u: "PHP/ton", dp: null, ref: "RAW float" },
    sd:         { t: "number", u: "PHP/ton", dp: null, ref: "RAW float" },
    z:          { t: "number", dp: null, ref: "RAW float" },
    percentile: { t: "number", u: "0..1", dp: null, ref: "RAW float" },
    band:       { t: "[number,number]", u: "PHP/ton", dp: null, ref: "p5/p95 of historical month-pair deltas" },
    verdict:    { t: "'signal'|'weak'|'noise'", dp: "-", ref: "bv2 |z|>=2 signal, >=1 weak, else noise (T3)" }
  };

  // ---------------------------------------------------------------------------
  // TRUST SIGNALS AND UNIVERSE FACTS (T1-T5) — facts only; gates live in C.
  // ---------------------------------------------------------------------------
  W.TRUST = {
    T1_MIX_ORDERING: "mix_ordering.sign_stable === false => customer/product split is a modelling artefact (bv2 header: one month moved a bar from -251 to +3). Present on BOTH bridges.",
    T2_CHURN: "mix_detail.churn_dominated === true => backend appends 'WARNING:' to canonical_bridge.note (me:793). Present on BOTH bridges.",
    T3_SIGNIFICANCE: "canonical_bridge.significance.verdict — canonical only, raw floats.",
    T4_META_WINDOW: "meta.window uses toISOString (me:907) and can be a day early on UTC+8. Authoritative periods: hero.compare_window, dissection.window, *_bridge.window (all mwin.fmt).",
    T5_UNIVERSES: "hero/matrix/trend/bridge/discount_overlay = (103,105,102), credit notes NOT netted. dissection.* = 103 only (Old 103+104), credit notes NETTED. They do not tie out (meta.data_quality.notes[1])."
  };
  W.ANCHORS = "dissection base_month/compare_month = first and last COMPLETE months inside the selected range (running PH month excluded, me:598); a single month steps back one (me:601). A YTD selection yields Jan->last-complete-month, not YTD vs prior YTD.";
  W.LITERALS = {
    TRUE_BASIS: "customer×SKU",
    DISCOUNT_BASIS: "OINV.DiscSum allocated to lines pro-rata on LineTotal",
    HERO_SCOPE: "ItmsGrpCod IN (103,105,102) — finished feed + trading-import + basemix",
    DISS_SCOPE: "finished_feed",
    BRIDGE_SCOPE: "finished_feed_103",
    SCOPE_HERO: "(103,105,102)",
    SCOPE_DISS: "(103)"
  };

  NS.WIRE = deepFreeze(W);
})();
