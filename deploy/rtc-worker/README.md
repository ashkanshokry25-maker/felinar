# A rendezvous on Cloudflare Workers, without a server

This folder runs the job of `tools/tracker.mjs` as a Cloudflare Worker with one Durable Object: a WebSocket tracker that
passes WebRTC offers and answers between visitors of the same site, so they find each other. It never sees the site's files
or its posts. It fits the Workers Free plan, needs no server and no domain, and answers at a name you choose under
`workers.dev`.

It also does two jobs for the apps on a door page: it pairs two people by a code ([Pairing](#pairing)) and, once one has
accepted the other, it can pass the sealed messages of their conversation between them ([Relay](#relay)). The relay is what
carries a message when the two browsers cannot reach each other directly, as long as both can open a WebSocket to this
rendezvous. It is not a general-purpose proxy.

Why another way to run one: the four public trackers are on block lists, by name. On one of our computers a DNS filter
(HaGeZi Anti-Piracy) answers 0.0.0.0 for `tracker.webtorrent.dev` and `open.ftorrent.com`, and browser block lists match
host names that contain `tracker`, `torrent`, `peer` or `bt` ([deploy/tracker](../tracker/README.md), [w2b-01](../../docs/research/w2b-01-tracker-resilience.md), F2).
A visitor behind such a filter still loads the site from its web seed, but meets nobody, so posts stop travelling for them.
[deploy/tracker](../tracker/README.md) answers that with a tracker on a neutral host name, which needs a server and a
domain. This Worker needs neither: `rtc-<name>.<your subdomain>.workers.dev` carries none of those words, and `workers.dev` is
a suffix that thousands of ordinary applications use.

| File | What it does |
|---|---|
| `worker.js` | the Worker (`/healthz`, `/stats.json`, WebSocket upgrades) and the Durable Object `Rendezvous`, which accepts the sockets with the Hibernation API, keeps each connection's state on the socket and the rows of pairing codes and lanes in its storage, has the platform answer the keepalive ping ([Relay](#relay)), and closes idle ones and expires codes, knocks and lanes from an alarm |
| `rtc.js` | the protocol (bittorrent-tracker 11.2.3's WebSocket messages, which the loader speaks), the allow list and the caps; no platform code, so a unit test drives it with fake connections |
| `pair.js` | the pairing and room protocol of the apps on a door page ([Pairing](#pairing)) and the relay lane ([Relay](#relay)); no platform code either, no import, and `tools/tracker.mjs` runs the same file |
| `front.js` | the HTTP front alone (`/healthz`, `/stats.json`, the upgrade at `/`): the same code as the default export of `worker.js`, and the one file a Pages project runs. `pages/public/_worker.js` is a byte-for-byte copy of it and `pages/wrangler.toml` holds the Pages project's settings ([Relay](#relay), "Deploying the Worker and the front") |
| `wrangler.jsonc` | the Worker's settings: the object binding, the SQLite-backed class (what the Free plan allows), the platform's own logs switched off, the vars below |

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
- `/stats.json?token=<STATS_TOKEN>` prints `{ open, uploads, allowed, swarms, unlisted, peers, sockets, interval, codes, knocks, lanes,
  relays, relayed, relayBytes, relayDay, relayBusy, relayRate, joinsRefused }` when `STATS_TOKEN` is set to a long random value; with
  it empty the counts are not served. `codes`, `knocks` and `lanes` are the pairing's (below) and the seven after them the relay's
  ([Relay](#relay)); like the others they name no infohash, code, knock or lane.

## Pairing

The apps on a door page (direct messages and rooms) meet through this rendezvous. A visitor opens a code, another visitor types
it, and only when the first approves does the rendezvous hand both a private lane: a random infohash that it serves for 24
hours. The two then exchange their WebRTC offers and answers through the usual tracker protocol on that lane, so neither learns
the other's network address before the approval. It is the same state machine as the Node tracker's (`tools/tracker.mjs`, which
runs `pair.js` too), and it is on by default: set `PAIRING` to `0` in `wrangler.jsonc` (or `--var PAIRING:0`) for a tracker only.
The two can also pass their messages through this rendezvous on the same lane instead of connecting to each other ([Relay](#relay)).

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
| `pair-join { lane, rid }` | joins the relay lane `lane` (the 40 hex the accept handed to both sides): `{ action: 'pair-join', lane, peers, rid }`, `peers` being the other sockets in it, and each of them gets `{ action: 'pair-joined', lane, peers }`. Joining again is the same answer and no push. Errors: `invalid lane`, `unknown lane` (never minted, or past its 24 hours), `lane full`, `too many lanes`, `relay is off on this rendezvous` |
| `pair-relay { lane, f, rid }` | `f` is a sealed frame as 4 to 7,700 base64url characters. Every other socket in the lane gets `{ action: 'pair-relayed', lane, f }`; the sender gets `{ action: 'pair-relay', lane, peers, rid }` only when it sent a `rid` (`peers`: the sockets it was written to, 0 when alone). Errors: `invalid lane`, `unknown lane` (the sender is not in the lane), `invalid frame`, `too many relays`, `relay is busy`, `relay is off on this rendezvous` |
| `pair-leave { lane, rid }` | the sender is answered only when it sent a `rid`; the others get `{ action: 'pair-left', lane, peers }`. A socket that closes leaves every lane it joined, with the same push. Leaving a lane one is not in is quiet |
| `pair-ping` | exactly `{"v":1,"action":"pair-ping"}`: answered `{ action: 'pair-pong' }` (on the Worker by the platform, without waking the object). Never a failure, and no cap counts it |
| `room-join`, `room-relay`, `room-leave` | the same for the lane of a room, with `room-` in place of `pair-`; the pushes are `room-joined`, `room-relayed` and `room-left` |

A reply goes to the sender only when it has something to say (`pair-cancel` and `pair-close` answer a `rid` and nothing else).
Besides the failures above the rendezvous says `invalid channel`, `invalid knock`, `unknown knock`, `proof invalid`, `invalid rid`,
`unsupported version`, `invalid action`, `message too large`, `too many lanes`, `too many messages` (the failure reply of the
message that went over its allowance; the socket is closed right after it, with code 1008) and, with `PAIRING` at `0`,
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
| relayed frames | 120 a minute per socket (`too many relays`); 20,000 a UTC day for the object (`relay is busy`) |
| messages of any kind but a ping | 150 a minute per socket; the next one closes the socket with code 1008 (`too many messages`) |
| relay lanes | 8 per socket (`too many lanes`); 2 sockets in a pair lane and 16 in a room lane (`lane full`) |

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
when it opens a code again after a reconnect), and it sends no periodic announce. The other, only when the door turns direct links on
(below), is the tracker connection that the lane's announces use after an accept. A lane is not in `ALLOW`: the Worker serves it for 24 hours by itself, and the page announces it only
after the accept, so the Worker has no swarm for it before then. When the pair socket drops, the page reconnects after 1, 2, 4, 8, 15 and
then every 30 seconds, opens its code again with a fresh box, and makes a lost request again up to three times. A rendezvous that does
not speak the pair protocol (a plain tracker, or this Worker with `PAIRING` at `0`) cannot pair anybody, and the page shows an error.
There is no `Origin` allow list: anyone can name your Worker in a door of their own, and the global caps above and `PAIRING=0` are the
limits you have.

The block can also say `"relay": "rendezvous"` (the default when it is absent: the messages of a conversation pass through this
rendezvous) or `"relay": "none"`, and `"direct": "off"` (the default) or `"direct": "on"` (the page also tries a direct WebRTC link,
which shows each side the other's network address). `"relay": "none"` with no `direct` means direct on, which is how the apps worked
before the relay existed ([docs/DEPLOY.md](../../docs/DEPLOY.md), "Apps at a door").

## Relay

After a pairing is accepted, the two pages can pass their messages through this rendezvous instead of connecting to each other. Each
joins the private lane the accept minted (`pair-join`, or `room-join` for a room) over the pair socket it already holds, and every
sealed message then goes as a `pair-relay` frame that the rendezvous writes to the other socket of the lane. That needs only what the
pairing needs, a WebSocket from each browser to this rendezvous (HTTPS, port 443), and no direct link between the two browsers.
Whether a door uses it is the door's choice (`relay` in its apps block, above). A direct link, when a door also turns it on, runs
beside the relay and is preferred while it works.

**What it is not.** The relay forwards only sealed pair frames between two members of a lane the rendezvous itself minted after an
accept, under caps; nothing general-purpose. It is not a proxy and not a VPN: it joins no lane it did not mint, it carries no other
traffic, and a frame that is not 4 to 7,700 base64url characters is refused. Cloudflare's terms for its self-serve plans do not allow
running a virtual private network or a similar proxy service on them; the relay is narrow for that reason, one variable switches it
off, and you should read the terms of your own plan before you run one.

**What the rendezvous sees, and what it cannot.** It sees the network address of each of the two connections (for a visitor behind a
VPN or using Tor Browser, the address of the VPN or of the exit; not tested here), the lane id, and the time and size of each frame. It
cannot see what a message says, a name or a key: the apps seal each frame before it leaves the page (`src/loader/apps-crypto.js`),
and this folder never holds a key, checks only the alphabet and the length of `f`, and passes on the same string. The three frames of
a direct message are 514, 1,538 and 5,634 bytes, which is 686, 2,051 and 7,512 base64url characters, so a request with the largest
and a push of it both fit under the 8,192 bytes of a pair frame. Cloudflare, which hosts the Worker, sees what any host of a WebSocket
sees (the address, the `Origin` of the page, when each frame is sent and how large it is) and can be ordered to record addresses
without telling you. The Worker reads none of that: it hands the Durable Object a request rebuilt with only the headers a WebSocket
upgrade needs, it never reads `request.cf`, and `wrangler.jsonc` switches the platform's own logs (`observability`) off. That is a
statement about this code, not a promise about what the host does.

**Caps.** Per socket: 120 relayed frames a minute (`too many relays`); 150 messages of any kind but a ping a minute, and the next
one closes the socket with code 1008 (`too many messages`); 8 lanes (`too many lanes`); 2 sockets in a pair lane and 16 in a room
lane (`lane full`). For the whole object: 20,000 relayed frames a UTC day, after which every relay is answered `relay is busy` until
00:00 UTC. The numbers are `DEFAULT_CAPS` in `pair.js` (a test keeps this section equal to them). The day cap and the counters are
in memory, so a new deployment starts them again at 0; `/stats.json` shows today's counts and the UTC day they belong to. A frame is
counted when it is accepted for forwarding, including one sent while the other side was away (it is written to nobody and costs a
request all the same).

**The Free plan's 100,000 requests a day.** The day cap is 20,000 because the Free plan gives the object 100,000 requests a day and
how it bills the WebSocket messages of a relay is not measured for this folder yet. The costs section below says 20 incoming messages
count as one request. If every relayed frame is billed as a request of its own instead, 20,000 of them and the pairing's own traffic
still stay under the 100,000, so pairing keeps working on a busy day; if the 20 to 1 holds, the cap is conservative. Change the
number (`relayDayMax`) only after you have read your own request count.

**Keepalive and idle.** A page sends exactly `{"v":1,"action":"pair-ping"}` every 50 seconds. `worker.js` gives the platform that
text and its answer, `{"action":"pair-pong"}` (`setWebSocketAutoResponse`), so the platform answers it without waking the object, and
a ping costs the object no running time (whether the Free plan counts the platform's answer as a request is not measured yet). When
the object wakes and when its sweep runs it reads the time of the last answer to each socket (`getWebSocketAutoResponseTimestamp`),
so a socket that only pings is never closed as idle. A page that gets no pong within 10 seconds treats its socket as dead and
connects again. A socket that sends nothing and pings nothing is closed by the sweep after 20 minutes; a page that was frozen (a phone
with the screen off) joins its lanes again when it wakes. The Node tracker answers a ping itself.

**The off switch.** `RELAY_LANE` is `"1"` in `wrangler.jsonc`; any other value than `"0"` leaves the relay on. With `"0"` (or
`--no-relay-lane` on the Node tracker) every join, relay and leave is answered `relay is off on this rendezvous`, and the pairing keeps
working. A door whose block says `"direct": "on"` still connects its two pages directly.

**Limits worth knowing.** A socket that disappears without closing (a phone that changed networks) stays a member of its lane until
the idle sweep closes it, up to 25 minutes (20 minutes of silence, looked at every 5): until then a pair lane can look full to the
page that replaces it, and a frame written to the vanished socket reaches nobody, so the sending page gets no acknowledgement and
handles that as it does for any message that is not acknowledged. Nothing is stored: a frame sent while the other socket is away is
written to nobody (`peers: 0` in the answer to a request with a `rid`) and the page sends it again after the other side joins. There
is no per-address quota; only the two members and the rendezvous know a lane's id, and whoever knows it can fill its places. A frame
is never opened, so a member that sends garbage is not noticed here; the receiving page drops it.

### Deploying the Worker and the front

The default export of `worker.js` and `front.js` are the same front: `/healthz`, `/stats.json?token=` and the upgrade at `/`, with
the rebuilt request. `front.js` is also the one file a Pages project runs, so the rendezvous can answer at a `<project>.pages.dev` name
that shows no account name while the Durable Object lives in a Worker with no public address of its own. `pages/public/_worker.js`
must be a byte-for-byte copy of `front.js` (a test compares them): copy it again after every change. Run `wrangler` from a copy of
this folder outside the repository, as above.

```sh
cp -R deploy/rtc-worker ../rtc && cd ../rtc
npm init -y > /dev/null && npm install --no-save wrangler@4
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
# 1. the object. In the copy's wrangler.jsonc set "workers_dev": false (keep "observability": { "enabled": false }).
#    The vars are part of a deployment: pass the SAME ALLOW as the live one, or the allow list is emptied and the swarms stop being served.
npx wrangler deploy --name rtc-mysite-do --var "ALLOW:$ALLOW"
# 2. the front. In the copy's pages/wrangler.toml set name (the Pages project) and script_name (the Worker above), and put the value of
#    STATS_TOKEN there, in the copy only: the repository holds the placeholder text, never a token.
cp front.js pages/public/_worker.js && cd pages
npx wrangler pages deploy public --project-name rtc-mysite --branch main --commit-dirty=true
curl https://rtc-mysite.pages.dev/healthz        # prints: ok
```

To roll back, deploy the Worker again with `--var "RELAY_LANE:0"` and the same `ALLOW` (pairing keeps working, and messages need a
direct link), or return the Worker to its previous version with `npx wrangler rollback`.

## What it costs, and the limits

On the Workers Free plan the object may serve 100,000 requests a day: a connection counts as one, and 20 incoming
WebSocket messages count as one (outgoing ones are free). A visitor announces each of its swarms every 120 s, and its loader
also sends an announce without offers on a socket that was silent for 55 s (`wire.keepaliveAnnounceMs` in
`src/loader/config.js`), so a visitor costs 110 to 180 requests a day: 108 with three swarms (site, ledger, chat) whose
announces are spread out, 180 with them in phase, 144 with two swarms. The plan covers roughly 550 to 900 visitors with a page open all
day, or many more who come and go; these numbers are computed from the code, not measured. The object sleeps between messages
(hibernation), so its running time stays near zero; a wake rebuilds the connections from the state kept on the sockets, and
that state is written again at least every 5 minutes so a live connection is not swept as idle after a wake. One object holds
every swarm; above those numbers, or for a hub, run one Worker per site. Cloudflare's own plan limits and prices are at
[developers.cloudflare.com/durable-objects/platform/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

What it doesn't do: no per-IP quota (pairing included: see its limits in the Pairing section), no `Origin` allow list, no metrics beyond `/stats.json`, no ping of its own
(a tracker socket's loader re-announces within the interval; a pair socket's page pings every 50 seconds and the platform answers, see Relay), no hub lanes (list a hub's follow lane by hand, `tools/tracker.mjs`
prints it). Visitors' loaders reconnect within a second or two when the object closes a socket or a deployment replaces it.

## Privacy

Cloudflare, as the operator of the Worker's host, sees every visitor's IP address, the infohash they announce and their
WebRTC session descriptions, as any tracker host does, and, for a pairing, the channels, the knock times, the lanes and the
sealed boxes described above and, for the relay, the lane and the time and size of each frame; the Worker's code writes no log
line and keeps no frame. `wrangler.jsonc` switches the platform's own logs (`observability`) off. The Pages project that fronts the
Worker is a second place a host can log from: check its settings in the dashboard too. Name the rendezvous and Cloudflare in your
privacy notice ([PRIVACY.md](../../docs/PRIVACY.md)), and never log infohash and IP address together.

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

The relay lane was added on 2026-11-07 and has unit tests only: `test/unit/deploy-rtc-pair.test.mjs` (the state machine: join,
relay, leave and ping, the caps, the day counter and its reset, the saved state and a wake), `test/unit/deploy-rtc-worker.test.mjs`
(the object on a fake platform: the exact auto-response texts, pings that never wake the object, the sweep, the rebuilt upgrade
request, `wrangler.jsonc`), `test/unit/deploy-rtc-front.test.mjs` (the front and its Pages copy, the names the code never reads, the
numbers of this README) and `test/unit/tools-tracker-pair.test.mjs` (the Node tracker with real WebSocket clients on loopback). Not
tested: a deployment on Cloudflare, the auto-response and hibernation on the real platform, how the Free plan counts relayed frames and
pings, and a message crossing a real office or mobile network.
