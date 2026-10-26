// tools/name-check.mjs: the name a server with only an IP address gets, and a check that the name works
// (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 F2, F3 and F6, recommendation Rc4). Pure helpers plus one lookup that the
// caller can replace, so every test runs with canned answers and nothing here opens a socket by itself.
//
//   ipName('203.0.113.7')              -> '203-0-113-7.nip.io'
//   ipName('203.0.113.7', 'sslip.io')  -> '203-0-113-7.sslip.io'
//   await nameCheck({ ip, suffix, resolve4, resolve6 })  -> { ok, name, got, reason }, reason 'ok' | 'blocked' | 'other' | 'nxdomain' | 'error'
//   await chooseName({ ip, suffixes, resolve4 })         -> the first service whose name answers the server's own address
//   describeNameCheck(check, { ip, alt })                -> the plain-words text for a failed check (S2 string Z4)
//
// nip.io and sslip.io are one free DNS service run by two volunteers (S2 F1). A name with the address in it answers that
// address. The service keeps a block list of addresses used in phishing: for those, the name answers the block page
// (64.176.22.9, or 2001:19f0:c800:2315:: over IPv6; S2 F3, measured 2026-10-20) instead of the server. A recycled server
// address can be on the list before anybody uses it, so the name is checked before a site is published under it.
// nip.io comes first because a DNS filter list covers sslip.io and not nip.io (S2 F6).

import { promises as dnsPromises } from 'node:dns';

import { WILDCARD_DNS_SUFFIXES } from '../src/loader/doh.js';
import { UsageError } from './lib.mjs';

/** The services that name an address, in the order they are tried: nip.io first (S2 F6). */
export const NAME_SERVICES = WILDCARD_DNS_SUFFIXES;
/** The addresses the services answer for a name they block (S2 F3). */
export const BLOCK_PAGE_ADDRESSES = Object.freeze(['64.176.22.9', '2001:19f0:c800:2315::']);

const OCTET = '(?:0|[1-9][0-9]{0,2})';
const IPV4 = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}$');

/** isIPv4Text(text) -> true for four decimal octets from 0 to 255 without leading zeros ('203.0.113.7'). */
export function isIPv4Text(text) {
  return typeof text === 'string' && IPV4.test(text) && text.split('.').every((part) => Number(part) <= 255);
}

/**
 * ipName(ip, suffix = 'nip.io') -> 'a-b-c-d.<suffix>'. UsageError for anything but an IPv4 address and one of NAME_SERVICES.
 * (IPv4 only: the rented-server rung of the ladder needs a public IPv4 address, S2 rung 2a.)
 */
export function ipName(ip, suffix = 'nip.io') {
  if (!isIPv4Text(ip)) throw new UsageError('the address must be an IPv4 address such as 203.0.113.7, got ' + JSON.stringify(ip));
  if (NAME_SERVICES.indexOf(suffix) < 0) throw new UsageError('the name service must be ' + NAME_SERVICES.join(' or ') + ', got ' + JSON.stringify(suffix));
  return ip.split('.').join('-') + '.' + suffix;
}

// The eight 16-bit groups of an IPv6 text address, or null when it is not one. Only what a DNS answer can hold.
function ipv6Groups(text) {
  if (typeof text !== 'string' || text.indexOf(':') < 0 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => {
    if (part === '') return [];
    const groups = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return head.concat(new Array(missing).fill(0), tail);
}

/** isBlockPageAddress(address) -> true when a service answers this address for a name it blocks (either family, any notation). */
export function isBlockPageAddress(address) {
  if (typeof address !== 'string') return false;
  const a = address.trim().toLowerCase();
  if (BLOCK_PAGE_ADDRESSES.indexOf(a) >= 0) return true;
  const groups = ipv6Groups(a);
  if (!groups) return false;
  return BLOCK_PAGE_ADDRESSES.some((b) => {
    const want = ipv6Groups(b);
    return want !== null && want.every((g, i) => g === groups[i]);
  });
}

// c-ares and getaddrinfo answer a name that does not exist or has no record of the type with these codes.
const NO_ANSWER_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * systemResolve4(name) → Promise<[IPv4 address]>: the A records as this computer's own resolver gives them (getaddrinfo, so the operating
 * system's DNS settings, a local resolver and a VPN's split DNS all apply), which is what a browser here would reach. Not DNS-over-HTTPS.
 */
export async function systemResolve4(name) {
  return (await dnsPromises.lookup(name, { all: true, family: 4 })).map((r) => r.address);
}

function sortedUnique(list) {
  return Array.from(new Set(list.map((x) => String(x).trim().toLowerCase()))).sort();
}

/**
 * nameCheck({ ip, suffix = 'nip.io', resolve4 = dns.promises.resolve4, resolve6 = null })
 *   -> Promise<{ ok, name, ip, suffix, got: [address], reason, error? }>
 * Resolves the name in Node (the system resolver, not DNS-over-HTTPS) and compares the answer with the server's own address.
 *   ok        reason 'ok': the name answers the address (and no block page address)
 *   blocked   reason 'blocked': the name answers the block page of the service (S2 F3)
 *   other     reason 'other': it answers some other address, such as a filtering resolver's
 *   nxdomain  reason 'nxdomain': the name does not exist or has no address record
 *   error     reason 'error': the lookup itself failed (timeout, SERVFAIL, no network); `error` holds the message
 * resolve4(name) and resolve6(name) return arrays of addresses and throw like dns.promises; the default resolve4 is systemResolve4; resolve6 is optional.
 */
export async function nameCheck({ ip, suffix = 'nip.io', resolve4 = null, resolve6 = null } = {}) {
  const name = ipName(ip, suffix);
  const lookup4 = resolve4 || systemResolve4;
  let got = [];
  let failure = null;
  const take = async (fn) => {
    try {
      const list = await fn(name);
      if (Array.isArray(list)) got = got.concat(list.map(String));
    } catch (err) {
      if (!(err && NO_ANSWER_CODES.has(err.code))) failure = failure || err;
    }
  };
  await take(lookup4);
  if (resolve6) await take(resolve6);
  got = sortedUnique(got);
  const base = { name, ip, suffix, got };
  if (got.some(isBlockPageAddress)) return Object.assign(base, { ok: false, reason: 'blocked' });
  if (got.indexOf(ip) >= 0) return Object.assign(base, { ok: true, reason: 'ok' });
  if (got.length > 0) return Object.assign(base, { ok: false, reason: 'other' });
  if (failure) return Object.assign(base, { ok: false, reason: 'error', error: (failure && failure.message) || String(failure) });
  return Object.assign(base, { ok: false, reason: 'nxdomain' });
}

/**
 * chooseName({ ip, suffixes = NAME_SERVICES, resolve4, resolve6 })
 *   -> Promise<{ ok, name, suffix, checks: [nameCheck result] }>
 * Tries the services in order and stops at the first whose name answers the address; `checks` holds every attempt, so a caller can
 * say why nip.io was not used. ok is false, with name and suffix null, when none works.
 */
export async function chooseName({ ip, suffixes = NAME_SERVICES, resolve4 = null, resolve6 = null } = {}) {
  const checks = [];
  for (const suffix of suffixes) {
    const check = await nameCheck({ ip, suffix, resolve4, resolve6 });
    checks.push(check);
    if (check.ok) return { ok: true, name: check.name, suffix, checks };
  }
  return { ok: false, name: null, suffix: null, checks };
}

/**
 * describeNameCheck(check, { alt = null }) -> the text for a check that failed. For 'blocked' it is S2 string Z4 as written,
 * with the sentence that names another service only when `alt` (the other service's name for this address) is given.
 * The other reasons say what happened without claiming a cause: only the block page is known to come from the service.
 */
export function describeNameCheck(check, { alt = null } = {}) {
  const { name, ip } = check;
  const got = check.got.join(' and ');
  const tail = (alt ? 'Try ' + alt + ', use another server, or use a domain you own.' : 'Use another server, or use a domain you own.');
  switch (check.reason) {
    case 'ok':
      return name + ' points to ' + ip + '.';
    case 'blocked':
      return name + ' points to ' + got + ', not to ' + ip + '. The service blocks names for addresses used in phishing. ' + tail;
    case 'other':
      return name + ' points to ' + got + ', not to ' + ip + '. A resolver between this computer and the service may be changing the answer. ' + tail;
    case 'nxdomain':
      return name + ' has no address record, so the service did not answer for it. ' + tail;
    default:
      return 'The name ' + name + ' could not be looked up (' + (check.error || 'no answer') + '). Check this computer\'s DNS and try again. ' + tail;
  }
}
