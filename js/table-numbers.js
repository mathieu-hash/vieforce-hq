/**
 * VieForce HQ — Auto Table Numbering (review aid)
 *
 * Stamps every <table> on the page with a small "Table #N" pill so EVP can
 * leave numbered comments during review. Numbers are assigned monotonically
 * in DOM order at first encounter and never reused — once a table has a
 * number it keeps it for the page lifetime.
 *
 * Disable per-page by setting `window.HQ_TABLE_NUMBERS = false` BEFORE this
 * script loads. Disable globally for a user by setting localStorage
 * `hq_table_numbers` = 'off'.
 *
 * Self-contained: no deps, no module system. Loads once, idempotent.
 */
(function () {
  if (window.__hqTnInstalled) return;
  window.__hqTnInstalled = true;

  if (window.HQ_TABLE_NUMBERS === false) return;
  try {
    if (localStorage.getItem('hq_table_numbers') === 'off') return;
  } catch (_e) { /* sandboxed storage — proceed */ }

  window.__hqTnCounter = window.__hqTnCounter || 0;

  function numberTable(t) {
    if (!t || t.nodeType !== 1 || t.tagName !== 'TABLE') return;
    if (t.hasAttribute('data-tn')) return;
    if (!t.parentNode) return;
    var n = ++window.__hqTnCounter;
    t.setAttribute('data-tn', String(n));
    var marker = document.createElement('div');
    marker.className = 'hq-tn-marker';
    marker.textContent = 'Table #' + n;
    marker.setAttribute('data-tn-marker', String(n));
    t.parentNode.insertBefore(marker, t);
  }

  function scanRoot(root) {
    if (!root || !root.querySelectorAll) return;
    var tables = root.querySelectorAll('table:not([data-tn])');
    for (var i = 0; i < tables.length; i++) numberTable(tables[i]);
  }

  function applyTableNumbers() {
    scanRoot(document.body || document.documentElement);
  }

  function start() {
    applyTableNumbers();
    if (typeof MutationObserver === 'function' && document.body) {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (!node || node.nodeType !== 1) continue;
            if (node.tagName === 'TABLE') numberTable(node);
            else if (node.querySelectorAll) scanRoot(node);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.applyTableNumbers = applyTableNumbers;
})();
