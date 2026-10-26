// Reference routing function for a Service Worker that serves a static export (research spike for w2a-09).
// Pure: no SW globals, no I/O. `hasFile(path)` is synchronous and takes a decoded path WITHOUT a leading slash.
//
// Manifest fields (all optional; the defaults describe the "lenient superset" profile recommended in the report):
//   cleanUrls       true   serve "/about" from "about.html"                          (Vercel cleanUrls, Netlify Pretty URLs, Cloudflare)
//   canonicalUrls   false  redirect "/about.html" -> "/about" and "/dir/index.html" -> "/dir/" instead of serving in place
//                          (Vercel cleanUrls:true, Cloudflare Pages)
//   trailingSlash   null   null = only the redirects needed for correct relative URLs; true = force "/x/" for pages; false = drop it
//                          (Vercel trailingSlash, Cloudflare html_handling force-/drop-trailing-slash)
//   index           "index.html"
//   notFound        "nearest" | "root" | null   nearest-ancestor 404.html (Cloudflare Pages, Workers 404-page) | only /404.html (GitHub Pages, Netlify)
//   spa             false | "/index.html"       navigation-only fallback answered with 200 (Cloudflare single-page-application, Angular, Workbox)
//   redirectStatus  308    status used for automatic canonical redirects
//   redirects       compiled rules from parse-redirects.mjs ({from,to,status,force,query,alwaysApplies})
//
// Result: { kind: 'file'|'redirect'|'status-page'|'spa'|'not-found', status, file?, location?, via }

import { matchRedirect } from './parse-redirects.mjs';

const DEFAULTS = Object.freeze({
  cleanUrls: true, canonicalUrls: false, trailingSlash: null, index: 'index.html',
  notFound: 'nearest', spa: false, redirectStatus: 308, redirects: [],
});

// Same rule as src/sw/lib.js extOf(): a dot that is neither the first nor the last character of the last segment.
export function hasExt(seg) {
  const i = seg.lastIndexOf('.');
  return i > 0 && i < seg.length - 1;
}
const lastSeg = (p) => p.replace(/\/+$/, '').split('/').pop();

function decodePath(pathname) {
  try { return pathname.split('/').map((s) => decodeURIComponent(s)).join('/'); } catch { return pathname; }
}

export function applyRouting(manifest, req, hasFile) {
  const cfg = { ...DEFAULTS, ...manifest };
  const search = req.search || '';
  const path = decodePath(req.pathname);
  if (path.split('/').includes('..') || path.includes('\0')) return { kind: 'not-found', status: 400, via: 'bad-path' };

  const redirect = (to, status = cfg.redirectStatus, via = 'canonical') => ({ kind: 'redirect', status, location: to + (to.includes('?') ? '' : search), via });
  const file = (f, via) => ({ kind: 'file', status: 200, file: f, via });
  const ctx = { cfg, hasFile, redirect, file };

  const fromRule = (r, via) => {
    if (r.status === 200) {                       // rewrite: the URL stays, the content comes from another path
      const target = decodePath(new URL(r.to, 'http://x').pathname);
      const s = resolveStatic(ctx, target, true);
      return s && s.kind === 'file' ? { ...s, via } : notFoundPage(cfg, target, hasFile, via);
    }
    if ([404, 410, 451].includes(r.status)) {     // status page: serve that file with that status
      const f = decodePath(new URL(r.to, 'http://x').pathname).slice(1);
      return { kind: 'status-page', status: r.status, file: hasFile(f) ? f : null, via };
    }
    return { kind: 'redirect', status: r.status, location: r.to, via };
  };

  // 1. rules that apply even when a file exists: Netlify "!" and every Cloudflare-flavoured rule
  for (let i = 0; i < cfg.redirects.length; i++) {
    const r = cfg.redirects[i];
    if (!(r.force || r.alwaysApplies)) continue;
    const m = matchRedirect(r, req.pathname, search);
    if (m) return fromRule({ ...r, to: m.to }, `rule#${i} (forced)`);
  }

  // 2. the static tree
  const s = resolveStatic(ctx, path, false);
  if (s) return s;

  // 3. ordinary rules apply only to paths that did not resolve (Netlify default, IPFS "No Forced Redirects")
  for (let i = 0; i < cfg.redirects.length; i++) {
    const r = cfg.redirects[i];
    if (r.force || r.alwaysApplies) continue;
    const m = matchRedirect(r, req.pathname, search);
    if (m) return fromRule({ ...r, to: m.to }, `rule#${i}`);
  }

  // 4. SPA fallback: navigations only, and never for a URL whose last segment has a file extension
  if (cfg.spa && req.navigation && !hasExt(lastSeg(path))) {
    const f = cfg.spa.replace(/^\//, '');
    if (hasFile(f)) return { kind: 'spa', status: 200, file: f, via: 'spa' };
  }

  // 5. 404
  return notFoundPage(cfg, path, hasFile, 'miss');
}

function resolveStatic({ cfg, hasFile, redirect, file }, path, noRedirects) {
  const idx = cfg.index;
  const p = path.slice(1);                                         // '' for the root
  const to = (stem, slash) => (stem === '' ? '/' : '/' + stem + (slash ? '/' : ''));

  if (path === '/') return hasFile(idx) ? file(idx, 'index') : null;

  if (path.endsWith('/')) {
    const stem = p.slice(0, -1);
    if (hasFile(stem + '/' + idx)) {
      if (cfg.trailingSlash === false && !noRedirects) return redirect(to(stem, false));
      return file(stem + '/' + idx, 'dir-index');
    }
    if (cfg.cleanUrls && hasFile(stem + '.html')) {
      // "/file/" for a page that is a file: serving it in place would change the base of its relative URLs.
      // Netlify and Cloudflare redirect to "/file"; Vercel with trailingSlash:true serves it under the slash.
      if (cfg.trailingSlash === true || noRedirects) return file(stem + '.html', 'file-at-slash');
      return redirect(to(stem, false));
    }
    return null;
  }

  // no trailing slash
  if (hasFile(p)) {
    if (cfg.canonicalUrls && !noRedirects) {
      if (p === idx) return redirect('/');
      if (p.endsWith('/' + idx)) return redirect(to(p.slice(0, -(idx.length + 1)), cfg.trailingSlash !== false));
      if (cfg.cleanUrls && p.endsWith('.html')) return redirect(to(p.slice(0, -5), cfg.trailingSlash === true));
    }
    return file(p, 'exact');
  }
  if (cfg.cleanUrls && hasFile(p + '.html')) {                    // file first: GitHub Pages, Netlify, Cloudflare Pages, Next.js nginx recipe
    if (cfg.trailingSlash === true && !noRedirects) return redirect(to(p, true));
    return file(p + '.html', 'clean-url');
  }
  if (hasFile(p + '/' + idx)) {
    if (cfg.trailingSlash === false || noRedirects) return file(p + '/' + idx, 'dir-index-no-slash');
    return redirect(to(p, true));                                  // "/dir" -> "/dir/" so relative links resolve inside it
  }
  return null;
}

function notFoundPage(cfg, path, hasFile, via) {
  if (cfg.notFound) {
    const dirs = path.split('/').slice(1, -1);
    const candidates = [];
    if (cfg.notFound === 'nearest') {
      for (let k = dirs.length; k > 0; k--) candidates.push(dirs.slice(0, k).join('/') + '/404.html');
    }
    candidates.push('404.html');
    for (const c of candidates) if (hasFile(c)) return { kind: 'status-page', status: 404, file: c, via: via + ':404.html' };
  }
  return { kind: 'not-found', status: 404, file: null, via };
}

// Follow redirects to a fixpoint (max 10 hops), for table-style comparisons.
export function resolveFully(manifest, url, hasFile, opts = {}) {
  const hops = [];
  let cur = url;
  for (let i = 0; i < 10; i++) {
    const [p, q] = cur.split('?');
    const r = applyRouting(manifest, { pathname: p, search: q ? '?' + q : '', navigation: opts.navigation ?? true }, hasFile);
    hops.push({ from: cur, ...r });
    if (r.kind !== 'redirect' || /^[a-z]+:\/\//i.test(r.location)) return { final: r, hops };
    cur = r.location;
  }
  return { final: { kind: 'loop' }, hops };
}
