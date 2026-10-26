// What a loader does with a valid withdrawal (v0.2.1, DIGEST-AMENDMENTS A3; ARCHITECTURE §4, §5.8):
// stop serving and seeding the scope, delete EVERY stored version of it (not "keep the previous
// one": the previous version may be the one complained about), keep the withdrawal as the cached
// record, and show the owner's why= text. Shared by the shell loader (src/loader/app.js) and the
// drop-in engine (src/dropin/engine.js). Pure apart from the injected cache (src/loader/cache.js
// API: getPref, setPref, listSites, deleteSite); runs in Node and browsers.

import { normalizeBtih } from './magnet.js';
import { ZERO_BTIH } from './pointer.js';

const WHY_MAX = 200;

/**
 * purgeWithdrawn({ cache, ledgerId, btihs = [], all = false }) → Promise<{ deleted: string[], failed: string[] }>
 * Deletes the stored versions of a withdrawn scope: every btih in the pref `versions:<ledgerId>`,
 * every btih given (for example the record the withdrawal replaced), and with `all` every site
 * stored on this origin (shell, hub subdomain and drop-in origins hold one site; a key rotation
 * gives the withdrawal another ledger id than the version it removes). Clears `versions:<ledgerId>`.
 * Never throws; storage errors are listed in `failed`.
 */
export async function purgeWithdrawn({ cache, ledgerId = null, btihs = [], all = false } = {}) {
  const deleted = [];
  const failed = [];
  if (!cache || typeof cache.deleteSite !== 'function') return { deleted, failed };
  const targets = new Set();
  const add = (b) => {
    const n = normalizeBtih(typeof b === 'string' ? b : '');
    if (n && n !== ZERO_BTIH) targets.add(n);
  };
  for (const b of Array.isArray(btihs) ? btihs : []) add(b);
  if (ledgerId && typeof cache.getPref === 'function') {
    try {
      const versions = await cache.getPref('versions:' + ledgerId, []);
      if (Array.isArray(versions)) for (const b of versions) add(b);
    } catch (_) { /* no list */ }
  }
  if (all && typeof cache.listSites === 'function') {
    try {
      for (const site of (await cache.listSites()) || []) add(site && site.btih);
    } catch (_) { /* no IndexedDB */ }
  }
  for (const b of targets) {
    try {
      await cache.deleteSite(b);
      deleted.push(b);
    } catch (_) {
      failed.push(b);
    }
  }
  if (ledgerId && typeof cache.setPref === 'function') {
    try {
      await cache.setPref('versions:' + ledgerId, []);
    } catch (_) { /* best effort */ }
  }
  return { deleted, failed };
}

/**
 * withdrawalNotice(record) → { why, ct } safe to show: why is the owner's text (percent-decoded by
 * the parser) without control or format (Unicode Cf) characters, at most 200 characters, or null; ct is kept only as an
 * https: or mailto: URL (never a javascript: or other link), or null.
 */
export function withdrawalNotice(record) {
  const r = record && typeof record === 'object' ? record : {};
  // Review round R 5.3 (PTR-12): every format character (Unicode Cf: zero-width spaces and joiners, bidi marks and
  // embeddings, word joiner, soft hyphen, BOM) becomes a space like the controls, and runs of white space collapse.
  let why = typeof r.why === 'string'
    ? r.why.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\p{Cf}/gu, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (why.length > WHY_MAX) why = why.slice(0, WHY_MAX - 3) + '...';
  let ct = null;
  if (typeof r.ct === 'string' && r.ct) {
    try {
      const u = new URL(r.ct);
      if (u.protocol === 'https:' || u.protocol === 'mailto:') ct = u.href;
    } catch (_) { /* not a URL */ }
  }
  return { why: why || null, ct };
}
