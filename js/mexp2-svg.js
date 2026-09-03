/* ============================================================================
 * mexp2-svg.js — Margin Explorer v2 · HAND-ROLLED SVG PRIMITIVES
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Four render-only drawing primitives, exported on window.MEXP2.svg:
 *
 *     waterfall(host, spec)    — the GM/ton bridge. DELTA-FRAMED. The single
 *                                most important mark in the rebuild.
 *     bullet(host, spec)       — one bullet row, or an array of them as a strip.
 *     sparkline(host, series)  — a bare trend line, no axes, no chrome.
 *     diverging(host, rows)    — a centred-zero horizontal bar set (lens rows).
 *
 *   It also owns three pieces of shared maths that must not be re-derived
 *   anywhere else in v2:
 *     · the nice-step axis (1 / 2 / 2.5 / 5 / 10 x 10^n)
 *     · the p95 domain clamp used by every bullet strip (C.BULLET_DOMAIN)
 *     · bridge closure: residual vs C.TOLERANCE(drivers, kind) — drift bound
 *   ...plus ResizeObserver-driven re-render, so every mark is exact at its
 *   real pixel width rather than scaled from a stale viewBox.
 *
 * WHY SVG AND NOT CHART.JS
 *   Every mark emits its colour as `var(--mx2-*)`, on BOTH the presentation
 *   attribute and the inline style. That means a theme flip — which in this
 *   shell is nothing more than documentElement's data-theme attribute changing
 *   between "" and "light" — re-paints every bar, rule, tick and label with
 *   ZERO JavaScript. Chart.js bakes resolved colour strings into its datasets,
 *   which is exactly why app.html:7820 has to walk every chart by hand on
 *   toggle and still misses the ones with embedded dataset colours.
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never fetch, never touch apiFetch / localStorage / the store.
 *   - Never read window.MEXP2.C and then decide something different from it.
 *     TOLERANCE, ROW_CAP, MATERIALITY and BULLET_P95 come from the contract.
 *   - Never define or read the global tokens --border / --surface2. It uses
 *     --mx2-border / --mx2-surface2, defined by mexp2.css.
 *   - Never use [data-theme="dark"] or prefers-color-scheme. Dark is "".
 *   - Never console.*, never mutate the spec it is handed.
 *   - Never touch, import or shadow anything named margin-explorer*.js.
 *
 * THE FIVE RULES OF THE WATERFALL (read before editing anything below)
 *   1. DELTA-FRAMED AXIS. The plot axis is the CUMULATIVE DELTA FROM PRIOR:
 *      it starts at 0 and walks the drivers. It is padded ~19% past the running
 *      min/max and snapped to a nice step. It does NOT begin at zero-the-
 *      absolute-value. v1 sets beginAtZero:true against a ~PHP 5,000/t anchor,
 *      so a real PHP 182/t price move draws at ~3% of plot height and the whole
 *      decomposition is arithmetically correct and visually invisible.
 *   2. ANCHORS ARE NUMERALS ONLY. Prior and Current are large numbers in a
 *      separated strip. No bar geometry. A true-zero anchor bar would be ~22x
 *      the plot height of the drivers, and an independently-scaled anchor bar
 *      is a dual axis wearing a hat.
 *   3. SIGN-CORRECT LABELS. Positive labels sit above the bar, negative below.
 *      A label is never drawn over its own bar or a neighbour's.
 *   4. A 14px GUTTER separates REAL LEVERS (price, cost) from COMPOSITION
 *      (customer mix, product mix) and again before Unexplained. Mix is not a
 *      commercial action and must not read as one.
 *   5. CLOSURE IS SILENT WHEN IT PASSES. residual = (current - prior) -
 *      sum(drivers). The bound is C.TOLERANCE(drivers, kind) and it is a
 *      ROUNDING-DRIFT bound, not a decomposition test (C13): the canonical
 *      bridge is Bennet-exact by construction and a non-reconciling one is
 *      impossible; what CAN happen is that four round()ed bars and two
 *      round()ed anchors re-sum ~3 PHP/ton off. Materially beyond the bound:
 *      draw the gold "Unexplained" bar, LABELLED as rounding drift in its
 *      footnote and tooltip — it never says or implies the decomposition
 *      failed. Under it: draw NOTHING. Not a green tick, not a "reconciles"
 *      badge — the check cannot tell real closure from rounding, and a tick
 *      would claim a precision the arithmetic does not have. The server's
 *      `reconciles` flag NEVER gates the bar (it is essentially always true).
 *      A DROPPED (null) driver also suppresses it: that gap is the missing
 *      driver, which the footnote already names, not drift.
 *   6. ESTIMATES ARE HATCHED. A step with role "est" or estimate:true (the
 *      C12 cost_components split — production-order class ratio, RM is the
 *      remainder) draws as a hatched bar with a DASHED outline in the mix
 *      slate (C.TOKENS.ROLE_MAP.estimated), never in a saturated lever
 *      colour, and its label carries "(est.)". A measured Price or Cost bar
 *      and an estimated component can never be confused at a glance.
 *   7. BADGE SLOT. Every chart accepts spec.badges (or spec.badge): up to
 *      three small pills, top-right, TEXT FROM THE CALLER. This is where the
 *      trust signals land (T1 mix split not determinate, T2 churn-dominated,
 *      T3 significance verdict). The primitive never composes that copy.
 *   8. PLACEHOLDERS ARE OUTLINES, NEVER VALUES. A step with role "placeholder"
 *      (C.WATERFALL_PLACEHOLDER) names a driver the wire does not carry. It
 *      draws as a dashed, unfilled, zero-width mark at the running level with
 *      the text "not on the wire"; its `tag` (why it is missing) is in the
 *      tooltip. It never prints a number, never moves the walk, and the
 *      closure check ignores it. It is not counted as a dropped driver.
 *
 * ORIENTATION
 *   >= 640px host width: vertical waterfall.
 *   <  640px: HORIZONTAL waterfall. Six stacked categories at 375px cannot be
 *   read vertically; js/margin-explorer-netbridge.js:34-44 already proves the
 *   horizontal form works in this codebase.
 *
 * LIFECYCLE
 *   Every component returns { update(spec), destroy(), host }. Mounting onto a
 *   host that already carries a component destroys the old one first, so a
 *   panel's render(vm) stays idempotent per C.PANEL_LIFECYCLE.
 * ========================================================================= */

(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C || {};
  var F = NS.fmt || null;

  var SVGNS = "http://www.w3.org/2000/svg";

  /* -------------------------------------------------------------------------
   * TUNING — local geometry only. Anything with a business meaning lives in
   * the contract and is read from C, never re-stated here.
   * ---------------------------------------------------------------------- */
  var GUTTER          = 14;    // rule 4: lever group vs composition group
  var PAD_FRAC        = 0.19;  // rule 1: ~18-20% headroom past running min/max
  var MOBILE_W        = 640;   // below this the waterfall goes horizontal
  var MIN_HOST_W      = 280;   // narrower than this we still draw, clamped
  var FALLBACK_W      = 640;   // detached / zero-width host
  var MAX_TICKS_HARD  = 40;    // float-loop guard, never a design number
  var CHAR_W          = 0.56;  // Montserrat mean advance as a fraction of size
  var BADGE_MAX       = 3;     // rule 7: more than three pills is a paragraph
  var BADGE_H         = 16;
  var EST_SUFFIX      = "(est.)";

  // Contract values, with local fallbacks so this file is testable standalone.
  // The tolerance fallbacks mirror C.TOLERANCE_PHP_T (rounding drift: 3 for
  // the canonical bridge, 12 for the per-kg phase-A bridge).
  var TOL_FALLBACK = { canonical: 3, phase_a: 12 };
  var ROW_CAP      = typeof C.ROW_CAP === "number" ? C.ROW_CAP : 300;
  var MATERIALITY  = typeof C.MATERIALITY_PHP_T === "number" ? C.MATERIALITY_PHP_T : 25;
  var BULLET_P95   = typeof C.BULLET_P95 === "number" ? C.BULLET_P95 : 0.95;
  var NULL_TEXT    = (C.NUM && C.NUM.NULL_TEXT) || "—";
  var BAND_LABELS  = C.BAND_LABELS || { absolute: "vs target", relative: "relative" };

  /* =========================================================================
   * 1. GUARDS + FORMATTING
   * ====================================================================== */

  // The contract's numeric rule, restated locally so this file never puts NaN
  // or Infinity into an attribute even if mexp2-fmt.js failed to load.
  function toNum(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = +v;
    if (n !== n) return null;
    if (n === Infinity || n === -Infinity) return null;
    return n;
  }

  // toNum with a caller-supplied default. Used for geometry, where a null
  // would poison an SVG attribute string.
  function fin(v, dflt) {
    var n = toNum(v);
    return n === null ? dflt : n;
  }

  // Round a coordinate for the DOM: 2dp is sub-pixel and keeps markup small.
  // Also normalises -0, which serialises as "-0" and looks like a bug.
  function px(n) {
    var v = fin(n, 0);
    v = Math.round(v * 100) / 100;
    return v === 0 ? 0 : v;
  }

  // Clamp with null-safety; used everywhere a bar could run off its plot.
  function clamp(v, lo, hi) {
    var n = fin(v, lo);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  // Plain text for DOM text nodes and attributes. NEVER HTML-escape here (S1):
  // createTextNode() and setAttribute() do not decode entities, so an escaped
  // "B&B FARMS" renders literally as "B&amp;B FARMS". F.esc() exists for
  // innerHTML interpolation only, and this file has no innerHTML path at all.
  function txt(s) {
    return String(s === null || s === undefined ? "" : s);
  }

  // Local thousands grouping, only reached when mexp2-fmt.js is absent.
  function groupAbs(n, dp) {
    var a = Math.abs(fin(n, 0));
    try {
      return a.toLocaleString("en-PH", {
        minimumFractionDigits: dp, maximumFractionDigits: dp
      });
    } catch (e) {
      var s = a.toFixed(dp), parts = s.split("."), head = parts[0], out = "", i, c;
      for (i = 0; i < head.length; i++) {
        c = head.length - i;
        out += head.charAt(i);
        if (c > 1 && c % 3 === 1) out += ",";
      }
      return parts.length > 1 ? out + "." + parts[1] : out;
    }
  }

  // Decimal places a unit is meaningful to. Per-ton figures are 4-digit; a
  // decimal on them is below C.MATERIALITY_PHP_T and is pure noise.
  function dpFor(unit) {
    if (unit === "php_per_kg") return 2;
    if (unit === "gp_pct" || unit === "pp") return 1;
    return 0;
  }

  // Unsigned display of an absolute value in a unit. Never returns "NaN".
  function fmtValue(n, unit) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    if (F) {
      if (unit === "php_per_ton") return F.perTon(v);
      if (unit === "php_per_kg") return F.perKg(v);
      if (unit === "gp_pct") return F.pct(v);
      if (unit === "pp") return F.pp(v);
      return F.php(v);
    }
    var neg = v < 0 ? "-" : "";
    if (unit === "gp_pct") return neg + groupAbs(v, 1) + "%";
    if (unit === "pp") return neg + groupAbs(v, 1) + " pp";
    if (unit === "php_per_kg") return neg + "₱" + groupAbs(v, 2);
    return neg + "₱" + groupAbs(v, 0);
  }

  // Signed display for a bridge step or a delta: "+182", "−96".
  // The minus is U+2212, not a hyphen — at 10px a hyphen is unreadable beside
  // an en dash, and a misread sign on a bridge step is a wrong call.
  function fmtSigned(n, unit) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    var dp = dpFor(unit);
    if (F && F.signed) return F.signed(v, dp);
    var body = groupAbs(v, dp);
    if (Math.abs(v) < Math.pow(10, -dp) / 2) return body;
    return (v < 0 ? "−" : "+") + body;
  }

  // Axis tick text. Ticks are cumulative-delta values, so they always carry an
  // explicit sign; a bare "150" on a delta axis invites reading it as a level.
  function fmtTick(n, unit) {
    var v = toNum(n);
    if (v === null) return "";
    if (v === 0) return "0";
    return fmtSigned(v, unit);
  }

  // Approximate rendered text width. Used only to decide truncation and label
  // collisions — never to position something that must be exact.
  function textW(str, size) {
    return String(str === null || str === undefined ? "" : str).length * size * CHAR_W;
  }

  // Hard-truncate to a pixel budget with a single-character ellipsis.
  function truncate(str, maxPx, size) {
    var s = String(str === null || str === undefined ? "" : str);
    if (textW(s, size) <= maxPx) return s;
    var max = Math.max(1, Math.floor(maxPx / (size * CHAR_W)) - 1);
    return s.slice(0, max) + "…";
  }

  // Greedy word wrap into at most maxLines, last line truncated if needed.
  function wrapLabel(str, maxPx, size, maxLines) {
    var words = String(str === null || str === undefined ? "" : str).split(/\s+/);
    var lines = [], cur = "", i, test;
    for (i = 0; i < words.length; i++) {
      test = cur ? cur + " " + words[i] : words[i];
      if (textW(test, size) <= maxPx || !cur) {
        cur = test;
      } else {
        lines.push(cur);
        cur = words[i];
        if (lines.length === maxLines - 1) break;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    if (lines.length) lines[lines.length - 1] = truncate(lines[lines.length - 1], maxPx, size);
    return lines.length ? lines : [""];
  }

  /* =========================================================================
   * 2. SVG DOM HELPERS
   * ====================================================================== */

  // Create an SVG element, set attributes, append. Colour-bearing attributes
  // are ALSO written to inline style: `fill="var(--x)"` as a presentation
  // attribute is not honoured everywhere, but inline style always is, and
  // keeping both means the serialised markup still carries the token.
  function mk(parent, tag, attrs) {
    var el = document.createElementNS(SVGNS, tag), k, v;
    if (attrs) {
      for (k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        v = attrs[k];
        if (v === null || v === undefined) continue;
        el.setAttribute(k, String(v));
        if (k === "fill" || k === "stroke") el.style[k] = String(v);
        if (k === "stroke-width") el.style.strokeWidth = String(v);
        if (k === "font-size") el.style.fontSize = String(v);
      }
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  // A <text> node. `anchor` is start | middle | end; `weight` optional.
  function label(parent, x, y, str, size, colorVar, anchor, weight) {
    var t = mk(parent, "text", {
      x: px(x), y: px(y),
      "font-size": size,
      "font-family": "var(--mx2-font)",
      "font-weight": weight || 500,
      "text-anchor": anchor || "start",
      fill: colorVar
    });
    t.appendChild(document.createTextNode(txt(str)));
    return t;
  }

  // A native tooltip. The only hover affordance these primitives ship: it
  // costs nothing, needs no listener, and cannot leak on destroy().
  function tip(el, lines) {
    var t = document.createElementNS(SVGNS, "title");
    t.appendChild(document.createTextNode(lines.join("\n")));
    el.insertBefore(t, el.firstChild || null);
    return t;
  }

  function clearHost(host) {
    while (host.firstChild) host.removeChild(host.firstChild);
  }

  // RULE 6: a diagonal hatch <pattern>, created per paint so its id is unique
  // across every svg on the page. Both the ground and the stroke are tokens,
  // so the hatch re-themes with zero JavaScript like everything else.
  var PATTERN_SEQ = 0;
  function hatchPattern(svg) {
    PATTERN_SEQ++;
    var id = "mx2-hatch-" + PATTERN_SEQ;
    var defs = mk(svg, "defs", null);
    var pat = mk(defs, "pattern", {
      id: id, width: 6, height: 6,
      patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)"
    });
    mk(pat, "rect", { x: 0, y: 0, width: 6, height: 6, fill: "var(--mx2-mix-soft)", stroke: "none" });
    mk(pat, "line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--mx2-mix)", "stroke-width": 1.5 });
    return "url(#" + id + ")";
  }

  // RULE 7: normalise spec.badges | spec.badge into at most BADGE_MAX pills.
  // Accepts a string, {text, tone, title}, or an array of either. tone is one
  // of "warn" | "bad" | "good" | "neutral"; anything else is neutral.
  function normBadges(b) {
    var out = [], list, i, x, tone;
    if (b === null || b === undefined) return out;
    list = (typeof b !== "string" && b.length !== undefined) ? b : [b];
    for (i = 0; i < list.length && out.length < BADGE_MAX; i++) {
      x = list[i];
      if (x === null || x === undefined) continue;
      if (typeof x === "string" || typeof x === "number") x = { text: x };
      if (x.text === null || x.text === undefined || x.text === "") continue;
      tone = (x.tone === "warn" || x.tone === "bad" || x.tone === "good") ? x.tone : "neutral";
      out.push({
        text: String(x.text),
        tone: tone,
        title: (x.title === null || x.title === undefined) ? null : String(x.title)
      });
    }
    return out;
  }

  function badgePaint(tone) {
    if (tone === "warn") return { fill: "var(--mx2-resid-soft)", stroke: "var(--mx2-resid-border)", text: "var(--mx2-resid)" };
    if (tone === "bad")  return { fill: "var(--mx2-neg-soft)",   stroke: "var(--mx2-neg-border)",   text: "var(--mx2-neg)" };
    if (tone === "good") return { fill: "var(--mx2-pos-soft)",   stroke: "var(--mx2-pos-border)",   text: "var(--mx2-pos)" };
    return { fill: "var(--mx2-mix-soft)", stroke: "var(--mx2-mix-border)", text: "var(--mx2-text2)" };
  }

  // Draw the pills right-to-left from rightX, top edge at y, within maxW.
  // Returns the horizontal room consumed so the title can shorten itself.
  function drawBadges(svg, rightX, y, badges, maxW) {
    var x = rightX, used = 0, size = 9, i, b, p, txt, w, g;
    for (i = 0; i < badges.length; i++) {
      b = badges[i];
      p = badgePaint(b.tone);
      txt = truncate(b.text, Math.max(28, maxW - used - 14), size);
      w = Math.round(textW(txt, size) + 14);
      if (i > 0 && used + w > maxW) break;
      g = mk(svg, "g", { "class": "mx2-badge", "data-tone": b.tone });
      mk(g, "rect", {
        x: px(x - w), y: px(y), width: px(w), height: BADGE_H, rx: 8,
        fill: p.fill, stroke: p.stroke, "stroke-width": 1
      });
      label(g, x - w / 2, y + 11.5, txt, size, p.text, "middle", 700);
      tip(g, [b.title || b.text]);
      x -= w + 6;
      used += w + 6;
    }
    return used;
  }

  // Usable pixel width of a host, with a sane fallback for a detached node.
  // A detached host still renders; the ResizeObserver corrects it on attach.
  function hostWidth(host) {
    var w = 0;
    if (host) {
      w = host.clientWidth || 0;
      if (!w && host.getBoundingClientRect) w = host.getBoundingClientRect().width || 0;
    }
    if (!w) w = FALLBACK_W;
    return Math.max(MIN_HOST_W, Math.round(w));
  }

  // Root <svg> for a component. Sized in real pixels — no viewBox scaling, so
  // 10px type is 10px at every host width instead of being stretched.
  function rootSvg(host, w, h, title) {
    var svg = mk(host, "svg", {
      width: w, height: h,
      viewBox: "0 0 " + px(w) + " " + px(h),
      role: "img",
      "aria-label": txt(title || ""),
      style: "display:block;max-width:100%;overflow:visible"
    });
    if (title) {
      var t = document.createElementNS(SVGNS, "title");
      t.appendChild(document.createTextNode(txt(title)));
      svg.appendChild(t);
    }
    return svg;
  }

  /* =========================================================================
   * 3. AXIS MATHS — nice steps, padded domains, p95 clamp
   * ====================================================================== */

  // Snap a rough step up to the next "nice" one: 1, 2, 2.5, 5, 10 x 10^n.
  // 2.5 is included on purpose: on a per-ton delta axis a 250/t step is a far
  // more natural read than being forced up to 500/t.
  function niceStep(rough) {
    var r = toNum(rough);
    if (r === null || r <= 0) return 1;
    var exp = Math.floor(Math.log(r) / Math.LN10);
    var mag = Math.pow(10, exp);
    var f = r / mag;
    var nf;
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 2.5) nf = 2.5;
    else if (f <= 5) nf = 5;
    else nf = 10;
    return nf * mag;
  }

  // Tick values across an explicit [min,max], aligned to a nice step.
  function ticksFor(min, max, target) {
    var lo = fin(min, 0), hi = fin(max, 1), out = [], i, v;
    if (hi <= lo) return [lo];
    var step = niceStep((hi - lo) / Math.max(2, fin(target, 5)));
    var start = Math.ceil(lo / step) * step;
    var n = Math.floor((hi - start) / step + 1e-9);
    if (n > MAX_TICKS_HARD) return [lo, hi];
    for (i = 0; i <= n; i++) {
      v = start + i * step;
      v = Math.round(v * 1e6) / 1e6;
      if (v === 0) v = 0;                 // kill -0
      out.push(v);
    }
    if (!out.length) out.push(lo);
    return out;
  }

  // THE delta-framed axis. Pads by padFrac past the observed extremes, snaps
  // the padded bounds outward to the nice step, and returns its ticks.
  // A degenerate range (all drivers identical, or a single zero) is widened
  // around its own value so a flat bridge still draws a readable plot.
  function axisFor(lo, hi, target, padFrac) {
    var a = fin(lo, 0), b = fin(hi, 0), t;
    if (b < a) { t = a; a = b; b = t; }
    var span = b - a;
    if (!(span > 0)) {
      var mag = Math.max(Math.abs(b), 1);
      span = mag * 0.2;
      a = b - span / 2;
      b = b + span / 2;
      span = b - a;
    }
    var pad = span * fin(padFrac, PAD_FRAC);
    a -= pad;
    b += pad;
    var step = niceStep((b - a) / Math.max(2, fin(target, 5)));
    var min = Math.floor(a / step) * step;
    var max = Math.ceil(b / step) * step;
    if (max <= min) max = min + step;
    return {
      min: Math.round(min * 1e6) / 1e6,
      max: Math.round(max * 1e6) / 1e6,
      step: step,
      ticks: ticksFor(min, max, target)
    };
  }

  // Use a caller-supplied domain verbatim (so two waterfalls can share one
  // scale) but still derive nice ticks inside it.
  function axisForDomain(min, max, target) {
    var lo = toNum(min), hi = toNum(max);
    if (lo === null || hi === null || hi <= lo) return null;
    return { min: lo, max: hi, step: niceStep((hi - lo) / Math.max(2, fin(target, 5))), ticks: ticksFor(lo, hi, target) };
  }

  // Linear percentile on a sorted copy. Nulls are dropped, not zeroed — a
  // missing peer must not drag the domain toward zero.
  function p95(values, q) {
    var arr = [], i, v;
    for (i = 0; i < (values ? values.length : 0); i++) {
      v = toNum(values[i]);
      if (v !== null) arr.push(v);
    }
    if (!arr.length) return null;
    arr.sort(function (a, b) { return a - b; });
    var p = fin(q, BULLET_P95);
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    var idx = (arr.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
  }

  // C.BULLET_DOMAIN "p95-clamp": the axis runs 0 .. p95 of the peer values.
  // Bars past the end are clamped and get an overflow caret, so one PHP
  // 19,000/t outlier SKU cannot compress every other bar into a stub.
  // A set containing negatives gets a symmetric-ish domain instead, because a
  // 0-anchored track cannot show a negative bar at all.
  function p95Domain(values, q) {
    var lo = null, hi = null, i, v, has = false;
    for (i = 0; i < (values ? values.length : 0); i++) {
      v = toNum(values[i]);
      if (v === null) continue;
      has = true;
      if (lo === null || v < lo) lo = v;
      if (hi === null || v > hi) hi = v;
    }
    if (!has) return { min: 0, max: 1, mode: "p95-clamp" };
    // The cap is the RANK-based p95 (lower rank), not the interpolated one:
    // with five peers a linear p95 sits 80% of the way toward the outlier
    // (16,424 for a 19,000 max) and the clamp never fires, which is the exact
    // crush the mode exists to prevent. Below four peers nothing is clamped —
    // three regions are not a distribution.
    var sorted = [], cap;
    for (i = 0; i < (values ? values.length : 0); i++) {
      v = toNum(values[i]);
      if (v !== null) sorted.push(v);
    }
    sorted.sort(function (a, b) { return a - b; });
    if (sorted.length >= 4) {
      var pq = fin(q, BULLET_P95);
      if (pq < 0) pq = 0;
      if (pq > 1) pq = 1;
      cap = sorted[Math.floor((sorted.length - 1) * pq)];
    } else {
      cap = hi;
    }
    if (cap === null || cap === undefined) cap = hi;
    var max = Math.max(cap, 0);
    var min = lo < 0 ? lo * 1.08 : 0;
    if (max <= min) max = min + Math.max(Math.abs(min), 1);
    var st = niceStep((max - min) / 4);
    return {
      min: min < 0 ? Math.floor(min / st) * st : 0,
      max: Math.ceil(max / st) * st,
      mode: "p95-clamp"
    };
  }

  /* =========================================================================
   * 4. INSTANCE REGISTRY + ResizeObserver
   * ====================================================================== */

  var INSTANCES = [];

  // Wire a host to a draw function and keep it correct across width changes.
  // Re-render is rAF-coalesced and ignores sub-4px jitter, so a flex reflow
  // storm cannot turn into a hundred redraws.
  function attach(host, draw, spec) {
    if (!host || !host.appendChild) {
      return { update: function () {}, destroy: function () {}, host: null };
    }
    destroyHost(host);

    var inst = {
      host: host,
      spec: spec,
      draw: draw,
      lastW: -1,
      ro: null,
      winFn: null,
      raf: 0,
      dead: false
    };

    // Draw at the host's current width, guarding against a throwing spec so a
    // single bad payload cannot take the whole panel down.
    inst.paint = function () {
      if (inst.dead) return;
      var w = hostWidth(host);
      inst.lastW = w;
      clearHost(host);
      try {
        inst.draw(host, inst.spec, w);
      } catch (e) {
        var d = document.createElement("div");
        d.className = "mx2-svg-fail";
        d.style.font = "11px var(--mx2-font)";
        d.style.color = "var(--mx2-text3)";
        d.textContent = NULL_TEXT;
        host.appendChild(d);
      }
    };

    inst.schedule = function () {
      if (inst.dead || inst.raf) return;
      inst.raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
        inst.raf = 0;
        if (inst.dead) return;
        if (Math.abs(hostWidth(host) - inst.lastW) < 4) return;
        inst.paint();
      });
    };

    if (typeof window.ResizeObserver === "function") {
      inst.ro = new window.ResizeObserver(inst.schedule);
      inst.ro.observe(host);
    } else {
      inst.winFn = function () { inst.schedule(); };
      window.addEventListener("resize", inst.winFn);
    }

    var api = {
      host: host,
      // Repaint with a new spec. Same host, same instance — panels stay idempotent.
      update: function (nextSpec) {
        if (inst.dead) return api;
        inst.spec = nextSpec;
        inst.paint();
        return api;
      },
      // Force a repaint at the current width (e.g. after the host is un-hidden).
      refresh: function () { if (!inst.dead) inst.paint(); return api; },
      destroy: function () { killInstance(inst); }
    };

    inst.api = api;
    host.__mx2svg = inst;
    INSTANCES.push(inst);
    inst.paint();
    return api;
  }

  // Tear one instance down: observer, listener, pending frame, DOM. Safe twice.
  function killInstance(inst) {
    if (!inst || inst.dead) return;
    inst.dead = true;
    if (inst.ro) { try { inst.ro.disconnect(); } catch (e) {} inst.ro = null; }
    if (inst.winFn) { window.removeEventListener("resize", inst.winFn); inst.winFn = null; }
    if (inst.raf && window.cancelAnimationFrame) { window.cancelAnimationFrame(inst.raf); }
    inst.raf = 0;
    if (inst.host) {
      clearHost(inst.host);
      if (inst.host.__mx2svg === inst) { try { delete inst.host.__mx2svg; } catch (e2) { inst.host.__mx2svg = null; } }
    }
    var i = INSTANCES.indexOf(inst);
    if (i >= 0) INSTANCES.splice(i, 1);
  }

  // Destroy whatever component owns this host. Safe on a host that never had one.
  function destroyHost(host) {
    if (host && host.__mx2svg) killInstance(host.__mx2svg);
  }

  // Panel destroy() convenience: drop every live component in one call.
  function destroyAll() {
    var copy = INSTANCES.slice(0), i;
    for (i = 0; i < copy.length; i++) killInstance(copy[i]);
  }

  /* =========================================================================
   * 5. WATERFALL
   * ====================================================================== */

  // Role -> paint. Levers are saturated and signed; composition is a muted
  // slate in BOTH directions because a mix shift is not good or bad news; the
  // residual is gold and is the only bar the reader is meant to distrust; an
  // estimate (rule 6) is hatched in the mix slate with a dashed outline —
  // `hatch` is the url(#...) of this svg's pattern, created by the caller.
  function stepPaint(role, value, hatch) {
    if (role === "resid") {
      return { fill: "var(--mx2-resid)", stroke: "var(--mx2-resid-border)", text: "var(--mx2-resid)", dash: null };
    }
    if (role === "est") {
      return { fill: hatch || "var(--mx2-mix-soft)", stroke: "var(--mx2-mix)", text: "var(--mx2-mix)", dash: "3 2" };
    }
    if (role === "mix") {
      return { fill: "var(--mx2-mix-soft)", stroke: "var(--mx2-mix-border)", text: "var(--mx2-mix)", dash: null };
    }
    if (fin(value, 0) < 0) {
      return { fill: "var(--mx2-neg)", stroke: "var(--mx2-neg-border)", text: "var(--mx2-neg)", dash: null };
    }
    return { fill: "var(--mx2-pos)", stroke: "var(--mx2-pos-border)", text: "var(--mx2-pos)", dash: null };
  }

  // Group index for the 14px gutter rule: levers | composition | residual.
  // An estimated cost component sits with the levers: it is a split of Cost,
  // not a composition effect, and belongs beside the bar it explains.
  function roleGroup(role) {
    if (role === "resid") return 2;
    if (role === "mix") return 1;
    return 0;
  }

  // Category text colour per role: measured levers read at full contrast,
  // composition and estimates step back.
  function roleTextColor(role) {
    return (role === "mix" || role === "est") ? "var(--mx2-text3)" : "var(--mx2-text2)";
  }

  function isEstimate(st) {
    return !!st && (st.role === "est" || st.estimate === true);
  }

  // RULE 8: a PLACEHOLDER is a NAMED driver the wire does not carry (C.WATERFALL
  // _PLACEHOLDER). It has no value — never a fabricated one — and is kept in the
  // walk as a zero-width mark at the running level, drawn as a dashed outline,
  // labelled "not on the wire", with the caller's `tag` (why it is missing) in
  // the tooltip. It is IGNORED by the closure check and is not a dropped driver.
  var PH_ROLE = (C.WATERFALL_PLACEHOLDER && C.WATERFALL_PLACEHOLDER.role) || "placeholder";
  var PH_TAG  = (C.WATERFALL_PLACEHOLDER && C.WATERFALL_PLACEHOLDER.tag) || "not on the wire";
  function isPlaceholder(st) {
    return !!st && (st.role === PH_ROLE || st.placeholder === true);
  }

  // Label with the "(est.)" marker appended once, never twice.
  function estLabel(s) {
    var t = String(s === null || s === undefined ? "" : s);
    if (/\best\.?\)?\s*$/i.test(t) || /\(est\.?\)/i.test(t) || /estimat/i.test(t)) return t;
    return t ? t + " " + EST_SUFFIX : EST_SUFFIX;
  }

  // Normalise a spec into everything both orientations need. Pure: it never
  // mutates the spec it was handed, and it makes the closure decision ONCE so
  // the vertical and horizontal forms can never disagree about it.
  function waterfallModel(spec) {
    var s = spec || {};
    var unit = s.unit || "php_per_ton";
    var prior = toNum(s.anchorStart ? s.anchorStart.value : null);
    var current = toNum(s.anchorEnd ? s.anchorEnd.value : null);
    var raw = s.steps && s.steps.length ? s.steps : [];
    var steps = [], drivers = [], dropped = 0, placeholders = 0, hasEst = false, drillEst = false, i, j, v, st, est, role;

    for (i = 0; i < raw.length; i++) {
      st = raw[i] || {};
      if (isPlaceholder(st)) {
        // RULE 8: kept, valued at nothing, outside the closure sum.
        placeholders++;
        steps.push({
          label: (st.label === null || st.label === undefined) ? "" : String(st.label),
          value: 0, role: PH_ROLE, estimate: false, placeholder: true,
          tag: (st.tag === null || st.tag === undefined || st.tag === "") ? null : String(st.tag),
          drill: null
        });
        continue;
      }
      v = toNum(st.value);
      if (v === null) { dropped++; continue; }   // a null driver is not a zero
      est = isEstimate(st);
      role = est ? "est" : (st.role === "mix" || st.role === "resid" ? st.role : "lever");
      if (est) hasEst = true;
      if (st.drill && st.drill.length) {
        for (j = 0; j < st.drill.length; j++) if (isEstimate(st.drill[j])) drillEst = true;
      }
      steps.push({
        label: est ? estLabel(st.label) : (st.label === null || st.label === undefined ? "" : String(st.label)),
        value: v,
        role: role,
        estimate: est,
        drill: st.drill && st.drill.length ? st.drill : null
      });
      drivers.push(v);
    }

    var sum = 0;
    for (i = 0; i < drivers.length; i++) sum += drivers[i];

    // Closure (rule 5, C13). The delta is only knowable when BOTH anchors are
    // real numbers; with a missing anchor we cannot claim a residual and must
    // stay silent. The bound is a ROUNDING-DRIFT bound: canonical 3 PHP/ton,
    // phase-A 12 PHP/ton (spec.toleranceKind), or an explicit spec.tolerance.
    // spec.reconciles is carried for the tooltip but NEVER gates the bar.
    var delta = (prior !== null && current !== null) ? current - prior : null;
    var kind = s.toleranceKind === "phase_a" ? "phase_a" : "canonical";
    var tol = (typeof C.TOLERANCE === "function") ? toNum(C.TOLERANCE(drivers, kind)) : null;
    if (tol === null || !(tol > 0)) tol = TOL_FALLBACK[kind];
    var specTol = toNum(s.tolerance);
    if (specTol !== null && specTol > 0) tol = specTol;

    var residual = delta === null ? null : delta - sum;
    // With a DROPPED driver the gap between the anchors and the walk is that
    // missing driver, not rounding drift — the footnote already reports "N
    // drivers unavailable", and an "Unexplained (rounding drift)" bar would
    // mislabel it. The bar is drawn only when every driver was measured.
    var showResid = residual !== null && dropped === 0 && Math.abs(residual) > tol;

    var all = steps.slice(0);
    if (showResid) {
      all.push({ label: "Unexplained", value: residual, role: "resid", estimate: false, drill: null });
    }

    // Walk the cumulative delta. running starts at 0 = the prior level, which
    // is what makes the axis delta-framed rather than absolute.
    var run = 0, lo = 0, hi = 0;
    for (i = 0; i < all.length; i++) {
      all[i].from = run;
      run += all[i].value;
      all[i].to = run;
      // A placeholder sits with whatever precedes it (no gutter of its own).
      all[i].group = all[i].placeholder ? (i > 0 ? all[i - 1].group : 0) : roleGroup(all[i].role);
      if (run < lo) lo = run;
      if (run > hi) hi = run;
    }
    // The true endpoint must be inside the domain even when the drivers do not
    // reach it (an unclosed bridge with the residual suppressed cannot happen,
    // but a caller-supplied domain still has to contain it).
    if (delta !== null) {
      if (delta < lo) lo = delta;
      if (delta > hi) hi = delta;
    }

    return {
      title: s.title || "",
      subtitle: s.subtitle || null,
      unit: unit,
      prior: prior,
      current: current,
      delta: delta,
      priorLabel: (s.anchorStart && s.anchorStart.label) || "Prior",
      currentLabel: (s.anchorEnd && s.anchorEnd.label) || "Current",
      steps: all,
      sum: sum,
      residual: residual,
      tolerance: tol,
      toleranceKind: kind,
      reconciles: (s.reconciles === true || s.reconciles === false) ? s.reconciles : null,
      showResid: showResid,
      hasEst: hasEst,
      drillEst: drillEst,
      dropped: dropped,
      placeholders: placeholders,
      badges: normBadges(s.badges !== undefined ? s.badges : s.badge),
      footnote: s.footnote || null,
      // C2 / C.ANCHORS: both REQUIRED by C.WATERFALL_SPEC_SHAPE. Carried verbatim,
      // null-safe; rendered by drawWaterfallHead (anchors) and drawFootnote (basis).
      basisNote: (s.basisNote === null || s.basisNote === undefined || s.basisNote === "") ? null : String(s.basisNote),
      anchorsNote: (s.anchorsNote === null || s.anchorsNote === undefined || s.anchorsNote === "") ? null : String(s.anchorsNote),
      runMin: lo,
      runMax: hi,
      domain: s.domain || null
    };
  }

  // The cumulative-delta extents of a spec, exported so a caller can union two
  // bridges and hand the union back as spec.domain — the sanctioned way to put
  // reported and net bridges on ONE scale instead of two lying ones.
  function waterfallDomain(spec) {
    var m = waterfallModel(spec);
    var ax = axisFor(m.runMin, m.runMax, 5, PAD_FRAC);
    return { min: ax.min, max: ax.max };
  }

  // Resolve the plot axis: an explicit shared domain wins, otherwise pad the
  // running extremes by PAD_FRAC. Zero is always inside, because the walk
  // starts there.
  function waterfallAxis(m, target) {
    var ax = null;
    if (m.domain) ax = axisForDomain(m.domain.min, m.domain.max, target);
    if (!ax) ax = axisFor(m.runMin, m.runMax, target, PAD_FRAC);
    return ax;
  }

  // Tooltip lines for one bar, including its drill breakdown when present.
  // The Unexplained bar's lines name it as rounding drift (C13) and never as
  // a failed decomposition.
  function stepTipLines(st, unit, m) {
    var lines, i, d;
    if (st.placeholder) {
      // RULE 8: no value line at all — a placeholder never prints a number.
      lines = [txt(st.label), PH_TAG + " — no value is drawn"];
      if (st.tag) lines.push(st.tag);
      return lines;
    }
    lines = [st.label + "  " + fmtSigned(st.value, unit)];
    if (st.role === "mix") lines.push("composition, not a price action");
    if (st.role === "est") lines.push("estimate — production-order class ratio, not a measured cost");
    if (st.role === "resid") {
      lines.push("rounding drift: the rounded bars re-sum " + fmtSigned(st.value, unit) +
        " past the anchor delta, beyond the ±" + fmtValue(m.tolerance, unit) + " drift bound");
      if (m.toleranceKind === "phase_a") {
        lines.push("per-kg bridge ×1000; the server accepts 0.01 PHP/kg (10/t) of slack plus rounding");
      } else {
        lines.push("the decomposition itself is exact by construction; this is arithmetic, not a missing driver");
      }
      if (m.reconciles === false) lines.push("server flag: reconciles = false");
    }
    if (st.drill) {
      for (i = 0; i < st.drill.length; i++) {
        d = st.drill[i] || {};
        lines.push("   " + (isEstimate(d) ? estLabel(d.label) : txt(d.label)) + "  " + fmtSigned(d.value, unit));
      }
    }
    return lines;
  }

  // RULE 2: the anchor strip. Prior, delta and current as NUMERALS in a
  // surfaced band. Deliberately not a chart element — there is no second
  // scale here and there must never be one.
  function drawAnchorStrip(svg, x, y, w, m) {
    var h = 48;
    mk(svg, "rect", {
      x: px(x), y: px(y), width: px(w), height: h, rx: 8,
      fill: "var(--mx2-surface2)", stroke: "var(--mx2-border)", "stroke-width": 1
    });
    var cx = x + w / 2;
    var small = 9.5, big = w < 340 ? 15 : 17;

    label(svg, x + 12, y + 17, truncate(m.priorLabel, w / 3 - 16, small), small, "var(--mx2-text4)", "start", 600);
    label(svg, x + 12, y + 37, m.prior === null ? NULL_TEXT : fmtValue(m.prior, m.unit), big, "var(--mx2-text)", "start", 700);

    label(svg, x + w - 12, y + 17, truncate(m.currentLabel, w / 3 - 16, small), small, "var(--mx2-text4)", "end", 600);
    label(svg, x + w - 12, y + 37, m.current === null ? NULL_TEXT : fmtValue(m.current, m.unit), big, "var(--mx2-text)", "end", 700);

    var dCol = m.delta === null ? "var(--mx2-text3)"
      : (m.delta > 0 ? "var(--mx2-pos)" : (m.delta < 0 ? "var(--mx2-neg)" : "var(--mx2-text3)"));
    label(svg, cx, y + 17, "Δ", small, "var(--mx2-text4)", "middle", 600);
    label(svg, cx, y + 37, m.delta === null ? NULL_TEXT : fmtSigned(m.delta, m.unit), big - 2, dCol, "middle", 700);

    return h;
  }

  // Header block: title, subtitle, anchor strip. Returns the y where the plot
  // may start.
  function drawWaterfallHead(svg, W, m, padX) {
    var y = 0, bw = 0;
    // RULE 7: badges first, top-right, so the title knows how much room it has.
    if (m.badges.length) bw = drawBadges(svg, W - padX, 2, m.badges, Math.max(60, (W - padX * 2) * 0.55));
    if (m.title) {
      label(svg, padX, 15, truncate(m.title, W - padX * 2 - bw - (bw ? 8 : 0), 13), 13, "var(--mx2-text)", "start", 700);
    }
    if (m.title || bw) y = 22;
    // C.ANCHORS.panel_rule: the month-pair anchors are printed in the subtitle
    // line, appended when the caller's subtitle does not already carry them.
    var sub = m.subtitle || "";
    if (m.anchorsNote && sub.indexOf(m.anchorsNote) === -1) {
      sub = sub ? sub + "  ·  " + m.anchorsNote : m.anchorsNote;
    }
    if (sub) {
      label(svg, padX, y + 11, truncate(sub, W - padX * 2, 10.5), 10.5, "var(--mx2-text3)", "start", 500);
      y += 17;
    }
    y += 4;
    y += drawAnchorStrip(svg, padX, y, W - padX * 2, m);
    return y + 16;
  }

  // Footnote line. NOTE: a footnote that merely asserts closure is dropped —
  // RULE 5 says a passing check draws nothing at all, and "reconciles" in gold
  // or green is exactly the false precision that rule exists to prevent. When
  // the Unexplained bar IS drawn the footnote names it as rounding drift.
  function drawFootnote(svg, x, y, w, m) {
    var parts = [], txt;
    // C2: the basis label leads the footnote so no bridge is ever read without
    // knowing whether it is gross or net of the off-invoice discount.
    if (m.basisNote) parts.push(m.basisNote);
    if (m.dropped > 0) {
      parts.push(m.dropped + (m.dropped === 1 ? " driver unavailable" : " drivers unavailable"));
    }
    if (m.showResid) {
      parts.push("Unexplained " + fmtSigned(m.residual, m.unit) +
        ": rounding drift beyond the ±" + fmtValue(m.tolerance, m.unit) + " bound, not a failed decomposition");
    }
    if (m.hasEst || m.drillEst) parts.push("hatched = estimate");
    if (m.placeholders > 0) parts.push("dashed outline = " + PH_TAG);
    if (m.footnote && !/reconcil/i.test(m.footnote)) parts.push(String(m.footnote));
    if (!parts.length) return 0;
    txt = parts.join("  ·  ");
    label(svg, x, y + 10, truncate(txt, w, 10), 10,
      m.showResid ? "var(--mx2-resid)" : "var(--mx2-text3)", "start", 500);
    return 16;
  }

  // ---- vertical form (>= 640px) -------------------------------------------
  function drawWaterfallVertical(host, spec, W) {
    var m = waterfallModel(spec);
    var padX = 12, padL = 58, padR = 14;
    var n = m.steps.length;

    var plotH = W >= 1100 ? 250 : (W >= 768 ? 220 : 196);
    var catH = 32;                                   // two 11px label lines
    var svg = rootSvg(host, W, 10, m.title || "GM bridge");
    var top = drawWaterfallHead(svg, W, m, padX);

    // Empty bridge: say so in words. A blank plot frame reads as "loading".
    if (!n) {
      label(svg, padX, top + 14, "No drivers to decompose.", 11, "var(--mx2-text3)", "start", 500);
      svg.setAttribute("height", px(top + 30));
      svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(top + 30));
      return;
    }

    var ax = waterfallAxis(m, 5);
    var span = ax.max - ax.min || 1;
    var plotX = padL, plotW = Math.max(60, W - padL - padR);
    var plotY = top, plotB = plotY + plotH;

    // y() maps a CUMULATIVE DELTA to a pixel. Not an absolute peso level.
    function y(v) { return plotB - (fin(v, 0) - ax.min) / span * plotH; }

    // Slot geometry, with a 14px gutter inserted at every group change.
    var gutters = 0, i;
    for (i = 1; i < n; i++) if (m.steps[i].group !== m.steps[i - 1].group) gutters++;
    var slot = (plotW - gutters * GUTTER) / n;
    var barW = Math.max(6, Math.min(58, slot * 0.62));

    var xs = [], acc = 0;
    for (i = 0; i < n; i++) {
      if (i > 0 && m.steps[i].group !== m.steps[i - 1].group) acc += GUTTER;
      xs.push(plotX + acc + slot * i + slot / 2);
    }

    // gridlines + tick labels
    var g = mk(svg, "g", null), t, yy;
    for (i = 0; i < ax.ticks.length; i++) {
      t = ax.ticks[i];
      yy = y(t);
      mk(g, "line", {
        x1: px(plotX), y1: px(yy), x2: px(plotX + plotW), y2: px(yy),
        stroke: t === 0 ? "var(--mx2-grid-zero)" : "var(--mx2-grid)",
        "stroke-width": t === 0 ? 1.25 : 1
      });
      label(g, plotX - 8, yy + 3.5, fmtTick(t, m.unit), 10, "var(--mx2-axis)", "end", 500);
    }
    // Name the zero rule: it is the prior level, and that is not obvious.
    // Guarded because a caller-supplied shared domain need not contain zero.
    if (ax.min <= 0 && ax.max >= 0) {
      label(g, plotX + plotW, y(0) - 5, "prior level", 9, "var(--mx2-text4)", "end", 500);
    }

    // step connectors, drawn under the bars
    var conn = mk(svg, "g", null);
    for (i = 0; i < n - 1; i++) {
      mk(conn, "line", {
        x1: px(xs[i] + barW / 2), y1: px(y(m.steps[i].to)),
        x2: px(xs[i + 1] - barW / 2), y2: px(y(m.steps[i].to)),
        stroke: "var(--mx2-border-strong)", "stroke-width": 1,
        "stroke-dasharray": "3 3"
      });
    }

    // bars + sign-correct labels (RULE 3); estimates hatched (RULE 6)
    var hatch = m.hasEst ? hatchPattern(svg) : null;
    var st, p, hiV, loV, bh, by, lblY, txt, lines, li, gc;
    for (i = 0; i < n; i++) {
      st = m.steps[i];
      if (st.placeholder) {
        // RULE 8: an outlined, unfilled, zero-height mark at the running level.
        by = y(st.from);
        gc = mk(svg, "g", { "class": "mx2-wf-step mx2-wf-placeholder", "data-role": PH_ROLE });
        mk(gc, "rect", {
          x: px(xs[i] - barW / 2), y: px(by - 4), width: px(barW), height: 8,
          rx: 2, fill: "none", stroke: "var(--mx2-text4)", "stroke-width": 1,
          "stroke-dasharray": "3 2"
        });
        tip(gc, stepTipLines(st, m.unit, m));
        label(svg, xs[i], by - 9, PH_TAG, 9, "var(--mx2-text4)", "middle", 600);
        lines = wrapLabel(st.label, slot - 2, 10, 2);
        for (li = 0; li < lines.length; li++) {
          label(svg, xs[i], plotB + 14 + li * 12, lines[li], 10, "var(--mx2-text4)", "middle", 600);
        }
        continue;
      }
      p = stepPaint(st.role, st.value, hatch);
      hiV = Math.max(st.from, st.to);
      loV = Math.min(st.from, st.to);
      by = y(hiV);
      bh = Math.max(1.5, y(loV) - y(hiV));

      gc = mk(svg, "g", { "class": "mx2-wf-step", "data-role": st.role });
      mk(gc, "rect", {
        x: px(xs[i] - barW / 2), y: px(by), width: px(barW), height: px(bh),
        rx: 2, fill: p.fill, stroke: p.stroke, "stroke-width": 1,
        "stroke-dasharray": p.dash
      });
      tip(gc, stepTipLines(st, m.unit, m));

      // A drillable bar gets a 3px dot; the breakdown is in its tooltip.
      if (st.drill) {
        mk(gc, "circle", {
          cx: px(xs[i]), cy: px(by + bh / 2), r: 1.8,
          fill: "var(--mx2-text)", stroke: "none"
        });
      }

      // positive above the top edge, negative below the bottom edge — never
      // over the bar, never over the neighbour's bar.
      lblY = st.value >= 0 ? by - 7 : by + bh + 12;
      label(svg, xs[i], lblY, fmtSigned(st.value, m.unit), 10.5, p.text, "middle", 700);

      // category labels below the plot, wrapped to two lines
      lines = wrapLabel(st.label, slot - 2, 10, 2);
      for (li = 0; li < lines.length; li++) {
        label(svg, xs[i], plotB + 14 + li * 12, lines[li], 10, roleTextColor(st.role), "middle", 600);
      }
    }

    // baseline under the plot
    mk(svg, "line", {
      x1: px(plotX), y1: px(plotB), x2: px(plotX + plotW), y2: px(plotB),
      stroke: "var(--mx2-border)", "stroke-width": 1
    });

    var fy = plotB + catH + 6;
    var fh = drawFootnote(svg, padX, fy, W - padX * 2, m);
    var H = fy + fh + 6;
    svg.setAttribute("height", px(H));
    svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(H));
  }

  // ---- horizontal form (< 640px) ------------------------------------------
  // Six stacked categories cannot be read as vertical bars at 375px: the
  // labels collide long before the bars do. netbridge.js:34-44 ships the
  // horizontal form already; this is the same idea on a real axis.
  function drawWaterfallHorizontal(host, spec, W) {
    var m = waterfallModel(spec);
    var padX = 10;
    var labW = Math.min(96, Math.max(64, W * 0.26));
    var plotX = padX + labW + 8;
    var plotW = Math.max(60, W - plotX - padX - 6);
    var n = m.steps.length;
    var rowH = 30, barH = 15;

    var svg = rootSvg(host, W, 10, m.title || "GM bridge");
    var top = drawWaterfallHead(svg, W, m, padX);

    if (!n) {
      label(svg, padX, top + 14, "No drivers to decompose.", 11, "var(--mx2-text3)", "start", 500);
      svg.setAttribute("height", px(top + 30));
      svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(top + 30));
      return;
    }

    var ax = waterfallAxis(m, W < 420 ? 3 : 4);
    var span = ax.max - ax.min || 1;
    function x(v) { return plotX + (clamp(v, ax.min, ax.max) - ax.min) / span * plotW; }

    var plotTop = top + 12;
    var rowTops = [], acc = 0, i;
    for (i = 0; i < n; i++) {
      if (i > 0 && m.steps[i].group !== m.steps[i - 1].group) acc += GUTTER;
      rowTops.push(plotTop + acc + rowH * i);
    }
    var plotB = rowTops[n - 1] + rowH;

    // vertical gridlines + tick labels above the plot
    var g = mk(svg, "g", null), t, xx;
    for (i = 0; i < ax.ticks.length; i++) {
      t = ax.ticks[i];
      xx = x(t);
      mk(g, "line", {
        x1: px(xx), y1: px(plotTop - 2), x2: px(xx), y2: px(plotB),
        stroke: t === 0 ? "var(--mx2-grid-zero)" : "var(--mx2-grid)",
        "stroke-width": t === 0 ? 1.25 : 1
      });
      label(g, xx, plotTop - 6, fmtTick(t, m.unit), 9, "var(--mx2-axis)", "middle", 500);
    }

    // connectors: vertical dashes joining the end of one bar to the start of
    // the next, which is what makes the stack read as a single walk.
    var conn = mk(svg, "g", null);
    for (i = 0; i < n - 1; i++) {
      mk(conn, "line", {
        x1: px(x(m.steps[i].to)), y1: px(rowTops[i] + rowH - (rowH - barH) / 2),
        x2: px(x(m.steps[i].to)), y2: px(rowTops[i + 1] + (rowH - barH) / 2),
        stroke: "var(--mx2-border-strong)", "stroke-width": 1, "stroke-dasharray": "3 3"
      });
    }

    var hatch = m.hasEst ? hatchPattern(svg) : null;
    var st, p, x0, x1, by, txt, tw, tx, anchor, gc;
    for (i = 0; i < n; i++) {
      st = m.steps[i];
      by = rowTops[i] + (rowH - barH) / 2;
      if (st.placeholder) {
        // RULE 8: outlined, unfilled, zero-width mark at the running level.
        x0 = x(st.from);
        label(svg, padX + labW, by + barH / 2 + 3.5, truncate(st.label, labW - 4, 10), 10,
          "var(--mx2-text4)", "end", 600);
        gc = mk(svg, "g", { "class": "mx2-wf-step mx2-wf-placeholder", "data-role": PH_ROLE });
        mk(gc, "rect", {
          x: px(x0 - 4), y: px(by), width: 8, height: barH,
          rx: 2, fill: "none", stroke: "var(--mx2-text4)", "stroke-width": 1,
          "stroke-dasharray": "3 2"
        });
        tip(gc, stepTipLines(st, m.unit, m));
        txt = PH_TAG;
        tw = textW(txt, 9);
        tx = x0 + 9; anchor = "start";
        if (tx + tw > plotX + plotW) { tx = x0 - 9; anchor = "end"; }
        label(svg, tx, by + barH / 2 + 3.5, txt, 9, "var(--mx2-text4)", anchor, 600);
        continue;
      }
      p = stepPaint(st.role, st.value, hatch);
      x0 = x(Math.min(st.from, st.to));
      x1 = x(Math.max(st.from, st.to));

      label(svg, padX + labW, by + barH / 2 + 3.5, truncate(st.label, labW - 4, 10), 10,
        roleTextColor(st.role), "end", 600);

      gc = mk(svg, "g", { "class": "mx2-wf-step", "data-role": st.role });
      mk(gc, "rect", {
        x: px(x0), y: px(by), width: px(Math.max(1.5, x1 - x0)), height: barH,
        rx: 2, fill: p.fill, stroke: p.stroke, "stroke-width": 1,
        "stroke-dasharray": p.dash
      });
      tip(gc, stepTipLines(st, m.unit, m));

      // Value sits just past the leading edge; if that would run off the plot
      // it flips inside the bar rather than being clipped away.
      txt = fmtSigned(st.value, m.unit);
      tw = textW(txt, 10);
      if (st.value >= 0) {
        tx = x1 + 5; anchor = "start";
        if (tx + tw > plotX + plotW) { tx = x1 - 5; anchor = "end"; }
      } else {
        tx = x0 - 5; anchor = "end";
        if (tx - tw < plotX) { tx = x0 + 5; anchor = "start"; }
      }
      label(svg, tx, by + barH / 2 + 3.5, txt, 10, p.text, anchor, 700);
    }

    var fy = plotB + 8;
    var fh = drawFootnote(svg, padX, fy, W - padX * 2, m);
    var H = fy + fh + 8;
    svg.setAttribute("height", px(H));
    svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(H));
  }

  // Public entry. Orientation is chosen from the REAL host width every paint,
  // so a panel that goes from a drawer to a full page flips form on its own.
  function waterfall(host, spec) {
    return attach(host, function (h, s, W) {
      var forced = s && s.orientation;
      if (forced === "horizontal" || (forced !== "vertical" && W < MOBILE_W)) {
        drawWaterfallHorizontal(h, s, W);
      } else {
        drawWaterfallVertical(h, s, W);
      }
    }, spec);
  }

  // Fold drivers below C.MATERIALITY_PHP_T into a single "Other" bar. NOT
  // applied automatically — which drivers are material is an adapter decision
  // — but the threshold and the arithmetic live here so nobody re-invents it.
  function foldImmaterial(steps, threshold) {
    var lim = fin(threshold, MATERIALITY);
    var keep = [], other = 0, folded = 0, allMix = true, i, v, st;
    for (i = 0; i < (steps ? steps.length : 0); i++) {
      st = steps[i] || {};
      v = toNum(st.value);
      if (v === null) continue;
      if (Math.abs(v) < lim && st.role !== "resid") {
        other += v;
        folded++;
        if (st.role !== "mix") allMix = false;
      } else {
        keep.push(st);
      }
    }
    // "Other" inherits the mix role only when everything folded into it was
    // composition; a folded lever must not be laundered into a muted bar.
    if (folded > 0 && Math.abs(other) > 0) {
      keep.push({ label: "Other", value: other, role: allMix ? "mix" : "lever", drill: null });
    }
    return keep;
  }

  /* =========================================================================
   * 6. BULLET
   * ====================================================================== */

  // Band zones across a domain, in draw order. Absent bands give one flat
  // "relative" track — per the contract, an invented threshold would put an
  // authoritative green tick next to a number nobody has agreed a standard for.
  function bandZones(bands, dmin, dmax) {
    var good = bands ? toNum(bands.good) : null;
    var warn = bands ? toNum(bands.warn) : null;
    if (good === null || warn === null) {
      return [{ from: dmin, to: dmax, fill: "var(--mx2-band-rel)" }];
    }
    var higher = !bands.dir || bands.dir === "higher-is-better";
    if (higher) {
      return [
        { from: dmin, to: Math.min(warn, dmax), fill: "var(--mx2-band-bad)" },
        { from: Math.min(warn, dmax), to: Math.min(good, dmax), fill: "var(--mx2-band-warn)" },
        { from: Math.min(good, dmax), to: dmax, fill: "var(--mx2-band-good)" }
      ];
    }
    return [
      { from: dmin, to: Math.min(good, dmax), fill: "var(--mx2-band-good)" },
      { from: Math.min(good, dmax), to: Math.min(warn, dmax), fill: "var(--mx2-band-warn)" },
      { from: Math.min(warn, dmax), to: dmax, fill: "var(--mx2-band-bad)" }
    ];
  }

  // Colour for the status word at the end of a row.
  function statusColor(status) {
    if (status === "good") return "var(--mx2-pos)";
    if (status === "warn") return "var(--mx2-resid)";
    if (status === "bad") return "var(--mx2-neg)";
    return "var(--mx2-mix)";
  }

  // Accepts one bullet spec, an array of them (a strip sharing one domain), or
  // { rows:[...], badges, domain } so a strip can carry the badge slot.
  function drawBullets(host, spec, W) {
    var o = (spec && spec.rows && spec.rows.length !== undefined) ? spec : null;
    var rows = o ? o.rows : ((spec && spec.length !== undefined) ? spec : [spec]);
    var badges = normBadges(o ? (o.badges !== undefined ? o.badges : o.badge) : null);
    var list = [], i, r;
    for (i = 0; i < rows.length && list.length < ROW_CAP; i++) {
      if (rows[i]) list.push(rows[i]);
    }
    var n = list.length;
    var svg = rootSvg(host, W, 10, "Bullet comparison");
    if (!n) {
      label(svg, 0, 12, "No rows in this scope.", 11, "var(--mx2-text3)", "start", 500);
      svg.setAttribute("height", 20);
      svg.setAttribute("viewBox", "0 0 " + px(W) + " 20");
      return;
    }

    // Shared domain: an explicit spec.domain wins; otherwise the p95 clamp
    // across every value AND comparator in the strip, so the tick and the bar
    // are always on one scale.
    var dom = (o && o.domain && toNum(o.domain.max) !== null) ? o.domain : null, vals = [], j;
    for (i = 0; i < n; i++) {
      if (!dom && list[i].domain && toNum(list[i].domain.max) !== null) dom = list[i].domain;
      vals.push(toNum(list[i].value));
      vals.push(toNum(list[i].comparator));
    }
    if (!dom || toNum(dom.min) === null || toNum(dom.max) === null) dom = p95Domain(vals);
    var dmin = fin(dom.min, 0), dmax = fin(dom.max, 1);
    if (dmax <= dmin) dmax = dmin + 1;
    var span = dmax - dmin;

    var narrow = W < 480;
    var labW = Math.min(narrow ? 92 : 150, Math.max(64, W * 0.24));
    var valW = narrow ? 66 : 82;
    var statW = narrow ? 0 : 62;                     // status word hides when tight
    var headH = badges.length ? 22 : 14;
    var rowH = 26, trackH = 11;
    var trackX = labW + 10;
    var trackW = Math.max(40, W - trackX - valW - statW - 8);
    function x(v) { return trackX + (clamp(v, dmin, dmax) - dmin) / span * trackW; }

    // One header at the top-right names the column: "vs target" when the cut
    // has verified bands, literally "relative" when it does not.
    var anyBands = false;
    for (i = 0; i < n; i++) if (list[i].bands) anyBands = true;
    var headLabel = list[0].domainLabel === "relative" || !anyBands
      ? BAND_LABELS.relative : BAND_LABELS.absolute;
    label(svg, W - 2, 10, headLabel, 9, "var(--mx2-text4)", "end", 600);
    // RULE 7: badges sit to the left of the column label, same header row.
    if (badges.length) drawBadges(svg, W - 2 - textW(headLabel, 9) - 10, 0, badges, Math.max(60, W * 0.5));

    var y0, spec1, val, cmp, bz, k, z, zx0, zx1, xv, x0, barFill, over, st, lines, hit;
    for (i = 0; i < n; i++) {
      spec1 = list[i];
      y0 = headH + i * rowH;
      val = toNum(spec1.value);
      cmp = toNum(spec1.comparator);

      label(svg, 0, y0 + trackH + 4, truncate(spec1.label, labW - 4, 10.5), 10.5,
        "var(--mx2-text2)", "start", 600);

      // band zones (or the single flat relative track)
      bz = bandZones(spec1.bands, dmin, dmax);
      for (k = 0; k < bz.length; k++) {
        z = bz[k];
        zx0 = x(z.from); zx1 = x(z.to);
        if (zx1 - zx0 < 0.5) continue;
        mk(svg, "rect", {
          x: px(zx0), y: px(y0 + 2), width: px(zx1 - zx0), height: trackH,
          rx: 2, fill: z.fill, stroke: "none"
        });
      }
      // track outline, so an empty domain still reads as a measurable strip
      mk(svg, "rect", {
        x: px(trackX), y: px(y0 + 2), width: px(trackW), height: trackH,
        rx: 2, fill: "none", stroke: "var(--mx2-border)", "stroke-width": 1
      });

      if (val === null) {
        label(svg, trackX + 6, y0 + trackH - 1, NULL_TEXT, 10, "var(--mx2-text4)", "start", 500);
      } else {
        // value bar: from the domain's zero (or its floor when the whole
        // domain is positive) to the value.
        x0 = x(dmin > 0 ? dmin : 0);
        xv = x(val);
        barFill = val < 0 ? "var(--mx2-neg)" : "var(--mx2-bullet-value)";
        mk(svg, "rect", {
          x: px(Math.min(x0, xv)), y: px(y0 + 5), width: px(Math.max(1.5, Math.abs(xv - x0))),
          height: trackH - 6, rx: 1.5, fill: barFill, stroke: "none"
        });
        // overflow caret — the p95 clamp hid the true magnitude, say so
        over = val > dmax;
        if (over) {
          mk(svg, "path", {
            d: "M" + px(trackX + trackW + 1) + "," + px(y0 + 3) +
               " L" + px(trackX + trackW + 7) + "," + px(y0 + 2 + trackH / 2) +
               " L" + px(trackX + trackW + 1) + "," + px(y0 + 1 + trackH) + " Z",
            fill: barFill, stroke: "none"
          });
        }
      }

      // comparator tick
      if (cmp !== null) {
        mk(svg, "line", {
          x1: px(x(cmp)), y1: px(y0), x2: px(x(cmp)), y2: px(y0 + trackH + 4),
          stroke: "var(--mx2-bullet-marker)", "stroke-width": 2
        });
      }

      label(svg, W - statW - 6, y0 + trackH + 3, fmtValue(val, spec1.unit || "php_per_ton"),
        10.5, "var(--mx2-text)", "end", 700);

      // A5 / C.BULLET_STATUS_RULE: resolve the status word ONCE and use it for
      // BOTH the text and the colour. A peer-relative row has no verdict, so
      // it can never print "relative" in verdict green. A row with no verified
      // bands is relative whatever its status field claims.
      st = (spec1.domainLabel === "relative" || !spec1.bands)
        ? "relative"
        : ((spec1.status === "good" || spec1.status === "warn" || spec1.status === "bad") ? spec1.status : "relative");
      if (statW) {
        label(svg, W - 2, y0 + trackH + 3, st, 9.5, statusColor(st), "end", 600)
          .setAttribute("class", "mx2-bullet-status");
      }

      // A transparent hit rect over the whole row carries the tooltip, so the
      // reader gets the comparator and the "no verified thresholds" caveat
      // without any hover listener to leak on destroy().
      lines = [txt(spec1.label) + "  " + fmtValue(val, spec1.unit || "php_per_ton")];
      if (cmp !== null) lines.push((spec1.comparatorLabel || "comparator") + "  " + fmtValue(cmp, spec1.unit || "php_per_ton"));
      if (st === "relative") lines.push("no verified thresholds for this cut — relative scale, no verdict");
      else lines.push("vs target: " + st);
      hit = mk(svg, "rect", {
        x: 0, y: px(y0), width: px(W), height: px(rowH),
        fill: "var(--mx2-surface)", stroke: "none", "fill-opacity": 0
      });
      tip(hit, lines);
    }

    var H = headH + n * rowH + 4;
    svg.setAttribute("height", px(H));
    svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(H));
  }

  // Public entry: accepts one spec or an array (a strip sharing one domain).
  function bullet(host, spec) {
    return attach(host, drawBullets, spec);
  }

  /* =========================================================================
   * 7. SPARKLINE
   * ====================================================================== */

  // Normalise a point series. On the wire (WIRE): trend points are EXACTLY
  // { month, gm_per_ton } (C8, no partial); trajectory points carry gm_per_ton
  // with `partial` only on a running last month (C17); category-trend cells
  // carry gm_ton (C19); discount_overlay.series carries THREE per-kg figures
  // (gm_per_kg_reported / discount_per_kg / gm_per_kg_net) so an adapter MUST
  // name the field via spec.key — there is no safe default between them.
  // {value | y} are accepted for pre-mapped series and bare number arrays.
  function sparkPoints(series, key) {
    var out = [], i, p, v;
    for (i = 0; i < (series ? series.length : 0); i++) {
      p = series[i];
      if (p === null || p === undefined) { out.push({ v: null, label: "", partial: false }); continue; }
      if (typeof p === "number" || typeof p === "string") {
        out.push({ v: toNum(p), label: "", partial: false });
        continue;
      }
      v = key ? toNum(p[key]) : null;
      if (v === null && !key) {
        v = toNum(p.value);
        if (v === null) v = toNum(p.y);
        if (v === null) v = toNum(p.gm_per_ton);
        if (v === null) v = toNum(p.gm_ton);
        if (v === null) v = toNum(p.rev_per_ton);
      }
      out.push({
        v: v,
        label: p.label || p.month || p.period || "",
        partial: !!p.partial
      });
    }
    return out;
  }

  function drawSpark(host, spec, W) {
    var o = (spec && spec.series) ? spec : { series: spec };
    var pts = sparkPoints(o.series, typeof o.key === "string" && o.key ? o.key : null);
    var unit = o.unit || "php_per_ton";
    var badges = normBadges(o.badges !== undefined ? o.badges : o.badge);
    var padTop = badges.length ? BADGE_H + 6 : 5;   // rule 7: reserve the top strip
    var H = Math.max(24, fin(o.height, 44)) + (badges.length ? padTop - 5 : 0);
    var padY = 5;
    var svg = rootSvg(host, W, H, o.title || "Trend");
    if (badges.length) drawBadges(svg, W - 1, 0, badges, Math.max(60, W * 0.7));

    var vals = [], i, n = pts.length;
    for (i = 0; i < n; i++) if (pts[i].v !== null) vals.push(pts[i].v);
    if (!vals.length) {
      label(svg, 0, padTop + (H - padTop) / 2 + 3.5, NULL_TEXT, 11, "var(--mx2-text4)", "start", 500);
      return;
    }

    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    // A sparkline is NOT zero-anchored either: a 2% month-on-month move on a
    // 5,000/t line is the whole story and a zero base flattens it to nothing.
    var ax = axisFor(lo, hi, 3, 0.12);
    var span = ax.max - ax.min || 1;
    var plotW = Math.max(20, W - 2);
    function X(i2) { return 1 + (n <= 1 ? plotW / 2 : (i2 / (n - 1)) * plotW); }
    function Y(v) { return padTop + (1 - (fin(v, ax.min) - ax.min) / span) * (H - padTop - padY); }

    // Contiguous runs only: a null is a hole in the data and the line must
    // break there rather than interpolate across a month that never posted.
    var segs = [], cur = null;
    for (i = 0; i < n; i++) {
      if (pts[i].v === null) { if (cur && cur.length > 1) segs.push(cur); cur = null; continue; }
      if (!cur) cur = [];
      cur.push(i);
    }
    if (cur && cur.length > 1) segs.push(cur);

    // Isolated readings (a lone month between two holes) get a dot of their
    // own. Dropping them would silently shorten the series.
    var prevNull, nextNull;
    for (i = 0; i < n; i++) {
      if (pts[i].v === null) continue;
      prevNull = (i === 0) || pts[i - 1].v === null;
      nextNull = (i === n - 1) || pts[i + 1].v === null;
      if (prevNull && nextNull) {
        mk(svg, "circle", {
          cx: px(X(i)), cy: px(Y(pts[i].v)), r: 2.2,
          fill: "var(--mx2-accent)", stroke: "none"
        });
      }
    }

    var s, k, d, area, partial;
    for (s = 0; s < segs.length; s++) {
      d = ""; area = "";
      for (k = 0; k < segs[s].length; k++) {
        i = segs[s][k];
        d += (k ? " L" : "M") + px(X(i)) + "," + px(Y(pts[i].v));
      }
      if (o.area !== false && segs[s].length > 1) {
        area = d + " L" + px(X(segs[s][segs[s].length - 1])) + "," + px(H) +
               " L" + px(X(segs[s][0])) + "," + px(H) + " Z";
        mk(svg, "path", { d: area, fill: "var(--mx2-accent-soft)", stroke: "none" });
      }
      // A segment touching a partial month is dashed: a part-month point is
      // not comparable to a closed one and must not read as a settled figure.
      partial = false;
      for (k = 0; k < segs[s].length; k++) if (pts[segs[s][k]].partial) partial = true;
      if (segs[s].length > 1) {
        mk(svg, "path", {
          d: d, fill: "none", stroke: "var(--mx2-accent)", "stroke-width": 1.75,
          "stroke-linecap": "round", "stroke-linejoin": "round",
          "stroke-dasharray": partial ? "4 3" : null
        });
      }
    }

    // last real point, marked
    var lastIdx = -1;
    for (i = n - 1; i >= 0; i--) if (pts[i].v !== null) { lastIdx = i; break; }
    if (lastIdx >= 0) {
      mk(svg, "circle", {
        cx: px(X(lastIdx)), cy: px(Y(pts[lastIdx].v)), r: 2.6,
        fill: "var(--mx2-accent)", stroke: "var(--mx2-surface)", "stroke-width": 1
      });
    }

    var firstIdx = -1;
    for (i = 0; i < n; i++) if (pts[i].v !== null) { firstIdx = i; break; }
    var lines = [];
    if (firstIdx >= 0) lines.push((pts[firstIdx].label || "first") + "  " + fmtValue(pts[firstIdx].v, unit));
    if (lastIdx >= 0) lines.push((pts[lastIdx].label || "last") + "  " + fmtValue(pts[lastIdx].v, unit));
    if (firstIdx >= 0 && lastIdx >= 0 && lastIdx !== firstIdx) {
      lines.push("Δ " + fmtSigned(pts[lastIdx].v - pts[firstIdx].v, unit));
    }
    tip(svg, lines);
  }

  // Public entry. Accepts a bare array, or { series, unit, height, area, title }.
  function sparkline(host, series) {
    return attach(host, drawSpark, series);
  }

  /* =========================================================================
   * 8. DIVERGING
   * ====================================================================== */

  function drawDiverging(host, spec, W) {
    var o = (spec && spec.length !== undefined) ? { rows: spec } : (spec || {});
    var src = o.rows || [];
    var unit = o.unit || "php_per_ton";
    var list = [], i, r, v;
    for (i = 0; i < src.length && list.length < ROW_CAP; i++) {
      r = src[i] || {};
      v = toNum(r.value);
      list.push({
        label: r.label === null || r.label === undefined ? (r.key || r.ssg || "") : String(r.label),
        value: v,
        role: r.role === "mix" ? "mix" : "lever"
      });
    }
    var n = list.length;
    var rowH = fin(o.rowH, 22);
    var svg = rootSvg(host, W, 10, o.title || "Contribution");
    var y = 0, bw = 0;
    var badges = normBadges(o.badges !== undefined ? o.badges : o.badge);

    if (badges.length) bw = drawBadges(svg, W - 1, 0, badges, Math.max(60, W * 0.55));
    if (o.title) label(svg, 0, 12, truncate(o.title, W - bw - (bw ? 8 : 0), 12), 12, "var(--mx2-text)", "start", 700);
    if (o.title || bw) y = 20;
    if (!n) {
      label(svg, 0, y + 12, "No rows in this scope.", 11, "var(--mx2-text3)", "start", 500);
      svg.setAttribute("height", px(y + 20));
      svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(y + 20));
      return;
    }

    var narrow = W < 480;
    var labW = Math.min(narrow ? 96 : 160, Math.max(60, W * 0.26));
    var valW = narrow ? 62 : 78;
    var plotX = labW + 8;
    var plotW = Math.max(40, W - plotX - valW - 6);

    // Symmetric domain around zero: an asymmetric one makes a −40 look bigger
    // than a +40, which is the exact misread this mark exists to prevent.
    var m = 0;
    for (i = 0; i < n; i++) if (list[i].value !== null) m = Math.max(m, Math.abs(list[i].value));
    if (!(m > 0)) m = 1;
    var step = niceStep(m * 1.18 / 2);
    var lim = Math.ceil(m * 1.18 / step) * step;
    function X(v) { return plotX + (clamp(v, -lim, lim) + lim) / (2 * lim) * plotW; }

    var zeroX = X(0);
    var plotTop = y + 4;
    var plotB = plotTop + n * rowH;

    // axis extremes + zero rule
    label(svg, plotX, plotTop - 3, fmtTick(-lim, unit), 9, "var(--mx2-axis)", "start", 500);
    label(svg, plotX + plotW, plotTop - 3, fmtTick(lim, unit), 9, "var(--mx2-axis)", "end", 500);
    mk(svg, "line", {
      x1: px(zeroX), y1: px(plotTop), x2: px(zeroX), y2: px(plotB),
      stroke: "var(--mx2-grid-zero)", "stroke-width": 1.25
    });

    var barH = Math.max(6, rowH - 9), ry, xv, fillV, strokeV, txtV, gc;
    for (i = 0; i < n; i++) {
      r = list[i];
      ry = plotTop + i * rowH + (rowH - barH) / 2;
      label(svg, labW, ry + barH / 2 + 3.5, truncate(r.label, labW - 4, 10), 10,
        "var(--mx2-text2)", "end", 600);

      if (r.value === null) {
        label(svg, zeroX + 5, ry + barH / 2 + 3.5, NULL_TEXT, 10, "var(--mx2-text4)", "start", 500);
        continue;
      }
      if (r.role === "mix") {
        fillV = "var(--mx2-mix-soft)"; strokeV = "var(--mx2-mix-border)"; txtV = "var(--mx2-mix)";
      } else if (r.value < 0) {
        fillV = "var(--mx2-neg)"; strokeV = "var(--mx2-neg-border)"; txtV = "var(--mx2-neg)";
      } else {
        fillV = "var(--mx2-pos)"; strokeV = "var(--mx2-pos-border)"; txtV = "var(--mx2-pos)";
      }
      xv = X(r.value);
      gc = mk(svg, "g", null);
      mk(gc, "rect", {
        x: px(Math.min(zeroX, xv)), y: px(ry),
        width: px(Math.max(1.5, Math.abs(xv - zeroX))), height: px(barH),
        rx: 2, fill: fillV, stroke: strokeV, "stroke-width": 1
      });
      tip(gc, [txt(r.label) + "  " + fmtSigned(r.value, unit)]);

      label(svg, W - 2, ry + barH / 2 + 3.5, fmtSigned(r.value, unit), 10, txtV, "end", 700);
    }

    var H = plotB + 6;
    if (src.length > ROW_CAP) {
      label(svg, 0, H + 10, "+" + (src.length - ROW_CAP) + " more rows not shown", 10,
        "var(--mx2-text3)", "start", 500);
      H += 16;
    }
    svg.setAttribute("height", px(H));
    svg.setAttribute("viewBox", "0 0 " + px(W) + " " + px(H));
  }

  // Public entry. Accepts a bare rows array, or { rows, unit, title, rowH }.
  function diverging(host, rows) {
    return attach(host, drawDiverging, rows);
  }

  /* =========================================================================
   * 9. EXPORT
   * ====================================================================== */

  NS.svg = {
    VERSION: "2.1.0",

    // components
    waterfall: waterfall,
    bullet: bullet,
    sparkline: sparkline,
    diverging: diverging,

    // shared maths — exported so adapters share ONE scale instead of two
    niceStep: niceStep,
    ticksFor: ticksFor,
    axisFor: axisFor,
    axisForDomain: axisForDomain,
    p95: p95,
    p95Domain: p95Domain,
    waterfallDomain: waterfallDomain,
    foldImmaterial: foldImmaterial,
    normBadges: normBadges,

    // lifecycle
    destroy: destroyHost,
    destroyAll: destroyAll,

    // geometry constants, read-only for tests
    GUTTER: GUTTER,
    PAD_FRAC: PAD_FRAC,
    MOBILE_W: MOBILE_W
  };

})();
