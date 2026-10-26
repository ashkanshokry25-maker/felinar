// src/widget/chat-panel.js: <mw-chat-panel> (R 2.11.2, 3.8). A closed shadow root with a Lobby room and direct
// messages among the site's signed-in visitors. It uses only the drop-in SDK on window.mw (the chat.*, auth.*
// and ready() methods of R 2.11.2); it has no key, no phrase and no secret field of its own. The consent text
// for "Turn on chat" is the loader-owned card that mw.chat.enable() shows (the chat service's 'chat.enable' card)
// and chat is enabled only after the person's own click on that card. High-risk confirmations stay at the identity page.
//
// Views: 'unavailable' (no window.mw, no drop-in engine, no ledger for the chat lane, or the site turned chat
// off), 'signed-out' (a Sign in button -> mw.auth.signIn()), 'off' (a Turn on chat button -> consent card ->
// mw.chat.enable()), 'on' (Lobby and Messages). Delivery-state words appear only when the string flag
// STRING_FLAGS.deliveryStates is true (MF-35). "Connected to you now" is the only presence wording.
//
//   <script type="module" src="/_mw/chat-panel.js" integrity="sha384-..." crossorigin></script>
//   <mw-chat-panel></mw-chat-panel>   (only lang is read; the tracker and STUN come from the site's pointer and _mw.cfg)

import { uiText, errorText, pickLang, deliveryText } from '../loader/strings.js';
import { checkElement } from './redress.js';

export const MAX_LOG = 200;
export const MAX_TEXT = 2000;

export function createChatPanelElement(deps) {
  const win = deps.win || (typeof window !== 'undefined' ? window : null);
  const doc = deps.doc || (win && win.document);
  const Base = deps.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  if (!Base) throw new TypeError('createChatPanelElement needs HTMLElement');
  const getMw = deps.getMw || (() => (win ? win.mw : null));

  return class MwChatPanel extends Base {
    constructor() {
      super();
      this._root = null;
      this._view = 'unavailable';
      this._tab = 'lobby';
      this._log = [];
      this._dmLog = new Map(); // pub -> [{ me, text, state }]
      this._people = new Map(); // pub -> { name, short }
      this._dmTo = '';
      this._unsubs = [];
      this._note = '';
    }

    get lang() { return pickLang(this.getAttribute('lang') || (win && win.navigator && win.navigator.language) || 'en'); }
    get view() { return this._view; }
    /** Read-only, for tests and support (as window.__mwShell.rectOf): the Lobby as the panel shows it, one line per message. */
    get lobby() { return this._log.map((m) => m.name + ': ' + m.text); }

    /**
     * rectOf(label) -> { x, y, width, height } | null: the box of the panel's button with that text, or of its message line
     * (named by its aria-label), so an end-to-end test can press it with a real click in the closed root (v0.3 final
     * integration). Nothing secret is inside the panel; page scripts can read the same messages through window.mw.
     */
    rectOf(label) {
      if (!this._root || typeof this._root.querySelectorAll !== 'function') return null;
      for (const el of Array.from(this._root.querySelectorAll('button, input'))) {
        const name = String(el.tagName).toUpperCase() === 'INPUT' ? el.getAttribute('aria-label') : el.textContent;
        if (name !== label || typeof el.getBoundingClientRect !== 'function') continue;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return null;
    }

    T(key, params) { return uiText(key, this.lang, params); }

    connectedCallback() {
      if (!this._root) this._root = this.attachShadow({ mode: 'closed' });
      this.refresh();
    }

    disconnectedCallback() {
      for (const u of this._unsubs) { try { u(); } catch (_) { /* gone */ } }
      this._unsubs = [];
    }

    /** refresh() decides the view from window.mw and renders it. */
    async refresh() {
      const mw = getMw();
      let view = 'unavailable';
      try {
        if (mw && typeof mw.ready === 'function' && mw.chat && typeof mw.chat === 'object') {
          const info = await mw.ready();
          const feats = (info && info.features) || {};
          if (info && feats.chat !== false && feats.chat !== undefined) {
            if (info.auth !== 'signed-in' && !(mw.auth && typeof mw.auth.state === 'function' && mw.auth.state() === 'signed-in')) view = 'signed-out';
            else {
              const st = typeof mw.chat.state === 'function' ? await mw.chat.state() : null;
              view = st && (st === 'on' || st.enabled === true || st.state === 'on') ? 'on' : 'off';
              this._chatState = st;
            }
          }
        }
      } catch (_) { view = 'unavailable'; }
      this._view = view;
      if (view === 'on') this._subscribe(mw);
      this.render();
      return view;
    }

    _subscribe(mw) {
      if (this._unsubs.length || typeof mw.chat.on !== 'function') return;
      // The chat service (src/chat/service.js) emits direct messages on 'message' and room messages on 'room'
      // (v0.3 reconciliation: the panel listened to 'message' only, so the Lobby stayed empty with real chat).
      for (const ev of ['message', 'room']) {
        const u = mw.chat.on(ev, (m) => this._onMessage(m, ev));
        if (typeof u === 'function') this._unsubs.push(u);
      }
    }

    _onMessage(m, ev = 'message') {
      if (!m || typeof m !== 'object') return;
      // A grant (a shared photo or file) has no text: the loader's own card offers it, the panel shows nothing.
      if (typeof m.text !== 'string' || !m.text) return;
      const text = m.text.slice(0, MAX_TEXT);
      // The service gives the sender's site key as a string; an object { pub, name, short } is read too.
      const from = m.from && typeof m.from === 'object' ? m.from : { pub: typeof m.from === 'string' ? m.from : m.pub, name: m.name, short: m.short };
      const pub = String(from.pub || m.pub || '');
      const known = pub ? this._people.get(pub) : null;
      if (pub) this._people.set(pub, { name: String(from.name || (known && known.name) || ''), short: String(from.short || (known && known.short) || pub.slice(-9)) });
      if (m.room || ev === 'room') {
        // UX-6: a chosen name is not unique, so the short id follows it; with no name, the short id alone (never "?").
        const short = String(from.short || (known && known.short) || pub.slice(-9));
        this._log.push({ pub, name: from.name ? String(from.name) + ' (' + short + ')' : short, text });
        if (this._log.length > MAX_LOG) this._log.shift();
      } else if (pub) {
        const arr = this._dmLog.get(pub) || [];
        arr.push({ me: false, text });
        if (arr.length > MAX_LOG) arr.shift();
        this._dmLog.set(pub, arr);
      }
      this.render();
    }

    _mk(tag, text, attrs) {
      const el = doc.createElement(tag);
      if (text !== undefined && text !== null) el.textContent = String(text);
      if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
      return el;
    }

    _button(label, onClick, pressed) {
      const b = this._mk('button', label, { type: 'button' });
      if (pressed !== undefined) b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      b.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return; // only the visitor's own click
        // Speed bump (R 2.3.4): the button must be topmost and visible. A missing API skips the check.
        const v = checkElement(b, { win, doc, host: this, strict: false });
        if (!v.ok) { this._note = this.T('redressCancelled'); this.render(); return; }
        onClick(ev, b);
      });
      return b;
    }

    _fail(err) {
      const code = (err && err.code) || 'E_BAD_REQUEST';
      this._note = errorText(code, this.lang, { name: this._dmTo ? this._nameOf(this._dmTo) : '' });
      this.render();
    }

    _nameOf(pub) { const p = this._people.get(pub); return p ? (p.name || p.short) : pub.slice(-9); }

    render() {
      if (!this._root) return;
      const root = this._root;
      // UX-8: a message that arrives while the visitor types must not wipe the line or move the focus.
      const prev = this._input || null;
      const keep = prev ? { v: prev.value, s: prev.selectionStart, e: prev.selectionEnd, f: (root.activeElement || doc.activeElement) === prev } : null;
      this._input = null;
      while (root.firstChild) root.removeChild(root.firstChild);
      const box = this._mk('div', null, { part: 'panel', lang: this.lang });
      const view = this._view;
      if (view === 'unavailable') {
        box.appendChild(this._mk('p', this.T('chatUnavailable'), { role: 'status' }));
      } else if (view === 'signed-out') {
        box.appendChild(this._mk('p', this.T('chatSignInFirst')));
        box.appendChild(this._button(this.T('signInButton'), () => this._signIn()));
      } else if (view === 'off') {
        box.appendChild(this._mk('h3', this.T('chatTitle')));
        box.appendChild(this._button(this.T('chatTurnOn'), () => this._turnOn()));
      } else {
        const tabs = this._mk('div', null, { role: 'tablist' });
        // UX-20: tabs inside a tablist are role="tab" with aria-selected (not toggle buttons).
        const tab = (label, id) => {
          const b = this._button(label, () => { this._tab = id; this.render(); });
          b.setAttribute('role', 'tab');
          b.setAttribute('aria-selected', this._tab === id ? 'true' : 'false');
          return b;
        };
        tabs.appendChild(tab(this.T('chatLobby'), 'lobby'));
        tabs.appendChild(tab(this.T('chatDms'), 'dms'));
        box.appendChild(tabs);
        if (this._tab === 'lobby') this._renderLobby(box); else this._renderDms(box);
      }
      if (this._note) box.appendChild(this._mk('p', this._note, { role: 'status', 'aria-live': 'polite' }));
      box.appendChild(this._mk('p', this.T('signinInfo')));
      root.appendChild(box);
      const input = keep ? this._input : null;
      if (input) {
        input.value = keep.v;
        if (keep.f) {
          try { input.focus(); input.setSelectionRange(keep.s, keep.e); } catch (_) { /* no selection API */ }
        }
      }
    }

    _composer(box, onSend, label) {
      // A plain message line: its name is "message", never a phrase or word list; nothing here is a secret.
      const input = this._mk('input', null, { type: 'text', name: 'message', 'aria-label': label, maxlength: String(MAX_TEXT), autocomplete: 'off' });
      const go = () => {
        const text = String(input.value || '').trim();
        if (!text) return;
        input.value = '';
        onSend(text);
      };
      const send = this._button(this.T('chatSend'), go);
      this._input = input;
      // UX-20: a form, so Enter in the line sends as the button does (the visitor's own key press only).
      const row = this._mk('form');
      row.addEventListener('submit', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (ev && ev.isTrusted === false) return;
        const v = checkElement(input, { win, doc, host: this, strict: false });
        if (!v.ok) { this._note = this.T('redressCancelled'); this.render(); return; }
        go();
      });
      row.appendChild(input);
      row.appendChild(send);
      box.appendChild(row);
    }

    _renderLobby(box) {
      const list = this._mk('ul', null, { 'aria-live': 'polite', 'aria-label': this.T('chatLobby') });
      if (!this._log.length) list.appendChild(this._mk('li', this.T('chatNoMessages')));
      for (const m of this._log) list.appendChild(this._mk('li', m.name + ': ' + m.text));
      box.appendChild(list);
      this._composer(box, (text) => this._sendRoom(text), this.T('chatMessage'));
    }

    _renderDms(box) {
      const mw = getMw();
      const choose = this._mk('div');
      choose.appendChild(this._mk('p', this.T('chatPickPerson')));
      for (const [pub, p] of this._people) {
        choose.appendChild(this._button(p.name || p.short, () => { this._dmTo = pub; this.render(); }, this._dmTo === pub));
      }
      box.appendChild(choose);
      if (this._dmTo) {
        const list = this._mk('ul', null, { 'aria-live': 'polite' });
        const arr = this._dmLog.get(this._dmTo) || [];
        if (!arr.length) list.appendChild(this._mk('li', this.T('chatNoMessages')));
        for (const m of arr) list.appendChild(this._mk('li', (m.me ? '> ' : this._nameOf(this._dmTo) + ': ') + m.text + (m.status ? ' (' + m.status + ')' : '')));
        box.appendChild(list);
        this._composer(box, (text) => this._sendDm(text), this.T('chatMessage'));
      }
      void mw;
    }

    async _sendRoom(text) {
      const mw = getMw();
      try {
        await mw.chat.room.send('Lobby', { text });
        this._note = '';
        // UX-7: the service does not echo one's own room messages (examples/social/js/chat.js adds its own line too).
        this._log.push({ pub: '', name: this.T('chatYou'), text: text.slice(0, MAX_TEXT) });
        if (this._log.length > MAX_LOG) this._log.shift();
        this.render();
      } catch (err) { this._fail(err); }
    }

    async _sendDm(text) {
      const mw = getMw();
      const to = this._dmTo;
      try {
        const res = await mw.chat.dm.send(to, { text });
        const arr = this._dmLog.get(to) || [];
        // The delivery wording ships only after gate rows G-CH-1 and G-CH-3 pass (STRING_FLAGS.deliveryStates).
        const status = res && res.state ? deliveryText(res.state, this.lang, { count: res.count, time: res.time, name: this._nameOf(to) }) : null;
        arr.push({ me: true, text, status });
        this._dmLog.set(to, arr);
        this._note = '';
        this.render();
      } catch (err) { this._fail(err); }
    }

    _signIn() {
      const mw = getMw();
      // called inside the click: transient activation is present for the popup
      let p;
      try { p = Promise.resolve(mw.auth.signIn()); } catch (err) { p = Promise.reject(err); }
      p.then(() => this.refresh(), (err) => { if (err && err.code === 'E_USER_CANCELLED') return; this._fail(err); });
    }

    _turnOn() {
      const mw = getMw();
      // Called inside the click. mw.chat.enable() shows the loader-owned consent card (the chat service's 'chat.enable'
      // card, src/loader/api.js cardFor: the tracker and STUN text) and turns chat on only after the person's own click
      // there. v0.3 final integration: the panel showed the same card first, so a visitor answered it twice (E-CH-R).
      let p;
      try { p = Promise.resolve(mw.chat.enable()); } catch (err) { p = Promise.reject(err); }
      p.then(async () => {
        try { await mw.chat.room.join('Lobby'); } catch (err) { this._fail(err); }
        await this.refresh();
      }, (err) => { if (err && err.code === 'E_USER_CANCELLED') return; this._fail(err); });
    }
  };
}

/** defineChatPanel(): registers <mw-chat-panel> on a real page. */
export function defineChatPanel(win = (typeof window !== 'undefined' ? window : null)) {
  if (!win || !win.customElements || typeof win.HTMLElement !== 'function') return null;
  if (win.customElements.get('mw-chat-panel')) return win.customElements.get('mw-chat-panel');
  const El = createChatPanelElement({ HTMLElement: win.HTMLElement, win, doc: win.document });
  win.customElements.define('mw-chat-panel', El);
  return El;
}

defineChatPanel();
