// What does a Public Suffix List entry change for sibling subdomains <a|b>.<parent>?  (cookies, cookie bomb, Sec-Fetch-Site, HTTP cache, storage)
// Hostnames are mapped to 127.0.0.1 with --host-resolver-rules, so no DNS or public domain is touched.
// PSL stand-ins: cloudfront.net (private-section entry) and *.inbrowser.link (wildcard rule, like *.dweb.link / *.eth.limo).
// Run: node psl-effects.mjs > results-psl-effects.json
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchChrome } from './chrome.mjs'

const CASES = [
  { name: 'NON-PSL parent hub-lab.test', parent: 'hub-lab.test' },
  { name: 'PSL private entry cloudfront.net', parent: 'cloudfront.net' },
  { name: 'PSL wildcard rule *.inbrowser.link (parent ipfs.inbrowser.link)', parent: 'ipfs.inbrowser.link' },
]
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-psl-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '2', '-subj', '/CN=lab'], { stdio: 'ignore' })

const hits = []
const handler = (scheme) => (req, res) => {
  const host = (req.headers.host || '').split(':')[0]
  const url = new URL(req.url, 'http://x')
  hits.push({ scheme, host, path: url.pathname })
  const cors = { 'access-control-allow-origin': '*' }
  if (url.pathname === '/shared.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600', ...cors }); return res.end('window.__shared = 1;') }
  if (url.pathname === '/echo') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); return res.end(JSON.stringify({ sfs: req.headers['sec-fetch-site'] || null })) }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><meta charset=utf-8><body>ok</body>')
}
const hs = http.createServer({ maxHeaderSize: 16384 }, handler('http')) // Node default request-header cap (16 KiB); CloudFront's is 32,768 bytes
hs.on('clientError', (e, s) => s.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'))
const ss = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')), maxHeaderSize: 16384 }, handler('https'))
await new Promise(r => hs.listen(0, '127.0.0.1', r)); await new Promise(r => ss.listen(0, '127.0.0.1', r))
const P1 = hs.address().port, P2 = ss.address().port

const chrome = await launchChrome({
  hostRules: 'MAP *.hub-lab.test 127.0.0.1, MAP *.cloudfront.net 127.0.0.1, MAP *.inbrowser.link 127.0.0.1',
  args: ['--ignore-certificate-errors'],
})
const results = []
for (const c of CASES) {
  const ctx = await chrome.browser.newContext({ ignoreHTTPSErrors: true })
  const A = `a.${c.parent}`, B = `b.${c.parent}`, AS = `assets.${c.parent}`
  const out = { case: c.name }
  const pa = await ctx.newPage(); await pa.goto(`http://${A}:${P1}/`)
  out.tossCookieSetByA_visibleAtA = await pa.evaluate((p) => { document.cookie = `toss=1; Domain=${p}; Path=/`; return document.cookie }, c.parent)
  await pa.evaluate((p) => { for (let i = 0; i < 10; i++) document.cookie = `bomb${i}=${'x'.repeat(3900)}; Domain=${p}; Path=/` }, c.parent)
  const pb = await ctx.newPage()
  let st; try { const r = await pb.goto(`http://${B}:${P1}/`, { waitUntil: 'domcontentloaded' }); st = r ? r.status() : 'none' } catch (e) { st = 'ERR ' + String(e.message).split('\n')[0] }
  out.siblingNavigationStatusAfter_10x3900B_cookie_bomb = st
  await ctx.clearCookies()
  await pa.evaluate((p) => { document.cookie = `toss2=1; Domain=${p}; Path=/` }, c.parent)
  await pb.goto(`http://${B}:${P1}/`)
  out.cookieSetByA_seenAtSiblingB = await pb.evaluate(() => document.cookie)
  await pa.close(); await pb.close()
  const load = (p, host) => p.evaluate((src) => new Promise((res) => { const s = document.createElement('script'); s.src = src; s.onload = () => res('ok'); s.onerror = () => res('err'); document.body.appendChild(s) }), `http://${host}:${P1}/shared.js`)
  const pa2 = await ctx.newPage(); await pa2.goto(`http://${A}:${P1}/`); await load(pa2, AS); await pa2.close()
  const pb2 = await ctx.newPage(); await pb2.goto(`http://${B}:${P1}/`); await load(pb2, AS); await pb2.close()
  out.serverHitsForSameSharedScript_after_A_then_B = hits.filter(h => h.scheme === 'http' && h.host === AS && h.path === '/shared.js').length
  const pa3 = await ctx.newPage(); await pa3.goto(`https://${A}:${P2}/`)
  out.secFetchSite_A_to_B = await pa3.evaluate(async (u) => (await (await fetch(u)).json()).sfs, `https://${B}:${P2}/echo`)
  await pa3.evaluate(() => localStorage.setItem('k', 'from-A'))
  const pb3 = await ctx.newPage(); await pb3.goto(`https://${B}:${P2}/`)
  out.localStorageSetByA_seenAtB = await pb3.evaluate(() => localStorage.getItem('k'))
  results.push(out)
  await ctx.close()
}
console.log(JSON.stringify({ browser: chrome.browser.version(), when: new Date().toISOString(), results }, null, 2))
await chrome.close(); hs.close(); ss.close(); fs.rmSync(tmp, { recursive: true, force: true })
