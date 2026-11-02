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
| `worker.js` | the Worker (`/healthz`, `/stats.json`, WebSocket upgrades) and the Durable Object `Rendezvous`, which accepts the sockets with the Hibernation API, keeps each connection's state on the socket and the rows of pairing codes and lanes in its storage, and closes idle ones and expires codes, knocks and lanes from an alarm |
| `rtc.js` | the protocol (bittorrent-tracker 11.2.3's WebSocket messages, which the loader speaks), the allow list and the caps; no platform code, so a unit test drives it with fake connections |
| `pair.js` | the pairing and room protocol of the apps on a door page ([Pairing](#pairing)); no platform code either, and `tools/tracker.mjs` runs the same file |
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
- `/stats.json?token=<STATS_TOKEN>` prints `{ open, uploads, allowed, swarms, unlisted, peers, sockets, interval, codes, knocks, lanes }`
  when `STATS_TOKEN` is set to a long random value; with it empty the counts are not served. The last three are the pairing's
  (below); like the others they name no infohash, code or knock.

## Pairing

The apps on a door page (direct messages and rooms) meet through this rendezvous. A visitor opens a code, another visitor types
it, and only when the first approves does the rendezvous hand both a private lane: a random infohash that it serves for 24
hours. The two then exchange their WebRTC offers and answers through the usual tracker protocol on that lane, so neither learns
the other's network address before the approval. It is the same state machine as the Node tracker's (`tools/tracker.mjs`, which
runs `pair.js` too), and it is on by default: set `PAIRING` to `0` in `wrangler.jsonc` (or `--var PAIRING:0`) for a tracker only.

A code is 12 characters from `abcdefghijkmnpqrstuvwxyz23456789` (no 0, 1, l or o), shown `xxxx-xxxx-xxxx`: channel 4 + secret 8.
The first 4 characters are the channel, the only part the rendezvous sees or stores. The last 8 are the secret (40 bits): the
owner's browser draws it from `crypto.getRandomValues` and it is never sent here. The hello (identity key, chat key, name)
travels only as a box, `{ iv, ct }`, sealed under a key derived from that secret, so the rendezvous checks shapes and sizes and
forwards what it cannot read (unless it records a box and guesses the secret offline; see below). It never carries an SDP, an address or a key. `normalizeCode` and `formatCode` in `pair.js` take
and give the 12 characters (a code of any other length is not a code); a message carries only the channel.

A pairing uses a WebSocket of its own to the same address (`/`). The first message classifies a socket for its lifetime: `announce`
and `scrape` make it a tracker socket, any `pair-*` or `room-*` action a pair socket, and a message of the other kind is
answered `{ action, 'failure reason': 'socket already used for another protocol' }`. Every message is a JSON text frame of at most
8,192 bytes with `v: 1`, an `action` and an optional `rid` (up to 16 characters, echoed in the direct reply). A failure reply is
`{ action, rid?, 'failure reason': <text> }`.

| Client sends | The rendezvous answers |
|---|---|
| `pair-open { channel, box, rid }` | the owner: `{ action: 'pair-open', channel, rid }`. One code per socket; opening another replaces it. Errors: `channel taken`, `box invalid`, `too many codes` |
| `pair-knock { channel, box, rid }` | the requester: `{ action: 'pair-knock', knock, rid }`; the owner: `{ action: 'pair-request', knock, channel, box }`. Errors: `unknown code` (also for a closed or expired code), `too many requests`, `box invalid` |
| `pair-accept { knock, proof, rid }` (owner) | mints `lane` (40 hex), allows it for 24 hours; the owner: `{ action: 'pair-accepted', knock, lane, rid }`; the requester: `{ action: 'pair-accepted', knock, lane, channel, box: <the owner's box>, proof }`. `proof` is the owner's signature (86 base64url characters) over the channel and the knock: the Worker checks its shape (`proof invalid` otherwise) and passes it on unchanged, and the requester's page checks the signature before it joins the lane |
| `pair-reject { knock, rid }` (owner) | the requester: `{ action: 'pair-rejected', knock, reason: 'rejected' }`; the owner: `{ action: 'pair-reject', knock, rid }` |
| `pair-cancel { knock }` (requester) | the owner: `{ action: 'pair-cancelled', knock }` |
| `pair-close { rid }` (owner) | releases the code; its pending knocks get `pair-rejected` with `reason: 'closed'` |
| `room-open`, `room-knock`, `room-accept`, `room-reject`, `room-cancel`, `room-close` | the same, with `room-` in place of `pair-`. `room-open` mints and allows the lane at once and answers `{ action: 'room-open', channel, lane, rid }`; a socket owns at most 4 rooms; `room-close { channel }` names the room; `room-accept { knock, proof, rid }` answers the owner `{ action: 'room-accepted', knock, rid }` and the requester `{ action: 'room-accepted', knock, lane, channel, box, proof }` |

A reply goes to the sender only when it has something to say (`pair-cancel` and `pair-close` answer a `rid` and nothing else).
Besides the failures above the rendezvous says `invalid channel`, `invalid knock`, `unknown knock`, `proof invalid`, `invalid rid`,
`unsupported version`, `invalid action`, `message too large`, `too many lanes` and, with `PAIRING` at `0`,
`pairing is off on this rendezvous`. It also pushes: `{ action: 'pair-rejected', knock, reason }` with `expired` (a knock older than
10 minutes, or its code ran out) or `gone` (the owner's socket closed); `{ action: 'pair-cancelled', knock }` to an owner whose
requester went away or whose knock ran out; and `{ action: 'pair-close', channel, reason: 'expired' }` (`room-close` for a room)
to an owner whose code ran out after 24 hours. The same pushes exist with `room-` in place of `pair-`.

| Lifetime and cap | Value |
|---|---|
| a knock pends | 10 minutes |
| a code stays open | until its owner closes it, its socket closes, or 24 hours (a socket that owns a code is not closed as idle meanwhile) |
| a lane is allowed | 24 hours, from the accept (from the open, for a room); after that it is dead: no new member, and a member's next announce is refused |
| pending knocks | 16 per code, 8 per requesting socket |
| knocks and opens | 10 a minute per socket (`too many requests`, `too many codes`) |
| codes in all, lanes in all | 4,096 and 10,000 (`too many codes`, `too many lanes`) |

What the rendezvous learns: channels, when knocks happen, lane ids and the addresses of the sockets, as any relay does; never
names, keys or which identity talks to which. What it keeps, and where: in the Durable Object's storage a row per code,
`chan:<channel>` -> `{ kind, box, lane, exp }` (the owner's sealed box lives as long as the code), and a row per lane,
`lane:<hex>` -> expiry; a socket's own attachment holds its codes and, for a requester, its pending knocks (a few hundred
bytes, far under the 2 KB limit). A pending knock is not written to storage. It rides on the requester's socket instead,
because the object sleeps between messages and a person takes longer to read a request than the object takes to fall asleep:
kept only in memory, the knock would be gone when the owner answered. A new deployment still drops the pending knocks, and a
requester whose knock vanished sees no answer and may knock again. Each pairing writes about four rows (a code, a lane, and
their deletion when they run out); the alarm that expires them is pulled forward to the first knock, code or lane to run out.
The rate windows of the caps are in memory and start again when the object wakes. The box is protected by a 40-bit secret (the last
8 characters of the code): a rendezvous that records boxes could try secrets against them offline, which 40 bits make about a
million times slower than the 20 bits of a 4-character secret would, and the clients' compare code after the connection (the
app shows it) is what catches a substituted key. A password-authenticated key exchange would remove the oracle; it is on the
backlog.

Limits worth knowing: there is no per-IP quota, so someone with many sockets can fill the 4,096 codes or the 10,000 lanes until
they run out (a day at most) and can use a lane they mint themselves as a signalling channel for 24 hours; `PAIRING=0` is the
answer for a site that does not host apps. A knock that the owner's client cannot open (a wrong secret) gets no answer, by design;
the owner's client closes a code after 5 of them. An open channel answers a knock differently from a closed one (`unknown code`), so
someone with many sockets can list which of the 1,048,576 channels are open: at 10 knocks a minute a socket, 1,000 sockets need about 105
minutes (arithmetic from the cap, not a run). A channel is not the secret, and the five-box rule above ends a code that is probed with
boxes the owner cannot open.

The Node tracker (`tools/tracker.mjs`) speaks the same protocol with everything in memory and allows a lane for 24 hours beside
its allow list; `--no-pairing` turns it off. `pair.js` lives in `deploy/`, which the npm package does not carry: there the
tracker starts with pairing off and says so, unless that file is added to the install. The Docker images of `deploy/tracker` and
`deploy/one-box` copy it, so their trackers pair.

### What a door needs to point at this Worker

A door sends its apps here with an `apps` block in its own `/_mw/door.json` ([docs/DEPLOY.md](../../docs/DEPLOY.md), "Apps at a door"; what
visitors see is in [docs/APPS.md](../../docs/APPS.md)): `"apps": { "rendezvous": ["wss://<this Worker>"], "stun": [...], "idp": "https://..." }`.
The page uses the first `rendezvous` URL for two kinds of socket to the same address. One is its own pair socket, everything described
above: it opens only when a person asks for a code or types one, it sends a message when a person opens, answers or closes a code (and
when it opens a code again after a reconnect), and it sends no periodic announce. The other is the tracker connection that the lane's
announces use after an accept. A lane is not in `ALLOW`: the Worker serves it for 24 hours by itself, and the page announces it only
after the accept, so the Worker has no swarm for it before then. When the pair socket drops, the page reconnects after 1, 2, 4, 8, 15 and
then every 30 seconds, opens its code again with a fresh box, and makes a lost request again up to three times. A rendezvous that does
not speak the pair protocol (a plain tracker, or this Worker with `PAIRING` at `0`) cannot pair anybody, and the page shows an error.
There is no `Origin` allow list: anyone can name your Worker in a door of their own, and the global caps above and `PAIRING=0` are the
limits you have.

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

What it doesn't do: no per-IP quota (pairing included: see its limits in the Pairing section), no `Origin` allow list, no metrics beyond `/stats.json`, no server ping (the loader
re-announces within the interval, which keeps a socket alive), no hub lanes (list a hub's follow lane by hand, `tools/tracker.mjs`
prints it). Visitors' loaders reconnect within a second or two when the object closes a socket or a deployment replaces it.

## Privacy

Cloudflare, as the operator of the Worker's host, sees every visitor's IP address, the infohash they announce and their
WebRTC session descriptions, as any tracker host does, and, for a pairing, the channels, the knock times, the lanes and the
sealed boxes described above; the Worker itself logs nothing. Leave Workers Logs and observability
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
Pairing was added after those runs and has unit tests only: `test/unit/deploy-rtc-pair.test.mjs` (the state machine
through fake connections and its dispatch inside `rtc.js`), the pairing cases of `test/unit/deploy-rtc-worker.test.mjs` (the object
with a fake platform: rows in storage, a wake with the sockets' attachments, the alarm) and `test/unit/tools-tracker-pair.test.mjs`
(the Node tracker with real WebSocket clients on loopback). Not tested: a deployment on Cloudflare itself, hibernation on the real
platform, pairing under `wrangler dev` or with a real loader against the Worker, and load.
