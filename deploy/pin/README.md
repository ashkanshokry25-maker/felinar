# Pin node, with Docker

A pin node is `tools/pin.mjs` running unattended: it keeps the real felinar loader open in Playwright Chromium,
so your site's files and its site ledger have one copy that is always online. It is infrastructure the owner or a
hub runs beside the static host and the tracker; members of a site never run one. It has four jobs
([PRODUCTION-DIGEST](../../docs/research/PRODUCTION-DIGEST.md), 7.2;
[SEEDING-AND-ZERO-SETUP-DESIGN](../../docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), 3.1.6):

1. **An always-online copy.** A site with no visitors still has a peer, and new posts reach visitors who never
   overlap in time.
2. **An easy peer.** On a public IP address with inbound UDP allowed, it can be reached by visitors whose NAT
   blocks other visitors, which takes the place of a relay (TURN) server for them.
3. **The ledger snapshot.** With `--snapshot` it writes a snapshot of the ledger on a timer, for the pointer's
   `cs=` URL.
4. **Evidence that the site keeps a file (v0.3 C2).** With a pin key of its own it answers `mw_pin1` challenges on
   the site's wires, signs a receipt once it holds a file whole, and writes a signed heartbeat. Visitors' pages show
   "Kept by the site" only on that evidence: a receipt, or a heartbeat at most 15 minutes old that lists the file.

It never needs the owner key: never put the owner key on a pin node. The pin key is a separate key that can sign
only those receipts, hellos and heartbeats.

## Build

From the repository root (the image copies `package.json`, the lockfile, `src/`, `tools/` and
`test/e2e/browser-args.mjs`):

```sh
docker build -f deploy/pin/Dockerfile -t felinar-pin .
```

The image is Node 24 on Debian 12 with every dependency from the lockfile (install scripts off), the Chromium
build that matches the lockfile's Playwright version and the system libraries Chromium needs. The build fails if
a `.jwk` key file was copied into it: keys live in a volume.

## Run

```sh
docker run -d --name mw-pin --init --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges \
  -v mw-pin:/var/lib/mw-pin \
  -e PIN_URL=https://example.com/ \
  felinar-pin --snapshot /var/lib/mw-pin/ledger.json.gz --snapshot-every 600
```

| Setting | Where | Default |
|---|---|---|
| `PIN_URL` | environment, required | none: the container exits with status 2 and says so |
| `PIN_INTERVAL` | environment: seconds between status lines | `60` |
| `PIN_PROFILE` | environment: the browser profile (the site's copy, the ledger, the consent choice) | `/var/lib/mw-pin/profile` |
| `PIN_KEY` | environment: the pin key file inside a volume (`--pin-key`), mode 600, owned by uid 1000 | empty: no pin identity, no receipts, no heartbeat |
| `PIN_STATUS` | environment: where the signed heartbeat goes when `PIN_KEY` is set (`--status`) | `/srv/site/ws/pin-status.json`; empty: no heartbeat |
| `MW_CHROMIUM_NO_SANDBOX` | environment: `1` starts Chromium without its own sandbox ("The Chromium sandbox" below) | `1` in this image |
| `PIN_MONTH_CAP` | environment: bytes, or `500GiB`, `2TB`, that pinned files may upload per UTC calendar month (`--month-cap`) | empty: no cap |
| `PIN_AUTO_ACCEPT` | environment: `owner` pins at once the file requests of the site's owner key (`--files --auto-accept owner`) | empty: every request waits for a moderator |
| more options | arguments after the image name, passed to `tools/pin.mjs` | `--snapshot <file>`, `--snapshot-every <seconds>` (600), `--plain`, `--no-consent`, `--max-restarts <n>`, `--quiet`, `--mailbox`, `--files`, `--status-every <seconds>` (300) |

The container runs `node tools/pin.mjs "$PIN_URL" --headless --profile "$PIN_PROFILE" --interval
"$PIN_INTERVAL"`, then the flags the four new variables ask for, then your arguments. Keep `/var/lib/mw-pin` on a
volume: a new container then reuses the copy, the ledger, the consent choice, the pin stores and the month count.
`--init` reaps the browser's exited processes; `docker stop` sends SIGTERM, and the pin closes the browser, writes a
heartbeat that lists nothing, and exits 0.

## The pin key, receipts and the heartbeat

1. Make the key where the pin runs (it never needs to leave that machine):

   ```sh
   node tools/keygen.mjs --out pin.jwk
   node tools/pin.mjs --pin-key pin.jwk
   ```

   The second command prints the public key and the command that names it in the site's settings, to run where the
   owner key lives (offline), then publish the ledger snapshot as usual:

   ```sh
   node tools/ledger-admin.mjs cfg --key owner.jwk --file ledger.json --pin p256:BB02...
   ```

   Visitors trust this node's hello, receipts and heartbeat only for the key `_mw.cfg.pin` names. A key file that
   group or others can read is refused, as for the owner key. If the pin key turns out to be the site's owner key,
   the node logs an error and signs nothing.

2. Put the key in the volume, owned by the image's user (uid 1000) and readable only by it:

   ```sh
   docker run --rm -i -v mw-pin:/var/lib/mw-pin --entrypoint sh felinar-pin \
     -c 'umask 077 && cat > /var/lib/mw-pin/pin.jwk' < pin.jwk
   ```

3. Run with `-e PIN_KEY=/var/lib/mw-pin/pin.jwk` and mount the directory your web server serves at the pointer's
   `ws=` base on `/srv/site/ws` (it must be writable by uid 1000; `chown 1000:1000` it once). The heartbeat lands in
   `pin-status.json` there, mode 644, so the web server can read it; visitors fetch it at
   `<ws base>/pin-status.json`.

What the page can ask of the key: the pinned page signs `mw_pin1` frames through this process (the key never enters
the page), and the Node side signs nothing but a hello (`"mw-pin1-hello\n" + infohash + "\n" + nonce + "\n" + time`)
or a receipt (`"mw-pin1-receipt\n" + infohash + "\n" + length + "\n" + time`) dated within 5 minutes of its clock,
and a receipt only for the site torrent or a file this node pins. The heartbeat
`{ v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap, sig }` lists hashed ids (the first 16 bytes
of SHA-256 of `"mw-pin-status-v1|" + infohash`), never an infohash in the clear, so private media swarms stay
private; `site` is the ledger id, so a hub pin's heartbeat for one site counts for no other. It is written every
300 seconds (`--status-every`, at most 600) and soon after something changes. Serve it with `Cache-Control:
no-cache`, and keep any sync job that deletes extra files (`rsync --delete`) away from it. The exact formats are in
[docs/deviations/pin-node.md](../../docs/deviations/pin-node.md).

## Owner auto-accept and the month cap

- **`PIN_AUTO_ACCEPT=owner`** (owner decision SZ-6): a file pin request whose author is the site's owner key, as the
  verified page tag names it, is pinned at once and logged in `<profile>/pin/log.jsonl` (`auto-accept`, then
  `approve` by `auto-accept owner`). Every other request waits in the moderator queue (`--queue`, `--approve`). A
  moderator's earlier decline stands, and files are still never opened, decoded or rendered. Without the variable
  nothing changes.
- **`PIN_MONTH_CAP`**: the node counts the bytes its pinned files upload in each UTC calendar month (from the page's
  counters, saved in `<profile>/pin/month.json`). At the cap it asks the page to stop seeding every pinned file and
  starts them again in the next month; the site torrent always seeds. The heartbeat carries the count and the cap,
  and lists no pinned file while they are paused. The counters come from the page side of the pin
  (`window.__mwPinHost.status()`); a page that does not report them leaves the count at 0, so the cap does nothing
  there.

With Docker Compose (the one-box template of the zero-setup lane, `deploy/one-box/docker-compose.yml`, uses the same
variables):

```yaml
services:
  pin:
    build: { context: ../.., dockerfile: deploy/pin/Dockerfile }
    init: true
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      PIN_URL: https://example.com/
      PIN_KEY: /var/lib/mw-pin/pin.jwk
      PIN_STATUS: /srv/site/ws/pin-status.json
      PIN_MONTH_CAP: 500GiB
      PIN_AUTO_ACCEPT: owner
    command: ["--snapshot", "/var/lib/mw-pin/ledger.json.gz"]
    volumes: ["mw-pin:/var/lib/mw-pin", "./site/ws:/srv/site/ws"]
volumes:
  mw-pin:
```

### Network

The browser needs outbound HTTPS (the site, its web seed, DNS-over-HTTPS) and outbound UDP (WebRTC). On Docker's
default bridge network it sits behind Docker's NAT as well as the host's. To be the easy peer of job 2, run it
with `--network host` on a machine with a public address and inbound UDP allowed. The image starts Chromium with
`--disable-dev-shm-usage`, so it needs no larger `/dev/shm`.

### The Chromium sandbox

Outside a container, `tools/pin.mjs` starts its browser with Chromium's own sandbox, because that browser renders the
site and handles blocks, pieces and frames from any peer. Docker's default seccomp profile does not let an unprivileged
process create the user namespaces that sandbox needs, so this image sets `MW_CHROMIUM_NO_SANDBOX=1`: Chromium runs
without its sandbox, the tool prints a warning on every launch, and the container is the boundary. Run it as the image's
`node` user with `--cap-drop ALL` and `--security-opt no-new-privileges` (the one-box compose file does both), and
keep only the volumes writable. To have Chromium's sandbox as well, start the container with a seccomp profile that
allows user namespaces (Playwright publishes one for its Docker images) and `-e MW_CHROMIUM_NO_SANDBOX=` (empty). A
read-only root filesystem has not been tested with this image yet.

This is one of the three tools allowed to reach the internet ([DEV-NETWORK.md](../../docs/DEV-NETWORK.md)): for a
URL that is not on this machine its browser runs without the local-only resolver rule. It prints what it will
contact before it starts. A loopback URL gets the local-only browser.

## What it logs

```text
consent given (this node shares the site and the ledger)
render: ok, the site frame rendered ("Peer Guestbook")
heartbeat: 1 item(s), hashed ids only -> /srv/site/ws/pin-status.json
01:18:51 Sharing with other visitors | 0 peers | Ledger: 1 entry, no peers connected | From the host | Pointer: page tag, signed, key remembered since 2026-10-20
snapshot: 1 blocks -> /var/lib/mw-pin/ledger.json.gz (410 B)
```

The times are UTC. On the first run it presses "Share and load" with a real mouse click and keeps the choice in
the profile; if it finds no card and no stored choice it logs a `WARNING` that it may not be sharing. When the page
shows "Update available: reload" it reloads. If the page or the browser crashes, or the loader is stuck for three
status checks, it restarts the browser after 5 s, doubling up to 5 minutes, and writes a heartbeat that lists
nothing while the browser is down. With a month cap the status line ends with `month 1.2 GiB of 500 GiB`.

## Snapshots

`--snapshot` writes the file on the volume; publishing it at the `cs=` URL is up to you (the tools don't upload).
For example, a timer on the host that copies it to the web seed bucket:

```sh
docker cp mw-pin:/var/lib/mw-pin/ledger.json.gz /tmp/ledger.json.gz
aws s3 cp /tmp/ledger.json.gz s3://example-site/ws/genesis.json --cache-control no-cache
```

The loader recognises a gzip snapshot by its first bytes and inflates it with a size cap, so serve the file as it
is, without `Content-Encoding`. `--plain` writes plain JSON instead.

## Watching it

With a pin key the heartbeat is the signal: its `at` field is the pin's clock in milliseconds, so an age over 15
minutes means visitors no longer count it.

```sh
curl -fsS https://example.com/ws/pin-status.json | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>console.log("heartbeat age: "+Math.round((Date.now()-JSON.parse(s).at)/1000)+" s"))'
```

Without one, two cheap signals ([OPERATIONS.md](../../docs/OPERATIONS.md)): its log keeps growing
(`docker logs --since 3m mw-pin | grep -q . || echo "pin node silent"`), and your tracker reports at least one seeder
for the site (`npx felinar check-site https://example.com/` prints the seeders per tracker).

## Cost and limits

- A small VM is enough to start: $0 (Oracle Always Free, which reclaims instances it sees as idle) to about $6 a
  month ([PRODUCTION-DIGEST](../../docs/research/PRODUCTION-DIGEST.md), 7.2); the zero-setup research lists a
  $4.00 a month server with 500 GiB of transfer ([S2](../../docs/research/v03/S2-zero-setup-hosting.md) F15, read
  2026-10-20), which is what a month cap is for. The memory and CPU that
  Chromium needs per pinned site are not measured. Run one container per site.
- The pin sees visitors' IP addresses like any peer, and it stores and passes on everything the site's visitors
  post. Run it for your own sites: pinning other people's content makes you their host
  ([DEPLOY.md](../../docs/DEPLOY.md), "Pin node").
- The heartbeat tells anyone who knows an infohash whether this node keeps it; it never names one.

## What was tested

In 0.3.0, as since the 0.2.1 work, CI (`.github/workflows/ci.yml`, job `deploy`) builds this image, checks that it exits with status 2
without `PIN_URL`, and runs it with `--network host` against the local demo (`npm run demo`): it must log
"consent given" and "render: ok". On a development machine (macOS, Node 24, 2026-10-19) the same files outside
Docker kept the local demo open for 35 s, logged a status line every 5 s, wrote the snapshot and exited on SIGTERM.

For v0.3 C2 (2026-10-20, macOS, Node 24): unit tests (`test/unit/pin-frames.test.mjs`, `pin-heartbeat.test.mjs`,
`tools-c2-pin.test.mjs`) cover the frames, the signer's refusals, the heartbeat file, auto-accept and the month cap
with fakes, and run this Dockerfile's entrypoint script under `sh` with a stand-in for `node`. One local run outside
Docker, on 127.0.0.1 only (Playwright Chromium, the current loader built into a temporary directory, the guestbook
example published for 127.0.0.1, the pin started by `test/fixtures/pin/start-pin.mjs`): the heartbeat file verified
(mode 644, the site torrent listed, `site` equal to the ledger id, no infohash in the clear), and verified again when
fetched from the dev server at `<ws base>/pin-status.json`; the owner key was read from the page tag, an owner
request was pinned at once and a member's waited; in the page, `pin.key` and `pin.sign` answered the top frame,
`pin.sign` refused a block string and the site frame was refused; after the stop the heartbeat listed nothing; the
browser asked for nothing outside 127.0.0.1. Not tested in this lane: building the image with the new variables, a
heartbeat served by Caddy, a site on the internet, the easy-peer role, runs longer than a minute, and the page side
of the pin (`window.__mwPinHost`, which the C2 integration added after this run; e2e E-PS-1 hands a file off to a pin
on loopback), so in this run pinned files were not seeded and the month cap saw no real counters.
