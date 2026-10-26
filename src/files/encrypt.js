// src/files/encrypt.js: STREAM records for F2 private files (R 2.8.1, MF-47, MF-56; INTERFACES "v0.3
// (proposed)" src/files/*). Pure apart from WebCrypto and ReadableStream; Node 22, browsers, workers.
//
// A private file is authenticated by its records, never by a plaintext digest. The plaintext stream is
//   uint64_be(length) || the file || zeros
// cut into records of RECORD_PAYLOAD (65,520) bytes, each sealed with AES-256-GCM into RECORD_BYTES
// (65,536) bytes, so the ciphertext is a whole number of 64 KiB pieces. The record count fills the
// size bucket of src/media/pad.js (MF-56). Record i uses
//   nonce_i = 0x00 * 7 || uint32_be(i) || last (0x01 on the final record, else 0x00)
//   AAD     = "mw-file-v1"
// (the STREAM construction: the counter orders the records and the last flag makes truncation and
// extension fail). The nonce prefix is constant because fk is 32 random bytes per file, never reused
// (a re-encryption draws a new fk).
//
//   streamPlan(length) -> { records, bytes }
//   encryptStream(readable, fk, { length }) -> ReadableStream<Uint8Array> of ciphertext
//   decryptStream(readable, fk) -> ReadableStream<Uint8Array> of the file; errors E_DECRYPT
//   decryptRecord(fk, i, last, record) / encryptRecord(fk, i, last, payload)

import { recordsFor } from '../media/pad.js';
import { utf8, asBytes } from '../chain/canonical.js';
import { importChunkKey, mediaError } from '../media/format.js';

export const RECORD_BYTES = 65536;
export const RECORD_PAYLOAD = RECORD_BYTES - 16;
export const HEADER_BYTES = 8;
export const AAD = 'mw-file-v1';
const AAD_BYTES = utf8.encode(AAD);

function subtle() {
  return globalThis.crypto.subtle;
}

/** streamPlan(length) -> { records, bytes }: the padded record count for a file of `length` bytes. */
export function streamPlan(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('streamPlan: length must be a non-negative safe integer');
  const needed = Math.ceil((length + HEADER_BYTES) / RECORD_PAYLOAD) * RECORD_BYTES;
  const records = recordsFor(needed, RECORD_BYTES);
  return { records, bytes: records * RECORD_BYTES };
}

function nonce(i, last) {
  const n = new Uint8Array(12);
  n[7] = (i >>> 24) & 255;
  n[8] = (i >>> 16) & 255;
  n[9] = (i >>> 8) & 255;
  n[10] = i & 255;
  n[11] = last ? 1 : 0;
  return n;
}

export async function encryptRecord(fk, i, last, payload) {
  const key = await importChunkKey(fk);
  const pt = asBytes(payload);
  if (pt.length !== RECORD_PAYLOAD) throw new RangeError('encryptRecord: the payload must be ' + RECORD_PAYLOAD + ' bytes');
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce(i, last), additionalData: AAD_BYTES, tagLength: 128 }, key, pt));
}

export async function decryptRecord(fk, i, last, record) {
  const key = await importChunkKey(fk);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce(i, last), additionalData: AAD_BYTES, tagLength: 128 }, key, asBytes(record)));
  } catch (_) {
    throw mediaError('E_DECRYPT', 'record ' + i + ' does not open');
  }
}

// Reads whole `size`-byte units from a ReadableStream of byte chunks (any chunking).
function unitReader(readable, size) {
  const reader = readable.getReader();
  let buf = new Uint8Array(0);
  let done = false;
  return {
    async next() {
      while (buf.length < size && !done) {
        const r = await reader.read();
        if (r.done) done = true;
        else {
          const v = asBytes(r.value);
          const nb = new Uint8Array(buf.length + v.length);
          nb.set(buf, 0);
          nb.set(v, buf.length);
          buf = nb;
        }
      }
      if (buf.length === 0) return null;
      const n = Math.min(size, buf.length);
      const unit = buf.slice(0, n);
      buf = buf.subarray(n);
      return unit;
    },
    cancel(reason) {
      try {
        reader.cancel(reason);
      } catch (_) { /* already closed */ }
    },
  };
}

/**
 * encryptStream(readable, fk, { length }) -> ReadableStream of RECORD_BYTES records. `length` is the
 * exact byte count the source will deliver (a mismatch errors the stream); it sets the padding.
 */
export async function encryptStream(readable, fk, { length } = {}) {
  const { records } = streamPlan(length);
  await importChunkKey(fk);
  const src = unitReader(readable, RECORD_PAYLOAD);
  let i = 0;
  let seen = 0;
  let carry = new Uint8Array(HEADER_BYTES); // the length header goes first
  const view = new DataView(carry.buffer);
  view.setUint32(0, Math.floor(length / 4294967296));
  view.setUint32(4, length >>> 0);
  let sourceDone = false;
  return new ReadableStream({
    async pull(controller) {
      if (i >= records) return controller.close();
      const payload = new Uint8Array(RECORD_PAYLOAD);
      payload.set(carry.subarray(0, RECORD_PAYLOAD), 0);
      let filled = Math.min(carry.length, RECORD_PAYLOAD);
      carry = carry.subarray(filled);
      while (filled < RECORD_PAYLOAD && !sourceDone) {
        const unit = await src.next();
        if (!unit) {
          sourceDone = true;
          break;
        }
        seen += unit.length;
        if (seen > length) throw mediaError('E_LIMIT', 'the file is longer than its declared length');
        const take = Math.min(unit.length, RECORD_PAYLOAD - filled);
        payload.set(unit.subarray(0, take), filled);
        filled += take;
        if (take < unit.length) carry = unit.slice(take);
      }
      if (sourceDone && seen !== length) throw mediaError('E_LIMIT', 'the file is shorter than its declared length');
      controller.enqueue(await encryptRecord(fk, i, i === records - 1, payload));
      i++;
    },
    cancel(reason) {
      src.cancel(reason);
    },
  });
}

/**
 * decryptStream(readable, fk) -> ReadableStream of the file's bytes. Any record that fails, a missing
 * final record, a record after the final one, a partial record or a record count that does not match
 * the length header errors the stream with E_DECRYPT.
 */
export async function decryptStream(readable, fk) {
  await importChunkKey(fk);
  const src = unitReader(readable, RECORD_BYTES);
  let i = 0;
  let pending = null;
  let remaining = -1;
  let expected = -1;
  let finished = false;
  const emit = (controller, pt) => {
    let body = pt;
    if (remaining < 0) {
      const v = new DataView(pt.buffer, pt.byteOffset, HEADER_BYTES);
      const len = v.getUint32(0) * 4294967296 + v.getUint32(4);
      if (!Number.isSafeInteger(len)) throw mediaError('E_DECRYPT', 'bad length header');
      remaining = len;
      expected = streamPlan(len).records;
      body = pt.subarray(HEADER_BYTES);
    }
    const n = Math.min(remaining, body.length);
    if (n > 0) controller.enqueue(body.slice(0, n));
    remaining -= n;
    return n > 0;
  };
  // One pull must enqueue or close: a pull that does neither is not called again (WHATWG Streams), so
  // the padding records, which yield no bytes, are consumed in a loop.
  const step = async (controller) => {
    if (pending === null) {
      pending = await src.next();
      if (pending === null) throw mediaError('E_DECRYPT', 'no records');
    }
    const next = await src.next();
    if (pending.length !== RECORD_BYTES) throw mediaError('E_DECRYPT', 'a partial record');
    const last = next === null;
    const pt = await decryptRecord(fk, i, last, pending);
    const enqueued = emit(controller, pt);
    i++;
    if (expected >= 0 && i > expected) throw mediaError('E_DECRYPT', 'more records than the length needs');
    if (last) {
      if (i !== expected) throw mediaError('E_DECRYPT', 'the record count does not match the length');
      finished = true;
      controller.close();
      return true;
    }
    pending = next;
    return enqueued;
  };
  return new ReadableStream({
    async pull(controller) {
      if (finished) return controller.close();
      while (!(await step(controller))) { /* a padding record: read the next one */ }
    },
    cancel(reason) {
      src.cancel(reason);
    },
  });
}
