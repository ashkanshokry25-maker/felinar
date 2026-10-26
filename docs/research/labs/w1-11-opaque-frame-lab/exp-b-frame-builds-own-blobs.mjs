// Variant B: parent posts file bytes to the opaque-origin frame; the FRAME builds its own blob: URLs.
import http from 'node:http'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(HOST) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const HOST = `<!doctype html><meta charset=utf-8><body><script>
window.msgs = [];
window.addEventListener('message', e => window.msgs.push({ origin: e.origin, data: e.data }));
window.run = () => {
  const frameHtml = '<!doctype html><meta charset=utf-8><body><div id=styled>hello</div><img id=im><script>' +
   'window.addEventListener("message", async (e) => { if (!e.data || e.data.t !== "files") return; const port = e.ports[0]; const F = e.data.files; const r = {};' +
   'const mk = (b, type) => URL.createObjectURL(new Blob([b], { type }));' +
   'const css = mk(F.css, "text/css"); const l = document.createElement("link"); l.rel="stylesheet"; l.href=css; document.head.appendChild(l);' +
   'const png = mk(F.png, "image/png"); const im = document.getElementById("im"); im.src = png; await im.decode().catch(()=>{});' +
   'const js = mk(F.js, "text/javascript"); await new Promise(ok => { const s = document.createElement("script"); s.src = js; s.onload = ok; s.onerror = () => { r.scriptErr = true; ok() }; document.head.appendChild(s) });' +
   'const mod = mk(F.mod, "text/javascript"); try { const m = await import(mod); r.moduleX = m.x } catch (err) { r.moduleErr = String(err) }' +
   'const modRel = mk(F.modRel, "text/javascript"); try { await import(modRel); r.relImport = "ok" } catch (err) { r.relImport = "ERR:" + err.name }' +
   'try { r.fetchOwnBlob = await (await fetch(js)).text().then(t => "ok:" + t.length) } catch (err) { r.fetchOwnBlob = "ERR:" + err.name }' +
   'r.cssColor = getComputedStyle(document.getElementById("styled")).color; r.imgW = im.naturalWidth; r.scriptRan = window.__s === "ran"; r.origin = location.origin;' +
   'try { localStorage.getItem("x"); r.ls = "ok" } catch (err) { r.ls = "ERR:" + err.name }' +
   'port.postMessage({ r }) }); parent.postMessage({ t: "ready" }, "*")<\\/script>';
  const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.srcdoc = frameHtml; document.body.appendChild(f);
  window.addEventListener('message', (e) => { if (e.data && e.data.t === 'ready') {
    const ch = new MessageChannel();
    ch.port1.onmessage = (m) => { window.final = m.data.r };
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    f.contentWindow.postMessage({ t: 'files', files: { css: '#styled{color:rgb(1,2,3)}', png, js: 'window.__s="ran"', mod: 'export const x = 42', modRel: 'import "./sibling.js"' } }, '*', [ch.port2]);
  } });
};
</script>`
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
await page.goto(`http://127.0.0.1:${port}/`)
await page.evaluate(() => window.run())
await page.waitForFunction(() => window.final, null, { timeout: 15000 })
console.log('Browser', browser.version(), '\nVariant B (frame builds own blob URLs from postMessage bytes):\n', JSON.stringify(await page.evaluate(() => window.final), null, 1))
await browser.close(); server.close()
