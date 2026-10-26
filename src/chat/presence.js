// Presence (R 2.7.6, D-C4, MF-34). Off by default. When on, one fixed-size PRES frame goes to each direct
// neighbour every 30 s while the page is visible ("away" when hidden, nothing from hidden tabs):
//   body = mode (1: 0 contacts, 1 public) | 8 slots x 8 bytes | status (1: 1 online, 2 away) | auth (64)
//   contacts slot  HMAC(K_pair, "pres|" + day)[:8] of that neighbour when it is a contact, else random
//   contacts auth  8 x 8 bytes: HMAC(K_pair, "pres-mac|" + day + "|" + hex(slot) + "|" + status)[:8] per real
//                  slot, random bytes for the padding slots
//   public         one slot carries the person's own id SHA-256(utf8(sitePub))[:8]; auth is an ECDSA
//                  signature by the site key over "mw-pres-v1\n" + hex(slots) + "|" + status (deviation D-5)
// The list is "Connected to you now" (never "online"): presence reaches direct neighbours only.
//
// Shared code: no Buffer, no node: imports.

import { utf8, hex, concatBytes } from '../chain/canonical.js';
import { sha256, verify } from '../chain/crypto.js';
import { presenceId, hmac, secureRandom } from './tags.js';
import { equalBytes } from './seal.js';
import { PRES_SLOTS, PRES_SLOT_BYTES, PRES_AUTH_BYTES, PRES_LABEL, PRES_PREFIX, PRES_INTERVAL_MS } from './limits.js';

export { PRES_LABEL };
export const PRES_TTL_MS = 3 * PRES_INTERVAL_MS;

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function slotMac(kPair, day, slot, status) {
  return (await hmac(kPair, 'pres-mac|' + day + '|' + hex.encode(slot) + '|' + status)).slice(0, PRES_SLOT_BYTES);
}

/** The person's own public presence id. */
export async function ownId(sitePub) {
  return (await sha256(utf8.encode(sitePub))).slice(0, PRES_SLOT_BYTES);
}

function publicSigningBytes(slots, status) {
  return utf8.encode(PRES_PREFIX + hex.encode(concatBytes(...slots)) + '|' + status);
}

/**
 * presFields({ day, status, kPair?, publicSigner?: { pub, sign }, random? }) -> { mode, slots, status, auth }.
 * kPair: the pair key with this neighbour when it is a contact (else null). publicSigner: public presence.
 */
export async function presFields({ day, status, kPair = null, publicSigner = null, random = secureRandom }) {
  const slots = [];
  for (let i = 0; i < PRES_SLOTS; i++) slots.push(randomBytes(PRES_SLOT_BYTES));
  const realAt = Math.floor(random() * PRES_SLOTS);
  if (publicSigner) {
    slots[realAt] = await ownId(publicSigner.pub);
    if (kPair) slots[(realAt + 1 + Math.floor(random() * (PRES_SLOTS - 1))) % PRES_SLOTS] = await presenceId(kPair, day);
    const auth = await publicSigner.sign(publicSigningBytes(slots, status));
    return { mode: 1, slots, status, auth };
  }
  const auth = randomBytes(PRES_AUTH_BYTES);
  if (kPair) {
    slots[realAt] = await presenceId(kPair, day);
    auth.set(await slotMac(kPair, day, slots[realAt], status), realAt * PRES_SLOT_BYTES);
  }
  return { mode: 0, slots, status, auth };
}

/**
 * readPres(fields, { day, kPair?, signerPub? }) -> { contact: boolean, public: boolean, status } | null.
 * kPair: our pair key with the neighbour that sent it (when it is a contact). signerPub: the neighbour's
 * site key (from its CK) for public presence. null when nothing verifies.
 */
export async function readPres(fields, { day, kPair = null, signerPub = null }) {
  if (!fields || !Array.isArray(fields.slots)) return null;
  if (fields.mode === 1) {
    if (!signerPub) return null;
    const own = await ownId(signerPub);
    if (!fields.slots.some((s) => equalBytes(s, own))) return null;
    const ok = await verify(signerPub, publicSigningBytes(fields.slots, fields.status), fields.auth);
    if (!ok) return null;
    let contact = false;
    if (kPair) {
      const id = await presenceId(kPair, day);
      contact = fields.slots.some((s) => equalBytes(s, id));
    }
    return { contact, public: true, status: fields.status };
  }
  if (!kPair) return null;
  const id = await presenceId(kPair, day);
  for (let i = 0; i < PRES_SLOTS; i++) {
    if (!equalBytes(fields.slots[i], id)) continue;
    const mac = await slotMac(kPair, day, id, fields.status);
    if (equalBytes(mac, fields.auth.subarray(i * PRES_SLOT_BYTES, (i + 1) * PRES_SLOT_BYTES))) {
      return { contact: true, public: false, status: fields.status };
    }
  }
  return null;
}

/** The "Connected to you now" list: entries expire after three missed intervals or when the wire closes. */
export class PresenceBook {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map(); // pub -> { pub, status, since, seen, wire }
  }

  update(pub, status, wire) {
    const prev = this.entries.get(pub);
    const t = this.now();
    this.entries.set(pub, { pub, status, since: prev && prev.status === status ? prev.since : t, seen: t, wire });
    return !prev || prev.status !== status;
  }

  dropWire(wire) {
    let changed = false;
    for (const [k, e] of this.entries) if (e.wire === wire) {
      this.entries.delete(k);
      changed = true;
    }
    return changed;
  }

  list() {
    const t = this.now();
    const out = [];
    for (const [k, e] of this.entries) {
      if (t - e.seen > PRES_TTL_MS) {
        this.entries.delete(k);
        continue;
      }
      out.push({ pub: e.pub, status: e.status === 2 ? 'away' : 'online', since: e.since });
    }
    return out;
  }

  clear() {
    this.entries.clear();
  }
}
