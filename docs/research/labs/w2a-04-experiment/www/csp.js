// CSP compatibility probe for the unmodified webtorrent@3.0.21 browser bundle.
const q = new URLSearchParams(location.search)
const role = q.get('role') || 'leech'
const TRACKER = q.get('tracker')
const out = { role, violations: [], errors: [], warnings: [], t: {}, cwNativeBeforeImport: !!(window.FileSystemFileHandle && FileSystemFileHandle.prototype.createWritable) }
window.__out = out
document.addEventListener('securitypolicyviolation', (e) => out.violations.push({ d: e.violatedDirective, b: String(e.blockedURI).slice(0, 90) }))
const t0 = performance.now()
let WebTorrent
try { ({ default: WebTorrent } = await import('/wt.js')) } catch (e) { out.errors.push('import:' + (e && e.message)) }
out.t.imported = Math.round(performance.now() - t0)
out.cwAfterImport = !!(window.FileSystemFileHandle && FileSystemFileHandle.prototype.createWritable)
if (WebTorrent) {
  const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
  client.on('error', (e) => out.errors.push('client:' + (e && e.message || e)))
  if (q.get('destroy') === '1') addEventListener('pagehide', () => { try { client.destroy() } catch (e) {} })
  window.__client = client
  const wire = (t) => {
    t.on('wire', () => { if (out.t.firstWire === undefined) out.t.firstWire = Math.round(performance.now() - t0) })
    t.on('error', (e) => out.errors.push('torrent:' + (e && e.message || e)))
    t.on('warning', (e) => out.warnings.push(String(e && e.message || e).slice(0, 120)))
    t.on('metadata', () => { out.t.metadata = Math.round(performance.now() - t0) })
    t.on('done', () => { out.t.done = Math.round(performance.now() - t0); out.done = true; out.bytes = t.downloaded })
  }
  if (role === 'seed') {
    const bytes = new Uint8Array(300000)
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)))
    const t = client.seed(new File([bytes], 'a.bin'), { name: 'csp-test', announce: [TRACKER] }, (tor) => { out.magnet = tor.magnetURI; out.seeding = true })
    wire(t)
  } else {
    const t = client.add(q.get('magnet'), { announce: [TRACKER] })
    wire(t)
  }
}
