// Same script runs under Node 24 and Deno 2.9.7: determinism of create-torrent, magnet parsing, tracker server+ws client, WebTorrent client lifecycle.
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import Server from 'bittorrent-tracker/server'
import WebSocket from 'ws'
const rt = typeof Deno !== 'undefined' ? `Deno ${Deno.version.deno} (reports node ${process.version})` : `Node ${process.version}`
const out = { runtime: rt }
const ct = (i, o) => new Promise((res, rej) => createTorrent(i, o, (e, t) => e ? rej(e) : res(t)))
let x = 7; const rnd = n => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255 } return b }
const files = [['site/a.html', rnd(30000)], ['site/b.js', rnd(70000)], ['site/c/d.bin', rnd(1234)]].map(([p, u]) => { u.name = p.split('/').pop(); u.fullPath = p; return u })
const t = await ct(files, { name: 'site', pieceLength: 16384, announce: [], creationDate: new Date(1700000000000) })
const p = await parseTorrent(t)
out.createTorrent = { infoHash: p.infoHash, torrentBytes: t.length }
// tracker
try {
  const s = new Server({ udp: false, http: false, ws: true, stats: false })
  s.on('warning', () => {})
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const port = s.http.address().port
  const reply = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => ws.send(JSON.stringify({ action: 'announce', info_hash: 'h'.repeat(20), peer_id: 'p'.repeat(20), event: 'started', left: 1, numwant: 0, offers: [] })))
    ws.on('message', m => { resolve(JSON.parse(m.toString())); ws.close() }); ws.on('error', reject); setTimeout(() => reject(new Error('timeout')), 4000)
  })
  out.trackerWs = { interval: reply.interval, incomplete: reply.incomplete }
  s.close()
} catch (e) { out.trackerWs = { error: String(e.message || e) } }
// webtorrent client
try {
  const { default: WebTorrent } = await import('webtorrent')
  const c = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, tracker: false })
  c.on('error', e => { out.clientError = String(e.message || e) })
  const tor = await new Promise((resolve, reject) => { const tt = c.seed(files, { name: 'site', pieceLength: 16384, announce: [] }, resolve); tt.on('error', reject) })
  out.webtorrentSeed = { infoHash: tor.infoHash, sameAsCreateTorrent: tor.infoHash === p.infoHash, files: tor.files.length }
  await new Promise(r => c.destroy(r))
} catch (e) { out.webtorrentSeed = { error: String(e && e.message || e).split('\n')[0] } }
// WebRTC via node-datachannel polyfill
try {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill')
  const wait = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res()) })
  const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
  const dc = a.createDataChannel('x'); let echoed = null
  b.ondatachannel = e => { e.channel.onmessage = m => e.channel.send('echo:' + m.data) }
  dc.onopen = () => dc.send('ping'); dc.onmessage = e => { echoed = e.data }
  await a.setLocalDescription(await a.createOffer()); await wait(a)
  await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await wait(b)
  await a.setRemoteDescription(b.localDescription)
  const t0 = Date.now(); while (!echoed && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 100))
  out.nodeDatachannel = { echoed, ms: echoed ? Date.now() - t0 : null }
  a.close(); b.close()
} catch (e) { out.nodeDatachannel = { error: String(e && e.message || e).split('\n')[0] } }
console.log(JSON.stringify(out, null, 1)); (typeof Deno !== 'undefined' ? Deno.exit(0) : process.exit(0))
