// src/files/lane.js: the file lanes in the loader (R 2.8; MF-47 to MF-55; ARCHITECTURE 15.7; INTERFACES
// "v0.3 (proposed)" src/files/*). F1 public files (plaintext torrent, re-encoded images, an mw.files
// listing) and F2 private files (STREAM records of src/files/encrypt.js, a grant through the chat
// service, no listing). Everything is injected, so Node tests run it with fakes.
//
// Seeding rules (R 2.8.4): nothing is fetched until the person confirms the fetch card for that file;
// a fetched file is never re-seeded unless the person turns on "Help share this file"; torrents go
// through TorrentManager.addFileTorrent with the site's own tracker only and a retained chunk store.
// Metadata (R 2.8.3) is validated before a byte is used (src/files/validate.js); public files must match
// the listed SHA-256, computed incrementally over the chunk store (E_FILE_HASH); private files must open
// (E_DECRYPT). A moderator _deny/ entry is checked through isDenied(hash) before any fetch or seed (R 2.8.7).
//
//   new FileLane(deps)
//     share(file, { public, to, name }) -> { ref, ih, listed }
//     list() / received()
//     fetch(ref, { onProgress, signal }) -> { handle, name, size, mime, stream(), blob() }
//     preview(ref) -> { kind, url?, text? } / save(ref) -> { saved, mode }
//     keepSharing(ref, on) / stopSharing(ref) / remove(ref) / pinRequest(ref) / onGrant(fromPub, grant)
//   listOf(node, name) -> [{ h, author, ts, v }]
//
// v0.3 C2 (lane seed-engine; SZ 3.1.2, 3.1.5; R 2.8.4, 2.8.6): own uploads are the H lane (the per-upload exception;
// on phones after the MF-45 card 'phone-upload'), "Help share this file" is K, a fetch is E. list() and received()
// keep 'available' ('kept' | 'online' | 'unknown') and add evidence { tier, count, atLeast, reported, checkedAt }, a
// label key of src/loader/availability.js and its labelParams; own items also carry handoff { state } moving
// onlyHere -> waiting -> sending -> kept ("sent" when a peer holds every piece). When _mw.cfg.pin is set and the
// uploader is the site owner, an own upload is put in the pin queue at once (owner decision SZ-6); everyone else's pin
// requests stay UI-driven. Nothing is fetched for a label: only a person's fetch, open or "Help share" joins a swarm.
//
// Review round (SCALE-1, MAL53-5, SYB-13, SCALE-13, MAL53-3, MAL53-4, HUB-10, MAL53-11): the caps of R 2.8.8 hold where
// honest copies read, not only in the uploader's client: a listing above 25 MiB is not a listing, an author shows at most
// their first 20 listings in ledger order, an infohash shows once (its first visible listing, so a later key cannot
// relabel an accepted file), and the site total counts only listings this reader shows (never another author's pending
// or hidden ones). Public upload stores are named f-<infohash> and own public uploads come back after a reload (their
// torrent kept in the device's sealed store) and join their swarms again in lane K. Every public fetch hashes the bytes
// and checks the digest against _deny/ before anything uses them; a _deny/ entry that arrives later (node.subscribe)
// stops and removes every handle and copy it names. Fetched files live under a storage budget (deps.filesBudget, else
// storageLines().filesMax of src/loader/policy.js), least recently used first; own uploads are never evicted.

import { sniff, SNIFF_BYTES } from '../media/sniff.js';
import { stripperFor, stripMp3, stripRiff } from '../media/strip.js';
import { mediaError, FK_BYTES } from '../media/format.js';
import { bucketBytes } from '../media/pad.js';
import { encryptStream, decryptStream, decryptRecord, streamPlan, RECORD_BYTES, RECORD_PAYLOAD, HEADER_BYTES } from './encrypt.js';
import { validateFileTorrent, createSha256, fileError } from './validate.js';
import { cleanName, randomName, downloadName, displayParts } from './names.js';
import { previewPlan, riskTier, render, TEXT_PREVIEW_BYTES, VERIFIED_TEXT } from './preview.js';
import { encode } from '../common/bencode.js';
import { b64url, hex, utf8 } from '../chain/canonical.js';
import { evidence as availabilityEvidence, availableOf, publicEvidence, handoffState } from '../loader/availability.js';
import { storageLines } from '../loader/policy.js';

export const CAPS = Object.freeze({
  publicPerFile: 25 * 1024 * 1024,
  publicPerSite: 256 * 1024 * 1024,
  privateDesktop: 100 * 1024 * 1024,
  privatePhone: 25 * 1024 * 1024,
  listingsPerAuthor: 20,
  // Review round R 5.3 (MAL53-10): private file grants not yet fetched, per sender and in all; more are dropped and counted
  // (grantsDropped), so one contact cannot fill the vault or the list.
  grantsPerSender: 20,
  grantsOpen: 200,
});
export const FETCH_NOTE = 'Fetching also shares it with others while this page is open';
export const IP_SENTENCE = 'Others can see your IP address next to this file.';
export const UNAVAILABLE_TEXT = 'Nobody who has this file is online right now.';
export const SAVE_BLOCK = 65536;
export const DONE_WAIT_MS = 120000;
/** Own public uploads that join their swarms again after a reload (lane K), newest first (review round, SCALE-13; as media). */
export const RESEED_MAX = 8;

const isPhone = (c) => typeof c === 'string' && c !== 'desktop';

/** privateCap(deviceClass) -> the private per-file cap (100 MiB desktop until G-FI-5, 25 MiB phones). */
export function privateCap(deviceClass) {
  return isPhone(deviceClass) ? CAPS.privatePhone : CAPS.privateDesktop;
}

/** listOf(node, name) -> the effective items of a ledger list ({ h, author, ts, v }). */
export function listOf(node, name) {
  if (!node) return [];
  const st = node.state;
  if (st && st.lists instanceof Map) return (st.lists.get(name) || []).slice();
  if (typeof node.snapshot === 'function') {
    const snap = node.snapshot();
    const lists = snap && snap.lists ? snap.lists : null;
    if (Array.isArray(lists)) {
      const hit = lists.find((e) => e[0] === name);
      return hit ? hit[1].slice() : [];
    }
    if (lists && Array.isArray(lists[name])) return lists[name].slice();
  }
  return [];
}

/** pieceLengthFor(bytes) -> the smallest power of two from 16 KiB with at most 1,024 pieces, at most 4 MiB. */
export function pieceLengthFor(bytes) {
  let pl = 16384;
  while (pl < 4194304 && Math.ceil(bytes / pl) > 1024) pl *= 2;
  return pl;
}

const LISTING_KEYS = new Set(['ih', 'len', 'name', 'mime', 'sha256', 'ws', 't']);

/** listingOk(v) -> true for an mw.files value of the R 2.10.2 schema whose len is within the public per-file cap (R 2.8.8). */
export function listingOk(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const k of Object.keys(v)) if (!LISTING_KEYS.has(k)) return false;
  return typeof v.ih === 'string' && /^[0-9a-f]{40}$/.test(v.ih) && Number.isSafeInteger(v.len) && v.len >= 0 && v.len <= CAPS.publicPerFile &&
    typeof v.name === 'string' && v.name.length <= 96 && typeof v.mime === 'string' && v.mime.length <= 128 &&
    (v.sha256 === undefined || (typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256))) &&
    (v.ws === undefined || typeof v.ws === 'string') && Number.isSafeInteger(v.t);
}

async function sha1(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', bytes));
}

async function readRange(blob, start, len) {
  return new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
}

function aborted(signal) {
  if (signal && signal.aborted) throw mediaError('E_USER_CANCELLED', 'cancelled');
}

/** chunksOf(stream, size) -> async reader of exact `size`-byte pieces of a ReadableStream (last may be short). */
function piecesOf(stream, size) {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let done = false;
  return async () => {
    while (buf.length < size && !done) {
      const r = await reader.read();
      if (r.done) done = true;
      else {
        const nb = new Uint8Array(buf.length + r.value.length);
        nb.set(buf, 0);
        nb.set(r.value, buf.length);
        buf = nb;
      }
    }
    if (buf.length === 0) return null;
    const n = Math.min(size, buf.length);
    const out = buf.slice(0, n);
    buf = buf.subarray(n);
    return out;
  };
}

function blobStream(blob, step = 65536) {
  let off = 0;
  return new ReadableStream({
    async pull(c) {
      if (off >= blob.size) return c.close();
      c.enqueue(await readRange(blob, off, step));
      off += step;
    },
  });
}

export class FileLane {
  constructor(deps = {}) {
    this.d = deps;
    this.files = new Map(); // ref -> record
    this.hidden = new Set(); // listings whose metadata lied (DS F18)
    this.deniedIh = new Set(); // infohashes a moderator's _deny/ entry took down while this page ran (review round, MAL53-3)
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
      } catch (_) { /* the listener's */ }
    }
    if (typeof this.d.emit === 'function') this.d.emit(event, data);
  }

  _keys(required = true) {
    const k = typeof this.d.keys === 'function' ? this.d.keys() : this.d.keys;
    if (required && (!k || !k.pub)) throw mediaError('E_NOT_SIGNED_IN', 'sign in first');
    return k || null;
  }

  _random(n) {
    return typeof this.d.random === 'function' ? this.d.random(n) : globalThis.crypto.getRandomValues(new Uint8Array(n));
  }

  _now() {
    return typeof this.d.now === 'function' ? this.d.now() : Date.now();
  }

  _hostOnly() {
    return typeof this.d.hostOnly === 'function' ? Boolean(this.d.hostOnly()) : Boolean(this.d.hostOnly);
  }

  _announce() {
    const t = typeof this.d.ownTracker === 'function' ? this.d.ownTracker() : this.d.ownTracker;
    return t ? [t] : [];
  }

  async _denied(...ids) {
    if (typeof this.d.isDenied !== 'function') return false;
    for (const id of ids) if (id && (await this.d.isDenied(id))) return true;
    return false;
  }

  async _addTorrent(rec, opts) {
    if (this._hostOnly()) throw mediaError('E_HOST_ONLY', 'host-only mode');
    if (rec.denied || (await this._denied(rec.ih, rec.sha256, rec.digest))) throw mediaError('E_DENIED', 'a moderator removed this file');
    if (!this.d.torrents || typeof this.d.torrents.addFileTorrent !== 'function') throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    this._watch();
    const store = this.d.storeClass ? this.d.storeClass(rec.storeName) : rec.store;
    // MAL53-6: the listing's length bounds the metadata a peer may announce on each file wire.
    const len = this._bytesOf(rec);
    const expectedLength = Number.isSafeInteger(len) && len > 0 ? len : null;
    const handle = await this.d.torrents.addFileTorrent(Object.assign({ store, announce: this._announce(), retain: true, expectedLength }, opts));
    rec.handle = handle;
    // C2 seed-engine: a handle whose torrent finished holds every piece here (E0).
    if (handle && typeof handle.once === 'function') handle.once('done', () => { rec.complete = true; });
    return handle;
  }

  // ---- review round: takedown that reaches running handles and kept copies (MAL53-3, HUB-10, MAL53-4) ----------------

  /** _watch(): once, subscribe to the ledger node so a _deny/ entry that arrives later reaches what this device holds. */
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

  /** unwatch(): ends the subscription of _watch() (the service's destroy()). */
  unwatch() {
    if (typeof this._unwatch === 'function') {
      try {
        this._unwatch();
      } catch (_) { /* gone */ }
    }
    this._unwatch = undefined;
  }

  /**
   * denySweep() -> how many items were taken down: every item this device holds (a handle, a store or verified bytes) is
   * checked against _deny/ by infohash, listed SHA-256 and computed digest; a denied one stops and loses its local copy.
   * Calls that arrive while a sweep runs are folded into one more pass.
   */
  denySweep() {
    if (this._sweeping) {
      this._sweepAgain = true;
      return this._sweeping;
    }
    this._sweeping = (async () => {
      let n = 0;
      do {
        this._sweepAgain = false;
        for (const rec of Array.from(this.files.values())) {
          if (rec.denied || (!rec.handle && !rec.store && !rec.verified)) continue;
          let hit = false;
          try {
            hit = await this._denied(rec.ih, rec.sha256, rec.digest);
          } catch (_) {
            hit = false;
          }
          if (hit) {
            this._takeDown(rec);
            n++;
          }
        }
      } while (this._sweepAgain);
      return n;
    })().finally(() => { this._sweeping = null; });
    return this._sweeping;
  }

  /** _takeDown(rec): a moderator denied this item: no handle, no copy, no listing row; an own private file keeps its bytes. */
  _takeDown(rec) {
    rec.denied = true;
    this._stop(rec);
    if (this.d.sessions && typeof this.d.sessions.closeFile === 'function') {
      try {
        this.d.sessions.closeFile(rec.ref);
      } catch (_) { /* none open */ }
    }
    if (rec.kind === 'public') this.deniedIh.add(rec.ih);
    if (rec.kind === 'private' && rec.mine) return;
    if (rec.store) rec.store.destroy(() => {});
    this.files.delete(rec.ref);
    if (rec.kind === 'private') this._unkeep(rec.ref);
    else this._unkeepPublic(rec.ih);
    this.emit('removed', { ref: rec.ref, denied: true });
  }

  /** _keepPublic(rec): an own public upload's torrent and listing in the device's sealed store (SCALE-13): it comes back after a reload. */
  async _keepPublic(rec) {
    if (!this.d.vault || typeof this.d.vault.put !== 'function' || rec.kind !== 'public' || !rec.mine || !rec.torrentFile) return false;
    const v = { v: 1, ih: rec.ih, name: rec.name, size: rec.size, mime: rec.mime, sha256: rec.sha256, pl: rec.store.chunkLength, t: rec.t, h: rec.listingH || null, torrent: b64url.encode(rec.torrentFile) };
    try {
      return Boolean(await this.d.vault.put('pub:' + rec.ih, v));
    } catch (_) {
      return false;
    }
  }

  _unkeepPublic(ih) {
    if (this.d.vault && typeof this.d.vault.del === 'function') Promise.resolve().then(() => this.d.vault.del('pub:' + ih)).catch(() => {});
  }

  /** An own public upload from the device's sealed store; the record when its bytes are all here, else null. */
  async _fromVaultPublic(v, keys) {
    if (!v || typeof v !== 'object' || v.v !== 1 || typeof v.ih !== 'string' || !/^[0-9a-f]{40}$/.test(v.ih)) return null;
    if (!Number.isSafeInteger(v.size) || v.size < 0 || v.size > CAPS.publicPerFile || v.pl !== pieceLengthFor(v.size)) return null;
    if (this.files.has(v.ih) || this.deniedIh.has(v.ih) || !keys || !keys.pub) return null;
    const torrentFile = b64url.decode(String(v.torrent || ''));
    const t = await validateFileTorrent(torrentFile, { length: v.size, maxBytes: CAPS.publicPerFile, privateSwarm: false, infoHash: v.ih });
    if (t.pieceLength !== v.pl) return null;
    const storeName = 'f-' + v.ih;
    const store = this.d.makeStore({ name: storeName, chunkLength: v.pl, length: v.size });
    if (!(await store.complete())) return null; // the browser dropped the bytes: the listing can still be fetched from peers
    const sha256 = typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256) ? v.sha256 : undefined;
    const rec = {
      ref: v.ih, ih: v.ih, kind: 'public', mine: true, name: cleanName(String(v.name || '')) || 'file', size: v.size,
      mime: typeof v.mime === 'string' ? v.mime : 'application/octet-stream', sha256, digest: sha256, store, storeName, handle: null,
      complete: true, verified: true, sharing: false, t: Number.isSafeInteger(v.t) ? v.t : this._now(), torrentFile,
      listingH: typeof v.h === 'string' ? v.h : null,
    };
    this.files.set(v.ih, rec);
    return rec;
  }

  /** Own public uploads kept here join their swarms again in lane K, newest first, at most RESEED_MAX; never a denied one. */
  _reseedPublic(recs) {
    if (this._hostOnly() || !recs.length) return 0;
    const pick = recs.slice().sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, RESEED_MAX);
    for (const rec of pick) {
      Promise.resolve().then(async () => {
        await this._addTorrent(rec, { torrentFile: rec.torrentFile, lane: 'K' });
        rec.sharing = true;
      }).catch(() => { /* denied, or no swarm now: the next reload tries again */ });
    }
    return pick.length;
  }

  // ---- review round: the files storage budget (SCALE-13, MAL53-11; R 2.8.8 'Files in the storage budget') ----------

  /** _budget() -> bytes fetched and own files may hold here: deps.filesBudget, else storageLines().filesMax (R 2.8.8). */
  _budget() {
    const b = typeof this.d.filesBudget === 'function' ? this.d.filesBudget() : this.d.filesBudget;
    if (Number.isFinite(b) && b > 0) return b;
    return storageLines({ deviceClass: isPhone(this.d.deviceClass) ? 'phone' : 'desktop' }).filesMax;
  }

  _bytesOf(rec) {
    return rec.kind === 'private' ? rec.cipherBytes : rec.size;
  }

  _touch(rec) {
    this._tick = (this._tick || 0) + 1;
    rec.used = this._tick;
  }

  /**
   * _enforceBudget(keep) -> evicted refs: while the copies held here exceed the budget, the least recently used fetched
   * file (never an own upload, never `keep`) loses its local bytes; its row stays and can be fetched again.
   */
  async _enforceBudget(keep) {
    const budget = this._budget();
    const held = () => Array.from(this.files.values()).filter((r) => r.store && (r.verified || r.mine));
    let total = held().reduce((n, r) => n + this._bytesOf(r), 0);
    const evicted = [];
    const order = held().filter((r) => !r.mine && r !== keep).sort((a, b) => (a.used || 0) - (b.used || 0));
    for (const rec of order) {
      if (total <= budget) break;
      this._stop(rec);
      rec.keepSharing = false;
      rec.evicting = new Promise((resolve) => rec.store.destroy(() => resolve()));
      rec.store = null;
      rec.complete = false;
      rec.verified = false;
      rec.head = null;
      total -= this._bytesOf(rec);
      evicted.push(rec.ref);
      this.emit('removed', { ref: rec.ref, evicted: true });
    }
    return evicted;
  }

  // ---- C2 seed-engine: lanes, evidence, labels, the owner's automatic pin request (SZ 3.1.2, 3.1.5, SZ-6) ----------

  _cfg() {
    try {
      return typeof this.d.cfg === 'function' ? this.d.cfg() || {} : this.d.cfg || {};
    } catch (_) {
      return {};
    }
  }

  /** The lane options of an own upload: H (the per-upload exception), on phones only after the MF-45 card. */
  async _ownLane(name) {
    if (!isPhone(this.d.deviceClass)) return { uploadException: true, lane: 'H' };
    const ok = await this.d.prompt({ kind: 'phone-upload', name });
    // Declined: the file stays on this device and is shared like a kept item (K: phones send none unless sharing is on).
    return ok ? { uploadException: true, lane: 'H' } : { lane: 'K' };
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
      await this.d.pin.request({ ih: rec.ih, name: rec.name, size: rec.kind === 'private' ? rec.cipherBytes : rec.size, author: keys.pub, sha256: rec.sha256, auto: true });
      rec.pinRequested = true;
      return true;
    } catch (_) {
      return false; // the queue may be closed; the person can still ask from the UI
    }
  }

  _evidenceOf(rec) {
    const h = rec.handle;
    let inputs = null;
    try {
      if (h && typeof h.evidenceInputs === 'function') inputs = h.evidenceInputs();
      else if (typeof this.d.evidenceInputs === 'function') inputs = this.d.evidenceInputs(rec.ih);
    } catch (_) {
      inputs = null;
    }
    const i = inputs && typeof inputs === 'object' ? inputs : {};
    const now = Number.isFinite(i.now) ? i.now : this._now();
    let pin = i.pin && typeof i.pin === 'object' ? Object.assign({}, i.pin) : null;
    if (!pin && typeof this.d.pinEvidence === 'function') {
      try {
        pin = this.d.pinEvidence(rec.ih, now) || null;
      } catch (_) {
        pin = null;
      }
    }
    pin = Object.assign({ receipt: null, heartbeat: null }, pin || {}, { configured: Boolean((pin && pin.configured) || this._pinKey()) });
    const local = Boolean(i.local) || Boolean(rec.mine && rec.complete) || Boolean(rec.verified && rec.complete);
    const ev = availabilityEvidence(Object.assign({}, i, { local, pin, now }));
    ev.pinPct = Number.isFinite(i.pinPct) ? i.pinPct : null;
    return ev;
  }

  /** The availability fields of a list entry (the SDK passes them through; 'available' as in v0.3). */
  _availability(rec) {
    const ev = this._evidenceOf(rec);
    const out = { available: availableOf(ev), evidence: publicEvidence(ev), label: ev.label, labelParams: Object.assign({}, ev.params) };
    if (rec.mine) {
      const hs = handoffState({ ev, requested: Boolean(rec.pinRequested), pinPct: ev.pinPct });
      out.label = hs.label;
      out.labelParams = Object.assign({}, hs.params);
      out.handoff = Object.assign({ state: hs.state }, hs.params);
    }
    return out;
  }

  _stop(rec) {
    if (rec.handle && typeof rec.handle.destroy === 'function') {
      try {
        rec.handle.destroy({ keepStore: true });
      } catch (_) { /* gone */ }
    }
    rec.handle = null;
    rec.sharing = false;
  }

  async _strip(file, sniffed, isPublic, original) {
    const kind = stripperFor(sniffed.mime);
    if (!kind) return { blob: file, removed: [], mime: sniffed.mime };
    if (original && !isPublic) {
      const ok = await this.d.prompt({ kind: 'file-send-original', text: 'The original may contain your location' });
      if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
      return { blob: file, removed: [], mime: sniffed.mime };
    }
    const s = this.d.strip || {};
    try {
      if (kind === 'image') {
        const r = await s.stripImage(file);
        return { blob: r.blob, removed: r.removed, mime: r.mime || r.blob.type || sniffed.mime };
      }
      const fn = { mp4: s.stripMp4, webm: s.stripWebm, mp3: s.stripMp3 || stripMp3, riff: s.stripRiff || stripRiff }[kind];
      const r = await fn(file);
      return { blob: r.blob, removed: r.removed, mime: sniffed.mime };
    } catch (err) {
      if (isPublic) throw mediaError('E_MEDIA_STRIP', 'metadata could not be removed, so the public upload is refused');
      const go = await this.d.prompt({ kind: 'file-strip-failed', choice: 'Upload anyway (may include your location)' });
      if (!go) throw mediaError('E_MEDIA_STRIP', err && err.message);
      return { blob: file, removed: [], mime: sniffed.mime, stripFailed: true };
    }
  }

  _publicListings() {
    return listOf(this.d.node, 'mw.files').filter((it) => listingOk(it.v));
  }

  /**
   * _shown() -> the listings this reader shows, in ledger order: [{ it, mine, pending }] (review round, SCALE-1, MAL53-5,
   * SYB-13). Per author only the first CAPS.listingsPerAuthor listings count (a hand-written flood shows 20); a hidden
   * listing (its metadata lied) is left out; another author's listing that waits for a moderator is left out, the own
   * one is kept as pending; an infohash shows once, as its first such listing, so a relisting cannot rename or retype it;
   * the listings shown stop at CAPS.publicPerSite in ledger order (an honest share() never writes past it).
   */
  _shown() {
    const me = this._keys(false);
    const perAuthor = new Map();
    const seen = new Set();
    const out = [];
    let total = 0;
    for (const it of this._publicListings()) {
      const n = (perAuthor.get(it.author) || 0) + 1;
      perAuthor.set(it.author, n);
      if (n > CAPS.listingsPerAuthor) continue;
      if (this.hidden.has(it.v.ih) || this.deniedIh.has(it.v.ih) || seen.has(it.v.ih)) continue;
      const mine = Boolean(me && it.author === me.pub);
      const visible = this._visible(it);
      if (!visible && !mine) continue;
      seen.add(it.v.ih);
      if (total + it.v.len > CAPS.publicPerSite) continue;
      total += it.v.len;
      out.push({ it, mine, pending: !visible });
    }
    return out;
  }

  /** share(file, { public, to, name, original }) -> { ref, ih, listed } */
  async share(file, { public: isPublic = false, to = [], name, original = false } = {}) {
    const keys = this._keys();
    if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') throw mediaError('E_LIMIT', 'not a file');
    if (isPublic) {
      if (file.size > CAPS.publicPerFile) throw mediaError('E_LIMIT', 'public files are at most 25 MiB');
      // The site total counts what this reader shows (review round, SCALE-1, MAL53-5): never another author's pending or
      // hidden listing, at most 25 MiB each (listingOk) and 20 per author, so one forged listing cannot fill the site.
      const used = this._shown().reduce((n, x) => n + x.it.v.len, 0);
      if (used + file.size > CAPS.publicPerSite) throw mediaError('E_LIMIT', 'this site has used its 256 MiB of public files');
      if (this._publicListings().filter((it) => it.author === keys.pub).length >= CAPS.listingsPerAuthor) throw mediaError('E_LIMIT', 'at most 20 active listings per author');
    } else if (file.size > privateCap(this.d.deviceClass)) {
      throw mediaError('E_LIMIT', 'over the private file cap of this device');
    }
    const sniffed = sniff(await readRange(file, 0, SNIFF_BYTES));
    const stripped = await this._strip(file, sniffed, isPublic, original);
    const blob = stripped.blob;
    const after = sniff(await readRange(blob, 0, SNIFF_BYTES));
    const display = name ? cleanName(name) || randomName(after.kind, after.ext, (n) => this._random(n)) : randomName(after.kind, after.ext, (n) => this._random(n));
    // unchecked (review round, PRIV-5): no stripper exists for this type, so the card can say the file was not checked
    const ok = await this.d.prompt({ kind: 'file-share', public: Boolean(isPublic), name: display, size: blob.size, mime: after.mime, removed: stripped.removed, recipients: isPublic ? [] : to, unchecked: !stripperFor(sniffed.mime) });
    if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    if (isPublic) return this._sharePublic(keys, blob, display, after);
    return this._sharePrivate(keys, blob, display, after, to);
  }

  async _sharePublic(keys, blob, display, sniffed) {
    const pl = pieceLengthFor(blob.size);
    const count = Math.max(1, Math.ceil(blob.size / pl));
    const pieces = new Uint8Array(count * 20);
    const h = createSha256();
    for (let i = 0; i * pl < blob.size; i++) {
      const piece = await readRange(blob, i * pl, pl);
      h.update(piece);
      pieces.set(await sha1(piece), i * 20);
    }
    const info = { length: blob.size, name: utf8.encode(display), 'piece length': pl, pieces };
    const torrentFile = encode({ info });
    const ih = hex.encode(await sha1(encode(info)));
    const sha256 = h.hex();
    // The store is named by the infohash (review round, SCALE-13): after a reload the listing finds these bytes.
    const storeName = 'f-' + ih;
    const store = this.d.makeStore({ name: storeName, chunkLength: pl, length: blob.size });
    for (let i = 0; i * pl < blob.size; i++) await store.putAsync(i, await readRange(blob, i * pl, pl));
    const rec = { ref: ih, ih, kind: 'public', mine: true, name: display, size: blob.size, mime: sniffed.mime, sha256, digest: sha256, store, storeName, handle: null, complete: true, verified: true, sharing: true, t: Math.floor(this._now() / 60000) * 60000, torrentFile }; // STALK-12: the minute, not the millisecond
    const lane = await this._ownLane(display); // C2 seed-engine: H, after the MF-45 card on phones
    this.files.set(ih, rec);
    const listing = { ih, len: blob.size, name: display, mime: sniffed.mime, sha256, t: rec.t };
    const block = await this.d.node.append('mw.files', listing);
    rec.listingH = block && block.h ? block.h : null;
    await this._keepPublic(rec);
    await this._addTorrent(rec, Object.assign({ torrentFile }, lane));
    await this._autoPin(rec, keys); // C2 seed-engine: SZ-6
    this.emit('shared', { ref: ih, listed: true });
    return { ref: ih, ih, listed: true };
  }

  async _sharePrivate(keys, blob, display, sniffed, to) {
    if (!this.d.chat || !this.d.chat.dm || typeof this.d.chat.dm.send !== 'function') throw mediaError('E_NO_CHAT_KEY', 'messages are off');
    const fk = this._random(FK_BYTES);
    const nonce = this._random(16);
    const sp = streamPlan(blob.size);
    const P = sp.bytes >= 2 * 1024 * 1024 ? 262144 : 65536;
    const ref = hex.encode(this._random(16));
    const storeName = 'p-' + ref;
    const store = this.d.makeStore({ name: storeName, chunkLength: P, length: sp.bytes });
    const pieces = new Uint8Array((sp.bytes / P) * 20);
    const next = piecesOf(await encryptStream(blobStream(blob), fk, { length: blob.size }), P);
    for (let i = 0; ; i++) {
      const piece = await next();
      if (!piece) break;
      await store.putAsync(i, piece);
      pieces.set(await sha1(piece), i * 20);
    }
    const info = { length: sp.bytes, name: utf8.encode('mw'), 'piece length': P, pieces, private: 1, 'x-mw-nonce': nonce };
    const torrentFile = encode({ info });
    const ih = hex.encode(await sha1(encode(info)));
    const rec = { ref, ih, kind: 'private', mine: true, name: display, size: blob.size, mime: sniffed.mime, fk, P, cipherBytes: sp.bytes, store, storeName, handle: null, complete: true, verified: true, sharing: true, t: this._now() };
    const lane = await this._ownLane(display); // C2 seed-engine: H, after the MF-45 card on phones
    this.files.set(ref, rec);
    await this._keep(rec); // fk has no other home (a private file has no ledger copy)
    await this._addTorrent(rec, Object.assign({ torrentFile }, lane));
    await this._autoPin(rec, keys); // C2 seed-engine: SZ-6
    const F = { ref, ih, len: sp.bytes, plen: blob.size, P, name: display, mime: sniffed.mime, fk: b64url.encode(fk), from: keys.pub };
    for (const pub of to) await this.d.chat.dm.send(pub, { grant: { t: 'file', F: Object.assign({ to: pub }, F) } });
    this.emit('shared', { ref, listed: false });
    return { ref, ih, listed: false };
  }

  /**
   * _visible(item) -> true when honest copies show this mw.files item: premoderation (R 2.17.1, MF-53; deps.listingVisible, the
   * rule of src/loader/mod.js: the author is the owner, a moderator or allow-listed, or a moderator accepted this listing or an
   * earlier one by the same author). Without the dep (tests, tools) every listing counts.
   */
  _visible(it) {
    if (typeof this.d.listingVisible !== 'function') return true;
    try {
      return Boolean(this.d.listingVisible(it));
    } catch (_) {
      return false;
    }
  }

  /**
   * list() -> public listings: [{ ref, name, len, mime, author, t, mine, pending? }] (names cleaned; never thumbnails).
   * pending: true on the device's own listing that waits for a moderator; others' pending listings are left out.
   */
  list() {
    const out = [];
    // Code review v0.3 (round 2, loader-sw request #21): a listing that waits for a moderator is listed only for its author,
    // with pending: true; nobody else lists or fetches it until a moderator accepts it. Review round (SCALE-1, MAL53-5,
    // SYB-13): the read-side caps of _shown() apply here too.
    for (const { it, mine, pending } of this._shown()) {
      const visible = !pending;
      const parts = displayParts(it.v.name, { ext: '', mime: it.v.mime });
      const e = { ref: it.v.ih, name: parts.claimed, ext: parts.ext, len: it.v.len, mime: it.v.mime, author: it.author, t: it.v.t, mine, fetched: Boolean(this.files.get(it.v.ih) && this.files.get(it.v.ih).verified) };
      if (it.v.sha256) e.sha256 = it.v.sha256;
      if (!visible) e.pending = true;
      // C2 seed-engine: evidence and label (a listing this device never fetched has only what the pin says).
      const rec = this.files.get(it.v.ih) || { ref: it.v.ih, ih: it.v.ih, kind: 'public', mine: false, handle: null, complete: false, verified: false };
      Object.assign(e, this._availability(rec));
      out.push(e);
    }
    return out;
  }

  // ---- the device's sealed home of private file keys (src/media/vault.js; R 2.9.4, MF-72; code review v0.3) ----------

  async _keep(rec) {
    if (!this.d.vault || typeof this.d.vault.put !== 'function' || rec.kind !== 'private') return false;
    const F = { ref: rec.ref, ih: rec.ih, len: rec.cipherBytes, plen: rec.size, P: rec.P, name: rec.name, mime: rec.mime, fk: b64url.encode(rec.fk) };
    try {
      return Boolean(await this.d.vault.put('file:' + rec.ref, { v: 1, mine: Boolean(rec.mine), from: rec.mine ? null : rec.from, F, t: rec.t }));
    } catch (_) {
      return false;
    }
  }

  _unkeep(ref) {
    if (this.d.vault && typeof this.d.vault.del === 'function') Promise.resolve().then(() => this.d.vault.del('file:' + ref)).catch(() => {});
  }

  /** A private file from the device's sealed store; true when it was added. */
  _fromVault(v, keys) {
    if (!v || typeof v !== 'object' || v.v !== 1 || !v.F || typeof v.F !== 'object') return false;
    const F = v.F;
    const fk = b64url.decode(F.fk);
    if (fk.length !== FK_BYTES) return false;
    if (typeof F.ih !== 'string' || !/^[0-9a-f]{40}$/.test(F.ih) || typeof F.ref !== 'string' || !/^[0-9a-f]{32}$/.test(F.ref)) return false;
    if (!Number.isSafeInteger(F.plen) || F.plen < 0 || F.len !== streamPlan(F.plen).bytes || (F.P !== 65536 && F.P !== 262144)) return false;
    const mine = v.mine === true;
    if (!mine && (typeof v.from !== 'string' || v.from === keys.pub)) return false;
    if (this.files.has(F.ref)) return false;
    const storeName = 'p-' + F.ref;
    this.files.set(F.ref, {
      ref: F.ref, ih: F.ih, kind: 'private', mine, from: mine ? undefined : v.from, name: cleanName(String(F.name || '')) || 'file', size: F.plen,
      mime: mine && typeof F.mime === 'string' ? F.mime : 'application/octet-stream', fk, P: F.P, cipherBytes: F.len,
      store: this.d.makeStore({ name: storeName, chunkLength: F.P, length: F.len }), storeName, handle: null, complete: mine, verified: mine,
      sharing: false, t: Number.isSafeInteger(v.t) ? v.t : this._now(),
    });
    return true;
  }

  /**
   * restore() -> how many private files came back from the device's sealed store. Own public uploads kept there come back
   * too (review round, SCALE-13): their f-<infohash> store is found again, remove() reaches them, and they join their swarms
   * again in lane K (_reseedPublic) unless a moderator denied them.
   */
  async restore() {
    const keys = this._keys();
    this._watch();
    if (!this.d.vault || typeof this.d.vault.entries !== 'function') return 0;
    let kept = [];
    try {
      kept = await this.d.vault.entries();
    } catch (_) {
      kept = [];
    }
    let n = 0;
    const pubs = [];
    for (const [name, v] of kept || []) {
      if (typeof name !== 'string') continue;
      try {
        if (name.indexOf('file:') === 0) {
          if (this._fromVault(v, keys)) n++;
        } else if (name.indexOf('pub:') === 0) {
          const rec = await this._fromVaultPublic(v, keys);
          if (rec && (await this._denied(rec.ih, rec.sha256))) this._takeDown(rec);
          else if (rec) pubs.push(rec);
        }
      } catch (_) { /* a broken entry */ }
    }
    this._reseedPublic(pubs);
    return n;
  }

  /** ready() -> Promise: restore() once per signed-in key (the service waits for it before its calls). */
  ready() {
    const keys = this._keys(false);
    if (!keys || !keys.pub) return Promise.resolve(0);
    if (this._restoring && this._restoring.pub === keys.pub) return this._restoring.p;
    const p = this.restore().catch(() => 0);
    this._restoring = { pub: keys.pub, p };
    return p;
  }

  /** received() -> private files granted to this person (offers show size and key only for strangers). */
  received() {
    this._keys();
    return Array.from(this.files.values()).filter((r) => r.kind === 'private' && !r.mine)
      .map((r) => Object.assign({ ref: r.ref, from: r.from, size: r.cipherBytes, name: r.name, fetched: Boolean(r.verified) }, this._availability(r))); // C2 seed-engine
  }

  /** onGrant(fromPub, grant): a private file the chat service delivered (never fetched before a click). */
  async onGrant(fromPub, grant) {
    const keys = this._keys();
    if (!grant || grant.t !== 'file' || !grant.F) return null;
    const F = grant.F;
    let fk;
    try {
      fk = b64url.decode(F.fk);
    } catch (_) {
      return null;
    }
    if (fk.length !== FK_BYTES || F.from !== fromPub || F.to !== keys.pub) return null;
    if (typeof F.ih !== 'string' || !/^[0-9a-f]{40}$/.test(F.ih) || typeof F.ref !== 'string' || !/^[0-9a-f]{32}$/.test(F.ref)) return null;
    if (!Number.isSafeInteger(F.plen) || F.plen < 0 || F.len !== streamPlan(F.plen).bytes || (F.P !== 65536 && F.P !== 262144)) return null;
    if (this.files.has(F.ref)) return F.ref;
    if (await this._denied(F.ih)) return null;
    let fromSender = 0;
    let open = 0;
    for (const r of this.files.values()) {
      if (r.mine || r.kind !== 'private' || r.complete) continue;
      open++;
      if (r.from === fromPub) fromSender++;
    }
    if (fromSender >= CAPS.grantsPerSender || open >= CAPS.grantsOpen) {
      this.grantsDropped = (this.grantsDropped || 0) + 1;
      return null;
    }
    const storeName = 'p-' + F.ref;
    this.files.set(F.ref, {
      ref: F.ref, ih: F.ih, kind: 'private', mine: false, from: fromPub, name: cleanName(String(F.name || '')) || 'file', size: F.plen,
      mime: 'application/octet-stream', fk, P: F.P, cipherBytes: F.len, store: this.d.makeStore({ name: storeName, chunkLength: F.P, length: F.len }),
      storeName, handle: null, complete: false, verified: false, sharing: false, t: this._now(),
    });
    await this._keep(this.files.get(F.ref)); // the grant survives a reload (MF-72)
    this.emit('received', { ref: F.ref, from: fromPub, size: F.len });
    return F.ref;
  }

  _resolve(ref) {
    const rec = this.files.get(ref);
    if (rec) return rec;
    const any = this._publicListings().find((x) => x.v.ih === ref);
    if (!any) {
      if (this.d.node && this.d.node.state && this.d.node.state.tombstoned instanceof Set && this._wasListed(ref)) throw mediaError('E_FILE_TOMBSTONED', 'this file was removed');
      throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    }
    if (this.deniedIh.has(ref)) throw mediaError('E_DENIED', 'a moderator removed this file');
    if (this.hidden.has(ref)) throw fileError('E_FILE_HASH', 'meta', 'this listing does not match its torrent');
    // Review round (SCALE-1, MAL53-5, SYB-13): only a listing this reader shows can be fetched, under its first visible name.
    const shown = this._shown().find((x) => x.it.v.ih === ref);
    if (!shown) {
      const me = this._keys(false);
      if (!this._visible(any) && !(me && any.author === me.pub)) throw mediaError('E_POLICY', 'this file waits for a moderator of this site');
      throw mediaError('E_POLICY', 'this listing is over the listing caps of this site');
    }
    const it = shown.it;
    const v = it.v;
    const pl = pieceLengthFor(v.len);
    const storeName = 'f-' + v.ih;
    const r = { ref, ih: v.ih, kind: 'public', mine: false, author: it.author, name: cleanName(v.name) || 'file', size: v.len, mime: v.mime, sha256: v.sha256, store: null, storeName, pieceLength: pl, handle: null, complete: false, verified: false, sharing: false, t: v.t };
    this.files.set(ref, r);
    return r;
  }

  _wasListed(ref) {
    return Boolean(this.d.wasListed && this.d.wasListed(ref));
  }

  async _waitDone(rec, onProgress, signal) {
    const handle = rec.handle;
    const total = rec.kind === 'private' ? rec.cipherBytes : rec.size;
    const t0 = Date.now(); // a real clock: deps.now may be a fixed test clock
    for (;;) {
      aborted(signal);
      if (await rec.store.complete()) return;
      const done = handle && typeof handle.downloaded === 'number' ? handle.downloaded : 0;
      const p = { ref: rec.ref, done, total };
      if (typeof onProgress === 'function') {
        try {
          onProgress(p);
        } catch (_) { /* the caller's */ }
      }
      this.emit('progress', p);
      if (Date.now() - t0 > (this.d.doneWaitMs || DONE_WAIT_MS)) throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
      await new Promise((resolve) => {
        let timer = null;
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        if (handle && typeof handle.once === 'function') handle.once('done', finish);
        timer = setTimeout(finish, this.d.pollMs || 250);
      });
    }
  }

  async _verify(rec) {
    if (rec.kind === 'public') {
      // Review round (MAL53-4): the digest is always computed, listed or not (MF-56 lets a listing omit it), and checked
      // against _deny/ before anything uses the bytes, so a relisting of denied bytes under a new name and infohash is caught.
      const h = createSha256();
      const n = Math.ceil(rec.size / rec.store.chunkLength);
      for (let i = 0; i < n; i++) h.update(await rec.store.getAsync(i));
      rec.digest = h.hex();
      if (rec.sha256 && rec.digest !== rec.sha256) throw fileError('E_FILE_HASH', 'sha256', 'the file does not match the SHA-256 in its listing');
      if (await this._denied(rec.digest)) throw mediaError('E_DENIED', 'a moderator removed this file');
      return;
    }
    const reader = (await decryptStream(this._cipherStream(rec), rec.fk)).getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
    }
  }

  _cipherStream(rec) {
    let i = 0;
    const n = rec.cipherBytes / rec.P;
    return new ReadableStream({
      async pull(c) {
        if (i >= n) return c.close();
        const piece = await rec.store.getAsync(i++);
        if (!piece) throw mediaError('E_FILE_UNAVAILABLE', 'a piece is missing');
        c.enqueue(piece);
      },
    });
  }

  _plainStream(rec) {
    if (rec.kind === 'private') {
      const lane = this;
      let inner = null;
      return new ReadableStream({
        async pull(c) {
          if (!inner) inner = (await decryptStream(lane._cipherStream(rec), rec.fk)).getReader();
          const r = await inner.read();
          if (r.done) c.close();
          else c.enqueue(r.value);
        },
      });
    }
    let i = 0;
    const n = Math.ceil(rec.size / rec.store.chunkLength);
    return new ReadableStream({
      async pull(c) {
        if (i >= n) return c.close();
        c.enqueue(await rec.store.getAsync(i++));
      },
    });
  }

  /** fetch(ref, { onProgress, signal }) -> { handle, name, size, mime, stream(), blob() } */
  async fetch(ref, { onProgress, signal } = {}) {
    const rec = this._resolve(ref);
    if (rec.denied || (await this._denied(rec.ih, rec.sha256, rec.digest))) {
      if (rec.verified || rec.handle) this._takeDown(rec);
      throw mediaError('E_DENIED', 'a moderator removed this file');
    }
    if (!rec.verified) {
      if (this._hostOnly()) throw mediaError('E_HOST_ONLY', 'host-only mode');
      const ok = await this.d.prompt({ kind: 'file-fetch', name: rec.name, size: rec.kind === 'private' ? rec.cipherBytes : rec.size, mime: rec.mime, note: FETCH_NOTE });
      if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
      aborted(signal);
      const expected = rec.kind === 'private' ? rec.cipherBytes : rec.size;
      if (expected > this._budget()) throw mediaError('E_LIMIT', 'this file is larger than the space files may use on this device');
      if (rec.evicting) await rec.evicting; // its old copy is still being deleted (review round, SCALE-13)
      rec.evicting = null;
      if (!rec.store) {
        rec.store = rec.kind === 'private'
          ? this.d.makeStore({ name: rec.storeName, chunkLength: rec.P, length: rec.cipherBytes })
          : this.d.makeStore({ name: rec.storeName, chunkLength: rec.pieceLength, length: rec.size });
      }
      const handle = await this._addTorrent(rec, { infoHash: rec.ih });
      try {
        if (handle && typeof handle.metadata === 'function') {
          const torrentFile = await handle.metadata();
          const cap = rec.kind === 'private' ? bucketBytes(privateCap(this.d.deviceClass) + 8) + RECORD_BYTES : CAPS.publicPerFile;
          const v = await validateFileTorrent(torrentFile, { length: expected, maxBytes: cap, privateSwarm: rec.kind === 'private', infoHash: rec.ih });
          if (rec.kind === 'public' && v.pieceLength !== rec.store.chunkLength) {
            rec.store = this.d.makeStore({ name: rec.storeName, chunkLength: v.pieceLength, length: rec.size });
          }
          if (rec.kind === 'private' && v.pieceLength !== rec.P) throw fileError('E_FILE_HASH', 'piece-length', 'unexpected piece length');
        }
        await this._waitDone(rec, onProgress, signal);
        await this._verify(rec);
      } catch (err) {
        this._stop(rec);
        if (err && err.code === 'E_FILE_HASH') {
          this.hidden.add(rec.ih);
          rec.store.destroy(() => {});
          this.files.delete(rec.ref);
        } else if (err && err.code === 'E_DENIED') {
          this._takeDown(rec);
        }
        throw err;
      }
      rec.complete = true;
      rec.verified = true;
      rec.head = await this._head(rec);
      if (!rec.keepSharing) this._stop(rec); // never re-seeded unless the person turns on "Help share this file"
      this._touch(rec);
      await this._enforceBudget(rec); // review round (SCALE-13, MAL53-11): LRU across fetched files
    }
    this._touch(rec);
    return this._handleOf(rec);
  }

  /** _usable(ref) -> a fetched record that no _deny/ entry names (checked again at preview and save, review round MAL53-3). */
  async _usable(ref) {
    const rec = this._fetched(ref);
    if (rec.denied || (await this._denied(rec.ih, rec.sha256, rec.digest))) {
      this._takeDown(rec);
      throw mediaError('E_DENIED', 'a moderator removed this file');
    }
    this._touch(rec);
    return rec;
  }

  async _head(rec) {
    const reader = this._plainStream(rec).getReader();
    const parts = [];
    let n = 0;
    while (n < TEXT_PREVIEW_BYTES) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
      n += r.value.length;
    }
    try {
      reader.cancel();
    } catch (_) { /* done */ }
    const out = new Uint8Array(Math.min(n, TEXT_PREVIEW_BYTES));
    let o = 0;
    for (const p of parts) {
      const take = Math.min(p.length, out.length - o);
      out.set(p.subarray(0, take), o);
      o += take;
      if (o >= out.length) break;
    }
    return out;
  }

  _handleOf(rec) {
    const lane = this;
    return {
      handle: rec.ref,
      name: rec.name,
      size: rec.size,
      mime: 'application/octet-stream',
      verified: VERIFIED_TEXT,
      stream: () => lane._plainStream(rec),
      blob: async () => {
        const reader = lane._plainStream(rec).getReader();
        const parts = [];
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          parts.push(r.value);
        }
        return new Blob(parts, { type: 'application/octet-stream' });
      },
    };
  }

  _fetched(ref) {
    const rec = this.files.get(ref);
    if (!rec || !rec.verified) throw mediaError('E_FILE_UNAVAILABLE', 'fetch the file first');
    return rec;
  }

  /** preview(ref) -> { kind: 'image' | 'text' | 'none', url?, text? }: the only render path (R 2.8.5). */
  async preview(ref) {
    const rec = await this._usable(ref);
    const head = rec.head || (await this._head(rec));
    const p = previewPlan(head);
    if (p.kind === 'none') return { kind: 'none' };
    const r = typeof this.d.render === 'function' ? this.d.render : render;
    return r(await this._handleOf(rec).blob(), p);
  }

  /** save(ref) -> { saved, mode }: through /_mw/f/<sid> (attachment), else a Blob with a[download]. */
  async save(ref) {
    const rec = await this._usable(ref);
    const sniffed = sniff(rec.head || (await this._head(rec)));
    const cfg = typeof this.d.cfg === 'function' ? this.d.cfg() || {} : {};
    const tier = riskTier(sniffed, Array.isArray(cfg.blockTiers) ? cfg.blockTiers : null);
    if (tier.tier === 'blocked') throw mediaError('E_POLICY', 'the site blocks this kind of file');
    if (tier.tier === 'confirm') {
      const ok = await this.d.prompt({ kind: 'file-risk', warning: tier.warning, fileKind: tier.kind, name: rec.name });
      if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    }
    const name = downloadName(rec.name, sniffed);
    const lane = this;
    const readBlock = async (i) => {
      if (rec.kind === 'public' && rec.store.chunkLength === SAVE_BLOCK) return rec.store.getAsync(i);
      return lane._block(rec, i);
    };
    const r = await this.d.sessions.openFile(ref, { name, size: rec.size, block: SAVE_BLOCK, readBlock });
    if (typeof this.d.download === 'function') await this.d.download(r.url, name);
    return { saved: true, mode: r.mode };
  }

  // Plaintext block i (SAVE_BLOCK bytes) of a fetched file, read from the chunk store.
  async _block(rec, i) {
    const start = i * SAVE_BLOCK;
    const end = Math.min(rec.size, start + SAVE_BLOCK);
    if (rec.kind === 'public') {
      const cl = rec.store.chunkLength;
      const out = new Uint8Array(end - start);
      for (let o = start; o < end;) {
        const piece = Math.floor(o / cl);
        const bytes = await rec.store.getAsync(piece);
        const from = o - piece * cl;
        const take = Math.min(bytes.length - from, end - o);
        out.set(bytes.subarray(from, from + take), o - start);
        o += take;
      }
      return out;
    }
    // private: random access by record (a record holds RECORD_PAYLOAD plaintext bytes; the stream starts
    // with the 8-byte length header), so blocks may be asked for in any order
    const records = rec.cipherBytes / RECORD_BYTES;
    const out = new Uint8Array(end - start);
    for (let o = start; o < end;) {
      const at = o + HEADER_BYTES;
      const r = Math.floor(at / RECORD_PAYLOAD);
      const piece = Math.floor((r * RECORD_BYTES) / rec.P);
      const bytes = await rec.store.getAsync(piece);
      if (!bytes) throw mediaError('E_FILE_UNAVAILABLE', 'a piece is missing');
      const within = r * RECORD_BYTES - piece * rec.P;
      const pt = await decryptRecord(rec.fk, r, r === records - 1, bytes.subarray(within, within + RECORD_BYTES));
      const from = at - r * RECORD_PAYLOAD;
      const take = Math.min(RECORD_PAYLOAD - from, end - o);
      out.set(pt.subarray(from, from + take), o - start);
      o += take;
    }
    return out;
  }

  /** keepSharing(ref, on) -> { on }: "Help share this file" (off by default, with the IP sentence). */
  async keepSharing(ref, on) {
    const rec = this._fetched(ref);
    if (!on) {
      rec.keepSharing = false;
      if (!rec.mine) this._stop(rec);
      return { on: false };
    }
    const ok = await this.d.prompt({ kind: 'file-help-share', text: IP_SENTENCE });
    if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
    rec.keepSharing = true;
    // C2 seed-engine: "Help share this file" is the K lane.
    if (!rec.handle) await this._addTorrent(rec, { infoHash: rec.ih, lane: 'K' });
    else if (typeof rec.handle.setLane === 'function' && rec.handle.lane !== 'H') rec.handle.setLane('K');
    rec.sharing = true;
    return { on: true };
  }

  stopSharing(ref) {
    const rec = this.files.get(ref);
    if (!rec) throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    rec.keepSharing = false;
    this._stop(rec);
    return { on: false };
  }

  /** remove(ref) -> { removed }: stops sharing, deletes the local copy, tombstones an own listing. */
  async remove(ref) {
    const rec = this.files.get(ref);
    if (!rec) throw mediaError('E_FILE_UNAVAILABLE', UNAVAILABLE_TEXT);
    this._stop(rec);
    if (this.d.sessions && typeof this.d.sessions.closeFile === 'function') this.d.sessions.closeFile(ref);
    if (rec.store) rec.store.destroy(() => {});
    if (rec.mine && rec.listingH && this.d.node && typeof this.d.node.tombstone === 'function') await this.d.node.tombstone(rec.listingH);
    this.files.delete(ref);
    if (rec.kind === 'private') this._unkeep(ref);
    else if (rec.mine) this._unkeepPublic(rec.ih);
    this.emit('removed', { ref });
    return { removed: true };
  }

  /** pinRequest(ref) -> { requested }: a moderator queue entry (name, size, author key, declared hash). */
  async pinRequest(ref) {
    const keys = this._keys();
    const rec = this.files.get(ref) || this._resolve(ref);
    if (!this.d.pin || typeof this.d.pin.request !== 'function') throw mediaError('E_POLICY', 'this site runs no pin node');
    await this.d.pin.request({ ih: rec.ih, name: rec.name, size: rec.kind === 'private' ? rec.cipherBytes : rec.size, author: rec.mine ? keys.pub : rec.author || rec.from, sha256: rec.sha256 });
    rec.pinRequested = true; // C2 seed-engine: "Waiting for the site to accept it."
    return { requested: true };
  }
}
