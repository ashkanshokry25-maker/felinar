// w2a-08 lab server: a "static host" (shell fallback, 405 on POST, /__site fixtures behind the SW)
// plus a second origin ("ext") for cross-origin navigation, popup and form tests.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.bin': 'application/octet-stream' }

export const defaults = {
  sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation', // ARCH 7.2 as written
  allow: 'fullscreen; clipboard-write; picture-in-picture',
  mirror: 'load',            // none | load | full
  hostFallbackStatus: 404,   // status the "static host" gives to the shell for unknown paths
  injectAgent: false,
  nonHtmlDirect: false,      // SW serves non-HTML top-level navigations directly instead of the shell
  passHash: true,
  frameTitle: 'Site content',
  shellViewport: 'width=device-width, initial-scale=1',
  shellExtraHead: '',
  shellCss: '',
  shellCsp: '',
  shellBodyExtra: '',
  frameStyle: 'position:fixed;inset:0;width:100%;height:100%;border:0',
  focusOnLoad: false
}

export function startLab () {
  const state = { cfg: { ...defaults }, log: [] }
  let extPort = 0

  const siteFile = (rel) => {
    const f = path.join(here, 'site', rel)
    if (!f.startsWith(path.join(here, 'site'))) return null
    try { return fs.readFileSync(f) } catch { return null }
  }
  const labFile = (rel) => { try { return fs.readFileSync(path.join(here, rel)) } catch { return null } }

  const shellHtml = () => {
    const c = state.cfg
    const sandboxAttr = c.sandbox === null ? '' : ` sandbox="${c.sandbox}"`
    const allowAttr = c.allow ? ` allow="${c.allow}"` : ''
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${c.shellViewport ? `<meta name="viewport" content="${c.shellViewport}">` : ''}
${c.shellCsp ? `<meta http-equiv="Content-Security-Policy" content="${c.shellCsp}">` : ''}
<title>shell</title>
<style>html,body{margin:0;height:100%;overflow:hidden}${c.shellCss}</style>
${c.shellExtraHead}
<script src="/__cfg.js"></script>
<script src="/_mw/shell.js"></script></head><body>${c.shellBodyExtra}</body></html>`
  }

  const mainServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    const rec = { t: Date.now(), method: req.method, url: req.url, dest: req.headers['sec-fetch-dest'], mode: req.headers['sec-fetch-mode'], site: req.headers['sec-fetch-site'], ua: (req.headers['user-agent'] || '').slice(0, 30) }
    if (!p.startsWith('/__log') && !p.startsWith('/__cfg')) state.log.push(rec)

    if (p === '/__cfg') {
      if (req.method === 'POST') {
        let b = ''; req.on('data', d => { b += d }); req.on('end', () => {
          try { state.cfg = { ...defaults, ...JSON.parse(b || '{}') } } catch {}
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(state.cfg))
        }); return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(state.cfg)); return
    }
    if (p === '/__cfg.js') { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }); res.end('window.__cfg=' + JSON.stringify({ ...state.cfg, extPort }) + ';'); return }
    if (p === '/__log') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(state.log)); return }
    if (p === '/__log/clear') { state.log = []; res.writeHead(204); res.end(); return }
    if (p === '/__shell') { res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }); res.end(shellHtml()); return }
    if (p === '/mw-sw.js') { const b = labFile('sw.js'); res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' }); res.end(b); return }
    if (p === '/site-sw.js') { // a "site's own" service worker, to test registration clash
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' }); res.end(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{});`); return
    }
    if (p.startsWith('/_mw/')) {
      const b = labFile(p.slice(5)); if (!b) { res.writeHead(404); res.end('nf'); return }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(b); return
    }
    if (p.startsWith('/__site/')) {
      const rel = decodeURIComponent(p.slice(8))
      const b = siteFile(rel)
      if (!b) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('site 404'); return }
      let body = b
      if (rel.endsWith('.html') || rel.endsWith('.js') || rel.endsWith('.txt')) body = Buffer.from(b.toString('utf8').replaceAll('{{EXT}}', String(extPort)))
      const h = { 'content-type': TYPES[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' }
      if (rel === 'attach.bin') h['content-disposition'] = 'attachment; filename="attach.bin"'
      res.writeHead(200, h); res.end(body); return
    }
    // "static host": POST to any path is refused like S3/GitHub Pages do
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/html', allow: 'GET, HEAD' }); res.end('<h1>405 Method Not Allowed (static host)</h1>'); return
    }
    // "static host": unknown path -> shell (with the configured status, 404 like GitHub Pages or 200 like an SPA fallback)
    res.writeHead(state.cfg.hostFallbackStatus, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }); res.end(shellHtml())
  })

  const extServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname
    if (!state.extLog) state.extLog = []
    if (p === '/__extlog') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(state.extLog)); state.extLog = []; return }
    state.extLog.push({ path: p, referer: req.headers.referer || null, dest: req.headers['sec-fetch-dest'] || null })
    if (p === '/pixel.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')); return }
    if (p === '/embed') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>embed</title><p>embedded widget'); return }
    const page = (title, body, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(`<!doctype html><title>${title}</title><body>${body}</body>`) }
    if (p === '/page') return page('EXT page', '<h1 id=ext>external page</h1>')
    if (p === '/deny') return page('EXT deny', '<h1>deny</h1>', { 'x-frame-options': 'DENY' })
    if (p === '/popup') return page('EXT popup', `<script>
      var r={}; try{r.opener=!!window.opener}catch(e){r.opener='err'}
      try{alert('x');r.alert='called'}catch(e){r.alert='threw '+e.name}
      try{localStorage.setItem('k','v');r.ls='ok'}catch(e){r.ls='threw '+e.name}
      r.origin=location.origin; r.sandboxedOrigin=(origin==='null');
      document.title='EXTPOPUP '+JSON.stringify(r); window.__r=r;
      </script><form id=f method=post action=/post-ok><button id=sub>go</button></form>`)
    if (p === '/post-ok' && req.method === 'POST') return page('EXT posted', '<h1>posted</h1>')
    if (p === '/post-redirect' && req.method === 'POST') {
      let b = ''; req.on('data', d => { b += d }); req.on('end', () => { res.writeHead(303, { location: `http://127.0.0.1:${mainPort}/thanks.html?from=ext` }); res.end() }); return
    }
    if (p === '/post-deny' && req.method === 'POST') return page('EXT post-deny', '<h1>denied</h1>', { 'x-frame-options': 'DENY' })
    res.writeHead(404); res.end('ext nf')
  })

  let mainPort = 0
  return new Promise((resolve) => {
    extServer.listen(0, '127.0.0.1', () => {
      extPort = extServer.address().port
      mainServer.listen(0, '127.0.0.1', () => {
        mainPort = mainServer.address().port
        resolve({
          origin: `http://127.0.0.1:${mainPort}`, ext: `http://127.0.0.1:${extPort}`, mainPort, extPort,
          state,
          setCfg (patch) { state.cfg = { ...defaults, ...patch } },
          clearLog () { state.log = [] },
          close () { mainServer.close(); extServer.close(); mainServer.closeAllConnections?.(); extServer.closeAllConnections?.() }
        })
      })
    })
  })
}
