// child process for d2: a stock bittorrent-tracker 11.2.3 WS-only server that prints one JSON stats line per second.
import Server from 'bittorrent-tracker/server'
const s = new Server({ udp: false, http: false, ws: true, stats: false })
s.on('warning', () => {}); s.on('error', e => console.error('err', e.message))
s.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: s.http.address().port, node: process.version, pid: process.pid }))
  let last = process.cpuUsage()
  setInterval(() => {
    const m = process.memoryUsage(); const c = process.cpuUsage(last); last = process.cpuUsage()
    console.log(JSON.stringify({ t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, external: m.external, cpuMs: Math.round((c.user + c.system) / 1000), swarms: Object.keys(s.torrents).length }))
  }, 1000)
})
