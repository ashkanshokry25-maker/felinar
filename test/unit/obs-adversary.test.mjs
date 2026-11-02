// Adversary tests for the usage reports (plan obs-2026-11-02 section 11, V1). They try to break the privacy rules (plan section 4), the
// consent rules (plan section 2.3) and the abuse limits of the endpoint (plan section 2.7), and they pass against the code as it stands.
//
// How to read this file. A test named "STOPPED: ..." proves that a defence holds; if it fails, a defence broke. A test named "STOPPED F<n>: ..."
// is the same for a gap the adversary found (the finding numbers are those of .orchestration/reports/obs-2026-11-02/verify-adversary.md): it was
// written as "HOLE F<n>", asserting the leak or the weakness itself, and the fix lane (.orchestration/reports/obs-2026-11-02/fix.md) flipped it
// when the fix landed, so it now fails the day the gap comes back. A test named "DESIGN: ..." (or "DESIGN F<n>: ...") pins a limit that is by
// design and written down, so that nobody takes it for a defence: the Origin is a browser rule (F5), a press of any button of the identity page
// lets its reports go (F8, plan 2.6), an unmarked control gives its label (F7), and a pair code written without hyphens is not cut (F3).
//
// Run: node --test test/unit/obs-adversary.test.mjs
// No network: the transports are spies, the Worker runs in Node over an in-memory store, and every page is the fake DOM of the other tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FakeNode, FakeDocument } from './dropin-fake-dom.mjs';
import * as appModule from '../../src/loader/app.js';
import { createReporter, describeTarget, safeField, OBS_LIMITS } from '../../src/loader/obs.js';
import * as idp from '../../src/idp/obs-client.js';
import worker, { ObsLog } from '../../deploy/obs-worker/worker.js';
import * as core from '../../deploy/obs-worker/obs-core.js';
import { doorJsonFor, checkObsBlock } from '../../src/loader/doors.js';
import { detectEnvironment } from '../../src/loader/policy.js';
import { createApps } from '../../src/loader/apps.js';
import { reasonWord } from '../../src/loader/apps-link.js';
import { FakeLink, FakeIdentity, makeWorld, makePerson, until, settle } from './fakes/apps-fakes.mjs';

const { __obs } = appModule;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(ROOT + rel, 'utf8');
const ch = (code) => String.fromCharCode(code);

// ---------------------------------------------------------------------------------------------------------------------------------
// the three lines of defence, as functions of a string: the loader's safeField, the identity page's safeField and the Worker's mask
// ---------------------------------------------------------------------------------------------------------------------------------

const LAYERS = { loader: (s) => safeField(s), idp: (s) => idp.safeField(s), worker: (s) => core.maskString(s) };
const NAMES = Object.keys(LAYERS);

/** outs(input) -> what each layer makes of the text. */
const outs = (input) => Object.fromEntries(NAMES.map((n) => [n, LAYERS[n](input)]));

/** held(input, secret, layers) -> the layers whose output still holds the secret. */
function held(input, secret, layers = NAMES) {
  return layers.filter((n) => LAYERS[n](input).includes(secret));
}

/** stopped(input, secrets, layers): none of the layers keeps any of the secrets. */
function stopped(input, secrets, layers = NAMES) {
  for (const secret of [].concat(secrets)) {
    const hit = held(input, secret, layers);
    assert.deepEqual(hit, [], 'the secret ' + JSON.stringify(secret) + ' survives in ' + hit.join(', ') + ' for ' + JSON.stringify(input) + ': ' + JSON.stringify(outs(input)));
  }
}

const IP4 = '203.0.113.5';
const IP6 = '2001:db8:85a3::8a2e:370:7334';

test('STOPPED: an IPv4 or IPv6 address, bare, bracketed, with a port or a zone, in a sentence or a URL, never survives any of the three layers', () => {
  const forms = [
    [IP4, [IP4]],
    ['connect to ' + IP4 + ' failed', [IP4]],
    [IP4 + ':8443', [IP4, '8443']],
    ['http://' + IP4 + ':8080/x?y=1#frag', [IP4, '8080', 'frag']],
    ['wss://user:pw@' + IP4 + ':443/announce', [IP4]],
    ['[' + IP6 + ']:51234', ['8a2e', '51234', 'db8']],
    ['[2001:db8::1]:443', ['db8', ':443']],
    ['fe80::1ff:fe23:4567:890a%en0', ['fe80', '4567', 'en0']],
    ['[fe80::1%25en0]:99', ['fe80', ':99']],
    ['::1', ['::1']],
    ['http://[::1]:8787/', ['::1', '8787']],
    ['::ffff:192.0.2.1', ['192.0.2.1']],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', ['ff00', '8329']],
    ['1:2:3:4:5:6:7:8', ['3:4:5']],
    ['a=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0', ['192.168.1.5']],
    ['a=candidate:2 1 UDP 1 ' + IP6 + ' 9 typ srflx raddr 10.0.0.1 rport 5555', ['10.0.0.1', '8a2e']],
    // the forms a hostile or odd string takes: full width digits and dots, zero width and soft hyphen characters inside, a trailing dot
    [ch(0xff11) + ch(0xff19) + ch(0xff12) + ch(0xff0e) + ch(0xff11) + ch(0xff16) + ch(0xff18) + ch(0xff0e) + ch(0xff10) + ch(0xff0e) + ch(0xff11), ['192.168', '168']],
    ['192' + ch(0x200d) + '.168' + ch(0x200d) + '.0.1', ['168']],
    ['192' + ch(0x200b) + '.168.0.1', ['168']],
    ['192.168' + ch(0xad) + '.0.1', ['168']],
    ['192' + ch(0xfe52) + '168' + ch(0xfe52) + '0' + ch(0xfe52) + '1', ['168']],
    ['2001' + ch(0xff1a) + 'db8' + ch(0xff1a) + ch(0xff1a) + '1', ['db8']],
    ['see 192.168.0.1.', ['168']],
    ['ip' + IP4 + 'end', [IP4]],
    ['(' + IP4 + ')', [IP4]],
    ['"' + IP4 + '"', [IP4]],
    [IP4 + ',' + '198.51.100.7', [IP4, '198.51.100.7']],
  ];
  for (const [input, secrets] of forms) stopped(input, secrets);
  // The loader and the Worker also take the port word of an SDP candidate line and the rport; the identity page's reduced mask keeps them
  // (it has no field that carries a candidate line, and the Worker takes them again).
  const line = 'a=candidate:2 1 UDP 1 ' + IP6 + ' 51472 typ srflx raddr 10.0.0.1 rport 5555';
  stopped(line, ['51472', '5555'], ['loader', 'worker']);
  assert.ok(LAYERS.idp(line).includes('rport 5555'), 'DESIGN: the identity page layer keeps candidate ports: ' + LAYERS.idp(line));
  // An mDNS candidate name stands in for an address: the loader and the Worker mask it, the identity page's reduced mask does not.
  const mdns = '3f2504e0-4f89-41d3-9a0c-0305e82c3301.local';
  stopped(mdns, ['3f2504e0'], ['loader', 'worker']);
  assert.equal(LAYERS.idp(mdns), mdns, 'DESIGN: the identity page layer keeps an mDNS name');
});

test('STOPPED: a seeded fuzz of 6000 addresses in odd contexts leaves no address in any layer, and the Worker mask is idempotent', () => {
  let seed = 20261102;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ri = (n) => Math.floor(rnd() * n);
  const pick = (a) => a[ri(a.length)];
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[ri(16)]).join('');
  const v4 = () => [0, 0, 0, 0].map(() => pick([String(ri(256)), String(ri(256)), String(ri(10)), '0' + ri(100), '255', '0'])).join('.');
  const v6 = () => {
    const g = () => hex(1 + ri(4));
    const parts = Array.from({ length: 8 }, g);
    const form = ri(5);
    let s;
    if (form === 0) s = parts.join(':');
    else if (form === 1) { const i = ri(6); const j = i + 1 + ri(7 - i); s = parts.slice(0, i).join(':') + '::' + parts.slice(j).join(':'); } else if (form === 2) s = '::' + parts.slice(0, 1 + ri(6)).join(':');
    else if (form === 3) s = parts.slice(0, 1 + ri(6)).join(':') + '::';
    else s = '::ffff:' + v4();
    if (ri(2)) s = s.toUpperCase();
    if (ri(5) === 0) s += '%' + pick(['en0', 'eth0', 'wlan0']);
    return s;
  };
  const pre = ['', '', 'ip ', 'addr=', 'from ', 'http://', 'https://', 'wss://', '(', '"', "'", '[', 'candidate:1 1 udp 1 ', 'err ', 'x', 'ws://u@', 'a=', '/', ',', '<'];
  const post = ['', '', ' ok', ')', '"', "'", ',', ';', '.', '/path', '/p?q=1#frag', '!', ' failed (code 4)', '>', ' typ host'];
  const zw = [ch(0x200b), ch(0x200d), ch(0xad), ch(0x2060), ch(0xfeff), ch(0x200e)];
  const disguise = (s) => {
    const k = ri(8);
    if (k === 0) return s.replace(/[0-9]/g, (d) => ch(0xff10 + Number(d)));
    if (k === 1) return s.replace(/\./g, ch(0xff0e));
    if (k === 2) return s.replace(/:/g, ch(0xff1a));
    if (k === 3) { const i = ri(s.length); return s.slice(0, i) + pick(zw) + s.slice(i); }
    if (k === 4) return s.split('').map((c) => (ri(6) === 0 ? c + pick(zw) : c)).join('');
    return s;
  };
  // An address that is left: a token the platform reads as an IP address (net.isIP), or four dotted octets.
  const addresses = (out) => {
    const hits = [];
    for (const tok of out.split(/[^0-9A-Fa-f:.%]+/)) {
      if (!tok) continue;
      const bare = tok.replace(/^[.:]+(?!:)/, '').replace(/\.+$/, '').split('%')[0];
      if (bare.length >= 7 && /[0-9a-fA-F]/.test(bare) && net.isIP(bare)) hits.push(bare);
      const m = tok.match(/(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}/);
      if (m && net.isIPv4(m[0])) hits.push(m[0]);
      for (let i = 0; i < tok.length && tok.length < 50; i++) {
        const sub = tok.slice(i).replace(/[.:]+$/, '').split('%')[0];
        if (sub.includes(':') && sub.length >= 3 && /[0-9a-f]/i.test(sub) && net.isIPv6(sub) && !/^[0-9a-f]{1,2}:[0-9a-f]{1,2}$/i.test(sub)) { hits.push(sub); break; }
      }
    }
    return hits;
  };
  const leaks = { loader: [], idp: [], worker: [] };
  let notIdempotent = 0;
  for (let i = 0; i < 6000; i++) {
    const input = disguise(pick(pre) + (ri(2) ? v4() : v6()) + pick(post));
    for (const n of NAMES) {
      const out = LAYERS[n](input);
      if (addresses(out).length) leaks[n].push([input, out]);
    }
    const w = core.maskString(input);
    if (core.maskString(w) !== w) notIdempotent++;
  }
  assert.deepEqual(leaks.loader.slice(0, 3), [], 'loader safeField left an address');
  assert.deepEqual(leaks.idp.slice(0, 3), [], 'identity page safeField left an address');
  assert.deepEqual(leaks.worker.slice(0, 3), [], 'Worker maskString left an address');
  assert.equal(notIdempotent, 0);
});

test('STOPPED: a pair code keeps its 4 character channel in the hyphen forms (ASCII, Unicode hyphens, full width, with invisible characters); the other 8 never survive', () => {
  const code = 'abcd-efgh-2345';
  const forms = [
    code, code.toUpperCase(), 'code ' + code + ' was opened', 'open ' + code + '.', '(' + code + ')',
    'abcd' + ch(0x2010) + 'efgh' + ch(0x2011) + '2345', 'abcd' + ch(0x2013) + 'efgh' + ch(0x2014) + '2345', 'abcd' + ch(0x2212) + 'efgh' + ch(0x2212) + '2345',
    'abcd' + ch(0x200b) + '-efgh-2345', 'ab' + ch(0x200d) + 'cd-efgh-2345',
    ch(0xff41) + ch(0xff42) + ch(0xff43) + ch(0xff44) + ch(0xff0d) + ch(0xff45) + ch(0xff46) + ch(0xff47) + ch(0xff48) + ch(0xff0d) + ch(0xff12) + ch(0xff13) + ch(0xff14) + ch(0xff15),
    'abcd-efgh-2345 and wxyz-qrst-6789',
  ];
  for (const f of forms) {
    stopped(f, ['efgh', '2345', 'qrst', '6789']);
    for (const n of NAMES) assert.ok(LAYERS[n](f).startsWith('abcd') || LAYERS[n](f).includes('abcd') || LAYERS[n](f).includes('ABCD'), n + ' lost the channel of ' + JSON.stringify(f));
  }
});

test('STOPPED: the text after a # of a URL is cut by every layer, in the forms a URL takes (relative, bare host, full width number sign, zero width character, after a path)', () => {
  const forms = [
    'https://host.example/#secret-token', 'https://host.example/path/file.pdf#frag-secret', 'host.example/#secret-token', 'see https://h.example/p #secret-token',
    'x #secret-token', 'https://h.example/' + ch(0xff03) + 'secret-token', 'https://h.example/#' + ch(0x200b) + 'secret-token', 'https://h.example/' + ch(0x200b) + '#secret-token',
    'page#secret-token', 'wss://t.example/announce?x=1#secret-token',
  ];
  for (const f of forms) stopped(f, ['secret-token', 'frag-secret']);
});

test('STOPPED: a hash of 40 or more hex digits keeps 8 characters in every layer; a long opaque run keeps 8 in the Worker', () => {
  const h = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
  for (const n of NAMES) assert.equal(LAYERS[n]('btih=' + h), 'btih=ab12cd34', n);
  assert.equal(core.maskString('key ' + 'Zq9'.repeat(14)), 'key Zq9Zq9Zq');
});

test('STOPPED: a string is cut to 200 characters after the masks, so no half of an address sits at the cut; numbers must be finite; objects and functions are null', () => {
  for (let at = 150; at < 200; at += 7) {
    const s = 'x'.repeat(at) + ' ' + IP4 + ' tail';
    for (const n of NAMES) {
      const out = LAYERS[n](s);
      assert.ok(out.length <= 200, n + ' ' + out.length);
      assert.ok(!/203\.0\.113|\.113\.5|\b113\b/.test(out), n + ' half address at ' + at + ': ' + out.slice(-30));
    }
  }
  for (const v of [NaN, Infinity, -Infinity]) assert.equal(safeField(v), null);
  for (const v of [{}, [], () => 1, Symbol('x'), undefined, 10n]) assert.equal(safeField(v), null);
  assert.equal(safeField(true), true);
  assert.equal(safeField(null), null);
  assert.equal(safeField(12.5), 12.5);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// holes in the masks (findings F3 and F6)
// ---------------------------------------------------------------------------------------------------------------------------------

test('STOPPED F3: an address written with an ideographic full stop, with percent-encoded dots or colons, with a combining mark inside, in octal groups or with a ratio sign for the colon is masked by every layer; one integer and a hex number are left alone on purpose (an error code has that shape)', () => {
  const forms = [
    ['192' + ch(0x3002) + '168' + ch(0x3002) + '0' + ch(0x3002) + '1', ['168']],
    ['192' + ch(0xff61) + '168' + ch(0xff61) + '0' + ch(0xff61) + '1', ['168']],
    ['192%2E168%2E0%2E1', ['168']],
    ['http://192%2e168%2e0%2e1/', ['168']],
    ['192' + ch(0x301) + '.168.0.1', ['168']],
    ['192.168' + ch(0x301) + ch(0x302) + '.0.1', ['168']],
    ['0300.0250.0.1', ['0250']],
    ['2001' + ch(0x2236) + 'db8' + ch(0x2236) + ch(0x2236) + '1', ['db8']],
    ['2001%3Adb8%3A%3A1', ['db8']],
  ];
  for (const [input, secrets] of forms) stopped(input, secrets);
  for (const input of ['3232235777', '0xC0A80001', 'Error 0x80070005 in 1.2.3']) for (const n of NAMES) assert.equal(LAYERS[n](input), input, n + ': ' + input);
});

test('DESIGN F3: a pair code that is not written with hyphens (spaces, dots, slashes, none, a soft hyphen for a separator) keeps all 12 characters through every layer: those separators are ordinary text elsewhere (snake_case words, host names, paths, any three words of four letters), and no call site writes a code that way (the apps show it as abcd-efgh-2345)', () => {
  for (const input of ['abcd efgh 2345', 'abcd.efgh.2345', 'abcd_efgh_2345', 'abcd/efgh/2345', 'abcdefgh2345', 'abcd' + ch(0xad) + 'efgh-2345']) {
    assert.deepEqual(held(input, 'efgh'), NAMES, JSON.stringify(input));
  }
});

test('STOPPED F6: the secrets of an SDP (ice-ufrag, ice-pwd, the fingerprint of the DTLS certificate) are cut by every layer, with its addresses and ports', () => {
  const sdp = 'a=candidate:842163049 1 udp 1677729535 203.0.113.9 51472 typ srflx raddr 192.168.1.5 rport 51472 a=ice-ufrag:Zq3k a=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsT a=fingerprint:sha-256 5D:1C:0A:77:B3:4E:99:AB';
  stopped(sdp, ['203.0.113.9', '192.168.1.5'], NAMES);
  stopped(sdp, ['51472'], ['loader', 'worker']);
  stopped(sdp, ['zXy9aBcDeFgHiJkLmNoPqRsT', 'Zq3k', '5D:1C', '99:AB'], NAMES);
  for (const n of NAMES) assert.ok(LAYERS[n](sdp).endsWith('a=ice-ufrag: a=ice-pwd: a=fingerprint:sha-256'), n + ': ' + LAYERS[n](sdp));
  stopped('a=ice-ufrag:Zq3k\r\na=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsT\r\na=fingerprint:sha-256 5D:1C:0A:77:B3\r\n', ['Zq3k', 'zXy9', '5D:1C']);
});

test('DESIGN: the masks cannot know a name, a message or a passphrase; only the call sites keep those out (so the call site tests below are the defence)', () => {
  for (const text of ['Ferdle Morrow', 'pat.example@example.com', 'passphrase correct horse battery staple', 'the will is in the safe', '/private/family-photos/diary.html']) {
    for (const n of NAMES) assert.equal(LAYERS[n](text).replace(/ +/g, ' '), text.replace(/ +/g, ' ').slice(0, 200), n + ' changed ' + text);
  }
  // A whole user agent passes too: only its dotted version number (read as an address) is changed. No call site puts one in a report (the
  // call site scan below), and the reporter's own batch field is the family only.
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  for (const n of NAMES) assert.ok(LAYERS[n](ua).startsWith('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'), n);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the loader's reporter: what an event may carry, what the envelope may carry, and when anything leaves
// ---------------------------------------------------------------------------------------------------------------------------------

const ENDPOINT = 'https://obs.example.test';
const manual = () => {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const h = { fn, ms, off: false }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.off = true; },
    run() { for (const h of timers.splice(0)) if (!h.off) h.fn(); },
  };
};

/** reporter(over) -> { r, posts, events(), clock } with a recording transport that answers true. */
function reporter(over = {}) {
  const posts = [];
  const clock = { t: 1793600000000 };
  const t = manual();
  const hide = { fn: null };
  const send = over.send || ((url, text, o) => { posts.push({ url, text, batch: JSON.parse(text), final: !!(o && o.final) }); return true; });
  const opts = Object.assign({ endpoint: ENDPOINT, page: 'site', build: 'bbcb82098cda', loader: '0.3.0', now: () => clock.t, random: () => 0.5, send, timers: t, visibility: { onHide: (fn) => { hide.fn = fn; } }, env: { navigator: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' } } }, over.opts || {});
  const r = createReporter(opts);
  return { r, posts, clock, timers: t, hide, events: () => posts.flatMap((p) => p.batch.events), text: () => posts.map((p) => p.text).join('\n') };
}

test('STOPPED: an event keeps only strings (masked), finite numbers, booleans and null; objects, arrays, functions, symbols, bigints and non-finite numbers are dropped field by field, and a field cannot overwrite t or n', () => {
  const g = reporter();
  g.r.allow(true);
  const nested = { host: IP4 };
  const fields = {
    ok: 'fine', ip: 'peer ' + IP4 + ':443', n: 'ui.click', t: 5, obj: nested, arr: [IP4], fn: () => IP4, sym: Symbol(IP4), big: 10n, nan: NaN, inf: Infinity, yes: true, no: null, num: 12.5,
    'bad key': 'x', 'dotted.key': 'x', '1st': 'x', _lead: 'x', constructor: 'kept as a plain field', toString: 'also plain',
  };
  // an own property named __proto__ (what JSON.parse makes), not the prototype setter
  Object.defineProperty(fields, '__proto__', { value: { polluted: IP4 }, enumerable: true, configurable: true, writable: true });
  assert.ok(Object.keys(fields).includes('__proto__'));
  g.r.event('test.fields', fields);
  g.r.flush('test');
  const ev = g.events()[0];
  assert.equal(ev.n, 'test.fields', 'a field named n cannot rename the event');
  assert.ok(Number.isInteger(ev.t) && ev.t !== 5, 'a field named t cannot set the time');
  assert.deepEqual(Object.keys(ev).sort(), ['constructor', 'ip', 'n', 'no', 'num', 'ok', 't', 'toString', 'yes']);
  assert.equal(ev.ip, 'peer x.x.x.x');
  assert.equal(({}).polluted, undefined, 'no prototype was touched');
  assert.ok(!g.text().includes(IP4), 'the address of a dropped object, array, function or symbol is nowhere');
});

test('STOPPED: at most 12 fields, names that are not [A-Za-z][A-Za-z0-9_]{0,31} are dropped, and an event name outside the rule is dropped and counted', () => {
  const g = reporter();
  g.r.allow(true);
  const many = {};
  for (let i = 0; i < 40; i++) many['k' + i] = 'v' + i;
  g.r.event('test.many', many);
  for (const bad of ['Bad', 'a', '1x', 'has space', 'x'.repeat(60), '', null, undefined, 5, {}, 'a/b', 'ui.click\n', 'ui_click']) g.r.event(bad, { ok: 1 });
  g.r.flush('test');
  assert.equal(g.events().length, 1);
  assert.equal(Object.keys(g.events()[0]).length, 12 + 2);
  assert.equal(g.r.inspect().dropped, 13);
});

test('STOPPED: the batch envelope is built from the reporter alone: a full user agent, an address, an e-mail or a name given to setWho, setSite or setNet does not go out as it came', () => {
  const g = reporter({ opts: { env: { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0 pat.example@example.com 203.0.113.5', userAgentData: undefined } } } });
  g.r.allow(true);
  g.r.setWho('pat.example@example.com');
  g.r.event('a.one', {});
  g.r.setWho(null);
  g.r.setSite('d680ff36deadbeefcafe0123456789ab');
  g.r.setNet({ type: IP4, effectiveType: 'a@b.c' });
  g.r.event('a.two', {});
  g.r.setNet({ type: 'cellular', effectiveType: '4g' });
  g.r.setSite('not hex at all');
  g.r.event('a.three', {});
  for (let i = 0; i < 4; i++) g.r.flush('test');
  const b = g.posts.map((p) => p.batch);
  assert.equal(b[0].who, null, 'an e-mail is no who');
  assert.deepEqual(b[0].ua, { browser: 'firefox', mobile: false }, 'the engine family and nothing of the string');
  assert.equal(b[1].site, 'd680ff36', 'the first 8 characters of an infohash and not one more');
  assert.deepEqual(b[1].net, { type: 'other', effectiveType: 'unknown' }, 'only the words navigator.connection has go out: any other word is "other" or "unknown"');
  assert.equal(b[2].site, '');
  assert.ok(!g.text().includes('zorblat') && !g.text().includes(IP4) && !g.text().includes('Gecko'));
});

test('STOPPED F4: setWho takes a short id (two groups of 4 from the identity page alphabet) and nothing else: a first name, a full name or a longer word goes out as null', () => {
  const g = reporter();
  g.r.allow(true);
  const sent = (given) => { g.r.setWho(given); g.r.event('a.one', {}); g.r.flush('test'); return g.posts[g.posts.length - 1].batch.who; };
  for (const given of ['Pat', 'zorblat', 'zorblat-quux-toronto', 'zorblat-quux', 'abcd-efg0', 'abcd-efgh-ijkm']) assert.equal(sent(given), null, given);
  assert.equal(sent('da9u-6qug'), 'da9u-6qug');
  assert.equal(sent('DA9U-6QUG'), 'da9u-6qug', 'in lower case');
});

test('STOPPED: an endpoint with a path, a query, a fragment, userinfo, a plain http host that is not loopback, or a blank is no endpoint: the reporter is inert and never calls a transport', () => {
  const calls = [];
  for (const endpoint of [ENDPOINT + '/e', ENDPOINT + '?x=1', ENDPOINT + '#f', 'https://user:pw@obs.example.test', 'http://obs.example.test', 'http://203.0.113.5:8787', 'ftp://obs.example.test', '', ' ' + ENDPOINT, 'javascript:alert(1)', null, undefined, 5, {}]) {
    const g = reporter({ send: (u, t) => { calls.push([u, t]); return true; }, opts: { endpoint } });
    g.r.allow(true);
    g.r.event('a.b', { ip: IP4 });
    g.r.flush('hide');
    g.r.stop();
    assert.equal(g.r.inspect().enabled, false, String(endpoint));
    assert.equal(g.r.inspect().queued, 0);
  }
  assert.deepEqual(calls, []);
});

test('CONSENT: nothing leaves before allow(true): not on the timer, not on flush, not on hide or stop; allow(false) drops what waited and later events; stop() after a no sends nothing', () => {
  const g = reporter();
  for (let i = 0; i < 30; i++) g.r.event('a.wait', { i, ip: IP4 });
  assert.equal(g.r.inspect().queued, 30);
  assert.equal(g.timers.timers.length, 0, 'no timer is armed while nothing is allowed');
  g.r.flush('timer');
  g.r.flush('test');
  g.r.flush('hide');
  g.hide.fn();
  assert.deepEqual(g.posts, []);
  g.r.allow(false);
  assert.equal(g.r.inspect().queued, 0);
  assert.equal(g.r.inspect().dropped, 30);
  g.r.event('a.after-no', {});
  assert.equal(g.r.event('a.after-no', {}), false, 'an event after a no is refused');
  g.r.flush('hide');
  g.hide.fn();
  g.r.stop();
  assert.deepEqual(g.posts, []);
  assert.equal(g.timers.timers.filter((h) => !h.off).length, 0);
});

test('CONSENT: allow(true) sends what waited first and in order; allow(false) after reports began drops the queue and the failed batches that waited for a retry, and no later flush sends them', () => {
  let answer = false;
  const posts = [];
  const g = reporter({ send: (u, t) => { posts.push(JSON.parse(t)); return answer; } });
  for (let i = 0; i < 5; i++) g.r.event('a.n', { i });
  g.r.allow(true);
  g.r.flush('test');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].events.map((e) => e.i), [0, 1, 2, 3, 4], 'the buffered events go first, in order');
  assert.equal(g.r.inspect().queued, 5, 'the failed batch waits for a retry');
  g.r.allow(false);
  assert.equal(g.r.inspect().queued, 0, 'the retry is dropped by the no');
  const n = posts.length;
  g.r.flush('test');
  g.r.flush('hide');
  g.hide.fn();
  g.timers.run();
  g.r.event('a.later', {});
  g.r.flush('test');
  assert.equal(posts.length, n, 'nothing more after a no');
  g.r.allow(true);
  g.r.event('a.fresh', { fresh: true });
  g.r.flush('test');
  assert.equal(posts.length, n + 1);
  assert.deepEqual(posts[n].events.map((e) => e.n), ['a.fresh'], 'only what happened after the second yes');
});

test('CONSENT: the default transport (fetch keepalive, then sendBeacon) is never touched before the yes, nor after a no; every request is a keepalive fetch with no credentials and no referrer', async () => {
  const beacons = [];
  const fetches = [];
  const env = { navigator: { userAgent: 'x', sendBeacon: (u, b) => { beacons.push([u, b]); return true; } }, fetch: (u, o) => { fetches.push([u, o]); return Promise.resolve({ ok: true }); } };
  const t = manual();
  const r = createReporter({ endpoint: ENDPOINT, page: 'door', now: () => 1e12, random: () => 0.5, timers: t, env, visibility: { onHide: () => {} } });
  r.event('a.b', { ip: IP4 });
  r.flush('hide');
  r.flush('timer');
  assert.deepEqual([beacons.length, fetches.length], [0, 0], 'before the yes');
  r.allow(true);
  r.flush('test');
  assert.equal(fetches.length, 1);
  assert.equal(beacons.length, 0, 'fetch first: a cors request carries the real Origin; a no-cors beacon carries Origin null under no-referrer and is refused');
  assert.equal(fetches[0][0], ENDPOINT + '/e');
  assert.equal(fetches[0][1].headers['content-type'], 'text/plain', 'text/plain: a simple request, no preflight');
  const text = fetches[0][1].body;
  assert.ok(!text.includes(IP4));
  assert.equal(JSON.parse(text).events[0].ip, 'x.x.x.x');
  r.allow(false);
  r.event('a.c', {});
  r.flush('hide');
  r.stop();
  assert.deepEqual([beacons.length, fetches.length], [0, 1], 'nothing after the no');
  // the final flush uses fetch with keepalive, mode cors and no credentials, never a cookie
  const r2 = createReporter({ endpoint: ENDPOINT, page: 'door', now: () => 1e12, random: () => 0.5, timers: manual(), env, visibility: { onHide: () => {} } });
  r2.allow(true);
  r2.event('a.d', {});
  r2.flush('final');
  assert.equal(fetches.length, 2);
  assert.deepEqual([fetches[1][1].keepalive, fetches[1][1].mode, fetches[1][1].credentials, fetches[1][1].referrerPolicy, fetches[1][1].headers['content-type']], [true, 'cors', 'omit', 'no-referrer', 'text/plain']);
  // the beacon is the fallback when there is no fetch: a text/plain Blob (a simple request, no preflight), masked the same
  const r3 = createReporter({ endpoint: ENDPOINT, page: 'door', now: () => 1e12, random: () => 0.5, timers: manual(), env: { navigator: env.navigator, fetch: null }, visibility: { onHide: () => {} } });
  r3.allow(true);
  r3.event('a.e', { ip: IP4 });
  r3.flush('test');
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0][1].type, 'text/plain');
  assert.ok(!(await beacons[0][1].text()).includes(IP4));
});

test('STOPPED: one batch is at most 50 events and 16384 bytes whatever the events hold, and one event cannot be larger than a batch', () => {
  const g = reporter();
  g.r.allow(true);
  for (let i = 0; i < 200; i++) {
    const f = {};
    for (let k = 0; k < 12; k++) f['k' + k] = 'x'.repeat(300);
    g.r.event('a.big', f);
  }
  for (let i = 0; i < 100; i++) g.r.flush('test');
  assert.ok(g.posts.length > 1);
  for (const p of g.posts) {
    assert.ok(Buffer.byteLength(p.text) <= OBS_LIMITS.maxBodyBytes, 'bytes ' + Buffer.byteLength(p.text));
    assert.ok(p.batch.events.length <= OBS_LIMITS.maxBatch);
    assert.ok(core.validateBatch(p.batch).ok, 'the Worker accepts what the reporter sends');
  }
  assert.equal(g.r.inspect().queued + g.r.inspect().sent + g.r.inspect().dropped, 200, 'every event is exactly one of queued, sent or dropped');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the endpoint: validateBatch, then the front and the object of worker.js in Node over an in-memory store
// ---------------------------------------------------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const SITE = 'https://site.example';
const DOOR = 'https://door.example';
const TOKEN = 'r3ad-t0ken-0123456789abcdef';
const SID = 'k3m8k3m8k3m8';

const sample = (over = {}) => Object.assign({
  v: 1, sid: SID, seq: 0, page: 'door', build: 'bbcb82098cda', loader: '0.3.0', site: 'd680ff36', who: null, net: null,
  ua: { browser: 'chromium', mobile: false }, t0: 1793600000, events: [{ t: 1, n: 'gate.shown', kind: 'consent' }],
}, over);
const sidOf = (i) => 'k3m8' + i.toString(8).padStart(8, '0').replace(/[0-7]/g, (d) => String(Number(d) + 2));
const evs = (n, extra = {}) => Array.from({ length: n }, (_, i) => Object.assign({ t: i, n: 'a.b' }, extra));

function fakeWs() {
  return { sent: [], attachment: null, send(t) { this.sent.push(JSON.parse(t)); }, close() {}, serializeAttachment(v) { this.attachment = v; }, deserializeAttachment() { return this.attachment; } };
}

/** platform(t, over) -> the object over an in-memory store, and the env the front reads (ALLOW_ORIGINS, READ_TOKEN and the binding). Date is mocked. */
const clocked = new WeakSet();
async function platform(t, over = {}) {
  if (!clocked.has(t)) { t.mock.timers.enable({ apis: ['Date'], now: T0 }); clocked.add(t); } else t.mock.timers.setTime(T0);
  let alarm = null;
  const storage = Object.assign(core.createMemoryStorage(), { async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; } });
  const sockets = [];
  const ctx = { storage, getWebSockets: () => sockets.slice(), acceptWebSocket: (ws) => sockets.push(ws), blockConcurrencyWhile: (fn) => Promise.resolve().then(fn) };
  const obj = new ObsLog(ctx, over.objectEnv || {});
  await obj.ready;
  const forwarded = [];
  const stub = { fetch: (req) => { forwarded.push(req.method + ' ' + new URL(req.url).pathname); return obj.fetch(req); } };
  const env = Object.assign({ ALLOW_ORIGINS: SITE + ', ' + DOOR, READ_TOKEN: TOKEN, OBS: { idFromName: (n) => 'id:' + n, get: () => stub } }, over.env);
  return { storage, ctx, obj, env, sockets, forwarded, rows: () => Array.from(storage.rows.entries()).filter(([k]) => k.startsWith(core.KEY_PREFIX)).map(([, v]) => v) };
}

const post = (p, body, { origin = SITE, type = 'text/plain;charset=UTF-8', headers = {} } = {}) => {
  const h = Object.assign({}, origin === null ? {} : { Origin: origin }, type === null ? {} : { 'Content-Type': type }, headers);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: h, body: type === null ? new TextEncoder().encode(text) : text }), p.env);
};
const get = (p, path, headers = {}, method = 'GET') => worker.fetch(new Request('https://obs.example' + path, { method, headers }), p.env);
const word = async (res) => (await res.text()).trim();

test('STOPPED: validateBatch names the reason for every malformed shape, stores nothing it did not check, and never throws', () => {
  const bad = (over, reason) => {
    const r = core.validateBatch(sample(over));
    assert.deepEqual([r.ok, r.reason], [false, reason], JSON.stringify(over).slice(0, 80));
  };
  assert.equal(core.validateBatch(sample()).ok, true);
  for (const input of [null, undefined, 5, 'x', true, [], [sample()]]) assert.deepEqual(core.validateBatch(input), { ok: false, reason: 'shape' });
  bad({ v: 2 }, 'version'); bad({ v: '1' }, 'version'); bad({ v: undefined }, 'version');
  for (const sid of ['', 'short', 'K3M8K3M8K3M8', 'k3m8k3m8k3m0', 'k3m8k3m8k3m1', 'k3m8k3m8k3m8x', ' k3m8k3m8k3m8', 'k3m8k3m8k3m\n', 5, null, ['k3m8k3m8k3m8']]) bad({ sid }, 'sid');
  for (const seq of [-1, 1.5, 1e9 + 1, '7', null, NaN, Infinity, 2 ** 53, undefined]) bad({ seq }, 'seq');
  for (const page of ['admin', 'Site', '', null, 5, ['door']]) bad({ page }, 'page');
  for (const build of ['XYZ', 'abcdef0123456789a', 'bbcb 2098', 5, null]) bad({ build }, 'build');
  for (const loader of ['a b', 'x'.repeat(17), '0.3.0\n', 5, null, '<script>']) bad({ loader }, 'loader');
  for (const site of ['g'.repeat(8), 'D680FF36', 'a'.repeat(17), 5, null]) bad({ site }, 'site');
  for (const who of ['A@b.c', 'user@example.com', 'a b', 'x'.repeat(25), '', 5, ['a'], { a: 1 }]) bad({ who }, 'who');
  for (const net of [5, 'x', [], { type: 'a b' }, { type: IP4 }, { type: 5 }, { effectiveType: 'x'.repeat(17) }]) bad({ net }, 'net');
  for (const ua of [null, 'chromium', {}, { browser: 'IE', mobile: false }, { browser: 'other', mobile: 'no' }, { browser: 'Mozilla/5.0 (X11)', mobile: false }]) bad({ ua }, 'ua');
  for (const t0 of [-1, 1.5, 4102444801, '1', null, NaN]) bad({ t0 }, 't0');
  for (const events of [[], null, 'x', {}, evs(101)]) bad({ events }, 'events');
  bad({ events: [5] }, 'event'); bad({ events: [null] }, 'event'); bad({ events: [[]] }, 'event');
  for (const t of [-1, 1.5, '1', null, NaN, 1e400, 2 ** 53]) bad({ events: [{ t, n: 'a.b' }] }, 'time');
  for (const n of ['Bad', 'a', '1x', 'a b', 'x'.repeat(50), '', null, 5, 'ui.click\n', 'a/b', 'ui_click', 'A.b']) bad({ events: [{ t: 1, n }] }, 'name');
  const many = { t: 1, n: 'a.b' };
  for (let i = 0; i < 13; i++) many['k' + i] = i;
  bad({ events: [many] }, 'keys');
  for (const key of ['bad key', 'a.b', '1st', '_lead', 'x'.repeat(33), 'a-b', 'a\u00e9', '__proto__']) bad({ events: [JSON.parse('{"t":1,"n":"a.b",' + JSON.stringify(key) + ':"x"}')] }, 'key');
  for (const v of [{}, [], { a: 1 }, [1], undefined]) bad({ events: [{ t: 1, n: 'a.b', f: v }] }, 'value');
  bad({ events: [JSON.parse('{"t":1,"n":"a.b","f":1e999}')] }, 'value');
  // the stored batch is rebuilt from what was checked: a key the format does not name never reaches storage
  const r = core.validateBatch(Object.assign(sample(), { evil: IP4, extra: { x: 1 } }));
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.batch), ['v', 'sid', 'seq', 'page', 'build', 'loader', 'site', 'who', 'net', 'ua', 't0', 'events']);
  assert.ok(!JSON.stringify(r.batch).includes(IP4));
});

test('STOPPED: Origin: a report is accepted only from an Origin that ALLOW_ORIGINS names exactly (no Origin, null, a suffix, a prefix, a case, a port, a scheme, a trailing slash, userinfo), and a refusal carries no CORS header', async (t) => {
  const p = await platform(t);
  const refused = [null, 'null', '', '*', 'https://site.example/', 'https://SITE.example', 'HTTPS://site.example', 'http://site.example', 'https://site.example:8443', 'https://site.example.evil.test', 'https://evilsite.example',
    'https://sub.site.example', 'https://site.example@evil.test', 'https://evil.test#https://site.example', 'https://evil.test/https://site.example', 'https://site.example https://evil.test', 'https://site.example,https://evil.test'];
  for (const origin of refused) {
    const res = await post(p, sample(), { origin });
    assert.equal(res.status, 403, JSON.stringify(origin));
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS grant for ' + JSON.stringify(origin));
  }
  assert.equal(p.rows().length, 0);
  assert.deepEqual(p.forwarded, [], 'a refused origin never reaches the object');
  for (const origin of [SITE, DOOR]) {
    const res = await post(p, sample({ seq: origin === SITE ? 0 : 1 }), { origin });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('vary'), 'Origin');
  }
  // preflight: the same list
  for (const origin of [null, 'https://evil.test', 'null']) {
    const res = await get(p, '/e', origin === null ? {} : { Origin: origin }, 'OPTIONS');
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  const ok = await get(p, '/e', { Origin: SITE }, 'OPTIONS');
  assert.deepEqual([ok.status, ok.headers.get('access-control-allow-origin'), ok.headers.get('access-control-allow-headers')], [204, SITE, 'content-type']);
});

test('STOPPED: an empty ALLOW_ORIGINS, a wildcard, "null", a path or an unset var refuses every origin, including the one the page would send', async (t) => {
  for (const value of ['', '*', 'null', 'site.example', 'https://site.example/path?x', 'https://*.site.example', undefined, 5, '   ', 'https://']) {
    const p = await platform(t, { env: { ALLOW_ORIGINS: value } });
    for (const origin of [SITE, 'null', '*', null, 'https://evil.test']) assert.equal((await post(p, sample(), { origin })).status, 403, JSON.stringify([value, origin]));
    assert.equal(p.rows().length, 0);
  }
});

test('DESIGN: the Origin check keeps web pages out, not programs: a request that names an allowed Origin by hand is stored, with any session id (finding F5)', async (t) => {
  const p = await platform(t);
  const fake = sample({ sid: 'zzzzzzzzzzzz', who: 'da9u-6qug', events: [{ t: 1, n: 'auth.change', signedIn: true }, { t: 2, n: 'apps.request', ev: 'accept' }] });
  const res = await post(p, fake, { origin: SITE });
  assert.equal(res.status, 204);
  assert.equal(p.rows().length, 1);
  assert.equal(p.rows()[0].who, 'da9u-6qug', 'a batch can claim any short id: reports are evidence of a page, not of a person');
});

test('STOPPED: body limits: 32768 bytes pass, 32769 are 413 (declared or streamed, bytes and not characters), an empty body is 400, and the object never sees an oversized one', async (t) => {
  const p = await platform(t);
  const padded = (bytes) => {
    const base = JSON.stringify(sample());
    return base + ' '.repeat(bytes - Buffer.byteLength(base));
  };
  assert.equal(Buffer.byteLength(padded(32768)), 32768);
  assert.equal((await post(p, padded(32768))).status, 204, 'exactly 32768 bytes');
  const before = p.forwarded.length;
  assert.equal((await post(p, padded(32769))).status, 413, '32769 bytes streamed');
  assert.equal((await post(p, JSON.stringify(sample()), { headers: { 'Content-Length': '32769' } })).status, 413, 'declared 32769');
  assert.equal((await post(p, JSON.stringify(sample()), { headers: { 'Content-Length': '99999999999' } })).status, 413, 'declared huge');
  // two bytes a character: fewer than 32768 characters, more than 32768 bytes
  const wide = JSON.stringify(sample({ events: [{ t: 1, n: 'a.b', m: '\u00e9'.repeat(16300) }] })) + ' '.repeat(2000);
  assert.ok(wide.length < 32768 && Buffer.byteLength(wide) > 32768);
  assert.equal((await post(p, wide)).status, 413, 'bytes, not characters');
  assert.equal((await post(p, '')).status, 400);
  assert.equal(p.forwarded.length, before, 'none of them reached the object');
  // a stream that never says its length: cut at the limit
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1000))); c.close(); } });
  const res = await worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'text/plain' }, body: stream, duplex: 'half' }), p.env);
  assert.equal(res.status, 413);
  assert.equal(p.rows().length, 1);
});

test('STOPPED: only text/plain and application/json are taken; any other or no content type is 415, a body that is not JSON, a BOM, or bytes that are not UTF-8 is 400', async (t) => {
  const p = await platform(t);
  for (const type of ['text/html', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'application/octet-stream', 'text/plain+evil', 'text/', null]) {
    assert.equal((await post(p, sample(), { type })).status, 415, String(type));
  }
  for (const type of ['text/plain', 'TEXT/PLAIN; charset=utf-8', 'application/json', 'application/json; charset=utf-8']) assert.equal((await post(p, sample({ seq: 0, sid: sidOf(Math.floor(Math.random() * 1e6)) }), { type })).status, 204, type);
  for (const body of ['not json', '{', '[]', 'null', '1', '"x"', '{"v":1}', JSON.stringify(sample()) + 'x']) assert.equal((await post(p, body)).status, 400, body.slice(0, 20));
  // a byte order mark is dropped by the decoder, as it is for every JSON reader; it is no way round the checks
  assert.equal((await post(p, '\ufeff' + JSON.stringify(sample({ sid: sidOf(5) })))).status, 204);
  const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
  const res = await worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'text/plain' }, body: bytes }), p.env);
  assert.equal(res.status, 400);
});

test('STOPPED: 100 events are taken and 101 are 400; the word of each refusal is one short word and the row count does not move', async (t) => {
  const p = await platform(t);
  assert.equal((await post(p, sample({ events: evs(100) }))).status, 204);
  const rows = p.rows().length;
  const res = await post(p, sample({ events: evs(101), seq: 1 }));
  assert.deepEqual([res.status, await word(res)], [400, 'events']);
  for (const [events, reason] of [[[{ t: 1, n: 'Bad Name' }], 'name'], [[{ t: 1, n: 'a.b', f: { x: 1 } }], 'value'], [[{ t: -1, n: 'a.b' }], 'time']]) {
    const r = await post(p, sample({ events, seq: 2 }));
    assert.deepEqual([r.status, await word(r)], [400, reason]);
  }
  assert.equal(p.rows().length, rows);
});

test('STOPPED: 60 batches a minute from one session, then 429 with Retry-After; the minute slides; 1000 a day from one session; all sessions together stop at MAX_BATCHES_PER_DAY; a refused batch is not stored', async (t) => {
  const p = await platform(t);
  for (let i = 0; i < 60; i++) assert.equal((await post(p, sample({ seq: i }))).status, 204, 'batch ' + i);
  const r61 = await post(p, sample({ seq: 60 }));
  assert.equal(r61.status, 429);
  assert.equal(await word(r61), 'sid-minute');
  assert.ok(Number(r61.headers.get('retry-after')) >= 1);
  assert.equal(p.rows().length, 60);
  t.mock.timers.tick(60000);
  assert.equal((await post(p, sample({ seq: 61 }))).status, 204, 'a minute later the session may go on');
  // the day: 2 s apart is 30 a minute, so only the day limit can stop the session
  const q = await platform(t);
  let day = 0;
  for (; day < 1000; day++) {
    t.mock.timers.tick(2000);
    const res = await post(q, sample({ seq: day }));
    if (res.status !== 204) break;
  }
  assert.equal(day, 1000, 'the first 1000 pass');
  t.mock.timers.tick(2000);
  const over = await post(q, sample({ seq: 1000 }));
  assert.deepEqual([over.status, await word(over)], [429, 'sid-day']);
  // all sessions together
  const g = await platform(t, { objectEnv: { MAX_BATCHES_PER_DAY: '5' } });
  for (let i = 0; i < 5; i++) assert.equal((await post(g, sample({ sid: sidOf(i) }))).status, 204);
  const all = await post(g, sample({ sid: sidOf(99) }));
  assert.deepEqual([all.status, await word(all)], [429, 'day-all']);
  assert.equal(g.rows().length, 5);
});

test('DESIGN: the per-session limits are keyed on a session id the sender chooses, so a sender that changes it each time is held only by the day total (finding F5)', async (t) => {
  const p = await platform(t);
  for (let i = 0; i < 300; i++) assert.equal((await post(p, sample({ sid: sidOf(i) }))).status, 204);
  assert.equal(p.rows().length, 300, '300 sessions of one batch each in the same instant: not one is limited');
  assert.equal(p.obj.log.todayCount(), 300);
});

test('STOPPED: the read routes and the tail answer 404 to a missing, empty, wrong, near or repeated token, and to every token when READ_TOKEN is unset or empty; the 404 holds no data', async (t) => {
  const p = await platform(t);
  await post(p, sample({ sid: 'qqqqqqqqqqqq', who: 'da9u-6qug' }));
  const guesses = ['', TOKEN.slice(0, -1), TOKEN + 'x', TOKEN.toUpperCase(), ' ' + TOKEN, TOKEN + ' ', 'x'.repeat(TOKEN.length), TOKEN.slice(0, -1) + 'X', TOKEN + '\u0000'].map((g) => encodeURIComponent(g));
  for (const route of ['/events.json', '/summary.json', '/tail']) {
    for (const g of guesses) {
      const res = await get(p, route + '?token=' + g);
      assert.equal(res.status, 404, route + ' ' + JSON.stringify(g));
      const text = await res.text();
      assert.ok(!text.includes('qqqqqqqqqqqq') && !text.includes('da9u-6qug'), 'no data in the 404');
    }
    assert.equal((await get(p, route)).status, 404, route + ' without a token');
    assert.equal((await get(p, route + '?token[]=' + TOKEN)).status, 404);
    assert.equal((await get(p, route + '?token=x&token=' + TOKEN)).status, 404, 'the first token counts, not the last');
    assert.equal((await get(p, route + '?TOKEN=' + TOKEN)).status, 404);
    assert.equal((await get(p, route, { Authorization: 'Bearer ' + TOKEN, 'X-Token': TOKEN })).status, 404, 'a header is not the token');
    assert.equal((await get(p, route + '?token=' + TOKEN, {}, 'POST')).status, 404, 'a read route takes GET only');
  }
  for (const READ_TOKEN of ['', undefined, null, 5]) {
    const q = await platform(t, { env: { READ_TOKEN } });
    for (const g of ['', 'undefined', 'null', '5', '   ', 'x']) for (const route of ['/events.json', '/summary.json', '/tail']) assert.equal((await get(q, route + '?token=' + encodeURIComponent(g))).status, 404, JSON.stringify([READ_TOKEN, g, route]));
  }
  // with the token: data; the tail without an upgrade is 426
  const ok = await get(p, '/events.json?token=' + TOKEN);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).batches.length, 1);
  assert.equal((await get(p, '/tail?token=' + TOKEN)).status, 426);
  assert.equal((await get(p, '/summary.json?token=' + TOKEN)).status, 200);
  for (const bad of ['since=b:1', 'since=x', 'sid=ABC', 'sid=k3m8k3m8k3m0', 'who=A@b.c', 'who=' + 'x'.repeat(25)]) assert.equal((await get(p, '/events.json?token=' + TOKEN + '&' + bad)).status, 400, bad);
  assert.deepEqual(core.parseEventsQuery(new URLSearchParams('limit=999999999')).query.limit, 1000);
  assert.deepEqual(core.parseEventsQuery(new URLSearchParams('limit=-5')).query.limit, 200);
  assert.deepEqual(core.parseEventsQuery(new URLSearchParams('limit=0')).query.limit, 1);
  assert.deepEqual(core.parseSummaryQuery(new URLSearchParams('hours=99999')).query.hours, 168);
});

test('STOPPED F9: a READ_TOKEN of fewer than 24 characters is taken for none: "x", three spaces and 23 characters open nothing, and 24 open the read routes and the tail (the token is also in the query string of every read, which the README says)', async (t) => {
  for (const weak of ['x', '   ', '1234', 'w'.repeat(23)]) {
    const p = await platform(t, { env: { READ_TOKEN: weak } });
    await post(p, sample());
    for (const route of ['/events.json', '/summary.json']) assert.equal((await get(p, route + '?token=' + encodeURIComponent(weak))).status, 404, JSON.stringify(weak) + ' ' + route);
    assert.equal((await get(p, '/tail?token=' + encodeURIComponent(weak))).status, 404, 'not even the 426');
  }
  const exact = 'w'.repeat(24);
  const p = await platform(t, { env: { READ_TOKEN: exact } });
  await post(p, sample());
  for (const route of ['/events.json', '/summary.json']) assert.equal((await get(p, route + '?token=' + exact)).status, 200, route);
  assert.equal((await get(p, '/tail?token=' + exact)).status, 426);
});

test('STOPPED: the token compare has no early exit: the same number of character reads for a guess that differs in the first character, the last, or everywhere (the time does not say where it differs)', async (t) => {
  const p = await platform(t);
  const reads = (guess) => {
    const orig = String.prototype.charCodeAt;
    let n = 0;
    String.prototype.charCodeAt = function (i) { n++; return orig.call(this, i); };
    let pending;
    try { pending = get(p, '/events.json?token=' + guess); } finally { String.prototype.charCodeAt = orig; }
    return pending.then((res) => { assert.equal(res.status, 404); return n; });
  };
  const L = TOKEN.length;
  const firstWrong = 'X' + TOKEN.slice(1);
  const lastWrong = TOKEN.slice(0, -1) + 'X';
  const allWrong = 'X'.repeat(L);
  const counts = [await reads(firstWrong), await reads(lastWrong), await reads(allWrong), await reads('X'.repeat(L - 5))];
  assert.ok(counts[0] > L, 'the compare reads characters: ' + counts[0]);
  assert.deepEqual([counts[1], counts[2], counts[3]], [counts[0], counts[0], counts[0]], 'reads: ' + counts.join(','));
});

test('STOPPED: what is stored, read back and pushed to a tail socket has been masked again by the Worker, whatever a program sent (addresses, ports, fragments, codes, hashes, control characters)', async (t) => {
  const p = await platform(t);
  const ws = fakeWs();
  await p.obj.accept(ws);
  const hostile = [
    'peer ' + IP4 + ':8443 up', 'wss://u:p@' + IP4 + ':443/a?k=1#frag-secret', '[' + IP6 + ']:51234', '192' + ch(0x200d) + '.168.0.1',
    ch(0xff11) + ch(0xff19) + ch(0xff12) + ch(0xff0e) + ch(0xff11) + ch(0xff16) + ch(0xff18) + ch(0xff0e) + ch(0xff10) + ch(0xff0e) + ch(0xff11), 'code abcd-efgh-2345', 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12',
    '\u001b[2J\u001b]0;pwn\u0007 hi', 'a=candidate:1 1 udp 1 203.0.113.9 51472 typ srflx raddr 192.168.1.5 rport 51472', 'x'.repeat(30000),
  ];
  const events = hostile.map((m, i) => ({ t: i, n: 'log', m }));
  const res = await post(p, sample({ events }));
  assert.equal(res.status, 204);
  const frame = JSON.stringify(ws.sent);
  const stored = JSON.stringify(p.rows());
  const read = await (await get(p, '/events.json?token=' + TOKEN)).text();
  for (const [where, text] of [['stored', stored], ['read', read], ['tail', frame]]) {
    for (const secret of [IP4, '8443', 'frag-secret', '2001:db8', '8a2e', '168.0.1', '192.168', 'efgh', '2345', 'ef56ab12', '51472', '203.0.113.9', '\u001b', 'pwn\u0007']) assert.ok(!text.includes(secret), where + ' holds ' + JSON.stringify(secret));
  }
  for (const e of p.rows()[0].body.events) assert.ok(e.m.length <= 200 && !/[\u0000-\u001f]/.test(e.m), 'cut and clean: ' + e.m.length);
});

test('STOPPED: JSON that is deep, wide, huge or repeated cannot get past the checks: depth, 2500 keys, a 30000 character string, duplicate keys, 1e999, __proto__ and constructor keys', async (t) => {
  const p = await platform(t);
  const code = async (body) => { const r = await post(p, body); return [r.status, await word(r)]; };
  assert.deepEqual(await code('['.repeat(16000) + ']'.repeat(16000)), [400, 'shape']);
  assert.deepEqual(await code('{"a":'.repeat(5000) + '1' + '}'.repeat(5000)), [400, 'version']);
  const deepField = JSON.stringify(sample({ events: [{ t: 1, n: 'a.b', f: 1 }] })).replace('"f":1', '"f":' + '['.repeat(3000) + ']'.repeat(3000));
  assert.deepEqual(await code(deepField), [400, 'value']);
  const wide = '{' + Array.from({ length: 2500 }, (_, i) => '"k' + i + '":1').join(',') + '}';
  assert.deepEqual(await code(wide), [400, 'version']);
  const wideEvent = JSON.stringify(sample({ events: [{ t: 1, n: 'a.b' }] })).replace('"n":"a.b"', '"n":"a.b",' + Array.from({ length: 2000 }, (_, i) => '"k' + i + '":1').join(','));
  assert.deepEqual(await code(wideEvent), [400, 'keys']);
  const huge = await post(p, sample({ events: [{ t: 1, n: 'a.b', m: 'y'.repeat(30000) }] }));
  assert.equal(huge.status, 204);
  assert.equal(p.rows()[0].body.events[0].m.length, 200);
  // duplicate keys: the last one wins, in the check and in what is stored (nothing is checked on one and stored from the other)
  const dupBad = JSON.stringify(sample()).replace('"sid":"' + SID + '"', '"sid":"' + SID + '","sid":"BAD"');
  assert.deepEqual(await code(dupBad), [400, 'sid']);
  const dupOk = JSON.stringify(sample({ seq: 5 })).replace('"sid":"' + SID + '"', '"sid":"BAD","sid":"' + sidOf(7) + '"');
  assert.equal((await post(p, dupOk)).status, 204);
  assert.equal(p.rows().at(-1).sid, sidOf(7));
  const dupField = JSON.stringify(sample({ seq: 6, sid: sidOf(8), events: [{ t: 1, n: 'a.b', m: 'safe' }] })).replace('"m":"safe"', '"m":"' + IP4 + '","m":"safe"');
  assert.equal((await post(p, dupField)).status, 204);
  assert.equal(p.rows().at(-1).body.events[0].m, 'safe');
  const dupMask = JSON.stringify(sample({ seq: 7, sid: sidOf(9), events: [{ t: 1, n: 'a.b', m: 'safe' }] })).replace('"m":"safe"', '"m":"safe","m":"' + IP4 + '"');
  assert.equal((await post(p, dupMask)).status, 204);
  assert.equal(p.rows().at(-1).body.events[0].m, 'x.x.x.x', 'the last duplicate is the one that is masked');
  assert.deepEqual(await code(JSON.stringify(sample()).replace('"t":1', '"t":1e999')), [400, 'time']);
  // prototype keys
  const protoTop = JSON.stringify(sample({ seq: 8, sid: sidOf(10) })).replace('{"v":1', '{"__proto__":{"polluted":"' + IP4 + '"},"constructor":{"prototype":{"polluted":1}},"v":1');
  assert.equal((await post(p, protoTop)).status, 204);
  assert.equal(({}).polluted, undefined);
  const last = p.rows().at(-1);
  assert.ok(!Object.prototype.hasOwnProperty.call(last.body, '__proto__') && !('polluted' in last.body) && !JSON.stringify(last).includes('polluted'));
  const protoEvent = JSON.stringify(sample({ seq: 9, sid: sidOf(11) })).replace('"n":"gate.shown"', '"n":"gate.shown","__proto__":{"polluted":1}');
  assert.deepEqual(await code(protoEvent), [400, 'key']);
  const ctorEvent = JSON.stringify(sample({ seq: 10, sid: sidOf(12) })).replace('"n":"gate.shown"', '"n":"gate.shown","constructor":"plain","toString":"plain","hasOwnProperty":"plain"');
  assert.equal((await post(p, ctorEvent)).status, 204, 'a field named constructor is only a field');
  assert.equal(({}).constructor, Object);
  // an event named like an Object member is only a name in the summary
  assert.equal((await post(p, sample({ seq: 11, sid: sidOf(13), events: [{ t: 1, n: 'constructor' }, { t: 2, n: 'valueof' }] }))).status, 204);
  const summary = await (await get(p, '/summary.json?token=' + TOKEN)).json();
  assert.equal(summary.names.constructor, 1);
  assert.equal(Object.getPrototypeOf(summary.names), Object.prototype);
});

test('STOPPED: who is null or a short [a-z0-9-] word: an e-mail address, a name with a dot or a space, and 25 characters are refused', async (t) => {
  const p = await platform(t);
  for (const who of ['pat.example@example.com', 'Pat', 'zorblat quux', 'zor.blat', 'x'.repeat(25), '203.0.113.5', '2001:db8::1']) assert.equal((await post(p, sample({ who }))).status, 400, who);
  assert.equal((await post(p, sample({ who: 'da9u-6qug' }))).status, 204);
});

test('STOPPED F4: the Worker takes who, loader, site and net only in the shapes the reporters write: a name, an address, a longer id and a word that navigator.connection does not have are 400 with the word of the field', async (t) => {
  const p = await platform(t);
  let seq = 0;
  for (const [over, reason] of [
    [{ who: 'zorblat-quux' }, 'who'], [{ loader: IP4 }, 'loader'], [{ net: { type: 'abcdefgh2345', effectiveType: '4g' } }, 'net'],
    [{ net: { type: 'wifi', effectiveType: '198-51-100-7' } }, 'net'], [{ site: 'd680ff36deadbeef' }, 'site'],
  ]) {
    const res = await post(p, sample(Object.assign({ seq: seq++ }, over)));
    assert.deepEqual([res.status, await word(res)], [400, reason], JSON.stringify(over));
  }
  assert.equal(p.rows().length, 0);
  const ok = await post(p, sample({ seq: seq++, who: 'da9u-6qug', loader: '0.3.0', site: 'd680ff36', net: { type: 'wifi', effectiveType: '4g' } }));
  assert.equal(ok.status, 204);
  assert.deepEqual([p.rows()[0].body.who, p.rows()[0].body.loader, p.rows()[0].body.site], ['da9u-6qug', '0.3.0', 'd680ff36']);
});

test('STOPPED F11: a batch sent twice (the same session, number and text, as a retry does) is answered 204 and stored once, and the summary counts it once; the same number with other text is a new batch', async (t) => {
  const p = await platform(t);
  const b = sample({ seq: 3 });
  assert.equal((await post(p, b)).status, 204);
  assert.equal((await post(p, b)).status, 204);
  assert.equal(p.rows().length, 1);
  const summary = await (await get(p, '/summary.json?token=' + TOKEN)).json();
  assert.deepEqual([summary.batches, summary.events], [1, 1], 'counted once');
  assert.equal((await post(p, sample({ seq: 3, events: [{ t: 9, n: 'a.b' }] }))).status, 204);
  assert.equal(p.rows().length, 2, 'other text under the same number is kept, for the reader to judge');
});

test('STOPPED: the front reads only the request headers Origin, Content-Type, Content-Length and Upgrade; no client address header, no request.cf, no console; it sends the object the text of the batch and no header of the sender', async (t) => {
  const front = read('deploy/obs-worker/worker.js').split('// ===== front: begin')[1].split('// ===== front: end')[0];
  const names = new Set([...front.matchAll(/headers\.get\('([^']+)'\)/g)].map((m) => m[1].toLowerCase()));
  assert.deepEqual([...names].sort(), ['content-length', 'content-type', 'origin', 'retry-after', 'upgrade']);
  assert.ok(!/cf-connecting-ip|x-forwarded-for|x-real-ip|\.cf\b|console\./i.test(read('deploy/obs-worker/worker.js').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no address read in worker.js outside comments');
  assert.ok(!/cf-connecting-ip|x-forwarded-for|request\.cf|console\./i.test(read('deploy/obs-worker/obs-core.js').replace(/^\s*\/\/.*$/gm, '')), 'none in obs-core.js');
  // what the object is handed for a report: a fresh request with one header, whatever the sender added
  const p = await platform(t);
  const seen = [];
  p.env.OBS.get = () => ({ fetch: async (req) => { seen.push({ headers: Array.from(req.headers.keys()), text: await req.text() }); return new Response(null, { status: 204 }); } });
  const res = await post(p, sample(), { headers: { 'CF-Connecting-IP': IP4, 'X-Forwarded-For': IP4, Cookie: 'a=b', Referer: 'https://site.example/secret/path', 'User-Agent': 'Mozilla/5.0 Special' } });
  assert.equal(res.status, 204);
  assert.deepEqual(seen[0].headers, ['content-type']);
  assert.ok(!seen[0].text.includes(IP4));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the cost of a hostile body, and where the checks run (finding F2)
// ---------------------------------------------------------------------------------------------------------------------------------

/** bodyOf(piece, perString) -> the largest body of 15 or so events (at most 32768 bytes) whose one text field is piece repeated to perString characters. */
function bodyOf(piece, perString) {
  const value = piece.repeat(Math.ceil(perString / piece.length)).slice(0, perString);
  const events = [];
  let text = '';
  for (;;) {
    events.push({ t: events.length, n: 'log', m: value });
    const next = JSON.stringify(sample({ events }));
    if (next.length > 32768 || events.length >= 100) { events.pop(); break; }
    text = next;
  }
  return text;
}

const bestOf = (n, fn) => {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
};

test('STOPPED F2: a body of "#1" repeated, within the 32768 byte limit, costs the endpoint about what a body of ordinary text of the same size costs, and the cost no longer grows with the square of the length of one string (cutFragment reads the word in front of each # once)', () => {
  const ordinary = bodyOf('abcdefghij', 2000);
  const hash2000 = bodyOf('#1', 2000);
  const hash500 = bodyOf('#1', 500);
  for (const text of [ordinary, hash2000, hash500]) assert.ok(text.length <= 32768 && core.parseBatchText(text).ok);
  core.parseBatchText(hash2000);
  const msOrdinary = bestOf(9, () => core.parseBatchText(ordinary));
  const ms2000 = bestOf(9, () => core.parseBatchText(hash2000));
  assert.ok(ms2000 < msOrdinary * 8 + 1, 'hash bomb ' + ms2000.toFixed(2) + ' ms against ordinary ' + msOrdinary.toFixed(2) + ' ms (before the fix it was 20 times)');
  // The work counted and not timed: the characters each layer hands to a regular expression test for one string of 1000 "#1".
  const real = RegExp.prototype.test;
  for (const n of NAMES) {
    let chars = 0;
    RegExp.prototype.test = function (s) { chars += String(s).length; return real.call(this, s); };
    try { LAYERS[n]('#1'.repeat(1000)); } finally { RegExp.prototype.test = real; }
    assert.ok(chars < 20000, n + ' read ' + chars + ' characters (reading everything before each # again was about a million)');
  }
});

test('STOPPED F2: once the day total is reached the object answers 429 day-all before it parses the body, whatever the body is; below the cap the front still reads no JSON, so a body that is not JSON from an allowed Origin reaches the object and is 400 there (DESIGN: the Origin is the front\'s one gate)', async (t) => {
  const front = read('deploy/obs-worker/worker.js').split('// ===== front: begin')[1].split('// ===== front: end')[0];
  assert.ok(!/validateBatch|parseBatchText|maskString|JSON\.parse/.test(front), 'the front does no validation');
  const p = await platform(t, { objectEnv: { MAX_BATCHES_PER_DAY: '3' } });
  for (let i = 0; i < 3; i++) assert.equal((await post(p, sample({ sid: sidOf(i) }))).status, 204);
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = function (...a) { parses++; return parse.apply(this, a); };
  const before = p.forwarded.length;
  try {
    for (const body of [bodyOf('#1', 2000), 'not json at all']) {
      const res = await post(p, body);
      assert.deepEqual([res.status, await word(res)], [429, 'day-all']);
    }
  } finally {
    JSON.parse = parse;
  }
  assert.equal(parses, 0, 'no body was parsed once the day was full');
  assert.equal(p.forwarded.length, before + 2, 'they did wake the object: the front cannot know the count');
  const q = await platform(t);
  const n = q.forwarded.length;
  assert.equal((await post(q, 'not json at all')).status, 400);
  assert.equal(q.forwarded.length, n + 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the loader page: consent, with the real app.js on a fake window, and spies on every path a report could take
// ---------------------------------------------------------------------------------------------------------------------------------

const OBS_BLOCK = { endpoint: 'https://obs.example.test' };
const APPS_BLOCK = { rendezvous: ['wss://rendezvous.example.test/announce'], stun: ['stun:stun.example.test:3478'], idp: 'https://id.example.test' };
const BTIH = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const flushTurn = () => new Promise((resolve) => setImmediate(resolve));

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
    const self = this;
    const list = () => String(self.className || '').split(/\s+/).filter(Boolean);
    const add = (...c) => { self.className = Array.from(new Set(list().concat(c))).join(' '); };
    const remove = (...c) => { self.className = list().filter((x) => c.indexOf(x) < 0).join(' '); };
    return { add, remove, toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want !== has) { if (want) add(c); else remove(c); } return want; }, contains: (c) => list().indexOf(c) >= 0 };
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
function node(doc, parent, tag, attrs = {}, text = null) {
  const el = doc.createElement(tag, attrs);
  if (attrs.class) el.className = attrs.class;
  if (text !== null) el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** spies() -> counts of every network path a report can take: the global fetch (the reporter's first choice, answered 204 here, its body text kept to be read) and the sendBeacon of the page's navigator (its blobs kept the same way). */
function spies() {
  const s = { fetch: [], beacon: [], blobs: [], bodies: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { s.fetch.push([url, init]); s.bodies.push(String(init && init.body)); return Promise.resolve({ ok: true, status: 204 }); };
  s.sendBeacon = (url, blob) => { s.beacon.push(url); s.blobs.push(blob); return true; };
  s.restore = () => { globalThis.fetch = realFetch; };
  s.total = () => s.fetch.length + s.beacon.length;
  s.texts = async () => (await Promise.all(s.blobs.map((b) => b.text()))).concat(s.bodies);
  s.batches = async () => (await s.texts()).map((t) => JSON.parse(t));
  return s;
}

let instance = 0;
/** runHub(opts, spy) -> the page after run(): a wildcard hub's landing page, the shortest road through run(); its own transport is the default one (no send is injected). */
async function runHub({ json = doorJsonWith({ obs: OBS_BLOCK }), fetchFail = false, spy, host = 'hub.example.test' } = {}) {
  const loop = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
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
    location: { origin: (loop ? 'http://' : 'https://') + host, protocol: loop ? 'http:' : 'https:', host, hostname: host.replace(/:\d+$/, ''), port: (/:(\d+)$/.exec(host) || [])[1] || '', pathname: '/', search: '', hash: '', href: (loop ? 'http://' : 'https://') + host + '/' },
    navigator: { language: 'en-CA', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36', sendBeacon: spy ? spy.sendBeacon : undefined },
    fetch: fetchOf(json, { fail: fetchFail }),
    addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    console: { error() {}, warn() {}, log() {} },
    crypto: globalThis.crypto,
    __mwBoot: { ok: true, stage: 'import', soft: { webrtc: false, serviceWorker: false }, features: {}, missing: [], polyfilled: ['toHex'], t0: Date.now() - 40, csp: 'normal', cspKind: 'normal', degraded: false, dev: false, swProbe: null },
  };
  doc.defaultView = win;
  win.events = events;
  const mod = await import('../../src/loader/app.js?obs-adversary-' + (++instance));
  const A = await mod.default({ window: win, obs: { random: () => 0.5 } });
  return { A, win, doc, root, events };
}

/** consentPage(opts) -> runHub plus what setConsent needs: the environment of a computer and a cache that stores nothing. */
async function consentPage(opts) {
  const run = await runHub(opts);
  const { A } = run;
  A.env = detectEnvironment({ battery: null });
  A.record = null;
  A.deps.cache = Object.assign({}, A.deps.cache, { setPref: async (k, v) => { A.stored = A.stored || {}; A.stored[k] = v; }, getPref: async (k, d) => d, requestPersist: async () => true });
  A.deps = Object.assign({}, A.deps, { cache: A.deps.cache });
  __obs.installSettings(A);
  return run;
}

/** hide(run): what a browser does when the page goes away: pagehide on the window and a hidden visibilitychange on the document. */
function hide(run) {
  for (const fn of run.events.get('pagehide') || []) fn({ type: 'pagehide' });
  run.doc.visibilityState = 'hidden';
  run.doc.dispatchEvent({ type: 'visibilitychange' });
  run.doc.visibilityState = 'visible';
}

/** stir(run): everything a visitor and the page can do that would be reported if reports were on. */
function stir(run, tag = 'x') {
  const { A, root, doc } = run;
  A.log('stir ' + tag + ' peer ' + IP4 + ':51234 answered');
  A.report('ui.click', { id: 'b-' + tag });
  const b = node(doc, root, 'button', { id: 'stir-' + tag }, 'Press ' + tag);
  root.dispatchEvent({ type: 'click', target: b, isTrusted: true });
  const e = run.events.get('error');
  if (e && e[0]) e[0]({ message: 'error ' + tag + ' at https://' + IP4 + ':8443/app.js?token=abc' });
  hide(run);
}

test('CONSENT: a page whose door.json has no obs block (none, apps only, null, a bad one, no door.json at all) has no reporter and makes no fetch or beacon beyond the one read of its own door.json, whatever happens on it', async () => {
  const s = spies();
  try {
    const bad = [{ json: doorJsonWith() }, { json: doorJsonWith({ apps: APPS_BLOCK }) }, { json: doorJsonWith({ obs: null }) }, { json: doorJsonWith({ obs: { endpoint: 'http://obs.example.test' } }) },
      { json: doorJsonWith({ obs: { endpoint: 'https://obs.example.test/e?x=1#f' } }) }, { json: doorJsonWith({ obs: 'https://obs.example.test' }) }, { fetchFail: true }, { json: '<html>blocked</html>' }];
    for (const over of bad) {
      const run = await runHub(Object.assign({ spy: s }, over));
      assert.equal(run.A.obs, null, JSON.stringify(Object.keys(over)));
      assert.equal(run.win.__mwShell.inspect().obs, null);
      assert.ok(run.win.fetch.seen.every(([url]) => url === 'https://hub.example.test/_mw/door.json'), 'only its own door.json was read');
      stir(run, 'none');
    }
    assert.equal(s.total(), 0);
  } finally { s.restore(); }
});

test('CONSENT: with a block, before the visitor says yes: not one fetch or beacon on log lines, clicks, errors, pagehide or a hidden tab, and the events wait in memory', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    assert.equal(A.obs.inspect().allowed, false);
    const queued = A.obs.inspect().queued;
    assert.ok(queued > 3);
    __obs.syncReports(A); // what run() does after it has read the stored choice: nothing is decided, so nothing may start
    assert.equal(A.obs.inspect().allowed, false);
    for (let i = 0; i < 5; i++) stir(run, 'pre' + i);
    A.obs.flush('timer'); A.obs.flush('test'); A.obs.flush('hide'); A.obs.flush('stop');
    assert.equal(s.total(), 0);
    assert.ok(A.obs.inspect().queued > queued, 'they waited');
    assert.equal(A.obs.inspect().sent, 0);
    // "Not now" and Cancel settle the waiters with pending and decide nothing
    A.consentWaiters.settle('pending');
    stir(run, 'cancel');
    assert.equal(s.total(), 0);
    assert.equal(A.obs.inspect().allowed, false);
  } finally { s.restore(); }
});

test('CONSENT: "Load from host only" drops what waited and nothing leaves then or later (a hidden tab, pagehide, new events); "Share and load" later starts a clean session', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    stir(run, 'a');
    await __obs.setConsent(A, 'host-only');
    assert.equal(A.obs.inspect().queued, 0);
    assert.equal(A.reportsBlocked, true);
    for (let i = 0; i < 3; i++) stir(run, 'b' + i);
    A.obs.flush('hide'); A.obs.flush('test');
    assert.equal(s.total(), 0);
    await __obs.setConsent(A, 'accepted');
    A.log('later ' + IP4);
    A.obs.flush('test');
    assert.equal(s.fetch.length, 1);
    const names = (await s.batches()).flatMap((b) => b.events.map((e) => e.n));
    assert.ok(!names.includes('boot.start'), 'what happened before the no is not sent after the yes');
  } finally { s.restore(); }
});

test('CONSENT: "Share and load" sends a text/plain request to <endpoint>/e and nothing else; the Settings switch turned off afterwards stops everything at once (queue empty, no fetch, no beacon, not on hide) and turned on again sends only what happens after', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    stir(run, 'pre');
    await __obs.setConsent(A, 'accepted');
    A.obs.flush('test');
    assert.equal(s.fetch.length, 1, 'a cors fetch with keepalive: the real Origin, an answer');
    assert.equal(s.fetch[0][0], 'https://obs.example.test/e');
    assert.equal(s.fetch[0][1].headers['content-type'], 'text/plain');
    assert.equal(s.beacon.length, 0, 'no beacon while fetch works: a no-cors beacon carries Origin null under no-referrer');
    const sent = s.total();
    await __obs.changeSetting(A, 'reports', { on: false });
    assert.equal(A.prefs.reports, 'off');
    assert.equal(A.obs.inspect().allowed, false);
    assert.equal(A.obs.inspect().queued, 0);
    for (let i = 0; i < 3; i++) stir(run, 'off' + i);
    A.obs.flush('hide'); A.obs.flush('test');
    assert.equal(s.total(), sent, 'nothing after the switch');
    assert.equal(A.obs.inspect().queued, 0);
    await __obs.changeSetting(A, 'reports', { on: true });
    A.log('after on');
    A.obs.flush('test');
    assert.equal(s.total(), sent + 1);
    const last = (await s.batches()).at(-1);
    assert.ok(last.events.some((e) => e.n === 'log' && e.m === 'after on'));
    assert.ok(!last.events.some((e) => /off\d/.test(String(e.m || '')) || e.id === 'stir-off0'), 'the events of the time it was off are not sent');
  } finally { s.restore(); }
});

test('CONSENT: a returning visitor with a stored yes and the switch off sends nothing, one with a stored host-only sends nothing, and the door page\'s apps path (consent state accepted, no first yes) sends nothing until the price card is continued', async () => {
  const s = spies();
  try {
    for (const [state, reports, want] of [['accepted', 'off', 0], ['host-only', 'on', 0], ['pending', 'on', 0], ['pending', 'off', 0], ['accepted', 'on', 1]]) {
      const run = await runHub({ spy: s });
      const before = s.total();
      run.A.consentState = state;
      run.A.prefs.reports = reports;
      __obs.syncReports(run.A);
      stir(run, state + reports);
      run.A.obs.flush('test');
      assert.equal(s.total() - before >= 1 ? 1 : 0, want, JSON.stringify([state, reports]));
    }
    // the door page with apps: runDoorApps sets firstYes false, and loadAppsTm sets consentState accepted without any card
    const run = await runHub({ spy: s });
    const before = s.total();
    run.A.firstYes = false;
    run.A.consentState = 'accepted';
    __obs.syncReports(run.A);
    stir(run, 'door');
    run.A.obs.flush('test');
    assert.equal(s.total(), before, 'no first yes: nothing');
    assert.equal(run.A.obs.inspect().allowed, false);
    __obs.firstYes(run.A);
    run.A.obs.flush('test');
    assert.equal(s.total(), before + 1, 'after the first yes it goes');
    // and a visitor who switched the reports off never starts them by continuing a card
    const off = await runHub({ spy: s });
    const b2 = s.total();
    off.A.firstYes = false;
    off.A.prefs.reports = 'off';
    __obs.firstYes(off.A);
    stir(off, 'off');
    off.A.obs.flush('test');
    assert.equal(s.total(), b2);
  } finally { s.restore(); }
});

test('PRIVACY: after the yes, the log mirror, the error listeners and the console carry no address, port, URL path or fragment, full infohash or pair code; the lines of the page itself are in the batch, masked', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    await __obs.setConsent(A, 'accepted');
    const lines = [
      'peer ' + IP4 + ':51234 and [' + IP6 + ']:443 answered',
      'status downloading https://host.example/_mw/ws/secret-site/private-file.html?token=abc#frag-secret',
      'tracker wss://user:pw@tracker.example:8443/announce?key=k#t open',
      'doors: web seeds https://' + IP4 + ':8443/seed/inner-name.bin, https://[2001:db8::1]:8443/x',
      'code abcd-efgh-2345 was opened',
      'ICE servers stun:' + IP4 + ':3478 stun:stun.example.test:3478',
      'a=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host',
      'pointer shell btih=' + BTIH + ' ledger=btih:' + BTIH,
      'door.json: failed to fetch https://door.example/_mw/door.json?v=1#x',
    ];
    for (const l of lines) A.log(l);
    run.events.get('error')[0]({ message: 'Uncaught TypeError at https://' + IP4 + ':8443/app.js?token=abc#frag-secret' });
    run.events.get('unhandledrejection')[0]({ reason: new Error('failed for [' + IP6 + ']:443 code abcd-efgh-2345') });
    A.win.console.error('[mw ui]', new Error('card broke at ' + IP4));
    __obs.noteSetting(A, 'exportIdentity', { passphrase: 'correct horse battery staple', on: undefined });
    A.obs.flush('test');
    let guard = 0;
    while (A.obs.inspect().queued > 0 && guard++ < 50) A.obs.flush('test');
    // the text values of the events (a number such as a timestamp may hold 2345 by chance)
    const text = (await s.batches()).flatMap((b) => b.events).flatMap((e) => Object.values(e)).filter((v) => typeof v === 'string').join('\n');
    for (const secret of [IP4, '51234', '2001:db8', '8443', 'secret-site', 'private-file', 'frag-secret', 'efgh', '2345', 'user:pw', 'inner-name', '192.168.1.5', '54321', BTIH, 'horse', 'staple', '?token', 'key=k']) assert.ok(!text.includes(secret), JSON.stringify(secret) + ' reached a batch');
    const logs = (await s.batches()).flatMap((b) => b.events).filter((e) => e.n === 'log' || e.n === 'error').map((e) => e.m);
    assert.ok(logs.includes('peer x.x.x.x and x.x.x.x answered'));
    assert.ok(logs.includes('status downloading https://host.example'));
    assert.ok(logs.includes('code abcd was opened'));
    assert.ok(logs.includes('pointer shell btih=ab12cd34... ledger=btih:ab12cd34...'));
  } finally { s.restore(); }
});

/** logCalls(src) -> the text between the parentheses of every A.log( call of a source file (strings and nested calls are skipped over, so a parenthesis inside a message does not end it). */
function logCalls(src) {
  const calls = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('A.log(', from);
    if (at < 0) return calls;
    let depth = 0;
    let i = at + 5;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      } else if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(src.slice(at + 6, i));
    from = i;
  }
}

test('STOPPED F1: the loader\'s own log lines that name a file of the site are reported without it: the ring keeps the whole line for the person who reads it, and the batch gets the line without the file (a stored copy found incomplete, a stored file that fails its check, the worker saying a stored copy is unusable)', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    await __obs.setConsent(A, 'accepted');
    A.btih = BTIH;
    const cache = { getSite: async () => ({ complete: true, torrentFile: new Uint8Array([1]), files: [{ path: '/family/diary-2026.html', length: 5 }] }), getFile: async () => null, deleteSite: async () => {}, touchSite: async () => {} };
    A.deps = Object.assign({}, A.deps, { cache: Object.assign({}, A.deps.cache, cache), verify: { verifyInfoHash: async () => true } });
    assert.equal(await __obs.lookupCache(A), null);
    A.obs.flush('test');
    const text = (await s.texts()).join('\n');
    assert.ok(!text.includes('/family/diary-2026.html') && !text.includes('diary'), 'the path of a site file is not in the batch');
    assert.ok((await s.batches()).flatMap((b) => b.events).some((e) => e.n === 'log' && e.m === 'cached copy incomplete'), 'the line is there, without the file');
    assert.ok(A.ui.diagnostics.lines().some((l) => l.endsWith('cached copy incomplete at /family/diary-2026.html')), 'the ring keeps the whole line');
    // The mechanism: a line with a report text is mirrored as that text; a line without one is mirrored as it is.
    A.log('looked at /secret/path.html just now', { report: 'looked at a file' });
    A.log('looked at nothing');
    A.log('looked at /secret/other.html', { report: 5 });
    A.obs.flush('test');
    const logs = (await s.batches()).flatMap((b) => b.events).filter((e) => e.n === 'log').map((e) => e.m);
    assert.ok(logs.includes('looked at a file') && logs.includes('looked at nothing'));
    assert.ok(!logs.includes('looked at /secret/path.html just now'), 'the line with a report text is not mirrored as it is');
    assert.ok(logs.includes('looked at /secret/other.html'), 'a report text that is not a string is not used: the line is then reported as it is, which is why the call sites below are scanned');
    // The other two lines need a service worker and a failed verification to run, so they are read from the source: every A.log call of app.js
    // that holds a path carries a report text, and the report text holds none.
    const calls = logCalls(read('src/loader/app.js'));
    const named = calls.filter((c) => /(?:\.|\b)path\b/.test(c.replace(/\{ report: [^}]*\}\s*$/, '')));
    assert.ok(named.length >= 3, 'the scan found the three lines: ' + named.length);
    for (const c of named) {
      const m = /\{ report: ([^}]*)\}\s*$/.exec(c);
      assert.ok(m, 'a log line that names a path has no report text: ' + c.slice(0, 120));
      assert.ok(!/\bpath\b/.test(m[1]), 'the report text of ' + c.slice(0, 60) + ' names a path');
    }
  } finally { s.restore(); }
});

test('STOPPED F1 (the same class): an error text of the cache, the download or the engine can name a file of the site, so the log lines that print one are reported without it (saveSite failed, download failed, a torrent warning, seedFromCache failed, a copy fetched for another tab)', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    await __obs.setConsent(A, 'accepted');
    const path = '/family/diary-2026.html';
    A.ui = Object.assign({}, A.ui, { setStatus() {}, showError() {}, setBanner() {} });
    __obs.presentDownloadError(A, Object.assign(new Error('Could not read the downloaded files: file missing from the torrent: ' + path), { code: 'E_BAD_TORRENT' }));
    __obs.presentDownloadError(A, new Error('no code, and the file ' + path));
    __obs.onTorrentWarning(A, { code: 'seed-error', message: 'missing file data for ' + path });
    __obs.onTorrentWarning(A, { code: 'xs-failed', reason: 'Failed to fetch ' + path });
    __obs.onTorrentWarning(A, { code: 'webseed-broken', reason: 'no-range' });
    A.deps = Object.assign({}, A.deps, { cache: Object.assign({}, A.deps.cache, { saveSite: async () => { throw new Error('saveSite: no data for ' + path); } }) });
    assert.equal(await __obs.persistSite(A, { manifest: { btih: BTIH }, blobs: new Map() }), false);
    A.obs.flush('test');
    let guard = 0;
    while (A.obs.inspect().queued > 0 && guard++ < 50) A.obs.flush('test');
    const logs = (await s.batches()).flatMap((b) => b.events).filter((e) => e.n === 'log').map((e) => e.m);
    assert.ok(!(await s.texts()).join('\n').includes('diary'), 'the file is in no batch');
    for (const want of ['download failed: E_BAD_TORRENT', 'download failed: error', 'warning seed-error', 'warning xs-failed (error)', 'warning webseed-broken (no-range)', 'saveSite failed']) assert.ok(logs.includes(want), want + ' is in the log events: ' + JSON.stringify(logs.slice(-8)));
    const ring = A.ui.diagnostics.lines().join('\n');
    assert.ok(ring.includes('file missing from the torrent: ' + path) && ring.includes('missing file data for ' + path) && ring.includes('saveSite: no data for ' + path), 'the visitor\'s own log keeps the whole lines');
    // the two lines that cannot run here (the engine of the leader tab and the copy for another tab) are read from the source
    const calls = logCalls(read('src/loader/app.js'));
    const printing = calls.filter((c) => /seedFromCache failed|for another tab: |saveSite failed|download failed|'warning '/.test(c));
    assert.ok(printing.length >= 5, 'the scan found the five lines: ' + printing.length);
    for (const c of printing) assert.match(c, /\{ report: [^}]+\}\s*$/, 'a log line that prints an engine or cache message has no report text: ' + c.slice(0, 100));
  } finally { s.restore(); }
});

test('PRIVACY: the pipeline events (site.*, pointer.*, tracker.state, api.request, signin.*) carry codes, words, counts and host names, whatever the errors say; a typed passphrase, a key file and a nick in the settings never reach a report', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A, root, doc } = run;
    await __obs.setConsent(A, 'accepted');
    A.log = () => {};
    A.ui = Object.assign({}, A.ui, { setStatus() {}, showError() {} });
    __obs.presentDownloadError(A, Object.assign(new Error('could not read /family/diary-2026.html for Ferdle at ' + IP4), { code: 'E_NO_PEERS' }));
    __obs.presentDownloadError(A, new Error('only a message with ' + IP4));
    __obs.presentPointerError(A, Object.assign(new Error('Pointer text for Ferdle'), { code: 'E_POINTER', tried: ['link'] }));
    __obs.presentPointerError(A, Object.assign(new Error('x'), { code: 'Failed to fetch https://' + IP4 + '/a' }));
    const pass = node(doc, root, 'input', { type: 'password', 'aria-label': 'Passphrase' });
    pass.value = 'correct horse battery staple';
    const area = node(doc, root, 'textarea', { 'aria-label': 'Moderator key' });
    area.value = '{"kty":"EC","d":"private-part"}';
    const nick = node(doc, root, 'input', { id: 'mw-apps-nick', type: 'text' });
    nick.value = 'Ferdle Morrow';
    const file = node(doc, root, 'input', { type: 'file' });
    file.value = 'C:\\fakepath\\will-2026.pdf';
    const exportBtn = node(doc, root, 'button', {}, 'Export identity');
    for (const target of [pass, area, nick, file]) for (const type of ['click', 'change', 'input', 'keydown', 'focus', 'blur', 'submit']) root.dispatchEvent({ type, target, isTrusted: true });
    root.dispatchEvent({ type: 'click', target: exportBtn, isTrusted: true });
    await __obs.changeSetting(A, 'exportIdentity', { passphrase: 'correct horse battery staple' }).catch(() => {});
    await __obs.changeSetting(A, 'importIdentity', { text: '{"jwk":"private-part"}', passphrase: 'correct horse battery staple' }).catch(() => {});
    await __obs.changeSetting(A, 'importModerator', { text: '{"kty":"EC","d":"private-part"}' }).catch(() => {});
    A.obs.flush('test');
    let guard = 0;
    while (A.obs.inspect().queued > 0 && guard++ < 50) A.obs.flush('test');
    const text = (await s.texts()).join('\n');
    for (const secret of ['horse', 'staple', 'private-part', 'kty', 'Ferdle', 'Morrow', 'will-2026', 'fakepath', 'diary', IP4, 'Pointer text']) assert.ok(!text.includes(secret), JSON.stringify(secret) + ' reached a batch');
    const events = (await s.batches()).flatMap((b) => b.events);
    assert.deepEqual(events.filter((e) => e.n === 'site.error' || e.n === 'pointer.error').map((e) => e.n + ':' + e.code), ['site.error:E_NO_PEERS', 'site.error:error', 'pointer.error:E_POINTER', 'pointer.error:error']);
    const changes = events.filter((e) => e.n === 'settings.change').map((e) => e.name + ':' + e.value);
    assert.deepEqual(changes, ['exportIdentity:null', 'importIdentity:null', 'importModerator:null']);
    for (const e of events.filter((x) => x.n === 'ui.change')) assert.deepEqual(Object.keys(e).sort(), ['control', 'n', 't'], 'a change in a text field names the control and nothing else');
  } finally { s.restore(); }
});

test('PRIVACY: the loader reports the short id as who and never a name: an e-mail or a capitalised word is refused by noteAuth, the signed-out state is null', async () => {
  const s = spies();
  try {
    const run = await consentPage({ spy: s });
    const { A } = run;
    await __obs.setConsent(A, 'accepted');
    // one request is in flight per flush (a fetch answers on a microtask), so each probe waits for its answer before the next
    const whoAfter = async (snap) => { __obs.noteAuth(A, snap); A.report('probe', {}); A.obs.flush('test'); await new Promise((resolve) => setImmediate(resolve)); };
    await whoAfter({ state: 'signed-in', info: { short: 'pat.example@example.com', name: 'Pat Example' } });
    await whoAfter({ state: 'signed-in', info: { short: 'Pat', name: 'Pat' } });
    await whoAfter({ state: 'signed-in', info: { short: 'da9u-6qug', name: 'Pat Example' } });
    await whoAfter({ state: 'guest', info: null });
    const whos = (await s.batches()).map((b) => b.who);
    assert.deepEqual(whos.slice(-4), [null, null, 'da9u-6qug', null]);
    assert.ok(!(await s.texts()).join('').includes('Pat'), 'the display name is never sent');
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the click walker: what describeTarget may take from a page that shows what people wrote
// ---------------------------------------------------------------------------------------------------------------------------------

test('STOPPED: describeTarget never reads an input, a textarea, a select or an option; a control that shows a person\'s text (dir="auto", or data-obs="off") gives no label, and the prefix of data-fk is all that is kept of its value', () => {
  const doc = new DomDocument();
  const root = node(doc, doc.body, 'div', { id: 'mw-root' });
  const input = node(doc, root, 'input', { type: 'text', id: 'mw-apps-nick' });
  input.value = 'Ferdle Morrow';
  const area = node(doc, root, 'textarea', { 'data-role': 'composer' });
  area.value = 'the will is in the safe';
  for (const el of [input, area]) assert.deepEqual(Object.keys(describeTarget(el)).sort().filter((k) => k === 'text'), []);
  assert.equal(JSON.stringify(describeTarget(input)).includes('Ferdle'), false);
  // a conversation row: the name and the preview are in dir="auto" spans inside the button
  const row = node(doc, root, 'button', { 'data-fk': 'conv:c9f3a1b2', class: 'mw-apps-rowbtn' });
  const main = node(doc, row, 'span');
  node(doc, main, 'span', { dir: 'auto' }, 'Ferdle Morrow');
  node(doc, main, 'span', { dir: 'auto' }, 'the will is in the safe');
  assert.deepEqual(describeTarget(row), { fk: 'conv' }, 'the prefix of the key, not the id after the colon, and no label');
  assert.deepEqual(describeTarget(main.children[0]), { fk: 'conv' }, 'a click on the name itself');
  // a saved snippet: marked data-obs="off"
  const snippet = node(doc, root, 'button', { 'data-role': 'snippet', 'data-obs': 'off' }, 'Use snippet: my home address is 12 Elm St');
  assert.deepEqual(describeTarget(snippet), { role: 'snippet' });
  // a button of the page itself keeps its label up to 24 characters
  const own = node(doc, root, 'button', { id: 'mw-share-btn' }, 'Share and load with everybody');
  assert.deepEqual(describeTarget(own), { id: 'mw-share-btn', text: 'Share and load with ever' });
  // an attribute that holds an address is masked like any string
  const odd = node(doc, root, 'button', { 'data-role': 'peer ' + IP4 + ':443' }, 'Go');
  assert.equal(describeTarget(odd).role, 'peer x.x.x.x');
  // the walk is bounded and never throws
  let deep = root;
  for (let i = 0; i < 400; i++) deep = node(doc, deep, 'div');
  assert.ok(describeTarget(deep).tag === 'div' || describeTarget(deep).id === 'mw-root');
  for (const odder of [null, undefined, {}, { nodeType: 3 }, doc, 5, 'x', { getAttribute() { throw new Error('boom'); } }]) assert.doesNotThrow(() => describeTarget(odder));
});

test('DESIGN F7: a control that shows a person\'s text but carries no dir="auto" or data-obs="off" mark gives its first 24 characters to the click report: only the marks keep a person\'s text out, so a control that shows what a person wrote needs one (CONTRIBUTING.md)', () => {
  const doc = new DomDocument();
  const root = node(doc, doc.body, 'div', { id: 'mw-root' });
  const unmarked = node(doc, root, 'button', { 'data-fk': 'row:1' }, 'Chat with Ferd Morrow in Toronto');
  assert.equal(describeTarget(unmarked).text, 'Chat with Ferd Morrow in', 'by design a button reports its label');
  unmarked.setAttribute('data-obs', 'off');
  assert.equal(describeTarget(unmarked).text, undefined, 'and the mark keeps it out');
});

test('STOPPED F7: a control too large for the search of the mark (more than 40 children, more than 80 nodes, more than 200 ancestors) is taken to hold a person\'s text and gives no label, where the mark could lie past the bound', () => {
  const doc = new DomDocument();
  const root = node(doc, doc.body, 'div', { id: 'mw-root' });
  // 40 children are looked at (the mark is the last), and a button with no mark among them keeps its label
  const forty = node(doc, root, 'button', { 'data-fk': 'row:2' });
  for (let i = 0; i < 39; i++) node(doc, forty, 'span');
  node(doc, forty, 'span', { dir: 'auto' }, 'Ferdle Morrow');
  assert.equal(describeTarget(forty).text, undefined, 'the mark in the 40th child is found');
  const plainForty = node(doc, root, 'button', { 'data-fk': 'row:3' }, 'Share');
  for (let i = 0; i < 40; i++) node(doc, plainForty, 'span');
  assert.equal(describeTarget(plainForty).text, 'Share', '40 children and no mark: the label stays');
  // 41 children: the search cannot cover them, so the label is withheld, the mark behind them or not
  const wide = node(doc, root, 'button', { 'data-fk': 'row:4' }, 'Ferdle Morrow');
  for (let i = 0; i < 40; i++) node(doc, wide, 'span');
  node(doc, wide, 'span', { dir: 'auto' }, 'Ferdle Morrow');
  assert.equal(describeTarget(wide).text, undefined, 'the mark behind 40 siblings is not missed');
  const wideNoMark = node(doc, root, 'button', { 'data-fk': 'row:5' }, 'Share');
  for (let i = 0; i < 41; i++) node(doc, wideNoMark, 'span');
  assert.equal(describeTarget(wideNoMark).text, undefined, 'too many to search: no label');
  // nodes below: plain nodes (the textContent of the fake DOM re-reads every level twice, which is exponential in the depth)
  const plain = (tag, attrs, text, parent) => { const n = { tagName: tag, getAttribute: (k) => (k in attrs ? attrs[k] : null), children: [], parentNode: parent, textContent: text }; if (parent) parent.children.push(n); return n; };
  const chain = (depth, mark) => {
    const top = plain('DIV', { id: 'mw-root' }, '', null);
    const ctl = plain('BUTTON', { 'data-fk': 'row:6' }, 'Share', top);
    let at = ctl;
    for (let i = 0; i < depth; i++) at = plain('SPAN', {}, '', at);
    if (mark) plain('SPAN', { dir: 'auto' }, 'Ferdle Morrow', at);
    return ctl;
  };
  assert.equal(describeTarget(chain(79, false)).text, 'Share', 'the control and 79 nodes below it are 80: searched in full');
  assert.equal(describeTarget(chain(80, false)).text, undefined, '81 nodes: more than the search covers');
  assert.equal(describeTarget(chain(81, true)).text, undefined, 'a mark 81 levels down is not missed');
  // ancestors: a control 205 levels below the root is searched up to 200 of them; the rest is more than it covers
  const deepControl = (levels) => {
    let at = plain('DIV', { id: 'mw-root' }, '', null);
    for (let i = 0; i < levels; i++) at = plain('DIV', {}, '', at);
    return plain('BUTTON', { 'data-fk': 'row:7' }, 'Share', at);
  };
  assert.equal(describeTarget(deepControl(150)).text, 'Share');
  assert.equal(describeTarget(deepControl(205)).text, undefined, 'more ancestors than the walk covers');
});

test('PRIVACY: the apps\' view marks every control that holds a person\'s text: every button of apps-ui.js whose label comes from a name, a title, a preview or a saved snippet sits inside a dir="auto" span or carries data-obs="off"', () => {
  const src = read('src/loader/apps-ui.js');
  // the three controls that wrap person text: the two row buttons and the quote button hold only dir="auto" children for it
  for (const marker of ["class: 'mw-apps-row-name', dir: 'auto'", "class: 'mw-apps-row-prev', dir: 'auto'", "class: 'mw-apps-quote-who', dir: 'auto'", "class: 'mw-apps-quote-text', dir: 'auto'"]) assert.ok(src.includes(marker), marker);
  assert.match(src, /'data-role': 'snippet', 'data-fk': 'snippet:' \+ i, 'data-obs': 'off'/);
  // a button whose label is built from a person's text outside those spots is a new leak: none of the labels is
  const labels = [...src.matchAll(/button\((T\('[^']+', \{[^}]*\}\)|[a-z]+\.[a-z]+)/g)].map((m) => m[1]).filter((l) => /name|title|text|preview|who|nick/i.test(l));
  assert.ok(labels.length >= 1, 'the scan found the snippet button');
  assert.ok(labels.every((l) => l.includes('snippetUse') || l.includes('snippetRemove')), 'a button label built from a name or text that is not a snippet: ' + labels.join(' | '));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the identity page's reporter
// ---------------------------------------------------------------------------------------------------------------------------------

test('CONSENT: the identity page\'s reporter sends nothing before allow(true), nothing after allow(false), and a final flush or stop without a yes sends nothing and settles at once', async () => {
  const posts = [];
  const beacons = [];
  const nav = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0', sendBeacon: (u, b) => { beacons.push([u, b]); return true; } };
  const make = () => idp.createReporter({ endpoint: ENDPOINT, build: 'bbcb82098cda', loader: '0.3.0', now: () => 1e12, random: () => 0.5, nav, send: (u, t) => { posts.push([u, JSON.parse(t)]); return true; }, setTimeout: () => 0, clearTimeout: () => {} });
  const r = make();
  for (let i = 0; i < 20; i++) r.event('card', { kind: 'signin', ip: IP4 });
  await r.flush('final');
  await r.flush('hide');
  await r.stop();
  assert.deepEqual([posts.length, beacons.length], [0, 0]);
  const q = make();
  q.event('ready', {});
  q.allow(false);
  q.event('card', { kind: 'x' });
  await q.flush('final');
  await q.stop();
  assert.deepEqual([posts.length, beacons.length], [0, 0]);
  assert.equal(q.inspect().queued, 0);
  const y = make();
  y.event('ready', {});
  y.allow(true);
  y.event('request', { kind: 'popup', ref: IP4 });
  await y.flush('final');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0][1].events.map((e) => e.n), ['ready', 'request']);
  assert.equal(posts[0][1].events[1].ref, 'x.x.x.x', 'a field is masked here too');
  assert.deepEqual([posts[0][1].who, posts[0][1].site, posts[0][1].net, posts[0][1].ua], [null, '', null, { browser: 'firefox', mobile: false }], 'the identity page never names a person or a site');
});

test('STOPPED: what a card resolves with is reported as a word of a closed list whatever the value says: a passphrase, a typed code, a name or a file is "continue", never its text', () => {
  const closed = /^(cancel|continue|restore|link|passkey|passphrase|visit|phrase|file|saved|later|check|keep|fresh|close|yes|no|done)$/;
  const hostile = ['correct horse battery staple', 'abcd-efgh-2345', { action: 'Ferdle Morrow' }, { method: IP4 }, { kind: 'x'.repeat(500) }, { text: 'the will' }, true, false, null, undefined, 5, ['a'], () => 1];
  for (const kind of idp.CARD_KINDS) for (const v of hostile) {
    const w = idp.cardOutcome(kind, v);
    assert.match(w, closed, kind + ' ' + JSON.stringify(v));
  }
  const events = [];
  const cards = idp.instrumentCards({ passphrase: async () => ({ value: 'hunter2 correct horse' }), signin: async () => ({ action: 'Ferdle' }), recoveryKit: async () => 'abcd-efgh-2345', notACard: async () => 'kept' }, (n, f) => events.push([n, f]));
  return Promise.all([cards.passphrase({ prompt: 'secret' }), cards.signin({ origin: 'https://site.example' }), cards.recoveryKit('abcd-efgh-2345'), cards.notACard()]).then(() => {
    const text = JSON.stringify(events);
    for (const secret of ['hunter2', 'horse', 'Ferdle', 'abcd-efgh', 'site.example', 'secret']) assert.ok(!text.includes(secret), secret);
    assert.deepEqual(events.map((e) => e[0] + ':' + (e[1].kind || e[1].name)).sort(), ['action:passphrase.continue', 'action:recoveryKit.done', 'action:signin.done', 'card:passphrase', 'card:recoveryKit', 'card:signin']);
    const handlers = idp.instrumentHandlers({ link: (site) => site, makeBackup: () => 1, evil: () => 2 }, (n, f) => events.push([n, f]));
    handlers.link('https://site.example'); handlers.makeBackup(); handlers.evil();
    assert.ok(!JSON.stringify(events).includes('site.example'));
  });
});

test('STOPPED: no call site of the loader or of the identity page puts a user agent, a navigator property or a typed value into a report: the report calls with a field are listed and none reads navigator, location.href, .value or .textContent', () => {
  const files = ['src/loader/app.js', 'src/loader/ui.js', 'src/loader/api.js', 'src/loader/torrent.js', 'src/loader/apps.js', 'src/loader/apps-link.js', 'src/loader/apps-ui.js', 'src/idp/idp.js'];
  const calls = [];
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/\b(?:rep|_rep|repThrottled|report|say)\(([^\n]*)/g)) if (/\{/.test(m[1])) calls.push([file, m[0]]);
  }
  assert.ok(calls.length > 100, 'found ' + calls.length + ' report calls with fields');
  for (const [file, call] of calls) {
    assert.ok(!/navigator|userAgent|location\.(href|search|hash|pathname)|\.value\b|\.textContent|innerText|document\.cookie|localStorage/i.test(call.replace(/\bvalue:\s*(true|false|payload|!!|null)/g, '')), file + ': ' + call.slice(0, 140));
  }
});

test('DESIGN: on the identity page the first press of any button of any card, Cancel and Close included, is the yes that lets the reports go; the line above the buttons says so (finding F8)', () => {
  const cards = read('src/idp/cards.js');
  const button = cards.split('function button(text')[1].split('function checkbox')[0];
  const handler = button.split("b.addEventListener('click'")[1];
  assert.match(handler, /if \(onCardPress\) \{[\s\S]*onCardPress\(\)/, 'every button calls it');
  assert.ok(!/primary|danger|cancel/i.test(handler), 'no condition on which button it is');
  const en = read('src/idp/strings.js').match(/obsDisclosure: '([^']+)'/)[1];
  assert.match(en, /when you press a button on this page, it sends \{host\} a report/);
  assert.match(en, /To send nothing, close this window without pressing one\./);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// WebRTC: SDP and candidates
// ---------------------------------------------------------------------------------------------------------------------------------

test('STOPPED: the peer connection wrapper reports states, candidate types and protocols; the addresses, ports, foundations, user fragments, passwords and fingerprints of an SDP and of the statistics never leave', async () => {
  const { wrapPeerConnection } = await import('../../src/loader/obs.js');
  class FakePc {
    constructor() { this.l = {}; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.iceGatheringState = 'new'; }
    addEventListener(type, fn) { (this.l[type] = this.l[type] || []).push(fn); }
    emit(type, ev) { for (const fn of this.l[type] || []) fn(ev || {}); }
    setRemoteDescription() { return Promise.resolve(); }
    close() {}
    getStats() {
      return Promise.resolve(new Map([
        ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
        ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded' }],
        ['L', { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: IP4, ip: IP4, port: 5555, relatedAddress: '192.168.1.5', usernameFragment: 'Zq3kLocal' }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'tcp', address: '198.51.100.7', port: 6666 }],
      ]));
    }
  }
  const sdp = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 'a=ice-ufrag:Zq3kRemote', 'a=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsTpwd', 'a=fingerprint:sha-256 5D:1C:0A:77:B3:4E:99:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AA',
    'a=candidate:842163049 1 udp 1677729535 ' + IP4 + ' 51472 typ srflx raddr 192.168.1.5 rport 51472', 'a=candidate:1 1 tcp 1 [' + IP6 + '] 9 typ host', 'a=candidate:3 1 udp 1 3f2504e0-4f89-41d3-9a0c-0305e82c3301.local 1234 typ host', ''].join('\r\n');
  const g = reporter();
  g.r.allow(true);
  const win = { RTCPeerConnection: FakePc };
  assert.equal(wrapPeerConnection(win, g.r), true);
  assert.equal(wrapPeerConnection(win, g.r), false, 'idempotent');
  const pc = new win.RTCPeerConnection();
  pc.emit('icegatheringstatechange'); pc.iceGatheringState = 'gathering'; pc.emit('icegatheringstatechange');
  pc.emit('icecandidate', { candidate: { candidate: 'candidate:842163049 1 udp 1677729535 ' + IP4 + ' 54321 typ srflx raddr 192.168.1.5 rport 54321 generation 0 ufrag Zq3kLocal', type: 'srflx', protocol: 'udp', address: IP4, port: 54321, foundation: '842163049', relatedAddress: '192.168.1.5', usernameFragment: 'Zq3kLocal' } });
  pc.emit('icecandidate', { candidate: { candidate: '' } });
  await pc.setRemoteDescription({ type: 'answer', sdp });
  pc.iceConnectionState = 'connected'; pc.emit('iceconnectionstatechange');
  pc.connectionState = 'connected'; pc.emit('connectionstatechange');
  await flushTurn(); await flushTurn();
  pc.close();
  g.r.flush('test');
  const ev = g.events();
  assert.deepEqual(ev.map((e) => e.n), ['ice.pc', 'ice.gathering', 'ice.gathering', 'ice.local', 'ice.remote', 'ice.state', 'ice.conn', 'ice.pair', 'ice.pc']);
  const by = (n) => { const { t, n: name, ...rest } = ev.find((e) => e.n === n); return rest; };
  assert.deepEqual(by('ice.local'), { id: 1, type: 'srflx', proto: 'udp' });
  assert.deepEqual(by('ice.remote'), { id: 1, sdp: 'answer', types: 'srflx,host,host' });
  assert.deepEqual(by('ice.pair'), { id: 1, local: 'srflx/udp', remote: 'host/tcp' });
  const text = g.text();
  for (const secret of [IP4, '198.51.100', '192.168.1.5', '54321', '51472', '5555', '6666', 'Zq3k', 'zXy9', '5D:1C', '842163049', '2001:db8', '3f2504e0', 'ufrag']) assert.ok(!text.includes(secret), JSON.stringify(secret) + ' left in an ICE report');
});

test('STOPPED F10: a report endpoint on a loopback host over plain http is accepted only for a page that is itself on a loopback host: a door.json read on any other page cannot aim the beacons of visitors who said yes at a service on their own machine', async () => {
  for (const endpoint of ['http://localhost:6379', 'http://127.0.0.1:9200', 'http://[::1]:8080', 'http://anything.localhost:3000']) {
    assert.equal(checkObsBlock({ endpoint }).reason, null, 'no page given (the tools check what they write): ' + endpoint);
    for (const pageHost of ['site.example', 'hub.example.test', '192.168.1.5:8080', '']) {
      const r = checkObsBlock({ endpoint }, { pageHost });
      assert.deepEqual([r.block, r.reason], [null, 'obs-endpoint-insecure'], endpoint + ' on ' + JSON.stringify(pageHost));
    }
    for (const pageHost of ['localhost:8080', '127.0.0.1:41001', '[::1]:8000', 'dev.localhost']) assert.equal(checkObsBlock({ endpoint }, { pageHost }).reason, null, endpoint + ' on ' + pageHost);
  }
  assert.equal(checkObsBlock({ endpoint: 'https://obs.example.test' }, { pageHost: 'site.example' }).reason, null, 'https is for any page');
  assert.equal(checkObsBlock({ endpoint: 'http://192.168.1.10:8080' }, { pageHost: 'localhost' }).reason, 'obs-endpoint-insecure', 'and a private address is never loopback');
  // the page: the same door.json gives a reporter on a page on loopback and none on any other
  const s = spies();
  try {
    const away = await runHub({ json: doorJsonWith({ obs: { endpoint: 'http://localhost:6379' } }), spy: s });
    assert.equal(away.A.obs, null);
    assert.ok(away.A.ui.diagnostics.lines().some((l) => l.includes('obs-endpoint-insecure') && l.includes('no usage reports')));
    stir(away, 'x');
    assert.equal(s.total(), 0, 'no call on a page that is not on loopback');
    assert.ok(away.win.fetch.seen.every(([url]) => url === 'https://hub.example.test/_mw/door.json'), 'only its own door.json was read');
    const here = await runHub({ json: doorJsonWith({ obs: { endpoint: 'http://localhost:6379' } }), spy: s, host: 'localhost:8080' });
    assert.ok(here.A.obs, 'a page on loopback may use it');
    assert.equal(here.A.obsHost, 'localhost');
  } finally { s.restore(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the apps: two people with poisoned names and words, through the service, the pair socket, the reporter and the Worker's validation
// ---------------------------------------------------------------------------------------------------------------------------------

async function appsPerson(w, name) {
  const p = await makePerson(name);
  const identity = new FakeIdentity(p);
  const tm = w.net.tm(name);
  const reports = [];
  const into = (prefix) => (n, f) => { reports.push([prefix + n, JSON.parse(JSON.stringify(f))]); };
  const link = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now, report: into('link.') });
  const apps = createApps({ api: { identity }, config: { rendezvous: ['wss://rendezvous.invalid/'], stun: [], idp: null }, loadTm: async () => tm, now: w.clock.now, link, setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, report: into('apps.'), limits: { byeGraceMs: 0, blockedRejectDelayMs: [10, 20] } });
  return { name, p, apps, reports };
}

test('PRIVACY: two people with a name, a nickname, a note and messages full of addresses, codes, passphrases and links pair and talk; nothing of it is in a report, and every report is a batch the Worker accepts unchanged', async () => {
  const w = makeWorld();
  const A = await appsPerson(w, 'Ferdle Morrow');
  const B = await appsPerson(w, 'Quilla Zorblat');
  const poison = ['my passphrase is correct horse battery staple', 'ssh to ' + IP4 + ':22 and [' + IP6 + ']:443', 'the code is wxyz-qrst-6789', 'see https://private.example/diary#frag-secret-token', 'pat.example@example.com', 'C:\\Users\\ferdle\\will.pdf'];
  const { code } = await A.apps.openCode();
  await B.apps.knock(code);
  await until(() => A.apps.state().requests.length === 1, 'the request');
  await A.apps.accept(A.apps.state().requests[0].knock);
  await until(() => A.apps.state().conversations[0] && A.apps.state().conversations[0].status === 'connected' && B.apps.state().conversations[0] && B.apps.state().conversations[0].status === 'connected', 'connected');
  const a = A.apps.state().conversations[0].id;
  const b = B.apps.state().conversations[0].id;
  for (const text of poison) await A.apps.send(a, text);
  await until(() => B.apps.state().conversations[0].messages.length === poison.length, 'delivered');
  await B.apps.setNickname(b, 'Ferdle from the mill ' + IP4);
  B.apps.setNote(b, poison[0]);
  B.apps.setDraft(b, poison[1]);
  await B.apps.send(b, poison[2]);
  await B.apps.markRead(b);
  await settle(20);
  // every report goes through the real reporter, then the Worker's own validation
  const sent = [];
  const rp = createReporter({ endpoint: ENDPOINT, page: 'door', now: () => 1e12, random: () => 0.5, send: (u, t) => { sent.push(JSON.parse(t)); return true; }, timers: manual(), visibility: { onHide: () => {} }, env: { navigator: { userAgent: 'x' } } });
  rp.allow(true);
  for (const [n, f] of A.reports.concat(B.reports)) rp.event(n, f);
  for (let i = 0; i < 100 && rp.inspect().queued > 0; i++) rp.flush('test');
  assert.ok(sent.length >= 1 && rp.inspect().dropped === 0);
  for (const batch of sent) assert.ok(core.validateBatch(batch).ok, 'the Worker takes it: ' + JSON.stringify(core.validateBatch(batch)));
  const valuesOf = (batches) => batches.flatMap((b) => b.events).flatMap((e) => Object.entries(e).filter(([k]) => k !== 'n').map(([, v]) => v)).filter((v) => typeof v === 'string').join('\n').toLowerCase();
  assert.ok(valuesOf([{ events: [{ t: 1, n: 'a.b', m: 'Ferdle' }] }]).includes('ferdle'), 'control: the scan sees a name when there is one');
  const values = valuesOf(sent);
  assert.ok(sent.flatMap((b) => b.events).some((e) => e.n === 'apps.msg'), 'control: the messages were reported as counts');
  const forbidden = ['ferdle', 'morrow', 'quilla', 'zorblat', 'passphrase', 'horse', 'staple', IP4, '2001:db8', ':22', 'qrst', '6789', 'private.example', 'frag-secret', 'diary', 'example.com', 'will.pdf', 'mill', A.p.keys.pub, B.p.keys.pub];
  for (const secret of forbidden) assert.ok(!values.includes(String(secret).toLowerCase()), JSON.stringify(secret) + ' is in a report');
  for (const x of code.replace(/-/g, '').match(/.{1,4}/g).slice(1)) assert.ok(!values.includes(x), 'more than the channel of the code: ' + x);
});

test('STOPPED F12: a reason a rendezvous gives for a refusal is reported only when it is one the code knows (unknown-code, channel-taken, ...); any other text it chooses is reported as "other", an address or a name in it included', async () => {
  const w = makeWorld();
  const A = await appsPerson(w, 'Ferdle Morrow');
  const B = await appsPerson(w, 'Quilla Zorblat');
  const { code } = await A.apps.openCode();
  const orig = w.rdv.handle.bind(w.rdv);
  w.rdv.handle = (conn, m) => (m && m.action === 'pair-knock' ? w.rdv._send(conn, { action: 'pair-knock', rid: m.rid, 'failure reason': 'Ferdle Morrow 203.0.113.5 asked' }) : orig(conn, m));
  const r = await B.apps.knock(code);
  assert.ok(r.error);
  await settle(10);
  const reasons = B.reports.filter(([n]) => n === 'apps.knock' || n === 'link.reply').map(([, f]) => f.reason).filter(Boolean);
  assert.deepEqual(reasons, ['other', 'other']);
  const text = JSON.stringify(B.reports);
  assert.ok(!/ferdle|203-0-113|203\.0\.113/i.test(text), 'nothing of the rendezvous\' text');
  assert.equal(reasonWord('ferdle-morrow-203-0-113-5-asked'), 'other');
  for (const known of ['unknown-code', 'channel-taken', 'too-many-codes', 'too-many-requests', 'box-invalid', 'link-down', 'timeout']) assert.equal(reasonWord(known), known);
});

test('the file itself follows the rules of the plan: ASCII only, straight quotes, no dash characters, none of the banned words, semicolons', () => {
  const me = read('test/unit/obs-adversary.test.mjs');
  assert.ok(!/[^\x00-\x7f]/.test(me), 'ASCII only');
  const banned = ['block' + 'chain', 'server' + 'less', 'un' + 'stoppable', 'censorship' + '-resistant', 'production' + '-ready', 'fully ' + 'decentralized', 'sub' + '-second'];
  for (const word of banned) assert.ok(!me.toLowerCase().includes(word), word);
  assert.ok(!/\bonline\b/i.test(me.replace(/obs-adversary/g, '')), 'the word the plan forbids for presence');
});
