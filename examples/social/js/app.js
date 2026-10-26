// Social: boot, routing and the page chrome. The SDK is imported dynamically so the static files still show their About page on a
// plain host (R 3.7: "JavaScript off" shows only the noscript notice; no loader shows a notice and the About page). Routes are
// the History API paths of R 3.7; the loader answers every path with this page, so a deep link works on reload.

import { h, $, $$, setChildren, announce, toast, throttle, formatClock, deviceClass } from './dom.js';
import { parseRoute, hrefFor } from './router.js';
import { createStore, KEYS as SK, DEFAULT_PREFS } from './store.js';
import { errorMessage, syncLine, offlineLine } from './strings.js';
import { createHub } from './hub.js';
import { createChat } from './chat.js';
import { createData } from './data.js';
import { createInbox } from './inbox.js';
import { DEFAULT_FLAGS, APP_NAME } from './config.js';

const VIEWS = {
  home: () => import('./views/timeline.js'),
  profile: () => import('./views/profile.js'),
  post: () => import('./views/post.js'),
  group: () => import('./views/group.js'),
  messages: () => import('./views/messages.js'),
  thread: () => import('./views/messages.js'),
  notifications: () => import('./views/notifications.js'),
  media: () => import('./views/media.js'),
  settings: () => import('./views/settings.js'),
  about: () => import('./views/about.js'),
  notfound: () => import('./views/notfound.js'),
};
const THEMES = ['auto', 'light', 'dark'];

async function loadSdk() {
  try { const mod = await import('/_mw/sdk.js'); return mod.default || globalThis.mw || null; } catch (err) { return null; }
}
async function loadFlags() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const cfg = await res.json();
    return {
      appName: typeof cfg.appName === 'string' && cfg.appName ? cfg.appName.slice(0, 40) : APP_NAME,
      directory: cfg.directory === true, moderationContact: typeof cfg.moderationContact === 'string' ? cfg.moderationContact.slice(0, 200) : '',
      hubName: typeof cfg.hubName === 'string' ? cfg.hubName.slice(0, 80) : '',
      // The public key that countersigns the hub directory's entries (js/directory.js); this file is part of the template the hub publishes.
      directoryKey: typeof cfg.directoryKey === 'string' ? cfg.directoryKey.slice(0, 100) : '',
    };
  } catch (err) { return Object.assign({ appName: APP_NAME, moderationContact: '', hubName: '', directoryKey: '' }, DEFAULT_FLAGS); }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = 'Theme: ' + theme;
    btn.setAttribute('aria-label', 'Colour theme: ' + (theme === 'auto' ? 'automatic' : theme) + '. Tap to change.');
  }
}

// This page runs in the loader's sandboxed frame, which may move the top window only while a tap is still active
// (allow-top-navigation-by-user-activation). The identity page's cards take seconds, after which the tap no longer counts and
// the browser refuses the move, so the page then offers a link the person taps (v0.3 final integration, seen end to end).
// A browser without navigator.userActivation (below Safari 16.4) cannot say whether the tap still counts: the page tries the
// move and offers the link as well, which a page that moved never shows.
function openTop(url, label) {
  const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null; // lint-floor-ignore: optional, read only when the browser has it
  if (!ua || ua.isActive) {
    try { (window.top || window).location.assign(url); if (ua) return; } catch (err) { /* refused: offer the link below */ }
  }
  const box = document.getElementById('toasts');
  if (!box) return;
  const a = h('a', { class: 'btn primary', href: url, target: '_top', rel: 'noopener', id: 'open-top' }, label || 'Open the page');
  const node = h('div', { class: 'toast ok', role: 'status' }, h('span', {}, 'Ready. '), a);
  box.append(node);
  setTimeout(() => node.remove(), 60000);
  try { a.focus(); } catch (err) { /* not focusable yet */ }
}

async function main() {
  const store = createStore();
  const env = { now: () => Date.now(), deviceClass, location: window.location };
  applyTheme(THEMES.indexOf(store.get(SK.theme, 'auto')) === -1 ? 'auto' : store.get(SK.theme, 'auto'));
  $('#theme-toggle').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(store.get(SK.theme, 'auto')) + 1) % THEMES.length];
    store.set(SK.theme, next); applyTheme(next);
  });
  const flags = await loadFlags();
  document.title = flags.appName;
  $('#brand-name').textContent = flags.appName;

  const mw = await loadSdk();
  const ctx = {
    mw, store, env, flags, hub: null, chat: null, data: null, inbox: null, ui: { editKey: '' }, route: null, standalone: false, subs: [],
    note: (text, kind) => toast(text, kind || 'info'),
    fail: (err) => { toast(errorMessage(err), 'error'); },
    announce, href: hrefFor,
    autoPictures: () => !!store.get(SK.prefs, DEFAULT_PREFS).autoPictures,
    onData(event, fn) { const off = ctx.data.on(event, fn); ctx.subs.push(off); return off; },
    go: (href, opts) => navigate(href, opts),
    navigateTop: (url, label) => openTop(url, label),
    rerender: () => render(ctx.route, { keepFocus: true }),
    signIn: () => signIn(),
    signOut: () => signOut(),
  };
  window.__social = { ctx }; // read-only handle for the end-to-end tests

  let reason = '';
  if (!mw) { ctx.standalone = true; reason = 'The loader SDK at /_mw/sdk.js is not served here.'; }
  else {
    try {
      ctx.hub = createHub(mw);
      ctx.chat = createChat({ mw });
      ctx.data = createData({ mw, hub: ctx.hub, store, env, chat: ctx.chat });
      await ctx.data.start();
      if (ctx.chat) ctx.inbox = createInbox({ chat: ctx.chat, data: ctx.data, announce });
    } catch (err) { ctx.standalone = true; reason = errorMessage(err); ctx.data = null; }
  }
  if (ctx.standalone) { $('#standalone').hidden = false; $('#standalone-why').textContent = reason; }

  // ---- chrome: nav, identity chip, sync line, alerts
  const updateChrome = throttle(() => {
    const d = ctx.data, signed = !!d && d.signedIn();
    const btn = $('#sign-in'), chip = $('#identity-chip');
    btn.hidden = ctx.standalone;
    btn.textContent = signed ? 'Sign out' : 'Sign in';
    chip.hidden = !signed;
    if (signed) { const id = d.state.identity || {}; chip.textContent = (id.name || 'You') + ' (' + (id.short || '') + ')'; }
    for (const a of $$('#main-nav a')) {
      const name = a.dataset.nav;
      a.hidden = !ctx.standalone && !signed && (name === 'messages' || name === 'notifications' || name === 'media' || name === 'settings');
      if (ctx.standalone && name !== 'about' && name !== 'home') a.hidden = true;
    }
    const count = $('#alerts-count'), n = d ? d.unseen() + (ctx.inbox ? ctx.inbox.unreadTotal() : 0) : 0;
    count.hidden = !n; count.textContent = n ? String(n) : '';
    const line = $('#sync-line');
    if (d) {
      const st = d.status();
      let text = st.offline ? offlineLine(formatClock(st.lastUpdated || env.now())) : st.syncing ? syncLine(st.done, st.total) : '';
      if (d.state.pow) text = (text ? text + '. ' : '') + 'Working out the spam fee for this post';
      line.textContent = text;
    } else line.textContent = '';
    renderSide();
  }, 200);
  function renderSide() {
    const side = $('#side');
    const d = ctx.data;
    const show = !!d && d.isHome();
    side.hidden = !show;
    if (!show) { setChildren(side, []); return; }
    import('./views/side.js').then((m) => m.renderSide(ctx, side)).catch(() => {});
  }

  async function signIn() {
    const d = ctx.data;
    if (!mw || !d) return;
    if (d.signedIn()) { try { await mw.auth.signOut(); await d.refresh(); toast('Signed out. This site no longer holds your keys.', 'ok'); updateChrome(); updateChrome.flush(); render(parseRoute(location.pathname)); } catch (err) { ctx.fail(err); } return; }
    try { await mw.auth.signIn(); await d.refresh(); updateChrome(); updateChrome.flush(); render(parseRoute(location.pathname)); } catch (err) { ctx.fail(err); }
  }
  async function signOut() { return signIn(); }
  $('#sign-in').addEventListener('click', () => { signIn(); });

  // ---- routing
  let current = null, token = 0, renderedKey = '';
  async function render(route, { keepFocus = false, first = false } = {}) {
    const mine = ++token;
    ctx.route = route;
    renderedKey = location.pathname + location.search;
    for (const off of ctx.subs.splice(0)) off();
    if (current && current.destroy) { try { current.destroy(); } catch (err) { /* gone */ } }
    current = null;
    for (const a of $$('#main-nav a')) {
      const here = a.dataset.nav === (route.name === 'thread' ? 'messages' : route.name === 'profile' || route.name === 'post' || route.name === 'group' ? '' : route.name);
      if (here) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const container = $('#view');
    setChildren(container, []);
    let name = route.name;
    if (ctx.standalone && name !== 'about') name = 'standalone';
    try {
      const mod = name === 'standalone' ? await import('./views/standalone.js') : await VIEWS[name]();
      if (mine !== token) return;
      const view = await mod.mount(ctx, route, container);
      if (mine !== token) { if (view && view.destroy) view.destroy(); return; }
      current = view || {};
      const title = (view && view.title) || flags.appName;
      $('#view-title').textContent = title;
      document.title = title + (title === flags.appName ? '' : ' - ' + flags.appName);
      if (!first && !keepFocus) { window.scrollTo(0, 0); $('#view-title').focus({ preventScroll: true }); announce(title); }
    } catch (err) {
      if (mine !== token) return;
      setChildren(container, [h('section', { class: 'card state' }, h('p', { class: 'error', role: 'alert' }, errorMessage(err)))]);
    }
  }
  function navigate(href, { replace = false } = {}) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) { location.assign(url.href); return; }
    if (url.pathname + url.search + url.hash !== location.pathname + location.search + location.hash) {
      history[replace ? 'replaceState' : 'pushState']({}, '', url.pathname + url.search + url.hash);
    }
    render(parseRoute(url.pathname));
  }
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#')) return;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/_mw/')) return;
    ev.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  window.addEventListener('popstate', () => {
    // A jump to an anchor on this page (the skip link) fires popstate in some browsers; it is not a new page, and drawing the view again would
    // throw away the place keyboard focus had reached. A pointer in the fragment names no element, so it still draws the page again.
    let anchor = false;
    try { anchor = location.hash.length > 1 && !!document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (err) { anchor = false; }
    if (anchor && location.pathname + location.search === renderedKey) return;
    render(parseRoute(location.pathname));
  });
  window.addEventListener('online', () => updateChrome());
  window.addEventListener('offline', () => updateChrome());

  if (ctx.data) {
    ctx.data.on('change', updateChrome); ctx.data.on('auth', updateChrome); ctx.data.on('pow', updateChrome);
    setInterval(updateChrome, 15000);
  }
  updateChrome();
  await render(parseRoute(location.pathname), { first: true });
}

main().catch((err) => {
  const v = $('#view');
  if (v) setChildren(v, [h('section', { class: 'card state' }, h('p', { class: 'error', role: 'alert' }, errorMessage(err)))]);
  console.error(err);
});

