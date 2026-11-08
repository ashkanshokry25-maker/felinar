// The v0.3 code review found documents that described things as built which were not (the wording rules of DESIGN-REVIEW
// section 4 bind documents too). Each test reads a document and the code it describes, so the claim and the code cannot drift
// apart again: the rights table of PRIVACY.md, the background tasks of the Service Worker, the open-writing protections of
// MF-54, the record-key limit, and the pass counts of the R 4.2 table against the e2e scenarios' own headers. The tests at the end
// (the post-8.2 polish batch, 2026-11-08) hold the documents that the lab deploy and the relay-first build made stale to the code and
// the dated records they now describe: the counters of the rendezvous, the trackers that pair by default, the status lines of the
// deploy documents, the check of a door, the door kit of a build without a signed list, the tool texts and the changelog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT } from '../../tools/lib.mjs';
import { APPS_TEXT } from '../../src/loader/strings.js';
import { appsTransportOf } from '../../src/loader/doors.js';
import { createRendezvous } from '../../deploy/rtc-worker/rtc.js';
import { DOOR_CHECK_MISSING_PATH, DOOR_CHECK_ORIGIN, withoutPointerStamp } from '../../tools/check-site.mjs';
import { doorKitFiles } from '../../tools/door-kit-files.mjs';
import { createTracker } from '../../tools/tracker.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const flat = (t) => t.replace(/\s+/g, ' ');
/** tableAfter(text, heading) -> the rows (arrays of trimmed cells) of the first Markdown table after the heading line. */
function tableAfter(text, heading) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim() === heading);
  assert.ok(i >= 0, 'no heading ' + heading);
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  const rows = [];
  for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  assert.ok(rows.length > 2, 'no table after ' + heading);
  return { head: rows[0], rows: rows.slice(2) };
}

test('PRIVACY.md "Your rights": every action names the method, card or tool that does it, or is marked (proposed)', () => {
  const { head, rows } = tableAfter(read('docs/PRIVACY.md'), '### Your rights, and what removal reaches');
  const where = head.indexOf('Where it is');
  assert.ok(where > 0, 'the table has a "Where it is" column');
  const sdk = read('src/sdk/sdk.js');
  const labels = read('src/loader/strings.js') + read('src/idp/strings.js');
  const problems = [];
  for (const r of rows) {
    const action = r[0], cell = r[where];
    if (/\(proposed\)/.test(cell)) continue;
    let evidence = 0;
    for (const m of cell.matchAll(/`mw\.([a-z]+\.[a-zA-Z]+)\(/g)) { evidence++; if (!sdk.includes("'" + m[1] + "'")) problems.push(action + ': no SDK method ' + m[1]); }
    for (const m of cell.matchAll(/"([^"]+)"/g)) { evidence++; if (!labels.includes("'" + m[1] + "'")) problems.push(action + ': no card or button labelled "' + m[1] + '"'); }
    for (const m of cell.matchAll(/`node (tools\/[a-z-]+\.mjs) ([a-z-]+)`/g)) {
      evidence++;
      if (!existsSync(join(ROOT, m[1])) || !read(m[1]).includes("'" + m[2] + "'")) problems.push(action + ': no command ' + m[1] + ' ' + m[2]);
    }
    if (!evidence) problems.push(action + ': names no method, card or tool and is not marked (proposed)');
  }
  assert.deepEqual(problems, []);
  // "Leave this site" (R 2.15) has no method yet: the row says so, and so does the notice template.
  const leave = rows.find((r) => r[0] === 'Leave this site');
  assert.ok(leave && /\(proposed\)/.test(leave[where]), 'Leave this site is not built: its row is marked (proposed)');
  assert.doesNotMatch(flat(read('docs/PRIVACY.md')), /"Leave this site" in Settings/);
});

// Background Sync, Periodic Sync, Background Fetch and Web Push are P3 (SZ section 2). A document may say the loader does one of them
// only when the Service Worker has the handler.
const BACKGROUND = [
  { name: 'Background Sync', handler: /addEventListener\(\s*['"]sync['"]/ },
  { name: 'Periodic Sync', handler: /addEventListener\(\s*['"]periodicsync['"]/ },
  { name: 'Background Fetch', handler: /addEventListener\(\s*['"]backgroundfetch/ },
  { name: 'Web Push', handler: /addEventListener\(\s*['"]push['"]/ },
];

test('the Service Worker\'s background tasks: COMPATIBILITY and ARCHITECTURE 8.1.8 say "(proposed" for each one src/sw does not handle', () => {
  const sw = readdirSync(join(ROOT, 'src', 'sw')).filter((n) => n.endsWith('.js')).map((n) => read('src/sw/' + n)).join('\n');
  const { head, rows } = tableAfter(read('docs/COMPATIBILITY.md'), '### Capabilities the C2 features use');
  const does = head.indexOf('What the loader does');
  assert.ok(does > 0);
  const arch = flat(read('docs/ARCHITECTURE.md'));
  const p818 = arch.slice(arch.indexOf('**8.1.8 When the tab is gone.**'), arch.indexOf('**8.1.9'));
  assert.ok(p818.length > 100, 'ARCHITECTURE 8.1.8 found');
  const problems = [];
  for (const b of BACKGROUND) {
    if (b.handler.test(sw)) continue; // built: nothing to check
    const row = rows.find((r) => r[0] === b.name);
    if (row && !/\(proposed/.test(row[does])) problems.push('COMPATIBILITY ' + b.name + ': "' + row[does] + '" but src/sw has no handler');
    if (p818.includes(b.name) && !/\(proposed/.test(p818)) problems.push('ARCHITECTURE 8.1.8 names ' + b.name + ' as built');
  }
  assert.deepEqual(problems, []);
  assert.ok(rows.some((r) => r[0] === 'Periodic Sync'), 'the rows are still there');
});

test('MF-54: the documents claim no open-writing warning and no per-author byte quota that the code does not have', () => {
  const tool = read('tools/ledger-admin.mjs');
  const chain = read('src/chain/node.js') + read('src/chain/state.js');
  const warns = /warn\([^)]*open/i.test(tool);
  const quota = /per-?author[^\n]{0,40}byte|authorQuota|maxAuthorBytes|perAuthorBytes/i.test(chain);
  const ops = flat(read('docs/OPERATIONS.md'));
  if (!warns) assert.doesNotMatch(ops, /`ledger-admin` warns when a policy opens writing/);
  if (!quota) {
    assert.doesNotMatch(ops, /a per-author byte quota applies/);
    const row = read('docs/THREAT-MODEL.md').split('\n').find((l) => l.startsWith('| MAL A12 '));
    assert.ok(row, 'THREAT-MODEL has the MAL A12 row');
    assert.ok(!/per-author quotas/.test(row) || /\(proposed\)/.test(row), 'MAL A12 lists per-author quotas as built: ' + row);
  }
});

test('the record-key limit: no document says a removed record key can never come back (docs/deviations/idp.md item 18)', () => {
  for (const f of ['docs/PRIVACY.md', 'docs/FAQ.md', 'docs/SDK.md']) assert.doesNotMatch(flat(read(f)), /cannot be recovered, by the person or by anyone/i, f);
  const privacy = flat(read('docs/PRIVACY.md'));
  const at = privacy.indexOf('A removed record key cannot be recovered');
  assert.ok(at > 0 && /backup file/.test(privacy.slice(at, at + 600)), 'PRIVACY.md states what still holds the key');
});

// The R 4.2 table: "pass" means the row as the review writes it ran. A row is not "pass" when every scenario it names calls itself
// PARTIAL in its file's header (the convention of test/e2e/scenarios-*.mjs).
function partialScenarios() {
  const out = new Map(); // id (upper case) -> true when the header calls it PARTIAL
  for (const name of readdirSync(join(ROOT, 'test', 'e2e')).filter((n) => n.endsWith('.mjs'))) {
    const lines = read('test/e2e/' + name).split('\n');
    let id = null;
    for (const line of lines) {
      if (!line.startsWith('//')) { id = null; continue; }
      const m = /^\/\/\s{2,}(E-[A-Z]{2}-\d+[A-Za-z]*|W-[A-Z0-9]+)\s/.exec(line);
      if (m) { id = m[1].toUpperCase(); if (!out.has(id)) out.set(id, false); }
      else if (!/^\/\/\s{4,}\S/.test(line)) id = null;
      if (id && /PARTIAL/.test(line)) out.set(id, true);
    }
  }
  return out;
}

test('the R 4.2 table of deviations/integration-v03.md: a "pass" row names a scenario that does not call itself PARTIAL, and the counts add up', () => {
  const text = read('docs/deviations/integration-v03.md');
  const headLine = text.split('\n').find((l) => l.startsWith('| Row | Status | Where |'));
  assert.ok(headLine, 'the R 4.2 table');
  const { rows } = tableAfter(text, headLine.trim());
  const partial = partialScenarios();
  assert.ok(partial.size > 20, 'scenario headers found: ' + partial.size);
  const problems = [];
  const count = { pass: 0, 'pass, partial': 0, open: 0 };
  for (const r of rows) {
    if (!/^E-/.test(r[0])) continue;
    count[r[1]] = (count[r[1]] || 0) + 1;
    if (r[1] !== 'pass') continue;
    const ids = [...r[2].matchAll(/\b(E-[A-Z]{2}-\d+[A-Za-z]*|W-[A-Z]+)\b/g)].map((m) => m[1].toUpperCase());
    if (!ids.length) continue; // a row that names a unit or browser test, not an e2e scenario
    if (ids.every((id) => partial.get(id) === true)) problems.push(r[0] + ' is "pass" but ' + ids.join(', ') + ' call themselves PARTIAL');
    for (const id of ids) if (!partial.has(id)) problems.push(r[0] + ' names ' + id + ', which no scenario header lists');
  }
  assert.deepEqual(problems, []);
  const total = count.pass + count['pass, partial'];
  const line = flat(text).match(/In all: (\d+) rows, (\d+) that ran and passed \((\d+) as written, (\d+) in part\) and (\d+) open\./);
  assert.ok(line, 'the "In all" line');
  assert.deepEqual(line.slice(1).map(Number), [count.pass + count['pass, partial'] + count.open, total, count.pass, count['pass, partial'], count.open]);
  const status = flat(read('docs/INTEGRATION-STATUS.md'));
  assert.ok(status.includes(total + ' ran and passed (' + count.pass + ' as written, ' + count['pass, partial'] + ' in part)'), 'INTEGRATION-STATUS.md repeats the counts');
});

// ---------------------------------------------------------------------------------------------------------------------
// The post-8.2 polish batch (2026-11-08): documents that the relay-first build and the lab deploy of 2026-11-08 made stale, held to the code.

const NODE = process.execPath;
// an en dash, an em dash and the curly quotes, built from code points so that this file holds none of them
const DASH_OR_CURLY = new RegExp('[' + [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c)).join('') + ']');
const lines = (text) => text.split('\n');
/** section(text, from, to) -> the text from the first `from` up to the next `to` after it. */
function section(text, from, to) {
  const a = text.indexOf(from);
  assert.ok(a >= 0, 'no passage starts with ' + JSON.stringify(from));
  const b = text.indexOf(to, a + from.length);
  assert.ok(b > a, 'the passage ' + JSON.stringify(from) + ' has no end ' + JSON.stringify(to));
  return text.slice(a, b);
}

test('deploy/rtc-worker/README.md: the counters and the day cap start again when the object is built again, relaySince says when, and no sentence calls the counts those of today (8.2 audit, lane A, F3)', () => {
  const md = flat(read('deploy/rtc-worker/README.md'));
  assert.doesNotMatch(md, /shows today's counts/);
  assert.doesNotMatch(md, /a new deployment starts them again at 0;/);
  for (const s of [
    'they start again at 0 whenever the object is built again: on a new deployment, and on a wake after the object slept',
    'a larger `relaySince` in the second read means that the object was built again or that a UTC midnight passed in between (`relayDay` differs then)',
    'The day cap holds for one run of the object: an object that is built again can forward up to 20,000 more frames in the same UTC day.',
    '`relaySince` is a time and not a count',
    '20,000 a UTC day for each run of the object (`relay is busy`)',
  ]) assert.ok(md.includes(s), 'the README does not say ' + JSON.stringify(s));
  // the code: relaySince is a number in the object's stats, right after relayDay, and "the nine after them" are the fields after lanes
  const stats = createRendezvous({ allow: new Set(['a'.repeat(40)]) }).stats();
  const keys = Object.keys(stats);
  assert.equal(typeof stats.relaySince, 'number');
  assert.equal(keys.indexOf('relaySince'), keys.indexOf('relayDay') + 1, 'relaySince follows relayDay');
  assert.equal(keys.length - keys.indexOf('lanes') - 1, 9, 'nine fields follow lanes');
  assert.ok(md.includes('and the nine after them the relay\'s'));
  // "or that a UTC midnight passed in between (`relayDay` differs then)": the same object, never built again, moves relaySince at midnight, so a larger
  // relaySince does not prove a rebuild (finding W1 of the wording verify, round 1)
  let clock = Date.UTC(2026, 10, 8, 23, 59, 0);
  const object = createRendezvous({ allow: new Set(['a'.repeat(40)]), now: () => clock });
  const first = object.stats();
  clock = Date.UTC(2026, 10, 9, 0, 1, 0);
  const second = object.stats();
  assert.ok(second.relaySince > first.relaySince, 'relaySince is larger in the second read');
  assert.notEqual(second.relayDay, first.relayDay, 'and relayDay differs');
  assert.equal(second.relaySince, Date.UTC(2026, 10, 9), 'it is 00:00 UTC of the new day');
});

test('deploy/rtc-worker/README.md: the relay is how a default door sends every message and a direct link needs the door to turn it on; a rollback of the relay leaves such a door with no way to connect, in the words the page shows', () => {
  const md = flat(read('deploy/rtc-worker/README.md'));
  assert.doesNotMatch(md, /The relay is what carries a message when the two browsers cannot reach each other directly/);
  assert.doesNotMatch(md, /so neither learns the other's network address before the approval/);
  assert.doesNotMatch(md, /The two can also pass their messages through this rendezvous on the same lane instead of connecting to each other/);
  for (const s of [
    'By default the relay carries every message of an accepted conversation or room, so a conversation does not wait for the two browsers to reach each other',
    'A door that turns direct links on also tries a direct link.',
    'By default the two then pass their sealed messages through this rendezvous on that lane',
    'and each side receives the other\'s address after it',
    'has no way to connect and shows "' + APPS_TEXT.en['apps.status.noPath'] + '"',
  ]) assert.ok(md.includes(s), 'the README does not say ' + JSON.stringify(s));
  // the same words are what the page shows
  assert.equal(APPS_TEXT.en['apps.status.noPath'], 'This door\'s rendezvous does not carry messages; ask the door\'s owner to update it');
  // What was tested: the lab run of 2026-11-08 is recorded, and "unit tests only" is gone
  assert.doesNotMatch(md, /The relay lane was added on 2026-11-07 and has unit tests only/);
  assert.ok(md.includes('On 2026-11-08 it was deployed on Cloudflare as the lab rendezvous'));
  assert.ok(md.includes('passed its 11 checks against it over the public internet'));
});

test('deploy/tracker and deploy/one-box: the READMEs say that the tracker pairs people and, by default, forwards their sealed messages under caps; the compose files and the tracker agree', async () => {
  const help = spawnSync(NODE, ['tools/tracker.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes('--no-pairing') && help.stdout.includes('--no-relay-lane'), 'the tracker has both flags');
  for (const dir of ['deploy/tracker', 'deploy/one-box']) {
    const md = flat(read(dir + '/README.md'));
    assert.ok(md.includes('`--no-pairing`') && md.includes('`--no-relay-lane`'), dir + ' README names both flags');
    assert.ok(md.includes('[deploy/rtc-worker/README.md]') && md.includes('"Pairing" and "Relay"'), dir + ' README points at the Worker README');
    assert.ok(md.includes('forwards the sealed messages of the two people between them, under caps'), dir + ' README says what the relay does');
    const compose = read(dir + '/docker-compose.yml');
    assert.ok(compose.includes('COPY deploy/rtc-worker/pair.js ./deploy/rtc-worker/pair.js'), dir + ': the image copies pair.js, so the tracker pairs');
    const command = lines(compose).find((l) => /^\s*command:/.test(l));
    assert.ok(command && !/--no-pairing|--no-relay-lane/.test(command), dir + ': the command passes neither flag, so both are on');
    assert.equal(DASH_OR_CURLY.test(read(dir + '/README.md')), false, dir + ' README has a dash or a curly quote');
  }
  // started as the compose files start it (no flag), the tracker pairs and has the relay lane on
  const tracker = await createTracker({ port: 0, allow: ['a'.repeat(40)], quiet: true });
  try {
    assert.equal(tracker.pairing, true);
    assert.equal(tracker.relayLane, true);
  } finally {
    await tracker.close();
  }
});

test('docs/DEPLOY.md: what the lab deploy of 2026-11-08 made false is corrected; the check of a door names what the checker reads; the kit of a build without a signed list is described as the tools make it; the word relay in the TURN section is told from the rendezvous', () => {
  const md = flat(read('docs/DEPLOY.md'));
  // (the first sentence is wrapped inside a block quote on main, so "have > not been served" is what flat() makes of it: the needle starts at "not")
  for (const old of ['not been served by a real host yet', 'not yet on Cloudflare itself', 'headless Chromium only)']) assert.ok(!md.includes(old), 'DEPLOY.md still says ' + JSON.stringify(old));
  for (const s of [
    'A lab door on Cloudflare Pages has served them since 2026-11-08 (`check-site --door` found 0 failures and 0 warnings there and printed `relay rendezvous, direct off`), and no conversation between two browsers has gone through them on a real network.',
    'DEMO-RESULTS rows G-AP-1 to G-AP-4: headless Chromium and one Android phone',
    'Tested under `wrangler dev`, with unit tests and, since 2026-11-02, on Cloudflare itself',
    'it is counted in memory and starts again whenever the object is built again',
    'a relay here means a TURN server; the rendezvous of a door\'s apps also forwards sealed messages, which is a different thing',
  ]) assert.ok(md.includes(s), 'DEPLOY.md does not say ' + JSON.stringify(s));
  // check-site --door: every file the section says it reads is one the tool asks for (the tool's own constants)
  const check = section(md, '### Checking a door: `check-site --door`', '### Apps at a door');
  assert.ok(check.includes('`' + DOOR_CHECK_MISSING_PATH + '`'), 'the section names the made-up path of the tool');
  for (const path of ['/mw-sw-kill.js', '/404.html', '/index.html']) assert.ok(check.includes('`' + path + '`'), 'the section names ' + path);
  assert.ok(check.includes('A header that is there but joined') && check.includes('is a failure with or without the flag'));
  assert.equal(typeof withoutPointerStamp, 'function');
  assert.ok(check.includes('the pointer tag that `publish --shell` adds to `index.html` and `404.html`'));
  // the answers the checker explains as [info], and the Origin it sends (tools-check-door.test.mjs holds the cases: a 403 with the listed bytes, and a host that echoes the Origin)
  assert.ok(check.includes('Five answers are an `[info]` line') && check.includes('the listed bytes with any other status (403 or 410, say)'), 'the unknown path has five [info] answers');
  assert.ok(check.includes('(or the `Origin` the check sends, `' + DOOR_CHECK_ORIGIN + '`, for a host that echoes it)'));
  // a dev server started with --dev, --hub or --doh stamps meta tags that the check does not take out (finding F6 of the privacy-and-code verify, round 1):
  // the three flags are the ones that push a tag in the dev server, and the helper of the check removes the pointer tag only
  assert.ok(check.includes('A dev server (`tools/dev-server.mjs`) that adds `<meta>` tags of its own to the HTML pages it serves'));
  assert.ok(check.includes('the check compares `/_mw/open.html` byte for byte and takes only the pointer tag that a publish adds out of `/404.html` and `/index.html`'));
  const devJs = read('tools/dev-server.mjs');
  for (const name of ['mw-dev', 'mw-hub', 'mw-doh']) {
    assert.ok(devJs.includes("metas.push({ name: '" + name + "'"), 'the dev server stamps ' + name);
    const page = Buffer.from('<!doctype html><head><meta charset="utf-8"><meta name="' + name + '" content="1"></head><body></body>');
    assert.deepEqual(withoutPointerStamp(page), page, 'the check leaves ' + name + ' in the page');
  }
  // the kit of a build without a signed list: the call the section names makes the README it describes, and only that file differs
  assert.ok(md.includes('`doorKitFiles({ version, release: false, buildId, commit })`'));
  const own = doorKitFiles({ version: '0.3.0', release: false, buildId: 'bb8ac84e73f6', commit: '10ef87d' });
  const signed = doorKitFiles({ version: '0.3.0' });
  assert.ok(own['README-DOOR.txt'].includes('not a signed release') && !own['README-DOOR.txt'].includes('byte for byte as released'));
  for (const name of Object.keys(signed)) if (name !== 'README-DOOR.txt') assert.equal(own[name], signed[name], name + ' is the same file in both kits');
});

test('docs/PRIVACY.md and docs/DEMO-RESULTS.md: the status lines say what has run on a real network, the counts are not those of "today", the register row says what the price card says, and the connected words are the ones the page shows', () => {
  const privacy = flat(read('docs/PRIVACY.md'));
  // the status of the apps passage (other passages of PRIVACY.md have their own, older, status lines)
  const appsPassage = section(privacy, '### Apps on the door page (unreleased)', '### Usage reports (unreleased)');
  assert.ok(!appsPassage.includes('tested on loopback only.'));
  assert.ok(!appsPassage.includes('it has not run on a real network.'));
  for (const s of [
    'tested on loopback, and on 2026-11-02 in headless Chromium and with one phone against the public tier (APPS.md, "What was tested")',
    'no conversation between two browsers has gone through it on a real network (a script of two sockets ran its lane on the lab rendezvous on 2026-11-08)',
    'the frames and characters forwarded and the frames refused since the counts last started (`/stats.json` of the rendezvous',
    'the frames refused since the counts last started',
  ]) assert.ok(privacy.includes(s), 'PRIVACY.md does not say ' + JSON.stringify(s));
  assert.doesNotMatch(privacy, /forwarded today and the frames refused/);
  // the register row of the rendezvous says what the price card says (strings.js: the text, the room text and the paragraph about the host)
  const row = lines(read('docs/PRIVACY.md')).find((l) => l.startsWith('| The rendezvous of a door that offers apps, and its host (unreleased) |'));
  assert.ok(row, 'the register row of the rendezvous');
  assert.ok(APPS_TEXT.en['apps.price.text'].includes('your network address and the other person\'s, the id of your conversation'));
  assert.ok(row.includes('your network address and the other person\'s (the other members\' in a room), the id of the conversation (of the room)'));
  assert.ok(row.includes(APPS_TEXT.en['apps.price.hostOrder'].replace('The host of a rendezvous', 'the host of a rendezvous').replace(/\.$/, '')));
  // DEMO-RESULTS: the row that counts RTCPeerConnection objects and times the connection names the words the page shows for a relay and for a direct link
  const g = lines(read('docs/DEMO-RESULTS.md')).find((l) => l.startsWith('| G-AP-2 | on each device'));
  assert.ok(g, 'the G-AP-2 row of "What to record"');
  assert.ok(g.includes('"' + APPS_TEXT.en['apps.status.relayed'] + '" (the relay)') && g.includes('"' + APPS_TEXT.en['apps.status.connected'] + '" (a direct link)'));
  assert.ok(g.includes('and after it (0 on a door that keeps direct links off, the default of the relay-first build)'));
  const results = flat(read('docs/DEMO-RESULTS.md'));
  assert.ok(!results.includes('The demo tier runs loader build f9b26a88bc9c since 15:17'));
  assert.ok(results.includes('On 2026-11-02 the demo tier ran loader build f9b26a88bc9c from 15:17'));
  assert.ok(results.includes('since 2026-11-03 the demo door has also served two service worker files of a later build (c19695f83323)'));
});

test('README.md item 8 says what is true of 0.3.0, and the publish checklist keeps the release that carries the apps from forgetting it while it says so (polish decision P7.D4)', () => {
  const sentence = 'Only a call can go through a relay, and only one that you set up yourself.';
  const readme = flat(read('README.md'));
  const list = flat(read('docs/PUBLISH-CHECKLIST.md'));
  const line = 'git grep -n "Only a call can go through a relay" -- README.md';
  // while the README says it, the checklist carries the line; once the release with the apps has changed the README, the line goes
  assert.equal(list.includes(line), readme.includes(sentence), 'README item 8 and the checklist line must stand or go together');
  if (readme.includes(sentence)) {
    assert.ok(list.includes('"' + sentence + '"'), 'the checklist quotes the sentence word for word');
    assert.ok(list.includes('change item 8 of "What it is not" in `README.md`'));
  }
});

test('tool texts: the demo, the dev server and the apps block say that a STUN server matters only when direct links are on', () => {
  // the comments of a file wrap with "// " at the start of each line: take that out, then collapse the white space
  const prose = (path) => flat(read(path).replace(/\n\s*\/\/ ?/g, ' '));
  const demo = prose('tools/demo.mjs');
  const dev = prose('tools/dev-server.mjs');
  const block = prose('tools/apps-block.mjs');
  assert.ok(!demo.includes('the demo runs none, so without it browsers connect with host candidates'));
  assert.ok(!demo.includes('The demo runs none: without it browsers connect with host'));
  assert.ok(!dev.includes('(repeat; at most 8; none: browsers on one network connect with host candidates)'));
  assert.ok(!block.includes('(stun: or stuns:), none when the browsers are on one network'));
  assert.ok(demo.includes('it matters only when direct links are on, that is with --apps-direct on or --apps-relay none alone: with the default, direct off, the page makes no peer connection and asks no STUN server'));
  assert.ok(dev.includes('used only when direct links are on, that is with --apps-direct on or --apps-relay none alone; none: browsers on one network connect with host candidates'));
  // "--apps-relay none alone" is the rule of the page (src/loader/doors.js appsTransportOf): relay none with direct absent means direct on (finding W5 of the wording verify, round 1)
  assert.equal(appsTransportOf({ relay: 'none' }).direct, 'on');
  assert.equal(appsTransportOf({ relay: 'rendezvous' }).direct, 'off');
  assert.equal(appsTransportOf({}).direct, 'off');
  assert.ok(block.includes('used only when direct is on; none when the browsers are on one network'));
  // the tracker's header (a wave 1 comment): the first message that moves after the approval is a sealed frame, not a WebRTC offer, by default
  const tracker = prose('tools/tracker.mjs');
  assert.ok(tracker.includes('so nothing else moves before approval: the first sealed frame by default, and with a door that turns direct links on the first WebRTC offer'));
});

test('CHANGELOG.md [Unreleased] records the polish batch with names the code has', () => {
  const log = read('CHANGELOG.md');
  const unreleased = flat(log.slice(log.indexOf('## [Unreleased]'), log.indexOf('\n## [0.3.0]')));
  const keys = Object.keys(createRendezvous({ allow: new Set(['a'.repeat(40)]) }).stats());
  assert.ok(keys.includes('relaySince') && unreleased.includes('`relaySince`'), 'the field of the stats');
  assert.ok(unreleased.includes('20,000 frames a UTC day for each run of the object'));
  for (const key of ['apps.price.hostOrder', 'apps.status.alone']) {
    assert.equal(typeof APPS_TEXT.en[key], 'string', key + ' is a text of the apps');
    assert.equal(typeof APPS_TEXT.fr[key], 'string', key + ' has its French twin');
    assert.ok(unreleased.includes('`' + key + '`'), 'the changelog names ' + key);
  }
  assert.ok(unreleased.includes('`DOOR_CHECK_MISSING_PATH`') && unreleased.includes('`withoutPointerStamp`'));
  assert.ok(unreleased.includes('`doorKitFiles({ version, release: false, buildId, commit })`'));
  assert.ok(unreleased.includes('The relay on a real host, 2026-11-08'));
  assert.ok(unreleased.includes('not yet run on a real network'), 'the phrase of the relay entry stays until the first conversation has gone through');
  assert.ok(unreleased.includes('of the lab kit (build bb8ac84e73f6, main 10ef87d) is 1,455,871 bytes (463,902 with `gzip -9`), 18,633 bytes (5,375 gzipped) more than the one in the kit before it (build f9b26a88bc9c, 1,437,238 bytes and 458,527 gzipped)'), 'the measured cost of the relay-first build');
});
