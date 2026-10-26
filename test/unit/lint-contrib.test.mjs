// The contribution rules of smart seeding and calls, run as a lint over src/ (v0.3 C2, seed-policy lane;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.9): no silent or keep-alive media; no navigator.audioSession
// writes; Wake Lock only in src/loader/dock.js and src/calls/session.js; getUserMedia and getDisplayMedia only in
// src/calls/. A page that plays nothing must never tell the operating system it does (S1 F3).
//
// Matching ignores comments, strings, template text and regular expression literals (scanJs from
// tools/lint-floor.mjs), so a message may name an API. Feature detection with typeof is allowed everywhere. One
// recorded exception: the device-link QR scanner in src/idp/cards.js (R 2.13) may call getUserMedia for the camera
// only, with audio: false.
// Run: node --test test/unit/lint-contrib.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanJs } from '../../tools/lint-floor.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const inCalls = (file) => file.startsWith('src/calls/')

// The arguments of the call that starts at `index` (the identifier) hold audio: false.
function callHasAudioFalse (raw, code, index) {
  let i = index
  while (i < code.length && /[\w$]/.test(code[i])) i++
  while (i < code.length && /\s/.test(code[i])) i++
  if (code[i] !== '(') return false
  let depth = 0
  for (let j = i; j < code.length; j++) {
    if (code[j] === '(') depth++
    else if (code[j] === ')' && --depth === 0) return /\baudio\s*:\s*false\b/.test(raw.slice(i, j + 1))
  }
  return false
}

/**
 * CONTRIB_RULES: { id, why, code: [RegExp] (matched on code with comments and strings blanked), raw: [RegExp]
 * (matched on the raw text, kept only where the match starts in code: bracket access with a string key),
 * typeofOk (a match inside a typeof expression is feature detection), allowed(file, raw, code, index) }.
 */
export const CONTRIB_RULES = [
  {
    id: 'audioSession write',
    why: 'no navigator.audioSession writes (SZ 3.1.9): it tells the operating system that media plays when none does',
    code: [
      /\baudioSession\s*(?:(?:\?\.|\.)\s*[A-Za-z_$][\w$]*\s*|\[[^\]\n]*\]\s*)*(?:=(?![=>])|\+=|-=|\|\|=|&&=|\?\?=)/g,
      /\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties)|Reflect\s*\.\s*(?:set|defineProperty))\s*\(\s*(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*audioSession\b/g,
      /(?:^|[^=!<>])=\s*(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*audioSession\b(?!\s*(?:\?\.|\.|\[|\())/gm,
      /\{[^}\n]*\baudioSession\b[^}\n]*\}\s*=(?!=)/g
    ],
    raw: [/\[\s*(['"`])audioSession\1\s*\]/g],
    typeofOk: false,
    allowed: () => false
  },
  {
    id: 'keep-alive media',
    why: "no silent or keep-alive media (SZ 3.1.9): 'new Audio(', createOscillator and '.loop = true' only in src/loader/call-ui.js (the ring sound)",
    code: [
      /\bnew\s+(?:(?:window|globalThis|self)\s*\.\s*)?Audio\s*\(/g,
      /\bcreateOscillator\b/g,
      /\bOscillatorNode\b/g,
      /\.\s*loop\s*=\s*(?:true\b|!0\b|1\b)/g
    ],
    raw: [/\[\s*(['"`])createOscillator\1\s*\]/g],
    typeofOk: false,
    allowed: (file) => file === 'src/loader/call-ui.js'
  },
  {
    id: 'wake lock',
    why: 'Wake Lock only in src/loader/dock.js and src/calls/session.js (SZ 3.1.9)',
    code: [/\bwakeLock\s*(?:\?\.|\.)\s*request\b/g],
    raw: [/\bwakeLock\s*(?:\?\.)?\s*\[\s*(['"`])request\1\s*\]/g],
    typeofOk: true,
    allowed: (file) => file === 'src/loader/dock.js' || file === 'src/calls/session.js'
  },
  {
    id: 'media capture',
    why: 'getUserMedia and getDisplayMedia only in src/calls/ (SZ 3.1.9); the src/idp/cards.js QR scanner may use the camera with audio: false',
    code: [/\b(?:getUserMedia|getDisplayMedia|webkitGetUserMedia|mozGetUserMedia)\b/g],
    raw: [/\[\s*(['"`])(?:getUserMedia|getDisplayMedia|webkitGetUserMedia|mozGetUserMedia)\1\s*\]/g],
    typeofOk: true,
    allowed: (file, raw, code, index) => inCalls(file) ||
      (file === 'src/idp/cards.js' && code.slice(index, index + 12) === 'getUserMedia' && callHasAudioFalse(raw, code, index))
  }
]

const TYPEOF_BEFORE = /\btypeof\s+(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*$/

/** lintContrib(file, text) → [{ file, line, column, id, match, why }] (file: a path relative to the repository). */
export function lintContrib (file, text) {
  const raw = String(text)
  const { code } = scanJs(raw)
  const out = []
  const seen = new Set()
  const report = (rule, index, match) => {
    const key = rule.id + ':' + index
    if (seen.has(key)) return
    seen.add(key)
    const before = raw.slice(0, index)
    const line = before.split('\n').length
    const column = index - before.lastIndexOf('\n')
    out.push({ file, line, column, id: rule.id, match: match.trim(), why: rule.why })
  }
  for (const rule of CONTRIB_RULES) {
    for (const re of rule.code) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(code)) !== null) {
        const lead = m[0].search(/[A-Za-z_$.{]/)
        const index = m.index + Math.max(0, lead)
        if (re.lastIndex === m.index) re.lastIndex++
        if (rule.typeofOk && TYPEOF_BEFORE.test(code.slice(Math.max(0, index - 160), index))) continue
        if (rule.allowed(file, raw, code, index)) continue
        report(rule, index, raw.slice(index, m.index + m[0].length))
      }
    }
    for (const re of rule.raw) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(raw)) !== null) {
        if (re.lastIndex === m.index) re.lastIndex++
        const bracket = m.index + m[0].indexOf('[')
        if (code[bracket] !== '[') continue // inside a comment or a string
        if (rule.allowed(file, raw, code, m.index)) continue
        report(rule, m.index, m[0])
      }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column)
}

function sourceFiles (dir, rel = 'src') {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name)
    const r = rel + '/' + ent.name
    if (ent.isDirectory()) out.push(...sourceFiles(abs, r))
    else if (ent.isFile() && /\.(?:m|c)?js$/.test(ent.name)) out.push(r)
  }
  return out
}

const ids = (file, text) => lintContrib(file, text).map((f) => f.id)

test('SZ 3.1.9: the tree passes (no keep-alive media, no audioSession writes, Wake Lock and capture only where allowed)', () => {
  const files = sourceFiles(join(ROOT, 'src'))
  assert.ok(files.length > 100, 'src/ was scanned (' + files.length + ' files)')
  const findings = []
  for (const f of files) findings.push(...lintContrib(f, readFileSync(join(ROOT, f), 'utf8')))
  assert.deepEqual(findings.map((x) => x.file + ':' + x.line + ':' + x.column + ' ' + x.id + ' ' + x.match), [])
})

test('the recorded exception is real and narrow: src/idp/cards.js calls getUserMedia for the camera with audio: false', () => {
  const text = readFileSync(join(ROOT, 'src/idp/cards.js'), 'utf8')
  assert.match(scanJs(text).code, /\bgetUserMedia\s*\(/, 'the exception still has a call to cover')
  const audio = text.replace('audio: false', 'audio: true')
  assert.deepEqual(ids('src/idp/cards.js', audio), ['media capture'], 'asking for the microphone there fails')
  assert.deepEqual(ids('src/idp/cards.js', 'md.getDisplayMedia({ video: true, audio: false })'), ['media capture'], 'no screen capture there')
  assert.deepEqual(ids('src/idp/other.js', 'md.getUserMedia({ video: true, audio: false })'), ['media capture'], 'the exception names one file')
})

test('inline fixtures: every rule fails where the design forbids it', () => {
  const cases = [
    ['src/loader/app.js', "navigator.audioSession.type = 'playback'", 'audioSession write'],
    ['src/calls/session.js', "navigator.audioSession.type = 'play-and-record'", 'audioSession write'],
    ['src/loader/app.js', "nav.audioSession['type'] = 'playback'", 'audioSession write'],
    ['src/loader/app.js', "navigator['audioSession'].type = 'playback'", 'audioSession write'],
    ['src/loader/app.js', "const s = navigator.audioSession\ns.type = 'playback'", 'audioSession write'],
    ['src/loader/app.js', 'const { audioSession } = navigator', 'audioSession write'],
    ['src/loader/app.js', "Object.assign(navigator.audioSession, { type: 'playback' })", 'audioSession write'],
    ['src/media/service.js', "const a = new Audio('/silence.mp3')", 'keep-alive media'],
    ['src/media/service.js', 'el.loop = true', 'keep-alive media'],
    ['src/media/service.js', 'el.loop=!0', 'keep-alive media'],
    ['src/loader/app.js', 'const o = ctx.createOscillator()', 'keep-alive media'],
    ['src/loader/app.js', 'const o = new OscillatorNode(ctx)', 'keep-alive media'],
    ['src/loader/app.js', "const o = ctx['createOscillator']()", 'keep-alive media'],
    ['src/loader/app.js', "await navigator.wakeLock.request('screen')", 'wake lock'],
    ['src/loader/ui.js', "nav.wakeLock?.request('screen')", 'wake lock'],
    ['src/calls/service.js', "wakeLock.request('screen')", 'wake lock'],
    ['src/loader/app.js', "nav.wakeLock['request']('screen')", 'wake lock'],
    ['src/loader/call-ui.js', 'navigator.mediaDevices.getUserMedia({ audio: true })', 'media capture'],
    ['src/chat/service.js', 'md.getDisplayMedia()', 'media capture'],
    ['src/loader/call-ui.js', 'const can = md && md.getDisplayMedia ? 1 : 0', 'media capture'],
    ['src/loader/app.js', "navigator.mediaDevices['getUserMedia']({ video: true })", 'media capture'],
    ['src/loader/app.js', 'navigator.webkitGetUserMedia({ audio: true }, ok, fail)', 'media capture']
  ]
  for (const [file, text, id] of cases) assert.deepEqual(ids(file, text), [id], file + ': ' + text)
  const two = lintContrib('src/media/x.js', "const a = new Audio(src)\na.loop = true\nnavigator.audioSession.type = 'playback'")
  assert.deepEqual(two.map((f) => [f.line, f.id]), [[1, 'keep-alive media'], [2, 'keep-alive media'], [3, 'audioSession write']])
})

test('inline fixtures: allowed places, comments, strings, typeof checks and reads pass', () => {
  const clean = [
    ['src/loader/dock.js', "pending = nav.wakeLock.request('screen')"],
    ['src/calls/session.js', "const lock = await deps.wakeLock.request('screen')\nconst s = await md.getUserMedia({ audio: true, video: true })"],
    ['src/calls/media.js', 'const s = await md.getDisplayMedia({ video: true })'],
    ['src/loader/call-ui.js', 'const ring = new Audio(url)\nring.loop = true\nconst o = ctx.createOscillator()'],
    ['src/loader/call-ui.js', "const canShare = !!(md && typeof md.getDisplayMedia === 'function')"],
    ['src/loader/app.js', "const can = typeof nav.wakeLock.request === 'function' && 'wakeLock' in nav"],
    ['src/loader/app.js', "// never: new Audio(), el.loop = true, navigator.audioSession.type = 'playback'\nconst x = 1"],
    ['src/loader/app.js', "/* wakeLock.request('screen') lives in dock.js */ const y = 2"],
    ['src/loader/app.js', "throw new Error('getUserMedia is not allowed here; navigator.audioSession.type = x')"],
    ['src/loader/app.js', 'const t = `call getDisplayMedia from a click`'],
    ['src/loader/app.js', "if ('audioSession' in navigator && navigator.audioSession.type === 'playback') log('x')"],
    ['src/loader/app.js', 'const re = /getUserMedia|new Audio\\(/'],
    ['src/loader/app.js', 'const loops = el.loop === true']
  ]
  for (const [file, text] of clean) assert.deepEqual(lintContrib(file, text), [], file + ': ' + text)
  assert.deepEqual(ids('src/calls/media.js', "wakeLock.request('screen')"), ['wake lock'], 'src/calls/ allows capture, not Wake Lock')
})
