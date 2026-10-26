// Fuzz targets for MW-PTR/1 and magnet links (V03-DESIGN-REVIEW 2.19, MF-43; docs/specs MW-PTR/1):
//
//   pointer-parse   parsePointer(): every number (seq, exp, max) as text in the forms a strict parser must tell
//                   apart (01, +5, 5.0, 1e3, 2^53, 2^64, spaces), org= counts and origins, nx= and ml= lengths and
//                   parts, idp=, btih=, st=, v=, repeated keys, parts without "=", control characters, bare
//                   infohashes and magnet links; a model of each rule; invariants of an accepted record
//   pointer-txt     splitTxt()/joinTxtData(): the DNS TXT round trip and garbage in
//   magnet-parse    parseMagnet()/normalizeBtih(): generated links against a model, and garbage
//
// Shared code under test: src/common/pointer.js, src/common/magnet.js.

import { isDeepStrictEqual } from 'node:util';

import { Rng, lengthNear, mutateBytes, concat, utf8, describe, fakePub, EDGE_MUST } from '../kit.mjs';
import { parsePointer, formatPointer, splitTxt, joinTxtData, ORG_MAX, isOriginString, isLoaderVersion } from '../../../src/common/pointer.js';
import { parseMagnet, normalizeBtih } from '../../../src/common/magnet.js';

const SPEC = { orgMax: 4, nx: /^[A-Za-z0-9_-]{43}$/, ml: /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,5})$/, sizeMax: 900, txt: 255 };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const UINT_KEYS = ['seq', 'exp', 'max'];
const SINGLE_KEYS = ['v', 'st', 'btih', 'dn', 'chain', 'max', 'owner', 'lo', 'gen', 'rot', 'cs', 'consent', 'aud', 'ct', 'lg', 'why', 'nx', 'ml', 'idp', 'seq', 'exp', 'sig'];
const ERRORS = new Set(['empty', 'malformed', 'duplicate-key', 'bad-value', 'no-version', 'unsupported-version', 'no-btih', 'bad-btih', 'bad-magnet']);

function modelUint(t) {
  return /^(?:0|[1-9][0-9]*)$/.test(t) && t.length <= 16 && Number.isSafeInteger(Number(t));
}

function modelOrigin(s) {
  if (typeof s !== 'string' || !s) return false;
  try {
    const u = new URL(s);
    if (u.origin !== s) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch (_) {
    return false;
  }
}

export function pointerConstantProblems() {
  const p = [];
  if (ORG_MAX !== SPEC.orgMax) p.push('ORG_MAX is ' + ORG_MAX + ', the spec says ' + SPEC.orgMax);
  return p;
}

// ---------------------------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------------------------

function basePairs(rng) {
  return [
    ['v', 'mw1'], ['btih', rng.hex(40)], ['dn', 'My%20site'], ['xs', 'https://x.example/a.torrent'], ['ws', 'https://seed.example/'],
    ['tr', 'wss://tracker.example'], ['chain', rng.b64(27)], ['max', '1000'], ['owner', fakePub(rng)], ['org', 'https://a.example'], ['org', 'https://b.example:8443'],
    ['nx', rng.b64(43)], ['ml', '0.3.0'], ['idp', 'https://id.example'], ['seq', '5'], ['exp', '1900000000'], ['sig', rng.b64(86)],
  ];
}

const UINT_FORMS = ['0', '1', '-1', '-0', '007', '00', '+5', ' 5', '5 ', '\t5\n', '5.0', '5.', '.5', '5e3', '5E3', '0x10', '0b1', '9007199254740991', '9007199254740992', '9007199254740993',
  '18446744073709551615', '18446744073709551616', '99999999999999999', '', 'abc', '5a', '\u0665', '\uff15', '1_000', '1,000', '\ud835\udfd3', '\u0661\u0662\u0663'];

function uintForm(rng) {
  const r = rng.next();
  if (r < 0.55) return rng.pick(UINT_FORMS);
  if (r < 0.75) return '9'.repeat(rng.range(1, 40));
  if (r < 0.9) return String(rng.int(2 ** 31));
  return rng.pick(['1', '9']) + '0'.repeat(rng.range(0, 18));
}

const ORIGINS_OK = ['https://a.example', 'https://a.example:8443', 'http://localhost', 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]', 'https://xn--bcher-kva.example', 'https://sub.a.example'];
const ORIGINS_BAD = ['https://a.example/', 'https://A.example', 'http://a.example', 'ftp://a.example', 'https://a.example:443', 'https://user@a.example', 'https://a.example?x=1', 'https://a.example#f', '', 'a.example',
  'https://', 'javascript:alert(1)', 'https://a.example/path', 'HTTPS://a.example', 'https://a.example:0', 'https://a.example:65536', 'http://127.0.0.2'];

/** seq, exp and max at 0, -1 and 2^53-1 (as the text a record carries), once each: the first inputs of pointer-parse. */
export const POINTER_SWEEP = [];
for (const key of UINT_KEYS) for (const value of EDGE_MUST) POINTER_SWEEP.push({ key, value: String(value) });

function pointerPairsCase(rng, forced = null) {
  const pairs = basePairs(rng);
  const label = [];
  let verdict = 'accept';
  let error = null;
  const setPair = (key, value) => {
    const at = pairs.findIndex((p) => p[0] === key);
    if (at >= 0) pairs[at] = [key, value];
    else pairs.push([key, value]);
  };
  const dropAll = (key) => {
    for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i][0] === key) pairs.splice(i, 1);
  };
  const refuse = (e, why) => {
    verdict = 'refuse';
    if (error === null) error = e;
    label.push(why);
  };
  const kind = forced ? 'uint' : rng.weighted([[8, 'uint'], [3, 'ml'], [5, 'org'], [3, 'nx'], [3, 'idp'], [3, 'btih'], [2, 'st'], [2, 'v'], [5, 'dup'], [4, 'syntax'], [3, 'text'], [4, 'none'], [3, 'extra']]);
  switch (kind) {
    case 'none': label.push('as built'); break;
    case 'uint': {
      const key = forced ? forced.key : rng.pick(UINT_KEYS);
      const value = forced ? forced.value : uintForm(rng);
      setPair(key, value);
      label.push(key + '=' + JSON.stringify(value));
      const t = value.trim();
      if (/[\u0000-\u001f\u007f]/.test(t)) refuse('malformed', 'control character');
      else if (!modelUint(t)) refuse('bad-value', key + ' is not an unsigned safe integer');
      break;
    }
    case 'ml': {
      const part = () => rng.pick(['0', '1', '9999', '10000', '99999', '100000', '999999', '1000000', '00', '01', '-1', 'x', '', ' 1', '1 ', String(rng.int(2000000))]);
      const value = rng.chance(0.2) ? rng.pick(['1.2', '1.2.3.4', '1..3', '.1.2', 'v1.2.3', '1.2.3-beta', '1.2.3 ']) : [part(), part(), part()].join('.');
      setPair('ml', value);
      label.push('ml=' + JSON.stringify(value));
      if (!SPEC.ml.test(value.trim()) || /[\u0000-\u001f\u007f]/.test(value.trim())) refuse('bad-value', 'ml');
      break;
    }
    case 'org': {
      dropAll('org');
      const n = lengthNear(rng, SPEC.orgMax);
      const list = [];
      for (let i = 0; i < Math.min(n, 12); i++) list.push(rng.chance(0.75) ? rng.pick(ORIGINS_OK) : rng.pick(ORIGINS_BAD));
      if (list.length > 1 && rng.chance(0.25)) list[list.length - 1] = list[0];
      for (const o of list) pairs.push(['org', o]);
      label.push('org x' + list.length);
      const distinct = new Set(list.map((o) => o.trim())).size === list.length;
      if (list.length > SPEC.orgMax || !list.every((o) => modelOrigin(o.trim())) || !distinct) refuse('bad-value', 'org');
      break;
    }
    case 'nx': {
      const n = lengthNear(rng, 43);
      const value = rng.chance(0.3) ? rng.pick(['+'.repeat(43), '/'.repeat(43), '='.repeat(43), '\u00e9'.repeat(43), rng.b64(42) + ' ']) : rng.b64(n);
      setPair('nx', value);
      label.push('nx length ' + value.length);
      if (!SPEC.nx.test(value.trim())) refuse('bad-value', 'nx');
      break;
    }
    case 'idp': {
      const value = rng.chance(0.8) ? rng.pick([...ORIGINS_OK, ...ORIGINS_BAD]) : 'https://' + 'a'.repeat(rng.int(400)) + '.example';
      setPair('idp', value);
      label.push('idp=' + describe(value, 50));
      if (!modelOrigin(value.trim())) refuse('bad-value', 'idp');
      break;
    }
    case 'btih': {
      const h = rng.hex(40);
      const value = rng.pick([h, h.toUpperCase(), h.slice(0, 39), h + '0', ' ' + h + ' ', 'btih:' + h, rng.chars(32, 'abcdefghijklmnopqrstuvwxyz234567'), '', 'g'.repeat(40), h.slice(0, 20) + 'G' + h.slice(21)]);
      setPair('btih', value);
      label.push('btih=' + describe(value, 50));
      if (!/^[0-9a-f]{40}$/.test(value.trim())) refuse('bad-btih', 'btih');
      break;
    }
    case 'st': {
      const value = rng.pick(['ok', 'withdrawn', '', 'OK', 'active', 'paused', 'x']);
      setPair('st', value);
      label.push('st=' + value);
      break;
    }
    case 'v': {
      const value = rng.pick(['mw1', 'mw2', 'MW1', '', 'mw1 ', 'mw']);
      setPair('v', value);
      label.push('v=' + JSON.stringify(value));
      if (value.trim() !== 'mw1') refuse('unsupported-version', 'v');
      break;
    }
    case 'dup': {
      const key = rng.pick(SINGLE_KEYS.filter((k) => pairs.some((p) => p[0] === k)));
      const first = pairs.find((p) => p[0] === key);
      pairs.splice(rng.int(pairs.length + 1), 0, [key, first[1]]);
      label.push('duplicate ' + key);
      refuse('duplicate-key', 'duplicate ' + key);
      break;
    }
    case 'syntax': {
      const how = rng.int(7);
      if (how === 0) { pairs.splice(rng.int(pairs.length + 1), 0, ['novalue', null]); refuse('malformed', 'a part without ='); }
      else if (how === 1) { pairs.splice(rng.int(pairs.length + 1), 0, ['', 'x']); refuse('malformed', 'an empty key'); }
      else if (how === 2) { pairs.splice(rng.int(pairs.length + 1), 0, [rng.pick(['a b', '\u00e9', '-a', '.a', 'a$', 'a\u0000']), 'x']); refuse('malformed', 'a bad key'); }
      else if (how === 3) { setPair('dn', 'a' + rng.pick(['\u0001', '\u007f', '\u0000', '\t', '\n', '\r']) + 'b'); refuse('malformed', 'control character in dn'); }
      else if (how === 4) { pairs.push(['UNKNOWN', 'x']); pairs.push(['unknown', 'y']); label.push('unknown key twice'); }
      else if (how === 5) { setPair('dn', '\t ' + rng.ascii(5) .replace(/;/g, ',') + ' \n'); label.push('dn trimmed'); }
      else { pairs.splice(rng.int(pairs.length + 1), 0, ['', null]); label.push('empty parts'); }
      break;
    }
    case 'extra': {
      pairs.push([rng.pick(['x', 'x-note', 'a.b', 'A1', 'foo_bar'.replace('_', '-')]), rng.ascii(rng.int(30)).replace(/;/g, ',')]);
      label.push('extra key');
      break;
    }
    default: label.push('text');
  }
  // compose the text; "novalue" parts have no "="
  const sep = rng.pick([';', ';', '; ', ' ;', ';\n']);
  let text = pairs.map(([k, v]) => (v === null ? k : k + '=' + v)).join(sep);
  if (rng.chance(0.1)) text = ' ' + text + ' \n';
  return { text, verdict, error, label: label.join(', '), pairs };
}

function randomText(rng) {
  const how = rng.int(7);
  if (how === 0) return rng.ascii(rng.int(300));
  if (how === 1) return rng.text(rng.int(100));
  if (how === 2) return 'v=mw1;btih=' + rng.hex(40) + ';' + Array.from({ length: rng.int(2000) }, () => rng.ascii(rng.range(1, 4)) + '=' + rng.ascii(rng.int(4))).join(';').replace(/[\u0000-\u001f]/g, '');
  if (how === 3) return ';'.repeat(rng.int(5000));
  if (how === 4) return '='.repeat(rng.int(5000));
  if (how === 5) return 'magnet:?' + Array.from({ length: rng.int(30) }, () => rng.pick(['xt=urn:btih:' + rng.hex(40), 'dn=' + enc(rng.text(5)), 'tr=' + enc('wss://t.example/' + rng.ascii(5)), rng.ascii(6), 'xt=' + rng.ascii(10), 'amp;tr=x'])).join('&');
  return rng.pick(['btih:', 'urn:btih:', '']) + rng.pick([rng.hex(40), rng.hex(40).toUpperCase(), rng.chars(32, 'abcdefghijklmnopqrstuvwxyz234567'), rng.hex(39), rng.hex(41)]);
}

// ---------------------------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------------------------

function recordProblems(text, res) {
  const p = [];
  if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') return ['parsePointer returned ' + describe(res, 60)];
  if (!res.ok) {
    if (!ERRORS.has(res.error)) p.push('refused with an unknown error ' + describe(res.error, 40));
    if (typeof res.detail !== 'string') p.push('a refusal has no detail');
    return p;
  }
  const r = res.record;
  if (r.kind !== 'pointer' && r.kind !== 'magnet') p.push('kind is ' + r.kind);
  if (typeof r.btih !== 'string' || !/^[0-9a-f]{40}$/.test(r.btih)) p.push('an accepted record has btih ' + describe(r.btih, 50));
  if (r.kind === 'pointer') {
    if (r.v !== 'mw1') p.push('an accepted pointer has v ' + describe(r.v, 20));
    for (const k of UINT_KEYS) if (r[k] !== null && !(typeof r[k] === 'number' && Number.isSafeInteger(r[k]) && r[k] >= 0)) p.push(k + ' is ' + describe(r[k], 30));
    if (!Array.isArray(r.org) || r.org.length > SPEC.orgMax) p.push('org has ' + (r.org && r.org.length) + ' entries');
    else {
      for (const o of r.org) if (!modelOrigin(o)) p.push('org has ' + describe(o, 60));
      if (new Set(r.org).size !== r.org.length) p.push('org has a duplicate');
    }
    if (r.nx !== null && !SPEC.nx.test(r.nx)) p.push('nx is ' + describe(r.nx, 60));
    if (r.ml !== null && !SPEC.ml.test(r.ml)) p.push('ml is ' + describe(r.ml, 30));
    if (r.idp !== null && !modelOrigin(r.idp)) p.push('idp is ' + describe(r.idp, 60));
    if (r.withdrawn !== (r.st !== null && r.st !== 'ok')) p.push('withdrawn is ' + r.withdrawn + ' with st ' + describe(r.st, 20));
    for (const k of Object.keys(r.extra)) if (SINGLE_KEYS.includes(k) || ['tr', 'ws', 'xs', 'org'].includes(k)) p.push('extra holds the named key ' + k);
    for (const [k] of r.pairs || []) if (k !== k.toLowerCase()) p.push('pairs hold an upper-case key ' + k);
  } else {
    for (const k of ['tr', 'ws', 'xs']) if (!Array.isArray(r[k]) || r[k].some((x) => typeof x !== 'string')) p.push('magnet ' + k + ' is not a list of strings');
  }
  return p;
}

function sameRecord(a, b) {
  const norm = (v) => (v === '' || v === undefined ? null : v);
  for (const k of ['v', 'st', 'btih', 'dn', 'chain', 'owner', 'lo', 'gen', 'rot', 'cs', 'consent', 'aud', 'ct', 'lg', 'why', 'nx', 'ml', 'idp', 'sig', 'max', 'seq', 'exp']) if (norm(a[k]) !== norm(b[k])) return k;
  for (const k of ['xs', 'ws', 'tr', 'org']) if (!isDeepStrictEqual(a[k].filter((x) => x !== ''), b[k].filter((x) => x !== ''))) return k;
  return null;
}

export const POINTER_PARSE = {
  name: 'pointer-parse',
  about: 'parsePointer(): seq/exp/max text forms, org/nx/ml/idp/btih rules, duplicate keys, syntax, random text; invariants of an accepted record',
  gen(rng, state, i) {
    if (i < POINTER_SWEEP.length) return Object.assign(pointerPairsCase(rng, POINTER_SWEEP[i]), { i });
    if (rng.chance(0.12)) return { label: 'random text', text: randomText(rng), verdict: 'any', error: null, i };
    const c = pointerPairsCase(rng);
    return Object.assign(c, { i });
  },
  run: (c) => parsePointer(c.text),
  check(c, { result }, state, note) {
    const problems = [];
    if (c.i === 0) problems.push(...pointerConstantProblems());
    problems.push(...recordProblems(c.text, result));
    if (result && typeof result.ok === 'boolean') {
      if (c.verdict === 'accept' && !result.ok) problems.push('refused (' + result.error + ': ' + result.detail + ') a pointer that is valid by construction');
      if (c.verdict === 'refuse' && result.ok) problems.push('accepted a pointer that is malformed by construction (' + c.error + ')');
      if (c.verdict === 'refuse' && !result.ok && c.error && result.error !== c.error) problems.push('refused with ' + result.error + ', the single fault calls for ' + c.error);
      if (result.ok && result.record.kind === 'pointer') {
        // a parsed record formats back to a record with the same fields (the signing input is built from either)
        let again = null;
        try {
          again = parsePointer(formatPointer(result.record));
        } catch (err) {
          note('pointer-format-throws', 'formatPointer threw on an accepted record: ' + err.message);
        }
        if (again) {
          if (!again.ok) note('pointer-format-roundtrip', 'formatPointer output does not parse (' + again.error + '): ' + c.label);
          else {
            const diff = sameRecord(result.record, again.record);
            if (diff) note('pointer-format-roundtrip', 'formatPointer then parsePointer changes ' + diff + ': ' + c.label);
          }
        }
      }
    }
    return problems;
  },
  show: (c) => describe(c.text, 700),
};

// ---------------------------------------------------------------------------------------------
// pointer-txt
// ---------------------------------------------------------------------------------------------

function presentation(chunks) {
  // RFC 1035: each character-string quoted, \" \\ and \DDD escapes
  return chunks.map((ch) => {
    let out = '"';
    for (const b of utf8.encode(ch)) {
      if (b === 0x22) out += '\\"';
      else if (b === 0x5c) out += '\\\\';
      else if (b < 0x20 || b > 0x7e) out += '\\' + String(b).padStart(3, '0');
      else out += String.fromCharCode(b);
    }
    return out + '"';
  }).join(' ');
}

export const POINTER_TXT = {
  name: 'pointer-txt',
  about: 'splitTxt()/joinTxtData(): chunks of at most 255 bytes that join back, the presentation format round trip, garbage',
  gen(rng, state, i) {
    const how = rng.int(4);
    let s;
    if (how === 0) s = rng.ascii(lengthNear(rng, 255) + rng.pick([0, 255, 510]));
    else if (how === 1) s = rng.text(rng.int(400)).replace(/[\ud800-\udfff]/g, '');
    else if (how === 2) s = '\u20ac'.repeat(rng.int(200)) + '\ud83d\ude00'.repeat(rng.int(100)) + '\u00e9'.repeat(rng.int(300));
    else s = rng.text(rng.int(300));
    return { label: ['ascii', 'text', 'multibyte', 'with lone surrogates'][how], input: s, garbage: rng.text(rng.int(60)) + rng.pick(['"', '\\', '"a"', '\\999', '\\', '"\\"', '" "', '']) , i };
  },
  run(c) {
    const chunks = splitTxt(c.input);
    const joined = joinTxtData(presentation(chunks));
    return { chunks, joined, junk: joinTxtData(c.garbage), junk2: joinTxtData('"' + c.garbage + '"') };
  },
  check(c, { result }) {
    const p = [];
    const { chunks, joined, junk, junk2 } = result;
    if (!Array.isArray(chunks) || chunks.length < 1) return ['splitTxt returned ' + describe(chunks, 40)];
    if (chunks.join('') !== c.input) p.push('the chunks do not join back to the string');
    for (const ch of chunks) if (utf8.encode(ch).length > SPEC.txt) p.push('a chunk of ' + utf8.encode(ch).length + ' bytes, over 255');
    const wellFormed = c.input.isWellFormed();
    if (wellFormed && joined !== c.input) p.push('joinTxtData(presentation(splitTxt(s))) is not s');
    if (typeof junk !== 'string' || typeof junk2 !== 'string') p.push('joinTxtData returned a non-string');
    return p;
  },
  show: (c) => describe({ input: c.input, garbage: c.garbage }, 500),
};

// ---------------------------------------------------------------------------------------------
// magnet-parse
// ---------------------------------------------------------------------------------------------

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** encodeURIComponent for any string: a lone surrogate (which it refuses) becomes U+FFFD first. */
const enc = (s) => encodeURIComponent(s.toWellFormed());
const sameUnique = (list) => {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

function magnetCase(rng) {
  const params = [];
  const btihs = [];
  let valid = true;
  const nXt = rng.weighted([[1, 0], [6, 1], [2, 2], [1, 3]]);
  const hexA = rng.hex(40);
  for (let i = 0; i < nXt; i++) {
    const how = rng.int(8);
    let v;
    let good = true;
    if (how === 0) v = hexA;
    else if (how === 1) v = hexA.toUpperCase();
    else if (how === 2) v = rng.hex(40);
    else if (how === 3) v = rng.hex(39);
    else if (how === 4) v = rng.chars(32, B32);
    else if (how === 5) v = rng.hex(41);
    else if (how === 6) v = ' ' + hexA + ' ';
    else v = 'zz' + rng.hex(38);
    const hex40 = /^[0-9a-fA-F]{40}$/.test(v.trim());
    const b32 = /^[a-z2-7]{32}$/i.test(v.trim());
    good = hex40 || b32;
    params.push(['xt', 'urn:btih:' + v, good ? v.trim() : null]);
    btihs.push({ v: v.trim(), good, hex40 });
  }
  if (rng.chance(0.3)) params.push(['xt', 'urn:btmh:1220' + rng.hex(64), 'ignored']);
  const dn = rng.chance(0.6) ? rng.text(rng.int(20)) : null;
  if (dn !== null) params.push(['dn', dn, null]);
  const lists = { tr: [], ws: [], xs: [] }; // filled from the final order below
  for (const k of ['tr', 'ws', 'xs']) {
    for (let i = 0; i < rng.int(5); i++) {
      const v = rng.chance(0.8) ? 'https://h' + rng.int(5) + '.example/' + rng.ascii(rng.int(6)) : rng.pick(['', ' ', rng.text(4)]);
      params.push([k, v.toWellFormed(), null]);
    }
  }
  const order = rng.shuffle(params.slice());
  const uri = 'magnet:?' + order.map(([k, v]) => k + '=' + (k === 'xt' ? v.replace(/ /g, '%20') : enc(v))).join('&');
  // expected
  let expected = null;
  const anyBad = btihs.some((b) => !b.good);
  const distinct = new Set(btihs.filter((b) => b.good).map((b) => normalizeLower(b)));
  for (const [k, v] of order) if (k in lists) lists[k].push(v);
  if (!anyBad && btihs.length > 0 && distinct.size === 1) {
    expected = { btih: [...distinct][0], tr: sameUnique(lists.tr), ws: sameUnique(lists.ws), xs: sameUnique(lists.xs) };
  }
  return { uri, expected, label: 'built ' + order.length + ' params, ' + btihs.length + ' xt' };
}

function normalizeLower(b) {
  if (b.hex40) return b.v.toLowerCase();
  return 'base32:' + b.v.toLowerCase(); // compared only for equality of spellings; the decoded value is checked against normalizeBtih below
}

export const MAGNET_PARSE = {
  name: 'magnet-parse',
  about: 'parseMagnet() and normalizeBtih(): generated links (hex and base32 infohashes, repeated tr/ws/xs) against a model, and garbage',
  gen(rng, state, i) {
    if (rng.chance(0.25)) {
      const text = randomText(rng);
      return { label: 'garbage', uri: text, expected: undefined, i };
    }
    const c = magnetCase(rng);
    if (rng.chance(0.2)) {
      const bytes = mutateBytes(rng, utf8.encode(c.uri), { maxLen: 4000 });
      return { label: c.label + ' mutated', uri: new TextDecoder().decode(bytes), expected: undefined, i };
    }
    return Object.assign(c, { i });
  },
  run(c) {
    return { magnet: parseMagnet(c.uri), norm: normalizeBtih(c.uri), norm2: normalizeBtih(c.uri.slice(0, 80)) };
  },
  check(c, { result }) {
    const p = [];
    const { magnet, norm, norm2 } = result;
    if (norm !== null && !/^[0-9a-f]{40}$/.test(norm)) p.push('normalizeBtih returned ' + describe(norm, 60));
    if (norm2 !== null && !/^[0-9a-f]{40}$/.test(norm2)) p.push('normalizeBtih returned ' + describe(norm2, 60));
    if (magnet !== null) {
      if (!/^[0-9a-f]{40}$/.test(magnet.btih)) p.push('an accepted magnet has btih ' + describe(magnet.btih, 60));
      for (const k of ['tr', 'ws', 'xs']) {
        if (!Array.isArray(magnet[k]) || magnet[k].some((x) => typeof x !== 'string' || !x) || new Set(magnet[k]).size !== magnet[k].length) p.push('magnet ' + k + ' is not a list of distinct non-empty strings');
      }
      if (magnet.dn !== null && (typeof magnet.dn !== 'string' || !magnet.dn)) p.push('magnet dn is ' + describe(magnet.dn, 40));
    }
    if (c.expected !== undefined) {
      if (c.expected === null && magnet !== null) p.push('accepted a link the model refuses (a bad or ambiguous infohash)');
      if (c.expected !== null) {
        if (magnet === null) p.push('refused a link the model accepts');
        else {
          if (c.expected.btih.startsWith('base32:')) {
            if (!/^[0-9a-f]{40}$/.test(magnet.btih)) p.push('base32 infohash not decoded');
          } else if (magnet.btih !== c.expected.btih) p.push('btih ' + magnet.btih + ', the model has ' + c.expected.btih);
          for (const k of ['tr', 'ws', 'xs']) if (!isDeepStrictEqual(magnet[k], c.expected[k])) p.push(k + ' is ' + describe(magnet[k], 80) + ', the model has ' + describe(c.expected[k], 80));
        }
      }
    }
    return p;
  },
  show: (c) => describe(c.uri, 700),
};

export const TARGETS = [POINTER_PARSE, POINTER_TXT, MAGNET_PARSE];
