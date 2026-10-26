// node --test worker.test.mjs   (Node >= 22). Mocks env.ASSETS and env.DENYLIST.
import test from 'node:test'
import assert from 'node:assert/strict'
import worker from './worker.js'

const L1 = 'abcdefghijklmnopqrstuvwxyz234567'
const L2 = '765432zyxwvutsrqponmlkjihgfedcba'
const mk = (denied = {}, kvThrows = false) => ({
  SITES_DOMAIN: 'hub-sites.example', CONTROL_URL: 'https://hub.example',
  DENYLIST: { get: async (k) => { if (kvThrows) throw new Error('kv down'); return denied[k] ?? null } },
  ASSETS: { fetch: async (req) => new Response('ASSET:' + new URL(req.url).pathname, { headers: { 'content-type': 'text/html' } }) },
})
const call = (env, host, p = '/', h = {}) => worker.fetch(new Request(`https://${host}${p}`, { headers: h }), env)
const DOC = { 'sec-fetch-dest': 'document' }

test('foreign host 421; vanity and malformed labels 404', async () => {
  assert.equal((await call(mk(), 'evil.example')).status, 421)
  for (const l of ['login-paypal', `a.${L1}`, `${L1}a`, L1.slice(1), '0123456789abcdef0123456789abcdef01234567', 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrsa']) {
    assert.equal((await call(mk(), `${l}.hub-sites.example`)).status, 404, l)
  }
})
test('valid labels get the shell for document navigations; deep links too', async () => {
  for (const l of [L1, L2]) for (const p of ['/', '/about', '/about.html', '/a/b', '/index.html']) {
    const r = await call(mk(), `${l}.hub-sites.example`, p, DOC)
    assert.equal(r.status, 200); assert.equal(await r.text(), 'ASSET:/index.html')
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow')
  }
})
test('denylisted label -> 451 + Clear-Site-Data "storage" + blocked-by on every path incl. the SW script', async () => {
  const env = mk({ [L1]: 'phish' })
  for (const p of ['/', '/mw-sw.js', '/_mw/loader.js', '/_mw/hub/status']) {
    const r = await call(env, `${L1}.hub-sites.example`, p, DOC)
    assert.equal(r.status, 451, p)
    assert.equal(r.headers.get('clear-site-data'), '"storage"')
    assert.match(r.headers.get('link'), /rel="blocked-by"/)
  }
  assert.equal((await call(env, `${L2}.hub-sites.example`, '/_mw/hub/status')).status, 200)
})
test('status ping is generated; other /_mw/hub/* paths are 404', async () => {
  const r = await call(mk(), `${L1}.hub-sites.example`, '/_mw/hub/status')
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal((await call(mk(), `${L1}.hub-sites.example`, '/_mw/hub/other')).status, 404)
})
test('missing subresources are real 404s', async () => {
  for (const [p, d] of [['/m.js', 'script'], ['/x.css', 'style'], ['/d/a.json', 'empty'], ['/x.png', 'image']]) {
    assert.equal((await call(mk(), `${L1}.hub-sites.example`, p, { 'sec-fetch-dest': d })).status, 404, p)
  }
})
test('physical files pass to ASSETS with the right cache headers', async () => {
  const sw = await call(mk(), `${L1}.hub-sites.example`, '/mw-sw.js', { 'sec-fetch-dest': 'serviceworker' })
  assert.equal(sw.status, 200); assert.equal(sw.headers.get('cache-control'), 'no-cache')
  const a = await call(mk(), `${L1}.hub-sites.example`, '/_mw/loader.js', { 'sec-fetch-dest': 'script' })
  assert.equal(await a.text(), 'ASSET:/_mw/loader.js'); assert.equal(a.headers.get('cache-control'), 'public, max-age=300')
})
test('KV outage fails open', async () => {
  assert.equal((await call(mk({}, true), `${L1}.hub-sites.example`, '/', DOC)).status, 200)
})
