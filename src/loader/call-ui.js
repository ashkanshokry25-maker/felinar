// src/loader/call-ui.js: the loader-owned call panel (v0.3 C2, lane wire-ui; research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md
// "SZ" 3.5 "UI", "Flow and IP exposure" and "Platform handling"; INTERFACES "v0.3 C2", call-ui.js).
//
//   const ui = createCallUi({ win, doc, lang, cssHref })
//   ui.attach(callService)            the calls service of src/calls/service.js (lane calls): its events drive the panel
//   ui.prompt(kind, data)             the cards the service asks for through deps.prompt: 'call.start', 'call.incoming',
//                                     'call.group', 'call.metered', 'call.screen' -> true | false | 'audio' | 'video' | 'decline'
//   ui.inspect() / ui.rectOf(label)   read-only diagnostics for tests and support (geometry and state, never media)
//   ui.destroy()
//
// What it shows, every text from CALL_TEXT of src/loader/strings.js (lane docs-strings; generic button words from UI_TEXT):
// - the incoming card: the caller's name and short id, what accepting shows ("Accepting shows your IP address to {name}"),
//   [Accept with audio] [Accept with video] [Decline]; for a group, the names of everyone in the call. A ring flashes the
//   tab title (call.ringTitle), runs navigator.vibrate where it exists, and plays a ring tone only where the page may
//   play sound (the browser's autoplay policy, [CRA]); it never takes the keyboard focus from the page;
// - the cards before a call starts (call.start with call.startRelay when a relay exists, call.group, call.metered,
//   call.screen): nothing leaves the device before the person's click on them;
// - the panel of a call: the people in it, each ringing, connecting, direct, "Relayed by {operator}", reconnecting or
//   left; notices (mobile data, iPhone and Android limits, a camera the browser paused, video paused on a slow
//   connection); Mute, Camera, Share screen (only where the browser has getDisplayMedia) and Hang up; the end of the call
//   (declined, busy, not connected, no direct path, ended with its duration).
//
// It lives in the loader's own document, over the site frame, so it survives the site's navigations in shell mode, in a
// CLOSED shadow root styled by /_mw/ui.css (the .mw-call rules). Every decision acts only on the person's own input
// (isTrusted), and the buttons that show the person's IP address or start capture also pass the redress checks of
// src/widget/redress.js (MF-06; speed bumps, not a lock). The service is called inside the click handler, so capture
// (getUserMedia in src/calls/session.js, getDisplayMedia after the call.screen card) runs in the person's gesture.
// This module itself never calls getUserMedia, getDisplayMedia or a Wake Lock (SZ 3.1.9, test/unit/lint-contrib.test.mjs);
// its one sound is the ring tone. It hands no MediaStream to the site: the media elements are in the closed root.
//
// Every browser global comes in through createCallUi's options or is looked up lazily, so Node 22 runs it with the
// fake DOM of the unit tests (test/unit/call-ui.test.mjs).

import { callText, uiText, errorText, pickLang } from './strings.js'
import { createGuard } from '../widget/redress.js'
import { shortKey } from '../chain/crypto.js'

/** The card kinds src/calls/service.js asks for (limits.js CALL_CARDS). */
export const CALL_UI_KINDS = Object.freeze(['call.start', 'call.incoming', 'call.group', 'call.metered', 'call.screen'])

/** Participant states the panel names (src/calls/limits.js PEER_STATES). */
export const PANEL_PEER_STATES = Object.freeze(['ringing', 'connecting', 'direct', 'relayed', 'reconnecting', 'left'])

const CTX = Object.freeze({ activation: true, tab: 'leader' })
const RING_FLASH_MS = 1000
const RING_REPEAT_MS = 3000
const END_SHOW_MS = 6000
const MAX_QUEUE = 4

function globalWin () { return typeof window !== 'undefined' ? window : null }

/** callName(name, pub) -> the contact's name, else the short id of the key ('?' when neither is known). */
export function callName (name, pub) {
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 48)
  return typeof pub === 'string' && pub ? shortKey(pub) : '?'
}

/** durationText(ms) -> '0:42', '2:35', '1:02:03' (the {duration} of call.ended). */
export function durationText (ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (x) => (x < 10 ? '0' : '') + x
  return h > 0 ? h + ':' + two(m) + ':' + two(sec) : m + ':' + two(sec)
}

/**
 * maySound(nav) -> true when the page may start sound now: the browser's own autoplay answer where it has one
 * (navigator.getAutoplayPolicy), else sticky user activation (the person has interacted with the page). [CRA]
 */
export function maySound (nav) {
  try {
    if (nav && typeof nav.getAutoplayPolicy === 'function') return nav.getAutoplayPolicy('audiocontext') === 'allowed'
  } catch (_) { /* fall through */ }
  try {
    const ua = nav && nav.userActivation // lint-floor-ignore: optional, read only when the browser has it
    return !!(ua && ua.hasBeenActive === true)
  } catch (_) { return false }
}

/** canShareScreen(mediaDevices) -> true when the browser has getDisplayMedia (feature detection by typeof only). */
export function canShareScreen (md) {
  return !!(md && typeof md.getDisplayMedia === 'function')
}

/** peerStateText(p, operator, lang) -> 'Ringing', 'Direct', 'Relayed by Example', ... for one participant. */
export function peerStateText (p, operator, lang = 'en') {
  const st = p && typeof p.state === 'string' ? p.state : 'connecting'
  if (st === 'relayed' || (p && p.path === 'relayed' && st !== 'left')) return callText('call.state.relayed', lang, { operator: operator || '?' })
  if (st === 'direct' || (p && p.path === 'direct' && st !== 'left')) return callText('call.state.direct', lang)
  if (PANEL_PEER_STATES.indexOf(st) >= 0) return callText('call.state.' + st, lang)
  return callText('call.state.connecting', lang)
}

/**
 * endText({ reason, code, duration, connected, name }, lang) -> the sentence a call ends with (SZ 3.5 "UI" table):
 * declined, busy, not here, no direct path, nobody answered, the connection could not be checked, or "Call ended (2:35)".
 */
export function endText (e, lang = 'en') {
  const x = e || {}
  const name = x.name || '?'
  switch (x.reason) {
    case 'declined': return callText('call.declined', lang, { name })
    case 'busy': return callText('call.busy', lang, { name })
    case 'unreachable': return callText('call.notHere', lang, { name })
    case 'no-answer': return errorText('E_NO_ANSWER', lang)
    case 'fingerprint': return errorText('E_CALL_FAILED', lang)
    case 'failed': return x.connected ? errorText('E_CALL_FAILED', lang) : callText('call.noPath', lang, { name })
    default: return callText('call.ended', lang, { duration: durationText(x.duration) })
  }
}

/**
 * noticesOf(state, lang, { phone }) -> the sentences the panel shows for a call state: mobile data (call.metered), the platform's
 * limits (call.ios, call.android), or on a phone before those notes ship (CALL_FLAGS.phoneNotes, state.platform null) the plain
 * "Keep this page open during the call." (call.keepOpen; code review v0.3, round 2), a camera the browser paused (call.paused),
 * video paused by the connection (call.videoPaused).
 */
export function noticesOf (st, lang = 'en', { phone = false } = {}) {
  const s = st || {}
  const out = []
  if (s.notice === 'metered') out.push(callText('call.metered', lang))
  if (s.platform === 'call.ios' || s.platform === 'call.android') out.push(callText(s.platform, lang))
  else if (phone) out.push(callText('call.keepOpen', lang))
  const paused = s.paused || {}
  if (paused.camera === true || paused.audio === true) out.push(callText('call.paused', lang))
  if (s.local && s.local.videoPaused === true) out.push(callText('call.videoPaused', lang))
  return out
}

/**
 * createCallUi(opts) -> { attach, prompt, inspect, rectOf, destroy }
 * opts: { win, doc, nav, lang, cssHref ('/_mw/ui.css'), now, setTimeout, clearTimeout, setInterval, clearInterval,
 *   MediaStream, AudioContext, strict (redress checks fail closed, default true), minVisibleMs (500), MutationObserverCtor,
 *   log(line), phone (boolean or () -> boolean: a phone, which shows call.keepOpen while the platform notes wait) }
 */
export function createCallUi (opts = {}) {
  const win = opts.win || globalWin()
  const doc = opts.doc || (win && win.document) || null
  if (!doc) throw new TypeError('createCallUi needs a document')
  const nav = opts.nav || (win && win.navigator) || null
  const lang = pickLang(opts.lang || (nav && nav.language) || 'en')
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h))
  const setI = opts.setInterval || ((fn, ms) => setInterval(fn, ms))
  const clearI = opts.clearInterval || ((h) => clearInterval(h))
  const MS = opts.MediaStream || (win && win.MediaStream) || null
  const AC = opts.AudioContext || (win && (win.AudioContext || win.webkitAudioContext)) || null
  const cssHref = typeof opts.cssHref === 'string' ? opts.cssHref : '/_mw/ui.css'
  const guardOpts = { strict: opts.strict !== false, now, minVisibleMs: opts.minVisibleMs === undefined ? 500 : opts.minVisibleMs, MutationObserverCtor: opts.MutationObserverCtor }
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const isPhone = () => { try { return typeof opts.phone === 'function' ? Boolean(opts.phone()) : opts.phone === true } catch (_) { return false } }
  const C = (key, params) => callText(key, lang, params)
  const U = (key, params) => uiText(key, lang, params)

  let service = null
  let offs = []
  let host = null
  let root = null
  let wrap = null
  let cardSlot = null
  let panelSlot = null
  let liveEl = null // polite announcements
  let alertEl = null // the ring
  let card = null // { kind, id, el, guards, resolve, bound: [resolve...], from }
  const queue = []
  const calls = new Map() // id -> { state, end, ring }
  let activeId = null
  let panel = null // { id, el, people, notices, status, tiles, controls: {...}, media: Map }
  let ring = null // { id, flash, vibrate, sound, ctx, title, stopAt }
  let endTimer = null
  let lastFocus = null
  let destroyed = false

  // ---- DOM ------------------------------------------------------------------------------------------------
  const make = (tag, cls, attrs, text) => {
    const n = doc.createElement(tag)
    if (cls) n.className = cls
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k])
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }
  const clear = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild) }
  // Set `hidden` only when it changes: a repeated write is still an attribute mutation, and the redress guard of an open
  // card (src/widget/redress.js) cancels the card on any style, class or hidden mutation under the host.
  const setHidden = (n, v) => { if (n && n.hidden !== !!v) n.hidden = !!v }

  // C2 integrator: the panel's stylesheet loads asynchronously into the closed root. A card shown before it applies moves
  // when it does, and its redress guard, which recorded the button's place at start(), then cancelled the card ('moved'):
  // the first call card of a page could never be confirmed (e2e E-CL-1). Guards of an open card take their place again
  // once the sheet has loaded (or failed), one frame later.
  let cssReady = !cssHref
  const cssWaiters = []
  function cssLoaded () {
    if (cssReady) return
    cssReady = true
    for (const fn of cssWaiters.splice(0)) { try { fn() } catch (_) { /* a closed card */ } }
  }
  function afterCss (fn) {
    let done = false
    const once = () => { if (!done) { done = true; fn() } }
    const frame = () => {
      const raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null
      if (raf) raf(() => once())
      else once()
    }
    if (cssReady) { frame(); return }
    cssWaiters.push(frame)
    // A cached sheet may apply without a second load event: the guards take their place again after a second at most.
    setT(frame, 1000)
  }

  /**
   * shellCssText() -> the rules of the shell's own copy of ui.css (already loaded by the shell page), or null. C2 integrator:
   * in Playwright WebKit 27.2 the panel's <link> never loaded inside the closed root on the shell page (link.sheet stayed
   * null, the panel showed unstyled and its buttons could not be confirmed, e2e E-CL-1W); a <style> with the same rules
   * applies at once in both engines (style-src allows inline styles in the shell policy), so nothing moves under a guard.
   */
  function shellCssText () {
    try {
      const base = (doc && doc.baseURI) || (win && win.location && win.location.href) || undefined
      const want = new URL(cssHref, base).href
      const sheets = doc && doc.styleSheets ? Array.from(doc.styleSheets) : []
      for (const sh of sheets) {
        if (!sh || sh.href !== want) continue
        let text = ''
        for (const r of Array.from(sh.cssRules || [])) text += r.cssText + '\n'
        return text || null
      }
    } catch (_) { /* a sheet this page may not read: the <link> below */ }
    return null
  }

  function ensureHost () {
    if (host) return
    host = make('div', null, { 'data-mw-call': '', 'data-nosnippet': '' })
    root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host
    const inline = cssHref ? shellCssText() : null
    if (inline) {
      root.appendChild(make('style', null, null, inline))
      cssReady = true
    } else if (cssHref) {
      const link = make('link', null, { rel: 'stylesheet', href: cssHref })
      if (typeof link.addEventListener === 'function') {
        link.addEventListener('load', cssLoaded)
        link.addEventListener('error', cssLoaded)
      }
      host.__mwLinked = true
      root.appendChild(link)
    }
    wrap = make('div', 'mw-call')
    liveEl = make('div', 'mw-call-live', { role: 'status', 'aria-live': 'polite' })
    alertEl = make('div', 'mw-call-live', { role: 'alert', 'aria-live': 'assertive' })
    cardSlot = make('div', 'mw-call-cards')
    panelSlot = make('div', 'mw-call-panels')
    wrap.appendChild(liveEl)
    wrap.appendChild(alertEl)
    wrap.appendChild(cardSlot)
    wrap.appendChild(panelSlot)
    root.appendChild(wrap)
  }
  function mount () {
    ensureHost()
    const parent = doc.body || doc.documentElement
    if (parent && !host.parentNode) {
      // C2 integrator: the host leaves the page when the panel is idle; on its way back the shadow root's stylesheet is
      // processed again (a new load event), so cards wait for it as on the first mount.
      if (cssHref && host.__mwMounted && host.__mwLinked) cssReady = false
      host.__mwMounted = true
      parent.appendChild(host)
    }
  }
  function unmountIfIdle () {
    if (host && host.parentNode && !card && !panel && !queue.length) host.parentNode.removeChild(host)
  }
  const announce = (text) => { if (liveEl) liveEl.textContent = String(text || '') }

  // A decision button: the person's own click only (isTrusted), and with guard: the redress checks (MF-06).
  function decisionButton (label, cls, onClick, guards, { guard = false, keys = null } = {}) {
    const b = make('button', 'mw-btn mw-call-btn' + (cls ? ' ' + cls : ''), { type: 'button' }, label)
    if (keys) b.setAttribute('aria-keyshortcuts', keys)
    let g = null
    if (guard && guards) {
      g = createGuard(Object.assign({ win, doc, getHost: () => host, button: b, onCancel: () => { if (card) setCardStatus(U('redressCancelled'), 'error') } }, guardOpts))
      guards.push(g)
    }
    b.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return // a script made this click
      if (g && !g.check()) return // too soon after it appeared, covered, moved or restyled
      onClick(ev)
    })
    return b
  }

  // ---- decision cards -------------------------------------------------------------------------------------
  let cardStatus = null
  function setCardStatus (text, kind) {
    if (!cardStatus) return
    cardStatus.textContent = String(text || '')
    cardStatus.setAttribute('data-kind', kind || 'info')
  }

  function closeCard (value) {
    const c = card
    if (!c) return
    card = null
    cardStatus = null
    for (const g of c.guards) { try { g.stop() } catch (_) { /* gone */ } }
    if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el)
    const all = c.bound.splice(0)
    if (c.resolve) all.unshift(c.resolve)
    for (const r of all) { try { r(value) } catch (_) { /* a resolver */ } }
    if (c.kind === 'call.incoming') stopRing(c.id)
    if (c.focusBack && lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus() } catch (_) { /* gone */ } }
    pump()
    unmountIfIdle()
  }

  function pump () {
    if (card || !queue.length) return
    const next = queue.shift()
    showCard(next)
  }

  // spec: { kind, id, title, sub, paras: [text], buttons: [{ label, cls, guard, run(value) }], escape, focus, assertive }
  function showCard (spec) {
    mount()
    const c = { kind: spec.kind, id: spec.id || null, el: null, guards: [], resolve: spec.resolve || null, bound: [], from: spec.from || 'prompt', focusBack: false }
    const name = spec.title || ((spec.paras || []).filter(Boolean)[0] || '').slice(0, 120) || C('call.ringTitle')
    const el = make('div', 'mw-call-card', { role: 'dialog', 'aria-label': name, 'data-mw-call-card': spec.kind })
    if (spec.title) el.appendChild(make('p', 'mw-call-title', null, spec.title))
    if (spec.sub) el.appendChild(make('p', 'mw-call-sub', null, spec.sub))
    for (const t of spec.paras || []) if (t) el.appendChild(make('p', 'mw-call-text', null, t))
    const row = make('div', 'mw-call-actions')
    let focusEl = null
    for (const b of spec.buttons) {
      const btn = decisionButton(b.label, b.cls, () => b.run(c), c.guards, { guard: b.guard === true })
      row.appendChild(btn)
      if (b.focus) focusEl = btn
    }
    el.appendChild(row)
    cardStatus = make('p', 'mw-call-status', { role: 'status', 'aria-live': 'polite' })
    el.appendChild(cardStatus)
    el.addEventListener('keydown', (ev) => {
      if (ev && ev.isTrusted === false) return
      if (ev && ev.key === 'Escape' && typeof spec.escape === 'function') spec.escape(c)
    })
    c.el = el
    card = c
    clear(cardSlot)
    cardSlot.appendChild(el)
    for (const g of c.guards) g.start()
    // C2 integrator: the guards take the button's place again once the panel's stylesheet has applied (see cssLoaded).
    if (!cssReady && c.guards.length) afterCss(() => { if (card === c) for (const g of c.guards) if (!g.cancelled) { g.stop(); g.start() } })
    if (spec.assertive) { if (alertEl) alertEl.textContent = spec.assertive } else if (spec.paras && spec.paras[0]) announce(spec.paras[0])
    // A card the person asked for (a click in the site) takes the focus on its safe button; a ring never takes it.
    if (spec.focus !== false && focusEl) {
      try { lastFocus = doc.activeElement || null; focusEl.focus(); c.focusBack = true } catch (_) { /* focus is a courtesy */ }
    }
    return c
  }

  function enqueue (spec) {
    if (!card) return showCard(spec)
    if (queue.length >= MAX_QUEUE) { if (spec.resolve) spec.resolve(false); return null }
    queue.push(spec)
    return null
  }

  // The incoming card. answer(choice) acts on the person's click: a pending prompt of the service (the site called
  // mw.calls.accept) gets the choice; otherwise this panel answers the call itself (service.answer / calls.decline).
  function incomingSpec (ring, { resolve = null, from = 'ring' } = {}) {
    const st = (calls.get(ring.id) || {}).state || null
    const group = !!(ring.group || (ring.roster && ring.roster.length))
    const name = callName(ring.name, ring.from)
    const kind = C(ring.kind === 'video' ? 'call.kind.video' : 'call.kind.audio')
    const names = [name].concat((ring.roster || []).map((p, i) => callName(ring.names && ring.names[i], p))).join(', ')
    const text = group ? C('call.group', { names }) : C('call.incoming', { name, kind })
    const paras = [text]
    const note = st && (st.platform === 'call.ios' || st.platform === 'call.android') ? C(st.platform) : (isPhone() ? C('call.keepOpen') : null)
    if (note) paras.push(note)
    const act = (choice) => (c) => answer(c, ring.id, choice)
    return {
      kind: 'call.incoming',
      id: ring.id,
      from,
      resolve,
      title: name,
      sub: shortKey(ring.from) || null,
      paras,
      assertive: from === 'ring' ? text : null,
      focus: from === 'prompt' ? undefined : false,
      escape: act('decline'),
      buttons: [
        { label: C('call.accept.audio'), cls: 'mw-call-accept', guard: true, run: act('audio') },
        { label: C('call.accept.video'), cls: 'mw-call-accept', guard: true, run: act('video') },
        { label: C('call.decline'), cls: 'mw-call-decline', focus: true, run: act('decline') }
      ]
    }
  }

  function answer (c, id, choice) {
    if (card !== c) return
    const waiting = c.bound.length > 0 || !!c.resolve
    if (waiting) { closeCard(choice); return } // the service's own accept (mw.calls.accept) continues with the choice
    closeCard(null)
    const svc = service
    if (!svc) return
    let p
    try {
      if (choice === 'decline') p = svc.methods['calls.decline']({ id }, CTX)
      else p = svc.answer(id, { video: choice === 'video' }) // inside the person's click: capture starts in it
    } catch (err) { p = Promise.reject(err) }
    Promise.resolve(p).then(null, (err) => showError(err))
  }

  function confirmSpec (kind, data, resolve) {
    const d = data && typeof data === 'object' ? data : {}
    const yes = (c) => { if (card === c) closeCard(true) }
    const no = (c) => { if (card === c) closeCard(false) }
    const relay = d.relay && d.relay.operator ? C('call.startRelay', { operator: d.relay.operator }) : null
    let paras = []
    let confirmLabel = U('continue')
    if (kind === 'call.start') {
      const name = callName(d.name, d.to)
      paras = [C('call.start', { name }), relay]
    } else if (kind === 'call.group') {
      const pubs = Array.isArray(d.to) ? d.to : []
      const named = Array.isArray(d.names) ? d.names : []
      paras = [C('call.group', { names: pubs.map((p, i) => callName(named[i], p)).join(', ') || '?' }), relay]
    } else if (kind === 'call.metered') {
      paras = [C('call.metered')]
    } else if (kind === 'call.screen') {
      paras = [C('call.screen')]
      confirmLabel = C('call.screen.start')
    }
    return {
      kind,
      id: d.id || null,
      resolve,
      paras: paras.filter(Boolean),
      escape: no,
      buttons: [
        { label: confirmLabel, cls: 'mw-call-confirm', guard: true, run: yes },
        { label: U('cancel'), cls: 'mw-call-cancel', focus: true, run: no }
      ]
    }
  }

  /** prompt(kind, data) -> the person's answer to a card the calls service asked for (deps.prompt). */
  function prompt (kind, data) {
    if (destroyed) return Promise.resolve(false)
    const d = data && typeof data === 'object' ? data : {}
    return new Promise((resolve) => {
      if (kind === 'call.incoming' || (kind === 'call.group' && d.role === 'callee')) {
        const id = d.id
        // The card of this ring is open: the person's click there answers this prompt too.
        if (card && card.kind === 'call.incoming' && card.id === id) { card.bound.push(resolve); return }
        const rec = calls.get(id)
        const r = (rec && rec.ring) || { id, from: d.from, name: d.name, kind: d.kind, group: d.group, roster: d.roster || [], names: d.names || [] }
        enqueue(incomingSpec(r, { resolve, from: 'prompt' }))
        return
      }
      if (CALL_UI_KINDS.indexOf(kind) < 0) { resolve(false); return }
      enqueue(confirmSpec(kind, d, resolve))
    })
  }

  // ---- ring effects -----------------------------------------------------------------------------------------
  function startRing (r) {
    stopRing(null)
    const saved = doc.title
    const ringTitle = C('call.ringTitle')
    const fx = { id: r.id, title: saved, flash: null, vibrate: null, sound: null, ctx: null, stopAt: null }
    let on = false
    fx.flash = setI(() => {
      try {
        if (doc.title !== ringTitle) fx.title = doc.title // the site may change its title while the call rings
        on = !on
        doc.title = on ? ringTitle : fx.title
      } catch (_) { /* read only */ }
    }, RING_FLASH_MS)
    if (nav && typeof nav.vibrate === 'function') {
      const buzz = () => { try { nav.vibrate([500, 300, 500]) } catch (_) { /* refused without activation */ } }
      buzz()
      fx.vibrate = setI(buzz, RING_REPEAT_MS)
    }
    if (AC && maySound(nav)) {
      try {
        fx.ctx = new AC()
        const tone = () => playTone(fx.ctx)
        tone()
        fx.sound = setI(tone, RING_REPEAT_MS)
      } catch (err) { log('ring tone: ' + ((err && err.message) || err)); fx.ctx = null }
    }
    const left = Number(r.expiresAt) - now()
    if (Number.isFinite(left) && left > 0) fx.stopAt = setT(() => stopRing(r.id), left)
    ring = fx
  }

  // The ring tone: two short 440 and 480 Hz bursts (a ring, not silence; never looped as a keep-alive, SZ 3.1.9).
  function playTone (ctx) {
    if (!ctx || typeof ctx.createOscillator !== 'function') return
    try {
      const t = ctx.currentTime || 0
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.linearRampToValueAtTime(0.12, t + 0.05)
      gain.gain.setValueAtTime(0.12, t + 1.0)
      gain.gain.linearRampToValueAtTime(0.0001, t + 1.2)
      gain.connect(ctx.destination)
      for (const f of [440, 480]) {
        const o = ctx.createOscillator()
        o.frequency.value = f
        o.connect(gain)
        o.start(t)
        o.stop(t + 1.25)
      }
    } catch (_) { /* a context that cannot play */ }
  }

  function stopRing (id) {
    const fx = ring
    if (!fx || (id !== null && fx.id !== id)) return
    ring = null
    if (fx.flash !== null) clearI(fx.flash)
    if (fx.vibrate !== null) { clearI(fx.vibrate); try { nav.vibrate(0) } catch (_) { /* nothing to stop */ } }
    if (fx.sound !== null) clearI(fx.sound)
    if (fx.stopAt !== null) clearT(fx.stopAt)
    if (fx.ctx && typeof fx.ctx.close === 'function') { try { const r = fx.ctx.close(); if (r && typeof r.then === 'function') r.then(null, () => {}) } catch (_) { /* closed */ } }
    try { if (doc.title === C('call.ringTitle')) doc.title = fx.title } catch (_) { /* read only */ }
    if (alertEl) alertEl.textContent = ''
  }

  // ---- the call panel ---------------------------------------------------------------------------------------
  function controlsOf (st) {
    const md = nav && nav.mediaDevices ? nav.mediaDevices : null
    return { screen: canShareScreen(md) }
  }

  function buildPanel (id) {
    mount()
    const el = make('section', 'mw-call-panel', { 'data-mw-call-panel': id })
    const head = make('p', 'mw-call-head')
    const clock = make('span', 'mw-call-clock', { 'aria-hidden': 'true' })
    const status = make('p', 'mw-call-status', { role: 'status', 'aria-live': 'polite' })
    const notices = make('div', 'mw-call-notices')
    const people = make('ul', 'mw-call-people')
    const tiles = make('div', 'mw-call-tiles')
    const local = make('video', 'mw-call-local', { playsinline: '', autoplay: '', muted: '', 'aria-hidden': 'true' })
    local.muted = true
    setHidden(local, true)
    const bar = make('div', 'mw-call-controls')
    // In-call controls act on the person's own click (isTrusted); they change what an accepted call carries, so the
    // redress checks of the decision cards (which re-rendering would trip) are not used here.
    const mute = decisionButton(C('call.mute'), 'mw-call-mute', () => control('mute'), null, { keys: 'M' })
    const camera = decisionButton(C('call.camera.on'), 'mw-call-camera', () => control('camera'), null, { keys: 'V' })
    const screen = decisionButton(C('call.screen.start'), 'mw-call-screen', () => control('screen'), null)
    const hangup = decisionButton(C('call.hangup'), 'mw-call-hangup mw-danger', () => control('hangup'), null)
    for (const b of [mute, camera, screen]) b.setAttribute('aria-pressed', 'false')
    bar.appendChild(mute)
    bar.appendChild(camera)
    bar.appendChild(screen)
    bar.appendChild(hangup)
    head.appendChild(clock)
    el.appendChild(head)
    el.appendChild(status)
    el.appendChild(notices)
    el.appendChild(people)
    el.appendChild(tiles)
    el.appendChild(local)
    el.appendChild(bar)
    // Keyboard shortcuts while the focus is in the panel: M mutes or unmutes, V turns the camera on or off.
    el.addEventListener('keydown', (ev) => {
      if (!ev || ev.isTrusted === false || ev.ctrlKey || ev.metaKey || ev.altKey) return
      const k = String(ev.key || '').toLowerCase()
      if (k === 'm') control('mute')
      else if (k === 'v') control('camera')
    })
    clear(panelSlot)
    panelSlot.appendChild(el)
    const p = { id, el, head, clock, status, notices, people, tiles, local, controls: { mute, camera, screen, hangup }, media: new Map(), localKey: null, lastStatus: '', tick: null, focused: false }
    p.tick = setI(() => renderClock(p), 1000)
    return p
  }

  function closePanel () {
    const p = panel
    if (!p) return
    panel = null
    if (p.tick !== null) clearI(p.tick)
    for (const m of p.media.values()) detachMedia(m)
    if (p.local) { try { p.local.srcObject = null } catch (_) { /* gone */ } }
    if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el)
    if (p.focused && lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus() } catch (_) { /* gone */ } }
    unmountIfIdle()
  }

  function renderClock (p) {
    const rec = calls.get(p.id)
    const st = rec && rec.state
    if (!st || !st.connectedAt || st.state === 'ended') { p.clock.textContent = ''; return }
    p.clock.textContent = durationText(now() - st.connectedAt)
  }

  function headText (st) {
    const people = Array.isArray(st.participants) ? st.participants : []
    const names = people.map((x) => callName(x.name, x.pub)).join(', ')
    if (st.state === 'ringing' && st.role === 'caller') return C('call.calling', { name: names || '?' })
    return names
  }

  function renderPanel (id) {
    const rec = calls.get(id)
    const st = rec && rec.state
    if (!st) return
    if (!panel || panel.id !== id) {
      closePanel()
      panel = buildPanel(id)
      // The person started or accepted this call: the panel takes the focus on Mute (never on a ring).
      try { lastFocus = doc.activeElement || null; panel.controls.mute.focus(); panel.focused = true } catch (_) { /* courtesy */ }
    }
    const p = panel
    const headLabel = headText(st)
    if (p.el.getAttribute('aria-label') !== headLabel) p.el.setAttribute('aria-label', headLabel)
    p.head.textContent = ''
    p.head.appendChild(make('span', 'mw-call-names', null, headLabel))
    p.head.appendChild(p.clock)
    renderClock(p)
    clear(p.notices)
    for (const t of noticesOf(st, lang, { phone: isPhone() })) p.notices.appendChild(make('p', 'mw-call-notice', null, t))
    clear(p.people)
    for (const x of st.participants || []) {
      const li = make('li', 'mw-call-person', { 'data-state': x.state || 'connecting' })
      li.appendChild(make('span', 'mw-call-person-name', null, callName(x.name, x.pub)))
      li.appendChild(make('span', 'mw-call-person-state', null, peerStateText(x, st.operator, lang)))
      p.people.appendChild(li)
    }
    const local = st.local || {}
    const c = p.controls
    c.mute.textContent = local.mute ? C('call.unmute') : C('call.mute')
    c.mute.setAttribute('aria-pressed', String(!!local.mute))
    c.camera.textContent = local.camera ? C('call.camera.off') : C('call.camera.on')
    c.camera.setAttribute('aria-pressed', String(!!local.camera))
    c.screen.textContent = local.screen ? C('call.screen.stop') : C('call.screen.start')
    c.screen.setAttribute('aria-pressed', String(!!local.screen))
    setHidden(c.screen, !controlsOf(st).screen)
    const live = st.state === 'ended'
    for (const b of [c.mute, c.camera, c.screen]) b.disabled = live
    // One polite announcement per change of what the call is doing.
    const status = st.state === 'ended' ? '' : (st.state === 'reconnecting' ? C('call.state.reconnecting') : (st.state === 'connected' ? '' : headLabel))
    if (status !== p.lastStatus) { p.lastStatus = status; p.status.textContent = status }
    attachMedia(id)
  }

  // ---- media: the service's tracks in this closed root only (service.media(id), never the SDK) -------------
  function streamOf (track) {
    if (!track) return null
    if (typeof MS === 'function') { try { return new MS([track]) } catch (_) { return null } }
    return null
  }
  function setSource (el, track) {
    const key = track ? String(track.id || '') + ':' + String(track.kind || '') : null
    if (el.__mwKey === key) return
    el.__mwKey = key
    try { el.srcObject = track ? streamOf(track) : null } catch (_) { /* a browser without srcObject */ }
    if (track && typeof el.play === 'function') {
      try { const r = el.play(); if (r && typeof r.then === 'function') r.then(null, () => {}) } catch (_) { /* autoplay refused */ }
    }
  }
  function detachMedia (m) {
    for (const el of [m.audio, m.video]) { if (el) { try { el.srcObject = null } catch (_) { /* gone */ } if (el.parentNode) el.parentNode.removeChild(el) } }
  }
  function attachMedia (id) {
    const p = panel
    if (!p || p.id !== id || !service || typeof service.media !== 'function') return
    let m = null
    try { m = service.media(id) } catch (_) { m = null }
    if (!m) return
    const seen = new Set()
    for (const r of m.remote || []) {
      if (!r || !r.pub) continue
      seen.add(r.pub)
      let tile = p.media.get(r.pub)
      if (!tile) {
        tile = { audio: make('audio', 'mw-call-audio', { autoplay: '' }), video: make('video', 'mw-call-video', { autoplay: '', playsinline: '' }) }
        setHidden(tile.video, true)
        p.tiles.appendChild(tile.audio)
        p.tiles.appendChild(tile.video)
        p.media.set(r.pub, tile)
      }
      setSource(tile.audio, r.audio || null)
      const vt = r.screen || r.camera || null
      setSource(tile.video, vt)
      setHidden(tile.video, !vt)
    }
    for (const [pub, tile] of Array.from(p.media)) if (!seen.has(pub)) { detachMedia(tile); p.media.delete(pub) }
    const lt = m.local ? (m.local.camera || null) : null
    setSource(p.local, lt)
    setHidden(p.local, !lt)
  }

  // ---- controls: the service is called inside the person's click (capture keeps its gesture) ----------------
  function control (what) {
    const p = panel
    const svc = service
    if (!p || !svc || !svc.methods) return
    const rec = calls.get(p.id)
    const st = rec && rec.state
    if (!st || st.state === 'ended') return
    const local = st.local || {}
    let r
    try {
      if (what === 'mute') r = svc.methods['calls.mute']({ id: p.id, on: !local.mute }, CTX)
      else if (what === 'camera') r = svc.methods['calls.camera']({ id: p.id, on: !local.camera }, CTX)
      else if (what === 'screen') r = svc.methods['calls.screen']({ id: p.id, on: !local.screen }, CTX)
      else if (what === 'hangup') r = svc.methods['calls.hangup']({ id: p.id }, CTX)
    } catch (err) { r = Promise.reject(err) }
    Promise.resolve(r).then(null, (err) => showError(err))
  }

  function showError (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'E_CALL_FAILED'
    if (code === 'E_USER_CANCELLED') return
    const text = errorText(code, lang)
    if (panel) { panel.status.textContent = text; announce(text); return }
    // No panel yet (an answer that failed before the call started): a small card says why, with one OK button.
    enqueue({ kind: 'call.notice', paras: [text], focus: false, escape: (c) => { if (card === c) closeCard(null) }, buttons: [{ label: U('ok'), run: (c) => { if (card === c) closeCard(null) } }] })
  }

  // ---- service events --------------------------------------------------------------------------------------
  function recOf (id) {
    if (!calls.has(id)) calls.set(id, { state: null, end: null, ring: null })
    return calls.get(id)
  }

  function onRing (r) {
    if (!r || typeof r.id !== 'string') return
    const rec = recOf(r.id)
    rec.ring = Object.assign({}, r)
    startRing(r)
    enqueue(incomingSpec(rec.ring, { from: 'ring' }))
  }

  function onState (st) {
    if (!st || typeof st.id !== 'string') return
    const rec = recOf(st.id)
    rec.state = st
    if (st.state !== 'ringing' || st.role !== 'callee') stopRing(st.id)
    if (st.state === 'ended') { finish(st.id); return }
    if (st.role === 'callee' && st.state === 'ringing') return // the incoming card is the UI until the person answers
    // The answered incoming card has closed already; one call has the panel at a time.
    if (card && card.kind === 'call.incoming' && card.id === st.id) closeCard(card.bound.length || card.resolve ? false : null)
    activeId = st.id
    renderPanel(st.id)
  }

  function onPeer (ev) {
    if (!ev || typeof ev.id !== 'string') return
    const rec = calls.get(ev.id)
    if (!rec || !rec.state) return
    const list = Array.isArray(rec.state.participants) ? rec.state.participants.slice() : []
    const i = list.findIndex((x) => x.pub === ev.pub)
    const x = { pub: ev.pub, state: ev.state, reason: ev.reason || null, path: ev.path || null, mute: !!ev.mute, camera: !!ev.camera, screen: !!ev.screen, name: ev.name || null }
    if (i >= 0) list[i] = Object.assign({}, list[i], x)
    else list.push(x)
    rec.state = Object.assign({}, rec.state, { participants: list })
    if (panel && panel.id === ev.id) renderPanel(ev.id)
  }

  function onEnded (e) {
    if (!e || typeof e.id !== 'string') return
    const rec = recOf(e.id)
    rec.end = Object.assign({}, e)
    if (card && card.kind === 'call.incoming' && card.id === e.id) closeCard(false)
    stopRing(e.id)
  }

  function finish (id) {
    const rec = calls.get(id)
    if (card && card.kind === 'call.incoming' && card.id === id) closeCard(false)
    const st = rec && rec.state
    const e = (rec && rec.end) || {}
    // The participants never include this tab's own key (src/calls/mesh.js): for a call of two, people[0] is the other.
    const people = st && Array.isArray(st.participants) ? st.participants : []
    const ringRec = (rec && rec.ring) || {}
    const other = people[0] || null
    const name = other ? callName(other.name || (other.pub === ringRec.from ? ringRec.name : null), other.pub) : callName(ringRec.name, ringRec.from)
    const text = endText({ reason: e.reason || (st && st.reason), code: e.code || (st && st.error), duration: e.duration, connected: !!(st && st.connectedAt), name }, lang)
    // A callee who declined or never answered sees nothing more; a call that ran or was refused says how it ended.
    const quiet = st && st.role === 'callee' && !st.connectedAt && (e.reason === 'declined' || e.reason === 'no-answer' || e.reason === 'cancelled')
    if (activeId === id) activeId = null
    if (panel && panel.id === id) {
      for (const m of panel.media.values()) detachMedia(m)
      panel.media.clear()
      try { panel.local.srcObject = null } catch (_) { /* gone */ }
      setHidden(panel.local, true)
      for (const b of [panel.controls.mute, panel.controls.camera, panel.controls.screen, panel.controls.hangup]) b.disabled = true
      panel.status.textContent = text
      announce(text)
      if (endTimer !== null) clearT(endTimer)
      endTimer = setT(() => { endTimer = null; if (panel && panel.id === id) closePanel() }, END_SHOW_MS)
    } else if (!quiet && text && st && st.role === 'caller') {
      announce(text)
    }
    if (calls.size > 32) calls.delete(calls.keys().next().value)
  }

  // ---- public ---------------------------------------------------------------------------------------------
  function attach (svc) {
    detach()
    if (!svc || typeof svc.on !== 'function') return () => {}
    service = svc
    const sub = (ev, fn) => { try { const off = svc.on(ev, fn); if (typeof off === 'function') offs.push(off) } catch (_) { /* no such event */ } }
    sub('ring', onRing)
    sub('state', onState)
    sub('peer', onPeer)
    sub('ended', onEnded)
    return detach
  }

  function detach () {
    for (const off of offs.splice(0)) { try { off() } catch (_) { /* gone */ } }
    service = null
  }

  function inspect () {
    return {
      card: card ? { kind: card.kind, id: card.id, waiting: card.bound.length + (card.resolve ? 1 : 0) } : null,
      queued: queue.length,
      panel: panel ? { id: panel.id, people: (calls.get(panel.id) && calls.get(panel.id).state && calls.get(panel.id).state.participants || []).length } : null,
      ringing: !!ring,
      calls: Array.from(calls.keys())
    }
  }

  function findButton (node, label) {
    if (!node || !node.children) return null
    for (const c of node.children) {
      if (c.tagName === 'BUTTON' && c.textContent === label && !c.hidden) return c
      const deeper = findButton(c, label)
      if (deeper) return deeper
    }
    return null
  }

  /** rectOf(label) -> the rectangle of a visible button of the panel or its card (a test clicks it with a real mouse). */
  function rectOf (label) {
    const b = findButton(wrap, label)
    if (!b || typeof b.getBoundingClientRect !== 'function') return null
    const r = b.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }

  function destroy () {
    destroyed = true
    detach()
    stopRing(null)
    while (queue.length) { const q = queue.shift(); if (q.resolve) q.resolve(false) }
    closeCard(false)
    closePanel()
    if (endTimer !== null) { clearT(endTimer); endTimer = null }
    if (host && host.parentNode) host.parentNode.removeChild(host)
    host = null; root = null; wrap = null
  }

  return { attach, detach, prompt, inspect, rectOf, destroy, get lang () { return lang }, get host () { return host } }
}
