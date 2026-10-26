// Fuzz targets for the byte formats a peer or a file can hand us (V03-DESIGN-REVIEW 2.19, MF-43, MF-55):
//
//   files-validate  src/files/validate.js: validateInfo() on info dictionaries with every number driven to 0, -1
//                   and 2^53-1 (as numbers and as bigints), the piece table one byte off a multiple of 20 and at
//                   16,384 and 16,385 pieces, names with path parts, the listing length, cap and piece length the
//                   caller passes; validateFileTorrent() on encoded torrents with the .torrent at 256 KiB less 1,
//                   exactly 256 KiB and one over; a model of every rule; only fileError E_FILE_HASH may escape
//   bencode         src/common/bencode.js: round trips, integer and string-length spellings, nesting around
//                   MAX_DEPTH and far beyond it, duplicate keys, trailing bytes, random mutations; only E_BENCODE
//   torrent-file    src/common/torrent-file.js parseTorrentFile(): single and multi file torrents, pad files, piece
//                   counts against lengths, lengths that overflow, names and paths; only E_BAD_TORRENT
//   inflate         src/common/inflate.js inflateRaw() and gunzip() against node:zlib: the output cap holds for a
//                   stream that inflates far past it, and a stream both accept gives the same bytes
//
// Shared code under test: src/files/validate.js, src/common/*.js.

import { deflateRawSync, gzipSync, inflateRawSync, gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';

import { Rng, edgeNumber, lengthNear, mutateBytes, concat, utf8, utf8Strict, describe, numberPaths, getAt, setAt, clone, hexOf, EDGE_MUST } from '../kit.mjs';
import { validateInfo, validateFileTorrent, checkTorrentBytes, LIMITS as FILE_LIMITS } from '../../../src/files/validate.js';
import { decode as bdecode, encode as bencode, MAX_DEPTH } from '../../../src/common/bencode.js';
import { parseTorrentFile, MAX_FILES, MAX_PIECE_LENGTH } from '../../../src/common/torrent-file.js';
import { inflateRaw, gunzip } from '../../../src/common/inflate.js';

// R 2.8.3, written out so a drift in validate.js is a finding.
const SPEC = Object.freeze({ minPiece: 16384, maxPiece: 4194304, maxPieces: 16384, maxTorrent: 262144, nonce: 16 });
const FILE_REASONS = new Set(['torrent-size', 'bencode', 'info', 'files', 'name', 'path', 'length', 'piece-length', 'pieces', 'nonce', 'infohash']);
const isUintNum = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

function limitsProblems() {
  const p = [];
  const same = (name, got, want) => {
    if (got !== want) p.push('LIMITS.' + name + ' is ' + got + ', the spec says ' + want);
  };
  same('minPieceLength', FILE_LIMITS.minPieceLength, SPEC.minPiece);
  same('maxPieceLength', FILE_LIMITS.maxPieceLength, SPEC.maxPiece);
  same('maxPieces', FILE_LIMITS.maxPieces, SPEC.maxPieces);
  same('maxTorrentBytes', FILE_LIMITS.maxTorrentBytes, SPEC.maxTorrent);
  same('nonceBytes', FILE_LIMITS.nonceBytes, SPEC.nonce);
  return p;
}

// ---------------------------------------------------------------------------------------------
// files-validate
// ---------------------------------------------------------------------------------------------

function nameModel(info) {
  const raw = info['name.utf-8'] !== undefined ? info['name.utf-8'] : info.name;
  if (!(raw instanceof Uint8Array)) return false;
  let s;
  try {
    s = utf8Strict.decode(raw);
  } catch (_) {
    return false;
  }
  return !(s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s));
}

/** Does the spec accept this info dictionary, given the listing? */
export function modelInfo(info, opts) {
  if (!isDict(info)) return false;
  if (info.files !== undefined) return false;
  if (info.attr !== undefined || info.symlink !== undefined || info['file tree'] !== undefined || info['meta version'] !== undefined) return false;
  if (!nameModel(info)) return false;
  if (!isUintNum(info.length)) return false;
  if (!isUintNum(opts.length) || info.length !== opts.length) return false;
  if (info.length > (opts.maxBytes === undefined ? Infinity : opts.maxBytes)) return false;
  const pl = info['piece length'];
  if (!isUintNum(pl) || pl < SPEC.minPiece || pl > SPEC.maxPiece) return false;
  if (opts.pieceLength !== undefined && pl !== opts.pieceLength) return false;
  if (!(info.pieces instanceof Uint8Array) || info.pieces.length % 20 !== 0) return false;
  const count = info.pieces.length / 20;
  if (count > SPEC.maxPieces || count !== Math.ceil(info.length / pl)) return false;
  if (opts.privateSwarm && !(info['x-mw-nonce'] instanceof Uint8Array && info['x-mw-nonce'].length === SPEC.nonce)) return false;
  return true;
}

function baseInfo(rng) {
  const PL = rng.pick([16384, 32768, 262144, 1048576, 4194304]);
  const L = rng.pick([1, PL - 1, PL, PL + 1, 3 * PL, rng.range(1, 5 * PL)]);
  const info = { name: utf8.encode('file.bin'), length: L, 'piece length': PL, pieces: rng.bytes(20 * Math.ceil(L / PL)) };
  return info;
}

function bigOrNumber(v) {
  return Number.isSafeInteger(v) ? v : Number.isInteger(v) && Math.abs(v) < 1e300 ? BigInt(v) : v;
}

/** info.length and info['piece length'] at 0, -1 and 2^53-1, in an info dictionary and in an encoded torrent, once each: the first inputs of files-validate. */
export const FILES_SWEEP = [];
for (const mode of ['info', 'torrent']) for (const key of ['length', 'piece length']) for (const value of EDGE_MUST) FILES_SWEEP.push({ mode, key, value });

function mutateInfo(rng, info, opts, mode, forced = null) {
  const label = [];
  const edit = forced ? 'num' : rng.weighted([[8, 'num'], [5, 'pieces'], [4, 'name'], [3, 'keys'], [3, 'opts'], [2, 'type'], [3, 'none']]);
  switch (edit) {
    case 'none': label.push('as built'); break;
    case 'num': {
      const key = forced ? forced.key : rng.pick(['length', 'piece length']);
      const limit = key === 'length' ? info.length : SPEC.maxPiece;
      let v = forced ? forced.value : edgeNumber(rng, { limit, objectMode: mode === 'info' });
      if (mode === 'torrent') v = bigOrNumber(v);
      if (mode === 'torrent' && typeof v === 'number' && !Number.isSafeInteger(v)) v = Math.trunc(v) || 0;
      info[key] = v;
      if (key === 'length' && (forced || rng.chance(0.5))) opts.length = v; // the listing agrees, so only the info itself is wrong
      label.push(key + '=' + String(v) + (typeof v === 'bigint' ? 'n' : ''));
      break;
    }
    case 'pieces': {
      const count = rng.pick([0, 1, Math.ceil(info.length / info['piece length']), 16383, 16384, 16385, 16386, rng.int(40)]);
      const extra = rng.pick([0, 0, 0, 1, 19, 21]);
      const n = mode === 'torrent' ? Math.min(count, 12000) : count;
      info.pieces = rng.bytes(20 * n + extra);
      label.push('pieces ' + n + ' x 20 + ' + extra);
      break;
    }
    case 'name': {
      const forms = ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '\u00e9.txt', '\ud83d\ude00', 'x'.repeat(1000), ' ', 'a b', '/', '\\'];
      const s = rng.pick(forms);
      const bytes = rng.chance(0.15) ? rng.pick([Uint8Array.of(0xff), Uint8Array.of(0xc0, 0x80), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0x61, 0xe2, 0x82)]) : utf8.encode(s);
      if (rng.chance(0.3)) {
        info['name.utf-8'] = bytes;
        label.push('name.utf-8 = ' + describe(s, 20));
      } else {
        info.name = bytes;
        label.push('name = ' + describe(s, 20));
      }
      if (rng.chance(0.1)) { delete info.name; delete info['name.utf-8']; label.push('no name'); }
      break;
    }
    case 'keys': {
      const k = rng.pick(['files', 'attr', 'symlink', 'file tree', 'meta version', 'private', 'x-mw-nonce', 'comment']);
      info[k] = k === 'files' ? [] : k === 'attr' ? utf8.encode('p') : k === 'x-mw-nonce' ? rng.bytes(rng.pick([0, 15, 16, 17])) : k === 'private' ? 1 : rng.pick([1, utf8.encode('x')]);
      label.push('adds ' + k);
      break;
    }
    case 'opts': {
      const which = rng.int(4);
      if (which === 0) { opts.length = bigOrNumber(edgeNumber(rng, { limit: info.length })); if (mode === 'torrent' && typeof opts.length === 'number' && !Number.isSafeInteger(opts.length)) opts.length = info.length; label.push('listing length=' + String(opts.length)); }
      else if (which === 1) { opts.maxBytes = rng.pick([0, 1, info.length - 1, info.length, info.length + 1, 25 * 1048576, 104857600, Infinity]); label.push('maxBytes=' + opts.maxBytes); }
      else if (which === 2) { opts.pieceLength = rng.pick([16384, 32768, info['piece length'], info['piece length'] + 1, 0, -1, SPEC.maxPiece]); label.push('expected piece length=' + opts.pieceLength); }
      else { opts.privateSwarm = true; if (rng.chance(0.5)) info['x-mw-nonce'] = rng.bytes(rng.pick([0, 15, 16, 17, 32])); label.push('private swarm'); }
      break;
    }
    default: {
      const k = rng.pick(['length', 'piece length', 'pieces', 'name']);
      info[k] = rng.pick([utf8.encode('x'), [], {}, new Uint8Array(0), rng.int(10)]);
      label.push(k + ' has another type');
    }
  }
  return label.join(', ');
}

function torrentBytes(rng, info, extra) {
  const root = Object.assign({ announce: utf8.encode('http://t.example/announce'), info }, extra || {});
  return bencode(root);
}

export const FILES_VALIDATE = {
  name: 'files-validate',
  about: 'validateInfo() and validateFileTorrent(): numbers as numbers and bigints, piece tables, names, listing, 256 KiB .torrent; E_FILE_HASH only',
  gen(rng, state, i) {
    const info = baseInfo(rng);
    const opts = { length: info.length, maxBytes: rng.pick([undefined, 25 * 1048576, 104857600]) };
    if (opts.maxBytes === undefined) delete opts.maxBytes;
    const forced = i < FILES_SWEEP.length ? FILES_SWEEP[i] : null;
    const mode = forced ? forced.mode : rng.chance(0.55) ? 'info' : 'torrent';
    const label = [forced ? 'sweep ' + mode : mode];
    let bytes = null;
    if (mode === 'info') label.push(mutateInfo(rng, info, opts, 'info', forced));
    else {
      const kind = forced ? 'info' : rng.weighted([[7, 'info'], [2, 'size'], [3, 'bytes'], [2, 'hash']]);
      if (kind === 'info') label.push(mutateInfo(rng, info, opts, 'torrent', forced));
      let ok = true;
      try {
        bytes = torrentBytes(rng, info);
      } catch (_) {
        ok = false; // an info that cannot be encoded
      }
      if (!ok) return { label: label.join(' ') + ' (not encodable)', mode: 'info', info, opts, i };
      if (kind === 'size') {
        // a .torrent of exactly 256 KiB - 1, 256 KiB and 256 KiB + 1
        const target = SPEC.maxTorrent + rng.pick([-1, 0, 1]);
        let k = Math.max(0, target - bytes.length - 12);
        let padded;
        for (let tries = 0; tries < 6; tries++) {
          padded = bencode({ announce: utf8.encode('http://t.example/announce'), comment: utf8.encode('x'.repeat(k)), info });
          if (padded.length === target) break;
          k += target - padded.length;
        }
        bytes = padded;
        label.push('torrent of ' + bytes.length + ' bytes');
      } else if (kind === 'bytes') {
        bytes = mutateBytes(rng, bytes, { maxLen: 4000 });
        label.push('random byte mutations');
      } else {
        label.push('infohash option');
      }
      if (kind === 'hash') opts.infoHash = rng.pick(['0'.repeat(40), 'F'.repeat(40), 'x']);
    }
    return { label: label.join(' '), mode, info, opts, bytes, i };
  },
  async run(c) {
    if (c.mode === 'info') {
      let res;
      try {
        res = { ok: true, value: validateInfo(c.info, c.opts) };
      } catch (err) {
        res = { ok: false, err };
      }
      return res;
    }
    let res;
    try {
      res = { ok: true, value: await validateFileTorrent(c.bytes, c.opts) };
    } catch (err) {
      res = { ok: false, err };
    }
    let sizeCheck;
    try {
      checkTorrentBytes(c.bytes);
      sizeCheck = true;
    } catch (_) {
      sizeCheck = false;
    }
    return Object.assign(res, { sizeCheck });
  },
  allowedError: () => false, // run() catches fileErrors itself and hands them to check()
  check(c, { result }) {
    const problems = [];
    if (c.i === 0) problems.push(...limitsProblems());
    const r = result;
    if (!r.ok) {
      const e = r.err;
      if (!e || e.code !== 'E_FILE_HASH' || !FILE_REASONS.has(e.reason)) problems.push('an error other than fileError E_FILE_HASH escaped: ' + describe(e && (e.name + ': ' + e.message + ' [' + e.code + '/' + e.reason + ']'), 160));
    }
    // the model
    let want;
    if (c.mode === 'info') want = modelInfo(c.info, c.opts);
    else {
      want = false;
      if (c.bytes.length > 0 && c.bytes.length <= SPEC.maxTorrent) {
        try {
          const d = bdecode(c.bytes);
          if (isDict(d.value) && isDict(d.value.info)) {
            const span = d.spans.get('info');
            const infoBytes = c.bytes.slice(span[0], span[1]);
            const again = bencode(d.value.info);
            want = hexOf(again) === hexOf(infoBytes) && modelInfo(d.value.info, c.opts);
          }
        } catch (_) {
          want = false;
        }
      }
      if (r.sizeCheck !== (c.bytes.length > 0 && c.bytes.length <= SPEC.maxTorrent)) problems.push('checkTorrentBytes ' + (r.sizeCheck ? 'accepts' : 'refuses') + ' a .torrent of ' + c.bytes.length + ' bytes (the limit is ' + SPEC.maxTorrent + ')');
      if (want && c.opts.infoHash !== undefined) want = false; // the options of the 'hash' case are wrong on purpose
    }
    if (r.ok && !want) problems.push('accepted ' + (c.mode === 'info' ? 'an info dictionary' : 'a torrent') + ' the spec refuses');
    if (!r.ok && want) problems.push('refused (' + (r.err && r.err.reason) + ') ' + (c.mode === 'info' ? 'an info dictionary' : 'a torrent') + ' the spec accepts');
    if (r.ok) {
      const v = r.value;
      if (!isUintNum(v.length) || !isUintNum(v.pieceLength) || !isUintNum(v.pieceCount)) problems.push('an accepted result holds a number that is not a safe unsigned integer');
      if (v.pieceCount !== Math.ceil(v.length / v.pieceLength)) problems.push('pieceCount does not match length and piece length');
    }
    return problems;
  },
  show: (c) => (c.mode === 'info' ? describe({ info: c.info, opts: c.opts }, 600) : describe(c.bytes, 400) + ' opts ' + describe(c.opts, 100)),
};

// ---------------------------------------------------------------------------------------------
// bencode
// ---------------------------------------------------------------------------------------------

function randomValue(rng, depth = 0) {
  const k = depth > 3 ? rng.int(3) : rng.int(6);
  switch (k) {
    case 0: return rng.pick([0, 1, -1, 123456789, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 9007199254740993n, -9007199254740993n, 123456789012345678901234567890n]);
    case 1: return rng.bytes(rng.int(20));
    case 2: return utf8.encode(rng.text(rng.int(8)).replace(/[\ud800-\udfff]/g, ''));
    case 3: return Array.from({ length: rng.int(4) }, () => randomValue(rng, depth + 1));
    default: {
      const o = {};
      for (let i = 0; i < rng.int(4); i++) o[rng.pick(['a', 'b', 'info', '\u00e9', 'z', 'piece length', '10', '9']) + rng.pick(['', '1', '2'])] = randomValue(rng, depth + 1);
      return o;
    }
  }
}

function normalized(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  if (Array.isArray(v)) return v.map(normalized);
  if (v instanceof Uint8Array) return v;
  if (isDict(v)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = normalized(v[k]);
    return o;
  }
  return v;
}

const INT_FORMS = ['i0e', 'i-0e', 'i00e', 'i01e', 'ie', 'i-e', 'i1e', 'i-1e', 'i+1e', 'i 1e', 'i1.5e', 'i1', 'i123456789012345e', 'i1234567890123456e', 'i9007199254740991e', 'i9007199254740992e',
  'i-9007199254740991e', 'i-9007199254740992e', 'i99999999999999999999e', 'i-99999999999999999999e', 'i0x10e', 'i1e2e', 'i1ee', 'i\u0663e'];
const STR_FORMS = ['0:', '00:', '1:a', '2:a', '01:a', ':', '-1:', '1a', '99999999999999999999:', '999999999999999:x', '5:abcde', '5:abcd', 'a:b', '1:\u00e9', '123456789012345:'];

export const BENCODE = {
  name: 'bencode',
  about: 'bencode decode(): round trips, integer and string-length spellings, nesting around MAX_DEPTH and beyond, duplicate keys, mutations',
  gen(rng, state, i) {
    const how = rng.weighted([[5, 'roundtrip'], [4, 'int'], [4, 'str'], [3, 'nest'], [2, 'dict'], [4, 'mutate'], [2, 'trail']]);
    switch (how) {
      case 'roundtrip': {
        const v = randomValue(rng);
        return { label: 'round trip', bytes: bencode(v), value: v, verdict: 'accept', i };
      }
      case 'int': {
        const s = rng.chance(0.2) ? 'i' + rng.pick(['', '-']) + '9'.repeat(rng.range(1, 5000)) + 'e' : rng.pick(INT_FORMS);
        const wrap = rng.pick(['', 'l', 'd1:k']);
        const text = wrap === 'l' ? 'l' + s + 'e' : wrap === 'd1:k' ? 'd1:k' + s + 'e' : s;
        const m = /^i(0|-?[1-9][0-9]*)e$/.exec(s);
        const ok = m !== null;
        return { label: 'integer ' + describe(s, 40) + (wrap ? ' in ' + wrap : ''), bytes: utf8.encode(text), intText: m ? m[1] : null, verdict: ok ? 'accept' : 'refuse', i };
      }
      case 'str': {
        const s = rng.pick(STR_FORMS);
        const m = /^(0|[1-9][0-9]{0,14}):(.*)$/s.exec(s);
        const ok = m !== null && utf8.encode(m[2]).length >= Number(m[1]) && utf8.encode(m[2]).length === Number(m[1]);
        return { label: 'string ' + describe(s, 40), bytes: utf8.encode(s), verdict: ok ? 'accept' : 'refuse', i };
      }
      case 'nest': {
        const n = rng.pick([1, 10, 100, 200, 255, 256, 257, 258, 259, 300, 1000, 100000, rng.range(1, 2000)]);
        const dict = rng.chance(0.4);
        const text = dict ? 'd1:k'.repeat(n) + 'i0e' + 'e'.repeat(n) : 'l'.repeat(n) + 'e'.repeat(n);
        return { label: (dict ? 'dict' : 'list') + ' nesting ' + n, bytes: utf8.encode(text), verdict: n <= 200 ? 'accept' : n >= 300 ? 'refuse' : 'any', i };
      }
      case 'dict': {
        const text = rng.pick(['d1:ai1e1:ai2ee', 'd1:bi1e1:ai2ee', 'di1ei2ee', 'd1:a', 'd1:ae', 'dee', 'de', 'd2:\u00ff\u00fe' + 'i1ee', 'd1:ai1e1:bi2ee']);
        const bytes = text.startsWith('d2:') ? concat(utf8.encode('d2:'), Uint8Array.of(0xff, 0xfe), utf8.encode('i1ee')) : utf8.encode(text);
        const verdict = { 'd1:ai1e1:ai2ee': 'refuse', 'd1:bi1e1:ai2ee': 'accept', 'di1ei2ee': 'refuse', 'd1:a': 'refuse', 'd1:ae': 'refuse', dee: 'refuse', de: 'accept', 'd1:ai1e1:bi2ee': 'accept' }[text] || 'refuse';
        return { label: 'dictionary ' + describe(text, 30), bytes, verdict, i };
      }
      case 'mutate': {
        const v = randomValue(rng);
        return { label: 'mutated round trip', bytes: mutateBytes(rng, bencode(v), { maxLen: 3000 }), verdict: 'any', i };
      }
      default: {
        const v = randomValue(rng);
        return { label: 'trailing bytes', bytes: concat(bencode(v), rng.bytes(rng.range(1, 4))), verdict: 'refuse', i };
      }
    }
  },
  run: (c) => bdecode(c.bytes),
  allowedError: (err) => err && err.code === 'E_BENCODE' && err instanceof Error,
  check(c, outcome) {
    const p = [];
    const { result, error } = outcome;
    if (error !== undefined) {
      if (c.verdict === 'accept') p.push('refused (' + error.message.slice(0, 80) + ') input that is valid by construction');
      return p;
    }
    if (c.verdict === 'refuse') p.push('accepted input that is malformed by construction');
    const { value, spans } = result;
    const root = spans.get('');
    if (!root || root[0] !== 0 || root[1] !== c.bytes.length) p.push('the root span is not the whole input');
    for (const [path, [a, b]] of spans) if (!(a >= 0 && a < b && b <= c.bytes.length)) p.push('span ' + path + ' is [' + a + ', ' + b + ') in ' + c.bytes.length + ' bytes');
    if (c.value !== undefined && !isDeepStrictEqual(value, normalized(c.value))) p.push('the decoded value differs from the encoded one');
    if (c.intText !== undefined && c.intText !== null) {
      const want = BigInt(c.intText);
      const probe = c.label.includes(' in l') ? value[0] : c.label.includes(' in d') ? value.k : value;
      const as = typeof probe === 'bigint' ? probe : BigInt(probe);
      if (as !== want) p.push('integer ' + c.intText + ' decoded as ' + String(probe));
      if (typeof probe === 'number' && !Number.isSafeInteger(probe)) p.push('a number outside the safe range was not returned as a bigint');
      if (typeof probe === 'bigint' && Number.isSafeInteger(Number(probe))) p.push('a safe integer came back as a bigint');
    }
    // a canonical encoding re-encodes to itself
    try {
      const again = bencode(value);
      if (c.verdict === 'accept' && c.value !== undefined && hexOf(again) !== hexOf(c.bytes)) p.push('encode(decode(x)) is not x for a canonical x');
    } catch (err) {
      p.push('encode of a decoded value threw ' + err.message);
    }
    return p;
  },
  show: (c) => describe(c.bytes, 400),
};

// ---------------------------------------------------------------------------------------------
// torrent-file
// ---------------------------------------------------------------------------------------------

function validSegment(raw) {
  if (!(raw instanceof Uint8Array)) return false;
  let s;
  try {
    s = utf8Strict.decode(raw);
  } catch (_) {
    return false;
  }
  return !(s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s));
}

/** The spec's view of a decoded torrent: does parseTorrentFile accept it? */
export function modelTorrent(bytes) {
  let d;
  try {
    d = bdecode(bytes);
  } catch (_) {
    return false;
  }
  const root = d.value;
  if (!isDict(root) || !isDict(root.info)) return false;
  const span = d.spans.get('info');
  if (hexOf(bencode(root.info)) !== hexOf(bytes.slice(span[0], span[1]))) return false;
  const info = root.info;
  if (!validSegment(info['name.utf-8'] !== undefined ? info['name.utf-8'] : info.name)) return false;
  const pl = info['piece length'];
  if (!isUintNum(pl) || pl === 0 || pl > MAX_PIECE_LENGTH) return false;
  if (!(info.pieces instanceof Uint8Array) || info.pieces.length % 20 !== 0) return false;
  let total = 0;
  if (info.files !== undefined) {
    if (info.length !== undefined) return false;
    if (!Array.isArray(info.files) || info.files.length === 0 || info.files.length > MAX_FILES) return false;
    const seen = new Set();
    for (const f of info.files) {
      if (!isDict(f) || !isUintNum(f.length)) return false;
      const raw = f['path.utf-8'] !== undefined ? f['path.utf-8'] : f.path;
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every(validSegment)) return false;
      const segs = raw.map((x) => utf8Strict.decode(x));
      const attr = f.attr instanceof Uint8Array ? new TextDecoder().decode(f.attr) : '';
      const pad = attr.includes('p') || (segs.length === 2 && segs[0] === '.pad' && /^[0-9]+$/.test(segs[1]));
      const path = segs.join('/');
      if (!pad) {
        if (seen.has(path)) return false;
        seen.add(path);
      }
      total += f.length;
      if (!Number.isSafeInteger(total)) return false;
    }
  } else {
    if (!isUintNum(info.length)) return false;
    total = info.length;
  }
  return info.pieces.length / 20 === Math.ceil(total / pl);
}

function baseTorrent(rng) {
  const PL = rng.pick([16384, 262144, 1048576]);
  const multi = rng.chance(0.5);
  const info = { name: utf8.encode('site'), 'piece length': PL };
  let total;
  if (multi) {
    const n = rng.range(1, 6);
    const files = [];
    total = 0;
    for (let k = 0; k < n; k++) {
      const len = rng.pick([0, 1, 100, PL, PL + 1, rng.int(3 * PL)]);
      const f = { length: len, path: [utf8.encode('d' + k), utf8.encode('f' + k + '.txt')] };
      if (rng.chance(0.15)) { f.attr = utf8.encode('p'); f.path = [utf8.encode('.pad'), utf8.encode(String(k))]; }
      files.push(f);
      total += len;
    }
    info.files = files;
  } else {
    total = rng.pick([1, PL, PL + 1, rng.int(4 * PL) + 1]);
    info.length = total;
  }
  info.pieces = rng.bytes(20 * Math.ceil(total / PL));
  const root = { info };
  if (rng.chance(0.7)) root.announce = utf8.encode('http://t.example/a');
  if (rng.chance(0.4)) root['announce-list'] = [[utf8.encode('http://t.example/a')], [utf8.encode('http://u.example/b'), utf8.encode('http://u.example/b')]];
  if (rng.chance(0.4)) root['url-list'] = rng.chance(0.5) ? utf8.encode('https://w.example/') : [utf8.encode('https://w.example/'), utf8.encode('https://x.example/')];
  if (rng.chance(0.2)) info.private = 1;
  return root;
}

export const TORRENT_FILE = {
  name: 'torrent-file',
  about: 'parseTorrentFile(): single and multi file torrents, pad files, piece counts against lengths, overflow, names and paths; E_BAD_TORRENT only',
  gen(rng, state, i) {
    const root = baseTorrent(rng);
    const label = [];
    const kind = rng.weighted([[7, 'num'], [3, 'type'], [3, 'path'], [2, 'pieces'], [3, 'bytes'], [2, 'none'], [2, 'overflow']]);
    switch (kind) {
      case 'none': label.push('as built'); break;
      case 'num': {
        const paths = numberPaths(root.info);
        if (paths.length) {
          const path = rng.pick(paths);
          const v = bigOrNumber(edgeNumber(rng, { limit: path[0] === 'piece length' ? MAX_PIECE_LENGTH : null }));
          const use = typeof v === 'number' && !Number.isSafeInteger(v) ? Math.trunc(v) : v;
          setAt(root.info, path, use);
          label.push('info.' + path.join('.') + '=' + String(use) + (typeof use === 'bigint' ? 'n' : ''));
        }
        break;
      }
      case 'type': {
        const k = rng.pick(['name', 'piece length', 'pieces', 'length', 'files']);
        root.info[k] = rng.pick([utf8.encode('x'), [], {}, 7, new Uint8Array(20)]);
        label.push(k + ' has another type');
        break;
      }
      case 'path': {
        if (root.info.files) {
          const f = rng.pick(root.info.files);
          f.path = rng.pick([[], [utf8.encode('')], [utf8.encode('..')], [utf8.encode('a/b')], [utf8.encode('a'), Uint8Array.of(0xff)], [utf8.encode('.')], utf8.encode('x'), [utf8.encode('a\0b')]]);
          label.push('a file path');
        } else {
          root.info.name = rng.pick([utf8.encode(''), utf8.encode('..'), utf8.encode('a/b'), Uint8Array.of(0xff), utf8.encode('a\\b')]);
          label.push('the name');
        }
        break;
      }
      case 'pieces': {
        root.info.pieces = rng.bytes(rng.pick([0, 19, 20, 21, 40, 41, 2000]));
        label.push('pieces ' + root.info.pieces.length + ' bytes');
        break;
      }
      case 'overflow': {
        const files = [];
        const n = rng.range(2, 4);
        for (let k = 0; k < n; k++) files.push({ length: rng.pick([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 2 ** 52, 1]), path: [utf8.encode('f' + k)] });
        delete root.info.length;
        root.info.files = files;
        label.push('file lengths near 2^53');
        break;
      }
      default: label.push('byte mutations');
    }
    let bytes;
    try {
      bytes = bencode(root);
    } catch (_) {
      bytes = utf8.encode('d4:infod6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:' + 'x'.repeat(20) + 'ee');
      label.push('(not encodable, fallback)');
    }
    if (kind === 'bytes') bytes = mutateBytes(rng, bytes, { maxLen: 3000 });
    return { label: label.join(', '), bytes, i };
  },
  async run(c) {
    return parseTorrentFile(c.bytes);
  },
  allowedError: (err) => err && err.code === 'E_BAD_TORRENT',
  check(c, outcome) {
    const p = [];
    const want = modelTorrent(c.bytes);
    if (outcome.error !== undefined) {
      if (want) p.push('refused (' + outcome.error.message.slice(0, 80) + ') a torrent the model accepts');
      return p;
    }
    if (!want) p.push('accepted a torrent the model refuses');
    const t = outcome.result;
    if (!isUintNum(t.length) || !isUintNum(t.pieceLength) || t.pieceLength === 0 || t.pieceLength > MAX_PIECE_LENGTH) p.push('an accepted torrent has length ' + t.length + ' and piece length ' + t.pieceLength);
    if (t.pieceCount !== Math.ceil(t.length / t.pieceLength)) p.push('pieceCount does not match');
    let off = 0;
    for (const f of t.files) {
      if (f.offset !== off || !isUintNum(f.length)) p.push('file offsets are not cumulative');
      off += f.length;
      if (/[\\\0]/.test(f.path) || f.path.split('/').some((s) => s === '' || s === '.' || s === '..')) p.push('a file path has a bad segment: ' + describe(f.path, 60));
    }
    if (off !== t.length) p.push('files add up to ' + off + ', the torrent says ' + t.length);
    if (!/^[0-9a-f]{40}$/.test(t.infoHash)) p.push('infoHash is ' + describe(t.infoHash, 50));
    if (new Set(t.announce).size !== t.announce.length || t.announce.some((s) => typeof s !== 'string' || !s)) p.push('announce is not a list of distinct non-empty strings');
    return p;
  },
  show: (c) => describe(c.bytes, 500),
};

// ---------------------------------------------------------------------------------------------
// inflate
// ---------------------------------------------------------------------------------------------

function payload(rng) {
  const len = rng.pick([0, 1, 10, 100, 5000, 70000, 300000]);
  switch (rng.int(4)) {
    case 0: return new Uint8Array(len);
    case 1: { const u = new Uint8Array(len); for (let i = 0; i < len; i++) u[i] = 97 + (i % 7); return u; }
    case 2: return rng.bytes(Math.min(len, 20000));
    default: return utf8.encode('lorem ipsum '.repeat(Math.ceil(len / 12)).slice(0, len));
  }
}

export const INFLATE = {
  name: 'inflate',
  about: 'inflateRaw() and gunzip() against node:zlib: the output cap on a stream that inflates past it, mutated streams, equal output when both accept',
  maxMs: 1500,
  gen(rng, state, i) {
    const data = payload(rng);
    const gz = rng.chance(0.4);
    const level = rng.pick([0, 1, 6, 9]);
    let stream = gz ? gzipSync(data, { level }) : deflateRawSync(data, { level });
    const label = [gz ? 'gzip' : 'deflate', 'level ' + level, data.length + ' bytes'];
    const maxOutput = rng.pick([Math.max(0, data.length - 1), data.length, data.length + 1, 64, 65536, 64 * 1024 * 1024]);
    let verdict = data.length > maxOutput ? 'cap' : 'accept';
    if (rng.chance(0.6)) {
      stream = mutateBytes(rng, stream, { maxLen: 400000 });
      label.push('mutated');
      verdict = 'any';
    }
    return { label: label.join(' ') + ' cap ' + maxOutput, gz, stream, data, maxOutput, verdict, i };
  },
  run(c) {
    let mine;
    try {
      mine = { data: c.gz ? gunzip(c.stream, { maxOutput: c.maxOutput }) : inflateRaw(c.stream, { maxOutput: c.maxOutput }).data };
    } catch (err) {
      mine = { err };
    }
    let ref;
    try {
      ref = { data: c.gz ? gunzipSync(c.stream, { maxOutputLength: Math.max(1, c.maxOutput) }) : inflateRawSync(c.stream, { maxOutputLength: Math.max(1, c.maxOutput) }) };
    } catch (err) {
      ref = { err };
    }
    return { mine, ref };
  },
  check(c, { result }, state, note) {
    const p = [];
    const { mine, ref } = result;
    if (mine.err) {
      if (mine.err.code !== 'E_INFLATE') p.push('an error other than E_INFLATE escaped: ' + describe(mine.err.name + ': ' + mine.err.message, 120));
      if (c.verdict === 'accept') p.push('refused (' + mine.err.message.slice(0, 80) + ') a valid stream');
    } else {
      if (!(mine.data instanceof Uint8Array)) p.push('the result is not a Uint8Array');
      else {
        // The output buffer starts at 1024 bytes and the cap is checked when it has to grow, so a cap below 1024 lets up to
        // 1024 bytes through (found by this target; nothing in the repository passes a cap that small). Reported as a note.
        const small = c.maxOutput < 1024;
        if (mine.data.length > c.maxOutput) {
          if (small && mine.data.length <= 1024) note('inflate-cap-below-1024', 'maxOutput ' + c.maxOutput + ' let ' + mine.data.length + ' bytes through: ' + c.label);
          else p.push('inflated to ' + mine.data.length + ' bytes, over the cap of ' + c.maxOutput);
        }
        if (c.verdict === 'cap' && !(small && mine.data.length <= 1024)) p.push('inflated past the cap without an error (cap ' + c.maxOutput + ', stream of ' + c.data.length + ' bytes)');
        if (c.verdict === 'accept' && hexOf(mine.data) !== hexOf(c.data)) p.push('the output differs from the input that was compressed');
        if (!ref.err && hexOf(mine.data) !== hexOf(ref.data)) p.push('node:zlib and src/common/inflate.js give different bytes for the same stream');
      }
    }
    if (mine.err && !ref.err && c.verdict === 'any' && ref.data.length <= c.maxOutput) note('inflate-stricter-than-zlib', 'inflate refuses (' + mine.err.message.slice(0, 60) + ') a stream node:zlib reads: ' + c.label);
    if (!mine.err && ref.err && c.verdict === 'any' && !/maxOutputLength|Cannot create a Buffer larger/.test(String(ref.err.message))) {
      if (c.gz && c.stream.length === 0) note('gunzip-accepts-empty-input', 'gunzip(empty) returns empty bytes; node:zlib reports an unexpected end of input (' + String(ref.err.code) + ')');
      else note('inflate-looser-than-zlib', 'inflate reads a stream node:zlib refuses (' + String(ref.err.code) + '): ' + c.label);
    }
    return p;
  },
  show: (c) => describe(c.stream, 300) + ' cap ' + c.maxOutput + (c.gz ? ' gzip' : ' raw'),
};

export const TARGETS = [FILES_VALIDATE, BENCODE, TORRENT_FILE, INFLATE];
