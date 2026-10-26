// Real-browser checks for the calls lane (opt-in like the other *-browser tests):
//   MW_BROWSER=1 node --test test/unit/calls-browser.test.mjs
// Network policy (docs/DEV-NETWORK.md): every page is http://127.0.0.1:<port> from a throw-away server that serves the
// unbundled src/ modules and test/fixtures/calls/browser-page.js; peer connections run with iceServers emptied, so
// only loopback host candidates are used. Chromium runs with chromiumArgs() plus --allow-loopback-in-peer-connection
// and BOTH fake-media flags (--use-fake-ui-for-media-stream alone grants the machine's real camera and microphone,
// docs/research/labs/c2-calls-lab). WebKit runs one browser per participant with the camera and microphone context
// permissions (a second capturing page in one WebKit browser mutes the first) and is driven on 127.0.0.1 only.
// SIG travels through Node (exposeBinding '__mwRelay'), which can alter it: the chat lane's sealing is tested in Node
// (calls-service.test.mjs); this file tests WebRTC.
//   Chromium: ring, accept with video, connected within 10 s, audio and video bytes both ways, the certificate check
//   against the fingerprint of the SDP that came as SIG (and its failure when getStats shows another certificate),
//   a relay that alters the SDP fingerprint makes the call fail (E_CALL_FAILED), mute and camera off reach the peer,
//   hang up closes both connections and ends every capture track.
//   WebKit: the same call in two WebKit browsers, plus a screen shared from a trusted click (page.click).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumArgs } from '../e2e/browser-args.mjs';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CALL_FLAGS = ['--allow-loopback-in-peer-connection', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const PAGE = '<!doctype html><meta charset="utf-8"><title>calls lab</title><button id="share" style="width:120px;height:40px">share</button><script type="module" src="/fx/browser-page.js"></script>';

async function startServer() {
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PAGE);
    }
    let file = null;
    if (p.startsWith('/src/')) file = path.join(ROOT, p);
    else if (p === '/fx/browser-page.js') file = path.join(ROOT, 'test', 'fixtures', 'calls', 'browser-page.js');
    if (!file || !file.startsWith(ROOT)) {
      res.writeHead(404);
      return res.end();
    }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch (_) {
      res.writeHead(404);
      return res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise((r) => server.close(r)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, arg, { timeoutMs = 15000, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + label);
    await sleep(100);
  }
}

/**
 * twoPeople(contexts, url, { alter }) -> { A, B, relayed }: two pages, each a participant with its own key; SIG goes
 * from one page to the other through Node, where alter(msg, from) may change it (msg is the decoded body).
 */
async function twoPeople([ctxA, ctxB], url, { alter = null } = {}) {
  const pubA = await exportPublicKey((await generateKeyPair()).publicKey);
  const pubB = await exportPublicKey((await generateKeyPair()).publicKey);
  const relayed = [];
  const pages = {};
  const people = [[ctxA, pubA, pubB, 'A'], [ctxB, pubB, pubA, 'B']];
  for (const [ctx, pub, peer, name] of people) {
    await ctx.addInitScript((m) => { window.__mwMe = m; }, { pub, peer, contacts: [peer] });
    await ctx.exposeBinding('__mwRelay', async (_source, msg) => {
      let body = JSON.parse(Buffer.from(msg.b64, 'base64').toString('utf8'));
      relayed.push({ from: name, body });
      if (alter) body = alter(body, name) || body;
      const target = name === 'A' ? pages.B : pages.A;
      const b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
      try {
        return await target.evaluate(([from, data]) => window.__mwDeliver(from, data), [msg.from, b64]);
      } catch (_) {
        return false;
      }
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => relayed.push({ from: name, pageerror: String(e) }));
    await page.goto(url);
    await page.waitForFunction(() => window.__mwCalls && window.__mwCalls.ready, null, { timeout: 15000 });
    pages[name] = page;
  }
  return { A: pages.A, B: pages.B, pubA, pubB, relayed };
}

async function ringAndAccept(A, B, pubB, { video = true } = {}) {
  const st = await A.evaluate((to) => window.__mwCalls.svc.methods['calls.start']({ to, video: true }, { activation: true }), pubB);
  await waitFor(B, () => window.__mwCalls.events.ring.length > 0, null, { label: 'ring' });
  await B.evaluate((v) => { window.__mwCalls.answers['call.incoming'] = v ? 'video' : 'audio'; }, video);
  const t0 = Date.now();
  await B.evaluate((id) => window.__mwCalls.svc.methods['calls.accept']({ id }, { activation: true }), st.id);
  return { id: st.id, t0 };
}

const connected = (p) => window.__mwCalls.events.state.some((s) => s.state === 'connected');

async function pairInfo(page) {
  return page.evaluate(async () => (await window.__mwCalls.svc.inspect()).calls[0].pairs[0]);
}

async function fullCall(A, B, pubA, pubB, relayed, { screen = false } = {}) {
  const { id, t0 } = await ringAndAccept(A, B, pubB);
  await waitFor(A, connected, null, { label: 'A connected', timeoutMs: 20000 });
  await waitFor(B, connected, null, { label: 'B connected', timeoutMs: 20000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 10000, 'connected within 10 s (' + ms + ' ms)');
  // The certificate the connection shows is the one named in the SDP that came as SIG.
  const answer = relayed.find((r) => r.from === 'B' && r.body && r.body.k === 'answer');
  assert.ok(answer, 'the answer travelled as SIG');
  const fp = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(answer.body.sdp)[1].toUpperCase();
  const pa = await pairInfo(A);
  const certificate = pa.fingerprint && pa.fingerprint.status;
  if (certificate === 'ok') assert.equal(pa.fingerprint.actual, fp);
  assert.ok(certificate === 'ok' || certificate === 'unavailable', 'the check ran: ' + JSON.stringify(pa.fingerprint));
  // Media both ways.
  await sleep(2500);
  const ba = (await pairInfo(A)).bytes;
  const bb = (await pairInfo(B)).bytes;
  for (const [who, b] of [['A', ba], ['B', bb]]) {
    assert.ok(b.audioSent > 0 && b.audioReceived > 0, who + ' audio both ways: ' + JSON.stringify(b));
    assert.ok(b.videoSent > 0 && b.videoReceived > 0, who + ' video both ways: ' + JSON.stringify(b));
  }
  // No candidate or SDP is in a ring; the callee sent no candidate before it accepted (the caller made the first offer).
  assert.ok(!relayed.find((r) => r.body && r.body.k === 'ring' && (r.body.sdp || r.body.cand)));
  const firstB = relayed.findIndex((r) => r.from === 'B' && r.body && (r.body.cand || r.body.sdp));
  const acceptB = relayed.findIndex((r) => r.from === 'B' && r.body && r.body.k === 'accept');
  assert.ok(acceptB >= 0 && (firstB < 0 || firstB > acceptB), 'B sent nothing with an address before its accept');
  // Mute and camera off reach the peer over mw-call.
  await A.evaluate((i) => window.__mwCalls.svc.methods['calls.mute']({ id: i, on: true }, { activation: false }), id);
  await waitFor(B, () => window.__mwCalls.events.peer.some((p) => p.mute === true), null, { label: 'mute at B' });
  await A.evaluate((i) => window.__mwCalls.svc.methods['calls.camera']({ id: i, on: false }, { activation: false }), id);
  await waitFor(B, () => window.__mwCalls.events.peer.some((p) => p.camera === false), null, { label: 'camera off at B' });
  let shared = null;
  if (screen) {
    await B.evaluate((i) => window.__mwCalls.svc.methods['calls.camera']({ id: i, on: true }, { activation: false }), id).catch(() => {});
    await A.click('#share');
    shared = await waitFor(A, () => { const s = window.__mwCalls.share(); return s && s !== 'pending' ? s : null; }, null, { label: 'screen share' });
    assert.deepEqual(shared, { id, screen: true }, 'getDisplayMedia from the trusted click');
    await waitFor(B, () => window.__mwCalls.events.peer.some((p) => p.screen === true), null, { label: 'screen at B' });
    await waitFor(B, async () => { const m = await window.__mwCalls.inboundByMid(); return (m['2'] || 0) > 0; }, null, { label: 'screen bytes at B', timeoutMs: 15000 });
  }
  // Hang up: both connections close; every capture track ends.
  const before = await A.evaluate((i) => window.__mwCalls.keep(i), id);
  assert.ok(before.length >= 1 && before.every((x) => x.endsWith(':live')), JSON.stringify(before));
  await B.evaluate((i) => window.__mwCalls.keep(i), id);
  await A.evaluate((i) => window.__mwCalls.svc.methods['calls.hangup']({ id: i }, { activation: false }), id);
  await waitFor(B, () => window.__mwCalls.events.ended.length > 0, null, { label: 'B ended' });
  await sleep(500);
  for (const p of [A, B]) {
    const states = await p.evaluate(() => window.__mwCalls.pcStates());
    assert.ok(states.every((s) => s === 'closed'), 'connections closed: ' + states.join(','));
    const kept = await p.evaluate(() => window.__mwCalls.kept());
    assert.ok(kept.every((x) => x.endsWith(':ended')), 'capture ended: ' + kept.join(','));
  }
  // Measured sizes of what travelled as SIG (the body cap is 15,000 bytes, an SDP at most 14,000).
  const size = (k) => Math.max(0, ...relayed.filter((r) => r.body && r.body.k === k).map((r) => Buffer.byteLength(JSON.stringify(r.body))));
  const sdpSize = (k) => Math.max(0, ...relayed.filter((r) => r.body && r.body.k === k && r.body.sdp).map((r) => Buffer.byteLength(r.body.sdp)));
  const sizes = { offerBody: size('offer'), answerBody: size('answer'), offerSdp: sdpSize('offer'), answerSdp: sdpSize('answer'), iceBody: size('ice') };
  assert.ok(sizes.offerBody > 0 && sizes.offerBody <= 15000 && sizes.answerBody <= 15000, JSON.stringify(sizes));
  return { id, ms, certificate, shared, sizes };
}

test('calls in Chromium (fake devices): connect, media both ways, the certificate check, a relay that alters the fingerprint fails the call, mute, camera, hang up', {
  skip: !ENABLED ? 'set MW_BROWSER=1 (opens Chromium on 127.0.0.1)' : false,
  timeout: 180000,
}, async (t) => {
  const { chromium } = await import('playwright');
  const srv = await startServer();
  const browser = await chromium.launch({ args: chromiumArgs({ allowRemote: false }).concat(CALL_FLAGS) });
  try {
    const ctx = () => browser.newContext({ permissions: ['camera', 'microphone'] });
    // 1. A full call.
    {
      const p = await twoPeople([await ctx(), await ctx()], srv.url);
      const r = await fullCall(p.A, p.B, p.pubA, p.pubB, p.relayed);
      assert.equal(r.certificate, 'ok', 'Chromium reports the remote certificate');
      t.diagnostic('Chromium ' + browser.version() + ': connected in ' + r.ms + ' ms; SIG sizes ' + JSON.stringify(r.sizes));
      assert.ok(!p.relayed.some((x) => x.pageerror), JSON.stringify(p.relayed.filter((x) => x.pageerror)));
    }
    // 2. getStats shows another certificate than the sealed SDP named: the pair closes with E_CALL_FAILED.
    {
      const cA = await ctx();
      await cA.addInitScript(() => { window.__mwTamperStats = true; });
      const p = await twoPeople([cA, await ctx()], srv.url);
      await ringAndAccept(p.A, p.B, p.pubB);
      const ended = await waitFor(p.A, () => window.__mwCalls.events.ended[0] || null, null, { label: 'A ended', timeoutMs: 20000 });
      assert.deepEqual([ended.reason, ended.code], ['fingerprint', 'E_CALL_FAILED']);
    }
    // 3. The relay alters the fingerprint in the answer: DTLS refuses, the call fails (E_CALL_FAILED), never connected.
    {
      const p = await twoPeople([await ctx(), await ctx()], srv.url, {
        alter: (body) => (body.k === 'answer' ? Object.assign({}, body, { sdp: body.sdp.replace(/a=fingerprint:sha-256 [0-9A-Fa-f:]+/g, 'a=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB') }) : body),
      });
      await ringAndAccept(p.A, p.B, p.pubB);
      const ended = await waitFor(p.A, () => window.__mwCalls.events.ended[0] || null, null, { label: 'A ended', timeoutMs: 40000 });
      assert.equal(ended.code, 'E_CALL_FAILED');
      assert.equal(await p.A.evaluate(() => window.__mwCalls.events.state.some((s) => s.participants.some((x) => x.state === 'direct' || x.state === 'relayed'))), false);
    }
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('calls in WebKit (mock devices, one browser per participant): the same call, plus a screen shared from a trusted click', {
  skip: !ENABLED ? 'set MW_BROWSER=1 (opens WebKit on 127.0.0.1)' : false,
  timeout: 180000,
}, async (t) => {
  const { webkit } = await import('playwright');
  const srv = await startServer();
  let b1 = null;
  let b2 = null;
  try {
    try {
      b1 = await webkit.launch();
      b2 = await webkit.launch();
    } catch (e) {
      t.skip('WebKit is not installed: ' + e.message);
      return;
    }
    const p = await twoPeople([await b1.newContext({ permissions: ['camera', 'microphone'] }), await b2.newContext({ permissions: ['camera', 'microphone'] })], srv.url);
    const r = await fullCall(p.A, p.B, p.pubA, p.pubB, p.relayed, { screen: true });
    t.diagnostic('WebKit ' + b1.version() + ' certificate check: ' + r.certificate + '; connected in ' + r.ms + ' ms; SIG sizes ' + JSON.stringify(r.sizes));
  } finally {
    if (b1) await b1.close();
    if (b2) await b2.close();
    await srv.close();
  }
});
