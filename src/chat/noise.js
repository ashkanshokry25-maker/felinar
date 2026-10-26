// Wire handshake for mw_chat1 (R 2.4.3, MF-40): the Noise XX pattern (noiseprotocol.org, revision 34)
// instantiated with P-256 ECDH, AES-256-GCM and SHA-256 (protocol name "Noise_XX_P256_AESGCM_SHA256"),
// the two parties' chat keys as static keys and the prologue utf8("mw-wire-v1") || utf8(ledgerId).
//
//   XX:  -> e
//        <- e, ee, s, es
//        -> s, se
//
// P-256 specifics (deviation D-2): public keys are the 65-byte uncompressed SEC1 points and DH() returns
// the 32-byte x coordinate; every other step is the Noise specification unchanged (HKDF over HMAC-SHA-256,
// AESGCM nonce = 32 zero bits || 64-bit big-endian counter, Split()). No signature is used, so the
// handshake is not a transferable proof that two keys were online together. After the handshake every
// frame on the wire is sealed under the session (Session.encrypt / decrypt): a relay that claims another
// peer's id holds a different transcript and cannot read or inject frames.
//
// New cryptographic code: vectors in test/vectors/chat.json; not called secure before the outside
// review (R 2.19). Shared code: WebCrypto only, no Buffer, no node: imports.

import { utf8, concatBytes } from '../chain/canonical.js';
import { encodePublicKey } from '../chain/crypto.js';
import { generateChatKey, rawPoint, aesGcmEncrypt, aesGcmDecrypt } from './seal.js';
import { hmac } from './tags.js';
import { isOnCurve } from './frames.js';
import { POINT_BYTES, GCM_TAG } from './limits.js';

export const PROTOCOL_NAME = 'Noise_XX_P256_AESGCM_SHA256';
export const PROLOGUE_PREFIX = 'mw-wire-v1';
const HASHLEN = 32;
const EMPTY = new Uint8Array(0);
/** The counter must stay below 2^64 - 1 in Noise; 2^53 - 1 is the JavaScript bound we can count to. */
const NONCE_MAX = Number.MAX_SAFE_INTEGER;

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

async function hash(data) {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

/** Noise HKDF(chainingKey, ikm, 2). */
async function noiseHkdf(chainingKey, ikm) {
  const temp = await hmac(chainingKey, ikm);
  const out1 = await hmac(temp, Uint8Array.of(1));
  const out2 = await hmac(temp, concatBytes(out1, Uint8Array.of(2)));
  return [out1, out2];
}

function nonceBytes(n) {
  const iv = new Uint8Array(12);
  let x = n;
  for (let i = 11; i >= 4; i--) {
    iv[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return iv;
}

/** The prologue for a ledger: "mw-wire-v1" || ledgerId. */
export function prologueFor(ledgerId) {
  return concatBytes(utf8.encode(PROLOGUE_PREFIX), utf8.encode(ledgerId));
}

class CipherState {
  constructor(k = null) {
    this.k = k;
    this.n = 0;
  }

  async encryptWithAd(ad, pt) {
    if (!this.k) return pt;
    if (this.n >= NONCE_MAX) throw new Error('noise nonce exhausted');
    const iv = nonceBytes(this.n++);
    return aesGcmEncrypt(this.k, iv, pt, ad);
  }

  /** Returns null on failure; the counter moves only on success. */
  async decryptWithAd(ad, ct) {
    if (!this.k) return ct;
    if (this.n >= NONCE_MAX) return null;
    const pt = await aesGcmDecrypt(this.k, nonceBytes(this.n), ct, ad);
    if (pt) this.n++;
    return pt;
  }
}

class SymmetricState {
  async init(prologue) {
    const name = utf8.encode(PROTOCOL_NAME);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = await hash(name);
    }
    this.ck = this.h.slice();
    this.cipher = new CipherState();
    await this.mixHash(prologue);
  }

  async mixHash(data) {
    this.h = await hash(concatBytes(this.h, data));
  }

  async mixKey(ikm) {
    const [ck, k] = await noiseHkdf(this.ck, ikm);
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  async encryptAndHash(pt) {
    const ct = await this.cipher.encryptWithAd(this.h, pt);
    await this.mixHash(ct);
    return ct;
  }

  async decryptAndHash(ct) {
    const pt = await this.cipher.decryptWithAd(this.h, ct);
    if (pt === null) return null;
    await this.mixHash(ct);
    return pt;
  }

  async split() {
    const [k1, k2] = await noiseHkdf(this.ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

/**
 * Session: the transport after the handshake. encrypt(pt) and decrypt(ct) run strictly in call order
 * (the counters are the nonces); decrypt returns null on failure (a strike) without moving the counter.
 */
export class Session {
  constructor(send, recv, { remoteStatic, handshakeHash }) {
    this._send = send;
    this._recv = recv;
    this.remoteStatic = remoteStatic; // 'p256:...' chat key of the other side
    this.handshakeHash = handshakeHash;
    this._sendChain = Promise.resolve();
    this._recvChain = Promise.resolve();
  }

  encrypt(pt) {
    const run = this._sendChain.then(() => this._send.encryptWithAd(EMPTY, pt));
    this._sendChain = run.then(() => undefined, () => undefined);
    return run;
  }

  decrypt(ct) {
    const run = this._recvChain.then(() => (ct instanceof Uint8Array && ct.length >= GCM_TAG ? this._recv.decryptWithAd(EMPTY, ct) : null));
    this._recvChain = run.then(() => undefined, () => undefined);
    return run.then((x) => x, () => null);
  }
}

/**
 * new XXHandshake({ staticKey: ChatKey, prologue: Uint8Array, initiator: boolean, ephemeral?: ChatKey,
 *                   payload?: Uint8Array })
 * next(msg?) -> Promise<{ send?: Uint8Array, done?: true, session?: Session } | { error }>
 *   initiator: next() -> { send: msg1 }; next(msg2) -> { send: msg3, done, session }
 *   responder: next(msg1) -> { send: msg2 }; next(msg3) -> { done, session }
 * Payloads (optional, same for every message this side writes) are encrypted where XX encrypts them;
 * received payloads are in `payloads`. Any failure ends the handshake with { error } (a strike).
 */
export class XXHandshake {
  constructor({ staticKey, prologue, initiator, ephemeral = null, payload = EMPTY }) {
    if (!staticKey || typeof staticKey.ecdh !== 'function' || typeof staticKey.pub !== 'string') {
      throw new TypeError('XXHandshake: staticKey must be a ChatKey { pub, ecdh }');
    }
    if (!(prologue instanceof Uint8Array)) throw new TypeError('XXHandshake: prologue must be bytes');
    this.s = staticKey;
    this.prologue = prologue;
    this.initiator = !!initiator;
    this._ephemeral = ephemeral;
    this.payload = payload;
    this.step = 0; // messages processed or written
    this.failed = null;
    this.done = false;
    this.payloads = [];
    this._ready = null;
    this._busy = false;
  }

  async _init() {
    if (!this._ready) {
      this._ready = (async () => {
        this.ss = new SymmetricState();
        await this.ss.init(this.prologue);
        this.e = this._ephemeral || await generateChatKey();
        this.ePub = rawPoint(this.e.pub);
        this.sPub = rawPoint(this.s.pub);
      })();
    }
    return this._ready;
  }

  _fail(reason) {
    this.failed = reason;
    return { error: reason };
  }

  async next(msg) {
    if (this.failed) return { error: this.failed };
    if (this.done) return this._fail('handshake-done');
    if (this._busy) return this._fail('handshake-reentrant');
    this._busy = true;
    try {
      await this._init();
      if (this.initiator) {
        if (this.step === 0) {
          if (msg !== undefined && msg !== null) return this._fail('unexpected-message');
          return { send: await this._write1() };
        }
        if (this.step === 1) {
          const ok = await this._read2(msg);
          if (!ok) return this._fail('xx2');
          const send = await this._write3();
          return this._finish(send);
        }
      } else {
        if (this.step === 0) {
          const ok = await this._read1(msg);
          if (!ok) return this._fail('xx1');
          return { send: await this._write2() };
        }
        if (this.step === 2) {
          const ok = await this._read3(msg);
          if (!ok) return this._fail('xx3');
          return this._finish(undefined);
        }
      }
      return this._fail('handshake-state');
    } catch (_) {
      return this._fail('handshake-error');
    } finally {
      this._busy = false;
    }
  }

  async _finish(send) {
    const [c1, c2] = await this.ss.split();
    const [tx, rx] = this.initiator ? [c1, c2] : [c2, c1];
    this.done = true;
    const session = new Session(tx, rx, { remoteStatic: encodePublicKey(this.rs), handshakeHash: this.ss.h.slice() });
    return send ? { send, done: true, session } : { done: true, session };
  }

  // -> e
  async _write1() {
    await this.ss.mixHash(this.ePub);
    const p = await this.ss.encryptAndHash(this.payload);
    this.step = 1;
    return concatBytes(this.ePub, p);
  }

  async _read1(msg) {
    if (!(msg instanceof Uint8Array) || msg.length < POINT_BYTES) return false;
    this.re = msg.slice(0, POINT_BYTES);
    if (!isOnCurve(this.re)) return false;
    await this.ss.mixHash(this.re);
    const p = await this.ss.decryptAndHash(msg.subarray(POINT_BYTES));
    if (p === null) return false;
    this.payloads.push(p);
    this.step = 1;
    return true;
  }

  // <- e, ee, s, es
  async _write2() {
    await this.ss.mixHash(this.ePub);
    await this.ss.mixKey(await this.e.ecdh(this.re)); // ee
    const sCt = await this.ss.encryptAndHash(this.sPub);
    await this.ss.mixKey(await this.s.ecdh(this.re)); // es: responder static with initiator ephemeral
    const p = await this.ss.encryptAndHash(this.payload);
    this.step = 2;
    return concatBytes(this.ePub, sCt, p);
  }

  async _read2(msg) {
    const sLen = POINT_BYTES + GCM_TAG;
    if (!(msg instanceof Uint8Array) || msg.length < POINT_BYTES + sLen + GCM_TAG) return false;
    this.re = msg.slice(0, POINT_BYTES);
    if (!isOnCurve(this.re)) return false;
    await this.ss.mixHash(this.re);
    await this.ss.mixKey(await this.e.ecdh(this.re)); // ee
    const rs = await this.ss.decryptAndHash(msg.subarray(POINT_BYTES, POINT_BYTES + sLen));
    if (rs === null || !isOnCurve(rs)) return false;
    this.rs = rs;
    await this.ss.mixKey(await this.e.ecdh(this.rs)); // es: initiator ephemeral with responder static
    const p = await this.ss.decryptAndHash(msg.subarray(POINT_BYTES + sLen));
    if (p === null) return false;
    this.payloads.push(p);
    this.step = 2;
    return true;
  }

  // -> s, se
  async _write3() {
    const sCt = await this.ss.encryptAndHash(this.sPub);
    await this.ss.mixKey(await this.s.ecdh(this.re)); // se: initiator static with responder ephemeral
    const p = await this.ss.encryptAndHash(this.payload);
    this.step = 3;
    return concatBytes(sCt, p);
  }

  async _read3(msg) {
    const sLen = POINT_BYTES + GCM_TAG;
    if (!(msg instanceof Uint8Array) || msg.length < sLen + GCM_TAG) return false;
    const rs = await this.ss.decryptAndHash(msg.subarray(0, sLen));
    if (rs === null || !isOnCurve(rs)) return false;
    this.rs = rs;
    await this.ss.mixKey(await this.e.ecdh(this.rs)); // se: responder ephemeral with initiator static
    const p = await this.ss.decryptAndHash(msg.subarray(sLen));
    if (p === null) return false;
    this.payloads.push(p);
    this.step = 3;
    return true;
  }
}
