// Verbatim copy of the pointer-detection lines of src/loader/render.js (Oct 14 version, read 2026-10-17 ~17:44 ET,
// before another agent rewrote render.js at 17:53 ET and removed detectMode). Only the pieces that matter for claim 4.
function queryParam (search, name) {
  if (!search) return null
  try { return new URLSearchParams(search).get(name) } catch (_) { return null }
}
function isPointerHash (hash) {
  const h = (hash || '').replace(/^#/, '')
  return /^(magnet:|btih:|host:|v=mw1|xt=urn:btih:)/i.test(h) || /(^|;)\s*btih=/i.test(h)
}
export function normalizePointerText (text) {
  const t = String(text || '').trim()
  const m = /^btih:([0-9a-z]{32}|[0-9a-f]{40})$/i.exec(t)
  if (m) return `magnet:?xt=urn:btih:${m[1]}`
  if (/^xt=urn:btih:/i.test(t)) return 'magnet:?' + t
  return t
}
export function detectModeOld (loc) {
  const hostname = String((loc && loc.hostname) || '').toLowerCase()
  let hash = ''
  try { hash = decodeURIComponent(String((loc && loc.hash) || '').replace(/^#/, '')) } catch (_) { hash = String(loc.hash || '').replace(/^#/, '') }
  const mwQuery = queryParam(loc && loc.search, 'mw')
  const explicit = isPointerHash('#' + hash) ? hash.trim() : (mwQuery ? mwQuery.trim() : null)
  if (explicit) {
    const hostMatch = /^host:([a-z0-9.-]+)\.?$/i.exec(explicit)
    if (hostMatch) return { mode: 'hub', kind: 'host', pointerText: null }
    return { mode: 'hub', kind: 'magnet', host: hostname, pointerText: normalizePointerText(explicit) }
  }
  return { mode: 'domain', kind: 'host', pointerText: null }
}
// Proposed fix from the research note (R2), for comparison
export function fragmentToPointerText (rawHash) {
  const h = String(rawHash || '').replace(/^#/, '')
  if (/^(?:magnet|btih|host)%3a/i.test(h)) { try { return decodeURIComponent(h) } catch (_) { return h } }
  return h
}
