# A rendezvous on Cloudflare Workers, without a server

This folder runs the job of `tools/tracker.mjs` as a Cloudflare Worker with one Durable Object: a WebSocket tracker that
passes WebRTC offers and answers between visitors of the same site, so they find each other. It never sees the site's files
or its posts. It fits the Workers Free plan, needs no server and no domain, and answers at a name you choose under
`workers.dev`.

Why another way to run one: the four public trackers are on block lists, by name. On one of our computers a DNS filter
(HaGeZi Anti-Piracy) answers 0.0.0.0 for `tracker.webtorrent.dev` and `open.ftorrent.com`, and browser block lists match
host names that contain `tracker`, `torrent`, `peer` or `bt` ([deploy/tracker](../tracker/README.md), [w2b-01](../../docs/research/w2b-01-tracker-resilience.md), F2).
A visitor behind such a filter still loads the site from its web seed, but meets nobody, so posts stop travelling for them.
[deploy/tracker](../tracker/README.md) answers that with a tracker on a neutral host name, which needs a server and a
domain. This Worker needs neither: `rtc-<name>.<your subdomain>.workers.dev` carries none of those words, and `workers.dev` is
a suffix that thousands of ordinary applications use.

| File | What it does |
|---|---|
| `worker.js` | the Worker (`/healthz`, `/stats.json`, WebSocket upgrades) and the Durable Object `Rendezvous`, which accepts the sockets with the Hibernation API, keeps each connection's state on the socket, and closes idle ones from an alarm |
| `rtc.js` | the protocol (bittorrent-tracker 11.2.3's WebSocket messages, which the loader speaks), the allow list and the caps; no platform code, so a unit test drives it with fake connections |
| `wrangler.jsonc` | the Worker's settings: the object binding, the SQLite-backed class (what the Free plan allows), the vars below |

## What you need

- A Cloudflare account (the Free plan is enough) with a `workers.dev` subdomain (Workers & Pages, Overview: the dashboard
  offers to create one; the subdomain is part of every Worker's name, so pick a neutral one).
- An API token for it: the dashboard's "Edit Cloudflare Workers" template, limited to that account, is enough; a custom
  token needs Account, Workers Scripts, Edit, and Account Settings, Read. Give it an expiry. The token and the account id
  go into the environment as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, never into a file you commit.
- Node and `wrangler` 4, run from a copy of this folder outside the repository: `wrangler` writes files next to the
  config it runs with, and it rewrote `package.json` when it was run inside a clone.

## Start it

```sh
cp -R deploy/rtc-worker ../rtc && cd ../rtc
npm init -y > /dev/null && npm install --no-save wrangler@4
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
# the infohashes to serve: the site's btih and rendezvousBtih and its chat lane, all in publish's summary.json
ALLOW="$(node -p "const s = require('/path/to/dist-publish/summary.json'); [s.btih, s.rendezvousBtih, require('crypto').createHash('sha1').update('mw-chat1|' + s.ledgerId).digest('hex')].join(' ')")"
npx wrangler deploy --name rtc-mysite --var "ALLOW:$ALLOW"
```

`--name` is the Worker's name and the first label of its address, `https://rtc-mysite.<subdomain>.workers.dev`. Then check it:

```sh
curl https://rtc-mysite.<subdomain>.workers.dev/healthz          # prints: ok
npx felinar check-site https://example.com/ --tr wss://rtc-mysite.<subdomain>.workers.dev
```

Publish your sites with it first in the list, then one or two public trackers, as [DEPLOY.md](../../docs/DEPLOY.md), "Your
own tracker", says:

```sh
npx felinar publish ./site --name my-site --scope example.com --key owner.jwk --shell \
  --ws https://example.com/ws/ --tr wss://rtc-mysite.<subdomain>.workers.dev --tr wss://tracker.openwebtorrent.com --out dist-publish
```

## The allow list and the caps

- `ALLOW` holds the infohashes this rendezvous serves, 40 hex each, separated by spaces, commas or lines (`urn:btih:` and
  magnet links are read too; `#` starts a comment). List two for every version you serve, the site's `btih` and the
  ledger's `rendezvousBtih`, plus the site's chat lane (`sha1("mw-chat1|" + ledgerId)`, as above). Keep the previous
  version's hashes for at least 7 days. The word `uploads` (or `UPLOADS=1`) turns uploads mode on for sites with files or
  media: unlisted swarms are served too, at most 10,000 in all. `OPEN=1` serves every infohash (anyone can then use this
  Worker to relay offers for anything; the default refuses what is not listed).
- To change the list, deploy again with the new `--var`, or edit `vars` in `wrangler.jsonc` and deploy. There is no file to
  reload: the vars are part of the deployment.
- Caps, per connection and in all: 32 swarms per connection (a browser uses one connection per tracker for all its
  torrents, so a pin node with many file swarms wants the Node tracker instead), 20 offers per announce, a 128 KiB
  message, and a connection that announced nothing for 20 minutes is closed by a sweep that runs every 5 minutes. The
  announce interval the replies ask for is `INTERVAL_S` (120), while `tools/tracker.mjs` asks for 24 s (bittorrent-tracker
  divides its interval by five for WebSocket clients): peers still meet on a newcomer's first announce, so the difference
  shows only when offers go unanswered, which a loader retries after 120 s here instead of 24; a lower `INTERVAL_S` costs
  requests. A scrape must name its infohashes (a bare scrape answers an empty list, as the Node tracker does).
- `/stats.json?token=<STATS_TOKEN>` prints `{ open, uploads, allowed, swarms, unlisted, peers, sockets, interval }` when
  `STATS_TOKEN` is set to a long random value; with it empty the counts are not served.

## What it costs, and the limits

On the Workers Free plan the object may serve 100,000 requests a day: a connection counts as one, and 20 incoming
WebSocket messages count as one (outgoing ones are free). A visitor announces each of its swarms every 120 s, and its loader
also sends an announce without offers on a socket that was silent for 55 s (`wire.keepaliveAnnounceMs` in
`src/loader/config.js`), so a visitor costs 110 to 180 requests a day: 108 with three swarms (site, ledger, chat) whose
announces are spread out, 180 with them in phase, 144 with two swarms. The plan covers roughly 550 to 900 visitors online all
day, or many more who come and go; these numbers are computed from the code, not measured. The object sleeps between messages
(hibernation), so its running time stays near zero; a wake rebuilds the connections from the state kept on the sockets, and
that state is written again at least every 5 minutes so a live connection is not swept as idle after a wake. One object holds
every swarm; above those numbers, or for a hub, run one Worker per site. Cloudflare's own plan limits and prices are at
[developers.cloudflare.com/durable-objects/platform/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

What it doesn't do: no per-IP quota, no `Origin` allow list, no metrics beyond `/stats.json`, no server ping (the loader
re-announces within the interval, which keeps a socket alive), no hub lanes (list a hub's follow lane by hand, `tools/tracker.mjs`
prints it). Visitors' loaders reconnect within a second or two when the object closes a socket or a deployment replaces it.

## Privacy

Cloudflare, as the operator of the Worker's host, sees every visitor's IP address, the infohash they announce and their
WebRTC session descriptions, as any tracker host does; the Worker itself logs nothing. Leave Workers Logs and observability
off for it, name the rendezvous and Cloudflare in your privacy notice ([PRIVACY.md](../../docs/PRIVACY.md)), and never log
infohash and IP address together.

## What was tested

On 2026-11-01: the unit tests of `test/unit/deploy-rtc-worker.test.mjs` (the protocol through fake connections, the allow
list and the caps, the state kept on a socket and restored after a restart, the sweep; the Worker's routes and the object
through a fake platform), and `wrangler dev` 4.156 (the local Workers runtime) with two raw WebSocket clients: announce
replies, an offer passed to the other peer, an answer passed back, scrape, a refused unlisted infohash, `/healthz` and
`/stats.json`. Later the same day, a real loader on loopback: a site published with the Worker under `wrangler dev` as its only
tracker, two isolated headless Chromium visitors that met through it in about 200 ms, joined the site and ledger swarms and
synced a signed post in under 4 s, and `check-site --tr ws://127.0.0.1:8787` passing; 21 raw protocol checks against
bittorrent-tracker 11.2.3's answers found three differences, fixed the same day (an answer no longer turns a seeder into a
leecher in the counts, a bare scrape lists nothing, `event: "empty"` is an update), and the fake platform showed a fourth,
also fixed (the state on a socket is written again at least every 5 minutes, so a sweep after a wake keeps a live connection).
Not tested: a deployment on Cloudflare itself, hibernation on the real platform, and load.
