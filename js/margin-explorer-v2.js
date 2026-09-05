/* Native HQ page. Reuses the approved V2 controller with isolated DOM IDs. */
(function () {
  var pending, controller;
  window.loadMarginExplorerV2 = function () {
    var root = document.getElementById('pg-margin-explorer-v2');
    if (pending) return pending;
    if (root.dataset.mounted === 'true') return controller.refresh();
    root.textContent = 'Loading Margin Explorer V2…';
    pending = fetch('margin-explorer-v2-content.html').then(function (response) {
      if (!response.ok) throw new Error('Page template unavailable');
      return response.text();
    }).then(function (html) {
      root.innerHTML = html;
      controller = mountMarginExplorerV2(root, 'mv2-');
      root.dataset.mounted = 'true';
    }).catch(function () {
      root.textContent = 'Margin Explorer V2 could not load. Select this page again to retry.';
    }).finally(function () { pending = null; });
    return pending;
  };
})();
