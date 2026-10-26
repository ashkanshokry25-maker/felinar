// Synthetic WebTorrent-tracker load generator. One process = one slice of the connections.
// node loadgen.mjs --url ws://127.0.0.1:P --conns 3000 --offset 0 --swarm-size 10 --interval-ms 2000 --offers 5 --answer-prob 0.2 --duration-s 60
import WebSocket from 'ws'
import { createHash } from 'node:crypto'
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1] }
const URL_ = arg('url'), CONNS = +arg('conns', 1000), OFFSET = +arg('offset', 0), SWARM = +arg('swarm-size', 10)
const INTERVAL = +arg('interval-ms', 2000), OFFERS = +arg('offers', 5), PANS = +arg('answer-prob', 0.2), SDPB = +arg('sdp-bytes', 1500)
const DURATION = +arg('duration-s', 60), RAMP = +arg('ramp-per-sec', 800), NOANN = arg('idle', '0') === '1'
const bin = (buf) => Array.from(buf, (c) => String.fromCharCode(c)).join('')
const ihFor = (s) => bin(createHash('sha1').update('swarm' + s).digest())
const pidFor = (i) => bin(createHash('sha1').update('peer' + i).digest())
const SDP = ('v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' + 'a=candidate:1 1 udp 2113937151 192.0.2.1 54321 typ host generation 0\r\n'.repeat(40)).slice(0, SDPB)
const answerSdp = SDP
let sent = 0, recv = 0, offersRecv = 0, answersRecv = 0, opened = 0, errors = 0, closed = 0
const conns = []
function mk (i) {
  const gi = OFFSET + i, s = Math.floor(gi / SWARM), ih = ihFor(s), pid = pidFor(gi)
  const ihj = JSON.stringify(ih), pidj = JSON.stringify(pid)
  let ctr = 0
  const ws = new WebSocket(URL_, { perMessageDeflate: false, maxPayload: 1 << 20 })
  const announce = (event) => {
    const offers = []
    for (let k = 0; k < OFFERS; k++) offers.push(`{"offer_id":${JSON.stringify(pid.slice(0, 16) + String.fromCharCode((ctr >> 8) & 255, ctr & 255, k, 7))},"offer":{"type":"offer","sdp":${JSON.stringify(SDP)}}}`), ctr++
    ws.send(`{"action":"announce","info_hash":${ihj},"peer_id":${pidj},"uploaded":0,"downloaded":0,"left":1,"event":"${event}","numwant":${OFFERS},"offers":[${offers.join(',')}]}`)
    sent++
  }
  ws.on('open', () => {
    opened++
    announce('started')
    if (!NOANN) {
      const jitter = INTERVAL * (0.8 + Math.random() * 0.4)
      setTimeout(() => { ws._t = setInterval(() => { if (ws.readyState === 1) announce('update') }, INTERVAL) }, Math.random() * INTERVAL)
    }
  })
  ws.on('message', (d) => {
    recv++
    const str = d.toString('utf8')
    if (str.length > 400 && str.includes('"offer":')) {
      offersRecv++
      if (Math.random() < PANS) {
        try {
          const m = JSON.parse(str)
          ws.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pid, to_peer_id: m.peer_id, offer_id: m.offer_id, answer: { type: 'answer', sdp: answerSdp } })); sent++
        } catch (_) { errors++ }
      }
    } else if (str.includes('"answer":')) answersRecv++
  })
  ws.on('error', () => { errors++ })
  ws.on('close', () => { closed++; clearInterval(ws._t) })
  conns.push(ws)
}
let started = 0
const rampTimer = setInterval(() => {
  const n = Math.min(CONNS - started, Math.ceil(RAMP / 20))
  for (let k = 0; k < n; k++) mk(started++)
  if (started >= CONNS) clearInterval(rampTimer)
}, 50)
let last = { sent: 0, recv: 0 }, lastT = Date.now()
const rep = setInterval(() => {
  const now = Date.now(), dt = (now - lastT) / 1000
  console.log(JSON.stringify({ t: Math.round((now - t0) / 1000), open: conns.filter((w) => w.readyState === 1).length, sentPerS: Math.round((sent - last.sent) / dt), recvPerS: Math.round((recv - last.recv) / dt), offersRecv, answersRecv, errors, closed }))
  last = { sent, recv }; lastT = now
}, 5000)
const t0 = Date.now()
setTimeout(() => { for (const w of conns) { clearInterval(w._t); try { w.close() } catch (_) {} } setTimeout(() => process.exit(0), 500) }, DURATION * 1000)
