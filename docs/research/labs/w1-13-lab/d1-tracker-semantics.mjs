// w1-13 D1: bittorrent-tracker 11.2.3 SERVER behaviour for WebSocket (WebTorrent) announces: interval, offers/numwant, caps, filter(), scrape,
// maxPayload, /stats, and in-process TLS (wss) without a reverse proxy. Raw `ws` clients, no WebRTC.
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import Server from 'bittorrent-tracker/server'
import bencode from 'bencode'
const here = fileURLToPath(new URL('.', import.meta.url))
const out = {}
const id20 = (p, i) => p + String(i).padStart(19, '0')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const offerObj = i => ({ offer_id: id20('o', i), offer: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'.padEnd(600, 'x') } })

async function mkServer (opts = {}) {
  const s = new Server({ udp: false, http: true, ws: true, stats: true, ...opts })
  s.on('warning', () => {}); s.on('error', e => console.error('server error', e.message))
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  return { s, port: s.http.address().port }
}
function client (port, { tls = false, ca } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${tls ? 'wss' : 'ws'}://localhost:${port}`, tls ? { ca } : undefined)
    ws.msgs = []; ws.on('message', m => { try { ws.msgs.push(JSON.parse(m.toString())) } catch { ws.msgs.push({ raw: String(m).slice(0, 50) }) } })
    ws.on('open', () => resolve(ws)); ws.on('error', reject); ws.on('close', c => { ws.closeCode = c })
  })
}
const announce = (ws, ih, pid, offers = [], extra = {}) => ws.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pid, event: 'started', numwant: offers.length, left: 100, uploaded: 0, downloaded: 0, offers, ...extra }))

// ---- T1: interval told to clients + offers/numwant semantics ----
{
  const { s, port } = await mkServer({ interval: 600000 })
  const ih = id20('h', 1)
  const peers = []
  for (let i = 0; i < 5; i++) { const c = await client(port); announce(c, ih, id20('p', i)); peers.push(c); await sleep(10) }
  await sleep(100)
  const sender = await client(port)
  announce(sender, ih, id20('p', 99), Array.from({ length: 10 }, (_, i) => offerObj(i)), { numwant: 3 })
  await sleep(300)
  const got = peers.map(p => p.msgs.filter(m => m.offer).length)
  const reply = sender.msgs.find(m => m.action === 'announce' && m.interval)
  out.T1 = { intervalMs: 600000, wsIntervalToldToClient: reply?.interval, completeIncomplete: [reply?.complete, reply?.incomplete], otherPeersInSwarm: 5, offersSent: 10, numwantClaimed: 3, offersDeliveredPerOtherPeer: got, totalDelivered: got.reduce((a, b) => a + b, 0), note: 'numwant is ignored; delivered = min(offers, other peers); extra offers dropped silently' }
  // answer relay + not validated against offers
  peers[0].send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: id20('p', 0), to_peer_id: id20('p', 99), offer_id: 'made-up-offer-id!!!', answer: { type: 'answer', sdp: 'x' } }))
  await sleep(150)
  out.T1.answerRelayedWithUnknownOfferId = sender.msgs.some(m => m.answer && m.offer_id === 'made-up-offer-id!!!')
  for (const c of [...peers, sender]) c.close()
  // HTTP interval
  const r = await fetch(`http://127.0.0.1:${port}/announce?info_hash=${encodeURIComponent('hhhhhhhhhhhhhhhhhhhh')}&peer_id=${encodeURIComponent('pppppppppppppppppppp')}&port=6881&uploaded=0&downloaded=0&left=0&compact=1&event=started`)
  const dec = bencode.decode(new Uint8Array(await r.arrayBuffer()))
  out.T1.httpAnnounceInterval = Number(dec.interval)
  await new Promise(r => s.close(r))
}
// ---- T2: MAX_ANNOUNCE_PEERS cap (82) ----
{
  const { s, port } = await mkServer()
  const ih = id20('h', 2); const cs = []
  for (let i = 0; i < 120; i++) { const c = await client(port); announce(c, ih, id20('q', i)); cs.push(c); if (i % 20 === 19) await sleep(20) }
  await sleep(200)
  const sender = await client(port)
  announce(sender, ih, id20('q', 999), Array.from({ length: 120 }, (_, i) => offerObj(i)), { numwant: 120 })
  await sleep(600)
  out.T2 = { peersInSwarm: 120, offersSent: 120, offersDelivered: cs.reduce((a, c) => a + c.msgs.filter(m => m.offer).length, 0) }
  for (const c of [...cs, sender]) c.close()
  await new Promise(r => s.close(r))
}
// ---- T3: filter() allow-list + scrape + stats ----
{
  const allowed = id20('a', 1), denied = id20('d', 1)
  const hex = s => Buffer.from(s, 'latin1').toString('hex')
  const { s, port } = await mkServer({ filter: (infoHash, params, cb) => (infoHash === hex(allowed) ? cb(null) : cb(new Error('infohash not allowed'))) })
  const c = await client(port)
  announce(c, allowed, id20('p', 1)); announce(c, denied, id20('p', 1))
  await sleep(200)
  c.send(JSON.stringify({ action: 'scrape', info_hash: [allowed, denied] })); await sleep(100)
  const scrapeSpecific = c.msgs.filter(m => m.action === 'scrape').pop()
  c.send(JSON.stringify({ action: 'scrape' })); await sleep(100)
  const scrapeAll = c.msgs.filter(m => m.action === 'scrape').pop()
  out.T3 = { announceAllowedReply: !!c.msgs.find(m => m.action === 'announce' && m.interval && !m['failure reason']), announceDeniedReply: c.msgs.find(m => m['failure reason'])?.['failure reason'], scrapeKeys: Object.keys(scrapeSpecific?.files ?? {}).length, scrapeNoInfoHashReturnsAllSwarmsCount: Object.keys(scrapeAll?.files ?? {}).length, torrentsKnownToServer: Object.keys(s.torrents).length }
  const st = await (await fetch(`http://127.0.0.1:${port}/stats.json`)).json()
  out.T3.statsJson = st
  const stHtml = await (await fetch(`http://127.0.0.1:${port}/stats`)).text()
  out.T3.statsHtmlStartsWith = stHtml.slice(0, 60)
  out.T3.randomPathStatus = (await fetch(`http://127.0.0.1:${port}/nope`)).status
  c.close(); await new Promise(r => s.close(r))
}
// ---- T4: ws maxPayload default vs configured ----
for (const [label, wsOpts] of [['default ws options', {}], ['ws: { maxPayload: 65536 }', { maxPayload: 65536 }]]) {
  const { s, port } = await mkServer({ ws: wsOpts })
  const c = await client(port)
  const big = JSON.stringify({ action: 'announce', info_hash: id20('h', 4), peer_id: id20('p', 4), event: 'started', left: 1, offers: [], pad: 'x'.repeat(1_000_000) })
  c.send(big); await sleep(400)
  out['T4 ' + label] = { sent: big.length, socketStillOpen: c.readyState === WebSocket.OPEN, closeCode: c.closeCode ?? null, gotReply: c.msgs.length }
  c.terminate(); await new Promise(r => s.close(r))
}
// ---- T5: in-process TLS (wss) with ws:{noServer:true} + https.createServer ----
{
  const s = new Server({ udp: false, http: false, ws: { noServer: true }, stats: false })
  s.on('warning', () => {})
  const httpsServer = https.createServer({ key: readFileSync(here + 'tls/key.pem'), cert: readFileSync(here + 'tls/cert.pem') }, (req, res) => { res.statusCode = 404; res.end('404') })
  httpsServer.on('upgrade', (req, socket, head) => s.ws.handleUpgrade(req, socket, head, ws => s.ws.emit('connection', ws, req)))
  await new Promise(r => httpsServer.listen(0, '127.0.0.1', r))
  const port = httpsServer.address().port
  const ca = readFileSync(here + 'tls/cert.pem')
  const c = await client(port, { tls: true, ca })
  announce(c, id20('h', 5), id20('p', 5)); await sleep(200)
  out.T5 = { wssWorks: c.msgs.some(m => m.action === 'announce' && m.interval), reply: c.msgs[0] && { interval: c.msgs[0].interval, complete: c.msgs[0].complete, incomplete: c.msgs[0].incomplete } }
  // without trusting the cert
  out.T5.untrustedCertRejected = await new Promise(r => { const w = new WebSocket(`wss://localhost:${port}`); w.on('open', () => { w.close(); r(false) }); w.on('error', e => r(e.code || e.message)) })
  c.close(); httpsServer.close(); s.close()
}
// ---- T6: per-swarm LRU: 1000 peers max per infohash ----
{
  const { s, port } = await mkServer()
  const ih = id20('h', 6); const cs = []
  for (let i = 0; i < 1100; i++) { const c = await client(port); announce(c, ih, id20('r', i)); cs.push(c); if (i % 100 === 99) await sleep(50) }
  await sleep(500)
  const sw = s.torrents[Buffer.from(ih, 'latin1').toString('hex')]
  out.T6 = { connected: cs.length, peersKeptInSwarm: sw.peers.keys.length, completeIncomplete: [sw.complete, sw.incomplete], peersCacheLengthDefault: s.peersCacheLength ?? 'undefined => 1000 inside Swarm', peersCacheTtl: s.peersCacheTtl ?? 'undefined => 20 min' }
  for (const c of cs) c.terminate(); await new Promise(r => s.close(r))
}
console.log(JSON.stringify(out, null, 1)); process.exit(0)
