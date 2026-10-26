// A manual clock for the drop-in unit tests: setTimeout / clearTimeout / now that only move when
// the test calls advance(ms), so timing rules (3 s visible, 15 s waits, back-off) are exact.

export function createClock(start = 1000000) {
  let current = start;
  let seq = 0;
  const timers = new Map();

  function nextDue(limit) {
    let best = null;
    for (const [id, t] of timers) {
      if (t.at <= limit && (best === null || t.at < best.at || (t.at === best.at && id < best.id))) best = { id, at: t.at };
    }
    return best;
  }

  return {
    now: () => current,
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      timers.set(id, { at: current + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    /** Runs every timer due within `ms` in order (timers they schedule inside the window run too). */
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        const t = timers.get(due.id);
        timers.delete(due.id);
        current = Math.max(current, t.at);
        t.fn();
      }
      current = target;
    },
    pending: () => timers.size,
    /** The timer functions in the shape src/dropin takes them. */
    timers() {
      return { setTimeoutFn: this.setTimeout, clearTimeoutFn: this.clearTimeout, now: this.now };
    },
  };
}

/** Lets promise continuations (and the ones they queue) run. */
export async function flush(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
