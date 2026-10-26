// Lab server for WebTorrent browser experiments. Binds to 127.0.0.1 only.
// usage: deno run --allow-net=127.0.0.1 --allow-read=. --allow-write=./out server.ts PAGE_PORT SEED_PORT
const [pagePortArg, seedPortArg] = Deno.args
const PAGE_PORT = Number(pagePortArg || 18080)
const SEED_PORT = Number(seedPortArg || 18081)
const root = new URL('.', import.meta.url).pathname
const www = root + 'www/'
const out = root + 'out/'
const seedDir = out + 'seedfiles/'
Deno.mkdirSync(seedDir, { recursive: true })
const logFile = out + 'requests.log'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json'
}
const kv = new Map<string, string>()

function log (role: string, req: Request, status: number, note = '') {
  const h: Record<string, string> = {}
  for (const [k, v] of req.headers) h[k] = v
  Deno.writeTextFileSync(logFile, JSON.stringify({ t: Date.now(), role, m: req.method, u: new URL(req.url).pathname + new URL(req.url).search, s: status, h, note }) + '\n', { append: true })
}

function safeJoin (base: string, rel: string): string | null {
  const p = decodeURIComponent(rel).replace(/^\/+/, '')
  if (p.split('/').some(seg => seg === '..' || seg === '')) return null
  return base + p
}

async function pageHandler (req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  let res: Response
  if (path.startsWith('/report/') && req.method === 'POST') {
    const name = path.slice('/report/'.length).replace(/[^a-zA-Z0-9_.-]/g, '_')
    Deno.writeTextFileSync(out + `report-${name}.json`, await req.text())
    res = new Response('ok')
  } else if (path.startsWith('/kv/')) {
    const k = path.slice(4)
    if (req.method === 'POST') { kv.set(k, await req.text()); res = new Response('ok') } else { res = new Response(kv.get(k) ?? '', { status: kv.has(k) ? 200 : 404 }) }
  } else if (path.startsWith('/upload/') && req.method === 'POST') {
    const name = path.slice('/upload/'.length).replace(/[^a-zA-Z0-9_.-]/g, '_')
    Deno.writeFileSync(seedDir + name, new Uint8Array(await req.arrayBuffer()))
    res = new Response('ok')
  } else {
    const file = safeJoin(www, path === '/' ? 'index.html' : path)
    if (!file) { res = new Response('bad path', { status: 400 }) } else {
      try {
        const data = await Deno.readFile(file)
        const ext = file.slice(file.lastIndexOf('.'))
        res = new Response(data, { headers: { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' } })
      } catch { res = new Response('not found', { status: 404 }) }
    }
  }
  log('page', req, res.status)
  return res
}

// Web-seed server: /seed/<mode>/<filename>, modes: none | acao | full
async function seedHandler (req: Request): Promise<Response> {
  const url = new URL(req.url)
  const m = url.pathname.match(/^\/seed\/(none|acao|full)\/([A-Za-z0-9_.-]+)$/)
  if (!m) { const r = new Response('not found', { status: 404 }); log('seed', req, 404); return r }
  const [, mode, name] = m
  const cors: Record<string, string> = {}
  if (mode === 'acao' || mode === 'full') cors['access-control-allow-origin'] = '*'
  if (req.method === 'OPTIONS') {
    if (mode === 'full') {
      cors['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
      cors['access-control-allow-headers'] = req.headers.get('access-control-request-headers') ?? ''
      cors['access-control-max-age'] = '600'
    }
    const r = new Response(null, { status: 204, headers: cors }); log('seed', req, 204, `mode=${mode}`); return r
  }
  let data: Uint8Array
  try { data = await Deno.readFile(seedDir + name) } catch { const r = new Response('missing', { status: 404, headers: cors }); log('seed', req, 404); return r }
  const range = req.headers.get('range')
  const rm = range?.match(/^bytes=(\d+)-(\d*)$/)
  if (rm) {
    const start = Number(rm[1]); const end = Math.min(rm[2] ? Number(rm[2]) : data.length - 1, data.length - 1)
    const body = data.slice(start, end + 1)
    const r = new Response(body, { status: 206, headers: { ...cors, 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${data.length}`, 'accept-ranges': 'bytes' } })
    log('seed', req, 206, `mode=${mode} range=${range}`); return r
  }
  const r = new Response(data, { status: 200, headers: { ...cors, 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' } })
  log('seed', req, 200, `mode=${mode} no-range`); return r
}

Deno.serve({ hostname: '127.0.0.1', port: PAGE_PORT, onListen: () => console.log(`page server http://127.0.0.1:${PAGE_PORT}`) }, pageHandler)
Deno.serve({ hostname: '127.0.0.1', port: SEED_PORT, onListen: () => console.log(`seed server http://127.0.0.1:${SEED_PORT}`) }, seedHandler)
