// Arrival safety (v0.2.1 DIGEST-AMENDMENTS C3; research digest P0-15, w1-09 F3-F4, R2) and the removal of
// the v0.1 hub flags (C4; research digest P0-12). parseFragment decodes once and only for encoded-scheme
// fragments; nothing that arrives by fragment, handler or ?mw= loads without the gate's click.
// Run: node --test test/unit/loader-app-arrival.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFragment, resolveMode } from '../../src/loader/app.js'
import { SANDBOX } from '../../src/loader/render.js'
import { parseMagnet } from '../../src/common/magnet.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HEX = '0123456789abcdef0123456789abcdef01234567'
// A tracker with its own query string (?key=a&b=c) and a name with an encoded '=' and '%'.
const LITERAL = 'magnet:?xt=urn:btih:' + HEX + '&dn=a%3Db%25c&tr=' + encodeURIComponent('wss://t.example/announce?key=a&b=c')

test('a literal magnet fragment is kept as typed: the magnet parser decodes its values exactly once', () => {
  const f = parseFragment('#' + LITERAL)
  assert.equal(f.kind, 'magnet')
  assert.equal(f.text, LITERAL)
  const m = parseMagnet(f.text)
  assert.equal(m.btih, HEX)
  assert.deepEqual(m.tr, ['wss://t.example/announce?key=a&b=c'])
  assert.equal(m.dn, 'a=b%c')
})

test('a protocol-handler link (/#%s, the whole magnet percent-encoded) is decoded once, never twice', () => {
  const handlerBuilt = '#' + encodeURIComponent(LITERAL)
  assert.match(handlerBuilt, /^#magnet%3A%3F/)
  const f = parseFragment(handlerBuilt)
  assert.equal(f.kind, 'magnet')
  assert.equal(f.text, LITERAL, 'one decode gives back the literal magnet')
  const m = parseMagnet(f.text)
  assert.deepEqual(m.tr, ['wss://t.example/announce?key=a&b=c'], 'the tracker query survives (a second decode would split it at &)')
  assert.equal(m.dn, 'a=b%c', 'an encoded % survives (a second decode would make it a stray escape)')
})

test('?mw= carries the same text (the query string is decoded by URLSearchParams, once)', () => {
  const f = parseFragment('', '?mw=' + encodeURIComponent(LITERAL))
  assert.equal(f.kind, 'magnet')
  assert.equal(f.text, LITERAL)
})

test('btih: and host: links, and records (literal or handler-encoded)', () => {
  assert.deepEqual(parseFragment('#btih:' + HEX.toUpperCase()), { kind: 'btih', btih: HEX, text: 'magnet:?xt=urn:btih:' + HEX })
  assert.deepEqual(parseFragment('#host:Example.COM.'), { kind: 'host', host: 'example.com', text: null })
  assert.equal(parseFragment('#host:not a host'), null)
  assert.equal(parseFragment('#host:%2F%2Fevil'), null)
  const record = 'v=mw1; btih=' + HEX + '; tr=wss://t.example'
  assert.deepEqual(parseFragment('#' + record), { kind: 'record', text: record })
  assert.deepEqual(parseFragment('#' + encodeURIComponent(record)), { kind: 'record', text: record })
})

test('anything else in the fragment is the site\'s own anchor, not a pointer', () => {
  for (const h of ['#section-2', '#', '', '#magnet', '#btih:xyz', '#javascript:alert(1)', '#https://evil.example/']) assert.equal(parseFragment(h), null, h)
})

test('nothing auto-loads from an arrival: a pointer in the fragment opens the gated hub, not the site', () => {
  const loc = (hash, hostname = '127.0.0.1') => ({ hostname, pathname: '/', search: '', hash })
  const viaHandler = resolveMode(loc('#' + encodeURIComponent(LITERAL)), { dev: true })
  assert.equal(viaHandler.mode, 'hub-shared', 'the shared hub always shows the gate before any connection')
  assert.equal(resolveMode(loc('#' + LITERAL), { hubMeta: 'shared' }).mode, 'hub-shared')
  assert.equal(resolveMode(loc('#' + LITERAL, 'example.com'), { metaPointer: 'v=mw1; btih=' + HEX }).mode, 'shell', 'a shell page ignores a fragment pointer: its own page tag wins')
  assert.equal(resolveMode(loc('', 'example.com'), {}).mode, 'shell')
})

// ---- C4: the v0.1 hub flags are gone -------------------------------------------------------------

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(m?js|html|json)$/.test(name)) out.push(p)
  }
  return out
}

test('no SANDBOX_HUB or HUB_CSP anywhere in src/ or the built dist/, and no protocol-handler registration', async () => {
  // Code review round 1 (F40): a build of its own (it used to walk the shared dist/ and passed when another
  // run had just deleted it).
  const { build } = await import('../../build.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const out = mkdtempSync(join(tmpdir(), 'mw-c4-'))
  try {
    await build({ outDir: join(out, 'dist'), quiet: true })
    const built = walk(join(out, 'dist'))
    assert.ok(built.length >= 10, 'the build produced ' + built.length + ' files')
    const files = walk(join(ROOT, 'src')).concat(built)
    assert.ok(files.length > 20)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      assert.doesNotMatch(text, /SANDBOX_HUB|HUB_CSP/, f)
      if (f.includes('/src/')) assert.doesNotMatch(text, /registerProtocolHandler/, f)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('render.js keeps exactly two frame sandboxes; the shared-origin demo hub cannot download', () => {
  assert.deepEqual(Object.keys(SANDBOX).sort(), ['hub-shared', 'shell'])
  assert.doesNotMatch(SANDBOX['hub-shared'], /allow-downloads/)
  assert.match(SANDBOX.shell, /allow-same-origin/, 'the same-origin frame is what the Service Worker controls')
  assert.ok(Object.isFrozen(SANDBOX))
})
