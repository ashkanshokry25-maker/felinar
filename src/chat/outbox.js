// Sender outbox and receiver ACKs (R 2.7.5 items 2, 3 and 6; MF-35, MF-46, PRIV M3).
//   - A contact message goes out without the hold flag. When no ACK arrives within 30 s (chosen), or the
//     person chose "Deliver later", it is sent again with the hold flag so holders and the pin mailbox may
//     keep it; a message delivered live is never held (E-CH-9).
//   - The outbox retries while the page is open (every 60 s, chosen); destroy() (page closing) ends the
//     retries and reports what never left as 'not-delivered'. The service seals one copy per message per UTC day
//     (e.cache: the same frame, so holders that dedupe by frameId keep it once).
//   - Review round (DS-5, MP-7, SYB-17): 'handed' is information only. A HOLDING proves nothing (any neighbour that saw the
//     frame can send one), so the held copy keeps going out, every 5 minutes once a neighbour took it or a HOLDING came,
//     every minute while nobody was reachable, until the ACK arrives or the outbox stops.
//   - HOLDING frames carry no proof of who holds the frame: each neighbour wire counts at most once per message,
//     so 'handed' is the number of neighbours that reported holding it (code review v0.3).
//   - Delivery states, exactly: 'delivered' (sealed ACK came back), 'handed' (HOLDING frames: "N peers
//     reported holding it at 14:02. They may go offline."; code review v0.3 round 2: HOLDING is unauthenticated), 'outbox' (in the outbox, retrying while this page is open),
//     'sent-unknown' (strangers get no ACK: "Sent to the network. You will not know if it arrived until
//     they reply."), 'not-delivered' (nobody who could hold it was reachable before the outbox stopped).
//   - The receiver ACKs a contact's message after a random 2 to 20 s delay, batched per contact.
//
// Shared code: no imports beyond limits.js and tags.js (secureRandom).

import {
  ACK_TIMEOUT_MS, ACK_DELAY_MIN_MS, ACK_DELAY_MAX_MS, OUTBOX_RETRY_MS, OUTBOX_MAX,
} from './limits.js';
import { secureRandom } from './tags.js';

export const STATES = Object.freeze(['delivered', 'handed', 'outbox', 'sent-unknown', 'not-delivered']);

function timers(t) {
  return {
    set: (t && t.setTimeout) || ((fn, ms) => setTimeout(fn, ms)),
    clear: (t && t.clearTimeout) || ((h) => clearTimeout(h)),
  };
}

export class Outbox {
  /**
   * new Outbox({ send, onState, now, setTimeout, clearTimeout })
   *   send(entry, { hold }) -> Promise<{ reached: number }>: seals and sends one copy; reached is the number
   *   of wires it went out on (0 when nobody is connected).
   *   onState(entry): called on every state change; entry = { id, to, state, handed, handedAt, stranger }.
   */
  constructor({ send, onState = () => {}, now = () => Date.now(), setTimeout: st, clearTimeout: ct } = {}) {
    if (typeof send !== 'function') throw new TypeError('Outbox needs send(entry, { hold })');
    this.sendFn = send;
    this.onState = onState;
    this.now = now;
    this.t = timers({ setTimeout: st, clearTimeout: ct });
    this.entries = new Map(); // id -> entry
    this.byFrame = new Map(); // frameId hex -> id
    this.destroyed = false;
  }

  _set(e, state) {
    if (e.state === state && state !== 'handed') return;
    e.state = state;
    try { this.onState(Object.assign({}, e)); } catch (_) { /* a listener must not break the outbox */ }
  }

  _timer(e, ms, fn) {
    if (e.timer) this.t.clear(e.timer);
    e.timer = this.t.set(() => {
      e.timer = null;
      fn();
    }, ms);
  }

  /**
   * add({ id, to, stranger = false, deliverLater = false, payload }) -> Promise<entry>. Sends at once.
   * Throws { code: 'E_LIMIT' } when the outbox is full.
   */
  async add({ id, to, stranger = false, deliverLater = false, payload = null }) {
    if (this.destroyed) throw Object.assign(new Error('chat is off'), { code: 'E_POLICY' });
    let pending = 0;
    for (const e of this.entries.values()) if (e.state === 'outbox') pending++;
    if (pending >= OUTBOX_MAX) throw Object.assign(new Error('too many messages waiting to be sent'), { code: 'E_LIMIT' });
    const e = { id, to, stranger: !!stranger, deliverLater: !!deliverLater, payload, state: null, handed: 0, handedAt: null, attempts: 0, held: false, timer: null, frames: [], holders: new Set(), cache: null };
    this.entries.set(id, e);
    await this._attempt(e, e.deliverLater);
    return Object.assign({}, e);
  }

  async _attempt(e, hold) {
    if (this.destroyed || e.state === 'delivered') return;
    e.attempts++;
    let reached = 0;
    try {
      const r = await this.sendFn(e, { hold });
      reached = (r && r.reached) || 0;
      if (r && r.frameId) {
        if (e.frames.indexOf(r.frameId) < 0) e.frames.push(r.frameId);
        this.byFrame.set(r.frameId, e.id);
      }
    } catch (_) {
      reached = 0;
    }
    if (hold && reached > 0) e.held = true;
    if (e.stranger) {
      this._set(e, 'sent-unknown');
      if (!hold) this._timer(e, ACK_TIMEOUT_MS, () => this._attempt(e, true));
      else if (reached === 0) this._timer(e, OUTBOX_RETRY_MS, () => this._attempt(e, true));
      return;
    }
    if (e.state !== 'handed') this._set(e, 'outbox');
    if (!hold) this._timer(e, ACK_TIMEOUT_MS, () => this._attempt(e, true));
    else this._timer(e, reached > 0 || e.handed > 0 ? OUTBOX_RETRY_MS * 5 : OUTBOX_RETRY_MS, () => this._attempt(e, true));
  }

  /** A sealed ACK arrived for message ids. */
  ack(ids) {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e || e.stranger) continue;
      if (e.timer) this.t.clear(e.timer);
      e.timer = null;
      e.cache = null;
      this._set(e, 'delivered');
    }
  }

  /**
   * A HOLDING came back for one of our frames (frameId hex) over neighbour wire `wire`: each wire counts once per
   * message (a HOLDING is unauthenticated, so one neighbour cannot make the count grow); null when nothing changed.
   */
  holding(frameIdHex, wire) {
    const id = this.byFrame.get(frameIdHex);
    const e = id && this.entries.get(id);
    if (!e || e.state === 'delivered' || e.stranger) return null;
    if (wire !== undefined && wire !== null) {
      const w = String(wire);
      if (e.holders.has(w)) return null;
      e.holders.add(w);
    }
    e.handed++;
    e.handedAt = this.now();
    this._set(e, 'handed');
    return Object.assign({}, e);
  }

  /** The person retries one message now. */
  retry(id) {
    const e = this.entries.get(id);
    if (!e || e.state === 'delivered') return false;
    this._attempt(e, true);
    return true;
  }

  get(id) {
    const e = this.entries.get(id);
    return e ? Object.assign({}, e, { holders: Array.from(e.holders), cache: undefined }) : null;
  }

  /** Page closing or chat off: stop retrying; messages that never left become 'not-delivered'. */
  destroy() {
    this.destroyed = true;
    for (const e of this.entries.values()) {
      if (e.timer) this.t.clear(e.timer);
      e.timer = null;
      if (e.state === 'outbox' && !e.held) this._set(e, 'not-delivered');
    }
  }
}

/** AckBatcher: one sealed ACK per contact, sent 2 to 20 s after the first unacknowledged message. */
export class AckBatcher {
  constructor({ sendAcks, random = secureRandom, setTimeout: st, clearTimeout: ct, max = 64 } = {}) {
    if (typeof sendAcks !== 'function') throw new TypeError('AckBatcher needs sendAcks(to, ids)');
    this.sendAcks = sendAcks;
    this.random = random;
    this.t = timers({ setTimeout: st, clearTimeout: ct });
    this.max = max;
    this.pending = new Map(); // to -> { ids: [], timer }
  }

  /** delay() -> ms in [2 s, 20 s]. */
  delay() {
    return ACK_DELAY_MIN_MS + Math.floor(this.random() * (ACK_DELAY_MAX_MS - ACK_DELAY_MIN_MS + 1));
  }

  queue(to, id) {
    let p = this.pending.get(to);
    if (!p) {
      p = { ids: [], timer: null };
      this.pending.set(to, p);
      p.timer = this.t.set(() => this._flush(to), this.delay());
    }
    if (p.ids.indexOf(id) < 0) p.ids.push(id);
    if (p.ids.length >= this.max) this._flush(to);
  }

  _flush(to) {
    const p = this.pending.get(to);
    if (!p) return;
    this.pending.delete(to);
    if (p.timer) this.t.clear(p.timer);
    Promise.resolve().then(() => this.sendAcks(to, p.ids)).catch(() => {});
  }

  destroy() {
    for (const p of this.pending.values()) if (p.timer) this.t.clear(p.timer);
    this.pending.clear();
  }
}
