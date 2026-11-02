// Unit tests for the usage-report wiring of the loader (plan obs-2026-11-02, lane L2 loader-hooks; docs/OBSERVABILITY.md):
//   - doors.js: the obs block of /_mw/door.json (checkObsBlock, obsBlockOf, obsBlockProblem, checkDoorJson) and consent.js: the report
//     host in the recipients key;
//   - the strings of the card, the gate and Settings, in English and French;
//   - ui.js: the host named on the first-run card and the gate, the Settings switch and the Diagnostics line, the banner and diagnostics
//     events, and the delegated listener inside the closed root of the cards (call-ui.js: of the call panel);
//   - app.js: the block read on the bare door page and on a site's shell page (one request), no reporter and no network call without a block,
//     the reporter gated by the visitor's choice (allow on "Share and load", allow(false) on "Load from host only", the Settings switch),
//     window.__mwShell.inspect().obs, the delegated click, change and submit listener on the fake DOM, the log ring mirrored line by line (and
//     scrubbed), the apps' report options, the peer connection wrapper beside the offer-timeout wrapper and the calls' unwrap;
//   - torrent.js and api.js: the report option and what it reports.
// The reporter is the real one of src/loader/obs.js, with an injected send, so a test never reaches a network. Run:
//   node --test test/unit/loader-app-obs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FakeNode, FakeDocument } from './dropin-fake-dom.mjs';
import * as appModule from '../../src/loader/app.js';
import { createReporter, describeTarget } from '../../src/loader/obs.js';
import {
  doorJsonFor, checkDoorJson, checkObsBlock, obsBlockOf, obsBlockProblem, obsHostOf
} from '../../src/loader/doors.js';
import { recipientsKey, makeConsentRecord, consentFromRecord } from '../../src/loader/consent.js';
import { CONFIG } from '../../src/loader/config.js';
import { STRINGS, STRINGS_FR, UI_TEXT, uiText, stringsFor, fmt } from '../../src/loader/strings.js';
import { createUI, createCards } from '../../src/loader/ui.js';
import { createCallUi } from '../../src/loader/call-ui.js';
import { TorrentManager } from '../../src/loader/torrent.js';
import { MwApi } from '../../src/loader/api.js';
import { installOfferTimeout } from '../../src/loader/connectivity.js';
import { wrapPeerConnection } from '../../src/loader/obs.js';

const { __obs, __apps, __test, __c2WireUi, nativeRtc } = appModule;

const OBS_BLOCK = { endpoint: 'https://obs.example.test' };
const APPS_BLOCK = { rendezvous: ['wss://rendezvous.example.test/announce'], stun: ['stun:stun.example.test:3478'], idp: 'https://id.example.test' };
const BTIH = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const flush = () => new Promise((resolve) => setImmediate(resolve));
// An em dash, an en dash, a curly quote or an ellipsis: built from code points, so that this file itself holds none of them.
const DASHES = new RegExp('[' + [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026].map((c) => String.fromCharCode(c)).join('') + ']');

// ---- fakes: a door.json, a DOM with classList, a window ----------------------------------------------------------------

function doorJsonWith(extra = {}) {
  const files = ['/_mw/open.html', '/_mw/loader.js', '/mw-sw.js', '/_mw/boot.js'].map((path) => {
    const bytes = Buffer.from('bytes of ' + path);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sri: 'sha384-' + createHash('sha384').update(bytes).digest('base64') };
  });
  return Object.assign(doorJsonFor({ version: '0.3.0', buildId: 'abcdef123456', files }), extra);
}

function fetchOf(json, { status = 200, fail = false } = {}) {
  const seen = [];
  const f = async (url, init) => {
    seen.push([url, init]);
    if (fail) throw new TypeError('offline');
    const bytes = new TextEncoder().encode(typeof json === 'string' ? json : JSON.stringify(json));
    return { status, headers: { get: () => String(bytes.length) }, body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  f.seen = seen;
  return f;
}

class DomNode extends FakeNode {
  get classList() {
    const node = this;
    const list = () => String(node.className || '').split(/\s+/).filter(Boolean);
    const add = (...c) => { node.className = Array.from(new Set(list().concat(c))).join(' '); };
    const remove = (...c) => { node.className = list().filter((x) => c.indexOf(x) < 0).join(' '); };
    return {
      add,
      remove,
      toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want !== has) { if (want) add(c); else remove(c); } return want; },
      contains: (c) => list().indexOf(c) >= 0,
    };
  }
  get dataset() { if (!this._data) this._data = {}; return this._data; }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.find((n) => n.getAttribute && n.getAttribute('id') === sel.slice(1)) || null;
    return this.find((n) => String(n.className || '').split(/\s+/).some((c) => sel.split(',').some((s) => s.trim() === '.' + c))) || null;
  }
}
class DomDocument extends FakeDocument {
  createElement(tag, attrs = null) {
    const el = new DomNode(tag, this);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  }
}

/** Every network path a usage report could take, as spies: the global fetch and sendBeacon, and the fake window's own fetch. */
function networkSpies() {
  const calls = { fetch: [], beacon: [] };
  const realFetch = globalThis.fetch;
  const nav = globalThis.navigator;
  const had = nav && Object.prototype.hasOwnProperty.call(nav, 'sendBeacon');
  globalThis.fetch = (...a) => { calls.fetch.push(a); return Promise.reject(new TypeError('no network in this test')); };
  if (nav) Object.defineProperty(nav, 'sendBeacon', { value: (...a) => { calls.beacon.push(a); return true; }, configurable: true, writable: true });
  calls.restore = () => {
    globalThis.fetch = realFetch;
    if (nav && !had) delete nav.sendBeacon;
  };
  return calls;
}

/** A recording send for the reporter: batches[i] is the parsed body of the i-th POST. */
function sender() {
  const sent = [];
  const send = (url, text, opts) => { sent.push({ url, text, batch: JSON.parse(text), final: !!(opts && opts.final) }); return true; };
  send.sent = sent;
  send.events = () => sent.flatMap((s) => s.batch.events);
  send.names = () => send.events().map((e) => e.n);
  return send;
}

/** drain(reporter): flush until nothing waits (one flush sends one batch, and a batch holds events that share the sign-in and the network). */
function drain(reporter) {
  for (let i = 0; i < 50 && reporter.inspect().queued > 0; i++) reporter.flush('test');
}

/** The parts of a page that the usage-report steps of app.js touch, with the fakes of the loader's UI and API (as in loader-apps-ui). */
function pageOf(over = {}) {
  const logs = [];
  const doc = new DomDocument();
  const rootEl = doc.createElement('div');
  rootEl.setAttribute('id', 'mw-root');
  doc.body.appendChild(rootEl);
  doc.getElementById = (id) => (id === 'mw-root' ? rootEl : null);
  const listeners = [];
  const settingsCalls = [];
  const ui = {
    root: rootEl,
    diagnostics: { lines: () => logs.map((l) => '12:00:00.000 ' + l) },
    settings: {
      setReports: (m) => settingsCalls.push(m),
      onChange: (fn) => { ui.settingsHandler = fn; },
    },
    setStatus() {},
    setIdentity() {},
    setPeers() {},
    showApps(n) { rootEl.appendChild(n); },
    hideApps() {},
    showLinkPaste() {},
    download: () => true,
    prompt: () => Promise.resolve(true),
  };
  const api = {
    identity: { onChange: (fn) => { listeners.push(fn); return () => {}; }, info: () => null, keys: () => null, state: () => 'guest' },
    service: (name) => (name === 'identity' ? { methods: {} } : null),
    openSignInCard: async () => true,
    setTorrentManager() {},
  };
  const A = Object.assign({
    win: {
      fetch: fetchOf(doorJsonWith({ apps: APPS_BLOCK, obs: OBS_BLOCK })),
      location: { origin: 'https://door.test', search: '', pathname: '/_mw/open', hash: '' },
      navigator: { language: 'en-CA' },
      addEventListener() {},
      console: { error() {}, warn() {} },
    },
    doc, ui, api, origin: 'https://door.test', webrtc: true, hasSw: false, prefs: { share: true, reports: 'on' }, config: CONFIG,
    mode: { mode: 'door', fragment: null }, boot: { soft: { webrtc: true }, missing: [], polyfilled: [], t0: Date.now() - 5, stage: 'import', cspKind: 'degraded' },
    consentState: 'pending',
    log: (line) => logs.push(line),
  }, over);
  return { A, logs, ui, api, listeners, doc, rootEl, settingsCalls };
}

// ---- doors.js: the obs block ---------------------------------------------------------------------------------------------

test('checkObsBlock: an exact https origin, or http on a loopback host; the same strictness as the apps block\'s identity origin', () => {
  const ok = (endpoint) => checkObsBlock({ endpoint });
  assert.deepEqual(ok('https://obs.example.test').block, { endpoint: 'https://obs.example.test' });
  assert.equal(ok('https://obs.example.test').reason, null);
  assert.deepEqual(ok('https://felinar-obs.pages.dev').block, { endpoint: 'https://felinar-obs.pages.dev' });
  assert.deepEqual(ok('https://obs.example.test:8443').block, { endpoint: 'https://obs.example.test:8443' });
  for (const dev of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://obs.localhost:9000']) assert.equal(ok(dev).reason, null, dev);
  const why = (endpoint) => checkObsBlock({ endpoint }).reason;
  assert.equal(why('http://obs.example.test'), 'obs-endpoint-insecure', 'http on a host that is not loopback');
  assert.equal(why('http://203.0.113.5:8787'), 'obs-endpoint-insecure');
  for (const bad of [
    'https://obs.example.test/', 'https://obs.example.test/e', 'https://obs.example.test?x=1', 'https://obs.example.test#frag',
    'https://user:pw@obs.example.test', 'https://user@obs.example.test', ' https://obs.example.test', 'https://obs.example.test ', 'https://OBS.example.test',
    'https://obs.example.test:443', 'wss://obs.example.test', 'ftp://obs.example.test', 'obs.example.test', '', 'https://', 'javascript:alert(1)',
    'https://' + 'a'.repeat(300) + '.test'
  ]) assert.equal(why(bad), 'obs-endpoint', JSON.stringify(bad.slice(0, 40)));
  for (const notString of [undefined, null, 5, true, {}, [], ['https://obs.example.test']]) assert.equal(checkObsBlock({ endpoint: notString }).reason, 'obs-endpoint');
  for (const notObject of [null, undefined, 'https://obs.example.test', 5, true, []]) assert.equal(checkObsBlock(notObject).reason, 'obs-shape');
  assert.equal(checkObsBlock({}).reason, 'obs-endpoint', 'a block with no endpoint');
  const out = checkObsBlock({ endpoint: 'https://obs.example.test', extra: 'ignored', more: [1] }).block;
  assert.deepEqual(out, { endpoint: 'https://obs.example.test' }, 'unknown keys are ignored');
  assert.ok(Object.isFrozen(out), 'the result is frozen');
  assert.equal(obsHostOf(out), 'obs.example.test');
  assert.equal(obsHostOf(checkObsBlock({ endpoint: 'https://obs.example.test:8443' }).block), 'obs.example.test', 'the host name, not the port');
  assert.equal(obsHostOf(null), null);
  assert.equal(obsHostOf({}), null);
  // the page's own host: http on a loopback host is for a page that is itself on one; https and the tools' check (no page) are as before
  for (const dev of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://obs.localhost:9000']) {
    assert.equal(checkObsBlock({ endpoint: dev }, { pageHost: 'site.example' }).reason, 'obs-endpoint-insecure', dev + ' from a page elsewhere');
    assert.equal(checkObsBlock({ endpoint: dev }, { pageHost: '' }).reason, 'obs-endpoint-insecure', dev + ' from a page of no known host');
    assert.equal(checkObsBlock({ endpoint: dev }, { pageHost: 'localhost:3000' }).reason, null, dev + ' from a page on loopback');
    assert.equal(checkObsBlock({ endpoint: dev }, { pageHost: 5 }).reason, null, 'a page host that is not text is no page given');
    assert.equal(checkObsBlock({ endpoint: dev }, null).reason, null);
  }
  assert.equal(checkObsBlock({ endpoint: 'https://obs.example.test' }, { pageHost: 'site.example' }).reason, null);
  assert.equal(obsBlockOf({ obs: { endpoint: 'http://localhost:8787' } }, { pageHost: 'site.example' }), null);
  assert.equal(obsBlockProblem({ obs: { endpoint: 'http://localhost:8787' } }, { pageHost: 'site.example' }), 'obs-endpoint-insecure');
  assert.deepEqual(obsBlockOf({ obs: { endpoint: 'http://localhost:8787' } }, { pageHost: '127.0.0.1:8080' }), { endpoint: 'http://localhost:8787' });
});

test('obsBlockOf and obsBlockProblem read a parsed door.json: no block is no problem, a bad one is null and says why', () => {
  assert.deepEqual(obsBlockOf({ obs: OBS_BLOCK }), OBS_BLOCK);
  for (const none of [null, undefined, {}, [], 'x', { obs: null }, { obs: undefined }, { other: OBS_BLOCK }]) {
    assert.equal(obsBlockOf(none), null);
    assert.equal(obsBlockProblem(none), null, 'no block: no problem');
  }
  assert.equal(obsBlockProblem({ obs: OBS_BLOCK }), null);
  assert.equal(obsBlockOf({ obs: { endpoint: 'http://obs.example.test' } }), null);
  assert.equal(obsBlockProblem({ obs: { endpoint: 'http://obs.example.test' } }), 'obs-endpoint-insecure');
  assert.equal(obsBlockProblem({ obs: 'https://obs.example.test' }), 'obs-shape');
  assert.equal(obsBlockProblem({ obs: { endpoint: 'https://obs.example.test/x' } }), 'obs-endpoint');
});

test('checkDoorJson: an obs block rides along as obs, beside apps; a bad block never decides ok; a door.json without either keeps exactly its five fields', () => {
  const plain = doorJsonWith();
  assert.deepEqual(Object.keys(checkDoorJson(plain)), ['ok', 'sameBuild', 'buildId', 'version', 'reason']);
  const r = checkDoorJson(doorJsonWith({ obs: OBS_BLOCK }), plain);
  assert.deepEqual(r.obs, OBS_BLOCK);
  assert.equal(r.ok, true);
  assert.equal(r.obsReason, undefined);
  assert.equal(r.apps, undefined);
  const both = checkDoorJson(doorJsonWith({ obs: OBS_BLOCK, apps: APPS_BLOCK }));
  assert.deepEqual(both.obs, OBS_BLOCK);
  assert.deepEqual(both.apps, APPS_BLOCK);
  const bad = checkDoorJson(doorJsonWith({ obs: { endpoint: 'http://obs.example.test' } }));
  assert.equal(bad.ok, true, 'the loader is still served');
  assert.equal(bad.obs, null);
  assert.equal(bad.obsReason, 'obs-endpoint-insecure');
  assert.deepEqual(Object.keys(checkDoorJson(doorJsonWith({ obs: null }))), ['ok', 'sameBuild', 'buildId', 'version', 'reason'], 'null is no block');
  assert.equal(checkDoorJson({ v: 1, kind: 'felinar-door', obs: OBS_BLOCK }).ok, false, 'the block does not make a file a door');
});

// ---- consent.js: the report host in the recipients ----------------------------------------------------------------------

test('recipientsKey: without an obs host it is what it always was; with one the key names it, so a visitor who agreed before is asked again', () => {
  const record = { signed: true, tr: ['wss://t.example/announce'] };
  const before = recipientsKey(record, CONFIG);
  assert.equal(recipientsKey(record, CONFIG, null), before);
  assert.equal(recipientsKey(record, CONFIG, {}), before);
  assert.equal(recipientsKey(record, CONFIG, { obsHost: null }), before);
  assert.equal(recipientsKey(record, CONFIG, { obsHost: '' }), before);
  assert.equal(recipientsKey(record), recipientsKey(record, CONFIG), 'the drop-in runtime calls it with two arguments or one');
  const after = recipientsKey(record, CONFIG, { obsHost: 'Obs.Example.Test' });
  assert.notEqual(after, before);
  assert.ok(after.split(',').includes('obs:obs.example.test'), after);
  assert.deepEqual(after.split(','), after.split(',').slice().sort(), 'sorted like the rest');
  assert.ok(before.split(',').every((h) => after.split(',').includes(h)), 'the trackers and STUN servers are still named');
  // A choice stored before the site had a report block: asked again for "Share and load", not for "Load from host only".
  const accepted = makeConsentRecord({ choice: 'accepted', rcpt: before, config: CONFIG });
  assert.equal(consentFromRecord(accepted, { rcpt: before, config: CONFIG }), 'accepted');
  assert.equal(consentFromRecord(accepted, { rcpt: after, config: CONFIG }), 'pending', 'the card comes back, naming the host');
  const hostOnly = makeConsentRecord({ choice: 'host-only', rcpt: before, config: CONFIG });
  assert.equal(consentFromRecord(hostOnly, { rcpt: after, config: CONFIG }), 'host-only', 'a choice that sends nothing is not asked again');
  const again = makeConsentRecord({ choice: 'accepted', rcpt: after, config: CONFIG });
  assert.equal(consentFromRecord(again, { rcpt: after, config: CONFIG }), 'accepted');
  assert.equal(consentFromRecord(again, { rcpt: before, config: CONFIG }), 'pending', 'the owner took the block away: asked again too, as for any change of recipients');
  assert.equal(CONFIG.consent.version, 2, 'consent.version is not raised: a site without the block must not ask again');
  // rcptOf(A) is that key on a page.
  assert.equal(__obs.rcptOf({ record, config: CONFIG, obsHost: null }), before);
  assert.equal(__obs.rcptOf({ record, config: CONFIG, obsHost: 'obs.example.test' }), recipientsKey(record, CONFIG, { obsHost: 'obs.example.test' }));
});

// ---- strings ---------------------------------------------------------------------------------------------------------------

test('the strings of the card, the gate and Settings: English ASCII, French too, the host named, and the wording rules of the plan', () => {
  const keys = ['consentReports', 'gateReports'];
  for (const k of keys) {
    assert.equal(typeof STRINGS[k], 'string', k);
    assert.equal(typeof STRINGS_FR[k], 'string', k + ' fr');
    assert.ok(STRINGS[k].includes('{host}') && STRINGS_FR[k].includes('{host}'), k + ' names the host');
    assert.equal((STRINGS[k].match(/\{host\}/g) || []).length, (STRINGS_FR[k].match(/\{host\}/g) || []).length, k + ' same placeholders');
    assert.match(fmt(STRINGS[k], { host: 'obs.example.test' }), /obs\.example\.test/);
    assert.ok(!/\{[a-z]+\}/.test(fmt(STRINGS[k], { host: 'h' })) && !/\{[a-z]+\}/.test(fmt(STRINGS_FR[k], { host: 'h' })), 'all placeholders filled');
    assert.equal(stringsFor('fr-CA')[k], STRINGS_FR[k]);
    assert.equal(stringsFor('en-CA')[k], STRINGS[k]);
  }
  const uiKeys = ['settingsReportsLabel', 'settingsReportsNote', 'reportsDebug', 'reportsStateSending', 'reportsStateWaiting', 'reportsStateOff'];
  const ph = (s) => (s.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');
  for (const k of uiKeys) {
    assert.equal(typeof UI_TEXT.en[k], 'string', k);
    assert.equal(typeof UI_TEXT.fr[k], 'string', k + ' fr');
    assert.equal(ph(UI_TEXT.en[k]), ph(UI_TEXT.fr[k]), k + ' same placeholders');
  }
  assert.equal(uiText('settingsReportsLabel', 'en', { host: 'obs.example.test' }), 'Send usage reports to obs.example.test');
  assert.equal(uiText('settingsReportsLabel', 'fr', { host: 'obs.example.test' }), 'Envoyer des rapports d\'utilisation à obs.example.test');
  assert.deepEqual(Object.keys(UI_TEXT.en).sort(), Object.keys(UI_TEXT.fr).sort());
  const english = keys.map((k) => STRINGS[k]).concat(uiKeys.map((k) => UI_TEXT.en[k]));
  const french = keys.map((k) => STRINGS_FR[k]).concat(uiKeys.map((k) => UI_TEXT.fr[k]));
  for (const text of english) assert.match(text, /^[\x20-\x7e]+$/, 'English strings are ASCII: ' + text.slice(0, 40));
  const banned = [/blockchain/i, /serverless/i, /unstoppable/i, /censorship[- ]resistant/i, /production[- ]ready/i, /fully decentralized/i, /sub-second/i, /\bonline\b/i, /\ben ligne\b/i, /\berase|effacer/i];
  for (const text of english.concat(french)) {
    for (const re of banned) assert.doesNotMatch(text, re, text.slice(0, 50));
    assert.doesNotMatch(text, DASHES, 'no dash, curly quote or ellipsis: ' + text.slice(0, 50));
  }
  // The disclosure says what is sent, what is not, who can see the address, and how to stop it.
  for (const text of [STRINGS.consentReports, STRINGS.gateReports]) {
    assert.match(text, /[Uu]sage reports/);
    assert.match(text, /no messages, names or passphrases/);
    assert.match(text, /can see your IP address/);
    assert.match(text, /Settings/);
  }
});

// ---- the helpers of app.js: what a report may carry --------------------------------------------------------------------------

test('reportableText: a URL keeps its scheme and host, an infohash its first 8 characters, a ledger id or a key its tag and 4; nothing else of them', () => {
  const t = __obs.reportableText;
  assert.equal(t('tracker wss://tracker.example:443/announce open'), 'tracker wss://tracker.example open');
  assert.equal(t('status downloading https://host.example/_mw/ws/site-name/secret-file.html?token=abc#frag'), 'status downloading https://host.example');
  assert.equal(t('https://user:pw@host.example:8080/x'), 'https://host.example');
  assert.equal(t('http://[::1]:8080/x and http://203.0.113.5:9000/y'), 'http://[::1] and http://203.0.113.5', 'the reporter masks an address after this');
  assert.equal(t('pointer shell btih=' + BTIH + ' ledger=btih:' + BTIH), 'pointer shell btih=ab12cd34... ledger=btih:ab12cd34...');
  assert.equal(t('hash ' + 'f'.repeat(64)), 'hash ffffffff...');
  assert.equal(t('hub label ' + 'abcdefghijklmnopqrstuvwxyz234567'), 'hub label abcdefgh...');
  assert.equal(t('ledger=mw1:AbCdEfGhIjKlMnOpQrStUvWxYz1'), 'ledger=mw1:AbCd...');
  assert.equal(t('lo=p256:BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'lo=p256:BAAA...');
  assert.equal(t('ICE servers stun:stun.cloudflare.com:3478 stun:global.stun.twilio.com:3478'), 'ICE servers stun:stun.cloudflare.com stun:global.stun.twilio.com', 'a host name keeps no port');
  assert.equal(t('peer 203.0.113.5:51234 answered at 12:30:45 on tracker.example:8443'), 'peer 203.0.113.5 answered at 12:30:45 on tracker.example', 'nor an address; a clock is not a port');
  assert.equal(t('plain words and 12 numbers 123456789012'), 'plain words and 12 numbers 123456789012');
  assert.equal(t(undefined), '');
  assert.equal(t(null), '');
  assert.equal(t('x'.repeat(1000)).length, 300);
  assert.equal(t(new Error('boom')), 'Error: boom');
});

test('codeWord: a short code stays, any other text is "error", nothing is null', () => {
  assert.equal(__obs.codeWord('E_NO_PEERS'), 'E_NO_PEERS');
  assert.equal(__obs.codeWord('no-service-worker'), 'no-service-worker');
  assert.equal(__obs.codeWord('Failed to register a ServiceWorker for scope https://x/'), 'error');
  assert.equal(__obs.codeWord(''), null);
  assert.equal(__obs.codeWord(null), null);
  assert.equal(__obs.codeWord(undefined), null);
  assert.equal(__obs.codeWord('x'.repeat(41)), 'error');
});

// ---- app.js: the whole page up to the first card, on a fake window --------------------------------------------------------------
//
// The hub root (a wildcard hub's landing page, no link) is the shortest path through run(): the loader reads door.json beside its own modules,
// creates the reporter when there is a block, and stops with its landing text. Each run is a fresh instance of app.js (a query string on its
// URL), because start() runs once per module instance.

let instance = 0;
async function runHub({ json = doorJsonWith({ obs: OBS_BLOCK }), obs = {}, fetchFail = false, boot = {}, lang = 'en-CA' } = {}) {
  const doc = new DomDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'mw-root');
  doc.body.appendChild(root);
  doc.getElementById = (id) => (id === 'mw-root' ? root : null);
  const meta = doc.createElement('meta');
  meta.setAttribute('content', 'subdomain');
  doc.querySelector = (sel) => (sel === 'meta[name="mw-hub"]' ? meta : null);
  const store = new Map();
  const events = new Map();
  const win = {
    document: doc,
    location: { origin: 'https://hub.example.test', protocol: 'https:', host: 'hub.example.test', hostname: 'hub.example.test', port: '', pathname: '/', search: '', hash: '', href: 'https://hub.example.test/' },
    navigator: { language: lang, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' },
    fetch: fetchOf(json, { fail: fetchFail }),
    addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    console: { error() {}, warn() {}, log() {} },
    crypto: globalThis.crypto,
    __mwBoot: Object.assign({ ok: true, stage: 'import', soft: { webrtc: false, serviceWorker: false }, features: {}, missing: [], polyfilled: ['toHex'], t0: Date.now() - 40, csp: 'normal', cspKind: 'normal', degraded: false, dev: false, swProbe: null }, boot),
  };
  doc.defaultView = win;
  win.events = events;
  const send = sender();
  const mod = await import('../../src/loader/app.js?obs-run-' + (++instance));
  const A = await mod.default({ window: win, obs: Object.assign({ send, random: () => 0.5 }, obs) });
  return { A, win, doc, root, send, mod, events };
}

const field = (root, id) => root.find((n) => n.getAttribute && n.getAttribute('id') === id);
const batchOf = (send) => send.sent.map((s) => s.batch);

test('a host whose door.json has an obs block: the page has a reporter, named after the endpoint, and nothing leaves before the visitor chooses', async () => {
  const spies = networkSpies();
  try {
    const { A, win, send } = await runHub();
    assert.ok(A.obs, 'the reporter exists');
    assert.equal(A.obsHost, 'obs.example.test');
    assert.equal(win.fetch.seen.length, 1, 'door.json was read once');
    const [url, init] = win.fetch.seen[0];
    assert.equal(url, 'https://hub.example.test/_mw/door.json');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    const seen = win.__mwShell.inspect().obs;
    assert.equal(seen.host, 'obs.example.test');
    assert.equal(seen.enabled, true);
    assert.equal(seen.allowed, false, 'no choice yet: the events wait in memory');
    assert.ok(seen.queued >= 5, 'boot, run.start and the log lines wait: ' + seen.queued);
    assert.equal(seen.sent, 0);
    assert.equal(seen.dropped, 0);
    assert.deepEqual(Object.keys(seen).sort(), ['allowed', 'batches', 'dropped', 'enabled', 'host', 'lastOk', 'queued', 'sent']);
    A.obs.flush('test');
    assert.equal(send.sent.length, 0, 'flushing before the yes sends nothing');
    assert.equal(spies.fetch.length + spies.beacon.length, 0, 'no fetch, no beacon');
  } finally { spies.restore(); }
});

test('a host without an obs block has no reporter, and not one fetch or beacon beyond the one read of its own door.json', async () => {
  const spies = networkSpies();
  try {
    for (const json of [doorJsonWith(), doorJsonWith({ apps: APPS_BLOCK }), doorJsonWith({ obs: null })]) {
      const { A, win, send, root } = await runHub({ json });
      assert.equal(A.obs, null);
      assert.equal(A.obsHost, null);
      assert.equal(win.__mwShell.inspect().obs, null);
      assert.equal(win.fetch.seen.length, 1, 'only door.json, once');
      assert.equal(win.fetch.seen[0][0], 'https://hub.example.test/_mw/door.json');
      A.log('a line, an address 203.0.113.5 and a click');
      A.report('ui.click', { id: 'x' });
      root.dispatchEvent({ type: 'click', target: root, isTrusted: true });
      assert.equal(field(root, 'mw-reports').parentNode.parentNode.hidden, true, 'no Settings switch without a report endpoint');
      assert.equal(field(root, 'mw-reports').disabled, true);
      assert.equal(send.sent.length, 0);
    }
    // A bad block is no block: the page says why in its log and sends nothing.
    const bad = await runHub({ json: doorJsonWith({ obs: { endpoint: 'http://obs.example.test' } }) });
    assert.equal(bad.A.obs, null);
    assert.ok(bad.A.ui.diagnostics.lines().some((l) => l.includes('usage-report block') && l.includes('obs-endpoint-insecure') && l.includes('no usage reports')));
    // No door.json to read (offline, a block page): no reporter either.
    for (const over of [{ fetchFail: true }, { json: '<html>blocked</html>' }]) {
      const none = await runHub(over);
      assert.equal(none.A.obs, null);
    }
    assert.equal(spies.fetch.length + spies.beacon.length, 0, 'the global fetch and sendBeacon were never called');
  } finally { spies.restore(); }
});

// ---- the visitor's choice decides whether the reports go ------------------------------------------------------------------------

/** What setConsent needs of a page that stopped at the hub root: the environment of a computer, and a deps.cache that stores nothing. */
async function consentPage(opts) {
  const run = await runHub(opts);
  const { A } = run;
  const { detectEnvironment } = await import('../../src/loader/policy.js');
  A.env = detectEnvironment({ battery: null });
  A.record = null;
  A.deps.cache = Object.assign({}, A.deps.cache, { setPref: async (k, v) => { A.stored = A.stored || {}; A.stored[k] = v; }, getPref: async (k, d) => d, requestPersist: async () => true });
  A.deps = Object.assign({}, A.deps, { cache: A.deps.cache });
  __obs.installSettings(A); // what the full page does after its pointer: the Settings handler of changeSetting, and the usage-report switch
  return run;
}

test('"Share and load" lets the reports go: what waited in memory goes first, then consent.set, then what comes after', async () => {
  const spies = networkSpies();
  try {
    const { A, send } = await consentPage();
    assert.equal(A.obs.inspect().allowed, false);
    await __obs.setConsent(A, 'accepted');
    assert.equal(A.consentState, 'accepted');
    assert.equal(A.obs.inspect().allowed, true);
    A.log('after the yes');
    A.obs.flush('test');
    assert.equal(send.sent.length, 1, 'one batch');
    const b = send.sent[0].batch;
    assert.equal(send.sent[0].url, 'https://obs.example.test/e');
    assert.equal(b.v, 1);
    assert.equal(b.page, 'hub', 'a hub page');
    assert.equal(b.build, 'abcdef123456', 'the door build id of door.json');
    assert.equal(b.loader, '0.3.0');
    assert.equal(b.site, '');
    assert.equal(b.who, null);
    assert.equal(b.ua.browser, 'chromium');
    const names = b.events.map((e) => e.n);
    assert.deepEqual(names.slice(0, 4), ['boot.start', 'boot.features', 'boot.stage', 'run.start'], 'what happened before the reporter existed goes first, in order');
    assert.ok(names.indexOf('consent.set') > names.indexOf('run.start'));
    const set = b.events.find((e) => e.n === 'consent.set');
    assert.deepEqual({ choice: set.choice, scope: set.scope }, { choice: 'accepted', scope: 'origin' });
    assert.ok(names.indexOf('log') > -1 && b.events[names.length - 1].n === 'log' && b.events[names.length - 1].m === 'after the yes', 'the log line after the yes is last');
    const start = b.events[0];
    assert.equal(start.dev, false);
    assert.equal(start.degraded, false);
    assert.equal(start.forced, false);
    assert.equal(start.cspKind, 'normal');
    assert.ok(start.t0ms >= 40 && start.t0ms < 5000, 'ms from the boot script to the reporter: ' + start.t0ms);
    const feat = b.events[1];
    assert.deepEqual({ missing: feat.missing, polyfilled: feat.polyfilled, soft: feat.soft }, { missing: '', polyfilled: 1, soft: 'webrtc,serviceWorker' }, 'the soft features this browser lacks');
    assert.deepEqual(b.events[3], Object.assign({ t: b.events[3].t, n: 'run.start' }, { mode: 'hub-root', hasSw: false, webrtc: false }));
    assert.equal(A.stored.consent.choice, 'accepted', 'the record is stored as before');
    assert.equal(spies.fetch.length + spies.beacon.length, 0);
  } finally { spies.restore(); }
});

test('"Load from host only" drops what waited and sends nothing, then or later', async () => {
  const spies = networkSpies();
  try {
    const { A, send } = await consentPage();
    const waiting = A.obs.inspect().queued;
    assert.ok(waiting > 0);
    await __obs.setConsent(A, 'host-only');
    const seen = A.obs.inspect();
    assert.equal(seen.allowed, false);
    assert.equal(seen.queued, 0, 'what waited is gone');
    assert.equal(seen.dropped, waiting, 'and counted as dropped');
    A.log('after the no');
    A.report('ui.click', { id: 'x' });
    assert.equal(A.obs.inspect().queued, 0, 'nothing is kept after a no');
    A.obs.flush('test');
    A.obs.flush('hide');
    assert.equal(send.sent.length, 0);
    assert.equal(spies.fetch.length + spies.beacon.length, 0);
    // Changing the choice to "Share and load" later starts a clean session: only what happens after it.
    await __obs.setConsent(A, 'accepted');
    A.log('later');
    A.obs.flush('test');
    assert.equal(send.sent.length, 1);
    assert.ok(!send.names().includes('boot.start'), 'the boot events of before the no are not sent');
    assert.ok(send.events().some((e) => e.n === 'log' && e.m === 'later'));
  } finally { spies.restore(); }
});

test('a returning visitor: the stored choice is read, and "accepted" sends, "host-only" and the Settings switch off do not (syncReports decides)', async () => {
  const mk = async (consentState, reports) => {
    const run = await runHub();
    run.A.consentState = consentState;
    run.A.prefs.reports = reports;
    __obs.syncReports(run.A);
    run.A.obs.flush('test');
    return run;
  };
  const accepted = await mk('accepted', 'on');
  assert.equal(accepted.A.obs.inspect().allowed, true);
  assert.ok(accepted.send.names().includes('boot.start'));
  const hostOnly = await mk('host-only', 'on');
  assert.equal(hostOnly.A.obs.inspect().allowed, false);
  assert.equal(hostOnly.send.sent.length, 0);
  const off = await mk('accepted', 'off');
  assert.equal(off.A.obs.inspect().allowed, false, 'a visitor who turned the switch off keeps it off after agreeing again');
  assert.equal(off.A.obs.inspect().queued, 0);
  assert.equal(off.send.sent.length, 0);
  const pending = await mk('pending', 'on');
  assert.equal(pending.A.obs.inspect().allowed, false);
  assert.ok(pending.A.obs.inspect().queued > 0, 'nothing decided: the events still wait, they are not dropped');
  assert.equal(pending.send.sent.length, 0);
  const pendingOff = await mk('pending', 'off');
  assert.equal(pendingOff.A.obs.inspect().queued, 0, 'switched off before any choice: dropped at once');
});

test('the Settings switch: the label names the host; off stops the reports at once and drops what waited; on lets them go again after the card\'s yes', async () => {
  const { A, root, send } = await consentPage();
  const input = () => field(root, 'mw-reports');
  const wrap = () => input().parentNode.parentNode;
  assert.equal(wrap().hidden, false, 'a report endpoint: the switch is there');
  assert.equal(input().disabled, false);
  assert.equal(input().checked, true);
  assert.equal(wrap().textContent.includes('Send usage reports to obs.example.test'), true, 'the label names the host');
  assert.match(wrap().textContent, /obs\.example\.test can see your IP address/);
  const line = root.find((n) => String(n.className).split(/\s+/).includes('mw-reports-line'));
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /^Usage reports to obs\.example\.test: waiting for your choice\. Sent 0, waiting \d+, dropped 0\.$/);
  await __obs.setConsent(A, 'accepted');
  assert.match(line.textContent, /: sending\. Sent 0, waiting \d+, dropped 0\.$/, 'the line follows the choice');
  A.obs.flush('test');
  assert.match(line.textContent, /Sent \d+/);
  // Off: a trusted click on the switch in the real UI fires 'reports' through the settings handler of the page.
  input().checked = false;
  input().dispatchEvent({ type: 'change' });
  await flush();
  assert.equal(A.prefs.reports, 'off');
  assert.equal(A.stored.reports, 'off', 'kept on this device (the pref of this origin)');
  assert.equal(A.obs.inspect().allowed, false);
  assert.equal(A.obs.inspect().queued, 0);
  assert.match(line.textContent, /: off\./);
  const before = send.sent.length;
  A.log('while off');
  A.obs.flush('hide');
  assert.equal(send.sent.length, before, 'nothing is sent while the switch is off');
  assert.ok(!send.names().includes('settings.change') || send.events().filter((e) => e.n === 'settings.change').every((e) => e.value !== false), 'the off itself is not reported');
  // On again: the visitor said yes at the card, so the reports go again, from here on only.
  input().checked = true;
  input().dispatchEvent({ type: 'change' });
  await flush();
  assert.equal(A.prefs.reports, 'on');
  assert.equal(A.stored.reports, 'on');
  assert.equal(A.obs.inspect().allowed, true);
  A.log('back on');
  A.obs.flush('test');
  const last = send.sent[send.sent.length - 1].batch.events;
  assert.ok(last.some((e) => e.n === 'settings.change' && e.name === 'reports' && e.value === true));
  assert.ok(last.some((e) => e.n === 'log' && e.m === 'back on'));
  assert.ok(!send.events().some((e) => e.n === 'log' && e.m === 'while off'));
  // A visitor who chose "Load from host only" and then flips the switch on still sends nothing.
  await __obs.setConsent(A, 'host-only');
  input().checked = false;
  input().dispatchEvent({ type: 'change' });
  await flush();
  input().checked = true;
  input().dispatchEvent({ type: 'change' });
  await flush();
  assert.equal(A.obs.inspect().allowed, false, 'the switch is not a yes to peers or to reports');
});

// ---- the delegated listeners ----------------------------------------------------------------------------------------------------

/** A node under the root: tag, attributes, text; appended to parent. */
function node(doc, parent, tag, attrs = {}, text = null) {
  const el = doc.createElement(tag, attrs);
  if (attrs.class) el.className = attrs.class;
  if (text !== null) el.textContent = text;
  parent.appendChild(el);
  return el;
}

test('the delegated listener on the root: a click is ui.click by role, id or tag with a button\'s label; a change names the control and a checkbox\'s value; typed text never leaves', async () => {
  const { A, send, root, doc } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  send.sent.length = 0;
  const bar = node(doc, root, 'div', { id: 'mw-bar' });
  const cont = node(doc, bar, 'button', { 'data-role': 'card-continue' }, 'Continue');
  const inner = node(doc, cont, 'span', {}, '');
  const plain = node(doc, bar, 'button', { id: 'mw-share-btn' }, 'Share and load');
  const named = node(doc, bar, 'a', {}, 'A link');
  const banner = node(doc, bar, 'div', { class: 'mw-banner', 'data-id': 'update' });
  const bannerBtn = node(doc, banner, 'button', {}, 'Reload');
  const input = node(doc, bar, 'input', { id: 'mw-nick', type: 'text' });
  input.value = 'my secret passphrase and a nick';
  const check = node(doc, bar, 'input', { id: 'mw-share', type: 'checkbox' });
  check.type = 'checkbox';
  check.checked = true;
  const select = node(doc, bar, 'select', { id: 'mw-expiry' });
  select.value = '1h';
  const form = node(doc, bar, 'form', { 'data-role': 'composer-form' });
  const fire = (target, type, extra = {}) => root.dispatchEvent(Object.assign({ type, target, isTrusted: true }, extra));
  fire(inner, 'click');
  fire(plain, 'click');
  fire(named, 'click', { isTrusted: false });
  fire(bannerBtn, 'click');
  fire(input, 'click');
  fire(input, 'change');
  fire(check, 'change');
  fire(select, 'change');
  fire(form, 'submit');
  A.obs.flush('test');
  const ev = send.events();
  assert.deepEqual(ev.map((e) => e.n), ['ui.click', 'ui.click', 'ui.click', 'ui.click', 'ui.click', 'ui.change', 'ui.change', 'ui.change', 'ui.click']);
  const by = (i) => { const { t, n, ...rest } = ev[i]; return rest; };
  assert.deepEqual(by(0), { role: 'card-continue', text: 'Continue', trusted: true, type: 'click' }, 'a click inside a button is the button');
  assert.deepEqual(by(1), { id: 'mw-share-btn', text: 'Share and load', trusted: true, type: 'click' });
  assert.deepEqual(by(2), { id: 'mw-bar', text: 'A link', trusted: false, type: 'click' }, 'a click a script made says so (a link with no mark of its own takes the closest ancestor\'s id)');
  assert.deepEqual(by(3), { banner: 'update', text: 'Reload', trusted: true, type: 'click' });
  assert.deepEqual(by(4), { id: 'mw-nick', trusted: true, type: 'click' }, 'an input has no text');
  assert.deepEqual(by(5), { control: 'mw-nick' }, 'a change in a text field: the control, never its value');
  assert.deepEqual(by(6), { control: 'mw-share', value: true });
  assert.deepEqual(by(7), { control: 'mw-expiry', value: '1h' });
  assert.deepEqual(by(8), { role: 'composer-form', trusted: true, type: 'submit' });
  assert.ok(!JSON.stringify(send.sent.map((s) => s.batch)).includes('secret'), 'what was typed is nowhere in the batch');
  // With the reports off the listener reports nothing at all.
  await __obs.changeSetting(A, 'reports', { on: false });
  send.sent.length = 0;
  fire(plain, 'click');
  fire(check, 'change');
  A.obs.flush('hide');
  assert.equal(send.sent.length, 0);
  assert.equal(A.obs.inspect().queued, 0);
});

test('the settings payloads never reach a report: the click is on a button, the text typed in the passphrase, file and key fields is not read', async () => {
  const { A, send, root, doc } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  send.sent.length = 0;
  const pass = node(doc, root, 'input', { type: 'password', 'aria-label': 'Passphrase' });
  pass.value = 'correct horse battery staple';
  const area = node(doc, root, 'textarea', { 'aria-label': 'Moderator key' });
  area.value = '{"kty":"EC","d":"private-part"}';
  const exportBtn = node(doc, root, 'button', {}, 'Export identity');
  root.dispatchEvent({ type: 'click', target: pass, isTrusted: true });
  root.dispatchEvent({ type: 'change', target: pass, isTrusted: true });
  root.dispatchEvent({ type: 'change', target: area, isTrusted: true });
  root.dispatchEvent({ type: 'click', target: exportBtn, isTrusted: true });
  await __obs.changeSetting(A, 'exportIdentity', { passphrase: 'correct horse battery staple' }).catch(() => {});
  await __obs.changeSetting(A, 'importIdentity', { text: '{"jwk":"private-part"}', passphrase: 'correct horse battery staple' }).catch(() => {});
  await __obs.changeSetting(A, 'importModerator', { text: '{"kty":"EC","d":"private-part"}' }).catch(() => {});
  A.obs.flush('test');
  const text = JSON.stringify(send.sent.map((s) => s.batch));
  for (const secret of ['horse', 'staple', 'private-part', 'kty']) assert.ok(!text.includes(secret), secret + ' is in a report');
  const changes = send.events().filter((e) => e.n === 'settings.change').map((e) => e.name + ':' + e.value);
  assert.deepEqual(changes, ['exportIdentity:null', 'importIdentity:null', 'importModerator:null'], 'the name of the action, and nothing of its payload');
  const clicks = send.events().filter((e) => e.n === 'ui.click');
  assert.equal(clicks.length, 2);
  assert.ok(clicks.some((e) => e.text === 'Export identity'));
});

test('inside the closed root of the cards and of the call panel: one capture listener per event type, handed to the observer; a throwing observer never reaches a card', () => {
  // The cards (ui.js createCards).
  const seenCards = [];
  const doc = new DomDocument();
  const win = { document: doc, navigator: { language: 'en-CA' }, matchMedia: () => ({ matches: false }) };
  doc.defaultView = win;
  const cards = createCards({ win, doc, strict: false, minVisibleMs: 0, observe: (ev) => seenCards.push(ev.type + ':' + ev.target.tagName) });
  cards.prompt('foreign-address', {});
  const host = cards.host;
  assert.ok(host._shadow && host._shadow.mode === 'closed');
  for (const type of ['click', 'change', 'submit']) assert.equal(host._shadow.listeners.get(type).size, 1, type);
  const button = host.find((n) => n.tagName === 'BUTTON');
  host._shadow.dispatchEvent({ type: 'click', target: button, isTrusted: true });
  host._shadow.dispatchEvent({ type: 'change', target: button, isTrusted: true });
  assert.deepEqual(seenCards, ['click:BUTTON', 'change:BUTTON']);
  // A throwing observer is swallowed.
  const doc2 = new DomDocument();
  const cards2 = createCards({ win: { document: doc2, navigator: { language: 'en' }, matchMedia: () => ({ matches: false }) }, doc: doc2, strict: false, minVisibleMs: 0, observe: () => { throw new Error('boom'); } });
  cards2.prompt('foreign-address', {});
  assert.doesNotThrow(() => cards2.host._shadow.dispatchEvent({ type: 'click', target: cards2.host.find((n) => n.tagName === 'BUTTON'), isTrusted: true }));
  // Without an observer the cards have no extra listeners.
  const doc3 = new DomDocument();
  const cards3 = createCards({ win: { document: doc3, navigator: { language: 'en' }, matchMedia: () => ({ matches: false }) }, doc: doc3, strict: false, minVisibleMs: 0 });
  cards3.prompt('foreign-address', {});
  assert.equal(cards3.host._shadow.listeners.size, 0, 'no observer: no listener');
  // The call panel (call-ui.js).
  const seenCall = [];
  const cdoc = new FakeDocument();
  const callUi = createCallUi({ doc: cdoc, win: {}, nav: { language: 'en' }, lang: 'en', strict: false, minVisibleMs: 0, observe: (ev) => seenCall.push(ev.type), cssHref: '' });
  const listeners = new Map();
  callUi.attach({ methods: {}, on: (name, fn) => { listeners.set(name, fn); return () => {}; }, media: () => null });
  listeners.get('ring')({ id: 'k'.repeat(22), from: 'p256:B' + 'Q'.repeat(86), name: 'Bo', kind: 'video', group: null, roster: [], expiresAt: Date.now() + 45000 });
  const chost = cdoc.body.find((x) => x.getAttribute && x.getAttribute('data-mw-call') !== null);
  assert.ok(chost && chost._shadow.mode === 'closed');
  for (const type of ['click', 'change', 'submit']) assert.equal(chost._shadow.listeners.get(type).size, 1, 'call panel ' + type);
  chost._shadow.dispatchEvent({ type: 'click', target: chost.find((n) => n.tagName === 'BUTTON'), isTrusted: true });
  assert.deepEqual(seenCall, ['click']);
  callUi.destroy(); // the ring would otherwise keep this process alive until it expires
});

test('the shadow roots reach the reporter: the page\'s observer makes ui.click of a card button by its kind', async () => {
  const { A, send, doc } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  send.sent.length = 0;
  // The cards of the real UI of the page: its closed root has the observer createUI was given (watchEvent of the page).
  A.ui.prompt('foreign-address', {}).catch(() => {});
  const host = doc.body.find((n) => n.getAttribute && n.getAttribute('data-mw-ui-cards') !== null);
  assert.ok(host, 'the card host is in the document');
  const button = host.find((n) => n.tagName === 'BUTTON');
  host._shadow.dispatchEvent({ type: 'click', target: button, isTrusted: true });
  A.obs.flush('test');
  const click = send.events().find((e) => e.n === 'ui.click');
  assert.ok(click, 'a click inside the closed root was reported');
  assert.equal(click.card, 'foreign-address', 'by the kind of the card');
  assert.equal(click.trusted, true);
  assert.equal(click.type, 'click');
});

// ---- the log ring, mirrored -----------------------------------------------------------------------------------------------------

test('the log ring is mirrored line by line, scrubbed: what logged before the reporter is replayed first; an address, a port, a path, a full infohash and a pair code do not leave', async () => {
  const { A, send } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.log('tracker wss://tracker.example:443/announce open');
  A.log('pointer shell btih=' + BTIH + ' ledger=btih:' + BTIH);
  A.log('peer 203.0.113.5:51234 and [2001:db8::1]:443 answered');
  A.log('status downloading https://host.example/_mw/ws/secret-site/private-file.html#frag');
  A.log('code abcd-efgh-ijkl was opened');
  A.log('x'.repeat(500));
  A.obs.flush('test');
  const logs = send.events().filter((e) => e.n === 'log').map((e) => e.m);
  assert.equal(logs[0], 'mode hub-root', 'the line that was logged before the reporter existed comes first');
  assert.ok(logs.includes('tracker wss://tracker.example open'));
  assert.ok(logs.includes('pointer shell btih=ab12cd34... ledger=btih:ab12cd34...'));
  assert.ok(logs.includes('peer x.x.x.x and x.x.x.x answered'));
  assert.ok(logs.includes('status downloading https://host.example'));
  assert.ok(logs.some((m) => m === 'code abcd was opened'), 'a pair code keeps its 4-character channel');
  assert.ok(logs.some((m) => m.length === 200), 'a long line is cut at 200');
  const all = JSON.stringify(send.sent.map((s) => s.batch));
  for (const leak of ['203.0.113', '51234', '2001:db8', BTIH, 'secret-site', 'private-file', 'efgh', 'ijkl', ':443']) assert.ok(!all.includes(leak), leak + ' reached a batch');
  // The ring itself is untouched: the visitor still reads the full lines in Settings.
  assert.ok(A.ui.diagnostics.lines().some((l) => l.includes(BTIH)));
  // The two global error listeners and the console feed 'error' events.
  const errors = A.win.events.get('error');
  const rejections = A.win.events.get('unhandledrejection');
  errors[0]({ message: 'Uncaught TypeError: x is undefined at https://host.example:8443/app.js?token=abc' });
  rejections[0]({ reason: new Error('failed for 198.51.100.7') });
  A.win.console.error('[mw ui]', new Error('card broke'));
  A.win.console.warn('[mw] import() failed, retrying');
  A.obs.flush('test');
  const errs = send.events().filter((e) => e.n === 'error').map((e) => e.kind + ': ' + e.m);
  assert.deepEqual(errs, [
    'error: Uncaught TypeError: x is undefined at https://host.example',
    'rejection: failed for x.x.x.x',
    'console: [mw ui] card broke',
    'console: [mw] import() failed, retrying',
  ]);
});

test('A.log(line, { report }): the ring keeps the whole line and the reporter gets the report text, scrubbed like any line; lines logged before the reporter existed are replayed the same way, once', async () => {
  const { A, send } = await consentPage();
  assert.equal(A.earlyLog, null, 'the page has its reporter: nothing is kept for it any more');
  await __obs.setConsent(A, 'accepted');
  A.log('cached copy incomplete at /family/diary-2026.html', { report: 'cached copy incomplete' });
  A.log('no report text at https://host.example/_mw/x?k=1');
  A.log('a report text that is no text at /seven.html', { report: 7 });
  A.log('with an address 203.0.113.5:443', { report: 'peer 203.0.113.5:443 gone' });
  A.obs.flush('test');
  const logs = send.events().filter((e) => e.n === 'log').map((e) => e.m);
  assert.ok(logs.includes('cached copy incomplete'));
  assert.ok(logs.includes('no report text at https://host.example'));
  assert.ok(logs.includes('a report text that is no text at /seven.html'), 'a report text that is not a string is not used (a call site must give one)');
  assert.ok(logs.includes('peer x.x.x.x gone'), 'the report text is scrubbed too');
  assert.ok(!logs.join('\n').includes('diary'));
  const ring = A.ui.diagnostics.lines().join('\n');
  assert.ok(ring.includes('cached copy incomplete at /family/diary-2026.html') && ring.includes('203.0.113.5:443'), 'the ring keeps the lines the person reads');
  // what a page logged before it had a reporter: its report texts wait in earlyLog, and the reporter says them first, once
  const p = pageOf();
  p.A.earlyLog = ['mode door', 'cached copy incomplete', 'peer 203.0.113.5:443 gone'];
  const early = sender();
  await __obs.startObs(p.A, { obs: { send: early } });
  p.A.obs.allow(true);
  drain(p.A.obs);
  assert.deepEqual(early.events().filter((e) => e.n === 'log').map((e) => e.m), ['mode door', 'cached copy incomplete', 'peer x.x.x.x gone']);
  assert.equal(p.A.earlyLog, null);
  // a page with no usable block never makes a reporter: the list is dropped when the read is over, and a line then goes to the ring only
  const none = await runHub({ json: doorJsonWith() });
  assert.equal(none.A.obs, null);
  assert.equal(none.A.earlyLog, null);
  assert.doesNotThrow(() => none.A.log('later', { report: 'later' }));
});

// ---- the card, the gate and the DNS card name the host --------------------------------------------------------------------------

const buttonOf = (root, label) => root.find((n) => n.tagName === 'BUTTON' && n.textContent === label);
const click = (b) => b.dispatchEvent({ type: 'click', isTrusted: true });
const reportsLine = (root) => root.findAll((n) => String(n.className).split(/\s+/).includes('mw-consent-reports'));

test('the first-run card names the report host before anything is sent; "Share and load" sends, the three other buttons say what they were', async () => {
  const { A, root, send } = await consentPage();
  A.record = { xs: ['https://host.example.test/site.torrent'] };
  __test.showConsentCard(A);
  const lines = reportsLine(root);
  assert.equal(lines.length, 1, 'one line about the reports');
  assert.match(lines[0].textContent, /^Usage reports: if you choose to share, this page also sends reports to obs\.example\.test, run by this site's owner/);
  assert.match(lines[0].textContent, /obs\.example\.test can see your IP address/);
  assert.match(lines[0].textContent, /If you do not share, none are sent\./);
  assert.equal(A.obs.inspect().allowed, false, 'the card is up and nothing is allowed');
  click(buttonOf(root, 'Share and load'));
  await flush();
  assert.equal(A.consentState, 'accepted');
  assert.equal(A.obs.inspect().allowed, true);
  A.obs.flush('test');
  const ev = send.events();
  const shown = ev.find((e) => e.n === 'gate.shown');
  assert.deepEqual({ kind: shown.kind, host: shown.host }, { kind: 'consent', host: 'obs.example.test' });
  const names = ev.map((e) => e.n);
  assert.ok(names.indexOf('gate.shown') < names.indexOf('gate.choice') && names.indexOf('gate.choice') < names.indexOf('consent.set'), names.join());
  assert.equal(ev.find((e) => e.n === 'gate.choice').choice, 'accepted');
  // Load from host only, Not now (here: Cancel is "Not now" without a host copy) and Settings.
  for (const [label, choice] of [['Load from host only', 'host-only']]) {
    const page = await consentPage();
    page.A.record = { xs: ['https://host.example.test/site.torrent'] };
    __test.showConsentCard(page.A);
    click(buttonOf(page.root, label));
    await flush();
    assert.equal(page.A.consentState, choice);
    assert.equal(page.A.obs.inspect().allowed, false);
    assert.equal(page.A.obs.inspect().queued, 0, 'what waited was dropped');
    assert.equal(page.send.sent.length, 0);
  }
  const noHost = await consentPage();
  noHost.A.record = {};
  __test.showConsentCard(noHost.A);
  assert.equal(reportsLine(noHost.root).length, 1, 'the line is there with no host copy too, and does not name a button that is not');
  assert.doesNotMatch(reportsLine(noHost.root)[0].textContent, /host only/i);
  click(buttonOf(noHost.root, 'Not now'));
  await flush();
  assert.equal(noHost.A.consentState, 'pending');
  assert.ok(noHost.A.obs.inspect().queued > 0, 'not now is not a no: the events still wait');
  assert.equal(noHost.send.sent.length, 0);
  const settings = await consentPage();
  settings.A.record = { xs: ['https://host.example.test/site.torrent'] };
  __test.showConsentCard(settings.A);
  click(buttonOf(settings.root, 'Settings'));
  settings.A.ui.settings.close();
  assert.equal(settings.A.obs.inspect().allowed, false);
});

test('a card without a report endpoint has no such line, and says nothing of reports; the French card is French', async () => {
  const none = await runHub({ json: doorJsonWith() });
  none.A.record = { xs: ['https://host.example.test/site.torrent'] };
  __test.showConsentCard(none.A);
  assert.equal(reportsLine(none.root).length, 0);
  assert.ok(!none.root.findAll((n) => n._text).some((n) => /usage report/i.test(n._text)));
  const fr = await consentPage({ lang: 'fr-CA' });
  fr.A.record = { xs: ['https://host.example.test/site.torrent'] };
  __test.showConsentCard(fr.A);
  const line = reportsLine(fr.root)[0];
  assert.match(line.textContent, /^Rapports d'utilisation : si vous choisissez de partager, cette page envoie aussi des rapports à obs\.example\.test/);
  assert.match(line.textContent, /Si vous ne partagez pas, aucun n'est envoyé\./);
  click(buttonOf(fr.root, 'Partager et charger'));
  await flush();
  assert.equal(fr.A.obs.inspect().allowed, true);
  const settings = field(fr.root, 'mw-reports').parentNode.parentNode;
  assert.equal(settings.textContent.includes('Envoyer des rapports d\'utilisation à obs.example.test'), true, 'the Settings switch in French');
});

test('the gate names the report host: "Load" sends, "Load from host only" and Cancel do not; the DNS card too', async () => {
  const gate = async (label) => {
    const page = await consentPage();
    page.A.record = { xs: ['https://host.example.test/site.torrent'] };
    page.A.mode = { mode: 'shell', scope: 'hub.example.test', path: '/' };
    const promise = __test.openGate(page.A);
    await flush();
    const lines = reportsLine(page.root);
    assert.equal(lines.length, 1);
    assert.match(lines[0].textContent, /^Loading it peer-to-peer also sends usage reports to obs\.example\.test, run by this site's owner/);
    assert.match(lines[0].textContent, /If you do not load it peer-to-peer, none are sent\./);
    click(buttonOf(page.root, label));
    const decision = await promise;
    await flush();
    return { page, decision };
  };
  const load = await gate('Load');
  assert.equal(load.decision, 'load');
  assert.equal(load.page.A.obs.inspect().allowed, true);
  load.page.A.obs.flush('test');
  const ev = load.page.send.events();
  assert.deepEqual(ev.filter((e) => e.n === 'gate.shown').map((e) => [e.kind, e.host]), [['gate', 'obs.example.test']]);
  assert.deepEqual(ev.filter((e) => e.n === 'gate.choice').map((e) => e.choice), ['accepted']);
  const hostOnly = await gate('Load from host only');
  assert.equal(hostOnly.decision, 'host-only');
  assert.equal(hostOnly.page.A.obs.inspect().allowed, false);
  assert.equal(hostOnly.page.send.sent.length, 0);
  const cancel = await gate('Cancel');
  assert.equal(cancel.decision, 'cancel');
  assert.equal(cancel.page.A.obs.inspect().allowed, false);
  assert.ok(cancel.page.A.obs.inspect().queued > 0, 'cancel is not a no: nothing is dropped, nothing sent');
  assert.equal(cancel.page.send.sent.length, 0);
  // The blocking card before a DNS lookup.
  const dns = await consentPage();
  const asked = __test.askBeforeDns(dns.A);
  const lines = reportsLine(dns.root);
  assert.equal(lines.length, 1);
  assert.match(lines[0].textContent, /obs\.example\.test/);
  click(buttonOf(dns.root, 'Share and load'));
  assert.equal(await asked, 'accepted');
  assert.equal(dns.A.obs.inspect().allowed, false, 'that card only chooses; readConsent and syncReports apply the choice once the pointer is known');
  dns.A.consentState = 'accepted';
  __obs.syncReports(dns.A);
  assert.equal(dns.A.obs.inspect().allowed, true);
  dns.A.obs.flush('test');
  assert.equal(dns.send.events().filter((e) => e.n === 'gate.shown').map((e) => e.kind).join(), 'dns');
  assert.equal(dns.send.events().filter((e) => e.n === 'gate.choice').map((e) => e.choice).join(), 'accepted');
});

// ---- the bare door page and the apps ---------------------------------------------------------------------------------------------

const fakeApps = () => ({ api: null, destroy() {}, on() { return () => {}; }, state: () => ({}) });

test('the bare door page: one read gives the apps block and the report block; the apps get report and createLink; nothing goes before their first yes', async () => {
  const spies = networkSpies();
  try {
    const p = pageOf();
    const send = sender();
    const wrapped = [];
    const apps = await __apps.readAppsBlock(p.A);
    await __obs.startObs(p.A, { obs: { send, random: () => 0.1, wrapPeerConnection: (w, r) => { wrapped.push([w, r]); return true; } } });
    assert.deepEqual(apps, APPS_BLOCK, 'the apps block is what it was');
    assert.ok(p.A.obs, 'and the page has a reporter from the same read');
    assert.equal(p.A.win.fetch.seen.length, 1, 'door.json was read once for both');
    assert.equal(p.A.obsHost, 'obs.example.test');
    const seen = { createApps: [], createUi: [], onFirstYes: [] };
    const view = { node: p.doc.createElement('div'), inspect: () => ({ view: 'home' }), destroy() {}, onFirstYes: (fn) => seen.onFirstYes.push(fn) };
    const ok = await __apps.runDoorApps(p.A, APPS_BLOCK, {
      importApps: async () => ({ createApps: (d) => { seen.createApps.push(d); return fakeApps(); } }),
      identity: { createIdentityService: () => ({}) },
      client: { configure() {} },
      mountServices: async () => ({ mounted: ['identity'], errors: {} }),
      createUi: (o) => { seen.createUi.push(o); return view; },
    });
    assert.equal(ok, true);
    assert.equal(wrapped.length >= 1 && wrapped[0][0] === p.A.win && wrapped[0][1] === p.A.obs, true, 'the peer connection wrapper went in before the apps can make a manager');
    const d = seen.createApps[0];
    assert.equal(typeof d.report, 'function', 'the service reports its transitions');
    assert.deepEqual(Object.keys(d.linkOptions), ['report'], 'and builds its pair socket with a report of its own');
    assert.equal(typeof d.linkOptions.report, 'function');
    const o = seen.createUi[0];
    assert.equal(typeof o.report, 'function');
    assert.equal(typeof o.reportsHost, 'function', 'the price cards ask for the host when they are drawn');
    assert.equal(o.reportsHost(), 'obs.example.test', 'the price card names the host');
    assert.equal(typeof o.actions.firstYes, 'function');
    assert.equal(seen.onFirstYes.length, 1, 'and the view\'s onFirstYes is used too');
    assert.equal(p.A.firstYes, false);
    // Names are given without the prefix; the page adds 'apps.' for the service and the view, 'link.' for the socket.
    d.report('view', { view: 'home' });
    o.report('card', { kind: 'start', ev: 'show' });
    d.linkOptions.report('state', { state: 'open' });
    assert.equal(p.A.obs.inspect().allowed, false, 'nothing is sent before the first yes');
    assert.ok(p.A.obs.inspect().queued >= 5);
    // The apps' first explicit yes (the price card's Continue, or the sign-in card).
    o.actions.firstYes();
    assert.equal(p.A.firstYes, true);
    assert.equal(p.A.obs.inspect().allowed, true);
    seen.onFirstYes[0]();
    d.report('conv', { id: 'c1', status: 'waiting' });
    p.A.obs.flush('test');
    const names = send.names();
    assert.deepEqual(names.slice(0, 4), ['boot.start', 'boot.features', 'boot.stage', 'run.start']);
    assert.ok(names.includes('apps.view') && names.includes('apps.card') && names.includes('apps.conv') && names.includes('link.state'), names.join());
    assert.equal(send.sent[0].batch.page, 'door');
    assert.equal(send.sent[0].batch.build, 'abcdef123456');
    // The Settings switch of the door page: the page installs a handler for it (and for nothing else), the switch shows the host and the state.
    assert.equal(typeof p.ui.settingsHandler, 'function');
    const last = p.settingsCalls[p.settingsCalls.length - 1];
    assert.deepEqual({ host: last.host, on: last.on, state: last.state }, { host: 'obs.example.test', on: true, state: 'sending' });
    assert.equal(await p.ui.settingsHandler('share', { on: false }), undefined, 'no other setting is answered here');
    await p.ui.settingsHandler('reports', { on: false });
    assert.equal(p.A.prefs.reports, 'off');
    assert.equal(p.A.obs.inspect().allowed, false);
    assert.equal(p.settingsCalls[p.settingsCalls.length - 1].state, 'off');
    assert.equal(o.reportsHost(), '', 'a price card drawn now names no report host: there are none');
    await p.ui.settingsHandler('reports', { on: true });
    assert.equal(o.reportsHost(), 'obs.example.test');
    assert.equal(p.A.obs.inspect().allowed, true, 'the first yes still stands');
    assert.equal(p.settingsCalls[p.settingsCalls.length - 1].state, 'sending');
    assert.equal(spies.fetch.length + spies.beacon.length, 0);
  } finally { spies.restore(); }
});

test('the door page: the first yes arriving through actions.firstYes alone, or through onFirstYes alone, is enough; a view that does not start leaves no page waiting for one', async () => {
  const mk = async () => {
    const p = pageOf();
    p.send = sender();
    await __obs.startObs(p.A, { obs: { send: p.send } });
    return p;
  };
  const run = (p, createUi) => __apps.runDoorApps(p.A, APPS_BLOCK, {
    importApps: async () => ({ createApps: () => fakeApps() }), identity: { createIdentityService: () => ({}) }, client: { configure() {} },
    mountServices: async () => ({ mounted: ['identity'], errors: {} }), createUi,
  });
  const viaActions = await mk();
  let o;
  await run(viaActions, (opts) => { o = opts; return { node: viaActions.doc.createElement('div'), inspect: () => ({}), destroy() {} }; });
  o.actions.firstYes();
  assert.equal(viaActions.A.obs.inspect().allowed, true);
  const viaMethod = await mk();
  let fn;
  await run(viaMethod, () => ({ node: viaMethod.doc.createElement('div'), inspect: () => ({}), destroy() {}, onFirstYes: (f) => { fn = f; } }));
  assert.equal(viaMethod.A.obs.inspect().allowed, false);
  fn();
  assert.equal(viaMethod.A.obs.inspect().allowed, true);
  const broken = await mk();
  assert.equal(await run(broken, () => { throw new Error('view boom'); }), false);
  assert.equal(broken.A.firstYes, undefined, 'no apps page after all');
  // Switched off before the yes: the yes does not turn it on.
  const off = await mk();
  let oo;
  await run(off, (opts) => { oo = opts; return { node: off.doc.createElement('div'), inspect: () => ({}), destroy() {} }; });
  await off.ui.settingsHandler('reports', { on: false });
  oo.actions.firstYes();
  assert.equal(off.A.obs.inspect().allowed, false);
  assert.equal(off.A.obs.inspect().queued, 0);
});

test('the door page without a report block: the apps are made exactly as before, with no report, no linkOptions, no reportsHost and no firstYes', async () => {
  const p = pageOf({ win: { fetch: fetchOf(doorJsonWith({ apps: APPS_BLOCK })), location: { origin: 'https://door.test', search: '' }, navigator: { language: 'en-CA' }, addEventListener() {}, console: {} } });
  const apps = await __apps.readAppsBlock(p.A);
  await __obs.startObs(p.A, { obs: {} });
  assert.deepEqual(apps, APPS_BLOCK);
  assert.ok(!p.A.obs, 'no reporter');
  assert.equal(p.A.win.fetch.seen.length, 1);
  const seen = { createApps: [], createUi: [] };
  await __apps.runDoorApps(p.A, APPS_BLOCK, {
    importApps: async () => ({ createApps: (d) => { seen.createApps.push(d); return fakeApps(); } }), identity: { createIdentityService: () => ({}) }, client: { configure() {} },
    mountServices: async () => ({ mounted: ['identity'], errors: {} }),
    createUi: (o) => { seen.createUi.push(o); return { node: p.doc.createElement('div'), inspect: () => ({}), destroy() {} }; },
  });
  assert.deepEqual(Object.keys(seen.createApps[0]).sort(), ['api', 'config', 'idp', 'lang', 'loadTm', 'log', 'rendezvous', 'stun']);
  assert.deepEqual(Object.keys(seen.createUi[0]).sort(), ['actions', 'lang', 'root', 'service', 'ui']);
  assert.deepEqual(Object.keys(seen.createUi[0].actions).sort(), ['log', 'openLink', 'signIn', 'signOut']);
  assert.equal(p.ui.settingsHandler, undefined, 'no settings handler is installed for a switch that does not exist');
  assert.equal(p.A.firstYes, undefined);
});

test('a site\'s shell page reads the same file once, with the same strictness; a bad endpoint is no endpoint and is said in the log', async () => {
  const shell = pageOf({ mode: { mode: 'shell', scope: 'door.test', path: '/' } });
  const send = sender();
  await __obs.startObs(shell.A, { obs: { send } });
  assert.ok(shell.A.obs);
  assert.equal(shell.A.win.fetch.seen.length, 1);
  shell.A.obs.allow(true);
  shell.A.obs.flush('test');
  assert.equal(send.sent[0].batch.page, 'site');
  const sub = pageOf({ mode: { mode: 'hub-sub', label: 'x', hubHost: 'h.test' } });
  await __obs.startObs(sub.A, { obs: { send: sender() } });
  sub.A.obs.allow(true);
  assert.equal(sub.A.obs.inspect().host, 'obs.example.test');
  for (const endpoint of ['http://obs.example.test', 'https://obs.example.test/e', 'https://user@obs.example.test', 'not a url']) {
    const p = pageOf({ win: { fetch: fetchOf(doorJsonWith({ obs: { endpoint } })), location: { origin: 'https://door.test', search: '' }, navigator: { language: 'en' }, addEventListener() {}, console: {} } });
    await __obs.startObs(p.A, { obs: { send } });
    assert.equal(p.A.obs, undefined, endpoint);
    assert.ok(p.logs.some((l) => l.includes('usage-report block') && l.includes('no usage reports')), endpoint + ': ' + p.logs.join('|'));
  }
  // The read happens at most once per page: a second reader gets the same answer.
  const again = pageOf();
  await __obs.startObs(again.A, { obs: { send } });
  await __apps.readAppsBlock(again.A);
  await __obs.readObsBlock(again.A);
  assert.equal(again.A.win.fetch.seen.length, 1);
});

// ---- peer connections: the usage wrapper, the offer-timeout wrapper, and the calls' unwrap -----------------------------------------

class NativePc {
  static generateCertificate() { return Promise.resolve('cert'); }
  constructor(cfg) { this.cfg = cfg; this.map = new Map(); this.iceConnectionState = 'new'; this.iceGatheringState = 'new'; this.connectionState = 'new'; }
  addEventListener(t, f) { if (!this.map.has(t)) this.map.set(t, []); this.map.get(t).push(f); }
  emit(t, ev) { for (const f of this.map.get(t) || []) f(ev); }
  close() { this.closed = true; }
  setRemoteDescription() { return Promise.resolve(); }
  getStats() { return Promise.resolve(new Map()); }
}

test('wrapRtc: the usage wrapper goes in before the offer-timeout wrapper, in either order both work, and the calls get the browser\'s own constructor through both', async () => {
  for (const order of ['usage first', 'offer timeout first']) {
    const win = { RTCPeerConnection: NativePc };
    const send = sender();
    const A = { win, webrtc: true, obs: createReporter({ endpoint: 'https://obs.example.test', send, page: 'site' }), log() {}, obsDeps: {} };
    A.obs.allow(true);
    if (order === 'usage first') {
      assert.equal(__obs.wrapRtc(A), true);
      assert.equal(installOfferTimeout(win, { timeoutMs: 5 }), true);
    } else {
      assert.equal(installOfferTimeout(win, { timeoutMs: 5 }), true);
      assert.equal(__obs.wrapRtc(A), true);
    }
    assert.equal(__obs.wrapRtc(A), false, order + ': idempotent');
    assert.equal(nativeRtc(win.RTCPeerConnection), NativePc, order + ': the calls find the browser\'s own constructor');
    assert.equal(__c2WireUi.callDeps({ win, webrtc: true, mode: { mode: 'shell' }, api: { cfg: () => ({}) }, config: CONFIG }).RTCPeerConnection, NativePc, order + ': callDeps hands it to the calls');
    assert.equal(win.RTCPeerConnection.generateCertificate, NativePc.generateCertificate, 'statics stay reachable');
    const pc = new win.RTCPeerConnection({ iceServers: [] });
    assert.ok(pc instanceof NativePc);
    assert.equal(typeof pc.onicecandidate === 'object' || pc.onicecandidate === undefined || pc.onicecandidate === null || typeof pc.onicecandidate === 'function', true);
    pc.iceGatheringState = 'gathering';
    pc.emit('icegatheringstatechange', {});
    pc.emit('icecandidate', { candidate: { candidate: 'candidate:1 1 udp 2113937151 192.0.2.1 54321 typ host', type: 'host', protocol: 'udp' } });
    pc.emit('icecandidate', { candidate: { candidate: 'candidate:2 1 udp 1677729535 198.51.100.9 40000 typ srflx raddr 192.0.2.1 rport 54321', type: 'srflx', protocol: 'udp' } });
    pc.iceConnectionState = 'connected';
    pc.emit('iceconnectionstatechange', {});
    A.obs.flush('test');
    const ev = send.events();
    assert.deepEqual(ev.filter((e) => e.n === 'ice.local').map((e) => e.type + '/' + e.proto), ['host/udp', 'srflx/udp'], order + ': candidate types only');
    assert.ok(ev.some((e) => e.n === 'ice.pc' && e.ev === 'created'));
    assert.ok(ev.some((e) => e.n === 'ice.gathering' && e.state === 'gathering'));
    assert.ok(ev.some((e) => e.n === 'ice.state' && e.state === 'connected'));
    assert.ok(!JSON.stringify(send.sent.map((s) => s.batch)).match(/192\.0\.2|198\.51\.100|54321|40000/), order + ': no address or port');
  }
  // A page without a reporter, or without WebRTC, is left alone.
  const win = { RTCPeerConnection: NativePc };
  assert.equal(__obs.wrapRtc({ win, webrtc: true, obs: null }), false);
  assert.equal(__obs.wrapRtc({ win, webrtc: false, obs: {} }), false);
  assert.equal(win.RTCPeerConnection, NativePc);
  // The unwrap by itself: no wrapper, a wrapper, junk.
  assert.equal(nativeRtc(NativePc), NativePc);
  assert.equal(nativeRtc(null), null);
  assert.equal(nativeRtc(undefined), undefined);
  // The offer-timeout wrapper alone, as before this lane.
  const w2 = { RTCPeerConnection: NativePc };
  installOfferTimeout(w2, { timeoutMs: 5 });
  assert.equal(nativeRtc(w2.RTCPeerConnection), NativePc);
  assert.equal(Object.getPrototypeOf(w2.RTCPeerConnection), NativePc);
  // The test's own wrapper function is a deps seam: a page may be given another wrapPeerConnection.
  let called = null;
  const A3 = { win: { RTCPeerConnection: NativePc }, webrtc: true, obs: { event() {} }, log() {}, obsDeps: { wrapPeerConnection: (w, r) => { called = [w, r]; return true; } } };
  assert.equal(__obs.wrapRtc(A3), true);
  assert.equal(called[0], A3.win);
  assert.equal(called[1], A3.obs);
  assert.equal(typeof wrapPeerConnection, 'function');
});

// ---- torrent.js: the report option -----------------------------------------------------------------------------------------------

class Emitter {
  constructor() { this._l = new Map(); }
  on(t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this; }
  once(t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a); }; return this.on(t, w); }
  removeListener(t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); } return this; }
  emit(t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true; }
}

function fakeWire({ type = 'webrtc', peerId = null } = {}) {
  const w = new Emitter();
  Object.assign(w, { type, peerId, destroyed: false, choked: 0, _onMessageLength() { return 'orig'; }, _parse() {}, choke() { this.choked++; }, unchoke() {}, setTimeout() {}, setKeepAlive() {} });
  w.destroy = function () { this.destroyed = true; this.emit('close'); };
  return w;
}

function managerWith(report) {
  return new TorrentManager({ WebTorrent: class {}, config: CONFIG, policy: { maxConns: 30, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false }, consent: { peersAllowed: () => true, onChange() {} }, deps: {}, lifecycle: false, report });
}

test('TorrentManager reports peer.ice, peer.wire, peers.count and tracker.state: states, counts and host names, never an id, an address or a port', () => {
  const got = [];
  const tm = managerWith((name, fields) => got.push([name, fields]));
  // A peer connection's ICE states, with the swarm kind it was made for.
  const peer = Object.assign(new Emitter(), { id: 'peer-secret-id-1234' });
  tm._onPeer(peer, 'rendezvous');
  peer.emit('iceStateChange', 'checking', 'gathering');
  peer.emit('iceStateChange', 'connected', 'complete');
  peer.emit('iceStateChange', undefined, 7);
  assert.deepEqual(got.splice(0), [
    ['peer.ice', { kind: 'rendezvous', ice: 'checking', gathering: 'gathering' }],
    ['peer.ice', { kind: 'rendezvous', ice: 'connected', gathering: 'complete' }],
    ['peer.ice', { kind: 'rendezvous', ice: null, gathering: null }],
  ]);
  // A wire opens and closes: kind, event, whether it is a web seed. The count follows.
  const wire = fakeWire({ peerId: 'wire-secret-peer-id' });
  tm._onWire(wire, { infoHash: 'x' }, 'chat');
  assert.deepEqual(got.splice(0), [['peers.count', { count: 1, webseeds: 0 }], ['peer.wire', { kind: 'chat', ev: 'open', web: false }]]);
  const seed = fakeWire({ type: 'webSeed' });
  tm._onWire(seed, { infoHash: 'x' }, 'site');
  assert.deepEqual(got.splice(0), [['peers.count', { count: 1, webseeds: 1 }], ['peer.wire', { kind: 'site', ev: 'open', web: true }]]);
  wire.destroy();
  assert.deepEqual(got.splice(0), [['peer.wire', { kind: 'chat', ev: 'close', web: false }], ['peers.count', { count: 0, webseeds: 1 }]]);
  // A tracker's state change: its host name, not its port or path.
  const tracker = { announceUrl: 'wss://tracker.example.test:8443/announce?x=1', socket: { connected: true }, reconnecting: false, destroyed: false };
  tm._trackerClients = () => [{ tc: { _trackers: [tracker], on() {} }, kind: 'site', torrent: {} }];
  tm._shimTrackers = () => 0;
  tm._hookTrackerClient = () => {};
  tm._glareCheck = () => {};
  tm._pollTrackers();
  tracker.socket.connected = false;
  tm._pollTrackers();
  tm._pollTrackers();
  assert.deepEqual(got.splice(0), [['tracker.state', { host: 'tracker.example.test', state: 'open' }], ['tracker.state', { host: 'tracker.example.test', state: 'connecting' }]]);
  // A closed wire that was never opened (refused by the guard) is not reported as a close.
  const refused = fakeWire({ peerId: 'refused' });
  refused._onMessageLength = undefined;
  const text = JSON.stringify(got);
  for (const secret of ['secret', '8443', '?x=1', '/announce']) assert.ok(!text.includes(secret), secret);
  tm.destroy();
});

test('TorrentManager without a report option, or with one that throws, behaves as before', () => {
  const plain = managerWith(null);
  const peer = Object.assign(new Emitter(), { id: 'p1' });
  plain._onPeer(peer, 'site');
  assert.equal(peer._l.has('iceStateChange'), false, 'no listener is added for a page without reports');
  const aWire = fakeWire({ peerId: 'a' });
  plain._onWire(aWire, { infoHash: 'x' }, 'chat');
  assert.equal(plain.peers, 1);
  aWire.destroy(); // a wire's grace timer ends with the wire
  plain.destroy();
  const boom = managerWith(() => { throw new Error('report broke'); });
  const p2 = Object.assign(new Emitter(), { id: 'p2' });
  boom._onPeer(p2, 'site');
  assert.doesNotThrow(() => p2.emit('iceStateChange', 'checking', 'new'));
  const bWire = fakeWire({ peerId: 'b' });
  assert.doesNotThrow(() => boom._onWire(bWire, { infoHash: 'x' }, 'chat'));
  assert.equal(boom.peers, 1, 'the engine goes on');
  bWire.destroy();
  boom.destroy();
});

// ---- api.js: api.request and the sign-in steps ------------------------------------------------------------------------------------

test('MwApi reports every request as api.request { method, outcome }: a known method by name, anything else as "unknown"; never params or results', async () => {
  const got = [];
  let clock = 1000;
  const api = new MwApi({ mod: false, report: (n, f) => got.push([n, f]), now: () => clock, info: () => ({ btih: BTIH, name: 'Secret Site Name', mode: 'shell' }), activation: () => true });
  const ok = await api.request('site.info', { secret: 'param text' });
  assert.equal(ok.ok, true);
  const unknown = await api.request('<script>alert(1)</script>', { x: 1 });
  assert.equal(unknown.reason, 'invalid');
  const bad = await api.request('db.set', 'not an object');
  assert.equal(bad.reason, 'invalid');
  const missing = await api.request('auth.state', {});
  assert.ok(missing);
  assert.deepEqual(got.filter((g) => g[0] === 'api.request').map((g) => g[1]), [
    { method: 'site.info', outcome: 'ok' },
    { method: 'unknown', outcome: 'invalid' },
    { method: 'db.set', outcome: 'invalid' },
    { method: 'auth.state', outcome: 'ok' },
  ]);
  const text = JSON.stringify(got);
  for (const leak of ['param text', 'Secret Site Name', 'script', BTIH]) assert.ok(!text.includes(leak), leak);
  // No report option: the plain call (the same promise result, no events, no wrapper object).
  const quiet = new MwApi({ mod: false });
  const r = await quiet.request('site.info', {});
  assert.equal(r.ok, true);
  // A reporter that throws never breaks a request.
  const boom = new MwApi({ mod: false, report: () => { throw new Error('boom'); } });
  assert.equal((await boom.request('site.info', {})).ok, true);
  clock += 1;
});

test('MwApi reports the sign-in steps: from the site (signin.start how sdk, signin.result), from the loader\'s card, and the fallbacks', async () => {
  const got = [];
  let clock = 5000;
  const events = () => got.map((g) => g[0] + ' ' + JSON.stringify(g[1]));
  const make = (extra = {}) => {
    got.length = 0;
    return new MwApi(Object.assign({ mod: false, report: (n, f) => got.push([n, f]), now: () => (clock += 120), activation: () => true }, extra));
  };
  // The site's own call, with no identity service: refused, and the refusal is a code.
  let api = make();
  const refused = await api.request('auth.signIn', {});
  assert.equal(refused.ok, false);
  assert.deepEqual(events().map((e) => e.split(' ')[0]), ['signin.start', 'api.request', 'signin.result'], 'start, then the request, then the result');
  assert.equal(got[0][0], 'signin.start');
  assert.deepEqual(got[0][1], { how: 'sdk' });
  assert.equal(got[1][0], 'api.request');
  assert.equal(got[2][0], 'signin.result');
  assert.equal(got[2][1].code, 'E_UNSUPPORTED');
  assert.equal(typeof got[2][1].ms, 'number');
  // The loader's own card: the identity service answers.
  api = make();
  api.services.identity = { methods: { 'auth.signIn': async () => ({ state: 'signed-in' }) } };
  assert.deepEqual(await api.signInFromCard({}), { state: 'signed-in' });
  assert.deepEqual(got.map((g) => g[0]), ['signin.start', 'signin.result']);
  assert.deepEqual(got[0][1], { how: 'card' });
  assert.equal(got[1][1].code, 'ok');
  api = make();
  api.services.identity = { methods: { 'auth.signIn': async () => { throw Object.assign(new Error('closed by the person'), { code: 'E_USER_CANCELLED' }); } } };
  await assert.rejects(api.signInFromCard({}), { code: 'E_USER_CANCELLED' });
  assert.equal(got[1][1].code, 'E_USER_CANCELLED');
  assert.ok(!JSON.stringify(got).includes('closed by the person'), 'the code, not the message');
  // A popup the browser blocked: the site's call falls back to the loader's card (a fallback of kind card), which can itself fall back to the redirect.
  api = make({ ui: { prompt: async (kind) => (kind === 'signin' ? { fallback: 'redirect' } : false) } });
  api.services.identity = { methods: { 'auth.signIn': async () => { throw Object.assign(new Error('blocked'), { code: 'E_POPUP_BLOCKED' }); } } };
  await api.request('auth.signIn', {});
  const kinds = got.filter((g) => g[0] === 'signin.fallback').map((g) => g[1].kind);
  assert.deepEqual(kinds, ['card', 'redirect']);
});

// ---- ui.js on its own: the banner and diagnostics events, the Settings switch -------------------------------------------------------

function uiFor(over = {}) {
  const doc = new DomDocument();
  const store = new Map();
  const win = { document: doc, navigator: { language: over.lang || 'en-CA' }, matchMedia: () => ({ matches: false }), localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), console };
  doc.defaultView = win;
  const root = doc.createElement('div');
  root.setAttribute('id', 'mw-root');
  doc.body.appendChild(root);
  const got = [];
  const ui = createUI(root, STRINGS, Object.assign({ lang: over.lang || 'en-CA', report: (n, f) => got.push([n, f]) }, over.opts || {}));
  return { ui, root, doc, got };
}

test('createUI reports a banner when it appears and when it goes (not when its text changes), and a diagnostics row when it appears or goes (not when its text changes)', () => {
  const { ui, got } = uiFor();
  ui.setBanner('update', 'Update available', { kind: 'info' });
  ui.setBanner('update', 'Update available again', { kind: 'info' });
  ui.setBanner('update', null);
  ui.setBanner('update', null);
  ui.setBanner('webseed', 'The host is slow', { kind: 'warn', dismissible: true });
  assert.deepEqual(got.splice(0), [['banner', { id: 'update', ev: 'show' }], ['banner', { id: 'update', ev: 'hide' }], ['banner', { id: 'webseed', ev: 'show' }]]);
  ui.diagnostics.set('tracker-unreachable', { count: 2, text: 'wss://t.example' });
  ui.diagnostics.set('tracker-unreachable', { count: 3, text: 'wss://t.example wss://u.example' });
  ui.diagnostics.set('nat', { count: 1 });
  ui.diagnostics.set('tracker-unreachable', null);
  ui.diagnostics.set('tracker-unreachable', false);
  ui.diagnostics.clear();
  assert.deepEqual(got.splice(0), [
    ['diag.row', { row: 'tracker-unreachable', ev: 'set' }], ['diag.row', { row: 'nat', ev: 'set' }],
    ['diag.row', { row: 'tracker-unreachable', ev: 'clear' }], ['diag.row', { row: 'nat', ev: 'clear' }],
  ]);
  const text = JSON.stringify(got);
  assert.ok(!text.includes('wss://') && !text.includes('slow'), 'ids and row names only, never the text');
  // A report hook that throws never reaches the interface; no hook is the plain interface.
  const boom = uiFor({ opts: { report: () => { throw new Error('boom') } } });
  assert.doesNotThrow(() => { boom.ui.setBanner('x', 'T'); boom.ui.diagnostics.set('nat', { count: 1 }); });
  const plain = uiFor({ opts: { report: undefined } });
  assert.doesNotThrow(() => { plain.ui.setBanner('x', 'T'); plain.ui.setBanner('x', null); });
});

test('the Settings switch of usage reports: hidden and disabled by default; setReports shows the host, the state and the counts; the switch fires "reports" with its value', () => {
  const { ui, root } = uiFor();
  const input = field(root, 'mw-reports');
  const wrap = input.parentNode.parentNode;
  const line = root.find((n) => String(n.className).split(/\s+/).includes('mw-reports-line'));
  assert.equal(wrap.hidden, true);
  assert.equal(input.disabled, true);
  assert.equal(line.hidden, true);
  const fired = [];
  ui.settings.onChange((action, payload) => fired.push([action, payload]));
  ui.settings.setReports({ host: 'obs.example.test', on: true, state: 'sending', sent: 12, queued: 3, dropped: 1 });
  assert.equal(wrap.hidden, false);
  assert.equal(input.disabled, false);
  assert.equal(input.checked, true);
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, 'Usage reports to obs.example.test: sending. Sent 12, waiting 3, dropped 1.');
  assert.ok(wrap.textContent.includes('Send usage reports to obs.example.test'));
  assert.ok(wrap.textContent.includes('Off stops them at once and drops the ones still waiting.'));
  input.checked = false;
  input.dispatchEvent({ type: 'change' });
  assert.deepEqual(fired.pop(), ['reports', { on: false }]);
  ui.settings.setReports({ host: 'obs.example.test', on: false, state: 'off', sent: -4, queued: 'x', dropped: 2.9 });
  assert.equal(input.checked, false);
  assert.equal(line.textContent, 'Usage reports to obs.example.test: off. Sent 0, waiting 0, dropped 2.');
  ui.settings.setReports({ host: 'obs.example.test', on: true, state: 'anything else' });
  assert.match(line.textContent, /: waiting for your choice\./);
  for (const gone of [null, undefined, {}, { host: '' }, { host: 5 }, 'obs.example.test']) {
    ui.settings.setReports({ host: 'obs.example.test', on: true });
    ui.settings.setReports(gone);
    assert.equal(wrap.hidden, true, JSON.stringify(gone));
    assert.equal(input.disabled, true);
    assert.equal(line.textContent, '');
  }
  const fr = uiFor({ lang: 'fr-CA' });
  fr.ui.settings.setReports({ host: 'obs.example.test', on: true, state: 'sending', sent: 1, queued: 0, dropped: 0 });
  const frLine = fr.root.find((n) => String(n.className).split(/\s+/).includes('mw-reports-line'));
  assert.equal(frLine.textContent, 'Rapports d\'utilisation vers obs.example.test : envoi en cours. Envoyés 1, en attente 0, abandonnés 0.');
});

test('showConsentCard and showGate take reportsHost: the line is there only with it, in the visitor\'s language, and the existing lines are where they were', () => {
  const { ui, root } = uiFor();
  const lines = (r) => r.findAll((n) => String(n.className).split(/\s+/).includes('mw-consent-reports')).map((n) => n.textContent);
  ui.showConsentCard({ hasWebseed: true, onShare() {} });
  assert.deepEqual(lines(root), []);
  ui.showConsentCard({ hasWebseed: true, dnsUpdate: true, reportsHost: 'obs.example.test', onShare() {} });
  assert.equal(lines(root).length, 1);
  assert.match(lines(root)[0], /sends reports to obs\.example\.test/);
  const texts = root.findAll((n) => n._text).map((n) => n._text);
  const at = (re) => texts.findIndex((t) => re.test(t));
  assert.ok(at(/^If you choose to share, your browser also asks a DNS-over-HTTPS service/) < at(/^Usage reports:/), 'after the DNS line, before the choice line');
  assert.ok(at(/^Usage reports:/) < at(/^You can load the site from its host only/));
  ui.showGate({ hasWebseed: true, reportsHost: 'obs.example.test', onLoad() {} });
  assert.equal(lines(root).length, 2, 'the gate has its own line');
  assert.match(lines(root)[1], /^Loading it peer-to-peer also sends usage reports to obs\.example\.test/);
  const fr = uiFor({ lang: 'fr' });
  fr.ui.showGate({ hasWebseed: true, reportsHost: 'obs.example.test', onLoad() {} });
  assert.match(lines(fr.root)[0], /^Le chargement de pair à pair envoie aussi des rapports d'utilisation à obs\.example\.test/);
});

// ---- the steps of the site pipeline, the identity, the network ---------------------------------------------------------------------

test('the pipeline events: the stored copy and why not, the download steps once each, errors as codes, the pointer, the ledger and the update checks', async () => {
  const { A, send } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  send.sent.length = 0;
  const cache = { getSite: async () => null };
  const verify = { verifyInfoHash: async () => false };
  A.deps = Object.assign({}, A.deps, { cache: Object.assign({}, A.deps.cache, cache), verify });
  A.btih = BTIH;
  assert.equal(await __obs.lookupCache(A), null);
  A.deps.cache.getSite = async () => ({ complete: true, torrentFile: new Uint8Array([1]), files: [] });
  A.deps.cache.deleteSite = async () => {};
  assert.equal(await __obs.lookupCache(A), null);
  A.deps.cache.getSite = async () => { throw new Error('idb gone'); };
  assert.equal(await __obs.lookupCache(A), null);
  A.log = () => {};
  __obs.fetchStep(A, 'start');
  __obs.fetchStep(A, 'torrent');
  __obs.fetchStep(A, 'torrent');
  __obs.fetchStep(A, 'download');
  __obs.fetchStep(A, 'persist');
  __obs.fetchStep(A, 'done');
  __obs.fetchStep(A, 'start');
  __obs.onTorrentStatus(Object.assign(A, { ui: Object.assign({}, A.ui, { setStatus() {} }) }), { code: 'fetching-torrent', url: 'https://host.example/x.torrent' });
  __obs.onTorrentStatus(A, { code: 'downloading', name: 'Secret Name' });
  __obs.onTorrentStatus(A, { code: 'downloading', name: 'Secret Name' });
  __obs.presentDownloadError(Object.assign(A, { ui: Object.assign({}, A.ui, { setStatus() {}, showError() {} }) }), Object.assign(new Error('Secret text of the error'), { code: 'E_NO_PEERS' }));
  __obs.presentDownloadError(A, new Error('only a message'));
  __obs.presentPointerError(A, Object.assign(new Error('Pointer text'), { code: 'E_POINTER', tried: ['link'] }));
  __obs.presentPointerError(A, new Error('no code'));
  __obs.reportLedger(A, 12, 2, 3);
  __obs.reportLedger(A, 12, 2, 3);
  A.obs.flush('test');
  const ev = send.events();
  const pick = (name) => ev.filter((e) => e.n === name).map(({ t, n, ...rest }) => rest);
  assert.deepEqual(pick('site.cache'), [{ hit: false, reason: 'absent' }, { hit: false, reason: 'hash' }, { hit: false, reason: 'error' }]);
  const steps = pick('site.fetch');
  assert.deepEqual(steps.map((s) => s.step), ['start', 'torrent', 'download', 'persist', 'done', 'start', 'torrent', 'download'], 'each step once per download');
  assert.ok(steps.every((s) => Number.isInteger(s.ms) && s.ms >= 0));
  assert.deepEqual(pick('site.error'), [{ code: 'E_NO_PEERS' }, { code: 'error' }]);
  assert.deepEqual(pick('pointer.error'), [{ code: 'E_POINTER' }, { code: 'error' }]);
  assert.deepEqual(pick('ledger.sync'), [{ entries: 12, inSync: 2, peers: 3 }], 'the same counts once');
  assert.ok(!JSON.stringify(ev.filter((e) => e.n !== 'log')).match(/Secret|Pointer text|only a message|x\.torrent|idb gone/), 'the structured events carry codes and words, never a message or a name (the log mirror carries the loader\'s own lines)');
});

test('repThrottled: the first at once, then at most one per interval, the latest fields of the interval last', async () => {
  const { A, send } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  send.sent.length = 0;
  __obs.repThrottled(A, 'site.progress', 40, { pct: 10 });
  __obs.repThrottled(A, 'site.progress', 40, { pct: 20 });
  __obs.repThrottled(A, 'site.progress', 40, { pct: 30 });
  A.obs.flush('test');
  assert.deepEqual(send.events().filter((e) => e.n === 'site.progress').map((e) => e.pct), [10]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  A.obs.flush('test');
  assert.deepEqual(send.events().filter((e) => e.n === 'site.progress').map((e) => e.pct), [10, 30], 'the trailing one carries the latest value');
  __obs.repThrottled(Object.assign({}, A, { obs: null }), 'site.progress', 40, { pct: 99 });
  assert.equal(A.obs.inspect().queued, 0);
});

test('the identity: auth.change when the sign-in changes, and the short id the header shows goes to the reporter (a short id of another shape does not)', async () => {
  const p = pageOf();
  const send = sender();
  await __obs.startObs(p.A, { obs: { send } });
  p.A.obs.allow(true);
  const fireAuth = (snap) => p.listeners[0](snap);
  fireAuth({ state: 'signed-in', info: { pub: 'p256:x', short: 'da9u-6qug', name: 'A Nick' } });
  p.A.report('after.in', {});
  fireAuth({ state: 'guest', info: null });
  p.A.report('after.out', {});
  fireAuth({ state: 'signed-in', info: { pub: 'p256:x', short: 'AbC_dEf1', name: 'Nick' } });
  p.A.report('after.legacy', {});
  drain(p.A.obs);
  const batches = send.sent.map((s) => s.batch);
  const whoOf = (name) => batches.find((b) => b.events.some((e) => e.n === name)).who;
  assert.equal(whoOf('after.in'), 'da9u-6qug');
  assert.equal(whoOf('after.out'), null);
  assert.equal(whoOf('after.legacy'), null, 'a short id outside [a-z0-9-] is not sent');
  assert.deepEqual(send.events().filter((e) => e.n === 'auth.change').map((e) => e.signedIn), [true, false, true]);
  assert.ok(!JSON.stringify(batches).includes('Nick'), 'no name');
  // Already signed in when the reporter is made.
  const q = pageOf();
  q.api.identity.state = () => 'signed-in';
  q.api.identity.info = () => ({ pub: 'p256:y', short: 'k3f9-2xqm' });
  const send2 = sender();
  await __obs.startObs(q.A, { obs: { send: send2 } });
  q.A.obs.allow(true);
  drain(q.A.obs);
  assert.ok(send2.sent.some((s) => s.batch.who === 'k3f9-2xqm'), 'the events after the sign-in carry it');
});

test('the identity: one sign-in announced twice is one auth.change, and another short id while signed in is another', async () => {
  const p = pageOf();
  const send = sender();
  await __obs.startObs(p.A, { obs: { send } });
  p.A.obs.allow(true);
  const fireAuth = (snap) => p.listeners[0](snap);
  const first = { state: 'signed-in', info: { pub: 'p256:x', short: 'da9u-6qug', name: 'A Nick' } };
  fireAuth(first);
  fireAuth(Object.assign({}, first)); // the identity's second notice of the same sign-in, in the same millisecond
  p.A.report('after.in', {});
  fireAuth({ state: 'signed-in', info: { pub: 'p256:z', short: 'k3f9-2xqm' } }); // another identity while signed in
  p.A.report('after.other', {});
  fireAuth({ state: 'guest', info: null });
  fireAuth({ state: 'guest', info: null });
  p.A.report('after.out', {});
  fireAuth(first); // signing in again after a sign-out counts
  drain(p.A.obs);
  assert.deepEqual(send.events().filter((e) => e.n === 'auth.change').map((e) => e.signedIn), [true, true, false, true]);
  const batches = send.sent.map((s) => s.batch);
  const whoOf = (name) => batches.find((b) => b.events.some((e) => e.n === name)).who;
  assert.deepEqual([whoOf('after.in'), whoOf('after.other'), whoOf('after.out')], ['da9u-6qug', 'k3f9-2xqm', null], 'the repeated notice changes nothing about who the batches name');
});

test('the network and the lifecycle: coarse words from navigator.connection, and one lifecycle event per hidden, visible, pagehide, pageshow, online, offline, freeze and resume', async () => {
  const p = pageOf();
  p.A.win.navigator.connection = { type: 'cellular', effectiveType: '4g', downlink: 1.5, rtt: 100, saveData: false };
  const send = sender();
  await __obs.startObs(p.A, { obs: { send } });
  p.A.obs.allow(true);
  p.A.win.navigator.connection = { type: 'wifi', effectiveType: '3g' };
  __obs.noteNetwork(p.A);
  p.A.win.navigator.connection = { type: 'Weird Type!', effectiveType: 'x'.repeat(40) };
  __obs.noteNetwork(p.A);
  p.A.win.navigator.connection = undefined;
  __obs.noteNetwork(p.A);
  drain(p.A.obs);
  const nets = send.events().filter((e) => e.n === 'net.change').map(({ t, n, ...r }) => r);
  assert.deepEqual(nets, [{ type: 'wifi', effectiveType: '3g' }, { type: null, effectiveType: null }]);
  assert.equal(send.sent[0].batch.net.type, 'cellular', 'the first batch carries the network of its time');
  assert.ok(!JSON.stringify(send.sent).includes('downlink'), 'only the two words');
  // The lifecycle on the page's own window and document.
  const { A, send: s2, doc } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  s2.sent.length = 0;
  __obs.installLifecycle(A);
  doc.setVisibility('hidden');
  doc.setVisibility('visible');
  for (const type of ['pagehide', 'pageshow', 'online', 'offline', 'freeze', 'resume']) for (const fn of A.win.events.get(type) || []) fn({ type, persisted: false });
  A.obs.flush('test');
  const life = s2.events().filter((e) => e.n === 'lifecycle').map((e) => e.ev);
  for (const ev of ['hidden', 'visible']) assert.ok(life.includes(ev), ev + ' in ' + life.join());
  assert.ok(life.length >= 2);
});

// ---- the sources of this lane ----------------------------------------------------------------------------------------------------------

const LANE_FILES = ['app.js', 'ui.js', 'call-ui.js', 'doors.js', 'consent.js', 'torrent.js', 'api.js', 'config.js', 'strings.js', 'connectivity.js'];
const srcOf = (f) => readFileSync(new URL('../../src/loader/' + f, import.meta.url), 'utf8');

// The names of plan section 3 that the loader hooks raise (3.1 to 3.3, with torrent.js's four); ui.click comes from the reporter's click(), the
// ice.* names from obs.js and apps.* and link.* from lane L3.
const CATALOGUE = [
  'boot.start', 'boot.features', 'boot.sw', 'boot.stage', 'run.start', 'run.mode', 'sw.register', 'sw.outdated', 'gate.shown', 'gate.choice', 'consent.set',
  'pointer.resolved', 'pointer.error', 'pointer.withdrawn', 'update.check', 'tab.role', 'site.cache', 'site.fetch', 'site.progress', 'site.error',
  'render.done', 'tracker.state', 'peers.count', 'peer.wire', 'peer.ice', 'ledger.open', 'ledger.sync', 'snapshot', 'connectivity', 'lifecycle',
  'net.change', 'banner', 'diag.row', 'error', 'api.request', 'log', 'ui.change', 'settings.change', 'auth.change', 'signin.start', 'signin.result', 'signin.fallback'
];

test('the loader raises only events of the catalogue, every one of them is raised somewhere, and each name fits the endpoint\'s rule', () => {
  const found = new Set();
  const re = /(?:\brep\(\s*(?:A\s*,\s*)?|\b_rep\(\s*|\bA\.report\(\s*|\brepThrottled\(\s*A\s*,\s*)'([^']+)'\s*[,)]/g;
  for (const f of ['app.js', 'ui.js', 'torrent.js', 'api.js']) {
    let m;
    const src = srcOf(f);
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  const nameRe = /^[a-z][a-z0-9.-]{1,48}$/;
  for (const name of found) {
    assert.match(name, nameRe, name);
    assert.ok(CATALOGUE.includes(name), name + ' is not in the catalogue of plan section 3');
  }
  for (const name of CATALOGUE) assert.ok(found.has(name), name + ' is never raised');
});

test('run() starts the report block read beside the loader\'s own modules and waits for it before anything that can show a card; the peer connection wrapper goes in before the offer-timeout wrapper', () => {
  const src = srcOf('app.js');
  const run = src.slice(src.indexOf('async function run (options)'), src.indexOf('/** inspectShell(A)'));
  const at = (needle) => { const i = run.indexOf(needle); assert.ok(i > 0, needle + ' is in run()'); return i; };
  assert.ok(at('const obsReady = startObs(A, options)') < at('A.deps = await loadDeps()'), 'the read starts first');
  assert.ok(at('A.deps = await loadDeps()') < at('await obsReady'), 'and is waited for after the modules');
  assert.ok(at('await obsReady') < at("if (A.mode.mode === 'hub-root') return runHubRoot"), 'before the hub root asks for DNS');
  assert.ok(at('await obsReady') < at('await readAppsBlock(A)'), 'before the door page shows its apps');
  assert.ok(at('await obsReady') < at('A.consentState = await readConsent(A)'), 'before the stored choice is read against the recipients');
  assert.ok(at('const obsReady') > at("A.log('sign-in answer taken; mode '"), 'after the sign-in redirect settled the mode');
  const make = src.slice(src.indexOf('async function createTorrentManager'), src.indexOf('function onTorrentStatus'));
  assert.ok(make.indexOf('wrapRtc(A)') > 0 && make.indexOf('wrapRtc(A)') < make.indexOf('installOfferTimeout(A.win'), 'usage wrapper first, the offer timeout on top');
  assert.ok(make.indexOf('installOfferTimeout(A.win') < make.indexOf('await import(/* webpackIgnore: true */ url)'), 'both before the webtorrent bundle is imported');
  assert.ok(make.includes('report: (name, fields) => rep(A, name, fields)'), 'the manager gets the report option');
  assert.match(src, /const base = nativeRtc\(R\)/, 'the calls take the constructor under both wrappers');
  assert.match(src, /function loadAppsTm[\s\S]*?wrapRtc\(A\)[\s\S]*?A\.lanesOnly = true/, 'the apps\' lanes are wrapped before their manager');
  // Every recipients key of the page includes the report host (the card, the record and the tab adoption agree).
  assert.doesNotMatch(src, /recipientsKey\(A\.record, A\.config\)/, 'no recipients key without the report host is left');
  assert.ok(src.includes('recipientsKey(A.record, A.config, { obsHost: A.obsHost || null })'));
  assert.equal((src.match(/rcpt: (?:A\.record \? )?rcptOf\(A\)/g) || []).length, 3, 'readConsent, saveConsentRecord and the tab adoption');
});

test('the wording rules of the plan over every file of this lane: no banned word, no em or en dash, no curly quote, no ellipsis character; the new code is semicolon-free', () => {
  const banned = [/blockchain/i, /serverless/i, /unstoppable/i, /censorship[- ]resistant/i, /production[- ]ready/i, /fully decentralized/i, /sub-second/i];
  for (const f of LANE_FILES) {
    const src = srcOf(f);
    // strings.js names the banned words in its own rules (ui-v03-strings and strings-c2 scan its texts); the other files must not use them at all.
    if (f !== 'strings.js') for (const re of banned) assert.doesNotMatch(src, re, f + ' has ' + re);
    assert.doesNotMatch(src, DASHES, f + ' has a dash, a curly quote or an ellipsis');
  }
  // The block of usage-report functions of app.js and the report hooks elsewhere: no statement ends with a semicolon.
  const app = srcOf('app.js');
  const block = app.slice(app.indexOf('// Usage reports (docs/OBSERVABILITY.md)\n'), app.indexOf('// C2 doors: the steps above, exported'));
  assert.ok(block.length > 10000);
  const code = block.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /;\s*$/m, 'src/loader is semicolon-free');
  // The test names above: this file itself keeps the dash and word rules in its own strings and comments.
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  assert.doesNotMatch(self, DASHES, 'this test file has a dash, a curly quote or an ellipsis character');
});

test('the interface reports gate.shown when a card or the gate is up (the gate once when it is drawn again for the size) and gate.choice for the button pressed, before the loader\'s own handler runs', () => {
  const { ui, root, got } = uiFor();
  const order = [];
  const press = (label) => click(buttonOf(root, label));
  ui.showGate({ hasWebseed: true, reportsHost: 'obs.example.test', onLoad: () => order.push('onLoad'), onHostOnly: () => order.push('onHostOnly'), onCancel: () => order.push('onCancel') });
  ui.showGate({ hasWebseed: true, reportsHost: 'obs.example.test', onLoad: () => order.push('onLoad'), onHostOnly: () => order.push('onHostOnly'), onCancel: () => order.push('onCancel') });
  assert.deepEqual(got.splice(0), [['gate.shown', { kind: 'gate', host: 'obs.example.test' }]], 'drawn twice while open: one event');
  got.length = 0;
  const seen = [];
  ui.showGate({ hasWebseed: true, onLoad: () => seen.push(got.slice()), onCancel() {} });
  assert.deepEqual(got.splice(0), [], 'a gate that was open and is drawn again is not new');
  press('Load');
  assert.deepEqual(got.splice(0), [['gate.choice', { choice: 'accepted' }]]);
  assert.deepEqual(seen[0], [['gate.choice', { choice: 'accepted' }]], 'the choice is reported before the loader acts on it');
  ui.showGate({ hasWebseed: true, onHostOnly() {}, onCancel() {} });
  assert.deepEqual(got.splice(0), [['gate.shown', { kind: 'gate', host: null }]], 'a gate with no report endpoint says so with a null host');
  press('Load from host only');
  assert.deepEqual(got.splice(0), [['gate.choice', { choice: 'host-only' }]]);
  ui.showGate({ hasWebseed: false, onCancel() {} });
  press('Cancel');
  assert.deepEqual(got.splice(0).map((g) => g[0] + ':' + (g[1].choice || g[1].kind)), ['gate.shown:gate', 'gate.choice:cancel']);
  // The first-run card and the card before a DNS lookup.
  ui.showConsentCard({ hasWebseed: true, reportsHost: 'obs.example.test', onShare() {}, onHostOnly() {}, onCancel() {}, onSettings() {} });
  click(root.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Settings' && String(n.className).split(/\s+/).includes('mw-link'))); // the card's, not the bar's
  press('Load from host only');
  ui.showConsentCard({ hasWebseed: true, onShare() {} });
  press('Share and load');
  ui.showConsentCard({ blocking: true, dns: true, hasWebseed: true, reportsHost: 'obs.example.test', onShare() {}, onCancel() {} });
  press('Cancel');
  ui.showConsentCard({ hasWebseed: false, onCancel() {} });
  press('Not now');
  assert.deepEqual(got.splice(0).map((g) => g[0] + ':' + (g[1].choice || g[1].kind) + (g[1].host ? '@' + g[1].host : '')), [
    'gate.shown:consent@obs.example.test', 'gate.choice:settings', 'gate.choice:host-only',
    'gate.shown:consent', 'gate.choice:accepted',
    'gate.shown:dns@obs.example.test', 'gate.choice:cancel',
    'gate.shown:consent', 'gate.choice:cancel',
  ]);
});

test('connectivity and withdrawal: the STUN class with a count and a time (never a mapped address), and the withdrawal of a site as one event with no text', async () => {
  const { A, send } = await consentPage();
  await __obs.setConsent(A, 'accepted');
  A.obs.flush('test');
  send.sent.length = 0;
  // The probe: a fake connection that finds one reflexive address and completes.
  class FakePC extends EventTarget {
    constructor() { super(); FakePC.made++; }
    createDataChannel() { return {}; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription() {
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { type: 'srflx', address: '198.51.100.7', port: 40000, url: 'stun:stun.cloudflare.com:3478' } })), 2);
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null })), 8);
    }
    close() { this.closed = true; }
  }
  FakePC.made = 0;
  A.webrtc = true;
  A.win.RTCPeerConnection = FakePC;
  A.config = Object.assign({}, CONFIG, { ice: Object.assign({}, CONFIG.ice, { probeBudgetMs: 400, probeSettleMs: 5, probeConfirmMs: 20 }) });
  A.policy = Object.assign({}, A.policy, { hostOnly: false });
  A.ui = Object.assign({}, A.ui, { diagnostics: Object.assign({}, A.ui.diagnostics, { set() {} }) });
  __obs.startProbe(A);
  assert.equal(FakePC.made, 1);
  for (let i = 0; i < 100 && !A.connectivity; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await flush();
  A.obs.flush('test');
  const conn = send.events().find((e) => e.n === 'connectivity');
  assert.ok(conn, 'the probe was reported');
  assert.deepEqual(Object.keys(conn).sort(), ['answered', 'cls', 'ms', 'n', 't']);
  assert.equal(conn.cls, 'easy-mapping');
  assert.equal(conn.answered, 1, 'a count of the STUN servers that answered');
  assert.ok(Number.isFinite(conn.ms) && conn.ms >= 0);
  assert.ok(!JSON.stringify(send.sent.map((s) => s.batch)).match(/198\.51\.100|40000|:3478/), 'no mapped address, no port in any event (the log line names the STUN servers by host name only)');
  // The withdrawal: the publisher took the site down; the text of the reason is not in the report.
  A.record = { btih: BTIH, why: 'A long private reason with a name in it', withdrawn: true };
  A.ui = Object.assign({}, A.ui, { setStatus() {}, showError() {} });
  A.log = () => {};
  await __obs.presentWithdrawal(A, { askFirst: false, binding: false });
  A.obs.flush('test');
  const names = send.events().map((e) => e.n);
  assert.ok(names.includes('pointer.withdrawn'));
  assert.ok(!JSON.stringify(send.events().filter((e) => e.n !== 'log')).includes('private reason'));
});

test('loadPrefs reads the Settings switch of this origin: only "off" is off; a page that has not stored it, or stored anything else, is on (which still sends nothing before the visitor\'s yes)', async () => {
  const load = async (stored) => {
    const A = { origin: 'https://site.example.test', prefs: { share: true, hostOnly: false, shareOnNetwork: false, reports: 'on' }, deps: { cache: { getPref: async (k, d) => (k === 'reports' && stored !== undefined ? stored : d) } } };
    await __obs.loadPrefs(A);
    return A.prefs.reports;
  };
  assert.equal(await load('off'), 'off');
  assert.equal(await load('on'), 'on');
  assert.equal(await load(undefined), 'on');
  assert.equal(await load('yes'), 'on');
  assert.equal(await load(false), 'on');
  assert.equal(await load(null), 'on');
});

test('a reporter that cannot use the endpoint (inert) is no reporter: the page has none and names no host; a stub reporter without inspect() is taken as it is', async () => {
  const inert = pageOf();
  const real = (opts) => createReporter(Object.assign({}, opts, { endpoint: 'ftp://nope.example.test' }));
  await __obs.startObs(inert.A, { obs: { createReporter: real } });
  assert.ok(!inert.A.obs);
  assert.ok(!inert.A.obsHost);
  assert.ok(inert.logs.some((l) => l.includes('did not accept the endpoint')));
  const stub = pageOf();
  const got = [];
  await __obs.startObs(stub.A, { obs: { createReporter: () => ({ event: (n, f) => got.push([n, f]), allow() {}, click() {}, setWho() {}, setNet() {}, setSite() {} }) } });
  assert.ok(stub.A.obs, 'a stub without inspect() is a reporter');
  assert.deepEqual(got.slice(0, 4).map((g) => g[0]), ['boot.start', 'boot.features', 'boot.stage', 'run.start']);
});
