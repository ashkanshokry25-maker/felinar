import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import {
  parsePointer, formatPointer, signingInput, signPointer, verifyPointer, verifyRotation, signRotation,
  rotationInput, ledgerIdFor, hubLabelFor, splitTxt, joinTxtData, magnetFromRecord, pickRecord,
  normalizeScope, MAX_EXP_DAYS, _sha256SyncForTests,
  pointerStatus, isWithdrawn, audienceTokens, pointerBudget, withdrawalRecord, ZERO_BTIH, STATUS_OK, STATUS_WITHDRAWN,
  POINTER_SIZE_SHOULD, POINTER_SIZE_MAX, AUDIENCES, WHY_CODES,
} from '../../src/common/pointer.js';
import { generateKeyPair, exportPublicKey, exportPrivateJwk, sign } from '../../src/chain/crypto.js';
import { b64url, utf8 } from '../../src/chain/canonical.js';
import { encode as b32, decode as b32decode } from '../../src/common/base32.js';
import { parseMagnet } from '../../src/common/magnet.js';

const BTIH = '0123456789abcdef0123456789abcdef01234567';
const BTIH2 = 'fedcba9876543210fedcba9876543210fedcba98';
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const DAY = 86400;
const EXP = Math.floor(NOW / 1000) + 90 * DAY;
const E_ACUTE = String.fromCharCode(0xe9);
const U_UML = String.fromCharCode(0xfc);
const IDN = 'b' + U_UML + 'cher.example';
const IDN_ASCII = 'xn--bcher-kva.example';

async function newOwner() {
  const kp = await generateKeyPair({ extractable: true });
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey), jwk: await exportPrivateJwk(kp.privateKey) };
}

function baseRecord(owner, more = {}) {
  return Object.assign({
    btih: BTIH, dn: 'Peer Guestbook', xs: ['https://example.com/_mw/t/' + BTIH + '.torrent'],
    ws: ['https://example.com/ws/'], tr: ['wss://tracker.example.com', 'wss://tracker.webtorrent.dev'],
    owner: owner.pub, seq: 7, exp: EXP,
  }, more);
}

async function signedText(owner, scope = 'example.com', more = {}) {
  return formatPointer(await signPointer(baseRecord(owner, more), scope, owner.privateKey));
}

// ------------------------------------------------------------------------------------------
// parse
// ------------------------------------------------------------------------------------------

test('parsePointer: fields, repeatable keys, unknown keys kept, dn decoded, other values verbatim', () => {
  const text = 'v=mw1; btih=' + BTIH + '; dn=My%20Site; xs=https://h.example/a%3Bb.torrent; ws=https://h.example/ws/; ' +
    'tr=wss://a.example; tr=wss://b.example; chain=guestbook; max=1048576; gen=' + 'ab'.repeat(32) + '; cs=https://h.example/snap.json.gz; ' +
    'consent=gate; seq=12; exp=1800000000; future=x=y; future=2; other=z';
  const res = parsePointer(text);
  assert.equal(res.ok, true);
  const r = res.record;
  assert.equal(r.v, 'mw1');
  assert.equal(r.kind, 'pointer');
  assert.equal(r.btih, BTIH);
  assert.equal(r.dn, 'My Site');
  assert.deepEqual(r.xs, ['https://h.example/a%3Bb.torrent'], 'xs kept verbatim, not decoded');
  assert.deepEqual(r.tr, ['wss://a.example', 'wss://b.example']);
  assert.equal(r.chain, 'guestbook');
  assert.equal(r.max, 1048576);
  assert.equal(r.seq, 12);
  assert.equal(r.exp, 1800000000);
  assert.equal(r.consent, 'gate');
  assert.equal(r.signed, false);
  assert.deepEqual(r.extra, { future: ['x=y', '2'], other: 'z' }, 'value keeps every = after the first');
  assert.equal(r.raw, text);
});

test('parsePointer: key case and whitespace do not matter', () => {
  const a = parsePointer('v=mw1;btih=' + BTIH + ';dn=x;SEQ=1').record;
  const b = parsePointer('  V = mw1 ;   BTIH=' + BTIH + '  ;\tdn=x ;  ;Seq =1 ; ').record;
  assert.equal(b.btih, BTIH);
  assert.equal(b.seq, 1);
  assert.equal(signingInput(a, 'example.com'), signingInput(b, 'example.com'));
});

test('parsePointer: errors', () => {
  const cases = [
    ['', 'empty'], ['   ', 'empty'], [';;', 'empty'], [null, 'empty'],
    ['btih=' + BTIH, 'no-version'], ['v=mw2; btih=' + BTIH, 'unsupported-version'],
    ['v=mw1', 'no-btih'], ['v=mw1; btih=' + BTIH.toUpperCase(), 'bad-btih'], ['v=mw1; btih=abc', 'bad-btih'],
    ['v=mw1; btih=' + BTIH + '; btih=' + BTIH2, 'duplicate-key'], ['v=mw1; v=mw1; btih=' + BTIH, 'duplicate-key'],
    ['v=mw1; btih=' + BTIH + '; seq=01', 'bad-value'], ['v=mw1; btih=' + BTIH + '; seq=-1', 'bad-value'],
    ['v=mw1; btih=' + BTIH + '; exp=1e9', 'bad-value'], ['v=mw1; btih=' + BTIH + '; max=', 'bad-value'],
    ['v=mw1; btih=' + BTIH + '; seq=99999999999999999', 'bad-value'],
    ['v=mw1; btih=' + BTIH + '; junk', 'malformed'], ['v=mw1; btih=' + BTIH + '; =x', 'malformed'],
    ['v=mw1; btih=' + BTIH + '; b@d=1', 'malformed'], ['v=mw1; btih=' + BTIH + '; _x=1', 'malformed'],
    ['v=mw1; btih=' + BTIH + '; dn=a\nb', 'malformed'], ['v=mw1; btih=' + BTIH + '; dn=a\u0007b', 'malformed'],
    ['magnet:?dn=nohash', 'bad-magnet'], ['hello', 'malformed'],
  ];
  for (const [text, error] of cases) {
    const res = parsePointer(text);
    assert.equal(res.ok, false, JSON.stringify(text));
    assert.equal(res.error, error, JSON.stringify(text));
    assert.equal(typeof res.detail, 'string');
  }
  const kelvin = String.fromCharCode(0x212a);
  assert.equal(parsePointer('v=mw1; btih=' + BTIH + '; ' + kelvin + 'ey=1').error, 'malformed', 'non-ASCII key refused before lowercasing');
});

test('parsePointer: bare magnet and bare infohash give unsigned magnet-kind records', () => {
  const m = parsePointer('magnet:?xt=urn:btih:' + BTIH + '&dn=Site&tr=wss%3A%2F%2Ft.example&ws=https%3A%2F%2Fh%2Fws%2F&xs=https%3A%2F%2Fh%2Ft.torrent');
  assert.equal(m.ok, true);
  assert.equal(m.record.kind, 'magnet');
  assert.equal(m.record.signed, false);
  assert.deepEqual([m.record.btih, m.record.dn, m.record.tr, m.record.ws, m.record.xs],
    [BTIH, 'Site', ['wss://t.example'], ['https://h/ws/'], ['https://h/t.torrent']]);
  for (const t of [BTIH, BTIH.toUpperCase(), 'btih:' + BTIH, 'urn:btih:' + BTIH, b32(Buffer.from(BTIH, 'hex'))]) {
    const r = parsePointer(t);
    assert.equal(r.ok, true, t);
    assert.equal(r.record.btih, BTIH);
    assert.equal(r.record.kind, 'magnet');
  }
});

// ------------------------------------------------------------------------------------------
// signing input, format, sign, verify
// ------------------------------------------------------------------------------------------

test('signingInput: exact layout (sorted by key then value, sig excluded, scope last)', () => {
  const r = parsePointer('v=mw1; btih=' + BTIH + '; tr=wss://b; tr=wss://a; dn=My%20Site; zz=1; seq=3; exp=99; owner=O; sig=SIG').record;
  assert.equal(signingInput(r, 'Example.COM.'), [
    'mw-pointer-v1', 'btih=' + BTIH, 'dn=My%20Site', 'exp=99', 'owner=O', 'seq=3', 'tr=wss://a', 'tr=wss://b', 'v=mw1', 'zz=1', 'example.com',
  ].join('\n'));
});

test('normalizeScope: hostnames, IDN to punycode, btih scopes', () => {
  assert.equal(normalizeScope('Example.COM'), 'example.com');
  assert.equal(normalizeScope('example.com.'), 'example.com');
  assert.equal(normalizeScope('https://Example.com:8443/path?q#f'), 'example.com');
  assert.equal(normalizeScope(IDN), IDN_ASCII);
  assert.equal(normalizeScope(IDN.toUpperCase()), IDN_ASCII);
  assert.equal(normalizeScope('btih:' + BTIH.toUpperCase()), 'btih:' + BTIH);
  assert.equal(normalizeScope('BTIH:' + b32(Buffer.from(BTIH, 'hex'))), 'btih:' + BTIH);
  assert.throws(() => normalizeScope(''), TypeError);
  assert.throws(() => normalizeScope('btih:xyz'), TypeError);
  assert.throws(() => normalizeScope('exa mple.com'), TypeError);
});

test('signPointer/verifyPointer: round trip through text; node:crypto verifies the raw r||s signature', async () => {
  const owner = await newOwner();
  const signed = await signPointer(baseRecord(owner), 'example.com', owner.privateKey);
  assert.equal(signed.signed, true);
  assert.equal(signed.kind, 'pointer');
  const text = formatPointer(signed);
  assert.equal(text, signed.raw);
  assert.match(text, /^v=mw1; btih=/);
  assert.match(text, /; sig=[A-Za-z0-9_-]{86}$/);
  const parsed = parsePointer(text).record;
  const v = await verifyPointer(parsed, 'example.com', { now: NOW });
  // status/withdrawn are on every result since v0.2.1 (A3); nx since v0.3 (harden-loader, MF-28).
  assert.deepEqual(v, { ok: true, reason: null, expired: false, rotated: false, owner: owner.pub, pinned: false, expiresAt: EXP * 1000, status: 'active', withdrawn: false, nx: 'none' });
  assert.ok(owner.pub.startsWith('p256:') && text.includes('owner=p256:'), 'owner= is algorithm-tagged (A2)');
  // independent check with node:crypto: ECDSA P-256 SHA-256 over the UTF-8 signing input, IEEE P1363 r||s
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: owner.jwk.x, y: owner.jwk.y }, format: 'jwk' });
  const ok = nodeVerify('sha256', Buffer.from(signingInput(parsed, 'example.com'), 'utf8'),
    { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parsed.sig, 'base64url'));
  assert.equal(ok, true);
  // the input record was not modified
  const input = baseRecord(owner);
  await signPointer(input, 'example.com', owner.privateKey);
  assert.equal(input.sig, undefined);
});

test('vector: key case changes after signing still verify; whitespace too', async () => {
  const owner = await newOwner();
  const text = await signedText(owner);
  const upper = text.replace(/(^|; )([a-z]+)=/g, (m, sep, k) => sep + k.toUpperCase() + '=');
  assert.notEqual(upper, text);
  const spaced = '  ' + text.split('; ').join(' ;\t ') + ' ;  ';
  for (const variant of [upper, spaced]) {
    const r = parsePointer(variant);
    assert.equal(r.ok, true);
    assert.equal((await verifyPointer(r.record, 'example.com', { now: NOW })).ok, true);
  }
});

test('vector: an unknown key appended after signing fails; changing any value fails', async () => {
  const owner = await newOwner();
  const text = await signedText(owner, 'example.com', { extra: { note: 'kept-and-signed' } });
  const parsed = parsePointer(text).record;
  assert.equal(parsed.extra.note, 'kept-and-signed');
  assert.equal((await verifyPointer(parsed, 'example.com', { now: NOW })).ok, true);
  const appended = parsePointer(text + '; future=1').record;
  assert.equal((await verifyPointer(appended, 'example.com', { now: NOW })).reason, 'bad-sig');
  const swapped = parsePointer(text.replace('btih=' + BTIH, 'btih=' + BTIH2)).record;
  assert.equal((await verifyPointer(swapped, 'example.com', { now: NOW })).reason, 'bad-sig');
  const dropped = parsePointer(text.replace(/tr=wss:\/\/tracker\.webtorrent\.dev; /, '')).record;
  assert.equal((await verifyPointer(dropped, 'example.com', { now: NOW })).reason, 'bad-sig');
  // a signature for one scope never verifies for another
  assert.equal((await verifyPointer(parsed, 'evil.example', { now: NOW })).reason, 'bad-sig');
  // editing a parsed record in memory is caught too
  const edited = Object.assign({}, parsed, { ws: ['https://evil.example/ws/'] });
  assert.equal((await verifyPointer(edited, 'example.com', { now: NOW })).reason, 'bad-sig');
});

test("vector: ';' inside a percent-encoded URL is one value and the signature holds", async () => {
  const owner = await newOwner();
  const signed = await signPointer(baseRecord(owner, { xs: ['https://h.example/a;b.torrent?x=1&y=2'], dn: 'A;B ' + E_ACUTE }), 'example.com', owner.privateKey);
  const text = formatPointer(signed);
  assert.ok(text.includes('xs=https://h.example/a%3Bb.torrent?x=1&y=2'), text);
  assert.ok(text.includes('dn=A%3BB%20%C3%A9'), text);
  assert.ok(/^[\x20-\x7e]+$/.test(text), 'formatted record is printable ASCII');
  const parsed = parsePointer(text).record;
  assert.deepEqual(parsed.xs, ['https://h.example/a%3Bb.torrent?x=1&y=2']);
  assert.equal(parsed.dn, 'A;B ' + E_ACUTE);
  assert.equal((await verifyPointer(parsed, 'example.com', { now: NOW })).ok, true);
  // a hand-written pointer that already carries %3B verifies when signed as-is
  const hand = parsePointer('v=mw1; btih=' + BTIH + '; xs=https://h.example/x%3By.torrent; owner=' + owner.pub + '; seq=1; exp=' + EXP).record;
  const handSigned = await signPointer(hand, 'example.com', owner.privateKey);
  assert.deepEqual(handSigned.xs, ['https://h.example/x%3By.torrent'], 'no double encoding of %');
  assert.equal((await verifyPointer(parsePointer(formatPointer(handSigned)).record, 'example.com', { now: NOW })).ok, true);
});

test('vector: IDN scope signs and verifies as its punycode A-label', async () => {
  const owner = await newOwner();
  const text = await signedText(owner, IDN);
  const parsed = parsePointer(text).record;
  for (const scope of [IDN, IDN_ASCII, IDN.toUpperCase(), 'https://' + IDN + '/x']) {
    assert.equal((await verifyPointer(parsed, scope, { now: NOW })).ok, true, scope);
  }
  assert.ok(signingInput(parsed, IDN).endsWith('\n' + IDN_ASCII));
  assert.equal((await verifyPointer(parsed, 'bucher.example', { now: NOW })).reason, 'bad-sig');
});

test('vector: expired fresh record is rejected, the same record from cache is allowed by the caller flag', async () => {
  const owner = await newOwner();
  const parsed = parsePointer(await signedText(owner)).record;
  const later = (EXP + 1) * 1000;
  const fresh = await verifyPointer(parsed, 'example.com', { now: later });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.reason, 'expired');
  assert.equal(fresh.expired, true);
  const cached = await verifyPointer(parsed, 'example.com', { now: later, allowExpired: true });
  assert.equal(cached.ok, true);
  assert.equal(cached.expired, true);
  assert.equal(cached.expiresAt, EXP * 1000);
  // allowExpired never excuses a bad signature
  const forged = Object.assign({}, parsed, { seq: 8 });
  assert.equal((await verifyPointer(forged, 'example.com', { now: later, allowExpired: true })).reason, 'bad-sig');
  // exactly at exp counts as expired
  assert.equal((await verifyPointer(parsed, 'example.com', { now: EXP * 1000 })).reason, 'expired');
});

test('verifyPointer: exp more than 400 days ahead, missing seq/exp, bad owner, unsigned, no btih', async () => {
  const owner = await newOwner();
  // code review round 1: a one-day clock-skew margin, so a visitor whose clock lags still
  // accepts a record signed at the 400-day limit (a default withdrawal used to be refused).
  const far = parsePointer(await signedText(owner, 'example.com', { exp: Math.floor(NOW / 1000) + (MAX_EXP_DAYS + 1) * DAY + 1 })).record;
  assert.equal((await verifyPointer(far, 'example.com', { now: NOW })).reason, 'exp-too-far');
  const edge = parsePointer(await signedText(owner, 'example.com', { exp: Math.floor(NOW / 1000) + MAX_EXP_DAYS * DAY })).record;
  assert.equal((await verifyPointer(edge, 'example.com', { now: NOW })).ok, true, 'exactly 400 days is allowed');
  const lagging = parsePointer(await signedText(owner, 'example.com', { exp: Math.floor(NOW / 1000) + MAX_EXP_DAYS * DAY + 1800 })).record;
  assert.equal((await verifyPointer(lagging, 'example.com', { now: NOW })).ok, true, '400 days plus 30 minutes passes with the margin');
  const good = parsePointer(await signedText(owner)).record;
  const noSeq = parsePointer(good.raw.replace(/seq=7; /, '')).record;
  assert.equal((await verifyPointer(noSeq, 'example.com', { now: NOW })).reason, 'missing-seq');
  const noExp = parsePointer(good.raw.replace(/exp=\d+; /, '')).record;
  assert.equal((await verifyPointer(noExp, 'example.com', { now: NOW })).reason, 'missing-exp');
  const badOwner = parsePointer(good.raw.replace(/owner=[^;]+/, 'owner=AAAA')).record;
  assert.equal((await verifyPointer(badOwner, 'example.com', { now: NOW })).reason, 'bad-owner');
  const unsigned = parsePointer(good.raw.replace(/; sig=.*$/, '')).record;
  assert.equal(unsigned.signed, false);
  const u = await verifyPointer(unsigned, 'example.com', { now: NOW, pinnedOwner: owner.pub });
  assert.equal(u.reason, 'unsigned');
  assert.equal(u.pinned, true, 'callers learn the scope is pinned and must refuse it');
  assert.equal((await verifyPointer({ sig: 'x' }, 'example.com')).reason, 'no-btih');
  assert.equal((await verifyPointer(null, 'example.com')).reason, 'no-btih');
  await assert.rejects(verifyPointer(good, ''), TypeError);
  await assert.rejects(signPointer(baseRecord(owner, { seq: undefined }), 'example.com', owner.privateKey), /seq/);
  await assert.rejects(signPointer(baseRecord(owner, { exp: null }), 'example.com', owner.privateKey), /exp/);
  const other = await newOwner();
  await assert.rejects(signPointer(baseRecord(owner), 'example.com', other.privateKey), /does not match/);
});

test('verifyPointer: seq rollback is refused, equal seq is fine', async () => {
  const owner = await newOwner();
  const parsed = parsePointer(await signedText(owner)).record; // seq 7
  assert.equal((await verifyPointer(parsed, 'example.com', { now: NOW, cachedSeq: 8 })).reason, 'seq-rollback');
  assert.equal((await verifyPointer(parsed, 'example.com', { now: NOW, cachedSeq: 7 })).ok, true);
  assert.equal((await verifyPointer(parsed, 'example.com', { now: NOW, cachedSeq: 0 })).ok, true);
});

test('vector: rotation with a valid rot is silent; without it the owner change is reported', async () => {
  const oldOwner = await newOwner();
  const newKey = await newOwner();
  const seq = 9;
  // v0.3 (harden-loader): rot= is v2 only, bound to the scope.
  const rot = await signRotation({ owner: newKey.pub, seq, scope: 'example.com' }, oldOwner.privateKey);
  const rotated = parsePointer(await signedText(newKey, 'example.com', { seq, rot })).record;
  assert.equal(await verifyRotation(rotated, oldOwner.pub, 'example.com'), true);
  assert.equal(await verifyRotation(rotated, oldOwner.pub), false, 'v0.3: no scope, nothing verifies');
  const v = await verifyPointer(rotated, 'example.com', { now: NOW, pinnedOwner: oldOwner.pub, cachedSeq: 7 });
  assert.equal(v.ok, true);
  assert.equal(v.rotated, true);
  // no rot at all
  const plain = parsePointer(await signedText(newKey, 'example.com', { seq })).record;
  assert.equal((await verifyPointer(plain, 'example.com', { now: NOW, pinnedOwner: oldOwner.pub })).reason, 'owner-changed');
  // rot signed by somebody else, or over another seq
  const stranger = await newOwner();
  const badRot = await signRotation({ owner: newKey.pub, seq, scope: 'example.com' }, stranger.privateKey);
  const forged = parsePointer(await signedText(newKey, 'example.com', { seq, rot: badRot })).record;
  assert.equal((await verifyPointer(forged, 'example.com', { now: NOW, pinnedOwner: oldOwner.pub })).reason, 'owner-changed');
  const otherSeqRot = await signRotation({ owner: newKey.pub, seq: seq + 1, scope: 'example.com' }, oldOwner.privateKey);
  const wrongSeq = parsePointer(await signedText(newKey, 'example.com', { seq, rot: otherSeqRot })).record;
  assert.equal(await verifyRotation(wrongSeq, oldOwner.pub, 'example.com'), false);
  assert.equal((await verifyPointer(wrongSeq, 'example.com', { now: NOW, pinnedOwner: oldOwner.pub })).reason, 'owner-changed');
  // the same pinned owner needs no rot
  assert.equal((await verifyPointer(plain, 'example.com', { now: NOW, pinnedOwner: newKey.pub })).rotated, false);
  assert.throws(() => rotationInput('PUB', 3), TypeError, 'v0.3: the v1 input is deleted');
});

test('vector: seq rollback across a key rotation is refused even with a valid rot', async () => {
  const oldOwner = await newOwner();
  const newKey = await newOwner();
  const seq = 4;
  const rot = await signRotation({ owner: newKey.pub, seq, scope: 'example.com' }, oldOwner.privateKey);
  const rec = parsePointer(await signedText(newKey, 'example.com', { seq, rot })).record;
  assert.equal(await verifyRotation(rec, oldOwner.pub, 'example.com'), true);
  const v = await verifyPointer(rec, 'example.com', { now: NOW, pinnedOwner: oldOwner.pub, cachedSeq: 5 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'seq-rollback');
});

test('formatPointer: canonical order; edited parsed records are re-encoded consistently', async () => {
  const owner = await newOwner();
  const parsed = parsePointer(await signedText(owner, 'example.com', { extra: { aaa: '1' } })).record;
  assert.match(parsed.raw, /^v=mw1; btih=\w+; dn=[^;]+; xs=[^;]+; ws=[^;]+; tr=[^;]+; tr=[^;]+; owner=[^;]+; seq=7; exp=\d+; aaa=1; sig=/);
  const bumped = Object.assign({}, parsed, { seq: 8 });
  assert.match(formatPointer(bumped), /; seq=8; /);
  assert.equal((await verifyPointer(bumped, 'example.com', { now: NOW })).reason, 'bad-sig');
  const resigned = await signPointer(bumped, 'example.com', owner.privateKey);
  assert.equal(resigned.seq, 8);
  assert.equal((await verifyPointer(parsePointer(formatPointer(resigned)).record, 'example.com', { now: NOW })).ok, true);
  // a bare magnet record formats as an unsigned pointer
  const m = parsePointer('magnet:?xt=urn:btih:' + BTIH + '&dn=x').record;
  assert.equal(formatPointer(m), 'v=mw1; btih=' + BTIH + '; dn=x');
  assert.throws(() => formatPointer(Object.assign({}, m, { seq: -1 })), TypeError);
  assert.throws(() => formatPointer({ btih: BTIH, extra: { BAD: '1' } }), TypeError);
});

// ------------------------------------------------------------------------------------------
// ledger id, hub label
// ------------------------------------------------------------------------------------------

test('ledgerIdFor: signed = mw1: + 27 chars of b64url(sha256(owner|chain-or-scope)); unsigned = btih:', async () => {
  const owner = await newOwner();
  const signed = parsePointer(await signedText(owner, IDN)).record;
  const expected = 'mw1:' + createHash('sha256').update(owner.pub + '|' + IDN_ASCII).digest('base64url').slice(0, 27);
  assert.equal(await ledgerIdFor(signed, IDN), expected);
  assert.equal(await ledgerIdFor(signed, IDN_ASCII), expected);
  const chained = parsePointer(await signedText(owner, 'example.com', { chain: 'guestbook' })).record;
  const expectedChain = 'mw1:' + createHash('sha256').update(owner.pub + '|guestbook').digest('base64url').slice(0, 27);
  assert.equal(await ledgerIdFor(chained, 'example.com'), expectedChain);
  assert.equal(await ledgerIdFor(chained, 'other.example'), expectedChain, 'chain label, not scope');
  assert.equal(expected.length, 31);
  const unsigned = parsePointer('v=mw1; btih=' + BTIH + '; chain=ignored').record;
  assert.equal(await ledgerIdFor(unsigned, 'example.com'), 'btih:' + BTIH);
  assert.equal(await ledgerIdFor(parsePointer(BTIH).record, 'x.example'), 'btih:' + BTIH);
  await assert.rejects(ledgerIdFor({}, 'x.example'), TypeError);
});

test('hubLabelFor: 32 base32 characters; signed from the ledger id, bare magnets from the btih, in disjoint label sets', async () => {
  const owner = await newOwner();
  const signed = parsePointer(await signedText(owner)).record;
  const lid = await ledgerIdFor(signed, 'example.com');
  const label = hubLabelFor(signed, lid);
  assert.match(label, /^[a-z2-7]{32}$/);
  assert.equal(label, b32(createHash('sha256').update('mw-label-v1\nledger\n' + lid).digest()).slice(0, 32));
  const magnet = parsePointer('magnet:?xt=urn:btih:' + BTIH).record;
  const mlabel = hubLabelFor(magnet, 'btih:' + BTIH);
  assert.equal(mlabel, b32(createHash('sha256').update('mw-label-v1\nbtih\n' + BTIH).digest()).slice(0, 32));
  assert.equal(hubLabelFor(null, 'btih:' + BTIH), mlabel);
  assert.throws(() => hubLabelFor(signed, null), TypeError);
  // Code review round 1: an unsigned record whose btih decodes from a signed site's label (the v0.2
  // collision: base32(btih) shared the signed labels' 160-bit space) gets a different label.
  const collider = Buffer.from(b32decode(label)).toString('hex');
  assert.equal(collider.length, 40);
  const forged = parsePointer('v=mw1; st=withdrawn; btih=' + collider).record;
  assert.notEqual(hubLabelFor(forged, 'btih:' + collider), label);
  assert.notEqual(hubLabelFor(forged, 'btih:' + collider), b32(Buffer.from(collider, 'hex')), 'never the plain base32 of the btih');
});

test('internal sync SHA-256 matches node:crypto across block boundaries', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
    const data = new Uint8Array(n).map((_, i) => (i * 131 + n) & 255);
    assert.equal(Buffer.from(_sha256SyncForTests(data)).toString('hex'), createHash('sha256').update(data).digest('hex'), 'length ' + n);
  }
});

// ------------------------------------------------------------------------------------------
// TXT helpers
// ------------------------------------------------------------------------------------------

const utf8Len = (s) => Buffer.byteLength(s, 'utf8');

test('splitTxt: chunks of at most 255 UTF-8 bytes that never split a code point', () => {
  assert.deepEqual(splitTxt(''), ['']);
  assert.deepEqual(splitTxt('abc'), ['abc']);
  const ascii = 'x'.repeat(600);
  assert.deepEqual(splitTxt(ascii).map((c) => c.length), [255, 255, 90]);
  const twoByte = E_ACUTE.repeat(200); // 400 bytes
  assert.deepEqual(splitTxt(twoByte).map(utf8Len), [254, 146]);
  const emoji = String.fromCodePoint(0x1f600);
  const four = emoji.repeat(100); // 400 bytes
  assert.deepEqual(splitTxt(four).map(utf8Len), [252, 148]);
  const mixed = 'a' + emoji.repeat(64) + 'bc' + String.fromCharCode(0x20ac).repeat(90);
  const chunks = splitTxt(mixed);
  assert.equal(chunks.join(''), mixed);
  for (const c of chunks) {
    assert.ok(utf8Len(c) <= 255);
    assert.ok(!/[\ud800-\udbff]$/.test(c), 'no dangling high surrogate');
  }
  assert.equal(utf8Len(chunks[0]), 253, 'a + 63 emoji = 253 bytes; the 64th emoji would not fit');
  assert.equal(chunks[1].codePointAt(0), 0x1f600, 'the next chunk starts with the whole emoji');
  const exact = 'y'.repeat(255);
  assert.deepEqual(splitTxt(exact), [exact]);
  assert.deepEqual(splitTxt('y'.repeat(256)), [exact, 'y']);
});

test('joinTxtData: Cloudflare quoting variants, Google unquoted, malformed left alone', () => {
  const q = String.fromCharCode(0x22);
  const bs = String.fromCharCode(0x5c);
  assert.equal(joinTxtData(q + 'v=mw1; btih=' + BTIH + q), 'v=mw1; btih=' + BTIH);
  assert.equal(joinTxtData(q + 'abc' + q + ' ' + q + 'def' + q), 'abcdef', 'joined with no separator');
  assert.equal(joinTxtData(q + 'abc' + q + q + 'def' + q), 'abcdef');
  assert.equal(joinTxtData(q + 'a' + bs + q + 'b' + bs + bs + 'c' + q), 'a' + q + 'b' + bs + 'c');
  assert.equal(joinTxtData(q + 'caf' + bs + '195' + bs + '169' + q), 'caf' + E_ACUTE, 'decimal escapes are bytes, read as UTF-8');
  assert.equal(joinTxtData(q + 'x' + bs + '059y' + q), 'x;y');
  assert.equal(joinTxtData(q + q), '');
  assert.equal(joinTxtData(q + 'caf' + E_ACUTE + q), 'caf' + E_ACUTE, 'raw non-ASCII inside quotes is kept');
  const google = 'v=mw1; btih=' + BTIH + '; dn=x';
  assert.equal(joinTxtData(google), google);
  for (const bad of [q + 'abc' + q + ' def', q + 'abc', q + 'a' + bs + q, q + bs + '999' + q, q]) {
    assert.equal(joinTxtData(bad), bad, JSON.stringify(bad));
  }
  assert.equal(joinTxtData(undefined), '');
});

test('splitTxt + presentation quoting + joinTxtData restores a long signed pointer', async () => {
  const owner = await newOwner();
  const text = await signedText(owner, 'example.com', { tr: ['wss://a.example', 'wss://b.example', 'wss://c.example'], extra: { note: 'x'.repeat(120) } });
  assert.ok(utf8Len(text) > 255);
  const chunks = splitTxt(text);
  assert.ok(chunks.length >= 2);
  const presentation = chunks.map((c) => '"' + c.replace(/[\\"]/g, (m) => '\\' + m) + '"').join(' ');
  const joined = joinTxtData(presentation);
  assert.equal(joined, text);
  assert.equal((await verifyPointer(parsePointer(joined).record, 'example.com', { now: NOW })).ok, true);
});

// ------------------------------------------------------------------------------------------
// choosing and using records
// ------------------------------------------------------------------------------------------

test('pickRecord: highest seq, ties to the smallest sig, signed above unsigned, failures ignored', () => {
  const rec = (seq, sig, extra = {}) => Object.assign({ btih: BTIH, seq, sig, owner: 'O', signed: Boolean(sig), raw: 'r' + seq + sig }, extra);
  const a = rec(3, 'BBB');
  const b = rec(5, 'ZZZ');
  const c = rec(5, 'AAA');
  const unsigned = { btih: BTIH2, seq: 99, sig: null, signed: false, raw: 'u' };
  assert.equal(pickRecord([a, b, c, unsigned]), c);
  assert.equal(pickRecord([unsigned, a]), a);
  assert.equal(pickRecord([{ ok: false, error: 'bad' }, { ok: true, record: b }, null, {}]), b);
  assert.equal(pickRecord([]), null);
  assert.equal(pickRecord(null), null);
  const u1 = { btih: BTIH, raw: 'b', signed: false };
  const u2 = { btih: BTIH2, raw: 'a', signed: false };
  assert.equal(pickRecord([u1, u2]), u2, 'unsigned ties break deterministically');
  assert.equal(pickRecord([u2, u1]), u2);
});

test('magnetFromRecord: defaults only for unsigned records; xs emitted; base resolves relative URLs', async () => {
  const owner = await newOwner();
  const signed = parsePointer(await signedText(owner)).record;
  const defaults = ['wss://default-1.example', 'wss://tracker.example.com'];
  const m1 = parseMagnet(magnetFromRecord(signed, { defaultTrackers: defaults }));
  assert.deepEqual(m1.tr, ['wss://tracker.example.com', 'wss://tracker.webtorrent.dev'], 'signed tr list used exactly');
  assert.deepEqual(m1.xs, signed.xs);
  assert.deepEqual(m1.ws, signed.ws);
  assert.equal(m1.dn, 'Peer Guestbook');
  const unsigned = parsePointer('v=mw1; btih=' + BTIH + '; tr=wss://own.example; xs=/_mw/t/' + BTIH + '.torrent; ws=/_mw/ws/').record;
  const m2 = parseMagnet(magnetFromRecord(unsigned, { defaultTrackers: defaults, base: 'https://site.example/blog/post.html' }));
  assert.deepEqual(m2.tr, ['wss://own.example', 'wss://default-1.example', 'wss://tracker.example.com']);
  assert.deepEqual(m2.xs, ['https://site.example/_mw/t/' + BTIH + '.torrent']);
  assert.deepEqual(m2.ws, ['https://site.example/_mw/ws/']);
  const bare = parsePointer(BTIH).record;
  assert.equal(magnetFromRecord(bare), 'magnet:?xt=urn:btih:' + BTIH);
  assert.throws(() => magnetFromRecord(null), TypeError);
});

// ------------------------------------------------------------------------------------------
// v0.2.1 (DIGEST-AMENDMENTS A2, A3): tagged owner, st= fail closed, why=, aud=, ct=, lg=, budget
// ------------------------------------------------------------------------------------------

test('A2: owner= must be an algorithm-tagged key; an untagged v0.2 owner is bad-owner, never signed or verified', async () => {
  const owner = await newOwner();
  const untagged = owner.pub.slice('p256:'.length);
  await assert.rejects(signPointer(baseRecord(owner, { owner: untagged }), 'example.com', owner.privateKey), /tagged P-256 public key/);
  const text = await signedText(owner);
  const forged = parsePointer(text.replace('owner=' + owner.pub, 'owner=' + untagged)).record;
  assert.equal((await verifyPointer(forged, 'example.com', { now: NOW })).reason, 'bad-owner');
  const other = parsePointer(text.replace('owner=' + owner.pub, 'owner=ed25519:' + untagged)).record;
  assert.equal((await verifyPointer(other, 'example.com', { now: NOW })).reason, 'bad-owner');
  // The ledger id hashes the tagged string, so it differs from a v0.2 id for the same key.
  const signed = parsePointer(text).record;
  const id = await ledgerIdFor(signed, 'example.com');
  const digest = createHash('sha256').update(owner.pub + '|example.com').digest('base64url').slice(0, 27);
  assert.equal(id, 'mw1:' + digest);
});

test('A3: st= is fail-closed: no st or st=ok is active, every other value withdraws the scope', () => {
  const base = 'v=mw1; btih=' + BTIH;
  const status = (extra) => {
    const res = parsePointer(base + extra);
    assert.equal(res.ok, true, extra);
    return [pointerStatus(res.record), res.record.withdrawn, isWithdrawn(res.record)];
  };
  assert.deepEqual(status(''), ['active', false, false]);
  assert.deepEqual(status('; st=ok'), ['active', false, false]);
  for (const st of ['withdrawn', 'active', 'paused', 'kill', 'OK', 'Withdrawn', 'ok.', '0', '']) {
    assert.deepEqual(status('; st=' + st), ['withdrawn', true, true], 'st=' + st);
  }
  // Code review round 1: a present but empty st= is a withdrawal, and stays on the wire.
  assert.match(formatPointer(parsePointer(base + '; st=').record), /^v=mw1; st=; btih=/);
  assert.equal(STATUS_OK, 'ok');
  assert.equal(STATUS_WITHDRAWN, 'withdrawn');
  // A withdrawal names no content: btih may be missing and is then read as 40 zeros.
  const bare = parsePointer('v=mw1; st=withdrawn; why=copyright');
  assert.equal(bare.ok, true);
  assert.equal(bare.record.btih, ZERO_BTIH);
  assert.equal(bare.record.withdrawn, true);
  assert.equal(parsePointer('v=mw1; st=ok').ok, false, 'an active record still needs btih');
  assert.equal(parsePointer('v=mw1; st=withdrawn; st=ok; btih=' + BTIH).error, 'duplicate-key');
  // Records built by hand (no parse) are judged from their fields, and from extra for old callers.
  assert.equal(pointerStatus({ btih: BTIH, st: 'withdrawn' }), 'withdrawn');
  assert.equal(pointerStatus({ btih: BTIH, extra: { st: 'gone' } }), 'withdrawn');
  assert.equal(pointerStatus({ btih: BTIH }), 'active');
  assert.equal(pointerStatus(null), 'active');
  // Bare magnets have no status key.
  assert.equal(parsePointer('magnet:?xt=urn:btih:' + BTIH).record.withdrawn, false);
});

test('A3: a signed withdrawal verifies as { ok: true, withdrawn: true }; rollback, scope and owner rules still apply', async () => {
  const owner = await newOwner();
  const record = withdrawalRecord({ owner: owner.pub, seq: 8, exp: EXP, why: 'No longer published', ct: 'mailto:abuse@example.com' });
  assert.equal(record.st, 'withdrawn');
  assert.equal(record.btih, ZERO_BTIH);
  const signed = await signPointer(record, 'example.com', owner.privateKey);
  const text = formatPointer(signed);
  assert.match(text, /^v=mw1; st=withdrawn; btih=0{40}; owner=p256:/);
  assert.ok(text.includes('why=No%20longer%20published'), 'why= is percent-encoded like dn');
  assert.ok(text.includes('ct=mailto:abuse@example.com'));
  const parsed = parsePointer(text).record;
  assert.equal(parsed.why, 'No longer published', 'why is decoded for display');
  assert.equal(parsed.ct, 'mailto:abuse@example.com');
  const v = await verifyPointer(parsed, 'example.com', { now: NOW, cachedSeq: 7 });
  assert.equal(v.ok, true);
  assert.equal(v.withdrawn, true);
  assert.equal(v.status, 'withdrawn');
  assert.equal((await verifyPointer(parsed, 'example.com', { now: NOW, cachedSeq: 9 })).reason, 'seq-rollback', 'an old withdrawal cannot undo a later publish');
  assert.equal((await verifyPointer(parsed, 'other.example', { now: NOW })).reason, 'bad-sig');
  const stranger = await newOwner();
  const pinnedElsewhere = await verifyPointer(parsed, 'example.com', { now: NOW, pinnedOwner: stranger.pub });
  assert.equal(pinnedElsewhere.reason, 'owner-changed', 'only the pinned owner (or a valid rot) withdraws');
  assert.equal(pinnedElsewhere.withdrawn, true, 'the claim is reported even when it is not authentic');
  // Editing why= after signing breaks the signature: why, ct, aud, lg and st are all signed.
  for (const [from, to] of [['why=No%20longer', 'why=Still'], ['st=withdrawn', 'st=paused'], ['ct=mailto:abuse', 'ct=mailto:other']]) {
    const edited = parsePointer(text.replace(from, to)).record;
    assert.equal((await verifyPointer(edited, 'example.com', { now: NOW })).reason, 'bad-sig', from);
  }
  // Without btih on the wire the record still verifies (the signing input has no btih line).
  const noBtih = await signPointer(Object.assign(withdrawalRecord({ owner: owner.pub, seq: 9, exp: EXP }), { btih: null }), 'example.com', owner.privateKey);
  assert.ok(!formatPointer(noBtih).includes('btih='));
  const reparsed = parsePointer(formatPointer(noBtih)).record;
  assert.equal(reparsed.btih, ZERO_BTIH);
  assert.equal((await verifyPointer(reparsed, 'example.com', { now: NOW })).ok, true);
  // An unsigned withdrawal is reported as such (callers decide; a pinned scope ignores it).
  const unsigned = parsePointer('v=mw1; st=withdrawn; btih=' + BTIH).record;
  const u = await verifyPointer(unsigned, 'example.com', { now: NOW });
  assert.deepEqual([u.ok, u.reason, u.withdrawn], [false, 'unsigned', true]);
  // Fail closed for any caller that would build a magnet: there is none.
  assert.throws(() => magnetFromRecord(parsed), (err) => err.code === 'E_WITHDRAWN');
  assert.throws(() => magnetFromRecord(unsigned), (err) => err.code === 'E_WITHDRAWN');
  // Several records: the higher-seq withdrawal wins over the older active record.
  const active = parsePointer(await signedText(owner)).record; // seq 7
  assert.equal(pickRecord([active, parsed]), parsed);
  assert.throws(() => withdrawalRecord({ owner: owner.pub.slice(5), seq: 1, exp: EXP }), TypeError);
  assert.throws(() => withdrawalRecord({ owner: owner.pub, seq: -1, exp: EXP }), TypeError);
  assert.throws(() => withdrawalRecord({ owner: owner.pub, seq: 1 }), TypeError);
});

test('A3: aud=, ct= and lg= are parsed and signed; aud= is a token list', async () => {
  const owner = await newOwner();
  const text = await signedText(owner, 'example.com', { aud: 'kids', ct: 'https://example.com/report', lg: 'https://example.com/legal' });
  const r = parsePointer(text).record;
  assert.equal(r.aud, 'kids');
  assert.equal(r.ct, 'https://example.com/report');
  assert.equal(r.lg, 'https://example.com/legal');
  assert.deepEqual(r.extra, {}, 'named fields, not unknown keys');
  assert.equal((await verifyPointer(r, 'example.com', { now: NOW })).ok, true);
  assert.equal((await verifyPointer(parsePointer(text.replace('aud=kids', 'aud=general')).record, 'example.com', { now: NOW })).reason, 'bad-sig');
  assert.deepEqual([...AUDIENCES], ['general', 'kids', 'sensitive']);
  assert.deepEqual([...WHY_CODES], ['owner', 'copyright', 'court', 'tos']);
  assert.deepEqual(audienceTokens(r), ['kids']);
  assert.deepEqual(audienceTokens({}), []);
  assert.deepEqual(audienceTokens({ aud: 'EEA,uk' }), ['eea', 'uk']);
  assert.deepEqual(audienceTokens({ aud: 'personal%2Cqc' }), ['personal', 'qc'], 'percent-decoded first');
  assert.deepEqual(audienceTokens({ aud: 'general + sensitive' }), ['general', 'sensitive']);
  assert.deepEqual(audienceTokens({ extra: { aud: 'kids' } }), ['kids'], 'a record built before v0.2.1');
  assert.deepEqual(audienceTokens(null), []);
  const listed = parsePointer(await signedText(owner, 'example.com', { aud: 'eea,personal' })).record;
  assert.deepEqual(audienceTokens(listed), ['eea', 'personal']);
  assert.ok(listed.raw.includes('aud=eea,personal'), 'commas need no escaping');
  // A record built before these keys were named (they sat in extra) signs to the same bytes.
  const viaExtra = await signPointer(baseRecord(owner, { extra: { aud: 'kids', ct: 'https://example.com/report', lg: 'https://example.com/legal' } }), 'example.com', owner.privateKey);
  assert.equal(signingInput(viaExtra, 'example.com'), signingInput(r, 'example.com'));
  assert.equal(viaExtra.aud, 'kids');
  assert.throws(() => formatPointer(Object.assign(baseRecord(owner), { aud: 'kids', extra: { aud: 'general' } })), /both as a field and in extra/);
});

test('A3: size budget (MW-PTR/1): SHOULD <= 450 bytes, MUST <= 900; a realistic signed record and its TXT strings', async () => {
  assert.equal(POINTER_SIZE_SHOULD, 450);
  assert.equal(POINTER_SIZE_MAX, 900);
  const owner = await newOwner();
  // A realistic record: two trackers, one web seed, xs, gen, seq, exp, tagged owner, sig.
  const text = await signedText(owner, 'example.com', { gen: 'ab'.repeat(32) });
  const b = pointerBudget(text);
  assert.equal(b.bytes, Buffer.byteLength(text, 'utf8'));
  assert.ok(b.bytes > POINTER_SIZE_SHOULD && b.bytes < POINTER_SIZE_MAX, 'about 500 bytes: ' + b.bytes);
  assert.equal(b.withinShould, false);
  assert.equal(b.withinMax, true);
  assert.equal(b.strings, splitTxt(text).length);
  assert.ok(b.strings >= 2 && b.strings <= 3, b.strings + ' strings');
  assert.deepEqual(pointerBudget(parsePointer(text).record), b, 'a record is formatted first');
  // The TXT round trip stays exact: split into <= 255-byte strings, quote, join without spaces.
  const quoted = splitTxt(text).map((s) => '"' + s.replace(/["\\]/g, (c) => '\\' + c) + '"').join(' ');
  assert.equal(joinTxtData(quoted), text);
  const huge = 'v=mw1; btih=' + BTIH + '; ' + Array.from({ length: 30 }, (_, i) => 'tr=wss://tracker' + i + '.example.com').join('; ');
  assert.ok(Buffer.byteLength(huge) > POINTER_SIZE_MAX);
  assert.equal(pointerBudget(huge).withinMax, false);
});

// ---------------------------------------------------------------------------------------------
// code review round 1: rotations bound to their scope, a bounded seq floor, lo=
// ---------------------------------------------------------------------------------------------

test('code review round 1: rot= v2 is bound to the scope (and chain); v0.3: v1 is refused', async () => {
  const k1 = await newOwner();
  const k2 = await newOwner();
  const seq = 9;
  assert.equal(rotationInput(k2.pub, seq, { scope: 'Blog.Example' }), 'mw-rot-v2\nblog.example\n\n' + k2.pub + '\n9');
  assert.equal(rotationInput(k2.pub, seq, { scope: 'blog.example', chain: 'gb' }), 'mw-rot-v2\nblog.example\ngb\n' + k2.pub + '\n9');
  const rot = await signRotation({ owner: k2.pub, seq, scope: 'blog.example' }, k1.privateKey);
  const blog = parsePointer(await signedText(k2, 'blog.example', { seq, rot })).record;
  assert.equal(await verifyRotation(blog, k1.pub, 'blog.example'), true);
  assert.equal(await verifyRotation(blog, k1.pub, 'shop.example'), false, 'a rotation signed for blog is not valid for shop');
  const shop = parsePointer(await signedText(k2, 'shop.example', { seq, rot })).record;
  const v = await verifyPointer(shop, 'shop.example', { now: NOW, pinnedOwner: k1.pub });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'owner-changed', 'the TOFU prompt stays for shop.example');
  assert.equal((await verifyPointer(blog, 'blog.example', { now: NOW, pinnedOwner: k1.pub })).rotated, true);
  // A chain= record binds the label too.
  const chainRot = await signRotation({ owner: k2.pub, seq, scope: 'blog.example', chain: 'gb' }, k1.privateKey);
  const chained = parsePointer(await signedText(k2, 'blog.example', { seq, rot: chainRot, chain: 'gb' })).record;
  assert.equal(await verifyRotation(chained, k1.pub, 'blog.example'), true);
  const relabeled = parsePointer(await signedText(k2, 'blog.example', { seq, rot: chainRot, chain: 'other' })).record;
  assert.equal(await verifyRotation(relabeled, k1.pub, 'blog.example'), false);
  // v0.3 (MF-28): the v1 input is deleted. A rot= signed over it no longer verifies, and the tools can no
  // longer produce one.
  await assert.rejects(signRotation({ owner: k2.pub, seq }, k1.privateKey), TypeError);
  const v1 = b64url.encode(await sign(k1.privateKey, utf8.encode('mw-rot-v1\n' + k2.pub + '\n' + seq)));
  const old = parsePointer(await signedText(k2, 'blog.example', { seq, rot: v1 })).record;
  assert.equal(await verifyRotation(old, k1.pub, 'blog.example'), false);
  assert.equal((await verifyPointer(old, 'blog.example', { now: NOW, pinnedOwner: k1.pub })).reason, 'owner-changed');
});

test('code review round 1: a seq more than a day ahead is refused; a poisoned floor is ignored; the owner is judged first', async () => {
  const k1 = await newOwner();
  const k2 = await newOwner();
  const k3 = await newOwner();
  const nowS = Math.floor(NOW / 1000);
  const ahead = parsePointer(await signedText(k1, 'example.com', { seq: nowS + 2 * DAY })).record;
  assert.equal((await verifyPointer(ahead, 'example.com', { now: NOW })).reason, 'seq-future');
  assert.equal((await verifyPointer(ahead, 'example.com', { now: NOW, allowExpired: true })).ok, true, 'a saved copy is not judged by the clock');
  const soon = parsePointer(await signedText(k1, 'example.com', { seq: nowS + 3600 })).record;
  assert.equal((await verifyPointer(soon, 'example.com', { now: NOW })).ok, true, 'an hour of clock skew is fine');
  // A visitor that saved seq 2^53-1 for K1 (before this check existed) is not locked out for good.
  const poisoned = Number.MAX_SAFE_INTEGER;
  const rot = await signRotation({ owner: k2.pub, seq: nowS, scope: 'example.com' }, k1.privateKey);
  const rotated = parsePointer(await signedText(k2, 'example.com', { seq: nowS, rot })).record;
  const r2 = await verifyPointer(rotated, 'example.com', { now: NOW, pinnedOwner: k1.pub, cachedSeq: poisoned });
  assert.equal(r2.ok, true);
  assert.equal(r2.rotated, true);
  const k3rec = parsePointer(await signedText(k3, 'example.com', { seq: nowS })).record;
  assert.equal((await verifyPointer(k3rec, 'example.com', { now: NOW, pinnedOwner: k1.pub, cachedSeq: poisoned })).reason, 'owner-changed');
  // A sane floor still holds for the same owner, and across a rotation.
  const same = parsePointer(await signedText(k1, 'example.com', { seq: nowS - 10 })).record;
  assert.equal((await verifyPointer(same, 'example.com', { now: NOW, pinnedOwner: k1.pub, cachedSeq: nowS })).reason, 'seq-rollback');
  assert.equal((await verifyPointer(k3rec, 'example.com', { now: NOW, pinnedOwner: k1.pub, cachedSeq: nowS + 10 })).reason, 'owner-changed', 'a new key without rot is the TOFU prompt, not a rollback');
});

test('code review round 1: lo= names the ledger owner after a rotation; the ledger id follows it', async () => {
  const k1 = await newOwner();
  const k2 = await newOwner();
  const plain = parsePointer(await signedText(k1, 'example.com')).record;
  const kept = parsePointer(await signedText(k2, 'example.com', { lo: k1.pub })).record;
  assert.equal(kept.lo, k1.pub);
  assert.match(kept.raw, new RegExp('; owner=' + k2.pub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '; lo=p256:'));
  assert.equal((await verifyPointer(kept, 'example.com', { now: NOW })).ok, true, 'lo= is signed like every key');
  assert.equal(await ledgerIdFor(kept, 'example.com'), await ledgerIdFor(plain, 'example.com'), 'same ledger id as the first owner\'s pointer');
  assert.notEqual(await ledgerIdFor(parsePointer(await signedText(k2, 'example.com')).record, 'example.com'), await ledgerIdFor(plain, 'example.com'));
  const bad = parsePointer((await signedText(k2, 'example.com')).replace(/; sig=/, '; lo=nonsense; sig=')).record;
  assert.equal((await verifyPointer(bad, 'example.com', { now: NOW })).reason, 'bad-owner');
  assert.equal(parsePointer(await signedText(k1, 'example.com')).record.lo, null);
  const w = withdrawalRecord({ owner: k2.pub, seq: 1, exp: EXP, lo: k1.pub });
  assert.equal(w.lo, k1.pub);
  assert.equal(withdrawalRecord({ owner: k2.pub, seq: 1, exp: EXP, lo: k2.pub }).lo, null, 'lo= equal to owner= is left out');
});

// ------------------------------------------------------------------------------------------
// v0.3 C2 doors (docs/research/v03/S4-doors.md D2, D3): dr=, door hosts, parseDoors, the light link
// ------------------------------------------------------------------------------------------

import {
  isDoorHost, isLoopbackDoorHost, doorOrigin, hostOfOrigin, doorsOf, parseDoors, parseHintList, parseLinkFragment,
  normalizeRecordText, formatLightLink, parseLightLink, DOOR_MAX, HINT_MAX, DOORS_TOTAL_MAX, DOOR_PAGE_PATH, FELINAR_SCHEME, ORG_MAX,
} from '../../src/common/pointer.js';
import { readFileSync as readVectorFile } from 'node:fs';

const HUB_SCOPE = 'btih:' + BTIH;
const DOORS3 = ['door-one.example.org', 'door-two.example.net:8443', 'mirror.example.com'];

function hubRecord(owner, more = {}) {
  return Object.assign({
    btih: BTIH, dn: 'Peer Guestbook', ws: ['https://example.com/ws/'], tr: ['wss://tracker.example.com'], chain: 'guestbook',
    owner: owner.pub, org: ['https://example.com'], dr: DOORS3.slice(), seq: 7, exp: EXP,
  }, more);
}

test('isDoorHost: lowercase host[:port] exactly as URL prints it; no scheme, path, userinfo, single label or default port', () => {
  for (const h of ['door.example.org', 'a.b.example', 'door.example:8443', 'xn--bcher-kva.example', 'localhost', 'localhost:8080',
    '127.0.0.1', '127.0.0.1:8081', '[::1]', '[::1]:8443', '203.0.113.7', 'site.localhost:9000', 'a-b.example']) {
    assert.equal(isDoorHost(h), true, h);
  }
  for (const h of ['', 'Door.example', 'https://door.example', 'door.example/', 'door.example/x', 'user@door.example', 'intranet',
    'door.example:443', 'door.example:08443', 'door.example:99999', 'door.example.', '-a.example', 'a_b.example', IDN, 'door.example?x',
    'door.example#x', ' door.example', '0x7f.1', 'door..example', null, 7]) {
    assert.equal(isDoorHost(h), false, String(h));
  }
});

test('doorOrigin / hostOfOrigin / isLoopbackDoorHost: https for doors, http only for a loopback host', () => {
  assert.equal(doorOrigin('door.example.org'), 'https://door.example.org');
  assert.equal(doorOrigin('door.example.org:8443'), 'https://door.example.org:8443');
  assert.equal(doorOrigin('127.0.0.1:8081'), 'http://127.0.0.1:8081');
  assert.equal(doorOrigin('[::1]:9'), 'http://[::1]:9');
  assert.equal(doorOrigin('a.localhost:9000'), 'http://a.localhost:9000');
  assert.equal(doorOrigin('Door.example'), null);
  assert.equal(isLoopbackDoorHost('localhost'), true);
  assert.equal(isLoopbackDoorHost('127.0.0.2'), false, 'only the loopback names isOriginString accepts');
  assert.equal(hostOfOrigin('https://shop.example:8443'), 'shop.example:8443');
  assert.equal(hostOfOrigin('http://127.0.0.1:8080'), '127.0.0.1:8080');
  assert.equal(hostOfOrigin('https://shop.example/'), null, 'an origin has no path');
  assert.equal(hostOfOrigin('http://shop.example'), null, 'http only on loopback');
});

test('dr=: one key holding a comma list; parsed into record.dr, signed, printed after org=, verified on the hub scope', async () => {
  const owner = await newOwner();
  const signed = await signPointer(hubRecord(owner), HUB_SCOPE, owner.privateKey);
  const text = formatPointer(signed);
  assert.match(text, /; org=https:\/\/example\.com; dr=door-one\.example\.org,door-two\.example\.net:8443,mirror\.example\.com; seq=/);
  const res = parsePointer(text);
  assert.equal(res.ok, true);
  assert.deepEqual(res.record.dr, DOORS3);
  assert.deepEqual(doorsOf(res.record), DOORS3);
  assert.equal(formatPointer(res.record), text);
  assert.match(signingInput(res.record, HUB_SCOPE), /\ndr=door-one\.example\.org,door-two\.example\.net:8443,mirror\.example\.com\n/);
  const v = await verifyPointer(res.record, HUB_SCOPE, { now: NOW });
  assert.equal(v.ok, true, v.reason);
  // the same record under a hostname scope (another door's page tag): bad-sig
  assert.equal((await verifyPointer(res.record, 'door-one.example.org', { now: NOW })).reason, 'bad-sig');
  // a record without dr= has dr: [] and prints no dr=
  const plain = parsePointer(formatPointer(await signPointer(hubRecord(owner, { dr: [] }), HUB_SCOPE, owner.privateKey)));
  assert.deepEqual(plain.record.dr, []);
  assert.doesNotMatch(formatPointer(plain.record), /dr=/);
});

test('dr=: a loader that predates dr= kept it as an unknown key; a record built with extra.dr signs the same input', async () => {
  const owner = await newOwner();
  const viaExtra = Object.assign(hubRecord(owner, { dr: [] }), { extra: { dr: DOORS3.join(',') } });
  const viaField = hubRecord(owner);
  assert.equal(signingInput(viaExtra, HUB_SCOPE), signingInput(viaField, HUB_SCOPE));
  const signed = await signPointer(viaExtra, HUB_SCOPE, owner.privateKey);
  assert.deepEqual(signed.dr, DOORS3, 'the parse of the signed text names the field');
  assert.equal((await verifyPointer(signed, HUB_SCOPE, { now: NOW })).ok, true);
  assert.throws(() => formatPointer(Object.assign(hubRecord(owner), { extra: { dr: 'a.example.org' } })), /both as a field and in extra/);
});

test('dr=: at most DOOR_MAX distinct door hosts; anything else does not parse (bad-value); a second dr= key is duplicate-key', () => {
  const head = 'v=mw1; btih=' + BTIH + '; dr=';
  const hosts = (n) => Array.from({ length: n }, (_, i) => 'd' + i + '.example.org').join(',');
  assert.equal(DOOR_MAX, 8);
  assert.equal(parsePointer(head + hosts(8)).ok, true);
  assert.equal(parsePointer(head + hosts(9)).error, 'bad-value');
  for (const bad of ['', 'https://a.example', 'a.example/', 'A.example', 'a.example,a.example', 'a.example,,b.example', 'intranet', 'a.example:443', 'a.example, b.example']) {
    assert.equal(parsePointer(head + bad).error, 'bad-value', JSON.stringify(bad));
  }
  assert.equal(parsePointer(head + 'a.example; dr=b.example').error, 'duplicate-key');
});

test('dr=: removing, adding or reordering one door after signing fails the signature (bad-sig)', async () => {
  const owner = await newOwner();
  const text = formatPointer(await signPointer(hubRecord(owner), HUB_SCOPE, owner.privateKey));
  for (const [what, edited] of [
    ['removed', text.replace('door-two.example.net:8443,', '')],
    ['added', text.replace('mirror.example.com', 'mirror.example.com,evil.example')],
    ['reordered', text.replace('door-one.example.org,door-two.example.net:8443', 'door-two.example.net:8443,door-one.example.org')],
    ['dropped', text.replace(/; dr=[^;]*/, '')],
  ]) {
    assert.notEqual(edited, text, what);
    const r = parsePointer(edited);
    assert.equal(r.ok, true, what);
    assert.equal((await verifyPointer(r.record, HUB_SCOPE, { now: NOW })).reason, 'bad-sig', what);
  }
});

test('golden vectors ptr-027 to ptr-034 (doors): node:crypto verifies ptr-027 independently; the rest refuse as stated', async () => {
  const doc = JSON.parse(readVectorFile(new URL('../vectors/pointer.json', import.meta.url), 'utf8'));
  const by = Object.fromEntries(doc.vectors.map((v) => [v.id, v]));
  const v27 = by['ptr-027-doors-hub-link'];
  assert.ok(v27, 'ptr-027 exists');
  const r = parsePointer(v27.text).record;
  assert.deepEqual(r.dr, v27.expect.parse.fields.dr);
  assert.equal(signingInput(r, v27.scope), v27.expect.signingInput);
  // Independent check: the raw r||s signature over the UTF-8 signing input verifies with node:crypto (IEEE P1363).
  const raw = b64url.decode(r.owner.slice(5));
  const jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(raw.slice(1, 33)).toString('base64url'), y: Buffer.from(raw.slice(33, 65)).toString('base64url') };
  const ok = nodeVerify('sha256', Buffer.from(v27.expect.signingInput, 'utf8'), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(r.sig, 'base64url'));
  assert.equal(ok, true);
  assert.equal(v27.expect.verify.ok, true);
  assert.equal(by['ptr-028-doors-hostname-scope'].expect.verify.reason, 'bad-sig');
  assert.equal(by['ptr-029-doors-door-removed'].expect.verify.reason, 'bad-sig');
  assert.equal(by['ptr-028-doors-hostname-scope'].expect.ledgerId, v27.expect.ledgerId, 'chain= keeps one ledger id on every door');
  for (const [id, error] of [['ptr-030-dr-nine-hosts', 'bad-value'], ['ptr-031-dr-not-a-host', 'bad-value'], ['ptr-032-dr-twice', 'duplicate-key'], ['ptr-033-dr-repeated-host', 'bad-value'], ['ptr-034-dr-uppercase', 'bad-value']]) {
    assert.equal(parsePointer(by[id].text).error, error, id);
  }
});

test('parseDoors: owner (org=) then guest (dr=) then hints, each host once, invalid hosts dropped, at most 12', async () => {
  const owner = await newOwner();
  const r = parsePointer(formatPointer(await signPointer(hubRecord(owner, {
    org: ['https://example.com', 'https://www.example.com'], dr: ['www.example.com', 'door.example.org', 'mirror.example.net'],
  }), HUB_SCOPE, owner.privateKey))).record;
  const d = parseDoors(r, ['MIRROR.example.net', 'hint.example.org', 'bad host', 'https://x.example']);
  assert.deepEqual(d.owner, ['example.com', 'www.example.com']);
  assert.deepEqual(d.guest, ['door.example.org', 'mirror.example.net'], 'a host already named as an owner door stays an owner door');
  assert.deepEqual(d.hints, ['hint.example.org'], 'hints are lowercased; a host named before is not repeated');
  assert.deepEqual(d.all.map((x) => x.kind), ['owner', 'owner', 'guest', 'guest', 'hint']);
  assert.equal(d.all[0].origin, 'https://example.com');
  // caps: 4 owner + 8 guest = 12, hints never pass the total
  const many = {
    org: ['https://o1.example', 'https://o2.example', 'https://o3.example', 'https://o4.example'],
    dr: Array.from({ length: 8 }, (_, i) => 'g' + i + '.example'), extra: {},
  };
  const all = parseDoors(many, ['h1.example', 'h2.example']);
  assert.equal(ORG_MAX + DOOR_MAX, DOORS_TOTAL_MAX);
  assert.equal(all.all.length, DOORS_TOTAL_MAX);
  assert.deepEqual(all.hints, []);
  assert.deepEqual(parseDoors(null, ['a.example', 'b.example', 'c.example', 'd.example', 'e.example']).hints.length, HINT_MAX);
  assert.deepEqual(parseDoors({ extra: { org: 'https://shop.example', dr: 'door.example' } }).all.map((x) => x.host), ['shop.example', 'door.example'], 'a record that predates the fields');
});

test('parseHintList / parseLinkFragment: segments after the record, #mwd= hints (at most 4), mwgen kept raw, unknown ignored', () => {
  assert.deepEqual(parseHintList('a.example,B.example,bad host,a.example,c.example:8443,d.example,e.example'), ['a.example', 'b.example', 'c.example:8443', 'd.example']);
  const f = parseLinkFragment('#v=mw1;%20btih=' + BTIH + '#mwgen=W3t9XQ#mwd=a.example,b.example#zz=1#mwd=c.example#=x#Bad Name=1');
  assert.equal(f.head, 'v=mw1;%20btih=' + BTIH);
  assert.equal(f.decoded, false);
  assert.equal(f.genesis, 'mwgen=W3t9XQ');
  assert.deepEqual(f.hints, ['a.example', 'b.example'], 'the first #mwd= wins');
  assert.equal(f.segments.zz, '1');
  assert.equal(normalizeRecordText(f.head), 'v=mw1; btih=' + BTIH);
  // an encoded head is decoded once; the separators come from the decode
  const enc = parseLinkFragment('v%3Dmw1%3B%20btih%3D' + BTIH + '%3B%20dn%3DMy%2520Site#mwd=a.example');
  assert.equal(enc.decoded, true);
  assert.equal(enc.head, 'v=mw1; btih=' + BTIH + '; dn=My%20Site');
  assert.deepEqual(enc.hints, ['a.example']);
  // web+felinar: literal and as a protocol handler's %s (the whole link escaped once more)
  const lit = parseLinkFragment('web+felinar:v%3Dmw1%3B%20btih%3D' + BTIH + '#mwd=a.example');
  assert.equal(lit.handler, true);
  assert.equal(lit.head, 'v=mw1; btih=' + BTIH);
  const viaHandler = parseLinkFragment('#' + encodeURIComponent('web+felinar:v%3Dmw1%3B%20btih%3D' + BTIH + '#mwd=a.example'));
  assert.equal(viaHandler.handler, true);
  assert.equal(viaHandler.head, 'v=mw1; btih=' + BTIH);
  assert.deepEqual(viaHandler.hints, ['a.example']);
  assert.deepEqual(parseLinkFragment(undefined).head, '');
});

test('formatLightLink / parseLightLink: the record arrives exactly as signed (spaces and %20 in values too) and verifies', async () => {
  const owner = await newOwner();
  const signed = await signPointer(hubRecord(owner, { dn: 'My Site 2', chain: 'my site' }), HUB_SCOPE, owner.privateKey);
  const text = formatPointer(signed);
  assert.match(text, /dn=My%20Site%202/);
  assert.match(text, /chain=my site/, 'a raw space inside a value');
  const link = formatLightLink({ door: 'door-one.example.org', record: signed, genesis: 'mwgen=W3t9XQ', hints: ['hint.example.net'] });
  assert.ok(link.startsWith('https://door-one.example.org' + DOOR_PAGE_PATH + '#v%3Dmw1%3B%20'), link.slice(0, 80));
  assert.match(link, /#mwgen=W3t9XQ#mwd=hint\.example\.net$/);
  // what a browser does with it: URL parsing, then location.hash
  const hash = new URL(link).hash;
  const p = parseLightLink(link);
  assert.equal(p.ok, true);
  assert.equal(p.door, 'door-one.example.org');
  assert.equal(p.origin, 'https://door-one.example.org');
  assert.equal(p.path, DOOR_PAGE_PATH);
  assert.equal(p.record, text);
  assert.deepEqual(p.hints, ['hint.example.net']);
  assert.equal(p.genesis, 'mwgen=W3t9XQ');
  assert.equal(parseLinkFragment(hash).head, text);
  const r = parsePointer(p.record);
  assert.equal((await verifyPointer(r.record, HUB_SCOPE, { now: NOW })).ok, true);
  // the protocol-handler form, and what the handler page receives (%s = the whole link escaped)
  const web = formatLightLink({ record: text, hints: ['hint.example.net'] });
  assert.ok(web.startsWith(FELINAR_SCHEME + 'v%3Dmw1'));
  assert.equal(parseLightLink(web).record, text);
  const handled = 'https://door-two.example.net:8443' + DOOR_PAGE_PATH + '#' + encodeURIComponent(web);
  const h = parseLightLink(handled);
  assert.equal(h.record, text);
  assert.equal(h.handler, true);
  assert.deepEqual(h.hints, ['hint.example.net']);
  assert.equal((await verifyPointer(parsePointer(h.record).record, HUB_SCOPE, { now: NOW })).ok, true);
  // a literal fragment (a person pasted the record as is): the separator spaces come back, value escapes stay
  const literal = parseLightLink('https://hub.example/#' + text.replace(/ /g, '%20'));
  assert.equal(literal.decoded, false);
  assert.equal(parsePointer(literal.record).record.dn, 'My Site 2');
  // a loopback door is http; the root of a hub is accepted, another page is not
  assert.ok(formatLightLink({ door: '127.0.0.1:8081', record: text }).startsWith('http://127.0.0.1:8081/_mw/open.html#'));
  assert.equal(parseLightLink('https://door.example/#' + encodeURIComponent(text)).path, '/');
  assert.equal(parseLightLink('https://door.example/other.html#' + encodeURIComponent(text)).error, 'path');
  assert.equal(parseLightLink('ftp://door.example/#x').error, 'not-a-link');
  assert.equal(parseLightLink('https://door.example/_mw/open.html').error, 'no-record');
  assert.equal(parseLightLink('').error, 'empty');
});

test('formatLightLink refuses what cannot travel in a fragment, a bad door and bad hints; caps the hints at HINT_MAX', () => {
  const text = 'v=mw1; btih=' + BTIH;
  assert.throws(() => formatLightLink({ door: 'Door.example', record: text }), /not a door host/);
  assert.throws(() => formatLightLink({ door: 'door.example', record: text + '; ws=https://a.example/#x' }), /cannot travel/);
  assert.throws(() => formatLightLink({ door: 'door.example', record: text + '; ws=https://a.example/<x>' }), /cannot travel/);
  assert.throws(() => formatLightLink({ door: 'door.example', record: '' }), /record/);
  assert.throws(() => formatLightLink({ door: 'door.example', record: text, hints: ['https://x.example'] }), /hint/);
  assert.throws(() => formatLightLink({ door: 'door.example', record: text, genesis: 'mwgen=a b' }), /genesis/);
  const link = formatLightLink({ door: 'door.example', record: text, hints: ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'] });
  assert.match(link, /#mwd=a\.example,b\.example,c\.example,d\.example$/);
});

test('light link size (S4 F1 measured 457 to 730 bytes): a hub record with 4 owner and 8 guest doors stays under the 900-byte limit', async () => {
  const owner = await newOwner();
  const rec = hubRecord(owner, {
    org: ['https://door-one.example.org', 'https://door-two.example.net', 'https://mirror.example.com', 'https://cdn3.example.io'],
    dr: ['door-one.example.org', 'door-two.example.net', 'mirror.example.com', 'cdn3.example.io', 'alt.example.dev', 'edge.example.app', 'w.example.page', 'x.example.site'],
    xs: ['https://seed.example.org/ws/my-site.torrent'], tr: ['wss://tracker.example.org/announce', 'wss://t2.example.net/announce'],
  });
  const text = formatPointer(await signPointer(rec, HUB_SCOPE, owner.privateKey));
  const b = pointerBudget(text);
  assert.equal(b.withinMax, true, b.bytes + ' bytes');
  assert.ok(b.bytes > POINTER_SIZE_SHOULD, 'above the 450-byte SHOULD, as S4 measured for every hub record');
});
