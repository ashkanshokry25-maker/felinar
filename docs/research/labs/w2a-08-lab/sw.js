// w2a-08 lab service worker: emulates ARCHITECTURE 7.1 dispatch for shell mode.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.bin': 'application/octet-stream' }
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
const ext = (p) => { const m = /\.[a-z0-9]+$/i.exec(p); return m ? m[0].toLowerCase() : '' }
const isHtmlPath = (p) => p.endsWith('/') || ext(p) === '.html' || ext(p) === ''
async function getCfg () { try { return await (await fetch('/__cfg', { cache: 'no-store' })).json() } catch { return {} } }

async function serveSite (url, cfg) {
  let p = url.pathname
  if (p === '/' ) p = '/index.html'
  if (p.startsWith('/spa/')) p = '/spa.html'
  let r = await fetch('/__site' + p, { cache: 'no-store' })
  let status = 200
  if (!r.ok) { r = await fetch('/__site/404.html', { cache: 'no-store' }); status = 404 }
  const type = status === 404 ? TYPES['.html'] : (r.headers.get('content-type') || TYPES[ext(p)] || 'application/octet-stream')
  let body = await r.arrayBuffer()
  const headers = new Headers({ 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' })
  if (cfg.docReferrerPolicy !== '') headers.set('referrer-policy', cfg.docReferrerPolicy || 'no-referrer')
  const cd = r.headers.get('content-disposition'); if (cd) headers.set('content-disposition', cd)
  // simulated routing-manifest "headers" rule (ARCH 7.1): a strict, header-delivered CSP for one page
  let nonce = null
  if (p === '/strictcsp-hdr.html') { headers.set('content-security-policy', "script-src 'nonce-abc123' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"); nonce = 'abc123' }
  headers.set('content-length', String(body.byteLength))
  if (cfg.injectAgent && type.startsWith('text/html')) {
    const tag = '<script' + (cfg.agentNonce && nonce ? ' nonce="' + nonce + '"' : '') + ' src="/_mw/agent.js"></script>'
    const html = new TextDecoder().decode(body).replace(/<head([^>]*)>/i, '<head$1>' + tag)
    body = new TextEncoder().encode(html).buffer
    headers.set('content-length', String(body.byteLength))
  }
  return new Response(body, { status, headers })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  const p = url.pathname
  if (p.startsWith('/_mw/') || p === '/mw-sw.js' || p.startsWith('/__') || p === '/site-sw.js') return
  if (req.method !== 'GET' && req.method !== 'HEAD') return   // non-GET untouched: goes to the "static host" (ARCH 3.4.2 d / 7.1)
  e.respondWith((async () => {
    const cfg = await getCfg()
    if (req.mode === 'navigate' && req.destination === 'document') {
      if (cfg.nonHtmlDirect && !isHtmlPath(p)) return serveSite(url, cfg)
      const r = await fetch('/__shell', { cache: 'no-store' })
      return new Response(await r.arrayBuffer(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    return serveSite(url, cfg)
  })())
})
