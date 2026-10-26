#!/usr/bin/env node
// tools/publish.mjs: publish a static site as a torrent with a signed pointer (ARCHITECTURE §3.4.1,
// §4, §10; DESIGN-REVIEW items 11, 13, 14, 22, 23, S12).
//
//   node tools/publish.mjs <dir> --name <n> --scope <hostname> --key owner.jwk [--ws <base>] [--xs <url>]
//     [--tr <wss>]... [--chain <label>] [--max <bytes>] [--cs <url>] [--consent notice|gate] [--exp <days>]
//     [--seq <n>] [--policy open|allow|owner] [--moderator <pub>]... [--allow <pub>]... [--bits <n>]
//     [--dropin] [--keep-days 7] [--verify-ws [--allow-no-preflight]] [--verify-host <url>] [--out dist-publish]
//     v0.3: [--org <origin>]... [--next-key <file>] [--nx <b64url>] [--ml <x.y.z>] [--idp <origin>] [--signin-widget] [--chat-panel]
//     [--tracker <wss>]... [--stun <stun:>]... [--turn <url>]... [--chat] [--files] [--media] [--calls] [--cfg-from <ledger.json>]
//
// Shell mode (default): every file of <dir> except the ignore list goes into the torrent, plus
// /.mw/site.json (routing manifest from flags and _redirects/_headers) and /.mw/files.json
// (SHA-256 per file). Drop-in mode (--dropin): HTML stays on the host and out of the torrent;
// every HTML page of the deploy copy is stamped with <meta name="mw-pointer">, and the runtime
// (/_mw/*, /mw-sw.js) and /_mw/t/<btih>.torrent are laid out next to it.
//
// The torrent is deterministic: fixed name, paths sorted by UTF-8 bytes, 256 KiB pieces, the exact
// --tr list as announce, --ws as url-list, created by "felinar", and a creation date that is an
// input (--date, SOURCE_DATE_EPOCH or the git commit time; none: no date), so two runs over the same
// files give the same infohash and the same .torrent bytes (v0.2.1 E4; --double-pack checks it).
//
// v0.2.1 publishing discipline (tools/publish-policy.mjs): the path policy (E1), budget gates with a
// size report (E2) and the secrets and personal-data lint with --from-wxr (E3) run before anything
// is written; F4 warns about an open ledger without a ct= contact. The genesis policy
// block of the site ledger is minted with the owner key on the first publish and reused from
// <out>/genesis.json afterwards, so gen= stays stable across site versions.
//
// v0.3 (V03-DESIGN-REVIEW 2.3.6, 2.5.3, 2.5.5, 3.8; MF-04, MF-28, MF-44, SC-6, SC-7): the signed pointer can carry org= (at most
// 4 origins the identity page may serve keys to), nx= (the commitment to the next owner key, computed from --next-key and carried
// into every later record of the same owner), ml= (the oldest loader that may mount the site) and idp= (a suggested identity
// origin). --signin-widget and --chat-panel copy the self-hosted widgets of dist/_mw and print the script tag with its SRI hash
// and the element. Chat, files and media need the site's own tracker and STUN servers (--tracker, --stun): publish refuses
// without them. Loader pages get Cross-Origin-Opener-Policy: same-origin-allow-popups and Referrer-Policy: no-referrer in a
// _headers file. The rot= v1 input is gone from the tools: --prev-key signs the v2 input only.
//
// v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2 and 3.5, S2 Rc3): a scope that is tied to an address (a nip.io or sslip.io name, or an IP
// literal other than a loopback address, see addressBoundScope) cannot carry a DNS record and changes with the address. For such a scope --chain
// defaults to --name, so the ledger, its rendezvous swarm and its infohash stay the same when the site later moves to a domain, and the
// 450-byte DNS-size warning gives way to one line saying the page tag is the only pointer and when it expires. --calls turns peer-to-peer
// calls on: it implies --chat and needs the same own tracker and STUN.
//
// v0.3 C2 doors (docs/research/v03/S4-doors.md D2, D7): "the site lives at its key; domains are doors". --door <host> (repeatable, at
// most 8) is link mode: besides the page tag, publish signs the same record for the hub scope btih:<hex> with dr=<the doors>, which
// verifies on every door, and writes link.txt (the primary light link, https://<first door>/_mw/open.html#<record>), link-card.txt
// (the primary link, two fallback links, the web+felinar: form and a QR code), link-qr.svg and doors.json. Link mode needs --chain
// (the ledger id is owner + chain on every door and across versions). The 450-byte warning and the 900-byte limit apply to the link
// record as to the page tag. --door-kit <dir> makes a door kit: the built loader copied unchanged after it matched the signed release
// list (--release-list, --release-sig, --release-key), plus the list and its signature, .nojekyll, _headers, _redirects, vercel.json,
// a Caddyfile and README-DOOR.txt; --door-site <publish output> also lays a site's web seed copy and .torrent into it (a full door).

import { readFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import createTorrent from 'create-torrent';

import { encode as bencode, decode as bdecode } from '../src/common/bencode.js';
import { parseTorrentFile } from '../src/common/torrent-file.js';
import {
  signPointer, signRotation, verifyPointer, formatPointer, normalizeScope, splitTxt, magnetFromRecord,
  hubLabelFor, MAX_EXP_DAYS, MAX_PUBLISH_EXP_DAYS, SEQ_PUBLISH_SLACK_S, DEFAULT_EXP_DAYS, pointerBudget, POINTER_SIZE_SHOULD, POINTER_SIZE_MAX,
  AUDIENCES, parsePointer, ORG_MAX, isOriginString, isLoaderVersion, nextKeyCommitment,
} from '../src/common/pointer.js';
import { utf8 } from '../src/chain/canonical.js';
import { isPublicKeyString, publicFromPrivateJwk } from '../src/chain/crypto.js';
import { statementProblem } from '../src/identity/signin.js';
import { compareVersions } from '../src/loader/harden.js';
import { isWildcardDnsName } from '../src/loader/doh.js';
import { parseRedirects, parseHeaders } from '../src/sw/lib.js';
import { CONFIG } from '../src/loader/config.js';
import { rendezvousInfoHash } from '../src/loader/torrent.js';
// v0.3 C2 doors: light links, the QR code of the link card, and the signed release list a door kit must match.
import { formatLightLink, isDoorHost, hostOfOrigin, ledgerIdFor, DOOR_MAX } from '../src/common/pointer.js';
import { encode as qrEncode } from '../src/idp/qr.js';
import { verifyRelease, readPublicKey, PINNED_RELEASE_KEYS } from './verify-release.mjs';
import { doorKitFiles } from './door-kit-files.mjs';

export { doorKitFiles };
import { createGenesis, checkGenesis, readBlocksFile, writeBlocksFile, policyOp, ledgerIdForOwner, loadLedger, currentCfg, OPEN_WRITING_WARNING } from './ledger-admin.mjs';
import { withdraw, WITHDRAW_FLAGS } from './withdraw.mjs';
import { checkWebseed, webseedTargets, verifyHostFiles } from './check-webseed.mjs';
import { lintPaths, dotPathReason, budgetReport, lintSecrets, importWxr } from './publish-policy.mjs';
import {
  parseCli, runMain, isMain, loadOwnerKey, walkFiles, compareUtf8, sha256Hex, sha384Base64, writeFileAtomic, copyTree,
  removeTree, isLoopbackHost, injectMeta, scanTags, isUtf16, escapeAttr, formatBytes, isoDate,
  isInside, assertPrivateKeyFile, ToolError, UsageError, out, warn, relPath, ROOT, PIECE_LENGTH,
  TOOLS_VERSION,
} from './lib.mjs';

const USAGE = `
Usage: node tools/publish.mjs <dir> --name <name> --scope <hostname> --key owner.jwk [options]

Pointer:   --ws <base URL> (web seed)  --xs <URL of the .torrent>  --tr <wss URL>... (--tr public = the
           four default public trackers)  --chain <label> (default for a nip.io or sslip.io name or a non-loopback IP
           address as --scope: --name)  --max <bytes>  --cs <snapshot URL>
           --consent notice|gate  --exp <days> (default 90, at most 399)  --seq <n> (default: Unix time, never later than it)
           --prev-key <old owner.jwk>  (key rotation: adds rot=, the old key's signature over the new one)
Ledger:    --policy owner|allow|open  --bits <n>  --moderator <pub>...  --allow <pub>...
           --max-value-bytes <n>  --max-chain-bytes <n>  --genesis <file>  --new-genesis
Routing:   --spa [--spa-path <file>]  --clean-urls  --trailing-slash auto|always|never
           --index <file>  --not-found <file>|none   (plus _redirects and _headers from <dir>)
Mode:      --dropin [--inject-script] [--keep-days 7] [--dist dist]   --shell [--dist dist]
           a --dist other than this checkout's dist/ is checked first: --release-list hashes-dist.json --release-sig hashes-dist.json.sig
           --release-key <pinned key> (the signed release list), or --allow-unverified-loader to deploy it unchecked
           --ct <https: or mailto: URL> (abuse and legal contact)  --lg <URL> (privacy and terms)
           --aud <token>[,<token>...] (general, kids, sensitive; personal, eea, eu, uk, qc, quebec make
           the consent gate the default for visitors)
Policy:    --include-dot <path>... (publish a dot path the dot-file table drops)  --allow-secret <path>...
           --max-files <n> (default 20000)  --from-wxr <export.xml> [--wxr-dir comments]
           --date <ISO 8601 | Unix seconds> (torrent creation date; default SOURCE_DATE_EPOCH, then the git
           commit time)  --double-pack (pack twice, fail on any difference)
Identity (v0.3): --org <origin>... (at most 4 exact origins, such as https://shop.example, that may hold this site's keys at the
           identity page; the scope's own host is always listed)  --idp <origin> (suggested identity origin)
           --next-key <file> (the NEXT owner key: a file with its public key p256:... or its key file; pointer nx= commits to it,
           and every later record of this owner keeps the same nx=)  --nx <43 characters> (the commitment itself)
           --ml <x.y.z> (the oldest loader version that may mount the site; older ones offer an update)
           --prev-pointer <file|none> (the last published pointer, default <out>/pointer.txt: nx= and owner continuity are checked)
Widgets:   --signin-widget (copy dist/_mw/signin.js, print the script tag with its SRI hash and <mw-signin>)
           --signin-statement <text> --challenge-url </path> --proof-url </path> (the attributes of <mw-signin>)
           --chat-panel (copy dist/_mw/chat-panel.js, print its tag and <mw-chat-panel>; needs a drop-in site with a ledger)
Features:  --chat --files --media --calls (turn the feature on; --chat-panel and --calls imply --chat)  --cfg-from <ledger.json> (read _mw.cfg from a ledger export)
           With any of them on, publish refuses unless the site names its OWN tracker and STUN: --tracker <wss URL>... (added to tr=;
           not the public default trackers) and --stun <stun: URL>... (written to /.mw/site.json). --turn <turn:, turns: or https: URL>...
           [--turn-mode static|endpoint] adds a TURN relay (off by default; the card names the operator).
Output:    --out <dir> (default dist-publish)  --verify-ws [--allow-no-preflight]  --verify-host <url> (drop-in)
           --ignore <path>...  --quiet
Doors (v0.3 C2): --door <host>... (at most 8 door hosts such as mirror.example.org or door.example.net:8443: link mode, needs --chain;
           writes link.txt, link-card.txt, link-qr.svg and doors.json beside the page tag)
Door kit:  node tools/publish.mjs --door-kit <dir> --release-list hashes-dist.json --release-sig hashes-dist.json.sig
           --release-key <pinned public key file or p256:...> [--dist dist] [--door-site <publish output dir>]...
           copies the built loader unchanged once it matches the signed release list, and adds the host settings and README-DOOR.txt
Withdraw:  node tools/publish.mjs --withdraw --scope <hostname> --key owner.jwk [--why <reason>] [--ct <url>]
           [--chain <label>] [--seq <n>] [--exp <days> (default 399)] [--prev-key <old owner.jwk>] [--ledger-owner <pub>] [--out <dir>]
           writes a signed st=withdrawn record (pointer.txt, meta.html, dns.txt, summary.json): loaders stop
           sharing the site and delete every stored version (tools/withdraw.mjs)

Writes site.torrent, <name>.torrent, <name>/ (the web seed upload), magnet.txt, pointer.txt,
dns.txt, meta.html, webseed-layout.txt, genesis.json, summary.json and csp.txt to --out. With --dropin:
site/ instead of <name>/ and <name>.torrent, no webseed-layout.txt (the host's own files are the web seed),
and csp.txt lists only what drop-in pages connect to.
With --verify-ws the pointer is withheld until tools/check-webseed.mjs passes against --ws (seed mode: the
Range preflight, a browser-style ranged GET per file, the SHA-1 of the first and last piece); with
--verify-host <url> (drop-in) until the live host serves browsers the torrent's bytes (host mode).
`;

const HTML_RE = /\.html?$/i;
/** publish reads the whole site into memory; this is far above what a visitor accepts and below what Node can hold. */
const MAX_SITE_READ = 512 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/;
// v0.2.1 D4: data-cfasync="false" comes before src (Cloudflare Rocket Loader leaves the tag alone only then).
const MW_SCRIPT = '<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>';
const OUTPUT_FILES = ['site.torrent', 'magnet.txt', 'pointer.txt', 'dns.txt', 'meta.html', 'webseed-layout.txt',
  'genesis.json', 'summary.json', 'csp.txt', 'mw-sw-kill.js', 'sdk-static.js', 'loader-headers.txt', 'widget',
  'link.txt', 'link-card.txt', 'link-qr.svg', 'doors.json'];
/** v0.3 C2 doors: the files link mode writes (removed at the start of every run, written with the pointer). */
const LINK_FILES = ['link.txt', 'link-card.txt', 'link-qr.svg', 'doors.json'];
const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; " +
  "img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

// ---------------------------------------------------------------------------------------------
// site collection
// ---------------------------------------------------------------------------------------------

/**
 * ignoreReason(rel, isDir, { extra, includeDot }) → reason | null for the torrent (ARCHITECTURE §10
 * ignore list; v0.2.1 E1: dot paths follow the explicit table of tools/publish-policy.mjs
 * dotPathReason, and --include-dot publishes a dot path the table would drop), node_modules, the
 * root README.md, the root _redirects and _headers (they become /.mw/site.json), OS junk, editor
 * backups (name~) and --ignore prefixes.
 */
export function ignoreReason(rel, isDir, { extra = [], includeDot = [] } = {}) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  const dot = dotPathReason(rel, isDir, { includeDot });
  if (dot) return dot;
  if (segs.includes('node_modules')) return 'node_modules';
  if (!isDir && segs.length === 1 && /^readme\.md$/i.test(base)) return 'README.md';
  if (!isDir && segs.length === 1 && (base === '_redirects' || base === '_headers')) return 'host config (read into /.mw/site.json)';
  if (!isDir && /^(thumbs\.db|desktop\.ini)$/i.test(base)) return 'OS junk';
  if (!isDir && base.endsWith('~')) return 'editor backup file';
  for (const p of extra) {
    const prefix = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (prefix && (rel === prefix || rel.startsWith(prefix + '/'))) return '--ignore ' + p;
  }
  return null;
}

// The deploy copy of a drop-in site keeps everything the host needs (_redirects, _headers,
// README.md, .well-known/, .nojekyll, .htaccess, and dot paths published with --include-dot) but
// never VCS data, node_modules or other dotfiles.
function deploySkip(rel, isDir, includeDot = []) {
  const segs = rel.split('/');
  if (segs.includes('node_modules')) return 'node_modules';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s.startsWith('.')) continue;
    if (i === 0 && (s === '.well-known' || (!isDir && segs.length === 1 && (s === '.nojekyll' || s === '.htaccess')))) continue;
    if (dotPathReason(rel, isDir, { includeDot }) === null) continue;
    return 'dotfile';
  }
  if (!isDir && /^(thumbs\.db|desktop\.ini)$/i.test(segs[segs.length - 1])) return 'OS junk';
  return null;
}

/**
 * applyNfcRenames(root, renames) (v0.2.1 E1): the deploy copy uses the NFC spelling of every path,
 * like the torrent, so the host and the web-seed rewrite answer the URL browsers request. On
 * normalisation-insensitive file systems (APFS) a rename to the NFC spelling only changes the stored
 * name; elsewhere directories left empty by the move are removed.
 */
export function applyNfcRenames(root, renames = []) {
  for (const { from, to } of renames) {
    if (from === to) continue;
    const src = join(root, ...from.split('/'));
    const dst = join(root, ...to.split('/'));
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    let parent = dirname(src);
    while (parent !== root && parent.startsWith(root)) {
      try {
        if (readdirSync(parent).length) break;
        rmdirSync(parent);
      } catch (_) {
        break;
      }
      parent = dirname(parent);
    }
  }
}

/**
 * Splits `<dir>` into torrent files, HTML pages and skipped entries. v0.2.1 E1: every collected path
 * is linted (tools/publish-policy.mjs lintPaths) and carries its NFC spelling as `path` (the name on
 * disk stays in `diskPath`); publish refuses to continue when `lint.errors` is not empty.
 */
export function collectSite(dir, { dropin = false, ignore = [], includeDot = [] } = {}) {
  const skipped = [];
  const found = walkFiles(dir, {
    skip: (rel, isDir) => ignoreReason(rel, isDir, { extra: ignore, includeDot }),
    onSkip: (rel, reason) => skipped.push({ path: rel, reason }),
  });
  const lint = lintPaths(found.map((f) => f.path));
  const files = found.map((f) => Object.assign({}, f, { diskPath: f.path, path: f.path.normalize('NFC') }));
  const html = files.filter((f) => HTML_RE.test(f.path));
  const torrent = dropin ? files.filter((f) => !HTML_RE.test(f.path)) : files;
  const readOptional = (name) => {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  return { files, html, torrent, skipped, lint, redirectsText: readOptional('_redirects'), headersText: readOptional('_headers') };
}

/**
 * skippedRedirectLines(text) → [{ line, text }]: the _redirects lines the Service Worker's parser leaves out
 * (query matching, conditions, proxying, other statuses, full-URL sources: src/sw/lib.js parseRedirects), so
 * publish can name them (post-wave fix, MIGRATION-DIGEST M43: they used to vanish without a word).
 */
export function skippedRedirectLines(text) {
  const out = [];
  if (text === null || text === undefined) return out;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') return;
    if (!parseRedirects(line).length) out.push({ line: i + 1, text: line });
  });
  return out;
}

/**
 * siteManifest({ files, flags, redirectsText, headersText, dropin }) → the /.mw/site.json object
 * (src/sw/lib.js normalizeManifest reads it): index, notFound, spa, cleanUrls, trailingSlash,
 * redirects and headers. notFound defaults to 404.html when the torrent has one.
 */
export function siteManifest({ files, flags = {}, redirectsText = null, headersText = null, dropin = false }) {
  const paths = new Set(files.map((f) => f.path));
  const index = flags.index || 'index.html';
  if (/[/\\]/.test(index)) throw new UsageError('--index must be a file name, not a path');
  let notFound = null;
  if (flags.notFound && flags.notFound !== 'none') {
    notFound = flags.notFound.replace(/^\/+/, '');
    if (!paths.has(notFound)) warn('--not-found ' + notFound + ' is not in the torrent');
  } else if (!flags.notFound && !dropin && paths.has('404.html')) {
    notFound = '404.html';
  }
  let spa = false;
  if (flags.spa || flags.spaPath) {
    spa = flags.spaPath ? flags.spaPath.replace(/^\/+/, '') : true;
    if (spa !== true && !paths.has(spa)) warn('--spa-path ' + spa + ' is not in the torrent');
  }
  let trailingSlash = 'auto';
  if (flags.trailingSlash) {
    if (!['auto', 'always', 'never'].includes(flags.trailingSlash)) throw new UsageError('--trailing-slash must be auto, always or never');
    trailingSlash = flags.trailingSlash;
  }
  return {
    v: 1,
    index,
    notFound,
    spa,
    cleanUrls: Boolean(flags.cleanUrls),
    trailingSlash,
    redirects: redirectsText ? parseRedirects(redirectsText) : [],
    headers: headersText ? parseHeaders(headersText) : [],
  };
}

// ---------------------------------------------------------------------------------------------
// pointer metadata
// ---------------------------------------------------------------------------------------------

/** The aud= tokens publish accepts: pointer.js AUDIENCES plus the loader's consent-gate tokens. */
export const AUD_TOKENS = Object.freeze(Array.from(new Set([...AUDIENCES, ...((CONFIG.consent && CONFIG.consent.gateAudiences) || [])])));

/**
 * audienceList(value) → 'tok1,tok2' (lowercase, de-duplicated, in the order given) for --aud, or a
 * UsageError naming the tokens that are not defined. Accepts commas, spaces or '+' between tokens.
 */
export function audienceList(value) {
  const tokens = String(value).toLowerCase().split(/[\s,+|/]+/).filter(Boolean);
  const unknown = tokens.filter((t) => AUD_TOKENS.indexOf(t) < 0);
  if (!tokens.length || unknown.length) {
    throw new UsageError('--aud must be one or more of ' + AUD_TOKENS.join(', ') + ', separated by commas' + (unknown.length ? ' (unknown: ' + unknown.join(', ') + ')' : ''));
  }
  return Array.from(new Set(tokens)).join(',');
}

/**
 * egressNote(copyBytes) → the drop-in egress warning (v0.2.1 DIGEST-AMENDMENTS E5; MIGRATION-DIGEST M10): on
 * unmetered networks every drop-in visitor's browser completes a copy of the non-HTML files from the host at
 * idle after its first page view, so host egress grows with the copy size, not with page views. The 13.3x is the
 * model of research w2a-07 F21 (20 MB / 1.5 MB with no peer help), not a measurement.
 */
export function egressNote(copyBytes) {
  return 'Egress: on unmetered networks each drop-in visitor downloads the whole copy (' + formatBytes(copyBytes) +
    ' of non-HTML files) from this host once, at idle after the first page view; cellular and Save-Data visitors fill it ' +
    'from peers only. Budget host egress for copies, not page views: in a model (arithmetic, not a measurement), ' +
    'a 20 MB copy completed after a 1.5 MB page view costs the host 13.3 times the bytes of that view. Leaving heavy files ' +
    'out of the torrent (--ignore <path>: they stay on this host only) limits it.';
}

// ---------------------------------------------------------------------------------------------
// v0.3: pointer fields, features, widgets, loader headers
// ---------------------------------------------------------------------------------------------

/** What the host sends with the loader pages (/, /index.html, /404.html), R 2.3.9 and MF-05. */
export const LOADER_HEADER_VALUES = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Referrer-Policy': 'no-referrer',
});
export const LOADER_PAGES = Object.freeze(['/', '/index.html', '/404.html']);

/**
 * loaderHeadersText() → the _headers file of a shell host (Netlify and Cloudflare Pages syntax): the sign-in page opens in a popup
 * and answers its opener, so the loader pages must not send Cross-Origin-Opener-Policy: same-origin, and no page sends a referrer.
 */
export function loaderHeadersText() {
  const lines = [
    '# felinar loader pages (V03-DESIGN-REVIEW 2.3.9, MF-05). The identity page opens in a popup and answers its opener, so these pages',
    '# send Cross-Origin-Opener-Policy: same-origin-allow-popups (never same-origin), and no referrer leaves them.',
  ];
  for (const page of LOADER_PAGES) {
    lines.push(page);
    for (const [name, value] of Object.entries(LOADER_HEADER_VALUES)) lines.push('  ' + name + ': ' + value);
  }
  return lines.join('\n') + '\n';
}

/** orgList(list) → the org= origins, each an exact serialized origin, distinct, at most ORG_MAX. UsageError otherwise. */
export function orgList(list) {
  const result = [];
  for (const value of list || []) {
    if (!isOriginString(value)) throw new UsageError('--org must be an exact origin such as https://shop.example or https://shop.example:8443 (no path, no trailing slash): ' + value);
    if (result.indexOf(value) >= 0) throw new UsageError('--org ' + value + ' is given twice');
    result.push(value);
  }
  if (result.length > ORG_MAX) throw new UsageError('--org takes at most ' + ORG_MAX + ' origins, got ' + result.length);
  return result;
}

// ---------------------------------------------------------------------------------------------
// v0.3 C2 doors: link mode and the door kit (docs/research/v03/S4-doors.md D2, D7)
// ---------------------------------------------------------------------------------------------

/** doorList(list) → the --door hosts: each a door host (isDoorHost: lowercase host or host:port), distinct, at most DOOR_MAX. */
export function doorList(list) {
  const result = [];
  for (const raw of list || []) {
    for (const value of String(raw).split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!isDoorHost(value)) throw new UsageError('--door takes a host such as mirror.example.org or door.example.net:8443 (lowercase, no scheme, path or trailing dot): ' + value);
      if (result.indexOf(value) >= 0) throw new UsageError('--door ' + value + ' is given twice');
      result.push(value);
    }
  }
  if (result.length > DOOR_MAX) throw new UsageError('--door takes at most ' + DOOR_MAX + ' hosts (dr= holds at most ' + DOOR_MAX + '), got ' + result.length);
  return result;
}

/**
 * qrText(qr, { margin }) → the QR code as text, two module rows per line: a full block for two dark modules, an upper or lower
 * half block for one, a space for none (dark on light: print it, or show it on a light background). margin: the quiet zone (4).
 */
export function qrText(qr, { margin = 4 } = {}) {
  const size = qr.size;
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && qr.modules[y * size + x] === 1;
  const lines = [];
  for (let y = -margin; y < size + margin; y += 2) {
    let line = '';
    for (let x = -margin; x < size + margin; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? '\u2588' : top ? '\u2580' : bottom ? '\u2584' : ' ';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n') + '\n';
}

/** qrSvg(qr, { scale, margin }) → an SVG of the QR code (black modules on white, crisp edges). */
export function qrSvg(qr, { scale = 4, margin = 4 } = {}) {
  const n = qr.size + margin * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.modules[y * qr.size + x] === 1) path += 'M' + (x + margin) + ' ' + (y + margin) + 'h1v1h-1z';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n * scale + '" height="' + n * scale + '" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges">' +
    '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path fill="#000" d="' + path + '"/></svg>\n';
}

/**
 * linkCardText({ name, primary, fallbacks, web, qr, bytes, expires }) → link-card.txt: the primary light link, up to two fallback links
 * (the same signed record at other doors), the web+felinar: form, the QR code of the primary link, and what a link cannot do.
 */
export function linkCardText({ name, primary, fallbacks = [], web = null, qr = null, bytes = null, expires = null } = {}) {
  const lines = [];
  lines.push('Light link for ' + name + (expires ? ' (the record expires ' + expires + '; publish again before then)' : ''));
  lines.push('The site lives at its key; domains are doors. Each address below opens the same signed record.');
  lines.push('');
  lines.push('Primary link:');
  lines.push(primary);
  if (fallbacks.length) {
    lines.push('');
    lines.push('Other doors (send these too: a link cannot switch doors by itself):');
    for (const f of fallbacks.slice(0, 2)) lines.push(f);
  }
  if (web) {
    lines.push('');
    lines.push('As a web+felinar: link (opens only where a door app is installed on desktop Chrome or Edge; Firefox, phones and Safari ignore it):');
    lines.push(web);
  }
  if (qr) {
    lines.push('');
    lines.push('QR code of the primary link (version ' + qr.version + ', level ' + qr.ecl + (bytes ? ', record ' + bytes + ' bytes' : '') + '; dark modules are blocks, so print it or scan it on a light background; link-qr.svg is the same code as an image):');
    lines.push(qrText(qr).replace(/\n$/, ''));
  }
  lines.push('');
  lines.push('What a link cannot do: when its first address is blocked or down and the visitor has never opened the site, the browser shows its own error page and nothing of the site runs. Give people more than one of the links above.');
  return lines.join('\n') + '\n';
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

// releasePinnedKeys (doorKit, checkLoaderRelease, publish, ship): internal, for tests that sign a fixture release with their own key. No flag sets it, so the command lines always trust PINNED_RELEASE_KEYS, as does any call that gives no non-empty list.
const releaseKeysToTrust = (releasePinnedKeys) => (Array.isArray(releasePinnedKeys) && releasePinnedKeys.length ? releasePinnedKeys : PINNED_RELEASE_KEYS);

/**
 * doorKit({ out, dist, releaseList, releaseSig, releaseKey, doorSite, log }) → { kit, version, listHash, files, sites }.
 * Refuses unless every file of dist matches the signed release list under the pinned release key (tools/verify-release.mjs): a
 * door must serve the loader as released, or a visitor's first load there would run something else. Then copies dist unchanged,
 * adds the list and its signature (hashes-dist.json, hashes-dist.json.sig) and the files of doorKitFiles(), and, for each
 * --door-site, the site's web seed copy (<publish out>/<name>/ to ws/<name>/) and its torrent (_mw/t/<btih>.torrent).
 */
export async function doorKit({ out: kitOut, dist = join(ROOT, 'dist'), releaseList = null, releaseSig = null, releaseKey = null, releasePinnedKeys = null, doorSite = [], quiet = false, log = null } = {}) {
  const say = quiet ? () => {} : (typeof log === 'function' ? log : (line) => out(line));
  if (!kitOut) throw new UsageError('--door-kit needs a directory');
  const kit = resolve(kitOut);
  const distDir = resolve(dist);
  if (!existsSync(join(distDir, 'index.html')) || !existsSync(join(distDir, '_mw', 'open.html'))) {
    throw new ToolError('--door-kit needs a built loader with the door page (run: node build.mjs): ' + relPath(distDir) + ' has no _mw/open.html');
  }
  if (!releaseList || !releaseSig || !releaseKey) {
    throw new UsageError('--door-kit needs the signed release list: --release-list hashes-dist.json --release-sig hashes-dist.json.sig --release-key <pinned public key file or p256:...> (docs/DEPLOY.md, "Doors")');
  }
  if (isInside(distDir, kit) || isInside(kit, distDir)) throw new UsageError('--door-kit must not be inside the loader build, nor contain it');
  const list = readJsonFile(releaseList, 'the release list');
  const sig = readJsonFile(releaseSig, 'the release signature');
  const publicKey = isPublicKeyString(String(releaseKey).trim()) ? String(releaseKey).trim() : await readPublicKey(releaseKey);
  const pinnedKeys = releaseKeysToTrust(releasePinnedKeys);
  const verdict = await verifyRelease({ dir: distDir, list, sig, publicKey, pinnedKeys });
  if (!verdict.ok) {
    throw new ToolError('refusing to make a door kit: ' + relPath(distDir) + ' does not match the signed release list (' + verdict.reason + '): ' +
      verdict.problems.slice(0, 5).join('; ') + (verdict.problems.length > 5 ? '; ...' : '') + '. A door must serve the loader byte for byte as released.');
  }
  if (existsSync(kit)) {
    const entries = readdirSync(kit);
    if (entries.length && !existsSync(join(kit, 'README-DOOR.txt'))) throw new ToolError('refusing to write into ' + relPath(kit) + ': it is not empty and is not a door kit');
    removeTree(kit);
  }
  copyTree(distDir, kit);
  writeFileAtomic(join(kit, 'hashes-dist.json'), readFileSync(releaseList));
  writeFileAtomic(join(kit, 'hashes-dist.json.sig'), readFileSync(releaseSig));
  const extra = doorKitFiles({ version: list.version });
  for (const [name, text] of Object.entries(extra)) writeFileAtomic(join(kit, name), text);
  const sites = [];
  for (const pubDir of doorSite || []) {
    const summary = readJsonFile(join(resolve(pubDir), 'summary.json'), 'the publish summary');
    if (summary.mode !== 'shell' || !/^[0-9a-f]{40}$/.test(String(summary.btih || '')) || !NAME_RE.test(String(summary.name || ''))) {
      throw new ToolError('--door-site ' + pubDir + ': summary.json is not a shell-mode publish output (a drop-in site serves its own files)');
    }
    const seedDir = join(resolve(pubDir), summary.name);
    if (!existsSync(seedDir) || !existsSync(join(resolve(pubDir), 'site.torrent'))) throw new ToolError('--door-site ' + pubDir + ': ' + summary.name + '/ or site.torrent is missing');
    copyTree(seedDir, join(kit, 'ws', summary.name));
    writeFileAtomic(join(kit, '_mw', 't', summary.btih + '.torrent'), readFileSync(join(resolve(pubDir), 'site.torrent')));
    sites.push({ name: summary.name, btih: summary.btih, webseed: '/ws/' + summary.name + '/', torrent: '/_mw/t/' + summary.btih + '.torrent' });
  }
  // The kit as the README's step 1 checks it (--door-kit): the host settings must be the ones made here, byte for byte (SEC-5).
  const again = await verifyRelease({ dir: kit, list, sig, publicKey, pinnedKeys, allowExtra: true, expectExtra: extra });
  if (!again.ok) throw new ToolError('internal: the kit does not hold the release as listed (' + again.problems.slice(0, 3).join('; ') + ')');
  say('door kit ' + relPath(kit) + ' (felinar ' + list.version + ', release list ' + verdict.listHash.slice(0, 16) + '..., ' + verdict.checked + ' loader files checked)');
  say('  added   hashes-dist.json, hashes-dist.json.sig, ' + Object.keys(extra).join(', '));
  for (const s of sites) say('  site    ' + s.name + ' (btih ' + s.btih + '): ' + s.webseed + ' and ' + s.torrent);
  say('Upload the folder to the root of a host name, then check it: node tools/check-site.mjs https://<host>/ --door');
  return { kit, version: list.version, listHash: verdict.listHash, files: verdict.checked, sites };
}

/**
 * checkLoaderRelease({ dist, releaseList, releaseSig, releaseKey, requireVerified, allowUnverified })
 *   → { verified, own, version, listHash, warning }
 * Review round SUP-5: the loader that publish (--shell, --dropin) and ship deploy is checked against the signed release list
 * (hashes-dist.json and its .sig, tools/verify-release.mjs) when the list is given, and the run stops on any difference. The
 * pinned key comes from --release-key or from the release key built into the tools, never from beside --dist. This checkout's own
 * build (dist/ of the repository) needs no list; any other --dist needs one when requireVerified is set (the command lines of publish
 * and ship) unless allowUnverified (--allow-unverified-loader), and otherwise gets a warning.
 */
export async function checkLoaderRelease({ dist = join(ROOT, 'dist'), releaseList = null, releaseSig = null, releaseKey = null, releasePinnedKeys = null, requireVerified = false, allowUnverified = false } = {}) {
  const distDir = resolve(dist);
  const own = distDir === join(ROOT, 'dist');
  if (releaseList || releaseSig || releaseKey) {
    if (!releaseList || !releaseSig) throw new UsageError('checking the loader needs the signed release list: --release-list hashes-dist.json --release-sig hashes-dist.json.sig (and --release-key <pinned key>)');
    const pinnedKeys = releaseKeysToTrust(releasePinnedKeys);
    let publicKey;
    if (releaseKey) publicKey = isPublicKeyString(String(releaseKey).trim()) ? String(releaseKey).trim() : await readPublicKey(releaseKey);
    else if (pinnedKeys.length) publicKey = pinnedKeys[0];
    else throw new UsageError('--release-key <pinned public key file or p256:...> is needed: this copy of the tools has no release key built in yet');
    const list = readJsonFile(releaseList, 'the release list');
    const sig = readJsonFile(releaseSig, 'the release signature');
    const verdict = await verifyRelease({ dir: distDir, list, sig, publicKey, pinnedKeys, expectTree: 'dist', minVersion: TOOLS_VERSION });
    if (!verdict.ok) {
      throw new ToolError('refusing to publish the loader in ' + relPath(distDir) + ': it does not match the signed release list (' + verdict.reason + '): ' +
        verdict.problems.slice(0, 5).join('; ') + (verdict.problems.length > 5 ? '; ...' : '') + '. Nothing was written.');
    }
    return { verified: true, own, version: verdict.version, listHash: verdict.listHash, warning: null };
  }
  if (own) return { verified: false, own, version: null, listHash: null, warning: null };
  const how = 'pass the signed release list (--release-list hashes-dist.json --release-sig hashes-dist.json.sig --release-key <pinned key>, docs/DEPLOY.md)';
  if (requireVerified && !allowUnverified) {
    throw new UsageError('--dist ' + relPath(distDir) + ' is not this checkout\'s own build, and the loader is what visitors run with your keys: ' + how +
      ', or --allow-unverified-loader to deploy it unchecked.');
  }
  return { verified: false, own, version: null, listHash: null, warning: 'the loader in ' + relPath(distDir) + ' was not checked against the signed release list; ' + how };
}

/** stunList(list) → distinct stun: and stuns: URLs (at most 4). UsageError otherwise. */
export function stunList(list) {
  const result = [];
  for (const raw of list || []) {
    for (const value of String(raw).split(',').map((v) => v.trim()).filter(Boolean)) {
      if (!/^stuns?:[^\s,;]+$/i.test(value)) throw new UsageError('--stun must be a stun: or stuns: URL such as stun:stun.example.org:3478, got ' + JSON.stringify(value));
      if (result.indexOf(value) < 0) result.push(value);
    }
  }
  if (result.length > 4) throw new UsageError('--stun takes at most 4 servers (the pointer-sized config stays small), got ' + result.length);
  return result;
}

/** turnConfig(urls, mode) → { urls, mode } | null; at most 8 turn:, turns: or https: URLs. UsageError otherwise. */
export function turnConfig(list, mode) {
  const urls = [];
  for (const raw of list || []) for (const value of String(raw).split(',').map((v) => v.trim()).filter(Boolean)) if (urls.indexOf(value) < 0) urls.push(value);
  if (!urls.length) {
    if (mode) throw new UsageError('--turn-mode needs --turn <url>');
    return null;
  }
  if (urls.length > 8) throw new UsageError('--turn takes at most 8 URLs');
  for (const u of urls) if (u.length > 256 || !/^(turns?:|https:\/\/)[^\s]+$/.test(u)) throw new UsageError('--turn must be turn:, turns: or https: URLs, got ' + JSON.stringify(u));
  const allHttps = urls.every((u) => u.startsWith('https://'));
  const chosen = mode || (allHttps ? 'endpoint' : 'static');
  if (chosen !== 'static' && chosen !== 'endpoint') throw new UsageError('--turn-mode must be static or endpoint');
  if (chosen === 'endpoint' && !allHttps) throw new UsageError('--turn-mode endpoint takes https: URLs of a credential endpoint (that is a backend you run), not turn: URLs');
  if (chosen === 'static' && urls.some((u) => u.startsWith('https://'))) throw new UsageError('--turn-mode static takes turn: or turns: URLs');
  return { urls: urls.slice().sort(), mode: chosen };
}

/** ownTrackers(tr) → the entries of tr that are not the shared public default trackers. */
export function ownTrackers(tr) {
  return (tr || []).filter((t) => CONFIG.trackers.indexOf(t) < 0);
}

/**
 * featureProblems({ features, tr, stun }) → [text]: why chat, files or media cannot be turned on yet (MF-44). Each of them
 * rendezvouses and relays through the site's own tracker and STUN servers; the shared public ones see which sites one
 * address opens and are never used as a fallback for chat, private groups or private media.
 */
export function featureProblems({ features, tr, stun }) {
  if (!features || !features.length) return [];
  const problems = [];
  const names = features.join(', ');
  if (!ownTrackers(tr).length) {
    problems.push('--tracker <wss URL>: ' + names + ' is on, so the site must name its own tracker (the four shared public trackers are not used for it, MF-44)');
  }
  if (!stun || !stun.length) {
    problems.push('--stun <stun: URL>: ' + names + ' is on, so the site must name its own STUN server (the shared public STUN servers are not used as a fallback, MF-44)');
  }
  return problems;
}

/**
 * readNextKey(file) → the tagged public key of the next owner key. The file holds the key as text (p256:...), as a public JWK or as a
 * key file made by tools/keygen.mjs; only the public half is read. A private key file must still not be readable by others.
 */
export async function readNextKey(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ToolError('cannot read --next-key ' + file + ': ' + err.message);
  }
  const trimmed = text.trim();
  if (isPublicKeyString(trimmed)) return { pub: trimmed, privateFile: false };
  let jwk;
  try {
    jwk = JSON.parse(trimmed);
  } catch (_) {
    throw new ToolError(file + ' is neither a public key (p256:...) nor a JSON Web Key');
  }
  const privateFile = Boolean(jwk && typeof jwk.d === 'string');
  if (privateFile) assertPrivateKeyFile(file);
  try {
    return { pub: await publicFromPrivateJwk(jwk), privateFile };
  } catch (err) {
    throw new ToolError(file + ' is not a P-256 key: ' + err.message);
  }
}

/** featuresFromCfg(cfg) → { chat, files, media, calls } booleans from an _mw.cfg object: a feature is on when it is set and not 'off'. */
export function featuresFromCfg(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const on = (v) => v !== undefined && v !== 'off';
  return { chat: on(c.chat), files: on(c.files), media: on(c.media), calls: on(c.calls) };
}

/** featuresFromLedger(file) → { chat, files, media, calls } booleans from the _mw.cfg of a ledger export. */
export async function featuresFromLedger(file) {
  const led = await loadLedger(readBlocksFile(file));
  return featuresFromCfg(currentCfg(led.state));
}

/**
 * addressBoundScope(scope) → true for a scope that is tied to an address and cannot carry a DNS record (v0.3 C2, S2 F2 and Rc3):
 * a nip.io or sslip.io name, or an IP literal other than a loopback address. A new address is a new origin for such a site, and no
 * _magnet TXT record can exist for it. Loopback addresses and localhost are development scopes and keep the older defaults.
 */
export function addressBoundScope(scope) {
  let host;
  try {
    host = normalizeScope(String(scope));
  } catch (_) {
    return false;
  }
  if (host.startsWith('btih:')) return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isWildcardDnsName(bare)) return true;
  return isIP(bare) !== 0 && !isLoopbackHost(bare);
}

/**
 * readPreviousPointer({ prevPointer, outDir, scope }) → the last published record, or null. 'none' skips the check; a file is
 * given with --prev-pointer; by default <out>/pointer.txt is read when <out>/summary.json names the same scope.
 */
export function readPreviousPointer({ prevPointer = null, outDir, scope }) {
  if (prevPointer === 'none') return null;
  let file;
  if (prevPointer) {
    file = resolve(prevPointer);
    if (!existsSync(file)) throw new ToolError('--prev-pointer ' + prevPointer + ' does not exist');
  } else {
    file = join(outDir, 'pointer.txt');
    if (!existsSync(file)) return null;
    try {
      const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
      if (summary && summary.scope && summary.scope !== scope) return null;
    } catch (_) { /* no summary: trust the pointer file */ }
  }
  const parsed = parsePointer(readFileSync(file, 'utf8'));
  if (!parsed.ok || parsed.record.kind !== 'pointer' || !parsed.record.signed) {
    if (prevPointer) throw new ToolError('--prev-pointer ' + prevPointer + ' is not a signed pointer record');
    return null;
  }
  return parsed.record;
}

/**
 * widgetTags({ name, integrity, statement, challengeUrl, proofUrl }) → { script, element }
 * name 'signin' | 'chat-panel'. The script tag is the one of R 2.3.6: a module script on the site's own origin with integrity=
 * (never a central widget host, SC-7).
 */
export function widgetTags({ name, integrity, statement = '', challengeUrl = '/auth/mw/challenge', proofUrl = '/auth/mw/verify' } = {}) {
  const script = '<script type="module" src="/_mw/' + name + '.js" integrity="' + escapeAttr(integrity) + '" crossorigin></script>';
  const element = name === 'signin'
    ? '<mw-signin statement="' + escapeAttr(statement) + '" challenge-url="' + escapeAttr(challengeUrl) + '" proof-url="' + escapeAttr(proofUrl) + '"></mw-signin>'
    : '<mw-chat-panel></mw-chat-panel>'; // CONF-1: the panel reads only lang; tracker and stun come from the pointer and _mw.cfg
  return { script, element };
}

// ---------------------------------------------------------------------------------------------
// torrent
// ---------------------------------------------------------------------------------------------

function createTorrentAsync(input, opts) {
  return new Promise((resolvePromise, reject) => {
    try {
      createTorrent(input, opts, (err, buf) => (err ? reject(err) : resolvePromise(buf)));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * buildTorrent({ name, entries: [{ path, bytes }], announce, urlList }) → { torrentFile, infoHash, parsed }
 * create-torrent with name, 256 KiB pieces, the exact announce list (never its defaults), urlList
 * and createdBy 'felinar'; then the top-level "creation date" is removed (it is outside info,
 * so the infohash is unchanged and the file becomes reproducible). The result is parsed back and
 * checked: same infohash, same name, same file paths in the same order.
 */
/**
 * resolveCreationDate({ date, dir, env }) → { seconds, source } (v0.2.1 E4): the torrent's creation date
 * is a reproducible input, never the wall clock. --date (ISO 8601 or Unix seconds) wins, then
 * SOURCE_DATE_EPOCH, then the commit time of the site directory when it is in a git work tree; with
 * none of them the .torrent has no creation date at all (the v0.2 behaviour). seconds > 0 always
 * (create-torrent turns a zero date into "now").
 */
export function resolveCreationDate({ date = null, dir = null, env = process.env } = {}) {
  const parse = (value, what) => {
    const s = String(value).trim();
    let seconds = null;
    if (/^\d+$/.test(s)) seconds = Number(s);
    else {
      const ms = Date.parse(s);
      if (Number.isFinite(ms)) seconds = Math.floor(ms / 1000);
    }
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new UsageError(what + ' must be an ISO 8601 date or positive Unix seconds: ' + s);
    return seconds;
  };
  if (date !== null && date !== undefined && date !== '') return { seconds: parse(date, '--date'), source: 'flag' };
  if (env && env.SOURCE_DATE_EPOCH) return { seconds: parse(env.SOURCE_DATE_EPOCH, 'SOURCE_DATE_EPOCH'), source: 'SOURCE_DATE_EPOCH' };
  if (dir) {
    try {
      const res = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const s = res.status === 0 ? String(res.stdout || '').trim() : '';
      if (/^\d+$/.test(s) && Number(s) > 0) return { seconds: Number(s), source: 'git' };
    } catch (_) { /* no git: no date */ }
  }
  return { seconds: null, source: null };
}

/**
 * buildTorrent({ name, entries: [{ path, bytes }], announce, urlList, pieceLength, creationDate }) → { torrentFile, infoHash, parsed }
 * create-torrent with name, 256 KiB pieces, the exact announce list (never its defaults), urlList
 * and createdBy 'felinar'; then the top-level "creation date" is set to creationDate (Unix seconds,
 * v0.2.1 E4) or removed (it is outside info, so the infohash is the same either way and the file is
 * reproducible). The result is parsed back and checked: same infohash, same name, same file paths in
 * the same order.
 */
export async function buildTorrent({ name, entries, announce = [], urlList = [], pieceLength = PIECE_LENGTH, creationDate = null }) {
  const sorted = entries.slice().sort((a, b) => compareUtf8(a.path, b.path));
  const input = sorted.map((e) => {
    const view = new Uint8Array(e.bytes.buffer, e.bytes.byteOffset, e.bytes.byteLength);
    view.name = e.path;
    return view;
  });
  const opts = { name, pieceLength, announce: announce.slice(), createdBy: 'felinar' };
  if (urlList.length) opts.urlList = urlList.slice();
  const raw = new Uint8Array(await createTorrentAsync(input, opts));
  const first = await parseTorrentFile(raw);
  const { value } = bdecode(raw);
  if (Number.isSafeInteger(creationDate) && creationDate > 0) value['creation date'] = creationDate;
  else delete value['creation date'];
  const torrentFile = bencode(value);
  const parsed = await parseTorrentFile(torrentFile);
  if (parsed.infoHash !== first.infoHash) throw new Error('internal: removing the creation date changed the infohash');
  if (parsed.name !== name) throw new Error('internal: torrent name ' + parsed.name + ' differs from ' + name);
  const got = parsed.files.map((f) => f.path);
  const want = sorted.map((e) => e.path);
  if (got.length !== want.length || got.some((p, i) => p !== want[i])) {
    throw new Error('internal: create-torrent changed the file list (' + got.slice(0, 3).join(', ') + '...)');
  }
  return { torrentFile, infoHash: parsed.infoHash, parsed };
}

/**
 * rendezvousBtihFor(ledgerId) → the infohash of the ledger's rendezvous swarm (v0.2.1 B2, ARCHITECTURE
 * §5.5): sha1hex("mw-ledger/1/" + ledgerId), the bare infohash every loader announces for the ledger
 * (the same function the loader uses). A tracker started with --allow needs it next to the site btih.
 */
export async function rendezvousBtihFor(ledgerId) {
  return rendezvousInfoHash(ledgerId);
}

/**
 * DEPRECATED (v0.2.1 B2): the v0.2 one-piece anchor torrent is gone, so the ledger swarm's infohash is
 * the rendezvous infohash. Kept for one release as an alias of rendezvousBtihFor(), and summary.json
 * keeps "anchorBtih" (= rendezvousBtih) so trackers that read the v0.2 key keep allowing the ledger swarm.
 */
export async function anchorInfoHash(ledgerId) {
  return rendezvousBtihFor(ledgerId);
}

// ---------------------------------------------------------------------------------------------
// text outputs
// ---------------------------------------------------------------------------------------------

function quoteTxt(chunk) {
  return '"' + chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function shellSingleQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * dnsTxt({ scope, pointer, ttl }) → the text of dns.txt: the record name _magnet.<scope>, the value
 * split into quoted character-strings of at most 255 bytes, a zone-file line, a Route 53 change
 * batch and a Cloudflare API example.
 */
export function dnsTxt({ scope, pointer, ttl = 300 }) {
  const name = '_magnet.' + scope;
  const chunks = splitTxt(pointer);
  const quoted = chunks.map(quoteTxt).join(' ');
  const route53 = {
    Comment: 'felinar pointer for ' + scope,
    Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: name + '.', Type: 'TXT', TTL: ttl, ResourceRecords: [{ Value: quoted }] } }],
  };
  const cf = JSON.stringify({ type: 'TXT', name, content: quoted, ttl, comment: 'felinar pointer' });
  const lines = [
    '# DNS TXT record for the felinar pointer of ' + scope,
    '# The pointer is ' + utf8.encode(pointer).length + ' bytes, split into ' + chunks.length + ' character-strings of at most 255 bytes.',
    '# Resolvers join the strings with no separator. Publish the record only after the web seed passes',
    '# tools/check-webseed.mjs. Visitors read it over DNS-over-HTTPS (Cloudflare, then dns.sb, then Google).',
    '',
    'name:  ' + name,
    'type:  TXT',
    'ttl:   ' + ttl,
    'value: ' + quoted,
    '',
    '# Zone file',
    name + '. ' + ttl + ' IN TXT ' + quoted,
    '',
    '# Amazon Route 53: aws route53 change-resource-record-sets --hosted-zone-id <ZONE_ID> --change-batch file://route53.json',
    '# route53.json:',
    JSON.stringify(route53, null, 2),
    '',
    '# Cloudflare API (the content is RFC 1035 quoted character-strings):',
    'curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \\',
    '  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \\',
    '  --data ' + shellSingleQuote(cf),
    '',
  ];
  if (isLoopbackHost(scope) || /^\d{1,3}(\.\d{1,3}){3}$/.test(scope) || scope.indexOf(':') >= 0) {
    lines.unshift('# Note: ' + scope + ' is not a DNS name; the loader never looks up DNS pointers for IP addresses or localhost.', '');
  }
  return lines.join('\n');
}

/** The <meta> tag for the shell's <head> (meta.html). */
export function metaTag(pointer) {
  return '<meta name="mw-pointer" content="' + escapeAttr(pointer) + '">';
}

function encodePathSegments(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function joinBase(base, rel) {
  return (base.endsWith('/') ? base : base + '/') + rel;
}

function webseedLayout({ name, ws, xs, files, outDir, keepDays }) {
  const base = ws[0] || '<web seed base>/';
  const lines = [
    'Web seed layout for ' + name,
    '',
    'BEP 19 multi-file web seeds address files as <ws base>/<torrent name>/<file path>. Upload these keys',
    'under the web seed base ' + base + ' (the files are in ' + join(outDir, name) + '/ and ' + join(outDir, name + '.torrent') + '):',
    '',
  ];
  for (const f of files) lines.push('  ' + joinBase(base, encodePathSegments(name) + '/' + encodePathSegments(f.path)) + '   (' + f.length + ' bytes)');
  lines.push('  ' + joinBase(base, encodePathSegments(name) + '.torrent') + '   (the .torrent' + (xs.length ? '; xs= ' + xs.join(', ') : '') + ')');
  lines.push(
    '',
    'HTTP contract (DESIGN-REVIEW item 14). The loader\'s WebTorrent is patched to send only Range (v0.2.1 B3);',
    'Chromium 156 and WebKit 27.2 sent no preflight for it, but not every browser at the floor has been measured,',
    'and the stock client also sends Cache-Control and User-Agent, so a cross-origin web seed answers the',
    'preflight as well as the ranged GET:',
    '  OPTIONS          2xx with Access-Control-Allow-Origin: *, Access-Control-Allow-Headers: * (at least',
    '                   Range, Cache-Control, User-Agent) and Access-Control-Allow-Methods: GET, HEAD',
    '  GET with Range   206 Partial Content with Content-Range (ranges past the end are clamped)',
    '  every response   Access-Control-Allow-Origin: * and Access-Control-Expose-Headers: Content-Range,',
    '                   Content-Length, Accept-Ranges, ETag',
    'A web seed on the loader\'s own origin (for example https://<your host>/ws/) needs no CORS at all.',
    '',
    'Check it before switching the pointer:',
    '  node tools/check-webseed.mjs ' + base + ' ' + join(outDir, 'site.torrent'),
    '',
    'Amazon S3 CORS configuration (S3 answers the OPTIONS preflight itself from these rules;',
    'AllowedMethods cannot list OPTIONS):',
    JSON.stringify([{
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
      MaxAgeSeconds: 600,
    }], null, 2),
    '',
    'CloudFront: allow GET, HEAD and OPTIONS on the web seed\'s behaviour, cache OPTIONS responses and turn',
    'compression off there. The managed response headers policies CORS-With-Preflight and',
    'CORS-with-preflight-and-SecurityHeadersPolicy send no Access-Control-Allow-Headers (research w1-10 F5),',
    'so either attach a custom response headers policy that allows every request header (pay-as-you-go, or',
    'the Business flat-rate plan and up), or forward the CORS request headers to S3 with the managed origin',
    'request policy CORS-S3Origin, key the cache on Origin, and let the bucket\'s CORS rule above answer (this',
    'variant is untested). docs/DEPLOY.md, "Amazon S3 and CloudFront", has the policy JSON; check-webseed',
    'tells you whether your setup passes. Enable HTTP/2.',
    'S3 website endpoints are HTTP only: serve the bucket through CloudFront (REST endpoint with origin',
    'access control) or use GitHub Pages or Cloudflare Pages. Purge the CDN after every deploy.',
    '',
    'Deploy order (DESIGN-REVIEW item 22): (1) upload these files and the .torrent, (2) run',
    'check-webseed, (3) switch the pointer (meta tag, stamped pages or DNS TXT), (4) keep the previous',
    'version\'s files for at least ' + keepDays + ' days.',
    '',
  );
  return lines.join('\n');
}

function originOf(url, base) {
  try {
    return new URL(url, base).origin;
  } catch (_) {
    return null;
  }
}

export function cspText({ dropin, tr, ws, xs, cs, scope, widgets = [], features = [] }) {
  const site = 'https://' + scope;
  const extra = [];
  for (const u of [].concat(ws, xs, cs ? [cs] : [])) {
    const o = originOf(u, site + '/');
    if (o && o !== site && extra.indexOf(o) < 0) extra.push(o);
  }
  const trackers = tr.length ? tr.join(' ') : '(no trackers in the pointer)';
  if (!dropin) {
    return [
      'Shell mode: /_mw/boot.js inserts this Content-Security-Policy itself (ARCHITECTURE section 13). If your host',
      'also sends a CSP header for the shell pages (/index.html, /404.html), it must allow at least:',
      '',
      '  ' + SHELL_CSP,
      '',
      'Site files are served by the Service Worker inside the shell frame with',
      "  Content-Security-Policy: frame-ancestors 'self' (plus the headers of /.mw/site.json).",
      '',
    ].join('\n');
  }
  return [
    'Drop-in pages: additions your Content-Security-Policy needs (only if the site sends one; ARCHITECTURE section 3.4.9).',
    'The drop-in script never inserts a CSP <meta> of its own: your policy stays yours (v0.2.1 D4). Measured set:',
    '',
    "  script-src   'self'                 /_mw/mw.js and /_mw/sdk.js (with 'strict-dynamic' or nonces: a nonce on the",
    '                                      tag, or allow the integrity hash of /_mw/mw.js; see below)',
    "  worker-src   'self'                 /mw-sw.js and the proof-of-work worker /_mw/pow-worker.js",
    "  connect-src  'self' " + trackers + (extra.length ? ' ' + extra.join(' ') : ''),
  ].concat(widgets.length ? [
    "  script-src   'self'                 " + widgets.map((w) => w.path).join(' and ') + ' are module scripts on your own origin with integrity= (no inline script, no other host)',
  ] : [], features.length ? [
    '',
    'With ' + features.join(', ') + ' on, connect-src above must hold your own tracker (wss://...): the page connects to it for rendezvous.',
  ] : [], widgets.length ? [
    '',
    'Headers: the identity page opens in a popup and answers its opener. A page that signs in must not send',
    'Cross-Origin-Opener-Policy: same-origin; same-origin-allow-popups is safe (Referrer-Policy: no-referrer is advised).',
  ] : [], [
    '',
    'Drop-in pages never query DNS, so no DNS-over-HTTPS resolver belongs in connect-src (a pointer in DNS,',
    'dns.txt, is read only by shell and hub pages).',
    '',
    'Not needed: STUN or TURN hosts (ICE is outside connect-src in every engine), blob:, data:,',
    "'unsafe-inline' and 'unsafe-eval'. The runtime tag is:",
    '  ' + MW_SCRIPT,
    '',
  ]).join('\n');
}

// ---------------------------------------------------------------------------------------------
// drop-in stamping
// ---------------------------------------------------------------------------------------------

/**
 * stampHtml(buffer, pointer, { injectScript }) → { buffer, changed, end, hasScript }
 * Stamps <meta name="mw-pointer"> as the first child of <head> (after a leading <meta charset>,
 * which browsers only honour within the first 1024 bytes), replacing any earlier stamp, so
 * stamping twice gives the same bytes. The document is handled as latin1 so every
 * ASCII-compatible encoding keeps its bytes. With injectScript the runtime tag is added to
 * pages that lack it.
 */
export function stampHtml(buffer, pointer, { injectScript = false } = {}) {
  const text = Buffer.from(buffer).toString('latin1');
  const res = injectMeta(text, [{ name: 'mw-pointer', content: pointer }]);
  let html = res.html;
  const tags = scanTags(html).filter((t) => t.name === 'script' && /^\/_mw\/mw\.js(?:[?#].*)?$/.test(String(t.attrs.get('src') || '').trim()));
  let hasScript = tags.length > 0;
  // v0.2.1 D4 tag guards: Rocket Loader rewrites a tag without data-cfasync="false"; a page that loads
  // the runtime twice is harmless (the second module instance returns the first engine) but reported.
  const cfasync = tags.every((t) => String(t.attrs.get('data-cfasync') || '').trim().toLowerCase() === 'false');
  const duplicate = tags.length > 1;
  if (!hasScript && injectScript) {
    // Before </head> when there is one; otherwise right after the stamped meta, where the parser's
    // implicit <head> still is (pages that are bare fragments have no </head> at all).
    const close = /<\/head\s*>/i.exec(html);
    const at = close ? close.index : res.end;
    html = html.slice(0, at) + MW_SCRIPT + html.slice(at);
    hasScript = true;
  }
  const outBuf = Buffer.from(html, 'latin1');
  return { buffer: outBuf, changed: !outBuf.equals(Buffer.from(buffer)), end: res.end, hasScript, cfasync: hasScript ? (tags.length ? cfasync : true) : null, duplicate };
}

// ---------------------------------------------------------------------------------------------
// validation of flags
// ---------------------------------------------------------------------------------------------

function checkUrl(value, what, { allowRelative = false, schemes = ['https:'], loopbackSchemes = ['http:'] } = {}) {
  if (allowRelative && value.startsWith('/') && !value.startsWith('//')) return value;
  let u;
  try {
    u = new URL(value);
  } catch (_) {
    throw new UsageError(what + ' is not an absolute URL: ' + value);
  }
  if (schemes.includes(u.protocol)) return value;
  if (loopbackSchemes.includes(u.protocol) && isLoopbackHost(u.hostname)) return value;
  throw new UsageError(what + ' must use ' + schemes.join(' or ') + ' (' + loopbackSchemes.join('/') + ' only for localhost): ' + value);
}

function expandTrackers(list) {
  const outList = [];
  for (const t of list) {
    const items = t === 'public' ? CONFIG.trackers : [t];
    for (const u of items) {
      checkUrl(u, '--tr', { schemes: ['wss:'], loopbackSchemes: ['ws:'] });
      if (outList.indexOf(u) < 0) outList.push(u);
    }
  }
  return outList;
}

// ---------------------------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------------------------

/**
 * publish(options) → result. Options mirror the CLI flags in camelCase: { dir, name, scope, key,
 * ws, xs, tr, chain, max, cs, consent, exp, seq, policy, moderator, allow, bits, maxValueBytes,
 * maxChainBytes, genesis, newGenesis, dropin, injectScript, keepDays, verifyWs, out, dist, shell,
 * spa, spaPath, cleanUrls, trailingSlash, index, notFound, ignore, now, quiet }.
 * result = { mode, name, btih, rendezvousBtih, anchorBtih (deprecated = rendezvousBtih), ledgerId, gen, genesisReused, owner, fingerprint,
 *   pointer, record, magnet, files, total, outDir, outputs, warnings, verified }
 */
export async function publish(options) {
  const o = Object.assign({
    ws: [], xs: [], tr: [], moderator: [], allow: [], ignore: [], exp: DEFAULT_EXP_DAYS, keepDays: 7,
    out: 'dist-publish', dist: join(ROOT, 'dist'), now: Date.now(), quiet: false,
    includeDot: [], allowSecret: [], date: null, maxFiles: null, fromWxr: null, wxrDir: 'comments', doublePack: false,
    ct: null, lg: null, aud: null,
    org: [], tracker: [], stun: [], turn: [], turnMode: null, chat: false, files: false, media: false, calls: false, signinWidget: false, chatPanel: false,
    nextKey: null, nx: null, ml: null, idp: null, signinStatement: null, challengeUrl: null, proofUrl: null, prevPointer: null, cfgFrom: null,
  }, options);
  // o.log (code review round 1): where the report lines go (tests read them); stdout by default.
  const log = o.quiet ? () => {} : (typeof o.log === 'function' ? o.log : out);
  const warnings = [];
  const note = (msg) => {
    warnings.push(msg);
    if (!o.quiet) warn(msg);
  };

  // ---- flags -------------------------------------------------------------------------------
  if (!o.dir) throw new UsageError('missing <dir>');
  const dir = resolve(o.dir);
  if (!existsSync(dir)) throw new ToolError('no such directory: ' + o.dir);
  if (!o.name) throw new UsageError('missing --name');
  if (!NAME_RE.test(o.name)) throw new UsageError('--name must be 1 to 100 characters of A-Z a-z 0-9 . _ ~ - (it is the torrent name and a URL path segment)');
  if (OUTPUT_FILES.includes(o.name) || OUTPUT_FILES.includes(o.name + '.torrent') || /^(site|shell)$/i.test(o.name)) {
    throw new UsageError('--name ' + o.name + ' collides with an output file name');
  }
  if (!o.scope) throw new UsageError('missing --scope <hostname>');
  if (/^btih:/i.test(o.scope)) throw new UsageError('publish signs per-domain pointers; --scope must be a hostname');
  let scope;
  try {
    scope = normalizeScope(o.scope);
  } catch (err) {
    throw new UsageError('invalid --scope: ' + o.scope);
  }
  if (!o.key) throw new UsageError('missing --key owner.jwk');
  // v0.3 C2: a scope tied to an address has the site name as its default ledger label (the ledger id then does not depend on the address).
  const addressBound = addressBoundScope(scope);
  let chainDefaulted = false;
  if (!o.chain && addressBound) {
    if (o.name.length > 64) throw new UsageError('--scope ' + scope + ' is tied to an address, so the ledger label defaults to --name, which may be at most 64 characters as a label: pass --chain <label> or a shorter --name');
    o.chain = o.name;
    chainDefaulted = true;
  }
  // v0.3 C2 doors: link mode (--door). The ledger id of a hub-scope record is owner + chain, so the site keeps one ledger on every door
  // and across versions only with a chain label (an address-bound scope already defaults it to --name above).
  const doorHosts = doorList(o.door);
  if (doorHosts.length && !o.chain) {
    throw new UsageError('--door needs --chain <label>: the light link is signed for btih:<hex>, which changes with every version, and the ledger id follows owner and chain. ' +
      'Without a label every version would start a new ledger. A site published before without --chain keeps its ledger only through its page tag.');
  }
  const outDir = resolve(o.out);
  if (isInside(dir, outDir)) throw new UsageError('--out must not be inside the site directory');
  const ws = o.ws.map((u) => {
    checkUrl(u, '--ws');
    return u.endsWith('/') ? u : u + '/';
  });
  const tr = expandTrackers(o.tr);
  // v0.3: --tracker names the site's OWN tracker (never the public default four); it joins tr= after the --tr entries.
  const ownTrackerList = [];
  for (const t of o.tracker || []) {
    for (const u of String(t).split(',').map((x) => x.trim()).filter(Boolean)) {
      if (u === 'public') throw new UsageError('--tracker names your own tracker; the shared public ones are --tr public');
      checkUrl(u, '--tracker', { schemes: ['wss:'], loopbackSchemes: ['ws:'] });
      if (ownTrackerList.indexOf(u) < 0) ownTrackerList.push(u);
    }
  }
  for (const u of ownTrackerList) if (tr.indexOf(u) < 0) tr.push(u);
  const xsGiven = o.xs.map((u) => checkUrl(u, '--xs', { allowRelative: true }));
  if (o.cs) checkUrl(o.cs, '--cs', { allowRelative: true });
  if (o.consent && !['notice', 'gate'].includes(o.consent)) throw new UsageError('--consent must be notice or gate');
  // Code review round 1: at most 399 days (a visitor whose clock lags must not refuse it) and a seq
  // never ahead of the clock (one record with a huge seq would set a floor nobody can pass).
  if (!Number.isInteger(o.exp) || o.exp < 1 || o.exp > MAX_PUBLISH_EXP_DAYS) throw new UsageError('--exp must be 1 to ' + MAX_PUBLISH_EXP_DAYS + ' days');
  if (o.seq !== null && o.seq !== undefined && (!Number.isSafeInteger(o.seq) || o.seq < 0 || o.seq > Math.floor(o.now / 1000) + SEQ_PUBLISH_SLACK_S)) {
    throw new UsageError('--seq must be a non-negative integer no later than the current Unix time (' + Math.floor(o.now / 1000) + '); visitors refuse a seq more than a day ahead of their clock');
  }
  if (o.max !== null && o.max !== undefined && (!Number.isSafeInteger(o.max) || o.max <= 0)) throw new UsageError('--max must be a positive number of bytes');
  if (o.chain && !/^[\x21-\x7e]{1,64}$/.test(o.chain)) throw new UsageError('--chain must be 1 to 64 printable ASCII characters');
  // v0.2.1: pointer metadata (A3 grammar; F4 owner duties): ct= abuse and legal contact, lg= privacy and
  // terms page, aud= audience.
  if (o.ct) {
    let u = null;
    try {
      u = new URL(o.ct);
    } catch (_) { /* reported below */ }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'mailto:')) throw new UsageError('--ct must be an https: or mailto: URL (the abuse and legal contact)');
  }
  if (o.lg) checkUrl(o.lg, '--lg');
  // aud= is a token list (ARCHITECTURE §4, §8): the content audience (general, kids, sensitive) and the
  // tokens the loader's consent rule reads (config.consent.gateAudiences: personal data, an EEA, UK or
  // Quebec audience), which make the blocking consent gate the default (v0.2.1 C1).
  if (o.aud) o.aud = audienceList(o.aud);
  if (o.maxFiles !== null && o.maxFiles !== undefined && (!Number.isSafeInteger(o.maxFiles) || o.maxFiles < 1)) throw new UsageError('--max-files must be a positive number');
  // ---- v0.3 pointer fields, features and widgets (flags only; files are read below) ----------
  const org = orgList(o.org);
  if (o.ml !== null && o.ml !== undefined && o.ml !== '' && !isLoaderVersion(String(o.ml))) throw new UsageError("--ml must be a loader version 'x.y.z' such as 0.3.0");
  const ml = o.ml ? String(o.ml) : null;
  if (ml && CONFIG.version && compareVersions(ml, CONFIG.version) > 0) {
    note('--ml ' + ml + ' is newer than the loader in this repository (' + CONFIG.version + '): every loader older than ' + ml + ' refuses to mount the site and offers the update, this build included');
  }
  if (o.idp !== null && o.idp !== undefined && o.idp !== '' && !isOriginString(String(o.idp))) throw new UsageError('--idp must be an exact origin such as https://id.example.org');
  const idp = o.idp ? String(o.idp) : null;
  const stun = stunList(o.stun);
  const turn = turnConfig(o.turn, o.turnMode);
  if (o.nx !== null && o.nx !== undefined && o.nx !== '' && !/^[A-Za-z0-9_-]{43}$/.test(String(o.nx))) throw new UsageError('--nx must be the 43-character base64url sha256 of the next owner key (or give the key with --next-key <file>)');
  let nx = o.nx ? String(o.nx) : null;
  let nextOwner = null;
  if (o.nextKey) {
    const next = await readNextKey(o.nextKey);
    if (next.privateFile) note('--next-key ' + o.nextKey + ' holds a private key; this machine needs only its public half (p256:...). Keep the private key offline');
    nextOwner = next.pub;
    const commitment = await nextKeyCommitment(next.pub);
    if (nx && nx !== commitment) throw new UsageError('--nx is not the commitment of the key in --next-key');
    nx = commitment;
  }
  const cfgFeatures = o.cfgFrom ? await featuresFromLedger(o.cfgFrom) : { chat: false, files: false, media: false, calls: false };
  const features = [];
  // Calls are signalled over the chat lane, so --calls implies --chat (v0.3 C2, SZ 3.5).
  if (o.chat || o.chatPanel || o.calls || cfgFeatures.chat || cfgFeatures.calls) features.push('chat');
  if (o.files || cfgFeatures.files) features.push('files');
  if (o.media || cfgFeatures.media) features.push('media');
  if (o.calls || cfgFeatures.calls) features.push('calls');
  const gate = featureProblems({ features, tr, stun });
  if (gate.length) {
    throw new UsageError('refusing to publish: ' + features.join(', ') + (features.length > 1 ? ' are' : ' is') + ' on (MF-44), and the site names no tracker or STUN server of its own:\n  ' + gate.join('\n  ') +
      '\nThey are shown to every visitor in the consent card and see their IP address and when they are active; the shared public servers also see which sites one address opens.');
  }
  if (features.length && stun.length && stun.every((s) => (CONFIG.stun || []).some((d) => d.urls === s))) {
    note('--stun names only the shared default STUN servers; naming your own keeps one operator from seeing every site its visitors open');
  }
  if (o.chatPanel && !o.dropin) note('--chat-panel: the panel reads window.mw, which only drop-in pages define (/_mw/mw.js); publish with --dropin');
  if (o.signinStatement !== null && o.signinStatement !== undefined) {
    const problem = statementProblem(String(o.signinStatement));
    if (problem) throw new UsageError('--signin-statement is not a valid sign-in statement (' + problem + ')');
  }
  for (const [flag, value] of [['--challenge-url', o.challengeUrl], ['--proof-url', o.proofUrl]]) {
    if (value && !(String(value).startsWith('/') && !String(value).startsWith('//'))) throw new UsageError(flag + ' must be a path on the site\'s own origin, such as /auth/mw/challenge');
  }
  const creation = resolveCreationDate({ date: o.date, dir, env: o.env || process.env });
  const dropin = Boolean(o.dropin);
  if (o.verifyWs && !ws.length) throw new UsageError('--verify-ws needs --ws');
  if (o.verifyHost) {
    if (!o.dropin) throw new UsageError('--verify-host checks a drop-in host (the files at their own URLs); use --verify-ws for a web seed');
    checkUrl(o.verifyHost, '--verify-host');
  }

  // ---- drop-in refusals ----------------------------------------------------------------------
  if (dropin) {
    if (existsSync(join(dir, '_mw'))) throw new ToolError('refusing --dropin: ' + o.dir + ' already has /_mw/ (reserved for the felinar runtime; publish from the original site, not from an earlier output)');
    if (existsSync(join(dir, 'mw-sw.js'))) throw new ToolError('refusing --dropin: ' + o.dir + ' already has /mw-sw.js (reserved for the felinar Service Worker)');
    if (!existsSync(join(o.dist, 'mw-sw.js')) || !existsSync(join(o.dist, '_mw'))) {
      throw new ToolError('drop-in needs the built runtime in ' + relPath(o.dist) + ' (run: node build.mjs)');
    }
  }

  // ---- the loader against the signed release list (review round SUP-5), before the owner key is read -------------------------
  if (o.shell || dropin) {
    const checked = await checkLoaderRelease({
      dist: o.dist, releaseList: o.releaseList, releaseSig: o.releaseSig, releaseKey: o.releaseKey, releasePinnedKeys: o.releasePinnedKeys,
      requireVerified: Boolean(o.requireVerifiedLoader), allowUnverified: Boolean(o.allowUnverifiedLoader),
    });
    if (checked.warning) note(checked.warning);
    else if (checked.verified) log('loader    ' + relPath(resolve(o.dist)) + ' matches the signed release list (felinar ' + checked.version + ', list ' + checked.listHash.slice(0, 16) + '...)');
  }

  // ---- key ----------------------------------------------------------------------------------
  const identity = await loadOwnerKey(o.key);

  // ---- v0.3 widgets: read (and hashed) before anything is written ------------------------------
  const widgets = [];
  for (const [flag, name] of [['signinWidget', 'signin'], ['chatPanel', 'chat-panel']]) {
    if (!o[flag]) continue;
    const file = join(o.dist, '_mw', name + '.js');
    if (!existsSync(file)) {
      throw new ToolError('--' + (name === 'signin' ? 'signin-widget' : 'chat-panel') + ' needs ' + relPath(file) + ' (run: node build.mjs; the build skips it while src/widget/' + name + '.js is missing)');
    }
    const bytes = readFileSync(file);
    const integrity = 'sha384-' + sha384Base64(bytes);
    const tags = widgetTags({
      name,
      integrity,
      statement: o.signinStatement !== null && o.signinStatement !== undefined ? String(o.signinStatement) : 'Sign in to ' + scope,
      challengeUrl: o.challengeUrl || '/auth/mw/challenge',
      proofUrl: o.proofUrl || '/auth/mw/verify',
    });
    widgets.push({ name, path: '/_mw/' + name + '.js', bytes, integrity, script: tags.script, element: tags.element });
  }

  // ---- files --------------------------------------------------------------------------------
  if (existsSync(join(dir, '.mw'))) {
    throw new ToolError('refusing to publish: ' + o.dir + '/.mw/ exists, and /.mw/ is reserved for the files publish generates (publish from the original site, not from an earlier output)');
  }
  const site = collectSite(dir, { dropin, ignore: o.ignore, includeDot: o.includeDot });
  // v0.2.1 E1: path policy, before anything is written.
  if (site.lint.errors.length) {
    throw new ToolError('refusing to publish: ' + site.lint.errors.length + ' path(s) break the path policy (ARCHITECTURE §10, v0.2.1 E1):\n' +
      site.lint.errors.slice(0, 40).map((e) => '  ' + JSON.stringify(e.path) + ': ' + e.why).join('\n') +
      (site.lint.errors.length > 40 ? '\n  ... ' + (site.lint.errors.length - 40) + ' more' : '') +
      '\nRename the files (and the links to them), or leave them out with --ignore <path>.');
  }
  for (const w of site.lint.warnings) note(w.path + ': ' + w.why);
  if (!site.torrent.length) throw new ToolError('no files to publish in ' + o.dir + (dropin ? ' (drop-in leaves HTML out of the torrent)' : ''));
  const onDisk = site.torrent.reduce((n, f) => n + f.size, 0);
  if (onDisk > MAX_SITE_READ) {
    throw new ToolError('the site is ' + formatBytes(onDisk) + ' on disk. Visitors refuse sites above ' + formatBytes(CONFIG.limits.maxSiteBytesDesktop) +
      ' (desktop), and this tool reads the whole site into memory, so it stops at ' + formatBytes(MAX_SITE_READ) + '. Move large media to the host and out of the torrent (--ignore <path>).');
  }
  const links = site.skipped.filter((s) => /symbolic link/.test(s.reason));
  if (links.length) note(links.length + ' symbolic link(s) are not followed or published (first: ' + links[0].path + ')');
  for (const s of site.skipped) if (/well-known/.test(s.reason)) note('/.well-known/ is not put into the torrent; keep serving it from the host');
  const entries = site.torrent.map((f) => ({ path: f.path, bytes: readFileSync(f.abs) }));
  // v0.2.1 E3: legacy WordPress comments as static JSON, without commenter e-mail and IP addresses.
  let wxr = null;
  if (o.fromWxr) {
    const wxrDir = String(o.wxrDir || 'comments').replace(/^\/+|\/+$/g, '');
    if (!wxrDir || lintPaths([wxrDir + '/index.json']).errors.length) throw new UsageError('--wxr-dir must be a plain site path (not reserved, no ? # % or backslash)');
    let xml;
    try {
      xml = readFileSync(resolve(o.fromWxr), 'utf8');
    } catch (err) {
      throw new ToolError('cannot read --from-wxr ' + o.fromWxr + ': ' + err.message);
    }
    try {
      wxr = importWxr(xml, { dir: wxrDir });
    } catch (err) {
      throw new ToolError('--from-wxr ' + o.fromWxr + ': ' + err.message);
    }
    const taken = site.files.find((f) => f.path === wxrDir || f.path.startsWith(wxrDir + '/'));
    if (taken) throw new ToolError('--from-wxr writes ' + wxrDir + '/, but the site already has ' + taken.path + ' (choose another directory with --wxr-dir)');
    for (const f of wxr.files) entries.push({ path: f.path, bytes: f.bytes });
    const s = wxr.stats;
    log('WordPress export: ' + s.comments + ' comment(s) on ' + s.posts + ' post(s) written to /' + wxrDir + '/ as plain text; dropped ' + s.emails + ' commenter e-mail address(es), ' +
      s.ips + ' IP address(es), ' + s.unapproved + ' unapproved, spam or trashed comment(s), ' + s.pingbacks + ' pingback(s) and ' + s.unpublished + ' comment(s) of unpublished posts.');
  }
  // v0.2.1 E3: secrets and personal data, over everything this run publishes (the torrent and, for
  // drop-in, the pages of the deploy copy).
  {
    const scanned = entries.slice();
    if (dropin) for (const page of site.html) scanned.push({ path: page.path, bytes: readFileSync(page.abs) });
    const lint = lintSecrets(scanned, { allow: o.allowSecret });
    for (const w of lint.warnings) note(w.path + ': ' + w.why);
    if (lint.errors.length) {
      throw new ToolError('refusing to publish: ' + lint.errors.length + ' finding(s) look like secrets or personal data, and a torrent cannot be recalled once a peer holds it:\n' +
        lint.errors.slice(0, 40).map((e) => '  ' + e.path + ': ' + e.why).join('\n') +
        '\nRemove them from the site (or leave them out with --ignore <path>). If a finding is wrong, pass --allow-secret <path> after checking the file.');
    }
  }
  // v0.2.1 E1: every path this run leaves out, with the reason (dot paths follow an explicit table).
  const dropped = site.skipped.filter((s) => !/symbolic link/.test(s.reason));
  if (dropped.length && !o.quiet) {
    log('Left out of the torrent (' + dropped.length + '):');
    for (const s of dropped.slice(0, 30)) log('  ' + s.path + '  ' + s.reason);
    if (dropped.length > 30) log('  ... ' + (dropped.length - 30) + ' more (summary.json lists every one)');
  }
  const manifest = siteManifest({ files: entries, flags: o, redirectsText: site.redirectsText, headersText: site.headersText, dropin });
  // v0.3 (MF-44): the site's own STUN servers (and TURN, when chosen) live in the signed torrent, next to the routing manifest.
  if (stun.length) manifest.stun = stun;
  if (turn) manifest.turn = turn;
  // Shell mode routes with /.mw/site.json; drop-in pages keep the host's own rules, so only shell mode warns.
  const skippedRules = dropin ? [] : skippedRedirectLines(site.redirectsText);
  if (skippedRules.length) {
    note('_redirects: ' + skippedRules.length + ' line(s) use what the Service Worker does not support and are left out of /.mw/site.json (first: line ' +
      skippedRules[0].line + ': ' + skippedRules[0].text + '). Supported: from to [status][!], splats and :placeholders, statuses 200, 301, 302, 303, 307, 308 and 404; ' +
      'no query matching, conditions or proxying to another origin (docs/MIGRATION.md, "The shell path for new or peer-to-peer-first sites")');
  }
  if (!dropin && !entries.some((e) => e.path === manifest.index)) {
    note('the site has no ' + manifest.index + ' at its root: the home page / will answer 404 (set --index <file> if the entry page has another name)');
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  entries.push({ path: '.mw/site.json', bytes: manifestBytes });
  entries.sort((a, b) => compareUtf8(a.path, b.path));
  const fileList = {
    v: 1,
    name: o.name,
    files: entries.map((e) => ({ path: e.path, length: e.bytes.length, sha256: sha256Hex(e.bytes) })),
  };
  const fileListBytes = Buffer.from(JSON.stringify(fileList, null, 2) + '\n', 'utf8');
  entries.push({ path: '.mw/files.json', bytes: fileListBytes });
  entries.sort((a, b) => compareUtf8(a.path, b.path));
  const total = entries.reduce((n, e) => n + e.bytes.length, 0);
  if (o.max && total > o.max) throw new ToolError('the site is ' + total + ' bytes, more than --max ' + o.max + '; visitors would refuse it');
  if (!tr.length) note('no --tr: visitors will not find each other (signed pointers never use default trackers); the site loads from the web seed only');
  if (!ws.length && !xsGiven.length && !dropin) note('no --ws or --xs: the site only loads while another visitor is online');

  // ---- torrent ------------------------------------------------------------------------------
  const built = await buildTorrent({ name: o.name, entries, announce: tr, urlList: ws, creationDate: creation.seconds });
  const btih = built.infoHash;
  // v0.2.1 E4: --double-pack builds the torrent again from a second walk of the site and compares the
  // bytes (CI runs it on every release; a difference means the pack is not deterministic).
  if (o.doublePack) {
    const again = collectSite(dir, { dropin, ignore: o.ignore, includeDot: o.includeDot });
    const reEntries = again.torrent.map((f) => ({ path: f.path, bytes: readFileSync(f.abs) }));
    const generated = entries.filter((e) => !again.torrent.some((f) => f.path === e.path));
    const rebuilt = await buildTorrent({ name: o.name, entries: reEntries.concat(generated), announce: tr, urlList: ws, creationDate: creation.seconds });
    if (rebuilt.infoHash !== btih || !Buffer.from(rebuilt.torrentFile).equals(Buffer.from(built.torrentFile))) {
      throw new ToolError('--double-pack: a second pack of the same site gave ' + (rebuilt.infoHash !== btih ? 'another infohash (' + rebuilt.infoHash + ')' : 'other .torrent bytes') +
        '; the site changed while publishing, or the pack is not deterministic');
    }
    log('double-pack: identical .torrent bytes (btih ' + btih + ')');
  }

  // ---- ledger -------------------------------------------------------------------------------
  // Code review round 1 (item 3(c)): a key rotation keeps the ledger. The ledger id is bound to the
  // ledger's genesis owner; with --prev-key the genesis is read from genesis.json (or --genesis) and
  // the pointer carries lo=<genesis owner>, so visitors keep the same ledger id, database, swarm and
  // history, and check the new owner through rot= and the ledger's own hand-over (ledger-admin owner).
  const genesisFile = o.genesis ? resolve(o.genesis) : join(outDir, 'genesis.json');
  let ledgerOwner = identity.pub;
  if (o.ledgerOwner) {
    if (!isPublicKeyString(o.ledgerOwner)) throw new UsageError('--ledger-owner must be a tagged public key (p256:...)');
    ledgerOwner = o.ledgerOwner;
  } else if (o.prevKey && !o.newGenesis) {
    const root = existsSync(genesisFile) ? readBlocksFile(genesisFile).find((b) => b && b.e && Array.isArray(b.e.prev) && b.e.prev.length === 0) : null;
    if (!root) {
      throw new ToolError('--prev-key keeps the ledger, so it needs the ledger\'s genesis block: put genesis.json in ' + relPath(outDir) + ' or pass --genesis <file>. ' +
        'Pass --new-genesis to start a new, empty ledger instead (posts made before the rotation stay in the old one).');
    }
    ledgerOwner = root.e.author;
  }
  if (o.prevKey && o.newGenesis) note('--new-genesis with --prev-key: this starts a new, empty ledger; posts made before the rotation stay in the old one');
  const ledgerId = await ledgerIdForOwner(ledgerOwner, { scope, chain: o.chain || null });
  const policyGiven = {};
  if (o.policy) {
    if (!['owner', 'allow', 'open'].includes(o.policy)) throw new UsageError('--policy must be owner, allow or open');
    policyGiven.writers = o.policy;
  }
  if (o.bits !== null && o.bits !== undefined) policyGiven.bits = o.bits;
  if (o.maxValueBytes !== null && o.maxValueBytes !== undefined) policyGiven.maxValueBytes = o.maxValueBytes;
  if (o.maxChainBytes !== null && o.maxChainBytes !== undefined) policyGiven.maxChainBytes = o.maxChainBytes;
  if (o.moderator.length) policyGiven.moderators = o.moderator.slice();
  if (o.allow.length) policyGiven.allow = o.allow.slice();
  policyOp(policyGiven); // validates the flags early
  let genesis = null;
  let genesisReused = false;
  if (!o.newGenesis && existsSync(genesisFile)) {
    const blocks = readBlocksFile(genesisFile);
    const candidate = blocks.find((b) => b && b.e && Array.isArray(b.e.prev) && b.e.prev.length === 0);
    const check = await checkGenesis(candidate, { ledgerId, owner: ledgerOwner });
    if (check.ok) {
      const op = candidate.e.op;
      for (const k of Object.keys(policyGiven)) {
        const want = JSON.stringify(policyOp({ [k]: policyGiven[k] })[k]);
        if (JSON.stringify(op[k]) !== want) {
          throw new ToolError('the ledger genesis in ' + relPath(genesisFile) + ' has ' + k + '=' + JSON.stringify(op[k]) + ', but the flags ask for ' + want +
            '. Change the policy of a live ledger with tools/ledger-admin.mjs policy, or pass --new-genesis to start a new ledger root.');
        }
      }
      genesis = candidate;
      genesisReused = true;
    } else if (o.genesis || ledgerOwner !== identity.pub) {
      throw new ToolError(relPath(genesisFile) + ' is not a genesis block of this ledger: ' + check.reason);
    } else {
      note('ignoring ' + relPath(genesisFile) + ' (' + check.reason + '); minting a new genesis: this starts a new, empty ledger');
    }
  }
  if (!genesis && ledgerOwner !== identity.pub) throw new ToolError('the ledger belongs to ' + ledgerOwner + ' and its genesis block was not found; a new key cannot mint that ledger\'s genesis');
  if (!genesis) genesis = await createGenesis({ identity, ledgerId, policy: policyGiven, now: o.now });
  if (ledgerOwner !== identity.pub) {
    note('the pointer keeps the ledger of ' + ledgerOwner.slice(0, 16) + '... (lo=): its owner must hand control to this key once: ' +
      'node tools/ledger-admin.mjs owner --key <old key> --file <ledger export> --next ' + identity.pub + ' --accept-key <this key>, then publish the snapshot (tools/snapshot.mjs)');
  }
  // v0.2.1 B2: the ledger swarm is the rendezvous infohash; anchorBtih is its deprecated v0.2 name.
  const rendezvousBtih = await rendezvousBtihFor(ledgerId);
  const anchorBtih = rendezvousBtih;
  if (genesis.e.op.writers !== 'owner' && !o.cs) {
    note('the ledger lets visitors write (writers=' + genesis.e.op.writers + ') but there is no --cs: a visitor who cannot get the genesis block (gen=) from a peer cannot post. Upload ' +
      relPath(join(outDir, 'genesis.json')) + ' and pass its URL as --cs');
  }
  // v0.2.1 F4 (owner duties): an open ledger is a place where anyone can write, so the pointer names
  // who answers abuse and legal notices (ct=).
  if (genesis.e.op.writers === 'open' && !o.ct) {
    note('the ledger lets anyone write (writers=open) but the pointer has no contact for abuse and legal notices: add --ct <https: or mailto: URL> (docs/DEPLOY.md, "Owner duties")');
  }
  // Code review v0.3 (round 2, MF-54): an open ledger is said so on every publish that makes one.
  if (genesis.e.op.writers === 'open') note(OPEN_WRITING_WARNING);

  // ---- pointer -----------------------------------------------------------------------------
  const nowSec = Math.floor(o.now / 1000);
  const seq = o.seq !== null && o.seq !== undefined ? o.seq : nowSec;
  const exp = nowSec + o.exp * 86400;
  let xs = xsGiven.slice();
  if (dropin) xs = ['/_mw/t/' + btih + '.torrent'].concat(xs.filter((u) => u !== '/_mw/t/' + btih + '.torrent'));
  else if (!xs.length && ws.length) xs = [joinBase(ws[0], encodeURIComponent(o.name) + '.torrent')];
  let rot = null;
  if (o.prevKey) {
    // Key rotation (ARCHITECTURE section 4): the previous owner key signs the new one, so returning
    // visitors accept the change without the "publisher key changed" prompt.
    const previous = await loadOwnerKey(o.prevKey);
    if (previous.pub === identity.pub) throw new UsageError('--prev-key is the same key as --key');
    // code review round 1: the rotation is bound to this scope and chain label.
    rot = await signRotation({ owner: identity.pub, seq, scope, chain: o.chain || null }, previous.privateKey);
    // Review round R 5.3 (PTR-5): loaders time a key change from seq, so every publish that signs rot= again starts the 24 h
    // first-visit wait again; and a --prev-key that is not the genesis key (lo=) cannot prove the lineage on a cold device.
    note('--prev-key: this record carries rot= at seq ' + seq + '. Visitors who never saw the old key wait up to 24 hours after each publish that signs rot= again; publish without --prev-key once returning visitors have the new key.');
    if (ledgerOwner && previous.pub !== ledgerOwner) note('--prev-key is not the ledger\'s genesis key (lo=): a device that never saw the previous record cannot prove the hand-over, and hub addresses refuse it.');
  }
  // v0.3 (MF-28): the commitment to the next owner key and its continuity with the previous record.
  if (nextOwner && nextOwner === identity.pub) throw new UsageError('--next-key is the key this pointer is signed with: commit to a different key, kept offline');
  const previous = readPreviousPointer({ prevPointer: o.prevPointer, outDir, scope });
  if (previous && previous.nx) {
    if (previous.owner === identity.pub) {
      if (nx === null) {
        nx = previous.nx;
        note('nx= carried over from the previous pointer: a record of the same owner must keep the commitment, or loaders that hold the previous record refuse this one (nx-changed)');
      } else if (nx !== previous.nx) {
        throw new ToolError('the previous pointer commits to a next owner key (nx=' + previous.nx + ') and a record of the same owner must carry the same nx=: ' +
          'loaders that hold the previous record would refuse this one (nx-changed). Give --next-key the committed key, or leave it out. The commitment changes only by rotating to the committed key.');
      }
    } else {
      const mine = await nextKeyCommitment(identity.pub);
      if (mine !== previous.nx) {
        throw new ToolError('the previous pointer commits to a different next owner key (nx=' + previous.nx + ', this key gives ' + mine + '): loaders that hold the previous record refuse this one (nx-mismatch), ' +
          'even with --prev-key. Sign with the committed key, or pass --prev-pointer none to start the scope afresh for visitors who never saw the previous record.');
      }
      note('this key is the committed next owner key (nx= matches the previous pointer): loaders accept the change without a prompt; commit to a new next key with --next-key');
    }
  }
  const unsigned = {
    v: 'mw1', btih, dn: o.name, xs, ws, tr, chain: o.chain || null, max: o.max || null, owner: identity.pub,
    lo: ledgerOwner !== identity.pub ? ledgerOwner : null, gen: genesis.h, rot, cs: o.cs || null, consent: o.consent || null, seq, exp,
  };
  if (o.aud) unsigned.aud = o.aud;
  if (o.ct) unsigned.ct = o.ct;
  if (o.lg) unsigned.lg = o.lg;
  if (org.length) unsigned.org = org.slice();
  if (nx) unsigned.nx = nx;
  if (ml) unsigned.ml = ml;
  if (idp) unsigned.idp = idp;
  const record = await signPointer(unsigned, scope, identity.privateKey);
  const pointer = formatPointer(record);
  const check = await verifyPointer(record, scope, { now: o.now });
  if (!check.ok) throw new Error('internal: the signed pointer does not verify (' + check.reason + ')');
  const magnet = magnetFromRecord(record, { base: 'https://' + scope + '/' });
  // MW-PTR/1 size budget (v0.2.1 A3): SHOULD <= 450 bytes, MUST <= 900 bytes.
  const budget = pointerBudget(pointer);
  if (!budget.withinMax) {
    throw new ToolError('the pointer is ' + budget.bytes + ' bytes; a pointer must stay at or under ' + POINTER_SIZE_MAX + ' bytes (MW-PTR/1). Use fewer --tr and --ws entries and shorter URLs (a shorter --name or web-seed path also shortens xs=)');
  }
  if (addressBound) {
    // v0.3 C2 (S2 F16 and F18, Rc3): the size budget is a DNS budget, and this name cannot carry a DNS record.
    note('This name cannot carry a DNS record; the page tag is the only pointer (expires ' + isoDate(exp * 1000) + ').');
  } else if (!budget.withinShould) {
    note('the pointer is ' + budget.bytes + ' bytes in ' + budget.strings + ' TXT strings; pointers should stay at or under ' + POINTER_SIZE_SHOULD + ' bytes (fewer --tr and --ws entries make it shorter)');
  }
  // ---- v0.3 C2 doors: the light link (the same record signed for the hub scope, with dr=) ----------------
  let link = null;
  if (doorHosts.length) {
    const linkScope = 'btih:' + btih;
    let linkRot = null;
    if (o.prevKey) {
      const prevForLink = await loadOwnerKey(o.prevKey);
      linkRot = await signRotation({ owner: identity.pub, seq, scope: linkScope, chain: o.chain || null }, prevForLink.privateKey);
    }
    const linkRecord = await signPointer(Object.assign({}, unsigned, { rot: linkRot, dr: doorHosts.slice() }), linkScope, identity.privateKey);
    const linkText = formatPointer(linkRecord);
    const linkCheck = await verifyPointer(linkRecord, linkScope, { now: o.now });
    if (!linkCheck.ok) throw new Error('internal: the link record does not verify (' + linkCheck.reason + ')');
    const linkBudget = pointerBudget(linkText);
    if (!linkBudget.withinMax) {
      throw new ToolError('the link record is ' + linkBudget.bytes + ' bytes; a record must stay at or under ' + POINTER_SIZE_MAX + ' bytes (MW-PTR/1). Use fewer --door, --org, --tr and --ws entries and shorter URLs');
    }
    if (!linkBudget.withinShould) note('the link record is ' + linkBudget.bytes + ' bytes (records should stay at or under ' + POINTER_SIZE_SHOULD + '): the link and its QR code grow with every door; fewer --door entries make them smaller');
    const linkLedger = await ledgerIdFor(linkRecord, linkScope);
    const primary = formatLightLink({ door: doorHosts[0], record: linkText });
    const fallbacks = doorHosts.slice(1, 3).map((h) => formatLightLink({ door: h, record: linkText }));
    // The site's own address is a door too (every build has /_mw/open.html), unless it is already listed.
    if (!dropin && fallbacks.length < 2 && isDoorHost(scope) && doorHosts.indexOf(scope) < 0) fallbacks.push(formatLightLink({ door: scope, record: linkText }));
    const web = formatLightLink({ record: linkText });
    const qr = qrEncode(primary, { ecl: 'L' });
    link = { record: linkRecord, text: linkText, scope: linkScope, ledgerId: linkLedger, bytes: linkBudget.bytes, primary, fallbacks, web, qr, doors: doorHosts.slice() };
  }
  const torrentFiles = built.parsed.files.map((f, i) => ({ path: f.path, length: f.length, sha256: sha256Hex(entries[i].bytes) }));
  // v0.2.1 E2: budget gates and the size report (before anything is written).
  const sizes = budgetReport({
    files: entries.map((e) => ({ path: e.path, length: e.bytes.length })), torrentBytes: built.torrentFile.length, pieceCount: built.parsed.pieceCount,
    xs: xs.length > 0, mode: dropin ? 'dropin' : 'shell', maxFiles: o.maxFiles || undefined,
    limits: { desktop: CONFIG.limits.maxSiteBytesDesktop, mobile: CONFIG.limits.maxSiteBytesMobile, cellular: CONFIG.limits.maxSiteBytesCellular },
  });
  if (sizes.errors.length) throw new ToolError('refusing to publish (budget, v0.2.1 E2):\n  ' + sizes.errors.join('\n  '));
  for (const w of sizes.warnings) note(w);

  // ---- phase 1: outputs without the pointer -------------------------------------------------
  mkdirSync(outDir, { recursive: true });
  // Only trees publish owns are replaced, and never one that holds the site itself.
  const replaceTree = (target) => {
    if (isInside(target, dir) || !isInside(outDir, target)) throw new ToolError('refusing to replace ' + target + ': it contains the site directory');
    removeTree(target);
  };
  // Whatever an earlier run wrote with a pointer in it is stale from here on, and must not survive a
  // failed --verify-ws: the pointer files, the summary, and the stamped trees this run will rebuild.
  for (const rel of ['pointer.txt', 'magnet.txt', 'meta.html', 'dns.txt', 'summary.json'].concat(LINK_FILES)) removeTree(join(outDir, rel)); // C2 doors: and the link files
  if (dropin) replaceTree(join(outDir, 'site'));
  if (o.shell) replaceTree(join(outDir, 'shell'));
  const outputs = [];
  const write = (rel, data, opts) => {
    writeFileAtomic(join(outDir, rel), data, opts);
    outputs.push(rel);
  };
  write('site.torrent', built.torrentFile);
  if (!dropin) {
    write(o.name + '.torrent', built.torrentFile);
    replaceTree(join(outDir, o.name));
    for (const e of entries) writeFileAtomic(join(outDir, o.name, ...e.path.split('/')), e.bytes);
    outputs.push(o.name + '/');
  }
  writeBlocksFile(join(outDir, 'genesis.json'), [genesis]);
  outputs.push('genesis.json');
  // Post-wave fix M: drop-in pages use the host's own files as the web seed (/_mw/ws/, same origin) and never
  // read DNS, so a drop-in publish writes no webseed-layout.txt (and removes one an earlier shell publish left).
  if (dropin) removeTree(join(outDir, 'webseed-layout.txt'));
  else write('webseed-layout.txt', webseedLayout({ name: o.name, ws, xs, files: torrentFiles, outDir: relPath(outDir), keepDays: o.keepDays }));
  write('csp.txt', cspText({ dropin, tr, ws, xs, cs: o.cs, scope, widgets, features }));
  // v0.3: the headers a shell host sends with the loader pages, whatever the mode (shell mode also lays them out in shell/_headers).
  write('loader-headers.txt', loaderHeadersText());
  removeTree(join(outDir, 'widget'));
  if (widgets.length) {
    for (const w of widgets) writeFileAtomic(join(outDir, 'widget', '_mw', w.name + '.js'), w.bytes);
    writeFileAtomic(join(outDir, 'widget', 'tags.html'), widgets.map((w) => '<!-- ' + w.name + ' -->\n' + w.script + '\n' + w.element + '\n').join('\n'));
    outputs.push('widget/');
  }
  if (existsSync(join(o.dist, 'mw-sw-kill.js'))) write('mw-sw-kill.js', readFileSync(join(o.dist, 'mw-sw-kill.js')));
  // v0.2.1 F7: the static /_mw/sdk.js stub, for a plain copy of the site or after the runtime is removed.
  if (existsSync(join(o.dist, '_mw', 'sdk-static.js'))) write('sdk-static.js', readFileSync(join(o.dist, '_mw', 'sdk-static.js')));

  // ---- --verify-ws gate ---------------------------------------------------------------------
  // The web seed must already serve the uploaded files: run publish once to get the upload
  // directory, upload it, then run publish again with --verify-ws (same files, same infohash).
  let verified = null;
  if (o.verifyWs) {
    verified = true;
    const xsAbs = xs.filter((u) => /^https?:/i.test(u));
    const siteOrigin = (isLoopbackHost(scope) ? 'http://' : 'https://') + scope;
    for (const base of ws) {
      const targets = webseedTargets(base, built.parsed, xsAbs);
      log('verify-ws: ' + built.parsed.name + ' (btih ' + btih + ', ' + targets.files + ' files)');
      log('verify-ws: will contact ' + targets.origins.join(', ') + ': OPTIONS and GET (Range: bytes=0-0) per file, ranged GETs for the SHA-1 of the first and last piece' + (targets.xs ? ', GET per xs URL' : '') + '.');
      const res = await checkWebseed({
        wsBase: base, torrent: built.parsed, xs: xsAbs, origin: siteOrigin, allowNoPreflight: Boolean(o.allowNoPreflight),
        onResult: (r) => {
          for (const w of r.warnings || []) note('verify-ws: ' + (r.url || r.path) + ': ' + w);
          if (r.ok) return;
          log('  FAIL  ' + (r.url || r.path));
          for (const p of r.problems) log('        ' + p);
        },
      });
      if (res.stock && res.stock.checked && res.stock.ok === false) {
        log('verify-ws: the stock WebTorrent request headers (cache-control, range, user-agent) would fail the preflight here; felinar\'s build sends only Range (v0.2.1), so this does not block');
      }
      log('verify-ws: ' + base + (res.ok ? ' OK (' + res.results.length + ' checks passed, verdict ' + res.verdict + ')' : ' FAILED (' + res.failed + ' of ' + res.results.length + ' checks, verdict ' + res.verdict + ')'));
      if (!res.ok) verified = false;
    }
    if (!verified) {
      throw new ToolError('--verify-ws failed: the pointer was not written or printed. Upload ' + relPath(join(outDir, o.name)) +
        '/ and ' + o.name + '.torrent to ' + ws[0] + ', fix the problems above, then publish again (same files give the same infohash).');
    }
  }
  // ---- --verify-host gate (drop-in, v0.2.1 B4: host mode of the same verification tool) -------------
  // The drop-in Service Worker's /_mw/ws/ rewrite fetches each file whole from the host, so the live
  // host must give browsers the torrent's exact bytes (an image optimiser or minifier would make every
  // piece fail). Upload the non-HTML files first, then run publish with --verify-host before the pages.
  let hostVerified = null;
  if (o.verifyHost) {
    const base = o.verifyHost.endsWith('/') ? o.verifyHost : o.verifyHost + '/';
    log('verify-host: will contact ' + new URL(base).origin + ': a full GET of each of ' + built.parsed.files.filter((f) => !f.pad).length + ' files with browser Accept headers.');
    const res = await verifyHostFiles({
      base, torrent: built.parsed, mode: 'host',
      onResult: (r) => {
        for (const w of r.warnings || []) note('verify-host: ' + r.url + ': ' + w);
        if (r.ok) return;
        log('  FAIL  ' + r.url);
        for (const p of r.problems) log('        ' + p);
      },
    });
    hostVerified = res.ok;
    log('verify-host: ' + base + (res.ok ? ' OK (' + res.results.length + ' files, every piece hash checked)' : ' FAILED (' + res.failed + ' of ' + res.results.length + ' files, verdict ' + res.verdict + ')'));
    if (!res.ok) {
      throw new ToolError('--verify-host failed: the pointer was not written or printed and no page was stamped (' + relPath(join(outDir, 'site')) + '/ was removed). ' +
        'Publish without --verify-host to get the deploy copy, upload its non-HTML files (not the pages), fix the problems above, then publish again with --verify-host ' +
        '(same files give the same infohash) and upload the pages it stamps.');
    }
  }
  if (!o.verifyWs && ws.length) {
    note('the web seed ' + ws[0] + ' has not been checked: after uploading, run publish again with --verify-ws (or node tools/check-webseed.mjs ' +
      ws[0] + ' ' + relPath(join(outDir, 'site.torrent')) + ') before you switch the pointer');
  }

  // ---- phase 2: pointer outputs ---------------------------------------------------------------
  write('pointer.txt', pointer + '\n');
  write('magnet.txt', magnet + '\n');
  write('meta.html', metaTag(pointer) + '\n');
  write('dns.txt', dnsTxt({ scope, pointer }));
  // v0.3 C2 doors: the light link, its card with a QR code, and the machine-readable door list.
  let doorsSummary = null;
  if (link) {
    doorsSummary = {
      v: 1, kind: 'felinar-doors', name: o.name, btih, ledgerId: link.ledgerId, scope: link.scope, record: link.text, bytes: link.bytes,
      seq, exp, expires: isoDate(exp * 1000),
      owner: org.map((x) => hostOfOrigin(x)).filter(Boolean), guest: link.doors.slice(),
      links: { primary: link.primary, fallbacks: link.fallbacks.slice(), web: link.web },
      qr: { version: link.qr.version, ecl: link.qr.ecl, size: link.qr.size },
      fullDoor: dropin ? null : { webseed: '/ws/' + o.name + '/', torrent: '/_mw/t/' + btih + '.torrent' },
    };
    write('link.txt', link.primary + '\n');
    write('link-card.txt', linkCardText({ name: o.name, primary: link.primary, fallbacks: link.fallbacks, web: link.web, qr: link.qr, bytes: link.bytes, expires: isoDate(exp * 1000) }));
    write('link-qr.svg', qrSvg(link.qr));
    write('doors.json', JSON.stringify(doorsSummary, null, 2) + '\n');
  }

  let pagesWithoutScript = [];
  const pagesWithoutCfasync = [];
  const pagesWithDuplicateTag = [];
  if (dropin) {
    const siteOut = join(outDir, 'site');
    replaceTree(siteOut);
    copyTree(dir, siteOut, { skip: (rel, isDir) => deploySkip(rel, isDir, o.includeDot) });
    applyNfcRenames(siteOut, site.lint.renames);
    if (wxr) for (const f of wxr.files) writeFileAtomic(join(siteOut, ...f.path.split('/')), f.bytes);
    for (const p of ['.mw/site.json', '.mw/files.json']) {
      const e = entries.find((x) => x.path === p);
      writeFileAtomic(join(siteOut, ...p.split('/')), e.bytes);
    }
    copyTree(join(o.dist, '_mw'), join(siteOut, '_mw'));
    for (const w of widgets) {
      const copied = join(siteOut, '_mw', w.name + '.js');
      if (!existsSync(copied) || !readFileSync(copied).equals(w.bytes)) throw new ToolError('internal: the deploy copy does not hold ' + w.path + ' as built');
    }
    writeFileAtomic(join(siteOut, 'mw-sw.js'), readFileSync(join(o.dist, 'mw-sw.js')));
    writeFileAtomic(join(siteOut, '_mw', 't', btih + '.torrent'), built.torrentFile);
    if (!existsSync(join(siteOut, '.nojekyll'))) writeFileAtomic(join(siteOut, '.nojekyll'), '');
    if (!existsSync(join(o.dist, '_mw', 'mw.js'))) note('the build has no /_mw/mw.js yet (src/dropin/mw.js missing); drop-in pages will not start until it is built');
    for (const page of site.html) {
      const target = join(siteOut, ...page.path.split('/'));
      const original = readFileSync(target);
      if (isUtf16(original)) {
        note('skipping UTF-16 page ' + page.path + ' (only ASCII-compatible encodings are stamped)');
        continue;
      }
      const stamped = stampHtml(original, pointer, { injectScript: o.injectScript });
      if (stamped.end > 4096) note(page.path + ': the stamped pointer ends at byte ' + stamped.end + '; the Service Worker reads only the first 4 KiB');
      if (!stamped.hasScript) pagesWithoutScript.push(page.path);
      if (stamped.cfasync === false) pagesWithoutCfasync.push(page.path);
      if (stamped.duplicate) pagesWithDuplicateTag.push(page.path);
      writeFileAtomic(target, stamped.buffer);
    }
    outputs.push('site/');
  }

  if (o.shell) {
    const shellOut = join(outDir, 'shell');
    if (!existsSync(join(o.dist, 'index.html'))) throw new ToolError('--shell needs the built loader in ' + relPath(o.dist) + ' (run: node build.mjs)');
    replaceTree(shellOut);
    copyTree(o.dist, shellOut);
    {
      // v0.3: Cross-Origin-Opener-Policy: same-origin-allow-popups and Referrer-Policy: no-referrer for the loader pages.
      const headersFile = join(shellOut, '_headers');
      const ours = loaderHeadersText();
      writeFileAtomic(headersFile, existsSync(headersFile) ? readFileSync(headersFile, 'utf8').replace(/\s*$/, '\n\n') + ours : ours);
      outputs.push('shell/_headers');
    }
    for (const page of ['index.html', '404.html']) {
      const target = join(shellOut, page);
      if (existsSync(target)) writeFileAtomic(target, stampHtml(readFileSync(target), pointer).buffer);
    }
    outputs.push('shell/');
  }

  const summary = {
    v: 1,
    tool: 'felinar publish ' + TOOLS_VERSION,
    mode: dropin ? 'dropin' : 'shell',
    name: o.name,
    btih,
    rendezvousBtih,
    anchorBtih,
    pieceLength: built.parsed.pieceLength,
    length: built.parsed.length,
    files: torrentFiles,
    scope,
    ledgerId,
    hubLabel: hubLabelFor(record, ledgerId),
    owner: identity.pub,
    ledgerOwner,
    fingerprint: identity.fingerprint,
    gen: genesis.h,
    genesisReused,
    policy: (({ t, ...rest }) => rest)(genesis.e.op),
    seq,
    exp,
    expires: isoDate(exp * 1000),
    tr,
    ws,
    xs,
    cs: o.cs || null,
    consent: o.consent || null,
    max: o.max || null,
    pointer,
    magnet,
    torrent: 'site.torrent',
    webseed: dropin ? { base: '/_mw/ws/', root: o.name + '/', note: 'the drop-in Service Worker serves /_mw/ws/<name>/<path> from /<path>' } : { base: ws[0] || null, root: o.name + '/', torrentKey: o.name + '.torrent' },
    dns: { name: '_magnet.' + scope, chunks: splitTxt(pointer).length },
    keepDays: o.keepDays,
    creationDate: creation.seconds,
    creationDateSource: creation.source,
    aud: o.aud || null,
    ct: o.ct || null,
    lg: o.lg || null,
    org,
    nx,
    nextOwner,
    ml,
    idp,
    features,
    stun,
    turn,
    widgets: widgets.map((w) => ({ name: w.name, path: w.path, integrity: w.integrity, script: w.script, element: w.element })),
    loaderHeaders: Object.assign({}, LOADER_HEADER_VALUES),
    size: { files: sizes.count, bytes: sizes.total, largest: sizes.largest ? { path: sizes.largest.path, length: sizes.largest.length } : null, torrentBytes: built.torrentFile.length, report: sizes.lines },
    dropped: dropped.map((s) => ({ path: s.path, reason: s.reason })),
    renamed: site.lint.renames,
    wxr: wxr ? wxr.stats : null,
    verifiedWebseed: verified,
    verifiedHost: hostVerified,
    link: doorsSummary ? { primary: doorsSummary.links.primary, fallbacks: doorsSummary.links.fallbacks, doors: doorsSummary.guest, bytes: doorsSummary.bytes } : null, // C2 doors
  };
  write('summary.json', JSON.stringify(summary, null, 2) + '\n');

  // ---- report -------------------------------------------------------------------------------
  log('felinar publish (' + summary.mode + ' mode)');
  log('  site      ' + relPath(dir) + ' -> ' + o.name + ' (' + entries.length + ' files, ' + formatBytes(total) + ')');
  log('  btih      ' + btih);
  log('  ledger    ' + ledgerId + ' (owner ' + identity.fingerprint + ', gen ' + genesis.h.slice(0, 16) + '..., ' + (genesisReused ? 'reused' : 'new') + ')');
  log('  ledger rv ' + rendezvousBtih + ' (the ledger rendezvous swarm; allow it on your tracker too: --allow ' + relPath(join(outDir, 'summary.json')) + ')');
  if (chainDefaulted) log('  chain     ' + o.chain + ' (the default for a name tied to an address: the ledger stays the same when the site moves to another address or a domain)');
  log('  xs        ' + (xs.join(' ') || '(none)'));
  log('  ws        ' + (ws.join(' ') || '(none)'));
  log('  tr        ' + (tr.join(' ') || '(none)'));
  log('  pointer   seq ' + seq + ', expires ' + summary.expires + ' (' + o.exp + ' days)');
  log('  created   ' + (creation.seconds ? isoDate(creation.seconds * 1000) + ' (' + creation.source + ')' : 'no creation date (pass --date, set SOURCE_DATE_EPOCH or publish from a git work tree)'));
  if (org.length) log('  org       ' + org.join(' '));
  if (nx) log('  nx        ' + nx + (nextOwner ? ' (commits to the next owner key ' + nextOwner.slice(0, 16) + '...)' : ''));
  if (ml) log('  ml        ' + ml);
  if (idp) log('  idp       ' + idp);
  if (features.length) log('  features  ' + features.join(', ') + ' (own tracker ' + ownTrackers(tr).join(' ') + ', STUN ' + stun.join(' ') + ')');
  if (o.calls) log('            calls are off for readers until the ledger says so: node tools/ledger-admin.mjs cfg --key <owner.jwk> --file <ledger.json> --chat members --calls contacts');
  if (turn) {
    log('  turn      ' + turn.mode + ' ' + turn.urls.join(' ') + ' (off for visitors until they choose "Connect directly"; the card names this operator)');
    log('            also advertise it to readers: node tools/ledger-admin.mjs cfg --key <owner.jwk> --file <ledger.json> ' + turn.urls.map((u) => '--turn ' + u).join(' ') + ' --turn-mode ' + turn.mode);
  }
  log('Size report (v0.2.1 E2):');
  for (const line of sizes.lines) log('  ' + line);
  log('  outputs   ' + relPath(outDir) + '/: ' + outputs.join(', '));
  log('');
  for (const w of widgets) {
    log('Widget ' + w.name + ' (' + relPath(join(outDir, 'widget', '_mw', w.name + '.js')) + ' is served from your own origin as ' + w.path + ', never from a shared host):');
    log('  ' + w.script);
    log('  ' + w.element);
  }
  if (widgets.some((w) => w.name === 'signin')) log('Tell your visitors: "Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites."');
  if (widgets.length) log('');
  if (o.cs && ledgerOwner !== identity.pub) {
    // Post-wave fix Q: after a rotation (lo=) the snapshot at cs= must hold the owner hand-over; genesis.json holds
    // only the first block, so uploading it there would drop the hand-over (docs/OPERATIONS.md, "The owner key is stolen").
    log('Ledger snapshot: keep the snapshot with the owner hand-over at ' + o.cs + ' (tools/ledger-admin.mjs owner, then tools/snapshot.mjs). ' +
      'Do not upload ' + relPath(join(outDir, 'genesis.json')) + ' there: it holds only the first block, and the hand-over would be lost.');
  } else if (o.cs) log('Ledger snapshot: upload ' + relPath(join(outDir, 'genesis.json')) + ' (a JSON array of blocks; later ones come from tools/snapshot.mjs) to ' + o.cs + '.');
  else log('No --cs: the ledger root (gen=) reaches a visitor only from another visitor. Upload genesis.json (or a snapshot from tools/snapshot.mjs) and pass its URL as --cs.');
  log('');
  log('Pointer (' + (dropin ? 'stamped into every HTML page of ' + relPath(join(outDir, 'site')) + '/' : 'meta.html for the shell, dns.txt for DNS') + '):');
  log(pointer);
  log('');
  if (link) {
    // v0.3 C2 doors
    log('Light link (' + link.bytes + ' bytes signed for ' + link.scope + ', doors ' + link.doors.join(', ') + '; ' + relPath(join(outDir, 'link-card.txt')) + ' has the fallbacks and a QR code):');
    log(link.primary);
    log('A link cannot switch doors by itself: give people the fallback links too. A full door also serves ' + o.name + '/ under /ws/' + o.name + '/ and site.torrent as /_mw/t/' + btih + '.torrent.');
    log('');
  }
  if (dropin) {
    if (pagesWithoutScript.length) {
      note(pagesWithoutScript.length + ' HTML page(s) do not load the runtime (first: ' + pagesWithoutScript[0] + '); add ' + MW_SCRIPT + ' or publish with --inject-script');
    }
    if (pagesWithoutCfasync.length) {
      note(pagesWithoutCfasync.length + ' HTML page(s) load /_mw/mw.js without data-cfasync="false" before src (first: ' + pagesWithoutCfasync[0] + '); behind Cloudflare, Rocket Loader would rewrite the tag. Use ' + MW_SCRIPT);
    }
    if (pagesWithDuplicateTag.length) {
      note(pagesWithDuplicateTag.length + ' HTML page(s) load /_mw/mw.js more than once (first: ' + pagesWithDuplicateTag[0] + '); harmless (one engine per page), but one tag is enough');
    }
    log(egressNote(total));
    log('CSP: the drop-in script inserts no Content-Security-Policy of its own. If the site sends one, add (' + relPath(join(outDir, 'csp.txt')) + '):');
    for (const line of cspText({ dropin, tr, ws, xs, cs: o.cs, scope }).split('\n').filter((l) => /^ {2}\S/.test(l))) log(line);
    log('Deploy ' + relPath(join(outDir, 'site')) + '/ in this order: (1) every non-HTML file, including /_mw/, /.mw/ and /mw-sw.js,');
    log('(2) the HTML pages last. Keep the previous version\'s files for at least ' + o.keepDays + ' days. For example:');
    log('  aws s3 sync ' + relPath(join(outDir, 'site')) + '/ s3://<bucket>/ --exclude "*.html" --exclude "*.htm"');
    log('  aws s3 sync ' + relPath(join(outDir, 'site')) + '/ s3://<bucket>/ --exclude "*" --include "*.html" --include "*.htm"');
    log('Serve /mw-sw.js with Cache-Control: no-cache. CSP additions: ' + relPath(join(outDir, 'csp.txt')) + '.');
  } else {
    log('Deploy order: (1) upload ' + relPath(join(outDir, o.name)) + '/ and ' + o.name + '.torrent to the web seed base' + (ws[0] ? ' ' + ws[0] : '') + ',');
    log('(2) node tools/check-webseed.mjs ' + (ws[0] || '<ws base>') + ' ' + relPath(join(outDir, 'site.torrent')) + ', (3) switch the pointer (meta.html into');
    log('the shell <head>' + (o.shell ? ', done in ' + relPath(join(outDir, 'shell')) + '/' : '') + ', or dns.txt), (4) keep the previous version\'s files for at least ' + o.keepDays + ' days.');
  }

  return {
    mode: summary.mode, name: o.name, btih, rendezvousBtih, anchorBtih, ledgerId, gen: genesis.h, genesis, genesisReused,
    owner: identity.pub, fingerprint: identity.fingerprint, pointer, record, magnet, files: torrentFiles, total,
    torrentFile: built.torrentFile, outDir, outputs, warnings, verified, summary,
    link: link ? { record: link.record, text: link.text, scope: link.scope, ledgerId: link.ledgerId, bytes: link.bytes, primary: link.primary, fallbacks: link.fallbacks, web: link.web, doors: link.doors } : null, // C2 doors
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export const PUBLISH_FLAGS = {
  name: { type: 'string' },
  scope: { type: 'string' },
  key: { type: 'string' },
  ws: { type: 'list' },
  xs: { type: 'list' },
  tr: { type: 'list' },
  chain: { type: 'string' },
  max: { type: 'int' },
  cs: { type: 'string' },
  consent: { type: 'string' },
  exp: { type: 'int', default: DEFAULT_EXP_DAYS },
  seq: { type: 'int' },
  'prev-key': { type: 'string' },
  'ledger-owner': { type: 'string' },
  policy: { type: 'string' },
  moderator: { type: 'list' },
  allow: { type: 'list' },
  bits: { type: 'int' },
  'max-value-bytes': { type: 'int' },
  'max-chain-bytes': { type: 'int' },
  genesis: { type: 'string' },
  'new-genesis': { type: 'boolean' },
  dropin: { type: 'boolean' },
  'inject-script': { type: 'boolean' },
  'keep-days': { type: 'int', default: 7 },
  'verify-ws': { type: 'boolean' },
  'allow-no-preflight': { type: 'boolean' },
  'verify-host': { type: 'string' },
  'include-dot': { type: 'list' },
  'allow-secret': { type: 'list' },
  date: { type: 'string' },
  'max-files': { type: 'int' },
  'from-wxr': { type: 'string' },
  'wxr-dir': { type: 'string' },
  'double-pack': { type: 'boolean' },
  ct: { type: 'string' },
  lg: { type: 'string' },
  aud: { type: 'string' },
  org: { type: 'list' },
  'next-key': { type: 'string' },
  nx: { type: 'string' },
  ml: { type: 'string' },
  idp: { type: 'string' },
  'prev-pointer': { type: 'string' },
  'signin-widget': { type: 'boolean' },
  'signin-statement': { type: 'string' },
  'challenge-url': { type: 'string' },
  'proof-url': { type: 'string' },
  'chat-panel': { type: 'boolean' },
  tracker: { type: 'list' },
  stun: { type: 'list' },
  turn: { type: 'list' },
  'turn-mode': { type: 'string' },
  chat: { type: 'boolean' },
  files: { type: 'boolean' },
  media: { type: 'boolean' },
  calls: { type: 'boolean' },
  'cfg-from': { type: 'string' },
  // v0.3 C2 doors
  door: { type: 'list' },
  'door-kit': { type: 'string' },
  'door-site': { type: 'list' },
  'release-list': { type: 'string' },
  'release-sig': { type: 'string' },
  'release-key': { type: 'string' },
  'allow-unverified-loader': { type: 'boolean' },
  out: { type: 'string', default: 'dist-publish' },
  dist: { type: 'string', default: join(ROOT, 'dist') },
  shell: { type: 'boolean' },
  spa: { type: 'boolean' },
  'spa-path': { type: 'string' },
  'clean-urls': { type: 'boolean' },
  'trailing-slash': { type: 'string' },
  index: { type: 'string' },
  'not-found': { type: 'string' },
  ignore: { type: 'list' },
  quiet: { type: 'boolean' },
};

async function main(argv) {
  const { flags, positionals } = parseCli(argv, Object.assign({}, PUBLISH_FLAGS, WITHDRAW_FLAGS));
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (flags.doorKit) {
    // v0.3 C2 doors: the loader as released plus the host settings of a door; no site directory is read.
    if (positionals.length) throw new UsageError('--door-kit takes no site directory');
    await doorKit({ out: flags.doorKit, dist: flags.dist, releaseList: flags.releaseList, releaseSig: flags.releaseSig, releaseKey: flags.releaseKey, doorSite: flags.doorSite, quiet: flags.quiet });
    return 0;
  }
  if (flags.withdraw) {
    // v0.2.1 A3: a signed st=withdrawn record for --scope; no site directory is read.
    if (positionals.length) throw new UsageError('--withdraw takes no site directory');
    const res = await withdraw({
      scope: flags.scope, key: flags.key, why: flags.why, ct: flags.ct, chain: flags.chain, seq: flags.seq,
      exp: argv.some((a) => a === '--exp' || a.startsWith('--exp=')) ? flags.exp : undefined, // withdrawals default to 399 days
      prevKey: flags.prevKey, prevPointer: flags.prevPointer, ledgerOwner: flags.ledgerOwner, out: flags.out, quiet: flags.quiet,
    });
    // v0.3 (MF-28, review round PTR-7): withdraw() carries the nx= of the previous record and refuses a withdrawal returning devices would ignore.
    return res ? 0 : 1;
  }
  if (positionals.length !== 1) throw new UsageError('expected exactly one site directory');
  // The command line checks a --dist that is not this checkout's own build against the signed release list (SUP-5).
  const res = await publish(Object.assign({}, flags, { dir: positionals[0], requireVerifiedLoader: true }));
  return res ? 0 : 1;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
