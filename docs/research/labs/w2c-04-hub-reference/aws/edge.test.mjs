// node --test edge.test.mjs   (Node >= 22). Runs the CloudFront Function source with a fake `cloudfront` module.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const L1 = 'abcdefghijklmnopqrstuvwxyz234567' // 32 chars of [a-z2-7]: valid label (ARCHITECTURE.md v0.2 section 3.2)
const L2 = '765432zyxwvutsrqponmlkjihgfedcba'
const L3 = 'mfrggzdfmztwq2lknnwg23tpobyxe43u'

function load({ denied = new Set(), kvsThrows = false } = {}) {
  const src = fs.readFileSync(path.join(here, 'edge.js'), 'utf8')
    .replaceAll('__SITES_DOMAIN__', 'hub-sites.example')
    .replaceAll('__CONTROL_URL__', 'https://hub.example')
    .replace("import cf from 'cloudfront';", '')
  const kvs = { exists: async (k) => { if (kvsThrows) throw new Error('boom'); return denied.has(k) } }
  const sandbox = { cf: { kvs: () => kvs }, console: { log() {} } }
  vm.createContext(sandbox)
  vm.runInContext(src + '\n;globalThis.handler = handler;', sandbox)
  return sandbox.handler
}
const ev = (host, uri = '/', hdr = {}) => ({ request: { method: 'GET', uri, querystring: {}, cookies: {}, headers: { host: { value: host }, ...Object.fromEntries(Object.entries(hdr).map(([k, v]) => [k, { value: v }])) } } })
const DOC = { 'sec-fetch-dest': 'document' }

test('foreign host is rejected with 421', async () => {
  assert.equal((await load()(ev('evil.example'))).statusCode, 421)
  assert.equal((await load()(ev('hub-sites.example'))).statusCode, 421) // the bare sites domain is not a label
})
test('vanity and malformed labels do not resolve', async () => {
  const h = load()
  const bad = ['login-paypal', 'www', L1.slice(1), L1 + 'a', 'a.' + L1, L1.slice(0, 31) + '0', L1.slice(0, 31) + '1', L1.slice(0, 31) + '8',
    '0123456789abcdef0123456789abcdef01234567', // 40 hex (the old v0.1 label form)
    'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrsa'] // 52 base32 (a 32-byte id form; not a v0.2 label)
  for (const l of bad) assert.equal((await h(ev(`${l}.hub-sites.example`, '/', DOC))).statusCode, 404, l)
})
test('valid labels get the shell for document navigations', async () => {
  const h = load()
  for (const l of [L1, L2, L3]) {
    const r = await h(ev(`${l}.hub-sites.example`, '/', DOC))
    assert.equal(r.uri, '/index.html'); assert.equal(r.statusCode, undefined)
  }
})
test('host normalisation: case, port, trailing dot', async () => {
  const h = load()
  for (const host of [`${L1.toUpperCase()}.HUB-SITES.EXAMPLE`, `${L1}.hub-sites.example:443`, `${L1}.hub-sites.example.`]) {
    assert.equal((await h(ev(host, '/', DOC))).uri, '/index.html', host)
  }
})
test('denylisted label: 451 + Clear-Site-Data "storage" + blocked-by on EVERY path, including the SW script', async () => {
  const h = load({ denied: new Set([L1]) })
  for (const u of ['/', '/about.html', '/mw-sw.js', '/_mw/loader.js', '/_mw/hub/status']) {
    const r = await h(ev(`${L1}.hub-sites.example`, u, DOC))
    assert.equal(r.statusCode, 451, u)
    assert.equal(r.headers['clear-site-data'].value, '"storage"', u)
    assert.match(r.headers.link.value, /rel="blocked-by"/)
    assert.equal(r.headers['cache-control'].value, 'no-store')
  }
  assert.equal((await h(ev(`${L2}.hub-sites.example`, '/', DOC))).uri, '/index.html') // other labels unaffected
})
test('status ping: 200 when allowed; other /_mw/hub/* paths are 404', async () => {
  const ok = await load()(ev(`${L1}.hub-sites.example`, '/_mw/hub/status'))
  assert.equal(ok.statusCode, 200); assert.equal(JSON.parse(ok.body.data).status, 'ok')
  assert.equal((await load()(ev(`${L1}.hub-sites.example`, '/_mw/hub/other'))).statusCode, 404)
})
test('physical shell files pass through untouched (a miss stays a miss at the origin)', async () => {
  const h = load()
  for (const u of ['/mw-sw.js', '/mw-sw-kill.js', '/build.json', '/_mw/loader.js', '/_mw/boot.js', '/_mw/icons/icon.svg', '/robots.txt', '/.well-known/security.txt']) {
    const r = await h(ev(`${L1}.hub-sites.example`, u, { 'sec-fetch-dest': 'script' }))
    assert.equal(r.uri, u, u); assert.equal(r.statusCode, undefined, u)
  }
})
test('subresource-looking misses are real 404s, not HTML', async () => {
  const h = load()
  for (const [u, d] of [['/missing.js', 'script'], ['/x.css', 'style'], ['/x.png', 'image'], ['/data/about.json', 'empty'], ['/x.wasm', 'empty'], ['/sw-old.js', 'serviceworker']]) {
    assert.equal((await h(ev(`${L1}.hub-sites.example`, u, { 'sec-fetch-dest': d }))).statusCode, 404, u)
  }
})
test('deep links navigate to the shell (shell mode answers every URL with the shell)', async () => {
  const h = load()
  for (const u of ['/', '/about', '/about.html', '/a/b/c', '/a/b/page.htm', '/index.html', '/404.html']) {
    assert.equal((await h(ev(`${L1}.hub-sites.example`, u, DOC))).uri, '/index.html', u)
  }
  assert.equal((await h(ev(`${L1}.hub-sites.example`, '/about'))).uri, '/index.html') // clients without Sec-Fetch-Dest
})
test('KVS failure fails open (site still served)', async () => {
  const r = await load({ kvsThrows: true })(ev(`${L1}.hub-sites.example`, '/', DOC))
  assert.equal(r.uri, '/index.html')
})
