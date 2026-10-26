// Bench 2: nostr-tools verifyEvent on FRESH (JSON-cloned) events so the verifiedSymbol cache cannot be hit.
import { finalizeEvent, verifyEvent, generateSecretKey } from 'nostr-tools/pure';
import * as wasmMod from 'nostr-tools/wasm';
import { initNostrWasm } from 'nostr-wasm';
const N = 3000;
const mk = () => { const sk = generateSecretKey(); return finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'x'.repeat(64)], ['t', 'y'.repeat(64)]], content: 'z'.repeat(900) }, sk); };
const evs = Array.from({ length: N }, mk);
const size = new TextEncoder().encode(JSON.stringify(evs[0])).length;
const clone = () => evs.map((e) => JSON.parse(JSON.stringify(e)));
let a = clone();
let t0 = performance.now(); let ok = 0; for (const e of a) ok += verifyEvent(e) ? 1 : 0; let dt = performance.now() - t0;
console.log(JSON.stringify({ name: 'nostr-tools 2.25.2 verifyEvent JS (fresh objects)', n: N, ok, ops_s: Math.round(N / dt * 1000), us_op: Math.round(dt / N * 1000), event_bytes: size }));
// second pass on JS: first-use JIT warmed
a = clone(); t0 = performance.now(); ok = 0; for (const e of a) ok += verifyEvent(e) ? 1 : 0; dt = performance.now() - t0;
console.log(JSON.stringify({ name: 'nostr-tools verifyEvent JS (fresh objects, warm)', n: N, ok, ops_s: Math.round(N / dt * 1000), us_op: Math.round(dt / N * 1000) }));
wasmMod.setNostrWasm(await initNostrWasm());
a = clone(); t0 = performance.now(); ok = 0; for (const e of a) ok += wasmMod.verifyEvent(e) ? 1 : 0; dt = performance.now() - t0;
console.log(JSON.stringify({ name: 'nostr-tools/wasm verifyEvent (nostr-wasm 0.1.0, fresh)', n: N, ok, ops_s: Math.round(N / dt * 1000), us_op: Math.round(dt / N * 1000) }));
a = clone(); t0 = performance.now(); ok = 0; for (const e of a) ok += wasmMod.verifyEvent(e) ? 1 : 0; dt = performance.now() - t0;
console.log(JSON.stringify({ name: 'nostr-tools/wasm verifyEvent (warm)', n: N, ok, ops_s: Math.round(N / dt * 1000), us_op: Math.round(dt / N * 1000) }));
// tampered content must fail
const bad = JSON.parse(JSON.stringify(evs[0])); bad.content = 'tampered';
console.log(JSON.stringify({ tamper_detected_js: !verifyEvent(bad), tamper_detected_wasm: !wasmMod.verifyEvent(JSON.parse(JSON.stringify(bad))) }));
