// test/e2e/peer-scenarios.mjs: the v0.2.1 network scenarios (DIGEST-AMENDMENTS B1, B2, B4, B5, C1), run by
// test/e2e/run.mjs as PEER-11, PEER-RV, PEER-BLIP, PEER-WS and PEER-CONSENT. Same rules as the rest of the
// suite (docs/DEV-NETWORK.md): Chromium with the local-only flags, every URL on 127.0.0.1, ICE servers
// stripped by the init script in test/e2e/lib.mjs.
//
//   PEER-11       a peer that declares a 0x7FFFFFFF-byte message (the largest length the stock parser buffers)
//                 is dropped within 1 s (ARCHITECTURE §12 test 11, v0.2.1 B5)
//   PEER-RV       visitors of two different site versions of one ledger meet in the rendezvous swarm
//                 (left: 1 announces) and exchange a guestbook post there (B2)
//   PEER-BLIP     a 2-second tracker outage: every visitor is back on the tracker within a few seconds (B1)
//   PEER-WS       a web seed that ignores Range is stopped after 3 failures; the copy comes from a peer and
//                 nothing more is asked of that host (B4)
//   PEER-CONSENT  the first-run card: nothing peer-to-peer before a choice, "Load from host only" keeps it
//                 that way, the versioned record is stored per origin, and "Share and load" starts peers (C1)

import { join } from 'node:path';
import { readFileSync, cpSync, writeFileSync, existsSync, statSync } from 'node:fs';

import { waitUntil, waitForSite, acceptConsent, clickShellButton, shellState, siteInfo, postMessage, guestbookEntries, sleep, createGate, SITE_NAME, ROOT, Visitor, StepError } from './lib.mjs';

import { STRINGS } from '../../src/loader/strings.js';
import { CONFIG } from '../../src/loader/config.js';
import { rendezvousInfoHash } from '../../src/loader/torrent.js';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';

/** A RegExp that matches exactly this label (Playwright hasText compares the button's whole text). */
const exactLabel = (label) => new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

/** ARCHITECTURE §12 test 11 (v0.2.1 B5): 0x7FFFFFFF, not "4 GiB". 0xFFFFFFFF and up are read as
 * keep-alives by the stock (signed) parser, so a test with them would not notice a broken cap. */
export const MALICIOUS_MESSAGE_LENGTH = 0x7FFFFFFF;

// A peer that joins the site's swarm with the vendored WebTorrent bundle and, once a wire is up, writes a
// length prefix of MALICIOUS_MESSAGE_LENGTH followed by 1 MiB of zeros straight onto the wire.
function evilPage(length) {
  return `<!doctype html><meta charset="utf-8"><title>evil peer</title>
<script type="module">
import WebTorrent from '/_mw/webtorrent.min.js';
const q = new URLSearchParams(location.search);
const L = ${length >>> 0};
const prefix = new Uint8Array([(L >>> 24) & 255, (L >>> 16) & 255, (L >>> 8) & 255, L & 255]);
window.__evil = { wires: 0, sent: [], closed: 0, errors: [] };
const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } }, dht: false, lsd: false, utPex: false, webSeeds: false });
client.on('error', (e) => window.__evil.errors.push(String(e && e.message || e)));
const t = client.add('magnet:?xt=urn:btih:' + q.get('btih'), { announce: [q.get('tr')], private: true });
t.on('wire', (wire) => {
  window.__evil.wires++;
  wire.once('close', () => { window.__evil.closed++; });
  setTimeout(() => {
    if (wire.destroyed) return;
    wire._push(prefix);
    for (let i = 0; i < 64; i++) wire._push(new Uint8Array(16384));
    window.__evil.sent.push({ at: Date.now(), peer: String(wire.peerId || '') });
  }, 400);
});
</script>`;
}

/** Records the announces a page sends (numwant, left, offers) from its WebSocket frames. */
function recordAnnounces(page) {
  const list = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const p = frame && frame.payload;
      if (typeof p !== 'string' || p.indexOf('"announce"') < 0) return;
      let m = null;
      try { m = JSON.parse(p); } catch (_) { return; }
      if (!m || m.action !== 'announce' || typeof m.info_hash !== 'string') return;
      let btih = '';
      for (let i = 0; i < m.info_hash.length; i++) btih += (m.info_hash.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
      list.push({ t: Date.now(), btih, event: m.event || 'update', numwant: m.numwant, left: m.left, offers: Array.isArray(m.offers) ? m.offers.length : 0, answer: !!m.answer });
    });
  });
  return list;
}

/** peerScenarios({ run, assert }) → { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function peerScenarios({ run, assert }) {
  const S = {};

  S['PEER-11'] = {
    title: 'a peer declaring a 0x7FFFFFFF-byte message is dropped (target 1 s); the visitor keeps working (B5)',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeAll();
      // The evil page is served by the gate (a real 127.0.0.1 response), not a Playwright route.fulfill:
      // a fulfilled body is in Chrome's "public" address space and its WebSocket to ws://127.0.0.1 is
      // blocked by Local Network Access, while a gate-served page is local like every loader page.
      const html = evilPage(MALICIOUS_MESSAGE_LENGTH);
      stack.gate.setRoute((req, res) => {
        const url = new URL(req.url, 'http://gate.invalid');
        if (url.pathname !== '/e2e-evil.html') return false;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return true;
      });
      try {
        const { page: victim } = await step('visitor V11 renders the site and shares it', () => ctx.openSite('V11'));
        await step('V11 announces the site', () => waitUntil(() => ctx.visitors.get('V11').announces.some((a) => a.btih === ctx.btih), { timeoutMs: 20000, label: 'V11 announced' }));
        const evil = await Visitor.open(ctx.browser, 'EVIL', run, { serviceWorkers: 'block' });
        ctx.visitors.set('EVIL', evil);
        const ep = await evil.newPage();
        const before = await shellState(victim);
        await step('the hostile peer joins the swarm and connects to V11', async () => {
          await ep.goto(ctx.origin + 'e2e-evil.html?btih=' + ctx.btih + '&tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'load', timeout: 20000 });
          await waitUntil(async () => {
            const e = await ep.evaluate(() => window.__evil || null);
            if (e && e.errors && e.errors.length) throw new StepError('evil peer error: ' + e.errors[0]);
            return e && e.wires > 0;
          }, { timeoutMs: 20000, label: 'hostile wire' });
        });
        const sent = await step('it writes the 0x7FFFFFFF length prefix', () => waitUntil(() => ep.evaluate(() => (window.__evil.sent[0] || null)), { timeoutMs: 10000, label: 'prefix sent' }));
        const dropped = await step('V11 drops the wire within 1 s, before buffering the message', async () => {
          const st = await waitUntil(async () => {
            const sx = await shellState(victim);
            return sx && sx.wireDrops > (before.wireDrops || 0) ? Object.assign({ at: Date.now() }, sx) : null;
          }, { timeoutMs: 5000, stepMs: 25, label: 'wire dropped' });
          const ms = st.at - sent.at;
          // Code review round 1 (F40): the 1 s target is reported; only 5 s fails the run (loaded runners).
          assert(ms < 5000, 'dropped after ' + ms + ' ms (target 1000 ms, bound 5000 ms)');
          assert(st.log.some((l) => /wire-message-too-long/.test(l)), 'no wire-message-too-long line in the loader log');
          await waitUntil(() => ep.evaluate(() => window.__evil.closed > 0), { timeoutMs: 5000, label: 'hostile wire closed' });
          return { ms, st };
        });
        await step('V11 still renders the site and keeps sharing', async () => {
          const sx = await shellState(victim);
          assert(sx.mounted, 'V11 lost its site frame');
          const info = await siteInfo(victim);
          assert(info.btih === ctx.btih, 'V11 site info ' + JSON.stringify(info));
        });
        await ctx.closeVisitor('EVIL');
        await ctx.closeVisitor('V11');
        return 'prefix 0x7FFFFFFF dropped ' + dropped.ms + ' ms after it was sent (target 1000 ms ' + (dropped.ms < 1000 ? 'met' : 'MISSED') + '); ' + dropped.st.wireDrops + ' wire(s) closed by the guard';
      } finally {
        stack.gate.setRoute(null);
      }
    },
  };

  S['PEER-RV'] = {
    title: 'two site versions of one ledger meet in the rendezvous swarm (left 1) and exchange a post there (B2)',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeAll();
      const rv = await rendezvousInfoHash(ctx.ledgerId);
      // A second host serving a changed copy of the site (another infohash) for the same owner and scope,
      // so the same ledger id: a stand-in for a visitor who still has the previous version open.
      const second = await step('publish a changed copy (another infohash, same ledger) on a second host', async () => {
        const outDir = join(stack.runDir, 'publish-rv');
        const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
        ctx.closers.push(() => dev.close());
        const gate = await createGate(dev.port);
        ctx.closers.push(() => gate.close());
        const dir = join(stack.runDir, 'example-rv');
        cpSync(join(ROOT, 'examples', 'peer-guestbook'), dir, { recursive: true });
        const about = JSON.parse(readFileSync(join(dir, 'data', 'about.json'), 'utf8'));
        about.version = '1.9.9-rv';
        writeFileSync(join(dir, 'data', 'about.json'), JSON.stringify(about, null, 2) + '\n');
        const pub = await publish({
          dir, name: SITE_NAME, scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
          tr: [stack.tracker.url], ws: [gate.url + 'ws/'], cs: gate.url + 'ws/genesis.json', moderator: [stack.moderator.pub],
          exp: 30, genesis: join(stack.outDir, 'genesis.json'), quiet: true, idp: stack.idp.url,
        });
        dev.setPointer(pub.pointer);
        return { pub, origin: gate.url };
      });
      assert(second.pub.btih !== ctx.btih, 'the copy has the same infohash');
      assert(second.pub.ledgerId === ctx.ledgerId, 'the copy has another ledger: ' + second.pub.ledgerId);
      const open = async (name, url) => {
        const v = await ctx.visitor(name);
        const page = await v.newPage();
        const announces = recordAnnounces(page);
        const t0 = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(page, { timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: name + ': site rendered' });
        return { page, announces, v };
      };
      const a = await step('R1 renders the published version', () => open('R1', ctx.origin));
      const b = await step('R2 renders the changed copy from the second host', () => open('R2', second.origin));
      const linked = await step('both join the rendezvous swarm (left 1) and connect there, with no common site swarm', async () => {
        const st = await waitUntil(async () => {
          const [s1, s2] = await Promise.all([shellState(a.page), shellState(b.page)]);
          return s1 && s2 && s1.rendezvous && s2.rendezvous && s1.rendezvous.wires > 0 && s2.rendezvous.wires > 0 ? [s1, s2] : null;
        }, { timeoutMs: 20000, label: 'rendezvous wires' });
        assert(st[0].rendezvous.infoHash === rv && st[1].rendezvous.infoHash === rv, 'rendezvous infohash ' + st[0].rendezvous.infoHash + ' / ' + st[1].rendezvous.infoHash);
        for (const [name, list] of [['R1', a.announces], ['R2', b.announces]]) {
          const ann = list.filter((x) => x.btih === rv && !x.answer);
          assert(ann.length > 0, name + ' sent no rendezvous announce');
          assert(ann.every((x) => x.left === 1), name + ' announced the rendezvous swarm with left ' + JSON.stringify(ann.map((x) => x.left)));
          assert(ann.every((x) => x.numwant >= 0 && x.numwant <= 3), name + ' rendezvous numwant ' + JSON.stringify(ann.map((x) => x.numwant)));
        }
        assert(!a.announces.some((x) => x.btih === second.pub.btih) && !b.announces.some((x) => x.btih === ctx.btih), 'a visitor announced the other version');
        return st;
      });
      const text = 'rendezvous ' + Date.now().toString(36);
      const seen = await step('R2 posts; R1 (another site version) shows the entry within 10 s', async () => {
        const t0 = Date.now();
        await postMessage(b.page, text);
        await waitUntil(async () => (await guestbookEntries(a.page)).some((e) => e.msg === text), { timeoutMs: 10000, label: 'entry on R1' });
        return Date.now() - t0;
      });
      await ctx.closeVisitor('R1');
      await ctx.closeVisitor('R2');
      return 'rendezvous ' + rv.slice(0, 12) + '... wires ' + linked[0].rendezvous.wires + '/' + linked[1].rendezvous.wires + ', every rendezvous announce left 1, post across versions in ' + seen + ' ms';
    },
  };

  S['PEER-BLIP'] = {
    title: 'the tracker drops every socket: the fast-reconnect shim brings both visitors back within seconds, not minutes (B1)',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeAll();
      await step('B1 renders and shares the site', () => ctx.openSite('B1'));
      await step('B2 renders and shares the site', () => ctx.openSite('B2'));
      const v1 = ctx.visitors.get('B1');
      const v2 = ctx.visitors.get('B2');
      // v0.2.1 (harden-verify): wait until both visitors announced BOTH swarms (the site and the ledger
      // rendezvous, joined after a 0 to 1.5 s jitter), so every announce after the drop is a re-announce and
      // not a first join. (The first version of this scenario dropped nothing: http.Server
      // .closeAllConnections() does not reach upgraded sockets, and it passed on the rendezvous joins.)
      const rv = await rendezvousInfoHash(ctx.ledgerId);
      const swarms = [ctx.btih, rv];
      await step('both announce, the site and the ledger rendezvous swarm', () => waitUntil(() => [v1, v2].every((v) => swarms.every((h) => v.announces.some((a) => a.btih === h))), { timeoutMs: 20000, label: 'announces' }));
      // Forcibly close every WebSocket the tracker holds (a Caddy reload, a deploy, a Cloudflare restart),
      // keeping the server listening. The stock client would wait 10 s x 2^n + U(0, 5 min); the shim reopens
      // in about a second.
      const dropAt = await step('the tracker drops every open connection (keeps listening)', async () => {
        const at = Date.now();
        const n = stack.tracker.dropConnections();
        assert(n >= 2, 'the tracker held ' + n + ' WebSocket(s), expected one per visitor');
        return at;
      });
      const back = await step('both visitors re-announce both swarms (target 6 s, bound 15 s)', async () => {
        try {
          // Each visitor's own frames after the drop prove both of its swarms re-announced (the site torrent
          // and the rendezvous share one pooled socket per page: B1 regression for the pool race).
          await waitUntil(() => [v1, v2].every((v) => swarms.every((h) => v.announces.some((a) => a.btih === h && a.t >= dropAt + 100))) &&
            new Set(stack.tracker.announces.filter((a) => a.t >= dropAt + 100).map((a) => a.peer)).size >= 2,
          { timeoutMs: 15000, stepMs: 50, label: 'both visitors re-announced both swarms (target 6 s, bound 15 s)' });
        } catch (err) {
          // Diagnostics: what each visitor's pages sent after the drop (client side) against what the
          // tracker processed.
          const since = (list) => list.filter((x) => x.t >= dropAt).map((x) => (x.t - dropAt) + 'ms ' + (x.btih ? x.btih.slice(0, 8) + ' ' : '') + (x.event || x.url || ''));
          const server = stack.tracker.announces.filter((a) => a.t >= dropAt).map((a) => (a.t - dropAt) + 'ms ' + a.event + ' ' + String(a.btih).slice(0, 8) + ' ' + String(a.peer).slice(0, 12));
          throw new StepError(err.message + '; B1 sent ' + JSON.stringify(since(v1.announces)) + ' over sockets ' + JSON.stringify(since(v1.sockets)) +
            '; B2 sent ' + JSON.stringify(since(v2.announces)) + ' over sockets ' + JSON.stringify(since(v2.sockets)) + '; tracker processed ' + JSON.stringify(server));
        }
        return Date.now() - dropAt;
      });
      await ctx.closeVisitor('B1');
      await ctx.closeVisitor('B2');
      return 'every socket dropped; both visitors re-announced both swarms ' + back + ' ms later (target 6000 ms ' + (back <= 6000 ? 'met' : 'MISSED') + '; stock client: 10 s x 2^n + up to 5 min)';
    },
  };

  S['PEER-WS'] = {
    title: 'a web seed that serves wrong bytes is stopped after 3 failures (no hot loop); the copy then comes from a peer (B4)',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeAll();
      await step('S renders and shares the site', () => ctx.openSite('S'));
      await step('S announces', () => waitUntil(() => ctx.visitors.get('S').announces.some((a) => a.btih === ctx.btih), { timeoutMs: 20000, label: 'S announced' }));
      // The host's web seed answers ranged GETs with a 206 of the right length but garbage bytes: the piece
      // buffers, its hash fails, and the stock client re-requests at once (23,240 requests in 4 s measured).
      // The 1-byte probe (bytes=0-0) still passes, so the web seed is accepted first.
      const hits = [];
      stack.gate.setRoute((req, res) => {
        const url = new URL(req.url, 'http://gate.invalid');
        if (req.method !== 'GET' || !url.pathname.startsWith('/ws/' + SITE_NAME + '/')) return false;
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (!range || (range[1] === '0' && range[2] === '0')) return false;
        const file = join(stack.outDir, decodeURIComponent(url.pathname.slice('/ws/'.length)));
        if (!existsSync(file) || !statSync(file).isFile()) return false;
        const total = statSync(file).size;
        const startB = Number(range[1]);
        const endB = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
        const len = Math.max(0, endB - startB + 1);
        hits.push(Date.now());
        res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': 'bytes ' + startB + '-' + endB + '/' + total, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        res.end(Buffer.alloc(len, 0x7a)); // right length, wrong bytes
        return true;
      });
      try {
        const w = await ctx.visitor('W');
        const page = await w.newPage();
        const t0 = Date.now();
        // No consent yet: peers wait, so the bad web seed is the only source and the breaker is forced.
        await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const tripped = await step('W: the web seed is stopped after wrong bytes, with a visible message and no hot loop', async () => {
          const st = await waitUntil(async () => { const sx = await shellState(page); return sx && sx.webseedBackoff && sx.webseedBackoff.length ? sx : null; }, { timeoutMs: 15000, label: 'web seed back-off' });
          await waitUntil(() => page.evaluate((needle) => document.body.textContent.indexOf(needle) >= 0, 'minutes'), { timeoutMs: 5000, label: 'back-off message' });
          const at = Date.now();
          await sleep(500);
          const count = hits.length;
          // One attempt at a piece is one ranged GET per file it spans (the stock web seed); the breaker trips
          // after failureLimit failed pieces, so a bound of (failureLimit + 1) x files per piece still catches a
          // hot loop (23,240 requests in 4 s without it). v0.3 reconciliation: the fixed 30 assumed the 0.2.1
          // guestbook (9 files in its one piece); the v0.3 one has 16 (members and profile pages, R 3.9).
          const perAttempt = Math.max(1, (stack.pub.files || []).length);
          const bound = (CONFIG.webseed.failureLimit + 1) * perAttempt;
          assert(count <= bound, count + ' web-seed requests before the breaker tripped (bound ' + bound + ': a hot loop?)');
          return { st, at, count };
        });
        await step('W: "Share and load", the copy comes from S, and nothing more is asked of the web seed', async () => {
          await acceptConsent(page, { timeoutMs: 20000 });
          await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'W rendered from a peer' });
          const info = await siteInfo(page);
          // 'mixed' is expected: the rejected garbage counts as web-seed bytes alongside the peer's good bytes.
          assert(info.source === 'peers' || info.source === 'mixed', 'W source ' + info.source);
          const after = hits.filter((t) => t > tripped.at + 200).length;
          assert(after === 0, after + ' web-seed requests after the back-off started');
        });
        return 'stopped after ' + tripped.count + ' wrong-byte requests (' + (stack.pub.files || []).length + ' files per piece attempt; none after the back-off, no hot loop); copy from a peer';
      } finally {
        stack.gate.setRoute(null);
        await ctx.closeVisitor('W');
        await ctx.closeVisitor('S');
      }
    },
  };

  S['PEER-CONSENT'] = {
    title: 'first-run card: no tracker, peer connection or probe before a choice; host only stays that way; the record is versioned (C1)',
    async fn(ctx, step) {
      await ctx.closeAll();
      const v = await ctx.visitor('C1');
      const page = await v.newPage();
      const t0 = Date.now();
      await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await step('the card shows both choices on one layer, and the site renders from its host meanwhile', async () => {
        await waitUntil(() => page.evaluate((labels) => {
          const box = document.querySelector('.mw-notice');
          if (!box || box.hidden) return false;
          const texts = Array.from(box.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
          return labels.every((l) => texts.includes(l));
        }, [STRINGS.consentShare, STRINGS.consentHostOnly]), { timeoutMs: 15000, label: 'first-run card' });
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'rendered before a choice' });
      });
      await step('2 s with the card open: no WebSocket, no RTCPeerConnection (no probe either)', async () => {
        await sleep(2000);
        const pcs = await page.evaluate(() => window.__mwE2EPc || 0);
        assert(!v.sockets.length, 'WebSocket before a choice: ' + v.sockets.map((s) => s.url).join(', '));
        assert(pcs === 0, pcs + ' RTCPeerConnection(s) before a choice');
      });
      await step('a script click on "Share and load" (isTrusted false) is ignored: still no choice, no socket (A4)', async () => {
        await page.evaluate((label) => Array.from(document.querySelectorAll('.mw-notice button')).find((b) => (b.textContent || '').trim() === label).click(), STRINGS.consentShare);
        await sleep(1000);
        const st = await shellState(page);
        assert(st.consent === 'pending', 'a script click gave consent: ' + st.consent);
        assert(!v.sockets.length, 'a script click opened ' + v.sockets.length + ' socket(s)');
        const card = await page.evaluate(() => { const b = document.querySelector('.mw-notice'); return !!(b && !b.hidden && b.querySelector('button')); });
        assert(card, 'the card disappeared after a script click');
      });
      await step('"Load from host only": still nothing peer-to-peer; the versioned record is stored', async () => {
        await clickShellButton(page, exactLabel(STRINGS.consentHostOnly), { scope: '.mw-notice button', timeoutMs: 5000 });
        await sleep(2500);
        const pcs = await page.evaluate(() => window.__mwE2EPc || 0);
        assert(!v.sockets.length && pcs === 0, 'host only opened ' + v.sockets.length + ' socket(s) and ' + pcs + ' peer connection(s)');
        const st = await shellState(page);
        assert(st.consent === 'host-only', 'consent ' + st.consent);
        const rec = st.consentRecord;
        assert(rec && rec.v === CONFIG.consent.version && rec.choice === 'host-only' && rec.dns === false && /^\d{4}-\d{2}-\d{2}$/.test(rec.day) && rec.scope === ctx.origin.replace(/\/$/, ''), 'record ' + JSON.stringify(rec));
      });
      await step('a reload keeps the choice: no card, still no peer connection', async () => {
        const r0 = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForSite(page, { timeoutMs: 30000, since: r0, label: 'reload' });
        await sleep(1500);
        const card = await page.evaluate(() => { const b = document.querySelector('.mw-notice'); return !!(b && !b.hidden); });
        assert(!card, 'the card came back after the choice');
        assert(!v.sockets.length, 'socket after reload');
      });
      const shared = await step('Settings, "Change your sharing choice", "Share and load": trackers, the probe and peers start', async () => {
        const at = Date.now();
        await page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === label); b.click(); }, STRINGS.settingsTitle);
        await clickShellButton(page, exactLabel(STRINGS.settingsConsentAgain), { timeoutMs: 5000 });
        await acceptConsent(page, { timeoutMs: 10000 });
        await waitUntil(() => v.sockets.length > 0, { timeoutMs: 10000, label: 'tracker socket' });
        const st = await waitUntil(async () => { const s = await shellState(page); return s && s.consent === 'accepted' && s.connectivity ? s : null; }, { timeoutMs: 10000, label: 'probe result' });
        assert(st.consentRecord.choice === 'accepted' && st.consentRecord.dns === true, 'record ' + JSON.stringify(st.consentRecord));
        assert(st.iceServers && st.iceServers.length >= 1, 'ICE servers ' + JSON.stringify(st.iceServers));
        return { ms: v.sockets[0].t - at, cls: st.connectivity.cls };
      });
      await ctx.closeVisitor('C1');
      return 'no socket or peer connection before a choice or with host only; record v' + CONFIG.consent.version + ' per origin; tracker ' + shared.ms + ' ms after "Share and load", probe class ' + shared.cls;
    },
  };

  return S;
}

export const PEER_ORDER = ['PEER-CONSENT', 'PEER-11', 'PEER-RV', 'PEER-BLIP', 'PEER-WS'];
