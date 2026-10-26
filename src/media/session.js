// src/media/session.js: playback and download sessions in the loader (R 2.9.6, 2.8.5; MF-47;
// ARCHITECTURE 15.7; INTERFACES "v0.3 (proposed)" src/media/session.js). Runs in the engine page
// (shell loader or drop-in runtime); the worker side is src/sw/media-route.js.
//
// open() gives site code an origin URL, never a key: /_mw/media/<sid> where sid is 128 random bits,
// valid until sign-out (closeAll), the engine page closing, or 12 hours. The key and the manifest go to
// the worker with mw-session-register over a private MessageChannel, and the worker asks for
// ciphertext chunks on that channel. Without a worker (degraded mode, a drop-in page whose worker is
// not active) the item is decrypted whole into a Blob, only up to the device class cap (E_LIMIT above),
// and the result says mode 'blob' ("Played from memory on this browser."); the Blob's type is the manifest's
// only when it is an allow-listed media type the decrypted bytes sniff as (blobType), else octet-stream.
// A worker that does not answer a register carrying a CryptoKey gets one retry with the raw key bytes.
//
//   new MediaSessions({ sw, random, now, channel, capBytes, URL, keyTransfer })
//     sw: { ready() -> boolean, post(msg, transfer), onMessage?(fn) }   the controlling worker
//     async open(id, { M, fk, readChunk, cancelChunk }) -> { url, poster, mime, duration?, w, h, mode, sid? }
//     async openFile(ref, { name, size, block, readBlock }) -> { url, mode, sid? }
//     close(id) / closeAll() / has(id) / onWorkerMessage(data)

import { MSG, message } from '../sw/protocol.js';
import { importChunkKey, decryptChunk, regionOf, partInfo, mediaError, TAG_BYTES, POSTER_MIMES } from './format.js';
import { sniff, MEDIA_MIMES } from './sniff.js';
import { b64url, hex } from '../chain/canonical.js';

const OCTET = 'application/octet-stream';

/**
 * blobType(mime, firstBytes, allowed) -> the type of a Blob fallback URL: the manifest's type only when it is in the
 * allow-list and the decrypted bytes sniff as that type, else application/octet-stream. The manifest comes from the
 * sender's grant: a blob: URL typed text/html or image/svg+xml would run script at the site origin when opened
 * top-level (code review v0.3).
 */
export function blobType(mime, firstBytes, allowed = MEDIA_MIMES) {
  if (typeof mime !== 'string' || allowed.indexOf(mime) < 0) return OCTET;
  if (!(firstBytes instanceof Uint8Array) || firstBytes.length === 0) return OCTET;
  return sniff(firstBytes.subarray(0, 4096)).mime === mime ? mime : OCTET;
}

export const SESSION_MS = 12 * 60 * 60 * 1000;
export const REGISTER_TIMEOUT_MS = 5000;
export const BLOB_TEXT = 'Played from memory on this browser.';
export const MEDIA_PREFIX = '/_mw/media/';
export const FILE_PREFIX = '/_mw/f/';

function defaultChannel() {
  const c = new MessageChannel();
  return { port1: c.port1, port2: c.port2 };
}

export class MediaSessions {
  constructor(opts = {}) {
    this.sw = opts.sw || null;
    this.random = typeof opts.random === 'function' ? opts.random : (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.channel = typeof opts.channel === 'function' ? opts.channel : defaultChannel;
    this.capBytes = Number.isSafeInteger(opts.capBytes) ? opts.capBytes : 25 * 1024 * 1024;
    this.URL = opts.URL || globalThis.URL;
    this.keyTransfer = opts.keyTransfer === 'raw' ? 'raw' : 'cryptokey';
    this.registerTimeoutMs = opts.registerTimeoutMs || REGISTER_TIMEOUT_MS;
    this.sessions = new Map(); // id -> session
    if (this.sw && typeof this.sw.onMessage === 'function') this.sw.onMessage((data) => this.onWorkerMessage(data));
  }

  has(id) {
    const s = this.sessions.get(id);
    return Boolean(s && s.exp > this.now());
  }

  _sid() {
    return hex.encode(this.random(16));
  }

  _workerReady() {
    try {
      return Boolean(this.sw && typeof this.sw.ready === 'function' && this.sw.ready());
    } catch (_) {
      return false;
    }
  }

  async _register(s) {
    const { port1, port2 } = this.channel();
    s.port = port1;
    s.cancelled = null; // request ids are the worker's: a new registration (a restarted worker) numbers them again
    if (!this._pendingRegisters) this._pendingRegisters = new Set();
    const pending = this._pendingRegisters;
    const reply = new Promise((resolve) => {
      let timer = null;
      let entry = null;
      const settle = (d) => {
        clearTimeout(timer);
        pending.delete(entry);
        resolve(d);
      };
      // mw-message-error (code review v0.3, round 2): the worker could not read a message of this page; a register that
      // carried a CryptoKey ends at once and open() retries with the raw key bytes.
      entry = { s, fail: () => settle({ ok: false, error: 'messageerror' }) };
      pending.add(entry);
      timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), this.registerTimeoutMs);
      port1.onmessage = (e) => {
        const d = e && e.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'mw-ack' && d.of === MSG.sessionRegister) {
          settle(d);
          return;
        }
        if (d.type === MSG.chunkNeed) this._answer(s, d);
        else if (d.type === MSG.chunkCancel) this._cancel(s, d);
      };
      if (typeof port1.start === 'function') port1.start();
    });
    const base = { sid: s.sid, kind: s.kind, exp: s.exp };
    let msg;
    if (s.kind === 'media') {
      let fk = s.fkRaw;
      if (this.keyTransfer === 'cryptokey') fk = await importChunkKey(s.fkRaw);
      msg = message(MSG.sessionRegister, Object.assign(base, { M: s.M, fk }));
    } else {
      msg = message(MSG.sessionRegister, Object.assign(base, { file: s.file }));
    }
    try {
      this.sw.post(msg, [port2]);
    } catch (err) {
      if (s.kind === 'media' && err && err.name === 'DataCloneError') {
        // a non-extractable CryptoKey that does not clone into the worker (lab row G-MD-6): raw bytes
        this.keyTransfer = 'raw';
        msg.fk = s.fkRaw;
        this.sw.post(msg, [port2]);
      } else {
        throw err;
      }
    }
    return reply;
  }

  /**
   * _cancel(s, { req, i }): the worker's range stream was cancelled (mw-chunk-cancel, code review v0.3): nobody waits for this
   * chunk now, so its read is not answered and its piece leaves the front of the download (the lane's cancelChunk:
   * FileTorrentHandle.deprioritize), and a seek the player abandoned stops pulling its pieces ahead of the rest.
   */
  _cancel(s, d) {
    if (!s.cancelled) s.cancelled = new Set();
    if (s.cancelled.size >= 1024) s.cancelled.clear();
    s.cancelled.add(d.req);
    if (typeof s.cancelChunk === 'function' && Number.isSafeInteger(d.i) && d.i >= 0) {
      try {
        s.cancelChunk(d.i);
      } catch (_) { /* the item went away */ }
    }
  }

  async _answer(s, d) {
    let out;
    const transfer = [];
    try {
      const bytes = s.kind === 'media' ? await s.readChunk(d.i) : await s.readBlock(d.i);
      const copy = bytes.slice();
      out = { type: MSG.chunk, req: d.req, i: d.i, data: copy.buffer };
      transfer.push(copy.buffer);
    } catch (err) {
      out = { type: MSG.chunk, req: d.req, i: d.i, error: err && typeof err.code === 'string' ? err.code : 'E_FILE_UNAVAILABLE' };
    }
    if (s.cancelled && s.cancelled.delete(d.req)) return; // the stream let go of this chunk while it was read
    try {
      s.port.postMessage(out, transfer);
    } catch (_) { /* the worker went away; it will ask again */ }
  }

  /**
   * open(id, { M, fk, readChunk, cancelChunk }) -> { url, poster, mime, duration?, w, h, mode, sid? }. fk: 32 raw bytes
   * (kept in this engine page and the worker only). readChunk(i) -> Promise<Uint8Array> of ciphertext; cancelChunk(i), optional:
   * the worker no longer needs chunk i (mw-chunk-cancel).
   */
  async open(id, { M, fk, readChunk, cancelChunk = null }) {
    this._sweep();
    const existing = this.sessions.get(id);
    if (existing && existing.kind === 'media' && existing.exp > this.now()) return existing.result;
    if (existing) this.close(id);
    const media = partInfo(M, 'media');
    const poster = partInfo(M, 'poster');
    const head = { mime: M.mime, w: M.w, h: M.h };
    if (M.duration !== undefined) head.duration = M.duration;
    if (this._workerReady()) {
      const s = { id, kind: 'media', sid: this._sid(), exp: this.now() + SESSION_MS, M, fkRaw: fk, readChunk, cancelChunk };
      let ack = await this._register(s);
      if (ack && !ack.ok && (ack.error === 'timeout' || ack.error === 'messageerror') && this.keyTransfer === 'cryptokey') {
        // A CryptoKey can clone in the page and still fail to deserialize in the worker ('messageerror' there, nothing
        // here): one retry with the raw bytes before the capped Blob path, remembered for later opens (R 2.9.6, G-MD-6;
        // code review v0.3).
        try {
          s.port.close();
        } catch (_) { /* nothing to close */ }
        this.keyTransfer = 'raw';
        ack = await this._register(s);
        if (!ack || !ack.ok) this.keyTransfer = 'cryptokey';
      }
      if (ack && ack.ok) {
        const url = MEDIA_PREFIX + s.sid;
        s.result = Object.assign({ url, poster: poster.size ? url + '?part=poster' : null, mode: 'worker', sid: s.sid }, head);
        this.sessions.set(id, s);
        return s.result;
      }
      try {
        s.port.close();
      } catch (_) { /* nothing to close */ }
    }
    // Blob fallback: the whole item from memory, up to the class cap
    if (media.size + poster.size > this.capBytes) throw mediaError('E_LIMIT', 'too large to play from memory on this browser');
    const key = await importChunkKey(fk);
    const fid = b64url.decode(M.fid);
    const base = b64url.decode(M.base);
    const part = async (info, allowed) => {
      const C = M.P - TAG_BYTES;
      const parts = [];
      let left = info.size;
      for (let i = info.first; i < info.end && left > 0; i++) {
        const pt = await decryptChunk(key, base, fid, i, M.total, regionOf(M, i), await readChunk(i));
        const take = Math.min(C, left);
        parts.push(take === C ? pt : pt.subarray(0, take));
        left -= take;
      }
      return new Blob(parts, { type: blobType(info.mime, parts[0], allowed) });
    };
    const urls = [];
    const url = this.URL.createObjectURL(await part(media, MEDIA_MIMES));
    urls.push(url);
    let posterUrl = null;
    if (poster.size) {
      posterUrl = this.URL.createObjectURL(await part(poster, POSTER_MIMES));
      urls.push(posterUrl);
    }
    const s = { id, kind: 'media', blob: true, urls, exp: this.now() + SESSION_MS };
    s.result = Object.assign({ url, poster: posterUrl, mode: 'blob', note: BLOB_TEXT }, head);
    this.sessions.set(id, s);
    return s.result;
  }

  /**
   * openFile(ref, { name, size, block, readBlock }) -> { url, mode, sid? }: /_mw/f/<sid> through the worker,
   * else a Blob URL (typed application/octet-stream) up to the class cap.
   */
  async openFile(ref, { name, size, block, readBlock }) {
    this._sweep();
    const key = 'file:' + ref;
    if (this.sessions.has(key)) this.close(key);
    if (this._workerReady()) {
      const s = { id: key, kind: 'file', sid: this._sid(), exp: this.now() + SESSION_MS, file: { name, size, block }, readBlock };
      const ack = await this._register(s);
      if (ack && ack.ok) {
        s.result = { url: FILE_PREFIX + s.sid, mode: 'worker', sid: s.sid };
        this.sessions.set(key, s);
        return s.result;
      }
    }
    if (size > this.capBytes) throw mediaError('E_LIMIT', 'too large to save from memory on this browser');
    const parts = [];
    for (let i = 0; i * block < size; i++) parts.push(await readBlock(i));
    const url = this.URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
    const s = { id: key, kind: 'file', blob: true, urls: [url], exp: this.now() + SESSION_MS };
    s.result = { url, mode: 'blob' };
    this.sessions.set(key, s);
    return s.result;
  }

  /** close(id): ends the session early (mw.media.close); revokes Blob URLs. */
  close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    if (s.blob) {
      for (const u of s.urls) {
        try {
          this.URL.revokeObjectURL(u);
        } catch (_) { /* already revoked */ }
      }
      return true;
    }
    try {
      if (this.sw) this.sw.post(message(MSG.sessionClose, { sid: s.sid }), []);
    } catch (_) { /* no worker */ }
    try {
      if (s.port && typeof s.port.close === 'function') s.port.close();
    } catch (_) { /* closed */ }
    return true;
  }

  closeFile(ref) {
    return this.close('file:' + ref);
  }

  /** closeAll(): sign-out and page hide end every session. */
  closeAll() {
    for (const id of Array.from(this.sessions.keys())) this.close(id);
  }

  _sweep() {
    const t = this.now();
    for (const [id, s] of Array.from(this.sessions.entries())) if (s.exp <= t) this.close(id);
  }

  /** onWorkerMessage(data): mw-session-lost { sid } from a restarted worker registers that session again. */
  onWorkerMessage(data) {
    if (data && data.type === MSG.messageError) {
      // Which message failed is not said; only registers that sent a CryptoKey can fail this way, so those end now.
      let n = 0;
      for (const entry of Array.from(this._pendingRegisters || [])) {
        if (this.keyTransfer === 'cryptokey' && entry.s && entry.s.kind === 'media') {
          entry.fail();
          n++;
        }
      }
      return n > 0;
    }
    if (!data || data.type !== MSG.sessionLost || typeof data.sid !== 'string') return false;
    for (const s of this.sessions.values()) {
      if (s.sid === data.sid && !s.blob && s.exp > this.now()) {
        this._register(s).catch(() => {});
        return true;
      }
    }
    return false;
  }
}
