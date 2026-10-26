// src/widget/signin.js: <mw-signin statement challenge-url proof-url> (R 2.3.6, 3.8; self-hosted at /_mw/signin.js
// with SRI, never from a central widget host). One button in a closed shadow root. On a click it
//   1. fetches the challenge from challenge-url (same origin only),
//   2. calls client.signIn({ purpose: 'server', challenge, want: ['proof'] }) from src/identity/client.js,
//      which opens the identity page; the proof is signed there and returned,
//   3. POSTs the proof text (its JSON) to proof-url (same origin only; mw-signin-v1 section 1, integration I-2),
//   4. dispatches 'mw-signin' events on the element ({ state: 'pending' | 'signed-in' | 'error', code?, status?, body? }).
// Code review v0.3 (round 2): nothing is awaited between the click and client.signIn, which opens the identity page's window
// first and only then awaits the challenge (src/identity/client.js resolveLate): the challenge fetch travels as a promise. An
// await before the window opened (the fetch, an import) ended the click's activation, so Safari, and Chromium after 5 s, blocked
// the window (E_POPUP_BLOCKED). The identity client is imported statically for the same reason.
// It has a 10 s cooldown, shows the info sentence "Scripts on this page can act as you on this site while you
// are signed in. They cannot reach your other sites.", and never holds, asks for or shows a phrase, a word, a
// passphrase or a file: the element contains one button and text.
//
// Usage:
//   <script type="module" src="/_mw/signin.js" integrity="sha384-..." crossorigin></script>
//   <mw-signin statement="Sign in to Example Forum" challenge-url="/auth/mw/challenge" proof-url="/auth/mw/verify"></mw-signin>
//
// Tests call createSigninElement({ HTMLElement, client, fetchFn, ... }) with fakes.

import { uiText, errorText, pickLang } from '../loader/strings.js';
import { checkElement } from './redress.js';
import * as identityClient from '../identity/client.js';

export const COOLDOWN_MS = 10000;
export const EVENT_NAME = 'mw-signin';

function codeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/** sameOriginUrl(raw, win) -> absolute URL string on this page's origin; throws E_BAD_REQUEST otherwise. */
export function sameOriginUrl(raw, win) {
  const loc = win && win.location;
  if (!loc || !loc.href) throw codeError('E_BAD_REQUEST', 'no page location');
  let u;
  try { u = new URL(String(raw || ''), loc.href); } catch (_) { throw codeError('E_BAD_REQUEST', 'bad url'); }
  if (u.origin !== (loc.origin || new URL(loc.href).origin)) throw codeError('E_BAD_REQUEST', 'cross-origin url refused');
  return u.href;
}

/** fetchChallenge(f, url, statement) -> Promise<{ nonce, statement, exp?, nbf?, resources? }>: the server's challenge. */
async function fetchChallenge(f, url, statement) {
  const res = await f(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } });
  if (!res || !res.ok) throw codeError('E_IDP_UNREACHABLE', 'challenge fetch failed (' + (res && res.status) + ')');
  const body = await res.json();
  const nonce = body && (body.nonce || (body.challenge && body.challenge.nonce));
  if (typeof nonce !== 'string' || !nonce) throw codeError('E_NONCE_REQUIRED', 'the server sent no nonce');
  const src = body.challenge && typeof body.challenge === 'object' ? body.challenge : body;
  const challenge = { nonce };
  challenge.statement = typeof src.statement === 'string' ? src.statement : String(statement || '');
  for (const k of ['exp', 'nbf', 'resources']) if (src[k] !== undefined) challenge[k] = src[k];
  return challenge;
}

/** callSignIn(c, challenge): client.signIn at once (it opens the window before its first await). */
function callSignIn(c, challenge) {
  if (!c || typeof c.signIn !== 'function') throw codeError('E_UNSUPPORTED', 'no identity client');
  // purpose is fixed here; the page chooses neither the domain, the origin nor the key mode of the proof.
  return c.signIn({ purpose: 'server', challenge, want: ['proof'] });
}

/**
 * createSigninRunner({ client, fetchFn, win, now, cooldownMs }); client may be an object or a function returning one (or a promise) -> { run({ challengeUrl, proofUrl, statement }) }
 * The flow without any DOM; the element and the tests use it. With an object (or a function returning one), run() calls
 * client.signIn before its first await, inside the click; a client that is still being imported (a promise) opens the window
 * only after that import.
 */
export function createSigninRunner({ client, fetchFn, win, now = () => Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
  let last = -Infinity;
  let busy = false;
  return {
    get busy() { return busy; },
    async run({ challengeUrl, proofUrl, statement = '' }) {
      if (busy || now() - last < cooldownMs) throw codeError('E_RATE', 'cooldown');
      // UX-10: a blocked window or a cancel does not start the cooldown, so the next tap opens the window at once.
      const prevLast = last;
      last = now();
      busy = true;
      try {
        const cUrl = sameOriginUrl(challengeUrl, win);
        const pUrl = sameOriginUrl(proofUrl, win);
        const f = fetchFn || (win && win.fetch && win.fetch.bind(win));
        if (typeof f !== 'function') throw codeError('E_UNSUPPORTED', 'no fetch');
        const challenge = fetchChallenge(f, cUrl, statement);
        challenge.catch(() => {}); // the client awaits it (resolveLate); an early failure is not an unhandled rejection here
        let c = client;
        if (typeof c === 'function') c = c();
        const out = await (c && typeof c.then === 'function' ? c.then((x) => callSignIn(x, challenge)) : callSignIn(c, challenge));
        const proof = out && out.proof;
        if (!proof) throw codeError('E_USER_CANCELLED', 'no proof returned');
        // The proof text itself, as docs/specs/mw-signin-v1.md says ("the page posts the proof text to its server"):
        // the verifier then also refuses duplicate keys, which it can only see in the text (integration I-2).
        const proofText = typeof proof === 'string' ? proof : JSON.stringify(proof);
        const post = await f(pUrl, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: proofText });
        let respBody = null;
        try { respBody = post && typeof post.json === 'function' ? await post.json() : null; } catch (_) { respBody = null; }
        if (!post || !post.ok) {
          const e = codeError('E_DENIED', 'the site refused the proof (' + (post && post.status) + ')');
          e.status = post && post.status;
          throw e;
        }
        return { status: post.status, body: respBody };
      } catch (err) {
        if (err && (err.code === 'E_POPUP_BLOCKED' || err.code === 'E_USER_CANCELLED')) last = prevLast;
        throw err;
      } finally {
        busy = false;
      }
    }
  };
}

/**
 * createSigninElement({ HTMLElement, client, fetchFn, win, doc, now, makeEvent, strict }) -> the element class.
 * client may be a function returning the client (or a promise of it) so the real page can import it lazily.
 */
export function createSigninElement(deps) {
  const win = deps.win || (typeof window !== 'undefined' ? window : null);
  const doc = deps.doc || (win && win.document);
  const Base = deps.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  if (!Base) throw new TypeError('createSigninElement needs HTMLElement');
  const makeEvent = deps.makeEvent || ((type, detail) => (typeof CustomEvent === 'function'
    ? new CustomEvent(type, { detail, bubbles: true, composed: true })
    : { type, detail, bubbles: true, composed: true }));

  return class MwSignin extends Base {
    constructor() {
      super();
      this._runner = null;
      this._root = null;
      this._button = null;
      this._status = null;
    }

    get lang() { return pickLang(this.getAttribute('lang') || (win && win.navigator && win.navigator.language) || 'en'); }

    connectedCallback() {
      if (this._root) return;
      const css = (el, style) => { for (const k of Object.keys(style)) el.style.setProperty(k, style[k]); };
      const mk = (tag, style, text, attrs) => {
        const el = doc.createElement(tag);
        css(el, style);
        if (text) el.textContent = text;
        if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
        return el;
      };
      // Styled through the CSSOM only (a strict Content-Security-Policy is fine). The host is inline-block.
      this._root = this.attachShadow({ mode: 'closed' });
      const dark = Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches);
      const fg = dark ? '#08111f' : '#ffffff';
      const accent = dark ? '#5b9bff' : '#0a58ca';
      const text = dark ? '#9da7b3' : '#57606a';
      const box = mk('div', { display: 'block', font: '14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' }, '', { lang: this.lang });
      this._button = mk('button', { display: 'inline-block', cursor: 'pointer', 'min-height': '44px', 'min-width': '44px', padding: '9px 16px', border: '1px solid ' + accent, 'border-radius': '6px', background: accent, color: fg, font: 'inherit', 'font-weight': '600' }, uiText('signinWithMagnet', this.lang), { type: 'button' });
      this._status = mk('div', { display: 'block', color: text, 'font-size': '13px', margin: '6px 0 0' }, '', { role: 'status', 'aria-live': 'polite' });
      const info = mk('div', { display: 'block', color: text, 'font-size': '12px', margin: '6px 0 0', 'max-width': '36em' }, uiText('signinInfo', this.lang));
      box.appendChild(this._button);
      box.appendChild(this._status);
      box.appendChild(info);
      this._root.appendChild(box);
      this._button.addEventListener('click', (ev) => this._onClick(ev));
    }

    _emit(detail) {
      try { this.dispatchEvent(makeEvent(EVENT_NAME, detail)); } catch (_) { /* a listener threw */ }
    }

    _say(text) { if (this._status) this._status.textContent = String(text || ''); }

    async _onClick(ev) {
      if (ev && ev.isTrusted === false) return; // only the visitor's own click
      // The redress speed bump (R 2.3.4): the button must be the topmost thing at its centre and visible.
      const verdict = checkElement(this._button, { win, doc, host: this, strict: deps.strict === true });
      if (!verdict.ok) { this._say(uiText('redressCancelled', this.lang)); this._emit({ state: 'error', code: 'E_USER_CANCELLED', reason: verdict.reason }); return; }
      if (!this._runner) this._runner = createSigninRunner({ client: deps.client, fetchFn: deps.fetchFn, win, now: deps.now });
      this._button.disabled = true;
      this._say(uiText('signingIn', this.lang));
      this._emit({ state: 'pending' });
      try {
        const out = await this._runner.run({ challengeUrl: this.getAttribute('challenge-url'), proofUrl: this.getAttribute('proof-url'), statement: this.getAttribute('statement') || '' });
        this._say(uiText('signinDone', this.lang));
        this._emit({ state: 'signed-in', status: out.status, body: out.body });
      } catch (err) {
        const code = (err && err.code) || 'E_IDP_UNREACHABLE';
        // UX-10: a second block in a row (or a client that opens in place) means this browser cannot open the window.
        this._blocked = code === 'E_POPUP_BLOCKED' ? (this._blocked || 0) + 1 : 0;
        const openInBrowser = code === 'E_POPUP_BLOCKED' && (this._blocked >= 2 || (err && err.opensInPlace === true));
        this._say(code === 'E_RATE' ? uiText('signinCooldown', this.lang) : openInBrowser ? uiText('signinOpenInBrowser', this.lang) : errorText(code, this.lang));
        this._emit({ state: 'error', code, status: err && err.status });
      } finally {
        this._button.disabled = false;
      }
    }
  };
}

/** defineSignin(): registers <mw-signin> on a real page with the identity client (src/identity/client.js). */
export function defineSignin(win = (typeof window !== 'undefined' ? window : null)) {
  if (!win || !win.customElements || typeof win.HTMLElement !== 'function') return null;
  if (win.customElements.get('mw-signin')) return win.customElements.get('mw-signin');
  const El = createSigninElement({
    HTMLElement: win.HTMLElement,
    win,
    doc: win.document,
    // src/identity/client.js signIn({ purpose, challenge, want }): imported statically, so the window opens inside the click
    client: identityClient
  });
  win.customElements.define('mw-signin', El);
  return El;
}

defineSignin();
