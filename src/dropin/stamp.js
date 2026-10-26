// src/dropin/stamp.js: the stamped pointer of a drop-in page (ARCHITECTURE §3.4.1, §4;
// DESIGN-REVIEW items 11, 23). tools/publish.mjs --dropin stamps
//   <meta name="mw-pointer" content="v=mw1; btih=...; xs=/_mw/t/<btih>.torrent; ...">
// into every HTML page. /_mw/mw.js reads it here, verifies the record with src/common/pointer.js
// against the page's own hostname (the signature covers the scope, so a record stamped for another
// host fails) and decides whether the engine may start. Pure functions over injected parts: no
// DOM globals are touched, so Node tests run them with a fake document.
//
//   readStampedText(doc)                  content of the first <meta name="mw-pointer"> | null
//   findScriptTag(doc, moduleUrl)         the <script> element that loaded /_mw/mw.js | null
//   parseScriptOptions(tag)               { sw: 'auto'|'off', consent: 'notice'|'site' }
//   evaluateStamp(input, deps)            → verdict (status 'ok' | 'key-changed' | 'rejected')
//   describeRejection(reason)             one console-ready sentence per verdict reason

import { parsePointer, verifyPointer, verifyRotation, ledgerIdFor, normalizeScope } from '../common/pointer.js';

export const META_NAME = 'mw-pointer';
const BTIH_RE = /^[0-9a-f]{40}$/;
const DAY_MS = 86400000;
const EXPIRY_WARN_DAYS = 14;

/** The content of the first <meta name="mw-pointer"> of the document (trimmed), or null. */
export function readStampedText(doc) {
  if (!doc || typeof doc.getElementsByTagName !== 'function') return null;
  const metas = doc.getElementsByTagName('meta');
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    const name = meta && typeof meta.getAttribute === 'function' ? meta.getAttribute('name') : null;
    if (name === null || name === undefined || String(name).trim().toLowerCase() !== META_NAME) continue;
    const content = meta.getAttribute('content');
    if (content === null || content === undefined) return null;
    const text = String(content).trim();
    return text || null;
  }
  return null;
}

/**
 * findScriptTag(doc, moduleUrl) → the <script src> whose URL has the same origin and path as the
 * module (document.currentScript is null for module scripts, so import.meta.url is matched
 * against the page's script elements), else the first script that ends in /_mw/mw.js, else null.
 */
export function findScriptTag(doc, moduleUrl) {
  if (!doc || typeof doc.getElementsByTagName !== 'function') return null;
  const scripts = doc.getElementsByTagName('script');
  let want = null;
  try {
    want = new URL(String(moduleUrl));
  } catch (_) {
    want = null;
  }
  const base = doc.baseURI || (want ? want.href : undefined);
  let fallback = null;
  for (let i = 0; i < scripts.length; i++) {
    const el = scripts[i];
    const src = el && typeof el.getAttribute === 'function' ? el.getAttribute('src') : null;
    if (!src) continue;
    let url;
    try {
      url = new URL(src, base);
    } catch (_) {
      continue;
    }
    if (want && url.origin === want.origin && url.pathname === want.pathname) return el;
    if (!fallback && /\/_mw\/mw\.js$/.test(url.pathname)) fallback = el;
  }
  return fallback;
}

function attr(tag, name) {
  if (!tag || typeof tag.getAttribute !== 'function') return null;
  const v = tag.getAttribute(name);
  return v === null || v === undefined ? null : String(v).trim().toLowerCase();
}

/**
 * parseScriptOptions(tag) → { sw, consent }.
 *   data-mw-sw="off"       never register /mw-sw.js and unregister ours if it is there (3.4.4)
 *   data-mw-consent="site" the site explains sharing itself and calls mw.consent.request() (from a
 *                          click) to open the loader's card; the notice is not shown on its own (3.4.9)
 */
export function parseScriptOptions(tag) {
  return {
    sw: attr(tag, 'data-mw-sw') === 'off' ? 'off' : 'auto',
    consent: attr(tag, 'data-mw-consent') === 'site' ? 'site' : 'notice',
  };
}

function verdict(extra) {
  return Object.assign({
    ok: false,
    status: 'rejected',
    reason: null,
    record: null,
    signed: false,
    scope: null,
    ledgerId: null,
    firstTime: false,
    rotated: false,
    expiresSoon: false,
  }, extra);
}

/**
 * evaluateStamp({ text, scope, now, pin, cachedSeq }, deps) → Promise<verdict>
 *
 *   text       the stamped content
 *   scope      location.hostname (normalised here to the lowercase A-label host)
 *   pin        { owner } remembered for this scope (TOFU), or null
 *   cachedSeq  highest seq seen for this scope, or null (a lower seq is a rollback)
 *
 * verdict = { ok, status: 'ok'|'key-changed'|'rejected', reason, record, signed, scope, ledgerId,
 *             firstTime, rotated, expiresSoon, oldOwner?, newOwner? }
 *
 * Signed records must verify (signature over the scope, required exp and seq, not expired, not
 * rolled back). A different owner key than the pin is accepted silently only with a valid rot=;
 * otherwise status is 'key-changed' and the visitor decides (the record itself is valid).
 * Unsigned records (a bare magnet or a pointer without sig) are accepted unless the scope is
 * pinned, and give an unmoderated ledger. Never throws.
 */
export async function evaluateStamp({ text, scope, now = Date.now(), pin = null, cachedSeq = null } = {}, deps = {}) {
  const d = Object.assign({ parsePointer, verifyPointer, verifyRotation, ledgerIdFor, normalizeScope }, deps);
  try {
    if (typeof text !== 'string' || !text.trim()) return verdict({ reason: 'empty' });
    let host;
    try {
      host = d.normalizeScope(scope);
    } catch (_) {
      return verdict({ reason: 'bad-scope' });
    }
    const parsed = d.parsePointer(text.trim());
    if (!parsed || !parsed.ok || !parsed.record) {
      return verdict({ scope: host, reason: 'parse: ' + ((parsed && parsed.error) || 'invalid') });
    }
    const record = parsed.record;
    const base = { record, scope: host };
    if (!BTIH_RE.test(String(record.btih || ''))) return verdict(Object.assign(base, { reason: 'no-btih' }));
    const pinnedOwner = pin && typeof pin.owner === 'string' && pin.owner ? pin.owner : null;

    if (!record.sig) {
      if (pinnedOwner) return verdict(Object.assign(base, { reason: 'unsigned-pinned' }));
      const ledgerId = await d.ledgerIdFor(record, host);
      return verdict(Object.assign(base, { ok: true, status: 'ok', ledgerId, signed: false }));
    }

    let v = await d.verifyPointer(record, host, { now, pinnedOwner, cachedSeq });
    if (!v.ok && v.reason === 'owner-changed' && pinnedOwner) {
      // The signature may still be perfectly valid: ask the visitor, do not guess. A key the
      // visitor confirms starts a new seq floor (code review round 1), so the old one does not apply.
      const unpinned = await d.verifyPointer(record, host, { now, pinnedOwner: null, cachedSeq: null });
      if (!unpinned.ok) return verdict(Object.assign(base, { reason: unpinned.reason || 'invalid', signed: true }));
      const ledgerId = await d.ledgerIdFor(record, host);
      return verdict(Object.assign(base, { status: 'key-changed', reason: 'owner-changed', signed: true, ledgerId, oldOwner: pinnedOwner, newOwner: record.owner }));
    }
    if (!v.ok) return verdict(Object.assign(base, { reason: v.reason || 'invalid', signed: true }));
    const ledgerId = await d.ledgerIdFor(record, host);
    const expiresAt = typeof record.exp === 'number' ? record.exp * 1000 : null;
    return verdict(Object.assign(base, {
      ok: true,
      status: 'ok',
      signed: true,
      ledgerId,
      rotated: Boolean(v.rotated),
      firstTime: !pinnedOwner,
      expiresSoon: expiresAt !== null && expiresAt - now < EXPIRY_WARN_DAYS * DAY_MS,
    }));
  } catch (err) {
    return verdict({ reason: 'error: ' + ((err && err.message) || String(err)) });
  }
}

const REASONS = {
  empty: 'the pointer on this page is empty',
  'bad-scope': 'the page address cannot be used as a pointer scope',
  'no-btih': 'the pointer has no valid infohash',
  unsigned: 'the pointer is not signed',
  'unsigned-pinned': 'this site has a remembered publisher key, so an unsigned pointer is refused',
  'bad-owner': 'the pointer carries an invalid owner key',
  'bad-sig': 'the pointer signature does not match this site (a pointer stamped for another host fails here)',
  'missing-exp': 'the signed pointer has no expiry',
  'missing-seq': 'the signed pointer has no sequence number',
  expired: 'the pointer has expired, the publisher has to sign it again',
  'exp-too-far': 'the pointer expires more than 400 days from now',
  'seq-rollback': 'the pointer is older than one this device has already seen',
  'seq-future': 'the pointer carries a sequence number more than a day ahead of this device\'s clock',
  'owner-changed': 'the publisher key changed',
};

/** describeRejection(reason) → a sentence for the one console warning (no em dashes). */
export function describeRejection(reason) {
  const key = String(reason || '');
  if (REASONS[key]) return REASONS[key];
  if (key.startsWith('parse: ')) return 'the pointer on this page does not parse (' + key.slice(7) + ')';
  if (key.startsWith('error: ')) return 'the pointer could not be checked (' + key.slice(7) + ')';
  return 'the pointer on this page was refused (' + (key || 'unknown reason') + ')';
}
