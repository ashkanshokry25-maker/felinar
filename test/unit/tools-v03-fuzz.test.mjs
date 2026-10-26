// Unit tests for the fuzz harness (test/fuzz/, V03-DESIGN-REVIEW 2.19, MF-43, MF-73): the registry, the replay rule (an input is a function of
// seed, target and iteration), the runner's verdicts (an undocumented throw, an oracle problem, a slow input, a hang, a note), the CLI, and
// that the targets find a bug when one is put back: the HELLO bounds removed from a scratch copy of src/ are reported by gossip-decode.
// The fuzz campaign itself is not part of npm test; these tests run a few dozen inputs of each target to keep the harness from rotting.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { fuzz, runTarget, selectTargets } from '../fuzz/run.mjs';
import { loadTargets, validateTarget, targetFiles } from '../fuzz/targets.mjs';
import { Rng, hash32, edgeNumber, lengthNear, stringify, Raw, numberPaths, setAt, describe, EDGE_MUST } from '../fuzz/kit.mjs';
import { constantProblems, modelFrame, modelAccepts, GOSSIP_SWEEP } from '../fuzz/targets/chain.mjs';
import { CHAT_SWEEP } from '../fuzz/targets/chat.mjs';
import { IDENTITY_SWEEP } from '../fuzz/targets/identity.mjs';
import { POINTER_SWEEP } from '../fuzz/targets/pointer.mjs';
import { FILES_SWEEP } from '../fuzz/targets/files.mjs';
import { ROOT } from '../../tools/lib.mjs';

const work = mkdtempSync(join(tmpdir(), 'mw-v03-fuzz-'));
after(() => rmSync(work, { recursive: true, force: true }));
const RUN = join(ROOT, 'test', 'fuzz', 'run.mjs');
const cli = (...args) => spawnSync(process.execPath, [RUN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

function synth(name, source) {
  const file = join(work, name + '.mjs');
  writeFileSync(file, source);
  return file;
}

test('the registry loads every module of test/fuzz/targets, with unique names and the whole contract', async () => {
  const all = await loadTargets();
  const names = all.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of all) validateTarget(t);
  // the brief: gossip HELLO and mw_chain1, chat frames, sign-in parseProof and the verifier, pointers, file validation
  for (const must of ['gossip-decode', 'gossip-handle', 'chat-frames', 'signin-parse', 'verify-package', 'pointer-parse', 'files-validate', 'bencode', 'block-validate']) {
    assert.ok(names.includes(must), 'target ' + must);
  }
  assert.ok(targetFiles().every((f) => f.endsWith('.mjs')));
  assert.throws(() => validateTarget({ name: 'Bad Name', about: 'x', gen() {}, run() {}, check() {} }), /lowercase/);
  assert.throws(() => validateTarget({ name: 'x', about: '', gen() {}, run() {}, check() {} }), /about/);
  assert.throws(() => validateTarget({ name: 'x', about: 'y', gen() {}, run() {} }), /check/);
  const dup = synth('dup', "export const TARGETS = [{ name: 'gossip-decode', about: 'x', gen() {}, run() {}, check() {} }];\n");
  await assert.rejects(loadTargets({ modules: [dup] }), /duplicate fuzz target gossip-decode/);
  const noExport = synth('noexport', 'export const x = 1;\n');
  await assert.rejects(loadTargets({ modules: [noExport] }), /does not export TARGETS/);
  assert.throws(() => selectTargets(all, ['nope']), /no fuzz target "nope"/);
  assert.deepEqual(selectTargets(all, ['bencode,pointer-parse', 'bencode']).map((t) => t.name), ['bencode', 'pointer-parse']);
});

test('an input is a function of the seed, the target and the iteration, so one input replays alone', async () => {
  const all = await loadTargets();
  for (const target of all) {
    const seen = new Map();
    await runTarget(target, { seed: 'replay-1', from: 0, to: 12, maxMs: 5000, onCase: (i, c) => seen.set(i, c.label) });
    for (const i of [0, 5, 11]) {
      let again = null;
      await runTarget(target, { seed: 'replay-1', from: i, to: i + 1, maxMs: 5000, onCase: (k, c) => { again = c.label; } });
      assert.equal(again, seen.get(i), target.name + ' #' + i);
    }
    let other = null;
    await runTarget(target, { seed: 'replay-2', from: 3, to: 4, maxMs: 5000, onCase: (k, c) => { other = c.label; } });
    // most targets differ across seeds; a label can coincide, the rng must not
    assert.notEqual(new Rng(hash32('replay-1', target.name, 3)).next(), new Rng(hash32('replay-2', target.name, 3)).next());
    assert.ok(typeof other === 'string');
  }
});

test('a short seeded run of every target finds nothing (the campaign is longer; this keeps the harness from rotting)', async () => {
  const lines = [];
  const report = await fuzz({ seed: 'unit-1', iterations: 60, worker: false, maxMs: 3000, log: (l) => lines.push(l) });
  assert.equal(report.ok, true, lines.join('\n'));
  assert.equal(report.violations.length, 0);
  assert.ok(report.inputs >= 60 * 15, 'inputs ' + report.inputs);
  assert.match(lines[0], /^fuzz seed=unit-1 iterations=60 targets=\d+ max-ms=3000/);
});

test('the first inputs of the required targets drive every numeric field to 0, -1 and 2^53-1, whatever the seed (PEER A1, MF-43, MF-73)', async () => {
  const all = await loadTargets();
  const labelsOf = async (name, n, seed) => {
    const out = [];
    await runTarget(all.find((t) => t.name === name), { seed, from: 0, to: n, maxMs: 5000, onCase: (i, c) => out.push(c.label) });
    return out;
  };
  const MAX = String(Number.MAX_SAFE_INTEGER);
  const values = ['0', '-1', MAX];
  const need = (labels, needle, where) => assert.ok(labels.some((l) => l.includes(needle)), where + ': no input with ' + needle);
  for (const seed of ['a', 'zz']) {
    for (const name of ['gossip-decode', 'gossip-handle']) {
      const labels = await labelsOf(name, GOSSIP_SWEEP.length, seed);
      for (const f of ['HELLO.v', 'HELLO.n', 'HELLO.d', 'HELLO.c', 'SYNC.w.k', 'SYNC.w.n', 'INV.k']) for (const v of values) need(labels, 'sweep ' + f + '=' + v, name);
    }
    const chat = await labelsOf('chat-frames', CHAT_SWEEP.length, seed);
    for (const f of ['HELLO.v', 'ROOM.t', 'CK.v', 'CK.epoch', 'CK.exp']) for (const v of values) need(chat, f + '=' + v, 'chat-frames');
    for (const f of ['version', 'hop', 'flags']) assert.ok(chat.filter((l) => l.includes('sweep') && l.includes(f + ' ')).length >= 13 * 2, 'chat-frames sweeps ' + f + ' for all 13 types');
    for (const name of ['signin-parse', 'verify-package']) {
      const labels = await labelsOf(name, IDENTITY_SWEEP.length, seed);
      for (const f of ['c.v', 'c.iat', 'c.nbf', 'c.exp']) for (const v of values) for (const form of ['text', 'object']) need(labels.filter((l) => l.includes(' ' + form + ' ')), f + '=' + v, name + ' ' + form);
    }
    const pointer = await labelsOf('pointer-parse', POINTER_SWEEP.length, seed);
    for (const f of ['seq', 'exp', 'max']) for (const v of values) need(pointer, f + '="' + v + '"', 'pointer-parse');
    const files = await labelsOf('files-validate', FILES_SWEEP.length, seed);
    for (const f of ['length', 'piece length']) for (const v of values) for (const mode of ['info', 'torrent']) need(files.filter((l) => l.includes('sweep ' + mode)), f + '=' + v, 'files-validate ' + mode);
    const state = await all.find((t) => t.name === 'block-validate').setup({ seed });
    const blocks = await labelsOf('block-validate', state.sweep.length, seed);
    for (const op of ['policy', 'put', 'ban-until', 'tombstone-bulk', 'checkpoint', 'rotate-recover']) for (const f of ['e.seq', 'e.ts', 'e.bits']) for (const v of values) need(blocks, op + ' ' + f + '=' + v, 'block-validate');
    for (const f of ['op.bits', 'op.maxValueBytes', 'op.maxChainBytes', 'op.modAllowPerDay', 'op.modActionsPerHour', 'op.reservedPool']) for (const v of values) need(blocks, 'policy ' + f + '=' + v, 'block-validate');
    for (const v of values) { need(blocks, 'ban-until op.until=' + v, 'block-validate'); need(blocks, 'checkpoint op.n=' + v, 'block-validate'); need(blocks, 'checkpoint op.bytes=' + v, 'block-validate'); }
  }
});

test('the exported constants agree with the spec arithmetic written out in the targets', () => {
  assert.deepEqual(constantProblems(), []);
  // the model itself: the A1 frame (d = 2e10) and the 2^53-1 numbers are refused, a sane HELLO is accepted
  const hello = { v: 1, site: 'mw1:x', owner: null, n: 10, d: 9, root: 'a'.repeat(64), heads: [] };
  assert.equal(modelAccepts(1, hello), true);
  for (const bad of [{ d: 2e10 }, { d: Number.MAX_SAFE_INTEGER }, { n: Number.MAX_SAFE_INTEGER }, { n: -1 }, { d: 10 }, { d: -2 }, { c: Number.MAX_SAFE_INTEGER }, { c: 358869 }]) {
    assert.equal(modelAccepts(1, Object.assign({}, hello, bad)), false, JSON.stringify(bad));
  }
  assert.equal(modelFrame(new Uint8Array([1, 0x7b, 0x7d])), null);
  assert.equal(modelFrame(new Uint8Array([9, 0x7b, 0x7d, 0x20])), null);
});

test('the kit: edge numbers start with 0, -1 and 2^53-1, lengths straddle a maximum, Raw spells a number as given', () => {
  assert.deepEqual(Array.from(EDGE_MUST), [0, -1, Number.MAX_SAFE_INTEGER]);
  const rng = new Rng(7);
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(edgeNumber(rng, { limit: 64 }));
  for (const must of [0, -1, Number.MAX_SAFE_INTEGER, 63, 64, 65]) assert.ok(seen.has(must), 'edge ' + must);
  const lens = new Set();
  for (let i = 0; i < 400; i++) lens.add(lengthNear(rng, 32));
  for (const must of [0, 1, 31, 32, 33]) assert.ok(lens.has(must), 'length ' + must);
  assert.equal(stringify({ a: new Raw('01'), b: [new Raw('1e999')], c: 'x' }), '{"a":01,"b":[1e999],"c":"x"}');
  const o = { a: 1, b: [2, { c: 3 }], d: 'x' };
  assert.deepEqual(numberPaths(o), [['a'], ['b', 0], ['b', 1, 'c']]);
  setAt(o, ['b', 1, 'c'], -1);
  assert.equal(o.b[1].c, -1);
  assert.match(describe(new Uint8Array([1, 2, 255])), /hex:0102ff \(3 bytes\)/);
  assert.equal(describe({ n: 5n, u: new Uint8Array([1]), x: NaN }), '{"n":"5n","u":"u8:01","x":"NaN"}');
  const shuffled = new Rng(3).shuffle([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(shuffled.slice().sort(), [1, 2, 3, 4, 5, 6]);
});

test('the runner reports an undocumented throw, an oracle problem, a slow input twice, and records notes without failing', async () => {
  const file = synth('verdicts', `
    export const TARGETS = [
      { name: 'v-throw', about: 'throws on 3 and 10', gen: (rng, s, i) => ({ label: 'i' + i, input: i }),
        run: async (c) => { if (c.input === 3) throw new RangeError('boom'); if (c.input === 10) { const e = new Error('documented'); e.code = 'E_OK'; throw e; } return 1; },
        allowedError: (e) => e.code === 'E_OK', check: () => [] },
      { name: 'v-check', about: 'oracle problem on 4', gen: (rng, s, i) => ({ label: 'i' + i, input: i }), run: async (c) => c.input, check: (c, o) => (o.result === 4 ? ['four'] : []) },
      { name: 'v-slow', about: 'slow on 2', maxMs: 15, gen: (rng, s, i) => ({ label: 'i' + i, input: i }),
        run: async (c) => { const t = Date.now(); while (Date.now() - t < (c.input === 2 ? 40 : 0)); return 1; }, check: () => [] },
      { name: 'v-once', about: 'slow only the first time', maxMs: 15, gen: (rng, s, i) => ({ label: 'i' + i, input: i }),
        run: async (c) => { globalThis.__fuzzOnce = (globalThis.__fuzzOnce || 0) + 1; const t = Date.now(); while (Date.now() - t < (globalThis.__fuzzOnce === 1 ? 40 : 0)); return 1; }, check: () => [] },
      { name: 'v-note', about: 'notes', gen: (rng, s, i) => ({ label: 'i' + i, input: i }), run: async (c) => c.input, check: (c, o, s, note) => { if (c.input % 2) note('odd', 'odd ' + c.input); return []; } },
      { name: 'v-harness', about: 'a broken oracle', gen: (rng, s, i) => ({ label: 'i' + i, input: i }), run: async () => 1, check: () => { throw new Error('bad oracle'); } },
    ];
  `);
  const report = await fuzz({ seed: 's', iterations: 12, modules: [file], targets: ['v-throw', 'v-check', 'v-slow', 'v-once', 'v-note', 'v-harness'], worker: false, log: () => {} });
  const by = (name) => report.violations.filter((v) => v.target === name);
  assert.deepEqual(by('v-throw').map((v) => [v.iteration, v.kind]), [[3, 'throw']]);
  assert.match(by('v-throw')[0].message, /RangeError: boom/);
  assert.deepEqual(by('v-check').map((v) => [v.iteration, v.kind, v.message.slice(0, 4)]), [[4, 'check', 'four']]);
  assert.deepEqual(by('v-slow').map((v) => [v.iteration, v.kind]), [[2, 'time']]);
  assert.equal(by('v-once').length, 0, 'a one-off slow input is run again before it counts');
  assert.equal(by('v-note').length, 0);
  assert.equal(report.notes.odd.count, 6);
  assert.equal(report.notes.odd.target, 'v-note');
  assert.equal(by('v-harness').length, 12);
  assert.ok(by('v-harness').every((v) => v.kind === 'harness'));
  assert.equal(report.ok, false);
  for (const v of report.violations) assert.equal(v.seed, 's');
});

test('a target that stops answering is killed and reported with its input number; a seconds budget ends a run', async () => {
  const file = synth('hang', `
    export const TARGETS = [
      { name: 'h-hang', about: 'hangs on 4', gen: (rng, s, i) => ({ label: 'i' + i, input: i }), run: async (c) => { if (c.input === 4) for (;;); return 1; }, check: () => [] },
      { name: 'h-ok', about: 'fine', gen: (rng, s, i) => ({ label: 'i' + i, input: i }), run: async (c) => c.input, check: () => [] },
    ];
  `);
  const t0 = Date.now();
  const report = await fuzz({ seed: 'h', iterations: 50, modules: [file], targets: ['h-hang', 'h-ok'], hangMs: 700, log: () => {} });
  assert.ok(Date.now() - t0 < 20000);
  const hang = report.violations.filter((v) => v.kind === 'hang');
  assert.equal(hang.length, 1);
  assert.equal(hang[0].target, 'h-hang');
  assert.equal(hang[0].iteration, 4);
  assert.match(hang[0].message, /no progress for 700 ms in input 4/);
  assert.equal(report.results.find((r) => r.name === 'h-ok').inputs, 50, 'the next target still runs');
  // --seconds: a run that could take for ever ends at the budget
  const t1 = Date.now();
  const timed = await fuzz({ seed: 'b', iterations: 1e9, seconds: 1, targets: ['jcs-diff'], worker: false, log: () => {} });
  assert.ok(Date.now() - t1 < 6000, 'ended at the budget');
  assert.equal(timed.results[0].stopped, 'deadline');
  assert.ok(timed.results[0].inputs > 10);
});

test('the CLI: seed printed first, replay reruns one input, exit 1 on a violation, --list and --help', () => {
  const ok = cli('--target', 'jcs-diff,bencode', '--iterations', '25', '--seed', '77');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.match(lines[0], /^fuzz seed=77 iterations=25 targets=2/);
  assert.match(lines[lines.length - 1], /^PASS: 50 inputs in .* 0 violation\(s\).* seed 77$/);

  const file = synth('cli-fail', "export const TARGETS = [{ name: 'c-fail', about: 'fails on 6', gen: (rng, s, i) => ({ label: 'i' + i, input: i }), run: async (c) => c.input, check: (c, o) => (o.result === 6 ? ['six'] : []) }];\n");
  const bad = cli('--module', file, '--target', 'c-fail', '--iterations', '10', '--seed', 'abc');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL c-fail #6 \[check\] six/);
  assert.match(bad.stdout, /replay: npm run test:fuzz -- --target c-fail --seed abc --replay 6 --verbose/);
  const replay = cli('--module', file, '--target', 'c-fail', '--seed', 'abc', '--replay', '6', '--verbose');
  assert.equal(replay.status, 1);
  assert.match(replay.stdout, /input:  6/);
  assert.match(replay.stdout, /label:  i6/);
  const fine = cli('--module', file, '--target', 'c-fail', '--seed', 'abc', '--replay', '5');
  assert.equal(fine.status, 0);

  const json = cli('--module', file, '--target', 'c-fail', '--iterations', '10', '--seed', 'abc', '--json');
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.violations[0].iteration, 6);

  const list = cli('--list');
  assert.equal(list.status, 0);
  assert.match(list.stdout, /^gossip-decode /m);
  assert.match(list.stdout, /^verify-package /m);

  const help = cli('--help');
  for (const flag of ['--target', '--iterations', '--seconds', '--seed', '--replay', '--max-ms', '--hang-ms', '--module', '--list', '--json', '--verbose', '--no-worker']) {
    assert.ok(help.stdout.includes(flag), 'help names ' + flag);
  }
  const unknown = cli('--target', 'nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no fuzz target "nope"/);
  assert.equal(cli('--bogus').status, 2);
});

test('the workflows call the fuzzer with flags it has, and a seed per run', () => {
  const help = cli('--help').stdout;
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = readFileSync(join(ROOT, file), 'utf8').replace(/\\\n\s*/g, ' ');
    const calls = text.split('\n').filter((l) => /test:fuzz/.test(l) && /npm run/.test(l));
    assert.ok(calls.length >= 1, file + ' runs the fuzzer');
    for (const line of calls) {
      for (const [flag] of line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) assert.ok(flag === '--' || help.includes(flag), file + ': ' + flag);
      assert.match(line, /--seed "\$GITHUB_RUN_NUMBER"/, file + ' seeds with the run number');
      assert.match(line, /--seconds \d+/, file + ' bounds the time');
    }
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:fuzz'], 'node test/fuzz/run.mjs');
  assert.ok(!/fuzz/.test(pkg.scripts.test + pkg.scripts['test:unit']), 'the fuzzer is not part of npm test');
});

test('the fuzzer finds a bug when one is put back: the HELLO bounds (MF-73) removed from a copy of src/ are reported by gossip-decode', () => {
  const tree = join(work, 'scratch-tree');
  mkdirSync(join(tree, 'tools'), { recursive: true });
  mkdirSync(join(tree, 'test'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(tree, 'src'), { recursive: true });
  cpSync(join(ROOT, 'packages'), join(tree, 'packages'), { recursive: true });
  cpSync(join(ROOT, 'test', 'fuzz'), join(tree, 'test', 'fuzz'), { recursive: true });
  cpSync(join(ROOT, 'tools', 'lib.mjs'), join(tree, 'tools', 'lib.mjs'));
  cpSync(join(ROOT, 'package.json'), join(tree, 'package.json'));
  const gossip = join(tree, 'src', 'chain', 'gossip.js');
  const source = readFileSync(gossip, 'utf8');
  const patched = source
    .replace('if (!o || !isUint(o.n) || o.n > MAX_LEDGER_BLOCKS) return false;', 'if (!o || !isUint(o.n)) return false;')
    .replace('if (!isUint(c) || o.n + c > MAX_LEDGER_BLOCKS) return false;\n  return Number.isSafeInteger(o.d) && o.d >= -1 && o.d < o.n + c;', 'if (!isUint(c)) return false;\n  return Number.isSafeInteger(o.d) && o.d >= -1;');
  assert.notEqual(patched, source, 'the patch applied');
  writeFileSync(gossip, patched);
  const r = spawnSync(process.execPath, [join(tree, 'test', 'fuzz', 'run.mjs'), '--target', 'gossip-decode', '--iterations', '400', '--seed', '1', '--no-worker'], { cwd: tree, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /accepted a frame the model refuses: type 1/);
  assert.match(r.stdout, /replay: npm run test:fuzz -- --target gossip-decode --seed 1 --replay \d+ --verbose/);
  // the same tree, unpatched, passes
  writeFileSync(gossip, source);
  const clean = spawnSync(process.execPath, [join(tree, 'test', 'fuzz', 'run.mjs'), '--target', 'gossip-decode', '--iterations', '400', '--seed', '1', '--no-worker'], { cwd: tree, encoding: 'utf8', timeout: 120000 });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});
