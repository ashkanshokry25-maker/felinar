// src/media/service.js: the mw.media.* service (R 2.9.11, 2.11.2; the SVC contract shared with the
// identity, chat and SDK lanes). createMediaService(deps) -> { methods, on(event, fn), destroy() }.
//
// Every method is async (params, ctx) with ctx = { activation, tab, signal }. Gating, in this order:
//   1. host-only mode: E_HOST_ONLY for a method that would reach peers, before any prompt or request
//   2. _mw.cfg.media off: E_POLICY
//   3. a UI method without ctx.activation (a click in the site frame): E_NEEDS_GESTURE
//   4. no working keys: E_NOT_SIGNED_IN
// No method returns fk, a CryptoKey or any playback key: open() returns an origin URL (/_mw/media/<sid>).
//
// deps: { keys, ledgerId, node, cfg(), deviceClass, hostOnly, ownTracker, torrents, chat, sealed,
//         isDenied, prompt, swPort, now, random } plus optional { strip, faststart, makePoster,
//         makeStore, storeClass, canPlay, sessions, vault, pin, URL, emit }
// vault (code review v0.3, MF-72): where own items without a ledger copy and accepted grants keep M and fk on this
// device. Default: keysVault(deps.keys), the working keys' sealed per-origin cache (src/media/vault.js); vault: null
// keeps them in memory only. The service restores them (and the ledger's own-index items) once per signed-in key
// before list, open and the other calls (lane.ready()).
// v0.3 C2 (lane seed-engine): plus optional { owner, pinEvidence, evidenceInputs }: owner is the site owner's key (a
// string or a function; default node.owner), pinEvidence(ih, now) -> { configured, receipt, heartbeat } (PinWire of
// src/loader/pinwire.js), evidenceInputs(ih) -> TorrentManager.evidenceInputs for items without a handle. media.list
// entries keep 'available' and add evidence, label and labelParams (own items: handoff); own uploads are the H seed
// lane and, for the site owner with _mw.cfg.pin set, go to the pin queue at once (SZ-6). pin = { request(item) }.

import { MediaLane, capFor } from './lane.js';
import { MediaSessions } from './session.js';
import { mediaError } from './format.js';
import { IdbChunkStore, idbBackend } from '../files/store-idb.js';
import { stripImage, stripMp4, stripWebm } from './strip.js';
import { faststart } from './faststart.js';
import { makePoster } from './poster.js';
import { keysVault } from './vault.js';

export const MEDIA_UI = Object.freeze(['media.upload', 'media.share', 'media.revoke', 'media.delete', 'media.keepAvailable']);
export const MEDIA_READ = Object.freeze(['media.list']);
export const MEDIA_WRITE = Object.freeze(['media.open', 'media.close', 'media.pinRequest']);
export const MEDIA_NETWORK = Object.freeze(['media.upload', 'media.share', 'media.revoke', 'media.keepAvailable', 'media.pinRequest']);
export const MEDIA_EVENTS = Object.freeze(['progress', 'received', 'shared', 'revoked', 'unavailable']);

/** cfgOn(cfg, key) -> true when _mw.cfg[key] turns the feature on ('members', 'on', true or an object). */
export function cfgOn(cfg, key) {
  const v = cfg && typeof cfg === 'object' ? cfg[key] : undefined;
  if (v === undefined || v === null || v === false || v === 'off') return false;
  return true;
}

/** gate(deps, { name, ui, network, feature }) -> a checker run before a method body (shared with files). */
export function makeGate(deps, feature) {
  const hostOnly = () => (typeof deps.hostOnly === 'function' ? Boolean(deps.hostOnly()) : Boolean(deps.hostOnly));
  const cfg = () => {
    try {
      return typeof deps.cfg === 'function' ? deps.cfg() || {} : deps.cfg || {};
    } catch (_) {
      return {};
    }
  };
  return function gate({ ui, network, featureKey = feature, signedIn = true }, ctx) {
    if (network && hostOnly()) throw mediaError('E_HOST_ONLY', 'this browser runs this site host-only: nothing is shared with peers');
    if (!cfgOn(cfg(), featureKey)) throw mediaError('E_POLICY', 'this site has not turned this on');
    if (ui && !(ctx && ctx.activation)) throw mediaError('E_NEEDS_GESTURE', 'call this from a click');
    if (signedIn) {
      const k = typeof deps.keys === 'function' ? deps.keys() : deps.keys;
      if (!k || !k.pub) throw mediaError('E_NOT_SIGNED_IN', 'sign in first');
    }
    return cfg();
  };
}

/** Emitter shared by the services: on(event, fn) -> unsubscribe. */
export function makeEmitter(events) {
  const map = new Map();
  return {
    on(event, fn) {
      if (events.indexOf(event) < 0) throw mediaError('E_BAD_REQUEST', 'unknown event ' + event);
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => {
        const set = map.get(event);
        if (set) set.delete(fn);
      };
    },
    emit(event, data) {
      const set = map.get(event);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try {
          fn(data);
        } catch (_) { /* a listener's failure is its own */ }
      }
    },
    clear() {
      map.clear();
    },
  };
}

/** defaultStores(backend?) -> { makeStore, storeClass } over IndexedDB (or the given backend). */
export function defaultStores(backend) {
  let b = backend || null;
  const be = () => b || (b = idbBackend());
  return {
    makeStore: ({ name, chunkLength, length }) => new IdbChunkStore(chunkLength, { name, length, backend: be() }),
    storeClass: (name) => IdbChunkStore.factory({ name, backend: be() }),
  };
}

function canPlayDefault(mime) {
  try {
    if (typeof document === 'undefined') return true;
    return document.createElement('video').canPlayType(mime) !== '';
  } catch (_) {
    return true;
  }
}

/** createMediaService(deps) -> { methods, on, destroy, lane } */
/** Open media offers (cards waiting for an answer) per sender and in all (review round R 5.3, MAL53-10). */
export const OFFERS_PER_SENDER = 3;
export const OFFERS_OPEN = 20;

export function createMediaService(deps = {}) {
  const emitter = makeEmitter(MEDIA_EVENTS);
  const stores = deps.makeStore ? { makeStore: deps.makeStore, storeClass: deps.storeClass } : defaultStores(deps.backend);
  const sessions = deps.sessions || new MediaSessions({ sw: deps.swPort, random: deps.random, now: deps.now, capBytes: capFor(deps.deviceClass), URL: deps.URL });
  const ownTracker = () => (typeof deps.ownTracker === 'function' ? deps.ownTracker() : deps.ownTracker);
  const lane = new MediaLane({
    keys: deps.keys,
    ledgerId: deps.ledgerId,
    node: deps.node,
    torrents: deps.torrents,
    chat: deps.chat,
    sealed: deps.sealed,
    isDenied: deps.isDenied,
    prompt: typeof deps.prompt === 'function' ? deps.prompt : async () => false,
    sessions,
    makeStore: stores.makeStore,
    storeClass: stores.storeClass,
    random: deps.random,
    now: deps.now,
    deviceClass: deps.deviceClass,
    hostOnly: deps.hostOnly,
    get ownTracker() {
      return ownTracker();
    },
    strip: deps.strip || { stripImage, stripMp4, stripWebm },
    faststart: deps.faststart || faststart,
    makePoster: deps.makePoster || ((blob, sniffed) => makePoster(blob, sniffed)),
    canPlay: deps.canPlay || canPlayDefault,
    vault: deps.vault !== undefined ? deps.vault : keysVault(deps.keys, { name: 'media:index' }),
    pin: deps.pin,
    canWrite: deps.canWrite,
    chunkWaitMs: deps.chunkWaitMs,
    // C2 seed-engine: the site owner's key (SZ-6), the pin evidence of src/loader/pinwire.js, the manager's evidence,
    // and _mw.cfg (whether the site names a pin node).
    cfg: deps.cfg,
    owner: deps.owner,
    pinEvidence: deps.pinEvidence,
    evidenceInputs: deps.evidenceInputs,
    // Code review v0.3 (round 2, loader-sw request #25): the pin key only from an owner-written _mw.cfg (api.js ownerCfgPin).
    pinKey: deps.pinKey,
    emit: (event, data) => emitter.emit(event, data),
  });
  const gate = makeGate(deps, 'media');
  const offerJobs = new Set();
  // Review round R 5.3 (MAL53-10): at most OFFERS_PER_SENDER open offers from one sender and OFFERS_OPEN in all; the rest are
  // declined without a card and counted (offersDropped), so one contact cannot queue cards without end.
  const openBy = new Map();
  let offersDropped = 0;
  const offOffer = lane.on('received', (offer) => {
    const from = String((offer && offer.from) || '');
    if ((openBy.get(from) || 0) >= OFFERS_PER_SENDER || offerJobs.size >= OFFERS_OPEN) {
      offersDropped++;
      try { lane.decline(offer.id); } catch (_) { /* gone */ }
      return;
    }
    openBy.set(from, (openBy.get(from) || 0) + 1);
    const job = (async () => {
      let yes = false;
      try {
        yes = await lane.d.prompt({ kind: 'media-offer', from: offer.from, size: offer.size, mediaKind: offer.kind });
      } catch (_) {
        yes = false;
      }
      if (yes) await lane.accept(offer.id).catch(() => {});
      else lane.decline(offer.id);
    })();
    offerJobs.add(job);
    job.then(() => {
      offerJobs.delete(job);
      const n = (openBy.get(from) || 1) - 1;
      if (n > 0) openBy.set(from, n); else openBy.delete(from);
    });
  });
  let destroyed = false;
  const live = () => {
    if (destroyed) throw mediaError('E_POLICY', 'the media service was stopped');
  };
  const noTracker = () => {
    if (!ownTracker()) throw mediaError('E_NO_OWN_TRACKER', 'private media needs the site\'s own tracker');
  };

  // Items kept on this device or in the ledger come back once per signed-in key, before the first call uses them.
  const ready = () => lane.ready();

  const methods = {
    async 'media.upload'(params = {}, ctx = {}) {
      live();
      gate({ ui: true, network: true }, ctx);
      noTracker();
      await ready();
      const file = params.file || params;
      const opts = params.opts || params;
      return lane.upload(file, {
        keepOriginal: Boolean(opts.keepOriginal),
        signal: ctx.signal,
        onProgress: (p) => emitter.emit('progress', p),
      });
    },
    async 'media.list'(params = {}, ctx = {}) {
      live();
      gate({ ui: false, network: false }, ctx);
      const from = params.from === 'mine' || params.from === 'received' ? params.from : 'all';
      await ready();
      return lane.list({ from });
    },
    async 'media.open'(params = {}, ctx = {}) {
      live();
      gate({ ui: false, network: false }, ctx);
      await ready();
      const r = await lane.open(params.id, { part: params.part === 'poster' ? 'poster' : 'media' });
      return r;
    },
    async 'media.close'(params = {}, ctx = {}) {
      live();
      gate({ ui: false, network: false, signedIn: false }, ctx);
      return lane.close(params.id);
    },
    async 'media.share'(params = {}, ctx = {}) {
      live();
      gate({ ui: true, network: true }, ctx);
      await ready();
      return lane.share(params.id, { to: params.to, durable: Boolean(params.durable) });
    },
    async 'media.revoke'(params = {}, ctx = {}) {
      live();
      gate({ ui: true, network: true }, ctx);
      await ready();
      return lane.revoke(params.id, { from: params.from, reencrypt: Boolean(params.reencrypt) });
    },
    async 'media.delete'(params = {}, ctx = {}) {
      live();
      gate({ ui: true, network: false }, ctx);
      await ready();
      return lane.delete(params.id);
    },
    async 'media.keepAvailable'(params = {}, ctx = {}) {
      live();
      gate({ ui: true, network: true }, ctx);
      await ready();
      return lane.keepAvailable(params.id, Boolean(params.on));
    },
    async 'media.pinRequest'(params = {}, ctx = {}) {
      live();
      gate({ ui: false, network: true }, ctx);
      await ready();
      return lane.pinRequest(params.id);
    },
  };

  return {
    methods,
    on: (event, fn) => emitter.on(event, fn),
    /** onGrant(fromPub, grant): the chat service hands media grants and revokes here (after the restore, so an item
     * accepted before a reload is not offered again). */
    onGrant: async (fromPub, grant) => {
      await ready();
      return lane.onGrant(fromPub, grant);
    },
    /** signOut(): every session and key goes (the identity lane calls it). */
    signOut: () => lane.signOut(),
    restore: () => lane.restore(),
    lane,
    sessions,
    /** offers declined without a card because one sender or all senders had too many open (MAL53-10). */
    get offersDropped() { return offersDropped; },
    async settled() {
      await Promise.all(Array.from(offerJobs));
    },
    destroy() {
      destroyed = true;
      offOffer();
      lane.signOut();
      lane.unwatch();
      emitter.clear();
    },
  };
}
