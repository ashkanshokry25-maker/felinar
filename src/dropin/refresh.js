// src/dropin/refresh.js: a new version's copy must not be filled with stale HTTP-cache entries
// (ARCHITECTURE §3.4.5, §3.4.7). The host is the web seed through the Service Worker, which reads
// /<path> with cache 'force-cache': a stale cached entry of a file that CHANGED in the new deploy
// (an un-hashed name such as /data.json, kept in the HTTP cache from an earlier visit) would be
// served as is, fail the piece hash, and the download would stall. Hashed names never have this
// problem, and a first visit has nothing stale. So, when an earlier version of the site is stored,
// the files whose SHA-256 differs between the two versions (and the routing manifest) are fetched
// once with cache 'reload' before the download starts; that replaces the stale entries, and the
// web seed then finds fresh ones.
//
//   parseFileList(json) → Map<path, { length, sha256 }> | null      /.mw/files.json of a version
//   changedPaths(oldList, newList) → string[]                        paths to refresh, sorted
//   refreshHttpCache({ fetchFn, origin, paths, ... }) → { refreshed, failed, skipped }

import { encodePath } from '../sw/lib.js';

export const FILE_LIST_PATH = '.mw/files.json';
export const SITE_MANIFEST_PATH = '.mw/site.json';

/** parseFileList(value) → Map(path → { length, sha256 }), or null when value is not a file list. */
export function parseFileList(value) {
  const list = value && typeof value === 'object' && Array.isArray(value.files) ? value.files : null;
  if (!list) return null;
  const map = new Map();
  for (const f of list) {
    if (!f || typeof f.path !== 'string' || !f.path || typeof f.sha256 !== 'string') continue;
    map.set(f.path, { length: Number(f.length) || 0, sha256: f.sha256.toLowerCase() });
  }
  return map;
}

/**
 * changedPaths(oldList, newList) → the site files of the new version that are not byte-identical
 * to the old version's (new paths, or another SHA-256 or length), without /.mw/ entries, sorted.
 */
export function changedPaths(oldList, newList) {
  const out = [];
  if (!(newList instanceof Map)) return out;
  for (const [path, v] of newList) {
    if (path.indexOf('.mw/') === 0) continue;
    const o = oldList instanceof Map ? oldList.get(path) : null;
    if (!o || o.sha256 !== v.sha256 || o.length !== v.length) out.push(path);
  }
  return out.sort();
}

/** The same-origin URL of a site file (each segment percent-encoded). */
export function siteFileUrl(origin, path) {
  return String(origin).replace(/\/+$/, '') + '/' + encodePath(path).replace(/^\/+/, '');
}

/**
 * refreshHttpCache({ fetchFn, origin, paths, concurrency, timeoutMs, maxFiles, setTimeoutFn, clearTimeoutFn })
 *   → Promise<{ refreshed: number, failed: string[], skipped: number }>
 * Fetches each path with { cache: 'reload' } and reads the body to the end (that is what stores the
 * fresh entry). A failure is recorded and never thrown: the download still runs, and a piece that
 * does not verify is then the web seed's problem, as it was before.
 */
export async function refreshHttpCache({ fetchFn, origin, paths, concurrency = 4, timeoutMs = 15000, maxFiles = 400, setTimeoutFn = null, clearTimeoutFn = null } = {}) {
  const setT = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const clearT = clearTimeoutFn || ((t) => clearTimeout(t));
  const list = Array.isArray(paths) ? paths.slice(0, maxFiles) : [];
  const out = { refreshed: 0, failed: [], skipped: Array.isArray(paths) ? Math.max(0, paths.length - list.length) : 0 };
  let next = 0;
  async function one(path) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setT(() => { try { ctl.abort(); } catch (_) { /* done */ } }, timeoutMs) : null;
    try {
      const res = await fetchFn(siteFileUrl(origin, path), { cache: 'reload', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined });
      if (!res || !res.ok) {
        out.failed.push(path);
        return;
      }
      await res.arrayBuffer();
      out.refreshed++;
    } catch (_) {
      out.failed.push(path);
    } finally {
      if (timer !== null) clearT(timer);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.max(1, Math.min(concurrency, list.length)); w++) {
    workers.push((async () => {
      while (next < list.length) await one(list[next++]);
    })());
  }
  await Promise.all(workers);
  return out;
}
