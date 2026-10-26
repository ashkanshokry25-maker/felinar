// src/dropin/rules.js: the decisions of drop-in mode as pure functions (ARCHITECTURE §3.4, §8;
// DESIGN-REVIEW item 23). The engine (engine.js) asks; these answer from plain data, so every rule
// has a unit test and none depends on a browser.
//
//   webseedDecision      may the engine add the host's /_mw/ws/ as a web seed?        (3.4.7)
//   dropinRecord         the pointer record with that web seed added
//   announceAllowed      may sockets and peers be opened right now?                    (3.4.6, §8)
//   promptFor            which consent card, if any, the visitor sees                  (3.4.9)
//   consentFromPref      the stored consent value                                      (§8)
//   planVersions         which stored versions to keep and which to delete             (3.4.5)
//   mapVerdict           how a missing page feature degrades                            (3.4.8)

import { normalizeBtih } from '../common/magnet.js';

export const DROPIN = Object.freeze({
  webseedPath: '/_mw/ws/',
  maxVersionsKept: 2, // the current one and at most one previous
  visibleAnnounceMs: 3000,
});

/**
 * webseedDecision({ policy, sw }) → { allowed, reason }
 * The host is the web seed only on unmetered networks (policy.column 'cellular' covers cellular,
 * Save-Data and the unknown network of a phone), and only when a worker that answers /_mw/ws/
 * controls the page (our /mw-sw.js, or a site worker that imports /_mw/sw-core.js).
 */
export function webseedDecision({ policy, sw } = {}) {
  const column = policy && policy.column;
  if (column === 'cellular') return { allowed: false, reason: 'metered' };
  const mode = sw && sw.mode;
  if (mode === 'off') return { allowed: false, reason: 'sw-off' };
  if (mode === 'foreign') return { allowed: false, reason: 'foreign-worker' };
  if (mode === 'integrated' || mode === 'ours') {
    if (sw.controlled) return { allowed: true, reason: null };
    return { allowed: false, reason: 'uncontrolled' };
  }
  if (mode === 'uncontrolled') return { allowed: false, reason: 'uncontrolled' };
  return { allowed: false, reason: 'no-worker' };
}

/**
 * dropinRecord(record, { origin, allowWebseed }) → a copy of the record for TorrentManager.download():
 * the web seed https://<host>/_mw/ws/ is added to ws= when allowed. The verified record itself is
 * never modified (it is what was signed). xs= may be relative (/_mw/t/<btih>.torrent): the
 * TorrentManager resolves it against the page.
 */
export function dropinRecord(record, { origin, allowWebseed = false } = {}) {
  const copy = Object.assign({}, record);
  copy.ws = Array.isArray(record.ws) ? record.ws.slice() : [];
  copy.xs = Array.isArray(record.xs) ? record.xs.slice() : [];
  copy.tr = Array.isArray(record.tr) ? record.tr.slice() : [];
  if (allowWebseed && origin) {
    const url = String(origin).replace(/\/+$/, '') + DROPIN.webseedPath;
    if (copy.ws.indexOf(url) < 0) copy.ws.push(url);
  }
  return copy;
}

/**
 * announceAllowed({ consent, hostOnly, visible, suspended, webrtc, noStore }) → boolean.
 * Trackers and peers (the only things that reveal the visit to third parties) need: the visitor's
 * consent, no host-only choice, WebRTC in the browser, 3 s of visible time on this page view, and a
 * page that is not being put into the back/forward cache. v0.2.1 D4: a page the host served with
 * Cache-Control: no-store runs host-only (noStore, from the worker's mw-ack doc): Chromium keeps such
 * a page out of the back/forward cache for life after any WebSocket or WebRTC use.
 */
export function announceAllowed({ consent, hostOnly = false, visible = false, suspended = false, webrtc = true, noStore = false } = {}) {
  return consent === 'accepted' && !hostOnly && !noStore && Boolean(visible) && !suspended && Boolean(webrtc);
}

/**
 * promptFor({ consent, webrtc, siteHandlesConsent, recordConsent }) → 'notice' | 'gate' | null.
 * Nothing when consent is stored (accepted or host-only), when the browser has no WebRTC (host only
 * is forced, nothing connects), or when the site explains sharing itself (data-mw-consent="site")
 * and opens the card with mw.consent.request() (v0.2.1 A4: a site never accepts). consent=gate in the
 * pointer asks with the gate instead of the notice.
 */
export function promptFor({ consent = 'pending', webrtc = true, siteHandlesConsent = false, recordConsent = null } = {}) {
  if (consent !== 'pending') return null;
  if (!webrtc || siteHandlesConsent) return null;
  return recordConsent === 'gate' ? 'gate' : 'notice';
}

/** consentFromPref(value) → 'pending' | 'accepted' | 'host-only' (the shell stores a string, older notes an object). */
export function consentFromPref(value) {
  if (value === 'accepted' || value === 'host-only') return value;
  if (value && typeof value === 'object' && (value.state === 'accepted' || value.state === 'host-only')) return value.state;
  return 'pending';
}

/**
 * planVersions({ versions, current, live }) → { versions, drop }
 *   versions  btihs this ledger stored so far, newest first (the pref `versions:<ledgerId>`)
 *   current   the btih of this page
 *   live      { btih: number of live controlled clients } from the worker, or null when unknown
 * Keeps the current version and at most one previous one, and the previous one only while a live
 * client still renders it (its lazy chunks): the first older version that has one, or, when the
 * worker cannot say, the most recent. Everything else is dropped (3.4.5, item 21).
 */
export function planVersions({ versions = [], current, live = null } = {}) {
  const cur = normalizeBtih(current);
  const seen = new Set();
  const older = [];
  for (const v of Array.isArray(versions) ? versions : []) {
    const b = normalizeBtih(v);
    if (!b || b === cur || seen.has(b)) continue;
    seen.add(b);
    older.push(b);
  }
  let previous = null;
  for (const b of older) {
    if (live === null || live === undefined) {
      previous = b;
      break;
    }
    if ((Number(live[b]) || 0) > 0) {
      previous = b;
      break;
    }
  }
  const keep = [];
  if (cur) keep.push(cur);
  if (previous && keep.length < DROPIN.maxVersionsKept) keep.push(previous);
  return { versions: keep, drop: older.filter((b) => b !== previous) };
}

const HARD_FEATURES = [
  ['indexedDB', 'IndexedDB'],
  ['crypto.subtle', 'Web Crypto (HTTPS only)'],
  ['fetch', 'fetch()'],
  ['TextEncoder', 'TextEncoder'],
  ['ReadableStream', 'ReadableStream'],
  ['BigInt', 'BigInt'],
  ['AbortController', 'AbortController'],
  ['MessageChannel', 'MessageChannel'],
  ['Blob', 'Blob'],
];

function has(win, path) {
  let obj = win;
  for (const part of path.split('.')) {
    if (obj === null || obj === undefined) return false;
    try {
      obj = obj[part];
    } catch (_) {
      return false;
    }
  }
  return obj !== undefined && obj !== null;
}

/**
 * missingFeatures(win) → [label] of the hard requirements this browser lacks (the floor is
 * Safari/iOS 15.4, Chromium 110, Firefox 115). Soft features (RTCPeerConnection, serviceWorker,
 * Web Locks, BroadcastChannel) are never listed here: each has its own fallback.
 */
export function missingFeatures(win) {
  const out = [];
  for (const [path, label] of HARD_FEATURES) if (!has(win, path)) out.push(label);
  if (!win || win.isSecureContext === false) out.push('a secure context (HTTPS or localhost)');
  return out;
}
