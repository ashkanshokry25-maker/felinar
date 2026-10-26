// Orchestrator: start a tracker (stock | hardened), ramp N connections over G generator processes, measure server CPU/RSS.
// node bench.mjs --target stock|hardened --conns 8000 --gens 3 --swarm-size 10 --interval-ms 2000 --offers 5 --window-s 30 [--idle 1]
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1] }
const TARGET = arg('target', 'stock'), CONNS = +arg('conns', 4000), GENS = +arg('gens', 3), SWARM = +arg('swarm-size', 10)
const INTERVAL = arg('interval-ms', '2000'), OFFERS = arg('offers', '5'), WINDOW = +arg('window-s', 30), IDLE = arg('idle', '0'), PANS = arg('answer-prob', '0.2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cpuSec = (pid) => { // ps cputime is [dd-]hh:mm:ss.cc or mm:ss.cc
  const t = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)]).toString().trim()
  const parts = t.split(':').map(Number); let s = 0
  for (const p of parts) s = s * 60 + p
  return s
}
const rssMiB = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024
const env = { ...process.env, PORT: '0', METRICS_PORT: '0', OPEN: '1', LOG_LEVEL: 'info', MAX_CONNECTIONS: '100000', MAX_CONN_PER_IP: '100000', CONN_RATE_PER_IP_PER_MIN: '10000000', RATE_BURST: '100000', RATE_PER_SEC: '100000', MAX_SWARMS_PER_SOCKET: '16' }
const script = TARGET === 'stock' ? join(HERE, 'stock-server.mjs') : join(HERE, '..', 'tracker.mjs')
// wait for TIME_WAIT sockets of the previous run to drain (macOS msl 15 s) or we run out of ephemeral ports
for (let i = 0; i < 120; i++) {
  const tw = Number(execFileSync('sh', ['-c', "netstat -an -p tcp | grep -c TIME_WAIT || true"]).toString().trim())
  if (tw < 300) break
  await sleep(1000)
}
const srv = spawn(process.execPath, ['--expose-gc', '--import', join(HERE, 'gchook.mjs'), script], { env, stdio: ['ignore', 'pipe', 'inherit'] })
let lastMem = null
const port = await new Promise((res, rej) => { let b = ''; srv.stdout.on('data', (d) => { b += d; for (const l of b.split('\n')) { try { const j = JSON.parse(l); if (j.msg === 'listening') res(j.port); if (j.msg === 'mem') lastMem = j } catch (_) {} } }); srv.on('exit', () => rej(new Error('server exited'))) })
const baseline = { rss: rssMiB(srv.pid), cpu: cpuSec(srv.pid) }
const per = Math.ceil(CONNS / GENS)
const gens = []
for (let g = 0; g < GENS; g++) {
  const n = Math.min(per, CONNS - g * per)
  if (n <= 0) break
  const p = spawn(process.execPath, [join(HERE, 'loadgen.mjs'), '--url', `ws://127.0.0.1:${port}`, '--conns', String(n), '--offset', String(g * per), '--swarm-size', String(SWARM), '--interval-ms', INTERVAL, '--offers', OFFERS, '--answer-prob', PANS, '--idle', IDLE, '--duration-s', String(120 + WINDOW + CONNS / 400), '--ramp-per-sec', '500'], { stdio: ['ignore', 'pipe', 'inherit'] })
  p.last = null; p.stdout.on('data', (d) => { const ls = String(d).trim().split('\n'); try { p.last = JSON.parse(ls[ls.length - 1]) } catch (_) {} })
  gens.push(p)
}
// wait until all connections are open (or timeout)
const tRamp = Date.now()
while (Date.now() - tRamp < 90000 + CONNS * 5) {
  await sleep(1000)
  const open = gens.reduce((a, p) => a + (p.last ? p.last.open : 0), 0)
  if (open >= CONNS * 0.995) break
}
const open0 = gens.reduce((a, p) => a + (p.last ? p.last.open : 0), 0)
await sleep(5000)
const rssIdleish = rssMiB(srv.pid)
srv.kill('SIGUSR2'); await sleep(1500)
const mem = lastMem
let statsMs = null
if (process.env.STATS_PROBE) {
  statsMs = []
  for (let i = 0; i < 3; i++) { const t = Date.now(); const r = await fetch(`http://127.0.0.1:${port}/stats.json`); const j = await r.json(); statsMs.push({ ms: Date.now() - t, peers: j.peersAll, torrents: j.torrents }) }
}
// measurement window
const c0 = cpuSec(srv.pid), t0 = Date.now()
const s0 = gens.map((p) => p.last)
await sleep(WINDOW * 1000)
const c1 = cpuSec(srv.pid), t1 = Date.now()
const s1 = gens.map((p) => p.last)
const wall = (t1 - t0) / 1000
const recvPerS = gens.reduce((a, p, i) => a + (p.last ? p.last.recvPerS : 0), 0)
const sentPerS = gens.reduce((a, p) => a + (p.last ? p.last.sentPerS : 0), 0)
const res = {
  target: TARGET, conns: CONNS, open: open0, swarmSize: SWARM, intervalMs: +INTERVAL, offersPerAnnounce: +OFFERS, idle: IDLE === '1',
  retainedHeapMiB: mem ? Math.round(mem.heapUsed / 1048576 * 10) / 10 : null, retainedRssAfterGcMiB: mem ? Math.round(mem.rss / 1048576) : null, externalMiB: mem ? Math.round(mem.external / 1048576 * 10) / 10 : null,
  statsMs,
  loadAvg: execFileSync('sh', ['-c', 'uptime | sed "s/.*load averages*: //"']).toString().trim(),
  serverRssMiB: Math.round(rssMiB(srv.pid)), rssBaselineMiB: Math.round(baseline.rss), kibPerConn: Math.round(((rssMiB(srv.pid) - baseline.rss) * 1024) / Math.max(1, open0) * 10) / 10,
  serverCpuCores: Math.round(((c1 - c0) / wall) * 100) / 100, msgsInPerS: sentPerS, msgsOutPerS: recvPerS,
  cpuMicrosPerIncomingMsg: sentPerS ? Math.round(((c1 - c0) / wall / sentPerS) * 1e6 * 10) / 10 : null,
  loadgenErrors: gens.reduce((a, p) => a + (p.last ? p.last.errors : 0), 0), loadgenClosedUnexpectedly: gens.reduce((a, p) => a + (p.last ? p.last.closed : 0), 0)
}
console.log(JSON.stringify(res))
for (const p of gens) p.kill('SIGKILL')
srv.kill('SIGKILL')
process.exit(0)
