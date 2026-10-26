// What does the engine's own URL serializer do to a magnet link before the handler template step (step: "serialization of inputURL")?
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const raw = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=My Site "q" `b` café \u{1F600}&tr=wss%3A%2F%2Ftracker.example%3A443%2Fannounce%3Fkey%3Da%26b%3Dc&x=a+b'
for (const [n, bt] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await bt.launch(); const p = await (await b.newContext()).newPage(); await p.goto('about:blank')
  const r = await p.evaluate((raw) => { const a = document.createElement('a'); a.href = raw; return { href: a.href, urlHref: new URL(raw).href } }, raw)
  console.log(n, b.version()); console.log('  raw        :', raw); console.log('  a.href     :', r.href); console.log('  same as new URL():', r.href === r.urlHref)
  console.log('  expected fragment after template "/#%s" = encodeURIComponent(a.href):'); console.log('   ', '#' + encodeURIComponent(r.href))
  await b.close()
}
