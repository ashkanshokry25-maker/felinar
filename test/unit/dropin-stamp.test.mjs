// Unit tests for src/dropin/stamp.js: reading the stamped <meta name="mw-pointer">, the script tag
// options, and the verdict that decides whether the drop-in engine may start. Records are signed
// with real P-256 keys through src/common/pointer.js, so the scope, expiry, rollback and key-change
// rules are exercised end to end (no mocks of the verifier).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { readStampedText, findScriptTag, parseScriptOptions, evaluateStamp, describeRejection, META_NAME } from '../../src/dropin/stamp.js';
import { formatPointer, signPointer, signRotation } from '../../src/common/pointer.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

const BTIH = '0123456789abcdef0123456789abcdef01234567';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const DAY = 86400;
const EXP = Math.floor(NOW / 1000) + 90 * DAY;

async function newOwner() {
  const kp = await generateKeyPair({ extractable: true });
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

function record(owner, more = {}) {
  return Object.assign({ btih: BTIH, dn: 'Existing Site', xs: ['/_mw/t/' + BTIH + '.torrent'], tr: ['wss://tracker.example'], owner: owner.pub, seq: 5, exp: EXP }, more);
}

async function stamped(owner, scope = 'site.test', more = {}) {
  return formatPointer(await signPointer(record(owner, more), scope, owner.privateKey));
}

test('readStampedText: first mw-pointer meta, any case, trimmed; null without one or without content', () => {
  assert.equal(META_NAME, 'mw-pointer');
  const doc = new FakeDocument({ metas: [{ name: 'viewport', content: 'width=device-width' }, { name: ' MW-Pointer ', content: '  v=mw1; btih=' + BTIH + '  ' }, { name: 'mw-pointer', content: 'second' }] });
  assert.equal(readStampedText(doc), 'v=mw1; btih=' + BTIH);
  assert.equal(readStampedText(new FakeDocument()), null);
  assert.equal(readStampedText(new FakeDocument({ metas: [{ name: 'mw-pointer' }] })), null, 'no content attribute');
  assert.equal(readStampedText(new FakeDocument({ metas: [{ name: 'mw-pointer', content: '   ' }] })), null, 'blank content');
  assert.equal(readStampedText(null), null);
  assert.equal(readStampedText({}), null);
});

test('findScriptTag: matches import.meta.url by origin and path, ignoring query; falls back to /_mw/mw.js', () => {
  const doc = new FakeDocument({
    baseURI: 'https://site.test/blog/post.html',
    scripts: [{ src: '/js/app.9c0d2e.js' }, { src: 'https://cdn.test/_mw/mw.js' }, { src: '/_mw/mw.js?v=3', 'data-mw-sw': 'off' }, { src: '/_mw/sdk.js' }],
  });
  const tag = findScriptTag(doc, 'https://site.test/_mw/mw.js');
  assert.equal(tag.getAttribute('data-mw-sw'), 'off', 'the same-origin copy, not the CDN one');
  const fallback = findScriptTag(new FakeDocument({ scripts: [{ src: '/other.js' }, { src: '/_mw/mw.js' }] }), 'https://elsewhere.test/_mw/mw.js');
  assert.equal(fallback.getAttribute('src'), '/_mw/mw.js');
  assert.equal(findScriptTag(new FakeDocument({ scripts: [{ src: '/a.js' }] }), 'https://site.test/_mw/mw.js'), null);
  assert.equal(findScriptTag(new FakeDocument({ scripts: [{}] }), 'not a url'), null);
});

test('parseScriptOptions: data-mw-sw="off" and data-mw-consent="site", otherwise defaults', () => {
  const tag = (attrs) => new FakeDocument({ scripts: [Object.assign({ src: '/_mw/mw.js' }, attrs)] }).getElementsByTagName('script')[0];
  assert.deepEqual(parseScriptOptions(tag({})), { sw: 'auto', consent: 'notice' });
  assert.deepEqual(parseScriptOptions(tag({ 'data-mw-sw': ' OFF ', 'data-mw-consent': 'Site' })), { sw: 'off', consent: 'site' });
  assert.deepEqual(parseScriptOptions(tag({ 'data-mw-sw': 'on', 'data-mw-consent': 'gate' })), { sw: 'auto', consent: 'notice' });
  assert.deepEqual(parseScriptOptions(null), { sw: 'auto', consent: 'notice' });
});

test('evaluateStamp: a signed record for this host verifies; ledger id and first-time flag', async () => {
  const owner = await newOwner();
  const v = await evaluateStamp({ text: await stamped(owner), scope: 'SITE.test', now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'ok');
  assert.equal(v.signed, true);
  assert.equal(v.firstTime, true);
  assert.equal(v.scope, 'site.test');
  assert.equal(v.record.btih, BTIH);
  assert.match(v.ledgerId, /^mw1:[A-Za-z0-9_-]{27}$/);
  assert.equal(v.expiresSoon, false);
  const again = await evaluateStamp({ text: await stamped(owner), scope: 'site.test', now: NOW, pin: { owner: owner.pub }, cachedSeq: 5 });
  assert.equal(again.ok, true);
  assert.equal(again.firstTime, false, 'pinned: not the first time');
  assert.equal(again.ledgerId, v.ledgerId, 'same owner and scope, same ledger');
});

test('evaluateStamp: the scope is part of the signature (a record stamped for another host fails)', async () => {
  const owner = await newOwner();
  const text = await stamped(owner, 'other.test');
  const v = await evaluateStamp({ text, scope: 'site.test', now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'rejected');
  assert.equal(v.reason, 'bad-sig');
  assert.match(describeRejection(v.reason), /another host/);
});

test('evaluateStamp: expired, expiry too far, missing seq, and seq rollback are refused', async () => {
  const owner = await newOwner();
  const past = await evaluateStamp({ text: await stamped(owner, 'site.test', { exp: Math.floor(NOW / 1000) - 60 }), scope: 'site.test', now: NOW });
  assert.equal(past.reason, 'expired');
  const far = await evaluateStamp({ text: await stamped(owner, 'site.test', { exp: Math.floor(NOW / 1000) + 402 * DAY }), scope: 'site.test', now: NOW }); // 400 days + the one-day skew margin (code review round 1)
  assert.equal(far.reason, 'exp-too-far');
  const rollback = await evaluateStamp({ text: await stamped(owner, 'site.test', { seq: 4 }), scope: 'site.test', now: NOW, cachedSeq: 5 });
  assert.equal(rollback.reason, 'seq-rollback');
  assert.equal(rollback.ok, false);
  const equalSeq = await evaluateStamp({ text: await stamped(owner, 'site.test', { seq: 5 }), scope: 'site.test', now: NOW, cachedSeq: 5 });
  assert.equal(equalSeq.ok, true, 'the same seq is not a rollback');
});

test('evaluateStamp: a record that expires within 14 days is ok but flagged', async () => {
  const owner = await newOwner();
  const v = await evaluateStamp({ text: await stamped(owner, 'site.test', { exp: Math.floor(NOW / 1000) + 3 * DAY }), scope: 'site.test', now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.expiresSoon, true);
});

test('evaluateStamp: a different owner key needs the visitor, unless rot= vouches for it', async () => {
  const a = await newOwner();
  const b = await newOwner();
  const swapped = await evaluateStamp({ text: await stamped(b), scope: 'site.test', now: NOW, pin: { owner: a.pub } });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.status, 'key-changed');
  assert.equal(swapped.oldOwner, a.pub);
  assert.equal(swapped.newOwner, b.pub);
  assert.ok(swapped.ledgerId.startsWith('mw1:'), 'the ledger id of the new key is known for the prompt');
  // v0.3 (MF-28): rot= v1 is deleted, so a rotation is signed with its scope (v2).
  const rot = await signRotation({ owner: b.pub, seq: 6, scope: 'site.test' }, a.privateKey);
  const rotated = await evaluateStamp({ text: await stamped(b, 'site.test', { seq: 6, rot }), scope: 'site.test', now: NOW, pin: { owner: a.pub } });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.rotated, true, 'silent rotation');
  const forged = await evaluateStamp({ text: await stamped(b, 'site.test', { seq: 6, rot: rot.slice(0, -4) + 'AAAA' }), scope: 'site.test', now: NOW, pin: { owner: a.pub } });
  assert.equal(forged.status, 'key-changed', 'a bad rot is no rot');
  const invalid = await evaluateStamp({ text: (await stamped(b)).replace(/seq=5/, 'seq=9'), scope: 'site.test', now: NOW, pin: { owner: a.pub } });
  assert.equal(invalid.status, 'rejected', 'a different owner AND a bad signature is simply refused');
  assert.equal(invalid.reason, 'bad-sig');
});

test('evaluateStamp: unsigned records (bare magnet or pointer without sig) are allowed unless the scope is pinned', async () => {
  const magnet = 'magnet:?xt=urn:btih:' + BTIH + '&dn=Existing+Site&xs=%2F_mw%2Ft%2F' + BTIH + '.torrent';
  const m = await evaluateStamp({ text: magnet, scope: 'site.test', now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.signed, false);
  assert.equal(m.ledgerId, 'btih:' + BTIH, 'unsigned ledgers are keyed by infohash');
  const bare = await evaluateStamp({ text: 'v=mw1; btih=' + BTIH + '; xs=/_mw/t/' + BTIH + '.torrent', scope: 'site.test', now: NOW });
  assert.equal(bare.ok, true);
  const pinned = await evaluateStamp({ text: magnet, scope: 'site.test', now: NOW, pin: { owner: 'x'.repeat(87) } });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.reason, 'unsigned-pinned');
});

test('evaluateStamp: garbage never throws and says why', async () => {
  for (const [text, scope, reason] of [
    ['', 'site.test', 'empty'], [null, 'site.test', 'empty'], ['   ', 'site.test', 'empty'],
    ['v=mw2; btih=' + BTIH, 'site.test', /^parse: /], ['not a pointer at all', 'site.test', /^parse: /],
    ['v=mw1; btih=' + BTIH, '', 'bad-scope'], ['v=mw1; btih=' + BTIH, null, 'bad-scope'],
  ]) {
    const v = await evaluateStamp({ text, scope, now: NOW });
    assert.equal(v.ok, false, String(text));
    assert.equal(v.status, 'rejected');
    if (reason instanceof RegExp) assert.match(v.reason, reason);
    else assert.equal(v.reason, reason);
  }
  const boom = await evaluateStamp({ text: 'v=mw1; btih=' + BTIH, scope: 'site.test', now: NOW }, { ledgerIdFor: async () => { throw new Error('disk on fire'); } });
  assert.equal(boom.ok, false);
  assert.match(boom.reason, /^error: disk on fire/);
});

test('describeRejection: every verifier reason has a plain sentence without em dashes', () => {
  for (const r of ['empty', 'bad-scope', 'no-btih', 'unsigned', 'unsigned-pinned', 'bad-owner', 'bad-sig', 'missing-exp', 'missing-seq', 'expired', 'exp-too-far', 'seq-rollback', 'owner-changed', 'parse: no-version', 'error: x', 'something-new']) {
    const s = describeRejection(r);
    assert.ok(s.length > 10, r);
    assert.ok(!/[–—]/.test(s), 'no dashes in: ' + s);
  }
  assert.match(describeRejection(undefined), /unknown reason/);
});

test('code review round 1: a scope-bound rot= counts only on its host; a poisoned floor never blocks rot= or the prompt; a seq a day ahead is refused', async () => {
  const a = await newOwner();
  const b = await newOwner();
  const c = await newOwner();
  const nowS = Math.floor(NOW / 1000);
  const rot = await signRotation({ owner: b.pub, seq: nowS, scope: 'site.test' }, a.privateKey);
  const here = await evaluateStamp({ text: await stamped(b, 'site.test', { seq: nowS, rot }), scope: 'site.test', now: NOW, pin: { owner: a.pub } });
  assert.equal(here.rotated, true);
  const elsewhere = await evaluateStamp({ text: await stamped(b, 'other.test', { seq: nowS, rot }), scope: 'other.test', now: NOW, pin: { owner: a.pub } });
  assert.equal(elsewhere.status, 'key-changed', 'a rotation signed for site.test is no rotation for other.test');
  const poisoned = Number.MAX_SAFE_INTEGER;
  const viaRot = await evaluateStamp({ text: await stamped(b, 'site.test', { seq: nowS, rot }), scope: 'site.test', now: NOW, pin: { owner: a.pub }, cachedSeq: poisoned });
  assert.equal(viaRot.ok, true);
  const prompt = await evaluateStamp({ text: await stamped(c, 'site.test', { seq: nowS }), scope: 'site.test', now: NOW, pin: { owner: a.pub }, cachedSeq: nowS + 3600 });
  assert.equal(prompt.status, 'key-changed', 'owner first: the visitor decides, no seq-rollback');
  const ahead = await evaluateStamp({ text: await stamped(a, 'site.test', { seq: nowS + 2 * DAY }), scope: 'site.test', now: NOW });
  assert.equal(ahead.reason, 'seq-future');
  assert.match(describeRejection('seq-future'), /a day ahead/);
});
