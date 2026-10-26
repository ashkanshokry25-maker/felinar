// Magnet URI helpers shared by the browser loader and the Node tools (ARCHITECTURE §4).
// No Buffer, no node: imports. Only BitTorrent v1 infohashes (btih) are understood:
// `urn:btmh:` (v2) parameters are ignored, never an error.

import { decode as base32Decode } from './base32.js';
import { hex } from '../chain/canonical.js';

const HEX40_RE = /^[0-9a-f]{40}$/i;
const BASE32_32_RE = /^[a-z2-7]{32}$/i;

/**
 * normalizeBtih(str) → lowercase 40-hex, or null.
 * Accepts 40 hex characters in either case, or the 32-character base32 form some magnet links
 * still use (RFC 4648 alphabet, either case). A leading `urn:btih:` / `btih:` is tolerated.
 */
export function normalizeBtih(str) {
  if (typeof str !== 'string') return null;
  let s = str.trim();
  const prefix = /^(?:urn:)?btih:/i.exec(s);
  if (prefix) s = s.slice(prefix[0].length);
  if (HEX40_RE.test(s)) return s.toLowerCase();
  if (BASE32_32_RE.test(s)) return hex.encode(base32Decode(s)); // 32 chars = exactly 20 bytes
  return null;
}

/** Order-preserving dedupe of non-empty trimmed strings; anything else is dropped. */
export function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// application/x-www-form-urlencoded order: '+' means space only before percent-decoding, so a
// literal '+' that was encoded as %2B survives the round trip.
function decodeComponent(raw, plusIsSpace) {
  const s = plusIsSpace ? raw.replace(/\+/g, ' ') : raw;
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s; // malformed escape: keep the text rather than lose the parameter
  }
}

// Splits a query string into [key, rawValue] pairs; parameters without '=' are skipped and a
// value keeps any '=' after the first one. Keys of HTML-escaped links ("&amp;tr=") are repaired.
function queryPairs(query) {
  const pairs = [];
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    let key = part.slice(0, eq);
    if (key.slice(0, 4).toLowerCase() === 'amp;') key = key.slice(4);
    pairs.push([key, part.slice(eq + 1)]);
  }
  return pairs;
}

/**
 * parseMagnet(uri) → { btih, dn, tr, ws, xs } | null.
 * Handles `xt=urn:btih:` (hex or base32, also numbered `xt.1=` forms), repeated `tr`/`ws`/`xs`
 * and `dn`; every other parameter is ignored. Returns null when there is no valid btih, or when
 * two different btih values are present (an ambiguous link must never load "the first one").
 */
export function parseMagnet(uri) {
  if (typeof uri !== 'string') return null;
  const s = uri.trim();
  const q = s.indexOf('?');
  if (q < 0 || s.slice(0, q).toLowerCase() !== 'magnet:') return null;

  let btih = null;
  let dn = null;
  const tr = [];
  const ws = [];
  const xs = [];
  for (const [rawKey, rawValue] of queryPairs(s.slice(q + 1))) {
    const key = decodeComponent(rawKey, false).toLowerCase().replace(/\.\d+$/, '');
    switch (key) {
      case 'xt': {
        const value = decodeComponent(rawValue, false);
        const m = /^urn:btih:(.*)$/i.exec(value.trim());
        if (!m) break; // btmh or an unknown urn: ignored
        const hexHash = normalizeBtih(m[1]);
        if (!hexHash) return null; // a btih that is not a btih: malformed link
        if (btih && btih !== hexHash) return null; // two different infohashes: ambiguous
        btih = hexHash;
        break;
      }
      case 'dn': {
        const name = decodeComponent(rawValue, true).trim();
        if (name && dn === null) dn = name;
        break;
      }
      case 'tr':
        tr.push(decodeComponent(rawValue, false));
        break;
      case 'ws':
        ws.push(decodeComponent(rawValue, false));
        break;
      case 'xs':
        xs.push(decodeComponent(rawValue, false));
        break;
      default:
        break;
    }
  }
  if (!btih) return null;
  return { btih, dn, tr: uniqueStrings(tr), ws: uniqueStrings(ws), xs: uniqueStrings(xs) };
}

/**
 * formatMagnet({ btih, dn, tr, ws, xs }) → string with a fixed parameter order
 * (xt, dn, tr..., ws..., xs...); list order is preserved (it expresses priority), duplicates
 * and empty entries are dropped. Throws TypeError when btih is not a valid infohash.
 */
export function formatMagnet({ btih, dn, tr = [], ws = [], xs = [] } = {}) {
  const hexHash = normalizeBtih(btih);
  if (!hexHash) throw new TypeError('formatMagnet: btih must be a 40-hex or base32 infohash');
  let out = 'magnet:?xt=urn:btih:' + hexHash;
  if (typeof dn === 'string' && dn.trim()) out += '&dn=' + encodeURIComponent(dn.trim());
  for (const url of uniqueStrings(tr)) out += '&tr=' + encodeURIComponent(url);
  for (const url of uniqueStrings(ws)) out += '&ws=' + encodeURIComponent(url);
  for (const url of uniqueStrings(xs)) out += '&xs=' + encodeURIComponent(url);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Web-seed filter for unsigned records (v0.3 hardening, V03-DESIGN-REVIEW MF-76, PEER A9)
// ---------------------------------------------------------------------------------------------
// A bare magnet or an unsigned pointer is written by whoever wrote the link, so its ws= and xs= URLs
// must not turn visitors into a probe of their own network or a reflector: at most WEBSEED_MAX_WS ws=
// and WEBSEED_MAX_XS xs=, https only, and no loopback, link-local, private, special-use or .local host,
// except the page's own origin (the drop-in's /_mw/t/ and /_mw/ws/ paths, local development). The filter
// reports only how many URLs it dropped, never why one URL failed (no per-URL failure reasons: a
// reason per URL would tell the link author which internal hosts exist).

/** Unsigned records: at most this many ws= and xs= URLs are used (MF-76). */
export const WEBSEED_MAX_WS = 4;
export const WEBSEED_MAX_XS = 2;

// Special-use names that resolve to the visitor's own machine or network (RFC 6761, 6762, 8375, ICANN
// .internal) and common LAN suffixes; single-label names are intranet names.
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'lan', 'home', 'corp', 'intranet', 'localdomain'];
// Review round R 5.3 (PTR-8): public DNS names that answer with an address written in the name, or always with
// loopback (wildcard DNS services). Any name under them is refused: the spelling hides a loopback or LAN address.
export const WILDCARD_DNS_SUFFIXES = Object.freeze([
  'nip.io', 'sslip.io', 'xip.io', 'traefik.me', 'localtest.me', 'lvh.me', 'vcap.me', 'local.gd', 'lacolhost.com',
  'localhost.direct', 'plex.direct', 'nip.direct', 'backname.io', 'fuf.me', 'yoogle.com', 'readme.localtest.me'
]);
// A signed record (its signer may be anyone: signing is free) keeps at most this many ws= and xs= (PTR-8).
export const WEBSEED_SIGNED_MAX_WS = 8;
export const WEBSEED_SIGNED_MAX_XS = 4;

// A label that spells an IPv4 address with dashes (192-168-1-1) or a run of labels that is a dotted IPv4 address
// (10.0.0.5.example.net) names that address on wildcard DNS services: refused when the address is not public.
function embeddedPrivateIpv4(labels) {
  for (const l of labels) {
    const m = /^(?:[a-z0-9-]*?-)?(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?:-[a-z0-9-]*)?$/.exec(l);
    if (m) {
      const p = m.slice(1).map(Number);
      if (p.every((n) => n <= 255) && privateIpv4(p)) return true;
    }
  }
  for (let i = 0; i + 4 <= labels.length; i++) {
    const p = labels.slice(i, i + 4);
    if (p.every((x) => /^\d{1,3}$/.test(x)) && p.map(Number).every((n) => n <= 255) && privateIpv4(p.map(Number))) return true;
  }
  return false;
}

function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateIpv4(p) {
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && p[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

// The 8 hextets of an IPv6 literal as WHATWG URL prints it (compressed, lowercase, IPv4 tail allowed).
function ipv6Hextets(literal) {
  let s = literal;
  const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const p = ipv4Parts(tail[1]);
    if (!p) return null;
    s = s.slice(0, tail.index + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = head.concat(new Array(fill).fill('0'), rest);
  if (all.length !== 8) return null;
  const out = [];
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    out.push(parseInt(h, 16));
  }
  return out;
}

function privateIpv6(h) {
  if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((h[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && (h[5] === 0xffff || h[5] === 0)) {
    return privateIpv4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255]); // IPv4-mapped and -compatible
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) return privateIpv4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255]); // NAT64
  if (h[0] === 0x2002) return privateIpv4([h[1] >> 8, h[1] & 255, h[2] >> 8, h[2] & 255]); // 6to4
  return false;
}

/**
 * isPublicWebHost(hostname) → false for loopback, link-local, private, multicast and other special
 * addresses (IPv4, IPv6, IPv4-mapped), for localhost and .local, .internal, .home.arpa, .lan and other
 * LAN suffixes, and for single-label names; true otherwise. `hostname` is URL.hostname (WHATWG URL has
 * already turned 0x7f.1 and friends into dotted IPv4, and keeps IPv6 in brackets).
 */
export function isPublicWebHost(hostname) {
  if (typeof hostname !== 'string') return false;
  let h = hostname.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return false;
  if (h.charAt(0) === '[') {
    const hextets = ipv6Hextets(h.slice(1, -1));
    return !!hextets && !privateIpv6(hextets);
  }
  const v4 = ipv4Parts(h);
  if (v4) return !privateIpv4(v4);
  if (/^[0-9.]+$/.test(h) || /^0x/.test(h)) return false; // a numeric form URL did not normalise: refuse
  if (h.indexOf('.') < 0) return false; // single label: an intranet name
  for (const suffix of LOCAL_SUFFIXES) if (h === suffix || h.endsWith('.' + suffix)) return false;
  for (const suffix of WILDCARD_DNS_SUFFIXES) if (h === suffix || h.endsWith('.' + suffix)) return false; // PTR-8
  if (embeddedPrivateIpv4(h.split('.'))) return false; // PTR-8: 127.0.0.1.example.net, 192-168-1-1.example.net
  return true;
}

/** isPublicHttpsUrl(url, { base, origin }) → true for a URL on the page's own origin, or https on a public host without userinfo (PTR-8). */
export function isPublicHttpsUrl(url, { base = null, origin = null } = {}) {
  let own = null;
  try {
    own = origin ? new URL(origin).origin : null;
  } catch (_) {
    own = null;
  }
  let u;
  try {
    u = new URL(String(url), base || own || undefined);
  } catch (_) {
    return false;
  }
  if (own && u.origin === own) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return isPublicWebHost(u.hostname);
}

/**
 * filterWebseeds({ ws, xs }, { origin, signed = false, base }) → { ws, xs, dropped }.
 * Review round R 5.3 (PTR-8): signed records get the same host rule, with caps WEBSEED_SIGNED_MAX_WS / _XS (8, 4);
 * before, they kept their lists whole. Unsigned records: each URL is resolved
 * against `base` (default: `origin`); a URL on the page's own `origin` is kept as is; any other URL must
 * be https on a public host (isPublicWebHost) without userinfo; then at most WEBSEED_MAX_WS ws= and
 * WEBSEED_MAX_XS xs= are kept, in order. `dropped` counts every URL left out; no per-URL reason is given.
 * Kept URLs are returned as written (relative ones stay relative).
 */
export function filterWebseeds({ ws = [], xs = [] } = {}, { origin = null, signed = false, base = null } = {}) {
  const wsList = Array.isArray(ws) ? ws.filter((u) => typeof u === 'string') : [];
  const xsList = Array.isArray(xs) ? xs.filter((u) => typeof u === 'string') : [];
  // Review round R 5.3 (PTR-8): a signature proves nothing about the hosts (anyone can sign a record for any btih), so
  // signed records get the same host rule; only their caps are larger.
  const maxWs = signed ? WEBSEED_SIGNED_MAX_WS : WEBSEED_MAX_WS;
  const maxXs = signed ? WEBSEED_SIGNED_MAX_XS : WEBSEED_MAX_XS;
  let own = null;
  try {
    own = origin ? new URL(origin).origin : null;
  } catch (_) {
    own = null;
  }
  const resolveAgainst = base || own || undefined;
  const allowed = (raw) => {
    let u;
    try {
      u = new URL(raw, resolveAgainst);
    } catch (_) {
      return false;
    }
    if (own && u.origin === own) return true;
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return isPublicWebHost(u.hostname);
  };
  const pick = (list, max) => {
    const out = [];
    for (const raw of list) if (out.length < max && allowed(raw)) out.push(raw);
    return out;
  };
  const keptWs = pick(wsList, maxWs);
  const keptXs = pick(xsList, maxXs);
  return { ws: keptWs, xs: keptXs, dropped: (wsList.length - keptWs.length) + (xsList.length - keptXs.length) };
}
