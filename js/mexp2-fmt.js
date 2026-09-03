/* ============================================================================
 * mexp2-fmt.js — Margin Explorer v2 · THE ONLY FORMATTER
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Every number -> string conversion in Margin Explorer v2, and every HTML
 *   escape. If a v2 file needs to put a number on screen it calls into
 *   MEXP2.fmt. No panel, chart, table, drawer or adapter may build its own
 *   toFixed / toLocaleString / '₱' + n string. One file formats; everything
 *   else composes.
 *
 *   It also owns the two SAFE derivations of a per-weight margin figure
 *   (gmPerKg / gmPerTon), because the unsafe derivation is the single most
 *   damaging numeric defect carried by v1 — see THE MULTIPLY RULE below.
 *
 * WHAT THIS FILE MUST NEVER DO
 *   - Never let NaN, Infinity, -Infinity, "undefined" or "null" reach a caller.
 *     Every entry point funnels through toNum() first; an unusable input
 *     becomes the em dash C.NUM.NULL_TEXT, never a broken glyph string.
 *   - Never read or write the DOM. esc() is pure string work on purpose, so
 *     this file is safe to load before document.body exists and safe to call
 *     from a worker or a test harness.
 *   - Never fetch, never touch localStorage, never hold mutable state.
 *   - Never reference or patch anything named margin-explorer*.js. v1 is
 *     untouched. The one place v1 semantics are reproduced is
 *     phpAbbrShellCompat(), which is a deliberate, commented replica.
 *   - Never define the global CSS tokens --border / --surface2. (No CSS here
 *     at all, but the prohibition is restated so the rule travels with the
 *     file.)
 *   - Never call console.*.
 *
 * THE MULTIPLY RULE — encoded here, enforced by everything importing it
 *   NEVER derive a PHP/ton figure by multiplying a 2-decimal PHP/kg field by
 *   1000. v1 does exactly that at js/margin-explorer-matrix.js:42, where the
 *   "ton" unit is configured as { field: 'gm_per_kg', scale: 1000 }.
 *
 *   Why it is wrong: gm_per_kg arrives already rounded (and is displayed to two
 *   decimals). The rounding error carried in that field is up to ±0.005 PHP/kg.
 *   Multiplying by 1000 does not scale the value and leave the error behind —
 *   it scales BOTH, turning a ±0.005 error into a ±5.00 PHP/ton error. On a
 *   ~5,000 PHP/ton anchor that is 0.1% — and it is added to a closure check
 *   whose whole bound is C.TOLERANCE_FLOOR_PHP_T = 3 PHP/ton of ROUNDING
 *   DRIFT (four round()ed bars + two round()ed anchors, C13). A bridge that is
 *   exact by construction can then sprout a spurious "Unexplained" bar purely
 *   because of the display rounding of a field it never should have read.
 *
 *   The correct derivation is always from the raw extensive quantities:
 *       gm_per_ton = gp / (kg / 1000)   ==  (gp / kg) * 1000
 *   computed in one pass from unrounded gp and unrounded kg. That is what
 *   gmPerTon() does. Use it. Never scale a display field.
 *
 * SHELL PARITY
 *   phpAbbrShellCompat() is a byte-for-byte replica of the shell's fc()
 *   (app.html:3946) INCLUDING its rounding boundary defect. See the comment on
 *   that function. It exists only so a figure that also appears on Home /
 *   Sales / Budget cannot disagree with itself while v1 and v2 are on screen
 *   side by side. Every figure unique to v2 uses php() instead.
 * ========================================================================= */

(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});

  // The contract may or may not have loaded first. Read its numeric-safety
  // strings when present, fall back to the same literals when not, so this
  // file is independently testable (fmt-test.html loads it alone).
  var C = NS.C || null;
  var NULL_TEXT = (C && C.NUM && C.NUM.NULL_TEXT) || "—"; // em dash
  var PESO = (C && C.NUM && C.NUM.PESO) || "₱";

  var MINUS = "−"; // U+2212 MINUS SIGN — typographic, used by signed()
  var LOCALE = "en-US"; // matches the shell; grouping is comma, decimal is dot

  /* -------------------------------------------------------------------------
   * CORE GUARD
   * ---------------------------------------------------------------------- */

  // The single numeric gate for the whole of v2. Implements C.NUM.RULE exactly:
  // null / undefined / "" are absent; anything that is not a finite number is
  // absent; everything else is a usable number. Nothing else in v2 is allowed
  // to decide whether a value is usable.
  function toNum(v) {
    if (v == null || v === "") return null;
    var n = +v;
    if (n !== n) return null;                       // NaN
    if (n === Infinity || n === -Infinity) return null;
    return n;
  }

  // Grouped fixed-decimal rendering of an already-validated finite number.
  // Private: callers go through the public formatters so the guard is never
  // skipped. Uses the absolute value; sign is applied by the caller so the
  // minus lands before the currency symbol rather than after it.
  function groupAbs(n, minDp, maxDp) {
    var a = Math.abs(n);
    var s;
    try {
      s = a.toLocaleString(LOCALE, {
        minimumFractionDigits: minDp,
        maximumFractionDigits: maxDp
      });
    } catch (e) {
      // Defensive: a locale-less environment must still produce digits, never
      // "undefined". toFixed then hand-grouped.
      s = groupPlain(a.toFixed(maxDp));
    }
    return s;
  }

  // Fallback thousands separator for the no-Intl path. Groups the integer part
  // of an already-stringified positive decimal.
  function groupPlain(s) {
    var parts = String(s).split(".");
    var head = parts[0];
    var out = "";
    var i, c;
    for (i = 0; i < head.length; i++) {
      c = head.length - i;
      out += head.charAt(i);
      if (c > 1 && c % 3 === 1) out += ",";
    }
    return parts.length > 1 ? out + "." + parts[1] : out;
  }

  // True when a validated number is negative. Treats -0 as non-negative so a
  // rounded-to-zero figure never prints as "-₱0.00".
  function isNeg(n) {
    return n < 0;
  }

  /* -------------------------------------------------------------------------
   * MONEY
   * ---------------------------------------------------------------------- */

  // Full-precision pesos, two decimals, grouped: "₱1,234,567.89".
  // Use this for any column a reader will add up and check against a stated
  // total — abbreviation makes a column that does not foot, and a column that
  // does not foot destroys trust in the whole page. The minus sign is placed
  // OUTSIDE the peso symbol ("-₱1,234.57"), which reads correctly; note that
  // v1's fmtMoney2 emits "₱-1,234.57" instead. That difference is cosmetic and
  // deliberate; any figure that must match v1 glyph-for-glyph uses
  // phpAbbrShellCompat() instead.
  function php(n) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    return (isNeg(v) ? "-" : "") + PESO + groupAbs(v, 2, 2);
  }

  // BYTE-FOR-BYTE replica of the shell's fc() at app.html:3946:
  //   function fc(n){if(n==null||isNaN(n))return'₱0';n=+n;
  //     if(Math.abs(n)>=1e6)return'₱'+(n/1e6).toFixed(1)+'M';
  //     if(Math.abs(n)>=1e3)return'₱'+(n/1e3).toFixed(0)+'K';
  //     return'₱'+n.toFixed(0)}
  //
  // USE ONLY where the same figure is also rendered by the v1 shell on Home,
  // Sales or Budget. During the side-by-side period v2 must never disagree
  // with another page about a shared number, even by a rounding step. For
  // every figure unique to v2, use php() or perTon()/perKg().
  //
  // ---- KNOWN SHELL DEFECT, DELIBERATELY MIRRORED -------------------------
  // The 1e3 branch rounds to ZERO decimals, so any value in [999500, 1000000)
  // renders as "₱1000K" instead of rolling over to "₱1.0M". 999500 -> 999.5
  // -> toFixed(0) -> "1000" -> "₱1000K". The band is only 500 pesos wide but
  // it is exactly the band a rounded-up million lands in, so it does show up
  // in the wild on monthly GP tiles.
  // Two further inherited behaviours are also reproduced on purpose:
  //   - the peso sign precedes the minus: fc(-1234.567) === "₱-1K";
  //   - a null/NaN input returns "₱0", NOT an em dash, so an absent value is
  //     indistinguishable from a real zero. That is precisely the confusion
  //     C.STATE.EMPTY_SCOPE exists to prevent, which is why this function is
  //     quarantined to parity use and php() is the default everywhere else.
  // FIXING ANY OF THIS IS A SEPARATE APP-WIDE TICKET. It must be changed in
  // app.html's fc() and here in the same release, or the two pages will
  // disagree — which is the one outcome this function exists to prevent. Do
  // not "improve" it locally.
  function phpAbbrShellCompat(n) {
    if (n == null || isNaN(n)) return "₱0";
    n = +n;
    // Guard the shell cannot: isNaN(Infinity) is false, so the original would
    // emit "₱InfinityM". Returning the shell's own absent-value string keeps
    // us byte-compatible on every input the shell can actually produce while
    // refusing to put a broken glyph in the DOM.
    if (n === Infinity || n === -Infinity) return "₱0";
    if (Math.abs(n) >= 1e6) return "₱" + (n / 1e6).toFixed(1) + "M";
    if (Math.abs(n) >= 1e3) return "₱" + (n / 1e3).toFixed(0) + "K";
    return "₱" + n.toFixed(0);
  }

  // Pesos per ton, zero decimals: "₱5,248". A per-ton figure is a ~4-digit
  // number; decimals on it are noise well below C.MATERIALITY_PHP_T (25/ton).
  function perTon(n) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    return (isNeg(v) ? "-" : "") + PESO + groupAbs(v, 0, 0);
  }

  // Pesos per kilo, two decimals: "₱5.25". Two decimals is the resolution the
  // source field carries; do not print more, and never multiply this up to a
  // per-ton figure (see THE MULTIPLY RULE — use gmPerTon()).
  function perKg(n) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    return (isNeg(v) ? "-" : "") + PESO + groupAbs(v, 2, 2);
  }

  /* -------------------------------------------------------------------------
   * DELTAS, PERCENTAGES, WEIGHT
   * ---------------------------------------------------------------------- */

  // A signed delta with an EXPLICIT sign on both directions: "+182", "−96".
  // Uses U+2212 MINUS SIGN, not the ASCII hyphen — at the small type sizes the
  // waterfall labels use, a hyphen is visually indistinguishable from the
  // en-dash separators around it, and a misread sign on a bridge step is a
  // wrong commercial call. The explicit "+" matters just as much: a bare "182"
  // next to a "−96" invites the reader to scan the column as magnitudes.
  //
  // dp is optional (default 0) so the same function serves per-ton steps (0dp)
  // and per-kg steps (2dp) without any caller rolling its own sign logic.
  // Exact zero prints as "0" with no sign — it is neither a gain nor a loss.
  function signed(n, dp) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    var d = toNum(dp);
    if (d === null || d < 0 || d > 6) d = 0;
    d = Math.floor(d);
    var body = groupAbs(v, d, d);
    // Re-test the sign AFTER rounding: -0.004 at 2dp is "0.00" and must not
    // be shown as "−0.00".
    if (Math.abs(v) < Math.pow(10, -d) / 2) return body;
    return (isNeg(v) ? MINUS : "+") + body;
  }

  // Percentage to one decimal: "12.3%". The input is already a percentage
  // (12.3), NOT a fraction (0.123) — every percentage field on this endpoint
  // arrives pre-multiplied, and re-scaling here would silently divide the
  // whole page by 100.
  function pct(n) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    return (isNeg(v) ? "-" : "") + groupAbs(v, 1, 1) + "%";
  }

  // A signed percentage-point delta: "+1.4 pp", "−0.6 pp". Kept beside pct()
  // so no caller concatenates its own " pp" suffix.
  function pp(n) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    return signed(v, 1) + " pp";
  }

  // Metric tonnage, labelled "MT" — the shell's vocabulary throughout
  // (app.html:1108 unit toggle, 1256 "Volume (MT)", 1315 "14,200 MT"). Do NOT
  // print "tons" or "t": two words for one unit on one screen reads as two
  // different measurements. One decimal maximum, none when the value is whole,
  // so 14200 -> "14,200 MT" and a 0.4 MT sample order stays visible as
  // "0.4 MT" rather than collapsing to "0 MT".
  function mt(n) {
    var v = toNum(n);
    if (v === null) return NULL_TEXT;
    return (isNeg(v) ? "-" : "") + groupAbs(v, 0, 1) + " MT";
  }

  /* -------------------------------------------------------------------------
   * SAFE DERIVATIONS — the enforcement half of THE MULTIPLY RULE
   * ---------------------------------------------------------------------- */

  // Divide with every failure mode collapsed to null. A zero, absent or
  // non-finite denominator yields null (which every formatter above renders as
  // an em dash). This NEVER returns NaN and NEVER returns Infinity — those are
  // the two values that, left alone, end up in the DOM as "NaN" or "Infinity"
  // beside a peso sign.
  function ratio(num, den) {
    var a = toNum(num);
    var b = toNum(den);
    if (a === null || b === null) return null;
    if (b === 0) return null;
    var r = a / b;
    if (r !== r) return null;
    if (r === Infinity || r === -Infinity) return null;
    return r;
  }

  // GM per kilo from RAW gross profit and RAW kilos. Returns a number or null.
  // Prefer this over any gm_per_kg field the endpoint hands back when the raw
  // components are available, and never the other way around.
  function gmPerKg(gp, kg) {
    return ratio(gp, kg);
  }

  // GM per ton from RAW gross profit and RAW kilos, in ONE division:
  //   gp / (kg / 1000). Computed as ratio(gp * 1000, kg) so the intermediate
  // per-kg value — and its rounding — never exists.
  //
  // THIS IS THE REPLACEMENT FOR v1's margin-explorer-matrix.js:42
  //   ton: { field: 'gm_per_kg', scale: 1000 }
  // which multiplies a two-decimal display field by 1000 and amplifies its
  // ±0.005/kg rounding into ±5.00/ton. See the file docblock. If you find
  // yourself writing `* 1000` anywhere in v2, you want this function instead.
  function gmPerTon(gp, kg) {
    var a = toNum(gp);
    if (a === null) return null;
    return ratio(a * 1000, kg);
  }

  /* -------------------------------------------------------------------------
   * TEXT
   * ---------------------------------------------------------------------- */

  // HTML-escape a value for interpolation into innerHTML.
  //
  // Written as `s == null ? "" : ...` on purpose. The shell's esc()
  // (app.html:3950) opens with `if(!s) return ''`, which is falsy-testing, so a
  // legitimate dimension value of 0 — a numeric SKU code, an "0" sales group, a
  // customer id of 0 — is silently blanked and the row loses its identity. Here
  // only null and undefined blank; 0, false and "" pass through as their string
  // form ("0", "false", "").
  //
  // Pure string work, no document, so this is callable before the DOM exists.
  // Escapes the five characters that can break out of either an element body or
  // a quoted attribute value.
  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* -------------------------------------------------------------------------
   * DISPATCH
   * ---------------------------------------------------------------------- */

  // Format a value in whichever display unit the scope is currently on. The one
  // place the C.UNITS vocabulary maps to a formatter, so no panel writes its own
  // switch. Unknown units fall back to php() rather than throwing.
  function byUnit(n, unit) {
    if (unit === "ton") return perTon(n);
    if (unit === "kg") return perKg(n);
    if (unit === "gp_pct") return pct(n);
    if (unit === "gp") return php(n);
    return php(n);
  }

  /* -------------------------------------------------------------------------
   * EXPORT
   * ---------------------------------------------------------------------- */

  NS.fmt = {
    // guards + derivations (return numbers or null, never strings)
    toNum: toNum,
    ratio: ratio,
    gmPerKg: gmPerKg,
    gmPerTon: gmPerTon,
    // money
    php: php,
    phpAbbrShellCompat: phpAbbrShellCompat,
    perTon: perTon,
    perKg: perKg,
    // deltas / percentages / weight
    signed: signed,
    pct: pct,
    pp: pp,
    mt: mt,
    // text + dispatch
    esc: esc,
    byUnit: byUnit,
    // constants, exported so callers compare against the same literals
    NULL_TEXT: NULL_TEXT,
    PESO: PESO,
    MINUS: MINUS
  };

})();
