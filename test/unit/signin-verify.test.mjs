// @felinar/verify (R 2.3.7, packages/verify/verify.js; tests U-SI-1 in Node and U-SI-2):
// every test/vectors/signin.json case, the order of checks, stateless HMAC nonces, skew bounds,
// P1363 accepted and DER refused, high-S accepted with nonce dedupe, the 4 KiB cap; byte
// equality of its RFC 8785 serialiser with src/chain/canonical.js; the single-file rules (no
// imports, under about 400 lines, README hash); and the loopback fixture server, two instances
// sharing one nonce directory (a replayed proof fails at the second instance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createVerifier, issueChallenge, MemoryNonceStore, statelessNonce, jcs } from '../../packages/verify/verify.js';
import * as s from '../../src/identity/signin.js';
import * as d from '../../src/identity/derive.js';
import { canonicalize } from '../../src/chain/canonical.js';
import { startSigninServer, FileNonceStore } from '../fixtures/signin-server/server.mjs';

const VERIFY_URL = new URL('../../packages/verify/verify.js', import.meta.url);
const SIGNIN = JSON.parse(readFileSync(new URL('../vectors/signin.json', import.meta.url), 'utf8'));
const T0 = Date.UTC(2026, 9, 20, 16, 0, 0);
const KEY_D = await d.signScalar(await d.labelSeed(await d.rootStar(new Uint8Array(16).fill(5)), 'o|https://forum.example'), 1);
const PUB = d.publicKeyOf(KEY_D);
const KEY = await d.importScalar(KEY_D);
const REQ = 'cmVxdWVzdC1pZC0xMjM0NQ';

/** runVector(v) -> the verifier's result for a signin.json vector (store state set up first). */
async function runVector(v) {
  const now = () => v.verifier.now;
  const store = new MemoryNonceStore({ now });
  let nonce = null;
  try {
    nonce = JSON.parse(v.proof).c.nonce;
  } catch (_) { /* unparsable vectors have no nonce */ }
  if (nonce && v.nonce !== 'unknown') {
    await store.put(nonce, v.verifier.now + 600000, v.issued);
    if (v.nonce === 'used') await store.consume(nonce);
  }
  const opts = Object.assign({}, v.verifier, { nonces: store, now });
  return createVerifier(opts).verify(v.proof);
}

test('U-SI-1 signin.json: every positive and negative vector gives the expected result in Node', async () => {
  assert.ok(SIGNIN.vectors.length >= 30);
  const reasons = new Set();
  for (const v of SIGNIN.vectors) {
    const r = await runVector(v);
    if (v.expect.ok) {
      assert.deepEqual(r, v.expect, v.id);
    } else {
      assert.equal(r.ok, false, v.id);
      assert.equal(r.reason, v.expect.reason, v.id);
      assert.equal(r.at, v.verifier.now, v.id);
      reasons.add(r.reason);
    }
    if (v.signingInput) assert.equal(v.signingInput, 'mw-signin-v1\n' + jcs(JSON.parse(v.proof).c), v.id + ' signing input');
  }
  for (const reason of ['parse', 'version', 'alg', 'sig', 'origin', 'domain', 'ledger', 'keymode', 'idp', 'nonce', 'replay', 'expired', 'not-yet-valid', 'too-long', 'statement']) {
    assert.ok(reasons.has(reason), 'a vector covers ' + reason);
  }
  for (const mode of ['pairwise', 'ledger', 'hub', 'linked']) {
    assert.ok(SIGNIN.vectors.some((v) => v.expect.ok && v.expect.keyMode === mode), 'a valid vector for ' + mode);
  }
});

test('U-SI-2 order of checks: origin before nonce, nonce before signature (a forged proof burns its nonce)', async () => {
  const store = new MemoryNonceStore({ now: () => T0 });
  const v = createVerifier({ origin: 'https://forum.example', nonces: store, now: () => T0 + 1000 });
  const ch = await issueChallenge({ statement: 'Sign in', nonces: store, now: T0 });
  const c = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch, now: T0, requestId: REQ, idp: 'https://id.example', build: 'b' });
  const good = await s.signChallenge(c, KEY);
  const forged = Object.assign({}, good, { sig: (await s.signChallenge(Object.assign({}, c, { statement: 'x' }), KEY)).sig });
  assert.equal((await v.verify(JSON.stringify(forged))).reason, 'sig');
  assert.equal((await v.verify(JSON.stringify(good))).reason, 'replay', 'the nonce was consumed by the forged attempt');
  // Foreign origin with a fresh nonce: refused at the origin step, the nonce stays usable.
  const ch2 = await issueChallenge({ statement: 'Sign in', nonces: store, now: T0 });
  const c2 = s.buildChallenge({ origin: 'https://evil.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch2, now: T0, requestId: REQ, idp: 'https://id.example', build: 'b' });
  assert.equal((await v.verify(JSON.stringify(await s.signChallenge(c2, KEY)))).reason, 'origin');
  const c3 = Object.assign({}, c2, { origin: 'https://forum.example', domain: 'forum.example' });
  assert.equal((await v.verify(JSON.stringify(await s.signChallenge(c3, KEY)))).ok, true);
});

test('U-SI-2 stateless HMAC nonces: issued by the verifier, bound to the origin, single use with a used store', async () => {
  let t = T0;
  const used = new MemoryNonceStore({ now: () => t });
  const sn = statelessNonce(randomBytes(32), { used, now: () => t });
  const v = createVerifier({ origin: 'https://forum.example', nonces: sn, now: () => t, statement: 'Sign in' });
  const mk = async (over = {}) => {
    const ch = await issueChallenge(Object.assign({ statement: 'Sign in', nonces: sn, origin: 'https://forum.example' }, over));
    const c = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch, now: t, requestId: REQ, idp: 'https://id.example', build: 'b' });
    return JSON.stringify(await s.signChallenge(c, KEY));
  };
  const p = await mk();
  assert.equal((await v.verify(p)).ok, true);
  assert.equal((await v.verify(p)).reason, 'replay');
  // A nonce issued for another origin does not verify here.
  assert.equal((await v.verify(await mk({ origin: 'https://other.example' }))).reason, 'nonce');
  // A nonce made up by the client (or by the IdO for a local proof) fails the MAC.
  const c = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'site', challenge: { statement: 'Sign in' }, now: t, requestId: REQ, idp: 'https://id.example', build: 'b' });
  assert.equal((await v.verify(JSON.stringify(await s.signChallenge(c, KEY)))).reason, 'nonce');
  // Another secret (another deployment) is refused.
  const other = statelessNonce(randomBytes(32), { now: () => t });
  assert.equal((await v.verify(await mk({ nonces: other }))).reason, 'nonce');
  // An old stateless nonce is refused even if the proof itself is fresh.
  const old = await sn.issue('https://forum.example');
  t += 300001;
  const c2 = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: { nonce: old.nonce, statement: 'Sign in' }, now: t, requestId: REQ, idp: 'https://id.example', build: 'b' });
  assert.equal((await v.verify(JSON.stringify(await s.signChallenge(c2, KEY)))).reason, 'nonce');
  // The statement option is compared when the store keeps no metadata.
  const p3 = await mk({ statement: 'Sign in as admin' });
  assert.equal((await v.verify(p3)).reason, 'statement');
  assert.throws(() => statelessNonce('short'), TypeError);
  await assert.rejects(() => issueChallenge({ nonces: sn }), TypeError, 'stateless issue needs the origin');
});

test('U-SI-2 two verifiers sharing a store: a proof accepted by one is a replay at the other', async () => {
  const shared = new MemoryNonceStore({ now: () => T0 });
  const a = createVerifier({ origin: 'https://forum.example', nonces: shared, now: () => T0 });
  const b = createVerifier({ origin: 'https://forum.example', nonces: shared, now: () => T0 });
  const ch = await issueChallenge({ nonces: shared, now: T0 });
  const c = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch, now: T0, requestId: REQ, idp: 'https://id.example', build: 'b' });
  const p = JSON.stringify(await s.signChallenge(c, KEY));
  const [ra, rb] = await Promise.all([a.verify(p), b.verify(p)]);
  assert.deepEqual([ra.ok, rb.ok].sort(), [false, true]);
  assert.equal((ra.ok ? rb : ra).reason, 'replay');
});

test('U-SI-2 skew bounds and verifier options', async () => {
  const nonces = new MemoryNonceStore();
  assert.throws(() => createVerifier({ origin: 'https://forum.example', nonces, maxSkewMs: 300001 }), RangeError);
  assert.throws(() => createVerifier({ origin: 'https://forum.example', nonces, maxAgeMs: 300001 }), RangeError);
  createVerifier({ origin: 'https://forum.example', nonces, maxSkewMs: 300000 });
  for (const origin of ['https://forum.example/', 'forum.example', 'https://FORUM.example', undefined]) {
    assert.throws(() => createVerifier({ origin, nonces }), TypeError, String(origin));
  }
  assert.throws(() => createVerifier({ origin: 'https://forum.example' }), TypeError, 'a nonce store is required');
  assert.throws(() => createVerifier({ origin: 'https://forum.example', nonces, allowKeyModes: ['admin'] }), TypeError);
  // A shorter maxAgeMs refuses a proof whose exp - iat is longer.
  const store = new MemoryNonceStore({ now: () => T0 });
  const ch = await issueChallenge({ nonces: store, now: T0 });
  const c = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch, now: T0, requestId: REQ, idp: 'https://id.example', build: 'b' });
  const p = JSON.stringify(await s.signChallenge(c, KEY));
  assert.equal((await createVerifier({ origin: 'https://forum.example', nonces: store, now: () => T0, maxAgeMs: 60000 }).verify(p)).reason, 'too-long');
  // maxSkewMs 0: a proof from 1 ms in the future is not yet valid.
  assert.equal((await createVerifier({ origin: 'https://forum.example', nonces: store, now: () => T0 - 1, maxSkewMs: 0 }).verify(p)).reason, 'not-yet-valid');
  assert.equal((await createVerifier({ origin: 'https://forum.example', nonces: store, now: () => T0, maxSkewMs: 0 }).verify(p)).ok, true);
});

test('U-SI-2 signature forms: P1363 accepted, DER refused, high-S accepted, 4 KiB cap', async () => {
  const vec = (id) => SIGNIN.vectors.find((v) => v.id.startsWith(id));
  assert.equal((await runVector(vec('si-001'))).ok, true);
  assert.equal((await runVector(vec('si-017'))).reason, 'sig');
  assert.equal((await runVector(vec('si-015'))).ok, true);
  assert.equal((await runVector(vec('si-016'))).reason, 'replay');
  assert.equal((await runVector(vec('si-024'))).reason, 'parse');
  assert.ok(Buffer.byteLength(vec('si-024').proof) > 4096);
  // Objects are accepted (size measured on their JCS form) but text is preferred.
  const store = new MemoryNonceStore({ now: () => T0 });
  const ch = await issueChallenge({ nonces: store, now: T0 });
  const c = s.buildChallenge({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch, now: T0, requestId: REQ, idp: 'https://id.example', build: 'b' });
  const r = await createVerifier({ origin: 'https://forum.example', nonces: store, now: () => T0 }).verify(await s.signChallenge(c, KEY));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['build', 'exp', 'iat', 'idp', 'keyMode', 'ledger', 'ok', 'pub', 'requestId', 'statement']);
  assert.ok(!('role' in r) && !('roles' in r), 'never returns roles');
});

test('code review v0.3 round 2: a proof whose strings do not serialise (a lone surrogate) is parse, and its nonce stays unused', async () => {
  const v = SIGNIN.vectors.find((x) => x.id === 'si-005-resources');
  assert.ok(v && v.expect.ok, 'the base vector is a valid proof');
  const obj = JSON.parse(v.proof);
  obj.c.resources = [obj.c.resources[0] + '\ud800'];
  const text = JSON.stringify(obj);
  assert.ok(text.includes('\\ud800'), 'the proof text carries the lone surrogate as an escape');
  const now = () => v.verifier.now;
  const store = new MemoryNonceStore({ now });
  await store.put(obj.c.nonce, v.verifier.now + 600000, v.issued);
  const verifier = createVerifier(Object.assign({}, v.verifier, { nonces: store, now }));
  const r = await verifier.verify(text);
  assert.deepEqual([r.ok, r.reason], [false, 'parse']);
  // The nonce was not used: the original proof with the same nonce still verifies.
  assert.equal((await verifier.verify(v.proof)).ok, true);
});

test('the verifier serialiser is byte-identical to src/chain/canonical.js (RFC 8785)', () => {
  const samples = [
    null, true, false, 0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012345680000, 0.1 + 0.2, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE,
    '', 'a"b\\c', '\u0000\u0001\u001f\u007f', '\b\t\n\f\r', 'é你\u{1F600}', '  ',
    [], [1, [2, [3]]], {}, { b: 1, a: 2, A: 3, 'é': 4, '\u{1F600}': 5, 'דּ': 6, '': 7 },
    { c: { z: [{ y: 1, x: 2 }], v: 1, t: 'mw-signin' } },
  ];
  for (let i = 0; i < 200; i++) {
    const o = {};
    for (let j = 0; j < 6; j++) o[randomBytes(3).toString('base64')] = [randomBytes(4).readInt32LE() / 7, randomBytes(5).toString('latin1'), { n: j }][j % 3];
    samples.push(o);
  }
  for (const x of samples) assert.equal(jcs(x), canonicalize(x), JSON.stringify(x));
  for (const bad of [undefined, NaN, Infinity, () => 1, new Date(0), '\ud800', [1, undefined]]) {
    assert.throws(() => jcs(bad), TypeError);
  }
});

test('single file, zero dependencies, under about 400 lines; README carries its sha256', () => {
  const src = readFileSync(VERIFY_URL, 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'no imports');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require');
  const lines = src.split('\n').length;
  assert.ok(lines <= 400, lines + ' lines');
  const pkg = JSON.parse(readFileSync(new URL('../../packages/verify/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@felinar/verify');
  assert.deepEqual(pkg.dependencies || {}, {});
  const sha = createHash('sha256').update(readFileSync(VERIFY_URL)).digest('hex');
  const readme = readFileSync(new URL('../../packages/verify/README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(sha), 'README.md names the current sha256 of verify.js: ' + sha);
  const spec = readFileSync(new URL('../../docs/specs/mw-signin-v1.md', import.meta.url), 'utf8');
  assert.ok(spec.includes(sha), 'docs/specs/mw-signin-v1.md names the current sha256 of verify.js: ' + sha);
});

test('fixture server: challenge, verify, and a replay refused by a second instance sharing the nonce directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mw-signin-nonces-'));
  const origin = 'http://127.0.0.1:1';
  const a = await startSigninServer({ origin, nonceDir: dir });
  const b = await startSigninServer({ origin, nonceDir: dir });
  t.after(async () => {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const ch = await (await fetch(a.url + '/auth/mw/challenge', { method: 'POST' })).json();
  assert.equal(ch.statement, 'Sign in to Example Forum');
  const c = s.buildChallenge({ origin, pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: ch, now: Date.now(), requestId: REQ, idp: 'https://id.example', build: 'b' });
  const body = JSON.stringify(await s.signChallenge(c, KEY));
  const r1 = await fetch(b.url + '/auth/mw/verify', { method: 'POST', body });
  assert.equal(r1.status, 200, 'the second instance accepts a nonce the first issued');
  assert.match(r1.headers.get('set-cookie') || '', /^mw_session=/);
  const ok = await r1.json();
  assert.equal(ok.pub, PUB);
  const r2 = await fetch(a.url + '/auth/mw/verify', { method: 'POST', body });
  assert.equal(r2.status, 401);
  assert.equal((await r2.json()).reason, 'replay');
  const r3 = await fetch(a.url + '/auth/mw/verify', { method: 'POST', body: 'x'.repeat(9000) });
  assert.equal(r3.status, 413);
  assert.equal((await fetch(a.url + '/healthz')).status, 200);
  // Concurrent consumption through the file store: exactly one wins.
  const store = new FileNonceStore(dir);
  await store.put('A'.repeat(43), Date.now() + 60000, { statement: '' });
  const results = await Promise.all(Array.from({ length: 8 }, () => new FileNonceStore(dir).consume('A'.repeat(43))));
  assert.equal(results.filter((x) => x && x !== 'used').length, 1);
  assert.equal(results.filter((x) => x === 'used').length, 7);
  assert.equal(await store.consume('../etc/passwd'), false);
});
