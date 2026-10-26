// src/identity/migrate.js: moving a 0.2.1 identity into the identity origin (R 2.2.7, amends ID 3.7; D-5;
// INTERFACES v0.3 migrate.js).
//
// 0.2.1 keys are random, extractable and stored per ledger on the site origin ('identity:<ledgerId>' in the
// loader's keys store). On the first v0.3 sign-in on a ledger that has one:
//   1. the sign-in request names the legacy public key; the IdO card offers "Keep posting as <name> (your old
//      key)" (the default) or "Start fresh";
//   2. after that choice the IdO asks for the key (an IdO ephemeral ECDH key) and this page answers with the
//      private JWK sealed to it (LEGACY_PREFIX): it is exported once, into the IdO window only, where it goes
//      into the vault and the next backup file;
//   3. with "keep" the bundle carries link = { from: legacy, to: new, t, sigTo } (sigTo by the new key over
//      "mw-link-v1\n" + ledgerId + from + to + t); the caller appends it to 'mw.link' on that ledger only, as a
//      block authored by the legacy key (public on that site, never written anywhere else);
//   4. the legacy key is deleted from the site origin only after a backup file made after the key entered the vault
//      exists (status.legacyBackedUp: the identity origin compares the backup's time with the key's); until then it
//      stays (it is the only copy outside the vault's devices). Code review v0.3 (security 15): fileSaved is a
//      lifetime flag, so a backup made a month before the migration used to delete the only other copy.
// On writers: 'allow' sites the legacy key stays the author until the owner adds the new key (HON M9).
//
//   migrateLegacy(ledgerId, legacyRecord, client, opts) -> { result, choice, stored, link, item, deleteLegacy }
//   legacyOption(ledgerId, record, { name }) / legacyOutcome(result, legacyPub, { removeLegacy }): the two halves,
//     for callers that must open the identity window before they know whether a legacy key exists
//   exportLegacyJwk(record, cryptoApi) -> the private JWK of a 0.2.1 record
//   legacyAuthorFor({ policy, newPub, legacyPub }) -> the key that should author writes on this ledger
//
// Shared code: Node >= 22 and browsers.

import { isPublicKeyString } from '../chain/crypto.js';

const migrateError = (code, message) => Object.assign(new Error(message), { code });

/** exportLegacyJwk(record, cryptoApi) -> { kty, crv, x, y, d } of a stored 0.2.1 identity record. */
export async function exportLegacyJwk(record, cryptoApi = globalThis.crypto) {
  if (!record || typeof record !== 'object') throw migrateError('E_BAD_REQUEST', 'no legacy identity');
  if (record.kind === 'jwk' && record.jwk && typeof record.jwk.d === 'string') {
    return { kty: 'EC', crv: 'P-256', x: record.jwk.x, y: record.jwk.y, d: record.jwk.d };
  }
  if (record.kind === 'cryptokey' && record.privateKey) {
    try {
      const jwk = await cryptoApi.subtle.exportKey('jwk', record.privateKey);
      return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
    } catch (_) {
      throw migrateError('E_UNSUPPORTED', 'this legacy key cannot be exported (it was stored non-extractable)');
    }
  }
  throw migrateError('E_BAD_REQUEST', 'unknown legacy identity record');
}

/**
 * legacyOption(ledgerId, legacyRecord, { name, cryptoApi }) -> the `legacy` option of client.signIn:
 * { pub, ledger, name, exportKey() } (exportKey runs only when the IdO asks, after the person's choice).
 */
export function legacyOption(ledgerId, legacyRecord, { name, cryptoApi = globalThis.crypto } = {}) {
  if (!legacyRecord || !isPublicKeyString(legacyRecord.pub)) return null;
  const out = { pub: legacyRecord.pub, ledger: ledgerId, exportKey: () => exportLegacyJwk(legacyRecord, cryptoApi) };
  if (typeof name === 'string' && name) out.name = name;
  return out;
}

/**
 * legacyOutcome(result, legacyPub, { removeLegacy }) -> { choice, stored, link, item, deleteLegacy } read from the
 * bundle the IdO answered with; runs removeLegacy() when the key is in the vault and a backup file made after it
 * entered the vault exists (status.legacyBackedUp).
 */
export async function legacyOutcome(result, legacyPub, { removeLegacy } = {}) {
  const K = result && result.bundle;
  const legacy = K && K.legacy ? K.legacy : null;
  const choice = legacy && (legacy.choice === 'keep' || legacy.choice === 'fresh') ? legacy.choice : null;
  const stored = Boolean(legacy && legacy.stored);
  let link = null;
  if (legacy && legacy.link && legacy.link.from === legacyPub && isPublicKeyString(legacy.link.to) && Number.isSafeInteger(legacy.link.t) && typeof legacy.link.sigTo === 'string') {
    link = { from: legacy.link.from, to: legacy.link.to, t: legacy.link.t, sigTo: legacy.link.sigTo };
  }
  const deleteLegacy = stored && Boolean(K && K.status && K.status.legacyBackedUp === true);
  if (deleteLegacy && typeof removeLegacy === 'function') {
    try { await removeLegacy(); } catch (_) { /* it stays; the next sign-in tries again */ }
  }
  return { choice, stored, link, item: link ? { l: 'mw.link', v: link } : null, deleteLegacy };
}

/**
 * migrateLegacy(ledgerId, legacyRecord, client, opts) -> {
 *   result,         // what client.signIn resolved with (result.bundle is the new working-key bundle)
 *   choice,         // 'keep' | 'fresh' | null (null when the IdO could not take the key)
 *   stored,         // the IdO vault holds the legacy key now
 *   link,           // { from, to, t, sigTo } for 'mw.link' (keep only), else null
 *   item,           // { l: 'mw.link', v: link } ready for the caller's legacy-key writer, else null
 *   deleteLegacy,   // true once the key is in the vault and a backup file made after that exists
 * }
 * client: an object with signIn (src/identity/client.js). opts: { pointer, name, escrow, record, countPosts,
 * win, idp, cryptoApi, removeLegacy() } - removeLegacy runs when deleteLegacy is true.
 */
export async function migrateLegacy(ledgerId, legacyRecord, client, opts = {}) {
  if (typeof ledgerId !== 'string' || !ledgerId) throw new TypeError('migrateLegacy needs the ledger id');
  if (!legacyRecord || !isPublicKeyString(legacyRecord.pub)) throw migrateError('E_BAD_REQUEST', 'no legacy identity');
  if (!client || typeof client.signIn !== 'function') throw new TypeError('migrateLegacy needs the identity client');
  const signInOpts = {
    purpose: 'site', want: ['keys'], pointer: opts.pointer, scope: opts.scope, escrow: opts.escrow, record: opts.record, countPosts: opts.countPosts,
    win: opts.win, idp: opts.idp, cryptoApi: opts.cryptoApi,
    legacy: legacyOption(ledgerId, legacyRecord, { name: opts.name, cryptoApi: opts.cryptoApi }),
  };
  for (const k of Object.keys(signInOpts)) if (signInOpts[k] === undefined) delete signInOpts[k];
  // No await before signIn: it opens the identity window inside the caller's click.
  const result = await client.signIn(signInOpts);
  return Object.assign({ result }, await legacyOutcome(result, legacyRecord.pub, { removeLegacy: opts.removeLegacy }));
}

/**
 * legacyAuthorFor({ policy, newPub, legacyPub }) -> newPub or legacyPub. On a writers: 'allow' ledger the legacy
 * key keeps authoring until the owner adds the new key to allow (R 2.2.7, 2.5.4); elsewhere the new key writes.
 */
export function legacyAuthorFor({ policy, newPub, legacyPub } = {}) {
  if (!policy || policy.writers !== 'allow' || !legacyPub) return newPub;
  const allow = policy.allow instanceof Set ? policy.allow : new Set(Array.isArray(policy.allow) ? policy.allow : []);
  return allow.has(newPub) ? newPub : legacyPub;
}
