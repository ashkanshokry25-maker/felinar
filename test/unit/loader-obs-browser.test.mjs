// src/loader/obs.js in real browsers (plan obs-2026-11-02 section 2.2; opt-in like the other *-browser tests):
//   MW_BROWSER=1 node --test test/unit/loader-obs-browser.test.mjs
// What the unit tests (loader-obs.test.mjs, in Node) cannot show: the module loads and runs in Chromium and WebKit; safeField gives the browser's answer
// and Node's answer alike on 1,200 generated strings; describeTarget works on a real DOM (SVG, text nodes, closed shadow roots, person text marked dir="auto");
// the reporter's transport works for real: sendBeacon on the 2 second timer, fetch with keepalive on pagehide and stop(), one POST of text/plain, no cookie,
// no preflight, nothing from the page's user agent string; a "no" sends nothing, not even on pagehide and stop(); and wrapPeerConnection reports a real
// two-connection WebRTC session under the offer-timeout wrapper in either position, with candidate types and protocols only and no address anywhere.
// Every address is 127.0.0.1 and nothing leaves the machine (the page makes no request of its own; a request to any other host fails the test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumArgs, localOnlyProxy } from '../e2e/browser-args.mjs';
import * as nodeObs from '../../src/loader/obs.js';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(ROOT, 'src') + path.sep;

const HTML = `<!doctype html><meta charset="utf-8"><title>obs check</title>
<body>
<div id="mw-root">
  <button id="plain">Plain</button>
  <button data-role="gate-accept" data-fk="gate:accept">Share and load</button>
  <div class="mw-banner" data-id="note"><span id="in-banner">b</span><button>Dismiss</button></div>
  <div class="mw-dialog" role="dialog" aria-labelledby="mw-settings-title"><h2 id="mw-settings-title">Settings</h2><button id="save">Save</button></div>
  <ul data-role="conv-list"><li><button id="conv" data-fk="conv:abc123" data-conv="abc123"><span dir="auto">Bea</span><span dir="auto">see you at 8</span></button></li></ul>
  <input id="nick" type="text" value="Alice secret">
  <svg id="svg" class="mw-banner" data-id="svg-banner" width="10" height="10"><rect id="rect" width="5" height="5"/></svg>
  <a id="lnk" href="https://x.example/#key=abc">Open https://x.example/#key=abc</a>
</div>
<div id="host"></div>
</body>`;

// ---- inputs for the safeField comparison (the same shapes as the unit test's generator), from a fixed seed
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function inputs() {
  const rnd = seeded(77);
  const hex = (n) => n.toString(16);
  const v4 = () => [0, 0, 0, 0].map(() => Math.floor(rnd() * 256)).join('.');
  const v6 = () => {
    const g = [];
    for (let i = 0; i < 8; i++) g.push(rnd() < 0.4 ? 0 : 1 + Math.floor(rnd() * 65534));
    if (g.every((n) => n === 0)) g[7] = 1;
    let best = null;
    for (let i = 0; i < 8; i++) {
      if (g[i] !== 0) continue;
      let j = i;
      while (j < 8 && g[j] === 0) j++;
      if (!best || j - i > best[1] - best[0]) best = [i, j];
      i = j;
    }
    if (!best || rnd() < 0.2) return g.map(hex).join(':');
    return g.slice(0, best[0]).map(hex).join(':') + '::' + g.slice(best[1]).map(hex).join(':');
  };
  const wraps = [(a) => a, (a) => 'peer ' + a + ' up', (a) => '(' + a + ')', (a) => '[' + a + ']:443', (a) => 'http://[' + a + ']:8080/p#frag',
    (a) => 'candidate:1 1 udp 2113937151 ' + a + ' 50000 typ host generation 0', (a) => a + '%en0 x'];
  const out = [];
  for (let i = 0; i < 1200; i++) {
    const w = wraps[Math.floor(rnd() * wraps.length)];
    out.push(w(rnd() < 0.5 ? v4() : v6()));
  }
  out.push('abcd-efgh-2345', 'https://x.example/p#secret', '0123456789abcdef0123456789abcdef01234567', 'Item #3 and C# fine', '12:34:56', 'std::vector', 'a'.repeat(300),
    '1.2.3.4 5.6.7.8', '::ffff:192.0.2.1', 'fe80::1%25en0', '\uff11\uff19\uff12\uff0e\uff11\uff16\uff18\uff0e\uff10\uff0e\uff11', '192.168.\u200b0.1', 'a\u2013b',
    'abcd\u2013efgh\u2013jkmn', 'x'.repeat(190) + ' 192.168.100.200', '\u00e9', '\ud83d\ude00'.repeat(150));
  // The forms an address hides in (the ideographic full stop, the half width one, percent escapes, a combining mark, an octal group, the ratio sign), the secrets
  // of an SDP, and a text of many "#1": the unicode property escape of the fold must read the same in both engines.
  const code = (c) => String.fromCharCode(c);
  out.push('192' + code(0x3002) + '168' + code(0x3002) + '0' + code(0x3002) + '1', '192' + code(0xff61) + '168' + code(0xff61) + '0' + code(0xff61) + '1', '192%2E168%2E0%2E1', 'http://192%2e168%2e0%2e1:8080/x',
    '192' + code(0x301) + '.168' + code(0x302) + code(0x327) + '.0.1', '0300.0250.0.1', '010.020.030.040', '2001' + code(0x2236) + 'db8' + code(0x2236) + code(0x2236) + '1', '2001%3adb8%3a%3a1',
    'a=ice-ufrag:Zq3k\r\na=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsT\r\na=fingerprint:sha-256 5D:1C:0A:77:B3:4E:99:AB\r\n', 'Error 0x80070005 in 1.2.3', 'caf' + code(0xe9) + ' q' + code(0x301), '#1'.repeat(300), '#1 '.repeat(100));
  return out;
}

test('src/loader/obs.js in Chromium and WebKit: the same masks as Node, describeTarget on a real DOM, the real transport, and a real WebRTC session without an address', {
  skip: ENABLED ? false : 'set MW_BROWSER=1 to run (needs Playwright browsers)',
  timeout: 300000,
}, async (t) => {
  const playwright = await import('playwright');
  const received = [];
  const collector = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const origin = req.headers.origin;
      const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({ 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }, cors));
        res.end();
        return;
      }
      res.writeHead(204, cors);
      res.end();
    });
  });
  const pageServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SRC) || path.extname(file) !== '.js') { res.writeHead(404); res.end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (_) {
      res.writeHead(404);
      res.end();
    }
  });
  const collectorPort = await new Promise((resolve) => collector.listen(0, '127.0.0.1', () => resolve(collector.address().port)));
  const pagePort = await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', () => resolve(pageServer.address().port)));
  t.after(() => {
    collector.close();
    pageServer.close();
    collector.closeAllConnections();
    pageServer.closeAllConnections();
  });
  const pageUrl = 'http://127.0.0.1:' + pagePort + '/';
  const endpoint = 'http://127.0.0.1:' + collectorPort;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const check = (name, ok, detail) => assert.ok(ok, name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));

  let engines = 0;
  for (const engine of ['chromium', 'webkit']) {
    let browser;
    try {
      browser = await playwright[engine].launch(engine === 'chromium' ? { headless: true, args: chromiumArgs() } : { headless: true, proxy: localOnlyProxy() });
    } catch (err) {
      t.diagnostic(engine + ': not available (' + String(err.message).split('\n')[0] + ')');
      continue;
    }
    engines++;
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const consoleLines = [];
      const external = [];
      page.on('console', (m) => consoleLines.push(m.type() + ': ' + m.text()));
      page.on('pageerror', (e) => consoleLines.push('pageerror: ' + e.message));
      page.on('request', (r) => { try { if (new URL(r.url()).hostname !== '127.0.0.1') external.push(r.url()); } catch (_) { /* a data: URL */ } });
      await page.goto(pageUrl);
      received.length = 0;

      // 1. the module loads and runs (no lookbehind or syntax the engine rejects)
      const loaded = await page.evaluate(async () => {
        const m = await import('/src/loader/obs.js');
        window.__obs = m;
        return Object.keys(m).sort();
      });
      check(engine + ': the module loads and exports what it should', eq(loaded, ['OBS_LIMITS', 'createReporter', 'describeTarget', 'safeField', 'wrapPeerConnection']), loaded);

      // 2. safeField: the browser and Node give the same answer for every input, and no address survives
      const list = inputs();
      const inBrowser = await page.evaluate((xs) => xs.map((x) => window.__obs.safeField(x)), list);
      const inNode = list.map((x) => nodeObs.safeField(x));
      let first = null;
      for (let i = 0; i < list.length && !first; i++) if (inBrowser[i] !== inNode[i]) first = { input: list[i], browser: inBrowser[i], node: inNode[i] };
      check(engine + ': safeField agrees with Node on ' + list.length + ' inputs', first === null, first);
      const leaks = inBrowser.filter((o) => /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(o) || /[0-9a-f]*::[0-9a-f]|(?:[0-9a-f]{1,4}:){7}/i.test(o));
      check(engine + ': no address in the browser outputs', leaks.length === 0, leaks.slice(0, 3));

      // 3. describeTarget on a real DOM
      const described = await page.evaluate(() => {
        const d = window.__obs.describeTarget;
        const q = (s) => document.querySelector(s);
        const out = {};
        out.plain = d(q('#plain'));
        out.gate = d(q('[data-role="gate-accept"]'));
        out.banner = d(q('#in-banner'));
        out.dialog = d(q('#save'));
        out.conv = d(q('#conv'));
        out.convName = d(q('#conv span'));
        out.input = d(q('#nick'));
        out.svgRect = d(q('#rect'));
        out.link = d(q('#lnk'));
        out.textNode = d(q('#plain').firstChild);
        out.doc = d(document);
        out.win = d(window);
        out.nothing = d(null);
        // a closed shadow root with a card: the listener sits inside the root, as in ui.js
        const root = q('#host').attachShadow({ mode: 'closed' });
        const card = document.createElement('div');
        card.setAttribute('data-mw-card', 'consent');
        const btn = document.createElement('button');
        btn.textContent = 'Accept';
        const plain = document.createElement('button');
        plain.textContent = 'No marks';
        card.appendChild(btn);
        root.appendChild(card);
        root.appendChild(plain);
        const seen = [];
        root.addEventListener('click', (ev) => seen.push(d(ev.target)), true);
        btn.click();
        plain.click();
        out.shadow = seen;
        return out;
      });
      check(engine + ': describeTarget: a plain button (id and text)', eq(described.plain, { id: 'plain', text: 'Plain' }), described.plain);
      check(engine + ': describeTarget: a data-role button', eq(described.gate, { role: 'gate-accept', text: 'Share and load' }), described.gate);
      check(engine + ': describeTarget: a banner', eq(described.banner, { banner: 'note' }), described.banner);
      check(engine + ': describeTarget: the dialog beats the id', eq(described.dialog, { dialog: 'mw-settings-title', text: 'Save' }), described.dialog);
      check(engine + ': describeTarget: a conversation row names the role of the list and holds back the person\'s text', eq(described.conv, { role: 'conv-list' }) && eq(described.convName, { role: 'conv-list' }), [described.conv, described.convName]);
      check(engine + ': describeTarget: an input has no text and never its value', eq(described.input, { id: 'nick' }), described.input);
      check(engine + ': describeTarget: an SVG element (its className is an object)', eq(described.svgRect, { banner: 'svg-banner' }), described.svgRect);
      check(engine + ': describeTarget: a link\'s text is masked and then cut at 24 characters', eq(described.link, { id: 'lnk', text: 'Open https://x.example/#' }), described.link);
      check(engine + ': describeTarget: a text node as the target', eq(described.textNode, { id: 'plain', text: 'Plain' }), described.textNode);
      check(engine + ': describeTarget: the document, the window and null', eq(described.doc, { tag: '#document' }) && eq(described.win, { tag: 'unknown' }) && eq(described.nothing, { tag: 'unknown' }), [described.doc, described.win, described.nothing]);
      check(engine + ': describeTarget: a closed shadow root', eq(described.shadow, [{ card: 'consent', text: 'Accept' }, { tag: 'button', text: 'No marks' }]), described.shadow);

      // 4. the reporter on the real transport: sendBeacon on the 2 s timer, fetch with keepalive on pagehide and stop()
      received.length = 0;
      await page.evaluate(async (ep) => {
        const { createReporter } = window.__obs;
        window.__r = createReporter({ endpoint: ep, page: 'site', build: 'bbcb82098cda', loader: '0.3.0', site: 'd680ff36' });
        window.__r.setWho('da9u-6qug');
        window.__r.setNet({ type: 'wifi', effectiveType: '4g' });
        window.__r.event('boot.start', { m: 'peer 10.0.0.1:3478 [2001:db8::1]:443 abcd-efgh-2345 https://x.example/#key' });
        window.__r.allow(true);
        window.__r.event('gate.shown', { kind: 'consent', host: 'obs.example' });
      }, endpoint);
      await page.waitForTimeout(2600);
      check(engine + ': the 2 s timer sent one batch (a beacon)', received.filter((r) => r.method === 'POST').length === 1, received.map((r) => r.method + ' ' + r.url));
      const sent = received.find((r) => r.method === 'POST');
      const body = JSON.parse(sent.body);
      check(engine + ': the beacon is a POST to /e, text/plain, with no cookie, from the page\'s origin',
        sent.url === '/e' && /^text\/plain/.test(sent.headers['content-type'] || '') && !sent.headers.cookie && sent.headers.origin === 'http://127.0.0.1:' + pagePort,
        { url: sent.url, ct: sent.headers['content-type'], origin: sent.headers.origin, cookie: sent.headers.cookie });
      check(engine + ': the batch has its shape', body.v === 1 && /^[a-z2-9]{12}$/.test(body.sid) && body.seq === 0 && body.page === 'site' && body.who === 'da9u-6qug' &&
        eq(body.net, { type: 'wifi', effectiveType: '4g' }) && body.site === 'd680ff36' && body.events.length === 2, body);
      check(engine + ': ua is a family', eq(Object.keys(body.ua), ['browser', 'mobile']) && ['chromium', 'firefox', 'webkit', 'other'].includes(body.ua.browser), body.ua);
      check(engine + ': what a string held is masked', body.events[0].m === 'peer x.x.x.x x.x.x.x abcd https://x.example/#', body.events[0]);
      check(engine + ': nothing of the page\'s user agent string is in the body', !/Mozilla|AppleWebKit|Gecko/.test(sent.body), sent.body.slice(0, 200));
      await page.evaluate(() => { window.__r.event('x.hidden'); window.dispatchEvent(new Event('pagehide')); });
      await page.waitForTimeout(500);
      const afterHide = received.filter((r) => r.method === 'POST');
      check(engine + ': pagehide flushed at once (a final flush)', afterHide.length === 2 && JSON.parse(afterHide[1].body).events[0].n === 'x.hidden' && JSON.parse(afterHide[1].body).seq === 1, afterHide.map((r) => r.body.slice(0, 80)));
      await page.evaluate(() => { window.__r.event('x.stopped'); window.__r.stop(); });
      await page.waitForTimeout(500);
      const afterStop = received.filter((r) => r.method === 'POST');
      check(engine + ': stop() flushed', afterStop.length === 3 && JSON.parse(afterStop[2].body).events[0].n === 'x.stopped', afterStop.length);
      check(engine + ': no preflight (no OPTIONS request reached the collector)', received.every((r) => r.method === 'POST'), received.map((r) => r.method));
      const insp = await page.evaluate(() => window.__r.inspect());
      check(engine + ': inspect() after stop()', eq(insp, { host: '127.0.0.1', enabled: false, allowed: false, queued: 0, sent: insp.sent, dropped: 0, batches: insp.batches, lastOk: insp.lastOk }) && insp.sent === 4, insp);

      // 5. a consent "no" sends nothing
      received.length = 0;
      await page.evaluate((ep) => {
        const { createReporter } = window.__obs;
        const r = createReporter({ endpoint: ep, page: 'door' });
        r.event('a.one');
        r.allow(false);
        r.event('a.two');
        window.dispatchEvent(new Event('pagehide'));
        r.stop();
      }, endpoint);
      await page.waitForTimeout(500);
      check(engine + ': a "no" sends nothing, not even on pagehide and stop()', received.length === 0, received.length);

      // 6. WebRTC: a real connection between two connections of this page, wrapped, with the offer timeout on top
      const rtc = await page.evaluate(async () => {
        const { wrapPeerConnection } = window.__obs;
        const { installOfferTimeout } = await import('/src/loader/connectivity.js');
        const Native = window.RTCPeerConnection;
        const events = [];
        const rep = { event: (n, f) => { events.push(Object.assign({ n }, f)); return true; } };
        const first = wrapPeerConnection(window, rep);
        const second = wrapPeerConnection(window, rep);
        // a subclass of the wrapper alone (installOfferTimeout builds its connections with new Base(), so it never supported subclasses)
        class Sub extends RTCPeerConnection { who() { return 'sub'; } }
        const s = new Sub({ iceServers: [] });
        const subclass = s instanceof Sub && s instanceof Native && s.who() === 'sub';
        s.close();
        const timeout = installOfferTimeout(window, { timeoutMs: 1500 });
        const W = window.RTCPeerConnection;
        const info = { first, second, timeout, subclass, native: W.__mwNative === Native, obs: W.__mwObs === true, offerMarker: W.__mwOfferTimeout === 1500, name: W.name };
        info.cert = await W.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }).then((c) => c && c.constructor && c.constructor.name, (e) => 'error ' + e.message);
        events.length = 0;
        const a = new RTCPeerConnection({ iceServers: [] });
        const b = new RTCPeerConnection({ iceServers: [] });
        info.instance = a instanceof W && a instanceof Native;
        const connected = (pc) => new Promise((resolve) => { if (pc.connectionState === 'connected') resolve(); else pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') resolve(); }); });
        const addresses = [];
        a.addEventListener('icecandidate', (e) => { if (e.candidate) { addresses.push(e.candidate.address || ''); b.addIceCandidate(e.candidate); } });
        b.addEventListener('icecandidate', (e) => { if (e.candidate) { addresses.push(e.candidate.address || ''); a.addIceCandidate(e.candidate); } });
        a.createDataChannel('probe');
        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
        await Promise.race([Promise.all([connected(a), connected(b)]), new Promise((r) => setTimeout(r, 8000))]);
        await new Promise((r) => setTimeout(r, 600));
        info.connected = [a.connectionState, b.connectionState];
        a.close();
        b.close();
        info.events = events;
        info.addresses = addresses.filter(Boolean);
        return info;
      });
      check(engine + ': wrapPeerConnection wrapped once, with the offer timeout on top, and the markers and the native class reachable', rtc.first === true && rtc.second === false && rtc.timeout === true && rtc.native && rtc.obs && rtc.offerMarker && rtc.name === 'RTCPeerConnection', rtc);
      check(engine + ': the static generateCertificate still works', /Certificate/.test(String(rtc.cert)), rtc.cert);
      check(engine + ': a subclass of the wrapped class, and instanceof the native one', rtc.subclass && rtc.instance, rtc);
      const names = rtc.events.map((e) => e.n);
      const has = (n, pred) => rtc.events.some((e) => e.n === n && (!pred || pred(e)));
      const pairs = rtc.events.filter((e) => e.n === 'ice.pair');
      check(engine + ': both ends connected', rtc.connected.every((s) => s === 'connected'), rtc.connected);
      check(engine + ': ice.pc created twice and closed twice', rtc.events.filter((e) => e.n === 'ice.pc' && e.ev === 'created').length === 2 && rtc.events.filter((e) => e.n === 'ice.pc' && e.ev === 'closed').length === 2, names);
      check(engine + ': ice.local with host and udp', has('ice.local', (e) => e.type === 'host' && e.proto === 'udp'), names);
      check(engine + ': ice.remote for an offer and an answer', has('ice.remote', (e) => e.sdp === 'offer') && has('ice.remote', (e) => e.sdp === 'answer'), names);
      check(engine + ': ice.gathering, ice.state and ice.conn are reported', has('ice.gathering') && has('ice.state') && has('ice.conn', (e) => e.state === 'connected'), names);
      check(engine + ': ice.pair from getStats on both ends, as type/proto words', pairs.length === 2 && pairs.every((e) => /^(host|srflx|prflx|relay)\/(udp|tcp)$/.test(e.local) && /^(host|srflx|prflx|relay)\/(udp|tcp)$/.test(e.remote)), pairs);
      const rawEvents = JSON.stringify(rtc.events);
      check(engine + ': no address, no port and no candidate text in any event', !/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(rawEvents) && rtc.addresses.every((a) => !rawEvents.includes(a)) && !/candidate:|typ |ufrag/.test(rawEvents), rawEvents.slice(0, 300));

      // 7. everything the page asked for stayed on loopback
      check(engine + ': no request left loopback', external.length === 0, external);
      t.diagnostic(engine + ' ' + browser.version() + ': ' + list.length + ' strings masked alike, ' + rtc.events.length + ' ICE events from a real session, ' + consoleLines.length + ' console lines');
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
