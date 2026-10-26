// Local search (R 3.4): an in-browser index over what this browser holds (the followed windows, profiles seen, your own data).
// There is no global search in this design (R 3.6). Results are newest first, never ranked by anything else, and the index is
// capped (10 MiB on phones, chosen) by dropping the oldest documents first.

import { LIMITS } from './config.js';

/** words(text) -> lowercase tokens of letters and digits, at least one character long. */
export function words(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export class LocalIndex {
  constructor({ capBytes = LIMITS.searchIndexBytesPhone } = {}) {
    this.capBytes = capBytes;
    this.docs = new Map(); // id -> { doc, bytes, tokens: Set }
    this.postings = new Map(); // token -> Set of ids
    this._sorted = null;
    this.bytes = 0;
  }
  get size() { return this.docs.size; }
  has(id) { return this.docs.has(id); }

  /** add(doc): doc = { id, kind, text, ts, l?, h? }; an existing id is replaced. Returns the number of documents dropped to stay under the cap. */
  add(doc) {
    if (!doc || typeof doc.id !== 'string') return 0;
    this.remove(doc.id);
    const tokens = new Set(words(doc.text));
    const bytes = 2 * String(doc.text || '').length + 64 + 24 * tokens.size;
    this.docs.set(doc.id, { doc, bytes, tokens });
    for (const t of tokens) {
      if (!this.postings.has(t)) { this.postings.set(t, new Set()); this._sorted = null; }
      this.postings.get(t).add(doc.id);
    }
    this.bytes += bytes;
    return this._evict();
  }
  remove(id) {
    const e = this.docs.get(id);
    if (!e) return false;
    for (const t of e.tokens) {
      const set = this.postings.get(t);
      if (set) { set.delete(id); if (!set.size) { this.postings.delete(t); this._sorted = null; } }
    }
    this.bytes -= e.bytes;
    this.docs.delete(id);
    return true;
  }
  clear() { this.docs.clear(); this.postings.clear(); this._sorted = null; this.bytes = 0; }

  _evict() {
    if (this.bytes <= this.capBytes) return 0;
    const oldest = Array.from(this.docs.values()).sort((a, b) => (a.doc.ts || 0) - (b.doc.ts || 0));
    let dropped = 0;
    for (const e of oldest) {
      if (this.bytes <= this.capBytes) break;
      this.remove(e.doc.id);
      dropped++;
    }
    return dropped;
  }
  _tokensWithPrefix(prefix) {
    if (!this._sorted) this._sorted = Array.from(this.postings.keys()).sort();
    const arr = this._sorted;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < prefix) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < arr.length && arr[i].startsWith(prefix); i++) out.push(arr[i]);
    return out;
  }
  /** search(query, { limit }) -> documents that contain every word of the query (the last word may be a prefix), newest first. */
  search(query, { limit = 50, kind } = {}) {
    const qs = words(query);
    if (!qs.length) return [];
    let ids = null;
    qs.forEach((q, i) => {
      const exact = i < qs.length - 1;
      const hit = new Set();
      for (const t of exact ? (this.postings.has(q) ? [q] : []) : this._tokensWithPrefix(q)) for (const id of this.postings.get(t)) hit.add(id);
      ids = ids === null ? hit : new Set(Array.from(ids).filter((id) => hit.has(id)));
    });
    return Array.from(ids || [], (id) => this.docs.get(id).doc)
      .filter((d) => !kind || d.kind === kind)
      .sort((a, b) => ((b.ts || 0) - (a.ts || 0)) || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
}
