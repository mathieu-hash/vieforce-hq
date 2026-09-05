/* Match the HQ theme preference before the preview paints. */
(function () {
  function apply(value) {
    document.documentElement.setAttribute('data-theme', value === 'light' ? 'light' : 'dark');
    document.documentElement.style.colorScheme = value === 'light' ? 'light' : 'dark';
    var button = document.getElementById('preview-theme');
    if (button) { button.textContent = value === 'light' ? 'Dark mode' : 'Light mode'; button.setAttribute('aria-label', 'Switch to ' + button.textContent.toLowerCase()); }
  }
  var saved; try { saved = localStorage.getItem('vf_theme'); } catch (_) {}
  apply(saved);
  document.addEventListener('DOMContentLoaded', function () {
    apply(document.documentElement.getAttribute('data-theme'));
    document.getElementById('preview-theme').addEventListener('click', function () {
      var theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      try { localStorage.setItem('vf_theme', theme); } catch (_) {}
      apply(theme);
    });
  });
  window.addEventListener('storage', function (event) { if (event.key === 'vf_theme') apply(event.newValue); });
})();
