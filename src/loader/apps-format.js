// src/loader/apps-format.js: text for the apps on the door page (ARCHITECTURE 15.21, formatting md1): the md1 parser that turns a
// message into a safe node description, link detection, the search helpers and the export shape.
//
// md1 marks: *bold*, _italic_, __underline__, ~strike~, `mono`. http and https URLs become links. Everything else is text.
// The parser returns DATA, never markup: the UI builds elements from the nodes and sets text with textContent (a text node's
// s, a link's visible text), so a message can never inject HTML, an attribute or a script. A link node carries href (an
// http or https URL that new URL() accepted, without credentials), rel 'noopener noreferrer' and target '_blank'.
//
//   node = { t: 'text', s } | { t: 'br' } | { t: 'code', s }
//        | { t: 'b' | 'i' | 'u' | 's', c: [node] }
//        | { t: 'a', href, rel, target, c: [{ t: 'text', s }] }
//
// A mark opens only where the character before it is not a letter or digit and the one after it is not a space; it closes at
// the first later mark of the same kind on the same line that follows a non-space and precedes a non-letter. An unpaired mark
// is plain text. Marks nest (bold inside italic) but not inside `mono`, nothing nests deeper than MAX_DEPTH, and a message
// produces at most MAX_NODES nodes (the rest is one text node). URLs inside a marked span are found first, so a path with
// underscores is not italicised; the characters * _ ~ and ` at the end of a URL are not part of it.
//
// Shared code: no DOM, no Buffer, no node: imports.

// The text limits (3,500, set at the integration of 2026-11-01): a sealed direct message is a JSON body in the largest bucket the
// frame allows, at most 4,064 bytes (apps-crypto.js DM_BODY_MAX), so the first design's 4,000 characters did not always fit. 3,500 plain letters always do (the body adds about 100 bytes). Text in a script of 2 or 3 byte letters (about 2,000
// Persian letters) or with many line breaks reaches the frame earlier: the send answers 'too long' and nothing is cut. Rooms: 2,000.
export const TEXT_MAX = 3500
export const ROOM_TEXT_MAX = 2000
export const REACTION_MAX = 8
export const MAX_DEPTH = 4
export const MAX_NODES = 1500
export const URL_MAX = 2048

/** 32 common emoji for the composer picker, as code point escapes (this file stays ASCII). */
export const COMMON_EMOJI = Object.freeze([
  '\u{1F600}', '\u{1F602}', '\u{1F60A}', '\u{1F60D}', '\u{1F618}', '\u{1F60E}', '\u{1F914}', '\u{1F622}',
  '\u{1F62D}', '\u{1F621}', '\u{1F634}', '\u{1F644}', '\u{1F44D}', '\u{1F44E}', '\u{1F44F}', '\u{1F64F}',
  '\u{1F4AA}', '\u{1F44B}', '\u{1F91D}', '\u{1F64C}', '\u{2764}\u{fe0f}', '\u{1F494}', '\u{1F525}', '\u{2728}',
  '\u{1F389}', '\u{1F4AF}', '\u{2705}', '\u{274c}', '\u{2b50}', '\u{1F339}', '\u{2615}', '\u{1F319}'
])

// ---------------------------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------------------------

// C0 and C1 controls (but not tab and newline), bidi embedding, override and isolate controls (a right-to-left override can
// reorder what a reader sees), the byte order mark. Zero-width joiners and the marks Persian text needs are kept.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu
const SURROGATE_RE = /[\ud800-\udfff]/

function fixSurrogates (s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      } else out += '\u{fffd}'
    } else if (c >= 0xdc00 && c <= 0xdfff) out += '\u{fffd}'
    else out += s[i]
  }
  return out
}

/** sanitizeText(text) -> a string without control, bidi override and lone surrogate characters; line ends are \n. */
export function sanitizeText (text) {
  let s = text === undefined || text === null ? '' : String(text)
  s = s.replace(/\r\n?/g, '\n').replace(/[\u{2028}\u{2029}]/gu, '\n').replace(CONTROL_RE, '')
  if (SURROGATE_RE.test(s)) s = fixSurrogates(s)
  return s
}

function cpBefore (s, i) {
  if (i <= 0) return ''
  const c = s.charCodeAt(i - 1)
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2)
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(i - 2, i)
  }
  return s[i - 1]
}

function cpAt (s, i) {
  if (i >= s.length) return ''
  const c = s.charCodeAt(i)
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1)
    if (d >= 0xdc00 && d <= 0xdfff) return s.slice(i, i + 2)
  }
  return s[i]
}

const ALNUM_RE = /[\p{L}\p{N}]/u
const SPACE_RE = /\s/

function isAlnum (ch) {
  return ch !== '' && ALNUM_RE.test(ch)
}

function isSpace (ch) {
  return ch === '' || SPACE_RE.test(ch)
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

const TRAIL_PUNCT = '.,;:!?\'"*_~`'
const PAIRS = { ')': '(', ']': '[', '}': '{' }

function stopsUrl (code) {
  return code <= 0x20 || code === 0x3c || code === 0x3e || code === 0x22 || (code >= 0x7f && code <= 0x9f) || code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0x3000
}

function count (str, ch) {
  let n = 0
  for (let i = 0; i < str.length; i++) if (str[i] === ch) n++
  return n
}

/**
 * urlAt(s, i, end = s.length) -> { start, end, text, href } | null: an http or https URL that starts at s[i]. The URL runs to the
 * next space or one of < > ", loses trailing punctuation and unbalanced closing brackets, and must be accepted by new URL()
 * with a host and without a user name or password (https://good.example@bad.example is not linked).
 */
export function urlAt (s, i, end = s.length) {
  const c = s.charCodeAt(i)
  if (c !== 0x68 && c !== 0x48) return null
  const head = s.slice(i, i + 8).toLowerCase()
  const scheme = head.startsWith('https://') ? 8 : (head.startsWith('http://') ? 7 : 0)
  if (!scheme) return null
  const first = s[i + scheme]
  if (first === '/' || first === '\\' || first === '?' || first === '#' || first === '@') return null // https:///x is parsed as a host named x: it is not what was typed
  let j = i + scheme
  while (j < end && !stopsUrl(s.charCodeAt(j))) j++
  let k = j
  while (k > i + scheme) {
    const ch = s[k - 1]
    if (TRAIL_PUNCT.indexOf(ch) >= 0) {
      k--
    } else if (PAIRS[ch]) {
      const body = s.slice(i, k)
      if (count(body, ch) > count(body, PAIRS[ch])) k--
      else break
    } else break
  }
  if (k <= i + scheme) return null
  const text = s.slice(i, k)
  if (text.length > URL_MAX || text.indexOf('\\') >= 0) return null
  let url
  try {
    url = new URL(text)
  } catch (_) {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.username || url.password) return null
  return { start: i, end: k, text, href: url.href }
}

function urlBoundary (s, i) {
  return i === 0 || !isAlnum(cpBefore(s, i))
}

/** linksIn(text) -> [{ start, end, text, href }]: every http or https link in a text, in order. */
export function linksIn (text) {
  const s = sanitizeText(text)
  const out = []
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if ((c === 0x68 || c === 0x48) && urlBoundary(s, i)) {
      const u = urlAt(s, i)
      if (u) {
        out.push(u)
        i = u.end
        continue
      }
    }
    i++
  }
  return out
}

/** hasLink(text) -> boolean. */
export function hasLink (text) {
  return linksIn(text).length > 0
}

// ---------------------------------------------------------------------------------------------
// md1
// ---------------------------------------------------------------------------------------------

const MARKS = { '`': 'code', '__': 'u', '*': 'b', '_': 'i', '~': 's' }

function markAt (s, i) {
  const ch = s[i]
  if (ch === '_') return s[i + 1] === '_' ? '__' : '_'
  if (ch === '*' || ch === '~' || ch === '`') return ch
  return null
}

// The index of the closing mark for an opening mark at i, or -1.
function findClose (s, i, mark) {
  const len = mark.length
  let j = i + len
  while (j < s.length) {
    const ch = s[j]
    if (ch === '\n') return -1
    if ((ch === 'h' || ch === 'H') && urlBoundary(s, j)) {
      const u = urlAt(s, j)
      if (u) {
        j = u.end
        continue
      }
    }
    if (s.startsWith(mark, j) && j > i + len) {
      const before = s[j - 1]
      const after = cpAt(s, j + len)
      const sameRun = len === 1 && s[j + 1] === mark
      if (!isSpace(before) && !isAlnum(after) && !sameRun) return j
    }
    j++
  }
  return -1
}

function parseRange (s, start, end, ctx, depth) {
  const nodes = []
  let buf = ''
  const flush = () => {
    if (buf) {
      nodes.push({ t: 'text', s: buf })
      ctx.nodes++
      buf = ''
    }
  }
  let i = start
  while (i < end) {
    const ch = s[i]
    if (ctx.nodes >= ctx.max) {
      buf += s.slice(i, end)
      break
    }
    if (ch === '\n') {
      flush()
      nodes.push({ t: 'br' })
      ctx.nodes++
      i++
      continue
    }
    if ((ch === 'h' || ch === 'H') && urlBoundary(s, i)) {
      const u = urlAt(s, i, end)
      if (u) {
        flush()
        nodes.push({ t: 'a', href: u.href, rel: 'noopener noreferrer', target: '_blank', c: [{ t: 'text', s: u.text }] })
        ctx.nodes += 2
        i = u.end
        continue
      }
    }
    const mark = markAt(s, i)
    if (mark) {
      const len = mark.length
      const next = cpAt(s, i + len)
      const openOk = urlBoundary(s, i) && !isSpace(next) && next !== mark[0] && i + len < end
      if (openOk && (depth < MAX_DEPTH || mark === '`')) {
        const close = findClose(s, i, mark)
        if (close > 0 && close + len <= end) {
          flush()
          if (mark === '`') {
            nodes.push({ t: 'code', s: s.slice(i + len, close) })
            ctx.nodes++
          } else {
            ctx.nodes++
            nodes.push({ t: MARKS[mark], c: parseRange(s, i + len, close, ctx, depth + 1) })
          }
          i = close + len
          continue
        }
      }
      buf += mark
      i += len
      continue
    }
    buf += ch
    i++
  }
  flush()
  return nodes
}

/** parseMd1(text, { maxNodes }) -> [node]: the safe node description of a message (see the header). */
export function parseMd1 (text, { maxNodes = MAX_NODES } = {}) {
  const s = sanitizeText(text)
  return parseRange(s, 0, s.length, { nodes: 0, max: maxNodes }, 0)
}

/** nodesText(nodes) -> the visible text of a node list (marks removed, line breaks as \n). */
export function nodesText (nodes) {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.s
    else if (n.t === 'br') out += '\n'
    else if (n.c) out += nodesText(n.c)
  }
  return out
}

/** plainText(text) -> the message without its marks. */
export function plainText (text) {
  return nodesText(parseMd1(text))
}

/** previewText(text, max = 80) -> one line without marks, cut at max characters with "..." (a notification or list line). */
export function previewText (text, max = 80) {
  const one = plainText(text).replace(/\s+/g, ' ').trim()
  const cps = Array.from(one)
  return cps.length <= max ? one : cps.slice(0, Math.max(1, max - 3)).join('') + '...'
}

// ---------------------------------------------------------------------------------------------
// Emoji (reactions)
// ---------------------------------------------------------------------------------------------

/**
 * isEmoji(s): a non-empty string of at most REACTION_MAX code points without spaces or controls (any Unicode, no list). A name
 * that an object already has (toString, valueOf, constructor, __proto__) is not one: a reaction is used as a key (ADV-6).
 */
export function isEmoji (s) {
  if (typeof s !== 'string' || !s) return false
  if (s !== sanitizeText(s) || /\s/.test(s)) return false
  if (Array.from(s).length > REACTION_MAX) return false
  if (s in Object.prototype) return false
  return s.length <= 32
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

const MARK_RE = /[\u{300}-\u{36f}\u{640}\u{64b}-\u{65f}\u{670}\u{6d6}-\u{6ed}]/gu
const ARABIC_FIX = { '\u{64a}': '\u{6cc}', '\u{649}': '\u{6cc}', '\u{643}': '\u{6a9}', '\u{6c0}': '\u{6d5}' }

/**
 * foldText(s) -> { text, starts, ends }: s lowercased with accents, Arabic vowel marks and tatweel removed and Arabic yeh and
 * kaf folded to the Persian letters; starts[i] and ends[i] are the span of folded character i in s (for highlight ranges).
 */
export function foldText (s) {
  let text = ''
  const starts = []
  const ends = []
  let i = 0
  while (i < s.length) {
    const cp = cpAt(s, i)
    const next = i + cp.length
    let f = cp.normalize('NFKD').replace(MARK_RE, '').toLowerCase()
    f = f.replace(/[\u{64a}\u{649}\u{643}\u{6c0}]/gu, (m) => ARABIC_FIX[m])
    if (!f && ends.length) ends[ends.length - 1] = next // a dropped mark (an accent) belongs to the letter before it
    for (let k = 0; k < f.length; k++) {
      text += f[k]
      starts.push(i)
      ends.push(next)
    }
    i = next
  }
  return { text, starts, ends }
}

function parseWhen (v, endOfDay) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      return endOfDay ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1 : d.getTime()
    }
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function allIndexes (hay, needle, limit = 200) {
  const out = []
  if (!needle) return out
  let at = hay.indexOf(needle)
  while (at >= 0 && out.length < limit) {
    out.push([at, at + needle.length])
    at = hay.indexOf(needle, at + Math.max(1, needle.length))
  }
  return out
}

function mergeRanges (ranges) {
  const r = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []
  for (const x of r) {
    const last = out[out.length - 1]
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}

/**
 * searchMessages(messages, query) -> [{ id, index, t, mine, ranges }] in message order.
 * query: { text, exact, from, to, direction: 'any' | 'sent' | 'received', links, saved, pinned, edited, reactions, important }.
 *   text      keywords (every word must occur, in any order), or with exact the whole phrase; case, accents and Arabic
 *             vowel marks do not matter; deleted messages never match a text query
 *   from, to  a time in ms, a Date, 'YYYY-MM-DD' (local day; to ends at the end of that day) or any string Date.parse reads
 *   links, saved, pinned, edited, reactions, important   only messages that have that
 * ranges: [start, end] pairs in message.text for the text query (UTF-16 offsets into the original text).
 */
export function searchMessages (messages, query = {}) {
  const q = query || {}
  const raw = typeof q.text === 'string' ? sanitizeText(q.text).trim() : ''
  const foldedQuery = raw ? foldText(raw).text.trim() : ''
  const terms = q.exact ? (foldedQuery ? [foldedQuery] : []) : foldedQuery.split(/\s+/).filter(Boolean)
  const from = parseWhen(q.from, false)
  const to = parseWhen(q.to, true)
  const dir = q.direction === 'sent' || q.direction === 'received' ? q.direction : 'any'
  const out = []
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index]
    if (!m) continue
    if (dir === 'sent' && !m.mine) continue
    if (dir === 'received' && m.mine) continue
    if (from !== null && m.t < from) continue
    if (to !== null && m.t > to) continue
    if (q.links && !(typeof m.text === 'string' && hasLink(m.text))) continue
    if (q.saved && !m.saved) continue
    if (q.pinned && !m.pinned) continue
    if (q.important && !(m.important || m.prio)) continue
    if (q.edited && !(Array.isArray(m.edits) && m.edits.length)) continue
    if (q.reactions && !(m.reactions && Object.keys(m.reactions).some((e) => m.reactions[e] && m.reactions[e].length))) continue
    let ranges = []
    if (terms.length) {
      if (m.deleted || typeof m.text !== 'string' || !m.text) continue
      const f = foldText(m.text)
      let ok = true
      for (const term of terms) {
        const hits = allIndexes(f.text, term)
        if (!hits.length) {
          ok = false
          break
        }
        for (const h of hits) ranges.push([f.starts[h[0]], f.ends[h[1] - 1]])
      }
      if (!ok) continue
      ranges = mergeRanges(ranges)
    }
    out.push({ id: m.id, index, t: m.t, mine: !!m.mine, ranges })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export const EXPORT_FORMAT = 'felinar-apps-chat'
export const EXPORT_VERSION = 1

function isoOf (ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function sidesOf (reactions, mePub, peerPub) {
  const out = {}
  for (const e of Object.keys(reactions || {})) {
    const who = (reactions[e] || []).map((p) => (p === mePub ? 'me' : (p === peerPub ? 'peer' : 'other')))
    if (who.length) out[e] = who
  }
  return out
}

/**
 * exportConversation({ conv, me, now }) -> the JSON-able object a visitor saves:
 * { format: 'felinar-apps-chat', version: 1, exportedAt, me: { pub, short, name }, peer: { pub, short, name, nick }, compare,
 *   cfg: { exp, receipts }, messages: [{ id, t, time, from: 'me' | 'peer', text, fmt, reply, status, readAt, edits: [{ t, text }],
 *   deleted, reactions: { emoji: ['me' | 'peer'] }, pinned, saved, important, prio, exp }] }.
 * edits lists the earlier texts, oldest first; text is the current one. Nothing is stored at a door: this file is the copy.
 */
export function exportConversation ({ conv, me, now = Date.now() }) {
  const peer = conv.peer || {}
  const list = (conv.messages || []).map((m) => ({
    id: m.id,
    t: m.t,
    time: isoOf(m.t),
    from: m.mine ? 'me' : 'peer',
    text: m.deleted ? '' : m.text,
    fmt: m.fmt || 'md1',
    reply: m.reply || null,
    status: m.mine ? m.status : null,
    readAt: m.readAt || null,
    edits: (m.edits || []).map((e) => ({ t: e.t, text: e.text })),
    deleted: !!m.deleted,
    reactions: sidesOf(m.reactions, me && me.pub, peer.pub),
    pinned: !!m.pinned,
    saved: !!m.saved,
    important: !!m.important,
    prio: !!m.prio,
    exp: m.exp || null
  }))
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: isoOf(now),
    me: me ? { pub: me.pub, short: me.short, name: me.name || null } : null,
    peer: { pub: peer.pub || null, short: peer.short || null, name: peer.name || null, nick: peer.nick || null },
    compare: conv.compare || null,
    cfg: { exp: conv.cfg ? conv.cfg.exp : null, receipts: conv.cfg ? conv.cfg.receipts !== false : true },
    messages: list
  }
}

/** exportFileName(conv, now) -> 'felinar-chat-<peer short id>-<YYYYMMDD>.json' (letters, digits and hyphens only). */
export function exportFileName (conv, now = Date.now()) {
  const d = new Date(now)
  const ymd = String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0')
  const who = String((conv.peer && conv.peer.short) || 'chat').replace(/[^A-Za-z0-9-]/g, '')
  return 'felinar-chat-' + (who || 'chat') + '-' + ymd + '.json'
}
