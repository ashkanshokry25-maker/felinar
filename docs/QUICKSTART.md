# Quickstart

From a clone of this repository to a site on your own domain, with the exact commands, what they print
and where every file goes. There are two tracks:

- **Track A, shell mode:** a new site. Your host serves a small loader; the site's files arrive by
  torrent from other visitors and from your host, and the loader's Service Worker serves them at their
  own URLs.
- **Track B, drop-in mode:** an existing static site. You add one script tag. Your host keeps serving
  every page exactly as today, and after the first page view the other files travel between visitors.

The goal is a published site in about 10 minutes of typing once your host and domain exist. Setting up a
new domain, its certificate or a DNS record takes as long as your provider takes. No domain yet? Start with
["Start without a domain"](#start-without-a-domain): the site lives at its key, a light link opens it at any door, a
rented server named by its IP address works the same day, and you move to a domain later with the same key.

No backend means there's no application server or database for you to run. You still need an HTTPS
static host, which serves the loader on every visit and keeps the site loading when nobody else is
online. Visitors find each other through WebSocket trackers and STUN servers, public ones or your own. If
you publish the pointer in DNS, a DNS-over-HTTPS service reads it for the browser.

## Pick a track

| | Track A: shell | Track B: drop-in |
|---|---|---|
| Start from | a new site, or one you are happy to serve only through the loader | an existing static site |
| Who serves the HTML | the torrent, through the loader's Service Worker | your host, unchanged |
| Search engines and link previews | see the loader page only | see your pages as today |
| Host down, returning visitor | the whole site renders from the saved copy | pages already visited render from the saved copy |
| Host down, new visitor | cannot load: the loader itself comes from your host | cannot load |
| Host egress | each new version once per visitor, shared with peers when any are online | each visitor on an unmetered network completes the copy from your host once |
| Good for | sites that work peer-to-peer first, apps, demos | migrating, sites that need search traffic |

Sources: [ARCHITECTURE.md](ARCHITECTURE.md) section 3, the migration digest's verdict 2
([research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md)), and the egress note `publish --dropin`
prints. Unsure which one you need? Answer the intake questions in [ONBOARDING.md](ONBOARDING.md) first.

## The short version

Every command below is explained, with its output, in the steps that follow.

```sh
# Track A: a new site in shell mode, at https://example.com/
node tools/keygen.mjs --out ~/keys/my-site-owner.jwk
node tools/publish.mjs ~/my-site --name my-site --scope example.com --key ~/keys/my-site-owner.jwk \
  --ws https://example.com/ws/ --tr public --cs https://example.com/ws/genesis.json \
  --ct mailto:abuse@example.com --shell --out dist-publish
#   upload dist-publish/shell/ to the host root, and my-site/, my-site.torrent, genesis.json under /ws/
node tools/check-site.mjs https://example.com/
```

```sh
# Track B: an existing site in drop-in mode, at https://www.example.com/
node tools/keygen.mjs --out ~/keys/my-site-owner.jwk
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
#   upload dist-publish/site/ to the host root: non-HTML files first, HTML pages last
node tools/check-site.mjs https://www.example.com/
```

```sh
# No domain: the key is the address. Publish once with --chain and --door, then hand out the light link
node tools/publish.mjs ~/my-site --name my-site --chain my-site --scope <user>.github.io --key ~/keys/my-site-owner.jwk \
  --ws https://<user>.github.io/ws/ --tr public --door <user>.github.io --door <a friend's host> --shell --out dist-publish
#   deploy as in Track A, then share dist-publish/link.txt or the QR code in dist-publish/link-qr.svg: any door opens it
#   (a guest door gives a limited view and an identity for that visit only; a door kit needs the pinned release key)
```

## Step 0: get the tools

```sh
git clone https://github.com/ashkanshokry25-maker/felinar.git
cd felinar
npm ci          # exact versions from package-lock.json; .npmrc turns off dependency install scripts
npm run build   # writes dist/: the loader, the Service Worker and the drop-in runtime
```

You need Node 22 or newer. Every command on this page runs from the repository root. The tools are
also one command, `felinar <command>` from `bin/felinar.mjs` (for example `npx felinar publish`
runs `node tools/publish.mjs`); this page uses the `node tools/...` form, which works in any clone.

`npm ci` ends with "4 high severity vulnerabilities" (npm 11.19, checked 2026-10-19). All four are one
advisory, GHSA-2p57-rm9w-gvfp, about `isPublic` in the `ip` package, which `bittorrent-tracker` pulls in.
Nothing here calls `isPublic`: `bittorrent-tracker` uses only `ip.toString`, in its UDP server, which
`tools/tracker.mjs` turns off, and the browser bundle in `dist/` doesn't contain the package. There is no
fixed release. Don't run `npm audit fix --force`: its "fix" installs `bittorrent-tracker` 0.7.3, which
npm itself calls a breaking change ([research/w1-11-security-threats.md](research/w1-11-security-threats.md),
item 18).

## Try it on this computer first

```sh
npm run demo
```

The demo builds the loader and the identity page, publishes the example site (`examples/peer-guestbook/`) with an
open guestbook, starts a local tracker, the dev server and the identity page, seeds the site from a headless browser
and prints the address. Abridged output (your infohash, ledger id and fingerprint differ):

```text
felinar demo, tier: desktop
created the demo owner key .../.tools/demo/owner.jwk (fingerprint cbba4914); it only signs this demo
identity page: http://localhost:8081/ (from .../dist-idp; a post signs in there)
published peer-guestbook: btih 08254da86efb5a03de8daedd3296e65aa6b17689, ledger mw1:eroU4kVeBuQ_m5yJOM0k5thT8s3 (policy open, 16 bits per post; cs= is genesis.json, so a first visitor can start the ledger)
this site folder has its own ledger (chain demo-peer-guestbook-e38899, remembered in .../.tools/demo/sites.json); another --site gets another one
tracker: ws://127.0.0.1:8000 (serves only this site and its ledger rendezvous swarm)
dev server: http://127.0.0.1:8080/

Tier: desktop (this computer, http://localhost): full mode.
  Open http://localhost:8080/ in Chrome, Edge, Firefox or Safari on THIS computer (use "localhost", not 127.0.0.1: the pointer is signed for the hostname).
```

1. Open `http://localhost:8080/`. A card says "This site is delivered peer-to-peer." with
   [Share and load] and [Load from host only]. Choose "Share and load".
2. Sign the guestbook. Writing needs a sign-in, so the first post opens the identity page in a window: create an
   identity there, or choose "For this visit only" to keep nothing. Posting takes a moment: every post carries a small proof-of-work fee. The
   loader's status bar folds into a small round counter in the corner a few seconds after the site
   appears; click the counter to open the bar again, and while a fee is worked out its status line says
   "Posting: working out the spam fee for this post".
3. Open the same address in a second browser (Firefox next to Chrome, or a second browser profile).
   The post is there, and both pages show the same ledger line, for example "Ledger: 2 entries, in sync
   with 1 peer". Two tabs of one browser profile share one identity and one engine, so use a second
   browser to see a second visitor.

Variants:

```sh
npm run demo -- --site ~/my-site --name my-site   # your own folder, published the same way
npm run demo -- --tls                             # https on your LAN address, for phones (no identity page: phones read and share)
```

Every folder you run the demo on gets a ledger of its own: one demo key signs all of them, and the demo gives each
folder a chain label (`demo-<folder name>-<6 random hex digits>`) the first time and remembers it in
`.tools/demo/sites.json`. Your guestbook posts therefore don't appear in a `--site` demo, and running the same folder
again keeps its posts. To start a folder's ledger afresh, delete its line from `sites.json` (and the folder
`.tools/demo/publish/<label>/`).

Phones need `--tls`: browsers run the loader only on HTTPS or `localhost`. The demo uses mkcert
certificates (`brew install mkcert nss && mkcert -install`) and prints how to trust the mkcert root on
iOS and Android. Android with USB debugging can skip certificates: the demo prints an `adb reverse`
line for the desktop tier. If the headless seeder cannot start (no Playwright browser:
`npx playwright install chromium`), the demo says so and the site still loads from the web seed.
Everything the demo runs stays on this computer and its LAN ([DEV-NETWORK.md](DEV-NETWORK.md)).

## Start without a domain

> **Status: v0.3 C2, written together with its code and not yet run on a real server or a phone.** The tools named here are in this tree and
> are tested with canned answers on loopback; that the loader asks no DNS resolver about a `nip.io` name is tested in a browser on loopback
> (e2e E-ZS-1). The research is [S2](research/v03/S2-zero-setup-hosting.md) (F1, F2 and so on) and the design is
> [SEEDING-AND-ZERO-SETUP-DESIGN](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), section 3.2. The facts behind each rung are in
> [DEPLOY.md, "Zero-setup"](DEPLOY.md#zero-setup-a-server-without-a-domain).

You don't need a domain to start. The ladder has rungs; each one costs more setup and removes a limit. Take the lowest rung that does what you
need.

| Rung | What you run | The honest limit |
|---|---|---|
| 0 try | `npm run demo`, or `node tools/demo.mjs --site ~/my-site --name my-site` | this computer only; open `localhost`, not `127.0.0.1` |
| 1 share on my LAN | `brew install mkcert nss && mkcert -install`, then `node tools/demo.mjs --tls` (no identity page on this rung: phones read and share); an Android phone on USB needs no certificate and can post: `adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8081 tcp:8081` with the desktop demo | each phone trusts the certificate authority by hand; whoever holds its key can read every trusting phone's secure traffic; Wi-Fi client isolation can block it |
| 2a rented server, no domain | `npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org` | the name is the IP; nip.io is two volunteers and a block list; ports 80 and 443 must be reachable; no DNS pointer, so the page tag expires |
| 2b free static host | `node tools/publish.mjs ... --scope <user>.github.io --tr public --exp 399 --shell`, then steps A3 and A4 | public trackers only; GitHub Pages sends no custom headers; the account can be closed |
| 2c a seeder at home | in a clone of this repository: `npm install node-datachannel` (Node's optional WebRTC binding, which `seed` loads from the package's own folder and which nothing installs for you), then `npx felinar seed dist-publish/site.torrent dist-publish` | loads only while a pin or a seeder holds it; a link on a hub is planned for v0.4; the package is not on npm, so `npx` runs the clone's copy |
| 2d a light link | publish with `--chain` and `--door <host>` (repeatable), then hand out `link.txt` or its QR code; any door opens it: your free static site with a door kit, a friend's host, or the loader on your own computer (`npx felinar dev`, then paste the link into `/_mw/open.html`) ([DEPLOY.md, "Doors without a domain"](DEPLOY.md#doors-without-a-domain)) | a guest door gives an identity for this visit only; a door kit is checked against the pinned release key; doors are tested on loopback only (no gate row G-DR has run on a real host) |
| 3 own domain | [Track A](#track-a-a-new-site-in-shell-mode) below, then step A6 | the price of a domain; nothing else |

Rung 0 is the demo above. Rung 1 is the second variant in its list: `npm run demo -- --tls` serves `https://<lan-ip>:8080/` with the tracker on the same
address at `/tracker` (one address, one port, one certificate for the phone) and prints the steps for iOS and Android.

> Phones run this site only over https. Trust the certificate on each phone once, or connect an Android phone by USB. Whoever gets the key of this local certificate authority can read the secure traffic of every phone that trusts it: keep it on this computer and remove the certificate afterwards.

### Rung 2a: a rented server with no domain

You need a rented server with a public IPv4 address (a droplet or a cloud server; list prices from $4.00 a month at DigitalOcean and EUR 5.99 at
Hetzner, read on 2026-10-20), Docker with Compose 2.17 or newer and rsync on it, ssh access with a key, ports 80 and 443 open to the internet, and a
clone of this repository on the server:

```sh
ssh root@203.0.113.7 'git clone https://github.com/ashkanshokry25-maker/felinar.git /opt/felinar'
```

On your own computer, in this repository with the loader built (`npm run build`), look at the plan first. This prints every host and every command, and
contacts, reads and writes nothing:

```sh
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org --dry-run
```

Then run it without `--dry-run`. In order, it:

1. looks up `203-0-113-7.nip.io` with your computer's DNS resolver and checks that it answers `203.0.113.7` (the service answers a block page for
   addresses used in phishing; if the name is blocked or wrong, it tries `203-0-113-7.sslip.io`, and if that fails too it stops and sends nothing);
2. looks at the server (the clone, rsync, Docker Compose, whether this is a first run or an update) before it makes or publishes anything;
3. makes your owner key on your computer (`~/.config/magnet-web/<name>.jwk`, mode 600, or the file you give with `--key`) and never copies it;
4. publishes the site with `--chain <name>`, your own tracker, `--shell` and `--exp 399`, and prints the date the signed address record expires;
5. sends the web seed, then the allow list, then the loader with the new pointer to the server with rsync, writes the server's `.env` with the
   name and the Let's Encrypt **staging** directory, and starts the box;
6. waits for the staging certificate, switches to production and restarts the box once (a closed port or a wrong address then costs no production
   certificate: Let's Encrypt allows 5 certificates for the same names a week);
7. runs `check-site` against `https://203-0-113-7.nip.io/` from your computer.

It names every host before it contacts one, and it prints these texts, which are the whole story in plain words:

```text
Your site will be at https://203-0-113-7.nip.io/. The name is your server's IP address with dashes: the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close.
If this server gets another IP address, the address changes and visitors start again. A domain you own does not have this problem.
nip.io is a free DNS service run by two volunteers with no uptime promise. If it stops, new visitors cannot open this address; people who already opened the site keep their saved copy.
...
Your signed address record expires on 2027-11-23. After that new visitors cannot load the site until you publish again. Add this date to your calendar.
```

(The date is for a run on 2026-10-20.) To publish a change, run the same command again from the same folder: the key, the ledger and the address
stay, only the files are sent, the snapshot on the server is kept and nothing restarts. Keep the work directory (`dist-ship/<name>`, or `--out`): it
holds the ledger's first block, and an update without it stops, because a new first block is a new ledger for every visitor (`--new-ledger` says that is
meant). `--staging-only` stops on the staging certificate, which browsers do not trust; `--suffix sslip.io` uses only that service; `--remote-dir`
names the clone on the server.

The same steps by hand, every flag as it exists today ([deploy/one-box/README.md](../deploy/one-box/README.md) explains each file):

```sh
node tools/keygen.mjs --out ~/keys/my-site.jwk
node tools/publish.mjs ~/my-site --name my-site --chain my-site --scope 203-0-113-7.nip.io --key ~/keys/my-site.jwk \
  --ws https://203-0-113-7.nip.io/ws/ --cs https://203-0-113-7.nip.io/ws/genesis.json --tr wss://203-0-113-7.nip.io/tracker \
  --ct mailto:you@example.org --exp 399 --shell --out dist-publish
mkdir -p site/ws allow && cp -R dist-publish/shell/. site/ && rm -f site/_headers
cp -R dist-publish/my-site dist-publish/my-site.torrent dist-publish/genesis.json site/ws/
jq -r '.btih, .rendezvousBtih' dist-publish/summary.json > allow/allow.txt
chmod -R u=rwX,go=rX site allow
ssh root@203.0.113.7 mkdir -p /opt/felinar/deploy/one-box/site/ws /opt/felinar/deploy/one-box/allow
rsync -rltp site/ws/ root@203.0.113.7:/opt/felinar/deploy/one-box/site/ws/
rsync -rltp --delete allow/ root@203.0.113.7:/opt/felinar/deploy/one-box/allow/
rsync -rltp --delete --exclude=/ws/ site/ root@203.0.113.7:/opt/felinar/deploy/one-box/site/
ssh root@203.0.113.7 'cd /opt/felinar/deploy/one-box && echo LW_SITE=203-0-113-7.nip.io > .env && docker compose up -d --build'
node tools/check-site.mjs https://203-0-113-7.nip.io/
```

For a name made from an address, `publish` already sets `--chain` to the site name when you leave it out, and says "This name cannot carry a DNS
record; the page tag is the only pointer (expires 2027-11-23)." instead of the 450-byte DNS warning.
The guided setup (`npm run init`) offers no `mailto:abuse@<name>` contact for such a name, because nobody receives mail there: type an https: page or a
mailto: address you read.

### Rung 2b: a free static host

No server and a GitHub account: publish for the host's name and deploy as in steps A3 and A4.

```sh
node tools/publish.mjs ~/my-site --name my-site --chain my-site --scope <user>.github.io --key ~/keys/my-site.jwk \
  --ws https://<user>.github.io/ws/ --cs https://<user>.github.io/ws/genesis.json --tr public --ct mailto:you@example.org \
  --exp 399 --shell --out dist-publish
node tools/check-site.mjs https://<user>.github.io/
```

> This address belongs to GitHub. They can remove it, change their limits or close the account. Your files and your key stay yours: publish the same site elsewhere with the same key.

Netlify Drop and Surge pick or assign the name when you upload: upload once to learn it, publish for that name, and upload again. Cloudflare Pages can
serve the shell but not the web seed ([A4](#a4-deploy-to-github-pages)).

### What a rung without a domain cannot do

- **The address record expires.** Without a DNS record the signed page tag is the only pointer, and it expires. After the date, new visitors cannot
  load the site until you publish again. Returning visitors keep their saved copy.
- **The name is the address.** A name made from the server's IP address changes with the IP, and visitors start again. nip.io is run by two
  volunteers with no uptime promise and blocks addresses used in phishing. An identity page on a bare IP address offers no passkeys, only
  the passphrase card; identities still work there.
- **Reaching the machine.** Home connections behind carrier-grade NAT cannot be reached, and a router without a port forward blocks the certificate
  request. Free hosts can close accounts. Tunnels see everything sent through them and give a new name on every run; the tools never start one
  ([DEPLOY.md](DEPLOY.md#https-and-phone-demos)).
- **Without a pin node or a host copy,** nothing stays available while nobody who has it is online ([DEPLOY.md](DEPLOY.md#pin-node)). Peers see your IP
  address, and sharing a file shows which file you hold.

### Moving up to a domain

Publish again with the same key and the same `--chain` under the new hostname, then add the DNS record (step A6). The ledger, its rendezvous swarm and
the infohash stay the same, and the old and the new address can run together as one swarm. The new hostname is a new origin, so saved copies, consent
and key pins start over.

## Track A: a new site in shell mode

The example assumes your site is in `~/my-site` and will live at `https://example.com/`. Replace both.
The site must be served at the root of its origin: `https://example.com/` or `https://<user>.github.io/`
work, a sub-path such as `https://<user>.github.io/<repo>/` does not.

### A1. Create the owner key

```sh
node tools/keygen.mjs --out ~/keys/my-site-owner.jwk
```

```text
wrote /Users/you/keys/my-site-owner.jwk (mode 600); keep it offline and backed up
fingerprint 5666dca3
owner=p256:BMINwovK50fOaGmPEb4I19RjFbHd2OvjPmDGeSOjZ4qXN8yiHDttLSR8GTqTa7HMUgi9yVfCYs4QRQUwvmk3hNg
```

The owner key signs your pointer and the site ledger's policy. It never goes into a browser, a web
server or a repository (`*.jwk` is in `.gitignore`). Back it up: visitors remember this key on their
first visit and warn before they accept a different one. `publish` refuses a key file that other users
can read.

### A2. Publish

```sh
node tools/publish.mjs ~/my-site --name my-site --scope example.com --key ~/keys/my-site-owner.jwk \
  --ws https://example.com/ws/ --tr public --cs https://example.com/ws/genesis.json \
  --ct mailto:abuse@example.com --shell --out dist-publish
```

| Flag | Meaning |
|---|---|
| `~/my-site` | the folder with your `index.html` and everything it uses (root-relative URLs work) |
| `--name my-site` | the torrent name; keep it the same for every version (it is part of the web seed paths) |
| `--scope example.com` | the hostname visitors type; the pointer is signed for it |
| `--ws https://example.com/ws/` | the web seed: your host serves the site's files under `/ws/`, so a site loads when nobody else is online. On the loader's own origin it needs no CORS |
| `--tr public` | the four public WebSocket trackers; add your own with `--tr wss://tracker.example.com` (repeatable). Without `--tr` visitors never find each other |
| `--cs https://example.com/ws/genesis.json` | where visitors fetch the ledger snapshot, so the first visitor gets the ledger when nobody else is online |
| `--ct mailto:abuse@example.com` | who answers abuse and legal notices, signed into the pointer ([DEPLOY.md](DEPLOY.md), "Owner duties") |
| `--shell` | writes `dist-publish/shell/`: the loader with your pointer stamped into `index.html` and `404.html` |

A site with shared data adds the ledger policy, for example `--policy open --bits 16` for a guestbook
anyone can sign (each post pays a 16-bit proof-of-work fee). The default policy lets only the owner and
moderators write. A site whose visitors only read needs no identity page at all: you change it by publishing again,
or with `tools/ledger-admin.mjs` and the owner key offline. [CRUD.md](CRUD.md) explains the choices. Visitors sign in before they write, at an identity page the site names with
`--idp https://<identity origin>`. By design, the project hosts no identity page (owner decision N-2): run your own
([DEPLOY.md](DEPLOY.md#the-identity-origin-running-your-own-with-toolsbuild-idpmjs)) or use one you trust, and pass
its origin, or every post fails with "The identity page could not be reached".

Abridged output of a real run with the example site:

```text
Left out of the torrent (1):
  README.md  README.md
warning: the pointer is 628 bytes in 3 TXT strings; pointers should stay at or under 450 bytes (fewer --tr and --ws entries make it shorter)
warning: the web seed https://example.com/ws/ has not been checked: after uploading, run publish again with --verify-ws (or node tools/check-webseed.mjs https://example.com/ws/ dist-publish/site.torrent) before you switch the pointer
felinar publish (shell mode)
  site      examples/peer-guestbook -> my-site (10 files, 62 KiB)
  btih      bdc1ee0895adb4416d08e37e0c563b779d07dff4
  ledger    mw1:kg166yEUTGpK0992FC45llLPOMA (owner 5666dca3, gen 14196acf68e4f952..., new)
  ledger rv f7238bd3d1c5bf8a0f6be3b7e99295df27b8973d (the ledger rendezvous swarm; allow it on your tracker too: --allow dist-publish/summary.json)
  xs        https://example.com/ws/my-site.torrent
  ws        https://example.com/ws/
  tr        wss://tracker.webtorrent.dev wss://tracker.openwebtorrent.com wss://tracker.novage.com.ua wss://open.ftorrent.com
  pointer   seq 1792457684, expires 2027-01-18 (90 days)
  created   2026-10-20 (git)
Size report (v0.2.1 E2):
  files       10
  total       62 KiB (63854 bytes)
  largest     js/app.js, 20 KiB
  metadata    772 B .torrent, 1 pieces, bootstrapped over HTTP (xs=)
  visitors    desktop yes (128 MiB), mobile Wi-Fi yes (48 MiB), mobile cellular yes (24 MiB)
  hosts       Cloudflare Pages (free): fits; GitHub Pages: fits; S3 / R2 / B2: fits
...
Ledger snapshot: upload dist-publish/genesis.json (a JSON array of blocks; later ones come from tools/snapshot.mjs) to https://example.com/ws/genesis.json.
...
Deploy order: (1) upload dist-publish/my-site/ and my-site.torrent to the web seed base https://example.com/ws/,
(2) node tools/check-webseed.mjs https://example.com/ws/ dist-publish/site.torrent, (3) switch the pointer (meta.html into
the shell <head>, done in dist-publish/shell/, or dns.txt), (4) keep the previous version's files for at least 7 days.
```

What the lines mean:

- **Left out of the torrent:** dot files and folders (`--include-dot <path>` publishes one you need; `.env`,
  version-control data and credentials never go in), a `README.md` at the top of the folder,
  `node_modules`, and `_redirects` and `_headers`, which become routing rules in `/.mw/site.json`.
  `publish` also stops on key, token, dump and backup files and on private keys or tokens inside files
  (`--allow-secret <path>` once you have checked one).
- **The size warning** is normal with four trackers: a pointer may be at most 900 bytes and `publish`
  refuses anything longer.
- **ledger rv** is the swarm where visitors of every version of your site meet to sync the ledger. Your own
  tracker must allow it as well as the site's infohash; `--allow dist-publish/summary.json` does both.
- **created** is the torrent's creation date. It never changes the infohash; taking it from git (or from
  `--date` or `SOURCE_DATE_EPOCH`) keeps the `.torrent` byte for byte reproducible.
- **Size report:** whether the site fits what phones and desktops accept and what common hosts allow.

Publishing the same files with the same name gives the same infohash, so you can publish again at any time.

### A3. Assemble one deploy tree

The shell goes at the root of the host, the web seed under `/ws/`:

```sh
rm -rf deploy-root && mkdir -p deploy-root/ws
cp -R dist-publish/shell/. deploy-root/
cp -R dist-publish/my-site dist-publish/my-site.torrent dist-publish/genesis.json deploy-root/ws/
touch deploy-root/.nojekyll            # GitHub Pages: without it, /_mw/ and /.mw/ are dropped
echo example.com > deploy-root/CNAME   # GitHub Pages with a custom domain only
```

Files that crawlers and other tools expect at the host root, such as `robots.txt`, a favicon or
`.well-known/`, go next to the shell as well: in shell mode the host answers every unknown path with the
loader, and crawlers that do not run it see only that page. Shell mode is not for pages that must be
indexed; see [MIGRATION.md](MIGRATION.md) for search and link previews.

### A4. Deploy to GitHub Pages

Use a user or organisation site (`<user>.github.io`) or a repository with a custom domain, with
"Deploy from a branch" (root folder) in Settings, Pages:

```sh
git clone https://github.com/<user>/<user>.github.io.git ../pages   # next to this clone, not inside it
cp -R deploy-root/. ../pages/
cd ../pages && git add -A && git commit -m "Publish my-site" && git push
```

Copying over the checkout, instead of deleting it first, keeps the files a new version drops;
[DEPLOY.md](DEPLOY.md) covers keeping a whole previous version for the 7 days visitors on it may need.
GitHub Pages sends no custom headers and caches every file for 10 minutes (`max-age=600`), so an update
can take that long to reach returning visitors, and its terms rule out sites "primarily directed at
facilitating commercial transactions" ([research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md),
section 11). A workflow template for publishing from CI is in `deploy/github-actions/publish-site.yml`.

**Cloudflare Pages** can serve the shell, but not the web seed: it answers `Range` requests with the
whole file (status 200), so piece downloads from it fail. Put `--ws` on a host that answers `Range` with
206 and sends CORS headers, for example Cloudflare R2 on a custom domain (the research's recommended
web seed, not yet checked against a real bucket), and run `tools/check-webseed.mjs` against it before
you switch the pointer. Host recipes and their caveats are in [DEPLOY.md](DEPLOY.md).

### A5. Check it

```sh
node tools/check-site.mjs https://example.com/
```

`check-site` contacts the internet and prints each target before it connects. It reads the page tag,
looks up the DNS pointer, fetches the `.torrent`, requests every web seed file with `Range`, connects to
every tracker and validates the snapshot. Output of a run against the local demo (a real site prints
`https://` and `wss://` URLs):

```text
[ok]   page: HTTP 200, 3.4 KiB
[info] page: loader shell (shell mode)
[ok]   /mw-sw.js: 69 KiB, text/javascript
[ok]   /_mw/boot.js: matches the integrity attribute in the page
[ok]   meta pointer: signed, seq 1792454951, owner 716193cf, expires 2026-11-19 (29 days left)
[ok]   xs: http://localhost:62996/ws/peer-guestbook.torrent: "peer-guestbook", 10 files, 62 KiB, infohash matches
[ok]   web seed: http://localhost:62996/ws/: every file answers Range with 206 and the first and last piece hash correctly (PASS)
[ok]   tracker: ws://localhost:62997 connected in 4 ms; 0 seeder(s), 0 leecher(s) online now
[ok]   snapshot: 1 blocks, 503 B, the genesis block is there and valid
OK: 0 failure(s), 0 warning(s).
```

It exits 0 when every check passes, 1 when one fails and 2 on a usage error, so it can run from CI or
cron. `--headless` also loads the page in Playwright Chromium (`--consent` clicks "Share and load",
`--screenshot <file>` saves what it saw). A host that drops dot files fails here, because the web seed
check requests every file, `ws/my-site/.mw/files.json` included.

### A6. Optional: the DNS TXT record

The page tag in `index.html` is enough to load the site. A TXT record is a second update channel: once a
visitor has chosen "Share and load", the loader also reads the pointer over DNS-over-HTTPS (Cloudflare,
then dns.sb, then Google), and a record signed by the same key with a higher `seq` than the page tag
wins. That service sees the visitor's IP address and your site's name, so name it in your privacy
notice ([PRIVACY.md](PRIVACY.md)).

`dist-publish/dns.txt` holds everything:

```text
name:  _magnet.example.com
type:  TXT
ttl:   300
value: "v=mw1; btih=...; dn=my-site; ..." "...orrent.com; owner=p256:...; seq=" "1792457684; exp=1800233684; sig=..."
```

The value is split into quoted strings of at most 255 bytes, which resolvers join with no separator.
`dns.txt` also has a zone-file line, an Amazon Route 53 change batch and a Cloudflare API call. Create
the record before visitors arrive: resolvers remember a missing record for the zone's negative TTL, 5 to
30 minutes on the zones the research measured ([research/05-doh-dns-txt.md](research/05-doh-dns-txt.md), F12).
Check it with `dig +short TXT _magnet.example.com`, and update it every time you publish. Drop-in pages never read
DNS, so Track B does not need this record.

## Track B: an existing site with drop-in

The example assumes your built site is in `~/my-site/public` and lives at `https://www.example.com/`. To try
drop-in on this computer first, with a local tracker and dev server, follow [MIGRATION.md, "Try it on this
computer first"](MIGRATION.md#try-it-on-this-computer-first), or the commands for the drop-in example in
[examples/existing-site-dropin/README.md](../examples/existing-site-dropin/README.md#try-it-by-hand).

### B1. Check that the site fits

- It is served over HTTPS from the root of its origin.
- Nothing lives under `/_mw/` or at `/mw-sw.js` (`publish` refuses to run if it does).
- Pages that should share are not sent with `Cache-Control: no-store`: such pages run host-only.
- If the site has its own Service Worker, felinar does not register over it. It runs the ledger and
  sharing without serving files and logs one console line with the two-line integration recipe
  ([RUNBOOK.md](RUNBOOK.md), section 10, step 5).

Framework and CMS notes, and what a site loses or keeps, are in [MIGRATION.md](MIGRATION.md) and
[COMPATIBILITY.md](COMPATIBILITY.md).

### B2. Add the script tag

Every HTML page gets one tag in its `<head>`:

```html
<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>
```

Or let `publish` add it with `--inject-script`. Two options on that tag: `data-mw-consent="site"` (your
site explains sharing itself and calls `mw.consent.request()`, see [SDK.md](SDK.md)) and
`data-mw-sw="off"` (never register `/mw-sw.js`; the ledger and sharing still run).

### B3. Publish

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

Abridged output of a real run with a four-page test site:

```text
warning: the pointer is 577 bytes in 3 TXT strings; pointers should stay at or under 450 bytes (fewer --tr and --ws entries make it shorter)
felinar publish (dropin mode)
  site      .../public -> my-site (4 files, 791 B)
  btih      2403d9029b0b3ef65eb0b22cfa27128de6467148
  ledger    mw1:RzMqrLLDoV8Y7dUoxbTE6uwq9S0 (owner 5666dca3, gen 744cc70cbea4d851..., new)
  ledger rv d5d250d1554bc6d41d6a44a39af08fe75b7cf75b (the ledger rendezvous swarm; allow it on your tracker too: --allow dist-publish/summary.json)
  xs        /_mw/t/2403d9029b0b3ef65eb0b22cfa27128de6467148.torrent
  ws        (none)
  tr        wss://tracker.webtorrent.dev wss://tracker.openwebtorrent.com wss://tracker.novage.com.ua wss://open.ftorrent.com
  pointer   seq 1792459345, expires 2027-01-18 (90 days)
  created   no creation date (pass --date, set SOURCE_DATE_EPOCH or publish from a git work tree)
Size report (v0.2.1 E2):
  ...
No --cs: the ledger root (gen=) reaches a visitor only from another visitor. Upload genesis.json (or a snapshot from tools/snapshot.mjs) and pass its URL as --cs.
...
Egress: on unmetered networks each drop-in visitor downloads the whole copy (791 B of non-HTML files) from this host once, at idle after the first page view; cellular and Save-Data visitors fill it from peers only. Budget host egress for copies, not page views: in a model (arithmetic, not a measurement), a 20 MB copy completed after a 1.5 MB page view costs the host 13.3 times the bytes of that view. Leaving heavy files out of the torrent (--ignore <path>: they stay on this host only) limits it.
CSP: the drop-in script inserts no Content-Security-Policy of its own. If the site sends one, add (dist-publish/csp.txt):
...
Deploy dist-publish/site/ in this order: (1) every non-HTML file, including /_mw/, /.mw/ and /mw-sw.js,
(2) the HTML pages last. Keep the previous version's files for at least 7 days. For example:
...
```

The torrent holds every non-HTML file plus `/.mw/files.json` (the SHA-256 of each file) and
`/.mw/site.json`. HTML stays on your host: each page carries the signed pointer as the first child of its
`<head>`. There is no `ws=`: the drop-in Service Worker turns your host into the web seed by answering
`/_mw/ws/` from your own files. A site whose ledger takes visitor posts adds `--policy` and `--cs`, for
example `--policy open --cs /ledger/genesis.json`, and uploads `dist-publish/genesis.json` to that path
(relative `--cs` URLs are allowed in drop-in mode).

### B4. Deploy

Deploy `dist-publish/site/` to the host root. It is your site with the pages stamped, plus `/_mw/` (the
runtime), `/mw-sw.js`, `/_mw/t/<btih>.torrent`, `/.mw/` and an empty `.nojekyll`. Order matters when
files are uploaded one by one: every non-HTML file first, the HTML pages last, so no stamped page points
at files that are not there yet. With S3:

```sh
aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*.html" --exclude "*.htm"
aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*" --include "*.html" --include "*.htm"
```

Hosts that switch a whole deploy at once (Cloudflare Pages, GitHub Pages) take care of the order, but
they also drop the previous deploy's files. Keep the previous version's files for at least 7 days by
copying them into the new upload: pages that are still open load their lazy files from the host.

- **Cloudflare Pages:** `npx wrangler pages deploy dist-publish/site --project-name my-site`. Your
  `_redirects` and `_headers` stay in the deploy copy and keep working. Drop-in does not need `Range`
  support, so Cloudflare Pages works here.
- **GitHub Pages:** copy `dist-publish/site/.` over the checkout of the Pages branch and push, as in
  step A4. The `.nojekyll` file is already there.

Serve `/mw-sw.js` with `Cache-Control: no-cache` where your host lets you set headers, and purge your
CDN after every deploy.

### B5. Check it

```sh
node tools/check-site.mjs https://www.example.com/
```

For a drop-in site `check-site` downloads every file of the torrent from your host and checks every
piece, which catches image optimisers or minifiers that change bytes after publishing. To check before
the HTML goes live, upload the non-HTML files, then publish again with `--verify-host
https://www.example.com/`: it withholds the stamped pages until the host serves the exact bytes.

Then look at it in a browser:

- With JavaScript off, every page looks exactly as before.
- After 3 seconds on screen the first-run card appears at the bottom of the page.
- The second page view gets its styles, scripts and images from the visitor's copy: the browser's
  network panel shows them answered by the Service Worker.
- In the console, `window.__mwDropin.inspect()` shows the state: `copy`, `source`, `consent`, `sw.mode`.

`examples/existing-site-dropin/EXPECTED.md` lists every check the end-to-end tests run against the
drop-in example.

### B6. Content-Security-Policy

The drop-in script inserts no policy of its own. If your site sends one, add what
`dist-publish/csp.txt` lists: `worker-src 'self'` (the Service Worker and the fee worker), `connect-src`
for the tracker `wss:` URLs, and, if your `script-src` uses nonces or `'strict-dynamic'`, a nonce on the tag
or the integrity hash of `/_mw/mw.js`. STUN hosts, `blob:`, `'unsafe-inline'` and `'unsafe-eval'` are not
needed.

## What visitors see

| Moment | Shell mode (loader status bar: top on desktop, bottom on phones) | Drop-in mode |
|---|---|---|
| First page view | "Starting...", "Finding this site...", then the site, downloaded from the web seed while the card waits | your page from your host, exactly as before |
| The first-run card | "This site is delivered peer-to-peer." with [Share and load] [Load from host only] [Settings]; nothing connects to a tracker, a peer or a DNS-over-HTTPS service before a choice | the same card at the bottom of the page, after 3 seconds on screen, in a closed shadow root |
| On a phone | "On this phone sharing stays off until you turn on "Share on this network" in Settings." | the same |
| The key | "First time on this device: the publisher key of this site is remembered from now on." | the same line, inside the card |
| Pointer badge | "Pointer: page tag, signed", or "Pointer: DNS via Cloudflare, signed, key remembered since 2026-10-19" | none (`inspect().signed`) |
| Source | "From the host", "From other visitors", "From this device" | none (`inspect().source`) |
| Ledger line | "Ledger: 1 entry, no peers connected", then "Ledger: 3 entries, syncing with 1 peer" while copies differ, and "Ledger: 1,204 entries, in sync with 3 peers" | none; your site can show its own with the SDK |
| Posting | "Posting: working out the spam fee for this post (12,345 tries so far)" | none; your site can show `onProgress` |
| A new version | "Update available: reload" | the next page view uses it |

"In sync" means the same set of entries as that many connected peers. The strings are in
`src/loader/strings.js`; their wording is fixed by [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md)
section 4.

## Where the files land

| In `dist-publish/` | What it is | Where it goes |
|---|---|---|
| `shell/` | the loader, your pointer stamped into `index.html` and `404.html` | the host root (Track A) |
| `site/` | your site with stamped pages, `/_mw/`, `/mw-sw.js`, `/_mw/t/<btih>.torrent` | the host root (Track B) |
| `<name>/` | the web seed copy of your site's files | `<ws>/<name>/` (Track A) |
| `<name>.torrent`, `site.torrent` | the torrent, the same bytes twice | `<ws>/<name>.torrent`, the default `xs=` (Track A) |
| `genesis.json` | the ledger's first entry: its policy, signed by the owner key | the `--cs` URL |
| `pointer.txt`, `meta.html` | the signed pointer, and the same as a page tag | already stamped into the pages |
| `dns.txt` | the TXT record with provider snippets | your DNS zone (optional, Track A) |
| `magnet.txt` | a magnet link for the site | for hub links |
| `summary.json` | everything above as JSON | `node tools/tracker.mjs --allow` reads it |
| `webseed-layout.txt` | every web seed URL, the HTTP contract and S3 CORS rules (Track A only: drop-in writes none) | reference |
| `csp.txt` | Content-Security-Policy additions | your host's CSP, if it sends one |
| `mw-sw-kill.js` | the kill switch | keep it for an emergency ([RUNBOOK.md](RUNBOOK.md), section 11) |
| `sdk-static.js` | a static `/_mw/sdk.js` for a plain copy of the site | only if you remove the runtime |

## Keep it running

- **Re-sign before the pointer expires.** A pointer is valid for 90 days by default (`--exp` up to 399).
  Run the same publish command again and deploy: same files, same infohash, a new signature.
  `check-site` prints the days left; 14 days before the end visitors see "The publisher must re-sign
  this site's pointer before" and the date. A new visitor cannot use an expired page tag; a returning
  one sees "Pointer expired on" the date, with the last known version.
- **Publish a new version** with the same command and the same `--out`, so the ledger keeps its
  genesis. Deploy in the order above. Visitors on the old version see "Update available: reload".
- **Refresh the ledger snapshot** behind `--cs` from time to time, so new visitors start from recent
  entries when nobody is online: [CRUD.md](CRUD.md), "Export and backup".
- **Run your own tracker** next to the public ones for production:
  `node tools/tracker.mjs --allow dist-publish/summary.json` (it serves only your site and its ledger
  swarm), with deployment files in `deploy/tracker/`.
- **Keep one copy always online** if the ledger must be reachable when no visitor is: `tools/pin.mjs`
  and `deploy/pin/`.
- **Know the kill switch** before you need it: [RUNBOOK.md](RUNBOOK.md), section 11.

## Next

- [ONBOARDING.md](ONBOARDING.md): the intake for a team, roles, the 30-60-90 plan, the release gate.
- [CRUD.md](CRUD.md) and [SDK.md](SDK.md): shared data on the site ledger, and the full API.
- [DEPLOY.md](DEPLOY.md) and [OPERATIONS.md](OPERATIONS.md): hosts, owner duties, privacy notice, abuse
  handling.
- [FAQ.md](FAQ.md): short honest answers.
