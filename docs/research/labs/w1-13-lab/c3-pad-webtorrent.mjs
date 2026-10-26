// w1-13 C3: how does WebTorrent 3.0.21 (Node) treat a BEP 47 padded torrent? (a) what torrent.files contains, (b) web-seed behaviour when the host
// serves vs. does not serve the .pad/<n> files.
import net from 'node:net'
import http from 'node:http'
const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...a) { const cb = typeof a[a.length - 1] === 'function' ? a.pop() : undefined; if (typeof a[0] === 'number' || a[0] === undefined) a = [a[0] ?? 0, '127.0.0.1']; return origListen.apply(this, cb ? [...a, cb] : a) }
const { default: WebTorrent } = await import('webtorrent')
const { default: createTorrent } = await import('create-torrent')
const { default: parseTorrent } = await import('parse-torrent')
const { default: bencode } = await import('bencode')
const { prng } = await import('./lib.mjs')
const ct = (i, o) => new Promise((res, rej) => createTorrent(i, o, (e, t) => e ? rej(e) : res(t)))

const PL = 16384
const spec = [['a.txt', prng(20000, 1)], ['b.txt', prng(5000, 2)], ['c.bin', prng(40000, 3)]]
const input = []; let off = 0
spec.forEach(([p, u], i) => {
  const f = u.slice(); f.name = p; f.fullPath = 'site/' + p; input.push(f); off += u.length
  if (i < spec.length - 1 && off % PL) { const n = PL - (off % PL); const z = new Uint8Array(n); z.name = String(n); z.fullPath = `site/.pad/${n}`; input.push(z); off += n }
})
let torrent = await ct(input, { name: 'site', pieceLength: PL, announce: [], creationDate: new Date(1700000000000) })
const d = bencode.decode(torrent)
for (const e of d.info.files) if (Buffer.from(e.path[0]).toString() === '.pad') e.attr = Buffer.from('p')
torrent = Buffer.from(bencode.encode(d))
const parsed = await parseTorrent(torrent)
const out = { parsedFiles: parsed.files.map(f => ({ path: f.path, length: f.length, offset: f.offset })), infoHash: parsed.infoHash, padAttrInInfoDict: d.info.files.filter(e => e.attr).length }

const files = new Map(spec.map(([p, u]) => ['site/' + p, u]))
for (const p of parsed.files) if (p.path.includes('/.pad/')) files.set(p.path, new Uint8Array(p.length)) // zeros
async function run (label, servePads, torrentBytes = torrent) {
  const log = []
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.slice('/ws/'.length))
    const body = files.get(rel)
    log.push(`${req.method} ${rel} ${req.headers.range ?? ''} -> ${(!body || (!servePads && rel.includes('/.pad/'))) ? 404 : 206}`)
    if (!body || (!servePads && rel.includes('/.pad/'))) { res.writeHead(404); return res.end('nf') }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? ''); const a = m ? +m[1] : 0; const b = Math.min(m ? +m[2] : body.length - 1, body.length - 1) // RFC 9110: clamp last-byte-pos (WebTorrent's webconn can ask past EOF of a file)
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' }); res.end(Buffer.from(body.subarray(a, b + 1)))
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const client = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, tracker: false })
  client.on('error', e => log.push('client error ' + e.message))
  const t = client.add(torrentBytes, { urlList: [`http://127.0.0.1:${srv.address().port}/ws`], path: '/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/wt-pad-' + label })
  const filesSeen = await new Promise(r => t.once('ready', () => r(t.files.map(f => ({ name: f.name, path: f.path, length: f.length })))))
  const t0 = Date.now(); let done = false; t.on('done', () => { done = true })
  while (!done && Date.now() - t0 < 12000) await new Promise(r => setTimeout(r, 100))
  const rec = { label, done, ms: Date.now() - t0, progress: +t.progress.toFixed(3), requests: log.length, sample404s: log.filter(l => l.endsWith('404')).slice(0, 4), fullLog: log.slice(0, 40), filesSeen: label === 'host serves pads' ? filesSeen : undefined }
  await new Promise(r => client.destroy(r)); srv.close()
  return rec
}
const plain = await ct(spec.map(([p, u]) => { const f = u.slice(); f.name = p; f.fullPath = 'site/' + p; return f }), { name: 'site', pieceLength: PL, announce: [], creationDate: new Date(1700000000000) })
for (const [p, u] of spec) files.set('site/' + p, u)
out.runs = [await run('control: unpadded torrent', true, plain), await run('host serves pads', true), await run('host 404s pads', false)]
console.log(JSON.stringify(out, null, 1)); process.exit(0)
