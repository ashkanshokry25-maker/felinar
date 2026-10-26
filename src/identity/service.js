// src/identity/service.js: auth.*, identity.* and me.* of R 2.11.2 behind one object the loader mounts (the SVC
// contract shared with the chat, media and sdk lanes; R 2.4, 2.5.4, 2.6, 2.15; MF-14, MF-16, MF-24, PR-1).
//
//   createIdentityService(deps) -> { methods, on(event, fn) -> unsubscribe, destroy(), keys(), ownerAction(card), adopt(result),
//     restore(), follow() }
//   methods[name] = async (params, ctx) => result, ctx = { activation, tab: 'leader' | 'follower', signal? }
//   failures: Object.assign(new Error(msg), { code }) with R 2.11.2 codes only.
//
// deps (brief): { node, ledgerId, pointer, cfg(), prompt(kind, data), now, random, countPosts(pub) }, plus
// optional: scope (the scope the loader verified the pointer under, or a function returning it: a mirror then gets
// the ledger label when the pointer's org= lists it), client (signIn, openIdentity; default src/identity/client.js),
// Keys (default WorkingKeys), origin,
// idb, channelFactory, cryptoApi, win, idp, sharedHub (a shared-origin hub: "this visit only"), legacy ({ get(),
// remove(), write(item) } for the 0.2.1 key of this ledger), onKeys(keys | null) (the loader re-opens its node
// with the new identity), writer ({ append, tombstone, profile }; default the node's methods), linkPointer (true on a hub
// label or a door: the pointer came by link, so its idp= never picks the identity origin; review round PTR-10).
//
// Gating, in this order: destroyed (E_POLICY); a follower tab may only read (E_POLICY: keys live in the leader
// tab); a UI method without ctx.activation (E_NEEDS_GESTURE; me.get is UI on its first call per session); a
// method that needs keys without them (E_NOT_SIGNED_IN); then the method's own rules. ctx.activation is the
// loader-verified click; a site-supplied flag proves nothing (HON M3).
//
// me.* (R 2.6.1, 2.6.2, 2.5.4): the record lives in the IdO vault by default; this origin keeps a copy sealed
// under K_local (client.sealLocal) that goes back to the IdO with each request. A synced copy goes to the site
// ledger as mw.s sealed items only when _mw.cfg.records is 'sealed', the person may write and opted in
// (me.sync): one index item and up to 31 data items under K_rec, at most one synced update per hour.
//
// Shared code: Node >= 22 and browsers.

import * as defaultClient from './client.js';
import { mergeRecords } from './client.js';
import { WorkingKeys, readEpoch, onSignedOut } from './store.js';
import { legacyOption, legacyOutcome } from './migrate.js';
import { makeLocalProof, verifyLocalProof, LOCAL_MAX_AGE_MS } from './signin.js';
import { seal as sealItem, open as openItem, readEffective, MAX_DATA_BYTES, MAX_ITEMS_PER_AUTHOR, KINDS, SEAL_LIST } from './sealed.js';
import { roleOf } from '../chain/state.js';
import { publicKeyBytes, isPublicKeyString } from '../chain/crypto.js';
import { utf8 } from '../chain/canonical.js';

export const IDENTITY_METHODS = Object.freeze([
  'auth.signIn', 'auth.signOut', 'auth.state', 'auth.prove', 'auth.verify', 'auth.signInServer',
  'identity.current', 'identity.setName', 'identity.backupStatus', 'identity.openIdentity',
  'me.get', 'me.set', 'me.del', 'me.sync', 'me.erase',
]);
export const IDENTITY_EVENTS = Object.freeze(['auth', 'kit', 'keychange']);
/** UI methods (a loader-verified click); auth.signOut only with forget: true; me.get on its first call per session. */
export const UI_IDENTITY_METHODS = Object.freeze(['auth.signIn', 'auth.signInServer', 'identity.openIdentity', 'me.sync', 'me.erase']);
export const READ_IDENTITY_METHODS = Object.freeze(['auth.state', 'auth.verify', 'identity.current', 'identity.backupStatus']);
export const SYNC_INTERVAL_MS = 3600 * 1000;
export const MAX_DATA_ITEMS = MAX_ITEMS_PER_AUTHOR - 1; // one index item plus 31 data items
export const MAX_RECORD_BYTES = MAX_DATA_ITEMS * MAX_DATA_BYTES;
/**
 * Review round SCALE-3: one synced update writes its data items and its index in one go, against the ledger's author
 * throttle (30 local writes in 10 minutes, chain/node.js ingressRate) that the keyinfo block and the tombstones of the
 * previous version share. A record that needs more than SYNC_WRITE_BUDGET appends stays on this device (stored 'local',
 * before any write); the tombstones of the previous version go after the new index and wait for a later sync when the throttle says no.
 */
export const SYNC_WRITE_BUDGET = 14;
export const MAX_SYNC_RECORD_BYTES = (SYNC_WRITE_BUDGET - 1) * MAX_DATA_BYTES;
export const NAME_MAX = 48;
/** Field names a record may never hold (R 2.6.2: never email, phone, legal name, birth date, documents or health). */
export const RESERVED_FIELDS = Object.freeze([
  'email', 'mail', 'phone', 'tel', 'telephone', 'mobile', 'legalname', 'fullname', 'realname', 'surname', 'firstname', 'lastname',
  'birthdate', 'birthday', 'dob', 'dateofbirth', 'age', 'documents', 'document', 'passport', 'idcard', 'license', 'ssn', 'sin',
  'nationalid', 'health', 'medical', 'diagnosis', 'address', 'homeaddress',
]);
/** The owner actions the identity origin confirms on its own card (R 3.3; ownerAction). */
export const OWNER_ACTIONS = Object.freeze(['policy', 'checkpoint', 'withdraw', 'delete']);
export const OWNER_ONLY_REASON = 'This site does not let visitors write to its ledger, so your record stays on this device.';

function fail(code, msg) {
  return Object.assign(new Error(msg || code), { code });
}

function argsOf(params, names = []) {
  if (Array.isArray(params)) {
    if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) return Object.assign({}, params[0]);
    const out = {};
    names.forEach((n, i) => { if (params[i] !== undefined) out[n] = params[i]; });
    const last = params[names.length];
    if (last && typeof last === 'object' && !Array.isArray(last)) Object.assign(out, last);
    return out;
  }
  if (params && typeof params === 'object') return Object.assign({}, params);
  if (params !== undefined && names.length) return { [names[0]]: params };
  return {};
}

/** fieldProblem(name) -> null or a reason: names are [a-z][a-zA-Z0-9_.-]{0,31} and not reserved. */
export function fieldProblem(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,31}$/.test(name)) return 'name';
  const flat = name.toLowerCase().replace(/[_.-]/g, '');
  if (RESERVED_FIELDS.indexOf(flat) >= 0) return 'reserved';
  for (const r of ['email', 'phone', 'passport', 'birth', 'health', 'medical', 'legalname', 'ssn']) if (flat.indexOf(r) >= 0) return 'reserved';
  return null;
}

// did:key for a P-256 key (multicodec p256-pub 0x1200, compressed point, base58btc)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** didKeyOf(pub) -> 'did:key:zDn...' for a p256: key. */
export function didKeyOf(pub) {
  const raw = publicKeyBytes(pub);
  const compressed = new Uint8Array(33);
  compressed[0] = (raw[64] & 1) === 1 ? 0x03 : 0x02;
  compressed.set(raw.subarray(1, 33), 1);
  const multi = new Uint8Array(35);
  multi[0] = 0x80;
  multi[1] = 0x24;
  multi.set(compressed, 2);
  return 'did:key:z' + base58(multi);
}

function modeName(keyMode) {
  return keyMode === 'linked' ? 'same' : keyMode === 'hub' ? 'hub' : keyMode === 'visit-only' ? 'visit' : 'private';
}

export function createIdentityService(depsIn = {}) {
  const given = {};
  for (const k of Object.keys(depsIn || {})) if (depsIn[k] !== undefined) given[k] = depsIn[k];
  const d = Object.assign({
    cfg: () => ({}), prompt: async () => false, now: () => Date.now(), random: Math.random, countPosts: null,
    client: defaultClient, Keys: WorkingKeys, sharedHub: false, legacy: null, onKeys: null,
  }, given);
  const now = d.now;
  const origin = d.origin || (typeof location !== 'undefined' ? location.origin : 'http://localhost');
  const listeners = new Map();
  const S = {
    keys: null, destroyed: false, record: null, recordGranted: false, recordLoaded: false,
    sync: { on: false, last: 0, items: [], stale: [], pending: false }, meaningful: false, kitAsked: false,
    unsubscribeFollower: null, follower: false,
  };

  function emit(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(data); } catch (_) { /* a listener must not break the service */ }
    }
  }

  function cfg() {
    try { return (typeof d.cfg === 'function' ? d.cfg() : d.cfg) || {}; } catch (_) { return {}; }
  }

  // deps.node may be the node, a live proxy of it (api.js liveObject) or a function returning it.
  function nodeOf() {
    try {
      const n = typeof d.node === 'function' ? d.node() : d.node;
      return n || null;
    } catch (_) {
      return null;
    }
  }

  function state() {
    try {
      const n = nodeOf();
      return n ? n.state || null : null;
    } catch (_) {
      return null;
    }
  }

  function roleFor(pub) {
    if (!pub) return 'reader';
    try {
      const n = nodeOf();
      if (n && typeof n.roleOf === 'function') return n.roleOf(pub);
    } catch (_) {
      // fall through to the reduced state
    }
    const st = state();
    // Code review v0.3 (round 2, ledger-tools request): the clock decides whether a temporary ban still holds.
    try { return st && st.policy ? roleOf(pub, st, now()) : 'reader'; } catch (_) { return 'reader'; }
  }

  function nameFor(pub) {
    const st = state();
    if (!st || !st.profiles) return null;
    const v = st.profiles instanceof Map ? st.profiles.get(pub) : st.profiles[pub];
    return typeof v === 'string' ? v : null;
  }

  function identityOf(keys) {
    if (!keys) return null;
    return { pub: keys.pub, short: keys.short, name: nameFor(keys.pub), mode: modeName(keys.keyMode), keyMode: keys.keyMode, did: didKeyOf(keys.pub) };
  }

  function writer() {
    const w = d.writer || nodeOf();
    let ok = false;
    try { ok = Boolean(w && typeof w.append === 'function' && typeof w.tombstone === 'function'); } catch (_) { ok = false; }
    if (!ok) throw fail('E_POLICY', 'this page has no ledger open to write to');
    return w;
  }

  function setKeys(keys) {
    S.keys = keys;
    S.record = null;
    S.recordGranted = false;
    S.recordLoaded = false;
    S.sync = { on: false, last: 0, items: [], stale: [], pending: false };
    if (typeof d.onKeys === 'function') {
      try { d.onKeys(keys); } catch (_) { /* the loader logs it */ }
    }
  }

  function announce() {
    const identity = identityOf(S.keys);
    emit('auth', { state: S.keys ? 'signed-in' : 'guest', identity, role: S.keys ? roleFor(S.keys.pub) : 'reader' });
  }

  // Follower tabs drop their state when the leader (or any tab) signs out (R 2.4.1, E-ID-2b).
  // Sign-out is per origin: every other tab drops its keys and its signed-in state (followers never hold keys).
  S.unsubscribeFollower = onSignedOut(() => {
    if (!S.keys && !S.follower) return;
    S.keys = null;
    S.record = null;
    S.recordGranted = false;
    S.recordLoaded = false;
    if (typeof d.onKeys === 'function') {
      try { d.onKeys(null); } catch (_) { /* the loader logs it */ }
    }
    if (S.follower) emit('auth', { state: 'guest', identity: null, role: 'reader' });
    else announce();
  }, d.channelFactory ? { channelFactory: d.channelFactory } : {});

  // -------------------------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------------------------

  function guard(name, ctx) {
    if (S.destroyed) throw fail('E_POLICY', 'the identity service is closed');
    const c = ctx || {};
    if (c.tab === 'follower' && READ_IDENTITY_METHODS.indexOf(name) < 0) throw fail('E_POLICY', 'sign in and write from the tab that runs this site');
  }

  function needGesture(ctx) {
    if (!ctx || ctx.activation !== true) throw fail('E_NEEDS_GESTURE', 'call this from a click');
  }

  function needKeys() {
    if (!S.keys || S.keys.destroyed) throw fail('E_NOT_SIGNED_IN', 'sign in first');
    return S.keys;
  }

  function needPersistent() {
    const k = needKeys();
    if (k.keyMode === 'visit-only') throw fail('E_HOST_ONLY_IDENTITY', 'this address is shared by many sites: your identity here lasts for this visit only');
    return k;
  }

  // A promise: the client resolves it after the identity window opened (no await before window.open).
  function escrow() {
    if (d.sharedHub) return undefined;
    return Promise.resolve().then(() => d.Keys.escrow({ idb: d.idb })).then((e) => e || undefined, () => undefined);
  }

  function clientOpts(extra) {
    const scope = typeof d.scope === 'function' ? d.scope() : d.scope;
    const o = Object.assign({ pointer: d.pointer || undefined, scope: d.pointer && typeof scope === 'string' && scope ? scope : undefined, win: d.win, idp: d.idp, cryptoApi: d.cryptoApi }, extra);
    // Review round PTR-10: a pointer that arrived by link (a hub label, a door) must not pick the identity origin. The loader
    // says so with deps.linkPointer once it passes the operator's own identity origin (deps.idp or configure()); until then a
    // hub keeps the pointer's idp= (hubs have no other way to name one yet: docs/deviations/review-round-identity.md).
    if (d.linkPointer === true) o.trustPointer = false;
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  }

  function markMeaningful() {
    if (S.meaningful) return;
    S.meaningful = true;
    const st = S.keys && S.keys.status;
    if (st && !st.kitSaved && !S.kitAsked) {
      S.kitAsked = true;
      emit('kit', { reason: 'first-action' });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Record (R 2.6)
  // -------------------------------------------------------------------------------------------

  function emptyRecord() {
    return { f: {}, ft: {}, t: 0 };
  }

  async function loadLocalRecord() {
    if (S.recordLoaded) return S.record;
    const k = needKeys();
    let local = null;
    try { local = await k.loadLocal('me'); } catch (_) { local = null; }
    const meta = await k.loadLocal('me-sync').catch(() => null);
    if (meta && typeof meta === 'object') S.sync = Object.assign({ on: false, last: 0, items: [], stale: [], pending: false }, meta);
    S.record = mergeRecords(S.record, local);
    S.recordLoaded = true;
    return S.record;
  }

  async function persistLocal() {
    const k = needKeys();
    await k.saveLocal('me', S.record);
  }

  async function persistSyncMeta() {
    const k = needKeys();
    await k.saveLocal('me-sync', { on: S.sync.on, last: S.sync.last, items: S.sync.items.slice(0, 64), stale: (S.sync.stale || []).slice(0, 256), digest: S.sync.digest || null });
  }

  /** tombstoneStale(w): the items of earlier versions, removed while the author throttle allows; the rest wait. */
  async function tombstoneStale(w) {
    const left = [];
    for (const h of S.sync.stale || []) {
      try {
        await w.tombstone(h);
      } catch (err) {
        if (err && err.code === 'E_RATE') left.push(h); // try again at the next sync; any other refusal: already gone
      }
    }
    S.sync.stale = left;
  }

  function recordBytes(rec) {
    return utf8.encode(JSON.stringify(rec));
  }

  async function recordDigest(bytes) {
    try {
      const c = d.cryptoApi || globalThis.crypto;
      const h = new Uint8Array(await c.subtle.digest('SHA-256', bytes));
      let out = '';
      for (let i = 0; i < 16; i++) out += h[i].toString(16).padStart(2, '0');
      return out;
    } catch (_) {
      return null;
    }
  }

  function syncPolicy() {
    const c = cfg();
    if (c.records !== 'sealed') return { ok: false, reason: 'This site has not turned on synced records.' };
    const st = state();
    const writers = st && st.policy ? st.policy.writers : null;
    const role = S.keys ? roleFor(S.keys.pub) : 'reader';
    if (role === 'reader') return { ok: false, reason: writers === 'owner' ? OWNER_ONLY_REASON : 'You may not write to this site\'s ledger, so your record stays on this device.' };
    return { ok: true };
  }

  async function ledgerRecord() {
    const st = state();
    const k = S.keys;
    if (!st || !st.lists || typeof st.lists.get !== 'function' || !k || !d.ledgerId) return null;
    const items = (st.lists.get(SEAL_LIST) || []).filter((it) => it && it.author === k.pub);
    const opened = await readEffective(items, { open: (it) => openItem({ value: it.v, ledgerId: d.ledgerId, authorPub: k.pub, key: k.rec }) });
    const mine = opened.get(k.pub) || [];
    let index = null;
    for (const { plain } of mine) if (plain.kind === KINDS.REC_INDEX && (!index || plain.ver > index.ver)) index = plain;
    if (!index) return null;
    const parts = mine.filter(({ plain }) => plain.kind === KINDS.REC_DATA && plain.ver === index.ver).sort((a, b) => a.plain.seq - b.plain.seq);
    if (!parts.length || parts.length !== parts[0].plain.count) return null;
    const total = parts.reduce((n, p) => n + p.plain.data.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { buf.set(p.plain.data, off); off += p.plain.data.length; }
    try {
      const rec = JSON.parse(utf8.decode(buf, { fatal: true }));
      return rec && rec.f && Number.isSafeInteger(rec.t) ? mergeRecords(rec) : null;
    } catch (_) {
      return null;
    }
  }

  async function syncNow({ force = false } = {}) {
    if (!S.sync.on) return { stored: 'local' };
    const p = syncPolicy();
    if (!p.ok) return { stored: 'local' };
    if (!force && now() - S.sync.last < SYNC_INTERVAL_MS) {
      S.sync.pending = true;
      return { stored: 'local' };
    }
    const k = needPersistent();
    const bytes = recordBytes(S.record);
    const n = Math.max(1, Math.ceil(bytes.length / MAX_DATA_BYTES));
    if (n > MAX_DATA_ITEMS) throw fail('E_LIMIT', 'the record is over ' + MAX_RECORD_BYTES + ' bytes');
    // Saved on this device and in the vault already; the ledger copy waits until the record is small enough to sync whole.
    if (n + 1 > SYNC_WRITE_BUDGET) return { stored: 'local', reason: 'This record is over ' + MAX_SYNC_RECORD_BYTES + ' bytes, so it stays on this device and is not synced.' };
    const w = writer();
    // Review round SCALE-5: an unchanged record writes nothing (each update leaves stubs in the site's shared pool).
    const digest = await recordDigest(bytes);
    if (digest && digest === S.sync.digest && S.sync.items.length) {
      await tombstoneStale(w);
      S.sync.last = now();
      S.sync.pending = false;
      await persistSyncMeta();
      return { stored: 'synced', h: S.sync.items[0] };
    }
    const ver = Math.floor(S.record.t / 1000) >>> 0;
    const hashes = [];
    const base = { ledgerId: d.ledgerId, authorPub: k.pub, key: k.rec, ver };
    // Review round SCALE-3: the data items first and the index last, so a refused append (E_RATE, E_CAP, a closed tab)
    // never leaves a newer index without its data, which would hide the complete older version on every other device.
    const dataHashes = [];
    try {
      for (let i = 0; i < n; i++) {
        const v = await sealItem(Object.assign({ kind: KINDS.REC_DATA, seq: i, count: n, data: bytes.subarray(i * MAX_DATA_BYTES, (i + 1) * MAX_DATA_BYTES) }, base));
        dataHashes.push((await w.append(SEAL_LIST, v)).h);
      }
      const index = await sealItem(Object.assign({ kind: KINDS.REC_INDEX, seq: 0, count: 1, data: JSON.stringify({ v: 1, n, t: S.record.t }) }, base));
      hashes.push((await w.append(SEAL_LIST, index)).h);
    } catch (err) {
      // The parts already written belong to no index: removed with the next sync's stale items.
      S.sync.stale = (S.sync.stale || []).concat(dataHashes);
      S.sync.pending = true;
      await persistSyncMeta().catch(() => {});
      throw err;
    }
    for (const h of dataHashes) hashes.push(h);
    // Update: the new items first, then the old ones are tombstoned (own entries); a tombstone the throttle refuses waits.
    S.sync.stale = (S.sync.stale || []).concat(S.sync.items);
    S.sync.items = hashes;
    S.sync.digest = digest;
    await tombstoneStale(w);
    S.sync.last = now();
    S.sync.pending = false;
    await persistSyncMeta();
    return { stored: 'synced', h: hashes[0] };
  }

  // -------------------------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------------------------

  const methods = {};
  function def(name, fn) {
    methods[name] = async (params, ctx) => {
      guard(name, ctx);
      return fn(params, ctx || {});
    };
  }

  async function installFrom(result) {
    if (!result || !result.bundle) throw fail('E_USER_CANCELLED', 'no keys came back');
    const K = result.bundle;
    const keys = await d.Keys.install(K, { stay: K.stay === true, sharedComputer: K.sharedComputer === true, idb: d.idb, cryptoApi: d.cryptoApi, channelFactory: d.channelFactory, now });
    if (S.keys && S.keys !== keys && !S.keys.destroyed) {
      try { S.keys.keys = null; S.keys.destroyed = true; } catch (_) { /* replaced */ }
    }
    setKeys(keys);
    if (keys.rotateNotice) emit('keychange', { notice: keys.rotateNotice, pub: keys.pub });
    return keys;
  }

  def('auth.signIn', async (params, ctx) => {
    needGesture(ctx);
    const p = argsOf(params);
    if (d.sharedHub && p.stay === true) throw fail('E_HOST_ONLY_IDENTITY', 'this address is shared by many sites: you can sign in for this visit only');
    // A 0.2.1 key of this ledger (R 2.2.7) is looked up while the window opens: the lookup is a promise.
    let legacyRec = null;
    const legacyP = !d.sharedHub && d.ledgerId && d.legacy && typeof d.legacy.get === 'function'
      ? Promise.resolve().then(() => d.legacy.get()).then((rec) => {
        legacyRec = rec && isPublicKeyString(rec.pub) ? rec : null;
        return legacyRec ? legacyOption(d.ledgerId, legacyRec, { name: nameFor(legacyRec.pub) || undefined, cryptoApi: d.cryptoApi }) : undefined;
      }, () => undefined)
      : undefined;
    // No await before this call: it opens the identity window inside the click (window.open). redirect: the loader's
    // "Continue in this tab" card (the popup could not open or lost its opener: R 2.3.1, G-ID-7); the page navigates to
    // the identity origin and the answer comes back through /_mw/idp-return (adopt). hubDefault is not passed on: no
    // page or SDK parameter preselects the hub link (R 2.3.5; code review v0.3, security 9).
    const result = await d.client.signIn(clientOpts({
      purpose: 'site', want: ['keys'], escrow: escrow(), legacy: legacyP, countPosts: d.countPosts || undefined,
      shared: d.sharedHub ? true : undefined, redirect: p.redirect === true ? true : undefined,
    }));
    await installFrom(result);
    if (legacyRec) {
      const m = await legacyOutcome(result, legacyRec.pub, { removeLegacy: d.legacy.remove });
      if (m.item && typeof d.legacy.write === 'function') {
        try { await d.legacy.write(m.item); } catch (_) { /* the link can be written later */ }
      }
    }
    announce();
    return { state: 'signed-in', identity: identityOf(S.keys), role: roleFor(S.keys.pub) };
  });

  def('auth.signOut', async (params, ctx) => {
    const p = argsOf(params);
    if (p.forget === true) needGesture(ctx);
    const k = S.keys;
    if (k) await k.destroy({ forget: p.forget === true });
    else if (p.forget === true) await d.Keys.forget({ idb: d.idb });
    setKeys(null);
    announce();
    return { state: 'guest' };
  });

  def('auth.state', async () => (S.keys && !S.keys.destroyed ? 'signed-in' : 'guest'));

  def('auth.prove', async (params) => {
    const k = needKeys();
    const p = argsOf(params, ['ttlMs']);
    const ttlMs = p.ttlMs === undefined ? LOCAL_MAX_AGE_MS : p.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > LOCAL_MAX_AGE_MS) throw fail('E_BAD_REQUEST', 'ttlMs is 1 to 900000');
    const epoch = await readEpoch({ idb: k.sharedComputer ? null : d.idb });
    // Memory only: the proof is returned and never written to any storage (MF-14, MF-16).
    return makeLocalProof({ signKey: k.identity.privateKey, pub: k.pub, origin, epoch, now: now(), ttlMs });
  });

  def('auth.verify', async (params) => {
    const proof = Array.isArray(params) ? params[0] : (params && params.proof ? params.proof : params);
    const epoch = await readEpoch({ idb: S.keys && S.keys.sharedComputer ? null : d.idb });
    const r = await verifyLocalProof(proof, { origin, epoch, now: now() });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, pub: r.pub, role: roleFor(r.pub), exp: proof.c.exp, kind: 'local' };
  });

  def('auth.signInServer', async (params, ctx) => {
    needGesture(ctx);
    if (d.sharedHub) throw fail('E_HOST_ONLY_IDENTITY', 'this address is shared by many sites: no signed statement can be made here');
    const p = argsOf(params);
    const ch = p.challenge;
    if (!ch || typeof ch !== 'object' || typeof ch.nonce !== 'string' || !ch.nonce) throw fail('E_NONCE_REQUIRED', 'a server sign-in needs a nonce issued by the server');
    const challenge = {};
    for (const k of ['nonce', 'statement', 'exp', 'nbf', 'resources']) if (ch[k] !== undefined) challenge[k] = ch[k];
    const result = await d.client.signIn(clientOpts({ purpose: 'server', want: ['proof'], challenge }));
    if (!result || !result.proof) throw fail('E_USER_CANCELLED', 'no proof came back');
    return result.proof;
  });

  def('identity.current', async () => (S.keys && !S.keys.destroyed ? identityOf(S.keys) : null));

  def('identity.setName', async (params) => {
    const k = needKeys();
    const p = argsOf(params, ['name']);
    const name = typeof p.name === 'string' ? p.name.normalize('NFC').trim() : '';
    if (!name || Array.from(name).length > NAME_MAX) throw fail('E_LIMIT', 'a name has 1 to 48 characters');
    const w = writer();
    if (typeof w.profile !== 'function') throw fail('E_POLICY', 'this page has no ledger open to write to');
    const block = await w.profile(name);
    markMeaningful();
    return { h: block && block.h ? block.h : null, pub: k.pub };
  });

  def('identity.backupStatus', async () => {
    const st = S.keys && S.keys.status ? S.keys.status : {};
    let legacy = Boolean(st.legacy);
    if (!legacy && d.legacy && typeof d.legacy.get === 'function') {
      try { legacy = Boolean(await d.legacy.get()); } catch (_) { legacy = false; }
    }
    return { kitSaved: Boolean(st.kitSaved), fileSaved: Boolean(st.fileSaved), passkey: Boolean(st.passkey), persisted: Boolean(st.persisted), legacy };
  });

  def('identity.openIdentity', async (params, ctx) => {
    needGesture(ctx);
    const p = argsOf(params, ['intent']);
    return d.client.openIdentity(clientOpts({ intent: p.intent }));
  });

  def('me.get', async (params, ctx) => {
    const k = needPersistent();
    const p = argsOf(params, ['field']);
    if (!S.recordGranted) {
      // First read per session: the card at the identity origin (high-risk card, R 2.3.4). The local copy is read
      // while the window opens (a promise), so window.open stays inside the click.
      needGesture(ctx);
      const blobP = loadLocalRecord().then(() => k.localBlob('me')).then((b) => b || undefined, () => undefined);
      const result = await d.client.signIn(clientOpts({ purpose: 'site', want: ['record'], record: blobP, escrow: escrow() }));
      const fromIdo = result && result.record ? result.record : null;
      const fromLedger = S.sync.on || cfg().records === 'sealed' ? await ledgerRecord().catch(() => null) : null;
      S.record = mergeRecords(S.record, fromIdo, fromLedger);
      S.recordGranted = true;
      try { await persistLocal(); } catch (_) { /* the session copy stays */ }
    }
    if (p.field !== undefined) {
      if (typeof p.field !== 'string') throw fail('E_BAD_REQUEST', 'field must be a string');
      return Object.prototype.hasOwnProperty.call(S.record.f, p.field) ? S.record.f[p.field] : null;
    }
    return JSON.parse(JSON.stringify(S.record.f));
  });

  def('me.set', async (params) => {
    needPersistent();
    const p = argsOf(params, ['field', 'value']);
    const problem = fieldProblem(p.field);
    if (problem === 'reserved') throw fail('E_FIELD', 'this field name is reserved: a record never holds contact, legal, birth, document or health data');
    if (problem) throw fail('E_BAD_REQUEST', 'a field name is a letter then up to 31 letters, digits, dot, dash or underscore');
    if (p.value === undefined) throw fail('E_BAD_REQUEST', 'a value is required (use me.del)');
    let copy;
    try { copy = JSON.parse(JSON.stringify(p.value)); } catch (_) { throw fail('E_BAD_REQUEST', 'the value must be plain JSON'); }
    await loadLocalRecord();
    const at = Math.max(now(), S.record.t + 1);
    const next = { f: Object.assign({}, S.record.f, { [p.field]: copy }), ft: Object.assign({}, S.record.ft, { [p.field]: at }), t: at };
    if (recordBytes(next).length > MAX_RECORD_BYTES) throw fail('E_LIMIT', 'the record is over ' + MAX_RECORD_BYTES + ' bytes');
    S.record = next;
    await persistLocal();
    markMeaningful();
    return syncNow();
  });

  def('me.del', async (params) => {
    needPersistent();
    const p = argsOf(params, ['field']);
    if (typeof p.field !== 'string') throw fail('E_BAD_REQUEST', 'field must be a string');
    await loadLocalRecord();
    if (!Object.prototype.hasOwnProperty.call(S.record.f, p.field)) return { stored: 'local' };
    const f = Object.assign({}, S.record.f);
    delete f[p.field];
    const at = Math.max(now(), S.record.t + 1);
    S.record = { f, ft: Object.assign({}, S.record.ft, { [p.field]: at }), t: at };
    await persistLocal();
    return syncNow();
  });

  def('me.sync', async (params, ctx) => {
    needGesture(ctx);
    needPersistent();
    const p = argsOf(params, ['on']);
    const on = p.on === true;
    if (on) {
      const pol = syncPolicy();
      if (!pol.ok) throw fail('E_POLICY', pol.reason);
      const ok = await d.prompt('consent', { card: 'syncRecord' });
      if (ok !== true) throw fail('E_USER_CANCELLED', 'cancelled');
    }
    await loadLocalRecord();
    S.sync.on = on;
    await persistSyncMeta();
    if (on) await syncNow({ force: S.sync.last === 0 });
    return { on };
  });

  def('me.erase', async (params, ctx) => {
    needGesture(ctx);
    const k = needPersistent();
    const before = k.pub;
    const result = await d.client.signIn(clientOpts({ purpose: 'site', want: ['erase'], escrow: escrow() }));
    if (!result || !result.erased || !result.bundle) throw fail('E_USER_CANCELLED', 'the identity page did not remove the keys');
    let tombstoned = 0;
    const st = state();
    if (st && st.lists && typeof st.lists.get === 'function') {
      const items = (st.lists.get(SEAL_LIST) || []).filter((it) => it && it.author === before);
      for (const it of items) {
        try { await writer().tombstone(it.h); tombstoned++; } catch (_) { /* refused: the copy stays hidden only when synced */ }
      }
    }
    try { await k.dropLocal('me'); await k.dropLocal('me-sync'); } catch (_) { /* gone */ }
    await installFrom(result);
    S.record = emptyRecord();
    S.recordLoaded = true;
    S.recordGranted = true;
    announce();
    return { tombstoned, shredded: true };
  });

  for (const n of IDENTITY_METHODS) if (!methods[n]) throw new Error('identity service: missing method ' + n);

  return {
    methods,
    on(event, fn) {
      if (IDENTITY_EVENTS.indexOf(event) < 0) throw new TypeError('unknown identity event ' + event);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    /** keys() -> the working keys, null when signed out (the chat, media and files services and api.js read them). */
    keys() {
      return S.keys && !S.keys.destroyed ? S.keys : null;
    },
    /** The same, as a property. */
    get workingKeys() {
      return S.keys && !S.keys.destroyed ? S.keys : null;
    },
    /**
     * ownerAction(card) -> boolean (v0.3 reconciliation of the sdk lane's request; R 3.3, MF-64): an owner action
     * (card.kind 'policy' | 'checkpoint' | 'withdraw' | 'delete') or "Create my page" ('create-page') confirmed on
     * the identity origin's own card, never in the page. Opens the identity window at once (call it inside the
     * person's click, like auth.signIn); the answer's key bundle replaces the working keys of the same label (a
     * create answer adds nextPubHash, the new site's nx=). true only when the identity origin confirmed the action.
     */
    async ownerAction(card) {
      if (S.destroyed) throw fail('E_POLICY', 'the identity service is closed');
      if (d.sharedHub) throw fail('E_HOST_ONLY_IDENTITY', 'this address is shared by many sites: owner actions need a site of your own');
      const kind = card && typeof card.kind === 'string' ? card.kind : 'policy';
      const extra = kind === 'create-page' ? { create: true } : { owner: { what: OWNER_ACTIONS.indexOf(kind) >= 0 ? kind : 'policy' } };
      // No await before this call: the client opens the identity window first (window.open inside the click).
      const result = await d.client.signIn(clientOpts(Object.assign({ purpose: 'site', want: ['keys'], escrow: escrow() }, extra)));
      if (!result || !result.bundle) return false;
      const K = result.bundle;
      const confirmed = kind === 'create-page' ? true : Boolean(K.owner && K.owner.confirmed === true && K.owner.what === extra.owner.what);
      await installFrom(result);
      announce();
      return confirmed;
    },
    /**
     * noteMeaningful(method): a first meaningful action of R 2.2.6 succeeded (the loader's MwApi calls it after a ledger
     * write, a message, an upload, me.set or the keep-history choice); the first one emits 'kit' while the recovery kit
     * is not saved (code review v0.3, conformance: only setName and me.set did, and nothing listened).
     */
    noteMeaningful() {
      if (S.destroyed || !S.keys) return false;
      markMeaningful();
      return true;
    },
    /** adopt(result) -> identity: installs the keys of a finished redirect round trip (client.completeRedirect). */
    async adopt(result) {
      await installFrom(result);
      announce();
      return identityOf(S.keys);
    },
    /** restore() -> true when "Stay signed in" keys were found (call once at boot, leader tab only). */
    async restore() {
      if (d.sharedHub) return false;
      const keys = await d.Keys.restore({ idb: d.idb, cryptoApi: d.cryptoApi, channelFactory: d.channelFactory, now });
      if (!keys) return false;
      setKeys(keys);
      announce();
      return true;
    },
    /** follow(identity): a follower tab mirrors the leader's public state (it never holds keys). */
    follow(identity) {
      S.follower = true;
      emit('auth', { state: identity ? 'signed-in' : 'guest', identity: identity || null, role: identity ? roleFor(identity.pub) : 'reader' });
    },
    async destroy() {
      S.destroyed = true;
      if (S.unsubscribeFollower) S.unsubscribeFollower();
      listeners.clear();
    },
  };
}

/** isSignedInIdentity(x) -> true for the { pub, short, name, mode } shape identity.current returns. */
export function isSignedInIdentity(x) {
  return Boolean(x && isPublicKeyString(x.pub) && typeof x.mode === 'string');
}
