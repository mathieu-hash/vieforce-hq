/* ============================================================================
 * mexp2-panel-trendmatrix.js — Margin Explorer · THE HERO: MONTHLY CATEGORY
 * MARGIN TABLE (MEXP2.panel "trendmatrix", phase B)
 * ----------------------------------------------------------------------------
 * WHAT THIS PANEL SHOWS
 *   diss.category_trend (WIRE.CATEGORY_TREND, cube:categoryTrend): one row per
 *   product category (SSG) with its tonnage under the name, biggest volume
 *   first (wire order), one column per month of the trailing-12 cube spine,
 *   the running month marked partial and dashed, and the payload's VOLUME-
 *   WEIGHTED avg[] row at the bottom — never recomputed here. This reproduces
 *   v1's renderCategoryTable (js/margin-explorer-dissection.js) and adds the
 *   owner's asks:
 *
 *   FILTER RAIL (directly above the table)
 *     Region / BU / Customer re-scope the WHOLE page through the one scope
 *     mechanism (dispatchScope below) — the table inherits them server-side
 *     (category_trend is cut by region/bu/customer, WIRE.PARAMS). DSM is NOT
 *     an API filter (dsm is a group_by dim only): the DSM control carries a
 *     "client-side" tag, the tooltip names the backend change (BACKEND.md B1)
 *     and a pick dispatches a {dim:"dsm"} drill crumb — a client-side row
 *     filter on the single-period matrix only. This table cannot apply it
 *     and says so in a note. The Category multi-select hides rows WITHOUT
 *     changing scope (client-side, labelled).
 *   UNIT  PHP/ton | GM% | GP | MT. A cell carries {month, gm_ton, gm_pct,
 *     tons}; GP is gm_ton × tons and is labelled DERIVED (tons is a rounded
 *     integer on the wire, so GP is approximate).
 *   WINDOW  trailing 12 months (default, as today) or the selected period's
 *     months (diss.base_month .. the current-side window end).
 *   THIN-TONNAGE GUARD  a cell under THIN_MT (5 MT) shows the dash with the
 *     tonnage in its tooltip, never a per-ton figure; the footer counts the
 *     withheld cells. This kills the Untagged PHP 4,519,296/t artefact.
 *   ROW CLICK  dispatches an SSG drill crumb (client-side tier; the
 *     controller/adapter badges server-computed panels). CELL / MONTH-HEADER
 *     CLICK sets that month as the requested bridge anchor (refMonth ->
 *     ref_month on the API) so the bridges re-run for that month pair; a
 *     second click on the anchored month returns to live.
 *   EXPORT  the shell's exportTableToXlsx(table, name) with the basis line
 *     as the first header row.
 *
 * THE SCOPE MECHANISM (one, never a second)
 *   dispatchScope(patch) resolves, at call time, the first of:
 *     MEXP2.adapter.applyScope  (the v1 seam, when the page is v1-driven)
 *     window.MEXP_applyScope    (the same seam exposed as a global)
 *     MEXP2.controller.applyScope (the v2 controller, when it is mounted)
 *     MEXP2.api.applyScope      (the store path)
 *   `patch` uses the contract's scope field names (C.DEFAULT_SCOPE):
 *   { region, bu, customer, refMonth, drill }. Nothing here fetches, mutates
 *   v1 STATE, or touches the store beyond that call.
 *
 * VIEW STATE
 *   unit / window / hidden categories are display-only and live in this file
 *   (VIEW). They never enter the scope key and never refetch. render(vm) is
 *   deterministic for (vm, VIEW).
 *
 * RULES THIS FILE OBEYS
 *   - Lifecycle per C.PANEL_LIFECYCLE. renderStale(prev, vm) paints prev.diss
 *     and PRINTS prev.label (header + gold banner); stale rows do not drill.
 *   - Every number through MEXP2.fmt; every colour via --mx2-* in mexp2.css;
 *     status chrome is CSS off [data-mx2-status]; show/hide by DOM
 *     membership. All classes .mx2-*. No console.*, no fetch.
 *   - Loading-first shows a skeleton WITH month headers (trailing 12 from the
 *     requested ref month, else the client clock — headers only) and never
 *     PHP 0.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-panel-trendmatrix: mexp2-contract.js must load before this file.");

  var PANEL_ID = "trendmatrix";
  var DASH = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var THIN_MT = (typeof C.THIN_TONNAGE_MT === "number") ? C.THIN_TONNAGE_MT : 5;
  var DEBOUNCE_MS = (typeof C.CUSTOMER_DEBOUNCE_MS === "number") ? C.CUSTOMER_DEBOUNCE_MS : 450;
  var SKEL_MONTHS = 12;
  var SKEL_ROWS = 6;
  var UNITS = ["ton", "gp_pct", "gp", "mt"];
  var WINDOWS = ["trailing", "period"];
  var REGIONS = C.REGIONS || ["ALL", "Luzon", "Visayas", "Mindanao"];
  var BUS = C.BUS || ["ALL", "DISTRIBUTION", "KEY ACCOUNTS", "PET CARE"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var COPY = {
    title: "Category margin by month",
    sub: "GM by SSG category · biggest volume first · inherits the Region / BU / Customer scope",
    basis: "Finished feed only (103) · " + C.BASIS_SUFFIX.reported + " · credit notes netted · GM/ton volume-weighted",
    universe: C.UNIVERSES.dissection,
    windowTrailing: "Trailing 12 months",
    windowPeriod: "Selected period",
    windowTrailingTip: "The cube's trailing 12 months ending at the anchor month (as the table has always shown).",
    windowPeriodTip: "Only the months inside the selected period: from the first complete month (base) to the current-side window end.",
    unit: { ton: "₱/ton", gp_pct: "GM%", gp: "GP", mt: "MT" },
    unitTip: {
      ton: "GM per ton, PHP · " + C.BASIS_SUFFIX.reported + " · volume-weighted",
      gp_pct: "GM as a percentage of revenue · " + C.BASIS_SUFFIX.reported,
      gp: "DERIVED: GM/ton × MT per cell. MT is a whole-ton rounding on the wire, so this GP is approximate — not a ledger figure.",
      mt: "Tonnage per cell, MT (whole tons on the wire)"
    },
    unitTag: { gp: "derived" },
    avgLabel: { ton: "AVG GM/t", gp_pct: "AVG GM%", gp: "TOTAL GP", mt: "TOTAL MT" },
    avgTip: "From the payload's volume-weighted avg[] row — not recomputed from the rows above (hidden rows do not change it).",
    avgTipGp: "Derived from the payload's avg[] row: avg GM/ton × total MT per month — approximate.",
    railRegion: "Region", railBu: "BU", railCustomer: "Customer", railDsm: "DSM", railCat: "Categories",
    railCatTag: "client-side", railDsmTag: "client-side",
    railCatTip: "Hides rows in this table only. The scope — and every other panel — is unchanged.",
    railDsmTip: "DSM scoping needs the backend change (B1); until then the page filters what it can",
    railDsmPlaceholder: "DSM name (client-side)",
    railDsmNoNames: "Group the matrix by DSM once to list names",
    railServerTip: "Re-scopes the server: the API accepts this filter, so every panel — including this table — follows it.",
    customerPlaceholder: "Card code or name",
    catAll: "All",
    catAllTip: "Show every category",
    exportBtn: "Export",
    exportTip: "Download this table as .xlsx with the basis line as the first row",
    exportName: "Category_margin_by_month",
    exportNoShell: "Export unavailable: the shell's exportTableToXlsx is not loaded.",
    partialTag: "part.",
    partialTip: "Running month — month-to-date only. Not comparable with a complete month.",
    anchorTag: "anchor",
    anchorTipA: "Requested bridge anchor (ref_month = ",
    anchorTipB: "). Click again to return to live.",
    monthTip: "Click to anchor the bridges on this month (sent as ref_month)",
    anchorsPrefix: "Bridge anchors ",
    anchorsWhy: " (first and last complete months in the period) · click a month to re-anchor",
    anchoredA: "anchored on ", anchoredB: " (as of)",
    live: "live",
    stalePrefix: "Showing previous scope: ",
    noVolume: "no volume — per-ton figure undefined (0 MT)",
    withheldA: "withheld: ", withheldB: " — under " + THIN_MT + " MT a per-ton figure is noise, not margin",
    withheldFootA: " cell", withheldFootB: " withheld under " + THIN_MT + " MT (hover a dash for the tonnage) — a per-ton figure at that volume is noise",
    withheldNone: "No cell under " + THIN_MT + " MT in view",
    partialFootA: " is a partial month (dashed) — month-to-date only",
    hiddenFootA: " categor", hiddenFootB: " hidden (client-side) — scope unchanged",
    tonsA: "MT · ", tonsTrailing: "12-month total (wire)", tonsPeriod: "sum of the visible months' rounded cells",
    zeroRow: "no volume in this window",
    dsmNoteA: "Not scoped to DSM: ", dsmNoteB: " — the API accepts no DSM filter; that crumb filters the matrix rows client-side only. This table shows the server scope.",
    ssgNoteA: "Drilled to ", ssgNoteB: " — highlighted here; server-computed panels carry the “not scoped” badge (SSG is not an API filter).",
    ctUnavailable: "No category trend for this scope.",
    rowsNote: " categories · ",
    monthsNote: " months",
    rowTip: "Click to drill into this category (client-side tier). Click again to clear."
  };

  /* -------------------------------------------------------------------------
   * helpers
   * ---------------------------------------------------------------------- */
  function dbg(level, msg, data) {
    try { var d = NS.debug; if (d && typeof d[level] === "function") d[level]("trendmatrix: " + msg, data); } catch (e) { /* silent */ }
  }
  function F() { return NS.fmt; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return !!v && typeof v === "object"; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function setText(node, text) { if (node) node.textContent = (text == null) ? "" : String(text); }
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
  function cls(node, name, onOff) {
    if (!node || !node.classList) return;
    if (onOff) node.classList.add(name); else node.classList.remove(name);
  }
  function on(target, type, fn) { target.addEventListener(type, fn); return function () { target.removeEventListener(type, fn); }; }
  function num(v) { var f = F(); return f ? f.toNum(v) : ((v == null || v === "") ? null : (isFinite(+v) ? +v : null)); }
  function inList(list, v) { var i; for (i = 0; i < list.length; i++) if (list[i] === v) return true; return false; }
  function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }
  function closest(node, attr, stop) {
    while (node && node !== stop) {
      if (node.getAttribute && node.getAttribute(attr) != null) return node;
      node = node.parentNode;
    }
    return null;
  }
  function stateBlock(state, title, hint) {
    var b = el("div", "mx2-msg"); b.setAttribute("data-mx2-for", state);
    b.appendChild(el("div", "mx2-msg-t", title));
    b.appendChild(el("div", "mx2-msg-h", hint || ""));
    return b;
  }
  function isYM(s) { return typeof s === "string" && /^\d{4}-\d{2}$/.test(s); }
  // "2026-07" -> "Jul'26" (v1's monLbl) and "Jul 2026".
  function monLbl(ym) {
    if (!isYM(ym)) return ym == null ? "" : String(ym);
    var m = parseInt(ym.slice(5, 7), 10);
    return (MON[m - 1] || "") + "'" + ym.slice(2, 4);
  }
  function monLong(ym) {
    if (!isYM(ym)) return ym == null ? "" : String(ym);
    var m = parseInt(ym.slice(5, 7), 10);
    return (MON[m - 1] || "") + " " + ym.slice(0, 4);
  }
  // Trailing `n` months ending at `endYM` ("YYYY-MM"), ascending.
  function trailingMonths(endYM, n) {
    var y, m, out = [], i, d;
    if (isYM(endYM)) { y = +endYM.slice(0, 4); m = +endYM.slice(5, 7); }
    else { d = new Date(); y = d.getFullYear(); m = d.getMonth() + 1; }
    for (i = n - 1; i >= 0; i--) {
      d = new Date(y, m - 1 - i, 1);
      out.push(d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2));
    }
    return out;
  }
  function titleCase(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/(^|\s)\S/g, function (c) { return c.toUpperCase(); });
  }
  function buLabel(v) { return v === "ALL" ? "All" : titleCase(v); }
  function regionLabel(v) { return v === "ALL" ? "All" : String(v); }

  /* -------------------------------------------------------------------------
   * THE scope mechanism — resolved at call time, never duplicated here
   * ---------------------------------------------------------------------- */
  function scopeFn() {
    if (NS.adapter && typeof NS.adapter.applyScope === "function") return NS.adapter.applyScope;
    if (typeof window.MEXP_applyScope === "function") return window.MEXP_applyScope;
    if (NS.controller && typeof NS.controller.applyScope === "function" &&
        typeof NS.controller.isMounted === "function" && NS.controller.isMounted()) return NS.controller.applyScope;
    if (NS.api && typeof NS.api.applyScope === "function") return NS.api.applyScope;
    return null;
  }
  function dispatchScope(patch) {
    var fn = scopeFn();
    if (!fn) { dbg("warn", "no scope mechanism available — patch dropped", patch); return null; }
    dbg("info", "scope patch", patch);
    try { return fn(patch); } catch (e) { dbg("fail", "scope dispatch threw", e && e.message); return null; }
  }
  function liveDrill() {
    if (cur && cur.scope && cur.scope.drill && typeof cur.scope.drill.length === "number") return cur.scope.drill;
    return [];
  }
  function crumbCopy(c) { return { dim: c.dim, value: c.value, label: c.label == null ? c.value : c.label }; }
  // The current drill without any crumb of `dim`, plus (optionally) a new one.
  function drillWith(dim, crumb) {
    var d = liveDrill(), out = [], i;
    for (i = 0; i < d.length; i++) if (d[i] && d[i].dim !== dim) out.push(crumbCopy(d[i]));
    if (crumb) out.push(crumb);
    return out;
  }
  function crumbOf(dim) {
    var d = liveDrill(), i;
    for (i = 0; i < d.length; i++) if (d[i] && d[i].dim === dim) return d[i];
    return null;
  }

  /* -------------------------------------------------------------------------
   * VIEW state (display-only; never in the scope key, never refetches)
   * ---------------------------------------------------------------------- */
  var VIEW = { unit: "ton", window: "trailing", hidden: {} };
  var seenDsm = {};          // DSM names seen this session (matrix rows grouped by dsm) — option list only
  var seenBu = {};           // BU literals seen in a bu-grouped matrix beyond C.BUS
  var custTimer = null;

  function legalUnit(u) { return inList(UNITS, u) ? u : "ton"; }
  function legalWindow(w) { return inList(WINDOWS, w) ? w : "trailing"; }

  /* -------------------------------------------------------------------------
   * model — pure: reads diss + core + scope + VIEW, returns what the table needs
   * ---------------------------------------------------------------------- */
  function cellValue(c, unit) {
    // -> { v, text, none, withheld, title }
    var f = F(), tons = c ? num(c.tons) : null, gmTon = c ? num(c.gm_ton) : null, gmPct = c ? num(c.gm_pct) : null, v = null, text = null;
    var out = { v: null, text: DASH, none: false, withheld: false, title: "" };
    if (!c) { out.none = true; out.title = COPY.noVolume; return out; }
    if (unit === "mt") {
      if (tons === null || tons <= 0) { out.none = true; out.title = COPY.noVolume; return out; }
      out.v = tons; out.text = f.mt(tons); return out;
    }
    var perUnit = (unit === "ton") ? gmTon : (unit === "gp_pct") ? gmPct : ((gmTon === null || tons === null) ? null : gmTon * tons);
    if (perUnit === null) { out.none = true; out.title = COPY.noVolume; return out; }
    if (tons !== null && tons < THIN_MT) {
      out.withheld = true;
      out.title = COPY.withheldA + f.mt(tons) + COPY.withheldB;
      return out;
    }
    v = perUnit;
    if (unit === "ton") text = f.perTon(v);
    else if (unit === "gp_pct") text = f.pct(v);
    else {
      // Derived and approximate (tons is whole-ton rounded on the wire): the
      // shell's abbreviated form, never a 2-dp figure that claims ledger precision.
      text = (typeof f.phpAbbrShellCompat === "function") ? f.phpAbbrShellCompat(v) : f.php(v);
      out.full = f.php(v);
    }
    out.v = v; out.text = text;
    return out;
  }
  function cellTip(ym, name, c, unit, cv) {
    var f = F(), bits = [monLong(ym), name];
    if (c) {
      bits.push(f.mt(num(c.tons)));
      if (num(c.gm_ton) !== null) bits.push("GM " + f.perTon(c.gm_ton) + (C.NUM && C.NUM.PER_TON ? C.NUM.PER_TON : "/t"));
      if (num(c.gm_pct) !== null) bits.push(f.pct(c.gm_pct));
      if (unit === "gp" && cv && cv.full) bits.push("GP " + cv.full + " (derived: GM/t × MT, approximate)");
    }
    return bits.join(" · ") + " — " + COPY.monthTip;
  }

  // The selected period's last month: the running (partial) month when the
  // spine ends on it, else the last complete month (the compare anchor).
  function periodEnd(M) {
    var last = M.allMonths.length ? M.allMonths[M.allMonths.length - 1] : null;
    if (last && M.partial[last]) return last;
    return M.compare || last;
  }

  function modelFor(diss, core, scope, view, stale) {
    var f = F(), ct = (isObj(diss) && diss.available === true && isObj(diss.category_trend)) ? diss.category_trend : null;
    scope = scope || {};
    var unit = legalUnit(view.unit), win = legalWindow(view.window);
    var M = {
      ok: false, reason: null, stale: !!stale, unit: unit, window: win, scope: scope,
      months: [], allMonths: [], partial: {}, anchor: isYM(scope.refMonth) ? scope.refMonth : null,
      base: null, compare: null, comparePartial: false, periodLabel: "",
      rows: [], allRows: 0, avg: {}, withheld: 0, hidden: 0, catNames: [],
      ssgCrumb: crumbOfScope(scope, "ssg"), dsmCrumb: crumbOfScope(scope, "dsm")
    };
    if (isObj(diss) && diss.available === false) { M.reason = diss.reason == null ? null : String(diss.reason); return M; }
    if (!ct) return M;
    if (ct.available === false || !ct.months || !ct.months.length) { M.reason = ct.note ? String(ct.note) : COPY.ctUnavailable; return M; }

    M.base = isYM(diss.base_month) ? diss.base_month : null;
    M.compare = isYM(diss.compare_month) ? diss.compare_month : null;
    M.comparePartial = diss.compare_partial === true;
    M.allMonths = ct.months.slice();

    // Partial columns. The wire flags the last column whenever it is the cube's
    // last month — also on a historical ref_month, where that month is complete.
    // Honest test: the running month is beyond the last complete month, or the
    // compare month itself is flagged partial by the window meta.
    var i, m, last = M.allMonths[M.allMonths.length - 1];
    if (isYM(ct.partial_month) && ct.partial_month === last && (M.compare === null || ct.partial_month > M.compare)) M.partial[ct.partial_month] = true;
    if (M.comparePartial && M.compare) M.partial[M.compare] = true;

    // Window: every column, or base .. current-side window end.
    var end = periodEnd(M), start = M.base;
    M.periodEnd = end;
    if (win === "period" && start) {
      for (i = 0; i < M.allMonths.length; i++) { m = M.allMonths[i]; if (m >= start && (end === null || m <= end)) M.months.push(m); }
      if (!M.months.length) M.months = M.allMonths.slice();
    } else {
      M.months = M.allMonths.slice();
    }
    M.periodLabel = (start && end) ? (monLbl(start) + "–" + monLbl(end)) : "";
    var inWin = {};
    for (i = 0; i < M.months.length; i++) inWin[M.months[i]] = true;

    // Rows: wire order (sorted by total kg desc on the server).
    var cats = ct.categories || [], c, j, cell, byMonth, winTons, R, sel = M.ssgCrumb ? String(M.ssgCrumb.value) : null, cv;
    M.allRows = cats.length;
    for (i = 0; i < cats.length; i++) {
      c = cats[i];
      byMonth = {}; winTons = 0;
      for (j = 0; j < (c.cells || []).length; j++) {
        cell = c.cells[j];
        if (!cell || !isYM(cell.month)) continue;
        byMonth[cell.month] = cell;
        if (inWin[cell.month] && num(cell.tons) !== null) winTons += num(cell.tons);
      }
      R = {
        idx: i, ssg: (c.ssg == null || c.ssg === "") ? "(none)" : String(c.ssg),
        totalTons: num(c.total_tons), winTons: winTons, cells: byMonth,
        hidden: !!view.hidden[String(c.ssg)], selected: sel !== null && String(c.ssg) === sel, zero: false, vals: {}
      };
      R.tonsShown = (win === "period") ? winTons : (R.totalTons === null ? winTons : R.totalTons);
      R.zero = !(R.tonsShown > 0);
      M.catNames.push(R.ssg);
      if (R.hidden) { M.hidden++; continue; }
      for (j = 0; j < M.months.length; j++) {
        cv = cellValue(byMonth[M.months[j]], unit);
        if (cv.withheld) M.withheld++;
        R.vals[M.months[j]] = cv;
      }
      M.rows.push(R);
    }
    // AVG row: the payload's volume-weighted cells, keyed by month. Never recomputed.
    var avg = ct.avg || [];
    for (i = 0; i < avg.length; i++) if (avg[i] && isYM(avg[i].month)) M.avg[avg[i].month] = avg[i];
    M.ok = true;
    return M;
  }
  function crumbOfScope(scope, dim) {
    var d = (scope && scope.drill) || [], i;
    for (i = 0; i < d.length; i++) if (d[i] && d[i].dim === dim) return d[i];
    return null;
  }

  /* -------------------------------------------------------------------------
   * the panel
   * ---------------------------------------------------------------------- */
  var host = null, R = null, cur = null, offs = [];

  function chip(text, group, value, extra) {
    var b = el("button", "mx2-chip mx2-tm-chip" + (extra || ""), text); b.type = "button";
    b.setAttribute("data-mx2-tm-group", group); b.setAttribute("data-mx2-value", value); b.setAttribute("aria-pressed", "false");
    return b;
  }
  function fgroup(label, tag, tip) {
    var g = el("div", "mx2-fgroup mx2-tm-fgroup"), lab = el("span", "mx2-flabel", label);
    if (tag) { lab.appendChild(document.createTextNode(" ")); lab.appendChild(el("span", "mx2-rail-tag", tag)); }
    if (tip) lab.title = tip;
    g.appendChild(lab);
    return g;
  }

  function build(hostEl) {
    var head = el("div", "mx2-panel-h"), col = el("div", "mx2-panel-hcol"), i;
    R = {};
    R.title = el("div", "mx2-panel-t", COPY.title);
    R.sub = el("div", "mx2-panel-st", COPY.sub);
    R.anchors = el("div", "mx2-panel-st mx2-tm-anchors", "");
    col.appendChild(R.title); col.appendChild(R.sub); col.appendChild(R.anchors);
    R.pill = el("span", "mx2-pill"); R.pill.appendChild(el("span", "mx2-pill-dot"));
    R.pillText = el("span", "", ""); R.pill.appendChild(R.pillText);
    head.appendChild(col); head.appendChild(R.pill);

    // ---- filter rail (chrome: usable in every state) ----
    R.rail = el("div", "mx2-filters mx2-tm-rail"); R.rail.setAttribute("role", "toolbar"); R.rail.setAttribute("aria-label", "Scope filters");
    var g = fgroup(COPY.railRegion, null, COPY.railServerTip);
    for (i = 0; i < REGIONS.length; i++) g.appendChild(chip(regionLabel(REGIONS[i]), "region", REGIONS[i]));
    R.rail.appendChild(g); R.rail.appendChild(el("span", "mx2-fdivider"));
    R.buGroup = fgroup(COPY.railBu, null, COPY.railServerTip);
    R.rail.appendChild(R.buGroup); R.rail.appendChild(el("span", "mx2-fdivider"));
    g = fgroup(COPY.railCustomer, null, COPY.railServerTip);
    R.customer = el("input", "mx2-input mx2-tm-input"); R.customer.type = "search"; R.customer.placeholder = COPY.customerPlaceholder; R.customer.setAttribute("aria-label", COPY.railCustomer);
    g.appendChild(R.customer); R.rail.appendChild(g); R.rail.appendChild(el("span", "mx2-fdivider"));
    g = fgroup(COPY.railDsm, COPY.railDsmTag, COPY.railDsmTip);
    R.dsm = el("input", "mx2-input mx2-tm-input mx2-tm-dsm"); R.dsm.type = "search"; R.dsm.placeholder = COPY.railDsmPlaceholder; R.dsm.title = COPY.railDsmTip;
    R.dsm.setAttribute("aria-label", COPY.railDsm + " (" + COPY.railDsmTag + ")");
    R.dsmList = el("datalist"); R.dsmList.id = "mx2-" + PANEL_ID + "-dsm-list"; R.dsm.setAttribute("list", R.dsmList.id);
    g.appendChild(R.dsm); g.appendChild(R.dsmList); R.rail.appendChild(g);

    // ---- category multi-select + unit / window / export (second strip) ----
    R.tools = el("div", "mx2-filters mx2-tm-tools"); R.tools.setAttribute("role", "toolbar"); R.tools.setAttribute("aria-label", "Table view");
    R.catGroup = fgroup(COPY.railCat, COPY.railCatTag, COPY.railCatTip);
    R.catAll = chip(COPY.catAll, "cat", "*"); R.catAll.title = COPY.catAllTip; R.catGroup.appendChild(R.catAll);
    R.catChips = el("span", "mx2-tm-cats"); R.catGroup.appendChild(R.catChips);
    R.tools.appendChild(R.catGroup); R.tools.appendChild(el("span", "mx2-fdivider"));
    g = fgroup("Unit");
    for (i = 0; i < UNITS.length; i++) {
      var b = chip(COPY.unit[UNITS[i]], "unit", UNITS[i]); b.title = COPY.unitTip[UNITS[i]];
      if (COPY.unitTag[UNITS[i]]) { b.appendChild(document.createTextNode(" ")); b.appendChild(el("span", "mx2-rail-tag", COPY.unitTag[UNITS[i]])); }
      g.appendChild(b);
    }
    R.tools.appendChild(g); R.tools.appendChild(el("span", "mx2-fdivider"));
    g = fgroup("Window");
    b = chip(COPY.windowTrailing, "window", "trailing"); b.title = COPY.windowTrailingTip; g.appendChild(b);
    R.winPeriod = chip(COPY.windowPeriod, "window", "period"); R.winPeriod.title = COPY.windowPeriodTip; g.appendChild(R.winPeriod);
    R.tools.appendChild(g);
    R.exportBtn = el("button", "mx2-btn mx2-btn-quiet mx2-tm-export", COPY.exportBtn); R.exportBtn.type = "button"; R.exportBtn.title = COPY.exportTip;
    R.tools.appendChild(R.exportBtn);

    R.banner = el("div", "mx2-stale-banner", COPY.stalePrefix);
    R.bannerLabel = el("span", "mx2-stale-label", ""); R.banner.appendChild(R.bannerLabel);

    // ---- data-bearing body ----
    R.body = el("div", "mx2-dimmable mx2-tm-body");
    R.notes = el("div", "mx2-tm-notes");
    R.wrap = el("div", "mx2-tablewrap mx2-tm-wrap");
    R.table = null;
    R.body.appendChild(R.wrap);
    R.foot = el("div", "mx2-tm-foot");
    R.footWithheld = el("div", "mx2-note mx2-tm-withheld", "");
    R.footPartial = el("div", "mx2-note", "");
    R.footHidden = el("div", "mx2-note", "");
    R.foot.appendChild(R.footWithheld); R.foot.appendChild(R.footPartial); R.foot.appendChild(R.footHidden);
    R.body.appendChild(R.foot);
    R.basis = el("div", "mx2-note mx2-tm-basis", COPY.basis);
    R.basis.title = COPY.universe;

    // ---- loading-first skeleton WITH month headers ----
    R.skel = el("div", "mx2-tm-skel"); R.skel.setAttribute("data-mx2-for", C.STATE.LOADING_FIRST);
    R.skelHead = el("div", "mx2-tm-skel-head");
    R.skel.appendChild(R.skelHead);
    var rows = el("div", "mx2-skel-rows mx2-tm-skel-rows");
    for (i = 0; i < SKEL_ROWS; i++) rows.appendChild(el("div", "mx2-skel"));
    R.skel.appendChild(rows);
    R.skel.appendChild(el("div", "mx2-note", C.STATE_COPY[C.STATE.LOADING_FIRST]));
    R.empty = stateBlock(C.STATE.EMPTY_SCOPE, C.STATE_COPY[C.STATE.EMPTY_SCOPE], C.STATE_COPY["empty-scope-hint"]);
    R.unavail = stateBlock(C.STATE.UNAVAILABLE_FOR_SCOPE, C.STATE_COPY[C.STATE.UNAVAILABLE_FOR_SCOPE], "");
    R.unavailHint = R.unavail.lastChild;
    R.errored = stateBlock(C.STATE.ERRORED, C.STATE_COPY[C.STATE.ERRORED], "");
    R.erroredTitle = R.errored.firstChild;

    hostEl.appendChild(head);
    hostEl.appendChild(R.rail);
    hostEl.appendChild(R.tools);
    hostEl.appendChild(R.body);
    hostEl.appendChild(R.skel);
    hostEl.appendChild(R.empty);
    hostEl.appendChild(R.unavail);
    hostEl.appendChild(R.errored);
    hostEl.appendChild(R.basis);
    R.head = head;

    paintBu({});
    offs.push(on(R.rail, "click", onRailClick));
    offs.push(on(R.tools, "click", onToolsClick));
    offs.push(on(R.customer, "input", onCustomerInput));
    offs.push(on(R.customer, "keydown", onCustomerKey));
    offs.push(on(R.dsm, "change", onDsmChange));
    offs.push(on(R.dsm, "keydown", onDsmKey));
    offs.push(on(R.exportBtn, "click", onExport));
    offs.push(on(R.wrap, "click", onTableClick));
    offs.push(on(R.wrap, "keydown", onTableKey));
  }

  /* -------------------------------------------------------------------------
   * chrome paint — rail, tools, skeleton
   * ---------------------------------------------------------------------- */
  function paintBu(extra) {
    var i, list = BUS.slice(), k;
    for (k in extra) if (hasOwn(extra, k) && !inList(list, k)) list.push(k);
    R.buGroup.innerHTML = "";
    var lab = el("span", "mx2-flabel", COPY.railBu); lab.title = COPY.railServerTip; R.buGroup.appendChild(lab);
    for (i = 0; i < list.length; i++) R.buGroup.appendChild(chip(buLabel(list[i]), "bu", list[i]));
  }
  function paintDsmList() {
    var k, o;
    R.dsmList.innerHTML = "";
    for (k in seenDsm) if (hasOwn(seenDsm, k)) { o = el("option"); o.value = k; R.dsmList.appendChild(o); }
  }
  function harvest(core) {
    var m = core && core.matrix, rows = (m && m.rows) || [], gb = m && m.group_by, i, d, changed = false;
    if (gb === "dsm") for (i = 0; i < rows.length; i++) { d = rows[i] && rows[i].dim; if (d != null && d !== "" && !hasOwn(seenDsm, String(d))) { seenDsm[String(d)] = true; changed = true; } }
    if (gb === "bu") for (i = 0; i < rows.length; i++) { d = rows[i] && rows[i].dim; if (d != null && d !== "" && !inList(BUS, String(d)) && !hasOwn(seenBu, String(d))) { seenBu[String(d)] = true; paintBu(seenBu); } }
    if (changed) paintDsmList();
  }
  function reflectRail(scope, M) {
    var list = R.rail.querySelectorAll(".mx2-chip[data-mx2-tm-group]"), i, c, g, v, on2;
    for (i = 0; i < list.length; i++) {
      c = list[i]; g = c.getAttribute("data-mx2-tm-group"); v = c.getAttribute("data-mx2-value");
      on2 = (g === "region") ? String(scope.region || "ALL") === v : (g === "bu") ? String(scope.bu || "ALL") === v : false;
      c.setAttribute("aria-pressed", on2 ? "true" : "false");
    }
    if (document.activeElement !== R.customer) R.customer.value = scope.customer || "";
    var dc = crumbOfScope(scope, "dsm");
    if (document.activeElement !== R.dsm) R.dsm.value = dc ? String(dc.label == null ? dc.value : dc.label) : "";
    // tools
    list = R.tools.querySelectorAll(".mx2-chip[data-mx2-tm-group]");
    for (i = 0; i < list.length; i++) {
      c = list[i]; g = c.getAttribute("data-mx2-tm-group"); v = c.getAttribute("data-mx2-value");
      if (g === "unit") c.setAttribute("aria-pressed", VIEW.unit === v ? "true" : "false");
      else if (g === "window") c.setAttribute("aria-pressed", VIEW.window === v ? "true" : "false");
    }
    setText(R.winPeriod, COPY.windowPeriod + (M && M.ok && M.periodLabel ? " · " + M.periodLabel : ""));
    R.winPeriod.disabled = !(M && M.ok && M.base);
    paintCats(M);
  }
  function paintCats(M) {
    var i, b, names = (M && M.catNames) || [], all = true;
    R.catChips.innerHTML = "";
    for (i = 0; i < names.length; i++) {
      b = chip(names[i], "cat", names[i], " mx2-tm-catchip");
      b.title = COPY.railCatTip;
      b.setAttribute("aria-pressed", VIEW.hidden[names[i]] ? "false" : "true");
      if (VIEW.hidden[names[i]]) all = false;
      R.catChips.appendChild(b);
    }
    R.catAll.setAttribute("aria-pressed", all ? "true" : "false");
  }
  function paintSkeleton(scope) {
    var months = trailingMonths(scope && scope.refMonth, SKEL_MONTHS), i, h;
    R.skelHead.innerHTML = "";
    R.skelHead.appendChild(el("span", "mx2-tm-skel-cat", "Category"));
    for (i = 0; i < months.length; i++) { h = el("span", "mx2-tm-skel-m", monLbl(months[i])); R.skelHead.appendChild(h); }
  }

  /* -------------------------------------------------------------------------
   * the table
   * ---------------------------------------------------------------------- */
  function numCell(td, cv) {
    setText(td, cv.text);
    cls(td, "mx2-null", cv.none || cv.withheld);
    cls(td, "mx2-tm-withheld", cv.withheld);
    cls(td, "mx2-neg", cv.v !== null && cv.v < 0);
  }
  function monthHead(ym, M) {
    var th = el("th", "mx2-num mx2-tm-m"), btn = el("button", "mx2-tm-mbtn", monLbl(ym)), isP = !!M.partial[ym], isA = M.anchor === ym;
    th.setAttribute("scope", "col");
    btn.type = "button"; btn.setAttribute("data-mx2-month", ym);
    btn.title = isA ? (COPY.anchorTipA + ym + COPY.anchorTipB) : (isP ? COPY.partialTip + " · " + COPY.monthTip : COPY.monthTip);
    btn.setAttribute("aria-pressed", isA ? "true" : "false");
    btn.setAttribute("aria-label", monLong(ym) + (isP ? " (partial)" : "") + (isA ? " (anchor)" : ""));
    if (M.stale) btn.disabled = true;
    th.appendChild(btn);
    if (isP) th.appendChild(el("span", "mx2-tm-tag mx2-tm-tag-partial", COPY.partialTag));
    if (isA) th.appendChild(el("span", "mx2-tm-tag mx2-tm-tag-anchor", COPY.anchorTag));
    cls(th, "mx2-tm-partial", isP); cls(th, "mx2-tm-anchor", isA);
    return th;
  }
  function buildTable(M) {
    var f = F(), table = el("table", "mx2-tbl mx2-tm-tbl"), thead, tr, th, tbody, tfoot, td, i, j, ym, Rm, cv, first = true, sub, c;
    table.appendChild(el("caption", "mx2-sr", COPY.title + " · " + M.rows.length + " categories · " + M.months.length + " months · unit " + COPY.unit[M.unit]));
    thead = el("thead"); tr = el("tr");
    th = el("th", "mx2-tm-cat", "Category"); th.setAttribute("scope", "col"); tr.appendChild(th);
    for (i = 0; i < M.months.length; i++) tr.appendChild(monthHead(M.months[i], M));
    thead.appendChild(tr); table.appendChild(thead);

    tbody = el("tbody");
    for (i = 0; i < M.rows.length; i++) {
      Rm = M.rows[i];
      tr = el("tr"); tr.setAttribute("data-mx2-row", String(i));
      cls(tr, "is-selected", Rm.selected); if (Rm.selected) tr.setAttribute("aria-selected", "true");
      cls(tr, "mx2-tm-zero", Rm.zero);
      if (!M.stale) { cls(tr, "is-clickable", true); tr.setAttribute("tabindex", first ? "0" : "-1"); first = false; tr.title = COPY.rowTip; }
      td = el("td", "mx2-dim-col mx2-tm-cat");
      td.appendChild(el("span", "mx2-tm-name", Rm.ssg));
      sub = el("span", "mx2-tm-tons", Rm.zero ? COPY.zeroRow : f.mt(Rm.tonsShown));
      sub.title = COPY.tonsA + (M.window === "period" ? COPY.tonsPeriod : COPY.tonsTrailing);
      td.appendChild(sub);
      tr.appendChild(td);
      for (j = 0; j < M.months.length; j++) {
        ym = M.months[j]; cv = Rm.vals[ym]; c = Rm.cells[ym];
        td = el("td", "mx2-num mx2-tm-m"); td.setAttribute("data-mx2-month", ym);
        numCell(td, cv);
        td.title = cv.withheld ? cv.title : (cv.none ? cv.title + " — " + COPY.monthTip : cellTip(ym, Rm.ssg, c, M.unit, cv));
        cls(td, "mx2-tm-partial", !!M.partial[ym]); cls(td, "mx2-tm-anchor", M.anchor === ym);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // AVG row from the payload avg[] block.
    tfoot = el("tfoot"); tr = el("tr", "mx2-tm-avg");
    td = el("td", "mx2-tm-cat", COPY.avgLabel[M.unit]); td.title = (M.unit === "gp") ? COPY.avgTipGp : COPY.avgTip; tr.appendChild(td);
    for (j = 0; j < M.months.length; j++) {
      ym = M.months[j]; c = M.avg[ym] || null;
      cv = cellValue(c, M.unit);
      td = el("td", "mx2-num mx2-tm-m"); td.setAttribute("data-mx2-month", ym);
      numCell(td, cv);
      td.title = cv.withheld ? cv.title : (cv.none ? cv.title : cellTip(ym, COPY.avgLabel[M.unit], c, M.unit, cv));
      cls(td, "mx2-tm-partial", !!M.partial[ym]); cls(td, "mx2-tm-anchor", M.anchor === ym);
      tr.appendChild(td);
    }
    tfoot.appendChild(tr); table.appendChild(tfoot);
    return table;
  }

  // A plain table for the shell's exporter: basis line first, then scope, then the grid.
  function buildExportTable(M, label) {
    var f = F(), t = el("table"), tr, td, i, j, Rm, cv, n = M.months.length + 2, ym, c;
    function row(cells, tag) { var r = el("tr"), k; for (k = 0; k < cells.length; k++) r.appendChild(el(tag || "td", null, cells[k])); return r; }
    tr = el("tr"); td = el("th", null, COPY.basis); td.setAttribute("colspan", String(n)); tr.appendChild(td); t.appendChild(tr);
    tr = el("tr"); td = el("th", null, label + " · " + (M.window === "period" ? COPY.windowPeriod : COPY.windowTrailing) + " · unit " + COPY.unit[M.unit] + (M.unit === "gp" ? " (derived)" : "") + " · cells under " + THIN_MT + " MT withheld"); td.setAttribute("colspan", String(n)); tr.appendChild(td); t.appendChild(tr);
    var hdr = ["Category", "MT (" + (M.window === "period" ? "window" : "12 months") + ")"];
    for (i = 0; i < M.months.length; i++) hdr.push(monLbl(M.months[i]) + (M.partial[M.months[i]] ? " (partial)" : ""));
    t.appendChild(row(hdr, "th"));
    for (i = 0; i < M.rows.length; i++) {
      Rm = M.rows[i];
      var cells = [Rm.ssg, Rm.zero ? "" : f.mt(Rm.tonsShown)];
      for (j = 0; j < M.months.length; j++) { cv = Rm.vals[M.months[j]]; cells.push(cv.text); }
      t.appendChild(row(cells));
    }
    var av = [COPY.avgLabel[M.unit], ""];
    for (j = 0; j < M.months.length; j++) { ym = M.months[j]; c = M.avg[ym] || null; cv = cellValue(c, M.unit); av.push(cv.text); }
    t.appendChild(row(av));
    return t;
  }

  function paintNotes(M) {
    var nodes = [], n;
    if (M.dsmCrumb) {
      n = el("div", "mx2-note mx2-tm-note"); n.appendChild(el("span", "mx2-warnglyph", "⚠"));
      n.appendChild(el("span", "", COPY.dsmNoteA + String(M.dsmCrumb.label == null ? M.dsmCrumb.value : M.dsmCrumb.label) + COPY.dsmNoteB));
      nodes.push(n);
    }
    if (M.ssgCrumb) {
      n = el("div", "mx2-note mx2-tm-note"); n.appendChild(el("span", "mx2-tm-glyph", "›"));
      n.appendChild(el("span", "", COPY.ssgNoteA + String(M.ssgCrumb.label == null ? M.ssgCrumb.value : M.ssgCrumb.label) + COPY.ssgNoteB));
      nodes.push(n);
    }
    R.notes.innerHTML = "";
    var i; for (i = 0; i < nodes.length; i++) R.notes.appendChild(nodes[i]);
    show(R.body, R.notes, nodes.length > 0, R.wrap);
  }
  function paintFoot(M) {
    var p = [], k;
    setText(R.footWithheld, M.withheld > 0 ? (String(M.withheld) + COPY.withheldFootA + (M.withheld === 1 ? "" : "s") + COPY.withheldFootB) : COPY.withheldNone);
    for (k in M.partial) if (hasOwn(M.partial, k)) p.push(monLbl(k));
    setText(R.footPartial, p.length ? p.join(", ") + COPY.partialFootA : "");
    show(R.foot, R.footPartial, p.length > 0, R.footHidden);
    setText(R.footHidden, M.hidden > 0 ? (String(M.hidden) + COPY.hiddenFootA + (M.hidden === 1 ? "y" : "ies") + COPY.hiddenFootB) : "");
    show(R.foot, R.footHidden, M.hidden > 0);
  }
  function anchorsLine(M) {
    if (!M.ok) return "";
    var s = "";
    if (M.base && M.compare) s = COPY.anchorsPrefix + monLong(M.base) + " → " + monLong(M.compare) + COPY.anchorsWhy;
    if (M.anchor) s += (s ? " · " : "") + COPY.anchoredA + monLong(M.anchor) + COPY.anchoredB;
    return s;
  }

  // Paint one payload. Idempotent: the table is rebuilt from (diss, scope, VIEW).
  function paint(diss, core, scope, label, stale, status) {
    if (!R || !host) return;
    scope = scope || C.DEFAULT_SCOPE;
    var M = modelFor(diss, core, scope, VIEW, stale), effective = status;
    cur = { M: M, diss: diss, scope: scope, label: label };

    harvest(core);
    setText(R.sub, (stale ? COPY.stalePrefix + label : label) + " · " + COPY.sub);
    setText(R.anchors, anchorsLine(M));
    cls(host, "mx2-is-stale", stale);
    setText(R.bannerLabel, stale ? label : "");
    show(host, R.banner, stale, R.body);
    reflectRail(scope, M);
    paintSkeleton(scope);

    if (R.table && R.table.parentNode === R.wrap) R.wrap.removeChild(R.table);
    R.table = null;
    if (M.ok) { R.table = buildTable(M); R.wrap.appendChild(R.table); }
    paintNotes(M);
    paintFoot(M);
    show(R.body, R.foot, M.ok);

    setText(R.erroredTitle, (stale || isObj(diss)) ? C.STATE_COPY["errored-stale"] : C.STATE_COPY[C.STATE.ERRORED]);
    setText(R.unavailHint, "");
    if (isObj(diss) && diss.available === false) setText(R.unavailHint, diss.reason == null ? "" : String(diss.reason));
    // A category_trend that is unavailable inside an available dissection: the
    // store/adapter report FRESH because the block exists; only this panel can
    // see inside it, so it surfaces the state itself with the reason verbatim.
    if (!M.ok && M.reason !== null && isObj(diss) && diss.available === true && (status === C.STATE.FRESH || status == null)) {
      effective = C.STATE.UNAVAILABLE_FOR_SCOPE;
      setText(R.unavailHint, M.reason);
    }
    if (effective && effective !== status) def.setStatus(effective);
  }

  /* -------------------------------------------------------------------------
   * interaction
   * ---------------------------------------------------------------------- */
  function onRailClick(ev) {
    var b = closest(ev.target, "data-mx2-tm-group", R.rail), g, v;
    if (!b || b.tagName !== "BUTTON") return;
    g = b.getAttribute("data-mx2-tm-group"); v = b.getAttribute("data-mx2-value");
    if (g === "region" || g === "bu") {
      if (cur && cur.scope && String(cur.scope[g] || "ALL") === v) return;
      var patch = { drill: [] }; patch[g] = v;
      dispatchScope(patch);
    }
  }
  function onToolsClick(ev) {
    var b = closest(ev.target, "data-mx2-tm-group", R.tools), g, v, k;
    if (!b || b.tagName !== "BUTTON") return;
    g = b.getAttribute("data-mx2-tm-group"); v = b.getAttribute("data-mx2-value");
    if (g === "unit") { if (VIEW.unit === v) return; VIEW.unit = legalUnit(v); }
    else if (g === "window") { if (VIEW.window === v) return; VIEW.window = legalWindow(v); }
    else if (g === "cat") {
      if (v === "*") { for (k in VIEW.hidden) if (hasOwn(VIEW.hidden, k)) delete VIEW.hidden[k]; }
      else if (VIEW.hidden[v]) delete VIEW.hidden[v]; else VIEW.hidden[v] = true;
    } else return;
    dbg("trace", "view", { unit: VIEW.unit, window: VIEW.window });
    repaint();
  }
  function repaint() {
    if (!cur) return;
    paint(cur.diss, null, cur.scope, cur.label, cur.M.stale, host.getAttribute("data-mx2-status") || null);
  }
  function onCustomerInput() {
    var v = trim(R.customer.value);
    if (custTimer) clearTimeout(custTimer);
    custTimer = setTimeout(function () { custTimer = null; commitCustomer(v); }, DEBOUNCE_MS);
  }
  function onCustomerKey(ev) {
    if (ev.key === "Enter" || ev.keyCode === 13) {
      ev.preventDefault();
      if (custTimer) { clearTimeout(custTimer); custTimer = null; }
      commitCustomer(trim(R.customer.value));
    }
  }
  function commitCustomer(v) {
    var now = (cur && cur.scope && cur.scope.customer) ? String(cur.scope.customer) : "";
    if (v === now) return;
    dispatchScope({ customer: v || null, drill: [] });
  }
  function onDsmChange() { commitDsm(trim(R.dsm.value)); }
  function onDsmKey(ev) { if (ev.key === "Enter" || ev.keyCode === 13) { ev.preventDefault(); commitDsm(trim(R.dsm.value)); } }
  function commitDsm(v) {
    var c = crumbOf("dsm"), now = c ? String(c.value) : "";
    if (v === now) return;
    dispatchScope({ drill: drillWith("dsm", v ? { dim: "dsm", value: v, label: v } : null) });
  }
  function onExport() {
    if (!cur || !cur.M.ok) return;
    if (typeof window.exportTableToXlsx !== "function") { dbg("warn", COPY.exportNoShell); if (window.alert) window.alert(COPY.exportNoShell); return; }
    var t = buildExportTable(cur.M, cur.label || "");
    try { window.exportTableToXlsx(t, COPY.exportName + "_" + cur.M.unit); } catch (e) { dbg("fail", "export threw", e && e.message); }
  }
  function dispatchAnchor(ym) {
    if (!cur || cur.M.stale || !isYM(ym)) return;
    var next = (cur.M.anchor === ym) ? null : ym;
    dbg("info", "anchor", next);
    dispatchScope({ refMonth: next });
  }
  function dispatchRow(Rm) {
    if (!cur || cur.M.stale || !Rm) return;
    var crumb = Rm.selected ? null : { dim: "ssg", value: Rm.ssg, label: Rm.ssg };
    dbg("info", "drill", crumb);
    dispatchScope({ drill: drillWith("ssg", crumb) });
  }
  function rowOf(node) {
    var tr = closest(node, "data-mx2-row", R.wrap), i;
    if (!tr || !cur) return null;
    i = +tr.getAttribute("data-mx2-row");
    return { tr: tr, R: cur.M.rows[i] || null };
  }
  function onTableClick(ev) {
    var m = closest(ev.target, "data-mx2-month", R.wrap), r;
    if (m) { dispatchAnchor(m.getAttribute("data-mx2-month")); return; }   // a cell or a month header
    r = rowOf(ev.target);
    if (r && r.R && r.tr.classList.contains("is-clickable")) dispatchRow(r.R);
  }
  function clickableRows() { return R.table ? R.table.querySelectorAll("tbody tr.is-clickable") : []; }
  function focusRow(list, idx) {
    var i;
    if (!list.length) return;
    if (idx < 0) idx = 0;
    if (idx >= list.length) idx = list.length - 1;
    for (i = 0; i < list.length; i++) list[i].setAttribute("tabindex", i === idx ? "0" : "-1");
    list[idx].focus();
  }
  function onTableKey(ev) {
    var key = ev.key, r, list, i, idx = -1;
    if (closest(ev.target, "data-mx2-month", R.wrap) && ev.target.tagName === "BUTTON") return;   // native button
    r = rowOf(ev.target);
    if (!r || !r.tr.classList.contains("is-clickable")) return;
    if (key === "Enter" || key === " " || key === "Spacebar" || ev.keyCode === 13 || ev.keyCode === 32) { ev.preventDefault(); dispatchRow(r.R); return; }
    list = clickableRows();
    for (i = 0; i < list.length; i++) if (list[i] === r.tr) idx = i;
    if (key === "ArrowDown" || key === "Down" || ev.keyCode === 40) { ev.preventDefault(); focusRow(list, idx + 1); }
    else if (key === "ArrowUp" || key === "Up" || ev.keyCode === 38) { ev.preventDefault(); focusRow(list, idx - 1); }
    else if (key === "Home" || ev.keyCode === 36) { ev.preventDefault(); focusRow(list, 0); }
    else if (key === "End" || ev.keyCode === 35) { ev.preventDefault(); focusRow(list, list.length - 1); }
  }

  var def = {
    slot: "body",
    phase: "diss",
    drillAware: true,      // applies / explains the client-side crumbs itself; the controller does not badge it

    mount: function (hostEl) {
      if (!hostEl) return;
      if (host && host !== hostEl) def.destroy();
      host = hostEl;
      cls(host, "mx2-panel-trendmatrix", true);
      build(host);
      paintSkeleton(null);
      dbg("info", "mounted");
    },

    render: function (vm) {
      if (!R || !host) return;
      vm = vm || {};
      paint(vm.diss || null, vm.core || null, vm.scope || C.DEFAULT_SCOPE, vm.label || "", false, host.getAttribute("data-mx2-status") || null);
    },

    renderStale: function (prev, vm) {
      if (!R || !host) return;
      vm = vm || {};
      if (!prev) { def.render(vm); return; }   // contract says never call with null; degrade honestly
      paint(prev.diss || null, prev.core || vm.core || null, vm.scope || C.DEFAULT_SCOPE, prev.label || "", true, host.getAttribute("data-mx2-status") || null);
    },

    setStatus: function (state) {
      if (!R || !host) return;
      if (!C.STATE_RULES[state]) state = C.STATE.FRESH;
      host.setAttribute("data-mx2-status", state);
      setText(R.pillText, C.pillText(state));
    },

    destroy: function () {
      var i;
      if (custTimer) { clearTimeout(custTimer); custTimer = null; }
      for (i = 0; i < offs.length; i++) { try { offs[i](); } catch (e) { /* silent */ } }
      offs = [];
      if (host) {
        cls(host, "mx2-is-stale", false);
        cls(host, "mx2-panel-trendmatrix", false);
        host.innerHTML = "";
      }
      host = null; R = null; cur = null;
    },

    // test probes — not used by the controller
    _model: modelFor,
    _cell: cellValue,
    _view: VIEW,
    THIN_MT: THIN_MT,
    COPY: COPY
  };

  NS.panel(PANEL_ID, def);
})();
