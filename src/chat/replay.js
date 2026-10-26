// Replay and ordering for opened messages (R 2.7.4, MF-36):
//   - accept t in [now - 7 days - 5 min, now + 5 min];
//   - per-sender high-water t: a message newer than everything seen from that sender cannot be a replay;
//   - a 7-day Bloom filter of (sender, id), one filter per UTC day of t, kept for 8 days, persisted through
//     an injected sealed store (it holds no content, so it is kept even when history is off);
//   - per-conversation counter n: a gap means "Earlier messages may still arrive".
// The store is { get(key) -> Promise<value | undefined>, set(key, value) -> Promise } (the vault-sealed
// IndexedDB of the identity lane); values are plain JSON.
//
// Review round (DS-6, SYB-6): the shared Bloom filter is consulted only where nothing exact decides, so a filled filter
// cannot drop a new sender's first message or an out-of-order message whose counter is known:
//   - a sender with no high-water mark has sent nothing this guard kept, unless it was evicted from the high-water map
//     (20,000 senders); `floor` is the newest t of an evicted sender, and only t <= floor falls back to the filter;
//   - an older message (t <= high-water) with a conversation counter n at or above the conversation's window start is a
//     replay exactly when n was seen;
//   - one sender adds at most REPLAY_SENDER_DAY_MAX ids a UTC day of t; more are refused ('sender-cap'), so one flooder
//     cannot fill the day's filter for everyone.
// What still reaches the filter (an older message without a known counter: ACKs, requests) loses about 1% at 6,800 ids
// a day (arithmetic).
//
// Shared code: no Buffer, no node: imports.

import { utf8, b64url, concatBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import {
  REPLAY_PAST_MS, REPLAY_FUTURE_MS, BLOOM_DAYS, BLOOM_BITS, BLOOM_HASHES, COUNTER_WINDOW, DAY_MS, REPLAY_SENDER_DAY_MAX,
} from './limits.js';

const SENDERS_MAX = 20000;
const CONVS_MAX = 5000;

function u32(d, at) {
  return ((d[at] << 24) >>> 0) + (d[at + 1] << 16) + (d[at + 2] << 8) + d[at + 3];
}

function bloomIndexes(sender, id) {
  const d = sha256Sync(concatBytes(utf8.encode(sender + '|'), id));
  const h1 = u32(d, 0);
  const h2 = (u32(d, 4) | 1) >>> 0;
  const out = [];
  for (let i = 0; i < BLOOM_HASHES; i++) out.push((h1 + i * h2) % BLOOM_BITS);
  return out;
}

export class ReplayGuard {
  /** new ReplayGuard({ store?, now = () => Date.now(), key = 'mw-chat-replay' }) */
  constructor({ store = null, now = () => Date.now(), key = 'mw-chat-replay', senderDayMax = REPLAY_SENDER_DAY_MAX } = {}) {
    this.store = store;
    this.now = now;
    this.key = key;
    this.high = new Map(); // sender -> highest t
    this.floor = -1; // the newest t of a sender evicted from `high`
    this.days = new Map(); // UTC day -> Uint8Array(BLOOM_BITS / 8)
    this.convs = new Map(); // conversation -> { first, max, seen: Set<n> }
    this.counts = new Map(); // UTC day -> Map(sender -> ids accepted), in memory only
    this.senderDayMax = senderDayMax;
    this.dirty = false;
  }

  /** Restores the persisted state (ignores anything malformed). */
  async load() {
    if (!this.store || typeof this.store.get !== 'function') return false;
    let v;
    try {
      v = await this.store.get(this.key);
    } catch (_) {
      return false;
    }
    if (!v || typeof v !== 'object' || v.v !== 1) return false;
    try {
      for (const [s, t] of Object.entries(v.high || {})) if (Number.isSafeInteger(t)) this.high.set(s, t);
      if (Number.isSafeInteger(v.floor)) this.floor = v.floor;
      for (const [d, bits] of Object.entries(v.days || {})) {
        const u = b64url.decode(bits);
        if (u.length === BLOOM_BITS / 8) this.days.set(Number(d), u);
      }
      for (const [c, o] of Object.entries(v.convs || {})) {
        if (o && Number.isSafeInteger(o.first) && Number.isSafeInteger(o.max) && Array.isArray(o.seen)) {
          this.convs.set(c, { first: o.first, max: o.max, seen: new Set(o.seen.filter(Number.isSafeInteger)) });
        }
      }
    } catch (_) {
      return false;
    }
    this._expire();
    return true;
  }

  /** Persists the state when it changed. */
  async save() {
    if (!this.store || typeof this.store.set !== 'function' || !this.dirty) return false;
    this._expire();
    const high = {};
    for (const [s, t] of this.high) high[s] = t;
    const days = {};
    for (const [d, bits] of this.days) days[d] = b64url.encode(bits);
    const convs = {};
    for (const [c, o] of this.convs) convs[c] = { first: o.first, max: o.max, seen: Array.from(o.seen) };
    await this.store.set(this.key, { v: 1, high, days, convs, floor: this.floor });
    this.dirty = false;
    return true;
  }

  _expire() {
    const today = Math.floor(this.now() / DAY_MS);
    for (const d of Array.from(this.days.keys())) if (d <= today - BLOOM_DAYS || d > today + 1) this.days.delete(d);
    for (const d of Array.from(this.counts.keys())) if (d <= today - BLOOM_DAYS || d > today + 1) this.counts.delete(d);
  }

  /** True when t is inside the accepted window. */
  inWindow(t) {
    const now = this.now();
    return Number.isSafeInteger(t) && t >= now - REPLAY_PAST_MS && t <= now + REPLAY_FUTURE_MS;
  }

  _seen(sender, id, t) {
    const bits = this.days.get(Math.floor(t / DAY_MS));
    if (!bits) return false;
    for (const i of bloomIndexes(sender, id)) if (!(bits[i >>> 3] & (1 << (i & 7)))) return false;
    return true;
  }

  /**
   * check(sender, { id, t, n?, conv? }) -> { ok: true } | { ok: false, reason: 'window' | 'replay' | 'sender-cap' }. Read only.
   */
  check(sender, { id, t, n, conv }) {
    if (typeof sender !== 'string' || !(id instanceof Uint8Array)) return { ok: false, reason: 'input' };
    if (!this.inWindow(t)) return { ok: false, reason: 'window' };
    const day = Math.floor(t / DAY_MS);
    const c = this.counts.get(day);
    if (c && (c.get(sender) || 0) >= this.senderDayMax) return { ok: false, reason: 'sender-cap' };
    const hw = this.high.get(sender);
    if (hw === undefined) {
      // Nothing kept from this sender: new, unless it may have been evicted from the high-water map.
      if (t > this.floor) return { ok: true };
      return this._seen(sender, id, t) ? { ok: false, reason: 'replay' } : { ok: true };
    }
    if (t > hw) return { ok: true };
    if (conv !== undefined && Number.isSafeInteger(n) && n >= 0) {
      const o = this.convs.get(String(conv));
      if (o && n >= o.first) return o.seen.has(n) ? { ok: false, reason: 'replay' } : { ok: true };
    }
    return this._seen(sender, id, t) ? { ok: false, reason: 'replay' } : { ok: true };
  }

  /**
   * accept(sender, { id, t, n?, conv? }) -> { ok: true, gap } | { ok: false, reason }. Records the message.
   * gap is true when the conversation's counters have a hole below the highest n seen.
   */
  accept(sender, { id, t, n, conv }) {
    const c = this.check(sender, { id, t, n, conv });
    if (!c.ok) return c;
    const day = Math.floor(t / DAY_MS);
    let counts = this.counts.get(day);
    if (!counts) {
      counts = new Map();
      this.counts.set(day, counts);
    }
    counts.set(sender, (counts.get(sender) || 0) + 1);
    if (counts.size > SENDERS_MAX) counts.delete(counts.keys().next().value);
    let bits = this.days.get(day);
    if (!bits) {
      bits = new Uint8Array(BLOOM_BITS / 8);
      this.days.set(day, bits);
    }
    for (const i of bloomIndexes(sender, id)) bits[i >>> 3] |= 1 << (i & 7);
    const hw = this.high.get(sender);
    if (hw === undefined || t > hw) {
      this.high.delete(sender);
      this.high.set(sender, t);
      while (this.high.size > SENDERS_MAX) {
        const k = this.high.keys().next().value;
        const old = this.high.get(k);
        if (old > this.floor) this.floor = old;
        this.high.delete(k);
      }
    }
    this.dirty = true;
    let gap = false;
    if (conv !== undefined && Number.isSafeInteger(n) && n >= 0) gap = this._counter(String(conv), n);
    return { ok: true, gap };
  }

  _counter(conv, n) {
    let o = this.convs.get(conv);
    if (!o) {
      o = { first: 0, max: n, seen: new Set() };
      this.convs.set(conv, o);
      while (this.convs.size > CONVS_MAX) this.convs.delete(this.convs.keys().next().value);
    }
    o.seen.add(n);
    if (n > o.max) o.max = n;
    const low = Math.max(o.first, o.max - COUNTER_WINDOW + 1);
    for (const x of Array.from(o.seen)) if (x < low) o.seen.delete(x);
    if (low > o.first) o.first = low;
    return this.gap(conv);
  }

  /** True when conversation `conv` has a counter gap below its highest n. */
  gap(conv) {
    const o = this.convs.get(String(conv));
    if (!o) return false;
    for (let x = o.first; x <= o.max; x++) if (!o.seen.has(x)) return true;
    return false;
  }
}
