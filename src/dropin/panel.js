// src/dropin/panel.js: the visitor-facing UI of drop-in mode (ARCHITECTURE §3.4.9, §8; DESIGN-REVIEW
// item 12, section 4.5). One host element in the page with a CLOSED shadow root, so the site's CSS
// and scripts cannot reach in (and ours cannot leak out). It shows at most one prompt at a time:
//
//   showConsentCard({ hostOnlyOffered, mobile, onShare, onHostOnly, onSettings })   v0.2.1 C1 first-run card:
//                                                         [Share and load] [Load from host only] [Settings]
//   showNotice({ onOk, onSettings })                     v0.2 notice "This site is delivered peer-to-peer..." [Settings] [OK]
//   showGate({ hostOnlyOffered, onLoad, onHostOnly, onCancel })   consent=gate: [Load] [Load from host only] [Cancel]
//   showKeyChange({ scope, oldFp, newFp, onKeep, onConfirm })     "publisher key changed"
//   showMessage(text, { kind, actions })                 a short status line
//   openSettings(model, onChange) / updateSettings(model) / notify(text, kind) / closeSettings()
//     model.identity = { short, name, canExport, canImport } adds Export / Import identity (v0.2.1 A4)
//   hidePrompt() / destroy()
//   v0.3 (lane ui): prompt(kind, data) -> Promise, setIdentityHeader(info, handlers): sign-in prompt, signed-in header,
//     consent / upload / moderator / offer cards (src/loader/ui.js createCards). Every button runs the redress speed
//     bumps of src/widget/redress.js and ignores events with isTrusted === false. No card or setting has a phrase,
//     word, passphrase or file field unless the model says identity.legacy === true (v0.2.1 migration only).
//
// Strings come from src/loader/strings.js (DESIGN-REVIEW §4 verbatim). Styling is done through the
// CSSOM (element.style.setProperty), never through a <style> element or a style attribute, because
// sites with a Content-Security-Policy without 'unsafe-inline' block both of those but not the
// CSSOM; nothing is parsed from strings (textContent only, no innerHTML); the only layout the
// panel needs is position: fixed, so it cannot shift the page (CLS). Colours follow
// prefers-color-scheme at creation time.

import { STRINGS, uiText } from '../loader/strings.js';
import { createCards } from '../loader/ui.js';
import { createGuard, adoptFocusRing } from '../widget/redress.js';

const THEMES = {
  light: { bg: '#ffffff', fg: '#1b1f23', muted: '#57606a', border: '#d0d7de', accent: '#0a58ca', accentFg: '#ffffff', soft: '#f3f4f6', shadow: '0 8px 24px rgba(0,0,0,.18)' },
  dark: { bg: '#1c1f24', fg: '#e6edf3', muted: '#9da7b3', border: '#3b434c', accent: '#5b9bff', accentFg: '#08111f', soft: '#272c33', shadow: '0 8px 24px rgba(0,0,0,.6)' },
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** formatBytes(n) → "12.3 MB" (binary units, one decimal from KB up). */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0 B';
  if (v < 1024) return Math.round(v) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return x.toFixed(x >= 100 ? 0 : 1) + ' ' + units[i];
}

function applyStyle(el, style) {
  if (!style) return;
  for (const k of Object.keys(style)) {
    const v = style[k];
    if (Array.isArray(v)) el.style.setProperty(k, v[0], v[1] || '');
    else el.style.setProperty(k, v);
  }
}

/** createPanel({ win, doc, strings }) → the panel (nothing is added to the page until a prompt shows). */
export function createPanel({ win = (typeof window !== 'undefined' ? window : null), doc = null, strings = STRINGS, actions = {}, lang = null, cardOptions = {} } = {}) {
  const document_ = doc || (win && win.document);
  if (!document_) throw new TypeError('createPanel needs a document');
  const S = strings;
  let dark = false;
  try {
    dark = Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (_) {
    dark = false;
  }
  const C = dark ? THEMES.dark : THEMES.light;

  let cards = null;
  let host = null;
  let root = null; // the closed shadow root (or the host itself where attachShadow is missing)
  let wrap = null;
  let promptSlot = null;
  let settingsSlot = null;
  let currentPrompt = null; // { kind, el }
  let settings = null; // { model, onChange, el, note }

  // Loader-owned UI acts only on the visitor's own input (v0.2.1, DIGEST-AMENDMENTS A4): an event a
  // script made (el.click(), dispatchEvent: isTrusted false), for example by a site that captured
  // this closed shadow root, is ignored, so a site cannot consent or change a setting for the visitor.
  function trusted(handler) {
    return (ev) => {
      if (ev && ev.isTrusted === false) return;
      handler(ev);
    };
  }

  function h(tag, props, children) {
    const el = document_.createElement(tag);
    if (props) {
      applyStyle(el, props.style);
      if (props.attrs) for (const k of Object.keys(props.attrs)) el.setAttribute(k, props.attrs[k]);
      if (props.text !== undefined) el.textContent = props.text;
      if (props.on) for (const type of Object.keys(props.on)) el.addEventListener(type, trusted(props.on[type]));
      if (props.props) for (const k of Object.keys(props.props)) el[k] = props.props[k];
    }
    for (const c of children || []) if (c) el.appendChild(c);
    return el;
  }

  const cardStyle = {
    'all': 'initial',
    'box-sizing': 'border-box',
    'display': 'block',
    'pointer-events': 'auto',
    'width': '100%',
    'max-width': '640px',
    'margin': '0 auto 8px',
    'padding': '12px 14px',
    'background': C.bg,
    'color': C.fg,
    'border': '1px solid ' + C.border,
    'border-radius': '10px',
    'box-shadow': C.shadow,
    'font': '14px/1.45 ' + FONT,
  };

  function buttonStyle(primary) {
    return {
      'all': 'initial',
      'box-sizing': 'border-box',
      'display': 'inline-block',
      'cursor': 'pointer',
      'min-height': '32px',
      'padding': '5px 14px',
      'margin': '0 8px 0 0',
      'border-radius': '6px',
      'border': '1px solid ' + (primary ? C.accent : C.border),
      'background': primary ? C.accent : C.soft,
      'color': primary ? C.accentFg : C.fg,
      'font': '600 14px/1.4 ' + FONT,
    };
  }

  // v0.3 (R 2.3.4, MF-06): every button also runs the redress speed bumps before it acts (topmost element at
  // its centre is the button and our host is topmost on the page, computed opacity and visibility, a
  // MutationObserver that cancels on style or position changes). Older prompts use strict: false, so a browser
  // that lacks an API skips that one check; they also have no minimum on-screen time (minVisibleMs 0).
  let pendingGuards = [];
  let activeGuards = [];
  function stopGuards() {
    for (const g of activeGuards) g.stop();
    activeGuards = [];
  }
  function startGuards() {
    const list = pendingGuards;
    pendingGuards = [];
    for (const g of list) {
      activeGuards.push(g);
      g.start();
    }
  }
  function redressCancelled() {
    stopGuards();
    clear(promptSlot);
    currentPrompt = null;
    clear(settingsSlot);
    settings = null;
    showMessage(uiText('redressCancelled', langOf()));
  }
  function langOf() {
    return lang || (win && win.navigator && win.navigator.language) || 'en';
  }

  function button(label, onClick, primary) {
    const el = h('button', { attrs: { type: 'button' }, style: buttonStyle(primary), text: label });
    const guard = createGuard({ win, doc: document_, getHost: () => host, button: el, strict: false, minVisibleMs: 0, onCancel: redressCancelled });
    pendingGuards.push(guard);
    el.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return; // a script made this click
      if (!guard.check()) return;
      onClick(ev);
    });
    return el;
  }

  function ensureHost() {
    if (host) return;
    host = document_.createElement('div');
    host.setAttribute('data-mw-ui', '');
    // v0.2.1 F7: crawler-inert. Search engines must not quote loader text as page content; Google reads
    // data-nosnippet only when it is there from the node's creation, never added later.
    host.setAttribute('data-nosnippet', '');
    applyStyle(host, {
      all: ['initial', 'important'],
      position: ['fixed', 'important'],
      left: ['0', 'important'],
      right: ['0', 'important'],
      bottom: ['0', 'important'],
      'z-index': ['2147483000', 'important'],
      'pointer-events': ['none', 'important'],
      display: ['block', 'important'],
    });
    root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;
    if (root !== host) adoptFocusRing(root, C.accent); // a visible focus ring despite the inline all: initial (WCAG 2.4.7)
    wrap = h('div', {
      style: {
        'all': 'initial',
        'box-sizing': 'border-box',
        'display': 'block',
        'width': '100%',
        'padding': '12px 12px 4px',
        'pointer-events': 'none',
      },
    });
    wrap.style.setProperty('padding-bottom', 'max(4px, env(safe-area-inset-bottom, 0px))');
    settingsSlot = h('div', { style: { all: 'initial', display: 'block' } });
    promptSlot = h('div', { style: { all: 'initial', display: 'block' } });
    wrap.appendChild(settingsSlot);
    wrap.appendChild(promptSlot);
    root.appendChild(wrap);
    const parent = document_.body || document_.documentElement;
    if (parent) parent.appendChild(host);
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function removeIfEmpty() {
    if (!host) return;
    const busy = (promptSlot && promptSlot.children && promptSlot.children.length) || (settingsSlot && settingsSlot.children && settingsSlot.children.length);
    if (!busy && host.parentNode) host.parentNode.removeChild(host);
  }

  function showPrompt(kind, el) {
    ensureHost();
    clear(promptSlot);
    promptSlot.appendChild(el);
    if (host && !host.parentNode) {
      const parent = document_.body || document_.documentElement;
      if (parent) parent.appendChild(host);
    }
    currentPrompt = { kind, el };
    startGuards();
    return function hide() {
      if (currentPrompt && currentPrompt.el === el) {
        currentPrompt = null;
        if (el.parentNode) el.parentNode.removeChild(el);
        removeIfEmpty();
      }
    };
  }

  function title(text) {
    return h('div', { style: { all: 'initial', display: 'block', font: '700 15px/1.4 ' + FONT, color: C.fg, margin: '0 0 4px' }, text });
  }

  function paragraph(text, muted) {
    return h('p', { style: { all: 'initial', display: 'block', font: '14px/1.45 ' + FONT, color: muted ? C.muted : C.fg, margin: '0 0 10px', 'white-space': 'pre-line' }, text });
  }

  function row(children) {
    return h('div', { style: { all: 'initial', display: 'block', margin: '2px 0 0' } }, children);
  }

  function showNotice({ onOk, onSettings, extra = null } = {}) {
    const card = h('div', { attrs: { role: 'region', 'aria-label': 'Peer-to-peer notice' }, style: cardStyle }, [
      paragraph(S.noticeText),
      extra ? paragraph(extra, true) : null,
      row([
        button(S.noticeSettings, () => { if (typeof onSettings === 'function') onSettings(); }, false),
        button(S.noticeOk, () => { hide(); if (typeof onOk === 'function') onOk(); }, true),
      ]),
    ]);
    const hide = showPrompt('notice', card);
    return hide;
  }

  /**
   * showConsentCard({ hostOnlyOffered, mobile, onShare, onHostOnly, onSettings, extra }) (v0.2.1 C1,
   * ARCHITECTURE §8): the first-run card, shown before the first tracker or peer connection, with the
   * same-layer choice [Share and load] [Load from host only] (equal weight: both are primary buttons) and
   * a Settings button. The same strings as the shell's card. Its prompt kind stays 'notice'.
   */
  function showConsentCard({ hostOnlyOffered = true, mobile = false, onShare, onHostOnly, onSettings, extra = null } = {}) {
    const buttons = [button(S.consentShare, () => { hide(); if (typeof onShare === 'function') onShare(); }, true)];
    if (hostOnlyOffered) buttons.push(button(S.consentHostOnly, () => { hide(); if (typeof onHostOnly === 'function') onHostOnly(); }, true));
    buttons.push(button(S.consentSettings, () => { if (typeof onSettings === 'function') onSettings(); }, false));
    const card = h('div', { attrs: { role: 'region', 'aria-label': S.consentTitle }, style: cardStyle }, [
      title(S.consentTitle),
      paragraph(S.consentText),
      mobile ? paragraph(S.consentMobile, true) : null,
      hostOnlyOffered ? paragraph(S.consentChoice, true) : null,
      extra ? paragraph(extra, true) : null,
      row(buttons),
    ]);
    const hide = showPrompt('notice', card);
    return hide;
  }

  function showGate({ hostOnlyOffered = true, onLoad, onHostOnly, onCancel, extra = null } = {}) {
    const buttons = [button(S.gateLoad, () => { hide(); if (typeof onLoad === 'function') onLoad(); }, true)];
    if (hostOnlyOffered) buttons.push(button(S.gateHostOnly, () => { hide(); if (typeof onHostOnly === 'function') onHostOnly(); }, false));
    buttons.push(button(S.gateCancel, () => { hide(); if (typeof onCancel === 'function') onCancel(); }, false));
    const card = h('div', { attrs: { role: 'dialog', 'aria-label': S.gateText }, style: cardStyle }, [paragraph(S.gateText), extra ? paragraph(extra, true) : null, row(buttons)]);
    const hide = showPrompt('gate', card);
    try {
      if (buttons[0] && typeof buttons[0].focus === 'function') buttons[0].focus();
    } catch (_) { /* focus is a courtesy */ }
    return hide;
  }

  function showKeyChange({ scope, oldFp, newFp, onKeep, onConfirm } = {}) {
    const card = h('div', { attrs: { role: 'dialog', 'aria-label': S.keyChangedTitle }, style: cardStyle }, [
      title(S.keyChangedTitle),
      paragraph(S.keyChangedDetail({ scope: scope || '', oldFp: oldFp || '?', newFp: newFp || '?' })),
      row([
        button(S.keyChangedKeep, () => { hide(); if (typeof onKeep === 'function') onKeep(); }, true),
        button(S.keyChangedConfirm, () => { hide(); if (typeof onConfirm === 'function') onConfirm(); }, false),
      ]),
    ]);
    const hide = showPrompt('key-change', card);
    try {
      if (card.children[2] && card.children[2].children[0] && typeof card.children[2].children[0].focus === 'function') card.children[2].children[0].focus();
    } catch (_) { /* focus is a courtesy */ }
    return hide;
  }

  function showMessage(text, { actions = [] } = {}) {
    const buttons = actions.map((a, i) => button(a.label, () => { if (a.hide !== false) hide(); if (typeof a.onClick === 'function') a.onClick(); }, i === 0 && a.primary !== false));
    const kids = [paragraph(String(text))];
    if (buttons.length) kids.push(row(buttons));
    const card = h('div', { attrs: { role: 'status' }, style: cardStyle }, kids);
    const hide = showPrompt('message', card);
    return hide;
  }

  function hidePrompt() {
    if (!currentPrompt) return;
    const el = currentPrompt.el;
    currentPrompt = null;
    if (el.parentNode) el.parentNode.removeChild(el);
    removeIfEmpty();
  }

  // ---- settings ---------------------------------------------------------------------------------

  function toggle(key, label, help, checked, disabled, onToggle) {
    const input = h('input', {
      attrs: { type: 'checkbox' },
      props: { checked: Boolean(checked), disabled: Boolean(disabled) },
      style: { 'all': 'revert', 'margin': '0 8px 0 0' },
      on: { change: (e) => onToggle(Boolean((e && e.target && e.target.checked !== undefined) ? e.target.checked : input.checked)) },
    });
    controls.set(key, input);
    return h('label', { style: { all: 'initial', display: 'block', margin: '0 0 10px', cursor: disabled ? 'default' : 'pointer', font: '14px/1.45 ' + FONT, color: C.fg } }, [
      h('div', { style: { all: 'initial', display: 'block', font: '600 14px/1.45 ' + FONT, color: C.fg } }, [input, h('span', { text: label })]),
      h('div', { style: { all: 'initial', display: 'block', font: '13px/1.4 ' + FONT, color: C.muted, margin: '2px 0 0 24px' }, text: help }),
    ]);
  }

  let controls = new Map();

  function renderSettings() {
    if (!settings) return;
    const m = settings.model || {};
    // A re-render replaces the controls; the one the visitor just used gets the focus back.
    const cb = settings.onChange;
    const emit = (action, payload) => {
      if (settings) settings.pendingFocus = action;
      if (typeof cb === 'function') cb(action, payload || {});
    };
    stopGuards();
    controls = new Map();
    const keyed = (key, el) => { controls.set(key, el); return el; };
    const kids = [];
    kids.push(h('div', { style: { all: 'initial', display: 'block', margin: '0 0 6px' } }, [
      h('span', { style: { all: 'initial', font: '700 15px/1.4 ' + FONT, color: C.fg }, text: S.settingsTitle }),
    ]));
    kids.push(h('div', { style: { all: 'initial', display: 'block', font: '600 13px/1.4 ' + FONT, color: C.muted, margin: '6px 0' }, text: S.settingsSharing }));
    kids.push(toggle('share', S.settingsShareLabel + ': ' + (m.share ? S.settingsOn : S.settingsOff), S.settingsShare, m.share, m.hostOnly, (on) => emit('share', { on })));
    kids.push(toggle('hostOnly', S.settingsHostOnlyLabel + ': ' + (m.hostOnly ? S.settingsOn : S.settingsOff), S.settingsHostOnly, m.hostOnly, m.hostOnlyForced, (on) => emit('hostOnly', { on })));
    if (m.isMobile) {
      kids.push(h('div', { style: { all: 'initial', display: 'block', margin: '0 0 10px' } }, [
        keyed('shareOnNetwork', button(S.settingsShareOnNetwork + ': ' + (m.shareOnNetwork ? S.settingsOn : S.settingsOff), () => emit('shareOnNetwork', { on: !m.shareOnNetwork }), false)),
        h('div', { style: { all: 'initial', display: 'block', font: '13px/1.4 ' + FONT, color: C.muted, margin: '4px 0 0' }, text: S.settingsShareOnNetworkNote }),
      ]));
    }
    const st = m.storage || {};
    kids.push(h('div', { style: { all: 'initial', display: 'block', font: '600 13px/1.4 ' + FONT, color: C.muted, margin: '6px 0' }, text: S.settingsStorage }));
    kids.push(paragraph(S.settingsStorageUsage(formatBytes(st.usage || 0), st.quota ? formatBytes(st.quota) : ''), false));
    kids.push(paragraph(S.settingsPersisted(m.persisted === undefined ? null : m.persisted), true));
    // v0.2.1 (A4): identity export and import live here, in loader-owned UI only (the site cannot reach
    // them through window.mw). Passphrase-wrapped, the same file format as the shell's Settings.
    const id = m.identity || null;
    if (id) {
      kids.push(h('div', { style: { all: 'initial', display: 'block', font: '600 13px/1.4 ' + FONT, color: C.muted, margin: '6px 0' }, text: S.settingsIdentity }));
      kids.push(paragraph(id.short ? S.identity({ short: id.short, name: id.name }) : '-', false));
      const field = (type, label, autocomplete) => h('input', {
        attrs: Object.assign({ type, 'aria-label': label }, type === 'password' ? { placeholder: label, autocomplete } : { accept: '.json,.txt,application/json,text/plain' }),
        // font-size 16px (code review round 1): iOS Safari zooms the page on focus of a smaller field.
        style: { 'all': 'revert', 'margin': '0 8px 6px 0', 'max-width': '100%', 'font-size': '16px' },
      });
      if (id.legacy !== true) {
        // v0.3 (R 2.3.4, MF-03): no passphrase, word or file field in the site page; identity work happens at the identity page.
        kids.push(row([keyed('openIdentity', button(uiText('openIdentity', langOf()), () => emit('openIdentity'), false))]));
      }
      if (id.legacy === true && id.canExport) {
        const pass = keyed('exportPass', field('password', S.settingsPassphrase, 'new-password'));
        kids.push(row([pass, keyed('exportIdentity', button(S.settingsExportIdentity, () => emit('exportIdentity', { passphrase: pass.value }), false))]));
      }
      if (id.legacy === true && id.canImport) {
        const file = keyed('importFile', field('file', S.settingsIdentityFile));
        const pass = keyed('importPass', field('password', S.settingsPassphrase, 'current-password'));
        kids.push(row([file, pass, keyed('importIdentity', button(S.settingsImportIdentity, async () => {
          const f = file.files && file.files[0];
          if (!f) {
            notify(S.settingsIdentityFile + '?', 'error');
            return;
          }
          let text = '';
          try {
            text = await f.text();
          } catch (err) {
            notify((err && err.message) || String(err), 'error');
            return;
          }
          emit('importIdentity', { text, passphrase: pass.value });
        }, false))]));
      }
    }
    const actions = [];
    if (m.canForget) actions.push(keyed('forget', button(S.settingsForget, () => emit('forget'), false)));
    actions.push(keyed('close', button(S.settingsClose, () => { closeSettings(); emit('close'); }, true)));
    kids.push(row(actions));
    settings.note = h('div', { attrs: { role: 'status', 'aria-live': 'polite' }, style: { all: 'initial', display: 'block', font: '13px/1.4 ' + FONT, color: C.muted, margin: '8px 0 0' } });
    kids.push(settings.note);
    if (m.version) kids.push(h('div', { style: { all: 'initial', display: 'block', font: '12px/1.4 ' + FONT, color: C.muted, margin: '8px 0 0' }, text: S.settingsVersion(m.version) }));
    const card = h('div', {
      attrs: { role: 'dialog', 'aria-label': S.settingsTitle },
      style: cardStyle,
      on: { keydown: (e) => { if (e && e.key === 'Escape') { closeSettings(); emit('close'); } } },
    }, kids);
    clear(settingsSlot);
    settingsSlot.appendChild(card);
    settings.el = card;
    startGuards();
  }

  function openSettings(model, onChange) {
    ensureHost();
    settings = { model: model || {}, onChange, el: null, note: null };
    renderSettings();
    if (host && !host.parentNode) {
      const parent = document_.body || document_.documentElement;
      if (parent) parent.appendChild(host);
    }
    return closeSettings;
  }

  function updateSettings(model) {
    if (!settings) return;
    settings.model = model || {};
    renderSettings();
    const want = settings.pendingFocus;
    settings.pendingFocus = null;
    const el = want ? controls.get(want) : null;
    try {
      if (el && typeof el.focus === 'function') el.focus();
    } catch (_) { /* focus is a courtesy */ }
  }

  function notify(text, kind) {
    if (!settings || !settings.note) return;
    settings.note.textContent = String(text || '');
    settings.note.setAttribute('data-kind', kind || 'info');
  }

  function closeSettings() {
    if (!settings) return;
    settings = null;
    clear(settingsSlot);
    removeIfEmpty();
  }

  function findButton(node, label) {
    if (!node || !node.children) return null;
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c && c.tagName === 'BUTTON' && c.textContent === label) return c;
      const deeper = findButton(c, label);
      if (deeper) return deeper;
    }
    return null;
  }

  /**
   * rectOf(label) → { x, y, width, height } of the visible button with that text (viewport
   * coordinates), or null. End-to-end tests click inside the closed shadow root with the mouse at
   * the centre of this rectangle (page.mouse.click), which works in every browser; keyboard focus
   * works too except in Safari, which does not Tab to buttons unless asked to.
   */
  function rectOf(label) {
    const button = findButton(wrap, label);
    if (!button || typeof button.getBoundingClientRect !== 'function') {
      // v0.3 final integration: the services' cards (chat, files, media, identity) live in the cards' own closed root.
      return cards && typeof cards.rectOf === 'function' ? cards.rectOf(label) : null;
    }
    const r = button.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function getCards() {
    if (!cards) cards = createCards(Object.assign({ win, doc: document_, actions, lang: langOf() }, cardOptions));
    return cards;
  }

  function destroy() {
    stopGuards();
    if (cards) cards.destroy();
    cards = null;
    settings = null;
    currentPrompt = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
    wrap = null;
    promptSlot = null;
    settingsSlot = null;
  }

  return {
    showConsentCard,
    showNotice,
    showGate,
    showKeyChange,
    showMessage,
    hidePrompt,
    openSettings,
    updateSettings,
    closeSettings,
    notify,
    rectOf,
    destroy,
    /** v0.3: prompt(kind, data) -> Promise, see createCards in src/loader/ui.js and docs/deviations/ui.md. */
    prompt: (kind, data) => getCards().prompt(kind, data),
    setIdentityHeader: (info, handlers) => getCards().setIdentityHeader(info, handlers),
    get cards() { return getCards(); },
    get promptKind() { return currentPrompt ? currentPrompt.kind : null; },
    get settingsOpen() { return Boolean(settings); },
    get host() { return host; },
    get mode() { return root && root !== host ? 'closed' : (root ? 'host' : null); },
  };
}
