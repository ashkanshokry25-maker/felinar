// src/files/service.js: the mw.files.* service (R 2.11.2, 2.8; the SVC contract shared with the
// identity, chat and SDK lanes). createFilesService(deps) -> { methods, on(event, fn), destroy() }.
//
// Methods are async (params, ctx) with ctx = { activation, tab, signal }. Gating, in this order:
// E_HOST_ONLY (a method that reaches peers, in host-only mode, before any prompt or request); E_POLICY
// (_mw.cfg.files off for public files, _mw.cfg.media off for private files, R 2.5.5); E_NEEDS_GESTURE
// (a UI method without ctx.activation); E_NOT_SIGNED_IN (sharing needs working keys). files.fetch()
// returns a handle whose Blobs are typed application/octet-stream; files.preview() and files.save()
// are the only paths from shared bytes to the screen or the disk (MF-48). No method returns fk.
//
// deps: as createMediaService, plus optional { download(url, name), render, makeStore, storeClass, sessions }
// vault (code review v0.3, MF-72): private file keys (own private shares and received grants) are kept on this device
// (default keysVault(deps.keys, { name: 'files:index' }), src/media/vault.js; null keeps them in memory only) and come
// back once per signed-in key before the first call (lane.ready()).
//
// v0.3 C2 (lane seed-engine): optional { owner, pinEvidence, evidenceInputs } as createMediaService. files.list and
// files.received entries keep 'available' and add evidence, label and labelParams (own items: handoff); an own
// upload is the H seed lane (the MF-45 card 'phone-upload' first on phones) and goes to the pin queue at once when
// _mw.cfg.pin is set and the uploader is the site owner (SZ-6).

import { FileLane, privateCap } from './lane.js';
import { MediaSessions } from '../media/session.js';
import { mediaError } from '../media/format.js';
import { makeGate, makeEmitter, defaultStores, cfgOn } from '../media/service.js';
import { stripImage, stripMp4, stripWebm } from '../media/strip.js';
import { keysVault } from '../media/vault.js';

export const FILES_UI = Object.freeze(['files.enable', 'files.share', 'files.save', 'files.keepSharing', 'files.remove']);
export const FILES_READ = Object.freeze(['files.list', 'files.received', 'files.preview']);
export const FILES_WRITE = Object.freeze(['files.fetch', 'files.stopSharing', 'files.pinRequest']);
export const FILES_EVENTS = Object.freeze(['progress', 'shared', 'received', 'removed']);

/** createFilesService(deps) -> { methods, on, destroy, lane } */
export function createFilesService(deps = {}) {
  const emitter = makeEmitter(FILES_EVENTS);
  const stores = deps.makeStore ? { makeStore: deps.makeStore, storeClass: deps.storeClass } : defaultStores(deps.backend);
  const sessions = deps.sessions || new MediaSessions({ sw: deps.swPort, random: deps.random, now: deps.now, capBytes: privateCap(deps.deviceClass), URL: deps.URL });
  const lane = new FileLane({
    keys: deps.keys,
    ledgerId: deps.ledgerId,
    node: deps.node,
    torrents: deps.torrents,
    chat: deps.chat,
    isDenied: deps.isDenied,
    prompt: typeof deps.prompt === 'function' ? deps.prompt : async () => false,
    sessions,
    makeStore: stores.makeStore,
    storeClass: stores.storeClass,
    random: deps.random,
    now: deps.now,
    deviceClass: deps.deviceClass,
    hostOnly: deps.hostOnly,
    ownTracker: deps.ownTracker,
    cfg: deps.cfg,
    strip: deps.strip || { stripImage, stripMp4, stripWebm },
    render: deps.render,
    download: deps.download,
    pin: deps.pin,
    vault: deps.vault !== undefined ? deps.vault : keysVault(deps.keys, { name: 'files:index' }),
    wasListed: deps.wasListed,
    doneWaitMs: deps.doneWaitMs,
    pollMs: deps.pollMs,
    // C2 seed-engine: the site owner's key (SZ-6), the pin evidence of src/loader/pinwire.js, the manager's evidence.
    owner: deps.owner,
    pinEvidence: deps.pinEvidence,
    evidenceInputs: deps.evidenceInputs,
    // Code review v0.3 (round 2, loader-sw requests #21 and #25): premoderation (mod.js listingVisible) and the pin key only
    // from an owner-written _mw.cfg (api.js ownerCfgPin).
    listingVisible: deps.listingVisible,
    pinKey: deps.pinKey,
    // Review round (SCALE-13, MAL53-11): bytes fetched files may hold on this device (else storageLines().filesMax).
    filesBudget: deps.filesBudget,
    emit: (event, data) => emitter.emit(event, data),
  });
  const gateFiles = makeGate(deps, 'files');
  const gateMedia = makeGate(deps, 'media');
  const cfg = () => {
    try {
      return typeof deps.cfg === 'function' ? deps.cfg() || {} : deps.cfg || {};
    } catch (_) {
      return {};
    }
  };
  // a fetched or shared file is public (cfg.files) or private (cfg.media); either switch allows listing
  const gateAny = (o, ctx) => {
    const c = cfg();
    const key = cfgOn(c, 'files') ? 'files' : 'media';
    return (key === 'files' ? gateFiles : gateMedia)(o, ctx);
  };
  const gateFor = (ref, o, ctx) => {
    const rec = lane.files.get(ref);
    if (rec && rec.kind === 'private') return gateMedia(o, ctx);
    return gateFiles(o, ctx);
  };
  let enabled = false;
  let destroyed = false;
  const live = () => {
    if (destroyed) throw mediaError('E_POLICY', 'the files service was stopped');
  };

  const methods = {
    async 'files.enable'(params = {}, ctx = {}) {
      live();
      gateAny({ ui: true, network: true, signedIn: false }, ctx);
      if (!enabled) {
        const ok = await lane.d.prompt({ kind: 'files-enable' });
        if (!ok) throw mediaError('E_USER_CANCELLED', 'cancelled');
        enabled = true;
      }
      return { enabled: true };
    },
    async 'files.list'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFiles({ ui: false, network: false, signedIn: false }, ctx);
      return lane.list();
    },
    async 'files.received'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateMedia({ ui: false, network: false }, ctx);
      return lane.received();
    },
    async 'files.share'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      const isPublic = Boolean(params.public);
      (isPublic ? gateFiles : gateMedia)({ ui: true, network: true }, ctx);
      return lane.share(params.file, { public: isPublic, to: Array.isArray(params.to) ? params.to : [], name: params.name, original: Boolean(params.original) });
    },
    async 'files.fetch'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: false, network: true, signedIn: false }, ctx);
      return lane.fetch(params.ref, { signal: ctx.signal, onProgress: (p) => emitter.emit('progress', p) });
    },
    async 'files.preview'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: false, network: false, signedIn: false }, ctx);
      return lane.preview(params.ref);
    },
    async 'files.save'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: true, network: false, signedIn: false }, ctx);
      return lane.save(params.ref);
    },
    async 'files.keepSharing'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: true, network: true, signedIn: false }, ctx);
      return lane.keepSharing(params.ref, params.on !== false);
    },
    async 'files.stopSharing'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: false, network: false, signedIn: false }, ctx);
      return lane.stopSharing(params.ref);
    },
    async 'files.remove'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: true, network: false, signedIn: false }, ctx);
      return lane.remove(params.ref);
    },
    async 'files.pinRequest'(params = {}, ctx = {}) {
      live();
      await lane.ready();
      gateFor(params.ref, { ui: false, network: true }, ctx);
      return lane.pinRequest(params.ref);
    },
  };

  return {
    methods,
    on: (event, fn) => emitter.on(event, fn),
    onGrant: async (fromPub, grant) => {
      await lane.ready(); // a grant kept before a reload is not offered again
      return lane.onGrant(fromPub, grant);
    },
    lane,
    sessions,
    destroy() {
      destroyed = true;
      sessions.closeAll();
      for (const rec of lane.files.values()) lane._stop(rec);
      lane.unwatch();
      emitter.clear();
    },
  };
}
