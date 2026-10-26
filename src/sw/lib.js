// src/sw/lib.js: pure helpers for the Service Worker core (ARCHITECTURE §7.1, §3.4; INTERFACES
// "src/sw/lib.js"; DESIGN-REVIEW items 7, 8, S11). No Service Worker globals: runs unchanged in
// Node >= 22, windows, workers and the worker itself. tools/publish.mjs reuses parseRedirects and
// parseHeaders to write /.mw/site.json, and tools/dev-server.mjs may reuse applyRouting.
//
//   mimeFor(path)                       Content-Type from an 80-entry extension map
//   parseRange(header, size)            RFC 9110 single byte range → { start, end } | null | 416
//   splitHubPath(pathname)              '/_mw/s/<btih>/<path>' → { btih, path } | null
//   applyRouting(manifest, path, hasFile, { navigate })
//                                       routing manifest (/.mw/site.json) → { path, status, redirect, headers }
//   parseRedirects(text) / parseHeaders(text)
//                                       Netlify / Cloudflare Pages `_redirects` and `_headers` subset
//   stampedPointerFromHtml(headChunk)   the <meta name="mw-pointer"> of a drop-in page → record | null
//   RESERVED_ROUTES, reservedRoute(p)   v0.3: /_mw/f/<id>, /_mw/media/<sid>, /_mw/idp-return (answered by the worker)

import { parsePointer } from '../common/pointer.js';

const OCTET = 'application/octet-stream';
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------------------------

// Extension → Content-Type. Text types carry charset=utf-8 so nothing is ever sniffed, and every
// type that nosniff or a module loader checks (scripts, styles, wasm, JSON) is exact.
const MIME = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  jsonld: 'application/ld+json; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  wasm: 'application/wasm',
  xml: 'application/xml; charset=utf-8',
  xsl: 'application/xslt+xml; charset=utf-8',
  rss: 'application/rss+xml; charset=utf-8',
  atom: 'application/atom+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  ics: 'text/calendar; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  srt: 'application/x-subrip',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  wgsl: 'text/wgsl; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  sqlite: 'application/vnd.sqlite3',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  mid: 'audio/midi',
  midi: 'audio/midi',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4s: 'video/iso.segment',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  ts: 'video/mp2t', // MPEG transport stream (HLS segments), never TypeScript
  m3u8: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  usdz: 'model/vnd.usdz+zip',
});

/** Frozen copy of the extension map (tests, debug panel, publish.mjs). */
export const MIME_TYPES = MIME;

/**
 * extOf(path) → lowercase extension of the last path segment, '' when there is none. A segment
 * whose only dot is the leading one ('.well-known', '.htaccess') has no extension.
 */
export function extOf(path) {
  if (typeof path !== 'string') return '';
  let p = path;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  const seg = p.slice(p.lastIndexOf('/') + 1);
  const dot = seg.lastIndexOf('.');
  if (dot <= 0 || dot === seg.length - 1) return '';
  return seg.slice(dot + 1).toLowerCase();
}

/** mimeFor(path) → Content-Type for a site path (application/octet-stream when unknown). */
export function mimeFor(path) {
  const ext = extOf(path);
  return ext && hasOwn(MIME, ext) ? MIME[ext] : OCTET;
}

// ---------------------------------------------------------------------------------------------
// Range (RFC 9110 §14)
// ---------------------------------------------------------------------------------------------

/**
 * parseRange(header, size) → { start, end } (inclusive), null, or 416.
 * null: no header, not a `bytes` range, malformed, or several ranges (the caller answers the whole
 * body with 200, which RFC 9110 allows). 416: syntactically valid but unsatisfiable (the caller
 * answers 416 with an unsatisfied-range Content-Range). Over-long ends are clamped; suffix
 * ranges (`bytes=-500`) take the last bytes; Safari's `bytes=0-1` media probe gives { 0, 1 }.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  if (!Number.isSafeInteger(size) || size < 0) return null;
  const m = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(header);
  if (!m) return null;
  const specs = m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (specs.length !== 1) return null; // several ranges → full body; an empty set → invalid
  const r = /^(\d*)-(\d*)$/.exec(specs[0]);
  if (!r) return null;
  const first = r[1];
  const last = r[2];
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 416;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null; // last-pos < first-pos is invalid → ignore
  if (start >= size) return 416; // also covers size === 0
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return { start, end };
}

// ---------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------

const HUB_PREFIX = '/_mw/s/';
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * splitHubPath(pathname) → { btih, path } | null for the shared-origin hub namespace
 * '/_mw/s/<btih>/<path>'. `btih` is lowercase hex; `path` is the rest of the URL path, still
 * percent-encoded, always starting with '/' ('/' when the URL ends at the btih). Same result as
 * src/loader/render.js splitHubPath.
 */
export function splitHubPath(pathname) {
  if (typeof pathname !== 'string' || pathname.indexOf(HUB_PREFIX) !== 0) return null;
  const rest = pathname.slice(HUB_PREFIX.length);
  const slash = rest.indexOf('/');
  const btih = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!HEX40.test(btih)) return null;
  return { btih, path: slash === -1 ? '/' : '/' + rest.slice(slash).replace(/^[/\\]+/, '') };
}

/**
 * decodePath(pathname) → the percent-decoded path with a leading '/'. Segments that are not valid
 * percent-encoding are kept as they are. Torrent paths are decoded strings, URLs are encoded.
 */
export function decodePath(pathname) {
  const p = typeof pathname === 'string' ? pathname : '/';
  const out = p.split('/').map((seg) => {
    if (seg.indexOf('%') < 0) return seg;
    try {
      return decodeURIComponent(seg);
    } catch (_) {
      return seg;
    }
  }).join('/');
  return out.charAt(0) === '/' ? out : '/' + out;
}

/** encodePath(path) → URL path with each segment percent-encoded (':@$&+,;=' kept readable). */
export function encodePath(path) {
  return String(path).split('/').map((seg) => encodeURIComponent(seg)
    .replace(/%(3A|40|24|26|2B|2C|3B|3D)/gi, (m) => decodeURIComponent(m))).join('/');
}

function stripQuery(p) {
  const cut = p.search(/[?#]/);
  return cut >= 0 ? p.slice(0, cut) : p;
}

// Request path as matched by the routing manifest: decoded, leading '/', no query, no '//' runs.
function requestPath(path) {
  return decodePath(stripQuery(typeof path === 'string' ? path : '/')).replace(/\/{2,}/g, '/');
}

// ---------------------------------------------------------------------------------------------
// `_redirects` and `_headers` (Netlify / Cloudflare Pages subset)
// ---------------------------------------------------------------------------------------------

export const REDIRECT_STATUSES = Object.freeze([200, 301, 302, 303, 307, 308, 404]);
const MAX_REDIRECTS = 2000;
const MAX_HEADER_RULES = 1000;
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isInternal(target) {
  return typeof target === 'string' && target.charAt(0) === '/' && target.charAt(1) !== '/';
}

function isExternal(target) {
  return typeof target === 'string' && /^https?:\/\/[^/]/i.test(target);
}

/**
 * parseRedirects(text) → [{ from, to, status, force }] in file order.
 * Line format: `from to [status][!]`, `#` comments. `from` is a site path; `*` is a splat (one per
 * rule; a trailing `/*` also matches the bare directory) and `:name` a placeholder for one path
 * segment; `to` may use `:splat` and `:name`. Status defaults to 301; 200 rewrites to an internal
 * path, 404 serves `to` with status 404, `!` forces the rule even when a file exists at `from`.
 * Not supported, so the line is skipped: query-parameter matching (`/path id=:id ...`), country,
 * language, role or cookie conditions, proxying (200 to another origin), statuses other than
 * 200, 301, 302, 303, 307, 308 and 404, and `from` values that are full URLs.
 */
export function parseRedirects(text) {
  const rules = [];
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
  for (const raw of lines) {
    if (rules.length >= MAX_REDIRECTS) break;
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) continue;
    const from = parts[0];
    const to = parts[1];
    let status = 301;
    let force = false;
    if (parts.length === 3) {
      const m = /^(\d{3})(!?)$/.exec(parts[2]);
      if (!m) continue;
      status = Number(m[1]);
      force = m[2] === '!';
    }
    const rule = normalizeRedirect({ from, to, status, force });
    if (rule) rules.push(rule);
  }
  return rules;
}

function normalizeRedirect(r) {
  if (!r || typeof r !== 'object') return null;
  const from = typeof r.from === 'string' ? r.from.trim() : '';
  const to = typeof r.to === 'string' ? r.to.trim() : '';
  const status = r.status === undefined || r.status === null ? 301 : Number(r.status);
  if (!isInternal(from) || from.indexOf('?') >= 0) return null;
  if (!isInternal(to) && !isExternal(to)) return null;
  if (REDIRECT_STATUSES.indexOf(status) < 0) return null;
  if ((status === 200 || status === 404) && !isInternal(to)) return null; // no proxying
  return { from, to, status, force: r.force === true };
}

/**
 * parseHeaders(text) → [{ for, values: { 'Header-Name': 'value' } }] in file order.
 * A line starting at column 0 is a path pattern (same `*` / `:name` syntax as redirects); the
 * indented `Name: value` lines below it are its headers. A repeated name is joined with ', '.
 * Skipped: `#` comments, Cloudflare's `! Name` detach lines, patterns that are full URLs, and
 * header names that are not HTTP tokens.
 */
export function parseHeaders(text) {
  const rules = [];
  let current = null;
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    if (!/^\s/.test(raw)) {
      current = null;
      if (rules.length >= MAX_HEADER_RULES) break;
      if (isInternal(line)) {
        current = { for: line, values: {} };
        rules.push(current);
      }
      continue;
    }
    if (!current || line.charAt(0) === '!') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    addHeader(current.values, line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return rules.filter((r) => Object.keys(r.values).length > 0);
}

function addHeader(values, name, value) {
  if (!TOKEN_RE.test(name) || typeof value !== 'string') return;
  const lower = name.toLowerCase();
  for (const existing of Object.keys(values)) {
    if (existing.toLowerCase() === lower) {
      values[existing] = values[existing] ? values[existing] + ', ' + value : value;
      return;
    }
  }
  values[name] = value;
}

// ---------------------------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------------------------

function escapeRe(c) {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? '\\' + c : c;
}

// '/blog/:year/*' → { re, names }. A trailing '/*' also matches the bare directory, and a
// pattern without a splat matches with or without one trailing slash.
function compilePattern(pattern) {
  let body = pattern;
  let tailSplat = false;
  if (body === '/*') {
    body = '';
    tailSplat = true;
  } else if (body.length > 2 && body.slice(-2) === '/*') {
    body = body.slice(0, -2);
    tailSplat = true;
  }
  let optionalSlash = false;
  if (!tailSplat && body.length > 1 && body.charAt(body.length - 1) === '/') {
    body = body.slice(0, -1);
    optionalSlash = true;
  } else if (!tailSplat && body.length > 1) {
    optionalSlash = true;
  }
  const names = [];
  let src = '^';
  for (let i = 0; i < body.length;) {
    const c = body.charAt(i);
    if (c === '*' && names.indexOf('splat') < 0 && !tailSplat) {
      src += '(.*)';
      names.push('splat');
      i += 1;
      continue;
    }
    if (c === ':') {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(body.slice(i));
      if (m && m[1] !== 'splat') {
        src += '([^/]+)';
        names.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    src += escapeRe(c);
    i += 1;
  }
  if (tailSplat) {
    src += '(?:/(.*))?';
    names.push('splat');
  } else if (optionalSlash) {
    src += '/?';
  }
  if (src === '^') src += '/';
  return { re: new RegExp(src + '$'), names };
}

function matchPattern(compiled, path) {
  const m = compiled.re.exec(path);
  if (!m) return null;
  const params = {};
  compiled.names.forEach((name, i) => {
    params[name] = m[i + 1] === undefined ? '' : m[i + 1];
  });
  return params;
}

function substitute(target, params) {
  return target.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => (hasOwn(params, name) ? params[name] : whole));
}

// ---------------------------------------------------------------------------------------------
// routing manifest (/.mw/site.json)
// ---------------------------------------------------------------------------------------------

const NORMALIZED = new WeakSet();
const NORMALIZED_FROM = new WeakMap();

function siteRel(p) {
  return typeof p === 'string' ? p.replace(/^\/+/, '') : '';
}

/**
 * normalizeManifest(raw) → the routing manifest with defaults and compiled rules.
 *   index:         directory index file name, default 'index.html'
 *   notFound:      page served with 404 to navigations that match nothing, default '404.html'
 *                  (null or false: plain 404)
 *   spa:           false (default) | true (= the root index) | '<path>': navigations that match
 *                  nothing get this document with 200 (History-API routers)
 *   cleanUrls:     false (default) | true: '/about.html' 301 → '/about' and '/dir/index.html' →
 *                  '/dir/'. '/about' always serves 'about.html' when no 'about' file exists.
 *   trailingSlash: 'auto' (default: '/dir' 301 → '/dir/', '/page/' 301 → '/page') | true (always
 *                  a trailing slash for pages) | false (never: '/dir/' 301 → '/dir', which serves
 *                  'dir/index.html')
 *   redirects:     [{ from, to, status, force }] or `_redirects` text
 *   headers:       [{ for, values }] or `_headers` text or { '<pattern>': { Name: value } }
 * Anything malformed is dropped, never thrown. The result is cached per input object.
 */
export function normalizeManifest(raw) {
  if (raw && typeof raw === 'object') {
    if (NORMALIZED.has(raw)) return raw;
    const hit = NORMALIZED_FROM.get(raw);
    if (hit) return hit;
  }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const index = typeof src.index === 'string' && src.index.trim() && !/[/\\]/.test(src.index.trim())
    ? src.index.trim() : 'index.html';
  let notFound = '404.html';
  if (src.notFound === null || src.notFound === false) notFound = null;
  else if (typeof src.notFound === 'string' && siteRel(src.notFound)) notFound = siteRel(src.notFound);
  let spa = null;
  if (src.spa === true) spa = index;
  else if (typeof src.spa === 'string' && siteRel(src.spa)) spa = siteRel(src.spa);
  const ts = src.trailingSlash;
  const trailingSlash = ts === true || ts === 'always' ? true : (ts === false || ts === 'never' ? false : 'auto');

  let redirectList = [];
  if (typeof src.redirects === 'string') redirectList = parseRedirects(src.redirects);
  else if (Array.isArray(src.redirects)) redirectList = src.redirects.map(normalizeRedirect).filter(Boolean).slice(0, MAX_REDIRECTS);
  const redirects = redirectList.map((r) => Object.freeze(Object.assign({}, r, { matcher: compilePattern(r.from) })));

  let headerList = [];
  if (typeof src.headers === 'string') headerList = parseHeaders(src.headers);
  else if (Array.isArray(src.headers)) headerList = src.headers.map(normalizeHeaderRule).filter(Boolean);
  else if (src.headers && typeof src.headers === 'object') {
    headerList = Object.keys(src.headers).map((pattern) => normalizeHeaderRule({ for: pattern, values: src.headers[pattern] })).filter(Boolean);
  }
  const headers = headerList.slice(0, MAX_HEADER_RULES)
    .map((r) => Object.freeze({ for: r.for, values: Object.freeze(r.values), matcher: compilePattern(r.for) }));

  const out = Object.freeze({
    index,
    notFound,
    spa,
    cleanUrls: src.cleanUrls === true,
    trailingSlash,
    redirects: Object.freeze(redirects),
    headers: Object.freeze(headers),
  });
  NORMALIZED.add(out);
  if (raw && typeof raw === 'object') NORMALIZED_FROM.set(raw, out);
  return out;
}

function normalizeHeaderRule(r) {
  if (!r || typeof r !== 'object') return null;
  const pattern = typeof r.for === 'string' ? r.for.trim() : '';
  if (!isInternal(pattern) || !r.values || typeof r.values !== 'object') return null;
  const values = {};
  for (const name of Object.keys(r.values)) {
    const v = r.values[name];
    if (typeof v === 'string') addHeader(values, name, v.trim());
    else if (typeof v === 'number') addHeader(values, name, String(v));
  }
  return Object.keys(values).length ? { for: pattern, values } : null;
}

/**
 * headersFor(manifest, path) → { Name: value } from every header rule matching the request path
 * (rules apply in order; a name set by several rules is joined with ', ').
 */
export function headersFor(manifest, path) {
  const m = normalizeManifest(manifest);
  const p = requestPath(path);
  const out = {};
  const nameOf = {};
  for (const rule of m.headers) {
    if (!matchPattern(rule.matcher, p)) continue;
    for (const name of Object.keys(rule.values)) {
      const lower = name.toLowerCase();
      if (hasOwn(nameOf, lower)) out[nameOf[lower]] += ', ' + rule.values[name];
      else {
        nameOf[lower] = name;
        out[name] = rule.values[name];
      }
    }
  }
  return out;
}

// The file a rewrite / spa / notFound target names, without redirects.
function resolveTarget(m, target, has) {
  const t = requestPath(target);
  const rel = t.slice(1);
  if (t.charAt(t.length - 1) === '/') {
    if (has(rel + m.index)) return rel + m.index;
    const base = rel.slice(0, -1);
    if (base && has(base + '.html')) return base + '.html';
    return null;
  }
  if (has(rel)) return rel;
  if (has(rel + '.html')) return rel + '.html';
  if (has(rel + '/' + m.index)) return rel + '/' + m.index;
  return null;
}

// The canonical clean URL of an existing HTML file, or null when cleanUrls does not apply to it.
function cleanUrlFor(m, rel) {
  if (rel === m.index) return '/';
  const suffix = '/' + m.index;
  if (rel.length > suffix.length && rel.slice(-suffix.length) === suffix) {
    const dir = rel.slice(0, -m.index.length); // 'docs/'
    return m.trailingSlash === false ? '/' + dir.slice(0, -1) : '/' + dir;
  }
  if (/\.html$/i.test(rel) && rel.length > 5) {
    const base = rel.slice(0, -5);
    return m.trailingSlash === true ? '/' + base + '/' : '/' + base;
  }
  return null;
}

// Files at the request path: { file } | { redirect } | null.
function resolveStatic(m, p, has) {
  const rel = p.slice(1);
  if (p.charAt(p.length - 1) === '/') {
    const idx = rel + m.index;
    if (has(idx)) {
      if (m.trailingSlash === false && p !== '/') return { redirect: p.slice(0, -1) };
      return { file: idx };
    }
    if (p !== '/') {
      const base = rel.slice(0, -1);
      if (has(base + '.html')) return m.trailingSlash === true ? { file: base + '.html' } : { redirect: '/' + base };
      if (has(base)) return { redirect: '/' + base };
    }
    return null;
  }
  if (has(rel)) {
    if (m.cleanUrls) {
      const canonical = cleanUrlFor(m, rel);
      if (canonical !== null && canonical !== p) return { redirect: canonical };
    }
    return { file: rel };
  }
  if (has(rel + '.html')) {
    if (m.trailingSlash === true) return { redirect: p + '/' };
    return { file: rel + '.html' };
  }
  if (has(rel + '/' + m.index)) {
    if (m.trailingSlash === false) return { file: rel + '/' + m.index };
    return { redirect: p + '/' };
  }
  return null;
}

function runRedirects(m, p, has, forced) {
  for (const rule of m.redirects) {
    if (rule.force !== forced) continue;
    const params = matchPattern(rule.matcher, p);
    if (!params) continue;
    const target = substitute(rule.to, params);
    if (rule.status === 200 || rule.status === 404) {
      const file = resolveTarget(m, target, has);
      if (file) return { status: rule.status, path: file };
      continue; // a rewrite to a missing file does not match
    }
    if (isInternal(target) && requestPath(target) === p) continue; // would redirect to itself
    return { status: rule.status, redirect: target };
  }
  return null;
}

/**
 * applyRouting(manifest, path, hasFile, { navigate = true } = {}) → { path, status, redirect, headers }
 *   path:     site-relative file to serve ('index.html', 'css/app.css'), or null
 *   status:   200, 404 or a redirect status
 *   redirect: decoded target for redirects ('/docs/', '/new?x=1' or an absolute URL), else null
 *   headers:  { Name: value } from the header rules matching the request path
 * `path` is the URL path as it appears in the URL (percent-encoded; a query is ignored);
 * `hasFile(sitePath)` must be synchronous. Order: forced rules (`!`), files (with index,
 * cleanUrls and trailingSlash), the other rules, the spa document, the notFound page; the last
 * two only for navigations (a missing script or image is a plain 404, never an HTML page).
 */
export function applyRouting(manifest, path, hasFile, opts) {
  const m = normalizeManifest(manifest);
  const navigate = !(opts && opts.navigate === false);
  const has = typeof hasFile === 'function'
    ? (p) => {
      try {
        return Boolean(hasFile(p));
      } catch (_) {
        return false;
      }
    }
    : () => false;
  const p = requestPath(path);
  const headers = headersFor(m, p);
  const result = (status, file, redirect) => ({ path: file || null, status, redirect: redirect || null, headers });

  const forced = runRedirects(m, p, has, true);
  if (forced) return result(forced.status, forced.path, forced.redirect);
  const found = resolveStatic(m, p, has);
  if (found) return found.redirect ? result(301, null, found.redirect) : result(200, found.file, null);
  const rule = runRedirects(m, p, has, false);
  if (rule) return result(rule.status, rule.path, rule.redirect);
  if (navigate && m.spa) {
    const file = resolveTarget(m, '/' + m.spa, has);
    if (file) return result(200, file, null);
  }
  if (navigate && m.notFound && has(m.notFound)) return result(404, m.notFound, null);
  return result(404, null, null);
}

// ---------------------------------------------------------------------------------------------
// HTML sniffing: the stamped pointer of a drop-in page, the loader shell
// ---------------------------------------------------------------------------------------------

const utf8Lenient = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;

function asText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (!utf8Lenient || !chunk) return '';
  if (chunk instanceof Uint8Array) return utf8Lenient.decode(chunk);
  if (chunk instanceof ArrayBuffer) return utf8Lenient.decode(new Uint8Array(chunk));
  if (ArrayBuffer.isView(chunk)) return utf8Lenient.decode(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return '';
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) };

function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g, (whole, dec, hx, name) => {
    if (name) return NAMED_ENTITIES[name];
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hx, 16);
    if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return String.fromCharCode(0xfffd);
    return String.fromCodePoint(code);
  });
}

// Attributes of the tag whose name ends at `pos`: { attrs: Map(lowercase name → raw value), end }
// or null when the tag is cut off (a chunk boundary inside it). Quotes are respected, so a '>'
// inside a quoted value does not end the tag.
function readTag(html, pos) {
  const attrs = new Map();
  let i = pos;
  const n = html.length;
  for (;;) {
    while (i < n && /[\s/]/.test(html.charAt(i))) i += 1;
    if (i >= n) return null;
    if (html.charAt(i) === '>') return { attrs, end: i + 1 };
    const nameMatch = /^[^\s"'>/=]+/.exec(html.slice(i, i + 256));
    if (!nameMatch) {
      i += 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;
    while (i < n && /\s/.test(html.charAt(i))) i += 1;
    let value = '';
    if (i < n && html.charAt(i) === '=') {
      i += 1;
      while (i < n && /\s/.test(html.charAt(i))) i += 1;
      if (i >= n) return null;
      const q = html.charAt(i);
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close < 0) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const m = /^[^\s>]+/.exec(html.slice(i));
        value = m ? m[0] : '';
        i += value.length;
      }
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
}

/**
 * stampedPointerFromHtml(headChunk) → pointer record | null.
 * headChunk: the first bytes of an HTML document (string, Uint8Array or ArrayBuffer; the Service
 * Worker passes at most 4 KiB). Finds the first <meta name="mw-pointer" content="..."> outside
 * comments (any attribute order, quoting or case; character references decoded) and parses its
 * content with src/common/pointer.js parsePointer, so the record has the same shape everywhere.
 * Signatures are not checked here: the stamped page comes from the host, the trust root.
 */
export function stampedPointerFromHtml(headChunk) {
  let html = asText(headChunk);
  if (!html) return null;
  if (html.length > 65536) html = html.slice(0, 65536);
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const open = /<meta(?=[\s/>])/gi;
  let m;
  while ((m = open.exec(html)) !== null) {
    const tag = readTag(html, m.index + 5);
    if (!tag) return null;
    open.lastIndex = tag.end;
    const name = tag.attrs.get('name');
    if (!name || decodeEntities(name).trim().toLowerCase() !== 'mw-pointer') continue;
    if (!tag.attrs.has('content')) return null;
    const parsed = parsePointer(decodeEntities(tag.attrs.get('content')));
    return parsed && parsed.ok ? parsed.record : null;
  }
  return null;
}

/**
 * isShellHtml(text) → true when the document is the felinar loader shell: it loads
 * /_mw/boot.js (src/loader/index.html) or carries <meta name="mw-shell">. A drop-in page loads
 * /_mw/mw.js instead and is never treated as the shell.
 */
export function isShellHtml(text) {
  const html = asText(text);
  if (!html) return false;
  return /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:\/\/[^/"'\s>]+)?\/_mw\/boot\.js(?:[?#"'\s>]|$)/i.test(html) ||
    /<meta\b[^>]*\bname\s*=\s*["']?mw-shell["'\s/>]/i.test(html);
}

// ---------------------------------------------------------------------------------------------
// v0.3 reserved worker routes (R 2.3.1, 2.8.5, 2.9.6; ARCHITECTURE 15.7)
// ---------------------------------------------------------------------------------------------

/** Paths the worker answers before the navigation catch-all; a site can never publish files there. */
export const RESERVED_ROUTES = Object.freeze({
  file: '/_mw/f/',
  media: '/_mw/media/',
  idpReturn: '/_mw/idp-return',
});

/**
 * reservedRoute(pathname) -> { kind: 'file' | 'media', id } | { kind: 'idp-return' } | null.
 * id is the path segment after the prefix (a 32-character hex session id when well formed).
 */
export function reservedRoute(pathname) {
  if (typeof pathname !== 'string') return null;
  if (pathname === RESERVED_ROUTES.idpReturn || pathname === RESERVED_ROUTES.idpReturn + '/') return { kind: 'idp-return' };
  if (pathname.indexOf(RESERVED_ROUTES.file) === 0) return { kind: 'file', id: pathname.slice(RESERVED_ROUTES.file.length) };
  if (pathname.indexOf(RESERVED_ROUTES.media) === 0) return { kind: 'media', id: pathname.slice(RESERVED_ROUTES.media.length) };
  return null;
}
