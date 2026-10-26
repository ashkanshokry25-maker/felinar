// The deniable sealed box (R 2.7.4, D-C6, MF-38, MF-41), the generic box used by sealed grants, joins and
// media grants (sealTo / openFrom), and group sealing (R 2.7.7). New cryptographic code: it gets vectors
// (test/vectors/chat.json), the fuzzer and the outside review of R 2.19 before anyone calls it secure.
//
//   K_pair = HKDF(ECDH(myChatKey, theirChatPub), salt = "", info = "mw-pair-v2|" + ledgerId + "|" + a + "|" + b)
//            with (a, b) = the two 'p256:' chat keys sorted as strings
//   tag    = contacts: HMAC(K_pair, "tag|" + day)[:8]; strangers: SHA-256("mw-inbox-v2|" + ek + "|" + day)[:8]
//   mk     = HKDF(K_pair || ECDH(epk, theirChatPub), salt = tag, info = "mw-dm-v2|" + ledgerId)
//   ct     = AES-256-GCM(mk, iv, plaintext, AAD = "mw-dm-v2" || tag || epk)
//   plaintext = id (16) | t (8, ms) | n (4) | kind (1) | flags (1)
//               | [stranger: ckLen (2) | CK (<= 400) | auth (32)] | len (2) | body | zero padding to the bucket
//   buckets 256, 1,024, 4,096, 16,000 -> ct 272, 1,040, 4,112, 16,016 -> ENV frames 371, 1,139, 4,211, 16,115 bytes
//
// Stranger frames (deviation, docs/deviations/chat.md D-1): the recipient cannot compute K_pair before it
// has read the sender's CK, so a stranger frame is encrypted under
//   mk_s = HKDF(ECDH(epk, theirChatPub), salt = tag, info = "mw-dm-v2|" + ledgerId + "|stranger")
// and authenticated by auth = HMAC(K_pair, "mw-dm-v2|auth|" || tag || epk || plaintext with auth zeroed),
// which the recipient checks after verifying the CK. Both modes stay deniable: K_pair is shared by the two
// parties and the recipient can compute ECDH(epk, ownChatPub) for any epk it picks, so the recipient can
// build a frame that opens as if the sender made it (U-CH-3).
//
// A ChatKey is { pub: 'p256:...', ecdh(theirPub) -> Promise<Uint8Array(32)> }; the private half never
// leaves it (WorkingKeys provide one; generateChatKey() makes a non-extractable one for tests and peers).
//
// Shared code: WebCrypto only (P-256 ECDH and ECDSA, HKDF-SHA-256, AES-256-GCM, SHA-256).

import { utf8, hex, b64url, concatBytes } from '../chain/canonical.js';
import { publicKeyBytes, encodePublicKey, sha256, verify as verifySig } from '../chain/crypto.js';
import { contactTag, contactTagFrom, inboxTag, groupTag, hmac } from './tags.js';
import { verifyCk } from './ck.js';
import { isOnCurve } from './frames.js';
import {
  BUCKETS, IV_BYTES, POINT_BYTES, TAG_BYTES, PT_FIXED, STRANGER_AUTH, CK_MAX, PAIR_INFO, DM_INFO, DM_AAD,
  GROUP_MSG_PREFIX, COLLECT_PREFIX, DAY_MS,
} from './limits.js';

const ECDH_ALG = { name: 'ECDH', namedCurve: 'P-256' };
export const PT_FLAG_CK = 0x01; // plaintext flags: the stranger layout (a CK and an auth field follow)
const EMPTY = new Uint8Array(0);

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function sealError(reason) {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Raw 65-byte point of a 'p256:' string or bytes (checked on the curve). */
export function rawPoint(pub) {
  const raw = typeof pub === 'string' ? publicKeyBytes(pub) : pub;
  if (!isOnCurve(raw)) throw new TypeError('not a P-256 point');
  return raw;
}

/** HKDF-SHA-256(ikm, salt, info) -> Uint8Array(len). */
export async function hkdf(ikm, salt, info, len = 32) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt || EMPTY, info: typeof info === 'string' ? utf8.encode(info) : info },
    key, len * 8);
  return new Uint8Array(bits);
}

export async function aesGcmEncrypt(key, iv, plaintext, aad) {
  const k = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, plaintext));
}

/** Decrypts or returns null (a failed AEAD never throws to the caller). */
export async function aesGcmDecrypt(key, iv, ct, aad) {
  try {
    const k = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, ct));
  } catch (_) {
    return null;
  }
}

/** Constant-time comparison of two byte strings of equal length. */
export function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function ecdhWith(privateKey, theirPub) {
  const pubKey = await subtle().importKey('raw', rawPoint(theirPub), ECDH_ALG, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pubKey }, privateKey, 256));
}

/** ChatKey from a WebCrypto ECDH pair. */
export async function chatKeyFromPair({ privateKey, publicKey }) {
  const pub = encodePublicKey(new Uint8Array(await subtle().exportKey('raw', publicKey)));
  return { pub, ecdh: (theirPub) => ecdhWith(privateKey, theirPub) };
}

/** A fresh non-extractable ChatKey (peers, ephemerals, tests). */
export async function generateChatKey() {
  const pair = await subtle().generateKey(ECDH_ALG, false, ['deriveBits']);
  return chatKeyFromPair(pair);
}

/** ChatKey from a private JWK { kty, crv, x, y, d } (vectors and the identity bundle). */
export async function chatKeyFromJwk(jwk) {
  const privateKey = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, ECDH_ALG, false, ['deriveBits']);
  const publicKey = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDH_ALG, true, []);
  return chatKeyFromPair({ privateKey, publicKey });
}

function checkChatKey(k, what) {
  if (!k || typeof k.ecdh !== 'function' || typeof k.pub !== 'string') throw new TypeError(what + ' must be a ChatKey { pub, ecdh }');
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** K_pair of two chat keys on a ledger (symmetric: both parties get the same 32 bytes). */
export async function pairKey(myChat, theirChatPub, ledgerId) {
  checkChatKey(myChat, 'myChat');
  if (typeof theirChatPub !== 'string') throw new TypeError('theirChatPub must be a p256: key string');
  const shared = await myChat.ecdh(theirChatPub);
  const [a, b] = [myChat.pub, theirChatPub].sort();
  return hkdf(shared, EMPTY, PAIR_INFO + ledgerId + '|' + a + '|' + b, 32);
}

function messageKey(kPair, dh, tag, ledgerId) {
  return hkdf(concatBytes(kPair, dh), tag, DM_INFO + ledgerId, 32);
}

function strangerKey(dh, tag, ledgerId) {
  return hkdf(dh, tag, DM_INFO + ledgerId + '|stranger', 32);
}

function dmAad(tag, epk) {
  return concatBytes(utf8.encode(DM_AAD), tag, epk);
}

async function strangerAuth(kPair, tag, epk, ptZeroAuth) {
  return hmac(kPair, concatBytes(utf8.encode(DM_INFO + 'auth|'), tag, epk, ptZeroAuth));
}

/** HMAC(K_pair, "hint|" + day)[:4] for sealed grants and joins (R 2.6.2). */
export async function hint(kPair, day) {
  return (await hmac(kPair, 'hint|' + String(day))).slice(0, 4);
}

/** COLLECTED proof: HMAC(K_pair, "collected|" + frameId) (frameId as lowercase hex). The R 2.7.3 form, kept for the vector. */
export async function collectedProof(kPair, frameIdBytes) {
  return hmac(kPair, 'collected|' + hex.encode(frameIdBytes));
}

/**
 * The COLLECTED hash lock (review round, SYB-15 and HUB-8; closes O-1 without a layout change): the sender derives the
 * frame's iv from a secret only the pair can compute,
 *   s  = HMAC(K_pair, "collect|" || tag || epk)          (tag as it is on the wire)
 *   iv = SHA-256("mw-collect-v1" || s)[:12]
 * and the recipient's COLLECTED carries s as its 32-byte proof. A holder deletes a frame only when SHA-256(prefix || proof)
 * starts with the frame's iv, so a neighbour that was handed the frame cannot delete it. mk is fresh per frame (a fresh epk),
 * so a derived iv is never reused under one key.
 */
export async function collectSecret(kPair, tag, epk) {
  return hmac(kPair, concatBytes(utf8.encode('collect|'), tag, epk));
}

/** iv of the COLLECTED hash lock for a secret s (32 bytes). */
export async function collectIv(secret) {
  return (await sha256(concatBytes(utf8.encode(COLLECT_PREFIX), secret))).slice(0, IV_BYTES);
}

/** True when a COLLECTED proof opens the lock of a frame whose iv is `iv`. */
export async function collectMatches(iv, proof) {
  if (!(iv instanceof Uint8Array) || iv.length !== IV_BYTES || !(proof instanceof Uint8Array) || proof.length !== 32) return false;
  return equalBytes(await collectIv(proof), iv);
}

// ---------------------------------------------------------------------------------------------
// Plaintext layout
// ---------------------------------------------------------------------------------------------

/** Smallest bucket that holds `need` plaintext bytes, or null. */
export function chooseBucket(need) {
  for (const b of BUCKETS) if (need <= b) return b;
  return null;
}

/** Plaintext bytes a message needs before padding. */
export function plaintextNeed({ body, ck }) {
  const ckBytes = ck ? utf8.encode(JSON.stringify(ck)).length : 0;
  return PT_FIXED + (ck ? 2 + ckBytes + STRANGER_AUTH : 0) + (body ? body.length : 0);
}

function writeU64(out, at, n) {
  let x = n;
  for (let i = 7; i >= 0; i--) {
    out[at + i] = x % 256;
    x = Math.floor(x / 256);
  }
}

function readU64(u8, at) {
  let x = 0;
  for (let i = 0; i < 8; i++) x = x * 256 + u8[at + i];
  return x;
}

/**
 * encodePlaintext({ id, t, n, kind, flags = 0, ck?, body }, bucket) -> Uint8Array(bucket). With ck the
 * stranger layout is used (PT_FLAG_CK set) and the auth field is left zero.
 */
export function encodePlaintext({ id, t, n, kind, flags = 0, ck = null, body = EMPTY }, bucket) {
  if (!(id instanceof Uint8Array) || id.length !== 16) throw new TypeError('plaintext id must be 16 bytes');
  if (!Number.isSafeInteger(t) || t < 0) throw new TypeError('plaintext t must be a safe non-negative integer');
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new TypeError('plaintext n is uint32');
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) throw new TypeError('plaintext kind is a byte');
  if (!Number.isInteger(flags) || flags < 0 || flags > 255) throw new TypeError('plaintext flags is a byte');
  if (!(body instanceof Uint8Array)) throw new TypeError('plaintext body must be bytes');
  const ckBytes = ck ? utf8.encode(JSON.stringify(ck)) : null;
  if (ckBytes && ckBytes.length > CK_MAX) throw new TypeError('CK over ' + CK_MAX + ' bytes');
  const fl = ck ? (flags | PT_FLAG_CK) : (flags & ~PT_FLAG_CK);
  const need = plaintextNeed({ body, ck });
  if (BUCKETS.indexOf(bucket) < 0) throw new TypeError('bucket must be one of ' + BUCKETS.join(', '));
  if (need > bucket) throw new TypeError('message does not fit the bucket');
  if (body.length > 0xffff) throw new TypeError('body too long');
  const out = new Uint8Array(bucket);
  out.set(id, 0);
  writeU64(out, 16, t);
  out[24] = (n >>> 24) & 255;
  out[25] = (n >>> 16) & 255;
  out[26] = (n >>> 8) & 255;
  out[27] = n & 255;
  out[28] = kind;
  out[29] = fl;
  let at = 30;
  if (ckBytes) {
    out[at] = ckBytes.length >> 8;
    out[at + 1] = ckBytes.length & 255;
    out.set(ckBytes, at + 2);
    at += 2 + ckBytes.length + STRANGER_AUTH; // auth stays zero here
  }
  out[at] = body.length >> 8;
  out[at + 1] = body.length & 255;
  out.set(body, at + 2);
  return out;
}

/** Offset of the auth field in a stranger plaintext, or -1. */
function authOffset(pt) {
  if (!(pt[29] & PT_FLAG_CK)) return -1;
  const ckLen = (pt[30] << 8) | pt[31];
  return 32 + ckLen;
}

/**
 * decodePlaintext(u8) -> { id, t, n, kind, flags, ck?, auth?, body } | null. Strict: the padding must be
 * zero, t a safe integer, the CK JSON an object.
 */
export function decodePlaintext(pt) {
  try {
    if (!(pt instanceof Uint8Array) || BUCKETS.indexOf(pt.length) < 0) return null;
    const t = readU64(pt, 16);
    if (!Number.isSafeInteger(t)) return null;
    const out = {
      id: pt.slice(0, 16), t, n: ((pt[24] << 24) >>> 0) + (pt[25] << 16) + (pt[26] << 8) + pt[27], kind: pt[28], flags: pt[29],
    };
    let at = 30;
    if (out.flags & PT_FLAG_CK) {
      const ckLen = (pt[at] << 8) | pt[at + 1];
      if (ckLen === 0 || ckLen > CK_MAX || at + 2 + ckLen + STRANGER_AUTH + 2 > pt.length) return null;
      let ck;
      try {
        ck = JSON.parse(utf8.decode(pt.subarray(at + 2, at + 2 + ckLen), { fatal: true }));
      } catch (_) {
        return null;
      }
      if (!ck || typeof ck !== 'object' || Array.isArray(ck)) return null;
      out.ck = ck;
      out.auth = pt.slice(at + 2 + ckLen, at + 2 + ckLen + STRANGER_AUTH);
      at += 2 + ckLen + STRANGER_AUTH;
    }
    if (at + 2 > pt.length) return null;
    const len = (pt[at] << 8) | pt[at + 1];
    if (at + 2 + len > pt.length) return null;
    out.body = pt.slice(at + 2, at + 2 + len);
    for (let i = at + 2 + len; i < pt.length; i++) if (pt[i] !== 0) return null;
    return out;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------------------------

/**
 * sealRaw({ kPair, dh, epk, tag, ledgerId, plaintext, iv, stranger, salt? }) -> { tag, epk, iv, ct }.
 * The bottom layer: the caller has already computed K_pair and dh = ECDH(epk, recipientChatPub). Exported
 * for the vectors and for the deniability test (a recipient computes dh with its own key and any epk). salt is the HKDF
 * salt of a stranger frame's key when it is not the wire tag (a blinded inbox tag: the full inbox tag).
 */
export async function sealRaw({ kPair, dh, epk, tag, ledgerId, plaintext, iv, stranger = false, salt = null }) {
  const pt = new Uint8Array(plaintext);
  let key;
  if (stranger) {
    const off = authOffset(pt);
    if (off < 0) throw new TypeError('sealRaw: a stranger plaintext needs the CK layout');
    pt.fill(0, off, off + STRANGER_AUTH);
    pt.set(await strangerAuth(kPair, tag, epk, pt), off);
    key = await strangerKey(dh, salt || tag, ledgerId);
  } else {
    if (authOffset(pt) >= 0) throw new TypeError('sealRaw: a contact plaintext must not carry a CK');
    key = await messageKey(kPair, dh, tag, ledgerId);
  }
  const ct = await aesGcmEncrypt(key, iv, pt, dmAad(tag, epk));
  return { tag, epk, iv, ct };
}

/**
 * sealDm({ myChat, theirChatPub, ledgerId, day, message: { id?, t, n, kind, flags?, body }, ck?, bucket?,
 *          stranger = false, ephemeral?, iv?, directional = false, blindInbox = false, collectLock = false })
 *   -> { tag, epk, iv, ct, bucket, kPair }.
 * stranger: true uses the recipient's inbox tag and carries `ck` (the sender's signed CK, required).
 * Review round options (the chat service sets all three; the defaults keep the vector forms of R 2.7.4):
 *   directional  contact tag HMAC(K_pair, "tag|" + day + "|" + myChat.pub)[:8] (PRIV-1);
 *   blindInbox   a stranger frame carries only the first byte of the inbox tag, then 7 random bytes; the full inbox tag
 *                stays the HKDF salt, so only the recipient (who can compute it) opens it (STALK-7);
 *   collectLock  iv from the COLLECTED hash lock (collectSecret, collectIv) unless an iv is given (SYB-15, HUB-8).
 */
export async function sealDm({
  myChat, theirChatPub, ledgerId, day, message, ck = null, bucket, stranger = false, ephemeral, iv,
  directional = false, blindInbox = false, collectLock = false,
}) {
  checkChatKey(myChat, 'myChat');
  if (typeof ledgerId !== 'string' || !ledgerId) throw new TypeError('sealDm: ledgerId');
  if (!Number.isSafeInteger(day) || day < 0) throw new TypeError('sealDm: day is the UTC day number');
  if (stranger && !ck) throw new TypeError('sealDm: a stranger message carries the sender CK');
  if (stranger && ck.ek !== myChat.pub) throw new TypeError('sealDm: the CK must carry the sender chat key');
  const msg = Object.assign({ flags: 0, body: EMPTY }, message);
  if (!msg.id) msg.id = randomBytes(16);
  const withCk = stranger ? ck : null;
  const b = bucket || chooseBucket(plaintextNeed({ body: msg.body, ck: withCk }));
  if (!b) throw Object.assign(new Error('message too long'), { code: 'E_LIMIT' });
  const pt = encodePlaintext(Object.assign({}, msg, { ck: withCk }), b);
  const kPair = await pairKey(myChat, theirChatPub, ledgerId);
  let tag;
  let salt = null;
  if (stranger) {
    const full = await inboxTag(theirChatPub, day);
    if (blindInbox) {
      tag = randomBytes(TAG_BYTES);
      tag[0] = full[0];
      salt = full;
    } else {
      tag = full;
    }
  } else {
    tag = directional ? await contactTagFrom(kPair, day, myChat.pub) : await contactTag(kPair, day);
  }
  const eph = ephemeral || await generateChatKey();
  const epk = publicKeyBytes(eph.pub);
  const dh = await eph.ecdh(theirChatPub);
  let nonce = iv;
  if (!nonce) nonce = collectLock ? await collectIv(await collectSecret(kPair, tag, epk)) : randomBytes(IV_BYTES);
  const out = await sealRaw({ kPair, dh, epk, tag, ledgerId, plaintext: pt, iv: nonce, stranger, salt });
  return Object.assign(out, { bucket: b, kPair, id: msg.id });
}

/**
 * openDm({ myChat, ledgerId, env: { tag, epk, iv, ct }, theirChatPub?, kPair?, stranger = false, now })
 *   -> { ok: true, from, kPair, message: { id, t, n, kind, flags, body, ck? } } | { ok: false, reason }.
 * Contact mode needs theirChatPub (or a cached kPair with theirChatPub). Stranger mode reads and verifies the
 * CK inside, then checks the auth field under K_pair with the CK's chat key. Never throws.
 */
export async function openDm({ myChat, ledgerId, env, theirChatPub = null, kPair = null, stranger = false, now = Date.now() }) {
  try {
    checkChatKey(myChat, 'myChat');
    const { tag, epk, iv, ct } = env;
    if (!(tag instanceof Uint8Array) || tag.length !== TAG_BYTES) return sealError('tag');
    if (!isOnCurve(epk)) return sealError('bad-point');
    if (!(iv instanceof Uint8Array) || iv.length !== IV_BYTES) return sealError('iv');
    const dh = await myChat.ecdh(epk);
    const aad = dmAad(tag, epk);
    if (!stranger) {
      if (typeof theirChatPub !== 'string') return sealError('no-sender');
      const kp = kPair || await pairKey(myChat, theirChatPub, ledgerId);
      const pt = await aesGcmDecrypt(await messageKey(kp, dh, tag, ledgerId), iv, ct, aad);
      if (!pt) return sealError('aead');
      const m = decodePlaintext(pt);
      if (!m) return sealError('plaintext');
      if (m.flags & PT_FLAG_CK) return sealError('layout');
      return { ok: true, from: theirChatPub, kPair: kp, message: m };
    }
    // The salt is the wire tag (the vector form) or, for a blinded inbox tag (STALK-7), the full inbox tag of this key for
    // one of the days a recipient listens on whose first byte the wire tag carries.
    const salts = [tag];
    const today = Math.floor(now / DAY_MS);
    for (const d of [today - 1, today, today + 1]) {
      if (d < 0) continue;
      const full = await inboxTag(myChat.pub, d);
      if (full[0] === tag[0] && !equalBytes(full, tag)) salts.push(full);
    }
    let pt = null;
    for (const salt of salts) {
      pt = await aesGcmDecrypt(await strangerKey(dh, salt, ledgerId), iv, ct, aad);
      if (pt) break;
    }
    if (!pt) return sealError('aead');
    const m = decodePlaintext(pt);
    if (!m || !m.ck) return sealError('plaintext');
    const v = await verifyCk(m.ck, { ledgerId, now });
    if (!v.ok) return sealError(v.reason);
    const kp = await pairKey(myChat, m.ck.ek, ledgerId);
    const off = authOffset(pt);
    const zeroed = new Uint8Array(pt);
    zeroed.fill(0, off, off + STRANGER_AUTH);
    const expect = await strangerAuth(kp, tag, epk, zeroed);
    if (!equalBytes(expect, m.auth)) return sealError('auth');
    return { ok: true, from: m.ck.ek, kPair: kp, message: m, ck: m.ck };
  } catch (_) {
    return sealError('open');
  }
}

// ---------------------------------------------------------------------------------------------
// The generic box (sealed grants, joins, media grants; R 2.6.2)
// ---------------------------------------------------------------------------------------------

function boxInfo(ledgerId) {
  return DM_INFO + ledgerId + '|box';
}

/**
 * sealTo({ myChat, theirChatPub, ledgerId, data, aad, ephemeral?, iv? }) -> { epk, iv, ct }.
 * key = HKDF(K_pair || ECDH(epk, theirChatPub), salt = SHA-256(aad), info = "mw-dm-v2|" + ledgerId + "|box");
 * ct = AES-256-GCM(key, iv, data, AAD = aad || epk). The caller's aad names its purpose (for example
 * "mw-seal-v1\n" + ledgerId + "\n" + authorPub). Deniable like a DM.
 */
export async function sealTo({ myChat, theirChatPub, ledgerId, data, aad, ephemeral, iv }) {
  checkChatKey(myChat, 'myChat');
  if (!(data instanceof Uint8Array)) throw new TypeError('sealTo: data must be bytes');
  if (!(aad instanceof Uint8Array)) throw new TypeError('sealTo: aad must be bytes');
  const kPair = await pairKey(myChat, theirChatPub, ledgerId);
  const eph = ephemeral || await generateChatKey();
  const epk = publicKeyBytes(eph.pub);
  const dh = await eph.ecdh(theirChatPub);
  const key = await hkdf(concatBytes(kPair, dh), await sha256(aad), boxInfo(ledgerId), 32);
  const nonce = iv || randomBytes(IV_BYTES);
  const ct = await aesGcmEncrypt(key, nonce, data, concatBytes(aad, epk));
  return { epk, iv: nonce, ct };
}

/** openFrom({ myChat, theirChatPub, ledgerId, epk, iv, ct, aad }) -> Uint8Array | null. Never throws. */
export async function openFrom({ myChat, theirChatPub, ledgerId, epk, iv, ct, aad }) {
  try {
    checkChatKey(myChat, 'myChat');
    if (!isOnCurve(epk) || !(iv instanceof Uint8Array) || iv.length !== IV_BYTES || !(aad instanceof Uint8Array)) return null;
    const kPair = await pairKey(myChat, theirChatPub, ledgerId);
    const dh = await myChat.ecdh(epk);
    const key = await hkdf(concatBytes(kPair, dh), await sha256(aad), boxInfo(ledgerId), 32);
    return await aesGcmDecrypt(key, iv, ct, concatBytes(aad, epk));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Groups (R 2.7.7)
// ---------------------------------------------------------------------------------------------

/** K_g = HKDF(groupSecret, salt = "", info = "mw-grp-msg-v2|" + ledgerId + "|" + groupId + "|" + epochId hex). */
export async function groupKey(groupSecret, ledgerId, groupId, epochId) {
  return hkdf(groupSecret, EMPTY, GROUP_MSG_PREFIX + '|' + ledgerId + '|' + groupId + '|' + hex.encode(epochId), 32);
}

/**
 * The bytes a group message signature covers: "mw-grp-msg-v2\n" + ledgerId + "\n" + groupId + "\n" +
 * hex(epochId) + "\n" + b64url(id) + "\n" + t + "\n" + hex(SHA-256(body)) (separators: D-3).
 */
export async function groupSigningBytes({ ledgerId, groupId, epochId, id, t, body }) {
  return utf8.encode(GROUP_MSG_PREFIX + '\n' + ledgerId + '\n' + groupId + '\n' + hex.encode(epochId) + '\n' +
    b64url.encode(id) + '\n' + t + '\n' + hex.encode(await sha256(body)));
}

const GROUP_FIXED = 16 + 8 + 4 + 1 + 1 + POINT_BYTES + 64 + 2; // 161

/**
 * sealGroup({ groupSecret, ledgerId, groupId, epochId, day, sender: { pub, sign }, message: { id?, t, n, kind, body },
 *             bucket?, iv?, ephemeral? }) -> { tag, epk, iv, ct, bucket, id }.
 * Group plaintext: id | t | n | kind | flags | senderPub (65) | sig (64) | len (2) | body | padding. epk is a
 * fresh point that is not used for any key (frames look like DMs on the wire).
 */
export async function sealGroup({ groupSecret, ledgerId, groupId, epochId, day, sender, message, bucket, iv, ephemeral }) {
  if (!sender || typeof sender.sign !== 'function' || typeof sender.pub !== 'string') throw new TypeError('sealGroup: sender { pub, sign }');
  const kG = await groupKey(groupSecret, ledgerId, groupId, epochId);
  const tag = await groupTag(kG, day);
  const id = message.id || randomBytes(16);
  const body = message.body || EMPTY;
  const b = bucket || chooseBucket(GROUP_FIXED + body.length);
  if (!b || GROUP_FIXED + body.length > b) throw Object.assign(new Error('message too long'), { code: 'E_LIMIT' });
  const sig = await sender.sign(await groupSigningBytes({ ledgerId, groupId, epochId, id, t: message.t, body }));
  const pt = new Uint8Array(b);
  pt.set(id, 0);
  writeU64(pt, 16, message.t);
  const n = message.n >>> 0;
  pt[24] = (n >>> 24) & 255;
  pt[25] = (n >>> 16) & 255;
  pt[26] = (n >>> 8) & 255;
  pt[27] = n & 255;
  pt[28] = message.kind & 255;
  pt[29] = 0;
  pt.set(publicKeyBytes(sender.pub), 30);
  pt.set(sig, 30 + POINT_BYTES);
  const at = 30 + POINT_BYTES + 64;
  pt[at] = body.length >> 8;
  pt[at + 1] = body.length & 255;
  pt.set(body, at + 2);
  const epk = publicKeyBytes((ephemeral || await generateChatKey()).pub);
  const nonce = iv || randomBytes(IV_BYTES);
  const ct = await aesGcmEncrypt(kG, nonce, pt, concatBytes(utf8.encode(GROUP_MSG_PREFIX), tag, epk));
  return { tag, epk, iv: nonce, ct, bucket: b, id };
}

/**
 * openGroup({ groupSecret, ledgerId, groupId, epochId, env }) -> { ok: true, from, message } | { ok: false, reason }.
 * Checks the AEAD under K_g, then the sender's signature inside. Never throws.
 */
export async function openGroup({ groupSecret, ledgerId, groupId, epochId, env }) {
  try {
    const kG = await groupKey(groupSecret, ledgerId, groupId, epochId);
    const pt = await aesGcmDecrypt(kG, env.iv, env.ct, concatBytes(utf8.encode(GROUP_MSG_PREFIX), env.tag, env.epk));
    if (!pt) return sealError('aead');
    if (BUCKETS.indexOf(pt.length) < 0) return sealError('plaintext');
    const t = readU64(pt, 16);
    if (!Number.isSafeInteger(t)) return sealError('plaintext');
    const fromRaw = pt.slice(30, 30 + POINT_BYTES);
    if (!isOnCurve(fromRaw)) return sealError('bad-point');
    const from = encodePublicKey(fromRaw);
    const sig = pt.slice(30 + POINT_BYTES, 30 + POINT_BYTES + 64);
    const at = 30 + POINT_BYTES + 64;
    const len = (pt[at] << 8) | pt[at + 1];
    if (at + 2 + len > pt.length) return sealError('plaintext');
    const body = pt.slice(at + 2, at + 2 + len);
    for (let i = at + 2 + len; i < pt.length; i++) if (pt[i] !== 0) return sealError('plaintext');
    const id = pt.slice(0, 16);
    const ok = await verifySig(from, await groupSigningBytes({ ledgerId, groupId, epochId, id, t, body }), sig);
    if (!ok) return sealError('signature');
    const n = ((pt[24] << 24) >>> 0) + (pt[25] << 16) + (pt[26] << 8) + pt[27];
    return { ok: true, from, message: { id, t, n, kind: pt[28], body } };
  } catch (_) {
    return sealError('open');
  }
}

