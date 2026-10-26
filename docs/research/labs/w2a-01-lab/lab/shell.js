(async () => {
  const MODE = '__MODE__';
  const BTIH = 'a'.repeat(40);
  const PREFIX = '/_mw/s/' + BTIH + '/';
  window.__events = [];
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready; } catch (e) { window.__events.push({ swErr: String(e) }); return; }
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation');
  const top = location.pathname + location.search + location.hash;
  f.src = MODE === 'true' ? top : PREFIX + (location.pathname === '/' ? 'index.html' : location.pathname.slice(1)) + location.search + location.hash;
  window.__iframe = f;
  addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'checks') window.__checks = ev.data.results; });
  f.addEventListener('load', () => {
    try {
      const l = f.contentWindow.location; let p = l.pathname;
      window.__events.push({ load: p });
      if (p.startsWith(PREFIX)) p = '/' + p.slice(PREFIX.length);
      if (p === '/index.html') p = '/';
      const want = p + l.search + l.hash;
      if (want !== location.pathname + location.search + location.hash) history.replaceState(null, '', want); // render.js mirror
    } catch (e) { window.__events.push({ load: 'ERR ' + e.name }); }
  });
  document.body.appendChild(f);
})();
