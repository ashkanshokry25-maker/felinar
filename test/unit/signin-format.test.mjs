// mw-signin-v1 format (R 2.3.2, docs/specs/mw-signin-v1.md; tests U-SI-3 and U-AU-1):
// buildChallenge takes domain, origin, ledger, pub, keyMode, iat, idp and build from its caller
// (the identity origin), caps exp at iat + 5 min and requires a verifier nonce for purpose
// 'server'; statements are NFC, at most 280 characters, without control or bidi characters;
// parseProof refuses unknown fields, duplicate keys and proofs over 4 KiB; local proofs last at
// most 15 minutes and die with the revocation epoch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as s from '../../src/identity/signin.js';
import * as d from '../../src/identity/derive.js';
import { canonicalize } from '../../src/chain/canonical.js';

const T0 = Date.UTC(2026, 9, 20, 16, 0, 0);
const SIGNIN = JSON.parse(readFileSync(new URL('../vectors/signin.json', import.meta.url), 'utf8'));
const seed = await d.labelSeed(await d.rootStar(new Uint8Array(16)), 'o|https://forum.example');
const D = await d.signScalar(seed, 1);
const PUB = d.publicKeyOf(D);
const KEY = await d.importScalar(D);
const REQ = 'cmVxdWVzdC1pZC0xMjM0NQ';
const NONCE = 'bm9uY2UtaXNzdWVkLWJ5LXZlcmlmaWVy';
const args = (over = {}) => Object.assign({ origin: 'https://forum.example', pub: PUB, keyMode: 'pairwise', purpose: 'server', challenge: { nonce: NONCE, statement: 'Sign in to Example Forum' }, now: T0, requestId: REQ, idp: 'https://id.example', build: '0.3.0' }, over);

test('buildChallenge: IdO-supplied fields, domain from the origin, exp capped at 5 minutes', () => {
  const c = s.buildChallenge(args());
  assert.deepEqual(Object.keys(c).sort(), s.CHALLENGE_FIELDS.slice().sort());
  assert.equal(c.v, 1);
  assert.equal(c.t, 'mw-signin');
  assert.equal(c.domain, 'forum.example');
  assert.equal(c.origin, 'https://forum.example');
  assert.equal(c.ledger, null);
  assert.equal(c.iat, T0);
  assert.equal(c.nbf, T0);
  assert.equal(c.exp, T0 + 300000);
  assert.deepEqual(c.resources, []);
  assert.equal(s.buildChallenge(args({ origin: 'http://127.0.0.1:8443' })).domain, '127.0.0.1:8443', 'port kept when not default');
  assert.throws(() => s.buildChallenge(args({ origin: 'https://forum.example:443' })), TypeError, 'not the serialised origin');
  assert.equal(s.buildChallenge(args({ challenge: { nonce: NONCE, exp: T0 + 60000 } })).exp, T0 + 60000, 'a shorter verifier exp wins');
  assert.equal(s.buildChallenge(args({ challenge: { nonce: NONCE, exp: T0 + 900000 } })).exp, T0 + 300000, 'never more than 5 minutes');
  assert.equal(s.buildChallenge(args({ challenge: { nonce: NONCE, nbf: T0 + 1000 } })).nbf, T0 + 1000);
  assert.throws(() => s.buildChallenge(args({ challenge: { nonce: NONCE, exp: T0 } })), (e) => e.code === 'E_CHALLENGE');
  assert.throws(() => s.buildChallenge(args({ challenge: { nonce: NONCE, nbf: T0 + 400000 } })), (e) => e.code === 'E_CHALLENGE');
});

test("purpose 'server' without a verifier nonce throws E_NONCE_REQUIRED; 'site' gets an IdO nonce", () => {
  assert.throws(() => s.buildChallenge(args({ challenge: null })), (e) => e.code === 'E_NONCE_REQUIRED');
  assert.throws(() => s.buildChallenge(args({ challenge: { statement: 'Hi' } })), (e) => e.code === 'E_NONCE_REQUIRED');
  const local = s.buildChallenge(args({ purpose: 'site', challenge: null }));
  assert.ok(s.b64urlBytes(local.nonce, 16, 16), '16 random bytes from the IdO');
  assert.notEqual(s.buildChallenge(args({ purpose: 'site', challenge: null })).nonce, local.nonce);
  assert.equal(local.statement, '');
  assert.throws(() => s.buildChallenge(args({ challenge: { nonce: 'short' } })), (e) => e.code === 'E_CHALLENGE');
  assert.throws(() => s.buildChallenge(args({ purpose: 'login' })), TypeError);
});

test('U-SI-3 statement rules: NFC, 0 to 280 characters, no control or bidi characters', () => {
  const ok = ['', 'Sign in to Example Forum', 'Café 你好 \u{1F600}', 'x'.repeat(280), '\u{1F600}'.repeat(280)];
  for (const st of ok) assert.equal(s.statementProblem(st), null, JSON.stringify(st));
  const badCases = [
    ['Café', 'nfc'], ['x'.repeat(281), 'length'], ['a\nb', 'control'], ['a\tb', 'control'], ['a\u0000', 'control'], ['a\u007f', 'control'],
    ['a\u0085', 'control'], ['a b', 'control'], ['‮evil', 'bidi'], ['a‎b', 'bidi'], ['a⁦b', 'bidi'], ['a؜b', 'bidi'],
    ['a\ud800', 'surrogate'], ['\udc00a', 'surrogate'], [42, 'type'],
  ];
  for (const [st, why] of badCases) {
    assert.equal(s.statementProblem(st), why, JSON.stringify(st));
    assert.throws(() => s.buildChallenge(args({ challenge: { nonce: NONCE, statement: st } })), (e) => e.code === 'E_STATEMENT', JSON.stringify(st));
  }
});

test('keyMode, ledger, pub, origin and resources are checked when building', () => {
  assert.throws(() => s.buildChallenge(args({ keyMode: 'ledger' })), TypeError, 'ledger keyMode without a ledger');
  assert.throws(() => s.buildChallenge(args({ ledger: 'mw1:x' })), TypeError, 'ledger without the ledger keyMode');
  assert.equal(s.buildChallenge(args({ keyMode: 'ledger', ledger: 'mw1:x' })).ledger, 'mw1:x');
  assert.throws(() => s.buildChallenge(args({ keyMode: 'admin' })), TypeError);
  assert.throws(() => s.buildChallenge(args({ pub: 'p256:short' })), TypeError);
  for (const origin of ['https://forum.example/', 'https://forum.example/login', 'forum.example', 'https://FORUM.example']) {
    assert.throws(() => s.buildChallenge(args({ origin })), TypeError, origin);
  }
  assert.throws(() => s.buildChallenge(args({ challenge: { nonce: NONCE, resources: ['http://forum.example/tos'] } })), (e) => e.code === 'E_CHALLENGE');
  assert.throws(() => s.buildChallenge(args({ challenge: { nonce: NONCE, resources: Array(5).fill('https://a.example/') } })), (e) => e.code === 'E_CHALLENGE');
  assert.throws(() => s.buildChallenge(args({ build: 'has space' })), TypeError);
  assert.throws(() => s.buildChallenge(args({ requestId: 'AAAA' })), (e) => e.code === 'E_CHALLENGE');
});

test('signChallenge: ES256-P1363 over "mw-signin-v1\\n" + JCS(c); parseProof accepts it and copies only known fields', async () => {
  const c = s.buildChallenge(args());
  const proof = await s.signChallenge(c, KEY);
  assert.equal(proof.alg, 'ES256-P1363');
  assert.equal(s.signingInput(c), 'mw-signin-v1\n' + canonicalize(c));
  const text = JSON.stringify(proof);
  const parsed = s.parseProof(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.proof, proof);
  assert.notEqual(parsed.proof.c, proof.c, 'a fresh copy');
  assert.equal(await s.verifySignature(parsed.proof), true);
  assert.equal(s.parseProof(proof).ok, true, 'objects are accepted too');
  const tampered = JSON.parse(text);
  tampered.c.statement = 'Sign in to Something Else';
  assert.equal(await s.verifySignature(tampered), false);
});

test('U-SI-3 parseProof against the signin.json vectors that fail before any verifier state', () => {
  const parseLevel = new Set(['parse', 'version', 'alg', 'sig', 'statement']);
  let checked = 0;
  for (const v of SIGNIN.vectors) {
    const r = s.parseProof(v.proof);
    if (v.expect.ok) {
      assert.equal(r.ok, true, v.id);
    } else if (parseLevel.has(v.expect.reason) && !['si-025-bad-signature', 'si-029-statement-mismatch', 'si-035-order-nonce-before-signature'].includes(v.id)) {
      assert.deepEqual(r, { ok: false, reason: v.expect.reason }, v.id);
      checked++;
    }
  }
  assert.ok(checked >= 9, checked + " parse-level vectors");
});

test('U-SI-3 unknown fields and duplicate keys are refused; ledger presence is a verifier decision', async () => {
  const c = s.buildChallenge(args());
  const proof = await s.signChallenge(c, KEY);
  const text = JSON.stringify(proof);
  assert.deepEqual(s.parseProof(JSON.stringify(Object.assign({}, proof, { extra: 1 }))), { ok: false, reason: 'parse' });
  assert.deepEqual(s.parseProof(JSON.stringify(Object.assign({}, proof, { c: Object.assign({}, c, { role: 'admin' }) }))), { ok: false, reason: 'parse' });
  const missing = Object.assign({}, c);
  delete missing.requestId;
  assert.deepEqual(s.parseProof(JSON.stringify(Object.assign({}, proof, { c: missing }))), { ok: false, reason: 'parse' });
  assert.deepEqual(s.parseProof(text.replace('{"c":{', '{"c":{"v":1,')), { ok: false, reason: 'parse' }, 'duplicate v');
  assert.deepEqual(s.parseProof(text.replace('"alg":', '"alg":"x","alg":')), { ok: false, reason: 'parse' });
  assert.deepEqual(s.parseProof(text + ' x'), { ok: false, reason: 'parse' });
  assert.deepEqual(s.parseProof('{"c":1'), { ok: false, reason: 'parse' });
  assert.deepEqual(s.parseProof(' '.repeat(4097)), { ok: false, reason: 'parse' }, 'over 4 KiB');
  assert.throws(() => s.strictJsonParse('{"a":1,"a":2}'), SyntaxError);
  assert.deepEqual(s.strictJsonParse('{"a":[1,"x\\u00e9",true,null,{"b":-1.5e3}]}'), { a: [1, 'xé', true, null, { b: -1500 }] });
  assert.equal(Object.getPrototypeOf(s.strictJsonParse('{"__proto__":{"x":1}}')), Object.prototype, 'no prototype pollution');
});

test('U-AU-1 local proofs: at most 15 minutes, same tab, and revoked by the epoch on sign-out', async () => {
  const origin = 'https://forum.example';
  const p = await s.makeLocalProof({ signKey: KEY, pub: PUB, origin, epoch: 3, now: T0 });
  assert.equal(p.c.t, 'mw-local');
  assert.equal(p.c.exp - p.c.iat, 900000);
  assert.deepEqual(await s.verifyLocalProof(p, { origin, epoch: 3, now: T0 + 1000 }), { ok: true, pub: PUB });
  assert.deepEqual(await s.verifyLocalProof(p, { origin, epoch: 4, now: T0 + 1000 }), { ok: false, reason: 'revoked' }, 'signed out since');
  assert.deepEqual(await s.verifyLocalProof(p, { origin, epoch: 2, now: T0 + 1000 }), { ok: false, reason: 'epoch' });
  assert.deepEqual(await s.verifyLocalProof(p, { origin: 'https://evil.example', epoch: 3, now: T0 }), { ok: false, reason: 'origin' });
  assert.deepEqual(await s.verifyLocalProof(p, { origin, epoch: 3, now: T0 + 900000 }), { ok: false, reason: 'expired' });
  assert.deepEqual(await s.verifyLocalProof(p, { origin, epoch: 3, now: T0 - 60000 }), { ok: false, reason: 'not-yet-valid' });
  await assert.rejects(() => s.makeLocalProof({ signKey: KEY, pub: PUB, origin, epoch: 3, now: T0, ttlMs: 900001 }), RangeError);
  const stretched = JSON.parse(JSON.stringify(p));
  stretched.c.exp = stretched.c.iat + 900001;
  assert.deepEqual(await s.verifyLocalProof(stretched, { origin, epoch: 3, now: T0 }), { ok: false, reason: 'too-long' });
  const edited = JSON.parse(JSON.stringify(p));
  edited.c.exp -= 1;
  assert.deepEqual(await s.verifyLocalProof(edited, { origin, epoch: 3, now: T0 }), { ok: false, reason: 'sig' });
  // A local proof is never a sign-in proof: different type and signing prefix.
  assert.deepEqual(s.parseProof(JSON.stringify(p)), { ok: false, reason: 'version' });
  const signinShaped = await s.signChallenge(s.buildChallenge(args()), KEY);
  assert.deepEqual(await s.verifyLocalProof(signinShaped, { origin, epoch: 3, now: T0 }), { ok: false, reason: 'version' });
});
