#!/usr/bin/env node
// tools/demo.mjs: the whole system on this machine (ARCHITECTURE section 10, DESIGN-REVIEW item 22).
// It builds the loader, publishes examples/peer-guestbook/ with --policy open (so the guestbook works), starts a
// tracker and the dev server, seeds the site from a headless page, and prints what to open.
//
//   node tools/demo.mjs [--tls [--cert <file> --key <file>]] [--bind <address>] [--port 8080] [--tracker-port 8000] [--idp-port 8081]
//                       [--site examples/peer-guestbook] [--name peer-guestbook] [--lan-host <ip|name>] [--seeder browser|node|none] [--no-build]
//                       [--dir .tools/demo] [--headed] [--quiet]
//
// v0.3 verify fix round 2: writing needs a sign-in (R 2.4.1), and a site with no identity page answers every post with
// E_IDP_UNREACHABLE. The desktop tier therefore also builds the identity page (dist-idp, as npm run build:idp does) and
// serves it on its own loopback port (--idp-port, default 8081), and the pointer names it (idp=http://localhost:<port>).
// The LAN tier has no identity page: it would need a certificate of its own, so phones there read and share, and post
// through the desktop tier (adb reverse, printed).
//
// Tiers (the tool prints the one it started):
//   desktop  (default)  http://localhost:<port>/ on this computer: localhost is a secure context, so the
//                       Service Worker, WebCrypto and the ledger work: full mode.
//   LAN      (--tls)    https://<lan-ip>:<port>/ with mkcert certificates, for phones and other computers.
//                       The phone must trust the mkcert root CA; without TLS the loader stops on any
//                       non-localhost address with "This page must be served over HTTPS (or localhost)".
//                       Android can also use `adb reverse` and the desktop tier (instructions printed).
//                       v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 rung 1): the tracker listens on 127.0.0.1 only and the dev
//                       server passes WebSocket upgrades on /tracker to it (dev-server --tracker-proxy), so the phone needs one
//                       address, one port and one certificate: wss://<lan-ip>:<port>/tracker.
//
// Everything stays on this machine and its LAN: the seeder is Playwright Chromium started with
// chromiumArgs() from test/e2e/browser-args.mjs (no hostname except localhost resolves), the tracker is
// local, the pointer's web seed is the dev server. Ctrl-C stops everything.
//
// One demo key signs every site, so the browser never sees "publisher key changed" between demos. Each site
// folder gets its own ledger all the same (post-wave fix L): a chain label the demo makes up once per folder
// and remembers in <dir>/sites.json, and its own publish directory <dir>/publish/<label>/. Without it every
// localhost site had the same ledger id (one key, scope localhost, no chain), so a browser profile that used the
// guestbook showed its entries in the next demo site. Running the same folder again keeps its ledger.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import net from 'node:net';

import { build } from '../build.mjs';
import { keygen } from './keygen.mjs';
import { publish } from './publish.mjs';
import { createTracker } from './tracker.mjs';
import { createDevServer, createIdpServer } from './dev-server.mjs';
import { buildIdp } from './build-idp.mjs';
import {
  parseCli, runMain, isMain, lanAddresses, mkcertCaRoot, ROOT, ToolError, UsageError, out, warn, writeFileAtomic,
} from './lib.mjs';

const USAGE = `
Usage: node tools/demo.mjs [--tls [--cert <file> --key <file>]] [--bind <address>] [--port 8080] [--tracker-port 8000] [--idp-port 8081]
                           [--site examples/peer-guestbook] [--name peer-guestbook] [--lan-host <ip|name>] [--seeder browser|node|none] [--no-build]
                           [--dir .tools/demo] [--headed] [--quiet]

--idp-port  the loopback port of the identity page that the desktop tier serves (posting signs in there; dist-idp is built with the loader)
`;

/** String Z8 of S2 (rung 1, share on my LAN), as written there. */
export const LAN_STRING_Z8 = 'Phones run this site only over https. Trust the certificate on each phone once, or connect an Android phone by USB. ' +
  'Whoever gets the key of this local certificate authority can read the secure traffic of every phone that trusts it: keep it on this computer and remove the certificate afterwards.';

/**
 * planDemo({ tls, port, trackerPort, lanHost, lan }) → the addresses of a demo run.
 *   tier       'desktop' | 'lan'
 *   scope      the hostname the pointer is signed for (what the browser's address bar shows)
 *   bindHost   where the servers listen
 *   origin     the page origin visitors open (https for the lan tier)
 *   wsBase     the pointer's web seed, trackerUrl the pointer's tracker (desktop: its own port; lan: /tracker on the page's origin)
 *   trackerProxy  true when the dev server passes /tracker on to a tracker on 127.0.0.1:<trackerPort> (the lan tier)
 *   local      { origin, trackerUrl }: the same servers by their localhost names, for the headless seeder
 * lan: the IPv4 addresses of this machine (lanAddresses()).
 */
export function planDemo({ tls = false, port = 8080, trackerPort = 8000, lanHost = null, lan = [] } = {}) {
  if (!tls) {
    const origin = 'http://localhost:' + port;
    return {
      tier: 'desktop', tls: false, scope: 'localhost', bindHost: '127.0.0.1', origin, wsBase: origin + '/ws/', trackerUrl: 'ws://localhost:' + trackerPort,
      local: { origin, trackerUrl: 'ws://localhost:' + trackerPort }, lan,
    };
  }
  const host = lanHost || lan[0] || null;
  if (!host) throw new UsageError('--tls found no LAN address on this computer; pass --lan-host <ip or name the phone can reach>');
  const shown = host.indexOf(':') >= 0 ? '[' + host + ']' : host;
  const origin = 'https://' + shown + ':' + port;
  // v0.3 C2: the tracker is on the page's own origin at /tracker (the dev server passes it on to a tracker on 127.0.0.1:<trackerPort>).
  return {
    tier: 'lan', tls: true, scope: host, bindHost: '0.0.0.0', origin, wsBase: origin + '/ws/', trackerUrl: origin.replace(/^https/, 'wss') + '/tracker', trackerPort,
    trackerProxy: true, local: { origin: 'https://localhost:' + port, trackerUrl: 'wss://localhost:' + port + '/tracker' }, lan,
  };
}

/** The instructions the demo prints for a plan (an array of lines). idpPort: the identity page's port (the desktop tier), or null. */
export function tierText(plan, { caRoot = null, port = 8080, trackerPort = 8000, idpPort = null } = {}) {
  if (plan.tier === 'desktop') {
    const reverseIdp = idpPort ? ' && adb reverse tcp:' + idpPort + ' tcp:' + idpPort : '';
    return [
      'Tier: desktop (this computer, http://localhost): full mode.',
      '  Open ' + plan.origin + '/ in Chrome, Edge, Firefox or Safari on THIS computer (use "localhost", not 127.0.0.1: the pointer is signed for the hostname).',
      '  localhost is a secure context, so the Service Worker, WebCrypto and the ledger work. Open a second tab or a second browser to see peers and shared posts.',
      idpPort
        ? '  Posting signs in first, at the identity page http://localhost:' + idpPort + '/ (built from src/idp): create an identity there, or choose "For this visit only".'
        : '  No identity page runs, so posting asks to sign in and fails.',
      '',
      'A phone cannot use this address. http://<this computer\'s IP>:' + port + '/ is not a secure context, and the loader stops with',
      '"This page must be served over HTTPS (or localhost)". For phones run:  npm run demo -- --tls',
      'Android with USB debugging works without certificates: adb reverse tcp:' + port + ' tcp:' + port + ' && adb reverse tcp:' + trackerPort + ' tcp:' + trackerPort + reverseIdp +
        ', then open http://localhost:' + port + '/ in Chrome on the phone.',
    ];
  }
  const lines = [
    'Tier: LAN (https with mkcert certificates): phones and other computers on this network.',
    '  Open ' + plan.origin + '/ on the phone (or on this computer: ' + plan.local.origin + '/ also works but the pointer is signed for ' + plan.scope + ', so use the address above).',
    '  Tracker: ' + plan.trackerUrl + '   Web seed: ' + plan.wsBase,
    '',
  ];
  if (caRoot) {
    lines.push(
      'The phone must trust the mkcert root CA, otherwise the browser warns and the loader cannot register its Service Worker:',
      '  CA file: ' + join(caRoot, 'rootCA.pem'),
      '  iPhone/iPad: AirDrop or mail rootCA.pem to the device and open it, then Settings > General > VPN & Device Management > install the profile,',
      '               then Settings > General > About > Certificate Trust Settings > switch on full trust for the mkcert root.',
      '  Android:     Settings > Security > Encryption & credentials > Install a certificate > CA certificate (Chrome trusts user CAs;',
      '               Firefox needs about:config security.enterprise_roots.enabled = true).',
    );
  } else {
    lines.push(
      'mkcert is not installed, so there are no certificates for the phone to trust. Install it (this tool never installs software):',
      '  brew install mkcert nss && mkcert -install      then run this command again',
    );
  }
  lines.push('Without the root CA on the phone the browser shows a certificate warning, and a page that is not a secure context stops with "This page must be served over HTTPS (or localhost)".');
  lines.push('This tier runs no identity page (it would need a certificate of its own), so a post asks to sign in and fails: phones here read and share the site. To post from a phone, use the desktop tier over USB (below).');
  lines.push(
    '',
    LAN_STRING_Z8,
    'An Android phone on USB debugging needs no certificate: run  npm run demo  (without --tls; it uses ports 8080, 8000 and 8081 unless you pass others), then',
    '  adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8081 tcp:8081',
    '  and open http://localhost:8080/ in Chrome on the phone.',
    'If a phone on the network cannot open the address above, Wi-Fi client isolation (a router setting that keeps devices apart) can be the reason.',
  );
  return lines;
}

/**
 * demoSiteLabel(siteDir, demoDir) → the chain label of this site folder's ledger in the demo, for example
 * "demo-peer-guestbook-3fa2c1": made up once (the folder name and 6 random hex digits, never the path) and
 * remembered in <demoDir>/sites.json, so each folder has its own ledger and keeps it from run to run.
 */
export function demoSiteLabel(siteDir, demoDir) {
  const site = resolve(siteDir);
  const file = join(resolve(demoDir), 'sites.json');
  let known = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) known = parsed;
  } catch (_) { /* no file yet, or unreadable: start a new map */ }
  const existing = known[site];
  if (typeof existing === 'string' && /^demo-[A-Za-z0-9._-]{1,40}-[0-9a-f]{6}$/.test(existing)) return existing;
  const name = basename(site).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'site';
  const label = 'demo-' + name + '-' + randomBytes(3).toString('hex');
  known[site] = label;
  mkdirSync(resolve(demoDir), { recursive: true });
  writeFileAtomic(file, JSON.stringify(known, null, 2) + '\n');
  return label;
}

/** A currently free TCP port on 127.0.0.1 (the pointer must name the ports before the servers start). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs, stepMs = 400) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * runDemo(options) → { plan, url, publishResult, chain, tracker, dev, idp: { origin, port, root } | null, seeder: 'browser'|'node'|'none', stop() }
 * options: see the command line; `log(line)` receives the output. idpPort 0 (the default) takes a free port; idpDist defaults to
 * dist-idp next to dist; idp: false serves no identity page.
 */
export async function runDemo(options = {}) {
  const o = Object.assign({
    tls: false, cert: null, key: null, bindHost: null, port: 8080, trackerPort: 8000, site: join(ROOT, 'examples', 'peer-guestbook'), name: 'peer-guestbook', lanHost: null, seeder: 'browser',
    build: true, dir: join(ROOT, '.tools', 'demo'), dist: join(ROOT, 'dist'), log: out, headless: true, idp: true, idpPort: 0, idpDist: null,
  }, options);
  const log = o.log;
  const closers = [];
  const stop = async () => {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch (_) { /* shutting down */ }
    }
    closers.length = 0;
  };
  try {
    const port = o.port || await freePort(); // 0: any free port
    const trackerPort = o.trackerPort || await freePort();
    const plan = planDemo({ tls: o.tls, port, trackerPort, lanHost: o.lanHost, lan: lanAddresses() });
    // mkcert certificates by default; --cert and --key bring your own (a private CA, openssl)
    const tls = plan.tls ? (o.cert && o.key ? { cert: o.cert, key: o.key } : true) : false;
    const bindHost = o.bindHost || plan.bindHost;
    log('felinar demo, tier: ' + plan.tier);

    if (o.build || !existsSync(join(o.dist, 'index.html'))) {
      log('building the loader into ' + o.dist + ' ...');
      await build({ outDir: o.dist, quiet: true });
    }
    const dir = resolve(o.dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, 'owner.jwk');
    if (!existsSync(keyFile)) {
      const k = await keygen({ out: keyFile });
      log('created the demo owner key ' + keyFile + ' (fingerprint ' + k.fingerprint + '); it only signs this demo');
    }
    // v0.3 verify fix round 2: the identity page on its own loopback port (the desktop tier), named in the pointer, so a post can sign in.
    let idp = null;
    if (!plan.tls && o.idp !== false) {
      const idpDist = o.idpDist ? resolve(o.idpDist) : join(dirname(resolve(o.dist)), 'dist-idp');
      if (o.build || !existsSync(join(idpDist, 'index.html'))) {
        log('building the identity page into ' + idpDist + ' ...');
        await buildIdp({ outDir: idpDist, quiet: true });
      }
      const server = await createIdpServer({ root: idpDist, port: o.idpPort || 0, quiet: true });
      closers.push(() => server.close());
      idp = { origin: 'http://localhost:' + server.port, port: server.port, root: idpDist };
      log('identity page: ' + idp.origin + '/ (from ' + idpDist + '; a post signs in there)');
    }
    // Post-wave fix L: every site folder its own ledger (chain label) and its own publish directory.
    const chain = demoSiteLabel(o.site, dir);
    const outDir = join(dir, 'publish', chain);
    const pub = await publish({
      dir: resolve(o.site), name: o.name, scope: plan.scope, key: keyFile, out: outDir, policy: 'open', bits: 16, exp: 30,
      tr: [plan.trackerUrl], ws: [plan.wsBase], cs: plan.wsBase + 'genesis.json', chain, quiet: true, idp: idp ? idp.origin : null,
    });
    log('published ' + o.name + ': btih ' + pub.btih + ', ledger ' + pub.ledgerId + ' (policy open, 16 bits per post; cs= is genesis.json, so a first visitor can start the ledger)');
    log('this site folder has its own ledger (chain ' + chain + ', remembered in ' + join(dir, 'sites.json') + '); another --site gets another one');

    // The lan tier keeps the tracker on loopback without TLS: the dev server passes /tracker on to it (v0.3 C2, S2 rung 1).
    const tracker = await createTracker(plan.trackerProxy ? {
      port: trackerPort, host: '127.0.0.1', allow: [join(outDir, 'summary.json')], quiet: true,
    } : {
      port: trackerPort, host: bindHost, allow: [join(outDir, 'summary.json')], tls, tlsHosts: [plan.scope], quiet: true,
    });
    closers.push(() => tracker.close());
    log('tracker: ' + tracker.urls.join(', ') + ' (serves only this site and its ledger rendezvous swarm)' + (plan.trackerProxy ? '; on this computer only, phones reach it at ' + plan.trackerUrl + ' through the dev server' : ''));
    const dev = await createDevServer({
      root: o.dist, webseed: outDir, pointer: pub.pointer, dev: true, port, host: bindHost, tls, tlsHosts: [plan.scope], trackerProxy: plan.trackerProxy ? tracker.port : null, quiet: true,
    });
    closers.push(() => dev.close());
    log('dev server: ' + dev.urls.join(', '));

    let seeder = 'none';
    if (o.seeder === 'browser') {
      try {
        const live = await import('./live.mjs');
        const session = await live.launchBrowser({ headless: o.headless, allowRemote: false, ignoreHTTPSErrors: plan.tls });
        closers.push(() => session.close());
        const page = await session.context.newPage();
        page.on('pageerror', (e) => warn('seeder page: ' + e.message));
        const url = plan.local.origin + '/_dev/seeder.html?tr=' + encodeURIComponent(plan.local.trackerUrl);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const state = await waitFor(async () => {
          const s = await page.evaluate(() => window.__seeder).catch(() => null);
          return s && (s.ok || s.error) ? s : null;
        }, 30000);
        if (state && state.ok) {
          seeder = 'browser';
          log('seeder: headless Chromium is seeding ' + state.btih + ' (' + state.files + ' files) to ' + plan.local.trackerUrl);
        } else {
          warn('the headless seeder did not start: ' + (state ? state.error : 'timed out') + '. The site still loads from the web seed; open ' + url + ' in a browser tab to seed.');
        }
      } catch (err) {
        warn('no headless seeder (' + ((err && err.message) || err) + '). The site loads from the web seed; to seed open ' +
          plan.local.origin + '/_dev/seeder.html?tr=' + encodeURIComponent(plan.local.trackerUrl) + ' in a browser tab, or run: node tools/seed.mjs ' + join(outDir, 'site.torrent') + ' ' + outDir);
      }
    } else if (o.seeder === 'node') {
      const child = spawn(process.execPath, [join(ROOT, 'tools', 'seed.mjs'), join(outDir, 'site.torrent'), outDir, '--tr', plan.local.trackerUrl], { stdio: ['ignore', 'inherit', 'inherit'] });
      closers.push(() => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }));
      seeder = 'node';
      log('seeder: tools/seed.mjs (Node) is running');
    }

    log('');
    for (const line of tierText(plan, { caRoot: plan.tls ? mkcertCaRoot() : null, port, trackerPort, idpPort: idp ? idp.port : null })) log(line);
    log('');
    log('Pointer (signed for ' + plan.scope + ', valid 30 days): ' + pub.pointer);
    log('Ctrl-C stops the tracker, the dev server' + (idp ? ', the identity page' : '') + ' and the seeder.');
    return { plan, url: plan.origin + '/', publishResult: pub, chain, tracker, dev, idp, seeder, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    tls: { type: 'boolean' },
    cert: { type: 'string' },
    key: { type: 'string' },
    bind: { type: 'string' },
    port: { type: 'int', default: 8080 },
    'tracker-port': { type: 'int', default: 8000 },
    'idp-port': { type: 'int', default: 8081 },
    site: { type: 'string', default: join(ROOT, 'examples', 'peer-guestbook') },
    name: { type: 'string', default: 'peer-guestbook' },
    'lan-host': { type: 'string' },
    seeder: { type: 'string', default: 'browser' },
    'no-build': { type: 'boolean' },
    dir: { type: 'string', default: join(ROOT, '.tools', 'demo') },
    headed: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length) throw new UsageError('unexpected argument ' + positionals[0]);
  if (!['browser', 'node', 'none'].includes(flags.seeder)) throw new UsageError('--seeder must be browser, node or none');
  if ((flags.cert || flags.key) && !(flags.tls && flags.cert && flags.key)) throw new UsageError('--cert and --key go together with --tls');
  if (flags.tls && flags.lanHost === null && lanAddresses().length === 0 && osHostname()) warn('no LAN address found; pass --lan-host');
  let demo;
  try {
    demo = await runDemo({
      tls: flags.tls, cert: flags.cert, key: flags.key, bindHost: flags.bind, port: flags.port, trackerPort: flags.trackerPort, idpPort: flags.idpPort, site: flags.site, name: flags.name, lanHost: flags.lanHost,
      seeder: flags.seeder, build: !flags.noBuild, dir: flags.dir, headless: !flags.headed, log: flags.quiet ? () => {} : out,
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') throw new ToolError('port ' + err.port + ' is already in use: pass --port <n>, --tracker-port <n> and/or --idp-port <n>');
    throw err;
  }
  await new Promise((resolveStop) => {
    const stop = () => demo.stop().then(resolveStop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
