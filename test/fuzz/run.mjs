#!/usr/bin/env node
// test/fuzz/run.mjs: seeded mutation fuzzers for the parsers a peer, a page or a file can reach
// (V03-DESIGN-REVIEW 2.19, MF-43, MF-73, PEER A1). Not part of npm test: CI runs it with a short budget
// (npm run test:fuzz -- --iterations 3000 --seconds 90 --seed "$GITHUB_RUN_NUMBER"), a release with a longer
// one, and a developer runs it for as long as they like.
//
//   node test/fuzz/run.mjs [--target <name>]... [--iterations <n>] [--seconds <s>] [--seed <text>]
//                          [--max-ms <ms>] [--hang-ms <ms>] [--replay <n>] [--module <file>]...
//                          [--list] [--json] [--verbose] [--no-worker]
//
// Every target drives every numeric field of its input to 0, -1 and 2^53-1 (and the stated maximum and its
// neighbours, and random lengths) and asserts three things:
//   1. no undocumented throw escapes (a documented error type, such as a fileError or E_BENCODE, is fine),
//   2. each input is handled within --max-ms (a slow input is run a second time before it counts, so a
//      garbage-collection pause is not a failure), and a target that stops answering for --hang-ms is
//      killed and reported (each target runs in a worker thread, with a memory cap, for that reason),
//   3. input that is malformed by construction (a number outside its range, a list over its maximum) is
//      refused, never accepted; where the code under test has a second implementation or a stated model,
//      the two must agree.
//
// Inputs are a function of (seed, target, iteration): the seed is printed first, "--seed <s> --replay <n>"
// reruns input n of a target alone (add --verbose to see it), and a longer run extends a shorter one.
// The exit code is 1 when anything failed. Targets live in test/fuzz/targets/*.mjs (see targets.mjs).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { parseCli, runMain, isMain, UsageError, out } from '../../tools/lib.mjs';
import { Rng, hash32, describe } from './kit.mjs';
import { loadTargets } from './targets.mjs';

const USAGE = `
Usage: node test/fuzz/run.mjs [options]

Seeded mutation fuzzers (V03-DESIGN-REVIEW 2.19). Not part of npm test.

  --target <name>      run only this target (repeatable; a comma list works too); default: all
  --iterations <n>     inputs per target (default 2000)
  --seconds <s>        total wall-clock budget, shared by the targets still to run (default: none)
  --seed <text>        any text; the same seed gives the same inputs (default: from the clock, printed)
  --replay <n>         run only input n of each selected target (with --verbose it is printed)
  --max-ms <ms>        bound per input (default 500); a slow input is re-run before it counts
  --hang-ms <ms>       a target that makes no progress for this long is killed and reported (default 20000)
  --module <file>      load more targets from this module (repeatable; it exports TARGETS)
  --list               print the targets and exit
  --json               print one JSON report instead of text
  --verbose            print every target's line, and the input and result of a replayed input
  --no-worker          run in this thread (no hang or memory guard; for debugging)
`;

const DEFAULTS = { iterations: 2000, maxMs: 500, hangMs: 20000 };

// ---------------------------------------------------------------------------------------------
// running one target
// ---------------------------------------------------------------------------------------------

function errorLine(err) {
  if (!err || typeof err !== 'object') return String(err);
  const where = typeof err.stack === 'string' ? (err.stack.split('\n')[1] || '').trim() : '';
  const code = err.code ? ' [' + err.code + (err.reason ? '/' + err.reason : '') + ']' : '';
  return (err.name || 'Error') + code + ': ' + String(err.message).slice(0, 300) + (where ? ' ' + where : '');
}

async function attempt(target, c, state) {
  const t0 = performance.now();
  let outcome;
  try {
    outcome = { result: await target.run(c, state) };
  } catch (error) {
    outcome = { error };
  }
  return { outcome, ms: performance.now() - t0 };
}

function showInput(target, c) {
  try {
    return target.show ? String(target.show(c)).slice(0, 700) : describe(c && c.input !== undefined ? c.input : c, 700);
  } catch (err) {
    return '(could not print the input: ' + errorLine(err) + ')';
  }
}

/**
 * runTarget(target, { seed, from, to, deadline, maxMs, progress, maxViolations, onViolation, onCase })
 *   -> { name, inputs, violations, notes, maxMs, slowest, totalMs, stopped }
 * Inputs from..to-1 (iteration numbers). deadline: epoch ms after which no new input starts. progress:
 * an Int32Array on a SharedArrayBuffer; slot 0 holds the 1-based number of the input in progress, which a
 * watchdog reads. onViolation(v) is called as each violation is found; onCase(i, c, outcome, ms) per input.
 */
export async function runTarget(target, opts = {}) {
  const {
    seed = '0', from = 0, to = Infinity, deadline = null, maxMs = DEFAULTS.maxMs, progress = null,
    maxViolations = 20, onViolation = null, onCase = null,
  } = opts;
  const limit = target.maxMs || maxMs;
  const summary = { name: target.name, inputs: 0, violations: [], notes: {}, maxMs: 0, slowest: -1, totalMs: 0, stopped: 'done' };
  const report = (iteration, kind, message, c) => {
    const v = {
      target: target.name, seed: String(seed), iteration, kind, message,
      input: c === null || c === undefined ? '' : showInput(target, c),
    };
    summary.violations.push(v);
    if (onViolation) onViolation(v);
  };
  const noteFor = (iteration) => (id, message) => {
    const n = summary.notes[id] || (summary.notes[id] = { count: 0, example: String(message).slice(0, 300), iteration });
    n.count++;
  };
  let state;
  try {
    state = target.setup ? await target.setup({ seed: String(seed) }) : undefined;
  } catch (err) {
    report(-1, 'harness', 'setup failed: ' + errorLine(err), null);
    summary.stopped = 'setup-failed';
    return summary;
  }
  for (let i = from; i < to; i++) {
    if (deadline !== null && Date.now() >= deadline) {
      summary.stopped = 'deadline';
      break;
    }
    if (summary.violations.length >= maxViolations) {
      summary.stopped = 'violations';
      break;
    }
    if (progress) Atomics.store(progress, 0, i + 1);
    const rng = new Rng(hash32(seed, target.name, i));
    let c;
    try {
      c = await target.gen(rng, state, i);
    } catch (err) {
      report(i, 'harness', 'the generator threw: ' + errorLine(err), null);
      summary.inputs++;
      continue;
    }
    let { outcome, ms } = await attempt(target, c, state);
    let slow = false;
    if (ms > limit) {
      const again = await attempt(target, c, state);
      slow = again.ms > limit;
      ms = Math.min(ms, again.ms);
    }
    summary.inputs++;
    summary.totalMs += ms;
    if (ms > summary.maxMs) {
      summary.maxMs = ms;
      summary.slowest = i;
    }
    if (onCase) onCase(i, c, outcome, ms);
    if (slow) report(i, 'time', 'took ' + ms.toFixed(1) + ' ms twice, over the bound of ' + limit + ' ms (' + (c && c.label) + ')', c);
    if (outcome.error !== undefined) {
      let allowed = false;
      try {
        allowed = target.allowedError ? target.allowedError(outcome.error, c, state) === true : false;
      } catch (_) {
        allowed = false;
      }
      if (!allowed) {
        report(i, 'throw', 'an undocumented throw escaped: ' + errorLine(outcome.error) + ' (' + (c && c.label) + ')', c);
        continue;
      }
    }
    let problems;
    try {
      problems = target.check(c, outcome, state, noteFor(i)) || [];
    } catch (err) {
      report(i, 'harness', 'the oracle threw: ' + errorLine(err), c);
      continue;
    }
    for (const p of problems) report(i, 'check', String(p) + ' (' + (c && c.label) + ')', c);
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// a worker per target: a hang or a memory blow-up is a finding, not the end of the run
// ---------------------------------------------------------------------------------------------

function runInWorker(spec, onViolation) {
  const progress = new Int32Array(new SharedArrayBuffer(8));
  return new Promise((resolve) => {
    const violations = [];
    let summary = null;
    let settled = false;
    let lastSeen = -1;
    let lastChange = Date.now();
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: Object.assign({ fuzzWorker: true, progress }, spec),
      resourceLimits: { maxOldGenerationSizeMb: 1536 },
    });
    const partial = (stopped) => ({
      name: spec.target, inputs: Math.max(0, Atomics.load(progress, 0) - spec.from), violations, notes: {}, maxMs: 0, slowest: -1, totalMs: 0, stopped,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(result);
    };
    const poll = setInterval(() => {
      const cur = Atomics.load(progress, 0);
      if (cur !== lastSeen) {
        lastSeen = cur;
        lastChange = Date.now();
        return;
      }
      // loading the modules and building the fixtures (keys, valid frames) happen before the first input: allow them longer
      if (Date.now() - lastChange <= (cur === 0 ? Math.max(spec.hangMs, 30000) : spec.hangMs)) return;
      const at = cur - 1;
      const v = {
        target: spec.target, seed: String(spec.seed), iteration: at, kind: 'hang',
        message: 'no progress for ' + (at < 0 ? Math.max(spec.hangMs, 30000) : spec.hangMs) + ' ms ' + (at < 0 ? 'in setup' : 'in input ' + at) + '; the worker was killed',
        input: '',
      };
      violations.push(v);
      onViolation(v);
      worker.terminate();
      finish(partial('hang'));
    }, 250);
    worker.on('message', (m) => {
      if (m.type === 'violation') {
        violations.push(m.v);
        onViolation(m.v);
      } else if (m.type === 'done') {
        summary = m.summary;
      }
    });
    worker.on('error', (err) => {
      const at = Atomics.load(progress, 0) - 1;
      const v = {
        target: spec.target, seed: String(spec.seed), iteration: at, kind: 'crash',
        message: 'the worker died' + (at >= 0 ? ' in input ' + at : ' in setup') + ': ' + errorLine(err), input: '',
      };
      violations.push(v);
      onViolation(v);
      finish(partial('crash'));
    });
    worker.on('exit', () => {
      if (summary) {
        summary.violations = violations;
        finish(summary);
      } else {
        finish(partial('exit'));
      }
    });
  });
}

if (!isMainThread && workerData && workerData.fuzzWorker) {
  const w = workerData;
  const targets = await loadTargets({ modules: w.modules });
  const target = targets.find((t) => t.name === w.target);
  const summary = await runTarget(target, {
    seed: w.seed, from: w.from, to: w.to, deadline: w.deadline, maxMs: w.maxMs, progress: w.progress, maxViolations: w.maxViolations,
    onViolation: (v) => parentPort.postMessage({ type: 'violation', v }),
  });
  parentPort.postMessage({ type: 'done', summary });
}

// ---------------------------------------------------------------------------------------------
// the whole run
// ---------------------------------------------------------------------------------------------

/** Target names from --target values: repeatable, comma lists allowed; unknown names are a usage error. */
export function selectTargets(all, names) {
  const wanted = [];
  for (const n of names) for (const part of String(n).split(',')) if (part.trim()) wanted.push(part.trim());
  if (wanted.length === 0) return all.slice();
  const picked = [];
  for (const w of wanted) {
    const t = all.find((x) => x.name === w);
    if (!t) throw new UsageError('no fuzz target ' + JSON.stringify(w) + ' (known: ' + all.map((x) => x.name).join(', ') + ')');
    if (!picked.includes(t)) picked.push(t);
  }
  return picked;
}

function replayCommand(v) {
  return 'npm run test:fuzz -- --target ' + v.target + ' --seed ' + JSON.stringify(String(v.seed)).replace(/^"([A-Za-z0-9._-]+)"$/, '$1') + ' --replay ' + v.iteration;
}

/**
 * fuzz(options) -> { seed, results, violations, notes, inputs, elapsedMs, ok }
 * options: { seed, iterations, seconds, targets: [names], modules: [files], maxMs, hangMs, replay, verbose,
 *            worker (default true), log (line => void) }
 */
export async function fuzz(options = {}) {
  const {
    seed = String(Date.now() % 1000000000), iterations = DEFAULTS.iterations, seconds = 0, targets: names = [], modules = [],
    maxMs = DEFAULTS.maxMs, hangMs = DEFAULTS.hangMs, replay = null, verbose = false, worker = true, log = () => {},
  } = options;
  const all = await loadTargets({ modules });
  const picked = selectTargets(all, names);
  const started = Date.now();
  const report = { seed: String(seed), iterations, results: [], violations: [], notes: {}, inputs: 0, elapsedMs: 0, ok: true };
  log('fuzz seed=' + report.seed + ' iterations=' + (replay === null ? iterations : 'replay ' + replay) + ' targets=' + picked.length + (seconds ? ' budget=' + seconds + 's' : '') + ' max-ms=' + maxMs);
  const announce = (v) => {
    log('FAIL ' + v.target + ' #' + v.iteration + ' [' + v.kind + '] ' + v.message);
    if (v.input) log('     input:  ' + v.input);
    if (v.iteration >= 0) log('     replay: ' + replayCommand(v) + ' --verbose');
  };
  for (let k = 0; k < picked.length; k++) {
    const target = picked[k];
    const from = replay === null ? 0 : replay;
    const to = replay === null ? iterations : replay + 1;
    let deadline = null;
    if (seconds > 0 && replay === null) {
      const left = seconds * 1000 - (Date.now() - started);
      deadline = Date.now() + Math.max(250, left / (picked.length - k));
    }
    const base = { seed: report.seed, from, to, deadline, maxMs };
    let result;
    if (worker && replay === null) {
      result = await runInWorker(Object.assign({ target: target.name, modules, hangMs, maxViolations: 20 }, base), announce);
    } else {
      result = await runTarget(target, Object.assign({}, base, {
        onViolation: announce,
        onCase: replay !== null && verbose ? (i, c, outcome, ms) => {
          log('     input:  ' + showInput(target, c));
          log('     label:  ' + (c && c.label));
          log('     result: ' + (outcome.error !== undefined ? 'threw ' + errorLine(outcome.error) : describe(outcome.result, 500)) + ' (' + ms.toFixed(2) + ' ms)');
        } : null,
      }));
    }
    report.results.push(result);
    report.inputs += result.inputs;
    for (const v of result.violations) report.violations.push(v);
    for (const [id, n] of Object.entries(result.notes || {})) {
      const t = report.notes[id] || (report.notes[id] = { target: target.name, count: 0, example: n.example, iteration: n.iteration });
      t.count += n.count;
    }
    const line = '  ' + target.name.padEnd(18) + String(result.inputs).padStart(6) + ' inputs  ' + String(result.violations.length).padStart(3) +
      ' failed  max ' + result.maxMs.toFixed(1).padStart(7) + ' ms' + (result.stopped !== 'done' ? '  (' + result.stopped + ')' : '');
    if (verbose || result.violations.length > 0 || result.stopped !== 'done') log(line);
  }
  report.elapsedMs = Date.now() - started;
  report.ok = report.violations.length === 0;
  return report;
}

async function main(argv) {
  const { flags } = parseCli(argv, {
    target: { type: 'list' },
    iterations: { type: 'int', default: DEFAULTS.iterations },
    seconds: { type: 'int', default: 0 },
    seed: { type: 'string' },
    replay: { type: 'int' },
    'max-ms': { type: 'int', default: DEFAULTS.maxMs },
    'hang-ms': { type: 'int', default: DEFAULTS.hangMs },
    module: { type: 'list' },
    list: { type: 'boolean' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean' },
    worker: { type: 'boolean', default: true },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (flags.list) {
    const all = await loadTargets({ modules: flags.module });
    for (const t of all) out(t.name.padEnd(18) + t.about);
    return 0;
  }
  const lines = [];
  const log = flags.json ? (line) => lines.push(line) : out;
  const report = await fuzz({
    seed: flags.seed === null ? undefined : flags.seed,
    iterations: flags.iterations,
    seconds: flags.seconds,
    targets: flags.target,
    modules: flags.module,
    maxMs: flags.maxMs,
    hangMs: flags.hangMs,
    replay: flags.replay,
    verbose: flags.verbose,
    worker: flags.worker,
    log,
  });
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  for (const [id, n] of Object.entries(report.notes)) {
    out('note ' + id + ' (' + n.target + ', ' + n.count + 'x, first at #' + n.iteration + '): ' + n.example);
  }
  out((report.ok ? 'PASS' : 'FAIL') + ': ' + report.inputs + ' inputs in ' + (report.elapsedMs / 1000).toFixed(1) + ' s, ' +
    report.violations.length + ' violation(s), ' + Object.keys(report.notes).length + ' note(s), seed ' + report.seed);
  return report.ok ? 0 : 1;
}

if (isMainThread && isMain(import.meta.url)) runMain(main, USAGE);
