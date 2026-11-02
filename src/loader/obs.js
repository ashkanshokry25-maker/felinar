// src/loader/obs.js: the usage reporter of the loader, the apps and the identity page (plan obs-2026-11-02, lane L1).
//
// A site owner can turn usage reports on for a site, a door or an identity page (an `obs` block in /_mw/door.json). When they
// are on, this module queues what the page does (steps, controls used, state changes, errors, WebRTC states by candidate
// type), batches it and posts it to the endpoint the owner runs. One rule decides every detail: a report never carries an
// address and never carries content. Plan section 4 lists the fields; safeField() below enforces that list for every string
// that is queued, and the endpoint enforces it a second time.
//
//   createReporter(opts)        the queue, the consent switch, the batches and the transport
//   describeTarget(el)          what a click was on, from the page's own data attributes (never a value, never typed text)
//   wrapPeerConnection(win, r)  ICE states and candidate types of every RTCPeerConnection, never an address
//   safeField(v)                one field value: a string masked and cut, a finite number, a boolean, null, else null
//   OBS_LIMITS                  the caps
//
// Everything that touches the page is injected (clock, random source, timers, transport, navigator), so the unit tests need no
// browser. The file has no imports, so the identity page build can bundle it as it is. Regular expressions here avoid
// lookbehind (the browser floor includes Safari 15.4): a boundary is a captured character that the replacement puts back.

/** The caps. flushMs: the timer between batches. maxBatch and maxBodyBytes: one batch. maxQueue: events held before a send. maxRetries: tries per batch. */
export const OBS_LIMITS = Object.freeze({ flushMs: 2000, maxBatch: 50, maxQueue: 500, maxField: 200, maxBodyBytes: 16384, maxRetries: 3 })

const MASK = 'x.x.x.x'
const TEXT_MAX = 24
const EVENT_MAX_KEYS = 12
const NAME_RE = /^[a-z][a-z0-9.-]{1,48}$/
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const SID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz23456789'
const SID_LENGTH = 12
const PAGES = ['site', 'door', 'hub', 'idp']
// The envelope fields that no mask looks at are checked against the shapes they really have, and the endpoint checks the same shapes: a
// version, the short id of an identity (two groups of 4 from the 32 characters the identity page's shortId draws from: letters but l and
// o, digits 2 to 9), and the words navigator.connection has.
const LOADER_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:[-+][0-9A-Za-z.]{1,8})?$/
const WHO_RE = /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/
const NET_TYPES = ['bluetooth', 'cellular', 'ethernet', 'mixed', 'none', 'other', 'unknown', 'wifi', 'wimax']
const NET_EFFECTIVE = ['slow-2g', '2g', '3g', '4g', 'unknown']
/** A send that never answers is treated as failed after this long, so one hung request cannot stall the queue. */
const SEND_TIMEOUT_MS = 15000
/** The reasons that mean the page may be gone after this flush: the queue is drained, not sent one batch at a time. */
const FINAL_REASONS = ['hide', 'pagehide', 'unload', 'final', 'stop', 'close']
/** A final flush sends at most this many batches (about 48 KB): a keepalive request has a quota of 64 KB per page. */
const FINAL_BATCHES = 3

// ---------------------------------------------------------------------------------------------
// Field rules (plan section 4): what a string may keep
// ---------------------------------------------------------------------------------------------

/**
 * Strings are cut here before any rule runs. It is far past OBS_LIMITS.maxField on purpose: masking shortens text by at most a
 * factor of ten, so 2000 characters still fill the 200 that are kept, and a literal that is cut in half by this limit lies
 * beyond the last character that survives. It also keeps every rule fast.
 */
const PRECUT = 2000

// Invisible characters (soft hyphen, zero width and direction marks, the byte order mark) hide an address from a pattern, so they go.
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
// Controls and every kind of space become one space: a log line with a newline is still one field.
const SPACE_RE = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g

// Forms of the dot and the colon that NFKC leaves alone and that would hide an address from the patterns: the ideographic full stop and its
// half width form, the ratio sign and the modifier letter colon, %2e and %3a written as the percent escapes they are, and a combining mark
// glued to a digit, a hex letter, a dot or a colon (it sits inside the address and breaks the group). Each goes back to its plain character.
const LOOKALIKE_RE = /([0-9A-Fa-f.:])\p{M}+|[\u3002\uff61]|[\u2236\ua789]|%2e|%3a/giu
// The secrets of an SDP (the ICE user fragment and password, the DTLS fingerprint) are cut where the text names them; the line keeps its keys.
const SDP_SECRET_RE = /\b(a=ice-(?:ufrag|pwd):|a=fingerprint:\S+\s+)\S+/gi

function foldLookalike (m, keep) {
  if (keep !== undefined) return keep
  return m === '\u3002' || m === '\uff61' || m === '%2e' || m === '%2E' ? '.' : ':'
}

const HEX_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/
const V6_RUN_SRC = '[0-9A-Fa-f:.]+'
const ZONE_RE = /^%[0-9A-Za-z._~-]{1,40}/
const PORT_RE = /^:[0-9]{1,5}(?![0-9])/
// An IPv4 literal: four octets from 0 to 255 (leading zeros allowed, as inet_aton reads them: 0300.0250.0.1 is 192.168.0.1 in octal), not
// part of a longer number, with an optional :port that goes with it. The boundary in front is a captured character that the replacement
// puts back (no lookbehind). A number written as one integer or in hex (3232235777, 0xC0A80001) is left alone: an error code such as
// 0x80070005 has that shape, and no code of this page writes an address that way.
const OCTET = '(?:0[0-7]{1,3}|25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])'
const IPV4_RE = new RegExp('(^|[^0-9])(' + OCTET + '(?:\\.' + OCTET + '){3})(?![0-9])(?::[0-9]{1,5}(?![0-9]))?', 'g')
// A browser may hide a host candidate behind a random name under .local (mDNS); it stands in for an address.
const MDNS_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local\b/gi
// In an SDP candidate line the port is a separate word after the address, and raddr is followed by rport.
const CANDIDATE_PORT_RE = /(x\.x\.x\.x)\s+[0-9]{1,5}(?=\s+typ\b)/g
const RADDR_PORT_RE = /(\braddr\s+x\.x\.x\.x)\s+rport\s+[0-9]{1,5}\b/g
// A pair code is twelve characters shown as xxxx-xxxx-xxxx; only the first four (the channel) may leave the page. The separator
// class also takes the Unicode hyphens and the minus sign, which a typed or pasted code can carry.
const PAIR_RE = /(^|[^A-Za-z0-9])([A-Za-z0-9]{4})[-\u2010-\u2015\u2212][A-Za-z0-9]{4}[-\u2010-\u2015\u2212][A-Za-z0-9]{4}(?![A-Za-z0-9])/g
// A run of 40 or more hex digits (an infohash, a ledger id, a hash) keeps its first 8: plan section 4 allows 8 characters of an infohash.
const HEX_RUN_RE = /(^|[^0-9A-Za-z])([0-9A-Fa-f]{40,})(?![0-9A-Za-z])/g
const URLISH_RE = /[/:.?=@%&+~]/

/** isV4(t): a dotted quad with four octets from 0 to 255. */
function isV4 (t) {
  const p = t.split('.')
  if (p.length !== 4) return false
  for (let i = 0; i < 4; i++) {
    if (!/^[0-9]{1,3}$/.test(p[i]) || Number(p[i]) > 255) return false
  }
  return true
}

/**
 * isV6(t): is t, as it is, an IPv6 literal (no brackets, no zone)? Eight groups of one to four hex digits, or fewer around one "::";
 * the last 32 bits may be a dotted quad (::ffff:192.0.2.1). Written out by hand because a single regular expression for every form
 * would have to be a long alternation, and an alternation that is searched, not anchored, masks a prefix and leaves the tail.
 */
function isV6 (t) {
  if (t.length < 2 || t.length > 45 || t.indexOf(':') < 0) return false
  let s = t
  if (s.indexOf('.') >= 0) {
    const c = s.lastIndexOf(':')
    if (!isV4(s.slice(c + 1))) return false
    s = s.slice(0, c + 1) + '0:0'
  }
  if (!/^[0-9A-Fa-f:]+$/.test(s)) return false
  const dbl = s.indexOf('::')
  if (dbl !== s.lastIndexOf('::')) return false
  if (dbl < 0) {
    const g = s.split(':')
    if (g.length !== 8) return false
    for (let i = 0; i < 8; i++) if (!HEX_GROUP_RE.test(g[i])) return false
    return true
  }
  const left = s.slice(0, dbl)
  const right = s.slice(dbl + 2)
  const groups = (left === '' ? [] : left.split(':')).concat(right === '' ? [] : right.split(':'))
  if (groups.length > 7) return false
  for (let i = 0; i < groups.length; i++) if (!HEX_GROUP_RE.test(groups[i])) return false
  return true
}

/**
 * v6Span(run) -> { from, to } | null: where a valid IPv6 literal lies inside a run of hex digits, colons and dots. The run is what the
 * text hands over, so it may carry punctuation of the sentence at its edges ("fe80::1." or ":2001:db8::1:"), and a word that ends in
 * hex letters may be glued to it ("feed2001:db8::1"): the edges are trimmed, and a first or last group longer than four digits gives
 * up its outer characters, so the address is masked and the glued letters stay.
 */
function v6Span (run) {
  let from = 0
  let to = run.length
  while (from < to && run.charAt(from) === '.') from++
  if (run.charAt(from) === ':' && run.charAt(from + 1) !== ':') from++
  while (to > from && run.charAt(to - 1) === '.') to--
  if (to - from > 1 && run.charAt(to - 1) === ':' && run.charAt(to - 2) !== ':') to--
  for (let pass = 0; pass < 2; pass++) {
    const t = run.slice(from, to)
    if (/[0-9A-Fa-f]/.test(t) && isV6(t)) return { from, to }
    if (pass === 1) return null
    const first = t.indexOf(':')
    const last = t.lastIndexOf(':')
    const f2 = first > 4 ? from + first - 4 : from
    const t2 = last >= 0 && t.length - last - 1 > 4 && t.indexOf('.', last) < 0 ? from + last + 1 + 4 : to
    if (f2 === from && t2 === to) return null
    from = f2
    to = t2
  }
  return null
}

/** maskIPv6(s): every IPv6 literal, with its [ ] around it, its %zone and its :port when it has them, becomes x.x.x.x. */
function maskIPv6 (s) {
  if (s.indexOf(':') < 0) return s
  const re = new RegExp(V6_RUN_SRC, 'g')
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m[0].indexOf(':') < 0) continue
    const span = v6Span(m[0])
    if (!span) continue
    let a = m.index + span.from
    let b = m.index + span.to
    if (s.charAt(b) === '%') {
      const z = ZONE_RE.exec(s.slice(b, b + 42))
      if (z) b += z[0].length
    }
    if (a > last && s.charAt(a - 1) === '[' && s.charAt(b) === ']') {
      a -= 1
      b += 1
      const p = PORT_RE.exec(s.slice(b, b + 8))
      if (p) b += p[0].length
    }
    out += s.slice(last, a) + MASK
    last = b
    if (b > re.lastIndex) re.lastIndex = b
  }
  return last === 0 ? s : out + s.slice(last)
}

/**
 * cutFragment(s): the part after a '#' goes, and the '#' stays (so the text says a fragment was there). A '#' is kept only where it
 * cannot start a fragment: a bare '#', or a number sign in front of a short number ("#3") inside text that is not a URL. In a token
 * with a scheme, a path, a query or a host in front of it the number is no exception: https://host/#123456 is cut.
 *
 * The word in front of a '#' is read once, not once per '#': a '#' that is passed has no URL character in front of it, so the word in
 * front of the next one needs only the text since the last, and a text made of many "#1" costs time in proportion to its length (it
 * cost the square of it when each '#' read everything before it again: a 32 KB body of them took the endpoint about 10 ms).
 */
function cutFragment (s) {
  let from = 0
  for (;;) {
    const p = s.indexOf('#', from)
    if (p < 0) return s
    const since = s.slice(from, p)
    const space = since.lastIndexOf(' ')
    const after = s.slice(p + 1, p + 8)
    if (URLISH_RE.test(space < 0 ? since : since.slice(space + 1))) return s.slice(0, p + 1)
    if (after === '' || after.charAt(0) === ' ' || /^[0-9]{1,6}(?![0-9A-Za-z_])/.test(after)) {
      from = p + 1
      continue
    }
    return s.slice(0, p + 1)
  }
}

/** maskText(s): the pattern rules of plan section 4, in an order that matters (a fragment first, IPv6 before IPv4 because it may embed one). */
function maskText (s) {
  let t = s
  if (t.indexOf('=') >= 0) t = t.replace(SDP_SECRET_RE, '$1')
  if (t.indexOf('#') >= 0) t = cutFragment(t)
  if (t.indexOf('.local') >= 0) t = t.replace(MDNS_RE, MASK)
  t = maskIPv6(t)
  if (t.indexOf('.') >= 0) {
    t = t.replace(IPV4_RE, (m, pre) => pre + MASK)
    if (t.indexOf('typ') >= 0) t = t.replace(CANDIDATE_PORT_RE, '$1')
    if (t.indexOf('rport') >= 0) t = t.replace(RADDR_PORT_RE, '$1')
  }
  if (t.length >= 14) t = t.replace(PAIR_RE, '$1$2')
  if (t.length >= 40) t = t.replace(HEX_RUN_RE, (m, pre, run) => (/[0-9]/.test(run) && /[A-Fa-f]/.test(run) ? pre + run.slice(0, 8) : m))
  return t
}

/**
 * cleanString(input, max): the string rules in one place. Compatibility forms are folded first (full width digits and dots would
 * otherwise slip past), invisible characters and spaces are normalised, the look-alikes of the dot and the colon go back to the plain
 * character, then the masks run on the whole text and only then is it cut to max, so no half of an address is left at the cut.
 */
function cleanString (input, max) {
  let s = input.length > PRECUT ? input.slice(0, PRECUT) : input
  try { s = s.normalize('NFKC') } catch (_) { /* a string that cannot be normalised is used as it is */ }
  s = s.replace(INVISIBLE_RE, '').replace(SPACE_RE, ' ').trim()
  s = s.replace(LOOKALIKE_RE, foldLookalike)
  if (s) s = maskText(s)
  if (s.length > max) {
    s = s.slice(0, max)
    const c = s.charCodeAt(s.length - 1)
    if (c >= 0xd800 && c <= 0xdbff) s = s.slice(0, -1)
  }
  return s.trim()
}

/**
 * safeField(v): the value of one report field. A string is trimmed to OBS_LIMITS.maxField characters and masked: IPv4 and IPv6
 * literals (with their brackets, zone and port) become "x.x.x.x", the text after a '#' in a URL-looking string is cut, a pair code
 * (xxxx-xxxx-xxxx) keeps its first 4 characters, and a hash of 40 or more hex digits keeps its first 8. The forms an address hides in
 * are read first (the ideographic full stop, the ratio sign, %2e and %3a, a combining mark inside the address, an octal group), and the
 * user fragment, the password and the fingerprint of an SDP are cut. A number must be finite. A boolean and null pass. Everything else
 * becomes null.
 */
export function safeField (v) {
  if (typeof v === 'string') return cleanString(v, OBS_LIMITS.maxField)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v === null) return v
  return null
}

// ---------------------------------------------------------------------------------------------
// describeTarget: what a click was on
// ---------------------------------------------------------------------------------------------

const TARGET_DEPTH = 200
const CONTROL_CHILDREN_MAX = 40
const CONTROL_NODES_MAX = 80
const INPUT_TAGS = ['input', 'textarea', 'select', 'option']

function attr (n, name) {
  const v = typeof n.getAttribute === 'function' ? n.getAttribute(name) : null
  return typeof v === 'string' ? v : ''
}

function lowerTag (n) {
  const t = typeof n.tagName === 'string' ? n.tagName : (typeof n.nodeName === 'string' ? n.nodeName : '')
  return t.toLowerCase()
}

/** hasClass(n, cls): className is a string on HTML elements and an object on SVG ones; the fake DOM of the tests has the string only. */
function hasClass (n, cls) {
  let c = n.className
  if (c && typeof c === 'object' && typeof c.baseVal === 'string') c = c.baseVal
  if (typeof c !== 'string' || c === '') c = attr(n, 'class')
  return (' ' + c.replace(/\s+/g, ' ') + ' ').indexOf(' ' + cls + ' ') >= 0
}

const val = (s) => cleanString(s, OBS_LIMITS.maxField)

/**
 * The rules, in the order of the plan. Each finds the closest element (the target first, then its ancestors, inside the same tree,
 * like Element.closest) that carries its attribute with a value; the first rule that finds one decides. The walk goes through
 * parentNode and getAttribute only, because the fake DOM of the unit tests has no closest and a shadow root has no getAttribute.
 */
const TARGET_RULES = [
  ['role', (n) => val(attr(n, 'data-role'))],
  ['fk', (n) => val(attr(n, 'data-fk').split(':')[0])],
  ['app', (n) => val(attr(n, 'data-app'))],
  ['view', (n) => val(attr(n, 'data-view'))],
  ['banner', (n) => (hasClass(n, 'mw-banner') ? val(attr(n, 'data-id')) : '')],
  ['dialog', (n) => (hasClass(n, 'mw-dialog') ? val(attr(n, 'aria-labelledby')) : '')],
  ['row', (n) => val(attr(n, 'data-row'))],
  ['card', (n) => val(attr(n, 'data-mw-card'))],
  ['id', (n) => val(attr(n, 'id'))]
]

function closestValue (el, test) {
  for (let n = el, i = 0; n && i < TARGET_DEPTH; n = n.parentNode, i++) {
    if (typeof n.getAttribute !== 'function') continue
    const v = test(n)
    if (v) return v
  }
  return ''
}

/** elementOf(target): an event can be aimed at a text node, the document or the window; take the nearest thing that has attributes. */
function elementOf (target) {
  let n = target
  for (let i = 0; n && i < 4; i++) {
    if (typeof n.getAttribute === 'function') return n
    n = n.parentElement || n.parentNode
  }
  return null
}

function tagOf (n) {
  const s = n && typeof n === 'object' ? lowerTag(n).replace(/[^a-z0-9#-]/g, '').slice(0, 32) : ''
  return s || 'unknown'
}

/**
 * holdsPersonText(ctl): does this control show text a person wrote (a contact's name, a message preview, a quote)? The apps mark such
 * text with dir="auto"; any element may opt out with data-obs="off". A control inside such a mark, or holding one, reports no text.
 * The search is bounded (200 ancestors, 80 nodes below, 40 children of a node), and a control that is too large for it is taken to hold
 * person text: a mark that lies past a bound must not be missed, so what cannot be searched in full is not labelled.
 */
function holdsPersonText (ctl) {
  let up = ctl
  for (let i = 0; up && i < TARGET_DEPTH; up = up.parentNode, i++) {
    if (typeof up.getAttribute !== 'function') continue
    if (attr(up, 'dir').toLowerCase() === 'auto' || attr(up, 'data-obs').toLowerCase() === 'off') return true
  }
  if (up) return true // more ancestors than the walk covers
  const stack = [ctl]
  let seen = 0
  while (stack.length) {
    if (seen++ >= CONTROL_NODES_MAX) return true // more nodes below than the walk covers
    const n = stack.pop()
    if (n !== ctl && attr(n, 'dir').toLowerCase() === 'auto') return true
    const kids = n.children
    if (kids && typeof kids.length === 'number') {
      if (kids.length > CONTROL_CHILDREN_MAX) return true // more children than the walk covers
      for (let k = 0; k < kids.length; k++) stack.push(kids[k])
    }
  }
  return false
}

/** controlText(el): the text of the button or link that holds el, first 24 characters, masked. Never an input, never a value. */
function controlText (el) {
  if (INPUT_TAGS.indexOf(lowerTag(el)) >= 0) return ''
  let ctl = null
  for (let n = el, i = 0; n && i < TARGET_DEPTH; n = n.parentNode, i++) {
    if (typeof n.getAttribute !== 'function') continue
    const tag = lowerTag(n)
    const role = attr(n, 'role').toLowerCase()
    if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link') { ctl = n; break }
  }
  if (!ctl || holdsPersonText(ctl)) return ''
  let raw = ctl.textContent
  if (typeof raw !== 'string') raw = typeof ctl.innerText === 'string' ? ctl.innerText : ''
  return cleanString(raw, TEXT_MAX)
}

/**
 * describeTarget(el) -> { role | fk | app | view | banner | dialog | row | card | id | tag, text? }. Pure. Walks el and its ancestors
 * and returns the first match of, in this order: [data-role] -> role; [data-fk] -> fk (the prefix before the first ':' only);
 * [data-app] -> app; [data-view] -> view; .mw-banner[data-id] -> banner; .mw-dialog with aria-labelledby -> dialog (the title id);
 * [data-row] -> row; [data-mw-card] -> card (its kind); [id] -> id; else the tag name in tag. Also text: the text of the button or
 * link that holds el, first 24 characters, and only for buttons and links (never inputs, never an input's value, nothing from a
 * control that shows what a person wrote). It never throws.
 */
export function describeTarget (el) {
  try {
    const target = elementOf(el)
    if (!target) return { tag: tagOf(el) }
    let out = null
    for (let i = 0; i < TARGET_RULES.length && !out; i++) {
      const hit = closestValue(target, TARGET_RULES[i][1])
      if (hit) out = { [TARGET_RULES[i][0]]: hit }
    }
    if (!out) out = { tag: tagOf(target) }
    const text = controlText(target)
    if (text) out.text = text
    return out
  } catch (_) {
    return { tag: 'unknown' }
  }
}

// ---------------------------------------------------------------------------------------------
// wrapPeerConnection: ICE states and candidate types, never an address
// ---------------------------------------------------------------------------------------------

const CAND_TYPES = ['host', 'srflx', 'prflx', 'relay']
const CAND_PROTOS = ['udp', 'tcp']
const SDP_TYPES_MAX = 32
const SDP_SCAN_MAX = 100000

function hasOwn (o, k) {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/**
 * nativeOf(ctor): the constructor underneath this loader's own wrappers (this one and installOfferTimeout of connectivity.js, in either
 * order). A wrapper is recognised by its own marker; a constructor that is none of ours (a test harness wrapper included) ends the walk.
 */
function nativeOf (ctor) {
  let cur = ctor
  for (let i = 0; i < 8 && typeof cur === 'function'; i++) {
    if (hasOwn(cur, '__mwNative')) return cur.__mwNative
    if (!hasOwn(cur, '__mwOfferTimeout') && !hasOwn(cur, '__mwObs')) break
    const up = Object.getPrototypeOf(cur)
    if (typeof up !== 'function' || up === Function.prototype) break
    cur = up
  }
  return cur
}

/** candidateInfo(c) -> { type, proto } of a local candidate: the fields when the browser has them, else the words of the candidate line. */
function candidateInfo (c) {
  let type = typeof c.type === 'string' ? c.type : ''
  let proto = typeof c.protocol === 'string' ? c.protocol.toLowerCase() : ''
  const line = typeof c.candidate === 'string' ? c.candidate : ''
  if (!type) { const m = /\btyp\s+([a-z]+)/.exec(line); if (m) type = m[1] }
  if (!proto) { const m = /^(?:a=)?candidate:\S+\s+[0-9]+\s+(\S+)/i.exec(line); if (m) proto = m[1].toLowerCase() }
  return { type: CAND_TYPES.indexOf(type) >= 0 ? type : 'other', proto: CAND_PROTOS.indexOf(proto) >= 0 ? proto : 'other' }
}

/** sdpTypes(sdp) -> 'host,host,srflx': the typ word of every candidate line, in order. The address and port of a line are never read. */
function sdpTypes (sdp) {
  if (typeof sdp !== 'string') return ''
  const re = /^a=candidate:[^\r\n]*?\btyp\s+([a-z]+)/gm
  const text = sdp.length > SDP_SCAN_MAX ? sdp.slice(0, SDP_SCAN_MAX) : sdp
  const out = []
  let m
  while ((m = re.exec(text)) !== null && out.length < SDP_TYPES_MAX) out.push(CAND_TYPES.indexOf(m[1]) >= 0 ? m[1] : 'other')
  return out.join(',')
}

/** selectedPair(stats) -> { local, remote } as 'type/proto' words, from the report getStats() gives; no address, no port, no id leaves. */
function selectedPair (stats) {
  const byId = new Map()
  const pairs = []
  let selected = null
  const each = (s) => {
    if (!s || typeof s !== 'object') return
    if (typeof s.id === 'string') byId.set(s.id, s)
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') selected = s.selectedCandidatePairId
    if (s.type === 'candidate-pair') pairs.push(s)
  }
  if (stats && typeof stats.forEach === 'function') stats.forEach(each)
  else if (stats && typeof stats === 'object') Object.keys(stats).forEach((k) => each(stats[k]))
  let pair = selected ? byId.get(selected) : null
  if (!pair) pair = pairs.find((p) => p.selected === true) || pairs.find((p) => p.nominated === true && p.state === 'succeeded') || pairs.find((p) => p.state === 'succeeded') || null
  if (!pair) return null
  const local = byId.get(pair.localCandidateId)
  const remote = byId.get(pair.remoteCandidateId)
  if (!local || !remote) return null
  const word = (c) => {
    const t = CAND_TYPES.indexOf(c.candidateType) >= 0 ? c.candidateType : 'other'
    const p = CAND_PROTOS.indexOf(String(c.protocol).toLowerCase()) >= 0 ? String(c.protocol).toLowerCase() : 'other'
    return t + '/' + p
  }
  return { local: word(local), remote: word(remote) }
}

/** watch(pc, id, r): the per-connection half. Listeners and instance methods only; the shared prototype is never touched, so connections made without the wrapper (the calls) report nothing. */
function watch (pc, id, r) {
  const emit = (name, fields) => { try { r.event(name, fields) } catch (_) { /* a report must never break a connection */ } }
  emit('ice.pc', { id, ev: 'created' })
  if (typeof pc.addEventListener !== 'function') return
  let pairShown = false
  const connected = () => (typeof pc.connectionState === 'string' ? pc.connectionState === 'connected' : (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'))
  const maybePair = () => {
    if (!connected()) { pairShown = false; return }
    if (pairShown || typeof pc.getStats !== 'function') return
    pairShown = true
    try {
      const p = pc.getStats()
      if (p && typeof p.then === 'function') {
        p.then((stats) => {
          const pair = selectedPair(stats)
          if (pair) emit('ice.pair', { id, local: pair.local, remote: pair.remote })
        }, () => { /* the connection closed before the statistics came */ })
      }
    } catch (_) { /* getStats refused: no pair is reported */ }
  }
  pc.addEventListener('icegatheringstatechange', () => emit('ice.gathering', { id, state: String(pc.iceGatheringState) }))
  pc.addEventListener('iceconnectionstatechange', () => {
    emit('ice.state', { id, state: String(pc.iceConnectionState) })
    if (typeof pc.connectionState !== 'string') maybePair()
  })
  pc.addEventListener('connectionstatechange', () => {
    emit('ice.conn', { id, state: String(pc.connectionState) })
    maybePair()
  })
  pc.addEventListener('icecandidate', (e) => {
    const c = e && e.candidate
    if (!c || (typeof c.candidate === 'string' && c.candidate === '')) return
    const info = candidateInfo(c)
    emit('ice.local', { id, type: info.type, proto: info.proto })
  })
  const setRemote = pc.setRemoteDescription
  if (typeof setRemote === 'function') {
    pc.setRemoteDescription = function () {
      try {
        const d = arguments[0]
        const kind = d && typeof d === 'object' ? d.type : ''
        if (kind === 'offer' || kind === 'answer' || kind === 'pranswer') emit('ice.remote', { id, sdp: kind === 'offer' ? 'offer' : 'answer', types: sdpTypes(d.sdp) })
      } catch (_) { /* the report is a courtesy */ }
      return setRemote.apply(this, arguments)
    }
  }
  const close = pc.close
  if (typeof close === 'function') {
    let closed = false
    pc.close = function () {
      if (!closed) { closed = true; emit('ice.pc', { id, ev: 'closed' }) }
      return close.apply(this, arguments)
    }
  }
}

/**
 * wrapPeerConnection(win, r) -> true when installed. Wraps win.RTCPeerConnection once (idempotent, marked __mwObs; the prototype and
 * the statics such as generateCertificate stay reachable) and reports through r.event: ice.pc {id, ev: 'created' | 'closed'},
 * ice.gathering, ice.state and ice.conn {id, state}, ice.local {id, type, proto} per local candidate, ice.remote {id, sdp, types} from
 * setRemoteDescription (the typ words of the candidate lines) and ice.pair {id, local, remote} from getStats when the connection
 * becomes connected. Types and protocols only: never an address, a port, a foundation or a username fragment.
 *
 * It is a function, not a subclass, like installOfferTimeout() of connectivity.js, and it composes with that wrapper in either
 * order, and with test harness wrappers that return a native connection from their constructor. It must be installed before the
 * webtorrent bundle is imported (the bundle captures the constructor then). The constructor underneath all of the loader's wrappers
 * is Wrapped.__mwNative: the calls use it, so a call is neither delayed by the offer timeout nor reported here (the calls code is
 * out of scope). Reading __mwNative works on the outer wrapper too, because a wrapper inherits the statics of what it wraps.
 */
export function wrapPeerConnection (win, r) {
  const Base = win && win.RTCPeerConnection
  if (typeof Base !== 'function' || Base.__mwObs || !r || typeof r.event !== 'function') return false
  const native = nativeOf(Base)
  let count = 0
  // Reflect.construct with new.target keeps subclasses of the wrapped class working (class X extends RTCPeerConnection).
  const Wrapped = function RTCPeerConnection (...args) {
    if (!new.target) return Base(...args)
    const pc = Reflect.construct(Base, args, new.target)
    try { watch(pc, ++count, r) } catch (_) { /* leave the connection unreported */ }
    return pc
  }
  Wrapped.prototype = Base.prototype
  Object.setPrototypeOf(Wrapped, Base)
  Object.defineProperty(Wrapped, '__mwObs', { value: true })
  Object.defineProperty(Wrapped, '__mwNative', { value: native })
  try { win.RTCPeerConnection = Wrapped } catch (_) { return false } // a read-only property: the page keeps its constructor
  return win.RTCPeerConnection === Wrapped
}

// ---------------------------------------------------------------------------------------------
// createReporter: the queue, the consent switch, the batches and the transport
// ---------------------------------------------------------------------------------------------

function isLoopbackHost (h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h)
}

/** parseEndpoint(text) -> { url, host } | null: an exact https origin (or http on a loopback host), no path, no userinfo, no query, no fragment. Reports go to <origin>/e. */
function parseEndpoint (text) {
  if (typeof text !== 'string' || text === '' || text.length > 300 || text !== text.trim()) return null
  if (text.indexOf('#') >= 0 || text.indexOf('?') >= 0) return null
  let u
  try { u = new URL(text) } catch (_) { return null }
  if (u.username || u.password || !u.hostname || (u.pathname !== '/' && u.pathname !== '')) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) return null
  return { url: u.origin + '/e', host: u.hostname }
}

function hexOf (v, max) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return /^[0-9a-f]+$/.test(t) ? t.slice(0, max) : ''
}

/** loaderOf(v): the loader's version when it has the shape of one (0.3.0, 0.3.1-rc.1, at most 16 characters), else '' (the batch says nothing of it). */
function loaderOf (v) {
  const t = typeof v === 'string' ? v.trim() : ''
  return t.length <= 16 && LOADER_RE.test(t) ? t : ''
}

/** whoOf(v): the short id as the header shows it (xxxx-xxxx), or null: a name, an e-mail address or any other word is none. */
function whoOf (v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return WHO_RE.test(t) ? t : null
}

/**
 * netOf(v): the coarse connection words of navigator.connection (type and effectiveType), or null. A word the browser does not have in its
 * lists is 'other' (type) or 'unknown' (effectiveType), whatever it said: only the words of the lists leave the page.
 */
function netOf (v) {
  if (!v || typeof v !== 'object') return null
  const word = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')
  const type = word(v.type)
  const eff = word(v.effectiveType)
  if (!type && !eff) return null
  return Object.freeze({ type: NET_TYPES.indexOf(type) >= 0 ? type : (type ? 'other' : 'unknown'), effectiveType: NET_EFFECTIVE.indexOf(eff) >= 0 ? eff : 'unknown' })
}

/** familyOf(ua): the engine family of a user agent string. Every browser on iOS runs WebKit, so CriOS, FxiOS and EdgiOS are webkit. */
function familyOf (ua) {
  if (/\b(?:CriOS|FxiOS|EdgiOS|OPiOS)\b/.test(ua) || /\b(?:iPhone|iPad|iPod)\b/.test(ua)) return 'webkit'
  if (/\bFirefox\//.test(ua)) return 'firefox'
  if (/\b(?:Chrome|Chromium|HeadlessChrome|Edg|EdgA|OPR|SamsungBrowser)\//.test(ua)) return 'chromium'
  if (/\bAppleWebKit\//.test(ua) && /\bSafari\//.test(ua)) return 'webkit'
  return 'other'
}

/** uaOf(nav) -> { browser, mobile }: the family only, never the string. userAgentData wins where the browser has it. */
function uaOf (nav) {
  let browser = 'other'
  let mobile = false
  try {
    const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : ''
    const data = nav && nav.userAgentData
    if (data && Array.isArray(data.brands) && data.brands.some((b) => b && /Chromium|Chrome|Edge|Opera|Brave/i.test(String(b.brand)))) browser = 'chromium'
    else browser = familyOf(ua)
    mobile = data && typeof data.mobile === 'boolean' ? data.mobile : /Mobi|iPhone|iPod/i.test(ua)
  } catch (_) { /* an odd navigator is reported as other */ }
  return { browser, mobile }
}

/** utf8len(s): the bytes of s in UTF-8 (what the endpoint counts against its body limit). */
function utf8len (s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++ } else n += 3
  }
  return n
}

/** randomUnit() -> [0, 1): crypto when the browser has it (the session id should not repeat), else Math.random. */
function randomUnit () {
  const c = typeof crypto !== 'undefined' ? crypto : null
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1)
    c.getRandomValues(a)
    return a[0] / 4294967296
  }
  return Math.random()
}

function makeSid (random) {
  let s = ''
  for (let i = 0; i < SID_LENGTH; i++) {
    let u
    try { u = Number(random()) } catch (_) { u = NaN }
    if (!(u >= 0 && u < 1)) u = Math.random()
    s += SID_ALPHABET.charAt(Math.floor(u * SID_ALPHABET.length))
  }
  return s
}

/** defaultVisibility() -> { onHide(fn) }: pagehide and a visibilitychange to hidden, where the page has them (none in Node). */
function defaultVisibility () {
  return {
    onHide (fn) {
      const w = typeof globalThis.addEventListener === 'function' ? globalThis : null
      const d = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function' ? document : null
      const onVis = () => { if (d && d.visibilityState === 'hidden') fn() }
      if (w) w.addEventListener('pagehide', fn)
      if (d) d.addEventListener('visibilitychange', onVis)
      return () => {
        if (w) w.removeEventListener('pagehide', fn)
        if (d) d.removeEventListener('visibilitychange', onVis)
      }
    }
  }
}

/**
 * makeDefaultSend(env) -> send(url, text, { final }) -> boolean | Promise<boolean>. A batch is a text/plain POST, which a browser sends
 * without a preflight. The first choice is fetch with keepalive, mode cors and no credentials: a cors request always carries the page's
 * real Origin, and its answer says whether the endpoint stored the batch (true on a 2xx status). navigator.sendBeacon is the fallback
 * when there is no fetch or the browser refuses the keepalive request (its quota): a beacon is a no-cors POST, and under the door's
 * Referrer-Policy of no-referrer a no-cors POST carries "Origin: null", which the endpoint refuses. Measured on 2026-11-02: a phone on a
 * Chromium browser showed 99 batches sent and the endpoint had stored none, until this order was turned around.
 */
function makeDefaultSend (env) {
  return function send (url, text, opts) {
    const nav = env.navigator !== undefined ? env.navigator : (typeof navigator !== 'undefined' ? navigator : null)
    const doFetch = env.fetch !== undefined ? env.fetch : (typeof fetch === 'function' ? fetch : null)
    const beacon = () => {
      try { return !!(nav && typeof nav.sendBeacon === 'function' && typeof Blob === 'function' && nav.sendBeacon(url, new Blob([text], { type: 'text/plain' }))) } catch (_) { return false }
    }
    if (typeof doFetch === 'function') {
      try {
        return Promise.resolve(doFetch(url, { method: 'POST', body: text, headers: { 'content-type': 'text/plain' }, keepalive: true, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })).then((res) => !!(res && res.ok), () => false)
      } catch (_) { /* a refused keepalive request (quota) falls through to the beacon */ }
    }
    return beacon()
  }
}

/** inertReporter(): what createReporter returns for an endpoint it cannot use. Same shape, does nothing, never calls the network. */
function inertReporter () {
  const no = () => false
  return { sid: '', event: no, click: no, setWho: no, setSite: no, setNet: no, allow: no, flush: no, stop: no, inspect: () => ({ host: '', enabled: false, allowed: false, queued: 0, sent: 0, dropped: 0, batches: 0, lastOk: null }) }
}

/**
 * createReporter({ endpoint, page, build, loader, site, now, random, send, visibility, timers, env }) -> reporter.
 *
 * endpoint: the origin of the endpoint the owner runs (https, or http on loopback). page: 'site' | 'door' | 'hub' | 'idp' (anything
 * else is reported as 'site'). build: the door build id (hex) or ''. loader: the loader version. site: the first 8 hex characters of the
 * site's infohash or '' (r.setSite sets it later). now() in ms, random() in [0, 1) for the session id, send(url, text, { final }) ->
 * boolean | Promise<boolean> (an explicit false, a rejection or no answer within 15 s is a failure; anything else is a success),
 * visibility { onHide(fn) } to flush when the page is hidden, timers { setTimeout, clearTimeout }, env { navigator, fetch }: all
 * injectable, all defaulting to the page's own. An endpoint that cannot be used gives an inert reporter (enabled false, no network).
 *
 * Consent comes first. Before the first allow(true) events only buffer in memory (at most maxQueue, the oldest dropped and counted);
 * allow(true) starts the sending and the buffered events go first; allow(false) drops what is queued and ignores events until the
 * next allow(true). Nothing leaves the page before a yes.
 *
 * Batches (the wire, one JSON object per POST, text/plain):
 *   { v: 1, sid, seq, page, build, loader, site, who, net, ua: { browser, mobile }, t0, events: [{ t, n, ...fields }] }
 * One batch holds at most maxBatch events and maxBodyBytes bytes; the rest waits for the next flush. who, site and net are taken when
 * an event is queued, and a batch holds events that share them, so a sign-in in the middle of a session never labels earlier events.
 * The 2 s timer runs only while something waits. A failed batch keeps its seq and body and goes again at the next flush, up to maxRetries
 * tries in all, then it is dropped and counted. A flush because the page is hidden (or stop()) sends up to three batches at once.
 *
 * The reporter: event(name, fields), click(target, extra), setWho(short), setSite(hex8), setNet({ type, effectiveType }), allow(bool),
 * flush(reason), stop(), inspect() -> { host, enabled, allowed, queued, sent, dropped, batches, lastOk }, and sid, the 12 character
 * session id (read-only; the identity page may be handed it, to join two timelines).
 *
 * Accounting: every event handed to event() while the reporter is live is exactly one of queued, sent or dropped (inspect()).
 */
export function createReporter (opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const ep = parseEndpoint(o.endpoint)
  if (!ep) return inertReporter()
  const env = o.env && typeof o.env === 'object' ? o.env : {}
  const timers = o.timers && typeof o.timers === 'object' ? o.timers : null
  const setT = (fn, ms) => {
    const id = timers && typeof timers.setTimeout === 'function' ? timers.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms)
    if (id && typeof id === 'object' && typeof id.unref === 'function') id.unref() // a pending report never keeps a Node process alive
    return id
  }
  const clearT = (id) => { if (timers && typeof timers.clearTimeout === 'function') timers.clearTimeout(id); else globalThis.clearTimeout(id) }
  const nowFn = typeof o.now === 'function' ? o.now : Date.now
  const send = typeof o.send === 'function' ? o.send : makeDefaultSend(env)

  let lastNow = 0
  const clock = () => {
    let n
    try { n = Number(nowFn()) } catch (_) { n = NaN }
    if (Number.isFinite(n)) lastNow = n
    return lastNow
  }
  const born = clock()
  let lastT = 0
  const elapsed = () => { lastT = Math.max(lastT, Math.round(clock() - born)); return lastT }

  const sid = makeSid(typeof o.random === 'function' ? o.random : randomUnit)
  const page = PAGES.indexOf(o.page) >= 0 ? o.page : 'site'
  const build = hexOf(o.build, 16)
  const loader = loaderOf(o.loader)
  const ua = uaOf(env.navigator !== undefined ? env.navigator : (typeof navigator !== 'undefined' ? navigator : null))
  const t0 = Math.max(0, Math.floor(born / 1000))

  let who = null
  let site = hexOf(o.site, 8)
  let net = null
  let consent = 'pending' // 'pending' (no answer yet: buffer), 'on' (send), 'off' (the visitor said no: drop and ignore)
  let stopped = false
  let seq = 0
  let timer = null
  let offHide = null
  let inflight = 0
  let inflightEvents = 0
  let sent = 0
  let dropped = 0
  let okBatches = 0
  let lastOk = null
  const queue = [] // { text, bytes, who, site, net }
  const retry = [] // batches that failed and wait for another try, oldest first

  const retryEvents = () => retry.reduce((a, b) => a + b.n, 0)
  const live = () => !stopped && consent === 'on'

  function arm () {
    if (timer !== null || !live() || (queue.length === 0 && retry.length === 0)) return
    timer = setT(() => { timer = null; try { flush('timer') } catch (_) { /* the page goes on */ } }, OBS_LIMITS.flushMs)
  }

  function disarm () {
    if (timer !== null) { clearT(timer); timer = null }
  }

  /** nextBatch(): takes the next batch off the queue (events that share who, site and net, within maxBatch and maxBodyBytes) or null. */
  function nextBatch () {
    while (queue.length) {
      const first = queue[0]
      const head = JSON.stringify({ v: 1, sid, seq, page, build, loader, site: first.site, who: first.who, net: first.net, ua, t0 })
      const prefix = head.slice(0, -1) + ',"events":['
      let bytes = utf8len(prefix) + 2
      let take = 0
      while (take < queue.length && take < OBS_LIMITS.maxBatch) {
        const it = queue[take]
        if (take > 0 && (it.who !== first.who || it.site !== first.site || it.net !== first.net)) break
        const add = it.bytes + (take > 0 ? 1 : 0)
        if (bytes + add > OBS_LIMITS.maxBodyBytes) break
        bytes += add
        take++
      }
      if (take === 0) { queue.shift(); dropped++; continue } // one event alone is larger than a batch can be: it can never leave
      const items = queue.splice(0, take)
      return { seq: seq++, n: take, text: prefix + items.map((x) => x.text).join(',') + ']}', tries: 0 }
    }
    return null
  }

  /** settle(b, ok): one try of a batch is over. A failed batch is kept for a retry only while the reporter is live and has tries left. */
  function settle (b, ok) {
    if (ok) { sent += b.n; okBatches++; lastOk = true; return }
    lastOk = false
    b.tries++
    if (!live() || b.tries >= OBS_LIMITS.maxRetries) { dropped += b.n; return }
    retry.push(b)
    retry.sort((x, y) => x.seq - y.seq)
  }

  function dispatch (b, final) {
    let res
    try { res = send(ep.url, b.text, { final }) } catch (_) { res = false }
    if (res && typeof res.then === 'function') {
      inflight++
      inflightEvents += b.n
      let done = false
      let guard = null
      const finish = (ok) => {
        if (done) return
        done = true
        if (guard !== null) { clearT(guard); guard = null }
        inflight--
        inflightEvents -= b.n
        settle(b, ok)
        arm()
      }
      guard = setT(() => { guard = null; finish(false) }, SEND_TIMEOUT_MS)
      res.then((v) => finish(v !== false), () => finish(false))
      return
    }
    settle(b, res !== false)
  }

  /**
   * flush(reason) -> true when a batch went out. One batch per flush, the oldest failed batch first. A reason that means the page may
   * be gone (hide, stop) sends up to FINAL_BATCHES batches now.
   */
  function flush (reason) {
    if (!live()) return false
    const final = FINAL_REASONS.indexOf(reason) >= 0
    let started = false
    disarm()
    try {
      if (final) {
        const todo = retry.splice(0, FINAL_BATCHES)
        while (todo.length < FINAL_BATCHES) {
          const b = nextBatch()
          if (!b) break
          todo.push(b)
        }
        for (let i = 0; i < todo.length; i++) { dispatch(todo[i], true); started = true }
      } else if (inflight === 0) {
        const b = retry.length ? retry.shift() : nextBatch()
        if (b) { dispatch(b, false); started = true }
      }
    } catch (_) { /* a failed flush is a failed try, never an error in the page */ }
    arm()
    return started
  }

  function event (name, fields) {
    if (stopped || consent === 'off') return false
    try {
      if (typeof name !== 'string' || !NAME_RE.test(name)) { dropped++; return false }
      const ev = { t: elapsed(), n: name }
      if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
        const keys = Object.keys(fields)
        let kept = 0
        for (let i = 0; i < keys.length && i < 64 && kept < EVENT_MAX_KEYS; i++) {
          const k = keys[i]
          if (k === 't' || k === 'n' || !KEY_RE.test(k)) continue
          const v = fields[k]
          if (typeof v === 'string') ev[k] = cleanString(v, OBS_LIMITS.maxField)
          else if (typeof v === 'number' && Number.isFinite(v)) ev[k] = v
          else if (typeof v === 'boolean' || v === null) ev[k] = v
          else continue
          kept++
        }
      }
      const text = JSON.stringify(ev)
      queue.push({ text, bytes: utf8len(text), who, site, net })
      if (queue.length > OBS_LIMITS.maxQueue) { queue.shift(); dropped++ }
      arm()
      return true
    } catch (_) {
      dropped++
      return false
    }
  }

  function click (target, extra) {
    const merged = Object.assign({}, describeTarget(target))
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(merged, extra)
    return event('ui.click', merged)
  }

  function allow (v) {
    if (stopped) return false
    if (v === true) {
      if (consent !== 'on') { consent = 'on'; arm() }
      return true
    }
    if (consent !== 'off') {
      dropped += queue.length + retryEvents()
      queue.length = 0
      retry.length = 0
      consent = 'off'
      disarm()
    }
    return false
  }

  function stop () {
    if (stopped) return
    try {
      if (consent === 'on') flush('stop')
    } catch (_) { /* nothing to do */ }
    dropped += queue.length + retryEvents()
    queue.length = 0
    retry.length = 0
    stopped = true
    disarm()
    if (offHide) { try { offHide() } catch (_) { /* gone with the page */ } offHide = null }
  }

  function inspect () {
    return { host: ep.host, enabled: !stopped, allowed: live(), queued: queue.length + retryEvents() + inflightEvents, sent, dropped, batches: okBatches, lastOk }
  }

  const vis = o.visibility && typeof o.visibility.onHide === 'function' ? o.visibility : (o.visibility ? null : defaultVisibility())
  if (vis) {
    try {
      const off = vis.onHide(() => { try { flush('hide') } catch (_) { /* the page is going away anyway */ } })
      if (typeof off === 'function') offHide = off
    } catch (_) { /* no hide flush: the 2 s timer still runs */ }
  }

  const api = {
    event,
    click,
    setWho (v) { who = whoOf(v) },
    setSite (v) { site = hexOf(v, 8) },
    setNet (v) {
      const next = netOf(v)
      net = next && net && next.type === net.type && next.effectiveType === net.effectiveType ? net : next
    },
    allow,
    flush,
    stop,
    inspect
  }
  Object.defineProperty(api, 'sid', { value: sid, enumerable: true })
  return api
}
