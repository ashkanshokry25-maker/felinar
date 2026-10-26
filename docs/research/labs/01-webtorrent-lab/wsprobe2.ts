// announce-style probe (numwant 0, then stopped) to see whether a tracker speaks the WebTorrent announce protocol
const urls = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']
const bin = (n: number) => String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))
for (const url of urls) {
  const r = await new Promise<string>(resolve => {
    const t0 = performance.now(); const infoHash = bin(20), peerId = bin(20)
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { try { ws.close() } catch (_) {} resolve('TIMEOUT') }, 12000)
    ws.onopen = () => ws.send(JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: peerId, numwant: 0, uploaded: 0, downloaded: 0, left: 1, event: 'started', offers: [] }))
    ws.onmessage = (e) => { clearTimeout(timer); try { ws.send(JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: peerId, numwant: 0, uploaded: 0, downloaded: 0, left: 1, event: 'stopped' })) } catch (_) {} resolve('reply: ' + String(e.data).slice(0, 160).replace(/[^\x20-\x7e]/g, '?') + ` (${Math.round(performance.now() - t0)}ms)`); setTimeout(() => ws.close(), 200) }
    ws.onerror = (e) => { clearTimeout(timer); resolve('ERROR ' + ((e as ErrorEvent).message || '')) }
    ws.onclose = (e) => { clearTimeout(timer); resolve(`CLOSED code=${e.code} reason=${e.reason}`) }
  })
  console.log(url, '=>', r)
}
