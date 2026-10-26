// Prototype: hardened web-seed connection for webtorrent 3.0.21 (drop-in via torrent.addWebSeed(conn)).
// Fixes measured failure modes: (1) non-safelisted request headers (CORS preflight), (2) servers that ignore Range,
// (3) corrupt-but-206 bodies (unbounded retry loop), (4) BEP 47 pad files that no HTTP host has, (5) no backoff.
import BitField from '$HOME/Documents/Projects/magnet-web/node_modules/bitfield/dist/index.js'
import ltDontHave from '$HOME/Documents/Projects/magnet-web/node_modules/lt_donthave/index.js'
import Wire from '$HOME/Documents/Projects/magnet-web/node_modules/bittorrent-protocol/index.js'
import { hash, concat } from '$HOME/Documents/Projects/magnet-web/node_modules/uint8-util/dist/src/node.js'

const FETCH_TIMEOUT = 30000
const BASE_DELAY = 10000      // first retry (same as stock WebConn)
const MAX_DELAY = 10 * 60000  // cap
const MAX_STRIKES = 5         // consecutive validation/hash failures before the URL is dropped for the session

export class HardenedWebConn extends Wire {
  constructor (url, torrent, { fetchImpl = null, onEvent = () => {}, baseDelay = BASE_DELAY } = {}) {
    super()
    this.url = url
    this.connId = url
    this._torrent = torrent
    // NOTE: never store window.fetch as a method (this._fetch(...) => 'Illegal invocation' in browsers); wrap it.
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a))
    this._onEvent = onEvent
    this._baseDelay = baseDelay
    this.fails = 0       // consecutive failures (any kind)
    this.strikes = 0     // consecutive integrity failures (bad status/length/hash)
    this.dead = false
    this._init(url)
  }

  _retryDelay () { return Math.min(MAX_DELAY, this._baseDelay * 2 ** Math.max(0, this.fails - 1)) }

  _init (url) {
    this.setKeepAlive(true)
    this.use(ltDontHave())
    this.once('handshake', async () => {
      const hex = await hash(url, 'hex')
      if (this.destroyed) return
      this.handshake(this._torrent.infoHash, hex)
      const bf = new BitField(this._torrent.pieces.length)
      for (let i = 0; i < this._torrent.pieces.length; i++) bf.set(i, true)
      this.bitfield(bf)
    })
    this.once('interested', () => this.unchoke())
    this.on('request', (pieceIndex, offset, length, callback) => {
      if (this.dead) { this.lt_donthave.donthave(pieceIndex); return callback(new Error('web seed dropped')) }
      this._request(pieceIndex, offset, length).then(
        data => { this.fails = 0; this.strikes = 0; callback(null, data) },
        err => {
          this.fails++
          if (err.integrity) this.strikes++
          this._onEvent({ url, type: 'fail', reason: err.message, fails: this.fails, strikes: this.strikes })
          this.lt_donthave.donthave(pieceIndex)
          if (this.strikes >= MAX_STRIKES) { this.dead = true; this._onEvent({ url, type: 'dropped' }) } else {
            const t = setTimeout(() => { if (!this.destroyed && !this.dead) this.have(pieceIndex) }, this._retryDelay())
            if (t.unref) t.unref()
          }
          callback(err)
        })
    })
  }

  async _request (pieceIndex, offset, length) {
    const tor = this._torrent
    const start = pieceIndex * tor.pieceLength + offset
    const end = start + length - 1
    const files = tor.files
    const parts = []
    const reqs = files.length <= 1
      ? [{ url: this.url, from: start, to: end, off: 0, pad: false, total: files.length ? files[0].length : tor.length }]
      : files.filter(f => f.offset <= end && f.offset + f.length > start).map(f => ({
        url: this.url + (this.url.endsWith('/') ? '' : '/') + f.path.replace(tor.path, ''),
        from: Math.max(start - f.offset, 0), to: Math.min(f.offset + f.length - 1, end) - f.offset,
        off: Math.max(f.offset - start, 0), pad: /(^|\/)\.pad\/\d+$/.test(f.path), total: f.length }))
    for (const r of reqs) {
      const n = r.to - r.from + 1
      if (r.pad) { parts.push(new Uint8Array(n)); continue }               // BEP 47: synthesize zeros, no HTTP request
      // ONLY the CORS-safelisted Range header: no Cache-Control, no User-Agent => no preflight on most hosts
      const res = await this._fetch(r.url, { headers: { range: `bytes=${r.from}-${r.to}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT), cache: 'no-store' })
      const bad = m => { try { res.body && res.body.cancel() } catch {} ; return Object.assign(new Error(m), { integrity: true }) }
      if (res.status === 200 && r.from === 0 && r.to === r.total - 1) { /* whole-file request: 200 is legitimate */ } else if (res.status !== 206) {
        try { res.body && res.body.cancel() } catch {}
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        throw bad(`status ${res.status} (server ignored Range)`)
      } else {
        const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') || '')
        if (cr && (+cr[1] !== r.from || +cr[2] !== r.to || (cr[3] !== '*' && +cr[3] !== r.total))) throw bad('Content-Range mismatch')
      }
      const ce = res.headers.get('content-encoding'); if (ce && ce !== 'identity') throw bad(`Content-Encoding ${ce}`)
      const body = new Uint8Array(await res.arrayBuffer())
      if (body.length !== n) throw bad(`length ${body.length} != ${n}`)
      parts.push(body)
    }
    const data = concat(parts)
    // Whole-piece request => verify SHA-1 here so a corrupt-but-206 host is attributed and struck (stock WebTorrent never penalises it)
    const thisPieceLength = pieceIndex === tor.pieces.length - 1 ? tor.lastPieceLength : tor.pieceLength
    if (offset === 0 && length === thisPieceLength) {
      const hex = await hash(data, 'hex')
      if (hex !== tor._hashes[pieceIndex]) throw Object.assign(new Error('piece hash mismatch'), { integrity: true })
    }
    return data
  }

  destroy () { super.destroy(); this._torrent = null }
}
