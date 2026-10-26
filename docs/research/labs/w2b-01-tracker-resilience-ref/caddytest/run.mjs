// Caddy 2.11.7 in front of tracker.mjs (plain HTTP on :18080 so no CA install is needed; the reverse_proxy/WebSocket path is identical).
// T1 relay through Caddy + X-Forwarded-For spoof resistance; T2 does Caddy's `servers { timeouts { idle } }` cut idle WebSockets?;
// T3 what `caddy reload` does to open WebSockets with and without stream_close_delay.
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
const HERE = dirname(fileURLToPath(import.meta.url))
const CADDY = process.env.CADDY
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bin = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('')
const dir = mkdtempSync(join(tmpdir(), 'caddytest-'))
const cfg = (idle, closeDelay) => `{
	auto_https off
	admin 127.0.0.1:12019
	grace_period 30s
	servers {
		timeouts {
			read_header 10s
			idle ${idle}
		}
	}
	metrics
}
:18080 {
	@ws {
		header Connection *Upgrade*
		header Upgrade websocket
	}
	handle @ws {
		reverse_proxy 127.0.0.1:{$TRACKER_PORT} {
			${closeDelay ? 'stream_close_delay ' + closeDelay : ''}
		}
	}
	handle {
		respond "ok" 200
	}
}
`
const startTracker = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(HERE, '..', 'tracker', 'tracker.mjs')], { env: { ...process.env, PORT: '0', METRICS_PORT: '0', OPEN: '1', ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  let b = ''
  p.stdout.on('data', (d) => { b += d; for (const l of b.split('\n')) { try { const j = JSON.parse(l); if (j.msg === 'listening') resolve({ p, port: j.port }) } catch (_) {} } })
})
const startCaddy = (file, port) => {
  const p = spawn(CADDY, ['run', '--config', file, '--adapter', 'caddyfile'], { env: { ...process.env, TRACKER_PORT: String(port) }, stdio: ['ignore', 'ignore', 'ignore'] })
  return p
}
const open = (headers = {}) => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:18080/', { headers }); w.msgs = []; w.on('message', (d) => w.msgs.push(JSON.parse(d.toString('utf8')))); w.on('open', () => res(w)); w.on('error', rej); w.on('unexpected-response', (_q, r) => rej(Object.assign(new Error('HTTP ' + r.statusCode), { status: r.statusCode }))) })
const ann = (ih, pid, extra = {}) => JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pid, left: 1, event: 'started', ...extra })
const waitFor = async (fn, ms = 3000) => { const e = Date.now() + ms; while (Date.now() < e) { const v = fn(); if (v) return v; await sleep(20) } return null }
const results = []
const rec = (name, ok, extra = '') => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, extra) }

// ---- T1 + T2 with idle 10s (short, to make T2 observable)
const f1 = join(dir, 'Caddyfile1'); writeFileSync(f1, cfg('10s', ''))
let t = await startTracker({ MAX_CONN_PER_IP: '2', PING_INTERVAL_S: '0', IDLE_TIMEOUT_S: '0' })
let c = startCaddy(f1, t.port); await sleep(2500)
try {
  const ih = bin(20); const a = await open(); const b = await open(); const pa = bin(20); const pb = bin(20); const oid = bin(20)
  a.send(ann(ih, pa, { numwant: 0, offers: [] })); await waitFor(() => a.msgs.find((m) => m.interval))
  b.send(ann(ih, pb, { numwant: 1, offers: [{ offer_id: oid, offer: { type: 'offer', sdp: 'v=0' } }] }))
  rec('T1a offer relayed through Caddy', !!(await waitFor(() => a.msgs.find((m) => m.offer))))
  // two sockets already open from 127.0.0.1 (the tracker cap is 2 per IP). A spoofed XFF must NOT buy a fresh identity.
  let st = null; try { await open({ 'X-Forwarded-For': '203.0.113.99' }) } catch (e) { st = e.status }
  rec('T1b spoofed X-Forwarded-For does not bypass the per-IP cap (3rd socket refused, HTTP 429)', st === 429, 'status ' + st)
  // T2: Caddy idle=10s. a and b stay silent for 40 s; do they survive?
  const t0 = Date.now(); let closedAt = null
  a.on('close', () => { closedAt = closedAt || Math.round((Date.now() - t0) / 1000) })
  await sleep(40000)
  rec('T2 idle WebSocket survives 40 s of silence with Caddy servers.timeouts.idle=10s (hijacked connections are exempt)', closedAt === null, closedAt === null ? 'still open' : 'closed after ' + closedAt + ' s')
  a.close(); b.close()
} finally { c.kill('SIGTERM'); t.p.kill('SIGKILL'); await sleep(800) }

// ---- T3 reload behaviour, without and with stream_close_delay
for (const delay of ['', '8s']) {
  const f = join(dir, 'CaddyfileR' + (delay || '0')); writeFileSync(f, cfg('5m', delay))
  t = await startTracker({ PING_INTERVAL_S: '0', IDLE_TIMEOUT_S: '0' })
  c = startCaddy(f, t.port); await sleep(2500)
  try {
    const w = await open(); w.send(ann(bin(20), bin(20), { numwant: 0, offers: [] })); await waitFor(() => w.msgs.length)
    let closedAfter = null; const t0 = Date.now(); w.on('close', (code) => { closedAfter = { ms: Date.now() - t0, code } })
    writeFileSync(f, cfg('5m', delay) + '\n# changed\n')
    execFileSync(CADDY, ['reload', '--config', f, '--adapter', 'caddyfile', '--address', '127.0.0.1:12019'], { stdio: 'ignore' })
    await sleep(14000)
    rec(`T3 caddy reload ${delay ? 'with stream_close_delay ' + delay : 'without stream_close_delay'}: WebSocket ${closedAfter ? 'closed after ' + closedAfter.ms + ' ms (code ' + closedAfter.code + ')' : 'survived 14 s'}`, delay ? (closedAfter && closedAfter.ms >= 7000) : (closedAfter && closedAfter.ms < 3000), '')
  } finally { c.kill('SIGTERM'); t.p.kill('SIGKILL'); await sleep(800) }
}
console.log(JSON.stringify({ pass: results.filter((r) => r.ok).length, total: results.length }))
process.exit(0)
