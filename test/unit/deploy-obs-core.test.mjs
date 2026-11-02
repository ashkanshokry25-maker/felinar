// Unit tests for deploy/obs-worker/obs-core.js, the part of the usage report endpoint that needs no platform: the masks of
// maskString, the rules of validateBatch, the key of a stored row and its order, the rate limiter, and the log (ingest, events,
// summary, sweep) over an in-memory store. The Worker and its Durable Object around it are in deploy-obs-worker.test.mjs. Nothing
// here opens a socket or reads a file of the deploy folder; the reporters of the loader and of the identity page (src/loader/obs.js,
// src/idp/obs-client.js) are loaded when they are in the tree, to hold the masks of the two sides together.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS, MASK, KEY_PREFIX, META_KEY, maskString, validateBatch, parseBatchText, utf8Length, batchKey, parseBatchKey,
  parseEventsQuery, parseSummaryQuery, createLimiter, createMemoryStorage, createObsLog, createSummary, summarizeRows,
} from '../../deploy/obs-worker/obs-core.js';
import { shortId } from '../../src/idp/cards.js';

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY = 86400000;
const SID = 'k3m8k3m8k3m8';
const FULLWIDTH = '\uff11\uff19\uff12\uff0e\uff11\uff16\uff18\uff0e\uff11\uff0e\uff11'; // 192.168.1.1 in full width characters

/** sidOf(i) -> a valid session id (12 characters of [a-z2-9]) that differs for each i below 16 million. */
const sidOf = (i) => 'k3m8' + i.toString(8).padStart(8, '0').replace(/[0-7]/g, (d) => String(Number(d) + 2));

/** sample(over) -> an example batch of the wire format (docs/OBSERVABILITY.md), with the fields in over replacing its own. */
const sample = (over = {}) => Object.assign({
  v: 1, sid: SID, seq: 7, page: 'door', build: 'bbcb82098cda', loader: '0.3.0', site: 'd680ff36', who: 'da9u-6qug',
  net: { type: 'cellular', effectiveType: '4g' }, ua: { browser: 'chromium', mobile: true }, t0: 1793600000,
  events: [{ t: 1234, n: 'gate.shown', kind: 'consent', host: 'tracker.example' }, { t: 1300, n: 'ui.click', role: 'continue', trusted: true, ms: 12.5, x: null }],
}, over);

// ---------------------------------------------------------------------------------------------- maskString

test('maskString: the rules of safeField, the port that follows an address, and what stays as it is', () => {
  const table = [
    // IPv4 and IPv6 literals become x.x.x.x, with the port and the brackets that belong to them
    ['192.168.1.5', MASK],
    ['connect to 10.0.0.1:8080 failed', 'connect to ' + MASK + ' failed'],
    ['ip1.2.3.4 here', 'ip' + MASK + ' here'],
    ['wss://[2001:db8::1]:443/x#frag', 'wss://' + MASK + '/x#'],
    ['fe80::1%en0', MASK],
    ['1.2.3.4:5.6.7.8', MASK + ':' + MASK],
    [FULLWIDTH, MASK],
    ['192.168\u200b.1.1', MASK],
    ['192.168\u00ad.1.1', MASK],
    ['3f8a1c2e-9b4d-4e7a-8c1d-2b5f6a7e8d90.local ok', MASK + ' ok'],
    ['candidate:842163049 1 udp 1677729535 203.0.113.9 54321 typ srflx raddr 192.168.1.5 rport 54321 generation 0', 'candidate:842163049 1 udp 1677729535 ' + MASK + ' typ srflx raddr ' + MASK + ' generation 0'],
    ['at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok', 'at ' + MASK + ' ok'],
    ['::ffff:192.0.2.1', MASK],
    ['::1', MASK],
    ['fe80::1', MASK],
    ['candidate 1.2.3.4 and 5.6.7.8:9', 'candidate ' + MASK + ' and ' + MASK],
    ['x.x.x.x:99', MASK],
    ['[x.x.x.x]:443', MASK],
    // anything after a # of a string that looks like a URL goes, the # stays
    ['https://x.example/open#secretkey', 'https://x.example/open#'],
    ['/_mw/open#abc', '/_mw/open#'],
    ['go to https://x.example/a#b c', 'go to https://x.example/a#'],
    ['mw://door.example/?x=1#key=abcdef', 'mw://door.example/?x=1#'],
    ['see #3 and #12 now', 'see #3 and #12 now'],
    // a pair code keeps its first 4 characters
    ['abcd-efgh-jkmn', 'abcd'],
    ['code abcd-efgh-jkmn opened', 'code abcd opened'],
    ['ABCD-EFGH-JKMN', 'ABCD'],
    ['abcd-efgh-jkmn-pqrs-tuvw', 'abcd'],
    ['abcd\u2010efgh\u2212jkmn', 'abcd'],
    // a long opaque run keeps its first 8 characters: an infohash, a ledger id, a key
    ['btih=' + 'ab12'.repeat(10) + ' ok', 'btih=ab12ab12 ok'],
    ['mw1:' + 'Zx9_'.repeat(11), 'mw1:Zx9_Zx9_'],
    // control characters become spaces, the ends are trimmed
    ['line1\nline2\u001b[2J', 'line1 line2 [2J'],
    ['  padded  ', 'padded'],
    // what stays
    ['0.3.0', '0.3.0'],
    ['k3f9-2xq1', 'k3f9-2xq1'],
    ['d680ff36', 'd680ff36'],
    [SID, SID],
    ['tracker.openwebtorrent.com', 'tracker.openwebtorrent.com'],
    ['wss://tracker.example:443/announce', 'wss://tracker.example:443/announce'],
    ['step #3', 'step #3'],
    ['caf\u00e9', 'caf\u00e9'],
    ['a'.repeat(40), 'a'.repeat(40)],
    ['', ''],
  ];
  for (const [input, expected] of table) assert.equal(maskString(input), expected, JSON.stringify(input));
  assert.equal(maskString(42), '42', 'anything else is read as text');
});

test('maskString: the masks run before the cut, so an address on the 200 character limit is never left half there', () => {
  const s = 'a'.repeat(190) + ' 192.168.100.200 tail';
  const out = maskString(s);
  assert.equal(out, 'a'.repeat(190) + ' ' + MASK + ' t');
  assert.equal(maskString('b'.repeat(500)).length, LIMITS.maxField);
  assert.equal(maskString('1.2.3.4 ' + 'c'.repeat(2000)).startsWith(MASK + ' c'), true, 'a very long string is cut before the masks run on all of it');
  assert.ok(maskString('d'.repeat(199) + '  e').length <= LIMITS.maxField);
  const smile = String.fromCharCode(0xd83d, 0xde00);
  assert.equal(maskString('a'.repeat(199) + smile), 'a'.repeat(199), 'a pair that straddles the limit goes whole, not in half');
  assert.equal(maskString('a'.repeat(198) + smile), 'a'.repeat(198) + smile, 'one that fits stays');
  assert.equal(maskString('1'.repeat(1999) + smile), '11111111', 'the same at the 2000 character cut that runs first');
});

test('maskString: it is idempotent, never longer than 200, and leaves no address or control character, over 100000 made-up strings', () => {
  let seed = 20261102;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pieces = ['1', '2', '.', ':', '::', 'a', 'f', 'x', '-', '#', '/', '//', ' ', '[', ']', 'http', 'abcd', 'efgh', 'jkmn', '192.168.0.1', 'e3', '9', '\n', 'Z', '_', 'ffff', '8080', 'q', '\u001b'];
  for (let i = 0; i < 100000; i++) {
    let s = '';
    const n = 1 + Math.floor(rnd() * 40);
    for (let j = 0; j < n; j++) s += pieces[Math.floor(rnd() * pieces.length)];
    if (rnd() < 0.05) s = s.repeat(1 + Math.floor(rnd() * 30));
    const once = maskString(s);
    assert.equal(maskString(once), once, 'idempotent: ' + JSON.stringify(s));
    assert.ok(once.length <= LIMITS.maxField, 'cut');
    assert.equal(/\d{1,3}(?:\.\d{1,3}){3}/.test(once), false, 'an IPv4 literal is left in ' + JSON.stringify(s));
    assert.equal(/x\.x\.x\.x:\d{1,5}(?![\d.])/.test(once), false, 'a port is left in ' + JSON.stringify(s));
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(once), false, 'a control character is left');
  }
});

test('maskString: strings with full width characters, invisible characters, odd spaces and lone surrogates come out the same way again, within 200, with no address in them', () => {
  const wellFormed = (str) => {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = str.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return false;
      }
    }
    return true;
  };
  const c = (...codes) => String.fromCharCode(...codes);
  const pieces = [c(0xff11), c(0xff19), c(0xff0e), c(0xff1a), c(0x200b), c(0x00ad), c(0x00a0), c(0x0085), c(0x2010), c(0x2212), c(0x3000), c(0xd83d), c(0xde00), c(0xd83d, 0xde00), c(0xfb03), c(0xfdfa), 'a', 'f', '1', '9', '.', ':', '-', '/', '#', ' ', '[', ']', '192.168.1.1', 'abcd'];
  let seed = 31337;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 30000; i++) {
    let text = '';
    const n = 1 + Math.floor(rnd() * 30);
    for (let j = 0; j < n; j++) text += pieces[Math.floor(rnd() * pieces.length)];
    if (rnd() < 0.05) text = text.repeat(1 + Math.floor(rnd() * 40));
    const once = maskString(text);
    assert.equal(maskString(once), once, 'idempotent: ' + JSON.stringify(text));
    assert.ok(once.length <= LIMITS.maxField);
    assert.equal(/\d{1,3}(?:\.\d{1,3}){3}/.test(once.normalize('NFKC')), false, 'an address is left in ' + JSON.stringify(text));
    if (wellFormed(text)) assert.equal(wellFormed(once), true, 'a half of a surrogate pair is left in ' + JSON.stringify(text));
  }
});

// What both reporters have: safeField. A test of the Worker's masks that did not hold them against the code that writes the batches
// would let the two sides drift apart. Each reporter is loaded when it is in the tree; the Worker may mask more, never less.
async function reporterFields() {
  const found = [];
  for (const rel of ['../../src/loader/obs.js', '../../src/idp/obs-client.js']) {
    try {
      const m = await import(rel);
      if (typeof m.safeField === 'function') found.push([rel, m.safeField]);
    } catch (_) { /* that lane's file is not in this tree, or does not load here */ }
  }
  return found;
}

test('maskString agrees with safeField of the reporters on the ordinary cases and lets nothing through that the reporters would have masked', async (t) => {
  const fields = await reporterFields();
  if (!fields.length) return t.skip('no reporter is in the tree');
  const plain = [
    '192.168.1.5', 'connect to 10.0.0.1 failed', 'at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok', '::1', 'fe80::1',
    'https://x.example/open#secretkey', '/_mw/open#abc', 'abcd-efgh-jkmn', 'code abcd-efgh-jkmn opened', 'ABCD-EFGH-JKMN', 'a'.repeat(300),
    '0.3.0', 'k3f9-2xq1', 'd680ff36', SID, 'tracker.openwebtorrent.com', 'wss://tracker.example:443/announce', 'step #3', '  padded  ', '',
  ];
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // no '#' among the pieces: the Worker cuts after a '#' in more strings than the reporter does, which can remove a mask with it
  const pieces = ['1', '2', '.', ':', '::', 'a', 'f', 'k', '-', '/', ' ', '[', ']', 'http', 'abcd', 'efgh', 'jkmn', '192.168.0.1', 'e3', '9', 'Z', 'ffff', '8080'];
  const made = [];
  for (let i = 0; i < 20000; i++) {
    let s = '';
    const n = 1 + Math.floor(rnd() * 30);
    for (let j = 0; j < n; j++) s += pieces[Math.floor(rnd() * pieces.length)];
    made.push(s);
  }
  for (const [name, safeField] of fields) {
    for (const s of plain) {
      const kept = safeField(s);
      // the reporters differ on a cut fragment (one keeps the '#', one does not); the Worker keeps it
      assert.ok(maskString(s) === kept || maskString(s) === kept + '#', name + ': ' + JSON.stringify(s) + ' -> ' + JSON.stringify(kept) + ' but ' + JSON.stringify(maskString(s)));
    }
    for (const s of made) {
      const kept = safeField(s);
      const worker = maskString(kept);
      assert.equal(/\d{1,3}(?:\.\d{1,3}){3}/.test(worker), false, name + ': an address came through ' + JSON.stringify(s));
      assert.equal(/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/i.test(worker), false, name + ': an IPv6 pattern came through ' + JSON.stringify(s));
    }
    t.diagnostic(name + ': ' + plain.length + ' ordinary cases equal, ' + made.length + ' made-up strings leave no address after the Worker masks the reporter\'s output');
  }
});

// ---------------------------------------------------------------------------------------------- validateBatch

test('validateBatch: the example batch of the wire format is accepted and comes back as a new object built from the checked fields only', () => {
  const input = sample({ extra: 'dropped', more: { a: 1 } });
  const r = validateBatch(input);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.batch), ['v', 'sid', 'seq', 'page', 'build', 'loader', 'site', 'who', 'net', 'ua', 't0', 'events']);
  assert.deepEqual(r.batch, sample());
  assert.notEqual(r.batch, input);
  assert.notEqual(r.batch.events, input.events);
  input.events[0].kind = 'changed afterwards';
  assert.equal(r.batch.events[0].kind, 'consent', 'the stored copy shares nothing with the input');
  assert.deepEqual(r.batch.events[1], { t: 1300, n: 'ui.click', role: 'continue', trusted: true, ms: 12.5, x: null });
});

test('validateBatch: what may be absent (build, loader, site, who, net) comes back as its empty value; net may carry one word or none', () => {
  const r = validateBatch({ v: 1, sid: SID, seq: 0, page: 'idp', ua: { browser: 'other', mobile: false }, t0: 0, events: [{ t: 0, n: 'ready' }] });
  assert.equal(r.ok, true);
  assert.deepEqual([r.batch.build, r.batch.loader, r.batch.site, r.batch.who, r.batch.net], ['', '', '', null, null]);
  assert.deepEqual(validateBatch(sample({ who: null, net: null, site: '', build: '', loader: '' })).batch.net, null);
  assert.deepEqual(validateBatch(sample({ net: { effectiveType: '4g' } })).batch.net, { type: null, effectiveType: '4g' });
  assert.deepEqual(validateBatch(sample({ net: {} })).batch.net, { type: null, effectiveType: null });
  for (const page of ['site', 'door', 'hub', 'idp']) assert.equal(validateBatch(sample({ page })).ok, true, page);
  for (const browser of ['chromium', 'firefox', 'webkit', 'other']) assert.equal(validateBatch(sample({ ua: { browser, mobile: false } })).ok, true, browser);
  assert.equal(validateBatch(sample({ seq: 1000000000 })).ok, true, 'seq up to 1e9');
  assert.equal(validateBatch(sample({ build: 'a'.repeat(16), site: 'f'.repeat(8), loader: '1234.5678.9012-a', who: 'zzzz-9999' })).ok, true, 'the longest allowed');
  assert.equal(validateBatch(sample({ events: [{ t: 0, n: 'a' + 'b'.repeat(48) }] })).ok, true, 'a name of 49 characters');
});

test('validateBatch: every field has its rule, and a refusal is one short word', () => {
  const nameOf = (n) => [{ t: 0, n }];
  const keys = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => ['k' + i, i]));
  const refused = [
    ['null', null, 'shape'], ['an array', [], 'shape'], ['a string', 'x', 'shape'], ['a number', 5, 'shape'],
    ['version 2', sample({ v: 2 }), 'version'], ['version as text', sample({ v: '1' }), 'version'], ['no version', sample({ v: undefined }), 'version'],
    ['sid too short', sample({ sid: 'k3m8k3m8k3m' }), 'sid'], ['sid too long', sample({ sid: SID + 'k' }), 'sid'], ['sid with a 0', sample({ sid: 'k3m8k3m8k3m0' }), 'sid'],
    ['sid with a 1', sample({ sid: 'k3m8k3m8k3m1' }), 'sid'], ['sid in capitals', sample({ sid: SID.toUpperCase() }), 'sid'], ['sid as number', sample({ sid: 123456789012 }), 'sid'],
    ['seq negative', sample({ seq: -1 }), 'seq'], ['seq fractional', sample({ seq: 1.5 }), 'seq'], ['seq past 1e9', sample({ seq: 1000000001 }), 'seq'],
    ['seq as text', sample({ seq: '7' }), 'seq'], ['seq missing', sample({ seq: undefined }), 'seq'],
    ['page unknown', sample({ page: 'app' }), 'page'], ['page missing', sample({ page: undefined }), 'page'], ['page in capitals', sample({ page: 'Door' }), 'page'],
    ['build not hex', sample({ build: 'xyz' }), 'build'], ['build in capitals', sample({ build: 'BBCB' }), 'build'], ['build over 16', sample({ build: 'a'.repeat(17) }), 'build'],
    ['build as number', sample({ build: 5 }), 'build'], ['build null', sample({ build: null }), 'build'],
    ['loader over 16', sample({ loader: '0.3.0-rc.1+abcdefgh' }), 'loader'], ['loader with a space', sample({ loader: '0.3 0' }), 'loader'], ['loader as number', sample({ loader: 3 }), 'loader'],
    ['site not hex', sample({ site: 'D680FF36' }), 'site'], ['site over 16', sample({ site: 'a'.repeat(17) }), 'site'], ['site over 8', sample({ site: 'd680ff36d' }), 'site'],
    ['loader an address', sample({ loader: '203.0.113.5' }), 'loader'], ['loader a word', sample({ loader: 'dev' }), 'loader'], ['loader of 4 numbers', sample({ loader: '0.3.0.1' }), 'loader'],
    ['who in capitals', sample({ who: 'DA9U' }), 'who'], ['who over 24', sample({ who: 'a'.repeat(25) }), 'who'], ['who empty', sample({ who: '' }), 'who'],
    ['who with a space', sample({ who: 'da9u 6qug' }), 'who'], ['who as number', sample({ who: 12 }), 'who'], ['who a name', sample({ who: 'zorblat-zorblat' }), 'who'],
    ['who with a 0', sample({ who: 'abc0-efgh' }), 'who'], ['who of 24 letters', sample({ who: 'a'.repeat(24) }), 'who'],
    ['net as text', sample({ net: 'wifi' }), 'net'], ['net an array', sample({ net: [] }), 'net'], ['net type over 16', sample({ net: { type: 'a'.repeat(17), effectiveType: '4g' } }), 'net'],
    ['net word as number', sample({ net: { type: 5, effectiveType: '4g' } }), 'net'], ['net word with a space', sample({ net: { type: 'a b', effectiveType: '4g' } }), 'net'],
    ['net type not in the list', sample({ net: { type: 'abcdefgh2345', effectiveType: '4g' } }), 'net'], ['net effectiveType not in the list', sample({ net: { type: 'wifi', effectiveType: '198-51-100-7' } }), 'net'],
    ['net word in capitals', sample({ net: { type: 'WIFI', effectiveType: '4g' } }), 'net'],
    ['ua missing', sample({ ua: undefined }), 'ua'], ['ua null', sample({ ua: null }), 'ua'], ['ua browser unknown', sample({ ua: { browser: 'ie', mobile: false } }), 'ua'],
    ['ua mobile as text', sample({ ua: { browser: 'chromium', mobile: 'yes' } }), 'ua'], ['ua without mobile', sample({ ua: { browser: 'chromium' } }), 'ua'],
    ['t0 fractional', sample({ t0: 1.5 }), 't0'], ['t0 negative', sample({ t0: -1 }), 't0'], ['t0 in the year 2100 and after', sample({ t0: 4102444801 }), 't0'], ['t0 missing', sample({ t0: undefined }), 't0'],
    ['no events', sample({ events: undefined }), 'events'], ['events empty', sample({ events: [] }), 'events'], ['events an object', sample({ events: {} }), 'events'],
    ['101 events', sample({ events: Array.from({ length: 101 }, (_, i) => ({ t: i, n: 'a.b' })) }), 'events'],
    ['an event null', sample({ events: [null] }), 'event'], ['an event as text', sample({ events: ['x'] }), 'event'], ['an event an array', sample({ events: [[]] }), 'event'],
    ['time negative', sample({ events: [{ t: -1, n: 'a.b' }] }), 'time'], ['time fractional', sample({ events: [{ t: 1.5, n: 'a.b' }] }), 'time'],
    ['time as text', sample({ events: [{ t: '5', n: 'a.b' }] }), 'time'], ['time missing', sample({ events: [{ n: 'a.b' }] }), 'time'],
    ['name in capitals', sample({ events: nameOf('Gate') }), 'name'], ['name of one character', sample({ events: nameOf('a') }), 'name'],
    ['name of 50 characters', sample({ events: nameOf('a' + 'b'.repeat(49)) }), 'name'], ['name starting with a digit', sample({ events: nameOf('1ab') }), 'name'],
    ['name with a space', sample({ events: nameOf('a b') }), 'name'], ['name with an underscore', sample({ events: nameOf('a_b') }), 'name'],
    ['name missing', sample({ events: [{ t: 0 }] }), 'name'], ['name as number', sample({ events: nameOf(5) }), 'name'],
    ['13 other keys', sample({ events: [Object.assign({ t: 0, n: 'a.b' }, keys(13))] }), 'keys'],
    ['a key starting with a digit', sample({ events: [{ t: 0, n: 'a.b', '1big': 1 }] }), 'key'], ['a key starting with an underscore', sample({ events: [{ t: 0, n: 'a.b', _x: 1 }] }), 'key'],
    ['a key with a dash', sample({ events: [{ t: 0, n: 'a.b', 'a-b': 1 }] }), 'key'],
    ['a key of 33 characters', sample({ events: [{ t: 0, n: 'a.b', ['a' + 'b'.repeat(32)]: 1 }] }), 'key'], ['a key with a dot', sample({ events: [{ t: 0, n: 'a.b', 'a.b': 1 }] }), 'key'],
    ['a value that is an object', sample({ events: [{ t: 0, n: 'a.b', x: {} }] }), 'value'], ['a value that is an array', sample({ events: [{ t: 0, n: 'a.b', x: [] }] }), 'value'],
    ['a value that is undefined', sample({ events: [{ t: 0, n: 'a.b', x: undefined }] }), 'value'], ['a value that is a function', sample({ events: [{ t: 0, n: 'a.b', x: () => 1 }] }), 'value'],
    ['a value that is Infinity', sample({ events: [{ t: 0, n: 'a.b', x: Infinity }] }), 'value'], ['a value that is NaN', sample({ events: [{ t: 0, n: 'a.b', x: NaN }] }), 'value'],
    ['a value that is a bigint', sample({ events: [{ t: 0, n: 'a.b', x: 5n }] }), 'value'],
  ];
  for (const [what, input, reason] of refused) {
    const r = validateBatch(input);
    assert.deepEqual([what, r.ok, r.reason], [what, false, reason]);
  }
  assert.equal(validateBatch(sample({ events: [Object.assign({ t: 0, n: 'a.b' }, keys(12))] })).ok, true, '12 other keys are allowed (t and n do not count)');
  assert.equal(validateBatch(sample({ events: [{ t: 0, n: 'a.b', Big: 1, t0ms: 5, hasSw: true, cspKind: 'x', ['a' + 'b'.repeat(31)]: 1 }] })).ok, true, 'a field name is a letter and up to 31 letters, digits or underscores, as the reporters make them');
  assert.equal(validateBatch(sample({ events: Array.from({ length: 100 }, (_, i) => ({ t: i, n: 'a.b' })) })).ok, true, '100 events');
});

test('validateBatch: string values are masked again and cut to 200; numbers, booleans and null pass; a key the format does not name is not kept', () => {
  const long = 'x'.repeat(5000);
  const r = validateBatch(sample({ events: [{
    t: 5, n: 'log', m: 'failed for 10.1.2.3:4567 and [2001:db8::1]:443', url: 'https://x.example/open#secret', code: 'abcd-efgh-jkmn', infohash: 'ab12'.repeat(10), long, n1: 3, f: 0.25, yes: true, no: false, none: null,
  }] }));
  assert.equal(r.ok, true);
  const e = r.batch.events[0];
  assert.equal(e.m, 'failed for ' + MASK + ' and ' + MASK);
  assert.equal(e.url, 'https://x.example/open#');
  assert.equal(e.code, 'abcd');
  assert.equal(e.infohash, 'ab12ab12');
  assert.equal(e.long.length, LIMITS.maxField);
  assert.deepEqual([e.n1, e.f, e.yes, e.no, e.none], [3, 0.25, true, false, null]);
  assert.equal(JSON.stringify(r.batch).includes('10.1.2.3'), false);
  const text = '{"v":1,"sid":"' + SID + '","seq":1,"page":"door","ua":{"browser":"other","mobile":false},"t0":1,"__proto__":{"polluted":true},"events":[{"t":1,"n":"a.b","__proto__":1}]}';
  assert.equal(parseBatchText(text).reason, 'key', 'a field named __proto__ is refused');
  const top = parseBatchText(text.replace(',"__proto__":1', ''));
  assert.equal(top.ok, true);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.keys(top.batch).includes('__proto__'), false, 'a top level key of the format is the only thing kept');
});

test('parseBatchText: empty, not JSON, a number too large for JSON, and a deep nest all come back as a word, never a throw', () => {
  assert.equal(parseBatchText('').reason, 'empty');
  assert.equal(parseBatchText(undefined).reason, 'empty');
  assert.equal(parseBatchText('{nope').reason, 'json');
  assert.equal(parseBatchText('[[[[').reason, 'json');
  assert.equal(parseBatchText('null').reason, 'shape');
  assert.equal(parseBatchText('"x"').reason, 'shape');
  assert.equal(parseBatchText('[' .repeat(16000) + ']'.repeat(16000)).reason, 'shape', 'a nest of 16000 arrays is an array, not a batch');
  const nested = '{"v":1,"sid":"' + SID + '","seq":1,"page":"door","ua":{"browser":"other","mobile":false},"t0":1,"events":[{"t":1,"n":"a.b","x":' + '['.repeat(5000) + ']'.repeat(5000) + '}]}';
  assert.equal(parseBatchText(nested).reason, 'value');
  const huge = '{"v":1,"sid":"' + SID + '","seq":1,"page":"door","ua":{"browser":"other","mobile":false},"t0":1,"events":[{"t":1,"n":"a.b","x":1e999}]}';
  assert.equal(JSON.parse(huge).events[0].x, Infinity, 'JSON.parse itself reads 1e999 as Infinity');
  assert.equal(parseBatchText(huge).reason, 'value');
  assert.equal(parseBatchText(JSON.stringify(sample())).ok, true);
});

test('utf8Length: the bytes of a string as UTF-8, the way a body is measured', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('caf\u00e9'), 5);
  assert.equal(utf8Length('\u20ac'), 3);
  assert.equal(utf8Length('\ud83d\ude00'), 4);
  assert.equal(utf8Length('\ud83d'), 3, 'a lone surrogate is encoded as the 3 bytes of the replacement character');
  for (const s of ['', 'a'.repeat(100), 'x\u00e9\u20ac\ud83d\ude00y', '\ude00\ud83d']) assert.equal(utf8Length(s), new TextEncoder().encode(s).length, JSON.stringify(s));
});

test('ingest never throws, whatever the body, and a stored body is a fixed point of validateBatch (5000 made-up mutations of a good batch)', async () => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const junk = (depth) => {
    switch (Math.floor(rnd() * 11)) {
      case 0: return null;
      case 1: return rnd() < 0.5;
      case 2: return Math.floor(rnd() * 2000000) - 1000000;
      case 3: return rnd() * 100;
      case 4: return 'x'.repeat(Math.floor(rnd() * 300));
      case 5: return depth < 4 ? Array.from({ length: Math.floor(rnd() * 4) }, () => junk(depth + 1)) : 1;
      case 6: return depth < 4 ? Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => ['k' + i, junk(depth + 1)])) : 'y';
      case 7: return 'peer 192.168.0.' + Math.floor(rnd() * 255) + ':' + Math.floor(rnd() * 65535) + ' via abcd-efgh-jkmn #frag';
      case 8: return pick(['chromium', 'door', 'ui.click', 'da9u-6qug', '4g', '', 'b'.repeat(40)]);
      case 9: return Number.MAX_SAFE_INTEGER;
      default: return undefined;
    }
  };
  const { storage, clock, log } = makeLog({ maxBatchesPerDay: 1e9, limits: { perSidPerMinute: 1e9, perSidPerDay: 1e9 } });
  const topKeys = Object.keys(sample());
  let stored = 0;
  for (let i = 0; i < 5000; i++) {
    clock.now += 1000;
    const batch = JSON.parse(JSON.stringify(sample({ seq: i })));
    const how = Math.floor(rnd() * 4);
    if (how === 0) batch[pick(topKeys)] = junk(0);
    else if (how === 1) batch.events[Math.floor(rnd() * batch.events.length)][pick(['t', 'n', 'kind', 'host', 'role', 'ms', 'x', 'extra'])] = junk(0);
    else if (how === 2) { batch.ua = junk(0); if (rnd() < 0.5) batch.net = junk(0); }
    else batch.events = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ t: Math.floor(rnd() * 100), n: pick(['a.b', 'ui.click', 'Bad', 'x']), [pick(['m', 'text', 'k'])]: junk(0) }));
    const text = JSON.stringify(batch);
    const r = await log.ingest(text);
    assert.ok([204, 400, 413, 429].includes(r.status), 'status ' + r.status + ' for ' + text.slice(0, 80));
    if (r.ok) {
      stored++;
      const again = validateBatch(JSON.parse(JSON.stringify(r.row.body)));
      assert.deepEqual(again, { ok: true, batch: r.row.body }, 'what was stored validates to itself: ' + text.slice(0, 80));
      assert.equal(/\d{1,3}(?:\.\d{1,3}){3}/.test(JSON.stringify(r.row)), false, 'an address was stored');
    }
  }
  assert.ok(stored > 500 && stored < 4500, 'the mutations produce both kinds: ' + stored + ' stored');
  assert.equal(storage.rows.size - 1 >= stored - 1, true);
  assert.equal(log.rowCount(), stored);
});

// ---------------------------------------------------------------------------------------------- keys and queries

test('batchKey: zero-padded milliseconds and a 4 digit counter, so the keys sort in time order', () => {
  assert.equal(batchKey(1793600000123, 7), 'b:001793600000123:0007');
  assert.equal(batchKey(0), 'b:000000000000000:0000');
  assert.equal(batchKey(T0, 12345 % 10000), 'b:' + String(T0).padStart(15, '0') + ':2345');
  assert.deepEqual(parseBatchKey('b:001793600000123:0007'), { ms: 1793600000123, n: 7 });
  for (const bogus of ['', 'b:1:1', 'c:001793600000123:0007', 'b:001793600000123:00071', 'b:001793600000123-0007', null, 7]) assert.equal(parseBatchKey(bogus), null, String(bogus));
  assert.ok(batchKey(T0, 9) < batchKey(T0, 10), 'the counter sorts as a number');
  assert.ok(batchKey(T0, 9999) < batchKey(T0 + 1, 0));
  assert.ok(batchKey(999999999999, 0) < batchKey(1000000000000, 0), 'a time that gains a digit still sorts after');
  const times = [T0 + 5, T0, T0 + 3, T0 + 3, T0 - 1];
  const sorted = times.map((ms, i) => batchKey(ms, i)).sort();
  assert.deepEqual(sorted.map((k) => parseBatchKey(k).ms), times.slice().sort((a, b) => a - b));
  assert.ok(batchKey(T0).startsWith(KEY_PREFIX));
  assert.notEqual(META_KEY.startsWith(KEY_PREFIX), true, 'the counter row is outside the range of the batch rows');
  assert.equal(batchKey(-5, -3), 'b:000000000000000:0000', 'nothing negative');
});

test('parseEventsQuery and parseSummaryQuery: the limits, the defaults, and a word for a bad filter', () => {
  const q = (s) => parseEventsQuery(new URLSearchParams(s));
  assert.deepEqual(q('').query, { since: null, sid: null, who: null, limit: 200 });
  assert.deepEqual(q('since=' + batchKey(T0, 1) + '&sid=' + SID + '&who=da9u-6qug&limit=5').query, { since: batchKey(T0, 1), sid: SID, who: 'da9u-6qug', limit: 5 });
  assert.equal(q('limit=5000').query.limit, 1000, 'at most 1000');
  assert.equal(q('limit=0').query.limit, 1);
  assert.equal(q('limit=abc').query.limit, 200);
  assert.equal(q('limit=-4').query.limit, 200);
  assert.equal(q('limit=').query.limit, 200);
  assert.equal(q('since=').query.since, null, 'an empty filter is no filter');
  assert.equal(q('since=nope').reason, 'since');
  assert.equal(q('since=b:1:1').reason, 'since');
  assert.equal(q('sid=ABC').reason, 'sid');
  assert.equal(q('sid=k3m8k3m8k3m0').reason, 'sid');
  assert.equal(q('who=A B').reason, 'who');
  assert.equal(q('who=' + 'a'.repeat(25)).reason, 'who');
  const s = (x) => parseSummaryQuery(new URLSearchParams(x)).query.hours;
  assert.deepEqual([s(''), s('hours=6'), s('hours=0'), s('hours=168'), s('hours=169'), s('hours=9999'), s('hours=x'), s('hours=-1')], [24, 6, 1, 168, 168, 168, 24, 24]);
});

// ---------------------------------------------------------------------------------------------- the rate limiter

test('createLimiter: 60 batches in a sliding minute and 1000 in a day for a session; the minute slides, the day is a UTC day', () => {
  const L = createLimiter();
  for (let i = 0; i < 60; i++) assert.deepEqual(L.take(SID, T0 + i * 100), { ok: true }, 'batch ' + i);
  const over = L.take(SID, T0 + 6000);
  assert.deepEqual([over.ok, over.why, over.retryAfter], [false, 'sid-minute', 54], 'the 61st in the minute; the first one leaves the window in 54 s');
  assert.deepEqual(L.take(sidOf(1), T0 + 6000), { ok: true }, 'another session is not held back');
  assert.equal(L.take(SID, T0 + 59999).ok, false, 'the first batch has not left the window yet');
  assert.deepEqual(L.take(SID, T0 + 60000), { ok: true }, 'it leaves after 60 s');
  const again = L.take(SID, T0 + 60001);
  assert.deepEqual([again.ok, again.why, again.retryAfter], [false, 'sid-minute', 1]);
  // a day: one batch a second passes the minute window; the 1001st of the day is refused until midnight UTC
  const D = createLimiter();
  for (let i = 0; i < 1000; i++) assert.deepEqual(D.take(SID, T0 + i * 1000), { ok: true }, 'batch ' + i);
  const full = D.take(SID, T0 + 1000 * 1000);
  assert.deepEqual([full.ok, full.why], [false, 'sid-day']);
  assert.equal(full.retryAfter, Math.ceil((Date.UTC(2026, 10, 3) - (T0 + 1000 * 1000)) / 1000), 'until the next UTC midnight');
  assert.deepEqual(D.take(sidOf(2), T0 + 1000 * 1000), { ok: true }, 'another session is not');
  assert.deepEqual(D.take(SID, Date.UTC(2026, 10, 3)), { ok: true }, 'the new day starts at 00:00 UTC');
  assert.equal(D.count(Date.UTC(2026, 10, 3)), 1);
});

test('createLimiter: all sessions together are held to maxBatchesPerDay, and the caps are read at each call', () => {
  const cfg = { maxBatchesPerDay: 5 };
  const L = createLimiter(cfg);
  for (let i = 0; i < 5; i++) assert.equal(L.take(sidOf(i), T0).ok, true);
  const refused = L.take(sidOf(99), T0);
  assert.deepEqual([refused.ok, refused.why, refused.retryAfter], [false, 'day-all', 12 * 3600]);
  assert.equal(L.take(sidOf(0), T0).why, 'day-all', 'a session that has had few is refused too');
  assert.equal(L.count(T0), 5, 'a refusal is not counted');
  cfg.maxBatchesPerDay = 6;
  assert.equal(L.take(sidOf(99), T0).ok, true, 'raising the cap takes effect at once');
  assert.equal(L.take(sidOf(100), T0 + DAY).ok, true, 'a new day');
  assert.equal(L.count(T0 + DAY), 1);
  const small = createLimiter({ perSidPerMinute: 2 });
  assert.deepEqual([small.take(SID, T0).ok, small.take(SID, T0).ok, small.take(SID, T0).ok], [true, true, false]);
  const none = createLimiter({ perSidPerMinute: 0 });
  assert.deepEqual(none.take(SID, T0), { ok: false, why: 'sid-minute', retryAfter: 60 }, 'a cap of none still answers with a time');
});

test('createLimiter: snapshot and restore move the count of the day, never down and never across a day', () => {
  const day = Math.floor(T0 / DAY);
  const a = createLimiter();
  a.take(SID, T0);
  a.take(SID, T0 + 1);
  assert.deepEqual(a.snapshot(T0 + 2), { d: day, n: 2 });
  const b = createLimiter();
  b.restore({ d: day, n: 2 }, T0 + 5);
  assert.equal(b.count(T0 + 5), 2);
  b.restore({ d: day - 1, n: 99 }, T0 + 5);
  b.restore({ d: day, n: 1 }, T0 + 5);
  b.restore({ d: day, n: -3 }, T0 + 5);
  b.restore({ d: day, n: 1.5 }, T0 + 5);
  b.restore(null, T0 + 5);
  b.restore('x', T0 + 5);
  assert.equal(b.count(T0 + 5), 2, 'another day, a smaller count, a bad one: all ignored');
  b.restore({ d: day, n: 9 }, T0 + 5);
  assert.equal(b.count(T0 + 5), 9);
  assert.equal(b.count(T0 + DAY), 0, 'the next day starts again');
});

// ---------------------------------------------------------------------------------------------- the storage adapter

test('createMemoryStorage: the list options of the platform storage, copies in and out, delete of one key or many', async () => {
  const s = createMemoryStorage();
  for (const k of ['a:1', 'b:1', 'b:2', 'b:3', 'b:4', 'c:1']) await s.put(k, { k });
  const keys = async (o) => Array.from((await s.list(o)).keys());
  assert.deepEqual(await keys({}), ['a:1', 'b:1', 'b:2', 'b:3', 'b:4', 'c:1']);
  assert.deepEqual(await keys({ prefix: 'b:' }), ['b:1', 'b:2', 'b:3', 'b:4']);
  assert.deepEqual(await keys({ prefix: 'b:', start: 'b:2' }), ['b:2', 'b:3', 'b:4'], 'start is inclusive');
  assert.deepEqual(await keys({ prefix: 'b:', startAfter: 'b:2' }), ['b:3', 'b:4'], 'startAfter is not');
  assert.deepEqual(await keys({ prefix: 'b:', end: 'b:3' }), ['b:1', 'b:2'], 'end is exclusive');
  assert.deepEqual(await keys({ prefix: 'b:', start: 'b:2', end: 'b:4', reverse: true }), ['b:3', 'b:2']);
  assert.deepEqual(await keys({ prefix: 'b:', limit: 2 }), ['b:1', 'b:2']);
  assert.deepEqual(await keys({ prefix: 'b:', reverse: true, limit: 1 }), ['b:4']);
  assert.deepEqual(await keys({ prefix: 'zz' }), []);
  const v = { n: 1 };
  await s.put('d', v);
  v.n = 2;
  const got = await s.get('d');
  assert.equal(got.n, 1, 'a value is copied in');
  got.n = 3;
  assert.equal((await s.get('d')).n, 1, 'and out');
  assert.equal((await s.list({ prefix: 'd' })).get('d').n, 1);
  assert.equal(await s.get('nope'), undefined);
  assert.equal(await s.delete('d'), true);
  assert.equal(await s.delete('d'), false);
  assert.equal(await s.delete(['a:1', 'zz', 'c:1']), 2);
  assert.deepEqual(await keys({}), ['b:1', 'b:2', 'b:3', 'b:4']);
});

// ---------------------------------------------------------------------------------------------- the log

function makeLog(options = {}, storage = createMemoryStorage()) {
  const clock = { now: T0 };
  const log = createObsLog(storage, Object.assign({ now: () => clock.now }, options));
  return { storage, clock, log };
}
const post = (log, batch) => log.ingest(typeof batch === 'string' ? batch : JSON.stringify(batch));
const batchOf = (i, extra = {}) => sample(Object.assign({ sid: sidOf(i), seq: i }, extra));

test('ingest: one row per batch under its key, { at, sid, page, who, site, build, n, body }; the counter tells batches of one millisecond apart', async () => {
  const { storage, clock, log } = makeLog();
  const r = await post(log, sample());
  assert.deepEqual([r.ok, r.status, r.key], [true, 204, batchKey(T0, 0)]);
  const row = storage.rows.get(r.key);
  assert.deepEqual(Object.keys(row), ['at', 'sid', 'page', 'who', 'site', 'build', 'n', 'body']);
  assert.deepEqual(row, { at: T0, sid: SID, page: 'door', who: 'da9u-6qug', site: 'd680ff36', build: 'bbcb82098cda', n: 2, body: sample() });
  assert.deepEqual(r.row, row);
  assert.equal((await post(log, sample({ seq: 8 }))).key, batchKey(T0, 1));
  assert.equal((await post(log, sample({ seq: 9 }))).key, batchKey(T0, 2));
  clock.now = T0 + 1;
  assert.equal((await post(log, sample({ seq: 10 }))).key, batchKey(T0 + 1, 0));
  clock.now = T0 - 5000;
  const back = await post(log, sample({ seq: 11 }));
  assert.equal(back.key, batchKey(T0 + 1, 1), 'a clock that steps back never reuses or precedes a key');
  assert.equal(back.row.at, T0 - 5000, 'the row says when the batch really came');
  assert.deepEqual(Array.from(storage.rows.keys()).filter((k) => k.startsWith(KEY_PREFIX)).sort(), Array.from(storage.rows.keys()).filter((k) => k.startsWith(KEY_PREFIX)), 'the keys are in time order');
  assert.equal(log.rowCount(), 5);
});

test('ingest: more than 9999 batches in one millisecond move the key on by one millisecond, never to a fifth digit', async () => {
  const { storage, log } = makeLog();
  let last = null;
  for (let i = 0; i < 10001; i++) {
    const r = await post(log, batchOf(i));
    assert.equal(r.ok, true, 'batch ' + i);
    last = r.key;
  }
  assert.equal(last, batchKey(T0 + 1, 0));
  assert.ok(storage.rows.has(batchKey(T0, 9999)));
  assert.equal(Array.from(storage.rows.keys()).filter((k) => /^b:\d{15}:\d{4}$/.test(k)).length, 10001);
});

test('ingest: a body over 32768 bytes is 413, the limit is bytes and not characters, and a bad batch is 400 with the word of validateBatch; nothing is stored', async () => {
  const { storage, log } = makeLog();
  const base = JSON.stringify(sample());
  const exact = base + ' '.repeat(LIMITS.maxBodyBytes - utf8Length(base));
  assert.equal(utf8Length(exact), 32768);
  assert.equal((await post(log, exact)).status, 204, '32768 bytes are fine');
  const before = storage.rows.size;
  const over = await post(log, exact + ' ');
  assert.deepEqual([over.ok, over.status, over.reason], [false, 413, 'too large']);
  const wide = JSON.stringify(sample({ events: [{ t: 0, n: 'a.b', m: '\u00e9'.repeat(16400) }] }));
  assert.ok(wide.length < 32768 && utf8Length(wide) > 32768, 'fewer than 32768 characters, more than 32768 bytes');
  assert.equal((await post(log, wide)).status, 413);
  const cases = [['', 'empty'], ['{', 'json'], ['null', 'shape'], [JSON.stringify(sample({ v: 2 })), 'version'], [JSON.stringify(sample({ sid: 'x' })), 'sid'], [JSON.stringify(sample({ events: [] })), 'events']];
  for (const [body, reason] of cases) {
    const r = await post(log, body);
    assert.deepEqual([body.slice(0, 20), r.ok, r.status, r.reason], [body.slice(0, 20), false, 400, reason]);
  }
  assert.equal((await log.ingest(undefined)).reason, 'empty');
  assert.equal(storage.rows.size, before, 'a refused batch leaves no row');
  assert.equal(log.rowCount(), 1);
});

test('ingest: the 61st batch of a session in a minute is 429 with a retry time, the day caps follow, and a refused batch is not stored or counted', async () => {
  const { storage, clock, log } = makeLog({ maxBatchesPerDay: 100 });
  for (let i = 0; i < 60; i++) assert.equal((await post(log, sample({ seq: i }))).ok, true);
  const r = await post(log, sample({ seq: 60 }));
  assert.deepEqual([r.ok, r.status, r.reason, r.retryAfter], [false, 429, 'sid-minute', 60]);
  assert.equal(log.rowCount(), 60);
  assert.equal(log.todayCount(), 60);
  assert.equal((await post(log, batchOf(1))).ok, true, 'another session');
  clock.now = T0 + 61000;
  assert.equal((await post(log, sample({ seq: 61 }))).ok, true, 'a minute later');
  const small = makeLog({ maxBatchesPerDay: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await post(small.log, batchOf(i))).ok, true);
  const refused = await post(small.log, batchOf(50));
  assert.deepEqual([refused.status, refused.reason, refused.retryAfter], [429, 'day-all', 12 * 3600]);
  assert.equal(small.storage.rows.size > 0, true);
  assert.equal(Array.from(small.storage.rows.keys()).filter((k) => k.startsWith(KEY_PREFIX)).length, 3);
  small.clock.now = T0 + DAY;
  assert.equal((await post(small.log, batchOf(50))).ok, true, 'the next UTC day');
  assert.equal(storage.rows.has(META_KEY), true);
});

test('ingest: the counter row is written with the first batch of a day and every 20th, not with each one; load() reads it back to within 19 batches', async () => {
  const inner = createMemoryStorage();
  const puts = [];
  const storage = { rows: inner.rows, get: (k) => inner.get(k), put: (k, v) => { puts.push([k, v]); return inner.put(k, v); }, delete: (k) => inner.delete(k), list: (o) => inner.list(o) };
  const { clock, log } = makeLog({}, storage);
  for (let i = 0; i < 45; i++) await post(log, batchOf(i));
  assert.equal(puts.filter(([k]) => k.startsWith(KEY_PREFIX)).length, 45, 'one row per batch');
  assert.deepEqual(puts.filter(([k]) => k === META_KEY).map(([, v]) => v), [{ d: Math.floor(T0 / DAY), n: 1, r: 1 }, { d: Math.floor(T0 / DAY), n: 20, r: 20 }, { d: Math.floor(T0 / DAY), n: 40, r: 40 }]);
  const woken = makeLog({}, inner);
  assert.deepEqual(await woken.log.load(), { rows: 40, today: 40 });
  assert.equal(woken.log.todayCount(), 40, 'five batches short, as the counter row was last written at 40');
  woken.clock.now = T0 + 2 * DAY;
  assert.equal(woken.log.todayCount(), 0, 'a new day starts at nothing');
  const next = makeLog({}, inner);
  next.clock.now = T0 + 2 * DAY;
  assert.deepEqual(await next.log.load(), { rows: 40, today: 0 }, 'yesterday count does not carry over; the rows still count');
  const fresh = makeLog();
  assert.deepEqual(await fresh.log.load(), { rows: 0, today: 0 });
  assert.equal(clock.now, T0);
});

test('events: rows in key order after since, filtered by sid and who, at most limit of them; next is the last key read and more says a cap stopped the read', async () => {
  const { clock, log } = makeLog();
  const A = sidOf(1);
  const B = sidOf(2);
  const keys = [];
  for (let i = 0; i < 8; i++) {
    clock.now = T0 + i * 10;
    keys.push((await post(log, sample({ sid: i % 2 ? B : A, who: i % 3 === 0 ? 'da9u-6qug' : null, seq: i }))).key);
  }
  const q = (over = {}) => Object.assign({ since: null, sid: null, who: null, limit: 200 }, over);
  const all = await log.events(q());
  assert.equal(all.batches.length, 8);
  assert.deepEqual(all.batches.map((r) => r.at), keys.map((k) => parseBatchKey(k).ms), 'in time order');
  assert.deepEqual([all.next, all.more], [keys[7], false]);
  // pages of 3: the three calls cover the eight rows once each, and the fourth call finds nothing new
  const seen = [];
  let since = null;
  for (let page = 0; page < 3; page++) {
    const r = await log.events(q({ since, limit: 3 }));
    seen.push(...r.batches.map((b) => b.body.seq));
    assert.equal(r.next, keys[Math.min(7, page * 3 + 2)], 'page ' + page);
    assert.equal(r.more, page < 2 || r.batches.length === 3, 'page ' + page);
    since = r.next;
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
  const end = await log.events(q({ since }));
  assert.deepEqual([end.batches, end.next, end.more], [[], keys[7], false], 'nothing after the last key: next stays where it was');
  const fresh = await log.events(q({ since: batchKey(T0 + 35, 0) }));
  assert.deepEqual(fresh.batches.map((b) => b.body.seq), [4, 5, 6, 7], 'since is a key, and the rows after it');
  assert.deepEqual((await log.events(q({ since: keys[3] }))).batches.map((b) => b.body.seq), [4, 5, 6, 7], 'since itself is not returned');
  assert.deepEqual((await log.events(q({ sid: A }))).batches.map((b) => b.body.seq), [0, 2, 4, 6]);
  assert.deepEqual((await log.events(q({ who: 'da9u-6qug' }))).batches.map((b) => b.body.seq), [0, 3, 6]);
  assert.deepEqual((await log.events(q({ sid: A, who: 'da9u-6qug' }))).batches.map((b) => b.body.seq), [0, 6], 'both filters must match');
  assert.deepEqual((await log.events(q({ sid: sidOf(77) }))).batches, []);
  assert.deepEqual((await log.events(q({ since: batchKey(1, 0) }))).batches.length, 8, 'a since before everything');
  // a read stops after eventsScanRows rows, matches or not; the next call goes on from next
  log.limits.eventsScanRows = 3;
  const first = await log.events(q({ who: 'da9u-6qug', limit: 10 }));
  assert.deepEqual([first.batches.map((b) => b.body.seq), first.next, first.more], [[0], keys[2], true], 'read 3 rows, 1 matched');
  const second = await log.events(q({ who: 'da9u-6qug', limit: 10, since: first.next }));
  assert.deepEqual([second.batches.map((b) => b.body.seq), second.next, second.more], [[3], keys[5], true]);
  const third = await log.events(q({ who: 'da9u-6qug', limit: 10, since: second.next }));
  assert.deepEqual([third.batches.map((b) => b.body.seq), third.next, third.more], [[6], keys[7], false], 'the end of the rows');
});

test('events: it reads the rows a page at a time, a limit that is not a multiple of the page size is kept, and a stored value that is not a row is skipped', async () => {
  const { storage, clock, log } = makeLog({ maxBatchesPerDay: 100000 });
  for (let i = 0; i < 300; i++) {
    clock.now = T0 + i;
    await post(log, batchOf(i));
  }
  await storage.put(batchKey(T0 + 150, 5), 'not a row');
  const r = await log.events({ since: null, sid: null, who: null, limit: 1000 });
  assert.equal(r.batches.length, 300, 'the 300 batches; what is not a row is not one of them');
  assert.equal(r.next, batchKey(T0 + 299, 0));
  assert.equal(r.more, false);
  const filtered = await log.events({ since: null, sid: sidOf(150), who: null, limit: 1000 });
  assert.deepEqual(filtered.batches.map((b) => b.body.seq), [150]);
  const some = await log.events({ since: null, sid: null, who: null, limit: 130 });
  assert.equal(some.batches.length, 130, 'a limit that is not a multiple of the page size');
  assert.equal(some.more, true);
});

test('summary: counts over the last N hours: batches, events, per name, per page, distinct sessions and identities; the newest rows when it has to stop', async () => {
  const { clock, log } = makeLog({ maxBatchesPerDay: 100000 });
  const put = async (hoursAgo, i, page, who, names) => {
    clock.now = T0 + 100 * 3600000 - hoursAgo * 3600000;
    await post(log, sample({ sid: sidOf(i), seq: i, page, who, events: names.map((n, k) => ({ t: k, n })) }));
  };
  await put(40, 1, 'site', null, ['boot.start', 'ui.click']);
  await put(30, 2, 'door', 'da9u-6qug', ['ui.click']);
  await put(5, 3, 'door', 'da9u-6qug', ['ui.click', 'log', 'log']);
  await put(2, 3, 'door', 'da9u-6qug', ['log']);
  await put(1, 4, 'idp', null, ['ready', 'ui.click']);
  clock.now = T0 + 100 * 3600000;
  const day = await log.summary({ hours: 24 });
  assert.deepEqual(day, {
    hours: 24, from: clock.now - 24 * 3600000, to: clock.now, truncated: false, batches: 3, events: 6, sids: 2, who: 1,
    pages: { door: 2, idp: 1 }, names: { log: 3, 'ui.click': 2, ready: 1 },
  });
  assert.deepEqual(Object.keys(day.names), ['log', 'ui.click', 'ready'], 'by count, then by name');
  const two = await log.summary({ hours: 48 });
  assert.deepEqual([two.batches, two.events, two.sids, two.who, two.pages, two.names], [5, 9, 4, 1, { door: 3, idp: 1, site: 1 }, { 'ui.click': 4, log: 3, 'boot.start': 1, ready: 1 }]);
  const hour = await log.summary({ hours: 1 });
  assert.deepEqual([hour.batches, hour.events], [1, 2], 'the hour is counted back from now: the batch of 1 hour ago is on the line');
  // a window over more rows than it may read: the newest ones are counted and the window says where it begins
  log.limits.summaryScanRows = 2;
  const cut = await log.summary({ hours: 168 });
  assert.deepEqual([cut.truncated, cut.batches, cut.events, cut.sids, cut.pages], [true, 2, 3, 2, { door: 1, idp: 1 }]);
  assert.equal(cut.from, T0 + 100 * 3600000 - 2 * 3600000, 'from the oldest row it counted');
  log.limits.summaryScanRows = 3;
  assert.equal((await log.summary({ hours: 168 })).batches, 3);
  log.limits.summaryScanRows = 5;
  assert.equal((await log.summary({ hours: 168 })).truncated, false, 'exactly as many rows as it may read is not a truncation');
  // more distinct event names than it counts one by one: the rest are counted together
  log.limits.summaryScanRows = 5000;
  log.limits.summaryNames = 2;
  const few = await log.summary({ hours: 168 });
  assert.deepEqual(few.names, { 'ui.click': 4, ready: 1, '*other': 4 }, 'the first names it meets, newest rows first, then the rest together');
  const empty = await makeLog().log.summary({ hours: 24 });
  assert.deepEqual([empty.batches, empty.events, empty.sids, empty.who, empty.pages, empty.names, empty.truncated], [0, 0, 0, 0, {}, {}, false]);
});

test('createSummary and summarizeRows: the counts of rows in any order; what is not a row is skipped; names past the cap are counted together', () => {
  const row = (sid, who, page, names, extra = {}) => Object.assign({ at: T0, sid, page, who, n: names.length, body: { events: names.map((n, i) => ({ t: i, n })) } }, extra);
  const rows = [
    row('a', 'da9u-6qug', 'door', ['ui.click', 'log', 'log']), row('b', null, 'site', ['ui.click']), row('a', 'da9u-6qug', 'door', ['boot.start']),
    null, 'not a row', 7, row('c', 'k3f9-2xq1', 'idp', []), { at: T0, sid: 'd', page: 'hub', body: { events: [{ n: 'ui.click' }, { x: 1 }, null] } },
  ];
  assert.deepEqual(summarizeRows(rows), {
    batches: 5, events: 8, sids: 4, who: 2, pages: { door: 2, hub: 1, idp: 1, site: 1 }, names: { 'ui.click': 3, log: 2, 'boot.start': 1 },
  });
  assert.deepEqual(summarizeRows(rows.slice().reverse()), summarizeRows(rows), 'the order of the rows does not matter');
  assert.deepEqual(summarizeRows([]), { batches: 0, events: 0, sids: 0, who: 0, pages: {}, names: {} });
  assert.deepEqual(summarizeRows(rows, { maxNames: 1 }).names, { 'ui.click': 3, '*other': 3 });
  assert.deepEqual(Object.keys(summarizeRows(rows, { maxNames: 2 }).names), ['ui.click', 'log', '*other']);
  const sum = createSummary();
  assert.deepEqual([sum.add(rows[0]), sum.add(null), sum.add('x')], [true, false, false]);
  assert.equal(sum.result().batches, 1);
  assert.equal(sum.result().batches, 1, 'result() does not consume the counts');
});

test('summary: an event named constructor or toString is a name like any other', async () => {
  const { log } = makeLog();
  await post(log, sample({ events: [{ t: 0, n: 'constructor' }, { t: 1, n: 'to.string' }, { t: 2, n: 'constructor' }] }));
  const s = await log.summary({ hours: 1 });
  assert.deepEqual(s.names, { constructor: 2, 'to.string': 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(s.names, 'constructor'), true);
});

test('sweep: rows older than the retention are deleted (a row exactly that old stays), the counter row and foreign keys are left, and an empty store resets the count', async () => {
  const { storage, clock, log } = makeLog();
  const at = (ms, i) => { clock.now = ms; return post(log, batchOf(i)); };
  const old = await at(T0 - 7 * DAY - 1, 1);
  const edge = await at(T0 - 7 * DAY, 2);
  const recent = await at(T0 - DAY, 3);
  await storage.put('zz:foreign', 'x');
  clock.now = T0;
  assert.equal(log.rowCount(), 3);
  assert.deepEqual(await log.sweep(), { deleted: 1, more: false, rows: 2 });
  assert.equal(storage.rows.has(old.key), false);
  assert.equal(storage.rows.has(edge.key), true);
  assert.equal(storage.rows.has(recent.key), true);
  assert.equal(storage.rows.has('zz:foreign'), true);
  assert.deepEqual(storage.rows.get(META_KEY), { d: Math.floor(T0 / DAY), n: 0, r: 2 }, 'the counter row follows the sweep: rows held, and the count of this day (the three batches were of other days)');
  assert.deepEqual(await log.sweep(), { deleted: 0, more: false, rows: 2 });
  clock.now = T0 + 7 * DAY;
  assert.deepEqual(await log.sweep(), { deleted: 2, more: false, rows: 0 }, 'seven days on, both are older than the retention');
  assert.deepEqual(Array.from(storage.rows.keys()).sort(), [META_KEY, 'zz:foreign']);
  // a shorter retention from the Worker's var
  const short = makeLog({ retentionDays: 1 });
  short.clock.now = T0 - 2 * DAY;
  await post(short.log, batchOf(1));
  short.clock.now = T0 - 12 * 3600000;
  await post(short.log, batchOf(2));
  short.clock.now = T0;
  assert.equal((await short.log.sweep()).deleted, 1);
});

test('sweep: at most maxRows rows are kept, the oldest go first; a long backlog is taken in rounds and says more until it is done', async () => {
  const capped = makeLog();
  capped.log.limits.maxRows = 3;
  const keys = [];
  for (let i = 0; i < 8; i++) {
    capped.clock.now = T0 + i;
    keys.push((await post(capped.log, batchOf(i))).key);
  }
  const r = await capped.log.sweep();
  assert.deepEqual(r, { deleted: 5, more: false, rows: 3 });
  assert.deepEqual(Array.from(capped.storage.rows.keys()).filter((k) => k.startsWith(KEY_PREFIX)), keys.slice(5));
  // rounds: 10 old rows, pages of 2, 2 rounds a sweep
  const rounds = makeLog();
  rounds.log.limits.pageRows = 2;
  rounds.log.limits.sweepRounds = 2;
  for (let i = 0; i < 10; i++) {
    rounds.clock.now = T0 - 9 * DAY + i;
    await post(rounds.log, batchOf(i));
  }
  rounds.clock.now = T0;
  assert.deepEqual(await rounds.log.sweep(), { deleted: 4, more: true, rows: 6 });
  assert.deepEqual(await rounds.log.sweep(), { deleted: 4, more: true, rows: 2 });
  assert.deepEqual(await rounds.log.sweep(), { deleted: 2, more: false, rows: 0 });
  assert.deepEqual(await rounds.log.sweep(), { deleted: 0, more: false, rows: 0 });
  // the count is a few off after a rebuilt object lost its last writes: an empty store puts it right
  const drift = makeLog();
  await drift.storage.put(META_KEY, { d: Math.floor(T0 / DAY), n: 5, r: 5 });
  assert.deepEqual(await drift.log.load(), { rows: 5, today: 5 });
  assert.deepEqual(await drift.log.sweep(), { deleted: 0, more: false, rows: 0 });
  assert.equal(drift.log.rowCount(), 0);
});

test('the log has nothing about the sender: rows hold the validated batch and its handful of fields, and no key or value that is not in the format', async () => {
  const { storage, log } = makeLog();
  await post(log, sample({ events: [{ t: 1, n: 'log', m: 'peer 203.0.113.9:5555 from [2001:db8::7]:1234 via abcd-efgh-jkmn' }] }));
  const dump = JSON.stringify(Array.from(storage.rows.values()));
  for (const leak of ['203.0.113.9', '5555', '2001:db8', 'efgh', 'jkmn']) assert.equal(dump.includes(leak), false, leak);
  assert.ok(dump.includes('peer ' + MASK + ' from ' + MASK + ' via abcd'));
});

// ---------------------------------------------------------------------------------------------- the checks of the fix lane (verify-adversary F2, F3, F4, F6, F11)

/** testedChars(fn) -> the characters fn hands to RegExp.prototype.test: the work of a rule that reads text again and again shows here, without a clock. */
function testedChars(fn) {
  const real = RegExp.prototype.test;
  let chars = 0;
  RegExp.prototype.test = function (s) { chars += String(s).length; return real.call(this, s); };
  try { fn(); } finally { RegExp.prototype.test = real; }
  return chars;
}

test('maskString: a text of many "#1" costs time in proportion to its length, not to its square (the word in front of each # is read once)', () => {
  const text = '#1'.repeat(1000);
  const seen = testedChars(() => maskString(text));
  assert.ok(seen < 20000, 'the characters handed to a regular expression test: ' + seen + ' (reading everything before each # again made it about a million)');
  assert.equal(maskString(text), '#1'.repeat(100), 'a number after a # in text that is not a URL stays, and the string is cut at 200');
  // what the rule does has not changed: a # after a URL character cuts, a # after a plain word and a number stays, in a long text as in a short one
  assert.equal(maskString('step #3 of #12 at #7'), 'step #3 of #12 at #7');
  assert.equal(maskString('a #1#1 b.c #2'), 'a #1#1 b.c #2');
  assert.equal(maskString('a #1#1 b.c#2'), 'a #1#1 b.c#');
  assert.equal(maskString('x#1.5#2'), 'x#1.5#');
  assert.equal(maskString('x#1#a/b'), 'x#1#');
  assert.equal(maskString('https://host/#123456'), 'https://host/#');
  assert.equal(maskString('#1 '.repeat(500)).slice(0, 12), '#1 #1 #1 #1 ');
});

test('maskString: the look-alikes of the dot and the colon, a combining mark in an address, percent escapes and octal groups are addresses; one integer and a hex number are left alone', () => {
  const ch = String.fromCharCode;
  const gone = (input, secret) => {
    const out = maskString(input);
    assert.equal(out.includes(secret), false, JSON.stringify(input) + ' -> ' + JSON.stringify(out));
    assert.equal(maskString(out), out, 'idempotent: ' + JSON.stringify(out));
  };
  gone('192' + ch(0x3002) + '168' + ch(0x3002) + '0' + ch(0x3002) + '1', '168');
  gone('192' + ch(0xff61) + '168' + ch(0xff61) + '0' + ch(0xff61) + '1', '168');
  gone('192%2E168%2E0%2E1', '168');
  gone('http://192%2e168%2e0%2e1:8080/x', '168');
  gone('192' + ch(0x301) + '.168.0.1', '168');
  gone('192.168' + ch(0x301) + ch(0x302) + '.0.1', '168');
  gone('0300.0250.0.1', '0250');
  gone('0300.0250.0.1:8080', '8080');
  gone('2001' + ch(0x2236) + 'db8' + ch(0x2236) + ch(0x2236) + '1', 'db8');
  gone('2001' + ch(0xa789) + 'db8' + ch(0xa789) + ch(0xa789) + '1', 'db8');
  gone('2001%3adb8%3a%3a1', 'db8');
  assert.equal(maskString('192.168.0.1'), MASK);
  // what is not an address stays: an accent (composed, or a mark after a letter that has no composed form), an integer, a hex error code, a version
  assert.equal(maskString('caf' + ch(0xe9) + ' and q' + ch(0x301)), 'caf' + ch(0xe9) + ' and q' + ch(0x301));
  assert.equal(maskString('3232235777'), '3232235777');
  assert.equal(maskString('0xC0A80001'), '0xC0A80001');
  assert.equal(maskString('Error 0x80070005 in 1.2.3'), 'Error 0x80070005 in 1.2.3');
  assert.equal(maskString('page 08.1.1.1 and 00.1.2.3 and 0.0.0.0'), 'page ' + MASK + ' and ' + MASK + ' and ' + MASK, 'groups with a leading zero are groups');
});

test('maskString: the user fragment, the password and the fingerprint of an SDP are cut, whatever line ends the text has; the keys and the rest of the line stay', () => {
  const sdp = 'a=candidate:842163049 1 udp 1677729535 203.0.113.9 51472 typ srflx raddr 192.168.1.5 rport 51472\r\na=ice-ufrag:Zq3k\r\na=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsT\r\na=fingerprint:sha-256 5D:1C:0A:77:B3:4E:99:AB:CD:EF:01:23:45:67:89:AB\r\n';
  const out = maskString(sdp);
  assert.equal(out, 'a=candidate:842163049 1 udp 1677729535 ' + MASK + ' typ srflx raddr ' + MASK + ' a=ice-ufrag: a=ice-pwd: a=fingerprint:sha-256');
  for (const secret of ['Zq3k', 'zXy9', '5D:1C', '203.0.113', '192.168', '51472']) assert.equal(out.includes(secret), false, secret);
  assert.equal(maskString(out), out, 'idempotent');
  assert.equal(maskString('ice-ufrag:Zq3k and fingerprint:abc'), 'ice-ufrag:Zq3k and fingerprint:abc', 'the key alone, without a=, is no SDP line');
  assert.equal(maskString('A=ICE-PWD:Secret1234 x'), 'A=ICE-PWD: x', 'in any case');
});

test('validateBatch: who is a short id as the identity page makes it (3000 of its own shortId pass, and the 32 characters it draws from are exactly the pattern); a name, an address or any other word is refused', () => {
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const id = shortId('p256:key-number-' + i);
    seen.add(id);
    assert.equal(validateBatch(sample({ who: id })).ok, true, id);
  }
  assert.ok(seen.size > 2990, 'the ids differ: ' + seen.size);
  const alphabet = new Set(Array.from(seen).join('').replace(/-/g, ''));
  assert.equal(alphabet.size, 32, 'all 32 characters of the identity page alphabet occur');
  for (const c of ['l', 'o', '0', '1']) assert.equal(alphabet.has(c), false, c + ' is not in it, and the Worker leaves it out');
  for (const who of ['zorblat-zorblat', 'zorblat', 'abcdefgh', 'abcd-efg', 'abcd-efghi', 'abcd_efgh', 'ABCD-EFGH', 'abc0-efgh', 'abc1-efgh', 'abcl-efgh', 'abco-efgh', 'a@b.c', '203.0.113.5', 'x'.repeat(24), ' abcd-efgh', 'abcd-efgh\n', '-abcd-efgh', 'abcd--efgh']) {
    assert.deepEqual([who, validateBatch(sample({ who })).reason], [who, 'who']);
  }
  assert.equal(parseEventsQuery(new URLSearchParams('who=da9u-6qug')).ok, true);
  for (const who of ['zorblat', 'abc0-efgh', 'a'.repeat(24)]) assert.equal(parseEventsQuery(new URLSearchParams('who=' + who)).reason, 'who', 'the filter takes the same shape: ' + who);
});

test('validateBatch: loader is a version or nothing, site is at most 8 hex characters, net takes the words navigator.connection has and none other', () => {
  for (const loader of ['', '0.3.0', '0.3.1-rc.1', '1.2.3+build.5', '1234.5678.9012-a']) assert.equal(validateBatch(sample({ loader })).ok, true, JSON.stringify(loader));
  for (const loader of ['dev', '203.0.113.5', '0.3', '0.3.0.1', 'zorblat', 'v0.3.0', '0.3.0-', '0.3.0 ', '0.3.0-rc.1+abcdefgh', '1234.5678.9012-ab']) assert.equal(validateBatch(sample({ loader })).reason, 'loader', JSON.stringify(loader));
  for (const site of ['', 'a', 'd680ff36']) assert.equal(validateBatch(sample({ site })).ok, true, site);
  for (const site of ['d680ff36d', 'd680ff36deadbeef', 'D680FF36', 'xyz', ' ']) assert.equal(validateBatch(sample({ site })).reason, 'site', JSON.stringify(site));
  for (const [type, effectiveType] of [['wifi', '4g'], ['cellular', '3g'], ['ethernet', 'unknown'], ['bluetooth', '2g'], ['none', 'slow-2g'], ['wimax', '4g'], ['mixed', '4g'], ['other', '4g'], ['unknown', 'unknown']]) {
    assert.deepEqual(validateBatch(sample({ net: { type, effectiveType } })).batch.net, { type, effectiveType });
  }
  for (const net of [{ type: 'abcdefgh2345', effectiveType: '4g' }, { type: 'wifi', effectiveType: '5g' }, { type: '203.0.113.5', effectiveType: '4g' }, { type: 'WIFI', effectiveType: '4g' }, { type: 'wifi', effectiveType: '198-51-100-7' }]) {
    assert.equal(validateBatch(sample({ net })).reason, 'net', JSON.stringify(net));
  }
});

test('createLimiter: gate() says only whether the day is full; take() remembers the number and text of a batch (the last 8 of a session) so that seen() knows one sent again; a refused batch is not remembered; a new day forgets', () => {
  const mark = (seq, sig = 's') => ({ seq, sig });
  const L = createLimiter({ maxBatchesPerDay: 3 });
  assert.deepEqual(L.gate(T0), { ok: true });
  assert.equal(L.seen('a', mark(0), T0), false);
  assert.deepEqual(L.take('a', T0, mark(0)), { ok: true });
  assert.equal(L.seen('a', mark(0), T0), true);
  assert.equal(L.seen('a', mark(0, 'other text'), T0), false, 'the same number with other text is another batch');
  assert.equal(L.seen('a', mark(1), T0), false);
  assert.equal(L.seen('b', mark(0), T0), false, 'another session');
  assert.equal(L.seen('a', null, T0), false);
  assert.equal(L.seen('a', { seq: 0 }, T0), false);
  L.take('b', T0, null);
  assert.equal(L.seen('b', mark(0), T0), false, 'a take without a mark remembers nothing');
  L.take('c', T0, mark(7));
  const full = L.gate(T0);
  assert.deepEqual([full.ok, full.why, full.retryAfter], [false, 'day-all', 12 * 3600]);
  const refused = L.take('d', T0, mark(9));
  assert.deepEqual([refused.ok, refused.why], [false, 'day-all']);
  assert.equal(L.seen('d', mark(9), T0), false, 'a refused batch is not remembered');
  assert.equal(L.count(T0), 3);
  assert.deepEqual(L.gate(T0 + DAY), { ok: true }, 'the next UTC day');
  assert.equal(L.seen('a', mark(0), T0 + DAY), false, 'and the marks are gone');
  const many = createLimiter({ perSidPerMinute: 100 });
  for (let i = 0; i < 10; i++) many.take('e', T0 + i, mark(i));
  assert.deepEqual([0, 1, 2, 9].map((i) => many.seen('e', mark(i), T0 + 20)), [false, false, true, true], 'the last 8 are kept');
  const slow = createLimiter({ perSidPerMinute: 1 });
  slow.take('f', T0, mark(0));
  assert.equal(slow.take('f', T0 + 1, mark(1)).why, 'sid-minute');
  assert.equal(slow.seen('f', mark(1), T0 + 2), false, 'a batch refused by the session limit is not remembered either');
});

test('ingest: a batch sent again (the same session, number and text) is answered 204 with repeat: true and is neither stored, counted nor saved; other text under the same number is a new batch', async () => {
  const { storage, clock, log } = makeLog();
  const text = JSON.stringify(sample({ seq: 5 }));
  const first = await log.ingest(text);
  assert.equal(first.ok, true);
  assert.ok(first.key && first.row);
  const puts = storage.rows.size;
  const again = await log.ingest(text);
  assert.deepEqual(again, { ok: true, status: 204, repeat: true });
  assert.deepEqual([log.rowCount(), log.todayCount(), storage.rows.size], [1, 1, puts], 'nothing stored or counted');
  clock.now = T0 + 5000;
  assert.equal((await log.ingest(text)).repeat, true, 'whenever it comes');
  const other = await log.ingest(JSON.stringify(sample({ seq: 5, events: [{ t: 1, n: 'a.b' }] })));
  assert.ok(other.key, 'the same number with other text is stored');
  const next = await log.ingest(JSON.stringify(sample({ seq: 6 })));
  assert.ok(next.key, 'the same text under the next number is stored');
  const sib = await log.ingest(JSON.stringify(sample({ seq: 5, sid: sidOf(2) })));
  assert.ok(sib.key, 'the same number and text from another session is stored');
  assert.equal(log.rowCount(), 4);
  // a repeat is not a way round the limits: it costs nothing, and it is not counted against the session either
  const lim = makeLog();
  for (let i = 0; i < 60; i++) await lim.log.ingest(JSON.stringify(sample({ seq: i })));
  assert.equal((await lim.log.ingest(JSON.stringify(sample({ seq: 60 })))).reason, 'sid-minute');
  assert.equal((await lim.log.ingest(JSON.stringify(sample({ seq: 59 })))).repeat, true, 'a batch the session did send is a repeat even when its minute is full');
  assert.equal(lim.log.rowCount(), 60);
});

test('ingest: once the day total is reached the answer is 429 day-all before the body is read: JSON.parse is not called, not even for text that is not JSON; the size checks come first', async () => {
  const { clock, log } = makeLog({ maxBatchesPerDay: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await post(log, batchOf(i))).ok, true);
  const real = JSON.parse;
  let parses = 0;
  JSON.parse = function (...args) { parses++; return real.apply(this, args); };
  try {
    for (const body of [JSON.stringify(batchOf(5)), 'not json at all', '{', '#1'.repeat(10000), JSON.stringify(sample({ v: 2 }))]) {
      const r = await log.ingest(body);
      assert.deepEqual([body.slice(0, 12), r.ok, r.status, r.reason, r.retryAfter], [body.slice(0, 12), false, 429, 'day-all', 12 * 3600]);
    }
    assert.equal(parses, 0, 'no body was parsed');
    assert.equal((await log.ingest('x'.repeat(32769))).status, 413, 'too large is still too large');
    assert.equal((await log.ingest('')).status, 400);
  } finally {
    JSON.parse = real;
  }
  clock.now = T0 + DAY;
  assert.equal((await log.ingest('not json at all')).reason, 'json', 'a new day reads bodies again');
});
