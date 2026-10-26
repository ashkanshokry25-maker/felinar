import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http';
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 100000);
const frameHtml = `<!doctype html><meta charset="utf-8"><body>
<a id="plain" href="mailto:owner@example.com?subject=hi">plain mailto link</a>
<a id="blank" target="_blank" href="mailto:owner@example.com?subject=hi">target=_blank mailto</a>
<button id="loc" onclick="location.href='mailto:owner@example.com?subject=hi'">location.href</button>
<button id="top" onclick="window.top.location.href='mailto:owner@example.com?subject=hi'">top.location.href</button>
<a id="https" href="https://checkout.stripe.example/c/pay/cs_test_123">https link (Stripe-like) in same frame</a>
<a id="httpsTop" target="_top" href="http://localhost/__top_target">https link target=_top</a>`;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/frame') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(frameHtml); }
  if (u.pathname === '/__top_target') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>TOP TARGET REACHED</title>top target'); }
  if (u.pathname === '/') { const sb = u.searchParams.get('sb'); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>shell</title><iframe id="f" ${sb === 'none' ? '' : `sandbox="${sb}"`} src="/frame" style="width:600px;height:300px"></iframe>`); }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://localhost:${srv.address().port}`;
const browser = await chromium.launch({ headless: true });
const variants = {
  'design flags (allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation)': 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation',
  'without allow-popups': 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation',
  'without allow-top-navigation-by-user-activation': 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
  'no sandbox at all (baseline)': 'none',
};
for (const [label, sb] of Object.entries(variants)) {
  console.log('\n### ' + label);
  for (const id of ['plain', 'blank', 'loc', 'top', 'httpsTop']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const msgs = [];
    page.on('console', (m) => msgs.push(m.type() + ': ' + m.text().slice(0, 200)));
    const popups = [];
    page.on('popup', (p) => popups.push(p.url()));
    await page.goto(base + '/?sb=' + encodeURIComponent(sb));
    const fr = await (await page.$('#f')).contentFrame();
    await fr.waitForSelector('#' + id);
    await fr.click('#' + id, { timeout: 5000 }).catch((e) => msgs.push('clickerr ' + String(e).slice(0, 80)));
    await page.waitForTimeout(700);
    console.log(`  ${id.padEnd(8)} topUrl=${page.url().replace(base, '')} popups=${JSON.stringify(popups.map((x) => x.slice(0, 40)))} console=${JSON.stringify(msgs.filter((m) => !m.includes('escape its sandboxing')).slice(0, 2))}`);
    await ctx.close();
  }
}
await browser.close(); srv.close(); process.exit(0);
