// Unit tests for src/dropin/polyfills.js: the guarded Uint8Array hex/base64 methods and
// AbortSignal.timeout that the vendored webtorrent bundle calls without guards. Drop-in pages
// never run boot.js, so mw.js installs these itself (ARCHITECTURE §5.1, §3.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impl, installPolyfills, selfTest } from '../../src/dropin/polyfills.js';

const te = new TextEncoder();
const hexOf = (u8) => impl.toHex.call(u8);
const b64Of = (u8, o) => impl.toBase64.call(u8, o);

/**
 * withLoopAlive(promise, what): awaits promise while a ref'd timer holds the event loop open, for at most 10 s; past that it
 * throws, naming what it waited for. Node 22's test runner cancels every pending test of a file as soon as its event loop is
 * empty ("Promise resolution is still pending but the event loop has already resolved"); Node 24's runner holds the loop open
 * itself. So an await whose only pending handle is an unref'd timer passes on Node 24 and is cancelled on Node 22, together
 * with every later test in the file.
 */
async function withLoopAlive(promise, what, deadlineMs = 10000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out after ' + deadlineMs + ' ms waiting for ' + what)), deadlineMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test('toHex and fromHex round trip, accept both cases, reject bad input', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
  assert.equal(hexOf(bytes), '00017f80feff');
  assert.deepEqual(Array.from(impl.fromHex('00017F80feff')), Array.from(bytes));
  assert.equal(hexOf(new Uint8Array(0)), '');
  assert.equal(impl.fromHex('').length, 0);
  assert.throws(() => impl.fromHex('abc'), SyntaxError);
  assert.throws(() => impl.fromHex('zz'), SyntaxError);
  assert.throws(() => impl.fromHex(5), TypeError);
  assert.throws(() => impl.toHex.call([1, 2]), TypeError, 'receiver must be a Uint8Array');
});

test('toBase64: RFC 4648 vectors, url alphabet, omitPadding', () => {
  const vectors = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
  for (const [text, b64] of vectors) assert.equal(b64Of(te.encode(text)), b64, JSON.stringify(text));
  const b = new Uint8Array([251, 255]);
  assert.equal(b64Of(b), '+/8=');
  assert.equal(b64Of(b, { alphabet: 'base64url' }), '-_8=');
  assert.equal(b64Of(b, { alphabet: 'base64url', omitPadding: true }), '-_8');
  assert.throws(() => b64Of(b, { alphabet: 'base32' }), TypeError);
  assert.throws(() => b64Of(b, null), TypeError);
});

test('fromBase64: vectors, whitespace, alphabets and every lastChunkHandling mode', () => {
  const text = (s, o) => new TextDecoder().decode(impl.fromBase64(s, o));
  assert.equal(text('Zm9vYmFy'), 'foobar');
  assert.equal(text('Zm9vYg=='), 'foob');
  assert.equal(text(' Zm9v\nYg == '), 'foob', 'ASCII whitespace is skipped');
  assert.equal(text('Zm9vYg'), 'foob', 'loose accepts a missing pad');
  assert.deepEqual(Array.from(impl.fromBase64('-_8', { alphabet: 'base64url' })), [251, 255]);
  assert.throws(() => impl.fromBase64('-_8='), SyntaxError, '- and _ are not in the default alphabet');
  assert.throws(() => impl.fromBase64('+/8=', { alphabet: 'base64url' }), SyntaxError);
  assert.throws(() => impl.fromBase64('Zg='), SyntaxError, 'incomplete padding');
  assert.throws(() => impl.fromBase64('Zm9vY'), SyntaxError, 'one leftover character');
  assert.throws(() => impl.fromBase64('Zg==Zg=='), SyntaxError, 'data after padding');
  assert.throws(() => impl.fromBase64('Zm9v!'), SyntaxError, 'invalid character');
  assert.throws(() => impl.fromBase64('Zh==', { lastChunkHandling: 'strict' }), SyntaxError, 'strict rejects extra bits');
  assert.equal(text('Zh==', { lastChunkHandling: 'loose' }), 'f', 'loose ignores extra bits');
  assert.equal(text('Zm9vYg', { lastChunkHandling: 'stop-before-partial' }), 'foo');
  assert.throws(() => impl.fromBase64('Zm9v', { lastChunkHandling: 'whatever' }), TypeError);
  assert.throws(() => impl.fromBase64(7), TypeError);
  // every length 0..40 round trips through both alphabets
  for (let n = 0; n <= 40; n++) {
    const src = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    assert.deepEqual(Array.from(impl.fromBase64(b64Of(src))), Array.from(src));
    assert.deepEqual(Array.from(impl.fromBase64(b64Of(src, { alphabet: 'base64url', omitPadding: true }), { alphabet: 'base64url' })), Array.from(src));
  }
});

test('timeout(): an AbortSignal that aborts with a TimeoutError after the delay', async () => {
  const signal = impl.timeout(15);
  assert.equal(signal.aborted, false);
  // timeout() unrefs its timer (src/dropin/polyfills.js, on purpose), so while this waits for the abort nothing holds the event
  // loop open: Node 22's runner then cancels this test and the three after it. withLoopAlive holds a ref'd timer meanwhile.
  await withLoopAlive(new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })), 'the abort from timeout(15)');
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason && signal.reason.name, 'TimeoutError');
  assert.throws(() => impl.timeout(-1), TypeError);
  assert.throws(() => impl.timeout(Infinity), TypeError);
  assert.throws(() => impl.timeout('5'), TypeError);
});

test('installPolyfills defines only what is missing and never replaces a native method', () => {
  function FakeU8() {}
  function FakeSignal() {}
  const native = function nativeToHex() { return 'native'; };
  FakeU8.prototype.toHex = native;
  const scope = { Uint8Array: FakeU8, AbortSignal: FakeSignal, AbortController: function FakeController() {} };
  const done = installPolyfills(scope);
  assert.deepEqual(done.sort(), ['AbortSignal.timeout', 'Uint8Array.fromBase64', 'Uint8Array.fromHex', 'Uint8Array.prototype.toBase64'].sort());
  assert.equal(FakeU8.prototype.toHex, native, 'native toHex kept');
  assert.equal(typeof FakeU8.fromHex, 'function');
  assert.equal(typeof FakeSignal.timeout, 'function');
  const desc = Object.getOwnPropertyDescriptor(FakeU8, 'fromHex');
  assert.equal(desc.enumerable, false, 'non-enumerable, like the built-ins');
  assert.deepEqual(installPolyfills(scope), [], 'second call defines nothing');
  assert.deepEqual(installPolyfills({}), [], 'no globals, no work');
});

test('installPolyfills on the real globals leaves selfTest clean', () => {
  installPolyfills(globalThis);
  assert.deepEqual(selfTest(globalThis), []);
  assert.equal(new Uint8Array([1, 2, 255]).toHex(), '0102ff');
  assert.deepEqual(Array.from(Uint8Array.fromHex('0102ff')), [1, 2, 255]);
});

test('selfTest reports a broken implementation instead of throwing', () => {
  const broken = { Uint8Array: class extends Uint8Array { toHex() { return 'nope'; } }, AbortSignal: { timeout: () => ({ aborted: true }) } };
  const failed = selfTest(broken);
  assert.ok(failed.includes('toHex'), failed.join(', '));
  assert.ok(failed.includes('AbortSignal.timeout'), failed.join(', '));
  assert.ok(selfTest({}).some((f) => f.startsWith('exception')));
});
