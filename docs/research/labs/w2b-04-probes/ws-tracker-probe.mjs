// w2b-04 probe: WebSocket tracker liveness. Node >= 22 (global WebSocket). No offers are created, so nothing is relayed to any peer.
//  - wsAnnounce: connect + announce(random infohash, numwant 0, offers []) + 'stopped'  -> the LIVENESS test (also logs complete/incomplete/interval)
//  - wsScrape  : connect + scrape(random infohash)                                      -> NOT a liveness test: tracker.openwebtorrent.com closes the socket on scrape
// Note: Node's WebSocket cannot set an Origin header, so origin-allowlisted trackers (tracker.files.fm:7073) cannot be probed this way.
// Run: node ws-tracker-probe.mjs [wss://tracker.example ...]
import { randomBytes } from 'node:crypto'

function probe (url, timeoutMs, onOpen, onMessage) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let ws; let opened = null; let settled = false
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { ws && ws.close() } catch {} ; resolve({ url, ...r }) }
    const timer = setTimeout(() => done({ ok: false, error: opened ? 'no-reply' : 'connect-timeout', connectMs: opened }), timeoutMs)
    try { ws = new WebSocket(url) } catch (e) { return done({ ok: false, error: 'ctor:' + e.message }) }
    ws.addEventListener('open', () => { opened = Math.round(performance.now() - t0); onOpen(ws) })
    ws.addEventListener('message', (ev) => {
      let j; try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch { return done({ ok: false, error: 'bad-json', connectMs: opened }) }
      done({ connectMs: opened, replyMs: Math.round(performance.now() - t0), ...onMessage(j, ws) })
    })
    // The browser/undici hides the reason (WHATWG WebSockets: UAs must not convey failure info to scripts).
    ws.addEventListener('error', () => done({ ok: false, error: opened ? 'ws-error-after-open' : 'ws-error', connectMs: opened }))
    ws.addEventListener('close', (ev) => done({ ok: false, error: 'closed:' + ev.code, connectMs: opened }))
  })
}

export function wsAnnounce (url, timeoutMs = 6000) {
  const ih = randomBytes(20).toString('latin1') // binary string, as the WS tracker protocol expects
  const pid = ('-MWC001-' + randomBytes(6).toString('hex')).slice(0, 20)
  const base = { action: 'announce', info_hash: ih, peer_id: pid, uploaded: 0, downloaded: 0, left: 1, numwant: 0, offers: [] }
  return probe(url, timeoutMs,
    (ws) => ws.send(JSON.stringify({ ...base, event: 'started' })),
    (j, ws) => {
      try { ws.send(JSON.stringify({ ...base, event: 'stopped' })) } catch {}
      return { ok: j.action === 'announce' && !j['failure reason'], interval: j.interval ?? null, complete: j.complete ?? null, incomplete: j.incomplete ?? null, failure: j['failure reason'] || null }
    })
}

export function wsScrape (url, timeoutMs = 6000) {
  const ih = randomBytes(20).toString('latin1')
  return probe(url, timeoutMs, (ws) => ws.send(JSON.stringify({ action: 'scrape', info_hash: ih })), (j) => ({ ok: j.action === 'scrape' && !!j.files }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = process.argv.slice(2).length ? process.argv.slice(2) : ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com', 'wss://open.ftorrent.com', 'wss://tracker.novage.com.ua', 'wss://tracker.btorrent.xyz']
  for (const u of list) console.log(JSON.stringify({ announce: await wsAnnounce(u), scrape: await wsScrape(u) }))
}
