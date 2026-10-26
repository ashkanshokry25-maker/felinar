// Does the stock server leave ghost peers when one socket announces several swarms with different peer ids and then closes?
import Server from 'bittorrent-tracker/server'
import WebSocket from 'ws'
const bin = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('')
const server = new Server({ udp: false, http: false, stats: false, ws: true })
server.on('warning', () => {}); server.on('error', console.error)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const w = await new Promise((res) => { const s = new WebSocket(`ws://127.0.0.1:${server.ws.address().port}`); s.on('open', () => res(s)) })
for (let i = 0; i < 5; i++) w.send(JSON.stringify({ action: 'announce', info_hash: bin(20), peer_id: bin(20), left: 1, event: 'started', numwant: 0, offers: [] }))
await new Promise((r) => setTimeout(r, 300))
const count = () => Object.values(server.torrents).reduce((n, s) => n + s.peers.length, 0)
console.log('peers while connected:', count(), 'swarms:', Object.keys(server.torrents).length)
w.close(); await new Promise((r) => setTimeout(r, 500))
console.log('peers after the socket closed:', count(), 'swarms:', Object.keys(server.torrents).length)
process.exit(0)
