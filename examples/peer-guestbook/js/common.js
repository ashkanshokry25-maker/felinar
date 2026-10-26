// Shared helpers for the v0.3 pages of the guestbook: sign in and out (auth.js), the profile page (profile.js) and the members
// area (members.js). The guestbook's own page logic is js/app.js, which stays one file with no static imports.
// Text that came from other visitors is only ever set as text, never as HTML.

export const $ = (sel) => document.querySelector(sel);
export const setText = (sel, text) => { const n = $(sel); if (n) n.textContent = text; };
export const show = (sel, on) => { const n = $(sel); if (n) n.hidden = !on; };
const has = Object.prototype.hasOwnProperty;

// Element builder: children are appended as nodes or as text, never parsed as HTML.
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const key of Object.keys(attrs || {})) {
    if (key === 'class') node.className = attrs[key];
    else if (attrs[key] != null) node.setAttribute(key, attrs[key]);
  }
  for (const child of children) if (child != null && child !== '') node.append(child);
  return node;
}
export function toast(text, kind) {
  const box = $('#toasts'), node = h('div', { class: 'toast ' + (kind || 'info') }, text);
  if (box) { box.append(node); setTimeout(() => node.remove(), 5000); }
}

// The SDK's English sentences for the v0.3 codes (src/loader/strings.js ERROR_TEXT; test/example/site.test.mjs compares them)
// and the sentence this site adds for a loader that is not there.
export const ERRORS = {
  E_NOT_SIGNED_IN: 'Sign in to do this.', E_USER_CANCELLED: 'You cancelled.',
  E_UNSUPPORTED: 'This browser cannot do this. Use a current version of Chrome, Edge, Firefox or Safari.',
  E_FIELD: 'That field name is reserved. Choose another.', E_DECRYPT: 'This could not be opened with your keys.',
  E_HOST_ONLY_IDENTITY: 'This address shares one origin with other sites, so your identity applies to this visit only.',
  E_POPUP_BLOCKED: 'Your browser blocked the sign-in window. Tap Sign in again.',
  E_IDP_UNREACHABLE: 'The identity page could not be reached. Check your connection and try again.',
  E_NEEDS_GESTURE: 'Tap the button on the page to continue.', E_HOST_ONLY: 'This feature needs peer connections, and you chose host only.',
  E_NO_OWN_TRACKER: 'This site has not set up its own connection server, so chat is off here.',
  E_FILE_UNAVAILABLE: 'Nobody who has this file is online right now.', E_FILE_TOMBSTONED: 'This file was removed.',
  E_FILE_HASH: 'This file did not match its checksum and was dropped.', E_DENIED: 'You do not have access to this.',
  E_MEDIA_TYPE: 'This kind of file is not accepted here.',
  E_MEDIA_STRIP: 'Location and camera details could not be removed, so the file was not sent.',
  E_POLICY: 'This site does not allow that.', E_LIMIT: 'That is over the limit.', E_RATE: 'Too fast. Wait a few seconds and try again.',
  E_BANNED: 'You cannot post here.',
  // the rest of the SDK's codes (src/loader/api.js ERROR_CODES), each with its ERROR_TEXT sentence or the one ERROR_STRING_KEYS names
  E_NOT_OWNER: 'Only the owner of this site can do this.', E_NOT_MODERATOR: 'Only a moderator of this site can do this.',
  E_POW_ABORTED: 'Cancelled before the spam fee finished.', E_IDENTITY: 'Your keys or this site ledger are not available in this browser right now. Reload the page, or sign out and sign in again.',
  E_CAP: 'This device is out of storage for this site. Free some space, or remove saved sites in Settings.', E_BAD_REQUEST: 'That request was not valid.',
  E_INTERNAL: 'Something went wrong on this page. Reload it and try again.', E_TIMEOUT: 'This took too long. Check your connection and try again.',
  E_NONCE_REQUIRED: 'This site did not send a sign-in code. Reload the page and try again.',
  E_LEDGER_FULL: 'This site cannot take more entries right now.', E_SYNCING: 'Still catching up with the site. Try again in a moment.',
  E_NO_CHAT_KEY: '{name} has not turned on messages on this site.', E_BLOCKED: 'You cannot send to {name}.',
  E_STAMP: 'Working out the spam fee did not finish. Try again.', E_NOT_MEMBER: 'You are not a member of this group.',
  E_NOT_ADMIN: 'Only an admin of this group can do this.', E_NOT_CONTACT: 'Direct connections are only for your contacts.',
  E_PEER_UNREACHABLE: '{name} could not be reached directly.', E_MEDIA_UNPLAYABLE: 'This browser cannot play this file.',
  E_REVOKED: 'Access to this was taken back.', E_BUSY: 'The other person is in another call.', E_DECLINED: 'The call was declined.',
  E_NO_ANSWER: 'Nobody answered the call.',
  E_MEDIA_DENIED: 'The browser did not allow the microphone or camera. Allow it in the site settings of your browser and try again.',
  E_NO_DEVICE: 'No microphone or camera was found on this device.',
  E_CALL_FAILED: 'The call could not be connected, or its connection could not be checked.',
  E_NO_HOST: 'This page is not running inside the felinar loader.',
};
/**
 * explain(err) -> the sentence a visitor sees. A code without a sentence gets a generic line that names it, as the SDK's errorText does;
 * an internal message (err.message) is never shown. {name} in a sentence is the person the error is about.
 */
export function explain(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code && has.call(ERRORS, code)) return ERRORS[code].replace(/^\{name\}/, 'This person').replace(/\{name\}/g, 'this person');
  return code ? 'Something went wrong (' + code + ').' : 'Something went wrong.';
}

// The SDK is imported dynamically: on a plain static host the page keeps its text and says so.
export async function loadSdk() {
  try { const mod = await import('/_mw/sdk.js'); return mod.default || globalThis.mw || null; } catch (err) { return null; }
}
export function standalone(reason) { show('#standalone', true); setText('#standalone-why', reason); }
/** readyInfo(mw) -> the ready() answer, or null when this page is not inside the loader (the standalone notice is shown). */
export async function readyInfo(mw) {
  if (!mw) { standalone('The loader SDK at /_mw/sdk.js is not served here.'); return null; }
  try { return (await mw.ready()) || {}; } catch (err) { standalone(explain(err)); return null; }
}
// A loader older than v0.3 has no mw.auth: the device key signs and there is nothing to sign in to.
export const hasAuth = (mw) => !!(mw && mw.auth && typeof mw.auth.signIn === 'function');
export const isGuest = (info) => !!info && info.auth === 'guest';

// Two taps instead of a modal confirm: works without allow-modals and suits phones.
export function armed(cls, label, run) {
  const btn = h('button', { class: 'link danger ' + cls, type: 'button' }, label);
  const reset = () => { btn.disabled = false; btn.dataset.armed = ''; btn.textContent = label; };
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to confirm';
      return setTimeout(() => { if (!btn.disabled) reset(); }, 3000);
    }
    btn.disabled = true;
    try { await run(); } catch (err) { toast(explain(err), 'error'); } finally { reset(); }
  });
  return btn;
}
export function fmtBytes(n) {
  let i = 0;
  for (n = Number(n) || 0; n >= 1024 && i < 3; i += 1) n /= 1024;
  return (i ? n.toFixed(1) : String(n)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
}
// Short id = first 8 hex of sha256(raw public key, without the 'p256:' tag), the loader's rule.
const shortIds = new Map();
export function shortId(pub) {
  if (!shortIds.has(pub)) shortIds.set(pub, (async () => {
    try {
      const b64 = pub.slice(pub.indexOf(':') + 1).replace(/-/g, '+').replace(/_/g, '/');
      const raw = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
      return Array.from(digest.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) { return String(pub).slice(0, 8); } // no WebCrypto, or not base64url
  })());
  return shortIds.get(pub);
}
