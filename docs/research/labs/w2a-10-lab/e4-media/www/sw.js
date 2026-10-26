// E4 service worker: serves /m/<variant>/<file> from an in-memory copy of /media/<file>, with a response behaviour per variant.
const log = new BroadcastChannel('e4log')
const cache = new Map()
const TYPES = { mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', mp3: 'audio/mpeg' }
async function getFile (name) {
  if (!cache.has(name)) { const r = await fetch('/media/' + name, { cache: 'no-store' }); cache.set(name, new Uint8Array(await r.arrayBuffer())) }
  return cache.get(name)
}
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const m = url.pathname.match(/^\/m\/([a-z0-9-]+)\/(.+)$/)
  if (!m) return
  event.respondWith(handle(event.request, m[1], decodeURIComponent(m[2])))
})
function parseRange (h, size) {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m) return 'bad'
  const s = m[1]; const e = m[2]
  if (s === '' && e === '') return 'bad'
  if (s === '') { const n = +e; return { start: Math.max(0, size - n), end: size - 1 } }
  const start = +s; const end = e === '' ? size - 1 : Math.min(+e, size - 1)
  if (start >= size || end < start) return 'unsat'
  return { start, end }
}
function slice (buf, rr, type, size, o, entry) {
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }
  if (rr === 'unsat') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  if (rr === null || rr === 'bad') { h['Content-Length'] = String(size); return new Response(buf, { status: 200, headers: h }) }
  let { start, end } = rr
  if (o.cap && end - start + 1 > o.cap) end = start + o.cap - 1
  h['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (!o.noContentLength) h['Content-Length'] = String(end - start + 1)
  entry.served = `${start}-${end}`
  const part = buf.subarray(start, end + 1)
  if (!o.stream) return new Response(part, { status: 206, headers: h })
  let off = 0
  const body = new ReadableStream({
    async pull (c) {
      if (off >= part.length) return c.close()
      if (o.delay) await new Promise(r => setTimeout(r, o.delay))
      c.enqueue(part.subarray(off, Math.min(off + o.chunk, part.length))); off += o.chunk
    },
    cancel () { log.postMessage({ cancel: true, variant: entry.variant, file: entry.file, range: entry.range, deliveredBytes: Math.min(off, part.length), of: part.length }) }
  })
  return new Response(body, { status: 206, headers: h })
}
function pacedFull (buf, type, size, entry) {
  let off = 0
  const body = new ReadableStream({
    async pull (c) { if (off >= size) return c.close(); await new Promise(r => setTimeout(r, 20)); c.enqueue(buf.subarray(off, Math.min(off + 262144, size))); off += 262144 },
    cancel () { log.postMessage({ cancel: true, variant: entry.variant, file: entry.file, range: entry.range, deliveredBytes: Math.min(off, size), of: size }) }
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size) } })
}
async function handle (req, variant, file) {
  const buf = await getFile(file)
  const size = buf.length
  const type = TYPES[file.split('.').pop()]
  const rh = req.headers.get('range')
  const rr = parseRange(rh, size)
  const entry = { variant, file, range: rh, dest: req.destination, mode: req.mode }
  let res
  switch (variant) {
    case 'ignore': res = new Response(buf, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size) } }); break
    case 'ar200': res = new Response(buf, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } }); break
    case 'full206': res = slice(buf, rr, type, size, {}, entry); break
    case 'cap206': res = slice(buf, rr, type, size, { cap: 256 * 1024 }, entry); break
    case 'slow206': res = slice(buf, rr, type, size, { stream: true, chunk: 65536, delay: 25 }, entry); break
    case 'nocl206': res = slice(buf, rr, type, size, { stream: true, chunk: 262144, delay: 0, noContentLength: true }, entry); break
    case 'rangepaced': res = slice(buf, rr, type, size, { stream: true, chunk: 262144, delay: 20 }, entry); break
    case 'ignorepaced': res = pacedFull(buf, type, size, entry); break
    case 'late206': await new Promise(r => setTimeout(r, 3000)); res = slice(buf, rr, type, size, {}, entry); break
    default: res = new Response('unknown variant', { status: 500 })
  }
  entry.status = res.status
  log.postMessage(entry)
  return res
}
