// Unit tests for tools/ship.mjs (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 rung 2a, Rc3 and Rc4): the plan for a server with only an IP address, the
// name check with its sslip.io fallback, the owner key that never leaves this computer, the first run (staging certificate, then production), the
// update, --staging-only, --dry-run, and the plain-words strings Z1 to Z6. publish and keygen run for real in a temporary directory; ssh, rsync, DNS,
// the TLS probe and check-site are canned. Nothing here opens a socket, resolves a name or starts a process other than a local rsync.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync, statSync, cpSync, symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  ship as shipForReal, planShip, commandsFor, publishArgs, urlsFor, parseSshTarget, unusableAddress, parseEnv, envState, mergeEnv, composeVersionAtLeast, commandText,
  sshArgv, sanitizeName, assembleOneBox, chmodTree, findKeyLeaks, SHIP_FLAGS, SHIP_DEFAULT_EXP_DAYS, ACME_STAGING, ACME_PRODUCTION, DEFAULT_REMOTE_DIR, COMPOSE_MIN,
  Z1, Z2, Z3, Z5, Z6,
} from '../../tools/ship.mjs';
import { ipName } from '../../tools/name-check.mjs';
import { UsageError, ToolError, ROOT, loadOwnerKey } from '../../tools/lib.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { buildHashList, signList } from '../../tools/verify-release.mjs';
import { chatLaneHash } from '../../tools/tracker.mjs';
import { parsePointer, verifyPointer, MAX_PUBLISH_EXP_DAYS } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-ship-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

// ship() makes a key under the home directory and a work directory under the current one when it is not told otherwise. A test that forgot
// to say where would write into the real home directory and into this repository, so every call in this file goes through this check.
const REAL_HOME = homedir();
function ship(options = {}, deps = {}) {
  const home = deps.home !== undefined ? deps.home : options.home;
  const cwd = deps.cwd !== undefined ? deps.cwd : options.cwd;
  if (!home || !cwd || home === REAL_HOME || cwd === ROOT || cwd === process.cwd()) {
    throw new Error('test bug: ship() must run with a temporary home and cwd (got home ' + home + ', cwd ' + cwd + ')');
  }
  return shipForReal(options, deps);
}
const NOW = Date.UTC(2026, 9, 20, 12, 0, 30);
const IP = '203.0.113.7';
const NAME = '203-0-113-7.nip.io';
const SSLIP = '203-0-113-7.sslip.io';
const CT = 'mailto:you@example.org';
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
const IGNORED = new Set(['.DS_Store']);
function listTree(root, rel = '') {
  const out = [];
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (IGNORED.has(ent.name)) continue;
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...listTree(root, r));
    else out.push(r);
  }
  return out.sort();
}

function makeSite(name = 'my-site') {
  const dir = join(fresh('sites'), name);
  writeTree(dir, {
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n',
    'css/app.css': 'body { margin: 0 }\n',
  });
  return dir;
}
function fakeDist() {
  const dist = fresh('dist');
  writeTree(dist, {
    'mw-sw.js': '// sw\n',
    'mw-sw-kill.js': '// kill\n',
    '_mw/boot.js': '// boot\n',
    '_mw/loader.js': '// loader\n',
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head><body><script src="/_mw/boot.js"></script></body></html>',
    '404.html': '<!doctype html><html><head><title>Loading</title></head><body></body></html>',
    '_headers': '/*\n  X-Test: 1\n',
  });
  return dist;
}

/** A canned DNS resolver: name -> answers; anything else is NXDOMAIN. Records the names asked. */
function dns(table) {
  const asked = [];
  const fn = async (name) => {
    asked.push(name);
    if (!(name in table)) throw Object.assign(new Error('queryA ENOTFOUND ' + name), { code: 'ENOTFOUND' });
    return table[name];
  };
  fn.asked = asked;
  return fn;
}
const GOOD = { [NAME]: [IP], [SSLIP]: [IP] };

/**
 * A canned server and the computer's side of the world: exec answers ssh and rsync as a server with the clone and Docker would, keeps a "remote" .env
 * from the file rsync is asked to upload, remembers which certificate authority the box was started with, and answers the TLS probe accordingly.
 */
function world(opts = {}) {
  const w = {
    calls: [],
    rsyncs: [],
    env: opts.env === undefined ? null : opts.env,
    composeFile: opts.composeFile !== false,
    composeVersion: opts.composeVersion || '2.29.1',
    activeCa: null,
    probes: [],
    probeFailures: opts.probeFailures || 1, // connection attempts that fail before the certificate shows up
    neverIssue: Boolean(opts.neverIssue),
    productionNeverTrusted: Boolean(opts.productionNeverTrusted),
    sleeps: 0,
    checked: [],
    lines: [],
    warnings: [],
  };
  const answer = (code, stdout = '') => ({ code, signal: null, stdout });
  w.exec = async (file, args, execOpts = {}) => {
    w.calls.push({ file, args: args.slice(), capture: Boolean(execOpts.capture) });
    if (file === 'ssh') {
      const at = args.findIndex((a) => /^[A-Za-z0-9_][A-Za-z0-9._-]*@/.test(a));
      const words = args.slice(at + 1);
      const line = words.join(' ');
      if (opts.sshCode !== undefined) return answer(opts.sshCode);
      if (/^test -f .*\/docker-compose\.yml$/.test(line)) return answer(w.composeFile ? 0 : 1);
      if (/^git -C \S+ rev-parse HEAD$/.test(line)) return answer(opts.noGit ? 128 : 0, opts.noGit ? '' : (opts.remoteHead || HEAD_COMMIT) + '\n');
      if (line === 'command -v rsync') return answer(opts.noRsyncThere ? 1 : 0, opts.noRsyncThere ? '' : '/usr/bin/rsync\n');
      if (line === 'docker compose version --short') return answer(opts.composeFails ? 127 : 0, w.composeVersion + '\n');
      if (/^test -f .*\/\.env$/.test(line)) return answer(w.env === null ? 1 : 0);
      if (/^cat .*\/\.env$/.test(line)) return answer(0, w.env);
      if (/^mkdir -p /.test(line)) {
        if (opts.mkdirFails) return answer(1);
        (w.dirs = w.dirs || []).push(line);
        return answer(0);
      }
      if (/^docker compose -f \S+ up /.test(line)) {
        if (opts.upFails) return answer(1);
        w.activeCa = parseEnv(w.env).get('LW_ACME_CA') || ACME_PRODUCTION;
        w.probeCount = 0;
        return answer(0);
      }
      throw new Error('the canned server does not know: ssh ' + line);
    }
    if (file === 'rsync') {
      w.rsyncs.push(args.slice());
      if (opts.rsyncFails && opts.rsyncFails(args)) return answer(23);
      const dest = args[args.length - 1];
      if (/\/\.env$/.test(dest)) w.env = readFileSync(args[args.length - 2], 'utf8');
      return answer(0);
    }
    throw new Error('unexpected command: ' + file);
  };
  w.probeCertificate = async ({ host, servername, verify }) => {
    w.probes.push({ host, servername, verify });
    w.probeCount = (w.probeCount || 0) + 1;
    if (w.neverIssue || w.activeCa === null || w.probeCount <= w.probeFailures) return { ok: false, error: 'connect ECONNREFUSED ' + host + ':443' };
    if (/staging/.test(w.activeCa)) return { ok: true, issuer: '(STAGING) Let\'s Encrypt (STAGING) Artificial Apricot R3', authorized: false };
    if (w.productionNeverTrusted) return { ok: true, issuer: 'Let\'s Encrypt R10', authorized: false, error: 'unable to verify the first certificate' };
    return { ok: true, issuer: 'Let\'s Encrypt R10', authorized: true };
  };
  w.checkSite = async (url, options) => {
    w.checked.push({ url, hasLog: typeof options.log === 'function' });
    if (typeof options.log === 'function') options.log('[ok]   page: HTTP 200');
    return opts.checkFails ? { ok: false, failures: 2, warnings: 0, results: [] } : { ok: true, failures: 0, warnings: 1, results: [] };
  };
  w.home = opts.home || fresh('home');
  w.cwd = opts.cwd || fresh('cwd');
  w.deps = (extra = {}) => Object.assign({
    exec: w.exec,
    resolve4: dns(GOOD),
    probeCertificate: w.probeCertificate,
    checkSite: w.checkSite,
    now: () => NOW,
    sleep: async () => { w.sleeps++; },
    log: (l) => w.lines.push(l),
    warn: (m) => w.warnings.push(m),
    home: w.home,
    cwd: w.cwd,
    localCommit: () => (opts.localCommit === undefined ? HEAD_COMMIT : opts.localCommit),
  }, Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)));
  return w;
}

// fakeDist() is not this checkout's build: the runs below send it unchecked on purpose (SUP-5 has its own tests).
const HEAD_COMMIT = '1'.repeat(40);
function baseOptions(extra = {}) {
  return Object.assign({ dir: makeSite(), ip: IP, to: 'ssh://root@' + IP, ct: CT, dist: fakeDist(), allowUnverifiedLoader: true }, extra);
}

// ---------------------------------------------------------------------------------------------- pure helpers

// IND-7 (independence design, 2026-10-25): Z1 no longer says the whole rung "costs nothing and needs no sign-up"; that is true of
// the name only, and the rented server is an account its provider can close.
test('the strings: Z1 (reworded by IND-7), Z2, Z3, Z5 and Z6 of S2 as written, with the name and the date filled in', () => {
  assert.equal(Z1(NAME), 'Your site will be at https://203-0-113-7.nip.io/. The name is your server\'s IP address with dashes: the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close.');
  assert.doesNotMatch(Z1(NAME), /It costs nothing/, 'the claim covers the name, not the server');
  assert.equal(Z2, 'If this server gets another IP address, the address changes and visitors start again. A domain you own does not have this problem.');
  assert.equal(Z3('nip.io'), 'nip.io is a free DNS service run by two volunteers with no uptime promise. If it stops, new visitors cannot open this address; people who already opened the site keep their saved copy.');
  assert.equal(Z3(), Z3('nip.io'));
  assert.equal(Z3('sslip.io').replace(/^sslip\.io/, 'nip.io'), Z3('nip.io'), 'sslip.io is the same service under its second name (S2 F1)');
  assert.equal(Z5, 'The certificate authority could not reach this server on port 80 or 443. At home a router may need a port forward, some providers block port 80, and a provider that shares one address between customers cannot be reached. Use a rented server, a free static host or a tunnel.');
  assert.equal(Z6('2027-11-23'), 'Your signed address record expires on 2027-11-23. After that new visitors cannot load the site until you publish again. Add this date to your calendar.');
});

test('parseSshTarget: ssh://user@host with an optional port; options, passwords, paths and odd users are refused', () => {
  assert.deepEqual(parseSshTarget('ssh://root@203.0.113.7'), { user: 'root', host: '203.0.113.7', port: null, target: 'root@203.0.113.7', text: 'ssh://root@203.0.113.7' });
  const p = parseSshTarget('ssh://deploy@box.example.org:2222');
  assert.equal(p.port, 2222);
  assert.equal(p.target, 'deploy@box.example.org');
  assert.equal(parseSshTarget('ssh://root@[2001:db8::7]:22').target, 'root@[2001:db8::7]');
  for (const bad of [
    '', 'root@203.0.113.7', 'http://root@203.0.113.7', 'ssh://203.0.113.7', 'ssh://@203.0.113.7', 'ssh://root:secret@203.0.113.7', 'ssh://root@203.0.113.7/opt', 'ssh://root@203.0.113.7?x=1',
    'ssh://-oProxyCommand=x@203.0.113.7', 'ssh://root@-oProxyCommand=x', 'ssh://root@203.0.113.7:0', 'ssh://root@203.0.113.7:70000', 'ssh://ro ot@203.0.113.7', 'ssh://root@host;rm',
  ]) {
    assert.throws(() => parseSshTarget(bad), UsageError, JSON.stringify(bad));
  }
});

test('unusableAddress: private, loopback, shared, link-local, multicast and reserved addresses are refused; the documentation ranges and public ones pass', () => {
  for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20', '127.0.0.1', '100.64.0.1', '100.127.255.255', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.ok(unusableAddress(ip), ip);
  }
  for (const ip of ['203.0.113.7', '192.0.2.10', '198.51.100.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '45.76.1.2']) {
    assert.equal(unusableAddress(ip), null, ip);
  }
  assert.match(unusableAddress('192.168.1.20'), /private address/);
  assert.match(unusableAddress('100.64.0.1'), /carrier-grade NAT/);
  assert.ok(unusableAddress('not an address'));
});

test('parseEnv, envState and mergeEnv: the compose .env file of the box', () => {
  const text = '# the box\nLW_SITE=' + NAME + '\nLW_ACME_CA="' + ACME_STAGING + '"\nPIN_MONTH_CAP=1000000\n\nexport OTHER=\'x y\'\n';
  const env = parseEnv(text);
  assert.equal(env.get('LW_SITE'), NAME);
  assert.equal(env.get('LW_ACME_CA'), ACME_STAGING);
  assert.equal(env.get('PIN_MONTH_CAP'), '1000000');
  assert.equal(env.get('OTHER'), 'x y');
  assert.equal(parseEnv('#LW_SITE=x\n').size, 0, 'a comment is not a setting');
  assert.deepEqual(envState('', NAME), { state: 'fresh', site: null, ca: null });
  assert.deepEqual(envState('PIN_MONTH_CAP=1\n', NAME), { state: 'fresh', site: null, ca: null });
  assert.deepEqual(envState('LW_SITE=' + NAME + '\n', NAME), { state: 'live', site: NAME, ca: null });
  assert.equal(envState('LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n', NAME).state, 'live');
  assert.equal(envState('LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_STAGING + '\n', NAME).state, 'staging');
  assert.deepEqual(envState('LW_SITE=198-51-100-9.nip.io\n', NAME), { state: 'replace', site: '198-51-100-9.nip.io', ca: null });
  const merged = mergeEnv(text, { LW_SITE: SSLIP, LW_ACME_CA: ACME_PRODUCTION });
  assert.equal(merged, '# the box\nPIN_MONTH_CAP=1000000\n\nexport OTHER=\'x y\'\nLW_SITE=' + SSLIP + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n');
  assert.equal(mergeEnv('', { LW_SITE: NAME, LW_ACME_CA: ACME_STAGING }), 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_STAGING + '\n');
  assert.equal(mergeEnv(merged, { LW_SITE: SSLIP, LW_ACME_CA: ACME_PRODUCTION }), merged, 'merging twice changes nothing');
});

test('composeVersionAtLeast, sanitizeName and commandText', () => {
  assert.deepEqual(COMPOSE_MIN, [2, 17]);
  for (const v of ['2.17.0', '2.29.1\n', 'v2.40.3', '3.0.0', '2.17']) assert.equal(composeVersionAtLeast(v), true, v);
  for (const v of ['2.16.9', '1.29.2', '', 'docker-compose', null, 'v1.99.0']) assert.equal(composeVersionAtLeast(v), false, String(v));
  assert.equal(sanitizeName('my-site'), 'my-site');
  assert.equal(sanitizeName('My Site (2026)!'), 'My-Site-2026');
  assert.equal(sanitizeName('  ..hidden'), 'hidden');
  assert.equal(sanitizeName('x'.repeat(90)).length, 64);
  assert.equal(sanitizeName('???'), '');
  assert.equal(commandText(['rsync', '-e', 'ssh -p 22', 'a b', "it's"]), "rsync -e 'ssh -p 22' 'a b' 'it'\\''s'");
});

// ---------------------------------------------------------------------------------------------- the plan

test('planShip: --ip 203.0.113.7 gives 203-0-113-7.nip.io, the box under /opt/felinar/deploy/one-box, a work directory and a key outside the site', () => {
  const home = fresh('home');
  const cwd = fresh('cwd');
  const dir = makeSite('Blog');
  const plan = planShip({ dir, ip: IP, to: 'ssh://root@' + IP, ct: CT }, { home, cwd });
  assert.equal(plan.firstName, NAME);
  assert.deepEqual(plan.suffixes, ['nip.io', 'sslip.io']);
  assert.equal(plan.siteName, 'Blog');
  assert.equal(plan.exp, SHIP_DEFAULT_EXP_DAYS);
  assert.equal(SHIP_DEFAULT_EXP_DAYS, 399);
  assert.equal(SHIP_DEFAULT_EXP_DAYS, MAX_PUBLISH_EXP_DAYS, 'the default is the longest record publish signs (owner decision SZ-3)');
  assert.equal(plan.remoteDir, DEFAULT_REMOTE_DIR);
  assert.equal(plan.boxDir, '/opt/felinar/deploy/one-box');
  assert.equal(plan.key, join(home, '.config', 'magnet-web', 'Blog.jwk'));
  assert.equal(plan.out, join(cwd, 'dist-ship', 'Blog'));
  assert.equal(plan.publishOut, join(cwd, 'dist-ship', 'Blog', 'publish'));
  assert.equal(plan.siteTree, join(cwd, 'dist-ship', 'Blog', 'one-box', 'site'));
  assert.equal(plan.allowDir, join(cwd, 'dist-ship', 'Blog', 'one-box', 'allow'));
  assert.equal(plan.target.target, 'root@' + IP);
  assert.equal(plan.stagingOnly, false);
  assert.equal(plan.dryRun, false);
  assert.deepEqual(urlsFor(NAME), { site: 'https://' + NAME + '/', ws: 'https://' + NAME + '/ws/', cs: 'https://' + NAME + '/ws/genesis.json', tracker: 'wss://' + NAME + '/tracker' });
  // the folder name decides the site name, made safe; --name overrides
  assert.equal(planShip({ dir: makeSite('My Site (2026)'), ip: IP, to: 'ssh://root@' + IP, ct: CT }, { home, cwd }).siteName, 'My-Site-2026');
  assert.equal(planShip({ dir, name: 'blog', ip: IP, to: 'ssh://root@' + IP, ct: CT }, { home, cwd }).siteName, 'blog');
  assert.equal(planShip({ dir, ip: IP, to: 'ssh://root@' + IP, ct: CT, suffix: 'sslip.io' }, { home, cwd }).firstName, SSLIP);
});

test('planShip: the publish command it runs is the by-hand command of S2 rung 2a, with --chain = --name, --exp 399 and the own tracker', () => {
  const plan = planShip({ dir: makeSite(), ip: IP, to: 'ssh://root@' + IP, ct: CT, dist: fakeDist() }, { home: fresh('h'), cwd: fresh('c') });
  const { options, argv } = publishArgs(plan, NAME);
  assert.deepEqual(argv, [
    plan.dir, '--name', 'my-site', '--chain', 'my-site', '--scope', NAME, '--key', plan.key, '--ws', 'https://' + NAME + '/ws/', '--cs', 'https://' + NAME + '/ws/genesis.json',
    '--tr', 'wss://' + NAME + '/tracker', '--ct', CT, '--exp', '399', '--shell', '--out', plan.publishOut, '--dist', plan.dist,
  ]);
  assert.equal(options.chain, 'my-site');
  assert.equal(options.exp, 399);
  assert.equal(options.shell, true);
  assert.deepEqual(options.tr, ['wss://' + NAME + '/tracker']);
  assert.deepEqual(options.ws, ['https://' + NAME + '/ws/']);
  assert.equal(options.cs, 'https://' + NAME + '/ws/genesis.json');
  assert.equal(options.scope, NAME);
  assert.equal(options.ct, CT);
  const open = publishArgs(Object.assign({}, plan, { policy: 'open', bits: 16 }), NAME);
  assert.deepEqual(open.argv.slice(-4), ['--policy', 'open', '--bits', '16']);
  assert.equal(open.options.policy, 'open');
});

test('planShip: refusals before anything happens: no --to or --ct, a bad address, a private one, a mismatch, an unsafe path, a key inside the site', () => {
  const dir = makeSite();
  const env = { home: fresh('home'), cwd: fresh('cwd') };
  const ok = { dir, ip: IP, to: 'ssh://root@' + IP, ct: CT };
  const refuses = (extra, pattern) => assert.throws(() => planShip(Object.assign({}, ok, extra), env), (e) => e instanceof UsageError && pattern.test(e.message), JSON.stringify(extra));
  refuses({ to: undefined }, /missing --to ssh:\/\/user@host/);
  refuses({ to: '' }, /missing --to/);
  refuses({ ct: undefined }, /missing --ct/);
  refuses({ ct: 'ftp://x.example/' }, /--ct must be an https: or mailto: URL/);
  refuses({ ct: 'not a url' }, /--ct must be an https: or mailto: URL/);
  refuses({ ip: undefined }, /missing --ip/);
  refuses({ ip: '203.0.113' }, /--ip must be an IPv4 address/);
  refuses({ ip: 'example.com' }, /--ip must be an IPv4 address/);
  refuses({ ip: '192.168.1.20', to: 'ssh://root@192.168.1.20' }, /private address[\s\S]*share on my LAN/);
  refuses({ ip: '127.0.0.1', to: 'ssh://root@127.0.0.1' }, /loopback/);
  refuses({ ip: '100.64.0.9', to: 'ssh://root@100.64.0.9' }, /carrier-grade NAT/);
  refuses({ to: 'ssh://root@198.51.100.9' }, /names 198\.51\.100\.9 but --ip is 203\.0\.113\.7/);
  refuses({ suffix: 'traefik.me' }, /nip\.io or sslip\.io/);
  refuses({ name: 'bad name!' }, /--name must be 1 to 64 characters/);
  refuses({ name: 'x'.repeat(65) }, /--name must be 1 to 64 characters/);
  refuses({ remoteDir: 'opt/felinar' }, /--remote-dir must be an absolute path/);
  refuses({ remoteDir: '/opt/my site' }, /--remote-dir must be an absolute path/);
  refuses({ remoteDir: '/opt/../etc' }, /--remote-dir must be an absolute path/);
  refuses({ remoteDir: '/opt/x;rm -rf /' }, /--remote-dir must be an absolute path/);
  refuses({ exp: 400 }, /--exp must be 1 to 399 days/);
  refuses({ exp: 0 }, /--exp must be 1 to 399 days/);
  refuses({ policy: 'everyone' }, /--policy must be owner, allow or open/);
  refuses({ key: join(dir, 'owner.jwk') }, /owner key must stay outside the site folder/);
  refuses({ out: join(dir, 'build') }, /--out must not be inside the site folder/);
  refuses({ out: join(env.cwd, 'work'), key: join(env.cwd, 'work', 'owner.jwk') }, /owner key must stay outside the work directory/);
  assert.throws(() => planShip(Object.assign({}, ok, { dir: undefined }), env), UsageError);
  assert.throws(() => planShip(Object.assign({}, ok, { dir: join(env.cwd, 'missing') }), env), (e) => e instanceof ToolError && /no such directory/.test(e.message));
  assert.doesNotThrow(() => planShip(Object.assign({}, ok, { remoteDir: '/srv/felinar/', to: 'ssh://deploy@box.example.org:2222' }), env), 'a host name for --to is not compared with --ip');
});

test('commandsFor: argv arrays for ssh and rsync; every remote word is safe for the login shell; rsync keeps the live snapshot on an update', () => {
  const plan = planShip({ dir: makeSite(), ip: IP, to: 'ssh://deploy@' + IP + ':2222', ct: CT, remoteDir: '/srv/felinar' }, { home: fresh('h'), cwd: fresh('c') });
  const c = commandsFor(plan);
  const sshHead = ['ssh', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-p', '2222', 'deploy@' + IP];
  assert.deepEqual(c.composeFile, [...sshHead, 'test', '-f', '/srv/felinar/deploy/one-box/docker-compose.yml']);
  assert.deepEqual(c.composeVersion, [...sshHead, 'docker', 'compose', 'version', '--short']);
  assert.deepEqual(c.rsyncThere, [...sshHead, 'command', '-v', 'rsync']);
  assert.deepEqual(c.envExists, [...sshHead, 'test', '-f', '/srv/felinar/deploy/one-box/.env']);
  assert.deepEqual(c.envRead, [...sshHead, 'cat', '/srv/felinar/deploy/one-box/.env']);
  assert.deepEqual(c.composeUp(true), [...sshHead, 'docker', 'compose', '-f', '/srv/felinar/deploy/one-box/docker-compose.yml', 'up', '-d', '--build', '--wait', '--wait-timeout', '300']);
  assert.deepEqual(c.composeUp(false).slice(-3), ['--wait', '--wait-timeout', '120']);
  assert.equal(c.composeUp(false).includes('--build'), false);
  assert.deepEqual(c.mkdirBox, [...sshHead, 'mkdir', '-p', '/srv/felinar/deploy/one-box/site/ws', '/srv/felinar/deploy/one-box/allow']);
  const web1 = c.rsyncWeb(false);
  const webUpdate = c.rsyncWeb(true);
  for (const r of [web1, webUpdate, c.rsyncAllow, c.rsyncShell]) {
    assert.deepEqual(r.slice(0, 2), ['rsync', '-rltp']);
    assert.equal(r.some((a) => /^--chmod/.test(a)), false, 'the rsync that macOS ships (openrsync) refuses --chmod=D755,F644; the modes are made 755 and 644 before the copy');
    assert.equal(r[r.indexOf('-e') + 1], 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -p 2222');
  }
  // 1. the web seed is added to, never pruned: visitors on the previous version still fetch its files for a week
  assert.equal(web1.includes('--delete'), false);
  assert.equal(web1[web1.length - 2], plan.siteTree + '/ws/');
  assert.equal(web1[web1.length - 1], 'deploy@' + IP + ':/srv/felinar/deploy/one-box/site/ws/');
  assert.equal(web1.includes('--exclude=/genesis.json'), false);
  assert.equal(webUpdate.includes('--exclude=/genesis.json'), true, 'an update keeps the snapshot on the server (a pin may have refreshed it)');
  // 3. the loader is pruned, without touching ws/ (where the pin\'s heartbeat and the web seed are)
  assert.deepEqual(c.rsyncShell.slice(0, 4), ['rsync', '-rltp', '--delete', '--exclude=/ws/']);
  assert.equal(c.rsyncShell[c.rsyncShell.length - 2], plan.siteTree + '/');
  assert.equal(c.rsyncShell[c.rsyncShell.length - 1], 'deploy@' + IP + ':/srv/felinar/deploy/one-box/site/');
  assert.deepEqual(c.rsyncEnv('/tmp/x/.env'), ['rsync', '-tp', '-e', 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -p 2222', '/tmp/x/.env', 'deploy@' + IP + ':/srv/felinar/deploy/one-box/.env']);
  assert.equal(c.rsyncAllow[c.rsyncAllow.length - 1], 'deploy@' + IP + ':/srv/felinar/deploy/one-box/allow/');
  for (const argv of [c.composeFile, c.rsyncThere, c.composeVersion, c.envExists, c.envRead, c.mkdirBox, c.composeUp(true), c.composeUp(false)]) {
    for (const word of argv.slice(argv.indexOf('deploy@' + IP) + 1)) assert.match(word, /^[A-Za-z0-9._\/:@+=,%-]+$/, word);
  }
  assert.throws(() => sshArgv(plan.target, ['cat', '/etc/passwd; reboot']), /needs quoting/);
  assert.throws(() => sshArgv(plan.target, ['echo', '$(id)']), /needs quoting/);
  // a port is only passed when the URL has one
  const noPort = commandsFor(planShip({ dir: makeSite(), ip: IP, to: 'ssh://root@' + IP, ct: CT }, { home: fresh('h'), cwd: fresh('c') }));
  assert.equal(noPort.composeFile.includes('-p'), false);
});

// ---------------------------------------------------------------------------------------------- --dry-run

test('--dry-run prints the hosts, the strings and every command, and contacts, reads and writes nothing', async () => {
  const w = world();
  const cwd = fresh('cwd');
  const home = fresh('home');
  const dist = fakeDist();
  const dir = makeSite();
  const resolve4 = dns(GOOD);
  const result = await ship({ dir, ip: IP, to: 'ssh://root@' + IP, ct: CT, dist, dryRun: true }, w.deps({ cwd, home, resolve4 }));
  assert.equal(result.dryRun, true);
  assert.equal(w.calls.length, 0, 'no ssh, no rsync');
  assert.equal(resolve4.asked.length, 0, 'no DNS lookup');
  assert.equal(w.probes.length, 0);
  assert.equal(w.checked.length, 0);
  assert.equal(existsSync(join(cwd, 'dist-ship')), false, 'nothing written');
  assert.equal(existsSync(join(home, '.config')), false, 'no key made');
  const text = w.lines.join('\n');
  assert.match(text, /^felinar ship \(dry run\): /);
  assert.match(text, /Would contact \(nothing else\):/);
  assert.match(text, new RegExp(NAME.replace(/\./g, '\\.') + ' or ' + SSLIP.replace(/\./g, '\\.') + '  DNS lookup'));
  assert.match(text, /root@203\.0\.113\.7  ssh and rsync/);
  assert.match(text, /203\.0\.113\.7:443  one TLS connection per check/);
  assert.ok(text.includes(Z1(NAME)) && text.includes(Z2) && text.includes(Z3('nip.io')));
  assert.ok(text.includes(Z6('2027-11-23')), 'the date is now plus 399 days: ' + text.slice(-400));
  const cmds = commandsFor(planShip({ dir, ip: IP, to: 'ssh://root@' + IP, ct: CT, dist }, { home, cwd }));
  for (const argv of [cmds.composeFile, cmds.rsyncThere, cmds.composeVersion, cmds.envExists, cmds.envRead, cmds.mkdirBox, cmds.rsyncWeb(false), cmds.rsyncAllow, cmds.rsyncShell, cmds.composeUp(true), cmds.composeUp(false)]) {
    assert.ok(text.includes(commandText(argv)), 'the command is printed: ' + commandText(argv));
  }
  assert.match(text, /node tools\/keygen\.mjs --out /);
  assert.match(text, /node tools\/publish\.mjs \S+ --name my-site --chain my-site --scope 203-0-113-7\.nip\.io /);
  assert.match(text, /--tr wss:\/\/203-0-113-7\.nip\.io\/tracker/);
  assert.match(text, /--exp 399 --shell --out /);
  assert.match(text, /LW_ACME_CA=https:\/\/acme-staging-v02\.api\.letsencrypt\.org\/directory/);
  assert.match(text, /LW_ACME_CA=https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
  assert.match(text, /node tools\/check-site\.mjs https:\/\/203-0-113-7\.nip\.io\//);
  // an existing key is reported as reused
  const keyFile = join(fresh('keys'), 'owner.jwk');
  writeFileSync(keyFile, '{}', { mode: 0o600 });
  w.lines.length = 0;
  await ship({ dir, ip: IP, to: 'ssh://root@' + IP, ct: CT, dist, dryRun: true, key: keyFile, stagingOnly: true }, w.deps({ cwd, home }));
  const again = w.lines.join('\n');
  assert.match(again, /\(exists; it is reused\)/);
  assert.equal(/node tools\/keygen\.mjs/.test(again), false);
  assert.match(again, /stop here \(--staging-only\)/);
  assert.equal(/switch \.env to LW_ACME_CA=https:\/\/acme-v02/.test(again), false);
  // a loader that is not built is a warning in a dry run
  w.warnings.length = 0;
  await ship({ dir, ip: IP, to: 'ssh://root@' + IP, ct: CT, dist: join(fresh('empty'), 'dist'), dryRun: true }, w.deps({ cwd, home }));
  assert.ok(w.warnings.some((m) => /the loader is not built yet[\s\S]*npm run build/.test(m)));
});

test('--dry-run still checks the flags, and --suffix sslip.io names that service first and only', async () => {
  const w = world();
  await assert.rejects(ship(baseOptions({ dryRun: true, to: undefined }), w.deps()), UsageError);
  await assert.rejects(ship(baseOptions({ dryRun: true, ct: undefined }), w.deps()), UsageError);
  await ship(baseOptions({ dryRun: true, suffix: 'sslip.io' }), w.deps());
  const text = w.lines.join('\n');
  assert.ok(text.includes(Z1(SSLIP)));
  assert.ok(text.includes(Z3('sslip.io')));
  assert.equal(text.includes(' or ' + NAME), false);
});

// ---------------------------------------------------------------------------------------------- a first run

async function firstRun(opts = {}, extra = {}) {
  const w = world(opts);
  const options = baseOptions(extra.options || {});
  const deps = w.deps(extra.deps || {});
  const result = await ship(options, deps);
  return { w, options, deps, result };
}

test('a first run: name check, key, publish, deploy tree, rsync, staging certificate, production certificate, check-site (in that order)', async () => {
  const { w, options, deps, result } = await firstRun();
  const plan = planShip(options, { home: deps.home, cwd: deps.cwd });
  const cmds = commandsFor(plan);
  assert.equal(result.name, NAME);
  assert.equal(result.suffix, 'nip.io');
  assert.equal(result.state, 'fresh');
  assert.equal(result.certificate, 'production');
  assert.equal(result.checked, true);
  assert.equal(result.keyCreated, true);
  assert.equal(result.expires, '2027-11-23');
  // the DNS lookup came first and only nip.io was asked
  assert.deepEqual(deps.resolve4.asked, [NAME]);
  // the exact command sequence: ssh by its remote words, rsync by where it sends. The server is looked at before anything is made or published,
  // and the sending follows the deploy order: web seed, allow list, loader with the pointer.
  const label = (c) => (c.file === 'ssh' ? 'ssh ' + c.args.slice(c.args.findIndex((a) => /^root@/.test(a)) + 1).join(' ') : 'rsync -> ' + c.args[c.args.length - 1].replace(/^[^:]*:/, ''));
  assert.deepEqual(w.calls.map(label), [
    'ssh test -f /opt/felinar/deploy/one-box/docker-compose.yml',
    'ssh git -C /opt/felinar rev-parse HEAD',
    'ssh command -v rsync',
    'ssh docker compose version --short',
    'ssh test -f /opt/felinar/deploy/one-box/.env',
    'ssh mkdir -p /opt/felinar/deploy/one-box/site/ws /opt/felinar/deploy/one-box/allow',
    'rsync -> /opt/felinar/deploy/one-box/site/ws/',
    'rsync -> /opt/felinar/deploy/one-box/allow/',
    'rsync -> /opt/felinar/deploy/one-box/site/',
    'rsync -> /opt/felinar/deploy/one-box/.env',
    'ssh docker compose -f /opt/felinar/deploy/one-box/docker-compose.yml up -d --build --wait --wait-timeout 300',
    'rsync -> /opt/felinar/deploy/one-box/.env',
    'ssh docker compose -f /opt/felinar/deploy/one-box/docker-compose.yml up -d --wait --wait-timeout 120',
  ]);
  // exactly the commands that --dry-run prints
  assert.deepEqual(w.calls[0].args, cmds.composeFile.slice(1));
  assert.deepEqual(w.calls[1].args, cmds.remoteHead.slice(1));
  assert.deepEqual(w.calls[2].args, cmds.rsyncThere.slice(1));
  assert.deepEqual(w.calls[5].args, cmds.mkdirBox.slice(1));
  assert.deepEqual(w.calls[6].args, cmds.rsyncWeb(false).slice(1));
  assert.deepEqual(w.calls[7].args, cmds.rsyncAllow.slice(1));
  assert.deepEqual(w.calls[8].args, cmds.rsyncShell.slice(1));
  assert.deepEqual(w.calls[10].args, cmds.composeUp(true).slice(1));
  assert.deepEqual(w.calls[12].args, cmds.composeUp(false).slice(1));
  // the .env that ended up on the server
  assert.equal(w.env, 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n');
  assert.equal(statSync(join(plan.deployRoot, '.env')).mode & 0o777, 0o600);
  // staging first: the box was started on the staging directory, and the probe waited for a staging issuer, then a trusted one
  assert.deepEqual(w.probes.map((p) => p.verify), [false, false, true, true], 'two attempts for staging (the first fails), then two for production (the first fails)');
  assert.ok(w.probes.every((p) => p.host === IP && p.servername === NAME));
  assert.equal(w.sleeps, 2, 'it waits between failed attempts, not after a good one');
  // check-site against the new address
  assert.deepEqual(w.checked.map((c) => c.url), ['https://' + NAME + '/']);
  assert.equal(w.checked[0].hasLog, true);
  const text = w.lines.join('\n');
  for (const s of [Z1(NAME), Z2, Z3('nip.io'), Z6('2027-11-23')]) assert.ok(text.includes(s), s);
  assert.equal(text.indexOf(Z1(NAME)) < text.indexOf('Owner key:'), true, 'Z1 is among the first lines');
  assert.match(text, /Will contact \(nothing else\):/);
  assert.ok(text.indexOf('Will contact') < text.indexOf(Z1(NAME)), 'the hosts are named before the first contact');
  assert.match(text, /Staging certificate issued \(\(STAGING\) Let's Encrypt/);
  assert.match(text, /Production certificate in use \(Let's Encrypt R10\)/);
  assert.match(text, /Done: https:\/\/203-0-113-7\.nip\.io\/ is live\./);
  assert.match(text, /OK: 0 failure\(s\), 1 warning\(s\)\./);
});

test('a first run publishes under the name: the signed pointer, the ledger label, the own tracker, the web seed and the snapshot URL, expiring in 399 days', async () => {
  const { options, deps, result } = await firstRun();
  const plan = planShip(options, { home: deps.home, cwd: deps.cwd });
  const summary = JSON.parse(readFileSync(join(plan.publishOut, 'summary.json'), 'utf8'));
  assert.equal(summary.scope, NAME);
  assert.equal(summary.expires, '2027-11-23');
  assert.equal(result.btih, summary.btih);
  assert.equal(result.ledgerId, summary.ledgerId);
  const parsed = parsePointer(summary.pointer);
  assert.equal(parsed.ok, true);
  const rec = parsed.record;
  assert.equal(rec.chain, 'my-site');
  assert.deepEqual(rec.tr, ['wss://' + NAME + '/tracker']);
  assert.deepEqual(rec.ws, ['https://' + NAME + '/ws/']);
  assert.deepEqual(rec.xs, ['https://' + NAME + '/ws/my-site.torrent']);
  assert.equal(rec.cs, 'https://' + NAME + '/ws/genesis.json');
  assert.equal(rec.ct, CT);
  assert.equal((await verifyPointer(rec, NAME, { now: NOW })).ok, true);
  assert.equal(rec.exp, Math.floor(NOW / 1000) + 399 * 86400);
  // a warning that is only a DNS size budget is not printed for a name that cannot carry DNS; the one-line replacement is
  assert.ok(result.warnings.includes('This name cannot carry a DNS record; the page tag is the only pointer (expires 2027-11-23).'), result.warnings.join('\n'));
  assert.equal(result.warnings.some((m) => /has not been checked: after uploading/.test(m)), false, 'check-site does that check; ship does not repeat the advice');
});

test('the deploy tree: the loader at the root without _headers, the web seed under ws/, the allow list with both swarms; nothing else', async () => {
  const { options, deps } = await firstRun();
  const plan = planShip(options, { home: deps.home, cwd: deps.cwd });
  const files = listTree(plan.siteTree);
  assert.ok(files.includes('index.html') && files.includes('404.html') && files.includes('mw-sw.js') && files.includes('_mw/boot.js'));
  assert.equal(files.includes('_headers'), false, 'a Netlify-style _headers file means nothing to Caddy (the Caddyfile sets the headers)');
  assert.ok(files.includes('ws/my-site.torrent') && files.includes('ws/genesis.json'));
  assert.ok(files.includes('ws/my-site/index.html') && files.includes('ws/my-site/css/app.css'));
  assert.ok(files.includes('ws/my-site/.mw/site.json') && files.includes('ws/my-site/.mw/files.json'), 'the dot paths inside the torrent are part of the web seed');
  assert.deepEqual(files.filter((f) => !f.startsWith('ws/') && !f.startsWith('_mw/')).sort(), ['404.html', 'index.html', 'mw-sw-kill.js', 'mw-sw.js']);
  assert.equal(readFileSync(join(plan.siteTree, 'index.html'), 'utf8').includes('name="mw-pointer"'), true, 'the shell carries the signed pointer');
  const summary = JSON.parse(readFileSync(join(plan.publishOut, 'summary.json'), 'utf8'));
  assert.equal(readFileSync(join(plan.allowDir, 'allow.txt'), 'utf8'),
    '# the site and its ledger swarm: the only infohashes the tracker serves\n' + summary.btih + '  # my-site\n' + summary.rendezvousBtih + '  # its ledger\n');
  assert.deepEqual(listTree(plan.allowDir), ['allow.txt']);
  const web = readFileSync(join(plan.siteTree, 'ws', 'my-site.torrent'));
  assert.deepEqual(web, readFileSync(join(plan.publishOut, 'site.torrent')));
});

test('the owner key stays on this computer: it is not in the deploy tree, not on any command line, and not in anything rsync is asked to copy', async () => {
  const { w, options, deps } = await firstRun();
  const plan = planShip(options, { home: deps.home, cwd: deps.cwd });
  assert.equal(existsSync(plan.key), true);
  assert.equal(statSync(plan.key).mode & 0o777, 0o600);
  const jwk = JSON.parse(readFileSync(plan.key, 'utf8'));
  assert.ok(typeof jwk.d === 'string' && jwk.d.length > 20);
  // the sources rsync copies: the site tree, the allow directory and the .env file, nothing else
  const sources = w.rsyncs.map((a) => a[a.length - 2]);
  assert.deepEqual(sources, [plan.siteTree + '/ws/', plan.allowDir + '/', plan.siteTree + '/', join(plan.deployRoot, '.env'), join(plan.deployRoot, '.env')]);
  for (const call of w.calls) {
    for (const arg of call.args) {
      assert.equal(arg.includes(plan.key), false, 'the key path is not an argument: ' + arg);
      assert.equal(arg.includes(jwk.d), false, 'the private scalar is not an argument');
    }
  }
  // no file in what was copied holds the private scalar (the search that ship runs itself, run again here from outside)
  assert.deepEqual(findKeyLeaks([plan.siteTree, plan.allowDir, join(plan.deployRoot)], jwk), []);
  assert.equal(readFileSync(join(plan.deployRoot, '.env'), 'utf8').includes(jwk.d), false);
  // the key is outside the site folder, the publish output and the deploy tree
  assert.equal(plan.key.startsWith(plan.out), false);
  assert.equal(plan.key.startsWith(plan.dir), false);
});

test('a key that ends up in the deploy tree stops the run before anything is sent', async () => {
  const w = world();
  const options = baseOptions();
  const leaky = async (o) => {
    const res = await (await import('../../tools/publish.mjs')).publish(o);
    const jwk = JSON.parse(readFileSync(o.key, 'utf8'));
    writeFileSync(join(o.out, 'shell', 'notes.txt'), 'backup of d: ' + jwk.d + '\n');
    return res;
  };
  await assert.rejects(ship(options, w.deps({ publish: leaky })), (e) => e instanceof ToolError && /the owner key is inside the deploy tree[\s\S]*notes\.txt/.test(e.message));
  assert.equal(w.rsyncs.length, 0, 'nothing was sent');
  assert.ok(w.calls.every((c) => c.file === 'ssh' && !/\bmkdir\b|\bup\b/.test(c.args.join(' '))), 'the server was only looked at, nothing was made there or started');
});

test('findKeyLeaks and assembleOneBox as functions', () => {
  const root = fresh('tree');
  writeTree(root, { 'a.txt': 'nothing here', 'sub/b.txt': 'the scalar is SECRETSECRETSECRETSECRET123 inside', 'big.bin': 'x' });
  assert.deepEqual(findKeyLeaks([root], { d: 'SECRETSECRETSECRETSECRET123' }), [join(root, 'sub/b.txt')]);
  assert.deepEqual(findKeyLeaks([root], { d: 'short' }), [], 'a short value is not searched for (it would match anything)');
  assert.deepEqual(findKeyLeaks([root], {}), []);
  assert.deepEqual(findKeyLeaks([root], null), []);
  const pubOut = fresh('publish');
  writeTree(pubOut, { 'shell/index.html': 'x', 'shell/_headers': '/*', 'shell/_mw/boot.js': 'b', 'site-name/index.html': 'i', 'site-name/.mw/files.json': '{}', 'site-name.torrent': 't', 'genesis.json': '[]' });
  const siteTree = join(fresh('one-box'), 'site');
  const allowDir = join(dirname(siteTree), 'allow');
  writeTree(siteTree, { 'stale.txt': 'left over from an earlier run' });
  const res = assembleOneBox({ publishOut: pubOut, siteTree, allowDir, siteName: 'site-name', summary: { btih: 'a'.repeat(40), rendezvousBtih: 'b'.repeat(40) } });
  assert.deepEqual(listTree(siteTree), ['_mw/boot.js', 'index.html', 'ws/genesis.json', 'ws/site-name.torrent', 'ws/site-name/.mw/files.json', 'ws/site-name/index.html'], 'the stale file is gone, _headers is left out');
  assert.equal(res.files, 6);
  assert.match(res.allow, /^# .*\n(a{40}) {2}# site-name\n(b{40}) {2}# its ledger\n$/);
  // files 644 and directories 755 whatever the umask: rsync -p carries them to the server, where the containers read them
  const modeOf = (p) => statSync(p).mode & 0o777;
  assert.equal(modeOf(siteTree), 0o755);
  assert.equal(modeOf(join(siteTree, 'ws')), 0o755);
  assert.equal(modeOf(join(siteTree, 'ws', 'site-name', '.mw')), 0o755);
  assert.equal(modeOf(join(siteTree, 'index.html')), 0o644);
  assert.equal(modeOf(join(siteTree, 'ws', 'site-name', '.mw', 'files.json')), 0o644);
  assert.equal(modeOf(allowDir), 0o755);
  assert.equal(modeOf(join(allowDir, 'allow.txt')), 0o644);
});

// ---------------------------------------------------------------------------------------------- the key

test('a second run reuses the owner key (and says so); a key other users can read is refused with the chmod to run', async () => {
  const keys = fresh('keys');
  const keyFile = join(keys, 'owner.jwk');
  const first = world();
  await ship(baseOptions({ key: keyFile }), first.deps());
  assert.equal(existsSync(keyFile), true);
  const before = readFileSync(keyFile, 'utf8');
  const again = world();
  let made = 0;
  const result = await ship(baseOptions({ key: keyFile }), again.deps({ keygen: async () => { made++; throw new Error('must not make a key'); } }));
  assert.equal(made, 0);
  assert.equal(result.keyCreated, false);
  assert.equal(readFileSync(keyFile, 'utf8'), before, 'the key file is untouched');
  assert.match(again.lines.join('\n'), /Owner key: .*owner\.jwk \(reused, fingerprint [0-9a-f]{8}\)\. It stays on this computer\./);
  chmodSync(keyFile, 0o644);
  const strict = world();
  await assert.rejects(ship(baseOptions({ key: keyFile }), strict.deps()), (e) => e instanceof ToolError && /readable or writable by group or others[\s\S]*chmod 600/.test(e.message));
  assert.equal(strict.rsyncs.length, 0, 'nothing was sent');
  assert.ok(strict.calls.every((c) => c.file === 'ssh' && !/\bmkdir\b|\bup\b/.test(c.args.join(' '))), 'the server was only looked at');
});

test('the key is made in a directory of mode 700 when its folder is new, with mode 600, and the report says to back it up', async () => {
  const home = fresh('home');
  const w = world({ home });
  await ship(baseOptions(), w.deps({ home }));
  const dir = join(home, '.config', 'magnet-web');
  assert.equal(statSync(join(dir, 'my-site.jwk')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o077, 0, 'the folder made for the key is closed to others (when it was made here)');
  assert.match(w.lines.join('\n'), /Owner key: made .*my-site\.jwk \(mode 600, fingerprint [0-9a-f]{8}\)\. It stays on this computer\. Back it up/);
});

// ---------------------------------------------------------------------------------------------- the name

test('nip.io answers the block page: Z4 for it, then sslip.io is used for the pointer, the strings and every URL', async () => {
  const resolve4 = dns({ [NAME]: ['64.176.22.9'], [SSLIP]: [IP] });
  const { w, options, deps, result } = await firstRun({}, { deps: { resolve4 } });
  assert.deepEqual(resolve4.asked, [NAME, SSLIP]);
  assert.equal(result.name, SSLIP);
  assert.equal(result.suffix, 'sslip.io');
  const text = w.lines.join('\n');
  assert.ok(text.includes('203-0-113-7.nip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Try 203-0-113-7.sslip.io, use another server, or use a domain you own.'), 'string Z4 as written');
  assert.match(text, /Using 203-0-113-7\.sslip\.io instead\./);
  assert.ok(text.includes(Z1(SSLIP)) && text.includes(Z3('sslip.io')));
  assert.equal(text.includes(Z1(NAME)), false);
  const plan = planShip(options, { home: deps.home, cwd: deps.cwd });
  const summary = JSON.parse(readFileSync(join(plan.publishOut, 'summary.json'), 'utf8'));
  assert.equal(summary.scope, SSLIP);
  assert.deepEqual(parsePointer(summary.pointer).record.tr, ['wss://' + SSLIP + '/tracker']);
  assert.equal(w.env, 'LW_SITE=' + SSLIP + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n');
  assert.deepEqual(w.probes.map((p) => p.servername), [SSLIP, SSLIP, SSLIP, SSLIP]);
  assert.deepEqual(w.checked.map((c) => c.url), ['https://' + SSLIP + '/']);
});

test('another address from nip.io (a filtering resolver) is not the block page: the text says what was seen and sslip.io is tried', async () => {
  const resolve4 = dns({ [NAME]: ['198.51.100.9'], [SSLIP]: [IP] });
  const { w, result } = await firstRun({}, { deps: { resolve4 } });
  assert.equal(result.name, SSLIP);
  const text = w.lines.join('\n');
  assert.match(text, /203-0-113-7\.nip\.io points to 198\.51\.100\.9, not to 203\.0\.113\.7\. A resolver between this computer and the service may be changing the answer\. Try 203-0-113-7\.sslip\.io/);
  assert.equal(/phishing/.test(text), false, 'only the block page is said to come from the service');
});

test('both names blocked: the run stops with Z4 for both, and nothing was made, published or sent', async () => {
  const w = world();
  const home = fresh('home');
  const cwd = fresh('cwd');
  const resolve4 = dns({ [NAME]: ['64.176.22.9'], [SSLIP]: ['64.176.22.9'] });
  await assert.rejects(ship(baseOptions(), w.deps({ resolve4, home, cwd })), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /no name for 203\.0\.113\.7 works: 203-0-113-7\.nip\.io \(blocked\), 203-0-113-7\.sslip\.io \(blocked\)\. Nothing was published or sent\./);
    return true;
  });
  const text = w.lines.join('\n');
  assert.ok(text.includes('203-0-113-7.nip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Try 203-0-113-7.sslip.io, use another server, or use a domain you own.'));
  assert.ok(text.includes('203-0-113-7.sslip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Use another server, or use a domain you own.'), 'the last service has no other to suggest');
  assert.equal(w.calls.length, 0);
  assert.equal(existsSync(join(cwd, 'dist-ship')), false);
  assert.equal(existsSync(join(home, '.config')), false, 'no key was made for a name that cannot work');
});

test('--suffix pins one service: the other is never asked, and a blocked name stops the run', async () => {
  const resolve4 = dns({ [NAME]: [IP], [SSLIP]: [IP] });
  const w = world();
  const result = await ship(baseOptions({ suffix: 'sslip.io' }), w.deps({ resolve4 }));
  assert.deepEqual(resolve4.asked, [SSLIP]);
  assert.equal(result.name, SSLIP);
  const blocked = dns({ [NAME]: ['64.176.22.9'], [SSLIP]: [IP] });
  const w2 = world();
  await assert.rejects(ship(baseOptions({ suffix: 'nip.io' }), w2.deps({ resolve4: blocked })), /no name for 203\.0\.113\.7 works: 203-0-113-7\.nip\.io \(blocked\)/);
  assert.deepEqual(blocked.asked, [NAME], 'no fallback when the service was chosen');
  assert.ok(w2.lines.join('\n').includes('Use another server, or use a domain you own.'));
});

// ---------------------------------------------------------------------------------------------- the server and the certificates

test('--staging-only stops on the staging certificate: no production .env, no restart, no check-site; Z6 is still printed', async () => {
  const { w, result, deps } = await firstRun({}, { options: { stagingOnly: true } });
  assert.equal(result.certificate, 'staging');
  assert.equal(result.checked, false);
  assert.equal(w.env, 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_STAGING + '\n');
  assert.equal(w.calls.filter((c) => c.file === 'ssh' && c.args.includes('up')).length, 1);
  assert.equal(w.checked.length, 0);
  assert.deepEqual(w.probes.map((p) => p.verify), [false, false]);
  const text = w.lines.join('\n');
  assert.match(text, /Stopped on the staging certificate, as --staging-only asks\. Browsers do not trust it\. Run the same command without --staging-only to switch to production\./);
  assert.ok(text.includes(Z6('2027-11-23')));
  assert.equal(/Production certificate/.test(text), false);
  assert.ok(deps);
});

test('the staging certificate never arrives: Z5 as written, the staging box is left running, production was never asked for', async () => {
  const w = world({ neverIssue: true });
  await assert.rejects(ship(baseOptions(), w.deps({ certAttempts: 4 })), (e) => {
    assert.ok(e instanceof ToolError);
    assert.ok(e.message.startsWith(Z5), e.message);
    assert.match(e.message, /answered port 443 with: connect ECONNREFUSED 203\.0\.113\.7:443/);
    assert.match(e.message, /run the same command again/);
    return true;
  });
  assert.equal(w.probes.length, 4, 'one probe per attempt');
  assert.equal(w.sleeps, 3, 'a wait between attempts, none after the last');
  assert.equal(w.env, 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_STAGING + '\n', 'production was not switched on');
  assert.equal(w.checked.length, 0);
});

test('production certificate never trusted (rate limit, say): the message says the box is reachable and points at the duplicate limit and the logs', async () => {
  const w = world({ productionNeverTrusted: true });
  await assert.rejects(ship(baseOptions(), w.deps({ certAttempts: 3 })), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /^The staging certificate worked, so the server is reachable, but no trusted production certificate arrived \(unable to verify the first certificate\)\./);
    assert.match(e.message, /5 duplicate certificates a week for the same names \(S2 F5\)/);
    assert.match(e.message, /keep its caddy_data volume/);
    assert.match(e.message, /ssh root@203\.0\.113\.7 docker compose -f \/opt\/felinar\/deploy\/one-box\/docker-compose\.yml logs caddy/);
    return true;
  });
  assert.equal(w.checked.length, 0);
});

// An update needs the work directory of the first run (it holds the ledger's first block), so these tests run twice against one work directory:
// a first run on a server with nothing on it, then the same arguments against a server whose .env says what the first run left.
async function firstThenAgain(second) {
  const home = fresh('home');
  const cwd = fresh('cwd');
  const options = baseOptions();
  const first = world({ home, cwd });
  await ship(options, first.deps());
  const again = world(Object.assign({ home, cwd }, second));
  return { home, cwd, options, first, again };
}

test('an update (same name, production in .env): only the files are sent, the snapshot on the server is kept, no staging, no restart, check-site runs', async () => {
  const env = 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\nPIN_MONTH_CAP=5\n';
  const { options, home, cwd, again: w } = await firstThenAgain({ env });
  w.activeCa = ACME_PRODUCTION; // the box is already running with its certificate
  w.probeFailures = 0;
  const genesisBefore = readFileSync(join(cwd, 'dist-ship', 'my-site', 'publish', 'genesis.json'), 'utf8');
  const result = await ship(options, w.deps({ home, cwd }));
  assert.equal(result.state, 'live');
  assert.equal(result.certificate, 'production');
  assert.equal(w.env, env, 'the server\'s .env is not rewritten');
  assert.equal(w.rsyncs.length, 3, 'the web seed, the allow list and the loader; no .env');
  assert.ok(w.rsyncs[0].includes('--exclude=/genesis.json'), 'the web seed is sent without the snapshot the server holds');
  assert.ok(w.rsyncs[1].includes('--delete') && /\/allow\/$/.test(w.rsyncs[1][w.rsyncs[1].length - 1]));
  assert.ok(w.rsyncs[2].includes('--exclude=/ws/'));
  const ups = w.calls.filter((c) => c.file === 'ssh' && c.args.includes('up'));
  assert.equal(ups.length, 1);
  assert.equal(ups[0].args.includes('--build'), false, 'no rebuild, no restart of a working box');
  assert.deepEqual(w.probes.map((p) => p.verify), [true]);
  assert.deepEqual(w.checked.map((c) => c.url), ['https://' + NAME + '/']);
  const text = w.lines.join('\n');
  assert.match(text, /This server already serves 203-0-113-7\.nip\.io with a production certificate: an update, so only the files are sent\./);
  assert.equal(/Staging certificate/.test(text), false);
  assert.equal(readFileSync(join(cwd, 'dist-ship', 'my-site', 'publish', 'genesis.json'), 'utf8'), genesisBefore, 'the ledger\'s first block was reused, not minted again');
  const first = JSON.parse(readFileSync(join(cwd, 'dist-ship', 'my-site', 'publish', 'summary.json'), 'utf8'));
  assert.equal(first.gen, JSON.parse(genesisBefore)[0].h);
});

test('an update without the work directory of the first run stops before anything is made: a new first block is a new ledger (--new-ledger says it is meant)', async () => {
  const env = 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n';
  const home = fresh('home');
  const cwd = fresh('cwd');
  const w = world({ env, home, cwd });
  await assert.rejects(ship(baseOptions(), w.deps({ home, cwd })), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /this server already serves 203-0-113-7\.nip\.io, but .*genesis\.json, the ledger's first block from the earlier publish, is not here\./);
    assert.match(e.message, /a new ledger, with none of the posts visitors already hold/);
    assert.match(e.message, /Put the earlier work directory back \(--out\), or pass --new-ledger to start a new ledger on purpose\. Nothing was made, published or sent\./);
    return true;
  });
  assert.equal(existsSync(join(cwd, 'dist-ship')), false);
  assert.equal(existsSync(join(home, '.config')), false, 'no key was made');
  assert.equal(w.rsyncs.length, 0);
  assert.equal(w.dirs, undefined);
  // a run that stopped on staging is guarded the same way
  const staged = world({ env: 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_STAGING + '\n', home, cwd });
  await assert.rejects(ship(baseOptions(), staged.deps({ home, cwd })), /first block from the earlier publish, is not here/);
  // on purpose
  const chosen = world({ env, home, cwd });
  chosen.activeCa = ACME_PRODUCTION;
  chosen.probeFailures = 0;
  const result = await ship(baseOptions({ newLedger: true }), chosen.deps({ home, cwd }));
  assert.equal(result.state, 'live');
  assert.equal(existsSync(join(cwd, 'dist-ship', 'my-site', 'publish', 'genesis.json')), true);
  // a first run or a replaced server is never guarded: there is no earlier ledger to keep
  const fresh1 = world({ home: fresh('home'), cwd: fresh('cwd') });
  await ship(baseOptions(), fresh1.deps({ home: fresh1.home, cwd: fresh1.cwd }));
});

test('a run that stopped on staging is continued: the .env is not rewritten for staging, the box starts, then production', async () => {
  const { options, home, cwd, first, again: w } = await firstThenAgain({ env: 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_STAGING + '\n' });
  assert.ok(first.env.includes(ACME_PRODUCTION));
  const result = await ship(options, w.deps({ home, cwd }));
  assert.equal(result.state, 'staging');
  assert.equal(result.certificate, 'production');
  assert.equal(w.rsyncs.filter((a) => /\.env$/.test(a[a.length - 1])).length, 1, 'only the production .env is sent');
  assert.equal(w.env, 'LW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n');
  assert.equal(w.rsyncs[0].includes('--exclude=/genesis.json'), false, 'the snapshot is still the first one');
  assert.match(w.lines.join('\n'), /This server was started for 203-0-113-7\.nip\.io on the staging directory by an earlier run: continuing to production\./);
});

test('a server set up for another name is replaced, and the run says so; other lines of its .env are kept', async () => {
  const env = '# mine\nLW_SITE=198-51-100-9.nip.io\nLW_ACME_CA=' + ACME_PRODUCTION + '\nPIN_MONTH_CAP=5\n';
  const w = world({ env });
  const result = await ship(baseOptions(), w.deps());
  assert.equal(result.state, 'replace');
  assert.match(w.lines.join('\n'), /This server was set up for 198-51-100-9\.nip\.io\. One box serves one site, so 203-0-113-7\.nip\.io replaces it: the loader files are replaced, and visitors of the old address start again\. Its web seed files stay until you delete them\./);
  assert.equal(w.env, '# mine\nPIN_MONTH_CAP=5\nLW_SITE=' + NAME + '\nLW_ACME_CA=' + ACME_PRODUCTION + '\n');
  assert.equal(result.certificate, 'production');
});

test('a server without the clone, with an old Compose, with Docker missing or unreachable over ssh: each stops with what to do, before anything is sent', async () => {
  const noBox = world({ composeFile: false });
  await assert.rejects(ship(baseOptions(), noBox.deps()), (e) => {
    assert.match(e.message, /finding \/opt\/felinar\/deploy\/one-box\/docker-compose\.yml failed on root@203\.0\.113\.7 \(exit 1\)/);
    assert.match(e.message, /On the server: git clone --branch v\d+\.\d+\.\d+ --depth 1 https:\/\/github\.com\/[A-Za-z0-9_.-]+\/felinar\.git \/opt\/felinar \(a release tag; compare git -C \/opt\/felinar rev-parse HEAD with the release notes\) and install Docker with Compose 2\.17 or newer\./);
    return true;
  });
  assert.equal(noBox.rsyncs.length, 0);
  const noRsync = world({ noRsyncThere: true });
  await assert.rejects(ship(baseOptions(), noRsync.deps()), /finding rsync failed on root@203\.0\.113\.7 \(exit 1\)\. rsync must be installed on the server too \(for example: apt install rsync\)\./);
  const old = world({ composeVersion: '2.16.0' });
  await assert.rejects(ship(baseOptions(), old.deps()), /the server has Docker Compose 2\.16\.0, and ship needs 2\.17 or newer \(for --wait-timeout\)/);
  const noDocker = world({ composeFails: true });
  await assert.rejects(ship(baseOptions(), noDocker.deps()), /running "docker compose version" failed on root@203\.0\.113\.7 \(exit 127\)\. Install Docker with the Compose plugin on the server\./);
  const unreachable = world({ sshCode: 255 });
  await assert.rejects(ship(baseOptions({ to: 'ssh://root@' + IP + ':2222' }), unreachable.deps()), /ssh could not reach root@203\.0\.113\.7 on port 2222 \(exit 255; the reason is printed above\)/);
  for (const w of [noBox, noRsync, old, noDocker, unreachable]) {
    assert.equal(w.rsyncs.length, 0, 'nothing sent');
    assert.equal(w.dirs, undefined, 'nothing made on the server');
  }
});

test('a server that cannot be used leaves nothing behind on this computer either: no key, no work directory, nothing published', async () => {
  const home = fresh('home');
  const cwd = fresh('cwd');
  for (const opts of [{ composeFile: false }, { noRsyncThere: true }, { composeVersion: '2.1.0' }, { sshCode: 255 }]) {
    const w = world(Object.assign({ home, cwd }, opts));
    await assert.rejects(ship(baseOptions(), w.deps({ home, cwd })), ToolError);
  }
  assert.equal(existsSync(join(cwd, 'dist-ship')), false);
  assert.equal(existsSync(join(home, '.config')), false);
});

test('rsync, mkdir, compose and check-site failures are reported with the step that failed, and a failed web seed send keeps the loader from being sent', async () => {
  const rsyncFail = world({ rsyncFails: (a) => /\/site\/ws\/$/.test(a[a.length - 1]) });
  await assert.rejects(ship(baseOptions(), rsyncFail.deps()), /rsync of the web seed failed on root@203\.0\.113\.7 \(exit 23\)/);
  assert.equal(rsyncFail.rsyncs.length, 1, 'the allow list and the loader (with the new pointer) were not sent after a failed web seed');
  const shellFail = world({ rsyncFails: (a) => /\/site\/$/.test(a[a.length - 1]) });
  await assert.rejects(ship(baseOptions(), shellFail.deps()), /rsync of the loader failed/);
  const mkdirFail = world({ mkdirFails: true });
  await assert.rejects(ship(baseOptions(), mkdirFail.deps()), /making \/opt\/felinar\/deploy\/one-box\/site\/ws and \/allow failed on root@203\.0\.113\.7 \(exit 1\)/);
  assert.equal(mkdirFail.rsyncs.length, 0);
  const upFail = world({ upFails: true });
  await assert.rejects(ship(baseOptions(), upFail.deps()), (e) => /docker compose up failed on root@203\.0\.113\.7 \(exit 1\)\. Look at the server's logs: ssh root@203\.0\.113\.7 docker compose -f \/opt\/felinar\/deploy\/one-box\/docker-compose\.yml logs/.test(e.message));
  const checkFail = world({ checkFails: true });
  await assert.rejects(ship(baseOptions(), checkFail.deps()), /check-site found 2 failure\(s\) at https:\/\/203-0-113-7\.nip\.io\/ \(the site is on the server;/);
  assert.match(checkFail.lines.join('\n'), /FAILED: 2 failure\(s\), 0 warning\(s\)\./);
});

test('a loader that is not built stops a real run before anything else', async () => {
  const w = world();
  await assert.rejects(ship(baseOptions({ dist: join(fresh('none'), 'dist') }), w.deps()), (e) => e instanceof ToolError && /ship needs the built loader in .*dist[\s\S]*npm run build/.test(e.message));
  assert.equal(w.calls.length, 0);
  assert.equal(w.lines.length, 0);
});

test('the injectable steps may also be given among the options (INTERFACES: ship({ ip, to, ct, ..., exec, ssh, rsync, resolve, now })), resolve is resolve4, now may be a number', async () => {
  const w = world();
  const resolve = dns({ [NAME]: ['64.176.22.9'], [SSLIP]: [IP] });
  const base = w.deps();
  const result = await ship(baseOptions({
    exec: w.exec, resolve, now: NOW, probeCertificate: w.probeCertificate, checkSite: w.checkSite, sleep: base.sleep, log: base.log, warn: base.warn, home: base.home, cwd: base.cwd,
    localCommit: base.localCommit,
  }));
  assert.equal(result.name, SSLIP, 'resolve answered the block page for nip.io');
  assert.deepEqual(resolve.asked, [NAME, SSLIP]);
  assert.equal(result.expires, '2027-11-23', 'now was the number 1792497630000');
  assert.ok(w.calls.length > 0, 'exec was used');
  // the second argument wins over the options
  const w2 = world();
  const seen = [];
  await ship(baseOptions({ exec: async () => { throw new Error('the option must lose'); }, dryRun: false }), w2.deps({ exec: async (file, args, o) => { seen.push(file); return w2.exec(file, args, o); } }));
  assert.ok(seen.length > 0);
});

test('the ssh and rsync dependencies replace exec for their own commands', async () => {
  const w = world();
  const seen = [];
  const deps = w.deps({
    ssh: async (argv, o) => { seen.push(['ssh', argv[0]]); return w.exec(argv[0], argv.slice(1), o); },
    rsync: async (argv, o) => { seen.push(['rsync', argv[0]]); return w.exec(argv[0], argv.slice(1), o); },
  });
  await ship(baseOptions(), deps);
  assert.equal(seen.filter((s) => s[0] === 'ssh').length, 8, 'with git rev-parse HEAD (SUP-9)');
  assert.equal(seen.filter((s) => s[0] === 'rsync').length, 5);
  assert.ok(seen.every((s) => s[0] === s[1]));
});

// ---------------------------------------------------------------------------------------------- a real rsync, locally

test('the rsync arguments work with the rsync of this computer, in the deploy order: the web seed is added to, the loader is pruned, ws/ is left alone (a local copy; skipped without rsync)', (t) => {
  if (spawnSync('rsync', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('rsync is not installed');
    return;
  }
  const plan = planShip({ dir: makeSite(), ip: IP, to: 'ssh://root@' + IP, ct: CT }, { home: fresh('h'), cwd: fresh('c') });
  writeTree(plan.siteTree, { 'index.html': 'new page', 'mw-sw.js': '// new worker', 'ws/my-site/a.txt': 'a', 'ws/genesis.json': '[first block]' });
  writeTree(plan.allowDir, { 'allow.txt': 'abcdef  # the new swarm' });
  chmodTree(plan.siteTree);
  chmodTree(plan.allowDir);
  // the server's side: an earlier version, a snapshot a pin refreshed, the pin's heartbeat, the web seed of an older name, a file the loader no longer has
  const box = fresh('server-box');
  writeTree(box, {
    'site/index.html': 'old', 'site/stale.html': 'gone soon', 'site/ws/genesis.json': '[first block, a later block]', 'site/ws/pin-status.json': '{"heartbeat":1}',
    'site/ws/old-site/x.txt': 'x', 'site/ws/my-site/removed-in-this-version.txt': 'still needed by visitors on the previous version', 'allow/allow.txt': 'old', 'allow/stale': 's',
  });
  const cmds = commandsFor(plan);
  // the commands name user@host:path; for a local copy the remote shell goes and the destination becomes a folder of the fake server
  const local = (argv, dest) => {
    const rest = argv.slice(1);
    rest.splice(rest.indexOf('-e'), 2);
    rest[rest.length - 1] = dest;
    return rest;
  };
  const run = (argv, dest) => {
    const r = spawnSync('rsync', local(argv, dest), { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  // 1. an update: the web seed first
  run(cmds.rsyncWeb(true), join(box, 'site', 'ws') + '/');
  assert.equal(readFileSync(join(box, 'site/ws/genesis.json'), 'utf8'), '[first block, a later block]', 'the update keeps the snapshot the server holds');
  assert.equal(readFileSync(join(box, 'site/ws/pin-status.json'), 'utf8'), '{"heartbeat":1}', 'and the pin\'s heartbeat');
  assert.equal(readFileSync(join(box, 'site/ws/my-site/a.txt'), 'utf8'), 'a');
  assert.ok(existsSync(join(box, 'site/ws/my-site/removed-in-this-version.txt')), 'the web seed is never pruned: visitors on the previous version still need its files');
  assert.ok(existsSync(join(box, 'site/ws/old-site/x.txt')));
  assert.equal(readFileSync(join(box, 'site/index.html'), 'utf8'), 'old', 'the loader with the new pointer comes last');
  // 2. the allow list, 3. the loader
  run(cmds.rsyncAllow, join(box, 'allow') + '/');
  assert.deepEqual(listTree(join(box, 'allow')), ['allow.txt'], 'the allow directory is replaced');
  assert.equal(readFileSync(join(box, 'allow/allow.txt'), 'utf8'), 'abcdef  # the new swarm');
  run(cmds.rsyncShell, join(box, 'site') + '/');
  assert.equal(readFileSync(join(box, 'site/index.html'), 'utf8'), 'new page');
  assert.equal(existsSync(join(box, 'site/stale.html')), false, 'the loader\'s old files are pruned');
  assert.ok(existsSync(join(box, 'site/ws/pin-status.json')) && existsSync(join(box, 'site/ws/old-site/x.txt')), 'and ws/ is left alone');
  assert.equal(readFileSync(join(box, 'site/ws/genesis.json'), 'utf8'), '[first block, a later block]');
  assert.equal(statSync(join(box, 'site/index.html')).mode & 0o777, 0o644, 'the modes made before the copy arrive as they are (-p)');
  assert.equal(statSync(join(box, 'site/ws')).mode & 0o777, 0o755);
  // a first send puts the first snapshot in place
  run(cmds.rsyncWeb(false), join(box, 'site', 'ws') + '/');
  assert.equal(readFileSync(join(box, 'site/ws/genesis.json'), 'utf8'), '[first block]');
  assert.equal(readFileSync(join(box, 'site/ws/pin-status.json'), 'utf8'), '{"heartbeat":1}');
});

// ---------------------------------------------------------------------------------------------- the command line

const BIN = join(ROOT, 'tools', 'ship.mjs');
function cli(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000, ...opts });
}

test('command line: --help names every flag; usage errors exit 2 and print the usage; --dry-run exits 0 and creates nothing', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  for (const flag of Object.keys(SHIP_FLAGS)) assert.ok(help.stdout.includes('--' + flag), '--help names --' + flag);
  assert.match(help.stdout, /Docker with Compose\s+2\.17 or newer/);
  assert.equal(cli([]).status, 2);
  const noTo = cli([makeSite(), '--ip', IP, '--ct', CT]);
  assert.equal(noTo.status, 2);
  assert.match(noTo.stderr, /missing --to ssh:\/\/user@host/);
  assert.match(noTo.stderr, /Usage: node tools\/ship\.mjs/);
  const noCt = cli([makeSite(), '--ip', IP, '--to', 'ssh://root@' + IP]);
  assert.equal(noCt.status, 2);
  assert.match(noCt.stderr, /missing --ct/);
  assert.equal(cli([makeSite(), '--ip', '192.168.1.20', '--to', 'ssh://root@192.168.1.20', '--ct', CT]).status, 2);
  assert.equal(cli([makeSite(), '--bogus']).status, 2);
  assert.equal(cli([makeSite(), makeSite(), '--ip', IP]).status, 2, 'exactly one site folder');
  const out = fresh('cli-out');
  const keyFile = join(fresh('cli-keys'), 'owner.jwk');
  const dry = cli([makeSite(), '--ip', IP, '--to', 'ssh://root@' + IP, '--ct', CT, '--dry-run', '--out', out, '--key', keyFile]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /felinar ship \(dry run\)/);
  assert.ok(dry.stdout.includes(Z1(NAME)));
  assert.equal(existsSync(join(out, 'publish')), false, 'a dry run writes nothing');
  assert.equal(existsSync(keyFile), false);
});

test('wording: ship and name-check, and everything a run prints, use none of the words the project does not use and no en or em dash or curly quote', async () => {
  const bannedWords = ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready', 'fully decentralized'];
  const dashesOrCurly = /[–—‘’“”]/;
  for (const file of ['tools/ship.mjs', 'tools/name-check.mjs']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const word of bannedWords) assert.equal(source.toLowerCase().includes(word), false, file + ': ' + word);
    assert.equal(dashesOrCurly.test(source), false, file + ' has an en or em dash or a curly quote');
  }
  const dry = world();
  await ship(baseOptions({ dryRun: true }), dry.deps());
  const real = world();
  await ship(baseOptions(), real.deps({ resolve4: dns({ [NAME]: ['64.176.22.9'], [SSLIP]: [IP] }) }));
  for (const line of dry.lines.concat(real.lines, real.warnings)) {
    for (const word of bannedWords) assert.equal(line.toLowerCase().includes(word), false, line);
    assert.equal(dashesOrCurly.test(line), false, line);
  }
  assert.equal(ipName(IP), NAME);
});

// ---------------------------------------------------------------------------------------------- review round (SUP-5, SUP-9, SCALE-2)

async function signedRelease(dist) {
  const keyFile = join(fresh('rk'), 'release.jwk');
  const k = await keygen({ out: keyFile });
  const list = buildHashList({ dir: dist, version: '0.3.0' });
  const sig = await signList(list, await loadOwnerKey(keyFile));
  const d = fresh('rel');
  writeFileSync(join(d, 'hashes-dist.json'), JSON.stringify(list));
  writeFileSync(join(d, 'hashes-dist.json.sig'), JSON.stringify(sig));
  return { releaseList: join(d, 'hashes-dist.json'), releaseSig: join(d, 'hashes-dist.json.sig'), releaseKey: k.pub };
}

// The release key built into tools/verify-release.mjs (PINNED_RELEASE_KEYS) refuses a list signed by any other key (SUP-2, SUP-12), so a
// ship run below pins the fixture's own key (releasePinnedKeys, an internal option no flag sets), and the command line runs a copy of the
// tools with that key built in.
const PINNED_LINE = /^export const PINNED_RELEASE_KEYS = Object\.freeze\(\[(.*)\]\);$/m;
/** toolsPinnedTo(keys) -> a copy of tools/ and src/ (the module graph of tools/publish.mjs; create-torrent comes from node_modules) whose PINNED_RELEASE_KEYS line holds keys. */
function toolsPinnedTo(keys) {
  const dir = fresh('tools-pinned');
  for (const sub of ['tools', 'src']) cpSync(join(ROOT, sub), join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'felinar-tools-copy', private: true, type: 'module' }));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  const file = join(dir, 'tools', 'verify-release.mjs');
  const src = readFileSync(file, 'utf8');
  assert.match(src, PINNED_LINE, 'PINNED_RELEASE_KEYS is one line of the form step 3b writes');
  writeFileSync(file, src.replace(PINNED_LINE, () => 'export const PINNED_RELEASE_KEYS = Object.freeze(' + JSON.stringify(keys) + ');'));
  return dir;
}

test('SUP-9: a server clone at another commit stops the run before anything is published or sent; --expect-commit names the commit', async () => {
  const w = world({ remoteHead: '2'.repeat(40) });
  await assert.rejects(ship(baseOptions(), w.deps()), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /is at commit 2{40}, not 1{40} \(this checkout\)/);
    assert.match(e.message, /Nothing was published or sent/);
    return true;
  });
  assert.equal(w.rsyncs.length, 0, 'no rsync');
  assert.equal(existsSync(join(w.cwd, 'dist-ship')), false, 'nothing was published');
  // --expect-commit wins over the checkout
  const w2 = world({ remoteHead: '3'.repeat(40) });
  const ok = await ship(baseOptions({ expectCommit: '3'.repeat(40) }), w2.deps());
  assert.equal(ok.certificate, 'production');
  // tools that are not a git checkout (an installed package) must be told the commit
  const w3 = world({ localCommit: null });
  await assert.rejects(ship(baseOptions(), w3.deps()), (e) => e instanceof UsageError && /--expect-commit/.test(e.message));
  assert.equal(w3.calls.length, 0, 'nothing was contacted');
  assert.throws(() => planShip(baseOptions({ expectCommit: 'abc' }), { home: fresh('h'), cwd: fresh('c') }), UsageError);
});

test('SUP-5: ship refuses a loader that is not this checkout\'s build unless it matches the signed release list', async () => {
  const dist = fakeDist();
  const w = world();
  await assert.rejects(ship(baseOptions({ dist, allowUnverifiedLoader: false }), w.deps()), (e) => e instanceof UsageError && /--release-list/.test(e.message) && /--allow-unverified-loader/.test(e.message));
  assert.equal(w.calls.length, 0, 'nothing was contacted');
  const rel = await signedRelease(dist);
  const pinned = { releasePinnedKeys: [rel.releaseKey] }; // the fixture's key stands in for the release key built into the tools
  writeFileSync(join(dist, '_mw', 'loader.js'), '// loader, changed\n');
  const w2 = world();
  await assert.rejects(ship(baseOptions(Object.assign({ dist, allowUnverifiedLoader: false }, rel, pinned)), w2.deps()), (e) => e instanceof ToolError && /does not match the signed release list \(files\)/.test(e.message));
  assert.equal(w2.calls.length, 0);
  writeFileSync(join(dist, '_mw', 'loader.js'), '// loader\n');
  const w3 = world();
  const ok = await ship(baseOptions(Object.assign({ dist, allowUnverifiedLoader: false }, rel, pinned)), w3.deps());
  assert.equal(ok.certificate, 'production');
  assert.match(w3.lines.join('\n'), /matches the signed release list \(felinar 0\.3\.0\)/);
});

test('SUP-5: publish --shell from the command line refuses another --dist without its signed list, and a changed byte with it; nothing is written', async () => {
  const dist = fakeDist();
  const rel = await signedRelease(dist);
  writeFileSync(join(dist, '_mw', 'loader.js'), '// loader, changed\n');
  const keyFile = join(fresh('ok'), 'owner.jwk');
  await keygen({ out: keyFile });
  const outDir = join(fresh('pub'), 'out');
  const base = [join(ROOT, 'tools', 'publish.mjs'), makeSite(), '--name', 'my-site', '--scope', 'example.com', '--key', keyFile, '--tr', 'wss://t.example', '--shell', '--dist', dist, '--out', outDir, '--quiet'];
  const bare = spawnSync(process.execPath, base, { encoding: 'utf8' });
  assert.equal(bare.status, 2, bare.stderr);
  assert.match(bare.stderr, /not this checkout's own build/);
  // from a copy of the tools with the fixture's key built in, so that the refusal is the changed byte (files) and not the key
  const pinnedPublish = join(toolsPinnedTo([rel.releaseKey]), 'tools', 'publish.mjs');
  const tampered = spawnSync(process.execPath, [pinnedPublish].concat(base.slice(1), ['--release-list', rel.releaseList, '--release-sig', rel.releaseSig, '--release-key', rel.releaseKey]), { encoding: 'utf8' });
  assert.equal(tampered.status, 1, tampered.stderr);
  assert.match(tampered.stderr, /does not match the signed release list \(files\)/);
  assert.equal(existsSync(outDir), false, 'no output');
});

test('SCALE-2: the one-box allow list names the chat lane, and asks for uploads when files or media are on', () => {
  const d = fresh('ob');
  const publishOut = join(d, 'publish');
  writeTree(publishOut, { 'shell/index.html': 'x', 'my-site/index.html': 'y', 'my-site.torrent': 't', 'genesis.json': '{}' });
  const summary = { btih: 'a'.repeat(40), rendezvousBtih: 'b'.repeat(40), ledgerId: 'ledger-1', features: ['chat', 'files'] };
  const res = assembleOneBox({ publishOut, siteTree: join(d, 'site'), allowDir: join(d, 'allow'), siteName: 'my-site', summary });
  assert.match(res.allow, new RegExp(chatLaneHash('ledger-1') + ' {2}# its chat lane'));
  assert.match(res.allow, /^uploads {2}#/m);
  const plain = assembleOneBox({ publishOut, siteTree: join(d, 'site2'), allowDir: join(d, 'allow2'), siteName: 'my-site', summary: Object.assign({}, summary, { features: [] }) });
  assert.doesNotMatch(plain.allow, /uploads|chat lane/);
});
