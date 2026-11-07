// The documents of the relay-first change (docs/APPS.md "Messages through the rendezvous", INTERFACES.md "The relay lane", ARCHITECTURE.md 15.21,
// DEPLOY.md "Apps at a door", PRIVACY.md "Apps on the door page", OBSERVABILITY.md and CHANGELOG.md) say things the code makes true or false: the
// names of the actions and pushes, the failure texts, the caps, the counters, the two door.json keys and their reasons, the flags of the tools, the
// sentences of the price card and the status line. Each test reads a document and the code it describes, so that the claim and the code cannot drift
// apart (the same idea as docs-observability.test.mjs, which holds the event tables to the calls). The last tests scan the passages written for this
// change for the words and dashes the wording rules forbid (CONTRIBUTING.md; the claims table of the research synthesis).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT } from '../../tools/lib.mjs';
import { APPS_TEXT } from '../../src/loader/strings.js';
import { checkAppsBlock } from '../../src/loader/doors.js';
import { APPS_RELAY_TOKENS, APPS_DIRECT_TOKENS } from '../../tools/apps-block.mjs';
import * as PAIR from '../../deploy/rtc-worker/pair.js';
import * as LINK from '../../src/loader/apps-link.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const flat = (t) => t.replace(/\s+/g, ' ');

/** between(text, from, to) -> the text from the line that starts with `from` up to (not including) the next line that starts with `to`. */
function between(text, from, to) {
  const a = text.indexOf(from);
  assert.ok(a >= 0, 'the document has no passage that starts with ' + JSON.stringify(from));
  const b = text.indexOf(to, a + from.length);
  assert.ok(b > a, 'the passage that starts with ' + JSON.stringify(from) + ' has no end ' + JSON.stringify(to));
  return text.slice(a, b);
}

const INTERFACES = read('docs/INTERFACES.md');
const RELAY_LANE = between(INTERFACES, '### The relay lane', '### The sealing and the frames');
const APPS = read('docs/APPS.md');
const APPS_RELAY_SECTION = between(APPS, '## Messages through the rendezvous', '## Limits');
const ARCH = read('docs/ARCHITECTURE.md');
const ARCH_RELAY = between(ARCH, '- **The relay lane** (relay-first', '- **Before and after approval.**');
const DEPLOY = read('docs/DEPLOY.md');
const DEPLOY_KEYS = between(DEPLOY, '- **`relay`** (optional)', '**Publishing.**');
const PRIVACY = read('docs/PRIVACY.md');
const PRIVACY_APPS = between(PRIVACY, '### Apps on the door page (unreleased)', '### Usage reports (unreleased)');
const CHANGELOG = read('CHANGELOG.md');
const UNRELEASED = between(CHANGELOG, '## [Unreleased]', '\n## [0.3.0]');

// ---------------------------------------------------------------------------------------------------------------------
// The protocol: INTERFACES.md "The relay lane" against deploy/rtc-worker/pair.js

const RELAY_FAILURES = ['invalid lane', 'unknown lane', 'lane full', 'too many lanes', 'invalid frame', 'too many relays', 'relay is busy', 'relay is off on this rendezvous', 'too many messages'];
const RELAY_ACTIONS = ['pair-join', 'pair-relay', 'pair-leave', 'pair-ping', 'pair-joined', 'pair-relayed', 'pair-left', 'pair-pong'];

test('INTERFACES "The relay lane" names every action, push and failure text of the relay, and the code has each of them', () => {
  const code = read('deploy/rtc-worker/pair.js');
  for (const name of RELAY_ACTIONS) {
    assert.ok(RELAY_LANE.includes(name), 'INTERFACES does not name ' + name);
    assert.ok(ARCH_RELAY.includes(name) || ['pair-pong', 'pair-left', 'pair-joined'].includes(name), 'ARCHITECTURE 15.21 does not name ' + name);
  }
  // the code builds the room forms and the pushes from the kind ('<kind>' + '-joined'), so it is the suffixes that are looked for; the ping and the pong are written out
  for (const suffix of ['-joined', '-relayed', '-left']) assert.ok(code.includes("'" + suffix + "'"), 'pair.js builds the push <kind>' + suffix);
  assert.ok(code.includes('pair-ping') && code.includes('pair-pong'), 'pair.js has the ping and the pong');
  for (const text of RELAY_FAILURES) {
    assert.ok(RELAY_LANE.includes(text), 'INTERFACES does not say ' + JSON.stringify(text));
    assert.ok(code.includes("'" + text + "'"), 'pair.js never answers ' + JSON.stringify(text));
  }
  // the room forms are named, and the code treats exactly these as actions of the relay
  assert.match(RELAY_LANE, /room-/);
  assert.ok(typeof PAIR.isRelayAction === 'function', 'pair.js exports isRelayAction');
  for (const a of ['pair-join', 'pair-relay', 'pair-leave', 'pair-ping', 'room-join', 'room-relay', 'room-leave']) assert.equal(PAIR.isRelayAction(a), true, a);
  for (const a of ['pair-open', 'pair-knock', 'pair-accept', 'room-open', 'pair-joined', 'pair-relayed', 'pair-left', 'pair-pong', 'announce']) assert.equal(PAIR.isRelayAction(a), false, a);
});

test('the numbers INTERFACES, APPS and ARCHITECTURE state for the relay are the caps of pair.js', () => {
  const caps = PAIR.DEFAULT_CAPS;
  const n = (v) => v.toLocaleString('en-US');
  assert.deepEqual([caps.relayPerMin, caps.messagesPerMin, caps.relayDayMax, caps.lanesPerSocket, caps.pairLaneMembers, caps.roomLaneMembers], [120, 150, 20000, 8, 2, 16], 'DEFAULT_CAPS');
  assert.equal(PAIR.MAX_FRAME_CHARS, 7700);
  const capsLine = RELAY_LANE.slice(RELAY_LANE.indexOf('Caps  '), RELAY_LANE.indexOf('Stats '));
  assert.ok(capsLine.includes(n(caps.relayPerMin) + ' relayed frames a minute'), capsLine);
  assert.ok(capsLine.includes(n(caps.messagesPerMin) + ' messages of any kind a minute'), capsLine);
  assert.ok(capsLine.includes(n(caps.relayDayMax) + ' relayed frames per object'), capsLine);
  assert.ok(capsLine.includes(caps.lanesPerSocket + ' lanes per socket'), capsLine);
  assert.ok(capsLine.includes(caps.pairLaneMembers + ' sockets in a pair lane, ' + caps.roomLaneMembers + ' in a room lane'), capsLine);
  assert.ok(RELAY_LANE.includes('{4,' + PAIR.MAX_FRAME_CHARS + '}'), 'the frame regular expression');
  const apps = flat(APPS_RELAY_SECTION);
  for (const cell of [n(caps.relayPerMin) + ' a minute', n(caps.messagesPerMin) + ' a minute', n(caps.relayDayMax) + ' a UTC day', String(caps.lanesPerSocket), '2 for a conversation, 16 for a room', n(PAIR.MAX_FRAME_CHARS) + ' characters']) {
    assert.ok(apps.includes(cell), 'APPS "Messages through the rendezvous" does not say ' + JSON.stringify(cell));
  }
  const arch = flat(ARCH_RELAY);
  for (const cell of [n(caps.relayPerMin) + ' relayed frames', n(caps.messagesPerMin) + ' messages of any kind', n(caps.relayDayMax) + ' relayed frames a UTC day', n(PAIR.MAX_FRAME_CHARS) + ' characters']) {
    assert.ok(arch.includes(cell), 'ARCHITECTURE 15.21 does not say ' + JSON.stringify(cell));
  }
  assert.ok(flat(APPS).includes('120 a minute and 150 messages of any kind a minute from one socket; 20,000 a UTC day'), 'the Limits table of APPS');
  // the keepalive and the ping text
  assert.equal(PAIR.PING_TEXT, '{"v":1,"action":"pair-ping"}');
  assert.ok(RELAY_LANE.includes(PAIR.PING_TEXT) && ARCH_RELAY.includes(PAIR.PING_TEXT), 'the exact ping text is in both documents');
  assert.ok(RELAY_LANE.includes('50,000 ms') && ARCH_RELAY.includes('50 seconds') && APPS_RELAY_SECTION.includes('50 seconds'));
});

test('every counter pair.js reports for the relay is named in INTERFACES, counts only', () => {
  const stats = PAIR.createPairing({ random: (len) => new Uint8Array(len), now: () => Date.UTC(2026, 10, 7, 12, 0, 0) }).stats();
  const relayFields = Object.keys(stats).filter((k) => !['codes', 'knocks'].includes(k));
  assert.deepEqual(relayFields.sort(), ['joinsRefused', 'relayBusy', 'relayBytes', 'relayDay', 'relayRate', 'relayed', 'relays']);
  const line = RELAY_LANE.slice(RELAY_LANE.indexOf('Stats '), RELAY_LANE.indexOf('Hibernation'));
  for (const k of relayFields) assert.ok(line.includes(k), 'INTERFACES does not name the counter ' + k);
  assert.match(line, /Counts only: no lane id, no frame, no address/);
  for (const v of Object.values(stats)) assert.equal(typeof v, 'number', 'a counter is a number');
});

test('INTERFACES names what pair.js exports for the relay, and the host options of the relay', () => {
  for (const name of ['PING_TEXT', 'PONG_TEXT', 'MAX_FRAME_CHARS', 'isRelayAction', 'utcDay']) {
    assert.ok(name in PAIR, 'pair.js exports ' + name);
    assert.ok(RELAY_LANE.includes(name), 'INTERFACES does not name ' + name);
  }
  for (const name of ['relayPerMin', 'messagesPerMin', 'relayDayMax', 'lanesPerSocket', 'pairLaneMembers', 'roomLaneMembers']) {
    assert.ok(name in PAIR.DEFAULT_CAPS, 'DEFAULT_CAPS has ' + name);
    assert.ok(RELAY_LANE.includes(name), 'INTERFACES does not name the cap ' + name);
  }
  for (const word of ['laneExpiry', 'RELAY_LANE', '--no-relay-lane', 'relayLane']) assert.ok(INTERFACES.includes(word), 'INTERFACES does not name ' + word);
  const tracker = read('tools/tracker.mjs');
  assert.ok(tracker.includes('no-relay-lane') && tracker.includes('relayLane'), 'tools/tracker.mjs has the flag and the option');
  assert.ok(read('deploy/rtc-worker/worker.js').includes('RELAY_LANE'), 'worker.js reads RELAY_LANE');
  assert.match(read('deploy/rtc-worker/wrangler.jsonc'), /"RELAY_LANE"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The link: INTERFACES against src/loader/apps-link.js

test('INTERFACES names the link methods, events and report reasons of the relay, and the link has them', () => {
  const methods = ['join', 'relay', 'leave'];
  for (const m of methods) assert.equal(typeof LINK.PairLink.prototype[m], 'function', 'PairLink.' + m);
  for (const m of methods) assert.ok(INTERFACES.includes(m + '(lane, kind'), 'INTERFACES does not show ' + m + '(lane, kind');
  for (const ev of ['relayed', 'joined', 'left']) assert.ok(INTERFACES.includes(ev + ' ({ lane, kind'), 'INTERFACES does not show the event ' + ev);
  const reasons = ['invalid-lane', 'unknown-lane', 'lane-full', 'too-many-lanes', 'relay-is-off-on-this-rendezvous', 'invalid-frame', 'too-many-relays', 'relay-is-busy', 'too-many-messages'];
  const observability = read('docs/OBSERVABILITY.md');
  for (const r of reasons) {
    assert.equal(LINK.reasonWord(r), r, 'the link reports the reason ' + r + ' as itself');
    assert.ok(INTERFACES.includes(r), 'INTERFACES does not name the reason ' + r);
    assert.ok(observability.includes('`' + r + '`'), 'OBSERVABILITY does not name the reason ' + r);
  }
  assert.equal(LINK.reasonWord('some text a rendezvous chose'), 'other');
  assert.ok(INTERFACES.includes('{"v":1,"action":"pair-ping"}') && INTERFACES.includes('keepaliveMs'));
});

// ---------------------------------------------------------------------------------------------------------------------
// The door.json keys: doors.js, tools/apps-block.mjs, the flags and the documents

test('the two door.json keys: the words, the reasons and the flags are the ones the documents give', () => {
  assert.deepEqual(APPS_RELAY_TOKENS, ['rendezvous', 'none']);
  assert.deepEqual(APPS_DIRECT_TOKENS, ['off', 'on']);
  const apps = { rendezvous: ['wss://rendezvous.example.test'], stun: [], idp: 'https://id.example.test' };
  const reasons = [checkAppsBlock(Object.assign({ relay: 'x' }, apps)).reason, checkAppsBlock(Object.assign({ direct: 'x' }, apps)).reason, checkAppsBlock(Object.assign({ relay: 'none', direct: 'off' }, apps)).reason];
  assert.deepEqual(reasons, ['apps-relay', 'apps-direct', 'apps-transport']);
  for (const r of reasons) assert.ok(INTERFACES.includes(r) && ARCH.includes(r), 'INTERFACES and ARCHITECTURE name ' + r);
  for (const word of ['"rendezvous"', '"none"', '"off"', '"on"']) assert.ok(DEPLOY_KEYS.includes(word), 'DEPLOY names ' + word);
  for (const flag of ['--apps-relay', '--apps-direct']) {
    assert.ok(DEPLOY.includes(flag) && INTERFACES.includes(flag) && APPS.includes(flag) && CHANGELOG.includes(flag), flag + ' is named in DEPLOY, INTERFACES, APPS and CHANGELOG');
    for (const tool of ['publish', 'dev-server', 'demo']) {
      const help = spawnSync(process.execPath, [join(ROOT, 'tools', tool + '.mjs'), '--help'], { encoding: 'utf8' });
      assert.equal(help.status, 0, tool + ': ' + help.stderr);
      assert.ok(help.stdout.includes(flag), tool + ' --help lists ' + flag);
    }
  }
  // the default and the rollback are said the way the code resolves them
  assert.match(flat(DEPLOY_KEYS), /`relay` `"none"` with no `direct` key means `direct` `"on"`/);
  assert.match(flat(DEPLOY_KEYS), /A block without the keys is `relay` `"rendezvous"` with `direct` `"off"`/);
  assert.match(flat(APPS_RELAY_SECTION), /`relay` `"none"` with no `direct` key means direct `"on"`/);
});

// ---------------------------------------------------------------------------------------------------------------------
// What a visitor is told: the sentences of the card and the status line are quoted as the strings hold them

test('APPS.md quotes the relay-first price card, its extra line and the status line word for word', () => {
  const apps = flat(APPS);
  assert.ok(apps.includes(flat(APPS_TEXT.en['apps.price.text'])), 'APPS.md does not quote apps.price.text as the code holds it');
  assert.ok(apps.includes(flat(APPS_TEXT.en['apps.price.direct'])), 'APPS.md does not quote apps.price.direct as the code holds it');
  assert.ok(apps.includes('"' + APPS_TEXT.en['apps.status.relayed'] + '"'), 'APPS.md does not quote apps.status.relayed');
  assert.ok(apps.includes('"' + APPS_TEXT.en['apps.status.connected'] + '"'), 'APPS.md still quotes apps.status.connected');
  // the sentence of before is gone from the page that describes what the card says (it stays in the strings for relay "none")
  assert.ok(!apps.includes(flat(APPS_TEXT.en['apps.price.textDirect'])), 'APPS.md still quotes the card of before as the card');
  // the tools line, as the view draws it
  assert.ok(apps.includes('Connection: through the rendezvous. This door: relay: rendezvous, direct: off.'));
  assert.equal(APPS_TEXT.en['apps.tool.transport'].replace('{via}', APPS_TEXT.en['apps.via.relay']).replace('{relay}', 'rendezvous').replace('{direct}', 'off'),
    'Connection: through the rendezvous. This door: relay: rendezvous, direct: off.');
});

test('the documents no longer say what the relay made false', () => {
  assert.doesNotMatch(flat(APPS), /There is no relay: when two browsers cannot reach each other directly/);
  assert.doesNotMatch(flat(APPS), /An "always relay" choice\./);
  assert.doesNotMatch(flat(ARCH), /an "always relay"\s+choice through the site's TURN server \(the block names STUN only, so two browsers that cannot connect directly do not connect\)/);
  assert.doesNotMatch(flat(APPS), /After the accept both browsers join a private lane and connect directly\./);
  assert.doesNotMatch(flat(ARCH), /After the accept both pages join the lane with\s+`joinLane/);
  assert.doesNotMatch(flat(PRIVACY_APPS), /the browsers connect to each other, and each learns the other's network address \(in a room,\s+every member can connect to every other member\); the rendezvous then carries/);
  // what replaced it
  assert.match(flat(ARCH), /\*\*Relay-first \(unreleased\)\.\*\*/);
  assert.match(flat(APPS), /\*\*Messages now pass through the rendezvous \(relay-first, unreleased\)\.\*\*/);
  assert.ok(flat(APPS).includes('No conversation has gone through the rendezvous on a real network'), 'APPS "Not yet run" says the relay has not run on a real network');
});

// ---------------------------------------------------------------------------------------------------------------------
// OBSERVABILITY.md: the rows the relay adds (the full table is held to the calls by docs-observability.test.mjs)

test('OBSERVABILITY.md has the rows of plan 3.6: apps.lane, and via on apps.conv and apps.wire; no lane id in any field', () => {
  const doc = read('docs/OBSERVABILITY.md');
  const row = (name) => {
    const line = doc.split('\n').find((l) => l.startsWith('| `' + name + '` |'));
    assert.ok(line, 'no row for ' + name);
    return { fields: Array.from(line.split('|')[2].matchAll(/`([A-Za-z0-9_]+)`/g), (m) => m[1]), text: line };
  };
  assert.deepEqual(row('apps.lane').fields, ['ev', 'peers']);
  assert.deepEqual(row('apps.wire').fields, ['conv', 'ev', 'kind', 'via', 'reason']);
  assert.deepEqual(row('apps.conv').fields, ['id', 'status', 'reason', 'incoming', 'via']);
  for (const ev of ['join', 'joined', 'left', 'full', 'busy', 'off', 'invalid', 'unknown', 'rate', 'dead', 'direct-unavailable']) assert.ok(row('apps.lane').text.includes('`' + ev + '`'), 'apps.lane names ' + ev);
  assert.match(row('apps.lane').text, /The lane's id is never in it/);
  for (const name of ['apps.lane', 'apps.wire', 'apps.conv']) for (const field of row(name).fields) assert.ok(!/^(lane|f|frame|text|box|knock)$/.test(field), name + ' has a field named ' + field);
  assert.match(doc, /pair-relayed.*\(one for each frame that arrives, with no content\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// CHANGELOG.md

test('CHANGELOG.md [Unreleased] records the relay, the two keys, the view and the change of default', () => {
  const flatUnreleased = flat(UNRELEASED);
  for (const needle of ['Messages through the rendezvous (relay-first', '`pair-join`', '`pair-relay`', 'RELAY_LANE', '--no-relay-lane', '`relays`', '`joinsRefused`',
    'gains two optional keys, `relay`', '`apps-relay`', '`apps-transport`', '--apps-relay rendezvous|none', 'appsTransportOf', 'Connected through the rendezvous', '`apps.lane`',
    'which is every block published before this change', '"relay": "none"', 'apps.price.textDirect']) {
    assert.ok(flatUnreleased.includes(needle), 'the CHANGELOG does not say ' + JSON.stringify(needle));
  }
  assert.ok(flatUnreleased.includes('not yet run on a real network'), 'the entry says the relay has not run on a real network');
});

// ---------------------------------------------------------------------------------------------------------------------
// The wording scan over the passages written for this change

// The words and claims the plan's section 2 and the claims table of the synthesis forbid. "Works on office Wi-Fi and mobile data" is allowed only after
// the live test R1, so no passage may say that it works there as a fact ("does not say that it works there" is the form the passages use).
const FORBIDDEN = [
  /\banonym/i, /untraceab/i, /serverless/i, /decentrali[sz]ed/i, /unstoppable/i, /censorship/i, /production-ready/i, /sub-second/i, /blockchain/i,
  /\bno logs\b/i, /\bpermanent/i, /\beverywhere\b/i, /peer-to-peer/i, /\bonline\b/i,
  /\bworks? (on|in|over|behind|through|with|at) (an |the |a )?(office|mobile|Tor|VPN|cellular|5G)/i,
];
// an en dash, an em dash, a horizontal bar and the curly quotes (a hyphen-like sign such as a minus or a non-breaking hyphen is not one); built from code points so that this file holds none of them
const DASH = new RegExp('[' + [0x2013, 0x2014, 0x2015, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c)).join('') + ']');

const PASSAGES = {
  'APPS.md "Messages through the rendezvous"': APPS_RELAY_SECTION,
  'INTERFACES.md "The relay lane"': RELAY_LANE,
  'ARCHITECTURE.md 15.21 "The relay lane"': ARCH_RELAY,
  'DEPLOY.md "relay" and "direct"': DEPLOY_KEYS,
  'PRIVACY.md "Apps on the door page"': PRIVACY_APPS,
  'CHANGELOG.md [Unreleased]': UNRELEASED,
  'OBSERVABILITY.md apps rows': read('docs/OBSERVABILITY.md').split('\n').filter((l) => /^\| `(apps\.lane|apps\.wire|apps\.conv|link\.(sent|reply|push))` /.test(l)).join('\n'),
};

test('the passages written for the relay use no forbidden word and no claim the claims table forbids', () => {
  for (const [name, text] of Object.entries(PASSAGES)) {
    for (const re of FORBIDDEN) {
      const hit = re.exec(text);
      assert.equal(hit, null, name + ' has ' + (hit && JSON.stringify(text.slice(Math.max(0, hit.index - 40), hit.index + 60))) + ' (' + re + ')');
    }
  }
});

test('the whole documents that were touched have no em or en dash and no curly quote, and the passages say so in straight quotes', () => {
  for (const name of ['docs/APPS.md', 'docs/ARCHITECTURE.md', 'docs/INTERFACES.md', 'docs/DEPLOY.md', 'docs/PRIVACY.md', 'docs/OBSERVABILITY.md', 'docs/README.md', 'CHANGELOG.md']) {
    const lines = read(name).split('\n');
    const bad = lines.map((l, i) => (DASH.test(l) ? name + ':' + (i + 1) : null)).filter(Boolean);
    assert.deepEqual(bad, [], name + ' has a dash or a curly quote');
  }
  for (const [name, text] of Object.entries(PASSAGES)) assert.equal(DASH.test(text), false, name);
});

test('the passages that state a benefit state its condition: what the rendezvous sees comes with what it does not, and the address claim with the direct link', () => {
  const apps = flat(APPS_RELAY_SECTION);
  assert.match(apps, /Relays carry sealed messages of three fixed sizes and cannot read them/);
  assert.match(apps, /your network address, unless the door turns direct links on and one connects/);
  assert.match(apps, /does not say that it works there/);
  assert.match(apps, /This page does not say|so this page does not say/);
  const privacy = flat(PRIVACY_APPS);
  assert.match(privacy, /the other person does not see your network address/);
  assert.match(privacy, /A door whose `door.json` also says `direct` `"on"` lets the browsers try a direct link as well: when one connects, each learns the other's network address/);
  assert.match(privacy, /can be ordered to record the addresses that connect to it and can be barred from saying so/);
  // the benefit of the default is never stated without the host's view of the address
  assert.match(privacy, /see the lane's id, the network address of each socket, when each message is sent and one of three size classes/);
});
