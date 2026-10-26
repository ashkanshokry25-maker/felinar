// src/dropin/schedule.js: when drop-in work may start (ARCHITECTURE §3.4.3, §3.4.6).
//
//   onWindowLoad(win, fn)          run fn once, after the window `load` event (now when it already fired)
//   runWhenIdle(win, fn, opts)     run fn at requestIdleCallback, or after a short setTimeout where
//                                  there is none (Safari); cancel() before it runs stops it
//   createVisibleTimer(opts)       fires once after `ms` of cumulative VISIBLE time (3 s): hidden time
//                                  does not count, so click-through visitors and background tabs never
//                                  announce; reset() starts the count again (back/forward-cache restore)
//
// Everything takes its clock and timers as options so Node tests drive them by hand.

export const VISIBLE_ANNOUNCE_MS = 3000;
export const IDLE_TIMEOUT_MS = 2000;
export const IDLE_FALLBACK_MS = 200;

function realTimers() {
  return {
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id) => clearTimeout(id),
    now: () => Date.now(),
  };
}

/** onWindowLoad(win, fn) → cancel(). fn runs once, never synchronously. */
export function onWindowLoad(win, fn, { doc = (win && win.document) || null } = {}) {
  let done = false;
  let cancelled = false;
  const run = () => {
    if (done || cancelled) return;
    done = true;
    fn();
  };
  if (!doc || doc.readyState === 'complete' || !win || typeof win.addEventListener !== 'function') {
    Promise.resolve().then(run);
    return () => { cancelled = true; };
  }
  win.addEventListener('load', run, { once: true });
  return () => {
    cancelled = true;
    if (typeof win.removeEventListener === 'function') win.removeEventListener('load', run);
  };
}

/** runWhenIdle(win, fn, { timeout, fallbackMs, setTimeoutFn, clearTimeoutFn }) → cancel(). */
export function runWhenIdle(win, fn, opts = {}) {
  const real = realTimers();
  const t = {
    setTimeoutFn: typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : real.setTimeoutFn,
    clearTimeoutFn: typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : real.clearTimeoutFn,
  };
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : IDLE_TIMEOUT_MS;
  const fallbackMs = typeof opts.fallbackMs === 'number' ? opts.fallbackMs : IDLE_FALLBACK_MS;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (win && typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(run, { timeout });
    return () => {
      done = true;
      if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(id);
    };
  }
  const id = t.setTimeoutFn(run, fallbackMs);
  return () => {
    done = true;
    t.clearTimeoutFn(id);
  };
}

/**
 * createVisibleTimer({ doc, ms, onElapsed, setTimeoutFn, clearTimeoutFn, now })
 *   → { start(), cancel(), reset(), elapsedMs(), fired }
 * start() begins counting while doc.visibilityState is 'visible' and follows visibilitychange:
 * hidden pauses, visible resumes with the time that is left. onElapsed() runs once.
 */
export function createVisibleTimer({ doc, ms = VISIBLE_ANNOUNCE_MS, onElapsed, setTimeoutFn, clearTimeoutFn, now } = {}) {
  const real = realTimers();
  const setT = typeof setTimeoutFn === 'function' ? setTimeoutFn : real.setTimeoutFn;
  const clearT = typeof clearTimeoutFn === 'function' ? clearTimeoutFn : real.clearTimeoutFn;
  const clock = typeof now === 'function' ? now : real.now;
  let acc = 0;
  let since = null;
  let timer = null;
  let fired = false;
  let started = false;
  let listening = false;

  const isVisible = () => !doc || doc.visibilityState === 'visible';

  function fire() {
    if (fired) return;
    fired = true;
    detach();
    if (typeof onElapsed === 'function') onElapsed();
  }

  function arm() {
    if (fired || timer !== null) return;
    const remaining = ms - acc;
    if (remaining <= 0) {
      fire();
      return;
    }
    since = clock();
    timer = setT(() => {
      timer = null;
      since = null;
      acc = ms;
      fire();
    }, remaining);
  }

  function pause() {
    if (timer === null) return;
    clearT(timer);
    timer = null;
    acc += Math.max(0, clock() - since);
    since = null;
  }

  function onVisibility() {
    if (!started || fired) return;
    if (isVisible()) arm();
    else pause();
  }

  function attach() {
    if (listening || !doc || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('visibilitychange', onVisibility);
    listening = true;
  }

  function detach() {
    if (!listening) return;
    listening = false;
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    start() {
      if (started) return;
      started = true;
      attach();
      if (isVisible()) arm();
    },
    cancel() {
      started = false;
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      since = null;
      detach();
    },
    reset() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      acc = 0;
      since = null;
      fired = false;
      started = true;
      attach();
      if (isVisible()) arm();
    },
    elapsedMs() {
      return fired ? ms : acc + (since === null ? 0 : Math.max(0, clock() - since));
    },
    get fired() { return fired; },
  };
}
