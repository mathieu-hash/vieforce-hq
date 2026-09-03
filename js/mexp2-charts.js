/* ============================================================================
 * mexp2-charts.js — Margin Explorer v2 · PRIVATE Chart.js registry
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Every Chart.js instance created by Margin Explorer v2. It owns their
 *   lifetime (create, destroy, rebuild), the resolution of every colour they
 *   draw with, the single MutationObserver that notices a theme flip, and the
 *   two dataset builders that read a wire shape directly: the dissection
 *   TRAJECTORY (WIRE.TRAJECTORY_POINT, C17) and the DISCOUNT OVERLAY series
 *   (WIRE.DISCOUNT_OVERLAY.SERIES_POINT, C3) — the chart that puts the honest
 *   GM/kg on screen beside the reported one.
 *
 *   Public surface, attached to window.MEXP2.charts:
 *     draw(id, canvasEl, config)             -> Chart instance | null
 *     trajectory(id, canvasEl, points, opts) -> Chart instance | null
 *     discountOverlay(id, canvasEl, overlay, opts) -> Chart instance | null
 *     trajectoryConfig(points, opts)         -> config factory | null
 *     discountOverlayConfig(overlay, opts)   -> config factory | null
 *     destroy(id) / destroyAll() / retheme()
 *     palette() / resolveTokens() / TOKENS   -> colour resolution, read-only
 *     note(canvasEl, msg) / has(id) / get(id) / ids()
 *     observing() / rebuilds()               -> harness probes
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never register into the shell's global `charts` map (app.html:7526,
 *     `let charts = {}`). DELIBERATE. The shell's toggleTheme (app.html:7821)
 *     walks Object.values(charts) and PATCHES hardcoded rgba strings onto every
 *     registered chart's axes/legend, then calls chart.update('none'). v2
 *     REBUILDS on theme change, so that patch would be overwritten milliseconds
 *     later and buys us nothing. Meanwhile `charts` is a bare `let` binding in
 *     the shell's top-level script: touching it from a separate <script> file
 *     that loads before or independently of that block throws a
 *     ReferenceError/TDZ, and the failure mode is a hard page break, not a
 *     mis-coloured axis. The correct trade is: stay out of it entirely.
 *   - Never hardcode an rgba/hex colour into a chart. v1 claims its palette
 *     "resolved live so light-theme works too" and then hardcodes grid and grey
 *     (margin-explorer-bridge.js:35-36) — those two stay dark-theme values in
 *     light mode. Every colour here comes from getComputedStyle at draw time.
 *   - Never read a token that css/mexp2.css does not define. The previous
 *     build read ten colour-named tokens (amber, blue, cyan, gold, green,
 *     green2, grey, muted, red, red2 under the --mx2- prefix) that exist
 *     nowhere — the list is C.TOKENS.UNDEFINED_DO_NOT_USE. Undefined custom
 *     properties inherit, so those bars silently took the shell's lime. The
 *     TOKENS map below is the complete list this file reads, and charts-test
 *     .html proves every one of them is defined and resolves in both themes.
 *   - Never define the global tokens --border or --surface2 (undefined app-wide
 *     by design of the v1 mess); v2 reads --mx2-border / --mx2-surface-solid.
 *   - Never console.*. Diagnostics go to MEXP2.debug (C.DEBUG): the store's
 *     trace/info/warn/fail wrappers when present, else the three-parameter
 *     push(level, msg, data). d.log and d.record do not exist (A4).
 *   - Never touch, import or patch anything named margin-explorer*.js.
 *   - Never fetch, never read the view model. It is handed a Chart.js config
 *     (or a wire block for the two builders) and draws it; every decision
 *     about WHAT to draw lives in the panel.
 *   - Never DERIVE a wire figure. trajectory[].cogs_per_ton exists on the wire
 *     (C17) and is read, never computed as rev - gm.
 *
 * THEME (verified against the shell, not assumed)
 *   app.html:7824 -> setAttribute('data-theme', currentTheme === 'dark' ? '' : 'light')
 *   Dark is the EMPTY STRING; "light" is the only truthy value. toggleTheme
 *   dispatches NO event (grep for dispatchEvent/CustomEvent across app.html
 *   returns nothing theme-related), so a MutationObserver on documentElement's
 *   data-theme attribute is the ONLY signal available to us. That observer is
 *   created lazily on the first draw and disconnected when the registry empties.
 *
 * REBUILD, NOT PATCH
 *   A Chart.js config carries colour in a dozen places — dataset backgrounds,
 *   segment callbacks, tooltip boxes, fills. Patching three axis keys (what the
 *   shell does) leaves the other nine wrong. So on a theme flip we destroy and
 *   recreate. To make that cheap and correct, prefer passing a CONFIG FACTORY:
 *   draw(id, el, function (pal) { return {...}; }). The factory is re-invoked
 *   with the freshly resolved palette on every rebuild. A plain object config
 *   also works — it is redrawn as-is with the themed scaffolding re-applied —
 *   but any colour baked into it by the caller will not follow the theme,
 *   which is exactly the v1 bug. Both builders in this file return factories.
 * ========================================================================= */

(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var VERSION = "2.1.0";

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

  // C.NUM.RULE, implemented locally so this file has no hard dependency on fmt.
  function toNum(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "boolean") return null;
    var n = +v;
    if (n !== n || n === Infinity || n === -Infinity) return null;
    return n;
  }

  // Contract access is OPTIONAL here: the registry must work on a page that
  // loads only this file, so every C.* read has a literal fallback.
  function contract() { return NS.C || null; }
  function basisSuffix(kind) {
    var C = contract();
    if (C && C.BASIS_SUFFIX && C.BASIS_SUFFIX[kind]) return C.BASIS_SUFFIX[kind];
    return kind === "net" ? "net of off-invoice discount" : "gross of off-invoice discount";
  }

  /* -------------------------------------------------------------------------
   * DIAGNOSTICS (A4). One channel: MEXP2.debug. The store exports
   * trace/info/warn/fail (C.DEBUG.API); when they are present we call them
   * with (msg, data). When only the raw ring is present we call the
   * three-parameter push(level, msg, data). The subsystem is carried INSIDE
   * the message on both paths so the ring reads the same either way.
   * Levels here are the ring's: "trace" | "info" | "warn" | "error"; the
   * wrapper for "error" is named fail so it never shadows an Error in a catch.
   * ---------------------------------------------------------------------- */
  function diag(level, msg, data) {
    var d = NS.debug;
    if (!d) return;
    var wrapper = (level === "error") ? "fail" : level;
    var text = "charts: " + msg;
    try {
      if (typeof d[wrapper] === "function") d[wrapper](text, data);
      else if (typeof d.push === "function") d.push(level, text, data);
    } catch (e) { /* diagnostics must never break a render */ }
  }

  /* -------------------------------------------------------------------------
   * COLOUR RESOLUTION — computed custom properties only, and ONLY names that
   * css/mexp2.css defines (dark on :root, light under :root[data-theme="light"]).
   * Roles follow C.TOKENS.ROLE_MAP: lever +/- = pos/neg, composition = mix,
   * residual = resid, estimate and "relative" = mix, neutral = text3.
   * ---------------------------------------------------------------------- */
  var TOKENS = {
    // semantic value signs
    pos: "--mx2-pos", neg: "--mx2-neg", mix: "--mx2-mix", resid: "--mx2-resid",
    stale: "--mx2-stale", error: "--mx2-error",
    posSoft: "--mx2-pos-soft", negSoft: "--mx2-neg-soft", mixSoft: "--mx2-mix-soft",
    residSoft: "--mx2-resid-soft", staleSoft: "--mx2-stale-soft",
    posBorder: "--mx2-pos-border", negBorder: "--mx2-neg-border", mixBorder: "--mx2-mix-border",
    // interactive accent — the "actual value" ink, same as the bullet value bar
    accent: "--mx2-accent", accentSoft: "--mx2-accent-soft", accentBorder: "--mx2-accent-border",
    // type
    text: "--mx2-text", text2: "--mx2-text2", text3: "--mx2-text3", text4: "--mx2-text4",
    // chart chrome — legible on BOTH grounds by the stylesheet's own contract
    axis: "--mx2-axis", axisTitle: "--mx2-axis-title", grid: "--mx2-grid",
    gridZero: "--mx2-grid-zero", legend: "--mx2-legend",
    tooltipBg: "--mx2-tooltip-bg", tooltipFg: "--mx2-tooltip-fg", tooltipBorder: "--mx2-tooltip-border",
    // lines and surfaces
    border: "--mx2-border", borderStrong: "--mx2-border-strong", surfaceSolid: "--mx2-surface-solid",
    // type faces
    font: "--mx2-font", mono: "--mx2-mono"
  };

  // Emergency values, used ONLY when the v2 stylesheet failed to load at all.
  // They are deliberately not a palette: a missing token is logged, not styled.
  function emergency(key) {
    if (key === "font") return "system-ui, sans-serif";
    if (key === "mono") return "ui-monospace, monospace";
    if (/Soft$/.test(key) || key === "grid" || key === "gridZero") return "transparent";
    return "currentColor";
  }

  var warnedMissing = {};

  // Read one CSS custom property off documentElement, trimmed; "" when unset.
  function cssVar(name) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v || "").trim();
    } catch (e) {
      return "";
    }
  }

  // The current theme value as a comparable string ("" for dark, "light").
  function themeValue() {
    try {
      return String(document.documentElement.getAttribute("data-theme") || "");
    } catch (e) {
      return "";
    }
  }

  // Is the document currently in light mode? Dark is the EMPTY STRING, so this
  // must compare against "light" and never against "dark".
  function isLight() { return themeValue() === "light"; }

  // Every token this file reads, resolved raw: { "--mx2-pos": "#22C58B", ... }.
  // "" means the token did not resolve. For the harness and for panels that
  // want to prove their own chrome against the same source.
  function resolveTokens() {
    var out = {}, k;
    for (k in TOKENS) if (hasOwn(TOKENS, k)) out[TOKENS[k]] = cssVar(TOKENS[k]);
    return out;
  }

  // Resolve the full chart palette from CSS at call time. Called on every draw
  // and every rebuild, never cached across a theme flip.
  function palette() {
    var p = { light: isLight() }, k, v;
    for (k in TOKENS) {
      if (!hasOwn(TOKENS, k)) continue;
      v = cssVar(TOKENS[k]);
      if (!v) {
        v = emergency(k);
        if (!warnedMissing[k]) {
          warnedMissing[k] = true;
          diag("warn", "token did not resolve", TOKENS[k]);
        }
      }
      p[k] = v;
    }
    return p;
  }

  /* -------------------------------------------------------------------------
   * THEMED SCAFFOLDING — axes/legend/tooltip ink, filled in ONLY where the
   * caller left a hole, so a factory that sets its own colours always wins.
   * Chart.js 4 keys: axis line colour lives in scale.border.color (the v3
   * grid.borderColor is gone); the zero rule gets --mx2-grid-zero through a
   * scriptable grid.color.
   * ---------------------------------------------------------------------- */

  // Assign obj[key] only when it is currently undefined.
  function setIfUnset(obj, key, value) {
    if (obj && obj[key] === undefined) obj[key] = value;
  }

  // Ensure obj[key] is an object and return it.
  function sub(obj, key) {
    if (!obj[key] || typeof obj[key] !== "object") obj[key] = {};
    return obj[key];
  }

  // Scriptable grid colour: the zero/anchor rule is stronger than the others.
  function gridColorFn(p) {
    return function (ctx) {
      var t = ctx && ctx.tick;
      return (t && t.value === 0) ? p.gridZero : p.grid;
    };
  }

  // Fill every axis / legend / tooltip colour from the resolved palette.
  // Mutates the config in place; safe to run repeatedly on the same config.
  function applyThemeScaffold(config, p) {
    if (!config || typeof config !== "object") return config;
    var options = sub(config, "options");
    var scales = sub(options, "scales");
    var plugins = sub(options, "plugins");
    var axes = ["x", "y", "y1", "y2", "r"];
    var i, ax, ticks, tt;

    setIfUnset(options, "responsive", true);
    setIfUnset(options, "maintainAspectRatio", false);

    for (i = 0; i < axes.length; i++) {
      if (!scales[axes[i]]) continue;
      ax = scales[axes[i]];
      setIfUnset(sub(ax, "grid"), "color", gridColorFn(p));
      setIfUnset(sub(ax, "border"), "color", p.border);
      ticks = sub(ax, "ticks");
      setIfUnset(ticks, "color", p.axis);
      setIfUnset(sub(ticks, "font"), "family", p.font);
      if (ax.title) {
        setIfUnset(ax.title, "color", p.axisTitle);
        setIfUnset(sub(ax.title, "font"), "family", p.font);
      }
    }

    if (plugins.legend) {
      setIfUnset(sub(plugins.legend, "labels"), "color", p.legend);
      setIfUnset(sub(plugins.legend.labels, "font"), "family", p.font);
    }
    if (plugins.title) {
      setIfUnset(plugins.title, "color", p.text2);
      setIfUnset(sub(plugins.title, "font"), "family", p.font);
    }
    if (plugins.tooltip !== false) {
      tt = sub(plugins, "tooltip");
      setIfUnset(tt, "backgroundColor", p.tooltipBg);
      setIfUnset(tt, "titleColor", p.tooltipFg);
      setIfUnset(tt, "bodyColor", p.tooltipFg);
      setIfUnset(tt, "footerColor", p.tooltipFg);
      setIfUnset(tt, "borderColor", p.tooltipBorder);
      setIfUnset(tt, "borderWidth", 1);
      setIfUnset(sub(tt, "titleFont"), "family", p.font);
      setIfUnset(sub(tt, "bodyFont"), "family", p.font);
      setIfUnset(sub(tt, "footerFont"), "family", p.font);
    }
    return config;
  }

  /* -------------------------------------------------------------------------
   * THE "NO CHART.JS" NOTE
   * The CSP is strict and Chart.js is the last CDN dependency in the shell
   * (app.html:18). If it is blocked, a bare empty canvas reads as a bug in the
   * panel. Precedent: margin-explorer-bridge.js:107 paints a centred note onto
   * the canvas itself. We do the same, and additionally expose it to assistive
   * tech, because canvas text is invisible to a screen reader.
   * ---------------------------------------------------------------------- */

  // Paint a centred, word-wrapped, full-contrast note onto the canvas.
  function renderNote(canvasEl, msg) {
    if (!canvasEl) return;
    var text = String(msg == null ? "" : msg);
    try {
      canvasEl.setAttribute("role", "img");
      canvasEl.setAttribute("aria-label", text);
      canvasEl.setAttribute("data-mx2-note", text);
    } catch (e) { /* non-element host; ignore */ }

    var ctx = canvasEl.getContext && canvasEl.getContext("2d");
    if (!ctx) {
      // No 2d context at all: fall back to a DOM sibling so the note is still
      // visible rather than silently swallowed.
      try {
        if (canvasEl.parentNode) {
          var el = canvasEl.parentNode.querySelector(".mx2-chart-note");
          if (!el) {
            el = document.createElement("div");
            el.className = "mx2-chart-note";
            canvasEl.parentNode.appendChild(el);
          }
          el.textContent = text;
        }
      } catch (e2) { /* nothing more we can do */ }
      return;
    }

    var p = palette();
    var w = (canvasEl.width = canvasEl.clientWidth || canvasEl.width || 300);
    var h = (canvasEl.height = canvasEl.clientHeight || canvasEl.height || 160);
    if (!(w > 0)) w = canvasEl.width = 300;
    if (!(h > 0)) h = canvasEl.height = 160;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.fillStyle = p.text;             // full contrast: a note is an answer
    ctx.font = "600 13px " + p.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    var words = text.split(/\s+/);
    var line = "", lines = [], maxW = Math.max(40, w - 40), i, test;
    for (i = 0; i < words.length; i++) {
      test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    var lh = 20, startY = h / 2 - ((lines.length - 1) * lh) / 2;
    for (i = 0; i < lines.length; i++) ctx.fillText(lines[i], w / 2, startY + i * lh);
    ctx.restore();
  }

  // Clear a previously painted note so a real chart is not drawn under one.
  function clearNote(canvasEl) {
    if (!canvasEl) return;
    try {
      canvasEl.removeAttribute("data-mx2-note");
      canvasEl.removeAttribute("aria-label");
      canvasEl.removeAttribute("role");
      if (canvasEl.parentNode) {
        var el = canvasEl.parentNode.querySelector(".mx2-chart-note");
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------------------
   * REGISTRY
   * entry = { id, canvas, source, chart }
   *   source: the caller's config factory (preferred) or config object.
   * ---------------------------------------------------------------------- */
  var registry = {};   // id -> entry
  var observer = null; // the single data-theme MutationObserver
  var lastTheme = null;
  var rethemePending = false;
  var rebuildCount = 0; // charts rebuilt by retheme(); harness probe

  // Count live entries without Object.keys allocation surprises.
  function entryCount() {
    var n = 0, k;
    for (k in registry) if (hasOwn(registry, k)) n++;
    return n;
  }

  // Destroy the Chart.js instance held by an entry, plus any foreign instance
  // still bound to the same canvas. This is what stops orphaned charts: a
  // canvas can only host one Chart.js instance, and a leaked one keeps its
  // resize/hover listeners alive forever.
  function killChartOn(entry, canvasEl) {
    if (entry && entry.chart) {
      try { entry.chart.destroy(); } catch (e) { diag("warn", "destroy threw", e && e.message); }
      entry.chart = null;
    }
    var el = canvasEl || (entry && entry.canvas);
    if (el && window.Chart && typeof window.Chart.getChart === "function") {
      var stray;
      try { stray = window.Chart.getChart(el); } catch (e2) { stray = null; }
      if (stray) {
        try { stray.destroy(); } catch (e3) { diag("warn", "stray destroy threw", e3 && e3.message); }
      }
    }
    // v1 parks its instance on the element; clear it if this canvas was reused.
    if (el && el._mexpChart) el._mexpChart = null;
    if (el && el._mx2Chart) el._mx2Chart = null;
  }

  // Produce a fresh, themed Chart.js config for an entry.
  function buildConfig(entry) {
    var p = palette();
    var cfg;
    if (typeof entry.source === "function") {
      cfg = entry.source(p);            // factory: colours re-resolve every time
    } else {
      cfg = entry.source;               // object: reused by reference, re-themed
    }
    if (!cfg || typeof cfg !== "object") return null;
    return applyThemeScaffold(cfg, p);
  }

  // Create the Chart.js instance for an entry. Returns the instance or null.
  function instantiate(entry) {
    if (!entry || !entry.canvas) return null;

    if (!window.Chart) {
      renderNote(entry.canvas, "Chart library not loaded.");
      diag("error", "window.Chart absent", entry.id);
      return null;
    }

    var cfg = buildConfig(entry);
    if (!cfg) {
      renderNote(entry.canvas, "Nothing to chart.");
      diag("warn", "empty config", entry.id);
      return null;
    }

    clearNote(entry.canvas);
    try {
      entry.chart = new window.Chart(entry.canvas, cfg);
      entry.canvas._mx2Chart = entry.chart;
      return entry.chart;
    } catch (e) {
      entry.chart = null;
      renderNote(entry.canvas, "Chart could not be drawn.");
      diag("error", "Chart constructor threw", e && e.message);
      return null;
    }
  }

  /* -------------------------------------------------------------------------
   * THEME OBSERVER — the only available signal. toggleTheme (app.html:7821)
   * flips the attribute and dispatches nothing, so we watch the attribute.
   * ---------------------------------------------------------------------- */

  // Start the single observer on first use. Idempotent.
  function ensureObserver() {
    if (observer || !window.MutationObserver || !document.documentElement) return;
    lastTheme = themeValue();
    try {
      observer = new window.MutationObserver(function () {
        var now = themeValue();
        if (now === lastTheme) return;   // unrelated attribute write
        lastTheme = now;
        scheduleRetheme();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"]
      });
    } catch (e) {
      observer = null;
      diag("warn", "theme observer failed", e && e.message);
    }
  }

  // Stop observing once nothing is registered, so a destroyed page leaves
  // nothing running.
  function stopObserver() {
    if (!observer) return;
    try { observer.disconnect(); } catch (e) { /* ignore */ }
    observer = null;
  }

  // Coalesce a burst of attribute writes into ONE rebuild. A timer, not
  // requestAnimationFrame: getComputedStyle forces a synchronous style recalc,
  // so nothing needs a frame to "settle" before the tokens are read — the
  // delay exists only to coalesce, and rAF never fires in a hidden tab, which
  // would leave a theme flip un-applied (and the harness hanging) until the
  // tab is fronted.
  function scheduleRetheme() {
    if (rethemePending) return;
    rethemePending = true;
    window.setTimeout(function () {
      rethemePending = false;
      api.retheme();
    }, 16);
  }

  /* -------------------------------------------------------------------------
   * FORMATTERS FOR TOOLTIPS — delegate to MEXP2.fmt when it is loaded so the
   * chart prints the same glyphs as the tiles; local fallbacks otherwise.
   * Never finer than the wire: per-ton integers, per-kg 2 dp (wire 3 dp).
   * ---------------------------------------------------------------------- */
  function fmtPerTon(v) {
    var n = toNum(v);
    if (n === null) return "—";
    if (NS.fmt && typeof NS.fmt.perTon === "function") return NS.fmt.perTon(n);
    return "₱" + String(Math.round(n)) + "/t";
  }
  function fmtPerKg(v) {
    var n = toNum(v);
    if (n === null) return "—";
    if (NS.fmt && typeof NS.fmt.perKg === "function") return NS.fmt.perKg(n) + "/kg";
    return "₱" + n.toFixed(2) + "/kg";
  }
  function fmtMt(v) {
    var n = toNum(v);
    if (n === null) return "—";
    if (NS.fmt && typeof NS.fmt.mt === "function") return NS.fmt.mt(n);
    return String(Math.round(n)) + " t";
  }
  function fmtPct1(v) {
    var n = toNum(v);
    if (n === null) return "—";
    return n.toFixed(1) + "%";
  }

  // The dashed-final-segment / hollow-final-point treatment for a partial
  // (running) month. `partialIdx` is -1 when no point is partial.
  function partialSegment(partialIdx) {
    return {
      borderDash: function (ctx) {
        return (partialIdx >= 0 && ctx && ctx.p1DataIndex === partialIdx) ? [4, 4] : undefined;
      }
    };
  }
  function partialPointRadius(partialIdx, base) {
    return function (ctx) {
      return (partialIdx >= 0 && ctx && ctx.dataIndex === partialIdx) ? base + 2 : base;
    };
  }
  function partialPointFill(partialIdx, solid, hollow) {
    return function (ctx) {
      return (partialIdx >= 0 && ctx && ctx.dataIndex === partialIdx) ? hollow : solid;
    };
  }

  /* -------------------------------------------------------------------------
   * TRAJECTORY BUILDER — WIRE.TRAJECTORY_POINT (C17):
   *   { month, tons (MT int), rev_per_ton, gm_per_ton, cogs_per_ton (ints),
   *     gm_pct (1dp), partial? }
   * `partial` is true on the LAST point only when it is the running PH month;
   * on every other point the KEY IS ABSENT. Test `=== true`, never truthiness
   * of a coerced value. cogs_per_ton is READ from the wire, never derived.
   * tons is round(kg/1000): a month with 400 kg prints tons 0 while its
   * per-ton figures are real, so tons === 0 must NOT null the lines.
   * Universe: finished feed (103), credit notes netted — the caller prints
   * C.UNIVERSES.dissection beside this chart; this file only labels the unit.
   *
   * opts: { series: ["gm_per_ton","cogs_per_ton","rev_per_ton"] (default gm only),
   *         tons: true (MT bars on a right axis), beginAtZero: false,
   *         basisNote: string|null (default C.BASIS_SUFFIX.reported) }
   * ---------------------------------------------------------------------- */
  var TRAJ_SERIES = {
    gm_per_ton:   { label: "GM / ton",      ink: "accent", dash: null,   width: 2.5 },
    cogs_per_ton: { label: "COGS / ton",    ink: "neg",    dash: [5, 4], width: 1.5 },
    rev_per_ton:  { label: "Revenue / ton", ink: "text3",  dash: [2, 3], width: 1.5 }
  };

  function trajectoryConfig(points, opts) {
    opts = opts || {};
    var pts = isArray(points) ? points : [];
    if (!pts.length) return null;
    var series = (isArray(opts.series) && opts.series.length) ? opts.series : ["gm_per_ton"];
    var showTons = opts.tons !== false;
    var basis = (opts.basisNote === undefined) ? basisSuffix("reported") : opts.basisNote;

    return function (p) {
      var labels = [], tons = [], gmPct = [], partialIdx = -1, i, pt, k, def, data, j, ds;
      var datasets = [];
      for (i = 0; i < pts.length; i++) {
        pt = pts[i] || {};
        labels.push(pt.month == null ? "" : String(pt.month));
        tons.push(toNum(pt.tons));
        gmPct.push(toNum(pt.gm_pct));
        if (pt.partial === true) partialIdx = i;   // C17: key absent elsewhere
      }
      for (j = 0; j < series.length; j++) {
        k = series[j];
        if (!hasOwn(TRAJ_SERIES, k)) continue;
        def = TRAJ_SERIES[k];
        data = [];
        for (i = 0; i < pts.length; i++) data.push(toNum((pts[i] || {})[k]));  // read, never derive
        ds = {
          type: "line",
          label: def.label,
          data: data,
          yAxisID: "y",
          order: 1 + j,
          borderColor: p[def.ink],
          backgroundColor: p[def.ink],
          borderWidth: def.width,
          tension: 0.25,
          spanGaps: false,
          fill: false,
          pointRadius: partialPointRadius(partialIdx, 2),
          pointHoverRadius: 5,
          pointBackgroundColor: partialPointFill(partialIdx, p[def.ink], p.surfaceSolid),
          pointBorderColor: p[def.ink],
          pointBorderWidth: 1.5,
          segment: partialSegment(partialIdx)
        };
        if (def.dash) ds.borderDash = def.dash;
        datasets.push(ds);
      }
      if (showTons) {
        datasets.push({
          type: "bar",
          label: "Volume (MT)",
          data: tons,
          yAxisID: "y1",
          order: 20,
          backgroundColor: p.mixSoft,
          borderColor: p.mixBorder,
          borderWidth: 1,
          borderSkipped: false,
          maxBarThickness: 28
        });
      }
      var scales = {
        x: { grid: { display: false } },
        y: {
          position: "left",
          beginAtZero: opts.beginAtZero === true,
          title: { display: true, text: "PHP/ton" + (basis ? " · " + basis : "") },
          ticks: { callback: function (v) { return fmtPerTon(v); } }
        }
      };
      if (showTons) {
        scales.y1 = {
          position: "right",
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          title: { display: true, text: "MT" },
          ticks: { callback: function (v) { return fmtMt(v); } }
        };
      }
      return {
        data: { labels: labels, datasets: datasets },
        options: {
          interaction: { mode: "index", intersect: false },
          scales: scales,
          plugins: {
            legend: { display: true, position: "bottom" },
            tooltip: {
              callbacks: {
                title: function (items) {
                  var idx = items && items.length ? items[0].dataIndex : -1;
                  var m = idx >= 0 ? labels[idx] : "";
                  return (idx >= 0 && idx === partialIdx) ? m + " (partial month)" : m;
                },
                label: function (item) {
                  var ds0 = item.dataset || {};
                  var v = item.parsed ? item.parsed.y : null;
                  if (ds0.yAxisID === "y1") return ds0.label + ": " + fmtMt(v);
                  return ds0.label + ": " + fmtPerTon(v);
                },
                footer: function (items) {
                  var idx = items && items.length ? items[0].dataIndex : -1;
                  if (idx < 0 || gmPct[idx] === null) return "";
                  return "GM % " + fmtPct1(gmPct[idx]);
                }
              }
            }
          }
        }
      };
    };
  }

  /* -------------------------------------------------------------------------
   * DISCOUNT OVERLAY BUILDER — WIRE.DISCOUNT_OVERLAY (C3). THE v2.0 chart.
   *   overlay = { available, discount_per_kg, discount_total,
   *               gm_per_kg_reported, gm_per_kg_net_of_discount, ...,
   *               series: [{ month, gm_per_kg_reported, discount_per_kg,
   *                          gm_per_kg_net, partial:boolean }], chart_hint, ... }
   * Two lines: REPORTED GM/kg (gross of off-invoice discount — the overstated
   * figure, drawn in the non-semantic slate) and NET-OF-DISCOUNT GM/kg (the
   * honest figure, drawn in the accent). The wedge between them is the
   * document-level trade discount given away, shaded neg-soft when reported
   * sits above net (the normal case) and pos-soft if it ever inverts.
   * series[].partial is a real boolean on EVERY point (contrast C17) and is
   * true only for the anchor month.
   * Accepts the overlay block or a bare series array. Returns null when there
   * is nothing to draw — the caller (or discountOverlay()) paints the note.
   *
   * opts: { beginAtZero: true, basisReported/basisNet: label suffix overrides }
   * ---------------------------------------------------------------------- */
  function discountOverlayConfig(overlay, opts) {
    opts = opts || {};
    var series = null;
    if (isArray(overlay)) series = overlay;
    else if (overlay && typeof overlay === "object") series = overlay.series;
    if (!isArray(series) || !series.length) return null;

    var repSuffix = (opts.basisReported === undefined) ? basisSuffix("reported") : opts.basisReported;
    var netSuffix = (opts.basisNet === undefined) ? basisSuffix("net") : opts.basisNet;
    var repLabel = "GM/kg reported" + (repSuffix ? " (" + repSuffix + ")" : "");
    var netLabel = "GM/kg" + (netSuffix ? " " + netSuffix : "");

    return function (p) {
      var labels = [], reported = [], net = [], disc = [], partialIdx = -1, i, pt;
      for (i = 0; i < series.length; i++) {
        pt = series[i] || {};
        labels.push(pt.month == null ? "" : String(pt.month));
        reported.push(toNum(pt.gm_per_kg_reported));
        net.push(toNum(pt.gm_per_kg_net));
        disc.push(toNum(pt.discount_per_kg));
        if (pt.partial === true) partialIdx = i;
      }
      return {
        type: "line",
        data: {
          labels: labels,
          datasets: [
            {
              label: repLabel,
              data: reported,
              order: 2,
              borderColor: p.mix,
              backgroundColor: p.mix,
              borderWidth: 2,
              tension: 0.25,
              spanGaps: false,
              fill: false,
              pointRadius: partialPointRadius(partialIdx, 2),
              pointHoverRadius: 5,
              pointBackgroundColor: partialPointFill(partialIdx, p.mix, p.surfaceSolid),
              pointBorderColor: p.mix,
              pointBorderWidth: 1.5,
              segment: partialSegment(partialIdx)
            },
            {
              label: netLabel,
              data: net,
              order: 1,
              borderColor: p.accent,
              backgroundColor: p.accent,
              borderWidth: 2.5,
              tension: 0.25,
              spanGaps: false,
              // The wedge: filled to dataset 0 (reported). Discount erodes
              // margin, so the area under reported is shaded as a loss.
              fill: { target: 0, above: p.posSoft, below: p.negSoft },
              pointRadius: partialPointRadius(partialIdx, 2.5),
              pointHoverRadius: 5,
              pointBackgroundColor: partialPointFill(partialIdx, p.accent, p.surfaceSolid),
              pointBorderColor: p.accent,
              pointBorderWidth: 1.5,
              segment: partialSegment(partialIdx)
            }
          ]
        },
        options: {
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { grid: { display: false } },
            y: {
              beginAtZero: opts.beginAtZero !== false,
              title: { display: true, text: "PHP/kg" },
              ticks: { callback: function (v) { return fmtPerKg(v); } }
            }
          },
          plugins: {
            legend: { display: true, position: "bottom" },
            tooltip: {
              callbacks: {
                title: function (items) {
                  var idx = items && items.length ? items[0].dataIndex : -1;
                  var m = idx >= 0 ? labels[idx] : "";
                  return (idx >= 0 && idx === partialIdx) ? m + " (partial month)" : m;
                },
                label: function (item) {
                  var ds0 = item.dataset || {};
                  return ds0.label + ": " + fmtPerKg(item.parsed ? item.parsed.y : null);
                },
                footer: function (items) {
                  var idx = items && items.length ? items[0].dataIndex : -1;
                  if (idx < 0 || disc[idx] === null) return "";
                  return "Off-invoice discount: " + fmtPerKg(disc[idx]);
                }
              }
            }
          }
        }
      };
    };
  }

  /* -------------------------------------------------------------------------
   * PUBLIC API
   * ---------------------------------------------------------------------- */
  var api = {};
  api.VERSION = VERSION;
  api.TOKENS = TOKENS;

  /**
   * draw(id, canvasEl, config)
   * Create (or replace) the chart registered under `id` on `canvasEl`.
   * `config` is a Chart.js config object, or — preferred — a factory
   * function(palette) returning one, so a theme flip re-resolves its colours.
   * Always destroys whatever was there first; never leaves an orphan.
   */
  api.draw = function (id, canvasEl, config) {
    if (!id || !canvasEl) {
      diag("warn", "draw called without id or canvas", id);
      return null;
    }

    // Same canvas registered under a different id? Retire the old entry, or
    // two entries would fight over one canvas and one would leak.
    var k, other;
    for (k in registry) {
      if (!hasOwn(registry, k)) continue;
      if (k !== id && registry[k] && registry[k].canvas === canvasEl) {
        other = registry[k];
        killChartOn(other, canvasEl);
        delete registry[k];
        diag("trace", "canvas re-registered under a new id", k + " -> " + id);
      }
    }

    var entry = registry[id];
    if (entry) killChartOn(entry, entry.canvas);
    else entry = registry[id] = { id: id, canvas: null, source: null, chart: null };

    // If the id moved to a different canvas, clean the old one too.
    if (entry.canvas && entry.canvas !== canvasEl) killChartOn(entry, entry.canvas);

    entry.canvas = canvasEl;
    entry.source = config;

    ensureObserver();
    return instantiate(entry);
  };

  /**
   * trajectory(id, canvasEl, points, opts) — draw dissection.trajectory.
   * Empty / non-array points paint "No trajectory for this selection."
   */
  api.trajectory = function (id, canvasEl, points, opts) {
    var factory = trajectoryConfig(points, opts);
    if (!factory) {
      api.destroy(id);
      renderNote(canvasEl, "No trajectory for this selection.");
      diag("info", "trajectory: nothing to draw", id);
      return null;
    }
    return api.draw(id, canvasEl, factory);
  };

  /**
   * discountOverlay(id, canvasEl, overlay, opts) — draw discount_overlay.
   * overlay null (query threw / kg<=0) or series [] paints an explicit note
   * instead of an empty canvas; a previous chart under `id` is torn down
   * first so the note is never painted under a live instance.
   */
  api.discountOverlay = function (id, canvasEl, overlay, opts) {
    var factory = discountOverlayConfig(overlay, opts);
    if (!factory) {
      api.destroy(id);
      renderNote(canvasEl, overlay == null
        ? "Discount overlay not available for this scope."
        : "No discount series for this window.");
      diag("info", "discountOverlay: nothing to draw", id);
      return null;
    }
    return api.draw(id, canvasEl, factory);
  };

  api.trajectoryConfig = trajectoryConfig;
  api.discountOverlayConfig = discountOverlayConfig;

  /**
   * destroy(id) — tear down one registered chart. Safe when `id` was never
   * drawn and safe to call twice. Returns true if something was removed.
   */
  api.destroy = function (id) {
    var entry = registry[id];
    if (!entry) return false;
    killChartOn(entry, entry.canvas);
    clearNote(entry.canvas);
    delete registry[id];
    if (entryCount() === 0) stopObserver();
    return true;
  };

  /**
   * destroyAll() — tear down every chart this file owns and stop the theme
   * observer. Called from a panel's destroy(). Safe when nothing was drawn.
   */
  api.destroyAll = function () {
    var k;
    for (k in registry) {
      if (!hasOwn(registry, k)) continue;
      killChartOn(registry[k], registry[k].canvas);
      clearNote(registry[k].canvas);
    }
    registry = {};
    stopObserver();
  };

  /**
   * retheme() — rebuild every registered chart against the freshly computed
   * palette. Rebuild, not patch: colour lives in too many places in a Chart.js
   * config for a three-key patch to be honest. Entries whose canvas has left
   * the document are dropped rather than redrawn.
   */
  api.retheme = function () {
    var k, entry, ids = [], i;
    for (k in registry) {
      if (hasOwn(registry, k)) ids.push(k);
    }
    for (i = 0; i < ids.length; i++) {
      entry = registry[ids[i]];
      if (!entry) continue;
      // Detached canvas: the panel was torn down without telling us. Drop it.
      if (entry.canvas && entry.canvas.isConnected === false) {
        killChartOn(entry, entry.canvas);
        delete registry[ids[i]];
        diag("trace", "dropped detached chart", ids[i]);
        continue;
      }
      killChartOn(entry, entry.canvas);
      instantiate(entry);
      rebuildCount++;
    }
    if (entryCount() === 0) stopObserver();
  };

  // palette() — exposed so a panel can colour non-canvas chrome (a legend it
  // draws in DOM, a swatch) from the exact same resolved tokens.
  api.palette = palette;

  // resolveTokens() — raw { "--mx2-*": value } for every token this file reads.
  api.resolveTokens = resolveTokens;

  // has(id) — is a chart currently registered under this id?
  api.has = function (id) {
    return hasOwn(registry, id) && !!registry[id];
  };

  // get(id) — the live Chart.js instance, or null. For tests and tooltips only.
  api.get = function (id) {
    return (registry[id] && registry[id].chart) || null;
  };

  // ids() — every currently registered id. Diagnostic.
  api.ids = function () {
    var out = [], k;
    for (k in registry) {
      if (hasOwn(registry, k)) out.push(k);
    }
    return out;
  };

  // observing() — is the data-theme MutationObserver live? rebuilds() — how
  // many charts retheme() has rebuilt since load. Both are harness probes.
  api.observing = function () { return !!observer; };
  api.rebuilds = function () { return rebuildCount; };

  // note(canvasEl, msg) — paint an explicit note where a chart would go.
  // Exposed so a panel can say "not available for this selection" on the
  // canvas itself without inventing its own text renderer.
  api.note = function (canvasEl, msg) {
    renderNote(canvasEl, msg);
  };

  NS.charts = api;

})();
