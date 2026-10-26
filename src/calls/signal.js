// SIG payloads and control messages of a call (SZ 3.5 "Signalling" and "Flow"). This module never sees keys or
// frames: src/chat/service.js seals the body with K_pair under plaintext kind sig (5) into a SIG frame (0x0B).
//
//   body = { v: 1, c: <callId: 16 bytes b64url>, k: 'ring'|'accept'|'decline'|'busy'|'offer'|'answer'|'ice'|'hangup'|'leave',
//            s: <seq>, t, sdp?, cand?: [<= 16], media?: { a, v, s }, roster?: [<= 5 pubs], g?: <groupId> }
//
// Bounds (decodeSignal never throws; anything off is { ok: false, reason }):
//   - the body at most 15,000 bytes of UTF-8 JSON, an object with known keys only;
//   - sdp only on offer and answer, and required there: at most 14,000 bytes, starting 'v=0', every fingerprint line
//     'a=fingerprint:sha-256 ...' and at least one (the binding of SZ 3.5: the DTLS fingerprint travels sealed);
//   - cand only on ice, and required there: 1 to 16 strings 'candidate:...', each at most 512 bytes, no line breaks;
//   - media { a, v, s } booleans (required on ring and accept), roster at most 5 distinct p256: keys, g a group id.
// SignalGuard: duplicates dropped by (sender, call, seq), seq far below the sender's highest dropped, t within 60 s.
// RingLimiter: one pending ring per contact and at most 10 rings an hour (both chosen).
// Control messages travel on the negotiated data channel 'mw-call' (id 0), at most 16 KiB of JSON:
//   { t: 'state', mute?, camera?, screen? } | { t: 'roster', pubs: [<= 5], cks?: [<= 5 CK records] } | { t: 'leave' }
//   | { t: 'desc', type: 'offer'|'answer', sdp } | { t: 'cand', cand: [<= 16] }
//
// Shared code: Node >= 22 and browsers.

import { utf8, b64url } from '../chain/canonical.js';
import { isPublicKeyString } from '../chain/crypto.js';
import { BUCKETS, PT_FIXED, CK_MAX } from '../chat/limits.js';
import {
  SIG_VERSION, SIG_KINDS, CALL_ID_BYTES, PAYLOAD_MAX, SDP_MAX, FINGERPRINT_ATTR, CAND_MAX, CAND_BYTES_MAX, ROSTER_MAX,
  GROUP_ID_MAX, T_SKEW_MS, SEQ_WINDOW, GUARD_CALLS_MAX, RINGS_PER_HOUR, RING_WINDOW_MS, RINGS_PENDING_PER_CONTACT,
  RING_TTL_MS, CONTROL_MAX, CONTROL_TYPES, ROSTER_CK_MAX,
} from './limits.js';

const KEY_ORDER = ['v', 'c', 'k', 's', 't', 'sdp', 'cand', 'media', 'roster', 'g'];
/** Optional fields each kind may carry (sdp and cand are required where listed in REQUIRED). */
const FIELDS = Object.freeze({
  ring: ['media', 'roster', 'g'],
  accept: ['media', 'g'],
  decline: ['g'],
  busy: ['g'],
  offer: ['sdp', 'media', 'roster', 'g'],
  answer: ['sdp', 'media', 'g'],
  ice: ['cand', 'g'],
  hangup: ['g'],
  leave: ['g'],
});
const REQUIRED = Object.freeze({ ring: ['media'], accept: ['media'], offer: ['sdp'], answer: ['sdp'], ice: ['cand'] });
const GROUP_RE = /^[A-Za-z0-9_-]+$/;
const CAND_RE = /^candidate:[\x20-\x7e]+$/;
const FP_LINE_RE = /^a=fingerprint:([^ ]+) ([0-9A-Fa-f:]+)$/;

function fail(reason) {
  return { ok: false, reason };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function byteLen(s) {
  return utf8.encode(s).length;
}

/** True when s is the b64url spelling of exactly 16 bytes (a call id). */
export function isCallId(s) {
  if (typeof s !== 'string' || s.length !== 22) return false;
  try {
    return b64url.decode(s).length === CALL_ID_BYTES;
  } catch (_) {
    return false;
  }
}

/** A fresh call id: 16 random bytes, b64url. */
export function newCallId() {
  const u = new Uint8Array(CALL_ID_BYTES);
  globalThis.crypto.getRandomValues(u);
  return b64url.encode(u);
}

export function isGroupId(g) {
  return typeof g === 'string' && g.length > 0 && g.length <= GROUP_ID_MAX && GROUP_RE.test(g);
}

/** fingerprintsOf(sdp) -> ['AB:CD:...'] (sha-256 lines only, uppercase), or null when any fingerprint line is not sha-256. */
export function fingerprintsOf(sdp) {
  if (typeof sdp !== 'string') return null;
  const out = [];
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('a=fingerprint:')) continue;
    const m = FP_LINE_RE.exec(line);
    if (!m || m[1].toLowerCase() !== 'sha-256') return null;
    const fp = normalizeFingerprint(m[2]);
    if (!fp) return null;
    out.push(fp);
  }
  return out;
}

/** 'ab:cd:..' or 'ABCD..' -> 'AB:CD:..' (32 bytes for sha-256), or null. */
export function normalizeFingerprint(fp) {
  if (typeof fp !== 'string') return null;
  const hexOnly = fp.replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hexOnly)) return null;
  return hexOnly.match(/../g).join(':');
}

/** checkSdp(sdp) -> { ok, fingerprints } | { ok: false, reason }: the SDP rules of an offer or an answer. */
export function checkSdp(sdp) {
  if (typeof sdp !== 'string' || sdp.length === 0) return fail('sdp');
  if (byteLen(sdp) > SDP_MAX) return fail('sdp-size');
  if (!sdp.startsWith('v=0')) return fail('sdp-version');
  if (/[\u0000]/.test(sdp)) return fail('sdp-char');
  if (sdp.indexOf(FINGERPRINT_ATTR + ' ') < 0) return fail('sdp-fingerprint');
  const fps = fingerprintsOf(sdp);
  if (!fps || fps.length === 0) return fail('sdp-fingerprint');
  for (const f of fps) if (f !== fps[0]) return fail('sdp-fingerprints-differ');
  return { ok: true, fingerprints: fps };
}

function checkCand(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > CAND_MAX) return 'cand';
  for (const c of list) {
    if (typeof c !== 'string' || !CAND_RE.test(c) || byteLen(c) > CAND_BYTES_MAX) return 'cand';
  }
  return null;
}

function checkMedia(m) {
  if (!isPlainObject(m)) return 'media';
  for (const k of Object.keys(m)) {
    if (k !== 'a' && k !== 'v' && k !== 's') return 'media';
    if (typeof m[k] !== 'boolean') return 'media';
  }
  return null;
}

function checkRoster(r) {
  if (!Array.isArray(r) || r.length > ROSTER_MAX) return 'roster';
  const seen = new Set();
  for (const p of r) {
    if (!isPublicKeyString(p) || seen.has(p)) return 'roster';
    seen.add(p);
  }
  return null;
}

/** validateSignal(msg) -> { ok: true } | { ok: false, reason }. */
export function validateSignal(msg) {
  if (!isPlainObject(msg)) return fail('shape');
  for (const k of Object.keys(msg)) if (KEY_ORDER.indexOf(k) < 0) return fail('key:' + k);
  if (msg.v !== SIG_VERSION) return fail('version');
  if (!isCallId(msg.c)) return fail('call-id');
  if (SIG_KINDS.indexOf(msg.k) < 0) return fail('kind');
  if (!Number.isSafeInteger(msg.s) || msg.s < 0) return fail('seq');
  if (!Number.isSafeInteger(msg.t) || msg.t < 0) return fail('t');
  const allowed = FIELDS[msg.k];
  for (const k of ['sdp', 'cand', 'media', 'roster', 'g']) {
    if (msg[k] === undefined) continue;
    if (allowed.indexOf(k) < 0) return fail('field:' + k);
  }
  for (const k of REQUIRED[msg.k] || []) if (msg[k] === undefined) return fail('missing:' + k);
  if (msg.sdp !== undefined) {
    const s = checkSdp(msg.sdp);
    if (!s.ok) return s;
  }
  if (msg.cand !== undefined) {
    const e = checkCand(msg.cand);
    if (e) return fail(e);
  }
  if (msg.media !== undefined) {
    const e = checkMedia(msg.media);
    if (e) return fail(e);
  }
  if (msg.roster !== undefined) {
    const e = checkRoster(msg.roster);
    if (e) return fail(e);
  }
  if (msg.g !== undefined && !isGroupId(msg.g)) return fail('group');
  return { ok: true };
}

function ordered(msg, keys) {
  const out = {};
  for (const k of keys) if (msg[k] !== undefined) out[k] = msg[k];
  return out;
}

/**
 * encodeSignal(msg) -> Uint8Array: the body in the fixed key order. Local input: TypeError when it is malformed,
 * { code: 'E_LIMIT' } when it is over 15,000 bytes.
 */
export function encodeSignal(msg) {
  const r = validateSignal(msg);
  if (!r.ok) throw new TypeError('encodeSignal: ' + r.reason);
  const bytes = utf8.encode(JSON.stringify(ordered(msg, KEY_ORDER)));
  if (bytes.length > PAYLOAD_MAX) throw Object.assign(new Error('call message over ' + PAYLOAD_MAX + ' bytes'), { code: 'E_LIMIT' });
  return bytes;
}

/** decodeSignal(bytes | string) -> { ok: true, msg } | { ok: false, reason }. Never throws. */
export function decodeSignal(input) {
  try {
    let bytes = input;
    if (typeof input === 'string') bytes = utf8.encode(input);
    if (!(bytes instanceof Uint8Array)) return fail('bytes');
    if (bytes.length === 0 || bytes.length > PAYLOAD_MAX) return fail('size');
    let msg;
    try {
      msg = JSON.parse(utf8.decode(bytes, { fatal: true }));
    } catch (_) {
      return fail('json');
    }
    const r = validateSignal(msg);
    if (!r.ok) return r;
    return { ok: true, msg };
  } catch (_) {
    return fail('decode');
  }
}

/** The sealed-box bucket (src/chat/seal.js) a body of n bytes lands in, or null when none holds it. */
export function bucketFor(n) {
  const need = PT_FIXED + n;
  for (const b of BUCKETS) if (need <= b) return b;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Duplicates, replays and ring limits
// ---------------------------------------------------------------------------------------------

export class SignalGuard {
  /** new SignalGuard({ now, skewMs = 60 s, window = 256, max = 512 }) */
  constructor({ now = () => Date.now(), skewMs = T_SKEW_MS, window = SEQ_WINDOW, max = GUARD_CALLS_MAX } = {}) {
    this.now = now;
    this.skewMs = skewMs;
    this.window = window;
    this.max = max;
    this.calls = new Map(); // from|c -> { high, seen: Set }
  }

  /** check(from, msg) -> { ok } | { ok: false, reason: 'skew' | 'dup' | 'old' | 'input' }. Read only. */
  check(from, msg) {
    if (typeof from !== 'string' || !msg || !isCallId(msg.c) || !Number.isSafeInteger(msg.s)) return fail('input');
    if (!Number.isSafeInteger(msg.t) || Math.abs(this.now() - msg.t) > this.skewMs) return fail('skew');
    const e = this.calls.get(from + '|' + msg.c);
    if (!e) return { ok: true };
    if (e.seen.has(msg.s)) return fail('dup');
    if (msg.s < e.high - this.window) return fail('old');
    return { ok: true };
  }

  /** accept(from, msg) -> as check(), and records the message when it passes. */
  accept(from, msg) {
    const r = this.check(from, msg);
    if (!r.ok) return r;
    const key = from + '|' + msg.c;
    let e = this.calls.get(key);
    if (!e) {
      e = { high: msg.s, seen: new Set() };
      this.calls.set(key, e);
      while (this.calls.size > this.max) this.calls.delete(this.calls.keys().next().value);
    } else {
      this.calls.delete(key);
      this.calls.set(key, e); // most recently used last
    }
    e.seen.add(msg.s);
    if (msg.s > e.high) e.high = msg.s;
    const low = e.high - this.window;
    if (e.seen.size > this.window * 2) for (const s of Array.from(e.seen)) if (s < low) e.seen.delete(s);
    return { ok: true };
  }

  /** Forgets every sender's state for a call. */
  forget(callId) {
    for (const k of Array.from(this.calls.keys())) if (k.endsWith('|' + callId)) this.calls.delete(k);
  }
}

export class RingLimiter {
  /** new RingLimiter({ now, perHour = 10, windowMs = 1 h, pending = 1, ttlMs = 45 s }) */
  constructor({ now = () => Date.now(), perHour = RINGS_PER_HOUR, windowMs = RING_WINDOW_MS, pending = RINGS_PENDING_PER_CONTACT, ttlMs = RING_TTL_MS } = {}) {
    this.now = now;
    this.perHour = perHour;
    this.windowMs = windowMs;
    this.pendingMax = pending;
    this.ttlMs = ttlMs;
    this.times = new Map(); // pub -> [t]
    this.pending = new Map(); // pub -> Map(callId -> at)
  }

  _prune(pub) {
    const t = this.now();
    const times = (this.times.get(pub) || []).filter((x) => t - x < this.windowMs);
    if (times.length) this.times.set(pub, times);
    else this.times.delete(pub);
    const p = this.pending.get(pub);
    if (p) {
      for (const [id, at] of p) if (t - at >= this.ttlMs) p.delete(id);
      if (!p.size) this.pending.delete(pub);
    }
    return times;
  }

  /** check(pub) -> { ok } | { ok: false, reason: 'pending' | 'rate' }. */
  check(pub) {
    const times = this._prune(pub);
    const p = this.pending.get(pub);
    if (p && p.size >= this.pendingMax) return fail('pending');
    if (times.length >= this.perHour) return fail('rate');
    return { ok: true };
  }

  /** add(pub, callId) -> { ok } | { ok: false, reason }: records a ring when it is allowed. */
  add(pub, callId) {
    const r = this.check(pub);
    if (!r.ok) return r;
    const t = this.now();
    this.times.set(pub, (this.times.get(pub) || []).concat([t]));
    if (!this.pending.has(pub)) this.pending.set(pub, new Map());
    this.pending.get(pub).set(callId, t);
    return { ok: true };
  }

  /** The ring was answered, refused or expired: it no longer counts as pending (it still counts for the hour). */
  done(pub, callId) {
    const p = this.pending.get(pub);
    if (p) {
      p.delete(callId);
      if (!p.size) this.pending.delete(pub);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Control messages (the 'mw-call' data channel)
// ---------------------------------------------------------------------------------------------

const CONTROL_FIELDS = Object.freeze({
  state: ['mute', 'camera', 'screen'],
  roster: ['pubs', 'cks'],
  leave: [],
  desc: ['type', 'sdp'],
  cand: ['cand'],
});

/** validateControl(obj) -> { ok } | { ok: false, reason }. */
export function validateControl(obj) {
  if (!isPlainObject(obj)) return fail('shape');
  if (CONTROL_TYPES.indexOf(obj.t) < 0) return fail('type');
  const allowed = CONTROL_FIELDS[obj.t];
  for (const k of Object.keys(obj)) if (k !== 't' && allowed.indexOf(k) < 0) return fail('key:' + k);
  switch (obj.t) {
    case 'state':
      for (const k of allowed) if (obj[k] !== undefined && typeof obj[k] !== 'boolean') return fail('state');
      return { ok: true };
    case 'roster': {
      const e = checkRoster(obj.pubs);
      if (e || obj.pubs === undefined) return fail('roster');
      if (obj.cks !== undefined) {
        if (!Array.isArray(obj.cks) || obj.cks.length > ROSTER_CK_MAX) return fail('cks');
        for (const ck of obj.cks) {
          if (!isPlainObject(ck)) return fail('cks');
          let n;
          try { n = byteLen(JSON.stringify(ck)); } catch (_) { return fail('cks'); }
          if (n > CK_MAX) return fail('cks');
        }
      }
      return { ok: true };
    }
    case 'leave':
      return { ok: true };
    case 'desc': {
      if (obj.type !== 'offer' && obj.type !== 'answer') return fail('desc-type');
      const s = checkSdp(obj.sdp);
      return s.ok ? { ok: true } : s;
    }
    case 'cand': {
      const e = checkCand(obj.cand);
      return e ? fail(e) : { ok: true };
    }
    default:
      return fail('type');
  }
}

/** encodeControl(obj) -> string (JSON). TypeError when malformed or over 16 KiB. */
export function encodeControl(obj) {
  const r = validateControl(obj);
  if (!r.ok) throw new TypeError('encodeControl: ' + r.reason);
  const s = JSON.stringify(obj);
  if (byteLen(s) > CONTROL_MAX) throw new TypeError('encodeControl: over ' + CONTROL_MAX + ' bytes');
  return s;
}

/** decodeControl(string | bytes) -> { ok: true, msg } | { ok: false, reason }. Never throws. */
export function decodeControl(data) {
  try {
    let text = data;
    if (data instanceof ArrayBuffer) text = utf8.decode(new Uint8Array(data), { fatal: true });
    else if (data instanceof Uint8Array) text = utf8.decode(data, { fatal: true });
    if (typeof text !== 'string' || text.length === 0) return fail('type');
    if (byteLen(text) > CONTROL_MAX) return fail('size');
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return fail('json');
    }
    const r = validateControl(obj);
    return r.ok ? { ok: true, msg: obj } : r;
  } catch (_) {
    return fail('decode');
  }
}
