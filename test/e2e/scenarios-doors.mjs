// test/e2e/scenarios-doors.mjs: doors (docs/research/v03/S4-doors.md; ARCHITECTURE 15.15) through the real built loader on static
// "doors" (the run's build copied to small servers on 127.0.0.1 that answer Range with 206 and door.json with CORS), written by the
// C2 integrator from the doors lane's request 7 and its scratch flow probe (docs/deviations/doors.md).
//
//   DOOR-DOWN   a light link opened at door A: one reload into the limited-mode policy, the gate, the site in the door view
//               (a frame with sandbox="allow-scripts", origin "null"); A goes down: the reload renders the stored copy, the
//               probe fails and the banner offers door B (an owner door, org=); a click on it opens B, which loads the same ledger.
//   DOOR-HASH   owner doors B then C (org=, also in dr=); B serves a .torrent with one flipped byte: a loader-only door takes the
//               .torrent from C (checked by its infohash) and backs off from B.
//   DOOR-GUEST  a loader-only door (no copy of the site): the door view's frame cannot use storage or a worker, nothing tells the
//               door's worker to serve the site (current stays null), and mw.ready() in the frame resolves with the link's
//               ledger id (the SDK's hello from the sandboxed frame); a guest door (dr= only) and the loader-only door itself are
//               never asked for the site's .torrent or web seed bytes (code review v0.3, byteDoors); with --webkit also DOOR-GUEST-W.
//
// Code review v0.3 (round 2): only owner doors (org=), the last good door and the hosts of the record's ws= and xs= are asked for
// a site's bytes (src/loader/doors.js byteDoors); a guest door (dr=) or a hint serves the loader only and never learns which site
// the visitor opens. A full door that serves the site's copy is therefore listed in org= as well.
//
// Network policy (docs/DEV-NETWORK.md): every door is http://127.0.0.1:<port>; visitors are lib.mjs Visitors (request guard, ICE
// servers emptied); the site has no tracker (tr= is empty), so nothing peer-to-peer starts.

import http from 'node:http';
import { join, extname } from 'node:path';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';

import { Visitor, waitUntil, sleep, StepError, shellState, launchWebkit } from './lib.mjs';
import { publish } from '../../tools/publish.mjs';

export const DOORS_ORDER = ['DOOR-DOWN', 'DOOR-HASH', 'DOOR-GUEST'];
export const DOORS_WEBKIT_ORDER = ['DOOR-GUEST-W'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.torrent': 'application/x-bittorrent', '.wasm': 'application/wasm',
};

/** A static door: the build (and, for a full door, the site's web seed copy and .torrent); Range answered with 206, CORS open. */
function doorServer(root) {
  const log = [];
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://door.invalid').pathname); } catch (_) { res.writeHead(400); return res.end(); }
    log.push(req.method + ' ' + p + (req.headers.range ? ' ' + req.headers.range : ''));
    let file = join(root, p);
    if (!file.startsWith(root)) { res.writeHead(404); return res.end(); }
    if (p.endsWith('/')) file = join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (!p.startsWith('/_mw/') && !p.startsWith('/ws/') && p !== '/mw-sw.js') file = join(root, 'index.html'); // the shell for other paths
      else { res.writeHead(404, { 'access-control-allow-origin': '*' }); return res.end('not found'); }
    }
    const body = readFileSync(file);
    const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
    if (p === '/mw-sw.js' || p === '/_mw/door.json') headers['cache-control'] = 'no-cache';
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + body.length;
      res.writeHead(206, headers);
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return {
    log,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

const SITE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Door Flow</title><link rel="stylesheet" href="app.css"></head><body>' +
  '<h1 id="h">Hello from the door flow</h1><script type="module">import mw from "/_mw/sdk.js"; mw.ready().then((i) => { document.body.dataset.ledger = i.siteId || ""; ' +
  'document.body.dataset.mode = i.mode || ""; }, (e) => { document.body.dataset.err = (e && e.code) || "error"; });</script></body></html>';

/** doorsScenarios({ run, assert, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function doorsScenarios({ run, assert, headed = false }) {
  const S = {};

  /**
   * doors(ctx, step, key, plan) -> { ports, pub, link(door), close } where plan names each door 'full' (the site's copy and .torrent),
   * 'bad' (full, with one byte of its .torrent flipped) or 'loader' (the build only), and which doors the link lists in dr=.
   */
  async function doors(ctx, step, key, plan, { dr, wsDoor, org = [] }) {
    const { stack } = ctx;
    return step('doors ' + Object.entries(plan).map(([n, k]) => n + ' (' + k + ')').join(', ') + ' on 127.0.0.1; the site published in link mode with dr=' + dr.join(',') + (org.length ? ' and org=' + org.join(',') : ''), async () => {
      const base = join(stack.runDir, 'doors-' + key);
      const site = join(base, 'site');
      mkdirSync(site, { recursive: true });
      writeFileSync(join(site, 'index.html'), SITE_HTML);
      writeFileSync(join(site, 'app.css'), 'h1 { color: rgb(9, 8, 7) }');
      const servers = {};
      const ports = {};
      for (const name of Object.keys(plan)) {
        const root = join(base, 'door-' + name);
        mkdirSync(root, { recursive: true });
        servers[name] = doorServer(root);
        servers[name].root = root;
        ports[name] = await servers[name].listen();
        ctx.closers.push(() => servers[name].close());
      }
      const host = (n) => '127.0.0.1:' + ports[n];
      const out = join(base, 'out');
      const pub = await publish({
        dir: site, name: 'flow-' + key, scope: '127.0.0.1', key: stack.owner.file, chain: 'doorsflow-' + key, ws: ['http://' + host(wsDoor) + '/ws/'],
        tr: [], door: dr.map(host), org: org.map((n) => 'http://' + host(n)), out, quiet: true,
      });
      for (const [name, kind] of Object.entries(plan)) {
        const root = servers[name].root;
        cpSync(stack.dist, root, { recursive: true });
        if (kind === 'loader') continue;
        cpSync(join(out, 'flow-' + key), join(root, 'ws', 'flow-' + key), { recursive: true });
        mkdirSync(join(root, '_mw', 't'), { recursive: true });
        const torrent = Buffer.from(readFileSync(join(out, 'site.torrent')));
        if (kind === 'bad') torrent[Math.floor(torrent.length / 2)] ^= 0x01;
        writeFileSync(join(root, '_mw', 't', pub.btih + '.torrent'), torrent);
      }
      const fragment = pub.link.primary.split('#').slice(1).join('#');
      return {
        ports, pub, servers, host,
        link: (n) => 'http://' + host(n) + '/_mw/open.html#' + fragment,
        close: async (n) => { await servers[n].close(); },
      };
    });
  }

  async function doorsState(page) {
    const st = await shellState(page);
    return st && st.doors ? st : null;
  }

  async function clickButton(page, re, scope = 'button') {
    const b = page.locator(scope).filter({ hasText: re }).first();
    await b.waitFor({ state: 'visible', timeout: 20000 });
    await b.click({ timeout: 10000 });
  }

  /** Opens a light link: the one reload into the limited-mode policy, then the gate's Load, then the door view renders. */
  async function openLink(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitUntil(async () => {
      const g = await page.locator('button').filter({ hasText: /^Load$/ }).count().catch(() => 0);
      return g > 0;
    }, { timeoutMs: 30000, label: 'the door gate (Load)' });
    await clickButton(page, /^Load$/);
    return waitUntil(async () => { const st = await doorsState(page); return st && st.doors.rendered ? st : null; }, { timeoutMs: 30000, label: 'the door view rendered' });
  }

  function doorFrame(page) {
    return page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame()) || null;
  }

  // ------------------------------------------------------------------------------------------- DOOR-DOWN
  S['DOOR-DOWN'] = {
    title: 'a light link at door A: limited-mode reload, gate, the sandboxed door view; A goes down: the stored copy and a banner that opens door B, which loads the same ledger',
    async fn(ctx, step) {
      const d = await doors(ctx, step, 'down', { A: 'full', B: 'full' }, { dr: ['B'], org: ['B'], wsDoor: 'A' });
      const v = await ctx.visitor('DDN');
      const page = await v.newPage();
      const first = await step('open the link at A: one reload, Load, the site in the door view', () => openLink(page, d.link('A')));
      assert(first.mode === 'door' && first.ledgerId === d.pub.ledgerId, 'door A: ' + JSON.stringify({ mode: first.mode, ledgerId: first.ledgerId }));
      const frame = await step('the door view is a sandboxed frame with origin "null" that rendered the site (CSS applied)', async () => {
        const iframe = await page.locator('iframe.mw-door-frame').getAttribute('sandbox');
        assert(iframe === 'allow-scripts', 'sandbox="' + iframe + '"');
        const f = doorFrame(page);
        assert(f, 'no door frame');
        return waitUntil(() => f.evaluate(() => {
          const h = document.getElementById('h');
          return h ? { origin: String(window.origin), h1: h.textContent, color: getComputedStyle(h).color } : null;
        }).catch(() => null), { timeoutMs: 15000, label: 'the site in the door view' });
      });
      assert(frame.origin === 'null' && frame.h1 === 'Hello from the door flow' && frame.color === 'rgb(9, 8, 7)', 'frame ' + JSON.stringify(frame));
      await sleep(1500);
      await step('door A goes down; a reload renders the stored copy, the probe fails and the banner offers door B', async () => {
        await d.close('A');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        const st = await waitUntil(async () => { const x = await doorsState(page); return x && x.doors.banner ? x : null; }, { timeoutMs: 30000, label: 'the doors banner' });
        assert(st.doors.down === true && st.doors.banner.indexOf(d.host('B')) >= 0, 'banner ' + JSON.stringify({ down: st.doors.down, banner: st.doors.banner }));
      });
      const atB = await step('"Open at ' + d.host('B') + '" opens the link at door B; Load: the same ledger, its .torrent from B', async () => {
        await clickButton(page, new RegExp('Open at ' + d.host('B').replace(/[.]/g, '\\.')), '.mw-banner[data-id="doors"] button');
        await page.waitForURL((u) => String(u).startsWith('http://' + d.host('B') + '/_mw/open.html#'), { timeout: 15000 });
        await waitUntil(async () => (await page.locator('button').filter({ hasText: /^Load$/ }).count().catch(() => 0)) > 0, { timeoutMs: 30000, label: 'the gate at B' });
        await clickButton(page, /^Load$/);
        return waitUntil(async () => { const st = await doorsState(page); return st && st.doors.rendered ? st : null; }, { timeoutMs: 30000, label: 'rendered at B' });
      });
      assert(atB.ledgerId === d.pub.ledgerId, 'ledger at B ' + atB.ledgerId);
      assert(String(atB.doors.torrentFrom || '').indexOf(d.host('B')) >= 0, 'torrent from ' + atB.doors.torrentFrom);
      await ctx.closeVisitor('DDN');
      return 'rendered at A in a sandboxed frame (origin null), A down: banner -> B, same ledger ' + atB.ledgerId;
    },
  };

  // ------------------------------------------------------------------------------------------- DOOR-HASH
  S['DOOR-HASH'] = {
    title: 'dr= lists B then C; B serves a .torrent with a flipped byte: a loader-only door takes it from C (checked by its infohash) and backs off from B',
    async fn(ctx, step) {
      const d = await doors(ctx, step, 'hash', { L: 'loader', B: 'bad', C: 'full' }, { dr: ['B', 'C'], org: ['B', 'C'], wsDoor: 'C' });
      const v = await ctx.visitor('DHS');
      const page = await v.newPage();
      const st = await step('open the link at the loader-only door L: the .torrent from B fails its infohash, C\'s is used', () => openLink(page, d.link('L')));
      assert(st.ledgerId === d.pub.ledgerId, 'ledger ' + st.ledgerId);
      assert(String(st.doors.torrentFrom || '').indexOf(d.host('C')) >= 0, 'torrent from ' + st.doors.torrentFrom);
      const health = st.doors.health && st.doors.health[d.host('B')];
      assert(health && Number(health.until) > Date.now() && health.fail >= 1, 'B health ' + JSON.stringify(health));
      assert(d.servers.B.log.some((l) => l.indexOf('/_mw/t/' + d.pub.btih + '.torrent') >= 0), 'B was never asked for the .torrent');
      await ctx.closeVisitor('DHS');
      return '.torrent from ' + st.doors.torrentFrom + '; B backed off until +' + Math.round((health.until - Date.now()) / 1000) + ' s';
    },
  };

  async function guest(ctx, step, page, name) {
    const d = await doors(ctx, step, 'guest' + name, { G: 'loader', F: 'full', X: 'full' }, { dr: ['F', 'X'], wsDoor: 'F' });
    const st = await step(name + ': open the link at the loader-only door G (no copy of the site there)', () => openLink(page, d.link('G')));
    assert(st.ledgerId === d.pub.ledgerId && st.mode === 'door', 'door G ' + JSON.stringify({ mode: st.mode, ledgerId: st.ledgerId }));
    const inFrame = await step(name + ': in the door view, storage and a worker throw; mw.ready() resolves with the link\'s ledger id', async () => {
      const f = doorFrame(page);
      assert(f, 'no door frame');
      await waitUntil(() => f.evaluate(() => document.body && (document.body.dataset.ledger || document.body.dataset.err) ? true : null).catch(() => null), { timeoutMs: 20000, label: 'mw.ready() in the frame' });
      return f.evaluate(async () => {
        const r = { origin: String(window.origin), ledger: document.body.dataset.ledger || null, err: document.body.dataset.err || null };
        try { window.localStorage.setItem('x', '1'); r.storage = 'allowed'; } catch (e) { r.storage = e && e.name; }
        try { await navigator.serviceWorker.register('/mw-sw.js'); r.worker = 'registered'; } catch (e) { r.worker = (e && e.name) || 'refused'; }
        return r;
      });
    });
    assert(inFrame.origin === 'null' && inFrame.ledger === d.pub.ledgerId && !inFrame.err, 'frame ' + JSON.stringify(inFrame));
    assert(inFrame.storage !== 'allowed' && inFrame.worker !== 'registered', 'the door view used storage or a worker: ' + JSON.stringify(inFrame));
    const current = await step(name + ': nothing told door G\'s worker to serve the site (current stays null)', async () => {
      const sw = page.context().serviceWorkers ? page.context().serviceWorkers().find((w) => w.url().indexOf(d.host('G')) >= 0) : null;
      if (!sw) return 'no worker handle (WebKit)';
      const s = await sw.evaluate(() => (self.mw && self.mw.inspect ? self.mw.inspect() : null)).catch(() => null);
      assert(s && s.current === null, 'the door worker serves ' + JSON.stringify(s && s.current));
      return 'current null';
    });
    const asked = await step(name + ': the guest door X (dr= only, a full copy) and the loader-only door G were never asked for the site\'s .torrent or web seed bytes', async () => {
      const bytes = (log) => log.filter((l) => l.indexOf('/_mw/t/') >= 0 || l.indexOf('/ws/') >= 0);
      const x = bytes(d.servers.X.log);
      const g = bytes(d.servers.G.log);
      assert(x.length === 0 && g.length === 0, 'byte requests at a guest or loader-only door: ' + JSON.stringify({ X: x.slice(0, 4), G: g.slice(0, 4) }));
      assert(bytes(d.servers.F.log).length > 0, 'the ws= door F served nothing');
      return 'X 0, G 0, F ' + bytes(d.servers.F.log).length;
    });
    return 'frame origin null, storage ' + inFrame.storage + ', worker ' + inFrame.worker + ', mw.ready() ' + inFrame.ledger + ', ' + current + '; byte requests ' + asked;
  }

  // ------------------------------------------------------------------------------------------- DOOR-GUEST
  S['DOOR-GUEST'] = {
    title: 'a loader-only door: the door view cannot use storage or a worker, the door\'s worker never serves the site, mw.ready() in the frame has the link\'s ledger',
    async fn(ctx, step) {
      const v = await ctx.visitor('DGS');
      const page = await v.newPage();
      const r = await guest(ctx, step, page, 'Chromium');
      await ctx.closeVisitor('DGS');
      return r;
    },
  };

  S['DOOR-GUEST-W'] = {
    title: 'DOOR-GUEST in WebKit (every URL http://127.0.0.1)',
    async fn(ctx, step) {
      const b = await launchWebkit({ headless: !headed });
      if (!b) throw new StepError('Playwright WebKit is not installed');
      ctx.closers.push(() => b.close());
      const v = await Visitor.open(b, 'DGW', run, {});
      ctx.visitors.set('DGW', v);
      ctx.closers.push(() => v.close());
      const page = await v.newPage();
      return guest(ctx, step, page, 'WebKit');
    },
  };

  return S;
}

export { StepError };
