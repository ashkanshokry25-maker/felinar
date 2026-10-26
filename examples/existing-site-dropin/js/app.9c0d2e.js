/* existing-site fixture, version 1: the page script. A classic script with root-relative URLs, a
   History-API router for app.html, fetch('/data.json') and a lazily loaded chunk. Everything the
   end-to-end test asserts is mirrored on window.__fixture. The file name carries a content hash. */
(function () {
  'use strict';
  var page = document.body.getAttribute('data-page') || 'unknown';
  var state = window.__fixture = { page: page, jsRan: true, pathname: location.pathname, data: null, route: null, routeId: null, chunk: null, errors: [] };
  document.documentElement.setAttribute('data-js', 'on');

  function text(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function fail(what, err) {
    state.errors.push(what + ': ' + (err && err.message ? err.message : String(err)));
  }

  text('path', location.pathname);

  fetch('/data.json').then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function (data) {
    state.data = data;
    text('data', 'data.json says: ' + data.message + ' (version ' + data.version + ')');
  }).catch(function (err) { fail('data.json', err); });

  // The lazy chunk: a script the page loads on demand, below the fold in spirit.
  var chunkButton = document.getElementById('load-chunk');
  if (chunkButton) {
    chunkButton.addEventListener('click', function () {
      var script = document.createElement('script');
      script.src = chunkButton.getAttribute('data-src');
      script.onload = function () {
        state.chunk = window.__chunk || null;
        text('chunk', 'chunk loaded: ' + (window.__chunk || '?'));
      };
      script.onerror = function () { fail('chunk', new Error('failed to load ' + script.src)); };
      document.head.appendChild(script);
    });
  }

  // History-API router for app.html. The host answers /app/* with app.html (see _redirects), so every
  // route below also works as a first request and after a reload.
  if (page === 'app') {
    var match = function (pathname) {
      if (pathname === '/app.html' || pathname === '/app' || pathname === '/app/') return { name: 'home', label: 'App home' };
      if (pathname === '/app/settings') return { name: 'settings', label: 'Settings' };
      var m = /^\/app\/items\/(\d+)$/.exec(pathname);
      if (m) return { name: 'item', id: Number(m[1]), label: 'Item ' + m[1] };
      return { name: 'not-found', label: 'No such route' };
    };
    var render = function () {
      var r = match(location.pathname);
      state.route = r.name;
      state.routeId = r.id === undefined ? null : r.id;
      state.pathname = location.pathname;
      text('view', r.label);
      text('path', location.pathname);
      document.title = 'Existing Site: app, ' + r.label;
    };
    document.addEventListener('click', function (e) {
      var link = e.target && e.target.closest ? e.target.closest('a[data-route]') : null;
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      history.pushState({}, '', link.getAttribute('href'));
      render();
    });
    window.addEventListener('popstate', render);
    render();
  }
}());
