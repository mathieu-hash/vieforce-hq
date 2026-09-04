/* ============================================================================
 * mexp2-adapter.js — Margin Explorer · THE SEAM BETWEEN v1's DATA FLOW AND THE
 * v2 PANELS (window.MEXP2.adapter)
 * ----------------------------------------------------------------------------
 * v1 (js/margin-explorer.js) fetches phase A and phase B itself and keeps the
 * RAW payloads in its LAST object, exposed read-only by window.MEXP_state().
 * The v2 panels (mexp2-panel-*.js) consume a contract-shaped view model
 * (C.VM_SHAPE) whose core/diss are produced by THE ONE normaliser,
 * MEXP2.api.mapCore / mapDissection (CONTRACT.md §8, D1). This file does only
 * that translation and the panel lifecycle fan-out. It never fetches, never
 * touches the store, never patches v1, never logs to console.
 *
 *   vmFromV1(coreRaw, dissRaw, scopeSig, scopeLabel, hints) -> vm
 *     coreRaw   raw phase-A envelope (or null before the first paint)
 *     dissRaw   raw `dissection` block (or null) — pass null for a block whose
 *               sig differs from scopeSig: it belongs to a previous scope
 *     hints     { coreLoading, dissLoading, coreError, dissError, scope, prev }
 *               coreError/dissError: a message string or an Error; scope: v1's
 *               STATE (period, ref_month, region, bu, customer, group_by,
 *               compare, unit); prev: {key,label,core,diss} of the last good vm
 *               for a DIFFERENT scope, owned by the caller (it is what
 *               renderStale prints).
 *   phaseStatus(vm, hints, phase)  one of C.STATE, per phase ("core"|"diss").
 *   mountPanels(hosts, order)      mount registered panels; `hosts` is one
 *               element (panels appended in order) or {panelId: element}.
 *   renderAll(vm, hints) / renderStaleAll(prev, vm) / setStatusAll(state) /
 *   destroyPanels()
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-adapter: mexp2-contract.js must load before this file.");

  var S = C.STATE;
  // Display order on the v1 page: the category-by-month table (Drill Matrix
  // box), the reported bridge (Bridge box), the realised bridge (net section).
  var DEFAULT_ORDER = ["trendmatrix", "bridge", "netbridge"];

  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level]("adapter: " + msg, data); } catch (e) { /* silent */ }
  }
  function isObj(v) { return !!v && typeof v === "object"; }
  function isEmptyScope(core) {
    if (NS.store && typeof NS.store.isEmptyScope === "function") return NS.store.isEmptyScope(core);
    return !!(core && core.matrix && core.matrix.rows && core.matrix.rows.length === 0);
  }

  /* -------------------------------------------------------------------------
   * scope: v1 STATE -> contract scope (C.DEFAULT_SCOPE shape, deep-copied)
   * ---------------------------------------------------------------------- */
  function scopeFromV1(s) {
    var d = C.DEFAULT_SCOPE, drill = [], i, c; s = s || {};
    // v1's drill path (margin-explorer.js STATE.drill): copied crumb by crumb,
    // never shared, so a panel cannot mutate the controller's path.
    if (s.drill && typeof s.drill.length === "number") {
      for (i = 0; i < s.drill.length; i++) {
        c = s.drill[i];
        if (!c || c.dim == null || c.value == null) continue;
        drill.push({ dim: String(c.dim), value: String(c.value), label: c.label == null ? String(c.value) : String(c.label) });
      }
    }
    return {
      period: s.period || d.period,
      refMonth: s.ref_month || null,
      region: s.region || d.region,
      bu: s.bu || d.bu,
      customer: s.customer || null,
      groupBy: s.group_by || d.groupBy,
      unit: s.unit || d.unit,
      compare: s.compare || d.compare,
      drill: drill,
      sort: { col: d.sort.col, dir: d.sort.dir }
    };
  }

  /* -------------------------------------------------------------------------
   * errors: v1 hands over a message string; the api typing helper takes an Error
   * ---------------------------------------------------------------------- */
  function errorOf(e) {
    if (!e) return null;
    if (typeof e === "string") e = { message: e };
    var kind = (NS.api && typeof NS.api.errorKindFor === "function") ? NS.api.errorKindFor(e) : C.ERROR_KIND.UNKNOWN;
    var msg = (NS.api && typeof NS.api.errorMessageFor === "function") ? NS.api.errorMessageFor(e) : (e.message || C.STATE_COPY.errored);
    return { kind: kind, message: msg };
  }

  /* -------------------------------------------------------------------------
   * status per C.STATE — same rules as the store's deriveStatus / statusFor
   * ---------------------------------------------------------------------- */
  function phaseStatus(vm, hints, phase) {
    var h = hints || {}, diss = (phase === "diss");
    var d = diss ? vm.diss : vm.core;
    var loading = diss ? h.dissLoading : h.coreLoading;
    var error = diss ? h.dissError : h.coreError;
    if (error) return S.ERRORED;                                  // only state with an error affordance
    if (loading) return d ? S.LOADING_REFRESH : S.LOADING_FIRST;  // never blank a painted panel
    if (!d) return S.LOADING_FIRST;                               // nothing has ever painted (A6)
    if (d.available === false) return S.UNAVAILABLE_FOR_SCOPE;    // the two-key form — an answer
    if (!diss && isEmptyScope(d)) return S.EMPTY_SCOPE;           // zero rows IS the whole test (A3)
    return S.FRESH;
  }

  /* -------------------------------------------------------------------------
   * the view model
   * ---------------------------------------------------------------------- */
  function vmFromV1(coreRaw, dissRaw, scopeSig, scopeLabel, hints) {
    hints = hints || {};
    var core = null, diss = null, mapErr = null;
    if (isObj(coreRaw)) {
      try { core = NS.api.mapCore(coreRaw); }
      catch (e) { mapErr = e; dbg("fail", "mapCore threw", e && e.message); }
    }
    if (isObj(dissRaw)) {
      try { diss = NS.api.mapDissection(dissRaw); }
      catch (e) { mapErr = mapErr || e; dbg("fail", "mapDissection threw", e && e.message); }
    }
    var h = { coreLoading: !!hints.coreLoading, dissLoading: !!hints.dissLoading,
              coreError: hints.coreError || (core === null && mapErr) || null,
              dissError: hints.dissError || (diss === null && mapErr) || null };
    var vm = {
      scope: scopeFromV1(hints.scope),
      key: scopeSig == null ? "" : String(scopeSig),
      label: scopeLabel == null ? "" : String(scopeLabel),
      status: S.LOADING_FIRST,
      core: core,
      diss: diss,
      prev: isObj(hints.prev) ? { key: hints.prev.key, label: hints.prev.label, core: hints.prev.core || null, diss: hints.prev.diss || null } : null,
      error: errorOf(h.coreError) || errorOf(h.dissError)
    };
    vm.status = phaseStatus(vm, h, "core");
    return vm;
  }

  /* -------------------------------------------------------------------------
   * panel lifecycle fan-out — `mounted` is the only state this file keeps
   * ---------------------------------------------------------------------- */
  var mounted = [];   // [{ id, inst, host, phase }]

  function hostFor(hosts, id) {
    if (!hosts) return null;
    if (typeof hosts.appendChild === "function") return hosts;
    return hosts[id] || null;
  }

  function mountPanels(hosts, order) {
    destroyPanels();
    var ids = order || DEFAULT_ORDER, i, id, inst, h, sec;
    for (i = 0; i < ids.length; i++) {
      id = ids[i];
      if (!NS.panel || !NS.panel.has(id)) { dbg("warn", "panel not registered", id); continue; }
      h = hostFor(hosts, id);
      if (!h) { dbg("warn", "no host element for panel", id); continue; }
      inst = NS.panel.create(id);
      if (!inst) continue;
      sec = document.createElement("section");
      sec.className = "mx2-panel";
      sec.setAttribute("data-mx2-panel", id);
      sec.setAttribute("data-mx2-status", S.LOADING_FIRST);
      h.appendChild(sec);
      try { inst.mount(sec); } catch (e) { dbg("fail", "panel mount threw", { id: id, message: e && e.message }); }
      mounted.push({ id: id, inst: inst, host: sec, phase: inst.phase === "diss" ? "diss" : "core" });
    }
    dbg("info", "mounted", ids.join(","));
    return mounted.slice();
  }

  function setOne(p, state) {
    p.host.setAttribute("data-mx2-status", state);
    p.inst.setStatus(state);
  }

  // Full paint: each panel gets its own phase's status; a panel whose live data
  // is null in a preservePrior state paints vm.prev through renderStale instead.
  // `phase` ("core" | "diss") limits the paint to that phase's panels — the v1
  // controller paints core panels when phase A lands and leaves the dissection
  // panels in their stale / loading state until phase B lands.
  function renderAll(vm, hints, phase) {
    var i, p, status, rule, live, stale;
    for (i = 0; i < mounted.length; i++) {
      p = mounted[i];
      if (phase && p.phase !== phase) continue;
      try {
        status = phaseStatus(vm, hints, p.phase);
        rule = C.STATE_RULES[status] || C.STATE_RULES.fresh;
        live = (p.phase === "diss") ? vm.diss : vm.core;
        stale = !!(rule.preservePrior && live == null && vm.prev);
        setOne(p, status);
        if (stale) p.inst.renderStale(vm.prev, vm); else p.inst.render(vm);
      } catch (e) {
        dbg("fail", "panel render threw", { id: p.id, message: e && e.message });
        p.host.setAttribute("data-mx2-status", S.ERRORED);
      }
    }
  }

  // Scope is changing: every panel keeps the previous scope's data, dimmed,
  // and prints prev.label. Status chrome is the caller's (setStatusAll).
  function renderStaleAll(prev, vm) {
    var i;
    if (!prev) { dbg("warn", "renderStaleAll without prev — rendering vm instead"); renderAll(vm, null); return; }
    for (i = 0; i < mounted.length; i++) {
      try { mounted[i].inst.renderStale(prev, vm); }
      catch (e) { dbg("fail", "panel renderStale threw", { id: mounted[i].id, message: e && e.message }); }
    }
  }

  // Status chrome only (never touches data). `phase` limits it as in renderAll.
  function setStatusAll(state, phase) {
    var i;
    if (!C.STATE_RULES[state]) state = S.FRESH;
    for (i = 0; i < mounted.length; i++) {
      if (phase && mounted[i].phase !== phase) continue;
      try { setOne(mounted[i], state); }
      catch (e) { dbg("fail", "panel setStatus threw", { id: mounted[i].id, message: e && e.message }); }
    }
  }

  function destroyPanels() {
    var i, p;
    for (i = 0; i < mounted.length; i++) {
      p = mounted[i];
      try { p.inst.destroy(); } catch (e) { dbg("fail", "panel destroy threw", p.id); }
      if (p.host && p.host.parentNode) p.host.parentNode.removeChild(p.host);
    }
    mounted = [];
  }

  NS.adapter = {
    VERSION: C.VERSION,
    DEFAULT_ORDER: DEFAULT_ORDER,
    // THE scope mechanism on the v1 page. Installed by js/margin-explorer.js at
    // build (applyScope(patch) with the contract's scope names); the panels
    // resolve it at call time and never keep a reference. Null until installed.
    applyScope: null,
    vmFromV1: vmFromV1,
    phaseStatus: phaseStatus,
    scopeFromV1: scopeFromV1,
    mountPanels: mountPanels,
    renderAll: renderAll,
    renderStaleAll: renderStaleAll,
    setStatusAll: setStatusAll,
    destroyPanels: destroyPanels,
    panels: function () { return mounted.slice(); }
  };
})();
