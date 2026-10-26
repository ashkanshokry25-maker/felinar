// Does the top URL follow History-API soft navigations inside the frame? (spec 7.2 mirrors on frame 'load' only)
import { startServer } from './server.mjs';
import { withBrowser, sleep } from './lab.mjs';
const gotoRetry = async (page, url) => { for (let i = 0; i < 8; i++) { try { return await page.goto(url, { timeout: 20000 }); } catch (e) { if (i === 7) throw e; await sleep(2500); } } };
const siteDir = new URL('./gen/vite-react/dist-root', import.meta.url).pathname;
const out = {};
await withBrowser(async (browser) => {
  for (const variant of ['mirror on load only (spec 7.2)', 'plus patched history.pushState/replaceState + popstate in frame']) {
    const srv = await startServer({ mode: 'true', siteDir, spa: true });
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    if (variant.startsWith('plus')) {
      // emulate the fix: after each frame load, wrap the frame's history methods so every soft navigation updates the top URL
      await page.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {});
        const hook = () => { try { const f = window.__iframe; const w = f.contentWindow; if (w.__mwHooked) return; w.__mwHooked = true; const sync = () => { const want = w.location.pathname + w.location.search + w.location.hash; if (want !== location.pathname + location.search + location.hash) history.replaceState(null, '', want); }; for (const m of ['pushState', 'replaceState']) { const o = w.history[m]; w.history[m] = function (...a) { const r = o.apply(this, a); sync(); return r; }; } w.addEventListener('popstate', sync); } catch (_) {} };
        const t = setInterval(() => { if (window.__iframe) { window.__iframe.addEventListener('load', hook); hook(); clearInterval(t); } }, 20);
      });
    }
    await gotoRetry(page, srv.url + '/');
    await page.waitForFunction(() => window.__events && window.__events.length > 0); await sleep(1500);
    const fr = page.frames().find((f) => f !== page.mainFrame());
    await fr.click('#to-about'); await sleep(1200);
    const afterNav = await page.evaluate(() => ({ top: location.pathname, frame: window.__iframe.contentWindow.location.pathname, text: window.__iframe.contentWindow.document.body.innerText.slice(0, 60) }));
    await page.reload(); await page.waitForFunction(() => window.__events && window.__events.length > 0); await sleep(1500);
    const afterReload = await page.evaluate(() => ({ top: location.pathname, frame: window.__iframe.contentWindow.location.pathname, text: window.__iframe.contentWindow.document.body.innerText.slice(0, 60) }));
    out[variant] = { afterSoftNavigation: afterNav, afterReload };
    await ctx.close(); await srv.close();
  }
});
console.log(JSON.stringify(out, null, 1));
