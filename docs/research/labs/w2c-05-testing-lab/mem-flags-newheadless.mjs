import http from 'node:http';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
const mk = (coi) => http.createServer((q, r) => { const h = { 'content-type': 'text/html' }; if (coi) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; } r.writeHead(200, h); r.end('<!doctype html><title>m</title><body>'); });
async function run(label, coi, args) {
  const s = mk(coi); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = await chromium.launch({ headless: true, channel: 'chromium', args });
  const p = await b.newPage(); await p.goto(`http://localhost:${s.address().port}/`);
  const out = await p.evaluate(async () => {
    const r = { crossOriginIsolated, hasGc: typeof gc, perfMemory: !!performance.memory, mUASM: typeof performance.measureUserAgentSpecificMemory };
    const heap = () => { const m = performance.memory; return m ? m.usedJSHeapSize : null; };
    r.h0 = heap(); window.junk = Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x' + i })); r.h1 = heap(); window.junk = null; if (typeof gc === 'function') gc(); r.h2 = heap();
    if (performance.measureUserAgentSpecificMemory) { try { const t0 = performance.now(); const m = await performance.measureUserAgentSpecificMemory(); r.uasmBytes = m.bytes; r.uasmMs = Math.round(performance.now() - t0); r.uasmBreakdown = m.breakdown.length; } catch (e) { r.uasmErr = e.name + ': ' + e.message; } }
    return r;
  });
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Performance.enable'); const pm = await cdp.send('Performance.getMetrics'); const jsh = pm.metrics.find((m) => m.name === 'JSHeapUsedSize');
  await cdp.send('HeapProfiler.collectGarbage'); const hu = await cdp.send('Runtime.getHeapUsage'); const dom = await cdp.send('Memory.getDOMCounters');
  console.log(label, JSON.stringify(out), '| CDP JSHeapUsedSize', jsh && Math.round(jsh.value), '| getHeapUsage(after GC)', Math.round(hu.usedSize), '| DOMCounters', JSON.stringify(dom));
  await b.close(); s.close();
}
await run('A) default flags, no COI              ', false, []);
await run('B) --js-flags=--expose-gc, no COI      ', false, ['--js-flags=--expose-gc']);
await run('C) +--enable-precise-memory-info       ', false, ['--js-flags=--expose-gc', '--enable-precise-memory-info']);
await run('D) +COOP/COEP headers (COI)            ', true, ['--js-flags=--expose-gc', '--enable-precise-memory-info']);
await run('E) +COI +ForceEagerMeasureMemory       ', true, ['--js-flags=--expose-gc', '--enable-precise-memory-info', '--enable-blink-features=ForceEagerMeasureMemory']);
