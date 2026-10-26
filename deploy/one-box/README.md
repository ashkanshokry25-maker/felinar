# One box: a site on a rented server, with no domain

One small server, one Docker Compose file, one site. The site is named by the server's IP address, for example
`203-0-113-7.nip.io`: the name costs nothing and needs no sign-up, and the server is rented under an account with its provider. Caddy gets the HTTPS certificate by itself, serves the
loader and the web seed, and passes the tracker's WebSocket through at `/tracker`. An optional `pin` profile adds an
always-on copy of the site and its ledger.

This is rung 2a of the zero-setup ladder
([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](../../docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), 3.2). The research it
rests on is [S2](../../docs/research/v03/S2-zero-setup-hosting.md), cited below as F1, F2 and so on. The user-facing page is
[DEPLOY.md](../../docs/DEPLOY.md), "Zero-setup: a server without a domain", and the quickstart is
[QUICKSTART.md](../../docs/QUICKSTART.md), "Start without a domain".

> [!IMPORTANT]
> What was checked and what was not. Caddy 2.11.7 validated this `Caddyfile` and served a test site with it on loopback, and the
> repository's `tools/check-webseed.mjs` and `tools/check-site.mjs` passed against that run (S2 F17). `docker compose config`
> accepted the compose file. No certificate was requested from Let's Encrypt, no real server was used, and no phone or browser
> opened a nip.io name. The first real run is gate row G-ZS1 in [DEMO-RESULTS.md](../../docs/DEMO-RESULTS.md).

## The short way: `ship`

From a checkout of this repository, with the loader built (`npm run build`):

```sh
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org --dry-run
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org
```

The first command prints every host and every command and contacts nothing. The second does the work:

1. It looks up `203-0-113-7.nip.io` with your computer's DNS resolver and checks that it answers `203.0.113.7`. The service keeps a block
   list of addresses used in phishing and answers a block page for them (F3), so a recycled address can be blocked before you start. If
   the name is blocked or wrong it tries `203-0-113-7.sslip.io`, the same service under its second name (F1).
2. It looks at the server before it makes or publishes anything: the clone, rsync, Docker Compose 2.17 or newer, and whether the server's
   `.env` says this is a first run or an update. A server that cannot be used stops the run with nothing created on your computer.
3. It makes the owner key on your computer (or reuses the one you name with `--key`). The key is never copied: only the site tree
   and the allow list are sent, and the run stops if the key's secret is found inside them.
4. It publishes with `--chain <name>`, the web seed and the snapshot at `https://<name>/ws/`, your own tracker at `wss://<name>/tracker`,
   `--shell` and `--exp 399`. A name made from an address cannot carry a DNS record, so the signed page tag is the only pointer and it
   expires: the date is printed.
5. It sends the site to `<remote dir>/deploy/one-box/` with rsync in the deploy order of [DEPLOY.md](../../docs/DEPLOY.md#deploy-order): the
   web seed (`site/ws/`, added to and never pruned, because visitors on the previous version still need its files for a week), then the
   allow list, then the loader with the new pointer. It writes `.env` on the server with `LW_SITE=<name>` and the Let's Encrypt **staging**
   directory in `LW_ACME_CA`, and starts the box.
6. When the staging certificate is there it switches `.env` to the production directory and restarts the box once. Staging first means
   a closed port or a wrong address costs no production certificate (Let's Encrypt allows 5 certificates for the same names a week,
   F5).
7. It runs `check-site` against `https://<name>/` from your computer.

Run the same command again to publish a change: the server's `.env` says the production certificate is in use, so only the files are
sent, the snapshot at `ws/genesis.json` on the server is kept, and nothing restarts. Keep the work directory (`dist-ship/<name>`, or
`--out`): it holds the ledger's first block. An update without it stops, because a new first block is a new ledger for every visitor
(`--new-ledger` says that is meant). `--staging-only` stops after the staging certificate and `--suffix sslip.io` uses only that service.

What the server needs: a public IPv4 address, Docker with Compose 2.17 or newer, rsync, ports 80 and 443 reachable from the internet, and a
clone of this repository at the `--remote-dir` (default `/opt/felinar`; the tracker image is built from it). The ssh user must be able to
write `<remote dir>/deploy/one-box/` and run Docker. Use an ssh key: every step is its own ssh or rsync call, and a password is asked for each.

```sh
ssh root@203.0.113.7 'git clone --branch v0.3.0 --depth 1 <this repository> /opt/felinar && git -C /opt/felinar rev-parse HEAD'
```

The tracker and the pin node are built on the server from that clone, so it must be a release tag: compare the commit it prints
with the release notes. `ship` checks it on every run and stops when the clone is at another commit than your checkout (or
`--expect-commit <sha>`, when you run the tools from an installed package). To move to a new release, run
`git -C /opt/felinar fetch --tags && git -C /opt/felinar checkout v<version>` on the server. Set
`LW_NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>` in the server's `.env` to pin the Node base image of both images.

## By hand

Every flag exists in the tools today. Run these from a checkout, then on the server.

```sh
node tools/keygen.mjs --out ~/keys/my-site.jwk
node tools/publish.mjs ~/my-site --name my-site --chain my-site --scope 203-0-113-7.nip.io --key ~/keys/my-site.jwk \
  --ws https://203-0-113-7.nip.io/ws/ --cs https://203-0-113-7.nip.io/ws/genesis.json --tr wss://203-0-113-7.nip.io/tracker \
  --ct mailto:you@example.org --exp 399 --shell --out dist-publish
mkdir -p site/ws allow && cp -R dist-publish/shell/. site/ && rm -f site/_headers
cp -R dist-publish/my-site dist-publish/my-site.torrent dist-publish/genesis.json site/ws/
jq -r '.btih, .rendezvousBtih' dist-publish/summary.json > allow/allow.txt
chmod -R u=rwX,go=rX site allow        # rsync -p carries these modes to the server
ssh root@203.0.113.7 mkdir -p /opt/felinar/deploy/one-box/site/ws /opt/felinar/deploy/one-box/allow
rsync -rltp site/ws/ root@203.0.113.7:/opt/felinar/deploy/one-box/site/ws/
rsync -rltp --delete allow/ root@203.0.113.7:/opt/felinar/deploy/one-box/allow/
rsync -rltp --delete --exclude=/ws/ site/ root@203.0.113.7:/opt/felinar/deploy/one-box/site/
ssh root@203.0.113.7 'cd /opt/felinar/deploy/one-box && echo LW_SITE=203-0-113-7.nip.io > .env && docker compose up -d --build'
node tools/check-site.mjs https://203-0-113-7.nip.io/
```

Add `echo LW_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory >> .env` before the first start to try the staging directory
first; when it works, remove that line and run `docker compose up -d` again to switch to the production directory. A staging certificate is
not trusted by browsers.

## What is in this directory

| File | What it is |
|---|---|
| `Caddyfile` | HTTPS for `LW_SITE`, the static site, the tracker on `/tracker`, the headers; the text S2 validated, with a header comment |
| `docker-compose.yml` | [deploy/tracker/docker-compose.yml](../tracker/docker-compose.yml) with the site mounted into Caddy, `LW_SITE` and `LW_ACME_CA`, and the optional `pin` profile |
| `site/`, `allow/`, `.env` | made on the server by `ship` or by hand; not in the repository |

What the `Caddyfile` does, in the order of its comments:

- **The tracker.** Only WebSocket upgrades on `/tracker` reach it. A plain request to `/tracker` is a request for a page like any other.
- **Dot paths** are never served, except `.mw` (inside the torrent, so the web seed has it) and `.well-known`.
- **Headers.** The loader files (`/`, `/index.html`, `/404.html`, `/mw-sw.js`, `/_mw/*`) are `no-cache`; the shell pages say
  `frame-ancestors 'none'` in a response header, which a `<meta>` policy cannot do; the web seed under `/ws/` is `no-cache` and is
  never compressed, so `Range` is answered with `206` and the bytes as they are.
- **Unknown paths** get the shell with status 404, which the loader renders. A missing loader file or seed file is a plain 404, never the shell as `200 text/html`.
- **No access log is written.** To keep one with client addresses masked to /24 and /48, add the `log` block of
  [../tracker/Caddyfile](../tracker/Caddyfile) where the comment in the site block says.

The environment: `LW_SITE` (the name, required), `LW_ACME_CA` (the certificate authority's directory; the default is Let's Encrypt
production), `LW_ROOT` (default `/srv/site`) and `LW_TRACKER` (default `tracker:8000`).

## Certificates

Caddy asks for a certificate with HTTP-01 on port 80 or TLS-ALPN-01 on port 443. Neither needs DNS credentials, and DNS-01 through a
DNS provider is not possible for these names (F7). Let's Encrypt has issued certificates for bare IP addresses since 2026-01-15, with a 6-day lifetime
(F8); that variant (`profile shortlived`) was parsed by Caddy and not run, and a site on a bare IP address cannot hold passkeys
(reported, F8), so it is not used here.

Keep the `caddy_data` volume. Losing it requests the certificate again, and the limit of 5 certificates for the same names a week has no
override (F5). The limit of 50 certificates per registered domain a week applies to everyone who uses the same service name, because
neither nip.io nor sslip.io is on the Public Suffix List (F4, F5; the sharing is an inference).

## The pin profile

A pin node keeps one copy of the site and its ledger online while nobody else is. It is `tools/pin.mjs` in Playwright Chromium,
described in [../pin/README.md](../pin/README.md); the settings here are the environment names of its Dockerfile.

```sh
cd /opt/felinar/deploy/one-box
chown 1000:1000 site/ws                 # the pin runs as the image's node user (uid 1000) and writes its heartbeat there
docker compose --profile pin run --rm --no-deps --entrypoint node pin tools/keygen.mjs --out /var/lib/mw-pin/pin.jwk
docker compose --profile pin up -d --build
```

The first command makes the pin's own key in the `mw-pin` volume, never in the image; it prints the public key
(`owner=p256:...`). On your own computer, keep a ledger file of your own (`publish` rewrites `genesis.json` with the first block alone on every
run), tell the ledger which key is the pin's, and put the new snapshot where the pointer's `cs=` names it. An update by `ship` keeps the snapshot
on the server:

```sh
cp dist-ship/my-site/publish/genesis.json ledger.json     # once; later control blocks are added to this file
node tools/ledger-admin.mjs cfg --key ~/keys/my-site.jwk --file ledger.json --pin p256:...
node tools/snapshot.mjs ledger.json --out snapshot.json.gz
rsync -t snapshot.json.gz root@203.0.113.7:/opt/felinar/deploy/one-box/site/ws/genesis.json
```

The pin writes a signed heartbeat to `site/ws/pin-status.json`, which Caddy serves at `https://<name>/ws/pin-status.json`; an update
by `ship` does not delete it. Set `PIN_MONTH_CAP` (bytes, or `500GiB`: what the pinned files may upload per month) and, once the owner
has decided SZ-6, `PIN_AUTO_ACCEPT=owner` in `.env`; both are explained in [../pin/README.md](../pin/README.md). Whether the pin
container can open the box's own public name from inside the machine is not tested (S2 Q10).

## Limits, in plain words

- The name is the server's IP address. If the server gets another address, the name changes, and visitors start again with empty saved
  copies, consent and key pins. A domain you own does not have this problem.
- nip.io and sslip.io are one free DNS service run by two volunteers, with no uptime promise and a block list (F1, F3). If it stops, new
  visitors cannot open the address; people who already opened the site keep their saved copy.
- Nobody can set a DNS record under these names (F2). The address record lives in the page, it expires (399 days at most), and after the
  date new visitors cannot load the site until you publish again. Put the date in your calendar.
- Ports 80 and 443 must be reachable from the internet. A home connection behind a router without a port forward, behind a provider that
  blocks port 80, or behind carrier-grade NAT cannot get a certificate (F12).
- One box serves one site. The tracker, the web seed and the pointer are on the same machine, so this machine is the floor: when it is
  down, new visitors cannot load the site, and returning visitors keep their saved copy.
- Who answers abuse notices for a site on a rented server is the owner (`--ct`); the question of who answers for a hub of such sites is
  open (SEEDING-AND-ZERO-SETUP-DESIGN, section 6).
- Peers see each other's IP addresses; that is the premise of the light web, not a setting.

The same texts, as the tool prints them:

```text
Z1  Your site will be at https://203-0-113-7.nip.io/. The name is your server's IP address with dashes: the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close.
Z2  If this server gets another IP address, the address changes and visitors start again. A domain you own does not have this problem.
Z3  nip.io is a free DNS service run by two volunteers with no uptime promise. If it stops, new visitors cannot open this address; people who already opened the site keep their saved copy.
Z4  203-0-113-7.nip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Try 203-0-113-7.sslip.io, use another server, or use a domain you own.
Z5  The certificate authority could not reach this server on port 80 or 443. At home a router may need a port forward, some providers block port 80, and a provider that shares one address between customers cannot be reached. Use a rented server, a free static host or a tunnel.
```

## Moving to a domain later

Publish again with the same key and the same `--chain`, under the new hostname and with the DNS record from
[DEPLOY.md](../../docs/DEPLOY.md#the-dns-txt-record). The ledger, its rendezvous swarm and the infohash stay the same, and the old and
the new address can run together as one swarm (F16). The new hostname is a new origin, so saved copies, consent and key pins start over.

## Cost

List prices read on 2026-10-20 (F15): a droplet with 500 GiB of transfer and an IPv4 address from $4.00 a month at DigitalOcean; Hetzner
from EUR 5.99 and 6.49 a month excluding VAT. Free and cheap offers change under you: Glitch ended hosting on 2025-07-08, and Oracle cut
its Always Free A1 allowance on 2026-06-15. Arithmetic, not a measurement: 500 GiB divided by a 5 MiB site is 102,400 first visits a month with no
help from peers.

## Tests

`test/unit/deploy-one-box.test.mjs` checks the text of the `Caddyfile` and the keys of the compose file. CI (`.github/workflows/ci.yml`,
job `one-box`) runs `caddy validate` in a Caddy 2.11.7 image and `docker compose config`. The loopback run of S2 F17 (Caddy serving a test
copy, then `check-webseed` and `check-site`) was done by hand and is repeated by the integrator.
