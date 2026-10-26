// mw_chat1 as a BEP 10 wire extension (R 2.7.1, MF-39). Registered through the seam the loader hardening
// lane adds to TorrentManager:
//   torrentManager.registerWireExtension('mw_chat1', { onWire(wire, swarmKind, { late }) }, { swarms: ['rendezvous', 'chat'] })
// so mw_chat1 rides the ledger rendezvous wires and the wires of the separate chat lane (joinLane kind 'chat'). A wire
// joins the ChatLane only after the remote's extended handshake advertises mw_chat1; webSeed wires are
// skipped; every message is size-checked (the 262,144-byte wire guard of src/loader/torrent.js applies
// before this) and handed to the lane, which strikes per wire. One wire is one lane peer: nothing is
// grouped by the self-declared peer id.
//
// Shared code: no Buffer, no node: imports.

import { EXT_NAME, FRAME_MAX, WIRE_AEAD_TAG } from './limits.js';

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

/**
 * chatExtension(lane, { name = 'mw_chat1', swarmKind = 'rendezvous' }) -> extension class for wire.use().
 */
export function chatExtension(lane, { name = EXT_NAME, swarmKind = 'rendezvous' } = {}) {
  class MwChatExtension {
    constructor(wire) {
      this.wire = wire;
      this.id = 'c' + (++nextId);
      this.skipped = !wire || wire.type === 'webSeed';
      this.ready = false;
      this.closed = false;
      this.early = 0;
      if (!this.skipped && typeof wire.once === 'function') wire.once('close', () => this.close());
    }

    onHandshake() {}

    onExtendedHandshake(handshake) {
      if (this.skipped || this.closed || this.ready || !advertises(handshake, name)) return;
      this.ready = true;
      const wire = this.wire;
      lane.attachWire({
        id: this.id,
        swarm: swarmKind,
        send: (u8) => {
          if (this.closed || wire.destroyed) return false;
          wire.extended(name, u8);
          return true;
        },
        close: () => {
          this.closed = true;
          try { wire.destroy(); } catch (_) { /* already closed */ }
        },
      });
    }

    onMessage(buf) {
      if (this.skipped || this.closed) return undefined;
      if (!this.ready) {
        this.early++;
        return undefined;
      }
      const bytes = toBytes(buf);
      if (!bytes) return undefined;
      if (bytes.length > FRAME_MAX + WIRE_AEAD_TAG) {
        lane.strike(this.id, 'too-large');
        return undefined;
      }
      try {
        const done = lane.onMessage(this.id, bytes);
        if (done && typeof done.then === 'function') return done.then(undefined, () => undefined);
      } catch (_) {
        // the lane never throws; a broken hook must not break the wire
      }
      return undefined;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.ready) lane.detachWire(this.id);
    }
  }
  MwChatExtension.prototype.name = name;
  return MwChatExtension;
}

/** Puts the extension on one wire (resends the extended handshake when it already went out). */
export function useOnWire(wire, lane, swarmKind = 'rendezvous', { late: lateHint = false } = {}) {
  if (!wire || typeof wire.use !== 'function' || wire.type === 'webSeed' || wire.destroyed) return false;
  const late = lateHint === true || wire._extendedHandshakeSent === true;
  try {
    wire.use(chatExtension(lane, { swarmKind }));
  } catch (_) {
    return false;
  }
  if (late && typeof wire._sendExtendedHandshake === 'function') {
    try { wire._sendExtendedHandshake(); } catch (_) { /* closing */ }
  }
  return true;
}

/**
 * registerChatWire(torrentManager, lane) -> unregister(). Uses the TorrentManager seam
 * registerWireExtension(name, { onWire(wire, swarmKind, { late }) }, { swarms: ['rendezvous', 'chat'] }). Throws
 * E_POLICY when the seam is missing.
 */
export function registerChatWire(torrentManager, lane) {
  if (!torrentManager || typeof torrentManager.registerWireExtension !== 'function') {
    throw Object.assign(new Error('this loader has no wire extension seam for chat'), { code: 'E_POLICY' });
  }
  const off = torrentManager.registerWireExtension(EXT_NAME, {
    onWire(wire, swarmKind, info) {
      useOnWire(wire, lane, swarmKind || 'rendezvous', info || {});
    },
  }, { swarms: ['rendezvous', 'chat'] });
  return typeof off === 'function' ? off : () => {
    if (typeof torrentManager.unregisterWireExtension === 'function') torrentManager.unregisterWireExtension(EXT_NAME);
  };
}
