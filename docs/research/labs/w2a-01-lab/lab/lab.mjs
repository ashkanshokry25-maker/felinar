import { pathToFileURL } from 'node:url';
const PW_URL = new URL('../../../../../node_modules/playwright/index.mjs', import.meta.url).href;
const _pw = await import(PW_URL);
export const chromium = _pw[process.env.ENGINE || 'chromium'];
export const ENGINE = process.env.ENGINE || 'chromium';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function withBrowser(fn) {
  const browser = await chromium.launch();
  try { return await fn(browser); } finally { await browser.close(); }
}
export const HOST_OWNED = new Set(['/', '/shell.js', '/sw.js']);
// requests that reached the network layer but are not just the host's own shell bootstrap
export function leaks(srv) {
  return srv.netlog.filter((r) => !(HOST_OWNED.has(r.path.split('?')[0]) && r.dest !== 'iframe' && r.dest !== 'frame')).map((r) => `${r.dest || '-'}:${r.path} -> ${r.served}`);
}
export async function frameInfo(page) {
  return page.evaluate(() => {
    const out = { top: location.pathname + location.search + location.hash };
    try { const w = window.__iframe.contentWindow; out.frame = w.location.pathname + w.location.search + w.location.hash; out.h = (w.document.getElementById('h') || w.document.body || {}).textContent; out.title = w.document.title; out.bodyText = (w.document.body ? w.document.body.innerText : '').trim().slice(0, 140); } catch (e) { out.frame = 'ERR ' + e.name; }
    return out;
  });
}
