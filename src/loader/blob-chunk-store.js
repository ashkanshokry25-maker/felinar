// Read-only abstract-chunk-store over a cached site (parsed .torrent + Map<path, Blob>), passed
// to WebTorrent as `preloadedStore` with `skipVerify: true` so a returning visitor seeds without
// re-hashing (ARCHITECTURE §3.4.6, §5.4). Every piece is SHA-1 verified on its first read and a
// piece that fails is refused (ARCHITECTURE §7.3, DESIGN-REVIEW item 9); verified indices are
// memoised in memory only. Pad files read as zeros. close/destroy release references only: the
// IndexedDB copy is owned by cache.js.

import { readPiece, readPieceRange, checkPiece, pieceSize } from './verify.js';

function later(cb, err, value) {
  queueMicrotask(() => cb(err, value));
}

function noop() {}

function verifyError(index) {
  const err = new Error('piece verification failed');
  err.code = 'E_VERIFY';
  err.index = index;
  return err;
}

export class BlobChunkStore {
  /**
   * @param {number} chunkLength must equal parsed.pieceLength
   * @param {{ parsed: object, blobs: Map<string, Blob>|Function, verify?: boolean, onVerifyFailed?: Function }} opts
   *   blobs may also be a function (path) → Blob | Promise<Blob>; onVerifyFailed(index) is called
   *   once per failed piece so the caller can deleteSite() and fall back to the network.
   */
  constructor(chunkLength, { parsed, blobs, verify = true, onVerifyFailed = null } = {}) {
    if (!parsed || !Array.isArray(parsed.files) || !(parsed.pieces instanceof Uint8Array)) {
      throw new TypeError('BlobChunkStore: opts.parsed must come from parseTorrentFile');
    }
    this.chunkLength = Number(chunkLength);
    if (this.chunkLength !== parsed.pieceLength) {
      throw new Error('BlobChunkStore: chunk length ' + chunkLength + ' differs from the piece length ' + parsed.pieceLength);
    }
    this.parsed = parsed;
    this.blobs = blobs;
    this.verify = verify !== false;
    this.onVerifyFailed = typeof onVerifyFailed === 'function' ? onVerifyFailed : null;
    this.length = parsed.length;
    this.lastChunkLength = parsed.lastPieceLength;
    this.lastChunkIndex = parsed.pieceCount - 1;
    this.verifiedPieces = new Set();
    this.failedPieces = new Set();
    this.closed = false;
    this._pending = new Map();
  }

  /** Writes are ignored: this store only serves bytes that are already cached. */
  put(index, buf, cb = noop) {
    later(cb, this.closed ? new Error('Storage is closed') : null);
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') return this.get(index, null, opts);
    if (typeof cb !== 'function') cb = noop;
    if (this.closed) return later(cb, new Error('Storage is closed'));
    if (!Number.isInteger(index) || index < 0 || index >= this.parsed.pieceCount) {
      const err = new Error('Chunk not found');
      err.notFound = true;
      return later(cb, err);
    }
    const size = pieceSize(this.parsed, index);
    const offset = (opts && opts.offset) || 0;
    const length = (opts && opts.length) || (size - offset); // 0 or absent = to the end
    if (offset < 0 || length < 0 || offset + length > size) {
      return later(cb, new Error('Range out of bounds for chunk ' + index));
    }
    this._read(index, offset, length).then(
      (bytes) => (this.closed ? cb(new Error('Storage is closed')) : cb(null, bytes)),
      (err) => cb(err),
    );
  }

  async _read(index, offset, length) {
    if (this.verify && !this.verifiedPieces.has(index)) {
      const piece = await this._verifiedPiece(index);
      return offset === 0 && length === piece.length ? piece : piece.slice(offset, offset + length);
    }
    return readPieceRange(this.parsed, this.blobs, index, offset, length);
  }

  _verifiedPiece(index) {
    if (this.failedPieces.has(index)) return Promise.reject(verifyError(index));
    let pending = this._pending.get(index);
    if (pending) return pending;
    pending = (async () => {
      const piece = await readPiece(this.parsed, this.blobs, index);
      if (!(await checkPiece(this.parsed, index, piece))) {
        if (!this.failedPieces.has(index)) {
          this.failedPieces.add(index);
          if (this.onVerifyFailed) {
            try {
              this.onVerifyFailed(index);
            } catch (_) { /* the caller's problem; the read still fails */ }
          }
        }
        throw verifyError(index);
      }
      this.verifiedPieces.add(index);
      return piece;
    })();
    this._pending.set(index, pending);
    const clear = () => {
      if (this._pending.get(index) === pending) this._pending.delete(index);
    };
    pending.then(clear, clear);
    return pending;
  }

  close(cb = noop) {
    if (this.closed) return later(cb, new Error('Storage is closed'));
    this.closed = true;
    this._pending.clear();
    this.blobs = null;
    later(cb, null);
  }

  destroy(cb = noop) {
    this.close(cb);
  }
}
