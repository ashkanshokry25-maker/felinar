// mw_chat1 frame codec (R 2.7.3, MF-32, MF-43). Binary frames, at most FRAME_MAX bytes:
//
//   clear header (14): type (1) | version (1) | hop (1) | flags (1) | day (2, big-endian) | stampNonce (8)
//   body: bounded per type (the table in R 2.7.3)
//
// frameId = SHA-256(type | version | flags | day | body): the hop byte and the stamp nonce are outside the
// hashed bytes, so a relay can raise the hop without changing the id, and the stamp (stamp.js) binds the
// frame through the id. decode() never throws: anything malformed returns { error } and the caller
// strikes the wire (not a peer id). encode() is for local data and throws TypeError on bad input.
//
// Shared code: Node >= 22 and browsers, no Buffer, no node: imports.

import { utf8, b64url, concatBytes, asBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { isPublicKeyString } from '../chain/crypto.js';
import {
  FRAME_MAX, FRAME_VERSION, HEADER_BYTES, FLAG_MASK, HELLO_MAX, HELLO_LANES_MAX, LANE_NAME_MAX, XX_MAX,
  TAG_BYTES, POINT_BYTES, IV_BYTES, CT_LENGTHS, ENV_FIXED, ROOM_NAME_MAX, ROOM_TEXT_MAX, ROOM_ID_BYTES,
  ROOM_BODY_MAX, WANT_MAX, HELD_MAX_ITEMS, CK_MAX, FRAME_ID_BYTES, PROOF_BYTES, PRES_SLOTS, PRES_SLOT_BYTES,
  PRES_AUTH_BYTES, PRES_BODY, CHALLENGE_BYTES, HOLDING_BODY, HOP_MAX_ENV, HOP_MAX_ROOM, NONCE_BYTES,
} from './limits.js';

/** Frame types (INTERFACES v0.3). */
export const T = Object.freeze({
  HELLO: 1, XX: 2, ENV: 3, ROOM: 4, WANT: 5, HELD: 6, CK: 7, HOLDING: 8, COLLECTED: 9, PRES: 10, SIG: 11,
  ICHAL: 12, IRESP: 13,
});
export const TYPE_NAMES = Object.freeze(Object.keys(T).reduce((m, k) => { m[T[k]] = k; return m; }, {}));

/** Types a relay may forward, with their hop limit; every other type travels one hop (hop must be 0). */
export const HOP_LIMIT = Object.freeze({
  [T.ENV]: HOP_MAX_ENV, [T.SIG]: HOP_MAX_ENV, [T.HOLDING]: HOP_MAX_ENV, [T.COLLECTED]: HOP_MAX_ENV, [T.ROOM]: HOP_MAX_ROOM,
});
/** Types whose header may carry flags (hold, stranger, pad-only). */
const FLAGGED = new Set([T.ENV, T.SIG]);

// ---------------------------------------------------------------------------------------------
// P-256 point check (uncompressed SEC1), so a malformed point is a strike before any crypto call.
// ---------------------------------------------------------------------------------------------

const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function bigFrom(u8, start, end) {
  let x = 0n;
  for (let i = start; i < end; i++) x = (x << 8n) | BigInt(u8[i]);
  return x;
}

/** True when u8 is a 65-byte uncompressed P-256 point on the curve (not the point at infinity). */
export function isOnCurve(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length !== POINT_BYTES || u8[0] !== 0x04) return false;
  const x = bigFrom(u8, 1, 33);
  const y = bigFrom(u8, 33, 65);
  if (x >= P || y >= P) return false;
  const lhs = (y * y) % P;
  const rhs = (((x * x) % P) * x - 3n * x + B) % P;
  return lhs === ((rhs % P) + P) % P;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isByte(n) {
  return Number.isInteger(n) && n >= 0 && n <= 255;
}

function needBytes(x, len, what) {
  if (!(x instanceof Uint8Array)) throw new TypeError(what + ' must be a Uint8Array');
  if (len !== undefined && x.length !== len) throw new TypeError(what + ' must be ' + len + ' bytes');
  return x;
}

function fail(error) {
  return { error };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

// Strict UTF-8 JSON object with only the allowed keys; null when anything is off.
function parseJsonObject(bytes, max, allowed) {
  if (bytes.length === 0 || bytes.length > max) return null;
  let obj;
  try {
    obj = JSON.parse(utf8.decode(bytes, { fatal: true }));
  } catch (_) {
    return null;
  }
  if (!isPlainObject(obj)) return null;
  for (const k of Object.keys(obj)) if (allowed.indexOf(k) < 0) return null;
  return obj;
}

function isSafeUint(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

// No C0/C1 control characters, no lone surrogates.
function cleanText(s, maxChars) {
  if (typeof s !== 'string' || s.length > maxChars) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x0a && c !== 0x09) return false;
    if (c >= 0x7f && c <= 0x9f) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function b64Bytes(s, len) {
  if (typeof s !== 'string') return null;
  try {
    const u = b64url.decode(s);
    return u.length === len ? u : null;
  } catch (_) {
    return null;
  }
}

const LANE_RE = /^[a-z0-9_]{1,32}$/;

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

function parseEnv(body) {
  const ctLen = body.length - ENV_FIXED;
  if (CT_LENGTHS.indexOf(ctLen) < 0) return fail('env-length');
  const epk = body.subarray(TAG_BYTES, TAG_BYTES + POINT_BYTES);
  if (!isOnCurve(epk)) return fail('bad-point');
  return {
    tag: body.subarray(0, TAG_BYTES),
    epk,
    iv: body.subarray(TAG_BYTES + POINT_BYTES, ENV_FIXED),
    ct: body.subarray(ENV_FIXED),
  };
}

function parseHello(body) {
  const o = parseJsonObject(body, HELLO_MAX, ['v', 'site', 'owner', 'lanes']);
  if (!o) return fail('hello-json');
  if (o.v !== 1) return fail('hello-version');
  if (typeof o.site !== 'string' || o.site.length === 0 || o.site.length > 128) return fail('hello-site');
  if (o.owner !== null && o.owner !== undefined && !isPublicKeyString(o.owner)) return fail('hello-owner');
  const lanes = o.lanes === undefined ? [] : o.lanes;
  if (!Array.isArray(lanes) || lanes.length > HELLO_LANES_MAX) return fail('hello-lanes');
  for (const l of lanes) if (typeof l !== 'string' || l.length > LANE_NAME_MAX || !LANE_RE.test(l)) return fail('hello-lanes');
  return { v: 1, site: o.site, owner: o.owner == null ? null : o.owner, lanes: lanes.slice() };
}

function parseXx(body) {
  if (body.length < 2 || body.length > XX_MAX) return fail('xx-length');
  const step = body[0];
  if (step < 1 || step > 3) return fail('xx-step');
  return { step, msg: body.subarray(1) };
}

function parseRoom(body) {
  const o = parseJsonObject(body, ROOM_BODY_MAX, ['room', 'id', 't', 'text', 'author', 'sig']);
  if (!o) return fail('room-json');
  if (!cleanText(o.room, ROOM_NAME_MAX) || o.room.length === 0 || /[\n\t]/.test(o.room)) return fail('room-name');
  if (!b64Bytes(o.id, ROOM_ID_BYTES)) return fail('room-id');
  if (!isSafeUint(o.t)) return fail('room-t');
  if (!cleanText(o.text, ROOM_TEXT_MAX) || o.text.length === 0) return fail('room-text');
  if (!isPublicKeyString(o.author)) return fail('room-author');
  if (!b64Bytes(o.sig, 64)) return fail('room-sig');
  return { room: o.room, id: o.id, t: o.t, text: o.text, author: o.author, sig: o.sig };
}

function parseWant(body) {
  if (body.length < 1) return fail('want-length');
  const count = body[0];
  if (count > WANT_MAX) return fail('want-count');
  const rest = body.length - 1;
  let mode;
  if (count === 0 && rest === 0) mode = 'prefix';
  else if (rest === count) mode = 'prefix';
  else if (rest === count * TAG_BYTES) mode = 'tag';
  else return fail('want-length');
  const size = mode === 'prefix' ? 1 : TAG_BYTES;
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(body.subarray(1 + i * size, 1 + (i + 1) * size));
  return { mode, entries };
}

function parseHeld(body) {
  if (body.length < 1) return fail('held-length');
  const count = body[0];
  if (count > HELD_MAX_ITEMS) return fail('held-count');
  const frames = [];
  let at = 1;
  for (let i = 0; i < count; i++) {
    if (at + 2 > body.length) return fail('held-length');
    const len = (body[at] << 8) | body[at + 1];
    at += 2;
    if (len < HEADER_BYTES || at + len > body.length) return fail('held-length');
    const inner = body.subarray(at, at + len);
    at += len;
    if (inner[0] !== T.ENV && inner[0] !== T.SIG) return fail('held-type');
    const d = decode(inner);
    if (d.error) return fail('held-item:' + d.error);
    if (d.type !== T.ENV && d.type !== T.SIG) return fail('held-type');
    frames.push({ bytes: inner, frame: d });
  }
  if (at !== body.length) return fail('held-length');
  return { frames };
}

function parseCk(body) {
  const o = parseJsonObject(body, CK_MAX, ['v', 'ledger', 'signer', 'ek', 'epoch', 'exp', 'sig']);
  if (!o) return fail('ck-json');
  return { ck: o };
}

function parseHolding(body) {
  if (body.length !== HOLDING_BODY) return fail('holding-length');
  for (let i = TAG_BYTES + FRAME_ID_BYTES + 4; i < body.length; i++) if (body[i] !== 0) return fail('holding-padding');
  const e = TAG_BYTES + FRAME_ID_BYTES;
  const expiry = ((body[e] << 24) >>> 0) + (body[e + 1] << 16) + (body[e + 2] << 8) + body[e + 3];
  return { tag: body.subarray(0, TAG_BYTES), frameId: body.subarray(TAG_BYTES, e), expiry };
}

function parseCollected(body) {
  if (body.length !== FRAME_ID_BYTES + PROOF_BYTES) return fail('collected-length');
  return { frameId: body.subarray(0, FRAME_ID_BYTES), proof: body.subarray(FRAME_ID_BYTES) };
}

function parsePres(body) {
  if (body.length !== PRES_BODY) return fail('pres-length');
  const mode = body[0];
  if (mode !== 0 && mode !== 1) return fail('pres-mode');
  const slots = [];
  for (let i = 0; i < PRES_SLOTS; i++) slots.push(body.subarray(1 + i * PRES_SLOT_BYTES, 1 + (i + 1) * PRES_SLOT_BYTES));
  const s = 1 + PRES_SLOTS * PRES_SLOT_BYTES;
  const status = body[s];
  if (status !== 1 && status !== 2) return fail('pres-status');
  return { mode, slots, status, auth: body.subarray(s + 1, s + 1 + PRES_AUTH_BYTES) };
}

function parseIchal(body) {
  if (body.length !== CHALLENGE_BYTES + POINT_BYTES) return fail('ichal-length');
  const hepk = body.subarray(CHALLENGE_BYTES);
  if (!isOnCurve(hepk)) return fail('bad-point');
  return { challenge: body.subarray(0, CHALLENGE_BYTES), hepk };
}

function parseIresp(body) {
  if (body.length !== POINT_BYTES + PROOF_BYTES) return fail('iresp-length');
  const ek = body.subarray(0, POINT_BYTES);
  if (!isOnCurve(ek)) return fail('bad-point');
  return { ek, proof: body.subarray(POINT_BYTES) };
}

const PARSERS = {
  [T.HELLO]: parseHello, [T.XX]: parseXx, [T.ENV]: parseEnv, [T.ROOM]: parseRoom, [T.WANT]: parseWant,
  [T.HELD]: parseHeld, [T.CK]: parseCk, [T.HOLDING]: parseHolding, [T.COLLECTED]: parseCollected,
  [T.PRES]: parsePres, [T.SIG]: parseEnv, [T.ICHAL]: parseIchal, [T.IRESP]: parseIresp,
};

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

/**
 * decode(u8) -> { type, header: { version, hop, flags, day, stampNonce }, body, fields } | { error }.
 * Never throws. Checks, in order: size, known type, version, hop limit, flags, then the body bounds.
 */
export function decode(u8) {
  try {
    if (!(u8 instanceof Uint8Array)) {
      if (u8 instanceof ArrayBuffer || ArrayBuffer.isView(u8)) u8 = asBytes(u8);
      else return fail('not-bytes');
    }
    if (u8.length < HEADER_BYTES) return fail('short');
    if (u8.length > FRAME_MAX) return fail('too-large');
    const type = u8[0];
    const parse = PARSERS[type];
    if (!parse) return fail('unknown-type');
    const version = u8[1];
    if (version !== FRAME_VERSION) return fail('unknown-version');
    const hop = u8[2];
    const limit = HOP_LIMIT[type] || 0;
    if (hop > limit) return fail('hop');
    const flags = u8[3];
    if (flags & ~FLAG_MASK) return fail('flags');
    if (flags !== 0 && !FLAGGED.has(type)) return fail('flags');
    const day = (u8[4] << 8) | u8[5];
    const stampNonce = u8.subarray(6, HEADER_BYTES);
    const body = u8.subarray(HEADER_BYTES);
    const fields = parse(body);
    if (fields && fields.error) return fields;
    return { type, header: { version, hop, flags, day, stampNonce }, body, fields };
  } catch (_) {
    return fail('decode');
  }
}

/**
 * encode(type, header, body) -> Uint8Array. header: { version = 1, hop = 0, flags = 0, day, stampNonce }.
 * body: Uint8Array (use the *Body helpers). The result must decode; otherwise TypeError.
 */
export function encode(type, header, body) {
  if (!PARSERS[type]) throw new TypeError('encode: unknown frame type ' + type);
  const h = header || {};
  const version = h.version === undefined ? FRAME_VERSION : h.version;
  const hop = h.hop === undefined ? 0 : h.hop;
  const flags = h.flags === undefined ? 0 : h.flags;
  const day = h.day;
  if (!isByte(version)) throw new TypeError('encode: version must be a byte');
  if (!isByte(hop)) throw new TypeError('encode: hop must be a byte');
  if (!isByte(flags)) throw new TypeError('encode: flags must be a byte');
  if (!Number.isInteger(day) || day < 0 || day > 0xffff) throw new TypeError('encode: day must be 0 to 65535');
  const nonce = h.stampNonce === undefined ? new Uint8Array(NONCE_BYTES) : needBytes(h.stampNonce, NONCE_BYTES, 'stampNonce');
  needBytes(body, undefined, 'body');
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = type;
  out[1] = version;
  out[2] = hop;
  out[3] = flags;
  out[4] = day >> 8;
  out[5] = day & 255;
  out.set(nonce, 6);
  out.set(body, HEADER_BYTES);
  const check = decode(out);
  if (check.error) throw new TypeError('encode: invalid frame (' + check.error + ')');
  return out;
}

/** frameId of a frame (bytes or a decoded frame): SHA-256(type | version | flags | day | body); hop excluded. */
export function frameId(frame) {
  let type, version, flags, day, body;
  if (frame instanceof Uint8Array) {
    if (frame.length < HEADER_BYTES) throw new TypeError('frameId: short frame');
    type = frame[0];
    version = frame[1];
    flags = frame[3];
    day = (frame[4] << 8) | frame[5];
    body = frame.subarray(HEADER_BYTES);
  } else if (frame && frame.header && frame.body) {
    type = frame.type;
    version = frame.header.version;
    flags = frame.header.flags;
    day = frame.header.day;
    body = frame.body;
  } else {
    throw new TypeError('frameId expects frame bytes or a decoded frame');
  }
  return sha256Sync(concatBytes(Uint8Array.of(type, version, flags, day >> 8, day & 255), body));
}

/** A copy of the frame bytes with another hop value (relaying). */
export function withHop(u8, hop) {
  if (!isByte(hop)) throw new TypeError('withHop: hop must be a byte');
  const out = new Uint8Array(u8);
  out[2] = hop;
  return out;
}

/** A copy of the frame bytes with another stamp nonce (after minting). */
export function withNonce(u8, nonce) {
  needBytes(nonce, NONCE_BYTES, 'nonce');
  const out = new Uint8Array(u8);
  out.set(nonce, 6);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Body builders (local data; throw TypeError)
// ---------------------------------------------------------------------------------------------

export function helloBody({ site, owner = null, lanes = [] }) {
  const b = utf8.encode(JSON.stringify({ v: 1, site, owner, lanes }));
  if (b.length > HELLO_MAX) throw new TypeError('helloBody: over ' + HELLO_MAX + ' bytes');
  return b;
}

export function xxBody(step, msg) {
  needBytes(msg, undefined, 'msg');
  if (!(step >= 1 && step <= 3)) throw new TypeError('xxBody: step 1 to 3');
  if (msg.length + 1 > XX_MAX) throw new TypeError('xxBody: over ' + XX_MAX + ' bytes');
  return concatBytes(Uint8Array.of(step), msg);
}

export function envBody({ tag, epk, iv, ct }) {
  needBytes(tag, TAG_BYTES, 'tag');
  needBytes(epk, POINT_BYTES, 'epk');
  needBytes(iv, IV_BYTES, 'iv');
  needBytes(ct, undefined, 'ct');
  if (CT_LENGTHS.indexOf(ct.length) < 0) throw new TypeError('envBody: ct length must be one of ' + CT_LENGTHS.join(', '));
  return concatBytes(tag, epk, iv, ct);
}

export function roomBody({ room, id, t, text, author, sig }) {
  const b = utf8.encode(JSON.stringify({ room, id, t, text, author, sig }));
  if (b.length > ROOM_BODY_MAX) throw new TypeError('roomBody: too large');
  return b;
}

export function wantBody(entries) {
  if (!Array.isArray(entries) || entries.length > WANT_MAX) throw new TypeError('wantBody: at most ' + WANT_MAX + ' entries');
  const size = entries.length ? entries[0].length : 1;
  if (size !== 1 && size !== TAG_BYTES) throw new TypeError('wantBody: entries are 1-byte prefixes or 8-byte tags');
  for (const e of entries) needBytes(e, size, 'want entry');
  return concatBytes(Uint8Array.of(entries.length), ...entries);
}

export function heldBody(frames) {
  if (!Array.isArray(frames) || frames.length > HELD_MAX_ITEMS) throw new TypeError('heldBody: at most ' + HELD_MAX_ITEMS + ' frames');
  const parts = [Uint8Array.of(frames.length)];
  for (const f of frames) {
    needBytes(f);
    parts.push(Uint8Array.of(f.length >> 8, f.length & 255), f);
  }
  return concatBytes(...parts);
}

export function ckBody(ck) {
  const b = utf8.encode(JSON.stringify(ck));
  if (b.length > CK_MAX) throw new TypeError('ckBody: over ' + CK_MAX + ' bytes');
  return b;
}

export function holdingBody({ tag, frameId: id, expiry }) {
  needBytes(tag, TAG_BYTES, 'tag');
  needBytes(id, FRAME_ID_BYTES, 'frameId');
  if (!Number.isInteger(expiry) || expiry < 0 || expiry > 0xffffffff) throw new TypeError('holdingBody: expiry is uint32 seconds');
  const out = new Uint8Array(HOLDING_BODY);
  out.set(tag, 0);
  out.set(id, TAG_BYTES);
  const e = TAG_BYTES + FRAME_ID_BYTES;
  out[e] = (expiry >>> 24) & 255;
  out[e + 1] = (expiry >>> 16) & 255;
  out[e + 2] = (expiry >>> 8) & 255;
  out[e + 3] = expiry & 255;
  return out;
}

export function collectedBody({ frameId: id, proof }) {
  needBytes(id, FRAME_ID_BYTES, 'frameId');
  needBytes(proof, PROOF_BYTES, 'proof');
  return concatBytes(id, proof);
}

export function presBody({ mode, slots, status, auth }) {
  if (mode !== 0 && mode !== 1) throw new TypeError('presBody: mode 0 or 1');
  if (!Array.isArray(slots) || slots.length !== PRES_SLOTS) throw new TypeError('presBody: 8 slots');
  for (const s of slots) needBytes(s, PRES_SLOT_BYTES, 'slot');
  if (status !== 1 && status !== 2) throw new TypeError('presBody: status 1 or 2');
  needBytes(auth, PRES_AUTH_BYTES, 'auth');
  return concatBytes(Uint8Array.of(mode), ...slots, Uint8Array.of(status), auth);
}

export function ichalBody({ challenge, hepk }) {
  needBytes(challenge, CHALLENGE_BYTES, 'challenge');
  needBytes(hepk, POINT_BYTES, 'hepk');
  return concatBytes(challenge, hepk);
}

export function irespBody({ ek, proof }) {
  needBytes(ek, POINT_BYTES, 'ek');
  needBytes(proof, PROOF_BYTES, 'proof');
  return concatBytes(ek, proof);
}
