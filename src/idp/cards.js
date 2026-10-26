// src/idp/cards.js: the identity origin's cards (R 2.3.4, 2.3.5, 2.2.6, 2.2.7, 2.3.8, 2.14.1, 2.15, 3.3; MF-03,
// MF-06, MF-09, MF-11, MF-12, MF-13, MF-20). These are the only screens in the project that ask for or show the
// 12 words, a backup file or a passphrase (E-ID-10): they run at the IdO address the browser shows, never on a
// site origin.
//
// Two parts:
//   policies (pure, tested on their own): sameIdentityOptions, recordSameOffer, approvalAllowed, kitDue,
//     reentryPositions, registrableSplit
//   createCards({ doc, win, lang, build, now, minPressMs }) -> { signin, confirmSame, chooseUnlock, passphrase,
//     showPhrase, reentry, restore, checkCode, foundPosts, recoveryKit, backupFile, saveBackup, tapToFinish,
//     createPage, ownerAction, recordRead, erase, legacy, replaceKeys, removeDevice, message, error, busy, progress,
//     showCodes, scanCode, settings, close, root }
//   Each card replaces the previous one and resolves on the person's own press (isTrusted !== false, and not in
//   the first minPressMs after it appeared). Text comes from strings.js; site-supplied text (origin, statement,
//   names) is set with textContent only. Styling is idp.css (CSP style-src 'self') plus CSSOM properties.

import { t, errorText, pickLang, IDP_STRING_FLAGS } from './strings.js';
import { encode as qrEncode } from './qr.js';
import { publicSuffixOf } from './psl.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { utf8 } from '../chain/canonical.js';

export const SAME_OFFER_INTERVAL_MS = 30 * 24 * 3600 * 1000;
export const MIN_PRESS_MS = 400;
export const SECOND_PRESS_MS = 800;

// ---------------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------------

/**
 * sameIdentityOptions({ state, origin, now }) -> [{ origin, label }]: the "Same as on ..." entries the mode
 * menu may list for this origin (R 2.3.5, MF-12). Empty when the person refused it here before (a refusal is
 * remembered), or when it was offered here in the last 30 days. Only origins with a persistent label count.
 * The menu's default is always "Private to this site"; nothing in a request can preselect an entry.
 */
export function sameIdentityOptions({ state, origin, now = Date.now() } = {}) {
  if (!state || !state.origins) return [];
  const rec = state.same && state.same[origin];
  if (rec && rec.refusedAt) return [];
  if (rec && rec.offeredAt && now - rec.offeredAt < SAME_OFFER_INTERVAL_MS) return [];
  const out = [];
  for (const o of Object.keys(state.origins).sort()) {
    if (o === origin) continue;
    const e = state.origins[o];
    if (!e || typeof e.label !== 'string' || e.keyMode === 'visit-only') continue;
    if (out.some((x) => x.label === e.label)) continue;
    out.push({ origin: o, label: e.label });
  }
  return out;
}

/** recordSameOffer(state, origin, { now, outcome: 'shown' | 'linked' | 'refused' }) -> state (mutated). */
export function recordSameOffer(state, origin, { now = Date.now(), outcome } = {}) {
  if (!state.same) state.same = {};
  const rec = state.same[origin] || {};
  if (outcome === 'shown') rec.offeredAt = now;
  else if (outcome === 'linked') { rec.offeredAt = rec.offeredAt || now; rec.linkedAt = now; }
  else if (outcome === 'refused') { rec.offeredAt = rec.offeredAt || now; rec.refusedAt = now; }
  else throw new TypeError('recordSameOffer: outcome');
  state.same[origin] = rec;
  return state;
}

/**
 * approvalAllowed({ state, origin, uv }) -> { ok, first, code? }: the first approval of an origin requires
 * user verification (a passkey assertion with the UV flag, or the passphrase or phrase typed here; R 2.3.4,
 * MF-07), so a reverse proxy cannot collect a silent approval.
 */
export function approvalAllowed({ state, origin, uv } = {}) {
  const first = !(state && state.origins && state.origins[origin]);
  if (first && uv !== true) return { ok: false, first, code: 'E_UV_REQUIRED' };
  return { ok: true, first };
}

/**
 * kitDue({ ios, standalone, kitSaved, meaningful }) -> { show, ios, offerHomeScreen } (R 2.2.6,
 * MF-11): after the first meaningful action until the kit is saved; on iOS outside Home Screen mode on every
 * visit until saved. offerHomeScreen is always false here (code review v0.3, browser): the identity page added to
 * the Home Screen is a separate web app with storage of its own that starts empty, and sites keep opening Safari's
 * copy, so the step would keep nothing (round 1 removed the same promise from the loader).
 */
export function kitDue({ ios = false, standalone = false, kitSaved = false, meaningful = false } = {}) {
  if (kitSaved) return { show: false, ios: false, offerHomeScreen: false };
  const iosOutside = ios && !standalone;
  return { show: iosOutside || meaningful, ios: iosOutside, offerHomeScreen: false };
}

/** reentryPositions(random) -> three distinct word positions 1..12, ascending (the 3-word re-entry check). */
export function reentryPositions(random = Math.random) {
  const set = new Set();
  while (set.size < 3) set.add(1 + Math.floor(random() * 12) % 12);
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * registrableSplit(host) -> { sub, reg }: the part shown in bold (R 2.3.4 "registrable part in bold"). With a
 * listed public suffix: suffix plus one label; otherwise the last two labels (three for a ccSLD like co.uk).
 * Display only: no decision uses it.
 */
export function registrableSplit(host) {
  const h = String(host || '').toLowerCase();
  const hostname = h.replace(/:\d+$/, '');
  const port = h.length > hostname.length ? h.slice(hostname.length) : '';
  if (/^[\d.]+$/.test(hostname) || hostname.indexOf('.') < 0 || hostname.startsWith('[')) return { sub: '', reg: h };
  const labels = hostname.split('.');
  const ps = publicSuffixOf(hostname);
  let n;
  if (ps && ps !== hostname) n = ps.split('.').length + 1;
  else {
    const last = labels[labels.length - 1];
    const second = labels[labels.length - 2];
    n = last.length === 2 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'gv'].indexOf(second) >= 0 ? 3 : 2;
  }
  n = Math.min(n, labels.length);
  return { sub: labels.slice(0, labels.length - n).join('.') + (labels.length > n ? '.' : ''), reg: labels.slice(labels.length - n).join('.') + port };
}

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

function identiconCells(pub) {
  const h = sha256Sync(utf8.encode(String(pub || '')));
  const hue = Math.round((h[0] / 255) * 360);
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const col = x < 3 ? x : 4 - x;
      cells.push(((h[1 + y * 3 + col] || 0) & 1) === 1);
    }
  }
  return { hue, cells };
}

/** shortId(pub) -> 'k3f9-2xq1' style id (8 base32 characters of SHA-256(pub)) used on the cards. */
export function shortId(pub) {
  const h = sha256Sync(utf8.encode(String(pub || '')));
  const A = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += A[h[i] & 31];
  return s.slice(0, 4) + '-' + s.slice(4);
}

/**
 * createCards(opts) -> the card set. opts: { doc, win, lang, build: { version, id, hash, test }, now, minPressMs,
 * secondPressMs, idp (this origin, for the copy) }.
 */
export function createCards(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new TypeError('createCards needs a document');
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const lang = pickLang(opts.lang || (win && win.navigator && win.navigator.language) || 'en');
  const now = opts.now || (() => Date.now());
  const minPress = opts.minPressMs === undefined ? MIN_PRESS_MS : opts.minPressMs;
  const secondPress = opts.secondPressMs === undefined ? SECOND_PRESS_MS : opts.secondPressMs;
  const build = opts.build || { version: '0.3.0', id: 'dev', hash: '', test: false };
  const idp = opts.idp || (win && win.location ? win.location.origin : '');
  const L = (key, params) => t(key, params, lang);

  let root = opts.root || null;
  if (!root) {
    root = doc.createElement('main');
    root.setAttribute('class', 'mw-idp');
    root.setAttribute('data-mw-idp-cards', '1');
    // Accessibility lane: the cards' language, so a screen reader reads French cards in French (WCAG 3.1.1, 3.1.2); on the
    // identity page itself (html data-mw-idp) the whole document is in that language.
    root.setAttribute('lang', lang);
    const html = doc.documentElement;
    if (html && typeof html.hasAttribute === 'function' && html.hasAttribute('data-mw-idp')) html.setAttribute('lang', lang);
    (doc.body || doc.documentElement).appendChild(root);
  }
  let pending = null; // resolve of the card on screen

  function el(tag, attrs, text) {
    const e = doc.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, String(attrs[k]));
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function clear() {
    if (pending) {
      const r = pending;
      pending = null;
      r(null);
    }
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  // A card without a title is named by its own message (the element with id mw-card-text, which message() and busy() add),
  // so a screen reader announces the dialog with its words (accessibility lane, axe aria-dialog-name).
  function frame(titleText) {
    clear();
    const card = el('section', { class: 'mw-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleText ? 'mw-card-title' : 'mw-card-text' });
    let heading = null;
    if (titleText) {
      heading = el('h1', { id: 'mw-card-title', tabindex: '-1' }, titleText);
      card.appendChild(heading);
    }
    root.appendChild(card);
    focusOn(heading || card);
    return card;
  }

  /**
   * focusOn(node): review round UX-9: each card replaces the last one, so the pressed button is gone and focus would fall to
   * the body; focus moves to the new card's heading (or the card itself, or its error line) so a screen reader announces
   * the new step and the next Tab reaches its first control. Never a button: a stray Enter must not press one.
   */
  function focusOn(node) {
    if (!node) return;
    try {
      if (typeof node.getAttribute === 'function' && node.getAttribute('tabindex') === null) node.setAttribute('tabindex', '-1');
      if (typeof node.focus === 'function') node.focus({ preventScroll: false });
    } catch (_) {
      // a document without focus (tests, a closed window)
    }
  }

  function footer(card) {
    const f = el('footer', { class: 'mw-build' });
    f.appendChild(el('span', null, L('build', { version: build.version || '', id: build.id || '' })));
    if (build.hash) f.appendChild(el('span', null, ' ' + L('bundleHash', { hash: String(build.hash).slice(0, 12) })));
    if (build.test) f.appendChild(el('strong', { class: 'mw-test' }, ' ' + L('testBuild')));
    card.appendChild(f);
  }

  function button(text, { primary = false, danger = false, onPress, delay = minPress } = {}) {
    const b = el('button', { type: 'button', class: primary ? 'mw-primary' : danger ? 'mw-danger' : 'mw-secondary' }, text);
    const shownAt = now();
    b.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      if (now() - shownAt < delay) return;
      if (b.disabled) return;
      onPress(ev);
    });
    return b;
  }

  function checkbox(labelText, { checked = false, name } = {}) {
    const wrap = el('label', { class: 'mw-check' });
    const box = el('input', { type: 'checkbox', name });
    box.checked = Boolean(checked);
    wrap.appendChild(box);
    wrap.appendChild(el('span', null, labelText));
    return { wrap, box };
  }

  function waitCard() {
    return new Promise((resolve) => { pending = resolve; });
  }

  function done(value) {
    const r = pending;
    pending = null;
    if (r) r(value);
  }

  function identityLine(pub, card) {
    const line = el('p', { class: 'mw-as' });
    line.appendChild(el('span', null, L('as') + ' '));
    if (pub) {
      const { hue, cells } = identiconCells(pub);
      const icon = el('span', { class: 'mw-identicon', 'aria-hidden': 'true' });
      for (const on of cells) {
        const c = el('span', { class: 'mw-cell' });
        if (on && c.style && typeof c.style.setProperty === 'function') c.style.setProperty('background-color', 'hsl(' + hue + ', 55%, 45%)');
        icon.appendChild(c);
      }
      line.appendChild(icon);
      line.appendChild(el('span', { class: 'mw-short' }, ' ' + shortId(pub)));
    } else {
      line.appendChild(el('span', { class: 'mw-short' }, L('newIdentityHere')));
    }
    card.appendChild(line);
  }

  function originHeading(origin, card) {
    const h = el('h1', { id: 'mw-card-title' });
    h.appendChild(el('span', null, L('signInTo') + ' '));
    let host = origin;
    try { host = new URL(origin).host; } catch (_) { /* shown as given */ }
    const split = registrableSplit(host);
    if (split.sub) h.appendChild(el('span', { class: 'mw-sub' }, split.sub));
    h.appendChild(el('strong', { class: 'mw-reg' }, split.reg));
    card.appendChild(h);
    card.appendChild(el('p', { class: 'mw-origin' }, origin));
  }

  // -------------------------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------------------------

  /**
   * signin(data) -> { action: 'continue' | 'cancel' | 'restore' | 'link', mode, stay, sharedComputer, hub }
   * data: { origin, pub?, first, notListed, mirrorOf?, statement, purpose, sameOptions: [{ origin, label }], linkedTo?,
   *         hub: { suffix, decided, on } | null, shared, create, owner, unlock: 'passkey' | 'passphrase' | 'visit' |
   *         'unlocked' | 'new', hasIdentity }
   * The hub box starts unchecked (R 2.3.5: no page or SDK parameter preselects a link), except hub.buildDefault, which only
   * the identity origin sets, from its own build's template list (review round UX-12). The lines about what
   * the key reaches follow the mode the card shows (code review v0.3, security 19): "works only here" for a private
   * key, the shared key's own line for a linked site, a hub or a listed mirror.
   */
  function signin(data) {
    clear();
    const card = el('section', { class: 'mw-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mw-card-title' });
    root.appendChild(card);
    originHeading(data.origin, card);
    // Review round PHISH-9: a redirect request names its origin in page text; the card says so and shows no identity of yours.
    if (data.unverified) card.appendChild(el('p', { class: 'mw-warn', role: 'note' }, L('unverifiedOrigin', { origin: hostOf(data.origin) })));
    else identityLine(data.pub || null, card);
    if (data.first && !data.unverified) card.appendChild(el('p', { class: 'mw-first' }, L('firstVisit')));
    if (data.notListed) card.appendChild(el('p', { class: 'mw-warn', role: 'note' }, L('notListed')));
    const mirrorOf = typeof data.mirrorOf === 'string' && data.mirrorOf ? data.mirrorOf : null;
    if (data.shared) card.appendChild(el('p', { class: 'mw-warn' }, L('sharedHub')));

    // Mode: "Private to this site" (default) / "Same as on ..." (R 2.3.5) / "One identity on all of <hub>".
    // An existing link or hub choice is shown as a line (it is changed in Settings, not here).
    let modeSelect = null;
    const options = Array.isArray(data.sameOptions) ? data.sameOptions : [];
    const hubOffer = data.hub && !data.hub.decided && !data.shared ? data.hub : null;
    if (data.shared) {
      // "this visit only": no menu
    } else if (data.linkedTo) {
      card.appendChild(el('p', { class: 'mw-mode' }, L('modeSameAs', { site: hostOf(data.linkedTo) })));
    } else if (data.hub && data.hub.decided && data.hub.on) {
      card.appendChild(el('p', { class: 'mw-mode' }, L('modeHub', { hub: data.hub.suffix })));
    } else if (options.length) {
      const label = el('label', { class: 'mw-mode' });
      label.appendChild(el('span', null, L('identityMenu') + ' '));
      modeSelect = el('select', { name: 'mode' });
      modeSelect.appendChild(el('option', { value: 'private' }, L('modePrivate')));
      for (const o of options) modeSelect.appendChild(el('option', { value: 'same:' + o.origin }, L('modeSameAs', { site: hostOf(o.origin) })));
      modeSelect.value = 'private';
      label.appendChild(modeSelect);
      card.appendChild(label);
    } else {
      card.appendChild(el('p', { class: 'mw-mode' }, L('modePrivate')));
    }

    let hubBox = null;
    if (hubOffer) {
      // Review round UX-12: ticked only when the identity origin says so (a page its build lists as one of this hub's own
      // templates that asks for the default); never by a page or SDK parameter.
      hubBox = checkbox(L('hubChoice', { hub: hubOffer.suffix }), { checked: hubOffer.buildDefault === true, name: 'hub' });
      card.appendChild(hubBox.wrap);
      card.appendChild(el('p', { class: 'mw-note' }, L('hubIdentityText', { hub: hubOffer.suffix })));
    }

    if (typeof data.statement === 'string' && data.statement) {
      card.appendChild(el('p', { class: 'mw-note' }, L('statementLabel')));
      card.appendChild(el('blockquote', { class: 'mw-statement', dir: 'auto' }, '"' + data.statement + '"'));
    }
    if (data.purpose === 'server') card.appendChild(el('p', { class: 'mw-note' }, L('serverSignIn')));
    if (data.create && data.hub) card.appendChild(el('p', { class: 'mw-strong' }, L('createPageText', { hub: data.hub.suffix })));
    if (data.owner) card.appendChild(el('p', { class: 'mw-strong' }, L('ownerActionText', { origin: hostOf(data.origin), what: ownerWhat(data.owner) })));

    // The lines about what the key reaches follow the mode the card shows, and follow the menu when the person changes it
    // (review round PHISH-3: with "Same as on X" chosen the card used to keep saying the key works only here).
    const keyLines = el('div', { class: 'mw-key-lines', 'aria-live': 'polite' });
    const drawKeyLines = () => {
      while (keyLines.firstChild) keyLines.removeChild(keyLines.firstChild);
      const m = modeOf(modeSelect);
      if (data.shared) {
        // "this visit only": the key is new and goes with this window
      } else if (data.linkedTo) {
        keyLines.appendChild(el('p', null, L('linkedLine', { site: hostOf(data.linkedTo) })));
      } else if (m.kind === 'same') {
        keyLines.appendChild(el('p', { class: 'mw-strong' }, L('linkedLine', { site: hostOf(m.origin) })));
        keyLines.appendChild(el('p', { class: 'mw-warn' }, L('sameIdentityText', { a: hostOf(data.origin), b: hostOf(m.origin) })));
      } else if (data.hub && data.hub.decided && data.hub.on && data.hub.notTemplate) {
        keyLines.appendChild(el('p', { class: 'mw-warn' }, L('hubNotTemplate', { hub: data.hub.suffix })));
        keyLines.appendChild(el('p', null, L('keyOnlyHere')));
      } else if (data.hub && data.hub.decided && data.hub.on) {
        keyLines.appendChild(el('p', null, L('hubLine', { hub: data.hub.suffix })));
      } else if (mirrorOf) {
        keyLines.appendChild(el('p', null, L('mirrorLine', { site: mirrorOf })));
        keyLines.appendChild(el('p', null, L('cannotSeeOthers')));
      } else {
        keyLines.appendChild(el('p', null, L('keyOnlyHere')));
        keyLines.appendChild(el('p', null, L('cannotSeeOthers')));
      }
    };
    drawKeyLines();
    if (modeSelect) modeSelect.addEventListener('change', drawKeyLines);
    card.appendChild(keyLines);
    card.appendChild(el('p', null, L('codeCanAct')));
    if (data.unlock === 'visit' || data.shared) card.appendChild(el('p', { class: 'mw-warn' }, L('visitOnlyWarning')));

    const primaryText = data.unlock === 'passkey' ? L('continuePasskey') : data.unlock === 'passphrase' ? L('continuePassphrase')
      : data.unlock === 'visit' ? L('continueVisit') : data.unlock === 'unlocked' ? L('cont') : data.create ? L('createPageButton') : L('continueNew');
    const actions = el('div', { class: 'mw-actions' });
    const stay = checkbox(L('staySignedIn'), { checked: false, name: 'stay' });
    const stayNote = el('p', { class: 'mw-note mw-stay-note' }, L('staySignedInText'));
    stayNote.hidden = true;
    const shared = checkbox(L('sharedComputer'), { checked: false, name: 'shared' });
    const sharedNote = el('p', { class: 'mw-note' }, L('sharedComputerText'));
    sharedNote.hidden = true;
    stay.box.addEventListener('change', () => {
      stayNote.hidden = !stay.box.checked;
      if (stay.box.checked) { shared.box.checked = false; sharedNote.hidden = true; }
    });
    shared.box.addEventListener('change', () => {
      sharedNote.hidden = !shared.box.checked;
      if (shared.box.checked) { stay.box.checked = false; stayNote.hidden = true; }
    });
    const result = (action) => ({
      action,
      mode: modeOf(modeSelect),
      stay: !data.shared && stay.box.checked === true,
      sharedComputer: data.shared === true || shared.box.checked === true,
      hub: hubBox ? hubBox.box.checked === true : null,
    });
    actions.appendChild(button(primaryText, { primary: true, onPress: () => done(result('continue')) }));
    actions.appendChild(button(L('cancel'), { onPress: () => done(result('cancel')) }));
    card.appendChild(actions);
    if (!data.shared && data.purpose !== 'server') {
      card.appendChild(stay.wrap);
      card.appendChild(stayNote);
      card.appendChild(shared.wrap);
      card.appendChild(sharedNote);
    }
    if (!data.hasIdentity) {
      const more = el('div', { class: 'mw-more' });
      more.appendChild(button(L('restoreTitle'), { onPress: () => done(result('restore')) }));
      more.appendChild(button(L('linkThisNew'), { onPress: () => done(result('link')) }));
      card.appendChild(more);
    }
    const details = el('details', { class: 'mw-others' });
    details.appendChild(el('summary', null, L('whatOthersSee')));
    details.appendChild(el('p', null, L('whatOthersSeeText')));
    card.appendChild(details);
    footer(card);
    const title = card.firstChild;
    if (title && typeof title.setAttribute === 'function') focusOn(title);
    return waitCard();
  }

  function modeOf(select) {
    if (!select) return { kind: 'private' };
    const v = String(select.value || 'private');
    if (v === 'hub') return { kind: 'hub' };
    if (v.startsWith('same:')) return { kind: 'same', origin: v.slice(5) };
    return { kind: 'private' };
  }

  function hostOf(origin) {
    try { return new URL(origin).host; } catch (_) { return String(origin); }
  }

  function ownerWhat(owner) {
    const k = owner && owner.what;
    return L(k === 'policy' ? 'ownerPolicy' : k === 'checkpoint' ? 'ownerCheckpoint' : k === 'withdraw' ? 'ownerWithdraw' : 'ownerDelete');
  }

  /** confirmSame({ a, b }) -> true only on the second, deliberate press of the confirm button (R 2.3.5). */
  function confirmSame({ a, b }) {
    const card = frame(L('modeSameAs', { site: hostOf(b) }));
    card.appendChild(el('p', { class: 'mw-strong' }, L('sameIdentityText', { a: hostOf(a), b: hostOf(b) })));
    card.appendChild(el('p', null, L('sameIdentityLater')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('back'), { primary: true, onPress: () => done(false) }));
    actions.appendChild(button(L('sameConfirm'), { delay: secondPress, onPress: () => done(true) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /**
   * chooseUnlock({ prf, wasm, extra }) -> { method: 'passkey' | 'passphrase' | 'visit', nickname, extra? } | null. extra: true
   * (a new identity, review round STALK-5) adds the optional extra word, typed twice; it is returned as extra.
   */
  function chooseUnlock({ prf = null, wasm = true, extra: withExtra = false } = {}) {
    const card = frame(L('chooseUnlockTitle'));
    let nickInput = null;
    if (prf !== false) {
      card.appendChild(el('p', { class: 'mw-note' }, L('passkeyText', { idp })));
      card.appendChild(el('p', { class: 'mw-note' }, L('passkeyEscrow')));
      const label = el('label', { class: 'mw-field' });
      label.appendChild(el('span', null, L('nicknameLabel')));
      nickInput = el('input', { type: 'text', name: 'nickname', maxlength: '64', autocomplete: 'off' });
      nickInput.value = L('nicknameDefault');
      label.appendChild(nickInput);
      card.appendChild(label);
    } else {
      card.appendChild(el('p', { class: 'mw-warn' }, L('noPrf')));
    }
    let ex1 = null;
    let ex2 = null;
    const exMsg = el('p', { class: 'mw-error', role: 'alert' });
    if (withExtra) {
      const det = el('details', { class: 'mw-extra' });
      det.appendChild(el('summary', null, L('extraWordCreate')));
      det.appendChild(el('p', { class: 'mw-note' }, L('extraWordText')));
      det.appendChild(el('p', { class: 'mw-warn' }, L('extraWordWarn')));
      ex1 = el('input', { type: 'password', name: 'extra', autocomplete: 'off', 'data-mw-secret': 'extra' });
      const la = el('label', { class: 'mw-field' });
      la.appendChild(el('span', null, L('extraWordCreate')));
      la.appendChild(ex1);
      det.appendChild(la);
      ex2 = el('input', { type: 'password', name: 'extra2', autocomplete: 'off', 'data-mw-secret': 'extra' });
      const lb = el('label', { class: 'mw-field' });
      lb.appendChild(el('span', null, L('extraWordRepeat')));
      lb.appendChild(ex2);
      det.appendChild(lb);
      card.appendChild(det);
      card.appendChild(exMsg);
    }
    const pick = (r) => {
      if (withExtra) {
        const a = String(ex1.value || '');
        if (a !== String(ex2.value || '')) { exMsg.textContent = L('extraWordMismatch'); focusOn(exMsg); return; }
        if (a) r.extra = a;
      }
      done(r);
    };
    const actions = el('div', { class: 'mw-actions' });
    if (prf !== false) actions.appendChild(button(L('unlockPasskey'), { primary: true, onPress: () => pick({ method: 'passkey', nickname: String(nickInput.value || '').trim() || L('nicknameDefault') }) }));
    actions.appendChild(button(L('unlockPassphrase'), { primary: prf === false, onPress: () => pick({ method: 'passphrase' }) }));
    actions.appendChild(button(L('unlockVisit'), { onPress: () => pick({ method: 'visit' }) }));
    card.appendChild(actions);
    card.appendChild(el('p', { class: 'mw-note' }, wasm ? L('kdfArgon') : L('kdfPbkdf2')));
    footer(card);
    return waitCard();
  }

  /** passphrase({ mode: 'unlock' | 'create', kdf: 'argon2id' | 'pbkdf2-sha256', error }) -> string | null */
  function passphrase({ mode = 'unlock', kdf = 'argon2id', error = null } = {}) {
    const card = frame(L(mode === 'create' ? 'unlockPassphrase' : 'continuePassphrase'));
    if (error) focusOn(card.appendChild(el('p', { class: 'mw-error', role: 'alert' }, error)));
    // Code review v0.3, security 2: a passphrase-wrapped identity is never escrowed to sites, so say what brings it back.
    if (mode === 'create') card.appendChild(el('p', { class: 'mw-note' }, L('passphraseNoEscrow')));
    const one = el('input', { type: 'password', name: 'passphrase', autocomplete: mode === 'create' ? 'new-password' : 'current-password', 'data-mw-secret': 'passphrase' });
    const l1 = el('label', { class: 'mw-field' });
    l1.appendChild(el('span', null, L('passphraseLabel')));
    l1.appendChild(one);
    card.appendChild(l1);
    let two = null;
    if (mode === 'create') {
      two = el('input', { type: 'password', name: 'passphrase2', autocomplete: 'new-password', 'data-mw-secret': 'passphrase' });
      const l2 = el('label', { class: 'mw-field' });
      l2.appendChild(el('span', null, L('passphraseRepeat')));
      l2.appendChild(two);
      card.appendChild(l2);
    }
    card.appendChild(el('p', { class: 'mw-note' }, kdf === 'pbkdf2-sha256' ? L('kdfPbkdf2') : L('kdfArgon')));
    const msg = el('p', { class: 'mw-error', role: 'alert' });
    card.appendChild(msg);
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('cont'), {
      primary: true,
      onPress: () => {
        const a = String(one.value || '');
        if (!a) return;
        if (two && a !== String(two.value || '')) { msg.textContent = L('passphraseMismatch'); return; }
        done(a);
      },
    }));
    actions.appendChild(button(L('cancel'), { onPress: () => done(null) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /** showPhrase({ words, checkCode }) -> true when the person continues to the re-entry check. */
  function showPhrase({ words, checkCode }) {
    const card = frame(L('showPhraseTitle'));
    card.appendChild(el('p', { class: 'mw-strong' }, L('twelveWordsText', { idp })));
    const list = el('ol', { class: 'mw-words', 'data-mw-phrase-display': '1' });
    for (const w of words) list.appendChild(el('li', null, w));
    card.appendChild(list);
    card.appendChild(el('p', { class: 'mw-code' }, L('checkCode', { code: checkCode })));
    card.appendChild(el('p', null, L('writeDown')));
    card.appendChild(el('p', { class: 'mw-note' }, L('neverAsk')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('cont'), { primary: true, onPress: () => done(true) }));
    actions.appendChild(button(L('kitLater'), { onPress: () => done(false) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /** reentry({ words, positions }) -> true when the three words typed match (the 3-word re-entry check). */
  function reentry({ words, positions }) {
    const card = frame(L('reentryTitle'));
    const inputs = [];
    for (const n of positions) {
      const label = el('label', { class: 'mw-field' });
      label.appendChild(el('span', null, L('reentryWord', { n })));
      const input = el('input', { type: 'text', name: 'word' + n, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'data-mw-phrase': '1' });
      label.appendChild(input);
      card.appendChild(label);
      inputs.push({ n, input });
    }
    const msg = el('p', { class: 'mw-error', role: 'alert' });
    card.appendChild(msg);
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('cont'), {
      primary: true,
      onPress: () => {
        const ok = inputs.every(({ n, input }) => String(input.value || '').trim().toLowerCase() === words[n - 1]);
        if (!ok) { msg.textContent = L('reentryWrong'); return; }
        done(true);
      },
    }));
    actions.appendChild(button(L('back'), { onPress: () => done(false) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /**
   * restore({ error, words, replaces }) -> { kind: 'phrase', words, extra } | { kind: 'file', text, pass } | null. words: the text
   * typed before a refused try, put back in the box (review round UX-4: the box used to come back empty); replaces: the check
   * code of the identity already on this device, which a restore replaces (review round SEC-3, PHISH-4).
   */
  function restore({ error = null, words = '', replaces = null } = {}) {
    const card = frame(L('restoreTitle'));
    card.appendChild(el('p', { class: 'mw-strong' }, L('neverAsk')));
    if (replaces) card.appendChild(el('p', { class: 'mw-warn' }, L('replacesCode', { code: replaces })));
    if (error) focusOn(card.appendChild(el('p', { class: 'mw-error', role: 'alert' }, error)));
    const phrase = el('textarea', { name: 'phrase', rows: '4', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'data-mw-phrase': '1' });
    if (typeof words === 'string' && words) phrase.value = words;
    const l1 = el('label', { class: 'mw-field' });
    l1.appendChild(el('span', null, L('phraseLabel')));
    l1.appendChild(phrase);
    card.appendChild(l1);
    const extra = el('input', { type: 'password', name: 'extra', autocomplete: 'off', 'data-mw-secret': 'extra' });
    const l2 = el('label', { class: 'mw-field' });
    l2.appendChild(el('span', null, L('extraWordLabel')));
    l2.appendChild(extra);
    card.appendChild(l2);
    card.appendChild(el('p', { class: 'mw-note' }, L('phraseOnlyOld')));
    const a1 = el('div', { class: 'mw-actions' });
    a1.appendChild(button(L('restorePhrase'), { primary: true, onPress: () => done({ kind: 'phrase', words: String(phrase.value || ''), extra: String(extra.value || '') }) }));
    card.appendChild(a1);
    const file = el('input', { type: 'file', name: 'backup', accept: '.json,application/json', 'data-mw-backup-file': '1' });
    const l3 = el('label', { class: 'mw-field' });
    l3.appendChild(el('span', null, L('fileLabel')));
    l3.appendChild(file);
    card.appendChild(l3);
    const pass = el('input', { type: 'password', name: 'filepass', autocomplete: 'off', 'data-mw-secret': 'backup' });
    const l4 = el('label', { class: 'mw-field' });
    l4.appendChild(el('span', null, L('filePassLabel')));
    l4.appendChild(pass);
    card.appendChild(l4);
    const a2 = el('div', { class: 'mw-actions' });
    a2.appendChild(button(L('restoreFile'), {
      onPress: async () => {
        const f = file.files && file.files[0];
        let text = typeof file.textValue === 'string' ? file.textValue : null; // tests set textValue
        if (f && typeof f.text === 'function') text = await f.text();
        if (!text) return;
        done({ kind: 'file', text, pass: String(pass.value || '') });
      },
    }));
    a2.appendChild(button(L('cancel'), { onPress: () => done(null) }));
    card.appendChild(a2);
    footer(card);
    return waitCard();
  }

  /** checkCode({ code, replaces }) -> true ("Is this the code on your recovery kit?" yes) or false. */
  function checkCode({ code, replaces = null }) {
    const card = frame(L('restored'));
    card.appendChild(el('p', { class: 'mw-code' }, L('checkCode', { code })));
    if (replaces) card.appendChild(el('p', { class: 'mw-warn' }, L('replacesCode', { code: replaces })));
    card.appendChild(el('p', null, L('checkCodeQuestion')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('cont'), { primary: true, onPress: () => done(true) }));
    actions.appendChild(button(L('checkWords'), { onPress: () => done(false) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /** foundPosts({ n, site }) -> 'continue' | 'check' (R 2.2.6 "Found N posts" / "No posts found"). */
  function foundPosts({ n, site }) {
    const card = frame(L('restored'));
    const s = hostOf(site);
    const text = n === 0 ? L('noPosts', { site: s }) : n === 1 ? L('foundOnePost', { site: s }) : L('foundPosts', { n, site: s });
    card.appendChild(el('p', { class: n === 0 ? 'mw-warn' : 'mw-strong', role: 'status' }, text));
    // Review round UX-5: the number is the site's own count (a ledger still syncing counts too few), so Continue stays the
    // main button; "Check the words" takes the restored identity off this device and opens the restore card again.
    card.appendChild(el('p', { class: 'mw-note' }, L('postsCountNote')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('continueAnyway'), { primary: true, onPress: () => done('continue') }));
    if (n === 0) actions.appendChild(button(L('checkWords'), { onPress: () => done('check') }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /**
   * recoveryKit({ ios, escrow, checkCode }) -> 'saved' | 'later'. No Home Screen step for this page (code review v0.3,
   * browser): an identity page added to the Home Screen gets storage of its own and starts empty, so it would keep
   * nothing. The iOS lines show only behind IDP_STRING_FLAGS.iosStrings (MF-63); escrow: the identity unlocks with a
   * passkey, so the sites it signed in to hold a sealed copy (a passphrase identity has none, security 2).
   */
  function recoveryKit({ ios = false, escrow = false, checkCode: code = '' } = {}) {
    const card = frame(L('kitTitle'));
    if (ios && IDP_STRING_FLAGS.iosStrings) {
      card.appendChild(el('p', { class: 'mw-warn' }, L('kitIos')));
      if (escrow) card.appendChild(el('p', { class: 'mw-note' }, L('kitIosEscrow')));
    }
    card.appendChild(el('p', null, L('kitText')));
    card.appendChild(el('p', { class: 'mw-code' }, L('kitIdp', { idp })));
    if (code) card.appendChild(el('p', { class: 'mw-code' }, L('checkCode', { code })));
    card.appendChild(el('p', { class: 'mw-strong' }, L('neverAsk')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('kitNow'), { primary: true, onPress: () => done('saved') }));
    actions.appendChild(button(L('kitLater'), { onPress: () => done('later') }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /** backupFile({ generated }) -> { pass } (the generated or a chosen passphrase) | null */
  function backupFile({ generated, error = null }) {
    const card = frame(L('backupTitle'));
    card.appendChild(el('p', null, L('backupText')));
    card.appendChild(el('p', { class: 'mw-strong' }, L('doNotEmail')));
    card.appendChild(el('p', { class: 'mw-code' }, L('backupPassphrase', { pass: generated })));
    if (error) card.appendChild(el('p', { class: 'mw-error', role: 'alert' }, error));
    const own = el('input', { type: 'password', name: 'own', autocomplete: 'new-password', 'data-mw-secret': 'backup' });
    const l = el('label', { class: 'mw-field' });
    l.appendChild(el('span', null, L('backupChoose')));
    l.appendChild(own);
    card.appendChild(l);
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('backupSave'), { primary: true, onPress: () => done({ pass: String(own.value || '') || generated }) }));
    actions.appendChild(button(L('cancel'), { onPress: () => done(null) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /**
   * saveBackup({ text, download, copy }) -> 'saved' | 'later'. The file is saved by the person's own press:
   * download(text) runs inside that click (iOS Safari asks before it reads the URL, and an engine that ties
   * script downloads to a gesture has one). 'saved' only after "I saved the file" (code review v0.3, browser: the
   * file used to be counted as saved before anything was downloaded). copy(text) puts the text on the clipboard
   * where downloads are unavailable; the text is also shown, selectable.
   */
  function saveBackup({ text, download = null, copy = null } = {}) {
    const card = frame(L('backupSaveTitle'));
    card.appendChild(el('p', null, L('backupSaveText')));
    card.appendChild(el('p', { class: 'mw-strong' }, L('doNotEmail')));
    const note = el('p', { class: 'mw-note', role: 'status' }, L('backupNotSaved'));
    // The text box is named by the line above it (accessibility lane, axe label).
    const area = el('textarea', { name: 'backup-text', rows: '4', readonly: 'readonly', 'data-mw-backup-text': '1', spellcheck: 'false', 'aria-labelledby': 'mw-backup-copy-text' });
    area.value = String(text || '');
    const wrap = el('div', { class: 'mw-copy' });
    wrap.hidden = true;
    wrap.appendChild(el('p', { id: 'mw-backup-copy-text', class: 'mw-note' }, L('backupCopyText')));
    wrap.appendChild(area);
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('backupSave'), { primary: true, onPress: () => { if (typeof download === 'function') download(text); } }));
    actions.appendChild(button(L('backupSaved'), { onPress: () => done('saved') }));
    actions.appendChild(button(L('backupCopy'), {
      onPress: () => {
        wrap.hidden = false;
        try { if (typeof area.select === 'function') area.select(); } catch (_) { /* read only */ }
        if (typeof copy === 'function') copy(text);
      },
    }));
    actions.appendChild(button(L('kitLater'), { onPress: () => done('later') }));
    card.appendChild(actions);
    card.appendChild(note);
    card.appendChild(wrap);
    footer(card);
    return waitCard();
  }

  /**
   * tapToFinish({ step }) -> true | null: one button, pressed by the person, inside whose click the identity page makes
   * the passkey call again (MF-09: the browser refused it without a prompt because the earlier press was too long ago,
   * or Safari's PRF output needs an assertion after the passkey was made).
   */
  function tapToFinish() {
    const card = frame(L('tapToFinishTitle'));
    card.appendChild(el('p', null, L('tapToFinishText')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('tapToFinish'), { primary: true, delay: 0, onPress: () => done(true) }));
    actions.appendChild(button(L('cancel'), { onPress: () => done(null) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  function yesNo(titleText, lines, yes, { danger = false } = {}) {
    const card = frame(titleText);
    for (const line of lines) card.appendChild(el('p', line.cls ? { class: line.cls } : null, line.text));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(yes, { primary: !danger, danger, onPress: () => done(true) }));
    actions.appendChild(button(L('cancel'), { primary: danger, onPress: () => done(false) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /** replaceIdentity({ code }) -> true when the person chose to unlock the current identity and restore over it. */
  function replaceIdentity({ code }) {
    return yesNo(L('replaceIdentityTitle'), [{ text: L('replaceIdentityText', { code: code || '?' }), cls: 'mw-strong' }], L('replaceIdentityButton'), { danger: true });
  }

  function createPage({ hub }) {
    return yesNo(L('createPageButton'), [{ text: L('createPageText', { hub }), cls: 'mw-strong' }], L('createPageButton'));
  }

  function ownerAction({ origin, what }) {
    return yesNo(L('confirm'), [{ text: L('ownerActionText', { origin: hostOf(origin), what: ownerWhat({ what }) }), cls: 'mw-strong' }], L('confirm'), { danger: what === 'withdraw' || what === 'delete' });
  }

  function recordRead({ origin }) {
    return yesNo(L('allow'), [{ text: L('recordReadText', { origin: hostOf(origin) }), cls: 'mw-strong' }, { text: L('recordReadNote') }], L('allow'));
  }

  function erase({ origin }) {
    return yesNo(L('remove'), [{ text: hostOf(origin), cls: 'mw-origin' }, { text: L('removePrivateDataText'), cls: 'mw-strong' }], L('remove'), { danger: true });
  }

  /** legacy({ name }) -> 'keep' | 'fresh' (R 2.2.7; keep is the default: it links the two keys). */
  function legacy({ name }) {
    const card = frame(L('legacyKeep', { name: name || '?' }));
    card.appendChild(el('p', null, L('legacyText')));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('legacyKeep', { name: name || '?' }), { primary: true, onPress: () => done('keep') }));
    actions.appendChild(button(L('legacyFresh'), { onPress: () => done('fresh') }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  function replaceKeys() {
    return yesNo(L('replaceKeys'), [{ text: L('replaceKeysText'), cls: 'mw-strong' }], L('replaceKeys'), { danger: true });
  }

  function removeDevice() {
    return yesNo(L('removeDevice'), [{ text: L('removeDeviceText'), cls: 'mw-strong' }], L('remove'), { danger: true });
  }

  /** message({ text, title, kind }) -> resolves on Close. */
  function message({ text, title = null, kind = 'info' }) {
    const card = frame(title);
    card.appendChild(el('p', { id: 'mw-card-text', class: kind === 'error' ? 'mw-error' : 'mw-strong', role: kind === 'error' ? 'alert' : 'status' }, text));
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('close'), { primary: true, delay: 0, onPress: () => done(true) }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  function error({ code }) {
    return message({ text: errorText(code, lang), kind: 'error' });
  }

  let busyLine = null;
  function busy(text) {
    const card = frame(null);
    busyLine = el('p', { id: 'mw-card-text', class: 'mw-busy', role: 'status', 'aria-live': 'polite' }, text || L('unlocking'));
    card.appendChild(busyLine);
    focusOn(card);
  }

  /** progress(fraction): the busy card's line shows how far the passphrase stretching is (code review v0.3, browser). */
  function progress(fraction) {
    if (!busyLine || !busyLine.parentNode) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(fraction) * 100)));
    busyLine.textContent = L('unlockingProgress', { percent: pct });
  }

  // -------------------------------------------------------------------------------------------
  // Device link screens
  // -------------------------------------------------------------------------------------------

  function drawQr(text) {
    const q = qrEncode(text, { ecl: 'M' });
    const canvas = el('canvas', { class: 'mw-qr', role: 'img', 'aria-label': L('linkShowCode'), 'data-mw-code': text });
    const scale = 6;
    const margin = 4;
    const dim = (q.size + margin * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = '#000000';
      for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y * q.size + x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
    return canvas;
  }

  /**
   * showCodes({ title, lines, codes, sas, buttons }) -> resolves with the pressed button's value. Several codes
   * cycle every cycleMs (the vault parts). The code text is also shown, for typing it on the other device.
   */
  function showCodes({ title, lines = [], codes = [], sas = null, buttons = [], cycleMs = 1200 }) {
    const card = frame(title);
    for (const line of lines) card.appendChild(el('p', null, line));
    if (sas) card.appendChild(el('p', { class: 'mw-sas', 'data-mw-sas': sas }, L('linkSas', { sas })));
    const holder = el('div', { class: 'mw-qr-holder' });
    const text = el('p', { class: 'mw-code mw-code-text' });
    card.appendChild(holder);
    card.appendChild(text);
    let i = 0;
    const show = () => {
      while (holder.firstChild) holder.removeChild(holder.firstChild);
      if (!codes.length) return;
      holder.appendChild(drawQr(codes[i % codes.length]));
      text.textContent = codes[i % codes.length];
      i++;
    };
    show();
    let timer = null;
    if (codes.length > 1 && win && typeof win.setInterval === 'function') timer = win.setInterval(show, cycleMs);
    const actions = el('div', { class: 'mw-actions' });
    for (const b of buttons) actions.appendChild(button(b.text, { primary: b.primary, danger: b.danger, onPress: () => { if (timer) win.clearInterval(timer); done(b.value); } }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  /**
   * scanCode({ title, lines, decode }) -> the scanned or typed text, or null on Cancel. The camera feeds
   * frames to decode(imageData) (BarcodeDetector where it exists, the bundled decoder otherwise); a typed code
   * is the last resort (R 2.13).
   */
  function scanCode({ title, lines = [], decode = null, sas = null }) {
    const card = frame(title);
    for (const line of lines) card.appendChild(el('p', null, line));
    if (sas) card.appendChild(el('p', { class: 'mw-sas', 'data-mw-sas': sas }, L('linkSas', { sas })));
    const status = el('p', { class: 'mw-note', role: 'status' });
    card.appendChild(status);
    let stream = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (stream) for (const tr of stream.getTracks()) { try { tr.stop(); } catch (_) { /* ignore */ } }
    };
    const nav = win && win.navigator;
    if (nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && typeof decode === 'function') {
      const video = el('video', { class: 'mw-camera', playsinline: '', muted: '' });
      card.appendChild(video);
      nav.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
        if (stopped) { for (const tr of s.getTracks()) tr.stop(); return; }
        stream = s;
        video.srcObject = s;
        const p = video.play && video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        const canvas = doc.createElement('canvas');
        const tick = async () => {
          if (stopped) return;
          if (video.videoWidth && video.videoHeight) {
            const w = Math.min(800, video.videoWidth);
            const h = Math.round(video.videoHeight * (w / video.videoWidth));
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, w, h);
            let found = null;
            try { found = await decode(ctx.getImageData(0, 0, w, h), canvas); } catch (_) { found = null; }
            if (found && !stopped) { stop(); done(found); return; }
          }
          setTimeout(tick, 150);
        };
        tick();
      }).catch(() => { status.textContent = L('linkCameraDenied'); });
    } else {
      status.textContent = L('linkCameraDenied');
    }
    const input = el('input', { type: 'text', name: 'code', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const label = el('label', { class: 'mw-field' });
    label.appendChild(el('span', null, L('linkPaste')));
    label.appendChild(input);
    card.appendChild(label);
    const actions = el('div', { class: 'mw-actions' });
    actions.appendChild(button(L('cont'), { primary: true, onPress: () => { const v = String(input.value || '').trim(); if (v) { stop(); done(v); } } }));
    actions.appendChild(button(L('cancel'), { onPress: () => { stop(); done(null); } }));
    card.appendChild(actions);
    footer(card);
    return waitCard();
  }

  // -------------------------------------------------------------------------------------------
  // Settings (the IdO home page)
  // -------------------------------------------------------------------------------------------

  /**
   * settings(model, handlers): model { hasIdentity, unlock, backup: { kitSaved, fileSaved }, checkCode, links:
   * [{ origin, with }], hubs: [{ suffix, on }], sites: [origin] }; handlers { stopSame(origin), hubOff(suffix),
   * replaceKeys(), removeDevice(), showPhrase(), makeBackup(), link(), restore() } (each may return a promise).
   */
  function settings(model, handlers = {}) {
    const card = frame(L('settingsTitle'));
    const call = (name, arg) => () => { if (typeof handlers[name] === 'function') handlers[name](arg); };
    if (!model.hasIdentity) {
      card.appendChild(el('p', null, L('settingsNone')));
      const a = el('div', { class: 'mw-actions' });
      a.appendChild(button(L('restoreTitle'), { primary: true, onPress: call('restore') }));
      a.appendChild(button(L('linkThisNew'), { onPress: call('link') }));
      card.appendChild(a);
      footer(card);
      return card;
    }
    const how = model.unlock === 'passkey' ? L('unlockHowPasskey') : model.unlock === 'passphrase' ? L('unlockHowPassphrase') : L('unlockHowVisit');
    card.appendChild(el('p', null, L('unlockedWith', { how })));
    if (model.locked) {
      // Review round STALK-6: the sites, the links, the hub choices and the check code wait for an unlock; removing the
      // identity from this device needs none (a quick way out on a device someone else may open).
      card.appendChild(el('p', null, L('settingsLocked')));
      const la = el('div', { class: 'mw-actions' });
      la.appendChild(button(L('settingsUnlock'), { primary: true, onPress: call('unlockView') }));
      la.appendChild(button(L('showPhrase'), { onPress: call('showPhrase') }));
      la.appendChild(button(L('makeBackup'), { onPress: call('makeBackup') }));
      la.appendChild(button(L('linkThisOld'), { onPress: call('link') }));
      card.appendChild(la);
      const ld = el('div', { class: 'mw-actions' });
      ld.appendChild(button(L('removeDevice'), { danger: true, onPress: call('removeDevice') }));
      card.appendChild(ld);
      footer(card);
      return card;
    }
    if (model.checkCode) card.appendChild(el('p', { class: 'mw-code' }, L('checkCode', { code: model.checkCode })));
    const b = model.backup || {};
    card.appendChild(el('p', null, L('backupState', { kit: b.kitSaved ? L('saved') : L('notSaved'), file: b.fileSaved ? L('saved') : L('notSaved') })));
    const top = el('div', { class: 'mw-actions' });
    top.appendChild(button(L('showPhrase'), { onPress: call('showPhrase') }));
    top.appendChild(button(L('makeBackup'), { onPress: call('makeBackup') }));
    top.appendChild(button(L('linkThisOld'), { onPress: call('link') }));
    card.appendChild(top);
    card.appendChild(el('h2', null, L('linksTitle')));
    if (!model.links || !model.links.length) card.appendChild(el('p', null, L('linksNone')));
    for (const l of model.links || []) {
      const row = el('div', { class: 'mw-row' });
      row.appendChild(el('span', null, hostOf(l.origin) + (l.with ? ' = ' + hostOf(l.with) : '')));
      row.appendChild(button(L('stopSame'), { onPress: call('stopSame', l.origin) }));
      card.appendChild(row);
    }
    if (model.hubs && model.hubs.length) {
      card.appendChild(el('h2', null, L('hubsTitle')));
      for (const h of model.hubs) {
        const row = el('div', { class: 'mw-row' });
        row.appendChild(el('span', null, h.suffix));
        // Review round UX-12: an answer given once is not final; "Ask me again" makes the next sign-in on the hub offer the box.
        if (h.on) row.appendChild(button(L('hubOff', { hub: h.suffix }), { onPress: call('hubOff', h.suffix) }));
        else row.appendChild(button(L('hubAskAgain', { hub: h.suffix }), { onPress: call('hubAsk', h.suffix) }));
        card.appendChild(row);
      }
    }
    if (model.sites && model.sites.length) {
      card.appendChild(el('h2', null, L('sitesTitle')));
      const ul = el('ul', { class: 'mw-sites' });
      for (const s of model.sites) ul.appendChild(el('li', null, s));
      card.appendChild(ul);
    }
    const danger = el('div', { class: 'mw-actions' });
    danger.appendChild(button(L('replaceKeys'), { danger: true, onPress: call('replaceKeys') }));
    danger.appendChild(button(L('removeDevice'), { danger: true, onPress: call('removeDevice') }));
    card.appendChild(danger);
    footer(card);
    return card;
  }

  function close() {
    clear();
  }

  return {
    root, lang, signin, confirmSame, chooseUnlock, passphrase, showPhrase, reentry, restore, checkCode, foundPosts, replaceIdentity,
    recoveryKit, backupFile, saveBackup, tapToFinish, createPage, ownerAction, recordRead, erase, legacy, replaceKeys,
    removeDevice, message, error, busy, progress, showCodes, scanCode, settings, close,
  };
}
