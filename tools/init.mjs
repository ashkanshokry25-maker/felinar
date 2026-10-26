#!/usr/bin/env node
// tools/init.mjs: the owner-settings wizard of V03-DESIGN-REVIEW 2.5.5 (UX M14, MF-22): it asks the questions of the owner settings table
// in one pass and prints the commands to run, in order. It runs nothing, writes nothing (but the answers file, when you ask for one) and
// opens no socket. The same answers can come from a file, which is how the tests drive it.
//
//   node tools/init.mjs                         ask the questions, then print the commands
//   node tools/init.mjs --answers answers.json  no questions: the answers come from the file
//   node tools/init.mjs --save-answers a.json   write the answers you gave (to run it again later)
//   node tools/init.mjs ... --json              print { steps, warnings } as JSON instead of text
//
// The commands use only flags the tools have, and the answers are checked with the rules of the tools themselves: chat, files and media
// need the site's own tracker and STUN (publish refuses without them), --max-items is at most 32 and goes with synced records, --chat-bits
// goes with message requests, at most 4 origins, a loader version is x.y.z.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { isPublicKeyString } from '../src/chain/crypto.js';
import { normalizeScope, isOriginString, isLoaderVersion, ORG_MAX } from '../src/common/pointer.js';
import { orgList, stunList, turnConfig, featureProblems, ownTrackers, addressBoundScope } from './publish.mjs';
import { CFG_ENUMS, CFG_MAX_ITEMS, CFG_MAX_CHAT_BITS } from './ledger-admin.mjs';
import { parseCli, runMain, isMain, UsageError, out } from './lib.mjs';

const USAGE = `
Usage: node tools/init.mjs [--answers <answers.json>] [--save-answers <file>] [--json]

Asks the owner-settings questions (chat, public file listings, private files and media, synced records, message requests, the site's own
tracker and STUN, the pin node, TURN, the age method, the sign-in widget) and prints the commands to run, in order. Nothing is run.
With --answers the questions are skipped; --save-answers writes the answers to a file.
`;

/** Every answer and its default. A file may omit any of them. */
export const DEFAULT_ANSWERS = Object.freeze({
  site: Object.freeze({ dir: './site', name: 'my-site', scope: 'example.com', key: 'owner.jwk', mode: 'shell', out: 'dist-publish', ws: Object.freeze([]), cs: null, ct: null, expectedMembers: null }),
  access: Object.freeze({ writers: 'owner', moderators: Object.freeze([]), bits: null }),
  features: Object.freeze({ chat: 'off', files: 'off', media: 'off', records: 'off', maxItems: null, requests: 'off', chatBits: null }),
  network: Object.freeze({ tracker: Object.freeze([]), stun: Object.freeze([]), turn: Object.freeze([]), turnMode: null }),
  pin: Object.freeze({ mailbox: false, files: false, key: null }),
  age: 'none',
  widgets: Object.freeze({ signin: false, chatPanel: false, statement: null, challengeUrl: null, proofUrl: null }),
  identity: Object.freeze({ org: Object.freeze([]), ml: null, idp: null, nextKey: null }),
});

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const strList = (x) => (Array.isArray(x) ? x.map(String) : x === null || x === undefined || x === '' ? [] : String(x).split(',').map((s) => s.trim()).filter(Boolean));

/**
 * normalizeAnswers(raw) → the answers with every default filled in, or a UsageError that lists every problem at once (so a file is fixed in
 * one pass). Unknown sections and keys are errors too: a misspelt setting must not be silently dropped.
 */
export function normalizeAnswers(raw) {
  if (!isObj(raw)) throw new UsageError('the answers must be a JSON object');
  const problems = [];
  const a = {};
  for (const section of Object.keys(DEFAULT_ANSWERS)) {
    const def = DEFAULT_ANSWERS[section];
    const given = raw[section];
    if (!isObj(def)) {
      a[section] = given === undefined ? def : given;
      continue;
    }
    if (given !== undefined && !isObj(given)) {
      problems.push(section + ' must be an object');
      a[section] = Object.assign({}, def);
      continue;
    }
    const merged = Object.assign({}, def, given || {});
    for (const k of Object.keys(given || {})) if (!Object.prototype.hasOwnProperty.call(def, k)) problems.push(section + '.' + k + ' is not a setting (the settings are ' + Object.keys(def).join(', ') + ')');
    a[section] = merged;
  }
  for (const k of Object.keys(raw)) if (!Object.prototype.hasOwnProperty.call(DEFAULT_ANSWERS, k)) problems.push(k + ' is not a section (the sections are ' + Object.keys(DEFAULT_ANSWERS).join(', ') + ')');
  const need = (cond, text) => {
    if (!cond) problems.push(text);
  };
  const { site, access, features, network, pin, widgets, identity } = a;
  for (const k of ['dir', 'name', 'scope', 'key', 'out']) need(typeof site[k] === 'string' && site[k].length > 0, 'site.' + k + ' must be a non-empty string');
  need(['shell', 'dropin'].includes(site.mode), "site.mode must be 'shell' or 'dropin'");
  try {
    normalizeScope(String(site.scope));
  } catch (_) {
    problems.push('site.scope must be a hostname such as forum.example');
  }
  need(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/.test(String(site.name)), 'site.name is 1 to 100 characters of A-Z a-z 0-9 . _ ~ -');
  site.ws = strList(site.ws);
  for (const u of site.ws) need(/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(u), 'site.ws entries are https URLs: ' + u);
  need(site.cs === null || /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(String(site.cs)), 'site.cs is an https URL');
  need(site.ct === null || /^(https:\/\/|mailto:)/.test(String(site.ct)), 'site.ct is an https: or mailto: URL');
  need(site.expectedMembers === null || (Number.isSafeInteger(site.expectedMembers) && site.expectedMembers >= 0), 'site.expectedMembers is a whole number or null');
  need(['owner', 'allow', 'open'].includes(access.writers), "access.writers must be 'owner', 'allow' or 'open'");
  access.moderators = strList(access.moderators);
  for (const m of access.moderators) need(isPublicKeyString(m), 'access.moderators entries are public keys (p256:...): ' + m);
  need(access.bits === null || (Number.isInteger(access.bits) && access.bits >= 0 && access.bits <= 32), 'access.bits is 0 to 32 or null');
  for (const k of ['chat', 'files', 'media', 'records', 'requests']) need(CFG_ENUMS[k].includes(features[k]), 'features.' + k + ' must be ' + CFG_ENUMS[k].join(', '));
  need(features.maxItems === null || (Number.isInteger(features.maxItems) && features.maxItems >= 1 && features.maxItems <= CFG_MAX_ITEMS), 'features.maxItems is 1 to ' + CFG_MAX_ITEMS);
  need(features.maxItems === null || features.records === 'sealed', "features.maxItems goes with features.records 'sealed'");
  need(features.chatBits === null || (Number.isInteger(features.chatBits) && features.chatBits >= 0 && features.chatBits <= CFG_MAX_CHAT_BITS), 'features.chatBits is 0 to ' + CFG_MAX_CHAT_BITS);
  need(features.chatBits === null || features.requests === 'on', "features.chatBits goes with features.requests 'on'");
  network.tracker = strList(network.tracker);
  network.stun = strList(network.stun);
  network.turn = strList(network.turn);
  for (const t of network.tracker) need(/^wss:\/\/[^\s]+$|^ws:\/\/(localhost|127\.0\.0\.1)/.test(t), 'network.tracker entries are wss:// URLs: ' + t);
  try {
    stunList(network.stun);
  } catch (err) {
    problems.push('network.stun: ' + err.message);
  }
  try {
    turnConfig(network.turn, network.turnMode);
  } catch (err) {
    problems.push('network.turn: ' + err.message);
  }
  const on = ['chat', 'files', 'media'].filter((k) => features[k] !== 'off' || (k === 'chat' && widgets.chatPanel));
  const gate = featureProblems({ features: on, tr: network.tracker, stun: network.stun });
  for (const g of gate) problems.push('network: ' + g);
  need(typeof pin.mailbox === 'boolean' && typeof pin.files === 'boolean', 'pin.mailbox and pin.files are true or false');
  need(pin.key === null || isPublicKeyString(pin.key), 'pin.key is the pin node\'s public key (p256:...) or null');
  need(a.age === 'none' || isPublicKeyString(a.age), "age is 'none' or the age verifier's public key (p256:...)");
  need(typeof widgets.signin === 'boolean' && typeof widgets.chatPanel === 'boolean', 'widgets.signin and widgets.chatPanel are true or false');
  for (const k of ['challengeUrl', 'proofUrl']) need(widgets[k] === null || (String(widgets[k]).startsWith('/') && !String(widgets[k]).startsWith('//')), 'widgets.' + k + ' is a path on the site\'s own origin');
  identity.org = strList(identity.org);
  try {
    orgList(identity.org);
  } catch (err) {
    problems.push('identity.org: ' + err.message + ' (at most ' + ORG_MAX + ')');
  }
  need(identity.ml === null || isLoaderVersion(String(identity.ml)), "identity.ml is a loader version 'x.y.z'");
  need(identity.idp === null || isOriginString(String(identity.idp)), 'identity.idp is an exact origin such as https://id.example.org');
  if (problems.length) throw new UsageError('the answers have ' + problems.length + ' problem(s):\n  - ' + problems.join('\n  - '));
  return a;
}

/** shellQuote(arg) → the argument as a shell would need it (plain characters as they are, anything else in single quotes). */
export function shellQuote(arg) {
  const s = String(arg);
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

const cmd = (parts) => parts.map(shellQuote).join(' ');

/**
 * planInit(answers) → { steps: [{ id, title, command, notes }], warnings }  The commands, in the order to run them. `answers` is
 * normalizeAnswers' result (or anything it accepts). Pure: nothing is read, written or run.
 */
export function planInit(raw) {
  const a = normalizeAnswers(raw);
  const { site, access, features, network, pin, widgets, identity } = a;
  const steps = [];
  const warnings = [];
  const step = (id, title, command, notes = []) => steps.push({ id, title, command, notes });
  const ledgerFile = 'ledger.json';

  step('key', 'Make the owner key (on a machine you trust; keep a backup; skip this if you already have one)', cmd(['node', 'tools/keygen.mjs', '--out', site.key]),
    ['The key file never leaves your machine. The site\'s pointer and ledger rules are signed with it.']);
  if (identity.nextKey) {
    step('next-key', 'Make the NEXT owner key now and keep it offline: the pointer commits to it (nx=), so a stolen current key cannot move the site',
      cmd(['node', 'tools/keygen.mjs', '--out', 'next-owner.jwk']), ['Save the owner=p256:... line it prints into ' + identity.nextKey + ' and put next-owner.jwk away, offline.']);
  }

  const publish = ['node', 'tools/publish.mjs', site.dir, '--name', site.name, '--scope', site.scope, '--key', site.key];
  if (site.mode === 'dropin') publish.push('--dropin');
  if (site.mode === 'shell') publish.push('--shell');
  if (access.writers !== 'owner') publish.push('--policy', access.writers);
  for (const m of access.moderators) publish.push('--moderator', m);
  if (access.bits !== null) publish.push('--bits', String(access.bits));
  for (const u of site.ws) publish.push('--ws', u);
  if (site.cs) publish.push('--cs', site.cs);
  if (site.ct) publish.push('--ct', site.ct);
  for (const t of network.tracker) publish.push('--tracker', t);
  for (const s of stunList(network.stun)) publish.push('--stun', s);
  const turn = turnConfig(network.turn, network.turnMode);
  if (turn) {
    for (const u of turn.urls) publish.push('--turn', u);
    publish.push('--turn-mode', turn.mode);
  }
  if (features.chat !== 'off' || widgets.chatPanel) publish.push('--chat');
  if (features.files !== 'off') publish.push('--files');
  if (features.media !== 'off') publish.push('--media');
  for (const o of orgList(identity.org)) publish.push('--org', o);
  if (identity.ml) publish.push('--ml', identity.ml);
  if (identity.idp) publish.push('--idp', identity.idp);
  if (identity.nextKey) publish.push('--next-key', identity.nextKey);
  if (widgets.signin) {
    publish.push('--signin-widget');
    if (widgets.statement) publish.push('--signin-statement', widgets.statement);
    if (widgets.challengeUrl) publish.push('--challenge-url', widgets.challengeUrl);
    if (widgets.proofUrl) publish.push('--proof-url', widgets.proofUrl);
  }
  if (widgets.chatPanel) publish.push('--chat-panel');
  if (site.out !== 'dist-publish') publish.push('--out', site.out);
  const publishNotes = ['Build the loader first if you have not (node build.mjs --strict): publish copies the widgets from dist/_mw.'];
  step('publish', 'Publish the site: the torrent, the signed pointer (with org=, nx=, ml= and idp= if you set them) and the ledger genesis', cmd(publish), publishNotes);

  const cfg = ['node', 'tools/ledger-admin.mjs', 'cfg', '--key', site.key, '--file', ledgerFile];
  let settings = 0;
  for (const k of ['chat', 'files', 'media']) {
    if (features[k] !== 'off') {
      cfg.push('--' + k, features[k]);
      settings++;
    }
  }
  if (features.records !== 'off') {
    cfg.push('--records', features.records);
    if (features.maxItems !== null) cfg.push('--max-items', String(features.maxItems));
    settings++;
  }
  if (features.requests !== 'off') {
    cfg.push('--requests', features.requests);
    if (features.chatBits !== null) cfg.push('--chat-bits', String(features.chatBits));
    settings++;
  }
  if (pin.key) {
    cfg.push('--pin', pin.key);
    settings++;
  }
  if (turn) {
    for (const u of turn.urls) cfg.push('--turn', u);
    cfg.push('--turn-mode', turn.mode);
    settings++;
  }
  if (a.age !== 'none') {
    cfg.push('--age', a.age);
    settings++;
  }
  if (settings) {
    step('ledger-file', 'Copy the genesis to a working ledger file (publish rewrites genesis.json on every run; ledger.json keeps what you add)', cmd(['cp', site.out + '/genesis.json', ledgerFile]));
    step('cfg', 'Turn the features on in the ledger (offline, with the owner key; the settings are advisory and honest loaders enforce them)', cmd(cfg),
      ['Only the settings you chose are written; a setting you leave out keeps its value. Run it again any time to change one.']);
  }
  if (features.records === 'sealed') {
    const members = site.expectedMembers === null ? 1000 : site.expectedMembers;
    const items = features.maxItems === null ? 4 : features.maxItems;
    step('capacity', 'Check the ledger budget of synced records (members x items x 1,877 bytes: arithmetic)', cmd(['node', 'tools/ledger-admin.mjs', 'capacity', '--members', String(members), '--items', String(items)]));
    if (access.writers === 'owner') warnings.push('Synced records need visitors to write to the ledger: with writers=owner they stay on the visitor\'s device ("This site does not let visitors write to its ledger"). Use access.writers allow or open.');
  }
  if (settings || features.records === 'sealed') {
    step('snapshot', 'Make the snapshot visitors fetch first (cs=), and upload it where --cs points', cmd(['node', 'tools/snapshot.mjs', ledgerFile, '--out', site.out + '/snapshot.json.gz']),
      ['Run it again after every ledger change you want visitors to get before anyone else is online.']);
  }
  if (network.tracker.length) {
    step('tracker', 'Run your own tracker and allow the site on it (the chat, group and private media lanes use only your own tracker)',
      cmd(['node', 'tools/tracker.mjs', '--allow', site.out + '/summary.json']), ['Put it behind TLS (deploy/tracker has a Caddy file), at the wss:// address you gave.']);
  }
  if (pin.mailbox || pin.files) {
    const pinCmd = ['node', 'tools/pin.mjs', 'https://' + site.scope + '/', '--headless', '--profile', 'pin-profile'];
    if (pin.mailbox) pinCmd.push('--mailbox');
    if (pin.files) pinCmd.push('--files');
    step('pin', 'Start the pin node on a machine that stays on', cmd(pinCmd), [
      pin.mailbox ? 'The mailbox sees IP addresses, tags, sizes and times of the people who use it; your site\'s card says so.' : null,
      pin.files ? 'File requests wait for a moderator: node tools/pin.mjs --queue --profile pin-profile, then --approve <infohash>; --quarantine <infohash> takes a file out.' : null,
    ].filter(Boolean));
  }
  step('check', 'Check the live site from outside once the files are uploaded and the pointer is published', cmd(['node', 'tools/check-site.mjs', 'https://' + site.scope + '/']));

  if (access.writers === 'open' && !site.ct) warnings.push('writers=open without site.ct: add an abuse and legal contact (an https: or mailto: URL); publish warns too.');
  if (features.chat === 'open') warnings.push('chat=open lets anyone who loads the site use chat; "members" limits it to people the ledger lets in.');
  if (features.requests === 'on' && features.chat === 'off') warnings.push('Message requests need chat: set features.chat to members or open.');
  if (pin.mailbox && features.chat === 'off' && !widgets.chatPanel) warnings.push('The pin mailbox holds chat envelopes; chat is off, so nothing will arrive.');
  if (turn) warnings.push('TURN relays traffic for anyone who loads the site: set quotas on the relay and keep its peer-address logging off (docs/DEPLOY.md). Visitors choose "Connect directly" per conversation; the card names the operator.');
  if (widgets.chatPanel && site.mode !== 'dropin') warnings.push('The chat panel reads window.mw, which only drop-in pages define: use site.mode dropin.');
  if (!identity.nextKey) warnings.push('No next owner key: a stolen owner key can move the site. identity.nextKey commits the pointer to a key you keep offline (nx=).');
  if (on(features, widgets).length) warnings.push('Chat, files and media connect visitors to your tracker and STUN server: they see visitors\' IP addresses and when they are active. Say so in your privacy page (docs/PRIVACY.md).');
  return { steps, warnings };
}

function on(features, widgets) {
  return ['chat', 'files', 'media'].filter((k) => features[k] !== 'off' || (k === 'chat' && widgets.chatPanel));
}

/** renderPlan(plan) → the text printed. */
export function renderPlan(plan) {
  const lines = ['felinar init: ' + plan.steps.length + ' steps. Nothing has been run; run them in order.', ''];
  plan.steps.forEach((s, i) => {
    lines.push((i + 1) + '. ' + s.title, '   ' + s.command);
    for (const n of s.notes) lines.push('   - ' + n);
    lines.push('');
  });
  if (plan.warnings.length) {
    lines.push('Things to know:');
    for (const w of plan.warnings) lines.push('  - ' + w);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// the questions
// ---------------------------------------------------------------------------------------------

/** QUESTIONS: the owner-settings table of R 2.5.5, row by row. `ask(io, answers)` fills `answers` in place. */
async function askText(io, prompt, def, check = null) {
  for (;;) {
    const shown = def === null || def === undefined || def === '' ? '' : ' [' + def + ']';
    const raw = String(await io.ask(prompt + shown + ': ')).trim();
    const value = raw === '' ? def : raw;
    if (!check) return value;
    const problem = check(value);
    if (!problem) return value;
    io.say('  ' + problem);
  }
}

async function askChoice(io, prompt, choices, def) {
  return askText(io, prompt + ' (' + choices.join(' / ') + ')', def, (v) => (choices.includes(v) ? null : 'answer one of: ' + choices.join(', ')));
}

async function askYes(io, prompt, def) {
  const v = await askText(io, prompt + ' (yes / no)', def ? 'yes' : 'no', (x) => (/^(y|yes|n|no)$/i.test(String(x)) ? null : 'answer yes or no'));
  return /^y/i.test(String(v));
}

async function askList(io, prompt, def = []) {
  const v = await askText(io, prompt + ' (comma separated, empty for none)', def.join(','));
  return strList(v);
}

/**
 * interview(io) → answers. io = { ask(prompt) → Promise<string>, say(line) }; every question has a default (Enter). The text of a question
 * says what the setting does in plain words and what it costs.
 */
export async function interview(io) {
  const a = JSON.parse(JSON.stringify(DEFAULT_ANSWERS));
  io.say('felinar init: the owner settings, one pass. Press Enter for the value in brackets. Nothing is run.');
  io.say('');
  a.site.dir = await askText(io, 'Folder of your site', a.site.dir);
  a.site.name = await askText(io, 'Site name (letters, digits, . _ ~ -)', a.site.name, (v) => (/^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/.test(v) ? null : 'use letters, digits, . _ ~ - (at most 100)'));
  a.site.scope = await askText(io, 'Hostname the site is served from', a.site.scope, (v) => {
    try {
      normalizeScope(v);
      return null;
    } catch (_) {
      return 'a hostname such as forum.example';
    }
  });
  a.site.key = await askText(io, 'Owner key file', a.site.key);
  a.site.mode = await askChoice(io, 'Mode: shell (the loader serves the site) or dropin (your pages stay on your host)', ['shell', 'dropin'], a.site.mode);
  a.access.writers = await askChoice(io, 'Who can write to the ledger (posts, records): the owner only, an allow list, or anyone with the fee', ['owner', 'allow', 'open'], a.access.writers);
  if (a.access.writers === 'open') {
    // 0.3.0 independence design (IND-12): no derived contact for an address-bound scope (nip.io, sslip.io, an IP address; publish.mjs
    // addressBoundScope). Nobody receives mail at abuse@<that name>, and the contact is signed into the pointer: the owner types one.
    if (addressBoundScope(a.site.scope)) {
      a.site.ct = await askText(io, 'Abuse and legal contact: an https: page or a mailto: address you read (' + a.site.scope + ' cannot receive mail)', null,
        (v) => (v === null || /^(https:\/\/|mailto:)/.test(String(v)) ? null : 'an https: page or a mailto: address (Enter for none)'));
    } else {
      a.site.ct = await askText(io, 'Abuse and legal contact (https: or mailto: URL)', 'mailto:abuse@' + a.site.scope);
    }
  }
  a.features.chat = await askChoice(io, 'Chat (direct messages, rooms, groups)', CFG_ENUMS.chat, a.features.chat);
  a.features.files = await askChoice(io, 'Public file listings', CFG_ENUMS.files, a.features.files);
  a.features.media = await askChoice(io, 'Private files and media', CFG_ENUMS.media, a.features.media);
  a.features.records = await askChoice(io, 'Synced records in the ledger (encrypted; visitors keep them on their device otherwise)', CFG_ENUMS.records, a.features.records);
  if (a.features.records === 'sealed') {
    a.features.maxItems = Number(await askText(io, 'Items per member (1 to ' + CFG_MAX_ITEMS + '; each costs 1,877 bytes of ledger)', 4, (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= CFG_MAX_ITEMS ? null : 'a whole number from 1 to ' + CFG_MAX_ITEMS)));
    const members = await askText(io, 'Members you expect (for the budget line)', 1000, (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : 'a whole number'));
    a.site.expectedMembers = Number(members);
  }
  a.features.requests = await askChoice(io, 'Message requests from strangers', CFG_ENUMS.requests, a.features.requests);
  if (a.features.requests === 'on') a.features.chatBits = Number(await askText(io, 'Work a stranger\'s message costs (bits, 0 to 32; 20 is about a million hashes)', 20, (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 32 ? null : 'a whole number from 0 to 32')));
  const needNetwork = [a.features.chat, a.features.files, a.features.media].some((v) => v !== 'off');
  if (needNetwork) {
    io.say('Chat, files and media need your OWN tracker and STUN server; the shared public ones are not used for them.');
    for (;;) {
      a.network.tracker = await askList(io, 'Your tracker address (wss://...)', a.network.tracker);
      a.network.stun = await askList(io, 'Your STUN server (stun:host:3478)', a.network.stun);
      if (ownTrackers(a.network.tracker).length && a.network.stun.length) break;
      io.say('  both are needed when chat, files or media is on.');
    }
  }
  if (needNetwork && await askYes(io, 'Add a TURN relay (off by default; relays traffic for anyone who loads the site)', false)) {
    a.network.turn = await askList(io, 'TURN URLs (turn:, turns: or an https: credential endpoint)');
    if (a.network.turn.length) a.network.turnMode = await askChoice(io, 'TURN mode', ['static', 'endpoint'], a.network.turn.every((u) => u.startsWith('https://')) ? 'endpoint' : 'static');
  }
  a.pin.mailbox = await askYes(io, 'Run a pin node with a MAILBOX (holds messages for people who are offline; it sees IP addresses, tags, sizes and times)', false);
  a.pin.files = await askYes(io, 'Run a pin node that keeps FILES (requests wait for a moderator)', false);
  if (a.pin.mailbox || a.pin.files) a.pin.key = (await askText(io, 'The pin node\'s public key (p256:..., empty if you do not have it yet)', '')) || null;
  const age = await askText(io, "Age method: 'none' or an age verifier's public key (0.3.0 does not use this setting yet)", 'none');
  a.age = age;
  a.widgets.signin = await askYes(io, 'Add the sign-in widget to an existing site (self-hosted, with an integrity hash)', false);
  if (a.widgets.signin) a.widgets.statement = await askText(io, 'Sign-in statement shown on the identity page', 'Sign in to ' + a.site.name);
  a.widgets.chatPanel = await askYes(io, 'Add the chat panel to your pages (drop-in sites)', false);
  a.identity.org = await askList(io, 'Other origins that serve this site and may share its keys (at most ' + ORG_MAX + ', exact origins like https://www.example.com)');
  if (await askYes(io, 'Commit to a next owner key now (a stolen key then cannot move the site)', true)) a.identity.nextKey = await askText(io, 'File for the next key\'s public line', 'next-owner.pub');
  return a;
}

function nodeIo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (prompt) => new Promise((resolve) => rl.question(prompt, resolve)),
    say: (line) => process.stdout.write(line + '\n'),
    close: () => rl.close(),
  };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    answers: { type: 'string' },
    'save-answers': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length) throw new UsageError('unexpected argument ' + positionals[0]);
  let raw;
  if (flags.answers) {
    try {
      raw = JSON.parse(readFileSync(flags.answers, 'utf8'));
    } catch (err) {
      throw new UsageError('cannot read the answers ' + flags.answers + ': ' + err.message);
    }
  } else {
    if (!process.stdin.isTTY) throw new UsageError('no terminal to ask on: pass --answers <file> (see --help)');
    const io = nodeIo();
    try {
      raw = await interview(io);
    } finally {
      io.close();
    }
  }
  const plan = planInit(raw);
  if (flags.saveAnswers) writeFileSync(flags.saveAnswers, JSON.stringify(normalizeAnswers(raw), null, 2) + '\n');
  if (flags.json) out(JSON.stringify(plan, null, 2));
  else out(renderPlan(plan));
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
