// Stock server, no uncaughtException handler (what `bittorrent-tracker --ws` does): does one bad message kill the process?
import Server from 'bittorrent-tracker/server'
import WebSocket from 'ws'
const bin = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('')
const server = new Server({ udp: false, http: false, stats: false, ws: true })
server.on('warning', () => {}); server.on('error', console.error)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `ws://127.0.0.1:${server.ws.address().port}`
const ih = bin(20)
const open = () => new Promise((res) => { const w = new WebSocket(url); w.on('open', () => res(w)) })
const a = await open(); const b = await open()
const ann = (peer, extra) => JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peer, uploaded: 0, downloaded: 0, left: 1, event: 'started', ...extra })
a.send(ann(bin(20), { numwant: 0, offers: [] }))
await new Promise((r) => setTimeout(r, 200))
b.send(ann(bin(20), { numwant: 1, offers: [null] }))
await new Promise((r) => setTimeout(r, 1000))
console.log('STILL ALIVE after malformed announce')
process.exit(0)
