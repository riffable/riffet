// Each draft page stacks its frames for browsing; ?only=<name> shows a single frame for rendering.
(() => {
  const only = new URLSearchParams(location.search).get('only');
  if (!only) return;
  document.documentElement.classList.add('render');
  addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-frame]').forEach(f => { if (f.dataset.frame !== only) f.remove(); });
  });
})();
