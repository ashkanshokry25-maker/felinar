// Chat-key records (R 2.7.2, N-5): CK = { v: 2, ledger, signer, ek, epoch, exp, sig } with
//   sig = ECDSA P-256 by signKey over utf8("mw-chat-key-v2\n" + JCS(CK without sig))   (raw r||s, b64url)
// A CK ties a chat key (ek, ECDH) to a site key (signer) on one ledger. CKs travel off-ledger in CK
// frames, are cached by every chat peer until exp (90 days, chosen), and are re-sent on request. A copy
// in the site ledger, append('mw.ck', CK), is opt-in only: the caller must pass the person's answer to the
// card "Your chat key will be public and permanent in this site's ledger ...". On rotation the newest
// epoch per signer supersedes the older ones for new messages.
//
// Shared code: WebCrypto through src/chain/crypto.js, RFC 8785 through src/chain/canonical.js.

import { canonicalize, utf8, b64url, byteLength } from '../chain/canonical.js';
import { verify, isPublicKeyString } from '../chain/crypto.js';
import { CK_PREFIX, CK_TTL_MS, CK_SKEW_MS, CK_MAX, CK_CACHE_MAX, CK_EPOCH_STEP, CK_EPOCH_MAX, CK_UNKNOWN_MAX } from './limits.js';

const FIELDS = ['v', 'ledger', 'signer', 'ek', 'epoch', 'exp', 'sig'];

function unsigned(ck) {
  return { v: ck.v, ledger: ck.ledger, signer: ck.signer, ek: ck.ek, epoch: ck.epoch, exp: ck.exp };
}

/** The bytes a CK signature covers. */
export function ckSigningBytes(ck) {
  return utf8.encode(CK_PREFIX + canonicalize(unsigned(ck)));
}

/** Size of a CK on the wire (JSON as sent in a CK frame). */
export function ckSize(ck) {
  return byteLength(JSON.stringify(ck));
}

/**
 * makeCk({ signer: { pub, sign(bytes) -> Uint8Array(64) }, ledger, ek, epoch = 1, exp, now }) -> CK.
 * exp defaults to now + 90 days.
 */
export async function makeCk({ signer, ledger, ek, epoch = 1, exp, now = Date.now() }) {
  if (!signer || typeof signer.sign !== 'function' || !isPublicKeyString(signer.pub)) {
    throw new TypeError('makeCk: signer needs { pub, sign }');
  }
  if (typeof ledger !== 'string' || ledger.length === 0 || ledger.length > 128) throw new TypeError('makeCk: ledger id');
  if (!isPublicKeyString(ek)) throw new TypeError('makeCk: ek must be a p256: chat key');
  const e = exp === undefined ? now + CK_TTL_MS : exp;
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > CK_EPOCH_MAX) throw new TypeError('makeCk: epoch is an integer from 1 to ' + CK_EPOCH_MAX);
  if (!Number.isSafeInteger(e) || e < 0) throw new TypeError('makeCk: exp is a time in ms');
  const ck = { v: 2, ledger, signer: signer.pub, ek, epoch, exp: e };
  const sig = await signer.sign(ckSigningBytes(ck));
  const out = Object.assign({}, ck, { sig: b64url.encode(sig) });
  if (ckSize(out) > CK_MAX) throw new TypeError('makeCk: record over ' + CK_MAX + ' bytes');
  return out;
}

/** Shape check without the signature; { ok } or { ok: false, reason }. */
export function checkCkShape(ck) {
  if (!ck || typeof ck !== 'object' || Array.isArray(ck)) return { ok: false, reason: 'ck-shape' };
  for (const k of Object.keys(ck)) if (FIELDS.indexOf(k) < 0) return { ok: false, reason: 'ck-field' };
  if (ck.v !== 2) return { ok: false, reason: 'ck-version' };
  if (typeof ck.ledger !== 'string' || ck.ledger.length === 0 || ck.ledger.length > 128) return { ok: false, reason: 'ck-ledger' };
  if (!isPublicKeyString(ck.signer)) return { ok: false, reason: 'ck-signer' };
  if (!isPublicKeyString(ck.ek)) return { ok: false, reason: 'ck-ek' };
  if (!Number.isSafeInteger(ck.epoch) || ck.epoch < 1 || ck.epoch > CK_EPOCH_MAX) return { ok: false, reason: 'ck-epoch' };
  if (!Number.isSafeInteger(ck.exp) || ck.exp < 0) return { ok: false, reason: 'ck-exp' };
  if (typeof ck.sig !== 'string') return { ok: false, reason: 'ck-sig' };
  let sig;
  try {
    sig = b64url.decode(ck.sig);
  } catch (_) {
    return { ok: false, reason: 'ck-sig' };
  }
  if (sig.length !== 64) return { ok: false, reason: 'ck-sig' };
  if (ckSize(ck) > CK_MAX) return { ok: false, reason: 'ck-size' };
  return { ok: true };
}

/**
 * verifyCk(ck, { ledgerId, now }) -> { ok: true } | { ok: false, reason }. Checks the shape, the
 * ledger, the lifetime (not expired; exp at most 90 days and 5 minutes ahead) and the signature.
 */
export async function verifyCk(ck, { ledgerId, now = Date.now() } = {}) {
  const shape = checkCkShape(ck);
  if (!shape.ok) return shape;
  if (ledgerId !== undefined && ck.ledger !== ledgerId) return { ok: false, reason: 'ck-other-ledger' };
  if (ck.exp <= now) return { ok: false, reason: 'ck-expired' };
  if (ck.exp > now + CK_TTL_MS + CK_SKEW_MS) return { ok: false, reason: 'ck-lifetime' };
  const ok = await verify(ck.signer, ckSigningBytes(ck), ck.sig);
  return ok ? { ok: true } : { ok: false, reason: 'ck-bad-signature' };
}

/**
 * CkCache: verified CKs by signer and by chat key, kept until exp; the highest epoch per signer is
 * current. put() verifies; get*(now) drop expired records.
 *
 * Code review v0.3 (round 2; MF-20): rotated(signer) -> true when the site ledger shows that key as rotated away (the chat
 * service passes node.state.rotations); a rotated-away key's CKs are refused ('ck-rotated') and the ones cached before the
 * rotation arrived are dropped on lookup, so a thief holding the old key cannot keep receiving the person's messages after a
 * recovery. An epoch jump above CK_EPOCH_STEP plus one per CK lifetime since the cached CK was taken is not taken
 * ('ck-epoch-jump').
 *
 * Review round (MP-5, SYB-5): known(signer) -> true for keys this tab has a reason to keep (contacts, group members, call
 * rosters; the chat service passes it). CKs of other signers are kept apart, at most `unknownMax` (256) of them, oldest out
 * first, and a stranger's CK never evicts a known one; when the cache is over `max` the oldest unknown signer goes first. A CK
 * identical to the cached one is answered without a second signature check ({ ok, same: true }).
 */
export class CkCache {
  constructor({ ledgerId, now = () => Date.now(), max = CK_CACHE_MAX, rotated = null, known = null, unknownMax = CK_UNKNOWN_MAX } = {}) {
    this.ledgerId = ledgerId;
    this.now = now;
    this.max = max;
    this.unknownMax = unknownMax;
    this.rotated = typeof rotated === 'function' ? rotated : () => false;
    this.known = typeof known === 'function' ? known : () => false;
    this.bySigner = new Map(); // signer -> CK (current epoch)
    this.byEk = new Map(); // ek -> CK
    this.takenAt = new Map(); // signer -> when its current CK was taken
    this.unknown = new Map(); // signer -> true, in the order their CKs were taken (signers that were not known then)
  }

  _isKnown(signer) {
    try {
      return Boolean(this.known(signer));
    } catch (_) {
      return false;
    }
  }

  _drop(signer) {
    this.bySigner.delete(signer);
    this.takenAt.delete(signer);
    this.unknown.delete(signer);
    for (const [ek, c] of Array.from(this.byEk)) if (c.signer === signer) this.byEk.delete(ek);
  }

  _evict() {
    while (this.unknown.size > this.unknownMax) {
      const s = this.unknown.keys().next().value;
      this.unknown.delete(s);
      if (!this._isKnown(s)) this._drop(s);
    }
    while (this.bySigner.size > this.max) {
      let victim = null;
      for (const s of this.bySigner.keys()) {
        if (!this._isKnown(s)) {
          victim = s;
          break;
        }
      }
      this._drop(victim === null ? this.bySigner.keys().next().value : victim);
    }
    while (this.byEk.size > this.max * 2) {
      let victim = null;
      for (const [ek, c] of this.byEk) {
        if (!this._isKnown(c.signer)) {
          victim = ek;
          break;
        }
      }
      this.byEk.delete(victim === null ? this.byEk.keys().next().value : victim);
    }
  }

  _same(ck) {
    const c = ck && typeof ck.ek === 'string' ? this.byEk.get(ck.ek) : null;
    if (!c || c.exp <= this.now() || this._rotatedAway(c.signer)) return false;
    return c.sig === ck.sig && c.signer === ck.signer && c.ledger === ck.ledger && c.epoch === ck.epoch && c.exp === ck.exp && c.v === ck.v &&
      Object.keys(ck).length === Object.keys(c).length;
  }

  _rotatedAway(signer) {
    try {
      return Boolean(this.rotated(signer));
    } catch (_) {
      return false;
    }
  }

  /** Verifies and stores; { ok, superseded?, changed, fresh, same? } or { ok: false, reason }. */
  async put(ck) {
    if (this._same(ck)) {
      const cur = this.bySigner.get(ck.signer);
      return cur && cur.epoch > ck.epoch ? { ok: true, superseded: true, changed: false, fresh: false, same: true } : { ok: true, changed: false, fresh: false, same: true };
    }
    const v = await verifyCk(ck, { ledgerId: this.ledgerId, now: this.now() });
    if (!v.ok) return v;
    if (this._rotatedAway(ck.signer)) return { ok: false, reason: 'ck-rotated' };
    const prev = this.forSigner(ck.signer);
    if (prev && prev.epoch > ck.epoch) {
      this.byEk.set(ck.ek, ck); // older epochs still open old envelopes
      this._evict();
      return { ok: true, superseded: true, changed: false, fresh: false };
    }
    if (prev && ck.epoch > prev.epoch) {
      const since = Math.max(0, this.now() - (this.takenAt.get(ck.signer) || this.now()));
      if (ck.epoch - prev.epoch > CK_EPOCH_STEP + Math.floor(since / CK_TTL_MS)) return { ok: false, reason: 'ck-epoch-jump' };
    }
    this.bySigner.set(ck.signer, ck);
    this.byEk.set(ck.ek, ck);
    if (!prev || prev.epoch !== ck.epoch || !this.takenAt.has(ck.signer)) this.takenAt.set(ck.signer, this.now());
    this.unknown.delete(ck.signer);
    if (!this._isKnown(ck.signer)) this.unknown.set(ck.signer, true);
    this._evict();
    return { ok: true, changed: !!prev && prev.ek !== ck.ek, fresh: !prev || prev.ek !== ck.ek || prev.epoch !== ck.epoch };
  }

  _fresh(ck, map, key) {
    if (!ck) return null;
    if (ck.exp <= this.now() || this._rotatedAway(ck.signer)) {
      map.delete(key);
      if (map === this.bySigner) {
        this.takenAt.delete(key);
        this.unknown.delete(key);
      }
      return null;
    }
    return ck;
  }

  /** The current CK of a site key, or null. */
  forSigner(signer) {
    return this._fresh(this.bySigner.get(signer), this.bySigner, signer);
  }

  /** The CK that carries a chat key, or null. */
  forEk(ek) {
    return this._fresh(this.byEk.get(ek), this.byEk, ek);
  }

  size() {
    return this.bySigner.size;
  }
}

/**
 * ledgerCopy(node, ck, { consented }) -> append result. Opt-in only (R 2.7.2): throws unless the
 * caller passes consented: true (the person accepted the card). Never used for conversation.
 */
export async function ledgerCopy(node, ck, { consented = false } = {}) {
  if (consented !== true) {
    throw Object.assign(new Error('a ledger copy of the chat key needs the person\'s consent'), { code: 'E_POLICY' });
  }
  const shape = checkCkShape(ck);
  if (!shape.ok) throw new TypeError('ledgerCopy: ' + shape.reason);
  if (!node || typeof node.append !== 'function') throw new TypeError('ledgerCopy: node.append is required');
  return node.append('mw.ck', ck);
}
