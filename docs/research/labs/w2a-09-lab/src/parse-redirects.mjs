// Reference parser for `_redirects` (research spike for w2a-09; not wired into src/).
//
// One grammar, three error policies, because the three families that honour this file name disagree:
//   flavor 'mw'         Netlify superset, lenient: a bad line is reported and skipped, the rest of the file still works.
//                       This is the recommended PUBLISH-TIME policy. The Service Worker should only ever read the compiled JSON.
//   flavor 'ipfs'       IPFS Web _redirects File Spec (2025-03-19) + the go-ipfs-redirects-file reference parser:
//                       strict, ANY bad line makes the whole file invalid (gateway answers 500 for every missing path).
//   flavor 'cloudflare' Cloudflare Pages / Workers static assets: default 302, only 301/302/303/307/308 redirects and 200 proxy,
//                       no query matching, no conditions, no 404/410/451, 2,000 static + 100 dynamic rules, 1,000 chars per rule.
//
// Output rule: { line, from, to, status, force, query, conditions }
//   status  number (default per flavor)
//   force   true only for Netlify "301!" style rules (never for ipfs; for cloudflare every rule behaves as forced, see `alwaysApplies`)

export const IPFS_STATUSES = Object.freeze([200, 301, 302, 303, 307, 308, 404, 410, 451]);
export const CF_REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);
export const IPFS_MAX_BYTES = 65536;            // 64 KiB, spec "Max File Size"
export const CF_MAX_STATIC = 2000;
export const CF_MAX_DYNAMIC = 100;
export const CF_MAX_LINE = 1000;

const enc = new TextEncoder();
const isUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

function placeholdersOf(from) {
  return (from.match(/:[A-Za-z_][A-Za-z0-9_]*/g) || []).map((s) => s.slice(1));
}

// Tokenise like Netlify's line_parser.js: whitespace separated, an inline "#..." token ends the line.
function tokens(line) {
  const toks = line.split(/\s+/).filter(Boolean);
  const hash = toks.findIndex((t) => t.startsWith('#'));
  return hash === -1 ? toks : toks.slice(0, hash);
}

// Netlify grammar:  from [query...] [to] [status[!]] [conditions...]
// "to" may be omitted only for forward rules (not supported here; reported).
function parseLine(line, flavor) {
  const [from, ...parts] = tokens(line);
  if (!parts.length) throw new Error('Missing destination path/URL');

  if (flavor === 'ipfs') {
    // go-ipfs-redirects-file: strings.Fields(line), 2 or 3 fields exactly
    if (parts.length > 2) throw new Error("must match format 'from to [status]'");
  }

  const statusLike = (t) => Number.isInteger(Number.parseInt(t, 10)) && /^\d+!?$/.test(t);
  let queryParts = [];
  let to;
  let rest;
  if (statusLike(parts[0])) {
    throw new Error('Forward rule (destination omitted) is not supported');
  } else {
    const toIndex = flavor === 'ipfs' ? 0 : parts.findIndex((t) => t.startsWith('/') || isUrl(t));
    if (toIndex === -1) throw new Error('The destination path/URL must start with "/", "http:" or "https:"');
    queryParts = parts.slice(0, toIndex);
    to = parts[toIndex];
    rest = parts.slice(toIndex + 1);
  }
  const [statusTok, ...condParts] = rest;

  const pairs = (xs) => Object.fromEntries(xs.map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; }));

  let status;
  let force = false;
  if (statusTok !== undefined) {
    if (statusTok.endsWith('!')) {
      if (flavor === 'ipfs') throw new Error('forced redirects (or "shadowing") are not supported');
      force = true;
    }
    if (!/^\d+!?$/.test(statusTok)) throw new Error(`parsing status "${statusTok}": not an integer`);
    status = Number.parseInt(statusTok, 10);
  }
  return { from, to, status, force, query: pairs(queryParts), conditions: pairs(condParts) };
}

function validate(rule, flavor) {
  const { from, to, status } = rule;
  const issues = [];
  const err = (m) => issues.push({ level: 'error', message: m });
  const warn = (m) => issues.push({ level: 'unsupported', message: m });

  if (!from.startsWith('/')) {
    if (isUrl(from)) warn('domain-level rule (from is a URL): host redirects only, not representable in a single-origin Service Worker');
    else err("parsing 'from': path must begin with '/'");
  }
  const stars = (from.match(/\*/g) || []).length;
  if (stars > 1) err("path can have at most one asterisk");
  else if (stars === 1 && !from.endsWith('*')) err('path must end with asterisk');

  const ph = placeholdersOf(from);
  if (new Set(ph).size !== ph.length) err('same placeholder name used more than once in from');

  // go-ipfs-redirects-file parseTo(): a path, or a URL whose scheme is one of http, https, ipfs, ipns
  if (flavor === 'ipfs' && !to.startsWith('/') && !/^(https?|ipfs|ipns):/i.test(to)) err("parsing 'to': invalid URL scheme");

  const allowed = flavor === 'cloudflare' ? [...CF_REDIRECT_STATUSES, 200] : IPFS_STATUSES;
  if (!allowed.includes(status)) {
    if (flavor === 'cloudflare' && [404, 410, 451].includes(status)) warn(`status ${status}: Cloudflare supports no rewrite-style statuses ("other status codes" are not supported)`);
    else err(`status code ${status} is not supported`);
  }
  if (status === 200 && isUrl(to)) {
    warn('200 rewrite to an external URL (Netlify proxy): needs a server; a browser would need CORS. Not representable in a Service Worker');
  }
  if (flavor !== 'ipfs' && Object.keys(rule.conditions).length) warn(`conditions ${Object.keys(rule.conditions).join(',')} (Country/Language/Role/Cookie/Sign) are not evaluated`);
  if (flavor === 'cloudflare') {
    if (Object.keys(rule.query).length) warn('query matching is not supported by Cloudflare');
    if (rule.force) err('"!" is not part of the Cloudflare grammar');
  }
  return issues;
}

export function parseRedirects(text, { flavor = 'mw' } = {}) {
  const diagnostics = [];
  const rules = [];
  const bytes = enc.encode(text).length;
  let fatal = false;

  if (flavor === 'ipfs' && bytes > IPFS_MAX_BYTES) {
    return { rules: [], diagnostics: [{ line: 0, level: 'error', message: `redirects file size cannot exceed ${IPFS_MAX_BYTES} bytes (is ${bytes})` }], fatal: true, bytes };
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const n = i + 1;
    if (flavor === 'cloudflare' && line.length > CF_MAX_LINE) {
      diagnostics.push({ line: n, level: 'error', message: `rule is ${line.length} characters, Cloudflare allows ${CF_MAX_LINE}` });
      return;
    }
    let rule;
    try {
      rule = parseLine(line, flavor);
    } catch (e) {
      diagnostics.push({ line: n, level: 'error', message: e.message });
      if (flavor === 'ipfs') fatal = true;
      return;
    }
    if (rule.status === undefined) rule.status = flavor === 'cloudflare' ? 302 : 301;
    const issues = validate(rule, flavor);
    for (const is of issues) diagnostics.push({ line: n, ...is });
    const blocking = issues.some((x) => x.level === 'error' || x.level === 'unsupported');
    if (issues.some((x) => x.level === 'error') && flavor === 'ipfs') fatal = true;
    if (blocking) return;
    rules.push({ line: n, ...rule, alwaysApplies: flavor === 'cloudflare' });
  });

  if (flavor === 'mw' && bytes > IPFS_MAX_BYTES) {
    diagnostics.push({ line: 0, level: 'warn', message: `file is ${bytes} bytes; IPFS gateways reject a _redirects file above ${IPFS_MAX_BYTES} bytes (spec "Max File Size")` });
  }
  if (flavor === 'cloudflare') {
    const dyn = rules.filter((r) => /[*:]/.test(r.from)).length;
    const stat = rules.length - dyn;
    if (stat > CF_MAX_STATIC) diagnostics.push({ line: 0, level: 'error', message: `${stat} static rules, Cloudflare allows ${CF_MAX_STATIC}` });
    if (dyn > CF_MAX_DYNAMIC) diagnostics.push({ line: 0, level: 'error', message: `${dyn} dynamic rules, Cloudflare allows ${CF_MAX_DYNAMIC}` });
  }
  if (fatal) return { rules: [], diagnostics, fatal: true, bytes };
  return { rules, diagnostics, fatal: false, bytes };
}

// ---- matching -------------------------------------------------------------------------------------------------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Canonicalise the literal parts of a rule path the way URL parsing canonicalises a request path,
// so "/café" in the rule matches "/caf%C3%A9" in url.pathname. ":" and "*" survive URL parsing.
function canonLiteral(seg) {
  try { return new URL('http://x/' + seg).pathname.slice(1); } catch { return seg; }
}

export function compileFrom(from) {
  const trimmed = from.length > 1 ? from.replace(/\/$/, '') : from;
  const segs = trimmed.split('/').slice(1);      // drop the leading ''
  const names = [];
  let splat = false;
  const parts = segs.map((seg, i) => {
    if (seg === '*' && i === segs.length - 1) { splat = true; names.push('splat'); return '(.*)'; }
    if (seg.startsWith(':') && /^:[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) { names.push(seg.slice(1)); return '([^/]+)'; }
    return esc(canonLiteral(seg));
  });
  // "/blog/*" also matches the bare "/blog" (zero segments). UNVERIFIED against Netlify/IPFS; see report Open questions.
  let src;
  if (splat) {
    const head = parts.slice(0, -1).join('/');
    src = '^/' + (head ? head + '(?:/(.*))?' : '(.*)') + '$';
  } else {
    src = '^/' + parts.join('/') + '$';
  }
  return { re: new RegExp(src), names };
}

// Returns null or { to, status } with placeholders expanded and the user's query merged (user wins, IPFS spec "Query Parameters").
export function matchRedirect(rule, pathname, search = '') {
  const norm = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;   // Netlify and IPFS ignore one trailing slash
  const { re, names } = rule._c || (rule._c = compileFrom(rule.from));
  const m = re.exec(norm);
  if (!m) return null;

  // Netlify query matching: "/store id=:id" matches only URLs that carry exactly those parameters
  const q = new URLSearchParams(search);
  const qkeys = Object.keys(rule.query || {});
  const caps = {};
  names.forEach((n, i) => { caps[n] = m[i + 1] ?? ''; });
  if (qkeys.length) {
    if ([...q.keys()].length !== qkeys.length) return null;
    for (const k of qkeys) {
      if (!q.has(k)) return null;
      const want = rule.query[k];
      if (want.startsWith(':')) caps[want.slice(1)] = q.get(k);
      else if (want !== q.get(k)) return null;
    }
  }

  let to = rule.to.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (all, name) => (Object.prototype.hasOwnProperty.call(caps, name) ? caps[name] : all));
  if (rule.status !== 200 && !qkeys.length) {
    // merge queries: user's dynamic values override static ones
    const qi = to.indexOf('?');
    const base = qi < 0 ? to : to.slice(0, qi);
    const staticQ = new URLSearchParams(qi < 0 ? '' : to.slice(qi + 1));
    for (const [k, v] of q) { staticQ.delete(k); }
    const merged = new URLSearchParams();
    for (const [k, v] of q) merged.append(k, v);
    for (const [k, v] of staticQ) merged.append(k, v);
    const s = merged.toString();
    to = base + (s ? '?' + s : '');
  }
  return { to, status: rule.status };
}
