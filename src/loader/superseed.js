// src/loader/superseed.js: the super-seeded hand-off of an own upload (BEP 16; v0.3 C2, lane seed-engine;
// docs/research/v03/S1-smart-phone-seeding.md D4, SZ 3.1.6). Behind CONFIG.seed.superSeed (default false until
// gate row G-PS-8): TorrentManager uses it only for H torrents on phones.
//
// A plain seed may upload 150% to 200% of an item before another full copy exists; a super-seed about 105%
// (BEP 16, [TO1] in S1). The seed masquerades as a peer with no pieces (an empty bitfield, or have-none on a
// Fast Extension wire) and then reveals one piece per wire with a have message, the next one only after that wire
// reports the piece (its own have). Pieces are revealed rarest first: what no other wire holds or was shown, then
// what fewest hold. An authenticated pin wire (src/loader/pinwire.js) goes first: while one is connected and not
// complete, only pin wires get reveals, so the phone's budget goes to the durable holder. Super-seeding stops, and
// every wire is told every remaining piece, when a pin receipt exists or any wire reports a complete bitfield.
//
// Vendored webtorrent 3.0.21 (checked in node_modules/webtorrent/lib/torrent.js and the minified dist bundle that
// build.mjs vendors): Torrent._onWire emits 'wire' first and only then, in a queueMicrotask (or from _onStore once
// the store is verified), calls _onWireWithMetadata, which sends `wire.haveAll()` (Fast Extension and every piece),
// `wire.haveNone()` or `wire.bitfield(this.bitfield)`. So own-property wrappers installed synchronously from the
// 'wire' event see that first message and can mask it. The library sends `wire.have(i)` only when a downloaded piece
// verifies, which never happens for a complete own upload; the wrapper drops it while super-seeding anyway.
//
//   new SuperSeed({ pieces, has, isPin, onStop, onReveal })
//     addWire(wire) -> boolean   (synchronously from the 'wire' event; false when inactive or not a peer wire)
//     removeWire(wire), pinChanged(), noteReceipt(), stop(reason), stats(), active, reason
//   emptyBitfield(pieces) -> Uint8Array

/** emptyBitfield(pieces) -> the bitfield of a peer that has nothing (ceil(pieces / 8) zero bytes). */
export function emptyBitfield (pieces) {
  const n = Math.max(0, Math.floor(Number(pieces) || 0))
  return new Uint8Array(Math.ceil(n / 8))
}

function noop () {}

/** How long an authenticated pin wire that reports no revealed piece keeps the other wires waiting (MP-15, chosen). */
export const PIN_WAIT_MS = 30000

function remoteHas (wire, i) {
  const pp = wire && wire.peerPieces
  try { return !!(pp && typeof pp.get === 'function' && pp.get(i)) } catch (_) { return false }
}

/**
 * SuperSeed({ pieces, has, isPin, onStop, onReveal }): one per H torrent.
 *   pieces   number of pieces of the item
 *   has(i)   true when this device holds piece i verified (an own upload holds every piece)
 *   isPin(w) true for a wire src/loader/pinwire.js authenticated as the site's pin node
 *   onStop({ reason }) and onReveal({ wire, index }) are notifications (never required)
 */
export class SuperSeed {
  constructor ({ pieces, has = () => true, isPin = () => false, onStop = noop, onReveal = noop, now = () => Date.now(), pinWaitMs = PIN_WAIT_MS, setTimeout: setT = null, clearTimeout: clearT = null } = {}) {
    const n = Math.floor(Number(pieces))
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError('SuperSeed: pieces must be a positive integer')
    this.pieces = n
    this._has = typeof has === 'function' ? has : () => true
    this._isPin = typeof isPin === 'function' ? isPin : () => false
    this._onStop = typeof onStop === 'function' ? onStop : noop
    this._onReveal = typeof onReveal === 'function' ? onReveal : noop
    this.active = true
    this.reason = null
    this._wires = new Map() // wire -> state
    this._seen = new Int32Array(n) // open wires that hold piece i (their bitfields and haves)
    this._sent = new Int32Array(n) // times piece i was revealed to any wire
    this._inflight = new Int32Array(n) // wires whose current reveal is piece i
    this._reveals = 0
    // Review round R 5.3 (MP-15): the pin-first rule has a deadline. A pin wire that reports no revealed piece for
    // pinWaitMs no longer holds the others back (a slow pin, or a relayed one, MP-9); a timer gives them their turn.
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._pinWaitMs = Number.isFinite(Number(pinWaitMs)) && Number(pinWaitMs) >= 0 ? Number(pinWaitMs) : PIN_WAIT_MS
    this._setT = typeof setT === 'function' ? setT : (typeof setTimeout === 'function' ? (fn, ms) => setTimeout(fn, ms) : null)
    this._clearT = typeof clearT === 'function' ? clearT : (typeof clearTimeout === 'function' ? (t) => clearTimeout(t) : null)
    this._pinTimer = null
  }

  get wires () { return Array.from(this._wires.keys()) }

  /**
   * addWire(wire) -> true when installed. Must run synchronously from the torrent's 'wire' event, before
   * webtorrent sends its bitfield (see the header). A web seed is never wrapped.
   */
  addWire (wire) {
    if (!this.active || !wire || wire.type === 'webSeed' || wire.destroyed || this._wires.has(wire)) return false
    if (typeof wire.bitfield !== 'function' || typeof wire.have !== 'function') return false
    const self = this
    const st = {
      wire,
      own: {
        bitfield: Object.prototype.hasOwnProperty.call(wire, 'bitfield'),
        haveAll: Object.prototype.hasOwnProperty.call(wire, 'haveAll'),
        have: Object.prototype.hasOwnProperty.call(wire, 'have')
      },
      orig: { bitfield: wire.bitfield, haveAll: wire.haveAll, have: wire.have },
      remote: new Uint8Array(this.pieces), // what this wire reported holding
      revealed: new Uint8Array(this.pieces), // what this wire was told we hold
      current: -1, // the piece revealed and not yet reported back
      sentInitial: false,
      progressAt: this._now(), // MP-15: when this wire last reported a piece we revealed to it (or joined)
      off: []
    }
    this._wires.set(wire, st)
    wire.bitfield = function mwSuperSeedBitfield (bf) {
      if (!self.active || st.sentInitial) return st.orig.bitfield.call(this, bf)
      st.sentInitial = true
      st.orig.bitfield.call(this, emptyBitfield(self.pieces))
      self._reveal(st)
      return undefined
    }
    wire.haveAll = function mwSuperSeedHaveAll () {
      if (!self.active || st.sentInitial) return st.orig.haveAll.call(this)
      st.sentInitial = true
      if (this.hasFast && typeof this.haveNone === 'function') this.haveNone()
      else st.orig.bitfield.call(this, emptyBitfield(self.pieces))
      self._reveal(st)
      return undefined
    }
    wire.have = function mwSuperSeedHave (index) {
      if (!self.active) return st.orig.have.call(this, index)
      return undefined // the library's own announcements would undo the mask; reveals go through st.orig.have
    }
    const on = (ev, fn) => {
      if (typeof wire.on !== 'function') return
      wire.on(ev, fn)
      st.off.push(() => { try { if (typeof wire.removeListener === 'function') wire.removeListener(ev, fn) } catch (_) { /* gone */ } })
    }
    on('bitfield', () => this._recount(st))
    on('have', (index) => this._onHave(st, Number(index)))
    on('have-all', () => this._recount(st))
    on('have-none', () => this._recount(st))
    on('close', () => this.removeWire(wire))
    this._recount(st)
    return true
  }

  removeWire (wire) {
    const st = this._wires.get(wire)
    if (!st) return false
    this._wires.delete(wire)
    for (let i = 0; i < this.pieces; i++) if (st.remote[i]) this._seen[i]--
    if (st.current >= 0) this._inflight[st.current]--
    st.current = -1
    for (const fn of st.off.splice(0)) fn()
    this._restore(st)
    if (this.active) this._revealAll() // a waiting wire may go now (the pin wire left)
    return true
  }

  /** An authenticated pin wire appeared or finished: pin wires go first, others wait meanwhile. */
  pinChanged () {
    if (this.active) this._revealAll()
  }

  /** A mw_pin1 receipt exists for the item: the hand-off is done. */
  noteReceipt () { this.stop('receipt') }

  /**
   * stop(reason): ends super-seeding. Every wire that already got the masked bitfield is told each remaining piece
   * it does not hold (have messages); a wire whose first message has not gone out yet sends the real bitfield.
   */
  stop (reason = 'stopped') {
    if (!this.active) return false
    this.active = false
    if (this._pinTimer && this._clearT) { try { this._clearT(this._pinTimer) } catch (_) { /* fired */ } }
    this._pinTimer = null
    this.reason = String(reason)
    for (const st of Array.from(this._wires.values())) {
      if (st.sentInitial && !st.wire.destroyed) {
        for (let i = 0; i < this.pieces; i++) {
          if (st.revealed[i] || st.remote[i] || remoteHas(st.wire, i) || !this._has(i)) continue
          st.revealed[i] = 1
          try { st.orig.have.call(st.wire, i) } catch (_) { /* closing */ }
        }
      }
      for (const fn of st.off.splice(0)) fn()
      this._restore(st)
    }
    this._wires.clear()
    try { this._onStop({ reason: this.reason }) } catch (_) { /* a listener's problem */ }
    return true
  }

  /** stats() -> { active, reason, wires, reveals, distinct, duplicates, inflight } (diagnostics and tests). */
  stats () {
    let distinct = 0
    let duplicates = 0
    let inflight = 0
    for (let i = 0; i < this.pieces; i++) {
      if (this._sent[i] > 0) distinct++
      if (this._sent[i] > 1) duplicates += this._sent[i] - 1
      inflight += this._inflight[i]
    }
    return { active: this.active, reason: this.reason, wires: this._wires.size, reveals: this._reveals, distinct, duplicates, inflight }
  }

  // ---- internals -------------------------------------------------------------------------------

  _restore (st) {
    const w = st.wire
    for (const k of ['bitfield', 'haveAll', 'have']) {
      try {
        if (st.own[k]) w[k] = st.orig[k]
        else delete w[k]
      } catch (_) { /* a frozen wire */ }
    }
  }

  _recount (st) {
    const w = st.wire
    let all = true
    for (let i = 0; i < this.pieces; i++) {
      const h = remoteHas(w, i) ? 1 : 0
      if (h !== st.remote[i]) {
        this._seen[i] += h ? 1 : -1
        st.remote[i] = h
      }
      if (!h) all = false
    }
    if (st.current >= 0 && st.remote[st.current]) this._settle(st)
    if (all) { this.stop('peer-complete'); return }
    if (this.active) this._reveal(st)
  }

  _onHave (st, index) {
    if (!this.active || !Number.isSafeInteger(index) || index < 0 || index >= this.pieces) return
    if (!st.remote[index]) {
      st.remote[index] = 1
      this._seen[index]++
    }
    if (st.current === index) { this._settle(st); st.progressAt = this._now() }
    let all = true
    for (let i = 0; i < this.pieces; i++) if (!st.remote[i]) { all = false; break }
    if (all) { this.stop('peer-complete'); return }
    this._reveal(st)
    if (this._isPin(st.wire)) this._revealAll() // the pin moved on: waiting wires may get a turn when it is done
  }

  _settle (st) {
    if (st.current >= 0) this._inflight[st.current]--
    st.current = -1
  }

  _pinWaiting () {
    const t = this._now()
    let soonest = Infinity
    for (const st of this._wires.values()) {
      if (st.wire.destroyed || !this._isPin(st.wire)) continue
      const left = st.progressAt + this._pinWaitMs - t
      if (left <= 0) continue // MP-15: this pin wire had its turn
      for (let i = 0; i < this.pieces; i++) {
        if (!st.remote[i] && this._has(i)) { soonest = Math.min(soonest, left); break }
      }
    }
    if (soonest === Infinity) return false
    this._armPinTimer(soonest)
    return true
  }

  _armPinTimer (ms) {
    if (this._pinTimer || !this._setT) return
    this._pinTimer = this._setT(() => { this._pinTimer = null; if (this.active) this._revealAll() }, Math.ceil(ms) + 1)
    if (this._pinTimer && typeof this._pinTimer.unref === 'function') this._pinTimer.unref()
  }

  _revealAll () {
    const list = Array.from(this._wires.values())
    // Pin wires first.
    list.sort((a, b) => (this._isPin(b.wire) ? 1 : 0) - (this._isPin(a.wire) ? 1 : 0))
    for (const st of list) this._reveal(st)
  }

  _pick (st) {
    let best = -1
    let bestRare = 0
    let bestSent = 0
    for (let i = 0; i < this.pieces; i++) {
      if (st.revealed[i] || st.remote[i] || !this._has(i)) continue
      const rare = this._seen[i] + this._inflight[i]
      const sent = this._sent[i]
      if (best < 0 || rare < bestRare || (rare === bestRare && sent < bestSent)) {
        best = i
        bestRare = rare
        bestSent = sent
      }
    }
    return best
  }

  _reveal (st) {
    if (!this.active || !st.sentInitial || st.current >= 0 || st.wire.destroyed) return false
    if (!this._isPin(st.wire) && this._pinWaiting()) return false
    const i = this._pick(st)
    if (i < 0) return false
    st.current = i
    st.revealed[i] = 1
    this._inflight[i]++
    this._sent[i]++
    this._reveals++
    try { st.orig.have.call(st.wire, i) } catch (_) { /* closing */ }
    try { this._onReveal({ wire: st.wire, index: i }) } catch (_) { /* a listener's problem */ }
    return true
  }
}
