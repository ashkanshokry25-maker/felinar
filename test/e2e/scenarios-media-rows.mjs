// test/e2e/scenarios-media-rows.mjs: the open end-to-end rows of the files and private media area (V03-DESIGN-REVIEW
// Part 4.2; docs/deviations/integration-v03.md, "The test plan's end-to-end rows"), through the real loader, SDK, identity
// origin, files and media lanes and the pin node. Written by the files and media rows lane (docs/deviations/rows-media.md).
//
//   E-FI-5   metadata stripping in the browser: a JPEG with an Exif GPS segment (and an ICC segment) and an MP4 with
//            moov/udta { ©xyz, loci } and a QuickTime location key are shared publicly; another member fetches them and
//            the bytes it gets hold no Exif, no ICC, no GPS IFD, no ©xyz, no loci and no location text
//   E-FI-6   file validation: refused sizes (a public file over 25 MiB, private media over the desktop cap: E_LIMIT) and
//            types (HTML bytes named .mp4: E_MEDIA_TYPE) before any card; a JPEG/HTML polyglot comes out of the
//            public upload as a JPEG without the HTML; a listing whose len lies is aborted (E_FILE_HASH) and hidden, and a
//            listing whose sha256 lies is dropped after the download and hidden
//   E-MD-3B  the remainder of E-MD-3: a third member fetches the private item's ciphertext by infohash from the swarm
//            (a WebTorrent page in its own browser context); the pieces match the piece table, carry no plaintext, the
//            recipient's key opens them, and no key held in the third member's context does
//   E-MD-5R  the reencrypt half of E-MD-5: revoke with { reencrypt: true }; the remaining recipient gets the new item
//            and plays it; the uploader's old chunks are gone; the revoked recipient's old key (read from its own page's
//            memory, as a recipient who kept it would) opens no chunk of the new ciphertext, while the new key opens all
//   E-MD-6   a pin-node fixture (test/e2e/pin-fixture.mjs: `node tools/pin.mjs` as a child process on loopback with a
//            temporary profile; the moderator's --queue and --approve as their own processes): the private item is
//            approved and fetched by the pin; the uploader goes offline; a fresh context accepts the grant and plays it,
//            with a seek, from the pin; with no holder (the pin node stopped), a fourth member's accept ends in
//            'unavailable', the grant is kept, and it plays once the pin node runs again on the same profile
//
// E-FI-4 (a 25 MiB phone-class file through the chunk store with bounded memory) is not here: the harness cannot measure
// the bound (docs/deviations/rows-media.md says why); it stays with the real-device row G-MD-5.
//
// Network policy (docs/DEV-NETWORK.md): Chromium with the local-only flags; every page is on http://127.0.0.1 (the
// site's dev server, the identity origin, and a small server of this file for the WebTorrent helper pages); the pin
// node's own Chromium gets the local-only flags from tools/live.mjs for a loopback URL (checked by its fixture).

import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';

import { waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, clickLoaderCard, dismissKitCard, Visitor, ROOT } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { setCfg, readBlocksFile, writeBlocksFile, acceptListing, appendControl } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadPinKey } from '../../tools/pin.mjs';
import { startPinProcess } from './pin-fixture.mjs';
import { UI_TEXT } from '../../src/loader/strings.js';
import { jpegSegments, jpegHasExif } from '../../src/media/strip.js';
import { decryptChunk, regionOf, idOf } from '../../src/media/format.js';
import { b64url } from '../../src/chain/canonical.js';
import { makeFixtures, hasFfmpeg, LOCATION } from '../fixtures/media/make-fixtures.mjs';

export const MEDIA_ROWS_ORDER = ['E-FI-5', 'E-FI-6', 'E-MD-3B', 'E-MD-5R', 'E-MD-6'];

const T = UI_TEXT.en;
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// byte helpers (Node)
// ---------------------------------------------------------------------------------------------

const has = (buf, needle) => Buffer.from(buf).indexOf(typeof needle === 'string' ? Buffer.from(needle, 'latin1') : Buffer.from(needle)) >= 0;
const sha1hex = (u8) => createHash('sha1').update(u8).digest('hex');
const sha256hex = (u8) => createHash('sha256').update(u8).digest('hex');
const XYZ = [0xa9, 0x78, 0x79, 0x7a];

/** The location and camera markers of the fixtures (test/fixtures/media/make-fixtures.mjs). */
function jpegMarkers(u8) {
  const segs = jpegSegments(new Uint8Array(u8));
  // The GPS IFD: the GPSInfo tag (0x8825, big-endian in the fixture's TIFF) inside an APP1 Exif segment.
  const gpsTag = segs.some((s) => s.name === 'APP1' && has(Buffer.from(u8).subarray(s.start, s.start + 2 + s.length), [0x88, 0x25]));
  return {
    exif: jpegHasExif(new Uint8Array(u8)),
    app1: segs.filter((s) => s.name === 'APP1').length,
    // the camera's profile (its marker text); the canvas encoder may write a plain sRGB ICC_PROFILE segment of its own
    icc: has(u8, 'MagnetCamProfile'),
    encoderIcc: segs.some((s) => s.name === 'APP2' && /ICC/.test(String(s.ident))),
    make: has(u8, 'MagnetCam'),
    gps: gpsTag,
    soi: u8[0] === 0xff && u8[1] === 0xd8,
  };
}

function mp4Markers(u8) {
  return {
    xyz: has(u8, XYZ),
    loci: has(u8, 'loci'),
    qtLocation: has(u8, 'com.apple.quicktime.location'),
    text: has(u8, LOCATION.slice(0, 8)),
    ftyp: has(u8, 'ftyp'),
    moov: has(u8, 'moov'),
  };
}

/** Tries fk (with M's fid, base and regions) on every chunk: { opened, failed }. */
async function tryKey(fk, M, chunks) {
  const fid = b64url.decode(M.fid);
  const base = b64url.decode(M.base);
  let opened = 0;
  let failed = 0;
  for (const [i, ct] of chunks) {
    try {
      await decryptChunk(fk, base, fid, i, M.total, regionOf(M, i), ct);
      opened++;
    } catch (_) {
      failed++;
    }
  }
  return { opened, failed };
}

// ---------------------------------------------------------------------------------------------
// browser-side helpers
// ---------------------------------------------------------------------------------------------

/**
 * heapKeys(page) -> [{ id, from, state, ih, fk (base64), M }]: every media or file record in the top frame's Maps that
 * holds a 32-byte key (Chromium DevTools protocol: Runtime.queryObjects of Map.prototype). This is what a person who
 * keeps a key they once had can read in their own browser; the test uses it to model a recipient who kept a key after
 * a revoke, and to show which keys a context holds.
 */
async function heapKeys(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Runtime.enable');
    const proto = await cdp.send('Runtime.evaluate', { expression: 'Map.prototype' });
    const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId: q.objects.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const out = [];
        const seen = new Set();
        const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
        for (const map of this) {
          try {
            for (const v of map.values()) {
              if (!v || typeof v !== 'object' || seen.has(v)) continue;
              const fk = v.fk;
              if (!(fk instanceof Uint8Array) || fk.length !== 32) continue;
              seen.add(v);
              const M = v.M && typeof v.M === 'object' ? JSON.parse(JSON.stringify(v.M)) : null;
              out.push({ id: v.id || v.ref || null, from: v.from || null, state: v.state || null, ih: (M && M.ih) || v.ih || null, fk: b64(fk), M });
            }
          } catch (_) { /* a Map whose values cannot be read */ }
        }
        return out;
      }`,
    });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: '' }).catch(() => {});
    return (r.result && r.result.value) || [];
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const fkOf = (rec) => new Uint8Array(Buffer.from(rec.fk, 'base64'));

/** idbChunks(page, name) -> [[index, Uint8Array]] of the loader's IndexedDB chunk store `name` (mw-files / chunks). */
async function idbChunks(page, name) {
  const got = await page.evaluate((n) => new Promise((resolve, reject) => {
    const r = indexedDB.open('mw-files');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('chunks')) { db.close(); resolve([]); return; }
      const out = [];
      const tx = db.transaction('chunks', 'readonly');
      const c = tx.objectStore('chunks').openCursor(IDBKeyRange.bound([n, 0], [n, Number.MAX_SAFE_INTEGER]));
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        const u8 = new Uint8Array(cur.value.buffer ? cur.value.buffer : cur.value, cur.value.byteOffset || 0, cur.value.byteLength);
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        out.push([cur.key[1], btoa(s)]);
        cur.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), name);
  return got.map(([i, b]) => [i, new Uint8Array(Buffer.from(b, 'base64'))]);
}

// The WebTorrent helper pages, served by a loopback server of this file with the run's vendored bundle.
const HELPER_HEAD = `<!doctype html><meta charset="utf-8"><title>helper</title>
<script type="module">
import WebTorrent from '/_mw/webtorrent.min.js';
const q = new URLSearchParams(location.search);
const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } }, dht: false, lsd: false, utPex: false, webSeeds: false });
const H = window.__h = { errors: [], wires: 0 };
client.on('error', (e) => H.errors.push(String((e && e.message) || e)));
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const hexOf = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
`;

/** fetch.html?ih&tr: joins a swarm by infohash only, downloads every piece, exposes them (a stranger with the infohash). */
const FETCH_PAGE = HELPER_HEAD + `
const t = client.add('magnet:?xt=urn:btih:' + q.get('ih'), { announce: [q.get('tr')], private: true });
t.on('wire', () => { H.wires++; });
t.on('metadata', () => {
  H.meta = { length: t.length, pieceLength: t.pieceLength, pieces: t.pieces.length, private: !!(t.info && t.info.private),
    nonce: !!(t.info && t.info['x-mw-nonce'] && t.info['x-mw-nonce'].length === 16), hashes: t.info && t.info.pieces ? hexOf(t.info.pieces) : null };
});
t.on('done', async () => {
  try {
    const all = new Uint8Array(await t.files[0].arrayBuffer());
    const out = [];
    for (let i = 0; i * t.pieceLength < all.length; i++) out.push(b64(all.subarray(i * t.pieceLength, (i + 1) * t.pieceLength)));
    H.pieces = out;
    H.done = true;
  } catch (e) { H.errors.push('read: ' + ((e && e.message) || e)); }
});
</script>`;

/** seed.html?len&name&pl&tr: seeds random bytes as a public file torrent (no listing); exposes ih and sha256. */
const SEED_PAGE = HELPER_HEAD + `
const len = Number(q.get('len'));
const bytes = new Uint8Array(len);
for (let i = 0; i < len; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(len, i + 65536)));
const digest = hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
client.seed(new File([bytes], q.get('name'), { type: 'application/octet-stream' }), { announce: [q.get('tr')], pieceLength: Number(q.get('pl')), name: q.get('name') }, (t) => {
  t.on('wire', () => { H.wires++; });
  H.seed = { ih: t.infoHash, len, sha256: digest };
});
</script>`;

async function helperServer(dist) {
  const bundle = readFileSync(join(dist, '_mw', 'webtorrent.min.js'));
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    const page = p === '/fetch.html' ? FETCH_PAGE : p === '/seed.html' ? SEED_PAGE : null;
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page);
    }
    if (p === '/_mw/webtorrent.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(bundle);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) };
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

/** mediaRowsScenarios({ assert, run }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function mediaRowsScenarios({ assert, run }) {
  const S = {};

  // ------------------------------------------------------------------------------------------- the site
  // A guestbook of its own (chain e2e-media-rows) with chat, files and media for members, its own tracker, and _mw.cfg.pin
  // naming a pin key made here (the pin node itself starts only in E-MD-6).
  async function site(ctx, step) {
    if (ctx.shared.mr) return ctx.shared.mr;
    const { stack } = ctx;
    const m = await step('a guestbook for members (chain e2e-media-rows): chat, files and media on, _mw.cfg.pin named, its own tracker', async () => {
      const outDir = join(stack.runDir, 'media-rows');
      mkdirSync(outDir, { recursive: true });
      const pinKeyFile = join(stack.runDir, 'media-rows-pin.jwk');
      await keygen({ out: pinKeyFile });
      const pinKey = await loadPinKey(pinKeyFile);
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'media-rows', scope: '127.0.0.1', chain: 'e2e-media-rows', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
        tracker: [stack.tracker.url], stun: ['stun:127.0.0.1:3478'], chat: true, files: true, media: true,
      });
      const identity = await loadOwnerKey(stack.owner.file);
      const cfg = await setCfg({ blocks: readBlocksFile(join(outDir, 'genesis.json')), identity, set: { chat: 'members', files: 'members', media: 'members', pin: pinKey.pub } });
      writeBlocksFile(join(outDir, 'genesis.json'), cfg.blocks);
      dev.setPointer(pub.pointer);
      const fxDir = join(outDir, 'fx');
      assert(hasFfmpeg(), 'ffmpeg is not on PATH (needed for the media fixtures)');
      const made = await makeFixtures(fxDir, { only: ['gpsJpeg', 'udtaLocation', 'moovAtEnd'] });
      const fx = {};
      for (const [k, p] of Object.entries(made)) fx[k] = { file: p, path: '/ws/fx/' + p.split('/').pop() };
      const helper = await helperServer(stack.dist);
      ctx.closers.push(() => helper.close());
      return { dev, pub, outDir, url: dev.url, ledgerId: pub.ledgerId, pinKeyFile, pinKey, fx, helper, identity, carriers: 0 };
    });
    ctx.shared.mr = m;
    return m;
  }

  const sdk = (page, fn, arg) => siteFrame(page).evaluate(fn, arg);

  /** Runs fn in the site frame (an evaluate: a user gesture) and presses the loader cards named by labels, in order. */
  async function withCards(page, fn, arg, labels, { timeoutMs = 45000 } = {}) {
    const f = siteFrame(page);
    const running = f.evaluate(fn, arg).then((v) => ({ v }), (e) => ({ e: (e && e.message) || String(e) }));
    let settled = null;
    running.then((r) => { settled = r; });
    for (const label of labels) {
      await waitUntil(async () => {
        if (settled) return true;
        const r = await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
        if (r && r.width > 0) return r;
        await dismissKitCard(page);
        return null;
      }, { timeoutMs, label: 'the loader card "' + label + '"' });
      if (settled) break;
      await waitUntil(async () => {
        if (settled) return true;
        await clickLoaderCard(page, label);
        await sleep(300);
        return !(await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null));
      }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
    }
    const r = await withTimeout(running, timeoutMs, 'the call');
    if (r.e) throw new StepError(r.e);
    return r.v;
  }

  const cardOpen = (page, label) => page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);

  async function answerCard(page, label, { timeoutMs = 30000 } = {}) {
    await waitUntil(async () => {
      const r = await cardOpen(page, label);
      if (r && r.width > 0) return r;
      await dismissKitCard(page);
      return null;
    }, { timeoutMs, label: 'the loader card "' + label + '"' });
    await waitUntil(async () => {
      await clickLoaderCard(page, label);
      await sleep(300);
      return !(await cardOpen(page, label));
    }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
  }

  /** A signed-in member (this visit only); chat on through the loader's card unless chat: false. */
  async function member(ctx, step, name, m, { chat = true } = {}) {
    const key = 'mr:' + name;
    if (ctx.shared[key] && !ctx.shared[key].v.closed) return ctx.shared[key];
    const r = await step(name + ' opens the site, signs in at the identity origin' + (chat ? ' and turns chat on' : ''), async () => {
      const v = await ctx.visitor(name);
      const page = await v.newPage();
      await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(page, { timeoutMs: 20000 });
      await waitForSite(page, { timeoutMs: 30000, label: name + ': site' });
      const f = siteFrame(page);
      await f.waitForSelector('#sign-in:not([hidden])', { timeout: 15000 });
      const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
      popupPromise.catch(() => {});
      await f.click('#sign-in');
      await withTimeout(driveIdp(await popupPromise, { unlock: 'visit' }), 60000, 'identity origin');
      await waitUntil(() => f.evaluate(() => document.documentElement.dataset.auth === 'signed-in'), { timeoutMs: 20000, label: name + ': signed in' });
      if (chat) {
        const on = await withCards(page, async () => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { await mw.chat.enable(); } catch (e) { return { err: e.code || e.message }; }
          return mw.chat.state();
        }, null, [T.continue]);
        assert(on && on.state === 'on', name + ': chat ' + JSON.stringify(on));
      }
      const info = await sdk(page, async () => (await import('/_mw/sdk.js')).default.ready());
      return { v, page, pub: info.identity.pub, short: info.identity.short, name };
    });
    ctx.shared[key] = r;
    return r;
  }

  /** Two members add each other as contacts and wait until a first message gets through (both chat keys known). */
  async function linked(ctx, a, b) {
    const k = 'mr-linked:' + [a.name, b.name].sort().join('-');
    if (ctx.shared[k]) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      const r = await sdk(x.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.chat.contacts.add(p.pub, { nick: p.nick }); } catch (e) { return { err: e.code || e.message }; }
      }, { pub: y.pub, nick: y.name });
      if (r && r.err) throw new StepError(x.name + ' contacts.add: ' + r.err);
    }
    await waitUntil(async () => {
      const r = await sdk(a.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.chat.dm.send(p, { text: 'hi' }); } catch (e) { return { err: e.code || e.message }; }
      }, b.pub);
      if (r && r.err === 'E_NO_CHAT_KEY') return null;
      if (r && r.err) throw new StepError(a.name + ' dm.send: ' + r.err);
      return r;
    }, { timeoutMs: 30000, stepMs: 1000, label: a.name + ' reaches ' + b.name });
    ctx.shared[k] = true;
  }

  /** The owner writes blocks into the host's snapshot (cs=); a new visitor loads it and passes them on over gossip. */
  async function ownerWrites(ctx, m, write) {
    const file = join(m.outDir, 'genesis.json');
    let blocks = readBlocksFile(file);
    blocks = await write(blocks);
    writeBlocksFile(file, blocks);
    const name = 'RO' + (++m.carriers);
    if (m.carriers > 1) await ctx.closeVisitor('RO' + (m.carriers - 1));
    const v = await ctx.visitor(name);
    const page = await v.newPage();
    await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await acceptConsent(page, { timeoutMs: 20000 });
    await waitForSite(page, { timeoutMs: 30000, label: name + ': site' });
  }

  async function filesList(page) {
    const list = await sdk(page, async () => (await (await import('/_mw/sdk.js')).default.files.list()));
    return Array.isArray(list) ? list : [];
  }

  /** Shares a fixture (fetched from the web seed directory) publicly from the site frame; the upload card. -> { ref } */
  async function sharePublic(page, path, name, type) {
    await waitUntil(() => sdk(page, async () => ((await (await import('/_mw/sdk.js')).default.ready()).features || {}).files === true), { timeoutMs: 20000, label: 'files on' });
    const r = await withCards(page, async (p) => {
      const mw = (await import('/_mw/sdk.js')).default;
      const bytes = p.path ? await (await fetch(p.path)).arrayBuffer() : new TextEncoder().encode(p.text);
      try { return await mw.files.share(new File([bytes], p.name, { type: p.type }), { public: true }); } catch (e) { return { err: e.code || e.message }; }
    }, typeof path === 'string' ? { path, name, type } : Object.assign({ name, type }, path), [T.continue]);
    if (!r || !r.ref || r.err) throw new StepError('files.share ' + name + ': ' + JSON.stringify(r));
    return r;
  }

  /** files.fetch (the offer card: Accept) and the bytes of blob(), as a Buffer; or { err, reason }. */
  async function fetchBytes(page, ref) {
    const r = await withCards(page, async (x) => {
      const mw = (await import('/_mw/sdk.js')).default;
      let h;
      try { h = await mw.files.fetch(x); } catch (e) { return { err: e.code || e.message, reason: e.reason || null, message: e.message }; }
      const u8 = new Uint8Array(await (await h.blob()).arrayBuffer());
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { b64: btoa(s), size: h.size, mime: h.mime };
    }, ref, [T.accept], { timeoutMs: 60000 });
    if (r && r.err) return r;
    return { bytes: Buffer.from(r.b64, 'base64'), size: r.size, mime: r.mime };
  }

  // ------------------------------------------------------------------------------------------- E-FI-5
  S['E-FI-5'] = {
    title: 'metadata stripping in the browser: a JPEG with Exif GPS and an MP4 with a location atom, shared publicly, reach another member without them (asserted on the bytes)',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'RA', m);
      const b = await member(ctx, step, 'RB', m);
      const srcJpeg = readFileSync(m.fx.gpsJpeg.file);
      const srcMp4 = readFileSync(m.fx.udtaLocation.file);
      const before = { jpeg: jpegMarkers(srcJpeg), mp4: mp4Markers(srcMp4) };
      assert(before.jpeg.exif && before.jpeg.make && before.jpeg.gps && before.jpeg.icc, 'the JPEG fixture carries no Exif GPS: ' + JSON.stringify(before.jpeg));
      assert(before.mp4.xyz && before.mp4.loci && before.mp4.qtLocation && before.mp4.text, 'the MP4 fixture carries no location: ' + JSON.stringify(before.mp4));
      const jpg = await step('RA shares gps.jpg publicly (files.share, the upload card)', () => sharePublic(a.page, m.fx.gpsJpeg.path, 'gps.jpg', 'image/jpeg'));
      const mp4 = await step('RA shares udta-location.mp4 publicly (files.share, the upload card)', () => sharePublic(a.page, m.fx.udtaLocation.path, 'udta-location.mp4', 'video/mp4'));
      await step('the owner accepts both listings offline (premoderation, ledger-admin listed); a new visitor passes the blocks on', () => ownerWrites(ctx, m, async (blocks) => {
        let bl = (await acceptListing({ blocks, identity: m.identity, ih: jpg.ref, author: a.pub })).blocks; // MAL53-1: bound to the author
        bl = (await acceptListing({ blocks: bl, identity: m.identity, ih: mp4.ref, author: a.pub })).blocks;
        return bl;
      }));
      const listed = await step('RB lists both', () => waitUntil(async () => {
        const list = await filesList(b.page);
        const j = list.find((f) => f.ref === jpg.ref && !f.pending);
        const v = list.find((f) => f.ref === mp4.ref && !f.pending);
        return j && v ? { j, v } : null;
      }, { timeoutMs: 30000, label: 'listed at RB' }));
      const gotJpeg = await step('RB fetches the JPEG (the offer card: Accept); the bytes it gets: no Exif, no GPS IFD, no camera make, no ICC', async () => {
        const r = await fetchBytes(b.page, jpg.ref);
        assert(r && r.bytes, 'fetch ' + JSON.stringify(r));
        const after = jpegMarkers(r.bytes);
        assert(after.soi && !after.exif && after.app1 === 0 && !after.gps && !after.make && !after.icc, 'the fetched JPEG keeps metadata: ' + JSON.stringify(after));
        assert(r.bytes.length === listed.j.len && sha256hex(r.bytes) === listed.j.sha256, 'the bytes do not match the listing');
        return { size: r.bytes.length, after };
      });
      const gotMp4 = await step('RB fetches the MP4; the bytes it gets: no ©xyz, no loci, no QuickTime location key, no location text; ftyp and moov kept', async () => {
        const r = await fetchBytes(b.page, mp4.ref);
        assert(r && r.bytes, 'fetch ' + JSON.stringify(r));
        const after = mp4Markers(r.bytes);
        assert(!after.xyz && !after.loci && !after.qtLocation && !after.text && after.ftyp && after.moov, 'the fetched MP4 keeps a location: ' + JSON.stringify(after));
        assert(r.bytes.length === listed.v.len && sha256hex(r.bytes) === listed.v.sha256, 'the bytes do not match the listing');
        return { size: r.bytes.length, after, same: r.bytes.length === srcMp4.length };
      });
      return 'JPEG ' + srcJpeg.length + ' -> ' + gotJpeg.size + ' bytes (re-encoded: Exif, GPS, make and ICC gone); MP4 ' + srcMp4.length + ' -> ' + gotMp4.size +
        ' bytes (' + (gotMp4.same ? 'same length: udta and meta became free boxes' : 'length changed') + '; ©xyz, loci, QuickTime location key and location text gone)';
    },
  };

  // ------------------------------------------------------------------------------------------- E-FI-6
  S['E-FI-6'] = {
    title: 'file validation: sizes and types refused before any card, a JPEG/HTML polyglot cleaned, a listing whose len lies aborted and hidden, a listing whose sha256 lies dropped and hidden',
    async fn(ctx, step) {
      const { stack } = ctx;
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'RA', m);
      const b = await member(ctx, step, 'RB', m);
      const codes = await step('RA: a public file of 25 MiB + 1, private media of 100 MiB + 1 and HTML bytes named clip.mp4 are refused, each before any card', () => sdk(a.page, async (MIB_) => {
        const mw = (await import('/_mw/sdk.js')).default;
        const code = async (fn) => { try { await fn(); return 'resolved'; } catch (e) { return e.code || e.message; } };
        const big = (n) => { const one = new Uint8Array(MIB_); const parts = []; for (let i = 0; i < Math.floor(n / MIB_); i++) parts.push(one); parts.push(new Uint8Array(n % MIB_)); return parts; };
        const html = new TextEncoder().encode('<!doctype html><html><body><script>parent.__pwned = 1</script></body></html>');
        return {
          publicOverCap: await code(() => mw.files.share(new File(big(25 * MIB_ + 1), 'big.bin', { type: 'application/octet-stream' }), { public: true })),
          mediaOverCap: await code(() => mw.media.upload(new File(big(100 * MIB_ + 1), 'big.mp4', { type: 'video/mp4' }))),
          htmlAsMp4: await code(() => mw.media.upload(new File([html], 'clip.mp4', { type: 'video/mp4' }))),
        };
      }, MIB));
      const open = await cardOpen(a.page, T.continue);
      assert(codes.publicOverCap === 'E_LIMIT' && codes.mediaOverCap === 'E_LIMIT' && codes.htmlAsMp4 === 'E_MEDIA_TYPE' && !open, 'refusals ' + JSON.stringify(codes) + ', card open: ' + Boolean(open));

      // A JPEG/HTML polyglot: a real JPEG with an HTML document in a COM segment and more HTML after EOI.
      const poly = await step('RA shares a JPEG/HTML polyglot publicly (an HTML page in a COM segment and after EOI)', () => withCards(a.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        const jpeg = new Uint8Array(await (await fetch(p)).arrayBuffer());
        const html = new TextEncoder().encode('<html><body><script>alert(document.domain)</script></body></html>');
        const com = new Uint8Array(4 + html.length);
        com.set([0xff, 0xfe, (html.length + 2) >> 8, (html.length + 2) & 255]);
        com.set(html, 4);
        const out = new Uint8Array(jpeg.length + com.length + html.length);
        out.set(jpeg.subarray(0, 2), 0);
        out.set(com, 2);
        out.set(jpeg.subarray(2), 2 + com.length);
        out.set(html, 2 + com.length + jpeg.length - 2);
        try { return await mw.files.share(new File([out], 'poly.jpg', { type: 'image/jpeg' }), { public: true }); } catch (e) { return { err: e.code || e.message }; }
      }, m.fx.gpsJpeg.path, [T.continue]));
      assert(poly && poly.ref && !poly.err, 'polyglot share ' + JSON.stringify(poly));

      // Two torrents nobody listed, seeded by a helper page; the owner lists them with a lying len and a lying sha256.
      const seeder = await Visitor.open(ctx.browser, 'RSEED', run, { serviceWorkers: 'block' });
      ctx.visitors.set('RSEED', seeder);
      const seed = async (name, len) => {
        const p = await seeder.newPage();
        await p.goto(m.helper.url + 'seed.html?len=' + len + '&name=' + name + '&pl=16384&tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'load', timeout: 20000 });
        return waitUntil(async () => {
          const h = await p.evaluate(() => window.__h || null);
          if (h && h.errors.length) throw new StepError('seed page: ' + h.errors[0]);
          return h && h.seed ? h.seed : null;
        }, { timeoutMs: 20000, label: 'seeded ' + name });
      };
      const lenLie = await step('a helper page seeds lie-len.bin (40 KiB, unlisted)', () => seed('lie-len.bin', 40960));
      const hashLie = await step('a helper page seeds lie-hash.bin (40 KiB, unlisted)', () => seed('lie-hash.bin', 40960));
      const t0 = Date.now();
      await step('the owner accepts the polyglot and lists the two torrents: lie-len.bin with len + 16384, lie-hash.bin with another sha256', () => ownerWrites(ctx, m, async (blocks) => {
        let bl = (await acceptListing({ blocks, identity: m.identity, ih: poly.ref, author: a.pub })).blocks; // MAL53-1: bound to the author
        const lying = [
          { ih: lenLie.ih, len: lenLie.len + 16384, name: 'lie-len.bin', mime: 'application/octet-stream', sha256: lenLie.sha256, t: t0 },
          { ih: hashLie.ih, len: hashLie.len, name: 'lie-hash.bin', mime: 'application/octet-stream', sha256: 'ab'.repeat(32), t: t0 },
        ];
        for (const value of lying) bl = (await appendControl({ blocks: bl, identity: m.identity, op: { t: 'append', l: 'mw.files' }, value })).blocks;
        return bl;
      }));
      await step('RB lists the polyglot and both lying listings', () => waitUntil(async () => {
        const list = await filesList(b.page);
        return [poly.ref, lenLie.ih, hashLie.ih].every((ih) => list.find((f) => f.ref === ih && !f.pending)) ? list : null;
      }, { timeoutMs: 30000, label: 'three listings at RB' }));
      const polyGot = await step('RB fetches the polyglot: a JPEG that holds no HTML, no script and no COM text', async () => {
        const r = await fetchBytes(b.page, poly.ref);
        assert(r && r.bytes, 'fetch ' + JSON.stringify(r));
        const segs = jpegSegments(new Uint8Array(r.bytes));
        assert(r.bytes[0] === 0xff && r.bytes[1] === 0xd8, 'not a JPEG');
        for (const needle of ['<html', '<script', 'alert(']) assert(!has(r.bytes, needle), 'the fetched polyglot still holds ' + needle);
        assert(!segs.some((s) => s.name === 'COM'), 'a COM segment survived');
        return { size: r.bytes.length };
      });
      const lenR = await step('RB fetches lie-len.bin: aborted on the metadata (E_FILE_HASH, length) and hidden from files.list()', async () => {
        const r = await fetchBytes(b.page, lenLie.ih);
        // the SDK carries the code and the message (the lane's reason field stays in the loader)
        assert(r && r.err === 'E_FILE_HASH' && /length does not match the listing/.test(r.message), 'fetch of a lying len: ' + JSON.stringify(r && (r.err ? r : { size: r.size })));
        const list = await filesList(b.page);
        assert(!list.find((f) => f.ref === lenLie.ih), 'the lying listing is still listed');
        return r;
      });
      const hashR = await step('RB fetches lie-hash.bin: downloaded, then refused (E_FILE_HASH, sha256), the bytes dropped and the listing hidden', async () => {
        const r = await fetchBytes(b.page, hashLie.ih);
        assert(r && r.err === 'E_FILE_HASH' && /SHA-256/.test(r.message), 'fetch of a lying sha256: ' + JSON.stringify(r && (r.err ? r : { size: r.size })));
        const list = await filesList(b.page);
        assert(!list.find((f) => f.ref === hashLie.ih), 'the lying listing is still listed');
        const again = await sdk(b.page, async (x) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { await mw.files.preview(x); return 'previewed'; } catch (e) { return e.code || e.message; }
        }, hashLie.ih);
        assert(again !== 'previewed', 'a dropped file still previews');
        return r;
      });
      await ctx.closeVisitor('RSEED');
      return 'refused ' + JSON.stringify(codes) + ' with no card; polyglot fetched as a ' + polyGot.size + '-byte JPEG without HTML; lying len: ' + lenR.err + ' ("' + lenR.message + '"), lying sha256: ' + hashR.err + ' ("' + hashR.message + '"), both hidden';
    },
  };

  // ------------------------------------------------------------------------------------------- the private item
  // RA uploads moov-at-end.mp4 as private media and shares it with RB and RD; both accept and play it. The records are read from
  // the members' own pages (heapKeys) for the key tests below.
  async function privateItem(ctx, step) {
    if (ctx.shared.mrItem) return ctx.shared.mrItem;
    const m = await site(ctx, step);
    const a = await member(ctx, step, 'RA', m);
    const b = await member(ctx, step, 'RB', m);
    const d = await member(ctx, step, 'RD', m);
    await step('RA and RB, RA and RD: contacts, and a first message gets through', async () => {
      await linked(ctx, a, b);
      await linked(ctx, a, d);
    });
    const up = await step('RA uploads moov-at-end.mp4 as private media (media.upload, the upload card)', () => withCards(a.page, async (path) => {
      const mw = (await import('/_mw/sdk.js')).default;
      const bytes = await (await fetch(path)).arrayBuffer();
      try { return await mw.media.upload(new File([bytes], 'holiday.mp4', { type: 'video/mp4' })); } catch (e) { return { err: e.code || e.message }; }
    }, m.fx.moovAtEnd.path, [T.continue], { timeoutMs: 60000 }));
    assert(up && up.id && !up.err, 'upload ' + JSON.stringify(up));
    const sh = await step('RA shares it with RB and RD (media.share, the share card)', () => withCards(a.page, async (p) => {
      const mw = (await import('/_mw/sdk.js')).default;
      try { return await mw.media.share(p.id, { to: p.to }); } catch (e) { return { err: e.code || e.message }; }
    }, { id: up.id, to: [b.pub, d.pub] }, [T.continue]));
    assert(sh && !sh.err, 'share ' + JSON.stringify(sh));
    for (const x of [b, d]) {
      await step(x.name + ' accepts the offer card and plays the item (206 from the worker, a seek)', async () => {
        await answerCard(x.page, T.accept);
        const it = await waitUntil(async () => {
          const list = await sdk(x.page, async () => (await import('/_mw/sdk.js')).default.media.list({ from: 'received' }));
          return Array.isArray(list) ? list.find((i) => i.id === up.id) || null : null;
        }, { timeoutMs: 30000, label: 'received at ' + x.name });
        const played = await play(x.page, it.id);
        assert(played && !played.err && played.status === 206 && played.ready >= 2, x.name + ' playback ' + JSON.stringify(played));
      });
    }
    const own = await step('RA\'s own record (manifest and key) read from RA\'s page', async () => {
      const recs = await heapKeys(a.page);
      const r = recs.find((x) => x.id === up.id && x.from === 'mine');
      assert(r && r.M && r.M.ih, 'no own record for ' + up.id + ' among ' + recs.length);
      return r;
    });
    const item = { id: up.id, ih: own.M.ih, M: own.M, fk: own.fk };
    ctx.shared.mrItem = item;
    return item;
  }

  /** Opens a media item in the site frame and plays it in a <video> with a seek: { url, status, ready, at } or { err }. */
  async function play(page, id) {
    return withCards(page, async (x) => {
      const mw = (await import('/_mw/sdk.js')).default;
      let o;
      try { o = await mw.media.open(x); } catch (e) { return { err: e.code || e.message }; }
      const range = await fetch(o.url, { headers: { Range: 'bytes=0-15' } });
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = o.url;
      document.body.appendChild(v);
      try {
        await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video error ' + (v.error && v.error.code))); setTimeout(() => rej(new Error('no loadeddata')), 30000); });
        v.currentTime = Math.max(0.5, (v.duration || 2) / 2);
        await new Promise((res, rej) => { v.onseeked = res; setTimeout(() => rej(new Error('no seeked')), 30000); });
        return { url: o.url, status: range.status, ready: v.readyState, at: v.currentTime };
      } finally {
        v.remove();
      }
    }, id, [], { timeoutMs: 75000 });
  }

  // ------------------------------------------------------------------------------------------- E-MD-3B
  S['E-MD-3B'] = {
    title: 'a third member fetches the private item\'s ciphertext by infohash from the swarm: the pieces match the piece table, hold no plaintext, open with the recipient\'s key and with no key held in its own context',
    async fn(ctx, step) {
      const { stack } = ctx;
      const m = await site(ctx, step);
      const item = await privateItem(ctx, step);
      const b = ctx.shared['mr:RB'];
      const c = await member(ctx, step, 'RC', m, { chat: false });
      const page = await step('RC opens a WebTorrent page in its own browser context and joins the swarm by the infohash alone', async () => {
        const p = await c.v.newPage();
        await p.goto(m.helper.url + 'fetch.html?ih=' + item.ih + '&tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'load', timeout: 20000 });
        return p;
      });
      const got = await step('RC gets the info dictionary (private, x-mw-nonce) and every piece', () => waitUntil(async () => {
        const h = await page.evaluate(() => window.__h || null);
        if (h && h.errors.length) throw new StepError('fetch page: ' + h.errors[0]);
        return h && h.done ? h : null;
      }, { timeoutMs: 60000, label: 'the ciphertext at RC' }));
      await page.close();
      const pieces = got.pieces.map((b64, i) => [i, new Uint8Array(Buffer.from(b64, 'base64'))]);
      assert(got.meta.private && got.meta.nonce && got.meta.pieceLength === item.M.P && pieces.length === item.M.total, 'metadata ' + JSON.stringify(Object.assign({}, got.meta, { hashes: undefined })) + ' vs P ' + item.M.P + ', total ' + item.M.total);
      for (const [i, p] of pieces) assert(sha1hex(p) === got.meta.hashes.slice(i * 40, i * 40 + 40), 'piece ' + i + ' does not match the piece table');
      const src = readFileSync(m.fx.moovAtEnd.file);
      const probes = [[0, 64], [Math.floor(src.length / 2), 64], [src.length - 64, 64]].map(([o, n]) => src.subarray(o, o + n));
      const all = Buffer.concat(pieces.map(([, p]) => Buffer.from(p)));
      for (const pr of probes) assert(all.indexOf(pr) < 0, 'a run of 64 plaintext bytes is in the ciphertext');
      assert(!pieces.some(([, p]) => p[4] === 0x66 && p[5] === 0x74 && p[6] === 0x79 && p[7] === 0x70), 'a piece starts with an ftyp box');
      const control = await tryKey(new Uint8Array(Buffer.from(item.fk, 'base64')), item.M, pieces);
      assert(control.opened === pieces.length, 'the uploader\'s key opens ' + control.opened + ' of ' + pieces.length + ' (the bytes are not the item\'s ciphertext)');
      const own = await step('RC\'s loader: media.list() has nothing, media.open(<the id>) is refused', () => sdk(c.page, async (id) => {
        const mw = (await import('/_mw/sdk.js')).default;
        const list = await mw.media.list({ from: 'all' });
        let code = null;
        try { await mw.media.open(id); code = 'opened'; } catch (e) { code = e.code || e.message; }
        return { listed: list.length, code };
      }, item.id));
      assert(own.listed === 0 && own.code !== 'opened', 'RC ' + JSON.stringify(own));
      const keys = await step('every key held in RC\'s page (its loader\'s media and file records) tried on every piece', async () => {
        const recs = await heapKeys(c.page);
        assert(!recs.some((r) => r.ih === item.ih), 'RC holds a record for the item');
        let opened = 0;
        for (const r of recs) {
          if (!r.M) continue;
          opened += (await tryKey(fkOf(r), Object.assign({}, item.M, { fid: r.M.fid, base: r.M.base }), pieces)).opened;
          opened += (await tryKey(fkOf(r), item.M, pieces)).opened;
        }
        assert(opened === 0, opened + ' piece(s) opened with a key from RC\'s context');
        return recs.length;
      });
      // RB, a recipient, holds the item's key: the same pieces open with it (the grant is what makes the difference).
      const rb = (await heapKeys(b.page)).find((r) => r.ih === item.ih);
      assert(rb, 'RB holds no record for the item');
      const viaRb = await tryKey(fkOf(rb), rb.M, pieces);
      assert(viaRb.opened === pieces.length, 'RB\'s key opens ' + viaRb.opened + ' of ' + pieces.length);
      return pieces.length + ' pieces (' + item.M.P + ' bytes each) fetched by infohash on ' + got.wires + ' wire(s), all matching the piece table, no ftyp, no plaintext run; RC lists ' + own.listed + ' item(s), open: ' + own.code +
        '; ' + keys + ' key(s) in RC\'s page opened 0 pieces; RB\'s key opens ' + viaRb.opened;
    },
  };

  // ------------------------------------------------------------------------------------------- E-MD-5R
  S['E-MD-5R'] = {
    title: 'revoke with reencrypt: the remaining recipient plays the new item, the uploader\'s old chunks are gone, and the revoked recipient\'s old key opens no chunk of the new ciphertext',
    async fn(ctx, step) {
      const item = await privateItem(ctx, step);
      assert(!ctx.shared.mrReencrypted, 'the item was already re-encrypted in this run');
      const a = ctx.shared['mr:RA'];
      const b = ctx.shared['mr:RB'];
      const d = ctx.shared['mr:RD'];
      const kept = await step('RB\'s record of the item (its key and manifest), as a recipient who keeps it would read it from its own page', async () => {
        const r = (await heapKeys(b.page)).find((x) => x.ih === item.ih);
        assert(r && r.M, 'RB holds no record for the item');
        return r;
      });
      const oldChunks = await step('RA\'s chunk store of the old item (m-<id>): the old key opens it', async () => {
        const ch = await idbChunks(a.page, 'm-' + item.id);
        assert(ch.length === item.M.total, 'RA holds ' + ch.length + ' of ' + item.M.total + ' old chunks');
        const t = await tryKey(fkOf(kept), kept.M, ch);
        assert(t.opened === ch.length, 'RB\'s key opens ' + t.opened + ' of ' + ch.length + ' old chunks');
        return ch;
      });
      const r = await step('RA revokes RB with reencrypt (media.revoke({ from: [RB], reencrypt: true }), the confirm card)', () => withCards(a.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.media.revoke(p.id, { from: [p.pub], reencrypt: true }); } catch (e) { return { err: e.code || e.message }; }
      }, { id: item.id, pub: b.pub }, [T.continue], { timeoutMs: 90000 }));
      ctx.shared.mrReencrypted = true;
      assert(r && !r.err && r.reencrypted === true && r.revoked.indexOf(b.pub) >= 0 && r.id && r.id !== item.id, 'revoke ' + JSON.stringify(r));
      const newId = r.id;
      await step('RB: the item leaves media.list() and media.open() is E_REVOKED', () => waitUntil(async () => {
        const x = await sdk(b.page, async (id) => {
          const mw = (await import('/_mw/sdk.js')).default;
          const list = await mw.media.list({ from: 'all' });
          let code = null;
          try { await mw.media.open(id); code = 'opened'; } catch (e) { code = e.code || e.message; }
          return { listed: list.length, code };
        }, item.id);
        return x.listed === 0 && x.code === 'E_REVOKED' ? x : null;
      }, { timeoutMs: 30000, label: 'revoked at RB' }));
      const played = await step('RD gets a new offer for the re-encrypted item, accepts it and plays it (206, a seek)', async () => {
        await answerCard(d.page, T.accept, { timeoutMs: 45000 });
        const it = await waitUntil(async () => {
          const list = await sdk(d.page, async () => (await import('/_mw/sdk.js')).default.media.list({ from: 'received' }));
          return Array.isArray(list) ? list.find((i) => i.id === newId) || null : null;
        }, { timeoutMs: 30000, label: 'the new item at RD' });
        const p = await play(d.page, it.id);
        assert(p && !p.err && p.status === 206 && p.ready >= 2, 'RD playback ' + JSON.stringify(p));
        return p;
      });
      const fresh = await step('RA: the new item\'s chunks are in m-<new id>, the old store m-<old id> is empty', async () => {
        const gone = await idbChunks(a.page, 'm-' + item.id);
        assert(gone.length === 0, 'RA still holds ' + gone.length + ' old chunks');
        const ch = await idbChunks(a.page, 'm-' + newId);
        assert(ch.length === item.M.total, 'RA holds ' + ch.length + ' new chunks of ' + item.M.total);
        return ch;
      });
      const rd = await step('RD\'s record of the new item (its key and manifest)', async () => {
        const x = (await heapKeys(d.page)).find((y) => y.id === newId);
        assert(x && x.M && x.M.ih !== item.ih && idOf(x.M) === newId, 'RD holds no record for ' + newId);
        return x;
      });
      const res = await step('RB\'s old key on every new chunk (with the old manifest, and with the new fid and base): nothing opens; RD\'s new key opens every chunk', async () => {
        const oldKey = fkOf(kept);
        const a1 = await tryKey(oldKey, kept.M, fresh);
        const a2 = await tryKey(oldKey, rd.M, fresh);
        const ok = await tryKey(fkOf(rd), rd.M, fresh);
        const back = await tryKey(fkOf(rd), kept.M, oldChunks);
        assert(a1.opened === 0 && a2.opened === 0, 'the old key opens ' + a1.opened + ' + ' + a2.opened + ' new chunks');
        assert(ok.opened === fresh.length, 'the new key opens ' + ok.opened + ' of ' + fresh.length);
        assert(back.opened === 0, 'the new key opens ' + back.opened + ' old chunks');
        return { a1, a2, ok };
      });
      return 'revoked and re-encrypted to ' + newId.slice(0, 12) + '... (new infohash ' + rd.M.ih.slice(0, 12) + '...); RD plays it (206, readyState ' + played.ready + '); RA\'s old store is empty; RB\'s old key opened 0 of ' + fresh.length +
        ' new chunks (old manifest and new fid/base: ' + res.a1.failed + ' and ' + res.a2.failed + ' refused), the new key ' + res.ok.opened;
    },
  };

  // ------------------------------------------------------------------------------------------- E-MD-6
  S['E-MD-6'] = {
    title: 'uploader offline: a pin node (node tools/pin.mjs as a child process, loopback, temporary profile) keeps a private media item; a fresh context accepts the grant and plays it from the pin; with no holder, "unavailable" and the grant kept, then it plays once the pin is back',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'RA', m);
      const e = await member(ctx, step, 'RE', m);
      const f = await member(ctx, step, 'RF', m);
      const pin = await step('the pin node: `node tools/pin.mjs <site> --headless --files --pin-key <key named in _mw.cfg.pin> --status ...` as a child process with a temporary profile', async () => {
        const p = await startPinProcess({ url: m.url, keyFile: m.pinKeyFile, statusFile: join(m.outDir, 'pin-status.json') });
        ctx.closers.push(() => p.cleanup());
        await withTimeout(p.start(), 120000, 'the pinned page renders');
        assert(p.pub === m.pinKey.pub, 'the node runs another key than _mw.cfg.pin names');
        return p;
      });
      const failWithLog = (err) => { throw new StepError(err.message + '; pin log:\n    ' + pin.lines.slice(-15).join('\n    ')); };
      try {
        await step('RA and RE, RA and RF: contacts, and a first message gets through', async () => {
          await linked(ctx, a, e);
          await linked(ctx, a, f);
        });
        const up = await step('RA uploads moov-at-end.mp4 as a new private item (the upload card)', () => withCards(a.page, async (path) => {
          const mw = (await import('/_mw/sdk.js')).default;
          const bytes = await (await fetch(path)).arrayBuffer();
          try { return await mw.media.upload(new File([bytes], 'kept.mp4', { type: 'video/mp4' })); } catch (err) { return { err: err.code || err.message }; }
        }, m.fx.moovAtEnd.path, [T.continue], { timeoutMs: 60000 }));
        assert(up && up.id && !up.err, 'upload ' + JSON.stringify(up));
        const own = (await heapKeys(a.page)).find((x) => x.id === up.id && x.from === 'mine');
        assert(own && own.M, 'no own record for ' + up.id);
        const ih = own.M.ih;
        const size = own.M.total * own.M.P;
        const approved = await step('the request waits in the pin\'s moderator queue (`--queue`: name, size, author key) and a moderator approves it (`node tools/pin.mjs --approve <ih> --profile <dir>`, its own process)', async () => {
          // The running node has reported the site to its heartbeat (its page is up and offers its host) before the approval, so
          // the approval below is one made while the node runs, as an operator would make it.
          await pin.waitFor(/^heartbeat: \d+ item/, 45000);
          await sleep(4000);
          // As E-PS-1: a member's page has no path to sign a pin request yet (pin-node O-1), so the operator enters it at the store.
          const q = pin.request({ ih, name: 'kept.mp4', size, author: a.pub });
          assert(q && q.queued, 'queued ' + JSON.stringify(q));
          const listed = await pin.moderate(['--queue']);
          assert(listed.code === 0 && listed.out.indexOf(ih) >= 0 && listed.out.indexOf('kept.mp4') >= 0, '--queue ' + JSON.stringify(listed));
          const r = await pin.moderate(['--approve', ih, '--by', 'e2e moderator']);
          assert(r.code === 0 && r.out.indexOf('pinned ' + ih) === 0, '--approve ' + JSON.stringify(r));
          assert(pin.pinned().some((x) => x.ih === ih && x.approvedBy === 'e2e moderator'), 'not pinned on disk');
          return r.out;
        });
        // tools/pin.mjs prints "the running pin node fetches and keeps it", but a running node that already offered its page host only
        // restores pinned files when its page (re)loads (docs/deviations/rows-media.md, D-1). Wait one window for the running node;
        // if it did not start the item, restart it on the same profile, as an operator would.
        let restartedForApproval = false;
        const held = await step('the pin fetches the ciphertext from RA and holds it whole: its signed heartbeat (pin-status.json) lists the item', async () => {
          try {
            return await pin.waitForStatus((s) => s.ok && s.has(ih), 15000, { site: m.ledgerId });
          } catch (_) {
            restartedForApproval = true;
            await pin.stop();
            await withTimeout(pin.start(), 120000, 'the pinned page renders again');
            return pin.waitForStatus((s) => s.ok && s.has(ih), 40000, { site: m.ledgerId });
          }
        }).catch(failWithLog);
        let last = null;
        const label = await step('RA\'s item reads "Kept by the site" (E4, the pin\'s receipt over mw_pin1)', () => waitUntil(async () => {
          last = await sdk(a.page, async (id) => {
            const list = await (await import('/_mw/sdk.js')).default.media.list({ from: 'mine' });
            const it = list.find((x) => x.id === id);
            return it ? { label: it.label, tier: it.evidence && it.evidence.tier, handoff: it.handoff && it.handoff.state } : null;
          }, up.id);
          return last && last.label === 'avail.keptBySite' && last.tier === 'E4' ? last : null;
        }, { timeoutMs: 30000, label: 'kept by the site' }).catch((err) => { throw new StepError(err.message + ' (last ' + JSON.stringify(last) + ')'); }));
        const sh = await step('RA shares it with RE and RF (the share card); both offer cards open; RA goes offline before either answers', async () => {
          const r = await withCards(a.page, async (p) => {
            const mw = (await import('/_mw/sdk.js')).default;
            try { return await mw.media.share(p.id, { to: p.to }); } catch (err) { return { err: err.code || err.message }; }
          }, { id: up.id, to: [e.pub, f.pub] }, [T.continue]);
          assert(r && !r.err, 'share ' + JSON.stringify(r));
          for (const x of [e, f]) await waitUntil(async () => { const c = await cardOpen(x.page, T.accept); if (c && c.width > 0) return c; await dismissKitCard(x.page); return null; }, { timeoutMs: 30000, label: 'the offer card at ' + x.name });
          await ctx.closeVisitor('RA');
          delete ctx.shared['mr:RA'];
          return r;
        });
        const sent0 = pin.monthBytes();
        const played = await step('RE accepts and plays it with the uploader offline: the pin is the only holder (206, a seek, readyState 2 or more)', async () => {
          await answerCard(e.page, T.accept);
          const it = await waitUntil(async () => {
            const list = await sdk(e.page, async () => (await import('/_mw/sdk.js')).default.media.list({ from: 'received' }));
            return Array.isArray(list) ? list.find((i) => i.id === up.id) || null : null;
          }, { timeoutMs: 30000, label: 'received at RE' });
          const p = await play(e.page, it.id);
          assert(p && !p.err && p.status === 206 && p.ready >= 2, 'RE playback ' + JSON.stringify(p));
          return p;
        });
        const sent = await step('the pin counted the bytes it sent (pin/month.json of its profile went up)', () => waitUntil(() => {
          const n = pin.monthBytes();
          return n > sent0 ? n - sent0 : null;
        }, { timeoutMs: 20000, label: 'pin upload count' }));
        await step('no holder: RE goes offline and the pin node stops (SIGTERM; it writes an empty heartbeat, the profile and its bytes stay)', async () => {
          await ctx.closeVisitor('RE');
          delete ctx.shared['mr:RE'];
          const r = await pin.stop();
          assert(r && (r.code === 0 || r.signal === 'SIGTERM'), 'the pin node exit ' + JSON.stringify(r));
          const st = await pin.readStatus({ site: m.ledgerId });
          assert(st.ok && !st.has(ih), 'the heartbeat after stop ' + JSON.stringify({ ok: st.ok, reason: st.reason, count: st.count }));
        });
        const t0 = Date.now();
        // The step cap is 60 s and the info dictionary wait is 60 s too: the accept and the wait are separate steps.
        await step('RF accepts the offer card while nobody who has the item is online', async () => {
          await sdk(f.page, async () => {
            const mw = (await import('/_mw/sdk.js')).default;
            window.__mrUnavailable = [];
            mw.media.on('unavailable', (x) => window.__mrUnavailable.push(x));
          });
          await answerCard(f.page, T.accept);
        });
        const unavailableAt = async () => (await sdk(f.page, () => window.__mrUnavailable.slice())).find((x) => x && x.id === up.id) || null;
        await step('no peer sends the info dictionary (the first 50 s of the 60 s wait)', () => sleep(Math.max(0, 50000 - (Date.now() - t0))));
        const gone = await step('media.on("unavailable") fires for the item at RF, and the grant is kept (media.list)', async () => {
          const ev = await waitUntil(unavailableAt, { timeoutMs: 40000, stepMs: 500, label: 'unavailable at RF' });
          const list = await sdk(f.page, async () => (await import('/_mw/sdk.js')).default.media.list({ from: 'received' }));
          assert(Array.isArray(list) && list.some((i) => i.id === up.id), 'the grant was dropped: ' + JSON.stringify(list));
          return { ev, ms: Date.now() - t0 };
        });
        // A holder is back: the pin node runs again on the same profile. tools/pin.mjs restores the pinned file by infohash only;
        // the pinned page keeps the bytes but not the info dictionary (src/loader/pinwire.js createPinPageHost.start), so with
        // nobody else online it may never get the metadata back (docs/deviations/rows-media.md, D-2). The scenario plays the kept
        // grant when the pin seeds the item again, and otherwise reports D-2 in its result and checks that the grant is still kept.
        const back = await step('the pin node starts again on the same profile; when its heartbeat lists the item again, RF opens the kept grant and plays it from the pin (206, a seek)', async () => {
          await withTimeout(pin.start(), 60000, 'the pinned page renders again');
          const listed = await pin.waitForStatus((s) => s.ok && s.has(ih), 25000, { site: m.ledgerId }).then(() => true, () => false);
          if (!listed) {
            const list = await sdk(f.page, async () => (await import('/_mw/sdk.js')).default.media.list({ from: 'received' }));
            assert(Array.isArray(list) && list.some((i) => i.id === up.id), 'the grant was dropped after the pin came back: ' + JSON.stringify(list));
            return { d2: true };
          }
          const p = await play(f.page, up.id);
          assert(p && !p.err && p.status === 206 && p.ready >= 2, 'RF playback ' + JSON.stringify(p));
          return p;
        });
        return 'pinned ' + size + ' bytes of ciphertext by a child-process pin node (' + JSON.stringify(approved) + (restartedForApproval ? '; the running node started it only after a restart, D-1' : '; the running node started it') +
          '; heartbeat ' + held.count + ' item(s); uploader label ' + JSON.stringify(label) + '); RA offline; RE accepted the grant ' + (sh && sh.granted ? '(delivered) ' : '') + 'and played from the pin: 206, readyState ' + played.ready +
          ' after a seek to ' + played.at.toFixed(1) + ' s; the pin counted ' + sent + ' bytes sent; with the pin stopped RF got "unavailable" after ' +
          Math.round(gone.ms / 1000) + ' s and kept the grant; ' + (back.d2
            ? 'OPEN D-2: the pin node\'s run ' + pin.runs() + ' on the same profile did not seed the item again within 25 s (no info dictionary kept, nobody else online); the grant is still kept at RF'
            : 'it played (206, readyState ' + back.ready + ') from the pin\'s run ' + pin.runs());
      } finally {
        await pin.cleanup().catch(() => {});
        for (const n of ['RB', 'RC', 'RD', 'RE', 'RF', 'RO' + m.carriers]) {
          await ctx.closeVisitor(n);
          delete ctx.shared['mr:' + n];
        }
      }
    },
  };

  return S;
}
