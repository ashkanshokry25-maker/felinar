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
import { LIMITS } from '../../src/loader/apps.js';

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
const APPS_KNOWN = between(APPS, '## Known limits', '## Prior art');
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

// The page keeps its socket under the caps above by its own count (finding A-3 of verify round 0): the link counts what its socket sent and holds a
// frame back until it has room, at most HELD_PER_LANE of one lane (finding A-6 of verify round 1). The numbers the documents give for that are the
// link's own, under the caps of pair.js, and the documents say the condition: the link counts a frame from its send, the rendezvous from its arrival,
// so a network that holds frames back and then delivers them at once can still take a socket over the caps (finding C-12 of verify round 1).
test('the minute a page keeps for its socket: APPS, ARCHITECTURE and INTERFACES give the link\'s numbers as the code holds them, under the caps of pair.js, with the condition they hold under', () => {
  assert.ok(LINK.RELAY_BUDGET > 0 && LINK.RELAY_BUDGET < PAIR.DEFAULT_CAPS.relayPerMin, 'the relayed frames a page sends a minute stay under relayPerMin');
  assert.ok(LINK.MESSAGE_BUDGET > LINK.RELAY_BUDGET && LINK.MESSAGE_BUDGET < PAIR.DEFAULT_CAPS.messagesPerMin, 'the messages a page sends a minute stay under messagesPerMin');
  assert.ok(LINK.BUDGET_WINDOW_MS > 60000 && LINK.HELD_PER_LANE > 0, 'the link counts a frame longer than the minute of the rendezvous');
  const secs = LINK.BUDGET_WINDOW_MS / 1000;
  const apps = flat(APPS_RELAY_SECTION);
  assert.ok(apps.includes('(' + LINK.RELAY_BUDGET + ' relayed frames and ' + LINK.MESSAGE_BUDGET + ' messages in those ' + secs + ' seconds)'), 'APPS "Messages through the rendezvous"');
  assert.ok(apps.includes('the last ' + secs + ' seconds, ' + (secs - 60) + ' more than the rendezvous counts'), 'APPS gives the count of the link');
  assert.ok(apps.includes('At most ' + LINK.HELD_PER_LANE + ' frames of one conversation or room wait at a time'), 'APPS gives the bound of a lane');
  assert.ok(apps.includes('while its frames reach the rendezvous at an even pace'), 'APPS says the condition');
  assert.ok(apps.includes('not one that holds frames back and then delivers them at once, which can still take a socket over the caps'), 'APPS says what the condition leaves out');
  const arch = flat(ARCH_RELAY);
  assert.ok(arch.includes(LINK.RELAY_BUDGET + ' relayed frames and ' + LINK.MESSAGE_BUDGET + ' messages in ' + secs + ' seconds, holding a frame back'), 'ARCHITECTURE 15.21');
  assert.ok(arch.includes('wait behind ' + LINK.HELD_PER_LANE + ' of its lane') && arch.includes('the rendezvous counts the frames as they arrive'), 'ARCHITECTURE 15.21, the bound and the condition');
  const intf = flat(INTERFACES);
  assert.ok(INTERFACES.includes('relayBudget = ' + LINK.RELAY_BUDGET + ', messageBudget = ' + LINK.MESSAGE_BUDGET), 'INTERFACES createLink');
  assert.ok(intf.includes('heldPerLane = ' + LINK.HELD_PER_LANE + ', log'), 'INTERFACES createLink, the bound of a lane');
  assert.ok(intf.includes('relayBudget relayed frames (RELAY_BUDGET, ' + LINK.RELAY_BUDGET + ') and messageBudget frames in all (MESSAGE_BUDGET, ' + LINK.MESSAGE_BUDGET + ')'), 'INTERFACES the socket\'s minute');
  assert.ok(intf.includes('the last ' + secs + ' seconds (BUDGET_WINDOW_MS') && intf.includes('(HELD_PER_LANE, ' + LINK.HELD_PER_LANE + ')'), 'INTERFACES the count and the bound');
  assert.ok(intf.includes('not when the network holds frames back and then delivers them at once'), 'INTERFACES says the condition');
  assert.equal(typeof LINK.PairLink.prototype.dropHeld, 'function');
  assert.ok(intf.includes('dropHeld(lane) -> n'), 'INTERFACES names dropHeld');
  // the sentences that promised it without the condition are gone, from the documents and from the link's own comments
  for (const [name, text] of [['APPS', APPS], ['ARCHITECTURE', ARCH], ['INTERFACES', INTERFACES], ['apps-link.js', read('src/loader/apps-link.js')]]) {
    assert.doesNotMatch(flat(text), /never trips? (?:the|those) caps by itself|keeps itself under both, 100|waits instead of being refused or closed \(tested/, name);
  }
});

// What the page does with the frames that wait, as the code does it (findings C-13, C-14 and C-15 of verify round 2; A-7 and A-8 the same): the
// link refuses at once a frame that would wait behind HELD_PER_LANE of its lane, also at a pace the rendezvous would still take; blocking drops what
// waited, while leaving, or an owner closing a room, sends its goodbye behind it within one count of BUDGET_WINDOW_MS unless the goodbye is refused;
// only a direct message is answered with a Delivered mark; and a refused message waits in the page until the person tries it again or sends the
// next one. test/unit/loader-apps-lane.test.mjs holds the code to each of these.
test('what a page does with the frames that wait: APPS and CHANGELOG say what the link refuses, what blocking and leaving do with what waited, and what a refused message does, as the code does it', () => {
  const secs = LINK.BUDGET_WINDOW_MS / 1000;
  const held = LINK.HELD_PER_LANE;
  const apps = flat(APPS_RELAY_SECTION);
  assert.ok(apps.includes('the next is refused at once with the rendezvous\'s reason (`too many relays`), even at a pace the rendezvous would still take'), 'APPS says the page refuses, also at a pace the rendezvous would take');
  assert.ok(apps.includes('So the rendezvous neither refuses nor closes a busy page, or a room owner letting many people in, while its frames reach the rendezvous at an even pace'), 'APPS says what the page is spared, with its condition');
  assert.ok(apps.includes('the page waits, and refuses only a frame that would wait behind ' + held + ' of its conversation or room'), 'APPS says what the page itself refuses');
  const known = flat(APPS_KNOWN);
  assert.ok(known.includes('The page answers every direct message it receives with a Delivered mark'), 'Known limits: the Delivered mark is for direct messages');
  assert.ok(known.includes('A refused message waits in the page (a direct message shows "' + APPS_TEXT.en['apps.msg.failed'] + '" with "' + APPS_TEXT.en['apps.msg.retry'] +
    '" after ' + LIMITS.ackTimeoutMs / 1000 + ' seconds) and goes when the person tries it again, sends the next one or a connection returns, not by itself'), 'Known limits: what a refused message does');
  assert.ok(known.includes('neither is a refused goodbye, so the other side is not told that the conversation or the room ended'), 'Known limits: a refused goodbye');
  assert.ok(known.includes('Blocking a conversation drops what waited for it at once. Leaving one, or closing a room one owns, first sends its goodbye, which waits its turn: the frames the page already handed to its connection go out and then the goodbye, within ' +
    secs + ' seconds, unless ' + held + ' frames already wait, when the goodbye is refused and they are dropped at once. A message that still waits in the page (one that was refused, or one written after the message on its way) does not reach the other side: it ends with the conversation or the room'),
  'Known limits: blocking and leaving (verify round 3, A-9: only the frames already handed to the link go before the goodbye)');
  const changelog = flat(UNRELEASED);
  assert.ok(changelog.includes('the next is refused at once, even at a pace the rendezvous would take; blocking a conversation drops what waited for it, and leaving it, or closing a room one owns, sends what waited and then the goodbye within ' +
    secs + ' seconds, unless ' + held + ' already wait, when the goodbye is refused and they are dropped'), 'CHANGELOG: the refusal, blocking and leaving');
  // the sentences that said more than the code does are gone
  for (const [name, text] of [['APPS', flat(APPS)], ['CHANGELOG', changelog]]) {
    assert.doesNotMatch(text, /leaving or blocking (?:a conversation )?drops what waited|as the rendezvous would refuse it|waits instead of being refused or closed|answers every message it receives|a message stays queued and goes again/i, name);
  }
});

test('every counter pair.js reports for the relay is named in INTERFACES, counts only', () => {
  const stats = PAIR.createPairing({ random: (len) => new Uint8Array(len), now: () => Date.UTC(2026, 10, 7, 12, 0, 0) }).stats();
  const relayFields = Object.keys(stats).filter((k) => !['codes', 'knocks'].includes(k));
  // the seven fields of plan 3.2 and `evicted` (members evicted from a full lane today, DECISIONS DEC-1), exactly (finding B-2 of verify round 0:
  // DEC-1 has landed, so a stats() that lost the field must fail here)
  const expected = ['evicted', 'joinsRefused', 'relayBusy', 'relayBytes', 'relayDay', 'relayRate', 'relayed', 'relays'];
  assert.deepEqual(relayFields.sort(), expected);
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

test('INTERFACES names the strings and the conversation reason of the Decide phase (DEC-3 apps.price.hidden, DEC-5 no-path and apps.status.noPath), and the strings exist in both languages', () => {
  const view = between(INTERFACES, '### The view and the hooks in the loader', 'src/loader/ui.js');
  for (const k of ['apps.price.hidden', 'apps.price.hiddenRoom', 'apps.status.noPath']) {
    assert.ok(view.includes(k), 'INTERFACES "The view" does not name ' + k);
    assert.ok(typeof APPS_TEXT.en[k] === 'string' && APPS_TEXT.en[k].length > 0, 'no English ' + k);
    assert.ok(typeof APPS_TEXT.fr[k] === 'string' && APPS_TEXT.fr[k].length > 0, 'no French ' + k);
  }
  const service = between(INTERFACES, 'apps.state() ->', 'Calls       every call');
  assert.ok(service.includes("'no-path'"), 'INTERFACES apps.state() does not name the conversation reason no-path');
  assert.ok(service.includes("'bad-lane'"), 'INTERFACES apps.state() does not name the conversation reason bad-lane');
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
  // DEC-3: the denial is its own paragraph, shown only when direct links are off, and the price text ends before it
  for (const k of ['apps.price.hidden', 'apps.price.hiddenRoom']) assert.ok(apps.includes('"' + APPS_TEXT.en[k] + '"'), 'APPS.md does not quote ' + k);
  assert.match(APPS_TEXT.en['apps.price.text'], /never what\.$/);
  assert.match(APPS_TEXT.en['apps.price.room'], /never what\.$/);
  assert.match(apps, /a card never states that the other person does not see your address and then takes it back/);
  // DEC-5: the line of a conversation with no usable path, in the troubleshooting table, with what to do
  assert.ok(apps.includes('"' + APPS_TEXT.en['apps.status.noPath'] + '"'), 'APPS.md does not quote apps.status.noPath');
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
    'which is every block published before this change', '"relay": "none"', 'apps.price.textDirect',
    // the Decide phase: DEC-1 (a vanished member does not block its replacement), DEC-3 (the denial as its own paragraph), DEC-5 (no usable path is visible)
    '`memberStaleMs`', '`lane full`', '`apps.price.hidden`', '`no-path`', '`apps.status.noPath`']) {
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
  // With direct links on, the connection offers and answers carry each browser's address to the other before any link exists (the tracker client
  // makes non-trickle offers with every candidate gathered, src/loader/connectivity.js): the address claim is tied to turning direct links on,
  // never to a link connecting (findings C-1 and C-2 of verify round 0)
  assert.match(apps, /your network address, unless the door turns direct links on \(its connection offers carry the address, connected or not\)/);
  assert.match(apps, /does not say that it works there/);
  assert.match(apps, /This page does not say|so this page does not say/);
  const privacy = flat(PRIVACY_APPS);
  assert.match(privacy, /the other person does not see your network address/);
  assert.match(privacy, /A door whose `door.json` also says `direct` `"on"` lets the browsers try a direct link as well: their connection offers and answers, which the rendezvous carries on the lane as any tracker does, hold each browser's network address, so each person's browser receives the other's address whether or not a link connects/);
  for (const [name, text] of [['APPS.md', flat(APPS)], ['PRIVACY.md', privacy], ['ARCHITECTURE.md', flat(ARCH)]]) {
    assert.doesNotMatch(text, /(?:and|when) one connects|a direct link connects, each|connects two browsers, each sees/, name + ' ties the address to a link connecting');
  }
  // the owner of the door is denied addresses only with the condition (C-4): the code gives none, unless the owner logs them or hosts the rendezvous
  assert.doesNotMatch(privacy, /not messages or addresses/);
  assert.match(privacy, /gives the owner no addresses, unless the owner adds code that logs them or hosts the rendezvous on a machine of their own/);
  assert.match(privacy, /can be ordered to record the addresses that connect to it and can be barred from saying so/);
  // the benefit of the default is never stated without the host's view of the address
  assert.match(privacy, /see the lane's id, the network address of each socket, when each message is sent and one of three size classes/);
});
