// Unit tests for the doors lane on the loader side (v0.3 C2, docs/research/v03/S4-doors.md D2 to D6): src/loader/doors.js (the
// candidates and their order, the health memory, door.json and the probe, the staggered fetch of RFC 8305, the ledger's _doors,
// the door budget, the panel and banner models, the door view), the door pieces of src/loader/app.js (the generalised fragment,
// mode 'door', share-target and pasted links, the one-time reload into the limited-mode policy, the byte fallback across doors,
// the "not answering" banner, the ledger doors, viaDoor storage), src/sw/core.js (the door page, door.json, meta.current), the door
// strings and the Doors panel of src/loader/ui.js, and the door outputs of build.mjs. No network: fetch, caches and windows are
// fakes; nothing leaves the process. The browser check of the door view is test/unit/loader-doors-browser.test.mjs (MW_BROWSER=1,
// Chromium with the local-only flags, WebKit on http://127.0.0.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  doorCandidates, hintAllowed, doorTorrentUrls, doorWebseeds, createDoorHealth, doorJsonFor, checkDoorJson, probeDoor, fetchFirst, byteDoors,
  ledgerDoorsFrom, ledgerDoorsProblem, ledgerDoorsValue, readLedgerDoors, enforceDoorBudget, doorsPanelModel, doorsBannerModel, doorLinkFor,
  doorFiles, doorFrameHtml, doorMimeOf, mountDoorView, DOOR_TIMING, DOOR_SANDBOX, LEDGER_DOORS_MAX, LEDGER_DOORS_BYTES, LEDGER_DOORS_INTERVAL_MS,
  DOOR_JSON_PATH, DOOR_COPIES_MAX,
} from '../../src/loader/doors.js';
import { parseFragment, resolveMode, sdkMode, pastedFragment, sharedFragment, __c2Doors } from '../../src/loader/app.js';
import { signPointer, formatPointer, parsePointer, verifyPointer, formatLightLink, DOOR_PAGE_PATH } from '../../src/common/pointer.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { encodeGenesis } from '../../src/loader/personal-site.js';
import { DOOR_TEXT, doorText } from '../../src/loader/strings.js';
import { createDoorsUi, doorStateText } from '../../src/loader/ui.js';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { createCore, PROTO, DOOR_PAGE_PATH as SW_DOOR_PAGE, DOOR_JSON_PATH as SW_DOOR_JSON } from '../../src/sw/core.js';
import { doorManifestJson, doorPageHtml, doorJson, precacheList, manifestJson, DOOR_JSON } from '../../build.mjs';

const BTIH = '6b3a0d1c5e7f90214365879aabbccddeeff00112';
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newOwner() {
  const kp = await generateKeyPair({ extractable: false });
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

async function hubRecord(owner, more = {}) {
  const now = Math.floor(NOW / 1000);
  const r = Object.assign({ btih: BTIH, dn: 'My Site', chain: 'my site', owner: owner.pub, org: ['https://example.com'], dr: ['door-b.example.org', 'door-c.example.net'], seq: now, exp: now + 86400 * 30 }, more);
  return signPointer(r, 'btih:' + BTIH, owner.privateKey);
}

// ---------------------------------------------------------------------------------------------- candidates and hints

test('doorCandidates: current, last good, owner (org=), guest (dr=), ledger, hints; each host once, at most 12', async () => {
  const owner = await newOwner();
  const rec = await hubRecord(owner);
  const c = doorCandidates({
    current: 'door-a.example.org', lastGood: 'door-c.example.net', record: rec,
    ledgerDoors: ['ledger.example.org', 'door-b.example.org', 'Bad Host'], hints: ['hint.example.org', '10.0.0.1', 'localhost'],
  });
  assert.deepEqual(c.map((x) => [x.host, x.kind]), [
    ['door-a.example.org', 'current'], ['door-c.example.net', 'last-good'], ['example.com', 'owner'], ['door-b.example.org', 'guest'],
    ['ledger.example.org', 'ledger'], ['hint.example.org', 'hint'],
  ]);
  assert.equal(c[0].origin, 'https://door-a.example.org');
  const many = doorCandidates({ current: 'a.example', ledgerDoors: Array.from({ length: 20 }, (_, i) => 'l' + i + '.example') });
  assert.equal(many.length, 12);
  assert.deepEqual(doorCandidates({ current: 'Bad', record: null }), []);
});

test('hintAllowed: an unsigned hint must be a public host, except loopback hints on a loopback page (development)', () => {
  assert.equal(hintAllowed('mirror.example.org'), true);
  for (const h of ['10.0.0.1', '192.168.1.1:8080', 'localhost', 'printer.local', 'router.lan', '[::1]', '169.254.1.1']) assert.equal(hintAllowed(h, { pageHost: 'door.example.org' }), false, h);
  assert.equal(hintAllowed('127.0.0.1:9001', { pageHost: '127.0.0.1:9000' }), true);
  assert.equal(hintAllowed('localhost:9001', { pageHost: 'door.example.org' }), false);
  assert.equal(hintAllowed('https://x.example'), false);
});

test('doorTorrentUrls and doorWebseeds: the full-door layout; web seeds skip doors in back-off and the record\'s own, at most 3', () => {
  const c = doorCandidates({ current: '127.0.0.1:9000', ledgerDoors: ['a.example', 'b.example', 'c.example', 'd.example'] });
  assert.deepEqual(doorTorrentUrls(c, BTIH).slice(0, 2), ['http://127.0.0.1:9000/_mw/t/' + BTIH + '.torrent', 'https://a.example/_mw/t/' + BTIH + '.torrent']);
  assert.deepEqual(doorTorrentUrls(c, 'nope'), []);
  const health = createDoorHealth({ now: () => NOW });
  health.fail('a.example', 'down');
  assert.deepEqual(doorWebseeds(c, { health, now: NOW, exclude: ['http://127.0.0.1:9000/ws/'] }), ['https://b.example/ws/', 'https://c.example/ws/', 'https://d.example/ws/']);
  assert.equal(doorWebseeds(c, { max: 1 }).length, 1);
});

// ---------------------------------------------------------------------------------------------- health memory

test('createDoorHealth: a failure starts a 10-minute back-off, a success ends it; order() puts doors in back-off last; persisted', async () => {
  let t = NOW;
  const saved = [];
  const h = createDoorHealth({ now: () => t, load: async () => ({ 'old.example': { ok: 5, fail: 0, until: 0, state: 'up' }, 'BAD KEY': {} }), save: (m) => { saved.push(m); return Promise.resolve() } });
  await h.ready;
  assert.equal(h.get('old.example').state, 'up');
  assert.equal(h.get('BAD KEY'), null);
  h.fail('a.example', 'first-byte');
  assert.equal(h.inBackoff('a.example'), true);
  assert.equal(DOOR_TIMING.backoffMs, 600000);
  t += DOOR_TIMING.backoffMs - 1;
  assert.equal(h.inBackoff('a.example'), true);
  t += 2;
  assert.equal(h.inBackoff('a.example'), false);
  h.fail('b.example');
  assert.deepEqual(h.order([{ host: 'b.example' }, { host: 'c.example' }]).map((x) => x.host), ['c.example', 'b.example']);
  h.ok('b.example', { state: 'other-build', buildId: 'abc123' });
  assert.equal(h.inBackoff('b.example'), false);
  assert.equal(h.get('b.example').buildId, 'abc123');
  assert.ok(saved.length >= 3 && saved[saved.length - 1]['b.example']);
  const small = createDoorHealth({ now: () => t++, max: 2 });
  for (const x of ['a.example', 'b.example', 'c.example']) small.ok(x);
  assert.deepEqual(Object.keys(small.snapshot()).sort(), ['b.example', 'c.example'], 'the least recently updated host goes');
});

// ---------------------------------------------------------------------------------------------- door.json and the probe

function fakeDoorJson(extra = {}) {
  const files = ['/_mw/open.html', '/_mw/loader.js', '/mw-sw.js', '/_mw/boot.js'].map((path) => {
    const bytes = Buffer.from('bytes of ' + path);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sri: 'sha384-' + createHash('sha384').update(bytes).digest('base64') };
  });
  return Object.assign(doorJsonFor({ version: '0.3.0', buildId: 'abcdef123456', files }), extra);
}

test('doorJsonFor / checkDoorJson: the shape, the required files, and whether a door runs this very build', () => {
  const mine = fakeDoorJson();
  assert.equal(mine.kind, 'felinar-door');
  assert.equal(mine.page, DOOR_PAGE_PATH);
  assert.deepEqual(Object.keys(mine.files), ['/_mw/boot.js', '/_mw/loader.js', '/_mw/open.html', '/mw-sw.js'], 'sorted, door.json itself never listed');
  assert.deepEqual(checkDoorJson(mine, mine), { ok: true, sameBuild: true, buildId: 'abcdef123456', version: '0.3.0', reason: null });
  const other = JSON.parse(JSON.stringify(mine));
  other.buildId = 'ffffff000000';
  other.files['/_mw/loader.js'].sha256 = 'f'.repeat(64);
  assert.equal(checkDoorJson(other, mine).sameBuild, false);
  assert.equal(checkDoorJson(other).ok, true);
  assert.equal(checkDoorJson('<html>blocked</html>').reason, 'not-an-object');
  assert.equal(checkDoorJson({ v: 1, kind: 'something' }).reason, 'not-a-door');
  const missing = JSON.parse(JSON.stringify(mine));
  delete missing.files['/mw-sw.js'];
  assert.match(checkDoorJson(missing).reason, /missing \/mw-sw\.js/);
  const badSri = JSON.parse(JSON.stringify(mine));
  badSri.files['/_mw/boot.js'].sri = 'md5-x';
  assert.match(checkDoorJson(badSri).reason, /entry/);
});

function fakeFetch(routes) {
  const f = async (url, init = {}) => {
    f.calls.push({ url, init });
    const r = routes[url + '|' + (init.mode || 'cors')] !== undefined ? routes[url + '|' + (init.mode || 'cors')] : routes[url];
    if (r === undefined) throw new TypeError('Failed to fetch');
    if (typeof r === 'function') return r(url, init);
    if (r instanceof Error) throw r;
    return r.clone ? r.clone() : r;
  };
  f.calls = [];
  return f;
}

test('probeDoor: down, opaque (no CORS), bad (a block page answers 200), up, other build; no credentials, no referrer, no cache', async () => {
  const mine = fakeDoorJson();
  const json = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
  const url = 'https://door.example' + DOOR_JSON_PATH;
  let r = await probeDoor('https://door.example', { fetch: fakeFetch({}) });
  assert.equal(r.state, 'down');
  r = await probeDoor('https://door.example', { fetch: fakeFetch({ [url + '|no-cors']: new Response(null, { status: 200 }), [url + '|cors']: new TypeError('CORS') }) });
  assert.equal(r.state, 'opaque');
  r = await probeDoor('https://door.example', { fetch: fakeFetch({ [url + '|no-cors']: new Response(null), [url + '|cors']: new Response('<html>This site is blocked</html>', { status: 200 }) }) });
  assert.equal(r.state, 'bad');
  r = await probeDoor('https://door.example', { fetch: fakeFetch({ [url + '|no-cors']: new Response(null), [url + '|cors']: new Response('gone', { status: 404 }) }) });
  assert.deepEqual([r.state, r.reason], ['bad', 'http-404']);
  const f = fakeFetch({ [url + '|no-cors']: new Response(null), [url + '|cors']: json(mine) });
  r = await probeDoor('https://door.example', { fetch: f, own: mine });
  assert.deepEqual([r.state, r.buildId], ['up', 'abcdef123456']);
  assert.deepEqual(r.json, mine, 'the parsed list comes back, so a page can keep its own');
  for (const c of f.calls) {
    assert.equal(c.init.cache, 'no-store');
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.referrerPolicy, 'no-referrer');
  }
  const other = Object.assign({}, mine, { buildId: '000000aaaaaa' });
  r = await probeDoor('https://door.example', { fetch: fakeFetch({ [url + '|no-cors']: new Response(null), [url + '|cors']: json(other) }), own: mine });
  assert.equal(r.state, 'other-build');
  // the page's own address: one same-origin request, and a failure is 'down'
  const same = fakeFetch({ [url + '|same-origin']: json(mine) });
  r = await probeDoor('https://door.example', { fetch: same, sameOrigin: true });
  assert.equal(r.state, 'up');
  assert.equal(same.calls.length, 1);
  r = await probeDoor('https://door.example', { fetch: fakeFetch({}), sameOrigin: true });
  assert.equal(r.state, 'down');
  // a door that never answers: down after timeoutMs
  const hang = (u, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))) });
  r = await probeDoor('https://door.example', { fetch: fakeFetch({ [url + '|no-cors']: hang }), timeoutMs: 30 });
  assert.equal(r.state, 'down');
});

// ---------------------------------------------------------------------------------------------- the staggered fetch

function bytesResponse(text, { delay = 0, status = 200 } = {}) {
  return (u, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(text, { status })), delay);
    if (init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) });
  });
}

test('fetchFirst: the first door starts at once, the next after the stagger; a failure starts the next at once; the hash decides', async () => {
  const verify = (b) => new TextDecoder().decode(b) === 'GOOD';
  const t0 = Date.now();
  const f = fakeFetch({ 'https://a/x': bytesResponse('GOOD', { delay: 400 }), 'https://b/x': bytesResponse('GOOD', { delay: 10 }) });
  let r = await fetchFirst(['https://a/x', 'https://b/x'], { fetch: f, verify, staggerMs: 40, firstByteMs: 1000, perDoorMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://b/x', 'the second door started after the stagger and won');
  assert.ok(Date.now() - t0 < 350, 'the slow first door was not waited for');
  // a wrong hash is skipped; a 404 fails at once and the next one starts without the stagger
  const g = fakeFetch({ 'https://a/x': bytesResponse('EVIL'), 'https://b/x': bytesResponse('nope', { status: 404 }), 'https://c/x': bytesResponse('GOOD') });
  r = await fetchFirst(['https://a/x', 'https://b/x', 'https://c/x'], { fetch: g, verify, staggerMs: 5000, firstByteMs: 1000, perDoorMs: 2000 });
  assert.equal(r.url, 'https://c/x');
  assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => x.reason).sort(), ['hash', 'http-404']);
  // never more than inFlight at once
  let live = 0
  let peak = 0
  const slow = () => (u, init) => { live++; peak = Math.max(peak, live); return new Promise((resolve, reject) => { const t = setTimeout(() => { live--; resolve(new Response('BAD')) }, 60); init.signal.addEventListener('abort', () => { clearTimeout(t); live--; reject(new Error('aborted')) }) }) };
  const urls = ['https://1/x', 'https://2/x', 'https://3/x', 'https://4/x', 'https://5/x'];
  r = await fetchFirst(urls, { fetch: fakeFetch(Object.fromEntries(urls.map((u) => [u, slow()]))), verify, staggerMs: 1, inFlight: 3, firstByteMs: 1000, perDoorMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(peak, 3);
  assert.equal(r.results.length, 5);
  // the time to the first byte is bounded
  const hang = (u, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))) });
  r = await fetchFirst(['https://h/x'], { fetch: fakeFetch({ 'https://h/x': hang }), verify, firstByteMs: 30, perDoorMs: 1000 });
  assert.deepEqual(r.results.map((x) => x.reason), ['first-byte']);
  // an abort from outside settles at once
  const ctl = new AbortController();
  const p = fetchFirst(['https://h/x'], { fetch: fakeFetch({ 'https://h/x': hang }), verify, signal: ctl.signal });
  ctl.abort();
  assert.equal((await p).aborted, true);
  assert.deepEqual(await fetchFirst([], { fetch: f }), { ok: false, url: null, bytes: null, results: [] });
});

// ---------------------------------------------------------------------------------------------- the ledger's _doors

test('ledgerDoorsFrom: owner-authored only, at most 24 distinct hosts and 2,048 bytes, one accepted change an hour on this device', () => {
  const owner = 'p256:OWNER';
  const entry = (v, more = {}) => Object.assign({ v, author: owner, h: 'h1', ts: NOW }, more);
  let r = ledgerDoorsFrom(entry({ v: 1, d: ['a.example', 'b.example:8443'] }), { owner, now: NOW });
  assert.deepEqual([r.reason, r.hosts], ['accepted', ['a.example', 'b.example:8443']]);
  assert.equal(ledgerDoorsFrom(entry({ v: 1, d: ['a.example'] }, { author: 'p256:MOD' }), { owner, now: NOW }).reason, 'not-owner', 'a moderator may write _ keys; its _doors is hidden');
  assert.equal(ledgerDoorsFrom(entry({ v: 1, d: Array.from({ length: 25 }, (_, i) => 'h' + i + '.example') }), { owner }).reason, 'too-many');
  assert.equal(ledgerDoorsFrom(entry({ v: 1, d: ['https://a.example'] }), { owner }).reason, 'bad-host');
  assert.equal(ledgerDoorsFrom(entry({ v: 1, d: ['a.example', 'a.example'] }), { owner }).reason, 'repeated-host');
  assert.equal(ledgerDoorsFrom(entry({ v: 1, d: ['a.example'], x: 1 }), { owner }).reason, 'unknown-field');
  assert.equal(ledgerDoorsFrom(entry({ v: 2, d: ['a.example'] }), { owner }).reason, 'version');
  const long = Array.from({ length: LEDGER_DOORS_MAX }, (_, i) => 'x'.repeat(50) + '.' + 'y'.repeat(50) + i + '.example');
  assert.equal(ledgerDoorsProblem({ v: 1, d: long.slice(0, 2) }), null, 'each host is valid');
  assert.equal(ledgerDoorsProblem({ v: 1, d: long }), 'too-large', 'over ' + LEDGER_DOORS_BYTES + ' bytes');
  // the rate: a second change within the hour is pending; the first one stays
  const first = r.accepted;
  r = ledgerDoorsFrom(entry({ v: 1, d: ['c.example'] }, { h: 'h2' }), { owner, previous: first, now: NOW + 1000 });
  assert.deepEqual([r.reason, r.pending, r.hosts], ['rate', true, ['a.example', 'b.example:8443']]);
  r = ledgerDoorsFrom(entry({ v: 1, d: ['c.example'] }, { h: 'h2' }), { owner, previous: first, now: NOW + LEDGER_DOORS_INTERVAL_MS });
  assert.deepEqual([r.reason, r.hosts], ['accepted', ['c.example']]);
  // an invalid new item hides itself and keeps what was accepted
  r = ledgerDoorsFrom(entry('nope', { h: 'h3' }), { owner, previous: first, now: NOW + 2 * LEDGER_DOORS_INTERVAL_MS });
  assert.deepEqual(r.hosts, ['a.example', 'b.example:8443']);
  assert.throws(() => ledgerDoorsValue(['Bad']), /ledgerDoorsValue/);
  assert.deepEqual(ledgerDoorsValue(['a.example']), { v: 1, d: ['a.example'] });
  // through a node's state (the existing key API: state.kv entries carry the author)
  const node = { owner, state: { kv: new Map([['_doors', entry({ v: 1, d: ['z.example'] })]]) } };
  assert.deepEqual(readLedgerDoors(node, { now: NOW }).hosts, ['z.example']);
  assert.deepEqual(readLedgerDoors({ get state () { throw new Error('closed') } }).hosts, []);
});

// ---------------------------------------------------------------------------------------------- storage

test('enforceDoorBudget: copies a door view stored go first (oldest first), beyond DOOR_COPIES_MAX or the budget; keep is kept', async () => {
  const sites = [
    { btih: 'a'.repeat(40), viaDoor: true, lastVisit: 1, files: [{ length: 100 }] },
    { btih: 'b'.repeat(40), viaDoor: true, lastVisit: 2, files: [{ length: 100 }] },
    { btih: 'c'.repeat(40), lastVisit: 0, files: [{ length: 1000 }] },
    { btih: 'd'.repeat(40), viaDoor: true, lastVisit: 3, files: [{ length: 100 }] },
  ];
  const cache = { deleted: [], async listSites () { return sites.filter((s) => !cache.deleted.includes(s.btih)) }, async deleteSite (b) { cache.deleted.push(b) } };
  let r = await enforceDoorBudget({ cache, budgetBytes: 1150, keep: ['d'.repeat(40)] });
  assert.deepEqual(r.evicted, ['a'.repeat(40), 'b'.repeat(40)], 'door copies first, oldest first; the own site and keep stay');
  cache.deleted = [];
  r = await enforceDoorBudget({ cache, budgetBytes: Infinity, maxCopies: 2 });
  assert.deepEqual(r.evicted, ['a'.repeat(40)]);
  assert.equal(DOOR_COPIES_MAX, 4);
  assert.deepEqual(await enforceDoorBudget({ cache: null }), { evicted: [] });
});

// ---------------------------------------------------------------------------------------------- panel, banner, links

test('doorsPanelModel / doorsBannerModel / doorLinkFor: states from the health memory; the banner skips this door and doors in back-off', () => {
  const c = doorCandidates({ current: 'a.example', lastGood: 'b.example', ledgerDoors: ['c.example', 'd.example', 'e.example', 'f.example'] });
  const health = createDoorHealth({ now: () => NOW });
  health.ok('b.example', { state: 'up' });
  health.fail('c.example');
  const m = doorsPanelModel({ candidates: c, health, now: NOW });
  assert.equal(m.shown, true);
  assert.deepEqual([m.current.host, m.lastGood.host, m.lastGood.state], ['a.example', 'b.example', 'up']);
  assert.deepEqual(m.ledger.map((x) => [x.host, x.state]), [['c.example', 'down'], ['d.example', null], ['e.example', null], ['f.example', null]]);
  const b = doorsBannerModel({ candidates: c, health, now: NOW });
  assert.deepEqual(b.hosts.map((x) => x.host), ['b.example', 'd.example', 'e.example'], 'at most 3, c in back-off left out');
  assert.equal(doorLinkFor({ host: 'x', origin: 'https://x.example', kind: 'guest' }, { fragment: '#v%3Dmw1', portable: true }), 'https://x.example/_mw/open.html#v%3Dmw1');
  assert.equal(doorLinkFor({ host: 'x', origin: 'https://x.example', kind: 'owner' }, { portable: false }), 'https://x.example/', 'an owner door opens at its root (its own page tag)');
  assert.equal(doorLinkFor({ host: 'x', origin: 'https://x.example', kind: 'guest' }, { portable: false }), null, 'a guest door needs a portable record');
});

// ---------------------------------------------------------------------------------------------- the door view (fake DOM; the browser check is at the end)

test('doorFiles, doorFrameHtml, doorMimeOf: site paths, an inline renderer that cannot end its script early, types by extension', async () => {
  const files = doorFiles({ files: [{ path: 'index.html' }, { path: '.pad/0', pad: true }, { path: 'a/b.css' }] }, new Map([['index.html', new Blob(['x'])], ['a/b.css', new Blob(['y'])]]));
  assert.deepEqual(Array.from(files.keys()), ['index.html', 'a/b.css']);
  const html = doorFrameHtml('var s = "</script><script>alert(1)</script>"; // <!-- x');
  assert.equal((html.match(/<\/script>/gi) || []).length, 1, 'only the closing tag of the renderer itself');
  assert.match(html, /<\\\/script>/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.equal(doorMimeOf('a/b.woff2', null), 'font/woff2');
  assert.equal(doorMimeOf('x.bin', { type: 'image/png' }), 'image/png');
  assert.equal(doorMimeOf('x.unknown', null), 'application/octet-stream');
});

function fakeWin() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener (type, fn) { if (type === 'message') listeners.add(fn) },
    removeEventListener (type, fn) { if (type === 'message') listeners.delete(fn) },
    deliver (ev) { for (const fn of Array.from(listeners)) fn(ev) },
  };
}

test('mountDoorView: sandbox="allow-scripts"; the files go to the frame\'s renderer over its port; only that frame, origin "null"', async () => {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  doc.appendChild(container);
  const win = fakeWin();
  const files = new Map([['index.html', new Blob(['<h1>hi</h1>'])]]);
  const sdk = new Blob(['export default {}']);
  const seen = { titles: [], blocked: [] };
  const p = mountDoorView({ container, files, path: '/', frameScript: 'frameMain(self)', sdk, base: 'https://door.example/', win, onTitle: (t) => seen.titles.push(t), onBlockedNavigation: (i) => seen.blocked.push(i.url), readyMs: 2000 });
  const iframe = container.children[0];
  assert.equal(iframe.tagName, 'IFRAME');
  assert.equal(iframe.getAttribute('sandbox'), DOOR_SANDBOX);
  assert.equal(DOOR_SANDBOX, 'allow-scripts');
  assert.equal(iframe.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(iframe.srcdoc, /<script>frameMain\(self\)/);
  const frameWin = { name: 'frame' };
  iframe.contentWindow = frameWin;
  const ch = new MessageChannel();
  const got = [];
  ch.port1.onmessage = (e) => {
    got.push(e.data);
    if (e.data.mwDoor === 'render') ch.port1.postMessage({ mwDoor: 'rendered', title: 'Hello', path: '/' });
  };
  // ignored: another window, another origin, the SDK's hello, no port
  win.deliver({ source: { name: 'other' }, origin: 'null', data: { mwDoor: 'ready' }, ports: [new MessageChannel().port2] });
  win.deliver({ source: frameWin, origin: 'https://evil.example', data: { mwDoor: 'ready' }, ports: [new MessageChannel().port2] });
  win.deliver({ source: frameWin, origin: 'null', data: { mw: 'hello' }, ports: [] });
  win.deliver({ source: frameWin, origin: 'null', data: { mwDoor: 'ready', v: 1 }, ports: [ch.port2] });
  const mount = await p;
  assert.equal(mount.rendered, true);
  assert.equal(mount.door, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].mwDoor, 'render');
  assert.equal(got[0].base, 'https://door.example/');
  assert.equal(got[0].path, '/');
  assert.equal(got[0].files.length, 1);
  assert.equal(got[0].files[0][0], 'index.html');
  assert.ok(got[0].sdk instanceof Blob);
  assert.deepEqual(seen.titles, ['Hello']);
  assert.equal(doc.title, 'Hello');
  // a site link asks for another page: the same frame element loads it (a new document and global)
  const before = iframe.srcdoc;
  ch.port1.postMessage({ mwDoor: 'navigate', path: '/about.html' });
  await sleep(20);
  assert.equal(mount.currentPath(), '/about.html');
  assert.equal(iframe.srcdoc, before);
  ch.port1.postMessage({ mwDoor: 'external', url: 'https://elsewhere.example/' });
  await sleep(20);
  assert.deepEqual(seen.blocked, ['https://elsewhere.example/']);
  mount.destroy();
  assert.equal(win.listeners.size, 0);
  assert.equal(container.children.length, 0);
  ch.port1.close();
  await assert.rejects(mountDoorView({ container, files, frameScript: '', win }), /renderer/);
});

// ---------------------------------------------------------------------------------------------- app.js: the fragment, the mode, pasted and shared links

test('parseFragment: #mwd= hints (at most 4) and #mwgen= after the record, web+felinar: literal and from a handler\'s %s', async () => {
  const owner = await newOwner();
  const rec = await hubRecord(owner);
  const text = formatPointer(rec);
  const enc = encodeURIComponent(text);
  let f = parseFragment('#' + enc + '#mwd=a.example,b.example,c.example,d.example,e.example#zz=1', '');
  assert.equal(f.kind, 'record');
  assert.equal(f.text, text, 'decoded once: values keep their own %20');
  assert.deepEqual(f.hints, ['a.example', 'b.example', 'c.example', 'd.example']);
  assert.equal((await verifyPointer(parsePointer(f.text).record, 'btih:' + BTIH, { now: NOW })).ok, true);
  // the literal form: the browser wrote the separator spaces as %20; dn=My%20Site and chain=my site (a raw space) come back as signed
  f = parseFragment('#' + text.replace(/ /g, '%20'), '');
  assert.equal((await verifyPointer(parsePointer(f.text).record, 'btih:' + BTIH, { now: NOW })).ok, false, 'a raw space inside a value cannot survive the literal form');
  const plain = await hubRecord(owner, { chain: 'mysite' });
  const plainText = formatPointer(plain);
  f = parseFragment('#' + plainText.replace(/ /g, '%20'), '');
  assert.equal(f.text, plainText);
  assert.equal(parsePointer(f.text).record.dn, 'My Site');
  assert.equal((await verifyPointer(parsePointer(f.text).record, 'btih:' + BTIH, { now: NOW })).ok, true, 'dn=My%20Site survives (loaders before C2 broke it)');
  // a protocol handler: /_mw/open.html#%s where %s is the whole web+felinar: link escaped once more
  const web = formatLightLink({ record: text, hints: ['hint.example'] });
  f = parseFragment('#' + encodeURIComponent(web), '');
  assert.equal(f.text, text);
  assert.equal(f.handler, true);
  assert.deepEqual(f.hints, ['hint.example']);
  // the genesis of a new personal site still travels, next to the hints
  const blocks = [{ e: { v: 1 }, h: 'a'.repeat(64) }];
  const gen = encodeGenesis(blocks);
  f = parseFragment('#' + enc + '#' + gen + '#mwd=a.example', '');
  assert.deepEqual(f.genesis, blocks);
  assert.equal(f.genesisText, gen);
  assert.deepEqual(f.hints, ['a.example']);
  // other kinds keep working; host links take no hints
  assert.deepEqual(parseFragment('#btih:' + BTIH + '#mwd=a.example', '').hints, ['a.example']);
  assert.equal(parseFragment('#host:example.com#mwd=a.example', '').hints, undefined);
  assert.equal(parseFragment('#section-2', ''), null, 'a site anchor is never a pointer');
  assert.equal(parseFragment('', '?mw=' + encodeURIComponent(plainText)).text, plainText);
});

test('resolveMode: /_mw/open.html is the door page (mode door, with or without a link, page tag or hub meta ignored); sdkMode', () => {
  const loc = (pathname, hash = '', hostname = 'door.example.org') => ({ hostname, pathname, search: '', hash });
  const m = resolveMode(loc(DOOR_PAGE_PATH, '#btih:' + BTIH), { metaPointer: 'v=mw1; btih=' + 'f'.repeat(40), hubMeta: 'subdomain' });
  assert.equal(m.mode, 'door');
  assert.equal(m.fragment.kind, 'btih');
  assert.deepEqual(resolveMode(loc(DOOR_PAGE_PATH)), { mode: 'door', fragment: null, path: '/' });
  assert.equal(resolveMode(loc('/')).mode, 'shell');
  assert.equal(resolveMode(loc('/_mw/open.htm')).mode, 'shell');
  assert.equal(sdkMode('door'), 'hub-shared');
  assert.equal(sdkMode('hub-sub'), 'hub');
});

test('pastedFragment / sharedFragment: light links, web+felinar:, hub links, records, magnets; a share target never names junk', async () => {
  const owner = await newOwner();
  const text = formatPointer(await hubRecord(owner));
  const link = formatLightLink({ door: 'door-b.example.org', record: text, hints: ['h.example'] });
  const frag = pastedFragment(link);
  assert.equal(parseFragment('#' + frag, '').text, text);
  assert.deepEqual(parseFragment('#' + frag, '').hints, ['h.example']);
  assert.equal(parseFragment('#' + pastedFragment(formatLightLink({ record: text })), '').text, text);
  assert.equal(parseFragment('#' + pastedFragment('https://hub.example/#' + encodeURIComponent(text)), '').text, text);
  assert.equal(parseFragment('#' + pastedFragment(text), '').text, text);
  assert.equal(parseFragment('#' + pastedFragment('magnet:?xt=urn:btih:' + BTIH), '').kind, 'magnet');
  for (const junk of ['', 'hello', 'https://example.com/page.html', 'javascript:alert(1)']) assert.equal(pastedFragment(junk), null, junk);
  assert.equal(parseFragment('#' + sharedFragment('?mw=' + encodeURIComponent(link)), '').text, text);
  assert.equal(parseFragment('#' + sharedFragment('?mwtext=' + encodeURIComponent('Look at this: ' + link + ' (via a friend)')), '').text, text);
  assert.equal(sharedFragment('?mwtext=nothing%20here'), null);
});

// ---------------------------------------------------------------------------------------------- app.js: door steps with a fake page

function fakeA(more = {}) {
  const banners = new Map();
  const prefs = new Map();
  const logs = [];
  const assigned = [];
  const A = Object.assign({
    mode: { mode: 'door', fragment: null, path: '/' },
    origin: 'http://127.0.0.1:9000',
    config: { version: '0.3.0' },
    win: { location: { host: '127.0.0.1:9000', href: 'http://127.0.0.1:9000/_mw/open.html', assign: (u) => assigned.push(u), reload () {} }, navigator: { language: 'en' } },
    ui: { setBanner: (id, text, opts) => banners.set(id, text ? { text, opts } : null), setDoors: (m) => { A.doorsModel = m }, setStatus () {}, showError () {} },
    deps: { cache: { getPref: async (k, d) => (prefs.has(k) ? prefs.get(k) : d), setPref: async (k, v) => { prefs.set(k, v) } }, verify: { verifyInfoHash: async (bytes, btih) => new TextDecoder().decode(bytes) === 'TORRENT ' + btih } },
    log: (l) => logs.push(l),
    btih: BTIH,
    ledgerId: 'mw1:test',
  }, more);
  A.banners = banners; A.prefs = prefs; A.logs = logs; A.assigned = assigned;
  return A;
}

test('doorCspReload: the door page reloads once into the limited-mode policy; another page that inherited it reloads back, once', () => {
  const store = new Map();
  let reloads = 0;
  const win = { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, location: { reload: () => { reloads++ } } };
  const A = fakeA({ win, boot: { cspKind: 'normal' } });
  assert.equal(__c2Doors.doorCspReload(A), true);
  assert.equal(store.get('mw:degraded'), 'door');
  assert.equal(reloads, 1);
  // the reload: boot.js started degraded; nothing more to do
  assert.equal(__c2Doors.doorCspReload(fakeA({ win, boot: { cspKind: 'degraded', forcedDegraded: true } })), false);
  // the origin's own site, later in the same tab: the flag came from a door page, so it is cleared and the page reloads normal
  const shell = fakeA({ win, mode: { mode: 'shell' }, boot: { cspKind: 'degraded', forcedDegraded: true } });
  assert.equal(__c2Doors.doorCspReload(shell), true);
  assert.equal(store.has('mw:degraded'), false);
  assert.equal(reloads, 2);
  // a real limited-mode decision (any other reason) is left alone
  store.set('mw:degraded', 'storage');
  assert.equal(__c2Doors.doorCspReload(fakeA({ win, mode: { mode: 'shell' }, boot: { cspKind: 'degraded', forcedDegraded: true } })), false);
  assert.equal(store.get('mw:degraded'), 'storage');
});

test('consentModeOf and needsGate: a door keeps one choice per site, and shows the gate until there is one', () => {
  assert.equal(__c2Doors.consentModeOf({ mode: { mode: 'door' } }), 'hub-shared');
  assert.equal(__c2Doors.consentModeOf({ mode: { mode: 'shell' } }), 'shell');
  assert.equal(__c2Doors.needsGate({ mode: { mode: 'door' }, consentState: 'pending' }), true);
  assert.equal(__c2Doors.needsGate({ mode: { mode: 'door' }, consentState: 'accepted' }), false);
});

test('doorDownloadPlan: the .torrent from the first door that serves the site and hashes right; owner doors join the web seeds', async () => {
  const owner = await newOwner();
  // org= lists the owner's own mirrors (full doors); dr= lists guest doors, which may serve the loader only.
  const rec = await hubRecord(owner, { org: ['http://127.0.0.1:9002', 'http://127.0.0.1:9003'], dr: ['127.0.0.1:9004'], xs: ['http://127.0.0.1:9001/_mw/t/' + BTIH + '.torrent'], ws: ['http://127.0.0.1:9001/ws/'] });
  const t = (port) => 'http://127.0.0.1:' + port + '/_mw/t/' + BTIH + '.torrent';
  const fetch = fakeFetch({
    [t(9001)]: new TypeError('Failed to fetch'), // the record's own xs= host is down
    [t(9002)]: bytesResponse('TORRENT ' + BTIH.replace(/^6/, '7')), // one flipped byte
    [t(9003)]: bytesResponse('TORRENT ' + BTIH),
    [t(9004)]: bytesResponse('TORRENT ' + BTIH), // a guest door: never asked
  });
  const A = fakeA({ record: rec, scope: 'btih:' + BTIH });
  A.win.fetch = fetch;
  A.doorHealth = createDoorHealth({});
  const plan = await __c2Doors.doorDownloadPlan(A, null);
  assert.equal(new TextDecoder().decode(plan.torrentFile), 'TORRENT ' + BTIH);
  assert.equal(A.doorTorrentFrom, t(9003));
  assert.equal(A.doorLastGood, '127.0.0.1:9003');
  assert.equal(A.prefs.get('doorLastGood:mw1:test'), '127.0.0.1:9003');
  assert.equal(A.doorHealth.inBackoff('127.0.0.1:9002'), true, 'wrong bytes put the door in back-off');
  // Code review v0.3 (conformance): this page's own door (9000, the light link's loader-only door) and the guest door (9004)
  // never learn which site the visitor opens: no .torrent and no web seed request names it to them.
  const asked = fetch.calls.map((c) => c.url)
  assert.ok(!asked.some((u) => u.indexOf('127.0.0.1:9000') >= 0 || u.indexOf('127.0.0.1:9004') >= 0), asked.join(' '));
  assert.ok(!asked.some((u) => u.indexOf(BTIH) >= 0 && !/:900[123]\//.test(u)), 'the btih goes only to doors that serve the site');
  assert.deepEqual(plan.record.ws, ['http://127.0.0.1:9001/ws/', 'http://127.0.0.1:9003/ws/'], 'owner doors only, the door in back-off left out');
  assert.equal(plan.record.sig, rec.sig, 'the record itself is unchanged (a copy with more web seeds)');
  assert.equal(await __c2Doors.doorDownloadPlan(fakeA({ mode: { mode: 'shell' }, record: rec }), null), null, 'only the door page');
});

test('byteDoors: owner doors, the last good door and the record\'s own ws= and xs= hosts; never a guest door, a ledger door or a hint', async () => {
  const owner = await newOwner();
  const rec = await hubRecord(owner, { org: ['https://mirror.example'], dr: ['guest.example.org'], ws: ['https://seed.example/ws/'], xs: ['https://files.example/x.torrent'] });
  const c = doorCandidates({ current: 'guest.example.org', lastGood: 'last.example.org', record: rec, ledgerDoors: ['ledger.example.org', 'seed.example'], hints: ['hint.example.org'] });
  assert.deepEqual(byteDoors(c, { record: rec }).map((x) => [x.host, x.kind]), [['last.example.org', 'last-good'], ['mirror.example', 'owner'], ['seed.example', 'ledger']]);
  assert.deepEqual(byteDoors(c, { record: null }).map((x) => x.host), ['last.example.org', 'mirror.example']);
});

test('probeThisDoor and showNotAnswering: this address fails, the banner offers the doors that answer, each a click away', async () => {
  const owner = await newOwner();
  const rec = await hubRecord(owner, { dr: ['127.0.0.1:9002', '127.0.0.1:9003'] });
  const text = formatPointer(rec);
  const A = fakeA({ record: rec, scope: 'btih:' + BTIH, resolved: { raw: text }, mode: { mode: 'door', fragment: parseFragment('#' + encodeURIComponent(text), ''), path: '/' } });
  const dj = (port) => 'http://127.0.0.1:' + port + '/_mw/door.json';
  A.win.fetch = fakeFetch({
    [dj(9000) + '|same-origin']: new TypeError('Failed to fetch'),
    [dj(9002) + '|no-cors']: new Response(null),
    [dj(9002) + '|cors']: new Response(JSON.stringify(fakeDoorJson()), { status: 200 }),
    [dj(9003) + '|no-cors']: new TypeError('Failed to fetch'),
  });
  A.doorHealth = createDoorHealth({});
  A.ownDoorJson = Object.assign({}, fakeDoorJson(), { buildId: 'aaaaaa999999' }); // kept from an earlier probe of this address
  await __c2Doors.probeThisDoor(A, 'load');
  assert.equal(A.doorDown, true);
  assert.equal(A.doorHealth.get('127.0.0.1:9002').state, 'other-build', 'compared with this door\'s own list');
  const b = A.banners.get('doors');
  assert.equal(b.text, doorText('door.notAnswering', 'en', { hosts: '127.0.0.1:9002' }));
  assert.equal(b.opts.kind, 'warn');
  assert.equal(b.opts.actions.length, 1);
  assert.equal(b.opts.actions[0].label, 'Open at 127.0.0.1:9002');
  assert.deepEqual(A.assigned, [], 'nothing navigates by itself');
  b.opts.actions[0].onClick();
  assert.equal(A.assigned[0], 'http://127.0.0.1:9002/_mw/open.html#' + encodeURIComponent(text));
  assert.deepEqual(__c2Doors.doorsInfo(A).banner, ['127.0.0.1:9002']);
  // the address answers again: the banner goes
  A.win.fetch = fakeFetch({ [dj(9000) + '|same-origin']: new Response(JSON.stringify(fakeDoorJson()), { status: 200 }) });
  await __c2Doors.probeThisDoor(A, 'visible');
  assert.equal(A.doorDown, false);
  assert.equal(A.banners.get('doors'), null);
  // a shell page with a page-tag record: only the owner's addresses (their roots) can be offered
  const S = fakeA({ mode: { mode: 'shell' }, record: rec, scope: 'example.com', resolved: { raw: text } });
  S.win.fetch = fakeFetch({ 'https://example.com/_mw/door.json|no-cors': new Response(null), 'https://example.com/_mw/door.json|cors': new TypeError('no CORS') });
  S.doorHealth = createDoorHealth({});
  await __c2Doors.showNotAnswering(S);
  const sb = S.banners.get('doors');
  assert.deepEqual(sb.opts.actions.map((a) => a.label), ['Open at example.com']);
  sb.opts.actions[0].onClick();
  assert.equal(S.assigned[0], 'https://example.com/');
});

test('refreshLedgerDoors, lightFragment and doorShareLink: the owner\'s _doors become candidates and unsigned hints of a copied link', async () => {
  const owner = await newOwner();
  const rec = await hubRecord(owner);
  const text = formatPointer(rec);
  const A = fakeA({ record: rec, scope: 'btih:' + BTIH, resolved: { raw: text }, origin: 'https://door-a.example.org', mode: { mode: 'door', fragment: null, path: '/' } });
  A.win.location.host = 'door-a.example.org';
  A.doorHealth = createDoorHealth({});
  A.node = { owner: owner.pub, state: { kv: new Map([['_doors', { v: { v: 1, d: ['ledger-door.example.org'] }, author: owner.pub, h: 'h1', ts: NOW }]]) } };
  __c2Doors.refreshLedgerDoors(A);
  assert.deepEqual(A.ledgerDoors.hosts, ['ledger-door.example.org']);
  assert.deepEqual(A.prefs.get('doorLedger:mw1:test').hosts, ['ledger-door.example.org']);
  assert.deepEqual(A.doorsModel.ledger.map((d) => d.host), ['ledger-door.example.org']);
  assert.ok(A.doorsModel.ledger[0].url.startsWith('https://ledger-door.example.org/_mw/open.html#v%3Dmw1'));
  const link = __c2Doors.doorShareLink(A, __c2Doors.doorCandidatesOf(A));
  assert.ok(link.startsWith('https://door-a.example.org/_mw/open.html#v%3Dmw1'));
  assert.match(link, /#mwd=ledger-door\.example\.org$/);
  assert.equal(A.doorsModel.link, link);
  // a moderator's _doors is hidden; a page tag (hostname scope) is not portable: no light link
  const M = fakeA({ record: rec, scope: 'btih:' + BTIH, resolved: { raw: text } });
  M.doorHealth = createDoorHealth({});
  M.node = { owner: owner.pub, state: { kv: new Map([['_doors', { v: { v: 1, d: ['m.example'] }, author: 'p256:MOD', h: 'h', ts: NOW }]]) } };
  __c2Doors.refreshLedgerDoors(M);
  assert.deepEqual(M.ledgerDoors.hosts, []);
  assert.equal(__c2Doors.lightFragment(fakeA({ scope: 'example.com', resolved: { raw: text } })), null);
});

test('persistSite on a door: the copy is stored flagged viaDoor, and door copies are evicted before any other', async () => {
  const saved = [];
  const A = fakeA({ policy: { storageBudget: 1e9 } });
  A.deps.cache = Object.assign(A.deps.cache, {
    saveSite: async (m) => { saved.push(m) }, listSites: async () => [], deleteSite: async () => {}, enforceBudget: async () => ({ evicted: [] }),
    getPref: async () => [], setPref: async () => {},
  });
  A.isLeader = false;
  A.ledgerId = 'mw1:x';
  const ok = await __c2Doors.persistSite(A, { manifest: { btih: BTIH, files: [] }, blobs: new Map() });
  assert.equal(ok, true);
  assert.equal(saved[0].viaDoor, true);
  A.mode = { mode: 'shell' };
  await __c2Doors.persistSite(A, { manifest: { btih: BTIH, files: [] }, blobs: new Map() });
  assert.equal(saved[1].viaDoor, undefined);
});

test('guardActivationWatch: the door view\'s cross-origin window cannot break the Bridge on attach', () => {
  const tracker = { watch () { throw new DOMException('Blocked a frame', 'SecurityError') } };
  __c2Doors.guardActivationWatch(tracker);
  assert.equal(typeof tracker.watch({}), 'function');
  const once = tracker.watch;
  __c2Doors.guardActivationWatch(tracker);
  assert.equal(tracker.watch, once, 'guarded once');
});

// ---------------------------------------------------------------------------------------------- Service Worker core

function swCore({ cached = {} } = {}) {
  const store = new Map(Object.entries(cached).map(([p, body]) => ['https://door.test' + p, body]));
  const fetches = [];
  const caches = {
    async match (url) { const b = store.get(typeof url === 'string' ? url : url.url); return b === undefined ? undefined : new Response(b, { headers: { 'content-type': 'text/html' } }) },
    async open () { return { match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => true } },
    async keys () { return [] }, async delete () { return true }, async has () { return false },
  };
  const core = createCore({
    buildId: 'test', precache: ['/index.html', SW_DOOR_PAGE], storage: { getSite: async () => null, listSites: async () => [], getFile: async () => null, getMeta: async () => null, setMeta: async () => {}, getDoc: async () => null, putDoc: async () => {}, deleteDoc: async () => {}, listDocs: async () => [] },
    env: { origin: 'https://door.test', caches, clients: { async get () { return null }, async matchAll () { return [] }, async claim () {} }, fetch: async (r) => { fetches.push(typeof r === 'string' ? r : r.url); return new Response('net', { status: 200 }) }, registration: { update: () => Promise.resolve() }, skipWaiting: () => Promise.resolve(), log: () => {} },
  });
  return { core, fetches };
}
function swEvent(path, { navigate = false } = {}) {
  const waits = [];
  return { request: { url: 'https://door.test' + path, method: 'GET', mode: navigate ? 'navigate' : 'cors', destination: navigate ? 'document' : '', headers: new Headers(), cache: 'default', credentials: 'include' }, clientId: '', resultingClientId: navigate ? 'door-client' : '', waitUntil (p) { waits.push(p) } };
}

test('SW core: /_mw/door.json always goes to the network; the door page comes from the precache with the shell\'s framing headers', async () => {
  assert.equal(SW_DOOR_PAGE, DOOR_PAGE_PATH);
  assert.equal(SW_DOOR_JSON, DOOR_JSON_PATH);
  const { core } = swCore({ cached: { [SW_DOOR_PAGE]: '<!doctype html><title>door</title>' } });
  assert.equal(core.owns(swEvent(SW_DOOR_JSON)), false, 'a probe of this address must reach the network');
  const ev = swEvent(SW_DOOR_PAGE, { navigate: true });
  assert.equal(core.owns(ev), true);
  const res = await core.handle(ev);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<!doctype html><title>door</title>');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  // not precached yet: the host answers
  const cold = swCore({});
  const r2 = await cold.core.handle(swEvent(SW_DOOR_PAGE, { navigate: true }));
  assert.equal(await r2.text(), 'net');
  assert.deepEqual(cold.fetches, ['https://door.test' + SW_DOOR_PAGE]);
});

test('SW core: the door page never sets this origin\'s current site (mw-set-current from it is refused)', async () => {
  const { core } = swCore({});
  const replies = [];
  const handled = core.message({ data: { proto: PROTO, type: 'mw-set-current', btih: BTIH }, source: { id: 'door-client', url: 'https://door.test' + SW_DOOR_PAGE }, ports: [{ postMessage: (m) => replies.push(m) }], waitUntil (p) { this.p = p } });
  assert.equal(handled, true);
  await sleep(20);
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error, 'door-page');
  assert.equal(core.inspect().current, null);
});

// ---------------------------------------------------------------------------------------------- strings and the Doors panel

test('DOOR_TEXT: the same keys in English and French, the sentences of S4 D4 and D5, the wording rules', () => {
  assert.deepEqual(Object.keys(DOOR_TEXT.fr).sort(), Object.keys(DOOR_TEXT.en).sort());
  assert.equal(DOOR_TEXT.en['door.view'], 'This address can show the site but cannot store anything for it.');
  assert.equal(doorText('door.notAnswering', 'en', { hosts: 'b.example, c.example' }), 'This address is not answering. The owner lists: b.example, c.example.');
  assert.equal(doorText('door.notAnswering', 'fr-CA', { hosts: 'b.example' }), 'Cette adresse ne répond pas. Le propriétaire indique : b.example.');
  assert.equal(doorText('door.nope'), '');
  for (const lang of ['en', 'fr']) {
    for (const [k, v] of Object.entries(DOOR_TEXT[lang])) {
      assert.doesNotMatch(v, /blockchain|serverless|unstoppable|censorship|production-ready|[\u2013\u2014\u2018\u2019\u201c\u201d]/i, lang + ' ' + k);
      assert.doesNotMatch(v, /reroute|automatically|always available/i, lang + ' ' + k + ': no promise that a link moves by itself');
    }
  }
  assert.equal(doorStateText('other-build'), 'answering, another loader version');
  assert.equal(doorStateText('weird'), 'not checked');
});

test('createDoorsUi: the Doors section lists the doors with plain links, and "Copy link with doors" acts on a trusted click', () => {
  const doc = new FakeDocument();
  const ui = createDoorsUi({ doc, lang: 'en' });
  const actions = [];
  ui.onAction((a, p) => actions.push([a, p]));
  assert.equal(ui.node.hidden, true);
  ui.setModel({
    shown: true, current: { host: 'door-a.example', state: 'down' }, lastGood: { host: 'door-c.example' },
    owner: [{ host: 'example.com', state: 'up', url: 'https://example.com/' }], guest: [{ host: 'door-b.example', state: null, url: 'https://door-b.example/_mw/open.html#v%3D' }],
    ledger: [], hint: [], link: 'https://door-a.example/_mw/open.html#v%3D', build: { version: '0.3.0', id: 'abcdef123456' },
  });
  assert.equal(ui.node.hidden, false);
  const text = ui.node.textContent;
  assert.match(text, /This address: door-a\.example \(not answering\)/);
  assert.match(text, /Last loaded from: door-c\.example/);
  assert.match(text, /The owner's addresses/);
  assert.match(text, /Doors the owner signed/);
  assert.match(text, /Loader 0\.3\.0, build abcdef123456/);
  const links = ui.node.findAll((n) => n.tagName === 'A');
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://example.com/', 'https://door-b.example/_mw/open.html#v%3D']);
  assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
  ui.nodes.copyBtn.dispatchEvent({ type: 'click', isTrusted: false });
  assert.deepEqual(actions, [], 'a script click does nothing');
  ui.nodes.copyBtn.dispatchEvent({ type: 'click', isTrusted: true });
  assert.deepEqual(actions, [['copyDoorLink', { link: 'https://door-a.example/_mw/open.html#v%3D' }]]);
  ui.setModel({ shown: true, owner: [], guest: [], ledger: [], hint: [], link: 'L', copied: false });
  assert.equal(ui.nodes.linkText.hidden, false);
  assert.equal(ui.nodes.linkText.value, 'L');
  assert.match(ui.node.textContent, /No other address is known for this site\./);
  ui.setModel({ shown: true, link: null });
  assert.equal(ui.nodes.copyBtn.disabled, true);
});

// ---------------------------------------------------------------------------------------------- build.mjs

test('build: the door page links the door manifest; only the door manifest has protocol_handlers, share_target and launch_handler', () => {
  const site = JSON.parse(manifestJson('0.3.0'));
  assert.equal(site.protocol_handlers, undefined);
  assert.equal(site.share_target, undefined);
  const door = JSON.parse(doorManifestJson('0.3.0'));
  assert.deepEqual(door.protocol_handlers, [{ protocol: 'web+felinar', url: '/_mw/open.html#%s' }]);
  assert.equal(door.share_target.action, '/_mw/open.html');
  assert.equal(door.share_target.method, 'GET');
  assert.deepEqual(door.launch_handler, { client_mode: 'navigate-existing' });
  assert.equal(door.id, '/_mw/open.html');
  assert.equal(door.scope, '/_mw/');
  assert.doesNotMatch(JSON.stringify(door), /serverless|blockchain|unstoppable|censorship/i);
  const shell = '<head><link rel="manifest" href="/_mw/manifest.webmanifest"><script src="/_mw/boot.js" integrity="sha384-x"></script></head>';
  assert.equal(doorPageHtml(shell), '<head><link rel="manifest" href="/_mw/door.webmanifest"><script src="/_mw/boot.js" integrity="sha384-x"></script></head>');
  assert.throws(() => doorPageHtml('<head></head>'), /exactly once/);
  assert.deepEqual(precacheList(['index.html', '_mw/open.html', '_mw/door.json', '_mw/door-frame.js']), ['/index.html', '/_mw/door-frame.js', '/_mw/open.html'], 'door.json is never precached');
  const outputs = new Map([['index.html', Buffer.from('a')], ['_mw/open.html', Buffer.from('b')], [DOOR_JSON, Buffer.from('old')], ['build.json', Buffer.from('{}')]]);
  const dj = JSON.parse(doorJson(outputs, { version: '0.3.0', buildId: 'abc123def456' }).toString('utf8'));
  assert.deepEqual(Object.keys(dj.files), ['/_mw/open.html', '/index.html']);
  assert.equal(dj.files['/index.html'].sha256, createHash('sha256').update('a').digest('hex'));
  assert.match(dj.files['/index.html'].sri, /^sha384-/);
});

// The door view in real browsers moved to test/unit/loader-doors-browser.test.mjs (C2 integrator, the doors lane's request 6), so
// `npm run test:browser` runs it.

test('a withdrawal opened at a door deletes that ledger\'s versions only, never the other copies the door holds (or its own site)', async () => {
  const { __test } = await import('../../src/loader/app.js');
  const deleted = [];
  const mk = (mode) => ({
    mode: { mode }, ledgerId: 'mw1:withdrawn', log () {},
    record: { st: 'withdrawn', btih: '0'.repeat(40), withdrawn: true },
    ui: { setStatus () {}, showError () {} }, win: {},
    deps: { cache: {
      getPref: async (k) => (k === 'versions:mw1:withdrawn' ? ['a'.repeat(40)] : []),
      listSites: async () => [{ btih: 'a'.repeat(40) }, { btih: 'b'.repeat(40) }, { btih: 'c'.repeat(40) }],
      deleteSite: async (b) => { deleted.push(b) },
    } },
  });
  await __test.presentWithdrawal(mk('door'), { askFirst: false });
  assert.deepEqual(deleted, ['a'.repeat(40)]);
  deleted.length = 0;
  await __test.presentWithdrawal(mk('shell'), { askFirst: false });
  assert.deepEqual(deleted.sort(), ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], 'a shell origin holds one site: every version goes, as before');
});
