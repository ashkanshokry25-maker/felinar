// src/media/lane.js: the private media lane in the loader (R 2.9; ARCHITECTURE 15.7; INTERFACES "v0.3
// (proposed)" src/media/*). Upload pipeline, own copies, grants, playback sessions, revocation and
// deletion. Everything is injected (keys, the ledger node, the torrent seam, the chat service, the
// sealed-item codec, the chunk store, the stripping and poster functions), so Node tests run it with fakes.
//
// Upload (R 2.9.3): sniff (E_MEDIA_TYPE outside R 2.9.2) -> strip metadata (E_MEDIA_STRIP; private media
// may go on as uploaded after the person chooses "Upload anyway (may include your location)") ->
// faststart for MP4 -> poster on the device -> the upload card -> encrypt, pad and store chunk by chunk
// (src/media/format.js) -> the own-index item (mw.s, kind 3) -> seed to the site's own tracker only.
// Keys (R 2.9.4): fid, fk, base and the x-mw-nonce are random per item; fk never leaves this lane except
// inside a sealed own-index item, a grant sealed by the chat service, and the worker session.
//
//   new MediaLane(deps)
//     upload(file, { onProgress, signal, keepOriginal }) / list({ from }) / open(id, { part })
//     close(id) / share(id, { to, durable }) / revoke(id, { from, reencrypt }) / delete(id)
//     keepAvailable(id, on) / pinRequest(id) / onGrant(fromPub, grant) / accept(id) / restore()
//
// v0.3 C2 (lane seed-engine; SZ 3.1.2, 3.1.5; R 2.9.8, 2.9.11): an own upload seeds in the H lane (the per-upload
// exception; on phones after the MF-45 card 'phone-upload'), "Keep available" is K, an opened item E. list() keeps
// 'available' ('kept' only with E3 or E4 evidence now: a ws field alone is no longer "kept") and adds evidence
// { tier, count, atLeast, reported, checkedAt }, a label key of src/loader/availability.js and labelParams; own items
// carry handoff { state }: onlyHere -> waiting -> sending -> kept. With _mw.cfg.pin set, an upload by the site owner
// goes to the pin queue at once (owner decision SZ-6). A label never joins a swarm: only open, accept and Keep do.

import { mediaType, sniff, SNIFF_BYTES } from './sniff.js';
import { stripperFor } from './strip.js';
import {
  plan, newSecrets, encryptChunk, decryptChunk, buildManifest, checkManifest, regionOf, idOf, mediaError,
  REGION, FK_BYTES,
} from './format.js';
import { randomName } from '../files/names.js';
import { imageSize, PIXEL_CAP } from '../files/preview.js';
import { encode } from '../common/bencode.js';
import { validateFileTorrent } from '../files/validate.js';
import { listOf } from '../files/lane.js';
import { b64url, hex, utf8 } from '../chain/canonical.js';
import { evidence as availabilityEvidence, availableOf, publicEvidence, handoffState } from '../loader/availability.js';

export const OWN_KIND = 3;
export const GRANT_KIND = 4;
export const CAPS = Object.freeze({ desktop: 100 * 1024 * 1024, phone: 25 * 1024 * 1024 });
export const CHUNK_WAIT_MS = 60000;
/**
 * After a reload, the person's own items kept on this device join their swarms again (lane K, the "kept" lane, under the
 * device's sharing budget), so the people they were shared with can still fetch them (code review v0.3, round 2): at most this
 * many, newest first (chosen; each swarm is one more tracker announce and wire budget share).
 */
export const RESEED_MAX = 8;
export const STRIP_FAILED_CHOICE = 'Upload anyway (may include your location)';
export const UNAVAILABLE_TEXT = 'Nobody who has this video is online right now.';
export const REVOKE_TEXT = 'People you shared with may have kept a copy. Revoking stops new viewing in honest apps only.';

const isPhone = (deviceClass) => typeof deviceClass === 'string' && deviceClass !== 'desktop';

/** capFor(deviceClass) -> the per-item cap of R 2.8.8 (desktop 100 MiB until G-FI-5, phones 25 MiB). */
export function capFor(deviceClass) {
  return isPhone(deviceClass) ? CAPS.phone : CAPS.desktop;
}

async function sha1(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', bytes));
}

/** buildInfo({ P, total, pieces, nonce }) -> the info dictionary of a private media or file torrent. */
export function buildInfo({ P, total, pieces, nonce, name = 'mw' }) {
  return { length: total * P, name: utf8.encode(name), 'piece length': P, pieces, private: 1, 'x-mw-nonce': nonce };
}

/** torrentOf(info) -> { torrentFile, infoHash } */
export async function torrentOf(info) {
  const infoBytes = encode(info);
  return { torrentFile: encode({ info }), infoHash: hex.encode(await sha1(infoBytes)) };
}

function aborted(signal) {
  if (signal && signal.aborted) throw mediaError('E_USER_CANCELLED', 'cancelled');
}

async function readRange(blob, start, len) {
  return new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
}

export class MediaLane {
  constructor(deps = {}) {
    this.d = deps;
    this.items = new Map(); // id -> record
    this.revoked = new Set(); // ids revoked by their sender (open -> E_REVOKED)
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, data) {
    const set = this.listeners.get(event);
    if (set) for (const fn of Array.from(set)) {
      try {
        fn(data);
      } catch (_) { /* a listener's failure is its own */ }
    }
    if (typeof this.d.emit === 'function') this.d.emit(event, data);
  }

  _keys() {
    const k = typeof this.d.keys === 'function' ? this.d.keys() : this.d.keys;
    if (!k || !k.pub) throw mediaError('E_NOT_SIGNED_IN', 'sign in first');
    return k;
  }

  _random(n) {
    return typeof this.d.random === 'function' ? this.d.random(n) : globalThis.crypto.getRandomValues(new Uint8Array(n));
  }

  _now() {
    return typeof this.d.now === 'function' ? this.d.now() : Date.now();
  }

  _store(name, P, length) {
    return this.d.makeStore({ name, chunkLength: P, length });
  }

  _announce() {
    return this.d.ownTracker ? [this.d.ownTracker] : [];
  }

  _hostOnly() {
    return typeof this.d.hostOnly === 'function' ? Boolean(this.d.hostOnly()) : Boolean(this.d.hostOnly);
  }

  async _seed(rec, { torrentFile, infoHash, lane = null }) {
    if (this._hostOnly()) return null; // host-only mode: no swarm, local chunks only
    if (!this.d.torrents || typeof this.d.torrents.addFileTorrent !== 'function') return null;
    // Review round (MAL53-3): every join of a swarm (upload, open, accept, Keep available, the re-seed after a reload) checks
    // _deny/ first, and a _deny/ entry that arrives later reaches a running handle (_watch, denySweep).
    if (rec.denied || (await this._isDenied(rec))) {
      this._takeDown(rec);
      throw mediaError('E_DENIED', 'a moderator removed this item');
    }
    this._watch();
    const opts = { store: this.d.storeClass ? this.d.storeClass(rec.storeName) : rec.store, announce: this._announce(), retain: true };
    if (torrentFile) opts.torrentFile = torrentFile;
    else opts.infoHash = infoHash;
    // C2 seed-engine: the seed lane (H for an own upload, with the per-upload exception; K kept; E by default).
    if (lane === 'H') Object.assign(opts, { uploadException: true, lane: 'H' });
    else if (lane === 'K') opts.lane = 'K';
    // MAL53-6: the grant's chunk count times its piece length bounds the metadata a peer may announce.
    const M = rec.M;
    if (M && Number.isSafeInteger(M.total) && Number.isSafeInteger(M.P) && M.total > 0 && M.P > 0) opts.expectedLength = M.total * M.P;
    const handle = await this.d.torrents.addFileTorrent(opts);
    rec.handle = handle;
    if (handle && typeof handle.on === 'function') {
      handle.on('verified', (i) => this._wake(rec, i));
      handle.on('done', () => { rec.complete = true; }); // C2 seed-engine: every piece here (E0)
    }
    return handle;
  }

  async _isDenied(rec) {
    if (typeof this.d.isDenied !== 'function' || !rec || !rec.M) return false;
    try {
      return Boolean(await this.d.isDenied(rec.M.ih));
    } catch (_) {
      return false;
    }
  }

  /** _watch(): once, subscribe to the ledger node so a _deny/ entry that arrives later reaches running handles (MAL53-3). */
  _watch() {
    if (this._unwatch !== undefined) return;
    this._unwatch = null;
    const n = this.d.node;
    if (!n || typeof n.subscribe !== 'function' || typeof this.d.isDenied !== 'function') return;
    try {
      const off = n.subscribe(() => { this.denySweep().catch(() => {}); });
      this._unwatch = typeof off === 'function' ? off : null;
    } catch (_) {
      this._unwatch = null;
    }
  }

  unwatch() {
    if (typeof this._unwatch === 'function') {
      try {
        this._unwatch();
      } catch (_) { /* gone */ }
    }
    this._unwatch = undefined;
  }

  /** denySweep() -> how many items were taken down (every item with a handle or a local copy is checked again). */
  denySweep() {
    if (this._sweeping) {
      this._sweepAgain = true;
      return this._sweeping;
    }
    this._sweeping = (async () => {
      let n = 0;
      do {
        this._sweepAgain = false;
        for (const rec of Array.from(this.items.values())) {
          if (rec.denied || rec.state === 'offer') continue;
          if (await this._isDenied(rec)) {
            this._takeDown(rec);
            n++;
          }
        }
      } while (this._sweepAgain);
      return n;
    })().finally(() => { this._sweeping = null; });
    return this._sweeping;
  }

  /**
   * _takeDown(rec): a moderator denied this item. Its handle stops; a received item is forgotten with its copy and its kept
   * grant; the person's own item keeps its bytes here but never joins a swarm again (rec.denied).
   */
  _takeDown(rec) {
    rec.denied = true;
    if (rec.from === 'mine') {
      if (rec.handle && typeof rec.handle.destroy === 'function') {
        try {
          rec.handle.destroy({ keepStore: true });
        } catch (_) { /* gone */ }
      }
      rec.handle = null;
      return;
    }
    if (this.items.get(rec.id) !== rec) return;
    this._forget(rec);
    this.emit('revoked', { id: rec.id, from: rec.from, denied: true });
  }

  /**
   * _checkedChunk(rec, i) -> the ciphertext of chunk i for a session. When i is the first chunk of a received picture (the
   * item or its poster), it is decrypted here first and refused (E_MEDIA_TYPE) when the header asks for more than PIXEL_CAP
   * pixels, or when a GIF's first frame is not inside that chunk (review round, MAL53-2: a decoder grows a GIF's screen to
   * its first frame), so the bytes never reach a decoder.
   */
  async _checkedChunk(rec, i) {
    const ct = await this._chunk(rec, i);
    const M = rec.M;
    if (rec.from === 'mine') return ct;
    const parts = [];
    if (M.kind === 'image' && M.regions.media[0] === i) parts.push({ mime: M.mime, size: M.len });
    if (M.plen && M.regions.poster[0] === i) parts.push({ mime: M.pmime, size: M.plen });
    for (const p of parts) {
      if (typeof p.mime !== 'string' || p.mime.indexOf('image/') !== 0) continue;
      const pt = await decryptChunk(rec.fk, b64url.decode(M.base), b64url.decode(M.fid), i, M.total, regionOf(M, i), ct);
      const size = imageSize(pt.subarray(0, Math.min(pt.length, p.size)), p.mime);
      if ((!size && p.mime === 'image/gif') || (size && (size.w * size.h > PIXEL_CAP || size.w * size.h === 0))) {
        throw mediaError('E_MEDIA_TYPE', 'this picture is too large to show safely');
      }
    }
    return ct;
  }

  // ---- C2 seed-engine: lanes, evidence, labels, the owner's automatic pin request (SZ 3.1.2, 3.1.5, SZ-6) ----------

  _cfg() {
    try {
      return typeof this.d.cfg === 'function' ? this.d.cfg() || {} : this.d.cfg || {};
    } catch (_) {
      return {};
    }
  }

  /** The lane of an own upload: H, on phones only after the MF-45 card (declined: K, nothing on mobile data). */
  async _ownLane() {
    if (!isPhone(this.d.deviceClass)) return 'H';
    const ok = await this.d.prompt({ kind: 'phone-upload' });
    return ok ? 'H' : 'K';
  }

  _ownerKey() {
    try {
      if (typeof this.d.owner === 'function') return this.d.owner() || null;
      if (typeof this.d.owner === 'string') return this.d.owner;
      const n = this.d.node;
      return n && typeof n.owner === 'string' ? n.owner : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * _pinKey() -> the pin node's key in effect, or null: deps.pinKey() when the loader passes it (only a _mw.cfg written with owner
   * standing names the pin, api.js ownerCfgPin; code review v0.3, security 13), else _mw.cfg.pin (tests and older callers).
   */
  _pinKey() {
    if (typeof this.d.pinKey === 'function') {
      try {
        const k = this.d.pinKey();
        return typeof k === 'string' && k ? k : null;
      } catch (_) {
        return null;
      }
    }
    const c = this._cfg();
    return typeof c.pin === 'string' && c.pin ? c.pin : null;
  }

  /** SZ-6: a pin key in effect and the uploader is the site owner: the own item goes to the pin queue without a click. */
  async _autoPin(rec, keys) {
    if (!this._pinKey() || !keys || !keys.pub || keys.pub !== this._ownerKey()) return false;
    if (!this.d.pin || typeof this.d.pin.request !== 'function') return false;
    try {
      await this.d.pin.request({ ih: rec.M.ih, size: rec.M.total * rec.M.P, author: keys.pub, auto: true });
      rec.pinRequested = true;
      return true;
    } catch (_) {
      return false; // the person can still ask from the UI
    }
  }

  _evidenceOf(rec) {
    const h = rec.handle;
    let inputs = null;
    try {
      if (h && typeof h.evidenceInputs === 'function') inputs = h.evidenceInputs();
      else if (typeof this.d.evidenceInputs === 'function') inputs = this.d.evidenceInputs(rec.M.ih);
    } catch (_) {
      inputs = null;
    }
    const i = inputs && typeof inputs === 'object' ? inputs : {};
    const now = Number.isFinite(i.now) ? i.now : this._now();
    let pin = i.pin && typeof i.pin === 'object' ? Object.assign({}, i.pin) : null;
    if (!pin && typeof this.d.pinEvidence === 'function') {
      try {
        pin = this.d.pinEvidence(rec.M.ih, now) || null;
      } catch (_) {
        pin = null;
      }
    }
    pin = Object.assign({ receipt: null, heartbeat: null }, pin || {}, { configured: Boolean((pin && pin.configured) || this._pinKey()) });
    const local = Boolean(i.local) || Boolean(rec.complete);
    const ev = availabilityEvidence(Object.assign({}, i, { local, pin, now }));
    ev.pinPct = Number.isFinite(i.pinPct) ? i.pinPct : null;
    return ev;
  }

  /**
   * 'available' as in v0.3, now from evidence: 'kept' only with E3 or E4. A seam that reports no evidence (an older
   * TorrentManager) keeps the v0.3 'online' rule for an own copy in the swarm or a handle with peers.
   */
  _availability(rec) {
    const ev = this._evidenceOf(rec);
    const h = rec.handle;
    let available = availableOf(ev);
    if (available === 'unknown' && h && typeof h.evidenceInputs !== 'function' && (rec.from === 'mine' || h.numPeers > 0 || h.peers > 0)) available = 'online';
    const out = { available, evidence: publicEvidence(ev), label: ev.label, labelParams: Object.assign({}, ev.params) };
    if (rec.from === 'mine') {
      const hs = handoffState({ ev, requested: Boolean(rec.pinRequested), pinPct: ev.pinPct });
      out.label = hs.label;
      out.labelParams = Object.assign({}, hs.params);
      out.handoff = Object.assign({ state: hs.state }, hs.params);
    }
    return out;
  }

  _wake(rec, i) {
    const w = rec.waiters && rec.waiters.get(i);
    if (!w) return;
    rec.waiters.delete(i);
    for (const fn of w) fn();
  }

  async _progress(onProgress, phase, done, total) {
    const p = { phase, done, total };
    if (typeof onProgress === 'function') {
      try {
        onProgress(p);
      } catch (_) { /* the caller's */ }
    }
    this.emit('progress', p);
  }

  async _strip(file, sniffed, keepOriginal) {
    const kind = stripperFor(sniffed.mime);
    const s = this.d.strip || {};
    if (keepOriginal) {
      const ok = await this.d.prompt({ kind: 'media-keep-original', text: 'The original may contain your location' });
      if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
      return { blob: file, removed: [], kept: true, mime: sniffed.mime };
    }
    try {
      if (kind === 'image') {
        const r = await s.stripImage(file);
        return { blob: r.blob, removed: r.removed, mime: r.mime || r.blob.type || sniffed.mime, w: r.w, h: r.h };
      }
      if (kind === 'mp4') {
        const r = await s.stripMp4(file);
        return { blob: r.blob, removed: r.removed, mime: sniffed.mime, location: r.location };
      }
      if (kind === 'webm') {
        const r = await s.stripWebm(file);
        return { blob: r.blob, removed: r.removed, mime: sniffed.mime };
      }
    } catch (err) {
      if (!err || err.code !== 'E_MEDIA_STRIP') throw err;
      const go = await this.d.prompt({ kind: 'media-strip-failed', choice: STRIP_FAILED_CHOICE });
      if (!go) throw mediaError('E_MEDIA_STRIP', err.message);
      return { blob: file, removed: [], stripFailed: true, mime: sniffed.mime };
    }
    throw mediaError('E_MEDIA_TYPE', 'no metadata removal for ' + sniffed.mime);
  }

  /** upload(file, opts) -> { id, kind, mime, len, duration?, w, h } (R 2.9.11). */
  async upload(file, { onProgress, signal, keepOriginal = false } = {}) {
    const keys = this._keys();
    if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') throw mediaError('E_MEDIA_TYPE', 'not a file');
    const cap = capFor(this.d.deviceClass);
    if (file.size > cap) throw mediaError('E_LIMIT', 'over the ' + cap + '-byte cap of this device');
    const head = await readRange(file, 0, SNIFF_BYTES);
    let sniffed = sniff(head);
    const heic = sniffed.mime === 'image/heic';
    if (!heic) sniffed = mediaType(head); // E_MEDIA_TYPE outside R 2.9.2
    aborted(signal);
    await this._progress(onProgress, 'strip', 0, 1);
    let stripped;
    if (heic) {
      // HEIC becomes JPEG where the browser decodes it, else it is refused
      try {
        const r = await this.d.strip.stripImage(file, { type: 'image/jpeg' });
        stripped = { blob: r.blob, removed: r.removed, mime: 'image/jpeg', w: r.w, h: r.h };
      } catch (_) {
        throw mediaError('E_MEDIA_TYPE', 'No preview for this format');
      }
    } else {
      stripped = await this._strip(file, sniffed, keepOriginal);
    }
    let blob = stripped.blob;
    const mime = stripped.mime;
    if ((mime === 'video/mp4' || mime === 'video/quicktime') && typeof this.d.faststart === 'function') {
      try {
        blob = (await this.d.faststart(blob)).blob;
      } catch (_) { /* upload as is: playback first fetches the last piece */ }
    }
    if (blob.size > cap) throw mediaError('E_LIMIT', 'over the cap after re-encoding');
    await this._progress(onProgress, 'strip', 1, 1);
    aborted(signal);
    await this._progress(onProgress, 'poster', 0, 1);
    const kind = mime.indexOf('video/') === 0 ? 'video' : 'image';
    let poster = null;
    try {
      poster = typeof this.d.makePoster === 'function' ? await this.d.makePoster(blob, { kind, mime }) : null;
    } catch (_) {
      poster = null; // a video this browser cannot decode still uploads, without a poster
    }
    await this._progress(onProgress, 'poster', 1, 1);
    const w = (poster && poster.w) || stripped.w || 0;
    const h = (poster && poster.h) || stripped.h || 0;
    const duration = poster && Number.isFinite(poster.duration) ? poster.duration : undefined;
    const ok = await this.d.prompt({
      kind: 'media-upload', size: blob.size, mime, removed: stripped.removed, stripFailed: Boolean(stripped.stripFailed),
      keptOriginal: Boolean(stripped.kept), text: stripped.removed.length ? 'Location and camera details removed' : '',
      preview: Boolean(poster && poster.blob), note: poster && !poster.blob && poster.note ? poster.note : '',
    });
    if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    aborted(signal);
    const secrets = newSecrets((n) => this._random(n));
    const posterBlob = poster && poster.blob ? poster.blob : null;
    const p = plan({ posterBytes: posterBlob ? posterBlob.size : 0, mediaBytes: blob.size });
    const id = hex.encode(secrets.fid);
    const storeName = 'm-' + id;
    const store = this._store(storeName, p.P, p.total * p.P);
    const pieces = new Uint8Array(p.total * 20);
    const regions = p.regions;
    const fakeM = { regions, total: p.total };
    try {
      for (let i = 0; i < p.total; i++) {
        aborted(signal);
        const region = regionOf(fakeM, i);
        const pt = new Uint8Array(p.C);
        if (region === REGION.poster) pt.set(await readRange(posterBlob, (i - regions.poster[0]) * p.C, p.C));
        else if (region === REGION.media) pt.set(await readRange(blob, (i - regions.media[0]) * p.C, p.C));
        const ct = await encryptChunk(secrets.fk, secrets.base, secrets.fid, i, p.total, region, pt);
        await store.putAsync(i, ct);
        pieces.set(await sha1(ct), i * 20);
        await this._progress(onProgress, 'encrypt', i + 1, p.total);
      }
    } catch (err) {
      await new Promise((resolve) => store.destroy(resolve));
      throw err;
    }
    const info = buildInfo({ P: p.P, total: p.total, pieces, nonce: secrets.swarmNonce });
    const t = await torrentOf(info);
    const ext = mime === 'video/mp4' ? 'mp4' : mime === 'video/webm' ? 'webm' : mime === 'video/quicktime' ? 'mov' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
    const M = buildManifest({
      fid: secrets.fid, kind, mime, len: blob.size, duration, w, h, P: p.P, base: secrets.base, regions, total: p.total,
      ih: t.infoHash, name: randomName(kind === 'video' ? 'video' : 'image', ext, (n) => this._random(n)), t: this._now(),
      plen: posterBlob ? posterBlob.size : 0, pmime: posterBlob ? (poster.mime || 'image/jpeg') : '',
    });
    const rec = { id, from: 'mine', M, fk: secrets.fk, store, storeName, handle: null, state: 'ready', grants: new Map(), keep: true, ownH: null, t: M.t, complete: true };
    const lane = await this._ownLane(); // C2 seed-engine: H, after the MF-45 card on phones
    this.items.set(id, rec);
    await this._progress(onProgress, 'seed', 0, 1);
    rec.ownH = await this._writeOwn(rec, keys, { signal, onProgress });
    await this._seed(rec, { torrentFile: t.torrentFile, lane });
    await this._autoPin(rec, keys); // C2 seed-engine: SZ-6
    await this._progress(onProgress, 'seed', 1, 1);
    const out = { id, kind, mime, len: M.len, w: M.w, h: M.h };
    if (M.duration !== undefined) out.duration = M.duration;
    this.emit('shared', { id, kind: 'own' });
    return out;
  }

  /** The device's sealed home of an item's keys (src/media/vault.js): own items and accepted grants (R 2.9.4, MF-72). */
  async _keep(rec) {
    if (!this.d.vault || typeof this.d.vault.put !== 'function') return false;
    const value = { v: 1, kind: rec.from === 'mine' ? 'own' : 'grant', from: rec.from, M: rec.M, fk: b64url.encode(rec.fk), t: rec.t };
    if (rec.previous && rec.previous.length) value.previous = rec.previous.slice();
    try {
      return Boolean(await this.d.vault.put('media:' + rec.id, value));
    } catch (_) {
      return false; // the ledger copy, when there is one, is the other home
    }
  }

  _unkeep(id) {
    if (this.d.vault && typeof this.d.vault.del === 'function') Promise.resolve().then(() => this.d.vault.del('media:' + id)).catch(() => {});
  }

  async _writeOwn(rec, keys, opts) {
    // Always kept on this device: a reader on an owner-only site (or a person who may not write) has no ledger copy,
    // and without this the key would live only in memory (code review v0.3).
    await this._keep(rec);
    const payload = utf8.encode(JSON.stringify({ M: rec.M, fk: b64url.encode(rec.fk) }));
    const node = this.d.node;
    const canWrite = node && typeof node.append === 'function' && (typeof this.d.canWrite !== 'function' || this.d.canWrite());
    if (!canWrite || !this.d.sealed || typeof this.d.sealed.seal !== 'function' || !keys.own) return null;
    const value = await this.d.sealed.seal({ kind: OWN_KIND, data: payload, key: keys.own, ledgerId: this.d.ledgerId, authorPub: keys.pub });
    const r = await node.append('mw.s', value, opts);
    return r && r.h ? r.h : (typeof r === 'string' ? r : null);
  }

  /** An item from the device's sealed store (own or an accepted grant); true when it was added. */
  _fromVault(v, keys) {
    if (!v || typeof v !== 'object' || v.v !== 1) return false;
    const M = checkManifest(v.M);
    const id = idOf(M);
    if (this.items.has(id) || this.revoked.has(id)) return false;
    const fk = b64url.decode(v.fk);
    if (fk.length !== FK_BYTES) return false;
    const own = v.kind === 'own';
    if (!own && (v.kind !== 'grant' || typeof v.from !== 'string' || v.from === keys.pub)) return false;
    const storeName = 'm-' + id;
    const previous = own && Array.isArray(v.previous) ? v.previous.filter((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)).slice(0, 16) : [];
    this.items.set(id, {
      id, from: own ? 'mine' : v.from, M, fk, store: this._store(storeName, M.P, M.total * M.P), storeName, handle: null, state: 'ready',
      grants: new Map(), keep: own, ownH: null, t: Number.isSafeInteger(v.t) ? v.t : M.t, previous,
    });
    return true;
  }

  /**
   * ready() -> Promise: restore() once per signed-in key; the service waits for it before list, open and the other
   * calls, so items kept on this device or in the ledger are there after a reload.
   */
  ready() {
    let keys;
    try {
      keys = this._keys();
    } catch (_) {
      return Promise.resolve(0);
    }
    if (this._restoring && this._restoring.pub === keys.pub) return this._restoring.p;
    const p = this.restore().catch(() => 0);
    this._restoring = { pub: keys.pub, p };
    return p;
  }

  /**
   * restore(): reads this person's items back: those kept on this device (own items without a ledger copy and
   * accepted grants, src/media/vault.js) and the own-index items of the ledger (another device after a device link).
   */
  async restore() {
    const keys = this._keys();
    this._watch(); // review round (MAL53-3): items kept here hear a later _deny/ entry
    let n = 0;
    const ownHere = [];
    if (this.d.vault && typeof this.d.vault.entries === 'function') {
      let kept = [];
      try {
        kept = await this.d.vault.entries();
      } catch (_) {
        kept = [];
      }
      for (const [name, v] of kept || []) {
        if (typeof name !== 'string' || name.indexOf('media:') !== 0) continue;
        try {
          if (this._fromVault(v, keys)) {
            n++;
            if (v.kind === 'own') ownHere.push(idOf(v.M));
          }
        } catch (_) { /* a broken entry */ }
      }
    }
    this._reseed(ownHere);
    const node = this.d.node;
    if (!node || !this.d.sealed || typeof this.d.sealed.open !== 'function' || !keys.own) return n;
    const items = listOf(node, 'mw.s').filter((it) => it.author === keys.pub);
    for (const it of items || []) {
      if (it.author && it.author !== keys.pub) continue;
      let opened;
      try {
        opened = await this.d.sealed.open(it.v, { key: keys.own, ledgerId: this.d.ledgerId, authorPub: keys.pub });
      } catch (_) {
        continue;
      }
      if (!opened || opened.kind !== OWN_KIND) continue;
      try {
        const { M, fk } = JSON.parse(utf8.decode(opened.data));
        checkManifest(M);
        const id = idOf(M);
        const have = this.items.get(id);
        if (have) {
          if (have.from === 'mine' && !have.ownH) have.ownH = it.h || null; // kept on this device and in the ledger
          continue;
        }
        const raw = b64url.decode(fk);
        if (raw.length !== FK_BYTES) continue;
        const storeName = 'm-' + id;
        this.items.set(id, { id, from: 'mine', M, fk: raw, store: this._store(storeName, M.P, M.total * M.P), storeName, handle: null, state: 'ready', grants: new Map(), keep: true, ownH: it.h || null, t: M.t });
        n++;
      } catch (_) { /* not ours or not a media item */ }
    }
    return n;
  }

  /**
   * _reseed(ids): own items kept on this device (their chunks are in its store) join their swarms again in lane K, newest first,
   * at most RESEED_MAX; the metadata comes from the first peer that has it (the people it was shared with, a pin node). Items
   * read from the ledger's own index (another device) are not fetched for this. Nothing in host-only mode.
   */
  _reseed(ids) {
    if (this._hostOnly() || !Array.isArray(ids) || ids.length === 0) return 0;
    const recs = ids.map((id) => this.items.get(id)).filter((r) => r && r.from === 'mine' && !r.handle)
      .sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, RESEED_MAX);
    for (const rec of recs) {
      Promise.resolve().then(() => this._seed(rec, { infoHash: rec.M.ih, lane: 'K' })).catch(() => { /* the swarm can wait for an open */ });
    }
    return recs.length;
  }

  _rec(id) {
    if (this.revoked.has(id)) throw mediaError('E_REVOKED', 'the sender revoked this item');
    let rec = this.items.get(id);
    if (!rec && typeof id === 'string') {
      // an own item re-encrypted since the site learned its id (revoke { reencrypt } moves it to the new id)
      for (const r of this.items.values()) if (r.from === 'mine' && r.previous && r.previous.indexOf(id) >= 0) rec = r;
    }
    if (!rec) throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    return rec;
  }

  /** Every id recipients may key this item by: the current one and the ids it had before a re-encryption. */
  _idsOf(rec) {
    return [rec.id].concat(rec.previous || []);
  }

  /** list({ from }) -> [{ id, kind, mime, len, duration?, w, h, from, t, available }] */
  list({ from = 'all' } = {}) {
    this._keys();
    const out = [];
    for (const rec of this.items.values()) {
      if (rec.state === 'offer') continue;
      if (from === 'mine' && rec.from !== 'mine') continue;
      if (from === 'received' && rec.from === 'mine') continue;
      const e = { id: rec.id, kind: rec.M.kind, mime: rec.M.mime, len: rec.M.len, w: rec.M.w, h: rec.M.h, from: rec.from, t: rec.t };
      if (rec.M.duration !== undefined) e.duration = rec.M.duration;
      Object.assign(e, this._availability(rec)); // C2 seed-engine: available, evidence, label, labelParams, handoff
      out.push(e);
    }
    return out;
  }

  /** offers() -> grants waiting for the person's answer (never auto-accepted, MAL A8). */
  offers() {
    return Array.from(this.items.values()).filter((r) => r.state === 'offer').map((r) => ({ id: r.id, from: r.from, size: r.M.total * r.M.P, kind: r.M.kind }));
  }

  async _chunk(rec, i) {
    const have = await rec.store.getAsync(i);
    if (have) return have;
    const h = rec.handle;
    if (!h) throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    if (typeof h.prioritize === 'function') h.prioritize(i, i);
    else if (h.torrent && typeof h.torrent.critical === 'function') h.torrent.critical(i, i);
    const waitMs = this.d.chunkWaitMs || CHUNK_WAIT_MS;
    const t0 = Date.now(); // a real clock: deps.now may be a fixed test clock
    for (;;) {
      await new Promise((resolve) => {
        if (!rec.waiters) rec.waiters = new Map();
        const list = rec.waiters.get(i) || [];
        let timer = null;
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        list.push(done);
        rec.waiters.set(i, list);
        timer = setTimeout(done, Math.min(500, waitMs));
      });
      const got = await rec.store.getAsync(i);
      if (got) return got;
      if (Date.now() - t0 >= waitMs) {
        this.emit('unavailable', { id: rec.id });
        throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
      }
    }
  }

  /** _cancelChunk(rec, i): the player let go of chunk i (mw-chunk-cancel): its piece leaves the front of the download. */
  _cancelChunk(rec, i) {
    const h = rec.handle;
    if (h && typeof h.deprioritize === 'function') h.deprioritize(i, i);
  }

  /** open(id, { part }) -> { url, mime, duration?, w, h } through MediaSessions (no key ever returned). */
  async open(id, { part = 'media' } = {}) {
    this._keys();
    const rec = this._rec(id);
    if (rec.state === 'offer') throw mediaError('E_FILE_UNAVAILABLE', 'accept the offer first');
    if (rec.M.kind === 'video' && typeof this.d.canPlay === 'function' && !this.d.canPlay(rec.M.mime)) {
      throw mediaError('E_MEDIA_UNPLAYABLE', 'This video format does not play in this browser. Download it instead.');
    }
    if (!rec.handle && rec.from !== 'mine') {
      const handle = await this._seed(rec, { infoHash: rec.M.ih });
      if (rec.unchecked) await this._checkSwarm(rec, handle); // accepted while nobody who had it was online
    }
    // review round (MAL53-2): the first chunk of a received picture is checked before a decoder sees it (_checkedChunk)
    const r = await this.d.sessions.open(id, { M: rec.M, fk: rec.fk, readChunk: (i) => this._checkedChunk(rec, i), cancelChunk: (i) => this._cancelChunk(rec, i) });
    const out = { url: part === 'poster' ? (r.poster || r.url) : r.url, mime: part === 'poster' && r.poster ? rec.M.pmime : rec.M.mime, w: rec.M.w, h: rec.M.h };
    if (rec.M.duration !== undefined) out.duration = rec.M.duration;
    if (r.mode === 'blob') out.note = r.note;
    return out;
  }

  close(id) {
    return { closed: this.d.sessions.close(id) };
  }

  async _recipients(to) {
    if (Array.isArray(to)) return to.slice();
    if (typeof to === 'string' && this.d.chat && typeof this.d.chat.groupMembers === 'function') return this.d.chat.groupMembers(to);
    throw mediaError('E_POLICY', 'to: a list of keys or a group id');
  }

  async _grant(rec, keys, pub, durable) {
    const G = { M: rec.M, fk: b64url.encode(rec.fk), from: keys.pub, to: pub };
    const r = await this.d.chat.dm.send(pub, { grant: { t: 'media', G } });
    const g = { state: r && r.state, h: null };
    if (durable && this.d.sealed && typeof this.d.sealed.sealTo === 'function' && this.d.node && typeof this.d.node.append === 'function') {
      const value = await this.d.sealed.sealTo({ kind: GRANT_KIND, data: utf8.encode(JSON.stringify(G)), to: pub, keys, ledgerId: this.d.ledgerId });
      const a = await this.d.node.append('mw.s', value);
      g.h = a && a.h ? a.h : null;
    }
    rec.grants.set(pub, g);
    return g;
  }

  /** share(id, { to, durable }) -> { granted: [pub], held: [pub] } */
  async share(id, { to, durable = false } = {}) {
    const keys = this._keys();
    const rec = this._rec(id);
    if (rec.from !== 'mine') throw mediaError('E_POLICY', 'only the uploader shares an item');
    if (!this.d.chat || !this.d.chat.dm || typeof this.d.chat.dm.send !== 'function') throw mediaError('E_NO_CHAT_KEY', 'messages are off');
    const list = await this._recipients(to);
    const ok = await this.d.prompt({ kind: 'media-share', recipients: list, size: rec.M.total * rec.M.P });
    if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    const granted = [];
    const held = [];
    for (const pub of list) {
      const g = await this._grant(rec, keys, pub, durable);
      if (g.state === 'delivered') granted.push(pub);
      else held.push(pub);
    }
    this.emit('shared', { id, to: list });
    return { granted, held };
  }

  /** revoke(id, { from, reencrypt }) -> { revoked: [pub], reencrypted } (best effort, R 2.9.7). */
  async revoke(id, { from, reencrypt = false } = {}) {
    const keys = this._keys();
    const rec = this._rec(id);
    if (rec.from !== 'mine') throw mediaError('E_POLICY', 'only the uploader revokes');
    const ok = await this.d.prompt({ kind: 'media-revoke', text: REVOKE_TEXT, reencrypt });
    if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    const targets = Array.isArray(from) ? from : Array.from(rec.grants.keys());
    const revoked = [];
    for (const pub of targets) {
      const g = rec.grants.get(pub);
      // Recipients key an item by idOf(M): name the current id and every id it had before a re-encryption.
      for (const rid of this._idsOf(rec)) {
        try {
          await this.d.chat.dm.send(pub, { grant: { t: 'revoke', id: rid } });
        } catch (_) { /* best effort: the ledger tombstone below still applies */ }
      }
      if (g && g.h && this.d.node && typeof this.d.node.tombstone === 'function') {
        try {
          await this.d.node.tombstone(g.h);
        } catch (_) { /* already gone */ }
      }
      rec.grants.delete(pub);
      revoked.push(pub);
    }
    let reencrypted = false;
    if (reencrypt) {
      await this._reencrypt(rec, keys);
      reencrypted = true;
    }
    this.emit('revoked', { id, from: revoked });
    return { revoked, reencrypted, id: rec.id };
  }

  async _reencrypt(rec, keys) {
    const oldId = rec.id;
    const old = { M: rec.M, fk: rec.fk, store: rec.store, handle: rec.handle, ownH: rec.ownH };
    const s = newSecrets((n) => this._random(n));
    const M0 = old.M;
    const newId = hex.encode(s.fid);
    const storeName = 'm-' + newId;
    const store = this._store(storeName, M0.P, M0.total * M0.P);
    const pieces = new Uint8Array(M0.total * 20);
    const fid0 = b64url.decode(M0.fid);
    const base0 = b64url.decode(M0.base);
    for (let i = 0; i < M0.total; i++) {
      const region = regionOf(M0, i);
      const pt = await decryptChunk(old.fk, base0, fid0, i, M0.total, region, await this._chunk(rec, i));
      const ct = await encryptChunk(s.fk, s.base, s.fid, i, M0.total, region, pt);
      await store.putAsync(i, ct);
      pieces.set(await sha1(ct), i * 20);
    }
    const t = await torrentOf(buildInfo({ P: M0.P, total: M0.total, pieces, nonce: s.swarmNonce }));
    const M = buildManifest(Object.assign({}, M0, { fid: s.fid, base: s.base, ih: t.infoHash, t: this._now() }));
    rec.M = M;
    rec.fk = s.fk;
    rec.store = store;
    rec.storeName = storeName;
    rec.handle = null;
    this.d.sessions.close(oldId);
    // The item's id is idOf(M): the new grants and restore() key it by the new fid, so the record moves there and
    // keeps the old id for later revokes and deletes (code review v0.3).
    this.items.delete(oldId);
    rec.id = idOf(M);
    rec.previous = [oldId].concat(rec.previous || []).slice(0, 16);
    this.items.set(rec.id, rec);
    this._unkeep(oldId);
    rec.ownH = await this._writeOwn(rec, keys, {});
    if (old.ownH && this.d.node && typeof this.d.node.tombstone === 'function') {
      try {
        await this.d.node.tombstone(old.ownH);
      } catch (_) { /* already gone */ }
    }
    rec.complete = true;
    rec.pinRequested = false;
    await this._seed(rec, { torrentFile: t.torrentFile, lane: 'H' }); // C2 seed-engine: a new item to hand off
    if (old.handle && typeof old.handle.destroy === 'function') old.handle.destroy();
    await new Promise((resolve) => old.store.destroy(resolve));
    for (const pub of Array.from(rec.grants.keys())) await this._grant(rec, keys, pub, Boolean(rec.grants.get(pub).h));
    this.emit('shared', { id: rec.id, kind: 'own', replaces: oldId });
  }

  /** delete(id) -> { deleted: true } */
  async delete(id) {
    this._keys();
    const rec = this._rec(id);
    const ok = await this.d.prompt({ kind: 'media-delete' });
    if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    if (rec.from === 'mine' && rec.grants.size) {
      for (const pub of Array.from(rec.grants.keys())) {
        for (const rid of this._idsOf(rec)) {
          try {
            await this.d.chat.dm.send(pub, { grant: { t: 'revoke', id: rid } });
          } catch (_) { /* best effort */ }
        }
        const g = rec.grants.get(pub);
        if (g && g.h && this.d.node && typeof this.d.node.tombstone === 'function') await Promise.resolve().then(() => this.d.node.tombstone(g.h)).catch(() => {});
      }
    }
    if (rec.ownH && this.d.node && typeof this.d.node.tombstone === 'function') await Promise.resolve().then(() => this.d.node.tombstone(rec.ownH)).catch(() => {});
    if (this.d.pin && typeof this.d.pin.drop === 'function') await Promise.resolve(this.d.pin.drop({ ih: rec.M.ih })).catch(() => {});
    this._forget(rec);
    return { deleted: true };
  }

  _forget(rec) {
    this.d.sessions.close(rec.id);
    if (rec.handle && typeof rec.handle.destroy === 'function') {
      try {
        rec.handle.destroy();
      } catch (_) { /* gone */ }
    }
    rec.store.destroy(() => {});
    this.items.delete(rec.id);
    this._unkeep(rec.id);
  }

  /** keepAvailable(id, on) -> { on }: recipients only seed when they opt in (the IP sentence card). */
  async keepAvailable(id, on) {
    this._keys();
    const rec = this._rec(id);
    if (on) {
      const ok = await this.d.prompt({ kind: 'media-keep-available', text: 'Others can see your IP address next to this file.' });
      if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
      rec.keep = true;
      // C2 seed-engine: "Keep available" is the K lane.
      if (!rec.handle) await this._seed(rec, { infoHash: rec.M.ih, lane: 'K' });
      else if (typeof rec.handle.setLane === 'function' && rec.handle.lane !== 'H') rec.handle.setLane('K');
    } else {
      rec.keep = rec.from === 'mine';
      if (rec.from !== 'mine' && rec.handle && typeof rec.handle.stopSeeding === 'function') rec.handle.stopSeeding();
    }
    return { on: Boolean(on) };
  }

  /** pinRequest(id) -> { requested }: a moderator queue entry (name, size, key and declared hash only). */
  async pinRequest(id) {
    const keys = this._keys();
    const rec = this._rec(id);
    if (!this.d.pin || typeof this.d.pin.request !== 'function') throw mediaError('E_POLICY', 'this site runs no pin node');
    await this.d.pin.request({ ih: rec.M.ih, size: rec.M.total * rec.M.P, author: keys.pub });
    rec.pinRequested = true; // C2 seed-engine: "Waiting for the site to accept it."
    return { requested: true };
  }

  /**
   * onGrant(fromPub, grant): a grant or a revoke the chat service delivered. A grant becomes an offer
   * (never auto-accepted, even from contacts); the loader asks the person (prompt 'media-offer').
   */
  async onGrant(fromPub, grant) {
    const keys = this._keys();
    if (!grant || typeof grant !== 'object') return null;
    if (grant.t === 'revoke' && typeof grant.id === 'string') {
      const rec = this.items.get(grant.id);
      if (rec && rec.from === fromPub) {
        this._forget(rec);
        this.revoked.add(grant.id);
        this.emit('revoked', { id: grant.id, from: fromPub });
      }
      return null;
    }
    if (grant.t !== 'media' || !grant.G) return null;
    const G = grant.G;
    let M;
    let fk;
    try {
      M = checkManifest(G.M);
      fk = b64url.decode(G.fk);
    } catch (_) {
      return null;
    }
    if (fk.length !== FK_BYTES || G.from !== fromPub || G.to !== keys.pub) return null;
    if (G.exp !== undefined && !(G.exp > this._now())) return null;
    if (typeof this.d.isDenied === 'function' && (await this.d.isDenied(M.ih))) return null;
    const id = idOf(M);
    if (this.items.has(id)) return id;
    this.revoked.delete(id);
    const storeName = 'm-' + id;
    this.items.set(id, { id, from: fromPub, M, fk, store: this._store(storeName, M.P, M.total * M.P), storeName, handle: null, state: 'offer', grants: new Map(), keep: false, ownH: null, t: M.t });
    this.emit('received', { id, from: fromPub, size: M.total * M.P, kind: M.kind });
    return id;
  }

  /** accept(id): the person accepted an offer: join the private swarm and fetch the poster first. */
  async accept(id) {
    const rec = this._rec(id);
    if (rec.state !== 'offer') return { accepted: true };
    rec.state = 'ready';
    await this._keep(rec); // an accepted grant survives a reload and a sign-out (MF-72)
    const handle = await this._seed(rec, { infoHash: rec.M.ih });
    await this._checkSwarm(rec, handle);
    if (rec.M.plen && typeof handle === 'object' && handle && typeof handle.prioritize === 'function') handle.prioritize(rec.M.regions.poster[0], rec.M.regions.poster[1] - 1);
    return { accepted: true };
  }

  /**
   * _checkSwarm(rec, handle): the swarm's info dictionary must be the one the grant describes (R 2.8.3). A swarm that does
   * not match drops the grant ('the swarm does not match the grant'). When nobody who has the item is online (no info
   * dictionary in time: E_FILE_UNAVAILABLE from the handle), the grant is kept, the swarm is left, 'unavailable' is
   * emitted and open() checks again later (R 2.9.8; rows lane, E-MD-6: before, the grant was forgotten for good).
   */
  async _checkSwarm(rec, handle) {
    if (!handle || typeof handle.metadata !== 'function') return;
    let torrentFile;
    try {
      torrentFile = await handle.metadata();
    } catch (err) {
      if (!err || err.code !== 'E_FILE_UNAVAILABLE') {
        this._forget(rec);
        throw mediaError('E_FILE_UNAVAILABLE', 'the swarm does not match the grant');
      }
      if (rec.handle === handle) rec.handle = null;
      try {
        handle.destroy({ keepStore: true });
      } catch (_) { /* gone */ }
      rec.unchecked = true;
      this.emit('unavailable', { id: rec.id });
      throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    }
    try {
      await validateFileTorrent(torrentFile, { length: rec.M.total * rec.M.P, pieceLength: rec.M.P, privateSwarm: true, infoHash: rec.M.ih, maxBytes: capFor(this.d.deviceClass) * 2 });
    } catch (_) {
      this._forget(rec);
      throw mediaError('E_FILE_UNAVAILABLE', 'the swarm does not match the grant');
    }
    rec.unchecked = false;
  }

  /** decline(id): the offer is dropped and nothing is fetched. */
  decline(id) {
    const rec = this.items.get(id);
    if (rec && rec.state === 'offer') this._forget(rec);
    return { declined: true };
  }

  /** signOut(): every session ends and every key is dropped from memory (the device's sealed copies stay). */
  signOut() {
    this._restoring = null;
    this.d.sessions.closeAll();
    for (const rec of this.items.values()) {
      if (rec.handle && typeof rec.handle.destroy === 'function') {
        try {
          rec.handle.destroy({ keepStore: true });
        } catch (_) { /* gone */ }
      }
    }
    this.items.clear();
  }
}
