// src/idp/link.js: device link between two identity origins (R 2.3.8; MF-05, MF-10; test U-ID-6, E-ID-14).
// Moves root* and K_vault (and the K_vault-encrypted vault blob) from an unlocked old device A to a new
// device B, in person, with no network path. Commit then reveal, so a substituted key passes the 6-digit
// check with probability 10^-6:
//
//   B: eB, nonceB (16 bytes)            QR 1  mwlink:2:c:<b64url SHA-256(eB)>:<b64url nonceB>
//   A: eA (on its own "Link a device" screen opened within the last 120 s)
//                                       QR 2  mwlink:2:a:<b64url eA>
//   B (reveal)                          QR 3  mwlink:2:b:<b64url eB>
//   both: SAS = uint32_be(SHA-256("mw-link-v2" || eA || eB || nonceB)[0..4]) mod 10^6, 6 digits
//   the person confirms on A that both numbers match; only then A makes ciphertext:
//                                       QR 4  mwlink:2:s:<b64url iv || AES-256-GCM(K, root* || K_vault)>
//                                       QR 5.. mwlink:2:v:<i>:<n>:<b64url part of the vault blob JSON>
//   K = HKDF-SHA-256(ECDH(eA, eB), salt = "", info = "mw-link-v2" || H(eB) || nonceB || eA || eB, 32)
//   AAD of QR 4 = "mw-link-v2\n" || H(eB) || nonceB
//
// eA and eB are raw 65-byte uncompressed P-256 points. No QR carries a site name or a ledger id. Every code is
// refused after 120 s (LINK_WINDOW_MS) counted from the moment the person opened the screen on that device, except the
// vault parts (review round SEC-4): they are AEAD-protected under K_vault, so B takes them for VAULT_PARTS_WINDOW_MS
// after the identity code arrived, and their count may reach MAX_PARTS (a vault at the VAULT_MAX_BYTES cap).
// The most frequent SAS values are about 0.02 percent more likely than the others (2^32 mod 10^6 = 967,296).
// Pure: Node >= 22 and browsers (WebCrypto).

import { b64url, utf8, concatBytes } from '../chain/canonical.js';
import { VAULT_MAX_BYTES } from '../identity/vault.js';

export const LINK_PREFIX = 'mw-link-v2';
export const LINK_WINDOW_MS = 120000;
export const PART_CHARS = 900;
/** Vault parts are taken this long after the identity code arrived (at 1.2 s a part, MAX_PARTS take about 8 minutes). */
export const VAULT_PARTS_WINDOW_MS = 20 * 60 * 1000;
/**
 * The part count a vault at the cap needs (review round SEC-4): its blob's ct is base64url of the plaintext plus the
 * 16-byte tag, the blob JSON adds a short header, and the parts carry that JSON in base64url again.
 */
export const MAX_PARTS = Math.ceil((Math.ceil(((VAULT_MAX_BYTES + 16) * 4) / 3) + 200) * 4 / 3 / PART_CHARS);
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw Object.assign(new Error('WebCrypto is unavailable'), { code: 'E_UNSUPPORTED' });
  return c.subtle;
}

const linkError = (code, message) => Object.assign(new Error(message), { code });

async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

function equal(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function decodeB64(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw linkError('E_LINK_STEP', 'not a link code');
  const out = b64url.decode(s);
  if (len !== undefined && out.length !== len) throw linkError('E_LINK_STEP', 'not a link code');
  return out;
}

async function ephemeral() {
  const pair = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, raw };
}

async function sharedSecret(privateKey, theirRaw) {
  const pub = await subtle().importKey('raw', theirRaw, ECDH, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
}

async function linkKey(shared, transcript) {
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: concatBytes(utf8.encode(LINK_PREFIX), transcript) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** sasFor(eA, eB, nonceB) -> '000000'..'999999' (raw points and the 16-byte nonce). */
export async function sasFor(eA, eB, nonceB) {
  const h = await sha256(concatBytes(utf8.encode(LINK_PREFIX), eA, eB, nonceB));
  const v = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(v % 1000000).padStart(6, '0');
}

/** parseLinkCode(text) -> { step: 'c'|'a'|'b'|'s'|'v', ... }; E_LINK_STEP for anything else. */
export function parseLinkCode(text) {
  if (typeof text !== 'string') throw linkError('E_LINK_STEP', 'not a link code');
  const s = text.trim();
  const m = /^mwlink:2:([cabsv]):(.+)$/.exec(s);
  if (!m || s.length > 4000) throw linkError('E_LINK_STEP', 'not a link code');
  const step = m[1];
  const rest = m[2];
  if (step === 'c') {
    const parts = rest.split(':');
    if (parts.length !== 2) throw linkError('E_LINK_STEP', 'not a link code');
    return { step, commit: decodeB64(parts[0], 32), nonce: decodeB64(parts[1], 16) };
  }
  if (step === 'a' || step === 'b') {
    const key = decodeB64(rest, 65);
    if (key[0] !== 4) throw linkError('E_LINK_STEP', 'not a link code');
    return { step, key };
  }
  if (step === 's') return { step, box: decodeB64(rest) };
  const parts = rest.split(':');
  if (parts.length !== 3 || !/^\d{1,3}$/.test(parts[0]) || !/^\d{1,3}$/.test(parts[1])) throw linkError('E_LINK_STEP', 'not a link code');
  const i = Number(parts[0]);
  const n = Number(parts[1]);
  if (n < 1 || i >= n || n > MAX_PARTS || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw linkError('E_LINK_STEP', 'not a link code');
  return { step, i, n, data: parts[2] };
}

function windowCheck(openedAt, now, windowMs = LINK_WINDOW_MS) {
  if (!Number.isFinite(openedAt) || now - openedAt > windowMs || now < openedAt) {
    throw linkError('E_LINK_EXPIRED', windowMs === LINK_WINDOW_MS ? 'this link took longer than 2 minutes' : 'the vault parts took too long');
  }
}

/**
 * Device B (the new device). new LinkNewDevice({ now }); await b.open() -> QR 1 text;
 * await b.acceptA(qr2) -> { reveal: QR 3 text, sas }; b.acceptSecret(qr4) / b.acceptPart(qr5..) until
 * b.complete() -> { rootStar, kVault, vaultBlob | null }.
 */
export class LinkNewDevice {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.state = 'new';
    this.openedAt = NaN;
    this.e = null;
    this.nonce = null;
    this.commit = null;
    this.eA = null;
    this.key = null;
    this.secret = null;
    this.parts = null;
    this.partsFrom = NaN;
  }

  async open() {
    this.openedAt = this.now();
    this.e = await ephemeral();
    this.nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
    this.commit = await sha256(this.e.raw);
    this.state = 'committed';
    return 'mwlink:2:c:' + b64url.encode(this.commit) + ':' + b64url.encode(this.nonce);
  }

  async acceptA(text) {
    windowCheck(this.openedAt, this.now());
    if (this.state !== 'committed') throw linkError('E_LINK_STEP', 'out of order');
    const code = parseLinkCode(text);
    if (code.step !== 'a') throw linkError('E_LINK_STEP', 'expected the other device\'s key');
    this.eA = code.key;
    const shared = await sharedSecret(this.e.privateKey, this.eA);
    this.key = await linkKey(shared, concatBytes(this.commit, this.nonce, this.eA, this.e.raw));
    this.state = 'revealed';
    const sas = await sasFor(this.eA, this.e.raw, this.nonce);
    return { reveal: 'mwlink:2:b:' + b64url.encode(this.e.raw), sas };
  }

  async acceptSecret(text) {
    windowCheck(this.openedAt, this.now());
    if (this.state !== 'revealed') throw linkError('E_LINK_STEP', 'out of order');
    const code = parseLinkCode(text);
    if (code.step !== 's' || code.box.length !== 12 + 64 + 16) throw linkError('E_LINK_STEP', 'expected the identity code');
    let plain;
    try {
      plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: code.box.subarray(0, 12), additionalData: concatBytes(utf8.encode(LINK_PREFIX + '\n'), this.commit, this.nonce) },
        this.key, code.box.subarray(12)));
    } catch (_) {
      throw linkError('E_LINK_COMMIT', 'the identity code does not open with this link');
    }
    this.secret = { rootStar: plain.slice(0, 32), kVault: plain.slice(32, 64) };
    this.state = 'secret';
    this.partsFrom = this.now();
    return { parts: this.parts ? this.parts.n : null };
  }

  acceptPart(text) {
    if (this.state !== 'secret') throw linkError('E_LINK_STEP', 'out of order');
    windowCheck(this.partsFrom, this.now(), VAULT_PARTS_WINDOW_MS);
    const code = parseLinkCode(text);
    if (code.step !== 'v') throw linkError('E_LINK_STEP', 'expected a vault part');
    if (!this.parts) this.parts = { n: code.n, got: new Map() };
    if (code.n !== this.parts.n) throw linkError('E_LINK_STEP', 'parts of two different links');
    this.parts.got.set(code.i, code.data);
    return { have: this.parts.got.size, of: this.parts.n };
  }

  /** complete() -> { rootStar, kVault, vaultBlob } once QR 4 and every vault part arrived (vaultBlob null when A sent none). */
  complete() {
    if (this.state !== 'secret') throw linkError('E_LINK_STEP', 'the identity code has not arrived');
    let vaultBlob = null;
    if (this.parts) {
      if (this.parts.got.size !== this.parts.n) throw linkError('E_LINK_STEP', 'some vault parts are missing');
      let joined = '';
      for (let i = 0; i < this.parts.n; i++) joined += this.parts.got.get(i);
      try {
        vaultBlob = JSON.parse(utf8.decode(b64url.decode(joined), { fatal: true }));
      } catch (_) {
        throw linkError('E_LINK_STEP', 'the vault parts do not form a vault');
      }
    }
    this.state = 'done';
    return { rootStar: this.secret.rootStar, kVault: this.secret.kVault, vaultBlob };
  }
}

/**
 * Device A (the old, unlocked device). new LinkOldDevice({ now }); a.open() when the person opens the screen;
 * await a.acceptCommit(qr1) -> QR 2 text; await a.acceptReveal(qr3) -> { sas };
 * await a.confirm(true, { rootStar, kVault, vaultBlob }) -> [QR 4 text, vault part texts...].
 * Nothing secret exists before confirm(true).
 */
export class LinkOldDevice {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.state = 'new';
    this.openedAt = NaN;
    this.e = null;
    this.commit = null;
    this.nonce = null;
    this.eB = null;
    this.sas = null;
  }

  open() {
    this.openedAt = this.now();
    this.state = 'open';
  }

  async acceptCommit(text) {
    windowCheck(this.openedAt, this.now());
    if (this.state !== 'open') throw linkError('E_LINK_STEP', 'out of order');
    const code = parseLinkCode(text);
    if (code.step !== 'c') throw linkError('E_LINK_STEP', 'expected the new device\'s first code');
    this.commit = code.commit;
    this.nonce = code.nonce;
    this.e = await ephemeral();
    this.state = 'answered';
    return 'mwlink:2:a:' + b64url.encode(this.e.raw);
  }

  async acceptReveal(text) {
    windowCheck(this.openedAt, this.now());
    if (this.state !== 'answered') throw linkError('E_LINK_STEP', 'out of order');
    const code = parseLinkCode(text);
    if (code.step !== 'b') throw linkError('E_LINK_STEP', 'expected the new device\'s key');
    if (!equal(await sha256(code.key), this.commit)) {
      this.state = 'failed';
      throw linkError('E_LINK_COMMIT', 'the revealed key does not match the commitment');
    }
    this.eB = code.key;
    this.sas = await sasFor(this.e.raw, this.eB, this.nonce);
    this.state = 'compare';
    return { sas: this.sas };
  }

  /** confirm(match, secrets) -> code texts; match false (or a timeout) ends the link with nothing sent. */
  async confirm(match, { rootStar, kVault, vaultBlob = null } = {}) {
    windowCheck(this.openedAt, this.now());
    if (this.state !== 'compare') throw linkError('E_LINK_STEP', 'out of order');
    if (match !== true) {
      this.state = 'failed';
      throw linkError('E_USER_CANCELLED', 'the numbers differ');
    }
    if (!(rootStar instanceof Uint8Array) || rootStar.length !== 32 || !(kVault instanceof Uint8Array) || kVault.length !== 32) {
      throw new TypeError('confirm needs rootStar and kVault (32 bytes each)');
    }
    const shared = await sharedSecret(this.e.privateKey, this.eB);
    const key = await linkKey(shared, concatBytes(this.commit, this.nonce, this.e.raw, this.eB));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: concatBytes(utf8.encode(LINK_PREFIX + '\n'), this.commit, this.nonce) },
      key, concatBytes(rootStar, kVault)));
    const out = ['mwlink:2:s:' + b64url.encode(concatBytes(iv, ct))];
    if (vaultBlob) {
      const text = b64url.encode(utf8.encode(JSON.stringify(vaultBlob)));
      const n = Math.max(1, Math.ceil(text.length / PART_CHARS));
      for (let i = 0; i < n; i++) out.push('mwlink:2:v:' + i + ':' + n + ':' + text.slice(i * PART_CHARS, (i + 1) * PART_CHARS));
    }
    this.state = 'sent';
    return out;
  }
}
