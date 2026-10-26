// src/idp/idp.js: the identity origin (IdO), a static top-level-window app (R 2.1 to 2.3, 2.12, 2.15; N-1, N-2;
// MF-02, MF-03, MF-05 to MF-14, MF-17, MF-19, MF-20; ARCHITECTURE 15.1 to 15.3; INTERFACES v0.3 src/idp/*).
//
// The root and the vault live only here. A site gets the working keys of one label in an ECIES bundle encrypted
// to its page key and posted only to the origin the browser reports:
//   popup:    on load post { v: 1, t: 'mw-idp-ready' } to window.opener; accept a request only when
//             event.source === window.opener; the requester is event.origin (never page text); answer with
//             postMessage(targetOrigin = that origin), then close.
//   redirect: IdO/signin#<request> carries origin and ret; ret must be exactly origin + '/_mw/idp-return' (the
//             answer goes to the origin being signed for and nowhere else); location.replace(ret#<answer>).
//
//   createIdp(env) -> { handleRequest(req, origin, channel), verifyPointerFor(text, origin, state), bootSignin(),
//                       bootHome(), unlock(...), runRestore(), runLinkNew(), runLinkOld(), ... }
//   env: { win, doc, navigator, crypto, indexedDB, location, cards, passkey, store, now, build, wasm, ios,
//          standalone, verifyPointer, locks, hubSuffixes, sharedOrigins, setTimeout, clearTimeout } (globals by
//          default; tests inject every one)
//
// Code review v0.3 (security 1, 2, 7 to 10, 19, 20; correctness 3; browser):
//   - Several windows of this origin may be open (a Settings window, a sign-in popup): every change to the vault or
//     the state record happens inside the Web Lock 'mw-idp-vault' and builds on the newest stored copy, re-read
//     inside the lock; the vault carries a version counter (vault.js). Nothing is cached across a save.
//   - Every vault copy a request carries (the site's escrow) is merged into this origin's own (Vault.mergeFrom) on
//     every sign-in, so labels made after an older copy keep their random keys and retired keys stay retired.
//   - Only the passkey (PRF) blob is escrowed to sites; a passphrase blob never leaves this origin.
//   - A private record from a site is capped (RECORD_MAX_BYTES per origin, VAULT_MAX_BYTES for the vault).
//   - The ledger label needs an unexpired pointer; the seq floor lives in the vault too (it travels in escrow
//     copies and backup files). The hub label exists only for the build's single-operator hub suffixes (psl.js);
//     a shared-origin hub is the build's decision, never the page's.
//   - MF-09: the wrapped record and the PRF salt are read before the card is drawn, so the press handler's first
//     await is the credentials call; a passkey call the browser refuses at once (no gesture left) gets one
//     "Tap to finish" card whose press makes the call again; Safari's PRF assertion after create() gets the same.
//   - The passphrase is stretched in slices that let the page paint (argon2idAsync), after the busy card painted.
//   - The backup file is saved by the person's own press and counted as saved only when they say so.
//   - "Replace my keys on all sites" keeps the key of a label that made or owns a page (a page cannot move to a new
//     key yet: no owner hand-over is written), and says so on its card.
//
// Pure enough for Node: nothing runs at import unless the page is the IdO page (<html data-mw-idp>).

import {
  validateRequest, seal, open, isOrigin, returnUrlOk, decodeFragment, encodeFragment, openLocal,
  BUNDLE_PREFIX, RECORD_PREFIX, LEGACY_PREFIX, PROTOCOL_VERSION, POPUP_NAME,
} from '../identity/client.js';
import {
  labelFor, deriveLabel, rootStar, newRoot, rootToPhrase, phraseToRoot, checkCode, importScalar, publicKeyOf,
  signScalar, labelSeed, scalarToJwk, recoverScalar, scalar, normalizeOrigin,
} from '../identity/derive.js';
import { wrapWithPrf, unwrapWithPrf, wrapWithPassphrase, unwrapWithPassphrase, packSecrets, unpackSecrets, describeKdf } from '../identity/wrap.js';
import { Vault, makeBackupFile, openBackupFile, generatePassphrase, passphraseStrength } from '../identity/vault.js';
import { buildChallenge, signChallenge, KEY_MODES } from '../identity/signin.js';
import { parsePointer, verifyPointer, ledgerIdFor, verifyRotation, nextKeyCommitment, hubLabelFor } from '../common/pointer.js';
import { sign as ecdsaSign, sha256 } from '../chain/crypto.js';
import { b64url, utf8 } from '../chain/canonical.js';
import { createPsl, hubShapeOf, isSharedOrigin, HUB_SUFFIXES, HUB_TEMPLATES, SHARED_ORIGINS, PSL_TEST_RULES, hubSuffixOf as defaultHubSuffixOf, isHubSuffix as defaultIsHubSuffix } from './psl.js';
import * as passkeyModule from './passkey.js';
import { openIdoStore, acceptEscrow, vaultIdOf, escrowIdOf } from './store.js';
import { createCards, sameIdentityOptions, recordSameOffer, approvalAllowed, kitDue, reentryPositions, shortId } from './cards.js';
import { LinkNewDevice, LinkOldDevice } from './link.js';
import { decode as qrDecode } from './qr.js';
import { t } from './strings.js';

export const IDP_VERSION = '0.3.0';
export const ROUND_TIMEOUT_MS = 30000;
export const RESTORE_CHECKS = 3;
/** The Web Lock every vault and state change of this origin runs under (code review v0.3, correctness 3). */
export const VAULT_LOCK = 'mw-idp-vault';
/** A passkey call refused faster than this showed no prompt: the browser wanted a fresh press (MF-09). */
export const FAST_REFUSAL_MS = 1000;
/** A backup file's download URL stays valid at least this long (iOS asks before it reads it). */
export const BACKUP_URL_MS = 60000;
export const BACKUP_FILE_NAME = 'magnet-web-identity-backup.json';

const idpError = (code, message) => Object.assign(new Error(message || code), { code });
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/**
 * wasmAvailable() -> true when WebAssembly can compile here. Under the IdO's CSP that needs
 * 'wasm-unsafe-eval' (Safari below 16 lacks it): then passphrases use PBKDF2 and the card says so (MF-17).
 */
export function wasmAvailable(g = globalThis) {
  try {
    const W = g.WebAssembly;
    if (!W || typeof W.Module !== 'function') return false;
    // The smallest valid module (magic and version only).
    new W.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])); // eslint-disable-line no-new
    return true;
  } catch (_) {
    return false;
  }
}

/** chooseKdf(wasm) -> 'argon2id' where WebAssembly runs, 'pbkdf2' otherwise (named on the card). */
export function chooseKdf(wasm) {
  return wasm ? 'argon2id' : 'pbkdf2';
}

function isIos(nav) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  return /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
}

function isStandalone(win, nav) {
  try {
    if (nav && nav.standalone === true) return true;
    return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches);
  } catch (_) {
    return false;
  }
}

/**
 * readBuild(doc) -> { version, id, hash, test, hubs, shared } from <meta name="mw-idp-build" content="version id sha256">; hubs and
 * shared are the build's MW_HUB_SUFFIXES (with a test build's suffixes) and MW_SHARED_ORIGINS (tools/build-idp.mjs --hub-suffix,
 * --shared-origin).
 */
export function readBuild(doc) {
  const out = { version: IDP_VERSION, id: 'dev', hash: '', test: PSL_TEST_RULES.length > 0, hubs: HUB_SUFFIXES.slice(), shared: SHARED_ORIGINS.slice() };
  try {
    const meta = doc && typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="mw-idp-build"]') : null;
    const parts = meta ? String(meta.getAttribute('content') || '').trim().split(/\s+/) : [];
    if (parts[0] && /^\d+\.\d+\.\d+$/.test(parts[0])) out.version = parts[0];
    if (parts[1] && /^[0-9a-z-]{4,64}$/.test(parts[1])) out.id = parts[1];
    if (parts[2] && /^[0-9a-f]{64}$/.test(parts[2])) out.hash = parts[2];
  } catch (_) {
    // dev page without the meta
  }
  return out;
}

function buildTag(build) {
  return (build.version + '-' + build.id).replace(/[^\x21-\x7e]/g, '').slice(0, 64) || 'dev';
}

/**
 * siteCode(code) -> the code a site sees (R 2.11.2): the IdO's own reasons (a wrong passphrase, a missing UV
 * flag, a broken link code) stay on its card; the site learns only that the sign-in did not happen.
 */
export function siteCode(code) {
  if (['E_USER_CANCELLED', 'E_HOST_ONLY_IDENTITY', 'E_UNSUPPORTED', 'E_NONCE_REQUIRED', 'E_BAD_REQUEST'].indexOf(code) >= 0) return code;
  if (code === 'E_STATEMENT' || code === 'E_CHALLENGE') return 'E_BAD_REQUEST';
  if (code === 'E_INTERNAL' || code === 'E_STORAGE') return 'E_IDP_UNREACHABLE';
  return 'E_USER_CANCELLED';
}

function sameBlob(a, b) {
  return Boolean(a && b && a.ct === b.ct && a.iv === b.iv);
}

// One-window fallback where Web Locks are missing (a test without navigator.locks): calls run one after another.
let fallbackChain = Promise.resolve();
function fallbackExclusive(fn) {
  const run = fallbackChain.then(() => fn(), () => fn());
  fallbackChain = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------------------------
// Pointer check for the ledger label (R 2.2.3, MF-04)
// ---------------------------------------------------------------------------------------------

/**
 * verifyPointerFor(text, origin, { now, state, floors, scope }) -> { ok, ledgerId, owner, lo, rotVerified, host, org,
 *   seq, ownHubAddress } | { ok: false, reason }
 * The pointer must verify for some scope: the scope the loader names (a mirror shows a pointer published under
 * another name), the origin's own hostname (a site at its domain), btih:<infohash> (a link-carried pointer) or the
 * hostname of one of its org= origins. A scope hint cannot widen anything: the signature must verify for it, and
 * the origin must still be that scope's host or listed in org=. host is the pointer's own host (null for
 * a btih scope), so only org= can list a hub or a mirror. An expired record gives no ledger label (code review
 * v0.3, security 10: an origin once listed in org=, say a lapsed and re-registered mirror domain, could replay it
 * for ever): the origin label instead. A seq below the highest one this IdO accepted for that ledger (state.seqFloors
 * or the vault's floors) is refused. One-step rot= lineage is checked here (lo signed the rotation to owner); longer
 * chains get the origin label. ownHubAddress: the origin is `<hubLabelFor(record, ledgerId)>.<suffix>`, the
 * address derived from this very pointer (a personal site on a hub), which no look-alike can have.
 */
export async function verifyPointerFor(text, origin, { now = Date.now(), state = null, floors = null, scope: hint = null } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let parsed;
  try {
    parsed = parsePointer(text);
  } catch (_) {
    return fail('parse');
  }
  if (!parsed || !parsed.ok || !parsed.record || !parsed.record.signed) return fail('unsigned');
  const record = parsed.record;
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch (_) {
    return fail('origin');
  }
  const scopes = [hostname, 'btih:' + record.btih];
  if (typeof hint === 'string' && hint && scopes.indexOf(hint) < 0) scopes.unshift(hint);
  for (const o of Array.isArray(record.org) ? record.org : []) {
    try {
      const h = new URL(o).hostname;
      if (scopes.indexOf(h) < 0) scopes.push(h);
    } catch (_) {
      // not an origin
    }
  }
  let expired = false;
  for (const scope of scopes) {
    let v;
    try {
      v = await verifyPointer(record, scope, { now });
    } catch (_) {
      continue;
    }
    if (v && v.expired) expired = true;
    if (!v || !v.ok || v.withdrawn) continue;
    const ledgerId = await ledgerIdFor(record, scope);
    const f1 = state && state.seqFloors ? state.seqFloors[ledgerId] : undefined;
    const f2 = floors && typeof floors === 'object' ? floors[ledgerId] : undefined;
    const floor = Math.max(Number.isSafeInteger(f1) ? f1 : -1, Number.isSafeInteger(f2) ? f2 : -1);
    if (floor >= 0 && record.seq < floor) return fail('rollback');
    const lo = typeof record.lo === 'string' && record.lo ? record.lo : null;
    let rotVerified = false;
    if (lo && lo !== record.owner) {
      try { rotVerified = await verifyRotation(record, lo, scope); } catch (_) { rotVerified = false; }
    }
    let ownHubAddress = false;
    const shape = hubShapeOf(hostname);
    if (shape) {
      try { ownHubAddress = hubLabelFor(record, ledgerId) === shape.label; } catch (_) { ownHubAddress = false; }
    }
    const btih = typeof record.btih === 'string' ? record.btih.toLowerCase() : null;
    return { ok: true, ledgerId, owner: record.owner, lo, rotVerified, host: scope.startsWith('btih:') ? null : scope, org: record.org || [], seq: record.seq, ownHubAddress, btih };
  }
  return fail(expired ? 'expired' : 'unverified');
}

// ---------------------------------------------------------------------------------------------
// The IdO
// ---------------------------------------------------------------------------------------------

export function createIdp(envIn = {}) {
  const win = envIn.win !== undefined ? envIn.win : (typeof window !== 'undefined' ? window : null);
  const doc = envIn.doc !== undefined ? envIn.doc : (win ? win.document : null);
  const nav = envIn.navigator !== undefined ? envIn.navigator : (win ? win.navigator : null);
  const loc = envIn.location !== undefined ? envIn.location : (win ? win.location : null);
  const now = envIn.now || (() => Date.now());
  const build = envIn.build || readBuild(doc);
  const wasm = envIn.wasm !== undefined ? envIn.wasm : wasmAvailable();
  const ios = envIn.ios !== undefined ? envIn.ios : isIos(nav);
  const standalone = envIn.standalone !== undefined ? envIn.standalone : isStandalone(win, nav);
  const passkey = envIn.passkey || passkeyModule;
  const passkeyEnv = envIn.passkeyEnv || (win ? { navigator: nav, PublicKeyCredential: win.PublicKeyCredential, crypto: globalThis.crypto, location: loc } : undefined);
  const idpOrigin = envIn.idpOrigin || (loc ? loc.origin : 'https://idp.invalid');
  const setT = envIn.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  // The Web Lock of this origin: shared by every window and tab of the identity page (and by every createIdp in a
  // test process, which stands in for several windows). env.locks: null forces the one-window fallback.
  const locks = envIn.locks !== undefined ? envIn.locks : ((nav && nav.locks) || (globalThis.navigator && globalThis.navigator.locks) || null);
  const hubPsl = Array.isArray(envIn.hubSuffixes) ? createPsl({ extra: PSL_TEST_RULES.concat(envIn.hubSuffixes), hubs: HUB_SUFFIXES.concat(envIn.hubSuffixes) }) : null;
  const hubSuffixOf = hubPsl ? hubPsl.hubSuffixOf : defaultHubSuffixOf;
  const isHubSuffix = hubPsl ? hubPsl.isHubSuffix : defaultIsHubSuffix;
  const sharedOrigins = (Array.isArray(envIn.sharedOrigins) ? envIn.sharedOrigins : []).concat(SHARED_ORIGINS);
  // Review round PHISH-1, HUB-3: the hub templates of this build (psl.js HUB_TEMPLATES; tests inject env.hubTemplates).
  const hubTemplates = (Array.isArray(envIn.hubTemplates) ? envIn.hubTemplates : HUB_TEMPLATES).map((b) => String(b).toLowerCase());
  let cards = envIn.cards || null;
  let store = envIn.store || null;
  // prf: the passkey's PRF output while this window is unlocked with it (review round SEC-1, STALK-1, PHISH-2): every site's
  // root escrow copy is wrapped again under it with a fresh IV, never the stored blob, so no two sites hold the same bytes.
  const session = { secrets: null, vault: null, method: null, credId: null, wrappedRec: null, visitOnly: false, uv: false, vaultBlob: null, prf: null };
  let saltBytes = null;

  function ui() {
    if (!cards) cards = createCards({ doc, win, build, now, idp: idpOrigin });
    return cards;
  }

  async function getStore(memory = false) {
    if (memory) return openIdoStore({ memory: true });
    if (!store) store = await openIdoStore({ indexedDB: envIn.indexedDB !== undefined ? envIn.indexedDB : (win ? win.indexedDB : undefined) });
    return store;
  }

  /** saltReady(): the PRF salt, computed before any card the person presses for a passkey (MF-09). */
  async function saltReady() {
    if (saltBytes) return saltBytes;
    try {
      saltBytes = typeof passkey.prfSalt === 'function' ? await passkey.prfSalt(globalThis.crypto) : await passkeyModule.prfSalt(globalThis.crypto);
    } catch (_) {
      saltBytes = null; // passkey.js computes it itself
    }
    return saltBytes;
  }

  /** paint(): one frame after the busy card, so it is on screen before the passphrase stretching starts. */
  function paint() {
    return new Promise((resolve) => {
      const later = () => setT(resolve, 0);
      try {
        if (win && typeof win.requestAnimationFrame === 'function') { win.requestAnimationFrame(later); return; }
      } catch (_) {
        // no frames: a task is enough
      }
      later();
    });
  }

  function progress(f) {
    try { if (typeof ui().progress === 'function') ui().progress(f); } catch (_) { /* a card without a line */ }
  }

  // -------------------------------------------------------------------------------------------
  // Exclusive changes (code review v0.3, correctness 3)
  // -------------------------------------------------------------------------------------------

  function exclusive(fn) {
    if (locks && typeof locks.request === 'function') return locks.request(VAULT_LOCK, { mode: 'exclusive' }, () => fn());
    return fallbackExclusive(fn);
  }

  function dropSession() {
    Object.assign(session, { secrets: null, vault: null, method: null, credId: null, wrappedRec: null, visitOnly: false, uv: false, vaultBlob: null, prf: null });
  }

  /**
   * commit(fn(vault, state, store)) -> fn's result: one change to the vault and the state record, under the lock, on
   * the newest stored copies (another window may have saved since this one unlocked); the version moves on and both
   * are saved before the lock is released. Refuses when the identity on this device changed in another window
   * (removed, restored or linked anew): the session is dropped and the person unlocks again.
   */
  async function commit(fn) {
    if (!session.secrets) throw idpError('E_INTERNAL', 'not unlocked');
    const st = session.store || await getStore();
    return exclusive(async () => {
      let vault = session.vault || new Vault();
      const state = await st.getState();
      if (!session.visitOnly) {
        const w = await st.getWrapped();
        if (!w || !sameBlob(w.blob, session.wrappedRec && session.wrappedRec.blob)) {
          dropSession();
          throw idpError('E_USER_CANCELLED', 'the identity on this device changed in another window');
        }
        const blob = await st.getVault();
        if (blob) {
          try {
            vault = await Vault.open(session.secrets.kVault, blob);
          } catch (_) {
            // a copy this key cannot open: this window's stays
          }
        }
      }
      const out = await fn(vault, state, st);
      vault.bump();
      if (!session.visitOnly) {
        const blob = await vault.toBlob(session.secrets.kVault, { id: await vaultIdOf(session.secrets.rootStar) });
        await st.setVault(blob);
        session.vaultBlob = blob;
      }
      await st.setState(state);
      session.vault = vault;
      return out;
    });
  }

  /** updateState(fn(state)) -> fn's result: the state record changed under the lock, on the stored copy. */
  async function updateState(fn, { memory = false } = {}) {
    const st = memory && session.store ? session.store : await getStore();
    return exclusive(async () => {
      const state = await st.getState();
      const out = fn(state);
      await st.setState(state);
      return out;
    });
  }

  /** freshVault() -> the newest stored vault (another window may have saved since this one unlocked). */
  async function freshVault() {
    if (!session.secrets) throw idpError('E_INTERNAL', 'not unlocked');
    if (session.visitOnly) return session.vault;
    const st = session.store || await getStore();
    return exclusive(async () => {
      const blob = await st.getVault();
      if (!blob) return session.vault;
      try {
        session.vault = await Vault.open(session.secrets.kVault, blob);
        session.vaultBlob = blob;
      } catch (_) {
        // keep this window's copy
      }
      return session.vault;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Passkey calls (MF-09)
  // -------------------------------------------------------------------------------------------

  /**
   * passkeyCall(fn) -> fn's result. A refusal faster than FAST_REFUSAL_MS showed no prompt: the browser wanted a
   * press of its own (WebKit after any delay, or a call outside a gesture). One "Tap to finish" card makes the call
   * again inside its press; a second fast refusal is E_PASSKEY_REFUSED (the caller may fall back to a passphrase).
   */
  async function passkeyCall(fn) {
    for (let tries = 0; ; tries++) {
      const t0 = now();
      try {
        return await fn();
      } catch (err) {
        const fast = now() - t0 < FAST_REFUSAL_MS;
        if (!(err && err.code === 'E_USER_CANCELLED' && fast)) throw err;
        if (tries > 0) throw idpError('E_PASSKEY_REFUSED', 'the browser refused the passkey call twice without a prompt');
        const go = await ui().tapToFinish({});
        if (go !== true) throw idpError('E_USER_CANCELLED');
      }
    }
  }

  /** makePasskey(nickname) -> { method: 'passkey', created } or { method: 'passphrase' } where passkeys fail here. */
  async function makePasskey(nickname) {
    try {
      const created = await passkeyCall(() => passkey.create({ nickname, env: passkeyEnv, salt: saltBytes }));
      return { method: 'passkey', created };
    } catch (err) {
      if (err && (err.code === 'E_UNSUPPORTED' || err.code === 'E_PASSKEY_REFUSED')) {
        // In-app browsers, an identity page on an IP address, a refusal: the passphrase card in this same window (R 2.13).
        await ui().message({ text: t('noPrf', null, ui().lang) });
        return { method: 'passphrase', created: null };
      }
      throw err;
    }
  }

  /** prfOf(created) -> { prf, uv }: create()'s PRF output, or one assertion inside a press (Safari 18). */
  async function prfOf(c) {
    if (c.prf) return { prf: c.prf, uv: c.uv !== false };
    if (c.prfEnabled !== true) return { prf: null, uv: c.uv !== false };
    const go = await ui().tapToFinish({ step: 'enrol' });
    if (go !== true) throw idpError('E_USER_CANCELLED');
    try {
      const got = await passkeyCall(() => passkey.get({ credId: c.credId, env: passkeyEnv, salt: saltBytes }));
      return { prf: got.prf, uv: got.uv !== false };
    } catch (err) {
      if (err && (err.code === 'E_UNSUPPORTED' || err.code === 'E_PASSKEY_REFUSED')) return { prf: null, uv: true };
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Unlock, create, restore
  // -------------------------------------------------------------------------------------------

  async function protect(secrets, { method, nickname, created = null } = {}) {
    // Wraps root* and K_vault for this device; returns { method, credId, rec, uv } (rec is saved by adoptNew).
    const packed = packSecrets(secrets);
    if (method === 'passkey') {
      let c = created;
      if (!c) {
        const made = await makePasskey(nickname);
        c = made.created;
        if (made.method !== 'passkey') method = 'passphrase';
      }
      if (c) {
        const got = await prfOf(c);
        if (got.prf) {
          const blob = await wrapWithPrf(got.prf, packed, { credId: c.credId });
          // Self-test with the same PRF output (no second prompt): the blob must open again.
          const back = await unwrapWithPrf(got.prf, blob);
          if (b64url.encode(back) !== b64url.encode(packed)) throw idpError('E_INTERNAL', 'the passkey self-test failed');
          return { method: 'passkey', credId: c.credId, rec: { blob, method: 'passkey', credId: c.credId, t: now() }, uv: got.uv !== false, prf: got.prf };
        }
        await ui().message({ text: t('noPrf', null, ui().lang) + ' ' + t('passkeyCleanup', null, ui().lang) });
        method = 'passphrase';
      }
    }
    if (method === 'passphrase') {
      const kdf = chooseKdf(wasm);
      let error = null;
      for (;;) {
        const pass = await ui().passphrase({ mode: 'create', kdf: kdf === 'pbkdf2' ? 'pbkdf2-sha256' : 'argon2id', error });
        if (pass === null) throw idpError('E_USER_CANCELLED');
        if (!passphraseStrength(pass).ok) { error = t('passphraseWeak', null, ui().lang); continue; }
        ui().busy();
        await paint();
        const blob = await wrapWithPassphrase(pass, packed, { kdf, onProgress: progress });
        return { method: 'passphrase', credId: null, rec: { blob, method: 'passphrase', t: now() }, uv: true };
      }
    }
    return { method: 'visit', credId: null, rec: null, uv: true };
  }

  async function adoptNew({ root, rootStarBytes, kVault, vault, method, nickname, created, fresh = false }) {
    // A new, restored or linked identity on this device: keep the vault (with the root inside, for the phrase).
    const secrets = { rootStar: rootStarBytes, kVault };
    if (root) vault.data.root = b64url.encode(root);
    const p = await protect(secrets, { method, nickname, created });
    const st = p.method === 'visit' ? await getStore(true) : await getStore();
    const id = await vaultIdOf(rootStarBytes);
    const code = await checkCode(rootStarBytes);
    let blob = null;
    const write = async () => {
      if (fresh && p.method !== 'visit' && await st.getWrapped()) throw idpError('E_INTERNAL', 'another window made an identity on this device meanwhile: sign in again');
      if (p.rec) await st.setWrapped(p.rec);
      const state = await st.getState();
      state.created = state.created || now();
      state.checkCode = code;
      await st.setState(state);
      if (p.method !== 'visit') {
        vault.bump();
        blob = await vault.toBlob(kVault, { id });
        await st.setVault(blob);
      }
    };
    if (p.method === 'visit') await write();
    else await exclusive(write);
    Object.assign(session, { secrets, vault, method: p.method, credId: p.credId, wrappedRec: p.rec, visitOnly: p.method === 'visit', uv: p.uv, store: st, vaultBlob: blob, prf: p.prf || null });
    return session;
  }

  /**
   * escrowFor(origin) -> { root, vault } for one site (review round SEC-1, STALK-1, PHISH-2): the root copy wrapped again under
   * the PRF output with a fresh IV and no credId (the unlock from it is a discoverable passkey call), the vault copy encrypted
   * again with a fresh IV, padded to its size bucket and named escrowIdOf(root*, origin). Nothing in it is the same for two
   * origins. No root copy without the PRF output in this window (a passphrase identity never has one: security 2).
   */
  async function escrowFor(origin) {
    if (!session.secrets || session.visitOnly) return { root: null, vault: null };
    let root = null;
    if (session.method === 'passkey' && session.prf) root = await wrapWithPrf(session.prf, packSecrets(session.secrets));
    const vault = session.vault ? await session.vault.toBlob(session.secrets.kVault, { id: await escrowIdOf(session.secrets.rootStar, origin), pad: true }) : null;
    return { root, vault };
  }

  async function createIdentity() {
    let caps = { prf: null, webauthn: false };
    try { caps = await passkey.capabilities(passkeyEnv); } catch (_) { /* unknown */ }
    await saltReady();
    const choice = await ui().chooseUnlock({ prf: caps.webauthn ? caps.prf : false, wasm, extra: true });
    if (!choice) throw idpError('E_USER_CANCELLED');
    // MF-09: the passkey is made in the press that chose it; the root and its derivations come after.
    let method = choice.method;
    let created = null;
    if (method === 'passkey') {
      const made = await makePasskey(choice.nickname);
      method = made.method;
      created = made.created;
    }
    const root = newRoot();
    // Review round STALK-5: the optional extra word, chosen here at creation; without it the 12 words alone rebuild every key.
    const extra = typeof choice.extra === 'string' && choice.extra ? choice.extra : undefined;
    if (extra) { ui().busy(); await paint(); }
    const rs = await rootStar(root, extra);
    const { vault, kVault } = Vault.create();
    return adoptNew({ root, rootStarBytes: rs, kVault, vault, method, nickname: choice.nickname, created, fresh: true });
  }

  /**
   * unlock({ escrow, allowCreate, pre }) -> session (secrets, vault, method, uv). Asks the person once (passkey or
   * passphrase). pre: { own } read before the card was drawn, so nothing awaits storage between the press and the
   * credentials call (MF-09). With no wrapped record here, the escrow's passkey blob is taken back (a passphrase
   * blob never is: security 2); the escrow's vault copy is merged by the sign-in that carried it.
   */
  async function unlock({ escrow = null, allowCreate = true, pre = null } = {}) {
    if (session.secrets) return session;
    const st = await getStore();
    let rec = pre && pre.own !== undefined ? pre.own : await st.getWrapped();
    let fromEscrow = false;
    if (!rec && escrow) {
      const e = acceptEscrow(escrow);
      if (e.root) {
        rec = { blob: e.root, method: 'passkey', credId: e.root.credId };
        fromEscrow = true;
      }
    }
    if (!rec) {
      if (!allowCreate) throw idpError('E_USER_CANCELLED', 'no identity on this device');
      return createIdentity();
    }
    let packed;
    let uv = true;
    let prf = null;
    if (rec.method === 'passkey') {
      if (!saltBytes) await saltReady();
      const got = await passkeyCall(() => passkey.get({ credId: rec.credId || rec.blob.credId, env: passkeyEnv, salt: saltBytes }));
      if (!got.prf) throw idpError('E_UNSUPPORTED', 'this passkey gave no PRF output');
      packed = await unwrapWithPrf(got.prf, rec.blob);
      uv = got.uv !== false;
      prf = got.prf;
    } else {
      let error = null;
      for (let attempt = 0; ; attempt++) {
        const pass = await ui().passphrase({ mode: 'unlock', kdf: describeKdf(rec.blob) || 'argon2id', error });
        if (pass === null) throw idpError('E_USER_CANCELLED');
        ui().busy();
        await paint();
        try {
          packed = await unwrapWithPassphrase(pass, rec.blob, { onProgress: progress });
          break;
        } catch (err) {
          if (err && err.code === 'E_UNWRAP' && attempt < 9) { error = t('passphraseWrong', null, ui().lang); continue; }
          throw err;
        }
      }
    }
    const secrets = unpackSecrets(packed);
    const id = await vaultIdOf(secrets.rootStar);
    const vault = await exclusive(async () => {
      if (fromEscrow) {
        // This origin had lost its copy: the site's passkey blob is ours again (it opened, so it is ours). Another
        // window may have taken one back meanwhile: then that one stays.
        const own = await st.getWrapped();
        if (own) {
          // Every site's copy has its own bytes now (escrowFor): another window may have taken back a different copy of this
          // same identity, which the same PRF output opens to the same secrets.
          let same = sameBlob(own.blob, rec.blob);
          if (!same && prf && own.method === 'passkey') {
            try { same = b64url.encode(await unwrapWithPrf(prf, own.blob)) === b64url.encode(packed); } catch (_) { same = false; }
          }
          if (!same) throw idpError('E_USER_CANCELLED', 'another identity was made on this device meanwhile');
          rec = own;
        } else {
          rec = Object.assign({ t: now() }, rec);
          await st.setWrapped(rec);
        }
      }
      const blob = await st.getVault();
      if (!blob) return new Vault();
      if (blob.id !== undefined && blob.id !== id) {
        if (fromEscrow) return new Vault(); // a stale copy of another identity: the escrow's copy is merged next
        throw idpError('E_UNWRAP', 'the vault belongs to another identity');
      }
      return Vault.open(secrets.kVault, blob);
    });
    Object.assign(session, { secrets, vault, method: rec.method, credId: rec.credId || null, wrappedRec: rec, visitOnly: false, uv, store: st, vaultBlob: null, prf });
    return session;
  }

  /** openEscrowVault(escrow, secrets) -> the site's vault copy (authenticated by K_vault), or null. */
  async function openEscrowVault(escrow, secrets) {
    if (!escrow || !secrets) return null;
    const e = acceptEscrow(escrow);
    if (!e.vault) return null;
    try {
      // A site's copy carries its own id (escrowIdOf), so the copy is recognised by opening it: K_vault authenticates it.
      return await Vault.open(secrets.kVault, e.vault);
    } catch (_) {
      return null; // a copy made under another K_vault (before a phrase restore), or a changed one: not ours
    }
  }

  /** phraseError(err, words) -> the restore card's line for a refused phrase (review round UX-4: which word, how many). */
  function phraseError(err, words) {
    const lang = ui().lang;
    if (err && err.code === 'E_PHRASE_WORD' && Number.isInteger(err.index)) return t('phraseBadWord', { n: err.index + 1 }, lang);
    if (err && err.code === 'E_PHRASE_LENGTH') {
      let k = 0;
      try { k = String(words || '').split(/\s+/).filter((w) => /[a-z]/i.test(w)).length; } catch (_) { k = 0; }
      return t('phraseBadLength', { k }, lang);
    }
    return t('phraseBad', null, lang);
  }

  /**
   * runRestore() -> session: the 12 words (and extra word) or a backup file, then a new unlock method here.
   * Review round SEC-3, PHISH-4: on a device that already has an identity the person first says so on a card that names its
   * check code and unlocks it (a page that sends someone to #restore cannot replace their identity without that); the
   * same identity restored again changes nothing (its vault, chat and record keys stay); another one is adopted only
   * after its check code is shown next to the one it replaces. A file restore shows the file identity's check code too.
   */
  async function runRestore() {
    const st0 = await getStore();
    const existing = await st0.getWrapped();
    let replaces = null;
    let currentId = null;
    if (existing) {
      const state0 = await st0.getState();
      const yes = await ui().replaceIdentity({ code: state0.checkCode || null });
      if (yes !== true) throw idpError('E_USER_CANCELLED');
      const cur = await unlock({ allowCreate: false, pre: { own: existing } });
      replaces = state0.checkCode || await checkCode(cur.secrets.rootStar);
      currentId = await vaultIdOf(cur.secrets.rootStar);
    }
    const sameAsCurrent = async (rs) => Boolean(currentId) && (await vaultIdOf(rs)) === currentId;
    const keepCurrent = async () => {
      await ui().message({ text: t('sameIdentityAlready', null, ui().lang) });
      return session;
    };
    let error = null;
    let typed = '';
    for (;;) {
      const r = await ui().restore({ error, words: typed, replaces });
      if (!r) throw idpError('E_USER_CANCELLED');
      if (r.kind === 'phrase') {
        typed = String(r.words || '');
        let root;
        try {
          root = phraseToRoot(r.words);
        } catch (err) {
          error = phraseError(err, r.words);
          continue;
        }
        ui().busy();
        await paint();
        const rs = await rootStar(root, r.extra || undefined);
        if (await sameAsCurrent(rs)) return keepCurrent();
        const ok = await ui().checkCode({ code: await checkCode(rs), replaces });
        if (!ok) { error = t('phraseCodeNo', null, ui().lang); continue; }
        const { vault, kVault } = Vault.create();
        await saltReady();
        const choice = await ui().chooseUnlock({ prf: null, wasm });
        if (!choice) throw idpError('E_USER_CANCELLED');
        const s = await adoptNew({ root, rootStarBytes: rs, kVault, vault, method: choice.method, nickname: choice.nickname, fresh: !existing });
        await updateState((state) => {
          if (existing && !s.visitOnly) forgetSites(state);
          state.restored = { t: now(), left: RESTORE_CHECKS };
        }, { memory: s.visitOnly });
        return s;
      }
      let opened;
      try {
        ui().busy();
        await paint();
        opened = await openBackupFile(r.text, r.pass, { onProgress: progress });
      } catch (_) {
        error = t('fileBad', null, ui().lang);
        continue;
      }
      if (await sameAsCurrent(opened.rootStar)) return keepCurrent();
      const okFile = await ui().checkCode({ code: await checkCode(opened.rootStar), replaces });
      if (!okFile) { error = null; continue; }
      await saltReady();
      const choice = await ui().chooseUnlock({ prf: null, wasm });
      if (!choice) throw idpError('E_USER_CANCELLED');
      const root = opened.vault.data.root ? b64url.decode(opened.vault.data.root) : null;
      const s = await adoptNew({ root, rootStarBytes: opened.rootStar, kVault: opened.kVault, vault: opened.vault, method: choice.method, nickname: choice.nickname, fresh: !existing });
      await updateState((state) => {
        if (existing && !s.visitOnly) forgetSites(state);
        state.backup = Object.assign({}, state.backup, { fileSaved: true });
      }, { memory: s.visitOnly });
      return s;
    }
  }

  /** forgetSites(state): the display cache of an identity this device no longer has (another one replaced it). */
  function forgetSites(state) {
    state.origins = {};
    state.same = {};
    state.hubs = {};
    state.backup = { kitSaved: false, fileSaved: false };
  }

  // -------------------------------------------------------------------------------------------
  // Device link (R 2.3.8)
  // -------------------------------------------------------------------------------------------

  async function scanDecode(imageData, canvas) {
    const BD = win && win.BarcodeDetector;
    if (BD && canvas) {
      try {
        const det = new BD({ formats: ['qr_code'] });
        const codes = await det.detect(canvas);
        if (codes && codes[0] && codes[0].rawValue) return codes[0].rawValue;
      } catch (_) {
        // fall through to the bundled decoder
      }
    }
    const r = qrDecode(imageData);
    return r ? r.text : null;
  }

  /** runLinkNew() -> session: this device (B) receives an identity from another device's IdO. */
  async function runLinkNew() {
    const L = (k, p) => t(k, p, ui().lang);
    const b = new LinkNewDevice({ now });
    const qr1 = await b.open();
    const go = await ui().showCodes({ title: L('linkTitle'), lines: [L('linkInPerson'), L('linkShowCode')], codes: [qr1], buttons: [{ text: L('cont'), value: true, primary: true }, { text: L('cancel'), value: false }] });
    if (!go) throw idpError('E_USER_CANCELLED');
    const qr2 = await ui().scanCode({ title: L('linkTitle'), lines: [L('linkScanCode')], decode: scanDecode });
    if (!qr2) throw idpError('E_USER_CANCELLED');
    const { reveal, sas } = await b.acceptA(qr2);
    const go2 = await ui().showCodes({ title: L('linkTitle'), lines: [L('linkShowCode')], codes: [reveal], sas, buttons: [{ text: L('cont'), value: true, primary: true }, { text: L('cancel'), value: false }] });
    if (!go2) throw idpError('E_USER_CANCELLED');
    const qr4 = await ui().scanCode({ title: L('linkTitle'), lines: [L('linkScanCode')], decode: scanDecode, sas });
    if (!qr4) throw idpError('E_USER_CANCELLED');
    await b.acceptSecret(qr4);
    for (;;) {
      if (b.parts && b.parts.got.size === b.parts.n) break;
      const part = await ui().scanCode({ title: L('linkTitle'), lines: [L('linkScanCode')], decode: scanDecode });
      if (!part) break;
      try { b.acceptPart(part); } catch (err) { if (err.code === 'E_LINK_EXPIRED') throw err; }
    }
    // Review round SEC-4: the old device always sends its vault; an identity without it (chat, record and file keys, links)
    // is never adopted quietly when the person stops scanning early.
    if (!b.parts || b.parts.got.size !== b.parts.n) throw idpError('E_LINK_STEP', 'some vault parts are missing');
    const got = b.complete();
    let vault = new Vault();
    if (got.vaultBlob) vault = await Vault.open(got.kVault, got.vaultBlob);
    await saltReady();
    const choice = await ui().chooseUnlock({ prf: null, wasm });
    if (!choice) throw idpError('E_USER_CANCELLED');
    const root = vault.data.root ? b64url.decode(vault.data.root) : null;
    const s = await adoptNew({ root, rootStarBytes: got.rootStar, kVault: got.kVault, vault, method: choice.method, nickname: choice.nickname });
    await ui().message({ text: L('linkDone') });
    return s;
  }

  /** runLinkOld({ pre }): this unlocked device (A) sends the identity to a new device in front of the person. */
  async function runLinkOld({ pre = null } = {}) {
    const L = (k, p) => t(k, p, ui().lang);
    const s = await unlock({ allowCreate: false, pre });
    const a = new LinkOldDevice({ now });
    a.open();
    const qr1 = await ui().scanCode({ title: L('linkTitle'), lines: [L('linkInPerson'), L('linkScanCode')], decode: scanDecode });
    if (!qr1) throw idpError('E_USER_CANCELLED');
    const qr2 = await a.acceptCommit(qr1);
    const go = await ui().showCodes({ title: L('linkTitle'), lines: [L('linkShowCode')], codes: [qr2], buttons: [{ text: L('cont'), value: true, primary: true }, { text: L('cancel'), value: false }] });
    if (!go) throw idpError('E_USER_CANCELLED');
    const qr3 = await ui().scanCode({ title: L('linkTitle'), lines: [L('linkScanCode')], decode: scanDecode });
    if (!qr3) throw idpError('E_USER_CANCELLED');
    const { sas } = await a.acceptReveal(qr3);
    // Review round PHISH-5: the card says what the match releases (a web page can play the other device).
    const match = await ui().showCodes({ title: L('linkTitle'), lines: [L('linkReleaseWarn')], codes: [], sas, buttons: [{ text: L('linkSasMatch'), value: true, primary: true }, { text: L('linkSasDiffer'), value: false, danger: true }] });
    // The newest saved vault (a sign-in in another window may have added a site since this one unlocked).
    const vault = await freshVault();
    const vaultBlob = await vault.toBlob(s.secrets.kVault, { id: await vaultIdOf(s.secrets.rootStar) });
    const codes = await a.confirm(match === true, { rootStar: s.secrets.rootStar, kVault: s.secrets.kVault, vaultBlob });
    await ui().showCodes({ title: L('linkTitle'), lines: [L('linkShowCode')], codes, buttons: [{ text: L('close'), value: true, primary: true }] });
    await ui().message({ text: L('linkSent') });
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------------------------

  async function visitOnlyBundle(origin) {
    // A shared-origin hub: a random key for this visit, nothing derived and nothing stored (R 2.2.3).
    const d = scalar(rand(48));
    const c = scalar(rand(48));
    const jwk = scalarToJwk(d);
    const cj = scalarToJwk(c);
    return {
      v: 1, label: null, keyMode: 'visit-only', origin, pub: publicKeyOf(d), short: shortId(publicKeyOf(d)),
      sign: { d: jwk.d, x: jwk.x, y: jwk.y, i: 1 },
      chat: { e: 1, d: cj.d, x: cj.x, y: cj.y, exp: now() + 24 * 3600 * 1000, pub: publicKeyOf(c) },
      rec: { r: 1, key: b64url.encode(rand(32)) }, own: b64url.encode(rand(32)), local: b64url.encode(rand(32)), name: b64url.encode(rand(32)),
      rc: null, escrow: null, vaultEscrow: null, ledger: null,
      status: { kitSaved: false, fileSaved: false, passkey: false, persisted: false, legacy: false },
      stay: false, sharedComputer: true,
    };
  }

  async function signLink(signD, ledgerId, from, to, tMs) {
    const key = await importScalar(signD, 'sign');
    const sig = await ecdsaSign(key, utf8.encode('mw-link-v1\n' + ledgerId + from + to + tMs));
    return b64url.encode(sig);
  }

  async function rotateNoticeFor(entry, origin, label, ledgerId, rs, { record = true } = {}) {
    const r = entry.rotated;
    if (!r || !Array.isArray(r.delivered) || r.delivered.indexOf(origin) >= 0) return null;
    // A redirect answer may never reach the origin it names (review round SEC-2): the notice is sent again next time.
    if (record) r.delivered.push(origin);
    const recover = await recoverScalar(rs, label);
    const rp = publicKeyOf(recover);
    const notice = { from: r.from, next: r.next, i: entry.i, rp, t: r.t };
    if (ledgerId) {
      const key = await importScalar(recover, 'sign');
      notice.ledger = ledgerId;
      notice.rsig = b64url.encode(await ecdsaSign(key, utf8.encode('mw-rotate-v1\n' + ledgerId + '\n' + r.from + '\n' + r.next)));
    }
    return notice;
  }

  let lastError = null;

  /**
   * handleRequest(req, origin, channel) -> the response object (never throws). origin is event.origin (popup)
   * or the redirect's checked origin. channel: { ask(message, expectT) -> Promise<data | null> } for the
   * count and legacy rounds (null in redirect mode).
   */
  async function handleRequest(req, origin, channel = null, { transport = 'popup' } = {}) {
    const requestId = req && typeof req.requestId === 'string' ? req.requestId : '';
    const answer = (more) => Object.assign({ v: PROTOCOL_VERSION, t: 'mw-signin-res', requestId }, more);
    try {
      if (!isOrigin(origin)) throw idpError('E_BAD_REQUEST', 'origin');
      // The identity origin runs the request rules itself; what the page checked proves nothing here.
      const v = validateRequest(req, { transport: 'popup' });
      if (!v.ok) throw idpError('E_BAD_REQUEST', v.reason);
      // Review round SEC-2, PHISH-9: a redirect request names its origin in page text that any page can write, so it may only
      // ask for keys or the record read (sealed to the named origin and sent there): no proof, erase, owner action, page
      // creation or legacy key, and nothing it does is remembered as that origin's (runSignIn unverified).
      if (transport === 'redirect' && !redirectAllowed(req)) throw idpError('E_BAD_REQUEST', 'not by redirect');
      // Review round PHISH-6: a server sign-in never marks a page or an owner action.
      if (req.purpose === 'server' && (req.create === true || req.owner)) throw idpError('E_BAD_REQUEST', 'owner actions are site sign-ins');
      const out = await runSignIn(req, normalizeOrigin(origin), channel, { unverified: transport === 'redirect' });
      return answer(Object.assign({ ok: true }, out));
    } catch (err) {
      const code = err && typeof err.code === 'string' && /^E_[A-Z_]+$/.test(err.code) ? err.code : 'E_INTERNAL';
      lastError = code;
      return answer({ ok: false, code: siteCode(code) });
    }
  }

  async function runSignIn(req, origin, channel, { unverified = false } = {}) {
    const want = new Set(req.want);
    const st = await getStore();
    const state = await st.getState();
    const host = new URL(origin).hostname;
    const hubInfo = unverified ? null : hubSuffixOf(host);
    const hubDecision = hubInfo ? state.hubs[hubInfo.suffix] : null;
    const prior = unverified ? null : state.origins[origin] || null;

    // Visit-only for a shared-origin hub: no root, no proof (proofs need a persistent key mode). Which origins are
    // shared is this build's list (psl.js SHARED_ORIGINS); the page's flag can only ask for less (security 20).
    if (req.shared === true || isSharedOrigin(origin, sharedOrigins)) {
      if (want.has('proof') || want.has('record') || want.has('erase')) throw idpError('E_HOST_ONLY_IDENTITY');
      const r = await ui().signin({ origin, shared: true, first: true, unlock: 'visit', hasIdentity: true, purpose: req.purpose });
      if (!r || r.action !== 'continue') throw idpError('E_USER_CANCELLED');
      const bundle = await visitOnlyBundle(origin);
      return { bundle: await seal(BUNDLE_PREFIX, req.epk, bundle, { origin, requestId: req.requestId }) };
    }

    // Erase (R 2.15): its own card, then the vault drops K_rec and K_own of this label.
    if (want.has('erase')) {
      const ok = await ui().erase({ origin });
      if (!ok) throw idpError('E_USER_CANCELLED');
    }

    // The pointer (ledger label) before the card, so the card can say "not one of this site's addresses".
    let pointerCheck = null;
    if (typeof req.pointer === 'string') pointerCheck = await verifyPointerFor(req.pointer, origin, { now: now(), state, scope: req.scope || null });
    const hubScopeFor = (on) => (hubInfo ? { suffix: hubInfo.suffix, optIn: on } : undefined);
    // Review round PHISH-1, HUB-3: the hub label goes only to one of the hub's own pages: an address derived from the very
    // pointer the request carries (verified), whose code (btih) is a template of this build, or without a build list the
    // template of the page where the person turned the hub identity on. Any other label under the suffix, a stranger's page
    // with its own code, gets its own key.
    const hubPage = Boolean(hubInfo && pointerCheck && pointerCheck.ok && pointerCheck.ownHubAddress && pointerCheck.btih);
    const templatesOf = (hs) => (hubTemplates.length ? hubTemplates : hs && Array.isArray(hs.templates) ? hs.templates : []);
    const templateOk = (hs) => hubPage && templatesOf(hs).indexOf(pointerCheck.btih) >= 0;
    const hubOnFor = (hs) => Boolean(hs && hs.on && templateOk(hs));
    let preLabel = null;
    try {
      preLabel = await labelFor({ origin, pointer: req.pointer, hubScope: hubScopeFor(hubOnFor(hubDecision)), links: unverified ? {} : linksFromState(state), verifyPointer: async () => pointerCheck, isPublicSuffix: isHubSuffix });
    } catch (_) {
      preLabel = null;
    }
    // A personal site on a hub has a pointer signed for its btih scope, which never lists the address; its address
    // is derived from that very pointer, so it is not a look-alike (conformance: the warning showed on every hub page).
    const notListed = Boolean(pointerCheck && preLabel && preLabel.reason === 'not-listed' && !(pointerCheck.ok && pointerCheck.ownHubAddress));
    const mirrorOf = preLabel && preLabel.keyMode === 'ledger' && pointerCheck && pointerCheck.ok && pointerCheck.host && pointerCheck.host !== host ? pointerCheck.host : null;
    await saltReady();

    // The card (R 2.3.4): one card, one button; "same identity" only through the menu and a second press.
    let choice;
    let sameTarget = null;
    let createConfirmed = false;
    let own = await st.getWrapped();
    if (want.has('record') && !want.has('keys')) {
      const ok = await ui().recordRead({ origin });
      if (!ok) throw idpError('E_USER_CANCELLED');
      choice = { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
    } else if (want.has('erase')) {
      choice = { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
    } else {
      for (;;) {
        // Read before the card is drawn (MF-09): the press goes straight to the credentials call.
        own = await st.getWrapped();
        const esc = !own && req.escrow ? acceptEscrow(req.escrow).root : null;
        const us = session.secrets ? { has: true, method: 'unlocked' } : { has: Boolean(own || esc), method: own ? own.method : esc ? 'passkey' : 'new' };
        // The hub box is offered only on one of the hub's own pages (hubPage), where the answer can name the template.
        const hubCard = !hubInfo ? null : hubDecision
          ? { suffix: hubInfo.suffix, decided: true, on: Boolean(hubDecision.on), notTemplate: Boolean(hubDecision.on) && !templateOk(hubDecision) }
          : hubPage ? { suffix: hubInfo.suffix, decided: false, on: false, buildDefault: req.hubDefault === true && hubTemplates.indexOf(pointerCheck.btih) >= 0 } : null;
        choice = await ui().signin({
          origin, pub: prior && prior.pub ? prior.pub : null, first: !prior, notListed, mirrorOf, unverified,
          statement: req.challenge && typeof req.challenge.statement === 'string' ? req.challenge.statement : '',
          purpose: req.purpose, sameOptions: unverified || (prior && prior.linkedTo) ? [] : sameIdentityOptions({ state, origin, now: now() }),
          linkedTo: prior && prior.linkedTo ? prior.linkedTo : null,
          hub: hubCard,
          shared: false, create: req.create === true, owner: req.owner || null, unlock: us.method, hasIdentity: us.has,
        });
        if (!choice || choice.action === 'cancel') throw idpError('E_USER_CANCELLED');
        if (choice.action === 'restore') { await runRestore(); continue; }
        if (choice.action === 'link') { await runLinkNew(); continue; }
        if (choice.mode && choice.mode.kind === 'same') {
          await updateState((s2) => recordSameOffer(s2, origin, { now: now(), outcome: 'shown' }));
          const yes = await ui().confirmSame({ a: origin, b: choice.mode.origin });
          await updateState((s2) => recordSameOffer(s2, origin, { now: now(), outcome: yes ? 'linked' : 'refused' }));
          if (yes) sameTarget = choice.mode.origin;
        }
        break;
      }
      if (req.owner) {
        const ok = await ui().ownerAction({ origin, what: req.owner.what });
        if (!ok) throw idpError('E_USER_CANCELLED');
      }
      if (req.create === true && hubInfo) {
        const ok = await ui().createPage({ hub: hubInfo.suffix });
        if (!ok) throw idpError('E_USER_CANCELLED');
        createConfirmed = true;
      }
    }

    // Unlock (one passkey prompt, or the passphrase), creating an identity on the first visit ever.
    const s = await unlock({ escrow: req.escrow || null, pre: { own } });
    const escrowVault = await openEscrowVault(req.escrow, s.secrets);

    // Everything that changes the vault or the state, under the lock, on the newest stored copies.
    const done = await commitOrRecheck(async (vault, fstate) => {
      // Every copy the site holds is merged in, never adopted in place of this one (security 1).
      if (escrowVault) vault.mergeFrom(escrowVault, { now: now() });
      // An unverified (redirect) origin is always a first approval: user verification every time, nothing remembered.
      const allowed = approvalAllowed({ state: unverified ? { origins: {} } : fstate, origin, uv: s.uv });
      if (!allowed.ok) throw idpError(allowed.code);

      // Hub choice (made once per hub, on one of its own pages) and the same-identity link, both local (nothing goes to any
      // ledger). Turned on without a build template list, the hub keeps this page's template (review round HUB-3).
      if (hubInfo && hubPage && !fstate.hubs[hubInfo.suffix] && choice.hub !== null && choice.hub !== undefined) {
        const rec = { on: choice.hub === true, t: now() };
        if (rec.on && !hubTemplates.length) rec.templates = [pointerCheck.btih];
        fstate.hubs[hubInfo.suffix] = rec;
      }
      if (sameTarget && fstate.origins[sameTarget] && fstate.origins[sameTarget].label) vault.linkOrigin(origin, fstate.origins[sameTarget].label, now());
      // The rollback floor travels in the vault (MF-30): a pointer older than one this identity accepted is refused.
      let check = pointerCheck;
      if (check && check.ok) {
        const vf = vault.floor(check.ledgerId);
        if (Number.isSafeInteger(vf) && check.seq < vf) check = { ok: false, reason: 'rollback' };
      }
      const hubOn = Boolean(hubInfo && hubOnFor(fstate.hubs[hubInfo.suffix]));
      const decision = await labelFor({ origin, pointer: req.pointer, hubScope: hubScopeFor(hubOn), links: unverified ? {} : vault.links(), verifyPointer: async () => check, isPublicSuffix: isHubSuffix });
      if (!decision || !decision.label) throw idpError('E_INTERNAL', 'no label');
      const label = decision.label;
      const keyMode = decision.keyMode;
      const ledgerId = decision.ledger || (check && check.ok ? check.ledgerId : null);

      // Keys of the label: the signing key is derived, every other key is random and lives in the vault.
      const rs = s.secrets.rootStar;
      const entry = vault.label(label, { now: now() });
      if (want.has('erase')) {
        vault.shred(label, 'rec');
        vault.shred(label, 'own');
        vault.eraseRecord(label, origin, now());
        vault.newRecordKey(label);
        entry.own = b64url.encode(rand(32));
      }
      const derived = await deriveLabel(rs, label, { i: entry.i });
      // A label that made a page or owns one keeps its key on "Replace my keys" (no owner hand-over yet). Review round
      // PHISH-6: only with evidence, never on a page's word: the "Create your page" card confirmed for one of the hub's own
      // pages under the hub key, or a pointer verified for this origin whose owner is this very key.
      const ownsByPointer = Boolean(req.owner && check && check.ok && (check.owner === derived.pub || check.lo === derived.pub));
      const madePage = req.create === true && createConfirmed && keyMode === 'hub';
      if (ownsByPointer || madePage) vault.markOwner(label, now());
      let chat = vault.currentChat(label, now());
      if (!chat) { vault.rotateChat(label, { now: now() }); chat = vault.currentChat(label, now()); }
      if (!entry.rec.length) vault.newRecordKey(label);
      if (!entry.own) entry.own = b64url.encode(rand(32));
      if (!entry.local) entry.local = b64url.encode(rand(32));
      const rec = entry.rec[entry.rec.length - 1];
      const jwk = scalarToJwk(derived.d);

      // The site's local copy of its private record comes back here (R 2.6.1): newest field wins, within the caps
      // (RECORD_MAX_BYTES per origin, VAULT_MAX_BYTES for the vault: security 8); a larger record is refused.
      if (req.record && entry.local) {
        const incoming = await openLocal(entry.local, label, 'me', req.record);
        if (incoming && typeof incoming === 'object' && incoming.f && typeof incoming.f === 'object' && Number.isSafeInteger(incoming.t)) {
          vault.mergeRecord(label, origin, incoming);
        }
      }

      // After a restore: "Found N posts" / "No posts found" (R 2.2.6, MF-11), from the site's own count.
      if (fstate.restored && fstate.restored.left > 0 && channel && want.has('keys')) {
        const reply = await channel.ask({ v: PROTOCOL_VERSION, t: 'mw-idp-count', requestId: req.requestId, pub: derived.pub }, 'mw-idp-count-res');
        if (reply && Number.isSafeInteger(reply.count) && reply.count >= 0) {
          const pick = await ui().foundPosts({ n: reply.count, site: origin });
          // Review round UX-5: "Check the words" takes the restored identity off again and opens the restore card.
          if (pick === 'check') throw idpError('E_RESTORE_RECHECK', 'check the words');
          fstate.restored.left = reply.count > 0 ? 0 : fstate.restored.left - 1;
          if (fstate.restored.left <= 0) fstate.restored = null;
        }
      }

      // A 0.2.1 key of this site moves into the vault (R 2.2.7); keep links it to the new key on that ledger.
      let legacyOut = null;
      if (req.legacy && channel && want.has('keys')) {
        const pick = await ui().legacy({ name: req.legacy.name || shortId(req.legacy.pub) });
        const eph = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const ephPub = 'p256:' + b64url.encode(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', eph.publicKey)));
        const reply = await channel.ask({ v: PROTOCOL_VERSION, t: 'mw-idp-legacy', requestId: req.requestId, epk: ephPub }, 'mw-idp-legacy-res');
        if (reply && reply.sealed) {
          try {
            const got = await open(LEGACY_PREFIX, eph.privateKey, reply.sealed, { origin, requestId: req.requestId });
            const lj = got && got.jwk;
            if (lj && typeof lj.d === 'string' && publicKeyOf(b64url.decode(lj.d)) === req.legacy.pub) {
              vault.addLegacy({ ledger: req.legacy.ledger || null, pub: req.legacy.pub, jwk: lj }, now());
              legacyOut = { choice: pick, stored: true };
              if (pick === 'keep' && typeof req.legacy.ledger === 'string' && req.legacy.ledger) {
                const tl = now();
                legacyOut.link = { from: req.legacy.pub, to: derived.pub, t: tl, sigTo: await signLink(derived.d, req.legacy.ledger, req.legacy.pub, derived.pub, tl) };
              }
            }
          } catch (_) {
            legacyOut = { choice: pick, stored: false };
          }
        } else {
          legacyOut = { choice: pick, stored: false };
        }
      }

      // The bundle (R 2.3.3); vaultEscrow is the very copy this commit saves (added after the save).
      const backup = fstate.backup || {};
      const leg = req.legacy ? vault.data.legacy.find((x) => x.pub === req.legacy.pub) : null;
      const status = {
        kitSaved: Boolean(backup.kitSaved), fileSaved: Boolean(backup.fileSaved),
        passkey: s.method === 'passkey', persisted: !s.visitOnly && Boolean(s.store && s.store.persistent), legacy: vault.data.legacy.length > 0,
        // R 2.2.7, security 15: the 0.2.1 key may leave the site only once a backup file made after it entered the vault exists.
        legacyBackedUp: Boolean(leg && Number.isSafeInteger(backup.fileAt) && Number.isSafeInteger(leg.t) && backup.fileAt > leg.t),
      };
      let K = null;
      let recordOut = null;
      if (want.has('keys') || want.has('erase')) {
        const recoverPub = derived.recoverPub;
        K = {
          v: 1, label, keyMode, origin, pub: derived.pub, short: shortId(derived.pub), ledger: ledgerId,
          sign: { d: jwk.d, x: jwk.x, y: jwk.y, i: entry.i },
          chat: { e: chat.e, d: chat.jwk.d, x: chat.jwk.x, y: chat.jwk.y, exp: chat.exp, pub: chat.pub },
          rec: { r: rec.r, key: rec.key }, own: entry.own, local: entry.local, name: b64url.encode(derived.kName),
          rc: b64url.encode(await sha256(utf8.encode(recoverPub))),
          status, stay: choice.stay === true && !s.visitOnly, sharedComputer: choice.sharedComputer === true || s.visitOnly,
          // Filled after the save with this origin's own copies (escrowFor); a passphrase blob never leaves this origin.
          escrow: null,
          vaultEscrow: null,
        };
        if (req.create === true) {
          const seed = await labelSeed(rs, label);
          K.nextPubHash = await nextKeyCommitment(publicKeyOf(await signScalar(seed, entry.i + 1)));
        }
        const notice = await rotateNoticeFor(entry, origin, label, ledgerId, rs, { record: !unverified });
        if (notice) K.rotateNotice = notice;
        if (legacyOut) K.legacy = legacyOut;
        if (req.owner) K.owner = { what: req.owner.what, confirmed: true };
        if (want.has('erase')) K.erased = true;
        if (want.has('record')) K.record = entry.me && entry.me[origin] ? entry.me[origin] : { f: {}, ft: {}, t: 0 };
        if (!unverified) vault.addSite(label, origin, now());
      } else if (want.has('record')) {
        recordOut = entry.me && entry.me[origin] ? entry.me[origin] : { f: {}, ft: {}, t: 0 };
      }

      // The proof (R 2.3.2): domain, origin, ledger, pub, keyMode, iat, idp and build from here.
      let proof = null;
      if (want.has('proof')) {
        if (KEY_MODES.indexOf(keyMode) < 0) throw idpError('E_HOST_ONLY_IDENTITY');
        const c = buildChallenge({
          origin, ledger: keyMode === 'ledger' ? ledgerId : null, pub: derived.pub, keyMode, purpose: req.purpose,
          challenge: req.challenge || null, now: now(), requestId: req.requestId, idp: idpOrigin, build: buildTag(build),
        });
        proof = await signChallenge(c, await importScalar(derived.d, 'sign'));
      }

      // Remember: display cache, sites, the ledger seq floor (state and vault). Not for an unverified (redirect) origin
      // (review round SEC-2, PHISH-9), and not on "Shared computer", which promises nothing is saved on this device for the
      // site (review round STALK-6; the encrypted vault still lists it).
      const linkedTo = keyMode === 'linked' ? originOfLabel(fstate, label, origin) : null;
      const was = fstate.origins[origin];
      if (!unverified && choice.sharedComputer !== true) fstate.origins[origin] = { label, keyMode, pub: derived.pub, short: shortId(derived.pub), linkedTo, first: was && Number.isSafeInteger(was.first) ? was.first : now(), last: now(), uv: s.uv };
      if (keyMode === 'ledger' && check && check.ok) {
        const f = fstate.seqFloors[ledgerId];
        fstate.seqFloors[ledgerId] = Number.isSafeInteger(f) ? Math.max(f, check.seq) : check.seq;
        vault.raiseFloor(ledgerId, check.seq);
      }
      return { K, recordOut, proof, status };
    });

    if (done === RECHECK) {
      // "Check the words" after a restore that found no posts (review round UX-5): nothing of this sign-in was saved; the
      // restored identity leaves this device again and the card offers the restore once more.
      await dropRestored();
      return runSignIn(req, origin, channel, { unverified });
    }
    const out = {};
    if (done.K) {
      if (!s.visitOnly) {
        const e = await escrowFor(origin);
        done.K.escrow = e.root;
        done.K.vaultEscrow = e.vault;
      }
      out.bundle = await seal(BUNDLE_PREFIX, req.epk, done.K, { origin, requestId: req.requestId });
      if (want.has('erase')) out.erased = true;
    } else if (done.recordOut) {
      out.record = await seal(RECORD_PREFIX, req.epk, done.recordOut, { origin, requestId: req.requestId });
    }
    if (done.proof) out.proof = done.proof;

    // iOS outside Home Screen: the recovery kit on every visit until saved (R 2.2.6, MF-11). It is shown after the
    // site has its answer (bootSignin), so the site never waits on it and closing the kit cancels nothing.
    const due = kitDue({ ios, standalone, kitSaved: done.status.kitSaved, meaningful: false });
    pendingKit = due.show ? due : null;
    return out;
  }

  let pendingKit = null;
  const RECHECK = Object.freeze({ recheck: true });

  async function commitOrRecheck(fn) {
    try {
      return await commit(fn);
    } catch (err) {
      if (err && err.code === 'E_RESTORE_RECHECK') return RECHECK;
      throw err;
    }
  }

  /** dropRestored(): the identity a restore just put on this device leaves it again (its display state with it). */
  async function dropRestored() {
    const st = session.store || await getStore();
    await exclusive(async () => {
      await st.dropIdentity();
      const state = await st.getState();
      state.restored = null;
      state.checkCode = null;
      await st.setState(state);
    });
    dropSession();
  }

  /** redirectAllowed(req): what a redirect request may ask for (review round SEC-2, PHISH-9). */
  function redirectAllowed(req) {
    const want = Array.isArray(req.want) ? req.want : [];
    if (req.purpose !== 'site' || req.challenge !== undefined) return false;
    if (want.some((w) => w !== 'keys' && w !== 'record')) return false;
    return req.create === undefined && req.owner === undefined && req.legacy === undefined;
  }

  /** afterAnswer(): the card that waits until the site has its answer (the iOS recovery kit). */
  async function afterAnswer() {
    const due = pendingKit;
    pendingKit = null;
    if (!due) return false;
    try {
      return await runKit({ ios: due.ios });
    } catch (_) {
      return false;
    }
  }

  function linksFromState(state) {
    const out = {};
    for (const o of Object.keys(state.origins || {})) {
      const e = state.origins[o];
      if (e && e.keyMode === 'linked' && e.label) out[o] = e.label;
    }
    return out;
  }

  function originOfLabel(state, label, self) {
    for (const o of Object.keys(state.origins || {})) {
      if (o !== self && state.origins[o] && state.origins[o].label === label && state.origins[o].keyMode !== 'linked') return o;
    }
    return null;
  }

  /** runKit(): the recovery kit: the 12 words, the 3-word re-entry check, then kitSaved. */
  async function runKit({ ios: onIos = false } = {}) {
    if (!session.secrets) return false;
    const st = session.store || await getStore();
    const state = await st.getState();
    const pick = await ui().recoveryKit({ ios: onIos, escrow: session.method === 'passkey', checkCode: state.checkCode || await checkCode(session.secrets.rootStar) });
    if (pick !== 'saved') return false;
    const root = session.vault && session.vault.data.root ? b64url.decode(session.vault.data.root) : null;
    if (!root) return false;
    const words = rootToPhrase(root);
    if (!(await ui().showPhrase({ words, checkCode: state.checkCode }))) return false;
    if (!(await ui().reentry({ words, positions: reentryPositions() }))) return false;
    if (!session.visitOnly) await updateState((s2) => { s2.backup = Object.assign({}, s2.backup, { kitSaved: true, kitAt: now() }); });
    await ui().message({ text: t('reentryDone', null, ui().lang) });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Settings actions (R 2.3.5 revoke for the future, MF-20 replace keys, R 2.15 remove from device)
  // -------------------------------------------------------------------------------------------

  /**
   * replaceAllKeys({ pre }) -> { replaced, kept }: every label moves to sign index i + 1 and tells each site once
   * (rotateNotice), except labels that made or own a page (vault markOwner): their key is the page's owner, and no
   * owner hand-over is written yet, so moving them would leave the person unable to write to their own page (code
   * review v0.3, security 5). The card says so.
   */
  async function replaceAllKeys({ pre = null } = {}) {
    const s = await unlock({ allowCreate: false, pre });
    const tNow = now();
    return commit(async (vault) => {
      let replaced = 0;
      let kept = 0;
      const keptSites = [];
      for (const label of vault.labels()) {
        const entry = vault.label(label, { create: false });
        if (Number.isSafeInteger(entry.owns)) {
          kept++;
          // Review round PHISH-6: the card names the sites whose key stays.
          for (const x of entry.sites || []) if (x && typeof x.origin === 'string' && keptSites.indexOf(x.origin) < 0) keptSites.push(x.origin);
          continue;
        }
        const seed = await labelSeed(s.secrets.rootStar, label);
        const from = publicKeyOf(await signScalar(seed, entry.i));
        const i = vault.bumpSignIndex(label);
        const next = publicKeyOf(await signScalar(seed, i));
        entry.rotated = { from, next, t: tNow, delivered: [] };
        replaced++;
      }
      return { replaced, kept, keptSites };
    });
  }

  /**
   * stopSame(origin) -> { rotated }: future sign-ins on origin use its own key, and (review round PHISH-3) the label it shared
   * moves to new keys, because the site already holds the other site's private keys: a new signing key (a rotation notice
   * for the sites that use it), a new chat epoch and a new record epoch (older ones stay for reading). A label that owns a
   * page keeps its signing key (no owner hand-over yet); then rotated is false and the card says so.
   */
  async function stopSame(origin, { pre = null } = {}) {
    const s = await unlock({ allowCreate: false, pre });
    const tNow = now();
    return commit(async (vault, state) => {
      const shared = vault.links()[normalizeOrigin(origin)] || null;
      vault.unlinkOrigin(origin, tNow);
      if (state.origins[origin]) {
        state.origins[origin].keyMode = 'pairwise';
        state.origins[origin].linkedTo = null;
        state.origins[origin].label = 'o|' + origin;
      }
      const entry = shared ? vault.label(shared, { create: false }) : null;
      if (!entry) return { rotated: false };
      vault.rotateChat(shared, { now: tNow });
      vault.newRecordKey(shared);
      if (Number.isSafeInteger(entry.owns)) return { rotated: false };
      const seed = await labelSeed(s.secrets.rootStar, shared);
      const from = publicKeyOf(await signScalar(seed, entry.i));
      const i = vault.bumpSignIndex(shared);
      entry.rotated = { from, next: publicKeyOf(await signScalar(seed, i)), t: tNow, delivered: [] };
      return { rotated: true };
    });
  }

  async function hubOff(suffix) {
    await updateState((state) => { state.hubs[suffix] = { on: false, t: now() }; });
  }

  /** hubAsk(suffix): review round UX-12: the hub's answer is forgotten, so its next sign-in offers the box again. */
  async function hubAsk(suffix) {
    await updateState((state) => { delete state.hubs[suffix]; });
  }

  /**
   * refuseFramed(): review round PHISH-12: the identity page works only as a top-level window (frame-ancestors 'none' is a
   * header some static hosts drop); inside a frame it draws one card and stops.
   */
  async function refuseFramed() {
    let framed = false;
    try { framed = Boolean(win && win.top && win.self && win.top !== win.self); } catch (_) { framed = true; }
    if (framed) await ui().message({ text: t('frameRefused', { idp: idpOrigin }, ui().lang), kind: 'error' });
    return framed;
  }

  async function removeDevice() {
    const st = await getStore();
    await exclusive(() => st.wipe());
    dropSession();
  }

  /**
   * startDownload(text) -> true when a download was started: a Blob URL and an a[download] click, run inside the
   * person's press on the save card. The URL stays valid at least BACKUP_URL_MS (iOS Safari asks first and reads it
   * after the answer; the loader keeps its own 30 s).
   */
  function startDownload(text) {
    if (!doc || !win || typeof win.Blob !== 'function' || !win.URL) return false;
    const url = win.URL.createObjectURL(new win.Blob([text], { type: 'application/json' }));
    const a = doc.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', BACKUP_FILE_NAME);
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    setT(() => { try { win.URL.revokeObjectURL(url); a.remove(); } catch (_) { /* ignore */ } }, BACKUP_URL_MS);
    return true;
  }

  function copyText(text) {
    try {
      const clip = nav && nav.clipboard;
      if (clip && typeof clip.writeText === 'function') clip.writeText(text).catch(() => {});
    } catch (_) {
      // the text is on the card to select by hand
    }
  }

  /**
   * makeBackup({ pre }) -> the file text or null. Built from the newest saved vault; then the save card: the file is
   * saved by the person's own press, and fileSaved is set only after "I saved the file" (code review v0.3, browser).
   */
  async function makeBackup({ pre = null } = {}) {
    const s = await unlock({ allowCreate: false, pre });
    const generated = generatePassphrase(6);
    let error = null;
    for (;;) {
      const pick = await ui().backupFile({ generated, error });
      if (!pick) return null;
      if (pick.pass !== generated && !passphraseStrength(pick.pass).ok) { error = t('passphraseWeak', null, ui().lang); continue; }
      ui().busy();
      await paint();
      const vault = await freshVault();
      const text = await makeBackupFile({ rootStar: s.secrets.rootStar, kVault: s.secrets.kVault, vault }, pick.pass, { kdf: chooseKdf(wasm), allowWeak: pick.pass === generated, onProgress: progress });
      const saved = await ui().saveBackup({ text, download: startDownload, copy: copyText });
      if (saved === 'saved' && !s.visitOnly) await updateState((state) => { state.backup = Object.assign({}, state.backup, { fileSaved: true, fileAt: now() }); });
      return text;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Page boot
  // -------------------------------------------------------------------------------------------

  function popupChannel(origin) {
    return {
      ask(message, expectT) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => { win.removeEventListener('message', onMsg); resolve(null); }, ROUND_TIMEOUT_MS);
          function onMsg(event) {
            if (!event || event.source !== win.opener || event.origin !== origin) return;
            const d = event.data;
            if (!d || d.t !== expectT || d.requestId !== message.requestId) return;
            clearTimeout(timer);
            win.removeEventListener('message', onMsg);
            resolve(d);
          }
          win.addEventListener('message', onMsg);
          try { win.opener.postMessage(message, origin); } catch (_) { clearTimeout(timer); resolve(null); }
        });
      },
    };
  }

  /**
   * bootSignin(): the /signin page. Redirect requests come in the fragment; popup requests by postMessage from
   * window.opener only (the first valid one; later ones are ignored).
   */
  async function bootSignin() {
    if (await refuseFramed()) return { done: false };
    const hash = loc && typeof loc.hash === 'string' ? loc.hash.replace(/^#/, '') : '';
    if (hash) {
      const req = decodeFragment(hash);
      try { if (win.history) win.history.replaceState(null, '', loc.pathname); } catch (_) { /* keep it */ }
      const v = validateRequest(req, { transport: 'redirect' });
      if (!v.ok || !returnUrlOk(req.ret, req.origin)) {
        await ui().error({ code: 'E_BAD_REQUEST' });
        return { done: false };
      }
      const clean = Object.assign({}, req);
      delete clean.origin;
      delete clean.ret;
      const res = await handleRequest(clean, req.origin, null, { transport: 'redirect' });
      if (res.ok) await afterAnswer(); // this tab goes back to the site next, so the kit comes first here
      loc.replace(req.ret + '#' + encodeFragment(res));
      return { done: true, res };
    }
    if (!win || !win.opener) {
      // A window a site opened (its name says so) that lost its opener: in-app browsers, iOS Home Screen apps. The
      // site offers "Continue in this tab" (the redirect round trip); tell the person to go back and choose it.
      const fromSite = Boolean(win && win.name === POPUP_NAME);
      await ui().message({ text: t(fromSite ? 'noOpener' : 'openFromSite', null, ui().lang) });
      return { done: false };
    }
    return new Promise((resolve) => {
      let taken = false;
      async function onMessage(event) {
        if (taken || !event || event.source !== win.opener) return;
        const data = event.data;
        if (!data || data.t !== 'mw-signin-req') return;
        const v = validateRequest(data, { transport: 'popup' });
        const origin = event.origin;
        if (!v.ok) {
          taken = true;
          win.removeEventListener('message', onMessage);
          try { win.opener.postMessage({ v: PROTOCOL_VERSION, t: 'mw-signin-res', requestId: typeof data.requestId === 'string' ? data.requestId : '', ok: false, code: 'E_BAD_REQUEST' }, origin); } catch (_) { /* gone */ }
          resolve({ done: false });
          return;
        }
        taken = true;
        win.removeEventListener('message', onMessage);
        const res = await handleRequest(data, origin, popupChannel(origin));
        try { win.opener.postMessage(res, origin); } catch (_) { /* the site went away */ }
        if (res.ok) await afterAnswer();
        if (res.ok === false && lastError && lastError !== 'E_USER_CANCELLED') await ui().error({ code: lastError });
        try { win.close(); } catch (_) { /* a window the person opened stays */ }
        resolve({ done: true, res });
      }
      win.addEventListener('message', onMessage);
      try { win.opener.postMessage({ v: PROTOCOL_VERSION, t: 'mw-idp-ready', build: buildTag(build) }, '*'); } catch (_) { /* opener gone */ }
    });
  }

  /** bootHome(): the IdO home page (Settings, recovery kit, backup file, device link). */
  async function bootHome() {
    if (await refuseFramed()) return;
    const st = await getStore();
    // What the buttons need is read when the page is drawn (MF-09): their press goes straight to the passkey call.
    let pre = { own: null };
    const render = async () => {
      const state = await st.getState();
      const wrapped = await st.getWrapped();
      pre = { own: wrapped };
      await saltReady();
      // Review round STALK-6: what this device knows about the person's sites waits for an unlock in this window.
      const locked = Boolean(wrapped) && !session.secrets;
      const links = [];
      for (const o of Object.keys(state.origins)) if (state.origins[o].keyMode === 'linked') links.push({ origin: o, with: state.origins[o].linkedTo });
      const hubs = Object.keys(state.hubs).map((suffix) => ({ suffix, on: state.hubs[suffix].on }));
      ui().settings(locked ? { hasIdentity: true, locked: true, unlock: wrapped.method, backup: state.backup } : {
        hasIdentity: Boolean(wrapped), unlock: wrapped ? wrapped.method : 'visit', backup: state.backup, checkCode: state.checkCode, links, hubs, sites: Object.keys(state.origins).sort(),
      }, {
        unlockView: () => guard(() => unlock({ allowCreate: false, pre })),
        stopSame: (o) => guard(async () => {
          const r = await stopSame(o, { pre });
          await ui().message({ text: t(r && r.rotated === false ? 'stopSameKept' : 'stopSameDone', { site: o }, ui().lang) });
        }),
        hubOff: (h) => guard(() => hubOff(h)),
        hubAsk: (h) => guard(() => hubAsk(h)),
        replaceKeys: () => guard(async () => {
          if (await ui().replaceKeys()) {
            const r = await replaceAllKeys({ pre });
            const lang = ui().lang;
            const kept = r && Array.isArray(r.keptSites) && r.keptSites.length ? ' ' + t('replaceKeysKept', { sites: r.keptSites.join(', ') }, lang) : '';
            await ui().message({ text: t('replaceKeysDone', null, lang) + kept });
          }
        }),
        removeDevice: () => guard(async () => { if (await ui().removeDevice()) { await removeDevice(); await ui().message({ text: t('removeDeviceDone', null, ui().lang) }); } }),
        showPhrase: () => guard(async () => { await unlock({ allowCreate: false, pre }); await freshVault(); await runKit({}); }),
        makeBackup: () => guard(() => makeBackup({ pre })),
        link: () => guard(async () => { if (pre.own) await runLinkOld({ pre }); else await runLinkNew(); }),
        restore: () => guard(() => runRestore()),
      });
    };
    const guard = async (fn) => {
      try { await fn(); } catch (err) { if (!err || err.code !== 'E_USER_CANCELLED') await ui().error({ code: (err && err.code) || 'E_INTERNAL' }); }
      await render();
    };
    const intent = loc && typeof loc.hash === 'string' ? loc.hash.replace(/^#/, '') : '';
    pre = { own: await st.getWrapped() };
    await saltReady();
    // Review round PHISH-4, PHISH-5, PHISH-10: restoring and linking start only in a window the person opened, never in one a
    // site opened (window.opener set): a page cannot walk someone into replacing or handing over their identity.
    let openedBySite = false;
    try { openedBySite = Boolean(win && win.opener); } catch (_) { openedBySite = true; }
    if (openedBySite && (intent === 'restore' || intent === 'link')) {
      await ui().message({ text: t('openYourself', { idp: idpOrigin }, ui().lang) });
      await render();
      return;
    }
    if (intent === 'kit') await guard(async () => { await unlock({ allowCreate: false, pre }); await freshVault(); await runKit({ ios: ios && !standalone }); });
    else if (intent === 'backup') await guard(() => makeBackup({ pre }));
    else if (intent === 'link') await guard(async () => { if (pre.own) await runLinkOld({ pre }); else await runLinkNew(); });
    else if (intent === 'restore') await guard(() => runRestore());
    else await render();
  }

  return {
    handleRequest, verifyPointerFor: (text, origin, opts) => verifyPointerFor(text, origin, opts), bootSignin, bootHome,
    unlock, runRestore, runLinkNew, runLinkOld, runKit, afterAnswer, replaceAllKeys, stopSame, hubOff, hubAsk, removeDevice, makeBackup,
    startDownload,
    get session() { return session; },
  };
}

/** main(): the page entry (the IdO's index.html sets <html data-mw-idp>). */
export async function main() {
  const idp = createIdp();
  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function') {
      const base = new URL('.', document.querySelector('script[type="module"][src]') ? document.querySelector('script[type="module"][src]').src : location.href);
      navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: new URL('./', base).pathname }).catch(() => {});
    }
  } catch (_) {
    // no worker: every sign-in fetches the bundle
  }
  if (/\/signin\/?$/.test(location.pathname)) return idp.bootSignin();
  return idp.bootHome();
}

if (typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.hasAttribute === 'function' && document.documentElement.hasAttribute('data-mw-idp')) {
  main();
}
