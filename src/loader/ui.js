// src/loader/ui.js: the shell's own interface (ARCHITECTURE §5.10, DESIGN-REVIEW §4, S3, S5, S10).
// Status bar (top on desktop, bottom on phones, collapsible to a pill), progress, peers, ledger
// line, identity, source and pointer badges, the consent notice and gate, error cards, banners, the
// settings dialog and the diagnostics matrix. DOM is built with createElement and textContent only;
// nothing from a site, a pointer or a peer is ever parsed as HTML.

import { STRINGS, STRING_HELPERS, uiText, cardText, errorText, fmt, pickLang, CARD_TEXT, UI_TEXT, stringsFor, STRINGS_FR } from './strings.js'
import { checkElement, createGuard, adoptFocusRing } from '../widget/redress.js'
// C2 wire-ui: the seeding texts of lane docs-strings (SZ 3.1.5): labels, hand-off, dock mode, keeper tab, carry meter.
import { seedText } from './strings.js'
// C2 doors: the Doors panel, the door view's lines, the "Open a link" box (research/v03/S4-doors.md D3 to D6).
import { doorText } from './strings.js'

export function formatBytes (n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return Math.round(n) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return (v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i]
}

export function formatSpeed (bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return '0 B/s'
  return formatBytes(bps) + '/s'
}

export function shortText (s, max = 24) {
  const str = String(s === null || s === undefined ? '' : s)
  return str.length > max ? str.slice(0, max - 3) + '...' : str
}

const COLLAPSE_KEY = 'mw:bar-collapsed'

// =====================================================================================================
// v0.3 C2 (lane wire-ui; research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md "SZ" 3.1.3 to 3.1.5 and 3.3): pure helpers for
// the seeding texts. Every number they print is a measured byte count, a configured cap, a count from evidence or a
// clock time: never a score, a ranking or a reward (ARCHITECTURE 8, no incentive layer).
// =====================================================================================================

const UNITS = {
  en: { bin: ['B', 'KiB', 'MiB', 'GiB', 'TiB'], dec: ['B', 'kB', 'MB', 'GB', 'TB'] },
  fr: { bin: ['o', 'Kio', 'Mio', 'Gio', 'Tio'], dec: ['o', 'ko', 'Mo', 'Go', 'To'] }
}

/**
 * capText(bytes, lang) -> a cap as configured (SZ 3.1.3): '1 GiB', '256 MiB', '20 GB' when the figure is a whole
 * number of binary or decimal units, else formatBytes(). Infinity or null -> '' (no cap).
 */
export function capText (bytes, lang = 'en') {
  const u = UNITS[pickLang(lang)] || UNITS.en
  if (bytes === null || bytes === undefined) return ''
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n === 0) return '0 ' + u.bin[0]
  for (let i = 4; i >= 1; i--) {
    const b = Math.pow(1024, i)
    if (n >= b && n % b === 0) return (n / b) + ' ' + u.bin[i]
    const d = Math.pow(1000, i)
    if (n >= d && n % d === 0) return (n / d) + ' ' + u.dec[i]
  }
  return formatBytes(n)
}

/** ageText(ms, lang) -> 'less than a minute', '1 minute', '12 minutes', '1 hour', '3 hours' (for avail.keptBySite {age}). */
export function ageText (ms, lang = 'en') {
  const fr = pickLang(lang) === 'fr'
  const n = Math.max(0, Number(ms) || 0)
  const min = Math.floor(n / 60000)
  if (min < 1) return fr ? 'moins d\'une minute' : 'less than a minute'
  if (min < 60) return min + (fr ? (min === 1 ? ' minute' : ' minutes') : (min === 1 ? ' minute' : ' minutes'))
  const h = Math.floor(min / 60)
  return h + (fr ? (h === 1 ? ' heure' : ' heures') : (h === 1 ? ' hour' : ' hours'))
}

/** clockText(ms, lang) -> the local time of a timestamp, hours and minutes ('16:30' or '4:30 PM' by locale). */
export function clockText (ms, lang = 'en') {
  const t = Number(ms)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  try {
    return new Intl.DateTimeFormat(lang || 'en', { hour: 'numeric', minute: '2-digit' }).format(d)
  } catch (_) {
    const p = (x) => (x < 10 ? '0' : '') + x
    return p(d.getHours()) + ':' + p(d.getMinutes())
  }
}

/** lastSentence(text) -> the last sentence of a text ('' when it has one sentence only). */
export function lastSentence (text) {
  const m = /[.?!]\s+([^.?!]+[.?!])\s*$/.exec(String(text || ''))
  return m ? m[1] : ''
}

const SINGULAR = { 'avail.heldBy': 'avail.heldByOne', 'meter.visit': 'meter.visitOne' }

/**
 * labelText(label, params, lang, { now }) -> the sentence of an availability or hand-off label key (SZ 3.1.5) with its
 * placeholders filled: { n } as a number, { age } (ms) as ageText, { pct } as a whole number. A count of 1 uses the
 * singular key when lane docs-strings has one ('avail.heldByOne'), else the plural sentence. '' for an unknown key.
 */
export function labelText (label, params, lang = 'en') {
  if (typeof label !== 'string' || !label) return ''
  const p = Object.assign({}, params || {})
  if (p.age !== undefined && typeof p.age === 'number') p.age = ageText(p.age, lang)
  if (p.pct !== undefined) p.pct = Math.max(0, Math.min(100, Math.floor(Number(p.pct) || 0)))
  if (p.n !== undefined) p.n = Math.max(0, Math.floor(Number(p.n) || 0))
  if (p.n === 1 && SINGULAR[label]) {
    const one = seedText(SINGULAR[label], lang, p)
    if (one) return one
  }
  return seedText(label, lang, p)
}

/**
 * carryMeter({ peerBytes, webseedBytes, senders }) -> { p, n, h } | null (SZ 3.1.5 meter.visit, 3.3): the share of this
 * visit's site bytes that came from visitors (p) and from the host (h), in whole percent adding up to 100, and n, the
 * number of distinct visitors that sent at least one byte of it. null before any byte arrived (a copy from the cache
 * downloaded nothing). Measured counts of bytes and peers on this device; nothing is sent anywhere.
 */
export function carryMeter ({ peerBytes = 0, webseedBytes = 0, senders = 0 } = {}) {
  const peer = Math.max(0, Number(peerBytes) || 0)
  const host = Math.max(0, Number(webseedBytes) || 0)
  const total = peer + host
  if (!(total > 0)) return null
  let p = Math.round((peer / total) * 100)
  if (peer > 0 && p === 0) p = 1 // some bytes came from visitors: never print 0%
  if (host > 0 && p === 100) p = 99
  const n = Math.max(0, Math.floor(Number(senders) || 0))
  return { p, n: peer > 0 ? Math.max(1, n) : 0, h: 100 - p }
}

/** meterText(meter, lang) -> 'This visit: 60% of the bytes came from 3 visitors, 40% from the host.' or ''. */
export function meterText (m, lang = 'en') {
  if (!m) return ''
  if (m.n === 1) {
    const one = seedText(SINGULAR['meter.visit'], lang, m)
    if (one) return one
  }
  return seedText('meter.visit', lang, { p: m.p, n: m.n, h: m.h })
}

/** trackerText(n, at, lang) -> '{n} connected to this site (tracker report, {time})', or '' without a report. */
export function trackerText (n, at, lang = 'en') {
  if (n === null || n === undefined || at === null || at === undefined) return ''
  const count = Math.floor(Number(n))
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(Number(at))) return ''
  return seedText('meter.tracker', lang, { n: count, time: clockText(at, lang) })
}

/**
 * createSeedUi({ doc, host, overlayHost, lang }) -> { setMeter, setUploads, setKeeper, setDock, nodes } (C2 wire-ui): the
 * seeding lines of the status bar and the dim page of dock mode. Plain DOM (createElement, textContent, attributes and
 * listeners only), so the fake DOM of the unit tests runs it. Decisions use trusted clicks only (trustedOnly).
 *   setMeter({ visit, tracker })   the carry meter after load: two labelled sources, each a text or null
 *   setUploads(items, { note })    the loader's own upload card: [{ key, name, text }] (label sentences), and a note
 *   setKeeper({ on, text })        the keeper tab line ("Keeping this site while this tab is open." and its counter)
 *   setDock(state, { onStop })     the dim page while the screen is kept on ({ on, until }), with its stop button
 */
export function createSeedUi ({ doc, host, overlayHost = null, meterHost = null, lang = 'en' } = {}) {
  if (!doc || !host) throw new TypeError('createSeedUi needs a document and a host element')
  const L = pickLang(lang)
  const make = (tag, cls, attrs) => {
    const n = doc.createElement(tag)
    if (cls) n.className = cls
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k])
    return n
  }
  const clear = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild) }
  const line = (cls, text) => { const p = make('p', cls); p.textContent = text; return p }

  const meter = make('div', 'mw-meter', { role: 'status', 'aria-live': 'polite' })
  meter.hidden = true
  const keeper = make('div', 'mw-keeper', { role: 'status', 'aria-live': 'polite' })
  keeper.hidden = true
  const uploads = make('div', 'mw-uploads', { role: 'status', 'aria-live': 'polite' })
  uploads.hidden = true
  host.appendChild(uploads)
  host.appendChild(keeper)
  // C2 integrator: the carry meter goes where meterHost says (the loader puts it in Settings, "Sharing"): in the bar its two lines
  // covered the top of the site whenever a notice kept the bar open (e2e E-ID-7 could not click the guestbook's Sign in).
  ;(meterHost || host).appendChild(meter)

  // Dock mode: a dim page over everything, with what is happening and how to stop (SZ 3.1.4, S1 D3: "a dim black page").
  const dock = make('div', 'mw-dock', { role: 'dialog', 'aria-modal': 'false', 'aria-live': 'polite' })
  dock.hidden = true
  const dockText = make('p', 'mw-dock-text')
  const dockStop = make('button', 'mw-btn mw-dock-stop', { type: 'button' })
  dockStop.textContent = seedText('dock.stop', L)
  let onDockStop = null
  dockStop.addEventListener('click', trustedOnly(() => { if (typeof onDockStop === 'function') onDockStop() }))
  dock.appendChild(dockText)
  dock.appendChild(dockStop)
  ;(overlayHost || host).appendChild(dock)

  function setMeter ({ visit = null, tracker = null } = {}) {
    clear(meter)
    if (visit) meter.appendChild(line('mw-meter-visit', visit))
    if (tracker) meter.appendChild(line('mw-meter-tracker', tracker))
    meter.hidden = !visit && !tracker
  }

  function setUploads (items, { note = null } = {}) {
    clear(uploads)
    const list = Array.isArray(items) ? items.filter((it) => it && it.text) : []
    if (!list.length) { uploads.hidden = true; return }
    for (const it of list.slice(0, 4)) {
      const row = make('p', 'mw-upload-row')
      if (it.name) {
        const name = make('span', 'mw-upload-name')
        name.textContent = shortText(it.name, 40)
        row.appendChild(name)
      }
      const label = make('span', 'mw-upload-label')
      label.textContent = String(it.text)
      row.appendChild(label)
      uploads.appendChild(row)
    }
    if (note) uploads.appendChild(line('mw-upload-note', note))
    uploads.hidden = false
  }

  function setKeeper ({ on = false, text = '' } = {}) {
    clear(keeper)
    if (!on) { keeper.hidden = true; return }
    keeper.appendChild(line('mw-keeper-text', text || seedText('keeper.on', L)))
    keeper.hidden = false
  }

  function setDock (state, { onStop = null } = {}) {
    onDockStop = onStop
    if (!state || !state.on) { dock.hidden = true; return }
    dockText.textContent = seedText('dock.on', L, { time: clockText(state.until, L) })
    dock.hidden = false
  }

  return { setMeter, setUploads, setKeeper, setDock, nodes: { meter, keeper, uploads, dock, dockStop } }
}

/** doorStateText(state, lang) → the words for a door's probe state ('up', 'other-build', 'opaque', 'bad', 'down'; else 'not checked'). C2 doors. */
export function doorStateText (state, lang = 'en') {
  const known = ['up', 'other-build', 'opaque', 'bad', 'down']
  return doorText('door.state.' + (known.indexOf(state) >= 0 ? state : 'unknown'), pickLang(lang))
}

/**
 * createDoorsUi({ doc, lang }) -> { node, setModel(model), onAction(fn), nodes } (C2 doors, S4 D3): the Doors section of Settings.
 * Plain DOM (createElement, textContent, attributes, listeners), so the unit tests' fake DOM runs it. model (src/loader/app.js,
 * from doors.js doorsPanelModel): { shown, current, lastGood, owner, guest, ledger, hint: [{ host, state, url }], link, build }.
 * A door with a url is a plain link the visitor follows; nothing here navigates by itself. "Copy link with doors" calls the
 * action listener with ('copyDoorLink', { link }) on a trusted click; setModel({ ..., copied: true | false }) shows the outcome
 * (on false the link is shown as text to copy by hand).
 */
export function createDoorsUi ({ doc, lang = 'en' } = {}) {
  if (!doc) throw new TypeError('createDoorsUi needs a document')
  const L = pickLang(lang)
  const make = (tag, cls, attrs) => {
    const n = doc.createElement(tag)
    if (cls) n.className = cls
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k])
    return n
  }
  const clear = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild) }
  const textNode = (tag, cls, text) => { const n = make(tag, cls); n.textContent = text; return n }
  let listener = null
  const node = make('section', 'mw-section mw-doors')
  node.hidden = true
  const title = textNode('h3', null, doorText('door.panel.title', L))
  const intro = textNode('p', 'mw-note', doorText('door.panel.intro', L))
  const body = make('div', 'mw-doors-body')
  const copyBtn = make('button', 'mw-btn mw-doors-copy', { type: 'button' })
  copyBtn.textContent = doorText('door.panel.copy', L)
  const result = make('p', 'mw-note mw-doors-result', { 'aria-live': 'polite' })
  const linkText = make('textarea', 'mw-input mw-mono mw-doors-link', { rows: '3', readonly: 'readonly', spellcheck: 'false', 'aria-label': doorText('door.panel.copy', L) })
  linkText.hidden = true
  const build = make('p', 'mw-note mw-doors-build')
  let current = {}
  copyBtn.addEventListener('click', trustedOnly(() => { if (typeof listener === 'function' && current.link) listener('copyDoorLink', { link: current.link }) }))
  node.appendChild(title)
  node.appendChild(intro)
  node.appendChild(body)
  node.appendChild(copyBtn)
  node.appendChild(result)
  node.appendChild(linkText)
  node.appendChild(build)
  const item = (d) => {
    const li = make('li', 'mw-door')
    li.appendChild(textNode('span', 'mw-door-host', d.host))
    li.appendChild(textNode('span', 'mw-door-state', ' (' + doorStateText(d.state, L) + ')'))
    if (d.url) {
      const a = make('a', 'mw-link mw-door-open', { href: d.url, rel: 'noopener noreferrer' })
      a.textContent = doorText('door.openAt', L, { host: d.host })
      li.appendChild(textNode('span', null, ' '))
      li.appendChild(a)
    }
    return li
  }
  function setModel (m = {}) {
    current = m || {}
    node.hidden = !current.shown
    clear(body)
    if (current.current) body.appendChild(textNode('p', 'mw-value mw-doors-current', doorText('door.panel.current', L, { host: current.current.host }) + ' (' + doorStateText(current.current.state, L) + ')'))
    if (current.lastGood) body.appendChild(textNode('p', 'mw-note mw-doors-last', doorText('door.panel.lastGood', L, { host: current.lastGood.host })))
    let any = false
    for (const kind of ['owner', 'guest', 'ledger', 'hint']) {
      const list = Array.isArray(current[kind]) ? current[kind] : []
      if (!list.length) continue
      any = true
      body.appendChild(textNode('p', 'mw-doors-kind', doorText('door.panel.' + kind, L)))
      const ul = make('ul', 'mw-doors-list', { 'data-kind': kind })
      for (const d of list) ul.appendChild(item(d))
      body.appendChild(ul)
    }
    if (!any) body.appendChild(textNode('p', 'mw-note', doorText('door.panel.none', L)))
    copyBtn.disabled = !current.link
    if (current.copied === true) { result.textContent = doorText('door.panel.copied', L); linkText.hidden = true }
    else if (current.copied === false) { result.textContent = doorText('door.panel.copyFailed', L); linkText.value = current.link || ''; linkText.hidden = false }
    else { result.textContent = ''; linkText.hidden = true }
    build.textContent = current.build && current.build.version ? doorText('door.panel.build', L, { version: current.build.version, build: current.build.id || '-' }) : ''
    build.hidden = !build.textContent
  }
  return { node, setModel, onAction: (fn) => { listener = fn }, nodes: { copyBtn, result, linkText, body, build } }
}

/**
 * trustedOnly(handler) → an event listener that ignores events a script made (event.isTrusted === false:
 * el.click(), dispatchEvent) and calls handler for the visitor's own input. Events without an isTrusted
 * field (unit-test fakes) pass. Used for every loader-owned decision (v0.2.1 A4).
 */
export function trustedOnly (handler) {
  return (ev) => {
    if (ev && ev.isTrusted === false) return undefined
    return typeof handler === 'function' ? handler(ev) : undefined
  }
}

/**
 * createUI(root, strings) → { setStatus, setProgress, setPeers, setLedger, setIdentity, setSource,
 *   setPointerInfo, showNotice, showGate, showError, hideError, setBanner, settings, diagnostics, ... }
 */
export function createUI (root, strings = STRINGS, uiOpts = {}) {
  if (!root || !root.ownerDocument) throw new TypeError('createUI needs a DOM element')
  const doc = root.ownerDocument
  const win = doc.defaultView
  // UX-13: the consent card, the notice, the gate and the settings panel in the visitor's language, like the cards below.
  const S = !strings || strings === STRINGS ? stringsFor((uiOpts && uiOpts.lang) || (win && win.navigator && win.navigator.language) || 'en') : strings
  if (S !== STRINGS && S.consentTitle === STRINGS_FR.consentTitle && typeof root.setAttribute === 'function') root.setAttribute('lang', 'fr') // WCAG 3.1.2

  const el = (tag, attrs, children) => {
    const node = doc.createElement(tag)
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k]
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = String(v)
        else if (k === 'hidden') node.hidden = !!v
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
        else node.setAttribute(k, v === true ? '' : String(v))
      }
    }
    for (const c of children || []) if (c) node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c)
    return node
  }
  const clear = (node) => { while (node && node.firstChild) node.removeChild(node.firstChild) }
  const button = (label, onClick, cls) => el('button', { type: 'button', class: 'mw-btn' + (cls ? ' ' + cls : ''), text: label, onclick: onClick })
  const safe = (fn) => (...args) => { try { if (typeof fn === 'function') return fn(...args) } catch (err) { if (win && win.console) win.console.error('[mw ui]', err) } }
  // v0.2.1 (DIGEST-AMENDMENTS A4; INTERFACES "src/loader/ui.js"): the consent decision and the identity
  // export/import act only on the visitor's own input. A click a script made (el.click(), dispatchEvent:
  // event.isTrusted === false), for example by the same-origin site frame, is ignored.
  const decision = (label, onClick, cls) => button(label, trustedOnly(onClick), cls)

  // ----- structure ------------------------------------------------------------------------------
  root.classList.add('mw-root')
  let site = root.querySelector('#mw-site')
  if (!site) { site = el('div', { id: 'mw-site', class: 'mw-site' }); root.appendChild(site) }
  let bar = root.querySelector('#mw-bar')
  if (!bar) { bar = el('div', { id: 'mw-bar' }); root.appendChild(bar) }
  // Accessibility lane (e2e E-ID-9b): the bar, which holds the first-run notice, the gate and Settings, comes before the site
  // frame in the document, so the keyboard and a screen reader reach the loader's own questions before the whole site. Both
  // are position: fixed and only the bar has a z-index, so nothing moves on screen.
  if (site.parentNode === root && bar.parentNode === root && typeof root.insertBefore === 'function' && typeof site.compareDocumentPosition === 'function' &&
      (site.compareDocumentPosition(bar) & 4)) root.insertBefore(bar, site)
  clear(bar)
  bar.className = 'mw-bar'
  bar.setAttribute('role', 'region')
  bar.setAttribute('aria-label', 'Site loader')

  const pillCount = el('span', { class: 'mw-pill-count', text: '0' })
  const pill = el('button', { type: 'button', class: 'mw-pill', 'aria-expanded': 'true', 'aria-label': 'Hide loader status' }, [el('span', { class: 'mw-dot', 'aria-hidden': 'true' }), pillCount])
  const statusEl = el('span', { class: 'mw-status', role: 'status', 'aria-live': 'polite', text: S.starting })
  const progressFill = el('span', { class: 'mw-progress-fill' })
  const progressEl = el('span', { class: 'mw-progress mw-indeterminate', role: 'progressbar', 'aria-label': 'Download progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [progressFill])
  const progressText = el('span', { class: 'mw-progress-text' })
  const peersEl = el('span', { class: 'mw-chip mw-peers', text: S.peers(0) })
  const sourceEl = el('span', { class: 'mw-chip mw-source', hidden: true })
  const ledgerEl = el('span', { class: 'mw-chip mw-ledger', hidden: true, title: S.ledgerOneLiner })
  const pointerEl = el('span', { class: 'mw-chip mw-pointer', hidden: true })
  const identityEl = el('span', { class: 'mw-chip mw-identity', hidden: true })
  const modeEl = el('span', { class: 'mw-chip mw-mode mw-warn', hidden: true })
  const settingsBtn = el('button', { type: 'button', class: 'mw-btn mw-settings-btn', 'aria-haspopup': 'dialog', text: S.settingsTitle })
  const chips = el('span', { class: 'mw-chips' }, [peersEl, sourceEl, ledgerEl, pointerEl, identityEl, modeEl])
  const row = el('div', { class: 'mw-bar-row' }, [pill, statusEl, progressEl, progressText, chips, settingsBtn])
  const subline = el('div', { class: 'mw-subline', hidden: true })
  const banners = el('div', { class: 'mw-banners' })
  const noticeBox = el('div', { class: 'mw-notice', role: 'region', 'aria-label': 'Peer-to-peer notice', hidden: true })
  bar.appendChild(row)
  bar.appendChild(subline)
  bar.appendChild(banners)
  bar.appendChild(noticeBox)
  // C2 wire-ui: the upload card and the keeper line in the bar; the dim page of dock mode over the page. C2 integrator: the carry
  // meter in Settings ("Sharing"), not in the bar, which stays open over the site while a notice is shown.
  const meterSlot = el('div', { class: 'mw-meter-slot' })
  const seedUi = createSeedUi({ doc, host: bar, overlayHost: root, meterHost: meterSlot, lang: uiOpts.lang || (win && win.navigator && win.navigator.language) || 'en' })

  // ----- collapse -------------------------------------------------------------------------------
  let collapsed = false
  let collapseTimer = null
  const setCollapsed = (v, remember = true) => {
    collapsed = !!v
    bar.classList.toggle('mw-collapsed', collapsed)
    pill.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    pill.setAttribute('aria-label', collapsed ? 'Show loader status' : 'Hide loader status')
    if (remember) { try { win.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0') } catch (_) { /* storage blocked */ } }
  }
  pill.addEventListener('click', () => setCollapsed(!collapsed))
  const rememberedCollapse = (() => { try { return win.localStorage.getItem(COLLAPSE_KEY) } catch (_) { return null } })()

  // ----- overlays -------------------------------------------------------------------------------
  let lastFocus = null
  const overlay = (cls, labelId) => {
    const box = el('div', { class: 'mw-dialog ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId, hidden: true })
    const scrim = el('div', { class: 'mw-scrim', hidden: true }, [box])
    root.appendChild(scrim)
    return { scrim, box }
  }
  const openOverlay = (o, focusTarget) => {
    lastFocus = doc.activeElement
    o.scrim.hidden = false
    o.box.hidden = false
    try { if (focusTarget) focusTarget.focus() } catch (_) { /* ignore */ }
  }
  const closeOverlay = (o) => {
    if (o.box.hidden) return
    o.box.hidden = true
    o.scrim.hidden = true
    try { if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus() } catch (_) { /* ignore */ }
  }

  // error card
  const errorO = overlay('mw-error', 'mw-error-title')
  const errTitle = el('h2', { id: 'mw-error-title' })
  const errDetail = el('p', { class: 'mw-error-detail' })
  const errActions = el('div', { class: 'mw-actions' })
  errorO.box.setAttribute('role', 'alertdialog')
  errorO.box.appendChild(errTitle)
  errorO.box.appendChild(errDetail)
  errorO.box.appendChild(errActions)
  const hideError = () => closeOverlay(errorO)
  const showError = ({ title, detail, actions = [] } = {}) => {
    errTitle.textContent = title || S.genericErrorTitle
    errDetail.textContent = detail || ''
    clear(errActions)
    const list = actions.length ? actions : [{ label: S.dismiss }]
    let first = null
    for (const a of list) {
      if (!a || !a.label) continue
      const b = button(a.label, safe(() => { if (a.keepOpen !== true) hideError(); if (a.onClick) a.onClick() }), a.primary ? 'mw-primary' : '')
      errActions.appendChild(b)
      if (!first || a.primary) first = b
    }
    openOverlay(errorO, first)
    return hideError
  }

  // gate
  const gateO = overlay('mw-gate', 'mw-gate-title')
  // dnsUpdate (post-wave fix B): this page asks DNS-over-HTTPS for updates once the visitor chooses Load, so the
  // gate names the service; dohHost replaces the loader's resolvers when the page carries <meta name="mw-doh">.
  // C2 doors: note (the door view's limits, doorText 'door.gateNote') is one more line under the gate's text.
  const showGate = ({ hasWebseed = false, onLoad, onHostOnly, onCancel, details = null, sharedOrigin = false, dnsUpdate = false, dohHost = null, note = null } = {}) => {
    clear(gateO.box)
    gateO.box.appendChild(el('h2', { id: 'mw-gate-title', text: sharedOrigin ? S.hubDetailsTitle : S.gateLoad }))
    gateO.box.appendChild(el('p', { text: S.gateText }))
    if (note) gateO.box.appendChild(el('p', { class: 'mw-note mw-gate-door', text: note }))
    if (dnsUpdate) gateO.box.appendChild(el('p', { class: 'mw-consent-dns', text: S.dohNamed(S.gateDnsUpdate, dohHost) }))
    if (details) {
      const dl = el('dl', { class: 'mw-details' })
      const add = (term, value) => { dl.appendChild(el('dt', { text: term })); dl.appendChild(el('dd', { text: value })) }
      add(S.hubDetailName, details.name || S.hubDetailUnknown)
      add(S.hubDetailBtih, details.btih || S.hubDetailUnknown)
      add(S.hubDetailSize, typeof details.size === 'number' ? formatBytes(details.size) : S.hubDetailUnknown)
      add(S.hubDetailTrackers, details.trackers && details.trackers.length ? details.trackers.join(', ') : S.hubDetailUnknown)
      add(S.hubDetailPublisher, details.publisher || S.hubDetailUnsigned)
      gateO.box.appendChild(dl)
    }
    const actions = el('div', { class: 'mw-actions' })
    const hide = () => closeOverlay(gateO)
    const load = decision(sharedOrigin ? S.hubSharedLoad : S.gateLoad, safe(() => { hide(); if (onLoad) onLoad() }), 'mw-primary')
    actions.appendChild(load)
    if (hasWebseed) actions.appendChild(decision(S.gateHostOnly, safe(() => { hide(); if (onHostOnly) onHostOnly() })))
    actions.appendChild(decision(S.gateCancel, safe(() => { hide(); if (onCancel) onCancel() })))
    gateO.box.appendChild(actions)
    if (sharedOrigin) gateO.box.appendChild(el('p', { class: 'mw-note', text: S.hubSharedBanner }))
    openOverlay(gateO, load)
    return hide
  }

  // C2 doors (S4 D6): "Open a link" on a door's own page (/_mw/open.html without a link): for iOS and Firefox, where a
  // web+felinar: link does nothing. onOpen(text) is called inside the visitor's click; it returns false when the text is not a
  // link to a site (the box says so and stays open). Nothing loads from the box: the page it opens shows the gate first (C3).
  const pasteO = overlay('mw-gate mw-door-paste', 'mw-door-paste-title')
  const showLinkPaste = ({ onOpen, onCancel, lang = null } = {}) => {
    const L = pickLang(lang || uiOpts.lang || (win && win.navigator && win.navigator.language) || 'en')
    clear(pasteO.box)
    pasteO.box.appendChild(el('h2', { id: 'mw-door-paste-title', text: doorText('door.paste.title', L) }))
    pasteO.box.appendChild(el('p', { text: doorText('door.paste.text', L) }))
    const input = el('input', { type: 'url', class: 'mw-input mw-mono', autocomplete: 'off', spellcheck: 'false', inputmode: 'url', 'aria-label': doorText('door.paste.label', L), placeholder: 'https://' })
    const msg = el('p', { class: 'mw-note', 'aria-live': 'polite' })
    const actions = el('div', { class: 'mw-actions' })
    const hide = () => closeOverlay(pasteO)
    const open = decision(doorText('door.paste.open', L), safe(() => {
      const ok = typeof onOpen === 'function' ? onOpen(String(input.value || '').trim()) : false
      if (ok === false) msg.textContent = doorText('door.paste.bad', L)
      else hide()
    }), 'mw-primary')
    actions.appendChild(open)
    actions.appendChild(button(S.gateCancel, safe(() => { hide(); if (onCancel) onCancel() })))
    pasteO.box.appendChild(input)
    pasteO.box.appendChild(msg)
    pasteO.box.appendChild(actions)
    openOverlay(pasteO, input)
    return hide
  }

  // notice (non-blocking)
  const showNotice = ({ onOk, onSettings } = {}) => {
    clear(noticeBox)
    const hide = () => { noticeBox.hidden = true }
    noticeBox.appendChild(el('p', { class: 'mw-notice-text', text: S.noticeText }))
    const actions = el('div', { class: 'mw-actions' })
    actions.appendChild(button(S.noticeSettings, safe(() => { if (onSettings) onSettings(); else openSettings() }), 'mw-link'))
    actions.appendChild(decision(S.noticeOk, safe(() => { hide(); if (onOk) onOk() }), 'mw-primary'))
    noticeBox.appendChild(actions)
    noticeBox.hidden = false
    setCollapsed(false, false)
    return hide
  }

  // first-run card (v0.2.1 C1): the same-layer choice [Share and load] [Load from host only]. Non-blocking in
  // the bar (the site renders from its host meanwhile), or blocking in the gate overlay when nothing can load
  // before the choice (a DNS-only pointer, or a site with no host copy).
  const consentO = overlay('mw-gate mw-consent', 'mw-consent-title')
  let hideConsentCard = null
  // dns: only DNS can find the site, so the lookup comes before the site (both choices allow it); dnsUpdate (post-wave
  // fix B): the page has a page tag but asks DNS-over-HTTPS for updates after "Share and load"; dohHost: see showGate.
  const showConsentCard = ({ hasWebseed = true, mobile = false, dns = false, dnsUpdate = false, dohHost = null, blocking = false, onShare, onHostOnly, onCancel, onSettings } = {}) => {
    if (hideConsentCard) hideConsentCard()
    const box = blocking ? consentO.box : noticeBox
    clear(box)
    let closed = false
    const hide = () => {
      if (closed) return
      closed = true
      if (hideConsentCard === hide) hideConsentCard = null
      if (blocking) closeOverlay(consentO)
      else { noticeBox.hidden = true; clear(noticeBox) }
    }
    box.appendChild(el(blocking ? 'h2' : 'p', { id: blocking ? 'mw-consent-title' : null, class: 'mw-notice-title', text: S.consentTitle }))
    box.appendChild(el('p', { class: 'mw-notice-text', text: S.consentText }))
    if (dns) {
      box.appendChild(el('p', { class: 'mw-notice-text mw-consent-dns', text: S.dohNamed(S.consentDns, dohHost) }))
      box.appendChild(el('p', { class: 'mw-notice-text mw-consent-dns', text: S.consentDnsAgain }))
    } else if (dnsUpdate) {
      box.appendChild(el('p', { class: 'mw-notice-text mw-consent-dns', text: S.dohNamed(S.consentDnsUpdate, dohHost) }))
    }
    if (mobile) box.appendChild(el('p', { class: 'mw-notice-text mw-consent-mobile', text: S.consentMobile }))
    if (hasWebseed) box.appendChild(el('p', { class: 'mw-notice-text', text: S.consentChoice }))
    const actions = el('div', { class: 'mw-actions' })
    // Equal weight on purpose: both choices are primary buttons on the same layer.
    const share = decision(S.consentShare, safe(() => { hide(); if (onShare) onShare() }), 'mw-primary mw-consent-share')
    actions.appendChild(share)
    if (hasWebseed) actions.appendChild(decision(S.consentHostOnly, safe(() => { hide(); if (onHostOnly) onHostOnly() }), 'mw-primary mw-consent-host'))
    if (!hasWebseed || blocking) actions.appendChild(decision(blocking ? S.gateCancel : S.consentNoHost, safe(() => { hide(); if (onCancel) onCancel() }), 'mw-consent-cancel'))
    if (!blocking) actions.appendChild(button(S.consentSettings, safe(() => { if (onSettings) onSettings(); else openSettings() }), 'mw-link'))
    box.appendChild(actions)
    if (blocking) openOverlay(consentO, share)
    else { noticeBox.hidden = false; setCollapsed(false, false) }
    hideConsentCard = hide
    return hide
  }

  // ----- status bar setters -----------------------------------------------------------------------
  const setStatus = (text, level = 'info') => {
    statusEl.textContent = text || ''
    statusEl.className = 'mw-status mw-' + (level || 'info')
    bar.classList.toggle('mw-has-error', level === 'error')
    if (level === 'error' || level === 'warn') setCollapsed(false, false)
  }

  const setProgress = ({ downloaded = 0, total = 0 } = {}) => {
    if (!total || !Number.isFinite(total)) {
      progressEl.classList.add('mw-indeterminate')
      progressEl.removeAttribute('aria-valuenow')
      progressFill.style.width = ''
      progressText.textContent = downloaded ? formatBytes(downloaded) : ''
      return
    }
    const pct = Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)))
    progressEl.classList.remove('mw-indeterminate')
    progressEl.classList.toggle('mw-done', pct >= 100)
    progressEl.setAttribute('aria-valuenow', String(pct))
    progressFill.style.width = pct + '%'
    progressText.textContent = pct >= 100 ? formatBytes(total) : formatBytes(downloaded) + ' / ' + formatBytes(total)
  }

  const setPeers = (n) => {
    const count = Math.max(0, Number(n) || 0)
    peersEl.textContent = S.peers(count)
    pillCount.textContent = String(count)
    bar.classList.toggle('mw-connected', count > 0)
  }

  // The ledger line; while a write's fee is computed it says so instead (code review round 1, item 4).
  let ledgerInfo = null
  let writeInfo = null
  const renderLedger = () => {
    if (writeInfo && typeof S.writeFee === 'function') {
      ledgerEl.hidden = false
      ledgerEl.textContent = S.writeFee(writeInfo)
      return
    }
    if (!ledgerInfo) { ledgerEl.hidden = true; return }
    ledgerEl.hidden = false
    ledgerEl.textContent = S.ledgerLine(ledgerInfo)
  }
  const setLedger = (info) => { ledgerInfo = info || null; renderLedger() }
  const setWriteProgress = (p) => { writeInfo = p && typeof p === 'object' ? p : null; renderLedger() }

  const setIdentity = (id) => {
    if (!id || !id.short) { identityEl.hidden = true; return }
    identityEl.hidden = false
    identityEl.textContent = shortText(S.identity({ short: id.short, name: id.name }), 40)
    identityEl.title = id.role ? 'Role: ' + id.role : ''
  }

  const setSource = (source) => {
    const text = source ? (S.sourceLabel(source) || String(source)) : ''
    sourceEl.hidden = !text
    sourceEl.textContent = text
  }

  const setPointerInfo = (info) => {
    if (!info || !info.text) { pointerEl.hidden = true; return }
    pointerEl.hidden = false
    pointerEl.textContent = info.text
    pointerEl.title = info.title || ''
    pointerEl.classList.toggle('mw-warn', !!info.warn)
  }

  const setMode = ({ degraded = false, hostOnly = false } = {}) => {
    const text = degraded ? S.limitedMode : hostOnly ? S.hostOnlyBadge : ''
    modeEl.hidden = !text
    modeEl.textContent = text
  }

  // Phone line under the bar ("Sharing only while ..." / "On mobile data ... Tap to share.").
  const setSubline = ({ text = null, onTap = null } = {}) => {
    clear(subline)
    if (!text) { subline.hidden = true; return }
    subline.hidden = false
    if (typeof onTap === 'function') subline.appendChild(button(text, safe(onTap), 'mw-link'))
    else subline.appendChild(el('span', { text }))
  }

  // ----- banners ----------------------------------------------------------------------------------
  const bannerEls = new Map()
  const setBanner = (id, text, { actions = [], kind = 'info', dismissible = false } = {}) => {
    const existing = bannerEls.get(id)
    if (!text) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
      bannerEls.delete(id)
      return
    }
    const box = existing || el('div', { class: 'mw-banner', role: kind === 'error' || kind === 'warn' ? 'alert' : 'status' })
    clear(box)
    box.className = 'mw-banner mw-' + kind
    box.dataset.id = id
    box.appendChild(el('span', { class: 'mw-banner-text', text }))
    const acts = el('span', { class: 'mw-banner-actions' })
    for (const a of actions) if (a && a.label) acts.appendChild(button(a.label, safe(a.onClick), 'mw-small' + (a.primary ? ' mw-primary' : '')))
    if (dismissible) acts.appendChild(button(S.dismiss, () => setBanner(id, null), 'mw-small mw-link'))
    box.appendChild(acts)
    if (!existing) { banners.appendChild(box); bannerEls.set(id, box) }
    if (kind === 'warn' || kind === 'error') setCollapsed(false, false)
  }

  // ----- settings -----------------------------------------------------------------------------
  const settingsO = overlay('mw-settings', 'mw-settings-title')
  const handlers = new Set()
  // Settings exist from the first paint ("Starting..."); the loader listens once it knows the site.
  // A change made before that is kept and handed to the first listener instead of being dropped.
  const queued = []
  const deliver = (fn, action, payload) => {
    try {
      const r = fn(action, payload)
      if (r && typeof r.catch === 'function') r.catch((err) => notify('general', (err && err.message) || String(err), 'error'))
    } catch (err) { notify('general', (err && err.message) || String(err), 'error') }
  }
  const onSettingsChange = (fn) => {
    handlers.add(fn)
    const early = queued.splice(0)
    for (const [action, payload] of early) deliver(fn, action, payload)
    return () => handlers.delete(fn)
  }
  const fire = (action, payload) => {
    if (!handlers.size) {
      if (queued.length < 20) queued.push([action, payload || {}])
      return
    }
    for (const fn of handlers) {
      try {
        const r = fn(action, payload || {})
        if (r && typeof r.catch === 'function') r.catch((err) => notify('general', (err && err.message) || String(err), 'error'))
      } catch (err) { notify('general', (err && err.message) || String(err), 'error') }
    }
  }
  const notes = new Map()
  const noteEl = (section) => {
    if (!notes.has(section)) notes.set(section, el('p', { class: 'mw-note', 'aria-live': 'polite' }))
    return notes.get(section)
  }
  const notify = (section, text, kind = 'info') => {
    const n = noteEl(section)
    n.textContent = text || ''
    n.className = 'mw-note mw-' + kind
  }

  const toggle = (id, label, note, onChange) => {
    const input = el('input', { type: 'checkbox', id, class: 'mw-switch', role: 'switch' })
    input.addEventListener('change', () => onChange(input.checked))
    const lab = el('label', { class: 'mw-toggle', for: id }, [input, el('span', { text: label })])
    return { input, node: el('div', { class: 'mw-field' }, [lab, el('p', { class: 'mw-note', text: note })]) }
  }

  const consentAgainBtn = decision(S.settingsConsentAgain, () => { closeSettings(); fire('consent') }, 'mw-link')
  const shareT = toggle('mw-share', S.settingsShareLabel, S.settingsShare, (on) => fire('share', { on }))
  const hostT = toggle('mw-hostonly', S.settingsHostOnlyLabel, S.settingsHostOnly, (on) => fire('hostOnly', { on }))
  const networkT = toggle('mw-network', S.settingsShareOnNetwork, S.settingsShareOnNetworkNote, (on) => fire('shareOnNetwork', { on }))
  // C2 wire-ui (SZ 3.1.3, 3.1.4): "I am on Wi-Fi" and "My phone is plugged in" where the browser cannot tell (iOS,
  // Firefox: no network or battery API), the desktop keeper tab, and dock mode on phones. The declarations last for this
  // page only; nothing is stored. The dock button starts dock mode inside this click (the Wake Lock request).
  const seedLang = pickLang(uiOpts.lang || (win && win.navigator && win.navigator.language) || 'en')
  const declareWifiT = toggle('mw-declare-wifi', seedText('seed.declareWifi', seedLang), '', (on) => fire('declareWifi', { on }))
  const declarePluggedT = toggle('mw-declare-plugged', seedText('seed.declarePlugged', seedLang), '', (on) => fire('declarePlugged', { on }))
  const keeperT = toggle('mw-keeper', seedText('keeper.toggle', seedLang), lastSentence(seedText('seed.ask', seedLang, { cap: '' })), (on) => fire('keeper', { on }))
  const dockBtn = decision(seedText('dock.start', seedLang), () => fire('dock', {}), 'mw-dock-start')
  const dockRow = el('div', { class: 'mw-field mw-dock-row', hidden: true }, [dockBtn])
  const seedLine = el('p', { class: 'mw-note mw-seed-line', hidden: true })
  for (const t of [declareWifiT, declarePluggedT, keeperT]) { t.node.hidden = true; t.input.disabled = true }
  // Until the loader hands over the stored settings (setModel), the switches show the defaults and
  // cannot be changed: nobody should turn off a switch that only looked off.
  shareT.input.checked = true
  for (const t of [shareT, hostT, networkT]) t.input.disabled = true

  const usageEl = el('p', { class: 'mw-value' })
  const persistedEl = el('p', { class: 'mw-note' })
  const iosHint = el('p', { class: 'mw-note', text: S.iosHomeScreen, hidden: true })
  const forgetBtn = button(S.settingsForget, () => fire('forget'), 'mw-danger')

  const identityLine = el('p', { class: 'mw-value' })
  const exportPass = el('input', { type: 'password', class: 'mw-input', autocomplete: 'new-password', 'aria-label': S.settingsPassphrase, placeholder: S.settingsPassphrase })
  const exportBtn = decision(S.settingsExportIdentity, () => fire('exportIdentity', { passphrase: exportPass.value }))
  const importFile = el('input', { type: 'file', class: 'mw-file', accept: '.json,.txt,application/json,text/plain', 'aria-label': S.settingsIdentityFile })
  const importPass = el('input', { type: 'password', class: 'mw-input', autocomplete: 'current-password', 'aria-label': S.settingsPassphrase, placeholder: S.settingsPassphrase })
  const importBtn = decision(S.settingsImportIdentity, async () => {
    const file = importFile.files && importFile.files[0]
    if (!file) { notify('identity', S.settingsIdentityFile + '?', 'error'); return }
    let text = ''
    try { text = await file.text() } catch (err) { notify('identity', (err && err.message) || String(err), 'error'); return }
    fire('importIdentity', { text, passphrase: importPass.value })
  })

  // v0.3 (R 2.3.4, MF-03): when the model says identity.v03, the passphrase and file fields above are not in the
  // page at all; the identity page opens instead. Only the model of a loader without the identity service puts the
  // v0.2.1 fields in, for migrating an old identity (R 2.2.7). v0.3 final integration: they used to be in the DOM,
  // hidden, from the start (E-ID-10 scans the DOM and found them), as the drop-in panel never had them.
  const exportRow = el('div', { class: 'mw-row' }, [exportPass, exportBtn])
  const importRow = el('div', { class: 'mw-row' }, [importFile, importPass, importBtn])
  const openIdentityRow = el('div', { class: 'mw-row', hidden: true }, [decision(uiText('openIdentity', 'en'), () => fire('openIdentity'))])
  const identityRows = el('div', {}, [openIdentityRow])

  const moderatorLine = el('p', { class: 'mw-value' })
  const moderatorText = el('textarea', { class: 'mw-input mw-mono', rows: '3', spellcheck: 'false', autocomplete: 'off', 'aria-label': S.settingsModerator })
  const moderatorBtn = button(S.settingsImportModerator, () => fire('importModerator', { text: moderatorText.value }))
  const moderatorRemove = button(S.settingsRemoveModerator, () => fire('removeModerator'), 'mw-link')

  const ledgerLine = el('p', { class: 'mw-value' })
  const exportLedgerBtn = button(S.settingsExportLedger, () => fire('exportLedger'))

  const diagList = el('ul', { class: 'mw-diag' })
  const diagEmpty = el('p', { class: 'mw-note', text: S.settingsDebugEmpty })
  const logEl = el('pre', { class: 'mw-log', 'aria-label': 'Debug log' })
  const versionEl = el('p', { class: 'mw-note' })
  const closeBtn = button(S.settingsClose, () => closeSettings(), 'mw-primary')

  const section = (title, children) => el('section', { class: 'mw-section' }, [el('h3', { text: title })].concat(children))
  settingsO.box.appendChild(el('h2', { id: 'mw-settings-title', text: S.settingsTitle }))
  settingsO.box.appendChild(section(S.settingsSharing, [shareT.node, hostT.node, networkT.node,
    declareWifiT.node, declarePluggedT.node, keeperT.node, dockRow, seedLine, meterSlot, // C2 wire-ui; the carry meter (C2 integrator)
    consentAgainBtn, noteEl('sharing')]))
  settingsO.box.appendChild(section(S.settingsStorage, [usageEl, persistedEl, iosHint, forgetBtn, noteEl('storage')]))
  // C2 doors (S4 D3): the Doors section (current, owner, guest, ledger, hint doors, last good; copy link with doors).
  const doorsUi = createDoorsUi({ doc, lang: uiOpts.lang || (win && win.navigator && win.navigator.language) || 'en' })
  doorsUi.onAction((action, payload) => fire(action, payload))
  settingsO.box.appendChild(doorsUi.node)
  settingsO.box.appendChild(section(S.settingsIdentity, [identityLine,
    identityRows,
    noteEl('identity')]))
  settingsO.box.appendChild(section(S.settingsModerator, [moderatorLine, moderatorText, el('div', { class: 'mw-row' }, [moderatorBtn, moderatorRemove]), noteEl('moderator')]))
  settingsO.box.appendChild(section(S.settingsLedger, [el('p', { class: 'mw-note', text: S.ledgerInfo }), ledgerLine, exportLedgerBtn, noteEl('ledger')]))
  settingsO.box.appendChild(section(S.settingsDebug, [diagEmpty, diagList, logEl]))
  settingsO.box.appendChild(el('div', { class: 'mw-dialog-foot' }, [versionEl, noteEl('general'), closeBtn]))

  const openSettings = () => { openOverlay(settingsO, closeBtn); fire('open') }
  const closeSettings = () => { closeOverlay(settingsO); fire('close') }
  settingsBtn.addEventListener('click', () => (settingsO.box.hidden ? openSettings() : closeSettings()))
  settingsO.scrim.addEventListener('click', (e) => { if (e.target === settingsO.scrim) closeSettings() })
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!settingsO.box.hidden) closeSettings()
    else if (!errorO.box.hidden) hideError()
  })

  const setModel = (m = {}) => {
    shareT.input.checked = m.share !== false
    shareT.input.disabled = !!m.hostOnly
    hostT.input.checked = !!m.hostOnly
    hostT.input.disabled = !!m.hostOnlyForced
    networkT.node.hidden = !m.isMobile
    networkT.input.checked = !!m.shareOnNetwork
    networkT.input.disabled = false
    // C2 wire-ui: m.seed = { declare: { wifi, plugged } | null, wifi, plugged, keeper: { shown, on, disabled }, dock: { shown, on,
    // supported }, line } (built by src/loader/app.js); every part is optional.
    const sd = m.seed || {}
    const showDeclare = !!sd.declare
    declareWifiT.node.hidden = !(showDeclare && sd.declare.wifi)
    declareWifiT.input.checked = sd.wifi === true
    declareWifiT.input.disabled = !showDeclare
    declarePluggedT.node.hidden = !(showDeclare && sd.declare.plugged)
    declarePluggedT.input.checked = sd.plugged === true
    declarePluggedT.input.disabled = !showDeclare
    const kp = sd.keeper || {}
    keeperT.node.hidden = !kp.shown
    keeperT.input.checked = kp.on === true
    keeperT.input.disabled = !kp.shown || kp.disabled === true
    const dk = sd.dock || {}
    dockRow.hidden = !dk.shown
    dockBtn.disabled = !dk.supported
    dockBtn.textContent = dk.on ? seedText('dock.stop', seedLang) : seedText('dock.start', seedLang)
    seedLine.hidden = !sd.line
    seedLine.textContent = sd.line || ''
    const st = m.storage || {}
    usageEl.textContent = S.settingsStorageUsage(formatBytes(st.usage || 0), st.quota ? formatBytes(st.quota) : null)
    persistedEl.textContent = S.settingsPersisted(m.persisted === true ? true : m.persisted === false ? false : null)
    iosHint.hidden = !m.iosHint
    forgetBtn.disabled = !m.canForget
    const id = m.identity || null
    identityLine.textContent = id && id.short ? S.identity({ short: id.short, name: id.name }) : '-'
    const v03 = !!(id && id.v03 === true)
    // UX-18: with a v0.3 identity there is nothing to export here; the hint points at the recovery kit instead.
    iosHint.textContent = v03 && S.iosHomeScreenV03 ? S.iosHomeScreenV03 : S.iosHomeScreen
    const legacyRows = id && !v03 ? [exportRow, importRow] : []
    while (identityRows.firstChild) identityRows.removeChild(identityRows.firstChild)
    for (const r of legacyRows.concat([openIdentityRow])) identityRows.appendChild(r)
    openIdentityRow.hidden = !v03
    exportBtn.disabled = !(id && id.canExport)
    importBtn.disabled = !(id && id.canImport)
    moderatorLine.textContent = m.moderator && m.moderator.short ? S.settingsModeratorActive(m.moderator.short) : ''
    moderatorRemove.hidden = !(m.moderator && m.moderator.short)
    ledgerLine.textContent = m.ledger ? S.ledgerLine(m.ledger) : S.ledgerUnavailable
    exportLedgerBtn.disabled = !m.ledger
    versionEl.textContent = S.settingsVersion(m.version || '')
  }

  // ----- diagnostics (failure matrix) -----------------------------------------------------------
  const diagRows = new Map()
  const logLines = []
  const maxLog = 300
  const renderDiag = () => {
    clear(diagList)
    for (const [row, detail] of diagRows) {
      const def = (S.matrix && S.matrix[row]) || { label: row, remedy: '' }
      const count = detail && typeof detail === 'object' ? detail.count : undefined
      const label = typeof def.label === 'function' ? def.label(count || 0) : def.label
      const extra = detail && typeof detail === 'object' ? detail.text : (typeof detail === 'string' ? detail : '')
      const info = !!(detail && typeof detail === 'object' && detail.info)
      diagList.appendChild(el('li', { class: 'mw-diag-row' + (info ? ' mw-diag-info' : ''), 'data-row': row }, [
        el('strong', { text: label }),
        extra ? el('span', { class: 'mw-diag-detail', text: ' (' + extra + ')' }) : null,
        def.remedy ? el('span', { class: 'mw-diag-remedy', text: def.remedy }) : null
      ]))
    }
    let problems = 0
    for (const detail of diagRows.values()) if (!(detail && typeof detail === 'object' && detail.info)) problems++
    diagEmpty.hidden = problems > 0
  }
  const diagnostics = {
    set (row, detail) {
      if (detail === null || detail === undefined || detail === false) diagRows.delete(row)
      else diagRows.set(row, detail)
      renderDiag()
    },
    clear () { diagRows.clear(); renderDiag() },
    rows () { return Array.from(diagRows.keys()) },
    log (line) {
      const stamp = new Date().toISOString().slice(11, 23)
      logLines.push(stamp + ' ' + String(line))
      while (logLines.length > maxLog) logLines.shift()
      logEl.textContent = logLines.slice(-80).join('\n')
    },
    lines () { return logLines.slice() }
  }

  // ----- misc ---------------------------------------------------------------------------------
  const download = (filename, text, type = 'application/json') => {
    try {
      const url = win.URL.createObjectURL(new win.Blob([text], { type }))
      const a = el('a', { href: url, download: filename, hidden: true })
      doc.body.appendChild(a)
      a.click()
      doc.body.removeChild(a)
      win.setTimeout(() => win.URL.revokeObjectURL(url), 30000)
      return true
    } catch (_) { return false }
  }

  // After the site renders the bar shrinks to a pill unless the visitor chose otherwise.
  const siteReady = (delayMs = 4000) => {
    if (collapseTimer) win.clearTimeout(collapseTimer)
    if (rememberedCollapse === '0') return
    collapseTimer = win.setTimeout(() => {
      const busy = !noticeBox.hidden || bar.classList.contains('mw-has-error') || banners.querySelector('.mw-warn, .mw-error')
      if (!busy) setCollapsed(true, false)
    }, delayMs)
  }

  setProgress({ downloaded: 0, total: 0 })
  setPeers(0)
  renderDiag()

  let cardsInstance = null
  const getCards = () => {
    if (!cardsInstance) cardsInstance = createCards({ win, doc, actions: uiOpts.actions, lang: uiOpts.lang, strict: uiOpts.strict, now: uiOpts.now, minVisibleMs: uiOpts.minVisibleMs })
    return cardsInstance
  }

  return {
    root,
    bar,
    siteContainer: site,
    setStatus,
    setProgress,
    setPeers,
    setLedger,
    setWriteProgress,
    setIdentity,
    setSource,
    setPointerInfo,
    setMode,
    setSubline,
    // C2 wire-ui (SZ 3.1.4, 3.1.5, 3.3): the upload card, the keeper line, the carry meter and the dim page of dock mode.
    setMeter: seedUi.setMeter,
    setUploads: seedUi.setUploads,
    setKeeper: seedUi.setKeeper,
    setDock: seedUi.setDock,
    showNotice,
    showConsentCard,
    hideConsentCard: () => { if (hideConsentCard) hideConsentCard() },
    // v0.2.1 loader-owned hooks (DIGEST-AMENDMENTS A4, C1): the site can only ask; the loader's own UI acts.
    openConsent: () => fire('consent'),
    openIdentityExport: () => { openSettings(); try { exportPass.focus() } catch (_) { /* hidden */ } },
    showGate,
    showError,
    hideError,
    setBanner,
    // C2 doors: the Doors section of Settings and the "Open a link" box of a door's page.
    setDoors: (model) => doorsUi.setModel(model),
    showLinkPaste,
    setCollapsed,
    siteReady,
    download,
    settings: {
      setModel,
      onChange: onSettingsChange,
      open: openSettings,
      close: closeSettings,
      notify,
      clearInputs () { exportPass.value = ''; importPass.value = ''; moderatorText.value = ''; try { importFile.value = '' } catch (_) { /* ignore */ } }
    },
    diagnostics,
    // v0.3: in-page prompts for the sdk lane (see createCards). Built on first use; uiOpts.actions = { signIn, openIdentity }.
    prompt: (kind, data) => getCards().prompt(kind, data),
    setIdentityHeader: (info, handlers) => getCards().setIdentityHeader(info, handlers),
    get cards () { return getCards() },
    strings: S,
    helpers: STRING_HELPERS
  }
}

// =====================================================================================================
// v0.3 in-page cards (R 2.3.4, 2.4.1, 2.8.4, 2.11.1, MF-03, MF-06, MF-09, MF-27; lane ui).
//
// createCards({ win, doc, lang, actions, ... }) -> { prompt(kind, data) -> Promise, setIdentityHeader(info, handlers),
//   close(), destroy(), rectOf(label), lang, host }
//
// What lives here: a Sign in prompt, the signed-in header, "Tap to finish", consent and upload confirmations,
// moderator cards, notices and offer cards. What does NOT live here (and has no field for it anywhere in this
// file): first sign-in to an origin, "same identity", link a device, show the phrase, first read of the private
// record. Those open at the identity origin (lane idp). No card has a text, password or file input; E-ID-10
// scans the DOM for that.
//
// Every card is in a CLOSED shadow root, is styled only through the CSSOM (a strict CSP is fine), accepts only
// events with isTrusted !== false, and runs the redress checks of src/widget/redress.js before it acts. Those
// checks are speed bumps, not a lock (MF-06): a page that shares this origin can still try other tricks.
// =====================================================================================================

const HIGH_RISK_CARDS = new Set(['signIn', 'passkey', 'twelveWords', 'sameIdentity', 'hubIdentity', 'recoveryKitIos', 'staySignedIn'])

/** Prompt kinds createCards().prompt() accepts (documented in docs/deviations/ui.md). */
export const CARD_KINDS = Object.freeze([
  'signin', 'tap', 'consent', 'confirm', 'upload', 'phone-upload', 'offer', 'owner-changed', 'foreign-address', 'storage-evicted',
  'error', 'mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.decide',
  // C2 wire-ui: mw.net.dock({ hours }) (SZ 3.1.4): keep the screen on and share, started inside the person's click here
  'dock',
  // Code review v0.3: the recovery kit after the first meaningful action (R 2.2.6), and "Continue in this tab" when the
  // sign-in window could not open or lost its opener (the redirect round trip, R 2.3.1)
  'kit', 'continue-here'
])
/** The card kinds another person can make this tab show (a file or media offer): a full queue drops these first (MAL53-10). */
const OFFER_KINDS = new Set(['offer'])

/** After sign-in on a phone the full header folds into a corner chip after this long (code review v0.3, browser). */
export const HEADER_FOLD_MS = 5000
/** The redress notice ("Cancelled: something moved ...") goes away by itself after this long (review round R 5.3, UX-3). */
export const NOTICE_MS = 6000

const CARD_THEMES = {
  light: { bg: '#ffffff', fg: '#1b1f23', muted: '#57606a', border: '#d0d7de', accent: '#0a58ca', accentFg: '#ffffff', soft: '#f3f4f6', danger: '#b42318', shadow: '0 8px 24px rgba(0,0,0,.18)' },
  dark: { bg: '#1c1f24', fg: '#e6edf3', muted: '#9da7b3', border: '#3b434c', accent: '#5b9bff', accentFg: '#08111f', soft: '#272c33', danger: '#ff8a80', shadow: '0 8px 24px rgba(0,0,0,.6)' }
}
const CARD_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

function hash32 (text) {
  let h = 0x811c9dc5
  const t = String(text)
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

function cardError (code, message) {
  const err = new Error(message || code)
  err.code = code
  return err
}

export function createCards (opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null)
  const doc = opts.doc || (win && win.document)
  if (!doc) throw new TypeError('createCards needs a document')
  const actions = opts.actions || {} // { signIn(): Promise, openIdentity(): Promise }  (injected by the sdk lane)
  const strict = opts.strict !== false
  let lang = pickLang(opts.lang || (win && win.navigator && win.navigator.language) || 'en')
  const guardOpts = { strict, now: opts.now, minVisibleMs: opts.minVisibleMs, MutationObserverCtor: opts.MutationObserverCtor }
  let dark = false
  try { dark = Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches) } catch (_) { dark = false }
  const C = dark ? CARD_THEMES.dark : CARD_THEMES.light

  let host = null
  let root = null
  let wrap = null
  let headerSlot = null
  let promptSlot = null
  let current = null // { kind, el, settle, guards }
  let header = null // { el, info, handlers, guards, chip, timer }
  let notice = null // { el, timer }: the redress notice (UX-3)
  let listening = false // the resize listeners of relayout() (UX-1, UX-2)
  const queue = []
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (t) => clearTimeout(t)
  const foldMs = opts.headerFoldMs === undefined ? HEADER_FOLD_MS : opts.headerFoldMs

  const T = (key, params) => uiText(key, lang, params)
  const K = (key, params) => cardText(key, lang, params)

  const css = (el, style) => {
    for (const k of Object.keys(style)) {
      const v = style[k]
      if (Array.isArray(v)) el.style.setProperty(k, v[0], v[1] || '')
      else el.style.setProperty(k, v)
    }
  }
  const h = (tag, style, text, attrs, kids) => {
    const el = doc.createElement(tag)
    if (style) css(el, style)
    if (text !== undefined && text !== null) el.textContent = String(text)
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k])
    for (const c of kids || []) if (c) el.appendChild(c)
    return el
  }
  const clearNode = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild) }
  const BASE = { all: 'initial', 'box-sizing': 'border-box', display: 'block' }
  const cardStyle = Object.assign({}, BASE, { 'pointer-events': 'auto', width: '100%', 'max-width': '640px', margin: '0 auto 8px', padding: '12px 14px', background: C.bg, color: C.fg, border: '1px solid ' + C.border, 'border-radius': '10px', 'box-shadow': C.shadow, font: '14px/1.45 ' + CARD_FONT })
  const buttonStyle = (primary, danger) => ({ all: 'initial', 'box-sizing': 'border-box', display: 'inline-block', cursor: 'pointer', 'min-height': '44px', 'min-width': '44px', padding: '9px 16px', margin: '0 8px 8px 0', 'border-radius': '6px', border: '1px solid ' + (primary ? (danger ? C.danger : C.accent) : C.border), background: primary ? (danger ? C.danger : C.accent) : C.soft, color: primary ? C.accentFg : C.fg, font: '600 14px/1.4 ' + CARD_FONT })

  function ensureHost () {
    if (host) return
    host = doc.createElement('div')
    host.setAttribute('data-mw-ui-cards', '')
    host.setAttribute('data-nosnippet', '')
    css(host, { all: ['initial', 'important'], position: ['fixed', 'important'], left: ['0', 'important'], right: ['0', 'important'], bottom: ['0', 'important'], 'z-index': ['2147483000', 'important'], 'pointer-events': ['none', 'important'], display: ['block', 'important'] })
    root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host
    if (root !== host) adoptFocusRing(root, C.accent) // a visible focus ring despite the inline all: initial (WCAG 2.4.7)
    // The bottom padding keeps the cards above the home indicator of phones without a home button (safe area).
    wrap = h('div', Object.assign({}, BASE, { width: '100%', padding: '12px 12px calc(4px + env(safe-area-inset-bottom, 0px))', 'pointer-events': 'none' }))
    wrap.setAttribute('lang', lang) // the cards' language inside a page in another one (WCAG 3.1.2, accessibility lane)
    // C2 integrator: the slots are layout boxes as wide as the viewport; BASE's all: initial gave them pointer-events: auto, so the
    // strip beside a card swallowed clicks meant for the site (e2e E-CL-*: the identity card blocked a site button 160 px to
    // its left). Only the cards themselves (cardStyle) take pointer events.
    headerSlot = h('div', Object.assign({}, BASE, { 'pointer-events': 'none' }))
    promptSlot = h('div', Object.assign({}, BASE, { 'pointer-events': 'none' }))
    wrap.appendChild(headerSlot)
    wrap.appendChild(promptSlot)
    root.appendChild(wrap)
  }
  function mount () {
    ensureHost()
    const parent = doc.body || doc.documentElement
    if (parent && !host.parentNode) parent.appendChild(host)
    if (!listening) {
      listening = true
      if (win && typeof win.addEventListener === 'function') { try { win.addEventListener('resize', onViewport) } catch (_) { /* none */ } }
      const vv = win && win.visualViewport
      if (vv && typeof vv.addEventListener === 'function') { try { vv.addEventListener('resize', onViewport) } catch (_) { /* none */ } }
    }
  }
  function unmountIfEmpty () {
    if (host && host.parentNode && !current && !header && !notice) {
      host.parentNode.removeChild(host)
      if (win && typeof win.removeEventListener === 'function') { try { win.removeEventListener('resize', onViewport) } catch (_) { /* gone */ } }
      const vv = win && win.visualViewport
      if (vv && typeof vv.removeEventListener === 'function') { try { vv.removeEventListener('resize', onViewport) } catch (_) { /* gone */ } }
      listening = false
    }
  }

  // Review round R 5.3 (UX-1, UX-2): the redress guards compare a button's position with the one taken when it was shown.
  // The loader moves its own buttons (a card shown or closed under the header, a status line, the header folding, a
  // rotated phone), so after each such change every live guard takes the position again and restarts its minVisibleMs
  // window; a move nobody here made still cancels. A synthetic resize event (isTrusted false) is ignored.
  function relayout () {
    if (header && !header.folded) for (const g of header.guards) g.rebase()
    if (current) for (const g of current.guards) g.rebase()
  }
  function onViewport (ev) {
    if (ev && ev.isTrusted === false) return
    relayout()
  }

  // A button that acts only on the person's own input, only after the redress checks pass (MF-06).
  // onClick runs synchronously inside the click, so transient activation is still present for popups.
  // onCancel: what a failed check closes. A card's guard closes that card; the header's guards close nothing but say why
  // (UX-1: a guard of one slot never finishes the card of the other).
  function makeButton (label, primary, onClick, guardList, { danger = false, onCancel = null } = {}) {
    const btn = h('button', buttonStyle(primary, danger), label, { type: 'button' })
    const guard = createGuard(Object.assign({ win, doc, host, button: btn, onCancel: typeof onCancel === 'function' ? onCancel : () => notifyRedress() }, guardOpts))
    guardList.push(guard)
    btn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return // a script made this click: ignore
      if (!guard.check()) return // too soon, or cancelled by a failed check (onCancel already ran)
      onClick(ev)
    })
    return btn
  }

  function redressStop (c) {
    // A check of this card failed: close it without acting and say why.
    if (c && !c.done) finish(c, false)
    notifyRedress()
  }
  // UX-3: the notice goes away by itself after NOTICE_MS or on OK, and the host is unmounted when nothing else is shown;
  // before, it stayed over the bottom of the site, taking its taps, for the rest of the session.
  function notifyRedress () {
    if (!promptSlot) return
    dismissNotice(false)
    mount()
    const ok = h('button', buttonStyle(false, false), T('ok'), { type: 'button' })
    const el = h('div', cardStyle, null, { role: 'alert', 'data-mw-notice': 'redress' }, [h('p', Object.assign({}, BASE, { margin: '0 0 8px' }), T('redressCancelled')), ok])
    ok.addEventListener('click', () => dismissNotice(true)) // dismissing acts on nothing, so no guard
    notice = { el, timer: setT(() => dismissNotice(true), NOTICE_MS) }
    promptSlot.appendChild(el)
    // The header's guards were re-armed: after a false alarm Sign out works again (UX-1).
    if (header && !header.folded) for (const g of header.guards) if (g.cancelled) g.start()
    relayout()
  }
  function dismissNotice (layout) {
    if (!notice) return
    const n = notice
    notice = null
    if (n.timer) clearT(n.timer)
    if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el)
    if (layout) { unmountIfEmpty(); relayout() }
  }

  function finish (c, value) {
    if (!c || c.done) return
    c.done = true
    for (const g of c.guards) g.stop()
    if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el)
    if (current === c) current = null
    c.resolve(value)
    unmountIfEmpty()
    pump()
    relayout() // the header above moved down (UX-1)
    // UX-17: focus goes back where it was before the card, once no other card took over (a queued one inherits it).
    if (current && current !== c) { if (!current.returnFocus) current.returnFocus = c.returnFocus } else restoreFocus(c.returnFocus)
  }

  function inPage (el) {
    for (let n = el, i = 0; n && i < 256; n = n.parentNode, i++) if (n === doc) return true
    return false
  }
  function restoreFocus (el) {
    try {
      if (!el || el === host || typeof el.focus !== 'function' || !inPage(el)) return
      const active = doc.activeElement
      if (active && active !== host && active !== doc.body && active !== el && inPage(active)) return // the person moved on
      el.focus()
    } catch (_) { /* focus is a courtesy */ }
  }

  function pump () {
    if (current || !queue.length) return
    const next = queue.shift()
    show(next)
  }

  function para (text, muted) {
    return h('p', Object.assign({}, BASE, { margin: '0 0 10px', color: muted ? C.muted : C.fg, font: (muted ? '13px/1.4 ' : '14px/1.45 ') + CARD_FONT }), text)
  }
  const heading = (text) => h('div', Object.assign({}, BASE, { font: '700 15px/1.4 ' + CARD_FONT, margin: '0 0 4px' }), text)
  const rowOf = (kids) => h('div', Object.assign({}, BASE, { margin: '2px 0 0' }), null, null, kids)

  // spec -> { title, paras:[{text, muted}], buttons:[{label, primary, danger, run(settle, c, btn)}], role, focus }
  function show (entry) {
    ensureHost()
    const spec = entry.spec
    const c = { kind: entry.kind, el: null, guards: [], resolve: entry.resolve, done: false, returnFocus: null }
    try { const a = doc.activeElement; if (a && a !== host && a !== doc.body && inPage(a)) c.returnFocus = a } catch (_) { /* none */ }
    const buttons = spec.buttons.map((b) => {
      const btn = makeButton(b.label, b.primary, () => b.run({ settle: (v) => finish(c, v), card: c, button: btn, setStatus }), c.guards, { danger: b.danger, onCancel: () => redressStop(c) })
      if (typeof b.pressed === 'boolean') btn.setAttribute('aria-pressed', String(b.pressed)) // C2 wire-ui: a declaration toggle
      b.el = btn
      return btn
    })
    let statusEl = null
    function setStatus (text, kind) {
      if (!statusEl) return
      statusEl.textContent = String(text || '')
      statusEl.setAttribute('data-kind', kind || 'info')
      relayout() // a longer status line grows the card upward (UX-2)
    }
    // UX-2: one line is reserved from the start, so the usual status ("Opening the identity page...", an error) does not
    // move the buttons; a longer one is followed by relayout() above.
    statusEl = h('div', Object.assign({}, BASE, { font: '13px/1.4 ' + CARD_FONT, color: C.muted, margin: '4px 0 0', 'min-height': '1.4em' }), '', { role: 'status', 'aria-live': 'polite' })
    const el = h('div', cardStyle, null, { role: spec.role || 'dialog', 'aria-label': spec.title, 'data-mw-card': entry.kind }, [
      spec.title ? heading(spec.title) : null,
      ...spec.paras.filter(Boolean).map((p) => para(p.text, p.muted)),
      rowOf(buttons),
      statusEl
    ])
    el.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Escape') finish(c, false) })
    c.el = el
    current = c
    dismissNotice(false)
    clearNode(promptSlot)
    promptSlot.appendChild(el)
    mount()
    for (const g of c.guards) g.start()
    relayout() // the header above moved up (UX-1)
    try {
      const f = spec.buttons.find((b) => b.focus) || spec.buttons[0]
      if (f && f.el && typeof f.el.focus === 'function') f.el.focus()
    } catch (_) { /* focus is a courtesy */ }
  }

  const cancelBtn = (label) => ({ label: label || T('cancel'), primary: false, focus: true, run: ({ settle }) => settle(false) })
  const trunc = (v, n = 80) => shortText(v, n)

  function specFor (kind, data) {
    const d = data && typeof data === 'object' ? data : {}
    const person = () => trunc(d.name || d.short || '?', 40)
    switch (kind) {
      case 'signin':
      case 'storage-evicted': {
        const evicted = kind === 'storage-evicted' || d.evicted === true
        const method = d.method === 'openIdentity' ? 'openIdentity' : 'signIn'
        return {
          title: T('signInTitle'),
          paras: [
            evicted ? { text: T('evicted') } : null,
            { text: T('signInOpens') },
            { text: K('neverWords'), muted: true },
            { text: T('signinInfo'), muted: true }
          ],
          buttons: [
            {
              label: T('signInButton'),
              primary: true,
              run: ({ settle, button, setStatus }) => {
                const fn = actions[method]
                if (typeof fn !== 'function') { setStatus(errorText('E_UNSUPPORTED', lang), 'error'); return }
                setStatus(T('signingIn'))
                let p
                try { p = Promise.resolve(fn(d.options)) } catch (err) { p = Promise.reject(err) }
                p.then((res) => settle(res === undefined || res === null ? true : res), (err) => {
                  const code = err && err.code
                  if (code === 'E_USER_CANCELLED') { settle(false); return }
                  // The window did not open even inside this click, or it lost its link to the page and never answered:
                  // the loader offers the redirect round trip on a card of its own (MwApi.openSignInCard, R 2.3.1).
                  if (method === 'signIn' && (code === 'E_POPUP_BLOCKED' || code === 'E_IDP_UNREACHABLE')) { settle({ fallback: 'redirect', code }); return }
                  setStatus(errorText(code || 'E_IDP_UNREACHABLE', lang), 'error')
                })
              }
            },
            cancelBtn()
          ]
        }
      }
      case 'kit':
        return {
          title: T('kitTitle'),
          paras: [{ text: T('kitPromptText') }, { text: K('neverWords'), muted: true }],
          buttons: [{
            label: T('kitButton'),
            primary: true,
            run: ({ settle, setStatus }) => {
              const fn = actions.openIdentity
              if (typeof fn !== 'function') { setStatus(errorText('E_UNSUPPORTED', lang), 'error'); return }
              let p
              try { p = Promise.resolve(fn({ intent: 'kit' })) } catch (err) { p = Promise.reject(err) }
              p.then((res) => settle(res !== 'cancelled'), (err) => setStatus(errorText((err && err.code) || 'E_IDP_UNREACHABLE', lang), 'error'))
            }
          }, { label: T('later'), primary: false, focus: true, run: ({ settle }) => settle(false) }]
        }
      case 'continue-here':
        return {
          title: T('continueHereTitle'),
          paras: [{ text: T('continueHereText') }, { text: K('neverWords'), muted: true }],
          buttons: [{
            label: T('continueHere'),
            primary: true,
            run: ({ settle, setStatus }) => {
              const fn = actions.signIn
              if (typeof fn !== 'function') { setStatus(errorText('E_UNSUPPORTED', lang), 'error'); return }
              setStatus(T('signingIn'))
              let p
              try { p = Promise.resolve(fn(Object.assign({}, d.options || {}, { redirect: true }))) } catch (err) { p = Promise.reject(err) }
              // The page navigates to the identity origin; this only settles when the redirect could not start.
              p.then((res) => settle(res === undefined || res === null ? true : res), (err) => {
                const code = err && err.code
                if (code === 'E_USER_CANCELLED') { settle(false); return }
                setStatus(errorText(code || 'E_IDP_UNREACHABLE', lang), 'error')
              })
            }
          }, cancelBtn()]
        }
      case 'tap':
        return {
          title: T('tapToFinish'),
          paras: [{ text: d.text ? trunc(d.text, 200) : T('tapToFinishText') }],
          buttons: [{
            label: T('tapToFinish'),
            primary: true,
            run: ({ settle, setStatus }) => {
              let p
              try { p = Promise.resolve(typeof d.run === 'function' ? d.run() : true) } catch (err) { p = Promise.reject(err) }
              p.then((res) => settle(res === undefined || res === null ? true : res), (err) => setStatus(errorText((err && err.code) || 'E_IDP_UNREACHABLE', lang), 'error'))
            }
          }, cancelBtn()]
        }
      case 'consent': {
        const key = String(d.card || '')
        if (!Object.prototype.hasOwnProperty.call(CARD_TEXT.en, key) || HIGH_RISK_CARDS.has(key)) throw cardError('E_BAD_REQUEST', 'unknown or identity-origin-only card: ' + key)
        return {
          title: d.title ? trunc(d.title, 80) : null,
          paras: [{ text: K(key, d.params) }],
          buttons: [{ label: d.confirmLabel ? trunc(d.confirmLabel, 40) : T('continue'), primary: true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      }
      case 'confirm':
        return {
          title: trunc(d.title || '', 120),
          paras: [{ text: trunc(d.text || '', 600) }],
          buttons: [{ label: d.confirmLabel ? trunc(d.confirmLabel, 40) : T('continue'), primary: true, danger: d.danger === true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      case 'upload': {
        const priv = d.visibility === 'private'
        // Code review v0.3 (conformance, MF-57): "details were removed" only when the stripper removed something (images,
        // MP4, MOV, WebM); every other file goes as it is, and the card says documents and archives can carry a name or
        // a location. d.removed: the list the lane reported; d.stripped: true when it is not empty.
        const stripped = d.stripped === true || (Array.isArray(d.removed) && d.removed.length > 0)
        return {
          title: priv ? T('uploadTitlePrivate') : T('uploadTitlePublic'),
          paras: [
            { text: T('uploadDetail', { name: trunc(d.name || '?', 60), size: formatBytes(Number(d.size)), type: trunc(d.type || '?', 40) }) },
            { text: K(priv ? 'privateUpload' : 'publicUpload') },
            stripped ? { text: T('uploadStripped'), muted: true } : { text: T('uploadAsIs'), muted: priv },
            // Review round R 5.3 (PRIV-5): a kind of file no stripper reads was not checked for location or camera details.
            d.unchecked === true && !stripped ? { text: T('uploadUnchecked') } : null
          ],
          buttons: [{ label: T('continue'), primary: true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      }
      case 'phone-upload':
        return {
          title: T('phoneTitle'),
          paras: [{ text: K('phoneUpload') }, d.name ? { text: trunc(d.name, 60), muted: true } : null],
          buttons: [{ label: T('phoneConfirm'), primary: true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      case 'offer': {
        const media = d.kind === 'media'
        return {
          title: T(media ? 'offerTitleMedia' : 'offerTitleFile', { from: trunc(d.from || '?', 40) }),
          paras: [
            { text: T('offerDetail', { name: trunc(d.name || '?', 60), size: formatBytes(Number(d.size)), type: trunc(d.type || '?', 40) }) },
            { text: K('fetchPublic'), muted: true }
          ],
          // never auto-accepted (MAL A8): no timer, the safe button has the focus
          buttons: [{ label: T('accept'), primary: false, run: ({ settle }) => settle(true) }, { label: T('decline'), primary: false, focus: true, run: ({ settle }) => settle(false) }]
        }
      }
      case 'owner-changed':
        return { title: null, role: 'alertdialog', paras: [{ text: T('ownerChanged', { minutes: Math.max(0, Math.floor(Number(d.minutes) || 0)) }) }], buttons: [{ label: T('ok'), primary: true, run: ({ settle }) => settle(true) }] }
      case 'foreign-address':
        return { title: null, role: 'alertdialog', paras: [{ text: T('foreignAddress') }], buttons: [{ label: T('ok'), primary: true, run: ({ settle }) => settle(true) }] }
      case 'error':
        return { title: null, role: 'alert', paras: [{ text: errorText(String(d.code || ''), lang, d.params) }], buttons: [{ label: T('ok'), primary: true, run: ({ settle }) => settle(true) }] }
      case 'mod.ban': {
        const until = d.until ? T('modBanUntil', { date: new Date(Number(d.until)).toISOString().slice(0, 10) }) : T('modBanForever')
        return {
          title: T('modBanTitle', { name: person() }),
          paras: [{ text: T('modBanText', { name: person(), short: trunc(d.short || '?', 24), until }) }],
          buttons: [{ label: T('modConfirm'), primary: true, danger: true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      }
      case 'mod.unban':
        return {
          title: T('modUnbanTitle', { name: person() }),
          paras: [{ text: T('modUnbanText', { name: person(), short: trunc(d.short || '?', 24) }) }],
          buttons: [{ label: T('modConfirm'), primary: true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      case 'mod.tombstoneMany': {
        const count = Array.isArray(d.authors) ? d.authors.length : Math.max(0, Math.floor(Number(d.count) || 0))
        const before = d.before ? T('modTombstoneBefore', { date: new Date(Number(d.before)).toISOString().slice(0, 10) }) : ''
        return {
          title: T('modTombstoneTitle', { count }),
          paras: [{ text: T('modTombstoneText', { count, before }) }],
          buttons: [{ label: T('modConfirm'), primary: true, danger: true, run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      }
      case 'dock': {
        // C2 wire-ui (SZ 3.1.4, S1 D3): data { ms, until, declare, start(declared) -> Promise<dock state> }. The start
        // button calls start() inside the person's click, so the Wake Lock request leaves before any await. Where the
        // browser cannot read the battery or the network (declare: true), the person first says "I am on Wi-Fi" and "My
        // phone is plugged in" with two toggle buttons (no input field in any card). A refused start keeps the card open
        // with the reason (dock.refused.*); the card answers the started state, or false when cancelled.
        const declare = d.declare === true
        const said = { wifi: false, plugged: false }
        const ms = Number(d.ms) > 0 ? Number(d.ms) : 7200000
        const until = Number(d.until) > 0 ? Number(d.until) : Date.now() + ms
        const S2 = (key, params) => seedText(key, lang, params)
        const toggleBtn = (key, which) => ({
          label: S2(key),
          primary: false,
          pressed: false,
          run: ({ button }) => { said[which] = !said[which]; button.setAttribute('aria-pressed', String(said[which])) }
        })
        const buttons = []
        if (declare) buttons.push(toggleBtn('seed.declareWifi', 'wifi'), toggleBtn('seed.declarePlugged', 'plugged'))
        buttons.push({
          label: Math.abs(ms - 7200000) < 1000 ? S2('dock.start') : T('continue'),
          primary: true,
          run: ({ settle, setStatus }) => {
            if (declare && !(said.wifi && said.plugged)) { setStatus(S2('dock.refused.declare'), 'error'); return }
            let p
            try { p = Promise.resolve(typeof d.start === 'function' ? d.start(declare) : null) } catch (err) { p = Promise.reject(err) }
            p.then((st) => {
              if (st && st.on) { settle(st); return }
              const reason = st && typeof st.reason === 'string' ? st.reason : 'denied'
              setStatus(S2('dock.refused.' + reason) || S2('dock.refused.denied'), 'error')
            }, () => setStatus(S2('dock.refused.denied'), 'error'))
          }
        })
        buttons.push(cancelBtn())
        return { title: null, paras: [{ text: S2('dock.on', { time: clockText(until, lang) }) }], buttons }
      }
      case 'mod.decide': {
        const dec = { accept: 'decisionAccept', decline: 'decisionDecline', deny: 'decisionDeny' }[d.decision]
        if (!dec) throw cardError('E_BAD_REQUEST', 'unknown decision')
        const decision = T(dec)
        const reason = d.reason ? T('modDecideReason', { reason: trunc(d.reason, 120) }) : ''
        return {
          title: T('modDecideTitle', { decision: decision.charAt(0).toUpperCase() + decision.slice(1), kind: trunc(d.kind || '?', 24) }),
          paras: [{ text: T('modDecideText', { decision, reason }) }],
          buttons: [{ label: T('modConfirm'), primary: true, danger: d.decision !== 'accept', run: ({ settle }) => settle(true) }, cancelBtn()]
        }
      }
      default:
        throw cardError('E_BAD_REQUEST', 'unknown card kind ' + kind)
    }
  }

  function prompt (kind, data) {
    let spec
    try { spec = specFor(String(kind), data) } catch (err) { return Promise.reject(err) }
    return new Promise((resolve) => {
      const entry = { kind: String(kind), spec, resolve }
      if (current || queue.length) {
        if (queue.length >= 8) {
          // MAL53-10: a flood of offers from a contact must not decline the next consent or sign-in card. A full queue
          // makes room by declining its newest offer when the new card is not an offer; another offer is declined.
          const isOffer = (k) => OFFER_KINDS.has(k)
          let at = -1
          if (!isOffer(entry.kind)) for (let i = queue.length - 1; i >= 0; i--) if (isOffer(queue[i].kind)) { at = i; break }
          if (at < 0) { resolve(false); return }
          const [dropped] = queue.splice(at, 1)
          try { dropped.resolve(false) } catch (_) { /* its caller's bug */ }
        }
        queue.push(entry)
        return
      }
      show(entry)
    })
  }

  // ---- the signed-in header --------------------------------------------------------------------
  function identicon (seedText) {
    const hsh = hash32(seedText)
    const hue = hsh % 360
    const fg = 'hsl(' + hue + ', 60%, ' + (dark ? '65%' : '40%') + ')'
    const box = h('div', { all: 'initial', display: 'grid', 'grid-template-columns': 'repeat(5, 8px)', 'grid-auto-rows': '8px', width: '40px', height: '40px', background: C.soft, 'border-radius': '6px', overflow: 'hidden', 'flex-shrink': '0' }, null, { role: 'img', 'aria-label': T('identiconLabel') })
    let bits = hash32(seedText + ':2') ^ (hsh << 3)
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const mc = col < 3 ? col : 4 - col // mirror: columns 3 and 4 copy 1 and 0
        const on = ((hsh >>> (row * 3 + mc)) ^ (bits >>> (row + mc))) & 1
        box.appendChild(h('div', { all: 'initial', display: 'block', background: on ? fg : 'transparent' }))
      }
    }
    return box
  }

  function modeText (info) {
    if (info.mode === 'same') return T('modeSame', { origin: trunc(info.origin || '?', 40) })
    if (info.mode === 'hub') return T('modeHub', { hub: trunc(info.hub || '?', 40) })
    return T('modePrivate')
  }
  const unlockText = (u) => (u === 'passkey' ? T('unlockPasskey') : u === 'passphrase' ? T('unlockPassphrase') : T('unlockVisit'))

  /** compactScreen() -> true on a coarse pointer or a narrow viewport (phones): the header folds there. */
  function compactScreen () {
    try {
      if (win && typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches) return true
      const w = Number(win && win.innerWidth)
      return w > 0 && w < 720
    } catch (_) { return false }
  }

  function dropHeader () {
    if (!header) return
    if (header.timer) clearT(header.timer)
    for (const g of header.guards) g.stop()
    if (header.el.parentNode) header.el.parentNode.removeChild(header.el)
    if (header.chip && header.chip.parentNode) header.chip.parentNode.removeChild(header.chip)
    header = null
  }

  /**
   * foldHeader(): the full header gives way to a 44 px corner chip (the identicon) at the right; a tap on it shows the
   * header again for a while. On phones a full-width card over the bottom of the site took the taps of its own bottom
   * bar for the whole session (code review v0.3, browser: 0 of 3 taps reached the site at 390 x 844).
   */
  function foldHeader () {
    if (!header || header.folded) return
    header.timer = null
    for (const g of header.guards) g.stop()
    if (header.el.parentNode) header.el.parentNode.removeChild(header.el)
    if (!header.chip) {
      const info = header.info
      const chip = h('button', { all: 'initial', 'box-sizing': 'border-box', display: 'block', cursor: 'pointer', width: '44px', height: '44px', padding: '2px', margin: '0 0 8px auto', 'border-radius': '10px', border: '1px solid ' + C.border, background: C.bg, 'box-shadow': C.shadow, 'pointer-events': 'auto' }, null,
        { type: 'button', 'aria-label': T('headerShow') + ': ' + trunc(info.name || info.short || '?', 40), 'aria-expanded': 'false', 'data-mw-header-chip': '' },
        [identicon(info.pub || info.short || info.name || '?')])
      chip.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return // a script made this click: ignore
        unfoldHeader()
      })
      header.chip = chip
    }
    headerSlot.appendChild(header.chip)
    header.folded = true
  }

  function unfoldHeader () {
    if (!header || !header.folded) return
    if (header.chip && header.chip.parentNode) header.chip.parentNode.removeChild(header.chip)
    headerSlot.appendChild(header.el)
    header.folded = false
    for (const g of header.guards) g.start()
    header.timer = setT(foldHeader, foldMs)
  }

  function setIdentityHeader (info, handlers) {
    dropHeader()
    if (!info) { unmountIfEmpty(); return }
    ensureHost()
    const hd = handlers || {}
    const guards = []
    const meta = (text) => h('div', Object.assign({}, BASE, { font: '13px/1.4 ' + CARD_FONT, color: C.muted }), text)
    const signOut = makeButton(T('signOut'), false, () => { if (typeof hd.onSignOut === 'function') hd.onSignOut() }, guards)
    const remove = makeButton(T('removeFromDevice'), false, () => {
      // a low-risk confirmation; the effect list is in R 2.15 ("Remove from this device")
      prompt('confirm', { title: T('removeFromDeviceTitle'), text: T('removeFromDeviceText'), confirmLabel: T('removeFromDevice'), danger: true }).then((ok) => { if (ok && typeof hd.onRemove === 'function') hd.onRemove() })
    }, guards)
    const el = h('div', Object.assign({}, cardStyle, { display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '12px' }), null, { role: 'region', 'aria-label': T('signedInAs'), 'data-mw-header': '' }, [
      identicon(info.pub || info.short || info.name || '?'),
      h('div', Object.assign({}, BASE, { flex: '1 1 200px', 'min-width': '0' }), null, null, [
        h('div', Object.assign({}, BASE, { font: '700 14px/1.4 ' + CARD_FONT }), trunc(info.name || info.short || '?', 40) + '  ' + trunc(info.short || '', 24)),
        meta(modeText(info)),
        meta(unlockText(info.unlock) + ' / ' + (info.backup === true ? T('backupSaved') : T('backupMissing')))
      ]),
      h('div', BASE, null, null, [signOut, remove])
    ])
    headerSlot.appendChild(el)
    header = { el, info, handlers: hd, guards, chip: null, timer: null, folded: false }
    mount()
    for (const g of guards) g.start()
    // Phones: shown once after sign-in, then folded into the corner chip (never a full-width card over the site).
    if (compactScreen()) header.timer = setT(foldHeader, foldMs)
  }

  function close () {
    queue.length = 0
    if (current) finish(current, false)
  }

  function destroy () {
    close()
    dropHeader()
    dismissNotice(true) // clears its timer, and the resize listeners go with the host
    if (host && host.parentNode) host.parentNode.removeChild(host)
    host = null; root = null; wrap = null; headerSlot = null; promptSlot = null
  }

  function findButton (node, label) {
    if (!node || !node.children) return null
    for (const c of node.children) {
      if (c.tagName === 'BUTTON' && c.textContent === label) return c
      const deeper = findButton(c, label)
      if (deeper) return deeper
    }
    return null
  }
  function rectOf (label) {
    const b = findButton(wrap, label)
    if (!b || typeof b.getBoundingClientRect !== 'function') return null
    const r = b.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }

  return {
    prompt,
    setIdentityHeader,
    close,
    destroy,
    rectOf,
    checkElement,
    get lang () { return lang },
    set lang (v) { lang = pickLang(v); if (wrap) wrap.setAttribute('lang', lang) },
    get host () { return host },
    get open () { return current ? current.kind : null },
    /** 'full' | 'folded' | null: the signed-in header's form (tests, the e2e probe). */
    get headerState () { return header ? (header.folded ? 'folded' : 'full') : null },
    kinds: CARD_KINDS,
    strings: { UI_TEXT, fmt }
  }
}
