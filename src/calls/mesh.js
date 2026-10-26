// Who connects to whom in a call (SZ 3.5 "Scope" and "Flow and IP exposure"). A call of two is a mesh of two.
//
//   - The caller rings each invitee; each one who accepts gets an offer from the caller. The caller keeps the roster
//     (who accepted) and sends it in each offer and over the control channel whenever it changes.
//   - Every other pair connects once, the lower public key offering (keys compare as their 'p256:' strings).
//   - Perfect negotiation: the higher public key of a pair is the polite side.
//   - Caps (chosen, SZ-4): 6 people with audio only, 4 when the call has video; everyone counts, the caller too.
//   - A leaver's pairs close within 5 s: at once on its 'leave', or when the caller's next roster leaves it out.
//
// Mesh holds the participants of one call as this tab sees them; it makes no connection and sends nothing, so the
// rules are testable without WebRTC.
//
// Shared code: Node >= 22 and browsers.

import { CAP_AUDIO, CAP_VIDEO, ROSTER_MAX } from './limits.js';

function fail(code, msg) {
  return Object.assign(new Error(msg), { code });
}

/** -1, 0 or 1 by plain string order of two 'p256:' keys (the same order on every device). */
export function compareKeys(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/** The polite side of a pair (perfect negotiation): the higher public key. */
export function politeFor(me, them) {
  return compareKeys(me, them) > 0;
}

/** The side that offers in a pair of two non-callers: the lower public key. */
export function offererOf(a, b) {
  return compareKeys(a, b) < 0 ? a : b;
}

/** capFor(video) -> people allowed in a call, oneself included. */
export function capFor(video) {
  return video ? CAP_VIDEO : CAP_AUDIO;
}

/** checkCap(people, video): throws E_LIMIT when `people` (oneself included) is over the cap. */
export function checkCap(people, video) {
  const cap = capFor(video);
  if (people > cap) throw fail('E_LIMIT', 'a call ' + (video ? 'with video ' : '') + 'has at most ' + cap + ' people');
  return cap;
}

const LIVE = new Set(['ringing', 'connecting', 'direct', 'relayed', 'reconnecting']);
const JOINED = new Set(['connecting', 'direct', 'relayed', 'reconnecting']);

export class Mesh {
  /** new Mesh({ me, caller, video = false, now }) */
  constructor({ me, caller, video = false, now = () => Date.now() }) {
    if (typeof me !== 'string' || typeof caller !== 'string') throw new TypeError('Mesh needs me and caller');
    this.me = me;
    this.caller = caller;
    this.video = !!video;
    this.now = now;
    this.people = new Map(); // pub -> { pub, state, reason, since, accepted }
    this.roster = new Set(); // callee side: the others the caller named (not the caller, not me)
  }

  get isCaller() {
    return this.me === this.caller;
  }

  /** add(pub, state) -> participant (an existing one keeps its entry). */
  add(pub, state = 'ringing') {
    if (pub === this.me) return null;
    let p = this.people.get(pub);
    if (!p) {
      p = { pub, state, reason: null, since: this.now(), accepted: JOINED.has(state) };
      this.people.set(pub, p);
    }
    return p;
  }

  get(pub) {
    return this.people.get(pub) || null;
  }

  /** set(pub, state, reason?) -> true when the state changed. A participant who left stays left. */
  set(pub, state, reason = null) {
    const p = this.people.get(pub);
    if (!p) return false;
    if (p.state === 'left' && state !== 'left') return false;
    if (p.state === state && (state !== 'left' || p.reason === reason)) return false;
    p.state = state;
    p.since = this.now();
    if (JOINED.has(state)) p.accepted = true;
    if (state === 'left') p.reason = reason || p.reason || 'hangup';
    return true;
  }

  /** The people other than me who are ringing, connecting or connected. */
  live() {
    return Array.from(this.people.values()).filter((p) => LIVE.has(p.state)).map((p) => p.pub);
  }

  /** Those who accepted and have not left. */
  joined() {
    return Array.from(this.people.values()).filter((p) => JOINED.has(p.state)).map((p) => p.pub);
  }

  ringing() {
    return Array.from(this.people.values()).filter((p) => p.state === 'ringing').map((p) => p.pub);
  }

  /** People in the call as it stands, me included (for the caps). */
  count() {
    return 1 + this.live().length;
  }

  /** A mesh (three or more people) rather than a call of two: the media rates follow it. */
  isMesh() {
    return this.count() > 2;
  }

  /** Caller side: the roster to send to `pub` (everyone who joined, without pub), at most 5, in key order. */
  rosterFor(pub) {
    return this.joined().filter((p) => p !== pub).sort(compareKeys).slice(0, ROSTER_MAX);
  }

  /**
   * Callee side: the caller's roster arrived. Returns { add: [pub], drop: [pub] }: people to connect to and pairs to
   * close (people the caller no longer names). The caller and I are never in either list.
   */
  applyRoster(pubs) {
    const next = new Set((pubs || []).filter((p) => p !== this.me && p !== this.caller).slice(0, ROSTER_MAX));
    const add = [];
    const drop = [];
    for (const p of next) if (!this.roster.has(p)) add.push(p);
    for (const p of this.roster) if (!next.has(p)) drop.push(p);
    this.roster = next;
    for (const p of add) {
      const e = this.add(p, 'connecting');
      if (e && e.state === 'left') e.reason = e.reason || 'hangup';
    }
    for (const p of drop) this.set(p, 'left', 'hangup');
    return { add: add.sort(compareKeys), drop: drop.sort(compareKeys) };
  }

  /** May `pub` take part in this call as this tab knows it (the caller, an invitee, or someone the caller named)? */
  isMember(pub) {
    if (pub === this.caller) return true;
    const p = this.people.get(pub);
    return !!p && p.state !== 'left';
  }

  /** Does this tab make the offer in its pair with `pub`? The caller offers to everyone; others by key order. */
  shouldOffer(pub) {
    if (this.isCaller) return true;
    if (pub === this.caller) return false;
    return offererOf(this.me, pub) === this.me;
  }

  /** True when nobody is ringing, connecting or connected any more. */
  finished() {
    return this.live().length === 0;
  }

  /** [{ pub, state, reason }] in key order. */
  list() {
    return Array.from(this.people.values()).sort((a, b) => compareKeys(a.pub, b.pub)).map((p) => ({ pub: p.pub, state: p.state, reason: p.reason }));
  }
}
