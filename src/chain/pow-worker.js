// Classic-worker entry served as /_mw/pow-worker.js. build.mjs bundles it with esbuild as an
// IIFE (format 'iife'): module workers need Firefox 147+ (ARCHITECTURE 1), so this file must stay
// free of top-level await and must not rely on `import` at run time.
//
// Protocol (INTERFACES pow-worker.js):
//   in  { id, entry, bits }           out { id, progress: hashesTried } about every 2 000 hashes,
//                                     then { id, entry, h } or { id, error: { code, message } }
//   in  { id, cancel: true }          aborts that job, which answers
//                                     { id, error: { code: 'E_POW_ABORTED', message } }
//   in  { id, verify: block, opts }   out { id, result: { ok: true } | { ok: false, reason } }
//                                     (block.js validateBlock, used by verify-pool.js)
// self.onmessage is installed only in a dedicated worker scope (no `window`, a postMessage).

import { mine } from './pow.js';
import { validateBlock } from './block.js';

/** Wires the protocol onto a worker-like scope ({ postMessage, onmessage }); returns the scope. */
export function installWorker(scope) {
  const jobs = new Map();
  const post = (msg) => {
    try {
      scope.postMessage(msg);
    } catch (_) {
      // The scope is closing; nothing left to tell.
    }
  };
  scope.onmessage = (event) => {
    const msg = event ? event.data : null;
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    if (msg.cancel === true) {
      const job = jobs.get(id);
      if (job) job.abort();
      return;
    }
    if (msg.verify !== undefined) {
      validateBlock(msg.verify, msg.opts || {}).then(
        (result) => post({ id, result }),
        () => post({ id, result: { ok: false, reason: 'shape' } }),
      );
      return;
    }
    if (msg.entry !== undefined) {
      const controller = new AbortController();
      jobs.set(id, controller);
      mine(msg.entry, msg.bits, { signal: controller.signal, onProgress: (hashes) => post({ id, progress: hashes }) })
        .then(
          (res) => post({ id, entry: res.entry, h: res.h }),
          (err) => post({
            id,
            error: {
              code: (err && err.code) || 'E_POW',
              message: String((err && err.message) || err),
            },
          }),
        )
        .then(() => {
          if (jobs.get(id) === controller) jobs.delete(id);
        });
    }
  };
  return scope;
}

if (typeof window === 'undefined' && typeof self === 'object' && self !== null &&
  typeof self.postMessage === 'function') {
  installWorker(self);
}
