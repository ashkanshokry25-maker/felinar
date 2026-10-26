// The review round of the v0.3 design review (R 5.3; findings HON-1 to HON-14, STALK-11, SCALE-9, SCALE-16, SEC-11, CONF-1 to
// CONF-5, UX-19) found documents and card texts that claimed more than the code does. Each test reads the document or string and the
// code it describes, so the two cannot drift apart again: when the code changes, the test names the sentence to update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';
import { CONFIG } from '../../src/loader/config.js';
import { CARD_TEXT } from '../../src/loader/strings.js';
import { chooseBucket } from '../../src/chat/seal.js';
import { BUCKETS } from '../../src/chat/limits.js';
import { kitDue } from '../../src/idp/cards.js';
import { registerChatWire } from '../../src/chat/wire.js';
import { byteDoors } from '../../src/loader/doors.js';
import { DEFAULT_POLICY, FREEZE_POLICY_DEFAULTS } from '../../src/chain/block.js';
import { loadTargets } from '../fuzz/targets.mjs';
import { PIN_LIMITS } from '../../tools/pin.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const flat = (t) => t.replace(/\s+/g, ' ');
const doc = (p) => flat(read(p));
const USER_DOCS = ['README.md', 'docs/FAQ.md', 'docs/WHY.md', 'docs/PRIVACY.md', 'docs/COMPATIBILITY.md', 'docs/QUICKSTART.md', 'docs/SECURITY-MODEL.md'];

/** The source text of every .js and .mjs file under a directory (recursive). */
function sources(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.m?js$/.test(e.name)) out.push({ path: p, text: read(p) });
  }
  return out;
}
/** The CHANGELOG's "### Known gaps" block of the newest release. */
function knownGaps() {
  const text = read('CHANGELOG.md');
  const start = text.indexOf('\n### Known gaps\n');
  assert.ok(start > 0, 'CHANGELOG has a Known gaps section');
  const end = text.indexOf('\n## ', start + 1);
  return flat(text.slice(start, end));
}

test('HON-1, STALK-11: the stalking mitigations the code lacks are listed as known gaps while they are missing', () => {
  const gaps = knownGaps();
  const gossip = read('src/chain/gossip.js');
  const announce = gossip.slice(gossip.indexOf('announce('), gossip.indexOf('announce(') + 1500);
  if (!/jitter|Math\.random|subset/i.test(announce)) assert.match(gaps, /no jitter or random subset \(STALK A3 for blocks/);
  const app = read('src/loader/app.js');
  const sched = app.slice(app.indexOf('function scheduleUpdateCheck'), app.indexOf('function startDiagnostics'));
  assert.ok(sched.length > 100, 'found scheduleUpdateCheck and checkForUpdate');
  if (!/hidden|visibility/i.test(sched)) assert.match(gaps, /keeps its interval .* while the tab is hidden \(A11\)/);
  const src = sources('src').map((f) => f.text).join('\n');
  if (!/ipPrefix|addressPrefix|subnet[A-Z]/.test(src)) assert.match(gaps, /wire caps count wires, not address prefixes/);
  if (!/nameReuse|reusedName/.test(src)) assert.match(gaps, /reused on other sites \(A12\)/);
  assert.match(gaps, new RegExp('only the 0 to ' + (CONFIG.ledger.joinJitterMs / 1000) + ' s join jitter'));
});

test('HON-2: no document promises children\'s defaults keyed to the age setting while no code reads _mw.cfg.age', () => {
  const readers = sources('src').filter((f) => f.path !== 'src/chain/state.js' && /cfg\.age\b|cfg\[['"]age['"]\]|\.age\s*[!=]==/.test(f.text));
  if (readers.length) return; // a reader exists: the documents may describe it (and this test should then be rewritten)
  for (const p of ['docs/FAQ.md', 'docs/PRIVACY.md']) {
    const t = doc(p);
    assert.doesNotMatch(t, /With no age method set, the most private defaults apply/, p);
    assert.doesNotMatch(t, /uploads and profiles are off/i, p);
    assert.doesNotMatch(t, /gets the children's defaults/, p);
  }
  assert.match(doc('docs/FAQ.md'), /the age method setting \(`_mw\.cfg\.age`\) changes nothing: no code reads it/);
  assert.match(doc('docs/PRIVACY.md'), /no code reads `_mw\.cfg\.age`, so setting an age method changes nothing/);
  assert.match(knownGaps(), /`_mw\.cfg\.age` is written by the tools .* no code reads it/);
  assert.equal(DEFAULT_POLICY.writers, 'owner', 'profiles are off by writer policy under the default owner, as the documents say');
});

test('HON-3: PRIVACY states the assessments as the owner\'s duty while no tool reads the audience', () => {
  const tools = read('tools/ledger-admin.mjs') + read('tools/init.mjs');
  if (/\baud\b/.test(tools)) return;
  const t = doc('docs/PRIVACY.md');
  assert.doesNotMatch(t, /turns them on only after both assessments/);
  assert.match(t, /That is the owner's duty: the tools do not check it, and `--aud` changes only the consent gate\./);
});

// IND-1 (independence design, 2026-10-25): N-2 is decided as "none in 0.3.0", so the guard no longer returns early on a
// CHANGELOG sentence: it pins the decided wording and keeps refusing any claim that the project publishes an identity page.
test('HON-4: the project hosts no identity page by design (N-2), and no document says it publishes one or a release hash', () => {
  const files = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter((n) => n.endsWith('.md')).map((n) => 'docs/' + n)];
  for (const p of files) assert.doesNotMatch(doc(p), /project publishes (one|an identity)/i, p);
  assert.doesNotMatch(doc('docs/FAQ.md'), /a hash that the project publishes for each release/);
  for (const p of ['docs/FAQ.md', 'CHANGELOG.md', 'README.md', 'docs/QUICKSTART.md', 'docs/DEPLOY.md', 'docs/PRIVACY.md']) {
    assert.match(doc(p), /By design, the project hosts no identity page/i, p);
    assert.doesNotMatch(doc(p), /no default (identity (origin|page) )?(exists )?yet|no identity origin is published yet|has not been made \(N-2/i, p);
  }
  assert.doesNotMatch(doc('docs/PUBLISH-CHECKLIST.md'), /buy it yourself/i, 'section 16.6 no longer asks the owner to buy a domain');
  assert.match(doc('docs/PUBLISH-CHECKLIST.md'), /N-2 decided: no default identity origin in 0\.3\.0/);
});

test('HON-5: no document ties the identity to the Home Screen while the identity page never offers it', () => {
  for (const ios of [true, false]) for (const standalone of [true, false]) for (const meaningful of [true, false]) {
    assert.equal(kitDue({ ios, standalone, meaningful }).offerHomeScreen, false);
  }
  for (const p of USER_DOCS) {
    const t = doc(p);
    assert.doesNotMatch(t, /(posting identity|identity)[^.]{0,60}unless the site is added to the Home Screen/i, p);
    assert.doesNotMatch(t, /asks for that on the first visit/, p);
    assert.doesNotMatch(t, /Visitors can export their identity from Settings/, p);
    assert.doesNotMatch(t, /exports the identity in Safari and imports it there/, p);
  }
  for (const p of ['README.md', 'docs/FAQ.md', 'docs/WHY.md', 'docs/COMPATIBILITY.md']) assert.match(doc(p), /Home Screen is not a way to keep (it|the identity)/, p);
});

test('HON-6: every parser SECURITY-MODEL.md says is fuzzed has a fuzz target', async () => {
  const names = (await loadTargets()).map((t) => t.name);
  const m = doc('docs/SECURITY-MODEL.md').match(/\(targets for: ([^;]+); no target yet for: ([^;]+);/);
  assert.ok(m, 'SECURITY-MODEL.md lists the fuzzed parsers as "targets for: ...; no target yet for: ...;"');
  const MAP = {
    'ledger gossip frames': /^gossip-/, 'ledger blocks': /^block-validate$/, JCS: /^jcs-/, 'the pointer': /^pointer-parse$/,
    'pointer TXT records': /^pointer-txt$/, 'magnet links': /^magnet-parse$/, bencode: /^bencode$/, 'torrent files': /^torrent-file$/,
    inflate: /^inflate$/, 'sign-in proofs': /^signin-parse$/, 'the verify package': /^verify-package$/, 'file listings': /^files-validate$/,
    'chat frames': /^chat-frames$/, 'chat points': /^chat-point$/,
  };
  for (const item of m[1].split(', ')) {
    assert.ok(MAP[item], 'add a target pattern for "' + item + '" to this test');
    assert.ok(names.some((n) => MAP[item].test(n)), '"' + item + '" is said to be fuzzed but no target matches ' + MAP[item]);
  }
  assert.match(m[2], /Noise handshake/);
  assert.doesNotMatch(doc('docs/SECURITY-MODEL.md'), /the fuzzers of the parsers of untrusted input/);
});

test('HON-7: the chat card and PRIVACY say chat also rides the ledger connections, while mw_chat1 is registered on them', () => {
  let swarms = null;
  registerChatWire({ registerWireExtension: (name, h, opts) => { swarms = opts.swarms; return () => {}; } }, {});
  assert.ok(Array.isArray(swarms));
  if (!swarms.includes('rendezvous')) return;
  assert.match(CARD_TEXT.en.turnOnChat, /Chat also travels over the connections your browser already has for this site's ledger/);
  assert.match(CARD_TEXT.fr.turnOnChat, /passe aussi par les connexions que votre navigateur a déjà pour le registre de ce site/);
  assert.ok(CARD_TEXT.en.turnOnChat.includes('{tracker} and {stun}.'), 'the card still names the site\'s own tracker and STUN');
  const t = doc('docs/PRIVACY.md');
  assert.doesNotMatch(t, /STUN servers are not used for chat, groups or private media/);
  assert.match(t, /Chat also travels over the connections the browser already has for this site's ledger/);
});

test('HON-8: PRIVACY says a SIG is padded to the smallest bucket that holds it, as the sealed box does', () => {
  assert.equal(chooseBucket(300), BUCKETS[1]);
  assert.notEqual(chooseBucket(300), BUCKETS[BUCKETS.length - 1]);
  const t = doc('docs/PRIVACY.md');
  assert.doesNotMatch(t, /uses the largest size, 16,000 bytes/);
  assert.match(t, /padded only to the smallest of the four sizes \(256, 1,024, 4,096 or 16,000 bytes\)/);
  assert.deepEqual(BUCKETS, [256, 1024, 4096, 16000]);
});

test('HON-9: held envelopes are documented as memory only while the Holder has no storage', () => {
  const holder = read('src/chat/holder.js');
  if (/indexedDB|idb|\.persist\(/i.test(holder)) return;
  assert.match(CARD_TEXT.en.holdMessages, /^While this page is open, and for up to 7 days, .*Nothing is written to disk/);
  assert.match(CARD_TEXT.fr.holdMessages, /^Tant que cette page est ouverte, .*Rien n'est écrit sur le disque/);
  assert.match(doc('docs/PRIVACY.md'), /\| a holder's memory, while the page is open: nothing is written to disk \|/);
});

test('HON-10: the sharing rates in the FAQ are the seeding table\'s, and no document says there is no daily cap', () => {
  const d = CONFIG.seed.rows.desktop;
  const kib = (n) => (n >= 1048576 ? n / 1048576 + ' MiB/s' : n / 1024 + ' KiB/s');
  const faq = doc('docs/FAQ.md');
  assert.ok(faq.includes('up to ' + kib(d.H) + ' on H, ' + kib(d.K) + ' on K and ' + kib(d.E) + ' on E'), 'desktop rates');
  assert.ok(faq.includes('so up to ' + (d.H + d.K + d.E) / 1048576 + ' MiB/s'), 'desktop total');
  assert.ok(faq.includes(d.month.toLocaleString('en-US') + ' bytes on a desktop'), 'desktop month cap');
  assert.ok(faq.includes('at most ' + CONFIG.seed.rows.phoneCharging.month / 1073741824 + ' GiB on a phone'), 'phone month cap');
  assert.ok(faq.includes('up to ' + kib(CONFIG.seed.rows.metered.H) + ' on mobile data'), 'phone upload on mobile data');
  for (const p of ['docs/FAQ.md', 'docs/WHY.md']) {
    assert.doesNotMatch(doc(p), /no cap on bytes per day/i, p);
    assert.doesNotMatch(doc(p), /Uploads are off on every phone until/, p);
  }
});

test('HON-11: the 0.2.1 posting key row of PRIVACY is marked for builds without the identity service', () => {
  const row = read('docs/PRIVACY.md').split('\n').find((l) => l.includes('the posting identity, a key pair for this site'));
  assert.ok(row && row.startsWith('| Builds without the identity service only (0.2.1 mode)'), row);
  assert.doesNotMatch(doc('docs/PRIVACY.md'), /Creating the identity only at the first post is on the/);
});

test('HON-12, HON-14: README and WHY quote the suite results as recorded runs, and README has no "blockchain"', () => {
  assert.doesNotMatch(doc('docs/WHY.md'), /0\.3\.0 passes every automated suite/);
  assert.doesNotMatch(doc('README.md'), /the unit, browser and end-to-end suites pass,/);
  assert.match(doc('README.md'), /passed in the last full runs recorded in \[docs\/INTEGRATION-STATUS\.md\]/);
  assert.doesNotMatch(read('README.md'), /blockchain/i);
});

test('HON-13: SECURITY-MODEL says lane by lane what is re-shared after an open', () => {
  assert.match(read('src/files/lane.js'), /if \(!rec\.keepSharing\) this\._stop\(rec\)/);
  const t = doc('docs/SECURITY-MODEL.md');
  assert.match(t, /a fetched public or private file is never re-seeded unless the visitor clicks "Help share this file"/);
  assert.match(t, /a private photo or video the visitor opened stays in its swarm on the Echo lane/);
  assert.match(doc('docs/PRIVACY.md'), /A private photo or video you opened joins the Echo lane/);
});

test('SCALE-9: the hub pin documents mark member windows (proposed) and state the fixed 2 GiB total', () => {
  const pin = read('tools/pin.mjs');
  const code = pin.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(PIN_LIMITS.maxTotalBytes, 2 * 1024 ** 3);
  const recipe = doc('docs/recipes/hub-pin.md');
  if (!/max-total/.test(pin)) assert.match(recipe, /at most 2 GiB of them in all \(a code constant, `PIN_LIMITS\.maxTotalBytes`, with no flag to change it\)/);
  if (!/\bmembers?\b/i.test(code)) {
    assert.match(recipe, /Keeping recent windows of members' ledgers and writing a snapshot per member is \*\*\(proposed\)\*\*/);
    assert.doesNotMatch(recipe, /it keeps recent copies of members' ledgers/);
    assert.match(doc('docs/FAQ.md'), /\*\*\(proposed\)\*\* Pinning each member's ledger window and media is not built/);
    assert.match(knownGaps(), /it does not follow a hub's members or keep their ledger windows/);
  }
});

test('SCALE-16: WHY.md\'s like count for visitors is the reserved pool of the default ledger', () => {
  const pool = (DEFAULT_POLICY.maxChainBytes * FREEZE_POLICY_DEFAULTS.reservedPool) / 100;
  const lo = Math.round(pool / 1039 / 100) * 100, hi = Math.round(pool / 570 / 100) * 100;
  const t = doc('docs/WHY.md');
  assert.ok(t.includes('about ' + lo.toLocaleString('en-US') + ' to ' + hi.toLocaleString('en-US') + ' likes from visitors'), lo + ' to ' + hi);
  assert.ok(t.includes(pool.toLocaleString('en-US') + ' bytes'), 'the arithmetic names the pool');
});

test('SEC-11, CONF-4, CONF-5: every signing and AAD prefix in the code is listed in ARCHITECTURE.md or R 2.10.3', () => {
  const listed = read('docs/ARCHITECTURE.md') + read('docs/review/V03-DESIGN-REVIEW.md');
  const found = new Set();
  for (const dir of ['src', 'tools', 'packages']) {
    for (const f of sources(dir)) {
      for (const m of f.text.matchAll(/['"`](mw-[a-z0-9-]+-v\d+|mw-pin1-[a-z]+)(?=[\\'"`|\n])/g)) found.add(m[1]);
    }
  }
  assert.ok(found.size > 30, 'found the prefixes (' + found.size + ')');
  const missing = [...found].filter((p) => !listed.includes('`' + p + '`'));
  assert.deepEqual(missing, []);
  for (const sub of ['`mw-dm-v2|<ledger id>|stranger`', '`mw-dm-v2|auth|`', '`mw-dm-v2|<ledger id>|box`']) assert.ok(listed.includes(sub), sub);
});

test('CONF-1, CONF-4: INTERFACES gives the chat panel\'s real attributes and the nonce store\'s real signature', () => {
  const panel = read('src/widget/chat-panel.js');
  const attrs = [...panel.matchAll(/getAttribute\('([a-z-]+)'\)/g)].map((m) => m[1]).filter((a) => a !== 'aria-label');
  assert.deepEqual(attrs, ['lang']);
  const ifc = read('docs/INTERFACES.md');
  assert.doesNotMatch(ifc, /<mw-chat-panel tracker stun>/);
  assert.match(read('packages/verify/verify.js'), /nonces\.consume\(c\.nonce, c\.exp, origin\)/);
  assert.match(ifc, /MemoryNonceStore \{ put\(nonce, expMs, meta\); consume\(nonce, expMs, origin\)/);
});

test('CONF-2: ARCHITECTURE 15.14 gives the calls gating order of the SDK boundary', () => {
  const api = flat(read('src/loader/api.js'));
  assert.ok(api.indexOf('a UI method without activation (E_NEEDS_GESTURE)') < api.indexOf('Services then apply their own rules (E_POLICY'));
  const arch = doc('docs/ARCHITECTURE.md');
  const s = arch.slice(arch.indexOf('### 15.14 Calls'), arch.indexOf('### 15.15'));
  const order = s.slice(s.indexOf('The gating order is'));
  assert.ok(order.indexOf('`E_NEEDS_GESTURE`') < order.indexOf('`E_POLICY`'), 'E_NEEDS_GESTURE comes before E_POLICY');
  assert.doesNotMatch(s, /then `E_POLICY` \(calls off\), `E_NEEDS_GESTURE`/);
});

test('CONF-3: ARCHITECTURE 15.15 asks only byte doors for bytes, as byteDoors does', () => {
  const kinds = ['current', 'last-good', 'owner', 'guest', 'ledger', 'hint'];
  const cands = kinds.map((kind, i) => ({ host: kind + i + '.example', kind }));
  assert.deepEqual(byteDoors(cands, { record: {} }).map((c) => c.kind), ['last-good', 'owner']);
  const arch = doc('docs/ARCHITECTURE.md');
  assert.doesNotMatch(arch, /hints, used last, only for hash-checked bytes/);
  assert.match(arch, /they serve the loader only and are never asked for the site's `\.torrent` or web-seed bytes/);
  assert.match(arch, /up to 3 byte doors join the web seeds/);
});

test('UX-19: QUICKSTART rung 2c names the optional WebRTC binding that seed needs', () => {
  assert.match(read('tools/seed.mjs'), /node-datachannel\/polyfill/);
  const row = read('docs/QUICKSTART.md').split('\n').find((l) => l.startsWith('| 2c '));
  assert.ok(row && row.includes('`npm install node-datachannel`'), row);
});
