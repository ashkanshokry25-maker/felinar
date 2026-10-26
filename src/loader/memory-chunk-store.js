// In-memory abstract-chunk-store for WebTorrent downloads (DESIGN-REVIEW item 18): never use
// WebTorrent's default browser store (fsa-chunk-store deletes the origin's OPFS `chunks`
// directory on import and spawns a Worker per write on older Safari). Callback API as used by
// WebTorrent 3 (put/get/close/destroy, chunkLength, length); the last chunk may be shorter.

function later(cb, err, value) {
  queueMicrotask(() => cb(err, value));
}

function noop() {}

function asBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}

export class MemoryChunkStore {
  /**
   * @param {number} chunkLength piece length
   * @param {{ length?: number }} opts total torrent length (WebTorrent passes it with more keys we ignore)
   */
  constructor(chunkLength, opts = {}) {
    this.chunkLength = Number(chunkLength);
    if (!Number.isSafeInteger(this.chunkLength) || this.chunkLength <= 0) {
      throw new Error('First argument must be a chunk length');
    }
    const length = opts && opts.length !== undefined && opts.length !== null ? Number(opts.length) : Infinity;
    this.length = Number.isSafeInteger(length) && length >= 0 ? length : Infinity;
    this.chunks = [];
    this.closed = false;
    if (this.length !== Infinity) {
      this.lastChunkLength = (this.length % this.chunkLength) || this.chunkLength;
      this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1;
    } else {
      this.lastChunkLength = undefined;
      this.lastChunkIndex = undefined;
    }
  }

  put(index, buf, cb = noop) {
    if (this.closed) return later(cb, new Error('Storage is closed'));
    if (!Number.isInteger(index) || index < 0 ||
      (this.lastChunkIndex !== undefined && index > this.lastChunkIndex)) {
      return later(cb, new Error('Chunk index out of range: ' + index));
    }
    const bytes = asBytes(buf);
    if (!bytes) return later(cb, new Error('Chunk must be a Uint8Array'));
    const isLast = index === this.lastChunkIndex;
    if (isLast && bytes.length !== this.lastChunkLength) {
      return later(cb, new Error('Last chunk length must be ' + this.lastChunkLength));
    }
    if (!isLast && bytes.length !== this.chunkLength) {
      return later(cb, new Error('Chunk length must be ' + this.chunkLength));
    }
    this.chunks[index] = bytes;
    later(cb, null);
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') return this.get(index, null, opts);
    if (typeof cb !== 'function') cb = noop;
    if (this.closed) return later(cb, new Error('Storage is closed'));
    const buf = this.chunks[index];
    if (!buf) {
      const err = new Error('Chunk not found');
      err.notFound = true;
      return later(cb, err);
    }
    const offset = (opts && opts.offset) || 0;
    const length = (opts && opts.length) || (buf.length - offset); // 0 or absent = to the end
    if (offset < 0 || length < 0 || offset + length > buf.length) {
      return later(cb, new Error('Range out of bounds for chunk ' + index));
    }
    later(cb, null, offset === 0 && length === buf.length ? buf : buf.subarray(offset, offset + length));
  }

  close(cb = noop) {
    if (this.closed) return later(cb, new Error('Storage is closed'));
    this.closed = true;
    this.chunks = null;
    later(cb, null);
  }

  destroy(cb = noop) {
    this.close(cb);
  }
}
