'use strict';

(() => {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['system', 'light', 'dark'].includes(value);
  let mode = 'system';
  try { const saved = localStorage.getItem('piq:theme'); if (valid(saved)) mode = saved; } catch { /* Private browser settings may disable storage. */ }
  function apply() {
    document.documentElement.dataset.theme = mode === 'system' ? (query.matches ? 'dark' : 'light') : mode;
    const select = document.getElementById('theme-mode');
    if (select) select.value = mode;
  }
  apply();
  query.addEventListener('change', () => { if (mode === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === 'piq:theme') { mode = valid(event.newValue) ? event.newValue : 'system'; apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-mode');
    if (!select) return;
    select.value = mode;
    select.addEventListener('change', () => {
      mode = valid(select.value) ? select.value : 'system';
      try { localStorage.setItem('piq:theme', mode); } catch { /* The current page still applies the chosen theme. */ }
      apply();
    });
  });
})();
