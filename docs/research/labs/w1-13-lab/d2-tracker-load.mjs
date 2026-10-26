// w1-13 D2: local load test of the stock bittorrent-tracker WS server (Node 24, loopback, one process). Indicative only (M3 Air, shared with other work).
// Phase A: memory per idle WebSocket (peer in a swarm). Phase B: announce throughput/latency at fixed offered rates with 5 offers each.
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { fileURLToPath } from 'node:url'
const here = fileURLToPath(new URL('.', import.meta.url))
const levels = (process.argv[2] ?? '1000,5000,10000,15000').split(',').map(Number)
const rates = (process.argv[3] ?? '200,1000,3000').split(',').map(Number)
const child = spawn(process.execPath, [here + 'd2-tracker-proc.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
let port = null; let last = null; const samples = []
child.stdout.setEncoding('utf8')
let buf = ''
child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(line); if (o.port) port = o.port; else { last = o; samples.push(o) } } catch {} } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
while (!port) await sleep(50)
await sleep(1500); const baseline = last
const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:' + 'p'.repeat(24) + '\r\na=fingerprint:sha-256 ' + 'AA:'.repeat(31) + 'AA\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\na=candidate:1 1 udp 2113937151 192.168.1.2 50000 typ host generation 0\r\na=candidate:2 1 udp 1677729535 203.0.113.9 50000 typ srflx raddr 192.168.1.2 rport 50000 generation 0\r\n'
const pad20 = (p, i) => p + String(i).padStart(19, '0')
const clients = []; const swarmOf = i => i % Math.max(1, Math.floor(levels[levels.length - 1] / 100))
let rtts = []; let offersRecv = 0; const sentAt = new Map()
function mkOffers (i, n) { return Array.from({ length: 5 }, (_, k) => ({ offer_id: pad20('o', (n * 5 + k) % 1e9), offer: { type: 'offer', sdp: SDP } })) }
function send (i, event, n) { const c = clients[i]; sentAt.set(i, performance.now()); c.ws.send(JSON.stringify({ action: 'announce', info_hash: pad20('h', swarmOf(i)), peer_id: pad20('p', i), event, numwant: 5, left: 100, uploaded: 0, downloaded: 0, offers: mkOffers(i, n) })) }
async function growTo (n) {
  while (clients.length < n) {
    const batch = Math.min(250, n - clients.length)
    await Promise.all(Array.from({ length: batch }, () => new Promise((resolve, reject) => {
      const i = clients.length
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      clients.push({ ws })
      ws.on('open', () => { send(i, 'started', i); resolve() })
      ws.on('error', reject)
      ws.on('message', m => { const s = m.toString(); if (s.includes('"offer"')) { offersRecv++ } else if (s.includes('"interval"')) { const t0 = sentAt.get(i); if (t0 !== undefined) { rtts.push(performance.now() - t0); sentAt.delete(i) } } })
    })))
    await sleep(30)
  }
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) }
const results = []
for (const n of levels) {
  const t0 = performance.now(); await growTo(n); const connectS = (performance.now() - t0) / 1000
  await sleep(4000)
  const idle = samples.slice(-3)
  const rec = { connections: n, connectSeconds: +connectS.toFixed(1), rssMB: +(last.rss / 1048576).toFixed(0), heapUsedMB: +(last.heapUsed / 1048576).toFixed(0), externalMB: +(last.external / 1048576).toFixed(0), kbPerConnectionAllIn: +(((last.rss - baseline.rss) / 1024) / n).toFixed(1), swarms: last.swarms, idleCpuMsPerSecond: Math.round(idle.reduce((s, x) => s + x.cpuMs, 0) / idle.length), throughput: [] }
  if (n === levels[levels.length - 1] || n === 10000) {
    for (const rate of rates) {
      rtts = []; offersRecv = 0; const dur = 8000; const startIdx = Math.floor(Math.random() * n)
      const s0 = samples.length; const t1 = performance.now(); let sent = 0
      while (performance.now() - t1 < dur) {
        const batchStart = performance.now()
        const k = Math.max(1, Math.round(rate / 20))
        for (let j = 0; j < k; j++) { send((startIdx + sent) % n, 'update', sent + 1e6); sent++ }
        const wait = 50 - (performance.now() - batchStart); if (wait > 0) await sleep(wait)
      }
      await sleep(1500)
      const win = samples.slice(s0, s0 + 8)
      rec.throughput.push({ offeredAnnouncesPerSec: rate, achievedAnnouncesPerSec: Math.round(sent / (dur / 1000)), serverCpuPct: +(100 * win.reduce((s, x) => s + x.cpuMs, 0) / (win.length * 1000)).toFixed(0), rttMsP50: pct(rtts, 0.5), rttMsP95: pct(rtts, 0.95), rttMsP99: pct(rtts, 0.99), offersForwardedToClientsPerSec: Math.round(offersRecv / (dur / 1000 + 1.5)), repliesReceivedPct: +(100 * rtts.length / sent).toFixed(1) })
    }
  }
  results.push(rec); console.error('level done', n, JSON.stringify(rec).slice(0, 220))
}
for (const c of clients) { try { c.ws.terminate() } catch {} }
child.kill('SIGTERM')
console.log(JSON.stringify({ node: process.version, baselineRssMB: +(baseline.rss / 1048576).toFixed(0), levels: results }, null, 1))
process.exit(0)
