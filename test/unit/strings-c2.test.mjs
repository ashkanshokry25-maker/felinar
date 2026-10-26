// Unit tests for the v0.3 C2 strings (research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md "SZ" 3.1.5 and 3.5; lane docs-strings):
// SEED_TEXT and CALL_TEXT carry every key the design and the lane briefs name, in English and French with the same
// placeholders; the English texts of the SZ tables are verbatim; the six call error codes have a sentence in both
// languages; nothing breaks the wording rules (no dash, no curly quote, no banned word, no durability promise, "online"
// only for holders of a file); the texts that name who sees an IP address keep that clause; and the spec files that
// quote the strings (ARCHITECTURE, INTERFACES) and the gate rows (DEMO-RESULTS) stay in step with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as M from '../../src/loader/strings.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const squash = (s) => s.replace(/\s+/g, ' ');
const { SEED_TEXT, CALL_TEXT, ERROR_TEXT, C2_ERROR_CODES, C2_REUSED_CODES, seedText, callText, errorText, fmt } = M;

// The keys SZ 3.1.5 names, then SZ 3.5, then the controls and states the lane wire-ui needs (the docs-strings brief).
// The reasons of src/loader/dock.js (docs/deviations/seed-policy.md): a start that is refused, and a stop.
const DOCK_REFUSED = ['unsupported', 'hidden', 'declare', 'unplugged', 'battery', 'denied'];
const DOCK_STOPPED = ['hidden', 'unplugged', 'battery', 'cap', 'user', 'released'];
const SEED_KEYS = [
  'avail.onlyHere', 'avail.heldBy', 'avail.keptBySite', 'avail.nobody', 'avail.noPin', 'handoff.waiting', 'handoff.sending',
  'seed.monthUsed', 'seed.ask', 'dock.on', 'meter.visit',
  'seed.declareWifi', 'seed.declarePlugged', 'keeper.on', 'keeper.toggle', 'dock.start', 'meter.tracker',
  // beyond the brief, asked for by the seed-policy lane: the button that ends it and one sentence for each reason it did not start or ended
  'dock.stop'
].concat(DOCK_REFUSED.map((r) => 'dock.refused.' + r), DOCK_STOPPED.map((r) => 'dock.stopped.' + r));
const CALL_KEYS = [
  'call.start', 'call.startRelay', 'call.incoming', 'call.group', 'call.metered', 'call.ios', 'call.android', 'call.noPath',
  'call.screen', 'call.notHere', 'call.ended', 'call.declined', 'call.busy',
  'call.accept.audio', 'call.accept.video', 'call.decline', 'call.mute', 'call.unmute', 'call.camera.on', 'call.camera.off',
  'call.screen.start', 'call.screen.stop', 'call.hangup', 'call.state.ringing', 'call.state.connecting', 'call.state.direct',
  'call.state.relayed', 'call.state.reconnecting', 'call.state.left', 'call.paused', 'call.videoPaused', 'call.ringTitle',
  'call.calling'
];
// Keys this lane adds beyond the brief, so the localised word fills {kind} of call.incoming; and (code review v0.3, round 2) the
// sentence phones show while the platform notes wait for their gate rows.
const EXTRA_CALL_KEYS = ['call.kind.audio', 'call.kind.video', 'call.keepOpen'];

// The English of the SZ tables, verbatim (call.incoming without its three bracketed buttons, which are separate keys).
const SZ_TEXT = {
  'avail.onlyHere': 'Only on this device. Keep this page open until it is sent.',
  'avail.heldBy': 'Kept by you and at least {n} others online now (reported)',
  'avail.keptBySite': 'Kept by the site (checked {age} ago)',
  'avail.nobody': 'Nobody who has this is online right now.',
  'avail.noPin': 'No always-on copy exists for this site. This file is available only while someone who has it is online.',
  'handoff.waiting': 'Waiting for the site to accept it.',
  'handoff.sending': 'Sending to the site: {pct}%',
  // Review round R 5.3 (SCALE-12): the month cap is counted per site (per origin), and the texts now say so.
  'seed.monthUsed': "Sharing paused: this site's limit of {cap} for this month is used. Your own uploads still go out.",
  'seed.ask': 'Help keep this available? While this page is open and your phone charges on Wi-Fi, it shares what you keep, up to {cap} a month on this site. Others can see your IP address and which files you share.',
  'dock.on': 'Keeping the screen on and sharing until {time}. Leave the page to stop.',
  'meter.visit': 'This visit: {p}% of the bytes came from {n} visitors, {h}% from the host.',
  'call.start': 'Call {name}? Your browsers connect directly, so {name} will see your IP address. Nobody else is in the media path.',
  'call.startRelay': "If a direct connection fails, the call goes through {operator}'s relay, which sees both IP addresses and how much you send, not what you say.",
  'call.incoming': '{name} is calling ({kind}). Accepting shows your IP address to {name}.',
  'call.group': 'Join a call with {names}? Each of them will see your IP address.',
  'call.metered': 'You are on mobile data, so the call starts with audio only. Video uses about 2 MB a minute.',
  'call.ios': 'On iPhone, video stops when you leave this page, and an app on the Home Screen loses the microphone too. Keep this page open during the call.',
  'call.android': 'Keep this page open during the call. Android may cut the connection when the screen is off.',
  'call.noPath': 'Could not connect to {name} directly. Some networks block direct connections, and this site has no relay.',
  'call.screen': 'Everyone in this call will see the screen or window you pick.',
  'call.notHere': '{name} is not connected now. Calls ring only while {name} has this site open.',
  'call.ended': 'Call ended ({duration}).',
  'call.declined': '{name} declined.',
  'call.busy': '{name} is in another call.',
  // the brief's own texts
  'seed.declareWifi': 'I am on Wi-Fi',
  'seed.declarePlugged': 'My phone is plugged in',
  'keeper.on': 'Keeping this site while this tab is open.',
  'keeper.toggle': 'Keep this site',
  'dock.start': 'Keep this screen on and share for 2 hours',
  'meter.tracker': '{n} connected to this site (tracker report, {time})',
  'call.state.relayed': 'Relayed by {operator}',
  'call.paused': 'Your camera is paused by the browser',
  'call.videoPaused': 'Video paused: the connection is too slow',
  'call.ringTitle': 'Incoming call',
  'call.calling': 'Calling {name}...'
};

const BANNED = [/blockchain/i, /serverless/i, /unstoppable/i, /censorship[- ]resistant/i, /production[- ]ready/i, /fully decentralized/i, /sub-second/i, /\bforever\b/i, /\bmirror/i];
const NO_DASH = /[–—‘’“”]/;
const ph = (s) => (s.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');
const PARAMS = { n: 3, age: '4 min', pct: 62, cap: '1 GiB', time: '14:30', p: 12, h: 88, name: 'Bo', names: 'Bo, Cy', operator: 'example.org', kind: 'video', duration: '2:35' };
const PLACEHOLDERS = new Set(Object.keys(PARAMS).map((k) => '{' + k + '}'));

const everyText = () => {
  const out = [];
  for (const [name, table] of Object.entries({ SEED_TEXT, CALL_TEXT })) {
    for (const lang of ['en', 'fr']) for (const [key, text] of Object.entries(table[lang])) out.push({ name, lang, key, text });
  }
  for (const lang of ['en', 'fr']) for (const code of C2_ERROR_CODES) out.push({ name: 'ERROR_TEXT', lang, key: code, text: ERROR_TEXT[lang][code] });
  return out;
};

test('every key the design and the brief name exists in SEED_TEXT and CALL_TEXT, in English and French, and nothing else', () => {
  for (const lang of ['en', 'fr']) {
    assert.deepEqual(Object.keys(SEED_TEXT[lang]).sort(), SEED_KEYS.slice().sort(), 'SEED_TEXT.' + lang);
    assert.deepEqual(Object.keys(CALL_TEXT[lang]).sort(), CALL_KEYS.concat(EXTRA_CALL_KEYS).sort(), 'CALL_TEXT.' + lang);
    for (const table of [SEED_TEXT[lang], CALL_TEXT[lang]]) {
      for (const [key, text] of Object.entries(table)) assert.ok(typeof text === 'string' && text.length > 3, lang + ' ' + key);
    }
  }
  assert.ok(Object.isFrozen(SEED_TEXT) && Object.isFrozen(SEED_TEXT.en) && Object.isFrozen(CALL_TEXT.fr));
});

test('the English texts of SZ 3.1.5 and 3.5 are verbatim, and call.incoming keeps its three buttons as keys of their own', () => {
  for (const [key, text] of Object.entries(SZ_TEXT)) {
    const table = key.startsWith('call.') ? CALL_TEXT : SEED_TEXT;
    assert.equal(table.en[key], text, key);
  }
  assert.equal(CALL_TEXT.en['call.accept.audio'], 'Accept with audio');
  assert.equal(CALL_TEXT.en['call.accept.video'], 'Accept with video');
  assert.equal(CALL_TEXT.en['call.decline'], 'Decline');
  assert.equal(CALL_TEXT.en['call.kind.audio'], 'audio');
  assert.equal(CALL_TEXT.en['call.kind.video'], 'video');
});

test('French is a translation: the same placeholders as English in every entry, and a different text (a few words are the same word)', () => {
  const sameWord = new Set(['call.state.direct', 'call.kind.audio']);
  for (const table of [SEED_TEXT, CALL_TEXT]) {
    for (const key of Object.keys(table.en)) {
      assert.equal(ph(table.fr[key]), ph(table.en[key]), key + ' placeholders');
      for (const placeholder of ph(table.en[key]).split(',').filter(Boolean)) assert.ok(PLACEHOLDERS.has(placeholder), key + ' uses the unknown placeholder ' + placeholder);
      if (!sameWord.has(key)) assert.notEqual(table.fr[key], table.en[key], key + ' French differs');
    }
  }
});

test('every entry fills completely from the parameters the callers pass, and fmt leaves a missing placeholder as written', () => {
  for (const t of everyText()) {
    if (t.name === 'ERROR_TEXT') continue;
    const table = t.name === 'SEED_TEXT' ? SEED_TEXT : CALL_TEXT;
    const out = fmt(table[t.lang][t.key], PARAMS);
    assert.ok(!out.includes('{'), t.name + '.' + t.lang + '.' + t.key + ' left a placeholder: ' + out);
  }
  assert.equal(seedText('avail.heldBy', 'en', { n: 3 }), 'Kept by you and at least 3 others online now (reported)');
  assert.equal(seedText('avail.heldBy', 'en'), 'Kept by you and at least {n} others online now (reported)');
  assert.equal(seedText('handoff.sending', 'en', { pct: 62 }), 'Sending to the site: 62%');
  assert.equal(callText('call.calling', 'en', { name: 'Bo' }), 'Calling Bo...');
  assert.equal(callText('call.state.relayed', 'en', { operator: 'example.org' }), 'Relayed by example.org');
  assert.ok(callText('call.incoming', 'fr', { name: 'Bo', kind: callText('call.kind.video', 'fr') }).includes('Bo'));
  assert.ok(seedText('meter.visit', 'fr', { p: 12, n: 3, h: 88 }).includes('12'));
});

test('lookups fall back to English for a language that is not there, and give an empty string for an unknown key', () => {
  assert.equal(seedText('dock.start', 'de'), SEED_TEXT.en['dock.start']);
  assert.equal(callText('call.hangup', undefined), 'Hang up');
  assert.equal(seedText('no.such.key', 'en'), '');
  assert.equal(callText('no.such.key', 'fr'), '');
  assert.equal(seedText('constructor', 'en'), '', 'an inherited property is not a key');
  assert.equal(callText('toString', 'en'), '');
  assert.equal(callText('__proto__', 'en'), '');
});

test('every reason keeping the screen on can be refused or can end has a sentence in both languages, in the words of dock.on', () => {
  for (const lang of ['en', 'fr']) {
    for (const reason of DOCK_REFUSED) assert.ok(SEED_TEXT[lang]['dock.refused.' + reason], lang + ' refused ' + reason);
    for (const reason of DOCK_STOPPED) assert.ok(SEED_TEXT[lang]['dock.stopped.' + reason], lang + ' stopped ' + reason);
  }
  // the person reads "screen", never an internal name: dock.start and dock.on never say "dock mode"
  for (const key of Object.keys(SEED_TEXT.en).filter((k) => k.startsWith('dock.'))) assert.ok(!/dock/i.test(SEED_TEXT.en[key]), key + ' names a feature the card never introduces');
  assert.equal(seedText('dock.refused.unplugged', 'en'), 'Could not keep the screen on: the phone is not plugged in.');
  assert.equal(seedText('dock.stopped.cap', 'en'), 'Stopped keeping the screen on: the time limit was reached.');
});

test('the texts that tell the person who will see an IP address say so in both languages', () => {
  for (const key of ['call.start', 'call.incoming', 'call.group']) {
    assert.match(CALL_TEXT.en[key], /IP address/, key);
    assert.match(CALL_TEXT.fr[key], /adresse IP/, key);
  }
  assert.match(SEED_TEXT.en['seed.ask'], /Others can see your IP address and which files you share\./);
  assert.match(SEED_TEXT.fr['seed.ask'], /adresse IP/);
  assert.match(SEED_TEXT.fr['seed.ask'], /fichiers que vous partagez/);
  assert.match(CALL_TEXT.en['call.startRelay'], /both IP addresses/);
  assert.match(CALL_TEXT.fr['call.startRelay'], /deux adresses IP/);
  assert.match(CALL_TEXT.en['call.screen'], /Everyone in this call will see/);
});

test('the availability labels never promise durability and only a pin or a probe may say "Kept by the site"', () => {
  for (const lang of ['en', 'fr']) {
    for (const key of ['avail.onlyHere', 'avail.heldBy', 'avail.keptBySite', 'avail.nobody', 'avail.noPin']) {
      assert.ok(!/forever|toujours pour|pour toujours|garanti|guarantee/i.test(SEED_TEXT[lang][key]), lang + ' ' + key);
    }
  }
  assert.match(SEED_TEXT.en['avail.heldBy'], /\(reported\)$/, 'a bitfield count says it is reported');
  assert.match(SEED_TEXT.en['avail.heldBy'], /at least \{n\}/, 'a count reads "at least"');
  assert.match(SEED_TEXT.en['avail.keptBySite'], /\{age\}/, 'the label carries its age');
  assert.match(SEED_TEXT.en['meter.tracker'], /tracker report/, 'a tracker count is labelled as a report');
  assert.match(SEED_TEXT.en['avail.noPin'], /only while someone who has it is online/);
});

test('no banned word, no dash, no curly quote, no "forever" or "mirror", in any C2 text or in the six call errors', () => {
  const texts = everyText();
  assert.ok(texts.length > 100);
  for (const t of texts) {
    const where = t.name + '.' + t.lang + '.' + t.key;
    for (const re of BANNED) assert.ok(!re.test(t.text), where + ' has ' + re);
    assert.ok(!NO_DASH.test(t.text), where + ' has a dash or a curly quote');
    assert.ok(!/\berase|delete everywhere|supprimer partout|effacer/i.test(t.text), where + ' erase wording');
    assert.equal(t.text, t.text.trim(), where + ' has outer whitespace');
  }
});

test('"online" and "en ligne" only say whether someone who holds a file is reachable; a call says "connected"', () => {
  const holders = new Set(['avail.heldBy', 'avail.nobody', 'avail.noPin']);
  for (const [key, text] of Object.entries(SEED_TEXT.en)) assert.equal(/\bonline\b/i.test(text), holders.has(key), 'en ' + key);
  for (const [key, text] of Object.entries(SEED_TEXT.fr)) assert.equal(/\ben ligne\b/i.test(text), holders.has(key), 'fr ' + key);
  for (const lang of ['en', 'fr']) for (const [key, text] of Object.entries(CALL_TEXT[lang])) assert.ok(!/\bonline\b|\ben ligne\b/i.test(text), lang + ' ' + key);
  assert.match(CALL_TEXT.en['call.notHere'], /is not connected now/);
});

test('SZ 3.5 errors: the six new codes have a sentence in both languages that needs no parameter, and the reused codes already have one', () => {
  assert.deepEqual(Array.from(C2_ERROR_CODES), ['E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED']);
  assert.deepEqual(Array.from(C2_REUSED_CODES), ['E_NOT_SIGNED_IN', 'E_HOST_ONLY', 'E_POLICY', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE', 'E_LIMIT', 'E_UNSUPPORTED']);
  assert.ok(Object.isFrozen(C2_ERROR_CODES) && Object.isFrozen(C2_REUSED_CODES));
  for (const code of C2_ERROR_CODES.concat(C2_REUSED_CODES)) {
    for (const lang of ['en', 'fr']) {
      const text = ERROR_TEXT[lang][code];
      assert.ok(typeof text === 'string' && text.length > 8, code + ' ' + lang);
      assert.ok(!errorText(code, lang, { name: 'Bo' }).includes('{'), code + ' ' + lang + ' placeholders filled');
    }
    assert.notEqual(ERROR_TEXT.en[code], ERROR_TEXT.fr[code], code + ' French differs');
  }
  for (const code of C2_ERROR_CODES) assert.ok(!/\{/.test(ERROR_TEXT.en[code] + ERROR_TEXT.fr[code]), code + ' needs no parameter');
  assert.deepEqual(Object.keys(ERROR_TEXT.en).sort(), Object.keys(ERROR_TEXT.fr).sort());
  assert.equal(errorText('E_DECLINED', 'en'), 'The call was declined.');
  assert.equal(errorText('E_NO_DEVICE', 'en'), 'No microphone or camera was found on this device.');
  assert.match(errorText('E_MEDIA_DENIED', 'fr'), /microphone/);
});

test('the specification quotes the strings it owns: ARCHITECTURE 8.1 and 15.14 carry the SZ texts, INTERFACES names every key', () => {
  const architecture = squash(read('docs/ARCHITECTURE.md'));
  const interfaces = read('docs/INTERFACES.md');
  // the integrator drops "proposed" from a heading when its lane is green, so the headings are matched without it
  assert.ok(/### 8\.1 Smart seeding \(v0\.3 C2/.test(architecture), 'ARCHITECTURE.md has no section 8.1');
  assert.ok(/### 15\.14 Calls \(v0\.3 C2/.test(architecture), 'ARCHITECTURE.md has no section 15.14');
  const quoted = Object.keys(SZ_TEXT).filter((k) => !['seed.declareWifi', 'seed.declarePlugged', 'keeper.on', 'keeper.toggle', 'dock.start', 'meter.tracker', 'call.state.relayed', 'call.paused', 'call.videoPaused', 'call.ringTitle', 'call.calling'].includes(k));
  for (const key of quoted) {
    const table = key.startsWith('call.') ? CALL_TEXT : SEED_TEXT;
    assert.ok(architecture.includes(squash(table.en[key])), 'ARCHITECTURE.md does not quote ' + key);
  }
  // INTERFACES writes the dock reasons as dock.refused.<a|b|c> and dock.stopped.<a|b|c>: accept that form for them
  const names = (key) => {
    const m = /^(dock\.(?:refused|stopped))\.(.+)$/.exec(key);
    return interfaces.includes(key) || Boolean(m && interfaces.includes(m[1] + '.<') && new RegExp('\\b' + m[1].replace('.', '\\.') + '\\.<[^>]*\\b' + m[2] + '\\b[^>]*>').test(interfaces));
  };
  for (const key of SEED_KEYS.concat(CALL_KEYS, EXTRA_CALL_KEYS)) assert.ok(names(key), 'INTERFACES.md does not name ' + key);
  for (const code of C2_ERROR_CODES) assert.ok(interfaces.includes(code) && architecture.includes(code), code + ' is not in both specification files');
});

test('PRIVACY quotes the card sentences of the C2 features exactly as the loader shows them', () => {
  const privacy = squash(read('docs/PRIVACY.md'));
  assert.ok(/### v0\.3 C2[^\n]*seeding, the pin node, dock mode and calls/.test(privacy), 'PRIVACY.md has no C2 section');
  const quoted = {
    seed: ['seed.ask', 'avail.onlyHere', 'avail.heldBy', 'meter.tracker'],
    call: ['call.start', 'call.startRelay', 'call.incoming', 'call.group', 'call.screen']
  };
  for (const key of quoted.seed) assert.ok(privacy.includes(squash(SEED_TEXT.en[key])), 'PRIVACY.md does not quote ' + key);
  for (const key of quoted.call) assert.ok(privacy.includes(squash(CALL_TEXT.en[key])), 'PRIVACY.md does not quote ' + key);
});

test('DEMO-RESULTS lists every C2 gate row: G-PS-1 to 14, G-ZS1 to 4, G-CL-1 to 9, and a row has a result only with a date', () => {
  const demo = read('docs/DEMO-RESULTS.md');
  const rows = [];
  for (let i = 1; i <= 14; i++) rows.push('G-PS-' + i);
  for (let i = 1; i <= 4; i++) rows.push('G-ZS' + i);
  for (let i = 1; i <= 9; i++) rows.push('G-CL-' + i);
  for (const id of rows) {
    const line = demo.split('\n').find((l) => l.startsWith('| ' + id + ' |'));
    assert.ok(line, id + ' has no row');
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 8, id + ' has the 8 columns of the table');
    // Result is column 4 and Date column 5: "not yet run" until a person ran it on a real device, and then pass, fail or partial with the day
    assert.ok(['not yet run', 'pass', 'fail', 'partial'].includes(cells[3]), id + ' has the result "' + cells[3] + '"');
    if (cells[3] !== 'not yet run') assert.match(cells[4], /^\d{4}-\d{2}-\d{2}$/, id + ' has a result and no date');
  }
  assert.ok(/## v0\.3 C2/.test(demo), 'DEMO-RESULTS.md has no C2 section');
});
