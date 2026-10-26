// src/loader/render.js: Service Worker registration (§5.2), the same-URL site iframe with history
// mirroring and frame guards (§7.2, DESIGN-REVIEW items 7, 8, 17, 20), the no-SW degraded renderer
// (§7.4) and the CSP builders (§13). Pure helpers are exported for Node tests; every DOM or browser
// global is reached through parameters or guarded lookups, never at import time.

const HUB_PREFIX = '/_mw/s/'
const BTIH_RE = /^[0-9a-f]{40}$/
const SW_RELOAD_KEY = 'mw:sw-reload'
/** Code review round 1: boot.js starts this tab session in limited mode (degraded CSP) when it is set. */
export const DEGRADED_RELOAD_KEY = 'mw:degraded'

/**
 * requestDegradedReload({ win, reason }) → true when the page is reloading into limited mode. The
 * loader decided on limited mode after boot.js fixed the normal CSP, which blocks what limited mode
 * needs (blob: scripts and styles, <base>), and a meta CSP cannot be relaxed: set the one-time flag and
 * reload once; boot.js then skips register() and inserts the degraded CSP. false when sessionStorage is
 * unusable or the flag is already set (no reload loop).
 */
export function requestDegradedReload ({ win = globalWin(), reason = '' } = {}) {
  let storage = null
  try { storage = win && win.sessionStorage } catch (_) { storage = null }
  if (!storage || !win || !win.location) return false
  if (readSession(storage, DEGRADED_RELOAD_KEY) !== null) return false
  if (!writeSession(storage, DEGRADED_RELOAD_KEY, reason || '1')) return false
  try { win.location.reload() } catch (_) { return false }
  return true
}

export const SANDBOX = Object.freeze({
  shell: 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation',
  'hub-shared': 'allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation'
})
export const FRAME_ALLOW = 'fullscreen; clipboard-write; picture-in-picture'

function globalNav () { return typeof navigator !== 'undefined' ? navigator : null }
function globalWin () { return typeof window !== 'undefined' ? window : null }
function errText (err) { return (err && err.message) || String(err) }

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

// Leading slashes and backslashes collapse to one so a crafted address such as
// https://site//evil.example/x can never become a protocol-relative iframe src.
export function normalizeFramePath (path) {
  const s = typeof path === 'string' ? path : '/'
  return '/' + s.replace(/^[/\\]+/, '')
}

/**
 * pathFromLocation(loc, { includeHash }) → the site path the iframe opens for a top-level URL:
 * pathname + search (+ hash when asked). Accepts a Location-like object or a URL string.
 */
export function pathFromLocation (loc, { includeHash = false } = {}) {
  let pathname = '/'
  let search = ''
  let hash = ''
  if (typeof loc === 'string') {
    try {
      const u = new URL(loc, 'https://x.invalid')
      pathname = u.pathname
      search = u.search
      hash = u.hash
    } catch (_) { pathname = '/' }
  } else if (loc) {
    pathname = typeof loc.pathname === 'string' ? loc.pathname : '/'
    search = typeof loc.search === 'string' ? loc.search : ''
    hash = typeof loc.hash === 'string' ? loc.hash : ''
  }
  return normalizeFramePath(pathname) + search + (includeHash ? hash : '')
}

/** '/_mw/s/<btih>/<path>' → { btih, path: '/<path>' } | null */
export function splitHubPath (pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(HUB_PREFIX)) return null
  const rest = pathname.slice(HUB_PREFIX.length)
  const slash = rest.indexOf('/')
  const btih = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
  if (!BTIH_RE.test(btih)) return null
  return { btih, path: slash === -1 ? '/' : normalizeFramePath(rest.slice(slash)) }
}

export function hubSiteUrl (btih, path) {
  return HUB_PREFIX + btih + normalizeFramePath(path || '/')
}

/**
 * topUrlFor(topLoc, mode, sitePath) → the address-bar URL (path + search + hash) that mirrors the
 * frame. Shell: the frame URL itself. Shared hub: '/?p=<site path>' plus the pointer fragment.
 */
export function topUrlFor (topLoc, mode, sitePath) {
  const site = typeof sitePath === 'string' ? sitePath : '/'
  if (mode !== 'hub-shared') return normalizeFramePath(site)
  let params
  try { params = new URLSearchParams((topLoc && topLoc.search) || '') } catch (_) { params = new URLSearchParams() }
  if (site === '/' || site === '') params.delete('p')
  else params.set('p', site)
  const q = params.toString()
  return '/' + (q ? '?' + q : '') + ((topLoc && topLoc.hash) || '')
}

/** Site path that a shared-hub top URL asks for ('?p=' parameter), default '/'. */
export function hubPathFromLocation (loc) {
  try {
    const p = new URLSearchParams((loc && loc.search) || '').get('p')
    return p ? normalizeFramePath(p) : '/'
  } catch (_) { return '/' }
}

/** The site path of the frame's current URL, or null when it is not a page of this site. */
export function frameSitePath (frameUrl, mode, btih) {
  let u
  try { u = new URL(String(frameUrl)) } catch (_) { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (mode === 'hub-shared') {
    const split = splitHubPath(u.pathname)
    if (!split || (btih && split.btih !== btih)) return null
    return split.path + u.search + u.hash
  }
  return normalizeFramePath(u.pathname) + u.search + u.hash
}

export function isCrossOrigin (url, origin) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return u.origin !== origin
  } catch (_) { return false }
}

/**
 * cspString(kind, { dev, lanHost }) → the policy boot.js inserts (ARCHITECTURE §13, §7.4).
 * kind 'normal' | 'degraded'. Degraded adds blob: to script/style/font/media/connect, 'unsafe-inline'
 * to script-src, data: fonts, and base-uri 'self' (the srcdoc document gets an injected <base>).
 * Code review round 1: degraded also allows https: (and, in development, http://127.0.0.1:* and
 * http://localhost:*) for scripts, styles, images, media, fonts and frames, so a site's third-party
 * subresources (CDN CSS and scripts, web fonts, embeds) load in limited mode as they do in SW mode,
 * where the site document is not under this policy at all.
 */
export function cspString (kind = 'normal', { dev = false, lanHost = null } = {}) {
  const degraded = kind === 'degraded'
  const connect = ["'self'", 'https:', 'wss:']
  if (degraded) connect.push('blob:')
  if (dev) {
    // v0.3 final integration: loopback web seeds on another origin (a subdomain hub's root, boot.js says why).
    connect.push('ws://127.0.0.1:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'http://localhost:*')
    if (lanHost) connect.push('wss://' + lanHost + ':*')
  }
  const remote = degraded ? ['https:'].concat(dev ? ['http://127.0.0.1:*', 'http://localhost:*'] : []) : []
  const list = [
    ['default-src', ["'self'"]],
    ['script-src', degraded ? ["'self'", "'unsafe-inline'", 'blob:'].concat(remote) : ["'self'"]],
    ['style-src', degraded ? ["'self'", "'unsafe-inline'", 'blob:'].concat(remote) : ["'self'", "'unsafe-inline'"]],
    ['connect-src', connect],
    ['img-src', ["'self'", 'blob:', 'data:'].concat(remote)],
    ['media-src', ["'self'", 'blob:'].concat(remote)]
  ]
  if (degraded) list.push(['font-src', ["'self'", 'blob:', 'data:'].concat(remote)])
  list.push(
    ['frame-src', ["'self'"].concat(remote)],
    ['worker-src', ["'self'", 'blob:']],
    ['object-src', ["'none'"]],
    ['base-uri', [degraded ? "'self'" : "'none'"]],
    ['form-action', ["'none'"]]
  )
  return list.map(([name, sources]) => name + ' ' + sources.join(' ')).join('; ')
}

/** insertCsp(mode, dev): adds the policy meta unless boot.js already did. Returns the policy. */
export function insertCsp (mode = 'normal', dev = false, { doc = (typeof document !== 'undefined' ? document : null), lanHost = null } = {}) {
  const policy = cspString(mode, { dev, lanHost })
  if (!doc || !doc.head) return policy
  if (doc.querySelector('meta[http-equiv="Content-Security-Policy"]')) return policy
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', policy)
  doc.head.insertBefore(meta, doc.head.firstChild)
  return policy
}

// ---- degraded-mode helpers (pure) ------------------------------------------------------------

function dirOf (sitePath) {
  const i = sitePath.lastIndexOf('/')
  return i === -1 ? '' : sitePath.slice(0, i + 1)
}

// Collapses '.', '..' and empty segments without escaping the root. Input and output carry no
// leading slash ('css/app.css').
export function cleanSitePath (path) {
  const out = []
  for (const seg of String(path || '').replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * resolveRef(basePath, ref) → site path (no leading slash) for a relative or path-absolute
 * reference, keeping a trailing slash; null for anything that leaves the site (scheme, '//', '#').
 */
export function resolveRef (basePath, ref) {
  if (typeof ref !== 'string') return null
  const r = ref.trim()
  if (!r || r.startsWith('#') || r.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null
  const clean = r.split(/[?#]/)[0]
  if (!clean) return null
  let decoded = clean
  try { decoded = decodeURIComponent(clean) } catch (_) { decoded = clean }
  const joined = decoded.startsWith('/') ? decoded : dirOf(basePath || '') + decoded
  const path = cleanSitePath(joined)
  return decoded.endsWith('/') ? (path ? path + '/' : '') : path
}

/**
 * resolveSitePath(routing, path, has) → { path, status, redirect } using the subset of the routing
 * manifest the degraded renderer can honour: redirects, cleanUrls, directory index, spa, notFound.
 * `has(p)` tells whether the torrent holds site path p (no leading slash).
 */
export function resolveSitePath (routing, path, has) {
  const r = routing && typeof routing === 'object' ? routing : {}
  const index = typeof r.index === 'string' && r.index ? r.index : 'index.html'
  const raw = typeof path === 'string' ? path : '/'
  const p = cleanSitePath(raw.split(/[?#]/)[0])
  const wantsDir = raw.split(/[?#]/)[0].endsWith('/') || p === ''
  if (Array.isArray(r.redirects)) {
    for (const rule of r.redirects) {
      if (!rule || typeof rule.from !== 'string' || typeof rule.to !== 'string') continue
      if (cleanSitePath(rule.from) === p) return { path: null, status: Number(rule.status) || 301, redirect: rule.to }
    }
  }
  const candidates = []
  if (wantsDir) candidates.push((p ? p + '/' : '') + index)
  else {
    candidates.push(p)
    if (r.cleanUrls !== false) candidates.push(p + '.html')
    candidates.push(p + '/' + index)
  }
  for (const c of candidates) if (has(c)) return { path: c, status: 200, redirect: null }
  if (r.spa && has(typeof r.spa === 'string' ? cleanSitePath(r.spa) : index)) {
    return { path: typeof r.spa === 'string' ? cleanSitePath(r.spa) : index, status: 200, redirect: null }
  }
  const notFound = typeof r.notFound === 'string' && r.notFound ? cleanSitePath(r.notFound) : '404.html'
  if (has(notFound)) return { path: notFound, status: 404, redirect: null }
  return { path: null, status: 404, redirect: null }
}

/** Rewrites url(...) and @import targets in CSS text through resolve(sitePath) → URL | null. */
export function rewriteCssText (css, basePath, resolve) {
  const swap = (whole, ref) => {
    const target = resolveRef(basePath, ref)
    if (target === null) return null
    const url = resolve(target)
    return url || null
  }
  let out = String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote, ref) => {
    const url = swap(whole, ref)
    return url ? 'url("' + url + '")' : whole
  })
  out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (whole, quote, ref) => {
    const url = swap(whole, ref)
    return url ? '@import url("' + url + '")' : whole
  })
  return out
}

export function rewriteSrcset (srcset, basePath, resolve) {
  return String(srcset).split(',').map((part) => {
    const trimmed = part.trim()
    if (!trimmed) return trimmed
    const sp = trimmed.search(/\s/)
    const ref = sp === -1 ? trimmed : trimmed.slice(0, sp)
    const desc = sp === -1 ? '' : trimmed.slice(sp)
    const target = resolveRef(basePath, ref)
    const url = target === null ? null : resolve(target)
    return (url || ref) + desc
  }).join(', ')
}

const STATIC_IMPORT_RE = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\}\s*)from\s*)(['"])([^'"\n]+)\2/g
const DYNAMIC_IMPORT_RE = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g

/**
 * Rewrites module specifiers (static import/export-from and import('literal')) through
 * map(specifier) → replacement | null. Regex based: good enough for the no-SW fallback.
 */
export function rewriteModuleSpecifiers (code, map) {
  return String(code)
    .replace(STATIC_IMPORT_RE, (whole, head, quote, spec) => {
      const next = map(spec)
      return next ? head + quote + next + quote : whole
    })
    .replace(DYNAMIC_IMPORT_RE, (whole, quote, spec) => {
      const next = map(spec)
      return next ? 'import(' + quote + next + quote + ')' : whole
    })
}

// ---------------------------------------------------------------------------------------------
// Service Worker
// ---------------------------------------------------------------------------------------------

function readSession (storage, key) {
  try { return storage ? storage.getItem(key) : null } catch (_) { return 'blocked' }
}
function writeSession (storage, key, value) {
  try { if (storage) storage.setItem(key, String(value)); return true } catch (_) { return false }
}
function clearSession (storage, key) {
  try { if (storage) storage.removeItem(key) } catch (_) { /* blocked storage */ }
}

function waitForController (sw, ms) {
  if (sw.controller) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sw.removeEventListener('controllerchange', onChange) } catch (_) { /* ignore */ }
      resolve(v)
    }
    const onChange = () => finish(!!sw.controller)
    sw.addEventListener('controllerchange', onChange)
    timer = setTimeout(() => finish(!!sw.controller), ms)
  })
}

/**
 * registerServiceWorker({ url, readyTimeoutMs, proto }) → { ok, controlled, degraded, reloaded, error }
 * Degrades only when the API is missing or register() rejects (or ready() exceeds the cap). In shell
 * mode an uncontrolled page reloads once (sessionStorage guard) so the site frame is controlled.
 * `existing` is boot.js's register() probe, reused instead of registering twice.
 */
export async function registerServiceWorker ({
  url = '/mw-sw.js', readyTimeoutMs = 15000, proto = 1, shell = true, existing = null,
  controllerWaitMs = 1500, onWaiting = null, nav = globalNav(), win = globalWin(),
  storage = (win && (() => { try { return win.sessionStorage } catch (_) { return null } })()) || null
} = {}) {
  const base = { ok: false, controlled: false, degraded: true, reloaded: false, error: null, proto }
  if (!nav || !('serviceWorker' in nav) || !nav.serviceWorker) return Object.assign(base, { error: 'no-service-worker' })
  const sw = nav.serviceWorker
  let registration = null
  try {
    // Bounded (code review round 1): a register() that never settles must not hold the page forever.
    let probeTimer = null
    const probe = existing
      ? await Promise.race([existing, new Promise((resolve) => { probeTimer = setTimeout(() => resolve({ ok: false, error: 'register() did not settle in ' + readyTimeoutMs + ' ms' }), readyTimeoutMs) })])
      : null
    clearTimeout(probeTimer)
    if (probe && probe.ok === false) throw new Error(probe.error || 'register() rejected')
    registration = (probe && probe.registration) || await sw.register(url, { scope: '/', updateViaCache: 'none' })
    // Browsers resolve with a registration; nothing means registration is blocked (see boot.js).
    if (!registration || typeof registration !== 'object') throw new Error('register() gave no registration')
  } catch (err) {
    return Object.assign(base, { error: errText(err) })
  }
  if (typeof onWaiting === 'function') { try { onWaiting() } catch (_) { /* UI only */ } }
  const TIMEOUT = {}
  const FAILED = {}
  let readyTimer = null
  // Code review round 1: an install that fails (a mixed deploy fails D2's integrity check) never makes
  // ready() settle; say so as soon as the installing worker turns redundant with nothing active.
  const failedInstall = new Promise((resolve) => {
    const w = registration.installing || registration.waiting
    if (!w || typeof w.addEventListener !== 'function' || registration.active) return
    w.addEventListener('statechange', () => { if (w.state === 'redundant' && !registration.active) resolve(FAILED) })
  })
  const ready = await Promise.race([sw.ready, failedInstall, new Promise((resolve) => { readyTimer = setTimeout(() => resolve(TIMEOUT), readyTimeoutMs) })])
  clearTimeout(readyTimer)
  if (ready === TIMEOUT) return Object.assign(base, { error: 'service worker not ready after ' + readyTimeoutMs + ' ms' })
  if (ready === FAILED) return Object.assign(base, { error: 'the service worker install failed (redundant)' })
  let controlled = !!sw.controller
  if (!controlled) controlled = await waitForController(sw, controllerWaitMs)
  if (controlled) {
    clearSession(storage, SW_RELOAD_KEY)
  } else if (shell) {
    const previous = readSession(storage, SW_RELOAD_KEY)
    if (!previous && writeSession(storage, SW_RELOAD_KEY, Date.now()) && win && win.location) {
      win.location.reload()
      return { ok: true, controlled: false, degraded: false, reloaded: true, error: null, proto, registration: ready || registration }
    }
  }
  return { ok: true, controlled, degraded: false, reloaded: false, error: null, proto, registration: ready || registration }
}

/** Posts { proto, type, ...data } to the controlling (or active) worker. Returns false if none. */
export function postToServiceWorker (type, data = {}, { nav = globalNav(), proto = 1, registration = null } = {}) {
  const sw = nav && nav.serviceWorker
  const target = (sw && sw.controller) || (registration && registration.active) || null
  if (!target) return false
  try {
    target.postMessage(Object.assign({}, data, { proto, type }))
    return true
  } catch (_) { return false }
}

/**
 * requestServiceWorker(type, data, { proto, timeoutMs, registration }) → the worker's reply to this
 * message ({ proto, type: 'mw-ack', of, ok, ... }), or null when there is no worker or no answer in
 * time. The reply travels on a transferred port, so it answers this message and no other one: the
 * worker sends it after it has finished the work (unlike a ping, which it answers at once).
 */
export function requestServiceWorker (type, data = {}, { nav = globalNav(), proto = 1, timeoutMs = 3000, registration = null } = {}) {
  const sw = nav && nav.serviceWorker
  const target = (sw && sw.controller) || (registration && registration.active) || null
  if (!target || typeof MessageChannel !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let timer = null
    const finish = (value) => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      try { channel.port1.close() } catch (_) { /* ignore */ }
      resolve(value)
    }
    channel.port1.onmessage = (e) => {
      const d = e && e.data
      if (d && typeof d === 'object' && (d.of === type || d.type !== 'mw-ack')) finish(d)
    }
    timer = setTimeout(() => finish(null), timeoutMs)
    try {
      target.postMessage(Object.assign({}, data, { proto, type }), [channel.port2])
    } catch (_) { finish(null) }
  })
}

/**
 * pingServiceWorker() → the worker's { proto, type: 'mw-pong', buildId } reply, or null on timeout.
 * Accepts a reply on the transferred port or on navigator.serviceWorker 'message'.
 */
export function pingServiceWorker ({ nav = globalNav(), proto = 1, timeoutMs = 1500, registration = null } = {}) {
  const sw = nav && nav.serviceWorker
  const target = (sw && sw.controller) || (registration && registration.active) || null
  if (!target) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    let channel = null
    let timer = null
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sw.removeEventListener('message', onMessage) } catch (_) { /* ignore */ }
      try { if (channel) channel.port1.close() } catch (_) { /* ignore */ }
      resolve(value)
    }
    const accept = (data) => {
      if (data && typeof data === 'object' && data.type === 'mw-pong') finish(data)
    }
    const onMessage = (e) => accept(e && e.data)
    try { sw.addEventListener('message', onMessage) } catch (_) { /* ignore */ }
    try {
      channel = typeof MessageChannel === 'function' ? new MessageChannel() : null
      if (channel) channel.port1.onmessage = (e) => accept(e && e.data)
      target.postMessage({ proto, type: 'mw-ping' }, channel ? [channel.port2] : [])
    } catch (_) { finish(null); return }
    timer = setTimeout(() => finish(null), timeoutMs)
  })
}

/**
 * watchController({ onMismatch }) → stop(). After every controllerchange the page pings the new
 * worker; a different protocol version means this page is stale ("Reload").
 */
export function watchController ({ nav = globalNav(), proto = 1, onMismatch, onChange } = {}) {
  const sw = nav && nav.serviceWorker
  if (!sw || typeof sw.addEventListener !== 'function') return () => {}
  const handler = async () => {
    if (typeof onChange === 'function') { try { onChange() } catch (_) { /* UI only */ } }
    const pong = await pingServiceWorker({ nav, proto })
    if (pong && pong.proto !== proto && typeof onMismatch === 'function') onMismatch(pong)
  }
  sw.addEventListener('controllerchange', handler)
  return () => sw.removeEventListener('controllerchange', handler)
}

// ---------------------------------------------------------------------------------------------
// Frame guards (DESIGN-REVIEW item 8)
// ---------------------------------------------------------------------------------------------

function closestLink (target) {
  let node = target
  while (node && node.nodeType !== 1) node = node.parentNode
  if (!node || typeof node.closest !== 'function') return null
  return node.closest('a[href], area[href]')
}

function linkHref (a) {
  const raw = a.getAttribute('href') || (a.getAttributeNS ? a.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null)
  if (!raw) return null
  try { return new URL(raw, a.ownerDocument.baseURI).href } catch (_) { return null }
}

/**
 * installFrameGuards(iframe, handlers) → uninstall(). On every frame load: a capture-phase click
 * listener opens cross-origin links that have no target in a new tab with noopener; the Navigation
 * API (where present) does the same for scripted navigations; a frame that still ends up cross-origin
 * is sent to about:blank and handlers.onBlocked({ url }) is called.
 * handlers: { onBlocked, onLoad(doc), origin, win, onSameOriginLink(url, event) }
 */
export function installFrameGuards (iframe, handlers = {}) {
  const win = handlers.win || (iframe.ownerDocument && iframe.ownerDocument.defaultView) || globalWin()
  const origin = handlers.origin || (win && win.location && win.location.origin)
  let lastExternal = null

  const openOutside = (url) => {
    lastExternal = url
    try { if (win) win.open(url, '_blank', 'noopener') } catch (_) { /* popup blocked */ }
  }

  const onClick = (e) => {
    if (!e || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = closestLink(e.target)
    if (!a) return
    const target = (a.getAttribute('target') || '').trim().toLowerCase()
    if (target && target !== '_self') return
    const href = linkHref(a)
    if (!href) return
    if (isCrossOrigin(href, origin)) {
      e.preventDefault()
      openOutside(href)
    } else if (typeof handlers.onSameOriginLink === 'function') {
      handlers.onSameOriginLink(href, e, a)
    }
  }

  const onSubmit = (e) => {
    const form = e && e.target
    if (!form || typeof form.getAttribute !== 'function') return
    let action = null
    try { action = new URL(form.getAttribute('action') || '', form.ownerDocument.baseURI).href } catch (_) { action = null }
    if (action && isCrossOrigin(action, origin)) lastExternal = action
  }

  const onNavigate = (e) => {
    const url = e && e.destination && e.destination.url
    if (!url || !isCrossOrigin(url, origin)) return
    lastExternal = url
    if (e.cancelable && !e.downloadRequest) {
      e.preventDefault()
      openOutside(url)
    }
  }

  const onLoad = () => {
    let frameWin = null
    let href = null
    try {
      frameWin = iframe.contentWindow
      href = frameWin.location.href
    } catch (_) {
      href = null
    }
    if (href === null || (href !== 'about:blank' && href !== 'about:srcdoc' && isCrossOrigin(href, origin))) {
      // The frame left the site's origin (form post, script navigation, a click the guards missed):
      // blank it so no foreign page runs inside the shell, and tell the UI.
      try { iframe.src = 'about:blank' } catch (_) { /* ignore */ }
      if (typeof handlers.onBlocked === 'function') handlers.onBlocked({ url: lastExternal })
      return
    }
    let doc = null
    try { doc = iframe.contentDocument } catch (_) { doc = null }
    if (doc && !doc.__mwGuarded) {
      doc.__mwGuarded = true
      doc.addEventListener('click', onClick, true)
      doc.addEventListener('submit', onSubmit, true)
    }
    try {
      if (frameWin && frameWin.navigation && typeof frameWin.navigation.addEventListener === 'function' && !frameWin.__mwNavGuard) {
        frameWin.__mwNavGuard = true
        frameWin.navigation.addEventListener('navigate', onNavigate)
      }
    } catch (_) { /* Navigation API unavailable */ }
    if (typeof handlers.onLoad === 'function' && doc) handlers.onLoad(doc)
  }

  iframe.addEventListener('load', onLoad)
  const uninstall = function uninstall () { iframe.removeEventListener('load', onLoad) }
  // Code review round 1: limited mode writes documents into the frame (document.open()), which erases
  // the document's and window's listeners without a load event: it calls this to attach them again.
  uninstall.attach = () => {
    try {
      if (iframe.contentDocument) iframe.contentDocument.__mwGuarded = false
      if (iframe.contentWindow) iframe.contentWindow.__mwNavGuard = false
    } catch (_) { /* cross-origin: onLoad blanks it */ }
    onLoad()
  }
  return uninstall
}

// ---------------------------------------------------------------------------------------------
// Mounting (shell mode and shared hub)
// ---------------------------------------------------------------------------------------------

/**
 * syncViewport(shellDoc, frameDoc) (code review round 1): an iframe has no viewport of its own, so the
 * shell's <meta name="viewport"> decides how the site lays out on phones. After each frame load the
 * shell takes the site's: its content as is (viewport-fit=cover and interactive-widget only when the
 * site declares them), or, when the site has none, the default both phone engines use without a meta
 * (width=980: removing the meta does not reset the viewport in Chromium, measured in Chromium 156), so
 * the site lays out as when it is opened directly. Returns the content set. restoreViewport(shellDoc,
 * content) puts the shell's own back (the loader's screens).
 */
export const DEFAULT_VIEWPORT = 'width=980'

export function syncViewport (shellDoc, frameDoc) {
  let site = null
  try {
    const m = frameDoc && typeof frameDoc.querySelector === 'function' ? frameDoc.querySelector('meta[name="viewport" i]') : null
    site = m ? String(m.getAttribute('content') || '').trim() : null
  } catch (_) { return undefined }
  return setViewport(shellDoc, site || DEFAULT_VIEWPORT)
}

export function restoreViewport (shellDoc, content) {
  return setViewport(shellDoc, content || null)
}

function setViewport (doc, content) {
  if (!doc || !doc.head) return undefined
  let meta = doc.head.querySelector('meta[name="viewport"]')
  if (content === null) {
    if (meta && meta.parentNode) meta.parentNode.removeChild(meta)
    return null
  }
  if (!meta) {
    meta = doc.createElement('meta')
    meta.setAttribute('name', 'viewport')
    doc.head.appendChild(meta)
  }
  if (meta.getAttribute('content') !== content) meta.setAttribute('content', content)
  return content
}

function shellViewport (doc) {
  try {
    const m = doc && doc.head ? doc.head.querySelector('meta[name="viewport"]') : null
    return m ? m.getAttribute('content') : null
  } catch (_) { return null }
}

function makeFrame (doc, mode) {
  const iframe = doc.createElement('iframe')
  iframe.className = 'mw-site-frame'
  iframe.setAttribute('title', 'Site')
  iframe.setAttribute('allow', FRAME_ALLOW)
  iframe.setAttribute('sandbox', mode === 'hub-shared' ? SANDBOX['hub-shared'] : SANDBOX.shell)
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  return iframe
}

function currentTopPath (win) {
  const l = win.location
  return l.pathname + l.search + l.hash
}

function watchTitle (frameDoc, apply, win) {
  try {
    const MO = win && win.MutationObserver
    if (!MO || !frameDoc || !frameDoc.head) return null
    const obs = new MO(apply)
    obs.observe(frameDoc.head, { childList: true, subtree: true, characterData: true })
    return obs
  } catch (_) { return null }
}

/**
 * mountSite({ container, mode: 'shell'|'hub-shared', btih, path, onNavigate, onTitle,
 *   onBlockedNavigation }) → { iframe, navigate(path), destroy() }
 * The frame opens the top-level URL itself (shell) or /_mw/s/<btih>/<path> (shared hub). Every frame
 * load is mirrored into the address bar with history.replaceState (never pushState) and the frame
 * title is copied. popstate and hashchange on the top page move the frame.
 */
export function mountSite ({ container, mode = 'shell', btih = null, path = '/', onNavigate, onTitle, onBlockedNavigation, win: winIn = null } = {}) {
  const doc = container.ownerDocument
  const win = winIn || doc.defaultView || globalWin()
  const iframe = makeFrame(doc, mode)
  const srcFor = (p) => (mode === 'hub-shared' ? hubSiteUrl(btih, p) : normalizeFramePath(p))
  let destroyed = false
  let current = typeof path === 'string' && path ? path : '/'
  let titleObserver = null
  const ownViewport = shellViewport(doc)

  const applyTitle = () => {
    try {
      const t = iframe.contentDocument && iframe.contentDocument.title
      if (t && typeof t === 'string' && doc.title !== t) {
        doc.title = t
        if (typeof onTitle === 'function') onTitle(t)
      }
    } catch (_) { /* not readable */ }
  }

  const mirror = () => {
    if (destroyed) return
    let href
    try { href = iframe.contentWindow.location.href } catch (_) { return }
    if (!href || href === 'about:blank') return
    const site = frameSitePath(href, mode, btih)
    if (site === null) return
    current = site
    const target = topUrlFor(win.location, mode, site)
    // Loop guard: only replace when the address bar differs; replaceState fires no popstate.
    if (target !== currentTopPath(win)) {
      try { win.history.replaceState(win.history.state, '', target) } catch (_) { /* sandboxed embedding */ }
    }
    if (typeof onNavigate === 'function') onNavigate(site)
  }

  const uninstallGuards = installFrameGuards(iframe, {
    win,
    onBlocked: (info) => { if (typeof onBlockedNavigation === 'function') onBlockedNavigation(info || {}) },
    onLoad: (frameDoc) => {
      mirror()
      applyTitle()
      syncViewport(doc, frameDoc)
      if (titleObserver) { try { titleObserver.disconnect() } catch (_) { /* ignore */ } }
      titleObserver = watchTitle(frameDoc, applyTitle, win)
      try {
        const fw = iframe.contentWindow
        if (fw && !fw.__mwMirror) {
          fw.__mwMirror = true
          // History-API routers and in-page anchors change the URL without a load event.
          fw.addEventListener('popstate', mirror)
          fw.addEventListener('hashchange', mirror)
          const h = fw.history
          if (h && typeof h.pushState === 'function' && !h.__mwWrapped) {
            h.__mwWrapped = true
            const push = h.pushState
            const replace = h.replaceState
            h.pushState = function () { const r = push.apply(this, arguments); mirror(); return r }
            h.replaceState = function () { const r = replace.apply(this, arguments); mirror(); return r }
          }
        }
      } catch (_) { /* cross-origin or locked down */ }
    }
  })

  const navigate = (p) => {
    const next = typeof p === 'string' && p ? p : '/'
    if (next === current) return
    current = next
    const url = srcFor(next)
    try {
      const cw = iframe.contentWindow
      if (cw && cw.location) cw.location.replace(url)
      else iframe.src = url
    } catch (_) { iframe.src = url }
  }

  const onTopChange = () => {
    if (destroyed) return
    const want = mode === 'hub-shared' ? hubPathFromLocation(win.location) : pathFromLocation(win.location, { includeHash: true })
    if (want !== current) navigate(want)
  }

  win.addEventListener('popstate', onTopChange)
  win.addEventListener('hashchange', onTopChange)
  iframe.src = srcFor(current)
  container.appendChild(iframe)

  return {
    iframe,
    navigate,
    currentPath: () => current,
    destroy () {
      if (destroyed) return
      destroyed = true
      win.removeEventListener('popstate', onTopChange)
      win.removeEventListener('hashchange', onTopChange)
      uninstallGuards()
      if (titleObserver) { try { titleObserver.disconnect() } catch (_) { /* ignore */ } }
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      restoreViewport(doc, ownViewport)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Degraded mode (§7.4): no Service Worker
// ---------------------------------------------------------------------------------------------

function siteFiles (parsed, blobs) {
  const map = new Map()
  const list = parsed && Array.isArray(parsed.files) ? parsed.files : []
  for (const f of list) {
    if (!f || f.pad || typeof f.path !== 'string') continue
    const key = cleanSitePath(f.path)
    const blob = blobs instanceof Map ? blobs.get(f.path) || blobs.get(key) : null
    if (blob) map.set(key, blob)
  }
  if (!list.length && blobs instanceof Map) for (const [k, v] of blobs) map.set(cleanSitePath(k), v)
  return map
}

function mimeOf (path, blob) {
  if (blob && blob.type) return blob.type
  const ext = (/\.([a-z0-9]+)$/i.exec(path) || [])[1]
  const m = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', txt: 'text/plain', xml: 'application/xml', wasm: 'application/wasm' }
  return m[(ext || '').toLowerCase()] || 'application/octet-stream'
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/**
 * mountDegraded({ container, parsed, blobs, path, routing, onNavigate, onTitle,
 *   onBlockedNavigation, writeDocument }) → { iframe, navigate(path), destroy() }
 * Renders the page with every reference to a torrent file rewritten to a blob: URL (src, href,
 * srcset, poster, CSS url() and @import, module import specifiers), inline scripts turned into blob:
 * scripts, an injected <base>, and same-site link clicks re-rendered here. Relative fetch() by the
 * site's own code cannot work without a Service Worker (documented).
 * Code review round 1:
 * - shell mode writes the page into a fresh same-origin about:blank frame with document.open() /
 *   write() / close() (writeDocument, default on), so the frame's URL is the address-bar path:
 *   location.pathname, history.pushState() and relative URLs behave as on the host (with srcdoc the
 *   document was about:srcdoc and pushState threw); the shared hub and a failed write keep srcdoc;
 * - where import maps exist (Chrome 89, Firefox 108, Safari 16.4) every module of the page's graph
 *   gets one blob: URL behind one import map keyed by its site URL, so a module graph with a cycle
 *   (Rollup and Vite code splitting: a lazy chunk imports the entry) links with one instance per
 *   module; without import maps (Safari 15.4 to 16.3) the recursive rewrite stays, with that limit.
 */
export async function mountDegraded ({ container, parsed, blobs, path = '/', routing = null, mode = 'shell', onNavigate, onTitle, onBlockedNavigation, win: winIn = null, writeDocument = true } = {}) {
  const doc = container.ownerDocument
  const win = winIn || doc.defaultView || globalWin()
  const origin = win.location.origin
  const files = siteFiles(parsed, blobs)
  const has = (p) => files.has(p)
  const urls = new Map()
  const textCache = new Map()
  let destroyed = false
  let current = typeof path === 'string' && path ? path : '/'
  let renderSeq = 0

  const blobUrl = (blob, type) => {
    const b = blob.type === type ? blob : new win.Blob([blob], { type })
    return win.URL.createObjectURL(b)
  }
  const fileUrl = (p) => {
    if (urls.has(p)) return urls.get(p)
    const blob = files.get(p)
    if (!blob) return null
    const url = blobUrl(blob, mimeOf(p, blob))
    urls.set(p, url)
    return url
  }
  const text = async (p) => {
    if (!textCache.has(p)) textCache.set(p, files.get(p).text())
    return textCache.get(p)
  }

  // Stylesheets: url() and @import are rewritten first, recursively (cycles fall back to the plain file).
  const cssUrl = async (p, stack = []) => {
    const key = 'css:' + p
    if (urls.has(key)) return urls.get(key)
    if (!files.has(p)) return null
    if (stack.includes(p)) return fileUrl(p)
    const css = await text(p)
    const imports = []
    String(css).replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi, (w, q, ref) => { imports.push(ref); return w })
    const nested = new Map()
    for (const ref of imports) {
      const target = resolveRef(p, ref)
      if (target && files.has(target)) nested.set(target, await cssUrl(target, stack.concat(p)))
    }
    const out = rewriteCssText(css, p, (target) => nested.get(target) || fileUrl(target))
    const url = win.URL.createObjectURL(new win.Blob([out], { type: 'text/css' }))
    urls.set(key, url)
    return url
  }

  // Import maps (code review round 1): a module's specifiers name other modules by their site URL
  // (origin + '/' + path), and the import map points each site URL at that module's blob: URL.
  let importMaps = false
  try { importMaps = !!(win.HTMLScriptElement && typeof win.HTMLScriptElement.supports === 'function' && win.HTMLScriptElement.supports('importmap')) } catch (_) { importMaps = false }
  const keyOf = (p) => origin + '/' + p
  const mapped = new Map() // site path → blob: URL of the rewritten module (import-map mode)
  const specifierKey = (basePath, spec) => {
    if (!(spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../'))) return null
    const target = resolveRef(basePath, spec)
    if (target === null) return null
    if (('/' + target).startsWith('/_mw/')) return { key: origin + '/' + target, target: null }
    return files.has(target) ? { key: keyOf(target), target } : null
  }
  const mapModule = async (p) => {
    if (mapped.has(p)) return mapped.get(p)
    mapped.set(p, null) // in progress: a cycle needs no blob URL, only the key
    const code = await text(p)
    const deps = []
    const out = rewriteModuleSpecifiers(code, (s) => {
      const k = specifierKey(p, s)
      if (k && k.target) deps.push(k.target)
      return k ? k.key : null
    })
    const url = win.URL.createObjectURL(new win.Blob([out], { type: 'text/javascript' }))
    urls.set('mjs:' + p, url)
    mapped.set(p, url)
    for (const d of deps) await mapModule(d)
    return url
  }
  const rewriteInlineModule = async (code, basePath) => {
    const deps = []
    const out = rewriteModuleSpecifiers(code, (s) => {
      const k = specifierKey(basePath, s)
      if (k && k.target) deps.push(k.target)
      return k ? k.key : null
    })
    for (const d of deps) await mapModule(d)
    return out
  }

  // ES modules: specifiers that resolve to torrent files become blob: URLs of rewritten modules;
  // /_mw/* stays on the host (a real file there); everything else is left alone.
  const moduleUrl = async (p, stack = []) => {
    if (importMaps) return mapModule(p)
    const key = 'mjs:' + p
    if (urls.has(key)) return urls.get(key)
    if (!files.has(p)) return null
    if (stack.includes(p)) return fileUrl(p)
    const code = await text(p)
    const out = await rewriteModuleCode(code, p, stack.concat(p))
    const url = win.URL.createObjectURL(new win.Blob([out], { type: 'text/javascript' }))
    urls.set(key, url)
    return url
  }
  const rewriteModuleCode = async (code, basePath, stack) => {
    if (importMaps) return rewriteInlineModule(code, basePath)
    const specs = new Set()
    rewriteModuleSpecifiers(code, (s) => { specs.add(s); return null })
    const mapped = new Map()
    for (const spec of specs) {
      if (!(spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../'))) continue
      const target = resolveRef(basePath, spec)
      if (target === null) continue
      if (('/' + target).startsWith('/_mw/')) mapped.set(spec, origin + '/' + target)
      else if (files.has(target)) mapped.set(spec, await moduleUrl(target, stack))
    }
    return rewriteModuleSpecifiers(code, (s) => mapped.get(s) || null)
  }

  const rewriteDocument = async (html, docPath) => {
    const page = new win.DOMParser().parseFromString(html, 'text/html')
    for (const m of Array.from(page.querySelectorAll('meta[http-equiv]'))) {
      if (/content-security-policy/i.test(m.getAttribute('http-equiv') || '')) m.remove()
    }
    for (const b of Array.from(page.querySelectorAll('base'))) b.remove()
    const base = page.createElement('base')
    base.setAttribute('href', origin + '/' + dirOf(docPath))
    page.head.insertBefore(base, page.head.firstChild)
    // The site's own import map (one is honoured): its values that name torrent files point at our
    // blob: URLs, and it is merged into ours below.
    let siteMap = null
    if (importMaps) {
      for (const s of Array.from(page.querySelectorAll('script[type="importmap"]'))) {
        if (!siteMap) {
          try { siteMap = JSON.parse(s.textContent || '{}') } catch (_) { siteMap = null }
        }
        s.remove()
      }
    }

    const swapAttr = (el, attr) => {
      const target = resolveRef(docPath, el.getAttribute(attr))
      if (target === null) return
      if (('/' + target).startsWith('/_mw/')) { el.setAttribute(attr, origin + '/' + target); return }
      const url = fileUrl(target)
      if (url) el.setAttribute(attr, url)
    }
    for (const link of Array.from(page.querySelectorAll('link[href]'))) {
      const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/)
      const target = resolveRef(docPath, link.getAttribute('href'))
      if (target !== null && rel.includes('stylesheet') && files.has(target)) {
        link.setAttribute('href', await cssUrl(target))
        link.removeAttribute('integrity')
      } else if (target !== null && rel.includes('modulepreload') && files.has(target)) {
        link.setAttribute('href', await moduleUrl(target))
        link.removeAttribute('integrity')
      } else {
        swapAttr(link, 'href')
      }
    }
    for (const s of Array.from(page.querySelectorAll('script'))) {
      const type = (s.getAttribute('type') || '').trim().toLowerCase()
      const isModule = type === 'module'
      const isClassic = !type || type === 'text/javascript' || type === 'application/javascript'
      if (!isModule && !isClassic) continue
      s.removeAttribute('integrity')
      if (s.hasAttribute('src')) {
        const target = resolveRef(docPath, s.getAttribute('src'))
        if (target === null) continue
        if (('/' + target).startsWith('/_mw/')) { s.setAttribute('src', origin + '/' + target); continue }
        if (!files.has(target)) continue
        s.setAttribute('src', isModule ? await moduleUrl(target) : fileUrl(target))
      } else {
        const code = s.textContent || ''
        const body = isModule ? await rewriteModuleCode(code, docPath, [docPath]) : code
        const url = win.URL.createObjectURL(new win.Blob([body], { type: 'text/javascript' }))
        urls.set('inline:' + urls.size, url)
        s.textContent = ''
        s.setAttribute('src', url)
      }
    }
    for (const el of Array.from(page.querySelectorAll('[src]'))) if (el.tagName !== 'SCRIPT') swapAttr(el, 'src')
    for (const el of Array.from(page.querySelectorAll('[poster]'))) swapAttr(el, 'poster')
    for (const el of Array.from(page.querySelectorAll('[srcset]'))) {
      el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'), docPath, (t) => fileUrl(t)))
    }
    for (const el of Array.from(page.querySelectorAll('style'))) {
      el.textContent = rewriteCssText(el.textContent || '', docPath, (t) => fileUrl(t))
    }
    for (const el of Array.from(page.querySelectorAll('[style]'))) {
      el.setAttribute('style', rewriteCssText(el.getAttribute('style') || '', docPath, (t) => fileUrl(t)))
    }
    for (const el of Array.from(page.querySelectorAll('use[href], image[href]'))) swapAttr(el, 'href')
    if (importMaps) {
      const remap = async (value) => {
        if (typeof value !== 'string') return value
        const target = resolveRef(docPath, value)
        if (target === null || !files.has(target)) return value
        return (await mapModule(target)) || value
      }
      const imports = {}
      const scopes = {}
      if (siteMap && siteMap.imports && typeof siteMap.imports === 'object') {
        for (const [k, v] of Object.entries(siteMap.imports)) imports[k] = await remap(v)
      }
      if (siteMap && siteMap.scopes && typeof siteMap.scopes === 'object') {
        for (const [scope, entries] of Object.entries(siteMap.scopes)) {
          if (!entries || typeof entries !== 'object') continue
          scopes[scope] = {}
          for (const [k, v] of Object.entries(entries)) scopes[scope][k] = await remap(v)
        }
      }
      for (const [p, url] of mapped) if (url) imports[keyOf(p)] = url
      if (Object.keys(imports).length || Object.keys(scopes).length) {
        const map = page.createElement('script')
        map.setAttribute('type', 'importmap')
        map.textContent = JSON.stringify(Object.keys(scopes).length ? { imports, scopes } : { imports })
        page.head.insertBefore(map, base.nextSibling)
      }
    }
    return { html: '<!doctype html>\n' + page.documentElement.outerHTML, title: page.title || '' }
  }

  const iframe = makeFrame(doc, mode)
  // Shell: the page is written into the frame (see above); the shared hub keeps srcdoc, because its
  // site paths live under /_mw/s/<btih>/ while the address bar shows the hub.
  let useWrite = writeDocument !== false && mode !== 'hub-shared'
  let written = false
  const freshBlank = () => new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      iframe.removeEventListener('load', done)
      resolve()
    }
    iframe.addEventListener('load', done)
    try { iframe.contentWindow.location.replace('about:blank') } catch (_) { iframe.setAttribute('src', 'about:blank') }
    setTimeout(done, 2000)
  })
  const writeInto = async (html) => {
    // A fresh about:blank for every page after the first: document.open() alone would keep the
    // previous page's global object (its top-level let/const would collide).
    if (written) await freshBlank()
    const d = iframe.contentDocument
    if (!d) throw new Error('no frame document')
    d.open()
    d.write(html)
    d.close()
    written = true
    if (uninstallGuards && typeof uninstallGuards.attach === 'function') uninstallGuards.attach()
  }

  const render = async (target, depth = 0) => {
    const seq = ++renderSeq
    const raw = typeof target === 'string' && target ? target : '/'
    const hashIndex = raw.indexOf('#')
    const route = resolveSitePath(routing, raw, has)
    if (route.redirect && depth < 5) return render(route.redirect, depth + 1)
    let html
    let title = ''
    if (route.path && files.has(route.path)) {
      const out = await rewriteDocument(await text(route.path), route.path)
      html = out.html
      title = out.title
    } else {
      html = '<!doctype html><title>Not found</title><p>Not found: ' + escapeHtml(raw) + '</p>'
    }
    if (destroyed || seq !== renderSeq) return
    current = raw
    // The address bar first: a written document takes the shell's URL as its own.
    try {
      const top = topUrlFor(win.location, mode, normalizeFramePath(raw.split('#')[0]) + (hashIndex === -1 ? '' : raw.slice(hashIndex)))
      if (top !== currentTopPath(win)) win.history.replaceState(win.history.state, '', top)
    } catch (_) { /* ignore */ }
    let wrote = false
    if (useWrite) {
      try {
        await writeInto(html)
        wrote = true
      } catch (_) {
        useWrite = false // this browser refused the write: srcdoc from here on
      }
    }
    if (!wrote) iframe.srcdoc = html
    if (title) {
      doc.title = title
      if (typeof onTitle === 'function') onTitle(title)
    }
    if (typeof onNavigate === 'function') onNavigate(raw)
  }

  const ownViewport = shellViewport(doc)
  const uninstallGuards = installFrameGuards(iframe, {
    win,
    origin,
    // Code review round 1: the site's own viewport (see syncViewport), after a write and a srcdoc load.
    onLoad: (frameDoc) => { syncViewport(doc, frameDoc) },
    onBlocked: (info) => { if (typeof onBlockedNavigation === 'function') onBlockedNavigation(info || {}) },
    onSameOriginLink: (href, e, a) => {
      const raw = a.getAttribute('href') || ''
      if (raw.startsWith('#')) {
        e.preventDefault()
        try {
          const id = decodeURIComponent(raw.slice(1))
          const frameDoc = iframe.contentDocument
          const el = id ? (frameDoc.getElementById(id) || frameDoc.getElementsByName(id)[0]) : frameDoc.body
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView()
        } catch (_) { /* ignore */ }
        return
      }
      let u
      try { u = new URL(href) } catch (_) { return }
      if (u.pathname.startsWith('/_mw/')) return
      e.preventDefault()
      render(u.pathname + u.search + u.hash)
    }
  })

  container.appendChild(iframe)
  await render(current)

  return {
    iframe,
    degraded: true,
    navigate: (p) => render(p),
    currentPath: () => current,
    destroy () {
      if (destroyed) return
      destroyed = true
      uninstallGuards()
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      restoreViewport(doc, ownViewport)
      for (const url of urls.values()) { try { win.URL.revokeObjectURL(url) } catch (_) { /* ignore */ } }
      urls.clear()
    }
  }
}
