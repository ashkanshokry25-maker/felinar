// Unit tests for tools/init.mjs (V03-DESIGN-REVIEW 2.5.5; MF-22, MF-44): an answers file becomes the commands, the commands use only flags the
// tools have, and the answers are refused by the rules of the tools themselves. The interview is driven with a scripted terminal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { normalizeAnswers, planInit, renderPlan, shellQuote, interview, DEFAULT_ANSWERS } from '../../tools/init.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

const work = mkdtempSync(join(tmpdir(), 'mw-v03-init-'));
after(() => rmSync(work, { recursive: true, force: true }));

async function key() {
  const { publicKey } = await generateKeyPair({ extractable: false });
  return exportPublicKey(publicKey);
}

const FULL = {
  site: { dir: './forum', name: 'forum', scope: 'forum.example', key: 'owner.jwk', mode: 'dropin', ws: ['https://forum.example/ws/'], cs: 'https://forum.example/ws/snapshot.json.gz', ct: 'mailto:abuse@forum.example', expectedMembers: 500 },
  access: { writers: 'allow', bits: 18 },
  features: { chat: 'members', files: 'members', media: 'members', records: 'sealed', maxItems: 4, requests: 'on', chatBits: 20 },
  network: { tracker: ['wss://rtc.forum.example'], stun: ['stun:stun.forum.example:3478'], turn: ['turns:turn.forum.example:5349'] },
  pin: { mailbox: true, files: true },
  widgets: { signin: true, chatPanel: true, statement: 'Sign in to Example Forum' },
  identity: { org: ['https://www.forum.example'], ml: '0.3.0', idp: 'https://id.forum.example', nextKey: 'next-owner.pub' },
};

const byId = (plan) => Object.fromEntries(plan.steps.map((s) => [s.id, s]));

test('an answers file becomes the commands of the owner-settings table, in the order to run them', () => {
  const plan = planInit(FULL);
  assert.deepEqual(plan.steps.map((s) => s.id), ['key', 'next-key', 'publish', 'ledger-file', 'cfg', 'capacity', 'snapshot', 'tracker', 'pin', 'check']);
  const s = byId(plan);
  assert.equal(s.key.command, 'node tools/keygen.mjs --out owner.jwk');
  assert.equal(s['next-key'].command, 'node tools/keygen.mjs --out next-owner.jwk');
  assert.equal(s.publish.command, [
    'node tools/publish.mjs ./forum --name forum --scope forum.example --key owner.jwk --dropin --policy allow --bits 18',
    '--ws https://forum.example/ws/ --cs https://forum.example/ws/snapshot.json.gz --ct mailto:abuse@forum.example',
    '--tracker wss://rtc.forum.example --stun stun:stun.forum.example:3478 --turn turns:turn.forum.example:5349 --turn-mode static',
    '--chat --files --media --org https://www.forum.example --ml 0.3.0 --idp https://id.forum.example --next-key next-owner.pub',
    "--signin-widget --signin-statement 'Sign in to Example Forum' --chat-panel",
  ].join(' '));
  assert.equal(s['ledger-file'].command, 'cp dist-publish/genesis.json ledger.json');
  assert.equal(s.cfg.command, [
    'node tools/ledger-admin.mjs cfg --key owner.jwk --file ledger.json --chat members --files members --media members',
    '--records sealed --max-items 4 --requests on --chat-bits 20 --turn turns:turn.forum.example:5349 --turn-mode static',
  ].join(' '));
  assert.equal(s.capacity.command, 'node tools/ledger-admin.mjs capacity --members 500 --items 4');
  assert.equal(s.snapshot.command, 'node tools/snapshot.mjs ledger.json --out dist-publish/snapshot.json.gz');
  assert.equal(s.tracker.command, 'node tools/tracker.mjs --allow dist-publish/summary.json');
  assert.equal(s.pin.command, 'node tools/pin.mjs https://forum.example/ --headless --profile pin-profile --mailbox --files');
  assert.equal(s.check.command, 'node tools/check-site.mjs https://forum.example/');
  const text = renderPlan(plan);
  assert.match(text, /^felinar init: 10 steps\. Nothing has been run; run them in order\./);
  assert.match(text, /\n3\. Publish the site/);
  assert.match(text, /Things to know:/);
  assert.ok(plan.warnings.some((w) => /TURN relays traffic for anyone who loads the site/.test(w)));
  assert.ok(plan.warnings.some((w) => /see visitors' IP addresses/.test(w)));
});

test('the defaults print a short plan (key, publish as a shell site, check) and warn about the missing next key', () => {
  const plan = planInit({});
  assert.deepEqual(plan.steps.map((s) => s.id), ['key', 'publish', 'check']);
  assert.equal(byId(plan).publish.command, 'node tools/publish.mjs ./site --name my-site --scope example.com --key owner.jwk --shell');
  assert.ok(plan.warnings.some((w) => /No next owner key/.test(w)));
  assert.equal(JSON.stringify(DEFAULT_ANSWERS.features), JSON.stringify({ chat: 'off', files: 'off', media: 'off', records: 'off', maxItems: null, requests: 'off', chatBits: null }));
});

test('every command the plan prints uses only flags its tool has (a flag that does not exist is never documented)', () => {
  const helps = new Map();
  const helpOf = (file) => {
    if (!helps.has(file)) {
      const r = spawnSync(process.execPath, [join(ROOT, file), '--help'], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, file + ' --help: ' + r.stderr);
      helps.set(file, r.stdout + r.stderr);
    }
    return helps.get(file);
  };
  let flagsChecked = 0;
  for (const answers of [FULL, {}, { features: { chat: 'open', requests: 'on' }, network: { tracker: ['wss://t.example'], stun: ['stun:s.example'] }, access: { writers: 'open' }, site: { ct: 'https://example.com/abuse' } }]) {
    for (const step of planInit(answers).steps) {
      const tokens = step.command.match(/'[^']*'|\S+/g).map((t) => t.replace(/^'|'$/g, ''));
      if (tokens[0] !== 'node') continue;
      const help = helpOf(tokens[1]);
      for (const t of tokens.slice(2)) {
        if (!/^--[a-z]/.test(t)) continue;
        flagsChecked++;
        assert.ok(help.includes(t), tokens[1] + ' has no ' + t + ' (' + step.id + ')');
      }
    }
  }
  assert.ok(flagsChecked > 40, 'only ' + flagsChecked + ' flags checked');
});

test('the answers are refused by the rules of the tools, all problems at once: no own tracker or STUN with chat on, items over 32, bits without requests', async () => {
  assert.throws(() => planInit({ features: { chat: 'members' } }), (e) => e instanceof UsageError && /--tracker/.test(e.message) && /--stun/.test(e.message));
  assert.throws(() => planInit({ features: { files: 'members' }, network: { tracker: ['wss://t.example'] } }), (e) => /--stun/.test(e.message) && !/--tracker <wss/.test(e.message));
  assert.throws(() => planInit({ features: { media: 'members' }, network: { tracker: ['wss://tracker.webtorrent.dev'], stun: ['stun:s.example'] } }), /--tracker/, 'a shared public tracker is not the own tracker');
  assert.throws(() => planInit({ widgets: { chatPanel: true } }), /chat is on/, 'the chat panel is chat');
  assert.throws(() => planInit({ features: { records: 'sealed', maxItems: 33 } }), /features\.maxItems is 1 to 32/);
  assert.throws(() => planInit({ features: { maxItems: 4 } }), /goes with features\.records 'sealed'/);
  assert.throws(() => planInit({ features: { chatBits: 20 } }), /goes with features\.requests 'on'/);
  assert.throws(() => planInit({ features: { chatBits: 33, requests: 'on' } }), /features\.chatBits is 0 to 32/);
  assert.throws(() => planInit({ features: { chat: 'everyone' } }), /features\.chat must be off, members, open/);
  assert.throws(() => planInit({ features: { files: 'open' } }), /features\.files must be off, members/);
  assert.throws(() => planInit({ identity: { org: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example'] } }), /at most 4/);
  assert.throws(() => planInit({ identity: { org: ['https://a.example/'] } }), /exact origin/);
  assert.throws(() => planInit({ identity: { ml: 'latest', idp: 'id.example' } }), (e) => /identity\.ml/.test(e.message) && /identity\.idp/.test(e.message), 'both problems are reported');
  assert.throws(() => planInit({ site: { scope: 'not a host' } }), /site\.scope/);
  assert.throws(() => planInit({ site: { mode: 'both' } }), /site\.mode/);
  assert.throws(() => planInit({ access: { writers: 'everyone' } }), /access\.writers/);
  assert.throws(() => planInit({ access: { moderators: ['nope'] } }), /access\.moderators/);
  assert.throws(() => planInit({ pin: { key: 'nope' } }), /pin\.key/);
  assert.throws(() => planInit({ age: 'child' }), /age is 'none'/);
  assert.throws(() => planInit({ network: { turn: ['http://insecure.example'] } }), /network\.turn/);
  assert.throws(() => planInit({ network: { stun: ['turn:wrong.example'] } }), /network\.stun/);
  assert.throws(() => planInit({ nonsense: 1 }), /nonsense is not a section/);
  assert.throws(() => planInit({ features: { chatt: 'members' } }), /features\.chatt is not a setting/, 'a misspelt setting is an error, not silently dropped');
  assert.throws(() => planInit([]), /must be a JSON object/);
  assert.throws(() => planInit({ features: 'members' }), /features must be an object/);
  try {
    planInit({ features: { chat: 'members', records: 'sealed', maxItems: 40 }, identity: { ml: 'x' } });
    assert.fail('should have refused');
  } catch (err) {
    assert.match(err.message, /the answers have \d+ problem\(s\)/);
    assert.ok((err.message.match(/\n {2}- /g) || []).length >= 3, 'every problem is listed');
  }
  const mod = await key();
  assert.doesNotThrow(() => planInit({ access: { moderators: [mod] }, pin: { key: mod }, age: mod }));
});

test('warnings: open writers without a contact, records with owner-only writing, requests without chat, a chat panel on a shell site', () => {
  assert.ok(planInit({ access: { writers: 'open' } }).warnings.some((w) => /writers=open without site\.ct/.test(w)));
  assert.ok(planInit({ access: { writers: 'open' }, site: { ct: 'mailto:a@b.example' } }).warnings.every((w) => !/without site\.ct/.test(w)));
  assert.ok(planInit({ features: { records: 'sealed' } }).warnings.some((w) => /Synced records need visitors to write/.test(w)));
  assert.ok(planInit({ features: { records: 'sealed' }, access: { writers: 'allow' } }).warnings.every((w) => !/Synced records need visitors/.test(w)));
  assert.ok(planInit({ features: { requests: 'on' } }).warnings.some((w) => /Message requests need chat/.test(w)));
  assert.ok(planInit({ widgets: { chatPanel: true }, network: { tracker: ['wss://t.example'], stun: ['stun:s.example'] } }).warnings.some((w) => /window\.mw/.test(w)));
  assert.ok(planInit({ features: { chat: 'open' }, network: { tracker: ['wss://t.example'], stun: ['stun:s.example'] } }).warnings.some((w) => /chat=open lets anyone/.test(w)));
  assert.ok(planInit({ pin: { mailbox: true } }).warnings.some((w) => /chat is off, so nothing will arrive/.test(w)));
});

test('shellQuote: plain arguments as they are, anything with a space or a quote in single quotes', () => {
  assert.equal(shellQuote('wss://t.example/x?y=1'), "'wss://t.example/x?y=1'", 'a question mark needs quotes');
  assert.equal(shellQuote('stun:stun.example:3478'), 'stun:stun.example:3478');
  assert.equal(shellQuote('Sign in'), "'Sign in'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('./site'), './site');
});

function scripted(answers) {
  const lines = [];
  const asked = [];
  let i = 0;
  return {
    asked,
    lines,
    say: (l) => lines.push(l),
    ask: async (prompt) => {
      asked.push(prompt);
      return i < answers.length ? answers[i++] : '';
    },
  };
}

test('the interview asks the table row by row, with defaults on Enter, and hands the answers to the planner', async () => {
  // Enter for everything: the defaults
  const defaults = await interview(scripted([]));
  assert.deepEqual(normalizeAnswers(defaults).features, normalizeAnswers({}).features);
  assert.equal(defaults.identity.nextKey, 'next-owner.pub', 'the default is to commit to a next key');
  // a full run
  const io = scripted([
    './forum', 'forum', 'forum.example', 'owner.jwk', 'dropin', 'allow', // site, mode, writers
    'members', 'members', 'members', // chat, files, media
    'sealed', '4', '500', // records, items, members
    'on', '20', // requests, bits
    'wss://rtc.forum.example', 'stun:stun.forum.example:3478', // own tracker and STUN
    'yes', 'turns:turn.forum.example:5349', 'static', // TURN
    'yes', 'yes', '', // pin mailbox, pin files, pin key
    'none', // age
    'yes', 'Sign in to Example Forum', // widget
    'yes', // chat panel
    'https://www.forum.example', // org
    'yes', 'next-owner.pub', // next key
  ]);
  const a = await interview(io);
  assert.equal(a.site.mode, 'dropin');
  assert.equal(a.access.writers, 'allow');
  assert.deepEqual(a.features, { chat: 'members', files: 'members', media: 'members', records: 'sealed', maxItems: 4, requests: 'on', chatBits: 20 });
  assert.deepEqual(a.network.tracker, ['wss://rtc.forum.example']);
  assert.deepEqual(a.network.stun, ['stun:stun.forum.example:3478']);
  assert.deepEqual(a.network.turn, ['turns:turn.forum.example:5349']);
  assert.equal(a.network.turnMode, 'static');
  assert.deepEqual(a.pin, { mailbox: true, files: true, key: null });
  assert.equal(a.widgets.signin, true);
  assert.equal(a.widgets.chatPanel, true);
  assert.equal(a.site.expectedMembers, 500);
  assert.deepEqual(a.identity.org, ['https://www.forum.example']);
  const plan = planInit(a);
  assert.ok(plan.steps.some((s) => s.id === 'cfg'));
  assert.ok(io.asked.some((q) => /Chat \(direct messages, rooms, groups\)/.test(q)));
  assert.ok(io.asked.some((q) => /Public file listings/.test(q)));
  assert.ok(io.asked.some((q) => /Private files and media/.test(q)));
  assert.ok(io.asked.some((q) => /Synced records/.test(q)));
  assert.ok(io.asked.some((q) => /Message requests/.test(q)));
  assert.ok(io.asked.some((q) => /OWN tracker|own tracker/i.test(q) || /Your tracker address/.test(q)));
  assert.ok(io.asked.some((q) => /Age method/.test(q)));
  // a bad answer is asked again
  const retry = scripted(['./s', 'bad name!', 'good-name']);
  const b = await interview(retry);
  assert.equal(b.site.name, 'good-name');
  assert.ok(retry.lines.some((l) => /use letters, digits/.test(l)));
  // chat on, the tracker answered wrongly first: asked again until both are given
  const loop = scripted(['./s', 'n', 'h.example', 'k.jwk', 'shell', 'owner', 'members', '', '', '', '', 'wss://tracker.webtorrent.dev', '', 'wss://own.example', 'stun:s.example']);
  const c = await interview(loop);
  assert.deepEqual(c.network.tracker, ['wss://own.example']);
  assert.ok(loop.lines.some((l) => /both are needed/.test(l)));
});

// 0.3.0 independence design (IND-12): for writers=open the contact prompt derives no mailto: for an address-bound scope (nip.io, sslip.io,
// an IP address): nobody receives mail at abuse@203-0-113-7.nip.io, and the contact would be signed into the pointer.
test('IND-12: an address-bound scope gets no derived mailto: default for the abuse contact; a named scope keeps it', async () => {
  const contactPrompt = (io) => io.asked.find((q) => /Abuse and legal contact/.test(q));
  for (const scope of ['203-0-113-7.nip.io', '203.0.113.7.sslip.io', '203.0.113.7']) {
    // Enter at the contact prompt: no contact, and the plan warns
    const io = scripted(['./s', 'n', scope, 'k.jwk', 'shell', 'open']);
    const a = await interview(io);
    assert.equal(a.site.ct, null, scope + ': no derived contact');
    const q = contactPrompt(io);
    assert.ok(q, scope + ': the contact is asked');
    assert.doesNotMatch(q, /\[mailto:/, scope + ': no default in brackets: ' + q);
    assert.doesNotMatch(q, /abuse@/, scope + ': ' + q);
    assert.match(q, /an https: page or a mailto: address you read/);
    assert.ok(q.includes(scope + ' cannot receive mail'), q);
    assert.ok(planInit(a).warnings.some((w) => /writers=open without site\.ct/.test(w)), scope + ': the plan warns about the missing contact');
    // a typed contact is taken; a malformed one is asked again
    const typed = scripted(['./s', 'n', scope, 'k.jwk', 'shell', 'open', 'abuse@example.org', 'https://example.org/contact']);
    const b = await interview(typed);
    assert.equal(b.site.ct, 'https://example.org/contact');
    assert.ok(typed.lines.some((l) => /an https: page or a mailto: address/.test(l)), 'the malformed answer is refused');
    const mail = await interview(scripted(['./s', 'n', scope, 'k.jwk', 'shell', 'open', 'mailto:owner@example.org']));
    assert.equal(mail.site.ct, 'mailto:owner@example.org');
    assert.ok(planInit(mail).steps.some((s) => s.command.includes('--ct mailto:owner@example.org')), 'the typed contact reaches publish');
  }
  // A named scope keeps today's default on Enter.
  const named = scripted(['./s', 'n', 'forum.example', 'k.jwk', 'shell', 'open']);
  const n = await interview(named);
  assert.equal(n.site.ct, 'mailto:abuse@forum.example');
  assert.match(contactPrompt(named), /^Abuse and legal contact \(https: or mailto: URL\) \[mailto:abuse@forum\.example\]: $/);
  // Owner-only writing asks no contact at all, as before.
  const owner = scripted(['./s', 'n', '203-0-113-7.nip.io', 'k.jwk', 'shell', 'owner']);
  assert.equal((await interview(owner)).site.ct, null);
  assert.equal(contactPrompt(owner), undefined);
});

function cli(args, opts = {}) {
  return spawnSync(process.execPath, ['tools/init.mjs', ...args], Object.assign({ cwd: ROOT, encoding: 'utf8' }, opts));
}

test('command line: --answers prints the plan, --json prints it as data, --save-answers writes the normalised answers; errors exit 2', () => {
  const file = join(work, 'answers.json');
  writeFileSync(file, JSON.stringify(FULL));
  const text = cli(['--answers', file]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /felinar init: 10 steps/);
  assert.match(text.stdout, /node tools\/ledger-admin\.mjs cfg --key owner\.jwk --file ledger\.json --chat members/);
  const json = cli(['--answers', file, '--json']);
  const data = JSON.parse(json.stdout);
  assert.equal(data.steps.length, 10);
  assert.ok(Array.isArray(data.warnings));
  const saved = join(work, 'saved.json');
  assert.equal(cli(['--answers', file, '--save-answers', saved]).status, 0);
  const again = JSON.parse(readFileSync(saved, 'utf8'));
  assert.equal(again.site.scope, 'forum.example');
  assert.equal(again.features.maxItems, 4);
  assert.deepEqual(planInit(again), planInit(FULL), 'the saved answers give the same plan');
  const bad = join(work, 'bad.json');
  writeFileSync(bad, JSON.stringify({ features: { chat: 'members' } }));
  const refused = cli(['--answers', bad]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--tracker/);
  writeFileSync(bad, '{ not json');
  assert.equal(cli(['--answers', bad]).status, 2);
  assert.equal(cli(['--answers', join(work, 'nothing.json')]).status, 2);
  assert.equal(cli([], { input: '' }).status, 2, 'no terminal and no answers file');
  assert.equal(cli(['extra']).status, 2);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  for (const flag of ['--answers', '--save-answers', '--json']) assert.ok(help.stdout.includes(flag), flag);
});
