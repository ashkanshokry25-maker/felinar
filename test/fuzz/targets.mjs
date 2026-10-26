// test/fuzz/targets.mjs: the registry of fuzz targets (V03-DESIGN-REVIEW 2.19, MF-43). Every module in
// test/fuzz/targets/ exports TARGETS, an array of targets; a lane that owns a parser adds
// test/fuzz/targets/<lane>.mjs and needs no change here or in run.mjs. Not part of npm test.
//
// A target is a plain object:
//
//   name         unique, lowercase, dashes ("gossip-decode")
//   about        one line for --list
//   maxMs        optional per-input bound; the default is run.mjs --max-ms
//   setup        optional async ({ seed }) => state: fixtures built once per target (keys, valid frames)
//   gen          (rng, state, i) => c: one input, deterministic in (seed, name, i). c.label says what was
//                done to it; the rest of c is the target's business. Use test/fuzz/kit.mjs.
//   run          async (c, state) => result: the code under test. It may throw. It must not keep state
//                between calls, so a second call with the same c gives the same answer.
//   check        (c, outcome, state, note) => string[]: the oracle. outcome is { result } or { error };
//                each returned string is a violation. note(id, message) records an observation that is
//                not a failure (a difference between two implementations that is known and harmless).
//   allowedError optional (err, c, state) => boolean: a throw the code under test documents (a fileError,
//                an E_BENCODE). Any other throw is a violation, and so is a throw from run for an input
//                the code under test promises not to throw on (leave allowedError out).
//   show         optional (c) => string: the input as printed in a failure report
//
// What every target asserts (R 2.19): no undocumented throw escapes, each input is handled within a
// time bound, and an input that is malformed by construction (a number outside its range, a list over
// its maximum, a length that is not one of the allowed ones) is refused, never accepted.

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const TARGETS_DIR = fileURLToPath(new URL('./targets/', import.meta.url));

/** Throws a plain Error naming the file when `t` is not a usable target. */
export function validateTarget(t, source = 'target') {
  const bad = (m) => {
    throw new Error(source + ': ' + (t && t.name ? t.name + ': ' : '') + m);
  };
  if (!t || typeof t !== 'object') bad('not an object');
  if (typeof t.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(t.name)) bad('name must be lowercase letters, digits and dashes');
  if (typeof t.about !== 'string' || !t.about) bad('about is required');
  for (const fn of ['gen', 'run', 'check']) if (typeof t[fn] !== 'function') bad(fn + ' must be a function');
  for (const fn of ['setup', 'allowedError', 'show']) if (t[fn] !== undefined && typeof t[fn] !== 'function') bad(fn + ' must be a function');
  if (t.maxMs !== undefined && !(Number.isFinite(t.maxMs) && t.maxMs > 0)) bad('maxMs must be a positive number');
}

/** The target modules: test/fuzz/targets/*.mjs, then the extra modules (absolute or relative to the cwd). */
export function targetFiles(extra = []) {
  return readdirSync(TARGETS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => resolve(TARGETS_DIR, f))
    .concat(extra.map((m) => resolve(m)));
}

/** loadTargets({ modules }) -> every target, in file order. Throws on a duplicate name or a broken target. */
export async function loadTargets({ modules = [] } = {}) {
  const all = [];
  for (const file of targetFiles(modules)) {
    const mod = await import(pathToFileURL(file).href);
    if (!Array.isArray(mod.TARGETS)) throw new Error(file + ' does not export TARGETS');
    for (const t of mod.TARGETS) {
      validateTarget(t, file);
      if (all.some((x) => x.name === t.name)) throw new Error('duplicate fuzz target ' + t.name + ' (' + file + ')');
      all.push(t);
    }
  }
  return all;
}

