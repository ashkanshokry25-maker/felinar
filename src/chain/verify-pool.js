// Block verification off the main thread (INTERFACES verify-pool.js, ARCHITECTURE 5.5: the site
// renders before the ledger syncs; signatures verify in a worker pool).
//
// createVerifierPool({ size = 2, workerUrl }) spreads validateBlock calls over up to `size`
// dedicated workers running the PoW worker bundle (/_mw/pow-worker.js answers
// { id, verify: block, opts } with { id, result }). Without workerUrl, without a Worker
// constructor (Node), or after a worker fails, it verifies inline with the same function, so
// results never depend on where they were computed.

import { validateBlock } from './block.js';

function closedError() {
  const err = new Error('verifier pool destroyed');
  err.code = 'E_ABORTED';
  return err;
}

/**
 * createVerifierPool({ size = 2, workerUrl = null, Worker })
 *   -> { verifyBlock(block, opts) -> Promise<{ ok } | { ok: false, reason }>,
 *       verifyBlocks(blocks, opts) -> Promise<results[]>, destroy(), mode }
 * opts are validateBlock's options. `Worker` defaults to globalThis.Worker (injectable for tests).
 */
export function createVerifierPool({ size = 2, workerUrl = null, Worker: WorkerCtor } = {}) {
  const Ctor = WorkerCtor !== undefined ? WorkerCtor : (typeof Worker === 'function' ? Worker : null);
  const max = Math.max(1, Math.min(16, Math.floor(Number(size)) || 1));
  let useWorkers = Boolean(workerUrl) && typeof Ctor === 'function';
  let destroyed = false;
  let nextId = 1;
  const slots = [];

  function inline(block, opts) {
    return validateBlock(block, opts);
  }

  function retire(slot) {
    if (slot.dead) return;
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch (_) {
      // already gone
    }
    const pending = Array.from(slot.pending.values());
    slot.pending.clear();
    for (const job of pending) inline(job.block, job.opts).then(job.resolve, job.reject);
    if (slots.every((s) => s.dead)) useWorkers = false;
  }

  function spawn() {
    const slot = { worker: null, pending: new Map(), dead: false };
    slot.worker = new Ctor(workerUrl);
    slot.worker.onmessage = (event) => {
      const msg = event ? event.data : null;
      if (!msg || typeof msg !== 'object' || msg.result === undefined) return;
      const job = slot.pending.get(msg.id);
      if (!job) return;
      slot.pending.delete(msg.id);
      job.resolve(msg.result);
    };
    slot.worker.onerror = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      retire(slot);
    };
    slot.worker.onmessageerror = slot.worker.onerror;
    slots.push(slot);
    return slot;
  }

  function pick() {
    let best = null;
    for (const s of slots) if (!s.dead && (best === null || s.pending.size < best.pending.size)) best = s;
    const alive = slots.filter((s) => !s.dead).length;
    if ((best === null || best.pending.size > 0) && slots.length < max) {
      try {
        return spawn();
      } catch (_) {
        if (best === null) useWorkers = false;
      }
    }
    return alive > 0 ? best : null;
  }

  function verifyBlock(block, opts = {}) {
    if (destroyed) return Promise.reject(closedError());
    const slot = useWorkers ? pick() : null;
    if (!slot) return inline(block, opts);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const job = { block, opts, resolve, reject };
      slot.pending.set(id, job);
      try {
        slot.worker.postMessage({ id, verify: block, opts });
      } catch (_) {
        slot.pending.delete(id);
        inline(block, opts).then(resolve, reject);
      }
    });
  }

  function verifyBlocks(blocks, opts = {}) {
    return Promise.all(Array.from(blocks, (b) => verifyBlock(b, opts)));
  }

  function destroy() {
    destroyed = true;
    for (const slot of slots) {
      slot.dead = true;
      try {
        slot.worker.terminate();
      } catch (_) {
        // already gone
      }
      const pending = Array.from(slot.pending.values());
      slot.pending.clear();
      for (const job of pending) job.reject(closedError());
    }
  }

  return {
    verifyBlock,
    verifyBlocks,
    destroy,
    get mode() {
      return useWorkers ? 'worker' : 'inline';
    },
  };
}
