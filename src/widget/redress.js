// src/widget/redress.js: the speed bumps for in-page loader cards (R 2.3.4, MF-06, PHISH A5).
// A card on a site page is a prompt or a low-risk confirmation. A page that shares the origin can still try
// to cover the button with its own element, fade the card out, or move it under the pointer just before a
// click. These checks make that harder; they are SPEED BUMPS, not a lock. Anything that matters (first
// sign-in to an origin, same identity, link a device, show the phrase, first read of the private record)
// opens only at the identity origin, in a window the page cannot draw over.
//
//   isTrusted(ev)                       false only for events a script made (ev.isTrusted === false)
//   checkElement(el, ctx)               -> { ok, reason }   topmost element, computed style, geometry
//   createGuard(opts)                   -> { start(), check(), stop(), rebase(), cancelled, reason }
//   adoptFocusRing(root, color)         -> true when a :focus-visible ring was adopted into a card's shadow root
//
// ctx / opts: { win, doc, host, strict }. strict (default true) fails closed when this browser lacks an API a
// check needs; the drop-in panel passes strict:false for its older prompts so a missing API skips the check.
// Nothing here reads or writes secrets, and nothing here is async.

export function isTrusted (ev) {
  return !(ev && ev.isTrusted === false)
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

function parentOf (node) {
  if (!node) return null
  if (node.parentNode) return node.parentNode
  return node.host || null // a shadow root continues at its host
}

function rectOf (el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null
  const r = el.getBoundingClientRect()
  if (!r) return null
  const x = Number(r.x !== undefined ? r.x : r.left)
  const y = Number(r.y !== undefined ? r.y : r.top)
  return { x, y, width: Number(r.width), height: Number(r.height) }
}

function contains (a, b) {
  for (let n = b, i = 0; n && i < 64; n = n.parentNode, i++) if (n === a) return true
  return false
}

/** checkElement(el, { win, doc, host, strict }) -> { ok: true } | { ok: false, reason } */
export function checkElement (el, ctx = {}) {
  const win = ctx.win || null
  const doc = ctx.doc || (win && win.document) || null
  const host = ctx.host || null
  const strict = ctx.strict !== false
  if (!el) return { ok: false, reason: 'missing' }
  const unverifiable = (what) => (strict ? { ok: false, reason: 'unverifiable:' + what } : null)

  // 1. geometry
  const r = rectOf(el)
  if (!r) {
    const u = unverifiable('rect'); if (u) return u
  } else {
    if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: 'hidden' }
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    const vw = win && Number(win.innerWidth); const vh = win && Number(win.innerHeight)
    if (vw && vh && (cx < 0 || cy < 0 || cx > vw || cy > vh)) return { ok: false, reason: 'offscreen' }

    // 2. the topmost element at the button's centre is the button (inside the closed root), and the page
    // sees only our host there (nothing of the page's own sits above it).
    const rootNode = typeof el.getRootNode === 'function' ? el.getRootNode() : null
    if (rootNode && typeof rootNode.elementFromPoint === 'function') {
      const top = rootNode.elementFromPoint(cx, cy)
      if (top !== el && !(top && contains(el, top))) return { ok: false, reason: 'covered' }
    } else {
      const u = unverifiable('elementFromPoint'); if (u) return u
    }
    if (host) {
      if (doc && typeof doc.elementFromPoint === 'function') {
        const outer = doc.elementFromPoint(cx, cy)
        if (outer !== host) return { ok: false, reason: 'covered-by-page' }
      } else {
        const u = unverifiable('document.elementFromPoint'); if (u) return u
      }
    }
  }

  // 3. computed style of the button and of every ancestor up to the document
  if (!win || typeof win.getComputedStyle !== 'function') {
    const u = unverifiable('getComputedStyle'); if (u) return u
  } else {
    let n = el
    for (let i = 0; n && i < 64; i++, n = parentOf(n)) {
      // Only elements have a computed style: skip the document (9) and a shadow root (11, a fragment), which
      // getComputedStyle refuses with a TypeError in real browsers (v0.3 integration: the fake DOM names them
      // by tagName only).
      if (n.nodeType === 9 || n.nodeType === 11 || n.tagName === '#document' || n.tagName === '#shadow-root') continue
      const cs = win.getComputedStyle(n)
      if (!cs) continue
      const op = num(cs.opacity)
      if (op !== null && op < 0.99) return { ok: false, reason: 'opacity' }
      const vis = String(cs.visibility || '')
      if (vis === 'hidden' || vis === 'collapse') return { ok: false, reason: 'visibility' }
      if (String(cs.display || '') === 'none') return { ok: false, reason: 'display' }
      if (n === el && String(cs.pointerEvents || cs['pointer-events'] || '') === 'none') return { ok: false, reason: 'pointer-events' }
    }
  }
  return { ok: true }
}

/**
 * createGuard({ win, doc, host, button, strict, onCancel, MutationObserverCtor, now, minVisibleMs })
 * One guard per card button. start() records the button's position and watches for style, class, hidden and
 * position changes under the host (and for new elements in the page body); check() is called right before the
 * click is acted on and also requires the button to have been on screen for minVisibleMs (default 250 ms).
 * A failed check or a changed style cancels the card once: onCancel(reason).
 */
export function createGuard (opts = {}) {
  const win = opts.win || null
  const doc = opts.doc || (win && win.document) || null
  const hostOf = () => (typeof opts.getHost === 'function' ? opts.getHost() : opts.host) || null
  const button = opts.button
  const strict = opts.strict !== false
  const now = opts.now || (() => Date.now())
  const minVisibleMs = opts.minVisibleMs === undefined ? 250 : opts.minVisibleMs
  const MO = opts.MutationObserverCtor || (win && win.MutationObserver) || null
  const state = { cancelled: false, reason: null }
  let observers = []
  let startedAt = 0
  let base = null

  function stop () {
    for (const o of observers) { try { o.disconnect() } catch (_) { /* gone */ } }
    observers = []
  }

  function cancel (reason) {
    if (state.cancelled) return false
    state.cancelled = true
    state.reason = reason
    stop()
    if (typeof opts.onCancel === 'function') { try { opts.onCancel(reason) } catch (_) { /* ignore */ } }
    return false
  }

  function moved () {
    const r = rectOf(button)
    if (!r || !base) return false
    return Math.abs(r.x - base.x) > 1 || Math.abs(r.y - base.y) > 1 || Math.abs(r.width - base.width) > 1 || Math.abs(r.height - base.height) > 1
  }

  function onMutations (records) {
    if (state.cancelled) return
    for (const rec of records || []) {
      if (rec.type === 'attributes' && (rec.attributeName === 'style' || rec.attributeName === 'class' || rec.attributeName === 'hidden')) { cancel('style-changed'); return }
      if (rec.type === 'childList' && rec.target && (rec.target === doc.body || rec.target === doc.documentElement)) {
        const verdict = checkElement(button, { win, doc, host: hostOf(), strict })
        if (!verdict.ok) { cancel(verdict.reason); return }
        if (moved()) { cancel('moved'); return }
      }
    }
    if (moved()) cancel('moved')
  }

  function start () {
    // Review round R 5.3 (UX-1): start() re-arms a guard. A header guard that a card's layout change cancelled used to
    // stay cancelled for the session, so Sign out and Remove did nothing after the first false alarm.
    stop()
    state.cancelled = false
    state.reason = null
    startedAt = now()
    base = rectOf(button)
    const host = hostOf()
    if (MO) {
      try {
        const root = typeof button.getRootNode === 'function' ? button.getRootNode() : null
        const watch = (target, init) => { if (!target) return; const o = new MO(onMutations); o.observe(target, init); observers.push(o) }
        // Style, class and hidden changes anywhere under the host, in the page or in the card.
        watch(host, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
        if (root && root !== host) watch(root, { attributes: true, attributeFilter: ['style', 'class', 'hidden'], subtree: true })
        // A new page element next to or above the card.
        if (doc) { watch(doc.body, { childList: true }); watch(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] }) }
      } catch (_) { /* a browser without it: the click-time check still runs */ }
    } else if (strict) {
      // No MutationObserver: only the click-time checks protect this card.
    }
    return api
  }

  /** check() -> true when the click may be acted on; false (and the card is cancelled) otherwise. */
  function check () {
    if (state.cancelled) return false
    if (now() - startedAt < minVisibleMs) return false // too soon after the card appeared: ignore, do not cancel
    const verdict = checkElement(button, { win, doc, host: hostOf(), strict })
    if (!verdict.ok) return cancel(verdict.reason)
    if (moved()) return cancel('moved')
    return true
  }

  /**
   * rebase(): the loader moved this button itself (a card shown or closed above or below it, a status line, the header
   * folding, a resize). Take the position again and restart the minVisibleMs window, so the button must sit still at its
   * new place before a click counts (UX-1, UX-2). A cancelled guard stays cancelled.
   */
  function rebase () {
    if (state.cancelled || !moved()) return api // nothing moved: the window already running stands
    const r = rectOf(button)
    if (r) base = r
    startedAt = now()
    return api
  }

  const api = {
    start,
    check,
    stop,
    rebase,
    get cancelled () { return state.cancelled },
    get reason () { return state.reason }
  }
  return api
}

/**
 * adoptFocusRing(root, color) -> true when applied (accessibility lane, e2e E-ID-9): the cards style every element with
 * an inline "all: initial", which also removes the browser's own focus ring, so a keyboard user could not see which button
 * is focused (WCAG 2.4.7). This adopts a constructed style sheet into the card's shadow root that draws one for
 * :focus-visible. It is CSSOM (a strict Content-Security-Policy is fine) and changes no attribute, so the guards above,
 * which cancel a card whose style attributes change, never see it. Without adoptedStyleSheets (Safari before 16.4, or a
 * host with no shadow root) it does nothing and the cards stay as they were.
 */
export function adoptFocusRing (root, color) {
  try {
    const doc = root && (root.ownerDocument || null)
    const Sheet = doc && doc.defaultView && doc.defaultView.CSSStyleSheet
    if (!Sheet || !root || !('adoptedStyleSheets' in root) || typeof Sheet.prototype.replaceSync !== 'function') return false // lint-floor-ignore: the guard
    const sheet = new Sheet()
    const c = /^#[0-9a-fA-F]{3,8}$/.test(String(color)) ? String(color) : '#0a58ca'
    const rule = 'button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid ' + c + ' !important; outline-offset: 2px !important; }'
    sheet.replaceSync(rule) // lint-floor-ignore: guarded above (Safari 16.4); older browsers keep the cards as they were
    const had = Array.from(root.adoptedStyleSheets || []) // lint-floor-ignore: guarded above
    root.adoptedStyleSheets = had.concat([sheet]) // lint-floor-ignore: guarded above
    return true
  } catch (_) {
    return false
  }
}
