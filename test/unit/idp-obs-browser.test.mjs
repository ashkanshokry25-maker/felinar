// The identity page's usage reports in real browsers (plan obs-2026-11-02 section 2.6; opt-in like the other *-browser tests):
//   MW_BROWSER=1 node --test test/unit/idp-obs-browser.test.mjs
// What the unit tests cannot show: a built identity page (node tools/build-idp.mjs --obs <origin>) in Chromium and WebKit, a loopback collector
// for the endpoint and a loopback page for the site that opens it. The page's own Content-Security-Policy lets the report out (connect-src), a
// report needs no preflight, the disclosure line is on the first card and sits right above its buttons, nothing leaves before a card button is
// pressed, the last report goes out before the sign-in window closes itself (the service worker of the page held a request sent as the window
// closes in Chromium 156 until src/idp/sw.js got its Static Routing rule), pagehide sends what is left, a redirect sign-in sends its last report
// before the page leaves, and the opener's session id arrives as ref on a popup and on no redirect. Every address is 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumArgs, localOnlyProxy } from '../e2e/browser-args.mjs';
import { startIdpServer } from '../fixtures/idp/serve.mjs';
import { buildIdp } from '../../tools/build-idp.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SID = 'abcdefgh2345';

/** serveSite(ido): a page that asks the identity page for a sign-in (popup or redirect) with the session id of its own reporter, and the sources it imports. */
function siteServer(idpUrl) {
  const html = `<!doctype html><meta charset="utf-8"><title>site</title><button id="go">Sign in</button> <button id="redir">Redirect</button><pre id="out"></pre>
<script type="module">
import * as client from '/src/identity/client.js';
document.getElementById('redir').addEventListener('click', () => { client.configure({ idp: ${JSON.stringify(idpUrl)}, obsSid: window.__sid }); client.signIn({ want: ['keys'], redirect: true }); });
document.getElementById('go').addEventListener('click', async () => {
  client.configure({ idp: ${JSON.stringify(idpUrl)}, obsSid: window.__sid });
  try { const r = await client.signIn({ want: ['keys'] }); document.getElementById('out').textContent = 'OK ' + r.bundle.origin; }
  catch (e) { document.getElementById('out').textContent = 'ERR ' + e.code; }
});
</script>`;
  return http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (p.startsWith('/src/') && !p.includes('..')) {
      try {
        const body = await fs.readFile(path.join(ROOT, p));
        res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
        res.end(body);
        return;
      } catch (_) { /* fall through */ }
    }
    res.writeHead(404);
    res.end('no');
  });
}

test('the identity page with --obs in Chromium and WebKit: the line on the first card, silence before a press, the last report before the window closes, no preflight, the opener\'s session id as ref', {
  skip: ENABLED ? false : 'set MW_BROWSER=1 to run (needs Playwright browsers)',
  timeout: 300000,
}, async (t) => {
  const playwright = await import('playwright');
  const hits = [];
  const collector = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const h = { 'Access-Control-Allow-Origin': req.headers.origin || '*', Vary: 'Origin' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign(h, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' }));
        res.end();
        return;
      }
      res.writeHead(204, h);
      res.end();
    });
  });
  await new Promise((ok) => collector.listen(0, '127.0.0.1', ok));
  const OBS = 'http://127.0.0.1:' + collector.address().port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mw-idp-obs-browser-'));
  await buildIdp({ root: ROOT, outDir: dir + '/idp', quiet: true, obs: OBS });
  const ido = await startIdpServer({ dir: dir + '/idp' });
  const site = siteServer(ido.url);
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  const SITE = 'http://127.0.0.1:' + site.address().port;
  t.after(async () => {
    await ido.close();
    collector.close();
    site.close();
    collector.closeAllConnections();
    site.closeAllConnections();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const waitUntil = async (cond, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out: ' + what);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  let engines = 0;
  for (const name of ['chromium', 'webkit']) {
    let browser;
    try {
      browser = await playwright[name].launch(name === 'chromium' ? { headless: true, args: chromiumArgs() } : { headless: true, proxy: localOnlyProxy() });
    } catch (err) {
      t.diagnostic(name + ': not available (' + String(err.message).split('\n')[0] + ')');
      continue;
    }
    engines++;
    const context = await browser.newContext();
    const consoleLines = [];
    const requests = [];
    context.on('request', (r) => { if (r.url().startsWith(OBS)) requests.push({ type: r.resourceType(), method: r.method(), url: r.url() }); });
    const watch = (p, label) => {
      p.on('console', (m) => consoleLines.push(label + ': ' + m.type() + ': ' + m.text()));
      p.on('pageerror', (e) => consoleLines.push(label + ': pageerror: ' + e.message));
    };
    hits.length = 0;
    try {
      // 1. a popup sign-in: the first card names the host, nothing leaves before the press, the last report survives the window closing itself
      const page = await context.newPage();
      watch(page, 'site');
      await page.goto(SITE + '/');
      await page.evaluate((sid) => { window.__sid = sid; }, SID);
      const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#go')]);
      watch(popup, 'popup');
      await popup.waitForSelector('button');
      await popup.waitForSelector('[data-mw-obs-line]');
      const lineText = await popup.textContent('[data-mw-obs-line]');
      assert.ok(lineText.includes('127.0.0.1'), name + ': the line names the host: ' + lineText);
      const sits = await popup.evaluate(() => { const l = document.querySelector('[data-mw-obs-line]'); const a = l.parentElement.querySelector('.mw-actions'); return l.nextElementSibling === a; });
      assert.equal(sits, true, name + ': the line sits right above the buttons');
      await popup.waitForTimeout(700);
      assert.equal(hits.length, 0, name + ': nothing reached the collector while the first card was up');
      await popup.click('.mw-primary'); // "Create my identity": the first press is the yes
      await popup.waitForSelector('text=For this visit only');
      assert.equal(await popup.locator('[data-mw-obs-line]').count(), 0, name + ': the second card does not repeat the line');
      await popup.waitForTimeout(500);
      await popup.click('text=For this visit only');
      await waitUntil(() => hits.length >= 1, name + ': the final flush', 4000);
      await page.waitForFunction(() => document.getElementById('out').textContent !== '', null, { timeout: 8000 });
      assert.match(await page.textContent('#out'), /^OK /, name + ': the site got its answer');
      await waitUntil(() => popup.isClosed(), name + ': the popup closes itself');
      const first = hits[0];
      assert.equal(first.method, 'POST', name);
      assert.equal(first.url, '/e', name);
      assert.match(first.headers['content-type'], /^text\/plain/, name);
      assert.equal(first.headers.origin, ido.url, name);
      assert.equal(first.headers.cookie, undefined, name + ': no cookie');
      assert.equal(first.headers.referer, undefined, name + ': no referrer');
      assert.equal(hits.filter((h) => h.method === 'OPTIONS').length, 0, name + ': no preflight');
      const batch = JSON.parse(first.body);
      assert.equal(batch.page, 'idp', name);
      assert.match(batch.sid, /^[a-z2-9]{12}$/, name);
      assert.notEqual(batch.sid, SID, name + ': the identity page makes a session id of its own');
      assert.deepEqual(batch.events.map((e) => e.n), ['ready', 'request', 'card', 'action', 'card', 'action', 'unlock', 'result'], name);
      assert.equal(batch.events[1].ref, SID, name + ': the opener\'s session id arrives as ref');
      assert.equal(batch.events[1].kind, 'popup', name);
      assert.deepEqual(batch.events.filter((e) => e.n === 'unlock').map((e) => e.method), ['visit'], name);
      assert.equal(batch.events.at(-1).code, 'ok', name);
      for (const bad of [SITE, '127.0.0.1', 'localhost', 'p256:']) assert.ok(!first.body.includes(bad), name + ': the report names ' + bad);
      t.diagnostic(name + ' ' + browser.version() + ': the final flush of a popup went by ' + JSON.stringify(requests.filter((r) => r.method === 'POST').map((r) => r.type)));

      // 2. a window closed before any press sends nothing
      const before = hits.length;
      const page2 = await context.newPage();
      watch(page2, 'site2');
      await page2.goto(SITE + '/');
      const [popup2] = await Promise.all([context.waitForEvent('page'), page2.click('#go')]);
      await popup2.waitForSelector('[data-mw-obs-line]');
      await popup2.waitForTimeout(600);
      await popup2.close({ runBeforeUnload: true });
      await page2.waitForTimeout(1500);
      assert.equal(hits.length, before, name + ': a card seen and a window closed unpressed sends nothing');
      await page2.close();

      // 3. the settings page: the first press agrees, the timer sends, pagehide sends the rest
      const home = await context.newPage();
      watch(home, 'home');
      const before3 = hits.length;
      await home.goto(ido.url + '/');
      await home.waitForSelector('[data-mw-obs-line]');
      await home.waitForTimeout(700);
      assert.equal(hits.length, before3, name + ': nothing before the first press');
      await home.click('text=Restore an identity');
      await waitUntil(() => hits.length > before3, name + ': the timer flush', 6000);
      const timerBatch = JSON.parse(hits[hits.length - 1].body);
      assert.deepEqual(timerBatch.events.map((e) => e.n), ['ready', 'card', 'action', 'card'], name);
      const n3 = hits.length;
      await home.waitForSelector('text=Restore an identity');
      await home.waitForTimeout(500);
      await home.click('text=Cancel');
      await home.waitForTimeout(100);
      await home.goto(SITE + '/'); // a navigation always runs pagehide (a closed tab is not the same in every engine)
      await waitUntil(() => hits.length > n3, name + ': the pagehide report', 6000);
      const hideBatch = JSON.parse(hits[hits.length - 1].body);
      assert.equal(hideBatch.sid, timerBatch.sid, name);
      assert.equal(hideBatch.seq, timerBatch.seq + 1, name);

      // 4. the redirect round trip: the last report goes before the page leaves, with the service worker in control, and carries no ref
      const page4 = await context.newPage();
      watch(page4, 'site4');
      await page4.goto(SITE + '/');
      await page4.evaluate((sid) => { window.__sid = sid; }, SID);
      const before4 = hits.length;
      await page4.click('#redir');
      await page4.waitForURL(ido.url + '/signin**', { timeout: 10000 });
      await page4.waitForSelector('[data-mw-obs-line]');
      await page4.waitForTimeout(500);
      await page4.click('.mw-primary');
      await page4.waitForSelector('text=For this visit only');
      await page4.waitForTimeout(500);
      await page4.click('text=For this visit only');
      await waitUntil(() => hits.length > before4, name + ': the redirect\'s final report', 8000);
      const redir = JSON.parse(hits[hits.length - 1].body);
      assert.equal(redir.events.find((e) => e.n === 'request').kind, 'redirect', name);
      assert.equal(redir.events.find((e) => e.n === 'request').ref, undefined, name + ': a redirect request carries no ref');
      assert.equal(redir.events.at(-1).n, 'result', name);
      assert.equal(redir.events.at(-1).code, 'ok', name);

      const complaints = consoleLines.filter((l) => /Content Security Policy|Refused to|CORS|blocked|violat/i.test(l));
      assert.deepEqual(complaints, [], name + ': no policy or CORS complaint in any console');
      t.diagnostic(name + ' ' + browser.version() + ': popup, closed unpressed, settings page (timer and pagehide) and redirect all behaved; ' + hits.length + ' reports in all');
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
