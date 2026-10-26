// Fuzz targets for sign-in proofs (docs/specs/mw-signin-v1.md, V03-DESIGN-REVIEW 2.19, MF-43):
//
//   signin-parse    src/identity/signin.js parseProof(): a proof as JSON text (strict, duplicate keys refused) and as
//                   an object; every number (v, iat, nbf, exp) driven to 0, -1, 2^53-1 and other edges, every string
//                   to lengths around its maximum, lists over their maximum, missing and extra keys, the 4 KiB
//                   limit to the byte. The standalone verifier (packages/verify) is asked the same question and the
//                   two are compared.
//   verify-package  packages/verify createVerifier().verify(): the same mutations, re-signed so the signature is
//                   valid for the changed claims, against a model of the time window (age at most 300 s, skew
//                   120 s), the nonce (issued or stateless, consumed once) and the replay rule
//
// A mutation carries what the spec says about it: accept, refuse (malformed by construction) or any. Differences
// between parseProof and the verifier that are known and harmless are notes, not failures.

import {
  Rng, edgeNumber, lengthNear, Raw, spellings, stringify, mutateBytes, concat, utf8, describe, ecdsaIdentity, nested, B64CH, EDGE_MUST,
} from '../kit.mjs';
import { parseProof, KEY_MODES, CHALLENGE_FIELDS, MAX_PROOF_BYTES, MAX_RESOURCES, MAX_STATEMENT_CHARS } from '../../../src/identity/signin.js';
import { sign } from '../../../src/chain/crypto.js';
import { canonicalize, b64url } from '../../../src/chain/canonical.js';
import { createVerifier, MemoryNonceStore, statelessNonce, issueChallenge } from '../../../packages/verify/verify.js';

const NOW = 1800000000000;
const ORIGIN = 'https://site.example';
const HOST = 'site.example';
const IDP = 'https://id.example';
const MAX_AGE = 300000;
const SKEW = 120000;
const REASONS = new Set(['parse', 'version', 'alg', 'sig', 'statement']);
const VERIFY_REASONS = new Set(['parse', 'version', 'alg', 'sig', 'origin', 'domain', 'ledger', 'keymode', 'idp', 'too-long', 'not-yet-valid', 'expired', 'nonce', 'replay', 'statement']);

// The spec constants, written out so a drift in the exported ones is a finding.
const SPEC = { proofBytes: 4096, resources: 4, statementChars: 280, fields: ['v', 't', 'domain', 'origin', 'ledger', 'pub', 'keyMode', 'nonce', 'statement', 'resources', 'iat', 'nbf', 'exp', 'requestId', 'idp', 'build'], modes: ['pairwise', 'ledger', 'hub', 'linked'] };

function constantProblems() {
  const p = [];
  if (MAX_PROOF_BYTES !== SPEC.proofBytes) p.push('MAX_PROOF_BYTES is ' + MAX_PROOF_BYTES + ', the spec says ' + SPEC.proofBytes);
  if (MAX_RESOURCES !== SPEC.resources) p.push('MAX_RESOURCES is ' + MAX_RESOURCES + ', the spec says ' + SPEC.resources);
  if (MAX_STATEMENT_CHARS !== SPEC.statementChars) p.push('MAX_STATEMENT_CHARS is ' + MAX_STATEMENT_CHARS + ', the spec says ' + SPEC.statementChars);
  if (JSON.stringify(CHALLENGE_FIELDS) !== JSON.stringify(SPEC.fields)) p.push('CHALLENGE_FIELDS differ from the spec list');
  if (JSON.stringify(KEY_MODES) !== JSON.stringify(SPEC.modes)) p.push('KEY_MODES differ from the spec list');
  return p;
}

/** The four numbers of a proof (v, iat, nbf, exp) at 0, -1 and 2^53-1, as text and as an object, once each: the first inputs of both targets. */
export const IDENTITY_SWEEP = [];
for (const form of ['text', 'object']) for (const key of ['v', 'iat', 'nbf', 'exp']) for (const value of EDGE_MUST) IDENTITY_SWEEP.push({ form, key, value });

// ---------------------------------------------------------------------------------------------
// the field model (independent of both implementations)
// ---------------------------------------------------------------------------------------------

/** Byte length of a canonical unpadded base64url string, or -1. */
function b64Len(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return -1;
  const n = s.length;
  const spare = n % 4 === 2 ? 4 : n % 4 === 3 ? 2 : 0;
  if (spare && (B64CH.indexOf(s[n - 1]) & ((1 << spare) - 1)) !== 0) return -1;
  return Math.floor((n * 3) / 4);
}
const b64Between = (s, min, max) => {
  const n = b64Len(s);
  return n >= min && n <= max;
};

function modelOrigin(s, limit = true) {
  if (typeof s !== 'string' || (limit && s.length > 300)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s;
  } catch (_) {
    return false;
  }
}

function modelStatement(s) {
  if (typeof s !== 'string' || !s.isWellFormed()) return false;
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return false;
    if (c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return false;
    n++;
  }
  return n <= SPEC.statementChars && s.normalize('NFC') === s;
}

function modelResources(r) {
  if (!Array.isArray(r) || r.length > SPEC.resources) return false;
  return r.every((x) => {
    if (typeof x !== 'string' || x.length > 1024 || !x.startsWith('https://')) return false;
    try {
      new URL(x); // eslint-disable-line no-new
      return true;
    } catch (_) {
      return false;
    }
  });
}

const isUint = (n) => Number.isSafeInteger(n) && n >= 0;
const isTimeKey = (k) => k === 'iat' || k === 'nbf' || k === 'exp';

// ---------------------------------------------------------------------------------------------
// building and mutating a proof
// ---------------------------------------------------------------------------------------------

function baseClaims(rng, A, over = {}) {
  return Object.assign({
    v: 1, t: 'mw-signin', domain: HOST, origin: ORIGIN, ledger: null, pub: A.pub, keyMode: 'pairwise', nonce: rng.b64Bytes(32),
    statement: 'Sign in to the forum', resources: [], iat: NOW - 1000, nbf: NOW - 1000, exp: NOW + 200000, requestId: rng.b64Bytes(16), idp: IDP, build: 'fuzz-1',
  }, over);
}

/** Signs the claims as a verifier reads them: written as JSON text and read back (so a Raw spelling counts as its number). */
async function signClaims(A, c) {
  const plain = JSON.parse(stringify(c));
  return b64url.encode(await sign(A.privateKey, utf8.encode('mw-signin-v1\n' + canonicalize(plain))));
}

/** A value of the wrong JSON type for a claim (never one the field would take). */
function wrongType(rng, key) {
  const containers = [[], {}, [1], { a: 1 }, true, false];
  if (isTimeKey(key)) return rng.pick([...containers, 'x', '', '1', null]);
  if (key === 'ledger') return rng.pick([...containers, 0, 1.5, -1]);
  if (key === 'resources') return rng.pick([true, false, {}, { a: 1 }, 'x', '', 0, 1.5, null]);
  return rng.pick([...containers, 0, 1.5, -1, null]); // a string field
}

/** Any value, for a key the claims do not have. */
function anyValue(rng) {
  return rng.pick([true, false, [], {}, 'x', '', 0, 1.5, -1, [1], { a: 1 }, null]);
}

function addKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const STRING_KEYS = ['domain', 'origin', 'ledger', 'pub', 'keyMode', 'nonce', 'statement', 'requestId', 'idp', 'build', 'alg', 'sig'];

function stringValue(rng, key) {
  const origins = ['https://a.example', 'http://localhost:3000', 'http://127.0.0.1', 'http://[::1]:8080', 'https://a.example/', 'https://A.example', 'ftp://x.example', 'https://a.example:443',
    'https://user@a.example', 'https://a.example?x=1', 'javascript:alert(1)', '', 'https://', 'https://' + 'a'.repeat(rng.int(400)) + '.example', 'https://a.example#x', ORIGIN, IDP];
  switch (key) {
    case 'domain': return rng.pick([HOST, rng.ascii(lengthNear(rng, 300)), 'a'.repeat(lengthNear(rng, 300))]);
    case 'origin': case 'idp': return rng.pick(origins);
    case 'ledger': return rng.pick(['L'.repeat(lengthNear(rng, 64)), rng.ascii(rng.int(70)), '']);
    case 'pub': return rng.pick(['p256:' + rng.b64(87), 'p256:' + rng.b64(86), 'p256:' + rng.b64(88), rng.b64(92), 'ed25519:' + rng.b64(87), '']);
    case 'keyMode': return rng.pick([...SPEC.modes, 'Pairwise', 'pairwise ', 'hub\n', '', 'x', 'constructor', '__proto__']);
    case 'nonce': case 'requestId': case 'sig': {
      const bytes = key === 'sig' ? 64 : key === 'nonce' ? 64 : 32;
      const how = rng.int(4);
      if (how === 0) return rng.b64Bytes(Math.max(0, lengthNear(rng, bytes)));
      if (how === 1) return rng.b64(Math.max(0, lengthNear(rng, Math.ceil((bytes * 4) / 3))));
      if (how === 2) return rng.b64Bytes(rng.range(1, bytes + 2)) + rng.pick(['=', '==', '+', '/', ' ', '\n']);
      return rng.text(rng.int(30));
    }
    case 'statement': return rng.pick([rng.ascii(lengthNear(rng, 280)), rng.text(lengthNear(rng, 40)), 'e\u0301'.repeat(rng.int(5)), '\u00e9'.repeat(lengthNear(rng, 280)), '\ud83d\ude00'.repeat(lengthNear(rng, 280)), 'a\u202eb', 'a\u0007b', 'a\ud800b', '']);
    case 'build': return rng.pick([rng.ascii(lengthNear(rng, 64)), 'x'.repeat(lengthNear(rng, 64)), 'v1.2-3', 'a b', '\u00e9']);
    case 'alg': return rng.pick(['ES256-P1363', 'ES256', 'ES256-DER', 'none', '', 'es256-p1363']);
    default: return rng.ascii(rng.int(20));
  }
}

function stringVerdict(key, s) {
  switch (key) {
    case 'domain': return s.length <= 300 ? ['accept'] : ['refuse', 'parse'];
    case 'origin': case 'idp': return modelOrigin(s) ? ['accept'] : ['refuse', 'parse'];
    case 'ledger': return s.length >= 1 && s.length <= 64 ? ['accept'] : ['refuse', 'parse'];
    case 'pub': return s.length !== 92 ? ['refuse', 'parse'] : ['any'];
    case 'keyMode': return SPEC.modes.includes(s) ? ['accept'] : ['refuse', 'parse'];
    case 'nonce': return b64Between(s, 16, 64) ? ['accept'] : ['refuse', 'parse'];
    case 'requestId': return b64Between(s, 16, 32) ? ['accept'] : ['refuse', 'parse'];
    case 'statement': return modelStatement(s) ? ['accept'] : ['refuse', 'statement'];
    case 'build': return /^[\x21-\x7e]{1,64}$/.test(s) ? ['accept'] : ['refuse', 'parse'];
    case 'alg': return s === 'ES256-P1363' ? ['accept'] : ['refuse', 'alg'];
    case 'sig': return b64Len(s) === 64 ? ['accept'] : ['refuse', 'sig'];
    default: return ['any'];
  }
}

/**
 * proofCase(rng, A, form, opts) -> { proof, text, input, verdict, reason, label, family, claims }
 * proof: the (mutated) { c, alg, sig } object; input: what goes to the code under test (text or object);
 * verdict: 'accept' | 'refuse' | 'any' for parseProof; reason: the reason when the refusal is single-fault.
 */
async function proofCase(rng, A, form, opts = {}) {
  const c = baseClaims(rng, A, opts.claims || {});
  const proof = { c, alg: 'ES256-P1363', sig: '' };
  proof.sig = await signClaims(A, c);
  const out = { proof, verdict: 'accept', reason: null, label: [], family: 'none', resign: false, changed: false, baseNonce: c.nonce };
  const refuse = (why, reason) => {
    out.verdict = 'refuse';
    if (out.reason === null) out.reason = reason || 'parse';
    out.label.push(why);
  };
  let textEdit = null;
  const forced = opts.forced || null;
  const kind = forced ? 'num' : rng.weighted([
    [2, 'none'], [7, 'num'], [5, 'time'], [8, 'str'], [3, 'resources'], [4, 'structure'], [3, 'type'], [form === 'text' ? 5 : 0, 'text'], [form === 'object' ? 1 : 0, 'deep'],
  ]);
  switch (kind) {
    case 'none': out.label.push('unchanged'); break;
    case 'num': {
      const key = forced ? forced.key : rng.pick(['v', 'iat', 'nbf', 'exp', 'iat', 'exp']);
      const value = forced ? forced.value : edgeNumber(rng, { objectMode: form === 'object', limit: key === 'v' ? 1 : null });
      let shown = value;
      let seen = value;
      if (!forced && form === 'text' && typeof value === 'number' && Number.isFinite(value) && rng.chance(0.3)) {
        const spelled = spellings(rng, value);
        try {
          seen = JSON.parse(spelled);
        } catch (_) {
          seen = undefined; // not JSON: the whole text is refused
        }
        c[key] = new Raw(spelled);
        shown = spelled;
        out.label.push('c.' + key + '=' + shown);
        if (seen === undefined) { refuse('number spelled wrongly', 'parse'); break; }
      } else {
        c[key] = value;
        out.label.push('c.' + key + '=' + String(shown));
        if (form === 'text' && (typeof value !== 'number' || !Number.isFinite(value))) seen = value !== value || value === Infinity || value === -Infinity ? null : value;
      }
      out.family = 'num';
      out.changed = true;
      out.resign = true;
      out.numeric = { key, seen };
      if (key === 'v') {
        if (seen !== 1) refuse('version', 'version');
      } else if (!isUint(seen)) {
        refuse('not a safe unsigned integer', 'parse');
      }
      break;
    }
    case 'time': {
      // the edges of the window: expiry (exp + skew), not yet valid (iat or nbf past now + skew), age (exp - iat)
      const scenario = rng.int(4);
      const k = rng.range(-2, 2);
      if (scenario === 0) {
        c.exp = NOW - SKEW + k;
        c.iat = c.exp - rng.pick([1, 1000, MAX_AGE]);
        c.nbf = c.iat;
      } else if (scenario === 1) {
        c.iat = NOW + SKEW + k;
        c.nbf = c.iat;
        c.exp = c.iat + rng.pick([1, 1000, MAX_AGE]);
      } else if (scenario === 2) {
        c.nbf = NOW + SKEW + k;
      } else {
        c.exp = c.iat + MAX_AGE + k;
      }
      out.label.push('time edge ' + scenario + ' ' + k);
      out.family = 'num';
      out.changed = true;
      out.resign = true;
      out.numeric = { key: 'time', seen: null };
      break;
    }
    case 'str': {
      const key = rng.pick(STRING_KEYS);
      const s = stringValue(rng, key);
      if (key === 'alg') proof.alg = s;
      else if (key === 'sig') proof.sig = s;
      else c[key] = s;
      out.label.push(key + ' = ' + describe(s, 40));
      out.family = 'str';
      out.changed = true;
      out.resign = key !== 'alg' && key !== 'sig' && rng.chance(0.7);
      const [v, r] = stringVerdict(key, s);
      if (v === 'refuse') refuse(key, r);
      else if (v === 'any') out.verdict = 'any';
      break;
    }
    case 'resources': {
      const n = lengthNear(rng, 4);
      const list = [];
      for (let k = 0; k < Math.min(n, 12); k++) {
        const len = rng.pick([0, 8, 9, 20, 1000, 1016, 1017, 1020]);
        const body = 'a'.repeat(Math.max(0, len - 8));
        list.push(rng.pick(['https://', 'https://', 'https://', 'http://', 'ftp://', 'HTTPS://', 'https:/']) + body + (rng.chance(0.3) ? '/x y' : ''));
      }
      c.resources = list;
      out.label.push('resources ' + list.length);
      out.family = 'str';
      out.changed = true;
      out.resign = rng.chance(0.7);
      if (!modelResources(list)) refuse('resources', 'parse');
      break;
    }
    case 'structure': {
      const where = rng.pick(['c', 'c', 'top']);
      const act = rng.pick(['drop', 'add']);
      if (where === 'top') {
        out.noResign = true;
        if (act === 'drop') {
          const k = rng.pick(['c', 'alg', 'sig']);
          delete proof[k];
          refuse('top-level ' + k + ' dropped', 'parse');
        } else {
          addKey(proof, rng.pick(['extra', '__proto__', 'constructor']), anyValue(rng));
          refuse('top-level key added', 'parse');
        }
      } else if (act === 'drop') {
        const k = rng.pick(SPEC.fields);
        delete c[k];
        refuse('c.' + k + ' dropped', k === 'v' || k === 't' ? 'version' : 'parse');
      } else {
        addKey(c, rng.pick(['extra', 'x', 'aud', '__proto__']), anyValue(rng));
        refuse('c key added', 'parse');
      }
      out.family = 'structure';
      out.changed = true;
      break;
    }
    case 'type': {
      const k = rng.pick([...SPEC.fields.filter((f) => f !== 'v' && f !== 't'), 'alg', 'sig']);
      const bad = wrongType(rng, k);
      if (k === 'alg' || k === 'sig') out.noResign = true;
      if (k === 'alg') proof.alg = bad;
      else if (k === 'sig') proof.sig = bad;
      else c[k] = bad;
      out.label.push(k + ' has the wrong type ' + describe(bad, 30));
      out.family = 'type';
      out.changed = true;
      refuse(k, k === 'alg' ? 'alg' : k === 'sig' ? 'sig' : k === 'statement' ? 'statement' : 'parse');
      break;
    }
    case 'text': {
      out.family = 'text';
      out.changed = true;
      const which = rng.int(9);
      if (which === 0) { textEdit = (t) => t.replace('{"c":{', '{"c":{"v":1,'); refuse('duplicate key', 'parse'); }
      else if (which === 1) { textEdit = (t) => t + rng.pick(['x', ',', '}', ' {', '\u0000']); refuse('trailing data', 'parse'); }
      else if (which === 2) { const cut = rng.int(100); textEdit = (t) => t.slice(0, Math.max(0, t.length - 1 - cut)); refuse('truncated', 'parse'); }
      else if (which === 3) { textEdit = (t) => '\ufeff' + t; refuse('BOM', 'parse'); }
      else if (which === 4) { textEdit = (t) => t.replace('"build":"fuzz-1"', '"build":"fuzz\n1"'); refuse('newline in a string', 'parse'); }
      else if (which === 5) { textEdit = (t) => t.replace('"build":"fuzz-1"', '"build":"fuzz\\x"'); refuse('bad escape', 'parse'); }
      else if (which === 6) {
        const target = SPEC.proofBytes + rng.pick([-2, -1, 0, 1, 2]);
        textEdit = (t) => (utf8.encode(t).length >= target ? t : t + rng.pick([' ', '\n', '\t', '\r']).repeat(target - utf8.encode(t).length));
        out.label.push('whitespace padded to ' + target);
      } else if (which === 7) { textEdit = (t) => t.replace('"build":"fuzz-1"', '"build":' + '['.repeat(rng.range(1, 40)) + ']'.repeat(0)); refuse('nesting', 'parse'); }
      else { out.verdict = 'any'; out.label.push('random byte mutations'); }
      out.textBytesMutation = which === 8;
      break;
    }
    default: { // deep: an object-mode value nested far deeper than the parser reads
      c.build = nested(rng.pick([10, 100, 5000, 100000]), 0, rng.pick(['array', 'object']));
      out.label.push('c.build nested');
      out.family = 'deep';
      out.changed = true;
      refuse('nested build', 'parse');
    }
  }
  if (out.family === 'structure' || out.family === 'type') out.resign = rng.chance(0.5);
  if (out.resign && !out.noResign && proof.c && typeof proof.c === 'object') {
    try {
      proof.sig = await signClaims(A, c);
    } catch (_) {
      // a value canonicalize refuses (NaN, Infinity): keep the old signature
    }
  }
  // text or object
  let input;
  let text = null;
  if (form === 'text') {
    text = stringify(proof);
    if (textEdit) text = textEdit(text);
    if (out.textBytesMutation) {
      const bytes = mutateBytes(rng, utf8.encode(text), { maxLen: 6000 });
      text = new TextDecoder().decode(bytes);
    }
    input = text;
  } else {
    input = proof;
  }
  // The 4 KiB limit is checked before anything else
  let size;
  try {
    size = form === 'text' ? utf8.encode(text).length : utf8.encode(canonicalize(proof)).length;
  } catch (_) {
    size = Infinity;
  }
  if (size > SPEC.proofBytes) {
    out.verdict = 'refuse';
    out.reason = 'parse';
    out.label.push('size ' + (size === Infinity ? 'not JSON' : size));
  }
  out.size = size;
  out.text = text;
  out.input = input;
  out.form = form;
  return out;
}

/** The claims as the code under test saw them (after the JSON text round trip), or null. */
function seenClaims(d) {
  try {
    const o = d.form === 'text' ? JSON.parse(d.text) : JSON.parse(JSON.stringify(d.proof));
    return o && typeof o === 'object' ? o.c : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// signin-parse
// ---------------------------------------------------------------------------------------------

/** Which claim a mutated proof is about, for naming an observation ("resources", "idp", "domain", ...). */
function faultKey(d) {
  const first = d.label.find((l) => !/^(unchanged|size)/.test(l)) || d.label[0] || 'none';
  return first.split(/[ =.]/)[0] === 'c' ? first.split(/[ =.]/)[1] : first.split(/[ =.]/)[0];
}

function looseVerifier() {
  // every nonce is accepted once: only the proof itself and the time window decide
  const nonces = { async consume() { return true; } };
  return createVerifier({ origin: ORIGIN, nonces, now: () => NOW });
}

export const SIGNIN_PARSE = {
  name: 'signin-parse',
  about: 'parseProof() on proof text and objects: numbers, string lengths, lists, keys, 4 KiB; compared with the standalone verifier',
  async setup() {
    return { A: await ecdsaIdentity(), verifier: looseVerifier() };
  },
  async gen(rng, state, i) {
    const forced = i < IDENTITY_SWEEP.length ? IDENTITY_SWEEP[i] : null;
    const form = forced ? forced.form : rng.chance(0.7) ? 'text' : 'object';
    const d = await proofCase(rng, state.A, form, { forced });
    return { label: (forced ? 'sweep ' : '') + form + ' ' + d.label.join(', '), d, input: d.input, i };
  },
  async run(c, state) {
    const parsed = parseProof(c.input);
    const verified = await state.verifier.verify(c.input);
    return { parsed, verified };
  },
  check(c, { result }, state, note) {
    const problems = [];
    if (c.i === 0) problems.push(...constantProblems());
    const { parsed, verified } = result;
    const d = c.d;
    if (!parsed || typeof parsed.ok !== 'boolean') return ['parseProof returned ' + describe(parsed, 80)];
    if (!parsed.ok && !REASONS.has(parsed.reason)) problems.push('refused with an unknown reason ' + describe(parsed.reason, 40));
    if (parsed.ok && d.verdict === 'refuse') problems.push('accepted a proof that is malformed by construction');
    if (!parsed.ok && d.verdict === 'accept') problems.push('refused (' + parsed.reason + ') a proof that is valid by construction');
    if (!parsed.ok && d.verdict === 'refuse' && d.reason && parsed.reason !== d.reason) problems.push('refused with ' + parsed.reason + ', the single fault calls for ' + d.reason);
    if (parsed.ok) {
      const p = parsed.proof;
      const keys = Object.keys(p.c);
      if (JSON.stringify(keys) !== JSON.stringify(CHALLENGE_FIELDS)) problems.push('the accepted claims are not exactly the challenge fields, in order');
      if (!isUint(p.c.iat) || !isUint(p.c.nbf) || !isUint(p.c.exp)) problems.push('an accepted proof has a time that is not a safe unsigned integer');
      if (p.c.v !== 1 || p.c.t !== 'mw-signin') problems.push('an accepted proof is not v 1 / mw-signin');
      if (!(p.c.resources.length <= 4) || !modelResources(p.c.resources)) problems.push('an accepted proof has resources the model refuses');
      if (!modelStatement(p.c.statement)) problems.push('an accepted proof has a statement the model refuses');
      if (b64Len(p.sig) !== 64 || p.alg !== 'ES256-P1363') problems.push('an accepted proof has a signature or algorithm the model refuses');
      if (!b64Between(p.c.nonce, 16, 64) || !b64Between(p.c.requestId, 16, 32)) problems.push('an accepted proof has a nonce or request id the model refuses');
      if (typeof c.input === 'object' && (p.c === c.input.c || p.c.resources === c.input.c.resources)) problems.push('the accepted proof is not a copy of the input');
      if (!modelOrigin(p.c.origin) || !modelOrigin(p.c.idp)) problems.push('an accepted proof has an origin the model refuses');
    }
    // the standalone verifier against the browser parser
    if (!verified || typeof verified.ok !== 'boolean') problems.push('verify() returned ' + describe(verified, 80));
    else {
      if (verified.ok === false && !VERIFY_REASONS.has(verified.reason)) problems.push('verify() refused with an unknown reason ' + describe(verified.reason, 40));
      if (verified.ok && !parsed.ok) note('verifier-looser-than-parser:' + faultKey(d), 'the verifier accepted a proof parseProof refuses (' + parsed.reason + '): ' + d.label.join(', '));
      if (!verified.ok && parsed.ok && ['parse', 'version', 'alg', 'statement'].includes(verified.reason)) {
        note('verifier-stricter-than-parser:' + faultKey(d), 'the verifier refused (' + verified.reason + ') a proof parseProof accepts: ' + d.label.join(', '));
      }
    }
    return problems;
  },
  show: (c) => (typeof c.input === 'string' ? describe(c.input, 700) : describe(c.input, 700)),
};

// ---------------------------------------------------------------------------------------------
// verify-package
// ---------------------------------------------------------------------------------------------

function windowOk(p) {
  return isUint(p.iat) && isUint(p.nbf) && isUint(p.exp) && p.exp > p.iat && p.exp - p.iat <= MAX_AGE && p.iat <= NOW + SKEW && p.nbf <= NOW + SKEW &&
    p.exp + SKEW > NOW && p.iat + MAX_AGE + SKEW > NOW;
}

export const VERIFY_PACKAGE = {
  name: 'verify-package',
  about: 'packages/verify verify(): mutated proofs re-signed, against a model of the time window, the nonce and the replay rule',
  async setup() {
    return { A: await ecdsaIdentity(), secret: new TextEncoder().encode('fuzz-secret-0123456789abcdef') };
  },
  async gen(rng, state, i) {
    const forced = i < IDENTITY_SWEEP.length ? IDENTITY_SWEEP[i] : null;
    const form = forced ? forced.form : rng.chance(0.7) ? 'text' : 'object';
    const stateless = rng.chance(0.25);
    let claims = {};
    let issued = null;
    if (stateless) {
      const nonces = statelessNonce(state.secret, { used: new MemoryNonceStore({ now: () => NOW }), now: () => NOW });
      const ch = await issueChallenge({ statement: 'Sign in to the forum', nonces, origin: ORIGIN });
      claims = { nonce: ch.nonce };
    }
    const d = await proofCase(rng, state.A, form, { claims, forced });
    if (!stateless) issued = { nonce: d.baseNonce, exp: NOW + 200000, meta: { statement: 'Sign in to the forum', resources: [] } };
    // a stateless nonce: damage it a little in some cases (the MAC must catch every change)
    let nonceDamaged = false;
    if (stateless && d.verdict !== 'refuse' && d.proof.c && typeof d.proof.c.nonce === 'string' && rng.chance(0.25)) {
      const n = d.proof.c.nonce;
      const at = rng.int(n.length);
      d.proof.c.nonce = n.slice(0, at) + (n[at] === 'A' ? 'B' : 'A') + n.slice(at + 1);
      nonceDamaged = true;
      d.label.push('stateless nonce damaged at ' + at);
      d.proof.sig = await signClaims(state.A, d.proof.c);
      d.input = d.form === 'text' ? stringify(d.proof) : d.proof;
      d.text = d.form === 'text' ? d.input : null;
      if (d.size > SPEC.proofBytes) d.verdict = 'refuse';
    }
    return {
      label: (stateless ? 'stateless ' : 'issued ') + d.form + ' ' + d.label.join(', '), d, stateless, issued, nonceDamaged, input: d.input, i,
    };
  },
  async run(c, state) {
    const store = new MemoryNonceStore({ now: () => NOW });
    let nonces = store;
    if (c.stateless) nonces = statelessNonce(state.secret, { used: store, now: () => NOW });
    else await store.put(c.issued.nonce, c.issued.exp, c.issued.meta);
    const verifier = createVerifier({ origin: ORIGIN, nonces, now: () => NOW, statement: c.stateless ? 'Sign in to the forum' : undefined });
    const first = await verifier.verify(c.input);
    const second = first.ok ? await verifier.verify(c.input) : null;
    return { first, second };
  },
  check(c, { result }, state, note) {
    const problems = [];
    const { first, second } = result;
    const d = c.d;
    if (!first || typeof first.ok !== 'boolean') return ['verify() returned ' + describe(first, 80)];
    if (!first.ok && !VERIFY_REASONS.has(first.reason)) problems.push('refused with an unknown reason ' + describe(first.reason, 40));
    if (first.ok) {
      for (const k of ['pub', 'keyMode', 'ledger', 'iat', 'exp', 'requestId', 'statement', 'idp', 'build']) if (!(k in first)) problems.push('an accepted result lacks ' + k);
      if (!second || second.ok !== false || second.reason !== 'replay') problems.push('the same accepted proof was not refused as a replay the second time: ' + describe(second, 80));
    }
    if (first.ok && d.verdict === 'refuse') {
      // the browser parser and the verifier are two implementations; a proof malformed by construction must be refused by both
      const parsed = parseProof(c.input);
      if (parsed.ok) problems.push('accepted a proof that is malformed by construction (and parseProof accepts it: the mutation is wrong)');
      else if (d.family === 'str' && d.label.some((l) => l.startsWith('resources'))) note('verifier-looser-than-parser:resources', 'the verifier accepts resources parseProof refuses: ' + d.label.join(', '));
      else if (d.label.some((l) => /^idp/.test(l))) note('verifier-looser-than-parser:idp', 'the verifier accepts an idp parseProof refuses: ' + d.label.join(', '));
      else problems.push('accepted a proof that is malformed by construction (' + d.label.join(', ') + ')');
    }
    // the exact cases: nothing but the times changed (or nothing at all)
    if (d.verdict === 'accept' && (d.family === 'none' || d.family === 'num')) {
      const seen = seenClaims(d);
      if (seen && !c.nonceDamaged) {
        const expectOk = windowOk(seen) && (d.family === 'none' || d.resign);
        if (first.ok !== expectOk) problems.push((first.ok ? 'accepted' : 'refused (' + first.reason + ')') + ' a proof whose window the model ' + (expectOk ? 'accepts' : 'refuses') + ': iat ' + seen.iat + ', nbf ' + seen.nbf + ', exp ' + seen.exp);
      }
    }
    if (c.nonceDamaged && first.ok) problems.push('accepted a stateless nonce that was changed after the MAC was made');
    return problems;
  },
  show: (c) => describe(c.input, 700),
};

export const TARGETS = [SIGNIN_PARSE, VERIFY_PACKAGE];
