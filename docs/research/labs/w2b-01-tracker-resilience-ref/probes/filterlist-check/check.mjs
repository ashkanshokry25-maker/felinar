// usage: node check.mjs <list files...>      (npm ci first; lists: sh fetch-lists.sh <dir>)
// Evaluates the URLs below against the given ADBlock-syntax lists with @ghostery/adblocker (a third-party engine, not uBO's or Brave's own).
// Edit `urls` to the hostnames in src/loader/config.js. Output: 'allowed' | 'BLOCKED' (+ the matching rule) | 'EXCEPTION(allow)' per URL.
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { readFileSync } from 'node:fs'
const dir = ''
const files = process.argv.slice(2)
const urls = [
  ['websocket','wss://tracker.openwebtorrent.com/'],
  ['websocket','wss://tracker.webtorrent.dev/'],
  ['websocket','wss://open.ftorrent.com/'],
  ['websocket','wss://tracker.novage.com.ua/'],
  ['websocket','wss://tracker.btorrent.xyz/'],
  ['websocket','wss://tracker.files.fm:7073/announce'],
  ['websocket','wss://tracker.example-site.org/'],
  ['websocket','wss://tracker.example-site.org/announce'],
  ['websocket','wss://rtc.example-site.org/'],
  ['websocket','wss://signal.example-site.org/'],
  ['websocket','wss://t.example-site.org/'],
  ['websocket','wss://stats.example-site.org/'],
  ['websocket','wss://analytics.example-site.org/'],
  ['websocket','wss://nos.lol/'],
  ['websocket','wss://relay.damus.io/'],
  ['websocket','wss://relay.primal.net/'],
  ['websocket','wss://broker.emqx.io:8084/mqtt'],
  ['websocket','wss://broker.hivemq.com:8884/mqtt'],
  ['websocket','wss://test.mosquitto.org:8081/mqtt'],
  ['websocket','wss://public:public@public.cloud.shiftr.io/'],
  ['xmlhttprequest','https://cloudflare-dns.com/dns-query?name=_magnet.example.com&type=TXT'],
  ['xmlhttprequest','https://dns.google/resolve?name=_magnet.example.com&type=TXT'],
  ['xmlhttprequest','https://tracker.openwebtorrent.com/stats.json'],
]
const text = files.map(f => readFileSync(f, 'utf8')).join('\n')
const engine = FiltersEngine.parse(text, { loadCosmeticFilters: false, loadNetworkFilters: true })
for (const src of ['https://example.com/']) {
  for (const [type, url] of urls) {
    const req = Request.fromRawDetails({ url, sourceUrl: src, type })
    const r = engine.match(req)
    const flag = r.exception ? 'EXCEPTION(allow)' : (r.match ? 'BLOCKED' : 'allowed')
    console.log(`${flag.padEnd(17)} ${type.padEnd(15)} ${url}` + (r.filter ? `   <= ${r.filter.toString()}` : '') + (r.exception ? `   exception: ${r.exception.toString()}` : ''))
  }
}
