// Deterministic reducer of a site ledger (ARCHITECTURE 6.2, 6.5 and 15.4; DESIGN-REVIEW items 2-4,
// S9; v0.3 DESIGN-REVIEW 2.5.3, 2.10).
//
// The state is a pure function of the block set, the genesis owner, the pointer's owner key and
// the PoW floor, so every node holding the same blocks computes the same state.
//
// Owner (code review round 1: a succession is a revocation). The succession chain
// K0 -> K1 -> ... is built level by level: K0 is the genesis owner; the candidates at level m are
// the reachable { t:'owner' } blocks by Km (a hand-over to the author itself is a no-op) that have
// the chosen succession of level m - 1 in their causal past, minimal ones only (a candidate with
// another candidate of its level in its past had already been superseded). One candidate is
// chosen. Several (equivocation: the key signed two hand-overs) are never decided by total order:
// with `expectedOwner` (the pointer's owner, the visitor's trust anchor) not already in the chain,
// the candidate endorsed by expectedOwner wins: a block signed by expectedOwner whose causal past
// holds that one candidate and no other (nobody else can forge it; a later merge of both is no
// endorsement); otherwise the chain stops there and the ledger reports `ownerConflict` (owner
// changes paused until the pointer's owner endorses one hand-over).
// level(B) = the number of chosen successions in B's causal past; ownerAt(B) = K(level(B)).
// Owner standing of block B (control ops, the owner's PoW and ban exemptions): author === ownerAt(B)
// and, when a succession away from that key was chosen, B is in its causal past (or is it): what
// the old key signed before the hand-over stays valid, anything it signs beside or after it has no
// owner standing. Under an ownerConflict the contested key keeps standing only for what is in the
// causal past of every contested hand-over.
//
// Control blocks (pass 1):
//   - owner: the chosen successions;
//   - policy: owner standing; allow: owner standing, or (freeze group) a moderator in effect adding
//     keys only (a moderator allow block with a non-empty remove has no effect), at most
//     modAllowPerDay additions per moderator per UTC day of the block's time, in total order;
//   - ban, unban: owner standing, or a moderator under controlFor(C); a ban { author, until? }
//     governs that author's payload blocks with ts < until (absent: all); an unban lifts the bans
//     of that author in its causal past for the blocks in its causal future: the owner lifts any
//     ban, a moderator only bans by moderators (owner bans are lifted only by the owner); blocks the
//     ban hid before the unban stay hidden (their values stay dropped). Bans and unbans cover the
//     author's rotation family (the keys joined to it by effective rotations, in both directions:
//     a ban of the new key reaches the old one and the other way round);
//   - tombstone { h }: owner standing, a moderator under controlFor(C) (no effect on a target
//     written with owner standing), or the author of the target payload block (who pays the
//     governing PoW like any write); bulk tombstone { authors, before } (owner or moderator, before
//     in its causal past): hides every payload of those authors not in the causal future of before;
//   - moderator ban, unban and tombstone blocks beyond modActionsPerHour per moderator per hour of
//     the block's time have no effect; the block's time is max(ts, the newest ts in its causal
//     past; a covered parent counts as the newest item time in S), so a block cannot claim an hour
//     older than what it builds on (the day of a moderator allow block is taken the same way); review
//     round: a moderator block has standing only with the policy that appointed the key in its causal
//     past (HUB-4), and per checkpoint epoch a moderator has at most EPOCH_ACTION_HOURS hours of actions
//     and EPOCH_ALLOW_DAYS days of allow additions in effect (SYB-2); policy `voided: [{ author, after }]` (the fold at the
//     heads): control blocks by `author` without owner standing that are not in the causal past of
//     `after` (or are it) have no effect;
//   - keyinfo { rc }: by a key that may write under controlFor(C) (writers, allow, PoW), and only
//     as the key's first word here (MF-20): the keyinfo blocks of a key with one rc count when
//     every other block the key signed is in the causal future of one of them, roots and recover
//     rotations to the key itself excepted (a key that has already written cannot get a late
//     commitment, so a thief cannot plant one); several keyinfo blocks with that rc are one
//     commitment (two devices), two rcs with neither first are none. The first of them in total
//     order is the one kept. A key that wrote in the history a checkpoint covers (it is among S's
//     authors, it is not the genesis owner and S gives it no keyinfo) gets none later. Bans and
//     tombstones never remove a keyinfo;
//   - rotate { from, next, by }: 'self' (signed by from; PoW for non-privileged authors; review round
//     HUB-7: from must hold the write right under controlFor(C)) or
//     'recover' (signed by next; rp must hash to from's keyinfo.rc; rsig is checked by block.js).
//     Review round (HUB-1, SYB-1): a self rotation joins from and next (bans, unbans, allow membership,
//     "key changed" on next) only with nsig, next's signature (block.js); without it, it only retires from.
//     A recover rotation of from overrides any self rotation of from, in any order; among
//     recovers the first in total order (lowest (depth, h)) wins, among self rotations too. next
//     inherits from's bans and allow membership, never moderator or owner standing. A rotation is a
//     revocation, as a hand-over is (MF-20): a block by from that is not in the causal past of the
//     rotation in effect has no effect (payload, bans, unbans, tombstones), except its keyinfo and
//     rotate blocks and blocks with owner standing; a rotation settled by a checkpoint revokes every
//     later block of from. A moderator allow block of from is not revoked (rotation never moves
//     moderator standing: the owner removes the key from moderators);
//   - checkpoint: owner standing (below).
// controlFor(B) folds, in total order, the valid policy and allow blocks P with B not in
// ancestors(P): a tightening governs concurrent and later writes, but never the writes its author
// had already seen. Bans and tombstones are not subject to that exclusion (ARCHITECTURE 6.5).
//
// A payload block B takes effect only if, under controlFor(B): it is reachable from a valid root;
// it still holds its value; it is not hidden by a tombstone, a bulk tombstone or a ban (the owner
// at B is exempt from bans and from moderator tombstones); the author is the owner at B or a
// moderator, or writers is 'open', or writers is 'allow' and the author (or a key it rotated
// from) is in the allow set; non-privileged authors meet max(minBits, bits); the value fits
// maxValueBytes; keys or list names starting with '_' come from the owner or a moderator (review round,
// HUB-6: not from a voided author, a put without owner standing never replaces an entry written with
// owner standing, and a _deny/ entry changes only by the owner or its author); a put
// key '@' + authorScope16 + '/' comes from that author only (authorScope); and an item on a
// schema'd list or key (schemaOk: mw.s, mw.files, mw.ck, mw.link, _mw.cfg, _deny/, _roles/)
// matches its schema, otherwise it is hidden and has no effect (the block stays valid, stored
// and relayed). put is last-writer-wins in total order (null deletes the key), append pushes
// { h, author, ts, v }, profile sets the author's display name ('' clears it).
//
// Checkpoint (freeze group, DESIGN-REVIEW 2.5.3). S = { v: 1, covered, state }: covered is the
// b64url of the sorted 32-byte hashes of every block in the causal past of the heads (and of the
// previous checkpoint's covered set), state is the reduced state of those blocks in the format of
// checkpointFor() below (tombstoned values absent). A checkpoint block C takes effect when it has
// owner standing, every head is in its causal past (or already covered), at least one head is not
// yet covered, the ledger has no ownerConflict over the covered blocks, and n, bytes and snap
// match S computed from the blocks: n = the number of covered hashes, bytes =
// byteLength(canonical(S)), snap = hex(sha256(utf8(canonical(S)))). Once C takes effect, the
// state is S plus the blocks not covered, reduced on top of S with every covered block taken as
// in the causal past of every uncovered block (the checkpoint settles the covered history:
// moderator day and hour counts restart, covered control effects stand, bans and tombstones of
// uncovered blocks still hide covered items, an overwritten put does not come back). The total
// order of the uncovered blocks is (relative depth, h) with relative depth 0 for a block whose
// parents are all covered. A copy holding only S and the uncovered blocks (dag.pruneTo,
// reduceFromCheckpoint) computes exactly the same state; checkpoints are applied first to last in
// that order.
//
// genesisOwner === null means an ownerless ledger (unsigned pointer, "btih:" id): open writing
// with the default PoW, roots by anyone, no owner or moderator, so the only valid control blocks
// are tombstones by the target's author, keyinfo and rotations.

import { canonicalize, byteLength, utf8, hex, b64url } from './canonical.js';
import { DEFAULT_POLICY, LIMITS, FREEZE_POLICY_DEFAULTS, FREEZE_LIMITS, validateName } from './block.js';
import { sha256Sync } from './sha256-sync.js';
import { isPublicKeyString } from './crypto.js';

const PAYLOAD = new Set(['put', 'append', 'profile']);
const UNDERSCORE = 95; // '_'
const AT_SIGN = 64; // '@'
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
// Review round (SYB-2): per moderator per checkpoint epoch, at most this many hours of modActionsPerHour and days
// of modAllowPerDay take effect, whatever times the blocks claim (no new field: the owner raises the hourly and
// daily figures, or checkpoints, to give more).
export const EPOCH_ACTION_HOURS = 24;
export const EPOCH_ALLOW_DAYS = 7;
const COVERED = -2; // prevIdx marker: the parent is covered by the checkpoint base
const HEADS = -1; // liftedFor(): a block arriving now at the heads
const SETTLED = -3; // liftedFor(): an item of the checkpoint base (never in an unban's future)

/** Version of the checkpoint state S. */
export const CHECKPOINT_VERSION = 1;

function basePolicy(owned) {
  return {
    writers: owned ? DEFAULT_POLICY.writers : 'open',
    bits: DEFAULT_POLICY.bits,
    maxValueBytes: DEFAULT_POLICY.maxValueBytes,
    maxChainBytes: DEFAULT_POLICY.maxChainBytes,
    moderators: new Set(),
    allow: new Set(),
    modAllowPerDay: FREEZE_POLICY_DEFAULTS.modAllowPerDay,
    modActionsPerHour: FREEZE_POLICY_DEFAULTS.modActionsPerHour,
    reservedPool: FREEZE_POLICY_DEFAULTS.reservedPool,
    voided: [],
  };
}

function clonePolicy(p) {
  return {
    writers: p.writers,
    bits: p.bits,
    maxValueBytes: p.maxValueBytes,
    maxChainBytes: p.maxChainBytes,
    moderators: new Set(p.moderators),
    allow: new Set(p.allow),
    modAllowPerDay: p.modAllowPerDay,
    modActionsPerHour: p.modActionsPerHour,
    reservedPool: p.reservedPool,
    voided: p.voided.slice(),
  };
}

// Applies one valid policy or allow op to a control state (mutates it).
function applyPermission(cs, op) {
  if (op.t === 'policy') {
    if (op.writers !== undefined) cs.writers = op.writers;
    if (op.bits !== undefined) cs.bits = op.bits;
    if (op.maxValueBytes !== undefined) cs.maxValueBytes = op.maxValueBytes;
    if (op.maxChainBytes !== undefined) cs.maxChainBytes = op.maxChainBytes;
    if (Array.isArray(op.moderators)) cs.moderators = new Set(op.moderators.slice(0, LIMITS.maxModerators));
    if (Array.isArray(op.allow)) cs.allow = new Set(op.allow.slice(0, LIMITS.maxAllow));
    if (op.modAllowPerDay !== undefined) cs.modAllowPerDay = op.modAllowPerDay;
    if (op.modActionsPerHour !== undefined) cs.modActionsPerHour = op.modActionsPerHour;
    if (op.reservedPool !== undefined) cs.reservedPool = op.reservedPool;
    if (Array.isArray(op.voided)) {
      cs.voided = op.voided.slice(0, FREEZE_LIMITS.maxVoided).map((x) => ({ author: x.author, after: x.after }));
    }
  } else if (op.t === 'allow') {
    if (Array.isArray(op.remove)) for (const p of op.remove) cs.allow.delete(p);
    if (Array.isArray(op.add)) {
      for (const p of op.add) {
        if (cs.allow.size >= LIMITS.maxAllow) break;
        cs.allow.add(p);
      }
    }
  }
}

function valueBytesOf(dag, block) {
  if (dag && typeof dag.valueBytes === 'function' && typeof dag.has === 'function' && dag.has(block.h)) return dag.valueBytes(block.h);
  return byteLength(canonicalize(block.v));
}

function opOk(op) {
  if (op === null || typeof op !== 'object' || typeof op.t !== 'string') return false;
  if (op.t === 'put') return typeof op.k === 'string' && op.k.length > 0;
  if (op.t === 'append') return typeof op.l === 'string' && op.l.length > 0;
  return true;
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Author-scoped keys and schemas (freeze group; state rules, never validity)
// ---------------------------------------------------------------------------------------------

const SCOPES = new Map();
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * authorScope(pub) -> '@' + the first 16 characters of b64url(sha256(utf8(pub))) + '/': the put-key
 * prefix that takes effect only from that author (DESIGN-REVIEW 2.5.3, SYB A13).
 */
export function authorScope(pub) {
  let s = SCOPES.get(pub);
  if (s === undefined) {
    s = '@' + b64url.encode(sha256Sync(utf8.encode(pub))).slice(0, 16) + '/';
    if (SCOPES.size > 4096) SCOPES.clear();
    SCOPES.set(pub, s);
  }
  return s;
}

/** true when a put key has the author-scoped form '@' + 16 base64url characters + '/'. */
export function isScopedKey(k) {
  if (typeof k !== 'string' || k.length < 18 || k.charCodeAt(0) !== AT_SIGN || k.charCodeAt(17) !== 47) return false;
  return B64URL_RE.test(k.slice(1, 17));
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const ownKeys = (x) => Object.keys(x);
const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const isHexN = (x, n) => typeof x === 'string' && x.length === n && /^[0-9a-f]*$/.test(x);

function onlyKeys(obj, required, optional) {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
  for (const k of ownKeys(obj)) if (required.indexOf(k) < 0 && optional.indexOf(k) < 0) return false;
  return true;
}

function b64Bytes(x, bytes) {
  if (typeof x !== 'string' || !B64URL_RE.test(x) || x.length !== Math.ceil((bytes * 4) / 3)) return false;
  try {
    return b64url.decode(x).length === bytes;
  } catch (_) {
    return false;
  }
}

// Printable text: at most `max` code points, no C0/C1 controls, no bidi controls, no lone surrogates.
function textOk(s, max, min = 0) {
  if (typeof s !== 'string') return false;
  if (min > 0 && s.length === 0) return false;
  return validateNameLike(s, max);
}

function validateNameLike(s, max) {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
    count++;
  }
  return count <= max;
}

const SEAL_CT_BYTES = 1040; // 1 024-byte plaintext + 16-byte GCM tag (DESIGN-REVIEW 2.6.2)
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const DENY_REASONS = new Set(['P0', 'illegal', 'malware', 'spam', 'other']);
const DENY_KEY_PREFIX = '_deny/';
const CFG = {
  chat: ['off', 'members', 'open'],
  files: ['off', 'members'],
  media: ['off', 'members'],
  records: ['off', 'sealed'],
  // 'introduced' (R 2.17.2): requests need an introduction; until introductions exist the chat lane treats it as 'on'.
  requests: ['off', 'on', 'introduced'],
  // v0.3 C2 (ARCHITECTURE 15.14, INTERFACES C2; C2 integrator): calls between signed-in contacts. Without this row cfgOk refused
  // any _mw.cfg that names calls and readers hid the whole item (chat, files and media read as off with it).
  calls: ['off', 'contacts'],
  // Who may post on a person's wall (R 3.5; the social example reads it before its mw.prof fallback).
  wall: ['everyone', 'follow', 'nobody', 'approve'],
};
/**
 * The file kinds src/media/sniff.js tells apart, which an owner may block with _mw.cfg.blockTiers (R 2.8.5; files lane
 * riskTier): a list of distinct names from this set.
 */
export const CFG_TIERS = Object.freeze(['image', 'video', 'audio', 'text', 'html', 'svg', 'xml', 'pdf', 'document', 'archive', 'executable',
  'installer', 'script', 'macro', 'unknown']);
/** Every key _mw.cfg may hold (any other key hides the whole item). */
export const CFG_KEYS = Object.freeze(Object.keys(CFG).concat(['maxItems', 'chatBits', 'pin', 'age', 'turn', 'blockTiers']));

function sealOk(v) {
  if (!isObj(v) || !onlyKeys(v, ['enc', 'iv', 'ct'], ['hint'])) return false;
  if (v.enc !== 'mw-seal-v1' || !b64Bytes(v.iv, 12) || !b64Bytes(v.ct, SEAL_CT_BYTES)) return false;
  return v.hint === undefined || b64Bytes(v.hint, 4);
}

function filesOk(v) {
  if (!isObj(v) || !onlyKeys(v, ['ih', 'len', 'name', 'mime', 't'], ['sha256', 'ws'])) return false;
  if (!isHexN(v.ih, 40) || !isUint(v.len) || !isUint(v.t) || !textOk(v.name, 96, 1)) return false;
  if (typeof v.mime !== 'string' || !MIME_RE.test(v.mime)) return false;
  if (v.sha256 !== undefined && !isHexN(v.sha256, 64)) return false;
  if (v.ws !== undefined && !(typeof v.ws === 'string' && v.ws.length <= 512 && publicHttpsUrl(v.ws))) return false;
  return true;
}

// Review round (MAL53-13): a listing's web seed is https at a public host name: no plain http, no IP literal
// in a private, loopback, link-local or shared range, no IPv6 literal, no localhost or .local name.
function publicHttpsUrl(u) {
  const m = /^https:\/\/([^\/\s?#@]+)(?:[\/?#][^\s]*)?$/.exec(u);
  if (!m) return false;
  const host = m[1].replace(/:\d{1,5}$/, '').toLowerCase();
  if (host.length === 0 || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const [a, b2] = [Number(ip[1]), Number(ip[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b2 === 254) || (a === 172 && b2 >= 16 && b2 <= 31) ||
      (a === 192 && b2 === 168) || (a === 100 && b2 >= 64 && b2 <= 127)) return false;
  }
  return /^[a-z0-9.-]+$/.test(host) && host.includes('.');
}

function ckOk(v) {
  if (!isObj(v) || !onlyKeys(v, ['v', 'ledger', 'signer', 'ek', 'epoch', 'exp', 'sig'], [])) return false;
  if (v.v !== 2 || typeof v.ledger !== 'string' || v.ledger.length === 0 || v.ledger.length > 128) return false;
  if (!isPublicKeyString(v.signer) || !isPublicKeyString(v.ek) || !isUint(v.epoch) || !isUint(v.exp)) return false;
  return b64Bytes(v.sig, 64);
}

function linkOk(v) {
  if (!isObj(v) || !onlyKeys(v, ['from', 'to', 't', 'sigTo'], [])) return false;
  return isPublicKeyString(v.from) && isPublicKeyString(v.to) && isUint(v.t) && b64Bytes(v.sigTo, 64);
}

function cfgOk(v) {
  if (!isObj(v)) return false;
  for (const k of ownKeys(v)) {
    const x = v[k];
    if (CFG[k]) {
      if (CFG[k].indexOf(x) < 0) return false;
    } else if (k === 'maxItems') {
      if (!Number.isSafeInteger(x) || x < 1 || x > 32) return false;
    } else if (k === 'chatBits') {
      if (!Number.isSafeInteger(x) || x < 0 || x > 32) return false;
    } else if (k === 'pin') {
      if (!isPublicKeyString(x)) return false;
    } else if (k === 'age') {
      if (x !== 'none' && !isPublicKeyString(x)) return false;
    } else if (k === 'blockTiers') {
      if (!Array.isArray(x) || x.length > CFG_TIERS.length) return false;
      for (let i = 0; i < x.length; i++) if (CFG_TIERS.indexOf(x[i]) < 0 || x.indexOf(x[i]) !== i) return false;
    } else if (k === 'turn') {
      if (!isObj(x) || !onlyKeys(x, ['urls', 'mode'], [])) return false;
      if (x.mode !== 'static' && x.mode !== 'endpoint') return false;
      if (!Array.isArray(x.urls) || x.urls.length === 0 || x.urls.length > 8) return false;
      for (const u of x.urls) if (typeof u !== 'string' || u.length > 256 || !/^(turns?:|https:\/\/)[^\s]+$/.test(u)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function denyOk(v) {
  if (!isObj(v) || !onlyKeys(v, ['by', 't', 'reason'], ['ref'])) return false;
  if (!isPublicKeyString(v.by) || !isUint(v.t) || !DENY_REASONS.has(v.reason)) return false;
  return v.ref === undefined || textOk(v.ref, 256);
}

function rolesOk(v) {
  if (!isObj(v) || !onlyKeys(v, ['role', 'label', 't'], [])) return false;
  return textOk(v.role, 32, 1) && textOk(v.label, 48) && isUint(v.t);
}

/**
 * schemaOk(listOrKey, value, kind?) -> boolean (DESIGN-REVIEW 2.10.2, MF-21; a state rule, never
 * validity). kind is 'list' (an append) or 'key' (a put); without it, names starting with '_' are
 * keys and the others lists. Lists: mw.s (sealed item), mw.files, mw.ck (a CK record, shape only),
 * mw.link; keys: _mw.cfg, _deny/<43 b64url>, _roles/<22 b64url>. Any other name has no schema
 * (true); bare names such as dm, chat and pres are not reserved. A put of null (deleting a key) is
 * always schema-valid. A non-matching item is hidden and has no effect; its block stays valid.
 */
export function schemaOk(listOrKey, value, kind) {
  if (typeof listOrKey !== 'string') return true;
  const k = kind === 'list' || kind === 'key' ? kind : listOrKey.charCodeAt(0) === UNDERSCORE ? 'key' : 'list';
  if (k === 'list') {
    switch (listOrKey) {
      case 'mw.s': return sealOk(value);
      case 'mw.files': return filesOk(value);
      case 'mw.ck': return ckOk(value);
      case 'mw.link': return linkOk(value);
      default: return true;
    }
  }
  if (value === null) return true;
  if (listOrKey === '_mw.cfg') return cfgOk(value);
  if (listOrKey.startsWith('_deny/')) return b64Bytes(listOrKey.slice(6), 32) && denyOk(value);
  if (listOrKey.startsWith('_roles/')) return listOrKey.length === 29 && B64URL_RE.test(listOrKey.slice(7)) && rolesOk(value);
  return true;
}

// ---------------------------------------------------------------------------------------------
// The model: an ordered block list (optionally on top of a checkpoint base) and its succession.
// All passes work on positions in the order: every parent has a smaller position than its child.
// ---------------------------------------------------------------------------------------------

// Order of the blocks not covered: (relative depth, h); relative depth 0 when every parent is
// covered (or the block is a root), else 1 + max over the uncovered parents present.
function orderFrom(blocks, covered) {
  const byH = new Map();
  for (const b of blocks) if (!covered || !covered.has(b.h)) byH.set(b.h, b);
  const depth = new Map();
  for (const b of byH.values()) {
    if (depth.has(b.h)) continue;
    const stack = [b];
    while (stack.length > 0) {
      const x = stack[stack.length - 1];
      if (depth.has(x.h)) {
        stack.pop();
        continue;
      }
      let pending = false;
      let d = 0;
      for (const p of x.e.prev) {
        const pb = byH.get(p);
        if (!pb) continue;
        const pd = depth.get(p);
        if (pd === undefined) {
          stack.push(pb);
          pending = true;
        } else if (pd + 1 > d) d = pd + 1;
      }
      if (!pending) {
        depth.set(x.h, d);
        stack.pop();
      }
    }
  }
  const items = Array.from(byH.values(), (b) => ({ d: depth.get(b.h), b }));
  items.sort((a, b) => (a.d - b.d) || cmpStr(a.b.h, b.b.h));
  return items.map((x) => x.b);
}

function baseFrom(order, covered, genesisOwner) {
  const N = order.length;
  const index = new Map();
  for (let i = 0; i < N; i++) index.set(order[i].h, i);
  const prevIdx = new Array(N);
  for (let i = 0; i < N; i++) {
    const prev = order[i].e.prev;
    const arr = new Array(prev.length);
    for (let j = 0; j < prev.length; j++) {
      const p = index.get(prev[j]);
      arr[j] = p !== undefined ? p : covered && covered.has(prev[j]) ? COVERED : -1;
    }
    prevIdx[i] = arr;
  }
  // Reachability from a valid root (owned ledgers: only the genesis owner's roots); covered
  // parents are reachable (the checkpoint base is reduced state).
  const owned = genesisOwner !== null;
  const reachable = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const pv = prevIdx[i];
    if (pv.length === 0) {
      reachable[i] = !owned || order[i].e.author === genesisOwner ? 1 : 0;
      continue;
    }
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p === COVERED || (p >= 0 && reachable[p])) {
        reachable[i] = 1;
        break;
      }
    }
  }
  return { order, N, index, prevIdx, reachable, covered: covered || null };
}

// The candidates (sorted positions) without a candidate in their strict causal past.
function minimalOf(base, cand) {
  const { N, prevIdx } = base;
  const lo = cand[0];
  const isCand = new Uint8Array(N);
  for (const c of cand) isCand[c] = 1;
  const below = new Uint8Array(N);
  for (let i = lo + 1; i < N; i++) {
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= lo && (below[p] || isCand[p])) {
        below[i] = 1;
        break;
      }
    }
  }
  return cand.filter((c) => !below[c]);
}

// The candidate (sorted positions) endorsed by `who`: a reachable block signed by `who` whose
// causal past holds exactly that one candidate. -> the candidate's position, or -1.
function endorsedBy(base, cand, who) {
  const { order, N, prevIdx, reachable } = base;
  const C = cand.length;
  const W = (C + 31) >>> 5;
  const lo = cand[0];
  const slot = new Map();
  for (let k = 0; k < C; k++) slot.set(cand[k], k);
  const bits = new Uint32Array((N - lo) * W);
  let found = -1;
  for (let i = lo; i < N; i++) {
    const bi = (i - lo) * W;
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p < lo) continue;
      const pb = (p - lo) * W;
      for (let w = 0; w < W; w++) bits[bi + w] |= bits[pb + w];
      const k = slot.get(p);
      if (k !== undefined) bits[bi + (k >>> 5)] |= 1 << (k & 31);
    }
    if (!reachable[i] || order[i].e.author !== who) continue;
    let count = 0;
    let which = -1;
    for (let w = 0; w < W && count < 2; w++) {
      let x = bits[bi + w];
      while (x !== 0 && count < 2) {
        const t = x & -x;
        which = w * 32 + (31 - Math.clz32(t));
        count++;
        x ^= t;
      }
    }
    if (count !== 1) continue;
    const c = cand[which];
    if (found === -1) found = c;
    else if (found !== c) return -1;
  }
  return found;
}

// out[i] = 1 when block i is in the strict causal past of every candidate (sorted positions).
function commonPastOf(base, cand) {
  const { N, prevIdx } = base;
  const C = cand.length;
  const W = (C + 31) >>> 5;
  const hi = cand[C - 1];
  const bits = new Uint32Array((hi + 1) * W);
  const slot = new Map();
  for (let k = 0; k < C; k++) slot.set(cand[k], k);
  for (let i = hi; i >= 0; i--) {
    const bi = i * W;
    const k = slot.get(i);
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p < 0) continue;
      const pb = p * W;
      for (let w = 0; w < W; w++) bits[pb + w] |= bits[bi + w];
      if (k !== undefined) bits[pb + (k >>> 5)] |= 1 << (k & 31);
    }
  }
  const out = new Uint8Array(N);
  for (let i = 0; i <= hi; i++) {
    let all = true;
    for (let w = 0; w < W && all; w++) {
      const n = w < W - 1 ? 32 : C - 32 * (W - 1);
      const want = n === 32 ? 0xffffffff : ((1 << n) >>> 0) - 1;
      if ((bits[i * W + w] & want) >>> 0 !== want) all = false;
    }
    if (all) out[i] = 1;
  }
  return out;
}

// -> { keys, L0, chosen (positions), conflict (positions), frozen, level, chosenAt, standing }
// startKeys: the chain of the checkpoint base (its last key is the owner at every covered block).
function computeSuccession(base, genesisOwner, expectedOwner, startKeys) {
  const { order, N, prevIdx, reachable } = base;
  const keys = genesisOwner === null ? [] : startKeys ? startKeys.slice() : [genesisOwner];
  const L0 = Math.max(0, keys.length - 1);
  const level = new Int32Array(N).fill(L0);
  const chosenAt = new Uint8Array(N);
  const standing = new Uint8Array(N);
  const chosen = [];
  let conflict = [];
  let frozen = false;
  if (genesisOwner === null) return { keys, L0, chosen, conflict, frozen, level, chosenAt, standing };
  const succ = [];
  for (let i = 0; i < N; i++) {
    const e = order[i].e;
    if (reachable[i] && e.op && e.op.t === 'owner' && e.op.next !== e.author) succ.push(i);
  }
  for (let m = L0; succ.length > 0; m++) {
    const K = keys[m];
    let cand = [];
    for (const i of succ) if (level[i] === m && order[i].e.author === K) cand.push(i);
    if (cand.length === 0) break;
    if (cand.length > 1) cand = minimalOf(base, cand);
    let pick = cand.length === 1 ? cand[0] : -1;
    if (pick < 0 && expectedOwner !== null && keys.indexOf(expectedOwner) < 0) pick = endorsedBy(base, cand, expectedOwner);
    if (pick < 0) {
      frozen = true;
      conflict = cand;
      break;
    }
    chosen.push(pick);
    chosenAt[pick] = 1;
    keys.push(order[pick].e.op.next);
    const desc = new Uint8Array(N);
    desc[pick] = 1;
    for (let i = pick + 1; i < N; i++) {
      const pv = prevIdx[i];
      for (let j = 0; j < pv.length; j++) {
        const p = pv[j];
        if (p >= pick && desc[p]) {
          desc[i] = 1;
          level[i] = m + 1;
          break;
        }
      }
    }
  }
  const L = keys.length - 1;
  const before = new Uint8Array(N);
  for (const c of chosen) before[c] = 1;
  for (let i = N - 1; i >= 0; i--) {
    if (!before[i]) continue;
    const li = level[i];
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= 0 && level[p] === li) before[p] = 1;
    }
  }
  const common = frozen ? commonPastOf(base, conflict) : null;
  for (let i = 0; i < N; i++) {
    if (!reachable[i]) continue;
    const lv = level[i];
    if (order[i].e.author !== keys[lv]) continue;
    if (lv < L) standing[i] = before[i];
    else standing[i] = frozen ? common[i] : 1;
  }
  return { keys, L0, chosen, conflict, frozen, level, chosenAt, standing };
}

// The succession as kept in a State: hashes, and levelAfter(h) = level(h) + (h is a chosen
// succession), for blocks in the model and, through `dag`, for blocks added since; covered
// hashes are at the base level.
function successionView(base, s) {
  const { order, index, covered } = base;
  const extra = new Map();
  const known = (h) => {
    const i = index.get(h);
    if (i !== undefined) return s.level[i] + s.chosenAt[i];
    if (covered && covered.has(h)) return s.L0;
    return extra.get(h);
  };
  const levelAfter = (h, dag) => {
    const k = known(h);
    if (k !== undefined) return k;
    if (!dag || typeof dag.get !== 'function') return s.L0;
    const stack = [h];
    while (stack.length > 0) {
      const x = stack[stack.length - 1];
      if (known(x) !== undefined) {
        stack.pop();
        continue;
      }
      const b = dag.get(x);
      if (!b) {
        extra.set(x, s.L0);
        stack.pop();
        continue;
      }
      let pending = false;
      for (const p of b.e.prev) {
        if (known(p) === undefined) {
          stack.push(p);
          pending = true;
        }
      }
      if (pending) continue;
      let m = s.L0;
      for (const p of b.e.prev) {
        const l = known(p);
        if (l > m) m = l;
      }
      extra.set(x, m);
      stack.pop();
    }
    return known(h);
  };
  return {
    keys: s.keys.slice(),
    chosen: s.chosen.map((i) => order[i].h),
    conflict: s.conflict.map((i) => order[i].h),
    frozen: s.frozen,
    levelOf: (h) => {
      const i = index.get(h);
      if (i !== undefined) return s.level[i];
      return covered && covered.has(h) ? s.L0 : -1;
    },
    levelAfter,
    levelAfterPrev: (prev, dag) => {
      let m = s.L0;
      for (const p of prev || []) {
        const l = levelAfter(p, dag);
        if (l > m) m = l;
      }
      return m;
    },
  };
}

// Folds permission blocks (positions `perms`, in order) excluding those that descend from a block.
function makeFolder(base, start, perms, opOf) {
  const { N, prevIdx } = base;
  const K = perms.length;
  const W = (K + 31) >>> 5;
  let D = null;
  if (K > 0) {
    const permBit = new Int32Array(N).fill(-1);
    for (let j = 0; j < K; j++) permBit[perms[j]] = j;
    D = new Uint32Array(N * W);
    for (let i = N - 1; i >= 0; i--) {
      const pv = prevIdx[i];
      if (pv.length === 0) continue;
      const bi = i * W;
      const bit = permBit[i];
      for (let j = 0; j < pv.length; j++) {
        const p = pv[j];
        if (p < 0) continue;
        const pb = p * W;
        for (let w = 0; w < W; w++) D[pb + w] |= D[bi + w];
        if (bit >= 0) D[pb + (bit >>> 5)] |= 1 << (bit & 31);
      }
    }
  }
  const foldExcluding = (i) => {
    const cs = clonePolicy(start);
    for (let j = 0; j < K; j++) {
      if (i >= 0 && (D[i * W + (j >>> 5)] & (1 << (j & 31))) !== 0) continue;
      applyPermission(cs, opOf(perms[j]));
    }
    return cs;
  };
  const memo = new Map();
  let current = null;
  return {
    at(i) {
      let key = 0;
      if (W === 1) key = D[i];
      else if (W > 1) {
        key = '';
        for (let w = 0; w < W; w++) key += D[i * W + w].toString(36) + ',';
      }
      let cs = memo.get(key);
      if (cs === undefined) {
        cs = foldExcluding(i);
        memo.set(key, cs);
      }
      return cs;
    },
    current() {
      if (current === null) current = foldExcluding(-1);
      return current;
    },
  };
}

// marks[i] = 1 for i and every ancestor of i (positions).
function pastMarks(base, starts) {
  const { N, prevIdx } = base;
  const marks = new Uint8Array(N);
  const stack = [];
  for (const s of starts) {
    if (s >= 0 && !marks[s]) {
      marks[s] = 1;
      stack.push(s);
    }
  }
  while (stack.length > 0) {
    const x = stack.pop();
    const pv = prevIdx[x];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= 0 && !marks[p]) {
        marks[p] = 1;
        stack.push(p);
      }
    }
  }
  return marks;
}

// Forward bitsets: bit k of row i is set when positions[k] is a strict ancestor of i.
function forwardBits(base, positions) {
  const { N, prevIdx } = base;
  const K = positions.length;
  const W = Math.max(1, (K + 31) >>> 5);
  const bits = new Uint32Array(N * W);
  const slot = new Map();
  for (let k = 0; k < K; k++) {
    const list = slot.get(positions[k]);
    if (list) list.push(k);
    else slot.set(positions[k], [k]);
  }
  for (let i = 0; i < N; i++) {
    const bi = i * W;
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p < 0) continue;
      const pb = p * W;
      for (let w = 0; w < W; w++) bits[bi + w] |= bits[pb + w];
      const ks = slot.get(p);
      if (ks) for (const k of ks) bits[bi + (k >>> 5)] |= 1 << (k & 31);
    }
  }
  return { W, has: (i, k) => (bits[i * W + (k >>> 5)] & (1 << (k & 31))) !== 0 };
}

// ---------------------------------------------------------------------------------------------
// The core reducer: the model's blocks, in order, on top of an optional checkpoint base B.
// ---------------------------------------------------------------------------------------------

function core(base, sc, B, ctx) {
  const { order, N, index, prevIdx, reachable, covered } = base;
  const owned = ctx.owned;
  const floorBits = ctx.floorBits;
  const standing = sc.standing;
  const start = B ? B.policy : basePolicy(owned);
  const validControl = new Uint8Array(N);
  const ownerSt = (i) => owned && standing[i] === 1;

  // Pass 1a: valid successions and owner permission blocks.
  const ownerPerms = [];
  if (owned) {
    for (let i = 0; i < N; i++) {
      if (!reachable[i]) continue;
      const op = order[i].e.op;
      if (!op) continue;
      if (op.t === 'owner') {
        if (sc.chosenAt[i]) validControl[i] = 1;
      } else if ((op.t === 'policy' || op.t === 'allow') && standing[i]) {
        validControl[i] = 1;
        ownerPerms.push(i);
      } else if (op.t === 'checkpoint' && standing[i]) {
        validControl[i] = 1; // a valid control block; whether it settles anything is evaluate()'s
      }
    }
  }
  const ownerFold = makeFolder(base, start, ownerPerms, (j) => order[j].e.op);

  // voided (the fold at the heads): control blocks by `author` without owner standing outside
  // the causal past of `after` have no effect.
  const voidAfter = new Map();
  for (const v of ownerFold.current().voided) voidAfter.set(v.author, v.after);
  const voidMarks = new Map();
  const isVoided = (i) => {
    if (voidAfter.size === 0 || ownerSt(i)) return false;
    const after = voidAfter.get(order[i].e.author);
    if (after === undefined) return false;
    let marks = voidMarks.get(after);
    if (marks === undefined) {
      const ai = index.get(after);
      marks = ai === undefined ? null : pastMarks(base, [ai]);
      voidMarks.set(after, marks);
    }
    return !(marks && marks[i]);
  };

  // The time of each block for the moderator caps: max(ts, the newest ts in its causal past), so a
  // block cannot claim an hour (or a day) older than the blocks it builds on. Covered parents are the
  // settled past and add nothing (a pruned copy computes the same).
  // Review round (HUB-4): a covered parent counts as the newest item time S holds (B.maxTs), so a block built
  // on pruned history cannot claim an hour from before the checkpointed past (full and pruned copies both
  // reduce on top of S, so they agree).
  const covFloor = B && Number.isFinite(B.maxTs) ? B.maxTs : 0;
  const capTs = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let m = order[i].e.ts;
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= 0 && capTs[p] > m) m = capTs[p];
      else if (p === COVERED && covFloor > m) m = covFloor;
    }
    capTs[i] = m;
  }
  // Review round (HUB-4, SYB-2): a moderator's control blocks (allow, ban, unban, tombstone) have standing only
  // when the owner block that made the key a moderator is in their causal past (or settled by a checkpoint):
  // controlAt(i) also applies a concurrent policy, so a block forked from before the appointment used to count,
  // claiming hours from before the key was a moderator. A concurrent removal still applies (controlAt).
  // The moderator set of the fold over the owner's policy blocks in i's strict causal past is the moderators field
  // of the last of them (total order) that has one, else the settled (or genesis-less) base.
  const modPerms = ownerPerms.filter((j) => order[j].e.op.t === 'policy' && Array.isArray(order[j].e.op.moderators));
  const permPast = modPerms.length > 0 ? forwardBits(base, modPerms) : null;
  const modGranted = (i) => {
    const a = order[i].e.author;
    if (permPast) {
      for (let k = modPerms.length - 1; k >= 0; k--) {
        if (permPast.has(i, k)) return order[modPerms[k]].e.op.moderators.slice(0, LIMITS.maxModerators).includes(a);
      }
    }
    return start.moderators.has(a);
  };

  // Pass 1b: moderator allow additions, capped per moderator per UTC day.
  const modAllow = new Map();
  const dayUsed = new Map();
  const epochAllow = new Map(); // moderator -> additions since the checkpoint (SYB-2)
  if (owned) {
    for (let i = 0; i < N; i++) {
      const e = order[i].e;
      if (e.op.t !== 'allow' || !reachable[i] || ownerSt(i)) continue;
      const cs = ownerFold.at(i);
      if (!cs.moderators.has(e.author) || !modGranted(i)) continue;
      if (Array.isArray(e.op.remove) && e.op.remove.length > 0) continue; // moderators add only
      if (isVoided(i)) continue;
      const key = e.author + '|' + Math.floor(capTs[i] / DAY_MS);
      const used = dayUsed.get(key) || 0;
      // SYB-2: and at most EPOCH_ALLOW_DAYS days' worth since the checkpoint (claimed days cannot add more).
      const total = epochAllow.get(e.author) || 0;
      const room = Math.min(cs.modAllowPerDay - used, cs.modAllowPerDay * EPOCH_ALLOW_DAYS - total);
      if (room <= 0) continue;
      const adds = (e.op.add || []).slice(0, room);
      if (adds.length === 0) continue;
      dayUsed.set(key, used + adds.length);
      epochAllow.set(e.author, total + adds.length);
      modAllow.set(i, adds);
      validControl[i] = 1;
    }
  }
  let fold = ownerFold;
  if (modAllow.size > 0) {
    const perms = ownerPerms.concat(Array.from(modAllow.keys())).sort((a, b) => a - b);
    fold = makeFolder(base, start, perms, (j) => (modAllow.has(j) ? { t: 'allow', add: modAllow.get(j) } : order[j].e.op));
  }
  const controlAt = fold.at;
  const privilegedAt = (i, cs) => ownerSt(i) || cs.moderators.has(order[i].e.author);
  const powOk = (i, cs) => order[i].e.bits >= Math.max(floorBits, cs.bits);

  // Pass 1c: rotations and keyinfo.
  const baseRot = B ? B.rotations : new Map();
  const keyinfo = new Map(B ? B.keyinfo : []);
  const afterSelf = new Map(); // from -> its first self rotation (provisional: the write right is judged below)
  const selfCands = new Map(); // from -> every self rotation of from, in total order
  const recoverCand = [];
  for (let i = 0; i < N; i++) {
    const e = order[i].e;
    if (e.op.t !== 'rotate' || !reachable[i]) continue;
    if (isVoided(i)) continue;
    const cs = controlAt(i);
    if (!privilegedAt(i, cs) && !powOk(i, cs)) continue;
    if (e.op.by === 'self') {
      if (baseRot.has(e.op.from)) continue;
      const r = { next: e.op.next, by: 'self', h: order[i].h, ts: e.ts, i };
      if (e.op.nsig !== undefined) r.nsig = true; // next agreed (block.js checked the signature)
      if (!afterSelf.has(e.op.from)) afterSelf.set(e.op.from, r);
      const list = selfCands.get(e.op.from);
      if (list) list.push(r);
      else selfCands.set(e.op.from, [r]);
    } else {
      recoverCand.push(i);
    }
  }
  // keyinfo's write right counts allow membership inherited through settled and self rotations next agreed to,
  // and, for the key a valid recover rotation moves to, its from's (rounds below).
  const selfRot = new Map();
  for (const [from, r] of baseRot) if (rotationLinks(r)) selfRot.set(from, r);
  for (const [from, r] of afterSelf) if (rotationLinks(r)) selfRot.set(from, r);
  const selfChain = chainResolver(selfRot);
  const kiBlocks = new Map(); // author -> positions of its reachable keyinfo blocks (no settled keyinfo)
  for (let i = 0; i < N; i++) {
    const e = order[i].e;
    if (e.op.t !== 'keyinfo' || !reachable[i] || keyinfo.has(e.author)) continue;
    if (isVoided(i)) continue;
    const list = kiBlocks.get(e.author);
    if (list) list.push(i);
    else kiBlocks.set(e.author, [i]);
  }
  const kiWrites = (i, chain) => {
    const cs = controlAt(i);
    if (privilegedAt(i, cs)) return true;
    return mayWrite(cs, chain || selfChain(order[i].e.author)) && powOk(i, cs);
  };
  // MF-20: a commitment counts only as the key's first word here. `wrote` holds the keys that have
  // already written: the authors of the covered history (S) other than the genesis owner and a key a
  // settled recover rotation moved to, then the authors of every reachable block that is not a root
  // and not a recover rotation to its own author (admit refuses a keyinfo from them: keyinfo-late).
  const wrote = new Set();
  if (B) {
    const recovered = new Set();
    for (const r of baseRot.values()) if (r.by === 'recover') recovered.add(r.next);
    for (const a of B.authors) if (a !== ctx.genesisOwner && !recovered.has(a)) wrote.add(a);
  }
  const relevant = new Uint8Array(N);
  const unknown = ctx.unknown;
  for (let i = 0; i < N; i++) {
    const e = order[i].e;
    if (!reachable[i] || e.prev.length === 0) continue;
    if (e.op.t === 'rotate' && e.op.by === 'recover' && e.op.next === e.author) continue;
    // A partial copy (a recent window, opts.unknown) does not know the causal past of a block whose parent it lacks:
    // such a block (a keyinfo aside) counts as written but is never taken as the key's first word (2).
    relevant[i] = unknown !== null && e.op.t !== 'keyinfo' && e.prev.some((p) => unknown.has(p)) ? 2 : 1;
  }
  const locked = new Set(wrote); // a key that wrote in the covered history gets no keyinfo later
  for (let i = 0; i < N; i++) if (relevant[i]) wrote.add(order[i].e.author);
  // judge(cand): for each author of cand (author -> positions of its valid keyinfo blocks), its first blocks: the
  // relevant blocks with no relevant block of the same key in their strict causal past (32 keys per forward pass,
  // one bit each). They must all be valid keyinfo blocks with one rc; then every other block of the key is in the
  // causal future of one, and the first in total order is kept.
  const judge = (cand) => {
    const judged = Array.from(cand.keys()).filter((a) => !locked.has(a) && !keyinfo.has(a));
    if (judged.length === 0) return;
    const slot = new Int32Array(N).fill(-1);
    const slotOf = new Map();
    for (let k = 0; k < judged.length; k++) slotOf.set(judged[k], k);
    let lo = N;
    for (let i = 0; i < N; i++) {
      if (!relevant[i]) continue;
      const k = slotOf.get(order[i].e.author);
      if (k === undefined) continue;
      slot[i] = k;
      if (i < lo) lo = i;
    }
    const firsts = new Map();
    const anc = new Uint32Array(N);
    for (let s0 = 0; s0 < judged.length; s0 += 32) {
      const s1 = Math.min(judged.length, s0 + 32);
      anc.fill(0);
      for (let i = lo; i < N; i++) {
        let m = 0;
        const pv = prevIdx[i];
        for (let j = 0; j < pv.length; j++) {
          const p = pv[j];
          if (p < lo) continue;
          m |= anc[p];
          const sp = slot[p];
          if (sp >= s0 && sp < s1) m |= 1 << (sp - s0);
        }
        anc[i] = m;
        const si = slot[i];
        if (si >= s0 && si < s1 && relevant[i] === 1 && (m & (1 << (si - s0))) === 0) {
          const list = firsts.get(judged[si]);
          if (list) list.push(i);
          else firsts.set(judged[si], [i]);
        }
      }
    }
    for (const a of judged) {
      const mins = firsts.get(a) || [];
      const valid = new Set(cand.get(a));
      let rc = null;
      let ok = mins.length > 0;
      for (const i of mins) {
        const x = order[i].e.op.rc;
        if (!valid.has(i) || (rc !== null && rc !== x)) {
          ok = false;
          break;
        }
        rc = x;
      }
      if (!ok) continue;
      keyinfo.set(a, { rc, h: order[mins[0]].h, ts: order[mins[0]].e.ts });
      for (const i of mins) validControl[i] = 1;
    }
  };
  const first = new Map();
  for (const [a, list] of kiBlocks) {
    const ok = list.filter((i) => kiWrites(i, null));
    if (ok.length > 0) first.set(a, ok);
  }
  judge(first);
  // The key a valid recover rotation moves to writes its own keyinfo with its from's allow membership, before the
  // rotation in effect is chosen (a recover rotation only ever adds keys; a few rounds cover a chain of recoveries).
  const rpOk = (i) => {
    const e = order[i].e;
    const ki = keyinfo.get(e.op.from);
    return ki !== undefined && ki.rc === b64url.encode(sha256Sync(utf8.encode(e.op.rp)));
  };
  const viaFrom = new Map(); // next -> froms of valid recover rotations to it
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const i of recoverCand) {
      if (!rpOk(i)) continue;
      const { from, next } = order[i].e.op;
      const list = viaFrom.get(next);
      if (!list) {
        viaFrom.set(next, [from]);
        grew = true;
      } else if (list.indexOf(from) < 0) {
        list.push(from);
        grew = true;
      }
    }
    if (!grew) break;
    // The keys a key came from: through settled and self rotations and the valid recover rotations found so far.
    const cameFrom = (k) => {
      const out = selfChain(k).slice();
      for (let n = 0; n < out.length; n++) {
        for (const f of viaFrom.get(out[n]) || []) {
          for (const x of selfChain(f)) if (out.indexOf(x) < 0) out.push(x);
        }
      }
      return out;
    };
    const more = new Map();
    for (const nx of viaFrom.keys()) {
      if (keyinfo.has(nx) || !kiBlocks.has(nx)) continue;
      const chain = cameFrom(nx);
      const ok = kiBlocks.get(nx).filter((i) => kiWrites(i, chain));
      if (ok.length > 0) more.set(nx, ok);
    }
    const before = keyinfo.size;
    judge(more);
    if (keyinfo.size === before) break;
  }
  const afterRecover = new Map();
  for (const i of recoverCand) {
    const e = order[i].e;
    const from = e.op.from;
    const settled = baseRot.get(from);
    if ((settled && settled.by === 'recover') || afterRecover.has(from)) continue;
    if (!rpOk(i)) continue;
    afterRecover.set(from, { next: e.op.next, by: 'recover', h: order[i].h, ts: e.ts, i });
  }
  // Review round (HUB-7, SYB-4): a self rotation needs the write right of `from` under the policy that governs
  // it (privileged, or writers/allow with the allow membership inherited through linked rotations): a stranger's
  // rotate on an owner-only or allow ledger has no effect. The first self rotation of from with that right wins.
  const linkedRot = new Map();
  for (const [f, r] of baseRot) if (rotationLinks(r)) linkedRot.set(f, r);
  for (const [f, r] of afterSelf) if (rotationLinks(r) && !linkedRot.has(f)) linkedRot.set(f, r);
  for (const [f, r] of afterRecover) linkedRot.set(f, r);
  const writeChain = chainResolver(linkedRot);
  const chosenSelf = new Map();
  for (const [from, list] of selfCands) {
    for (const r of list) {
      const cs = controlAt(r.i);
      if (privilegedAt(r.i, cs) || mayWrite(cs, writeChain(from))) {
        chosenSelf.set(from, r);
        break;
      }
    }
  }
  const rotations = new Map();
  const rotAt = new Map(); // from -> position of the rotation in effect (absent: settled by the checkpoint)
  const froms = new Set(baseRot.keys());
  for (const f of afterRecover.keys()) froms.add(f);
  for (const f of chosenSelf.keys()) froms.add(f);
  for (const from of froms) {
    const s = baseRot.get(from);
    let r = null;
    if (s && s.by === 'recover') r = s;
    else if (afterRecover.has(from)) r = afterRecover.get(from);
    else if (s) r = s;
    else r = chosenSelf.get(from);
    if (r.i !== undefined) {
      validControl[r.i] = 1;
      rotAt.set(from, r.i);
    }
    const rec = { next: r.next, by: r.by, h: r.h, ts: r.ts };
    if (r.nsig === true) rec.nsig = true;
    rotations.set(from, rec);
  }
  // Review round (HUB-1, SYB-1): only a rotation `next` agreed to joins the two keys (a recover rotation is
  // signed by next; a self rotation needs next's nsig). A self rotation without it retires from (revocation
  // below, admit 'rotated') and moves neither from's bans nor its allow membership to next.
  const linked = new Map();
  for (const [f, r] of rotations) if (rotationLinks(r)) linked.set(f, r);
  const chainOf = chainResolver(linked);
  const familyOf = familyResolver(linked);
  // A rotation is a revocation (MF-20): blocks of `from` outside the causal past of the rotation in
  // effect have no effect, its keyinfo and rotate blocks and blocks with owner standing excepted. A
  // rotation settled by the checkpoint is in the past of every uncovered block.
  const revoked = new Uint8Array(N);
  if (rotations.size > 0) {
    const byFrom = new Map();
    for (let j = 0; j < N; j++) {
      const a = order[j].e.author;
      if (!rotations.has(a)) continue;
      const list = byFrom.get(a);
      if (list) list.push(j);
      else byFrom.set(a, [j]);
    }
    for (const [from, list] of byFrom) {
      const at = rotAt.get(from);
      const marks = at === undefined ? null : pastMarks(base, [at]);
      for (const j of list) {
        if (marks && marks[j]) continue;
        const t = order[j].e.op.t;
        if (t === 'keyinfo' || t === 'rotate' || ownerSt(j)) continue;
        revoked[j] = 1;
      }
    }
  }

  // Pass 1d: bans, unbans and tombstones, with the moderator hourly cap.
  const hourUsed = new Map();
  const epochActions = new Map(); // moderator -> actions in effect since the checkpoint (SYB-2)
  const capOk = (i, cs) => {
    const e = order[i].e;
    const key = e.author + '|' + Math.floor(capTs[i] / HOUR_MS);
    const used = hourUsed.get(key) || 0;
    if (used >= cs.modActionsPerHour) return false;
    // Review round (SYB-2): claimed hours are the signer's, so the hourly buckets alone let old parents and old
    // claims add up to (hours of history) x cap. A moderator also has at most EPOCH_ACTION_HOURS hours' worth of
    // actions in effect per checkpoint epoch (a checkpoint restarts the count, as it does the buckets).
    const total = epochActions.get(e.author) || 0;
    if (total >= cs.modActionsPerHour * EPOCH_ACTION_HOURS) return false;
    hourUsed.set(key, used + 1);
    epochActions.set(e.author, total + 1);
    return true;
  };
  const bans = []; // { i (-1: settled), h, author, owner, until }
  if (B) for (const b of B.bans) bans.push({ i: -1, h: b.h, author: b.author, owner: b.owner, until: b.until });
  const unbans = []; // { i, author, owner }
  const strong = new Set(B ? B.tombstoned : []); // tombstones by the owner or by the target's author
  const modT = new Set(B ? B.modTombstoned : []); // moderator tombstones (never hide owner-standing payload)
  const bulks = []; // { i, authors: Set, before: position | COVERED, mod }
  for (let i = 0; i < N; i++) {
    const b = order[i];
    const e = b.e;
    const op = e.op;
    if ((op.t !== 'ban' && op.t !== 'unban' && op.t !== 'tombstone') || !reachable[i] || revoked[i]) continue;
    const cs = controlAt(i);
    const own = ownerSt(i);
    const isMod = !own && cs.moderators.has(e.author) && modGranted(i);
    if (op.t === 'ban' || op.t === 'unban') {
      if (!own && !isMod) continue;
      if (isVoided(i)) continue;
      if (isMod && !capOk(i, cs)) continue;
      if (op.t === 'ban') bans.push({ i, h: b.h, author: op.author, owner: own, until: op.until === undefined ? Infinity : op.until });
      else unbans.push({ i, author: op.author, owner: own });
      validControl[i] = 1;
      continue;
    }
    if (op.h !== undefined) {
      const ti = index.get(op.h);
      const target = ti === undefined ? null : order[ti];
      if (target && !PAYLOAD.has(target.e.op.t)) continue; // control blocks are never redacted
      const item = !target && B ? B.byH.get(op.h) : undefined;
      const tAuthor = target ? target.e.author : item ? item.author : null;
      const tOwn = target ? owned && standing[ti] === 1 : item ? item.own : false;
      if (tAuthor !== null && tAuthor === e.author && (own || isMod || powOk(i, cs))) {
        strong.add(op.h);
        validControl[i] = 1;
        continue;
      }
      if (own) {
        strong.add(op.h);
        validControl[i] = 1;
        continue;
      }
      if (!isMod || isVoided(i) || tOwn) continue; // owner-protected payload (HUB H5)
      if (!capOk(i, cs)) continue;
      modT.add(op.h);
      validControl[i] = 1;
      continue;
    }
    // Bulk form: { authors, before }, before in the block's causal past.
    if (!own && !isMod) continue;
    if (isVoided(i)) continue;
    let before = index.get(op.before);
    if (before === undefined) {
      if (!covered || !covered.has(op.before)) continue;
      before = COVERED;
    } else if (before >= i || !pastMarks(base, [i])[before]) continue;
    if (isMod && !capOk(i, cs)) continue;
    bulks.push({ i, authors: new Set(op.authors), before, mod: isMod });
    validControl[i] = 1;
  }

  // Ban predicate: hidden(j, author, ts) when an effective ban of a key of the author's rotation
  // family governs ts and no unban with standing over it (an unban of a key of the same family)
  // lifts it for block j.
  const bansByKey = new Map();
  for (const b of bans) {
    const list = bansByKey.get(b.author);
    if (list) list.push(b);
    else bansByKey.set(b.author, [b]);
  }
  let banAnc = null;
  let unbanAnc = null;
  const afterBanSlot = new Map();
  if (unbans.length > 0) {
    const pos = [];
    for (const b of bans) {
      if (b.i >= 0) {
        afterBanSlot.set(b, pos.length);
        pos.push(b.i);
      }
    }
    banAnc = forwardBits(base, pos);
    unbanAnc = forwardBits(base, unbans.map((u) => u.i));
  }
  const liftedFor = (ban, j) => {
    if (unbans.length === 0) return false;
    for (let k = 0; k < unbans.length; k++) {
      const u = unbans[k];
      if (familyOf(u.author) !== familyOf(ban.author) || !(u.owner || !ban.owner)) continue;
      if (ban.i >= 0 && !banAnc.has(u.i, afterBanSlot.get(ban))) continue;
      if (j === HEADS) return true;
      if (j >= 0 && unbanAnc.has(j, k)) return true;
    }
    return false;
  };
  // -> 0 (not hidden), 1 (hidden by moderator bans only) or 2 (an owner ban hides it).
  const bannedAt = (j, author, ts) => {
    if (bansByKey.size === 0) return 0;
    let level = 0;
    for (const k of familyOf(author)) {
      const list = bansByKey.get(k);
      if (!list) continue;
      for (const b of list) {
        if (!(ts < b.until) || liftedFor(b, j)) continue;
        if (b.owner) return 2;
        level = 1;
      }
    }
    return level;
  };
  // Bulk predicate: payload of a listed author not in the causal future of before.
  let beforeAnc = null;
  const beforeSlot = new Map();
  if (bulks.length > 0) {
    const pos = [];
    for (const bk of bulks) {
      if (bk.before >= 0 && !beforeSlot.has(bk.before)) {
        beforeSlot.set(bk.before, pos.length);
        pos.push(bk.before);
      }
    }
    if (pos.length > 0) beforeAnc = forwardBits(base, pos);
  }
  // -> 0, 1 (hidden by moderator bulk tombstones only) or 2 (an owner bulk tombstone hides it).
  const bulkHides = (j, author, isOwner) => {
    let level = 0;
    for (const bk of bulks) {
      if (!bk.authors.has(author) || (bk.mod && isOwner)) continue;
      if (bk.before === COVERED) continue; // every uncovered block is in the future of a covered block
      if (!beforeAnc.has(j, beforeSlot.get(bk.before))) {
        if (!bk.mod) return 2;
        level = 1;
      }
    }
    return level;
  };
  const settledOwn = B ? B.own : null;
  const settledHidden = (it) => {
    const own = settledOwn.has(it.h);
    if (strong.has(it.h) || (modT.has(it.h) && !own)) return true;
    for (const bk of bulks) if (bk.authors.has(it.author) && !(bk.mod && own)) return true;
    return !own && bannedAt(SETTLED, it.author, it.ts);
  };

  // Pass 2: the settled items, then the payload effects in order.
  const kv = new Map();
  const lists = new Map();
  const profiles = new Map();
  const profileMeta = new Map();
  const authors = new Set(B ? B.authors : []);
  const redacted = new Set();
  const modHidden = new Set(); // payload hidden by moderator standing only (the node's grace, HUB-2)
  const effective = new Set();
  const ownerWritten = new Set(); // payload in effect written with owner standing
  if (B) {
    const keep = (it) => {
      if (settledHidden(it)) {
        redacted.add(it.h);
        return false;
      }
      if (settledOwn.has(it.h)) ownerWritten.add(it.h);
      return true;
    };
    for (const [k, it] of B.kv) if (keep(it)) kv.set(k, it);
    for (const [name, items] of B.lists) {
      const kept = items.filter(keep);
      if (kept.length > 0) lists.set(name, kept);
    }
    for (const [pub, it] of B.profiles) {
      if (keep(it)) {
        profiles.set(pub, it.name);
        profileMeta.set(pub, it);
      }
    }
  }
  let controlBlocks = 0;
  for (let i = 0; i < N; i++) {
    const b = order[i];
    const e = b.e;
    const op = e.op;
    if (!op || !PAYLOAD.has(op.t)) {
      if (validControl[i]) {
        controlBlocks++;
        authors.add(e.author);
        effective.add(b.h);
      }
      continue;
    }
    const isOwner = ownerSt(i);
    // How the payload is hidden: 2 by its author or with owner standing, 1 by moderator standing only (the
    // node keeps such values for the grace, so a void, a removal or an unban can show them again: HUB-2).
    let hide = strong.has(b.h) ? 2 : 0;
    if (hide === 0 && modT.has(b.h) && !isOwner) hide = 1;
    if (hide < 2 && bulks.length > 0) hide = Math.max(hide, bulkHides(i, e.author, isOwner));
    if (hide < 2 && !isOwner) hide = Math.max(hide, bannedAt(i, e.author, e.ts));
    if (hide > 0) {
      redacted.add(b.h);
      if (hide === 1) modHidden.add(b.h);
      continue;
    }
    if (!reachable[i] || b.v === undefined || !opOk(op) || revoked[i]) continue;
    const cs = controlAt(i);
    const privileged = isOwner || cs.moderators.has(e.author);
    if (!privileged) {
      if (!mayWrite(cs, chainOf(e.author))) continue;
      if (e.bits < Math.max(floorBits, cs.bits)) continue;
    }
    if (valueBytesOf(ctx.dag, b) > cs.maxValueBytes) continue;
    // Review round (HUB-6): reserved '_' entries. A voided author's puts and appends there have no effect; a
    // put without owner standing does not replace (or delete) an entry written with owner standing, and a
    // _deny/ entry is changed only by the owner or by the key that wrote it.
    if ((op.t === 'put' || op.t === 'append') && !isOwner && (op.t === 'put' ? op.k : op.l).charCodeAt(0) === UNDERSCORE) {
      if (isVoided(i)) continue;
      if (op.t === 'put') {
        const cur = kv.get(op.k);
        if (cur && (ownerWritten.has(cur.h) || (op.k.startsWith(DENY_KEY_PREFIX) && cur.author !== e.author))) continue;
      }
    }
    if (op.t === 'put') {
      if (op.k.charCodeAt(0) === UNDERSCORE && !privileged) continue;
      if (op.k.charCodeAt(0) === AT_SIGN && isScopedKey(op.k) && !op.k.startsWith(authorScope(e.author))) continue;
      if (!schemaOk(op.k, b.v, 'key')) continue;
      if (b.v === null) kv.delete(op.k);
      else kv.set(op.k, { v: b.v, author: e.author, h: b.h, ts: e.ts });
    } else if (op.t === 'append') {
      if (op.l.charCodeAt(0) === UNDERSCORE && !privileged) continue;
      if (!schemaOk(op.l, b.v, 'list')) continue;
      let list = lists.get(op.l);
      if (!list) {
        list = [];
        lists.set(op.l, list);
      }
      list.push({ h: b.h, author: e.author, ts: e.ts, v: b.v });
    } else {
      if (!validateName(b.v).ok) continue;
      if (b.v === '') {
        profiles.delete(e.author);
        profileMeta.delete(e.author);
      } else {
        profiles.set(e.author, b.v);
        profileMeta.set(e.author, { name: b.v, author: e.author, h: b.h, ts: e.ts });
      }
    }
    if (isOwner) ownerWritten.add(b.h);
    authors.add(e.author);
    effective.add(b.h);
  }

  // The ban state at the heads (what governs a block arriving now): banUntil holds every key a ban
  // reaches (Infinity when permanent), banned the permanent ones only, because whether a temporary ban
  // is in force depends on the clock (isBanned, roleOf and snapshot take `now`).
  const banned = new Set();
  const banUntil = new Map();
  const liveBans = [];
  for (const b of bans) {
    if (liftedFor(b, HEADS)) continue;
    liveBans.push(b);
    for (const k of familyOf(b.author)) {
      if (b.until === Infinity) banned.add(k);
      if (!(banUntil.get(k) >= b.until)) banUntil.set(k, b.until);
    }
  }
  const keychange = new Map();
  const rotList = Array.from(rotations, ([from, r]) => Object.assign({ from }, r));
  rotList.sort((a, b) => (a.ts - b.ts) || cmpStr(a.h, b.h));
  for (const r of rotList) {
    const rec = { from: r.from, next: r.next, by: r.by, h: r.h, ts: r.ts };
    keychange.set(r.from, rec);
    if (rotationLinks(r)) keychange.set(r.next, rec); // next is shown "key changed" only when it agreed (HUB-1)
  }
  return {
    kv, lists, profiles, profileMeta, authors, redacted, modHidden, effective, controlBlocks, ownerWritten,
    current: fold.current(), banned, banUntil, liveBans, strong, modT, keyinfo, rotations, keychange,
    chainOf, keys: sc.keys, frozen: sc.frozen, wrote,
  };
}

// A rotation joins from and next (bans, unbans, allow membership) only when next agreed: a recover rotation is
// authored by next; a self rotation carries next's nsig (review round, HUB-1 and SYB-1).
function rotationLinks(r) {
  return r.by === 'recover' || r.nsig === true;
}

function mayWrite(cs, chain) {
  if (cs.writers === 'open') return true;
  if (cs.writers !== 'allow') return false;
  for (const k of chain) if (cs.allow.has(k)) return true;
  return false;
}

// chain(author) = [author, and every key it rotated from, transitively]; memoised, cycle-safe.
function chainResolver(rotations) {
  if (rotations.size === 0) return (a) => [a];
  const from = new Map();
  for (const [f, r] of rotations) {
    const list = from.get(r.next);
    if (list) list.push(f);
    else from.set(r.next, [f]);
  }
  const memo = new Map();
  return (a) => {
    let out = memo.get(a);
    if (out) return out;
    out = [a];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const f of from.get(out[i]) || []) {
        if (!seen.has(f)) {
          seen.add(f);
          out.push(f);
        }
      }
    }
    memo.set(a, out);
    return out;
  };
}

// family(k) = the keys joined to k by rotations in effect, in both directions (k first on the first
// call). Every member maps to the same array, so two keys are of one family when family(a) === family(b).
function familyResolver(rotations) {
  const memo = new Map();
  if (rotations.size === 0) {
    return (a) => {
      let out = memo.get(a);
      if (!out) {
        out = [a];
        memo.set(a, out);
      }
      return out;
    };
  }
  const adj = new Map();
  const link = (a, b) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const [f, r] of rotations) {
    link(f, r.next);
    link(r.next, f);
  }
  return (a) => {
    let out = memo.get(a);
    if (out) return out;
    out = [a];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const x of adj.get(out[i]) || []) {
        if (!seen.has(x)) {
          seen.add(x);
          out.push(x);
        }
      }
    }
    for (const x of out) memo.set(x, out);
    return out;
  };
}

// ---------------------------------------------------------------------------------------------
// Checkpoint state S (format version 1)
// ---------------------------------------------------------------------------------------------

function itemJson(it, withName, own) {
  const out = withName ? { name: it.name, author: it.author, h: it.h, ts: it.ts } : { v: it.v, author: it.author, h: it.h, ts: it.ts };
  if (own.has(it.h)) out.o = 1;
  return out;
}

function coveredString(covered) {
  const list = Array.from(covered).sort();
  const bytes = new Uint8Array(list.length * 32);
  for (let i = 0; i < list.length; i++) bytes.set(hex.decode(list[i]), i * 32);
  return b64url.encode(bytes);
}

// S = { v: 1, covered, state } from a core result over the covered blocks.
function makeS(R, covered) {
  const p = R.current;
  const sorted = (it) => Array.from(it).sort(cmpStr);
  const ow = R.ownerWritten;
  const kv = Array.from(R.kv.keys()).sort(cmpStr).map((k) => [k, itemJson(R.kv.get(k), false, ow)]);
  const lists = Array.from(R.lists.keys()).sort(cmpStr).map((name) => [name, R.lists.get(name).map((it) => itemJson(it, false, ow))]);
  const profiles = Array.from(R.profileMeta.keys()).sort(cmpStr).map((pub) => [pub, itemJson(R.profileMeta.get(pub), true, ow)]);
  const bans = R.liveBans.map((b) => (b.until === Infinity ? { h: b.h, author: b.author, owner: b.owner } : { h: b.h, author: b.author, owner: b.owner, until: b.until }));
  bans.sort((a, b) => cmpStr(a.h, b.h) || cmpStr(a.author, b.author));
  const pending = (set) => sorted(set).filter((h) => !covered.has(h));
  return {
    v: CHECKPOINT_VERSION,
    covered: coveredString(covered),
    state: {
      owner: { keys: R.keys.slice() },
      policy: {
        writers: p.writers,
        bits: p.bits,
        maxValueBytes: p.maxValueBytes,
        maxChainBytes: p.maxChainBytes,
        moderators: sorted(p.moderators),
        allow: sorted(p.allow),
        modAllowPerDay: p.modAllowPerDay,
        modActionsPerHour: p.modActionsPerHour,
        reservedPool: p.reservedPool,
        voided: p.voided.map((x) => ({ author: x.author, after: x.after })),
      },
      kv,
      lists,
      profiles,
      bans,
      tombstoned: pending(R.strong),
      modTombstoned: pending(R.modT),
      keyinfo: Array.from(R.keyinfo.keys()).sort(cmpStr).map((a) => [a, { rc: R.keyinfo.get(a).rc, h: R.keyinfo.get(a).h, ts: R.keyinfo.get(a).ts }]),
      rotations: Array.from(R.rotations.keys()).sort(cmpStr).map((f) => {
        const r = R.rotations.get(f);
        const x = { next: r.next, by: r.by, h: r.h, ts: r.ts };
        if (r.nsig === true) x.n = 1; // a self rotation next agreed to (HUB-1); absent for every other entry
        return [f, x];
      }),
      authors: sorted(R.authors),
    },
  };
}

function snapError(message) {
  const err = new Error(message);
  err.code = 'E_SNAP';
  return err;
}

/** Decodes S.covered -> Set of hex hashes (sorted, unique). Throws E_SNAP when malformed. */
export function decodeCovered(str) {
  let bytes;
  try {
    bytes = b64url.decode(str);
  } catch (_) {
    throw snapError('checkpoint state: covered is not base64url');
  }
  if (bytes.length === 0 || bytes.length % 32 !== 0) throw snapError('checkpoint state: covered must hold 32-byte hashes');
  const out = new Set();
  let last = '';
  for (let i = 0; i < bytes.length; i += 32) {
    const h = hex.encode(bytes.subarray(i, i + 32));
    if (!(h > last)) throw snapError('checkpoint state: covered hashes must be sorted and unique');
    out.add(h);
    last = h;
  }
  return out;
}

/** snap of a checkpoint state: hex(sha256(utf8(canonical(S)))). */
export function checkpointSnap(S) {
  return hex.encode(sha256Sync(utf8.encode(canonicalize(S))));
}

// Parses S (already hash-checked by the caller) into the core's base form.
function parseS(S) {
  const bad = (what) => snapError('checkpoint state: ' + what);
  if (!isObj(S) || S.v !== CHECKPOINT_VERSION || typeof S.covered !== 'string' || !isObj(S.state)) throw bad('shape');
  const covered = decodeCovered(S.covered);
  const st = S.state;
  const arr = (x, what) => {
    if (!Array.isArray(x)) throw bad(what);
    return x;
  };
  if (!isObj(st.owner) || !Array.isArray(st.owner.keys) || st.owner.keys.length === 0) throw bad('owner');
  const p = st.policy;
  if (!isObj(p)) throw bad('policy');
  const policy = {
    writers: p.writers,
    bits: p.bits,
    maxValueBytes: p.maxValueBytes,
    maxChainBytes: p.maxChainBytes,
    moderators: new Set(arr(p.moderators, 'moderators')),
    allow: new Set(arr(p.allow, 'allow')),
    modAllowPerDay: p.modAllowPerDay,
    modActionsPerHour: p.modActionsPerHour,
    reservedPool: p.reservedPool,
    voided: arr(p.voided, 'voided').map((x) => ({ author: x.author, after: x.after })),
  };
  const byH = new Map();
  const own = new Set();
  const item = (x, profileOf) => {
    if (!isObj(x) || typeof x.h !== 'string' || typeof x.author !== 'string') throw bad('item');
    if (profileOf !== undefined && x.author !== profileOf) throw bad('profile');
    const it = profileOf !== undefined
      ? { name: x.name, author: x.author, h: x.h, ts: x.ts }
      : { v: x.v, author: x.author, h: x.h, ts: x.ts };
    if (x.o === 1) own.add(it.h);
    byH.set(it.h, { author: it.author, own: x.o === 1, ts: it.ts });
    return it;
  };
  const kv = new Map();
  for (const [k, x] of arr(st.kv, 'kv')) kv.set(k, item(x));
  const lists = new Map();
  for (const [name, items] of arr(st.lists, 'lists')) lists.set(name, arr(items, 'list').map((x) => item(x)));
  const profiles = new Map();
  for (const [pub, x] of arr(st.profiles, 'profiles')) profiles.set(pub, item(x, pub));
  const bans = arr(st.bans, 'bans').map((b) => ({ h: b.h, author: b.author, owner: b.owner === true, until: b.until === undefined ? Infinity : b.until }));
  const keyinfo = new Map();
  for (const [a, x] of arr(st.keyinfo, 'keyinfo')) keyinfo.set(a, { rc: x.rc, h: x.h, ts: x.ts });
  const rotations = new Map();
  for (const [f, x] of arr(st.rotations, 'rotations')) {
    const r = { next: x.next, by: x.by, h: x.h, ts: x.ts };
    if (x.n === 1 && x.by === 'self') r.nsig = true;
    rotations.set(f, r);
  }
  // The newest item time S holds: the cap time of a block whose parent is covered (HUB-4).
  let maxTs = 0;
  const seeTs = (t) => {
    if (Number.isFinite(t) && t > maxTs) maxTs = t;
  };
  for (const it of kv.values()) seeTs(it.ts);
  for (const items of lists.values()) for (const it of items) seeTs(it.ts);
  for (const it of profiles.values()) seeTs(it.ts);
  for (const x of keyinfo.values()) seeTs(x.ts);
  for (const x of rotations.values()) seeTs(x.ts);
  return {
    covered,
    B: {
      keys: st.owner.keys.slice(),
      policy,
      kv,
      lists,
      profiles,
      bans,
      tombstoned: arr(st.tombstoned, 'tombstoned').slice(),
      modTombstoned: arr(st.modTombstoned, 'modTombstoned').slice(),
      keyinfo,
      rotations,
      authors: arr(st.authors, 'authors').slice(),
      byH,
      own,
      maxTs,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// evaluate(): apply effective checkpoints first to last, return the final model.
// ---------------------------------------------------------------------------------------------

function contextOf(opts, dag) {
  const genesisOwner = typeof opts.genesisOwner === 'string' ? opts.genesisOwner : null;
  return {
    genesisOwner,
    expectedOwner: typeof opts.expectedOwner === 'string' && opts.expectedOwner ? opts.expectedOwner : null,
    owned: genesisOwner !== null,
    floorBits: Number.isInteger(opts.minBits) && opts.minBits > 0 ? opts.minBits : 0,
    checkpoints: opts.checkpoints !== false,
    dag: dag || null,
    unknown: opts.unknown instanceof Set && opts.unknown.size > 0 ? opts.unknown : null,
  };
}

// Tries checkpoint block at position i of the model -> null or { parsed, S, json, marks, R }.
function tryCheckpoint(base, i, B, covered, ctx) {
  const { order, index } = base;
  const op = order[i].e.op;
  if (!Array.isArray(op.heads)) return null;
  const pastOfC = pastMarks(base, [i]);
  const heads = [];
  for (const h of op.heads) {
    const hi = index.get(h);
    if (hi === undefined) {
      if (covered && covered.has(h)) continue;
      return null;
    }
    if (hi === i || !pastOfC[hi]) return null;
    heads.push(hi);
  }
  if (heads.length === 0) return null;
  const marks = pastMarks(base, heads);
  const subOrder = order.filter((_, j) => marks[j] === 1);
  const subBase = baseFrom(subOrder, covered, ctx.genesisOwner);
  const subSc = computeSuccession(subBase, ctx.genesisOwner, ctx.expectedOwner, B ? B.keys : null);
  if (subSc.frozen) return null;
  const R = core(subBase, subSc, B, ctx);
  const nextCovered = new Set(covered || []);
  for (const b of subOrder) nextCovered.add(b.h);
  if (nextCovered.size !== op.n) return null;
  const S = makeS(R, nextCovered);
  const json = canonicalize(S);
  if (byteLength(json) !== op.bytes) return null;
  if (hex.encode(sha256Sync(utf8.encode(json))) !== op.snap) return null;
  return { parsed: parseS(JSON.parse(json)), S, marks, R };
}

// -> { base, sc, B, covered, settledRedacted, settledEffective, checkpoint }
function evaluate(start, blocks, ctx, orderHint) {
  let B = start ? start.B : null;
  let covered = start ? start.covered : null;
  let current = blocks;
  let hint = start ? null : orderHint;
  const settledRedacted = new Set();
  const settledEffective = new Set();
  let checkpoint = start ? start.info : null;
  for (;;) {
    const order = hint || orderFrom(current, covered);
    hint = null;
    const base = baseFrom(order, covered, ctx.genesisOwner);
    const sc = computeSuccession(base, ctx.genesisOwner, ctx.expectedOwner, B ? B.keys : null);
    let applied = null;
    if (ctx.owned && ctx.checkpoints) {
      for (let i = 0; i < base.N && applied === null; i++) {
        if (order[i].e.op.t !== 'checkpoint' || !sc.standing[i]) continue;
        const r = tryCheckpoint(base, i, B, covered, ctx);
        if (r) applied = { i, r };
      }
    }
    if (applied === null) return { base, sc, B, covered, settledRedacted, settledEffective, checkpoint };
    const { r, i } = applied;
    for (const h of r.R.redacted) settledRedacted.add(h);
    for (const h of r.R.effective) settledEffective.add(h);
    B = r.parsed.B;
    covered = r.parsed.covered;
    const op = order[i].e.op;
    checkpoint = { h: order[i].h, snap: op.snap, n: op.n };
    // The state S this checkpoint settles, for a copy that prunes to it (ChainNode); not enumerable, so
    // the checkpoint record stays { h, snap, n } for comparisons and JSON.
    Object.defineProperty(checkpoint, 'S', { value: r.S, enumerable: false });
    current = order.filter((_, j) => r.marks[j] !== 1);
  }
}

function assemble(model, R, ctx, stats) {
  const { sc } = model;
  const owned = ctx.owned;
  const redacted = new Set(model.settledRedacted);
  for (const h of R.redacted) redacted.add(h);
  const effective = new Set();
  for (const h of model.settledEffective) if (!redacted.has(h)) effective.add(h);
  for (const h of R.effective) effective.add(h);
  const tombstoned = new Set(R.strong);
  for (const h of R.modT) tombstoned.add(h);
  const c = R.current;
  return {
    kv: R.kv,
    lists: R.lists,
    profiles: R.profiles,
    profileMeta: R.profileMeta,
    owner: owned ? sc.keys[sc.keys.length - 1] : null,
    policy: {
      writers: c.writers,
      bits: c.bits,
      maxValueBytes: c.maxValueBytes,
      maxChainBytes: c.maxChainBytes,
      moderators: c.moderators,
      allow: c.allow,
      banned: R.banned,
      banUntil: R.banUntil,
      modAllowPerDay: c.modAllowPerDay,
      modActionsPerHour: c.modActionsPerHour,
      reservedPool: c.reservedPool,
      voided: c.voided,
    },
    tombstoned,
    modTombstoned: R.modT,
    modHidden: R.modHidden,
    ownerWritten: R.ownerWritten,
    redacted,
    height: stats.height,
    depth: stats.depth,
    bytes: stats.bytes,
    capReached: stats.bytes >= c.maxChainBytes,
    authors: R.authors,
    controlBlocks: R.controlBlocks,
    effective,
    keyinfo: R.keyinfo,
    rotations: R.rotations,
    keychange: R.keychange,
    wrote: R.wrote,
    checkpoint: model.checkpoint,
    ownerless: !owned,
    ownerConflict: sc.frozen,
    succession: successionView(model.base, sc),
  };
}

// A pruned Dag (dag.pruneTo) carries its checkpoint base: { S, snap, h }.
function startOf(dag) {
  const cp = dag && typeof dag.checkpointBase === 'function' ? dag.checkpointBase() : null;
  if (!cp) return null;
  if (!cp.parsed) cp.parsed = parseS(cp.S);
  return { B: cp.parsed.B, covered: cp.parsed.covered, info: { h: cp.h, snap: cp.snap, n: cp.parsed.covered.size } };
}

function modelOf(dag, ctx) {
  const start = startOf(dag);
  if (start) return evaluate(start, Array.from(dag.blocks()), ctx, null);
  const order = dag.order();
  return evaluate(null, order, ctx, order);
}

// Memo of the latest model per (dag, genesisOwner, expectedOwner), valid while dag.version is
// unchanged (ownerAt and ownerAfter read it; reduce refreshes it).
const SUCCESSIONS = new WeakMap();

function memoKey(genesisOwner, expectedOwner) {
  return String(genesisOwner) + '|' + String(expectedOwner);
}

function successionFor(dag, genesisOwner, expectedOwner) {
  let perDag = SUCCESSIONS.get(dag);
  if (!perDag) {
    perDag = new Map();
    SUCCESSIONS.set(dag, perDag);
  }
  const key = memoKey(genesisOwner, expectedOwner);
  const hit = perDag.get(key);
  const version = typeof dag.version === 'number' ? dag.version : -1;
  if (hit && hit.version === version && version >= 0) return hit.view;
  const ctx = contextOf({ genesisOwner, expectedOwner }, dag);
  const model = modelOf(dag, ctx);
  const view = successionView(model.base, model.sc);
  perDag.set(key, { version, view });
  return view;
}

/**
 * reduce(dag, { genesisOwner = null, expectedOwner = null, minBits = 0 }) -> State
 *
 * State = { kv: Map<k, { v, author, h, ts }>, lists: Map<name, Item[]>, profiles: Map<pub, name>,
 *   profileMeta: Map<pub, { name, author, h, ts }>, owner, policy: { writers, bits,
 *   maxValueBytes, maxChainBytes, moderators: Set, allow: Set, banned: Set, banUntil: Map<pub, ms |
 *   Infinity>, modAllowPerDay, modActionsPerHour, reservedPool, voided: [{ author, after }] },
 *   tombstoned: Set<h>, modTombstoned: Set<h> (tombstoned by moderators only), modHidden: Set<h> (payload
 *   hidden by moderator standing only: a moderator tombstone, bulk tombstone or ban; review round HUB-2), ownerWritten: Set<h>
 *   (payload in effect written with owner standing), height (blocks in the DAG), bytes, authors: Set,
 *   controlBlocks (valid control blocks reduced on top of the last checkpoint), depth (max
 *   depth), capReached (bytes >= maxChainBytes), redacted: Set<h> (payload blocks whose value must
 *   be dropped), effective: Set<h> (payload blocks that took effect and valid control blocks),
 *   keyinfo: Map<pub, { rc, h, ts }>, rotations: Map<from, { next, by, h, ts }>, keychange:
 *   Map<pub, { from, next, by, h, ts }> (readers show "key changed on <date>"), wrote: Set<pub> (keys
 *   that have written here, so a keyinfo from them would be late: see keyinfo above), checkpoint:
 *   { h, snap, n } | null (the last checkpoint in effect; when the DAG is not pruned to it yet, its
 *   state S rides along as the non-enumerable checkpoint.S), ownerless, ownerConflict, succession:
 *   { keys, chosen, conflict, frozen, levelOf(h), levelAfter(h, dag?), levelAfterPrev(prev, dag?) } }
 * Item = { h, author, ts, v }.
 * `policy` is the control state at the heads, which is what governs a block arriving now. policy.banned
 * holds the keys under a permanent ban; policy.banUntil every key under a ban (until, Infinity when
 * permanent): a temporary ban is in force while now < until (isBanned(pub, state, now)).
 * A Dag pruned by dag.pruneTo() reduces from its checkpoint base; the result equals the reduce of
 * the full DAG (height, bytes and depth are those of the local DAG).
 */
export function reduce(dag, options) {
  const ctx = contextOf(options || {}, dag);
  const model = modelOf(dag, ctx);
  if (typeof dag.version === 'number') {
    let perDag = SUCCESSIONS.get(dag);
    if (!perDag) {
      perDag = new Map();
      SUCCESSIONS.set(dag, perDag);
    }
    perDag.set(memoKey(ctx.genesisOwner, ctx.expectedOwner), { version: dag.version, view: successionView(model.base, model.sc) });
  }
  const R = core(model.base, model.sc, model.B, ctx);
  return assemble(model, R, ctx, {
    height: dag.size !== undefined ? dag.size : model.base.N,
    depth: typeof dag.maxDepth === 'function' ? dag.maxDepth() : -1,
    bytes: typeof dag.bytes === 'number' ? dag.bytes : 0,
  });
}

/**
 * reduceFromCheckpoint(S, blocksAfter, { genesisOwner, expectedOwner, minBits, snap }) -> State
 *
 * The state of a ledger from its checkpoint state S = { v: 1, covered, state } and the blocks not
 * covered by it (any order; blocks whose hash is covered are ignored). S is verified first: its
 * snap, hex(sha256(utf8(canonical(S)))), must equal opts.snap or the snap of a checkpoint block
 * among blocksAfter; otherwise, or when S is malformed, it throws Error code 'E_SNAP'. Equals
 * reduce() of the full DAG (height and bytes count blocksAfter only). opts.unknown (a Set of covered hashes
 * whose blocks the caller never saw, recent.js) marks a partial copy: blocks naming one are not taken as a key's
 * first word when keyinfo is judged (only the keyinfo blocks themselves are).
 */
export function reduceFromCheckpoint(S, blocksAfter, options) {
  const opts = options || {};
  const ctx = contextOf(opts, null);
  if (!ctx.owned) throw snapError('a checkpoint needs an owned ledger (genesisOwner)');
  let snap;
  try {
    snap = checkpointSnap(S);
  } catch (_) {
    throw snapError('checkpoint state is not canonical JSON');
  }
  const list = Array.from(blocksAfter || []);
  let anchor = null;
  if (typeof opts.snap === 'string') {
    if (opts.snap !== snap) throw snapError('checkpoint state does not match snap');
  }
  for (const b of list) if (b && b.e && b.e.op && b.e.op.t === 'checkpoint' && b.e.op.snap === snap) anchor = anchor || b.h;
  if (typeof opts.snap !== 'string' && anchor === null) throw snapError('no checkpoint block names this state');
  const parsed = parseS(S);
  const start = { B: parsed.B, covered: parsed.covered, info: { h: anchor, snap, n: parsed.covered.size } };
  const blocks = list.filter((b) => !parsed.covered.has(b.h));
  const model = evaluate(start, blocks, ctx, null);
  const R = core(model.base, model.sc, model.B, ctx);
  let bytes = 0;
  for (const b of blocks) {
    bytes += byteLength(canonicalize(b.e));
    if (b.v !== undefined) bytes += byteLength(canonicalize(b.v)) + (b.z !== undefined ? 22 : 0);
  }
  return assemble(model, R, ctx, { height: blocks.length, depth: -1, bytes });
}

/**
 * checkpointFor(dag, heads, { genesisOwner, expectedOwner, minBits }) -> { S, snap, n, bytes, heads }
 *
 * What the owner signs in { t:'checkpoint', heads, snap, n, bytes } (owner tools): S over the
 * causal past of `heads` (sorted, at most 32, each held or already covered, at least one not yet
 * covered) on top of the checkpoint in effect. Throws E_SNAP when the heads cannot be covered or
 * the ledger has an ownerConflict there.
 */
export function checkpointFor(dag, heads, options) {
  const ctx = contextOf(options || {}, dag);
  if (!ctx.owned) throw snapError('a checkpoint needs an owned ledger (genesisOwner)');
  const model = modelOf(dag, ctx);
  const { base, B, covered } = model;
  const sortedHeads = Array.from(new Set(heads || [])).sort();
  if (sortedHeads.length === 0 || sortedHeads.length > FREEZE_LIMITS.maxCheckpointHeads) throw snapError('checkpoint: 1 to 32 heads');
  const pos = [];
  for (const h of sortedHeads) {
    const i = base.index.get(h);
    if (i === undefined) {
      if (covered && covered.has(h)) continue;
      throw snapError('checkpoint: head ' + h + ' is not held');
    }
    pos.push(i);
  }
  if (pos.length === 0) throw snapError('checkpoint: every head is already covered');
  const marks = pastMarks(base, pos);
  const subOrder = base.order.filter((_, j) => marks[j] === 1);
  const subBase = baseFrom(subOrder, covered, ctx.genesisOwner);
  const subSc = computeSuccession(subBase, ctx.genesisOwner, ctx.expectedOwner, B ? B.keys : null);
  if (subSc.frozen) throw snapError('checkpoint: ownerConflict over the covered blocks');
  const R = core(subBase, subSc, B, ctx);
  const nextCovered = new Set(covered || []);
  for (const b of subOrder) nextCovered.add(b.h);
  const S = makeS(R, nextCovered);
  const json = canonicalize(S);
  return { S, snap: hex.encode(sha256Sync(utf8.encode(json))), n: nextCovered.size, bytes: byteLength(json), heads: sortedHeads };
}

// ---------------------------------------------------------------------------------------------
// ownerAt / ownerAfter: read the memoised succession of the DAG as it is now.
// ---------------------------------------------------------------------------------------------

/**
 * ownerAt(dag, h, genesisOwner, expectedOwner = null) -> K(level(h)): the owner key in effect for
 * block h (null: unknown h or ownerless).
 */
export function ownerAt(dag, h, genesisOwner = null, expectedOwner = null) {
  if (typeof genesisOwner !== 'string' || !dag.has(h)) return null;
  const view = successionFor(dag, genesisOwner, typeof expectedOwner === 'string' && expectedOwner ? expectedOwner : null);
  const lv = view.levelOf(h);
  return lv < 0 ? null : view.keys[lv];
}

/**
 * ownerAfter(dag, prev, genesisOwner, expectedOwner = null) -> the owner key in effect for a new
 * block whose parents are `prev` (all in the DAG or covered).
 */
export function ownerAfter(dag, prev, genesisOwner = null, expectedOwner = null) {
  if (typeof genesisOwner !== 'string') return null;
  const view = successionFor(dag, genesisOwner, typeof expectedOwner === 'string' && expectedOwner ? expectedOwner : null);
  return view.keys[view.levelAfterPrev(prev || [], dag)];
}

/**
 * ownerStanding(state, block, { dag, expectedOwner }) -> true when `block`, arriving now with all
 * of its parents in `dag` (and no descendants), would have owner standing.
 */
export function ownerStanding(state, block, options) {
  if (!state || state.ownerless || typeof state.owner !== 'string') return false;
  const opts = options || {};
  const dag = opts.dag || null;
  const e = block.e;
  const sc = state.succession;
  if (!sc) return e.author === state.owner;
  const last = sc.keys.length - 1;
  const lv = sc.levelAfterPrev(e.prev, dag);
  if (!sc.frozen) return lv === last && e.author === sc.keys[last];
  const x = typeof opts.expectedOwner === 'string' ? opts.expectedOwner : null;
  if (x === null || e.author !== x || sc.keys.indexOf(x) >= 0 || !dag || lv !== last) return false;
  const past = new Set();
  for (const p of e.prev) {
    past.add(p);
    if (typeof dag.ancestors === 'function' && dag.has(p)) for (const a of dag.ancestors(p)) past.add(a);
  }
  let count = 0;
  for (const c of sc.conflict) if (past.has(c)) count++;
  return count === 1;
}

/**
 * revokedAuthor(state, block, dag) -> true when `block` (all of its parents in `dag`) is signed by
 * a key at its own level that has already handed over, or that is contested.
 */
export function revokedAuthor(state, block, dag) {
  const sc = state && state.succession;
  if (!sc || state.ownerless || sc.keys.length === 0) return false;
  const e = block.e;
  for (const p of e.prev) if (!dag || !(dag.has(p) || (typeof dag.isCovered === 'function' && dag.isCovered(p)))) return false;
  const last = sc.keys.length - 1;
  const lv = sc.levelAfterPrev(e.prev, dag);
  if (e.author !== sc.keys[lv]) return false;
  return lv < last || sc.frozen;
}

/**
 * controlFor(dag, h, controlBlocks, ancestorSets, { genesisOwner }) -> ControlState
 * The permission state that governs block h: the fold, in the given (total) order, of the valid
 * policy and allow blocks C with h not in ancestors(C), plus every valid ban (bans are global).
 * -> { writers, bits, maxValueBytes, maxChainBytes, moderators: Set, allow: Set, banned: Set,
 *      modAllowPerDay, modActionsPerHour, reservedPool, voided }
 */
export function controlFor(dag, h, controlBlocks, ancestorSets, options) {
  const owned = !options || options.genesisOwner === undefined || typeof options.genesisOwner === 'string';
  const cs = basePolicy(owned);
  const banned = new Set();
  for (const c of controlBlocks || []) {
    const op = c.e.op;
    if (op.t === 'ban') {
      banned.add(op.author);
      continue;
    }
    if (op.t !== 'policy' && op.t !== 'allow') continue;
    let anc = ancestorSets ? ancestorSets.get(c.h) : undefined;
    if (!anc) {
      anc = dag.ancestors(c.h);
      if (ancestorSets) ancestorSets.set(c.h, anc);
    }
    if (anc.has(h)) continue;
    applyPermission(cs, op);
  }
  cs.banned = banned;
  return cs;
}

function refuse(code, reason) {
  return { ok: false, code, reason };
}

function bannedNow(p, author, ts) {
  if (p.banUntil instanceof Map) {
    const until = p.banUntil.get(author);
    return until !== undefined && ts < until;
  }
  return p.banned.has(author);
}

/**
 * admit(state, block, { dag, genesisOwner = null, expectedOwner = null, minBits = 0 })
 *   -> { ok: true, dropValue: boolean } | { ok: false, code, reason }
 *
 * The ingest control-state check of ARCHITECTURE 6.3: would `block`, arriving now with all of its
 * parents in `dag` (and no descendants), take effect under the control state at the local heads,
 * `state = reduce(dag, ...)`? Run it after validateBlock; skip it for blocks WANTed as parents.
 * codes (SDK, ARCHITECTURE 9): E_NOT_OWNER (owner-only op, a moderator allow that removes, or a
 * root by anyone but the genesis owner), E_NOT_MODERATOR (ban, unban, foreign or bulk tombstone,
 * '_' key), E_BANNED, E_POLICY (writers, allow set, governing bits, tombstone of a control block
 * or of owner-protected payload, '@' key of another author, keyinfo already set ('keyinfo-set') or
 * late because the key has already written here ('keyinfo-late'), recover proof, and 'rotated': a
 * key that rotated away writes nothing more but its keyinfo and rotations, MF-20),
 * E_LIMIT (value over maxValueBytes), E_CAP (DAG at maxChainBytes: only the owner, moderators and
 * allow-listed authors are ingested). Moderator day and hour caps are state rules (not refused).
 * dropValue: the block may be stored only without its value (its tombstone arrived first).
 */
export function admit(state, block, options) {
  const opts = options || {};
  const dag = opts.dag || null;
  const genesisOwner = typeof opts.genesisOwner === 'string' ? opts.genesisOwner : null;
  const owned = genesisOwner !== null;
  const minBits = Number.isInteger(opts.minBits) && opts.minBits > 0 ? opts.minBits : 0;
  const e = block.e;
  const op = e.op;
  const author = e.author;
  const p = state.policy;
  if (owned && e.prev.length === 0 && author !== genesisOwner) return refuse('E_NOT_OWNER', 'root');
  let isOwner = false;
  if (owned) {
    if (state.succession) isOwner = ownerStanding(state, block, { dag, expectedOwner: opts.expectedOwner });
    else isOwner = author === (dag ? ownerAfter(dag, e.prev, genesisOwner) : state.owner);
  }
  const privileged = isOwner || p.moderators.has(author);
  // MF-20: a rotation revokes the old key (state rule: what it signs outside the rotation's causal
  // past has no effect, and a block arriving now is outside it).
  if (!isOwner && op.t !== 'keyinfo' && op.t !== 'rotate' && state.rotations instanceof Map && state.rotations.has(author)) {
    return refuse('E_POLICY', 'rotated');
  }
  const floor = Math.max(minBits, p.bits);
  const atCap = dag !== null && typeof dag.bytes === 'number' && dag.bytes >= p.maxChainBytes;
  const allowHas = (k) => allowListed(k, state);
  const writeProblem = () => {
    if (privileged) return null;
    if (p.writers === 'owner') return refuse('E_POLICY', 'writers');
    if (p.writers === 'allow' && !allowHas(author)) return refuse('E_POLICY', 'allow');
    if (e.bits < floor) return refuse('E_POLICY', 'bits');
    return null;
  };
  if (PAYLOAD.has(op.t)) {
    if (!isOwner && bannedNow(p, author, e.ts)) return refuse('E_BANNED', 'banned');
    const w = writeProblem();
    if (w) return w;
    const name = op.t === 'put' ? op.k : op.t === 'append' ? op.l : '';
    if (name.charCodeAt(0) === UNDERSCORE && !privileged) return refuse('E_NOT_MODERATOR', 'underscore');
    if (op.t === 'put' && isScopedKey(op.k) && !op.k.startsWith(authorScope(author))) return refuse('E_POLICY', 'scope');
    // HUB-6: a reserved entry written with owner standing changes only with owner standing; a _deny/ entry only
    // by the owner or its own author.
    if (op.t === 'put' && !isOwner && name.charCodeAt(0) === UNDERSCORE && state.kv instanceof Map) {
      const cur = state.kv.get(op.k);
      if (cur && ((state.ownerWritten instanceof Set && state.ownerWritten.has(cur.h)) ||
        (op.k.startsWith(DENY_KEY_PREFIX) && cur.author !== author))) return refuse('E_POLICY', 'owner-protected');
    }
    if (block.v !== undefined && byteLength(canonicalize(block.v)) > p.maxValueBytes) return refuse('E_LIMIT', 'value-size');
    if (atCap && !privileged && !allowHas(author)) return refuse('E_CAP', 'cap');
    const mod = state.modTombstoned instanceof Set && state.modTombstoned.has(block.h);
    const strongT = state.tombstoned.has(block.h) && !mod;
    return { ok: true, dropValue: strongT || (mod && !isOwner) };
  }
  if (op.t === 'policy' || op.t === 'owner' || op.t === 'checkpoint') {
    if (!isOwner) return refuse('E_NOT_OWNER', 'owner-only');
    if (op.t === 'owner' && op.next === author) return refuse('E_POLICY', 'self-succession');
    return { ok: true, dropValue: false };
  }
  // HUB-4: a moderator acts only with the policy that appointed it in the block's causal past (the reducer's rule).
  let granted = null;
  const modActs = () => {
    if (granted === null) granted = p.moderators.has(author) && moderatorInPast(state, dag, e.prev, author);
    return granted;
  };
  if (op.t === 'allow') {
    if (isOwner) return { ok: true, dropValue: false };
    if (modActs() && !(Array.isArray(op.remove) && op.remove.length > 0)) return { ok: true, dropValue: false };
    return refuse('E_NOT_OWNER', 'owner-only');
  }
  if (op.t === 'ban' || op.t === 'unban') return isOwner || modActs() ? { ok: true, dropValue: false } : refuse('E_NOT_MODERATOR', 'moderator-only');
  if (op.t === 'tombstone') {
    if (op.h === undefined) return isOwner || modActs() ? { ok: true, dropValue: false } : refuse('E_NOT_MODERATOR', 'moderator-only');
    const target = dag ? dag.get(op.h) : undefined;
    if (target && !PAYLOAD.has(target.e.op.t)) return refuse('E_POLICY', 'target');
    if (target && target.e.author === author && (isOwner || e.bits >= floor || modActs())) {
      if (!privileged && atCap && !allowHas(author)) return refuse('E_CAP', 'cap');
      return { ok: true, dropValue: false };
    }
    if (isOwner) return { ok: true, dropValue: false };
    if (modActs()) {
      if (target && ownerPayload(state, target)) return refuse('E_POLICY', 'owner-protected');
      return { ok: true, dropValue: false };
    }
    if (!target || target.e.author !== author) return refuse('E_NOT_MODERATOR', 'not-author');
    if (e.bits < floor) return refuse('E_POLICY', 'bits');
    return { ok: true, dropValue: false };
  }
  if (op.t === 'keyinfo') {
    if (state.keyinfo instanceof Map && state.keyinfo.has(author)) return refuse('E_POLICY', 'keyinfo-set');
    if (state.wrote instanceof Set && state.wrote.has(author)) return refuse('E_POLICY', 'keyinfo-late');
    const w = writeProblem();
    return w || { ok: true, dropValue: false };
  }
  if (op.t === 'rotate') {
    if (op.by === 'self') {
      // HUB-7, SYB-4: a self rotation is a write by from: the writers/allow rule, the governing bits and bans.
      if (!isOwner && bannedNow(p, author, e.ts)) return refuse('E_BANNED', 'banned');
      const w = writeProblem();
      if (w) return w;
    } else if (!privileged && e.bits < floor) return refuse('E_POLICY', 'bits');
    if (op.by === 'recover') {
      const ki = state.keyinfo instanceof Map ? state.keyinfo.get(op.from) : undefined;
      if (!ki || ki.rc !== b64url.encode(sha256Sync(utf8.encode(op.rp)))) return refuse('E_POLICY', 'recover');
    }
    return { ok: true, dropValue: false };
  }
  return refuse('E_POLICY', 'op');
}

// moderatorInPast(state, dag, prev, author): is `author` a moderator under the newest (total order: depth, then h)
// effective owner policy block with a moderators field in the causal past of `prev`? Covered or missing history
// leaves it to the reducer (true when no such policy is found below it). Review round, HUB-4.
function moderatorInPast(state, dag, prev, author) {
  if (!dag || typeof dag.get !== 'function' || !(state.effective instanceof Set)) return true;
  const seen = new Set();
  const stack = prev.slice();
  let best = null;
  let gap = false;
  while (stack.length > 0) {
    const h = stack.pop();
    if (seen.has(h)) continue;
    seen.add(h);
    const b = dag.get(h);
    if (!b) {
      gap = true;
      continue;
    }
    const op = b.e.op;
    if (op && op.t === 'policy' && Array.isArray(op.moderators) && state.effective.has(h)) {
      const d = typeof dag.depth === 'function' ? dag.depth(h) : 0;
      if (best === null || d > best.d || (d === best.d && h > best.h)) best = { d, h, mods: op.moderators };
    }
    for (const p of b.e.prev) if (!seen.has(p)) stack.push(p);
  }
  if (best !== null) return best.mods.slice(0, LIMITS.maxModerators).includes(author);
  return gap;
}

// true when payload block `target` (in the DAG) was written with owner standing: exact for
// payload in effect (state.ownerWritten); otherwise whether its author is the owner now.
function ownerPayload(state, target) {
  if (state.ownerWritten instanceof Set && state.ownerWritten.has(target.h)) return true;
  if (state.effective instanceof Set && state.effective.has(target.h)) return false;
  return target.e.author === state.owner;
}

/**
 * shouldDropValue(state, block, dag?) -> boolean: the block is a payload block whose value must
 * not be kept or relayed (tombstoned, or by a banned author).
 */
export function shouldDropValue(state, block, dag) {
  if (!block || !block.e || !block.e.op || !PAYLOAD.has(block.e.op.t)) return false;
  if (state.redacted.has(block.h)) return true;
  const held = dag && typeof dag.has === 'function' && dag.has(block.h);
  const isOwnerNow = block.e.author === state.owner;
  if (state.tombstoned.has(block.h)) {
    const mod = state.modTombstoned instanceof Set && state.modTombstoned.has(block.h);
    if (!mod || !isOwnerNow) return true;
  }
  if (held) return false;
  return !isOwnerNow && bannedNow(state.policy, block.e.author, block.e.ts);
}

// Own data properties only, so keys such as "__proto__" stay ordinary keys.
function plainObject(entries) {
  const out = {};
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * allowListed(pub, state) -> true when `pub`, or a key it rotated from (transitively), is on the allow
 * list at the heads: next inherits from's allow membership (the reducer's chainOf).
 */
export function allowListed(pub, state) {
  const p = state.policy;
  if (p.allow.has(pub)) return true;
  const rot = state.rotations;
  if (!(rot instanceof Map) || rot.size === 0) return false;
  const seen = new Set([pub]);
  const todo = [pub];
  while (todo.length > 0) {
    const k = todo.pop();
    for (const [from, r] of rot) {
      if (r.next !== k || seen.has(from) || !rotationLinks(r)) continue;
      if (p.allow.has(from)) return true;
      seen.add(from);
      todo.push(from);
    }
  }
  return false;
}

/**
 * isBanned(pub, state, now?) -> true when a ban at the heads governs `pub` now: a permanent ban, or,
 * given `now` (unix ms), a temporary one with now < until. Without `now` only permanent bans count
 * (state.js has no clock; ChainNode passes its own).
 */
export function isBanned(pub, state, now) {
  if (typeof pub !== 'string' || !state || !state.policy) return false;
  const p = state.policy;
  if (p.banned instanceof Set && p.banned.has(pub)) return true;
  if (typeof now !== 'number' || !(p.banUntil instanceof Map)) return false;
  const until = p.banUntil.get(pub);
  return until !== undefined && now < until;
}

/**
 * snapshot(state, { now } = {}) -> plain JSON for the SDK and UI:
 * { height, depth, bytes, capReached, kv: { k: v }, lists: { name: [{ h, author, ts, v }] oldest
 *   first }, profiles: { pub: name }, policy: { writers, bits, maxValueBytes, maxChainBytes,
 *   moderators: [], banned: [], banUntil: { pub: until }, allowCount, modAllowPerDay,
 *   modActionsPerHour, reservedPool, voided: [] }, owner, authors: n, unmoderated, keychange:
 *   { pub: { from, next, by, ts } }, checkpoint: { h, n } | null }
 * banned lists the keys under a ban in force: the permanent bans, and with `now` (unix ms) the
 * temporary bans with now < until; banUntil gives the temporary bans with their until (with `now`,
 * only those still in force).
 * Values are shared with the state, not copied: treat them as read-only.
 */
export function snapshot(state, options) {
  const now = options && typeof options.now === 'number' ? options.now : null;
  const kvEntries = [];
  for (const [k, entry] of state.kv) kvEntries.push([k, entry.v]);
  const listEntries = [];
  for (const [name, items] of state.lists) {
    listEntries.push([name, items.map((it) => ({ h: it.h, author: it.author, ts: it.ts, v: it.v }))]);
  }
  const p = state.policy;
  const banned = new Set(p.banned);
  const banUntil = [];
  if (p.banUntil instanceof Map) {
    for (const [pub, until] of p.banUntil) {
      if (until === Infinity || (now !== null && !(now < until))) continue;
      if (now !== null) banned.add(pub);
      banUntil.push([pub, until]);
    }
  }
  banUntil.sort((a, b) => cmpStr(a[0], b[0]));
  const keychange = [];
  if (state.keychange instanceof Map) {
    for (const k of Array.from(state.keychange.keys()).sort(cmpStr)) {
      const r = state.keychange.get(k);
      keychange.push([k, { from: r.from, next: r.next, by: r.by, ts: r.ts }]);
    }
  }
  return {
    height: state.height,
    depth: state.depth,
    bytes: state.bytes,
    capReached: state.capReached,
    kv: plainObject(kvEntries),
    lists: plainObject(listEntries),
    profiles: plainObject(state.profiles),
    policy: {
      writers: p.writers,
      bits: p.bits,
      maxValueBytes: p.maxValueBytes,
      maxChainBytes: p.maxChainBytes,
      moderators: Array.from(p.moderators).sort(),
      banned: Array.from(banned).sort(),
      banUntil: plainObject(banUntil),
      allowCount: p.allow.size,
      modAllowPerDay: p.modAllowPerDay,
      modActionsPerHour: p.modActionsPerHour,
      reservedPool: p.reservedPool,
      voided: (p.voided || []).map((x) => ({ author: x.author, after: x.after })),
    },
    owner: state.owner,
    authors: state.authors.size,
    unmoderated: state.owner === null,
    keychange: plainObject(keychange),
    checkpoint: state.checkpoint ? { h: state.checkpoint.h, n: state.checkpoint.n } : null,
  };
}

/**
 * roleOf(pub, state, now?) -> 'owner' | 'moderator' | 'writer' | 'reader' under the current control
 * state. A key under a ban in force (isBanned: permanent, or temporary with now < until when `now` is
 * given) and a key that rotated away (MF-20) are readers.
 */
export function roleOf(pub, state, now) {
  if (typeof pub !== 'string' || !state) return 'reader';
  if (state.owner && pub === state.owner && !state.ownerConflict) return 'owner';
  const p = state.policy;
  if (state.rotations instanceof Map && state.rotations.has(pub)) return 'reader';
  if (p.moderators.has(pub)) return 'moderator';
  if (isBanned(pub, state, now)) return 'reader';
  if (p.writers === 'open') return 'writer';
  if (p.writers === 'allow' && allowListed(pub, state)) return 'writer';
  return 'reader';
}
