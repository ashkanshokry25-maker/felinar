// Local WebSocket tracker (official bittorrent-tracker server) bound to 127.0.0.1 only.
import Server from 'npm:bittorrent-tracker@11.2.3/server'
const server = new Server({ udp: false, http: false, ws: true, stats: false })
server.on('error', (e: Error) => console.error('tracker error:', e.message))
server.on('warning', (e: Error) => console.error('tracker warning:', e.message))
server.on('start', (addr: string) => console.log('announce from', addr))
server.listen(18082, '127.0.0.1', () => console.log('tracker listening ws://127.0.0.1:18082'))
