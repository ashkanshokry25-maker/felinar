// Liveness probe for public WebTorrent WebSocket trackers using a SCRAPE request (does not register as a peer).
const urls = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz', 'wss://tracker.files.fm:7073/announce', 'wss://tracker.fastcast.nz', 'wss://tracker.novage.com.ua:443/announce', 'wss://tracker.webtorrent.io']
const infoHash = String.fromCharCode(...crypto.getRandomValues(new Uint8Array(20)))
const probe = (url: string) => new Promise<string>(resolve => {
  const t0 = performance.now(); let opened = -1
  let ws: WebSocket
  try { ws = new WebSocket(url) } catch (e) { return resolve(`${url}  constructor error: ${e}`) }
  const done = (msg: string) => { try { ws.close() } catch (_) {} resolve(`${url}  ${msg}  [open=${opened < 0 ? 'never' : Math.round(opened) + 'ms'}, total=${Math.round(performance.now() - t0)}ms]`) }
  const timer = setTimeout(() => done('TIMEOUT 12s (no reply)'), 12000)
  ws.onopen = () => { opened = performance.now() - t0; ws.send(JSON.stringify({ action: 'scrape', info_hash: infoHash })) }
  ws.onmessage = (e) => { clearTimeout(timer); done('reply: ' + String(e.data).slice(0, 120).replace(/[^\x20-\x7e]/g, '?')) }
  ws.onerror = (e) => { clearTimeout(timer); done('ERROR ' + ((e as ErrorEvent).message || 'ws error')) }
  ws.onclose = (e) => { clearTimeout(timer); done(`CLOSED code=${e.code} reason=${e.reason}`) }
})
for (const u of urls) console.log(await probe(u))
