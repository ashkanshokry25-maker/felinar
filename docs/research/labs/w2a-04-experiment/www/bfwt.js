// Two real WebTorrent clients inside ONE page (seeder + leecher) connected via a local ws tracker.
const q = new URLSearchParams(location.search)
const mode = q.get('mode') // 'connected-left-running' | 'connected-destroy-on-pagehide' | 'alone'
const out = { mode, done: false }; window.__out = out
const { default: WebTorrent } = await import('/wt.js')
const TR = q.get('tracker')
const mk = () => new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
const A = mk()
const bytes = new Uint8Array(200000); for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)))
const tA = A.seed(new File([bytes], 'a.bin'), { name: 'bfwt-' + Math.random().toString(36).slice(2), announce: [TR] })
await new Promise((r) => tA.on('ready', r))
let B = null
if (!mode.startsWith('alone')) {
  B = mk()
  const tB = B.add(tA.magnetURI, { announce: [TR] })
  await new Promise((r) => { tB.on('done', r); setTimeout(r, 12000) })
  out.done = tB.done; out.wires = tB.wires.length
}
if (mode === 'connected-destroy-on-pagehide' || mode === 'alone-destroy-on-pagehide') addEventListener('pagehide', () => { try { A.destroy(); B && B.destroy() } catch (e) {} })
window.__ready = true
