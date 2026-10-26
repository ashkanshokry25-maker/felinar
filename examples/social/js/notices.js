// Notices: the small messages one member's page sends another member's page when they follow, reply, mention or share
// (R 3.5 "Notifications in the page"). The SDK carries them as chat messages (mw.chat.dm.send / mw.chat.on('message')); this
// file is the template's own convention for what the text of such a message holds, so a notice never shows up as a conversation.
// A notice names things by ledger id and block hash only; it carries no text of the post or comment.
// Kinds: follow (someone followed you), reply (a comment on your post, awaiting your wall setting), mention (@short id in a post),
// share (someone shared your post), wall (a post addressed to your wall) and join (a request to join a group, for its moderators).

import { isRef, makeRef, refKey } from './model.js';
import { isLedgerId, jsonBytes } from './ids.js';
import { LIMITS } from './config.js';

export const NOTICE_PREFIX = 'mwn1:';
export const NOTICE_KINDS = Object.freeze(['follow', 'reply', 'mention', 'share', 'wall', 'join']);
const MAX_NOTICE_BYTES = 1000;

/** encodeNotice({ k, from, ref?, target?, group?, ptr?, note? }) -> the text to send, or null when the notice is not valid. */
export function encodeNotice(n) {
  const clean = normalizeNotice(Object.assign({ v: 1 }, n));
  if (!clean) return null;
  const text = NOTICE_PREFIX + JSON.stringify(clean);
  return jsonBytes(text) <= MAX_NOTICE_BYTES ? text : null;
}
/** decodeNotice(text) -> a notice, or null when the text is an ordinary message (or a malformed notice). */
export function decodeNotice(text) {
  if (typeof text !== 'string' || !text.startsWith(NOTICE_PREFIX) || jsonBytes(text) > MAX_NOTICE_BYTES) return null;
  let raw;
  try { raw = JSON.parse(text.slice(NOTICE_PREFIX.length)); } catch (err) { return null; }
  return normalizeNotice(raw);
}
function normalizeNotice(n) {
  if (!n || typeof n !== 'object' || n.v !== 1 || NOTICE_KINDS.indexOf(n.k) === -1 || !isLedgerId(n.from)) return null;
  const out = { v: 1, k: n.k, from: n.from };
  if (n.ref !== undefined) { if (!isRef(n.ref)) return null; out.ref = makeRef(n.ref.l, n.ref.h); }
  if (n.target !== undefined) { if (!isRef(n.target)) return null; out.target = makeRef(n.target.l, n.target.h); }
  if (n.group !== undefined) { if (!isLedgerId(n.group)) return null; out.group = n.group; }
  if (n.ptr !== undefined) { if (typeof n.ptr !== 'string' || n.ptr.length > 600) return null; out.ptr = n.ptr; }
  if (n.note !== undefined) { if (typeof n.note !== 'string' || n.note.length > 140) return null; out.note = n.note; }
  if ((n.k === 'reply' || n.k === 'share') && !(out.ref && out.target)) return null;
  if ((n.k === 'mention' || n.k === 'wall') && !out.ref) return null;
  if (n.k === 'join' && !out.group) return null;
  return out;
}

/** notificationId(notice): the same event is one entry however many times it arrives (live, then from the hub mailbox). */
export function notificationId(n) {
  return [n.k, n.from, n.ref ? refKey(n.ref) : '', n.group || ''].join('|');
}
/** addNotification(list, notice, t, max): newest first, deduplicated, at most 200 (the requests inbox cap). */
export function addNotification(list, notice, t, max = LIMITS.requestsInbox) {
  const id = notificationId(notice);
  if ((list || []).some((x) => x.id === id)) return list.slice();
  return [Object.assign({ id, t, seen: false }, notice)].concat(list || []).slice(0, max);
}
export const unseenCount = (list) => (list || []).filter((x) => !x.seen).length;
export const markAllSeen = (list) => (list || []).map((x) => Object.assign({}, x, { seen: true }));

/**
 * mentionsOfMe(items, myShort, myLedger): notifications for posts in the synced windows that mention this reader's short id,
 * for the case where the notice itself never arrived. Own posts do not count. myShort is one short id or a list of them: the
 * identity service's short id ("k3f9-2xq1", src/idp/cards.js shortId) is not the one this template shows and its mention picker
 * inserts (ids.js shortIdOf, 8 hex), so the alerts look for both (docs/deviations/rows-social.md).
 */
export function mentionsOfMe(items, myShort, myLedger) {
  const out = [];
  const shorts = (Array.isArray(myShort) ? myShort : [myShort]).filter((x) => typeof x === 'string' && x);
  if (!shorts.length) return out;
  for (const it of items || []) {
    if (!it || it.l === myLedger || typeof it.text !== 'string') continue;
    const hit = shorts.some((short) => {
      const needle = '@' + short;
      for (let at = it.text.indexOf(needle); at !== -1; at = it.text.indexOf(needle, at + 1)) {
        const next = it.text[at + needle.length];
        if (at > 0 && /[0-9A-Za-z_@]/.test(it.text[at - 1])) continue;
        if (next && /[0-9A-Za-z_]/.test(next)) continue;
        return true;
      }
      return false;
    });
    if (hit) out.push({ v: 1, k: 'mention', from: it.l, ref: makeRef(it.l, it.h) });
  }
  return out;
}

/**
 * syncedNotices(view, myLedger): the notices a followed page's window already shows, for when the notice itself never arrived
 * (R 3.5 "Notifications in the page", 3.6: replies from people you follow arrive with their windows). Chat runs per page ledger in
 * this build, so a notice from another member's home page does not reach yours (docs/deviations/rows-social.md); their window does.
 *   reply   a comment on one of my posts (target.l is my ledger), named by its first version, so later edits are one notice
 *   follow  a public follow item (mw.f) that names my ledger ("Followers you can see")
 * Nothing is produced for my own page or for a view without an id.
 */
export function syncedNotices(view, myLedger) {
  const out = [];
  if (!view || !isLedgerId(view.id) || !isLedgerId(myLedger) || view.id === myLedger) return out;
  for (const c of view.comments || []) {
    if (!c || !isRef(c.target) || c.target.l !== myLedger) continue;
    out.push({ v: 1, k: 'reply', from: view.id, ref: makeRef(view.id, c.h), target: makeRef(c.target.l, c.target.h) });
  }
  if (view.follows && typeof view.follows.has === 'function' && view.follows.has(myLedger)) out.push({ v: 1, k: 'follow', from: view.id });
  return out;
}
