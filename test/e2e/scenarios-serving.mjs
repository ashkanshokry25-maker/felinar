// test/e2e/scenarios-serving.mjs: the v0.2.1 end-to-end scenarios of the serving-publishing agent,
// registered by test/e2e/run.mjs (ids SW-* and PUBLISH-*). Local-only like everything in run.mjs:
// Chromium launched by lib.mjs with the resolver rules, every server on 127.0.0.1.
//
//   SW-INSTALL   D2 atomic install in Chromium: a new /mw-sw.js whose integrity for /_mw/loader.js does
//                not match what the host serves (a mixed deploy, a stale CDN copy) fails its install,
//                no half-filled cache is left, and the worker in control keeps its build; a consistent
//                new worker then installs and takes over; the site still renders.
//   PUBLISH-WS   B3 in Chromium: a cold start from a cross-origin web seed that answers every OPTIONS
//                with 405 (GitHub Pages) completes from the web seed with zero preflights, because the
//                patched bundle sends only Range; publish --verify-ws (seed mode, --allow-no-preflight)
//                passes that seed with the PASS-no-preflight verdict and fails a seed that ignores Range.

import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { StepError, waitForSite, siteInfo, waitUntil, isLocalUrl, ROOT, SITE_NAME } from './lib.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { checkWebseed } from '../../tools/check-webseed.mjs';
import { parseTorrentFile } from '../../src/common/torrent-file.js';

function assert(cond, message) {
  if (!cond) throw new StepError(message);
}

function sri(bytes) {
  return 'sha384-' + createHash('sha384').update(bytes).digest('base64');
}

/** Pings the worker that controls the page: { buildId, mode } or null. */
async function workerBuild(page) {
  return page.evaluate(() => new Promise((res) => {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) return res(null);
    const ch = new MessageChannel();
    const t = setTimeout(() => res(null), 3000);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      res(e.data && e.data.type === 'mw-pong' ? { buildId: e.data.buildId, mode: e.data.mode } : null);
    };
    c.postMessage({ proto: 1, type: 'mw-ping' }, [ch.port2]);
  }));
}

/** Asks the registration for an update and waits until no worker is installing or waiting. */
async function updateAndSettle(page, timeoutMs = 15000) {
  return page.evaluate(async (ms) => {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const out = { error: null, states: [] };
    if (!reg) return Object.assign(out, { error: 'no registration' });
    const watch = (w) => {
      if (!w) return;
      out.states.push(w.state);
      w.addEventListener('statechange', () => out.states.push(w.state));
    };
    reg.addEventListener('updatefound', () => watch(reg.installing));
    try {
      await reg.update();
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    const t0 = Date.now();
    while ((reg.installing || reg.waiting) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
    out.active = reg.active ? reg.active.scriptURL : null;
    out.installing = Boolean(reg.installing);
    out.waiting = Boolean(reg.waiting);
    out.caches = await caches.keys();
    return out;
  }, timeoutMs);
}

// A self-signed certificate for 127.0.0.1 (openssl, local only): the loader's CSP allows https: web
// seeds, and a cross-origin seed on plain http would be refused by the page's connect-src.
function selfSignedCert(dir) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'seed-key.pem');
  const cert = join(dir, 'seed-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// A static web seed on its own 127.0.0.1 ports (its own origins): OPTIONS answered 405 like GitHub
// Pages, GET with Access-Control-Allow-Origin: * and Range. Served over https (for the browser, with
// a self-signed certificate) and http (for the Node-side gate, which would refuse that certificate),
// one handler, one set of counters.
async function ghPagesLikeSeed(dir, { range = true, tls = null } = {}) {
  const root = resolve(dir);
  const seen = { options: 0, gets: 0, ranged: 0, cacheControl: 0, userAgentWebTorrent: 0 };
  const handler = (req, res) => {
    if (req.method === 'OPTIONS') {
      seen.options++;
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    seen.gets++;
    // The stock client sends Cache-Control: no-store as an author header (preflighted); with cache: 'no-store'
    // the browser itself adds Cache-Control: no-cache at the network layer, which is not preflighted.
    if (/no-store/i.test(String(req.headers['cache-control'] || ''))) seen.cacheControl++;
    if (/WebTorrent/i.test(String(req.headers['user-agent'] || ''))) seen.userAgentWebTorrent++;
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ws\//, '');
    } catch (_) {
      res.writeHead(400);
      return res.end();
    }
    const abs = resolve(join(root, ...rel.split('/')));
    if (!abs.startsWith(root + sep) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { 'access-control-allow-origin': '*' });
      return res.end();
    }
    const data = readFileSync(abs);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && range) {
      seen.ranged++;
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'access-control-allow-origin': '*', 'content-range': 'bytes ' + start + '-' + end + '/' + data.length, 'content-length': String(end - start + 1), 'content-type': 'application/octet-stream' });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-length': String(data.length), 'content-type': 'application/octet-stream' });
    return res.end(data);
  };
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const secure = tls ? https.createServer(tls, handler) : null;
  if (secure) await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  const closeOne = (s) => new Promise((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/',
    tlsUrl: secure ? 'https://127.0.0.1:' + secure.address().port + '/' : null,
    seen,
    close: async () => {
      await closeOne(server);
      if (secure) await closeOne(secure);
    },
  };
}

/** Run order of these scenarios in run.mjs (after scenario 9, before the PEER-* scenarios). */
export const SERVING_ORDER = Object.freeze(['SW-INSTALL', 'PUBLISH-WS']);

export function servingScenarios() {
  return {
    'SW-INSTALL': {
      title: 'atomic Service Worker install (D2): a mixed deploy fails its install and the worker in control keeps serving; a consistent update takes over',
      async fn(ctx, step) {
        const { stack } = ctx;
        await ctx.closeAll();
        const dist = stack.dist;
        const info = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
        const swText = readFileSync(join(dist, 'mw-sw.js'), 'utf8');
        assert(info.integrity && info.integrity['/_mw/loader.js'], 'build.json has no integrity for /_mw/loader.js');
        assert(swText.includes(info.integrity['/_mw/loader.js']), 'mw-sw.js does not embed the integrity map');
        assert(swText.includes(JSON.stringify(info.buildId)), 'mw-sw.js does not carry its build id');
        const variant = (buildId, loaderIntegrity) => {
          let t = swText.split(JSON.stringify(info.buildId)).join(JSON.stringify(buildId));
          if (loaderIntegrity) t = t.split(info.integrity['/_mw/loader.js']).join(loaderIntegrity);
          const file = join(stack.runDir, 'mw-sw-' + buildId + '.js');
          writeFileSync(file, t);
          return file;
        };
        const bad = variant('badbuild0001', sri(Buffer.from('a loader.js of another build')));
        const good = variant('goodbuild001', null);
        const v = await ctx.visitor('swinstall');
        const page = await v.newPage();
        try {
          await step('first visit: the worker of this build installs and renders the site', async () => {
            const t0 = Date.now();
            await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'SW-INSTALL first visit' });
          });
          const before = await step('the worker in control has the build of dist/', () => waitUntil(() => workerBuild(page), { timeoutMs: 15000, label: 'mw-pong' }));
          assert(before.buildId === info.buildId, 'build id ' + before.buildId + ', expected ' + info.buildId);

          stack.dev.override('/mw-sw.js', bad);
          const failed = await step('a new /mw-sw.js whose loader.js hash does not match the host: the install fails', () => updateAndSettle(page));
          assert(!failed.installing && !failed.waiting, 'a worker is still installing or waiting: ' + JSON.stringify(failed));
          assert(failed.caches.indexOf('mw-shell-badbuild0001') < 0, 'a half-filled cache of the failed install was left: ' + failed.caches.join(', '));
          assert(failed.states.indexOf('redundant') >= 0 || failed.states.length === 0, 'the new worker did not end redundant: ' + failed.states.join(' > '));
          const kept = await workerBuild(page);
          assert(kept && kept.buildId === info.buildId, 'the worker in control changed after a failed install: ' + JSON.stringify(kept));

          stack.dev.override('/mw-sw.js', good);
          const updated = await step('a consistent new worker installs, activates and takes control', async () => {
            const r = await updateAndSettle(page);
            const b = await waitUntil(async () => {
              const x = await workerBuild(page);
              return x && x.buildId === 'goodbuild001' ? x : null;
            }, { timeoutMs: 15000, label: 'new build in control' });
            return { r, b };
          });
          assert(updated.r.caches.indexOf('mw-shell-goodbuild001') >= 0, 'the new worker has no precache: ' + updated.r.caches.join(', '));
          await step('the site renders after a reload with the new worker', async () => {
            const t0 = Date.now();
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
            await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'SW-INSTALL after the update' });
          });
          return 'failed install left ' + info.buildId + ' in control (states ' + (failed.states.join('>') || 'none seen') + '); goodbuild001 took over';
        } finally {
          stack.dev.override('/mw-sw.js', null);
          await ctx.closeVisitor('swinstall');
        }
      },
    },

    'PUBLISH-WS': {
      title: 'patched web-seed requests (B3): a cold start from a cross-origin seed that answers OPTIONS with 405 completes with zero preflights; the gate reports it',
      async fn(ctx, step) {
        const { stack } = ctx;
        await ctx.closeAll();
        const outDir = join(stack.runDir, 'publish-ws');
        const seed = await ghPagesLikeSeed(outDir, { tls: selfSignedCert(join(stack.runDir, 'publish-ws-tls')) });
        const dev = await createDevServer({ root: stack.dist, port: 0, host: '127.0.0.1', dev: true, quiet: true });
        ctx.closers.push(() => seed.close());
        ctx.closers.push(() => dev.close());
        const pub = await step('publish the example with an https web seed on another origin (xs on the seed too)', () => publish({
          dir: join(ROOT, 'examples', 'peer-guestbook'), name: SITE_NAME, scope: '127.0.0.1', key: stack.owner.file, out: outDir,
          policy: 'open', bits: 4, tr: [stack.tracker.url], ws: [seed.tlsUrl + 'ws/'], xs: [seed.tlsUrl + 'ws/' + SITE_NAME + '.torrent'],
          exp: 30, quiet: true, cs: seed.tlsUrl + 'ws/genesis.json', ct: 'mailto:abuse@example.com',
        }));
        dev.setPointer(pub.pointer);
        const torrent = await parseTorrentFile(new Uint8Array(pub.torrentFile));
        const gate = await step('the verification gate: OPTIONS fails, the ranged GETs and the piece hashes pass', async () => {
          const strict = await checkWebseed({ wsBase: seed.url + 'ws/', torrent, origin: dev.url.replace(/\/$/, ''), timeoutMs: 5000 });
          const lax = await checkWebseed({ wsBase: seed.url + 'ws/', torrent, origin: dev.url.replace(/\/$/, ''), timeoutMs: 5000, allowNoPreflight: true });
          return { strict, lax };
        });
        assert(!gate.strict.ok && gate.strict.verdict === 'FAIL-cors', 'strict gate verdict ' + gate.strict.verdict);
        assert(gate.lax.ok && gate.lax.verdict === 'PASS-no-preflight', 'lax gate verdict ' + gate.lax.verdict + ' ' + JSON.stringify(gate.lax.results.filter((r) => !r.ok)).slice(0, 400));
        seed.seen.options = 0;
        seed.seen.gets = 0;
        seed.seen.ranged = 0;
        // A context of our own: it must accept the self-signed certificate of the seed. The same
        // network-policy guard as every visitor (lib.mjs): no request may leave 127.0.0.1.
        const context = await ctx.browser.newContext({ viewport: { width: 1100, height: 800 }, ignoreHTTPSErrors: true });
        const offHost = [];
        context.on('request', (req) => {
          if (!isLocalUrl(req.url())) offHost.push(req.url());
        });
        const page = await context.newPage();
        try {
          const rendered = await step('cold start (consent pending): the site renders from the cross-origin web seed', async () => {
            const t0 = Date.now();
            await page.goto(dev.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            return waitForSite(page, { timeoutMs: 40000, since: t0, label: 'PUBLISH-WS cold start' });
          });
          const sInfo = await step('mw.site.info(): source webseed', () => siteInfo(page));
          assert(sInfo.source === 'webseed', 'source is ' + sInfo.source);
          assert(seed.seen.ranged > 0, 'the seed saw no ranged GET');
          assert(seed.seen.options === 0, 'the seed saw ' + seed.seen.options + ' OPTIONS preflight(s): the request still carries a non-safelisted header');
          assert(seed.seen.cacheControl === 0 && seed.seen.userAgentWebTorrent === 0, 'a request carried the stock Cache-Control: no-store or the WebTorrent user-agent: ' + JSON.stringify(seed.seen));
          assert(offHost.length === 0, 'requests left 127.0.0.1: ' + offHost.slice(0, 3).join(', '));
          return 'rendered in ' + rendered.ms + ' ms from ' + seed.seen.ranged + ' ranged GETs, 0 preflights; gate: strict ' + gate.strict.verdict + ', --allow-no-preflight ' + gate.lax.verdict;
        } catch (err) {
          let state = null;
          try {
            state = await page.evaluate(() => (window.__mwShell ? window.__mwShell.inspect() : null));
          } catch (_) { /* closed */ }
          if (state && state.log) err.message += ' | loader log: ' + state.log.slice(-8).join(' / ');
          err.message += ' | seed saw ' + JSON.stringify(seed.seen);
          throw err;
        } finally {
          await context.close().catch(() => {});
        }
      },
    },
  };
}
