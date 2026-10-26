// Black-box tests for tracker.mjs: spawns the real process, talks real WebSocket. `node --test test/` or `node test/run.mjs`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const TRACKER = join(HERE, '..', 'tracker.mjs')
const bin = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('')
const hex = (b) => Buffer.from(b, 'latin1').toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let metricsPortCounter = 19400 + Math.floor(Math.random() * 400)

function run (env = {}) {
  const metricsPort = metricsPortCounter++
  const proc = spawn(process.execPath, [TRACKER], { env: { ...process.env, PORT: '0', METRICS_PORT: String(metricsPort), OPEN: '1', LOG_LEVEL: 'info', SHUTDOWN_SPREAD_MS: '300', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  let exit = null
  const done = new Promise((r) => proc.on('exit', (code, sig) => { exit = { code, sig }; r(exit) }))
  return new Promise((resolve, reject) => {
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try { const j = JSON.parse(line); logs.push(j); if (j.msg === 'listening') resolve({ proc, port: j.port, metricsPort, logs, done, get exit () { return exit }, stop: () => { proc.kill('SIGKILL') } }) } catch (_) { /* ignore */ }
      }
    })
    proc.stderr.on('data', (d) => logs.push({ stderr: String(d) }))
    proc.on('exit', () => reject(new Error('tracker exited early: ' + JSON.stringify(logs.slice(-3)))))
  })
}
const open = (t, opts = {}) => new Promise((res, rej) => {
  const w = new WebSocket(`ws://127.0.0.1:${t.port}/`, opts)
  w.msgs = []
  w.on('message', (d) => { try { w.msgs.push(JSON.parse(d.toString('utf8'))) } catch (_) { w.msgs.push({ raw: String(d) }) } })
  w.on('open', () => res(w))
  w.on('unexpected-response', (_q, r) => rej(Object.assign(new Error('HTTP ' + r.statusCode), { status: r.statusCode })))
  w.on('error', rej)
})
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(15) } return null }
const ann = (ih, pid, extra = {}) => JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pid, uploaded: 0, downloaded: 0, left: 1, event: 'started', ...extra })
const offer = (id) => ({ offer_id: id, offer: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' + 'a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n'.repeat(20) } })

test('relays offer and answer between two peers; replies to announce with interval', async () => {
  const t = await run(); const ih = bin(20)
  try {
    const a = await open(t); const b = await open(t); const pa = bin(20); const pb = bin(20); const oid = bin(20)
    a.send(ann(ih, pa, { numwant: 0, offers: [] }))
    const first = await waitFor(() => a.msgs.find((m) => m.interval))
    assert.equal(first.interval, 120)
    b.send(ann(ih, pb, { numwant: 1, offers: [offer(oid)] }))
    const got = await waitFor(() => a.msgs.find((m) => m.offer))
    assert.equal(got.offer_id, oid); assert.equal(got.peer_id, pb)
    a.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pa, to_peer_id: pb, offer_id: oid, answer: { type: 'answer', sdp: 'v=0\r\n' } }))
    const ans = await waitFor(() => b.msgs.find((m) => m.answer))
    assert.equal(ans.offer_id, oid); assert.equal(ans.peer_id, pa)
  } finally { t.stop() }
})

test('malformed announces are rejected and the process survives (stock server dies on offers:[null])', async () => {
  const t = await run(); const ih = bin(20)
  try {
    const a = await open(t); const b = await open(t)
    a.send(ann(ih, bin(20), { numwant: 0, offers: [] }))
    await waitFor(() => a.msgs.length)
    const cases = [
      [{ numwant: 1, offers: [null] }, 'invalid offer'],
      [{ numwant: 1, offers: ['x'] }, 'invalid offer'],
      [{ numwant: 1, offers: [{ offer_id: bin(20), offer: null }] }, 'invalid offer'],
      [{ numwant: 11, offers: Array.from({ length: 11 }, () => offer(bin(20))) }, 'too many offers'],
      [{ event: 'bogus' }, 'invalid event'],
      [{ offers: 'abc' }, 'too many offers'],
      [{ answer: { type: 'answer', sdp: 'x' } }, 'answer needs to_peer_id and offer_id']
    ]
    const pidB = bin(20)
    for (const [extra, why] of cases) {
      b.msgs.length = 0
      b.send(ann(ih, pidB, extra))
      const r = await waitFor(() => b.msgs.find((m) => m['failure reason']))
      assert.ok(r, 'no failure reply for ' + JSON.stringify(extra).slice(0, 60))
      assert.equal(r['failure reason'], why)
    }
    b.msgs.length = 0
    b.send('not json'); assert.equal((await waitFor(() => b.msgs[0]))['failure reason'], 'invalid json')
    b.msgs.length = 0
    b.send(ann('short', pidB)); assert.equal((await waitFor(() => b.msgs[0]))['failure reason'], 'invalid info_hash')
    b.msgs.length = 0
    b.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pidB, left: null, event: 'update', offers: [], numwant: 0 }))
    assert.ok((await waitFor(() => b.msgs.find((m) => m.interval))), 'left:null (Infinity) must be accepted')
    assert.equal(t.exit, null, 'process must still be alive')
  } finally { t.stop() }
})

test('scrape is disabled by default and cannot enumerate swarms', async () => {
  const t = await run()
  try {
    const a = await open(t)
    a.send(JSON.stringify({ action: 'scrape' }))
    assert.equal((await waitFor(() => a.msgs[0]))['failure reason'], 'scrape is disabled')
  } finally { t.stop() }
  const t2 = await run({ ALLOW_SCRAPE: '1' })
  try {
    const a = await open(t2)
    a.send(JSON.stringify({ action: 'scrape' }))
    assert.equal((await waitFor(() => a.msgs[0]))['failure reason'], 'scrape needs 1-10 info_hash values')
    a.msgs.length = 0
    a.send(JSON.stringify({ action: 'scrape', info_hash: [bin(20)] }))
    assert.ok((await waitFor(() => a.msgs[0])).files)
  } finally { t2.stop() }
})

test('oversize message closes the socket with 1009', async () => {
  const t = await run()
  try {
    const a = await open(t)
    const closed = new Promise((r) => a.on('close', (code) => r(code)))
    a.send(JSON.stringify({ action: 'announce', info_hash: bin(20), peer_id: bin(20), pad: 'x'.repeat(70 * 1024) }))
    assert.equal(await Promise.race([closed, sleep(3000).then(() => 'timeout')]), 1009)
  } finally { t.stop() }
})

test('swarms per socket are capped', async () => {
  const t = await run({ MAX_SWARMS_PER_SOCKET: '3' })
  try {
    const a = await open(t)
    const pid = bin(20)
    for (let i = 0; i < 3; i++) a.send(ann(bin(20), pid, { numwant: 0, offers: [] }))
    await waitFor(() => a.msgs.filter((m) => m.interval).length === 3)
    a.msgs.length = 0
    a.send(ann(bin(20), pid, { numwant: 0, offers: [] }))
    assert.equal((await waitFor(() => a.msgs[0]))['failure reason'], 'too many swarms on this connection')
    a.msgs.length = 0
    a.send(ann(bin(20), bin(20), { numwant: 0, offers: [] })) // a different peer_id on the same socket
    assert.equal((await waitFor(() => a.msgs[0]))['failure reason'], 'peer_id changed on this connection')
  } finally { t.stop() }
})

test('per-socket message rate limit; persistent flooding is cut with 1008', async () => {
  const t = await run({ RATE_BURST: '5', RATE_PER_SEC: '1' })
  try {
    const a = await open(t)
    const closed = new Promise((r) => a.on('close', (code) => r(code)))
    const pid = bin(20)
    for (let i = 0; i < 40; i++) a.send(ann(bin(20), pid, { numwant: 0, offers: [] }))
    await sleep(300)
    assert.ok(a.msgs.some((m) => m['failure reason'] === 'rate limit'))
    assert.equal(await Promise.race([closed, sleep(3000).then(() => 'timeout')]), 1008)
  } finally { t.stop() }
})

test('per-IP connection cap (X-Forwarded-For honoured only from loopback proxy)', async () => {
  const t = await run({ MAX_CONN_PER_IP: '2' })
  try {
    const h1 = { 'X-Forwarded-For': '203.0.113.7' }; const h2 = { 'X-Forwarded-For': '203.0.113.8' }
    const a = await open(t, { headers: h1 }); const b = await open(t, { headers: h1 })
    await assert.rejects(open(t, { headers: h1 }), (e) => e.status === 429)
    const c = await open(t, { headers: h2 }) // different client IP is fine
    a.close(); await sleep(200)
    const d = await open(t, { headers: h1 }) // slot released
    for (const w of [b, c, d]) w.close()
  } finally { t.stop() }
})

test('CLIENT_IP_HEADER selects the header that carries the client IP (e.g. Fly-Client-IP / X-Real-IP)', async () => {
  const t = await run({ MAX_CONN_PER_IP: '1', CLIENT_IP_HEADER: 'x-real-ip' })
  try {
    const a = await open(t, { headers: { 'X-Real-IP': '198.51.100.1' } })
    await assert.rejects(open(t, { headers: { 'X-Real-IP': '198.51.100.1' } }), (e) => e.status === 429)
    const b = await open(t, { headers: { 'X-Real-IP': '198.51.100.2' } })
    a.close(); b.close()
  } finally { t.stop() }
})

test('info-hash allow-list with SIGHUP reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwt-')); const file = join(dir, 'allow.txt')
  const ok = bin(20); const later = bin(20); const no = bin(20)
  writeFileSync(file, `# allowed\n${hex(ok)}\n`)
  const t = await run({ ALLOW_FILE: file, OPEN: '' })
  try {
    const a = await open(t)
    const pid = bin(20)
    a.send(ann(ok, pid, { numwant: 0, offers: [] })); assert.ok(await waitFor(() => a.msgs.find((m) => m.interval)))
    a.msgs.length = 0
    a.send(ann(no, pid, { numwant: 0, offers: [] })); assert.match((await waitFor(() => a.msgs[0]))['failure reason'], /not allowed/)
    a.msgs.length = 0
    a.send(ann(later, pid, { numwant: 0, offers: [] })); assert.match((await waitFor(() => a.msgs[0]))['failure reason'], /not allowed/)
    writeFileSync(file, `${hex(ok)}\n${hex(later)}\n`); t.proc.kill('SIGHUP'); await sleep(300)
    a.msgs.length = 0
    a.send(ann(later, pid, { numwant: 0, offers: [] })); assert.ok(await waitFor(() => a.msgs.find((m) => m.interval)))
  } finally { t.stop() }
})

test('refuses to start without ALLOW_FILE or OPEN=1', async () => {
  const p = spawn(process.execPath, [TRACKER], { env: { ...process.env, PORT: '0', METRICS_PORT: '0', OPEN: '' }, stdio: 'ignore' })
  const code = await new Promise((r) => p.on('exit', r))
  assert.equal(code, 2)
})

test('Origin allow-list', async () => {
  const t = await run({ ALLOW_ORIGINS: 'https://a.example,https://b.example' })
  try {
    await assert.rejects(open(t, { headers: { Origin: 'https://evil.example' } }), (e) => e.status === 403)
    await assert.rejects(open(t), (e) => e.status === 403) // no Origin header: not a browser
    const w = await open(t, { headers: { Origin: 'https://b.example' } }); w.close()
  } finally { t.stop() }
})

test('ping/pong: a client that never answers pings is dropped; idle clients are closed', async () => {
  const t = await run({ PING_INTERVAL_S: '1', IDLE_TIMEOUT_S: '3' })
  try {
    const zombie = await open(t, { autoPong: false })
    const closedZ = new Promise((r) => { const t0 = Date.now(); zombie.on('close', (c) => r({ c, ms: Date.now() - t0 })) })
    const rz = await Promise.race([closedZ, sleep(6000).then(() => null)])
    assert.ok(rz, 'zombie must be terminated'); assert.ok(rz.ms < 4500, 'terminated within ~2-3 pings, was ' + rz.ms)
    const idle = await open(t) // answers pings but never sends an application message
    const closedI = new Promise((r) => { const t0 = Date.now(); idle.on('close', (c) => r({ c, ms: Date.now() - t0 })) })
    const ri = await Promise.race([closedI, sleep(7000).then(() => null)])
    assert.ok(ri, 'idle client must be closed'); assert.equal(ri.c, 1001)
  } finally { t.stop() }
})

test('metrics endpoint and /healthz', async () => {
  const t = await run()
  try {
    const a = await open(t); a.send(ann(bin(20), bin(20), { numwant: 0, offers: [] })); await waitFor(() => a.msgs.length)
    const txt = await (await fetch(`http://127.0.0.1:${t.metricsPort}/metrics`)).text()
    for (const k of ['mwt_connections 1', 'mwt_messages_total{action="announce"} 1', 'mwt_swarms 1', 'mwt_peers 1', 'mwt_process_cpu_seconds_total', 'mwt_message_handle_seconds_bucket', 'mwt_build_info']) assert.ok(txt.includes(k), 'missing ' + k)
    const h = await (await fetch(`http://127.0.0.1:${t.port}/healthz`)).json()
    assert.equal(h.ok, true); assert.equal(h.connections, 1)
    assert.equal((await fetch(`http://127.0.0.1:${t.port}/metrics`)).status, 404, '/metrics must not be served on the public port')
  } finally { t.stop() }
})

test('empty swarms are garbage-collected', async () => {
  const t = await run({ GC_INTERVAL_S: '1' })
  try {
    const a = await open(t)
    const pid = bin(20)
    for (let i = 0; i < 5; i++) a.send(ann(bin(20), pid, { numwant: 0, offers: [] }))
    await waitFor(() => a.msgs.length === 5)
    let txt = await (await fetch(`http://127.0.0.1:${t.metricsPort}/metrics`)).text()
    assert.match(txt, /mwt_swarms 5/)
    a.close(); await sleep(2500)
    txt = await (await fetch(`http://127.0.0.1:${t.metricsPort}/metrics`)).text()
    assert.match(txt, /mwt_swarms 0/)
  } finally { t.stop() }
})

test('slow reader is cut when its backlog exceeds BUFFER_LIMIT', async () => {
  const t = await run({ BUFFER_LIMIT: '50000', RATE_BURST: '100000', RATE_PER_SEC: '100000', MAX_PAYLOAD: '65536' })
  try {
    const ih = bin(20)
    const victim = await open(t)
    victim.send(ann(ih, bin(20), { numwant: 0, offers: [] })); await waitFor(() => victim.msgs.length)
    victim._socket.pause() // stop reading: kernel buffers fill, then ws queues in user space
    const closed = new Promise((r) => victim.on('close', () => r('closed')))
    const flooder = await open(t)
    const fpid = bin(20)
    const big = { offer_id: bin(20), offer: { type: 'offer', sdp: 'x'.repeat(15000) } }
    let sent = 0
    const end = Date.now() + 8000
    while (Date.now() < end && sent < 20000) {
      flooder.send(ann(ih, fpid, { numwant: 1, offers: [big] })); sent++
      if (sent % 200 === 0) { await sleep(5); victim._socket.resume(); victim._socket.pause(); if (victim.readyState !== 1) break }
    }
    victim._socket.resume()
    await Promise.race([closed, sleep(2000)])
    const txt = await (await fetch(`http://127.0.0.1:${t.metricsPort}/metrics`)).text()
    assert.match(txt, /mwt_connections_closed_total\{reason="backlog"\} [1-9]/, 'victim should be cut with reason=backlog (sent ' + sent + ')')
  } finally { t.stop() }
})

test('SIGTERM drains: 503 on /healthz is not required, but sockets get 1001 and the process exits 0', async () => {
  const t = await run({ SHUTDOWN_SPREAD_MS: '400' })
  const a = await open(t); const b = await open(t)
  const cl = (w) => new Promise((r) => w.on('close', (c) => r(c)))
  const ca = cl(a); const cb = cl(b)
  t.proc.kill('SIGTERM')
  assert.deepEqual([await ca, await cb], [1001, 1001])
  const ex = await Promise.race([t.done, sleep(5000).then(() => null)])
  assert.ok(ex && ex.code === 0, 'exit code 0, got ' + JSON.stringify(ex))
})
