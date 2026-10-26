// Site ledger block v1 (ARCHITECTURE 6.1 and 6.3; DESIGN-REVIEW items 1-4 and S9).
//
//   e     = { v: 1, site, author, seq, prev, ts, bits, op, nonce }
//   h     = hex(sha256(utf8(canonical(e))))
//   s     = b64url(ECDSA-P256-SHA256(author, utf8("mw-block-v1\n" + h)))   raw r||s, 64 bytes
//   Block = { e, h, s, v?, z? }
//
// Payload ops ({ t:'put', k, vh }, { t:'append', l, vh }, { t:'profile', vh }) carry a SALTED
// value hash (v0.2.1, DIGEST-AMENDMENTS A1):
//   vh = hex(sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(v))))
// where z is a fresh 128-bit random salt, base64url (22 characters), carried beside v as
// block.z. v and z travel outside the hash and are dropped together, so a tombstoned block keeps
// { e, h, s } and still verifies (redact()), and the stub reveals nothing guessable about v: an
// unsalted hash of a short value ("yes", a name) could be confirmed by anyone forever. z is
// present exactly when v is; it is never the hashcash nonce. Control ops (policy, owner,
// tombstone, ban, allow) carry their whole content inside e and can never be redacted.
//
// Op names (v0.2.1 A2): put, append, profile (payload) and policy, owner, tombstone, ban, allow
// (control) are the v1 ops. v0.3 freeze group (DESIGN-REVIEW 2.5.3, 2.10.1; ARCHITECTURE 15.4)
// adds the control ops unban, keyinfo, rotate and the defined checkpoint, the optional ban.until,
// the bulk tombstone form and the policy fields modAllowPerDay, modActionsPerHour, reservedPool
// and voided; vanish and grp stay reserved. An unknown op.t (a reserved one included) makes the
// block invalid ('unknown-op'): it is rejected at ingest and never relayed. Public keys are
// algorithm-tagged strings ('p256:...', crypto.js). Validity stays a function of e (and v against
// vh) only: what an op does is decided by state.js (the rotate rsig is a signature over fields of
// e, so it is checked here).
//
// This module is pure. Who may write what (owner, moderators, writers policy, bans) is decided
// by state.js and node.js. validateBlock takes the PoW floor (minBits; node.js passes 0 for the
// owner and for moderators in effect) and the value cap (maxValueBytes) from its caller.

import { canonicalize, utf8, hex, b64url, byteLength } from './canonical.js';
import { sha256, sign, verify, isPublicKeyString } from './crypto.js';
import { leadingZeroBits, hashEntry, mine as mineInline, powAbortedError, NONCE_WIDTH, MAX_BITS } from './pow.js';
import { sha256Sync } from './sha256-sync.js';

export const LIMITS = Object.freeze({
  maxBlockBytes: 4096,
  maxPrev: 8,
  maxKey: 256,
  maxListName: 64,
  maxName: 48,
  maxChainBytesCeiling: 67108864,
  maxAllow: 1000,
  maxModerators: 50,
});

export const DEFAULT_POLICY = Object.freeze({
  writers: 'owner',
  bits: 16,
  maxValueBytes: 2048,
  maxChainBytes: 8388608,
  moderators: Object.freeze([]),
  allow: Object.freeze([]),
});

export const BLOCK_VERSION = 1;
/** Domain-separation prefix of the signed message: utf8(SIG_PREFIX + h). */
export const SIG_PREFIX = 'mw-block-v1\n';
/** e.ts is unix milliseconds rounded down to the minute. */
export const TS_ROUND_MS = 60000;
/** Upper bound for a policy's `bits` (2^32 hashes is already far beyond any phone). */
export const MAX_POLICY_BITS = 32;
export const PAYLOAD_OPS = Object.freeze(['put', 'append', 'profile']);
export const CONTROL_OPS = Object.freeze(['policy', 'owner', 'tombstone', 'ban', 'allow', 'unban', 'keyinfo', 'rotate', 'checkpoint']);
/** Reserved for later control ops (w2c-02 R6): invalid ('unknown-op') until a version defines them. */
export const FUTURE_CONTROL_OPS = Object.freeze(['vanish', 'grp']);
/** Every op name a site or a future version may not reuse for anything else (v0.2.1 A2). */
export const RESERVED_OP_NAMES = Object.freeze(PAYLOAD_OPS.concat(CONTROL_OPS, FUTURE_CONTROL_OPS));
export const WRITERS = Object.freeze(['owner', 'allow', 'open']);
/** Domain-separation prefix of the salted value hash (v0.2.1 A1). */
export const VH_PREFIX = 'mw-vh-v1\n';
/** The value salt z: 16 random bytes, base64url without padding (22 characters). */
export const SALT_BYTES = 16;
export const SALT_LENGTH = 22;
/** Domain-separation prefix of the recover-rotation signature (freeze group, DESIGN-REVIEW 2.5.3). */
export const ROTATE_PREFIX = 'mw-rotate-v1\n';
/**
 * Domain-separation prefix of the consent of `next` to a self rotation (review round, HUB-1 and SYB-1): the optional
 * `nsig` of { t: 'rotate', by: 'self' } is ECDSA P-256 by `next` over SELF_ROTATE_PREFIX + ledgerId + "\n" + from + "\n" +
 * next. Without it a self rotation only retires `from`; it never joins `next` to from's bans or allow membership.
 */
export const SELF_ROTATE_PREFIX = 'mw-rotate-self-v1\n';
/** Every policy field (v1 plus the freeze group); `t` is the op name. */
export const POLICY_FIELDS = Object.freeze(['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'moderators', 'allow',
  'modAllowPerDay', 'modActionsPerHour', 'reservedPool', 'voided']);
/** Defaults of the freeze-group policy fields (chosen, DESIGN-REVIEW 2.5.3); DEFAULT_POLICY keeps the v1 fields. */
export const FREEZE_POLICY_DEFAULTS = Object.freeze({
  modAllowPerDay: 20,
  modActionsPerHour: 60,
  reservedPool: 25,
  voided: Object.freeze([]),
});
/** Freeze-group caps (DESIGN-REVIEW 2.10.1): checkpoint heads, bulk tombstone authors, policy voided entries. */
export const FREEZE_LIMITS = Object.freeze({
  maxCheckpointHeads: 32,
  maxBulkAuthors: 64,
  maxVoided: 50,
  maxReservedPool: 50,
  maxModAllowPerDay: 1000,
  maxModActionsPerHour: 100000,
});

const PAYLOAD_SET = new Set(PAYLOAD_OPS);
const CONTROL_SET = new Set(CONTROL_OPS);
const WRITER_SET = new Set(WRITERS);
const ENTRY_KEYS = ['v', 'site', 'author', 'seq', 'prev', 'ts', 'bits', 'op', 'nonce'];
const SALT_RE = /^[A-Za-z0-9_-]{22}$/;
const POLICY_FIELD_SET = new Set(['t'].concat(POLICY_FIELDS));
const HEX64 = /^[0-9a-f]{64}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const RC_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[0-9A-Za-z_-]{0,64}$/;
const MAX_SITE_LENGTH = 128;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function exactKeys(obj, keys) {
  const own = Object.keys(obj);
  if (own.length !== keys.length) return false;
  for (const k of keys) if (!has(obj, k)) return false;
  return true;
}

const isHex64 = (x) => typeof x === 'string' && HEX64.test(x);

// ---------------------------------------------------------------------------------------------
// Salted value hash (v0.2.1 A1)
// ---------------------------------------------------------------------------------------------

/** true for a well-formed salt: 22 canonical base64url characters that decode to 16 bytes. */
export function isSalt(z) {
  if (typeof z !== 'string' || !SALT_RE.test(z)) return false;
  try {
    return b64url.decode(z).length === SALT_BYTES; // strict decoder: one spelling per salt
  } catch (_) {
    return false;
  }
}

/** A fresh salt from crypto.getRandomValues (never derived from the hashcash nonce). */
export function newSalt() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('crypto.getRandomValues is unavailable');
  return b64url.encode(c.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** The hashed text: "mw-vh-v1\n" + z + "\n" + canonical(value). TypeError for a bad salt or value. */
export function valueHashInput(value, z) {
  if (!isSalt(z)) throw new TypeError('valueHash needs the value salt z (22 base64url characters, 16 bytes)');
  return VH_PREFIX + z + '\n' + canonicalize(value);
}

function vhFromCanonical(vStr, z) {
  return VH_PREFIX + z + '\n' + vStr;
}

// Site ids are printable ASCII ("mw1:<27 b64url>" or "btih:<40 hex>"), 1..128 characters.
function isSiteId(x) {
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_SITE_LENGTH) return false;
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

export function isControlOp(op) {
  return op !== null && typeof op === 'object' && CONTROL_SET.has(op.t);
}

export function isPayloadOp(op) {
  return op !== null && typeof op === 'object' && PAYLOAD_SET.has(op.t);
}

/** Unix ms rounded down to the minute (the only ts form a valid block carries). */
export function roundTs(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) throw new TypeError('ts must be a non-negative number');
  return Math.floor(ts / TS_ROUND_MS) * TS_ROUND_MS;
}

// ---------------------------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------------------------

function keyProblem(k, maxBytes) {
  if (typeof k !== 'string' || k.length === 0) return 'op';
  if (byteLength(k) > maxBytes) return 'limit';
  return null;
}

function pubListProblem(list, max) {
  if (!Array.isArray(list)) return 'op';
  if (list.length > max) return 'limit';
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!isPublicKeyString(p) || seen.has(p)) return 'op';
    seen.add(p);
  }
  return null;
}

function intProblem(obj, key, max) {
  if (!has(obj, key)) return null;
  const v = obj[key];
  if (!Number.isSafeInteger(v) || v < 0) return 'op';
  if (v > max) return 'limit';
  return null;
}

// Profile names: at most LIMITS.maxName code points, no C0/C1 control characters, no bidi
// embedding/override/isolate controls (they can reorder neighbouring text in the UI), no lone
// surrogates. '' is allowed and clears the name.
function nameProblem(name) {
  if (typeof name !== 'string') return 'op';
  let count = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return 'op';
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) ||
      c === 0x200e || c === 0x200f || c === 0x061c) return 'op';
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = name.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return 'op';
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return 'op';
    }
    count++;
  }
  return count > LIMITS.maxName ? 'limit' : null;
}

/** { ok: true } or { ok: false, reason: 'op' | 'limit' } for a profile name. */
export function validateName(name) {
  const reason = nameProblem(name);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * Checks the fields of a (possibly partial) policy: writers in 'owner'|'allow'|'open'; bits an
 * integer 0..32; maxValueBytes 0..LIMITS.maxBlockBytes; maxChainBytes
 * 0..LIMITS.maxChainBytesCeiling; moderators (at most 50) and allow (at most 1000) arrays of
 * distinct public keys. A `t` member is accepted only as 'policy'; any other member is refused.
 * -> { ok: true } | { ok: false, reason: 'op' | 'limit', field }
 */
export function validatePolicyFields(partial) {
  const bad = (reason, field) => ({ ok: false, reason, field });
  if (!isPlainObject(partial)) return bad('op', null);
  for (const key of Object.keys(partial)) if (!POLICY_FIELD_SET.has(key)) return bad('op', key);
  if (has(partial, 't') && partial.t !== 'policy') return bad('op', 't');
  if (has(partial, 'writers') && !WRITER_SET.has(partial.writers)) return bad('op', 'writers');
  let r = intProblem(partial, 'bits', MAX_POLICY_BITS);
  if (r) return bad(r, 'bits');
  r = intProblem(partial, 'maxValueBytes', LIMITS.maxBlockBytes);
  if (r) return bad(r, 'maxValueBytes');
  r = intProblem(partial, 'maxChainBytes', LIMITS.maxChainBytesCeiling);
  if (r) return bad(r, 'maxChainBytes');
  if (has(partial, 'moderators')) {
    r = pubListProblem(partial.moderators, LIMITS.maxModerators);
    if (r) return bad(r, 'moderators');
  }
  if (has(partial, 'allow')) {
    r = pubListProblem(partial.allow, LIMITS.maxAllow);
    if (r) return bad(r, 'allow');
  }
  // Freeze group (DESIGN-REVIEW 2.5.3): moderator caps, the reserved pool, voided moderators.
  r = intProblem(partial, 'modAllowPerDay', FREEZE_LIMITS.maxModAllowPerDay);
  if (r) return bad(r, 'modAllowPerDay');
  r = intProblem(partial, 'modActionsPerHour', FREEZE_LIMITS.maxModActionsPerHour);
  if (r) return bad(r, 'modActionsPerHour');
  r = intProblem(partial, 'reservedPool', FREEZE_LIMITS.maxReservedPool);
  if (r) return bad(r, 'reservedPool');
  if (has(partial, 'voided')) {
    r = voidedProblem(partial.voided);
    if (r) return bad(r, 'voided');
  }
  return { ok: true };
}

// voided: [{ author: <p256>, after: <hex sha256> }], at most 50, one entry per author.
function voidedProblem(list) {
  if (!Array.isArray(list)) return 'op';
  if (list.length > FREEZE_LIMITS.maxVoided) return 'limit';
  const seen = new Set();
  for (const item of list) {
    if (!isPlainObject(item) || !exactKeys(item, ['author', 'after'])) return 'op';
    if (!isPublicKeyString(item.author) || !isHex64(item.after) || seen.has(item.author)) return 'op';
    seen.add(item.author);
  }
  return null;
}

/** true for a b64url string that decodes (strictly) to exactly `bytes` bytes. */
function isB64urlBytes(x, length, bytes) {
  if (typeof x !== 'string' || x.length !== length) return false;
  try {
    return b64url.decode(x).length === bytes;
  } catch (_) {
    return false;
  }
}

/** The text the recover key signs for a rotate block: "mw-rotate-v1\n" + ledgerId + "\n" + from + "\n" + next. */
export function rotateSigningInput(ledgerId, from, next) {
  return ROTATE_PREFIX + ledgerId + '\n' + from + '\n' + next;
}

/** The text `next` signs to agree to a self rotation (nsig): "mw-rotate-self-v1\n" + ledgerId + "\n" + from + "\n" + next. */
export function selfRotateSigningInput(ledgerId, from, next) {
  return SELF_ROTATE_PREFIX + ledgerId + '\n' + from + '\n' + next;
}

function rotateProblem(op) {
  if (op.by === 'self') {
    if (has(op, 'nsig')) {
      if (!exactKeys(op, ['t', 'from', 'next', 'by', 'nsig']) || typeof op.nsig !== 'string' || !SIG_RE.test(op.nsig)) return 'op';
    } else if (!exactKeys(op, ['t', 'from', 'next', 'by'])) return 'op';
  } else if (op.by === 'recover') {
    if (!exactKeys(op, ['t', 'from', 'next', 'by', 'rp', 'rsig'])) return 'op';
    if (!isPublicKeyString(op.rp) || typeof op.rsig !== 'string' || !SIG_RE.test(op.rsig)) return 'op';
  } else {
    return 'op';
  }
  if (!isPublicKeyString(op.from) || !isPublicKeyString(op.next) || op.from === op.next) return 'op';
  return null;
}

// checkpoint { t, heads: [1..32 sorted unique hex], snap: hex, n: uint >= 1, bytes: uint }. The
// v0.2.1 placeholder form (no heads) stays an undefined reserved form: 'unknown-op' (vector blk-007).
function checkpointProblem(op) {
  if (!has(op, 'heads')) return 'unknown-op';
  if (!exactKeys(op, ['t', 'heads', 'snap', 'n', 'bytes'])) return 'op';
  const heads = op.heads;
  if (!Array.isArray(heads) || heads.length === 0) return 'op';
  if (heads.length > FREEZE_LIMITS.maxCheckpointHeads) return 'limit';
  for (let i = 0; i < heads.length; i++) {
    if (!isHex64(heads[i])) return 'op';
    if (i > 0 && !(heads[i - 1] < heads[i])) return 'op';
  }
  if (!isHex64(op.snap)) return 'op';
  if (!Number.isSafeInteger(op.n) || op.n < 1) return 'op';
  if (!Number.isSafeInteger(op.bytes) || op.bytes < 0) return 'op';
  return null;
}

function tombstoneProblem(op) {
  if (has(op, 'h')) return exactKeys(op, ['t', 'h']) && isHex64(op.h) ? null : 'op';
  // Bulk form (freeze group): { t, authors: [1..64 distinct p256], before: <hex> }.
  if (!exactKeys(op, ['t', 'authors', 'before']) || !isHex64(op.before)) return 'op';
  if (!Array.isArray(op.authors) || op.authors.length === 0) return 'op';
  return pubListProblem(op.authors, FREEZE_LIMITS.maxBulkAuthors);
}

function banProblem(op) {
  if (has(op, 'until')) {
    if (!exactKeys(op, ['t', 'author', 'until'])) return 'op';
    if (!Number.isSafeInteger(op.until) || op.until < 0) return 'op';
  } else if (!exactKeys(op, ['t', 'author'])) {
    return 'op';
  }
  return isPublicKeyString(op.author) ? null : 'op';
}

function allowProblem(op) {
  for (const key of Object.keys(op)) if (key !== 't' && key !== 'add' && key !== 'remove') return 'op';
  let r = null;
  if (has(op, 'add')) {
    r = pubListProblem(op.add, LIMITS.maxAllow);
    if (r) return r;
  }
  if (has(op, 'remove')) {
    r = pubListProblem(op.remove, LIMITS.maxAllow);
    if (r) return r;
  }
  if (has(op, 'add') && has(op, 'remove')) {
    const added = new Set(op.add);
    for (const p of op.remove) if (added.has(p)) return 'op';
  }
  return null;
}

function opProblem(op) {
  if (!isPlainObject(op) || typeof op.t !== 'string') return 'op';
  switch (op.t) {
    case 'put':
      if (!exactKeys(op, ['t', 'k', 'vh']) || !isHex64(op.vh)) return 'op';
      return keyProblem(op.k, LIMITS.maxKey);
    case 'append':
      if (!exactKeys(op, ['t', 'l', 'vh']) || !isHex64(op.vh)) return 'op';
      return keyProblem(op.l, LIMITS.maxListName);
    case 'profile':
      return exactKeys(op, ['t', 'vh']) && isHex64(op.vh) ? null : 'op';
    case 'policy': {
      const r = validatePolicyFields(op);
      return r.ok ? null : r.reason;
    }
    case 'owner':
      return exactKeys(op, ['t', 'next']) && isPublicKeyString(op.next) ? null : 'op';
    case 'tombstone':
      return tombstoneProblem(op);
    case 'ban':
      return banProblem(op);
    case 'allow':
      return allowProblem(op);
    case 'unban':
      return exactKeys(op, ['t', 'author']) && isPublicKeyString(op.author) ? null : 'op';
    case 'keyinfo':
      return exactKeys(op, ['t', 'rc']) && RC_RE.test(op.rc) && isB64urlBytes(op.rc, 43, 32) ? null : 'op';
    case 'rotate':
      return rotateProblem(op);
    case 'checkpoint':
      return checkpointProblem(op);
    default:
      // The unknown-op rule (v0.2.1 A2): an op this version does not define, including the
      // reserved vanish and grp, makes the block invalid; it is neither stored nor relayed.
      return 'unknown-op';
  }
}

function entryProblem(e, opts) {
  if (!isPlainObject(e) || !exactKeys(e, ENTRY_KEYS)) return 'shape';
  if (e.v !== BLOCK_VERSION) return 'shape';
  if (!isSiteId(e.site)) return 'shape';
  if (typeof opts.site === 'string' && e.site !== opts.site) return 'shape';
  if (!isPublicKeyString(e.author)) return 'shape';
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) return 'shape';
  if (!Array.isArray(e.prev)) return 'shape';
  if (e.prev.length > LIMITS.maxPrev) return 'limit';
  for (let i = 0; i < e.prev.length; i++) {
    const p = e.prev[i];
    if (!isHex64(p)) return 'shape';
    if (i > 0 && !(e.prev[i - 1] < p)) return 'shape'; // sorted ascending and unique
  }
  // Only the genesis owner creates roots (ARCHITECTURE 6.2); checked when the caller knows it.
  if (e.prev.length === 0 && typeof opts.genesisOwner === 'string' && e.author !== opts.genesisOwner) return 'shape';
  if (!Number.isSafeInteger(e.ts) || e.ts < 0 || e.ts % TS_ROUND_MS !== 0) return 'shape';
  if (!Number.isInteger(e.bits) || e.bits < 0 || e.bits > MAX_BITS) return 'shape';
  if (typeof e.nonce !== 'string' || !NONCE_RE.test(e.nonce)) return 'shape';
  const r = opProblem(e.op);
  if (r) return r;
  // rotate (freeze group): 'self' is signed by from, 'recover' by next (a function of e).
  if (e.op.t === 'rotate' && e.author !== (e.op.by === 'self' ? e.op.from : e.op.next)) return 'op';
  return null;
}

// Structure, limits and sizes: everything that needs no hashing or signature check.
// -> { ok: false, reason } | { ok: true, eStr, vStr (null when the block carries no value) }
function inspect(block, opts) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPlainObject(block)) return fail('shape');
  for (const key of Object.keys(block)) {
    if (key !== 'e' && key !== 'h' && key !== 's' && key !== 'v' && key !== 'z') return fail('shape');
  }
  if (opts.envelope) {
    if (!isHex64(block.h)) return fail('shape');
    if (typeof block.s !== 'string' || !SIG_RE.test(block.s)) return fail('shape');
  }
  const reason = entryProblem(block.e, opts);
  if (reason) return fail(reason);
  const e = block.e;
  const hasValue = block.v !== undefined;
  const hasSalt = block.z !== undefined;
  const payload = PAYLOAD_SET.has(e.op.t);
  if (!payload && (hasValue || hasSalt)) return fail('shape'); // control ops never carry v or z
  // z travels exactly with v (A1): a stub carries neither, a value never comes without its salt.
  if (hasValue !== hasSalt) return fail('shape');
  if (hasSalt && !isSalt(block.z)) return fail('shape');
  if (payload && !hasValue && opts.requireValue) return fail('value-hash');
  let eStr;
  let vStr = null;
  try {
    eStr = canonicalize(e);
    if (hasValue) vStr = canonicalize(block.v);
  } catch (_) {
    return fail('shape'); // lone surrogates, non-JSON values, absurd nesting
  }
  const vBytes = vStr === null ? 0 : byteLength(vStr);
  if (byteLength(eStr) + vBytes + (hasSalt ? SALT_LENGTH : 0) > LIMITS.maxBlockBytes) return fail('size');
  if (vStr !== null) {
    if (vBytes > opts.maxValueBytes) return fail('value-size');
    if (e.op.t === 'profile') {
      const r = nameProblem(block.v);
      if (r) return fail(r);
    }
  }
  return { ok: true, eStr, vStr, z: hasSalt ? block.z : null };
}

function readOptions(options) {
  const o = options || {};
  return {
    minBits: Number.isInteger(o.minBits) && o.minBits > 0 ? o.minBits : 0,
    maxValueBytes: typeof o.maxValueBytes === 'number' && o.maxValueBytes >= 0 ? o.maxValueBytes : DEFAULT_POLICY.maxValueBytes,
    requireValue: o.requireValue === true,
    site: typeof o.site === 'string' ? o.site : null,
    genesisOwner: typeof o.genesisOwner === 'string' ? o.genesisOwner : null,
  };
}

/**
 * validateBlock(block, { minBits = 0, maxValueBytes = 2048, requireValue = false, site, genesisOwner })
 * -> { ok: true } | { ok: false, reason }
 *
 * Checks, cheapest first: shape and limits ('shape', 'op', 'limit', 'unknown-op' for an op.t
 * that this version does not define, reserved names included), total size of canonical(e) + canonical(v)
 * + z ('size'), value cap ('value-size'), h recomputes ('hash'), e.bits >= minBits and
 * leadingZeroBits(h) >= e.bits ('pow'), the signature ('sig'; also the rsig of a recover
 * rotation, by rp over rotateSigningInput(e.site, from, next)), and v with its salt z matches
 * op.vh ('value-hash'). v and z come together or not at all ('shape' otherwise). A payload
 * block without v is valid (a DAG node only) unless requireValue is set, which reports
 * 'value-hash'. Optional extras: `site` (e.site must equal it) and `genesisOwner` (a root,
 * prev: [], must be authored by it), both reported as 'shape'. Never throws.
 */
export async function validateBlock(block, options) {
  try {
    const opts = readOptions(options);
    const pre = inspect(block, Object.assign({ envelope: true }, opts));
    if (!pre.ok) return pre;
    const e = block.e;
    const hashU8 = await sha256(utf8.encode(pre.eStr));
    if (hex.encode(hashU8) !== block.h) return { ok: false, reason: 'hash' };
    if (e.bits < opts.minBits || leadingZeroBits(hashU8) < e.bits) return { ok: false, reason: 'pow' };
    if (!(await verify(e.author, SIG_PREFIX + block.h, block.s))) return { ok: false, reason: 'sig' };
    // A recover rotation carries rsig, ECDSA P-256 by rp over rotateSigningInput (fields of e only).
    if (e.op.t === 'rotate' && e.op.by === 'recover' &&
      !(await verify(e.op.rp, rotateSigningInput(e.site, e.op.from, e.op.next), e.op.rsig))) return { ok: false, reason: 'sig' };
    // A self rotation may carry nsig, the consent of next (HUB-1): ECDSA P-256 by next over selfRotateSigningInput.
    if (e.op.t === 'rotate' && e.op.by === 'self' && e.op.nsig !== undefined &&
      !(await verify(e.op.next, selfRotateSigningInput(e.site, e.op.from, e.op.next), e.op.nsig))) return { ok: false, reason: 'sig' };
    if (pre.vStr !== null) {
      const vh = hex.encode(await sha256(utf8.encode(vhFromCanonical(pre.vStr, pre.z))));
      if (vh !== e.op.vh) return { ok: false, reason: 'value-hash' };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'shape' };
  }
}

/**
 * valueHash(value, z) → hex(sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(value)))) (A1).
 * TypeError for values that are not plain JSON and for a missing or malformed salt.
 */
export async function valueHash(value, z) {
  return hex.encode(await sha256(utf8.encode(valueHashInput(value, z))));
}

/** valueHash with the synchronous SHA-256 (dag.js restores values synchronously). */
export function valueHashSync(value, z) {
  return hex.encode(sha256Sync(utf8.encode(valueHashInput(value, z))));
}

/**
 * Bytes counted against LIMITS.maxBlockBytes and maxChainBytes: canonical(e) + canonical(v) + the
 * 22-character salt z when the value is held.
 */
export function blockBytes(block) {
  let n = byteLength(canonicalize(block.e));
  if (block.v !== undefined) n += byteLength(canonicalize(block.v));
  if (block.z !== undefined) n += SALT_LENGTH;
  return n;
}

/**
 * The block without its value and salt ({ e, h, s }): h and s stay valid, and the stub reveals
 * nothing guessable about the value (vh is salted). Control blocks have no value, so redacting
 * one returns an equivalent block with its full content.
 */
export function redact(block) {
  return { e: block.e, h: block.h, s: block.s };
}

function inputError(reason, message) {
  const limit = reason === 'size' || reason === 'limit' || reason === 'value-size';
  const err = limit ? new Error(message) : new TypeError(message);
  err.code = limit ? 'E_LIMIT' : 'E_INVALID';
  err.reason = reason;
  return err;
}

function identityError(message) {
  const err = new Error(message);
  err.code = 'E_IDENTITY';
  return err;
}

/**
 * createBlock({ identity: { privateKey, pub }, site, seq, prev, op, value, ts, bits, miner,
 *               signal, onProgress, maxValueBytes, z }) -> Block
 *
 * `op` is given WITHOUT vh for payload ops; createBlock draws a fresh salt z (A1; `z` may be
 * passed only by test vectors, never reuse one), computes the salted vh from `value` (use null
 * to clear a key) and attaches a canonical copy of the value as v and the salt as z. Control ops
 * take no value and no salt.
 * prev is de-duplicated and sorted, ts is rounded down to the minute (default: now), bits
 * defaults to 0 (the caller picks the governing bits; owner and moderators may use 0). With
 * bits > 0 the entry is mined by `miner.mine(entry, bits, { signal, onProgress })` (pow-client)
 * or inline. Errors: TypeError code 'E_INVALID' or Error code 'E_LIMIT' (both with .reason as in
 * validateBlock) for bad input, 'E_IDENTITY' for a key problem, 'E_POW_ABORTED' on abort.
 */
export async function createBlock({
  identity, site, seq = 0, prev = [], op, value, ts, bits = 0, miner = null,
  signal = null, onProgress = null, maxValueBytes = DEFAULT_POLICY.maxValueBytes, z = undefined,
} = {}) {
  if (!identity || typeof identity !== 'object') throw identityError('createBlock needs identity { privateKey, pub }');
  const { privateKey, pub } = identity;
  if (!isPublicKeyString(pub)) throw identityError('identity.pub must be a tagged P-256 public key (p256:<base64url>)');
  if (!privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private') {
    throw identityError('identity.privateKey must be a private CryptoKey');
  }
  if (!isPlainObject(op) || typeof op.t !== 'string') throw inputError('op', 'createBlock needs an op object with a type');
  if (!Number.isInteger(bits) || bits < 0 || bits > MAX_BITS) throw inputError('shape', 'bits must be an integer from 0 to ' + MAX_BITS);
  if (!Array.isArray(prev)) throw inputError('shape', 'prev must be an array of block hashes');

  const payload = PAYLOAD_SET.has(op.t);
  let fullOp;
  let v;
  let salt;
  if (payload) {
    if (value === undefined) throw inputError('shape', 'a payload op needs a value (use null to clear a key)');
    let vStr;
    try {
      vStr = canonicalize(value);
    } catch (err) {
      throw inputError('shape', 'the value must be plain JSON: ' + err.message);
    }
    if (z !== undefined && !isSalt(z)) throw inputError('shape', 'z must be a value salt (22 base64url characters, 16 bytes)');
    salt = z === undefined ? newSalt() : z;
    v = JSON.parse(vStr); // canonical deep copy: later changes to `value` cannot alter the block
    const vh = hex.encode(await sha256(utf8.encode(vhFromCanonical(vStr, salt))));
    if (op.t === 'put') fullOp = { t: 'put', k: op.k, vh };
    else if (op.t === 'append') fullOp = { t: 'append', l: op.l, vh };
    else fullOp = { t: 'profile', vh };
  } else {
    if (value !== undefined) throw inputError('shape', 'control ops carry no value');
    if (z !== undefined) throw inputError('shape', 'control ops carry no salt');
    try {
      fullOp = JSON.parse(canonicalize(op));
    } catch (err) {
      throw inputError('op', 'the op must be plain JSON: ' + err.message);
    }
  }

  const prevList = Array.from(new Set(prev)).sort();
  const when = roundTs(ts === undefined ? Date.now() : ts);
  const draftNonce = bits > 0 ? '0'.repeat(NONCE_WIDTH) : '';
  let entry = { v: BLOCK_VERSION, site, author: pub, seq, prev: prevList, ts: when, bits, op: fullOp, nonce: draftNonce };
  const draft = payload ? { e: entry, v, z: salt } : { e: entry };
  const checkOpts = { envelope: false, maxValueBytes, requireValue: false, site: null, genesisOwner: null };
  const pre = inspect(draft, checkOpts);
  if (!pre.ok) throw inputError(pre.reason, 'invalid block: ' + pre.reason);

  if (bits > 0) {
    if (signal && signal.aborted) throw powAbortedError();
    const result = miner && typeof miner.mine === 'function'
      ? await miner.mine(entry, bits, { signal, onProgress })
      : await mineInline(entry, bits, { signal, onProgress });
    const nonce = result && result.entry ? result.entry.nonce : undefined;
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new Error('the miner returned an invalid nonce');
    entry = Object.assign({}, entry, { nonce });
    const final = inspect(payload ? { e: entry, v, z: salt } : { e: entry }, checkOpts);
    if (!final.ok) throw inputError(final.reason, 'invalid block after mining: ' + final.reason);
  } else if (signal && signal.aborted) {
    throw powAbortedError();
  }

  const { hashU8, hashHex } = await hashEntry(entry);
  if (leadingZeroBits(hashU8) < bits) throw new Error('the miner returned a nonce that misses the target');
  let sigBytes;
  try {
    sigBytes = await sign(privateKey, SIG_PREFIX + hashHex);
  } catch (err) {
    throw identityError('signing failed: ' + (err && err.message ? err.message : String(err)));
  }
  const s = b64url.encode(sigBytes);
  if (!(await verify(pub, SIG_PREFIX + hashHex, s))) throw identityError('identity.privateKey does not match identity.pub');
  const block = { e: entry, h: hashHex, s };
  if (payload) {
    block.v = v;
    block.z = salt;
  }
  return block;
}
