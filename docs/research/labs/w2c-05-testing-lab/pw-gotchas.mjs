import http from 'node:http';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { WebSocketServer } from '../../../../node_modules/ws/wrapper.mjs';

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
wss.on('connection', (c) => c.on('message', (m) => c.send('REAL:' + m)));
await new Promise((r) => wss.on('listening', r));
const WS_URL = `ws://127.0.0.1:${wss.address().port}/t`;

const SW = `self.addEventListener('install',e=>self.skipWaiting()); self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.__boot = Date.now() + ':' + Math.random().toString(36).slice(2,8);
self.addEventListener('fetch',e=>{ const u=new URL(e.request.url); if(u.pathname==='/_mw/date'){ e.respondWith(new Response(JSON.stringify({now:Date.now(),boot:self.__boot}),{headers:{'content-type':'application/json'}})); }
  if(u.pathname==='/_mw/ws'){ e.respondWith(new Promise((res)=>{ try{ const w=new WebSocket('${WS_URL}'); w.onopen=()=>w.send('from-sw'); w.onmessage=(m)=>{res(new Response(m.data)); w.close();}; w.onerror=()=>res(new Response('ws-error')); setTimeout(()=>res(new Response('ws-timeout')),3000);}catch(err){res(new Response('ws-throw '+err.message));} })); } });`;
const WORKER = `self.onmessage=async(e)=>{ if(e.data==='date') postMessage({now:Date.now(), perf: performance.now()>0}); if(e.data==='ws'){ try{ const w=new WebSocket('${WS_URL}'); w.onopen=()=>w.send('from-worker'); w.onmessage=(m)=>{postMessage({ws:m.data}); w.close();}; w.onerror=()=>postMessage({ws:'ws-error'}); setTimeout(()=>postMessage({ws:'ws-timeout'}),3000);}catch(err){postMessage({ws:'ws-throw '+err.message});} } };`;
const server = http.createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  if (p === '/sw.js') { r.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }); return r.end(SW); }
  if (p === '/worker.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(WORKER); }
  if (p.startsWith('/_mw/')) { r.writeHead(404); return r.end('NOT FROM SW'); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>g</title><body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });

// 1. page.clock vs workers / service worker
{
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2030-01-01T00:00:00Z'));
  await page.goto(url);
  const res = await page.evaluate(async () => {
    const out = { pageNow: new Date(Date.now()).toISOString() };
    const w = new Worker('/worker.js'); out.workerNow = await new Promise((r) => { w.onmessage = (e) => r(new Date(e.data.now).toISOString()); w.postMessage('date'); }); w.terminate();
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    const j = await (await fetch('/_mw/date')).json(); out.swNow = new Date(j.now).toISOString();
    return out;
  });
  console.log('1) page.clock.setFixedTime(2030-01-01): ', JSON.stringify(res), '| real now:', new Date().toISOString());
  await ctx.close();
}
// 2. routeWebSocket scope: page vs dedicated worker vs service worker
{
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  let routed = 0;
  await page.routeWebSocket(WS_URL, (ws) => { routed++; ws.onMessage((m) => ws.send('MOCK:' + m)); });
  await page.goto(url);
  const res = await page.evaluate(async (WS_URL) => {
    const out = {};
    out.page = await new Promise((r) => { const w = new WebSocket(WS_URL); w.onopen = () => w.send('from-page'); w.onmessage = (m) => { r(m.data); w.close(); }; w.onerror = () => r('error'); setTimeout(() => r('timeout'), 3000); });
    const wk = new Worker('/worker.js'); out.worker = await new Promise((r) => { wk.onmessage = (e) => { if (e.data.ws) r(e.data.ws); }; wk.postMessage('ws'); }); wk.terminate();
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    out.sw = await (await fetch('/_mw/ws')).text();
    return out;
  }, WS_URL);
  console.log('2) page.routeWebSocket mock answers MOCK:*, real server answers REAL:* =>', JSON.stringify(res), '| mock handler invocations', routed);
  // also context-level
  await ctx.close();
}
{
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  let routed = 0; let has = typeof ctx.routeWebSocket;
  if (has === 'function') await ctx.routeWebSocket(WS_URL, (ws) => { routed++; ws.onMessage((m) => ws.send('MOCK:' + m)); });
  await page.goto(url);
  const res = await page.evaluate(async (WS_URL) => {
    const out = {};
    const wk = new Worker('/worker.js'); out.worker = await new Promise((r) => { wk.onmessage = (e) => { if (e.data.ws) r(e.data.ws); }; wk.postMessage('ws'); }); wk.terminate();
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    out.sw = await (await fetch('/_mw/ws')).text();
    return out;
  }, WS_URL);
  console.log('2b) context.routeWebSocket typeof =', has, '=>', JSON.stringify(res), '| invocations', routed);
  await ctx.close();
}
// 3. CDP ServiceWorker.stopAllWorkers: does SW restart on next fetch? (state is lost: boot id changes)
{
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(url);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })); });
  const cdp = await ctx.newCDPSession(page);
  const versions = []; cdp.on('ServiceWorker.workerVersionUpdated', (e) => e.versions.forEach((v) => versions.push(v.runningStatus + '/' + v.status)));
  await cdp.send('ServiceWorker.enable');
  const before = await page.evaluate(async () => (await (await fetch('/_mw/date')).json()).boot);
  await cdp.send('ServiceWorker.stopAllWorkers');
  await new Promise((r) => setTimeout(r, 500));
  const after = await page.evaluate(async () => (await (await fetch('/_mw/date')).json()).boot);
  console.log('3) SW global state across stopAllWorkers: boot before', before, 'after', after, '=>', before === after ? 'SAME (not restarted?)' : 'DIFFERENT (SW restarted, in-memory state lost)', '| runningStatus events:', [...new Set(versions)].join(','));
  await ctx.close();
}
await browser.close(); server.close(); wss.close();
