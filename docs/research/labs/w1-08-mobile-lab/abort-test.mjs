import fs from 'node:fs'; import vm from 'node:vm';
const native = typeof AbortSignal.timeout;
delete AbortSignal.timeout;
vm.runInThisContext(fs.readFileSync(new URL('./abort-polyfill.js', import.meta.url), 'utf8'));
const s = AbortSignal.timeout(50);
const t0 = Date.now();
await new Promise(r => s.addEventListener('abort', r));
console.log(JSON.stringify({ nativeBefore: native, installed: typeof AbortSignal.timeout, aborted: s.aborted, reasonName: s.reason && s.reason.name, ms: Date.now() - t0 }));
// use with fetch against a hanging local server
import http from 'node:http';
const srv = http.createServer((req, res) => { /* hang */ }).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const t1 = Date.now();
try { await fetch('http://127.0.0.1:' + srv.address().port, { signal: AbortSignal.timeout(200) }); } catch (e) { console.log('fetch aborted:', e.name, '| after ms', Date.now() - t1); }
srv.closeAllConnections(); srv.close();
