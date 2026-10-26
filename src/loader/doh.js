// DNS TXT lookups over DNS-over-HTTPS JSON (ARCHITECTURE §4 source 3, DESIGN-REVIEW item 12(b),
// research 05). Resolvers are tried one after another (Cloudflare, dns.sb, Google) so the
// visited hostname reaches as few third parties as possible; the first usable answer wins.
// Requests are simple CORS GETs: the only header is Accept (Google answers preflights without
// CORS headers, so anything else would fail there), no credentials, no referrer, no HTTP cache.
// Google gets edns_client_subnet=0.0.0.0/0 so it does not forward the visitor's /24.

import { joinTxtData } from '../common/pointer.js';

/** Answers are cached at least this long (ARCHITECTURE §4: minimum 5 min). */
export const MIN_TTL_SECONDS = 300;
/** ... and at most this long, so a huge TTL cannot freeze updates. */
export const MAX_TTL_SECONDS = 86400;
/** DNS label that holds pointer records: `_magnet.<hostname>`. */
export const TXT_LABEL = '_magnet.';
/**
 * v0.3 (MF-30): the largest delay setTimeout honours (2^31 - 1 ms, about 24.8 days). A larger value
 * overflows to 0 in every browser, so a timer armed from a hostile TTL or record expiry would fire at
 * once, again and again. Every timer the loader arms from external data goes through clampTimerMs.
 */
export const MAX_TIMER_MS = 2147483647;
/**
 * v0.3 (MF-30): DNS-over-HTTPS AD=1 means "the resolver says it validated DNSSEC"; the loader cannot
 * check that itself, so the UI shows this wording and never a validated badge.
 */
export const AD_WORDING = 'resolver says validated';
// Review round R 5.3 (PTR-13): the largest DoH JSON body read (a TXT answer for one name is a few KiB at most).
export const MAX_DOH_BODY_BYTES = 65536;

/**
 * clampTimerMs(ms, { min = 0 }) → a delay setTimeout and setInterval honour: NaN, negative and
 * non-numbers become `min`, anything above MAX_TIMER_MS becomes MAX_TIMER_MS (v0.3, MF-30).
 */
export function clampTimerMs(ms, { min = 0 } = {}) {
  const floor = typeof min === 'number' && Number.isFinite(min) && min > 0 ? Math.min(min, MAX_TIMER_MS) : 0;
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return n === Infinity ? MAX_TIMER_MS : floor;
  return Math.min(MAX_TIMER_MS, Math.max(floor, Math.floor(n)));
}

export const RESOLVERS = [
  { name: 'cloudflare', url: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`, headers: { accept: 'application/dns-json' } },
  { name: 'dns.sb', url: (n, t) => `https://doh.dns.sb/dns-query?name=${encodeURIComponent(n)}&type=${t}`, headers: { accept: 'application/dns-json' } },
  { name: 'google', url: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}&edns_client_subnet=0.0.0.0/0`, headers: {} },
];

// Special-use and private names that public DNS never answers: asking a public resolver about
// them only leaks the name (RFC 6761, 6762, 7686, 8375, 2606, ICANN .internal, common LAN TLDs).
const SKIP_SUFFIXES = ['localhost', 'local', 'test', 'invalid', 'example', 'onion', 'internal', 'home.arpa', 'lan', 'home', 'corp'];

/**
 * v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 F2): the two free wildcard-DNS services whose names are an IP address and
 * nothing more, such as 203-0-113-7.nip.io or 203.0.113.7.sslip.io. A site that lives at such a name does not control the
 * zone, so no `_magnet` TXT record can exist there (measured: NOERROR with no data), and a lookup would only tell a public
 * resolver which site is being opened. The page tag is the only pointer for these names.
 */
export const WILDCARD_DNS_SUFFIXES = Object.freeze(['nip.io', 'sslip.io']);

/**
 * 0.3.0 independence design (IND-10): hosting platforms whose site names sit in the platform's own zone, where no user can publish a
 * TXT record, so no `_magnet` record can exist under them and a lookup would only send the site's name and the visitor's IP address
 * to the resolvers (for a ts.net name, a private machine name). The list is an inference from how these platforms run their zones;
 * the owner checks each zone with dig before the release. Kept apart from WILDCARD_DNS_SUFFIXES, which tools/name-check.mjs uses as
 * its name services. dedyn.io and duckdns.org are not here: their users can set TXT records.
 */
export const NO_TXT_SUFFIXES = Object.freeze([
  'github.io', 'gitlab.io', 'codeberg.page', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'surge.sh', 'trycloudflare.com', 'ts.net',
]);

// A lower-case host without a trailing dot, or null when the input is not a string or is empty.
function lowerHost(hostname) {
  if (typeof hostname !== 'string') return null;
  let h = hostname.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h || null;
}

/**
 * isWildcardDnsName(hostname) → true for nip.io, sslip.io and every name under them (any case, with or without a trailing
 * dot). A name that only contains the text, such as nip.io.example.com or anip.io, is an ordinary name and gets false.
 */
export function isWildcardDnsName(hostname) {
  const h = lowerHost(hostname);
  if (h === null) return false;
  return WILDCARD_DNS_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

/**
 * isNoTxtPlatformName(hostname) -> true for a name equal to or under one of NO_TXT_SUFFIXES (IND-10), with the same matching as
 * isWildcardDnsName: a dot boundary, so xgithub.io and github.io.example.com get false.
 */
export function isNoTxtPlatformName(hostname) {
  const h = lowerHost(hostname);
  if (h === null) return false;
  return NO_TXT_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

/**
 * shouldSkipDoh(hostname) → true for names a DoH lookup must not be made for: localhost, IP
 * literals, single labels, special-use suffixes (.local, .localhost, .test, .onion, ...),
 * since v0.3 C2 nip.io and sslip.io names (isWildcardDnsName) and, since 0.3.0 IND-10, names on
 * hosting platforms that cannot carry a TXT record (isNoTxtPlatformName).
 */
export function shouldSkipDoh(hostname) {
  const h = lowerHost(hostname);
  if (h === null) return true;
  if (h.charAt(0) === '[' || h.indexOf(':') >= 0) return true; // IPv6 literal
  const labels = h.split('.');
  if (labels.length < 2) return true; // single label
  const last = labels[labels.length - 1];
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last)) return true; // WHATWG "ends in a number": an IPv4 literal
  for (const suffix of SKIP_SUFFIXES) {
    if (h === suffix || h.endsWith('.' + suffix)) return true;
  }
  return isWildcardDnsName(h) || isNoTxtPlatformName(h);
}

/** magnetTxtName(hostname) → '_magnet.' + lowercase hostname without a trailing dot. */
export function magnetTxtName(hostname) {
  let h = String(hostname).trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return TXT_LABEL + h;
}

/**
 * dohOverrideFromMeta(doc = document) → the content of <meta name="mw-doh"> when it is an https
 * URL template (http only for localhost), else null. Templates may contain {name} and {type};
 * without them, `name` and `type` are appended as query parameters.
 */
export function dohOverrideFromMeta(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.querySelector !== 'function') return null;
  const meta = d.querySelector('meta[name="mw-doh"]');
  if (!meta) return null;
  const content = typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : meta.content;
  if (typeof content !== 'string') return null;
  const template = content.trim();
  if (!template) return null;
  let url;
  try {
    url = new URL(template.replace(/\{(?:name|type)\}/g, 'x'));
  } catch (_) {
    return null;
  }
  if (url.protocol === 'https:') return template;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
    return template;
  }
  return null;
}

/** expandTemplate(template, name, type) → request URL for an override resolver. */
export function expandTemplate(template, name, type) {
  if (/\{(?:name|type)\}/.test(template)) {
    return template.replace(/\{name\}/g, encodeURIComponent(name)).replace(/\{type\}/g, encodeURIComponent(type));
  }
  const q = template.indexOf('?');
  const sep = q < 0 ? '?' : (q === template.length - 1 || template.endsWith('&') ? '' : '&');
  return template + sep + 'name=' + encodeURIComponent(name) + '&type=' + encodeURIComponent(type);
}

function overrideResolver(override) {
  if (override && typeof override === 'object' && typeof override.url === 'function') {
    return { name: override.name || 'override', url: override.url, headers: override.headers || { accept: 'application/dns-json' } };
  }
  return { name: 'override', url: (n, t) => expandTemplate(String(override), n, t), headers: { accept: 'application/dns-json' } };
}

/**
 * clampTtlSeconds(ttl) → the TTL the loader uses, in seconds: 5 min to 1 day (v0.3, MF-30). A missing,
 * negative, non-finite or string TTL counts as 0 and becomes the minimum; the bounds themselves are
 * clamped to [MIN_TTL_SECONDS, MAX_TTL_SECONDS] so a caller cannot widen them.
 */
export function clampTtlSeconds(ttl, { min = MIN_TTL_SECONDS, max = MAX_TTL_SECONDS } = {}) {
  const lo = typeof min === 'number' && Number.isFinite(min) ? Math.min(Math.max(min, MIN_TTL_SECONDS), MAX_TTL_SECONDS) : MIN_TTL_SECONDS;
  const hi = typeof max === 'number' && Number.isFinite(max) ? Math.min(Math.max(max, lo), MAX_TTL_SECONDS) : MAX_TTL_SECONDS;
  const seconds = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  return Math.min(Math.max(seconds, lo), hi);
}

/** ttlUntil(ttl, now = Date.now()) → epoch ms until which an answer may be reused (5 min to 1 day). */
export function ttlUntil(ttl, now = Date.now(), { min = MIN_TTL_SECONDS, max = MAX_TTL_SECONDS } = {}) {
  return now + clampTtlSeconds(ttl, { min, max }) * 1000;
}

function validName(name) {
  if (typeof name !== 'string') return null;
  let n = name.trim();
  if (n.endsWith('.')) n = n.slice(0, -1);
  if (!n || n.length > 253) return null;
  for (const label of n.split('.')) {
    if (!label || label.length > 63) return null;
  }
  return n;
}

function asNumber(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function isTxt(answer) {
  if (!answer || typeof answer.data !== 'string') return false;
  const t = answer.type;
  return t === 16 || t === '16' || (typeof t === 'string' && t.toUpperCase() === 'TXT');
}

// Negative-caching TTL (RFC 2308): min(SOA TTL, SOA MINIMUM) over the Authority section.
function negativeTtl(json) {
  let ttl = null;
  const authority = Array.isArray(json.Authority) ? json.Authority : [];
  for (const rr of authority) {
    if (!rr || !(rr.type === 6 || rr.type === '6' || rr.type === 'SOA')) continue;
    let value = asNumber(rr.TTL);
    if (typeof rr.data === 'string') {
      const fields = rr.data.trim().split(/\s+/);
      const minimum = fields.length >= 7 ? asNumber(fields[6]) : null;
      if (minimum !== null) value = value === null ? minimum : Math.min(value, minimum);
    }
    if (value !== null && value >= 0) ttl = ttl === null ? value : Math.min(ttl, value);
  }
  return ttl;
}

function interpret(json, httpStatus, resolverName) {
  if (!json || typeof json !== 'object') throw new Error('HTTP ' + httpStatus + ': unexpected response body');
  const status = asNumber(json.Status);
  if (status === null) throw new Error('HTTP ' + httpStatus + ': no DNS status in the response');
  if (status !== 0 && status !== 3) {
    throw new Error('DNS status ' + status + (httpStatus >= 200 && httpStatus < 300 ? '' : ' (HTTP ' + httpStatus + ')'));
  }
  const answers = status === 0 && Array.isArray(json.Answer) ? json.Answer.filter(isTxt) : [];
  let ttl = null;
  for (const a of answers) {
    const t = asNumber(a.TTL);
    if (t !== null && t >= 0) ttl = ttl === null ? t : Math.min(ttl, t);
  }
  if (answers.length === 0) ttl = negativeTtl(json);
  const ad = json.AD === true || json.AD === 1;
  return {
    resolver: resolverName,
    strings: answers.map((a) => joinTxtData(a.data)),
    ad,
    // v0.3 (MF-30): what AD may be shown as. Never a badge: the loader did not validate anything.
    adWording: ad ? AD_WORDING : null,
    ttl,
    status,
  };
}

function dohError(errors, message) {
  const err = new Error(message || 'DNS-over-HTTPS lookup failed');
  err.code = 'E_DOH';
  err.errors = errors;
  return err;
}

// One resolver. The timeout races the whole exchange (request and body), so it holds even if a
// fetch implementation ignores the abort signal; the AbortController still cancels the request.
async function queryOne(resolver, name, fetchImpl, timeoutMsRaw, outerSignal) {
  const timeoutMs = clampTimerMs(timeoutMsRaw, { min: 1 });
  const controller = new AbortController();
  let timer = null;
  let onOuterAbort = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout after ' + timeoutMs + ' ms'));
    }, timeoutMs);
    if (outerSignal) {
      onOuterAbort = () => {
        controller.abort();
        reject(new Error('aborted'));
      };
      outerSignal.addEventListener('abort', onOuterAbort);
    }
  });
  const attempt = async () => {
    let response;
    try {
      response = await fetchImpl(resolver.url(name, 'TXT'), {
        method: 'GET',
        headers: Object.assign({}, resolver.headers || {}),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error('network error: ' + ((err && err.message) || String(err)));
    }
    let body;
    try {
      body = await readCapped(response, MAX_DOH_BODY_BYTES, controller);
    } catch (err) {
      if (err && err.code === 'E_TOO_LARGE') throw new Error('HTTP ' + response.status + ': body larger than ' + MAX_DOH_BODY_BYTES + ' bytes');
      throw new Error('HTTP ' + response.status + ': unreadable body');
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch (_) {
      throw new Error('HTTP ' + response.status + ': response is not JSON');
    }
    return interpret(json, response.status, resolver.name);
  };
  try {
    return await Promise.race([attempt(), guard]);
  } finally {
    clearTimeout(timer);
    if (outerSignal && onOuterAbort) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

// readCapped(response, max, controller) → the body text, refusing more than `max` bytes (Content-Length first, then the
// stream as it arrives; a body without a stream is measured after text()). PTR-13.
async function readCapped(response, max, controller) {
  const tooLarge = () => Object.assign(new Error('too large'), { code: 'E_TOO_LARGE' });
  const len = response && response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('content-length')) : NaN;
  if (Number.isFinite(len) && len > max) {
    try { controller.abort(); } catch (_) { /* ignore */ }
    throw tooLarge();
  }
  const stream = response && response.body && typeof response.body.getReader === 'function' ? response.body : null;
  if (!stream) {
    const text = await response.text();
    if (typeof text !== 'string' || text.length > max) throw tooLarge();
    return text;
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value ? value.byteLength : 0;
    if (total > max) {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      try { controller.abort(); } catch (_) { /* ignore */ }
      throw tooLarge();
    }
    if (value) chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * resolveTxt(name, { fetch, timeoutMs = 4000, resolvers = RESOLVERS, override = null, signal, accept })
 *   → { resolver, strings, ad, adWording, ttl, status }
 * Tries the resolvers in order (only the override, when given) and returns the first usable
 * answer: Status 0 (strings = one joined string per TXT record, CNAMEs skipped; [] = no record)
 * or Status 3 (NXDOMAIN, strings []). ttl is the smallest answer TTL in seconds, or the negative
 * TTL from the SOA, or null (callers clamp it with clampTtlSeconds or ttlUntil). ad is the
 * resolver's AD flag; adWording is AD_WORDING when it is set (v0.3: shown as words, never as a
 * badge). timeoutMs is clamped with clampTimerMs. Any other status, HTTP error without a DNS body, non-JSON body,
 * network error or timeout moves on to the next resolver. Throws an Error with code 'E_DOH' and
 * errors: [{ resolver, error }] when none answers.
 * Review round R 5.3 (PTR-4, PTR-12): an empty answer (no TXT record, or NXDOMAIN) no longer ends the lookup: the next
 * resolver is asked, and the first empty answer is returned only when no resolver has a record. `accept(result)`
 * (optional, may be async) can refuse a non-empty answer too (for example one older than the cached record): the next
 * resolver is then asked, and when none is accepted the first non-empty answer is returned.
 */
export async function resolveTxt(name, { fetch: fetchImpl = null, timeoutMs = 4000, resolvers = RESOLVERS, override = null, signal = null, accept = null } = {}) {
  const f = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!f) throw dohError([{ resolver: null, error: 'fetch is unavailable' }]);
  const qname = validName(name);
  if (!qname) throw dohError([{ resolver: null, error: 'invalid DNS name ' + JSON.stringify(name) }]);
  const list = override ? [overrideResolver(override)] : resolvers;
  const errors = [];
  let firstEmpty = null;
  let firstRefused = null;
  for (const resolver of list) {
    if (signal && signal.aborted) {
      errors.push({ resolver: resolver.name, error: 'aborted' });
      break;
    }
    let res;
    try {
      res = await queryOne(resolver, qname, f, timeoutMs, signal);
    } catch (err) {
      errors.push({ resolver: resolver.name, error: (err && err.message) || String(err) });
      continue;
    }
    if (!res.strings.length) {
      if (!firstEmpty) firstEmpty = res;
      continue;
    }
    let ok = true;
    if (typeof accept === 'function') {
      try { ok = (await accept(res)) !== false; } catch (_) { ok = true; }
    }
    if (ok) return res;
    if (!firstRefused) firstRefused = res;
  }
  if (firstRefused) return firstRefused;
  if (firstEmpty) return firstEmpty;
  throw dohError(errors);
}
