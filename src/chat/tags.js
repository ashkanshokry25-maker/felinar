// Tags (R 2.7.4, 2.7.5, 2.7.6, 2.7.7; MF-33, PRIV M3, STALK A1):
//   contact tag   HMAC(K_pair, "tag|" + day)[:8]           only the two parties can compute it
//   inbox tag     SHA-256("mw-inbox-v2|" + ek + "|" + day)[:8]   publicly computable from the chat key:
//                 NEVER sent in WANT-TAGS (not even its prefix); stranger mail is collected only through
//                 INBOX-CHAL / INBOX-RESP at the pin mailbox
//   presence id   HMAC(K_pair, "pres|" + day)[:8]
//   group tag     HMAC(K_g, "gtag|" + day)[:8]
// `day` is the full UTC day number (days since 1970) as a decimal string. Recipients ask for day - 1,
// day and day + 1 (clock skew at the boundary), and holders also for the older days of the 7-day hold
// (heldDays: held mail keeps the tag of the day it was sent on). WANT-TAGS carry 1-byte prefixes mixed with random decoy
// prefixes (k-anonymity buckets), or full contact tags only to a holder the person chose.
//
// Shared code: WebCrypto only, no Buffer, no node: imports.

import { utf8, hex } from '../chain/canonical.js';
import { sha256 } from '../chain/crypto.js';
import { TAG_BYTES, INBOX_PREFIX, WANT_MAX, WANT_DECOYS, PRES_SLOT_BYTES } from './limits.js';

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

/** HMAC-SHA-256(key, data) -> Uint8Array(32). */
export async function hmac(key, data) {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, typeof data === 'string' ? utf8.encode(data) : data));
}

function dayString(day) {
  if (!Number.isSafeInteger(day) || day < 0) throw new TypeError('day must be a non-negative integer (UTC days since 1970)');
  return String(day);
}

/** Contact tag of a pair for a UTC day (the vector form, the same in both directions). */
export async function contactTag(kPair, day) {
  return (await hmac(kPair, 'tag|' + dayString(day))).slice(0, TAG_BYTES);
}

/**
 * Directional contact tag (review round, PRIV-1): HMAC(K_pair, "tag|" + day + "|" + senderEk)[:8]. A message and its ACK, or
 * a message and its reply, carry different tags, so a neighbour of both parties cannot link the two addresses by one tag.
 * The service seals contact mail and SIG with the sender's own chat key here and listens for its contacts' keys.
 */
export async function contactTagFrom(kPair, day, senderEk) {
  if (typeof senderEk !== 'string') throw new TypeError('contactTagFrom: senderEk is a p256: key string');
  return (await hmac(kPair, 'tag|' + dayString(day) + '|' + senderEk)).slice(0, TAG_BYTES);
}

/**
 * secureRandom() -> a float in [0, 1) from crypto.getRandomValues (review round, SEC-10): decoy prefixes, presence slots,
 * jitter and relay subsets must not be predictable from earlier draws, as Math.random's xorshift128+ is.
 */
export function secureRandom() {
  const u = new Uint32Array(2);
  globalThis.crypto.getRandomValues(u);
  // 53 random bits: (hi 21 bits * 2^32 + lo 32 bits) / 2^53
  return ((u[0] >>> 11) * 4294967296 + u[1]) / 9007199254740992;
}

/** Stranger inbox tag of a chat key (the 'p256:' string) for a UTC day. Publicly computable. */
export async function inboxTag(ek, day) {
  if (typeof ek !== 'string') throw new TypeError('inboxTag: ek is a p256: key string');
  return (await sha256(utf8.encode(INBOX_PREFIX + ek + '|' + dayString(day)))).slice(0, TAG_BYTES);
}

/** Presence blinded id of a contact for a UTC day. */
export async function presenceId(kPair, day) {
  return (await hmac(kPair, 'pres|' + dayString(day))).slice(0, PRES_SLOT_BYTES);
}

/** Group tag of a group epoch key for a UTC day. */
export async function groupTag(kGroup, day) {
  return (await hmac(kGroup, 'gtag|' + dayString(day))).slice(0, TAG_BYTES);
}

/** The three days a recipient listens on: day - 1, day, day + 1. */
export function listenDays(day) {
  return [day - 1, day, day + 1];
}

/** The older days a recipient asks holders for (held mail keeps its day for up to `days` days): day - days .. day - 2. */
export function heldDays(day, days = 7) {
  const out = [];
  for (let d = day - days; d <= day - 2; d++) if (d >= 0) out.push(d);
  return out;
}

/** Hex key of a tag (Map keys). */
export function tagKey(tag) {
  return hex.encode(tag);
}

function randomByte(random) {
  return Math.floor(random() * 256) & 255;
}

/**
 * buildWant(interests, { decoys = 4, random = secureRandom, holderChosen = false }) -> Uint8Array[] entries.
 * interests: [{ tag: Uint8Array(8), kind: 'contact' | 'group' | 'inbox' }]. Inbox tags are refused
 * (publicly computable, MF-33): they never appear, not as prefixes and not in full. With holderChosen the
 * entries are the full contact and group tags (a holder the person chose); otherwise 1-byte prefixes,
 * de-duplicated, mixed with `decoys` random prefixes that match no interest, shuffled. At most 32 entries.
 */
export function buildWant(interests, { decoys = WANT_DECOYS, random = secureRandom, holderChosen = false } = {}) {
  const usable = [];
  for (const it of interests || []) {
    if (!it || !(it.tag instanceof Uint8Array) || it.tag.length !== TAG_BYTES) continue;
    if (it.kind !== 'contact' && it.kind !== 'group') continue; // inbox and unknown kinds never go out
    usable.push(it.tag);
  }
  let entries;
  if (holderChosen) {
    const seen = new Set();
    entries = [];
    for (const t of usable) {
      const k = tagKey(t);
      if (!seen.has(k)) {
        seen.add(k);
        entries.push(t.slice());
      }
    }
  } else {
    const prefixes = new Set();
    for (const t of usable) prefixes.add(t[0]);
    const real = new Set(prefixes);
    let guard = 0;
    while (prefixes.size < real.size + decoys && prefixes.size < 256 && guard++ < 4096) {
      const b = randomByte(random);
      if (!real.has(b)) prefixes.add(b);
    }
    entries = Array.from(prefixes).map((b) => Uint8Array.of(b));
  }
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const x = entries[i];
    entries[i] = entries[j];
    entries[j] = x;
  }
  return entries.slice(0, WANT_MAX);
}

/** True when a WANT entry matches a tag (1-byte prefix or full tag). */
export function wantMatches(entry, tag) {
  if (entry.length === 1) return tag[0] === entry[0];
  if (entry.length !== tag.length) return false;
  for (let i = 0; i < tag.length; i++) if (entry[i] !== tag[i]) return false;
  return true;
}
