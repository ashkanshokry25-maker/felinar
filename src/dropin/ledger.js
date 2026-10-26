// src/dropin/ledger.js: the site ledger inside a drop-in page (ARCHITECTURE §5.5, §5.9, §6.8;
// DESIGN-REVIEW S2, S6). Functions over the engine (`E`, see engine.js): open the ChainNode for the
// leader tab, stand in for it in follower tabs (RemoteNode over the BroadcastChannel), keep the tabs
// in step, attach the node to the torrents' wires, and ingest the pointer's cs= snapshot.
//
//   openLedger(E) → node | null        leader: identity + IndexedDB store + ChainNode.open
//   followLedger(E) → RemoteNode       follower: state from the leader, writes forwarded to it
//
// v0.3 (R 2.4.1, E-ID-2b): with the identity service in the build (E.identityMode 'v03') no key is made for a
// guest. The ledger opens read only and signs with the working keys once the person signs in (engine.bindKeys);
// follower tabs hold no keys and show the engine tab's auth state from its 'state' messages, and drop it on
// 'signed-out'.
//   installTabLink(E)                  what this tab answers on 'mw-<ledgerId>'
//   broadcastState(E)                  leader -> followers, at most every 250 ms
//   attachLedger(E, torrent)           register the ledger's wire extension on a torrent
//   fetchSnapshot(E)                   cs= (gzip or plain JSON array of blocks) -> node.importSnapshot
//   closeLedger(E)                     close the node, miner and verifier pool (pagehide)

import { ensureIdentity } from './identity.js';
import { nodeIdentityOf, siteModeOf } from '../loader/api.js';
import { readSnapshot } from '../common/snapshot-read.js';
import { RemoteNode, TAB_ARITY } from './leader.js';

const BROADCAST_MS = 250;

function msg(err) {
  return (err && err.message) || String(err);
}

async function loadSigner(E, cache, crypto) {
  const moderator = await cache.getKey('moderator:' + E.ledgerId).catch(() => null);
  let identity;
  if (moderator && moderator.pub && (moderator.privateKey || moderator.jwk)) {
    const privateKey = moderator.privateKey || await crypto.importPrivateJwk(moderator.jwk, { extractable: false });
    identity = { privateKey, pub: moderator.pub, kind: 'moderator' };
  } else if (E.identityMode === 'v03') {
    // v0.3: the working keys of a sign-in, or nothing for a guest (the ledger opens read only).
    const id = nodeIdentityOf(E.api.identity.keys());
    E.identity = id;
    const info = E.api.identity.info();
    E.identityInfo = info ? { pub: info.pub, short: info.short || null, name: info.name || null } : null;
    return id;
  } else {
    identity = await ensureIdentity({ cache, crypto, ledgerId: E.ledgerId });
  }
  E.identity = identity;
  let short;
  try {
    short = await crypto.fingerprint(identity.pub);
  } catch (_) {
    short = typeof crypto.shortKey === 'function' ? crypto.shortKey(identity.pub) : String(identity.pub).slice(0, 8);
  }
  E.identityInfo = { pub: identity.pub, short, name: null };
  // v0.3: an imported moderator key signs this tab's writes, so the site sees it as the signed-in key.
  if (identity.kind === 'moderator' && E.api && E.api.identity && typeof E.api.identity.setLoaderKey === 'function') E.api.identity.setLoaderKey(E.identityInfo);
  return identity;
}

export function attachLedger(E, torrent) {
  const node = E.node;
  if (!node || E.followerNode || typeof node.attachTorrent !== 'function' || !torrent) return;
  try {
    const detach = node.attachTorrent(torrent);
    if (typeof detach === 'function' && typeof torrent.once === 'function') {
      torrent.once('close', () => {
        try {
          detach();
        } catch (_) { /* already detached */ }
      });
    }
  } catch (err) {
    E.log('ledger attach failed: ' + msg(err));
  }
}

export function onLedgerChange(E) {
  const node = E.node;
  if (!node) return;
  let snap = null;
  try {
    snap = node.snapshot();
  } catch (_) {
    snap = null;
  }
  if (E.identityInfo && snap && snap.profiles) {
    const name = snap.profiles instanceof Map ? snap.profiles.get(E.identityInfo.pub) : snap.profiles[E.identityInfo.pub];
    if (typeof name === 'string' && name !== E.identityInfo.name) E.identityInfo = Object.assign({}, E.identityInfo, { name });
  }
  E.binding.pushState();
  broadcastState(E);
}

export async function openLedger(E) {
  const run = E.runId; // the engine restarts after a back/forward-cache restore: a stale open is dropped
  try {
    const cache = await E.mod('cache');
    const crypto = await E.mod('crypto');
    const identity = await loadSigner(E, cache, crypto);
    const chain = await E.mod('chain');
    const store = new chain.IdbBlockStore();
    E.nodeStore = store;
    E.miner = E.miner || chain.createMiner({ workerUrl: E.config.assets.powWorker });
    // A worker pool for signatures (code review round 1: workerUrl was missing, so blocks verified inline).
    E.verifierPool = E.verifierPool || chain.createVerifierPool({ size: E.config.ledger.verifierPoolSize, workerUrl: E.config.assets.powWorker });
    const node = await chain.ChainNode.open({
      siteId: E.ledgerId,
      expectedOwner: E.signed ? E.record.owner : null,
      ledgerOwner: E.signed ? (E.record.lo || E.record.owner) : null,
      genesisHash: E.record.gen || null,
      store,
      // v0.3: a guest opens the ledger read only (identity null); a sign-in binds its working keys later.
      identity: identity && identity.privateKey ? { privateKey: identity.privateKey, pub: identity.pub } : null,
      miner: E.miner,
      verifierPool: E.verifierPool,
      config: { minBits: E.config.chain.minBits, ingressRate: E.config.ledger.ingressRate },
    });
    if (run !== E.runId || E.state === 'destroyed' || E.state === 'off') {
      // The page went away (or the engine was restarted) while the ledger was opening.
      try {
        await node.close();
      } catch (_) { /* closing a stale node */ }
      return null;
    }
    E.node = node;
    E.followerNode = null;
    node.subscribe(() => onLedgerChange(E));
    if (E.identityMode === 'v03' && typeof E.bindKeys === 'function') {
      try {
        await E.bindKeys(E.api.identity.keys());
      } catch (err) {
        E.log('keys: ' + msg(err));
      }
    }
    E.api.setNode(node);
    if (node.ownerConflict) E.warnOnce('owner-conflict', 'felinar: ' + E.strings.ownerConflict);
    else if (node.ownerMismatch) E.warnOnce('owner-mismatch', 'felinar: ' + E.strings.ownerMismatch + '. Shared data from this site is not trusted.');
    if (E.tm) {
      // Torrents added before the node opened still get the extension on their future wires.
      if (E.tm.site && E.tm.site.torrent) attachLedger(E, E.tm.site.torrent);
      if (E.tm.anchor && E.tm.anchor.torrent) attachLedger(E, E.tm.anchor.torrent);
    }
    onLedgerChange(E);
    E.log('ledger open, height ' + node.height);
    return node;
  } catch (err) {
    E.api.setNode(null, { failed: true });
    E.warnOnce('ledger', 'felinar: the site ledger could not be opened (' + msg(err) + '). The page still works; shared data is off.');
    return null;
  }
}

async function showStoredIdentity(E) {
  try {
    // A follower never creates an identity: two tabs creating one at once would overwrite each other.
    const cache = await E.mod('cache');
    const rec = await cache.getKey('identity:' + E.ledgerId).catch(() => null);
    if (rec && rec.pub) {
      const crypto = await E.mod('crypto');
      let short;
      try {
        short = await crypto.fingerprint(rec.pub);
      } catch (_) {
        short = typeof crypto.shortKey === 'function' ? crypto.shortKey(rec.pub) : String(rec.pub).slice(0, 8);
      }
      E.identityInfo = { pub: rec.pub, short, name: null };
    }
  } catch (_) { /* the leader's first state message carries the identity */ }
}

export async function followLedger(E) {
  // v0.3: a follower holds no keys; the engine tab's 'state' messages carry its auth state.
  if (E.identityMode !== 'v03') await showStoredIdentity(E);
  const node = new RemoteNode(E.link);
  node.identity = E.identityInfo;
  E.followerNode = node;
  E.node = node;
  node.subscribe(() => onLedgerChange(E));
  E.api.setNode(node);
  E.link.send('need-state');
  return node;
}

export function broadcastState(E) {
  if (!E.isLeader || !E.link || !E.node || E.node === E.followerNode) return;
  if (E.stateTimer !== null) return;
  E.stateTimer = E.timers.setTimeoutFn(() => {
    E.stateTimer = null;
    const node = E.node;
    if (!node || node === E.followerNode) return;
    let snap = null;
    try {
      snap = node.snapshot();
    } catch (_) {
      snap = null;
    }
    if (!snap) return;
    E.link.send('state', {
      snap,
      peers: E.tm ? E.tm.peers : (typeof node.peers === 'number' ? node.peers : 0),
      inSync: node.inSyncPeers || 0,
      role: node.role,
      identity: E.identityInfo,
      auth: E.api ? E.api.identity.state() : null,
      mode: E.identityMode || null,
    });
  }, BROADCAST_MS);
}

export function installTabLink(E) {
  E.link.on(async (m) => {
    if (m.t === 'consent') {
      // Adopted only when the stored per-origin record confirms it (code review round 1).
      if (m.state !== E.consent.state()) await E.consent.set(m.state, { broadcast: false, fromTab: true });
      return;
    }
    if (m.t === 'signed-out') {
      // The engine tab signed out (E-ID-2b): this tab drops what it showed of that sign-in.
      if ((!E.isLeader || E.node === E.followerNode) && typeof E.onSignedOutBroadcast === 'function') E.onSignedOutBroadcast();
      return;
    }
    if (m.t === 'state' && E.followerNode) {
      E.followerNode.apply(m);
      if (E.identityMode === 'v03' && (m.auth === 'signed-in' || m.auth === 'guest')) {
        const id = m.identity && typeof m.identity === 'object' && typeof m.identity.pub === 'string'
          ? { pub: m.identity.pub, short: m.identity.short || null, name: m.identity.name || null, mode: siteModeOf(m.identity.mode) }
          : null;
        E.api.identity.setRemote({ state: m.auth, info: m.auth === 'signed-in' ? id : null });
        if (m.auth === 'guest') E.identityInfo = null;
      }
      if (m.identity && typeof m.identity === 'object' && !(E.identityMode === 'v03' && m.auth === 'guest')) E.identityInfo = Object.assign({}, E.identityInfo || {}, m.identity);
      E.binding.push('peers', { count: Number(m.peers) || 0 });
      return;
    }
    if (m.t === 'site' && m.btih === E.btih) {
      E.onSiblingSavedSite();
      return;
    }
    if (m.t === 'version') {
      E.log('another tab shows version ' + m.btih);
      return;
    }
    if (!E.isLeader || !E.node || E.node === E.followerNode) return;
    if (m.t === 'need-state' || m.t === 'leader') {
      broadcastState(E);
      return;
    }
    if (m.t === 'cancel') {
      const ctl = E.tabCalls ? E.tabCalls.get(m.from + ' ' + m.id) : null;
      if (ctl) ctl.abort();
      return;
    }
    if (m.t === 'call') {
      const node = E.node;
      // Code review round 1 (item 4): the follower hears the fee's progress and can cancel.
      if (!E.tabCalls) E.tabCalls = new Map();
      const key = m.from + ' ' + m.id;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      if (ctl) E.tabCalls.set(key, ctl);
      const opts = {
        signal: ctl ? ctl.signal : null,
        onProgress: (p) => { E.link.send('pow', { id: m.id, to: m.from, hashes: Number(p.hashes) || 0, bits: Number(p.bits) || 0 }); },
      };
      const args = m.args.slice(0, TAB_ARITY[m.method]);
      while (args.length < TAB_ARITY[m.method]) args.push(undefined);
      let reply;
      try {
        if (m.method === 'ban' && node.role !== 'owner' && node.role !== 'moderator') throw Object.assign(new Error('only moderators can ban'), { code: 'E_NOT_MODERATOR' });
        const block = await node[m.method](...args, opts);
        reply = { ok: true, result: block && block.h ? { h: block.h } : (typeof block === 'string' ? { h: block } : null) };
      } catch (err) {
        reply = { ok: false, error: { code: (err && err.code) || 'E_INTERNAL', message: msg(err) } };
      } finally {
        if (ctl && E.tabCalls.get(key) === ctl) E.tabCalls.delete(key);
      }
      E.link.send('result', Object.assign({ id: m.id, to: m.from }, reply));
    }
  });
}

export async function fetchSnapshot(E) {
  const cs = E.record && E.record.cs;
  if (!cs || !E.node || E.node === E.followerNode || typeof E.node.importSnapshot !== 'function') return 0;
  try {
    const url = new URL(cs, E.win.location.href).href;
    // Code review round 1: capped, with a timeout; gzip without DecompressionStream inflates in JS.
    const blocks = await readSnapshot({
      url,
      fetch: (u, init) => E.win.fetch(u, init),
      maxBytes: E.config.ledger.snapshotMaxBytes,
      maxInflatedBytes: E.config.ledger.snapshotMaxInflatedBytes || 2 * E.config.ledger.snapshotMaxBytes,
      timeoutMs: E.config.ledger.snapshotTimeoutMs || 30000,
      DecompressionStream: E.win.DecompressionStream, // lint-floor-ignore: optional, inflate.js otherwise
      Blob: E.win.Blob,
    });
    await E.node.importSnapshot(blocks);
    E.log('snapshot: ' + blocks.length + ' blocks offered');
    return blocks.length;
  } catch (err) {
    E.log('snapshot (cs=) failed: ' + msg(err));
    return 0;
  }
}

export async function closeLedger(E) {
  const node = E.node;
  E.node = null;
  E.followerNode = null;
  if (E.stateTimer !== null) {
    E.timers.clearTimeoutFn(E.stateTimer);
    E.stateTimer = null;
  }
  if (node && typeof node.close === 'function') {
    try {
      await node.close();
    } catch (_) { /* best effort */ }
  }
  if (E.nodeStore && typeof E.nodeStore.flush === 'function') {
    try {
      await E.nodeStore.flush();
    } catch (_) { /* best effort */ }
  }
  if (E.miner && typeof E.miner.destroy === 'function') {
    try {
      E.miner.destroy();
    } catch (_) { /* gone */ }
  }
  if (E.verifierPool && typeof E.verifierPool.destroy === 'function') {
    try {
      E.verifierPool.destroy();
    } catch (_) { /* gone */ }
  }
  E.miner = null;
  E.verifierPool = null;
  E.nodeStore = null;
}
