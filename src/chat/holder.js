// Holders and the mailbox (R 2.7.5 item 4, MF-33, MF-35, PEER B3/B4, SYB A8, STALK A1).
//   - Opt-in desktops and the pin mailbox hold only frames with the hold flag (a message delivered live
//     is never held). Peer holders hold contact-tag mail only; stranger mail (stranger flag) is held only by
//     the pin mailbox, which releases it only after INBOX-CHAL / INBOX-RESP proves the collector holds the
//     chat key.
//   - Quotas (chosen): 7 days, 64 frames per tag, 4 MiB per holder, at most 1/8 of the store from one
//     neighbour. Eviction from the largest source first and, within it, by the least stamp work, never by age.
//   - HELD answers: each tag at most once per wire per minute.
//   - COLLECTED deletes only on proof (review round, SYB-15 and HUB-8, closing O-1): contact mail carries the COLLECTED hash
//     lock in its iv (seal.js collectSecret / collectIv), and the holder deletes when SHA-256("mw-collect-v1" | proof) starts
//     with the frame's iv; stranger mail at the pin mailbox is deleted for a wire that was handed it after a valid
//     INBOX-RESP (the collector proved the chat key) in the last 10 minutes. A wire that was only handed a frame through
//     WANT-TAGS deletes nothing.
//   - Sources (review round, DS-7): the per-source quota and the eviction count by the neighbour's Noise static key when the
//     lane gives it (a reconnect or a second wire of the same key is the same source); among equal sources the one first
//     seen most recently gives way first. At most HELD_PER_WIRE_PER_MIN frames are handed to one wire a minute.
//
// Shared code: WebCrypto through seal.js, no Buffer, no node: imports.

import { hex, utf8, concatBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { publicKeyBytes, encodePublicKey } from '../chain/crypto.js';
import { T, frameId as frameIdOf } from './frames.js';
import { stampWork, utcDay } from './stamp.js';
import { inboxTag, wantMatches, hmac, listenDays, tagKey } from './tags.js';
import { generateChatKey, equalBytes } from './seal.js';
import {
  FLAG_HOLD, FLAG_STRANGER, HOLD_TTL_MS, HOLD_PER_TAG, HOLD_BYTES, HOLD_SOURCE_FRACTION, HELD_INTERVAL_MS,
  COLLECT_WINDOW_MS, FRAME_MAX, HEADER_BYTES, CHALLENGE_BYTES, HELD_PER_WIRE_PER_MIN, COLLECT_PREFIX, TAG_BYTES,
  POINT_BYTES, IV_BYTES,
} from './limits.js';

const IV_AT = HEADER_BYTES + TAG_BYTES + POINT_BYTES;

/** True when a COLLECTED proof opens the hash lock of a held frame (its iv; seal.js collectIv). Synchronous. */
export function lockOpens(frameBytes, proof) {
  if (!(proof instanceof Uint8Array) || proof.length !== 32 || !(frameBytes instanceof Uint8Array) || frameBytes.length < IV_AT + IV_BYTES) return false;
  const d = sha256Sync(concatBytes(utf8.encode(COLLECT_PREFIX), proof));
  return equalBytes(d.subarray(0, IV_BYTES), frameBytes.subarray(IV_AT, IV_AT + IV_BYTES));
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const INBOX_RESP = 'mw-inbox-resp|';

/** Collector side of INBOX-RESP: HMAC(ECDH(chatKey, hepk), "mw-inbox-resp|" + hex(challenge) + "|" + ek). */
export async function inboxProof(myChat, hepk, challenge) {
  const shared = await myChat.ecdh(hepk);
  return hmac(shared, INBOX_RESP + hex.encode(challenge) + '|' + myChat.pub);
}

/**
 * packHeld(frames) -> Uint8Array[] HELD bodies: count (1) | len (2) | frame ... each body under the frame cap.
 */
export function packHeld(frames, max = FRAME_MAX - HEADER_BYTES) {
  const out = [];
  let cur = [];
  let size = 1;
  const flush = () => {
    if (!cur.length) return;
    const parts = [Uint8Array.of(cur.length)];
    for (const f of cur) parts.push(Uint8Array.of(f.length >> 8, f.length & 255), f);
    out.push(concatBytes(...parts));
    cur = [];
    size = 1;
  };
  for (const f of frames) {
    if (2 + f.length + 1 > max) continue;
    if (size + 2 + f.length > max || cur.length >= 32) flush();
    cur.push(f);
    size += 2 + f.length;
  }
  flush();
  return out;
}

export class Holder {
  /**
   * new Holder({ quotas?, now?, pinMailbox = false })
   * quotas: { ttlMs, perTag, bytes, sourceFraction } (defaults from limits.js)
   */
  constructor({ quotas = {}, now = () => Date.now(), pinMailbox = false } = {}) {
    this.q = {
      ttlMs: quotas.ttlMs || HOLD_TTL_MS,
      perTag: quotas.perTag || HOLD_PER_TAG,
      bytes: quotas.bytes || HOLD_BYTES,
      sourceFraction: quotas.sourceFraction || HOLD_SOURCE_FRACTION,
    };
    this.now = now;
    this.pinMailbox = !!pinMailbox;
    this.items = new Map(); // frameId hex -> { id, bytes, tag, tagHex, source, work, at, expires, stranger }
    this.byTag = new Map(); // tag hex -> Set<frameId hex>
    this.bySource = new Map(); // source -> bytes
    this.total = 0;
    this.served = new Map(); // 'wire|tagHex' -> time
    this.handed = new Map(); // frameId hex -> Map(wire -> time)
    this.proven = new Map(); // frameId hex -> Map(wire -> time): handed after a valid INBOX-RESP
    this.firstSeen = new Map(); // source -> first time it deposited
    this.handedOut = new Map(); // wire -> { at, n }: frames handed in the current minute
    this.challenges = new Map(); // wire -> { challenge, eph, at }
  }

  stats() {
    return { count: this.items.size, bytes: this.total, sources: this.bySource.size };
  }

  _remove(idHex) {
    const it = this.items.get(idHex);
    if (!it) return false;
    this.items.delete(idHex);
    const set = this.byTag.get(it.tagHex);
    if (set) {
      set.delete(idHex);
      if (!set.size) this.byTag.delete(it.tagHex);
    }
    const s = (this.bySource.get(it.source) || 0) - it.bytes.length;
    if (s > 0) this.bySource.set(it.source, s);
    else this.bySource.delete(it.source);
    this.total -= it.bytes.length;
    this.handed.delete(idHex);
    this.proven.delete(idHex);
    if (!this.bySource.has(it.source)) this.firstSeen.delete(it.source);
    return true;
  }

  /** Drops expired frames and stale bookkeeping. */
  expire() {
    const t = this.now();
    for (const [id, it] of Array.from(this.items)) if (it.expires <= t) this._remove(id);
    for (const [k, at] of Array.from(this.served)) if (t - at >= HELD_INTERVAL_MS) this.served.delete(k);
    for (const [w, c] of Array.from(this.challenges)) if (t - c.at > COLLECT_WINDOW_MS) this.challenges.delete(w);
    for (const [w, h] of Array.from(this.handedOut)) if (t - h.at >= HELD_INTERVAL_MS) this.handedOut.delete(w);
  }

  _weakest(ids) {
    let best = null;
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) continue;
      if (!best || it.work < best.work || (it.work === best.work && it.at < best.at)) best = it;
    }
    return best;
  }

  _idsOfSource(source) {
    const out = [];
    for (const [id, it] of this.items) if (it.source === source) out.push(id);
    return out;
  }

  /**
   * offer(frameBytes, decoded, fromWire, sourceKey?) -> { held: true, holding: { tag, frameId, expiry } } |
   *   { held: false, reason }. decoded is frames.decode(frameBytes). sourceKey: the neighbour's Noise static key (the
   *   lane passes it), so quotas follow the neighbour across reconnects and wires; without it the wire id counts.
   */
  offer(frameBytes, decoded, fromWire, sourceKey = null) {
    this.expire();
    if (!decoded || decoded.error) return { held: false, reason: 'malformed' };
    if (decoded.type !== T.ENV && decoded.type !== T.SIG) return { held: false, reason: 'type' };
    const flags = decoded.header.flags;
    if (!(flags & FLAG_HOLD)) return { held: false, reason: 'not-flagged' };
    const stranger = !!(flags & FLAG_STRANGER);
    if (stranger && !this.pinMailbox) return { held: false, reason: 'stranger-mail' };
    const idBytes = frameIdOf(decoded);
    const idHex = hex.encode(idBytes);
    if (this.items.has(idHex)) return { held: false, reason: 'duplicate' };
    const bytes = new Uint8Array(frameBytes);
    bytes[2] = 0; // stored without the hop count
    const size = bytes.length;
    if (size > this.q.bytes) return { held: false, reason: 'too-large' };
    const work = stampWork(idBytes, decoded.header.stampNonce);
    const tag = decoded.fields.tag.slice();
    const tagHex = tagKey(tag);
    const source = sourceKey ? 'k:' + String(sourceKey) : String(fromWire);
    const sourceCap = Math.floor(this.q.bytes / this.q.sourceFraction);
    if (size > sourceCap) return { held: false, reason: 'source-quota' };
    // Per tag: replace the weakest frame of the tag only with more work.
    const tagSet = this.byTag.get(tagHex);
    if (tagSet && tagSet.size >= this.q.perTag) {
      const w = this._weakest(tagSet);
      if (!w || w.work >= work) return { held: false, reason: 'tag-quota' };
      this._remove(w.id);
    }
    // Per source: at most 1/8 of the store; replace that source's weakest frame only with more work.
    while ((this.bySource.get(source) || 0) + size > sourceCap) {
      const w = this._weakest(this._idsOfSource(source));
      if (!w || w.work >= work) return { held: false, reason: 'source-quota' };
      this._remove(w.id);
    }
    // Store: evict from the largest source first, weakest stamp first.
    while (this.total + size > this.q.bytes) {
      let largest = null;
      let largestBytes = -1;
      for (const [s, b] of this.bySource) {
        // Equal sizes: the source first seen most recently gives way (a burst of new neighbours cannot push out an older one).
        if (b > largestBytes || (b === largestBytes && (this.firstSeen.get(s) || 0) > (this.firstSeen.get(largest) || 0))) {
          largest = s;
          largestBytes = b;
        }
      }
      if (largest === null) return { held: false, reason: 'full' };
      const w = this._weakest(this._idsOfSource(largest));
      if (!w) return { held: false, reason: 'full' };
      this._remove(w.id);
    }
    const at = this.now();
    const expires = at + this.q.ttlMs;
    this.items.set(idHex, { id: idHex, bytes, tag, tagHex, source, work, at, expires, stranger });
    if (!this.byTag.has(tagHex)) this.byTag.set(tagHex, new Set());
    this.byTag.get(tagHex).add(idHex);
    this.bySource.set(source, (this.bySource.get(source) || 0) + size);
    if (!this.firstSeen.has(source)) this.firstSeen.set(source, at);
    this.total += size;
    return { held: true, holding: { tag, frameId: idBytes, expiry: Math.floor(expires / 1000) } };
  }

  _handOut(ids, wire, { proven = false } = {}) {
    const t = this.now();
    const out = [];
    const w = String(wire);
    let budget = this.handedOut.get(w);
    if (!budget || t - budget.at >= HELD_INTERVAL_MS) {
      budget = { at: t, n: 0 };
      this.handedOut.set(w, budget);
    }
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) continue;
      if (budget.n >= HELD_PER_WIRE_PER_MIN) break;
      budget.n++;
      if (proven) {
        let p = this.proven.get(id);
        if (!p) {
          p = new Map();
          this.proven.set(id, p);
        }
        p.set(w, t);
      }
      let m = this.handed.get(id);
      if (!m) {
        m = new Map();
        this.handed.set(id, m);
      }
      m.set(String(wire), t);
      out.push(it.bytes);
    }
    return out;
  }

  /**
   * want(entries, wire) -> frame bytes to answer in HELD frames. entries: 1-byte prefixes or full tags.
   * Stranger mail is never answered here. Each tag at most once per wire per minute.
   */
  want(entries, wire) {
    this.expire();
    const t = this.now();
    const ids = [];
    for (const [tagHex, set] of this.byTag) {
      const any = set.values().next().value;
      const it = this.items.get(any);
      if (!it || it.stranger) continue;
      if (!entries.some((e) => wantMatches(e, it.tag))) continue;
      const key = String(wire) + '|' + tagHex;
      const last = this.served.get(key);
      if (last !== undefined && t - last < HELD_INTERVAL_MS) continue;
      this.served.set(key, t);
      for (const id of set) if (!this.items.get(id).stranger) ids.push(id);
    }
    return this._handOut(ids, wire);
  }

  /** Pin mailbox: a fresh INBOX-CHAL for a wire -> { challenge, hepk } (null when not a mailbox). */
  async challenge(wire) {
    if (!this.pinMailbox) return null;
    const eph = await generateChatKey();
    const challenge = randomBytes(CHALLENGE_BYTES);
    this.challenges.set(String(wire), { challenge, eph, at: this.now() });
    return { challenge, hepk: publicKeyBytes(eph.pub) };
  }

  /**
   * respond(wire, { ek, proof }) -> frame bytes of the stranger mail for ek (day - 1 to day + 1), or null when
   * the proof fails. One answer per challenge.
   */
  async respond(wire, { ek, proof }) {
    const c = this.challenges.get(String(wire));
    if (!c) return null;
    this.challenges.delete(String(wire));
    if (this.now() - c.at > COLLECT_WINDOW_MS) return null;
    let ekStr;
    try {
      ekStr = encodePublicKey(ek);
    } catch (_) {
      return null;
    }
    const shared = await c.eph.ecdh(ek);
    const expect = await hmac(shared, INBOX_RESP + hex.encode(c.challenge) + '|' + ekStr);
    if (!equalBytes(expect, proof)) return null;
    const day = utcDay(this.now());
    // Exact inbox tags only. Blinded stranger frames (one byte of the inbox tag on the wire, STALK-7) can be told apart only
    // by that byte; releasing a whole 1-in-256 bucket here waits until the pin mailbox has a sender (ROADMAP; review round
    // note in docs/deviations/review-round-chat.md). Peer holders never hold stranger mail.
    const ids = [];
    for (const d of listenDays(day)) {
      const set = this.byTag.get(tagKey(await inboxTag(ekStr, d)));
      if (set) for (const id of set) ids.push(id);
    }
    return this._handOut(ids, wire, { proven: true });
  }

  /**
   * COLLECTED: deletes the frame when the proof opens its hash lock (contact mail), or, for stranger mail, when this wire
   * was handed it after a valid INBOX-RESP in the last 10 minutes. Anything else deletes nothing (SYB-15, HUB-8).
   */
  collected(frameIdBytes, proof, wire) {
    const idHex = hex.encode(frameIdBytes);
    const it = this.items.get(idHex);
    if (!it) return false;
    if (!(proof instanceof Uint8Array) || proof.length !== 32) return false;
    if (lockOpens(it.bytes, proof)) return this._remove(idHex);
    if (!it.stranger) return false;
    const m = this.proven.get(idHex);
    const at = m && m.get(String(wire));
    if (at === undefined || this.now() - at > COLLECT_WINDOW_MS) return false;
    return this._remove(idHex);
  }

  /** True when the holder keeps a frame. */
  has(frameIdBytes) {
    return this.items.has(hex.encode(frameIdBytes));
  }

  clear() {
    this.items.clear();
    this.byTag.clear();
    this.bySource.clear();
    this.total = 0;
    this.served.clear();
    this.handed.clear();
    this.proven.clear();
    this.firstSeen.clear();
    this.handedOut.clear();
    this.challenges.clear();
  }
}

