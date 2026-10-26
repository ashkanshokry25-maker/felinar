// The hub directory (R 3.4, N-7): names for people, published by the hub as static shards /_dir/<shard>.json, each entry
// { name, ledgerId, pointer, t, sig, hubSig }. The code ships OFF: it runs only when the operator turns on "directory" in
// /config.json, and the flag is labelled "pending counsel" (R 3.4, N-7, ROADMAP; no lawyer is engaged for 0.3.0, so it stays off until a lawyer has looked at it). Names are first
// come, at most one per person. A follow made from the directory pins the ledger id; if the name later points to a different
// ledger the page warns "This name now points to a different page" and does not move your follow.
//
// Every entry is checked before it is shown as a name you can follow (MF-67: signed name records countersigned by the hub), because the
// shards come from the hub's static host or a CDN, which could otherwise map a name to someone else's page:
//   - the pointer is a signed record (v=mw1 with owner= and sig=) and its ledger id is the entry's ledgerId;
//   - sig: the person's signature, by the pointer's owner key, over "mw-dir-v1\n" + the canonical JSON of { ledgerId, name, pointer, t };
//   - hubSig: the hub's signature, by the key the operator puts in /config.json as directoryKey (that file is part of the template the
//     hub publishes, not of the shards), over "mw-dir-hub-v1\n" + the canonical JSON of { ledgerId, name, pointer, sig, t }.
// Signatures are ECDSA P-256 with SHA-256, 64 bytes (r and s), base64url, as every other signature of felinar. Canonical JSON here is
// the object with its keys sorted and no spaces (RFC 8785 for these string and integer values). An entry that fails a check is shown as
// not verified and cannot be followed from the directory; the pin warning counts only verified entries. The pointer's own signature is
// checked by the loader when it is followed (mw.hub.follow). Nothing in felinar signs these records yet: registering a name needs an
// endpoint, which is a backend (R 3.4), so the format is the template's proposal for the operator's exporter (docs/deviations/examples.md).

import { sha256, utf8, b64urlDecode, isLedgerId, isPub } from './ids.js';
import { SHARD_COUNT } from './config.js';
import { parsePointerText, ledgerIdFromPointer } from './hub.js';

export const DIR_PREFIX = 'mw-dir-v1\n';
export const DIR_HUB_PREFIX = 'mw-dir-hub-v1\n';

/** shardOf(name): the first 12 bits of sha256(lowercase name), 0 to 4095. An operator's exporter must use the same rule. */
export function shardOf(name) {
  const d = sha256(utf8(String(name).trim().toLowerCase()));
  return ((d[0] << 4) | (d[1] >> 4)) % SHARD_COUNT;
}
export const shardPath = (name) => '/_dir/' + shardOf(name) + '.json';

/** canonical(obj): the keys sorted, no spaces; for flat objects of strings and integers this is the RFC 8785 form. */
export function canonical(obj) {
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + JSON.stringify(obj[k])).join(',') + '}';
}
/** recordText(entry): what the person signs (sig). */
export const recordText = (e) => DIR_PREFIX + canonical({ ledgerId: e.ledgerId, name: e.name, pointer: e.pointer, t: e.t });
/** hubText(entry): what the hub countersigns (hubSig): the record and the person's signature. */
export const hubText = (e) => DIR_HUB_PREFIX + canonical({ ledgerId: e.ledgerId, name: e.name, pointer: e.pointer, sig: e.sig, t: e.t });

async function verifySig(pub, sigB64, text, subtle) {
  if (!isPub(pub) || typeof sigB64 !== 'string') return false;
  const raw = b64urlDecode(pub.slice(5)), sig = b64urlDecode(sigB64);
  if (!raw || raw.length !== 65 || !sig || sig.length !== 64) return false;
  try {
    const key = await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, utf8(text));
  } catch (err) { return false; }
}

/**
 * verifyEntry(entry, { hubKey, subtle }) -> { ok: true } | { ok: false, reason }: the checks above, in order. reason is one of 'shape',
 * 'pointer' (not a signed record, or its ledger id is not ledgerId), 'sig' (the person did not sign it), 'no-hub-key' (the operator
 * published no directoryKey), 'hubSig' (the hub did not countersign it), 'crypto' (no WebCrypto here).
 */
export async function verifyEntry(entry, { hubKey = '', subtle = globalThis.crypto && globalThis.crypto.subtle } = {}) {
  const e = entry || {};
  if (typeof e.name !== 'string' || !e.name || !isLedgerId(e.ledgerId) || typeof e.pointer !== 'string' || !Number.isSafeInteger(e.t) || e.t < 0) return { ok: false, reason: 'shape' };
  const rec = parsePointerText(e.pointer);
  if (!rec || !rec.sig || !isPub(rec.owner) || ledgerIdFromPointer(rec) !== e.ledgerId) return { ok: false, reason: 'pointer' };
  if (!subtle || typeof subtle.verify !== 'function') return { ok: false, reason: 'crypto' };
  if (!(await verifySig(rec.owner, e.sig, recordText(e), subtle))) return { ok: false, reason: 'sig' };
  if (!isPub(hubKey)) return { ok: false, reason: 'no-hub-key' };
  if (!(await verifySig(hubKey, e.hubSig, hubText(e), subtle))) return { ok: false, reason: 'hubSig' };
  return { ok: true };
}

/** What the page says about an entry that did not verify. */
export const UNVERIFIED_TEXT = Object.freeze({
  shape: 'This entry is not a complete name record.',
  pointer: 'This entry does not carry the signed pointer of the page it names.',
  sig: 'The person this entry names did not sign it.',
  'no-hub-key': 'This hub has not published the key that signs its directory, so no name in it can be checked.',
  hubSig: 'This hub did not sign this entry.',
  crypto: 'This browser cannot check signatures.',
});

/**
 * lookup(name, fetchFn, { hubKey, subtle }) -> { ok: true, entry } | { ok: true, entry: null } | { ok: false, error }.
 * entry: { name, ledgerId, pointer, t, verified, reason }: verified is true only when every check of verifyEntry passed.
 */
export async function lookup(name, fetchFn = (u) => fetch(u, { cache: 'no-store' }), opts = {}) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return { ok: true, entry: null };
  try {
    const res = await fetchFn(shardPath(q));
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const shard = await res.json();
    const list = Array.isArray(shard) ? shard : shard && Array.isArray(shard.names) ? shard.names : [];
    const hit = list.find((e) => e && typeof e.name === 'string' && e.name.toLowerCase() === q && typeof e.ledgerId === 'string');
    if (!hit) return { ok: true, entry: null };
    const entry = { name: hit.name, ledgerId: hit.ledgerId, pointer: typeof hit.pointer === 'string' ? hit.pointer : '', t: Number(hit.t) || 0 };
    const check = await verifyEntry({ name: hit.name, ledgerId: hit.ledgerId, pointer: hit.pointer, t: hit.t, sig: hit.sig, hubSig: hit.hubSig }, opts);
    return { ok: true, entry: Object.assign(entry, { verified: check.ok, reason: check.ok ? '' : check.reason }) };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** pinStatus(pins, ledgerId, entry) -> 'ok' | 'changed' | 'unknown': does the directory still point where this follow was pinned? Only a verified entry counts. */
export function pinStatus(pins, ledgerId, entry) {
  if (!pins || !pins[ledgerId]) return 'unknown';
  if (!entry || entry.verified !== true) return 'unknown';
  return entry.ledgerId === ledgerId ? 'ok' : 'changed';
}
export const CHANGED_WARNING = 'This name now points to a different page';
