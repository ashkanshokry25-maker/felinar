// usage: node run-gen.mjs <name> <distDir> <homeMarker> <aboutMarker> <aboutLinkSelector> [spa=0|1] [modes=prefix,remap,true]
import { startServer } from './server.mjs';
import { withBrowser, sleep, leaks } from './lab.mjs';
import fs from 'node:fs';
const [name, dist, HOME, ABOUT, SEL, spaArg = '0', modesArg = 'prefix,remap,true', baseArg = '/'] = process.argv.slice(2);
const BASE = baseArg;
const spa = spaArg === '1';
const modes = modesArg.split(',');
const out = { name, dist, spa, modes: {} };
const frameText = (page) => page.evaluate(() => { try { const w = window.__iframe.contentWindow; return { url: w.location.pathname + w.location.search + w.location.hash, text: (w.document.body ? w.document.body.innerText : '').trim().slice(0, 200), nested: !!(w.document.querySelector && w.document.title === 'shell') }; } catch (e) { return { url: 'ERR ' + e.name, text: '' }; } });
async function waitFor(page, marker, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const f = await frameText(page); if (f.text.includes(marker)) return { ok: true, ms: Date.now() - t0, frame: f }; await sleep(150); }
  return { ok: false, ms, frame: await frameText(page) };
}
const gotoRetry = async (page, url) => { for (let i = 0; i < 8; i++) { try { return await page.goto(url, { timeout: 20000 }); } catch (e) { if (i === 7) throw e; await sleep(2500); } } };
await withBrowser(async (browser) => {
  for (const mode of modes) {
    const srv = await startServer({ mode, siteDir: dist, spa, base: BASE });
    const ctx = await browser.newContext();
    if (process.env.BLOCK_EXTERNAL) await ctx.route((u) => !u.href.startsWith(srv.url), (rt) => rt.abort());
    const R = { home: null, nav: null, deep: null, errors: [], failed: [], leaksAfterNav: [] };
    const page = await ctx.newPage();
    const note = (p) => { p.on('console', (m) => { if (m.type() === 'error') R.errors.push(m.text().slice(0, 120)); }); p.on('pageerror', (e) => R.errors.push('pageerror: ' + String(e).slice(0, 120))); p.on('response', (r) => { if (r.status() >= 400) R.failed.push(r.status() + ' ' + r.url().replace(srv.url, '')); }); };
    note(page);
    await gotoRetry(page, srv.url + BASE);
    try { await page.waitForFunction(() => window.__events && window.__events.length > 0, null, { timeout: 15000 }); } catch (_) {}
    R.home = await waitFor(page, HOME, 6000);
    // client-side navigation to /about
    let aboutHref = null;
    try {
      aboutHref = await page.evaluate((sel) => { const w = window.__iframe.contentWindow; const a = w.document.querySelector(sel); if (!a) return null; const u = new URL(a.getAttribute('href'), w.document.baseURI); return u.pathname + u.search + u.hash + '|' + a.getAttribute('href'); }, SEL);
      const fr = page.frames().find((f) => f !== page.mainFrame());
      try { await fr.click(SEL, { timeout: 2500 }); } catch (_) { await fr.evaluate((s) => { const a = document.querySelector(s); if (!a) throw new Error('no element'); a.click(); }, SEL); }
      R.nav = await waitFor(page, ABOUT, 5000);
    } catch (e) { R.nav = { ok: false, error: String(e).slice(0, 120) }; }
    R.aboutHref = aboutHref;
    R.leaksAfterNav = leaks(srv);
    // deep link to the about URL as a fresh top-level navigation
    if (aboutHref) {
      const p2 = await ctx.newPage(); note(p2);
      const abs = aboutHref.split('|')[0];
      let target = abs;
      const PFX = '/_mw/s/' + 'a'.repeat(40);
      if (target.startsWith(PFX)) target = target.slice(PFX.length) || '/';
      try {
        await gotoRetry(p2, srv.url + target);
        try { await p2.waitForFunction(() => window.__events && window.__events.length > 0, null, { timeout: 15000 }); } catch (_) {}
        R.deep = { target, ...(await waitFor(p2, ABOUT, 6000)) };
      } catch (e) { R.deep = { target, ok: false, error: String(e).slice(0, 120) }; }
      await p2.close();
    }
    R.leaksFinal = leaks(srv);
    out.modes[mode] = R;
    await ctx.close(); await srv.close();
  }
});
fs.writeFileSync(new URL('./gen-' + name + '.json', import.meta.url).pathname, JSON.stringify(out, null, 2));
console.log(`\n##### ${name}  (dist=${dist.split('/').slice(-2).join('/')}, spaFallback=${spa})`);
for (const m of modes) {
  const R = out.modes[m];
  const s = (x) => (x && x.ok ? 'PASS' : 'FAIL');
  console.log(`[${m.padEnd(6)}] home=${s(R.home)}  client-nav=${s(R.nav)}  deep-link=${s(R.deep)}  leaks=${R.leaksFinal.length}  console-errors=${R.errors.length}  failed-resp=${R.failed.length}`);
  if (!R.home.ok) console.log('         home frame:', JSON.stringify(R.home.frame));
  if (R.nav && !R.nav.ok) console.log('         nav frame :', JSON.stringify(R.nav.frame || R.nav.error));
  if (R.deep && !R.deep.ok) console.log('         deep frame:', JSON.stringify(R.deep.frame || R.deep.error), 'target=' + R.deep.target);
  if (R.leaksFinal.length) console.log('         leaks:', R.leaksFinal.slice(0, 6).join(' ; '));
}
