/* The site's own Service Worker registration, as an existing site writes it. */
(function () {
  'use strict';
  var state = window.__ownSw = { registered: false, controlled: false, stats: null, error: null };
  if (!('serviceWorker' in navigator)) { state.error = 'no Service Worker support'; return; }
  function report() {
    state.controlled = Boolean(navigator.serviceWorker.controller);
    return fetch('/__own-sw/stats').then(function (r) { return r.json(); }).then(function (stats) {
      state.stats = stats;
      var el = document.getElementById('own-sw');
      if (el) el.textContent = 'The site worker answered: ' + JSON.stringify(stats);
    }).catch(function (err) { state.error = String(err && err.message ? err.message : err); });
  }
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function () {
    state.registered = true;
    return navigator.serviceWorker.ready;
  }).then(function () {
    if (navigator.serviceWorker.controller) return report();
    navigator.serviceWorker.addEventListener('controllerchange', report, { once: true });
    return null;
  }).catch(function (err) { state.error = String(err && err.message ? err.message : err); });
}());
