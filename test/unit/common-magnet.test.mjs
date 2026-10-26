import test from 'node:test';
import assert from 'node:assert/strict';
import magnetUri from 'magnet-uri';
import { normalizeBtih, parseMagnet, formatMagnet, uniqueStrings } from '../../src/common/magnet.js';
import { encode as b32 } from '../../src/common/base32.js';

const HEX = '0123456789abcdef0123456789abcdef01234567';

test('normalizeBtih: hex in either case, base32, prefixes; null otherwise', () => {
  assert.equal(normalizeBtih(HEX), HEX);
  assert.equal(normalizeBtih(HEX.toUpperCase()), HEX);
  assert.equal(normalizeBtih('urn:btih:' + HEX), HEX);
  assert.equal(normalizeBtih('btih:' + HEX), HEX);
  const base32 = b32(Buffer.from(HEX, 'hex'));
  assert.equal(base32.length, 32);
  assert.equal(normalizeBtih(base32), HEX);
  assert.equal(normalizeBtih(base32.toUpperCase()), HEX);
  for (const bad of [null, undefined, 42, '', HEX.slice(1), HEX + '0', 'z'.repeat(40), '1'.repeat(32)]) {
    assert.equal(normalizeBtih(bad), null, String(bad));
  }
});

test('parseMagnet: xt, dn, repeated tr/ws/xs, numbered keys, btmh ignored', () => {
  const uri = 'magnet:?xt=urn:btih:' + HEX.toUpperCase() +
    '&xt=urn:btmh:1220' + 'ab'.repeat(32) +
    '&dn=My+Site%20%2B1' +
    '&tr=wss%3A%2F%2Fa.example&tr.1=wss://b.example&tr=wss%3A%2F%2Fa.example' +
    '&ws=https%3A%2F%2Fseed.example%2Fws%2F' +
    '&xs=https%3A%2F%2Fseed.example%2Fsite.torrent&xs=https%3A%2F%2Fmirror.example%2Fsite.torrent' +
    '&x.pe=1.2.3.4:5';
  const m = parseMagnet(uri);
  assert.deepEqual(m, {
    btih: HEX,
    dn: 'My Site +1',
    tr: ['wss://a.example', 'wss://b.example'],
    ws: ['https://seed.example/ws/'],
    xs: ['https://seed.example/site.torrent', 'https://mirror.example/site.torrent'],
  });
});

test('parseMagnet: HTML-escaped &amp; and odd input', () => {
  const m = parseMagnet('MAGNET:?xt=urn:btih:' + HEX + '&amp;tr=wss%3A%2F%2Fa.example&amp;xs=https%3A%2F%2Fh%2Ft');
  assert.deepEqual(m.tr, ['wss://a.example']);
  assert.deepEqual(m.xs, ['https://h/t']);
  assert.equal(parseMagnet('magnet:?dn=x'), null, 'no infohash');
  assert.equal(parseMagnet('magnet:?xt=urn:btih:nothex'), null);
  assert.equal(parseMagnet('magnet:?xt=urn:btih:' + HEX + '&xt=urn:btih:' + 'f'.repeat(40)), null, 'ambiguous');
  assert.equal(parseMagnet('http://example.com/?xt=urn:btih:' + HEX), null);
  assert.equal(parseMagnet(42), null);
  const same = parseMagnet('magnet:?xt=urn:btih:' + HEX + '&xt.1=urn:btih:' + b32(Buffer.from(HEX, 'hex')));
  assert.equal(same.btih, HEX, 'the same hash twice (hex and base32) is fine');
  assert.equal(parseMagnet('magnet:?xt=urn:btih:' + HEX + '&dn=%E0%A4%A').dn, '%E0%A4%A', 'malformed escape kept');
});

test('formatMagnet: fixed order xt, dn, tr, ws, xs; round trip; magnet-uri agrees', () => {
  const rec = {
    btih: HEX.toUpperCase(), dn: 'Caf' + String.fromCharCode(0xe9) + ' & co',
    tr: ['wss://b.example', 'wss://a.example', 'wss://b.example', ''],
    ws: ['https://seed.example/ws/'], xs: ['https://seed.example/t.torrent'],
  };
  const uri = formatMagnet(rec);
  assert.equal(uri,
    'magnet:?xt=urn:btih:' + HEX + '&dn=Caf%C3%A9%20%26%20co' +
    '&tr=wss%3A%2F%2Fb.example&tr=wss%3A%2F%2Fa.example' +
    '&ws=https%3A%2F%2Fseed.example%2Fws%2F&xs=https%3A%2F%2Fseed.example%2Ft.torrent');
  const back = parseMagnet(uri);
  assert.deepEqual(back, { btih: HEX, dn: rec.dn, tr: ['wss://b.example', 'wss://a.example'], ws: rec.ws, xs: rec.xs });
  const theirs = magnetUri(uri);
  assert.equal(theirs.infoHash, HEX);
  assert.equal(theirs.name, rec.dn);
  assert.deepEqual(theirs.announce.slice().sort(), ['wss://a.example', 'wss://b.example']);
  assert.deepEqual(theirs.urlList, ['https://seed.example/ws/']);
  assert.equal(theirs.xs, 'https://seed.example/t.torrent');
  assert.throws(() => formatMagnet({ btih: 'nope' }), TypeError);
  assert.equal(formatMagnet({ btih: HEX }), 'magnet:?xt=urn:btih:' + HEX);
});

test('uniqueStrings: trims, dedupes, keeps order', () => {
  assert.deepEqual(uniqueStrings([' a ', 'b', 'a', '', 3, null, 'b']), ['a', 'b']);
  assert.deepEqual(uniqueStrings('nope'), []);
});
