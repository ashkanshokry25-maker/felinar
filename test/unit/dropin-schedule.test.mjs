// Unit tests for src/dropin/schedule.js: after-load, idle start with a setTimeout fallback, and the
// "3 s visible" announce timer (hidden time does not count). Fake clock, fake document, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { createClock, flush } from './dropin-fake-timers.mjs';
import { onWindowLoad, runWhenIdle, createVisibleTimer, VISIBLE_ANNOUNCE_MS, IDLE_FALLBACK_MS } from '../../src/dropin/schedule.js';

test('onWindowLoad: a finished load runs fn once, asynchronously', async () => {
  const doc = new FakeDocument({ readyState: 'complete' });
  const win = new FakeDocument();
  win.document = doc;
  let calls = 0;
  onWindowLoad(win, () => { calls++; });
  assert.equal(calls, 0, 'never synchronous');
  await flush();
  assert.equal(calls, 1);
});

test('onWindowLoad: waits for the load event, runs once, and can be cancelled', async () => {
  const doc = new FakeDocument({ readyState: 'loading' });
  const win = new FakeDocument();
  win.document = doc;
  let calls = 0;
  onWindowLoad(win, () => { calls++; });
  const second = onWindowLoad(win, () => { calls += 10; });
  second();
  win.dispatchEvent({ type: 'load' });
  win.dispatchEvent({ type: 'load' });
  await flush();
  assert.equal(calls, 1, 'one run, the cancelled one never ran');
  const cancelledAlready = onWindowLoad(new FakeDocument(), () => { calls += 100; }, { doc: new FakeDocument({ readyState: 'complete' }) });
  cancelledAlready();
  await flush();
  assert.equal(calls, 1);
});

test('runWhenIdle: uses requestIdleCallback with a timeout; cancel stops it', () => {
  const seen = [];
  const win = {
    requestIdleCallback(fn, opts) { seen.push({ fn, opts }); return 7; },
    cancelIdleCallback(id) { seen.push({ cancelled: id }); },
  };
  let ran = 0;
  const cancel = runWhenIdle(win, () => { ran++; }, { timeout: 1500 });
  assert.equal(seen[0].opts.timeout, 1500);
  seen[0].fn();
  seen[0].fn();
  assert.equal(ran, 1, 'once');
  const cancel2 = runWhenIdle(win, () => { ran += 10; });
  cancel2();
  assert.deepEqual(seen[seen.length - 1], { cancelled: 7 });
  seen[1].fn();
  assert.equal(ran, 1, 'a cancelled callback that still fires does nothing');
  cancel();
});

test('runWhenIdle: without requestIdleCallback it falls back to a short setTimeout', () => {
  const clock = createClock();
  let ran = 0;
  runWhenIdle({}, () => { ran++; }, clock.timers());
  clock.advance(IDLE_FALLBACK_MS - 1);
  assert.equal(ran, 0);
  clock.advance(1);
  assert.equal(ran, 1);
  const cancel = runWhenIdle({}, () => { ran += 10; }, Object.assign({ fallbackMs: 50 }, clock.timers()));
  cancel();
  clock.advance(1000);
  assert.equal(ran, 1);
  assert.equal(clock.pending(), 0, 'no timer left behind');
});

test('visible timer: fires after 3 s of continuous visibility, once', () => {
  const clock = createClock();
  const doc = new FakeDocument();
  let fired = 0;
  const timer = createVisibleTimer({ doc, onElapsed: () => { fired++; }, ...clock.timers() });
  timer.start();
  assert.equal(VISIBLE_ANNOUNCE_MS, 3000);
  clock.advance(2999);
  assert.equal(fired, 0);
  assert.equal(timer.elapsedMs(), 2999);
  clock.advance(1);
  assert.equal(fired, 1);
  assert.equal(timer.fired, true);
  clock.advance(60000);
  doc.setVisibility('hidden');
  doc.setVisibility('visible');
  assert.equal(fired, 1, 'never again');
  assert.equal(timer.elapsedMs(), 3000);
});

test('visible timer: hidden time does not count and the rest resumes when visible again', () => {
  const clock = createClock();
  const doc = new FakeDocument();
  let fired = 0;
  const timer = createVisibleTimer({ doc, onElapsed: () => { fired++; }, ...clock.timers() });
  timer.start();
  clock.advance(2000);
  doc.setVisibility('hidden');
  assert.equal(clock.pending(), 0, 'the timer is paused, not running in the background');
  clock.advance(60000);
  assert.equal(fired, 0, 'a background tab never announces');
  assert.equal(timer.elapsedMs(), 2000);
  doc.setVisibility('visible');
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1, '2 s + 1 s visible');
});

test('visible timer: started while hidden waits for the first visible moment', () => {
  const clock = createClock();
  const doc = new FakeDocument({ visibilityState: 'hidden' });
  let fired = 0;
  const timer = createVisibleTimer({ doc, ms: 1000, onElapsed: () => { fired++; }, ...clock.timers() });
  timer.start();
  clock.advance(10000);
  assert.equal(fired, 0);
  doc.setVisibility('visible');
  clock.advance(1000);
  assert.equal(fired, 1);
});

test('visible timer: cancel stops it, reset starts the count again (back/forward-cache restore)', () => {
  const clock = createClock();
  const doc = new FakeDocument();
  let fired = 0;
  const timer = createVisibleTimer({ doc, onElapsed: () => { fired++; }, ...clock.timers() });
  timer.start();
  clock.advance(1000);
  timer.cancel();
  clock.advance(10000);
  assert.equal(fired, 0);
  assert.equal(clock.pending(), 0);
  timer.reset();
  clock.advance(2999);
  assert.equal(fired, 0, 'the count restarted from zero');
  clock.advance(1);
  assert.equal(fired, 1);
  timer.reset();
  assert.equal(timer.fired, false, 'reset after firing allows another round');
  clock.advance(3000);
  assert.equal(fired, 2);
});

test('visible timer: works without a document (always visible) and tolerates a missing callback', () => {
  const clock = createClock();
  const timer = createVisibleTimer({ ms: 10, ...clock.timers() });
  timer.start();
  clock.advance(10);
  assert.equal(timer.fired, true);
});
