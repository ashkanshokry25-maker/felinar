// Drift detector between the examples and the landed SDK (src/sdk/sdk.js): every SDK call the examples make exists on the facade a site gets from
// /_mw/sdk.js, every event they listen to is one the facade accepts, and the calls the social template still has no method for (GAP 2 and 4 in
// examples/social/js/hub.js) are reported. Pure Node: the facade is imported with no host behind it, so only its shape is looked at. ASCII only.
// Run: node --test test/example/sdk-surface.test.mjs   (or npm run test:example)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const sdk = await import(pathToFileURL(join(ROOT, 'src/sdk/sdk.js')).href);
const mw = sdk.default;

function files(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) files(abs, out);
    else if (/\.js$/.test(name)) out.push(abs);
  }
  return out;
}
const pathOf = (path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), mw);

// The calls the examples write out as mw.<namespace>.<method>(...), found in the source.
const SITES = ['examples/social/js', 'examples/peer-guestbook/js'];
const CALL = /\bmw\.((?:[a-z]+\.)+[a-zA-Z]+)\(/g;
const used = new Map();
for (const site of SITES) {
  for (const file of files(join(ROOT, site))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(relative(ROOT, file));
    }
  }
}

// Calls made through an alias the regular expression cannot see: examples/social/js/chat.js holds `chat = mw.chat`, hub.js holds `hub = mw.hub` and `db = mw.db`.
const ALIASED = [
  'chat.state', 'chat.enable', 'chat.disable', 'chat.on', 'chat.dm.send', 'chat.dm.history', 'chat.contacts.list', 'chat.contacts.add', 'chat.contacts.block', 'chat.contacts.unblock',
  'chat.contacts.verify', 'chat.presence.list', 'chat.presence.set', 'chat.requests.list', 'chat.requests.accept', 'chat.requests.decline', 'chat.requests.setOpen',
  'chat.room.join', 'chat.room.leave', 'chat.room.send', 'chat.group.create', 'chat.group.send', 'chat.holder.set',
  'hub.follow', 'hub.unfollow', 'hub.list', 'hub.createPage', 'db.subscribe', 'db.list',
];
// Not in the SDK yet: one function each in examples/social/js/hub.js, which throws NOT_AVAILABLE when the method is missing.
const GAPS = ['hub.withdrawPage', 'mod.requestJoin'];

test('every SDK call the examples write out exists on the facade of src/sdk/sdk.js', (t) => {
  assert.ok(used.size >= 40, 'found ' + used.size + ' distinct calls');
  const missing = [];
  for (const [path, where] of used) {
    if (GAPS.indexOf(path) !== -1) continue;
    if (typeof pathOf(path) !== 'function') missing.push(path + ' (' + Array.from(where).join(', ') + ')');
  }
  assert.deepEqual(missing, [], 'the examples call methods the SDK does not have');
  assert.equal(typeof mw.ready, 'function');
  for (const path of ['auth.signIn', 'auth.signOut', 'auth.onChange', 'me.get', 'me.set', 'me.del', 'me.sync', 'me.erase', 'identity.openIdentity', 'identity.backupStatus', 'identity.setName',
    'chat.enable', 'chat.room.join', 'chat.room.send', 'chat.on', 'files.list', 'files.share', 'files.fetch', 'files.preview', 'files.save', 'files.remove', 'files.on', 'db.append', 'db.tombstone',
    'db.subscribe', 'media.upload', 'media.list', 'media.open', 'media.share', 'hub.follow', 'hub.createPage', 'consent.state', 'mod.ban']) {
    assert.ok(used.has(path) || ALIASED.indexOf(path) !== -1, path + ' is expected to be called by an example');
  }
  t.diagnostic('distinct calls checked: ' + used.size);
});

test('the calls made through an alias exist too', () => {
  const missing = ALIASED.filter((path) => typeof pathOf(path) !== 'function');
  assert.deepEqual(missing, []);
});

test('the GAPs: reported, and written so that the template works either way', (t) => {
  for (const path of GAPS) {
    const present = typeof pathOf(path) === 'function';
    t.diagnostic(path + (present ? ' now exists in the SDK: remove it from the GAP table in examples/social/README.md and js/hub.js' : ' is still not in the SDK (a GAP)'));
  }
  const hub = readFileSync(join(ROOT, 'examples/social/js/hub.js'), 'utf8');
  for (const name of ['withdrawPage', 'requestJoin']) assert.match(hub, new RegExp("fn\\([^)]*'" + name + "'\\)"), name + ' is reached only through the optional lookup');
  assert.equal(typeof mw.hub.createPage, 'function', 'GAP 1 landed as mw.hub.createPage');
});

test('the events the examples listen to are accepted by the facade; an unknown one is refused', () => {
  const offs = [];
  const listens = (ns, event) => { const off = mw[ns].on(event, () => {}); if (typeof off === 'function') offs.push(off); };
  for (const event of ['message', 'room']) listens('chat', event);
  for (const event of ['shared', 'removed']) listens('files', event);
  for (const event of ['received', 'shared', 'revoked', 'unavailable']) listens('media', event);
  for (const off of offs) off();
  for (const ns of ['chat', 'files', 'media']) assert.throws(() => mw[ns].on('no-such-event', () => {}), (e) => e.code === 'E_LIMIT', ns);
  // The events are named where the examples listen: no others are used.
  const social = files(join(ROOT, 'examples/social/js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const m of social.matchAll(/\bsub\('([a-z]+)'/g)) assert.ok(['message', 'room'].indexOf(m[1]) !== -1, 'chat event ' + m[1]);
  for (const m of social.matchAll(/for \(const ev of \[([^\]]+)\]\) \{ try \{ const off = mw\.media\.on/g)) {
    for (const name of m[1].split(',').map((x) => x.trim().replace(/'/g, ''))) assert.ok(['received', 'shared', 'revoked', 'unavailable'].indexOf(name) !== -1, 'media event ' + name);
  }
});

test('the error codes the examples map to sentences are codes the SDK knows', () => {
  const known = new Set(sdk.ERROR_CODES);
  const text = readFileSync(join(ROOT, 'examples/peer-guestbook/js/common.js'), 'utf8');
  const table = text.slice(text.indexOf('export const ERRORS = {'), text.indexOf('export function explain'));
  const codes = [...table.matchAll(/\b(E_[A-Z_]+):/g)].map((m) => m[1]);
  assert.ok(codes.length >= 20);
  for (const code of codes) if (code !== 'E_NO_HOST') assert.ok(known.has(code), code + ' is in ERROR_CODES');
  assert.ok(known.has('E_NO_HOST'));
  const social = readFileSync(join(ROOT, 'examples/social/js/strings.js'), 'utf8');
  for (const m of social.matchAll(/\b(E_[A-Z_]+):/g)) assert.ok(known.has(m[1]), m[1] + ' is in ERROR_CODES');
});
