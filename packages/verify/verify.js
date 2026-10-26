// @felinar/verify: verifies mw-signin-v1 proofs (docs/specs/mw-signin-v1.md) on a server or in
// a browser. One ES module, zero dependencies, WebCrypto only (Node >= 22 and browsers). It
// returns the verified identity and never roles: scope is a request, never a grant.
//
// Order of checks (cheap first): parse and size (4 KiB) -> version and type -> origin, domain,
// ledger, keyMode, idp -> age and skew -> nonce consumption (a stateless MAC is checked before
// any store is touched) -> signature -> statement and resources against the issued challenge.
// The nonce is consumed before the signature is checked, so a forged proof that carries a stolen
// nonce burns it; dedupe is on the nonce, never on the signature (ECDSA signatures are malleable).

const PREFIX = 'mw-signin-v1\n';
const MAX_BYTES = 4096;
const MAX_AGE_CAP = 300000;
const MAX_SKEW_CAP = 300000;
const ALG = 'ES256-P1363';
const MODES = ['pairwise', 'ledger', 'hub', 'linked'];
const FIELDS = ['v', 't', 'domain', 'origin', 'ledger', 'pub', 'keyMode', 'nonce', 'statement', 'resources', 'iat', 'nbf', 'exp', 'requestId', 'idp', 'build'];
const enc = new TextEncoder();

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('@felinar/verify needs WebCrypto (crypto.subtle)');
  return c.subtle;
}

// ---- RFC 8785 (JSON Canonicalization Scheme) -------------------------------------------------

/** jcs(value) -> RFC 8785 text; TypeError for anything that is not plain JSON data. */
export function jcs(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('jcs: non-finite number');
      return value === 0 ? '0' : String(value);
    case 'string': return quote(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('jcs: unsupported object');
      return '{' + Object.keys(value).sort().map((k) => quote(k) + ':' + jcs(value[k])).join(',') + '}';
    }
    default: throw new TypeError('jcs: unsupported value');
  }
}

function quote(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c < 0x20) {
      const short = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' }[c];
      out += short || '\\u00' + c.toString(16).padStart(2, '0');
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1);
      if (c > 0xdbff || !(d >= 0xdc00 && d <= 0xdfff)) throw new TypeError('jcs: lone surrogate');
      out += s[i] + s[i + 1];
      i++;
    } else out += s[i];
  }
  return out + '"';
}

// ---- base64url --------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64e(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 3) {
    const x = (u8[i] << 16) | ((u8[i + 1] || 0) << 8) | (u8[i + 2] || 0);
    const n = Math.min(3, u8.length - i);
    out += B64[x >>> 18] + B64[(x >>> 12) & 63] + (n > 1 ? B64[(x >>> 6) & 63] : '') + (n > 2 ? B64[x & 63] : '');
  }
  return out;
}

/** b64d(s) -> Uint8Array, or null unless s is canonical unpadded base64url. */
function b64d(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    acc = ((acc << 6) | B64.indexOf(s[i])) & 0x3fff; // at most 13 pending bits
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 255;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

const b64len = (s, min, max) => {
  const b = b64d(s);
  return b !== null && b.length >= min && b.length <= max;
};

// ---- strict JSON: duplicate keys refused ------------------------------------------------------

function parseStrict(text) {
  let i = 0;
  const fail = () => { throw new SyntaxError('bad JSON at ' + i); };
  const ws = () => { while (/[ \t\n\r]/.test(text[i] || '')) i++; };
  const str = () => {
    i++;
    let out = '';
    for (;;) {
      const c = text[i];
      if (c === undefined || text.charCodeAt(i) < 0x20) fail();
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          const h = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
          out += String.fromCharCode(parseInt(h, 16));
          i += 6;
        } else {
          const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
          if (m === undefined) fail();
          out += m;
          i += 2;
        }
      } else { out += c; i++; }
    }
  };
  const val = (depth) => {
    if (depth > 16) fail();
    ws();
    const c = text[i];
    if (c === '"') return str();
    if (c === '{' || c === '[') {
      const isObj = c === '{';
      const out = isObj ? {} : [];
      const seen = new Set();
      i++;
      ws();
      if (text[i] === (isObj ? '}' : ']')) { i++; return out; }
      for (;;) {
        ws();
        if (isObj) {
          if (text[i] !== '"') fail();
          const k = str();
          if (seen.has(k)) fail();
          seen.add(k);
          ws();
          if (text[i++] !== ':') fail();
          Object.defineProperty(out, k, { value: val(depth + 1), enumerable: true, writable: true, configurable: true });
        } else out.push(val(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === (isObj ? '}' : ']')) { i++; return out; }
        fail();
      }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (m) { i += m[0].length; return Number(m[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(w, i)) { i += w.length; return v; }
    return fail();
  };
  const v = val(0);
  ws();
  if (i !== text.length) fail();
  return v;
}

// ---- field rules ------------------------------------------------------------------------------

function originOf(s) {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s ? s : null;
  } catch (_) { return null; }
}

function statementBad(s) {
  if (typeof s !== 'string') return true;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if ((c >= 0xdc00 && c <= 0xdfff) || c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
      c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
    n++;
  }
  return n > 280 || s.normalize('NFC') !== s;
}

const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const exact = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const isPub = (s) => typeof s === 'string' && s.length === 92 && s.startsWith('p256:') && (b64d(s.slice(5)) || [])[0] === 4 && b64d(s.slice(5)).length === 65;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- nonce stores -----------------------------------------------------------------------------

/**
 * MemoryNonceStore: single process only. put(nonce, expMs, meta?) records an issued nonce;
 * consume(nonce, expMs) -> true or meta once, 'used' after that, false for a nonce never issued
 * or expired. markUsed(nonce, expMs) -> true the first time, false after that, 'full' when the store is full of
 * unexpired entries (for stateless nonces; review round SEC-9: a full store is not a replay). A shared
 * store for several instances implements the same calls atomically (for example one row per
 * nonce deleted with a conditional delete).
 */
export class MemoryNonceStore {
  constructor({ max = 100000, now = () => Date.now() } = {}) {
    this.max = max;
    this.now = now;
    this.map = new Map();
  }

  sweep() {
    const t = this.now();
    for (const [k, e] of this.map) if (e.exp <= t) this.map.delete(k);
  }

  async put(nonce, expMs, meta = null) {
    if (this.map.size >= this.max) this.sweep();
    if (this.map.size >= this.max) throw new Error('nonce store full');
    this.map.set(nonce, { exp: expMs, meta, used: false });
  }

  async consume(nonce) {
    const e = this.map.get(nonce);
    if (!e || e.exp <= this.now()) return false;
    if (e.used) return 'used';
    e.used = true;
    return e.meta || true;
  }

  async markUsed(nonce, expMs) {
    const e = this.map.get(nonce);
    if (e && e.exp > this.now()) return false;
    if (this.map.size >= this.max) this.sweep();
    if (this.map.size >= this.max) return 'full';
    this.map.set(nonce, { exp: expMs, meta: null, used: true });
    return true;
  }
}

async function hmac(secret, text) {
  const key = await subtle().importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, enc.encode(text)));
}

/**
 * statelessNonce(secret, { ttlMs = 300000, used = new MemoryNonceStore(), now }) ->
 *   { issue(origin) -> { nonce, exp }, consume(nonce, expMs, origin) }
 * nonce = b64url(t (8 bytes) || random (8) || HMAC-SHA-256(secret, "mw-nonce-v1|" + origin + "|" + t + "|" + random)[:16]).
 * consume checks the MAC and the time first, then marks the nonce used in `used` (pass a shared
 * store when several instances verify: the MAC alone does not stop a replay).
 */
export function statelessNonce(secret, { ttlMs = 300000, used = new MemoryNonceStore(), now = () => Date.now() } = {}) {
  if (!secret || secret.length < 16) throw new TypeError('statelessNonce needs a secret of at least 16 bytes');
  const mac = async (origin, t, r) => (await hmac(secret, 'mw-nonce-v1|' + origin + '|' + t + '|' + b64e(r))).slice(0, 16);
  return {
    stateless: true,
    async issue(origin) {
      const t = now();
      const r = globalThis.crypto.getRandomValues(new Uint8Array(8));
      const tb = new Uint8Array(8);
      new DataView(tb.buffer).setBigUint64(0, BigInt(t));
      const n = new Uint8Array(32);
      n.set(tb, 0); n.set(r, 8); n.set(await mac(origin, t, r), 16);
      return { nonce: b64e(n), exp: t + ttlMs };
    },
    async consume(nonce, expMs, origin) {
      const b = b64d(nonce);
      if (!b || b.length !== 32) return false;
      const t = Number(new DataView(b.buffer).getBigUint64(0));
      const want = await mac(origin, t, b.slice(8, 16));
      let diff = 0;
      for (let i = 0; i < 16; i++) diff |= want[i] ^ b[16 + i];
      if (diff !== 0 || t > now() + MAX_SKEW_CAP || t + ttlMs <= now()) return false;
      const m = await used.markUsed(nonce, t + ttlMs);
      return m === 'full' ? 'full' : m ? true : 'used';
    },
  };
}

/**
 * issueChallenge({ statement = '', nonces, ttlMs = 300000, resources = [], origin, now })
 *   -> { nonce, statement, exp, resources }
 * With a store, a random 32-byte nonce is put with the statement and resources, which verify()
 * then compares; with statelessNonce, origin is required and verify() compares the statement
 * to createVerifier's `statement` option when one is given.
 */
export async function issueChallenge({ statement = '', nonces, ttlMs = 300000, resources = [], origin, now = Date.now() } = {}) {
  if (statementBad(statement)) throw new TypeError('statement: at most 280 characters, NFC, no control or bidi characters');
  if (!Array.isArray(resources) || resources.length > 4 || !resources.every((r) => typeof r === 'string' && r.startsWith('https://'))) throw new TypeError('resources: at most 4 https URLs');
  if (!nonces) throw new TypeError('issueChallenge needs a nonce store');
  if (nonces.stateless) {
    if (!originOf(origin)) throw new TypeError('statelessNonce needs the site origin');
    const n = await nonces.issue(origin);
    return { nonce: n.nonce, statement, exp: n.exp, resources: resources.slice() };
  }
  const nonce = b64e(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const exp = now + Math.min(ttlMs, MAX_AGE_CAP);
  await nonces.put(nonce, exp, { statement, resources: resources.slice() });
  return { nonce, statement, exp, resources: resources.slice() };
}

// ---- verifier ---------------------------------------------------------------------------------

/**
 * createVerifier({ origin, ledger = null, allowKeyModes, allowIdps, maxAgeMs = 300000,
 *   maxSkewMs = 120000, nonces, now = () => Date.now(), statement })
 *   -> { verify(proof) -> { ok: true, pub, keyMode, ledger, iat, exp, requestId, statement, idp, build }
 *                       | { ok: false, reason, at } }
 * origin is the site's exact origin from configuration (never from request headers). Pass the
 * proof as the raw request body text: duplicate keys can only be refused in text.
 */
export function createVerifier({ origin, ledger = null, allowKeyModes = MODES, allowIdps, maxAgeMs = 300000, maxSkewMs = 120000, nonces, now = () => Date.now(), statement } = {}) {
  if (!originOf(origin)) throw new TypeError('origin must be the exact serialised origin, for example https://forum.example');
  if (ledger !== null && (typeof ledger !== 'string' || !ledger)) throw new TypeError('ledger must be null or a ledger id');
  if (!Array.isArray(allowKeyModes) || !allowKeyModes.every((m) => MODES.includes(m))) throw new TypeError('allowKeyModes: ' + MODES.join(', '));
  if (allowIdps !== undefined && (!Array.isArray(allowIdps) || !allowIdps.every(originOf))) throw new TypeError('allowIdps must be origins');
  if (!uint(maxAgeMs) || maxAgeMs > MAX_AGE_CAP) throw new RangeError('maxAgeMs is at most 300000');
  if (!uint(maxSkewMs) || maxSkewMs > MAX_SKEW_CAP) throw new RangeError('maxSkewMs is at most 300000');
  if (!nonces || typeof nonces.consume !== 'function') throw new TypeError('nonces: a store with consume() is required');
  const domain = new URL(origin).host;

  async function check(input, t) {
    let obj = input;
    if (typeof input === 'string') {
      if (enc.encode(input).length > MAX_BYTES) return 'parse';
      try { obj = parseStrict(input); } catch (_) { return 'parse'; }
    } else {
      try { if (enc.encode(jcs(input)).length > MAX_BYTES) return 'parse'; } catch (_) { return 'parse'; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !exact(obj, ['c', 'alg', 'sig'])) return 'parse';
    const c = obj.c;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'parse';
    if (c.v !== 1 || c.t !== 'mw-signin') return 'version';
    if (!exact(c, FIELDS)) return 'parse';
    if (obj.alg !== ALG) return 'alg';
    const sig = b64d(obj.sig);
    if (!sig || sig.length !== 64) return 'sig';
    if (!isPub(c.pub) || !b64len(c.nonce, 16, 64) || !b64len(c.requestId, 16, 32) || !uint(c.iat) || !uint(c.nbf) || !uint(c.exp) ||
      typeof c.domain !== 'string' || !originOf(c.idp) || typeof c.build !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(c.build) ||
      !(c.ledger === null || (typeof c.ledger === 'string' && c.ledger.length > 0 && c.ledger.length <= 64)) ||
      !Array.isArray(c.resources) || c.resources.length > 4 || !c.resources.every((r) => typeof r === 'string' && r.startsWith('https://'))) return 'parse';
    if (statementBad(c.statement)) return 'statement';
    if (c.origin !== origin) return 'origin';
    if (c.domain !== domain) return 'domain';
    if (c.ledger !== ledger) return 'ledger';
    if (!MODES.includes(c.keyMode) || !allowKeyModes.includes(c.keyMode)) return 'keymode';
    if (allowIdps && !allowIdps.includes(c.idp)) return 'idp';
    if (c.exp - c.iat > maxAgeMs || c.exp <= c.iat) return 'too-long';
    if (c.iat > t + maxSkewMs || c.nbf > t + maxSkewMs) return 'not-yet-valid';
    if (c.exp + maxSkewMs <= t || c.iat + maxAgeMs + maxSkewMs <= t) return 'expired';
    // The signing input is built before the nonce is used: a proof whose strings do not serialise (a lone surrogate) is
    // 'parse' and burns nothing (code review v0.3, round 2).
    let signed;
    try { signed = enc.encode(PREFIX + jcs(c)); } catch (_) { return 'parse'; }
    const used = await nonces.consume(c.nonce, c.exp, origin);
    if (used === 'full') return 'store-full';
    if (used === 'used') return 'replay';
    if (!used) return 'nonce';
    let key;
    try {
      key = await subtle().importKey('raw', b64d(c.pub.slice(5)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch (_) { return 'sig'; }
    const good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed).catch(() => false);
    if (!good) return 'sig';
    const issued = typeof used === 'object' ? used : null;
    if (issued && (issued.statement !== c.statement || !sameList(issued.resources || [], c.resources))) return 'statement';
    if (!issued && statement !== undefined && statement !== c.statement) return 'statement';
    return { c };
  }

  return {
    async verify(proof) {
      const at = now();
      const r = await check(proof, at);
      if (typeof r === 'string') return { ok: false, reason: r, at };
      const c = r.c;
      return { ok: true, pub: c.pub, keyMode: c.keyMode, ledger: c.ledger, iat: c.iat, exp: c.exp, requestId: c.requestId, statement: c.statement, idp: c.idp, build: c.build };
    },
  };
}
