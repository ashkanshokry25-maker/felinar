// Experiment: can a sandbox="allow-scripts" (opaque origin) frame, fed via srcdoc + blob: URLs + MessageChannel,
// host a multi-file static site while being isolated from the loader origin? Time-boxed, local only.
import http from 'node:http'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'

const log = []
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  log.push(`${req.method} ${u.pathname} origin=${req.headers.origin || '-'} sec-fetch-site=${req.headers['sec-fetch-site'] || '-'} dest=${req.headers['sec-fetch-dest'] || '-'}`)
  if (u.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(HOST) }
  if (u.pathname === '/data.json') { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true,"from":"network"}') }       // NO CORS headers on purpose
  if (u.pathname === '/data-cors.json') { res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*'); return res.end('{"ok":true,"from":"network-cors"}') }
  if (u.pathname === '/about.html') { res.setHeader('content-type', 'text/html'); return res.end('<h1 id=net>NETWORK about.html (static host SPA fallback would be the loader shell)</h1>') }
  res.statusCode = 404; res.end('nf')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const HOST = `<!doctype html><meta charset=utf-8><title>host</title><body>
<script>
  // secrets that an isolated site must NOT be able to touch
  localStorage.setItem('loader-secret', 'S3CR3T');
  document.cookie = 'sid=abc; path=/';
  window.results = {};
  window.addEventListener('message', (e) => { (window.msgs ||= []).push({ origin: e.origin, sameSource: e.source === window.frames[0], data: e.data }) });
  window.run = async () => {
    const js = URL.createObjectURL(new Blob(['window.__blobScript = "ran"; parent.postMessage({kind:"blobScript"}, "*")'], { type: 'text/javascript' }));
    const mod = URL.createObjectURL(new Blob(['export const x = 42; import("./sibling.js").catch(e => { window.__sibErr = String(e) })'], { type: 'text/javascript' }));
    const css = URL.createObjectURL(new Blob(['#styled{color:rgb(1,2,3)}'], { type: 'text/css' }));
    const png = URL.createObjectURL(new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))], { type: 'image/png' }));
    const html = '<!doctype html><meta charset=utf-8><link rel=stylesheet href="' + css + '"><body><div id=styled>hello</div><img id=im src="' + png + '"><a id=lnk href="about.html">about</a>' +
      '<script src="' + js + '"><\\/script>' +
      '<script type=module src="' + mod + '"><\\/script>' +
      '<script>(async()=>{const r={};' +
      'try{r.parentDoc=String(parent.document.title)}catch(e){r.parentDoc="ERR:"+e.name}' +
      'try{r.localStorage=String(localStorage.getItem("loader-secret"))}catch(e){r.localStorage="ERR:"+e.name}' +
      'try{r.cookie=document.cookie||"(empty)"}catch(e){r.cookie="ERR:"+e.name}' +
      'try{const db=await new Promise((ok,no)=>{const q=indexedDB.open("x");q.onsuccess=()=>ok("opened");q.onerror=()=>no(q.error)});r.indexedDB=db}catch(e){r.indexedDB="ERR:"+(e.name||e)}' +
      'r.origin=String(location.origin);r.href=location.href;r.baseURI=document.baseURI;r.isSecureContext=isSecureContext;' +
      'try{r.fetchBlob=await (await fetch("' + js + '")).text().then(t=>"ok:"+t.length)}catch(e){r.fetchBlob="ERR:"+e.name}' +
      'try{r.fetchRelNoCors=await fetch("/data.json").then(x=>x.text())}catch(e){r.fetchRelNoCors="ERR:"+e.name+":"+e.message}' +
      'try{r.fetchRelCors=await fetch("/data-cors.json").then(x=>x.text())}catch(e){r.fetchRelCors="ERR:"+e.name}' +
      'try{r.nav=typeof navigator.serviceWorker}catch(e){r.nav="ERR:"+e.name}' +
      'r.imgOk=document.getElementById("im").naturalWidth;r.cssColor=getComputedStyle(document.getElementById("styled")).color;' +
      'parent.postMessage({kind:"results",r},"*")})()<\\/script>';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');   // NO allow-same-origin => opaque origin
    f.srcdoc = html;
    document.body.appendChild(f);
  };
</script>`

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.on('console', m => log.push('console: ' + m.text()))
await page.goto(`http://127.0.0.1:${port}/`)
await page.evaluate(() => window.run())
await page.waitForFunction(() => (window.msgs || []).some(m => m.data && m.data.kind === 'results'), null, { timeout: 15000 })
await page.waitForTimeout(500)
const out = await page.evaluate(() => ({ msgs: window.msgs }))
const results = out.msgs.find(m => m.data.kind === 'results')
console.log('Browser:', browser.version())
console.log('postMessage seen by parent -> origin:', JSON.stringify(results.origin), '| event.source === iframe.contentWindow:', results.sameSource)
console.log('Frame-side results:', JSON.stringify(results.data.r, null, 1))
console.log('blobScript ran (kind=blobScript message received):', out.msgs.some(m => m.data.kind === 'blobScript'))

// Now click the relative link inside the sandboxed frame and see what the frame navigates to (network, not SW).
const frame = page.frames().find(f => f !== page.mainFrame())
const before = log.length
await frame.evaluate(() => document.getElementById('lnk').click())
await page.waitForTimeout(800)
const frame2 = page.frames().find(f => f !== page.mainFrame())
console.log('After clicking relative link: frame url =', frame2.url())
console.log('Server saw:', log.slice(before).filter(l => l.startsWith('GET')).join(' || '))
console.log('Server log (network requests):'); console.log(log.filter(l => !l.startsWith('console')).join('\n'))
await browser.close(); server.close()
