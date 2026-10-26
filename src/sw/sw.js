// src/sw/sw.js: the classic entry of /mw-sw.js (ARCHITECTURE §7.1; INTERFACES "src/sw/sw.js").
// build.mjs bundles it as a classic IIFE (module Service Workers need Firefox 147+) and replaces
// self.__BUILD_ID__ (a string) and self.__PRECACHE__ (an array of same-origin paths, usually the
// shell /index.html plus /_mw/*; webtorrent.min.js is always left out and cached on first fetch).
// Unbuilt development falls back to 'dev' and DEFAULT_PRECACHE. v0.2.1 (D2): build.mjs also replaces
// self.__INTEGRITY__ with { path: 'sha384-...' } for the JS and CSS of the precache list (the same
// values build.json lists); those entries make the install atomic (src/sw/core.js precacheCritical).
//
// The script URL never changes, it is served with Cache-Control: no-cache and registered with
// scope '/' and updateViaCache 'none'. To remove the worker from every returning visitor, deploy
// src/sw/kill-switch.js (dist/mw-sw-kill.js) as /mw-sw.js.

import { createCore, DEFAULT_PATHS, DEFAULT_PRECACHE, PROTO } from './core.js';

const core = createCore({
  paths: DEFAULT_PATHS,
  proto: PROTO,
  buildId: self.__BUILD_ID__ || 'dev',
  precache: self.__PRECACHE__ || DEFAULT_PRECACHE,
  integrity: self.__INTEGRITY__ || null,
});

// Same object a site's own worker gets from /_mw/sw-core.js; replaces the drop-in core that
// core.js attached while it was evaluated, so its message listener reaches this one too.
self.mw = core;

self.addEventListener('install', (event) => {
  core.install(event);
});

self.addEventListener('activate', (event) => {
  core.activate(event);
});

self.addEventListener('fetch', (event) => {
  if (core.owns(event)) event.respondWith(core.handle(event));
});

// core.message() handles each event once, whichever listener sees it first.
self.addEventListener('message', (event) => {
  core.message(event);
});

// A page's message that does not deserialize here: tell the page at once (code review v0.3, round 2).
self.addEventListener('messageerror', (event) => {
  core.messageError(event);
});

core.init();
