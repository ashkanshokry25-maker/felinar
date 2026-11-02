// deploy/obs-worker/obs-core.js: the part of the usage report endpoint that needs no platform. It decides what a batch must look like
// and masks what a string may carry (validateBatch, maskString), keeps the limits and the rate limiter, names the key of a stored row
// and the order that key gives, reads the rows back (events, summary) and sweeps the store so that it stays small. worker.js wraps it
// around the Durable Object; the unit tests and the end to end collector (test/e2e/obs-collector.mjs) run this same file over an
// in-memory store (createMemoryStorage), so what they accept is what the Worker accepts.
//
// Nothing here reads a request header, a client address or anything else about the sender: the only input is the text of a batch and
// the clock. The wire format is the one the reporters of the loader and of the identity page write (docs/OBSERVABILITY.md): one JSON
// object per batch, { v, sid, seq, page, build, loader, site, who, net, ua, t0, events: [{ t, n, ...fields }] }.

/** The numbers every part of the endpoint shares. createObsLog copies them, so a test (or an operator build) can change its own copy. */
export const LIMITS = Object.freeze({
  maxBodyBytes: 32768, // one POST; the reporters send at most 16384
  maxEvents: 100, // per batch (the reporters send at most 50)
  maxEventKeys: 12, // fields per event, apart from t and n
  maxField: 200, // characters of one string value, after masking
  maxSeq: 1000000000,
  perSidPerMinute: 60, // batches one session may add in a sliding minute
  perSidPerDay: 1000,
  maxBatchesPerDay: 20000, // all sessions together; a row put and later deleted for each stays under the Free plan's 100,000 row writes a day
  retentionDays: 7,
  maxRows: 50000,
  eventsDefault: 200,
  eventsMax: 1000,
  eventsScanRows: 5000, // rows one /events.json request may read, matches or not
  summaryScanRows: 5000,
  summaryHoursDefault: 24,
  summaryHoursMax: 168,
  summaryNames: 500, // distinct event names a summary counts one by one; the rest are counted together
  pageRows: 128, // rows per storage read; 128 is also the most keys one delete may name
  sweepRounds: 40, // pages one sweep may delete before it asks to be run again soon
  saveEvery: 20, // the counter row is written with every 20th batch of a day (and by the sweep), not with each one
});

export const PAGES = Object.freeze(['site', 'door', 'hub', 'idp']);
export const BROWSERS = Object.freeze(['chromium', 'firefox', 'webkit', 'other']);
export const KEY_PREFIX = 'b:';
export const META_KEY = 'm:c';
export const MASK = 'x.x.x.x';

const DAY_MS = 86400000;
const SEEN_MAX = 8; // batches per session whose number and text are remembered, to recognise one that is sent again (a final flush sends up to 4 at once)
const KEY_DIGITS = 15; // zero-padded milliseconds: 15 digits reach the year 33658, so the keys sort as the times do
const SEQ_DIGITS = 4;

const SID_RE = /^[a-z2-9]{12}$/;
const NAME_RE = /^[a-z][a-z0-9.-]{1,48}$/;
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/; // the reporters' own rule for a field name
const HEX_RE = /^[0-9a-f]{0,16}$/;
const SITE_RE = /^[0-9a-f]{0,8}$/; // the first 8 hex characters of an infohash and no more
const LOADER_RE = /^(?:\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.]{1,8})?)?$/; // a version (0.3.0, 0.3.1-rc.1) or nothing
// The short id of a signed-in identity, as the header shows it: two groups of 4 from the 32 characters the identity page's shortId draws
// from (letters but l and o, digits 2 to 9). A name, an e-mail address or a word of any other shape is not one.
const WHO_RE = /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/;
// The words navigator.connection has (type and effectiveType) and that the reporters send: nothing else is a coarse network word.
const NET_TYPES = Object.freeze(['bluetooth', 'cellular', 'ethernet', 'mixed', 'none', 'other', 'unknown', 'wifi', 'wimax']);
const NET_EFFECTIVE = Object.freeze(['slow-2g', '2g', '3g', '4g', 'unknown']);
const KEY_RE = /^b:\d{15}:\d{4}$/;
const MAX_T0 = 4102444800; // 2100-01-01 in seconds: a clock far past it is not a clock

// ---------------------------------------------------------------------------------------------- masking

// The masks of the reporters' safeField (src/loader/obs.js, src/idp/obs-client.js), run again here because a batch may come from a
// client that skipped them or has a gap in them. They are the loader reporter's rules (text folded to NFKC, invisible characters
// dropped, the part after a '#' cut, an mDNS candidate name, a candidate's port word, a pair code down to its channel) with two
// differences in how addresses are found, so that the two lines of defence do not share their gaps: the IPv6 pattern here takes
// every run of colon-joined hex groups (a clock time such as 12:30:45 goes too: over-masking loses a detail, under-masking would
// leak an address), and an IPv4 literal is taken wherever four dotted groups of digits stand, with the port and the brackets and
// the zone that belong to it. On top of the reporter's rule for a hash of 40 hex digits, any run of 32 or more letters, digits,
// hyphens and underscores that holds a digit (an infohash, a ledger id, a key) keeps its first 8 characters, which is all that
// the field rules (docs/OBSERVABILITY.md) allow of an infohash. test/unit/deploy-obs-core.test.mjs holds this file against both reporters.
const PRECUT = 2000; // the reporter's own limit, far past maxField: masking shortens text by at most a factor of ten
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const SPACE_RE = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
// The look-alikes of the dot and the colon that NFKC leaves alone (the ideographic full stop, the ratio sign, %2e and %3a, a combining mark
// glued to a digit, a hex letter, a dot or a colon) go back to the plain character; the secrets of an SDP (the ICE user fragment and
// password, the DTLS fingerprint) are cut where the text names them.
const LOOKALIKE_RE = /([0-9A-Fa-f.:])\p{M}+|[\u3002\uff61]|[\u2236\ua789]|%2e|%3a/giu;
const SDP_SECRET_RE = /\b(a=ice-(?:ufrag|pwd):|a=fingerprint:\S+\s+)\S+/gi;
const URLISH_RE = /[/:.?=@%&+~]/;
const MDNS_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local\b/gi;
const IPV4_RE = /0?\d{1,3}(?:\.0?\d{1,3}){3}(?::\d{1,5}(?!\d|\.\d))?/g; // the port is not taken when it is the start of the next address; a group may be octal (0300.0250.0.1)
const IPV6_RE = /[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi;
const MASKED_RE = /(?:\[?x\.x\.x\.x\]?(?:%[0-9A-Za-z._~-]{1,40})?(?::\d{1,5}(?!\d|\.\d))?)+/g;
const CANDIDATE_PORT_RE = /(x\.x\.x\.x)\s+\d{1,5}(?=\s+typ\b)/g; // an SDP candidate line: the address, then its port as a word
const RADDR_PORT_RE = /(\braddr\s+x\.x\.x\.x)\s+rport\s+\d{1,5}\b/g;
const PAIR_RE = /(^|[^A-Za-z0-9])([A-Za-z0-9]{4})[-\u2010-\u2015\u2212][A-Za-z0-9]{4}[-\u2010-\u2015\u2212][A-Za-z0-9]{4}(?![A-Za-z0-9])/g;
const LONG_RUN_RE = /[A-Za-z0-9_-]{32,}/g;

function cutLongRun(run) {
  return /\d/.test(run) ? run.slice(0, 8) : run;
}

/**
 * cutFragment(s): the part after a '#' goes and the '#' stays, except in front of a short number in text that is not a URL ("step #3").
 * The word in front of a '#' is read once: a '#' that was passed has no URL character before it, so the word in front of the next one
 * needs only the text since the last. A body of many "#1" then costs time in proportion to its length; reading everything before each
 * '#' again cost the square of it (a 32 KB body took the object about 10 ms, ordinary text of that size 1 ms).
 */
function cutFragment(s) {
  let from = 0;
  for (;;) {
    const p = s.indexOf('#', from);
    if (p < 0) return s;
    const since = s.slice(from, p);
    const space = since.lastIndexOf(' ');
    const after = s.slice(p + 1, p + 8);
    if (URLISH_RE.test(space < 0 ? since : since.slice(space + 1))) return s.slice(0, p + 1);
    if (after === '' || after.charAt(0) === ' ' || /^\d{1,6}(?![0-9A-Za-z_])/.test(after)) {
      from = p + 1;
      continue;
    }
    return s.slice(0, p + 1);
  }
}

/** cut(s, max) -> s cut to max characters, without the first half of a surrogate pair at the end. */
function cut(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const last = head.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

function foldLookalike(m, keep) {
  if (keep !== undefined) return keep;
  return m === '\u3002' || m === '\uff61' || m === '%2e' || m === '%2E' ? '.' : ':';
}

function maskPass(text) {
  let s = cut(text, PRECUT);
  try { s = s.normalize('NFKC'); } catch (_) { /* a string that cannot be normalised is used as it is */ }
  s = s.replace(INVISIBLE_RE, '').replace(SPACE_RE, ' ').trim();
  s = s.replace(LOOKALIKE_RE, foldLookalike).replace(SDP_SECRET_RE, '$1');
  if (s.indexOf('#') >= 0) s = cutFragment(s);
  s = s.replace(MDNS_RE, MASK).replace(IPV4_RE, MASK).replace(IPV6_RE, MASK).replace(MASKED_RE, MASK);
  s = s.replace(CANDIDATE_PORT_RE, '$1').replace(RADDR_PORT_RE, '$1');
  s = s.replace(PAIR_RE, '$1$2').replace(LONG_RUN_RE, cutLongRun);
  return cut(s, LIMITS.maxField).trim();
}

/**
 * maskString(value) -> the string as it may be stored: folded to NFKC, invisible characters dropped, controls and spaces one space,
 * IPv4 and IPv6 literals (with their port, brackets and zone) and mDNS candidate names become "x.x.x.x", the text after a '#' of
 * a URL-looking string is cut, a pair code (xxxx-xxxx-xxxx) keeps its first 4 characters, a long opaque run keeps its first 8, and
 * the result is trimmed and cut to LIMITS.maxField characters. The masks run before the cut, so an address that straddles the limit
 * is never left half there. A pass can leave something the next one takes (the 4 characters a code keeps may now join the next
 * group into a code), so it runs until nothing changes: maskString(maskString(s)) is maskString(s).
 */
export function maskString(value) {
  let s = maskPass(String(value));
  for (let i = 0; i < 6; i++) {
    const next = maskPass(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------- validation

const bad = (reason) => ({ ok: false, reason });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** coarse(v, words) -> the string v when it is one of the words, null for absent, undefined for anything else. */
function coarse(v, words) {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && words.includes(v) ? v : undefined;
}

function checkEvent(ev) {
  if (!isObject(ev)) return bad('event');
  if (!isInt(ev.t, 0, Number.MAX_SAFE_INTEGER)) return bad('time');
  if (typeof ev.n !== 'string' || !NAME_RE.test(ev.n)) return bad('name');
  const keys = Object.keys(ev).filter((k) => k !== 't' && k !== 'n');
  if (keys.length > LIMITS.maxEventKeys) return bad('keys');
  const out = { t: ev.t, n: ev.n };
  for (const key of keys) {
    if (!FIELD_KEY_RE.test(key)) return bad('key');
    const v = ev[key];
    if (typeof v === 'string') out[key] = maskString(v);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean' || v === null) out[key] = v;
    else return bad('value');
  }
  return { ok: true, event: out };
}

/**
 * validateBatch(input) -> { ok: true, batch } | { ok: false, reason }. input is the parsed JSON. The batch it returns is built from
 * the fields it checked and nothing else, so a key the format does not name never reaches storage; every string value has been
 * through maskString. reason is one short word: shape, version, sid, seq, page, build, loader, site, who, net, ua, t0, events,
 * event, time, name, keys, key or value. The fields of the envelope are checked against the shapes the reporters really write (a
 * version, up to 8 hex characters of an infohash, a short id, the words of navigator.connection), not against a loose pattern, so
 * that a name, an address or a longer id cannot ride in a field that has no mask.
 */
export function validateBatch(input) {
  if (!isObject(input)) return bad('shape');
  if (input.v !== 1) return bad('version');
  if (typeof input.sid !== 'string' || !SID_RE.test(input.sid)) return bad('sid');
  if (!isInt(input.seq, 0, LIMITS.maxSeq)) return bad('seq');
  if (!PAGES.includes(input.page)) return bad('page');
  const build = input.build === undefined ? '' : input.build;
  if (typeof build !== 'string' || !HEX_RE.test(build)) return bad('build');
  const loader = input.loader === undefined ? '' : input.loader;
  if (typeof loader !== 'string' || loader.length > 16 || !LOADER_RE.test(loader)) return bad('loader');
  const site = input.site === undefined ? '' : input.site;
  if (typeof site !== 'string' || !SITE_RE.test(site)) return bad('site');
  const who = input.who === undefined ? null : input.who;
  if (who !== null && (typeof who !== 'string' || !WHO_RE.test(who))) return bad('who');
  let net = null;
  if (input.net !== undefined && input.net !== null) {
    if (!isObject(input.net)) return bad('net');
    const type = coarse(input.net.type, NET_TYPES);
    const effectiveType = coarse(input.net.effectiveType, NET_EFFECTIVE);
    if (type === undefined || effectiveType === undefined) return bad('net');
    net = { type, effectiveType };
  }
  if (!isObject(input.ua) || !BROWSERS.includes(input.ua.browser) || typeof input.ua.mobile !== 'boolean') return bad('ua');
  if (!isInt(input.t0, 0, MAX_T0)) return bad('t0');
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > LIMITS.maxEvents) return bad('events');
  const events = [];
  for (const ev of input.events) {
    const checked = checkEvent(ev);
    if (!checked.ok) return checked;
    events.push(checked.event);
  }
  return {
    ok: true,
    batch: { v: 1, sid: input.sid, seq: input.seq, page: input.page, build, loader, site, who, net, ua: { browser: input.ua.browser, mobile: input.ua.mobile }, t0: input.t0, events },
  };
}

/** parseBatchText(text) -> validateBatch's answer for the text of a POST; the reasons empty and json are added. */
export function parseBatchText(text) {
  if (typeof text !== 'string' || text.length === 0) return bad('empty');
  let value;
  try { value = JSON.parse(text); } catch (_) { return bad('json'); }
  return validateBatch(value);
}

/** utf8Length(s) -> the bytes of s encoded as UTF-8 (a lone surrogate counts as the 3 bytes of its replacement character). */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------- keys and queries

/** batchKey(ms, n) -> 'b:' + 15 digits of milliseconds + ':' + 4 digits: the key of one stored batch, which sorts in time order. */
export function batchKey(ms, n = 0) {
  return KEY_PREFIX + String(Math.max(0, Math.floor(ms))).padStart(KEY_DIGITS, '0') + ':' + String(Math.max(0, Math.floor(n))).padStart(SEQ_DIGITS, '0');
}

/** parseBatchKey(key) -> { ms, n } or null for a string that is not a batch key. */
export function parseBatchKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  return { ms: Number(key.slice(KEY_PREFIX.length, KEY_PREFIX.length + KEY_DIGITS)), n: Number(key.slice(-SEQ_DIGITS)) };
}

const clampInt = (raw, min, max, fallback) => {
  if (raw === null || raw === undefined || raw === '' || !/^\d{1,9}$/.test(String(raw))) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
};

/** parseEventsQuery(params) -> { ok, query: { since, sid, who, limit } } | { ok: false, reason }; params has get(name) (URLSearchParams). */
export function parseEventsQuery(params) {
  const since = params.get('since');
  if (since !== null && since !== '' && !KEY_RE.test(since)) return bad('since');
  const sid = params.get('sid');
  if (sid !== null && sid !== '' && !SID_RE.test(sid)) return bad('sid');
  const who = params.get('who');
  if (who !== null && who !== '' && !WHO_RE.test(who)) return bad('who');
  return { ok: true, query: { since: since || null, sid: sid || null, who: who || null, limit: clampInt(params.get('limit'), 1, LIMITS.eventsMax, LIMITS.eventsDefault) } };
}

/** parseSummaryQuery(params) -> { ok: true, query: { hours } }. */
export function parseSummaryQuery(params) {
  return { ok: true, query: { hours: clampInt(params.get('hours'), 1, LIMITS.summaryHoursMax, LIMITS.summaryHoursDefault) } };
}

// ---------------------------------------------------------------------------------------------- rate limiter

/**
 * signatureOf(text) -> a short string that two equal texts share (32 bit FNV-1a over the UTF-16 units, and the length): enough to tell
 * a batch sent again from another batch that reuses its numbers, not a security measure.
 */
function signatureOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + '.' + text.length.toString(36);
}

/**
 * createLimiter(cfg) -> { gate(now), take(sid, now, mark), seen(sid, mark, now), count(now), snapshot(now), restore(saved, now) }. cfg
 * holds perSidPerMinute, perSidPerDay and maxBatchesPerDay; it is read at each call, so changing it takes effect at once.
 * gate() asks only whether the day is full: { ok: true }, or { ok: false, why: 'day-all', retryAfter }, so that a batch can be refused
 * before anyone reads it. take() counts a batch only when it lets it through: { ok: true }, or { ok: false, why, retryAfter } with
 * why sid-minute (60 in a sliding minute), sid-day (1000 a UTC day) or day-all (all sessions together) and retryAfter in seconds.
 * Given a mark ({ seq, sig }), take() remembers it for its session (the last SEEN_MAX of them), and seen() says whether a session
 * already had a batch with that mark: a batch sent again after a lost answer has the same session id, number and text. A day is a UTC
 * day. The windows and the marks live in memory and start again when the object that holds them is rebuilt; the count of the day is
 * what snapshot() and restore() move through storage.
 */
export function createLimiter(cfg = {}) {
  const get = (name) => (typeof cfg[name] === 'number' ? cfg[name] : LIMITS[name]);
  let day = -1;
  let total = 0;
  const sids = new Map(); // sid -> { times: [ms of its last batches inside the minute], day: batches today, marks: [seq + ' ' + sig of its last batches] }
  const roll = (now) => {
    const d = Math.floor(now / DAY_MS);
    if (d !== day) { day = d; total = 0; sids.clear(); }
  };
  const untilMidnight = (now) => Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000));
  const gate = (now) => {
    roll(now);
    return total >= get('maxBatchesPerDay') ? { ok: false, why: 'day-all', retryAfter: untilMidnight(now) } : { ok: true };
  };
  const markOf = (mark) => (mark && Number.isSafeInteger(mark.seq) && typeof mark.sig === 'string' ? mark.seq + ' ' + mark.sig : null);
  return {
    gate,
    take(sid, now, mark) {
      const full = gate(now);
      if (!full.ok) return full;
      let e = sids.get(sid);
      if (!e) { e = { times: [], day: 0, marks: [] }; sids.set(sid, e); }
      while (e.times.length && now - e.times[0] >= 60000) e.times.shift();
      if (e.times.length >= get('perSidPerMinute')) return { ok: false, why: 'sid-minute', retryAfter: e.times.length ? Math.max(1, Math.ceil((e.times[0] + 60000 - now) / 1000)) : 60 };
      if (e.day >= get('perSidPerDay')) return { ok: false, why: 'sid-day', retryAfter: untilMidnight(now) };
      e.times.push(now);
      e.day++;
      total++;
      const m = markOf(mark);
      if (m !== null) {
        e.marks.push(m);
        if (e.marks.length > SEEN_MAX) e.marks.shift();
      }
      return { ok: true };
    },
    seen(sid, mark, now) {
      roll(now);
      const e = sids.get(sid);
      const m = markOf(mark);
      return !!e && m !== null && e.marks.includes(m);
    },
    count(now) {
      roll(now);
      return total;
    },
    snapshot(now) {
      roll(now);
      return { d: day, n: total };
    },
    restore(saved, now) {
      roll(now);
      if (saved && saved.d === day && Number.isSafeInteger(saved.n) && saved.n > total) total = saved.n;
    },
  };
}

// ---------------------------------------------------------------------------------------------- storage adapter

/**
 * createMemoryStorage() -> an in-memory store with the methods of the Durable Object storage that createObsLog uses, for tests and
 * for the end to end collector: get(key), put(key, value), delete(key | keys) and list({ prefix, start, startAfter, end, reverse,
 * limit }) -> Map in key order. Values go in and come out as copies, as they do through the platform. The same interface is what
 * createObsLog asks of ctx.storage:
 *   get(key) -> value | undefined          put(key, value)           delete(key) -> boolean | delete(keys) -> number deleted
 *   list(opts) -> Map, ascending unless reverse; start is inclusive, startAfter and end exclusive, prefix filters, limit caps.
 */
export function createMemoryStorage() {
  const rows = new Map();
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    rows,
    async get(key) { return clone(rows.get(key)); },
    async put(key, value) { rows.set(key, clone(value)); },
    async delete(keys) {
      if (Array.isArray(keys)) {
        let n = 0;
        for (const k of keys) if (rows.delete(k)) n++;
        return n;
      }
      return rows.delete(keys);
    },
    async list({ prefix = '', start, startAfter, end, reverse = false, limit } = {}) {
      let keys = Array.from(rows.keys()).filter((k) => k.startsWith(prefix) && (start === undefined || k >= start) && (startAfter === undefined || k > startAfter) && (end === undefined || k < end)).sort();
      if (reverse) keys.reverse();
      if (typeof limit === 'number') keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, clone(rows.get(k))]));
    },
  };
}

// ---------------------------------------------------------------------------------------------- the summary

/**
 * createSummary(options) -> { add(row), result() }: counts stored rows as they are fed in, in any order, and keeps the counts only.
 * A row is { at, sid, page, who, n, body: { events: [{ n }] } } as the log stores it; anything else is skipped. result() is
 * { batches, events, sids, who, pages, names }: the rows, their events, the distinct sessions and signed-in identities, and the
 * rows per page and the events per name, each by count and then by name. The first options.maxNames distinct names are counted one
 * by one, the rest together as "*other" (a name can never look like that).
 */
export function createSummary({ maxNames = LIMITS.summaryNames } = {}) {
  const sids = new Set();
  const whos = new Set();
  const pages = new Map();
  const names = new Map();
  let other = 0;
  let batches = 0;
  let events = 0;
  const byCount = (m) => Object.fromEntries(Array.from(m.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return {
    add(row) {
      if (!row || typeof row !== 'object') return false;
      batches++;
      const list = row.body && Array.isArray(row.body.events) ? row.body.events : [];
      events += Number.isSafeInteger(row.n) ? row.n : list.length;
      if (typeof row.sid === 'string') sids.add(row.sid);
      if (typeof row.who === 'string') whos.add(row.who);
      if (typeof row.page === 'string') pages.set(row.page, (pages.get(row.page) || 0) + 1);
      for (const ev of list) {
        const name = ev && typeof ev.n === 'string' ? ev.n : null;
        if (name === null) continue;
        if (names.has(name) || names.size < maxNames) names.set(name, (names.get(name) || 0) + 1);
        else other++;
      }
      return true;
    },
    result() {
      const nameCounts = byCount(names);
      if (other > 0) nameCounts['*other'] = other;
      return { batches, events, sids: sids.size, who: whos.size, pages: byCount(pages), names: nameCounts };
    },
  };
}

/** summarizeRows(rows, options) -> the result() of createSummary over an iterable of stored rows. */
export function summarizeRows(rows, options) {
  const counts = createSummary(options);
  for (const row of rows) counts.add(row);
  return counts.result();
}

// ---------------------------------------------------------------------------------------------- the log

const failure = (status, reason, extra = {}) => Object.assign({ ok: false, status, reason }, extra);

/**
 * createObsLog(storage, options) -> the store of the endpoint over any storage with the interface of createMemoryStorage.
 * options: retentionDays, maxBatchesPerDay (the Worker's vars), now() (default Date.now), limits (any number of LIMITS to change).
 * The log keeps one row per accepted batch under batchKey(), { at, sid, page, who, site, build, n: events.length, body: the
 * validated batch }, and one small row META_KEY, { d: UTC day, n: batches that day, r: rows held }, written with every
 * saveEvery-th batch of a day and by sweep(), so a rebuilt object knows the day's count to within a few batches.
 *
 *   load()            reads the counter row once (call it when the object wakes)
 *   ingest(text)      -> { ok: true, status: 204, key, row } | { ok: true, status: 204, repeat: true } | { ok: false, status, reason,
 *                        retryAfter? }; 413 for a body over maxBodyBytes, 429 day-all before the body is read once the day's total is
 *                        reached, 400 with validateBatch's reason, 429 with sid-minute, sid-day or day-all. A batch that a session
 *                        sent before (the same number, the same text: what a retry after a lost answer sends) is answered 204 with
 *                        repeat: true and is neither stored nor counted
 *   events(query)     -> { next, more, batches } rows in key order after query.since, filtered by sid and who, at most limit of
 *                        them, reading at most eventsScanRows rows; next is the last key read (or since), more says the read stopped
 *                        at a cap and the next call may find more
 *   summary(query)    -> { hours, from, to, truncated, batches, events, sids, who, pages, names } over the last query.hours
 *                        (the counts are createSummary's), reading the newest summaryScanRows rows at most
 *   sweep()           -> { deleted, more, rows } deletes rows older than retentionDays, then the oldest rows beyond maxRows
 *   todayCount(), rowCount(), limits
 */
export function createObsLog(storage, options = {}) {
  const limits = Object.assign({}, LIMITS, options.limits);
  if (options.retentionDays !== undefined) limits.retentionDays = options.retentionDays;
  if (options.maxBatchesPerDay !== undefined) limits.maxBatchesPerDay = options.maxBatchesPerDay;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limiter = createLimiter(limits);
  let rows = 0;
  let lastMs = 0;
  let seq = 0;

  const nextKey = (at) => {
    if (at > lastMs) { lastMs = at; seq = 0; } else if (seq >= 9999) { lastMs += 1; seq = 0; } else seq += 1;
    return batchKey(lastMs, seq);
  };

  async function saveMeta(at) {
    const snap = limiter.snapshot(at);
    await storage.put(META_KEY, { d: snap.d, n: snap.n, r: rows });
  }

  async function load() {
    const saved = await storage.get(META_KEY);
    const at = now();
    if (saved && typeof saved === 'object') {
      if (Number.isSafeInteger(saved.r) && saved.r >= 0) rows = saved.r;
      limiter.restore(saved, at);
    }
    return { rows, today: limiter.count(at) };
  }

  async function ingest(body) {
    if (typeof body !== 'string' || body.length === 0) return failure(400, 'empty');
    if (utf8Length(body) > limits.maxBodyBytes) return failure(413, 'too large');
    const at = now();
    // Once the day's total is reached every batch gets the same answer, and none of them is read: a body costs a parse and the masks.
    const full = limiter.gate(at);
    if (!full.ok) return failure(429, full.why, { retryAfter: full.retryAfter });
    const parsed = parseBatchText(body);
    if (!parsed.ok) return failure(400, parsed.reason);
    const batch = parsed.batch;
    const mark = { seq: batch.seq, sig: signatureOf(body) };
    if (limiter.seen(batch.sid, mark, at)) return { ok: true, status: 204, repeat: true };
    const verdict = limiter.take(batch.sid, at, mark);
    if (!verdict.ok) return failure(429, verdict.why, { retryAfter: verdict.retryAfter });
    const key = nextKey(at);
    const row = { at, sid: batch.sid, page: batch.page, who: batch.who, site: batch.site, build: batch.build, n: batch.events.length, body: batch };
    await storage.put(key, row);
    rows++;
    const n = limiter.count(at);
    if (n === 1 || n % limits.saveEvery === 0) await saveMeta(at);
    return { ok: true, status: 204, key, row };
  }

  const wanted = (row, q) => row && typeof row === 'object' && (!q.sid || row.sid === q.sid) && (!q.who || row.who === q.who);

  async function events(q) {
    const unfiltered = !q.sid && !q.who;
    const out = [];
    let after = q.since || undefined;
    let last = q.since || null;
    let scanned = 0;
    let stopped = false;
    scan: for (;;) {
      const room = unfiltered ? Math.min(limits.pageRows, q.limit - out.length) : limits.pageRows;
      const opts = { prefix: KEY_PREFIX, limit: room };
      if (after !== undefined) opts.startAfter = after;
      const page = await storage.list(opts);
      if (page.size === 0) break;
      for (const [key, row] of page) {
        scanned++;
        last = key;
        after = key;
        if (wanted(row, q)) out.push(row);
        if (out.length >= q.limit || scanned >= limits.eventsScanRows) { stopped = true; break scan; }
      }
      if (page.size < room) break;
    }
    return { next: last, more: stopped, batches: out };
  }

  async function summary(q) {
    const at = now();
    const from = Math.max(0, at - q.hours * 3600000);
    const startKey = batchKey(from, 0);
    const counts = createSummary({ maxNames: limits.summaryNames });
    let scanned = 0;
    let oldest = null;
    let truncated = false;
    let end;
    scan: for (;;) {
      const opts = { prefix: KEY_PREFIX, start: startKey, reverse: true, limit: limits.pageRows };
      if (end !== undefined) opts.end = end;
      const page = await storage.list(opts);
      if (page.size === 0) break;
      for (const [key, row] of page) {
        end = key;
        if (!row || typeof row !== 'object') continue;
        if (scanned >= limits.summaryScanRows) { truncated = true; break scan; }
        scanned++;
        if (typeof row.at === 'number') oldest = row.at;
        counts.add(row);
      }
      if (page.size < limits.pageRows) break;
    }
    return Object.assign({ hours: q.hours, from: truncated && oldest !== null ? oldest : from, to: at, truncated }, counts.result());
  }

  async function removeOldest(list, wantRows) {
    // list(room) -> a page of the rows to delete; stops when it is empty, short, or wantRows are gone
    let deleted = 0;
    let full = false;
    let rounds = 0;
    for (; rounds < limits.sweepRounds && deleted < wantRows; rounds++) {
      const room = Math.min(limits.pageRows, wantRows - deleted);
      const page = await list(room);
      if (page.size === 0) { full = false; break; }
      await storage.delete(Array.from(page.keys()));
      deleted += page.size;
      full = page.size >= room;
      if (!full) break;
    }
    return { deleted, more: rounds >= limits.sweepRounds && full && deleted < wantRows };
  }

  async function sweep() {
    const at = now();
    const cutoff = batchKey(at - limits.retentionDays * DAY_MS, 0);
    const old = await removeOldest((room) => storage.list({ prefix: KEY_PREFIX, end: cutoff, limit: room }), Number.MAX_SAFE_INTEGER);
    let deleted = old.deleted;
    let more = old.more;
    rows = Math.max(0, rows - old.deleted);
    if (!more && rows > limits.maxRows) {
      const over = await removeOldest((room) => storage.list({ prefix: KEY_PREFIX, limit: room }), rows - limits.maxRows);
      deleted += over.deleted;
      more = over.more;
      rows = Math.max(0, rows - over.deleted);
    }
    if (!more && rows > 0) {
      // the count is a few rows off after a rebuilt object lost its last writes; an empty store puts it right
      const head = await storage.list({ prefix: KEY_PREFIX, limit: 1 });
      if (head.size === 0) rows = 0;
    }
    await saveMeta(at);
    return { deleted, more, rows };
  }

  return {
    limits,
    load,
    ingest,
    events,
    summary,
    sweep,
    todayCount: () => limiter.count(now()),
    rowCount: () => rows,
  };
}
