/* ============================================================================
 * mexp2-store.js — Margin Explorer v2 · THE SINGLE STATE OWNER
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   1. The canonical scope -> key -> label derivation (scopeKey / scopeLabel).
 *   2. The ONE mutable state object for Margin Explorer v2, and the only
 *      reducer allowed to change it (dispatch, seven action shapes).
 *   3. THE SCOPE INVARIANT — the whole reason this file exists:
 *        (i)   the DATA/ERROR/LOADING reducers DROP any payload whose key is
 *              not the live scope key, or whose seq has been superseded.
 *              Silently, with one ring-buffer entry. This is the line that
 *              kills the v1 stale-scope leak.
 *        (ii)  viewModel() NULLS any data whose key does not match vm.key,
 *              so a leak that somehow got past (i) still cannot paint.
 *        (iii) on a SCOPE change the OUTGOING payload is captured into
 *              state.data.prev as {key,label,core,diss} and surfaces as
 *              vm.prev — a separate typed channel that can only reach the
 *              screen through renderStale(), never through render().
 *        (iv)  a VIEW action (unit, sort) can NEVER change the scope key.
 *              The key is snapshotted before and forcibly restored after.
 *        (v)   THE SEQ RULE (C.SEQ_RULE, A2): state.seq advances if and only
 *              if the scope KEY changes. A SCOPE action whose patch leaves the
 *              key unchanged is routed through the VIEW reducer and touches
 *              neither seq nor the in-flight phases. The controller reads the
 *              live seq back from get().seq after every SCOPE dispatch.
 *   4. Normalisation of the raw endpoint payload — DELEGATED to MEXP2.api's
 *      mapCore / mapDissection (D1: ONE normaliser, resolved at call time
 *      because mexp2-api.js loads after this file). vm.core / vm.diss are
 *      C5-exact: keys the wire leaves absent are UNDEFINED, never null-
 *      filled; unavailable forms carry exactly their wire keys; a block the
 *      server did not send is null. Numerics go through toNum(): no NaN, no
 *      Infinity, no "undefined" string can leave this file.
 *   5. The scope-keyed LRU response cache (C.CACHE_MAX / C.CACHE_TTL_MS).
 *   6. The panel registry, MEXP2.panel(id, def).
 *   7. The debug ring (MEXP2.debug) and its four level wrappers
 *      trace/info/warn/fail (C.DEBUG.API, A4). Every other v2 file calls
 *      those and nothing else.
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never touch the DOM. No document, no elements, no classes, no styles.
 *   - Never fetch. It has no knowledge of apiFetch, URLs or transport. The
 *     controller fetches and reports the result back as a DATA/ERROR action.
 *   - Never call console.*. The debug ring buffer is the only channel.
 *   - Never redefine, rename or extend anything in mexp2-contract.js, and
 *     never add a field to the view model that the contract does not declare.
 *   - Never touch, read or patch anything named margin-explorer*.js.
 *   - Never let a panel mutate state: get()/viewModel() hand out copies of
 *     every mutable container the caller could plausibly write to.
 *
 * BASIS (WIRE.BASIS, C2): every peso figure descending from `sales` — hero,
 * matrix, phase-A bridge, trend, canonical_bridge — is GROSS of the
 * off-invoice discount. The honest figure is discount_overlay
 * .gm_per_kg_net_of_discount, present in BOTH phases. This file carries it
 * on vm.core.discount_overlay; v1 never read it.
 *
 * EMPTY SCOPE (C1, A3): matrix.rows is never truncated and hero carries no
 * volume field, so tonnage is SUM(rows[].kg)/1000 and can never disagree
 * with the row count. ZERO ROWS IS THE WHOLE TEST. There is no data-fault
 * branch.
 *
 * REPLACES (v1, js/margin-explorer.js:436-530)
 *   scopeSig()  -> scopeKey(), which additionally encodes the drill path.
 *   LAST{...}   -> state.data + state.phase, keyed by scope key AND seq.
 *   fetchSeq    -> state.seq, still monotonic, but now checked against the
 *                  key as well, so a phase-B response can no longer outlive
 *                  its phase-A (V1_HAZARDS[3]).
 * ========================================================================= */

(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) {
    // Load-order fault, not a runtime path: mexp2-contract.js must be first.
    throw new Error("mexp2-store: mexp2-contract.js must load before this file.");
  }

  /* ==========================================================================
   * DEBUG RING BUFFER
   * The only sanctioned diagnostic channel (C.DEBUG). Cooperative: if another
   * v2 file already installed a compatible ring, reuse it rather than clobber,
   * and graft the four level wrappers onto it when they are missing (A4).
   * push(level, msg, data) has EXACTLY three parameters; the wrappers are
   * trace/info/warn/fail(msg, data). `fail` rather than `error` so it can
   * never shadow an Error inside a catch block.
   * ======================================================================= */

  // A level writer bound to a ring.
  function ringWriter(ring, level) {
    return function (msg, data) { ring.push(level, msg, data); };
  }

  // Graft trace/info/warn/fail onto a ring that lacks them. Idempotent.
  function ensureWrappers(ring) {
    if (typeof ring.trace !== "function") ring.trace = ringWriter(ring, "trace");
    if (typeof ring.info !== "function") ring.info = ringWriter(ring, "info");
    if (typeof ring.warn !== "function") ring.warn = ringWriter(ring, "warn");
    if (typeof ring.fail !== "function") ring.fail = ringWriter(ring, "error");
    return ring;
  }

  // Build a bounded ring buffer honouring C.DEBUG.RING_SIZE.
  function makeRing() {
    var buf = [];
    var ring = {
      push: function (level, msg, data) {
        if (!C.DEBUG.ENABLED) return;
        buf.push({ t: Date.now(), level: level || "trace", msg: String(msg), data: data });
        while (buf.length > C.DEBUG.RING_SIZE) buf.shift();
      },
      dump: function (level) {
        if (!level) return buf.slice();
        var out = [], i;
        for (i = 0; i < buf.length; i++) if (buf[i].level === level) out.push(buf[i]);
        return out;
      },
      clear: function () { buf.length = 0; },
      size: function () { return buf.length; }
    };
    return ensureWrappers(ring);
  }
  if (!NS.debug || typeof NS.debug.push !== "function" || typeof NS.debug.dump !== "function") {
    NS.debug = makeRing();
  } else {
    ensureWrappers(NS.debug);
  }
  var DBG = NS.debug;

  // Shorthand ring writers for this file. Never console.
  function trace(msg, data) { DBG.push("trace", msg, data); }
  function info(msg, data) { DBG.push("info", msg, data); }
  function warn(msg, data) { DBG.push("warn", msg, data); }
  var warnRing = warn;   // the un-shadowable name, for applyScopePatch(_, _, silent)
  function fail(msg, data) { DBG.push("error", msg, data); }

  /* ==========================================================================
   * PRIMITIVES
   * ======================================================================= */

  // The contract's C.NUM.RULE, implemented once. Anything that is not a finite
  // number becomes null; null renders as C.NUM.NULL_TEXT. NaN never escapes.
  function toNum(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "boolean") return null;
    var n = +v;
    if (n !== n) return null;                       // NaN
    if (n === Infinity || n === -Infinity) return null;
    return n;
  }

  // String or null. Never returns the literal "undefined".
  function toStr(v) {
    if (v === null || v === undefined) return null;
    var s = String(v);
    if (s === "undefined" || s === "null") return null;
    return s;
  }

  // Strict boolean, defaulting to false for anything absent.
  function toBool(v) { return v === true || v === "true" || v === 1; }

  // Always an array; never null, never a non-array.
  function toArr(v) { return (v && typeof v.length === "number" && typeof v !== "string") ? v : []; }

  // Always a plain object; never null.
  function toObj(v) { return (v && typeof v === "object") ? v : {}; }

  // True only for a non-null object (arrays included; callers that care test length).
  function isObj(v) { return !!v && typeof v === "object"; }

  // Own-property test that survives a hostile prototype.
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // Array of strings, nulls dropped.
  function strArr(v) {
    var a = toArr(v), out = [], i, s;
    for (i = 0; i < a.length; i++) { s = toStr(a[i]); if (s !== null) out.push(s); }
    return out;
  }

  // Exact membership test against a contract vocabulary list.
  function inList(list, v) {
    var i;
    if (v === null || v === undefined) return false;
    for (i = 0; i < list.length; i++) if (list[i] === v) return true;
    return false;
  }

  // "KEY ACCOUNTS" -> "Key Accounts". Used only for the human label.
  function titleCase(s) {
    if (!s) return "";
    return String(s).toLowerCase().replace(/(^|[\s\-\/])([a-z])/g, function (m, pre, ch) {
      return pre + ch.toUpperCase();
    });
  }

  // Strip the two key separators out of a value so a customer name containing
  // "|" cannot forge a different scope key.
  function keySafe(v) {
    return String(v).split(C.KEY_SEP).join("/").split(C.KEY_DRILL_SEP).join("/");
  }

  /* ==========================================================================
   * SCOPE: CLONE, VALIDATE, KEY, LABEL
   * ======================================================================= */

  // Deep-enough copy of a scope: drill entries and sort are new objects, so a
  // caller holding a vm.scope can never write through into store state (A7).
  function cloneScope(s) {
    s = toObj(s);
    var out = {
      period: s.period,
      refMonth: (s.refMonth === undefined) ? null : s.refMonth,
      region: s.region,
      bu: s.bu,
      customer: (s.customer === undefined) ? null : s.customer,
      groupBy: s.groupBy,
      unit: s.unit,
      compare: s.compare,
      drill: cloneDrill(s.drill),
      sort: cloneSort(s.sort)
    };
    return out;
  }

  // Copy the breadcrumb array, oldest first, dropping malformed entries.
  function cloneDrill(d) {
    var out = [], i, e;
    d = toArr(d);
    for (i = 0; i < d.length; i++) {
      e = toObj(d[i]);
      if (e.dim === undefined || e.dim === null) continue;
      out.push({
        dim: String(e.dim),
        value: (e.value === undefined || e.value === null) ? "" : String(e.value),
        label: (e.label === undefined || e.label === null) ? String(e.value == null ? "" : e.value) : String(e.label)
      });
    }
    return out;
  }

  // Copy the sort descriptor, forcing dir into the two legal values.
  function cloneSort(s) {
    s = toObj(s);
    var col = (s.col === undefined || s.col === null) ? C.DEFAULT_SCOPE.sort.col : String(s.col);
    var dir = (s.dir === "asc") ? "asc" : "desc";
    return { col: col, dir: dir };
  }

  // Apply only recognised, validated scope fields. An illegal value is ignored
  // and logged rather than allowed to poison the key.
  function applyScopePatch(scope, patch, silent) {
    var k;
    // `silent` is the preview path (previewKey): same validation, no ring
    // entries, so the api can ask "would this patch change the key?" (D2)
    // without logging every illegal value twice.
    var warn = silent ? function () {} : warnRing;
    patch = toObj(patch);
    for (k in patch) {
      if (!hasOwn(patch, k)) continue;
      switch (k) {
        case "period":
          if (inList(C.PERIODS, patch.period)) scope.period = patch.period;
          else warn("SCOPE: illegal period ignored", patch.period);
          break;
        case "refMonth":
          if (patch.refMonth === null || patch.refMonth === "" || patch.refMonth === "live") scope.refMonth = null;
          else if (/^\d{4}-\d{2}$/.test(String(patch.refMonth))) scope.refMonth = String(patch.refMonth);
          else warn("SCOPE: illegal refMonth ignored", patch.refMonth);
          break;
        case "region":
          if (inList(C.REGIONS, patch.region)) scope.region = patch.region;
          else warn("SCOPE: illegal region ignored", patch.region);
          break;
        case "bu":
          if (inList(C.BUS, patch.bu)) scope.bu = patch.bu;
          else warn("SCOPE: illegal bu ignored", patch.bu);
          break;
        case "customer":
          if (patch.customer === null || patch.customer === "") scope.customer = null;
          else scope.customer = String(patch.customer);
          break;
        case "groupBy":
          if (inList(C.GROUP_BYS, patch.groupBy)) scope.groupBy = patch.groupBy;
          else warn("SCOPE: illegal groupBy ignored", patch.groupBy);
          break;
        case "compare":
          if (inList(C.COMPARES, patch.compare)) scope.compare = patch.compare;
          else warn("SCOPE: illegal compare ignored", patch.compare);
          break;
        case "unit":
          // Display-only. Tolerated in a SCOPE patch: it is not a key field.
          if (inList(C.UNITS, patch.unit)) scope.unit = patch.unit;
          else warn("SCOPE: illegal unit ignored", patch.unit);
          break;
        case "drill":
          scope.drill = cloneDrill(patch.drill);
          break;
        case "sort":
          scope.sort = cloneSort(patch.sort);
          break;
        default:
          warn("SCOPE: unknown field ignored", k);
      }
    }
    return scope;
  }

  // Encode the breadcrumb path as "dim=value>dim=value", oldest first.
  function drillKey(drill) {
    var out = [], i, d;
    drill = toArr(drill);
    for (i = 0; i < drill.length; i++) {
      d = toObj(drill[i]);
      out.push(keySafe(d.dim == null ? "" : d.dim) + "=" + keySafe(d.value == null ? "" : d.value));
    }
    return out.join(C.KEY_DRILL_SEP);
  }

  // The canonical scope key. Exactly C.scopeKeyFields, in that order, joined by
  // C.KEY_SEP. `unit` and `sort` are deliberately absent: they are display-only
  // and must never cause a refetch or a cache miss.
  function scopeKey(scope) {
    var s = toObj(scope), parts = [], i, f, v;
    for (i = 0; i < C.scopeKeyFields.length; i++) {
      f = C.scopeKeyFields[i];
      if (f === "drill") { parts.push(drillKey(s.drill)); continue; }
      v = s[f];
      parts.push((v === null || v === undefined) ? "" : keySafe(v));
    }
    return parts.join(C.KEY_SEP);
  }

  // Human label for the scope, e.g. "Visayas · All BUs · QTD". This is what
  // renderStale() must print so a reader can see which scope the numbers on
  // screen actually belong to. Region, BU, then any customer / drill crumbs,
  // then the period (with the as-of month when one is pinned).
  function scopeLabel(scope) {
    var s = toObj(scope), parts = [], i, d, per;
    parts.push((s.region && s.region !== "ALL") ? String(s.region) : "All Regions");
    parts.push((s.bu && s.bu !== "ALL") ? titleCase(s.bu) : "All BUs");
    if (s.customer) parts.push(String(s.customer));
    d = toArr(s.drill);
    for (i = 0; i < d.length; i++) {
      if (d[i] && d[i].label) parts.push(String(d[i].label));
    }
    per = (C.LABELS.period && C.LABELS.period[s.period]) ? C.LABELS.period[s.period] : String(s.period || "");
    if (s.refMonth) per += " @ " + String(s.refMonth);
    parts.push(per);
    return parts.join(" · ");
  }

  /* ==========================================================================
   * NORMALISATION — DELEGATED to MEXP2.api (D1: ONE normaliser)
   * The raw endpoint payload is mapped by the wire mappers in mexp2-api.js
   * (mapCore / mapDissection) and by nothing else. vm.core and vm.diss are
   * therefore C5-EXACT: a key the wire leaves absent is UNDEFINED on the vm,
   * never filled with null; unavailable forms carry exactly their wire keys
   * ({available:false, reason} / {available:false, level:null, reason}); a
   * block the server did not send (include-gated, nullable overlay) is null.
   * Panels guard with `v == null` (C.NUM.UNDEFINED_RULE).
   * mexp2-api.js loads AFTER this file, so the delegate is resolved at CALL
   * time. Normalising before it has loaded is a load-order fault: reduceData
   * reports it as a PARSE error, never a silent second mapping.
   * ======================================================================= */

  // Resolve one of the api's exported mappers, or throw a load-order fault.
  function mapper(name) {
    var api = NS.api;
    if (!api || typeof api[name] !== "function") {
      throw new Error("mexp2-store: MEXP2.api." + name + " is absent — mexp2-api.js must load before data is normalised (one normaliser, D1).");
    }
    return api[name];
  }

  // The core view: WIRE.ENVELOPE minus dissection. A phase-B response is a
  // FULL envelope (C15), so this is valid for either phase; the include-gated
  // blocks (bridge/trend/movers/gap) come back null when not requested.
  // Tolerates a {data:{...}} gateway wrapper defensively.
  function normCore(rawIn) {
    var raw = toObj(rawIn);
    if (raw.matrix === undefined && raw.hero === undefined && raw.data && typeof raw.data === "object") {
      raw = raw.data;
    }
    return mapper("mapCore")(raw);
  }

  // WIRE.DISSECTION. Accepts the whole envelope ({dissection:{...}}, which is
  // what arrives) or a bare block. An envelope whose dissection is not an
  // object maps to the two-key unavailable form with an explicit reason.
  // dissection.scope is the STRING "finished_feed" (C10); anchors are a MONTH
  // PAIR (first and last COMPLETE months in range), never the selected period.
  function normDiss(rawIn) {
    var raw = toObj(rawIn);
    if (hasOwn(raw, "dissection")) {
      raw = isObj(raw.dissection) ? raw.dissection
                                  : { available: false, reason: "Dissection block absent from the response." };
    }
    return mapper("mapDissection")(raw);
  }

  /* ==========================================================================
   * STATE
   * ======================================================================= */

  // A per-phase record. status is internal ('idle'|'loading'|'ok'|'error') and
  // never leaves this file: the contract's six states are derived in viewModel.
  function newPhase() {
    return { status: "idle", key: null, seq: 0, first: true, error: null };
  }

  // A fresh store state, anchored on C.DEFAULT_SCOPE.
  function initialState() {
    var scope = cloneScope(C.DEFAULT_SCOPE);
    return {
      scope: scope,
      key: scopeKey(scope),
      label: scopeLabel(scope),
      seq: 0,
      phase: { core: newPhase(), diss: newPhase() },
      // data.core / data.diss are always {key, seq, norm, unavailable, reason}
      // so the key travels WITH the payload and can be re-checked at render.
      data: { core: null, diss: null, prev: null },
      cache: [],
      ver: 0
    };
  }

  var state = initialState();
  var subs = [];
  var vmCache = null;      // memoised viewModel, invalidated by state.ver
  var vmCacheVer = -1;

  /* ==========================================================================
   * SCOPE-KEYED LRU CACHE (C.CACHE_MAX / C.CACHE_TTL_MS)
   * ======================================================================= */

  // Find a cache entry index by scope key, or -1.
  function cacheIndex(key) {
    var i;
    for (i = 0; i < state.cache.length; i++) if (state.cache[i].key === key) return i;
    return -1;
  }

  // Store a normalised phase payload under its scope key, newest last, evicting
  // the oldest entry beyond C.CACHE_MAX.
  function cachePut(key, phase, rec) {
    var i = cacheIndex(key), e;
    if (i >= 0) {
      e = state.cache.splice(i, 1)[0];
    } else {
      e = { key: key, t: 0, core: null, diss: null };
    }
    e[phase] = rec;
    e.t = Date.now();
    state.cache.push(e);
    while (state.cache.length > C.CACHE_MAX) {
      trace("cache evict", state.cache[0].key);
      state.cache.shift();
    }
  }

  // Return a live (non-expired) cache entry for a key, or null.
  function cacheGet(key) {
    var i = cacheIndex(key);
    if (i < 0) return null;
    var e = state.cache[i];
    if ((Date.now() - e.t) > C.CACHE_TTL_MS) {
      state.cache.splice(i, 1);
      trace("cache expired", key);
      return null;
    }
    return e;
  }

  // On a scope change, paint immediately from cache when the new scope was
  // visited within the TTL. The payload keeps its ORIGINAL key, so the render
  // invariant in viewModel() still validates it.
  function hydrateFromCache() {
    var e = cacheGet(state.key);
    if (!e) return false;
    if (e.core) {
      state.data.core = e.core;
      state.phase.core = { status: "ok", key: state.key, seq: state.seq, first: false, error: null };
    }
    if (e.diss) {
      state.data.diss = e.diss;
      state.phase.diss = { status: "ok", key: state.key, seq: state.seq, first: false, error: null };
    }
    if (e.core || e.diss) { info("cache hydrate", state.key); return true; }
    return false;
  }

  /* ==========================================================================
   * REDUCERS — the seven action shapes, and nothing else.
   * ======================================================================= */

  // Promote the CURRENT scope's data into state.data.prev. Never clobbers a
  // good prev with an empty one: if the outgoing scope never landed any data,
  // the previous prev survives, which is what renderStale actually needs.
  function capturePrev(labelOverride) {
    if (!state.data.core && !state.data.diss) {
      trace("STALE skipped: nothing to promote", state.key);
      return;
    }
    state.data.prev = {
      key: state.key,
      label: labelOverride || state.label,
      core: state.data.core ? state.data.core.norm : null,
      diss: state.data.diss ? state.data.diss.norm : null
    };
    trace("prev captured", state.data.prev.key);
  }

  // SCOPE — a filter moved. Recomputes key + label, promotes outgoing data to
  // prev, clears current data, bumps the sequence so every in-flight phase of
  // the old scope is superseded.
  //
  // THE SEQ RULE (A2, C.SEQ_RULE): seq advances iff the KEY changes. When the
  // patch leaves the key unchanged, only display-only fields (unit, sort) or
  // drill captions can have moved; those are routed through the VIEW reducer,
  // seq is NOT touched, nothing is promoted to prev, nothing is cleared, and
  // every in-flight phase stays valid. A bump here orphaned valid in-flight
  // work and hung the panel in loading-first with no data, no error, no pill.
  function reduceScope(p) {
    p = toObj(p);
    var patch = toObj(p.patch);
    var before = state.key;
    var beforeLabel = state.label;           // caption of the OUTGOING scope
    var next = cloneScope(state.scope);
    applyScopePatch(next, patch);

    var after = scopeKey(next);
    if (after === before) {
      var vp = {}, routed = false;
      if (hasOwn(patch, "unit")) { vp.unit = patch.unit; routed = true; }
      if (hasOwn(patch, "sort")) { vp.sort = patch.sort; routed = true; }
      if (routed) reduceView(vp);
      if (hasOwn(patch, "drill")) {
        // Same dim=value path (the key proved it); only captions can differ.
        state.scope.drill = next.drill;
        state.label = scopeLabel(state.scope);
      }
      trace("SCOPE: key unchanged, seq not advanced", { key: after, seq: state.seq, viaView: routed });
      return;
    }

    var newSeq = toNum(p.seq);
    if (newSeq === null || newSeq <= state.seq) newSeq = state.seq + 1;

    // Promote the outgoing payload while state.key and beforeLabel still
    // describe it. Capturing after state.label is overwritten is precisely the
    // renderStale defect the contract names: Visayas numbers, Mindanao heading.
    capturePrev(beforeLabel);                // outgoing data -> vm.prev channel
    state.scope = next;
    state.seq = newSeq;
    state.label = scopeLabel(next);
    state.key = after;
    state.data.core = null;
    state.data.diss = null;
    state.phase.core = newPhase();
    state.phase.diss = newPhase();
    hydrateFromCache();
    info("SCOPE", { from: before, to: after, seq: state.seq });
  }

  // VIEW — display-only. Unit and sort are the ONLY accepted fields, and the
  // scope key is snapshotted before and forcibly restored after, so this action
  // is structurally incapable of triggering a refetch or a cache miss.
  function reduceView(p) {
    p = toObj(p);
    var keyBefore = state.key;
    var k;
    for (k in p) {
      if (!hasOwn(p, k)) continue;
      if (k === "unit") {
        if (inList(C.UNITS, p.unit)) state.scope.unit = p.unit;
        else warn("VIEW: illegal unit ignored", p.unit);
      } else if (k === "sort") {
        state.scope.sort = cloneSort(p.sort);
      } else {
        warn("VIEW: non-display field refused", k);
      }
    }
    var keyAfter = scopeKey(state.scope);
    if (keyAfter !== keyBefore) {
      // Structurally impossible while scopeKeyFields excludes unit + sort. If it
      // ever happens the invariant is broken and we refuse the change outright.
      fail("VIEW changed the scope key — reverted", { before: keyBefore, after: keyAfter });
      state.scope = cloneScope(state.scope);
    }
    state.key = keyBefore;                    // the invariant, hard-enforced
    state.label = scopeLabel(state.scope);
    trace("VIEW", { unit: state.scope.unit, sort: state.scope.sort });
  }

  // Shared gate for DATA / ERROR / LOADING. Returns true when the payload still
  // belongs to the live scope AND the live sequence. THIS IS THE INVARIANT.
  function payloadIsLive(p, actionName) {
    var seq;
    if (p.key !== state.key) {
      warn(actionName + " dropped: stale scope key", { got: p.key, live: state.key });
      return false;
    }
    seq = toNum(p.seq);
    if (seq !== null && seq !== state.seq) {
      warn(actionName + " dropped: superseded seq", { got: seq, live: state.seq });
      return false;
    }
    return true;
  }

  // The block whose `available` decides UNAVAILABLE_FOR_SCOPE for a phase: the
  // dissection block for phase B (the envelope itself has no such flag), the
  // envelope for phase A (defensive; the core envelope never carries one).
  function availabilityBlock(phase, raw) {
    var o = toObj(raw);
    if (phase === "diss" && hasOwn(o, "dissection")) return toObj(o.dissection);
    return o;
  }

  // DATA — a phase landed. Normalised, stamped with its key + seq, cached.
  function reduceData(p) {
    p = toObj(p);
    var phase = (p.phase === "diss") ? "diss" : "core";
    if (!payloadIsLive(p, "DATA(" + phase + ")")) return;

    var rec, raw = p.data, blk;
    if (raw === null || raw === undefined) {
      // A 2xx with a null body is an EMPTY_BODY error, not data.
      state.phase[phase] = {
        status: "error", key: p.key, seq: state.seq, first: false,
        error: { kind: C.ERROR_KIND.EMPTY_BODY, message: "Empty response body." }
      };
      warn("DATA(" + phase + ") empty body", p.key);
      return;
    }

    try {
      blk = availabilityBlock(phase, raw);
      rec = {
        key: p.key,
        seq: state.seq,
        norm: (phase === "core") ? normCore(raw) : normDiss(raw),
        // Top-level availability flag, kept OFF the vm block because the
        // contract's VM_SHAPE does not declare it there. Read via statusFor().
        unavailable: (blk.available === false),
        reason: toStr(blk.reason) || toStr(blk.note)
      };
    } catch (e) {
      state.phase[phase] = {
        status: "error", key: p.key, seq: state.seq, first: false,
        error: { kind: C.ERROR_KIND.PARSE, message: (e && e.message) ? e.message : "Malformed payload." }
      };
      fail("DATA(" + phase + ") normalise threw", e && e.message);
      return;
    }

    state.data[phase] = rec;
    state.phase[phase] = { status: "ok", key: p.key, seq: state.seq, first: false, error: null };
    cachePut(p.key, phase, rec);
    info("DATA(" + phase + ")", p.key);
  }

  // ERROR — a phase failed. Prior good data is left untouched; the derived
  // state degrades to a header warning rather than blanking the screen.
  function reduceError(p) {
    p = toObj(p);
    var phase = (p.phase === "diss") ? "diss" : "core";
    if (!payloadIsLive(p, "ERROR(" + phase + ")")) return;
    var kind = p.kind;
    var ok = false, k;
    for (k in C.ERROR_KIND) {
      if (hasOwn(C.ERROR_KIND, k) && C.ERROR_KIND[k] === kind) ok = true;
    }
    if (!ok) kind = C.ERROR_KIND.UNKNOWN;
    state.phase[phase] = {
      status: "error",
      key: p.key,
      seq: state.seq,
      first: !state.data[phase],
      error: { kind: kind, message: toStr(p.message) || C.STATE_COPY.errored }
    };
    warn("ERROR(" + phase + ")", { kind: kind, message: p.message });
  }

  // LOADING — a phase started. `first` decides loading-first vs loading-refresh;
  // when the payload omits it, it is derived from whether data already exists.
  function reduceLoading(p) {
    p = toObj(p);
    var phase = (p.phase === "diss") ? "diss" : "core";
    if (!payloadIsLive(p, "LOADING(" + phase + ")")) return;
    var first = (p.first === undefined) ? !state.data[phase] : toBool(p.first);
    state.phase[phase] = {
      status: "loading", key: p.key, seq: state.seq, first: first, error: null
    };
    trace("LOADING(" + phase + ")", { key: p.key, first: first });
  }

  // STALE — promote current -> prev, ahead of a scope change. The label comes
  // from the payload when supplied so the controller can caption the outgoing
  // scope exactly as it was rendered.
  function reduceStale(p) {
    p = toObj(p);
    if (p.key && p.key !== state.key) {
      warn("STALE: payload key is not the live key; promoting live data anyway",
        { got: p.key, live: state.key });
    }
    capturePrev(toStr(p.label));
  }

  // RESET — back to C.DEFAULT_SCOPE, caches dropped, in-flight superseded.
  function reduceReset(p) {
    p = toObj(p);
    var keepView = (p.keepView === undefined) ? true : toBool(p.keepView);
    var unit = state.scope.unit, sort = cloneSort(state.scope.sort);
    var seq = state.seq + 1;
    var ver = state.ver;
    state = initialState();
    state.seq = seq;
    // initialState() restarts ver at 0. Carrying the old counter forward keeps
    // it monotonic, so the memoised viewModel can never match a pre-reset
    // version number and hand a panel the vm of the scope we just dropped.
    state.ver = ver;
    vmCache = null;
    vmCacheVer = -1;
    if (keepView) {
      if (inList(C.UNITS, unit)) state.scope.unit = unit;
      state.scope.sort = sort;
    }
    info("RESET", { keepView: keepView });
  }

  /* ==========================================================================
   * DISPATCH + SUBSCRIBE
   * ======================================================================= */

  // The one entry point that may change state. Anything that is not one of the
  // seven contract actions is refused with a ring entry and no state change.
  function dispatch(action) {
    var a = toObj(action), t = a.type, p = a.payload;
    if (!inList(C.ACTION_LIST, t)) {
      warn("dispatch: unknown action refused", t);
      return viewModel();
    }
    try {
      switch (t) {
        case C.ACTION.SCOPE:   reduceScope(p);   break;
        case C.ACTION.VIEW:    reduceView(p);    break;
        case C.ACTION.DATA:    reduceData(p);    break;
        case C.ACTION.ERROR:   reduceError(p);   break;
        case C.ACTION.LOADING: reduceLoading(p); break;
        case C.ACTION.STALE:   reduceStale(p);   break;
        case C.ACTION.RESET:   reduceReset(p);   break;
      }
    } catch (e) {
      fail("reducer threw", { type: t, message: (e && e.message) ? e.message : String(e) });
    }
    state.ver++;
    notify();
    return viewModel();
  }

  // Notify subscribers with (vm, rawState). A throwing subscriber is contained:
  // one bad panel must not stop the others from repainting.
  function notify() {
    var vm = viewModel(), snap = get(), i, list = subs.slice();
    for (i = 0; i < list.length; i++) {
      try { list[i](vm, snap); }
      catch (e) { fail("subscriber threw", (e && e.message) ? e.message : String(e)); }
    }
  }

  // Register a listener. Returns the unsubscribe function; calling it twice is
  // safe and does not remove somebody else's listener.
  function subscribe(fn) {
    if (typeof fn !== "function") {
      warn("subscribe: not a function");
      return function () {};
    }
    subs.push(fn);
    var live = true;
    return function unsubscribe() {
      if (!live) return;
      live = false;
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  // Current raw state. Top level is a copy so a caller cannot swap containers
  // out from under the store; nested payloads are shared by reference and are
  // to be treated as read-only. `seq` here is what the controller must stamp
  // on every LOADING/DATA/ERROR it dispatches (read it AFTER a SCOPE).
  function get() {
    return {
      scope: cloneScope(state.scope),
      key: state.key,
      label: state.label,
      seq: state.seq,
      phase: { core: shallow(state.phase.core), diss: shallow(state.phase.diss) },
      data: { core: state.data.core, diss: state.data.diss, prev: state.data.prev },
      cacheSize: state.cache.length,
      ver: state.ver
    };
  }

  // One-level copy of a small record.
  function shallow(o) {
    var out = {}, k;
    o = toObj(o);
    for (k in o) if (hasOwn(o, k)) out[k] = o[k];
    return out;
  }

  /* ==========================================================================
   * VIEW MODEL
   * ======================================================================= */

  // Second line of defence on the invariant: return a phase's normalised data
  // ONLY when the key it was stamped with is still the live scope key.
  function liveData(phase) {
    var rec = state.data[phase];
    if (!rec) return null;
    if (rec.key !== state.key) {
      warn("viewModel nulled stale " + phase, { stamped: rec.key, live: state.key });
      return null;
    }
    return rec.norm;
  }

  // C.EMPTY_SCOPE_TEST: a 200 whose matrix.rows is empty. ZERO ROWS IS THE
  // WHOLE TEST (A3). matrix.rows is never truncated (C1) and hero carries no
  // volume, so there is no tonnage figure that could disagree with the row
  // count and no data-fault branch. Rows with kg=0 are NOT an empty scope.
  function isEmptyScope(core) {
    if (!core || !core.matrix) return false;
    var rows = core.matrix.rows;
    return !!rows && typeof rows.length === "number" && rows.length === 0;
  }

  // C.TONNAGE.source: SUM(matrix.rows[].kg) / 1000 over ALL rows — exact scope
  // tonnage, same FROM/WHERE as the hero totals. Never rows[].tons (integer
  // MT, up to 0.5 t lost per row). Null when there are no rows to sum.
  function scopeTons(core) {
    if (!core || !core.matrix) return null;
    var rows = toArr(core.matrix.rows), sum = 0, i, v, any = false;
    for (i = 0; i < rows.length; i++) {
      v = toNum(toObj(rows[i]).kg);
      if (v !== null) { sum += v; any = true; }
    }
    return any ? sum / 1000 : null;
  }

  // Collapse the internal phase records into exactly one of the six contract
  // states. Phase A (core) is what the page-level status tracks; a phase-B-only
  // condition is read per-panel through statusFor("diss").
  function deriveStatus(core) {
    var pc = state.phase.core;
    var rec = state.data.core;
    if (pc.status === "loading") {
      return core ? C.STATE.LOADING_REFRESH : C.STATE.LOADING_FIRST;
    }
    if (pc.status === "error") return C.STATE.ERRORED;
    if (!core) return C.STATE.LOADING_FIRST;   // nothing has ever painted (A6)
    if (rec && rec.unavailable) return C.STATE.UNAVAILABLE_FOR_SCOPE;
    if (isEmptyScope(core)) return C.STATE.EMPTY_SCOPE;
    return C.STATE.FRESH;
  }

  // Per-phase state, for panels bound to phase B. Same six values, same rules;
  // this is a store method and NOT a vm field, because the contract's view
  // model declares no such field and nothing here may invent one.
  function statusFor(phase) {
    phase = (phase === "diss") ? "diss" : "core";
    var ph = state.phase[phase];
    var d = liveData(phase);
    var rec = state.data[phase];
    if (ph.status === "loading") return d ? C.STATE.LOADING_REFRESH : C.STATE.LOADING_FIRST;
    if (ph.status === "error") return C.STATE.ERRORED;
    if (!d) return C.STATE.LOADING_FIRST;
    if (rec && rec.unavailable) return C.STATE.UNAVAILABLE_FOR_SCOPE;
    if (phase === "diss" && d.available === false) return C.STATE.UNAVAILABLE_FOR_SCOPE;
    if (phase === "core" && isEmptyScope(d)) return C.STATE.EMPTY_SCOPE;
    return C.STATE.FRESH;
  }

  // The error surfaced on the vm: phase A first, then phase B.
  function deriveError() {
    if (state.phase.core.error) return {
      kind: state.phase.core.error.kind, message: state.phase.core.error.message
    };
    if (state.phase.diss.error) return {
      kind: state.phase.diss.error.kind, message: state.phase.diss.error.message
    };
    return null;
  }

  // Derive the contract view model. Memoised on state.ver so a panel may call
  // it freely inside a render pass. Every mutable container handed out is a
  // copy of the store's own, except the normalised payloads, which are frozen
  // by convention (read-only) for cost reasons.
  function viewModel() {
    if (vmCacheVer === state.ver && vmCache) return vmCache;
    var core = liveData("core");
    var prev = state.data.prev;
    var vm = {
      scope: cloneScope(state.scope),
      key: state.key,
      label: state.label,
      status: deriveStatus(core),
      core: core,
      diss: liveData("diss"),
      prev: prev ? { key: prev.key, label: prev.label, core: prev.core, diss: prev.diss } : null,
      error: deriveError()
    };
    vmCache = vm;
    vmCacheVer = state.ver;
    return vm;
  }

  /* ==========================================================================
   * PANEL REGISTRY — MEXP2.panel(id, def)
   * ======================================================================= */

  var PANELS = {};

  // No-op stand-in for a lifecycle method a panel forgot to implement, so the
  // controller can call all five on every panel without guarding each call.
  function noop() {}

  // Register (two args) or look up (one arg) a panel definition. A definition
  // is either an object carrying the five lifecycle methods, or a factory
  // function returning one; missing methods are filled with no-ops and logged.
  function panel(id, def) {
    if (typeof id !== "string" || !id) { warn("panel: bad id", id); return null; }
    if (def === undefined) return PANELS[id] || null;
    if (typeof def === "function") {
      PANELS[id] = def;                       // factory; validated at create()
      info("panel registered (factory)", id);
      return def;
    }
    if (!def || typeof def !== "object") { warn("panel: bad definition", id); return null; }
    var m = C.PANEL_LIFECYCLE.methods, i, name;
    for (i = 0; i < m.length; i++) {
      name = m[i];
      if (typeof def[name] !== "function") {
        warn("panel missing lifecycle method; stubbed", { id: id, method: name });
        def[name] = noop;
      }
    }
    def.id = id;
    PANELS[id] = def;
    info("panel registered", id);
    return def;
  }

  // Instantiate a registered factory (or return the singleton object).
  panel.create = function (id) {
    var d = PANELS[id];
    if (!d) { warn("panel.create: unknown id", id); return null; }
    if (typeof d !== "function") return d;
    var inst;
    try { inst = d(); } catch (e) { fail("panel factory threw", { id: id, message: e && e.message }); return null; }
    return panel(id + ":instance", inst);
  };
  // Ids of every registered panel, in registration order.
  panel.list = function () {
    var out = [], k;
    for (k in PANELS) if (hasOwn(PANELS, k)) out.push(k);
    return out;
  };
  panel.has = function (id) { return hasOwn(PANELS, id); };
  // Test-support only: forget every registration.
  panel.clear = function () { PANELS = {}; };

  /* ==========================================================================
   * EXPORT
   * ======================================================================= */

  NS.panel = panel;
  NS.store = {
    VERSION: C.VERSION,

    // scope -> identity
    scopeKey: scopeKey,
    scopeLabel: scopeLabel,
    // The key a SCOPE patch WOULD produce, with the reducer's own validation
    // and without dispatching. The api uses it to skip STALE on a same-key
    // patch (D2). Never mutates state, never logs.
    previewKey: function (patch) { return scopeKey(applyScopePatch(cloneScope(state.scope), patch, true)); },

    // the reducer surface
    dispatch: dispatch,
    subscribe: subscribe,
    get: get,
    viewModel: viewModel,

    // shared helpers other v2 files are required to use rather than re-invent
    toNum: toNum,
    statusFor: statusFor,
    isEmptyScope: isEmptyScope,
    scopeTons: scopeTons,

    // normalisers, exposed so a panel test can build a fixture the same way
    normalizeCore: normCore,
    normalizeDiss: normDiss,

    // introspection for the test page; not used by shipping panels
    _cache: function () {
      var out = [], i;
      for (i = 0; i < state.cache.length; i++) {
        out.push({ key: state.cache[i].key, t: state.cache[i].t, hasCore: !!state.cache[i].core });
      }
      return out;
    },
    _reset: function () { state = initialState(); subs = []; vmCache = null; vmCacheVer = -1; }
  };

})();
