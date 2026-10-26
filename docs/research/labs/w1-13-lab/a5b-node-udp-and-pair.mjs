// w1-13 A5b: is raw UDP between two Node sockets on the LAN IP possible here, and do two node-datachannel peers connect?
import dgram from 'node:dgram'
import { RTCPeerConnection } from 'node-datachannel/polyfill'
const out = {}
// raw UDP on loopback and on the LAN address
for (const addr of ['127.0.0.1', '192.168.18.5']) {
  out['udp ' + addr] = await new Promise(resolve => {
    const a = dgram.createSocket('udp4'), b = dgram.createSocket('udp4')
    const t = setTimeout(() => { a.close(); b.close(); resolve('TIMEOUT (no datagram received)') }, 3000)
    b.on('message', m => { clearTimeout(t); a.close(); b.close(); resolve('ok: ' + m) })
    b.on('error', e => { clearTimeout(t); resolve('b error ' + e.message) })
    a.on('error', e => { clearTimeout(t); resolve('a error ' + e.message) })
    b.bind(0, addr, () => { a.send('hi', b.address().port, addr, err => err && resolve('send error ' + err.message)) })
  })
}
// two node-datachannel peers, host candidates only
const wait = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res()) })
const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
const dc = a.createDataChannel('x'); let echoed = null
b.ondatachannel = e => { e.channel.onmessage = m => e.channel.send('echo:' + m.data) }
dc.onopen = () => dc.send('ping'); dc.onmessage = e => { echoed = e.data }
await a.setLocalDescription(await a.createOffer()); await wait(a)
await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await wait(b)
await a.setRemoteDescription(b.localDescription)
const t0 = Date.now(); while (!echoed && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 100))
out.nodeToNode = { echoed, ms: echoed ? Date.now() - t0 : null, aState: a.connectionState, bState: b.connectionState }
console.log(JSON.stringify(out, null, 1)); process.exit(0)
