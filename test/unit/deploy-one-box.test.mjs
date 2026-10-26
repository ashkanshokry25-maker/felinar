// Static checks of deploy/one-box/ (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 rung 2a, Rc1): the Caddyfile is the text Caddy 2.11.7 validated in the research, the
// compose file is deploy/tracker/docker-compose.yml with its documented changes, the README quotes the strings the tools print, and the CI job that runs
// `caddy validate` and `docker compose config` exists. Nothing here starts Docker or Caddy; those run in CI (job one-box).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT } from '../../tools/lib.mjs';
import { COMMANDS } from '../../bin/felinar.mjs';
import { Z1, Z2, Z3, Z5, ACME_PRODUCTION, ACME_STAGING, ONE_BOX_DIR, DEFAULT_REMOTE_DIR, commandsFor, planShip } from '../../tools/ship.mjs';
import { nameCheck, describeNameCheck } from '../../tools/name-check.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const caddyfile = read('deploy/one-box/Caddyfile');
const compose = read('deploy/one-box/docker-compose.yml');
const readme = read('deploy/one-box/README.md');
const noComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The top-level blocks of a compose file's service section: name -> text (an indentation scan; the files are plain block YAML). */
function serviceBlocks(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'services:');
  const blocks = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // the next top-level key
    const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) {
      current = m[1];
      blocks[current] = [];
    } else if (current) blocks[current].push(line);
  }
  return Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.join('\n').replace(/\s+$/, '')]));
}
const services = serviceBlocks(compose);

// ---------------------------------------------------------------------------------------------- the Caddyfile

test('Caddyfile: after its header comment it is, character for character, the text that S2 validated with Caddy 2.11.7 (F17)', () => {
  const s2 = read('docs/research/v03/S2-zero-setup-hosting.md');
  const m = /```caddyfile\n([\s\S]*?)\n```/.exec(s2);
  assert.ok(m, 'S2 holds the Caddyfile block');
  const at = caddyfile.indexOf('\n{\n') + 1;
  assert.ok(at > 1, 'the global options block follows the header comment');
  assert.equal(caddyfile.slice(at).replace(/\n+$/, ''), m[1], 'deploy/one-box/Caddyfile and the S2 text have drifted: change both, or neither');
  // the header says what it is and what was not checked
  const header = caddyfile.slice(0, at);
  assert.match(header, /^# deploy\/one-box\/Caddyfile: one rented server, one site, no domain/);
  assert.match(header, /The certificate request was not part of that run/);
});

test('Caddyfile: braces balance, indentation is tabs, and the environment names are the ones the compose file and ship use', () => {
  const body = noComments(caddyfile);
  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    assert.ok(depth >= 0, 'a closing brace without an opening one');
  }
  assert.equal(depth, 0, 'every brace is closed');
  assert.equal(/^ +\S/m.test(body), false, 'caddy fmt wants tabs, not spaces');
  assert.match(body, /acme_ca \{\$LW_ACME_CA:https:\/\/acme-v02\.api\.letsencrypt\.org\/directory\}/, 'the default authority is Let\'s Encrypt production');
  assert.match(body, /^\{\$LW_SITE\} \{$/m, 'the site address is LW_SITE');
  assert.match(body, /root \* \{\$LW_ROOT:\/srv\/site\}/);
  assert.match(body, /reverse_proxy \{\$LW_TRACKER:tracker:8000\} \{/);
  assert.equal(ACME_PRODUCTION, 'https://acme-v02.api.letsencrypt.org/directory');
  assert.equal(ACME_STAGING, 'https://acme-staging-v02.api.letsencrypt.org/directory');
  for (const name of ['LW_SITE', 'LW_ACME_CA']) assert.ok(compose.includes(name), name + ' is in the compose file');
});

test('Caddyfile: only WebSocket upgrades on /tracker reach the tracker', () => {
  const m = /@tracker \{([\s\S]*?)\n\t\}/.exec(caddyfile);
  assert.ok(m, 'a @tracker matcher');
  assert.deepEqual(m[1].trim().split('\n').map((l) => l.trim()), ['path /tracker', 'header Connection *Upgrade*', 'header Upgrade websocket']);
  assert.match(caddyfile, /handle @tracker \{\n\t\treverse_proxy \{\$LW_TRACKER:tracker:8000\} \{\n\t\t\tstream_close_delay 30s\n\t\t\tstream_timeout 24h\n\t\t\}\n\t\}/);
  assert.equal((caddyfile.match(/reverse_proxy/g) || []).length, 1, 'nothing else is proxied: the tracker\'s /stats.json and /healthz stay private');
});

test('Caddyfile: reserved paths answer 404 with their own body, never the shell; unknown pages get the shell with status 404', () => {
  assert.match(caddyfile, /@reserved path \/mw-sw\.js \/_mw\/\* \/ws\/\* \/\.mw\/\*/);
  assert.match(caddyfile, /handle @reserved \{\n\t\t\trespond "Not found" \{err\.status_code\}\n\t\t\}/, 'a missing loader or seed file is a plain error response');
  assert.match(caddyfile, /handle \{\n\t\t\trewrite \* \/404\.html\n/, 'the shell answers every other missing page');
  assert.match(caddyfile, /handle_errors \{\n\t\timport lw_headers/);
  // the 404.html page is the shell: it carries the same security headers as the home page
  const unknown = /rewrite \* \/404\.html([\s\S]*?)file_server/.exec(caddyfile)[1];
  assert.match(unknown, /header Cache-Control "no-cache"/);
  assert.match(unknown, /header Content-Security-Policy "frame-ancestors 'none'"/);
  assert.match(unknown, /header X-Frame-Options DENY/);
});

test('Caddyfile: dot paths are hidden except .mw and .well-known; the headers; no compression of the web seed', () => {
  assert.match(caddyfile, /path_regexp dot \/\\\.\[\^\/\]\n\t\t\tnot path_regexp ok \/\\\.\(mw\|well-known\)\(\/\|\$\)/);
  assert.match(caddyfile, /respond @hidden "Not found" 404/);
  for (const h of ['X-Content-Type-Options nosniff', 'Referrer-Policy no-referrer', 'Strict-Transport-Security "max-age=31536000"', '-Server']) {
    assert.ok(caddyfile.includes('\t\t' + h + '\n'), h);
  }
  assert.match(caddyfile, /@loader path \/ \/index\.html \/404\.html \/mw-sw\.js \/_mw\/\*\n\theader @loader Cache-Control "no-cache"/);
  assert.match(caddyfile, /header \/ws\/\* Cache-Control "no-cache"/, 'the web seed is revalidated');
  assert.match(caddyfile, /@compress not path \/ws\/\*\n\tencode @compress zstd gzip/, 'and never compressed: Range answers 206 with the bytes as stored');
  assert.equal(/encode [^@]/.test(caddyfile), false, 'there is no encode directive that includes /ws/');
  assert.match(caddyfile, /@shell path \/ \/index\.html \/404\.html\n\theader @shell \{\n\t\tContent-Security-Policy "frame-ancestors 'none'"\n\t\tX-Frame-Options DENY\n\t\}/);
});

test('Caddyfile: it opens no port of its own, serves no log of client addresses, and says where to add the masked log', () => {
  assert.equal(/^\s*log\b/m.test(noComments(caddyfile)), false, 'no access log is written');
  assert.match(caddyfile, /# Add the log block of deploy\/tracker\/Caddyfile here \(client addresses masked to \/24 and \/48\)\./);
  const tracker = read('deploy/tracker/Caddyfile');
  assert.match(tracker, /ipv4 24/, 'the block the comment points at exists');
  assert.match(tracker, /ipv6 48/);
});

// ---------------------------------------------------------------------------------------------- the compose file

test('compose: the project, the three services and the volumes', () => {
  assert.match(compose, /^name: felinar-one-box$/m, 'its own project name: it does not collide with deploy/tracker on a machine that runs both');
  assert.deepEqual(Object.keys(services), ['tracker', 'caddy', 'pin']);
  assert.match(compose, /^volumes:\n {2}caddy_data:\n {2}caddy_config:\n {2}mw-pin:\n/m);
  assert.match(compose, /^networks:\n {2}internal:\n/m);
  assert.match(compose, /Docker Compose 2\.17 or newer/);
});

test('compose: the tracker service is the one of deploy/tracker, comments aside', () => {
  const other = serviceBlocks(read('deploy/tracker/docker-compose.yml'));
  assert.equal(noComments(services.tracker), noComments(other.tracker), 'the tracker service of the one-box and of deploy/tracker have drifted: change both, or neither');
  assert.doesNotMatch(noComments(services.tracker), /^\s*ports:/m, 'the tracker port is not published to the host');
  const command = JSON.parse(/command: (\[.*\])/.exec(services.tracker)[1]);
  const help = spawnSync(process.execPath, [join(ROOT, 'tools', 'tracker.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const a of command.filter((x) => x.startsWith('--'))) assert.ok(help.stdout.includes(a), 'tracker has no ' + a);
  assert.ok(!command.includes('--open'), 'the deployed tracker serves only the allow list');
  const mount = /- \.\/allow:(\S+):ro/.exec(services.tracker);
  assert.ok(mount && command[command.indexOf('--allow') + 1].startsWith(mount[1] + '/'), 'the allow file is inside a mounted directory, not a single-file mount');
});

test('compose: caddy takes the site name and the certificate authority from the environment, mounts the site read-only and keeps its certificates', () => {
  const c = services.caddy;
  assert.match(c, /image: caddy:2\.11$/m);
  assert.match(c, /LW_SITE: \$\{LW_SITE:\?set LW_SITE, for example 203-0-113-7\.nip\.io\}/, 'a missing name stops compose instead of starting a box for nothing');
  assert.match(c, /LW_ACME_CA: \$\{LW_ACME_CA:-https:\/\/acme-v02\.api\.letsencrypt\.org\/directory\}/, 'an empty value would break the Caddyfile, so the default is written out');
  for (const port of ['"80:80"', '"443:443"', '"443:443/udp"']) assert.ok(c.includes('- ' + port), port);
  for (const mount of ['./Caddyfile:/etc/caddy/Caddyfile:ro', './site:/srv/site:ro', 'caddy_data:/data', 'caddy_config:/config']) assert.ok(c.includes('- ' + mount), mount);
  assert.match(c, /depends_on:\n {6}tracker:\n {8}condition: service_healthy/);
  assert.match(c, /Keep this volume: losing it requests the certificate again, and Let's Encrypt allows 5 duplicate/);
  assert.doesNotMatch(c, /profiles:/, 'caddy and the tracker start without any profile');
  assert.doesNotMatch(services.tracker, /profiles:/);
});

test('compose: the pin profile builds deploy/pin/Dockerfile and uses the environment names that Dockerfile defines; no key in the image or the file', () => {
  const p = services.pin;
  assert.match(p, /profiles: \["pin"\]/);
  assert.match(p, /build:\n {6}context: \.\.\/\.\.\n {6}dockerfile: deploy\/pin\/Dockerfile/);
  assert.ok(existsSync(join(ROOT, 'deploy/pin/Dockerfile')));
  const docker = read('deploy/pin/Dockerfile');
  for (const name of ['PIN_URL', 'PIN_KEY', 'PIN_STATUS', 'PIN_MONTH_CAP', 'PIN_AUTO_ACCEPT']) {
    assert.match(docker, new RegExp('\\b' + name + '\\b'), 'deploy/pin/Dockerfile does not know ' + name + ': the pin-node lane defines these names');
    assert.ok(p.includes(name), name + ' is in the pin service');
  }
  assert.match(p, /- PIN_URL=https:\/\/\$\{LW_SITE:-localhost\}\//);
  assert.match(p, /- PIN_KEY=\/var\/lib\/mw-pin\/pin\.jwk$/m, 'the key is a path in the volume');
  assert.match(p, /- PIN_STATUS=\/srv\/site\/ws\/pin-status\.json$/m);
  assert.match(p, /^ {6}- PIN_MONTH_CAP$/m, 'passed through when set in .env, absent when not');
  assert.match(p, /^ {6}- PIN_AUTO_ACCEPT$/m);
  assert.match(p, /- mw-pin:\/var\/lib\/mw-pin/);
  assert.match(p, /- \.\/site\/ws:\/srv\/site\/ws/, 'the heartbeat lands in the directory Caddy serves');
  assert.equal(/\.jwk\b/.test(noComments(compose).replace(/pin\.jwk/g, '')), false, 'no other key file is named');
  assert.equal(/BEGIN|"d":|\bd=/.test(compose), false, 'no key material');
  assert.match(compose, /The pin runs as the image's node user \(uid 1000\)/);
  // Code review v0.3 (round 2): tools/live.mjs wants Chromium's sandbox for a remote-capable browser; the image says how it is
  // handled in a container (MW_CHROMIUM_NO_SANDBOX=1, documented), and the container drops every capability and privilege gain.
  assert.match(p, /cap_drop: \[ALL\]/);
  assert.match(p, /- no-new-privileges:true/);
  assert.match(docker, /^ {4}MW_CHROMIUM_NO_SANDBOX=1 \\$/m);
  assert.match(docker, /The Chromium sandbox/);
  assert.equal(/Playwright starts Chromium with --no-sandbox/.test(docker), false, 'the old comment is gone');
});

test('compose and ship agree: the directories rsync fills are the ones the compose file mounts, and the box is where ship says', () => {
  const plan = planShip({ dir: ROOT, ip: '203.0.113.7', to: 'ssh://root@203.0.113.7', ct: 'mailto:you@example.org' }, { home: '/nonexistent-home', cwd: '/nonexistent-cwd' });
  const c = commandsFor(plan);
  assert.equal(ONE_BOX_DIR, 'deploy/one-box');
  assert.ok(existsSync(join(ROOT, ONE_BOX_DIR, 'docker-compose.yml')) && existsSync(join(ROOT, ONE_BOX_DIR, 'Caddyfile')));
  assert.equal(plan.boxDir, DEFAULT_REMOTE_DIR + '/' + ONE_BOX_DIR);
  assert.ok(c.rsyncShell[c.rsyncShell.length - 1].endsWith(':' + plan.boxDir + '/site/'));
  assert.ok(c.rsyncWeb(false)[c.rsyncWeb(false).length - 1].endsWith(':' + plan.boxDir + '/site/ws/'));
  assert.ok(c.rsyncAllow[c.rsyncAllow.length - 1].endsWith(':' + plan.boxDir + '/allow/'));
  assert.deepEqual(c.mkdirBox.slice(-2), [plan.boxDir + '/site/ws', plan.boxDir + '/allow'], 'the directories the compose file mounts are made before rsync fills them');
  assert.ok(c.rsyncEnv('/x/.env')[c.rsyncEnv('/x/.env').length - 1].endsWith(':' + plan.boxDir + '/.env'));
  assert.match(compose, /- \.\/site:\/srv\/site:ro/);
  assert.match(compose, /- \.\/allow:\/etc\/magnet-tracker:ro/);
  // the file name the tracker reads from the allow directory is the one ship writes
  assert.match(compose, /"--allow", "\/etc\/magnet-tracker\/allow\.txt"/);
});

// ---------------------------------------------------------------------------------------------- the README

test('README: the strings Z1 to Z5 are those the tools print, the by-hand commands use flags that exist, and every link and file it names exists', async () => {
  assert.ok(readme.includes(Z1('203-0-113-7.nip.io')));
  // IND-7: "costs nothing and needs no sign-up" is said of the name only; the rented server is an account (Z1 and the opening paragraph).
  assert.doesNotMatch(readme, /It costs nothing and needs no sign-up|which costs nothing and needs no sign-up/);
  assert.match(readme, /the server is rented under an account/);
  assert.ok(readme.includes(Z2));
  assert.ok(readme.includes(Z3('nip.io')));
  assert.ok(readme.includes(Z5));
  const blocked = await nameCheck({ ip: '203.0.113.7', resolve4: async () => ['64.176.22.9'] });
  assert.ok(readme.includes(describeNameCheck(blocked, { alt: '203-0-113-7.sslip.io' })), 'string Z4');
  // flags: every --flag on a command line of a tool must be a flag of that tool
  const helpOf = (file) => {
    const r = spawnSync(process.execPath, [join(ROOT, file), '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, file);
    return r.stdout + r.stderr;
  };
  const text = readme.replace(/\\\n\s*/g, ' ');
  let checked = 0;
  for (const line of text.split('\n')) {
    let m = /(?:^|[\s'"`])(?:node\s+)?(tools\/[a-z0-9-]+\.mjs)((?:\s+[^\s|;&'"`]+)*)/.exec(line);
    let file = m && existsSync(join(ROOT, m[1])) ? m[1] : null;
    if (!file) {
      m = /\b(?:felinar|magnet-web)\s+([a-z][a-z-]*)((?:\s+[^\s|;&'"`]+)*)/.exec(line);
      file = m && Object.prototype.hasOwnProperty.call(COMMANDS, m[1]) ? COMMANDS[m[1]].file : null;
    }
    if (!file) continue;
    const help = helpOf(file);
    for (const [flag] of m[2].matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
      checked++;
      assert.ok(help.includes(flag), file + ' has no ' + flag + ' (in: ' + line.trim().slice(0, 140) + ')');
    }
  }
  assert.ok(checked >= 20, 'only ' + checked + ' flags found');
  // links
  const stripped = readme.replace(/```[\s\S]*?```/g, '');
  const missing = [];
  for (const m of stripped.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    const target = join(ROOT, 'deploy/one-box', m[1]);
    if (!existsSync(target) || !statSync(target)) missing.push(m[1] + ' -> ' + relative(ROOT, target));
  }
  assert.deepEqual(missing, []);
  // the files and tests it names
  for (const f of ['test/unit/deploy-one-box.test.mjs', '.github/workflows/ci.yml']) assert.ok(readme.includes(f) && existsSync(join(ROOT, f)), f);
});

test('README: the limits of SZ 3.2 and 3.4 are stated, with the measured and arithmetic labels the project uses', () => {
  for (const s of [
    'The name is the server\'s IP address.',
    'nip.io and sslip.io are one free DNS service run by two volunteers, with no uptime promise and a block list',
    'Nobody can set a DNS record under these names',
    'Ports 80 and 443 must be reachable from the internet',
    'carrier-grade NAT',
    'One box serves one site.',
    'Peers see each other\'s IP addresses',
    'Arithmetic, not a measurement',
    'No certificate was requested from Let\'s Encrypt, no real server was used',
  ]) assert.ok(readme.replace(/\s+/g, ' ').includes(s), s);
  assert.match(readme, /neither nip\.io nor sslip\.io is on the Public Suffix List \(F4, F5; the sharing is an inference\)/);
});

test('wording: no banned word, no en or em dash and no curly quote in anything under deploy/one-box/', () => {
  const dashesOrCurly = /[–—‘’“”]/;
  for (const [file, text] of [['Caddyfile', caddyfile], ['docker-compose.yml', compose], ['README.md', readme]]) {
    for (const word of ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready', 'fully decentralized']) {
      assert.equal(text.toLowerCase().includes(word), false, file + ': ' + word);
    }
    assert.equal(dashesOrCurly.test(text), false, file + ' has an en or em dash or a curly quote');
  }
});

// ---------------------------------------------------------------------------------------------- CI

test('ci.yml: a job one-box runs docker compose config (with and without the pin profile) and caddy validate in a Caddy 2.11.7 image, with a pinned checkout', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = /\n {2}one-box:\n([\s\S]*)$/.exec(ci);
  assert.ok(job, 'a job named one-box');
  const text = job[1];
  assert.match(text, /permissions:\n {6}contents: read/);
  assert.match(text, /CADDY_IMAGE: caddy:2\.11\.7(@sha256:[0-9a-f]{64})?$/m, 'Caddy 2.11.7, with its digest once it is copied in');
  assert.match(text, /LW_SITE: 203-0-113-7\.nip\.io/);
  assert.match(text, /docker compose -f deploy\/one-box\/docker-compose\.yml config --quiet/);
  assert.match(text, /docker compose -f deploy\/one-box\/docker-compose\.yml --profile pin config --quiet/);
  assert.match(text, /caddy validate --config \/etc\/caddy\/Caddyfile --adapter caddyfile/);
  assert.match(text, /-v "\$PWD\/deploy\/one-box\/Caddyfile:\/etc\/caddy\/Caddyfile:ro"/);
  assert.match(text, /docker image inspect --format '\{\{index \.RepoDigests 0\}\}' "\$CADDY_IMAGE"/, 'the digest is printed for pinning');
  assert.match(text, /uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+persist-credentials: false/);
  assert.doesNotMatch(text, /\$\{\{/, 'no expression inside a run block');
  assert.match(ci, /^#   one-box the files in deploy\/one-box\//m, 'the header of the workflow lists the job');
});
