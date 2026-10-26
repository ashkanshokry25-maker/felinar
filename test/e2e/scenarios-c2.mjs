// test/e2e/scenarios-c2.mjs: the phase C2 seeding and zero-setup scenarios of docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md
// section 5 ("the C2 integrator ... adds E-PS-1 ... E-ZS-1"), through the real loader, SDK, identity origin, files lane, pin node
// (tools/pin.mjs through test/fixtures/pin/start-pin.mjs) and seed policy. Written by the C2 integrator.
//
//   E-PS-1  hand-off to a pin node: an upload is lane H with "Only on this device"; the pin is asked to keep it (its page door
//           refuses an unsigned request, code review v0.3; the request is entered at the pin's store as its operator would, then
//           approved as a moderator would with --approve: no page-to-pin request path exists yet), authenticates on the file wire with mw_pin1 hello, fetches it from the
//           uploader, sends a receipt; the uploader's label becomes "Kept by the site" (E4) and the hand-off reads "kept";
//           the signed heartbeat lists the item (hashed). The 5 MiB transfer time is reported (loopback, not Wi-Fi).
//   E-PS-2  lying bitfields stay "reported": a peer that announces every piece of an upload it never fetched (have
//           messages, no data) gives the uploader "Kept by you and at least 1 others online now (reported)", tier E1,
//           reported: true, and never "Kept by the site"; a second liar changes the count, never the tier.
//   E-PS-3  the month cap stops K and E, not H: a member whose month record is at the desktop cap (20 GB, K plus E) has
//           K and E locked and H open; another member fetches the member's upload (H bytes leave), while K and E send
//           nothing; the "Sharing paused" line is on the bar. Wires are made to read as not local (getStats reports
//           srflx), because two tabs on one machine are a host-to-host pair, which the cap does not count.
//   E-PS-4  dock mode on a phone (Pixel 7 emulation, a battery that reports charging): mw.net.dock({ hours: 2 }) and the
//           card's button take the screen Wake Lock inside the click; K and E open while it runs (dock mode is the
//           opt-in); "Stop and let the screen sleep" releases the lock and closes them again.
//   E-ZS-1  no DNS-over-HTTPS query for a nip.io name: the site published for 127-0-0-1.nip.io (page tag only) renders at
//           http://127-0-0-1.nip.io:<port>/ with an owner resolver (<meta name="mw-doh">, a counting stub on 127.0.0.1)
//           that receives nothing; a control name (c2-zs-control.example.net) on the same browser does reach the stub.
//
// Network policy (docs/DEV-NETWORK.md): every page is on 127.0.0.1, except E-ZS-1's two names, which a Chromium of its own
// maps to 127.0.0.1 with its host resolver rule (chromiumArgs() with that one loopback mapping in front of the local-only
// rule: no name reaches a DNS server, no packet leaves the machine) and treats as secure contexts. Every other visitor is a
// lib.mjs Visitor of the run's browser (request guard, ICE servers emptied). The pin node runs tools/pin.mjs headless with
// chromiumArgs({ allowRemote: false }) through the fixture, which accepts only http://127.0.0.1 URLs.

import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

import { Visitor, waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, clickLoaderCard, dismissKitCard, shellState, ROOT } from './lib.mjs';
import { chromiumArgs } from './browser-args.mjs';
import { driveIdp } from './idp-driver.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { setCfg, readBlocksFile, writeBlocksFile, acceptListing } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadPinKey } from '../../tools/pin.mjs';
import { startPin } from '../fixtures/pin/start-pin.mjs';
import { UI_TEXT, SEED_TEXT } from '../../src/loader/strings.js';
import { monthKeyOf } from '../../src/loader/seed-meters.js';

export const SEED_ORDER = ['E-PS-1', 'E-PS-2', 'E-PS-3', 'E-PS-4', 'E-ZS-1'];

const T = UI_TEXT.en;
const S = SEED_TEXT.en;
/** The desktop month cap of SZ 3.1.3 (decimal, docs/deviations/seed-policy.md). */
const DESKTOP_MONTH_CAP = 20000000000;

// ---------------------------------------------------------------------------------------------
// init scripts
// ---------------------------------------------------------------------------------------------

/** Every peer connection's selected pair reads as server-reflexive, so torrent.js counts the wire as not local (E-PS-3). */
function nonLocalStats() {
  const P = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
  if (!P || P.__mwSrflx) return;
  const orig = P.getStats;
  P.getStats = function (...a) {
    return orig.apply(this, a).then((report) => {
      const out = new Map();
      report.forEach((s, id) => { out.set(id, s && s.type === 'local-candidate' ? Object.assign({}, s, { candidateType: 'srflx' }) : s); });
      return out;
    });
  };
  Object.defineProperty(P, '__mwSrflx', { value: true });
}

/** A battery that charges at 90% and a Wake Lock that records each request and release (E-PS-4, a phone context). */
function fakeBatteryAndWakeLock() {
  if (window.__mwDockE2E) return;
  const W = { requests: [], releases: 0, sentinels: [] };
  window.__mwDockE2E = W;
  const listeners = () => {
    const m = new Map();
    return {
      addEventListener(t, f) { if (!m.has(t)) m.set(t, new Set()); m.get(t).add(f); },
      removeEventListener(t, f) { if (m.has(t)) m.get(t).delete(f); },
      emit(t) { for (const f of Array.from(m.get(t) || [])) { try { f({ type: t }); } catch (_) { /* a listener */ } } },
    };
  };
  const battery = Object.assign(listeners(), { charging: true, level: 0.9, chargingTime: 0, dischargingTime: Infinity });
  try { Object.defineProperty(Navigator.prototype, 'getBattery', { configurable: true, value() { return Promise.resolve(battery); } }); } catch (_) { /* fixed */ }
  // Chrome for Android reports the network type; the desktop build in phone emulation does not, so it is given here (SZ 3.1.3
  // row 2: Wi-Fi by connection.type, charging, battery 50% and up, the one row where a phone may run K and E).
  const conn = Object.assign(listeners(), { type: 'wifi', effectiveType: '4g', saveData: false, downlink: 10, rtt: 50 });
  try { Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get() { return conn; } }); } catch (_) { /* fixed */ }
  const wakeLock = {
    request(type) {
      const ua = navigator.userActivation;
      W.requests.push({ type, active: !!(ua && ua.isActive), at: Date.now() });
      const ev = listeners();
      const s = {
        type, released: false, onrelease: null,
        addEventListener: ev.addEventListener, removeEventListener: ev.removeEventListener,
        release() { if (s.released) return Promise.resolve(); s.released = true; W.releases++; ev.emit('release'); if (typeof s.onrelease === 'function') s.onrelease({ type: 'release' }); return Promise.resolve(); },
      };
      W.sentinels.push(s);
      return Promise.resolve(s);
    },
  };
  try { Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get() { return wakeLock; } }); } catch (_) { /* fixed */ }
}

// ---------------------------------------------------------------------------------------------
// pages served by a small loopback server: the liar peer (E-PS-2)
// ---------------------------------------------------------------------------------------------

/** A peer that joins a file swarm, takes the metadata, announces every piece with have messages and fetches nothing. */
const LIAR_PAGE = `<!doctype html><meta charset="utf-8"><title>liar peer</title>
<script type="module">
import WebTorrent from '/_mw/webtorrent.min.js';
const q = new URLSearchParams(location.search);
const L = window.__liar = { wires: 0, claimed: 0, meta: false, errors: [] };
const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } }, dht: false, lsd: false, utPex: false, webSeeds: false });
client.on('error', (e) => L.errors.push(String((e && e.message) || e)));
const t = client.add('magnet:?xt=urn:btih:' + q.get('ih'), { announce: [q.get('tr')], private: true, deselect: true });
window.__liarT = t;
const n = () => (t.pieces ? t.pieces.length : 0);
const claim = (wire) => {
  if (!n() || wire.destroyed || wire.__claimed) return;
  wire.__claimed = true;
  for (let i = 0; i < n(); i++) wire.have(i);
  L.claimed++;
};
t.on('metadata', () => { L.meta = true; try { t.deselect(0, n() - 1, 0); } catch (_) {} for (const w of t.wires) setTimeout(() => claim(w), 300); });
t.on('wire', (wire) => { L.wires++; wire.on('unchoke', () => { try { wire.uninterested(); } catch (_) {} }); setTimeout(() => claim(wire), 300); });
</script>`;

async function liarServer(dist) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    if (p === '/liar.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(LIAR_PAGE);
    }
    if (p === '/_mw/webtorrent.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(join(dist, '_mw', 'webtorrent.min.js')));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) };
}

/** A DNS-over-HTTPS JSON stub on 127.0.0.1 that counts every query and answers NXDOMAIN (E-ZS-1). */
async function dohStub() {
  const queries = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    queries.push({ at: Date.now(), name: u.searchParams.get('name'), type: u.searchParams.get('type'), path: u.pathname });
    res.writeHead(200, { 'content-type': 'application/dns-json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ Status: 3, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name: u.searchParams.get('name'), type: 16 }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/dns-query', queries, close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }) };
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

/** seedScenarios({ run, assert, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function seedScenarios({ run, assert, headed = false }) {
  const SC = {};

  /** A guestbook with files for members (and chat), its own dev server, cfg extras (pin) served at cs=. */
  async function seedSite(ctx, step, key, { cfg = {}, scope = '127.0.0.1', doh = null, tls = null } = {}) {
    const k = 'seedSite:' + key;
    if (ctx.shared[k]) return ctx.shared[k];
    const { stack } = ctx;
    const m = await step('a guestbook for members with files on' + (cfg.pin ? ' and _mw.cfg.pin named' : '') + ' (' + key + ', scope ' + scope + ')', async () => {
      const outDir = join(stack.runDir, 'c2-' + key);
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true, doh, tls: tls || false });
      ctx.closers.push(() => dev.close());
      // The page's address: the scope's name on the dev server's port. The web seed and cs= stay on http://127.0.0.1 (publish
      // allows plain http for loopback only; for another name the page fetches them cross-origin, as from a static host).
      const base = scope === '127.0.0.1' ? dev.url : (tls ? 'https://' : 'http://') + scope + ':' + dev.port + '/';
      const pub = await publish({
        // A ledger of its own (chain): sites on one scope with one owner key would otherwise share a ledger id and merge their _mw.cfg.
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'c2-' + key, scope, chain: 'e2e-c2-' + key, key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
        tracker: [stack.tracker.url], stun: ['stun:127.0.0.1:3478'], chat: true, files: true,
      });
      const identity = await loadOwnerKey(stack.owner.file);
      const set = Object.assign({ chat: 'members', files: 'members' }, cfg);
      const res = await setCfg({ blocks: readBlocksFile(join(outDir, 'genesis.json')), identity, set });
      writeBlocksFile(join(outDir, 'genesis.json'), res.blocks);
      dev.setPointer(pub.pointer);
      return { dev, pub, outDir, url: base, ledgerId: pub.ledgerId };
    });
    ctx.shared[k] = m;
    return m;
  }

  async function sdk(page, fn, arg) {
    return siteFrame(page).evaluate(fn, arg);
  }

  /** Runs fn in the site frame (an evaluate is a user gesture) and presses the loader cards named by labels, in order. */
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
        await dismissKitCard(page); // the recovery kit card of the page's first meaningful action queues every later card
        return null;
      }, { timeoutMs, label: 'the loader card "' + label + '"' });
      if (settled) break;
      await waitUntil(async () => {
        if (settled) return true;
        await clickLoaderCard(page, label);
        await sleep(300);
        const still = await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
        return !still;
      }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
    }
    const r = await withTimeout(running, timeoutMs, 'the call');
    if (r.e) throw new StepError(r.e);
    return r.v;
  }

  /** A signed-in member (this visit only) of a seed site; opts.before(page) runs after the first render, before signing in. */
  async function member(ctx, step, name, m, { initScripts = [], contextOptions = {}, before = null } = {}) {
    return step(name + ' opens the site and signs in at the identity origin (this visit only)', async () => {
      const v = await ctx.visitor(name, { initScripts, contextOptions });
      const page = await v.newPage();
      await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(page, { timeoutMs: 20000 });
      await waitForSite(page, { timeoutMs: 30000, label: name + ': site' });
      if (before) await before(page);
      const f = siteFrame(page);
      await f.waitForSelector('#sign-in:not([hidden])', { timeout: 15000 });
      const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
      popupPromise.catch(() => {});
      await f.click('#sign-in');
      const popup = await popupPromise;
      await withTimeout(driveIdp(popup, { unlock: 'visit' }), 60000, 'identity origin');
      await waitUntil(() => f.evaluate(() => document.documentElement.dataset.auth === 'signed-in'), { timeoutMs: 20000, label: name + ': signed in' });
      const info = await sdk(page, async () => (await import('/_mw/sdk.js')).default.ready());
      return { v, page, pub: info.identity.pub, info };
    });
  }

  /** Shares a public file of `size` bytes (random content) from the site frame; presses the upload card. -> { ref } */
  async function share(page, name, size) {
    // The ledger (and with it _mw.cfg.files) can arrive a moment after the sign-in on a loaded runner: wait for the feature.
    await waitUntil(() => sdk(page, async () => ((await (await import('/_mw/sdk.js')).default.ready()).features || {}).files === true), { timeoutMs: 20000, label: 'files on (mw.ready().features.files)' });
    const r = await withCards(page, async ([n, len]) => {
      const mw = (await import('/_mw/sdk.js')).default;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(len, i + 65536)));
      try { return await mw.files.share(new File([bytes], n, { type: 'application/octet-stream' }), { public: true }); } catch (e) { return { err: e.code || e.message }; }
    }, [name, size], [T.continue]);
    if (!r || !r.ref || r.err) throw new StepError('files.share ' + JSON.stringify(r));
    return r;
  }

  async function item(page, ref) {
    const list = await sdk(page, async () => (await import('/_mw/sdk.js')).default.files.list());
    return Array.isArray(list) ? list.find((f) => f.ref === ref) || null : null;
  }

  // ------------------------------------------------------------------------------------------- E-PS-1
  SC['E-PS-1'] = {
    title: 'hand-off to a pin node: lane H "Only on this device", the pin authenticates (mw_pin1 hello), fetches, sends a receipt; the uploader reads "Kept by the site" (E4) and the heartbeat lists it',
    async fn(ctx, step) {
      const { stack } = ctx;
      const keyFile = join(stack.runDir, 'c2-pin.jwk');
      const pinKey = await step('a pin key for the node (tools/keygen.mjs), never the owner key', async () => {
        await keygen({ out: keyFile });
        return loadPinKey(keyFile);
      });
      const m = await seedSite(ctx, step, 'pin', { cfg: { pin: pinKey.pub } });
      const pin = await step('the pin node: tools/pin.mjs headless on the site (--files, --pin-key, --status into the web seed directory)', async () => {
        const p = await startPin({ url: m.url, keyFile, statusFile: join(m.outDir, 'pin-status.json'), files: true, autoAccept: 'owner', statusEverySec: 2, log: null });
        ctx.closers.push(() => p.stop());
        await withTimeout(p.ready, 120000, 'the pinned page renders');
        return p;
      });
      const u = await member(ctx, step, 'PU', m);
      const size = 5 * 1024 * 1024;
      const shared = await step('PU shares a 5 MiB file publicly (files.share, the upload card): lane H, "Only on this device"', () => share(u.page, 'handoff.bin', size));
      const ih = shared.ref;
      const first = await step('PU\'s files.list(): own item, hand-off onlyHere, label avail.onlyHere (E0)', () => waitUntil(async () => {
        const it = await item(u.page, ih);
        return it && it.mine && it.handoff && it.evidence ? it : null;
      }, { timeoutMs: 20000, label: 'own item listed' }));
      assert(first.handoff.state === 'onlyHere' && first.label === 'avail.onlyHere' && first.evidence.tier === 'E0', 'before the pin: ' + JSON.stringify({ h: first.handoff, label: first.label, ev: first.evidence }));
      const t0 = Date.now();
      // Code review v0.3 (round 2): the page door ('file.request') takes only a request its author signed (src/pin/frames.js
      // makePinRequest, verifyPinRequest), and a member's page has no path to sign one yet (O-1); so the step checks that the
      // door refuses an unsigned request, then enters it at the pin's store as its operator would and approves it (--approve).
      await step('the pin\'s page door refuses an unsigned file.request; the operator enters the request at the pin\'s store and a moderator approves it (--approve)', async () => {
        const host = pin.host();
        assert(host && host.files, 'the pin host runs with --files');
        await waitUntil(() => host.site().ledgerId === m.ledgerId, { timeoutMs: 20000, label: 'the pinned page reported its ledger' });
        const refused = await host.call('file.request', { ih, name: 'handoff.bin', size, author: u.pub });
        assert(refused && refused.queued === false && refused.reason === 'unsigned', 'an unsigned page request: ' + JSON.stringify(refused));
        const q = host.files.request({ ih, name: 'handoff.bin', size, author: u.pub });
        assert(q && q.queued, 'queued ' + JSON.stringify(q));
        await host.files.decide(ih, 'accept', { by: 'e2e moderator' });
      });
      let lastItem = null;
      const kept = await step('the pin fetches it from PU, authenticates and sends a receipt: PU reads "Kept by the site" (E4), hand-off kept', () => waitUntil(async () => {
        const it = lastItem = await item(u.page, ih);
        return it && it.label === 'avail.keptBySite' && it.evidence && it.evidence.tier === 'E4' && it.handoff && it.handoff.state === 'kept' ? it : null;
      }, { timeoutMs: 55000, stepMs: 500, label: 'kept by the site' }).catch(async (err) => {
        // What the pin node said, and what the uploader shows, for the failure report.
        const host = pin.host();
        const stats = host && typeof host.stats === 'function' ? host.stats() : null;
        const pi = await pin.inspect();
        throw new StepError(err.message + '; PU item ' + JSON.stringify(lastItem && { label: lastItem.label, ev: lastItem.evidence, h: lastItem.handoff }) +
          '; pin stats ' + JSON.stringify(stats) + '; pinned page ' + JSON.stringify(pi && { pin: pi.pin, peers: pi.peers, ledger: pi.ledger, log: (pi.log || []).slice(-25) }) +
          '; pin log:\n    ' + pin.lines.slice(-12).join('\n    '));
      }));
      const ms = Date.now() - t0;
      await step('PU holds the receipt over an authenticated pin wire (its PinWire: a hello verified against _mw.cfg.pin, then rcpt)', async () => {
        const st = await shellState(u.page);
        assert(st && st.pin && st.pin.key === pinKey.pub, 'PU pin state ' + JSON.stringify(st && st.pin));
        assert(st.pin.wires >= 1 && st.pin.receipts >= 1, 'pin wires ' + st.pin.wires + ', receipts ' + st.pin.receipts);
        const pi = await pin.inspect();
        assert(pi && pi.pin && pi.pin.responder === true && pi.pin.pinPage === true, 'the pinned page is not the responder: ' + JSON.stringify(pi && pi.pin));
      });
      await step('code on the pinned page cannot make the node join a swarm nobody approved: __mwPinHost.start of another infohash is refused', async () => {
        const other = 'c'.repeat(40);
        const r = await pin.evaluate((x) => window.__mwPinHost.start({ ih: x, name: 'x', size: 1 }), other);
        assert(r === 'not-pinned', 'start of an unapproved infohash: ' + JSON.stringify(r));
        const again = await pin.evaluate((x) => window.__mwPinHost.start({ ih: x }), ih);
        assert(again === 'seeding', 'start of the approved one: ' + JSON.stringify(again));
      });
      const hb = await step('the signed heartbeat (pin-status.json in the web seed directory) lists the item, hashed, for this ledger', () => pin.waitForStatus((v) => v.ok && v.has(ih), 60000, { site: m.ledgerId }));
      const raw = readFileSync(pin.statusFile, 'utf8');
      assert(raw.indexOf(ih) < 0, 'the heartbeat names the infohash in the clear');
      return '5 MiB kept by the site ' + ms + ' ms after the approval (loopback; SZ target 60 s on Wi-Fi is a gate row), receipt tier ' + kept.evidence.tier + ', heartbeat ' + hb.count + ' item(s), age ' + Math.round(hb.age / 1000) + ' s';
    },
  };

  // ------------------------------------------------------------------------------------------- E-PS-2
  SC['E-PS-2'] = {
    title: 'lying bitfields stay "reported": peers that announce every piece of an upload they never fetched give E1 reported, never "Kept by the site"',
    async fn(ctx, step) {
      const { stack } = ctx;
      const m = await seedSite(ctx, step, 'liar');
      const u = await member(ctx, step, 'LU', m);
      const shared = await step('LU shares a 256 KiB file publicly (lane H)', () => share(u.page, 'claimed.bin', 256 * 1024));
      const ih = shared.ref;
      const srv = await liarServer(stack.dist);
      ctx.closers.push(() => srv.close());
      const liars = [];
      const addLiar = async (name) => {
        const v = await Visitor.open(ctx.browser, name, run, { serviceWorkers: 'block' });
        ctx.visitors.set(name, v);
        const p = await v.newPage();
        await p.goto(srv.url + 'liar.html?ih=' + ih + '&tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'load', timeout: 20000 });
        await waitUntil(async () => {
          const l = await p.evaluate(() => window.__liar || null);
          if (l && l.errors.length) throw new StepError(name + ': ' + l.errors[0]);
          return l && l.claimed > 0 ? l : null;
        }, { timeoutMs: 30000, label: name + ' announced every piece' });
        liars.push(p);
        return p;
      };
      await step('a liar peer joins the file swarm, takes the metadata and announces every piece (have), fetching nothing', () => addLiar('LIAR1'));
      const one = await step('LU: tier E1, reported, "Kept by you and at least 1 others online now (reported)", never kept by the site', () => waitUntil(async () => {
        const it = await item(u.page, ih);
        return it && it.evidence && it.evidence.tier === 'E1' ? it : null;
      }, { timeoutMs: 30000, label: 'E1 at LU' }));
      assert(one.evidence.reported === true, 'E1 must read reported: ' + JSON.stringify(one.evidence));
      assert(one.label === 'avail.heldBy' && one.labelParams && one.labelParams.n >= 1, 'label ' + one.label + ' ' + JSON.stringify(one.labelParams));
      assert(one.handoff && one.handoff.state !== 'kept', 'hand-off ' + JSON.stringify(one.handoff));
      await step('a second liar', () => addLiar('LIAR2'));
      const two = await step('LU: still E1 and reported with the higher count; the label never says "Kept by the site"', () => waitUntil(async () => {
        const it = await item(u.page, ih);
        return it && it.evidence && it.evidence.count >= 2 ? it : null;
      }, { timeoutMs: 30000, label: 'two reported holders' }));
      assert(two.evidence.tier === 'E1' && two.evidence.reported === true && two.label !== 'avail.keptBySite', 'two liars: ' + JSON.stringify({ ev: two.evidence, label: two.label }));
      for (const p of liars) {
        const got = await p.evaluate(() => ({ downloaded: window.__liarT.downloaded, have: window.__liarT.bitfield ? Array.from({ length: window.__liarT.pieces.length }, (_, i) => window.__liarT.bitfield.get(i)).filter(Boolean).length : 0 }));
        assert(got.downloaded === 0 && got.have === 0, 'a liar holds data after all: ' + JSON.stringify(got));
      }
      for (const name of ['LIAR1', 'LIAR2']) await ctx.closeVisitor(name);
      return 'E1 reported with 1 and ' + two.evidence.count + ' lying holders; label ' + two.label + ' {n: ' + two.labelParams.n + '}; hand-off "' + two.handoff.state + '" (two complete bitfields end H: the documented residual risk, spot-checks are v0.4)';
    },
  };

  // ------------------------------------------------------------------------------------------- E-PS-3
  SC['E-PS-3'] = {
    title: 'the month cap stops K and E, not H: at the desktop cap K and E stay locked and send nothing while an upload still goes out in H; "Sharing paused" shows',
    async fn(ctx, step) {
      const m = await seedSite(ctx, step, 'cap');
      const month = monthKeyOf(Date.now());
      const before = async (page) => {
        // The month record of this origin at the cap (the loader's pref store, cache.js 'mw-sites' / 'prefs'), then a reload.
        const origin = await page.evaluate(() => location.origin);
        await page.evaluate(([key, value]) => new Promise((resolve, reject) => {
          const r = indexedDB.open('mw-sites');
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result;
            const tx = db.transaction('prefs', 'readwrite');
            tx.objectStore('prefs').put(value, key);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => reject(tx.error);
          };
        }), ['seedMeters:' + origin, { v: 1, month, K: DESKTOP_MONTH_CAP, E: 0 }]);
        const t0 = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'CU: site after the reload' });
      };
      const u = await member(ctx, step, 'CU', m, { initScripts: [nonLocalStats], before });
      const locked = await step('CU: the month record is at the cap; K and E are locked, H is open; the bar says "Sharing paused"', () => waitUntil(async () => {
        const st = await shellState(u.page);
        const s = st && st.seeding;
        if (!s || !s.lanes || s.monthUsed < DESKTOP_MONTH_CAP) return null;
        return s.lanes.K.open === false && s.lanes.E.open === false && s.lanes.H.open === true ? s : null;
      }, { timeoutMs: 30000, label: 'K and E locked at the cap' }));
      const capLine = S['seed.monthUsed'].split('{cap}')[0].trim();
      await step('the month-cap line is on the bar', () => waitUntil(() => u.page.evaluate((t) => document.body.textContent.indexOf(t) >= 0, capLine), { timeoutMs: 20000, label: 'the "' + capLine + '" line' }));
      const shared = await step('CU shares a 512 KiB file publicly (lane H)', () => share(u.page, 'capped.bin', 512 * 1024));
      // Premoderation (code review v0.3, round 2): CU's key is new, so the owner accepts its listing offline (ledger-admin listed)
      // into the snapshot at cs=, which CD reads when it opens the site.
      await step('the owner accepts CU\'s listing offline (ledger-admin listed into the host\'s snapshot)', async () => {
        const file = join(m.outDir, 'genesis.json');
        const res = await acceptListing({ blocks: readBlocksFile(file), identity: await loadOwnerKey(ctx.stack.owner.file), ih: shared.ref, author: u.pub }); // MAL53-1: bound to the author
        writeBlocksFile(file, res.blocks);
      });
      const d = await member(ctx, step, 'CD', m, { initScripts: [nonLocalStats] });
      await step('CD fetches it (the offer card: Accept): every byte comes from CU, in lane H', async () => {
        const r = await withCards(d.page, async (ref) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { await mw.files.fetch(ref); } catch (e) { return { err: e.code || e.message }; }
          return { ok: true };
        }, shared.ref, [T.accept]);
        assert(r && r.ok, 'fetch ' + JSON.stringify(r));
      });
      const after = await step('CU sent the file in H (counted, the wires are not local) and nothing in K or E; the month figure did not grow', () => waitUntil(async () => {
        const st = await shellState(u.page);
        const s = st && st.seeding;
        return s && s.lanes && s.lanes.H.used >= 512 * 1024 ? s : null;
      }, { timeoutMs: 30000, label: 'H bytes at CU' }));
      assert(after.lanes.K.used === 0 && after.lanes.E.used === 0, 'K or E sent bytes at the cap: ' + JSON.stringify(after.lanes));
      assert(after.lanes.K.local === 0 && after.lanes.E.local === 0, 'K or E sent bytes on wires counted as local: ' + JSON.stringify(after.lanes));
      assert(after.lanes.K.open === false && after.lanes.E.open === false, 'K or E opened again: ' + JSON.stringify(after.lanes));
      assert(after.monthUsed === locked.monthUsed, 'the month figure moved: ' + locked.monthUsed + ' -> ' + after.monthUsed);
      return 'at ' + after.monthUsed + ' bytes this month: H sent ' + after.lanes.H.used + ' bytes, K and E 0 (locked)';
    },
  };

  // ------------------------------------------------------------------------------------------- E-PS-4
  SC['E-PS-4'] = {
    title: 'dock mode on a phone: the Wake Lock is taken inside the click, K and E open while it runs, "Stop" releases it and closes them',
    async fn(ctx, step) {
      const m = await seedSite(ctx, step, 'dock');
      const pw = await import('playwright');
      const devices = pw.devices || (pw.default && pw.default.devices) || {};
      const phone = devices['Pixel 7'] || { viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
      const contextOptions = { viewport: phone.viewport, userAgent: phone.userAgent, deviceScaleFactor: phone.deviceScaleFactor, isMobile: true, hasTouch: true };
      const v = await ctx.visitor('DK', { initScripts: [fakeBatteryAndWakeLock], contextOptions });
      const page = await v.newPage();
      await step('a phone (Pixel 7 emulation, on Wi-Fi by connection.type, charging at 90%) opens the site: K and E are 0 (phones share only after a choice)', async () => {
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(page, { timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, label: 'DK: site' });
        const st = await waitUntil(async () => { const x = await shellState(page); return x && x.seeding && x.seeding.rates ? x : null; }, { timeoutMs: 20000, label: 'DK budget' });
        assert(st.policyClass !== 'desktop', 'the phone context reads as ' + st.policyClass);
        assert(st.seeding.rates.K === 0 && st.seeding.rates.E === 0, 'phone rates before dock mode ' + JSON.stringify(st.seeding.rates));
        assert(st.seeding.dock && st.seeding.dock.on === false, 'dock ' + JSON.stringify(st.seeding.dock));
      });
      const started = await step('mw.net.dock({ hours: 2 }) from a click, then the card\'s "' + S['dock.start'] + '": the Wake Lock request leaves inside the click', async () => {
        const r = await withCards(page, async () => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { return await mw.net.dock({ hours: 2 }); } catch (e) { return { err: e.code || e.message }; }
        }, null, [S['dock.start']]);
        assert(r && r.on === true && !r.err, 'dock ' + JSON.stringify(r));
        const w = await page.evaluate(() => window.__mwDockE2E);
        assert(w.requests.length === 1 && w.requests[0].type === 'screen', 'wake lock requests ' + JSON.stringify(w.requests));
        assert(w.requests[0].active === true, 'the request left outside the click');
        assert(Math.abs(r.until - Date.now() - 2 * 3600000) < 120000, 'until ' + r.until);
        return r;
      });
      await step('while docked: K and E are open (dock mode is the opt-in), the dim page shows', async () => {
        const st = await waitUntil(async () => { const x = await shellState(page); return x && x.seeding && x.seeding.dock && x.seeding.dock.on && x.seeding.rates.K > 0 ? x : null; }, { timeoutMs: 15000, label: 'K open while docked' });
        assert(st.seeding.row === 'phoneCharging' && st.seeding.rates.E > 0, 'row 2 with E open: ' + JSON.stringify({ row: st.seeding.row, rates: st.seeding.rates }));
        assert(await page.locator('.mw-dock:not([hidden]) .mw-dock-stop').count() === 1, 'no dim page with a stop button');
      });
      await step('"' + S['dock.stop'] + '": the Wake Lock is released, dock mode ends (reason user), K and E close', async () => {
        await page.locator('.mw-dock-stop').click({ timeout: 10000 });
        await waitUntil(() => page.evaluate(() => window.__mwDockE2E.releases === 1 && window.__mwDockE2E.sentinels[0].released === true), { timeoutMs: 10000, label: 'the lock released' });
        const st = await waitUntil(async () => { const x = await shellState(page); return x && x.seeding && x.seeding.dock && x.seeding.dock.on === false ? x : null; }, { timeoutMs: 10000, label: 'dock off' });
        assert(st.seeding.dock.reason === 'user', 'reason ' + st.seeding.dock.reason);
        assert(st.seeding.rates.K === 0 && st.seeding.rates.E === 0, 'rates after dock mode ' + JSON.stringify(st.seeding.rates));
      });
      await ctx.closeVisitor('DK');
      return 'Wake Lock taken in the click (until ' + new Date(started.until).toISOString().slice(11, 16) + ' UTC), released by Stop; K and E followed dock mode';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ZS-1
  SC['E-ZS-1'] = {
    title: 'no DNS-over-HTTPS query for a nip.io name: the site at 127-0-0-1.nip.io renders from its page tag and the owner resolver stub hears nothing; a control name does reach it',
    async fn(ctx, step) {
      const NIP = '127-0-0-1.nip.io';
      const CONTROL = 'c2-zs-control.example.net';
      const stub = await dohStub();
      ctx.closers.push(() => stub.close());
      // The page must be a secure context (a Service Worker and WebCrypto): HTTPS with a certificate made here for the two names
      // and 127.0.0.1 (openssl, valid one day), which this browser accepts with --ignore-certificate-errors. Measured: this
      // Chromium build ignores --unsafely-treat-insecure-origin-as-secure, so plain http on these names stays insecure.
      const tls = await step('a self-signed certificate for ' + NIP + ', ' + CONTROL + ' and 127.0.0.1 (openssl, one day)', () => {
        const dir = join(ctx.stack.runDir, 'c2-tls');
        mkdirSync(dir, { recursive: true });
        const cert = join(dir, 'cert.pem');
        const key = join(dir, 'key.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
          '-subj', '/CN=' + NIP, '-addext', 'subjectAltName=DNS:' + NIP + ',DNS:' + CONTROL + ',IP:127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
        return { cert, key };
      });
      const zs = await seedSite(ctx, step, 'nip', { scope: NIP, doh: stub.url, tls });
      const control = await seedSite(ctx, step, 'control', { scope: CONTROL, doh: stub.url, tls });
      const browser = await step('a Chromium of its own: chromiumArgs() with ' + NIP + ' and ' + CONTROL + ' mapped to 127.0.0.1 in front of the local-only rule', async () => {
        const args = chromiumArgs({ allowRemote: false }).map((a) => (a.startsWith('--host-resolver-rules=')
          ? a.replace('--host-resolver-rules=', '--host-resolver-rules=MAP ' + NIP + ' 127.0.0.1, MAP ' + CONTROL + ' 127.0.0.1, ')
          : a));
        assert(args.some((a) => /^--host-resolver-rules=MAP 127-0-0-1\.nip\.io 127\.0\.0\.1, MAP c2-zs-control\.example\.net 127\.0\.0\.1, MAP \* ~NOTFOUND/.test(a)), 'resolver rule ' + args.find((a) => a.startsWith('--host-resolver-rules')));
        args.push('--allow-loopback-in-peer-connection', '--ignore-certificate-errors');
        const chromium = (await import('playwright')).chromium;
        const b = await chromium.launch({ headless: !headed, args });
        ctx.closers.push(() => b.close());
        return b;
      });
      const allowed = new Set(['127.0.0.1', NIP, CONTROL, 'localhost']);
      const open = async (name, site) => {
        const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, ignoreHTTPSErrors: true });
        ctx.closers.push(() => context.close());
        context.on('request', (req) => {
          let host = '';
          try { host = new URL(req.url()).hostname; } catch (_) { host = '?'; }
          if (!allowed.has(host) && !/^(data|blob|about|chrome-extension):/.test(req.url())) run.violation(name + ' requested ' + req.url());
        });
        await context.addInitScript(() => { const R = window.RTCPeerConnection; if (typeof R === 'function') { const W = function (c, ...r) { return new R(Object.assign({}, c || {}, { iceServers: [] }), ...r); }; W.prototype = R.prototype; Object.setPrototypeOf(W, R); window.RTCPeerConnection = W; } });
        // A lib.mjs Visitor around this context (its own request guard above), so a failing step prints its console and loader log.
        const v = new Visitor(name, context, run);
        context.on('page', (pg) => v._watch(pg));
        ctx.visitors.set(name, v);
        const page = await context.newPage();
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        try {
          await acceptConsent(page, { timeoutMs: 20000 });
        } catch (err) {
          if (process.env.MW_E2E_SHOTS) {
            await page.screenshot({ path: join(process.env.MW_E2E_SHOTS, 'zs-' + name + '.png') }).catch(() => {});
            const dump = await page.evaluate(() => ({ boot: window.__mwBoot || null, secure: window.isSecureContext, sw: !!navigator.serviceWorker, html: document.documentElement.outerHTML.slice(0, 1500) })).catch((e) => String(e));
            console.log('[shots] ' + name + ' ' + JSON.stringify(dump));
          }
          throw err;
        }
        await waitForSite(page, { timeoutMs: 30000, label: name + ': site' });
        return page;
      };
      const page = await step('a visitor opens ' + zs.url + ' and chooses "Share and load": the site renders from the page tag', async () => {
        const p = await open('ZS', zs);
        const st = await shellState(p);
        assert(st && st.pointerSource === 'meta' && st.signed === true, 'pointer ' + JSON.stringify(st && { source: st.pointerSource, signed: st.signed }));
        assert(st.ledgerId === zs.ledgerId, 'ledger ' + (st && st.ledgerId) + ' differs from publish ' + zs.ledgerId);
        return p;
      });
      await step('10 s later: the owner resolver stub got no query (no _magnet lookup for a nip.io name)', async () => {
        await sleep(10000);
        const mine = stub.queries.filter((q) => String(q.name || '').indexOf(NIP) >= 0);
        assert(mine.length === 0, 'DoH queries for ' + NIP + ': ' + JSON.stringify(mine));
        assert((await shellState(page)).mounted === true, 'the site is not mounted');
      });
      await step('control: the same browser at ' + CONTROL + ' (an ordinary name) asks the stub for _magnet.' + CONTROL, async () => {
        await open('ZC', control);
        await waitUntil(() => stub.queries.some((q) => q.name === '_magnet.' + CONTROL), { timeoutMs: 30000, label: 'a DoH query for the control name' });
      });
      const total = stub.queries.length;
      return 'no DoH query for ' + NIP + '; the control name made ' + total + ' (the stub would have seen one)';
    },
  };

  return SC;
}

export { StepError };
