#!/usr/bin/env node
// tracker.mjs - hardened reference WebSocket (WebTorrent) tracker for magnet-web.
//
// What it is: bittorrent-tracker 11.2.3 (WebSocket part only) behind
//   - strict input validation (the stock server crashes on `offers: [null]`, accepts 100 MiB messages,
//     lets one socket create unlimited swarms and returns every swarm on a scrape without info_hash),
//   - quotas (connections total / per IP / new connections per IP per minute, swarms per socket / total,
//     messages per second per socket, outgoing backlog per socket),
//   - WebSocket ping/pong (dead-peer detection + proxy/CDN idle keepalive), idle close, empty-swarm GC,
//   - an info-hash allow-list (SIGHUP reload) and an Origin allow-list,
//   - Prometheus metrics on a separate loopback port, JSON logs, graceful drain on SIGTERM.
// What it is not: audited, horizontally scalable (one process, all state in memory), or a replacement for
// aquatic_ws / wt-tracker-rust when you need > ~20k sockets per host.
//
// Run:  OPEN=1 node tracker.mjs            (open tracker, quotas only)
//       ALLOW_FILE=allow.txt node tracker.mjs   (only listed 40-hex info hashes)
// Env:  see CFG below. All limits are per process.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import Server from 'bittorrent-tracker/server'
import client from 'prom-client'

// ---------------------------------------------------------------- configuration
const env = process.env
const num = (k, d) => {
  const v = env[k]
  if (v === undefined || v === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number, got "${v}"`)
  return n
}
const flag = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]))
const announceIntervalS = num('ANNOUNCE_INTERVAL_S', 120)
export const CFG = {
  host: env.HOST || '127.0.0.1',
  port: num('PORT', 8000),
  metricsPort: num('METRICS_PORT', 9464), // 0 disables; always bound to 127.0.0.1
  announceIntervalS, // told to clients (response.interval); the library derives it as intervalMs / 5000
  maxPayload: num('MAX_PAYLOAD', 64 * 1024), // bytes per WebSocket message (ws default is 100 MiB)
  maxOffers: num('MAX_OFFERS', 10), // offers accepted per announce (stock browser client sends <= 5)
  maxSdp: num('MAX_SDP', 16 * 1024), // characters per offer/answer SDP
  maxConnections: num('MAX_CONNECTIONS', 20000),
  maxConnPerIp: num('MAX_CONN_PER_IP', 200), // CGNAT / offices share IPs: keep this generous
  connRatePerIpPerMin: num('CONN_RATE_PER_IP_PER_MIN', 120),
  maxSwarmsPerSocket: num('MAX_SWARMS_PER_SOCKET', 16),
  maxSwarmsTotal: num('MAX_SWARMS_TOTAL', 100000),
  rateBurst: num('RATE_BURST', 40), // token bucket per socket
  ratePerSec: num('RATE_PER_SEC', 5),
  bufferLimit: num('BUFFER_LIMIT', 256 * 1024), // bytes queued for one socket before it is cut; worst-case RAM = MAX_CONNECTIONS x this
  pingIntervalS: num('PING_INTERVAL_S', 30), // 0 disables
  idleTimeoutS: num('IDLE_TIMEOUT_S', Math.round(announceIntervalS * 2.75)), // no application message at all; 0 disables
  peersPerSwarm: num('PEERS_PER_SWARM', 1000), // LRU size inside the library
  peerTtlS: num('PEER_TTL_S', 20 * 60),
  gcIntervalS: num('GC_INTERVAL_S', 60),
  allowFile: env.ALLOW_FILE || '', // one 40-hex info hash per line, # comments; SIGHUP reloads
  open: flag('OPEN', false), // must be set explicitly when ALLOW_FILE is empty
  allowOrigins: (env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean), // empty = any
  allowScrape: flag('ALLOW_SCRAPE', false),
  trustProxy: flag('TRUST_PROXY', true), // honour the client-IP header, but only when the TCP peer is loopback ...
  trustAnyProxy: flag('TRUST_ANY_PROXY', false), // ... unless this is set (platforms such as Fly.io where the proxy is the only way in)
  clientIpHeader: (env.CLIENT_IP_HEADER || 'x-forwarded-for').toLowerCase(),
  shutdownSpreadMs: num('SHUTDOWN_SPREAD_MS', 5000), // spread the 1001 closes to avoid a reconnect stampede
  logLevel: env.LOG_LEVEL || 'info'
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const log = (level, msg, extra) => {
  if (LEVELS[level] < LEVELS[CFG.logLevel]) return
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }) + '\n')
}
const noop = () => {}

// ---------------------------------------------------------------- allow-list
let allow = null // Set<string> of lowercase hex, or null (open)
function loadAllow () {
  if (!CFG.allowFile) return
  const next = new Set()
  for (const line of readFileSync(CFG.allowFile, 'utf8').split('\n')) {
    const s = line.replace(/#.*/, '').trim().toLowerCase()
    if (!s) continue
    if (!/^[0-9a-f]{40}$/.test(s)) throw new Error(`bad info hash in ${CFG.allowFile}: "${s}"`)
    next.add(s)
  }
  allow = next
  log('info', 'allow-list loaded', { entries: allow.size })
}
if (!CFG.allowFile && !CFG.open) {
  console.error('refusing to start: set ALLOW_FILE=<file of 40-hex info hashes> or OPEN=1 (open tracker)')
  process.exit(2)
}
loadAllow()

// ---------------------------------------------------------------- metrics
const register = new client.Registry()
client.collectDefaultMetrics({ register, prefix: 'mwt_' })
const m = {
  conns: new client.Gauge({ name: 'mwt_connections', help: 'open WebSocket connections', registers: [register] }),
  opened: new client.Counter({ name: 'mwt_connections_opened_total', help: 'accepted WebSocket upgrades', registers: [register] }),
  closed: new client.Counter({ name: 'mwt_connections_closed_total', help: 'closed WebSockets by reason', labelNames: ['reason'], registers: [register] }),
  refused: new client.Counter({ name: 'mwt_upgrades_refused_total', help: 'refused upgrades by reason', labelNames: ['reason'], registers: [register] }),
  msgs: new client.Counter({ name: 'mwt_messages_total', help: 'valid messages by action', labelNames: ['action'], registers: [register] }),
  rejected: new client.Counter({ name: 'mwt_messages_rejected_total', help: 'rejected messages by reason', labelNames: ['reason'], registers: [register] }),
  offers: new client.Counter({ name: 'mwt_offers_received_total', help: 'offers received in announces', registers: [register] }),
  answers: new client.Counter({ name: 'mwt_answers_received_total', help: 'answers received', registers: [register] }),
  bytesIn: new client.Counter({ name: 'mwt_bytes_received_total', help: 'application bytes received', registers: [register] }),
  warnings: new client.Counter({ name: 'mwt_library_warnings_total', help: 'warnings emitted by bittorrent-tracker', registers: [register] }),
  crashes: new client.Counter({ name: 'mwt_uncaught_exceptions_total', help: 'uncaught exceptions (process exits after logging)', registers: [register] }),
  handle: new client.Histogram({
    name: 'mwt_message_handle_seconds', help: 'synchronous cost of validating + dispatching one message',
    buckets: [0.00002, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.05], registers: [register]
  }),
  swarms: new client.Gauge({
    name: 'mwt_swarms', help: 'swarms held in memory', registers: [register],
    collect () { this.set(Object.keys(server.torrents).length) }
  }),
  peers: new client.Gauge({
    name: 'mwt_peers', help: 'peer entries over all swarms', registers: [register],
    collect () { let n = 0; for (const k in server.torrents) n += server.torrents[k].peers.length; this.set(n) }
  }),
  loopLag: new client.Gauge({
    name: 'mwt_event_loop_lag_p99_seconds', help: 'p99 event-loop delay since last scrape', registers: [register],
    collect () { this.set(loopHist.percentile(99) / 1e9); loopHist.reset() }
  }),
  info: new client.Gauge({ name: 'mwt_build_info', help: 'static info', labelNames: ['tracker', 'node', 'interval_s', 'mode'], registers: [register] })
}
const loopHist = monitorEventLoopDelay({ resolution: 10 })
loopHist.enable()
m.info.set({ tracker: 'bittorrent-tracker@11.2.3', node: process.version, interval_s: String(CFG.announceIntervalS), mode: CFG.allowFile ? 'allowlist' : 'open' }, 1)

// ---------------------------------------------------------------- the library server (WebSocket only, no listener of its own)
const server = new Server({
  http: false, udp: false, stats: false,
  ws: { noServer: true, maxPayload: CFG.maxPayload },
  trustProxy: false, // we do our own client-IP handling (see clientIp)
  interval: CFG.announceIntervalS * 5 * 1000, // WebSocket clients are told interval / 1000 / 5
  peersCacheLength: CFG.peersPerSwarm,
  peersCacheTtl: CFG.peerTtlS * 1000,
  filter: (infoHash, _params, cb) => (allow && !allow.has(infoHash) ? cb(new Error('info_hash not allowed here')) : cb(null))
})
server.on('warning', (err) => { m.warnings.inc(); log('debug', 'library warning', { err: err && err.message }) })
server.on('error', (err) => log('error', 'library error', { err: err && err.message }))

// cap total swarms
const origCreateSwarm = server.createSwarm.bind(server)
server.createSwarm = (infoHash, cb) => {
  if (swarmCountCache >= CFG.maxSwarmsTotal) return process.nextTick(() => cb(new Error('tracker is full')))
  swarmCountCache++
  origCreateSwarm(infoHash, cb)
}
let swarmCountCache = 0

// ---------------------------------------------------------------- helpers
const BIN20 = /^[\x00-\xff]{20}$/
const isBin20 = (s) => typeof s === 'string' && BIN20.test(s)
const hex = (bin) => Buffer.from(bin, 'latin1').toString('hex')
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o)
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const EVENTS = new Set(['started', 'stopped', 'completed', 'update', 'empty', 'paused'])

function clientIp (req) {
  const peer = req.socket.remoteAddress || ''
  if (CFG.trustProxy && (CFG.trustAnyProxy || LOOPBACK.has(peer))) {
    const xff = req.headers[CFG.clientIpHeader]
    if (typeof xff === 'string' && xff) {
      const parts = xff.split(',')
      return parts[parts.length - 1].trim() // the entry our own proxy appended
    }
  }
  return peer.replace(/^::ffff:/, '')
}

function validate (msg) {
  // returns an error string, or null when the message is acceptable
  if (!isObj(msg)) return 'not an object'
  if (msg.action === 'scrape') {
    if (!CFG.allowScrape) return 'scrape is disabled'
    const h = msg.info_hash
    if (!(isBin20(h) || (Array.isArray(h) && h.length > 0 && h.length <= 10 && h.every(isBin20)))) return 'scrape needs 1-10 info_hash values'
    return null
  }
  if (msg.action !== 'announce') return 'invalid action'
  if (!isBin20(msg.info_hash)) return 'invalid info_hash'
  if (!isBin20(msg.peer_id)) return 'invalid peer_id'
  if (msg.event !== undefined && !EVENTS.has(msg.event)) return 'invalid event'
  // `left` is Infinity (serialised as null) while a client still lacks metadata
  if (msg.left !== undefined && msg.left !== null && !(typeof msg.left === 'number' || (typeof msg.left === 'string' && msg.left.length < 20))) return 'invalid left'
  if (msg.offers !== undefined) {
    if (!Array.isArray(msg.offers) || msg.offers.length > CFG.maxOffers) return 'too many offers'
    for (const o of msg.offers) {
      if (!isObj(o) || !isBin20(o.offer_id) || !isObj(o.offer)) return 'invalid offer'
      if (o.offer.type !== 'offer' || typeof o.offer.sdp !== 'string' || o.offer.sdp.length > CFG.maxSdp) return 'invalid offer sdp'
    }
  }
  if (msg.answer !== undefined) {
    if (msg.offers !== undefined && msg.offers.length) return 'offers and answer in one message'
    if (!isObj(msg.answer) || msg.answer.type !== 'answer' || typeof msg.answer.sdp !== 'string' || msg.answer.sdp.length > CFG.maxSdp) return 'invalid answer'
    if (!isBin20(msg.to_peer_id) || !isBin20(msg.offer_id)) return 'answer needs to_peer_id and offer_id'
  }
  return null
}

function refuse (socket, code, text, reason) {
  m.refused.inc({ reason })
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: ${30 + Math.floor(Math.random() * 60)}\r\n\r\n`)
  } catch (_) { /* socket already gone */ }
  socket.destroy()
}

// ---------------------------------------------------------------- connection bookkeeping
const sockets = new Set()
const perIp = new Map() // ip -> { n, tokens, last }
let shuttingDown = false

function ipEntry (ip) {
  let e = perIp.get(ip)
  if (!e) { e = { n: 0, tokens: CFG.connRatePerIpPerMin, last: Date.now() }; perIp.set(ip, e) }
  return e
}
function takeConnToken (e) {
  const now = Date.now()
  e.tokens = Math.min(CFG.connRatePerIpPerMin, e.tokens + ((now - e.last) / 60000) * CFG.connRatePerIpPerMin)
  e.last = now
  if (e.tokens < 1) return false
  e.tokens -= 1
  return true
}

// ---------------------------------------------------------------- message path: validate, rate-limit, dispatch to the library
const libOnWebSocketRequest = server._onWebSocketRequest.bind(server)
server._onWebSocketRequest = (socket, opts, raw) => {
  const st = socket.mw
  if (!st) return
  const t0 = process.hrtime.bigint()
  const now = Date.now()
  st.lastMsg = now
  st.alive = true
  m.bytesIn.inc(raw.length)
  // token bucket
  st.tokens = Math.min(CFG.rateBurst, st.tokens + ((now - st.last) / 1000) * CFG.ratePerSec)
  st.last = now
  if (st.tokens < 1) {
    m.rejected.inc({ reason: 'rate' })
    if (++st.drops > 3 * CFG.rateBurst) { socket.close(1008, 'rate limit'); return }
    reply(socket, 'rate limit')
    return
  }
  st.tokens -= 1
  let msg
  try {
    msg = JSON.parse(raw.toString('utf8'))
  } catch (_) {
    m.rejected.inc({ reason: 'json' })
    reply(socket, 'invalid json')
    return
  }
  const bad = validate(msg)
  if (bad) {
    m.rejected.inc({ reason: bad.replace(/[^a-z]+/gi, '_').slice(0, 40) })
    reply(socket, bad)
    return
  }
  if (msg.action === 'announce') {
    // One peer_id per connection (WebTorrent and Trystero both do this). The library only removes the FIRST
    // peer_id of a socket when it closes, so letting a client vary it would leak ghost peers for 20 minutes.
    if (st.peerId === undefined) st.peerId = msg.peer_id
    else if (st.peerId !== msg.peer_id) {
      m.rejected.inc({ reason: 'peer_id_changed' })
      reply(socket, 'peer_id changed on this connection')
      return
    }
    const ih = hex(msg.info_hash)
    if (!socket.infoHashes.includes(ih) && socket.infoHashes.length >= CFG.maxSwarmsPerSocket) {
      m.rejected.inc({ reason: 'swarms_per_socket' })
      reply(socket, 'too many swarms on this connection')
      return
    }
    if (msg.offers) m.offers.inc(msg.offers.length)
    if (msg.answer) m.answers.inc()
  }
  m.msgs.inc({ action: msg.action })
  try {
    libOnWebSocketRequest(socket, opts, raw)
  } catch (err) {
    m.rejected.inc({ reason: 'library_throw' })
    log('error', 'library threw synchronously', { err: err && err.message })
  }
  m.handle.observe(Number(process.hrtime.bigint() - t0) / 1e9)
}

function reply (socket, text) {
  if (socket.readyState === 1) socket.send(JSON.stringify({ 'failure reason': text }), noop)
}

// ---------------------------------------------------------------- HTTP: upgrade gate, health, nothing else
const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
    res.statusCode = shuttingDown ? 503 : 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: !shuttingDown, connections: sockets.size, uptime_s: Math.round(process.uptime()) }))
    return
  }
  res.statusCode = 404
  res.end('not found\n')
})
httpServer.headersTimeout = 10000
httpServer.requestTimeout = 10000

httpServer.on('upgrade', (req, socket, head) => {
  socket.on('error', noop)
  if (shuttingDown) return refuse(socket, 503, 'Service Unavailable', 'shutting_down')
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket') return refuse(socket, 400, 'Bad Request', 'not_websocket')
  if (CFG.allowOrigins.length && !CFG.allowOrigins.includes(req.headers.origin)) return refuse(socket, 403, 'Forbidden', 'origin')
  if (sockets.size >= CFG.maxConnections) return refuse(socket, 503, 'Service Unavailable', 'full')
  const ip = clientIp(req)
  const e = ipEntry(ip)
  if (e.n >= CFG.maxConnPerIp) return refuse(socket, 429, 'Too Many Requests', 'ip_connections')
  if (!takeConnToken(e)) return refuse(socket, 429, 'Too Many Requests', 'ip_rate')
  req.mwIp = ip
  e.n++
  // release on TCP close: covers failed handshakes as well as normal WebSocket closes
  socket.once('close', () => { if (--e.n <= 0 && e.tokens >= CFG.connRatePerIpPerMin - 1) perIp.delete(ip) })
  server.ws.handleUpgrade(req, socket, head, (ws) => server.ws.emit('connection', ws, req))
})

server.ws.on('connection', (ws, req) => {
  const now = Date.now()
  ws.mw = { ip: req.mwIp, tokens: CFG.rateBurst, last: now, lastMsg: now, alive: true, drops: 0 }
  sockets.add(ws)
  m.conns.set(sockets.size)
  m.opened.inc()
  ws.on('pong', () => { ws.mw.alive = true })
  // never let one slow reader hold unbounded memory: cut it when its backlog passes BUFFER_LIMIT
  const rawSend = ws.send.bind(ws)
  ws.send = (data, cb) => {
    if (ws.bufferedAmount > CFG.bufferLimit) { ws.mw.counted = true; m.closed.inc({ reason: 'backlog' }); ws.terminate(); return }
    rawSend(data, cb)
  }
  let why = 'client'
  ws.once('error', () => { why = 'error' })
  ws.once('close', (code) => {
    sockets.delete(ws)
    m.conns.set(sockets.size)
    if (!ws.mw.counted) m.closed.inc({ reason: why === 'error' ? 'error' : (code === 1001 ? 'going_away' : 'client') })
  })
})

// ---------------------------------------------------------------- housekeeping
const timers = []
if (CFG.pingIntervalS > 0) {
  timers.push(setInterval(() => {
    const now = Date.now()
    for (const ws of sockets) {
      if (!ws.mw.alive) { ws.mw.counted = true; m.closed.inc({ reason: 'ping_timeout' }); ws.terminate(); continue }
      if (CFG.idleTimeoutS > 0 && now - ws.mw.lastMsg > CFG.idleTimeoutS * 1000) { ws.mw.counted = true; m.closed.inc({ reason: 'idle' }); ws.close(1001, 'idle'); continue }
      ws.mw.alive = false
      try { ws.ping() } catch (_) { /* closing */ }
    }
  }, CFG.pingIntervalS * 1000))
}
timers.push(setInterval(() => {
  let removed = 0
  for (const ih in server.torrents) {
    if (server.torrents[ih].peers.length === 0) { delete server.torrents[ih]; removed++ }
  }
  swarmCountCache = Object.keys(server.torrents).length
  if (removed) log('debug', 'swarm gc', { removed, left: swarmCountCache })
  const nowMs = Date.now()
  for (const [ip, e] of perIp) if (e.n <= 0 && nowMs - e.last > 120000) perIp.delete(ip)
}, CFG.gcIntervalS * 1000))
for (const t of timers) t.unref()

// ---------------------------------------------------------------- metrics endpoint (loopback only)
let metricsServer = null
if (CFG.metricsPort > 0) {
  metricsServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      res.setHeader('content-type', register.contentType)
      res.end(await register.metrics())
    } else { res.statusCode = 404; res.end() }
  })
}

// ---------------------------------------------------------------- lifecycle
process.on('SIGHUP', () => { try { loadAllow() } catch (err) { log('error', 'allow-list reload failed, keeping the old one', { err: err.message }) } })
function drain (signal) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'draining', { signal, connections: sockets.size, spread_ms: CFG.shutdownSpreadMs })
  httpServer.close()
  for (const ws of sockets) setTimeout(() => { try { ws.close(1001, 'server restarting') } catch (_) { /* gone */ } }, Math.random() * CFG.shutdownSpreadMs)
  // exit as soon as the last socket is gone (immediately when there are none), at the latest after spread + 2 s
  setInterval(() => { if (sockets.size === 0) process.exit(0) }, 100)
  setTimeout(() => process.exit(0), CFG.shutdownSpreadMs + 2000)
}
process.on('SIGTERM', () => drain('SIGTERM'))
process.on('SIGINT', () => drain('SIGINT'))
process.on('uncaughtException', (err) => {
  m.crashes.inc()
  log('error', 'uncaught exception, exiting for a clean restart', { err: err && err.stack })
  process.exit(1)
})

function start () {
  return new Promise((resolve) => {
    httpServer.listen(CFG.port, CFG.host, () => {
      const addr = httpServer.address()
      if (metricsServer) metricsServer.listen(CFG.metricsPort, '127.0.0.1')
      log('info', 'listening', { host: addr.address, port: addr.port, metricsPort: CFG.metricsPort, mode: CFG.allowFile ? 'allowlist' : 'open', cfg: { ...CFG, allowOrigins: CFG.allowOrigins.length } })
      resolve({ port: addr.port, metricsPort: metricsServer ? metricsServer.address()?.port : 0 })
    })
  })
}

await start()
