/* ============================================================================
 * mexp2-controller.js — Margin Explorer v2 · THE PAGE CONTROLLER
 * ----------------------------------------------------------------------------
 * Exposes window.loadMarginExplorerV2() (the shell's loadPage hook) and
 * window.MEXP2_destroy(). Everything else lives on MEXP2.controller.
 *
 * WHAT THIS FILE OWNS
 *   - The shell DOM inside #pg-mexp2: header, MARGIN DEFINITION line, filter
 *     bar, the DRILL RAIL + breadcrumb block (placed directly above the
 *     matrix panel), panel hosts, drawer + scrim. Built once (idempotent).
 *   - THE DRILL RAIL (v2.1): "DRILL BY" + one chip per C.GROUP_BYS value. A
 *     chip click sets groupBy and the matrix re-cuts; it is the ONE way to
 *     change group_by (the old <select> is gone). A chip pick, a matrix row
 *     click and a crumb click all go through scopePatch -> api.applyScope:
 *     one code path, so the store sees the identical action sequence
 *     (STALE -> SCOPE -> load). The drill PATH is preserved on a chip pick —
 *     that is what makes "Region, then BU, then Customer" a drill and not
 *     three unrelated cuts. Honesty tiers are the contract's: a Region / BU /
 *     Customer crumb re-scopes the server (C.DRILL_FILTER); every other dim
 *     is a client-side row filter on the matrix and the other panels carry
 *     the "Not scoped to X" badge. The DSM chip says "client-side" on its
 *     face and its tooltip names the backend change (BACKEND.md). Each chip
 *     shows a row count once that cut has been seen this session — read
 *     from the api cache with a NON-TOUCHING peek; nothing is fetched
 *     speculatively, one SAP query per click.
 *   - Seeding the scope on FIRST mount only: shell globals (window.PD,
 *     window.VF_REF_MONTH, window.RG — the three v1 reads, margin-explorer.js
 *     :864-885), then the deep link (MEXP2.url) on top.
 *   - Mounting every panel in the MEXP2.panel registry, in registration
 *     order, and the ONE try/catch render loop on store.subscribe.
 *   - [data-mx2-status] on every panel root. CSS does the chrome; no opacity,
 *     no display is ever written from here.
 *   - The ONE document-level Escape handler (C.ESCAPE precedence).
 *   - Page-leave detection: a MutationObserver on the page div's class
 *     attribute. NOT a navTo wrapper — app.html already wraps navTo once
 *     (wrapNavForInv, :8836) and chained wrappers break the moment either
 *     side is edited; an observer needs nothing from the shell.
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never fetch directly (MEXP2.api), never mutate store state (dispatch
 *     only), never format a number (MEXP2.fmt), never write a colour.
 *   - Never route unit through applyScope: unit/sort are VIEW (C.SEQ_RULE).
 *   - Never register beforeunload/unload (C.WINDOW_LISTENERS).
 *   - Never console.*, never touch margin-explorer*.js or window.apiFetch.
 * THEME: dark is data-theme="" (empty), light is "light". No CSS here.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-controller: mexp2-contract.js must load before this file.");

  var PAGE_ID = "pg-mexp2";            // the shell's page div (INTEGRATION.md)
  var DEFINITION = "GM is invoice-line revenue minus item cost, GROSS of off-invoice discount; net-of-discount is shown separately.";

  // DRILL RAIL copy. The DSM tooltip is verbatim owner-facing text: the API
  // accepts region / bu / customer as WHERE filters only (WIRE.PARAMS); dsm is
  // a group_by DIM, so a DSM crumb can only filter matrix rows client-side.
  var RAIL = {
    label: "Drill by",
    reset: "Reset drill",
    tag_client: "client-side",
    tip_server: "Re-scopes the server: the API accepts this dimension as a filter, so every panel follows the drill.",
    tip_client: "Client-side row filter on the matrix only. The API accepts region, bu and customer filters; other panels keep the server scope and say so.",
    tip_dsm: "The API accepts region, bu and customer filters only. DSM scoping of the bridge needs the backend change in BACKEND.md.",
    seen: " rows in this cut (seen this session)"
  };

  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level](msg, data); } catch (e) {}
  }
  function fmt() { return NS.fmt; }
  function esc(s) { return NS.fmt ? NS.fmt.esc(s) : String(s == null ? "" : s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function on(target, type, fn) { target.addEventListener(type, fn); return function () { target.removeEventListener(type, fn); }; }
  // Show/hide by DOM membership, never by inline style or [hidden]: mexp2.css
  // gives .mx2-btn / .mx2-stale-banner a display value, which beats the UA
  // [hidden] rule, and no v2 JS may write display/opacity (CSS owns chrome).
  function show(parent, node, yes, before) {
    var inDom = node.parentNode === parent;
    if (yes && !inDom) { if (before && before.parentNode === parent) parent.insertBefore(node, before); else parent.appendChild(node); }
    else if (!yes && inDom) parent.removeChild(node);
  }

  /* ==========================================================================
   * STATE (this file's only mutable state; the scope lives in the store)
   * ======================================================================= */
  var host = null, root = null, refs = {}, panels = [], unsubscribe = null;
  var built = false, seeded = false, active = false, drawerOpen = false;
  var escOff = null, observer = null, offs = [];

  /* ==========================================================================
   * PLACEHOLDER PANEL — used when the registry is empty. Implements the full
   * lifecycle; renders the state name, the scope label and the thesis line
   * (reported GM/kg beside net-of-discount GM/kg) so the page shows the true
   * number even before the real panels land.
   * ======================================================================= */
  function placeholder(id, title, slot, phase) {
    var h = null, nodes = null;
    function overlayLine(core) {
      var ov = core && core.discount_overlay, F = fmt();
      if (ov == null || !F) return "";
      return "GM/kg reported " + F.perKg(ov.gm_per_kg_reported) + " · net of off-invoice discount " + F.perKg(ov.gm_per_kg_net_of_discount) +
        (ov.discount_pct_of_reported_gm == null ? "" : " · discount is " + F.pct(ov.discount_pct_of_reported_gm) + " of reported GM");
    }
    function paint(label, state, core, diss, stale) {
      nodes.state.textContent = state;
      nodes.label.textContent = label;
      nodes.line.textContent = (phase === "diss")
        ? ((diss && diss.available !== false && diss.base_month) ? "Anchors " + diss.base_month + " → " + diss.compare_month + " · " + C.UNIVERSES.dissection
                                                                  : (diss && diss.reason) ? String(diss.reason) : "")
        : overlayLine(core);
      show(nodes.body, nodes.banner, stale, nodes.line);
      if (h.classList) { if (stale) h.classList.add("mx2-is-stale"); else h.classList.remove("mx2-is-stale"); }
    }
    return {
      slot: slot, phase: phase,
      mount: function (hostEl) {
        h = hostEl;
        var head = el("div", "mx2-panel-h"), col = el("div", "mx2-panel-hcol"), body = el("div", "mx2-dimmable");
        col.appendChild(el("div", "mx2-panel-t", title));
        nodes = { label: el("div", "mx2-panel-st"), state: el("span", "mx2-chip"), line: el("div", "mx2-note"), banner: el("div", "mx2-stale-banner"), body: body };
        col.appendChild(nodes.label);
        head.appendChild(col); head.appendChild(nodes.state);
        body.appendChild(nodes.line);
        h.appendChild(head); h.appendChild(body);
        h.appendChild(stateBlock("loading-first", C.STATE_COPY["loading-first"], ""));
        h.appendChild(stateBlock("empty-scope", C.STATE_COPY["empty-scope"], C.STATE_COPY["empty-scope-hint"]));
        h.appendChild(stateBlock("unavailable-for-scope", C.STATE_COPY["unavailable-for-scope"], ""));
        h.appendChild(stateBlock("errored", C.STATE_COPY.errored, ""));
      },
      render: function (vm) { paint(vm.label, vm.status, vm.core, vm.diss, false); },
      renderStale: function (prev, vm) {
        paint(vm.label, vm.status, prev.core, prev.diss, true);
        nodes.banner.textContent = "Showing previous scope: ";
        nodes.banner.appendChild(el("span", "mx2-stale-label", prev.label));
      },
      setStatus: function (state) { if (nodes) nodes.state.textContent = state; },
      destroy: function () { if (h) h.innerHTML = ""; h = null; nodes = null; }
    };
  }
  function stateBlock(state, title, hint) {
    var b = el("div", "mx2-msg"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", title));
    if (hint) b.appendChild(el("div", "mx2-msg-h", hint));
    return b;
  }
  var PLACEHOLDERS = [["hero", "Hero KPIs", "body", "core"], ["overlay", "Discount overlay", "body", "core"],
    ["matrix", "Margin matrix", "body", "core"], ["bridge", "GM/ton bridge", "body", "core"], ["dissection", "Dissection", "stack", "diss"]];

  /* ==========================================================================
   * DOM
   * ======================================================================= */
  function chip(text, value, group) {
    var b = el("button", "mx2-chip", text); b.type = "button"; b.setAttribute("data-mx2-value", value); b.setAttribute("data-mx2-group", group); b.setAttribute("aria-pressed", "false");
    return b;
  }
  function chips(group, values, labels) {
    var wrap = el("div", "mx2-fgroup"), i, lab = el("span", "mx2-flabel", group === "groupBy" ? "Group" : group);
    wrap.appendChild(lab);
    for (i = 0; i < values.length; i++) wrap.appendChild(chip(labels ? (labels[values[i]] || values[i]) : values[i], values[i], group));
    return wrap;
  }
  function select(group, values, labels) {
    var wrap = el("div", "mx2-fgroup"), s = el("select", "mx2-select"), i, o;
    wrap.appendChild(el("span", "mx2-flabel", group === "groupBy" ? "Group by" : group));
    for (i = 0; i < values.length; i++) { o = el("option", null, labels ? (labels[values[i]] || values[i]) : values[i]); o.value = values[i]; s.appendChild(o); }
    s.setAttribute("data-mx2-group", group); s.setAttribute("aria-label", group);
    wrap.appendChild(s); refs[group] = s;
    return wrap;
  }
  function divider() { return el("span", "mx2-fdivider"); }

  function build() {
    root = el("div", "mx2-wrap"); root.id = C.ROOT_ID;   // css/mexp2.css scopes on #pg-margin-explorer-2
    var head = el("div", "mx2-head"), hl = el("div", "mx2-head-l"), hr = el("div", "mx2-head-r"), t = el("div", "mx2-title", "Margin Explorer v2 ");
    t.appendChild(el("span", "mx2-chip", "preview"));
    hl.appendChild(t);
    hl.appendChild(el("div", "mx2-sub", DEFINITION));
    refs.scopeLabel = el("div", "mx2-scope-label"); hl.appendChild(refs.scopeLabel);
    refs.hr = hr;
    refs.pill = el("span", "mx2-chip", "");
    refs.err = el("span", "mx2-note mx2-neg");
    refs.retry = el("button", "mx2-btn mx2-btn-retry", "Retry"); refs.retry.type = "button";
    head.appendChild(hl); head.appendChild(hr);

    var f = el("div", "mx2-filters");
    f.appendChild(chips("period", C.PERIODS, C.LABELS.period)); f.appendChild(divider());
    f.appendChild(select("region", C.REGIONS)); f.appendChild(select("bu", C.BUS)); f.appendChild(divider());
    // group_by has NO control here: the drill rail above the matrix is the one way to cut.
    f.appendChild(chips("compare", C.COMPARES, C.LABELS.compare)); f.appendChild(divider());
    f.appendChild(chips("unit", C.UNITS, C.LABELS.unit)); f.appendChild(divider());
    var cg = el("div", "mx2-fgroup"); cg.appendChild(el("span", "mx2-flabel", "Customer"));
    refs.customer = el("input", "mx2-input"); refs.customer.type = "search"; refs.customer.placeholder = "Card code or name"; refs.customer.setAttribute("aria-label", "Customer");
    cg.appendChild(refs.customer); f.appendChild(cg);
    refs.reset = el("button", "mx2-btn mx2-btn-quiet", "Reset"); refs.reset.type = "button"; f.appendChild(refs.reset);

    buildDrill();   // refs.drill = rail + crumbs; placed above the matrix by placeDrill()
    refs.slots = { hero: el("div", "mx2-hero"), body: el("div", "mx2-body"), stack: el("div", "mx2-stack") };

    refs.scrim = el("div", "mx2-scrim"); refs.drawer = el("aside", "mx2-drawer"); refs.drawer.setAttribute("aria-hidden", "true");
    var dh = el("div", "mx2-drawer-h"); refs.drawerTitle = el("div", "mx2-drawer-t"); refs.drawerClose = el("button", "mx2-btn mx2-btn-ghost", "Close"); refs.drawerClose.type = "button";
    dh.appendChild(refs.drawerTitle); dh.appendChild(refs.drawerClose); refs.drawer.appendChild(dh);
    refs.drawerBody = el("div", "mx2-stack"); refs.drawer.appendChild(refs.drawerBody);

    root.appendChild(head); root.appendChild(f);
    root.appendChild(refs.slots.hero); root.appendChild(refs.slots.body); root.appendChild(refs.slots.stack);
    root.appendChild(refs.scrim); root.appendChild(refs.drawer);
    host.appendChild(root);
    bindFilters();
  }

  /* ==========================================================================
   * DRILL RAIL + BREADCRUMB BLOCK
   * "DRILL BY" then one chip per group_by; the crumbs sit under the rail.
   * Chips carry data-mx2-group="groupBy" so reflect()'s ONE aria-pressed loop
   * marks the active cut exactly as it marks period / compare / unit.
   * ======================================================================= */
  function railTier(g) { return C.DRILL_FILTER[g] ? "server" : "client"; }
  function buildDrill() {
    var i, g, b, lab, scroll, list = el("div", "mx2-rail-chips");
    refs.drill = el("div", "mx2-drill");
    refs.rail = el("div", "mx2-rail"); refs.rail.setAttribute("role", "toolbar"); refs.rail.setAttribute("aria-label", RAIL.label);
    lab = el("span", "mx2-flabel mx2-rail-label", RAIL.label); lab.id = C.ROOT_ID + "-rail-label";
    list.setAttribute("aria-labelledby", lab.id);
    refs.railChips = [];
    for (i = 0; i < C.GROUP_BYS.length; i++) {
      g = C.GROUP_BYS[i];
      b = chip(C.LABELS.groupBy[g] || g, g, "groupBy");
      b.className = "mx2-chip mx2-rail-chip";
      b.setAttribute("data-mx2-tier", railTier(g));
      b.setAttribute("tabindex", "-1");
      b.title = (g === "dsm") ? RAIL.tip_dsm : (railTier(g) === "server" ? RAIL.tip_server : RAIL.tip_client);
      if (g === "dsm") b.appendChild(el("span", "mx2-rail-tag", RAIL.tag_client));
      b.appendChild(el("span", "mx2-rail-n", ""));
      list.appendChild(b); refs.railChips.push(b);
    }
    scroll = el("div", "mx2-rail-scroll"); scroll.appendChild(list);
    refs.railReset = el("button", "mx2-btn mx2-btn-quiet mx2-rail-reset", RAIL.reset); refs.railReset.type = "button";
    refs.rail.appendChild(lab); refs.rail.appendChild(scroll); refs.rail.appendChild(refs.railReset);
    refs.crumbs = el("nav", "mx2-crumbs"); refs.crumbs.setAttribute("aria-label", "Drill path");
    refs.drill.appendChild(refs.rail); refs.drill.appendChild(refs.crumbs);
  }
  // Directly above the matrix panel (the first drillAware host in the body
  // slot); with no such panel, at the top of the body slot. Idempotent.
  function placeDrill() {
    var i, before = null, body = refs.slots.body;
    for (i = 0; i < panels.length; i++) if (panels[i].drillAware && panels[i].host.parentNode === body) { before = panels[i].host; break; }
    if (!before) for (i = 0; i < panels.length; i++) if (panels[i].id === "matrix" && panels[i].host.parentNode === body) { before = panels[i].host; break; }
    show(body, refs.drill, true, before || body.firstChild);
  }
  // THE pick. Same path as a matrix row click (controller.drillInto) and a
  // crumb click: scopePatch -> api.applyScope -> STALE, SCOPE, load. The
  // drill path is kept; only the cut changes. An already-active chip is a
  // no-op (no same-key SCOPE, nothing dispatched).
  function railPick(g) {
    if (!C.LABELS.groupBy[g]) return null;
    if (NS.store.get().scope.groupBy === g) return null;
    return scopePatch({ groupBy: g });
  }
  function railIndexOf(node) {
    var i;
    for (i = 0; i < refs.railChips.length; i++) if (refs.railChips[i] === node) return i;
    return -1;
  }
  function railFocus(idx) {
    var i, n = refs.railChips.length;
    if (!n) return;
    if (idx < 0) idx = n - 1;
    if (idx >= n) idx = 0;
    for (i = 0; i < n; i++) refs.railChips[i].setAttribute("tabindex", i === idx ? "0" : "-1");
    refs.railChips[idx].focus();
  }
  // Roving tabindex: arrows move, Home/End jump; Enter/Space are the native
  // button activation (one click path, nothing duplicated here).
  function onRailKey(ev) {
    var idx = railIndexOf(ev.target), key = ev.key;
    if (idx < 0) return;
    if (key === "ArrowRight" || key === "Right" || key === "ArrowDown" || key === "Down" || ev.keyCode === 39 || ev.keyCode === 40) { ev.preventDefault(); railFocus(idx + 1); }
    else if (key === "ArrowLeft" || key === "Left" || key === "ArrowUp" || key === "Up" || ev.keyCode === 37 || ev.keyCode === 38) { ev.preventDefault(); railFocus(idx - 1); }
    else if (key === "Home" || ev.keyCode === 36) { ev.preventDefault(); railFocus(0); }
    else if (key === "End" || ev.keyCode === 35) { ev.preventDefault(); railFocus(refs.railChips.length - 1); }
  }
  // Row count for one cut, from the api cache ONLY (non-touching peek), or
  // null when that cut has not been seen this session. Never fetches.
  function railCount(g) {
    var key, hit, body, rows;
    if (!NS.api || typeof NS.api.cachePeek !== "function" || typeof NS.store.previewKey !== "function") return null;
    try { key = NS.store.previewKey({ groupBy: g }); hit = NS.api.cachePeek(key, "core"); } catch (e) { return null; }
    if (!hit || !hit.body || typeof hit.body !== "object") return null;
    body = hit.body;
    if (!body.matrix && body.data && typeof body.data === "object") body = body.data;   // gateway envelope
    rows = body.matrix && body.matrix.rows;
    if (!rows || typeof rows.length !== "number") return null;
    return rows.length;
  }
  // A cardinality, not a measure: MEXP2.fmt has no bare-integer formatter and
  // a count carries no unit, so it is guarded through fmt.toNum and grouped.
  function countText(n) {
    var F = fmt(), v = F ? F.toNum(n) : ((n == null) ? null : +n);
    if (v === null || v !== v) return "";
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function reflectRail(s) {
    var i, b, g, n, active = -1, focused = -1;
    for (i = 0; i < refs.railChips.length; i++) {
      b = refs.railChips[i]; g = b.getAttribute("data-mx2-value");
      if (g === s.groupBy) active = i;
      if (b === document.activeElement) focused = i;
      n = railCount(g);
      b.lastChild.textContent = countText(n);
      b.setAttribute("aria-label", (C.LABELS.groupBy[g] || g) + (g === "dsm" ? " (" + RAIL.tag_client + ")" : "") + (n === null ? "" : ", " + countText(n) + RAIL.seen));
    }
    // Roving tab stop: the focused chip keeps it mid-navigation, else the active one.
    n = focused >= 0 ? focused : (active >= 0 ? active : 0);
    for (i = 0; i < refs.railChips.length; i++) refs.railChips[i].setAttribute("tabindex", i === n ? "0" : "-1");
    refs.railReset.disabled = !(s.drill && s.drill.length);
  }

  function bindFilters() {
    offs.push(on(root, "click", function (ev) {
      var b = ev.target, g, v;
      while (b && b !== root && !(b.getAttribute && b.getAttribute("data-mx2-group"))) b = b.parentNode;
      if (!b || b === root || b.tagName === "SELECT") return;
      g = b.getAttribute("data-mx2-group"); v = b.getAttribute("data-mx2-value");
      if (g === "unit") { NS.store.dispatch({ type: C.ACTION.VIEW, payload: { unit: v } }); return; }
      if (g === "groupBy") { railPick(v); return; }     // the rail: keeps the drill path
      var patch = { drill: [] }; patch[g] = v; scopePatch(patch);
    }));
    offs.push(on(refs.rail, "keydown", onRailKey));
    offs.push(on(refs.railReset, "click", function () { scopePatch({ drill: [] }); }));
    offs.push(on(root, "change", function (ev) {
      var s = ev.target, g = s && s.getAttribute && s.getAttribute("data-mx2-group"), patch;
      if (!g || s.tagName !== "SELECT") return;
      patch = { drill: [] }; patch[g] = s.value; scopePatch(patch);
    }));
    offs.push(on(refs.customer, "input", function () { NS.api.debounceCustomer(refs.customer.value); }));
    offs.push(on(refs.customer, "keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); NS.api.flushCustomer(); } }));
    offs.push(on(refs.reset, "click", function () {
      refs.customer.value = "";
      NS.api.cancelCustomer();
      NS.store.dispatch({ type: C.ACTION.RESET, payload: { keepView: true } });
      NS.api.load();
    }));
    offs.push(on(refs.retry, "click", function () { NS.api.load(); }));
    offs.push(on(refs.crumbs, "click", function (ev) {
      var b = ev.target, n;
      while (b && b !== refs.crumbs && !(b.getAttribute && b.getAttribute("data-mx2-depth"))) b = b.parentNode;
      if (!b || b === refs.crumbs) return;
      n = +b.getAttribute("data-mx2-depth");
      scopePatch({ drill: NS.store.get().scope.drill.slice(0, n) });
    }));
    offs.push(on(refs.scrim, "click", closeDrawer));
    offs.push(on(refs.drawerClose, "click", closeDrawer));
  }

  function scopePatch(patch) { return NS.api.applyScope(patch); }

  /* ==========================================================================
   * PANELS
   * ======================================================================= */
  // THE MOUNT LIST. Ids named here mount first, in this order, whatever order
  // their script tags loaded in; any other registered panel follows in
  // registration order. The hero KPI panel (mexp2-panel-kpi.js) is first: it
  // carries the thesis (reported vs net-of-discount GM/kg) and sits in the
  // hero slot above everything else. "From reported to realised margin"
  // (mexp2-panel-g2n.js, phase B) comes next, full-width at the top of the
  // body slot — directly under the hero and above the matrix. The drill
  // matrix (mexp2-panel-matrix.js) follows, then the GM/ton bridge
  // (mexp2-panel-bridge.js, phase B) beside it. "What moved margin, and where
  // to look" (mexp2-panel-insight.js, phase B) closes the body, full-width
  // BELOW the bridge: prose computed from blocks already on the wire.
  var PANEL_ORDER = ["kpi", "g2n", "matrix", "bridge", "insight"];
  function orderedIds(ids) {
    var out = [], i, j, seen;
    for (i = 0; i < PANEL_ORDER.length; i++) for (j = 0; j < ids.length; j++) if (ids[j] === PANEL_ORDER[i]) out.push(ids[j]);
    for (j = 0; j < ids.length; j++) {
      seen = false;
      for (i = 0; i < out.length; i++) if (out[i] === ids[j]) seen = true;
      if (!seen) out.push(ids[j]);
    }
    return out;
  }

  function mountPanels() {
    var ids = orderedIds((NS.panel && NS.panel.list) ? NS.panel.list() : []), i, def, inst, h, slot;
    if (!ids.length) {
      dbg("info", "no panels registered — mounting placeholders");
      for (i = 0; i < PLACEHOLDERS.length; i++) mountOne(PLACEHOLDERS[i][0], placeholder.apply(null, PLACEHOLDERS[i]));
      placeDrill();
      return;
    }
    for (i = 0; i < ids.length; i++) {
      if (/:instance$/.test(ids[i])) continue;
      inst = NS.panel.create(ids[i]);
      if (inst) mountOne(ids[i], inst);
    }
    placeDrill();
    function mountOne(id, p) {
      slot = refs.slots[p.slot] ? p.slot : "stack";
      h = el("section", "mx2-panel"); h.setAttribute("data-mx2-panel", id); h.setAttribute("data-mx2-status", C.STATE.LOADING_FIRST);
      refs.slots[slot].appendChild(h);
      try { p.mount(h); } catch (e) { dbg("fail", "panel mount threw", { id: id, message: e && e.message }); }
      panels.push({ id: id, inst: p, host: h, phase: p.phase === "diss" ? "diss" : "core", drillAware: p.drillAware === true, badge: null });
    }
  }

  // UNSCOPED BADGE. A drill crumb whose dim is not a server filter
  // (C.DRILL_FILTER: region / bu / customer) is a CLIENT-SIDE filter that only
  // a drillAware panel (the matrix) applies. Every other panel keeps showing
  // the server scope, and says so with a badge at the top of its card — by
  // DOM membership, text only, no chrome written from here.
  function unscopedCrumbs(scope) {
    var out = [], d = (scope && scope.drill) || [], i;
    for (i = 0; i < d.length; i++) if (d[i] && d[i].dim != null && !C.DRILL_FILTER[d[i].dim]) out.push(d[i]);
    return out;
  }
  function badgePanel(p, crumbs) {
    var i, b, span;
    if (p.drillAware || !crumbs.length) { if (p.badge) show(p.host, p.badge, false); return; }
    if (!p.badge) p.badge = el("div", "mx2-unscoped");
    b = p.badge; b.innerHTML = "";
    b.appendChild(el("span", "", "Not scoped to"));
    for (i = 0; i < crumbs.length; i++) {
      span = el("span", "mx2-unscoped-label", (C.LABELS.groupBy[crumbs[i].dim] || crumbs[i].dim) + ": " + (crumbs[i].label == null ? crumbs[i].value : crumbs[i].label));
      b.appendChild(span);
    }
    b.appendChild(el("span", "", "— a client-side filter on the matrix only; this panel shows the server scope"));
    show(p.host, b, true, p.host.firstChild);
  }

  // THE render loop. One try/catch; a throwing panel is logged and shown as
  // errored, and never stops the panels after it.
  function render(vm) {
    var i, p, status, rule, live, stale, crumbs = unscopedCrumbs(vm.scope);
    reflect(vm);
    for (i = 0; i < panels.length; i++) {
      p = panels[i];
      try {
        badgePanel(p, crumbs);
        status = (p.phase === "diss") ? NS.store.statusFor("diss") : vm.status;
        rule = C.STATE_RULES[status] || C.STATE_RULES.fresh;
        live = (p.phase === "diss") ? vm.diss : vm.core;
        stale = !!(rule.preservePrior && live == null && vm.prev);
        p.host.setAttribute("data-mx2-status", status);
        p.inst.setStatus(status);
        if (stale) p.inst.renderStale(vm.prev, vm); else p.inst.render(vm);
      } catch (e) {
        dbg("fail", "panel render threw", { id: p.id, message: e && e.message });
        p.host.setAttribute("data-mx2-status", C.STATE.ERRORED);
      }
    }
  }

  // Chrome outside the panels: scope label, pill, error line, filters, crumbs, hash.
  function reflect(vm) {
    var s = vm.scope, i, n, list, c, err;
    refs.scopeLabel.textContent = vm.label;
    refs.pill.textContent = C.pillText(vm.status);
    err = vm.status === C.STATE.ERRORED;
    show(refs.hr, refs.err, err); show(refs.hr, refs.retry, err); show(refs.hr, refs.pill, !!C.pillText(vm.status));
    if (err) refs.err.textContent = vm.core ? C.STATE_COPY["errored-stale"] : (C.STATE_COPY.errored + (vm.error && vm.error.message ? " (" + vm.error.message + ")" : ""));
    list = root.querySelectorAll(".mx2-chip[data-mx2-group]");
    for (i = 0; i < list.length; i++) { c = list[i]; c.setAttribute("aria-pressed", String(s[c.getAttribute("data-mx2-group")]) === c.getAttribute("data-mx2-value") ? "true" : "false"); }
    refs.region.value = s.region; refs.bu.value = s.bu;
    reflectRail(s);
    if (document.activeElement !== refs.customer) refs.customer.value = s.customer || "";
    refs.crumbs.innerHTML = "";
    c = el("button", "mx2-crumb", "All"); c.type = "button"; c.setAttribute("data-mx2-depth", "0"); refs.crumbs.appendChild(c);
    for (n = 0; n < s.drill.length; n++) {
      refs.crumbs.appendChild(el("span", "mx2-crumb-sep", "›"));
      c = el("button", "mx2-crumb", (C.LABELS.groupBy[s.drill[n].dim] || s.drill[n].dim) + ": " + s.drill[n].label); c.type = "button"; c.setAttribute("data-mx2-depth", String(n + 1));
      refs.crumbs.appendChild(c);
    }
    if (active && NS.url) NS.url.write(s);
  }

  /* ==========================================================================
   * DRAWER + ESCAPE (C.ESCAPE: drawer, then one crumb, then NOTHING)
   * ======================================================================= */
  function openDrawer(title, content) {
    refs.drawerTitle.textContent = title == null ? "" : String(title);
    refs.drawerBody.innerHTML = "";
    if (content && content.nodeType) refs.drawerBody.appendChild(content);
    else if (content != null) refs.drawerBody.innerHTML = String(content);
    refs.drawer.classList.add("is-open"); refs.scrim.classList.add("is-open"); refs.drawer.setAttribute("aria-hidden", "false");
    drawerOpen = true;
  }
  function closeDrawer() {
    if (!refs.drawer) return;
    refs.drawer.classList.remove("is-open"); refs.scrim.classList.remove("is-open"); refs.drawer.setAttribute("aria-hidden", "true");
    drawerOpen = false;
  }
  function onKey(ev) {
    if (ev.key !== C.ESCAPE.KEY && ev.key !== C.ESCAPE.LEGACY_KEY && ev.keyCode !== 27) return;
    if (drawerOpen) { ev.stopPropagation(); ev.preventDefault(); closeDrawer(); return; }
    var d = NS.store.get().scope.drill;
    if (d.length > 0) { ev.stopPropagation(); ev.preventDefault(); scopePatch({ drill: d.slice(0, d.length - 1) }); return; }
    // otherwise: nothing. The shell's own Escape handling must still run.
  }

  /* ==========================================================================
   * SEED (first mount only), PAGE LEAVE, LIFECYCLE
   * ======================================================================= */
  function seedPatch() {
    var p = { drill: [] }, pd = window.PD, rm = window.VF_REF_MONTH, rg = window.RG, link, k;
    // v1 parity (margin-explorer.js:872-874): MTD stays MTD; anything else lands on QTD.
    if (typeof pd === "string" && pd) p.period = (pd === "MTD") ? "MTD" : "QTD";
    if (typeof rm === "string" && /^\d{4}-\d{2}$/.test(rm)) p.refMonth = rm;
    if (typeof rg === "string" && rg) p.region = rg;
    link = NS.url ? NS.url.read() : null;      // the deep link wins over the topbar
    if (link) for (k in link) if (Object.prototype.hasOwnProperty.call(link, k)) p[k] = link[k];
    return p;
  }

  function onPageLeave() {
    active = false;
    closeDrawer();
    if (escOff) { escOff(); escOff = null; }
    NS.api.cancelCustomer();
    NS.api.abortAll("page-leave");
    NS.api.destroy();
    dbg("info", "page left");
  }
  function watchPage() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(function () {
      if (active && host.className.split(/\s+/).indexOf("active") < 0) onPageLeave();
    });
    observer.observe(host, { attributes: true, attributeFilter: ["class"] });
  }

  function mount() {
    host = document.getElementById(PAGE_ID) || document.getElementById(C.ROOT_ID);
    if (!host) { dbg("warn", "mount: #" + PAGE_ID + " not found"); return false; }
    if (!NS.store || !NS.api) { dbg("fail", "mount: store/api missing (load order)"); return false; }
    if (!built) {
      build();
      mountPanels();
      built = true;
    }
    if (!seeded) {
      NS.store.dispatch({ type: C.ACTION.SCOPE, payload: { patch: seedPatch(), seq: NS.store.get().seq + 1 } });
      seeded = true;
    }
    active = true;
    NS.api.mount();
    if (!escOff) escOff = on(document, "keydown", onKey);
    if (!unsubscribe) unsubscribe = NS.store.subscribe(render);
    watchPage();
    render(NS.store.viewModel());
    NS.api.load();
    return true;
  }

  function destroy() {
    var i;
    active = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (escOff) { escOff(); escOff = null; }
    if (observer) { observer.disconnect(); observer = null; }
    for (i = 0; i < offs.length; i++) { try { offs[i](); } catch (e) {} }
    offs = [];
    for (i = 0; i < panels.length; i++) { try { panels[i].inst.destroy(); } catch (e) { dbg("fail", "panel destroy threw", panels[i].id); } }
    panels = [];
    try { if (NS.svg) NS.svg.destroyAll(); } catch (e) {}
    try { if (NS.charts) NS.charts.destroyAll(); } catch (e) {}
    NS.api.destroy();
    if (host) host.innerHTML = "";
    root = null; refs = {}; built = false; seeded = false; drawerOpen = false; host = null;
    dbg("info", "destroyed");
  }

  NS.controller = {
    VERSION: C.VERSION, PAGE_ID: PAGE_ID, DEFINITION: DEFINITION,
    mount: mount, destroy: destroy,
    openDrawer: openDrawer, closeDrawer: closeDrawer,
    drillInto: function (crumb) { return scopePatch({ drill: NS.store.get().scope.drill.concat([crumb]) }); },
    drillBy: railPick,                 // the rail's pick: same scopePatch path as drillInto
    resetDrill: function () { return scopePatch({ drill: [] }); },
    applyScope: scopePatch,
    RAIL: RAIL,
    isMounted: function () { return built; }, isActive: function () { return active; },
    placeholder: placeholder
  };
  window.loadMarginExplorerV2 = mount;
  window.MEXP2_destroy = destroy;
})();
