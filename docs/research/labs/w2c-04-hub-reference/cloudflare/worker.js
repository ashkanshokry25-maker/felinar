// Cloudflare Worker (Workers Static Assets) for a magnet-web hub sites domain: routes "*.hub-sites.example/*".
// Same policy as aws/edge.js (ARCHITECTURE.md v0.2): 32-char base32 label grammar, 451 denylist (+ Clear-Site-Data: "storage"),
// network-only status ping, navigation fallback with REAL 404s for everything else.
// Denylist = Workers KV, one key per label (value = reason). KV is eventually consistent (edge cache up to 60 s).
const LABEL = /^[a-z2-7]{32}$/
const SUBRESOURCE = new Set(['script', 'style', 'image', 'font', 'worker', 'sharedworker', 'serviceworker', 'manifest', 'audio', 'video', 'track', 'object', 'embed', 'audioworklet', 'paintworklet', 'json', 'text', 'xslt', 'report'])
// physical shell files (ARCHITECTURE.md v0.2 sections 3.1 and 10); a miss stays a miss
const PHYSICAL = /^\/(?:mw-sw\.js|mw-sw-kill\.js|build\.json|_mw\/.+|robots\.txt|favicon\.ico|\.well-known\/.+)$/
const NO_CACHE = /^\/(?:mw-sw\.js|mw-sw-kill\.js)$/

const SECURITY = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' blob: data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'permissions-policy': 'accelerometer=(), autoplay=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()',
  'origin-agent-cluster': '?1',
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'x-robots-tag': 'noindex, nofollow',
}

function reply(status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  return new Response(body, { status, headers: { ...SECURITY, 'content-type': type, 'cache-control': 'no-store', ...extra } })
}
function secured(res, cacheControl) {
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(SECURITY)) h.set(k, v)
  if (cacheControl) h.set('cache-control', cacheControl)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const sites = env.SITES_DOMAIN || 'hub-sites.example'
    const control = env.CONTROL_URL || 'https://hub.example'
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    const suffix = '.' + sites
    if (host.length <= suffix.length || !host.endsWith(suffix)) return reply(421, 'Unknown host\n')
    const label = host.slice(0, host.length - suffix.length)
    if (!LABEL.test(label)) return reply(404, `Not a content address. See ${control}\n`)

    // Denylist. Fail OPEN: an unreachable store must not take every site down (logged loudly, like the IPFS SW gateway).
    let reason = null
    try { reason = await env.DENYLIST.get(label, { cacheTtl: 60 }) } catch (err) { console.log('denylist_lookup_error', String(err)) }
    if (reason !== null) {
      return reply(451, `This site is unavailable. Policy and appeals: ${control}/policy/takedown\n`, 'text/plain; charset=utf-8', {
        link: `<${control}/policy/takedown>; rel="blocked-by"`,
        'clear-site-data': '"storage"',
      })
    }

    const p = url.pathname
    if (p === '/_mw/hub/status') return reply(200, '{"v":1,"status":"ok"}', 'application/json')
    if (p.startsWith('/_mw/hub/')) return reply(404, 'Not found\n')
    if (PHYSICAL.test(p)) {
      const res = await env.ASSETS.fetch(request)
      return secured(res, NO_CACHE.test(p) ? 'no-cache' : 'public, max-age=300')
    }

    const dest = request.headers.get('sec-fetch-dest') || ''
    const last = p.slice(p.lastIndexOf('/') + 1)
    const looksLikeDocument = dest === 'document' || !last.includes('.') || /\.html?$/.test(last)
    if (SUBRESOURCE.has(dest) || !looksLikeDocument) return reply(404, 'Not found\n')

    const res = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
    return secured(res, 'no-cache')
  },
}
