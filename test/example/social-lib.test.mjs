// The small libraries of examples/social: identifiers (checked against the loader's own functions), routes, notices, local search,
// the QR encoder (Reed-Solomon against published codewords, pinned symbols, every version at its capacity), the strings
// (compared with src/loader/strings.js) and the hub adapter (against a fake mw at the contract boundary, with every GAP named).
// Run: node --test test/example/social-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as IDS from '../../examples/social/js/ids.js';
import * as HUB from '../../examples/social/js/hub.js';
import * as ROUTER from '../../examples/social/js/router.js';
import * as NOTICES from '../../examples/social/js/notices.js';
import { LocalIndex, words } from '../../examples/social/js/search.js';
import { encodeQr, qrPath, capacityBytes, dataCodewords, rsDivisor, rsRemainder } from '../../examples/social/js/qr.js';
import * as STR from '../../examples/social/js/strings.js';
import { createStore } from '../../examples/social/js/store.js';
import { DEFAULT_FLAGS, DIRECTORY_LABEL, SETTINGS_SECTIONS, LIMITS } from '../../examples/social/js/config.js';
import { hubLabelFor as loaderLabel, ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { encode as loaderBase32 } from '../../src/common/base32.js';
import { authorScope as loaderScope } from '../../src/chain/state.js';
import { ERROR_TEXT, CARD_TEXT, REPLACED_SENTENCES, NOSCRIPT_TEXT } from '../../src/loader/strings.js';
import { ledgerId, hashOf, pubOf, MINUTE } from './social-helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '../../examples/social');
const hex = (u8) => Buffer.from(u8).toString('hex');

// ---------------------------------------------------------------------------------------------- identifiers
test('ids: sha256, base64url and base32 agree with Node, for every padding length', () => {
  for (const n of [0, 1, 2, 3, 4, 31, 55, 56, 63, 64, 65, 119, 1000]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(hex(IDS.sha256(data)), createHash('sha256').update(data).digest('hex'), 'sha256 of ' + n + ' bytes');
    assert.equal(IDS.b64urlEncode(data), Buffer.from(data).toString('base64url'));
    assert.deepEqual(Array.from(IDS.b64urlDecode(IDS.b64urlEncode(data))), Array.from(data));
  }
  assert.equal(IDS.b64urlDecode('a'), null, 'a single character is not base64url');
  assert.equal(IDS.b64urlDecode('ab+/'), null);
  assert.equal(IDS.base32Encode(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])), '32w353y', 'RFC 4648 alphabet, lowercase, no padding');
  assert.equal(IDS.base32Encode(new TextEncoder().encode('foobar')), 'mzxw6ytboi', 'the RFC 4648 test vector for "foobar"');
  for (let n = 0; n < 20; n++) { const d = Uint8Array.from({ length: n }, (_, i) => i * 13 + 5); assert.equal(IDS.base32Encode(d), loaderBase32(d), 'base32 of ' + n + ' bytes, as the loader encodes it'); }
});

test('ids: the hub label, the ledger id format, the short id and the author scope are the loader\'s', async () => {
  const owner = pubOf(1), chain = 'AAAAAAAAAAAAAAAAAAAAAA', sig = 'S'.repeat(86);
  const rec = parsePointer('v=mw1; btih=' + '0123456789abcdef0123456789abcdef01234567' + '; owner=' + owner + '; chain=' + chain + '; seq=1; exp=1900000000; sig=' + sig);
  assert.ok(rec.ok, JSON.stringify(rec));
  const id = await ledgerIdFor(rec.record, 'whatever.example');
  assert.match(id, /^mw1:[A-Za-z0-9_-]{27}$/);
  assert.ok(IDS.isLedgerId(id));
  assert.equal(IDS.hubLabelFor(id), loaderLabel(rec.record, id), 'a signed record: kind ledger');
  assert.equal(IDS.hubLabelFor('btih:' + '0123456789abcdef0123456789abcdef01234567'), loaderLabel({ btih: '0123456789abcdef0123456789abcdef01234567' }, null), 'a bare magnet: kind btih');
  assert.ok(IDS.isLabel(IDS.hubLabelFor(id)));
  assert.equal(IDS.hubLabelFor(ledgerId(1)), IDS.hubLabelFor(ledgerId(1)));
  assert.notEqual(IDS.hubLabelFor(ledgerId(1)), IDS.hubLabelFor(ledgerId(2)));
  // The loader's short id: the first 8 hex of sha256 of the raw key without the tag.
  const raw = Buffer.from(owner.slice(5), 'base64url');
  assert.equal(IDS.shortIdOf(owner), createHash('sha256').update(raw).digest('hex').slice(0, 8));
  assert.equal(raw.length, 65);
  assert.equal(IDS.authorScope(owner), loaderScope(owner));
  assert.match(IDS.authorScope(owner), IDS.SCOPE_KEY.source ? /^@[A-Za-z0-9_-]{16}\/$/ : /x/);
  assert.ok(IDS.isPub(owner) && !IDS.isPub('p256:short') && !IDS.isPub(owner.slice(5)));
  assert.ok(IDS.isHash(hashOf('x')) && !IDS.isHash('ABC'));
  assert.equal(IDS.jsonBytes({ a: '\u00e9' }), 10);
  assert.ok(IDS.hueOf('x') >= 0 && IDS.hueOf('x') < 360);
});

// ---------------------------------------------------------------------------------------------- routes
test('routes: every route of R 3.7 parses and builds back to the same path; anything else is the not-found state', () => {
  const label = IDS.hubLabelFor(ledgerId(1)), h = hashOf('p'), short = 'a1b2c3d4';
  const table = [
    ['/', 'home', {}], ['/@' + label, 'profile', { label }], ['/@' + label + '/p/' + h, 'post', { label, h }], ['/g/' + label, 'group', { label }],
    ['/messages', 'messages', {}], ['/messages/' + short, 'thread', { short }], ['/notifications', 'notifications', {}], ['/media', 'media', { id: '' }],
    ['/media/abc_123-X', 'media', { id: 'abc_123-X' }], ['/settings', 'settings', { section: '' }], ['/about', 'about', {}],
    ['/@example.org', 'profile', { handle: 'example.org' }], ['/@Sub.Example.co.uk', 'notfound', {}],
  ];
  for (const [path, name, params] of table) {
    const r = ROUTER.parseRoute(path);
    assert.equal(r.name, name, path);
    for (const k of Object.keys(params)) assert.equal(r[k], params[k], path + ' ' + k);
    if (name !== 'notfound') assert.equal(ROUTER.hrefFor(r.name, r), path, 'round trip ' + path);
  }
  for (const section of SETTINGS_SECTIONS) assert.deepEqual([ROUTER.parseRoute('/settings/' + section).name, ROUTER.parseRoute('/settings/' + section).section], ['settings', section]);
  assert.equal(SETTINGS_SECTIONS.length, 12);
  for (const bad of ['/nope', '/@short', '/@' + label + '/p/xyz', '/@' + label + '/x', '/g/' + label.toUpperCase(), '/messages/zz', '/messages/a1b2c3d4/extra', '/settings/unknown', '/about/us', '/media/a b', '/../etc', '/a//b', '/%2e%2e/x', '/%E0%A4%A']) {
    assert.equal(ROUTER.parseRoute(bad).name, 'notfound', bad);
  }
  assert.equal(ROUTER.parseRoute('/messages/').name, 'messages', 'a trailing slash is the same route');
  assert.equal(ROUTER.parseRoute('/about?x=1#y').name, 'about', 'query and fragment are not part of the route');
  assert.equal(ROUTER.parseRoute('/index.html').name, 'home');
  assert.ok(ROUTER.ROUTE_NAMES.includes('notfound') && ROUTER.ROUTE_NAMES.length === 11);
  assert.equal(ROUTER.isAppPath('/about'), true);
  assert.equal(ROUTER.isAppPath('/nope'), false);
});

// ---------------------------------------------------------------------------------------------- notices
test('notices: a small typed message for follow, reply, mention, share, wall and join, and nothing else passes for one', () => {
  const l = ledgerId(2), ref = { l, h: hashOf('r') }, target = { l: ledgerId(3), h: hashOf('t') };
  const good = [{ k: 'follow', from: l }, { k: 'follow', from: l, ptr: 'v=mw1; btih=x' }, { k: 'reply', from: l, ref, target }, { k: 'mention', from: l, ref }, { k: 'share', from: l, ref, target },
    { k: 'wall', from: l, ref }, { k: 'join', from: l, group: ledgerId(9), note: 'hello' }];
  for (const n of good) {
    const text = NOTICES.encodeNotice(n);
    assert.ok(text && text.startsWith(NOTICES.NOTICE_PREFIX), JSON.stringify(n));
    assert.deepEqual(NOTICES.decodeNotice(text), Object.assign({ v: 1 }, n));
    assert.ok(new TextEncoder().encode(text).length <= 1000);
  }
  assert.equal(NOTICES.NOTICE_KINDS.length, 6);
  for (const bad of ['hello', '', null, 7, NOTICES.NOTICE_PREFIX + '{', NOTICES.NOTICE_PREFIX + '[]', NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 2, k: 'follow', from: l }),
    NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'bogus', from: l }), NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'follow', from: 'nope' }),
    NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'reply', from: l, ref }), NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'mention', from: l }),
    NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'join', from: l }), NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'follow', from: l, note: 'x'.repeat(141) }),
    NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'follow', from: l, ptr: 'x'.repeat(2000) })]) {
    assert.equal(NOTICES.decodeNotice(bad), null, String(bad).slice(0, 40));
  }
  assert.equal(NOTICES.encodeNotice({ k: 'reply', from: l }), null, 'an invalid notice is not encoded');
  // Unknown fields are dropped on decode: a notice cannot smuggle text into the page.
  const sneaky = NOTICES.decodeNotice(NOTICES.NOTICE_PREFIX + JSON.stringify({ v: 1, k: 'follow', from: l, html: '<b>x</b>' }));
  assert.deepEqual(Object.keys(sneaky).sort(), ['from', 'k', 'v']);
});

test('notifications: one entry per event however often it arrives, newest first, at most 200; mentions found in synced posts', () => {
  const l = ledgerId(2), n = { v: 1, k: 'follow', from: l };
  let list = NOTICES.addNotification([], n, 1000);
  list = NOTICES.addNotification(list, n, 2000);
  assert.equal(list.length, 1);
  assert.equal(list[0].t, 1000, 'the first arrival is kept');
  assert.equal(NOTICES.unseenCount(list), 1);
  assert.equal(NOTICES.unseenCount(NOTICES.markAllSeen(list)), 0);
  let many = [];
  for (let i = 0; i < 230; i++) many = NOTICES.addNotification(many, { v: 1, k: 'mention', from: l, ref: { l, h: hashOf('m' + i) } }, i);
  assert.equal(many.length, 200);
  assert.equal(many[0].t, 229);
  const items = [{ l, h: hashOf('a'), text: 'hi @deadbeef!' }, { l, h: hashOf('b'), text: 'no a@deadbeef' }, { l: ledgerId(1), h: hashOf('c'), text: '@deadbeef mine' }, { l, h: hashOf('d'), text: '@deadbeefs' }];
  assert.deepEqual(NOTICES.mentionsOfMe(items, 'deadbeef', ledgerId(1)).map((m) => m.ref.h), [hashOf('a')], 'own posts and look-alikes do not count');
  assert.deepEqual(NOTICES.mentionsOfMe(items, '', ledgerId(1)), []);
});

// ---------------------------------------------------------------------------------------------- search
test('local search: words, AND semantics with a prefix on the last word, newest first, capped by dropping the oldest', () => {
  assert.deepEqual(words('Hello, World! 42 \u00e9t\u00e9'), ['hello', 'world', '42', '\u00e9t\u00e9']);
  const ix = new LocalIndex({ capBytes: 10 * 1024 * 1024 });
  ix.add({ id: 'a', kind: 'post', text: 'Brick walls and red doors', ts: 100 });
  ix.add({ id: 'b', kind: 'post', text: 'A red bicycle by the wall', ts: 300 });
  ix.add({ id: 'c', kind: 'profile', text: 'Doorman who likes bricks', ts: 200 });
  assert.deepEqual(ix.search('red').map((d) => d.id), ['b', 'a'], 'newest first, no scoring');
  assert.deepEqual(ix.search('red wal').map((d) => d.id), ['b', 'a'], 'the last word may be a prefix ("wal" matches "wall" and "walls")');
  assert.deepEqual(ix.search('re door'), [], 'earlier words must match whole: "re" is not a word here');
  assert.deepEqual(ix.search('red door').map((d) => d.id), ['a']);
  assert.deepEqual(ix.search('brick', { kind: 'profile' }).map((d) => d.id), ['c']);
  assert.deepEqual(ix.search(''), []);
  assert.deepEqual(ix.search('zzz'), []);
  assert.equal(ix.size, 3);
  ix.add({ id: 'a', kind: 'post', text: 'replaced', ts: 100 });
  assert.deepEqual(ix.search('brick').map((d) => d.id), ['c'], 'an existing id is replaced');
  assert.equal(ix.remove('c'), true);
  assert.equal(ix.remove('c'), false);
  const small = new LocalIndex({ capBytes: 2000 });
  let dropped = 0;
  for (let i = 0; i < 30; i++) dropped += small.add({ id: 'd' + i, kind: 'post', text: 'word' + i + ' ' + 'filler '.repeat(10), ts: i });
  assert.ok(dropped > 0 && small.bytes <= 2000, 'over the cap the oldest go first (' + small.size + ' kept)');
  assert.ok(small.has('d29') && !small.has('d0'));
  assert.equal(LIMITS.searchIndexBytesPhone, 10 * 1024 * 1024);
});

// ---------------------------------------------------------------------------------------------- QR
test('qr: Reed-Solomon matches the published codewords, and every version holds exactly its capacity at every level', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]; // "HELLO WORLD", version 1-M
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.deepEqual([capacityBytes(1, 'L'), capacityBytes(1, 'M'), capacityBytes(1, 'Q'), capacityBytes(1, 'H')], [17, 14, 11, 7]);
  assert.deepEqual([capacityBytes(10, 'L'), capacityBytes(10, 'M'), capacityBytes(10, 'Q'), capacityBytes(10, 'H')], [271, 213, 151, 119]);
  assert.deepEqual([capacityBytes(40, 'L'), capacityBytes(40, 'M'), capacityBytes(40, 'Q'), capacityBytes(40, 'H')], [2953, 2331, 1663, 1273]);
  assert.equal(dataCodewords(1, 'L'), 19);
  assert.equal(dataCodewords(40, 'H'), 1276);
  for (let v = 1; v <= 40; v += 3) for (const e of ['L', 'M', 'Q', 'H']) {
    const s = encodeQr('x'.repeat(capacityBytes(v, e)), { ecc: e });
    assert.equal(s.version, v, 'v' + v + e);
    assert.equal(s.size, 17 + 4 * v);
    if (v < 40) assert.equal(encodeQr('x'.repeat(capacityBytes(v, e) + 1), { ecc: e }).version, v + 1, 'one more byte needs v' + (v + 1));
  }
  assert.throws(() => encodeQr('x'.repeat(2954), { ecc: 'L' }), RangeError);
  assert.throws(() => encodeQr('x', { ecc: 'Z' }), RangeError);
  assert.throws(() => encodeQr('x'.repeat(100), { ecc: 'L', maxVersion: 2 }), RangeError);
});

test('qr: symbols are pinned by hash (each also decodes with an independent decoder: CoreImage, checked when this encoder was written), with the structure the standard fixes', () => {
  const hash = (s) => createHash('sha256').update(s.modules.map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('')).digest('hex');
  const pins = [
    ['hello', 'M', 1, '99ccedcf0d82e92a63894c8b42e405a3ac50eafa33ee2ce68fa895813fdcb386'],
    ['hello world', 'L', 1, '09434ae2f1e048f844260d117ebcad36a8849c5e864a520cd6dd3dfe4c8a452b'],
    ['https://example.org/', 'Q', 2, '0c5dcc9978d83de249088f87bb25f8e2168539c553fd2c20fe1eac52d82fe85b'],
    ['x'.repeat(capacityBytes(7, 'M')), 'M', 7, '39fabad74b9daebadbedcc7a7fe0cab84625a14627e0c779522e63a26538d223'],
    ['x'.repeat(capacityBytes(10, 'L') + 1), 'L', 11, '7280e78082de47e2dbca35fafe6cdabdecae8ca5cf43654f6c2e249d911f9b34'],
    ['\u00e9\u00e8 unicode \u20ac', 'H', 3, 'c31a180a885cb8be95b0273273a77ec4363c37607bcea5d534d36bec4b5a4f05'],
  ];
  for (const [text, ecc, version, sha] of pins) {
    const s = encodeQr(text, { ecc });
    assert.equal(s.version, version, text.slice(0, 12));
    assert.equal(hash(s), sha, 'symbol for ' + JSON.stringify(text.slice(0, 20)) + ' at ' + ecc);
    const m = s.modules, n = s.size;
    // Three finder patterns: a 7 x 7 ring, a 3 x 3 centre and a light ring between.
    for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let d = 0; d < 7; d++) assert.ok(m[y0][x0 + d] && m[y0 + 6][x0 + d] && m[y0 + d][x0] && m[y0 + d][x0 + 6], 'finder ring');
      for (let d = 1; d < 6; d++) assert.ok(!m[y0 + 1][x0 + d] && !m[y0 + 5][x0 + d], 'finder inner light ring');
      assert.ok(m[y0 + 3][x0 + 3] && m[y0 + 2][x0 + 2] && m[y0 + 4][x0 + 4], 'finder centre');
    }
    for (let i = 8; i < n - 8; i++) assert.equal(m[6][i], i % 2 === 0, 'timing row'), assert.equal(m[i][6], i % 2 === 0, 'timing column');
    assert.ok(m[n - 8][8], 'the always-dark module');
  }
  // Forcing a mask is honoured (and changes the symbol), and the default picks the lowest penalty of the eight.
  const a = encodeQr('mask test', { ecc: 'M', mask: 3 }), b = encodeQr('mask test', { ecc: 'M', mask: 5 });
  assert.deepEqual([a.mask, b.mask], [3, 5]);
  assert.notEqual(hash(a), hash(b));
  const p = qrPath(encodeQr('hello', { ecc: 'M' }), { border: 4 });
  assert.equal(p.size, 21 + 8);
  assert.match(p.d, /^M[0-9 ]+h\d+v1h-\d+z/);
  assert.equal(qrPath(encodeQr('hello'), { border: 0 }).size, 21);
  // A realistic invite link (a signed pointer in the fragment) fits well inside one symbol.
  const link = 'https://' + 'a'.repeat(32) + '.hub.example/#' + encodeURIComponent('v=mw1; btih=' + '0123456789abcdef0123456789abcdef01234567' + '; owner=' + pubOf(1) + '; chain=abcdefghijklmnopqrstuv; seq=3; exp=1900000000; sig=' + 'S'.repeat(86));
  assert.ok(link.length > 300 && link.length < 700, 'link of ' + link.length + ' characters');
  assert.ok(encodeQr(link, { ecc: 'L' }).version <= 20);
});

// ---------------------------------------------------------------------------------------------- strings
test('strings: the error table is the SDK\'s, the privacy sentences are R 2.14, and the R 3.7 states are verbatim', () => {
  for (const code of Object.keys(ERROR_TEXT.en)) assert.equal(STR.ERROR_TEXT[code], ERROR_TEXT.en[code], code);
  for (const code of ['E_NOT_OWNER', 'E_NOT_MODERATOR', 'E_CAP', 'E_IDENTITY', 'E_NO_HOST', 'E_TIMEOUT', 'E_INTERNAL', 'EMPTY', 'ALT_REQUIRED', 'MENTIONS', 'LINK_HTTPS', 'HANDLE', 'NOT_AVAILABLE', 'NO_HOME', 'HUB_IDENTITY']) assert.ok(STR.ERROR_TEXT[code], code);
  assert.equal(STR.errorMessage({ code: 'E_NO_CHAT_KEY' }, { name: 'Bo' }), 'Bo has not turned on messages on this site.');
  assert.equal(STR.errorMessage({ code: 'E_RATE' }), 'Too fast. Wait a few seconds and try again.');
  assert.equal(STR.errorMessage({ code: 'E_WHAT' }), 'Something went wrong (E_WHAT).');
  assert.equal(STR.errorMessage(null), 'Something went wrong.');
  assert.equal(STR.errorMessage({ code: '__proto__' }), 'Something went wrong (__proto__).', 'a code is looked up as an own key');
  assert.equal(STR.errorMessage('E_LIMIT'), 'That is over the limit.');
  assert.equal(STR.fill('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
  const en = CARD_TEXT.en, rs = REPLACED_SENTENCES.en;
  assert.equal(STR.PRIVACY.whatOthersSee, en.whatOthersSee);
  assert.equal(STR.PRIVACY.recordNote, rs.profileSealed);
  assert.equal(STR.PRIVACY.recordNote, 'Encrypted. The site can read it while you are signed in.');
  assert.equal(STR.PRIVACY.conversations, rs.conversations);
  assert.equal(STR.PRIVACY.presenceKey, rs.presenceKey);
  assert.equal(STR.PRIVACY.presenceOff, rs.presenceOff);
  assert.equal(STR.PRIVACY.keyMatching, rs.keyMatching);
  assert.equal(STR.PRIVACY.rooms, en.rooms);
  assert.equal(STR.PRIVACY.groups, en.groups);
  assert.equal(STR.PRIVACY.fetchPublic, en.fetchPublic);
  assert.equal(STR.PRIVACY.scriptsNote, en.scriptsNote);
  assert.equal(STR.PRIVACY.neverWords, en.neverWords);
  // R 3.7, verbatim.
  assert.equal(STR.STATE.noFollows, "You don't follow anyone yet. Share your QR code or open a friend's link.");
  assert.equal(STR.STATE.unknownRoute, "This page doesn't exist in this app.");
  assert.equal(STR.STATE.unknownPost, "This post isn't in the copies this browser has. It may have been removed, or nobody who has it is online.");
  assert.equal(STR.STATE.noscript, NOSCRIPT_TEXT.en);
  assert.equal(STR.STATE.noscript, "This site loads from other visitors' browsers and needs JavaScript.");
  assert.equal(STR.syncLine(37, 120), 'Catching up: 37 of 120 pages');
  assert.equal(STR.offlineLine('14:02'), 'Showing what this device has. Last updated 14:02.');
  assert.equal(STR.AVAILABLE.kept, 'Kept by the hub');
  assert.equal(STR.AVAILABLE.other, 'Available only while someone who has it is online');
  assert.equal(STR.CONNECTED, 'Connected to you now');
  assert.equal(STR.STATE.withdrawn, 'This page was withdrawn by its owner');
  assert.equal(STR.STATE.removedByHub, 'Removed by this hub');
});

test('strings: the old sentences of R 2.14.2 appear nowhere in the template', () => {
  const OLD = ['Sites cannot match a visitor by key', 'Nobody else can decrypt, including the owner reading the ledger', 'Only you can read this', 'Nothing is sent anywhere.',
    'Everything conversational is ephemeral in the swarm.', 'Holders learn tag, size and arrival time, never sender or recipient', 'Blinded public presence', 'Signing in tells no company that you signed in.',
    'Non-extractable: a script cannot copy the key', 'Uploaded content never executes at the site origin', 'Owner cannot read private lanes', 'Nobody sees you as online unless you turn presence on.'];
  const files = ['index.html', 'js/strings.js', 'js/views/settings.js', 'js/views/messages.js', 'js/views/about.js', 'README.md'];
  for (const f of files) { const text = readFileSync(join(SITE, f), 'utf8'); for (const old of OLD) assert.ok(!text.includes(old), f + ' contains the old sentence "' + old + '"'); }
});

// ---------------------------------------------------------------------------------------------- store and config
test('store: localStorage when it works, memory when it throws, and values that cannot be read fall back', () => {
  const mem = new Map();
  const ok = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), get length() { return mem.size; }, key: (i) => Array.from(mem.keys())[i] };
  const s = createStore(ok);
  assert.equal(s.persistent, true);
  s.set('drafts', [{ id: 'a' }]);
  assert.deepEqual(s.get('drafts', []), [{ id: 'a' }]);
  assert.ok(mem.has('social.drafts'), 'keys are namespaced');
  mem.set('social.theme', '{not json');
  assert.equal(s.get('theme', 'auto'), 'auto', 'unreadable values give the fallback');
  let seen = 0; const off = s.onChange(() => { seen++; });
  s.set('theme', 'dark'); s.remove('theme'); off(); s.set('theme', 'light');
  assert.equal(seen, 2);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const t = createStore(throwing);
  assert.equal(t.persistent, false);
  assert.equal(t.set('a', 1), false);
  assert.equal(t.get('a', 0), 1, 'a failed write still lives in memory for this page view');
  t.remove('a');
  assert.equal(t.get('a', 0), 0);
  const none = createStore(null);
  assert.equal(none.persistent, false);
  none.set('x', [1]);
  assert.deepEqual(none.get('x', []), [1]);
});

test('config: the directory ships off and says why; config.json agrees', () => {
  assert.equal(DEFAULT_FLAGS.directory, false);
  assert.equal(DIRECTORY_LABEL, 'pending counsel');
  const cfg = JSON.parse(readFileSync(join(SITE, 'config.json'), 'utf8'));
  assert.equal(cfg.directory, false);
  assert.equal(cfg.directoryNote, 'pending counsel');
  assert.equal(typeof cfg.appName, 'string');
  assert.equal(cfg.moderationContact, '');
  assert.ok(Object.isFrozen(DEFAULT_FLAGS));
});

// ---------------------------------------------------------------------------------------------- the hub adapter (contract boundary)
test('hub adapter: pointers, ledger ids and invite links are derived the way the loader derives them', async () => {
  const owner = pubOf(7), chain = 'chainchainchainchain01', btih = 'fedcba9876543210fedcba9876543210fedcba98';
  const text = 'v=mw1; btih=' + btih + '; tr=wss://t.example; tr=wss://u.example; owner=' + owner + '; chain=' + chain + '; seq=4; exp=1900000000; sig=' + 'S'.repeat(86);
  const rec = HUB.parsePointerText(text);
  assert.equal(rec.owner, owner);
  assert.equal(rec.chain, chain);
  assert.deepEqual(rec.fields.tr, ['wss://t.example', 'wss://u.example']);
  const real = parsePointer(text);
  assert.ok(real.ok);
  const id = HUB.ledgerIdFromPointer(rec);
  assert.equal(id, await ledgerIdFor(real.record, 'x.example'), 'the template derives the id the loader derives');
  assert.equal(HUB.ledgerIdFromPointer(HUB.parsePointerText('v=mw1; btih=' + btih)), 'btih:' + btih, 'a bare record gives a btih id');
  assert.equal(HUB.ledgerIdFromPointer(HUB.parsePointerText('v=mw1; owner=' + owner + '; sig=' + 'S'.repeat(86))), null, 'a signed record without a chain has no id the template can derive');
  assert.equal(HUB.parsePointerText('hello'), null);
  assert.equal(HUB.parsePointerText('x'.repeat(1300)), null);
  assert.equal(HUB.ledgerIdFromPointer(null), null);
  const loc = { protocol: 'https:', hostname: IDS.hubLabelFor(ledgerId(1)) + '.hub.example', port: '', origin: 'https://x' };
  const label = IDS.hubLabelFor(id);
  const link = HUB.inviteLink({ label, pointer: text }, loc);
  assert.ok(link.startsWith('https://' + label + '.hub.example/#v%3Dmw1'), link.slice(0, 80));
  assert.ok(!link.includes(' ') && !/[;]/.test(link.split('#')[1]), 'the fragment is percent-encoded once');
  const parsed = HUB.parseInviteLink(link);
  assert.deepEqual([parsed.label, parsed.pointer, parsed.ledger], [label, text, id]);
  assert.deepEqual(HUB.parseInviteLink(text), { label, pointer: text, ledger: id }, 'the bare pointer works too');
  assert.deepEqual(HUB.parseInviteLink('https://' + label + '.hub.example/'), { label, pointer: '', ledger: null }, 'a link without a pointer names the label only');
  assert.equal(HUB.parseInviteLink('nonsense'), null);
  assert.equal(HUB.parseInviteLink(''), null);
  assert.equal(HUB.findPointer('https://x.example/#' + text), text, 'a literal fragment works');
  assert.equal(HUB.findPointer('#' + encodeURIComponent(text)), text);
  assert.equal(HUB.findPointer('#section'), '');
  // v0.3 final integration (F-11): an address bar copy escapes only the spaces, and a new page's link carries its genesis after a second '#'.
  assert.ok(text.includes(' '), 'the pointer text has spaces between its fields');
  assert.equal(HUB.findPointer('https://x.example/#' + text.replace(/ /g, '%20')), text, 'only the spaces escaped');
  assert.equal(HUB.findPointer('https://x.example/#' + encodeURIComponent(text) + '#mwgen=abc'), text, 'the genesis is not part of the pointer');
  assert.equal(HUB.findPointer('https://x.example/#' + text + '#mwgen=abc'), text);
  assert.equal(HUB.findPointer('#v=mw1;%20nothing=1'), '', 'a candidate without a btih is not a pointer');
  assert.deepEqual(HUB.hubHost(loc), { label: IDS.hubLabelFor(ledgerId(1)), suffix: 'hub.example', protocol: 'https:', port: '' });
  assert.equal(HUB.hubHost({ hostname: 'localhost', protocol: 'http:', port: '8080' }), null);
  assert.equal(HUB.pageOrigin(HUB.hubHost(Object.assign({}, loc, { port: '8443' })), label), 'https://' + label + '.hub.example:8443');
  assert.equal(HUB.inviteLink({ label, pointer: '' }, { origin: 'http://127.0.0.1:1', hostname: '127.0.0.1', protocol: 'http:' }), 'http://127.0.0.1:1/', 'off a hub the link is the page itself');
});

test('hub adapter: mw.hub and the { ledger } reads are used as the sdk lane amended R 2.11.2 (follow, unfollow, list, createPage); the three GAPs are named, not guessed', async () => {
  const calls = [];
  const L = ledgerId(5);
  const mw = {
    hub: { async follow(t) { calls.push(['follow', t]); return { ledger: L }; }, async unfollow(l) { calls.push(['unfollow', l]); }, async list() { return [{ ledger: L }, ledgerId(6), { id: ledgerId(7), ptr: 'v=mw1' }, { ledger: 'junk' }, null]; } },
    db: { subscribe(fn, o) { calls.push(['subscribe', o]); return () => calls.push(['off']); }, list(name, o) { calls.push(['list', name, o]); return Promise.resolve([]); } },
    site: { async info() { return { pointer: 'v=mw1; btih=abc' }; } },
  };
  const hub = HUB.createHub(mw, null);
  assert.equal(hub.available, true);
  assert.deepEqual(await hub.follow(L), { ledger: L });
  assert.deepEqual(await hub.follow('v=mw1; btih=' + '1'.repeat(40)), { ledger: L }, 'the ledger the SDK names wins');
  await hub.unfollow(L);
  assert.deepEqual((await hub.list()).map((x) => x.ledger), [L, ledgerId(6), ledgerId(7)], 'ids and objects are both accepted; junk is dropped');
  const off = hub.subscribe(L, () => {});
  off();
  await hub.read(L, 'mw.post', { limit: 5 });
  assert.deepEqual(calls.filter((c) => c[0] === 'subscribe' || c[0] === 'list'), [['subscribe', { ledger: L }], ['list', 'mw.post', { limit: 5, ledger: L }]], 'the { ledger } option is the last argument');
  assert.equal(await hub.ownPointer(), 'v=mw1; btih=abc', 'GAP 3: site.info().pointer when the SDK offers it');
  for (const [name, args] of [['createPage', []], ['withdrawPage', []], ['requestJoin', [ledgerId(1)]]]) {
    await assert.rejects(() => hub[name](...args), (e) => e.code === 'NOT_AVAILABLE', 'GAP: ' + name + ' without a method says so');
  }
  assert.equal(hub.canCreatePage, false, '"Create my page" is offered only by a loader that has it');
  assert.equal(hub.canWithdraw, false, '"Delete my page" promises a withdrawal only where the loader has one (GAP 2)');
  mw.hub.withdrawPage = async () => ({ withdrawn: true });
  assert.equal(hub.canWithdraw, true, 'read when asked: a method the loader adds later counts');
  delete mw.hub.withdrawPage;
  const gapped = HUB.createHub({ hub: { createPage: async () => ({ ledgerId: L, label: 'x', url: 'https://x.hub.test:8443/#v%3Dmw1%3B%20btih%3D1#mwgen=e30', pointer: 'v=mw1; btih=1' }), withdrawPage: async () => ({ withdrawn: true }) }, mod: { requestJoin: async (g) => ({ g }) } }, null);
  assert.deepEqual(await gapped.createPage(), { ledgerId: L, label: 'x', url: 'https://x.hub.test:8443/#v%3Dmw1%3B%20btih%3D1#mwgen=e30', origin: 'https://x.hub.test:8443', pointer: 'v=mw1; btih=1' }, 'the address keeps its fragment, which carries the genesis; origin is the part the page remembers');
  const legacyCreate = HUB.createHub({ hub: { createPage: async () => ({ origin: 'https://x' }) } }, null);
  assert.deepEqual(await legacyCreate.createPage(), { ledgerId: null, label: '', url: 'https://x/', origin: 'https://x', pointer: '' }, 'a build that answers with only an origin still works');
  assert.deepEqual(await gapped.withdrawPage(), { withdrawn: true });
  assert.equal(gapped.canCreatePage, true);
  assert.equal(gapped.canWithdraw, true);
  assert.deepEqual(await gapped.requestJoin('G'), { g: 'G' });
  const bare = HUB.createHub({ db: {} }, null);
  assert.equal(bare.available, false);
  assert.deepEqual(await bare.list(), [], 'without mw.hub the template reads only its own ledger');
  await assert.rejects(() => bare.follow(L), (e) => e.code === 'NOT_AVAILABLE');
  assert.throws(() => bare.subscribe(L, () => {}), (e) => e.code === 'NOT_AVAILABLE');
  assert.equal(await bare.ownPointer(), '');
  // Without site.info().pointer the page's own fragment is read from the top page when it is reachable.
  const win = { parent: { location: { hash: '#' + encodeURIComponent('v=mw1; btih=def') } }, location: { hash: '' } };
  win.parent !== win;
  assert.equal(await HUB.createHub({}, win).ownPointer(), 'v=mw1; btih=def');
  const blocked = { get parent() { throw new Error('cross-origin'); }, location: { hash: '' } };
  assert.equal(await HUB.createHub({}, blocked).ownPointer(), '');
  void MINUTE;
});

// ---------------------------------------------------------------------------------------------- the hub directory's checks (MF-67)
test('directory: an entry is verified only with the person\'s signature, the hub\'s countersignature and the page\'s own pointer', async () => {
  const DIR = await import('../../examples/social/js/directory.js');
  const KEYS = await import('./social-directory-keys.mjs');
  const person = await KEYS.newKey(), other = await KEYS.newKey(), hub = await KEYS.newKey();
  const p = KEYS.pointerOf(person.pub, 7), q = KEYS.pointerOf(other.pub, 8);
  const good = await KEYS.entry({ name: 'dee', ledgerId: p.id, pointer: p.pointer, t: 1792454760000 }, person, hub);
  assert.deepEqual(await DIR.verifyEntry(good, { hubKey: hub.pub }), { ok: true });
  assert.equal(DIR.recordText(good), 'mw-dir-v1\n{"ledgerId":' + JSON.stringify(p.id) + ',"name":"dee","pointer":' + JSON.stringify(p.pointer) + ',"t":1792454760000}');
  assert.ok(DIR.hubText(good).startsWith('mw-dir-hub-v1\n{"ledgerId":') && DIR.hubText(good).includes(',"sig":"' + good.sig + '","t":'));
  const reason = async (e, hubKey = hub.pub) => (await DIR.verifyEntry(e, { hubKey })).reason;
  assert.equal(await reason(Object.assign({}, good, { name: 'eve' })), 'sig', 'a renamed entry: the person did not sign that name');
  assert.equal(await reason(Object.assign({}, good, { t: good.t + 1 })), 'sig');
  assert.equal(await reason(Object.assign({}, good, { ledgerId: q.id })), 'pointer', 'a name mapped to another page whose pointer it does not carry');
  assert.equal(await reason(Object.assign({}, good, { pointer: q.pointer, ledgerId: q.id })), 'sig', 'another person\'s pointer: its owner did not sign this name');
  assert.equal(await reason(await KEYS.entry({ name: 'dee', ledgerId: p.id, pointer: p.pointer, t: 1 }, other, hub)), 'sig', 'signed by someone other than the page\'s owner');
  assert.equal(await reason(Object.assign({}, good, { hubSig: undefined })), 'hubSig');
  assert.equal(await reason(await KEYS.entry({ name: 'dee', ledgerId: p.id, pointer: p.pointer, t: 1 }, person, other)), 'hubSig', 'countersigned by a key that is not the hub\'s');
  assert.equal(await reason(good, ''), 'no-hub-key', 'no directoryKey in config.json: nothing can be checked');
  assert.equal(await reason(Object.assign({}, good, { pointer: p.pointer.replace(/; sig=S+$/, '') })), 'pointer', 'an unsigned pointer');
  assert.equal(await reason({ name: 'dee', ledgerId: p.id }), 'shape');
  assert.equal((await DIR.verifyEntry(good, { hubKey: hub.pub, subtle: null })).reason, 'crypto');
  for (const r of ['shape', 'pointer', 'sig', 'no-hub-key', 'hubSig', 'crypto']) assert.ok(DIR.UNVERIFIED_TEXT[r], r);
  // lookup marks what it found; pinStatus counts only verified entries, so an unverified shard cannot move a name.
  const fetchOf = (list) => async () => ({ ok: true, json: async () => list });
  const found = await DIR.lookup('Dee', fetchOf([good]), { hubKey: hub.pub });
  assert.equal(found.entry.verified, true);
  const forged = await DIR.lookup('dee', fetchOf([Object.assign({}, good, { ledgerId: q.id })]), { hubKey: hub.pub });
  assert.deepEqual([forged.entry.verified, forged.entry.reason], [false, 'pointer']);
  const pins = { [p.id]: 'dee' };
  assert.equal(DIR.pinStatus(pins, p.id, found.entry), 'ok');
  assert.equal(DIR.pinStatus(pins, p.id, forged.entry), 'unknown');
  const moved = await DIR.lookup('dee', fetchOf([await KEYS.entry({ name: 'dee', ledgerId: q.id, pointer: q.pointer, t: 2 }, other, hub)]), { hubKey: hub.pub });
  assert.equal(DIR.pinStatus(pins, p.id, moved.entry), 'changed');
});
