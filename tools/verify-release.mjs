#!/usr/bin/env node
// tools/verify-release.mjs: the signed per-file hash list of a release (V03-DESIGN-REVIEW 2.19, SC-1, SC-8, MF-78). Offline: no
// command here opens a socket, so it can run on a machine that never leaves its network.
//
//   node tools/verify-release.mjs list   <dir> --out hashes.json [--version <v>] [--tree dist]       (CI: the unsigned list)
//   node tools/verify-release.mjs sign   --list hashes.json --rebuilt <own build> --key release.jwk --out hashes.json.sig   (the owner, offline)
//   node tools/verify-release.mjs verify <dir> --list hashes.json --sig hashes.json.sig (--key <file> | --pubkey p256:...)
//                                       (--expect-version <v> | --min-version <v> | --any-version) [--allow-extra | --door-kit]
//
// The list is { v: 1, kind: 'mw-release-files', name, version, tree, files: [{ path, bytes, sha256 }] } with the files sorted by the UTF-8
// bytes of the path. The signature is ECDSA P-256 / SHA-256 (the raw 64-byte r || s, base64url) over utf8("mw-release-v1\n" + JCS(list)),
// RFC 8785 as for every signed object. The key that signs it is the release key, and its public half is pinned in README.md,
// SECURITY.md and PINNED_RELEASE_KEYS below, with the second places SECURITY.md names (they need no domain); "verify" takes that pinned key and nothing from the network, so a
// replaced release asset, a swapped file or a changed byte fails here. The key in the signature file is informational: it must equal
// the pinned key, and the pinned key alone decides.
//
// Review round (2026-10-24): verify names the release it accepted and refuses one older than, or other than, the version the person
// expects (SEC-6: a genuine older signed release is a rollback); a key in RETIRED_RELEASE_KEYS is refused, and once
// PINNED_RELEASE_KEYS holds the project's key a list signed by any other key is refused even when --pubkey names it (SUP-2, SUP-12);
// sign compares the list with a build made on the signing machine and signs nothing else (SUP-3); with --allow-extra the extra files
// are named, and host settings (_headers, _redirects, vercel.json, ...) or code under _mw/ outside the list fail (SEC-5).

import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

import { canonicalize, b64url, utf8 } from '../src/chain/canonical.js';
import { isPublicKeyString, publicFromPrivateJwk, sign, verify, fingerprint } from '../src/chain/crypto.js';
import { parseCli, runMain, isMain, loadOwnerKey, walkFiles, writeFileAtomic, assertPrivateKeyFile, ToolError, UsageError, out, warn } from './lib.mjs';
import { doorKitFiles } from './door-kit-files.mjs';

/**
 * The release keys this copy of the tools trusts (SUP-2). The project's release key goes here when it is made (docs/PUBLISH-CHECKLIST.md,
 * "Release key"), so an installed copy already knows it: verify then refuses a list signed by any other key, whatever --pubkey says.
 * Empty until the key exists: verify then trusts the key it is given and says so.
 */
export const PINNED_RELEASE_KEYS = Object.freeze(['p256:BCHNewmajl6XLH2R_GitiO3TJ5bQQQCEK6ljHGk-y5ZBnZ7iVk_dnkRQWcMrvy-LAbwQ5UTfQTBOpDKxz-YvtS4']);
/** Release keys that must never verify again (a lost or leaked key; docs/OPERATIONS.md, "A lost or leaked release key"). */
export const RETIRED_RELEASE_KEYS = Object.freeze([]);

/**
 * Names a static host reads as its settings (SEC-5): an unlisted file of one of these names would change what the host serves, so it
 * fails verify even with --allow-extra, unless it is byte for byte the file the door kit makes (--door-kit).
 */
export const HOST_SETTINGS_NAMES = new Set([
  '_headers', '_redirects', '_routes.json', '_worker.js', 'vercel.json', 'netlify.toml', 'caddyfile', '.htaccess', 'nginx.conf',
  'staticwebapp.config.json', 'firebase.json', 'web.config', 'app.yaml', 'now.json',
]);
// Unlisted files a door kit may hold under _mw/: the torrents of its sites (hash-checked by the loader when used).
const KIT_MW_EXTRA = /^_mw\/t\/[0-9a-f]{40}\.torrent$/;

const USAGE = `
Usage:
  node tools/verify-release.mjs list   <dir> --out <hashes.json> [--version <v>] [--tree <name>] [--name <name>]
  node tools/verify-release.mjs sign   --list <hashes.json> --rebuilt <dir> --key <release key file> --out <hashes.json.sig>
  node tools/verify-release.mjs verify <dir> --list <hashes.json> --sig <hashes.json.sig> (--key <public key file> | --pubkey <p256:...>)
                                       (--expect-version <v> | --min-version <v> | --any-version) [--expect-tree <name>] [--expect-name <name>]
                                       [--allow-extra | --door-kit] [--allow-unpinned-key] [--json]

list     hashes every file under <dir> (no symbolic links) into the per-file list; --version defaults to the version in <dir>/build.json.
sign     signs that list with the release key (a P-256 key file made by tools/keygen.mjs), offline; keep the key offline. --rebuilt
         names the same tree built on this machine from the tag (node build.mjs --strict, npm run build:idp): the list is signed only
         when it equals the list of that build byte for byte. --skip-rebuild-check signs without it (and says so).
verify   checks the signature with the PINNED public key, then the version, then every file: a changed byte, a missing file, an extra
         file (unless --allow-extra), the wrong key or an older or other version fails, and the exit code is 1. --expect-version
         names the release you meant to get; --min-version accepts it or a newer one; --any-version skips the check (a genuine older
         release then passes). --allow-extra names every extra file and still fails on host settings (_headers, _redirects,
         vercel.json, ...) and on code under _mw/; --door-kit accepts the host settings a door kit makes, byte for byte, and nothing
         else. Nothing is read from the network. Without --key and --pubkey the release key built into this copy is used.
The pinned key is a file with the public key (p256:...), a public JWK or the key file itself, or --pubkey with the key text.
`;

/** Domain-separation prefix of the signed text (a new purpose gets a new prefix, R 2.10.3). */
export const RELEASE_PREFIX = 'mw-release-v1\n';
export const LIST_KIND = 'mw-release-files';
export const SIG_ALG = 'ES256-P1363';

const HEX64 = /^[0-9a-f]{64}$/;
const SIG_B64 = /^[A-Za-z0-9_-]{86}$/;
const sha256File = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cmpUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A path in a list: relative, forward slashes, no empty, dot or dot-dot segment, no backslash or control character, NFC. */
export function listPathProblem(path) {
  if (typeof path !== 'string' || !path) return 'empty path';
  if (path.startsWith('/')) return 'absolute path';
  if (path.indexOf('\\') >= 0) return 'backslash';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'control character';
  if (path.normalize('NFC') !== path) return 'not NFC';
  for (const seg of path.split('/')) if (seg === '' || seg === '.' || seg === '..') return 'empty or dot segment';
  return null;
}

/**
 * buildHashList({ dir, version, tree, name }) → the unsigned list. Every regular file under dir is hashed; a symbolic link or any
 * other kind of entry is a ToolError (a release tree has none).
 */
export function buildHashList({ dir, version, tree = 'dist', name = 'felinar' } = {}) {
  if (!dir || !existsSync(dir)) throw new ToolError('no such directory: ' + dir);
  const skipped = [];
  const found = walkFiles(dir, { onSkip: (rel, reason) => skipped.push(rel + ' (' + reason + ')') });
  if (skipped.length) throw new ToolError('a release tree holds only regular files; found ' + skipped.slice(0, 5).join(', ') + (skipped.length > 5 ? ', ...' : ''));
  if (!found.length) throw new ToolError(dir + ' holds no files');
  let v = version;
  if (!v) {
    try {
      v = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')).version;
    } catch (_) { /* below */ }
  }
  if (typeof v !== 'string' || !v) throw new ToolError('no version: pass --version (the tree has no build.json)');
  const files = found.map((f) => {
    const problem = listPathProblem(f.path);
    if (problem) throw new ToolError('cannot list ' + JSON.stringify(f.path) + ' (' + problem + ')');
    const bytes = readFileSync(f.abs);
    return { path: f.path, bytes: bytes.length, sha256: sha256File(bytes) };
  });
  return { v: 1, kind: LIST_KIND, name, version: v, tree, files };
}

/** canonicalList(list) → the exact bytes that are signed: utf8("mw-release-v1\n" + JCS(list)). */
export function signedText(list) {
  return RELEASE_PREFIX + canonicalize(list);
}

/** listHash(list) → hex SHA-256 of the canonical list: the one number that names a whole tree (the identity bundle hash of a release). */
export function listHash(list) {
  return createHash('sha256').update(canonicalize(list), 'utf8').digest('hex');
}

/** checkList(list) → [problem]: the shape of a list, strictly. */
export function checkList(list) {
  const problems = [];
  if (!list || typeof list !== 'object' || Array.isArray(list)) return ['the list is not an object'];
  if (list.v !== 1) problems.push('unsupported list version ' + JSON.stringify(list.v));
  if (list.kind !== LIST_KIND) problems.push('not a release hash list (kind ' + JSON.stringify(list.kind) + ')');
  for (const k of ['name', 'version', 'tree']) if (typeof list[k] !== 'string' || !list[k]) problems.push(k + ' is missing');
  if (!Array.isArray(list.files) || list.files.length === 0) {
    problems.push('files is empty');
    return problems;
  }
  const seen = new Set();
  let last = null;
  for (const f of list.files) {
    if (!f || typeof f !== 'object') {
      problems.push('a file entry is not an object');
      continue;
    }
    const bad = listPathProblem(f.path);
    if (bad) problems.push(JSON.stringify(f.path) + ': ' + bad);
    else if (seen.has(f.path)) problems.push(f.path + ': listed twice');
    else seen.add(f.path);
    if (!HEX64.test(String(f.sha256))) problems.push(f.path + ': sha256 is not 64 lowercase hex characters');
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) problems.push(f.path + ': bytes is not a size');
    if (last !== null && typeof f.path === 'string' && cmpUtf8(last, f.path) >= 0) problems.push(f.path + ': the files are not sorted by the UTF-8 bytes of the path');
    last = typeof f.path === 'string' ? f.path : last;
    for (const k of Object.keys(f)) if (k !== 'path' && k !== 'bytes' && k !== 'sha256') problems.push(f.path + ': unknown field ' + k);
  }
  for (const k of Object.keys(list)) if (['v', 'kind', 'name', 'version', 'tree', 'files'].indexOf(k) < 0) problems.push('unknown field ' + k);
  return problems;
}

/** signList(list, { privateKey, pub }) → the signature file object { v, alg, key, sig }. */
export async function signList(list, { privateKey, pub }) {
  const problems = checkList(list);
  if (problems.length) throw new ToolError('the list is not valid: ' + problems.slice(0, 3).join('; '));
  if (!isPublicKeyString(pub)) throw new ToolError('the signing key is not a P-256 key');
  const sig = b64url.encode(await sign(privateKey, utf8.encode(signedText(list))));
  return { v: 1, alg: SIG_ALG, key: pub, sig };
}

/**
 * readPublicKey(file) → the tagged public key: a text file with p256:..., a public or private JWK, or a key file. Only the public
 * half is read.
 */
export async function readPublicKey(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ToolError('cannot read the key file ' + file + ': ' + err.message);
  }
  const trimmed = text.trim();
  if (isPublicKeyString(trimmed)) return trimmed;
  let jwk;
  try {
    jwk = JSON.parse(trimmed);
  } catch (_) {
    throw new ToolError(file + ' is neither a public key (p256:...) nor a JSON Web Key');
  }
  if (jwk && typeof jwk.d === 'string') assertPrivateKeyFile(file);
  try {
    return await publicFromPrivateJwk(jwk);
  } catch (err) {
    throw new ToolError(file + ' is not a P-256 key: ' + err.message);
  }
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** compareVersions(a, b) → -1, 0 or 1 (semantic version order: 0.3.0-rc.1 < 0.3.0 < 0.3.1), or null when one is not a version. */
export function compareVersions(a, b) {
  const x = VERSION_RE.exec(String(a));
  const y = VERSION_RE.exec(String(b));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!x[4] && !y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const pa = x[4].split('.');
  const pb = y[4].split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/**
 * verifyRelease({ dir, list, sig, publicKey, allowExtra, expectExtra, expectVersion, minVersion, expectName, expectTree,
 *                 pinnedKeys, retiredKeys, allowUnpinnedKey })
 *   → { ok, reason, problems, checked, signer, listHash, name, version, tree, extras, warnings }
 * reason is 'key' (not a key, a retired key, or not a key built into this copy), 'list' (the list is malformed), 'signature' (wrong
 * key, changed list or changed signature), 'version' (another name, tree or version than expected, or older than minVersion) or
 * 'files' (a changed, missing or extra file); ok is true only when the signature verifies under publicKey, the release is the one
 * expected and every file matches. With allowExtra, extras lists the files outside the list; host settings among them fail unless
 * expectExtra (path → exact text) holds them, and so does any file under _mw/ but a site torrent (_mw/t/<btih>.torrent).
 */
export async function verifyRelease({
  dir, list, sig, publicKey, allowExtra = false, expectExtra = null, expectVersion = null, minVersion = null, expectName = null, expectTree = null,
  pinnedKeys = PINNED_RELEASE_KEYS, retiredKeys = RETIRED_RELEASE_KEYS, allowUnpinnedKey = false,
} = {}) {
  const result = { ok: false, reason: null, problems: [], checked: 0, signer: null, listHash: null, name: null, version: null, tree: null, extras: [], warnings: [] };
  if (!isPublicKeyString(publicKey)) {
    result.reason = 'key';
    result.problems.push('the pinned key is not a P-256 public key (p256: followed by 87 base64url characters)');
    return result;
  }
  if ((retiredKeys || []).includes(publicKey)) {
    result.reason = 'key';
    result.problems.push('this release key was retired (lost or leaked): nothing it signed is trusted (docs/OPERATIONS.md, "A lost or leaked release key")');
    return result;
  }
  const pinned = pinnedKeys || [];
  if (pinned.length && !pinned.includes(publicKey)) {
    if (!allowUnpinnedKey) {
      result.reason = 'key';
      result.problems.push('the key given is not a release key built into this copy of the tools (' + pinned.map((k) => k.slice(0, 20) + '...').join(', ') + '): a list signed by another key is not the release');
      return result;
    }
    result.warnings.push('the key given is not a release key built into this copy of the tools; it is trusted because --allow-unpinned-key was given');
  } else if (!pinned.length) {
    result.warnings.push('this copy of the tools has no release key built in yet: the key given is trusted as given; compare it with the pinned key in README.md, SECURITY.md and the second places SECURITY.md names');
  }
  result.signer = publicKey;
  const listProblems = checkList(list);
  if (listProblems.length) {
    result.reason = 'list';
    result.problems = listProblems;
    return result;
  }
  result.listHash = listHash(list);
  const sigObject = sig && typeof sig === 'object' ? sig : {};
  if (sigObject.v !== 1 || sigObject.alg !== SIG_ALG || typeof sigObject.sig !== 'string' || !SIG_B64.test(sigObject.sig)) {
    result.reason = 'signature';
    result.problems.push('the signature file is malformed (expected { v: 1, alg: "' + SIG_ALG + '", key, sig })');
    return result;
  }
  if (sigObject.key !== undefined && sigObject.key !== publicKey) {
    result.reason = 'signature';
    result.problems.push('the list was signed by another key than the pinned one (' + String(sigObject.key).slice(0, 24) + '...)');
    return result;
  }
  if (!(await verify(publicKey, utf8.encode(signedText(list)), sigObject.sig))) {
    result.reason = 'signature';
    result.problems.push('the signature does not verify under the pinned key: the list was changed, or it was signed by another key');
    return result;
  }
  // The signature holds, so the list's name, version and tree are the signer's; now they are compared with what was expected (SEC-6).
  result.name = list.name;
  result.version = list.version;
  result.tree = list.tree;
  if (expectName && list.name !== expectName) result.problems.push('the list is ' + list.name + ', not ' + expectName);
  if (expectTree && list.tree !== expectTree) result.problems.push('the list is of the tree ' + list.tree + ', not ' + expectTree);
  if (expectVersion && list.version !== expectVersion) {
    result.problems.push('the list is version ' + list.version + ', not the version expected (' + expectVersion + '): an older signed release is a rollback');
  }
  if (minVersion) {
    const c = compareVersions(list.version, minVersion);
    if (c === null) result.problems.push('cannot compare the version ' + list.version + ' with ' + minVersion);
    else if (c < 0) result.problems.push('the list is version ' + list.version + ', older than ' + minVersion + ': an older signed release is a rollback');
  }
  if (result.problems.length) {
    result.reason = 'version';
    return result;
  }
  // Now the files.
  const skipped = [];
  const found = walkFiles(dir, { onSkip: (rel, reason) => skipped.push(rel + ' (' + reason + ')') });
  for (const s of skipped) result.problems.push(s + ': not a regular file');
  const byPath = new Map(found.map((f) => [f.path, f]));
  const listed = new Set();
  for (const entry of list.files) {
    listed.add(entry.path);
    const file = byPath.get(entry.path);
    if (!file) {
      result.problems.push(entry.path + ': missing');
      continue;
    }
    let st;
    try {
      st = lstatSync(file.abs);
    } catch (_) {
      result.problems.push(entry.path + ': unreadable');
      continue;
    }
    if (st.size !== entry.bytes) {
      result.problems.push(entry.path + ': ' + st.size + ' bytes, the list says ' + entry.bytes);
      continue;
    }
    const digest = sha256File(readFileSync(file.abs));
    result.checked++;
    if (digest !== entry.sha256) result.problems.push(entry.path + ': sha256 ' + digest + ' differs from the list (' + entry.sha256 + ')');
  }
  const expected = expectExtra && typeof expectExtra === 'object' ? expectExtra : {};
  for (const f of found) {
    if (listed.has(f.path)) continue;
    if (!allowExtra) {
      result.problems.push(f.path + ': not in the list');
      continue;
    }
    result.extras.push(f.path);
    if (Object.prototype.hasOwnProperty.call(expected, f.path)) {
      const want = Buffer.from(expected[f.path]);
      if (!want.equals(readFileSync(f.abs))) result.problems.push(f.path + ': differs from the file the door kit makes (host settings change what is served)');
    } else if (HOST_SETTINGS_NAMES.has(baseName(f.path))) {
      result.problems.push(f.path + ': host settings that are not in the signed list (they change what a host serves)');
    } else if ((f.path === '_mw' || f.path.startsWith('_mw/')) && !KIT_MW_EXTRA.test(f.path)) {
      result.problems.push(f.path + ': a file under _mw/ that is not in the signed list');
    } else if (f.path.indexOf('/') < 0 && /\.(m?js|cjs|html?|xhtml|svg|wasm)$/i.test(f.path)) {
      result.problems.push(f.path + ': code at the root that is not in the signed list');
    }
  }
  result.reason = result.problems.length ? 'files' : null;
  result.ok = result.problems.length === 0;
  return result;
}

/** compareLists(a, b) → [difference]: what differs between two lists of the same tree (empty when they are the same bytes). */
export function compareLists(a, b) {
  if (canonicalize(a) === canonicalize(b)) return [];
  const diffs = [];
  for (const k of ['name', 'version', 'tree']) if (a[k] !== b[k]) diffs.push(k + ': ' + a[k] + ' in the list, ' + b[k] + ' here');
  const mine = new Map((b.files || []).map((f) => [f.path, f]));
  const theirs = new Set();
  for (const f of a.files || []) {
    theirs.add(f.path);
    const m = mine.get(f.path);
    if (!m) diffs.push(f.path + ': in the list, not in the local build');
    else if (m.sha256 !== f.sha256 || m.bytes !== f.bytes) diffs.push(f.path + ': sha256 ' + f.sha256 + ' in the list, ' + m.sha256 + ' here');
  }
  for (const f of b.files || []) if (!theirs.has(f.path)) diffs.push(f.path + ': in the local build, not in the list');
  if (!diffs.length) diffs.push('the lists differ in a field outside the files');
  return diffs;
}

function readJsonFile(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ToolError('cannot read ' + what + ' ' + file + ': ' + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ToolError(what + ' ' + file + ' is not JSON: ' + err.message);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    out(USAGE.trim());
    return command ? 0 : 2;
  }
  const { flags, positionals } = parseCli(rest, {
    out: { type: 'string' },
    version: { type: 'string' },
    tree: { type: 'string', default: 'dist' },
    name: { type: 'string', default: 'felinar' },
    list: { type: 'string' },
    sig: { type: 'string' },
    key: { type: 'string' },
    pubkey: { type: 'string' },
    'allow-extra': { type: 'boolean' },
    'door-kit': { type: 'boolean' },
    'expect-version': { type: 'string' },
    'min-version': { type: 'string' },
    'any-version': { type: 'boolean' },
    'expect-tree': { type: 'string' },
    'expect-name': { type: 'string' },
    'allow-unpinned-key': { type: 'boolean' },
    rebuilt: { type: 'string' },
    'skip-rebuild-check': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (command === 'list') {
    if (positionals.length !== 1) throw new UsageError('list takes one directory');
    if (!flags.out) throw new UsageError('list needs --out <hashes.json>');
    const list = buildHashList({ dir: resolve(positionals[0]), version: flags.version, tree: flags.tree, name: flags.name });
    writeFileAtomic(flags.out, JSON.stringify(list, null, 2) + '\n');
    out('listed ' + list.files.length + ' files of ' + list.tree + ' (' + list.name + ' ' + list.version + ') into ' + flags.out);
    out('list sha256 ' + listHash(list) + ' (the one number that names this tree; publish it with the release)');
    return 0;
  }
  if (command === 'sign') {
    if (positionals.length) throw new UsageError('sign takes no directory');
    if (!flags.list || !flags.key || !flags.out) throw new UsageError('sign needs --list, --key and --out');
    if (!flags.rebuilt && !flags.skipRebuildCheck) {
      throw new UsageError('sign needs --rebuilt <dir>: the same tree built on this machine from the tag (node build.mjs --strict for dist, npm run build:idp for dist-idp), ' +
        'so the key signs what the source builds and not what a draft release holds. --skip-rebuild-check signs without it.');
    }
    if (flags.rebuilt && flags.skipRebuildCheck) throw new UsageError('give --rebuilt or --skip-rebuild-check, not both');
    const list = readJsonFile(flags.list, 'the list');
    const listProblems = checkList(list);
    if (listProblems.length) throw new ToolError('the list is not valid: ' + listProblems.slice(0, 3).join('; '));
    if (flags.rebuilt) {
      const own = buildHashList({ dir: resolve(flags.rebuilt), version: list.version, tree: list.tree, name: list.name });
      const differs = compareLists(list, own);
      out('list to sign    sha256 ' + listHash(list));
      out('local rebuild   sha256 ' + listHash(own) + ' (' + flags.rebuilt + ')');
      if (differs.length) {
        out('NOT SIGNED: the list differs from this machine\'s build of the same tree:');
        for (const d of differs.slice(0, 20)) out('  ' + d);
        if (differs.length > 20) out('  ... ' + (differs.length - 20) + ' more');
        return 1;
      }
    } else {
      warn('--skip-rebuild-check: the list is signed without comparing it with a build of your own');
    }
    const identity = await loadOwnerKey(flags.key);
    const signature = await signList(list, identity);
    writeFileAtomic(flags.out, JSON.stringify(signature, null, 2) + '\n');
    out('signed ' + flags.list + ' with the release key ' + identity.fingerprint + ' into ' + flags.out);
    out('pin this public key in PINNED_RELEASE_KEYS (tools/verify-release.mjs), README.md and SECURITY.md, and put it in the second places SECURITY.md names: ' + identity.pub);
    return 0;
  }
  if (command === 'verify') {
    if (positionals.length !== 1) throw new UsageError('verify takes one directory');
    if (!flags.list || !flags.sig) throw new UsageError('verify needs --list and --sig');
    if (flags.key && flags.pubkey) throw new UsageError('give the pinned key once: --key or --pubkey');
    const versionChecks = [flags.expectVersion, flags.minVersion, flags.anyVersion].filter(Boolean).length;
    if (versionChecks === 0) {
      throw new UsageError('verify needs the release you expect: --expect-version <v> (or --min-version <v>, the oldest you accept). ' +
        'A genuine older signed release is a rollback; --any-version skips the check.');
    }
    if (flags.anyVersion && versionChecks > 1) throw new UsageError('--any-version cannot be combined with --expect-version or --min-version');
    const list = readJsonFile(flags.list, 'the list');
    const sig = readJsonFile(flags.sig, 'the signature file');
    let publicKey;
    if (flags.pubkey) publicKey = flags.pubkey.trim();
    else if (flags.key) publicKey = await readPublicKey(flags.key);
    else if (PINNED_RELEASE_KEYS.length) publicKey = PINNED_RELEASE_KEYS.includes(sig && sig.key) ? sig.key : PINNED_RELEASE_KEYS[0];
    else throw new UsageError('verify needs the pinned public key: --key <file> or --pubkey p256:... (this copy of the tools has no release key built in yet)');
    const result = await verifyRelease({
      dir: resolve(positionals[0]), list, sig, publicKey, allowExtra: flags.allowExtra || flags.doorKit,
      expectExtra: flags.doorKit && list && typeof list.version === 'string' ? doorKitFiles({ version: list.version }) : null,
      expectVersion: flags.expectVersion || null, minVersion: flags.minVersion || null, expectTree: flags.expectTree || null, expectName: flags.expectName || null,
      allowUnpinnedKey: flags.allowUnpinnedKey,
    });
    if (flags.json) {
      out(JSON.stringify({
        ok: result.ok, reason: result.reason, name: result.name, version: result.version, tree: result.tree, checked: result.checked, problems: result.problems,
        extras: result.extras, warnings: result.warnings, signer: result.signer, listHash: result.listHash,
      }));
    } else if (result.ok) {
      out('OK: ' + result.name + ' ' + result.version + ' (' + result.tree + '): ' + result.checked + ' files match the list, signed by ' + (await fingerprint(result.signer)) + ' (' + result.signer.slice(0, 20) + '...)');
      out('list sha256 ' + result.listHash);
      if (result.extras.length) {
        out(result.extras.length + ' file(s) not in the signed list (accepted: not host settings, not code under _mw/):');
        for (const p of result.extras.slice(0, 50)) out('  ' + p);
        if (result.extras.length > 50) out('  ... ' + (result.extras.length - 50) + ' more');
      }
      for (const w of result.warnings) warn(w);
    } else {
      out('FAILED (' + result.reason + '):');
      for (const p of result.problems.slice(0, 50)) out('  ' + p);
      if (result.problems.length > 50) out('  ... ' + (result.problems.length - 50) + ' more');
    }
    return result.ok ? 0 : 1;
  }
  warn('unknown command ' + command);
  throw new UsageError('unknown command ' + command);
}

if (isMain(import.meta.url)) runMain(main, USAGE);
