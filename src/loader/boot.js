/* src/loader/boot.js: CLASSIC script, ES2017-safe syntax (written as ES5 so it parses everywhere).
   It runs before anything else on the shell page and implements ARCHITECTURE §5.1 in this order:
     (1) secure context, (2) top !== window, (3) root deployment, (4) hard and soft feature checks,
     (5) guarded polyfills + self-tests, (6) CSP <meta> (normal, degraded or dev), (7) loader import.
   The polyfills exist because the vendored webtorrent bundle (through uint8-util@2.3.2) calls
   Uint8Array.prototype.toHex/toBase64 and Uint8Array.fromHex/fromBase64 without guards, and its
   web-seed fetches use AbortSignal.timeout (DESIGN-REVIEW items 14 and 16).
   Dynamic import is never written literally (a parse error in old engines): the importer is built
   with new Function before the CSP meta exists; if that is impossible a module <script> is used and
   app.js starts itself (window.__mwBoot.autostart). User-facing texts: textContent only. The five
   texts shared with strings.js must stay identical (a unit test compares them). */
(function (window, document) {
  'use strict'

  if (!window || !document || window.__mwBoot) return

  var LOADER_URL = '/_mw/loader.js'
  var BOOT_PATH = '/_mw/boot.js'
  var SW_URL = '/mw-sw.js'
  var SW_PROBE_MS = 3000
  // Code review round 1: set by the loader (render.js requestDegradedReload) when it decides to use limited
  // mode after this script fixed the normal CSP (ready() timeout, a late register() failure, storage full):
  // the page reloads once and this tab session then starts degraded, with the degraded CSP.
  var DEGRADED_KEY = 'mw:degraded'

  var STR = {
    insecure: 'This page must be served over HTTPS (or localhost)',
    framed: 'Open this page directly',
    lockdown: 'Turn off Lockdown Mode for this website',
    hostOnlyBadge: 'Host only, not sharing',
    preparingEngine: 'Preparing offline engine...',
    nonRoot: 'This loader must be served from the root of its domain, because /mw-sw.js needs the origin root.',
    insecureDetail: 'Open the https:// address of this site. Browsers allow the offline engine and the cryptography the loader needs only on secure pages.',
    framedDetail: 'This site was embedded in another page. Open it in its own tab.',
    unsupportedTitle: 'This browser cannot open this site',
    unsupportedIntro: 'It lacks features the loader needs:',
    floor: 'Use Safari or iOS 15.4, Chrome, Edge, Samsung Internet or Brave based on Chromium 110, or Firefox 115, or newer.',
    starting: 'Starting...',
    stillStarting: 'Still starting... (slow connection?)',
    loadFailedTitle: 'The loader could not start',
    loadFailed: '/_mw/loader.js did not load (network error, content blocker or integrity check). Check the connection and reload.',
    reload: 'Reload'
  }

  var boot = window.__mwBoot = {
    ok: false,
    stage: 'boot',
    started: false,
    imported: false,
    autostart: false,
    degraded: false,
    dev: false,
    csp: null,
    features: {},
    soft: {},
    missing: [],
    polyfilled: [],
    t0: Date.now(),
    swProbe: null,
    cspFor: cspFor,
    strings: STR
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering (textContent only)
  // ---------------------------------------------------------------------------------------------

  function el (tag, text, className) {
    var node = document.createElement(tag)
    if (text !== undefined && text !== null) node.textContent = String(text)
    if (className) node.className = className
    return node
  }

  function host () {
    var root = document.getElementById('mw-root') || document.body
    while (root && root.firstChild) root.removeChild(root.firstChild)
    return root
  }

  function stop (title, lines, list) {
    boot.ok = false
    boot.stage = 'stopped'
    var root = host()
    if (!root) return
    var box = el('div', null, 'mw-boot-error')
    box.setAttribute('role', 'alert')
    box.appendChild(el('h1', title))
    var i
    for (i = 0; lines && i < lines.length; i++) box.appendChild(el('p', lines[i]))
    if (list && list.length) {
      var ul = document.createElement('ul')
      for (i = 0; i < list.length; i++) ul.appendChild(el('li', list[i]))
      box.appendChild(ul)
    }
    root.appendChild(box)
  }

  function status (text) {
    var line = document.getElementById('mw-boot')
    if (line) line.textContent = text
  }

  // ---------------------------------------------------------------------------------------------
  // (1) secure context, (2) framing, (3) root deployment
  // ---------------------------------------------------------------------------------------------

  var loc = window.location || {}
  var hostname = String(loc.hostname || '').toLowerCase()
  var loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' ||
    /\.localhost$/.test(hostname)

  var secure = window.isSecureContext
  if (secure === undefined) secure = loc.protocol === 'https:' || loopback
  if (!secure) {
    stop(STR.insecure, [STR.insecureDetail])
    return
  }

  var framed
  try { framed = window.top !== window } catch (e) { framed = true }
  if (framed) {
    stop(STR.framed, [STR.framedDetail])
    return
  }

  var current = document.currentScript
  if (current && current.src) {
    var scriptPath = ''
    try { scriptPath = new URL(current.src, loc.href).pathname } catch (e) { scriptPath = BOOT_PATH }
    if (scriptPath !== BOOT_PATH) {
      stop(STR.nonRoot, ['Loaded from ' + scriptPath + ' instead of ' + BOOT_PATH + '.'])
      return
    }
  }

  // ---------------------------------------------------------------------------------------------
  // (4) feature checks
  // ---------------------------------------------------------------------------------------------

  function has (fn) { try { return !!fn() } catch (e) { return false } }

  // Built before the CSP meta exists, so 'unsafe-eval' is never needed later.
  var importer = null
  var dynamicImport = 'unknown'
  try {
    importer = new Function('u', 'return import(u)') // eslint-disable-line no-new-func
    dynamicImport = 'yes'
  } catch (e) {
    importer = null
    dynamicImport = e && e.name === 'SyntaxError' ? 'no' : 'unknown' // EvalError: a host CSP forbids eval
  }
  var bigint = has(function () { return typeof BigInt === 'function' && typeof BigInt(1) === 'bigint' })
  if (dynamicImport === 'unknown') {
    // Every engine with BigInt also has import() (Chrome 67 > 63, Firefox 68 > 67, Safari 14 > 11.1).
    dynamicImport = bigint && has(function () { return 'noModule' in document.createElement('script') }) ? 'yes' : 'no'
  }

  var HARD = [
    { id: 'dynamicImport', label: 'dynamic import()', since: 'Chrome 63, Firefox 67, Safari 11.1', ok: dynamicImport === 'yes' },
    { id: 'promise', label: 'Promise', since: 'Chrome 32, Firefox 29, Safari 8', ok: has(function () { return typeof Promise === 'function' && typeof Promise.prototype.then === 'function' }) },
    { id: 'indexedDB', label: 'IndexedDB', since: 'Chrome 24, Firefox 16, Safari 10', ok: has(function () { return !!window.indexedDB }) },
    { id: 'cryptoSubtle', label: 'Web Crypto (crypto.subtle), HTTPS only', since: 'Chrome 37, Firefox 34, Safari 11', ok: has(function () { return !!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') }) },
    { id: 'bigint', label: 'BigInt', since: 'Chrome 67, Firefox 68, Safari 14', ok: bigint },
    { id: 'textEncoder', label: 'TextEncoder and TextDecoder', since: 'Chrome 38, Firefox 19, Safari 10.1', ok: has(function () { return typeof TextEncoder === 'function' && typeof TextDecoder === 'function' }) },
    { id: 'readableStream', label: 'ReadableStream', since: 'Chrome 43, Firefox 65, Safari 10.1', ok: has(function () { return typeof ReadableStream === 'function' }) },
    { id: 'fetch', label: 'fetch()', since: 'Chrome 42, Firefox 39, Safari 10.1', ok: has(function () { return typeof window.fetch === 'function' }) },
    { id: 'abortController', label: 'AbortController', since: 'Chrome 66, Firefox 57, Safari 12.1', ok: has(function () { return typeof AbortController === 'function' && typeof AbortSignal === 'function' }) },
    { id: 'messageChannel', label: 'MessageChannel', since: 'Chrome 4, Firefox 41, Safari 5', ok: has(function () { return typeof MessageChannel === 'function' }) },
    { id: 'eventTarget', label: 'EventTarget constructor', since: 'Chrome 64, Firefox 59, Safari 14', ok: has(function () { return new EventTarget() instanceof EventTarget }) },
    { id: 'blobArrayBuffer', label: 'Blob.arrayBuffer()', since: 'Chrome 76, Firefox 69, Safari 14', ok: has(function () { return typeof Blob === 'function' && typeof Blob.prototype.arrayBuffer === 'function' }) }
  ]

  var i
  for (i = 0; i < HARD.length; i++) {
    boot.features[HARD[i].id] = HARD[i].ok
    if (!HARD[i].ok) boot.missing.push(HARD[i])
  }

  var nav = window.navigator || {}
  var ua = String(nav.userAgent || '')
  var hasRtc = has(function () { return typeof window.RTCPeerConnection === 'function' })
  var hasSw = has(function () { return 'serviceWorker' in nav && !!nav.serviceWorker })
  var webkitOnly = /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua)
  // Lockdown Mode removes WebAssembly and, with it, Service Workers and WebRTC data channels.
  var lockdown = webkitOnly && typeof window.WebAssembly !== 'object' && (!hasRtc || !hasSw)
  boot.soft = { webrtc: hasRtc, serviceWorker: hasSw, lockdown: lockdown }
  boot.features.webrtc = hasRtc
  boot.features.serviceWorker = hasSw

  // ---------------------------------------------------------------------------------------------
  // (5) polyfills, guarded, then self-tested
  // ---------------------------------------------------------------------------------------------

  var HEX = '0123456789abcdef'
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

  function isUint8Array (value) {
    return Object.prototype.toString.call(value) === '[object Uint8Array]'
  }

  function optionsObject (options) {
    if (options === undefined) return {}
    if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
      throw new TypeError('options must be an object')
    }
    return options
  }

  function alphabetOf (opts) {
    var alphabet = opts.alphabet
    if (alphabet === undefined) return 'base64'
    if (alphabet !== 'base64' && alphabet !== 'base64url') throw new TypeError('alphabet must be "base64" or "base64url"')
    return alphabet
  }

  function hexValue (code) {
    if (code >= 48 && code <= 57) return code - 48
    if (code >= 97 && code <= 102) return code - 87
    if (code >= 65 && code <= 70) return code - 55
    return -1
  }

  function toHex () {
    if (!isUint8Array(this)) throw new TypeError('Uint8Array.prototype.toHex called on an incompatible receiver')
    var out = ''
    for (var k = 0; k < this.length; k++) out += HEX.charAt(this[k] >> 4) + HEX.charAt(this[k] & 15)
    return out
  }

  function fromHex (string) {
    if (typeof string !== 'string') throw new TypeError('Uint8Array.fromHex expects a string')
    if (string.length % 2 !== 0) throw new SyntaxError('Uint8Array.fromHex: odd number of hex digits')
    var out = new Uint8Array(string.length / 2)
    for (var k = 0; k < out.length; k++) {
      var hi = hexValue(string.charCodeAt(2 * k))
      var lo = hexValue(string.charCodeAt(2 * k + 1))
      if (hi < 0 || lo < 0) throw new SyntaxError('Uint8Array.fromHex: invalid hex digit')
      out[k] = hi * 16 + lo
    }
    return out
  }

  function toBase64 (options) {
    if (!isUint8Array(this)) throw new TypeError('Uint8Array.prototype.toBase64 called on an incompatible receiver')
    var opts = optionsObject(options)
    var table = alphabetOf(opts) === 'base64url' ? B64URL : B64
    var omitPadding = !!opts.omitPadding
    var out = ''
    var n = this.length
    var k = 0
    var x
    for (; k + 2 < n; k += 3) {
      x = (this[k] << 16) | (this[k + 1] << 8) | this[k + 2]
      out += table.charAt((x >> 18) & 63) + table.charAt((x >> 12) & 63) + table.charAt((x >> 6) & 63) + table.charAt(x & 63)
    }
    if (n - k === 1) {
      x = this[k] << 16
      out += table.charAt((x >> 18) & 63) + table.charAt((x >> 12) & 63) + (omitPadding ? '' : '==')
    } else if (n - k === 2) {
      x = (this[k] << 16) | (this[k + 1] << 8)
      out += table.charAt((x >> 18) & 63) + table.charAt((x >> 12) & 63) + table.charAt((x >> 6) & 63) + (omitPadding ? '' : '=')
    }
    return out
  }

  function isAsciiWhitespace (code) {
    return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
  }

  // DecodeBase64Chunk from the TC39 proposal: a 2- or 3-character final chunk may carry extra bits,
  // which only the 'strict' mode rejects.
  function decodeChunk (chunk, throwOnExtraBits, bytes) {
    var len = chunk.length
    var x = (chunk[0] << 18) | (chunk[1] << 12) | ((len > 2 ? chunk[2] : 0) << 6) | (len > 3 ? chunk[3] : 0)
    var b0 = (x >> 16) & 255
    var b1 = (x >> 8) & 255
    var b2 = x & 255
    if (len === 2) {
      if (throwOnExtraBits && b1 !== 0) throw new SyntaxError('Uint8Array.fromBase64: extra bits in the last chunk')
      bytes.push(b0)
    } else if (len === 3) {
      if (throwOnExtraBits && b2 !== 0) throw new SyntaxError('Uint8Array.fromBase64: extra bits in the last chunk')
      bytes.push(b0, b1)
    } else {
      bytes.push(b0, b1, b2)
    }
  }

  function decodeBase64 (string, alphabet, lastChunkHandling) {
    var bytes = []
    var chunk = []
    var index = 0
    var length = string.length
    for (;;) {
      while (index < length && isAsciiWhitespace(string.charCodeAt(index))) index++
      if (index === length) {
        if (chunk.length > 0) {
          if (lastChunkHandling === 'stop-before-partial') return bytes
          if (lastChunkHandling !== 'loose' || chunk.length === 1) throw new SyntaxError('Uint8Array.fromBase64: incomplete last chunk')
          decodeChunk(chunk, false, bytes)
        }
        return bytes
      }
      var ch = string.charAt(index)
      index++
      if (ch === '=') {
        if (chunk.length < 2) throw new SyntaxError('Uint8Array.fromBase64: unexpected padding')
        while (index < length && isAsciiWhitespace(string.charCodeAt(index))) index++
        if (chunk.length === 2) {
          if (index === length) {
            if (lastChunkHandling === 'stop-before-partial') return bytes
            throw new SyntaxError('Uint8Array.fromBase64: incomplete padding')
          }
          if (string.charAt(index) === '=') {
            index++
            while (index < length && isAsciiWhitespace(string.charCodeAt(index))) index++
          }
        }
        if (index < length) throw new SyntaxError('Uint8Array.fromBase64: data after padding')
        decodeChunk(chunk, lastChunkHandling === 'strict', bytes)
        return bytes
      }
      if (alphabet === 'base64url') {
        if (ch === '+' || ch === '/') throw new SyntaxError('Uint8Array.fromBase64: invalid base64url character')
        if (ch === '-') ch = '+'
        else if (ch === '_') ch = '/'
      }
      var value = B64.indexOf(ch)
      if (value < 0) throw new SyntaxError('Uint8Array.fromBase64: invalid character')
      chunk.push(value)
      if (chunk.length === 4) {
        decodeChunk(chunk, false, bytes)
        chunk = []
      }
    }
  }

  function fromBase64 (string, options) {
    if (typeof string !== 'string') throw new TypeError('Uint8Array.fromBase64 expects a string')
    var opts = optionsObject(options)
    var alphabet = alphabetOf(opts)
    var last = opts.lastChunkHandling
    if (last === undefined) last = 'loose'
    if (last !== 'loose' && last !== 'strict' && last !== 'stop-before-partial') {
      throw new TypeError('lastChunkHandling must be "loose", "strict" or "stop-before-partial"')
    }
    return new Uint8Array(decodeBase64(string, alphabet, last))
  }

  function timeout (ms) {
    if (typeof ms !== 'number' || !(ms >= 0) || ms === Infinity) throw new TypeError('AbortSignal.timeout expects a non-negative finite number')
    var controller = new AbortController()
    setTimeout(function () {
      var reason
      try { reason = new DOMException('The operation timed out.', 'TimeoutError') } catch (e) {
        reason = new Error('The operation timed out.')
        reason.name = 'TimeoutError'
      }
      try { controller.abort(reason) } catch (e) { controller.abort() }
    }, ms)
    return controller.signal
  }

  function define (target, name, fn) {
    if (!target || typeof target[name] === 'function') return
    try {
      Object.defineProperty(target, name, { value: fn, writable: true, configurable: true, enumerable: false })
      boot.polyfilled.push(name)
    } catch (e) { /* frozen intrinsic: the self-test reports it */ }
  }

  define(Uint8Array.prototype, 'toHex', toHex)
  define(Uint8Array.prototype, 'toBase64', toBase64)
  define(Uint8Array, 'fromHex', fromHex)
  define(Uint8Array, 'fromBase64', fromBase64)
  if (typeof AbortSignal === 'function' && typeof AbortController === 'function') define(AbortSignal, 'timeout', timeout)

  function sameBytes (a, b) {
    if (!a || !b || a.length !== b.length) return false
    for (var k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
    return true
  }

  function throwsSyntaxError (fn) {
    try { fn() } catch (e) { return e instanceof SyntaxError }
    return false
  }

  // Runs on whatever implementation is present (native or ours).
  function selfTest () {
    var failed = []
    try {
      var bytes = new Uint8Array([0, 1, 127, 128, 254, 255])
      if (bytes.toHex() !== '00017f80feff') failed.push('toHex')
      if (!sameBytes(Uint8Array.fromHex('00017F80feff'), bytes)) failed.push('fromHex')
      if (!throwsSyntaxError(function () { Uint8Array.fromHex('abc') })) failed.push('fromHex odd length')
      if (!throwsSyntaxError(function () { Uint8Array.fromHex('zz') })) failed.push('fromHex non-hex')
      var b = new Uint8Array([251, 255])
      if (b.toBase64() !== '+/8=') failed.push('toBase64')
      if (b.toBase64({ alphabet: 'base64url' }) !== '-_8=') failed.push('toBase64 base64url')
      if (b.toBase64({ alphabet: 'base64url', omitPadding: true }) !== '-_8') failed.push('toBase64 omitPadding')
      if (!sameBytes(Uint8Array.fromBase64('+/8='), b)) failed.push('fromBase64')
      if (!sameBytes(Uint8Array.fromBase64('-_8', { alphabet: 'base64url' }), b)) failed.push('fromBase64 base64url')
      if (!throwsSyntaxError(function () { Uint8Array.fromBase64('-_8=') })) failed.push('fromBase64 alphabet')
      if (!throwsSyntaxError(function () { Uint8Array.fromBase64('Zg=') })) failed.push('fromBase64 padding')
      var signal = AbortSignal.timeout(60000)
      if (!signal || signal.aborted !== false) failed.push('AbortSignal.timeout')
    } catch (e) {
      failed.push('exception: ' + (e && e.message))
    }
    return failed
  }

  if (!boot.missing.length) {
    var failures = selfTest()
    boot.selfTest = failures
    if (failures.length) {
      boot.missing.push({ id: 'uint8Base64', label: 'Uint8Array hex and base64 conversions, AbortSignal.timeout (self-test failed: ' + failures.join(', ') + ')', since: 'Chrome 140, Firefox 133, Safari 18.2 have them built in', ok: false })
    }
  }

  if (boot.missing.length) {
    var lines = []
    for (i = 0; i < boot.missing.length; i++) lines.push(boot.missing[i].label + ': first supported in ' + boot.missing[i].since)
    stop(STR.unsupportedTitle, [STR.unsupportedIntro], lines)
    var tail = document.getElementById('mw-root') || document.body
    if (tail) tail.appendChild(el('p', STR.floor))
    return
  }

  // ---------------------------------------------------------------------------------------------
  // (6) CSP meta (ARCHITECTURE §13, §7.4). render.js cspString() builds the same strings.
  // ---------------------------------------------------------------------------------------------

  function cspFor (kind, dev, lanHost) {
    var degraded = kind === 'degraded'
    var connect = ["'self'", 'https:', 'wss:']
    if (degraded) connect.push('blob:')
    if (dev) {
      // v0.3 final integration: http://127.0.0.1:* and http://localhost:* too: the web seed of a loopback subdomain hub
      // lives on the hub root (http://localhost:<port>/ws/), another origin than <label>.localhost:<port>.
      connect.push('ws://127.0.0.1:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'http://localhost:*')
      if (lanHost) connect.push('wss://' + lanHost + ':*')
    }
    // Code review round 1: limited mode loads a site's third-party subresources too (render.js cspString).
    var remote = degraded ? (dev ? ['https:', 'http://127.0.0.1:*', 'http://localhost:*'] : ['https:']) : []
    var list = [
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
      // Degraded mode injects <base> into the srcdoc document, which inherits this policy.
      ['base-uri', [degraded ? "'self'" : "'none'"]],
      ['form-action', ["'none'"]]
    )
    var parts = []
    for (var k = 0; k < list.length; k++) parts.push(list[k][0] + ' ' + list[k][1].join(' '))
    return parts.join('; ')
  }

  function metaContent (name) {
    var m = document.querySelector('meta[name="' + name + '"]')
    return m ? String(m.getAttribute('content') || '').trim() : ''
  }

  var devMeta = metaContent('mw-dev')
  boot.dev = loopback || devMeta === '1' || devMeta === 'true'
  var lanHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !loopback ? hostname : null

  function insertCsp () {
    boot.cspKind = boot.degraded ? 'degraded' : 'normal'
    var policy = cspFor(boot.cspKind, boot.dev, lanHost)
    var meta = document.createElement('meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', policy)
    var head = document.head || document.getElementsByTagName('head')[0]
    if (head) head.insertBefore(meta, head.firstChild)
    boot.csp = policy
  }

  // ---------------------------------------------------------------------------------------------
  // (7) loader import
  // ---------------------------------------------------------------------------------------------

  function loadFailed () {
    stop(STR.loadFailedTitle, [STR.loadFailed])
    var root = document.getElementById('mw-root') || document.body
    if (!root) return
    var btn = el('button', STR.reload, 'mw-btn mw-primary')
    btn.type = 'button'
    btn.addEventListener('click', function () { window.location.reload() })
    root.appendChild(btn)
  }

  function moduleScriptFallback () {
    boot.autostart = true // app.js calls start() itself when it sees this flag
    boot.stage = 'module-script'
    var script = document.createElement('script')
    script.type = 'module'
    script.src = LOADER_URL
    var preload = document.querySelector('link[rel="modulepreload"][href="' + LOADER_URL + '"]')
    if (preload && preload.getAttribute('integrity')) {
      script.integrity = preload.getAttribute('integrity')
      script.crossOrigin = 'anonymous'
    }
    script.addEventListener('error', loadFailed)
    var head = document.head || document.getElementsByTagName('head')[0] || document.body
    head.appendChild(script)
  }

  function startLoader () {
    boot.ok = true
    boot.stage = 'import'
    status(boot.degraded ? STR.starting : STR.preparingEngine)
    var pending = null
    if (importer) {
      // v0.3 C2 doors: an absolute URL. Chromium can reuse the compiled importer of another loader origin of the same site in one
      // renderer (two doors on one host name with other ports, or sibling subdomains), and a relative specifier then resolved
      // against that origin (seen with two doors on 127.0.0.1: door B imported door A's loader.js, the module-script fallback saved it).
      var loaderHref = LOADER_URL
      try { loaderHref = new URL(LOADER_URL, document.baseURI || loc.href).href } catch (e) { loaderHref = LOADER_URL }
      try { pending = importer(loaderHref) } catch (e) { pending = null }
    }
    if (!pending || typeof pending.then !== 'function') {
      moduleScriptFallback()
    } else {
      pending.then(function (mod) {
        boot.imported = true
        var start = mod && (typeof mod.default === 'function' ? mod.default : mod.start)
        if (typeof start !== 'function') throw new Error('loader.js has no start()')
        return start()
      }).then(null, function (err) {
        if (boot.imported) {
          if (window.console) window.console.error('[mw] loader start failed', err)
          return
        }
        if (window.console) window.console.warn('[mw] import() failed, retrying with a module script', err)
        moduleScriptFallback()
      })
    }
    setTimeout(function () {
      if (!boot.started && boot.stage !== 'stopped') status(STR.stillStarting)
    }, 10000)
  }

  // degraded = no Service Worker, or register() rejects. register() is started here (and reused by
  // render.js) so a rejection is known before the CSP is fixed: a meta CSP cannot be relaxed later.
  var forced = false
  try { forced = !!(window.sessionStorage && window.sessionStorage.getItem(DEGRADED_KEY)) } catch (e) { forced = false }
  boot.forcedDegraded = forced
  boot.degraded = !hasSw || forced
  if (hasSw && !forced) {
    var probeDone = false
    var finish = function () {
      if (probeDone) return
      probeDone = true
      insertCsp()
      startLoader()
    }
    boot.swProbe = new Promise(function (resolve) {
      var registration
      try {
        registration = nav.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' })
      } catch (e) {
        registration = Promise.reject(e)
      }
      registration.then(function (reg) {
        // A browser always resolves with a ServiceWorkerRegistration. Nothing at all means the
        // environment blocked registration without rejecting (Playwright's serviceWorkers: 'block'
        // does this): degrade now, while the CSP can still be the degraded one.
        if (!reg || typeof reg !== 'object') {
          boot.degraded = !probeDone
          resolve({ ok: false, registration: null, error: 'register() gave no registration' })
          return
        }
        resolve({ ok: true, registration: reg, error: null })
      }, function (err) {
        boot.degraded = !probeDone
        resolve({ ok: false, registration: null, error: (err && err.message) || String(err) })
      })
    })
    boot.swProbe.then(finish, finish)
    setTimeout(finish, SW_PROBE_MS)
  } else {
    insertCsp()
    startLoader()
  }
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null)
