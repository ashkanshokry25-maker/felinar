// BitTorrent wire adapter for ledger gossip (ARCHITECTURE 1 and 6.6; DESIGN-REVIEW S1, S9; v0.3 MF-74).
//
// The ledger rides on BEP 10 extension 'mw_chain1' of every wire of a torrent: the site torrent
// and the anchor torrent (S1) alike, since attachToTorrent() only needs the Torrent's 'wire' events
// and its `wires` array. The hub follow lane (multi.js) registers 'mw_chain2' the same way, with a
// MultiGossip in place of the Gossip (any object with attach, detach and handle). Rules:
//   - register synchronously from the 'wire' event (WebTorrent emits it before the extended
//     handshake goes out, so the extension is advertised), and also walk torrent.wires;
//   - skip webSeed wires (HTTP, no extension protocol);
//   - a wire joins the gossip only once the peer's extended handshake advertises the extension;
//     messages that arrive before that are ignored and counted;
//   - detach on wire close; the gossip may detach a peer itself (another (site, owner) or protocol
//     version in HELLO), after which that peer's messages are ignored.
// One wire, one gossip peer, everything counted by wire (code review round 1; v0.3 MF-74). WebTorrent
// uses one peer id per client, and with the rendezvous swarm a visitor usually reaches us over two
// wires (site swarm and rendezvous swarm). The wires used to be grouped by the remote's self-declared
// peer id, which nothing checks against the tracker-level one: a swarm member that claimed a visitor's
// id received frames meant for that visitor and could get the shared link dropped (a mismatched HELLO,
// 50 invalid frames), eclipsing the honest visitor's gossip. Now every wire is its own gossip peer:
// frames, strikes, budgets and detach are per wire, and the remote peer id is only the `group` the
// peer counts use ("in sync with N peers" counts visitors, not wires) and that the gossip caps (at most
// maxPeersPerGroup wires per claimed id). The cost: HELLO and ANN may reach a visitor once per wire.
// v0.3 hooks to the loader (MF-74; all optional, the loader's TorrentManager provides them):
//   - the gossip ignores a wire's peer (invalid frames, silent, over its group's cap): ignoreWire(wire,
//     reason), or else the wire is flagged wire.__mwIgnored = true, which the loader's periodic check
//     closes; the handler drops everything from it from then on;
//   - the peer delivered its first valid block: anchorWire(wire) (else wire.__mwAnchored = true);
//   - the peer is in sync with us: noteProgress(kind) (kind defaults to 'rendezvous').
// A wire found in torrent.wires has usually sent its extended handshake already, without our
// extension. BEP 10 allows a later handshake whose `m` is additive, and bittorrent-protocol merges
// it, so the adapter registers the extension and sends the handshake again (resendHandshake: false
// turns that off). A handler stays on its wire for the wire's life (bittorrent-protocol has no way
// to remove an extension); after detach() it is unbound, and a later attach (a reopened ledger)
// binds it to the new gossip. A wire carries one handler per extension name.

export const EXT_NAME = 'mw_chain1';

const HANDLERS = new WeakMap(); // wire -> Map(extension name -> handler), whichever gossip created it
const LINKS = new WeakMap(); // gossip -> Map(remote key -> Link)
const COUNTS = new WeakMap(); // gossip -> { wires, attached, early, ignored, refused }
let nextId = 0;

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (buf && ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}

function advertises(handshake, name) {
  const m = handshake && handshake.m;
  return !!(m && typeof m === 'object' && m[name] !== undefined && m[name] !== null && Number(m[name]) > 0);
}

function countsOf(gossip) {
  let c = COUNTS.get(gossip);
  if (!c) {
    c = { wires: 0, attached: 0, early: 0, ignored: 0, refused: 0 };
    COUNTS.set(gossip, c);
  }
  return c;
}

/**
 * wireCounts(gossip) -> { wires, attached, early, ignored, refused }: counted by wire (MF-74). wires:
 * handlers bound to this gossip; attached: wires registered as gossip peers; early: messages ignored
 * before the extended handshake; ignored: wires the gossip ignored; refused: wires the gossip refused.
 */
export function wireCounts(gossip) {
  const c = countsOf(gossip);
  return { wires: c.wires, attached: c.attached, early: c.early, ignored: c.ignored, refused: c.refused };
}

// The wire behind one gossip peer, seen by one gossip.
class Link {
  constructor(gossip, key) {
    this.gossip = gossip;
    this.key = key;
    this.id = 'w' + (++nextId) + ':' + key.slice(0, 8);
    this.handlers = [];
    this.attached = false; // registered with the gossip as peer `id`
    this.dropped = false; // the gossip detached or ignored it: ignore it from now on
    this.closing = false; // we are detaching it ourselves
  }

  send(u8) {
    for (const h of this.handlers) if (h._sendRaw(u8)) return true;
    return false;
  }
}

function linkFor(gossip, key) {
  let links = LINKS.get(gossip);
  if (!links) {
    links = new Map();
    LINKS.set(gossip, links);
  }
  let link = links.get(key);
  if (!link) {
    link = new Link(gossip, key);
    links.set(key, link);
  }
  return link;
}

function forgetLink(link) {
  const links = LINKS.get(link.gossip);
  if (links && links.get(link.key) === link) links.delete(link.key);
}

function setHandler(wire, name, handler) {
  let byName = HANDLERS.get(wire);
  if (!byName) {
    byName = new Map();
    HANDLERS.set(wire, byName);
  }
  byName.set(name, handler);
}

function getHandler(wire, name) {
  const byName = wire && typeof wire === 'object' ? HANDLERS.get(wire) : null;
  return byName ? byName.get(name) || null : null;
}

/**
 * makeWireExtension(gossip, { name = 'mw_chain1', hooks }) -> extension class for wire.use(); its
 * prototype.name is `name`. Instances register with `gossip` (as one peer { id, send, close, group,
 * ignored, delivered, synced } per wire) once the remote side has advertised the extension. hooks:
 * { ignoreWire(wire, reason), anchorWire(wire), noteProgress(kind), kind } (see the header).
 */
export function makeWireExtension(gossip, { name = EXT_NAME, hooks = null } = {}) {
  const H = hooks || {};
  class MwChainExtension {
    constructor(wire) {
      this.wire = wire;
      this.extName = name;
      this.gossip = gossip;
      this.hooks = H;
      this.uniqueKey = 'wire' + (++nextId); // every wire is its own gossip peer
      this.skipped = !wire || wire.type === 'webSeed';
      this.ready = false; // the remote advertised the extension in its extended handshake
      this.closed = false;
      this.ignoredReason = null; // set when the gossip ignored or refused this wire
      this.early = 0; // messages ignored because they came before the extended handshake
      this.link = null;
      if (wire && typeof wire === 'object') setHandler(wire, name, this);
      if (!this.skipped && gossip) countsOf(gossip).wires++;
      if (!this.skipped && typeof wire.once === 'function') wire.once('close', () => this.close());
    }

    /** Registered with the gossip (through its link) and not refused by it. */
    get attached() {
      return !!this.link && this.link.attached && !this.link.dropped;
    }

    /** The gossip detached or ignored this wire (another (site, owner), protocol version, strikes). */
    get dropped() {
      return !!this.link && this.link.dropped;
    }

    /** The gossip peer id of this wire (null until attached). */
    get peerId() {
      return this.link ? this.link.id : null;
    }

    onHandshake() {}

    onExtendedHandshake(handshake) {
      if (this.skipped || this.closed || !advertises(handshake, this.extName)) return;
      this.ready = true;
      this._attach();
    }

    // Returns a promise that settles when the gossip has processed the frame and never rejects
    // (bittorrent-protocol ignores the return value; test harnesses on a virtual clock await it).
    onMessage(buf) {
      if (this.skipped || this.closed) return undefined;
      if (!this.ready) {
        this.early++;
        if (this.gossip) countsOf(this.gossip).early++;
        return undefined;
      }
      const link = this.link;
      if (!link || !link.attached || link.dropped || !this.gossip || this.ignoredReason !== null) return undefined;
      const bytes = toBytes(buf);
      if (!bytes) return undefined;
      try {
        const done = this.gossip.handle(link.id, bytes);
        if (done && typeof done.then === 'function') return done.then(undefined, () => undefined);
      } catch (_) {
        // the gossip never throws; a broken hook must not break the wire
      }
      return undefined;
    }

    _attach() {
      if (this.link || this.closed || !this.ready || !this.gossip || this.skipped || this.ignoredReason !== null) return;
      if (this.wire.destroyed) return;
      const remote = this.wire.peerId;
      // Keyed by this wire alone; the remote peer id only groups the counts and the cap (see the header).
      const link = linkFor(this.gossip, this.uniqueKey);
      this.link = link;
      link.handlers.push(this);
      if (link.attached || link.dropped) return;
      link.attached = true;
      const counts = countsOf(this.gossip);
      counts.attached++;
      const ok = this.gossip.attach({
        id: link.id,
        group: typeof remote === 'string' && remote.length > 0 ? 'p:' + remote : link.id,
        send: (u8) => link.send(u8),
        close: () => {
          if (link.attached) counts.attached--;
          link.attached = false;
          if (!link.closing) link.dropped = true; // detached by the gossip: ignore this wire
        },
        ignored: (reason) => this._ignored(reason),
        delivered: () => this._delivered(),
        synced: () => this._synced(),
      });
      if (ok === false && link.attached) {
        // Refused (the remote's claimed id already has its share of wires): the wire keeps no slot.
        link.attached = false;
        link.dropped = true;
        counts.attached--;
        counts.refused++;
      }
    }

    // The gossip ignores (or refused) this wire's peer: the loader closes the wire (MF-74).
    _ignored(reason) {
      if (this.ignoredReason !== null) return;
      this.ignoredReason = String(reason || 'ignored');
      if (this.gossip) countsOf(this.gossip).ignored++;
      if (this.link) this.link.dropped = true;
      const wire = this.wire;
      if (typeof this.hooks.ignoreWire === 'function') {
        try {
          this.hooks.ignoreWire(wire, this.ignoredReason);
          return;
        } catch (_) {
          // fall back to the flag
        }
      }
      try {
        wire.__mwIgnored = true;
      } catch (_) {
        // a frozen wire object: the loader's idle close takes it
      }
    }

    _delivered() {
      const wire = this.wire;
      if (typeof this.hooks.anchorWire === 'function') {
        try {
          this.hooks.anchorWire(wire);
          return;
        } catch (_) {
          // fall back to the flag
        }
      }
      try {
        wire.__mwAnchored = true;
      } catch (_) {
        // ignore
      }
    }

    _synced() {
      if (typeof this.hooks.noteProgress === 'function') {
        try {
          this.hooks.noteProgress(this.hooks.kind || 'rendezvous');
        } catch (_) {
          // advisory
        }
      }
    }

    _sendRaw(u8) {
      if (this.closed || !this.ready || this.wire.destroyed) return false;
      try {
        this.wire.extended(this.extName, u8);
        return true;
      } catch (_) {
        return false;
      }
    }

    // Leaves the link; the wire's link detaches it from the gossip.
    _leave() {
      const link = this.link;
      if (!link) return;
      this.link = null;
      const at = link.handlers.indexOf(this);
      if (at >= 0) link.handlers.splice(at, 1);
      if (link.handlers.length > 0) return;
      forgetLink(link);
      if (link.attached) {
        link.closing = true;
        try {
          link.gossip.detach(link.id);
        } catch (_) {
          // gossip already destroyed
        }
        if (link.attached) {
          link.attached = false;
          countsOf(link.gossip).attached--;
        }
      }
    }

    /** Moves the handler to another gossip (or none). */
    bind(next) {
      if (next === this.gossip) {
        if (!this.link) this._attach();
        return;
      }
      this._leave();
      if (this.gossip && !this.skipped && !this.closed) countsOf(this.gossip).wires--;
      this.gossip = next || null;
      if (this.gossip && !this.skipped && !this.closed) countsOf(this.gossip).wires++;
      if (this.gossip) this._attach();
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this._leave();
      if (this.gossip && !this.skipped) countsOf(this.gossip).wires--;
    }
  }
  MwChainExtension.prototype.name = name;
  return MwChainExtension;
}

/**
 * handlerFor(wire, name = 'mw_chain1') -> the handler registered on a wire for that extension by any
 * gossip, or null (tests, diagnostics). Without a name: the mw_chain1 handler, else any handler.
 */
export function handlerFor(wire, name) {
  if (typeof name === 'string') return getHandler(wire, name);
  const byName = wire && typeof wire === 'object' ? HANDLERS.get(wire) : null;
  if (!byName) return null;
  return byName.get(EXT_NAME) || byName.values().next().value || null;
}

/**
 * attachToTorrent(torrent, gossip, { name, resendHandshake = true, ignoreWire, anchorWire, noteProgress, kind })
 * -> detach(). Works for any WebTorrent Torrent, including the one-piece anchor torrent (S1) and the hub
 * lane torrent (name 'mw_chain2', a MultiGossip).
 */
export function attachToTorrent(torrent, gossip, { name = EXT_NAME, resendHandshake = true, ignoreWire = null, anchorWire = null, noteProgress = null, kind = null } = {}) {
  if (!torrent || typeof torrent.on !== 'function') throw new TypeError('attachToTorrent expects a torrent');
  const hooks = { ignoreWire, anchorWire, noteProgress, kind };
  const Ext = makeWireExtension(gossip, { name, hooks });
  const handlers = new Set();
  let detached = false;

  function attachWire(wire) {
    if (detached || !wire || typeof wire !== 'object' || wire.type === 'webSeed' || wire.destroyed) return;
    const existing = getHandler(wire, name);
    if (existing) {
      existing.hooks = hooks;
      existing.bind(gossip);
      handlers.add(existing);
      return;
    }
    if (typeof wire.use !== 'function') return;
    const lateHandshake = wire._extendedHandshakeSent === true;
    try {
      wire.use(Ext);
    } catch (_) {
      return;
    }
    const handler = getHandler(wire, name);
    if (!handler) return;
    handlers.add(handler);
    if (lateHandshake) {
      if (resendHandshake && typeof wire._sendExtendedHandshake === 'function') {
        try {
          wire._sendExtendedHandshake();
        } catch (_) {
          // the wire is closing
        }
      }
      // The remote may have advertised the extension before we registered.
      const mapping = wire.peerExtendedMapping;
      if (mapping && mapping[name]) handler.onExtendedHandshake({ m: { [name]: mapping[name] } });
    }
  }

  const onWire = (wire) => attachWire(wire);
  torrent.on('wire', onWire);
  const existing = Array.isArray(torrent.wires) ? torrent.wires.slice() : [];
  for (const wire of existing) attachWire(wire);

  return function detach() {
    if (detached) return;
    detached = true;
    if (typeof torrent.removeListener === 'function') torrent.removeListener('wire', onWire);
    else if (typeof torrent.off === 'function') torrent.off('wire', onWire);
    for (const h of handlers) if (h.gossip === gossip) h.bind(null);
    handlers.clear();
  };
}
