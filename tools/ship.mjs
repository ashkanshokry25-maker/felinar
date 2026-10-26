#!/usr/bin/env node
// tools/ship.mjs: put a site on a rented server that has only an IP address (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 rung 2a, Rc3, Rc4).
//
//   node tools/ship.mjs <site dir> --ip <public IPv4> --to ssh://user@host[:port] --ct <https: or mailto: URL>
//                       [--name <site name>] [--key <owner.jwk>] [--suffix nip.io|sslip.io] [--remote-dir /opt/felinar]
//                       [--staging-only] [--dry-run] [--out <work dir>] [--dist <built loader>] [--exp <days>] [--policy owner|allow|open] [--bits <n>]
//                       [--new-ledger]
//
// The site is named by its server's address, a-b-c-d.nip.io (or sslip.io): the name costs nothing and needs no sign-up, but the server
// is rented under an account its provider can close (Z1). The steps, in order:
//   1. The name is looked up in Node with this computer's DNS resolver and must answer --ip. A name the service blocks (it answers a
//      block page instead, S2 F3) or any other address stops that name, and sslip.io is tried next (S2 string Z4). --suffix pins one service.
//   2. The owner key is made, or reused, on this computer. It is never copied: only the published site tree and the allow list are.
//   3. publish runs in this process with --chain <name> --ws https://<name>/ws/ --cs https://<name>/ws/genesis.json --tr wss://<name>/tracker
//      --shell --exp 399 (owner decision SZ-3). A name tied to an address cannot carry a DNS record, so the signed page tag is the only
//      pointer and it expires: the date is printed (string Z6).
//   4. site/ (the loader, plus the web seed under ws/) and allow/allow.txt (the site and its ledger swarm for the tracker) are assembled
//      under <work dir>/one-box/ and sent with rsync to <remote dir>/deploy/one-box/ on the server, which holds a clone of this repository.
//      The order is the deploy order of docs/DEPLOY.md: the web seed first (added to, never pruned: visitors on the previous version still
//      need its files for a week), then the allow list, then the loader with the new pointer. The server is inspected before anything is
//      made or published, so a missing clone, rsync or Compose stops the run with nothing created.
//   5. The server's .env gets LW_SITE and, first, the Let's Encrypt staging directory in LW_ACME_CA; docker compose starts the box (Caddy
//      with automatic HTTPS, and the tracker). Once the staging certificate is there, .env switches to production and the box restarts
//      once. Staging first means a closed port or a wrong address costs no production certificate (5 duplicate certificates a week, S2 F5).
//   6. check-site runs against https://<name>/ from this computer.
// A second run with the same arguments is an update: the server's .env says the production certificate is already in use, so only the files are
// sent (rsync), the snapshot at ws/genesis.json on the server is kept, and no restart happens. The work directory must be kept between runs: it
// holds the ledger's first block (publish reuses it so gen= stays the same). On an update without it the run stops, because a new first block is a
// new ledger for every visitor; --new-ledger says that is meant.
//
// It names every host before it contacts one, and --dry-run prints every command without running, reading or writing anything. Every external
// step goes through an injectable function (exec, ssh, rsync, resolve4, probeCertificate, checkSite, publish, keygen, now, sleep), so the tests run
// with canned answers and no network. The tools never start a tunnel (docs/DEV-NETWORK.md).

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import tls from 'node:tls';

import { MAX_PUBLISH_EXP_DAYS } from '../src/common/pointer.js';
import { publish, checkLoaderRelease } from './publish.mjs';
import { keygen } from './keygen.mjs';
import { checkSite } from './check-site.mjs';
import { chatLaneHash } from './tracker.mjs';
import { chooseName, describeNameCheck, ipName, isIPv4Text, NAME_SERVICES } from './name-check.mjs';
import {
  parseCli, runMain, isMain, loadOwnerKey, isInside, copyTree, walkFiles, writeFileAtomic, isoDate, ToolError, UsageError, out, warn, relPath, ROOT, TOOLS_VERSION,
} from './lib.mjs';

/**
 * How long a page tag lives when the name cannot carry a DNS record: 399 days, the longest publish signs. This is owner decision SZ-3 of
 * SEEDING-AND-ZERO-SETUP-DESIGN section 6 (rungs without DNS default to 399 days with a printed re-sign date, or keep 90 days as a retention
 * clock); it is awaiting the owner's sign-off, and --exp <days> picks another value without a code change.
 */
export const SHIP_DEFAULT_EXP_DAYS = 399;
export const DEFAULT_REMOTE_DIR = '/opt/felinar';
/** Where the one-box files are in a clone of this repository. */
export const ONE_BOX_DIR = 'deploy/one-box';
export const ACME_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
export const ACME_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
/** docker compose 2.17 added --wait-timeout (S2 rung 2a: "Docker with Compose 2.17 or newer"). */
export const COMPOSE_MIN = Object.freeze([2, 17]);
export const CERT_ATTEMPTS = 36;
export const CERT_DELAY_MS = 5000;

const USAGE = `
Usage: node tools/ship.mjs <site dir> --ip <public IPv4 address> --to ssh://user@host[:port] --ct <https: or mailto: URL> [options]

Publishes the site under a name made from the server's address (203.0.113.7 -> 203-0-113-7.nip.io), sends it to the server and starts
the one-box there (Caddy with automatic HTTPS, and the tracker), then checks it from this computer. The server needs Docker with Compose
2.17 or newer and rsync, ports 80 and 443 reachable from the internet, and a clone of this repository (see deploy/one-box/README.md). Use
an ssh key: every step is its own ssh or rsync call, and a password would be asked for each time.

Required:  <site dir>  --ip <address>  --to ssh://user@host[:port]  --ct <https: or mailto: URL> (who answers abuse and legal notices)
Options:   --name <site name> (default: the folder name; it is also the ledger label)
           --key <owner.jwk> (default: ~/.config/magnet-web/<name>.jwk; made when missing, mode 600, never copied)
           --suffix nip.io|sslip.io (use only this service; by default nip.io first, then sslip.io if nip.io does not answer the address)
           --remote-dir <path> (the clone on the server; default ${DEFAULT_REMOTE_DIR})
           --staging-only (stop on the Let's Encrypt staging certificate, which browsers do not trust; run again without it for production)
           --dry-run (print every command and every host; contact, read and write nothing)
           --out <dir> (work directory; default dist-ship/<name>; keep it between runs: it holds the ledger's first block)
           --dist <dir> (the built loader; default dist, made by npm run build). Any other loader, such as the unpacked
                         felinar-<version>-dist.zip of a release, is checked first against its signed list:
           --release-list hashes-dist.json --release-sig hashes-dist.json.sig --release-key <pinned key>
           --allow-unverified-loader (send a --dist that is not this checkout's build without that check)
           --expect-commit <sha> (the commit the server's clone must be at; default: the commit of this checkout. The server builds
                         the tracker and the pin node from its clone, so ship stops when the clone is at another commit)
           --exp <days> (how long the signed address record lives; default ${SHIP_DEFAULT_EXP_DAYS}, at most 399)
           --policy owner|allow|open  --bits <n>  (passed to publish: who may write to the site ledger)
           --new-ledger (the server already serves this site but the work directory has no first block of the ledger: mint a new one anyway,
                         which is a new ledger for every visitor; without this flag the run stops)
`;

// ---------------------------------------------------------------------------------------------
// the plain-words strings (S2, "Strings")
// ---------------------------------------------------------------------------------------------

/** Z1: where the site will be. */
export const Z1 = (name) => 'Your site will be at https://' + name + '/. The name is your server\'s IP address with dashes: the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close.';
/** Z2: the name is the address. */
export const Z2 = 'If this server gets another IP address, the address changes and visitors start again. A domain you own does not have this problem.';
/** Z3: the naming service. `service` is nip.io or sslip.io, which are one service under two names (S2 F1). */
export const Z3 = (service = 'nip.io') => service + ' is a free DNS service run by two volunteers with no uptime promise. If it stops, new visitors cannot open this address; people who already opened the site keep their saved copy.';
/** Z5: the certificate authority could not reach the server. */
export const Z5 = 'The certificate authority could not reach this server on port 80 or 443. At home a router may need a port forward, some providers block port 80, and a provider that shares one address between customers cannot be reached. Use a rented server, a free static host or a tunnel.';
/** Z6: the signed address record expires. */
export const Z6 = (date) => 'Your signed address record expires on ' + date + '. After that new visitors cannot load the site until you publish again. Add this date to your calendar.';

// ---------------------------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------------------------

const SITE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
// Every word that reaches the server on a command line stays inside this set, so the login shell that ssh hands the words to has nothing to interpret.
const SAFE_WORD = /^[A-Za-z0-9._\/:@+=,%-]+$/;

/** sanitizeName(folderName) → a site name made from a folder name: letters, digits and . _ ~ - only, at most 64 characters; '' when nothing is left. */
export function sanitizeName(base) {
  return String(base || '').replace(/[^A-Za-z0-9._~-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '').slice(0, 64).replace(/-+$/, '');
}

/**
 * parseSshTarget('ssh://user@host[:port]') → { user, host, port, target: 'user@host', text }. UsageError for anything else. A host or user that
 * starts with '-' would read as an ssh option, so it is refused; a password in the URL is refused too (ssh asks for it itself).
 */
export function parseSshTarget(text) {
  const bad = (why) => new UsageError('--to must look like ssh://user@host or ssh://user@host:2222 (' + why + '), got ' + JSON.stringify(text));
  let u;
  try {
    u = new URL(String(text));
  } catch (_) {
    throw bad('not a URL');
  }
  if (u.protocol !== 'ssh:') throw bad('the scheme must be ssh:');
  if (u.password) throw bad('no password in the URL: ssh asks for it itself');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw bad('no path, query or fragment');
  let user;
  try {
    user = decodeURIComponent(u.username);
  } catch (_) {
    throw bad('the user name is not valid');
  }
  if (!user) throw bad('the user name is missing');
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user)) throw bad('the user name may hold letters, digits, . _ and - and does not start with -');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || !/^[A-Za-z0-9:.-]+$/.test(host) || host.startsWith('-')) throw bad('the host is missing or not valid');
  let port = null;
  if (u.port) {
    port = Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('the port must be 1 to 65535');
  }
  return { user, host, port, target: user + '@' + (host.indexOf(':') >= 0 ? '[' + host + ']' : host), text: String(text) };
}

/**
 * unusableAddress(ip) → null, or the reason a certificate authority on the internet cannot reach this address: private, loopback, link-local,
 * shared (carrier-grade NAT), multicast and other reserved ranges. The three documentation ranges (RFC 5737) are accepted, because every
 * example, dry run and test uses 203.0.113.7.
 */
export function unusableAddress(ip) {
  if (!isIPv4Text(ip)) return 'not an IPv4 address';
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0) return 'the address 0.0.0.0/8 means "this network"';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'a private address, which only this network can reach';
  if (a === 100 && b >= 64 && b <= 127) return 'a shared address of a provider that puts many customers behind one (carrier-grade NAT)';
  if (a === 127) return 'a loopback address, which is this computer';
  if (a === 169 && b === 254) return 'a link-local address';
  if (a === 192 && b === 0 && c === 0) return 'a reserved address';
  if (a === 192 && b === 88 && c === 99) return 'a reserved address';
  if (a === 198 && (b === 18 || b === 19)) return 'a benchmarking address';
  if (a >= 224) return 'a multicast or reserved address';
  return null;
}

/** parseEnv(text) → Map of KEY → value for the KEY=VALUE lines of a compose .env file (comments and blank lines skipped, quotes stripped). */
export function parseEnv(text) {
  const env = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    env.set(m[1], value);
  }
  return env;
}

/**
 * envState(text, name) → { state, site, ca }:
 *   'fresh'    no .env, or no LW_SITE in it
 *   'replace'  LW_SITE is another name: this server held another site, and one box serves one site
 *   'staging'  the same name, still on the staging directory (an earlier run stopped there)
 *   'live'     the same name on the production directory (or none set, which means production): an update
 */
export function envState(text, name) {
  const env = parseEnv(text);
  const site = env.get('LW_SITE') || null;
  const ca = env.get('LW_ACME_CA') || null;
  if (!site) return { state: 'fresh', site: null, ca };
  if (site !== name) return { state: 'replace', site, ca };
  return { state: ca === ACME_STAGING ? 'staging' : 'live', site, ca };
}

/** mergeEnv(text, { LW_SITE, LW_ACME_CA }) → the .env text with those two lines set and every other line kept as it was. */
export function mergeEnv(text, values) {
  const keep = String(text || '').split(/\r?\n/).filter((line) => !/^\s*(?:export\s+)?(LW_SITE|LW_ACME_CA)\s*=/.test(line));
  while (keep.length && keep[keep.length - 1].trim() === '') keep.pop();
  return keep.concat(Object.keys(values).map((k) => k + '=' + values[k])).join('\n') + '\n';
}

/** composeVersionAtLeast(text, [major, minor]) → true when `docker compose version --short` printed at least that version ("2.29.1", "v2.40.3"). */
export function composeVersionAtLeast(text, min = COMPOSE_MIN) {
  const m = /v?(\d+)\.(\d+)/.exec(String(text || ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/** commandText(argv) → a shell-pasteable line: words that need it are single-quoted. */
export function commandText(argv) {
  return argv.map((w) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(w) ? w : "'" + String(w).replace(/'/g, "'\\''") + "'")).join(' ');
}

// ---------------------------------------------------------------------------------------------
// the plan: everything that follows from the flags
// ---------------------------------------------------------------------------------------------

/**
 * planShip(options, { home, cwd }) → the plan of a run, or a UsageError / ToolError for flags that cannot work. Pure apart from looking at the
 * site folder: nothing is created, contacted or read beyond that.
 */
export function planShip(options = {}, env = {}) {
  const o = Object.assign({ remoteDir: DEFAULT_REMOTE_DIR, exp: SHIP_DEFAULT_EXP_DAYS, stagingOnly: false, dryRun: false, dist: join(ROOT, 'dist') }, options);
  const home = env.home || homedir();
  const cwd = env.cwd || process.cwd();
  if (!o.dir) throw new UsageError('missing <site dir>');
  const dir = resolve(cwd, o.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError('no such directory: ' + o.dir);
  if (!o.ip) throw new UsageError('missing --ip <the server\'s public IPv4 address>, for example --ip 203.0.113.7');
  if (!isIPv4Text(o.ip)) throw new UsageError('--ip must be an IPv4 address such as 203.0.113.7, got ' + JSON.stringify(o.ip));
  const unusable = unusableAddress(o.ip);
  if (unusable) {
    throw new UsageError('--ip ' + o.ip + ' is ' + unusable + ', so a certificate authority on the internet cannot reach it. ' +
      'Use the server\'s public address. To show the site to phones on this network instead, use "share on my LAN" (docs/QUICKSTART.md, "Start without a domain").');
  }
  if (!o.to) throw new UsageError('missing --to ssh://user@host, the server to put the site on (for example --to ssh://root@' + o.ip + ')');
  const target = parseSshTarget(o.to);
  if (isIPv4Text(target.host) && target.host !== o.ip) {
    throw new UsageError('--to names ' + target.host + ' but --ip is ' + o.ip + ': the name is made from --ip, so both must be the same server');
  }
  if (!o.ct) throw new UsageError('missing --ct <https: or mailto: URL>: who answers abuse and legal notices for this site (it is signed into the pointer; docs/DEPLOY.md, "Owner duties")');
  let ct;
  try {
    ct = new URL(o.ct);
  } catch (_) {
    ct = null;
  }
  if (!ct || (ct.protocol !== 'https:' && ct.protocol !== 'mailto:')) throw new UsageError('--ct must be an https: or mailto: URL, got ' + JSON.stringify(o.ct));
  const siteName = o.name || sanitizeName(basename(dir));
  if (!siteName) throw new UsageError('the folder name gives no usable site name: pass --name <letters, digits, . _ ~ ->');
  if (!SITE_NAME_RE.test(siteName)) throw new UsageError('--name must be 1 to 64 characters of A-Z a-z 0-9 . _ ~ - (it is the torrent name, a URL path segment and the ledger label), got ' + JSON.stringify(siteName));
  const suffixes = o.suffix ? [o.suffix] : NAME_SERVICES.slice();
  const firstName = ipName(o.ip, suffixes[0]); // also validates --suffix
  if (!Number.isInteger(o.exp) || o.exp < 1 || o.exp > MAX_PUBLISH_EXP_DAYS) throw new UsageError('--exp must be 1 to ' + MAX_PUBLISH_EXP_DAYS + ' days');
  const remoteDir = String(o.remoteDir).replace(/\/+$/, '');
  if (!remoteDir.startsWith('/') || !SAFE_WORD.test(remoteDir) || remoteDir.split('/').includes('..')) {
    throw new UsageError('--remote-dir must be an absolute path of letters, digits and . _ - + @ : / , = % (no spaces, no ..), got ' + JSON.stringify(o.remoteDir));
  }
  const workDir = resolve(cwd, o.out || join('dist-ship', siteName));
  const key = resolve(cwd, o.key || join(home, '.config', 'magnet-web', siteName + '.jwk'));
  if (isInside(dir, workDir)) throw new UsageError('--out must not be inside the site folder (it would be published)');
  if (isInside(dir, key)) throw new UsageError('the owner key must stay outside the site folder: ' + key + ' is inside ' + dir + ' and would be published');
  if (isInside(workDir, key)) throw new UsageError('the owner key must stay outside the work directory: ' + key + ' is inside ' + workDir + ', whose files are published and sent');
  if (o.policy !== undefined && o.policy !== null && !['owner', 'allow', 'open'].includes(o.policy)) throw new UsageError('--policy must be owner, allow or open');
  if (o.expectCommit && !/^[0-9a-f]{40}$/.test(String(o.expectCommit))) throw new UsageError('--expect-commit must be a full commit hash (40 lowercase hex characters), such as git rev-parse \'v0.3.0^{commit}\' prints');
  return {
    dir, ip: o.ip, to: o.to, target, ct: String(o.ct), siteName, suffixes, firstName, exp: o.exp, remoteDir, boxDir: remoteDir + '/' + ONE_BOX_DIR,
    out: workDir, publishOut: join(workDir, 'publish'), deployRoot: join(workDir, 'one-box'), siteTree: join(workDir, 'one-box', 'site'), allowDir: join(workDir, 'one-box', 'allow'),
    key, keyIsDefault: !o.key, dist: resolve(cwd, o.dist), stagingOnly: Boolean(o.stagingOnly), dryRun: Boolean(o.dryRun),
    policy: o.policy || null, bits: o.bits === undefined ? null : o.bits, newLedger: Boolean(o.newLedger),
    releaseList: o.releaseList ? resolve(cwd, o.releaseList) : null, releaseSig: o.releaseSig ? resolve(cwd, o.releaseSig) : null, releaseKey: o.releaseKey || null, releasePinnedKeys: o.releasePinnedKeys || null,
    allowUnverifiedLoader: Boolean(o.allowUnverifiedLoader), expectCommit: o.expectCommit || null,
  };
}

/** The addresses that follow from the name the site gets. */
export function urlsFor(name) {
  return { site: 'https://' + name + '/', ws: 'https://' + name + '/ws/', cs: 'https://' + name + '/ws/genesis.json', tracker: 'wss://' + name + '/tracker' };
}

/** publishArgs(plan, name) → { options for publish(), argv for the equivalent command line }. */
export function publishArgs(plan, name) {
  const u = urlsFor(name);
  const options = {
    dir: plan.dir, name: plan.siteName, scope: name, key: plan.key, chain: plan.siteName, ws: [u.ws], cs: u.cs, tr: [u.tracker], ct: plan.ct,
    exp: plan.exp, shell: true, out: plan.publishOut, dist: plan.dist,
  };
  const argv = [plan.dir, '--name', plan.siteName, '--chain', plan.siteName, '--scope', name, '--key', plan.key, '--ws', u.ws, '--cs', u.cs, '--tr', u.tracker,
    '--ct', plan.ct, '--exp', String(plan.exp), '--shell', '--out', plan.publishOut];
  if (plan.dist !== join(ROOT, 'dist')) argv.push('--dist', plan.dist);
  if (plan.policy) {
    options.policy = plan.policy;
    argv.push('--policy', plan.policy);
  }
  if (plan.bits !== null) {
    options.bits = plan.bits;
    argv.push('--bits', String(plan.bits));
  }
  // The loader check (SUP-5): ship has already checked it; publish checks it again before it reads the key.
  if (plan.releaseList) {
    Object.assign(options, { releaseList: plan.releaseList, releaseSig: plan.releaseSig, releaseKey: plan.releaseKey, releasePinnedKeys: plan.releasePinnedKeys });
    argv.push('--release-list', plan.releaseList, '--release-sig', plan.releaseSig);
    if (plan.releaseKey) argv.push('--release-key', plan.releaseKey);
  }
  if (plan.allowUnverifiedLoader) {
    options.allowUnverifiedLoader = true;
    argv.push('--allow-unverified-loader');
  }
  return { options, argv };
}

const sshOptionWords = (t) => ['-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30'].concat(t.port ? ['-p', String(t.port)] : []);
/** sshArgv(target, remoteWords) → the argv of `ssh` for one remote command; the words stay inside SAFE_WORD. */
export function sshArgv(t, words) {
  for (const w of words) if (!SAFE_WORD.test(w)) throw new Error('internal: a remote word needs quoting: ' + JSON.stringify(w));
  return ['ssh', ...sshOptionWords(t), t.target, ...words];
}
const rsyncRemoteShell = (t) => 'ssh ' + sshOptionWords(t).join(' ');

/** The commands, as argv arrays, that a run sends to ssh and rsync. Dry-run prints these, and a real run executes these same arrays. */
export function commandsFor(plan) {
  const t = plan.target;
  const box = plan.boxDir;
  // -p, not --chmod: the tree is made 755 and 644 here (assembleOneBox), and the rsync that macOS ships (openrsync) refuses --chmod=D755,F644.
  return {
    composeFile: sshArgv(t, ['test', '-f', box + '/docker-compose.yml']),
    // SUP-9: the server builds the tracker (and the pin) from its own clone, so the clone must be the commit this run expects.
    remoteHead: sshArgv(t, ['git', '-C', plan.remoteDir, 'rev-parse', 'HEAD']),
    rsyncThere: sshArgv(t, ['command', '-v', 'rsync']),
    composeVersion: sshArgv(t, ['docker', 'compose', 'version', '--short']),
    envExists: sshArgv(t, ['test', '-f', box + '/.env']),
    envRead: sshArgv(t, ['cat', box + '/.env']),
    // rsync makes only the last directory of a path, so the directories it fills are made first.
    mkdirBox: sshArgv(t, ['mkdir', '-p', box + '/site/ws', box + '/allow']),
    // 1. The web seed: added to and overwritten, never pruned (visitors on the previous version still fetch its files for a week). An update keeps
    //    the ledger snapshot the server holds (a pin node may have refreshed it); the pin's heartbeat is not in the tree, so it stays.
    rsyncWeb: (update) => ['rsync', '-rltp'].concat(update ? ['--exclude=/genesis.json'] : [], ['-e', rsyncRemoteShell(t), plan.siteTree + '/ws/', t.target + ':' + box + '/site/ws/']),
    // 2. The allow list, before any visitor holds the new pointer. 3. The loader with the pointer, last; ws/ is neither sent nor pruned here.
    rsyncAllow: ['rsync', '-rltp', '--delete', '-e', rsyncRemoteShell(t), plan.allowDir + '/', t.target + ':' + box + '/allow/'],
    rsyncShell: ['rsync', '-rltp', '--delete', '--exclude=/ws/', '-e', rsyncRemoteShell(t), plan.siteTree + '/', t.target + ':' + box + '/site/'],
    rsyncEnv: (file) => ['rsync', '-tp', '-e', rsyncRemoteShell(t), file, t.target + ':' + box + '/.env'],
    // -f names the compose file, so it is found whatever directory the ssh session starts in; its folder is the project directory (the .env, ./site, ./allow).
    composeUp: (build) => sshArgv(t, ['docker', 'compose', '-f', box + '/docker-compose.yml', 'up', '-d'].concat(build ? ['--build'] : [], ['--wait', '--wait-timeout', build ? '300' : '120'])),
  };
}

// ---------------------------------------------------------------------------------------------
// default external steps (replaced in tests)
// ---------------------------------------------------------------------------------------------

/** defaultExec(file, args, { capture }) → Promise<{ code, stdout }>. ssh and rsync use this computer's terminal for passwords and host-key questions. */
export function defaultExec(file, args, { capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '';
    if (capture) child.stdout.on('data', (d) => { stdout += d; });
    child.once('error', (err) => {
      reject(err && err.code === 'ENOENT'
        ? new ToolError(file + ' was not found on this computer. ship needs ssh and rsync (macOS and most Linux systems have both; on Windows use WSL).')
        : err);
    });
    child.once('exit', (code, signal) => resolvePromise({ code: code === null ? (signal ? 1 : 0) : code, signal, stdout }));
  });
}

/**
 * defaultProbeCertificate({ host, port = 443, servername, timeoutMs = 8000 }) → Promise<{ ok, issuer, authorized, error }>
 * Opens one TLS connection to the server's address with the site's name as SNI and reads the certificate. `authorized` is true only when the
 * chain is trusted by this computer and the name matches, which is what a visitor's browser needs.
 */
export function defaultProbeCertificate({ host, port = 443, servername, timeoutMs = 8000 }) {
  return new Promise((resolvePromise) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert && cert.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(' ') : '';
      resolvePromise({ ok: true, issuer, authorized: Boolean(socket.authorized), error: socket.authorizationError ? String(socket.authorizationError) : null });
      socket.end();
    });
    socket.once('error', (err) => resolvePromise({ ok: false, error: (err && err.message) || String(err) }));
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise({ ok: false, error: 'no answer in ' + timeoutMs + ' ms' });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// the deploy tree
// ---------------------------------------------------------------------------------------------

/**
 * assembleOneBox({ publishOut, siteTree, allowDir, siteName, summary }) → { files, allow }
 * site/ holds the loader (publish's shell/ without its _headers, which only a Netlify or Cloudflare host reads; the Caddyfile sets the headers),
 * and under ws/ the web seed: <name>/, <name>.torrent and genesis.json. allow/allow.txt lists the site and its ledger swarm for the tracker.
 */
export function assembleOneBox({ publishOut, siteTree, allowDir, siteName, summary }) {
  rmSync(siteTree, { recursive: true, force: true });
  rmSync(allowDir, { recursive: true, force: true });
  mkdirSync(join(siteTree, 'ws'), { recursive: true });
  mkdirSync(allowDir, { recursive: true });
  copyTree(join(publishOut, 'shell'), siteTree, { skip: (rel, isDir) => (!isDir && rel === '_headers' ? '_headers' : null) });
  copyTree(join(publishOut, siteName), join(siteTree, 'ws', siteName));
  for (const f of [siteName + '.torrent', 'genesis.json']) copyFileSync(join(publishOut, f), join(siteTree, 'ws', f));
  let allow = '# the site and its ledger swarm: the only infohashes the tracker serves\n' + summary.btih + '  # ' + siteName + '\n' + summary.rendezvousBtih + '  # its ledger\n';
  // v0.3 (review round SCALE-2): the chat lane, and uploads mode when file or media swarms (a new infohash per upload) must be served.
  const features = Array.isArray(summary.features) ? summary.features : [];
  if (summary.ledgerId && features.length) allow += chatLaneHash(summary.ledgerId) + '  # its chat lane\n';
  if (features.includes('files') || features.includes('media')) allow += 'uploads  # file and media swarms, capped per connection (docs/DEPLOY.md, "Tracker")\n';
  writeFileAtomic(join(allowDir, 'allow.txt'), allow);
  // rsync -p carries these modes to the server: readable by the Caddy and tracker containers whatever the umask of the person running ship.
  chmodTree(siteTree);
  chmodTree(allowDir);
  return { files: walkFiles(siteTree).length, allow };
}

/** chmodTree(root): directories 755, files 644, the root included. */
export function chmodTree(root) {
  chmodSync(root, 0o755);
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, ent.name);
    if (ent.isDirectory()) chmodTree(abs);
    else if (ent.isFile()) chmodSync(abs, 0o644);
  }
}

/** findKeyLeaks(roots, privateJwk) → [path]: files under the roots (each at most 64 MiB) that contain the private scalar of the key. */
export function findKeyLeaks(roots, jwk) {
  const secret = jwk && typeof jwk.d === 'string' && jwk.d.length > 20 ? jwk.d : null;
  const leaks = [];
  if (!secret) return leaks;
  for (const root of roots) {
    for (const f of walkFiles(root)) {
      if (f.size > 64 * 1024 * 1024) continue;
      if (readFileSync(f.abs).includes(secret)) leaks.push(join(root, f.path));
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------------

const without = (warnings) => warnings.filter((w) => !/has not been checked: after uploading/.test(w));

function willContact(plan, name, { dry }) {
  const verb = dry ? 'Would contact' : 'Will contact';
  const lines = [verb + ' (nothing else):'];
  const names = plan.suffixes.map((s) => ipName(plan.ip, s));
  lines.push('  ' + names.join(' or ') + '  DNS lookup with this computer\'s resolver, to see that the name answers ' + plan.ip + (names.length > 1 ? ' (the second only if the first does not)' : ''));
  lines.push('  ' + plan.target.target + (plan.target.port ? ' port ' + plan.target.port : '') + '  ssh and rsync, to send the site and start it');
  lines.push('  ' + plan.ip + ':443  one TLS connection per check, to see which certificate the server presents');
  lines.push('  ' + name + '  check-site, at the end: the page, its files and wss://' + name + '/tracker');
  lines.push('Your server, not this computer, contacts Let\'s Encrypt (staging first, then production) and the registries it builds the tracker image from.');
  return lines;
}

// The names of the injectable steps. They may be given as the second argument of ship() or among its options (INTERFACES: "ship({ ip, to, ct,
// ..., exec, ssh, rsync, resolve, now })"); the second argument wins. `resolve` is the name INTERFACES uses for resolve4.
const DEP_KEYS = ['exec', 'ssh', 'rsync', 'resolve', 'resolve4', 'resolve6', 'probeCertificate', 'checkSite', 'publish', 'keygen', 'now', 'sleep', 'log', 'warn',
  'certAttempts', 'certDelayMs', 'home', 'cwd', 'localCommit'];

/** localCommit() → the commit of this checkout (git rev-parse HEAD), or null when the tools do not run from a git checkout. */
export function localCommit() {
  try {
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch (_) {
    return null;
  }
}

/**
 * ship(options, deps) → Promise<result>. options mirror the flags in camelCase (dir, ip, to, ct, name, key, suffix, remoteDir, stagingOnly, dryRun, out,
 * dist, exp, policy, bits). deps replace the external steps: { exec(file, args, { capture }) → { code, stdout }, ssh(argv, opts), rsync(argv, opts),
 * resolve4(name) or resolve(name), resolve6, probeCertificate({ host, port, servername, verify }), checkSite(url, options), publish(options), keygen({ out }),
 * now (a function, or the milliseconds), sleep(ms), log(line), warn(line), certAttempts, certDelayMs, home, cwd }.
 * result: { dryRun, name, suffix, url, ip, siteName, state, certificate, checked, btih, ledgerId, expires, keyFile, keyCreated, publishOut, deployRoot, warnings }
 */
export async function ship(options = {}, deps = {}) {
  const given = {};
  for (const k of DEP_KEYS) if (options[k] !== undefined) given[k] = options[k];
  const d = Object.assign({
    exec: defaultExec, resolve4: null, resolve6: null, probeCertificate: defaultProbeCertificate, checkSite, publish, keygen, localCommit,
    now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: out, warn, certAttempts: CERT_ATTEMPTS, certDelayMs: CERT_DELAY_MS,
  }, given, deps);
  if (d.resolve && !d.resolve4) d.resolve4 = d.resolve;
  if (typeof d.now !== 'function') {
    const fixed = d.now;
    d.now = () => fixed;
  }
  const plan = planShip(options, { home: d.home, cwd: d.cwd });
  const log = d.log;
  const cmds = commandsFor(plan);
  const run = (argv, opts) => {
    if (argv[0] === 'ssh' && d.ssh) return d.ssh(argv, opts);
    if (argv[0] === 'rsync' && d.rsync) return d.rsync(argv, opts);
    return d.exec(argv[0], argv.slice(1), opts);
  };
  const result = {
    dryRun: plan.dryRun, name: plan.firstName, suffix: plan.suffixes[0], url: urlsFor(plan.firstName).site, ip: plan.ip, siteName: plan.siteName, state: null,
    certificate: null, checked: false, btih: null, ledgerId: null, expires: null, keyFile: plan.key, keyCreated: false, publishOut: plan.publishOut,
    deployRoot: plan.deployRoot, warnings: [],
  };

  // ---- dry run: print the plan and stop ---------------------------------------------------
  if (plan.dryRun) {
    const name = plan.firstName;
    log('felinar ship (dry run): ' + relPath(plan.dir) + ' -> ' + urlsFor(name).site);
    log('Nothing is contacted, read or written. The hosts and commands below are what a real run would use.');
    log('');
    for (const line of willContact(plan, name, { dry: true })) log(line);
    log('');
    log(Z1(name));
    log(Z2);
    log(Z3(plan.suffixes[0]));
    log('');
    const expires = isoDate(d.now() + plan.exp * 86400000);
    log('Owner key: ' + plan.key + (existsSync(plan.key) ? ' (exists; it is reused)' : ' (does not exist; it would be made, mode 600)') + '. It stays on this computer: only ' + relPath(plan.siteTree) + ' and ' + relPath(plan.allowDir) + ' are sent.');
    log('');
    log('Commands, in order (run from the repository root; steps that depend on the server\'s answers are marked):');
    let n = 0;
    const step = (text, argv) => {
      log('  ' + ++n + '. ' + text);
      if (argv) log('     ' + commandText(argv));
    };
    step('look up ' + plan.suffixes.map((s) => ipName(plan.ip, s)).join(' and, if it does not answer ' + plan.ip + ', ') + ' (A record) and compare');
    step('look at the server before anything is made: the clone, rsync and Docker Compose ' + COMPOSE_MIN.join('.') + ' or newer, and whether this is a first run or an update', cmds.composeFile);
    log('     ' + commandText(cmds.remoteHead) + '   (must print ' + (plan.expectCommit || 'the commit of this checkout') + ': the server builds the tracker from its clone)');
    log('     ' + commandText(cmds.rsyncThere));
    log('     ' + commandText(cmds.composeVersion));
    log('     ' + commandText(cmds.envExists));
    log('     ' + commandText(cmds.envRead) + '   (only if the file exists)');
    if (!existsSync(plan.key)) step('make the owner key', ['node', 'tools/keygen.mjs', '--out', plan.key]);
    step('publish', ['node', 'tools/publish.mjs'].concat(publishArgs(plan, name).argv));
    step('assemble ' + relPath(plan.siteTree) + ' (the loader, and the web seed under ws/) and ' + relPath(plan.allowDir) + '/allow.txt (the site and its ledger swarm)');
    step('make the directories on the server', cmds.mkdirBox);
    step('send the web seed (added to, never pruned; an update keeps ws/genesis.json on the server), then the allow list, then the loader with the pointer', cmds.rsyncWeb(false));
    log('     ' + commandText(cmds.rsyncAllow));
    log('     ' + commandText(cmds.rsyncShell));
    step('first run: write .env with LW_SITE=' + name + ' and LW_ACME_CA=' + ACME_STAGING + ' (the Let\'s Encrypt staging directory), then send it', cmds.rsyncEnv(join(plan.deployRoot, '.env')));
    step('first run: start the box', cmds.composeUp(true));
    step('first run: wait for the staging certificate (a TLS connection to ' + plan.ip + ':443 every ' + (d.certDelayMs / 1000) + ' s, up to ' + d.certAttempts + ' times)');
    if (plan.stagingOnly) {
      step('stop here (--staging-only): the staging certificate is not trusted by browsers');
    } else {
      step('switch .env to LW_ACME_CA=' + ACME_PRODUCTION + ', send it and restart the box once', cmds.composeUp(false));
      step('wait for the production certificate the same way, then run check-site on ' + urlsFor(name).site + ' (node tools/check-site.mjs ' + urlsFor(name).site + ')');
    }
    log('');
    log(Z6(expires));
    log('(the date above is for a run started now; the real run prints the date it signed)');
    if (!existsSync(join(plan.dist, 'index.html'))) d.warn('the loader is not built yet (' + relPath(plan.dist) + '/index.html is missing): run npm run build before the real run');
    return result;
  }

  // ---- a real run ------------------------------------------------------------------------
  if (!existsSync(join(plan.dist, 'index.html'))) {
    throw new ToolError('ship needs the built loader in ' + relPath(plan.dist) + ' (run: npm run build, from a checkout of this repository, or pass --dist <dir> with the unpacked felinar-<version>-dist.zip of a release ' +
      'and its signed list: --release-list hashes-dist.json --release-sig hashes-dist.json.sig --release-key <pinned key>)');
  }
  // SUP-5: a loader that is not this checkout's own build is checked against the signed release list before anything is contacted.
  const loader = await checkLoaderRelease({
    dist: plan.dist, releaseList: plan.releaseList, releaseSig: plan.releaseSig, releaseKey: plan.releaseKey, releasePinnedKeys: plan.releasePinnedKeys, requireVerified: true, allowUnverified: plan.allowUnverifiedLoader,
  });
  if (loader.verified) log('The loader in ' + relPath(plan.dist) + ' matches the signed release list (felinar ' + loader.version + ').');
  else if (loader.warning) d.warn(loader.warning);
  // SUP-9: the commit the server's clone must be at.
  const wantCommit = plan.expectCommit || d.localCommit();
  if (!wantCommit) {
    throw new UsageError('ship cannot tell which commit the server\'s clone must be at (these tools are not a git checkout): pass --expect-commit <the commit of the release tag, from its release notes>. Nothing was contacted.');
  }
  log('felinar ship: ' + relPath(plan.dir) + ' -> a server at ' + plan.ip);
  for (const line of willContact(plan, plan.firstName, { dry: false })) log(line);
  log('');

  // 1. the name
  const picked = await chooseName({ ip: plan.ip, suffixes: plan.suffixes, resolve4: d.resolve4, resolve6: d.resolve6 });
  picked.checks.forEach((check, i) => {
    if (check.ok) return;
    const next = plan.suffixes[i + 1];
    log(describeNameCheck(check, { alt: next ? ipName(plan.ip, next) : null }));
  });
  if (!picked.ok) {
    throw new ToolError('no name for ' + plan.ip + ' works: ' + picked.checks.map((c) => c.name + ' (' + c.reason + ')').join(', ') + '. Nothing was published or sent.');
  }
  const name = picked.name;
  const suffix = picked.suffix;
  Object.assign(result, { name, suffix, url: urlsFor(name).site });
  if (name !== plan.firstName) log('Using ' + name + ' instead.');
  log(Z1(name));
  log(Z2);
  log(Z3(suffix));
  log('');

  // 2. the server, looked at before anything is made or published: a missing clone, rsync or Compose stops the run with nothing created
  // ssh itself ends with 255 when it cannot connect or log in; it printed the reason above.
  const fail = (res, what, hint) => (res.code === 255
    ? new ToolError('ssh could not reach ' + plan.target.target + (plan.target.port ? ' on port ' + plan.target.port : '') + ' (exit 255; the reason is printed above). Check the address, the user name and your key, then run the same command again.')
    : new ToolError(what + ' failed on ' + plan.target.target + ' (exit ' + res.code + ')' + (hint ? '. ' + hint : '')));
  const setup = 'On the server: git clone --branch v' + TOOLS_VERSION + ' --depth 1 ' + repositoryUrl() + ' ' + plan.remoteDir + ' (a release tag; compare git -C ' + plan.remoteDir +
    ' rev-parse HEAD with the release notes) and install Docker with Compose ' + COMPOSE_MIN.join('.') + ' or newer.';
  const hasBox = await run(cmds.composeFile, { capture: true });
  if (hasBox.code !== 0) throw fail(hasBox, 'finding ' + plan.boxDir + '/docker-compose.yml', setup);
  const head = await run(cmds.remoteHead, { capture: true });
  if (head.code !== 0) throw fail(head, 'reading the commit of ' + plan.remoteDir + ' (git rev-parse HEAD)', 'The server needs a git clone of the release: ' + setup);
  const serverCommit = String(head.stdout || '').trim();
  if (serverCommit !== wantCommit) {
    throw new ToolError('the clone on the server (' + plan.remoteDir + ') is at commit ' + (serverCommit || '(none)') + ', not ' + wantCommit + (plan.expectCommit ? ' (--expect-commit)' : ' (this checkout)') +
      '. The server builds the tracker and the pin node from that clone, so it must be the release you reviewed: on the server run git -C ' + plan.remoteDir +
      ' fetch --tags and git -C ' + plan.remoteDir + ' checkout <release tag>, and compare the commit with the release notes. Nothing was published or sent.');
  }
  log('The clone on the server is at ' + serverCommit.slice(0, 12) + ', as expected.');
  // rsync runs on both ends: a minimal server image may not have it.
  const hasRsync = await run(cmds.rsyncThere, { capture: true });
  if (hasRsync.code !== 0) throw fail(hasRsync, 'finding rsync', 'rsync must be installed on the server too (for example: apt install rsync).');
  const version = await run(cmds.composeVersion, { capture: true });
  if (version.code !== 0) throw fail(version, 'running "docker compose version"', 'Install Docker with the Compose plugin on the server.');
  if (!composeVersionAtLeast(version.stdout)) {
    throw new ToolError('the server has Docker Compose ' + String(version.stdout).trim() + ', and ship needs ' + COMPOSE_MIN.join('.') + ' or newer (for --wait-timeout). Update Docker on the server.');
  }
  let existingEnv = '';
  const hasEnv = await run(cmds.envExists, { capture: true });
  if (hasEnv.code === 0) {
    const read = await run(cmds.envRead, { capture: true });
    if (read.code !== 0) throw fail(read, 'reading ' + plan.boxDir + '/.env');
    existingEnv = read.stdout;
  } else if (hasEnv.code !== 1) {
    throw fail(hasEnv, 'looking for ' + plan.boxDir + '/.env');
  }
  const found = envState(existingEnv, name);
  result.state = found.state;
  const update = found.state === 'live';
  if (found.state === 'replace') {
    log('This server was set up for ' + found.site + '. One box serves one site, so ' + name + ' replaces it: the loader files are replaced, and visitors of the old address start again. Its web seed files stay until you delete them.');
  } else if (update) {
    log('This server already serves ' + name + ' with a production certificate: an update, so only the files are sent.');
  } else if (found.state === 'staging') {
    log('This server was started for ' + name + ' on the staging directory by an earlier run: continuing to production.');
  }

  // 3. the ledger's first block: an update without it would mint a new one, which is a new ledger for every visitor
  if ((found.state === 'live' || found.state === 'staging') && !plan.newLedger && !existsSync(join(plan.publishOut, 'genesis.json'))) {
    throw new ToolError('this server already serves ' + name + ', but ' + relPath(join(plan.publishOut, 'genesis.json')) + ', the ledger\'s first block from the earlier publish, is not here. ' +
      'Publishing now would mint a new first block: a new ledger, with none of the posts visitors already hold. Put the earlier work directory back (--out), ' +
      'or pass --new-ledger to start a new ledger on purpose. Nothing was made, published or sent.');
  }

  // 4. the owner key: made or reused here, never copied
  let keyCreated = false;
  if (existsSync(plan.key)) {
    const k = await loadOwnerKey(plan.key); // refuses a key file other users can read
    log('Owner key: ' + plan.key + ' (reused, fingerprint ' + k.fingerprint + '). It stays on this computer.');
  } else {
    mkdirSync(dirname(plan.key), { recursive: true, mode: 0o700 });
    const made = await d.keygen({ out: plan.key });
    keyCreated = true;
    log('Owner key: made ' + plan.key + ' (mode 600, fingerprint ' + made.fingerprint + '). It stays on this computer. Back it up: visitors remember it, and a lost key means a new ledger.');
  }
  result.keyCreated = keyCreated;

  // 5. publish (in this process, quiet: the report here is shorter, and publish's own "deploy order" does not apply)
  const nowMs = d.now();
  const { options: publishOptions } = publishArgs(plan, name);
  const pub = await d.publish(Object.assign({}, publishOptions, { now: nowMs, quiet: true }));
  const warnings = without(pub.warnings || []);
  result.warnings = warnings;
  Object.assign(result, { btih: pub.btih, ledgerId: pub.ledgerId, expires: pub.summary && pub.summary.expires ? pub.summary.expires : isoDate(nowMs + plan.exp * 86400000) });
  log('Published ' + plan.siteName + ': infohash ' + pub.btih + ', ledger ' + pub.ledgerId + ', ' + pub.files.length + ' files.');
  const dropped = (pub.summary && pub.summary.dropped) || [];
  if (dropped.length) log('Left out of the torrent (' + dropped.length + '): ' + dropped.slice(0, 5).map((x) => x.path).join(', ') + (dropped.length > 5 ? ', and ' + (dropped.length - 5) + ' more (summary.json lists every one)' : ''));
  for (const w of warnings) d.warn(w);

  // 6. the deploy tree, and the proof that the key is not in it
  const assembled = assembleOneBox({ publishOut: plan.publishOut, siteTree: plan.siteTree, allowDir: plan.allowDir, siteName: plan.siteName, summary: pub.summary || pub });
  const jwk = JSON.parse(readFileSync(plan.key, 'utf8'));
  const leaks = findKeyLeaks([plan.siteTree, plan.allowDir], jwk);
  if (leaks.length) throw new ToolError('stopping before anything is sent: the owner key is inside the deploy tree (' + leaks.map((p) => relPath(p)).join(', ') + '). Remove it from the site folder and run again.');
  log('Assembled ' + relPath(plan.siteTree) + ' (' + assembled.files + ' files) and ' + relPath(plan.allowDir) + '/allow.txt.');

  // 7. send, in the deploy order of docs/DEPLOY.md: the web seed, the allow list, then the loader with the pointer
  log('Sending the site to ' + plan.target.target + ':' + plan.boxDir + '/ ...');
  const made = await run(cmds.mkdirBox, { capture: true });
  if (made.code !== 0) throw fail(made, 'making ' + plan.boxDir + '/site/ws and /allow');
  const sentWeb = await run(cmds.rsyncWeb(update));
  if (sentWeb.code !== 0) throw fail(sentWeb, 'rsync of the web seed');
  const sentAllow = await run(cmds.rsyncAllow);
  if (sentAllow.code !== 0) throw fail(sentAllow, 'rsync of the allow list');
  const sentShell = await run(cmds.rsyncShell);
  if (sentShell.code !== 0) throw fail(sentShell, 'rsync of the loader');

  const writeEnv = async (ca) => {
    const file = join(plan.deployRoot, '.env');
    writeFileAtomic(file, mergeEnv(existingEnv, { LW_SITE: name, LW_ACME_CA: ca }), { mode: 0o600 });
    const sent = await run(cmds.rsyncEnv(file));
    if (sent.code !== 0) throw fail(sent, 'rsync of .env');
    existingEnv = readFileSync(file, 'utf8');
  };
  const up = async (build, message) => {
    log(message);
    const res = await run(cmds.composeUp(build));
    if (res.code !== 0) {
      throw fail(res, 'docker compose up', 'Look at the server\'s logs: ssh ' + plan.target.target + ' docker compose -f ' + plan.boxDir + '/docker-compose.yml logs');
    }
  };
  const waitFor = async (kind) => {
    const want = kind === 'staging' ? 'a Let\'s Encrypt staging certificate' : 'a trusted production certificate';
    log('Waiting for ' + want + ' on ' + plan.ip + ':443 ...');
    let last = null;
    for (let i = 0; i < d.certAttempts; i++) {
      last = await d.probeCertificate({ host: plan.ip, port: 443, servername: name, verify: kind === 'production' });
      if (last && last.ok) {
        const staging = /staging/i.test(last.issuer || '');
        if (kind === 'staging' && staging) return { ok: true, issuer: last.issuer };
        if (kind === 'production' && last.authorized && !staging) return { ok: true, issuer: last.issuer };
      }
      if (i + 1 < d.certAttempts) await d.sleep(d.certDelayMs);
    }
    return { ok: false, last };
  };

  if (!update) {
    if (found.state !== 'staging') await writeEnv(ACME_STAGING);
    await up(true, 'Starting the box on the staging directory (the first start builds the tracker image on the server; this can take a few minutes) ...');
    const staged = await waitFor('staging');
    if (!staged.ok) {
      throw new ToolError(Z5 + '\n(The server answered port 443 with: ' + ((staged.last && (staged.last.error || staged.last.issuer)) || 'nothing') + '. The box is running on the staging directory; fix the cause and run the same command again.)');
    }
    result.certificate = 'staging';
    log('Staging certificate issued (' + staged.issuer + '): the address, the ports and the box work.');
    if (plan.stagingOnly) {
      log('Stopped on the staging certificate, as --staging-only asks. Browsers do not trust it. Run the same command without --staging-only to switch to production.');
      log('');
      log(Z6(result.expires));
      return result;
    }
    await writeEnv(ACME_PRODUCTION);
    await up(false, 'Restarting the box on the production directory ...');
  } else {
    await up(false, 'Making sure the box is running ...');
  }
  const trusted = await waitFor('production');
  if (!trusted.ok) {
    throw new ToolError('The staging certificate worked, so the server is reachable, but no trusted production certificate arrived (' + ((trusted.last && (trusted.last.error || trusted.last.issuer)) || 'no answer') + '). ' +
      'Let\'s Encrypt allows 5 duplicate certificates a week for the same names (S2 F5), and the box must keep its caddy_data volume. Look at: ssh ' + plan.target.target +
      ' docker compose -f ' + plan.boxDir + '/docker-compose.yml logs caddy. Run the same command again when the cause is fixed.');
  }
  result.certificate = 'production';
  log('Production certificate in use (' + trusted.issuer + ').');

  // 6. from outside
  log('Checking ' + urlsFor(name).site + ' from this computer ...');
  const checked = await d.checkSite(urlsFor(name).site, { log, timeoutMs: 15000 });
  result.checked = true;
  log((checked.ok ? 'OK' : 'FAILED') + ': ' + checked.failures + ' failure(s), ' + checked.warnings + ' warning(s).');
  if (!checked.ok) {
    throw new ToolError('check-site found ' + checked.failures + ' failure(s) at ' + urlsFor(name).site + ' (the site is on the server; fix the cause and run the same command again, or run: node tools/check-site.mjs ' + urlsFor(name).site + ')');
  }

  log('');
  log('Done: ' + urlsFor(name).site + ' is live.');
  log(Z6(result.expires));
  log('Next:');
  log('  Back up the owner key (' + plan.key + '). Keep ' + relPath(plan.out) + ' too: it holds the ledger\'s first block, and a change is published by running this command again.');
  log('  An always-on copy of the site and its ledger: the "pin" profile in ' + ONE_BOX_DIR + '/README.md.');
  log('  To move to a domain you own later, publish with the same key and --chain ' + plan.siteName + ' (docs/QUICKSTART.md, "Start without a domain").');
  return result;
}

// package.json holds the repository URL; the clone command printed on a missing box uses it.
function repositoryUrl() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
    return String(url || 'https://github.com/ashkanshokry25-maker/felinar.git').replace(/^git\+/, '');
  } catch (_) {
    return 'https://github.com/ashkanshokry25-maker/felinar.git';
  }
}

// ---------------------------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------------------------

export const SHIP_FLAGS = {
  ip: { type: 'string' },
  to: { type: 'string' },
  ct: { type: 'string' },
  name: { type: 'string' },
  key: { type: 'string' },
  suffix: { type: 'string' },
  'remote-dir': { type: 'string', default: DEFAULT_REMOTE_DIR },
  'staging-only': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  out: { type: 'string' },
  dist: { type: 'string', default: join(ROOT, 'dist') },
  exp: { type: 'int', default: SHIP_DEFAULT_EXP_DAYS },
  policy: { type: 'string' },
  bits: { type: 'int' },
  'new-ledger': { type: 'boolean' },
  'release-list': { type: 'string' },
  'release-sig': { type: 'string' },
  'release-key': { type: 'string' },
  'allow-unverified-loader': { type: 'boolean' },
  'expect-commit': { type: 'string' },
};

async function main(argv) {
  const { flags, positionals } = parseCli(argv, SHIP_FLAGS);
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('expected exactly one site directory');
  await ship(Object.assign({}, flags, { dir: positionals[0] }));
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
