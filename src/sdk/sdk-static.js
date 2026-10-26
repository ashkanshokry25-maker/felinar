// src/sdk/sdk-static.js: the static /_mw/sdk.js stub (v0.2.1 DIGEST-AMENDMENTS F7, MIGRATION-DIGEST
// M12; w2a-05 R3; v0.3 surface of R 2.11.2). build.mjs emits it as dist/_mw/sdk-static.js and tools/publish.mjs
// copies it to <out>/sdk-static.js. Serve it AS /_mw/sdk.js wherever the felinar runtime is not: a plain static
// copy of the site (a crawler's view, a preview, a mirror) or a site after the runtime was removed
// (rollback: the kill switch first, then the tags and /_mw/, keeping this stub). A page that imports
// /_mw/sdk.js then finds a module instead of a 404 (a failed resource in every crawler report) and
// gets mw.ready() -> { mode: 'static' } instead of an error, so it can render its static view without
// developer-facing text. Nothing here connects anywhere, stores anything or reads any page data.
//
// Surface (ARCHITECTURE 9 and 15.9, R 2.11.2): reads resolve empty (a guest with no ledger, no chat, no files),
// writes and UI methods reject with E_NO_HOST, subscriptions and events are inert, consent.state() is
// 'host-only', auth.state() is 'guest'. v0.3 C2: mw.calls (state() null, list() [], the rest E_NO_HOST) and
// mw.net.seeding() (every lane off, nothing counted), dock() and keep() (E_NO_HOST). tools/dev-server.mjs answers /_mw/sdk.js with this file when the directory
// it serves has no /_mw/sdk.js of its own.

const STATIC = 'static';
export const SDK_VERSION = '0.3.0';

function noHost() {
  const err = new Error('felinar is not running on this page: this is a static copy of the site');
  err.code = 'E_NO_HOST';
  return Promise.reject(err);
}

function off() {
  return () => {};
}

const empty = (v) => () => Promise.resolve(v);

// v0.3 C2: what mw.net.seeding() reads on a static copy: nothing shares, nothing is counted.
const NO_SEEDING = () => Promise.resolve({
  lanes: { H: { rate: 0, used: 0 }, K: { rate: 0, used: 0 }, E: { rate: 0, used: 0 } },
  month: { used: 0, cap: 0 },
  dock: { on: false, until: null },
  keeper: false,
});

const mw = {
  mode: STATIC,
  version: SDK_VERSION,
  ready: () => Promise.resolve({
    mode: STATIC, siteId: null, btih: null, auth: 'guest', identity: null, role: 'reader', peers: 0, height: 0, owner: null, unmoderated: true,
    features: { chat: false, files: false, media: false, records: false, requests: false, calls: false },
  }),
  auth: {
    signIn: noHost, signOut: noHost, state: () => 'guest', onChange: off, prove: noHost, verify: empty({ ok: false, reason: 'static' }), signInServer: noHost,
  },
  identity: { current: empty(null), setName: noHost, backupStatus: empty(null), openIdentity: noHost },
  me: { get: noHost, set: noHost, del: noHost, sync: noHost, erase: noHost },
  db: {
    get: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    set: noHost,
    del: noHost,
    append: noHost,
    tombstone: noHost,
    subscribe: off,
    setMine: noHost,
    getMine: () => Promise.resolve(undefined),
    listBy: () => Promise.resolve([]),
  },
  hub: { follow: noHost, unfollow: noHost, list: empty([]), createPage: noHost },
  mod: { ban: noHost, unban: noHost, tombstoneMany: noHost, queue: empty([]), decide: noHost },
  chat: {
    enable: noHost, disable: noHost, state: empty({ state: 'off', hostOnly: false }), on: off,
    presence: { set: noHost, list: empty([]) },
    contacts: { list: noHost, add: noHost, remove: noHost, block: noHost, unblock: noHost, verify: noHost },
    requests: { list: empty([]), accept: noHost, decline: noHost, setOpen: noHost },
    dm: { send: noHost, history: noHost, keepHistory: noHost },
    room: { join: noHost, leave: noHost, send: noHost },
    group: { create: noHost, invite: noHost, remove: noHost, leave: noHost, send: noHost },
    holder: { set: noHost },
    direct: { connect: noHost },
  },
  files: {
    enable: noHost, list: empty([]), received: empty([]), share: noHost, fetch: noHost, preview: empty({ kind: 'none' }), save: noHost,
    keepSharing: noHost, stopSharing: noHost, remove: noHost, pinRequest: noHost, on: off,
  },
  media: {
    upload: noHost, list: empty([]), open: noHost, close: noHost, share: noHost, revoke: noHost, delete: noHost, keepAvailable: noHost,
    pinRequest: noHost, on: off,
  },
  report: { send: noHost },
  calls: {
    start: noHost, accept: noHost, decline: noHost, hangup: noHost, mute: noHost, camera: noHost, screen: noHost,
    state: empty(null), list: empty([]), on: off,
  },
  net: { peers: () => 0, on: off, seeding: NO_SEEDING, dock: noHost, keep: noHost },
  site: { info: () => Promise.resolve({ name: null, files: [], btih: null, source: STATIC, mode: STATIC }) },
  consent: { state: () => 'host-only', request: () => Promise.resolve('host-only') },
  owner: {
    policy: () => {
      const err = new Error('the owner key never runs in a browser');
      err.code = 'E_NOT_OWNER';
      return Promise.reject(err);
    },
  },
};

try {
  if (typeof globalThis !== 'undefined' && !globalThis.mw) globalThis.mw = mw;
} catch (_) { /* a read-only global: the default export still works */ }

export default mw;
