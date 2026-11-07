// Unit tests for the front of the rendezvous (deploy/rtc-worker/front.js, the file a Pages project runs, and its copy
// pages/public/_worker.js), for the same front inside worker.js, and for the files that travel with them: the privacy rule of the
// relay lane (the object is handed a rebuilt request with only the upgrade headers; no code reads a client address, request.cf, an
// Origin, a Referer or a User-Agent), the settings files, the wording rules of the project and the numbers the README states.
// Nothing here opens a socket or reaches a network; the object behind the front is a function that keeps the request it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import front from '../../deploy/rtc-worker/front.js';
import pagesFront from '../../deploy/rtc-worker/pages/public/_worker.js';
import workerFront from '../../deploy/rtc-worker/worker.js';
import { createRendezvous, PEER_TTL_S } from '../../deploy/rtc-worker/rtc.js';
import { DEFAULT_CAPS, MAX_FRAME_CHARS, MAX_PAIR_BYTES, PING_TEXT, PONG_TEXT } from '../../deploy/rtc-worker/pair.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'rtc-worker');
const read = (rel) => readFileSync(join(DIR, rel), 'utf8');
const UPGRADE = ['connection', 'sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-version', 'upgrade'];

/** code(text) -> the text without comments: block comments, whole-line comments and a trailing comment (a // that has a space before and after it). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''))).join('\n');
}
function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

// What no code of the rendezvous may read (plan 3.7, D7): a client address in any header, request.cf, an Origin, a Referer, a User-Agent.
// Comments may name them; code may not. The header names are looked for as strings, so the .origin of a URL is not one.
const FORBIDDEN = [
  [/cf-connecting-ip/i, 'CF-Connecting-IP'], [/cf-connecting-ipv6/i, 'CF-Connecting-IPv6'], [/x-forwarded-for/i, 'X-Forwarded-For'], [/x-real-ip/i, 'X-Real-IP'],
  [/true-client-ip/i, 'True-Client-IP'], [/['"`]forwarded['"`]/i, 'Forwarded'], [/request\.cf\b/, 'request.cf'], [/\.cf\b/, '.cf'], [/\bcf\s*[:}=]/, 'cf'], [/['"`]cf-/i, 'a cf- header'],
  [/['"`]origin['"`]/i, 'Origin'], [/['"`]referer['"`]/i, 'Referer'], [/['"`]referrer['"`]/i, 'Referrer'], [/['"`]user-agent['"`]/i, 'User-Agent'], [/\bconsole\b/, 'console'],
];
const flagged = (text) => FORBIDDEN.filter(([re]) => re.test(code(text))).map(([, name]) => name);
const WALKS = /headers\.(?:entries|keys|values|forEach)\b|\.\.\.\s*[\w.]*headers\b|Object\.(?:fromEntries|entries)\([^)]*headers|Symbol\.iterator/;

test('pages/public/_worker.js is a byte-for-byte copy of front.js; the front imports nothing, defines no class and has one default export', () => {
  const a = readFileSync(join(DIR, 'front.js'));
  const b = readFileSync(join(DIR, 'pages', 'public', '_worker.js'));
  assert.ok(a.length > 1000);
  assert.equal(Buffer.compare(a, b), 0, 'copy front.js to pages/public/_worker.js again');
  const body = code(a.toString('utf8'));
  assert.equal(/^\s*import\b|\bimport\s*\(|\brequire\(/m.test(body), false, 'a Pages route is one file: no import');
  assert.equal(/\bclass\b/.test(body), false, 'a Pages project cannot define the object class');
  assert.equal((body.match(/export default/g) || []).length, 1);
  assert.equal(/^export (?!default)/m.test(body), false, 'no named export beside the default one');
  assert.equal(WALKS.test(body), false);
  assert.equal(/\bwaitUntil\b|\bfetch\(\s*['"`]http|\bcaches\b|\bKV\b|\bsendBeacon\b/.test(body), false, 'the front reaches out to nothing but the object');
});

test('source scan: no client address header, no request.cf, no Origin, Referer or User-Agent, no console, no walk over the headers, in code (the scan itself is checked on samples)', () => {
  const sample = "const ip = request.headers.get('CF-Connecting-IP');\nconst c = request.cf;\nconsole.log(1);\nconst h = req.headers.get('x-forwarded-for'); // fine?\nconst o = request.headers.get('Origin');\nconst u = h.get('user-agent');\nconst r = h.get(\"Referer\");\n";
  assert.deepEqual(flagged(sample), ['CF-Connecting-IP', 'X-Forwarded-For', 'request.cf', '.cf', 'a cf- header', 'Origin', 'Referer', 'User-Agent', 'console']);
  assert.deepEqual(flagged("// reads no CF-Connecting-IP, no request.cf, no Origin\nconst a = 1; // never X-Forwarded-For and no console.log\n/* console.log\n  request.cf */\nconst u = new Request(url.origin + '/');\n"), [], 'comments, and the .origin of a URL, are not code');
  assert.deepEqual(flagged("const url = 'https://x.example/' + request.cf;\n"), ['request.cf', '.cf'], 'a // inside a string does not hide what follows it on the line');
  assert.equal(WALKS.test('for (const [k, v] of request.headers.entries()) {}'), true);
  assert.equal(WALKS.test('const h = { ...request.headers };'), true);
  assert.equal(WALKS.test("const v = request.headers.get('Upgrade');"), false);
  for (const rel of ['front.js', 'pages/public/_worker.js', 'worker.js', 'rtc.js', 'pair.js']) {
    const body = code(read(rel));
    assert.ok(body.length > 500, rel + ' has code');
    assert.deepEqual(flagged(read(rel)), [], rel);
    if (rel !== 'rtc.js' && rel !== 'pair.js') {
      assert.equal(WALKS.test(body), false, rel + ' walks the headers');
      // the headers it reads by name: Upgrade for the check, and the upgrade set it passes on
      const names = Array.from(body.matchAll(/headers\.(?:get|has)\(\s*(['"])([^'"]+)\1/g)).map((m) => m[2].toLowerCase());
      for (const n of names) assert.equal(n, 'upgrade', rel + ' reads the header ' + n);
      const list = /const UPGRADE_HEADERS = \[([^\]]*)\]/.exec(body);
      assert.ok(list, rel + ' names the headers it passes on');
      assert.deepEqual(Array.from(list[1].matchAll(/'([^']+)'/g)).map((m) => m[1].toLowerCase()).sort(), UPGRADE, rel);
    }
    assert.equal(/\bwaitUntil\b|\bsendBeacon\b|\blocalStorage\b/.test(body), false, rel);
  }
});

/** The object behind the front: keeps the request it is given. */
function objectEnv(token = 's3cret') {
  const seen = [];
  const env = { STATS_TOKEN: token, RTC: { idFromName: (n) => 'id:' + n, get: (id) => ({ fetch: async (req) => { seen.push({ id, url: req.url, method: req.method, headers: Array.from(req.headers.keys()).sort() }); return new Response('from the object'); } }) } };
  return { env, seen };
}
const SENDER = {
  Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Extensions': 'permessage-deflate',
  Origin: 'https://door.example', Referer: 'https://door.example/page', 'User-Agent': 'x', 'CF-Connecting-IP': 'client-address', 'X-Forwarded-For': 'client-address', 'X-Real-IP': 'client-address',
  Cookie: 'a=b', 'Accept-Language': 'fr', Authorization: 'x',
};
const SHOWN = (res) => [res.status, res.headers.get('upgrade'), res.headers.get('content-type'), res.headers.get('cache-control')];

test('the three fronts (front.js, its Pages copy and the default export of worker.js) answer the same requests the same way and hand the object the same fresh request', async () => {
  const requests = [
    ['https://rtc.example/healthz', {}],
    ['https://rtc.example/', {}],
    ['https://rtc.example/', { Upgrade: 'WebSocket' }],
    ['https://rtc.example/', SENDER],
    ['https://rtc.example/?a=1&b=2', SENDER],
    ['https://rtc.example/announce', SENDER],
    ['https://rtc.example/stats.json', SENDER],
    ['https://rtc.example/stats.json?token=wrong', SENDER],
    ['https://rtc.example/stats.json?token=s3cret', SENDER],
    ['https://rtc.example/stats.json/', SENDER],
  ];
  const results = [];
  for (const [name, f] of [['front.js', front], ['pages/public/_worker.js', pagesFront], ['worker.js', workerFront]]) {
    const { env, seen } = objectEnv();
    const out = [];
    for (const [url, headers] of requests) {
      const res = await f.fetch(new Request(url, { headers }), env);
      out.push([SHOWN(res), await res.text()]);
    }
    const noToken = objectEnv('');
    const closed = await f.fetch(new Request('https://rtc.example/stats.json?token=', { headers: SENDER }), noToken.env);
    out.push([SHOWN(closed), await closed.text(), noToken.seen.length]);
    results.push({ name, out, seen });
  }
  assert.deepEqual(results[1].out, results[0].out, 'the Pages copy answers like front.js');
  assert.deepEqual(results[2].out, results[0].out, 'worker.js answers like front.js');
  assert.deepEqual(results[1].seen, results[0].seen);
  assert.deepEqual(results[2].seen, results[0].seen);
  const { out, seen } = results[0];
  assert.deepEqual(out[0], [[200, null, 'text/plain; charset=utf-8', 'no-store'], 'ok\n']);
  assert.equal(out[1][0][0], 426);
  assert.equal(out[1][0][1], 'websocket', 'a plain GET of / is told to use a WebSocket');
  assert.match(out[1][1], /felinar rendezvous/);
  assert.equal(out[5][0][0], 404);
  assert.deepEqual([out[6][0][0], out[7][0][0], out[9][0][0]], [404, 404, 404], 'no token, a wrong token and a trailing slash are never served');
  assert.deepEqual(out[10], [[404, null, 'text/plain; charset=utf-8', 'no-store'], 'not found\n', 0], 'with no STATS_TOKEN set the stats are never served and the object is not asked');
  // what reached the object: the upgrades at / (3 of them: a lower-case upgrade value, SENDER, SENDER with a query) and the one stats request
  assert.deepEqual(seen.map((s) => s.url), ['https://rtc.example/', 'https://rtc.example/', 'https://rtc.example/', 'https://rtc.example/stats.json']);
  assert.deepEqual(seen.map((s) => s.id), Array(4).fill('id:swarms'));
  assert.deepEqual(seen[0].headers, ['upgrade'], 'only what the caller had of the allowed names');
  // SENDER has every allowed name but Sec-WebSocket-Protocol, and a dozen others that must not get through
  assert.deepEqual(seen[1].headers, ['connection', 'sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-version', 'upgrade']);
  assert.deepEqual(seen[2].headers, seen[1].headers, 'a query on the url changes nothing about the headers');
  for (const name of ['origin', 'referer', 'user-agent', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cookie', 'accept-language', 'authorization']) {
    assert.equal(seen.some((s) => s.headers.includes(name)), false, name + ' reached the object');
  }
  assert.deepEqual(seen[3].headers, [], 'the stats request carries no header of the caller\'s');
  assert.equal(seen.every((s) => s.method === 'GET'), true);
  assert.equal(seen.some((s) => s.url.includes('token') || s.url.includes('?')), false, 'no query, so no token, reaches the object');
});

test('the front reads headers by name, one at a time, and touches nothing of the request but its url and headers (a spy on every access)', async () => {
  for (const [name, f] of [['front.js', front], ['pages/public/_worker.js', pagesFront], ['worker.js', workerFront]]) {
    const read = new Set();
    const props = new Set();
    const { env } = objectEnv();
    const spy = (target) => new Proxy(target, {
      get(t, prop) {
        if (prop === 'headers') return { get: (n) => { read.add(String(n).toLowerCase()); return t.headers.get(n); }, has: (n) => { read.add(String(n).toLowerCase()); return t.headers.has(n); } };
        props.add(String(prop));
        const v = Reflect.get(t, prop, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    for (const path of ['/', '/healthz', '/stats.json?token=s3cret', '/nothing', '/stats.json']) await f.fetch(spy(new Request('https://rtc.example' + path, { headers: SENDER })), env);
    assert.deepEqual(Array.from(read).filter((n) => !UPGRADE.includes(n)), [], name + ' read headers: ' + Array.from(read).join(', '));
    assert.ok(read.has('upgrade'), name);
    assert.deepEqual(Array.from(props).filter((p) => p !== 'url'), [], name + ' touched ' + Array.from(props).join(', '));
    assert.equal(props.has('cf'), false);
  }
});

test('pages/wrangler.toml holds the placeholder and no token, binds the object by script_name and says to run wrangler from a copy outside the repository', () => {
  const toml = read('pages/wrangler.toml');
  assert.ok(toml.includes('STATS_TOKEN = "<value of the stats token file>"'), 'the placeholder text exactly');
  assert.ok(/script_name = "felinar-rtc-do"/.test(toml));
  assert.ok(/class_name = "Rendezvous"/.test(toml) && /name = "RTC"/.test(toml));
  assert.ok(/pages_build_output_dir = "\.\/public"/.test(toml));
  assert.ok(/outside the repository/.test(toml), 'the comment says where to run wrangler');
  assert.ok(/byte-for-byte copy of \.\.\/front\.js/.test(toml.replace(/\n#\s*/g, ' ')));
  const settings = toml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace('<value of the stats token file>', '');
  assert.equal(/[A-Za-z0-9_+/=-]{32,}/.test(settings), false, 'no long random-looking value in the settings');
  assert.equal(/\[observability\]/.test(toml), false, 'no key the Pages configuration is not known to take');
});

test('the folder holds exactly these files: no token file, no key, no stray copy (the list the integrate step puts in the layout test)', () => {
  const files = filesUnder(DIR).map((f) => relative(DIR, f).split(sep).join('/')).sort();
  assert.deepEqual(files, ['README.md', 'front.js', 'pages/public/_worker.js', 'pages/wrangler.toml', 'pair.js', 'rtc.js', 'worker.js', 'wrangler.jsonc']);
});

test('source scan: everything under deploy/rtc-worker is pure ASCII; no em or en dash, no banned word, no presence word the rules keep out, straight quotes (the wording rules of the project)', () => {
  const dash = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
  // built from parts, so that this file never holds the words it looks for
  const presence = 'on' + 'line'; // presence reads "Connected to you now"
  const banned = ['block' + 'chain', 'server' + 'less', 'unstop' + 'pable', 'censorship' + '-resistant', 'production' + '-ready', 'fully ' + 'decentralized', 'sub' + '-second', 'anony' + 'mous', 'untrace' + 'able', 'peer' + '-to-peer', 'no ' + 'logs', 'warrant ' + 'canary', 'works ' + 'everywhere', 'perma' + 'nent'];
  const files = filesUnder(DIR);
  assert.equal(files.length, 8);
  for (const file of files) {
    const rel = relative(DIR, file);
    const buf = readFileSync(file);
    const bad = Array.from(buf).findIndex((b) => b > 127);
    assert.equal(bad, -1, rel + ' has a byte above 127 at ' + bad);
    const text = buf.toString('utf8');
    for (const d of dash) assert.equal(text.includes(d), false, rel + ' has a dash that is not a hyphen');
    for (const w of banned) assert.equal(text.toLowerCase().includes(w), false, rel + ' has the phrase ' + w);
    assert.equal(new RegExp('\\b' + presence + '\\b', 'i').test(text), false, rel + ' uses the word ' + presence);
    assert.equal(/[\u2018\u2019\u201c\u201d]/.test(text), false, rel + ' has curly quotes');
    assert.equal(/\t/.test(text), false, rel + ' has a tab');
    assert.equal(/[ \t]+$/m.test(text) && !rel.endsWith('.md'), false, rel + ' has trailing spaces');
    assert.equal(text.endsWith('\n'), true, rel + ' ends with a newline');
  }
  for (const rel of ['worker.js', 'rtc.js', 'pair.js', 'front.js']) {
    // a statement that starts on a line ends with a semicolon, or the line goes on (an opening bracket, a comma, an operator)
    const lines = code(read(rel)).split('\n');
    const bareEnds = lines.map((l, i) => [l.trim(), i + 1]).filter(([l]) => /^(?:const|let|var|return|throw|await|import)\b/.test(l) && !/[;{(\[,:+&|?=>]$/.test(l));
    assert.deepEqual(bareEnds.map(([l, n]) => rel + ':' + n + ': ' + l.slice(0, 60)), [], rel + ' uses semicolons');
  }
  assert.equal(/^import\b/m.test(read('pair.js')), false, 'pair.js keeps zero imports: the Docker images copy that one file');
});

test('README.md states the numbers the code enforces and the names it answers with', () => {
  const md = read('README.md');
  const flat = md.replace(/\s+/g, ' ');
  const n = (x) => x.toLocaleString('en-US');
  assert.equal(DEFAULT_CAPS.relayPerMin, 120);
  assert.equal(DEFAULT_CAPS.messagesPerMin, 150);
  assert.equal(DEFAULT_CAPS.relayDayMax, 20000);
  assert.equal(DEFAULT_CAPS.lanesPerSocket, 8);
  assert.equal(DEFAULT_CAPS.pairLaneMembers, 2);
  assert.equal(DEFAULT_CAPS.roomLaneMembers, 16);
  assert.ok(flat.includes(n(DEFAULT_CAPS.relayPerMin) + ' relayed frames a minute'));
  assert.ok(flat.includes(n(DEFAULT_CAPS.messagesPerMin) + ' messages of any kind a minute'));
  assert.ok(flat.includes('a ping that reaches the object counts as one'), 'DECISIONS DEC-2: a ping that wakes the object counts');
  assert.ok(flat.includes(n(DEFAULT_CAPS.relayDayMax) + ' relayed frames a UTC day'));
  assert.ok(flat.includes(DEFAULT_CAPS.lanesPerSocket + ' lanes (`too many lanes`)'));
  assert.ok(flat.includes(DEFAULT_CAPS.pairLaneMembers + ' sockets in a pair lane and ' + DEFAULT_CAPS.roomLaneMembers + ' in a room lane'));
  assert.ok(flat.includes('4 to ' + n(MAX_FRAME_CHARS) + ' base64url characters'));
  assert.ok(flat.includes(n(MAX_PAIR_BYTES) + ' bytes of a pair frame'));
  assert.ok(flat.includes('514, 1,538 and 5,634 bytes, which is 686, 2,051 and 7,512 base64url characters'));
  assert.ok(md.includes(PING_TEXT) && md.includes(PONG_TEXT), 'the exact ping and pong texts');
  assert.ok(flat.includes('every 50 seconds') && flat.includes('within 10 seconds') && flat.includes('after ' + PEER_TTL_S / 60 + ' minutes'));
  // DECISIONS DEC-1: a vanished member is evicted when its replacement joins; the sweep's 20 minutes stay the limit for a socket nobody replaces
  assert.equal(DEFAULT_CAPS.memberStaleMs, 120000);
  assert.ok(flat.includes(n(DEFAULT_CAPS.memberStaleMs) + ' ms') && flat.includes('`memberStaleMs`'), 'the eviction threshold');
  assert.ok(flat.includes('20 minutes of silence, looked at every 5'));
  assert.ok(flat.includes('closed with code 1000') && flat.includes('`evicted`'));
  assert.equal(flat.includes('up to 25 minutes'), false, 'the lock-out of up to 25 minutes is gone');
  assert.ok(flat.includes('100,000 requests a day') && flat.includes('`RELAY_LANE`') && flat.includes('`--no-relay-lane`') && flat.includes('observability'));
  assert.ok(flat.includes('nothing general-purpose'), 'the sentence about what the relay is not');
  assert.ok(flat.includes('forwards only sealed pair frames between two members of a lane the rendezvous itself minted after an accept, under caps'));
  for (const why of ['invalid lane', 'unknown lane', 'lane full', 'too many lanes', 'invalid frame', 'too many relays', 'relay is busy', 'relay is off on this rendezvous', 'too many messages']) {
    assert.ok(md.includes('`' + why + '`'), 'the failure text ' + why);
  }
  for (const action of ['pair-join', 'pair-relay', 'pair-leave', 'pair-ping', 'room-join', 'room-relay', 'room-leave', 'pair-joined', 'pair-relayed', 'pair-left', 'pair-pong', 'room-joined', 'room-relayed', 'room-left']) {
    assert.ok(md.includes(action), 'the action ' + action);
  }
  // every field /stats.json answers is in the README
  const fields = Object.keys(createRendezvous({ allow: new Set(['a'.repeat(40)]) }).stats());
  assert.equal(fields.length, 19);
  for (const field of fields) assert.ok(md.includes(field), 'the stats field ' + field);
  // and the files of the front are named
  for (const name of ['front.js', 'pages/public/_worker.js', 'pages/wrangler.toml']) assert.ok(md.includes(name), name);
});
