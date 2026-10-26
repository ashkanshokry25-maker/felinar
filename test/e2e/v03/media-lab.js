// test/e2e/v03/media-lab.js: the engine-page stand-in of the private media and file e2e scenarios
// (E-MD-*, E-FI-3*, the media part of E-CH-6; test/e2e/scenarios-v03.mjs). It runs on the e2e stack
// origin under the product Service Worker (/mw-sw.js from the run's own build), served from /ws/e2e-lab/
// (the dev server's web-seed path, which the worker passes through), with the unbundled src/ modules.
//
// What is real: createMediaService (the SVC contract the SDK lane mounts), MediaLane, the upload pipeline
// (sniff, stripMp4, faststart, the poster from an off-screen <video>, chunk encryption and padding), the
// IndexedDB chunk store, the sealed own-index item (src/identity/sealed.js), MediaSessions and the worker's
// /_mw/media/<sid> and /_mw/f/<sid> routes. Stand-ins (wave 1: lanes idp, chain-net and sdk not landed):
// the signed-in keys (a fresh P-256 key and a random K_own), the ledger node (it records appends), the
// loader's cards (every prompt says yes and is counted) and no swarm (torrents: null).
import { createMediaService } from './src/media/service.js';
import { MediaSessions } from './src/media/session.js';
import { importChunkKey, decryptChunk, regionOf, partInfo } from './src/media/format.js';
import { readTopBoxes } from './src/media/faststart.js';
import { idbBackend } from './src/files/store-idb.js';
import * as sealed from './src/identity/sealed.js';
import { b64url, hex } from './src/chain/canonical.js';

const LEDGER = 'mw1:E2eMediaLabLedger000000000';
const lab = { services: {}, appended: [], tombstoned: [], prompts: [], chunkReads: [], swMessages: [], errors: [] };
const sw = navigator.serviceWorker;

lab.swPort = {
  ready: () => Boolean(sw && sw.controller),
  post: (msg, transfer) => sw.controller.postMessage(msg, transfer || []),
  onMessage: (fn) => sw.addEventListener('message', (e) => {
    lab.swMessages.push(e.data && e.data.type);
    fn(e.data);
  }),
};

let identity = null;
async function keys() {
  if (identity) return identity;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  identity = { pub: 'p256:' + b64url.encode(raw), own: crypto.getRandomValues(new Uint8Array(32)) };
  return identity;
}

const node = {
  role: 'member',
  async append(list, value) {
    const h = hex.encode(crypto.getRandomValues(new Uint8Array(32)));
    lab.appended.push({ list, value, h });
    return { h };
  },
  async tombstone(h) {
    lab.tombstoned.push(h);
    return { h };
  },
};

// The media lane calls open(value, opts); src/identity/sealed.js takes open({ value, ...opts }) (integration I-4).
const sealedAdapter = { seal: (o) => sealed.seal(o), open: (value, o) => sealed.open(Object.assign({ value }, o)), sealTo: null };

/** makeService(name, { worker, cfg, hostOnly, signedIn, capBytes }) -> true */
lab.makeService = async (name, { worker = true, cfg = { media: 'members' }, hostOnly = false, signedIn = true, capBytes } = {}) => {
  const id = await keys();
  const sessions = worker ? undefined : new MediaSessions({ sw: null, capBytes: Number.isSafeInteger(capBytes) ? capBytes : undefined });
  const svc = createMediaService({
    keys: () => (signedIn ? id : null),
    ledgerId: LEDGER,
    node,
    cfg: () => cfg,
    deviceClass: 'desktop',
    hostOnly: () => hostOnly,
    ownTracker: 'ws://127.0.0.1:9/announce', // never contacted: torrents is null, so nothing is seeded in this lab
    torrents: null,
    chat: null,
    sealed: sealedAdapter,
    isDenied: async () => false,
    prompt: async (p) => {
      lab.prompts.push((p && p.kind) || String(p));
      return true;
    },
    swPort: worker ? lab.swPort : null,
    sessions,
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  });
  const lane = svc.lane;
  const orig = lane._chunk.bind(lane);
  lane._chunk = (rec, i) => {
    lab.chunkReads.push({ id: rec.id, i, t: performance.now() });
    return orig(rec, i);
  };
  lab.services[name] = svc;
  return true;
};

async function fileFrom(url, name, type) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('fixture ' + url + ': HTTP ' + res.status);
  return new File([await res.blob()], name, { type });
}

/** upload(name, url, fileName, type, ctx) -> the result, or { error: code } */
lab.upload = async (name, url, fileName, type = 'video/mp4', ctx = { activation: true }) => {
  const file = await fileFrom(url, fileName, type);
  try {
    return await lab.services[name].methods['media.upload']({ file }, ctx);
  } catch (err) {
    return { error: (err && err.code) || String(err), message: err && err.message };
  }
};

lab.call = async (name, method, params, ctx = {}) => {
  try {
    return await lab.services[name].methods[method](params, ctx);
  } catch (err) {
    return { error: (err && err.code) || String(err), message: err && err.message };
  }
};

/** item(name, id) -> what the lane keeps (inspection only: never exposed to a site) */
lab.item = (name, id) => {
  const rec = lab.services[name].lane.items.get(id);
  if (!rec) return null;
  return { M: rec.M, storeName: rec.storeName, P: rec.M.P, total: rec.M.total };
};

/** chunks(name, id) -> what the IndexedDB chunk store holds for the item (the bytes a peer would get). */
lab.chunks = async (name, id) => {
  const rec = lab.services[name].lane.items.get(id);
  const backend = idbBackend();
  const stored = await backend.keys(rec.storeName);
  let bytes = 0;
  let ftyp = 0;
  let sizes = new Set();
  let firstPlainFtyp = 0;
  for (const i of stored) {
    const c = await backend.get(rec.storeName, i);
    bytes += c.length;
    sizes.add(c.length);
    for (let o = 0; o + 8 <= Math.min(c.length, 64); o++) {
      if (c[o + 4] === 0x66 && c[o + 5] === 0x74 && c[o + 6] === 0x79 && c[o + 7] === 0x70) { ftyp++; break; }
    }
  }
  // The plaintext of the first media chunk does start with an ftyp box (so the check above is meaningful).
  const head = await lab.mediaHead(name, id);
  if (head.boxes[0] === 'ftyp') firstPlainFtyp = 1;
  return { stored: stored.length, bytes, sizes: Array.from(sizes), ftypAtChunkStart: ftyp, firstPlainFtyp, total: rec.M.total, P: rec.M.P };
};

/** mediaHead(name, id) -> the top-level MP4 boxes of the decrypted media (the first chunk and the whole). */
lab.mediaHead = async (name, id) => {
  const rec = lab.services[name].lane.items.get(id);
  const M = rec.M;
  const key = await importChunkKey(rec.fk);
  const fid = b64url.decode(M.fid);
  const base = b64url.decode(M.base);
  const info = partInfo(M, 'media');
  const parts = [];
  for (let i = info.first; i < info.end; i++) {
    parts.push(await decryptChunk(key, base, fid, i, M.total, regionOf(M, i), await rec.store.getAsync(i)));
  }
  const blob = new Blob(parts).slice(0, info.size);
  const boxes = (await readTopBoxes(blob)).map((b) => b.type);
  return { boxes, len: info.size };
};

/** ownItem(name, id) -> the own-index item appended to mw.s, opened with K_own (as restore() does). */
lab.ownItem = async () => {
  const id = await keys();
  const it = lab.appended.filter((a) => a.list === 'mw.s').slice(-1)[0];
  if (!it) return null;
  const opened = await sealed.open({ value: it.value, ledgerId: LEDGER, authorPub: id.pub, key: id.own });
  const payload = opened ? JSON.parse(new TextDecoder().decode(opened.data)) : null;
  return { value: it.value, kind: opened && opened.kind, hasM: Boolean(payload && payload.M), plen: payload && payload.M.plen, pmime: payload && payload.M.pmime, ctBytes: b64url.decode(it.value.ct).length, ledgerId: LEDGER, author: id.pub };
};

/**
 * play(url, { preload }) -> { readyState, duration, ... } once the first frame is there. preload 'metadata' (the
 * default here) keeps the browser from buffering the whole item ahead, so a later seek far away needs a new
 * Range request through the worker (a local worker answers fast enough to buffer 20 MiB in well under a second).
 */
lab.video = null;
lab.play = async (url, { timeoutMs = 30000, preload = 'metadata' } = {}) => {
  if (lab.video) { lab.video.pause(); lab.video.removeAttribute('src'); lab.video.load(); lab.video.remove(); }
  const v = document.createElement('video');
  v.muted = true;
  v.preload = preload;
  v.playsInline = true;
  document.body.appendChild(v);
  lab.video = v;
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no first frame in ' + timeoutMs + ' ms (readyState ' + v.readyState + ', error ' + (v.error && v.error.code) + ')')), timeoutMs);
    v.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video error ' + (v.error && v.error.code) + ' ' + (v.error && v.error.message))); }, { once: true });
    v.src = url;
  });
  return { readyState: v.readyState, duration: v.duration, firstFrameMs: Math.round(performance.now() - t0), w: v.videoWidth, h: v.videoHeight };
};

/** seek(t) -> { readyState, currentTime, ms } after 'seeked' */
lab.seek = async (t, { timeoutMs = 30000 } = {}) => {
  const v = lab.video;
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('seek to ' + t + ' not done in ' + timeoutMs + ' ms (readyState ' + v.readyState + ')')), timeoutMs);
    v.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    v.currentTime = t;
  });
  // HAVE_CURRENT_DATA (2) or better at the new position
  const end = performance.now() + timeoutMs;
  while (v.readyState < 2 && performance.now() < end) await new Promise((r) => setTimeout(r, 50));
  return { readyState: v.readyState, currentTime: v.currentTime, ms: Math.round(performance.now() - t0) };
};

/** fileSession(name, fileName, text, { worker }) -> { url, mode } through MediaSessions.openFile (files.save uses it) */
lab.fileSession = async (fileName, text, { worker = true } = {}) => {
  const bytes = new TextEncoder().encode(text);
  const sessions = new MediaSessions({ sw: worker ? lab.swPort : null });
  lab.fileSessions = (lab.fileSessions || []).concat(sessions);
  const block = 65536;
  return sessions.openFile('lab-' + fileName, { name: fileName, size: bytes.length, block, readBlock: async (i) => bytes.slice(i * block, (i + 1) * block) });
};

/** head(url) -> status, headers and body text of a GET */
lab.get = async (url, headers = {}) => {
  const r = await fetch(url, { cache: 'no-store', headers });
  const h = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  let text = null;
  try { text = await r.text(); } catch (_) { text = null; }
  return { status: r.status, headers: h, text, type: r.type };
};

lab.blobType = async (url) => (await (await fetch(url)).blob()).type;

/** timings(url) -> the Resource Timing entries of a URL (status where the browser reports responseStatus). */
lab.timings = (url) => performance.getEntriesByType('resource')
  .filter((e) => e.name.endsWith(url))
  .map((e) => ({ status: typeof e.responseStatus === 'number' ? e.responseStatus : null, start: Math.round(e.startTime), type: e.initiatorType }));

lab.ready = true;
window.mwMediaLab = lab;
