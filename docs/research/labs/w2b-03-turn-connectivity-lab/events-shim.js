// minimal Node-style EventEmitter for the browser test bundle
export class EventEmitter {
  constructor () { this._ev = Object.create(null) }
  _l (n) { return this._ev[n] || (this._ev[n] = []) }
  on (n, f) { this._l(n).push({ f }); return this }
  addListener (n, f) { return this.on(n, f) }
  prependListener (n, f) { this._l(n).unshift({ f }); return this }
  once (n, f) { this._l(n).push({ f, once: true }); return this }
  off (n, f) { const a = this._ev[n]; if (a) { const i = a.findIndex(x => x.f === f || x.f.listener === f); if (i >= 0) a.splice(i, 1) } return this }
  removeListener (n, f) { return this.off(n, f) }
  removeAllListeners (n) { if (n) delete this._ev[n]; else this._ev = Object.create(null); return this }
  emit (n, ...args) {
    const a = this._ev[n]
    if (!a || !a.length) { if (n === 'error') throw args[0] instanceof Error ? args[0] : new Error('Unhandled error'); return false }
    for (const x of a.slice()) { if (x.once) this.off(n, x.f); x.f.apply(this, args) }
    return true
  }
  listenerCount (n) { return (this._ev[n] || []).length }
  listeners (n) { return (this._ev[n] || []).map(x => x.f) }
  setMaxListeners () { return this }
}
export default EventEmitter
export const once = () => Promise.resolve()
