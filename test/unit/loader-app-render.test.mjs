// Unit tests for the pure parts of src/loader/render.js and its page <-> worker messaging
// (ARCHITECTURE 5.2, 7.1, 7.2; DESIGN-REVIEW items 7, 8, 17). Browser objects are small fakes;
// MessageChannel is Node's own. Every port is closed, so the file exits on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeFramePath, pathFromLocation, splitHubPath, hubSiteUrl, topUrlFor, hubPathFromLocation, frameSitePath,
  isCrossOrigin, cspString, requestServiceWorker, pingServiceWorker, postToServiceWorker, registerServiceWorker,
  syncViewport, restoreViewport
} from '../../src/loader/render.js'

const BTIH = 'ab'.repeat(20)

/** A navigator.serviceWorker with a controller that answers like src/sw/core.js message(). */
function fakeNav ({ answer = (data) => ({ type: 'mw-ack', of: data.type, ok: true, complete: true }), controller = true, delayMs = 0 } = {}) {
  const posted = []
  const listeners = new Set()
  const worker = {
    postMessage (data, transfer) {
      posted.push(data)
      const port = transfer && transfer[0]
      const reply = answer(data)
      if (!reply) {
        if (port) port.close()
        return
      }
      const send = () => {
        if (port) { port.postMessage(Object.assign({ proto: 1 }, reply)); port.close() } else for (const fn of listeners) fn({ data: Object.assign({ proto: 1 }, reply) })
      }
      if (delayMs) setTimeout(send, delayMs); else send()
    }
  }
  return {
    posted,
    serviceWorker: {
      controller: controller ? worker : null,
      addEventListener (type, fn) { if (type === 'message') listeners.add(fn) },
      removeEventListener (type, fn) { listeners.delete(fn) }
    }
  }
}

test('frame paths: leading slashes collapse, search and hash are kept on request', () => {
  assert.equal(normalizeFramePath('//evil.example/x'), '/evil.example/x')
  assert.equal(normalizeFramePath('\\\\x'), '/x')
  assert.equal(normalizeFramePath(undefined), '/')
  assert.equal(pathFromLocation({ pathname: '/a/b', search: '?q=1', hash: '#h' }), '/a/b?q=1')
  assert.equal(pathFromLocation({ pathname: '/a/b', search: '?q=1', hash: '#h' }, { includeHash: true }), '/a/b?q=1#h')
  assert.equal(pathFromLocation('https://site.test//x?y'), '/x?y')
})

test('shared hub paths: split, build, mirror to the top URL and back', () => {
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH + '/about.html'), { btih: BTIH, path: '/about.html' })
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH.toUpperCase()), { btih: BTIH, path: '/' })
  assert.equal(splitHubPath('/_mw/s/nothex/x'), null)
  assert.equal(splitHubPath('/about'), null)
  assert.equal(hubSiteUrl(BTIH, 'x/y'), '/_mw/s/' + BTIH + '/x/y')
  assert.equal(topUrlFor({ search: '', hash: '#btih:' + BTIH }, 'hub-shared', '/x?y=1'), '/?p=%2Fx%3Fy%3D1#btih:' + BTIH)
  assert.equal(topUrlFor({ search: '?p=%2Fold', hash: '' }, 'hub-shared', '/'), '/')
  assert.equal(topUrlFor(null, 'shell', '//x'), '/x')
  assert.equal(hubPathFromLocation({ search: '?p=%2Fdocs%2F' }), '/docs/')
  assert.equal(frameSitePath('https://hub.test/_mw/s/' + BTIH + '/a?b#c', 'hub-shared', BTIH), '/a?b#c')
  assert.equal(frameSitePath('https://hub.test/_mw/s/' + 'cd'.repeat(20) + '/a', 'hub-shared', BTIH), null)
  assert.equal(frameSitePath('about:blank', 'shell'), null)
  assert.equal(frameSitePath('https://site.test/a/b?c', 'shell'), '/a/b?c')
  assert.equal(isCrossOrigin('https://other.test/x', 'https://site.test'), true)
  assert.equal(isCrossOrigin('https://site.test/x', 'https://site.test'), false)
  assert.equal(isCrossOrigin('mailto:x@y', 'https://site.test'), false)
})

test('CSP: the shell policy, the dev additions and the degraded variant', () => {
  const normal = cspString('normal')
  assert.match(normal, /default-src 'self'/)
  assert.match(normal, /script-src 'self'(;|$)/)
  assert.match(normal, /connect-src 'self' https: wss:/)
  assert.match(normal, /object-src 'none'/)
  assert.doesNotMatch(normal, /ws:\/\/127\.0\.0\.1/)
  assert.match(cspString('normal', { dev: true }), /ws:\/\/127\.0\.0\.1:\*/)
  const degraded = cspString('degraded')
  assert.match(degraded, /script-src[^;]*blob:/)
  assert.match(degraded, /script-src[^;]*'unsafe-inline'/)
  // Code review round 1: third-party subresources load in limited mode as in SW mode.
  for (const d of ['script-src', 'style-src', 'img-src', 'media-src', 'font-src', 'frame-src']) {
    assert.match(degraded, new RegExp(d + "[^;]* https:(;| |$)"), d + ' allows https:')
    assert.match(cspString('degraded', { dev: true }), new RegExp(d + '[^;]*http://127\\.0\\.0\\.1:\\*'), d + ' allows loopback in development')
  }
  assert.doesNotMatch(cspString('normal'), /script-src[^;]*https:/, 'the normal shell policy stays strict')
  assert.doesNotMatch(cspString('normal'), /frame-src[^;]*https:/)
})

test('CSP: boot.js and render.js build the same policies (normal, degraded, development)', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const src = readFileSync(new URL('../../src/loader/boot.js', import.meta.url), 'utf8')
  const start = src.indexOf('  function cspFor (kind, dev, lanHost) {')
  const end = src.indexOf('\n  }\n', start) + 4
  const cspFor = vm.runInNewContext('(' + src.slice(start, end).trim().replace(/^function cspFor/, 'function') + ')')
  for (const kind of ['normal', 'degraded']) {
    for (const dev of [false, true]) assert.equal(cspFor(kind, dev, null), cspString(kind, { dev }), kind + (dev ? ' dev' : ''))
  }
  assert.equal(cspFor('normal', true, '192.168.1.5'), cspString('normal', { dev: true, lanHost: '192.168.1.5' }))
})

test('requestServiceWorker: waits for the worker\'s own ack to this message (not a ping)', async () => {
  const nav = fakeNav({ delayMs: 20 })
  const ack = await requestServiceWorker('mw-set-current', { btih: BTIH }, { nav, proto: 1, timeoutMs: 2000 })
  assert.equal(ack.type, 'mw-ack')
  assert.equal(ack.of, 'mw-set-current')
  assert.equal(ack.complete, true)
  assert.deepEqual(nav.posted[0], { btih: BTIH, proto: 1, type: 'mw-set-current' })
})

test('requestServiceWorker: null without a controller, and null when no answer comes in time', async () => {
  assert.equal(await requestServiceWorker('mw-set-current', {}, { nav: fakeNav({ controller: false }), timeoutMs: 50 }), null)
  assert.equal(await requestServiceWorker('mw-set-current', {}, { nav: null, timeoutMs: 50 }), null)
  const silent = fakeNav({ answer: () => null })
  const t0 = Date.now()
  assert.equal(await requestServiceWorker('mw-site-saved', { btih: BTIH }, { nav: silent, timeoutMs: 60 }), null)
  assert.ok(Date.now() - t0 >= 50)
})

test('requestServiceWorker: an ack for another message type is ignored', async () => {
  const nav = fakeNav({ answer: () => ({ type: 'mw-ack', of: 'mw-map-client', ok: true }) })
  assert.equal(await requestServiceWorker('mw-set-current', {}, { nav, timeoutMs: 60 }), null)
})

test('pingServiceWorker and postToServiceWorker', async () => {
  const nav = fakeNav({ answer: (d) => (d.type === 'mw-ping' ? { type: 'mw-pong', buildId: 'b1' } : null) })
  const pong = await pingServiceWorker({ nav, proto: 1, timeoutMs: 1000 })
  assert.equal(pong.type, 'mw-pong')
  assert.equal(pong.buildId, 'b1')
  assert.equal(postToServiceWorker('mw-map-client', { btih: BTIH }, { nav, proto: 1 }), true)
  assert.deepEqual(nav.posted[nav.posted.length - 1], { btih: BTIH, proto: 1, type: 'mw-map-client' })
  assert.equal(postToServiceWorker('mw-map-client', {}, { nav: fakeNav({ controller: false }) }), false)
})

test('registerServiceWorker: degraded only without the API or when register() rejects', async () => {
  const none = await registerServiceWorker({ nav: {}, win: null, storage: null })
  assert.equal(none.degraded, true)
  assert.equal(none.error, 'no-service-worker')
  const rejecting = { serviceWorker: { register: () => Promise.reject(new Error('blocked')), ready: new Promise(() => {}) } }
  const r = await registerServiceWorker({ nav: rejecting, win: null, storage: null })
  assert.equal(r.degraded, true)
  assert.match(r.error, /blocked/)
  const controlled = { serviceWorker: { controller: {}, register: () => Promise.resolve({ scope: '/' }), ready: Promise.resolve({ active: {} }), addEventListener () {}, removeEventListener () {} } }
  const ok = await registerServiceWorker({ nav: controlled, win: null, storage: null })
  assert.equal(ok.ok, true)
  assert.equal(ok.controlled, true)
  assert.equal(ok.degraded, false)
})

test('registerServiceWorker: register() resolving with nothing (registration blocked) degrades at once', async () => {
  let readyAsked = false
  const blocked = { serviceWorker: { register: () => Promise.resolve(undefined), get ready () { readyAsked = true; return new Promise(() => {}) } } }
  const t0 = Date.now()
  const r = await registerServiceWorker({ nav: blocked, win: null, storage: null, readyTimeoutMs: 60000 })
  assert.equal(r.ok, false)
  assert.equal(r.degraded, true)
  assert.match(r.error, /no registration/)
  assert.equal(readyAsked, false, 'never waits for ready')
  assert.ok(Date.now() - t0 < 1000)
  const probe = await registerServiceWorker({ nav: blocked, win: null, storage: null, existing: Promise.resolve({ ok: false, registration: null, error: 'register() gave no registration' }) })
  assert.equal(probe.ok, false)
  assert.match(probe.error, /no registration/)
})

test('registerServiceWorker: an uncontrolled shell reloads once (sessionStorage guard), never twice', async () => {
  const store = new Map()
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  let reloads = 0
  const win = { location: { reload: () => { reloads++ } } }
  const uncontrolled = () => ({ serviceWorker: { controller: null, register: () => Promise.resolve({ scope: '/' }), ready: Promise.resolve({ active: {} }), addEventListener () {}, removeEventListener () {} } })
  const first = await registerServiceWorker({ nav: uncontrolled(), win, storage, controllerWaitMs: 10 })
  assert.equal(first.reloaded, true)
  assert.equal(reloads, 1)
  const second = await registerServiceWorker({ nav: uncontrolled(), win, storage, controllerWaitMs: 10 })
  assert.equal(second.reloaded, false, 'the guard stops a reload loop')
  assert.equal(second.ok, true)
  assert.equal(reloads, 1)
})

// Code review round 1 (§7.4): limited mode decided after boot.js fixed the normal CSP reloads once.
test('registerServiceWorker: an install that turns redundant (mixed deploy) degrades at once, before the ready() cap', async () => {
  const listeners = []
  const installing = { state: 'installing', addEventListener: (t, fn) => { if (t === 'statechange') listeners.push(fn) } }
  const reg = { installing, waiting: null, active: null }
  const nav = { serviceWorker: { controller: null, register: () => Promise.resolve(reg), ready: new Promise(() => {}), addEventListener () {}, removeEventListener () {} } }
  const t0 = Date.now()
  const p = registerServiceWorker({ nav, win: null, storage: null, readyTimeoutMs: 60000 })
  await new Promise((resolve) => setTimeout(resolve, 5))
  installing.state = 'redundant'
  for (const fn of listeners) fn()
  const r = await p
  assert.equal(r.ok, false)
  assert.equal(r.degraded, true)
  assert.match(r.error, /install failed/)
  assert.ok(Date.now() - t0 < 1000)
})

test('requestDegradedReload: sets the one-time flag and reloads once; never a loop; nothing without sessionStorage', async () => {
  const { requestDegradedReload, DEGRADED_RELOAD_KEY } = await import('../../src/loader/render.js')
  const store = new Map()
  let reloads = 0
  const win = { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, location: { reload: () => { reloads++ } } }
  assert.equal(requestDegradedReload({ win, reason: 'storage' }), true)
  assert.equal(store.get(DEGRADED_RELOAD_KEY), 'storage')
  assert.equal(reloads, 1)
  assert.equal(requestDegradedReload({ win, reason: 'again' }), false, 'already set: this load is the limited one')
  assert.equal(reloads, 1)
  const blocked = { get sessionStorage () { throw new Error('SecurityError') }, location: { reload: () => { reloads++ } } }
  assert.equal(requestDegradedReload({ win: blocked }), false)
  assert.equal(reloads, 1)
})

test('boot.js starts a tab session in limited mode when the degraded flag is set: no register(), the degraded CSP', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const src = readFileSync(new URL('../../src/loader/boot.js', import.meta.url), 'utf8')
  const quiet = { log () {}, warn () {}, error () {} }
  const run = (flag) => {
    const metas = []
    let registered = 0
    const el = () => ({ setAttribute () {}, appendChild () {}, addEventListener () {}, style: {}, className: '', textContent: '' })
    const head = { insertBefore: (m) => metas.push(m), appendChild () {}, firstChild: null }
    const document = {
      head, body: { appendChild () {} }, documentElement: { appendChild () {} }, readyState: 'complete',
      createElement: () => { const m = { attrs: {}, setAttribute (k, v) { this.attrs[k] = v }, getAttribute (k) { return this.attrs[k] }, appendChild () {}, addEventListener () {}, style: {} }; return m },
      getElementById: () => el(), querySelector: () => null, getElementsByTagName: () => [head], currentScript: { src: 'http://127.0.0.1/_mw/boot.js' }
    }
    const window = {
      document, location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', href: 'http://127.0.0.1/' },
      isSecureContext: true, top: null, self: null, indexedDB: {}, crypto: globalThis.crypto, fetch: globalThis.fetch,
      sessionStorage: { getItem: (k) => (k === 'mw:degraded' && flag ? '1' : null), setItem () {}, removeItem () {} },
      navigator: { serviceWorker: { register: () => { registered++; return new Promise(() => {}) } }, userAgent: 'test' },
      setTimeout: () => 0, console: quiet
    }
    window.top = window
    window.self = window
    const ctx = vm.createContext({
      window, document, navigator: window.navigator, setTimeout: () => 0, console: quiet, Uint8Array, AbortSignal, AbortController, Promise, Error,
      Object, Array, String, Number, Math, JSON, TextEncoder, TextDecoder, URL, BigInt, ReadableStream, MessageChannel, EventTarget, Blob,
      SyntaxError, TypeError, RangeError // one realm for the shared Uint8Array polyfills across runs
    })
    try { vm.runInContext(src, ctx) } catch (_) { /* the import step needs a real browser */ }
    return { boot: window.__mwBoot, registered, csp: metas.map((m) => m.attrs && m.attrs.content).filter(Boolean) }
  }
  const forced = run(true)
  assert.equal(forced.boot && forced.boot.forcedDegraded, true)
  assert.equal(forced.registered, 0, 'no register() in a forced limited session')
  assert.equal(forced.boot.cspKind, 'degraded')
  assert.match(forced.csp[0] || '', /script-src 'self' 'unsafe-inline' blob:/)
  const normal = run(false)
  assert.equal(normal.boot.forcedDegraded, false, JSON.stringify({ stage: normal.boot.stage, missing: normal.boot.missing }))
  assert.equal(normal.registered, 1, JSON.stringify({ stage: normal.boot.stage, missing: normal.boot.missing }))
})

// ---- the site's own viewport (code review round 1, F19) --------------------------------------------

function fakeHeadDoc (metas = []) {
  const head = {
    children: [],
    appendChild (el) { el.parentNode = head; head.children.push(el); return el },
    removeChild (el) { head.children.splice(head.children.indexOf(el), 1); el.parentNode = null; return el },
    querySelector (sel) {
      if (!/^meta\[name="viewport"( i)?\]$/.test(sel)) throw new Error('unexpected selector ' + sel)
      const ci = / i\]$/.test(sel)
      return head.children.find((el) => el.tag === 'meta' && (ci ? String(el.attrs.name).toLowerCase() : el.attrs.name) === 'viewport') || null
    }
  }
  const doc = {
    head,
    createElement (tag) { return { tag, attrs: {}, parentNode: null, setAttribute (k, v) { this.attrs[k] = String(v) }, getAttribute (k) { return k in this.attrs ? this.attrs[k] : null } } },
    querySelector: (sel) => head.querySelector(sel)
  }
  for (const m of metas) { const el = doc.createElement('meta'); el.attrs = Object.assign({}, m); head.appendChild(el) }
  return doc
}

const SHELL_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content'

test('code review round 1: the shell takes the site\'s viewport after each load (none, a fixed width, device-width) and restores its own', () => {
  const shell = fakeHeadDoc([{ name: 'viewport', content: SHELL_VIEWPORT }])
  const own = shell.head.querySelector('meta[name="viewport"]').getAttribute('content')
  // A site without a viewport meta: the phone engines' default, stated (removing the meta does not reset Chromium).
  assert.equal(syncViewport(shell, fakeHeadDoc([])), 'width=980')
  assert.equal(shell.head.querySelector('meta[name="viewport"]').getAttribute('content'), 'width=980')
  // A fixed-width site keeps its width; neither cover nor interactive-widget are added.
  assert.equal(syncViewport(shell, fakeHeadDoc([{ name: 'viewport', content: 'width=1024' }])), 'width=1024')
  assert.equal(shell.head.querySelector('meta[name="viewport"]').getAttribute('content'), 'width=1024')
  // device-width with the site's own options (the attribute name in any case).
  assert.equal(syncViewport(shell, fakeHeadDoc([{ name: 'Viewport', content: ' width=device-width, initial-scale=1, viewport-fit=cover ' }])), 'width=device-width, initial-scale=1, viewport-fit=cover')
  assert.equal(shell.head.children.filter((el) => el.tag === 'meta').length, 1, 'one meta, updated in place')
  // An empty content attribute counts as none.
  assert.equal(syncViewport(shell, fakeHeadDoc([{ name: 'viewport', content: '' }])), 'width=980')
  // Back to the loader's own screens.
  restoreViewport(shell, own)
  assert.equal(shell.head.querySelector('meta[name="viewport"]').getAttribute('content'), SHELL_VIEWPORT)
  assert.equal(syncViewport(shell, null), 'width=980', 'no readable frame document: as for a site without one')
})
