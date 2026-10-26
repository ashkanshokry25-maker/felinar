// tools/publish-policy.mjs: the publishing discipline of tools/publish.mjs (v0.2.1, DIGEST-AMENDMENTS
// E1 to E3; MIGRATION-DIGEST M02 to M04, w2a-02 F11, F16, F21, F24). Pure functions over paths and
// bytes, so each rule has a unit test and publish only has to call them.
//
//   lintPaths(paths)            E1 path policy: NFC, no ? # % \ or control characters, no dot segments,
//                               no case or normalisation twins, reserved felinar paths refused
//   dotPathReason(rel, isDir)   E1 the explicit dot-file table (what is dropped, and why)
//   budgetReport(...)           E2 file count, torrent metadata, largest file per host, total per visitor
//   lintSecrets(entries)        E3 key, token and backup files, private keys inside files, raw WordPress
//                               exports with commenter e-mail or IP addresses
//   importWxr(xml)              E3 --from-wxr: legacy comments as static JSON, without e-mail and IP
//
// Publication into a torrent cannot be recalled once a peer holds a copy (w2a-02 Gotcha 1), so every
// rule here runs before anything is written.

const enc = new TextEncoder();
const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// E1: path policy
// ---------------------------------------------------------------------------------------------

/** Paths the loader origin reserves (ARCHITECTURE §3.1): never a site file. */
export const RESERVED_PATHS = Object.freeze({ prefixes: Object.freeze(['_mw/', '.mw/', 'ws/']), files: Object.freeze(['_mw', '.mw', 'ws', 'mw-sw.js']) });

// '?' and '#' end the path when WebTorrent pastes it into a web-seed URL (no percent-encoding), '%'
// starts an escape the host decodes, '\' becomes '/', control characters are dropped by the URL parser.
// eslint-disable-next-line no-control-regex
const BREAKS_URL = /[?#%\\\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /[:*"<>|]/;

function describeChar(c) {
  const code = c.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return 'control character U+' + code.toString(16).toUpperCase().padStart(4, '0');
  return JSON.stringify(c);
}

/** reservedPathReason(nfcPath) → reason | null. */
const RESERVED_WHY = {
  '_mw/': '/_mw/ holds the loader runtime; the Service Worker answers it from its precache',
  '.mw/': '/.mw/ holds the files publish generates (site.json, files.json)',
  'ws/': '/ws/ is the development web seed; the Service Worker passes it to the host',
  'mw-sw.js': '/mw-sw.js is the Service Worker',
};

export function reservedPathReason(p) {
  for (const f of RESERVED_PATHS.files) {
    if (p === f) return 'reserved by felinar (' + (RESERVED_WHY[f] || RESERVED_WHY[f + '/']) + ')';
  }
  for (const prefix of RESERVED_PATHS.prefixes) {
    if (p.startsWith(prefix)) return 'reserved by felinar (' + RESERVED_WHY[prefix] + ')';
  }
  return null;
}

/**
 * pathProblems(path) → { errors: [why], warnings: [why] } for one path (as written on disk, site-relative,
 * '/'-separated). The NFC spelling is what the torrent and the deploy copy use.
 */
export function pathProblems(path) {
  const errors = [];
  const warnings = [];
  const p = String(path);
  const nfc = p.normalize('NFC');
  if (nfc !== p) warnings.push('not in Unicode NFC form; published as its NFC spelling (browsers request the NFC spelling)');
  if (!nfc || nfc.startsWith('/') || nfc.endsWith('/') || nfc.includes('//')) errors.push('empty path segment');
  for (const seg of nfc.split('/')) {
    if (seg === '.' || seg === '..') errors.push('dot segment "' + seg + '" (the URL parser removes it)');
    const bad = BREAKS_URL.exec(seg);
    if (bad) errors.push('character ' + describeChar(bad[0]) + ' in "' + seg + '" (WebTorrent pastes paths into web-seed URLs unescaped: ? and # cut the path, % starts an escape, \\ becomes /)');
    if (seg !== '.' && seg !== '..' && (/^ /.test(seg) || /[ .]$/.test(seg))) errors.push('leading or trailing space, or trailing dot, in "' + seg + '"');
    if (enc.encode(seg).length > 255) errors.push('a path segment longer than 255 bytes');
    if (WINDOWS_RESERVED.test(seg)) warnings.push('character reserved on Windows in "' + seg + '" (the file cannot be checked out there)');
  }
  if (enc.encode(nfc).length > 1024) errors.push('longer than 1,024 bytes (the S3 key limit)');
  const reserved = reservedPathReason(nfc);
  if (reserved) errors.push(reserved);
  return { errors, warnings };
}

/**
 * lintPaths(paths) → { errors: [{ path, why }], warnings: [{ path, why }], renames: [{ from, to }] }
 * E1 over the whole site: pathProblems per path, plus collisions after NFC normalisation and case
 * folding (APFS and Windows merge such names silently; case-sensitive hosts serve both).
 */
export function lintPaths(paths) {
  const errors = [];
  const warnings = [];
  const renames = [];
  const seen = new Map();
  for (const path of paths) {
    const r = pathProblems(path);
    for (const why of r.errors) errors.push({ path, why });
    for (const why of r.warnings) warnings.push({ path, why });
    const nfc = path.normalize('NFC');
    if (nfc !== path) renames.push({ from: path, to: nfc });
    const fold = nfc.toLowerCase();
    const other = seen.get(fold);
    if (other !== undefined && other !== path) {
      errors.push({ path, why: 'case or Unicode-normalisation twin of "' + other + '" (one name on APFS and Windows, two URLs on the web)' });
    } else if (other === undefined) {
      seen.set(fold, path);
    }
  }
  return { errors, warnings, renames };
}

// The explicit dot-path table (E1: "enumerate dot-files explicitly and report dropped paths"). Every
// reason names the path as a dotfile or dot-directory, so the publish report says why it is not there.
const DOT_RULES = [
  { re: /^\.well-known$/, root: true, dir: true, reason: 'dot-directory (serve /.well-known/ from the host)' },
  { re: /^\.mw$/, root: true, reason: 'dot-directory /.mw/ is reserved for the files publish generates' },
  { re: /^\.(git|svn|hg|bzr)$/, reason: 'dot-directory: version control data, never published' },
  { re: /^\.env(\..*)?$/, reason: 'dotfile: environment file (secrets), never published' },
  { re: /^(\.DS_Store|\._.*|\.Spotlight-V100|\.Trashes|\.fseventsd|\.TemporaryItems)$/, reason: 'dotfile: OS junk' },
  { re: /^\.(github|gitlab|circleci|vscode|idea|husky|cache|parcel-cache|next|nuxt|svelte-kit|astro|vercel|netlify)$/, reason: 'dot-directory: build or editor tooling, never published' },
  { re: /^\.(nojekyll|htaccess)$/, root: true, file: true, reason: 'dotfile: host configuration (kept in the drop-in deploy copy, not in the torrent)' },
  { re: /^\.(htpasswd|npmrc|pypirc|netrc|pgpass|git-credentials)$/, reason: 'dotfile: credentials, never published' },
  {
    re: /^\.(gitignore|gitattributes|gitmodules|editorconfig|nvmrc|node-version|tool-versions|prettierrc.*|prettierignore|eslintrc.*|eslintignore|stylelintrc.*|babelrc.*|browserslistrc|travis\.yml|gitlab-ci\.yml|dockerignore|vercelignore)$/,
    reason: 'dotfile: tooling configuration, never published',
  },
];
/** Dot paths that --include-dot can never publish. */
const NEVER_INCLUDED = /^\.(git|svn|hg|bzr|env(\..*)?|htpasswd|npmrc|pypirc|netrc|pgpass|git-credentials|mw)$/;

/**
 * dotPathReason(rel, isDir, { includeDot }) → reason | null for the first dot segment of rel.
 * includeDot: site-relative paths (files or directories) to publish although they start with a dot
 * (never VCS data, .env, credentials or /.mw/).
 */
export function dotPathReason(rel, isDir, { includeDot = [] } = {}) {
  const segs = rel.split('/');
  const i = segs.findIndex((s) => s.startsWith('.'));
  if (i < 0) return null;
  const seg = segs[i];
  const isLast = i === segs.length - 1;
  const segIsDir = isLast ? isDir : true;
  for (const inc of includeDot) {
    const prefix = String(inc).replace(/^\/+/, '').replace(/\/+$/, '');
    if (prefix && (rel === prefix || rel.startsWith(prefix + '/') || prefix.startsWith(rel + '/')) && !NEVER_INCLUDED.test(seg)) return null;
  }
  for (const rule of DOT_RULES) {
    if (!rule.re.test(seg)) continue;
    if (rule.root && i !== 0) continue;
    if (rule.dir && !segIsDir) continue;
    if (rule.file && segIsDir) continue;
    return rule.reason;
  }
  return segIsDir ? 'dotfile directory (not published; --include-dot ' + segs.slice(0, i + 1).join('/') + ' publishes it)'
    : 'dotfile (not published; --include-dot ' + segs.slice(0, i + 1).join('/') + ' publishes it)';
}

// ---------------------------------------------------------------------------------------------
// E2: budget gates
// ---------------------------------------------------------------------------------------------

export const BUDGET = Object.freeze({
  warnFiles: 5000,
  failFiles: 20000, // also Cloudflare Pages' free-tier file ceiling (w2a-02 F24)
  warnMetadataBytes: 1000000, // about 61 ut_metadata blocks of 16 KiB; xs= becomes mandatory
  loaderTorrentBytes: 8 * MiB, // src/loader/torrent.js refuses a larger .torrent from xs=
  peerMetadataBytes: 10000000, // ut_metadata MAX_METADATA_SIZE: peers refuse larger info dictionaries
});

/** Host profiles for the size report (w2a-02 F24; numbers as of 2026-10). */
export const HOST_PROFILES = Object.freeze([
  Object.freeze({ name: 'Cloudflare Pages (free)', maxFileBytes: 25 * MiB, maxFiles: 20000, maxSiteBytes: null }),
  Object.freeze({ name: 'GitHub Pages', maxFileBytes: 100 * 1000 * 1000, maxFiles: null, maxSiteBytes: 1000 * 1000 * 1000 }),
  Object.freeze({ name: 'S3 / R2 / B2', maxFileBytes: null, maxFiles: null, maxSiteBytes: null }),
]);

function fmt(n) {
  if (n >= MiB) return (n / MiB).toFixed(n >= 10 * MiB ? 0 : 1) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(n >= 10240 ? 0 : 1) + ' KiB';
  return n + ' B';
}

/**
 * budgetReport({ files: [{ path, length }], torrentBytes, pieceCount, xs, mode, limits, maxFiles })
 *   → { lines: [string], warnings: [string], errors: [string], largest }
 * limits: { desktop, mobile, cellular } visitor caps (CONFIG.limits). Errors: more files than maxFiles
 * (default BUDGET.failFiles), a .torrent the loader refuses, an info dictionary peers refuse without
 * xs=, and in shell mode a site above the desktop cap (no visitor could load it).
 */
export function budgetReport({ files, torrentBytes, pieceCount = null, xs = false, mode = 'shell', limits, maxFiles = BUDGET.failFiles }) {
  const lines = [];
  const warnings = [];
  const errors = [];
  const count = files.length;
  const total = files.reduce((n, f) => n + f.length, 0);
  let largest = null;
  for (const f of files) if (!largest || f.length > largest.length) largest = f;
  lines.push('files       ' + count + (count >= BUDGET.warnFiles ? '  (warn at ' + BUDGET.warnFiles + ', fail above ' + maxFiles + ')' : ''));
  lines.push('total       ' + fmt(total) + ' (' + total + ' bytes)');
  lines.push('largest     ' + (largest ? largest.path + ', ' + fmt(largest.length) : '(none)'));
  lines.push('metadata    ' + fmt(torrentBytes) + ' .torrent' + (pieceCount !== null ? ', ' + pieceCount + ' pieces' : '') + (xs ? ', bootstrapped over HTTP (xs=)' : ', peers only (no xs=)'));
  if (count > maxFiles) errors.push(count + ' files is more than ' + maxFiles + ' (raise the limit with --max-files if your host and visitors cope; Cloudflare Pages free stops at 20,000)');
  else if (count >= BUDGET.warnFiles) warnings.push(count + ' files: metadata grows about 82 bytes per file; consider leaving large or rare media on the host (outside the torrent)');
  if (torrentBytes > BUDGET.loaderTorrentBytes) errors.push('the .torrent is ' + fmt(torrentBytes) + '; the loader refuses a .torrent above ' + fmt(BUDGET.loaderTorrentBytes) + ' (fewer files, or media on the host)');
  else if (!xs && torrentBytes > BUDGET.peerMetadataBytes) errors.push('the info dictionary is ' + fmt(torrentBytes) + ' and the pointer has no xs=: peers refuse metadata above 10 MB');
  else if (torrentBytes >= BUDGET.warnMetadataBytes) warnings.push('the .torrent is ' + fmt(torrentBytes) + ' (warn at 1 MB): a cold start from peers needs ' + Math.ceil(torrentBytes / 16384) + ' metadata blocks; keep xs= in the pointer');
  const visitors = [];
  if (limits) {
    for (const [name, cap] of [['desktop', limits.desktop], ['mobile Wi-Fi', limits.mobile], ['mobile cellular', limits.cellular]]) {
      if (!cap) continue;
      visitors.push(name + ' ' + (total <= cap ? 'yes' : 'NO') + ' (' + fmt(cap) + ')');
    }
    if (limits.desktop && total > limits.desktop) {
      if (mode === 'shell') errors.push('the site is ' + fmt(total) + '; every visitor refuses sites above ' + fmt(limits.desktop) + ' in shell mode (move large media to the host and out of the torrent with --ignore)');
      else warnings.push('the site is ' + fmt(total) + '; no visitor completes a copy above ' + fmt(limits.desktop) + ' (drop-in pages still load from the host)');
    } else if (limits.mobile && total > limits.mobile) {
      warnings.push('the site is ' + fmt(total) + '; phones refuse sites above ' + fmt(limits.mobile) + ' (Wi-Fi) and ' + fmt(limits.cellular) + ' (cellular)');
    }
  }
  if (visitors.length) lines.push('visitors    ' + visitors.join(', '));
  const hosts = HOST_PROFILES.map((h) => {
    const why = [];
    if (h.maxFileBytes && largest && largest.length > h.maxFileBytes) why.push('largest file above ' + fmt(h.maxFileBytes));
    if (h.maxFiles && count > h.maxFiles) why.push('more than ' + h.maxFiles + ' files');
    if (h.maxSiteBytes && total > h.maxSiteBytes) why.push('site above ' + fmt(h.maxSiteBytes));
    return h.name + ': ' + (why.length ? 'NO (' + why.join(', ') + ')' : 'fits');
  });
  lines.push('hosts       ' + hosts.join('; '));
  if (largest && largest.length > 25 * MiB) warnings.push(largest.path + ' is ' + fmt(largest.length) + ': above Cloudflare Pages\' 25 MiB asset limit');
  return { lines, warnings, errors, largest, total, count };
}

// ---------------------------------------------------------------------------------------------
// E3: secrets and personal data
// ---------------------------------------------------------------------------------------------

const SECRET_NAMES = [
  { re: /(^|\/)wp-config\.php[^/]*$/i, why: 'WordPress configuration (database password and salts)' },
  { re: /(^|\/)\.env(\.[^/]*)?$/, why: 'environment file' },
  { re: /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|jwk)$/i, why: 'private key or key store' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, why: 'SSH private key' },
  { re: /\.(sql|sql\.gz|sql\.bz2|sql\.zip|dump)$/i, why: 'database dump' },
  { re: /\.(bak|backup|swp|swo)$/i, why: 'backup or editor swap file' },
  { re: /(^|\/)[^/]*(backup|dump)[^/]*\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i, why: 'backup archive' },
  { re: /(^|\/)(credentials|secrets?|service-account)[^/]*\.(json|ya?ml|txt|ini|env|toml)$/i, why: 'credentials file' },
  { re: /(^|\/)\.?htpasswd$/i, why: 'password file' },
];

const SECRET_CONTENT = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, why: 'a PEM private key' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: 'an AWS access key id' },
  { re: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/i, why: 'an AWS secret access key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, why: 'a GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, why: 'a GitHub fine-grained token' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, why: 'a Slack token' },
  { re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/, why: 'a Stripe live secret key' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, why: 'an npm token' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, why: 'an Anthropic API key' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, why: 'an OpenAI-style secret key' },
  { re: /"kty"\s*:\s*"(?:EC|RSA|OKP)"[\s\S]{0,400}?"d"\s*:\s*"[A-Za-z0-9_-]{20,}"|"d"\s*:\s*"[A-Za-z0-9_-]{20,}"[\s\S]{0,400}?"kty"\s*:\s*"(?:EC|RSA|OKP)"/, why: 'a private JWK (an owner key?)' },
];

const PII_WXR = /<wp:comment_author_(?:email|IP)>\s*(?:<!\[CDATA\[\s*)?[^<\s\]]/i;
const WARN_CONTENT = [
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: 'a Google API key (fine for a browser key restricted to your domain; never for a server key)' },
];
const MAX_SCAN_BYTES = 8 * MiB;

function looksText(bytes) {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/**
 * lintSecrets(entries, { allow }) → { errors: [{ path, why }], warnings: [{ path, why }] }
 * entries: [{ path, bytes }] of everything that would be published (torrent files and the drop-in
 * deploy copy). allow: exact paths the owner has checked (--allow-secret): their findings become warnings.
 */
export function lintSecrets(entries, { allow = [] } = {}) {
  const errors = [];
  const warnings = [];
  const allowed = new Set(allow.map((p) => String(p).replace(/^\/+/, '')));
  for (const { path, bytes } of entries) {
    const found = [];
    for (const rule of SECRET_NAMES) if (rule.re.test(path)) found.push(rule.why);
    if (bytes && bytes.length <= MAX_SCAN_BYTES && looksText(bytes)) {
      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
      for (const rule of SECRET_CONTENT) if (rule.re.test(text)) found.push('contains ' + rule.why);
      if (/xmlns:wp="http:\/\/wordpress\.org\/export\//.test(text) && PII_WXR.test(text)) {
        found.push('a WordPress export with commenter e-mail or IP addresses (import it with --from-wxr, which drops them)');
      }
      for (const rule of WARN_CONTENT) if (rule.re.test(text)) warnings.push({ path, why: 'contains ' + rule.why });
    }
    for (const why of found) (allowed.has(path) ? warnings : errors).push({ path, why: allowed.has(path) ? why + ' (allowed by --allow-secret)' : why });
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// E3: --from-wxr (legacy comments without e-mail and IP)
// ---------------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

function unwrap(raw) {
  const s = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s);
  return cdata ? cdata[1] : decodeXml(s);
}

function tag(block, name) {
  const re = new RegExp('<' + name.replace(/[:.]/g, (c) => '\\' + c) + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name.replace(/[:.]/g, (c) => '\\' + c) + '>');
  const m = re.exec(block);
  return m ? unwrap(m[1]) : null;
}

function blocks(text, name) {
  const out = [];
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'g');
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Comment HTML → plain text (tags dropped, entities decoded, whitespace folded): safe to render as text. */
export function commentText(html) {
  const noTags = String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return decodeXml(noTags).replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeSlug(slug, id) {
  let s = String(slug || '');
  try {
    s = decodeURIComponent(s);
  } catch (_) { /* keep it */ }
  s = s.normalize('NFC').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,120}$/.test(s) && !/\.\.|[.]$/.test(s) ? s : 'post-' + String(id || '0').replace(/[^0-9]/g, '');
}

/**
 * importWxr(xmlText, { dir = 'comments' }) → { files: [{ path, bytes }], stats }
 * Reads a WordPress export (WXR) and keeps, per published post, the approved comments as
 * <dir>/<slug>.json = { v: 1, post: { id, slug, title, link }, comments: [{ id, parent, author, url, date, text }] }
 * plus <dir>/index.json. Dropped: every commenter e-mail address and IP address (they are in every
 * WXR, and a torrent is public and permanent), unapproved, spam and trashed comments, pingbacks and
 * trackbacks, and comments of posts that are not published. Comment HTML becomes plain text.
 * stats = { posts, comments, emails, ips, unapproved, pingbacks, unpublished }
 */
export function importWxr(xmlText, { dir = 'comments' } = {}) {
  const text = String(xmlText);
  if (!/xmlns:wp="http:\/\/wordpress\.org\/export\//.test(text) && !/<wp:wxr_version>/.test(text)) {
    throw new Error('not a WordPress export (no xmlns:wp="http://wordpress.org/export/..." and no <wp:wxr_version>)');
  }
  const stats = { posts: 0, comments: 0, emails: 0, ips: 0, unapproved: 0, pingbacks: 0, unpublished: 0 };
  const index = [];
  const files = [];
  const used = new Set();
  for (const item of blocks(text, 'item')) {
    const comments = blocks(item, 'wp:comment');
    if (!comments.length) continue;
    for (const c of comments) {
      if ((tag(c, 'wp:comment_author_email') || '').trim()) stats.emails++;
      if ((tag(c, 'wp:comment_author_IP') || '').trim()) stats.ips++;
    }
    const status = (tag(item, 'wp:status') || 'publish').trim();
    if (status !== 'publish') {
      stats.unpublished += comments.length;
      continue;
    }
    const id = (tag(item, 'wp:post_id') || '').trim();
    let slug = safeSlug(tag(item, 'wp:post_name'), id);
    while (used.has(slug)) slug = slug + '-' + id;
    const kept = [];
    for (const c of comments) {
      const approved = (tag(c, 'wp:comment_approved') || '').trim();
      const type = (tag(c, 'wp:comment_type') || '').trim();
      if (type === 'pingback' || type === 'trackback') {
        stats.pingbacks++;
        continue;
      }
      if (approved !== '1') {
        stats.unapproved++;
        continue;
      }
      const url = (tag(c, 'wp:comment_author_url') || '').trim();
      kept.push({
        id: (tag(c, 'wp:comment_id') || '').trim(),
        parent: ((tag(c, 'wp:comment_parent') || '0').trim() || '0'),
        author: (tag(c, 'wp:comment_author') || '').trim(),
        url: /^https?:\/\//i.test(url) ? url : null,
        date: (tag(c, 'wp:comment_date_gmt') || tag(c, 'wp:comment_date') || '').trim(),
        text: commentText(tag(c, 'wp:comment_content')),
      });
    }
    if (!kept.length) continue;
    used.add(slug);
    stats.posts++;
    stats.comments += kept.length;
    const post = { id, slug, title: (tag(item, 'title') || '').trim(), link: (tag(item, 'link') || '').trim() };
    const path = dir + '/' + slug + '.json';
    files.push({ path, bytes: Buffer.from(JSON.stringify({ v: 1, post, comments: kept }, null, 2) + '\n', 'utf8') });
    index.push({ slug, id, title: post.title, link: post.link, file: '/' + path, count: kept.length });
  }
  index.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  files.push({ path: dir + '/index.json', bytes: Buffer.from(JSON.stringify({ v: 1, source: 'wordpress-wxr', posts: index }, null, 2) + '\n', 'utf8') });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, stats };
}
