// Fuzz targets for the mw_chat1 frame codec (V03-DESIGN-REVIEW 2.7.3, 2.19, MF-43, PEER B8):
//
//   chat-frames   decode() of all thirteen frame types: header bytes (type, version, hop, flags), the
//                 counts and 2-byte lengths inside WANT and HELD, the ENV ciphertext length against the
//                 four buckets, JSON bodies with every number driven to 0, -1 and 2^53-1, fixed-length
//                 bodies one byte short and long, points that are not on the curve
//   chat-point    isOnCurve() against WebCrypto's own check of a P-256 point
//
// decode() never throws and returns { error } for anything malformed (the caller strikes the wire). Each
// mutation carries what the spec says about it: accept (still valid), refuse (malformed by construction)
// or any (the mutation is blind; only the invariants of an accepted frame and "no throw" are asserted).
//
// Shared code under test: src/chat/frames.js.

import {
  Rng, edgeNumber, lengthNear, Raw, spellings, stringify, mutateBytes, concat, utf8, utf8Strict, describe, fakePub, ecdhPoints, hexOf, EDGE_MUST,
} from '../kit.mjs';
import {
  T, HOP_LIMIT, decode, encode, helloBody, xxBody, envBody, roomBody, wantBody, heldBody, ckBody, holdingBody, collectedBody, presBody,
  ichalBody, irespBody, isOnCurve,
} from '../../../src/chat/frames.js';
import * as L from '../../../src/chat/limits.js';

// The table of R 2.7.3, written out so a drift in src/chat/limits.js is a finding.
const SPEC = Object.freeze({
  frameMax: 16384, header: 14, version: 1, flagMask: 7, hopEnv: 4, hopRoom: 3, helloMax: 512, helloLanes: 4, laneName: 32, xxMax: 256, tag: 8,
  point: 65, iv: 12, ctLengths: [272, 1040, 4112, 16016], roomName: 32, roomText: 2000, roomBodyMax: 12288, want: 32, held: 32, ckMax: 400,
  frameId: 32, proof: 32, presBody: 130, challenge: 32, holdingBody: 357,
});
const ID = { HELLO: 1, XX: 2, ENV: 3, ROOM: 4, WANT: 5, HELD: 6, CK: 7, HOLDING: 8, COLLECTED: 9, PRES: 10, SIG: 11, ICHAL: 12, IRESP: 13 };
const NAMES = Object.keys(ID);
const hopLimit = (type) => (type === ID.ENV || type === ID.SIG || type === ID.HOLDING || type === ID.COLLECTED ? SPEC.hopEnv : type === ID.ROOM ? SPEC.hopRoom : 0);
const flagged = (type) => type === ID.ENV || type === ID.SIG;
const JSON_TYPES = new Set([ID.HELLO, ID.ROOM, ID.CK]);
const FIXED = new Map([[ID.HOLDING, SPEC.holdingBody], [ID.COLLECTED, 64], [ID.PRES, SPEC.presBody], [ID.ICHAL, 97], [ID.IRESP, 97]]);

export function chatConstantProblems() {
  const p = [];
  const same = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) p.push('src/chat/limits.js ' + name + ' is ' + JSON.stringify(got) + ', the spec table gives ' + JSON.stringify(want));
  };
  same('FRAME_MAX', L.FRAME_MAX, SPEC.frameMax);
  same('HEADER_BYTES', L.HEADER_BYTES, SPEC.header);
  same('FRAME_VERSION', L.FRAME_VERSION, SPEC.version);
  same('FLAG_MASK', L.FLAG_MASK, SPEC.flagMask);
  same('HELLO_MAX', L.HELLO_MAX, SPEC.helloMax);
  same('HELLO_LANES_MAX', L.HELLO_LANES_MAX, SPEC.helloLanes);
  same('XX_MAX', L.XX_MAX, SPEC.xxMax);
  same('CT_LENGTHS', Array.from(L.CT_LENGTHS), SPEC.ctLengths);
  same('ROOM_BODY_MAX', L.ROOM_BODY_MAX, SPEC.roomBodyMax);
  same('WANT_MAX', L.WANT_MAX, SPEC.want);
  same('HELD_MAX_ITEMS', L.HELD_MAX_ITEMS, SPEC.held);
  same('CK_MAX', L.CK_MAX, SPEC.ckMax);
  same('PRES_BODY', L.PRES_BODY, SPEC.presBody);
  same('HOLDING_BODY', L.HOLDING_BODY, SPEC.holdingBody);
  same('HOP_MAX_ENV', L.HOP_MAX_ENV, SPEC.hopEnv);
  same('HOP_MAX_ROOM', L.HOP_MAX_ROOM, SPEC.hopRoom);
  return p;
}

// ---------------------------------------------------------------------------------------------
// valid frames
// ---------------------------------------------------------------------------------------------

function header(rng, type) {
  return {
    version: 1, hop: rng.int(hopLimit(type) + 1), flags: flagged(type) ? rng.int(8) : 0, day: rng.int(65536), stampNonce: rng.bytes(8),
  };
}

function envBodyOf(rng, state, ctLen) {
  return envBody({ tag: rng.bytes(8), epk: rng.pick(state.points), iv: rng.bytes(12), ct: rng.bytes(ctLen === undefined ? rng.pick([272, 272, 1040, 4112]) : ctLen) });
}

function validHeld(rng, state) {
  const h = header(rng, ID.HELD);
  const t = ID.ENV;
  const inner = encode(t, header(rng, t), envBodyOf(rng, state, 272));
  return { type: ID.HELD, bytes: encode(ID.HELD, h, heldBody([inner])), header: h };
}

function validFrame(rng, state, type) {
  const h = header(rng, type);
  let body;
  switch (type) {
    case ID.HELLO: {
      const lanes = Array.from({ length: rng.int(5) }, (_, k) => 'lane' + k);
      body = helloBody({ site: 'mw1:' + rng.b64(27), owner: rng.chance(0.5) ? null : fakePub(rng), lanes });
      break;
    }
    case ID.XX: body = xxBody(rng.range(1, 3), rng.bytes(rng.range(1, 255))); break;
    case ID.ENV: case ID.SIG: body = envBodyOf(rng, state); break;
    case ID.ROOM:
      body = roomBody({ room: 'general', id: rng.b64Bytes(16), t: rng.int(2 ** 40), text: 'hello ' + rng.ascii(rng.int(40)), author: fakePub(rng), sig: rng.b64Bytes(64) });
      break;
    case ID.WANT: {
      const n = rng.int(33);
      const size = rng.chance(0.5) ? 1 : 8;
      body = wantBody(Array.from({ length: n }, () => rng.bytes(size)));
      break;
    }
    case ID.HELD: {
      const n = rng.int(5);
      const frames = [];
      for (let k = 0; k < n; k++) {
        const t = rng.chance(0.5) ? ID.ENV : ID.SIG;
        frames.push(encode(t, header(rng, t), envBodyOf(rng, state, rng.pick([272, 272, 1040]))));
      }
      body = heldBody(frames);
      break;
    }
    case ID.CK:
      body = ckBody({ v: 2, ledger: rng.b64(27), signer: fakePub(rng), ek: rng.b64(87), epoch: rng.int(1000), exp: rng.int(2 ** 40), sig: rng.b64(86) });
      break;
    case ID.HOLDING: body = holdingBody({ tag: rng.bytes(8), frameId: rng.bytes(32), expiry: rng.int(2 ** 32) }); break;
    case ID.COLLECTED: body = collectedBody({ frameId: rng.bytes(32), proof: rng.bytes(32) }); break;
    case ID.PRES:
      body = presBody({ mode: rng.int(2), slots: Array.from({ length: 8 }, () => rng.bytes(8)), status: rng.range(1, 2), auth: rng.bytes(64) });
      break;
    case ID.ICHAL: body = ichalBody({ challenge: rng.bytes(32), hepk: rng.pick(state.points) }); break;
    default: body = irespBody({ ek: rng.pick(state.points), proof: rng.bytes(32) });
  }
  return { type, bytes: encode(type, h, body), header: h };
}

// ---------------------------------------------------------------------------------------------
// mutations: { bytes, verdict, label }
// ---------------------------------------------------------------------------------------------

const rank = { accept: 0, any: 1, refuse: 2 };
function worse(a, b) {
  return rank[b] > rank[a] ? b : a;
}

function setJsonBody(frame, text) {
  return concat(frame.bytes.subarray(0, SPEC.header), utf8.encode(text));
}

function bodyJson(frame) {
  return JSON.parse(utf8Strict.decode(frame.bytes.subarray(SPEC.header)));
}

/** What the spec says about a frame of this type whose length was changed (the header and the first bytes are as they were). */
function resizeVerdict(type, length) {
  if (type === ID.ENV || type === ID.SIG) {
    // the ciphertext is whatever follows the 85 fixed bytes: another bucket size is another valid frame
    const ct = length - SPEC.header - 85;
    return SPEC.ctLengths.includes(ct) ? 'accept' : 'refuse';
  }
  if (FIXED.has(type)) return length - SPEC.header === FIXED.get(type) ? 'accept' : 'refuse';
  return 'any';
}

function mutate(rng, state, frame, forced = null) {
  const out = { bytes: Uint8Array.from(frame.bytes), verdict: 'accept', label: [NAMES[frame.type - 1]] };
  const type = frame.type;
  const set = (verdict, label) => {
    out.verdict = worse(out.verdict, verdict);
    out.label.push(label);
  };
  const b = out.bytes;
  const kinds = [[1, 'none'], [3, 'type'], [3, 'version'], [4, 'hop'], [4, 'flags'], [1, 'day'], [3, 'truncate'], [3, 'extend'], [2, 'random'], [2, 'bytes']];
  if (JSON_TYPES.has(type)) kinds.push([4, 'pad'], [5, 'json-edge']);
  if (type === ID.HELLO || type === ID.ROOM) kinds.push([5, 'json-len']);
  if (type === ID.WANT || type === ID.HELD) kinds.push([6, 'count']);
  if (type === ID.HELD) kinds.push([5, 'held-len']);
  if (type === ID.ENV || type === ID.SIG) kinds.push([6, 'ct'], [5, 'point']);
  if (type === ID.ICHAL || type === ID.IRESP) kinds.push([8, 'point']);
  if (type === ID.HOLDING) kinds.push([8, 'holding']);
  if (type === ID.PRES) kinds.push([8, 'pres']);
  if (type === ID.XX) kinds.push([8, 'xx']);
  const kind = forced ? forced.kind : rng.weighted(kinds);
  switch (kind) {
    case 'none': break;
    case 'type': {
      const t = rng.pick([0, 14, 15, 255, rng.int(256), rng.range(1, 13)]);
      b[0] = t;
      set(t >= 1 && t <= 13 ? 'any' : 'refuse', 'type byte ' + t);
      break;
    }
    case 'version': {
      const v = forced ? forced.value : rng.pick([0, 1, 2, 255, rng.int(256)]);
      b[1] = v;
      set(v === 1 ? 'accept' : 'refuse', 'version ' + v);
      break;
    }
    case 'hop': {
      const limit = hopLimit(type);
      const h = forced ? forced.value : rng.pick([0, limit, limit + 1, 255, rng.int(256), 3, 4, 5]);
      b[2] = h;
      set(h <= limit ? 'accept' : 'refuse', 'hop ' + h);
      break;
    }
    case 'flags': {
      const f = forced ? forced.value : rng.pick([0, 1, 2, 4, 7, 8, 0x80, 0xff, rng.int(256)]);
      b[3] = f;
      set((f & ~7) === 0 && (f === 0 || flagged(type)) ? 'accept' : 'refuse', 'flags ' + f);
      break;
    }
    case 'day': {
      if (forced) {
        b[4] = forced.value >> 8;
        b[5] = forced.value & 255;
        set('accept', 'day ' + forced.value);
        break;
      }
      b[4] = rng.int(256);
      b.set(rng.bytes(1), 5);
      b.set(rng.bytes(8), 6);
      set('accept', 'day and nonce');
      break;
    }
    case 'truncate': {
      const n = rng.pick([0, 1, 13, 14, 15, b.length - 1, rng.int(b.length + 1)]);
      out.bytes = b.slice(0, Math.min(n, b.length));
      if (out.bytes.length === b.length) set('accept', 'not truncated');
      else if (out.bytes.length < SPEC.header) set('refuse', 'cut to ' + n);
      else set(resizeVerdict(type, out.bytes.length), 'cut to ' + n);
      break;
    }
    case 'extend': {
      const n = rng.pick([1, 2, 8, 64, SPEC.frameMax - b.length, SPEC.frameMax - b.length + 1, rng.int(200)]);
      if (n <= 0) { set('accept', 'nothing added'); break; }
      out.bytes = concat(b, rng.bytes(n));
      if (out.bytes.length > SPEC.frameMax) set('refuse', 'grown to ' + out.bytes.length);
      else set(resizeVerdict(type, out.bytes.length), 'added ' + n + ' bytes');
      break;
    }
    case 'pad': {
      if (!JSON_TYPES.has(type)) { set('accept', 'no pad'); break; }
      const max = type === ID.HELLO ? SPEC.helloMax : type === ID.CK ? SPEC.ckMax : SPEC.roomBodyMax;
      const body = b.length - SPEC.header;
      const target = max + rng.pick([-1, 0, 1]);
      if (body >= target) { set(body > max ? 'refuse' : 'accept', 'already ' + body); break; }
      out.bytes = concat(b, utf8.encode(' '.repeat(target - body)));
      set(target <= max && out.bytes.length <= SPEC.frameMax ? 'accept' : 'refuse', 'body padded to ' + target);
      break;
    }
    case 'count': {
      if (type !== ID.WANT && type !== ID.HELD) { set('accept', 'no count'); break; }
      const c = forced ? forced.value : rng.pick([0, 1, 31, 32, 33, 64, 255, rng.int(256)]);
      const old = b[SPEC.header];
      b[SPEC.header] = c;
      const rest = b.length - SPEC.header - 1;
      if (type === ID.WANT) set(c <= 32 && (rest === c || rest === c * 8) ? 'accept' : 'refuse', 'WANT count ' + c);
      else set(c === old ? 'accept' : 'refuse', 'HELD count ' + c);
      break;
    }
    case 'held-len': {
      if (type !== ID.HELD || b[SPEC.header] === 0) { set('accept', 'no held item'); break; }
      const at = SPEC.header + 1;
      const real = (b[at] << 8) | b[at + 1];
      const rem = b.length - at - 2;
      const len = forced ? forced.value : rng.pick([0, 1, 13, 14, real - 1, real + 1, rem, rem + 1, 65535]);
      b[at] = (len >> 8) & 255;
      b[at + 1] = len & 255;
      if (len === real) set('accept', 'same item length');
      else set(len < SPEC.header || len > rem ? 'refuse' : 'any', 'HELD item length ' + len);
      break;
    }
    case 'ct': {
      if (type !== ID.ENV && type !== ID.SIG) { set('accept', 'no ct'); break; }
      const ctLen = rng.pick([0, 1, 271, 272, 273, 1039, 1040, 1041, 4111, 4112, 4113, 16015, 16016, 16017, rng.int(20000)]);
      const fixed = SPEC.header + SPEC.tag + SPEC.point + SPEC.iv;
      out.bytes = concat(b.subarray(0, fixed), rng.bytes(ctLen));
      if (out.bytes.length > SPEC.frameMax) set('refuse', 'ct ' + ctLen + ' (frame too large)');
      else set(SPEC.ctLengths.includes(ctLen) ? 'accept' : 'refuse', 'ct length ' + ctLen);
      break;
    }
    case 'point': {
      const off = type === ID.ENV || type === ID.SIG ? SPEC.header + SPEC.tag : type === ID.ICHAL ? SPEC.header + 32 : type === ID.IRESP ? SPEC.header : -1;
      if (off < 0) { set('accept', 'no point'); break; }
      const how = rng.int(5);
      if (how === 0) b[off] ^= 1 << rng.int(8);
      else if (how === 1) b[off] = rng.pick([0, 2, 3, 5, 0xff]);
      else if (how === 2) b.fill(0, off, off + 65);
      else b[off + 1 + rng.int(64)] ^= 1 << rng.int(8);
      set('refuse', 'point damaged (' + how + ')');
      break;
    }
    case 'json-edge': {
      if (!JSON_TYPES.has(type)) { set('accept', 'no json'); break; }
      const o = bodyJson(frame);
      const nums = type === ID.HELLO ? ['v'] : type === ID.ROOM ? ['t'] : ['epoch', 'exp', 'v'];
      const key = forced ? forced.key : rng.pick(nums);
      const value = forced ? forced.value : edgeNumber(rng);
      const spelled = !forced && typeof value === 'number' && Number.isFinite(value) && rng.chance(0.25) ? new Raw(spellings(rng, value)) : value;
      o[key] = spelled;
      const text = stringify(o);
      out.bytes = setJsonBody(frame, text);
      const parseOk = (() => { try { JSON.parse(text); return true; } catch (_) { return false; } })();
      const parsed = parseOk ? JSON.parse(text)[key] : undefined;
      if (type === ID.HELLO) set(parsed === 1 ? 'accept' : 'refuse', 'HELLO.v=' + text.match(/"v":([^,}]+)/)[1]);
      else if (type === ID.ROOM) set(Number.isSafeInteger(parsed) && parsed >= 0 ? 'accept' : 'refuse', 'ROOM.t=' + (spelled instanceof Raw ? spelled.text : value));
      else set(parseOk && utf8.encode(text).length <= SPEC.ckMax ? 'accept' : 'refuse', 'CK.' + key + '=' + (spelled instanceof Raw ? spelled.text : value));
      break;
    }
    case 'json-len': {
      if (type === ID.HELLO) {
        const o = bodyJson(frame);
        const pick = rng.int(3);
        if (pick === 0) {
          const n = lengthNear(rng, 128);
          o.site = 'a'.repeat(n);
          set(n >= 1 ? 'any' : 'refuse', 'HELLO.site ' + n + ' chars'); // over 128 is refused; in range the body bound may still refuse
        } else if (pick === 1) {
          const n = lengthNear(rng, SPEC.helloLanes);
          o.lanes = Array.from({ length: Math.min(n, 40) }, (_, k) => 'l' + k);
          set(n > SPEC.helloLanes ? 'refuse' : 'accept', 'HELLO.lanes ' + n);
        } else {
          const n = lengthNear(rng, SPEC.laneName);
          o.lanes = ['a'.repeat(n)];
          set(n < 1 || n > SPEC.laneName ? 'refuse' : 'accept', 'HELLO lane name ' + n);
        }
        out.bytes = setJsonBody(frame, JSON.stringify(o));
        const bodyLen = out.bytes.length - SPEC.header;
        if (bodyLen > SPEC.helloMax) out.verdict = 'refuse';
        else if (out.verdict === 'any') out.verdict = o.site.length >= 1 && o.site.length <= 128 ? 'accept' : 'refuse';
      } else if (type === ID.ROOM) {
        const o = bodyJson(frame);
        if (rng.chance(0.5)) {
          const n = lengthNear(rng, SPEC.roomName);
          o.room = 'r'.repeat(n);
          set(n >= 1 && n <= SPEC.roomName ? 'accept' : 'refuse', 'ROOM.room ' + n + ' chars');
        } else {
          const n = lengthNear(rng, SPEC.roomText);
          o.text = 't'.repeat(n);
          set(n >= 1 && n <= SPEC.roomText ? 'accept' : 'refuse', 'ROOM.text ' + n + ' chars');
        }
        out.bytes = setJsonBody(frame, JSON.stringify(o));
      } else {
        set('accept', 'no length');
      }
      break;
    }
    case 'holding': {
      if (type !== ID.HOLDING) { set('accept', 'no padding'); break; }
      if (rng.chance(0.5)) {
        b[SPEC.header + 44 + rng.int(SPEC.holdingBody - 44)] = 1 + rng.int(255);
        set('refuse', 'HOLDING padding byte set');
      } else {
        b[SPEC.header + 40 + rng.int(4)] = rng.int(256);
        set('accept', 'HOLDING expiry byte');
      }
      break;
    }
    case 'pres': {
      if (type !== ID.PRES) { set('accept', 'no pres'); break; }
      const modeAt = SPEC.header;
      const statusAt = SPEC.header + 1 + 64;
      const mode = forced && forced.key === 'mode' ? forced.value : forced ? b[modeAt] : rng.pick([0, 1, 2, 255, b[modeAt]]);
      const status = forced && forced.key === 'status' ? forced.value : forced ? b[statusAt] : rng.pick([0, 1, 2, 3, 255, b[statusAt]]);
      b[modeAt] = mode;
      b[statusAt] = status;
      set((mode === 0 || mode === 1) && (status === 1 || status === 2) ? 'accept' : 'refuse', 'PRES mode ' + mode + ' status ' + status);
      break;
    }
    case 'xx': {
      if (type !== ID.XX) { set('accept', 'no step'); break; }
      if (forced || rng.chance(0.5)) {
        const step = forced ? forced.value : rng.pick([0, 1, 2, 3, 4, 255]);
        b[SPEC.header] = step;
        set(step >= 1 && step <= 3 ? 'accept' : 'refuse', 'XX step ' + step);
      } else {
        const n = lengthNear(rng, SPEC.xxMax);
        out.bytes = concat(b.subarray(0, SPEC.header), Uint8Array.of(b[SPEC.header]), rng.bytes(Math.max(0, n - 1)));
        const body = out.bytes.length - SPEC.header;
        set(body >= 2 && body <= SPEC.xxMax ? 'accept' : 'refuse', 'XX body ' + body + ' bytes');
      }
      break;
    }
    case 'random': {
      out.bytes = concat(Uint8Array.of(rng.range(1, 13), 1), rng.bytes(rng.int(600)));
      set('any', 'random body');
      break;
    }
    case 'bytes':
      out.bytes = mutateBytes(rng, b, { maxLen: SPEC.frameMax + 50 });
      set('any', 'random byte mutations');
      break;
    default:
      throw new Error('chat-frames: no mutation called ' + kind);
  }
  return { bytes: out.bytes, verdict: out.verdict, label: out.label.join(' ') };
}

// ---------------------------------------------------------------------------------------------
// invariants of an accepted frame
// ---------------------------------------------------------------------------------------------

function invariants(bytes, res) {
  const p = [];
  if (bytes.length < SPEC.header || bytes.length > SPEC.frameMax) p.push('accepted a frame of ' + bytes.length + ' bytes');
  if (!NAMES.map((n) => ID[n]).includes(res.type)) p.push('accepted unknown type ' + res.type);
  const h = res.header;
  if (!h || h.version !== 1) p.push('accepted version ' + (h && h.version));
  if (h && h.hop > hopLimit(res.type)) p.push('accepted hop ' + h.hop + ' for type ' + res.type);
  if (h && ((h.flags & ~7) !== 0 || (h.flags !== 0 && !flagged(res.type)))) p.push('accepted flags ' + h.flags + ' for type ' + res.type);
  if (h && h.day !== ((bytes[4] << 8) | bytes[5])) p.push('day differs from bytes 4 and 5');
  if (h && hexOf(h.stampNonce) !== hexOf(bytes.subarray(6, 14))) p.push('stamp nonce differs from bytes 6 to 13');
  if (hexOf(res.body) !== hexOf(bytes.subarray(SPEC.header))) p.push('body differs from the bytes after the header');
  const f = res.fields;
  const body = bytes.subarray(SPEC.header);
  if (!f) {
    p.push('accepted without fields');
    return p;
  }
  switch (res.type) {
    case ID.ENV: case ID.SIG:
      if (!SPEC.ctLengths.includes(f.ct.length)) p.push('accepted ct of ' + f.ct.length + ' bytes');
      if (f.epk.length !== 65 || f.epk[0] !== 4) p.push('accepted an epk that is not an uncompressed point');
      break;
    case ID.WANT:
      if (f.entries.length > SPEC.want) p.push('accepted ' + f.entries.length + ' WANT entries');
      for (const e of f.entries) if (e.length !== f.entries[0].length || (e.length !== 1 && e.length !== 8)) p.push('WANT entry of ' + e.length + ' bytes');
      break;
    case ID.HELD: {
      if (f.frames.length > SPEC.held) p.push('accepted ' + f.frames.length + ' HELD items');
      let n = 1;
      for (const item of f.frames) {
        n += 2 + item.bytes.length;
        const again = decode(item.bytes);
        if (again.error || (again.type !== ID.ENV && again.type !== ID.SIG)) p.push('a HELD item does not decode as ENV or SIG');
      }
      if (n !== body.length) p.push('HELD items add up to ' + n + ' bytes, the body has ' + body.length);
      break;
    }
    case ID.HOLDING: if (body.length !== SPEC.holdingBody) p.push('accepted HOLDING of ' + body.length); break;
    case ID.COLLECTED: if (body.length !== 64) p.push('accepted COLLECTED of ' + body.length); break;
    case ID.PRES: if (body.length !== SPEC.presBody || (f.mode !== 0 && f.mode !== 1) || (f.status !== 1 && f.status !== 2)) p.push('accepted a PRES that is not valid'); break;
    case ID.ICHAL: case ID.IRESP: if (body.length !== 97) p.push('accepted a body of ' + body.length); break;
    case ID.XX: if (body.length < 2 || body.length > SPEC.xxMax || f.step < 1 || f.step > 3) p.push('accepted an XX that is not valid'); break;
    case ID.HELLO:
      if (body.length > SPEC.helloMax || f.v !== 1 || f.lanes.length > SPEC.helloLanes || f.site.length < 1 || f.site.length > 128) p.push('accepted a HELLO that is not valid');
      break;
    case ID.ROOM:
      if (body.length > SPEC.roomBodyMax || !Number.isSafeInteger(f.t) || f.t < 0 || f.text.length < 1 || f.text.length > SPEC.roomText) p.push('accepted a ROOM that is not valid');
      break;
    case ID.CK: if (body.length > SPEC.ckMax) p.push('accepted a CK of ' + body.length + ' bytes'); break;
    default:
  }
  return p;
}

/**
 * The numeric fields of the frames at their edges, once each, in a fixed order: the first inputs of chat-frames. The JSON numbers
 * (HELLO v, ROOM t, CK v, epoch and exp) take 0, -1 and 2^53-1; the byte-wide fields (version, hop, flags, day, a count, an item
 * length, a step, a mode and a status) take their smallest and largest values.
 */
export const CHAT_SWEEP = [];
for (const [type, key] of [[ID.HELLO, 'v'], [ID.ROOM, 't'], [ID.CK, 'v'], [ID.CK, 'epoch'], [ID.CK, 'exp']]) {
  for (const value of EDGE_MUST) CHAT_SWEEP.push({ type, kind: 'json-edge', key, value });
}
for (let type = 1; type <= 13; type++) {
  for (const kind of ['version', 'hop', 'flags']) for (const value of [0, 255]) CHAT_SWEEP.push({ type, kind, value });
  for (const value of [0, 65535]) CHAT_SWEEP.push({ type, kind: 'day', value });
}
for (const value of [0, 255]) {
  CHAT_SWEEP.push({ type: ID.WANT, kind: 'count', value }, { type: ID.HELD, kind: 'count', value }, { type: ID.XX, kind: 'xx', value }, { type: ID.PRES, kind: 'pres', key: 'mode', value }, { type: ID.PRES, kind: 'pres', key: 'status', value });
}
CHAT_SWEEP.push({ type: ID.HELD, kind: 'held-len', value: 0 }, { type: ID.HELD, kind: 'held-len', value: 65535 });

export const CHAT_FRAMES = {
  name: 'chat-frames',
  about: 'mw_chat1 decode(): header bytes, WANT/HELD counts and lengths, ENV buckets, JSON numbers, points off the curve',
  async setup() {
    return { points: await ecdhPoints(6) };
  },
  gen(rng, state, i) {
    if (i < CHAT_SWEEP.length) {
      const entry = CHAT_SWEEP[i];
      const base = validFrame(rng, state, entry.type);
      // HELD needs an item for its length to be swept
      const frame = entry.kind === 'held-len' ? validHeld(rng, state) : base;
      const m = mutate(rng, state, frame, entry);
      return { label: 'sweep ' + m.label, bytes: m.bytes, verdict: m.verdict, i };
    }
    const type = rng.range(1, 13);
    const frame = validFrame(rng, state, type);
    if (rng.chance(0.08)) return { label: NAMES[type - 1] + ' valid', bytes: frame.bytes, verdict: 'accept', i };
    const m = mutate(rng, state, frame);
    return { label: m.label, bytes: m.bytes, verdict: m.verdict, i };
  },
  run: (c) => decode(c.bytes),
  check(c, { result }) {
    const problems = [];
    if (c.i === 0) problems.push(...chatConstantProblems());
    if (!result || typeof result !== 'object') return ['decode returned ' + describe(result, 60)];
    const accepted = result.error === undefined;
    if (!accepted && (typeof result.error !== 'string' || Object.keys(result).length !== 1)) problems.push('a refusal is { error: string }, got ' + describe(result, 80));
    if (accepted) problems.push(...invariants(c.bytes, result));
    if (c.verdict === 'accept' && !accepted) problems.push('refused (' + result.error + ') a frame that is valid by construction');
    if (c.verdict === 'refuse' && accepted) problems.push('accepted a frame that is malformed by construction (type ' + result.type + ')');
    if (accepted) {
      let again;
      try {
        again = encode(result.type, result.header, result.body);
      } catch (err) {
        problems.push('encode of an accepted frame threw ' + err.message);
      }
      if (again && hexOf(again) !== hexOf(c.bytes)) problems.push('an accepted frame does not survive encode (header and body are not the bytes)');
    }
    return problems;
  },
  show: (c) => describe(c.bytes, 600),
};

// ---------------------------------------------------------------------------------------------
// chat-point
// ---------------------------------------------------------------------------------------------

const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
function beBytes(x, len) {
  const out = new Uint8Array(len);
  let v = x;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}

export const CHAT_POINT = {
  name: 'chat-point',
  about: 'isOnCurve() against WebCrypto: a valid point, one bit flipped, coordinates at p-1, p, p+1 and 0, other prefixes and lengths',
  async setup() {
    return { points: await ecdhPoints(8) };
  },
  gen(rng, state, i) {
    let pt = Uint8Array.from(rng.pick(state.points));
    const label = ['point'];
    switch (rng.int(8)) {
      case 0: break;
      case 1: pt[rng.int(65)] ^= 1 << rng.int(8); label.push('bit flipped'); break;
      case 2: { // x at an edge
        const x = rng.pick([0n, 1n, P - 1n, P, P + 1n, (1n << 256n) - 1n]);
        pt.set(beBytes(x, 32), 1);
        label.push('x edge');
        break;
      }
      case 3: {
        const y = rng.pick([0n, 1n, P - 1n, P, P + 1n, (1n << 256n) - 1n]);
        pt.set(beBytes(y, 32), 33);
        label.push('y edge');
        break;
      }
      case 4: pt[0] = rng.pick([0, 2, 3, 5, 6, 7, 255]); label.push('prefix ' + pt[0]); break;
      case 5: pt = pt.slice(0, rng.pick([0, 1, 32, 33, 64, 66 - 1])); label.push('short ' + pt.length); break;
      case 6: pt = concat(pt, rng.bytes(rng.range(1, 4))); label.push('long ' + pt.length); break;
      default: pt = concat(Uint8Array.of(4), rng.bytes(64)); label.push('random');
    }
    return { label: label.join(' '), input: pt, i };
  },
  async run(c) {
    let webcrypto;
    try {
      await globalThis.crypto.subtle.importKey('raw', c.input, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      webcrypto = true;
    } catch (_) {
      webcrypto = false;
    }
    return { mine: isOnCurve(c.input), webcrypto };
  },
  check(c, { result }) {
    // WebCrypto also takes the compressed and hybrid forms (prefix 2, 3, 6, 7); a chat frame carries only the uncompressed one, by design
    const problems = [];
    const uncompressed = c.input.length === 65 && c.input[0] === 4;
    if (typeof result.mine !== 'boolean') problems.push('isOnCurve returned a non-boolean');
    if (result.mine && !result.webcrypto) problems.push('isOnCurve accepts a point WebCrypto refuses');
    if (!result.mine && result.webcrypto && uncompressed) problems.push('isOnCurve refuses an uncompressed point WebCrypto accepts');
    if (result.mine && !uncompressed) problems.push('isOnCurve accepts something that is not a 65-byte uncompressed point');
    return problems;
  },
};

export const TARGETS = [CHAT_FRAMES, CHAT_POINT];
