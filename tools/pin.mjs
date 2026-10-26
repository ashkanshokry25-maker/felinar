#!/usr/bin/env node
// tools/pin.mjs: a pinned node (ARCHITECTURE sections 3.4.6, 5.5, 10; DESIGN-REVIEW S2; v0.3: V03-DESIGN-REVIEW 2.7.5 item 7, 2.8.6;
// MF-46, MF-50). It keeps the real loader open in Playwright Chromium so the site and its ledger have one copy that is always online:
// it seeds the files, relays and stores every ledger block, and can write a snapshot file for the pointer's cs= on a timer.
//
//   node tools/pin.mjs <url> [--headless] [--profile <dir>] [--interval 60] [--no-consent] [--mailbox] [--files]
//                      [--snapshot <file> [--snapshot-every 600] [--plain]] [--max-restarts <n>] [--quiet]
//   node tools/pin.mjs --queue | --pinned | --quarantined --profile <dir>
//   node tools/pin.mjs --approve <infohash> | --decline <infohash> | --quarantine <infohash> --profile <dir> [--reason <text>]
//
// The browser profile persists in --profile (default .tools/pin/<host>), so the site's copy, the ledger and the consent survive restarts.
// v0.3 stores live on disk in the same profile, under <profile>/pin/ (never in tab memory, so a restart keeps them):
//   --mailbox  the pin mailbox (R 2.7.5 item 7): holds the envelopes that senders flagged for holding, with the chat holder quotas (7 days,
//              64 per tag, 4 MiB, at most 1/8 from one source), and releases stranger mail only to a collector that proves it holds the chat
//              key (INBOX-CHAL / INBOX-RESP). It sees IP addresses, tags, sizes and times; the card of the site says so. mailbox.json
//   --files    the file pin (R 2.8.6): members ask the pin node to keep a file with a request their site key signs (src/pin/frames.js
//              pinRequestBytes; unsigned or forged requests are refused, code review v0.3); the request waits in a moderator queue that
//              shows the name, the size, the author key and the declared hash and nothing else; pinning is a moderator action, never
//              automatic; the node counts and hashes bytes and never opens, decodes or renders a file. files/queue, files/pinned,
//              files/quarantine, log.jsonl
//   --quarantine <infohash>  moves a pinned file to an isolated folder (no execute bit, mode 0600), stops seeding it, and logs the action.
//
// v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.1.6; docs/deviations/pin-node.md has the exact contract):
//   --pin-key <jwk file>  the node's own P-256 key (tools/keygen.mjs; never the owner key; mode 600). The site names its public key
//              in _mw.cfg.pin. The pinned page signs mw_pin1 hello and receipt frames through the bridge ('pin.key', 'pin.sign');
//              the Node signer refuses every other byte string (src/pin/frames.js isPinSignable), so the key never enters the page
//              and a page cannot make it sign anything else. Without a URL, --pin-key prints the public key and the ledger-admin command.
//   --status <file> [--status-every 300]  the signed heartbeat (src/pin/heartbeat.js), written atomically with mode 0644 for the
//              owner to publish at <ws base>/pin-status.json: hashed ids of the site torrent and of every pinned file it holds whole.
//   --auto-accept owner  file pin requests the pointer's owner key signed are pinned at once and logged (owner decision SZ-6); files
//              are still never opened or rendered; without the flag nothing changes.
//   --month-cap <size>  uploaded bytes of pinned files are counted per UTC calendar month (month.json); at the cap the pinned files
//              stop seeding (window.__mwPinHost.stop) until the next month. The site torrent always seeds.
//
// Consent: a pinned node exists to share, so the tool presses "Share and load" on the first-run card (shell, or the drop-in card in its
// closed shadow root through window.__mwDropin.rectOf) or "Load" on the gate, once, with a real mouse click; it says so loudly when it
// finds no card and no stored choice. This tool reaches the internet (docs/DEV-NETWORK.md) and prints that before it starts. It needs a
// display unless --headless is given. It is never run by the tests; the stores above are plain classes the unit tests drive with a fake clock.

import {
  mkdirSync, readFileSync, appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync, openSync, writeSync, readSync, closeSync, chmodSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { parsePointer, ledgerIdFor, normalizeScope, verifyPointer } from '../src/common/pointer.js';
import { dbNameFor } from '../src/chain/stores.js';
import { isPublicKeyString, sign as ecdsaSign } from '../src/chain/crypto.js';
import { b64url, asBytes } from '../src/chain/canonical.js';
import { Holder } from '../src/chat/holder.js';
import { decode as decodeFrame } from '../src/chat/frames.js';
import { cleanName } from '../src/files/names.js';
import { parseSignable, SKEW_MS, verifyPinRequest } from '../src/pin/frames.js';
import { makeStatus, signStatus, encodeStatus, STATUS_MAX_ITEMS, STATUS_FILE } from '../src/pin/heartbeat.js';
import { buildSnapshot, encodeSnapshot } from './snapshot.mjs';
import {
  launchBrowser, acceptConsent, renderWithRecovery, readLoaderStatus, formatStatus, readLedgerBlocks, pickLedgerDatabase, allowRemoteFor,
} from './live.mjs';
import { parseCli, runMain, isMain, writeFileAtomic, formatBytes, loadOwnerKey, ROOT, ToolError, UsageError, out, warn } from './lib.mjs';

const USAGE = `
Usage: node tools/pin.mjs <url> [--headless] [--profile <dir>] [--interval <seconds>] [--no-consent] [--mailbox] [--files]
                          [--snapshot <file> [--snapshot-every <seconds>] [--plain]] [--max-restarts <n>] [--quiet]
                          [--pin-key <jwk file> [--status <file> [--status-every <seconds>]]] [--auto-accept owner] [--month-cap <size>]
                          [--max-total <size>] [--mailbox-bytes <size>] [--mailbox-source-fraction <n>]
       node tools/pin.mjs --pin-key <jwk file>
       node tools/pin.mjs --queue | --pinned | --quarantined --profile <dir>
       node tools/pin.mjs --approve <infohash> | --decline <infohash> | --quarantine <infohash> --profile <dir> [--reason <text>] [--by <name>]

--mailbox  keep the pin mailbox (envelopes senders flagged for holding; stranger mail only to a proven collector)
--files    keep the file pin: requests wait in a moderator queue (name, size, author key, declared hash) until --approve
--queue    list the requests that wait         --pinned  list the pinned files        --quarantined  list quarantined files
--approve  pin a queued file (a moderator action)     --decline  refuse it (asked again after 7 days)
--quarantine  move a pinned file to the isolated folder, stop seeding it, log it       --reason  recorded with the action
The stores are plain files under <profile>/pin/ with mode 0600 (directories 0700).

Pin identity, heartbeat and budget (v0.3 C2):
--pin-key <file>     the node's own P-256 key, made with: node tools/keygen.mjs --out pin.jwk (never the owner key; mode 600).
                     The page signs mw_pin1 hello and receipt frames through this process; the key never enters the page.
                     Without a URL it prints the public key and the command that names it in _mw.cfg.pin.
--status <file>      write the signed heartbeat there (mode 644, needs --pin-key); publish it at <ws base>/pin-status.json
--status-every <s>   seconds between heartbeats (default 300, at most 600: visitors ignore one older than 15 minutes)
--auto-accept owner  pin at once the file requests whose author is the site's owner key, and log it (needs --files)
--month-cap <size>   pinned files stop seeding once they uploaded this much in a UTC calendar month (bytes, or 500GiB,
                     2TB, ...), and start again the next month; the site torrent always seeds

Capacity (review round R 5.3, SCALE-9 and SCALE-15):
--max-total <size>   the most bytes of approved files this node keeps in all (default 2GiB); pass it to --approve too
--mailbox-bytes <size>            the mailbox's total bytes (default 4MiB, the per-desktop quota)
--mailbox-source-fraction <n>     one sender may fill at most 1/n of the mailbox (default as in the chat holder)
`;

const IH_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DAY_MS = 86400000;
const isUint = (x) => Number.isSafeInteger(x) && x >= 0;

/** v0.3 C2 settings of the pin identity, the heartbeat and the month cap (chosen; docs/deviations/pin-node.md). */
export const PIN_C2 = Object.freeze({
  statusEveryDefaultSec: 300,
  statusEveryMaxSec: 600,
  statusMinGapMs: 5000,
  signArgMax: 256,
  pageFilesMax: 10000,
  monthSaveEveryMs: 30000,
});

/** Limits of the pin node (chosen; R 2.8.8 sets the per-file caps of the lanes, 100 MiB being the largest). */
export const PIN_LIMITS = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxPending: 200,
  maxPendingPerAuthor: 20,
  declineDays: 7,
  chunkMax: 1024 * 1024,
});

function pinError(code, message) {
  const err = new ToolError(message);
  err.code = code;
  return err;
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// the store: <profile>/pin/ on disk
// ---------------------------------------------------------------------------------------------

/**
 * new PinStore({ profileDir, now })  the directory of the pin node's own state, <profile>/pin/ (mode 0700, files 0600), and its action log
 * (log.jsonl, one JSON object per line: { t, action, ... }). Nothing here is held in memory only.
 */
export class PinStore {
  constructor({ profileDir, now = () => Date.now() } = {}) {
    if (!profileDir) throw new TypeError('PinStore needs the profile directory (--profile)');
    this.profileDir = resolve(profileDir);
    this.dir = join(this.profileDir, 'pin');
    this.now = now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  path(...parts) {
    return join(this.dir, ...parts);
  }

  ensure(...parts) {
    const p = this.path(...parts);
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }

  /** log(entry) appends { t: ISO time, ...entry } to log.jsonl. */
  log(entry) {
    appendFileSync(this.path('log.jsonl'), JSON.stringify(Object.assign({ t: new Date(this.now()).toISOString() }, entry)) + '\n', { mode: 0o600 });
  }

  /** readLog({ limit }) → the last entries, oldest first. */
  readLog({ limit = 100 } = {}) {
    let text = '';
    try {
      text = readFileSync(this.path('log.jsonl'), 'utf8');
    } catch (_) {
      return [];
    }
    const lines = text.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
    return lines.slice(-limit);
  }
}

// ---------------------------------------------------------------------------------------------
// the mailbox: the chat holder with the pin mailbox on, persisted
// ---------------------------------------------------------------------------------------------

/**
 * new Mailbox({ store, quotas, now, pinMailbox })  src/chat/holder.js Holder in pin-mailbox mode (flagged frames only, the holder quotas
 * of R 2.7.5 item 4: 7 days, 64 frames per tag, 4 MiB, at most 1/8 from one source, eviction by stamp work; stranger mail released only
 * after INBOX-CHAL / INBOX-RESP), with the held frames saved to <profile>/pin/mailbox.json and restored in arrival order after a restart.
 * Frames travel as bytes (Uint8Array). `now` is the clock (a fake one in tests).
 */
export class Mailbox {
  constructor({ store = null, quotas = {}, now = () => Date.now(), pinMailbox = true } = {}) {
    this.store = store;
    this.realNow = now;
    this.override = null;
    this.holder = new Holder({ quotas, pinMailbox, now: () => (this.override !== null ? this.override : this.realNow()) });
    this.dirty = false;
    this.file = store ? store.path('mailbox.json') : null;
  }

  /** offer(frameBytes, fromWire) → the holder's verdict { held, holding? | reason }; a held frame marks the store for saving. */
  offer(frameBytes, fromWire) {
    const bytes = frameBytes instanceof Uint8Array ? frameBytes : new Uint8Array(frameBytes);
    const res = this.holder.offer(bytes, decodeFrame(bytes), fromWire);
    if (res.held) this.dirty = true;
    return res;
  }

  want(entries, wire) {
    return this.holder.want(entries, wire);
  }

  challenge(wire) {
    return this.holder.challenge(wire);
  }

  async respond(wire, proof) {
    return this.holder.respond(wire, proof);
  }

  collected(frameIdBytes, proof, wire) {
    const removed = this.holder.collected(frameIdBytes, proof, wire);
    if (removed) this.dirty = true;
    return removed;
  }

  /** expire() drops what is past its 7 days; marks the store for saving when something went. */
  expire() {
    const before = this.holder.stats().count;
    this.holder.expire();
    if (this.holder.stats().count !== before) this.dirty = true;
  }

  stats() {
    return this.holder.stats();
  }

  /** save() writes mailbox.json (atomic, mode 0600) when something changed since the last save → boolean. */
  save() {
    if (!this.file || !this.dirty) return false;
    const items = [];
    for (const it of this.holder.items.values()) items.push({ at: it.at, source: it.source, frame: b64url.encode(it.bytes) });
    items.sort((a, b) => a.at - b.at);
    writeFileAtomic(this.file, JSON.stringify({ v: 1, savedAt: this.realNow(), items }) + '\n', { mode: 0o600 });
    this.dirty = false;
    return true;
  }

  /**
   * load() restores the saved frames in arrival order: each is offered again with the clock set to the time it first arrived, so its seven
   * days run from then and the quotas judge it as they did. Frames past their time are gone. → the number held afterwards.
   */
  load() {
    const saved = this.file ? readJsonOrNull(this.file) : null;
    if (!saved || saved.v !== 1 || !Array.isArray(saved.items)) return this.holder.stats().count;
    const items = saved.items.filter((x) => x && typeof x.frame === 'string' && Number.isSafeInteger(x.at)).sort((a, b) => a.at - b.at);
    try {
      for (const item of items) {
        let bytes;
        try {
          bytes = b64url.decode(item.frame);
        } catch (_) {
          continue;
        }
        this.override = item.at;
        this.holder.offer(bytes, decodeFrame(bytes), String(item.source));
      }
    } finally {
      this.override = null;
    }
    this.holder.expire();
    this.dirty = this.holder.stats().count !== items.length;
    return this.holder.stats().count;
  }
}

// ---------------------------------------------------------------------------------------------
// the file pin: a moderator queue, pinned files on disk, quarantine (R 2.8.6, MF-50)
// ---------------------------------------------------------------------------------------------

/**
 * normalizeRequest(entry) → { ok: true, value } | { ok: false, reason }: the only five things a pin request may carry and the pin node keeps
 * are the infohash, the name, the size, the author's key and the declared hash (the host checks the author's signature over them, `at` and
 * `sig`, before; neither is kept); everything else a requester adds is dropped. The name is
 * stripped of control and bidi characters (a name is text from a stranger); the size is a whole number of bytes under the per-file cap.
 */
export function normalizeRequest(entry, limits = PIN_LIMITS) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'bad-entry' };
  const ih = typeof entry.ih === 'string' ? entry.ih.toLowerCase() : '';
  if (!IH_RE.test(ih)) return { ok: false, reason: 'bad-infohash' };
  if (!Number.isSafeInteger(entry.size) || entry.size < 1) return { ok: false, reason: 'bad-size' };
  if (entry.size > limits.maxFileBytes) return { ok: false, reason: 'too-large' };
  if (!isPublicKeyString(entry.author)) return { ok: false, reason: 'bad-author' };
  let sha256 = null;
  if (entry.sha256 !== undefined && entry.sha256 !== null) {
    sha256 = String(entry.sha256).toLowerCase();
    if (!HEX64_RE.test(sha256)) return { ok: false, reason: 'bad-hash' };
  }
  const name = entry.name === undefined || entry.name === null ? '' : cleanName(String(entry.name), { max: 96 });
  return { ok: true, value: { ih, name, size: entry.size, author: entry.author, sha256 } };
}

function sha256OfFile(file, size) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(1, size)));
    for (let pos = 0; pos < size;) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * new FilePins({ store, seeder, limits, now })
 * seeder = { start(meta) → Promise, stop(ih) → Promise }: how the browser page keeps or drops a torrent (the pin page implements it;
 * tests pass a fake). Without a seeder the stores still work and a stop request is left for the running node (control files).
 *
 *   request(entry) → { queued } | { queued: false, reason }       a member asks; nothing is fetched, nothing is opened
 *   queue() → [{ ih, name, size, author, sha256, requestedAt }]   what a moderator sees: those five fields only
 *   decide(ih, 'accept' | 'decline' | 'deny', { by }) → ...        pinning is a moderator action, never automatic
 *   pinned() / quarantined() / restore() / processControl()
 *   writeChunk(ih, offset, bytes) / finish(ih) / readChunk(ih, offset, length)   the pinned bytes live in <profile>/pin/files/pinned/<ih>/data
 *   quarantine(ih, { reason, by }) → moves the folder to <profile>/pin/quarantine/<ih>/, stops seeding, logs it
 * paused() → true while the month cap (v0.3 C2) holds the pinned files: accept and restore then start no seeding.
 * isDenied(id) → Promise<boolean> (optional; review round MAL53-3): whether the site's ledger has a _deny/ entry for an infohash or a
 * declared SHA-256. decide('accept') and restore() quarantine an item it names (by '_deny/'), and so does a seeder whose start()
 * answers 'denied' (the pin page host checks the page's own ledger: src/loader/pinwire.js createPinPageHost). A check that throws is
 * not a deny.
 */
export class FilePins {
  constructor({ store, seeder = null, limits = {}, now = () => Date.now(), paused = () => false, isDenied = null } = {}) {
    if (!store) throw new TypeError('FilePins needs a PinStore');
    this.store = store;
    this.seeder = seeder;
    this.limits = Object.assign({}, PIN_LIMITS, limits);
    this.now = now;
    this.paused = typeof paused === 'function' ? paused : () => false;
    this.isDenied = typeof isDenied === 'function' ? isDenied : null;
    this.queueDir = store.ensure('files', 'queue');
    this.pinnedDir = store.ensure('files', 'pinned');
    this.declinedDir = store.ensure('files', 'declined');
    this.quarantineDir = store.ensure('quarantine');
    this.controlDir = store.ensure('control');
  }

  setSeeder(seeder) {
    this.seeder = seeder;
  }

  /** _denied(meta) → whether isDenied names the item's infohash or its declared (or measured) SHA-256 (review round MAL53-3). */
  async _denied(meta) {
    if (!this.isDenied || !meta) return false;
    const ids = [meta.ih];
    for (const k of ['sha256', 'sha256Actual']) if (typeof meta[k] === 'string' && /^[0-9a-f]{64}$/.test(meta[k]) && ids.indexOf(meta[k]) < 0) ids.push(meta[k]);
    for (const id of ids) {
      try {
        if (await this.isDenied(id)) return true;
      } catch (_) { /* a failed check is not a deny */ }
    }
    return false;
  }

  /** _quarantineDenied(ih) → the quarantine record: the site's ledger denies the item, so it leaves the pinned store (MAL53-3). */
  async _quarantineDenied(ih) {
    this.store.log({ action: 'ledger-denied', ih });
    return this.quarantine(ih, { reason: "the site's ledger denies this item (_deny/)", by: '_deny/' });
  }

  _ih(ih) {
    const v = typeof ih === 'string' ? ih.toLowerCase() : '';
    if (!IH_RE.test(v)) throw pinError('E_BAD_REQUEST', 'an infohash is 40 hexadecimal characters');
    return v;
  }

  _meta(ih) {
    return readJsonOrNull(join(this.pinnedDir, ih, 'meta.json'));
  }

  _writeMeta(meta) {
    writeFileAtomic(join(this.pinnedDir, meta.ih, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  }

  request(entry) {
    const parsed = normalizeRequest(entry, this.limits);
    if (!parsed.ok) return { queued: false, reason: parsed.reason };
    const v = parsed.value;
    if (this._meta(v.ih)) return { queued: false, reason: 'already-pinned' };
    if (existsSync(join(this.quarantineDir, v.ih))) return { queued: false, reason: 'quarantined' };
    const declined = readJsonOrNull(join(this.declinedDir, v.ih + '.json'));
    if (declined && (declined.until === null || declined.until > this.now())) return { queued: false, reason: 'declined' };
    if (existsSync(join(this.queueDir, v.ih + '.json'))) return { queued: false, reason: 'duplicate' };
    const waiting = this.queue();
    if (waiting.length >= this.limits.maxPending) return { queued: false, reason: 'queue-full' };
    if (waiting.filter((w) => w.author === v.author).length >= this.limits.maxPendingPerAuthor) return { queued: false, reason: 'author-limit' };
    const record = { ih: v.ih, name: v.name, size: v.size, author: v.author, sha256: v.sha256, requestedAt: this.now() };
    writeFileAtomic(join(this.queueDir, v.ih + '.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    this.store.log({ action: 'request', ih: v.ih, size: v.size, author: v.author });
    return { queued: true };
  }

  queue() {
    const list = [];
    for (const f of listDir(this.queueDir)) {
      if (!f.endsWith('.json')) continue;
      const e = readJsonOrNull(join(this.queueDir, f));
      if (e && IH_RE.test(String(e.ih))) list.push({ ih: e.ih, name: e.name, size: e.size, author: e.author, sha256: e.sha256, requestedAt: e.requestedAt });
    }
    return list.sort((a, b) => a.requestedAt - b.requestedAt || (a.ih < b.ih ? -1 : 1));
  }

  pinned() {
    const list = [];
    for (const d of listDir(this.pinnedDir)) {
      const m = IH_RE.test(d) ? this._meta(d) : null;
      if (m) list.push(m);
    }
    return list.sort((a, b) => a.approvedAt - b.approvedAt || (a.ih < b.ih ? -1 : 1));
  }

  quarantined() {
    const list = [];
    for (const d of listDir(this.quarantineDir)) {
      const m = readJsonOrNull(join(this.quarantineDir, d, 'QUARANTINED.json'));
      if (m) list.push(m);
    }
    return list.sort((a, b) => a.quarantinedAt - b.quarantinedAt);
  }

  totalPinnedBytes() {
    return this.pinned().reduce((n, m) => n + m.size, 0);
  }

  /** decide(ih, decision, { by }): 'accept' pins it (and asks the seeder to fetch and keep it); 'decline' refuses for 7 days; 'deny' refuses for good. */
  async decide(ih, decision, { by = 'moderator' } = {}) {
    const id = this._ih(ih);
    if (['accept', 'decline', 'deny'].indexOf(decision) < 0) throw pinError('E_BAD_REQUEST', "the decision is 'accept', 'decline' or 'deny'");
    const file = join(this.queueDir, id + '.json');
    const entry = readJsonOrNull(file);
    if (!entry) throw pinError('E_NOT_QUEUED', id + ' is not in the queue');
    if (decision !== 'accept') {
      const until = decision === 'deny' ? null : this.now() + this.limits.declineDays * DAY_MS;
      writeFileAtomic(join(this.declinedDir, id + '.json'), JSON.stringify({ ih: id, at: this.now(), until, by, decision }) + '\n', { mode: 0o600 });
      unlinkSync(file);
      this.store.log({ action: decision, ih: id, by });
      return { decision, pinned: false };
    }
    // Review round MAL53-3: an item the site's ledger denies is never pinned. It goes to quarantine with a record, so the moderator sees
    // why and a new request for it is refused ('quarantined').
    const denied = await this._denied({ ih: id, sha256: entry.sha256 });
    if (!denied && this.totalPinnedBytes() + entry.size > this.limits.maxTotalBytes) throw pinError('E_PIN_FULL', 'the pin store would pass ' + formatBytes(this.limits.maxTotalBytes) + '; quarantine or remove a pinned file first');
    this.store.ensure('files', 'pinned', id);
    const meta = { ih: id, name: entry.name, size: entry.size, author: entry.author, sha256: entry.sha256, state: 'pinned', requestedAt: entry.requestedAt, approvedAt: this.now(), approvedBy: by };
    this._writeMeta(meta);
    unlinkSync(file);
    if (denied) {
      const q = await this._quarantineDenied(id);
      return { decision, pinned: false, quarantined: true, meta, to: q.to, seeding: false };
    }
    this.store.log({ action: 'approve', ih: id, by });
    let seeding = false;
    if (this.seeder && this.paused()) {
      this.store.log({ action: 'seed-paused', ih: id, reason: 'month-cap' });
    } else if (this.seeder) {
      try {
        if ((await this.seeder.start(meta)) === 'denied') {
          const q = await this._quarantineDenied(id);
          return { decision, pinned: false, quarantined: true, meta, to: q.to, seeding: false };
        }
        seeding = true;
      } catch (err) {
        this.store.log({ action: 'seed-failed', ih: id, error: String((err && err.message) || err) });
      }
    }
    return { decision, pinned: true, meta, seeding };
  }

  /**
   * restore() asks the seeder to keep every pinned file again (after a restart, after the page loaded, and when a new month ends the
   * month cap); stop requests left by a quarantine run are handled first. While paused() it starts nothing. A pinned item that the
   * site's ledger now denies (isDenied, or a seeder start() that answers 'denied') is quarantined instead (review round MAL53-3);
   * the isDenied check also runs while paused or without a seeder.
   */
  async restore() {
    await this.processControl();
    let started = 0;
    if (this.isDenied) {
      for (const meta of this.pinned()) {
        if (await this._denied(meta)) await this._quarantineDenied(meta.ih);
      }
    }
    if (!this.seeder || this.paused()) return started;
    for (const meta of this.pinned()) {
      try {
        if ((await this.seeder.start(meta)) === 'denied') {
          await this._quarantineDenied(meta.ih);
          continue;
        }
        started++;
      } catch (err) {
        this.store.log({ action: 'seed-failed', ih: meta.ih, error: String((err && err.message) || err) });
      }
    }
    return started;
  }

  /** writeChunk(ih, offset, bytes) stores bytes of a pinned file (it only counts them; it never reads the content as anything). */
  writeChunk(ih, offset, bytes) {
    const id = this._ih(ih);
    const meta = this._meta(id);
    if (!meta) throw pinError('E_NOT_PINNED', id + ' is not pinned');
    if (meta.state !== 'pinned') throw pinError('E_COMPLETE', id + ' is already complete');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!Number.isSafeInteger(offset) || offset < 0 || data.length === 0 || data.length > this.limits.chunkMax) throw pinError('E_RANGE', 'a chunk is 1 byte to ' + formatBytes(this.limits.chunkMax) + ' at a whole offset');
    if (offset + data.length > meta.size) throw pinError('E_RANGE', 'the chunk passes the size the request declared (' + meta.size + ' bytes)');
    const part = join(this.pinnedDir, id, 'data.part');
    const fd = openSync(part, existsSync(part) ? 'r+' : 'w', 0o600);
    try {
      writeSync(fd, data, 0, data.length, offset);
    } finally {
      closeSync(fd);
    }
    return { written: data.length };
  }

  /** finish(ih) checks the length and the declared hash, then keeps the file as data (a wrong hash deletes it and says so). */
  finish(ih) {
    const id = this._ih(ih);
    const meta = this._meta(id);
    if (!meta) throw pinError('E_NOT_PINNED', id + ' is not pinned');
    if (meta.state !== 'pinned') return { complete: true, sha256: meta.sha256Actual || meta.sha256 };
    const part = join(this.pinnedDir, id, 'data.part');
    let size = -1;
    try {
      size = statSync(part).size;
    } catch (_) { /* below */ }
    if (size !== meta.size) throw pinError('E_INCOMPLETE', 'the file has ' + Math.max(0, size) + ' of ' + meta.size + ' bytes');
    const actual = sha256OfFile(part, size);
    if (meta.sha256 && actual !== meta.sha256) {
      rmSync(part, { force: true });
      this.store.log({ action: 'hash-mismatch', ih: id, declared: meta.sha256, actual });
      throw pinError('E_FILE_HASH', 'the bytes do not match the hash the request declared; they were deleted');
    }
    renameSync(part, join(this.pinnedDir, id, 'data'));
    chmodSync(join(this.pinnedDir, id, 'data'), 0o600);
    this._writeMeta(Object.assign({}, meta, { state: 'complete', sha256Actual: actual, completedAt: this.now() }));
    this.store.log({ action: 'complete', ih: id, size, sha256: actual });
    return { complete: true, sha256: actual };
  }

  /** readChunk(ih, offset, length) → Buffer: bytes of a complete file, for the page that seeds from disk. */
  readChunk(ih, offset, length) {
    const id = this._ih(ih);
    const meta = this._meta(id);
    if (!meta || meta.state !== 'complete') throw pinError('E_NOT_PINNED', id + ' is not a complete pinned file');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > this.limits.chunkMax || offset >= meta.size) throw pinError('E_RANGE', 'bad range');
    const n = Math.min(length, meta.size - offset);
    const buf = Buffer.allocUnsafe(n);
    const fd = openSync(join(this.pinnedDir, id, 'data'), 'r');
    try {
      readSync(fd, buf, 0, n, offset);
    } finally {
      closeSync(fd);
    }
    return buf;
  }

  /**
   * quarantine(ih, { reason, by }) → { ih, to, stopped, requested }
   * Stops seeding first (the seeder; without one, a stop request is left in control/ for the running node), then moves the pinned folder
   * to <profile>/pin/quarantine/<ih>/ (directory 0700, the bytes renamed data.quarantined with mode 0600, no execute bit), writes
   * QUARANTINED.json next to them and appends the action to log.jsonl. The file is not opened, decoded or rendered.
   */
  async quarantine(ih, { reason = null, by = 'operator' } = {}) {
    const id = this._ih(ih);
    const meta = this._meta(id);
    if (!meta) throw pinError('E_NOT_PINNED', id + ' is not pinned here');
    let stopped = false;
    let requested = false;
    if (this.seeder) {
      try {
        await this.seeder.stop(id);
        stopped = true;
      } catch (err) {
        this.store.log({ action: 'stop-failed', ih: id, error: String((err && err.message) || err) });
      }
    }
    if (!stopped) {
      this.requestStop(id);
      requested = true;
    }
    let to = join(this.quarantineDir, id);
    for (let n = 1; existsSync(to); n++) to = join(this.quarantineDir, id + '.' + n);
    renameSync(join(this.pinnedDir, id), to);
    try {
      chmodSync(to, 0o700);
      for (const f of listDir(to)) {
        const p = join(to, f);
        if (f === 'data' || f === 'data.part') {
          const q = join(to, f + '.quarantined');
          renameSync(p, q);
          chmodSync(q, 0o600);
        } else {
          chmodSync(p, 0o600);
        }
      }
    } catch (_) { /* the move is what matters; a chmod that fails leaves the files as the move left them */ }
    const record = Object.assign({}, meta, { state: 'quarantined', quarantinedAt: this.now(), quarantinedBy: by, reason: reason || null, stopped, from: join('files', 'pinned', id) });
    writeFileAtomic(join(to, 'QUARANTINED.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    this.store.log({ action: 'quarantine', ih: id, by, reason: reason || null, stopped, requestedStop: requested, to: to.slice(this.store.dir.length + 1) });
    return { ih: id, to, stopped, requested };
  }

  /** requestStop(ih) leaves a note for the running node: stop seeding this infohash (control/<time>-stop-<ih>.json). */
  requestStop(ih) {
    const id = this._ih(ih);
    writeFileAtomic(join(this.controlDir, String(this.now()).padStart(15, '0') + '-stop-' + id + '.json'), JSON.stringify({ action: 'stop', ih: id }) + '\n', { mode: 0o600 });
  }

  /** processControl() carries out the notes left by other runs of this tool (stop seeding what was quarantined) and removes them. → how many. */
  async processControl() {
    let done = 0;
    for (const f of listDir(this.controlDir).sort()) {
      const file = join(this.controlDir, f);
      const note = readJsonOrNull(file);
      if (note && note.action === 'stop' && IH_RE.test(String(note.ih)) && this.seeder) {
        try {
          await this.seeder.stop(note.ih);
          this.store.log({ action: 'stopped', ih: note.ih });
          done++;
        } catch (err) {
          this.store.log({ action: 'stop-failed', ih: note.ih, error: String((err && err.message) || err) });
          continue;
        }
      } else if (note && note.action === 'stop' && !this.seeder) {
        continue; // nobody to tell yet: keep it for the next start
      }
      try {
        unlinkSync(file);
      } catch (_) { /* gone */ }
    }
    return done;
  }
}

// ---------------------------------------------------------------------------------------------
// v0.3 C2: the pin key and its signer, the month cap, the heartbeat file (SEEDING-AND-ZERO-SETUP-DESIGN 3.1.6)
// ---------------------------------------------------------------------------------------------

const SIZE_UNITS = Object.freeze({
  '': 1, b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
});

/** parseByteSize(text) → bytes (a whole number, at least 1) for '536870912000', '500GiB', '2 TB', '1.5g'; null otherwise. */
export function parseByteSize(text) {
  const m = /^\s*([0-9]{1,16}(?:\.[0-9]{1,6})?)\s*([A-Za-z]{0,3})\s*$/.exec(String(text));
  if (!m) return null;
  const unit = SIZE_UNITS[m[2].toLowerCase()];
  if (unit === undefined) return null;
  const n = Math.floor(Number(m[1]) * unit);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** utcMonth(ms) → 'YYYY-MM', the UTC calendar month the month cap counts in. */
export function utcMonth(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * loadPinKey(file) → { privateKey (non-extractable), pub, fingerprint }: the pin node's own key, a JWK made by tools/keygen.mjs.
 * Refuses a file that group or others can read or write, like the owner key (tools/lib.mjs loadOwnerKey).
 */
export async function loadPinKey(file) {
  try {
    return await loadOwnerKey(file);
  } catch (err) {
    throw new ToolError('--pin-key: ' + ((err && err.message) || err));
  }
}

/** pinKeyLines(key) → the lines --pin-key prints: the public key and the command that names it in _mw.cfg.pin. */
export function pinKeyLines(key) {
  return [
    'Pin key: ' + key.pub + (key.fingerprint ? ' (fingerprint ' + key.fingerprint + ')' : ''),
    'Visitors trust this node\'s hello, receipts and heartbeat only when the site names this key. With the owner key, offline:',
    '  node tools/ledger-admin.mjs cfg --key owner.jwk --file <ledger.json> --pin ' + key.pub,
  ];
}

/**
 * createPinSigner({ key, now, skewMs, kept }) → { pub, check(bytes), sign(bytes), signB64(text), signStatus(obj), disable(reason), disabled }
 * The Node side of 'pin.sign'. It signs only byte strings parseSignable() accepts (an mw_pin1 hello or receipt), only when their `at`
 * is within skewMs (5 minutes) of this clock, and a receipt only for an infohash kept(ih) says this node keeps (the site torrent or a
 * pinned file). Refusals throw with code E_NOT_SIGNABLE, E_STALE, E_NOT_KEPT, E_BAD_REQUEST, or E_POLICY once disabled (the pin key
 * turned out to be the site's owner key). The heartbeat is signed here too (signStatus), never through the page.
 */
export function createPinSigner({ key, now = () => Date.now(), skewMs = SKEW_MS, kept = null } = {}) {
  if (!key || !key.privateKey || !isPublicKeyString(key.pub)) throw new TypeError('createPinSigner needs { privateKey, pub } (loadPinKey)');
  let disabled = null;
  const check = (bytes) => {
    if (disabled) return { ok: false, code: 'E_POLICY', reason: disabled };
    const p = parseSignable(bytes);
    if (!p) return { ok: false, code: 'E_NOT_SIGNABLE', reason: 'the pin key signs only mw_pin1 hello and receipt strings' };
    if (Math.abs(now() - p.at) > skewMs) return { ok: false, code: 'E_STALE', reason: 'at is more than ' + Math.round(skewMs / 60000) + ' minutes from this clock' };
    if (p.kind === 'receipt' && typeof kept === 'function' && !kept(p.ih)) return { ok: false, code: 'E_NOT_KEPT', reason: 'this pin node does not keep ' + p.ih };
    return { ok: true, parsed: p };
  };
  const signBytes = async (bytes) => {
    const c = check(bytes);
    if (!c.ok) throw pinError(c.code, c.reason);
    return ecdsaSign(key.privateKey, asBytes(bytes));
  };
  return {
    pub: key.pub,
    fingerprint: key.fingerprint || null,
    check,
    sign: signBytes,
    async signB64(text) {
      if (typeof text !== 'string' || !text || text.length > PIN_C2.signArgMax) throw pinError('E_BAD_REQUEST', 'pin.sign takes the base64url of the bytes to sign');
      let bytes;
      try {
        bytes = b64url.decode(text);
      } catch (_) {
        throw pinError('E_BAD_REQUEST', 'pin.sign takes the base64url of the bytes to sign');
      }
      return b64url.encode(await signBytes(bytes));
    },
    async signStatus(obj) {
      if (disabled) throw pinError('E_POLICY', disabled);
      return signStatus(obj, key.privateKey);
    },
    disable(reason) {
      disabled = String(reason || 'disabled');
    },
    get disabled() {
      return disabled;
    },
  };
}

/**
 * new MonthMeter({ store, cap, now })  the month cap's counter: uploaded bytes of pinned files in the current UTC calendar month,
 * saved to <profile>/pin/month.json (mode 0600) so a restart keeps the count. The page reports cumulative counters per infohash for
 * its session; sample() adds the growth since the last sample (a smaller value means the page started again), newSession() forgets
 * the old counters when the page is replaced or reloaded. Bytes counted at the first sample after midnight UTC go to the new month.
 */
export class MonthMeter {
  constructor({ store = null, cap = null, now = () => Date.now() } = {}) {
    if (cap !== null && !(Number.isSafeInteger(cap) && cap >= 1)) throw new TypeError('the month cap is a number of bytes or null');
    this.cap = cap;
    this.now = now;
    this.file = store ? store.path('month.json') : null;
    this.month = utcMonth(now());
    this.bytes = 0;
    this.last = new Map();
    this.dirty = false;
    this.savedAt = 0;
    const saved = this.file ? readJsonOrNull(this.file) : null;
    if (saved && saved.v === 1 && saved.month === this.month && isUint(saved.bytes)) this.bytes = saved.bytes;
  }

  /** roll() → true when a new UTC month began since the last call: the count starts again at 0. */
  roll() {
    const m = utcMonth(this.now());
    if (m === this.month) return false;
    this.month = m;
    this.bytes = 0;
    this.dirty = true;
    this.save(true);
    return true;
  }

  newSession() {
    this.last.clear();
  }

  /** sample(files = [{ ih, uploaded }]) → bytes added to this month. */
  sample(files) {
    let added = 0;
    for (const f of files || []) {
      if (!f || !IH_RE.test(String(f.ih)) || !isUint(f.uploaded)) continue;
      const prev = this.last.has(f.ih) ? this.last.get(f.ih) : 0;
      added += f.uploaded >= prev ? f.uploaded - prev : f.uploaded;
      this.last.set(f.ih, f.uploaded);
    }
    if (added > 0) {
      const wasPaused = this.paused();
      this.bytes = Math.min(Number.MAX_SAFE_INTEGER, this.bytes + added);
      this.dirty = true;
      this.save(this.paused() !== wasPaused);
    }
    return added;
  }

  /** paused() → true once this month's count reached the cap. */
  paused() {
    return this.cap !== null && this.bytes >= this.cap;
  }

  /** save(force) writes month.json when the count changed, at most every 30 s unless forced. */
  save(force = false) {
    if (!this.file || !this.dirty) return false;
    if (!force && this.now() - this.savedAt < PIN_C2.monthSaveEveryMs) return false;
    writeFileAtomic(this.file, JSON.stringify({ v: 1, month: this.month, bytes: this.bytes }) + '\n', { mode: 0o600 });
    this.dirty = false;
    this.savedAt = this.now();
    return true;
  }

  snapshot() {
    return { month: this.month, bytes: this.bytes, cap: this.cap, paused: this.paused() };
  }
}

/**
 * writeStatusFile(file, status) writes a signed heartbeat atomically (a temporary file in the same directory, then a rename) with
 * mode 0644: the owner publishes it, so the web server must be able to read it. It holds no secret.
 */
export function writeStatusFile(file, status) {
  const text = encodeStatus(status);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), '.' + basename(file) + '.' + randomBytes(6).toString('hex') + '.tmp');
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    chmodSync(tmp, 0o644); // the umask can remove bits; the server must read it
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * pinPageProbe() runs in the pinned page (page.evaluate): the loader's read-only diagnostics (window.__mwShell or
 * window.__mwDropin: btih, ledgerId, whether the site is mounted), the page tag, and window.__mwPinHost.status() when the page
 * offers it ({ files: [{ ih, uploaded, complete }] }, the page side of the pin; docs/deviations/pin-node.md).
 */
async function pinPageProbe() {
  const h = window.__mwShell || window.__mwDropin;
  let info = null;
  try {
    info = h && typeof h.inspect === 'function' ? h.inspect() : null;
  } catch (_) {
    info = null;
  }
  const meta = document.querySelector('meta[name="mw-pointer"]');
  let files = null;
  const ph = window.__mwPinHost;
  if (ph && typeof ph.status === 'function') {
    try {
      const st = await Promise.race([Promise.resolve(ph.status()), new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
      if (st && Array.isArray(st.files)) {
        files = st.files.slice(0, 10000).map((f) => ({ ih: String(f && f.ih), uploaded: Number(f && f.uploaded), complete: Boolean(f && f.complete === true) }));
      }
    } catch (_) {
      files = null;
    }
  }
  return {
    btih: info && typeof info.btih === 'string' ? info.btih : null,
    ledgerId: info && typeof info.ledgerId === 'string' ? info.ledgerId : null,
    mounted: Boolean(info && (info.mounted === true || (info.copy && info.copy.btih))),
    pointer: meta ? meta.getAttribute('content') : null,
    files,
  };
}

async function pointerFacts(text, url, now) {
  try {
    const parsed = parsePointer(text);
    if (!parsed.ok) return { owner: null, ledgerId: null, reason: parsed.reason || 'unparsed' };
    const scope = normalizeScope(new URL(url).hostname);
    const v = await verifyPointer(parsed.record, scope, { now, allowExpired: true });
    if (!v.ok) return { owner: null, ledgerId: null, reason: v.reason };
    if (v.withdrawn) return { owner: null, ledgerId: null, reason: 'withdrawn' };
    return { owner: parsed.record.owner, ledgerId: await ledgerIdFor(parsed.record, scope), reason: null };
  } catch (err) {
    return { owner: null, ledgerId: null, reason: String((err && err.message) || err) };
  }
}

/**
 * parsePinPage(raw, { url, cache, now }) → { site: { btih, ledgerId, mounted, owner }, files: [{ ih, uploaded, complete }] | null }
 * Turns what pinPageProbe() returned into checked values. The owner key comes from the page tag, verified for the URL's host (an
 * expired tag still names its owner; a withdrawn or badly signed one names nobody); verified tags are cached by their text.
 */
export async function parsePinPage(raw, { url, cache = new Map(), now = Date.now() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const site = {
    btih: typeof r.btih === 'string' && IH_RE.test(r.btih) ? r.btih : null,
    ledgerId: typeof r.ledgerId === 'string' && r.ledgerId.length >= 1 && r.ledgerId.length <= 128 ? r.ledgerId : null,
    mounted: r.mounted === true,
    owner: null,
  };
  if (typeof r.pointer === 'string' && r.pointer.length > 0 && r.pointer.length <= 4096 && url) {
    let facts = cache.get(r.pointer);
    if (facts === undefined) {
      facts = await pointerFacts(r.pointer, url, now);
      cache.set(r.pointer, facts);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    site.owner = facts.owner;
    if (!site.ledgerId) site.ledgerId = facts.ledgerId;
  }
  let files = null;
  if (Array.isArray(r.files)) {
    files = r.files.slice(0, PIN_C2.pageFilesMax).filter((f) => f && typeof f.ih === 'string' && IH_RE.test(f.ih)).map((f) => ({
      ih: f.ih, uploaded: isUint(f.uploaded) ? f.uploaded : null, complete: f.complete === true,
    }));
  }
  return { site, files };
}

// ---------------------------------------------------------------------------------------------
// the host: what the pin page may ask of the Node side (binary as base64url, everything bounded)
// ---------------------------------------------------------------------------------------------

const unb64 = (s) => b64url.decode(String(s));
const b64 = (u8) => b64url.encode(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));

/**
 * createPinHost({ profileDir, mailbox, files, seeder, now, limits, quotas, pinKey, autoAccept, monthCap, isDenied, log })
 *   → { store, mailbox, files, signer, meter, call(op, arg), start(), tick(), stats(), setSeeder(), observe(info), setSite(site),
 *       site(), statusItems(), heartbeat({ empty }), writeStatus(file, { empty }), statusDirty(), resume(), pageChanged() }
 * call(op, arg) is the one door for the page: 'file.request', 'file.write', 'file.finish', 'file.read', 'file.pinned', 'mailbox.offer',
 * 'mailbox.want', 'mailbox.challenge', 'mailbox.respond', 'mailbox.collected', 'stats', and (v0.3 C2) 'pin.key' → the pin's public key
 * or null, 'pin.sign' (the base64url of a hello or receipt string) → the base64url signature. Arguments are plain objects (pin.sign
 * takes the string); frames, keys and file bytes are base64url strings. A feature that was not switched on (--mailbox, --files,
 * --pin-key) refuses.
 *
 * v0.3 C2: pinKey ({ privateKey, pub } from loadPinKey) makes the signer; autoAccept 'owner' pins at once the file requests whose
 * author is the site's owner key (setSite / observe tell the host who that is; requests that came first are pinned when it is known);
 * monthCap (bytes) stops the pinned files' seeding at the cap and starts it again the next month. observe(info) takes what the page
 * reports (parsePinPage), heartbeat() builds the signed heartbeat from the site torrent (when mounted) and the pinned files held whole.
 */
export function createPinHost({
  profileDir, mailbox = false, files = false, seeder = null, now = () => Date.now(), limits = {}, quotas = {},
  pinKey = null, autoAccept = null, monthCap = null, isDenied = null, log = () => {},
} = {}) {
  if (autoAccept !== null && autoAccept !== 'owner') throw new TypeError("autoAccept is 'owner' or null");
  const store = new PinStore({ profileDir, now });
  const meter = new MonthMeter({ store, cap: monthCap, now });
  const mb = mailbox ? new Mailbox({ store, quotas, now }) : null;
  const fp = files ? new FilePins({ store, seeder, limits, now, paused: () => meter.paused(), isDenied }) : null;
  const site = { btih: null, ledgerId: null, mounted: false, owner: null };
  const complete = new Set(); // pinned infohashes the page reports whole and verified
  let wasPaused = meter.paused();
  let dirty = true;
  let warnedItems = false;
  const kept = (ih) => (site.btih !== null && ih === site.btih) || Boolean(fp && IH_RE.test(String(ih)) && fp._meta(ih));
  const signer = pinKey ? createPinSigner({ key: pinKey, now, kept }) : null;
  const need = (x, what) => {
    if (!x) throw pinError('E_POLICY', 'this pin node runs without ' + what);
    return x;
  };
  const arg0 = (a) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw pinError('E_BAD_REQUEST', 'the argument is an object');
    return a;
  };

  // --- auto-accept (owner decision SZ-6): the owner's own requests skip the moderator queue; files are still never opened ---
  async function acceptOwner(ih, author) {
    store.log({ action: 'auto-accept', ih, author, rule: 'owner' });
    try {
      const d = await fp.decide(ih, 'accept', { by: 'auto-accept owner' });
      if (d.quarantined) {
        log('auto-accept of ' + ih + ": the site's ledger denies it (_deny/), so it was quarantined, not pinned");
        dirty = true;
        return { queued: false, accepted: false, reason: 'denied' };
      }
      log('auto-accepted ' + ih + ' (' + formatBytes(d.meta.size) + '): its author is the site\'s owner key; the file is not opened');
      dirty = true;
      return { queued: true, accepted: true, seeding: d.seeding };
    } catch (err) {
      store.log({ action: 'auto-accept-failed', ih, error: String((err && err.message) || err) });
      log('auto-accept of ' + ih + ' failed (' + ((err && err.message) || err) + '): it waits in the queue for a moderator');
      return { queued: true, accepted: false, reason: (err && err.code) || 'failed' };
    }
  }
  // Code review v0.3 (security lens finding 12): page script reaches this door, the site's own code included (a same-origin
  // site frame calls window.top.__mwPinCall), so a request is taken only when its author signed it for this ledger
  // (src/pin/frames.js verifyPinRequest): the author shown in the moderator queue is the key that asked, and only a request
  // the owner key signed can skip the queue.
  async function request(entry) {
    const files = need(fp, '--files');
    const e = arg0(entry);
    const shape = normalizeRequest(e, fp.limits);
    if (!shape.ok) return { queued: false, reason: shape.reason };
    if (!site.ledgerId) return { queued: false, reason: 'site-unknown' };
    const proof = await verifyPinRequest(e, { site: site.ledgerId, now: now() });
    if (!proof.ok) {
      store.log({ action: 'request-refused', reason: proof.reason });
      return { queued: false, reason: proof.reason === 'unsigned' ? 'unsigned' : 'bad-signature' };
    }
    const r = files.request(e);
    if (!r.queued || autoAccept !== 'owner') return r;
    const v = normalizeRequest(e, fp.limits).value;
    if (!site.owner) {
      store.log({ action: 'auto-accept-wait', ih: v.ih, reason: 'owner-unknown' });
      return r;
    }
    return v.author === site.owner ? acceptOwner(v.ih, v.author) : r;
  }
  async function sweepAutoAccept() {
    if (autoAccept !== 'owner' || !fp || !site.owner) return 0;
    let n = 0;
    for (const e of fp.queue()) {
      if (e.author !== site.owner) continue;
      if ((await acceptOwner(e.ih, e.author)).accepted) n++;
    }
    return n;
  }

  // --- what the page reports ---
  async function setSite(s = {}) {
    const before = { owner: site.owner, btih: site.btih, mounted: site.mounted, ledgerId: site.ledgerId };
    if (s.btih !== undefined) site.btih = typeof s.btih === 'string' && IH_RE.test(s.btih) ? s.btih : null;
    if (s.ledgerId !== undefined) site.ledgerId = typeof s.ledgerId === 'string' && s.ledgerId ? s.ledgerId : null;
    if (s.mounted !== undefined) site.mounted = s.mounted === true;
    if (s.owner !== undefined) site.owner = isPublicKeyString(s.owner) ? s.owner : null;
    if (signer && !signer.disabled && site.owner && site.owner === signer.pub) {
      signer.disable('the pin key is the site\'s owner key: make a separate one with node tools/keygen.mjs --out pin.jwk');
      store.log({ action: 'signer-off', reason: 'owner-key' });
      log('ERROR: --pin-key is the site\'s owner key. Never keep the owner key on a pin node: make a separate key (node tools/keygen.mjs --out pin.jwk) and name it with ledger-admin cfg --pin. This node signs nothing until then.');
    }
    if (site.btih !== before.btih || site.mounted !== before.mounted || site.ledgerId !== before.ledgerId) dirty = true;
    if (site.owner !== before.owner) await sweepAutoAccept();
  }
  async function stopPinned() {
    if (!fp || !fp.seeder) return 0;
    let n = 0;
    for (const m of fp.pinned()) {
      try {
        await fp.seeder.stop(m.ih);
        n++;
      } catch (err) {
        store.log({ action: 'stop-failed', ih: m.ih, error: String((err && err.message) || err) });
      }
    }
    return n;
  }
  /**
   * observe({ site, files }) → { rolled, paused, monthBytes }: the page's report (parsePinPage); applies the month cap. A null btih,
   * ledger id or owner in a report means "not known right now" (a page in the middle of a reload), so the last known value stays;
   * mounted always follows the page.
   */
  async function observe({ site: s = null, files: list = null } = {}) {
    if (s) {
      const known = { mounted: s.mounted === true };
      for (const k of ['btih', 'ledgerId', 'owner']) if (s[k]) known[k] = s[k];
      await setSite(known);
    }
    const rolled = meter.roll();
    if (Array.isArray(list) && fp) {
      const pinned = new Set(fp.pinned().map((m) => m.ih));
      const counted = [];
      for (const f of list) {
        if (!f || !IH_RE.test(String(f.ih)) || f.ih === site.btih || !pinned.has(f.ih)) continue;
        if (f.complete === true && !complete.has(f.ih)) {
          complete.add(f.ih);
          dirty = true;
        } else if (f.complete !== true && complete.has(f.ih)) {
          complete.delete(f.ih);
          dirty = true;
        }
        if (isUint(f.uploaded)) counted.push({ ih: f.ih, uploaded: f.uploaded });
      }
      meter.sample(counted);
    }
    const paused = meter.paused();
    if (paused && !wasPaused) {
      wasPaused = true;
      dirty = true;
      meter.save(true);
      store.log({ action: 'month-cap', month: meter.month, bytes: meter.bytes, cap: meter.cap });
      const stopped = await stopPinned();
      log('month cap reached (' + formatBytes(meter.bytes) + ' of ' + formatBytes(meter.cap) + ' in ' + meter.month + ' UTC): ' + stopped + ' pinned file(s) stop seeding until the next month; the site keeps seeding');
    } else if (!paused && wasPaused) {
      wasPaused = false;
      dirty = true;
      store.log({ action: 'month-resume', month: meter.month });
      const started = fp ? await fp.restore() : 0;
      log('a new month (' + meter.month + ' UTC): ' + started + ' pinned file(s) seed again');
    }
    return { rolled, paused, monthBytes: meter.bytes };
  }

  // --- the heartbeat ---
  /** statusItems() → the infohashes the heartbeat lists: the site torrent while mounted, then pinned files held whole (none while paused). */
  function statusItems() {
    const items = [];
    if (site.btih && site.mounted) items.push(site.btih);
    if (fp && !meter.paused()) {
      for (const m of fp.pinned()) if (m.state === 'complete' || complete.has(m.ih)) items.push(m.ih);
    }
    if (items.length > STATUS_MAX_ITEMS) {
      if (!warnedItems) log('the heartbeat lists the first ' + STATUS_MAX_ITEMS + ' of ' + items.length + ' items (its cap)');
      warnedItems = true;
      items.length = STATUS_MAX_ITEMS;
    }
    return items;
  }
  /** heartbeat({ empty }) → the signed heartbeat, or null while the site's ledger id is unknown or the signer is off. */
  async function heartbeat({ empty = false } = {}) {
    if (!signer) throw pinError('E_POLICY', 'the heartbeat needs --pin-key');
    if (signer.disabled || !site.ledgerId) return null;
    const obj = makeStatus({ key: signer.pub, site: site.ledgerId, at: now(), ihs: empty ? [] : statusItems(), monthBytes: meter.bytes, monthCap: meter.cap });
    return signer.signStatus(obj);
  }
  async function writeStatus(file, opts = {}) {
    const st = await heartbeat(opts);
    if (!st) return null;
    writeStatusFile(file, st);
    dirty = false;
    return st;
  }

  async function call(op, arg) {
    switch (op) {
      case 'file.request': return request(arg);
      case 'file.write': {
        const a = arg0(arg);
        return need(fp, '--files').writeChunk(a.ih, a.offset, unb64(a.data));
      }
      case 'file.finish': {
        const r = need(fp, '--files').finish(arg0(arg).ih);
        dirty = true;
        return r;
      }
      case 'file.read': {
        const a = arg0(arg);
        return { data: b64(need(fp, '--files').readChunk(a.ih, a.offset, a.length)) };
      }
      case 'file.pinned': {
        const paused = meter.paused();
        return need(fp, '--files').pinned().map((m) => Object.assign({ ih: m.ih, name: m.name, size: m.size, state: m.state }, paused ? { paused: true } : {}));
      }
      case 'mailbox.offer': {
        const a = arg0(arg);
        const r = need(mb, '--mailbox').offer(unb64(a.frame), String(a.wire));
        return r.held ? { held: true, holding: { tag: b64(r.holding.tag), frameId: b64(r.holding.frameId), expiry: r.holding.expiry } } : r;
      }
      case 'mailbox.want': {
        const a = arg0(arg);
        if (!Array.isArray(a.entries) || a.entries.length > 32) throw pinError('E_BAD_REQUEST', 'at most 32 entries');
        return { frames: need(mb, '--mailbox').want(a.entries.map(unb64), String(a.wire)).map(b64) };
      }
      case 'mailbox.challenge': {
        const r = await need(mb, '--mailbox').challenge(String(arg0(arg).wire));
        return r ? { challenge: b64(r.challenge), hepk: b64(r.hepk) } : null;
      }
      case 'mailbox.respond': {
        const a = arg0(arg);
        const frames = await need(mb, '--mailbox').respond(String(a.wire), { ek: unb64(a.ek), proof: unb64(a.proof) });
        return frames ? { frames: frames.map(b64) } : null;
      }
      case 'mailbox.collected': {
        const a = arg0(arg);
        return { removed: need(mb, '--mailbox').collected(unb64(a.frameId), unb64(a.proof), String(a.wire)) };
      }
      case 'pin.key': return signer && !signer.disabled ? signer.pub : null;
      case 'pin.sign': return need(signer, '--pin-key').signB64(arg);
      case 'stats': return stats();
      default: throw pinError('E_BAD_REQUEST', 'unknown pin operation ' + JSON.stringify(String(op).slice(0, 40)));
    }
  }
  function stats() {
    return {
      mailbox: mb ? mb.stats() : null,
      queue: fp ? fp.queue().length : null,
      pinned: fp ? fp.pinned().length : null,
      quarantined: fp ? fp.quarantined().length : null,
      month: meter.snapshot(),
      key: signer ? { pub: signer.pub, off: Boolean(signer.disabled) } : null,
    };
  }
  return {
    store,
    mailbox: mb,
    files: fp,
    signer,
    meter,
    call,
    stats,
    observe,
    setSite,
    statusItems,
    heartbeat,
    writeStatus,
    site: () => Object.assign({}, site),
    statusDirty: () => dirty,
    setSeeder(s) {
      if (fp) fp.setSeeder(s);
    },
    /** start() restores the mailbox from disk and asks the seeder to keep the pinned files again (not while the month cap holds). */
    async start() {
      if (mb) mb.load();
      if (fp) await fp.restore();
    },
    /** resume() asks the page to keep the pinned files again once it has loaded (not while the month cap holds). → how many. */
    async resume() {
      return fp ? fp.restore() : 0;
    },
    /** pageChanged() forgets what the old page reported: its upload counters, which files it held whole, whether the site was mounted. */
    pageChanged() {
      meter.newSession();
      complete.clear();
      site.mounted = false;
      dirty = true;
    },
    /** tick() saves the mailbox, drops what expired, carries out notes left by other runs of this tool, and saves the month count. */
    async tick() {
      if (mb) {
        mb.expire();
        mb.save();
      }
      if (fp) await fp.processControl();
      meter.save();
    },
  };
}

/**
 * attachPinBridge(context, host, { page }) exposes window.__mwPinCall(op, arg) in the pinned page (Playwright exposeBinding). It answers the
 * binding of the page's top frame only, but that is no boundary (code review v0.3): the shell's site frame is same-origin with it and calls
 * window.top.__mwPinCall, which Playwright reports as the top frame, and in drop-in mode the site's pages are the top frame. So every
 * operation is built for page script, the site's own code included: a file request counts only with its author's signature (only the
 * owner's skips the moderator queue), mailbox frames go to collectors that prove the chat key, the Node signer signs nothing but mw_pin1
 * hello and receipt strings for what this node keeps, and the heartbeat is signed in Node. Pin sites you run (docs/DEPLOY.md, "The pin node").
 */
export async function attachPinBridge(context, host, { page = null } = {}) {
  await context.exposeBinding('__mwPinCall', async (source, op, arg) => {
    if (page && (source.page !== page || source.frame !== page.mainFrame())) throw new Error('the pin bridge answers the top frame of the pinned page only');
    return host.call(op, arg);
  });
}

/** pageSeeder(getPage, log) → a seeder that asks window.__mwPinHost of the pinned page to keep or drop a torrent (the page side is wired by the SDK lane). */
export function pageSeeder(getPage, log = () => {}) {
  const ask = async (method, arg) => {
    const page = getPage();
    if (!page) return 'no-page';
    return page.evaluate(([m, a]) => (window.__mwPinHost && typeof window.__mwPinHost[m] === 'function' ? window.__mwPinHost[m](a) : 'no-host'), [method, arg]);
  };
  return {
    async start(meta) {
      // sha256 and sha256Actual let the page host check the ledger's _deny/ by the declared hash too (review round MAL53-3).
      const r = await ask('start', { ih: meta.ih, name: meta.name, size: meta.size, state: meta.state, sha256: meta.sha256 || null, sha256Actual: meta.sha256Actual || null });
      if (r === 'no-host') log('the pinned page has no pin host (window.__mwPinHost): ' + meta.ih + ' is pinned on disk and will be seeded when the page offers one');
      return r;
    },
    async stop(ih) {
      const r = await ask('stop', ih);
      if (r === 'no-host') log('the pinned page has no pin host (window.__mwPinHost): it could not be asked to stop seeding ' + ih);
      return r;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// the browser run
// ---------------------------------------------------------------------------------------------

/** Delay before restart number `attempt` (0 based): 5 s, doubling, at most 5 minutes. */
export function backoffMs(attempt) {
  return Math.min(300000, 5000 * 2 ** Math.max(0, attempt));
}

/** One log line for a status object from readLoaderStatus. */
export function statusLine(status, { restarts = 0, now = new Date(), extra = '' } = {}) {
  return now.toISOString().slice(11, 19) + ' ' + formatStatus(status) + (extra ? ' | ' + extra : '') + (restarts ? ' (restarts: ' + restarts + ')' : '');
}

/** pinStatsLine(stats) → "mailbox 3 frames (4.1 KiB) | files: 2 waiting, 5 pinned | month 1.2 GiB of 500 GiB" for the status line, or ''. */
export function pinStatsLine(stats) {
  const parts = [];
  if (stats && stats.mailbox) parts.push('mailbox ' + stats.mailbox.count + ' frame(s) (' + formatBytes(stats.mailbox.bytes) + ')');
  if (stats && stats.queue !== null && stats.queue !== undefined) parts.push('files: ' + stats.queue + ' waiting, ' + stats.pinned + ' pinned');
  if (stats && stats.month && stats.month.cap !== null && stats.month.cap !== undefined) {
    parts.push('month ' + formatBytes(stats.month.bytes) + ' of ' + formatBytes(stats.month.cap) + (stats.month.paused ? ' (pinned files paused)' : ''));
  }
  return parts.join(' | ');
}

/** True when the loader asks for a reload because a newer pointer exists. */
export function wantsReload(status) {
  return Boolean(status && status.banners && status.banners.some((b) => /Update available: reload/.test(b)));
}

/** True when the status says the loader cannot continue (boot stopped or an error card is up). */
export function isBroken(status) {
  return !status || status.bootStage === 'stopped' || Boolean(status.error);
}

async function readBanners(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.mw-banner')).map((b) => String(b.textContent || '').replace(/\s+/g, ' ').trim()));
}

async function expectedDatabase(page, url) {
  try {
    const text = await page.evaluate(() => {
      const m = document.querySelector('meta[name="mw-pointer"]');
      return m ? m.getAttribute('content') : null;
    });
    if (!text) return null;
    const parsed = parsePointer(text);
    if (!parsed.ok) return null;
    return dbNameFor(await ledgerIdFor(parsed.record, normalizeScope(new URL(url).hostname)));
  } catch (_) {
    return null;
  }
}

async function writeSnapshot(page, url, file, plain, log) {
  const found = await readLedgerBlocks(page);
  const picked = pickLedgerDatabase(found, await expectedDatabase(page, url));
  if (!picked || !picked.blocks.length) {
    log('snapshot: no ledger blocks yet');
    return;
  }
  // Code review v0.3: the page's copy prunes to the owner's checkpoints; S then stands for the covered blocks and goes first.
  const snap = await buildSnapshot({ blocks: picked.blocks, checkpoint: picked.checkpoint || null });
  const data = encodeSnapshot(snap.entries, { plain });
  writeFileAtomic(file, data);
  log('snapshot: ' + snap.height + ' blocks' + (snap.checkpoint ? ' after checkpoint ' + snap.checkpoint.h.slice(0, 16) + '...' : '') + ' -> ' + file + ' (' + formatBytes(data.length) + ')');
}

/**
 * runPin({ url, headless, profileDir, intervalSec, consent, snapshotFile, snapshotEverySec, plain, mailbox, files, maxRestarts, log, signal,
 *          pinKey, statusFile, statusEverySec, autoAccept, monthCap, allowRemote })
 * Runs until `signal` aborts (or maxRestarts is used up); resolves with the number of restarts.
 * mailbox and files (v0.3) switch on the stores under <profile>/pin/; they survive the restarts of the session because they are on disk.
 * v0.3 C2: pinKey (loadPinKey) answers 'pin.key' and 'pin.sign' on the bridge; statusFile writes the signed heartbeat every
 * statusEverySec seconds (and soon after a change), and a heartbeat that lists nothing when the browser stops; autoAccept 'owner' and
 * monthCap as in createPinHost. Every two seconds the page is asked what it holds (pinPageProbe). allowRemote: false forces the
 * local-only browser (a loopback URL always gets it; nothing here can open the remote one for a loopback page). onHost(host) is
 * called with the pin host once it started (test/fixtures/pin/start-pin.mjs reads its stores).
 */
export async function runPin(options) {
  const o = Object.assign({
    headless: false, profileDir: null, intervalSec: 60, consent: true, snapshotFile: null, snapshotEverySec: 600, plain: false,
    mailbox: false, files: false, maxRestarts: Infinity, log: out, signal: new AbortController().signal,
    pinKey: null, statusFile: null, statusEverySec: PIN_C2.statusEveryDefaultSec, autoAccept: null, monthCap: null, allowRemote: null, onHost: null,
    onPage: null,
  }, options);
  if (o.statusFile && !o.pinKey) throw new UsageError('--status writes a signed heartbeat: add --pin-key <jwk file>');
  if (o.autoAccept && !o.files) throw new UsageError('--auto-accept owner works on file pin requests: add --files');
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    o.signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
  let currentPage = null;
  let pageReady = false;
  let host = null;
  let tickTimer = null;
  let busy = false;
  if (o.mailbox || o.files || o.pinKey || (o.monthCap !== null && o.monthCap !== undefined)) {
    host = createPinHost({
      profileDir: o.profileDir, mailbox: o.mailbox, files: o.files, seeder: pageSeeder(() => currentPage, o.log),
      pinKey: o.pinKey || null, autoAccept: o.autoAccept || null, monthCap: o.monthCap === undefined ? null : o.monthCap, log: o.log,
      limits: o.limits || {}, quotas: o.quotas || {},
    });
    await host.start();
    if (typeof o.onHost === 'function') o.onHost(host);
    const pointerCache = new Map();
    let lastStatus = 0;
    let lastStatusTry = 0;
    let lastCount = -1;
    let waitingSaid = false;
    let ownerSaid = false;
    let lastWarning = '';
    // The page report feeds the signer (which infohashes are kept), auto-accept (the owner key), the month cap and the heartbeat.
    const wantReport = Boolean(host.signer || host.files || host.meter.cap !== null);
    const warnOnce = (line) => {
      if (line !== lastWarning) warn(line);
      lastWarning = line;
    };
    const pinTick = async () => {
      await host.tick();
      const page = currentPage;
      if (page && pageReady && wantReport) {
        const raw = await page.evaluate(pinPageProbe).catch(() => null);
        if (raw && page === currentPage && pageReady) await host.observe(await parsePinPage(raw, { url: o.url, cache: pointerCache }));
        if (o.autoAccept && !host.site().owner && !ownerSaid && page === currentPage) {
          ownerSaid = true;
          o.log('auto-accept: the page names no owner key verified for this host (no valid page tag): every request waits for a moderator');
        }
      }
      if (!o.statusFile || !pageReady) return;
      const due = Date.now() - lastStatus >= o.statusEverySec * 1000;
      if (!(due || host.statusDirty()) || Date.now() - lastStatusTry < PIN_C2.statusMinGapMs) return;
      lastStatusTry = Date.now();
      let st = null;
      try {
        st = await host.writeStatus(o.statusFile);
      } catch (err) {
        warnOnce('heartbeat not written to ' + o.statusFile + ': ' + ((err && err.message) || err));
        return;
      }
      if (st) {
        lastStatus = Date.now();
        if (st.items.length !== lastCount) o.log('heartbeat: ' + st.items.length + ' item(s), hashed ids only -> ' + o.statusFile);
        lastCount = st.items.length;
      } else if (!waitingSaid && !(host.signer && host.signer.disabled)) {
        waitingSaid = true;
        o.log('heartbeat: waiting for the site\'s ledger id (the page has not opened its ledger yet)');
      }
    };
    // Notes left by --quarantine runs, the mailbox save, the page report and the heartbeat run every two seconds, not only at each status line.
    tickTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      pinTick().catch((err) => warnOnce('pin store: ' + ((err && err.message) || err))).finally(() => { busy = false; });
    }, 2000);
    if (tickTimer.unref) tickTimer.unref();
    o.log('pin stores on disk under ' + host.store.dir + (o.mailbox ? '; mailbox on' : '') + (o.files ? '; file pin on (requests wait for a moderator)' : '') +
      (o.autoAccept ? '; the owner key\'s requests are pinned at once' : '') + (host.signer ? '; pin key ' + host.signer.pub.slice(0, 18) + '...' : '') +
      (o.statusFile ? '; heartbeat every ' + o.statusEverySec + ' s to ' + o.statusFile : '') + (host.meter.cap !== null ? '; month cap ' + formatBytes(host.meter.cap) : ''));
  }
  // Ask the loaded page to keep the pinned files (window.__mwPinHost.start), or say once per page that it offers no pin host.
  // C2 integrator: the page offers its host only once it has read _mw.cfg.pin from the ledger and checked this bridge, which can
  // be seconds after the render; until it has, every status tick asks again (offered), so pinned files and approvals made in
  // between are started as soon as it does (before, they waited for the next reload).
  let offered = false;
  let toldNoHost = false;
  const resumePinned = async (page) => {
    if (!host.files) return;
    const offers = await page.evaluate(() => Boolean(window.__mwPinHost && typeof window.__mwPinHost.start === 'function')).catch(() => false);
    if (!offers) {
      if (host.files.pinned().length && !toldNoHost) {
        toldNoHost = true;
        o.log('the pinned page has no pin host (window.__mwPinHost) yet: ' + host.files.pinned().length + ' pinned file(s) stay on disk until it offers one');
      }
      return;
    }
    offered = true;
    if (!host.files.pinned().length) return;
    await host.resume().catch((err) => warn('pinned files: ' + ((err && err.message) || err)));
  };
  // rows-media D-1 (integrator): an approval made with --approve while this node runs is pinned on disk by that other process; the
  // page already offers its host, so resumePinned no longer runs. Each status tick starts the pinned files the page does not hold.
  const startMissing = async (page) => {
    if (!host.files || !host.files.pinned().length) return;
    const held = await page.evaluate(() => {
      try { return ((window.__mwPinHost.status() || {}).files || []).map((f) => f.ih); } catch (_) { return null; }
    }).catch(() => null);
    if (!Array.isArray(held)) return;
    if (host.files.pinned().some((m) => held.indexOf(m.ih) < 0)) await host.resume().catch((err) => warn('pinned files: ' + ((err && err.message) || err)));
  };
  // Wait for a running tick, so that nothing it writes lands after the heartbeat that says this node holds nothing.
  const idle = async () => {
    for (let i = 0; busy && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  };
  let restarts = 0;
  try {
    for (;;) {
      if (o.signal.aborted) return restarts;
      let session = null;
      try {
        mkdirSync(o.profileDir, { recursive: true });
        // Code review round 1: a loopback URL gets the local-only browser (docs/DEV-NETWORK.md); allowRemote: false only narrows it.
        session = await launchBrowser({ headless: o.headless, profileDir: o.profileDir, allowRemote: allowRemoteFor(o.url) && o.allowRemote !== false, ignoreHTTPSErrors: false });
        const page = session.context.pages()[0] || await session.context.newPage();
        currentPage = page;
        // C2 integrator: the test fixture reads the pinned page's read-only state (window.__mwShell.inspect()) through this hook.
        if (typeof o.onPage === 'function') { try { o.onPage(page); } catch (_) { /* a hook */ } }
        if (host) {
          host.pageChanged();
          await attachPinBridge(session.context, host, { page });
        }
        let dead = null;
        page.on('crash', () => { dead = 'the page crashed'; });
        session.context.on('close', () => { dead = dead || 'the browser closed'; });
        o.log('opening ' + o.url);
        await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        if (o.consent) {
          const clicked = await acceptConsent(page, { timeoutMs: 20000 });
          o.log(clicked ? 'consent given (this node shares the site and the ledger)' : 'WARNING: no consent card was found and no stored choice says "accepted": this node may not share (check the page)');
        }
        // The pinned node keeps seeding even when the frame never renders; the reload recovers the usual first-visit case.
        const rendered = await renderWithRecovery(page, { consent: o.consent, signal: o.signal, log: o.log });
        o.log('render: ' + (rendered.ok ? 'ok, ' : 'NOT ok, ') + rendered.detail);
        pageReady = true;
        offered = false;
        toldNoHost = false;
        if (host) await resumePinned(page);
        let broken = 0;
        let lastSnapshot = 0;
        while (!o.signal.aborted && !dead) {
          await sleep(o.intervalSec * 1000);
          if (o.signal.aborted || dead) break;
          if (host && !offered) await resumePinned(page);
          else if (host) await startMissing(page);
          const status = await readLoaderStatus(page).catch(() => null);
          if (status) status.banners = await readBanners(page).catch(() => []);
          o.log(statusLine(status, { restarts, extra: host ? pinStatsLine(host.stats()) : '' }));
          if (wantsReload(status)) {
            o.log('a newer pointer is published: reloading');
            if (host) host.pageChanged();
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            offered = false;
            toldNoHost = false;
            if (host) await resumePinned(page);
            broken = 0;
          } else if (isBroken(status)) {
            broken++;
            if (broken >= 3) throw new Error('the loader has been stuck for 3 status checks: ' + formatStatus(status));
          } else {
            broken = 0;
          }
          if (o.snapshotFile && Date.now() - lastSnapshot >= o.snapshotEverySec * 1000) {
            lastSnapshot = Date.now();
            await writeSnapshot(page, o.url, o.snapshotFile, o.plain, o.log).catch((err) => warn('snapshot failed: ' + ((err && err.message) || err)));
          }
        }
        if (dead && !o.signal.aborted) throw new Error(dead);
      } catch (err) {
        warn('session ended: ' + ((err && err.message) || err));
      } finally {
        pageReady = false;
        currentPage = null;
        await idle();
        if (session) await session.close().catch(() => {});
        if (host) await host.tick().catch(() => {});
        // The browser is gone: say at once that this node holds nothing, rather than letting the last heartbeat speak for 15 minutes.
        if (host && o.statusFile) await host.writeStatus(o.statusFile, { empty: true }).catch(() => {});
      }
      if (o.signal.aborted) return restarts;
      if (restarts >= o.maxRestarts) {
        warn('giving up after ' + restarts + ' restart(s)');
        return restarts;
      }
      const wait = backoffMs(restarts);
      restarts++;
      o.log('restarting in ' + Math.round(wait / 1000) + ' s (restart ' + restarts + ')');
      await sleep(wait);
    }
  } finally {
    if (tickTimer) clearInterval(tickTimer);
    await idle();
    if (host && host.mailbox) host.mailbox.save();
    if (host) host.meter.save(true);
  }
}

// ---------------------------------------------------------------------------------------------
// the command line
// ---------------------------------------------------------------------------------------------

const shortKey = (k) => String(k).slice(0, 14) + '...';

function printQueue(files) {
  const list = files.queue();
  if (!list.length) {
    out('no file waits for a moderator');
    return;
  }
  out('Waiting for a moderator (name, size, author key, declared hash; nothing else is known, nothing is opened):');
  for (const e of list) {
    out('  ' + e.ih + '  ' + formatBytes(e.size).padStart(9) + '  ' + shortKey(e.author) + '  ' + (e.sha256 ? 'sha256 ' + e.sha256.slice(0, 16) + '...' : 'no declared hash') + '  ' + JSON.stringify(e.name || '(unnamed)'));
  }
  out('Pin one with --approve <infohash>, refuse it with --decline <infohash>.');
}

function printPinned(files) {
  const list = files.pinned();
  if (!list.length) out('no file is pinned');
  for (const m of list) out('  ' + m.ih + '  ' + m.state.padEnd(8) + formatBytes(m.size).padStart(9) + '  ' + shortKey(m.author) + '  ' + JSON.stringify(m.name || '(unnamed)'));
}

function printQuarantined(files) {
  const list = files.quarantined();
  if (!list.length) out('nothing is quarantined');
  for (const m of list) out('  ' + m.ih + '  ' + new Date(m.quarantinedAt).toISOString() + '  ' + (m.reason ? JSON.stringify(m.reason) : '(no reason given)') + '  ' + (m.stopped ? 'seeding stopped' : 'stop requested'));
}

/** runModeration(flags) → exit code: the offline commands (--queue, --pinned, --quarantined, --approve, --decline, --quarantine) on a profile's pin stores. */
export async function runModeration(flags, { log = out } = {}) {
  if (!flags.profile) throw new UsageError('this command works on a profile directory: add --profile <dir>');
  const host = createPinHost(Object.assign({ profileDir: flags.profile, files: true }, { limits: pinCapacity(flags).limits }));
  const files = host.files;
  const by = flags.by || 'operator';
  if (flags.queue) printQueue(files);
  if (flags.pinned) printPinned(files);
  if (flags.quarantined) printQuarantined(files);
  if (flags.approve) {
    const r = await files.decide(flags.approve, 'accept', { by });
    if (r.quarantined) log('quarantined ' + r.meta.ih + " -> " + r.to + ": the site's ledger denies it (_deny/); it was not pinned.");
    else log('pinned ' + r.meta.ih + ' (' + formatBytes(r.meta.size) + ', ' + JSON.stringify(r.meta.name || '(unnamed)') + '): the running pin node fetches and keeps it; it was not opened.');
  }
  if (flags.decline) {
    await files.decide(flags.decline, 'decline', { by });
    log('declined ' + flags.decline + ' (it is not asked again for ' + PIN_LIMITS.declineDays + ' days)');
  }
  if (flags.quarantine) {
    const r = await files.quarantine(flags.quarantine, { reason: flags.reason, by });
    log('quarantined ' + r.ih + ' -> ' + r.to + (r.stopped ? ' (seeding stopped)' : ' (a stop note is left for the running node, which stops seeding within seconds, or at its next start)'));
    log('logged in ' + host.store.path('log.jsonl'));
  }
  return 0;
}

/** The flags of the command line (parseCli spec). */
export const PIN_FLAGS = Object.freeze({
  headless: { type: 'boolean' },
  profile: { type: 'string' },
  interval: { type: 'int', default: 60 },
  'no-consent': { type: 'boolean' },
  snapshot: { type: 'string' },
  'snapshot-every': { type: 'int', default: 600 },
  plain: { type: 'boolean' },
  'max-restarts': { type: 'int' },
  quiet: { type: 'boolean' },
  mailbox: { type: 'boolean' },
  files: { type: 'boolean' },
  queue: { type: 'boolean' },
  pinned: { type: 'boolean' },
  quarantined: { type: 'boolean' },
  approve: { type: 'string' },
  decline: { type: 'string' },
  quarantine: { type: 'string' },
  reason: { type: 'string' },
  by: { type: 'string' },
  // v0.3 C2
  'pin-key': { type: 'string' },
  status: { type: 'string' },
  'status-every': { type: 'int', default: PIN_C2.statusEveryDefaultSec },
  'auto-accept': { type: 'string' },
  'month-cap': { type: 'string' },
  // review round R 5.3 (SCALE-9, SCALE-15; integrator)
  'max-total': { type: 'string' },
  'mailbox-bytes': { type: 'string' },
  'mailbox-source-fraction': { type: 'int' },
});

/** pinCapacity(flags) -> { limits, quotas } from --max-total, --mailbox-bytes and --mailbox-source-fraction (UsageError when bad). */
export function pinCapacity(flags) {
  const limits = {};
  const quotas = {};
  if (flags.maxTotal !== null && flags.maxTotal !== undefined) {
    const n = parseByteSize(flags.maxTotal);
    if (n === null || n < 1) throw new UsageError('--max-total is a size in bytes, or with a unit (20GiB): got ' + JSON.stringify(flags.maxTotal));
    limits.maxTotalBytes = n;
  }
  if (flags.mailboxBytes !== null && flags.mailboxBytes !== undefined) {
    const n = parseByteSize(flags.mailboxBytes);
    if (n === null || n < 1) throw new UsageError('--mailbox-bytes is a size in bytes, or with a unit (500MiB): got ' + JSON.stringify(flags.mailboxBytes));
    quotas.bytes = n;
  }
  if (flags.mailboxSourceFraction !== null && flags.mailboxSourceFraction !== undefined) {
    if (!(Number.isSafeInteger(flags.mailboxSourceFraction) && flags.mailboxSourceFraction >= 1)) throw new UsageError('--mailbox-source-fraction is a whole number of at least 1');
    quotas.sourceFraction = flags.mailboxSourceFraction;
  }
  return { limits, quotas };
}

/**
 * parsePinArgs(argv) → { mode: 'help' } | { mode: 'moderation', flags } | { mode: 'key', pinKeyFile }
 *   | { mode: 'run', url, profileDir, pinKeyFile, options } (options are runPin's, without pinKey, log and signal)
 * UsageError (exit 2) for a bad command line. Reads no file and starts nothing.
 */
export function parsePinArgs(argv) {
  const { flags, positionals } = parseCli(argv, PIN_FLAGS);
  if (flags.help) return { mode: 'help', flags };
  const moderation = flags.queue || flags.pinned || flags.quarantined || flags.approve || flags.decline || flags.quarantine;
  if (moderation) {
    if (positionals.length) throw new UsageError('the moderation commands take no URL');
    return { mode: 'moderation', flags };
  }
  if (flags.pinKey !== null && !flags.pinKey) throw new UsageError('--pin-key needs the key file');
  if (!positionals.length && flags.pinKey) return { mode: 'key', pinKeyFile: flags.pinKey, flags };
  if (positionals.length !== 1) throw new UsageError('expected one URL');
  let parsedUrl;
  try {
    parsedUrl = new URL(positionals[0]);
  } catch (_) {
    throw new UsageError('not a URL: ' + positionals[0]);
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new UsageError('the URL must be http(s)');
  if (flags.interval < 1) throw new UsageError('--interval must be at least 1 second');
  if (flags.status !== null && !flags.status) throw new UsageError('--status needs a file');
  if (flags.status && !flags.pinKey) throw new UsageError('--status writes a signed heartbeat: add --pin-key <jwk file>');
  if (flags.statusEvery < 1 || flags.statusEvery > PIN_C2.statusEveryMaxSec) {
    throw new UsageError('--status-every must be 1 to ' + PIN_C2.statusEveryMaxSec + ' seconds (visitors ignore a heartbeat older than 15 minutes)');
  }
  if (flags.autoAccept !== null && flags.autoAccept !== 'owner') throw new UsageError('--auto-accept takes one rule: owner');
  if (flags.autoAccept && !flags.files) throw new UsageError('--auto-accept owner works on file pin requests: add --files');
  let monthCap = null;
  if (flags.monthCap !== null) {
    monthCap = parseByteSize(flags.monthCap);
    if (monthCap === null) throw new UsageError('--month-cap is a size in bytes, or with a unit (500GiB, 2TB): got ' + JSON.stringify(flags.monthCap));
  }
  const profileDir = flags.profile || join(ROOT, '.tools', 'pin', parsedUrl.host.replace(/[^A-Za-z0-9.-]/g, '_'));
  return {
    mode: 'run',
    url: parsedUrl.href,
    origin: parsedUrl.origin,
    profileDir,
    pinKeyFile: flags.pinKey || null,
    flags,
    options: {
      url: parsedUrl.href, headless: flags.headless, profileDir, intervalSec: flags.interval, consent: !flags.noConsent,
      snapshotFile: flags.snapshot, snapshotEverySec: flags.snapshotEvery, plain: flags.plain, mailbox: flags.mailbox, files: flags.files,
      maxRestarts: flags.maxRestarts === null || flags.maxRestarts === undefined ? Infinity : flags.maxRestarts,
      statusFile: flags.status ? resolve(flags.status) : null, statusEverySec: flags.statusEvery, autoAccept: flags.autoAccept || null, monthCap,
      ...pinCapacity(flags),
    },
  };
}

async function main(argv) {
  const parsed = parsePinArgs(argv);
  if (parsed.mode === 'help') {
    out(USAGE.trim());
    return 0;
  }
  if (parsed.mode === 'moderation') return runModeration(parsed.flags);
  const pinKey = parsed.pinKeyFile ? await loadPinKey(parsed.pinKeyFile) : null;
  if (pinKey) for (const line of pinKeyLines(pinKey)) out(line);
  if (parsed.mode === 'key') return 0;
  const { flags, options } = parsed;
  out('pin ' + parsed.url + (flags.headless ? ' (headless)' : ' (a browser window opens)'));
  out('Will contact: ' + parsed.origin + ', then the trackers, peers, web seed and DNS-over-HTTPS servers its pointer names. Those see this machine\'s IP address,');
  out('and visitors receive the site\'s files and ledger from this browser. Profile: ' + parsed.profileDir + '. Status every ' + flags.interval + ' s. Ctrl-C to stop.');
  if (flags.mailbox) out('Mailbox: holds the envelopes senders flag for holding (7 days, 64 per tag, 4 MiB); it sees IP addresses, tags, sizes and times of the people who use it (R 2.16). Say so on your site.');
  if (flags.files) out('File pin: requests wait for a moderator (--queue, --approve); the node counts and hashes bytes and never opens a file. Quarantine with --quarantine <infohash>.');
  if (options.autoAccept) out('Auto-accept: requests whose author is the site\'s owner key are pinned at once and logged (owner decision SZ-6); every other request waits for a moderator. Files are still never opened.');
  if (options.statusFile) out('Heartbeat: signed, every ' + options.statusEverySec + ' s, to ' + options.statusFile + ' (mode 644). Publish it at <ws base>/' + STATUS_FILE + '. It lists hashed ids, never an infohash.');
  if (options.monthCap !== null) out('Month cap: pinned files stop seeding after ' + formatBytes(options.monthCap) + ' uploaded in a UTC calendar month and start again the next month; the site torrent always seeds.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runPin(Object.assign({}, options, { pinKey, log: flags.quiet ? () => {} : out, signal: controller.signal }));
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
