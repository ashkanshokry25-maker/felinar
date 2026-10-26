const q = new URLSearchParams(location.search)
const kind = q.get('kind')
const rep = (o) => navigator.sendBeacon('/__report', JSON.stringify({ kind, ...o, t: Date.now() }))
addEventListener('pageshow', (e) => rep({ ev: 'pageshow', persisted: e.persisted }))
addEventListener('pagehide', (e) => rep({ ev: 'pagehide', persisted: e.persisted }))
let keep = {}
// Negotiate a loopback pair (offer/answer WITH candidates, non-trickle like WebTorrent) but do NOT wait for ICE to connect.
async function negotiate () {
  const pc1 = new RTCPeerConnection(); const pc2 = new RTCPeerConnection()
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate)
  const dc = pc1.createDataChannel('x')
  pc1.oniceconnectionstatechange = () => rep({ ev: 'ice1:' + pc1.iceConnectionState })
  dc.onopen = () => rep({ ev: 'dc-open' })
  await pc1.setLocalDescription(await pc1.createOffer()); await pc2.setRemoteDescription(pc1.localDescription)
  await pc2.setLocalDescription(await pc2.createAnswer()); await pc1.setRemoteDescription(pc2.localDescription)
  keep = { pc1, pc2, dc }
  await new Promise((r) => setTimeout(r, 700))
  rep({ ev: 'negotiated', ice1: pc1.iceConnectionState })
}
async function loopbackRTC () {
  const pc1 = new RTCPeerConnection(); const pc2 = new RTCPeerConnection()
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate)
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate)
  const dc = pc1.createDataChannel('x'); const open = new Promise((r) => (dc.onopen = () => { rep({ ev: 'dc-open' }); r() }))
  pc1.oniceconnectionstatechange = () => rep({ ev: 'ice1:' + pc1.iceConnectionState })
  pc1.onconnectionstatechange = () => rep({ ev: 'conn1:' + pc1.connectionState })
  await pc1.setLocalDescription(await pc1.createOffer()); await pc2.setRemoteDescription(pc1.localDescription)
  await pc2.setLocalDescription(await pc2.createAnswer()); await pc1.setRemoteDescription(pc2.localDescription)
  await open
  keep = { pc1, pc2, dc }
}
;(async () => {
  switch (kind) {
    case 'base': break
    case 'ws-open': keep.ws = new WebSocket(q.get('ws')); await new Promise((r) => (keep.ws.onopen = r)); break
    case 'ws-closed': keep.ws = new WebSocket(q.get('ws')); await new Promise((r) => (keep.ws.onopen = r)); addEventListener('pagehide', () => keep.ws.close()); break
    case 'INVALID-rtc-open': await loopbackRTC(); break
    case 'INVALID-rtc-closed': await loopbackRTC(); addEventListener('pagehide', () => { keep.pc1.close(); keep.pc2.close() }); break
    case 'INVALID-rtc-closed-then-reopen-ok': await loopbackRTC(); addEventListener('pagehide', () => { keep.pc1.close(); keep.pc2.close() }); break
    case 'rtc-created-only': keep.pc = new RTCPeerConnection(); break
    case 'rtc-created-closed-early': keep.pc = new RTCPeerConnection(); keep.pc.close(); break
    case 'INVALID-rtc-open-then-closed-early': await loopbackRTC(); keep.pc1.close(); keep.pc2.close(); await new Promise((r) => setTimeout(r, 800)); break
    case 'INVALID-rtc-dc-only-closed-early': { await loopbackRTC(); keep.dc.close(); await new Promise((r) => setTimeout(r, 800)); break }
    case 'rtc-offer-pending': { const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer()); keep.pc = pc; await new Promise((r) => setTimeout(r, 1200)); break }
    case 'rtc-offer-pending-closed': { const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer()); keep.pc = pc; addEventListener('pagehide', () => pc.close()); await new Promise((r) => setTimeout(r, 1200)); break }
    case 'INVALID-rtc-close-drop': { await loopbackRTC(); const { pc1, pc2 } = keep; pc1.close(); pc2.close(); keep = {}; await new Promise((r) => setTimeout(r, 3000)); break }
    case 'INVALID-rtc-close-drop-gc': { await loopbackRTC(); let { pc1, pc2 } = keep; pc1.close(); pc2.close(); pc1 = pc2 = null; keep = {}; await new Promise((r) => setTimeout(r, 500)); if (typeof gc === 'function') { gc(); await new Promise((r) => setTimeout(r, 300)); gc(); rep({ ev: 'gc-called' }) } await new Promise((r) => setTimeout(r, 1500)); break }
    case 'neg-open': await negotiate(); break
    case 'neg-closed-pagehide': await negotiate(); addEventListener('pagehide', () => { keep.pc1.close(); keep.pc2.close() }); break
    case 'neg-closed-early': await negotiate(); keep.pc1.close(); keep.pc2.close(); await new Promise((r) => setTimeout(r, 800)); break
    case 'neg-close-drop': { await negotiate(); const { pc1, pc2 } = keep; pc1.close(); pc2.close(); keep = {}; await new Promise((r) => setTimeout(r, 3000)); break }
    case 'neg-close-drop-gc': { await negotiate(); let { pc1, pc2 } = keep; pc1.close(); pc2.close(); pc1 = pc2 = null; keep = {}; await new Promise((r) => setTimeout(r, 500)); if (typeof gc === 'function') { gc(); await new Promise((r) => setTimeout(r, 300)); gc(); rep({ ev: 'gc-called' }) } await new Promise((r) => setTimeout(r, 1500)); break }
    case 'neg-first-pc-only-offer-answer-no-candidates': break
    case 'lock': await new Promise((r) => navigator.locks.request('mw', () => { r(); return new Promise(() => {}) })); break
    case 'idb-open': keep.db = await new Promise((res, rej) => { const r = indexedDB.open('bf', 1); r.onsuccess = () => res(r.result); r.onerror = rej }); break
    case 'sw': await navigator.serviceWorker.register('/site/sw-passthrough.js', { scope: '/' }).catch(() => {}); await navigator.serviceWorker.ready; break
  }
  rep({ ev: 'ready' })
})()
