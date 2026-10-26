// w1-13 C4: BEP 47 padded torrent + web seed host that does NOT contain the .pad/<n> files (typical static host), per bundle and engine.
// Usage: node c4-pad-bundle.mjs <engine> <bundle.js> [<bundle.js> ...]
import { chromium, webkit } from 'playwright'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import bencode from 'bencode'
import { startOrigin, startPageServer, closeServer, prng, WT_MIN } from './lib.mjs'
const [engine, ...bundleArgs] = process.argv.slice(2)
const bundles = bundleArgs.length ? bundleArgs : [WT_MIN]
const ct = (i, o) => new Promise((res, rej) => createTorrent(i, o, (e, t) => e ? rej(e) : res(t)))
const PL = 16384
const spec = [['a.html', prng(9000, 1)], ['b.js', prng(30000, 2)], ['c.css', prng(5000, 3)], ['d.bin', prng(70000, 4)], ['e.txt', prng(300, 5)]]
const input = []; let off = 0
spec.forEach(([p, u], i) => { const f = u.slice(); f.name = p; f.fullPath = 'site/' + p; input.push(f); off += u.length; if (i < spec.length - 1 && off % PL) { const n = PL - (off % PL); const z = new Uint8Array(n); z.name = String(n); z.fullPath = `site/.pad/${n}`; input.push(z); off += n } })
let tb = await ct(input, { name: 'site', pieceLength: PL, announce: [], creationDate: new Date(1700000000000) })
const d = bencode.decode(tb); for (const e of d.info.files) if (Buffer.from(e.path[0]).toString() === '.pad') e.attr = Buffer.from('p'); tb = Buffer.from(bencode.encode(d))
const parsed = await parseTorrent(tb)
const files = new Map(spec.map(([p, u]) => ['site/' + p, u])) // NO pad files on the host
const log = []
const B = await startOrigin({ site: { files, torrentBytes: tb }, log })
const pageHtml = `<!doctype html><meta charset="utf-8"><script type="module">
import WebTorrent from '/wt.js'
class MemStore { constructor (cl, o) { this.chunkLength = cl; this.length = o.length; this.m = new Map() }
  put (i, b, cb = () => {}) { this.m.set(i, new Uint8Array(b)); queueMicrotask(() => cb(null)) }
  get (i, o, cb) { if (typeof o === 'function') { cb = o; o = {} } const c = this.m.get(i); if (!c) return queueMicrotask(() => cb(new Error('nf'))); const off = (o && o.offset) || 0; const len = (o && o.length != null) ? o.length : c.length - off; queueMicrotask(() => cb(null, c.slice(off, off + len))) }
  close (cb = () => {}) { queueMicrotask(() => cb(null)) } destroy (cb = () => {}) { this.m.clear(); queueMicrotask(() => cb(null)) } }
const sha256 = async u8 => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(b => b.toString(16).padStart(2, '0')).join('')
window.run = async ({ torrentBytes, ws, timeoutMs }) => {
  const rec = { warnings: [], errors: [], filesSeen: 0 }
  const c = new WebTorrent({ tracker: false, dht: false, lsd: false })
  const t = c.add(new Uint8Array(torrentBytes), { store: MemStore, urlList: [ws] })
  t.on('warning', e => rec.warnings.push(String(e.message || e).slice(0, 80))); t.on('error', e => rec.errors.push(String(e.message || e).slice(0, 80)))
  t.on('metadata', () => { rec.filesSeen = t.files.length })
  const t0 = performance.now()
  await new Promise(r => { const tm = setTimeout(r, timeoutMs); t.on('done', () => { rec.doneMs = Math.round(performance.now() - t0); clearTimeout(tm); r() }) })
  rec.done = !!rec.doneMs; rec.progress = +t.progress.toFixed(3)
  if (rec.done) { const f = t.files.find(x => x.path === 'site/d.bin'); rec.sha = await sha256(new Uint8Array(await f.arrayBuffer())) }
  await new Promise(r => c.destroy(r)); return rec
}
window.__ready = true</script>`
const sha256hex = async u8 => Buffer.from(await crypto.subtle.digest('SHA-256', u8)).toString('hex')
const expected = await sha256hex(spec[3][1])
const results = []
for (const bundlePath of bundles) {
  const A = await startPageServer({ pageHtml, bundlePath })
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true })
  const rec = { bundle: bundlePath.replace(/^.*\/(dist|out)\//, '$1/'), engine, version: browser.version() }
  const before = log.length
  try {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    await page.goto(A.origin + '/'); await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 })
    const run = `r${Math.random().toString(36).slice(2, 8)}`
    Object.assign(rec, await page.evaluate(c => window.run(c), { torrentBytes: [...tb], ws: `${B.origin}/m/acao/${run}/ws`, timeoutMs: 10000 }))
    rec.shaMatches = rec.sha === expected
    rec.hostSawPadRequests = log.slice(before).filter(r => r.path.includes('/.pad/')).length
    rec.host404s = log.slice(before).filter(r => r.status === 404).length
    rec.options = log.slice(before).filter(r => r.method === 'OPTIONS').length
    await ctx.close()
  } catch (e) { rec.fatal = String(e.message).split('\n')[0] }
  await browser.close(); await closeServer(A.server); results.push(rec)
}
await closeServer(B.server)
console.log(JSON.stringify({ torrentFiles: parsed.files.map(f => f.path.replace('site/', '') + ':' + f.length), results }, null, 1)); process.exit(0)
