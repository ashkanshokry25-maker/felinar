# Your own tracker, with Docker Compose

This directory runs `tools/tracker.mjs` (a WebSocket tracker built on `bittorrent-tracker` 11.2.3) behind
[Caddy](https://caddyserver.com/), which gets the TLS certificate and renews it. Visitors' browsers use a tracker
to find each other: the tracker passes WebRTC offers and answers between visitors of the same site. It never
sees the site's files or its posts.

Why run one: the four public trackers have no service level or abuse policy, and a DNS block list (HaGeZi
Anti-Piracy) blocks all four by name. A visitor behind such a filter still loads your site from the web seed,
but meets other visitors only through a tracker both can reach, so the site ledger stops syncing for them
([PRODUCTION-DIGEST](../../docs/research/PRODUCTION-DIGEST.md), verdict 3 and section 7.1;
[w2b-01](../../docs/research/w2b-01-tracker-resilience.md), F2). A tracker on a neutral hostname under your own
domain is on none of those lists.

| File | What it does |
|---|---|
| `docker-compose.yml` | two containers: `tracker` (built from this repository) and `caddy` (the official image); only Caddy is reachable from outside |
| `Caddyfile` | HTTPS for `TRACKER_DOMAIN`; only WebSocket upgrades reach the tracker; a masked access log |
| `allow/allow.txt` | yours to create: the infohashes this tracker serves (below) |

## What you need

- A Linux server with Docker Engine and Docker Compose 2.17 or newer (the tracker image is defined inline,
  `dockerfile_inline`), and a clone of this repository on it: the image is built from the repository root.
- Ports 80 and 443 (TCP), and 443 (UDP) for HTTP/3, open to the internet. Caddy uses port 80 for the ACME
  challenge and for the redirect to HTTPS.
- A DNS `A` (and `AAAA`) record for a neutral hostname that points at the server, such as `rtc.example.com`.
  Block lists match hostnames that contain `tracker`, `torrent`, `peer` or `bt`, and free dynamic-DNS suffixes
  (EasyPrivacy blocks third-party WebSockets to `duckdns.org`); w2b-01, F2.

## Start it

From this directory:

```sh
mkdir -p allow
jq -r '.btih, .rendezvousBtih' /path/to/dist-publish/summary.json > allow/allow.txt
echo 'TRACKER_DOMAIN=rtc.example.com' > .env
docker compose up -d --build
```

`allow/allow.txt` holds one infohash, magnet link or pointer record per line; `#` starts a comment. Without `jq`,
print the two values with Node: `node -p "const s = require('./dist-publish/summary.json'); s.btih + '\n' + s.rendezvousBtih"`.

Then check it from another machine:

```sh
curl https://rtc.example.com/healthz          # prints: ok
npx felinar check-site https://example.com/ --tr wss://rtc.example.com
```

`check-site` opens a WebSocket to every tracker in the pointer (and to `--tr`), sends a `stopped` announce for
the site's infohash, which the allow list must accept, and asks for the number of seeders and leechers online.

Publish your sites with the tracker first in the list, then one or two public trackers. Fewer trackers also
keep the pointer under 450 bytes:

```sh
npx felinar publish ./site --name my-site --scope example.com --key owner.jwk --shell \
  --ws https://example.com/ws/ --tr wss://rtc.example.com --tr wss://tracker.webtorrent.dev --out dist-publish
```

## The allow list

`tools/tracker.mjs` serves only the infohashes it is allowed; it refuses to start without `--allow` unless you
pass `--open` (anyone could then use it to relay WebRTC offers for any infohash; this setup never does). The rule:

- **List two infohashes for every version you publish:** the site's `btih` and the site ledger's
  `rendezvousBtih` (the ledger swarm, since 0.2.1), both in that version's `summary.json`. `publish` prints both.
  With only the `btih`, visitors download the files but their ledgers never meet.
- **Chat, files and media (v0.3):** the site's chat lane is `sha1("mw-chat1|" + ledgerId)`. A `summary.json` given
  with `--allow` adds it by itself; for `allow.txt`, print it with
  `node -p "require('crypto').createHash('sha1').update('mw-chat1|' + require('./dist-publish/summary.json').ledgerId).digest('hex')"`
  (`ship` writes it for the one-box). File, private media and member ledger swarms get a new infohash with every upload, so add a line `uploads` to `allow.txt` when the
  site has files or media on (a `summary.json` with them on does the same). The tracker then serves unlisted
  infohashes too, at most 256 per connection and 10,000 in all, while the listed ones are always served (DEPLOY.md,
  "Your own tracker", says what that costs). A hub adds a line `hub <its host name>` for its follow lane. Without
  `uploads`, every file swarm is refused and nobody finds a peer.
- **Keep the previous versions for at least 7 days.** Visitors who still have the old version open keep
  announcing it until they reload.
- **Update the file atomically:** write a new file in `allow/` and rename it over `allow.txt`. The directory is
  mounted, not the file, so the container sees the rename (a bind-mounted single file would keep the old copy).
- **Changes apply within seconds:** the tracker checks the file's modification time at most once a second, when an
  announce arrives, and the next announce after that uses the new list. While the file is being replaced, the
  last good list stays in force.
- An empty list refuses every announce, and the tracker warns about it at start.

```sh
{ cat allow/allow.txt; jq -r '.btih, .rendezvousBtih' dist-publish/summary.json; } | sort -u > allow/allow.txt.new
mv allow/allow.txt.new allow/allow.txt
```

Removing a site's infohashes from the list is also how this tracker stops introducing its visitors to each other
after a takedown ([OPERATIONS.md](../../docs/OPERATIONS.md)). Visitors still load the site from its web seed and
through other trackers in its pointer.

## Sizing

Measured on `bittorrent-tracker` 11.2.3, which `tools/tracker.mjs` also runs on, with the research's reference
tracker (it adds guards to the same library; `tools/tracker.mjs` itself was not load-tested). Source:
[PRODUCTION-DIGEST](../../docs/research/PRODUCTION-DIGEST.md), 7.1.

| | Value |
|---|---|
| Memory | about 25 KiB per open WebSocket plus about 70 MB; 20,000 sockets in about 0.57 GB; on Linux, 10,200 idle sockets used 287 MB |
| CPU | 4,002 sockets announcing once a second used 0.81 of a core; one core saturates near 15,000 to 23,000 announces a second |
| Expected load | 10 to 1,400 open sockets for small sites |
| Egress | about 50 bytes a second per socket with the stock 5 offers per 120 s announce |
| Hosting | Oracle Always Free A1 at $0 (it reclaims instances idle for 7 days), or a $4 to $7 VPS |

`docker-compose.yml` caps the tracker at 1 GiB of memory (`mem_limit`, room for roughly 35,000 sockets by the
figures above) and 65,536 open files (`ulimits`). Raise both together for more.

## Monitoring

What there is:

- `https://<TRACKER_DOMAIN>/healthz` answers `ok` through Caddy; Docker's health check calls it inside the
  container every 30 s (`docker compose ps` shows `healthy`).
- `check-site` from CI or cron, as above: it fails when the tracker refuses the site or does not answer
  ([OPERATIONS.md](../../docs/OPERATIONS.md) has the schedule and a heartbeat pattern).
- The tracker's counters, inside the host only (Caddy does not expose them):
  `docker compose exec tracker node -e "fetch('http://127.0.0.1:8000/stats.json').then((r) => r.text()).then(console.log)"`
  prints, for example, `{"open":false,"allowed":2,"torrents":1,"peers":3}`. The tracker also logs its torrent and
  peer counts every 10 minutes.
- Caddy's `caddy_http_*` metrics: `docker compose exec caddy wget -qO- http://localhost:2019/metrics`.
- Logs: `docker compose logs -f`. Both services rotate them (3 files of 10 MB).

What there isn't: `tools/tracker.mjs` has no Prometheus metrics, no server ping or idle close, no per-socket
backlog limit, no per-IP quota or rate limit and no `Origin` allow list (PRODUCTION-DIGEST, 7.1, compares it with
the hardened reference). Caddy ends every WebSocket after 24 hours (`stream_timeout`), which bounds half-open
sockets; visitors' loaders reconnect within about a second.

## Upgrades

The image is built from this clone, so keep it at a release tag and compare the commit with the release notes:

```sh
git fetch --tags
git checkout v<version>
git rev-parse HEAD                  # the commit the release notes give
docker compose up -d --build
```

Recreating the tracker container drops every WebSocket; visitors' loaders reconnect within about a second (the
reconnect shim in `src/loader/torrent.js`; E2E scenario PEER-BLIP measured 1.0 to 1.6 s,
[INTEGRATION-STATUS.md](../../docs/INTEGRATION-STATUS.md)). Caddy keeps
WebSockets open for 30 s during its own reloads (`stream_close_delay`, `grace_period`). Pin the images for
repeatable deploys: replace `caddy:2.11` with `caddy@sha256:<digest>`, and set `LW_NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>`
in `.env` for the tracker's base image (`docker image inspect --format '{{index .RepoDigests 0}}' caddy:2.11` after a pull).

## Privacy

A tracker operator sees every visitor's IP address, the infohash of the site they are viewing and their WebRTC
session descriptions. Behind Caddy, `tools/tracker.mjs` sees only Caddy's address and logs no visitor addresses;
Caddy's access log keeps addresses masked to /24 (IPv4) and /48 (IPv6), without `X-Forwarded-For` or cookies, for
7 days, in the `caddy_data` volume. Never log infohash and IP address together. List the tracker in your privacy
notice ([PRIVACY.md](../../docs/PRIVACY.md)).

## What was tested

In 0.3.0, as since the 0.2.1 work, CI (`.github/workflows/ci.yml`, job `deploy`) builds the tracker image, starts both containers with
`TRACKER_DOMAIN=localhost` (Caddy's internal certificate authority, so no ACME and no DNS), and checks through
Caddy that `/healthz` answers, that `/stats.json` is not exposed, that an allowed infohash is accepted and another
is refused, and that a renamed allow file takes effect. The Caddyfile is checked with `caddy validate`. Not
tested: a real certificate from Let's Encrypt, HTTP/3, a real server on the internet, and load through Caddy.
The Caddyfile follows the research reference, which passed `caddy validate` with Caddy 2.11.7 and behaviour tests
([labs/w2b-01-tracker-resilience-ref/deploy/](../../docs/research/labs/w2b-01-tracker-resilience-ref/deploy/)).
Deploying it is in [DEPLOY.md](../../docs/DEPLOY.md), "Your own tracker".
