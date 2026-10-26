// Browser run of HardenedWebConn (separate bundle) next to the REAL webtorrent.min.js, client webSeeds:false, NO fetch wrapper.
// usage: node webseed-matrix-hardened.mjs <torrentdir> <hardened.browser.js> <results.json>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'
const require = createRequire('$HOME/Documents/Projects/magnet-web/package.json'); const { chromium } = require('playwright')
const [outdir, hardenedJs, resultsFile] = process.argv.slice(2)
const WT = '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/dist/webtorrent.min.js'
const H = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553', TX = 'nBOEA5n1P9qCVyJL2QD7DWMzCzpMUikE8Ee2-Ev8IqQ', SB = 'tqjyia4z6u75vasxejf5sah3bvrtgcz2jrjcsbhqi63pqs74eksa', CID = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'
const SHA = { 'bitcoin.pdf': H, 'arweave.png': 'ba85c4fa3f162f09fa6ecc53722f23bc1633b70922a0e3b74952283d897c26d2', 'gwcheck.txt': '7530010a7ec61daef2e028720f102a75d40af932528e742eb10cdae4de8d7004' }
const u = { hz: `https://cdn.hzrd149.com/${H}`, nd: `https://nostr.download/${H}`, sat: `https://cdn.satellite.earth/${H}`, primal: `https://blossom.primal.net/${H}`, ard: `https://ardrive.net/${TX}`, ardsb: `https://${SB}.ardrive.net/${TX}`, vil: `https://vilenarios.com/${TX}`, arw: `https://arweave.net/${TX}`, arwsb: `https://${SB}.arweave.net/${TX}`, fb: `https://ipfs.filebase.io/ipfs/${CID}`, orb: `https://ipfs.orbitor.dev/ipfs/${CID}`, pin: `https://gateway.pinata.cloud/ipfs/${CID}`, storry: `https://${CID}.ipfs.storry.tv/` }
const entries = [
  ['bitcoin.pdf', 'blossom cdn.hzrd149.com alone', [u.hz]], ['bitcoin.pdf', 'blossom nostr.download alone', [u.nd]], ['bitcoin.pdf', 'blossom cdn.satellite.earth alone', [u.sat]],
  ['bitcoin.pdf', 'blossom primal.net alone (ignores Range)', [u.primal]], ['bitcoin.pdf', 'primal.net + cdn.hzrd149.com', [u.primal, u.hz]],
  ['arweave.png', 'ardrive.net apex alone', [u.ard]], ['arweave.png', 'vilenarios.com alone', [u.vil]], ['arweave.png', 'arweave.net apex alone (ignores Range)', [u.arw]], ['arweave.png', 'arweave.net sandbox alone', [u.arwsb]],
  ['arweave.png', 'arweave.net apex + ardrive.net', [u.arw, u.ard]], ['arweave.png', 'arweave.net sandbox + vilenarios.com', [u.arwsb, u.vil]],
  ['gwcheck.txt', 'ipfs.filebase.io alone', [u.fb]], ['gwcheck.txt', 'ipfs.orbitor.dev alone', [u.orb]], ['gwcheck.txt', 'gateway.pinata.cloud alone', [u.pin]], ['gwcheck.txt', 'ipfs.storry.tv subdomain alone', [u.storry]]
]
const html = `<!doctype html><meta charset=utf-8><script type="module">
const q = new URLSearchParams(location.search)
const { default: WebTorrent } = await import('/webtorrent.min.js'); const { HardenedWebConn } = await import('/hardened.js')
const urls = q.get('ws').split(','), name = q.get('t'), want = q.get('sha'), timeout = +q.get('timeout') || 20000
const buf = new Uint8Array(await (await fetch('/t/' + name + '.torrent')).arrayBuffer())
const client = new WebTorrent({ tracker: false, webSeeds: false }); const events = []
const t = client.add(buf, { announce: [] })
t.once('ready', () => { for (const url of urls) t.addWebSeed(new HardenedWebConn(url, t, { baseDelay: 1000, onEvent: e => events.push(e) })) })
const t0 = performance.now(); const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), timeout) })
let shaOk = null; if (done) { const d = await crypto.subtle.digest('SHA-256', await t.files[0].arrayBuffer()); shaOk = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') === want }
window.__result = { done, ms: Math.round(performance.now() - t0), downloaded: t.downloaded, shaOk, dropped: events.filter(e => e.type === 'dropped').map(e => new URL(e.url).hostname), failReasons: [...new Set(events.filter(e => e.type === 'fail').map(e => e.reason))].slice(0, 3), nFail: events.filter(e => e.type === 'fail').length }
client.destroy()
</script>`
const server = http.createServer((req, res) => { const p = new URL(req.url, 'http://x').pathname
  if (p === '/') { res.setHeader('content-type', 'text/html'); return res.end(html) }
  if (p === '/webtorrent.min.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(WT)) }
  if (p === '/hardened.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(hardenedJs)) }
  if (p.startsWith('/t/')) { res.setHeader('content-type', 'application/x-bittorrent'); return res.end(fs.readFileSync(path.join(outdir, p.slice(3)))) }
  res.statusCode = 404; res.end('nf') }).listen(8138, '127.0.0.1')
const browser = await chromium.launch(); const results = []
async function run ([t, label, urls]) {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const cons = []
  page.on('console', m => { const x = m.text(); if (/CORS|blocked|Access to fetch/.test(x)) cons.push(x.slice(0, 160)) })
  page.on('pageerror', e => cons.push('pageerror ' + String(e).slice(0, 160)))
  await page.goto('http://127.0.0.1:8138/?' + new URLSearchParams({ t, ws: urls.join(','), sha: SHA[t], timeout: '20000' }))
  let r; try { await page.waitForFunction(() => window.__result, null, { timeout: 45000 }); r = await page.evaluate(() => window.__result) } catch (e) { r = { error: String(e).slice(0, 100) } }
  await ctx.close(); const out = { label, ...r, cors: cons[0] || null }; results.push(out); console.log(JSON.stringify(out)) }
let i = 0; await Promise.all(Array.from({ length: 4 }, async () => { while (i < entries.length) await run(entries[i++]) }))
fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1)); await browser.close(); server.close()
