// w2a-08 lab shell: same-URL iframe shell (ARCHITECTURE 3.1 / 7.2) with configurable mirroring strategy.
(function () {
  const cfg = window.__cfg
  const W = window.__mw = { cfg, log: [], loads: 0, mirrors: 0, ready: false, errors: [], frame: null }
  const t0 = performance.now()
  const log = (type, data) => W.log.push(Object.assign({ t: Math.round(performance.now() - t0), type }, data || {}))
  window.addEventListener('error', (e) => W.errors.push(String(e.message)))
  window.addEventListener('pageshow', (e) => log('top-pageshow', { persisted: e.persisted }))
  window.addEventListener('pagehide', (e) => log('top-pagehide', { persisted: e.persisted }))
  window.addEventListener('popstate', () => log('top-popstate', { url: location.pathname + location.search + location.hash }))
  window.addEventListener('hashchange', () => log('top-hashchange'))

  async function boot () {
    if (!('serviceWorker' in navigator)) { log('no-sw'); return mount() }
    try {
      await navigator.serviceWorker.register('/mw-sw.js', { scope: '/' })
      await navigator.serviceWorker.ready
    } catch (err) { log('sw-error', { err: String(err) }) }
    mount()
  }

  function readFramePath () {
    try { const l = W.frame.contentWindow.location; return l.pathname + l.search + l.hash } catch (_) { return null }
  }

  function mirror (reason) {
    if (cfg.mirror === 'none') return
    const p = readFramePath()
    if (p === null) { log('mirror-unreadable', { reason }); return }
    const now = location.pathname + location.search + location.hash
    if (p !== now) {
      try { history.replaceState(history.state, '', p); W.mirrors++; log('mirror', { reason, to: p }) } catch (err) { log('mirror-error', { reason, err: String(err) }) }
    }
    try { const t = W.frame.contentDocument.title; if (t) document.title = t } catch (_) {}
  }

  function attach () {
    const w = W.frame.contentWindow
    if (cfg.mirror === 'patch') {
      try {
        const h = w.history
        const push = h.pushState; const rep = h.replaceState
        h.pushState = function () { const r = push.apply(this, arguments); log('patched-pushState'); mirror('pushState'); return r }
        h.replaceState = function () { const r = rep.apply(this, arguments); log('patched-replaceState'); mirror('replaceState'); return r }
        w.addEventListener('popstate', () => { log('frame-popstate', { path: readFramePath() }); mirror('popstate') })
        w.addEventListener('hashchange', () => { log('frame-hashchange', { path: readFramePath() }); mirror('hashchange') })
      } catch (err) { log('attach-error', { err: String(err) }) }
    }
    if (cfg.guard === 'navapi' && w.navigation) {
      w.navigation.addEventListener('navigate', (e) => {
        let dest = null; try { dest = new URL(e.destination.url) } catch (_) {}
        const external = dest && dest.origin !== location.origin
        log('frame-navigate', { url: e.destination.url.replace(/^http:\/\/127.0.0.1:\d+/, ''), navType: e.navigationType, canIntercept: e.canIntercept, cancelable: e.cancelable, userInitiated: e.userInitiated, sameDoc: e.destination.sameDocument, download: e.downloadRequest, form: !!e.formData, external })
        if (external && e.cancelable && cfg.guardCancel) { e.preventDefault(); log('blocked-external', { url: e.destination.url }) }
      })
    }
    if (cfg.mirror === 'full') {
      try {
        w.addEventListener('pageshow', (e) => { log('frame-pageshow', { persisted: e.persisted, path: readFramePath() }); mirror('pageshow') })
        w.addEventListener('popstate', () => { log('frame-popstate', { path: readFramePath() }); mirror('popstate') })
        w.addEventListener('hashchange', () => { log('frame-hashchange', { path: readFramePath() }); mirror('hashchange') })
        if (w.navigation) w.navigation.addEventListener('currententrychange', (e) => { log('frame-currententrychange', { navType: e.navigationType, path: readFramePath() }); mirror('currententrychange') })
      } catch (err) { log('attach-error', { err: String(err) }) }
    }
  }

  function startAutoHeight () {
    W.resizes = 0
    try {
      const d = W.frame.contentDocument
      const apply = () => { const h = d.documentElement.scrollHeight; if (h !== parseInt(W.frame.style.height, 10)) { W.frame.style.height = h + 'px'; W.resizes++ } }
      apply()
      new ResizeObserver(apply).observe(d.documentElement)
    } catch (err) { log('autoheight-error', { err: String(err) }) }
  }
  function scrollKey () { return 'mw-scroll:' + location.pathname + location.search }
  function startSaveScroll () {
    try { const w = W.frame.contentWindow; w.addEventListener('scroll', () => { try { sessionStorage.setItem(scrollKey(), String(w.scrollY)) } catch (_) {} }, { passive: true }) } catch (_) {}
  }
  function restoreScroll () {
    try { const y = parseInt(sessionStorage.getItem(scrollKey()) || '0', 10); if (y > 0) { W.frame.contentWindow.scrollTo(0, y); log('restored-scroll', { y }) } } catch (_) {}
  }

  function mount () {
    const iframe = document.createElement('iframe')
    W.frame = iframe
    iframe.setAttribute('title', cfg.frameTitle)
    if (cfg.sandbox !== null) iframe.setAttribute('sandbox', cfg.sandbox)
    if (cfg.allow) iframe.setAttribute('allow', cfg.allow)
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    iframe.setAttribute('style', cfg.frameStyle)
    iframe.addEventListener('load', () => {
      W.loads++
      log('frame-load', { path: readFramePath(), n: W.loads })
      mirror('load')
      attach()
      if (cfg.autoheight) startAutoHeight()
      if (cfg.restoreScroll) restoreScroll()
      if (cfg.saveScroll) startSaveScroll()
      if (cfg.focusOnLoad) { try { iframe.contentWindow.focus() } catch (_) {} }
    })
    let hashToPass = ''
    if (cfg.passHash) {
      hashToPass = location.hash
      if (cfg.tfFromNav) { try { const n = performance.getEntriesByType('navigation')[0].name; const i = n.indexOf('#'); log('nav-entry-name', { hash: i >= 0 ? n.slice(i) : '' }); if (i >= 0) hashToPass = n.slice(i) } catch (_) {} }
    }
    log('location-hash-seen-by-shell', { hash: location.hash, fragmentDirectiveKeys: (typeof document.fragmentDirective === 'object') ? Object.keys(document.fragmentDirective).length : 'n/a' })
    iframe.src = location.pathname + location.search + hashToPass
    document.body.appendChild(iframe)
    W.ready = true
    log('mounted', { src: iframe.getAttribute('src'), historyLength: history.length })
  }
  boot()
})()
