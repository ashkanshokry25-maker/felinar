// Unit tests for the v0.3 additions of tools/publish.mjs (V03-DESIGN-REVIEW 2.3.6, 2.5.3, 2.5.5, 3.8; MF-04, MF-28, MF-44,
// SC-6, SC-7): org=, nx=, ml= and idp= in the signed pointer, the widget tags and their SRI, the refusal without the site's own
// tracker and STUN when chat, files or media are on, the loader headers and the CSP lines. No network; loopback only (none used).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  publish, loaderHeadersText, LOADER_HEADER_VALUES, orgList, stunList, turnConfig, featureProblems, ownTrackers, widgetTags, readNextKey, cspText,
  PUBLISH_FLAGS,
} from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { withdraw } from '../../tools/withdraw.mjs';
import { createGenesis, setCfg, ledgerIdForOwner, writeBlocksFile } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey, ToolError, UsageError, ROOT } from '../../tools/lib.mjs';
import { parsePointer, verifyPointer, verifyRotation, signRotation, nextKeyCommitment, ORG_MAX } from '../../src/common/pointer.js';
import { parseHeaders } from '../../src/sw/lib.js';
import { CONFIG } from '../../src/loader/config.js';

const work = mkdtempSync(join(tmpdir(), 'mw-v03-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 20, 12, 0, 30);
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
const sri384 = (bytes) => 'sha384-' + createHash('sha384').update(bytes).digest('base64');

function makeSite() {
  const dir = fresh('site');
  writeTree(dir, {
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n',
    'css/app.css': 'body { margin: 0 }\n',
  });
  return dir;
}

const SIGNIN_BYTES = '// signin widget (a stand-in for the built file)\nexport const widget = "signin";\n';
const PANEL_BYTES = '// chat panel (a stand-in for the built file)\nexport const widget = "chat-panel";\n';
function fakeDist({ widgets = true } = {}) {
  const dist = fresh('dist');
  writeTree(dist, {
    'mw-sw.js': '// sw\n',
    'mw-sw-kill.js': '// kill\n',
    '_mw/boot.js': '// boot\n',
    '_mw/loader.js': '// loader\n',
    '_mw/mw.js': '// mw\n',
    '_mw/sw-core.js': '// core\n',
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head><body><script src="/_mw/boot.js"></script></body></html>',
    '404.html': '<!doctype html><html><head><title>Loading</title></head><body></body></html>',
  });
  if (widgets) writeTree(dist, { '_mw/signin.js': SIGNIN_BYTES, '_mw/chat-panel.js': PANEL_BYTES });
  return dist;
}

let keyCounter = 0;
async function makeKey() {
  const file = join(work, 'owner-' + ++keyCounter + '.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub };
}

async function run(extra = {}) {
  const key = extra.key || (await makeKey()).file;
  return publish(Object.assign({
    dir: makeSite(), name: 'my-site', scope: 'example.com', key, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, quiet: true,
  }, extra));
}

// ---------------------------------------------------------------------------------------------- org, nx, ml, idp

test('org=, nx=, ml= and idp= are signed into the pointer, verify, and are echoed in summary.json', async () => {
  const owner = await makeKey();
  const next = await makeKey();
  const res = await run({
    key: owner.file, org: ['https://www.example.com', 'https://shop.example:8443'], nextKey: next.file, ml: '0.3.0', idp: 'https://id.example.org',
  });
  const rec = parsePointer(res.pointer).record;
  assert.deepEqual(rec.org, ['https://www.example.com', 'https://shop.example:8443']);
  assert.equal(rec.nx, await nextKeyCommitment(next.pub), 'nx= is the commitment to the key in --next-key');
  assert.equal(rec.ml, '0.3.0');
  assert.equal(rec.idp, 'https://id.example.org');
  const verdict = await verifyPointer(rec, 'example.com', { now: NOW });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const summary = JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.org, rec.org);
  assert.equal(summary.nx, rec.nx);
  assert.equal(summary.nextOwner, next.pub);
  assert.equal(summary.ml, '0.3.0');
  assert.equal(summary.idp, 'https://id.example.org');
  assert.equal(readFileSync(join(res.outDir, 'pointer.txt'), 'utf8').trim(), res.pointer);
  // the same fields in the other outputs
  assert.ok(readFileSync(join(res.outDir, 'meta.html'), 'utf8').includes('nx=' + rec.nx));
  assert.ok(readFileSync(join(res.outDir, 'dns.txt'), 'utf8').includes('org=https://www.example.com'));
  // a pointer without them is unchanged: no org, nx, ml or idp
  const plain = parsePointer((await run({})).pointer).record;
  assert.deepEqual([plain.org, plain.nx, plain.ml, plain.idp], [[], null, null, null]);
});

test('--next-key takes a public key line, a public JWK or a key file; --nx takes the commitment itself; a disagreement is a usage error', async () => {
  const owner = await makeKey();
  const next = await makeKey();
  const commitment = await nextKeyCommitment(next.pub);
  const pubFile = join(work, 'next.pub');
  writeFileSync(pubFile, next.pub + '\n');
  const jwk = JSON.parse(readFileSync(next.file, 'utf8'));
  const jwkPub = join(work, 'next-public.jwk');
  writeFileSync(jwkPub, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  for (const file of [pubFile, jwkPub, next.file]) {
    const r = await readNextKey(file);
    assert.equal(r.pub, next.pub, file);
  }
  assert.equal((await readNextKey(next.file)).privateFile, true);
  assert.equal((await readNextKey(pubFile)).privateFile, false);
  const a = parsePointer((await run({ key: owner.file, nextKey: pubFile })).pointer).record;
  assert.equal(a.nx, commitment);
  const b = parsePointer((await run({ key: owner.file, nx: commitment })).pointer).record;
  assert.equal(b.nx, commitment);
  await assert.rejects(run({ key: owner.file, nextKey: pubFile, nx: 'A'.repeat(43) }), (e) => e instanceof UsageError && /not the commitment/.test(e.message));
  await assert.rejects(run({ key: owner.file, nx: 'short' }), UsageError);
  await assert.rejects(run({ key: owner.file, nextKey: owner.file }), (e) => e instanceof UsageError && /commit to a different key/.test(e.message), 'the next key is not the signing key');
  await assert.rejects(run({ nextKey: join(work, 'missing') }), ToolError);
  writeFileSync(join(work, 'junk.pub'), 'not a key');
  await assert.rejects(run({ nextKey: join(work, 'junk.pub') }), /neither a public key/);
});

test('nx continuity (MF-28): a later record of the same owner carries the commitment, a different one is refused, rotating to the committed key is silent', async () => {
  const owner = await makeKey();
  const next = await makeKey();
  const out = fresh('out');
  const first = await run({ key: owner.file, nextKey: next.file, out });
  const nx = parsePointer(first.pointer).record.nx;
  // 1. the next publish says nothing about the next key: the commitment is carried over
  const second = await run({ key: owner.file, out, seq: Math.floor(NOW / 1000) + 10 });
  const rec2 = parsePointer(second.pointer).record;
  assert.equal(rec2.nx, nx);
  assert.ok(second.warnings.some((w) => /nx= carried over/.test(w)));
  assert.equal((await verifyPointer(rec2, 'example.com', { now: NOW + 20000, previousRecord: parsePointer(first.pointer).record })).ok, true, 'loaders that hold the previous record accept it');
  // 2. a different commitment from the same owner is what loaders refuse as nx-changed: the tool refuses first
  const other = await makeKey();
  await assert.rejects(run({ key: owner.file, out, nextKey: other.file }), (e) => e instanceof ToolError && /nx-changed/.test(e.message));
  // 3. any other key is what loaders refuse as nx-mismatch, even with a valid rot= from the stolen current key
  const thief = await makeKey();
  await assert.rejects(run({ key: thief.file, out, prevKey: owner.file }), (e) => e instanceof ToolError && /nx-mismatch/.test(e.message));
  // the escape hatch for a scope nobody has seen: skip the previous record
  const fresh2 = await run({ key: thief.file, out: fresh('out'), prevPointer: 'none' });
  assert.ok(fresh2.pointer);
  // 4. rotating to the committed key: accepted by loaders without rot=, and the tool says so
  const rotated = await run({ key: next.file, out, dir: makeSite() });
  const recR = parsePointer(rotated.pointer).record;
  const vR = await verifyPointer(recR, 'example.com', { now: NOW, pinnedOwner: owner.pub, previousRecord: parsePointer(second.pointer).record });
  assert.equal(vR.ok, true, JSON.stringify(vR));
  assert.equal(vR.rotated, true);
  assert.equal(vR.nx, 'match');
  assert.ok(rotated.warnings.some((w) => /committed next owner key/.test(w)));
  // a previous record of another scope in the same --out is not consulted
  const otherScope = await run({ key: thief.file, out, scope: 'other.example' });
  assert.ok(otherScope.pointer);
});

test('nx= is checked against an explicit --prev-pointer file; a file that is not a signed pointer is an error', async () => {
  const owner = await makeKey();
  const next = await makeKey();
  const first = await run({ key: owner.file, nextKey: next.file });
  const file = join(work, 'previous-pointer.txt');
  writeFileSync(file, first.pointer + '\n');
  const again = await run({ key: owner.file, prevPointer: file });
  assert.equal(parsePointer(again.pointer).record.nx, parsePointer(first.pointer).record.nx);
  writeFileSync(join(work, 'bad-pointer.txt'), 'v=mw1; btih=' + '0'.repeat(40));
  await assert.rejects(run({ key: owner.file, prevPointer: join(work, 'bad-pointer.txt') }), /not a signed pointer record/);
  await assert.rejects(run({ key: owner.file, prevPointer: join(work, 'nothing-here.txt') }), /does not exist/);
});

test('org= is at most 4 exact origins; ml= and idp= are validated; --ml newer than this loader warns', async () => {
  assert.equal(ORG_MAX, 4);
  assert.deepEqual(orgList(['https://a.example', 'https://b.example:8443', 'http://localhost:8080']), ['https://a.example', 'https://b.example:8443', 'http://localhost:8080']);
  assert.throws(() => orgList(['https://a.example/']), (e) => e instanceof UsageError && /exact origin/.test(e.message), 'a trailing slash is not an origin');
  assert.throws(() => orgList(['https://a.example/path']), UsageError);
  assert.throws(() => orgList(['http://a.example']), UsageError, 'http only for loopback');
  assert.throws(() => orgList(['https://a.example', 'https://a.example']), /twice/);
  assert.throws(() => orgList(['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example']), (e) => e instanceof UsageError && /at most 4/.test(e.message));
  assert.equal(orgList(['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']).length, 4);
  await assert.rejects(run({ ml: 'latest' }), (e) => e instanceof UsageError && /x\.y\.z/.test(e.message));
  await assert.rejects(run({ ml: '1.2' }), UsageError);
  await assert.rejects(run({ idp: 'https://id.example.org/' }), UsageError);
  await assert.rejects(run({ idp: 'id.example.org' }), UsageError);
  const newer = await run({ ml: '9.0.0' });
  assert.ok(newer.warnings.some((w) => /newer than the loader in this repository/.test(w)));
  const same = await run({ ml: CONFIG.version });
  assert.equal(same.warnings.some((w) => /newer than the loader/.test(w)), false);
  const four = await run({ org: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'], nextKey: (await makeKey()).file, ml: '0.3.0', idp: 'https://id.example.org' });
  assert.equal(four.summary.org.length, 4);
  const budget = Buffer.byteLength(four.pointer, 'utf8');
  assert.ok(budget <= 900, 'four origins, nx, ml and idp still fit the 900-byte pointer limit (' + budget + ' bytes)');
});

test('rot= is the v2 input only: --prev-key verifies with the scope, and a v1 verification (no scope) never accepts', async () => {
  const oldKey = await makeKey();
  const newKey = await makeKey();
  const out = fresh('out');
  await run({ key: oldKey.file, out }); // the ledger genesis stays: --prev-key keeps the ledger
  const res = await run({ key: newKey.file, prevKey: oldKey.file, out });
  const rec = parsePointer(res.pointer).record;
  assert.ok(rec.rot, 'rot= is written');
  assert.equal(await verifyRotation(rec, oldKey.pub, 'example.com'), true);
  assert.equal(await verifyRotation(rec, oldKey.pub), false, 'the v1 path (no scope) is gone');
  assert.equal(await verifyRotation(rec, oldKey.pub, 'other.example'), false, 'bound to the scope');
  const oldIdentity = await loadOwnerKey(oldKey.file);
  await assert.rejects(signRotation({ owner: newKey.pub, seq: 5 }, oldIdentity.privateKey), TypeError);
  assert.equal(res.summary.mode, 'shell');
});

// ---------------------------------------------------------------------------------------------- own tracker and STUN

test('chat, files and media need the site\'s own tracker and STUN: publish refuses without them, with a message that names both', async () => {
  const dist = fakeDist();
  for (const feature of ['chat', 'files', 'media']) {
    await assert.rejects(run({ [feature]: true, tr: [], dist }), (e) => e instanceof UsageError && /--tracker/.test(e.message) && /--stun/.test(e.message) && new RegExp(feature).test(e.message), feature);
  }
  // a tracker alone is not enough, a STUN alone is not enough
  await assert.rejects(run({ chat: true, tracker: ['wss://own.example'], dist }), (e) => e instanceof UsageError && /--stun/.test(e.message) && !/--tracker <wss/.test(e.message));
  await assert.rejects(run({ chat: true, tr: [], stun: ['stun:stun.own.example:3478'], dist }), (e) => e instanceof UsageError && /--tracker/.test(e.message));
  // the shared public trackers are not "own", with --tr public or listed by hand
  await assert.rejects(run({ chat: true, tr: ['public'], stun: ['stun:stun.own.example:3478'], dist }), /--tracker/);
  await assert.rejects(run({ chat: true, tr: CONFIG.trackers.slice(0, 1), stun: ['stun:stun.own.example:3478'], dist }), /--tracker/);
  // --chat-panel means chat
  await assert.rejects(run({ chatPanel: true, tr: [], dist }), /chat is on/);
  // with both, it publishes, and the STUN list is part of the signed torrent (/.mw/site.json)
  const ok = await run({ chat: true, files: true, media: true, tracker: ['wss://own.example'], stun: ['stun:stun.own.example:3478'], dist, out: fresh('out'), tr: [] });
  const pointer = parsePointer(ok.pointer).record;
  assert.ok(pointer.tr.includes('wss://own.example'), 'the own tracker is in tr=');
  const site = JSON.parse(readFileSync(join(ok.outDir, 'my-site', '.mw', 'site.json'), 'utf8'));
  assert.deepEqual(site.stun, ['stun:stun.own.example:3478']);
  assert.equal(site.turn, undefined);
  assert.deepEqual(ok.summary.features, ['chat', 'files', 'media']);
  assert.deepEqual(ok.summary.stun, ['stun:stun.own.example:3478']);
  // without a feature on, nothing is required (the v0.2.1 behaviour) and site.json has no stun
  const plain = await run({});
  assert.equal(JSON.parse(readFileSync(join(plain.outDir, 'my-site', '.mw', 'site.json'), 'utf8')).stun, undefined);
});

test('--cfg-from reads _mw.cfg from a ledger export: a site whose ledger turns chat on is refused until it names its tracker and STUN', async () => {
  const owner = await makeKey();
  const identity = await loadOwnerKey(owner.file);
  const ledgerId = await ledgerIdForOwner(identity.pub, { scope: 'example.com' });
  const genesis = await createGenesis({ identity, ledgerId, now: NOW });
  const withChat = await setCfg({ blocks: [genesis], identity, set: { chat: 'members' }, now: NOW + 60000 });
  const chatFile = join(work, 'chat-ledger.json');
  writeBlocksFile(chatFile, withChat.blocks);
  const offFile = join(work, 'off-ledger.json');
  writeBlocksFile(offFile, (await setCfg({ blocks: [genesis], identity, set: { chat: 'off' }, now: NOW + 60000 })).blocks);
  await assert.rejects(run({ key: owner.file, cfgFrom: chatFile }), (e) => e instanceof UsageError && /chat is on/.test(e.message));
  assert.ok(await run({ key: owner.file, cfgFrom: offFile }), 'chat off: nothing required');
  assert.ok(await run({ key: owner.file, cfgFrom: chatFile, tracker: ['wss://own.example'], stun: ['stun:stun.own.example'] }));
});

test('featureProblems, ownTrackers, stunList and turnConfig as functions', () => {
  assert.deepEqual(featureProblems({ features: [], tr: [], stun: [] }), []);
  assert.equal(featureProblems({ features: ['chat'], tr: [], stun: [] }).length, 2);
  assert.equal(featureProblems({ features: ['chat'], tr: ['wss://own.example'], stun: ['stun:s.example'] }).length, 0);
  assert.deepEqual(ownTrackers(['wss://own.example'].concat(CONFIG.trackers)), ['wss://own.example']);
  assert.deepEqual(stunList(['stun:a.example:3478', 'stun:a.example:3478,stuns:b.example']), ['stun:a.example:3478', 'stuns:b.example']);
  assert.throws(() => stunList(['turn:a.example']), UsageError);
  assert.throws(() => stunList(['a.example:3478']), UsageError);
  assert.throws(() => stunList(['stun:1', 'stun:2', 'stun:3', 'stun:4', 'stun:5']), UsageError);
  assert.equal(turnConfig([], null), null);
  assert.deepEqual(turnConfig(['turns:t.example:5349', 'turn:t.example:3478']), { urls: ['turn:t.example:3478', 'turns:t.example:5349'], mode: 'static' });
  assert.deepEqual(turnConfig(['https://t.example/credentials']), { urls: ['https://t.example/credentials'], mode: 'endpoint' });
  assert.throws(() => turnConfig(['https://t.example/c'], 'static'), UsageError);
  assert.throws(() => turnConfig(['turn:t.example'], 'endpoint'), UsageError);
  assert.throws(() => turnConfig(['ftp://t.example']), UsageError);
  assert.throws(() => turnConfig([], 'static'), UsageError);
});

test('--turn is written to /.mw/site.json next to the STUN list and reported with the matching ledger-admin command; it is off unless given', async () => {
  const dist = fakeDist();
  const lines = [];
  const res = await run({
    chat: true, tracker: ['wss://own.example'], stun: ['stun:stun.own.example'], turn: ['turns:turn.own.example:5349'], dist, out: fresh('out'), quiet: false, log: (l) => lines.push(String(l)),
  });
  const site = JSON.parse(readFileSync(join(res.outDir, 'my-site', '.mw', 'site.json'), 'utf8'));
  assert.deepEqual(site.turn, { urls: ['turns:turn.own.example:5349'], mode: 'static' });
  assert.ok(lines.some((l) => /ledger-admin\.mjs cfg .*--turn turns:turn\.own\.example:5349 --turn-mode static/.test(l)));
});

// ---------------------------------------------------------------------------------------------- widgets

test('--signin-widget and --chat-panel copy the built widgets, print script tags whose SRI matches the bytes, and put the files in the deploy copy', async () => {
  const dist = fakeDist();
  const lines = [];
  const res = await run({
    dir: (() => { const d = fresh('existing'); writeTree(d, { 'index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>\n', 'a.css': 'a{}' }); return d; })(),
    dropin: true, dist, signinWidget: true, chatPanel: true, tracker: ['wss://own.example'], stun: ['stun:stun.own.example:3478'], ws: [], tr: [],
    signinStatement: 'Sign in to Example Forum', challengeUrl: '/auth/mw/challenge', proofUrl: '/auth/mw/verify',
    quiet: false, log: (l) => lines.push(String(l)),
  });
  const signinSri = sri384(Buffer.from(SIGNIN_BYTES));
  const panelSri = sri384(Buffer.from(PANEL_BYTES));
  const text = lines.join('\n');
  assert.ok(text.includes('<script type="module" src="/_mw/signin.js" integrity="' + signinSri + '" crossorigin></script>'), 'the script tag of R 2.3.6, with the SRI of the file');
  assert.ok(text.includes('<mw-signin statement="Sign in to Example Forum" challenge-url="/auth/mw/challenge" proof-url="/auth/mw/verify"></mw-signin>'));
  assert.ok(text.includes('<script type="module" src="/_mw/chat-panel.js" integrity="' + panelSri + '" crossorigin></script>'));
  assert.ok(text.includes('<mw-chat-panel></mw-chat-panel>'), 'CONF-1: the printed tag carries no tracker or stun attribute');
  assert.ok(!/<mw-chat-panel[^>]*(tracker|stun)=/.test(text));
  assert.ok(text.includes('Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.'));
  assert.deepEqual(res.summary.widgets.map((w) => [w.name, w.path, w.integrity]), [['signin', '/_mw/signin.js', signinSri], ['chat-panel', '/_mw/chat-panel.js', panelSri]]);
  // the copies: next to the outputs and inside the deploy copy, byte for byte what the build made
  assert.equal(readFileSync(join(res.outDir, 'widget', '_mw', 'signin.js'), 'utf8'), SIGNIN_BYTES);
  assert.equal(readFileSync(join(res.outDir, 'site', '_mw', 'signin.js'), 'utf8'), SIGNIN_BYTES);
  assert.equal(readFileSync(join(res.outDir, 'site', '_mw', 'chat-panel.js'), 'utf8'), PANEL_BYTES);
  const tags = readFileSync(join(res.outDir, 'widget', 'tags.html'), 'utf8');
  assert.ok(tags.includes(signinSri) && tags.includes(panelSri));
  // the CSP lines: connect-src names the own tracker, worker-src 'self', the widgets are same-origin scripts
  const csp = readFileSync(join(res.outDir, 'csp.txt'), 'utf8');
  assert.match(csp, /worker-src +'self'/);
  assert.match(csp, /connect-src +'self' wss:\/\/own\.example/);
  assert.match(csp, /script-src +'self' +\/_mw\/signin\.js and \/_mw\/chat-panel\.js/);
  assert.match(csp, /Cross-Origin-Opener-Policy: same-origin; same-origin-allow-popups is safe/);
  assert.ok(lines.some((l) => /^ {2}worker-src +'self'/.test(l)), 'the console prints the CSP lines a drop-in site must add');
  assert.ok(lines.some((l) => /^ {2}connect-src +'self' wss:\/\/own\.example/.test(l)));
  // a second run without the flags removes the stale copies
  const again = await publish({ dir: res.outDir && makeSite(), name: 'my-site', scope: 'example.com', key: (await makeKey()).file, tr: ['wss://t.example'], ws: [], out: res.outDir, now: NOW, quiet: true, prevPointer: 'none' });
  assert.equal(existsSync(join(again.outDir, 'widget')), false);
});

test('the widgets come from dist/_mw: a missing file stops publish and says how to build it; the default statement names the scope', async () => {
  const noWidgets = fakeDist({ widgets: false });
  await assert.rejects(run({ signinWidget: true, dist: noWidgets }), (e) => e instanceof ToolError && /node build\.mjs/.test(e.message) && /signin\.js/.test(e.message));
  await assert.rejects(run({ chatPanel: true, tracker: ['wss://own.example'], stun: ['stun:s.example'], tr: [], dist: noWidgets }), /chat-panel\.js/);
  const lines = [];
  await run({ signinWidget: true, dist: fakeDist(), quiet: false, log: (l) => lines.push(String(l)) });
  assert.ok(lines.join('\n').includes('statement="Sign in to example.com"'));
  await assert.rejects(run({ signinWidget: true, dist: fakeDist(), signinStatement: 'bad\u202etext' }), (e) => e instanceof UsageError && /statement/.test(e.message));
  await assert.rejects(run({ signinWidget: true, dist: fakeDist(), challengeUrl: 'https://elsewhere.example/c' }), /own origin/);
  await assert.rejects(run({ signinWidget: true, dist: fakeDist(), proofUrl: '//elsewhere.example/p' }), /own origin/);
  const tag = widgetTags({ name: 'signin', integrity: 'sha384-X', statement: 'a "quoted" <b>', challengeUrl: '/c', proofUrl: '/p' });
  assert.ok(tag.element.includes('statement="a &quot;quoted&quot; &lt;b&gt;"'), 'attribute values are escaped');
  assert.ok(tag.script.startsWith('<script type="module" src="/_mw/signin.js" integrity="sha384-X" crossorigin>'));
});

test('--chat-panel on a shell site warns that the panel needs the drop-in engine', async () => {
  const res = await run({ chatPanel: true, tracker: ['wss://own.example'], stun: ['stun:s.example'], tr: [], dist: fakeDist() });
  assert.ok(res.warnings.some((w) => /drop-in/.test(w) && /window\.mw/.test(w)));
});

// ---------------------------------------------------------------------------------------------- headers

test('loader pages get Cross-Origin-Opener-Policy: same-origin-allow-popups and Referrer-Policy: no-referrer in _headers', async () => {
  assert.deepEqual(Object.assign({}, LOADER_HEADER_VALUES), { 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', 'Referrer-Policy': 'no-referrer' });
  const rules = parseHeaders(loaderHeadersText());
  assert.deepEqual(rules.map((r) => r.for), ['/', '/index.html', '/404.html']);
  for (const r of rules) assert.deepEqual(r.values, { 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', 'Referrer-Policy': 'no-referrer' });
  assert.equal(/same-origin\s*$/m.test(loaderHeadersText()), false, 'never plain same-origin');
  const dist = fakeDist();
  const shell = await run({ shell: true, dist });
  assert.equal(readFileSync(join(shell.outDir, 'shell', '_headers'), 'utf8'), loaderHeadersText());
  assert.equal(readFileSync(join(shell.outDir, 'loader-headers.txt'), 'utf8'), loaderHeadersText());
  assert.ok(shell.outputs.includes('shell/_headers'));
  const plain = await run({});
  assert.equal(readFileSync(join(plain.outDir, 'loader-headers.txt'), 'utf8'), loaderHeadersText(), 'written in every mode, for hosts that serve the loader themselves');
  // an existing _headers in the built loader is kept and ours follows it
  writeFileSync(join(dist, '_headers'), '/_mw/*\n  Cache-Control: no-cache\n');
  const merged = await run({ shell: true, dist });
  const mergedText = readFileSync(join(merged.outDir, 'shell', '_headers'), 'utf8');
  assert.ok(mergedText.startsWith('/_mw/*\n  Cache-Control: no-cache\n\n'));
  assert.ok(mergedText.includes('Cross-Origin-Opener-Policy: same-origin-allow-popups'));
});

test('the CSP text of a drop-in site names worker-src \'self\' and the tracker; a plain site gets no widget lines', () => {
  const base = { dropin: true, tr: ['wss://own.example'], ws: [], xs: [], cs: null, scope: 'example.com' };
  const plain = cspText(base);
  assert.match(plain, /worker-src +'self'/);
  assert.match(plain, /connect-src +'self' wss:\/\/own\.example/);
  assert.equal(/signin\.js/.test(plain), false);
  const rich = cspText(Object.assign({}, base, { widgets: [{ path: '/_mw/signin.js' }], features: ['chat'] }));
  assert.match(rich, /signin\.js are module scripts on your own origin with integrity=/);
  assert.match(rich, /With chat on, connect-src above must hold your own tracker/);
});

// ---------------------------------------------------------------------------------------------- the command line

function cli(args) {
  return spawnSync(process.execPath, ['tools/publish.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('command line: the new flags are in --help; refusals are usage errors (exit 2); a good run prints the tags', async () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  for (const flag of ['--org', '--next-key', '--nx', '--ml', '--idp', '--prev-pointer', '--signin-widget', '--signin-statement', '--challenge-url', '--proof-url', '--chat-panel',
    '--tracker', '--stun', '--turn', '--turn-mode', '--chat', '--files', '--media', '--cfg-from']) {
    assert.ok(help.stdout.includes(flag), '--help names ' + flag);
    assert.ok(Object.prototype.hasOwnProperty.call(PUBLISH_FLAGS, flag.slice(2)), flag + ' is a parsed flag');
  }
  const key = (await makeKey()).file;
  const dir = makeSite();
  const noTracker = cli([dir, '--name', 'x', '--scope', 'example.com', '--key', key, '--chat', '--out', fresh('o'), '--quiet']);
  assert.equal(noTracker.status, 2);
  assert.match(noTracker.stderr, /--tracker/);
  assert.equal(cli([dir, '--name', 'x', '--scope', 'example.com', '--key', key, '--org', 'https://a.example/', '--out', fresh('o'), '--quiet']).status, 2);
  const five = ['a', 'b', 'c', 'd', 'e'].flatMap((x) => ['--org', 'https://' + x + '.example']);
  assert.equal(cli([dir, '--name', 'x', '--scope', 'example.com', '--key', key, ...five, '--out', fresh('o'), '--quiet']).status, 2);
  const good = cli([dir, '--name', 'x', '--scope', 'example.com', '--key', key, '--org', 'https://www.example.com', '--ml', '0.3.0', '--idp', 'https://id.example.org', '--tr', 'wss://t.example', '--out', fresh('o')]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /org +https:\/\/www\.example\.com/);
  assert.match(good.stdout, /ml +0\.3\.0/);
  assert.match(good.stdout, /idp +https:\/\/id\.example\.org/);
});

test('wording: nothing the new code prints uses the words the project does not use', () => {
  const source = readFileSync(join(ROOT, 'tools', 'publish.mjs'), 'utf8');
  for (const word of ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready']) {
    assert.equal(source.toLowerCase().includes(word), false, word);
  }
});

// ---------------------------------------------------------------------------------------------- tools/webseed-file.mjs (R 2.8.5, 2.8.6; MF-50)

import { statSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { webseedFile, commonHeaders, headersText, readEntries, wsUrl, headersOfWritten, LANE_CAPS, WEBSEED_CORS, DEFAULT_PREFIX } from '../../tools/webseed-file.mjs';
import { createDevServer, createIdpServer } from '../../tools/dev-server.mjs';
import { fileHeaders } from '../../src/files/serve.js';
import { encode as bencode } from '../../src/common/bencode.js';

function sha256hexOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeFile(name, content) {
  const file = join(fresh('f'), name);
  writeFileSync(file, content);
  return file;
}

function makeTorrent(bytes, { nonce = false, name = 'file.bin' } = {}) {
  const plen = 16384;
  const pieces = [];
  for (let i = 0; i < bytes.length; i += plen) pieces.push(createHash('sha1').update(bytes.subarray(i, i + plen)).digest());
  const info = { length: bytes.length, name: Buffer.from(name), 'piece length': plen, pieces: Buffer.concat(pieces) };
  if (nonce) info['x-mw-nonce'] = Buffer.alloc(16, 7);
  const file = join(fresh('t'), 'x.torrent');
  writeFileSync(file, bencode({ info }));
  return { file, infoHash: createHash('sha1').update(bencode(info)).digest('hex') };
}

test('webseed-file: the bytes land under <dir>/ws-files/<sha256> and _headers carries the R 2.8.5 headers; ws is the URL of that file', async () => {
  const dir = fresh('seed');
  const bytes = Buffer.from('<script>alert(1)</script> not a page, just bytes\n');
  const file = makeFile('evil.html', bytes);
  const r = await webseedFile({ file, dir, base: 'https://static.example/', name: 'evil\u202e.html' });
  const sha = sha256hexOf(bytes);
  assert.equal(r.sha256, sha);
  assert.equal(r.ws, 'https://static.example/ws-files/' + sha);
  assert.equal(wsUrl('https://static.example', DEFAULT_PREFIX, sha), r.ws, 'a base without a trailing slash is the same');
  assert.deepEqual(readFileSync(join(dir, 'ws-files', sha)), bytes);
  assert.equal(statSync(join(dir, 'ws-files', sha)).mode & 0o111, 0, 'no execute bit');
  const text = readFileSync(join(dir, '_headers'), 'utf8');
  const merged = headersOfWritten(text, '/ws-files/' + sha);
  const expected = fileHeaders({ name: 'evil.html', size: undefined });
  for (const name of ['Content-Type', 'X-Content-Type-Options', 'Content-Security-Policy', 'Cross-Origin-Resource-Policy', 'Cache-Control', 'Accept-Ranges']) {
    assert.equal(merged[name], expected[name], name + ' is the one the Service Worker route sends');
  }
  assert.equal(merged['Content-Type'], 'application/octet-stream');
  assert.equal(merged['X-Content-Type-Options'], 'nosniff');
  assert.equal(merged['Content-Security-Policy'], "sandbox; default-src 'none'");
  assert.equal(merged['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(merged['Cache-Control'], 'no-store');
  assert.equal(merged['Content-Disposition'], "attachment; filename*=UTF-8''evil.html", 'the bidi override is gone from the name');
  for (const [k, v] of Object.entries(WEBSEED_CORS)) assert.equal(merged[k], v);
  assert.equal(merged['Access-Control-Allow-Origin'], '*');
  assert.deepEqual(Object.keys(commonHeaders()).filter((k) => /disposition|length|range$/i.test(k) && k !== 'Accept-Ranges' && k !== 'Access-Control-Allow-Headers'), [], 'no per-file or dynamic header in the common block');
  // a path outside the prefix gets nothing
  assert.deepEqual(headersOfWritten(text, '/index.html'), {});
  // the content-addressed name has no extension, so no host or browser decides a type from it
  assert.equal(/\./.test(r.path), false);
  assert.match(r.path, /^ws-files[\\/][0-9a-f]{64}$/);
});

test('webseed-file: every duplicate-free header block: a path matches the generic rule and its own, and no header is stated twice', async () => {
  const dir = fresh('seed');
  const a = await webseedFile({ file: makeFile('a.txt', 'first'), dir, base: 'https://static.example/' });
  const b = await webseedFile({ file: makeFile('b.bin', 'second file'), dir, base: 'https://static.example/', name: 'Report (final) - caf\u00e9.bin' });
  const text = readFileSync(join(dir, '_headers'), 'utf8');
  assert.deepEqual(readEntries(text, '/ws-files/').map((e) => e.sha256).sort(), [a.sha256, b.sha256].sort(), 'the entry of the first run is kept');
  const merged = headersOfWritten(text, '/ws-files/' + b.sha256);
  assert.equal(merged['Content-Disposition'], "attachment; filename*=UTF-8''Report%20%28final%29%20-%20caf%C3%A9.bin");
  // a header stated by two matching blocks would be joined with ", " and come out different from the single source
  for (const [name, value] of Object.entries(commonHeaders())) assert.equal(merged[name], value, name + ' is stated once');
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(commonHeaders()).concat(['Content-Disposition']).sort(), 'nothing else, nothing twice');
  // running again changes nothing
  await webseedFile({ file: makeFile('a.txt', 'first'), dir, base: 'https://static.example/' });
  assert.equal(readFileSync(join(dir, '_headers'), 'utf8'), text);
  assert.equal(readdirSync(join(dir, 'ws-files')).length, 2);
  assert.equal(headersText({ prefixPath: '/ws-files/', entries: readEntries(text, '/ws-files/') }), text, 'the writer and the reader agree');
  // a base under a path: the rules use the path of the URL
  const sub = fresh('seed');
  const s = await webseedFile({ file: makeFile('c.bin', 'third'), dir: sub, base: 'https://static.example/files/v1/' });
  assert.equal(s.ws, 'https://static.example/files/v1/ws-files/' + s.sha256);
  assert.ok(readFileSync(join(sub, '_headers'), 'utf8').includes('/files/v1/ws-files/*'));
});

test('webseed-file: the lane caps (25 MiB public, 100 MiB private), a base that is https, a plain prefix; private files are the ciphertext and say so', async () => {
  assert.equal(LANE_CAPS.public, 25 * 1024 * 1024);
  assert.equal(LANE_CAPS.private, 100 * 1024 * 1024);
  const dir = fresh('seed');
  const big = makeFile('big.bin', Buffer.alloc(LANE_CAPS.public + 1));
  await assert.rejects(webseedFile({ file: big, dir, base: 'https://static.example/' }), (e) => e instanceof ToolError && /26,214,401 bytes, over the 26,214,400 bytes \(25 MiB\) cap of a public file/.test(e.message));
  const priv = await webseedFile({ file: big, dir, base: 'https://static.example/', lane: 'private' });
  assert.equal(priv.lane, 'private');
  await assert.rejects(webseedFile({ file: makeFile('e.bin', ''), dir, base: 'https://static.example/' }), /is empty/);
  await assert.rejects(webseedFile({ file: join(work, 'missing'), dir, base: 'https://static.example/' }), UsageError);
  await assert.rejects(webseedFile({ file: big, dir, base: 'http://static.example/' }), /https/);
  await assert.rejects(webseedFile({ file: big, dir, base: 'https://static.example/?x=1' }), /no query/);
  await assert.rejects(webseedFile({ file: big, dir, base: 'static.example' }), UsageError);
  await assert.rejects(webseedFile({ file: big, dir, base: 'https://static.example/', lane: 'secret' }), /--lane/);
  await assert.rejects(webseedFile({ file: big, dir, base: 'https://static.example/', prefix: '../x' }), /--prefix/);
  assert.ok((await webseedFile({ file: makeFile('l.bin', 'local'), dir: fresh('seed'), base: 'http://127.0.0.1:8080/' })).ws.startsWith('http://127.0.0.1:8080/ws-files/'), 'http is for localhost');
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { lines.push(String(c)); return true; };
  let res;
  try {
    res = spawnSync(process.execPath, ['tools/webseed-file.mjs', makeFile('p.bin', 'cipher'), '--dir', fresh('seed'), '--base', 'https://static.example/', '--lane', 'private'], { cwd: ROOT, encoding: 'utf8' });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ciphertext of a private file/);
  assert.match(res.stdout, /^ws=https:\/\/static\.example\/ws-files\/[0-9a-f]{64}$/m);
  void lines;
});

test('webseed-file --torrent: the bytes are checked against the torrent (one file, its length, every piece); a changed byte or a wrong torrent stops it before anything is written', async () => {
  const bytes = Buffer.alloc(40000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  const t = makeTorrent(bytes);
  const dir = fresh('seed');
  const ok = await webseedFile({ file: makeFile('data.bin', bytes), dir, base: 'https://static.example/', torrent: t.file });
  assert.equal(ok.infoHash, t.infoHash);
  const bad = Buffer.from(bytes);
  bad[20000] ^= 1;
  const dir2 = fresh('seed');
  await assert.rejects(webseedFile({ file: makeFile('data.bin', bad), dir: dir2, base: 'https://static.example/', torrent: t.file }), (e) => e instanceof ToolError && /piece 1 of --torrent does not match/.test(e.message));
  assert.equal(existsSync(join(dir2, 'ws-files')), false, 'nothing is written');
  assert.equal(existsSync(join(dir2, '_headers')), false);
  const other = makeTorrent(Buffer.alloc(10));
  await assert.rejects(webseedFile({ file: makeFile('data.bin', bytes), dir: fresh('seed'), base: 'https://static.example/', torrent: other.file }), /is not a public file torrent for these bytes/);
  // a private torrent carries the nonce of R 2.9.4; a public one does not pass as private
  const priv = makeTorrent(bytes, { nonce: true });
  assert.equal((await webseedFile({ file: makeFile('c.bin', bytes), dir: fresh('seed'), base: 'https://static.example/', torrent: priv.file, lane: 'private' })).infoHash, priv.infoHash);
  await assert.rejects(webseedFile({ file: makeFile('c.bin', bytes), dir: fresh('seed'), base: 'https://static.example/', torrent: t.file, lane: 'private' }), /nonce/);
  await assert.rejects(webseedFile({ file: makeFile('c.bin', bytes), dir: fresh('seed'), base: 'https://static.example/', torrent: join(work, 'no.torrent') }), /cannot read --torrent/);
});

// ---------------------------------------------------------------------------------------------- dev-server --idp-port

async function get(url, init = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method || 'GET', headers: init.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeIdpTree() {
  const dir = fresh('dist-idp');
  writeTree(dir, {
    'index.html': '<!doctype html><title>identity</title><script src="/idp.js"></script>\n',
    'idp.js': 'export const idp = 1;\n',
    'assets/app.css': 'body{}\n',
    '404.html': '<!doctype html><title>no</title>\n',
    '.secret': 'hidden\n',
    '_redirects': '/old /new 301\n',
    '_headers': [
      '/*',
      "  Content-Security-Policy: default-src 'none'; script-src 'self'; frame-ancestors 'none'",
      '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
      '  Referrer-Policy: no-referrer',
      '/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '',
    ].join('\n'),
  });
  return dir;
}

test('--idp-port: the identity page is served from dist-idp on 127.0.0.1 with the headers of its _headers file, and _headers itself is not served', async () => {
  const root = makeIdpTree();
  const idp = await createIdpServer({ root, port: 0, quiet: true });
  try {
    assert.equal(idp.server.address().address, '127.0.0.1', 'loopback only');
    assert.match(idp.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(idp.urls.some((u) => /^http:\/\/localhost:\d+\/$/.test(u)));
    const home = await get(idp.url);
    assert.equal(home.status, 200);
    assert.match(home.body, /<title>identity<\/title>/);
    assert.equal(home.headers['content-security-policy'], "default-src 'none'; script-src 'self'; frame-ancestors 'none'");
    assert.equal(home.headers['cross-origin-opener-policy'], 'same-origin-allow-popups');
    assert.equal(home.headers['referrer-policy'], 'no-referrer');
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    const asset = await get(idp.url + 'assets/app.css');
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable', 'a path rule overrides the default');
    assert.equal(asset.headers['content-security-policy'], home.headers['content-security-policy'], 'and the general rule still applies');
    assert.equal((await get(idp.url + '_headers')).status, 404);
    assert.equal((await get(idp.url + '_redirects')).status, 404);
    assert.equal((await get(idp.url + '.secret')).status, 404, 'dotfiles are not served');
    const missing = await get(idp.url + 'no/such/page');
    assert.equal(missing.status, 404, 'no SPA fallback');
    assert.match(missing.body, /<title>no<\/title>/, 'the 404 page, with the same headers');
    assert.equal(missing.headers['referrer-policy'], 'no-referrer');
    assert.ok([400, 404].includes((await get(idp.url + '..%2f..%2fetc%2fpasswd')).status), 'a path that climbs out of the root is refused');
    assert.equal((await get(idp.url + 'idp.js', { method: 'HEAD' })).status, 200);
    assert.equal((await get(idp.url + 'idp.js', { headers: { range: 'bytes=0-5' } })).status, 206);
    assert.equal((await get(idp.url + 'idp.js', { method: 'POST' })).status, 405);
    // the headers file is re-read when it changes
    writeFileSync(join(root, '_headers'), "/*\n  Content-Security-Policy: default-src 'self'\n  X-Extra: 2\n");
    const later = await get(idp.url);
    assert.equal(later.headers['content-security-policy'], "default-src 'self'");
    assert.equal(later.headers['x-extra'], '2');
  } finally {
    await idp.close();
  }
  await assert.rejects(createIdpServer({ root: join(work, 'no-such-dist-idp'), quiet: true }), (e) => e instanceof ToolError && /npm run build:idp/.test(e.message));
  const lines = [];
  const bare = fresh('dist-idp');
  writeTree(bare, { 'index.html': 'x' });
  const warned = await createIdpServer({ root: bare, port: 0, log: (l) => lines.push(l) });
  await warned.close();
  assert.ok(lines.some((l) => /has no _headers file/.test(l)));
});

test('--idp-port with the dev server: two loopback ports (two origins), both closed together; a missing dist-idp stops the start and frees the main port', async () => {
  const root = fresh('dist');
  writeTree(root, { 'index.html': '<!doctype html><title>shell</title>\n', 'mw-sw.js': '//\n' });
  const dev = await createDevServer({ root, port: 0, quiet: true, idpPort: 0, idpRoot: makeIdpTree(), dev: true });
  try {
    assert.ok(dev.idp);
    assert.notEqual(dev.idp.port, dev.port);
    assert.notEqual(new URL(dev.url).origin, new URL(dev.idp.url).origin, 'a different port is a different origin');
    assert.match((await get(dev.url)).body, /shell/);
    assert.match((await get(dev.idp.url)).body, /identity/);
    assert.equal((await get(dev.idp.url)).headers['referrer-policy'], 'no-referrer');
    assert.equal((await get(dev.url)).headers['referrer-policy'], undefined, 'the identity page headers do not leak onto the site');
    // --dev serves the chunk store module the seeder uses
    const store = await get(dev.url + '_dev/store-idb.js');
    assert.equal(store.status, 200);
    assert.match(store.headers['content-type'], /javascript/);
    assert.match(store.body, /class IdbChunkStore/);
  } finally {
    await dev.close();
  }
  const plain = await createDevServer({ root, port: 0, quiet: true });
  try {
    assert.equal(plain.idp, null);
    assert.equal((await get(plain.url + '_dev/store-idb.js')).status, 404, 'only with --dev');
  } finally {
    await plain.close();
  }
  await assert.rejects(createDevServer({ root, port: 0, quiet: true, idpPort: 0, idpRoot: join(work, 'missing-idp') }), /build:idp/);
});

test('dev-server command line: --idp-port prints and reports the identity page URL', async () => {
  const root = fresh('dist');
  writeTree(root, { 'index.html': '<!doctype html><title>shell</title>\n' });
  const child = spawnSync(process.execPath, ['tools/dev-server.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(child.stdout, /--idp-port/);
  assert.match(child.stdout, /--idp-root/);
  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--idp-port', '0', '--idp-root', makeIdpTree(), '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('no output from the dev server')), 15000);
      proc.stdout.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
        }
      });
      proc.on('error', reject);
    });
    const info = JSON.parse(line);
    assert.ok(info.idp && info.idp.port > 0 && info.idp.port !== info.port);
    assert.match((await get(info.idp.url)).body, /identity/);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('close', r));
  }
});

// ---------------------------------------------------------------------------------------------- review round PTR-7

test('PTR-7: a withdrawal keeps the nx= of the record it replaces, so a returning visitor that holds that record takes it', async () => {
  const owner = await makeKey();
  const next = await makeKey();
  const res = await run({ key: owner.file, nextKey: next.file });
  const previous = parsePointer(res.pointer).record;
  assert.ok(previous.nx);
  const later = NOW + 120000;
  const w = await withdraw({ scope: 'example.com', key: owner.file, why: 'court', out: res.outDir, now: later, quiet: true });
  assert.equal(w.record.nx, previous.nx, 'nx= is carried forward (read before pointer.txt was overwritten)');
  assert.equal(w.summary.nx, previous.nx);
  const returning = await verifyPointer(w.record, 'example.com', { now: later, pinnedOwner: owner.pub, previousRecord: previous, cachedSeq: previous.seq });
  assert.equal(returning.ok, true, JSON.stringify(returning));
  assert.equal(returning.withdrawn, true);
  // the same from a saved copy of the earlier pointer (--prev-pointer) into another folder
  const saved = join(fresh('saved'), 'pointer.txt');
  writeFileSync(saved, res.pointer + '\n');
  const w2 = await withdraw({ scope: 'example.com', key: owner.file, out: fresh('elsewhere'), prevPointer: saved, now: later, quiet: true });
  assert.equal(w2.record.nx, previous.nx);
  // a withdrawal by another key that is not the committed one would be ignored: refused, nothing written
  const stranger = await makeKey();
  const out3 = fresh('refused');
  await assert.rejects(withdraw({ scope: 'example.com', key: stranger.file, prevKey: owner.file, out: out3, prevPointer: saved, now: later, quiet: true }),
    (e) => e instanceof ToolError && /commits to a next owner key/.test(e.message) && /Nothing was written/.test(e.message));
  assert.equal(existsSync(join(out3, 'pointer.txt')), false);
  // the committed next key may sign it (the owner who lost the current key)
  const rotated = await withdraw({ scope: 'example.com', key: next.file, prevKey: owner.file, out: fresh('rotated'), prevPointer: saved, now: later, quiet: true });
  const v = await verifyPointer(rotated.record, 'example.com', { now: later, pinnedOwner: owner.pub, previousRecord: previous });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.rotated, true);
});
