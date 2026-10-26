// Miner front end (INTERFACES pow-client.js): createMiner({ workerUrl }) runs proof-of-work in
// the classic PoW worker (/_mw/pow-worker.js) so the page stays responsive, and falls back to
// mining inline (pow.js) when there is no Worker constructor (Node, some in-app WebViews), when
// constructing the worker throws (CSP), or when the worker fails to load or crashes; jobs that
// were in flight then finish inline.
//
// miner.mine(entry, bits, { signal, onProgress }) -> { entry, h }; rejects with
// { code: 'E_POW_ABORTED' } when the signal aborts (the worker gets { id, cancel: true }) or
// when the miner is destroyed. onProgress(hashesTried) is an extension to the INTERFACES shape.

import { mine as mineInline, powAbortedError } from './pow.js';

function errorFromWorker(data) {
  if (data && data.code === 'E_POW_ABORTED') return powAbortedError(data.message || undefined);
  const err = new Error((data && data.message) || 'mining failed in the worker');
  err.code = (data && data.code) || 'E_POW';
  return err;
}

/**
 * createMiner({ workerUrl = null, Worker }) -> { mine(entry, bits, { signal, onProgress }), destroy(), mode }
 * `Worker` defaults to globalThis.Worker (injectable for tests). mode is 'worker' or 'inline'.
 */
export function createMiner({ workerUrl = null, Worker: WorkerCtor } = {}) {
  const Ctor = WorkerCtor !== undefined ? WorkerCtor : (typeof Worker === 'function' ? Worker : null);
  let inline = !workerUrl || typeof Ctor !== 'function';
  let destroyed = false;
  let worker = null;
  let nextId = 1;
  const jobs = new Map();
  const inlineRuns = new Set(); // AbortControllers of jobs mining on this thread

  // Inline mining that destroy() can stop too (AbortSignal.any is past the browser floor, so
  // the caller's signal is linked by hand).
  function mineHere(entry, bits, signal, onProgress) {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forward);
    }
    inlineRuns.add(controller);
    const done = () => {
      inlineRuns.delete(controller);
      if (signal) signal.removeEventListener('abort', forward);
    };
    return mineInline(entry, bits, { signal: controller.signal, onProgress }).then(
      (res) => {
        done();
        return res;
      },
      (err) => {
        done();
        throw err;
      },
    );
  }

  function cleanup(job) {
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
  }

  function runInline(job) {
    cleanup(job);
    mineHere(job.entry, job.bits, job.signal, job.onProgress).then(job.resolve, job.reject);
  }

  function failWorker() {
    inline = true;
    if (worker) {
      try {
        worker.terminate();
      } catch (_) {
        // already gone
      }
    }
    worker = null;
    const pending = Array.from(jobs.values());
    jobs.clear();
    for (const job of pending) runInline(job);
  }

  function onMessage(event) {
    const msg = event ? event.data : null;
    if (!msg || typeof msg !== 'object') return;
    const job = jobs.get(msg.id);
    if (!job) return;
    if (msg.progress !== undefined) {
      if (job.onProgress) {
        try {
          job.onProgress(msg.progress);
        } catch (_) {
          // progress callbacks never break mining
        }
      }
      return;
    }
    jobs.delete(msg.id);
    cleanup(job);
    if (msg.error) job.reject(errorFromWorker(msg.error));
    else job.resolve({ entry: msg.entry, h: msg.h });
  }

  function onError(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    failWorker();
  }

  function ensureWorker() {
    if (!worker) {
      worker = new Ctor(workerUrl);
      worker.onmessage = onMessage;
      worker.onerror = onError;
      worker.onmessageerror = onError;
    }
    return worker;
  }

  function mine(entry, bits, { signal = null, onProgress = null } = {}) {
    if (destroyed) return Promise.reject(powAbortedError('miner destroyed'));
    if (signal && signal.aborted) return Promise.reject(powAbortedError());
    if (inline || bits === 0) return mineHere(entry, bits, signal, onProgress);
    let w;
    try {
      w = ensureWorker();
    } catch (_) {
      inline = true;
      worker = null;
      return mineHere(entry, bits, signal, onProgress);
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const job = { id, entry, bits, signal, onProgress, resolve, reject, onAbort: null };
      if (signal) {
        job.onAbort = () => {
          if (jobs.get(id) !== job) return;
          jobs.delete(id);
          cleanup(job);
          try {
            if (worker) worker.postMessage({ id, cancel: true });
          } catch (_) {
            // the worker is gone; nothing to cancel
          }
          reject(powAbortedError());
        };
        signal.addEventListener('abort', job.onAbort);
      }
      jobs.set(id, job);
      try {
        w.postMessage({ id, entry, bits });
      } catch (_) {
        // DataCloneError or a dead worker: mine this job inline.
        jobs.delete(id);
        runInline(job);
      }
    });
  }

  function destroy() {
    destroyed = true;
    if (worker) {
      try {
        worker.terminate();
      } catch (_) {
        // already gone
      }
    }
    worker = null;
    const pending = Array.from(jobs.values());
    jobs.clear();
    for (const job of pending) {
      cleanup(job);
      job.reject(powAbortedError('miner destroyed'));
    }
    for (const controller of Array.from(inlineRuns)) controller.abort();
  }

  return {
    mine,
    destroy,
    get mode() {
      return inline ? 'inline' : 'worker';
    },
  };
}
