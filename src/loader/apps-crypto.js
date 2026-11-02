// src/loader/apps-crypto.js: the client side of the pairing code and the thin sealing wrappers of the apps on the door page
// (docs: ARCHITECTURE 15.21 and docs/APPS.md). New cryptography is NOT written here: every box is the project's own
// (src/chat/seal.js sealDm / openDm / sealTo / openFrom / sealGroup / openGroup, src/chain/crypto.js verify,
// src/chain/canonical.js canonicalize); this file adds the code split, the key derived from a code, the sealed hello, and the
// byte layout of the frames over a private lane.
//
// The code (Magic Wormhole split): 12 characters of CODE_ALPHABET shown as xxxx-xxxx-xxxx. The first 4 are the CHANNEL, the only
// part the rendezvous ever sees; the last 8 are the SECRET (40 bits), drawn from crypto.getRandomValues by the owner's client and
// never sent anywhere. Why 8 and not 4: without a PAKE a relay that keeps the sealed hellos can try secrets offline; each try costs
// 100,000 PBKDF2 rounds (about 200,000 SHA-256 compressions) and a 40-bit secret has about a million times as many candidates as a
// 20-bit one (arithmetic; no attack was run).
//   K_code = PBKDF2-SHA-256(utf8(secret), salt = utf8("mw-pair-v1|" + channel), 100000 rounds, 32 bytes)
//   box    = { iv, ct } (b64url, at most 2,048 bytes as JSON) = AES-256-GCM(K_code, iv = 12 random bytes, utf8(JSON hello),
//            aad = utf8("mw-pair-v1|hello|" + channel + "|" + role))        role = 'owner' | 'knock'
//   hello  = { pub, ek, name?, t, n, sig }   sig = b64url(sign("mw-pair-v1\n" + canonicalize({ role, channel, pub, ek, name?, t, n })))
// The rendezvous forwards boxes it cannot read. A client that cannot open a box treats it as a wrong code.
//
// Frames over a lane (mw_apps1): [0x01 version][type][payload], at most FRAME_MAX bytes, the payload JSON:
//   0x02 DM        { tag, epk, iv, ct }  sealDm under K_pair of the two chat keys, ledger id APPS_LEDGER
//   0x03 ROOM-KEY  { epk, iv, ct }       sealTo from the room owner to one member (the 32-byte room secret)
//   0x04 ROSTER    { tag, epk, iv, ct }  sealGroup under the room secret, from the room owner; the body is { k: 'roster', seq, members:
//                  [{ pub, name }] }. Sealed, so a peer of the lane that was never accepted cannot read who is in the room (ADV-1)
//   0x05 GROUP     { tag, epk, iv, ct }  sealGroup under the room secret
// Prefixes used here: mw-pair-v1 (the code, the hello and its signature, the owner's proof of an accept) and mw-apps-v1 (the room key's aad).
//
// Shared code: WebCrypto only, no Buffer, no node: imports, no DOM.

import { utf8, b64url, canonicalize } from '../chain/canonical.js'
import { verify, isPublicKeyString } from '../chain/crypto.js'
import { sha256Sync } from '../chain/sha256-sync.js'
import { sealDm, openDm, sealTo, openFrom, sealGroup, openGroup, pairKey, rawPoint, aesGcmEncrypt, aesGcmDecrypt } from '../chat/seal.js'
import { hmac } from '../chat/tags.js'
import { KIND, PT_FIXED, GCM_TAG, DAY_MS } from '../chat/limits.js'

export const PAIR_PREFIX = 'mw-pair-v1'
export const APPS_PREFIX = 'mw-apps-v1'
/** The ledger id every apps pair and room is sealed under (K_pair already binds the two chat keys). */
export const APPS_LEDGER = 'mw-apps/1'
export const EXT_NAME = 'mw_apps1'

/** 32 characters without 0, 1, l and o (the same alphabet as the short ids). */
export const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
export const CODE_LENGTH = 12
export const CHANNEL_LENGTH = 4
export const SECRET_LENGTH = 8
export const PBKDF2_ROUNDS = 100000
/** A hello's t must be this close to the checker's clock (10 minutes). */
export const HELLO_SKEW_MS = 600000
export const BOX_MAX_BYTES = 2048
export const NAME_MAX = 32

export const FRAME_VERSION = 1
export const FRAME_MAX = 16384
export const T = Object.freeze({ DM: 0x02, ROOM_KEY: 0x03, ROSTER: 0x04, GROUP: 0x05 })
const TYPE_SET = new Set([T.DM, T.ROOM_KEY, T.ROSTER, T.GROUP])

/**
 * The sealed plaintext buckets are 256, 1,024, 4,096 and 16,000 bytes. A frame is JSON with base64url fields (a third larger),
 * so the 16,000 byte bucket (ct 16,016) cannot fit FRAME_MAX; the largest usable bucket is 4,096. The longest body a DM can
 * carry is therefore 4,096 - PT_FIXED, and a group message 4,096 - 161 (id, t, n, kind, flags, sender key, signature, length).
 */
export const BUCKET_MAX = 4096
export const DM_BODY_MAX = BUCKET_MAX - PT_FIXED
export const GROUP_FIXED = 16 + 8 + 4 + 1 + 1 + 65 + 64 + 2
export const ROOM_BODY_MAX = BUCKET_MAX - GROUP_FIXED
/** The ct lengths a frame may carry (bucket + the 16 byte tag): 272, 1,040 and 4,112. */
export const CT_SIZES = Object.freeze([256, 1024, 4096].map((b) => b + GCM_TAG))
/** One room epoch: a leaver means a new room (docs/APPS.md, "Prior art and design notes"), so the group key never rotates. */
export const ROOM_EPOCH = Uint8Array.of(1)

const ALPHABET_SET = new Set(CODE_ALPHABET.split(''))
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const MS_PER_DAY = DAY_MS

function subtle () {
  const c = globalThis.crypto
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable')
  return c.subtle
}

/** randomBytes(n) -> Uint8Array(n) from crypto.getRandomValues (never Math.random). */
export function randomBytes (n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** randomId(random = randomBytes) -> 16 random base64url characters (an id, a nonce, a knock-sized token). */
export function randomId (random = randomBytes) {
  return b64url.encode(random(12))
}

export function utcDay (ms) {
  return Math.floor(ms / MS_PER_DAY)
}

function fail (code, message) {
  return Object.assign(new Error(message || code), { code })
}

// ---------------------------------------------------------------------------------------------
// Short ids and the compare code
// ---------------------------------------------------------------------------------------------

/**
 * shortIdOf(pub) -> 'k3f9-2xq1': 8 base32 characters of SHA-256(pub), the identity cards' short form. The same function as
 * shortId in src/chat/service.js (a unit test holds the two together); it is repeated here so this file needs no chat service.
 */
export function shortIdOf (pub) {
  const h = sha256Sync(utf8.encode(String(pub || '')))
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[h[i] & 31]
  return s.slice(0, 4) + '-' + s.slice(4)
}

/** K_pair of this person's chat key and the peer's, on the apps ledger (symmetric: both sides get the same 32 bytes). */
export function kPairOf (keys, peerEk) {
  return pairKey(keys.chat, peerEk, APPS_LEDGER)
}

/**
 * compareCode(kPair) -> '12345678': the 8 digits both people read to each other to rule out a substituted key. The same
 * derivation as chat.contacts.verify (HMAC(K_pair, "verify|" + ledger id), first 4 bytes mod 10^8) on the apps ledger.
 */
export async function compareCode (kPair) {
  const m = await hmac(kPair, 'verify|' + APPS_LEDGER)
  const n = (((m[0] << 24) >>> 0) + (m[1] << 16) + (m[2] << 8) + m[3]) % 100000000
  return String(n).padStart(8, '0')
}

/** formatCompare('12345678') -> '1234 5678' (the way the compare line shows it). */
export function formatCompare (digits) {
  const s = String(digits || '')
  return s.slice(0, 4) + ' ' + s.slice(4)
}

// ---------------------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------------------

const DIGIT_FIXES = new Map()
for (let i = 0; i < 10; i++) {
  DIGIT_FIXES.set(String.fromCharCode(0x06f0 + i), String(i)) // Persian digits
  DIGIT_FIXES.set(String.fromCharCode(0x0660 + i), String(i)) // Arabic-Indic digits
}
const INVISIBLE_RE = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{feff}]/gu
const SEPARATOR_RE = /[\s_.\-\u{ad}\u{2010}-\u{2015}\u{2212}]+/gu

/**
 * normalizeCode(text) -> the 12 character code, or null (a code of any other length is not a code). Lowercase; spaces,
 * hyphens (also the dashes a phone keyboard substitutes), dots, underscores and invisible marks are removed; Persian and
 * Arabic-Indic digits and full-width forms are folded; each character must be in CODE_ALPHABET.
 */
export function normalizeCode (text) {
  if (typeof text !== 'string' || text.length > 64) return null
  const folded = text.normalize('NFKC').replace(INVISIBLE_RE, '').replace(SEPARATOR_RE, '').toLowerCase()
  let s = ''
  for (const ch of folded) s += DIGIT_FIXES.has(ch) ? DIGIT_FIXES.get(ch) : ch
  if (s.length !== CODE_LENGTH) return null
  for (let i = 0; i < s.length; i++) if (!ALPHABET_SET.has(s[i])) return null
  return s
}

/** formatCode('abcd2345wxyz') -> 'abcd-2345-wxyz': three groups of four. */
export function formatCode (code) {
  const c = String(code || '')
  const groups = []
  for (let i = 0; i < c.length; i += 4) groups.push(c.slice(i, i + 4))
  return groups.join('-')
}

/** splitCode(text) -> { code, channel, secret } | null: the channel (4) is what the rendezvous sees, the secret (8) never leaves. */
export function splitCode (text) {
  const code = normalizeCode(text)
  if (!code) return null
  return { code, channel: code.slice(0, CHANNEL_LENGTH), secret: code.slice(CHANNEL_LENGTH) }
}

/** isChannel(s): four characters of CODE_ALPHABET. */
export function isChannel (s) {
  if (typeof s !== 'string' || s.length !== CHANNEL_LENGTH) return false
  for (let i = 0; i < s.length; i++) if (!ALPHABET_SET.has(s[i])) return false
  return true
}

/** generateCode(random = randomBytes) -> a 12 character code: 4 of channel and 8 of secret (32 divides 256, so a byte & 31 is uniform). */
export function generateCode (random = randomBytes) {
  const b = random(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[b[i] & 31]
  return out
}

/** codeKey(secret, channel, rounds = PBKDF2_ROUNDS) -> Promise<Uint8Array(32)>: K_code (see the header). */
export async function codeKey (secret, channel, rounds = PBKDF2_ROUNDS) {
  if (typeof secret !== 'string' || secret.length !== SECRET_LENGTH) throw new TypeError('codeKey: secret is ' + SECRET_LENGTH + ' characters')
  if (!isChannel(channel)) throw new TypeError('codeKey: channel is ' + CHANNEL_LENGTH + ' characters')
  const base = await subtle().importKey('raw', utf8.encode(secret), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8.encode(PAIR_PREFIX + '|' + channel), iterations: rounds }, base, 256)
  return new Uint8Array(bits)
}

// ---------------------------------------------------------------------------------------------
// The sealed hello
// ---------------------------------------------------------------------------------------------

function trimName (name) {
  if (typeof name !== 'string') return null
  const s = Array.from(name.trim()).slice(0, NAME_MAX).join('')
  return s || null
}

function helloAad (channel, role) {
  return utf8.encode(PAIR_PREFIX + '|hello|' + channel + '|' + role)
}

function helloSigningBytes ({ role, channel, pub, ek, name, t, n }) {
  const o = { role, channel, pub, ek, t, n }
  if (name !== undefined) o.name = name
  return utf8.encode(PAIR_PREFIX + '\n' + canonicalize(o))
}

/**
 * boxProblem(box) -> string | null: the shape the rendezvous also checks ({ iv, ct } b64url strings, at most 2,048 bytes as JSON).
 */
export function boxProblem (box) {
  if (!box || typeof box !== 'object' || Array.isArray(box)) return 'shape'
  if (typeof box.iv !== 'string' || typeof box.ct !== 'string') return 'shape'
  if (!B64URL_RE.test(box.iv) || !B64URL_RE.test(box.ct)) return 'alphabet'
  if (box.iv.length !== 16) return 'iv'
  if (box.ct.length < 22) return 'ct'
  if (utf8.encode(JSON.stringify({ iv: box.iv, ct: box.ct })).length > BOX_MAX_BYTES) return 'size'
  return null
}

/**
 * sealHello({ keyCode, channel, role, keys, name, now, random }) -> Promise<{ box: { iv, ct }, hello }>.
 * keys: { pub, sign(bytes) -> 64 bytes, chat: { pub } } (WorkingKeys). role: 'owner' | 'knock'.
 */
export async function sealHello ({ keyCode, channel, role, keys, name = null, now = Date.now(), random = randomBytes }) {
  if (role !== 'owner' && role !== 'knock') throw new TypeError('sealHello: role is owner or knock')
  if (!(keyCode instanceof Uint8Array) || keyCode.length !== 32) throw new TypeError('sealHello: keyCode is 32 bytes')
  if (!isChannel(channel)) throw new TypeError('sealHello: bad channel')
  if (!keys || typeof keys.sign !== 'function' || !keys.chat || typeof keys.pub !== 'string') throw new TypeError('sealHello: keys')
  const hello = { pub: keys.pub, ek: keys.chat.pub, t: now, n: randomId(random) }
  const nm = trimName(name)
  if (nm) hello.name = nm
  hello.sig = b64url.encode(await keys.sign(helloSigningBytes(Object.assign({ role, channel }, hello))))
  const iv = random(12)
  const ct = await aesGcmEncrypt(keyCode, iv, utf8.encode(JSON.stringify(hello)), helloAad(channel, role))
  const box = { iv: b64url.encode(iv), ct: b64url.encode(ct) }
  const bad = boxProblem(box)
  if (bad) throw fail('E_LIMIT', 'the hello does not fit a box (' + bad + ')')
  return { box, hello }
}

/**
 * helloShape(h) -> string | null: the plaintext hello's shape (the checks before any signature work).
 */
export function helloShape (h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'shape'
  if (typeof h.pub !== 'string' || !isPublicKeyString(h.pub)) return 'pub'
  if (typeof h.ek !== 'string' || !isPublicKeyString(h.ek)) return 'ek'
  if (h.name !== undefined && (typeof h.name !== 'string' || !h.name || Array.from(h.name).length > NAME_MAX)) return 'name'
  if (!Number.isSafeInteger(h.t) || h.t < 0) return 't'
  if (typeof h.n !== 'string' || h.n.length !== 16 || !B64URL_RE.test(h.n)) return 'n'
  if (typeof h.sig !== 'string' || h.sig.length !== 86 || !B64URL_RE.test(h.sig)) return 'sig'
  return null
}

/**
 * openHello({ keyCode, channel, role, box, now, skewMs, pastMs }) -> Promise<{ ok: true, hello } | { ok: false, reason }>.
 * role is the role of the box's SENDER ('owner' for the box a requester receives, 'knock' for a box an owner receives).
 * t must be at most skewMs ahead of now (10 minutes) and at most pastMs behind it (default skewMs): a knock is fresh, but an
 * owner's hello is made when the code opens and is read when a knock is accepted, so a requester passes pastMs of a day.
 * Reasons: box, aead (wrong code or another role or channel), json, shape, pub, ek, name, t, n, sig, skew, point, signature.
 * A box that opens under K_code was made by someone who knew the secret; the signature then binds the keys to the hello.
 */
export async function openHello ({ keyCode, channel, role, box, now = Date.now(), skewMs = HELLO_SKEW_MS, pastMs = skewMs }) {
  try {
    if (role !== 'owner' && role !== 'knock') return { ok: false, reason: 'role' }
    if (!(keyCode instanceof Uint8Array) || keyCode.length !== 32 || !isChannel(channel)) return { ok: false, reason: 'input' }
    if (boxProblem(box)) return { ok: false, reason: 'box' }
    const pt = await aesGcmDecrypt(keyCode, b64url.decode(box.iv), b64url.decode(box.ct), helloAad(channel, role))
    if (!pt) return { ok: false, reason: 'aead' }
    let h
    try {
      h = JSON.parse(utf8.decode(pt, { fatal: true }))
    } catch (_) {
      return { ok: false, reason: 'json' }
    }
    const bad = helloShape(h)
    if (bad) return { ok: false, reason: bad }
    if (h.t - now > skewMs || now - h.t > pastMs) return { ok: false, reason: 'skew' }
    try {
      rawPoint(h.ek)
    } catch (_) {
      return { ok: false, reason: 'point' }
    }
    const signed = helloSigningBytes({ role, channel, pub: h.pub, ek: h.ek, name: h.name, t: h.t, n: h.n })
    if (!(await verify(h.pub, signed, h.sig))) return { ok: false, reason: 'signature' }
    return { ok: true, hello: { pub: h.pub, ek: h.ek, name: h.name === undefined ? null : h.name, t: h.t, n: h.n, role } }
  } catch (_) {
    return { ok: false, reason: 'open' }
  }
}

// ---------------------------------------------------------------------------------------------
// The owner's proof of an accept
// ---------------------------------------------------------------------------------------------

/**
 * acceptSigningBytes({ channel, knock }) -> the bytes an owner signs to say that it accepted this request: "mw-pair-v1\naccept\n"
 * + JCS({ channel, knock }). The rendezvous relays the signature, never checks it (it holds no key); the requester does (ADV-7).
 */
export function acceptSigningBytes ({ channel, knock }) {
  return utf8.encode(PAIR_PREFIX + '\naccept\n' + canonicalize({ channel, knock }))
}

/** signAccept({ keys, channel, knock }) -> Promise<string>: b64url of the 64-byte signature, the proof that goes with pair-accept and room-accept. */
export async function signAccept ({ keys, channel, knock }) {
  if (!keys || typeof keys.sign !== 'function') throw new TypeError('signAccept: keys')
  if (!isChannel(channel) || typeof knock !== 'string' || !knock || knock.length > 32) throw new TypeError('signAccept: channel or knock')
  return b64url.encode(await keys.sign(acceptSigningBytes({ channel, knock })))
}

/**
 * verifyAccept({ ownerPub, channel, knock, proof }) -> Promise<boolean>: the proof is the owner's signature over this channel and
 * this knock. ownerPub is the identity key from the owner's hello (the box the requester opened with the code). Never throws.
 */
export async function verifyAccept ({ ownerPub, channel, knock, proof }) {
  try {
    if (typeof proof !== 'string' || proof.length !== 86 || !B64URL_RE.test(proof)) return false
    if (!isChannel(channel) || typeof knock !== 'string' || !knock || knock.length > 32) return false
    return await verify(ownerPub, acceptSigningBytes({ channel, knock }), proof)
  } catch (_) {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

/** encodeFrame(type, payload) -> Uint8Array | null (null when the frame would pass FRAME_MAX bytes). */
export function encodeFrame (type, payload) {
  if (!TYPE_SET.has(type)) throw new TypeError('encodeFrame: unknown type')
  const json = utf8.encode(JSON.stringify(payload))
  if (json.length + 2 > FRAME_MAX) return null
  const out = new Uint8Array(json.length + 2)
  out[0] = FRAME_VERSION
  out[1] = type
  out.set(json, 2)
  return out
}

/** decodeFrame(bytes) -> { type, payload } | null. Strict: version 1, a known type, a JSON object, at most FRAME_MAX bytes. */
export function decodeFrame (bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > FRAME_MAX) return null
    if (bytes[0] !== FRAME_VERSION || !TYPE_SET.has(bytes[1])) return null
    const payload = JSON.parse(utf8.decode(bytes.subarray(2), { fatal: true }))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    return { type: bytes[1], payload }
  } catch (_) {
    return null
  }
}

/** envToWire({ tag, epk, iv, ct }) -> the same four fields as base64url strings. */
export function envToWire (env) {
  const out = {}
  for (const k of ['tag', 'epk', 'iv', 'ct']) if (env[k] !== undefined) out[k] = b64url.encode(env[k])
  return out
}

function bytesField (o, key, sizes) {
  const v = o[key]
  if (typeof v !== 'string' || !B64URL_RE.test(v) || v.length > 22000) return null
  let b
  try {
    b = b64url.decode(v)
  } catch (_) {
    return null
  }
  if (Array.isArray(sizes) ? sizes.indexOf(b.length) < 0 : b.length !== sizes) return null
  return b
}

/** envFromWire(payload, { tag = true }) -> { tag?, epk, iv, ct } as bytes, or null (strict sizes: tag 8, epk 65, iv 12, ct one of CT_SIZES). */
export function envFromWire (o, { tag = true } = {}) {
  if (!o || typeof o !== 'object') return null
  const epk = bytesField(o, 'epk', 65)
  const iv = bytesField(o, 'iv', 12)
  const ct = bytesField(o, 'ct', tag ? CT_SIZES : 48)
  if (!epk || !iv || !ct) return null
  if (!tag) return { epk, iv, ct }
  const t = bytesField(o, 'tag', 8)
  return t ? { tag: t, epk, iv, ct } : null
}

// ---------------------------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------------------------

function bodyBytes (body, max) {
  const bytes = utf8.encode(JSON.stringify(body))
  if (bytes.length > max) throw fail('E_LIMIT', 'the message does not fit one frame')
  return bytes
}

/** dmBodySize(body) -> the UTF-8 length of the JSON a DM would carry (compare with DM_BODY_MAX). */
export function dmBodySize (body) {
  return utf8.encode(JSON.stringify(body)).length
}

/** roomBodySize(body) -> the same for a room message (compare with ROOM_BODY_MAX). */
export function roomBodySize (body) {
  return utf8.encode(JSON.stringify(body)).length
}

/**
 * sealDmBody({ keys, peerEk, body, now, n, random }) -> Promise<{ payload, id, t, n, kPair }>.
 * body: the JSON object of one body kind. payload: { tag, epk, iv, ct } as base64url strings (the 0x02 frame's payload).
 * Throws E_LIMIT when the JSON passes DM_BODY_MAX bytes.
 */
export async function sealDmBody ({ keys, peerEk, body, now = Date.now(), n = 0, random = randomBytes }) {
  const bytes = bodyBytes(body, DM_BODY_MAX)
  const id = random(16)
  const sealed = await sealDm({
    myChat: keys.chat, theirChatPub: peerEk, ledgerId: APPS_LEDGER, day: utcDay(now),
    message: { id, t: now, n, kind: KIND.text, body: bytes }
  })
  return { payload: envToWire(sealed), id: b64url.encode(id), t: now, n, kPair: sealed.kPair }
}

/**
 * openDmBody({ keys, peerEk, payload, kPair, now }) -> Promise<{ ok: true, body, id, t, n, kPair } | { ok: false, reason }>.
 * Never throws. A frame that opens was made by someone holding K_pair (the peer, or this person).
 */
export async function openDmBody ({ keys, peerEk, payload, kPair = null, now = Date.now() }) {
  try {
    const env = envFromWire(payload)
    if (!env) return { ok: false, reason: 'shape' }
    const r = await openDm({ myChat: keys.chat, ledgerId: APPS_LEDGER, env, theirChatPub: peerEk, kPair, now })
    if (!r.ok) return { ok: false, reason: r.reason }
    if (r.message.kind !== KIND.text) return { ok: false, reason: 'kind' }
    let body
    try {
      body = JSON.parse(utf8.decode(r.message.body, { fatal: true }))
    } catch (_) {
      return { ok: false, reason: 'body' }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.k !== 'string') return { ok: false, reason: 'body' }
    return { ok: true, body, id: b64url.encode(r.message.id), t: r.message.t, n: r.message.n, kPair: r.kPair }
  } catch (_) {
    return { ok: false, reason: 'open' }
  }
}

// ---------------------------------------------------------------------------------------------
// Rooms: the room secret, the roster, group messages
// ---------------------------------------------------------------------------------------------

/** The aad of a sealed room secret: "mw-apps-v1\nroomkey\n" + lane + "\n" + owner pub. */
export function roomKeyAad (lane, ownerPub) {
  return utf8.encode(APPS_PREFIX + '\nroomkey\n' + lane + '\n' + ownerPub)
}

/** sealRoomKey({ keys, memberEk, secret, lane, ownerPub }) -> Promise<{ epk, iv, ct }> (base64url strings). */
export async function sealRoomKey ({ keys, memberEk, secret, lane, ownerPub }) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new TypeError('sealRoomKey: the room secret is 32 bytes')
  const sealed = await sealTo({ myChat: keys.chat, theirChatPub: memberEk, ledgerId: APPS_LEDGER, data: secret, aad: roomKeyAad(lane, ownerPub) })
  return envToWire(sealed)
}

/** openRoomKey({ keys, ownerEk, payload, lane, ownerPub }) -> Promise<Uint8Array(32) | null>. Never throws. */
export async function openRoomKey ({ keys, ownerEk, payload, lane, ownerPub }) {
  try {
    const env = envFromWire(payload, { tag: false })
    if (!env) return null
    const out = await openFrom({ myChat: keys.chat, theirChatPub: ownerEk, ledgerId: APPS_LEDGER, epk: env.epk, iv: env.iv, ct: env.ct, aad: roomKeyAad(lane, ownerPub) })
    return out && out.length === 32 ? out : null
  } catch (_) {
    return null
  }
}

/**
 * sealGroupBody({ keys, secret, lane, body, now, n, random }) -> Promise<{ payload, id, t, n }>. The sender's key signs inside the
 * box (sealGroup), so every member can tell who wrote a message. Throws E_LIMIT past ROOM_BODY_MAX bytes of JSON.
 */
export async function sealGroupBody ({ keys, secret, lane, body, now = Date.now(), n = 0, random = randomBytes }) {
  const bytes = bodyBytes(body, ROOM_BODY_MAX)
  const id = random(16)
  const sealed = await sealGroup({
    groupSecret: secret, ledgerId: APPS_LEDGER, groupId: lane, epochId: ROOM_EPOCH, day: utcDay(now),
    sender: { pub: keys.pub, sign: (b) => keys.sign(b) },
    message: { id, t: now, n, kind: KIND.text, body: bytes }
  })
  return { payload: envToWire(sealed), id: b64url.encode(id), t: now, n }
}

/** openGroupBody({ secret, lane, payload }) -> Promise<{ ok: true, from, body, id, t, n } | { ok: false, reason }>. Never throws. */
export async function openGroupBody ({ secret, lane, payload }) {
  try {
    const env = envFromWire(payload)
    if (!env) return { ok: false, reason: 'shape' }
    const r = await openGroup({ groupSecret: secret, ledgerId: APPS_LEDGER, groupId: lane, epochId: ROOM_EPOCH, env })
    if (!r.ok) return { ok: false, reason: r.reason }
    if (r.message.kind !== KIND.text) return { ok: false, reason: 'kind' }
    let body
    try {
      body = JSON.parse(utf8.decode(r.message.body, { fatal: true }))
    } catch (_) {
      return { ok: false, reason: 'body' }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.k !== 'string') return { ok: false, reason: 'body' }
    return { ok: true, from: r.from, body, id: b64url.encode(r.message.id), t: r.message.t, n: r.message.n }
  } catch (_) {
    return { ok: false, reason: 'open' }
  }
}

// ---------------------------------------------------------------------------------------------
// The roster, sealed under the room secret
// ---------------------------------------------------------------------------------------------

/** A roster lists at most this many people (the owner included): the sealed body, at 3,935 bytes, then always fits one frame. */
export const ROSTER_MAX = 16

function rosterShape (members) {
  if (!Array.isArray(members) || members.length < 1 || members.length > ROSTER_MAX) return false
  for (const m of members) {
    if (!m || typeof m !== 'object' || typeof m.pub !== 'string' || typeof m.name !== 'string') return false
    if (!isPublicKeyString(m.pub) || Array.from(m.name).length > NAME_MAX) return false
  }
  return true
}

/**
 * sealRoster({ keys, secret, lane, seq, members, t, n, random }) -> Promise<{ payload, id, t, n }>: the room's roster as a group
 * message under the room secret, so only a holder of the secret can read who is in the room (ADV-1: a peer of the lane that was never
 * accepted gets nothing readable). The owner's signature inside the box (sealGroup) is what makes it the owner's: there is no second
 * signature. The body is { k: 'roster', seq, members: [{ pub, name }] }: the visit keys and names, and no chat keys (a member has no
 * use for another member's chat key). Throws TypeError for a bad seq or members, E_LIMIT when the body does not fit one frame.
 */
export async function sealRoster ({ keys, secret, lane, seq, members, t = Date.now(), n = 0, random = randomBytes }) {
  const list = Array.isArray(members) ? members.map((m) => ({ pub: m && m.pub, name: (m && m.name) || '' })) : null
  if (!Number.isSafeInteger(seq) || seq < 1 || !rosterShape(list)) throw new TypeError('sealRoster: seq or members')
  return sealGroupBody({ keys, secret, lane, body: { k: 'roster', seq, members: list }, now: t, n, random })
}

/**
 * openRoster({ secret, lane, payload, ownerPub }) -> Promise<{ ok: true, seq, members: [{ pub, name }], t, id } | { ok: false, reason }>.
 * The box opens only under this room's secret and lane; its sender (the key that signed inside) must be ownerPub, the key the member
 * got at room-accepted; the body must be a roster. Never throws.
 */
export async function openRoster ({ secret, lane, payload, ownerPub }) {
  const r = await openGroupBody({ secret, lane, payload })
  if (!r.ok) return r
  if (r.body.k !== 'roster') return { ok: false, reason: 'kind' }
  if (r.from !== ownerPub) return { ok: false, reason: 'sender' }
  const b = r.body
  if (!Number.isSafeInteger(b.seq) || b.seq < 1 || !rosterShape(b.members)) return { ok: false, reason: 'shape' }
  return { ok: true, seq: b.seq, members: b.members.map((m) => ({ pub: m.pub, name: m.name })), t: r.t, id: r.id }
}
