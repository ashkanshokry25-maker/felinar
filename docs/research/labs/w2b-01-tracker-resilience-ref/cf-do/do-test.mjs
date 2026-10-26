// Black-box test of the Durable Object tracker through `wrangler dev`.  node do-test.mjs ws://127.0.0.1:8787 [idleSeconds]
import WebSocket from 'ws'
const base = process.argv[2] || 'ws://127.0.0.1:8787'
const idle = Number(process.argv[3] || 0)
const bin = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('')
const hex = (b) => Buffer.from(b, 'latin1').toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ih = bin(20); const room = hex(ih)
const open = (path = '/' + room) => new Promise((res, rej) => { const w = new WebSocket(base + path); w.msgs = []; w.on('message', (d) => w.msgs.push(JSON.parse(d.toString('utf8')))); w.on('open', () => res(w)); w.on('error', rej); w.on('unexpected-response', (_q, r) => rej(Object.assign(new Error('HTTP ' + r.statusCode), { status: r.statusCode }))) })
const waitFor = async (fn, ms = 3000) => { const e = Date.now() + ms; while (Date.now() < e) { const v = fn(); if (v) return v; await sleep(20) } return null }
const ann = (pid, extra = {}) => JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pid, uploaded: 0, downloaded: 0, left: 1, event: 'started', ...extra })
const offer = (id) => ({ offer_id: id, offer: { type: 'offer', sdp: 'v=0\r\n' + 'a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n'.repeat(10) } })
const out = []
const check = (name, ok, extra = '') => { out.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, extra) }

const a = await open(); const b = await open(); const pa = bin(20); const pb = bin(20); const oid = bin(20)
a.send(ann(pa, { numwant: 0, offers: [] }))
const first = await waitFor(() => a.msgs.find((m) => m.interval))
check('announce reply has interval 120', first && first.interval === 120, JSON.stringify(first && { interval: first.interval, complete: first.complete, incomplete: first.incomplete }))
if (idle) { console.log(`idling ${idle}s so the Durable Object can hibernate...`); await sleep(idle * 1000) }
const t0 = Date.now()
b.send(ann(pb, { numwant: 1, offers: [offer(oid)] }))
const got = await waitFor(() => a.msgs.find((m) => m.offer))
check('offer relayed to A (after idle/hibernation)', got && got.offer_id === oid && got.peer_id === pb, `${Date.now() - t0} ms`)
a.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: pa, to_peer_id: pb, offer_id: oid, answer: { type: 'answer', sdp: 'v=0\r\n' } }))
const ans = await waitFor(() => b.msgs.find((m) => m.answer))
check('answer relayed to B', ans && ans.offer_id === oid && ans.peer_id === pa)
b.msgs.length = 0; b.send(ann(pb, { offers: [null] }))
check('offers:[null] rejected, no crash', (await waitFor(() => b.msgs[0]))?.['failure reason'] === 'invalid offer')
b.msgs.length = 0; b.send(ann(bin(20), { offers: [] }))
check('peer_id change rejected', (await waitFor(() => b.msgs[0]))?.['failure reason'] === 'peer_id changed on this connection')
const wrong = JSON.stringify({ action: 'announce', info_hash: bin(20), peer_id: pb, left: 1, event: 'started' })
b.msgs.length = 0; b.send(wrong)
check('info_hash different from the URL rejected', (await waitFor(() => b.msgs[0]))?.['failure reason'] === 'info_hash does not match this endpoint')
let st = null; try { await open('/not-a-hash') } catch (e) { st = e.status }
check('bad path -> HTTP 400', st === 400, String(st))
const closed = new Promise((r) => b.on('close', (c) => r(c))); b.close(1000)
check('clean close handshake completes', (await Promise.race([closed, sleep(2000).then(() => null)])) !== null)
console.log(JSON.stringify({ pass: out.filter((x) => x.ok).length, total: out.length }))
process.exit(out.every((x) => x.ok) ? 0 : 1)
