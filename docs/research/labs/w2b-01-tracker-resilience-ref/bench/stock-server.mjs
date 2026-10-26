// The stock bittorrent-tracker 11.2.3 server configured like `bittorrent-tracker --ws` (CLI defaults) for benchmarking.
import Server from 'bittorrent-tracker/server'
const server = new Server({ udp: false, http: false, ws: true, stats: process.env.STATS === '1', interval: 600000 })
server.on('error', (e) => console.error('error', e.message))
server.on('warning', () => {})
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({ msg: 'listening', port: server.http.address().port })))
