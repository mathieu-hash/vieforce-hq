/* ============================================================================
 * mexp2-url.js — Margin Explorer v2 · HASH SERIALISATION OF SCOPE (MEXP2.url)
 * ----------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The one mapping between a v2 scope and the location hash, in the shell's
 *   own convention (app.html:8812-8834 uses "#pg-inv?region=..."):
 *       #pg-mexp2?period=QTD&region=Visayas&bu=ALL&group_by=bu&unit=kg
 *                 &compare=pp&customer=...&ref_month=2026-05
 *                 &drill=dim:value:label,dim:value:label
 *   Only fields that differ from C.DEFAULT_SCOPE are written, so the default
 *   scope is a bare "#pg-mexp2".
 *
 * RULES
 *   - history.replaceState ONLY. Never pushState: a filter click must not
 *     add a Back-button stop. Never a popstate/hashchange listener: the shell
 *     owns navigation; v2 reads the hash ONCE, on first mount (controller).
 *   - Never touch a hash that is not ours. "#pg-inv?..." belongs to the
 *     inventory page; "#access_token=..." belongs to auth.js. write() leaves
 *     both alone and read() returns null for both.
 *   - No DOM, no fetch, no state, no console. Attaches to window.MEXP2 only.
 * ========================================================================= */
(function () {
  "use strict";

  var NS = (window.MEXP2 = window.MEXP2 || {});
  var C = NS.C;
  if (!C) throw new Error("mexp2-url: mexp2-contract.js must load before this file.");

  var PREFIX = "#pg-mexp2";
  // scope field -> hash param name. Server names where the server has one.
  var MAP = [
    ["period", "period"], ["refMonth", "ref_month"], ["region", "region"], ["bu", "bu"],
    ["customer", "customer"], ["groupBy", "group_by"], ["compare", "compare"], ["unit", "unit"]
  ];

  function enc(v) { return encodeURIComponent(String(v)); }
  function dec(v) { try { return decodeURIComponent(String(v).replace(/\+/g, " ")); } catch (e) { return null; } }
  function ours(hash) { return hash === PREFIX || hash.indexOf(PREFIX + "?") === 0 || hash.indexOf(PREFIX + "&") === 0; }
  function currentHash() { try { return String(window.location.hash || ""); } catch (e) { return ""; } }

  // scope -> "#pg-mexp2?..." (only non-default fields).
  function serialise(scope) {
    var s = scope || {}, parts = [], i, f, v, d, crumbs = [];
    for (i = 0; i < MAP.length; i++) {
      f = MAP[i][0];
      v = s[f];
      if (v === undefined || v === null || v === "") continue;
      if (String(v) === String(C.DEFAULT_SCOPE[f])) continue;
      parts.push(MAP[i][1] + "=" + enc(v));
    }
    d = (s.drill && typeof s.drill.length === "number") ? s.drill : [];
    for (i = 0; i < d.length; i++) {
      if (!d[i] || d[i].dim == null) continue;
      crumbs.push(enc(d[i].dim) + ":" + enc(d[i].value == null ? "" : d[i].value) + ":" + enc(d[i].label == null ? "" : d[i].label));
    }
    if (crumbs.length) parts.push("drill=" + crumbs.join(","));
    return parts.length ? PREFIX + "?" + parts.join("&") : PREFIX;
  }

  // "#pg-mexp2?..." -> partial scope PATCH (only the fields present), or null
  // when the hash is not ours. Values are NOT validated here: the store's
  // SCOPE reducer ignores and logs illegal values, and that is the one place
  // validation lives.
  function parse(hash) {
    var h = (hash === undefined) ? currentHash() : String(hash || "");
    if (!ours(h)) return null;
    var q = h.indexOf("?") >= 0 ? h.slice(h.indexOf("?") + 1) : "";
    var out = {}, pairs, i, kv, k, v, j, f, crumbs, c, drill;
    if (!q) return out;
    pairs = q.split("&");
    for (i = 0; i < pairs.length; i++) {
      kv = pairs[i].split("=");
      if (kv.length < 2) continue;
      k = kv[0];
      v = dec(kv.slice(1).join("="));
      if (v === null) continue;
      if (k === "drill") {
        crumbs = v.split(",");
        drill = [];
        for (j = 0; j < crumbs.length; j++) {
          c = crumbs[j].split(":");
          if (c.length < 2 || !c[0]) continue;
          drill.push({ dim: dec(c[0]), value: dec(c[1]), label: c.length > 2 ? dec(c[2]) : dec(c[1]) });
        }
        out.drill = drill;
        continue;
      }
      for (j = 0; j < MAP.length; j++) {
        f = MAP[j];
        if (f[1] === k) { out[f[0]] = v; break; }
      }
    }
    return out;
  }

  // Deep-link read: the patch from the current hash, or null.
  function read() { return parse(); }

  // Write the scope to the hash via replaceState. Returns true when written.
  // Refuses when the current hash belongs to someone else, or when nothing
  // would change (no churn in the history entry).
  function write(scope) {
    var h = currentHash(), next;
    if (h && !ours(h)) return false;
    next = serialise(scope);
    if (next === h) return true;
    try {
      if (window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState(window.history.state, document.title, next);
        return true;
      }
    } catch (e) {}
    return false;
  }

  NS.url = { VERSION: C.VERSION, PREFIX: PREFIX, serialise: serialise, serialize: serialise, parse: parse, read: read, write: write, isOurs: function (h) { return ours(h === undefined ? currentHash() : String(h || "")); } };
})();
