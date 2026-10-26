// src/dropin/mw.js: the entry of /_mw/mw.js, the one script tag a site adds (ARCHITECTURE §3.4.1;
// INTERFACES "src/dropin/mw.js"):
//
//   <script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>
//
// Loading the module starts one DropinEngine for the page (engine.js) and binds window.mw to it
// (binding.js). Everything else is lazy: the ledger, the cache, the torrent code and the 222 KB
// webtorrent bundle (222,343 bytes as patched in the 0.2.1 build) load only when a step needs them. The
// module never throws into the page: any failure is one console.warn and the page keeps working from the
// host (3.4.8).
//
// Script tag options (read from this very <script> element):
//   data-mw-sw="off"        never register /mw-sw.js (the ledger and sharing still run)
//   data-mw-consent="site"  no automatic notice: the site explains sharing itself and calls
//                           mw.consent.request() (from a click); the visitor decides in the
//                           loader's own card (closed shadow root). A site never accepts (v0.2.1 A4).
//
// v0.3 (R 2.11, 3.8): the same SDK tables, services and gating as the shell (src/loader/api.js). The engine tab
// mounts the identity, chat, files and media services (deps.v03, lazily); a page without a ledger still gets
// window.mw (the chat panel shows "unavailable"). On /_mw/idp-return (the Service Worker's minimal page, <meta
// name="mw-idp-return">) the engine only finishes a redirect sign-in and goes back to the page that asked.
//
// window.__mwDropin = { version, started, inspect(), openSettings(), rectOf(label) }, frozen and without the engine
// (code review round 1, F08: see start() below), exists for diagnostics, tests and for a site that wants a link
// that opens the visitor's sharing settings (the notice is shown once).

import { CONFIG } from '../loader/config.js';
import { installOfferTimeout } from '../loader/connectivity.js';
import { DropinEngine } from './engine.js';
import { findScriptTag, parseScriptOptions } from './stamp.js';

export const DROPIN_VERSION = CONFIG.version;

/**
 * Module loaders the engine uses; each import() is evaluated only when a step first needs it.
 * win: the window whose RTCPeerConnection the B7 offer-timeout wrapper patches before the bundle loads.
 */
export function createDeps(moduleUrl, { webtorrentUrl = null, win = (typeof window !== 'undefined' ? window : null) } = {}) {
  return {
    cache: () => import('../loader/cache.js'),
    verify: () => import('../loader/verify.js'),
    torrentFile: () => import('../common/torrent-file.js'),
    crypto: () => import('../chain/crypto.js'),
    torrent: () => import('../loader/torrent.js'),
    // v0.3: the modules of the services (one missing is left out: its methods answer E_UNSUPPORTED). Each import
    // sits in its own try, so a build without one of them still builds and runs (as src/loader/app.js does).
    v03: async () => {
      const out = {};
      try { out.client = await import('../identity/client.js'); } catch (_) { out.client = null; }
      try { out.store = await import('../identity/store.js'); } catch (_) { out.store = null; }
      try { out.migrate = await import('../identity/migrate.js'); } catch (_) { out.migrate = null; }
      try { out.sealed = await import('../identity/sealed.js'); } catch (_) { out.sealed = null; }
      try { out.chat = await import('../chat/service.js'); } catch (_) { out.chat = null; }
      try { out.files = await import('../files/service.js'); } catch (_) { out.files = null; }
      try { out.media = await import('../media/service.js'); } catch (_) { out.media = null; }
      return out;
    },
    chain: async () => {
      const [node, stores, pow, pool] = await Promise.all([
        import('../chain/node.js'),
        import('../chain/stores.js'),
        import('../chain/pow-client.js'),
        import('../chain/verify-pool.js'),
      ]);
      let createBlock = null;
      try {
        createBlock = (await import('../chain/block.js')).createBlock;
      } catch (_) { /* the 0.2.1 key's mw.link item is written later */ }
      return { ChainNode: node.ChainNode, IdbBlockStore: stores.IdbBlockStore, createMiner: pow.createMiner, createVerifierPool: pool.createVerifierPool, createBlock };
    },
    webtorrent: async () => {
      // v0.2.1 B7 (as the shell does in app.js): the bundle captures RTCPeerConnection when it is
      // imported, so the wrapper that sends a non-trickle offer 1.5 s after the first candidate (instead
      // of waiting up to 5 s for a dead STUN server) goes in first.
      try {
        if (win) installOfferTimeout(win, { timeoutMs: CONFIG.ice.offerTimeoutMs });
      } catch (_) { /* leave RTCPeerConnection as it is */ }
      // A computed specifier on purpose: the vendored bundle is copied next to this file, never bundled.
      const url = webtorrentUrl || new URL(CONFIG.assets.webtorrent, moduleUrl).href;
      const mod = await import(/* webpackIgnore: true */ url);
      const WebTorrent = mod && (mod.default || mod.WebTorrent);
      if (typeof WebTorrent !== 'function') throw new Error('webtorrent.min.js has no default export');
      return WebTorrent;
    },
  };
}

// window.mw = binding. When /_mw/sdk.js ran first it installed an accessor whose setter adopts the
// binding; assignment goes through it. A page that made window.mw something else is left alone.
function bindGlobal(win, mw) {
  try {
    win.mw = mw;
  } catch (_) { /* read-only global */ }
  let current;
  try {
    current = win.mw;
  } catch (_) {
    current = undefined;
  }
  if (current !== mw) {
    try {
      Object.defineProperty(win, 'mw', { value: mw, configurable: true, writable: true, enumerable: true });
    } catch (_) { /* a frozen window: the SDK facade still reaches the engine through window.__mwDropin */ }
  }
}

/**
 * start({ win, moduleUrl, deps, options }) → { version, started, inspect, openSettings, rectOf,
 * engine } on the call that creates the engine, or null outside a page. One engine per window: a
 * second call returns the public handle only.
 *
 * window.__mwDropin is the PUBLIC handle, frozen: { version, started, inspect(), openSettings(),
 * rectOf(label) } (code review round 1: it used to carry the engine itself, through which any page
 * script could accept consent for the visitor or export the identity; ARCHITECTURE 3.4.9). The
 * engine is reachable only from this function's return value (unit tests and embedders that start
 * the runtime themselves with __mwNoAutostart).
 */
export function start({ win = (typeof window !== 'undefined' ? window : null), moduleUrl = import.meta.url, deps = null, options = null, engineOptions = {} } = {}) {
  if (!win || !win.document) return null;
  if (win.__mwDropin) return win.__mwDropin;
  const tag = findScriptTag(win.document, moduleUrl);
  const engine = new DropinEngine(Object.assign({
    win,
    deps: deps || createDeps(moduleUrl),
    options: options || parseScriptOptions(tag),
  }, engineOptions));
  bindGlobal(win, engine.mw);
  const handle = Object.freeze({
    version: DROPIN_VERSION,
    started: engine.start(),
    inspect: () => engine.inspect(),
    // For a site that wants its own "peer-to-peer settings" link: the panel of the notice, on demand.
    openSettings: () => engine.openSettings(),
    // Geometry of a button of the closed-shadow card or panel, for tests and tools that click it with
    // a real (trusted) mouse event (tools/live.mjs, e2e): reading a rectangle grants nothing.
    rectOf: (label) => (engine.panel && typeof engine.panel.rectOf === 'function' ? engine.panel.rectOf(label) : null),
  });
  try {
    Object.defineProperty(win, '__mwDropin', { value: handle, configurable: false, writable: false, enumerable: false });
  } catch (_) {
    try {
      win.__mwDropin = handle;
    } catch (_e) { /* frozen window */ }
  }
  return Object.assign({}, handle, { engine });
}

export default start;

// Loaded as the page's script: start. Tests set window.__mwNoAutostart before importing this module.
if (typeof window !== 'undefined' && window.document && !window.__mwNoAutostart) {
  try {
    start();
  } catch (err) {
    try {
      if (typeof console !== 'undefined' && console.warn) console.warn('felinar: the peer-to-peer engine could not start (' + ((err && err.message) || String(err)) + '). The host serves every file.');
    } catch (_) { /* no console */ }
  }
}
