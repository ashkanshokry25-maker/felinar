// Fuzz targets for the ledger side (V03-DESIGN-REVIEW 2.19, MF-43, MF-73, PEER A1):
//
//   gossip-decode   mw_chain1 frame codec: decode()/validFrame() against a model written from the spec
//                   arithmetic (n and c at most 64 MiB over the smallest block, -1 <= d < n + c, windows
//                   under ceil(that / 64), list maxima), with every numeric field driven to 0, -1, 2^53-1
//   gossip-handle   Gossip.handle() and tick() on a fake peer: no throw, no swallowed internal error
//                   (stats.errors), bounded output (a HELLO costs at most ceil(MAX_WINDOWS / 128) SYNC
//                   frames), every frame it sends decodes, a refused frame changes nothing
//   block-validate  validateBlock() on every op, re-hashed and re-signed after the mutation: numeric
//                   fields of the freeze group (policy caps, ban.until, checkpoint, bulk tombstone)
//   jcs-diff        RFC 8785 canonicalisation: src/chain/canonical.js against packages/verify/verify.js
//
// Shared code under test: src/chain/*.js (Node >= 22 and browsers).

import { isDeepStrictEqual } from 'node:util';

import {
  Rng, edgeNumber, lengthNear, Raw, spellings, stringify, numberPaths, getAt, setAt, clone, mutateBytes, concat, utf8, utf8Strict,
  describe, randomJson, ecdsaIdentity, fakePub, EDGE_MUST,
} from '../kit.mjs';
import {
  decode, encode, validFrame, Gossip, MSG, FRAME_MAX, MAX_LEDGER_BLOCKS, MAX_WINDOWS, MAX_SITE_LENGTH, DEFAULT_LIMITS, OWNER_KEY_RE,
  MIN_BLOCK_BYTES, EMPTY_DIGEST,
} from '../../../src/chain/gossip.js';
import { Dag, WINDOW_SIZE } from '../../../src/chain/dag.js';
import {
  createBlock, validateBlock, valueHash, SIG_PREFIX, rotateSigningInput,
} from '../../../src/chain/block.js';
import { hashEntry } from '../../../src/chain/pow.js';
import { sign, verify } from '../../../src/chain/crypto.js';
import { canonicalize, b64url } from '../../../src/chain/canonical.js';
import { jcs } from '../../../packages/verify/verify.js';

const SITE = 'mw1:fuzzgossip00000000000000000';
const T0 = 1800000000000 - (1800000000000 % 60000);

// ---------------------------------------------------------------------------------------------
// the model: the spec arithmetic, written out (not imported), so a drift in an exported constant is a finding
// ---------------------------------------------------------------------------------------------

const MODEL = Object.freeze({
  smallestBlock: 187, // bytes of the smallest valid block (MF-73, measured)
  maxChainBytesCeiling: 67108864,
  window: 64,
  maxHeads: 32,
  maxWant: 64,
  maxInv: 200,
  maxAnn: 200,
  maxSyncWindows: 128,
  frameMax: 15360,
  maxSite: 256,
});
const MODEL_MAX_BLOCKS = Math.floor(MODEL.maxChainBytesCeiling / MODEL.smallestBlock);
const MODEL_MAX_WINDOWS = Math.ceil(MODEL_MAX_BLOCKS / MODEL.window);

const HEX64 = /^[0-9a-f]{64}$/;
const isU = (x) => Number.isSafeInteger(x) && x >= 0;
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const hashList = (a, min, max) => Array.isArray(a) && a.length >= min && a.length <= max && a.every((h) => typeof h === 'string' && HEX64.test(h));

/** Does the model accept this parsed frame body of this type? */
export function modelAccepts(type, o) {
  switch (type) {
    case MSG.HELLO: {
      if (!isU(o.v) || typeof o.site !== 'string' || o.site.length < 1 || o.site.length > MODEL.maxSite) return false;
      if (!(o.owner === null || (typeof o.owner === 'string' && OWNER_KEY_RE.test(o.owner)))) return false;
      if (!isU(o.n) || o.n > MODEL_MAX_BLOCKS) return false;
      const c = o.c === undefined ? 0 : o.c;
      if (!isU(c) || o.n + c > MODEL_MAX_BLOCKS) return false;
      if (!Number.isSafeInteger(o.d) || o.d < -1 || o.d >= o.n + c) return false;
      return typeof o.root === 'string' && HEX64.test(o.root) && hashList(o.heads, 0, MODEL.maxHeads);
    }
    case MSG.WANT: return hashList(o.h, 1, MODEL.maxWant) && (o.v === undefined || typeof o.v === 'boolean');
    case MSG.BLOCKS: return Array.isArray(o.b) && o.b.length > 0 && o.b.every(isPlain);
    case MSG.ANN: return hashList(o.h, 1, MODEL.maxAnn);
    case MSG.SYNC:
      return Array.isArray(o.w) && o.w.length > 0 && o.w.length <= MODEL.maxSyncWindows &&
        o.w.every((x) => isPlain(x) && isU(x.k) && x.k < MODEL_MAX_WINDOWS && typeof x.dg === 'string' && HEX64.test(x.dg) && isU(x.n) && x.n <= MODEL_MAX_BLOCKS);
    case MSG.INV: return isU(o.k) && o.k < MODEL_MAX_WINDOWS && hashList(o.h, 0, MODEL.maxInv) && typeof o.more === 'boolean';
    default: return false;
  }
}

/** The model of decode(): { type, obj } or null, from the raw bytes. */
export function modelFrame(bytes) {
  if (bytes.length < 3 || bytes.length > MODEL.frameMax) return null;
  const type = bytes[0];
  if (type < 1 || type > 6) return null;
  let obj;
  try {
    obj = JSON.parse(utf8Strict.decode(bytes.subarray(1)));
  } catch (_) {
    return null;
  }
  if (!isPlain(obj)) return null;
  return modelAccepts(type, obj) ? { type, obj } : null;
}

/** Exported constants against the spec arithmetic: the problems, if any. */
export function constantProblems() {
  const p = [];
  const same = (name, got, want) => {
    if (got !== want) p.push('exported ' + name + ' is ' + got + ', the spec arithmetic gives ' + want);
  };
  same('MAX_LEDGER_BLOCKS', MAX_LEDGER_BLOCKS, MODEL_MAX_BLOCKS);
  same('MAX_WINDOWS', MAX_WINDOWS, MODEL_MAX_WINDOWS);
  same('MIN_BLOCK_BYTES', MIN_BLOCK_BYTES, MODEL.smallestBlock);
  same('WINDOW_SIZE', WINDOW_SIZE, MODEL.window);
  same('FRAME_MAX', FRAME_MAX, MODEL.frameMax);
  same('MAX_SITE_LENGTH', MAX_SITE_LENGTH, MODEL.maxSite);
  same('DEFAULT_LIMITS.maxHeads', DEFAULT_LIMITS.maxHeads, MODEL.maxHeads);
  same('DEFAULT_LIMITS.maxWant', DEFAULT_LIMITS.maxWant, MODEL.maxWant);
  same('DEFAULT_LIMITS.maxInv', DEFAULT_LIMITS.maxInv, MODEL.maxInv);
  same('DEFAULT_LIMITS.maxAnn', DEFAULT_LIMITS.maxAnn, MODEL.maxAnn);
  same('DEFAULT_LIMITS.maxSyncWindows', DEFAULT_LIMITS.maxSyncWindows, MODEL.maxSyncWindows);
  return p;
}

// ---------------------------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------------------------

function hashes(rng, n, pool) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool && pool.length && rng.chance(0.5) ? rng.pick(pool) : rng.hex(64));
  return out;
}

/** A valid body of a type. pool: known block hashes to refer to. */
function baseObject(rng, type, pool) {
  switch (type) {
    case MSG.HELLO: {
      const n = rng.pick([0, 1, 2, rng.int(2000), rng.int(MODEL_MAX_BLOCKS + 1)]);
      const c = rng.chance(0.3) ? rng.int(Math.min(1000, MODEL_MAX_BLOCKS - n) + 1) : undefined;
      const total = n + (c || 0);
      const o = {
        v: 1, site: SITE, owner: null, n, d: total === 0 ? -1 : rng.range(-1, total - 1), root: rng.hex(64), heads: hashes(rng, rng.int(33), pool),
      };
      if (rng.chance(0.15)) o.owner = 'p256:' + rng.b64(87);
      if (c !== undefined) o.c = c;
      return o;
    }
    case MSG.WANT: {
      const o = { h: hashes(rng, rng.range(1, 64), pool) };
      if (rng.chance(0.3)) o.v = rng.chance(0.5);
      return o;
    }
    case MSG.BLOCKS:
      return { b: Array.from({ length: rng.range(1, 4) }, () => ({ e: { v: 1, seq: rng.int(10), prev: [] }, h: rng.hex(64), s: rng.b64(86) })) };
    case MSG.ANN: return { h: hashes(rng, rng.range(1, 200), pool) };
    case MSG.SYNC: return { w: Array.from({ length: rng.range(1, 128) }, () => ({ k: rng.int(MODEL_MAX_WINDOWS), dg: rng.chance(0.2) ? EMPTY_DIGEST : rng.hex(64), n: rng.int(65) })) };
    default: return { k: rng.int(MODEL_MAX_WINDOWS), h: hashes(rng, rng.int(201), pool), more: rng.chance(0.5) };
  }
}

const LIST_FIELD = {
  [MSG.HELLO]: { path: ['heads'], min: 0, max: 32, make: (rng, pool) => hashes(rng, 1, pool)[0] },
  [MSG.WANT]: { path: ['h'], min: 1, max: 64, make: (rng, pool) => hashes(rng, 1, pool)[0] },
  [MSG.ANN]: { path: ['h'], min: 1, max: 200, make: (rng, pool) => hashes(rng, 1, pool)[0] },
  [MSG.INV]: { path: ['h'], min: 0, max: 200, make: (rng, pool) => hashes(rng, 1, pool)[0] },
  [MSG.SYNC]: { path: ['w'], min: 1, max: 128, make: (rng) => ({ k: rng.int(MODEL_MAX_WINDOWS), dg: rng.hex(64), n: rng.int(65) }) },
  [MSG.BLOCKS]: { path: ['b'], min: 1, max: 4, make: (rng) => ({ e: { v: 1 }, h: rng.hex(64), s: rng.b64(86) }) },
};

function setNumber(rng, type, o, label) {
  const raw = (v) => (typeof v === 'number' && Number.isFinite(v) && rng.chance(0.2) ? new Raw(spellings(rng, v)) : v);
  if (type === MSG.HELLO) {
    const key = rng.weighted([[4, 'n'], [4, 'd'], [3, 'c'], [1, 'v']]);
    const n = isU(o.n) ? o.n : 0;
    const limit = key === 'n' ? MODEL_MAX_BLOCKS : key === 'c' ? Math.max(0, MODEL_MAX_BLOCKS - n) : key === 'd' ? n + (isU(o.c) ? o.c : 0) : 1;
    const value = edgeNumber(rng, { limit });
    o[key] = raw(value);
    label.push('HELLO.' + key + '=' + (value instanceof Raw ? value.text : value));
  } else if (type === MSG.SYNC) {
    const w = o.w[rng.int(o.w.length)];
    const key = rng.pick(['k', 'n']);
    const value = edgeNumber(rng, { limit: key === 'k' ? MODEL_MAX_WINDOWS : MODEL_MAX_BLOCKS });
    w[key] = raw(value);
    label.push('SYNC.w.' + key + '=' + value);
  } else if (type === MSG.INV) {
    const value = edgeNumber(rng, { limit: MODEL_MAX_WINDOWS });
    o.k = raw(value);
    label.push('INV.k=' + value);
  } else {
    return false;
  }
  return true;
}

function setLength(rng, type, o, label) {
  const spec = LIST_FIELD[type];
  const list = getAt(o, spec.path);
  const want = lengthNear(rng, spec.max);
  if (want < list.length) list.length = want;
  else while (list.length < want && list.length < 4096) list.push(spec.make(rng, null));
  label.push(spec.path.join('.') + ' length ' + want);
}

function setField(rng, type, o, label) {
  const odd = () => rng.pick([null, true, false, [], {}, 'x', '', 1.5, -1, 0]);
  const k = rng.int(7);
  if (type === MSG.HELLO && k === 0) {
    o.site = rng.chance(0.5) ? rng.ascii(lengthNear(rng, MODEL.maxSite)) : rng.text(rng.int(8));
    label.push('HELLO.site length ' + o.site.length);
  } else if (type === MSG.HELLO && k === 1) {
    o.owner = rng.pick(['', 'p256', 'p256:', 'P256:abc', 'p256:' + rng.b64(240), 'p256:' + rng.b64(241), 'x'.repeat(17) + ':abc', 'ed25519:' + rng.b64(43), 'p256:a b', 'p256:\u00e9', undefined, odd()]);
    label.push('HELLO.owner ' + describe(o.owner, 40));
  } else if (type === MSG.HELLO && k === 2) {
    o.root = rng.pick([rng.hex(63), rng.hex(65), rng.hex(64).toUpperCase(), 'g'.repeat(64), '', odd()]);
    label.push('HELLO.root');
  } else if (k === 3) {
    const lists = [LIST_FIELD[type]].filter(Boolean);
    const spec = lists[0];
    if (spec && spec.path.length === 1 && Array.isArray(o[spec.path[0]]) && o[spec.path[0]].length > 0 && typeof o[spec.path[0]][0] === 'string') {
      const l = o[spec.path[0]];
      l[rng.int(l.length)] = rng.pick([rng.hex(63), rng.hex(65), rng.hex(64).toUpperCase(), '0x' + rng.hex(62), ' ' + rng.hex(63), odd()]);
      label.push('one hash spoiled');
    } else {
      o['zz'] = odd();
      label.push('unknown key');
    }
  } else if (k === 4) {
    const keys = Object.keys(o);
    if (keys.length) {
      const key = rng.pick(keys);
      delete o[key];
      label.push('drop ' + key);
    }
  } else if (k === 5) {
    const keys = Object.keys(o);
    const key = rng.pick(keys);
    o[key] = odd();
    label.push('type of ' + key + ' swapped');
  } else {
    o[rng.pick(['extra', 'v2', '__proto__', 'constructor'])] = odd();
    label.push('unknown key');
  }
}

/**
 * Every numeric field of the six frame types driven to 0, -1 and 2^53-1, once each, in a fixed order: the first inputs of
 * gossip-decode and gossip-handle (so the A1 class is covered whatever the seed and the budget). Random inputs follow.
 */
export const GOSSIP_SWEEP = [];
for (const [type, name, key] of [[MSG.HELLO, 'HELLO', 'v'], [MSG.HELLO, 'HELLO', 'n'], [MSG.HELLO, 'HELLO', 'd'], [MSG.HELLO, 'HELLO', 'c'],
  [MSG.SYNC, 'SYNC', 'w.k'], [MSG.SYNC, 'SYNC', 'w.n'], [MSG.INV, 'INV', 'k']]) {
  for (const value of EDGE_MUST) GOSSIP_SWEEP.push({ type, name: name + '.' + key, key, value });
}

/** The frame of one sweep entry: a valid body with that one field set (text and bytes as the wire would carry them). */
export function sweepFrame(rng, pool, entry) {
  const o = baseObject(rng, entry.type, pool);
  if (entry.type === MSG.SYNC) o.w[rng.int(o.w.length)][entry.key.split('.')[1]] = entry.value;
  else o[entry.key] = entry.value;
  return { label: 'sweep ' + entry.name + '=' + entry.value, bytes: concat(Uint8Array.of(entry.type), utf8.encode(JSON.stringify(o))) };
}

/** One frame: { label, bytes } (bytes is what decode() sees). pool: known block hashes. */
export function gossipFrame(rng, pool = null) {
  const type = rng.weighted([[5, MSG.HELLO], [2, MSG.WANT], [1, MSG.BLOCKS], [2, MSG.ANN], [3, MSG.SYNC], [3, MSG.INV]]);
  const o = baseObject(rng, type, pool);
  const label = [['', 'HELLO', 'WANT', 'BLOCKS', 'ANN', 'SYNC', 'INV'][type]];
  const r = rng.next();
  if (r < 0.1) label.push('valid');
  else if (r < 0.6) {
    if (!setNumber(rng, type, o, label)) setLength(rng, type, o, label);
  } else if (r < 0.78) setLength(rng, type, o, label);
  else setField(rng, type, o, label);
  let bytes = concat(Uint8Array.of(type), utf8.encode(stringify(o)));
  if (rng.chance(0.3)) {
    switch (rng.int(9)) {
      case 0: bytes[0] = rng.pick([0, 7, 255, rng.int(256)]); label.push('type byte'); break;
      case 1: bytes = bytes.slice(0, rng.pick([0, 1, 2, 3, bytes.length - 1, rng.int(bytes.length + 1)])); label.push('truncated'); break;
      case 2: bytes = concat(bytes, rng.bytes(rng.range(1, 64))); label.push('garbage appended'); break;
      case 3: {
        const at = rng.range(1, bytes.length);
        bytes = concat(bytes.slice(0, at), rng.pick([Uint8Array.of(0xff), Uint8Array.of(0xc0, 0x80), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xf4, 0x90, 0x80, 0x80), Uint8Array.of(0xe2, 0x82)]), bytes.slice(at));
        label.push('invalid UTF-8');
        break;
      }
      case 4: bytes = concat(Uint8Array.of(bytes[0], 0xef, 0xbb, 0xbf), bytes.slice(1)); label.push('BOM'); break;
      case 5: {
        const target = MODEL.frameMax + rng.pick([-2, -1, 0, 1, 2]);
        if (bytes.length < target) bytes = concat(bytes, utf8.encode(' '.repeat(target - bytes.length)));
        label.push('padded to ' + bytes.length);
        break;
      }
      case 6: bytes = mutateBytes(rng, bytes, { maxLen: MODEL.frameMax + 200 }); label.push('random byte mutations'); break;
      case 7: bytes = concat(Uint8Array.of(bytes[0]), utf8.encode(' \n\t'), bytes.slice(1), utf8.encode(' \n')); label.push('whitespace'); break;
      default: bytes = concat(Uint8Array.of(bytes[0]), utf8.encode('['.repeat(rng.range(1, 3000))), bytes.slice(1)); label.push('nesting');
    }
  }
  return { label: label.join(' '), bytes };
}

function asInput(rng, bytes) {
  // decode() takes any byte view; other things are not frames
  switch (rng.int(12)) {
    case 0: return { input: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), form: 'ArrayBuffer' };
    case 1: return { input: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), form: 'DataView' };
    case 2: return { input: rng.pick([undefined, null, 'string', {}, [1, 2, 3], 123, true, () => 1]), form: 'not bytes', none: true };
    default: return { input: bytes, form: 'Uint8Array' };
  }
}

export const GOSSIP_DECODE = {
  name: 'gossip-decode',
  about: 'mw_chain1 frame codec (decode, validFrame): HELLO, WANT, BLOCKS, ANN, SYNC, INV; n, c, d, k, lengths',
  gen(rng, state, i) {
    if (i < GOSSIP_SWEEP.length) {
      const f = sweepFrame(rng, null, GOSSIP_SWEEP[i]);
      return { label: f.label, bytes: f.bytes, input: f.bytes, i };
    }
    const f = gossipFrame(rng, null);
    const form = asInput(rng, f.bytes);
    return { label: f.label + (form.form === 'Uint8Array' ? '' : ' as ' + form.form), bytes: form.none ? null : f.bytes, input: form.input, i };
  },
  run(c) {
    return decode(c.input);
  },
  check(c, { result }) {
    const problems = [];
    if (c.i === 0) problems.push(...constantProblems());
    const want = c.bytes === null ? null : modelFrame(c.bytes);
    if (want === null && result !== null) problems.push('accepted a frame the model refuses: type ' + result.type);
    if (want !== null && result === null) problems.push('refused a frame the model accepts: type ' + want.type);
    if (want !== null && result !== null) {
      if (result.type !== want.type) problems.push('type ' + result.type + ', the model has ' + want.type);
      if (!isDeepStrictEqual(result.obj, want.obj)) problems.push('the decoded object differs from JSON.parse of the bytes');
      if (validFrame(result.type, result.obj) !== true) problems.push('validFrame refuses what decode accepted');
      let again = null;
      try {
        again = decode(encode(result.type, result.obj));
      } catch (err) {
        problems.push('encode of an accepted frame threw ' + err.message);
      }
      if (again === null || JSON.stringify(again.obj) !== JSON.stringify(result.obj)) problems.push('an accepted frame does not survive encode and decode');
    }
    return problems;
  },
  show: (c) => (c.bytes === null ? describe(c.input) : describe(c.bytes, 600)),
};

// ---------------------------------------------------------------------------------------------
// gossip-handle
// ---------------------------------------------------------------------------------------------

const MAX_SYNC_FRAMES = Math.ceil(MODEL_MAX_WINDOWS / MODEL.maxSyncWindows);

async function makeChain(identity, n) {
  const blocks = [];
  let prev = [];
  const add = async (op, value) => {
    const b = await createBlock({ identity, site: SITE, seq: blocks.length + 1, prev, op, value, ts: T0, bits: 0 });
    blocks.push(b);
    prev = [b.h];
  };
  await add({ t: 'policy', writers: 'open', bits: 0 });
  for (let i = 1; i < n; i++) await add({ t: 'put', k: 'k' + i }, { n: i });
  return blocks;
}

export const GOSSIP_HANDLE = {
  name: 'gossip-handle',
  about: 'Gossip.handle() and tick() on a fake peer: no throw, no swallowed error, bounded and well-formed output',
  maxMs: 1500,
  async setup() {
    const identity = await ecdsaIdentity();
    const blocks = await makeChain(identity, 7);
    return { identity, blocks, pool: blocks.map((b) => b.h) };
  },
  gen(rng, state, i) {
    if (i < GOSSIP_SWEEP.length) {
      const f = sweepFrame(rng, state.pool, GOSSIP_SWEEP[i]);
      return { label: f.label, held: rng.int(state.blocks.length + 1), helloFirst: rng.chance(0.5), steps: [f], ticks: 1, i };
    }
    const n = rng.weighted([[6, 1], [3, 2], [1, 4]]);
    const steps = [];
    for (let k = 0; k < n; k++) {
      if (rng.chance(0.15) && state.blocks.length) {
        // a BLOCKS frame with real blocks (some mutated in a numeric field of the entry)
        const take = state.blocks.slice(rng.int(state.blocks.length)).slice(0, rng.range(1, 3)).map((b) => clone(b));
        const label = ['BLOCKS real'];
        if (rng.chance(0.6)) {
          const b = rng.pick(take);
          const paths = numberPaths(b.e);
          if (paths.length) {
            const path = rng.pick(paths);
            setAt(b.e, path, edgeNumber(rng));
            label.push('e.' + path.join('.'));
          }
        }
        const bytes = concat(Uint8Array.of(MSG.BLOCKS), utf8.encode(JSON.stringify({ b: take })));
        steps.push({ label: label.join(' '), bytes });
      } else {
        steps.push(gossipFrame(rng, state.pool));
      }
    }
    return { label: steps.map((s) => s.label).join(' | '), held: rng.int(state.blocks.length + 1), helloFirst: rng.chance(0.6), steps, ticks: rng.int(3), i };
  },
  async run(c, state) {
    let t = 0;
    const dag = new Dag();
    for (let k = 0; k < c.held; k++) dag.add(state.blocks[k]);
    const sent = [];
    let closed = 0;
    const g = new Gossip({
      site: SITE,
      owner: null,
      dag,
      now: () => t,
      setTimeoutFn: () => null,
      clearTimeoutFn: () => {},
      getBlock: (h) => dag.get(h),
      ingest: async (blocks, peerId) => {
        const added = [];
        const rejected = [];
        for (const b of blocks) {
          const r = await validateBlock(b, { site: SITE });
          if (!r.ok) rejected.push({ h: b && typeof b.h === 'string' ? b.h : null, reason: r.reason });
          else if (!dag.has(b.h)) {
            dag.add(b, peerId);
            added.push(b.h);
          }
        }
        return { added, rejected };
      },
    });
    g.attach({ id: 'P', send: (u8) => sent.push(u8), close: () => { closed++; } });
    const perStep = [];
    if (c.helloFirst) {
      const hello = encode(MSG.HELLO, { v: 1, site: SITE, owner: null, n: state.blocks.length, d: state.blocks.length - 1, root: rootOf(state.blocks), heads: [state.pool[state.pool.length - 1]] });
      await g.handle('P', hello);
      t += 1000;
    }
    for (const step of c.steps) {
      const peerBefore = g.peerInfo('P');
      const helloBefore = peerBefore ? peerBefore.hello : null;
      const n0 = sent.length;
      await g.handle('P', step.bytes);
      const n1 = sent.length;
      t += 1000;
      g.tick();
      const peerAfter = g.peerInfo('P');
      perStep.push({
        handle: n1 - n0, tick: sent.length - n1, helloBefore, helloAfter: peerAfter ? peerAfter.hello : null, hadPeer: !!peerBefore, hasPeer: !!peerAfter,
      });
    }
    for (let k = 0; k < c.ticks; k++) {
      t += 31000;
      g.tick();
    }
    const out = { sent, stats: g.stats, perStep, closed, hasPeer: g.hasPeer('P') };
    g.destroy();
    return out;
  },
  check(c, { result }) {
    const problems = [];
    const r = result;
    if (r.stats.errors) problems.push('an internal error was swallowed ' + r.stats.errors + 'x (stats.errors)');
    for (let k = 0; k < r.sent.length; k++) {
      if (r.sent[k].length > FRAME_MAX) problems.push('sent a frame of ' + r.sent[k].length + ' bytes, over FRAME_MAX');
      else if (decode(r.sent[k]) === null) problems.push('sent a frame its own decoder refuses (type ' + r.sent[k][0] + ')');
    }
    for (let k = 0; k < c.steps.length; k++) {
      const model = modelFrame(c.steps[k].bytes);
      const st = r.perStep[k];
      if (model === null) {
        if (st.hadPeer && st.handle > 0) problems.push('a refused frame (step ' + k + ') was answered with ' + st.handle + ' frame(s)');
        if (st.hadPeer && st.hasPeer && !sameHello(st.helloBefore, st.helloAfter)) problems.push('a refused frame (step ' + k + ') changed the peer HELLO state');
        continue;
      }
      // a HELLO costs at most ceil(MAX_WINDOWS / 128) SYNC frames and a couple of others; no frame costs more than a full SYNC answer
      const bound = model.type === MSG.HELLO ? MAX_SYNC_FRAMES + 4 : MODEL.maxSyncWindows + 12;
      if (st.handle > bound) problems.push('step ' + k + ' (' + ['', 'HELLO', 'WANT', 'BLOCKS', 'ANN', 'SYNC', 'INV'][model.type] + ') was answered with ' + st.handle + ' frames, over the bound of ' + bound);
      if (st.tick > MODEL.maxSyncWindows + 12) problems.push('one tick sent ' + st.tick + ' frames');
    }
    for (const key of Object.keys(r.stats)) if (typeof r.stats[key] === 'number' && (!Number.isFinite(r.stats[key]) || r.stats[key] < 0)) problems.push('stats.' + key + ' is ' + r.stats[key]);
    return problems;
  },
  show: (c) => c.steps.map((s, k) => 'step ' + k + ' ' + describe(s.bytes, 160)).join(' || ') + ' [held ' + c.held + ', helloFirst ' + c.helloFirst + ', ticks ' + c.ticks + ']',
};

function sameHello(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rootOf(blocks) {
  const d = new Dag();
  for (const b of blocks) d.add(b);
  return d.root();
}

// ---------------------------------------------------------------------------------------------
// block-validate
// ---------------------------------------------------------------------------------------------

const REASONS = new Set(['shape', 'size', 'hash', 'pow', 'sig', 'op', 'limit', 'unknown-op', 'value-hash', 'value-size']);

async function blockFixtures() {
  const A = await ecdsaIdentity();
  const B = await ecdsaIdentity();
  const R = await ecdsaIdentity();
  return { A, B, R };
}

function entryOf(A, op, extra = {}) {
  return Object.assign({ v: 1, site: SITE, author: A.pub, seq: 1, prev: [], ts: T0, bits: 0, op, nonce: '' }, extra);
}

function opTemplates(rng, F) {
  const h = () => rng.hex(64);
  const sortedHeads = (n) => Array.from({ length: n }, () => h()).sort().filter((x, k, a) => k === 0 || a[k - 1] !== x);
  const next = F.B.pub;
  return [
    { name: 'policy', op: { t: 'policy', writers: 'allow', bits: 4, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [F.B.pub], allow: [F.B.pub], modAllowPerDay: 20, modActionsPerHour: 60, reservedPool: 25, voided: [{ author: F.B.pub, after: h() }] } },
    { name: 'owner', op: { t: 'owner', next } },
    { name: 'tombstone', op: { t: 'tombstone', h: h() } },
    { name: 'tombstone-bulk', op: { t: 'tombstone', authors: [F.B.pub, F.R.pub], before: h() } },
    { name: 'ban', op: { t: 'ban', author: F.B.pub } },
    { name: 'ban-until', op: { t: 'ban', author: F.B.pub, until: T0 + 86400000 } },
    { name: 'allow', op: { t: 'allow', add: [F.B.pub], remove: [F.R.pub] } },
    { name: 'unban', op: { t: 'unban', author: F.B.pub } },
    { name: 'keyinfo', op: { t: 'keyinfo', rc: b64url.encode(rng.bytes(32)) } },
    { name: 'rotate-self', op: { t: 'rotate', from: F.A.pub, next, by: 'self' } },
    { name: 'rotate-recover', recover: true, op: { t: 'rotate', from: F.A.pub, next, by: 'recover', rp: F.R.pub, rsig: '' }, author: 'B' },
    { name: 'checkpoint', op: { t: 'checkpoint', heads: sortedHeads(3), snap: h(), n: 5, bytes: 1000 } },
    { name: 'put', payload: true, op: { t: 'put', k: 'a' }, value: { a: 1 } },
    { name: 'append', payload: true, op: { t: 'append', l: 'list' }, value: 'x' },
    { name: 'profile', payload: true, op: { t: 'profile' }, value: 'Ash' },
  ];
}

/** Range rules of the numeric fields of an entry, from the spec (DESIGN-REVIEW 2.5.3, 2.10.1), written out. */
const RANGES = {
  'e.seq': { min: 0, max: MAX_SAFE_INT() },
  'e.ts': { min: 0, max: MAX_SAFE_INT(), step: 60000 },
  'e.bits': { min: 0, max: 256 },
  'op.bits': { min: 0, max: 32 },
  'op.maxValueBytes': { min: 0, max: 4096 },
  'op.maxChainBytes': { min: 0, max: 67108864 },
  'op.modAllowPerDay': { min: 0, max: 1000 },
  'op.modActionsPerHour': { min: 0, max: 100000 },
  'op.reservedPool': { min: 0, max: 50 },
  'op.until': { min: 0, max: MAX_SAFE_INT() },
  'op.n': { min: 1, max: MAX_SAFE_INT() },
  'op.bytes': { min: 0, max: MAX_SAFE_INT() },
};

function MAX_SAFE_INT() {
  return Number.MAX_SAFE_INTEGER;
}

const LISTS = {
  'op.heads': { min: 1, max: 32 },
  'op.authors': { min: 1, max: 64 },
  'op.moderators': { min: 0, max: 50 },
  'op.allow': { min: 0, max: 1000 },
  'op.voided': { min: 0, max: 50 },
  'e.prev': { min: 0, max: 8 },
};

function inRange(rule, v) {
  return Number.isSafeInteger(v) && v >= rule.min && v <= rule.max && (!rule.step || v % rule.step === 0);
}

async function forge(F, template, e, extras) {
  const author = template.author === 'B' ? F.B : F.A;
  const out = clone(e);
  if (template.recover && out.op && out.op.t === 'rotate' && out.op.by === 'recover') {
    const rsig = await sign(F.R.privateKey, rotateSigningInput(out.site, out.op.from, out.op.next));
    out.op.rsig = b64url.encode(rsig);
  }
  let hashHex;
  try {
    hashHex = (await hashEntry(out)).hashHex;
  } catch (_) {
    return { e: out, h: '0'.repeat(64), s: b64url.encode(new Uint8Array(64)), stale: true };
  }
  const s = b64url.encode(await sign(author.privateKey, SIG_PREFIX + hashHex));
  return Object.assign({ e: out, h: hashHex, s }, extras || {});
}

export const BLOCK_VALIDATE = {
  name: 'block-validate',
  about: 'validateBlock() on every op after a numeric or length mutation, re-hashed and re-signed: ranges of the freeze group',
  maxMs: 800,
  async setup() {
    const F = await blockFixtures();
    // every numeric field of every op (the entry's seq, ts and bits, and the numbers inside each op) at 0, -1 and 2^53-1, once each
    const sweep = [];
    for (const t of opTemplates(new Rng(1), F)) {
      const keys = [['e', 'seq'], ['e', 'ts'], ['e', 'bits']];
      for (const k of Object.keys(t.op)) if (typeof t.op[k] === 'number') keys.push(['op', k]);
      for (const [scope, key] of keys) for (const value of EDGE_MUST) sweep.push({ template: t.name, scope, key, value });
    }
    return { F, sweep };
  },
  async gen(rng, state, i) {
    const F = state.F;
    const forced = i < state.sweep.length ? state.sweep[i] : null;
    const templates = opTemplates(rng, F);
    const template = forced ? templates.find((t) => t.name === forced.template) : rng.pick(templates);
    const author = template.author === 'B' ? F.B : F.A;
    const e = entryOf(author, clone(template.op));
    let value = template.payload ? clone(template.value) : undefined;
    const label = [template.name];
    let verdict = 'accept'; // what the model says about the mutated block
    const kind = forced ? 'number' : rng.weighted([[6, 'number'], [3, 'list'], [template.payload ? 4 : 0, 'string'], [1, 'none']]);
    if (kind === 'number') {
      const keys = [];
      const opKeys = Object.keys(e.op).filter((k) => typeof e.op[k] === 'number');
      for (const k of ['seq', 'ts', 'bits']) keys.push(['e', k]);
      const [scope, key] = forced ? [forced.scope, forced.key] : opKeys.length && rng.chance(0.7) ? ['op', rng.pick(opKeys)] : rng.pick(keys);
      const rule = RANGES[scope + '.' + key];
      const value2 = forced ? forced.value : edgeNumber(rng, { limit: rule ? Math.min(rule.max, 1e9) : null });
      setAt(e, scope === 'e' ? [key] : ['op', key], value2);
      label.push(scope + '.' + key + '=' + value2);
      if (!rule) verdict = 'any';
      else if (!inRange(rule, value2)) verdict = 'refuse';
      else if (scope === 'e' && key === 'bits' && value2 > 0) verdict = 'any'; // a proof-of-work target the hash may miss
    } else if (kind === 'list') {
      const cands = [];
      for (const k of Object.keys(e.op)) if (Array.isArray(e.op[k]) && LISTS['op.' + k]) cands.push(['op', k]);
      cands.push(['e', 'prev']);
      const [scope, key] = rng.pick(cands);
      const spec = LISTS[scope + '.' + key];
      const list = scope === 'e' ? e.prev : e.op[key];
      const want = lengthNear(rng, spec.max);
      const maker = () => {
        if (key === 'voided') return { author: fakePub(rng), after: rng.hex(64) };
        if (key === 'heads' || key === 'prev') return rng.hex(64);
        return fakePub(rng);
      };
      while (list.length < want) list.push(maker());
      list.length = Math.min(list.length, want);
      if (key === 'heads' || key === 'prev') {
        list.sort();
        for (let k = list.length - 1; k > 0; k--) if (list[k] === list[k - 1]) list[k] = rng.hex(64);
        list.sort();
      }
      label.push(scope + '.' + key + ' length ' + want);
      if (want < spec.min || want > spec.max) verdict = 'refuse';
      else verdict = 'accept';
    } else if (kind === 'string') {
      const which = template.name;
      const unit = rng.pick(['a', '\u00e9', '\u20ac', '\ud83d\ude00']);
      const bytesOf = (str) => utf8.encode(str).length;
      if (which === 'put' || which === 'append') {
        const max = which === 'put' ? 256 : 64;
        const n = lengthNear(rng, max);
        const str = unit.repeat(Math.max(0, Math.ceil(n / bytesOf(unit))));
        e.op[which === 'put' ? 'k' : 'l'] = str;
        label.push('op key ' + bytesOf(str) + ' bytes');
        verdict = str.length === 0 || bytesOf(str) > max ? 'refuse' : 'accept';
      } else {
        const n = lengthNear(rng, 48);
        const str = unit.repeat(n);
        value = str;
        label.push('name of ' + n + ' code points');
        verdict = n > 48 ? 'refuse' : 'accept';
      }
      if (rng.chance(0.3)) {
        // the value cap: canonical(v) over maxValueBytes (2048) is refused; the block cap is 4096
        const n = lengthNear(rng, 2048);
        if (which === 'put' || which === 'append') {
          value = 'a'.repeat(n);
          label.push('value of ' + n + ' chars');
          verdict = verdict === 'refuse' ? 'refuse' : n + 2 > 2048 ? 'refuse' : 'accept';
        }
      }
    }
    let extras = null;
    if (template.payload) {
      const z = b64url.encode(rng.bytes(16));
      e.op.vh = await valueHash(value, z);
      extras = { v: value, z };
    }
    const block = await forge(F, template, e, extras);
    if (block.stale) verdict = 'any';
    // a block is at most 4096 bytes: canonical(e) + canonical(v) + the 22-character salt (a limit most list maxima cannot reach inside it)
    try {
      const size = utf8.encode(canonicalize(e)).length + (extras ? utf8.encode(canonicalize(extras.v)).length + 22 : 0);
      if (size > 4096) {
        verdict = 'refuse';
        label.push('block of ' + size + ' bytes');
      }
    } catch (_) {
      verdict = 'any';
    }
    if (rng.chance(0.12)) {
      block.h = rng.hex(64);
      label.push('stale hash');
      verdict = 'refuse'; // a wrong h is never valid
    }
    return { label: label.join(' '), input: block, verdict, template: template.name, i };
  },
  run: (c) => validateBlock(c.input, { site: SITE }),
  check(c, { result }) {
    const problems = [];
    if (!result || typeof result.ok !== 'boolean') return ['validateBlock returned ' + describe(result, 80)];
    if (result.ok === false && !REASONS.has(result.reason)) problems.push('refused with an unknown reason ' + describe(result.reason, 40));
    if (result.ok === true && c.verdict === 'refuse') problems.push('accepted a block the model refuses');
    if (result.ok === false && c.verdict === 'accept') problems.push('refused (' + result.reason + ') a block the model accepts');
    return problems;
  },
};

// ---------------------------------------------------------------------------------------------
// jcs-diff
// ---------------------------------------------------------------------------------------------

function attempt(fn, v) {
  try {
    return { ok: true, value: fn(v) };
  } catch (err) {
    return { ok: false, name: err && err.name };
  }
}

export const JCS_DIFF = {
  name: 'jcs-diff',
  about: 'RFC 8785: canonicalize() (src/chain/canonical.js) against jcs() (packages/verify), on random JSON',
  gen(rng, state, i) {
    const v = randomJson(rng);
    const wrap = rng.chance(0.5) ? { k: v, '\u00e9': rng.text(3), '\ufb33': 1, '\ud83d\ude00': 2, a: [v, v] } : v;
    return { label: 'random json', input: wrap, i };
  },
  run: (c) => ({ a: attempt(canonicalize, c.input), b: attempt(jcs, c.input) }),
  check(c, { result }) {
    const { a, b } = result;
    const problems = [];
    if (a.ok !== b.ok) problems.push('canonicalize ' + (a.ok ? 'accepts' : 'throws') + ' and jcs ' + (b.ok ? 'accepts' : 'throws'));
    else if (a.ok && a.value !== b.value) problems.push('canonicalize and jcs disagree: ' + describe(a.value, 120) + ' against ' + describe(b.value, 120));
    if (a.ok) {
      let back;
      try {
        back = JSON.parse(a.value);
      } catch (_) {
        problems.push('the canonical text does not parse');
      }
      if (back !== undefined && canonicalize(back) !== a.value) problems.push('canonical text is not a fixed point');
    }
    return problems;
  },
};

export const TARGETS = [GOSSIP_DECODE, GOSSIP_HANDLE, BLOCK_VALIDATE, JCS_DIFF];
