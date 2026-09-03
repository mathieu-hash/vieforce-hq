/* ============================================================================
 * mexp2-api.js — Margin Explorer v2 · THE KEYED FETCH LAYER + THE ADAPTER SEAM
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   1. mexpFetch(endpoint, params, signal) — a faithful replica of the shell's
 *      apiFetch() request preparation (js/api.js), plus the three things v2
 *      needs and v1 does not have: an AbortSignal, retention of the Response
 *      object, and a TYPED SessionExpired error on 401 instead of a silent
 *      `return null`.
 *   2. normalise(raw, phase) — THE SINGLE FUNCTION AWARE OF THE WIRE CONTRACT.
 *      It validates the envelope and maps it, field by field, against
 *      MEXP2.WIRE (mexp2-wire.js — derived from the backend source, not from
 *      the v1 client). Every assumption v2 makes about the endpoint lives in
 *      the MAP section below and nowhere else.
 *   3. Request keying by scope key, inflight dedupe on BOTH phases, an 8-entry
 *      LRU with a 120s TTL and stale-while-revalidate, abort on scope-key
 *      change, abort on page leave (bound in mount(), see A1), and the 450ms
 *      customer-field debounce.
 *
 * THE THESIS THIS FILE SERVES (WIRE.BASIS)
 *   Every peso figure descending from `sales` is NET of the line discount and
 *   GROSS of the document-level trade discount (OINV.DiscSum). hero.net_sales
 *   is not net. The honest figure is in EVERY response, both phases, as
 *   `discount_overlay` — gm_per_kg_reported beside gm_per_kg_net_of_discount
 *   plus a 12-month series. v1 never reads it. This file maps it on both
 *   phases so the true number can reach the screen.
 *
 * LOADING THIS FILE HAS NO OBSERVABLE EFFECT ON THE SHELL (A1)
 *   No listener, no timer, no fetch, no storage at module load. The only
 *   side effect of parsing this file is the MEXP2.api property. A registered
 *   `beforeunload` listener disqualifies the WHOLE APP from the back/forward
 *   cache merely by existing, so it is never registered at all; the page-leave
 *   abort is `pagehide`, bound in mount() and unbound in destroy()
 *   (C.WINDOW_LISTENERS).
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never mutate store state directly. It only dispatches the contract's
 *     LOADING / DATA / ERROR actions and lets the store's key+seq invariant
 *     decide what is allowed to land.
 *   - Never re-implement authentication. API_BASE and getApiHeaders() are read
 *     from the shell at call time.
 *   - Never surface an AbortError. An abort is a user changing their mind, not
 *     a failure. It is swallowed BEFORE any status dispatch.
 *   - Never call console.*. The ring buffer (MEXP2.debug) is the only channel,
 *     addressed per C.DEBUG.CALLER_RULE (silent no-op when absent).
 *   - Never touch, read or patch anything named margin-explorer*.js, and never
 *     patch window.apiFetch — v1 must keep working untouched.
 *   - Never let a malformed payload reach the screen as a thrown exception.
 *     Shape violations are DETECTED and ROUTED to unavailable-for-scope through
 *     a returned result, never through a throw that something upstream eats.
 *   - Never treat meta.window as the authoritative period (T4). It is mapped
 *     because it is on the wire; hero.compare_window and dissection.window are
 *     the periods a panel prints.
 *
 * STYLE
 *   ES5 throughout: var, function declarations, Promise chains. No async/await,
 *   no arrows, no template literals, no let/const, no spread, no destructuring.
 *
 * THEME NOTE (no CSS here, recorded so nobody copies the wrong convention)
 *   Dark is data-theme="" (the EMPTY STRING); the only truthy value is "light".
 *   Stylesheets use :root { dark } + :root[data-theme="light"] { overrides }.
 *   Never [data-theme="dark"], never prefers-color-scheme.
 * ========================================================================= */

(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) {
    // Load-order fault, not a runtime path: mexp2-contract.js must load first.
    throw new Error("mexp2-api: mexp2-contract.js must load before this file.");
  }
  // The raw wire description. Read at call time (wireDims()) so a harness that
  // loads the wire file after this one still gets the shared lens list.
  function wire() { return NS.WIRE || null; }

  /* ==========================================================================
   * DEBUG RING — C.DEBUG.CALLER_RULE
   * The store owns MEXP2.debug and exports trace/info/warn/fail on it. This
   * file never installs a ring over an existing one and never probes methods
   * that do not exist: when the ring or the wrapper is absent it falls back to
   * push(level, msg, data), and when that is absent too it is a silent no-op.
   * A standalone harness (no store) gets a private ring so dump() still works.
   * ======================================================================= */

  // Build a bounded ring buffer honouring C.DEBUG.RING_SIZE, with the four
  // wrappers the contract names. Used ONLY when no ring exists yet.
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
    ring.trace = function (msg, data) { ring.push("trace", msg, data); };
    ring.info = function (msg, data) { ring.push("info", msg, data); };
    ring.warn = function (msg, data) { ring.push("warn", msg, data); };
    ring.fail = function (msg, data) { ring.push("error", msg, data); };
    return ring;
  }
  if (!NS.debug || typeof NS.debug.push !== "function") NS.debug = makeRing();

  // Write one entry. `level` is the ring level; `wrapper` the C.DEBUG wrapper
  // name ("fail" for level "error", so a catch-block `error` is never shadowed).
  function ringWrite(level, wrapper, msg, data) {
    try {
      var d = NS.debug;
      if (!d) return;
      if (typeof d[wrapper] === "function") d[wrapper](msg, data);
      else if (typeof d.push === "function") d.push(level, msg, data);
    } catch (e) {}
  }
  function trace(msg, data) { ringWrite("trace", "trace", msg, data); }
  function info(msg, data) { ringWrite("info", "info", msg, data); }
  function warn(msg, data) { ringWrite("warn", "warn", msg, data); }
  function fail(msg, data) { ringWrite("error", "fail", msg, data); }

  /* ==========================================================================
   * SMALL PRIMITIVES
   * ======================================================================= */

  // C.NUM.RULE. Anything not finite becomes null; NaN never escapes. The store
  // exports the same rule; it is used when present so v2 has one numeric rule.
  function localToNum(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "boolean") return null;
    var n = +v;
    if (n !== n) return null;
    if (n === Infinity || n === -Infinity) return null;
    return n;
  }
  function toNum(v) {
    return (NS.store && typeof NS.store.toNum === "function") ? NS.store.toNum(v) : localToNum(v);
  }

  // True for a plain object; an Array is deliberately NOT a plain object here,
  // because "hero is an array" is exactly one of the shape faults we must catch.
  function isObj(v) {
    return !!v && typeof v === "object" && Object.prototype.toString.call(v) !== "[object Array]";
  }

  // True for a real Array.
  function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

  // Always a plain object; never null.
  function obj(v) { return isObj(v) ? v : {}; }

  // Own-property test that is safe on non-objects.
  function has(o, k) { return isObj(o) && Object.prototype.hasOwnProperty.call(o, k); }

  // Trimmed string or null; never the literal "undefined"/"null".
  function str(v) {
    if (v === null || v === undefined) return null;
    var s = String(v);
    if (s === "undefined" || s === "null" || s === "") return null;
    return s;
  }

  // Strict boolean: only a literal true is true.
  function bool(v) { return v === true; }

  // Array of non-null strings.
  function strArr(a) {
    var out = [], i, s;
    a = isArr(a) ? a : [];
    for (i = 0; i < a.length; i++) { s = str(a[i]); if (s !== null) out.push(s); }
    return out;
  }

  // Two-slot string pair (["from","to"] windows).
  function pair(a) { a = isArr(a) ? a : []; return [str(a[0]), str(a[1])]; }

  // Two-slot numeric range ([lo,hi]).
  function range(a) { a = isArr(a) ? a : []; return [toNum(a[0]), toNum(a[1])]; }

  // Monotonic-ish millisecond clock; performance.now when available.
  function nowMs() {
    try {
      if (window.performance && typeof window.performance.now === "function") {
        return window.performance.now();
      }
    } catch (e) {}
    return Date.now();
  }

  /* ==========================================================================
   * THE KEY TABLE — request parameter names and envelope key names.
   * The wire SHAPE is MEXP2.WIRE; this is only the handful of literal keys the
   * request builder and the validator address by name.
   * ======================================================================= */

  var KEYS = {
    // Request-side parameter names (WIRE.PARAMS). `ssg` and `scope` are never
    // read by the server and are never sent.
    PARAM: {
      period: "period", region: "region", bu: "bu", groupBy: "group_by",
      compare: "compare", refMonth: "ref_month", customer: "customer", include: "include"
    },
    // Response-side top-level blocks (WIRE.ENVELOPE). Phase B is the FULL
    // envelope: meta/hero/discount_overlay/matrix populated plus `dissection`.
    ENVELOPE: {
      meta: "meta", hero: "hero", discount_overlay: "discount_overlay", matrix: "matrix",
      bridge: "bridge", trend: "trend", dissection: "dissection", movers: "movers", gap: "gap"
    },
    // A defensive gateway wrapper: { data: {...} }. Not on the wire; tolerated.
    GATEWAY: "data",
    // The two fields every unavailable form carries.
    AVAILABLE: "available",
    REASON: "reason"
  };

  var LENS_DIMS_FALLBACK = ["ssg", "bu", "region", "customer", "sku"];
  function lensDims() {
    var w = wire();
    return (w && isArr(w.LENS_DIMS)) ? w.LENS_DIMS : LENS_DIMS_FALLBACK;
  }

  /* ==========================================================================
   * TYPED ERRORS
   * Every rejection this file produces carries a C.ERROR_KIND, so the caller
   * never has to sniff a message string to decide what happened.
   * ======================================================================= */

  var ABORT_KIND = "abort";   // internal only; NOT one of C.ERROR_KIND — an
                              // abort must never become a user-visible status.

  // Build a typed error. `extra` may carry status / response / url / cause.
  function mkError(kind, message, extra) {
    var e = new Error(message || "Margin Explorer request failed.");
    var k;
    e.kind = kind;
    e.mexp2 = true;
    extra = obj(extra);
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }

  // The abort error. Flagged so isAbort() never has to match on a message.
  function abortError(reason) {
    var e = mkError(ABORT_KIND, "Request aborted" + (reason ? ": " + reason : "."), {});
    e.name = "AbortError";
    e.aborted = true;
    return e;
  }

  // The 401. api.js calls logout() and returns null, which is indistinguishable
  // from "the server had nothing". v2 raises this instead and lets the
  // controller decide; nothing in v2 logs the user out as a side effect.
  function sessionExpiredError(res, url) {
    var e = mkError(C.ERROR_KIND.HTTP, "Session expired — sign in again.", {
      status: 401, response: res || null, url: url || null
    });
    e.name = "SessionExpired";
    e.sessionExpired = true;
    return e;
  }

  // True for any abort, whether ours or the platform's DOMException.
  function isAbort(e) {
    if (!e) return false;
    if (e.aborted === true) return true;
    if (e.kind === ABORT_KIND) return true;
    if (e.name === "AbortError") return true;
    if (e.code === 20) return true;                 // legacy DOMException code
    return false;
  }

  // Map an arbitrary thrown value onto one of the five C.ERROR_KIND values.
  function errorKindFor(e) {
    if (!e) return C.ERROR_KIND.UNKNOWN;
    var k = e.kind, key;
    for (key in C.ERROR_KIND) {
      if (Object.prototype.hasOwnProperty.call(C.ERROR_KIND, key) && C.ERROR_KIND[key] === k) return k;
    }
    // The mock and v1 both reject with the exact string api.js throws.
    if (e.message && /^API error:\s*\d/.test(String(e.message))) return C.ERROR_KIND.HTTP;
    if (e.name === "TypeError") return C.ERROR_KIND.NETWORK;   // fetch() threw
    if (e.name === "SyntaxError") return C.ERROR_KIND.PARSE;
    return C.ERROR_KIND.UNKNOWN;
  }

  // The message a user should see for a thrown value. Never "undefined".
  function errorMessageFor(e) {
    var m = e && e.message ? String(e.message) : "";
    if (!m) return C.STATE_COPY.errored;
    return m;
  }

  /* ==========================================================================
   * SHELL BINDINGS — API_BASE + getApiHeaders() from js/api.js
   * Read LAZILY, at call time. Binding at load time would capture whatever
   * existed when this script parsed, and the shell defines both as top-level
   * script globals whose availability depends on tag order.
   * ======================================================================= */

  // The shell's API base URL, or null when api.js has not loaded.
  function apiBase() {
    var b = null;
    try { b = window.API_BASE; } catch (e) { b = null; }
    if (typeof b === "string" && b) return b.replace(/\/+$/, "");
    return null;
  }

  // The shell's session headers. Falls back to a content-type-only header set
  // so a unit harness without api.js still exercises the request path.
  function apiHeaders() {
    var h = null;
    try {
      if (typeof window.getApiHeaders === "function") h = window.getApiHeaders();
    } catch (e) {
      warn("getApiHeaders threw; falling back to bare headers", e && e.message);
      h = null;
    }
    if (isObj(h)) return h;
    return { "Content-Type": "application/json" };
  }

  /* ==========================================================================
   * ABORT PLUMBING
   * AbortController exists everywhere this app runs, but the shim keeps the
   * layer testable in an engine without it — withAbort() then still rejects on
   * time even though fetch() itself receives no signal.
   * ======================================================================= */

  // A controller with .signal and .abort(), real or shimmed.
  function makeAbort() {
    try {
      if (typeof window.AbortController === "function") return new window.AbortController();
    } catch (e) {}
    var listeners = [];
    var signal = {
      aborted: false,
      reason: undefined,
      addEventListener: function (t, fn) { if (t === "abort") listeners.push(fn); },
      removeEventListener: function (t, fn) {
        if (t !== "abort") return;
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    };
    return {
      signal: signal,
      abort: function (reason) {
        if (signal.aborted) return;
        signal.aborted = true;
        signal.reason = reason;
        var i, list = listeners.slice();
        for (i = 0; i < list.length; i++) {
          try { list[i]({ type: "abort" }); } catch (e) { fail("abort listener threw", e && e.message); }
        }
      },
      _shim: true
    };
  }

  // Race a promise against a signal so a transport that ignores signals (the
  // mock, or an older fetch) still stops delivering the instant we abort.
  function withAbort(p, signal) {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(abortError("already aborted"));
    return new Promise(function (resolve, reject) {
      var done = false;
      function onAbort() {
        if (done) return;
        done = true;
        reject(abortError(signal.reason ? String(signal.reason) : ""));
      }
      try { signal.addEventListener("abort", onAbort); } catch (e) {}
      p.then(function (v) {
        if (done) return;
        done = true;
        try { signal.removeEventListener("abort", onAbort); } catch (e) {}
        resolve(v);
      }, function (err) {
        if (done) return;
        done = true;
        try { signal.removeEventListener("abort", onAbort); } catch (e) {}
        reject(err);
      });
    });
  }

  /* ==========================================================================
   * mexpFetch — THE REQUEST
   *
   * Parity with js/api.js apiFetch(), line for line:
   *   - strips undefined, null AND the STRINGS "undefined" / "null" from params.
   *     api.js:25-32 cites the real incident: calls fired before state init
   *     produced /api/dashboard?period=undefined and the backend silently
   *     coerced it. See QG report 2026-04-28.
   *   - appends the _t cache-buster so browser and CDN cannot answer a changed
   *     filter from a stale entry.
   *   - cache: "no-store".
   *   - rejects on non-2xx with the exact message shape
   *     'API error: <status> <body>' that v1's error path already surfaces.
   *
   * v2 additions:
   *   - an AbortSignal is honoured (and pre-checked, so an already-aborted
   *     request never leaves the building).
   *   - the Response object is RETAINED on the resolved envelope and on every
   *     HTTP error, so a caller can read headers / status without a re-fetch.
   *   - 401 rejects with a typed SessionExpired error instead of api.js's
   *     silent `logout(); return null`.
   *
   * Resolves with an ENVELOPE: { ok, status, response, url, ms, body }.
   * Always returns a Promise; never throws synchronously.
   * ======================================================================= */

  function mexpFetch(endpoint, params, signal) {
    var base = apiBase();
    if (!base) {
      return Promise.reject(mkError(C.ERROR_KIND.UNKNOWN,
        "Margin Explorer cannot reach the API: the shell's API_BASE is unavailable.", {}));
    }
    if (signal && signal.aborted) return Promise.reject(abortError("pre-flight"));

    params = params || {};
    // See the docblock above: undefined, null, "undefined" and "null" all go.
    var clean = {}, k, v;
    for (k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      v = params[k];
      if (v !== undefined && v !== null && v !== "undefined" && v !== "null") clean[k] = v;
    }
    clean._t = Date.now();

    var qs = "";
    try { qs = new window.URLSearchParams(clean).toString(); }
    catch (e) { qs = manualQuery(clean); }
    var url = base + "/" + endpoint + (qs ? "?" + qs : "");

    var init = { headers: apiHeaders(), cache: "no-store" };
    if (signal) init.signal = signal;

    trace("fetch ->", { endpoint: endpoint, params: params });
    var t0 = nowMs();

    var started;
    try { started = Promise.resolve(window.fetch(url, init)); }
    catch (e0) { started = Promise.reject(e0); }

    return started.then(null, function (e) {
      if (isAbort(e)) throw abortError("transport");
      throw mkError(C.ERROR_KIND.NETWORK,
        "Network error: " + (e && e.message ? e.message : "request failed."),
        { url: url, cause: e });
    }).then(function (res) {
      var ms = Math.round(nowMs() - t0);
      trace("fetch <-", { endpoint: endpoint, status: res.status, ms: ms });

      if (res.status === 401) {
        warn("401 — session invalid", endpoint);
        throw sessionExpiredError(res, url);
      }

      if (!res.ok) {
        return Promise.resolve().then(function () { return res.text(); })
          .then(null, function () { return ""; })
          .then(function (body) {
            throw mkError(C.ERROR_KIND.HTTP, "API error: " + res.status + " " + body,
              { status: res.status, response: res, url: url, ms: ms });
          });
      }

      return Promise.resolve().then(function () { return res.json(); }).then(function (parsed) {
        return { ok: true, status: res.status, response: res, url: url, ms: ms, body: parsed };
      }, function (e3) {
        throw mkError(C.ERROR_KIND.PARSE,
          "Malformed response: the server returned a body that is not JSON.",
          { status: res.status, response: res, url: url, ms: ms, cause: e3 });
      });
    });
  }

  // URLSearchParams stand-in for an engine that lacks it. Same encoding rules.
  function manualQuery(o) {
    var out = [], k;
    for (k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      out.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(o[k])));
    }
    return out.join("&");
  }

  /* ==========================================================================
   * PARAMS — scope -> wire (WIRE.PARAMS)
   * ======================================================================= */

  // Build the endpoint params for one phase from a v2 scope. Drill crumbs whose
  // dim is a real filter (C.DRILL_FILTER) collapse into that filter; any other
  // crumb is a display-level drill only and is deliberately NOT invented as a
  // query parameter — the server reads exactly the eight names in KEYS.PARAM
  // and silently ignores the rest (WIRE.PARAMS.IGNORED).
  function paramsFor(scope, phase) {
    var s = obj(scope), p = {}, i, d, target;
    p[KEYS.PARAM.period] = s.period || C.DEFAULT_SCOPE.period;
    p[KEYS.PARAM.region] = s.region || "ALL";
    p[KEYS.PARAM.bu] = s.bu || "ALL";
    p[KEYS.PARAM.groupBy] = s.groupBy || C.DEFAULT_SCOPE.groupBy;
    p[KEYS.PARAM.compare] = s.compare || C.DEFAULT_SCOPE.compare;
    if (s.refMonth) p[KEYS.PARAM.refMonth] = s.refMonth;
    if (s.customer) p[KEYS.PARAM.customer] = s.customer;

    var drill = isArr(s.drill) ? s.drill : [];
    for (i = 0; i < drill.length; i++) {
      d = obj(drill[i]);
      target = C.DRILL_FILTER[d.dim];
      if (!target) { trace("drill crumb has no wire filter; not sent", d.dim); continue; }
      if (target === "region") p[KEYS.PARAM.region] = String(d.value);
      else if (target === "bu") p[KEYS.PARAM.bu] = String(d.value);
      else if (target === "customer") p[KEYS.PARAM.customer] = String(d.value);
    }

    p[KEYS.PARAM.include] = (phase === "diss") ? C.INCLUDE_DISS : C.INCLUDE_CORE;
    return p;
  }

  /* ==========================================================================
   * THE MAP — raw wire -> normalised wire shape, against MEXP2.WIRE
   *
   * Rules, stated once:
   *   - Numerics go through toNum(); nothing is re-rounded (the server already
   *     rounded to the dp in WIRE, and re-rounding invents precision).
   *   - A block that is NULL on the wire stays null. A block that is an
   *     unavailable form comes out as EXACTLY that form: canonical/net bridge
   *     and dissection {available:false, reason}; phase-A bridge
   *     {available:false, level:null, reason}; mix_bridge {available:false,
   *     items:[]} (C5). Nothing else is added to those objects.
   *   - Keys the wire leaves ABSENT stay absent (undefined, never null):
   *     trajectory[].partial, hero.compare_window.current_last_posted,
   *     bridge.cost.rm/packaging/feedtag at ssg level, bridge.true_*, and
   *     net_bridge's narrower blocks. Panels guard with `== null`.
   *   - Anything the wire says never happens but a payload does anyway is an
   *     OFF-WIRE oddity: mapped as safely as possible and recorded once in
   *     ctx.warnings, which surface on the normalise() result. It is never a
   *     throw and never silently invented data.
   *   - The map never reads meta.window for anything (T4).
   * ======================================================================= */

  // Record one off-wire warning per code per payload.
  function oddity(ctx, code, msg) {
    if (!ctx || ctx.seen[code]) return;
    ctx.seen[code] = 1;
    ctx.warnings.push(msg);
  }
  function newCtx() { return { warnings: [], seen: {} }; }

  // The minimal unavailable form. `withLevel` adds level:null (phase-A bridge).
  function unavailableForm(raw, withLevel) {
    var out = { available: false };
    if (withLevel) out.level = null;
    out.reason = str(obj(raw).reason);
    return out;
  }

  // ---- meta (WIRE.META, C22) -----------------------------------------------

  function mapMeta(raw, ctx) {
    var m = obj(raw), w = obj(m.window), af = m.applied_filters, dq = m.data_quality;
    var out = {
      endpoint: str(m.endpoint),
      sap_validated: bool(m.sap_validated),   // a hard-coded constant, not a verdict
      data_source: str(m.data_source),
      // T4: toISOString() bug — may be one day early on UTC+8. Mapped because
      // it is on the wire; NEVER the period a panel prints.
      window: (str(w.from) && str(w.to)) ? { from: str(w.from), to: str(w.to) } : null,
      applied_filters: null,
      data_quality: null
    };
    if (isObj(af)) {
      out.applied_filters = {
        period: str(af.period), ref_month: str(af.ref_month), region: str(af.region),
        bu: str(af.bu), customer: str(af.customer), group_by: str(af.group_by),
        compare: str(af.compare), include: strArr(af.include)
      };
    } else {
      oddity(ctx, "meta.applied_filters", "meta.applied_filters absent — the applied group_by fallback cannot be read back (C22)");
    }
    if (isObj(dq)) {
      out.data_quality = {
        volume_basis: str(dq.volume_basis), region_basis: str(dq.region_basis), bu_basis: str(dq.bu_basis),
        scope_hero: str(dq.scope_hero), scope_dissection_bridge: str(dq.scope_dissection_bridge),
        snapshot_at: str(dq.snapshot_at), notes: strArr(dq.notes)
      };
    } else {
      oddity(ctx, "meta.data_quality", "meta.data_quality absent — snapshot_at (the only as-of) is unavailable (C22)");
    }
    return out;
  }

  // ---- hero (WIRE.HERO, C2, C14) ---------------------------------------------

  function mapTile(raw, deltaKey) {
    var t = obj(raw), out = { value: toNum(t.value) };
    out[deltaKey] = toNum(t[deltaKey]);
    return out;
  }

  function mapHero(raw, ctx) {
    var h = obj(raw), cw = h.compare_window, out;
    if (!isObj(raw)) oddity(ctx, "hero", "hero absent — KPI tiles will render as em dashes");
    out = {
      // GROSS of the off-invoice discount — every label carries C.BASIS_SUFFIX.reported.
      net_sales: mapTile(h.net_sales, "delta_pct"),
      gross_profit: mapTile(h.gross_profit, "delta_pct"),
      gp_pct: mapTile(h.gp_pct, "delta_pp"),
      gm_per_kg: mapTile(h.gm_per_kg, "delta"),
      compare_basis: str(h.compare_basis),
      compare_window: null,
      scope: str(h.scope),
      ly_comparable: (h.ly_comparable === false) ? false : true,
      compare_note: str(h.compare_note)
    };
    if (isObj(cw)) {
      // The explicit baseline label (C14). current_last_posted: key present
      // only when compare=pp (null if the refine failed), ABSENT when ly.
      out.compare_window = { from: str(cw.from), to: str(cw.to), basis: str(cw.basis) };
      if (has(cw, "current_last_posted")) out.compare_window.current_last_posted = str(cw.current_last_posted);
    } else if (isObj(raw)) {
      oddity(ctx, "hero.compare_window", "hero.compare_window absent — the baseline label cannot be rendered (C14)");
    }
    return out;
  }

  // ---- discount_overlay (WIRE.DISCOUNT_OVERLAY, C3 — THE THESIS) ---------------

  function mapOverlayPoint(raw) {
    var p = obj(raw);
    return {
      month: str(p.month),
      gm_per_kg_reported: toNum(p.gm_per_kg_reported),
      discount_per_kg: toNum(p.discount_per_kg),
      gm_per_kg_net: toNum(p.gm_per_kg_net),
      partial: bool(p.partial)
    };
  }

  function mapOverlay(raw, ctx) {
    if (raw === null || raw === undefined) return null;   // query threw or window kg<=0
    if (!isObj(raw)) { oddity(ctx, "overlay.type", "discount_overlay is not an object — dropped"); return null; }
    if (raw.available === false) {
      // The wire never emits this form (the block is null instead); the closest
      // honest mapping is the wire's own "not available" value.
      oddity(ctx, "overlay.avail", "discount_overlay.available:false is not a wire form — treated as null");
      return null;
    }
    var s = isArr(raw.series) ? raw.series : [], series = [], i;
    for (i = 0; i < s.length; i++) series.push(mapOverlayPoint(s[i]));
    return {
      available: true,
      discount_per_kg: toNum(raw.discount_per_kg),
      discount_total: toNum(raw.discount_total),
      gm_per_kg_reported: toNum(raw.gm_per_kg_reported),
      gm_per_kg_net_of_discount: toNum(raw.gm_per_kg_net_of_discount),   // the honest figure
      discount_pct_of_reported_gm: toNum(raw.discount_pct_of_reported_gm),
      delta_reported: toNum(raw.delta_reported),                 // null whenever compare=ly
      delta_net_of_discount: toNum(raw.delta_net_of_discount),   // null whenever compare=ly
      series: series,
      chart_hint: str(raw.chart_hint),
      basis: str(raw.basis),
      note: str(raw.note)
    };
  }

  // ---- matrix (WIRE.MATRIX, C1, C6) --------------------------------------------

  function mapMatrixRow(raw, totalGp, ctx) {
    var r = obj(raw);
    var kg = toNum(r.kg), sales = toNum(r.sales);
    var out = {
      dim: (r.dim === null || r.dim === undefined) ? "(none)" : String(r.dim),
      sales: sales,                       // GROSS of off-invoice discount
      kg: kg,                             // THE tonnage source
      tons: toNum(r.tons),                // round(kg/1000), integer MT — never summed
      gp: toNum(r.gp),
      gp_pct: toNum(r.gp_pct),
      gm_per_kg: toNum(r.gm_per_kg),
      pct_of_gp: toNum(r.pct_of_gp),
      expandable: bool(r.expandable)
    };
    // C6: the server emits 0, never null, on a zero-tonnage / zero-sales row.
    // A null here is off-wire; it is coerced to the value the server would
    // have sent, and recorded, so a panel testing row.kg === 0 keeps working.
    if (out.gm_per_kg === null && kg !== null && kg <= 0) { out.gm_per_kg = 0; oddity(ctx, "row.null0", "matrix row carried null on a zero-tonnage row — coerced to 0 (C6: the wire never sends null here; test row.kg === 0)"); }
    if (out.gp_pct === null && sales !== null && sales <= 0) { out.gp_pct = 0; oddity(ctx, "row.null0", "matrix row carried null on a zero-tonnage row — coerced to 0 (C6)"); }
    if (out.pct_of_gp === null && totalGp === 0) out.pct_of_gp = 0;
    return out;
  }

  function mapMatrix(raw, ctx) {
    var m = obj(raw), rows = isArr(m.rows) ? m.rows : [], out = [], i;
    var totalGp = toNum(m.total_gp);
    for (i = 0; i < rows.length; i++) out.push(mapMatrixRow(rows[i], totalGp, ctx));
    // rows are NOT truncated on the wire (no TOP/LIMIT): [] really is an
    // empty scope, and total_gp differs from SUM(rows[].gp) by sub-peso
    // rounding only. Neither is a truncation signal.
    return { group_by: str(m.group_by), total_gp: totalGp, rows: out };
  }

  // SUM(rows[].kg)/1000 — the exact scope tonnage. hero carries no volume, and
  // rows[].tons is an integer that loses up to 0.5 t per row (C1, C.TONNAGE).
  function tonnageOf(matrix) {
    var m = obj(matrix), rows = isArr(m.rows) ? m.rows : [], i, v, kg = 0;
    for (i = 0; i < rows.length; i++) {
      v = toNum(obj(rows[i]).kg);
      if (v !== null) kg += v;
    }
    return { rows: rows.length, kg: kg, tons: kg / 1000 };
  }

  // ---- phase-A bridge (WIRE.BRIDGE_A, C5, C7, C20, C21, C23) ---------------------

  function mapIngredientA(raw) {
    var r = obj(raw);
    return {
      name: (r.name === null || r.name === undefined) ? "" : String(r.name),
      price_now: toNum(r.price_now),            // PHP/kg 2dp
      price_prior: toNum(r.price_prior),        // null = not issued in the prior window
      incl_now_pct: toNum(r.incl_now_pct),
      incl_prior_pct: toNum(r.incl_prior_pct),  // null together with price_prior
      perton_cost: toNum(r.perton_cost),        // PHP/ton feed 1dp
      perton_delta: toNum(r.perton_delta),      // === price_effect + inclusion_effect
      price_effect: toNum(r.price_effect),
      inclusion_effect: toNum(r.inclusion_effect)
    };
  }

  // The ten fields of ingredients_meta (C20). feed_basis names the per-ton
  // DENOMINATOR; "issued-kg proxy ..." means it is a guess (C.TRUST_GATES.FEED_BASIS).
  function mapIngredientsMeta(raw) {
    if (!isObj(raw)) return null;
    return {
      unit: str(raw.unit),
      feed_tons_current: toNum(raw.feed_tons_current),
      feed_tons_prior: toNum(raw.feed_tons_prior),
      feed_basis: str(raw.feed_basis),
      price_source: str(raw.price_source),
      items_priced_both_windows: toNum(raw.items_priced_both_windows),
      sum_perton_delta: toNum(raw.sum_perton_delta),
      sum_price_effect: toNum(raw.sum_price_effect),
      sum_inclusion_effect: toNum(raw.sum_inclusion_effect),
      note: str(raw.note)
    };
  }

  function mapBridgeA(raw, ctx) {
    if (raw === null || raw === undefined) return null;    // not included
    if (!isObj(raw)) { oddity(ctx, "bridge.type", "bridge is not an object — treated as unavailable"); return { available: false, level: null, reason: null }; }
    if (raw.available !== true) return unavailableForm(raw, true);   // EXACTLY 3 keys (C5)

    var ing = isArr(raw.ingredients) ? raw.ingredients : [], items = [], i;
    for (i = 0; i < ing.length; i++) items.push(mapIngredientA(ing[i]));
    var rc = obj(raw.cost), cost = { total: toNum(rc.total) };
    // sku level carries all four; ssg level carries {total} ONLY (C21).
    if (has(rc, "rm")) cost.rm = toNum(rc.rm);
    if (has(rc, "packaging")) cost.packaging = toNum(rc.packaging);
    if (has(rc, "feedtag")) cost.feedtag = toNum(rc.feedtag);

    var out = {
      available: true,
      level: str(raw.level),                   // 'sku' | 'ssg'
      basis: str(raw.basis),
      unit: str(raw.unit),                     // 'php_per_ton'
      // MISNOMER (C7): these three are PHP PER TON — round(gm_perkg*1000) —
      // unit margins, never gross-profit totals.
      prior_gp: toNum(raw.prior_gp),
      current_gp: toNum(raw.current_gp),
      delta_gp: toNum(raw.delta_gp),
      price: toNum(raw.price),                 // SKU-blended; customer mix leaks in
      mix: toNum(raw.mix),
      cost: cost,
      reconciles: bool(raw.reconciles),
      cogs_split: bool(raw.cogs_split),
      ingredients: items,
      ingredients_meta: mapIngredientsMeta(raw.ingredients_meta),
      note: str(raw.note)
    };
    if (!has(raw, "delta_gp")) oddity(ctx, "bridge.delta_gp", "bridge.delta_gp absent (WIRE.BRIDGE_A) — left null, not derived");
    // Present ONLY when level sku AND the customer x SKU pair pass succeeded.
    // true_basis is 'customer×SKU' with U+00D7 (C23): copied verbatim, never
    // compared by equality.
    if (has(raw, "true_price")) out.true_price = toNum(raw.true_price);
    if (has(raw, "true_cost")) out.true_cost = toNum(raw.true_cost);
    if (has(raw, "customer_mix")) out.customer_mix = toNum(raw.customer_mix);
    if (has(raw, "product_mix")) out.product_mix = toNum(raw.product_mix);
    if (has(raw, "true_basis")) out.true_basis = str(raw.true_basis);
    if (has(raw, "true_note")) out.true_note = str(raw.true_note);
    return out;
  }

  // ---- trend (WIRE.TREND, C8) ----------------------------------------------------

  function mapTrend(raw, ctx) {
    if (raw === null || raw === undefined) return null;
    if (!isObj(raw)) { oddity(ctx, "trend.type", "trend is not an object — dropped"); return null; }
    var s = isArr(raw.series) ? raw.series : [], series = [], i, p, month;
    for (i = 0; i < s.length; i++) {
      p = obj(s[i]);
      month = str(p.month);
      if (month === null) oddity(ctx, "trend.month", "trend point without `month` — the wire carries {month, gm_per_ton} only; no aliases are read (C8)");
      series.push({ month: month, gm_per_ton: toNum(p.gm_per_ton) });
    }
    return {
      unit: str(raw.unit) || "gm_per_ton",
      ly_comparable: bool(raw.ly_comparable),          // always false on the wire
      ly_suppressed_reason: str(raw.ly_suppressed_reason),
      series: series
    };
  }

  // ---- movers / gap (C9) ------------------------------------------------------------

  function mapMovers(raw, ctx) {
    if (raw === null || raw === undefined) return null;
    if (!isObj(raw)) { oddity(ctx, "movers.type", "movers is not an object — dropped"); return null; }
    var items = isArr(raw.items) ? raw.items.slice() : [];
    if (items.length) oddity(ctx, "movers.items", "movers.items is non-empty — the wire always emits [] (C9)");
    return { basis: str(raw.basis), items: items };
  }

  function mapGap(raw, ctx) {
    if (raw === null || raw === undefined) return null;
    if (!isObj(raw)) { oddity(ctx, "gap.type", "gap is not an object — dropped"); return null; }
    if (raw.available === true) oddity(ctx, "gap.avail", "gap.available is true — the wire never produces it (C9)");
    return { available: bool(raw.available), note: str(raw.note) };
  }

  // ---- the phase-A / phase-B envelope minus dissection ------------------------------

  function mapCore(body, ctx) {
    var b = obj(body);
    var out = {
      meta: mapMeta(b.meta, ctx),
      hero: mapHero(b.hero, ctx),
      discount_overlay: mapOverlay(b.discount_overlay, ctx),
      matrix: mapMatrix(b.matrix, ctx),
      bridge: mapBridgeA(b.bridge, ctx),
      trend: mapTrend(b.trend, ctx),
      movers: mapMovers(b.movers, ctx),
      gap: mapGap(b.gap, ctx)
    };
    // matrix.group_by is the APPLIED group_by; the applied_filters echo is the
    // same value and stands in when a fixture forgot it.
    if (out.matrix.group_by === null && out.meta.applied_filters && out.meta.applied_filters.group_by) {
      out.matrix.group_by = out.meta.applied_filters.group_by;
    }
    if (!has(b, "discount_overlay")) oddity(ctx, "overlay.absent", "discount_overlay key absent — the honest GM/kg cannot be shown (C3: the wire carries it on both phases)");
    return out;
  }

  // ---- dissection sub-blocks (WIRE.DISSECTION and friends) ----------------------------

  // win:meta — the like-for-like proof (WIRE.WINDOW_META). Null on the wire
  // when either anchor is pre-2026 or the drill block threw.
  function mapWindowMeta(raw) {
    if (!isObj(raw)) return null;
    return {
      base_month: str(raw.base_month),
      compare_month: str(raw.compare_month),
      compare_partial: bool(raw.compare_partial),
      like_for_like: bool(raw.like_for_like),
      base_window: pair(raw.base_window),
      compare_window: pair(raw.compare_window),
      base_shipping_days: toNum(raw.base_shipping_days),
      compare_shipping_days: toNum(raw.compare_shipping_days),
      compare_shipping_days_full_month: toNum(raw.compare_shipping_days_full_month),
      month_progress_pct: toNum(raw.month_progress_pct),
      last_posted_date: str(raw.last_posted_date),
      last_posted_source: str(raw.last_posted_source),
      note: str(raw.note)
    };
  }

  // One trajectory point (WIRE.TRAJECTORY_POINT, C17). cogs_per_ton is READ,
  // never derived; `partial` is set only when the wire says true.
  function mapTrajectoryPoint(raw, ctx) {
    var p = obj(raw);
    var out = {
      month: str(p.month),
      tons: toNum(p.tons),
      rev_per_ton: toNum(p.rev_per_ton),
      gm_per_ton: toNum(p.gm_per_ton),
      cogs_per_ton: toNum(p.cogs_per_ton),
      gm_pct: toNum(p.gm_pct)
    };
    if (!has(p, "cogs_per_ton")) oddity(ctx, "traj.cogs", "trajectory point without cogs_per_ton — left null, NOT derived from rev - gm (C17)");
    if (p.partial === true) out.partial = true;
    return out;
  }

  function mapTrajectory(raw, ctx) {
    var a = isArr(raw) ? raw : [], out = [], i;
    for (i = 0; i < a.length; i++) out.push(mapTrajectoryPoint(a[i], ctx));
    return out;
  }

  // cube:ssgBridge — legacy, NOT exact (explicit interaction residual).
  function mapSsgBridge(raw, ctx) {
    if (!isObj(raw) || raw.available !== true) {
      if (isObj(raw) && raw.available === undefined) oddity(ctx, "ssgbridge.avail", "dissection.bridge has no `available` flag — treated as unavailable");
      return { available: false, reason: str(obj(raw).reason) };
    }
    return {
      available: true,
      base: toNum(raw.base), compare: toNum(raw.compare),
      price: toNum(raw.price), mix: toNum(raw.mix), cost: toNum(raw.cost),
      interaction: toNum(raw.interaction),
      delta: toNum(raw.delta),
      base_month: str(raw.base_month), compare_month: str(raw.compare_month)
    };
  }

  // cube:mixBridge — unavailable form is {available:false, items:[]}, NO reason.
  function mapMixBridge(raw) {
    if (!isObj(raw) || raw.available !== true) return { available: false, items: [] };
    var a = isArr(raw.items) ? raw.items : [], items = [], i, e;
    for (i = 0; i < a.length; i++) {
      e = obj(a[i]);
      items.push({ ssg: (e.ssg === null || e.ssg === undefined) ? "" : String(e.ssg), contribution: toNum(e.contribution) });
    }
    return { available: true, items: items, total: toNum(raw.total) };
  }

  // cube:ingredientContribution (C18).
  function mapDissIngredients(raw) {
    var r = obj(raw), a = isArr(r.items) ? r.items : [], items = [], i, e;
    for (i = 0; i < a.length; i++) {
      e = obj(a[i]);
      items.push({
        name: (e.name === null || e.name === undefined) ? "" : String(e.name),
        contribution: toNum(e.contribution),     // + = costlier
        cost_now: toNum(e.cost_now),
        carried: bool(e.carried)                 // price carried from the other month
      });
    }
    return { available: bool(r.available), items: items, net: toNum(r.net), note: str(r.note) };
  }

  // cube:priceDrill (WIRE.PRICE_DRILL).
  function mapPriceDrill(raw) {
    if (!isObj(raw) || raw.available !== true) return { available: false, reason: str(obj(raw).reason) };
    var a = isArr(raw.top_rows) ? raw.top_rows : [], rows = [], i, e;
    for (i = 0; i < a.length; i++) {
      e = obj(a[i]);
      rows.push({
        ssg: str(e.ssg), sku: str(e.sku), name: str(e.name),
        tons_b: toNum(e.tons_b), tons_c: toNum(e.tons_c),
        rev_ton_b: toNum(e.rev_ton_b), rev_ton_c: toNum(e.rev_ton_c),
        true_price: toNum(e.true_price), customer_mix: toNum(e.customer_mix),
        held_pct: toNum(e.held_pct)
      });
    }
    return {
      available: true,
      unit: str(raw.unit),
      total: toNum(raw.total),
      true_price: toNum(raw.true_price),
      customer_mix: toNum(raw.customer_mix),
      sku_mix: toNum(raw.sku_mix),
      residual: toNum(raw.residual),
      price_held_pct: toNum(raw.price_held_pct),
      top_rows: rows,
      note: str(raw.note)
    };
  }

  // One lens (WIRE.LENS). null on the wire is a legal lens; anything that is
  // not an object with a rows array is skipped (C.TRUST_GATES.LENSES).
  function mapLens(raw) {
    if (!isObj(raw) || !isArr(raw.rows)) return null;
    var rows = [], i, r;
    for (i = 0; i < raw.rows.length; i++) {
      r = obj(raw.rows[i]);
      rows.push({
        key: (r.key === null || r.key === undefined) ? "" : String(r.key),
        value: toNum(r.value),
        share0_pct: toNum(r.share0_pct), share1_pct: toNum(r.share1_pct),
        share_shift_pp: toNum(r.share_shift_pp),
        gm_ton0: toNum(r.gm_ton0), gm_ton1: toNum(r.gm_ton1),   // null when absent in that window
        tons0: toNum(r.tons0), tons1: toNum(r.tons1)
      });
    }
    // total is over ALL rows while rows are server-truncated (C11): "top N".
    return { total: toNum(raw.total), rows: rows };
  }

  // The five lenses, iterated by WIRE.LENS_DIMS — never Object.keys — because
  // canonical_bridge.lenses.note is a STRING sitting among the lens objects.
  function mapLenses(raw, keepNote, ctx, label) {
    var dims = lensDims(), out = {}, i, r = obj(raw);
    if (!isObj(raw)) oddity(ctx, label + ".lenses", label + ".lenses absent — every lens mapped as null");
    for (i = 0; i < dims.length; i++) out[dims[i]] = mapLens(r[dims[i]]);
    if (keepNote && typeof r.note === "string") out.note = r.note;
    return out;
  }

  // mix_ordering (T1). `full` keeps customer_first/product_first (canonical only).
  function mapMixOrdering(raw, full, ctx, label) {
    if (!isObj(raw)) { oddity(ctx, label + ".mix_ordering", label + ".mix_ordering absent — sign stability unknown; the split must not be quoted (T1)"); return null; }
    var out = {
      customer_range: range(raw.customer_range),
      product_range: range(raw.product_range),
      sign_stable: bool(raw.sign_stable)     // false => the split is a modelling artefact
    };
    if (full) {
      var cf = obj(raw.customer_first), pf = obj(raw.product_first);
      out.customer_first = { customer: toNum(cf.customer), product: toNum(cf.product) };
      out.product_first = { customer: toNum(pf.customer), product: toNum(pf.product) };
    }
    return out;
  }

  // mix_detail (T2). `full` keeps cells_only_prior/current (canonical only).
  function mapMixDetail(raw, full, ctx, label) {
    if (!isObj(raw)) { oddity(ctx, label + ".mix_detail", label + ".mix_detail absent — churn dominance unknown (T2)"); return null; }
    var out = {
      continuing: toNum(raw.continuing),
      entering: toNum(raw.entering),
      exiting: toNum(raw.exiting),
      one_sided_share_pct: toNum(raw.one_sided_share_pct),
      matched_kg_share_pct: toNum(raw.matched_kg_share_pct),
      churn_dominated: bool(raw.churn_dominated)
    };
    if (full) {
      out.cells_only_prior = toNum(raw.cells_only_prior);
      out.cells_only_current = toNum(raw.cells_only_current);
    }
    return out;
  }

  // cost_components (C12) — ALWAYS an estimate, rendered distinct from the
  // measured bars. Null when no production ratio resolved.
  function mapCostComponents(raw, ctx) {
    if (raw === null || raw === undefined) return null;
    if (!isObj(raw)) return null;
    if (raw.estimated !== true) oddity(ctx, "cc.estimated", "cost_components.estimated missing — forced true (C12: the block is always an estimate)");
    return {
      rm: toNum(raw.rm),               // the remainder; absorbs every error
      packaging: toNum(raw.packaging),
      feedtag: toNum(raw.feedtag),
      estimated: true,
      basis: str(raw.basis)
    };
  }

  // significance (T3) — raw floats; formatting is the panel's job.
  function mapSignificance(raw, ctx) {
    if (!isObj(raw)) { oddity(ctx, "sig.absent", "canonical_bridge.significance absent — no verdict either way (T3)"); return { available: false, reason: null }; }
    if (raw.available !== true) return { available: false, reason: str(raw.reason) };
    return {
      available: true,
      n: toNum(raw.n), mean: toNum(raw.mean), sd: toNum(raw.sd), z: toNum(raw.z),
      percentile: toNum(raw.percentile), band: range(raw.band),
      verdict: str(raw.verdict)          // 'signal' | 'weak' | 'noise'
    };
  }

  function mapProductMixBySsg(raw) {
    var a = isArr(raw) ? raw : [], out = [], i, e;
    for (i = 0; i < a.length; i++) {
      e = obj(a[i]);
      out.push({ ssg: (e.ssg === null || e.ssg === undefined) ? "" : String(e.ssg), value: toNum(e.value) });
    }
    return out;
  }

  // The bars and anchors shared by the canonical and net bridges.
  function mapBennetCommon(raw, ctx, label) {
    var out = {
      available: true,
      unit: str(raw.unit),
      scope: str(raw.scope),
      method: str(raw.method),
      window: mapWindowMeta(raw.window),
      base_month: str(raw.base_month),
      compare_month: str(raw.compare_month),
      compare_partial: bool(raw.compare_partial),
      like_for_like: bool(raw.like_for_like),
      prior_gm_ton: toNum(raw.prior_gm_ton),
      current_gm_ton: toNum(raw.current_gm_ton),
      delta: toNum(raw.delta),                 // EXISTS on the wire (C4)
      price: toNum(raw.price),                 // real lever
      cost: toNum(raw.cost),                   // sign = GP impact
      customer_mix: toNum(raw.customer_mix),   // composition
      product_mix: toNum(raw.product_mix),
      mix_total: toNum(raw.mix_total),
      product_mix_by_ssg: mapProductMixBySsg(raw.product_mix_by_ssg),
      // Exact by construction (C13): a false here is impossible; the client
      // closure check is a ROUNDING-DRIFT bound, never a decomposition test.
      reconciles: bool(raw.reconciles),
      residual: toNum(raw.residual),           // RAW float while bars are rounded
      note: str(raw.note)                      // ends with ' WARNING: ...' when churn-dominated
    };
    if (!has(raw, "delta")) oddity(ctx, label + ".delta", label + ".delta absent — left null, not derived (C4)");
    if (!has(raw, "mix_total")) oddity(ctx, label + ".mix_total", label + ".mix_total absent — left null (WIRE.CANONICAL_BRIDGE)");
    return out;
  }

  // bv2:bridgeExactGMperTon on the GROSS basis (WIRE.CANONICAL_BRIDGE).
  // Absence of the whole block is recorded by validateDiss(), not here.
  function mapCanonicalBridge(raw, ctx) {
    if (!isObj(raw)) return { available: false, reason: null };
    if (raw.available !== true) return unavailableForm(raw, false);   // EXACTLY 2 keys (C5)
    var out = mapBennetCommon(raw, ctx, "canonical_bridge");
    var dc = raw.dropped_cells;
    out.mix_ordering = mapMixOrdering(raw.mix_ordering, true, ctx, "canonical_bridge");
    out.mix_detail = mapMixDetail(raw.mix_detail, true, ctx, "canonical_bridge");
    out.lenses = mapLenses(raw.lenses, true, ctx, "canonical_bridge");
    out.cost_components = mapCostComponents(raw.cost_components, ctx);
    out.significance = mapSignificance(raw.significance, ctx);
    out.dropped_cells = isObj(dc) ? {
      prior: toNum(dc.prior), current: toNum(dc.current),
      gp_prior: toNum(dc.gp_prior), gp_current: toNum(dc.gp_current)
    } : null;
    return out;
  }

  // The same decomposition NET of the off-invoice discount (WIRE.NET_BRIDGE).
  // Narrower than canonical: no cost_components, significance, dropped_cells,
  // lenses.note, mix_ordering.*_first, mix_detail.cells_only_*.
  function mapNetBridge(raw, ctx) {
    if (!isObj(raw)) return { available: false, reason: null };   // absence recorded by validateDiss()
    if (raw.available !== true) return unavailableForm(raw, false);   // EXACTLY 2 keys (C5)
    var out = mapBennetCommon(raw, ctx, "net_bridge");
    var d = obj(raw.discount), vs = obj(raw.vs_reported);
    out.mix_ordering = mapMixOrdering(raw.mix_ordering, false, ctx, "net_bridge");
    out.mix_detail = mapMixDetail(raw.mix_detail, false, ctx, "net_bridge");
    out.lenses = mapLenses(raw.lenses, false, ctx, "net_bridge");
    // The wedge.
    out.discount = {
      prior_per_ton: toNum(d.prior_per_ton), current_per_ton: toNum(d.current_per_ton),
      delta_per_ton: toNum(d.delta_per_ton),
      prior_total: toNum(d.prior_total), current_total: toNum(d.current_total)
    };
    // gap = net - reported.
    out.vs_reported = {
      delta_reported: toNum(vs.delta_reported), delta_net: toNum(vs.delta_net), gap: toNum(vs.gap),
      price_reported: toNum(vs.price_reported), price_net: toNum(vs.price_net), price_gap: toNum(vs.price_gap)
    };
    return out;
  }

  // cube:categoryTrend (C19). Here gm_ton / gm_pct ARE null on zero tons —
  // the opposite convention from matrix rows. Nothing is coerced.
  function mapCategoryCell(raw) {
    var c = obj(raw);
    return { month: str(c.month), gm_ton: toNum(c.gm_ton), gm_pct: toNum(c.gm_pct), tons: toNum(c.tons) };
  }

  function mapCategoryTrend(raw, ctx) {
    var r = obj(raw), cats = isArr(r.categories) ? r.categories : [], out = [], i, j, c, cells, ncells;
    var avg = isArr(r.avg) ? r.avg : [], navg = [];   // absence recorded by validateDiss()
    for (i = 0; i < cats.length; i++) {
      c = obj(cats[i]);
      cells = isArr(c.cells) ? c.cells : [];
      ncells = [];
      for (j = 0; j < cells.length; j++) ncells.push(mapCategoryCell(cells[j]));
      out.push({ ssg: (c.ssg === null || c.ssg === undefined) ? "" : String(c.ssg), total_tons: toNum(c.total_tons), cells: ncells });
    }
    for (i = 0; i < avg.length; i++) navg.push(mapCategoryCell(avg[i]));   // VOLUME-WEIGHTED row
    return {
      available: bool(r.available),
      months: strArr(r.months),
      partial_month: str(r.partial_month),
      categories: out,
      avg: navg,
      note: str(r.note)
    };
  }

  // The dissection block (WIRE.DISSECTION, C10, C16). Universe 103 only, credit
  // notes netted, MONTH-PAIR anchors — never the selected period (C.ANCHORS).
  function mapDissection(block, ctx) {
    if (!isObj(block)) return { available: false, reason: null };
    if (block.available !== true) return unavailableForm(block, false);   // EXACTLY 2 keys
    var out = {
      available: true,
      scope: str(block.scope),                  // the STRING 'finished_feed' (C10)
      basis: str(block.basis),
      base_month: str(block.base_month),        // FIRST complete month in range
      compare_month: str(block.compare_month),  // LAST complete month in range
      compare_partial: bool(block.compare_partial),
      compare_days: toNum(block.compare_days),
      window: mapWindowMeta(block.window),      // authoritative period (T4); nullable
      months: strArr(block.months),
      trajectory: mapTrajectory(block.trajectory, ctx),
      bridge: mapSsgBridge(block.bridge, ctx),
      mix_bridge: mapMixBridge(block.mix_bridge),
      ingredients: mapDissIngredients(block.ingredients),
      price_drill: mapPriceDrill(block.price_drill),
      canonical_bridge: mapCanonicalBridge(block.canonical_bridge, ctx),
      net_bridge: mapNetBridge(block.net_bridge, ctx),
      category_trend: mapCategoryTrend(block.category_trend, ctx)
    };
    if (isObj(block.scope)) oddity(ctx, "diss.scope", "dissection.scope is an object — on the wire it is the string 'finished_feed'; the real scope echo is meta.applied_filters (C10)");
    return out;
  }

  /* ==========================================================================
   * normalise(raw, phase) — THE ADAPTER SEAM
   *
   * Contract of the returned RESULT (nothing else in v2 may invent one):
   *   {
   *     ok:        boolean,                 shape passed validation
   *     phase:     "core" | "diss",
   *     route:     "data" | "error",        which action the caller dispatches
   *     state:     C.STATE.FRESH | C.STATE.EMPTY_SCOPE | C.STATE.UNAVAILABLE_FOR_SCOPE
   *     empty:     boolean,                 the EMPTY_SCOPE flag (core only)
   *     unavailable: boolean,               server said available:false, OR we
   *                                         rejected the shape
   *     reason:    string | null,           the text to show at full contrast
   *     errorKind: null | C.ERROR_KIND.*    set only when route === "error"
   *     message:   string | null,           set only when route === "error"
   *     errors:    [string],                fatal shape violations
   *     warnings:  [string],                non-fatal shape oddities (off-wire)
   *     data:      object,                  DISPATCH THIS as ACTION.DATA.payload.data
   *                                         (the RAW body — C.ACTION_EXAMPLES.DATA)
   *     norm:      object | null,           the mapped wire shape: phase core ->
   *                                         WIRE.ENVELOPE minus dissection; phase
   *                                         diss -> WIRE.DISSECTION
   *     envelope:  object | null            phase diss ONLY: the phase-B body's
   *                                         hero/discount_overlay/matrix mapped as
   *                                         a core (C15) — a store may refresh
   *                                         the core view from it, last write wins
   *   }
   *
   * A MALFORMED PAYLOAD NEVER THROWS. It is detected by explicit validation and
   * returned with route "data" and a synthetic { available:false, reason }
   * body, which the store's own rule turns into UNAVAILABLE_FOR_SCOPE. Routing
   * it as an ERROR would be wrong: the transport worked perfectly.
   *
   * THE EMPTY-SCOPE TEST IS ZERO ROWS (C.EMPTY_SCOPE_TEST, A3). matrix.rows is
   * never truncated and hero carries no volume; the only tonnage on the wire is
   * per row, so "zero rows with tonnage" cannot exist and there is no fault
   * branch. Phase A only: the matrix is what answers it.
   * ======================================================================= */

  // A fresh, fully-populated result record. Nothing downstream tests for a key.
  function blankResult(phase) {
    return {
      ok: true,
      phase: (phase === "diss") ? "diss" : "core",
      route: "data",
      state: C.STATE.FRESH,
      empty: false,
      unavailable: false,
      reason: null,
      errorKind: null,
      message: null,
      errors: [],
      warnings: [],
      data: null,
      norm: null,
      envelope: null
    };
  }

  // Strip the defensive { data: {...} } gateway wrapper, if present. Not on
  // the wire; tolerated because it costs nothing and one gateway did it once.
  function unwrapGateway(raw) {
    if (!isObj(raw)) return raw;
    var e = KEYS.ENVELOPE;
    var looksEnvelope = has(raw, e.matrix) || has(raw, e.hero) || has(raw, e.dissection) || has(raw, e.discount_overlay);
    if (!looksEnvelope && isObj(raw[KEYS.GATEWAY])) return raw[KEYS.GATEWAY];
    return raw;
  }

  // True when a body is a BARE dissection block (a fixture, or a future
  // flattened wire) rather than the envelope that carries one.
  function looksLikeBareDiss(body) {
    return isObj(body) && !has(body, KEYS.ENVELOPE.dissection) &&
      (has(body, "trajectory") || has(body, "canonical_bridge") || has(body, "base_month") ||
       (has(body, KEYS.AVAILABLE) && !has(body, KEYS.ENVELOPE.matrix)));
  }

  // SHAPE VALIDATION of the envelope, both phases. Fatal faults are the ones
  // that would make the render wrong or throw; everything else is a warning so
  // a slightly-off but usable payload still paints. Phase B REQUIRES only the
  // dissection block; the rest of the envelope is expected (C15) but its
  // absence is an oddity, not a rejection.
  function validateEnvelope(body, phase, errors, warnings) {
    var e = KEYS.ENVELOPE, tag = phase + ": ";
    if (!isObj(body)) { errors.push(tag + "payload is not an object"); return; }

    if (body[e.meta] !== undefined && body[e.meta] !== null && !isObj(body[e.meta])) errors.push(tag + "meta is not an object");
    if (body[e.hero] !== undefined && body[e.hero] !== null && !isObj(body[e.hero])) errors.push(tag + "hero is not an object");
    if (body[e.discount_overlay] !== undefined && body[e.discount_overlay] !== null && !isObj(body[e.discount_overlay])) {
      errors.push(tag + "discount_overlay is neither null nor an object");
    }

    var mtx = body[e.matrix];
    if (mtx === undefined || mtx === null) {
      if (phase === "core") errors.push(tag + "matrix is missing");
      else warnings.push(tag + "phase-B envelope carries no matrix (off-wire: C15 says hero/discount_overlay/matrix are always populated)");
    } else if (!isObj(mtx)) {
      errors.push(tag + "matrix is not an object");
    } else {
      if (!isArr(mtx.rows)) errors.push(tag + "matrix.rows is not an array");
      if (mtx.group_by !== undefined && typeof mtx.group_by !== "string") warnings.push(tag + "matrix.group_by is not a string");
      if (mtx.total_gp !== undefined && mtx.total_gp !== null && toNum(mtx.total_gp) === null) warnings.push(tag + "matrix.total_gp is not numeric");
    }
    if (phase === "core") {
      if (body[e.hero] === undefined || body[e.hero] === null) warnings.push(tag + "hero is missing (the wire never omits it)");
      if (body[e.bridge] !== undefined && body[e.bridge] !== null && !isObj(body[e.bridge])) warnings.push(tag + "bridge is not an object");
      if (body[e.trend] !== undefined && body[e.trend] !== null) {
        if (!isObj(body[e.trend])) warnings.push(tag + "trend is not an object");
        else if (body[e.trend].series !== undefined && body[e.trend].series !== null && !isArr(body[e.trend].series)) warnings.push(tag + "trend.series is not an array");
      }
      if (body[e.gap] !== undefined && body[e.gap] !== null && !isObj(body[e.gap])) warnings.push(tag + "gap is not an object");
      if (body[e.movers] !== undefined && body[e.movers] !== null && !isObj(body[e.movers])) warnings.push(tag + "movers is not an object");
    }
  }

  // SHAPE VALIDATION — phase B, applied to the dissection block itself.
  function validateDiss(block, errors, warnings) {
    if (!isObj(block)) { errors.push("diss: dissection block is not an object"); return; }
    var chk = [
      ["trajectory", "array"], ["ingredients", "object"], ["category_trend", "object"],
      ["canonical_bridge", "object"], ["net_bridge", "object"], ["window", "object"],
      ["bridge", "object"], ["mix_bridge", "object"], ["price_drill", "object"], ["months", "array"]
    ], i, k, want, v;
    for (i = 0; i < chk.length; i++) {
      k = chk[i][0]; want = chk[i][1]; v = block[k];
      if (v === undefined) { warnings.push("diss: " + k + " absent — mapped as unavailable / empty"); continue; }
      if (v === null) { if (k !== "window") warnings.push("diss: " + k + " is null — mapped as unavailable / empty"); continue; }
      if (want === "array" && !isArr(v)) errors.push("diss: " + k + " is not an array");
      if (want === "object" && !isObj(v)) errors.push("diss: " + k + " is not an object");
    }
  }

  // The synthetic body used to route a rejected payload to unavailable-for-scope
  // through the store's own `available === false` rule. Nothing invented: it
  // uses the same two wire fields the server itself uses to say "not for this
  // cut", so the store needs no special case for a malformed response.
  function unavailableBody(reason) {
    var b = {};
    b[KEYS.AVAILABLE] = false;
    b[KEYS.REASON] = reason || C.STATE_COPY["unavailable-for-scope"];
    return b;
  }

  // Map a body under a ctx, never throwing: a mapper fault becomes a warning
  // and a null, and is written to the ring.
  function safeMap(fn, arg, ctx, label) {
    try { return fn(arg, ctx); }
    catch (e) {
      fail("normalise: mapper threw", { what: label, message: e && e.message });
      ctx.warnings.push(label + ": mapper threw (" + (e && e.message ? e.message : "?") + ")");
      return null;
    }
  }

  // THE SINGLE FUNCTION AWARE OF THE WIRE CONTRACT.
  function normalise(raw, phase) {
    var res = blankResult(phase);
    var isDiss = (res.phase === "diss");
    var ctx = newCtx();

    // 1. A 2xx with no body at all is EMPTY_BODY — an error, not an answer.
    if (raw === null || raw === undefined) {
      res.ok = false;
      res.route = "error";
      res.errorKind = C.ERROR_KIND.EMPTY_BODY;
      res.message = "Empty response body.";
      res.errors.push(res.phase + ": empty body");
      warn("normalise: empty body", res.phase);
      return res;
    }

    // 2. A JSON scalar (a string, a number) is a parse-level fault: the
    //    transport succeeded but this is not the document we asked for.
    if (typeof raw !== "object") {
      res.ok = false;
      res.route = "error";
      res.errorKind = C.ERROR_KIND.PARSE;
      res.message = "Unexpected response body.";
      res.errors.push(res.phase + ": body is a " + (typeof raw) + ", expected an object");
      warn("normalise: scalar body", { phase: res.phase, type: typeof raw });
      return res;
    }

    var body = unwrapGateway(raw);
    var bare = isDiss && looksLikeBareDiss(body);
    var block = isDiss ? (bare ? body : (isObj(body) ? body[KEYS.ENVELOPE.dissection] : undefined)) : body;
    if (bare) res.warnings.push("diss: body is a bare dissection block, not the phase-B envelope (fixture?)");

    // 3. The server's own "not computable for this cut" answer. This is an
    //    ANSWER: full contrast, reason text, no error affordance. Checked
    //    BEFORE shape validation, because an unavailable cut legitimately omits
    //    the blocks a present cut must carry. The envelope itself has no
    //    `available` on the wire; the check on `body` exists for the synthetic
    //    unavailableBody() and any fixture that uses the same two fields.
    var bodyAvail = (isObj(body) && !isArr(body)) ? body[KEYS.AVAILABLE] : undefined;
    var blockAvail = (isDiss && isObj(block)) ? block[KEYS.AVAILABLE] : undefined;
    if (bodyAvail === false || blockAvail === false) {
      res.unavailable = true;
      res.state = C.STATE.UNAVAILABLE_FOR_SCOPE;
      res.reason = str(isObj(block) ? block[KEYS.REASON] : null) ||
                   str(isObj(body) ? body[KEYS.REASON] : null) ||
                   str(isObj(block) ? block.note : null) ||
                   C.STATE_COPY["unavailable-for-scope"];
      res.data = raw;                       // pass the server's own words through
      if (isDiss) {
        res.norm = { available: false, reason: str(isObj(block) ? block[KEYS.REASON] : null) };
        // Phase B still carries the full envelope (C15) even when the
        // dissection is not computable for the cut.
        if (!bare && isObj(body) && (has(body, KEYS.ENVELOPE.hero) || has(body, KEYS.ENVELOPE.matrix))) {
          res.envelope = safeMap(mapCore, body, ctx, "envelope");
        }
      } else {
        res.norm = { available: false, reason: str(isObj(body) ? body[KEYS.REASON] : null) };
      }
      appendWarnings(res, ctx);
      info("normalise: unavailable-for-scope", { phase: res.phase, reason: res.reason });
      return res;
    }

    // 4. SHAPE VALIDATION. Explicit, never a swallowed TypeError.
    if (isDiss) {
      if (!bare) {
        validateEnvelope(body, "diss", res.errors, res.warnings);
        if (isObj(body) && !has(body, KEYS.ENVELOPE.dissection)) res.errors.push("diss: dissection block is missing from the envelope");
        else if (isObj(body) && body[KEYS.ENVELOPE.dissection] === null) res.errors.push("diss: dissection is null — include=dissection was not honoured");
      }
      validateDiss(block, res.errors, res.warnings);
    } else {
      validateEnvelope(body, "core", res.errors, res.warnings);
    }

    if (res.errors.length) {
      res.ok = false;
      res.unavailable = true;
      res.state = C.STATE.UNAVAILABLE_FOR_SCOPE;
      res.reason = C.STATE_COPY["unavailable-for-scope"];
      res.data = unavailableBody(res.reason);   // routes via the store's own rule
      res.norm = { available: false, reason: res.reason };
      fail("normalise: shape rejected -> unavailable-for-scope", { phase: res.phase, errors: res.errors });
      return res;
    }

    // 5. THE MAP.
    if (isDiss) {
      res.norm = safeMap(mapDissection, block, ctx, "dissection");
      if (!bare && isObj(body) && (has(body, KEYS.ENVELOPE.hero) || has(body, KEYS.ENVELOPE.matrix) || has(body, KEYS.ENVELOPE.discount_overlay))) {
        res.envelope = safeMap(mapCore, body, ctx, "envelope");
      }
    } else {
      res.norm = safeMap(mapCore, body, ctx, "core");
    }

    // 6. THE EMPTY-SCOPE FLAG — phase A only, ZERO ROWS IS THE WHOLE TEST (A3).
    if (!isDiss) {
      var tn = tonnageOf(obj(body)[KEYS.ENVELOPE.matrix]);
      if (tn.rows === 0) {
        res.empty = true;
        res.state = C.STATE.EMPTY_SCOPE;
        res.reason = C.STATE_COPY["empty-scope"];
        info("normalise: empty-scope", { rows: 0 });
      }
    }

    res.data = raw;                         // the store normalises from raw
    appendWarnings(res, ctx);
    if (res.warnings.length) warn("normalise: shape warnings", { phase: res.phase, warnings: res.warnings });
    return res;
  }

  // Fold the mapping context's off-wire notes into the result.
  function appendWarnings(res, ctx) {
    var i;
    for (i = 0; i < ctx.warnings.length; i++) res.warnings.push(ctx.warnings[i]);
  }

  /* ==========================================================================
   * THE SCOPE-KEYED LRU  (C.CACHE_MAX entries, C.CACHE_TTL_MS TTL)
   *
   * This cache holds RAW BODIES, not view models: a cached body must go through
   * exactly the same normalise() the live one does, or the cached render and
   * the fresh render can disagree.
   *
   * STALE-WHILE-REVALIDATE: past the TTL an entry is not discarded. It is
   * served immediately (so the panel never blanks) and a refresh is fired in
   * the background; when it lands, DATA is dispatched a second time.
   * ======================================================================= */

  var CACHE = [];   // oldest first; newest at the end

  // Index of the entry for a scope key, or -1.
  function cacheIndex(key) {
    var i;
    for (i = 0; i < CACHE.length; i++) if (CACHE[i].key === key) return i;
    return -1;
  }

  // Store one phase's raw body under its scope key, promoting the entry to MRU
  // and evicting past C.CACHE_MAX.
  function cachePut(key, phase, body) {
    var i = cacheIndex(key), e;
    if (i >= 0) e = CACHE.splice(i, 1)[0];
    else e = { key: key, core: null, diss: null };
    e[phase] = { body: body, t: Date.now() };
    CACHE.push(e);
    while (CACHE.length > C.CACHE_MAX) {
      trace("cache evict", CACHE[0].key);
      CACHE.shift();
    }
  }

  // Read one phase for a key. Returns null on a miss, otherwise
  // { body, age, stale } — stale entries are RETURNED, not dropped.
  function cacheGet(key, phase) {
    var i = cacheIndex(key);
    if (i < 0) return null;
    var e = CACHE[i], slot = e[phase];
    if (!slot) return null;
    // Touch: reading makes this the most-recently-used entry.
    CACHE.splice(i, 1);
    CACHE.push(e);
    var age = Date.now() - slot.t;
    return { body: slot.body, age: age, stale: age > C.CACHE_TTL_MS };
  }

  // Drop everything. Test support and the RESET action.
  function cacheClear() { CACHE.length = 0; }

  // NON-TOUCHING read for chrome (the controller's drill rail paints a row
  // count on every cut already seen this session). Same result shape as
  // cacheGet, but the LRU order is NOT changed: painting nine chips must not
  // reorder eviction, and it must never fetch. Stale entries are returned.
  function cachePeek(key, phase) {
    var i = cacheIndex(key), slot;
    if (i < 0) return null;
    slot = CACHE[i][phase];
    if (!slot) return null;
    var age = Date.now() - slot.t;
    return { body: slot.body, age: age, stale: age > C.CACHE_TTL_MS };
  }

  /* ==========================================================================
   * INFLIGHT DEDUPE — ON BOTH PHASES
   *
   * v1 dedupes phase A only (js/margin-explorer.js scopeSig()), so three fast
   * region clicks leave three live phase-B dissection queries running against
   * one SAP connection. Here the map is keyed by scopeKey + phase, so a second
   * caller for the same cut JOINS the flight instead of starting another.
   * ======================================================================= */

  var INFLIGHT = {};   // id -> { id, key, phase, controller, promise, t }

  // The inflight map id for one cut+phase.
  function flightId(key, phase) { return key + "::" + phase; }

  // Start (or join) the network request for one cut+phase.
  function fetchPhase(key, phase, params) {
    var id = flightId(key, phase), live = INFLIGHT[id];
    if (live) {
      trace("inflight join", id);
      return live.promise;
    }
    var ctrl = makeAbort();
    var rec = { id: id, key: key, phase: phase, controller: ctrl, promise: null, t: Date.now() };
    var p = Promise.resolve()
      .then(function () { return TRANSPORT(C.ENDPOINT, params, ctrl.signal); })
      .then(function (body) {
        if (INFLIGHT[id] === rec) delete INFLIGHT[id];
        return body;
      }, function (err) {
        if (INFLIGHT[id] === rec) delete INFLIGHT[id];
        throw err;
      });
    rec.promise = p;
    INFLIGHT[id] = rec;
    return p;
  }

  // Abort every inflight request whose scope key is NOT `keepKey`. Called on
  // every scope change: the answer to a cut nobody is looking at any more is
  // dead weight on the SAP connection.
  function abortOthers(keepKey, reason) {
    var id, rec, n = 0;
    for (id in INFLIGHT) {
      if (!Object.prototype.hasOwnProperty.call(INFLIGHT, id)) continue;
      rec = INFLIGHT[id];
      if (rec.key === keepKey) continue;
      try { rec.controller.abort(reason || "scope-change"); } catch (e) {}
      delete INFLIGHT[id];
      n++;
    }
    if (n) info("aborted superseded requests", { count: n, keep: keepKey });
    return n;
  }

  // Abort every inflight request for one key (both phases).
  function abortKey(key, reason) {
    var phases = ["core", "diss"], i, id, rec, n = 0;
    for (i = 0; i < phases.length; i++) {
      id = flightId(key, phases[i]);
      rec = INFLIGHT[id];
      if (!rec) continue;
      try { rec.controller.abort(reason || "abortKey"); } catch (e) {}
      delete INFLIGHT[id];
      n++;
    }
    return n;
  }

  // Abort everything. Used on page leave and by the test harness.
  function abortAll(reason) {
    var id, rec, n = 0;
    for (id in INFLIGHT) {
      if (!Object.prototype.hasOwnProperty.call(INFLIGHT, id)) continue;
      rec = INFLIGHT[id];
      try { rec.controller.abort(reason || "abortAll"); } catch (e) {}
      n++;
    }
    INFLIGHT = {};
    if (n) info("aborted all requests", { count: n, reason: reason || "abortAll" });
    return n;
  }

  // Snapshot of the inflight map, for the test page.
  function inflightList() {
    var out = [], id;
    for (id in INFLIGHT) {
      if (!Object.prototype.hasOwnProperty.call(INFLIGHT, id)) continue;
      out.push({ id: id, key: INFLIGHT[id].key, phase: INFLIGHT[id].phase, t: INFLIGHT[id].t });
    }
    return out;
  }

  /* ==========================================================================
   * TRANSPORT
   * Swappable so the mock, and the test page, can stand in for the network
   * WITHOUT anything patching window.apiFetch (which would poison v1).
   * ======================================================================= */

  // The shipping transport: the mock when it is explicitly enabled, otherwise
  // the real request. Resolves with the parsed body in both cases.
  function defaultTransport(endpoint, params, signal) {
    if (NS.mock && typeof NS.mock.fetch === "function" &&
        typeof NS.mock.isEnabled === "function" && NS.mock.isEnabled()) {
      // The mock does not take a signal; withAbort() enforces it from outside.
      return withAbort(NS.mock.fetch(endpoint, params), signal);
    }
    return mexpFetch(endpoint, params, signal).then(function (env) { return env.body; });
  }

  var TRANSPORT = defaultTransport;

  // Replace the transport (tests, mock harnesses). Pass nothing to restore.
  function setTransport(fn) {
    TRANSPORT = (typeof fn === "function") ? fn : defaultTransport;
    info("transport set", TRANSPORT === defaultTransport ? "default" : "custom");
  }

  /* ==========================================================================
   * DISPATCH HELPERS
   * Every action leaves here stamped with BOTH the scope key and the sequence,
   * so the store's invariant — not this file's optimism — decides what lands.
   * ======================================================================= */

  // Dispatch into the store when one is loaded; a harness without a store still
  // gets the callbacks and the ring entries.
  function dispatch(action) {
    if (NS.store && typeof NS.store.dispatch === "function") return NS.store.dispatch(action);
    trace("dispatch skipped: no store", action && action.type);
    return null;
  }

  // Current store snapshot, or a safe stand-in.
  function snapshot() {
    if (NS.store && typeof NS.store.get === "function") return NS.store.get();
    return { scope: null, key: "", label: "", seq: 0, data: { core: null, diss: null, prev: null } };
  }

  // True when the store already holds data for this phase under this key —
  // i.e. something is already painted, so a refetch is a REFRESH, not a FIRST.
  function hasPainted(key, phase) {
    var snap = snapshot(), rec = snap.data ? snap.data[phase] : null;
    return !!(rec && rec.key === key);
  }

  function dispatchLoading(key, phase, seq, first) {
    dispatch({ type: C.ACTION.LOADING, payload: { phase: phase, key: key, seq: seq, first: first } });
  }

  function dispatchData(key, phase, seq, data) {
    dispatch({ type: C.ACTION.DATA, payload: { phase: phase, key: key, seq: seq, data: data } });
  }

  function dispatchError(key, phase, seq, kind, message) {
    dispatch({
      type: C.ACTION.ERROR,
      payload: { phase: phase, key: key, seq: seq, kind: kind, message: message }
    });
  }

  // Turn one raw body into the right action. The ONLY place a normalise result
  // is converted into a dispatch, so the routing rule exists once.
  function deliver(key, phase, seq, body, source, opts) {
    var res;
    try {
      res = normalise(body, phase);
    } catch (e) {
      // normalise() is written not to throw; this is the belt on the braces so
      // a future edit cannot turn a shape fault into an unhandled rejection.
      fail("normalise threw — routed as PARSE", { phase: phase, message: e && e.message });
      res = blankResult(phase);
      res.ok = false;
      res.route = "error";
      res.errorKind = C.ERROR_KIND.PARSE;
      res.message = errorMessageFor(e);
    }
    res.key = key;
    res.seq = seq;
    res.source = source;

    if (res.route === "error") {
      dispatchError(key, phase, seq, res.errorKind, res.message);
    } else {
      dispatchData(key, phase, seq, res.data);
    }
    if (opts && typeof opts.onPhase === "function") {
      try { opts.onPhase(res); } catch (e2) { fail("onPhase threw", e2 && e2.message); }
    }
    return res;
  }

  /* ==========================================================================
   * THE PHASE RUNNER
   * Cache -> stale-while-revalidate -> network, with the abort swallow.
   * ======================================================================= */

  // Run one phase for one cut. Never rejects: every outcome is either a
  // dispatched action or, for an abort, silence.
  function runPhase(key, phase, scope, seq, opts) {
    var params = paramsFor(scope, phase);
    var cached = cacheGet(key, phase);

    if (cached && !cached.stale) {
      // Fresh cache hit: paint from cache, no network at all.
      trace("cache hit (fresh)", { key: key, phase: phase, age: cached.age });
      var hit = deliver(key, phase, seq, cached.body, "cache", opts);
      hit.fromCache = true;
      return Promise.resolve(hit);
    }

    if (cached && cached.stale) {
      // STALE-WHILE-REVALIDATE: show the last good body immediately so the
      // panel never blanks, then mark the panel as refreshing and go get it.
      trace("cache hit (stale) — revalidating", { key: key, phase: phase, age: cached.age });
      deliver(key, phase, seq, cached.body, "cache-stale", opts);
      dispatchLoading(key, phase, seq, false);
    } else {
      dispatchLoading(key, phase, seq, !hasPainted(key, phase));
    }

    return fetchPhase(key, phase, params).then(function (body) {
      cachePut(key, phase, body);
      var res = deliver(key, phase, seq, body, "net", opts);
      res.fromCache = false;
      return res;
    }, function (err) {
      // THE ABORT SWALLOW. An abort is the user changing their mind — the ONLY
      // outcome that produces no status dispatch at all. Without this line,
      // every fast second chip click paints an error badge, and the reliability
      // work this whole layer exists for would read as flakiness.
      if (isAbort(err)) {
        trace("aborted (swallowed)", { key: key, phase: phase });
        return { aborted: true, key: key, phase: phase, route: "none" };
      }
      var kind = errorKindFor(err);
      var message = errorMessageFor(err);
      if (err && err.sessionExpired) info("session expired on " + phase, key);
      dispatchError(key, phase, seq, kind, message);
      if (opts && typeof opts.onPhase === "function") {
        try {
          opts.onPhase({ phase: phase, key: key, seq: seq, route: "error",
                         ok: false, errorKind: kind, message: message });
        } catch (e2) { fail("onPhase threw", e2 && e2.message); }
      }
      return { aborted: false, key: key, phase: phase, route: "error",
               errorKind: kind, message: message };
    });
  }

  /* ==========================================================================
   * load() — BOTH PHASES
   * ======================================================================= */

  // Set true only if the backend is ever MEASURED to serialise both phases on
  // one SAP connection. We have not measured it, so parallel is the default.
  var SEQUENTIAL = false;

  // Fire phase A and phase B for the live scope. Aborts everything belonging to
  // any other scope key first, so a superseded cut stops consuming the
  // connection the moment the user moves.
  function load(opts) {
    opts = obj(opts);
    var snap = snapshot();
    var scope = opts.scope || snap.scope;
    var key = (opts.key !== undefined && opts.key !== null) ? opts.key : snap.key;
    var seq = (opts.seq === undefined || opts.seq === null) ? snap.seq : opts.seq;

    abortOthers(key, "scope-change");

    var pCore = runPhase(key, "core", scope, seq, opts);
    var pDiss;
    if (SEQUENTIAL) {
      /* SEQUENTIAL FALLBACK (one line) — phase B waits for phase A. */
      pDiss = pCore.then(function () { return runPhase(key, "diss", scope, seq, opts); });
    } else {
      pDiss = runPhase(key, "diss", scope, seq, opts);   // PARALLEL (default)
    }

    return Promise.all([pCore, pDiss]).then(function (both) {
      var out = { key: key, seq: seq, core: both[0], diss: both[1] };
      if (typeof opts.onDone === "function") {
        try { opts.onDone(out); } catch (e) { fail("onDone threw", e && e.message); }
      }
      return out;
    });
  }

  // Choose parallel (false) or sequential (true) phase firing at runtime.
  function setSequential(on) { SEQUENTIAL = !!on; info("phase firing", SEQUENTIAL ? "sequential" : "parallel"); }

  /* ==========================================================================
   * SCOPE CHANGE — the sanctioned path
   * STALE (promote current -> prev) then SCOPE (new key, new seq) then load().
   * Doing it in this order is what lets renderStale() print prev.label instead
   * of showing Visayas numbers under a Mindanao heading.
   * ======================================================================= */

  // The key the store WOULD derive from this patch, without dispatching. The
  // store applies the same validation it uses on SCOPE (silently), so an
  // illegal value that the reducer will ignore cannot fake a key change.
  function prospectiveKey(patch) {
    if (!NS.store || typeof NS.store.previewKey !== "function") return null;
    try { return NS.store.previewKey(patch); } catch (e) { return null; }
  }

  // Apply a scope patch and refetch. Returns load()'s promise.
  //
  // D2: STALE is dispatched ONLY when the patch actually changes the scope
  // key. A same-key patch with STALE in front of it would promote the CURRENT
  // payload into vm.prev under the CURRENT label — exactly the renderStale
  // defect class (Visayas numbers under a Mindanao heading, in reverse).
  //
  // CONTROLLER RULE: unit and sort are display-only. Controllers route them
  // through store.dispatch({type: VIEW}) and NEVER through applyScope; this
  // function exists for real scope fields (C.scopeKeyFields) only. A
  // same-key call is tolerated (no STALE, no seq advance in the store, the
  // load() hits cache) but it is not the sanctioned path for a unit toggle.
  function applyScope(patch, opts) {
    opts = obj(opts);
    var before = snapshot();
    var next = prospectiveKey(patch);
    if (next === null || next !== before.key) {
      dispatch({ type: C.ACTION.STALE, payload: { key: before.key, label: before.label } });
    } else {
      trace("applyScope: same key — STALE not dispatched (D2)", { key: before.key });
    }
    dispatch({ type: C.ACTION.SCOPE, payload: { patch: patch, seq: before.seq + 1 } });
    var after = snapshot();
    return load({ key: after.key, scope: after.scope, seq: after.seq,
                  onPhase: opts.onPhase, onDone: opts.onDone });
  }

  /* ==========================================================================
   * CUSTOMER DEBOUNCE — C.CUSTOMER_DEBOUNCE_MS (450ms)
   * Below ~350ms a touch-typist fires one query per keystroke against the
   * heaviest filter on the endpoint; above ~600ms the field feels broken. 450
   * is the value already proven in production on this endpoint (v1 parity).
   * ======================================================================= */

  var custTimer = null;
  var custPending = null;

  // Run the pending customer change now.
  function flushCustomer() {
    if (custTimer !== null) { clearTimeout(custTimer); custTimer = null; }
    var p = custPending;
    custPending = null;
    if (!p) return null;
    return p.run();
  }

  // Drop the pending customer change without running it.
  function cancelCustomer() {
    if (custTimer !== null) { clearTimeout(custTimer); custTimer = null; }
    custPending = null;
  }

  // Debounce the free-text customer filter. `fn` is optional: with no callback
  // the default action is the sanctioned STALE -> SCOPE -> load sequence.
  function debounceCustomer(value, fn) {
    var v = (value === null || value === undefined || value === "") ? null : String(value);
    cancelCustomer();
    custPending = {
      value: v,
      run: function () {
        if (typeof fn === "function") return fn(v);
        return applyScope({ customer: v, drill: [] });
      }
    };
    custTimer = setTimeout(function () {
      custTimer = null;
      var p = custPending;
      custPending = null;
      if (!p) return;
      try { p.run(); } catch (e) { fail("customer debounce callback threw", e && e.message); }
    }, C.CUSTOMER_DEBOUNCE_MS);
    trace("customer debounce armed", { value: v, ms: C.CUSTOMER_DEBOUNCE_MS });
  }

  /* ==========================================================================
   * PAGE-LEAVE ABORT — mount() / destroy()  (A1, C.WINDOW_LISTENERS)
   * A dissection query that outlives its page keeps a SAP connection busy for
   * nothing. `pagehide` fires on both the bfcache path and the real unload, so
   * it is the ONLY listener; `beforeunload` is FORBIDDEN because registering it
   * at all disqualifies the whole app from the back/forward cache. Nothing is
   * bound at module load: the controller calls mount() when v2 is shown and
   * destroy() when it is torn down.
   * ======================================================================= */

  var leaveBound = false;

  // Abort everything the moment the page goes away.
  function onPageLeave() { abortAll("page-leave"); cancelCustomer(); }

  // Bind the page-leave abort. Idempotent. Returns true when bound.
  function mount() {
    if (leaveBound) return true;
    try {
      window.addEventListener(C.WINDOW_LISTENERS.ALLOWED_FOR_TEARDOWN[0], onPageLeave);
      leaveBound = true;
    } catch (e) { warn("could not bind page-leave abort", e && e.message); }
    return leaveBound;
  }

  // Unbind and stop everything. Safe to call twice, safe before mount().
  function destroy() {
    abortAll("destroy");
    cancelCustomer();
    if (!leaveBound) return;
    try { window.removeEventListener(C.WINDOW_LISTENERS.ALLOWED_FOR_TEARDOWN[0], onPageLeave); } catch (e) {}
    leaveBound = false;
  }

  /* ==========================================================================
   * EXPORT — one property on the single global namespace object. This
   * assignment is the ONLY side effect of loading this file.
   * ======================================================================= */

  NS.api = {
    VERSION: C.VERSION,

    // The request
    mexpFetch: mexpFetch,
    paramsFor: paramsFor,

    // The adapter seam
    normalise: normalise,
    normalize: normalise,      // spelling alias; same function object
    tonnageOf: tonnageOf,      // SUM(rows[].kg)/1000 — the only scope tonnage (C1)
    KEYS: KEYS,

    // THE ONE NORMALISER (D1). The store's normCore / normDiss delegate here,
    // so vm.core / vm.diss are exactly what these mappers produce: C5-exact,
    // keys the wire leaves absent stay UNDEFINED. Off-wire oddities are
    // ring-logged (the store has no warnings channel of its own). A mapper
    // fault throws: the store's reduceData turns it into a PARSE error.
    mapCore: function (body) {
      var ctx = newCtx(), out = mapCore(obj(body), ctx);
      if (ctx.warnings.length) warn("map(core): off-wire oddities", ctx.warnings);
      return out;
    },
    mapDissection: function (block) {
      var ctx = newCtx(), out = mapDissection(block, ctx);
      if (ctx.warnings.length) warn("map(diss): off-wire oddities", ctx.warnings);
      return out;
    },

    // Orchestration
    load: load,
    runPhase: runPhase,
    applyScope: applyScope,
    setSequential: setSequential,
    isSequential: function () { return SEQUENTIAL; },

    // Transport seam
    setTransport: setTransport,
    defaultTransport: defaultTransport,

    // Lifecycle (window listeners live between these two, never outside)
    mount: mount,
    destroy: destroy,
    isMounted: function () { return leaveBound; },

    // Abort
    abortKey: abortKey,
    abortOthers: abortOthers,
    abortAll: abortAll,
    isAbort: isAbort,

    // Customer debounce
    debounceCustomer: debounceCustomer,
    flushCustomer: flushCustomer,
    cancelCustomer: cancelCustomer,

    // Error typing, shared so no panel sniffs a message string
    errorKindFor: errorKindFor,
    errorMessageFor: errorMessageFor,
    sessionExpiredError: sessionExpiredError,

    // Introspection for the test page; not used by shipping panels
    _cache: function () {
      var out = [], i, e;
      for (i = 0; i < CACHE.length; i++) {
        e = CACHE[i];
        out.push({
          key: e.key,
          core: e.core ? { age: Date.now() - e.core.t } : null,
          diss: e.diss ? { age: Date.now() - e.diss.t } : null
        });
      }
      return out;
    },
    _cacheClear: cacheClear,
    _inflight: inflightList,
    _cacheGet: cacheGet,
    cachePeek: cachePeek,      // non-touching read (drill rail counts); never fetches, never reorders the LRU
    _cachePut: cachePut,
    // Test support only: backdate a cache slot so the 120s stale-while-
    // revalidate window can be exercised without waiting two minutes.
    _cacheAge: function (key, phase, ms) {
      var i = cacheIndex(key);
      if (i < 0 || !CACHE[i][phase]) return false;
      CACHE[i][phase].t -= (+ms || 0);
      return true;
    }
  };

})();
