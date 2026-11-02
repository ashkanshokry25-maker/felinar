// src/idp/obs-client.js: the usage reporter of the identity page (plan obs-2026-11-02 sections 2.2, 2.6, 3.6 and 5;
// docs/OBSERVABILITY.md). It exists only when the build names a report endpoint (tools/build-idp.mjs --obs); without one
// nothing in this file runs and the page makes no request but its own.
//
// Why a file of its own and not the loader's src/loader/obs.js: this bundle holds the root of every identity, so it carries the
// least code that does the job. The batch format and the masking are the loader reporter's (the Worker checks both the same
// way); the loader's click walker, its WebRTC wrapper and its site and identity setters are left out, because this page has no
// use for them. The identity page never sets who and never sets site: it does not know a short id worth reporting (the one a site
// shows is a different site's id) and it must not name the site it signs in to.
//
//   createReporter({ endpoint, build, loader, now, random, send, nav, visibility, setTimeout, clearTimeout })
//     -> { event(name, fields), allow(on), flush(reason), stop(), inspect(), sid }
//   event(name, fields)   queue one event; fields are strings (masked), finite numbers, booleans or null, at most 12; anything
//                         else is dropped field by field, never thrown. Before the first allow() events wait in memory.
//   allow(true)           the person agreed (the first press of a card button): the waiting events go out first, then the rest.
//   allow(false)          drops the queue and ignores events from then on.
//   flush(reason)         sends one batch now; 'final' sends the whole queue (at most FINAL_BATCHES batches) with fetch keepalive,
//                         the call the page makes after the answer is posted and before its window closes. It returns a promise
//                         that never rejects: for 'final' it settles when every batch has its answer (fetch), or when the browser
//                         has had a moment to take the request (a beacon has no answer). A page held by a service worker that cannot
//                         route around its request can lose one sent in the same breath as the window closes (src/idp/sw.js, and the
//                         wait in src/idp/idp.js finalFlush), so the caller waits for this promise.
//   inspect()             { host, enabled, allowed, queued, sent, dropped, batches, lastOk }, the host name only.
//   sid                   the session id (12 characters of [a-z2-9]); the opener's reporter may name it in the request (ref).
//
// The wire (one POST of text/plain per batch, no preflight):
//   { v: 1, sid, seq, page: 'idp', build, loader, site: '', who: null, net: null, ua: { browser, mobile }, t0, events: [{ t, n, ... }] }
//
// instrumentCards, instrumentHandlers and cardOutcome turn what the cards already do into events without touching a card: a card
// shown is card {kind}, its outcome is action {name} drawn from a closed list of words, and nothing a person typed is ever read.

export const OBS_LIMITS = Object.freeze({ flushMs: 2000, maxBatch: 50, maxQueue: 500, maxField: 200, maxBodyBytes: 16384, maxRetries: 3 });

const PAGE = 'idp';
const NAME_RE = /^[a-z][a-z0-9.-]{1,48}$/;
const KEY_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
const MAX_KEYS = 12;
const SID_CHARS = 'abcdefghijklmnopqrstuvwxyz23456789';
const FINAL_BATCHES = 4;

// Masks: the rules of the loader's safeField (src/loader/obs.js) in the fewest lines, and the Worker applies the full set again. None
// of the address patterns asks for a word boundary or for the end of a word, so an address glued to a letter is masked, one with a
// port loses the port with it, and the IPv6 pattern that takes every run of two or more colon-joined hex groups (brackets and zone
// included) also takes a clock time such as 12:30:45: over-masking loses a detail, under-masking would leak an address. What the loader
// masks beyond this (the port word of an SDP candidate line, an mDNS candidate name) the identity page has no field for: every value it
// reports comes from a closed list (test/unit/idp-obs.test.mjs holds that). An address written as one integer or in hex is left alone, as
// in the loader: an error code such as 0x80070005 has that shape.
const IPV4_RE = /(?:0?\d{1,3}\.){3}0?\d{1,3}(?::\d{1,5})?/g;
const IPV6_RE = /\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[0-9a-z._~-]{1,40})?\]?(?::\d{1,5})?/gi;
const PAIR_CODE_RE = /\b([a-z2-9]{4})[-\u2010-\u2015\u2212][a-z2-9]{4}[-\u2010-\u2015\u2212][a-z2-9]{4}\b/gi;
const HEX_RUN_RE = /[0-9a-f]{40,}/gi;
const URLISH_RE = /[/:.?=@%&+~]/;
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// The loader's folds: the look-alikes of the dot and the colon that NFKC leaves alone (the ideographic full stop, the ratio sign, %2e and %3a,
// a combining mark glued to a digit, a hex letter, a dot or a colon) go back to the plain character, and the secrets of an SDP are cut.
const LOOKALIKE_RE = /([0-9A-Fa-f.:])\p{M}+|[\u3002\uff61]|[\u2236\ua789]|%2e|%3a/giu;
const SDP_SECRET_RE = /\b(a=ice-(?:ufrag|pwd):|a=fingerprint:\S+\s+)\S+/gi;

function foldLookalike(m, keep) {
  if (keep !== undefined) return keep;
  return m === '\u3002' || m === '\uff61' || m === '%2e' || m === '%2E' ? '.' : ':';
}

/**
 * cutFragment(s) -> s without what follows a '#' that belongs to a URL (the loader's rule): the '#' stays, a '#' in plain words
 * ("issue #12", a lone one) does not count, and a '#' after something that looks like an address or a path does. The word in front
 * of a '#' is read once (a '#' that was passed has no URL character before it, so the next word needs only the text since), so many
 * "#1" cost time in proportion to their length, not to its square.
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
    if (after === '' || after.charAt(0) === ' ' || /^[0-9]{1,6}(?![0-9A-Za-z_])/.test(after)) {
      from = p + 1;
      continue;
    }
    return s.slice(0, p + 1);
  }
}

/**
 * safeField(v) -> a string cut to 200 characters with addresses masked (IPv4 and IPv6 literals, with their port, become "x.x.x.x";
 * anything after the '#' of a URL is cut; a 12-character pair code keeps its first 4 characters; a run of 40 or more hex digits
 * keeps its first 8), a finite number, a boolean or null. Everything else, and a number that is not finite, is null. The text
 * is folded to NFKC and loses its invisible characters first (full-width digits do not hide an address), and the masks run before the
 * cut, so an address that straddles the limit is never left half there.
 */
export function safeField(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (typeof v !== 'string') return null;
  let s = v.slice(0, 2000).normalize('NFKC').replace(INVISIBLE_RE, '').replace(LOOKALIKE_RE, foldLookalike).replace(SDP_SECRET_RE, '$1').trim();
  if (s.indexOf('#') >= 0) s = cutFragment(s);
  s = s.replace(PAIR_CODE_RE, '$1').replace(IPV4_RE, 'x.x.x.x').replace(IPV6_RE, 'x.x.x.x');
  // A hash or a key written in hex keeps its first 8 characters; a run of letters a to f alone is a word, not a hash.
  s = s.replace(HEX_RUN_RE, (m) => (/[0-9]/.test(m) && /[a-f]/i.test(m) ? m.slice(0, 8) : m));
  return s.slice(0, OBS_LIMITS.maxField);
}

/** uaOf(navigator) -> { browser: 'chromium' | 'firefox' | 'webkit' | 'other', mobile } by engine family only, never the string itself. */
export function uaOf(nav) {
  const out = { browser: 'other', mobile: false };
  try {
    const data = nav && nav.userAgentData;
    const brands = data && Array.isArray(data.brands) ? data.brands.map((b) => String(b && b.brand)).join(' ') : '';
    const ua = String((nav && nav.userAgent) || '');
    out.mobile = data && typeof data.mobile === 'boolean' ? data.mobile : /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const probe = brands + ' ' + ua;
    // Every browser on iOS runs the WebKit engine, whatever its name says.
    if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/.test(ua)) out.browser = 'webkit';
    else if (/Firefox/i.test(probe)) out.browser = 'firefox';
    else if (/Chrom|Edg\/|OPR\//i.test(probe)) out.browser = 'chromium';
    else if (/AppleWebKit|Safari/i.test(probe)) out.browser = 'webkit';
  } catch (_) {
    // keep the defaults
  }
  return out;
}

function randomUnit() {
  try {
    const b = new Uint32Array(1);
    globalThis.crypto.getRandomValues(b);
    return b[0] / 4294967296;
  } catch (_) {
    return Math.random();
  }
}

function newSid(random) {
  let out = '';
  for (let i = 0; i < 12; i++) {
    const r = random();
    out += SID_CHARS[Math.floor((r >= 0 && r < 1 ? r : 0) * SID_CHARS.length)];
  }
  return out;
}

const byteLength = (text) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length);

export const BEACON_GRACE_MS = 150;

/**
 * defaultSend(nav) -> send(url, text, { final }) -> boolean | Promise<boolean>. fetch first, with keepalive where the browser has it
 * (Firefox before 133 does not): a cors request carries the page's real Origin and its answer says whether the endpoint stored the
 * batch. A beacon is a no-cors POST and, under a Referrer-Policy of no-referrer, carries "Origin: null", which the endpoint refuses
 * (measured on 2026-11-02 on a phone: 99 batches reported sent, none stored). The beacon is the fallback when there is no fetch, when
 * the browser refuses the keepalive request, and for the final flush of a browser without keepalive, where a request that outlives
 * the window matters more than its answer. A beacon has no answer to wait for, so a final beacon settles after BEACON_GRACE_MS, the
 * moment a page held by its service worker needs to hand the request over before its window goes.
 */
function defaultSend(nav) {
  const hasKeepalive = typeof Request === 'function' && Request.prototype && 'keepalive' in Request.prototype;
  const beacon = (url, text) => {
    try { return Boolean(nav && typeof nav.sendBeacon === 'function' && typeof Blob === 'function' && nav.sendBeacon(url, new Blob([text], { type: 'text/plain' }))); } catch (_) { return false; }
  };
  return (url, text, { final = false } = {}) => {
    if (typeof fetch === 'function' && (hasKeepalive || !final)) {
      try {
        return Promise.resolve(fetch(url, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' }, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true }))
          .then((res) => Boolean(res && res.ok), () => false);
      } catch (_) {
        // a refused keepalive request falls through to the beacon
      }
    }
    if (beacon(url, text)) return final ? new Promise((resolve) => setTimeout(() => resolve(true), BEACON_GRACE_MS)) : true;
    return false;
  };
}

/**
 * hideHook(win, doc) -> { onHide(fn) }: fn runs when the page is being hidden or closed (pagehide, and visibilitychange to hidden),
 * where the reporter sends what it holds if the person has agreed.
 */
export function hideHook(win, doc) {
  return {
    onHide(fn) {
      try {
        if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', () => fn());
      } catch (_) {
        // no window events
      }
      try {
        if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') fn(); });
      } catch (_) {
        // no document events
      }
    },
  };
}

/**
 * createReporter(opts) -> the reporter (see the header). opts: endpoint (an exact origin, checked by the caller), build (the hex
 * build id or ''), loader (the page version), now(), random() (0 to 1, for the session id), send(url, text, { final }),
 * nav (for the browser family), visibility ({ onHide(fn) }), setTimeout and clearTimeout.
 */
export function createReporter(opts = {}) {
  const endpoint = String(opts.endpoint || '');
  const url = endpoint + '/e';
  let host = '';
  try { host = new URL(endpoint).hostname; } catch (_) { host = ''; }
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const random = typeof opts.random === 'function' ? opts.random : randomUnit;
  const nav = opts.nav !== undefined ? opts.nav : (typeof navigator !== 'undefined' ? navigator : null);
  const send = typeof opts.send === 'function' ? opts.send : defaultSend(nav);
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (h) => clearTimeout(h);
  const build = /^[0-9a-f]{1,16}$/.test(String(opts.build || '')) ? String(opts.build) : '';
  // A version (0.3.0, 0.3.1-rc.1) or nothing: the endpoint takes no other shape in this field.
  const loader = String(opts.loader || '').length <= 16 && /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:[-+][0-9A-Za-z.]{1,8})?$/.test(String(opts.loader || '')) ? String(opts.loader) : '';
  const created = now();
  const t0 = Math.floor(created / 1000);
  const sid = newSid(random);
  const ua = uaOf(nav);

  let allowed = false;
  let decided = false; // allow() was called with an answer: a no keeps the page from queueing at all
  let stopped = false;
  let timer = null;
  let seq = 0;
  let sent = 0;
  let dropped = 0;
  let batches = 0;
  let lastOk = null;
  const queue = [];
  const retries = [];

  function envelope(batch) {
    return { v: 1, sid, seq: batch.seq, page: PAGE, build, loader, site: '', who: null, net: null, ua, t0, events: batch.events };
  }

  function takeEvents() {
    const out = [];
    let size = byteLength(JSON.stringify(envelope({ seq: 999999999, events: [] })));
    while (queue.length && out.length < OBS_LIMITS.maxBatch) {
      const add = byteLength(JSON.stringify(queue[0])) + 1;
      if (out.length && size + add > OBS_LIMITS.maxBodyBytes) break;
      size += add;
      out.push(queue.shift());
    }
    return out;
  }

  function clearTimer() {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  function arm() {
    if (timer !== null || !allowed || stopped || (!queue.length && !retries.length)) return;
    timer = setT(() => { timer = null; flush('timer'); }, OBS_LIMITS.flushMs);
    // A pending report must never keep a Node process alive; a browser's handle is a number and has no unref.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // sendOne(final) -> false when there was nothing to send, true when a batch went to the transport and was settled at once, or a
  // promise that settles when the transport answers. A batch that fails stays for the next flush, at most maxRetries tries in all,
  // then it is dropped and counted; it keeps its seq, so the operator can tell a repeat from a new batch.
  function sendOne(final) {
    let batch = retries.shift();
    if (!batch) {
      if (!queue.length) return false;
      batch = { seq: seq++, events: takeEvents(), tries: 0 };
    }
    batch.tries++;
    const settle = (ok) => {
      if (ok === true) {
        sent += batch.events.length;
        batches++;
        lastOk = now();
        return;
      }
      if (batch.tries >= OBS_LIMITS.maxRetries) {
        dropped += batch.events.length;
        return;
      }
      retries.push(batch);
      arm();
    };
    let result = false;
    try { result = send(url, JSON.stringify(envelope(batch)), { final }); } catch (_) { result = false; }
    if (result && typeof result.then === 'function') return result.then(settle, () => settle(false));
    settle(result);
    return true;
  }

  function flush(reason) {
    if (!allowed || stopped) return Promise.resolve();
    clearTimer();
    const final = reason === 'final';
    const waiting = [];
    for (let i = 0; i < (final ? FINAL_BATCHES : 1); i++) {
      const sentOne = sendOne(final);
      if (!sentOne) break;
      if (sentOne !== true) waiting.push(sentOne);
    }
    arm();
    return Promise.all(waiting).then(() => undefined, () => undefined);
  }

  function event(name, fields) {
    if (stopped || (decided && !allowed)) return;
    if (typeof name !== 'string' || !NAME_RE.test(name)) return;
    const ev = { t: Math.max(0, Math.round(now() - created)), n: name };
    if (fields && typeof fields === 'object') {
      let kept = 0;
      for (const key of Object.keys(fields)) {
        if (kept >= MAX_KEYS) break;
        if (key === 't' || key === 'n' || !KEY_RE.test(key)) continue;
        const v = fields[key];
        if (typeof v === 'number' && !Number.isFinite(v)) continue;
        if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
        ev[key] = safeField(v);
        kept++;
      }
    }
    queue.push(ev);
    while (queue.length > OBS_LIMITS.maxQueue) {
      queue.shift();
      dropped++;
    }
    arm();
  }

  function allow(on) {
    if (stopped) return;
    decided = true;
    allowed = on === true;
    if (allowed) {
      arm();
      return;
    }
    dropped += queue.length;
    queue.length = 0;
    retries.length = 0;
    clearTimer();
  }

  function stop() {
    const done = flush('final');
    stopped = true;
    clearTimer();
    return done;
  }

  if (opts.visibility && typeof opts.visibility.onHide === 'function') opts.visibility.onHide(() => flush('hide'));

  return {
    event, allow, flush, stop,
    inspect() {
      let queued = queue.length;
      for (const b of retries) queued += b.events.length;
      return { host, enabled: true, allowed, queued, sent, dropped, batches, lastOk };
    },
    get sid() { return sid; },
  };
}

// ---------------------------------------------------------------------------------------------
// What the cards already do, as events
// ---------------------------------------------------------------------------------------------

/** CARD_KINDS: every card of src/idp/cards.js that takes a person's press or shows one line (test/unit/idp-obs.test.mjs checks the list against createCards). */
export const CARD_KINDS = Object.freeze([
  'signin', 'confirmSame', 'chooseUnlock', 'passphrase', 'showPhrase', 'reentry', 'restore', 'checkCode', 'foundPosts', 'replaceIdentity',
  'recoveryKit', 'backupFile', 'saveBackup', 'tapToFinish', 'createPage', 'ownerAction', 'recordRead', 'erase', 'legacy', 'replaceKeys',
  'removeDevice', 'message', 'error', 'busy', 'showCodes', 'scanCode', 'settings',
]);
const KIND_SET = new Set(CARD_KINDS);

/** HANDLER_NAMES: the buttons of the settings card (src/idp/idp.js bootHome). */
export const HANDLER_NAMES = Object.freeze(['unlockView', 'stopSame', 'hubOff', 'hubAsk', 'replaceKeys', 'removeDevice', 'showPhrase', 'makeBackup', 'link', 'restore']);

const pick = (x, words) => (words.indexOf(x) >= 0 ? x : 'done');

/**
 * cardOutcome(kind, value) -> one word for what a card resolved with. A word comes from a closed list or from the shape of the
 * value (null, true, false), never from the value's own text: a passphrase, a typed code or a file is 'continue' and nothing more.
 */
export function cardOutcome(kind, v) {
  if (v === null || v === undefined) return 'cancel';
  switch (kind) {
    case 'signin': return pick(v && v.action, ['continue', 'cancel', 'restore', 'link']);
    case 'chooseUnlock': return pick(v && v.method, ['passkey', 'passphrase', 'visit']);
    case 'restore': return pick(v && v.kind, ['phrase', 'file']);
    case 'passphrase': case 'scanCode': case 'backupFile': return 'continue';
    case 'recoveryKit': case 'saveBackup': return pick(v, ['saved', 'later']);
    case 'foundPosts': return pick(v, ['continue', 'check']);
    case 'legacy': return pick(v, ['keep', 'fresh']);
    case 'message': case 'error': return 'close';
    default: return v === true ? 'yes' : v === false ? 'no' : 'done';
  }
}

/**
 * instrumentCards(cards, report) -> the same cards, each card in CARD_KINDS also reporting card {kind} when it is shown and
 * action {name: kind + '.' + outcome} when the person's press resolves it. It returns the card's own promise untouched; a
 * report that throws is lost, never the sign-in.
 */
export function instrumentCards(cards, report) {
  const say = (name, fields) => {
    try { report(name, fields); } catch (_) { /* a report never breaks a card */ }
  };
  return new Proxy(cards, {
    get(target, key) {
      const value = target[key];
      if (typeof key !== 'string' || typeof value !== 'function' || !KIND_SET.has(key)) return value;
      return function observed(...args) {
        say('card', { kind: key });
        const out = value.apply(target, args);
        if (key !== 'busy' && out && typeof out.then === 'function') {
          out.then((v) => say('action', { name: key + '.' + cardOutcome(key, v) }), () => say('action', { name: key + '.error' }));
        }
        return out;
      };
    },
  });
}

/** instrumentHandlers(handlers, report) -> the settings card's handlers, each button reporting action {name: 'settings.' + button}; the arguments (a site) are not read. */
export function instrumentHandlers(handlers, report) {
  const out = {};
  for (const key of Object.keys(handlers || {})) {
    const fn = handlers[key];
    if (typeof fn !== 'function' || HANDLER_NAMES.indexOf(key) < 0) {
      out[key] = fn;
      continue;
    }
    out[key] = (...args) => {
      try { report('action', { name: 'settings.' + key }); } catch (_) { /* a report never breaks a button */ }
      return fn(...args);
    };
  }
  return out;
}

/** wantWord(want) -> 'keys', 'proof', 'keys+proof', 'record' or 'erase' (the sorted words of a validated request), '' for anything else. */
export function wantWord(want) {
  return Array.isArray(want) ? want.slice().sort().join('+') : '';
}
