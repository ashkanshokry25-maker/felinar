// Topic-12 experiment orchestrator (research 2026-10-17).  Node >= 22, Playwright 1.64 + its Chromium, bittorrent-tracker 11.2.3.
// Usage:  PATH=$HOME/.local/share/node/current/bin:$PATH node lab.mjs <experiment> [<experiment> ...]    (results -> ./results/<name>.json)
//   e1            metadata-less "rendezvous" torrent (bare infohash): connects? announces left=? ext round-trip      (e1soak adds a 140 s idle soak)
//   e1x:<kind>:<mode>[:N]   glare matrix, kind = rv | seed, mode = sim | stag, N trials (default 15)
//   e2            bugout-style rendezvous (one-file torrent named+filled with the identifier): deterministic infohash? seed<->seed wires?
//   e3:<uplink>[:r<N>]      head-of-line blocking; uplink = off | 8MiB | 1MiB | 256KiB, optional reqq N advertised by the uploader
//   e4            client-global upload throttle: throttleUpload(0) vs ext frames on an rv wire (same client) and on a second client
//   e5            is maxConns enforced for WebRTC peers? (5 pages, maxConns 2)
//   e6            Trystero 0.26.0 torrent strategy against the same local tracker      (needs TRYSTERO_BUNDLE=<iife js exposing window.__trystero>)
//   e7            unbounded inbound message length in bittorrent-protocol 5.0.9
//   e8            per-torrent getAnnounceOpts (numwant / left override)
//   e9            the rendezvous trick against live public trackers                     (needs E9_URLS=wss://a,wss://b ...)
//   e10           is wire.peerId identical across torrents of one client?
//   e11           two site versions (different content infohashes) meet through the rendezvous infohash
//   e12 / e12c    hostile ut_metadata size on a bare-infohash swarm, without / with wire.ut_metadata.cancel()
//   diag          idle RTT sanity matrix
// Env: PAGE_PORT, TR_PORT (default 18281 / 18282), LAB_DEBUG='webtorrent:peer,...' (forwards page console + enables the debug module).
// Everything binds to 127.0.0.1 only; only e9 contacts third-party servers (the trackers you list).
import { chromium } from 'playwright'
import Tracker from 'bittorrent-tracker/server'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wtDist = path.resolve(here, '../../../../node_modules/webtorrent/dist/webtorrent.min.js')
const outDir = path.join(here, 'results'); fs.mkdirSync(outDir, { recursive: true })
const PAGE_PORT = Number(process.env.PAGE_PORT || 18281); const TR_PORT = Number(process.env.TR_PORT || 18282)
const TR = `ws://127.0.0.1:${TR_PORT}`
const sha1hex = s => crypto.createHash('sha1').update(s).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => { fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(obj, null, 2)); return obj }
const MiB = 1024 * 1024

// ---------------------------------------------------------------------------------------------------------------
const announceLog = []
const tracker = new Tracker({ udp: false, http: false, ws: true, stats: false })
tracker.on('error', e => console.error('tracker error', e.message))
tracker.on('warning', e => announceLog.push({ warn: e.message }))
for (const ev of ['start', 'update', 'complete', 'stop']) {
  tracker.on(ev, (peerId, params) => announceLog.push({ ev, ih: params.info_hash, left: params.left, numwant: params.numwant, offers: Array.isArray(params.offers) ? params.offers.length : undefined }))
}
await new Promise(res => tracker.listen(TR_PORT, '127.0.0.1', res))

const files = {
  '/page.html': ['text/html; charset=utf-8', Buffer.from('<!doctype html><meta charset="utf-8"><title>lab</title><script type="module" src="/page-lib.js"></script>')],
  '/page-lib.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(path.join(here, 'page-lib.js'))],
  '/webtorrent.min.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(wtDist)]
}
if (process.env.TRYSTERO_BUNDLE) files['/trystero.js'] = ['text/javascript; charset=utf-8', () => fs.readFileSync(process.env.TRYSTERO_BUNDLE)]
const web = http.createServer((req, res) => {
  const f = files[req.url.split('?')[0]]
  if (!f) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200, { 'content-type': f[0], 'cache-control': 'no-store' })
  res.end(typeof f[1] === 'function' ? f[1]() : f[1])
})
await new Promise(res => web.listen(PAGE_PORT, '127.0.0.1', res))

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
})
const version = browser.version()
const pagesOpen = []
const newPage = async () => {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  p.on('pageerror', e => console.error('pageerror', String(e).slice(0, 300)))
  p.on('crash', () => console.error('PAGE CRASHED'))
  p.on('close', () => { if (process.env.LAB_DEBUG_CLOSE) console.error('page closed') })
  if (process.env.LAB_DEBUG) {
    await p.addInitScript(d => { try { localStorage.debug = d } catch (_) {} }, process.env.LAB_DEBUG)
    const id = pagesOpen.length
    p.on('console', m => console.log(`[page${id}]`, m.text().slice(0, 400)))
  }
  await p.goto(`http://127.0.0.1:${PAGE_PORT}/page.html`)
  await p.waitForFunction(() => window.__labReady === true, null, { timeout: 15000 })
  pagesOpen.push(ctx)
  return p
}
const closeAll = async () => { for (const c of pagesOpen.splice(0)) { try { await c.close() } catch (_) { /* ignore */ } } }
const ev = (p, fn, arg) => p.evaluate(fn, arg)
const clearAnn = () => { announceLog.length = 0 }
const annSummary = ih => {
  const rows = announceLog.filter(r => r.ih === ih)
  const by = {}
  for (const r of rows) { const k = `${r.ev} left=${JSON.stringify(r.left)}`; by[k] = (by[k] || 0) + 1 }
  return by
}
const rvHex = id => sha1hex('magnet-web/rv/1\0' + id)
const hexOf20 = ih => ih // tracker logs info_hash as hex already

// ---------------------------------------------------------------------------------------------------------------
async function e1 (soakS = 0) {
  clearAnn()
  const R = { name: 'e1 metadata-less rendezvous', chromium: version, tracker: TR }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  const rv = rvHex('chain:host:example.test'); R.rvInfoHash = rv
  const tAdd = Date.now()
  await Promise.all([A, B].map(p => ev(p, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])))
  const waits = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0, 30000))))
  R.timeToWireMs = { A: waits[0], B: waits[1], wallMs: Date.now() - tAdd }
  R.pingIdle = await ev(A, () => lab.pingLoop('rv', 50, 3000, 64))
  R.wireA = await ev(A, () => lab.wireInfo())
  R.torrentA = await ev(A, () => lab.torrentInfo('rv:c'))
  R.torrentB = await ev(B, () => lab.torrentInfo('rv:c'))
  R.announcesFromPageA = (await ev(A, () => lab.announces)).slice(0, 6)
  R.trackerSideAnnounces = annSummary(rv)
  R.logsA = await ev(A, () => lab.logs)
  if (soakS > 0) {
    await sleep(soakS * 1000)
    R.soak = { seconds: soakS, wiresAAfter: await ev(A, () => lab.wireCount('rv')), wiresBAfter: await ev(B, () => lab.wireCount('rv')), pingAfter: await ev(A, () => lab.pingLoop('rv', 50, 2000, 64)), announcesA: (await ev(A, () => lab.announces)).length }
  }
  await closeAll()
  return save('e1' + (soakS ? '-soak' : ''), R)
}

async function e2 () {
  clearAnn()
  const R = { name: 'e2 bugout-style seeded identifier torrent', chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  const ident = 'magnet-web-rv-test-identifier'
  const [ia, ib] = await Promise.all([A, B].map(p => ev(p, ([id, tr]) => lab.seedText('c', id, tr, 'bo'), [ident, TR])))
  R.infoHashA = ia; R.infoHashB = ib; R.sameInfoHash = ia.infoHash === ib.infoHash
  const tw = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('bo') > 0, 30000))))
  R.timeToWireMs = tw
  if (tw[0].ok) R.pingIdle = await ev(A, () => lab.pingLoop('bo', 50, 2000, 64))
  R.announcesFromPageA = (await ev(A, () => lab.announces)).slice(0, 6)
  R.trackerSideAnnounces = annSummary(ia.infoHash)
  await sleep(30000)
  R.wiresAfter30s = { A: await ev(A, () => lab.wireCount('bo')), B: await ev(B, () => lab.wireCount('bo')) }
  R.wireInfoA = await ev(A, () => lab.wireInfo())
  await closeAll()
  return save('e2', R)
}

async function e3 (modeStr) {
  const [mode, rqPart] = modeStr.split(':'); const reqq = rqPart ? Number(rqPart.replace('r', '')) : 0
  const rates = { off: -1, '8MiB': 8 * MiB, '1MiB': 1 * MiB, '256KiB': 256 * 1024 }
  const sizes = { off: 128 * MiB, '8MiB': 128 * MiB, '1MiB': 64 * MiB, '256KiB': 64 * MiB }
  const windows = { off: 25000, '8MiB': 14000, '1MiB': 10000, '256KiB': 10000 }
  clearAnn()
  const R = { name: 'e3 head-of-line blocking', mode, reqq, uploadLimitBps: rates[mode], contentBytes: sizes[mode], chromium: version }
  // --- pass 1: clean idle baseline (no bulk traffic) on a fresh pair: rv = rendezvous wire on the content client, ctl = rendezvous wire on a 2nd client
  {
    const A = await newPage(); const B = await newPage()
    await Promise.all([A, B].map(p => ev(p, () => { lab.mk('c'); lab.mk('g') })))
    const a = rvHex('e3-idle-c:' + mode + Date.now()); const b = rvHex('e3-idle-g:' + mode + Date.now())
    await Promise.all([A, B].map(p => ev(p, ([a, b, tr]) => { lab.joinRv('c', a, tr, 'rv'); lab.joinRv('g', b, tr, 'ctl') }, [a, b, TR])))
    R.idleReady = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0 && lab.wireCount('ctl') > 0, 30000))))
    R.idleBaseline = []
    for (const t of ['rv', 'ctl']) R.idleBaseline.push(await ev(A, t => lab.pingLoop(t, 20, 3000, 64), t))
    await closeAll()
  }
  // --- pass 2: bulk transfer A -> B while pinging three paths from A
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => { lab.mk('c'); lab.mk('g') })))
  const a = rvHex('e3-run-c:' + mode + Date.now()); const b = rvHex('e3-run-g:' + mode + Date.now())
  await Promise.all([A, B].map(p => ev(p, ([a, b, tr]) => { lab.joinRv('c', a, tr, 'rv'); lab.joinRv('g', b, tr, 'ctl') }, [a, b, TR])))
  R.runReady = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0 && lab.wireCount('ctl') > 0, 30000))))
  if (reqq) await ev(A, q => { lab.reqq = q }, reqq)
  const ih = await ev(A, ([n, tr]) => lab.seedBytes('c', n, 'blob.bin', tr, 'content'), [sizes[mode], TR])
  R.contentInfoHash = ih
  if (rates[mode] > 0) await ev(A, r => lab.throttle('c', r), rates[mode])
  await sleep(700) // a leecher normally arrives long after the seeder announced; joining within ~1 tracker RTT causes crossed offers (see e1x)
  await ev(B, ([ih, tr]) => { lab.addMagnet('c', ih, tr, 'content'); return true }, [ih, TR])
  R.contentWireReady = await ev(A, () => lab.waitFor(() => lab.wireCount('content') > 0, 8000))
  if (!R.contentWireReady.ok) { await closeAll(); R.retryNeeded = true; return R } // crossed offers (glare) between seeder start and leecher join: retry the whole trial
  await ev(A, () => lab.startPingers(['content', 'rv', 'ctl'], 10, 64))
  const tStart = Date.now()
  const done = await ev(B, w => lab.waitFor(() => lab.torrents['content:c'].done, w, 100), windows[mode])
  const tEnd = Date.now()
  const recvBytes = await ev(B, () => lab.torrents['content:c'].received)
  R.transfer = { finished: done.ok, windowMs: tEnd - tStart, receivedBytes: recvBytes, MiBps: Math.round(recvBytes / MiB / ((tEnd - tStart) / 1000) * 10) / 10 }
  R.rtt = await ev(A, () => lab.stopPingers(['content', 'rv', 'ctl'], 2500))
  R.wireInfoA = (await ev(A, () => lab.wireInfo())).map(w => ({ tag: w.tag, type: w.type, errors: w.errors }))
  await closeAll()
  return save('e3-' + mode + (reqq ? '-r' + reqq : ''), R)
}

// e1x: glare / first-connect reliability.  kind = 'rv' (bare infohash, left=null) | 'seed' (bugout-style complete tiny torrent, left=0)
//      mode = 'sim' (both pages join in the same tick) | 'stag' (B joins 300 ms after A).  N trials, 12 s timeout each.
async function glare (kind, mode, N = 15) {
  clearAnn()
  const R = { name: `e1x glare ${kind}/${mode}`, chromium: version, trials: N, connected: 0, timeMs: [], failed: [] }
  const A = await newPage(); const B = await newPage()
  for (let i = 0; i < N; i++) {
    const tag = `${kind}${mode}${i}`; const cid = 'c' + i
    await Promise.all([A, B].map(p => ev(p, cid => lab.mk(cid), cid)))
    const id = rvHex(`glare:${kind}:${mode}:${i}:${Date.now()}:${Math.random()}`)
    const join = p => kind === 'rv'
      ? ev(p, ([cid, id, tr, tag]) => lab.joinRv(cid, id, tr, tag), [cid, id, TR, tag])
      : ev(p, ([cid, id, tr, tag]) => lab.seedText(cid, id, tr, tag), [cid, id, TR, tag])
    const t0 = Date.now()
    if (mode === 'sim') await Promise.all([join(A), join(B)])
    else { await join(A); await sleep(300); await join(B) }
    const w = await Promise.all([A, B].map(p => ev(p, tag => lab.waitFor(() => lab.wireCount(tag) > 0, 12000, 25), tag)))
    const ok = w[0].ok && w[1].ok
    if (ok) { R.connected++; R.timeMs.push(Date.now() - t0) } else R.failed.push({ i, A: w[0], B: w[1], wires: [await ev(A, tag => lab.wireCount(tag), tag), await ev(B, tag => lab.wireCount(tag), tag)] })
  }
  R.timeMs.sort((a, b) => a - b)
  R.p50ms = R.timeMs[Math.floor(R.timeMs.length / 2)] ?? null; R.maxMs = R.timeMs[R.timeMs.length - 1] ?? null
  await closeAll()
  return save(`e1x-${kind}-${mode}`, R)
}

// diag: why is the idle RTT on the 2nd client's wire slow?  order/concurrency matrix
async function diag () {
  const R = { name: 'diag idle RTT by client order', chromium: version, runs: [] }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => { lab.mk('c'); lab.mk('g') })))
  const a = rvHex('diag-c:' + Date.now()); const b = rvHex('diag-g:' + Date.now())
  await Promise.all([A, B].map(p => ev(p, ([a, b, tr]) => { lab.joinRv('c', a, tr, 'rv'); lab.joinRv('g', b, tr, 'ctl') }, [a, b, TR])))
  await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0 && lab.wireCount('ctl') > 0, 30000))))
  const one = async (label, tags) => {
    const res = await Promise.all(tags.map(t => ev(A, t => lab.pingLoop(t, 20, 2000, 64, 2500), t)))
    R.runs.push({ label, res: res.map(r => ({ tag: r.tag, sent: r.sent, recv: r.recv, p50: r.p50, p90: r.p90, p99: r.p99, max: r.max })) })
  }
  await one('rv alone', ['rv'])
  await one('ctl alone', ['ctl'])
  await one('rv alone again', ['rv'])
  await one('ctl alone again', ['ctl'])
  await one('both concurrent', ['rv', 'ctl'])
  R.visibility = await Promise.all([A, B].map(p => ev(p, () => ({ vis: document.visibilityState, hasFocus: document.hasFocus() }))))
  await closeAll()
  return save('diag', R)
}

// e7: does bittorrent-protocol bound the inbound message length?  A claims a 2 GiB-1 message and streams 32 MiB; B's wire buffers it all.
async function e7 () {
  const R = { name: 'e7 unbounded inbound message length (bittorrent-protocol 5.0.9)', chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  const rv = rvHex('e7:' + Date.now())
  await Promise.all([A, B].map(p => ev(p, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])))
  await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0, 30000))))
  R.beforeOnB = await ev(B, () => { const w = lab.wires[0].wire; return { bufferSize: w._bufferSize, parserSize: w._parserSize, destroyed: w.destroyed } })
  // B: event-loop stall monitor (setInterval drift) while the attack runs
  await ev(B, () => { window.__stall = { max: 0, last: performance.now() }; window.__stallTimer = setInterval(() => { const n = performance.now(); window.__stall.max = Math.max(window.__stall.max, n - window.__stall.last - 20); window.__stall.last = n }, 20) })
  R.attack = await ev(A, async () => {
    const w = lab.wires[0].wire; const t0 = performance.now()
    w._push(new Uint8Array([0x7f, 0xff, 0xff, 0xff])) // length prefix = 2^31-1, then never finish the message
    const chunk = new Uint8Array(64 * 1024).fill(7)   // <= 256 KiB data channel cap in Chromium (a bigger chunk kills the connection, see 01 F24)
    for (let i = 0; i < 256; i++) { w._push(chunk); if (i % 4 === 3) await new Promise(r => setTimeout(r, 5)) }
    return { sentMiB: 16, sendMs: Math.round(performance.now() - t0), aDestroyed: !!w.destroyed }
  })
  await sleep(4000)
  R.afterOnB = await ev(B, () => { const w = lab.wires[0].wire; clearInterval(window.__stallTimer); return { bufferMiB: Math.round(w._bufferSize / 1048576 * 10) / 10, parserSize: w._parserSize, destroyed: !!w.destroyed, maxEventLoopStallMs: Math.round(window.__stall.max) } })
  await closeAll()
  return save('e7', R)
}

// e8: per-torrent getAnnounceOpts (numwant / left override) on a bare-infohash torrent
async function e8 () {
  clearAnn()
  const R = { name: 'e8 getAnnounceOpts override', chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  const rv = rvHex('e8:' + Date.now())
  await ev(A, ([rv, tr]) => { window.__want = 2; return lab.joinRv('c', rv, tr, 'rv', { getAnnounceOpts: () => ({ numwant: window.__want, left: 1 }) }) }, [rv, TR])
  await sleep(300)
  await ev(B, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])
  R.connected = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0, 15000))))
  R.announcesA = (await ev(A, () => lab.announces)).map(a => ({ event: a.event, left: a.left, numwant: a.numwant, nOffers: a.nOffers, hasAnswer: a.hasAnswer }))
  R.trackerSide = annSummary(rv)
  // now ask for zero offers and force a re-announce via the discovery object
  await ev(A, () => { window.__want = 0; const t = lab.torrents['rv:c']; t.discovery.tracker.update() })
  await sleep(600)
  R.announcesAfterNumwant0 = (await ev(A, () => lab.announces)).slice(-2).map(a => ({ event: a.event, left: a.left, numwant: a.numwant, nOffers: a.nOffers }))
  await closeAll()
  return save('e8', R)
}

// e9: the same trick against the four live public trackers (2 local pages, private random infohash, ICE over loopback)
async function e9 (urls) {
  const R = { name: 'e9 live trackers', chromium: version, results: [] }
  for (const url of urls) {
    for (const kind of ['rv', 'seed']) {
      for (const mode of ['sim', 'stag']) {
        const A = await newPage(); const B = await newPage()
        await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
        const id = rvHex(`e9:${url}:${kind}:${mode}:${Date.now()}:${Math.random()}`)
        const join = p => kind === 'rv' ? ev(p, ([id, u]) => lab.joinRv('c', id, u, 't'), [id, url]) : ev(p, ([id, u]) => lab.seedText('c', id, u, 't'), [id, url])
        const t0 = Date.now()
        if (mode === 'sim') await Promise.all([join(A), join(B)]); else { await join(A); await sleep(600); await join(B) }
        const w = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('t') > 0, 15000, 50))))
        R.results.push({ url, kind, mode, connected: w[0].ok && w[1].ok, ms: w[0].ok && w[1].ok ? Date.now() - t0 - (mode === 'stag' ? 600 : 0) : null })
        await closeAll()
      }
    }
  }
  return save('e9', R)
}

// e10: is wire.peerId identical for the same remote client across two torrents (content + rendezvous)?
async function e10 () {
  const R = { name: 'e10 peerId across torrents', chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  const rv = rvHex('e10:' + Date.now())
  await Promise.all([A, B].map(p => ev(p, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])))
  await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0, 15000))))
  const ih = await ev(A, ([n, tr]) => lab.seedBytes('c', n, 'x.bin', tr, 'content'), [2 * MiB, TR])
  await sleep(700)
  await ev(B, ([ih, tr]) => lab.addMagnet('c', ih, tr, 'content'), [ih, TR])
  R.wait = await ev(A, () => lab.waitFor(() => lab.wireCount('content') > 0, 15000))
  R.clientPeerIds = { A: await ev(A, () => lab.clients.c.peerId), B: await ev(B, () => lab.clients.c.peerId) }
  R.wiresOnA = await ev(A, () => lab.wires.map(r => ({ tag: r.tag, type: r.wire.type, peerId: r.wire.peerId })))
  R.samePeerIdAcrossTorrents = R.wiresOnA.length === 2 && R.wiresOnA[0].peerId === R.wiresOnA[1].peerId
  await closeAll()
  return save('e10', R)
}

// e11: two visitors on DIFFERENT site versions (different content infohashes) meet only through the rendezvous infohash
async function e11 () {
  clearAnn()
  const R = { name: 'e11 version split healed by rendezvous swarm', chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  const chainId = 'host:example.test'; const rv = sha1hex('mw-ledger/1/' + chainId)
  const ihA = await ev(A, ([n, tr]) => lab.seedBytes('c', n, 'site-v1.bin', tr, 'siteA'), [1 * MiB, TR])
  const ihB = await ev(B, ([n, tr]) => lab.seedBytes('c', n + 1, 'site-v2.bin', tr, 'siteB'), [1 * MiB, TR])
  R.contentInfoHashes = { versionA: ihA, versionB: ihB, differ: ihA !== ihB }
  await sleep(1200) // let both content torrents announce; they are different swarms so nobody connects
  R.contentWiresBefore = { A: await ev(A, () => lab.wires.length), B: await ev(B, () => lab.wires.length) }
  const t0 = Date.now()
  await Promise.all([A, B].map(p => ev(p, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])))
  R.rvConnect = await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0, 15000))))
  R.wallMs = Date.now() - t0
  R.pingOverRv = await ev(A, () => lab.pingLoop('rv', 50, 1000, 64))
  R.rvInfoHash = rv
  await closeAll()
  return save('e11', R)
}

// e12: a hostile peer in a metadata-less swarm advertises metadata_size = 10 MB; does the honest side start fetching?
async function e12 (cancel) {
  const R = { name: 'e12 hostile metadata_size on a bare-infohash swarm', mitigation_wire_ut_metadata_cancel: !!cancel, chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => lab.mk('c'))))
  await ev(A, () => { lab.fakeMetaSize = 10000000 })
  await ev(B, c => { lab.countMetaReq = true; lab.cancelMeta = c }, !!cancel)
  const rv = rvHex('e12:' + Date.now() + cancel)
  await Promise.all([A, B].map(p => ev(p, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])))
  await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rv') > 0, 15000))))
  await sleep(2500)
  R.honestSide = await ev(B, () => { const w = lab.wires[0].wire; const um = w.ut_metadata; return { metadataRequestsSent: lab.metaReqs || 0, utMetadataSize: um._metadataSize, fetching: um._fetching, allocatedBytes: um.metadata ? um.metadata.length : 0, wireAlive: !w.destroyed } })
  await closeAll()
  return save('e12' + (cancel ? '-cancel' : ''), R)
}

async function e4 () {
  clearAnn()
  const R = { name: 'e4 client-global throttle vs ext frames', chromium: version }
  const A = await newPage(); const B = await newPage()
  await Promise.all([A, B].map(p => ev(p, () => { lab.mk('c'); lab.mk('g') })))
  const rv1 = rvHex('e4-c:' + Date.now()); const rv2 = rvHex('e4-g:' + Date.now())
  await Promise.all([A, B].map(p => ev(p, ([a, b, tr]) => { lab.joinRv('c', a, tr, 'rvc'); lab.joinRv('g', b, tr, 'rvg') }, [rv1, rv2, TR])))
  await Promise.all([A, B].map(p => ev(p, () => lab.waitFor(() => lab.wireCount('rvc') > 0 && lab.wireCount('rvg') > 0, 30000))))
  R.baseline = { rvc: await ev(A, () => lab.pingLoop('rvc', 100, 1000, 64)), rvg: await ev(A, () => lab.pingLoop('rvg', 100, 1000, 64)) }
  await ev(A, () => lab.throttle('c', 0))
  const [rvcFrozen, rvgFree] = await Promise.all([ev(A, () => lab.pingLoop('rvc', 100, 3000, 64, 500)), ev(A, () => lab.pingLoop('rvg', 100, 3000, 64, 500))])
  R.whileThrottleUpload0 = { rvc_sameClientAsThrottle: rvcFrozen, rvg_secondClient: rvgFree }
  const tRestore = Date.now()
  await ev(A, () => lab.throttle('c', -1))
  const resume = await ev(A, () => lab.waitFor(() => lab.pings.rvc.recv > 0, 5000, 20))
  R.resumeAfterRestoreMs = { waitForFirstDelayedPong: resume, wallMs: Date.now() - tRestore, rvcAfter: await ev(A, () => lab.summ('rvc')) }
  await closeAll()
  return save('e4', R)
}

async function e5 () {
  clearAnn()
  const R = { name: 'e5 maxConns enforcement for WebRTC peers', chromium: version, maxConnsOption: 2 }
  const N = 5; const pages = []
  for (let i = 0; i < N; i++) pages.push(await newPage())
  const rv = rvHex('e5:' + Date.now())
  await Promise.all(pages.map(p => ev(p, () => lab.mk('c', { maxConns: 2 }))))
  await Promise.all(pages.map(p => ev(p, ([rv, tr]) => lab.joinRv('c', rv, tr, 'rv'), [rv, TR])))
  await sleep(25000)
  R.wiresPerPage = await Promise.all(pages.map(p => ev(p, () => ({ wires: lab.wireCount('rv'), torrentNumPeers: lab.torrents['rv:c'].numPeers, clientMaxConns: lab.clients.c.maxConns }))))
  R.announcesPerPage0 = (await ev(pages[0], () => lab.announces)).map(a => ({ event: a.event, numwant: a.numwant, nOffers: a.nOffers, left: a.left })).slice(0, 8)
  await closeAll()
  return save('e5', R)
}

async function e6 () {
  if (!process.env.TRYSTERO_BUNDLE) throw new Error('set TRYSTERO_BUNDLE to an iife bundle exposing window.__trystero = {joinRoom, selfId}')
  clearAnn()
  const R = { name: 'e6 Trystero 0.26.0 torrent strategy vs local tracker', chromium: version }
  const A = await newPage(); const B = await newPage()
  const setup = async p => {
    await p.addScriptTag({ url: '/trystero.js' })
    await p.evaluate(() => {
      const t = window.__trystero; const log = (window.__tlog = [])
      window.__room = null; window.__rtts = { act: [], ping: [], bulk: [] }; window.__t0 = performance.now()
      window.__join = (tr, appId, roomId) => {
        const room = t.joinRoom({ appId, relayConfig: { urls: [tr] }, rtcConfig: { iceServers: [] }, trickleIce: false }, roomId)
        window.__room = room; window.__peers = []
        room.onPeerJoin = id => { window.__peers.push(id); log.push(['join', Math.round(performance.now() - window.__t0), id]) }
        room.onPeerLeave = id => log.push(['leave', Math.round(performance.now() - window.__t0), id])
        const act = room.makeAction('pp')
        act.onMessage = (d, { peerId }) => { if (d.k === 'ping') act.send({ k: 'pong', t: d.t, pad: d.pad }, { target: peerId }); else if (d.k === 'pong') window.__rtts.act.push(performance.now() - d.t) }
        window.__act = act
        const bulk = room.makeAction('bk'); window.__bulk = bulk; bulk.onMessage = (d) => { window.__bulkRecv = (window.__bulkRecv || 0) + (d.byteLength || 0) }
        return true
      }
    })
  }
  await setup(A); await setup(B)
  const roomId = 'room-' + Date.now()
  const tj = Date.now()
  await A.evaluate(([tr, r]) => window.__join(tr, 'mw-lab', r), [TR, roomId]); await B.evaluate(([tr, r]) => window.__join(tr, 'mw-lab', r), [TR, roomId])
  const w = await A.evaluate(() => new Promise(res => { const t0 = performance.now(); const h = setInterval(() => { if (window.__peers.length > 0) { clearInterval(h); res({ ok: true, ms: Math.round(performance.now() - t0) }) } else if (performance.now() - t0 > 40000) { clearInterval(h); res({ ok: false }) } }, 50) }))
  R.timeToPeerJoin = w; R.wallMs = Date.now() - tj
  R.tlogA = await A.evaluate(() => window.__tlog)
  R.announcesPageA = (await A.evaluate(() => lab.announces)).map(a => ({ t: a.t, event: a.event ?? '<absent>', left: a.left, numwant: a.numwant, nOffers: a.nOffers, hasAnswer: a.hasAnswer, ihLen: a.ih ? a.ih.length / 2 : null })).slice(0, 8)
  R.trackerSideEvents = announceLog.slice(0, 12)
  if (w.ok) {
    // action ping/pong idle
    const stats = arr => { const a = arr.slice().sort((x, y) => x - y); const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return { n: a.length, p50: Math.round(q(0.5) * 10) / 10, p90: Math.round(q(0.9) * 10) / 10, p99: Math.round(q(0.99) * 10) / 10, max: Math.round(a[a.length - 1] * 10) / 10 } }
    await A.evaluate(() => new Promise(res => { let n = 0; window.__rtts.act = []; const h = setInterval(() => { window.__act.send({ k: 'ping', t: performance.now(), pad: 'x'.repeat(40) }); if (++n >= 150) { clearInterval(h); setTimeout(res, 800) } }, 20) }))
    R.actionRttIdleMs = stats(await A.evaluate(() => window.__rtts.act))
    const pr = await A.evaluate(async () => { const id = window.__peers[0]; const v = []; for (let i = 0; i < 20; i++) v.push(await window.__room.ping(id)); return v })
    R.roomPingMs = stats(pr)
    // bulk 128 MiB binary action while small pings flow
    await A.evaluate(() => { window.__rtts.act = [] })
    const bulkP = A.evaluate(async () => { const buf = new Uint8Array(128 * 1024 * 1024); const t0 = performance.now(); await window.__bulk.send(buf); return performance.now() - t0 })
    await sleep(400)
    const pingDuring = A.evaluate(() => new Promise(res => { let n = 0; const h = setInterval(() => { window.__act.send({ k: 'ping', t: performance.now(), pad: 'x'.repeat(40) }); if (++n >= 400) { clearInterval(h); setTimeout(res, 1500) } }, 10) }))
    await pingDuring
    R.actionRttDuringBulkMs = stats(await A.evaluate(() => window.__rtts.act))
    R.bulkSendMs = Math.round(await bulkP)
    await sleep(4000)
    R.bulkRecvBytesB = await B.evaluate(() => window.__bulkRecv || 0)
  }
  await closeAll()
  return save('e6', R)
}

// ---------------------------------------------------------------------------------------------------------------
const want = process.argv.slice(2); const all = {}
try {
  for (const w of want) {
    console.log('== running', w)
    if (w === 'e1') all.e1 = await e1(0)
    else if (w === 'e1soak') all.e1soak = await e1(140)
    else if (w === 'e2') all.e2 = await e2()
    else if (w.startsWith('e1x')) { const [, kind, mode, n] = w.split(':'); all[w] = await glare(kind, mode, Number(n || 15)) }
    else if (w.startsWith('e3')) { let r; for (let k = 0; k < 4; k++) { r = await e3(w.split(':').slice(1).join(':') || 'off'); if (!r.retryNeeded) break; console.log('retry', w, k + 1) } all[w] = r }
    else if (w === 'e4') all.e4 = await e4()
    else if (w === 'diag') all.diag = await diag()
    else if (w === 'e7') all.e7 = await e7()
    else if (w === 'e8') all.e8 = await e8()
    else if (w === 'e10') all.e10 = await e10()
    else if (w === 'e11') all.e11 = await e11()
    else if (w === 'e12') all.e12 = await e12(false)
    else if (w === 'e12c') all.e12c = await e12(true)
    else if (w.startsWith('e9')) all.e9 = await e9(process.env.E9_URLS.split(','))
    else if (w === 'e5') all.e5 = await e5()
    else if (w === 'e6') all.e6 = await e6()
    console.log(JSON.stringify(all[w] ?? all[Object.keys(all).pop()], null, 1).slice(0, 6000))
  }
} catch (e) { console.error('LAB FAILURE', e && e.stack || e) } finally {
  await closeAll(); await browser.close(); tracker.close(); web.close()
  process.exit(0)
}
