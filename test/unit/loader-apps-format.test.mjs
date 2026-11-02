// Unit tests for src/loader/apps-format.js (ARCHITECTURE 15.21, formatting md1): the md1 parser's node description, link
// detection, no HTML injection by construction, the search helpers and the export shape.
// Run: node tools/run-unit.mjs test/unit/loader-apps-format.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  TEXT_MAX, ROOM_TEXT_MAX, REACTION_MAX, MAX_DEPTH, MAX_NODES, URL_MAX, COMMON_EMOJI,
  sanitizeText, parseMd1, nodesText, plainText, previewText, urlAt, linksIn, hasLink, isEmoji, foldText, searchMessages,
  exportConversation, exportFileName, EXPORT_FORMAT, EXPORT_VERSION
} from '../../src/loader/apps-format.js'

const T = (s) => ({ t: 'text', s })
const link = (href, text = href) => ({ t: 'a', href, rel: 'noopener noreferrer', target: '_blank', c: [T(text)] })
const ch = (code) => String.fromCodePoint(code)

describe('limits and the emoji list', () => {
  test('the plan numbers', () => {
    assert.equal(TEXT_MAX, 3500)
    assert.equal(ROOM_TEXT_MAX, 2000)
    assert.equal(REACTION_MAX, 8)
    assert.equal(COMMON_EMOJI.length, 32)
    assert.equal(new Set(COMMON_EMOJI).size, 32)
    for (const e of COMMON_EMOJI) assert.ok(isEmoji(e), e)
  })

  test('isEmoji: any short string without spaces or controls, no list', () => {
    assert.ok(isEmoji('\u{1F600}'))
    assert.ok(isEmoji('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}')) // a family: 7 code points
    assert.ok(isEmoji('ok'))
    assert.ok(!isEmoji(''))
    assert.ok(!isEmoji('a b'))
    assert.ok(!isEmoji('a\nb'))
    assert.ok(!isEmoji('123456789')) // 9 code points
    assert.ok(!isEmoji('a' + ch(0x202e)))
    assert.ok(!isEmoji(null))
    assert.ok(!isEmoji(5))
    assert.ok(!isEmoji({}))
    assert.ok(!isEmoji(['x']))
  })

  test('isEmoji: a name every object has is not a reaction (ADV-6), though other short words are', () => {
    for (const name of ['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__']) assert.ok(!isEmoji(name), name)
    for (const word of ['ok', 'yes', 'tostring', 'ToString', 'valueof', 'proto']) assert.ok(isEmoji(word), word)
  })
})

describe('sanitizeText', () => {
  test('controls, bidi overrides and isolates go; joiners and marks Persian needs stay', () => {
    assert.equal(sanitizeText('a' + ch(7) + 'b' + ch(0) + 'c'), 'abc')
    assert.equal(sanitizeText('x' + ch(0x202e) + 'evil' + ch(0x202c) + 'y'), 'xevily')
    assert.equal(sanitizeText('p' + ch(0x2066) + 'q' + ch(0x2069)), 'pq')
    assert.equal(sanitizeText('\u{FEFF}start'), 'start')
    assert.equal(sanitizeText('ab' + ch(0x200c) + 'cd'), 'ab' + ch(0x200c) + 'cd') // ZWNJ is Persian text
    assert.equal(sanitizeText('a' + ch(0x200f) + 'b'), 'a' + ch(0x200f) + 'b') // right-to-left mark
    assert.equal(sanitizeText('a\tb'), 'a\tb')
  })

  test('line ends become \\n; lone surrogates become U+FFFD; non-strings become text', () => {
    assert.equal(sanitizeText('a\r\nb\rc\u{2028}d\u{2029}e'), 'a\nb\nc\nd\ne')
    assert.equal(sanitizeText('a\ud800b'), 'a\u{fffd}b')
    assert.equal(sanitizeText('a\udc00b'), 'a\u{fffd}b')
    assert.equal(sanitizeText('\u{1F600}'), '\u{1F600}')
    assert.equal(sanitizeText(null), '')
    assert.equal(sanitizeText(undefined), '')
    assert.equal(sanitizeText(42), '42')
  })
})

describe('md1 marks', () => {
  test('plain text is one text node', () => {
    assert.deepEqual(parseMd1('hello world'), [T('hello world')])
    assert.deepEqual(parseMd1(''), [])
  })

  test('each mark', () => {
    assert.deepEqual(parseMd1('*bold*'), [{ t: 'b', c: [T('bold')] }])
    assert.deepEqual(parseMd1('_italic_'), [{ t: 'i', c: [T('italic')] }])
    assert.deepEqual(parseMd1('__under__'), [{ t: 'u', c: [T('under')] }])
    assert.deepEqual(parseMd1('~strike~'), [{ t: 's', c: [T('strike')] }])
    assert.deepEqual(parseMd1('`mono`'), [{ t: 'code', s: 'mono' }])
  })

  test('marks inside a sentence keep the text around them', () => {
    assert.deepEqual(parseMd1('a *b* c _d_ e'), [T('a '), { t: 'b', c: [T('b')] }, T(' c '), { t: 'i', c: [T('d')] }, T(' e')])
    assert.deepEqual(parseMd1('(*bold*).'), [T('('), { t: 'b', c: [T('bold')] }, T(').')])
  })

  test('marks nest', () => {
    assert.deepEqual(parseMd1('*bold _and italic_ too*'), [{ t: 'b', c: [T('bold '), { t: 'i', c: [T('and italic')] }, T(' too')] }])
    assert.deepEqual(parseMd1('__~x~__'), [{ t: 'u', c: [{ t: 's', c: [T('x')] }] }])
  })

  test('mono is literal: no marks, no links inside', () => {
    assert.deepEqual(parseMd1('`a *b* https://x.example`'), [{ t: 'code', s: 'a *b* https://x.example' }])
  })

  test('unpaired marks, marks beside spaces and marks inside words are text', () => {
    for (const s of ['*a', 'a*', '* a *', 'snake_case_word', '2*3*4', 'a ~ b', '`open', '__x', 'a_b_c', 'x * y * z']) {
      assert.deepEqual(parseMd1(s), [T(s)], s)
    }
  })

  test('a span does not cross a line', () => {
    assert.deepEqual(parseMd1('*a\nb*'), [T('*a'), { t: 'br' }, T('b*')])
  })

  test('line breaks are br nodes; spaces are kept', () => {
    assert.deepEqual(parseMd1('one\ntwo'), [T('one'), { t: 'br' }, T('two')])
    assert.deepEqual(parseMd1('a  b'), [T('a  b')])
    assert.deepEqual(parseMd1('x\r\ny'), [T('x'), { t: 'br' }, T('y')])
  })

  test('__ is underline, _ is italic, and a lone _ pair inside an underline is italic', () => {
    assert.deepEqual(parseMd1('__a _b_ c__'), [{ t: 'u', c: [T('a '), { t: 'i', c: [T('b')] }, T(' c')] }])
  })

  test('Persian text with marks', () => {
    const fa = '\u{633}\u{644}\u{627}\u{645}'
    assert.deepEqual(parseMd1('*' + fa + '*'), [{ t: 'b', c: [T(fa)] }])
    assert.deepEqual(parseMd1(fa + ' _' + fa + '_'), [T(fa + ' '), { t: 'i', c: [T(fa)] }])
  })

  test('nesting stops at MAX_DEPTH and the node count at MAX_NODES', () => {
    const depth = (nodes) => Math.max(0, ...nodes.map((n) => (n.c ? 1 + depth(n.c) : 0)))
    const deep = '*_~*_~*_~*_~x~_*~_*~_*~_*'
    assert.ok(depth(parseMd1(deep)) <= MAX_DEPTH + 1)
    const many = Array.from({ length: 3000 }, () => '*a*').join(' ')
    const nodes = parseMd1(many)
    const count = (list) => list.reduce((n, x) => n + 1 + (x.c ? count(x.c) : 0), 0)
    assert.ok(count(nodes) <= MAX_NODES + 4, 'node count ' + count(nodes))
    // nothing is lost: once the budget is spent the rest is plain text, marks included
    assert.ok(nodesText(nodes).replace(/[*\s]/g, '') === many.replace(/[*\s]/g, ''))
  })

  test('a long run of unmatched marks stays fast', () => {
    const s = '*a '.repeat(1300)
    const t0 = Date.now()
    parseMd1(s)
    assert.ok(Date.now() - t0 < 1500, 'parsing took ' + (Date.now() - t0) + ' ms')
  })

  test('plainText, nodesText and previewText', () => {
    assert.equal(plainText('*a* _b_ `c` https://x.example/p'), 'a b c https://x.example/p')
    assert.equal(plainText('one\ntwo'), 'one\ntwo')
    assert.equal(previewText('*hello*   world\nagain'), 'hello world again')
    assert.equal(previewText('x'.repeat(200), 10), 'xxxxxxx...')
    assert.equal(previewText('short', 10), 'short')
  })
})

describe('links', () => {
  test('an http and an https URL become links; the visible text is what was typed', () => {
    assert.deepEqual(parseMd1('see https://example.com/a?b=1#c now'), [T('see '), link('https://example.com/a?b=1#c'), T(' now')])
    assert.deepEqual(parseMd1('http://example.org'), [link('http://example.org/', 'http://example.org')])
    assert.deepEqual(parseMd1('HTTPS://Example.COM/x'), [link('https://example.com/x', 'HTTPS://Example.COM/x')])
  })

  test('every link carries rel noopener noreferrer and target _blank', () => {
    const [a] = parseMd1('https://example.com')
    assert.equal(a.rel, 'noopener noreferrer')
    assert.equal(a.target, '_blank')
  })

  test('trailing punctuation and unbalanced brackets are not part of the URL', () => {
    assert.deepEqual(parseMd1('go to https://example.com/x.'), [T('go to '), link('https://example.com/x'), T('.')])
    assert.deepEqual(parseMd1('(https://example.com/x)'), [T('('), link('https://example.com/x'), T(')')])
    assert.deepEqual(parseMd1('https://example.com/a_(b)'), [link('https://example.com/a_(b)')])
    assert.deepEqual(parseMd1('"https://example.com/x",'), [T('"'), link('https://example.com/x'), T('",')])
    assert.deepEqual(parseMd1('https://example.com/x!?'), [link('https://example.com/x'), T('!?')])
  })

  test('only http and https', () => {
    for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/x', 'file:///etc/passwd', 'vbscript:x', 'mailto:a@example.com']) {
      assert.deepEqual(parseMd1(s), [T(s)], s)
      assert.ok(!hasLink(s), s)
    }
  })

  test('a URL with a user name or password is not linked', () => {
    for (const s of ['https://user:pw@example.com/', 'https://good.example@bad.example/', 'http://a@b.example']) {
      assert.deepEqual(parseMd1(s), [T(s)], s)
    }
  })

  test('a URL without a host, or too long, is not linked', () => {
    assert.deepEqual(parseMd1('https://'), [T('https://')])
    assert.deepEqual(parseMd1('https:///x'), [T('https:///x')])
    const long = 'https://example.com/' + 'a'.repeat(URL_MAX)
    const nodes = parseMd1(long)
    assert.ok(nodes.length === 1 && nodes[0].t === 'text' && nodes[0].s === long)
  })

  test('a link needs a boundary before it', () => {
    assert.deepEqual(parseMd1('xhttps://example.com'), [T('xhttps://example.com')])
    assert.deepEqual(parseMd1('x https://example.com'), [T('x '), link('https://example.com/', 'https://example.com')])
  })

  test('underscores inside a URL do not italicise; a closing mark after a URL still closes', () => {
    assert.deepEqual(parseMd1('https://example.com/a_b_c'), [link('https://example.com/a_b_c')])
    assert.deepEqual(parseMd1('*see https://example.com/x*'), [{ t: 'b', c: [T('see '), link('https://example.com/x')] }])
    assert.deepEqual(parseMd1('_https://example.com/x_'), [{ t: 'i', c: [link('https://example.com/x')] }])
  })

  test('a link inside mono is text', () => {
    assert.deepEqual(parseMd1('`https://example.com`'), [{ t: 'code', s: 'https://example.com' }])
  })

  test('urlAt, linksIn and hasLink', () => {
    const s = 'a https://one.example/x, b http://two.example'
    assert.equal(urlAt(s, 2).text, 'https://one.example/x')
    assert.equal(urlAt(s, 0), null)
    const l = linksIn(s)
    assert.deepEqual(l.map((x) => x.text), ['https://one.example/x', 'http://two.example'])
    assert.deepEqual(l.map((x) => [x.start, x.end]), [[2, 23], [27, 45]])
    assert.ok(hasLink(s))
    assert.ok(!hasLink('no links here, only example.com'))
  })

  test('an international host is linked with its ASCII form in href', () => {
    const [a] = parseMd1('https://b\u{fc}cher.example/x')
    assert.equal(a.t, 'a')
    assert.equal(a.href, 'https://xn--bcher-kva.example/x')
    assert.equal(a.c[0].s, 'https://b\u{fc}cher.example/x')
  })
})

describe('no HTML injection', () => {
  const ALLOWED = { text: ['t', 's'], br: ['t'], code: ['t', 's'], b: ['t', 'c'], i: ['t', 'c'], u: ['t', 'c'], s: ['t', 'c'], a: ['t', 'href', 'rel', 'target', 'c'] }

  function check (nodes, path = 'root') {
    assert.ok(Array.isArray(nodes), path)
    for (const n of nodes) {
      assert.ok(n && typeof n === 'object' && ALLOWED[n.t], path + ': type ' + (n && n.t))
      assert.deepEqual(Object.keys(n).sort(), ALLOWED[n.t].slice().sort(), path + ': keys of ' + n.t)
      if (n.t === 'text' || n.t === 'code') assert.equal(typeof n.s, 'string')
      if (n.t === 'a') {
        assert.match(n.href, /^https?:\/\/[^\s<>"]+$/)
        assert.equal(n.rel, 'noopener noreferrer')
        assert.equal(n.target, '_blank')
        assert.equal(n.c.length, 1)
        assert.equal(n.c[0].t, 'text')
      }
      if (n.c) check(n.c, path + '/' + n.t)
    }
  }

  const NASTY = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "' onmouseover='alert(1)",
    '*<b>bold</b>*', '_<i>x</i>_', '`<u>x</u>`', 'https://example.com/"onmouseover="alert(1)', 'https://example.com/<script>',
    '[click](javascript:alert(1))', '<a href="javascript:alert(1)">x</a>', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=',
    'https://example.com/\u{202e}evil', '&lt;script&gt;', '&#x3c;img src=x&#x3e;', '${alert(1)}', '{{constructor.constructor("alert(1)")()}}',
    '\u0000\u0001', '*\u0000*', 'a\ud800b', '__proto__', 'constructor', 'toString', '<!--', ']]>'
  ]

  test('a script, an attribute, a template or an entity stays text; nothing outside the node vocabulary appears', () => {
    for (const s of NASTY) {
      const nodes = parseMd1(s)
      check(nodes)
      // the text of the nodes is the input with only its marks, controls and bidi characters taken out
      const visible = nodesText(nodes)
      assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(visible), s)
    }
    assert.deepEqual(parseMd1('<img src=x onerror=alert(1)>'), [T('<img src=x onerror=alert(1)>')])
    assert.deepEqual(parseMd1('<b>x</b>'), [T('<b>x</b>')])
    assert.deepEqual(parseMd1('*<b>x</b>*'), [{ t: 'b', c: [T('<b>x</b>')] }])
  })

  test('a quote or angle bracket ends a URL, so it cannot break out of an attribute', () => {
    const nodes = parseMd1('https://example.com/"onmouseover="alert(1)')
    check(nodes)
    assert.equal(nodes[0].t, 'a')
    assert.equal(nodes[0].href, 'https://example.com/')
    assert.equal(nodes[1].s, '"onmouseover="alert(1)')
  })

  test('random strings of marks, URLs and markup always give valid nodes', () => {
    let seed = 12345
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n }
    const parts = ['*', '_', '__', '~', '`', ' ', '\n', 'a', 'bc', '<', '>', '"', "'", 'https://', 'http://x.example/', 'x.example', '/', '(', ')', '.', ',', '\u{1F600}', '\u{633}', '&', ';', '@', ':', '%41']
    for (let i = 0; i < 400; i++) {
      let s = ''
      const n = 1 + rnd(40)
      for (let k = 0; k < n; k++) s += parts[rnd(parts.length)]
      const nodes = parseMd1(s)
      check(nodes, JSON.stringify(s))
      // nothing is invented: every character of the visible text comes from the input
      const vis = nodesText(nodes)
      for (const c of Array.from(vis)) assert.ok(s.includes(c) || c === '\n', JSON.stringify(s) + ' -> ' + JSON.stringify(vis))
    }
  })

  test('the node list is plain data: JSON round trip equals the list', () => {
    const nodes = parseMd1('*a* https://example.com `b` __c__\n~d~')
    assert.deepEqual(JSON.parse(JSON.stringify(nodes)), nodes)
  })
})

describe('foldText and searchMessages', () => {
  const day = (d, h = 12) => new Date(2026, 10, d, h).getTime()
  const msgs = [
    { id: 'm1', t: day(1), mine: true, text: 'Caf\u{e9} au lait on Monday' },
    { id: 'm2', t: day(2), mine: false, text: 'See https://example.com/menu please', pinned: true },
    { id: 'm3', t: day(3), mine: true, text: 'the CAFE closes at nine', edits: [{ t: day(3, 11), text: 'cafe closes at eight' }], saved: true },
    { id: 'm4', t: day(4), mine: false, text: 'No match here', reactions: { '\u{1F44D}': ['p256:x'] } },
    { id: 'm5', t: day(5), mine: false, text: '', deleted: true },
    { id: 'm6', t: day(6), mine: true, text: 'nine cafe latte', important: true }
  ]
  const ids = (r) => r.map((x) => x.id)

  test('foldText ignores case, accents, Arabic vowel marks and folds yeh and kaf', () => {
    assert.equal(foldText('Caf\u{e9}').text, 'cafe')
    assert.equal(foldText('\u{643}\u{62a}\u{627}\u{628}').text, '\u{6a9}\u{62a}\u{627}\u{628}') // Arabic kaf -> Persian kaf
    assert.equal(foldText('\u{64a}').text, '\u{6cc}')
    assert.equal(foldText('\u{628}\u{64e}\u{628}').text, '\u{628}\u{628}') // fatha removed
    const f = foldText('Caf\u{e9}!')
    assert.deepEqual([f.starts.length, f.ends.length, f.text.length], [5, 5, 5])
  })

  test('no query returns every message in order', () => {
    assert.deepEqual(ids(searchMessages(msgs, {})), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    assert.deepEqual(ids(searchMessages(msgs)), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    assert.deepEqual(searchMessages([], { text: 'x' }), [])
  })

  test('keywords: every word must occur, any order, any case, accents ignored', () => {
    assert.deepEqual(ids(searchMessages(msgs, { text: 'cafe' })), ['m1', 'm3', 'm6'])
    assert.deepEqual(ids(searchMessages(msgs, { text: 'CAF\u{c9} nine' })), ['m3', 'm6'])
    assert.deepEqual(ids(searchMessages(msgs, { text: 'nine cafe' })), ['m3', 'm6'])
    assert.deepEqual(ids(searchMessages(msgs, { text: 'zebra' })), [])
  })

  test('exact: the phrase in that order', () => {
    assert.deepEqual(ids(searchMessages(msgs, { text: 'nine cafe', exact: true })), ['m6'])
    assert.deepEqual(ids(searchMessages(msgs, { text: 'cafe closes', exact: true })), ['m3'])
    assert.deepEqual(ids(searchMessages(msgs, { text: 'closes cafe', exact: true })), [])
  })

  test('ranges point at the matches in the original text', () => {
    const [r] = searchMessages(msgs, { text: 'cafe' })
    assert.equal(r.id, 'm1')
    assert.deepEqual(r.ranges, [[0, 4]])
    assert.equal(msgs[0].text.slice(r.ranges[0][0], r.ranges[0][1]), 'Caf\u{e9}')
    const r2 = searchMessages([{ id: 'x', t: 1, mine: true, text: 'ab ab ab' }], { text: 'ab' })[0]
    assert.deepEqual(r2.ranges, [[0, 2], [3, 5], [6, 8]])
    const r3 = searchMessages([{ id: 'x', t: 1, mine: true, text: 'one two' }], { text: 'two one' })[0]
    assert.deepEqual(r3.ranges, [[0, 3], [4, 7]])
  })

  test('result records: id, index, t, mine', () => {
    const r = searchMessages(msgs, { text: 'lait' })
    assert.deepEqual(r, [{ id: 'm1', index: 0, t: msgs[0].t, mine: true, ranges: [[8, 12]] }])
  })

  test('a deleted message never matches a text query', () => {
    assert.deepEqual(ids(searchMessages([{ id: 'd', t: 1, mine: true, text: 'secret', deleted: true }], { text: 'secret' })), [])
  })

  test('direction: sent and received', () => {
    assert.deepEqual(ids(searchMessages(msgs, { direction: 'sent' })), ['m1', 'm3', 'm6'])
    assert.deepEqual(ids(searchMessages(msgs, { direction: 'received' })), ['m2', 'm4', 'm5'])
    assert.deepEqual(ids(searchMessages(msgs, { direction: 'any' })).length, 6)
    assert.deepEqual(ids(searchMessages(msgs, { text: 'cafe', direction: 'received' })), [])
  })

  test('date and date range: ms, Date, YYYY-MM-DD (a local day; "to" is the end of that day)', () => {
    assert.deepEqual(ids(searchMessages(msgs, { from: day(3) })), ['m3', 'm4', 'm5', 'm6'])
    assert.deepEqual(ids(searchMessages(msgs, { to: day(2) })), ['m1', 'm2'])
    assert.deepEqual(ids(searchMessages(msgs, { from: new Date(day(2)), to: new Date(day(4)) })), ['m2', 'm3', 'm4'])
    assert.deepEqual(ids(searchMessages(msgs, { from: '2026-11-03', to: '2026-11-04' })), ['m3', 'm4'])
    assert.deepEqual(ids(searchMessages(msgs, { from: '2026-11-04', to: '2026-11-04' })), ['m4'])
    assert.deepEqual(ids(searchMessages(msgs, { from: 'not a date' })).length, 6)
  })

  test('links, saved, pinned, edited, reactions, important', () => {
    assert.deepEqual(ids(searchMessages(msgs, { links: true })), ['m2'])
    assert.deepEqual(ids(searchMessages(msgs, { saved: true })), ['m3'])
    assert.deepEqual(ids(searchMessages(msgs, { pinned: true })), ['m2'])
    assert.deepEqual(ids(searchMessages(msgs, { edited: true })), ['m3'])
    assert.deepEqual(ids(searchMessages(msgs, { reactions: true })), ['m4'])
    assert.deepEqual(ids(searchMessages(msgs, { important: true })), ['m6'])
  })

  test('filters combine', () => {
    assert.deepEqual(ids(searchMessages(msgs, { text: 'cafe', direction: 'sent', from: day(2), saved: true })), ['m3'])
    assert.deepEqual(ids(searchMessages(msgs, { text: 'https', links: true, direction: 'received' })), ['m2'])
  })

  test('Persian: kaf and yeh variants match', () => {
    const fa = [{ id: 'f', t: 1, mine: false, text: '\u{6a9}\u{62a}\u{627}\u{628} \u{6cc}\u{6a9}' }]
    assert.deepEqual(ids(searchMessages(fa, { text: '\u{643}\u{62a}\u{627}\u{628}' })), ['f'])
    assert.deepEqual(ids(searchMessages(fa, { text: '\u{64a}\u{643}' })), ['f'])
  })
})

describe('export', () => {
  const conv = {
    id: 'c1',
    peer: { pub: 'p256:PEER', short: 'abcd-2345', name: 'Bob', nick: 'B.' },
    compare: '12345678',
    cfg: { exp: 60000, receipts: false, typing: true },
    messages: [
      { id: 'a', t: Date.UTC(2026, 10, 1, 12, 0, 0), mine: true, text: 'hello', fmt: 'md1', reply: null, status: 'read', readAt: Date.UTC(2026, 10, 1, 12, 1, 0), edits: [{ t: Date.UTC(2026, 10, 1, 12, 0, 0), text: 'helo' }], deleted: false, reactions: { '\u{1F44D}': ['p256:PEER'] }, pinned: true, saved: false, important: false, prio: true, exp: 60000 },
      { id: 'b', t: Date.UTC(2026, 10, 1, 12, 2, 0), mine: false, text: 'secret', fmt: 'md1', reply: 'a', status: null, readAt: null, edits: [], deleted: true, reactions: { '\u{2764}': ['p256:ME', 'p256:PEER', 'p256:OTHER'] }, pinned: false, saved: true }
    ]
  }
  const me = { pub: 'p256:ME', short: 'wxyz-6789', name: 'Ana' }
  const now = Date.UTC(2026, 10, 1, 13, 0, 0)

  test('the shape', () => {
    const out = exportConversation({ conv, me, now })
    assert.equal(out.format, EXPORT_FORMAT)
    assert.equal(out.format, 'felinar-apps-chat')
    assert.equal(out.version, EXPORT_VERSION)
    assert.equal(out.exportedAt, '2026-11-01T13:00:00.000Z')
    assert.deepEqual(out.me, { pub: 'p256:ME', short: 'wxyz-6789', name: 'Ana' })
    assert.deepEqual(out.peer, { pub: 'p256:PEER', short: 'abcd-2345', name: 'Bob', nick: 'B.' })
    assert.equal(out.compare, '12345678')
    assert.deepEqual(out.cfg, { exp: 60000, receipts: false })
    assert.equal(out.messages.length, 2)
    const [a, b] = out.messages
    assert.deepEqual(Object.keys(a).sort(), ['deleted', 'edits', 'exp', 'fmt', 'from', 'id', 'important', 'pinned', 'prio', 'reactions', 'readAt', 'reply', 'saved', 'status', 't', 'text', 'time'])
    assert.equal(a.from, 'me')
    assert.equal(a.time, '2026-11-01T12:00:00.000Z')
    assert.equal(a.status, 'read')
    assert.deepEqual(a.edits, [{ t: Date.UTC(2026, 10, 1, 12, 0, 0), text: 'helo' }])
    assert.deepEqual(a.reactions, { '\u{1F44D}': ['peer'] })
    assert.equal(a.prio, true)
    assert.equal(b.from, 'peer')
    assert.equal(b.status, null)
    assert.equal(b.text, '', 'a message deleted for both is exported without its text')
    assert.equal(b.deleted, true)
    assert.equal(b.reply, 'a')
    assert.deepEqual(b.reactions, { '\u{2764}': ['me', 'peer', 'other'] })
  })

  test('it is JSON and survives a round trip', () => {
    const out = exportConversation({ conv, me, now })
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
  })

  test('a conversation without a peer yet', () => {
    const out = exportConversation({ conv: { id: 'x', peer: {}, messages: [] }, me: null, now })
    assert.equal(out.me, null)
    assert.deepEqual(out.peer, { pub: null, short: null, name: null, nick: null })
    assert.deepEqual(out.messages, [])
    assert.deepEqual(out.cfg, { exp: null, receipts: true })
  })

  test('the file name: short id and the UTC day, letters digits and hyphens', () => {
    assert.equal(exportFileName(conv, now), 'felinar-chat-abcd-2345-20261101.json')
    assert.equal(exportFileName({ peer: {} }, now), 'felinar-chat-chat-20261101.json')
    assert.match(exportFileName({ peer: { short: '../../x y' } }, now), /^felinar-chat-[A-Za-z0-9-]+-\d{8}\.json$/)
  })
})
