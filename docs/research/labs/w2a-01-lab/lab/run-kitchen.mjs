import { startServer } from './server.mjs';
import { withBrowser, sleep, leaks, frameInfo } from './lab.mjs';
import fs from 'node:fs';
const siteName = process.argv[3] || 'kitchen';
const site = new URL('./sites/' + siteName, import.meta.url).pathname;
const modes = (process.argv[2] || 'prefix,remap,true').split(',');
const all = {};
const gotoRetry = async (page, url) => { for (let i = 0; i < 8; i++) { try { return await page.goto(url, { timeout: 20000 }); } catch (e) { if (i === 7) throw e; await sleep(2500); } } };
await withBrowser(async (browser) => {
  for (const mode of modes) {
    const srv = await startServer({ mode, siteDir: site, spa: false });
    const ctx = await browser.newContext();
    const R = { mode, checks: {}, interactions: {}, leaksAfterLoad: [], console: [] };
    const page = await ctx.newPage();
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) R.console.push(m.type() + ': ' + m.text().slice(0, 140)); });
    page.on('pageerror', (e) => R.console.push('pageerror: ' + String(e).slice(0, 140)));
    await gotoRetry(page, srv.url + '/');
    try { await page.waitForFunction(() => window.__events && window.__events.length > 0, null, { timeout: 20000 }); } catch (e) { R.checks = { TIMEOUT: String(e).slice(0, 100) }; }
    await sleep(2500);
    R.checks = await page.evaluate(() => window.__checks || { NONE: { ok: false, e: 'site main script never reported (it did not run)' } });
    R.afterLoad = await frameInfo(page);
    R.leaksAfterLoad = leaks(srv);
    const interact = async (name, fn) => {
      const p2 = await ctx.newPage(); p2.on('pageerror', () => {});
      const before = srv.netlog.length;
      try {
        await gotoRetry(p2, srv.url + '/');
        await p2.waitForFunction(() => window.__events && window.__events.length > 0, null, { timeout: 20000 });
        await sleep(1500);
        const fr = p2.frames().find((f) => f !== p2.mainFrame());
        await fn(p2, fr);
        await sleep(900);
        R.interactions[name] = { ...(await frameInfo(p2)), newNet: srv.netlog.slice(before).filter((r) => r.path !== '/' && !r.path.startsWith('/shell.js') ).map((r) => `${r.dest || '-'}:${r.path}->${r.served}`) };
      } catch (e) { R.interactions[name] = { error: String(e).slice(0, 200) }; }
      await p2.close();
    };
    await interact('click root-abs link /about.html', async (p, fr) => fr.click('#a-abs'));
    await interact('click relative link about.html', async (p, fr) => fr.click('#a-rel'));
    await interact('click #frag link', async (p, fr) => fr.click('#a-frag'));
    await interact('submit GET form action=/search', async (p, fr) => fr.click('#f-go'));
    await interact('click target=_top root-abs link', async (p, fr) => fr.click('#a-top'));
    await interact('pushState(/pushed) then reload shell', async (p, fr) => { await fr.evaluate(() => history.pushState({}, '', '/pushed')); await p.reload(); await p.waitForFunction(() => window.__iframe, null, { timeout: 10000 }); });
    R.swDecisions = srv.swlog.map((e) => `${e.dest || '-'}${e.rmode === 'navigate' ? '(nav)' : ''} ${e.path} client=${e.cFrame || (e.cUrl === null ? 'unknown' : '-')}${e.cUrl ? ':' + e.cUrl : ''} => ${e.by}`);
    all[mode] = R;
    R.site = siteName;
    await ctx.close(); await srv.close();
  }
});
fs.writeFileSync(new URL('./results-' + siteName + '.' + (process.env.ENGINE || 'chromium') + '.json', import.meta.url).pathname, JSON.stringify(all, null, 2));
for (const m of modes) {
  const R = all[m];
  console.log('\n==================== MODE', m);
  for (const [k, v] of Object.entries(R.checks)) console.log((v.ok ? 'PASS ' : 'FAIL ') + k.padEnd(36), v.ok ? JSON.stringify(v.v).slice(0, 110) : v.e);
  console.log('after load:', JSON.stringify(R.afterLoad));
  console.log('NETWORK LEAKS after initial load:'); for (const l of R.leaksAfterLoad) console.log('   ', l);
  console.log('INTERACTIONS:'); for (const [k, v] of Object.entries(R.interactions)) console.log('  *', k, '\n      ', JSON.stringify(v));
  if (R.console.length) { console.log('CONSOLE:'); for (const c of R.console.slice(0, 12)) console.log('   ', c); }
}
