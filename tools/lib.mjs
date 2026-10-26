// tools/lib.mjs: helpers shared by the Node tools (ARCHITECTURE §10). Node >= 22 only: this file
// may use node: modules, unlike src/common and src/chain.
//
//   parseCli(argv, spec)            small, strict flag parser (repeatable flags, --tls cert key)
//   runMain(fn)                     uniform error reporting and exit codes (2 = usage, 1 = failure)
//   loadOwnerKey(file)              refuses group- or world-readable key files (DESIGN-REVIEW S12)
//   walkFiles(root, { skip })       deterministic recursive listing without following symlinks
//   injectMeta(html, metas)         idempotent <meta> stamping as the first child of <head>
//   isLoopbackHost / isLoopbackUrl  the network policy of docs/DEV-NETWORK.md
//   devCerts(...)                   mkcert certificates for --tls (generated locally, never fetched)

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, statSync, lstatSync, readdirSync, existsSync,
  realpathSync, rmSync, copyFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

import { importPrivateJwk, publicFromPrivateJwk, fingerprint } from '../src/chain/crypto.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TOOLS_VERSION = '0.3.0'; // matches CONFIG.version and SDK_VERSION (integration I-6)
export const PIECE_LENGTH = 262144;
// v0.2 anchor torrent constants, unused since v0.2.1 B2 (the ledger swarm is a bare rendezvous infohash).
export const ANCHOR_NAME = 'mw-ledger';
export const ANCHOR_PIECE_LENGTH = 16384;
/** Where --tls looks for (and mkcert writes) development certificates; listed in .gitignore. */
export const DEV_CERT_DIR = '.mw-dev-certs';

// ---------------------------------------------------------------------------------------------
// errors, main
// ---------------------------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

export class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ToolError';
    this.exitCode = exitCode;
  }
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === metaUrl;
  } catch (_) {
    return false;
  }
}

/**
 * runMain(fn, usage): runs fn(argv) and maps errors to exit codes: UsageError prints the usage
 * and exits 2, ToolError and others print one line and exit with err.exitCode or 1. A numeric
 * return value becomes the exit code; nothing else exits the process (servers keep running).
 */
export function runMain(fn, usage = '') {
  Promise.resolve()
    .then(() => fn(process.argv.slice(2)))
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof UsageError) {
        process.stderr.write('error: ' + err.message + '\n');
        if (usage) process.stderr.write('\n' + usage.trim() + '\n');
        process.exitCode = 2;
        return;
      }
      process.stderr.write('error: ' + (err && err.message ? err.message : String(err)) + '\n');
      if (process.env.MW_DEBUG && err && err.stack) process.stderr.write(err.stack + '\n');
      process.exitCode = err && Number.isInteger(err.exitCode) ? err.exitCode : 1;
    });
}

// ---------------------------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------------------------

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * parseCli(argv, spec) → { flags, positionals }
 * spec: { 'flag-name': { type, alias, default } } with type one of
 *   'string'   --x value | --x=value
 *   'int'      a non-negative integer (also --x=value)
 *   'boolean'  --x | --no-x | --x=true|false
 *   'list'     repeatable string, collected in order
 *   'tls'      --tls (boolean) or --tls <cert> <key>
 * Flags are returned in camelCase. Unknown flags, missing values and bad integers throw
 * UsageError. '--' ends flag parsing. '-h' and '--help' set flags.help.
 */
export function parseCli(argv, spec) {
  const byName = new Map();
  for (const name of Object.keys(spec)) {
    byName.set(name, name);
    const alias = spec[name].alias;
    if (alias) for (const a of [].concat(alias)) byName.set(a, name);
  }
  const flags = {};
  for (const name of Object.keys(spec)) {
    const s = spec[name];
    const key = camel(name);
    if (s.type === 'list') flags[key] = Array.isArray(s.default) ? s.default.slice() : [];
    else if (s.default !== undefined) flags[key] = s.default;
    else if (s.type === 'boolean') flags[key] = false;
    else flags[key] = null;
  }
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok === '-h' || tok === '--help') {
      flags.help = true;
      continue;
    }
    if (!tok.startsWith('--') || tok === '--') {
      positionals.push(tok);
      continue;
    }
    let body = tok.slice(2);
    let inline = null;
    const eq = body.indexOf('=');
    if (eq >= 0) {
      inline = body.slice(eq + 1);
      body = body.slice(0, eq);
    }
    let negated = false;
    let name = byName.get(body);
    if (!name && body.startsWith('no-') && byName.has(body.slice(3)) && spec[byName.get(body.slice(3))].type === 'boolean') {
      name = byName.get(body.slice(3));
      negated = true;
    }
    if (!name) throw new UsageError('unknown option --' + body);
    const s = spec[name];
    const key = camel(name);
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) throw new UsageError('--' + name + ' needs a value');
      i += 1;
      return next;
    };
    switch (s.type) {
      case 'boolean':
        if (inline !== null) {
          if (!/^(true|false|1|0|yes|no)$/i.test(inline)) throw new UsageError('--' + name + ' takes true or false');
          flags[key] = /^(true|1|yes)$/i.test(inline);
        } else {
          flags[key] = !negated;
        }
        break;
      case 'string':
        flags[key] = takeValue();
        break;
      case 'int': {
        const raw = takeValue();
        if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) throw new UsageError('--' + name + ' must be a non-negative integer, got ' + JSON.stringify(raw));
        const n = Number(raw);
        if (!Number.isSafeInteger(n)) throw new UsageError('--' + name + ' is too large');
        flags[key] = n;
        break;
      }
      case 'list':
        flags[key].push(takeValue());
        break;
      case 'tls': {
        if (inline !== null) throw new UsageError('use --tls or --tls <cert> <key>');
        const a = argv[i + 1];
        const b = argv[i + 2];
        if (a !== undefined && b !== undefined && !a.startsWith('-') && !b.startsWith('-')) {
          flags[key] = { cert: a, key: b };
          i += 2;
        } else {
          flags[key] = true;
        }
        break;
      }
      default:
        throw new Error('parseCli: unknown type ' + s.type);
    }
  }
  return { flags, positionals };
}

// ---------------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------------

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha384Base64(bytes) {
  return createHash('sha384').update(bytes).digest('base64');
}

/** Writes through a temporary file in the same directory, then renames (no torn files). */
export function writeFileAtomic(file, data, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), '.' + Math.random().toString(36).slice(2) + '.tmp');
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Copies a directory tree (files only; symlinks are skipped). */
export function copyTree(from, to, { skip = null } = {}) {
  for (const f of walkFiles(from, { skip })) {
    const dest = join(to, ...f.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }
}

export function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Byte order of the UTF-8 encodings (locale-independent and stable across engines). */
export function compareUtf8(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return Buffer.compare(x, y);
}

/**
 * walkFiles(root, { skip }) → [{ path, abs, size }] sorted by UTF-8 byte order of `path`
 * (posix separators, relative to root). Directories are entered unless skip(rel, true) returns a
 * reason; files are kept unless skip(rel, false) returns one. Symbolic links and special files
 * are never followed; they are reported through `onSkip(rel, reason)`.
 */
export function walkFiles(root, { skip = null, onSkip = null } = {}) {
  const out = [];
  const visit = (dirAbs, dirRel) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      throw new ToolError('cannot read directory ' + dirAbs + ': ' + err.message);
    }
    for (const ent of entries) {
      const rel = dirRel ? dirRel + '/' + ent.name : ent.name;
      const abs = join(dirAbs, ent.name);
      if (ent.isSymbolicLink()) {
        if (onSkip) onSkip(rel, 'symbolic link (not followed)');
        continue;
      }
      if (ent.isDirectory()) {
        const reason = skip ? skip(rel, true) : null;
        if (reason) {
          if (onSkip) onSkip(rel + '/', reason);
          continue;
        }
        visit(abs, rel);
      } else if (ent.isFile()) {
        const reason = skip ? skip(rel, false) : null;
        if (reason) {
          if (onSkip) onSkip(rel, reason);
          continue;
        }
        out.push({ path: rel, abs, size: statSync(abs).size });
      } else if (onSkip) {
        onSkip(rel, 'not a regular file');
      }
    }
  };
  visit(resolve(root), '');
  out.sort((a, b) => compareUtf8(a.path, b.path));
  return out;
}

/** True when `child` is inside `parent` (both resolved), or equal to it. */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

// ---------------------------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------------------------

/** Throws unless the key file exists, is a regular file and is not readable by group or others. */
export function assertPrivateKeyFile(file) {
  let st;
  try {
    st = statSync(file);
  } catch (_) {
    throw new ToolError('key file not found: ' + file + ' (create one with: node tools/keygen.mjs --out ' + file + ')');
  }
  if (!st.isFile()) throw new ToolError('key file is not a regular file: ' + file);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new ToolError('refusing ' + file + ': it is readable or writable by group or others (mode ' +
      (st.mode & 0o777).toString(8) + '). Run: chmod 600 ' + file);
  }
  return st;
}

/**
 * loadOwnerKey(file) → { privateKey (non-extractable CryptoKey), pub, fingerprint }
 * Refuses group- or world-readable files. The JWK never leaves this function.
 */
export async function loadOwnerKey(file) {
  assertPrivateKeyFile(file);
  let jwk;
  try {
    jwk = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ToolError(file + ' is not a JSON Web Key: ' + err.message);
  }
  let privateKey;
  let pub;
  try {
    privateKey = await importPrivateJwk(jwk);
    pub = await publicFromPrivateJwk(jwk);
  } catch (err) {
    throw new ToolError(file + ' is not a P-256 private key: ' + err.message);
  }
  return { privateKey, pub, fingerprint: await fingerprint(pub) };
}

// ---------------------------------------------------------------------------------------------
// network policy (docs/DEV-NETWORK.md)
// ---------------------------------------------------------------------------------------------

export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isLoopbackUrl(url) {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

/** IPv4 addresses of this machine's non-internal interfaces (for --tls LAN testing). */
export function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a && (a.family === 'IPv4' || a.family === 4) && !a.internal && out.indexOf(a.address) < 0) out.push(a.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTML meta stamping (publish --dropin, dev-server --pointer/--dev)
// ---------------------------------------------------------------------------------------------

/** Attribute-safe HTML text: & " < > escaped (the SW and the loader decode character references). */
export function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (whole, dec, hx, name) => {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hx, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// Parses the attributes of a tag starting at `start` ('<'), quote-aware. → { name, attrs, end } | null
function readTagAt(html, start) {
  const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(start, start + 64));
  if (!m) return null;
  const name = m[1].toLowerCase();
  const attrs = new Map();
  let i = start + m[0].length;
  const n = html.length;
  for (;;) {
    while (i < n && /[\s/]/.test(html[i])) i++;
    if (i >= n) return null;
    if (html[i] === '>') return { name, attrs, start, end: i + 1 };
    const nm = /^[^\s"'>/=]+/.exec(html.slice(i, i + 256));
    if (!nm) {
      i++;
      continue;
    }
    const an = nm[0].toLowerCase();
    i += nm[0].length;
    while (i < n && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close < 0) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const vm = /^[^\s>]*/.exec(html.slice(i));
        value = vm[0];
        i += value.length;
      }
    }
    if (!attrs.has(an)) attrs.set(an, decodeEntities(value));
  }
}

/**
 * scanTags(html) → [{ name, attrs, start, end }] for every start tag outside comments, with the
 * raw text of <script>, <style>, <textarea> and <title> skipped. Works on any ASCII-compatible
 * encoding (callers pass latin1 strings to keep bytes exact).
 */
export function scanTags(html, { stopAt = Infinity } = {}) {
  const tags = [];
  const n = Math.min(html.length, stopAt);
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt >= n) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?' || html[lt + 1] === '/') {
      const close = html.indexOf('>', lt + 1);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const tag = readTagAt(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    tags.push(tag);
    i = tag.end;
    if (tag.name === 'script' || tag.name === 'style' || tag.name === 'textarea' || tag.name === 'title') {
      const re = new RegExp('</' + tag.name + '\\s*>', 'ig');
      re.lastIndex = i;
      const m = re.exec(html);
      i = m ? m.index + m[0].length : html.length;
    }
  }
  return tags;
}

function isCharsetMeta(tag) {
  if (tag.name !== 'meta') return false;
  if (tag.attrs.has('charset')) return true;
  const he = tag.attrs.get('http-equiv');
  return typeof he === 'string' && he.trim().toLowerCase() === 'content-type';
}

// Length of a leading byte order mark: U+FEFF in a decoded string, or EF BB BF in a latin1 one.
function bomLength(s) {
  if (s.charCodeAt(0) === 0xfeff) return 1;
  if (s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb && s.charCodeAt(2) === 0xbf) return 3;
  return 0;
}

/**
 * injectMeta(html, metas) → { html, changed, end }
 * Removes every existing <meta name="<name>"> for the given names and inserts
 * `<meta name="<name>" content="<content>">` tags as the first children of <head>; a leading
 * <meta charset> (or http-equiv Content-Type) keeps its place first, because browsers look for
 * the charset in the first 1024 bytes only. Without a <head> tag the metas go right after <html>
 * (or the doctype), where the parser opens the head implicitly. Idempotent: injecting the same
 * metas into the output again returns it unchanged. `html` should be a latin1 (binary) string so
 * any ASCII-compatible encoding round-trips byte for byte. `end` is the offset just past the
 * inserted tags.
 */
export function injectMeta(html, metas) {
  const names = new Set(metas.map((m) => m.name.toLowerCase()));
  // 1. remove existing tags with these names (last to first so offsets stay valid)
  let out = html;
  const existing = scanTags(out).filter((t) => t.name === 'meta' && names.has(String(t.attrs.get('name') || '').trim().toLowerCase()));
  for (let k = existing.length - 1; k >= 0; k--) out = out.slice(0, existing[k].start) + out.slice(existing[k].end);
  // 2. insertion point
  const tags = scanTags(out);
  const head = tags.find((t) => t.name === 'head');
  let at;
  if (head) at = head.end;
  else {
    const htmlTag = tags.find((t) => t.name === 'html');
    if (htmlTag) at = htmlTag.end;
    else {
      const bom = bomLength(out);
      const doctype = /^\s*<!doctype[^>]*>/i.exec(out.slice(bom));
      at = bom + (doctype ? doctype[0].length : 0);
    }
  }
  const next = tags.find((t) => t.start >= at);
  if (next && isCharsetMeta(next) && /^\s*$/.test(out.slice(at, next.start))) at = next.end;
  const text = metas.map((m) => '<meta name="' + escapeAttr(m.name) + '" content="' + escapeAttr(m.content) + '">').join('');
  const result = out.slice(0, at) + text + out.slice(at);
  return { html: result, changed: result !== html, end: at + text.length };
}

/** Reads the content of the first <meta name="<name>"> outside comments, or null. */
export function readMeta(html, name) {
  const want = name.toLowerCase();
  const tag = scanTags(html).find((t) => t.name === 'meta' && String(t.attrs.get('name') || '').trim().toLowerCase() === want);
  return tag && tag.attrs.has('content') ? tag.attrs.get('content') : null;
}

/** True when the bytes look like UTF-16 (we only stamp ASCII-compatible documents). */
export function isUtf16(buf) {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
}

// ---------------------------------------------------------------------------------------------
// development certificates (--tls)
// ---------------------------------------------------------------------------------------------

function commandExists(cmd) {
  const paths = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const p of paths) {
    for (const ext of exts) {
      try {
        if (p && statSync(join(p, cmd + ext)).isFile()) return join(p, cmd + ext);
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

function certCovers(certPem, hosts) {
  try {
    const x = new X509Certificate(certPem);
    const san = String(x.subjectAltName || '');
    const notAfter = Date.parse(x.validTo);
    if (Number.isFinite(notAfter) && notAfter < Date.now() + 86400000) return false;
    return hosts.every((h) => san.indexOf('DNS:' + h) >= 0 || san.indexOf('IP Address:' + h) >= 0 ||
      (h === '::1' && /IP Address:0:0:0:0:0:0:0:1|IP Address:::1/i.test(san)));
  } catch (_) {
    return false;
  }
}

/**
 * devCerts({ dir, hosts, cert, key }) → { cert: pem, key: pem, certFile, keyFile, generated }
 * Explicit cert/key files win. Otherwise <dir>/cert.pem and key.pem are used when they cover
 * every host; if not, and mkcert is installed, they are (re)generated locally with mkcert
 * (no network; mkcert creates its local CA on first use but never installs it). Throws with
 * instructions when no certificate is available.
 */
export function devCerts({ dir = join(ROOT, DEV_CERT_DIR), hosts = ['localhost', '127.0.0.1', '::1'], cert = null, key = null } = {}) {
  if (cert || key) {
    if (!cert || !key) throw new ToolError('--tls needs both a certificate and a key file');
    return { cert: readFileSync(cert), key: readFileSync(key), certFile: cert, keyFile: key, generated: false };
  }
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  if (existsSync(certFile) && existsSync(keyFile) && certCovers(readFileSync(certFile), hosts)) {
    return { cert: readFileSync(certFile), key: readFileSync(keyFile), certFile, keyFile, generated: false };
  }
  const mkcert = commandExists('mkcert');
  if (!mkcert) {
    throw new ToolError('--tls needs a certificate for ' + hosts.join(', ') + '. Install mkcert (https://github.com/FiloSottile/mkcert), ' +
      'run "mkcert -install" once, then run this command again; or pass explicit files (--cert, --key).');
  }
  mkdirSync(dir, { recursive: true });
  execFileSync(mkcert, ['-cert-file', certFile, '-key-file', keyFile, ...hosts], { stdio: ['ignore', 'ignore', 'inherit'] });
  return { cert: readFileSync(certFile), key: readFileSync(keyFile), certFile, keyFile, generated: true };
}

/** The mkcert root CA location, for the "install this on your phone" hint (null when unknown). */
export function mkcertCaRoot() {
  const mkcert = commandExists('mkcert');
  if (!mkcert) return null;
  try {
    return execFileSync(mkcert, ['-CAROOT'], { encoding: 'utf8' }).trim() || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------------------------

export function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return n + ' B';
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[u];
}

export function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Lines for terminal output; tools never print private material. */
export function out(line = '') {
  process.stdout.write(line + '\n');
}

export function warn(line) {
  process.stderr.write('warning: ' + line + '\n');
}

export function relPath(p) {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

export function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (_) {
    return null;
  }
}
