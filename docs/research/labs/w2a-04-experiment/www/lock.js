// Engine-leader election across same-origin pages with Web Locks (what an embedded engine would do).
const q = new URLSearchParams(location.search)
const id = q.get('id'), page = q.get('p')
const rep = (o) => navigator.sendBeacon('/__report', JSON.stringify({ lock: true, id, page, ...o, t: Date.now() }))
rep({ ev: 'loaded' })
navigator.locks.request('mw-engine', async () => { rep({ ev: 'LEADER' }); await new Promise(() => {}) })
addEventListener('pagehide', () => rep({ ev: 'pagehide' }))
