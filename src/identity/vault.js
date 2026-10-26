// The identity vault and the backup file (R 2.2.2, 2.2.6; MF-18, MF-19). Lives at the identity
// origin only. Pure: Node >= 22 and browsers.
//
// Vault (plaintext JSON):
//   { v: 2, labels: { <label>: { i, chat: [{ e, jwk, exp }], rec: [{ r, key }], own, local,
//     contacts: [], links: [{ origin, t }], sites: [{ origin, t }] } }, legacy: [{ ledger, pub, jwk, t }] }
// Every key in it is random (chat epoch key pairs, record keys K_rec[r], K_own, K_local), never
// derived from the root, so a phrase-only restore recovers the public identities and nothing of
// the vault. The vault is encrypted with a random 32-byte K_vault:
//   vault blob = { v: 2, kind: 'vault', id?, iv, ct }, AES-256-GCM, AAD "mw-vault-v2\n" + JCS(header)
// K_vault is wrapped by the PRF key and by the backup-file key (wrap.js), never by a key derived
// from the phrase alone.
//
// Backup file "mw-identity-v3" (made only at the identity origin; label it "Do not email"):
//   { type: 'mw-identity', v: 3, kdf, params, salt, iv, ct }
//   kdf 'argon2id' (params { m, t, p }) or 'pbkdf2-sha256' (params { iter })
//   ct = AES-256-GCM(passphraseKey, AAD "mw-identity-v3\n" + JCS({ type, v, kdf, params, salt }),
//        JSON { rootStar, kVault, vault })
// The 0.2.1 export (src/loader/app.js exportIdentityText: { type: 'mw-identity', v: 1, ledger,
// pub, kdf: 'PBKDF2-SHA256', iter, salt, iv, ct }) is read by parseLegacyExport for migration.
//
// Several copies of one vault exist at once: the identity origin's own, and the escrow copy each
// site keeps from its last sign-in (R 2.2.5). Code review v0.3 (security 1, correctness 3): copies
// are merged, never adopted whole, so a label created after an older copy was made keeps its random
// keys. The plaintext therefore also carries
//   ver        a counter raised on every save and every merge (the identity origin saves inside a
//              Web Lock and builds on the newest stored copy, src/idp/idp.js)
//   gone       { tag: t }: retired keys (shred, me.erase), tag = keyTag(key text); a merge never
//              brings a retired key back
//   unlinked   { origin: t }: "Stop using the same identity here"; a link made before t is dropped
//   floors     { ledgerId: seq }: the highest pointer seq the identity origin accepted for the ledger
//              label (MF-30), so the rollback floor travels with escrow copies and backup files
// and per label: meCut { origin: t } (a private record erased at t: older fields never return),
// owns (t: the label made or owns a page, "Replace my keys" keeps its key) and archived (keys of
// another copy that collided with one here, kept so no key is lost; never handed to a site).

import { scalar, scalarToJwk, publicKeyOf, normalizeOrigin } from './derive.js';
import { passphraseKey, PBKDF2_ITERATIONS } from './wrap.js';
import { ARGON2ID_DEFAULTS } from './argon2.js';
import { BIP39_ENGLISH, wordIndex } from './bip39-english.js';
import { MAX_DATA_BYTES, MAX_ITEMS_PER_AUTHOR } from './sealed.js';
import { b64url, utf8, canonicalize } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';

export const VAULT_PREFIX = 'mw-vault-v2';
export const BACKUP_PREFIX = 'mw-identity-v3';
/** Chat epoch lifetime (R 2.2.2: rotation every 90 days, chosen). */
export const CHAT_EPOCH_MS = 90 * 24 * 3600 * 1000;
/** Strength floor for a person-chosen backup passphrase, in estimated bits (stated in the card). */
export const PASSPHRASE_FLOOR_BITS = 60;
export const PASSPHRASE_MIN_LENGTH = 12;
/** A private record held for one origin: one index item plus 31 data items of 1,013 bytes (R 2.6.2). */
export const RECORD_MAX_BYTES = (MAX_ITEMS_PER_AUTHOR - 1) * MAX_DATA_BYTES;
/** The whole vault's plaintext stays under this, so its escrow copy fits every request (client.js). */
export const VAULT_MAX_BYTES = 200000;
/** The smallest padded escrow copy (review round SEC-1 / STALK-1): every vault up to about 20 sites has this one length. */
export const VAULT_PAD_MIN = 16384;

/**
 * padBucket(n) -> the padded plaintext length of an escrow copy: VAULT_PAD_MIN, then the next power of two, so a site's
 * copy shows at most the order of magnitude of the vault (262,144 for the VAULT_MAX_BYTES cap; its base64url text, 349,548
 * characters, stays under the 350,000 that acceptEscrow takes). A vault already over that is not padded.
 */
export function padBucket(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('padBucket: a length');
  if (n <= VAULT_PAD_MIN) return VAULT_PAD_MIN;
  let size = VAULT_PAD_MIN;
  while (size < n) size *= 2;
  return size > 262144 ? n : size;
}
const MAX_GONE = 4096;
const MAX_ARCHIVED = 16;
const MAX_CONTACTS = 1000;
const LABEL_RE = /^[olh]\|./;

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const vaultError = (code, message) => Object.assign(new Error(message), { code });

async function aes(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function newChatKey(e, now) {
  const d = scalar(rand(48));
  return { e, jwk: scalarToJwk(d), exp: now + CHAT_EPOCH_MS };
}

function emptyLabel(now) {
  return {
    i: 1, chat: [newChatKey(1, now)], rec: [{ r: 1, key: b64url.encode(rand(32)) }],
    own: b64url.encode(rand(32)), local: b64url.encode(rand(32)), contacts: [], links: [], sites: [],
  };
}

function checkLabelName(label) {
  if (typeof label !== 'string' || !LABEL_RE.test(label) || label.length > 300) throw new TypeError('bad label');
}

/** keyTag(text) -> 22 base64url characters naming a retired key (the key itself is never kept). */
export function keyTag(text) {
  return b64url.encode(sha256Sync(utf8.encode('mw-vault-gone-v1\n' + String(text)))).slice(0, 22);
}

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const isTime = (x) => Number.isSafeInteger(x) && x >= 0;

/** recordSize(record) -> UTF-8 bytes of its JSON (the R 2.6.2 cap counts these). */
export function recordSize(record) {
  try {
    return utf8.encode(JSON.stringify(record)).length;
  } catch (_) {
    return Infinity;
  }
}

/** cutRecord(record, cut) -> the record without the fields written at or before cut (an erase at cut). */
function cutRecord(r, cut) {
  if (!isObj(r) || !isObj(r.f) || !isTime(r.t)) return null;
  if (!isTime(cut)) return r;
  const ft = isObj(r.ft) ? r.ft : {};
  const out = { f: {}, ft: {}, t: r.t };
  for (const name of new Set(Object.keys(r.f).concat(Object.keys(ft)))) {
    const at = isTime(ft[name]) ? ft[name] : r.t;
    if (at <= cut) continue;
    out.ft[name] = at;
    if (Object.prototype.hasOwnProperty.call(r.f, name)) out.f[name] = r.f[name];
  }
  return out;
}

/** mergeRecordCopies(...records) -> { f, ft, t }: per field, the newest write wins (as client.js mergeRecords). */
export function mergeRecordCopies(...records) {
  const out = { f: {}, ft: {}, t: 0 };
  for (const r of records) {
    if (!isObj(r) || !isObj(r.f) || !isTime(r.t)) continue;
    const ft = isObj(r.ft) ? r.ft : {};
    for (const name of new Set(Object.keys(r.f).concat(Object.keys(ft)))) {
      const at = isTime(ft[name]) ? ft[name] : r.t;
      if (out.ft[name] !== undefined && out.ft[name] >= at) continue;
      out.ft[name] = at;
      if (Object.prototype.hasOwnProperty.call(r.f, name)) out.f[name] = r.f[name];
      else delete out.f[name];
    }
    if (r.t > out.t) out.t = r.t;
  }
  return out;
}

/** normalizeEntry(entry) -> a label entry with every list present (copies written by older builds lack some). */
function normalizeEntry(e) {
  if (!isObj(e)) return null;
  const out = Object.assign({}, e);
  out.i = Number.isSafeInteger(e.i) && e.i >= 1 ? e.i : 1;
  for (const k of ['chat', 'rec', 'contacts', 'links', 'sites']) out[k] = Array.isArray(e[k]) ? e[k].filter(Boolean) : [];
  out.chat = out.chat.filter((c) => Number.isSafeInteger(c.e) && c.jwk && typeof c.jwk.d === 'string');
  out.rec = out.rec.filter((r) => Number.isSafeInteger(r.r) && typeof r.key === 'string');
  out.links = out.links.filter((l) => typeof l.origin === 'string' && isTime(l.t));
  out.sites = out.sites.filter((x) => typeof x.origin === 'string');
  out.own = typeof e.own === 'string' ? e.own : null;
  out.local = typeof e.local === 'string' ? e.local : null;
  return out;
}

function purgeGone(entry, gone) {
  entry.chat = entry.chat.filter((c) => !gone[keyTag(c.jwk.d)]);
  entry.rec = entry.rec.filter((r) => !gone[keyTag(r.key)]);
  if (entry.own && gone[keyTag(entry.own)]) entry.own = null;
  if (entry.local && gone[keyTag(entry.local)]) entry.local = null;
}

function archive(entry, kind, value, now) {
  const list = Array.isArray(entry.archived) ? entry.archived : [];
  const text = JSON.stringify(value);
  if (list.some((a) => a.k === kind && JSON.stringify(a.v) === text)) return;
  list.push({ k: kind, v: value, t: now });
  entry.archived = list.slice(-MAX_ARCHIVED);
}

function mergeEntry(mine, theirs, now) {
  if (theirs.i > mine.i) {
    mine.i = theirs.i;
    if (theirs.rotated) mine.rotated = theirs.rotated;
  } else if (theirs.i === mine.i && theirs.rotated && mine.rotated && theirs.rotated.next === mine.rotated.next) {
    const d = new Set((mine.rotated.delivered || []).concat(theirs.rotated.delivered || []));
    mine.rotated.delivered = Array.from(d);
  } else if (theirs.i === mine.i && theirs.rotated && !mine.rotated) {
    mine.rotated = theirs.rotated;
  }
  const byE = new Map(mine.chat.map((c) => [c.e, c]));
  for (const c of theirs.chat) {
    const have = byE.get(c.e);
    if (!have) { mine.chat.push(c); byE.set(c.e, c); } else if (have.jwk.d !== c.jwk.d) archive(mine, 'chat', c, now);
  }
  mine.chat.sort((a, b) => a.e - b.e);
  const byR = new Map(mine.rec.map((r) => [r.r, r]));
  for (const r of theirs.rec) {
    const have = byR.get(r.r);
    if (!have) { mine.rec.push(r); byR.set(r.r, r); } else if (have.key !== r.key) archive(mine, 'rec', r, now);
  }
  mine.rec.sort((a, b) => a.r - b.r);
  for (const k of ['own', 'local']) {
    if (!mine[k] && theirs[k]) mine[k] = theirs[k];
    else if (theirs[k] && theirs[k] !== mine[k]) archive(mine, k, theirs[k], now);
  }
  const contacts = new Map(mine.contacts.map((c) => [JSON.stringify(c), c]));
  for (const c of theirs.contacts) if (!contacts.has(JSON.stringify(c))) contacts.set(JSON.stringify(c), c);
  mine.contacts = Array.from(contacts.values()).slice(0, MAX_CONTACTS);
  const links = new Map(mine.links.map((l) => [l.origin, l]));
  for (const l of theirs.links) if (!links.has(l.origin) || links.get(l.origin).t < l.t) links.set(l.origin, l);
  mine.links = Array.from(links.values());
  const sites = new Map(mine.sites.map((x) => [x.origin, x]));
  for (const x of theirs.sites) if (!sites.has(x.origin) || (isTime(x.t) && x.t < (sites.get(x.origin).t || Infinity))) sites.set(x.origin, x);
  mine.sites = Array.from(sites.values());
  const cuts = Object.assign({}, isObj(mine.meCut) ? mine.meCut : {});
  if (isObj(theirs.meCut)) for (const o of Object.keys(theirs.meCut)) if (!(cuts[o] >= theirs.meCut[o])) cuts[o] = theirs.meCut[o];
  if (Object.keys(cuts).length) mine.meCut = cuts;
  if (isObj(mine.me) || isObj(theirs.me)) {
    const me = Object.assign({}, isObj(mine.me) ? mine.me : {});
    const other = isObj(theirs.me) ? theirs.me : {};
    for (const o of new Set(Object.keys(me).concat(Object.keys(other)))) {
      const merged = mergeRecordCopies(cutRecord(me[o], cuts[o]), cutRecord(other[o], cuts[o]));
      // A merge never makes a record larger than one write may (the cap is the identity origin's, R 2.6.2).
      if (recordSize(merged) <= RECORD_MAX_BYTES) me[o] = merged;
      else if (me[o]) me[o] = cutRecord(me[o], cuts[o]);
    }
    mine.me = me;
  }
  if (!mine.owns && isTime(theirs.owns)) mine.owns = theirs.owns;
  if (Array.isArray(theirs.archived)) for (const a of theirs.archived) if (a && typeof a.k === 'string') archive(mine, a.k, a.v, a.t || now);
}

export class Vault {
  constructor(data) {
    this.data = data || { v: 2, labels: {}, legacy: [] };
  }

  /** Vault.create() -> { vault, kVault }: an empty vault and a fresh random K_vault. */
  static create() {
    return { vault: new Vault(), kVault: rand(32) };
  }

  /** Vault.open(kVault, blob) -> Vault; E_VAULT when the key is wrong or the blob was changed. */
  static async open(kVault, blob) {
    if (!(kVault instanceof Uint8Array) || kVault.length !== 32) throw vaultError('E_VAULT', 'the vault could not be opened');
    if (!blob || blob.v !== 2 || blob.kind !== 'vault' || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') {
      throw vaultError('E_VAULT', 'the vault could not be opened');
    }
    const header = { v: 2, kind: 'vault' };
    if (blob.id !== undefined) header.id = blob.id;
    let data;
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64url.decode(blob.iv), additionalData: utf8.encode(VAULT_PREFIX + '\n' + canonicalize(header)) }, await aes(kVault), b64url.decode(blob.ct));
      data = JSON.parse(utf8.decode(new Uint8Array(pt), { fatal: true }));
    } catch (_) {
      throw vaultError('E_VAULT', 'the vault could not be opened');
    }
    if (!data || data.v !== 2 || typeof data.labels !== 'object' || !Array.isArray(data.legacy)) throw vaultError('E_VAULT', 'the vault could not be opened');
    return new Vault(data);
  }

  /**
   * toBlob(kVault, { id?, pad? }) -> { v: 2, kind: 'vault', id?, iv, ct }. pad: true (the escrow copy a site keeps, review
   * round SEC-1 / STALK-1) fills the JSON with trailing spaces up to padBucket(length), so the length of a site's copy does
   * not count the person's sites; JSON.parse ignores the spaces, so Vault.open reads padded and plain blobs alike.
   */
  async toBlob(kVault, { id, pad = false } = {}) {
    if (!(kVault instanceof Uint8Array) || kVault.length !== 32) throw new TypeError('kVault must be 32 bytes');
    const header = { v: 2, kind: 'vault' };
    if (id !== undefined) header.id = String(id);
    const iv = rand(12);
    let plain = utf8.encode(JSON.stringify(this.data));
    if (pad) {
      const size = padBucket(plain.length);
      const out = new Uint8Array(size).fill(0x20);
      out.set(plain, 0);
      plain = out;
    }
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(VAULT_PREFIX + '\n' + canonicalize(header)) }, await aes(kVault), plain));
    return Object.assign(header, { iv: b64url.encode(iv), ct: b64url.encode(ct) });
  }

  toJSON() {
    return this.data;
  }

  /** version() -> the save counter (0 for a vault written before code review v0.3). */
  version() {
    return Number.isSafeInteger(this.data.ver) ? this.data.ver : 0;
  }

  /** bump() -> the next version: the identity origin calls it once per save. */
  bump() {
    this.data.ver = this.version() + 1;
    return this.data.ver;
  }

  /** size() -> the plaintext length of the vault JSON (VAULT_MAX_BYTES is the cap). */
  size() {
    try {
      return JSON.stringify(this.data).length;
    } catch (_) {
      return Infinity;
    }
  }

  _gone() {
    if (!isObj(this.data.gone)) this.data.gone = {};
    return this.data.gone;
  }

  /** retire(text, now): a key leaves the vault for good; its tag stays so no other copy brings it back. */
  retire(text, now = Date.now()) {
    if (typeof text !== 'string' || !text) return;
    const gone = this._gone();
    gone[keyTag(text)] = now;
    const tags = Object.keys(gone);
    if (tags.length > MAX_GONE) {
      tags.sort((a, b) => gone[a] - gone[b]);
      for (const t of tags.slice(0, tags.length - MAX_GONE)) delete gone[t];
    }
  }

  /** isRetired(text) -> true when the key was shredded in this copy or a merged one. */
  isRetired(text) {
    return Boolean(isObj(this.data.gone) && typeof text === 'string' && this.data.gone[keyTag(text)]);
  }

  /** floor(ledgerId) -> the highest pointer seq accepted for that ledger label, or undefined. */
  floor(ledgerId) {
    const f = isObj(this.data.floors) ? this.data.floors[ledgerId] : undefined;
    return Number.isSafeInteger(f) ? f : undefined;
  }

  /** raiseFloor(ledgerId, seq): never lowers it. */
  raiseFloor(ledgerId, seq) {
    if (typeof ledgerId !== 'string' || !ledgerId || !Number.isSafeInteger(seq)) return;
    if (!isObj(this.data.floors)) this.data.floors = {};
    const f = this.data.floors[ledgerId];
    this.data.floors[ledgerId] = Number.isSafeInteger(f) ? Math.max(f, seq) : seq;
  }

  /** markOwner(label, now): the label made a page or confirmed an owner action ("Replace my keys" keeps it). */
  markOwner(label, now = Date.now()) {
    const entry = this.label(label, { now });
    if (!isTime(entry.owns)) entry.owns = now;
  }

  /**
   * eraseRecord(label, origin, now): the private record of origin is gone (R 2.15); fields written before now never
   * come back from another copy (meCut).
   */
  eraseRecord(label, origin, now = Date.now()) {
    const entry = this.label(label, { create: false });
    if (!entry) return;
    if (isObj(entry.me)) delete entry.me[origin];
    entry.meCut = Object.assign({}, isObj(entry.meCut) ? entry.meCut : {}, { [origin]: now });
  }

  /**
   * mergeRecord(label, origin, incoming, { maxVault }) -> 'ok' | 'too-large' | 'vault-full' | 'bad' | 'none': a site's
   * copy of its private record merged into this one (R 2.6.1: per field, the newest write wins; fields older than an
   * erase stay gone). Refused when the record would exceed RECORD_MAX_BYTES (one index item plus 31 data items, what
   * a site may sync, R 2.6.2) or the vault VAULT_MAX_BYTES (code review v0.3, security 8: one site could otherwise
   * grow the vault until every later sign-in, at every site, was refused).
   */
  mergeRecord(label, origin, incoming, { maxVault = VAULT_MAX_BYTES } = {}) {
    const entry = this.label(label, { create: false });
    if (!entry) return 'none';
    if (!isObj(incoming) || !isObj(incoming.f) || !isTime(incoming.t)) return 'bad';
    if (recordSize(incoming) > RECORD_MAX_BYTES) return 'too-large';
    const cut = isObj(entry.meCut) ? entry.meCut[origin] : undefined;
    const before = isObj(entry.me) ? entry.me[origin] : undefined;
    const merged = mergeRecordCopies(cutRecord(before, cut), cutRecord(incoming, cut));
    if (recordSize(merged) > RECORD_MAX_BYTES) return 'too-large';
    if (!isObj(entry.me)) entry.me = {};
    entry.me[origin] = merged;
    if (this.size() > maxVault) {
      if (before) entry.me[origin] = before;
      else delete entry.me[origin];
      return 'vault-full';
    }
    return 'ok';
  }

  /**
   * mergeFrom(other, { now }) -> true when other (a Vault or its data) was merged: another copy of this same vault
   * (an escrow copy from a site, a copy another window saved). Per label: chat epochs by e, record keys by r, K_own
   * and K_local when this copy has none, contacts, links (newest per origin), sites, the private records per field
   * (newest write wins, erasures stand), the larger sign index with its rotation notice; then the legacy keys and the
   * pointer floors. Keys either copy retired never return. Where both copies hold different keys under one epoch
   * number (a label created again after the identity origin lost its storage), this copy's key stays in use and the
   * other is kept in archived. The caller has authenticated other (AES-GCM under K_vault).
   */
  mergeFrom(other, { now = Date.now() } = {}) {
    const src = other instanceof Vault ? other.data : other;
    if (!isObj(src) || src.v !== 2 || !isObj(src.labels)) return false;
    const d = this.data;
    const gone = this._gone();
    if (isObj(src.gone)) for (const tag of Object.keys(src.gone)) if (!(tag in gone) && isTime(src.gone[tag])) gone[tag] = src.gone[tag];
    if (!isObj(d.unlinked)) d.unlinked = {};
    if (isObj(src.unlinked)) for (const o of Object.keys(src.unlinked)) if (isTime(src.unlinked[o]) && !(d.unlinked[o] >= src.unlinked[o])) d.unlinked[o] = src.unlinked[o];
    for (const l of Object.keys(d.labels)) {
      d.labels[l] = normalizeEntry(d.labels[l]) || emptyLabel(now);
      purgeGone(d.labels[l], gone);
    }
    for (const l of Object.keys(src.labels)) {
      if (!LABEL_RE.test(l) || l.length > 300) continue;
      let theirs;
      try { theirs = normalizeEntry(JSON.parse(JSON.stringify(src.labels[l]))); } catch (_) { theirs = null; }
      if (!theirs) continue;
      purgeGone(theirs, gone);
      if (!d.labels[l]) d.labels[l] = theirs;
      else mergeEntry(d.labels[l], theirs, now);
    }
    // One origin is linked to one label: the newest link wins, and a link older than its removal is dropped.
    const newest = new Map();
    for (const l of Object.keys(d.labels)) {
      for (const x of d.labels[l].links) {
        const cur = newest.get(x.origin);
        if (!cur || cur.t < x.t) newest.set(x.origin, { label: l, t: x.t });
      }
    }
    for (const l of Object.keys(d.labels)) {
      d.labels[l].links = d.labels[l].links.filter((x) => {
        const best = newest.get(x.origin);
        return best && best.label === l && best.t === x.t && !(d.unlinked[x.origin] >= x.t);
      });
    }
    if (Array.isArray(src.legacy)) {
      for (const x of src.legacy) {
        if (!x || typeof x.pub !== 'string' || !x.jwk || typeof x.jwk.d !== 'string') continue;
        if (!d.legacy.some((y) => y.pub === x.pub && (y.ledger || null) === (x.ledger || null))) d.legacy.push(x);
      }
    }
    if (isObj(src.floors)) for (const id of Object.keys(src.floors)) this.raiseFloor(id, src.floors[id]);
    d.ver = Math.max(this.version(), Number.isSafeInteger(src.ver) ? src.ver : 0) + 1;
    return true;
  }

  labels() {
    return Object.keys(this.data.labels);
  }

  /**
   * label(label, { create = true, now }) -> { i, chat, rec, own, local, contacts, links, sites }
   * (the live entry). A new label gets chat epoch 1, record epoch 1, K_own and K_local, all random.
   */
  label(label, { create = true, now = Date.now() } = {}) {
    checkLabelName(label);
    let entry = this.data.labels[label];
    if (!entry && create) {
      entry = emptyLabel(now);
      this.data.labels[label] = entry;
    }
    return entry || null;
  }

  /** currentChat(label, now) -> { e, jwk, exp, pub } of the newest unexpired epoch, or null. */
  currentChat(label, now = Date.now()) {
    const entry = this.label(label, { create: false });
    if (!entry || entry.chat.length === 0) return null;
    const c = entry.chat[entry.chat.length - 1];
    if (c.exp <= now) return null;
    return Object.assign({ pub: publicKeyOf(b64url.decode(c.jwk.d)) }, c);
  }

  /** rotateChat(label, { now }) -> the new epoch { e, jwk, exp }; older epochs stay for reading. */
  rotateChat(label, { now = Date.now() } = {}) {
    const entry = this.label(label, { now });
    const last = entry.chat.length ? entry.chat[entry.chat.length - 1].e : 0;
    const next = newChatKey(last + 1, now);
    entry.chat.push(next);
    return next;
  }

  /** newRecordKey(label) -> { r, key }: a fresh record epoch for sealed items. */
  newRecordKey(label) {
    const entry = this.label(label);
    const last = entry.rec.length ? entry.rec[entry.rec.length - 1].r : 0;
    const next = { r: last + 1, key: b64url.encode(rand(32)) };
    entry.rec.push(next);
    return next;
  }

  /** bumpSignIndex(label) -> the new rotation index i (the signing key changes, R 2.2.2). */
  bumpSignIndex(label) {
    const entry = this.label(label);
    entry.i += 1;
    return entry.i;
  }

  /**
   * shred(label, what): deletes keys so they are retired (MF-18). what: 'chat' | 'rec' | 'own' |
   * 'local' | 'contacts' | 'links' | 'sites' | 'all' | { chat: e } | { rec: r }. Returns true when
   * something was removed. Copies in older backup files are not reached: the card says so.
   */
  shred(label, what) {
    checkLabelName(label);
    const known = ['chat', 'rec', 'own', 'local', 'contacts', 'links', 'sites', 'all'];
    const selector = what && typeof what === 'object' ? Number.isInteger(what.chat) || Number.isInteger(what.rec) : known.indexOf(what) >= 0;
    if (!selector) throw new TypeError('shred: unknown selector ' + String(what));
    const entry = this.data.labels[label];
    if (!entry) return false;
    // Every key that leaves is retired (keyTag), so an older escrow or backup copy merged later cannot bring it back.
    const now = Date.now();
    const retireChat = (list) => { for (const c of list) if (c && c.jwk) this.retire(c.jwk.d, now); };
    const retireRec = (list) => { for (const r of list) if (r) this.retire(r.key, now); };
    if (what === 'all') {
      retireChat(entry.chat || []);
      retireRec(entry.rec || []);
      this.retire(entry.own, now);
      this.retire(entry.local, now);
      if (!isObj(this.data.unlinked)) this.data.unlinked = {};
      for (const x of entry.links || []) this.data.unlinked[x.origin] = now;
      delete this.data.labels[label];
      return true;
    }
    if (what && typeof what === 'object') {
      if (Number.isInteger(what.chat)) {
        const before = entry.chat.length;
        retireChat(entry.chat.filter((c) => c.e === what.chat));
        entry.chat = entry.chat.filter((c) => c.e !== what.chat);
        return entry.chat.length !== before;
      }
      if (Number.isInteger(what.rec)) {
        const before = entry.rec.length;
        retireRec(entry.rec.filter((r) => r.r === what.rec));
        entry.rec = entry.rec.filter((r) => r.r !== what.rec);
        return entry.rec.length !== before;
      }
      throw new TypeError('shred: unknown selector');
    }
    switch (what) {
      case 'chat': case 'rec': case 'contacts': case 'links': case 'sites': {
        const had = entry[what].length > 0;
        if (what === 'chat') retireChat(entry.chat);
        if (what === 'rec') retireRec(entry.rec);
        if (what === 'links') {
          if (!isObj(this.data.unlinked)) this.data.unlinked = {};
          for (const x of entry.links) this.data.unlinked[x.origin] = now;
        }
        entry[what] = [];
        return had;
      }
      case 'own': case 'local': {
        const had = entry[what] !== null;
        this.retire(entry[what], now);
        entry[what] = null;
        return had;
      }
      default:
        throw new TypeError('shred: unknown selector ' + String(what));
    }
  }

  /** linkOrigin(origin, label, now): "Use the same identity as on X" (R 2.3.5); local only. */
  linkOrigin(origin, label, now = Date.now()) {
    const o = normalizeOrigin(origin);
    this._dropLinks(o);
    const at = isObj(this.data.unlinked) && this.data.unlinked[o] >= now ? this.data.unlinked[o] + 1 : now;
    this.label(label).links.push({ origin: o, t: at });
  }

  _dropLinks(origin) {
    let removed = false;
    for (const l of Object.keys(this.data.labels)) {
      const entry = this.data.labels[l];
      const before = entry.links.length;
      entry.links = entry.links.filter((x) => x.origin !== origin);
      if (entry.links.length !== before) removed = true;
    }
    return removed;
  }

  /**
   * unlinkOrigin(origin, now) -> true when a link was removed (future sign-ins only). The removal is remembered
   * (unlinked), so an older copy that still holds the link does not bring it back in a merge.
   */
  unlinkOrigin(origin, now = Date.now()) {
    const removed = this._dropLinks(origin);
    if (removed) {
      if (!isObj(this.data.unlinked)) this.data.unlinked = {};
      this.data.unlinked[origin] = now;
    }
    return removed;
  }

  /** links() -> { origin: label } for labelFor. */
  links() {
    const out = {};
    for (const l of Object.keys(this.data.labels)) for (const x of this.data.labels[l].links) out[x.origin] = l;
    return out;
  }

  /** addSite(label, origin, now): the local list of sites signed in to with this label. */
  addSite(label, origin, now = Date.now()) {
    const o = normalizeOrigin(origin);
    const entry = this.label(label, { now });
    if (!entry.sites.some((s) => s.origin === o)) entry.sites.push({ origin: o, t: now });
  }

  /** addLegacy({ ledger, pub, jwk }, now): a 0.2.1 key taken into the vault (R 2.2.7). */
  addLegacy({ ledger, pub, jwk }, now = Date.now()) {
    if (typeof pub !== 'string' || !jwk || typeof jwk.d !== 'string') throw new TypeError('legacy key needs pub and jwk.d');
    if (this.data.legacy.some((x) => x.pub === pub && x.ledger === (ledger || null))) return false;
    this.data.legacy.push({ ledger: ledger || null, pub, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, t: now });
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Backup file (mw-identity-v3)
// ---------------------------------------------------------------------------------------------

function backupAad(header) {
  return utf8.encode(BACKUP_PREFIX + '\n' + canonicalize(header));
}

function backupKdf(kdf, params) {
  if (kdf === 'argon2id') {
    const p = Object.assign({}, ARGON2ID_DEFAULTS, params || {});
    return { kdf: 'argon2id', params: { m: p.m, t: p.t, p: p.p }, spec: { name: 'argon2id', m: p.m, t: p.t, p: p.p } };
  }
  if (kdf === 'pbkdf2' || kdf === 'pbkdf2-sha256') {
    const iter = params && params.iter !== undefined ? params.iter : PBKDF2_ITERATIONS;
    return { kdf: 'pbkdf2-sha256', params: { iter }, spec: { name: 'pbkdf2-sha256', iter } };
  }
  throw new TypeError("kdf must be 'argon2id' or 'pbkdf2'");
}

/**
 * makeBackupFile({ rootStar, kVault, vault }, passphrase, { kdf = 'argon2id', params, allowWeak })
 *   -> JSON text of { type: 'mw-identity', v: 3, kdf, params, salt, iv, ct }.
 * A passphrase below the floor (passphraseStrength) is refused with E_WEAK_PASSPHRASE unless it
 * is a generated one; allowWeak is for tests only.
 */
export async function makeBackupFile({ rootStar, kVault, vault }, passphrase, { kdf = 'argon2id', params, allowWeak = false, onProgress = null } = {}) {
  if (!(rootStar instanceof Uint8Array) || rootStar.length !== 32) throw new TypeError('rootStar must be 32 bytes');
  if (!(kVault instanceof Uint8Array) || kVault.length !== 32) throw new TypeError('kVault must be 32 bytes');
  if (!allowWeak && !passphraseStrength(passphrase).ok) throw vaultError('E_WEAK_PASSPHRASE', 'choose a longer passphrase, or use the generated one');
  const k = backupKdf(kdf, params);
  const salt = rand(16);
  const header = { type: 'mw-identity', v: 3, kdf: k.kdf, params: k.params, salt: b64url.encode(salt) };
  const key = await passphraseKey(passphrase, salt, k.spec, { onProgress });
  const iv = rand(12);
  const body = { rootStar: b64url.encode(rootStar), kVault: b64url.encode(kVault), vault: vault instanceof Vault ? vault.toJSON() : vault };
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: backupAad(header) }, await aes(key), utf8.encode(JSON.stringify(body))));
  return JSON.stringify(Object.assign({}, header, { iv: b64url.encode(iv), ct: b64url.encode(ct) }), null, 2);
}

/** openBackupFile(text, passphrase, { onProgress }) -> { rootStar, kVault, vault: Vault }; E_BACKUP on any failure. */
export async function openBackupFile(text, passphrase, { onProgress = null } = {}) {
  const fail = () => vaultError('E_BACKUP', 'this backup file could not be opened with that passphrase');
  let obj;
  try {
    obj = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (_) {
    throw fail();
  }
  if (!obj || obj.type !== 'mw-identity' || obj.v !== 3 || typeof obj.salt !== 'string' || typeof obj.iv !== 'string' || typeof obj.ct !== 'string') throw fail();
  const header = { type: obj.type, v: 3, kdf: obj.kdf, params: obj.params, salt: obj.salt };
  let spec;
  if (obj.kdf === 'argon2id' && obj.params) spec = { name: 'argon2id', m: obj.params.m, t: obj.params.t, p: obj.params.p };
  else if (obj.kdf === 'pbkdf2-sha256' && obj.params) spec = { name: 'pbkdf2-sha256', iter: obj.params.iter };
  else throw fail();
  let body;
  try {
    const key = await passphraseKey(passphrase, b64url.decode(obj.salt), spec, { onProgress });
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64url.decode(obj.iv), additionalData: backupAad(header) }, await aes(key), b64url.decode(obj.ct));
    body = JSON.parse(utf8.decode(new Uint8Array(pt), { fatal: true }));
  } catch (_) {
    throw fail();
  }
  const rootStar = b64url.decode(body.rootStar);
  const kVault = b64url.decode(body.kVault);
  if (rootStar.length !== 32 || kVault.length !== 32 || !body.vault || body.vault.v !== 2) throw fail();
  return { rootStar, kVault, vault: new Vault(body.vault) };
}

/** isLegacyExport(text) -> true for the 0.2.1 export shape. */
export function isLegacyExport(text) {
  try {
    const o = typeof text === 'string' ? JSON.parse(text) : text;
    return Boolean(o && o.type === 'mw-identity' && o.v === 1);
  } catch (_) {
    return false;
  }
}

/**
 * parseLegacyExport(text, passphrase) -> { ledger, pub, jwk } from a 0.2.1 export
 * (exportIdentityText); checks that the decrypted scalar gives the recorded public key.
 * E_LEGACY on a wrong passphrase or a changed file.
 */
export async function parseLegacyExport(text, passphrase) {
  const fail = () => vaultError('E_LEGACY', 'this identity file could not be opened with that passphrase');
  let obj;
  try {
    obj = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (_) {
    throw fail();
  }
  if (!obj || obj.type !== 'mw-identity' || obj.v !== 1 || obj.kdf !== 'PBKDF2-SHA256') throw fail();
  const iter = Number(obj.iter);
  if (!Number.isInteger(iter) || iter < 1000 || iter > 10000000) throw fail();
  let jwk;
  try {
    const base = await subtle().importKey('raw', utf8.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle().deriveKey({ name: 'PBKDF2', salt: b64url.decode(obj.salt), iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const aad = utf8.encode('mw-identity-v1\n' + (obj.ledger || '') + '\n' + (obj.pub || ''));
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64url.decode(obj.iv), additionalData: aad }, key, b64url.decode(obj.ct));
    jwk = JSON.parse(utf8.decode(new Uint8Array(pt), { fatal: true }));
  } catch (_) {
    throw fail();
  }
  let pub;
  try {
    pub = publicKeyOf(b64url.decode(jwk.d));
  } catch (_) {
    throw fail();
  }
  if (pub !== obj.pub) throw fail();
  return { ledger: obj.ledger || null, pub, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
}

// ---------------------------------------------------------------------------------------------
// Passphrases
// ---------------------------------------------------------------------------------------------

/** generatePassphrase(words = 6) -> 'word-word-...': distinct BIP-39 words, about 11 bits each. */
export function generatePassphrase(words = 6) {
  if (!Number.isInteger(words) || words < 6 || words > 24) throw new RangeError('6 to 24 words');
  // Distinct words (a repeat is drawn again), and never in list order (about 1 draw in 360 for 6 words is drawn
  // again), so the strength estimate below always gives it the full 11 bits per word.
  const r = new Uint16Array(1);
  for (;;) {
    const out = [];
    while (out.length < words) {
      globalThis.crypto.getRandomValues(r);
      const w = BIP39_ENGLISH[r[0] & 0x7ff]; // 2048 divides 65536: uniform
      if (out.indexOf(w) < 0) out.push(w);
    }
    if (wordBits(out.map((w) => wordIndex(w))) === 11 * words) return out.join('-');
  }
}

/**
 * passphraseStrength(pass) -> { ok, bits, reason? }. The stated floor: at least 12 characters
 * and an estimate of at least 60 bits. The estimate: 11 bits per word for a passphrase made only
 * of distinct BIP-39 words (5 or more, separated by spaces or hyphens), less what their order gives
 * away (words in list order are nearly free to guess: code review v0.3, security 2, "abandon ability
 * able about above absent"); otherwise half of effective length x log2(alphabet size), because
 * chosen passphrases are far from random. The effective length counts a run of 3 or more characters
 * that repeat, step through the alphabet or digits ("abcdef", "4321") or walk a keyboard row
 * ("qwerty", "asdfgh") as 2 characters.
 */
export function passphraseStrength(pass) {
  if (typeof pass !== 'string') return { ok: false, bits: 0, reason: 'empty' };
  const p = pass.normalize('NFC');
  const chars = Array.from(p);
  const tokens = p.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let bits;
  if (tokens.length >= 5 && tokens.every((t) => wordIndex(t) >= 0) && new Set(tokens).size === tokens.length) {
    bits = wordBits(tokens.map((t) => wordIndex(t)));
  } else {
    let pool = 0;
    if (/[a-z]/.test(p)) pool += 26;
    if (/[A-Z]/.test(p)) pool += 26;
    if (/[0-9]/.test(p)) pool += 10;
    if (/[^A-Za-z0-9\s]/.test(p)) pool += 33;
    if (/\s/.test(p)) pool += 1;
    if (chars.some((c) => c.codePointAt(0) > 127)) pool += 100;
    const distinct = new Set(chars).size;
    const effective = effectiveLength(chars);
    bits = Math.floor(0.5 * Math.min(effective, 2 * distinct) * Math.log2(Math.max(pool, 2)));
  }
  if (chars.length < PASSPHRASE_MIN_LENGTH) return { ok: false, bits, reason: 'short' };
  if (bits < PASSPHRASE_FLOOR_BITS) return { ok: false, bits, reason: 'weak' };
  return { ok: true, bits };
}

/**
 * wordBits(indices) -> bits for distinct BIP-39 word indices: 11 per word, minus log2(n!) when the words are in
 * list order (either direction), and only 11 + 4 per further word when each is within 16 places of the last
 * (taken from one stretch of the list).
 */
function wordBits(idx) {
  const n = idx.length;
  let near = true;
  for (let i = 1; i < n; i++) if (Math.abs(idx[i] - idx[i - 1]) > 16) near = false;
  if (near) return 11 + 4 * (n - 1);
  let up = true;
  let down = true;
  for (let i = 1; i < n; i++) {
    if (idx[i] < idx[i - 1]) up = false;
    if (idx[i] > idx[i - 1]) down = false;
  }
  let bits = 11 * n;
  if (up || down) {
    let fact = 0;
    for (let k = 2; k <= n; k++) fact += Math.log2(k);
    bits = Math.floor(bits - fact);
  }
  return bits;
}

const KEYBOARD_ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
const KEY_AT = (() => {
  const m = new Map();
  KEYBOARD_ROWS.forEach((row, r) => Array.from(row).forEach((c, i) => m.set(c, { r, i })));
  return m;
})();

/** step(a, b) -> true when b continues a run after a: the same character, the next or previous code point, a keyboard neighbour. */
function step(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const cx = x.codePointAt(0);
  const cy = y.codePointAt(0);
  if (Math.abs(cx - cy) === 1 && /[a-z0-9]/.test(x) && /[a-z0-9]/.test(y)) return true;
  const kx = KEY_AT.get(x);
  const ky = KEY_AT.get(y);
  return Boolean(kx && ky && kx.r === ky.r && Math.abs(kx.i - ky.i) === 1);
}

/** effectiveLength(chars) -> the length with every run of 3 or more stepping characters counted as 2. */
function effectiveLength(chars) {
  let total = 0;
  let run = 1;
  const close = () => { total += run >= 3 ? 2 : run; };
  for (let i = 1; i < chars.length; i++) {
    if (step(chars[i - 1], chars[i])) run++;
    else { close(); run = 1; }
  }
  if (chars.length) close();
  return total;
}
