// test/e2e/scenarios-v03.mjs: v0.3 scenarios of docs/review/V03-DESIGN-REVIEW.md Part 4.2 for the lanes
// built so far (wave 1: idcore, ui, media; freeze, harden-loader and chat are covered by unit tests until
// chain-net, idp and sdk wire them). Run by test/e2e/run.mjs; same rules as the rest of the suite
// (docs/DEV-NETWORK.md): Chromium with the local-only flags, WebKit only on http://127.0.0.1 URLs, every
// request checked by the run's network-policy guard.
//
// Wave 1 has no identity origin (lane idp), no SDK wiring (lane sdk) and no swarm wiring for files and
// media, so several rows are PARTIAL here: the scenario says which half runs and which half waits.
//
//   E-SI-1   server-backed sign-in through the <mw-signin> element (a real mouse click, closed shadow
//            root, redress check), the fixture server and @felinar/verify: success and a session
//            cookie. PARTIAL: a stand-in signs instead of the identity origin (test/e2e/v03/signin-lab.js).
//   E-SI-2   replayed, foreign-origin and expired proofs refused (a foreign-origin proof burns no nonce)
//   E-SI-3   a local proof (mw-local) is refused by the server library
//   E-SI-4   two server instances sharing a nonce directory: a proof accepted at one is a replay at the other
//   E-SI-5   a loopback reverse proxy that rewrites the page: the proof carries the proxy origin and the
//            server refuses it. PARTIAL: a stand-in (lab.proofFor) signs the proxy origin by construction; E-SI-5W
//            (scenarios-dropin-v03.mjs) runs the row with the real identity origin's event.origin binding.
//   E-CH-6M  the media part of E-CH-6: host-only refuses media.upload with E_HOST_ONLY before any card or
//            request; the other gates in order (E_POLICY, E_NEEDS_GESTURE, E_NOT_SIGNED_IN)
//   E-MD-1   a 20 MiB MP4: the chunk store holds only ciphertext (no ftyp at any chunk start), the padded
//            total is the R 2.9.5 bucket, a poster is made, the own-index item is sealed (kind 3, 1,040
//            bytes, passes the freeze schema). PARTIAL: no swarm in wave 1, so "the wire" is not checked.
//   E-MD-2   playback through /_mw/media/<sid> with three seeks, each answered 206 by the worker, and
//            HAVE_CURRENT_DATA after each. PARTIAL: same profile; the device-linked second profile waits
//            for lane idp.
//   E-MD-10  an MP4 with moov at the end is rewritten at upload and its first frame needs no tail chunk
//   E-MD-7   (Chromium, DevTools protocol) the worker is stopped mid-playback; the next seek resumes after
//            the page registers the session again (mw-session-lost)
//   E-MD-8   no worker: the Blob fallback up to the cap; over the cap E_LIMIT
//   E-MD-9   a cross-origin page in the same profile that embeds the media URL gets a 404 from the host
//   E-FI-3   an HTML file (and 3b: an SVG with a script) through /_mw/f/<sid> downloads as an attachment and
//            never renders; 3c: without a worker the Blob is application/octet-stream. PARTIAL: the SDK half
//            of 3b and the limited-mode checks of 3c wait for lane sdk.
//   W-SI     (--webkit) E-SI-1 and the replay of E-SI-2 in WebKit
//   W-MD     (--webkit) E-MD-2 in WebKit: upload, play and seek through the worker route
//
// Not here yet (need lanes still building): E-HD-1 (chain-net), E-ID-* (idp), E-CH-* other than the media
// gate (sdk wiring of the chat lane), E-FI-1/2/4/5/6 and E-MD-3 to E-MD-6 (swarm wiring of the file and
// media lanes), E-SO-* (examples). docs/INTEGRATION-STATUS.md lists them.

import http from 'node:http';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { Visitor, launchWebkit, waitUntil, sleep, ROOT } from './lib.mjs';
import { startSigninServer } from '../fixtures/signin-server/server.mjs';
import { makeFixtures, hasFfmpeg } from '../fixtures/media/make-fixtures.mjs';
import { schemaOk } from '../../src/chain/state.js';
import { bucketBytes } from '../../src/media/pad.js';

export const V03_ORDER = ['E-SI-1', 'E-SI-2', 'E-SI-3', 'E-SI-4', 'E-SI-5', 'E-CH-6M', 'E-MD-1', 'E-MD-2', 'E-MD-10', 'E-MD-7', 'E-MD-8', 'E-MD-9', 'E-FI-3'];
export const V03_WEBKIT_ORDER = ['W-SI', 'W-MD'];

const LAB = join(ROOT, 'test', 'e2e', 'v03');

/**
 * copyLab(dir, files): the lab pages and the unbundled src/ modules they import. The whole of src/ is copied (about 3 MB): a
 * hand-written list of directories and loader files broke eight scenarios once when a lane module gained an import (C2-14; v0.3
 * code review), and a module the labs never load costs only the copy.
 */
function copyLab(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) cpSync(join(LAB, f), join(dir, f));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch (_) {
      resolve();
    }
  });
}

/**
 * A loopback reverse proxy that rewrites HTML on the way (a hostile "rewritten loader" in front of a site). Also used by E-SI-5W.
 * stats.posts records each POST it forwards ({ path, request: Buffer[], status, response: Buffer[], done }), so a scenario can read
 * the proof a page sent and the site's answer off the wire.
 */
export async function startRewritingProxy(targetUrl) {
  const target = new URL(targetUrl);
  const stats = { rewritten: 0, forwarded: 0, posts: [] };
  const server = http.createServer((req, res) => {
    stats.forwarded++;
    const post = req.method === 'POST' ? { path: req.url, request: [], status: 0, response: [], done: false } : null;
    if (post) {
      stats.posts.push(post);
      req.on('data', (c) => post.request.push(c));
    }
    const up = http.request({ hostname: '127.0.0.1', port: target.port, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: target.host }) }, (r) => {
      if (post) {
        post.status = r.statusCode;
        r.on('data', (c) => post.response.push(c));
        r.on('end', () => { post.done = true; });
      }
      const type = String(r.headers['content-type'] || '');
      if (type.startsWith('text/html')) {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          stats.rewritten++;
          const body = Buffer.concat(chunks).toString('utf8').replace('<head>', '<head><meta name="x-rewritten" content="e2e reverse proxy">');
          const h = Object.assign({}, r.headers);
          delete h['content-length'];
          res.writeHead(r.statusCode, h);
          res.end(body);
        });
      } else {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  const port = await listen(server);
  return { url: 'http://127.0.0.1:' + port, stats, close: () => closeServer(server) };
}

/** A one-page loopback server (another origin), for E-MD-9. */
async function startPageServer(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  const port = await listen(server);
  return { url: 'http://127.0.0.1:' + port + '/', close: () => closeServer(server) };
}

async function postProof(baseUrl, proof) {
  const r = await fetch(baseUrl + '/auth/mw/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof proof === 'string' ? proof : JSON.stringify(proof) });
  let body = null;
  try {
    body = await r.json();
  } catch (_) {
    body = null;
  }
  return { status: r.status, body };
}

/** Top-level MP4 box types of a file on disk. */
function topBoxes(file) {
  const buf = readFileSync(file);
  const out = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    let size = buf.readUInt32BE(o);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    if (size === 0) size = buf.length - o;
    if (size < 8) break;
    out.push(buf.toString('latin1', o + 4, o + 8));
    o += size;
  }
  return out;
}

/** v03Scenarios({ assert, run, webkit, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function v03Scenarios({ assert, run, headed = false }) {
  const S = {};

  // ------------------------------------------------------------------------------------------- sign-in
  async function signinSite(ctx, { nonceDir, origin } = {}) {
    if (!ctx.shared.siLab) {
      const dir = join(ctx.stack.runDir, 'signin-lab');
      copyLab(dir, ['signin-lab.html', 'signin-lab.js']);
      ctx.shared.siLab = dir;
    }
    const s = await startSigninServer({ port: 0, staticDir: ctx.shared.siLab, nonceDir, origin });
    ctx.closers.push(() => s.close());
    return s;
  }

  async function openLab(visitor, url) {
    const page = await visitor.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await waitUntil(() => page.evaluate(() => Boolean(window.mwSigninLab && window.mwSigninLab.ready)), { timeoutMs: 15000, label: 'sign-in lab loaded' });
    return page;
  }

  /** The visitor's own mouse click on the <mw-signin-lab> button (inside the element's closed shadow root). */
  async function clickSignin(page) {
    const box = await page.locator('mw-signin-lab').boundingBox();
    assert(box && box.width > 20 && box.height > 20, 'the sign-in element has no box: ' + JSON.stringify(box));
    await sleep(300); // past any minimum on-screen time
    await page.mouse.click(box.x + 16, box.y + 14);
  }

  async function signinFlow(page, site, step, label) {
    await step(label + 'a real mouse click on "Sign in with felinar": challenge, stand-in signature, the proof text posted, 200 and a session', async () => {
      await clickSignin(page);
      const ev = await waitUntil(() => page.evaluate(() => window.mwSigninLab.events.find((e) => e.state === 'signed-in' || e.state === 'error') || null), { timeoutMs: 15000, label: 'mw-signin event' });
      assert(ev.state === 'signed-in', 'the element reported ' + JSON.stringify(ev));
      assert(ev.status === 200 && ev.body && ev.body.ok === true, 'the server answered ' + JSON.stringify(ev));
      const pub = await page.evaluate(() => window.mwSigninLab.pub);
      assert(ev.body.pub === pub, 'verified key ' + ev.body.pub + ' is the signer ' + pub);
      assert(ev.body.keyMode === 'pairwise', 'keyMode ' + ev.body.keyMode);
      const calls = await page.evaluate(() => window.mwSigninLab.calls);
      assert(calls.length === 1, calls.length + ' identity calls');
      const keys = Object.keys(calls[0]).sort().join(',');
      assert(keys === 'challenge,purpose,want' && calls[0].purpose === 'server' && JSON.stringify(calls[0].want) === '["proof"]', 'the page asked the identity side for ' + JSON.stringify(calls[0]));
      assert(calls[0].challenge.statement === 'Sign in to Example Forum', 'statement ' + calls[0].challenge.statement);
      const sessions = Array.from(site.sessions.values());
      assert(sessions.length === 1 && sessions[0].pub === pub, 'server sessions ' + JSON.stringify(sessions));
      const cookies = await page.context().cookies(site.url);
      assert(cookies.some((c) => c.name === 'mw_session' && c.httpOnly), 'no HttpOnly mw_session cookie: ' + JSON.stringify(cookies.map((c) => c.name)));
      return ev;
    });
  }

  S['E-SI-1'] = {
    title: 'server-backed sign-in: <mw-signin> (real click, closed root), the fixture server and @felinar/verify; success and a session cookie (identity origin: stand-in)',
    async fn(ctx, step) {
      const site = await step('start the server-backed example site (fixture server, 127.0.0.1)', () => signinSite(ctx));
      const v = await ctx.visitor('SI');
      const page = await step('open the site page', () => openLab(v, site.url + '/signin-lab.html'));
      await signinFlow(page, site, step, '');
      ctx.shared.si = { site, page };
      return 'site ' + site.url + ', 1 session, the proof posted as text (integration I-2); identity origin: stand-in until lane idp lands';
    },
  };

  S['E-SI-2'] = {
    title: 'replayed, foreign-origin and expired proofs are refused by the server (a foreign-origin proof burns no nonce)',
    async fn(ctx, step) {
      const si = ctx.shared.si;
      assert(si, 'E-SI-1 did not run');
      const { site, page } = si;
      const replay = await step('a valid proof is accepted once; the same proof again is "replay"', async () => {
        const r = await page.evaluate(async () => {
          const lab = window.mwSigninLab;
          const ch = await lab.challenge();
          const proof = await lab.proofFor(ch);
          return [await lab.post(proof), await lab.post(proof)];
        });
        assert(r[0].status === 200 && r[0].body.ok === true, 'first ' + JSON.stringify(r[0]));
        assert(r[1].status === 401 && r[1].body.reason === 'replay', 'second ' + JSON.stringify(r[1]));
        return r[1].body.reason;
      });
      const foreign = await step('a proof for another origin is "origin"; the same nonce then signs in for this origin', async () => {
        const other = 'http://127.0.0.1:' + (Number(new URL(site.url).port) === 65535 ? 65534 : Number(new URL(site.url).port) + 1);
        const r = await page.evaluate(async (o) => {
          const lab = window.mwSigninLab;
          const ch = await lab.challenge();
          const bad = await lab.post(await lab.proofFor(ch, { origin: o }));
          const good = await lab.post(await lab.proofFor(ch));
          return { bad, good };
        }, other);
        assert(r.bad.status === 401 && r.bad.body.reason === 'origin', 'foreign ' + JSON.stringify(r.bad));
        assert(r.good.status === 200, 'the nonce was burned by the refused proof: ' + JSON.stringify(r.good));
        return r.bad.body.reason;
      });
      const expired = await step('a proof made 10 minutes ago is "expired"', async () => {
        const r = await page.evaluate(async () => {
          const lab = window.mwSigninLab;
          const ch = await lab.challenge();
          return lab.post(await lab.proofFor(ch, { now: Date.now() - 10 * 60 * 1000 }));
        });
        assert(r.status === 401 && r.body.reason === 'expired', 'expired ' + JSON.stringify(r));
        return r.body.reason;
      });
      return [replay, foreign, expired].join(', ');
    },
  };

  S['E-SI-3'] = {
    title: 'a local proof (mw-local, made by a page for itself) is refused by the server library',
    async fn(ctx, step) {
      const si = ctx.shared.si;
      assert(si, 'E-SI-1 did not run');
      const r = await step('post a local proof to the verifier', () => si.page.evaluate(async () => {
        const lab = window.mwSigninLab;
        return lab.post(await lab.localProof());
      }));
      assert(r.status === 401 && r.body.reason === 'version', 'local proof ' + JSON.stringify(r));
      return 'refused: ' + r.body.reason;
    },
  };

  S['E-SI-4'] = {
    title: 'two server instances with one shared nonce directory: a proof accepted at one is a replay at the other',
    async fn(ctx, step) {
      const nonceDir = join(ctx.stack.runDir, 'si-nonces');
      mkdirSync(nonceDir, { recursive: true });
      const a = await step('instance A (site origin = A) with the shared nonce directory', () => signinSite(ctx, { nonceDir }));
      const b = await step('instance B behind the same site origin, same directory', () => signinSite(ctx, { nonceDir, origin: a.origin }));
      const v = await ctx.visitor('SI4');
      const page = await step('open the site at A', () => openLab(v, a.url + '/signin-lab.html'));
      const proofs = await step('the page makes two proofs for two challenges issued by A', () => page.evaluate(async () => {
        const lab = window.mwSigninLab;
        return [await lab.proofFor(await lab.challenge()), await lab.proofFor(await lab.challenge())];
      }));
      await step('proof 1: accepted at A, "replay" at B', async () => {
        const atA = await postProof(a.url, proofs[0]);
        const atB = await postProof(b.url, proofs[0]);
        assert(atA.status === 200, 'A ' + JSON.stringify(atA));
        assert(atB.status === 401 && atB.body.reason === 'replay', 'B ' + JSON.stringify(atB));
      });
      await step('proof 2: accepted at B (a nonce A issued), "replay" at A', async () => {
        const atB = await postProof(b.url, proofs[1]);
        const atA = await postProof(a.url, proofs[1]);
        assert(atB.status === 200, 'B ' + JSON.stringify(atB));
        assert(atA.status === 401 && atA.body.reason === 'replay', 'A ' + JSON.stringify(atA));
      });
      await ctx.closeVisitor('SI4');
      return 'A ' + a.url + ' and B ' + b.url + ' share ' + nonceDir.split('/').slice(-2).join('/');
    },
  };

  S['E-SI-5'] = {
    title: 'a loopback reverse proxy rewrites the page: the proof carries the proxy origin and the server refuses it (identity origin binding: lane idp)',
    async fn(ctx, step) {
      const site = await step('the real site', () => signinSite(ctx));
      const proxy = await step('a rewriting reverse proxy in front of it (another loopback port)', async () => {
        const p = await startRewritingProxy(site.url);
        ctx.closers.push(() => p.close());
        return p;
      });
      const v = await ctx.visitor('SI5');
      const page = await step('open the site through the proxy: the page was rewritten on the way', async () => {
        const pg = await openLab(v, proxy.url + '/signin-lab.html');
        const mark = await pg.evaluate(() => { const m = document.querySelector('meta[name="x-rewritten"]'); return m && m.content; });
        assert(mark === 'e2e reverse proxy', 'the page did not come through the proxy');
        return pg;
      });
      const r = await step('the proof (origin = the proxy origin, as the identity origin would sign it) is refused with "origin"', () => page.evaluate(async () => {
        const lab = window.mwSigninLab;
        const ch = await lab.challenge();
        return lab.post(await lab.proofFor(ch));
      }));
      assert(r.status === 401 && r.body.reason === 'origin', 'through the proxy ' + JSON.stringify(r));
      assert(site.sessions.size === 0, 'the site minted a session');
      await ctx.closeVisitor('SI5');
      return 'refused: origin (' + proxy.stats.forwarded + ' requests forwarded, ' + proxy.stats.rewritten + ' pages rewritten)';
    },
  };

  // ------------------------------------------------------------------------------------------- media lab
  async function mediaSetup(ctx, step) {
    if (ctx.shared.md) return ctx.shared.md;
    assert(hasFfmpeg(), 'ffmpeg is not on PATH (needed for the media fixtures)');
    const { stack } = ctx;
    const labDir = join(stack.outDir, 'e2e-lab');
    const fxDir = join(stack.outDir, 'e2e-fx');
    const made = await step('fixtures from test/fixtures/media/make-fixtures.mjs (reference 20 MiB, moov at end) and a 20 MiB moov-at-end copy', async () => {
      const m = await makeFixtures(fxDir, { only: ['reference', 'moovAtEnd'] });
      const big = join(fxDir, 'reference-moov-end.mp4');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', m.reference, '-map', '0', '-c', 'copy', '-f', 'mp4', big], { stdio: ['ignore', 'ignore', 'pipe'] });
      return Object.assign(m, { bigMoovEnd: big });
    });
    copyLab(labDir, ['media-lab.html', 'media-lab.js']);
    const md = { labDir, fxDir, made, url: ctx.origin + 'ws/e2e-lab/media-lab.html', fx: (name) => '/ws/e2e-fx/' + name, responses: [] };
    ctx.shared.md = md;
    return md;
  }

  async function openMediaLab(ctx, visitor, md, { query = '' } = {}) {
    const page = await visitor.newPage();
    page.on('response', (r) => {
      const u = r.url();
      if (u.indexOf('/_mw/media/') >= 0 || u.indexOf('/_mw/f/') >= 0) {
        md.responses.push({ t: Date.now(), url: u, status: r.status(), sw: typeof r.fromServiceWorker === 'function' ? r.fromServiceWorker() : null, range: r.request().headers().range || null, page: page.url() });
      }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(md.url + query, { waitUntil: 'load', timeout: 20000 });
      const st = await waitUntil(() => page.evaluate(() => (window.mwMediaLab && window.mwMediaLab.ready ? window.mwLabState : null)), { timeoutMs: 20000, label: 'media lab loaded' });
      if (st.worker === 'controlled' || query.indexOf('worker=off') >= 0) return page;
      // The first registration may not claim this page: one reload brings it under the worker.
    }
    const st = await page.evaluate(() => window.mwLabState);
    assert(false, 'the media lab is not controlled by the worker: ' + JSON.stringify(st));
    return page;
  }

  S['E-CH-6M'] = {
    title: 'media part of E-CH-6: host-only refuses media.upload with E_HOST_ONLY before any card or request; then E_POLICY, E_NEEDS_GESTURE, E_NOT_SIGNED_IN',
    async fn(ctx, step) {
      const md = await mediaSetup(ctx, step);
      const v = await ctx.visitor('MD');
      const page = await step('open the media lab on the site origin under the product worker', () => openMediaLab(ctx, v, md));
      md.page = page;
      md.visitor = v;
      const codes = await step('host-only, media off, no gesture, signed out: each refused before the upload card', () => page.evaluate(async (fx) => {
        const lab = window.mwMediaLab;
        await lab.makeService('hostonly', { hostOnly: true });
        await lab.makeService('off', { cfg: { media: 'off' } });
        await lab.makeService('anon', { signedIn: false });
        await lab.makeService('main');
        const before = lab.prompts.length;
        const out = {
          hostOnly: (await lab.upload('hostonly', fx, 'clip.mp4')).error,
          policy: (await lab.upload('off', fx, 'clip.mp4')).error,
          gesture: (await lab.upload('main', fx, 'clip.mp4', 'video/mp4', {})).error,
          signedOut: (await lab.upload('anon', fx, 'clip.mp4')).error,
        };
        out.prompts = lab.prompts.length - before;
        out.appended = lab.appended.length;
        return out;
      }, md.fx('moov-at-end.mp4')));
      assert(codes.hostOnly === 'E_HOST_ONLY', 'host-only gave ' + codes.hostOnly);
      assert(codes.policy === 'E_POLICY', 'media off gave ' + codes.policy);
      assert(codes.gesture === 'E_NEEDS_GESTURE', 'no gesture gave ' + codes.gesture);
      assert(codes.signedOut === 'E_NOT_SIGNED_IN', 'signed out gave ' + codes.signedOut);
      assert(codes.prompts === 0, codes.prompts + ' cards were shown');
      assert(codes.appended === 0, codes.appended + ' ledger writes');
      assert(v.sockets.length === 0, 'a socket was opened: ' + v.sockets.map((s) => s.url).join(' '));
      return JSON.stringify(codes);
    },
  };

  S['E-MD-1'] = {
    title: 'a 20 MiB MP4 upload: only ciphertext in the chunk store, the padded total is the R 2.9.5 bucket, a poster, a sealed own-index item that passes the freeze schema (wire half: swarm wiring)',
    async fn(ctx, step) {
      const md = await mediaSetup(ctx, step);
      assert(md.page, 'E-CH-6M did not open the lab');
      const page = md.page;
      const up = await step('media.upload of the reference MP4 (20,971,520 bytes) with a click', () => page.evaluate(async (fx) => {
        const lab = window.mwMediaLab;
        const t0 = performance.now();
        const r = await lab.upload('main', fx, 'holiday.mp4');
        r.ms = Math.round(performance.now() - t0);
        r.prompts = lab.prompts.slice();
        return r;
      }, md.fx('reference.mp4')), 120000);
      assert(!up.error, 'upload failed: ' + JSON.stringify(up));
      assert(up.kind === 'video' && up.mime === 'video/mp4' && up.len === 20971520, 'upload result ' + JSON.stringify(up));
      assert(up.prompts.indexOf('media-upload') >= 0, 'no upload card: ' + up.prompts.join(','));
      md.id = up.id;
      const item = await page.evaluate((id) => window.mwMediaLab.item('main', id), up.id);
      const chunks = await step('every stored chunk is ciphertext of one piece; none starts with an ftyp box', () => page.evaluate((id) => window.mwMediaLab.chunks('main', id), up.id));
      assert(chunks.firstPlainFtyp === 1, 'the decrypted media does not start with ftyp (the check would be empty)');
      assert(chunks.ftypAtChunkStart === 0, chunks.ftypAtChunkStart + ' chunks start with an ftyp box');
      assert(chunks.stored === item.total && chunks.sizes.length === 1 && chunks.sizes[0] === item.P, 'chunks ' + JSON.stringify(chunks));
      const total = item.total * item.P;
      const unpadded = item.M.regions.media[1] * item.P; // poster and media chunks before the padding region
      assert(bucketBytes(unpadded) === total, 'the padded total ' + total + ' is not the bucket of ' + unpadded);
      if (item.M.plen <= item.P - 16) assert(total === 23068672, 'reference fixture: ' + total + ' bytes, R 2.9.5 says 23,068,672');
      const own = await step('the own-index item: sealed kind 3 in mw.s, 1,040 bytes of ciphertext, opens with K_own, passes schemaOk', () => page.evaluate(() => window.mwMediaLab.ownItem()));
      assert(own && own.kind === 3 && own.hasM && own.ctBytes === 1040, 'own item ' + JSON.stringify(own && { kind: own.kind, ct: own.ctBytes }));
      assert(schemaOk('mw.s', own.value) === true, 'the freeze reducer would hide the own-index item');
      assert(own.plen > 0 && own.pmime === 'image/jpeg', 'no poster: plen ' + own.plen + ' ' + own.pmime);
      return 'upload ' + up.ms + ' ms; ' + item.total + ' pieces of ' + item.P + ' = ' + total + ' bytes (bucket of ' + unpadded + '), poster ' + own.plen + ' bytes, ' + up.w + 'x' + up.h + ', own item sealed; no swarm in wave 1';
    },
  };

  S['E-MD-2'] = {
    title: 'playback through /_mw/media/<sid>: three seeks, each answered 206 by the worker, HAVE_CURRENT_DATA after each (same profile; device link: lane idp)',
    async fn(ctx, step) {
      const md = ctx.shared.md;
      assert(md && md.id, 'E-MD-1 did not upload');
      const page = md.page;
      const opened = await step('media.open gives an origin URL, never a key', () => page.evaluate((id) => window.mwMediaLab.call('main', 'media.open', { id }), md.id));
      assert(!opened.error && /^\/_mw\/media\/[0-9a-f]{32}$/.test(opened.url), 'open ' + JSON.stringify(opened));
      assert(!('fk' in opened) && JSON.stringify(opened).indexOf('"key"') < 0, 'open returned key material');
      md.mediaUrl = opened.url;
      const first = await step('the first frame', () => page.evaluate((u) => window.mwMediaLab.play(u), opened.url));
      assert(first.readyState >= 2 && first.duration > 5, 'first frame ' + JSON.stringify(first));
      const seeks = [];
      for (const frac of [0.85, 0.3, 0.6]) {
        const t = Math.round(first.duration * frac * 10) / 10;
        const before = md.responses.length;
        const readsBefore = await page.evaluate(() => window.mwMediaLab.chunkReads.length);
        const timingsBefore = (await page.evaluate((u) => window.mwMediaLab.timings(u), opened.url)).length;
        const r = await step('seek to ' + t + ' s', () => page.evaluate((x) => window.mwMediaLab.seek(x), t));
        await sleep(100); // response events arrive on the Node side a little later
        const fresh = md.responses.slice(before).filter((x) => x.url.indexOf(opened.url) >= 0);
        const reads = (await page.evaluate(() => window.mwMediaLab.chunkReads.length)) - readsBefore;
        const timings = (await page.evaluate((u) => window.mwMediaLab.timings(u), opened.url)).slice(timingsBefore);
        const diag = JSON.stringify({ responses: fresh.map((x) => [x.status, x.range, x.sw]), reads, timings, all: md.responses.length });
        assert(r.readyState >= 2, 'readyState ' + r.readyState + ' after the seek to ' + t + ' ' + diag);
        assert(reads > 0, 'the worker read no chunk for the seek to ' + t + ' (served from a buffer?) ' + diag);
        assert(fresh.some((x) => x.status === 206), 'no 206 for the seek to ' + t + ' ' + diag);
        assert(fresh.every((x) => x.status === 206 || x.status === 200), 'statuses ' + diag);
        seeks.push(t + ' s: ' + r.ms + ' ms, ' + fresh.filter((x) => x.status === 206).length + ' x 206' + (fresh.some((x) => x.sw === true) ? ' from the worker' : '') + ', ' + reads + ' chunks');
      }
      return 'first frame ' + first.firstFrameMs + ' ms (' + first.w + 'x' + first.h + ', ' + first.duration.toFixed(1) + ' s, preload metadata); ' + seeks.join('; ');
    },
  };

  S['E-MD-10'] = {
    title: 'an MP4 with moov at the end is rewritten at upload (faststart) and its first frame needs no tail chunk',
    async fn(ctx, step) {
      const md = ctx.shared.md;
      assert(md && md.page, 'E-CH-6M did not open the lab');
      const page = md.page;
      const before = topBoxes(md.made.bigMoovEnd);
      assert(before.indexOf('moov') > before.indexOf('mdat'), 'the fixture has moov first: ' + before.join(','));
      const up = await step('upload the 20 MiB moov-at-end copy', () => page.evaluate((fx) => window.mwMediaLab.upload('main', fx, 'tail.mp4'), md.fx('reference-moov-end.mp4')), 120000);
      assert(!up.error, 'upload ' + JSON.stringify(up));
      const head = await step('the stored media starts ftyp, moov', () => page.evaluate((id) => window.mwMediaLab.mediaHead('main', id), up.id));
      assert(head.boxes[0] === 'ftyp' && head.boxes.indexOf('moov') >= 0 && head.boxes.indexOf('moov') < head.boxes.indexOf('mdat'), 'boxes after upload ' + head.boxes.join(','));
      const item = await page.evaluate((id) => window.mwMediaLab.item('main', id), up.id);
      const opened = await page.evaluate((id) => window.mwMediaLab.call('main', 'media.open', { id }), up.id);
      md.tailUrl = opened.url;
      const t0 = await page.evaluate(() => performance.now());
      const first = await step('the first frame', () => page.evaluate((u) => window.mwMediaLab.play(u), opened.url));
      const reads = await page.evaluate(({ id, t }) => window.mwMediaLab.chunkReads.filter((r) => r.id === id && r.t >= t), { id: up.id, t: t0 });
      const lastMedia = item.M.regions.media[1] - 1;
      const tail = reads.filter((r) => r.i >= lastMedia - 1).map((r) => r.i);
      assert(first.readyState >= 2, 'no first frame');
      assert(tail.length === 0, 'the first frame needed tail chunks ' + JSON.stringify(tail) + ' of ' + lastMedia);
      return 'fixture ' + before.join(',') + ' -> ' + head.boxes.join(',') + '; first frame after ' + reads.length + ' chunk reads, highest ' + Math.max(...reads.map((r) => r.i)) + ' of ' + lastMedia;
    },
  };

  S['E-MD-7'] = {
    title: '(Chromium, DevTools protocol) the worker is stopped mid-playback; the next seek plays after the page registers the session again',
    async fn(ctx, step) {
      const md = ctx.shared.md;
      assert(md && md.tailUrl, 'E-MD-10 did not open its item');
      const page = md.page;
      // The E-MD-10 item: only its first frame was ever fetched, so a seek far away needs the worker.
      await step('play the E-MD-10 item from the start', () => page.evaluate((u) => window.mwMediaLab.play(u), md.tailUrl));
      const swStats = async () => {
        const w = page.context().serviceWorkers()[0];
        if (!w) return null;
        try {
          return await w.evaluate(() => (self.mw && self.mw.inspect ? self.mw.inspect().media : null));
        } catch (_) {
          return null;
        }
      };
      const statsBefore = await swStats();
      const states = await step('stop every Service Worker through the DevTools protocol', async () => {
        const cdp = await page.context().newCDPSession(page);
        const seen = [];
        cdp.on('ServiceWorker.workerVersionUpdated', (e) => { for (const x of e.versions) seen.push(x.runningStatus); });
        await cdp.send('ServiceWorker.enable');
        await sleep(200);
        await cdp.send('ServiceWorker.stopAllWorkers');
        await waitUntil(() => seen.indexOf('stopped') >= 0, { timeoutMs: 5000, label: 'the worker stopped' });
        await cdp.detach().catch(() => {});
        return seen;
      });
      const lostBefore = await page.evaluate(() => window.mwMediaLab.swMessages.filter((m) => m === 'mw-session-lost').length);
      const readsBefore = await page.evaluate(() => window.mwMediaLab.chunkReads.length);
      const r = await step('seek: the restarted worker asks for the session, the page registers it again, the seek completes', async () => {
        const res = await page.evaluate(() => window.mwMediaLab.seek(Math.round(window.mwMediaLab.video.duration * 0.7)));
        return res;
      });
      const lost = (await page.evaluate(() => window.mwMediaLab.swMessages.filter((m) => m === 'mw-session-lost').length)) - lostBefore;
      const reads = (await page.evaluate(() => window.mwMediaLab.chunkReads.length)) - readsBefore;
      const statsAfter = await swStats();
      const diag = JSON.stringify({ states, statsBefore, statsAfter, lost, reads });
      assert(r.readyState >= 2, 'readyState ' + r.readyState + ' ' + diag);
      assert(reads > 0, 'the seek was served without the worker reading a chunk ' + diag);
      assert(lost >= 1, 'the worker never said mw-session-lost ' + diag);
      return 'resumed after ' + r.ms + ' ms (' + lost + ' mw-session-lost, ' + reads + ' chunks read after the restart)';
    },
  };

  S['E-MD-8'] = {
    title: 'no worker: the Blob fallback plays up to the cap ("Played from memory"); over the cap E_LIMIT',
    async fn(ctx, step) {
      const md = ctx.shared.md;
      assert(md && md.page, 'E-CH-6M did not open the lab');
      const page = md.page;
      const blob = await step('a service without the worker: open gives a blob: URL and the note, and it plays', () => page.evaluate(async (fx) => {
        const lab = window.mwMediaLab;
        await lab.makeService('noworker', { worker: false });
        const up = await lab.upload('noworker', fx, 'small.mp4');
        if (up.error) return up;
        const o = await lab.call('noworker', 'media.open', { id: up.id });
        if (o.error) return o;
        const p = await lab.play(o.url);
        return { url: o.url.slice(0, 5), note: o.note, readyState: p.readyState };
      }, md.fx('moov-at-end.mp4')));
      assert(!blob.error && blob.url === 'blob:' && blob.readyState >= 2, 'blob path ' + JSON.stringify(blob));
      assert(blob.note === 'Played from memory on this browser.', 'note ' + blob.note);
      const over = await step('a 16 KiB cap: E_LIMIT', () => page.evaluate(async (fx) => {
        const lab = window.mwMediaLab;
        await lab.makeService('tiny', { worker: false, capBytes: 16384 });
        const up = await lab.upload('tiny', fx, 'small.mp4');
        if (up.error) return up;
        return lab.call('tiny', 'media.open', { id: up.id });
      }, md.fx('moov-at-end.mp4')));
      assert(over.error === 'E_LIMIT', 'over the cap ' + JSON.stringify(over));
      return 'blob mode plays (' + blob.note + '); over the cap: ' + over.error;
    },
  };

  S['E-MD-9'] = {
    title: 'a cross-origin page in the same profile that embeds the media URL gets a 404 from the host, not the stream',
    async fn(ctx, step) {
      const md = ctx.shared.md;
      assert(md && md.mediaUrl, 'E-MD-2 did not open the media');
      const target = ctx.origin.replace(/\/$/, '') + md.mediaUrl;
      const host = await step('another loopback origin serves a page with <video src> pointing at the media URL', async () => {
        const h = await startPageServer('<!doctype html><meta charset="utf-8"><title>other site</title><video id="v" muted src="' + target + '"></video><script>window.r=null;const v=document.getElementById("v");v.onerror=()=>{window.r="error "+(v.error&&v.error.code)};v.onloadeddata=()=>{window.r="played"};fetch(' + JSON.stringify(target) + ',{mode:"no-cors"}).then((x)=>{window.f=x.type+" "+x.status},(e)=>{window.f="fetch error"})</script>');
        ctx.closers.push(() => h.close());
        return h;
      });
      const before = md.responses.length;
      const page = await md.visitor.newPage();
      page.on('response', (r) => { if (r.url() === target) md.responses.push({ t: Date.now(), url: r.url(), status: r.status(), sw: r.fromServiceWorker(), page: 'other' }); });
      await page.goto(host.url, { waitUntil: 'load', timeout: 20000 });
      const res = await step('the video errors; the media request was answered by the host with 404', () => waitUntil(() => page.evaluate(() => window.r), { timeoutMs: 15000, label: 'video settled' }));
      assert(/^error/.test(res), 'the other origin played the media: ' + res);
      const seen = md.responses.slice(before).filter((x) => x.page === 'other');
      assert(seen.length > 0 && seen.every((x) => x.status === 404 && !x.sw), 'answers to the other origin ' + JSON.stringify(seen));
      const direct = await fetch(target);
      assert(direct.status === 404, 'the host answered ' + direct.status);
      await page.close();
      return res + '; ' + seen.length + ' request(s), 404 from the host; the stream stays with its own origin';
    },
  };

  S['E-FI-3'] = {
    title: 'HTML (3) and SVG with a script (3b) through /_mw/f/<sid> download as attachments and never render; without a worker the Blob is octet-stream (3c)',
    async fn(ctx, step) {
      const md = ctx.shared.md;
      assert(md && md.page, 'E-CH-6M did not open the lab');
      const page = md.page;
      const files = [
        { name: 'page.html', text: '<!doctype html><title>ran</title><script>document.title="script ran";parent.postMessage("x","*")</script><h1>hello</h1>' },
        { name: 'logo.svg', text: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>document.title="script ran"</script><rect width="10" height="10"/></svg>' },
      ];
      const notes = [];
      for (const f of files) {
        const s = await step(f.name + ': a file session, then GET /_mw/f/<sid> headers', () => page.evaluate(async (x) => {
          const lab = window.mwMediaLab;
          const r = await lab.fileSession(x.name, x.text);
          return Object.assign({ url: r.url, mode: r.mode }, await lab.get(r.url));
        }, f));
        assert(s.mode === 'worker' && /^\/_mw\/f\/[0-9a-f]{32}$/.test(s.url), 'session ' + JSON.stringify(s));
        assert(s.status === 200, f.name + ' status ' + s.status);
        assert(s.headers['content-type'] === 'application/octet-stream', f.name + ' type ' + s.headers['content-type']);
        assert(/^attachment; filename\*=UTF-8''/.test(s.headers['content-disposition'] || ''), f.name + ' disposition ' + s.headers['content-disposition']);
        assert(s.headers['x-content-type-options'] === 'nosniff', f.name + ' nosniff');
        assert(/sandbox/.test(s.headers['content-security-policy'] || ''), f.name + ' csp ' + s.headers['content-security-policy']);
        assert(s.text === f.text, f.name + ' body differs');
        const dl = await step(f.name + ': opening the URL in a tab downloads it and renders nothing', async () => {
          const tab = await md.visitor.newPage();
          try {
            const [download] = await Promise.all([
              tab.waitForEvent('download', { timeout: 15000 }),
              tab.goto(ctx.origin.replace(/\/$/, '') + s.url).catch(() => null),
            ]);
            const path = await download.path();
            const body = path ? readFileSync(path, 'utf8') : null;
            const title = await tab.title().catch(() => '');
            return { name: download.suggestedFilename(), same: body === f.text, title };
          } finally {
            await tab.close().catch(() => {});
          }
        });
        assert(dl.name === f.name && dl.same, f.name + ' download ' + JSON.stringify(dl));
        assert(dl.title !== 'script ran', f.name + ' rendered and ran its script');
        notes.push(f.name + ' downloaded as ' + dl.name);
      }
      const c = await step('3c: without a worker the session is a Blob typed application/octet-stream', () => page.evaluate(async () => {
        const lab = window.mwMediaLab;
        const r = await lab.fileSession('page.html', '<h1>x</h1>', { worker: false });
        return { mode: r.mode, scheme: r.url.slice(0, 5), type: await lab.blobType(r.url) };
      }));
      assert(c.mode === 'blob' && c.scheme === 'blob:' && c.type === 'application/octet-stream', '3c ' + JSON.stringify(c));
      return notes.join('; ') + '; 3c Blob ' + c.type + ' (the SDK half of 3b/3c waits for lane sdk)';
    },
  };

  // ------------------------------------------------------------------------------------------- WebKit
  S['W-SI'] = {
    title: 'WebKit (127.0.0.1 only): E-SI-1 through <mw-signin> and the replay of E-SI-2',
    async fn(ctx, step) {
      const webkit = await step('launch Playwright WebKit', () => launchWebkit({ headless: !headed }));
      assert(webkit, 'Playwright WebKit is not installed (npx playwright install webkit)');
      try {
        const site = await step('a fresh server-backed site', () => signinSite(ctx));
        const v = await Visitor.open(webkit, 'webkit-si', run);
        const page = await step('open the site page in WebKit', () => openLab(v, site.url + '/signin-lab.html'));
        await signinFlow(page, site, step, 'WebKit: ');
        const r = await step('WebKit: the same proof twice: 200, then replay', () => page.evaluate(async () => {
          const lab = window.mwSigninLab;
          const proof = await lab.proofFor(await lab.challenge());
          return [await lab.post(proof), await lab.post(proof)];
        }));
        assert(r[0].status === 200 && r[1].body && r[1].body.reason === 'replay', 'WebKit replay ' + JSON.stringify(r));
        await v.close();
        return 'WebKit ' + webkit.version() + ': signed in through the element, replay refused';
      } finally {
        await webkit.close().catch(() => {});
      }
    },
  };

  S['W-MD'] = {
    title: 'WebKit (127.0.0.1 only): E-MD-2: upload the reference MP4, play it through /_mw/media/<sid> and seek three times',
    async fn(ctx, step) {
      const md = await mediaSetup(ctx, step);
      const webkit = await step('launch Playwright WebKit', () => launchWebkit({ headless: !headed }));
      assert(webkit, 'Playwright WebKit is not installed (npx playwright install webkit)');
      try {
        const v = await Visitor.open(webkit, 'webkit-md', run);
        const page = await step('open the media lab in WebKit under the product worker', () => openMediaLab(ctx, v, md));
        const up = await step('upload the reference MP4', () => page.evaluate(async (fx) => {
          const lab = window.mwMediaLab;
          await lab.makeService('main');
          return lab.upload('main', fx, 'holiday.mp4');
        }, md.fx('reference.mp4')), 120000);
        assert(!up.error, 'WebKit upload ' + JSON.stringify(up));
        const opened = await page.evaluate((id) => window.mwMediaLab.call('main', 'media.open', { id }), up.id);
        assert(!opened.error, 'open ' + JSON.stringify(opened));
        // WebKit with preload="metadata" stops at HAVE_METADATA and fires no loadeddata until play or a seek, so the
        // WebKit run uses preload="auto" and reports the worker's answers instead of requiring one per seek.
        const before = md.responses.length;
        const first = await step('WebKit: the first frame through the worker route (preload auto)', () => page.evaluate((u) => window.mwMediaLab.play(u, { preload: 'auto' }), opened.url));
        const seeks = [];
        for (const frac of [0.85, 0.3, 0.6]) {
          const t = Math.round(first.duration * frac * 10) / 10;
          const r = await step('WebKit: seek to ' + t + ' s', () => page.evaluate((x) => window.mwMediaLab.seek(x), t));
          assert(r.readyState >= 2, 'readyState ' + r.readyState);
          seeks.push(t + ' s ' + r.ms + ' ms');
        }
        const answers = md.responses.slice(before).filter((x) => x.url.indexOf(opened.url) >= 0);
        const statuses = Array.from(new Set(answers.map((x) => x.status)));
        assert(answers.length > 0 && answers.every((x) => x.status === 206 || x.status === 200), 'WebKit answers ' + JSON.stringify(answers.map((x) => [x.status, x.range])));
        await v.close();
        return 'WebKit ' + webkit.version() + ': first frame ' + first.firstFrameMs + ' ms; ' + seeks.join(', ') + '; ' + answers.length + ' answers from the worker route, statuses ' + statuses.join('/');
      } finally {
        await webkit.close().catch(() => {});
      }
    },
  };

  return S;
}
