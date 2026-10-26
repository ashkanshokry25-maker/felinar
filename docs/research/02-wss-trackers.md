# 02 - Public WebSocket trackers and self-hosting

- **Topic:** public `wss://` WebTorrent trackers (liveness, defaults, protocol limits), self-hosting a tracker, free-tier hosting, and tracker-less WebRTC signaling (Nostr, MQTT).
- **Research date:** 2026-10-14. Live probes ran 2026-10-14 23:48Z to 2026-10-15 00:40Z. Sources are 2024-2026 unless flagged as older.
- **Probe scripts (stdlib-only Python, re-runnable):** `docs/research/labs/02-wss-trackers-probes/`.
- **Confidence scale:** high = read in primary source/code and/or reproduced live; medium = one good source, or inferred from consistent evidence; low = anecdotal, vendor claim, or my own estimate. Anything I could not verify is marked **unverified**.
- **Design-critical** findings (would change the architecture if wrong) are tagged `[DESIGN-CRITICAL]`.

---

## Summary

1. **Four public wss:// trackers are alive and pass a full signaling test today** (WebSocket upgrade, announce on a never-published random infohash, offer relayed to a second peer, answer relayed back, 40-120 ms): `wss://tracker.webtorrent.dev`, `wss://tracker.openwebtorrent.com`, `wss://open.ftorrent.com`, `wss://tracker.novage.com.ua`. They run on four different infrastructures (Hetzner, a US colo "Pulse", Oracle Cloud, Cloudflare-proxied).
2. **Dead or unusable:** `tracker.btorrent.xyz` (DNS A record is `127.0.0.1`), `tracker.fastcast.nz` (NXDOMAIN), `tracker.webtorrent.io`, `tracker.sloppyta.co`, `tracker.manager.v6.navy`, `tracker.ghostchu-services.top`, `ws.peer.ooo`, `tracker.dnlab.net`, `qot.abiir.top`, the Heroku one. **Up but unusable from our loader:** `tracker.files.fm:7073` (HTTP 403 unless `Origin: https://files.fm`) and PeerTube instance trackers (only registered torrents).
3. **WebTorrent itself ships no tracker list for magnet links.** webtorrent 3.0.21 only uses `tr=` from the magnet/.torrent, per-torrent `opts.announce`, and `client.tracker.announce`. The only "default announce list" lives in `create-torrent` 6.1.3 (5 UDP + 3 wss, one of which, btorrent.xyz, is dead) and is applied only when *creating* a torrent without `announce`/`announceList`. Our magnet/loader must carry its own list. `[DESIGN-CRITICAL]`
4. **Protocol numbers that matter:** server `interval` = 120 s (180 s on novage); the browser client sends at most **5 offers per tracker per announce** (bittorrent-tracker 11.2.3); servers forward **10** (aquatic, novage - measured) or **at least 14** (openwebtorrent - measured) offers per announce; unanswered offers die after 50 s client-side; **trackers close idle sockets after about 125-185 s (measured)**, so a keepalive is mandatory; the stock client waits `10 s + U(0, 5 min)` before reconnecting. `[DESIGN-CRITICAL]`
5. **Scale right now:** openwebtorrent 264,806 open WebSockets / 2.19 M peer entries / 352 k torrents; webtorrent.dev 66 k-174 k peer entries over the last 24 h; novage 88.7 k WebSockets; ftorrent small (about 195 k offers relayed per day). Our traffic is noise to them, but there is no SLA anywhere, and operators are volunteers/small companies.
6. **Rate limits / abuse policy:** none published by openwebtorrent, webtorrent.dev or novage. ftorrent publishes a circuit breaker (24 h `503` + `Retry-After: 86400` when a service passes 200 M relayed offers per rolling 24 h). 14 parallel connections from one IP were accepted by all four. Nobody authenticates users, so any swarm ID can be joined by anyone who knows it.
7. **Self-hosting:** `bittorrent-tracker` 11.2.3 (2026-05-25) is the simplest (`--ws --trust-proxy` behind Caddy) but is the weakest engine: no TLS, no WS ping, swarms never pruned (issue open since 2016), `ws` default `maxPayload` 100 MiB, 1000 peers per swarm. Better: `aquatic_ws` (Rust, Linux >= 5.8; powers webtorrent.dev and ftorrent) or Novage `wt-tracker` / `wt-tracker-rust` (the Rust port has run tracker.novage.com.ua since Oct 2026 with 88 k connections on a 2-core Oracle Always-Free VM).
8. **Free hosting:** only **Oracle Always Free** is both free and big enough (A1 = 2 OCPU / 12 GB per today's doc, 10 TB/month egress, idle-reclaim rule). **Cloudflare Workers + Durable Objects** could host a WS tracker on the Free plan on paper (100 k requests/day, incoming WS messages billed 20:1) but I found no public WebTorrent-protocol implementation and Free-tier enforcement is disputed. Fly.io has no free tier for new orgs ($2.19/month smallest machine). Render Free sleeps after 15 min without inbound traffic and is "not for production". GCP e2-micro includes only 1 GB/month egress.
9. **Tracker-less signaling works today (verified live):** Nostr - 6/6 tested relays accepted and echoed an ephemeral event in 95-210 ms, and 26/29 of Trystero's default relays answered NIP-11; MQTT - 4/4 public brokers (EMQX, HiveMQ, Mosquitto, shiftr) did CONNECT/SUBSCRIBE/PUBLISH in 68-110 ms. Trystero 0.26.0 (2026-10-04) wraps trackers, Nostr and MQTT behind one API. Nostr/MQTT are free-for-all test infrastructure, same caveats as trackers.
10. **Verdict:** use trackers as *one* of two discovery planes. Ship >= 3 live trackers (identical list for every peer, embedded in the magnet), send a keepalive well under 120 s, add a Nostr/MQTT room as an independent second plane, optionally run one tracker of our own on Oracle Always Free, and treat every peer and every operator as hostile/observing.

---

## Method and evidence log

What I actually ran (all from one residential/corporate IP; no real browser available):

- A stdlib-only RFC 6455 WebSocket client (`wsprobe.py`): TLS handshake + certificate dates/issuer, WS upgrade with `Origin: https://example.org`, one `scrape` for 4 demo infohashes (Sintel, Big Buck Bunny, Tears of Steel, Cosmos Laundromat), one `announce` for a random 20-byte infohash (`event:"started"`, `left:1`, `numwant:0`, `offers:[]`), then close.
- `relaytest.py`: two fake peers in a private random swarm: B announces with 1 mock offer, tracker must forward it to A, A answers, tracker must forward the answer to B.
- `offercap.py`: 14 receivers + 1 offerer sending 14 mock offers; count how many offers are forwarded.
- `idle_test.py`: announce once, then stay silent for 230 s; record when the server/proxy closes the socket (my client auto-answers WS pings).
- `nostrprobe.py`: BIP-340-signed ephemeral event (kind 20000-29999, tag `x`) published and received back via a `REQ` filter, exactly the pattern Trystero uses. `mqttprobe.py`: MQTT 3.1.1 over wss round trip.
- DNS cross-checks through Cloudflare and Google DNS-over-HTTPS JSON APIs (my local resolver sinkholes some names, e.g. `broker.hivemq.com` -> `0.0.0.0`, which first produced a *false* "HiveMQ is down"; corrected by resolving via DoH). TLS chains via `openssl s_client`. Hosting ASNs via Team Cymru DNS.
- Source reading: bittorrent-tracker, webtorrent, create-torrent, torrent-discovery, Trystero, aquatic, wt-tracker, wt-tracker-rust, ftorrent repos and docs (raw files fetched 2026-10-14).

Load placed on third-party infrastructure: at most 15 short-lived connections per tracker, a few KB of JSON, random infohashes in private swarms, closed immediately. Not tested: real browsers or phones, real WebRTC establishment, multi-day reliability, per-IP rate limits, behaviour under abusive load.

---

## Findings

### F1. Which public wss:// trackers are alive on 2026-10-14 `[DESIGN-CRITICAL]`

**Claim.** Exactly four general-purpose public WebSocket trackers pass every test; the rest of the historically-listed ones are dead or restricted.

Alive (all four: `101 Switching Protocols` with `Origin: https://example.org`, announce on a random never-published infohash accepted, offer -> answer relay verified end to end):

| Tracker | Verdict | Measured 2026-10-14 | Software / host | Interval, idle-close | Leaf TLS cert |
|---|---|---|---|---|---|
| `wss://tracker.webtorrent.dev` | ALIVE | scrape OK; relay offer 110 ms / answer 106 ms; 14-offer test forwarded **10** | aquatic (site: "running Aquatic"); AS24940 Hetzner (DE); no CDN | 120 s; closed idle socket after ~134 s | Let's Encrypt YR1, 2026-08-25 to 2026-11-23, SAN `*.webtorrent.dev` |
| `wss://tracker.openwebtorrent.com` | ALIVE | announce OK; **scrape: socket closed, no reply**; relay 117 / 118 ms; 14-offer test forwarded **14/14** | Cloudflare-proxied (AS13335, `server: cloudflare`), `uwebsockets: 20` header, public `/stats.json` (schema matches Novage wt-tracker - inference) | 120 s; closed idle socket after ~125 s | Cloudflare edge cert (Google Trust Services WE1), 2026-09-29 to 2026-12-28 |
| `wss://open.ftorrent.com` | ALIVE (new in 2026) | scrape OK (no demo torrents); relay 40 / 42 ms; forwarded **10**; 99.99% 90-day uptime on its own dashboard | aquatic v0.9.0 in Docker behind HAProxy 2.8.16; Ubuntu 24.04 bare metal; AS394838 "Pulse" (US) | 120 s; closed idle socket after ~184 s | Let's Encrypt YE1, 2026-09-07 to 2026-12-06 |
| `wss://tracker.novage.com.ua` | ALIVE | scrape OK; relay 84 / 83 ms; forwarded **10**; public `/stats.json` | `wt-tracker-rust` on Oracle Cloud Ampere A1 Always Free (AS31898) | **180 s**; still open at 235 s (inconclusive: my client answers pings automatically) | Let's Encrypt YE1, 2026-10-03 to 2027-01-01 |

Up but unusable from our loader:

| Tracker | Evidence |
|---|---|
| `wss://tracker.files.fm:7073/announce` | TLS fine (LE YE1, 2026-10-05 to 2027-01-03; AS12578 Tet, LV) but the upgrade returns **HTTP 403** for no `Origin`, `Origin: null`, `https://example.org`, `https://webtorrent.io`; **101 only for `Origin: https://files.fm`**. It is an origin-allowlisted private tracker now. (In Aug 2024 bittorrent-tracker issue #525 reported it as working from an ad-hoc page, so this changed after that.) |
| `wss://peertube.cpy.re:443/tracker/socket` | Upgrade OK (nginx/1.22.1) but announce returns `failure reason: Unknown infoHash ...` - PeerTube instance trackers only accept registered torrents (ngosang blacklists it as "registered torrents"). |

Dead:

| Tracker | Evidence |
|---|---|
| `wss://tracker.btorrent.xyz` | DNS A = **127.0.0.1** (TTL 300) via Cloudflare DoH and locally; TCP connect refused. The parent site `btorrent.xyz` still serves a page (Last-Modified 2026-07-02) but lists no tracker. |
| `wss://tracker.fastcast.nz` | NXDOMAIN (Cloudflare and Google DoH, NZ registry SOA). |
| `wss://tracker.webtorrent.io` | NOERROR, no A record (both DoH). |
| `wss://tracker.sloppyta.co`, `wss://tracker.manager.v6.navy` | NXDOMAIN (both DoH). |
| `wss://tracker.ghostchu-services.top`, `wss://ws.peer.ooo`, `wss://tracker.dnlab.net` | NOERROR, no A (both DoH). ngosang blacklist: `ws.peer.ooo` "deprecated by owner". |
| `wss://qot.abiir.top` | Resolves to Google Cloud IPs; TLS handshake dies with EOF (no working service). |
| `wss://spacetradersapi-chatbox.herokuapp.com` | Heroku "No such app" (HTTP 404). |
| `ws://tracker.nighthawk.pw:2052/announce` | Plain `ws://` - blocked as mixed content from any https page even if alive (ngosang blacklist lists it); not probed. |

**Confidence:** high for the four ALIVE (live protocol test + operator stats + independent third-party defaults, F2); high for DEAD (DNS evidence from two independent DoH providers); high for files.fm (five Origin variants tested).
**Sources:** my probes (scripts in `labs/02-wss-trackers-probes/`); https://cloudflare-dns.com/dns-query and https://dns.google/resolve (2026-10-14); https://tracker.openwebtorrent.com/stats.json; https://webtorrent.dev/ ; https://tracker.novage.com.ua/stats.json ; https://open.ftorrent.com/page.json ; https://github.com/webtorrent/bittorrent-tracker/issues/525 (2024-08-06); https://raw.githubusercontent.com/ngosang/trackerslist/master/blacklist.txt.
**Source date:** all 2026-10-14/15, except issue #525 (2024-08).

### F2. Third-party corroboration of the live set

**Claim.** Three independent, actively maintained sources agree with the probe results.

- **ngosang/trackerslist** (bot-updated daily; last commit touching `trackers_all_ws.txt` 2026-10-13T22:09:46Z; README "Last update 2026/10/15"): `trackers_all_ws.txt` = `wss://tracker.webtorrent.dev:443`, `wss://tracker.openwebtorrent.com:443`, `wss://open.ftorrent.com:443` (3 trackers). `tracker.novage.com.ua` is *not* listed although it passed every test (reason unknown; **unverified** whether the bot even sees it).
- **Trystero 0.26.0** (npm 2026-10-04), `packages/torrent/src/index.ts` `defaultRelayUrls`: `open.ftorrent.com`, `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.btorrent.xyz`, `tracker.files.fm:7073/announce`. `getRelays(config, defaultRelayUrls, 3)` takes the **first 3** (`defaultRedundancy = 3`; no shuffle for the torrent strategy), so by default it uses ftorrent + webtorrent.dev + openwebtorrent. Entries 4-5 are broken from a browser today (dead / origin-locked). CHANGELOG: 0.25.3 (2026-07-13) "new default tracker `open.ftorrent.com`"; 0.23.1 (2026-04-21) "fixed issues with connecting to trackers running on aquatic"; git history: `open.ftorrent.com` added 2026-07-02, "promote ftorrent tracker" 2026-07-13.
- **P2P Media Loader 4.0.0** (npm 2026-08-19) default `trackerAnnounce`: `wss://tracker.novage.com.ua`, `wss://tracker.webtorrent.dev`, `wss://tracker.openwebtorrent.com`.

**Confidence:** high. **Sources:** https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ws.txt ; https://api.github.com/repos/ngosang/trackerslist/commits?path=trackers_all_ws.txt ; https://raw.githubusercontent.com/dmotz/trystero/main/packages/torrent/src/index.ts ; https://raw.githubusercontent.com/dmotz/trystero/main/packages/core/src/utils.ts ; https://raw.githubusercontent.com/dmotz/trystero/main/CHANGELOG.md ; https://github.com/dmotz/trystero/commits/main/packages/torrent/src/index.ts ; https://cdn.jsdelivr.net/npm/p2p-media-loader-core@4.0.0/README.md and `lib/types.d.ts`.
**Source date:** 2026-10-13 .. 2026-10-14.

### F3. `tracker.files.fm:7073` enforces an Origin allowlist `[DESIGN-CRITICAL for anyone copying Trystero's list]`

**Claim.** From a browser on any origin other than `https://files.fm`, the WebSocket handshake fails (403), and the page JS cannot see the status (only `onerror` / close code 1006). Trystero 0.26.0 still lists it as the 5th default (unused unless `relayConfig.redundancy >= 5`). Non-443 ports are also commonly blocked on corporate/mobile networks (**unverified here**).
**Confidence:** high (tested). **Sources:** probes; Trystero source above. **Date:** 2026-10-14.

### F4. Governance, SLA, and who runs these trackers

**Claim.** All four are community/small-company services with no SLA and no published abuse policy.
- openwebtorrent.com (GitHub Pages, Last-Modified 2023-07-06): "OpenWebTorrent is a webtorrent tracker free for anyone to use. You don't need to register, upload or index a torrent anywhere"; outage policy: "First off wait 6 hours ... open an issue at our Github Repo". Lists btorrent.xyz (now dead) and webtorrent.dev as sister trackers.
- webtorrent.dev: "A free-to-use, public WebTorrent tracker, running Aquatic ... This tracker is not associated with WebTorrent LLC or Feross Aboukhadijeh."
- WebTorrent maintainer, issue #957 (2017-01-23): "The webtorrent project doesn't run a tracker, and leaves that up to the community." (older than 2024; still consistent with webtorrent.dev's disclaimer.)
- tracker.novage.com.ua landing page: "a WebTorrent tracker for P2P Media Loader and other WebTorrent clients, running wt-tracker-rust". Operator: Novage, LLC (P2P Media Loader vendor).
- open.ftorrent.com: hobby/infra project (https://github.com/zootella/ftorrent, GPL-3.0, pushed 2026-10-13); its docs are openly AI-assisted ("Prepared by Claude Code using Opus 4.7" in the breaker guide), so treat its numbers as operator claims.

**Confidence:** high for the quotes; medium for the "no SLA" inference (absence of evidence). **Sources:** https://openwebtorrent.com/ ; https://webtorrent.dev/ ; https://github.com/webtorrent/webtorrent/issues/957 ; https://tracker.novage.com.ua/ ; https://docs.ftorrent.com/ ; https://github.com/zootella/ftorrent. **Date:** 2026-10-14 (issue #957: 2017).

### F5. WebTorrent's "default announce list" `[DESIGN-CRITICAL]`

**Claim.**
- **webtorrent 3.0.21** (npm 2026-07-27; Node >= 22 for node usage; pins `bittorrent-tracker` exactly `11.2.3`, `torrent-discovery ^11.0.21`, `@thaunknown/simple-peer ^10.1.2`) has **no built-in tracker list**. `this.tracker = opts.tracker !== undefined ? opts.tracker : {}`; announce URLs come from (a) `tr=` in the magnet / `.torrent`, (b) per-torrent `opts.announce`, (c) `client.tracker.announce` (array, ignored for private torrents), (d) `global.WEBTORRENT_ANNOUNCE`. A magnet without `tr=` and no client-level list => no tracker discovery in the browser (DHT/UDP/TCP do not exist there: "WebTorrent does not support UDP/TCP peers in browser").
- **create-torrent 6.1.3** (npm 2026-07-23) `announceList`, applied only if you pass neither `announce` nor `announceList`: `udp://tracker.leechers-paradise.org:6969`, `udp://tracker.coppersurfer.tk:6969`, `udp://tracker.opentrackr.org:1337`, `udp://explodie.org:6969`, `udp://tracker.empire-js.us:1337`, `wss://tracker.btorrent.xyz` (**dead**), `wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev`. (UDP entries are unusable in browsers.)
- The WebTorrent API doc's example Sintel magnet (docs/api.md) still lists `wss://tracker.btorrent.xyz`, `wss://tracker.fastcast.nz` (**both dead**) and `wss://tracker.openwebtorrent.com`.
- Per-torrent tuning hook: `opts.getAnnounceOpts` / `client.tracker.getAnnounceOpts` can return `{ numwant: N }`; it is merged *after* the default `numwant = 50`, so it overrides it (bittorrent-tracker `client.js _defaultAnnounceOpts`).

**Confidence:** high (read the code). **Sources:** https://raw.githubusercontent.com/webtorrent/webtorrent/master/lib/torrent.js (lines ~337-349, 383-418), `index.js` (line 78), `package.json`, `docs/api.md`, `README.md` ; https://raw.githubusercontent.com/webtorrent/create-torrent/master/index.js (lines 16-24, 252-273) and `README.md` ; https://registry.npmjs.org/webtorrent , /create-torrent. **Date:** 2026-07 releases, fetched 2026-10-14.

### F6. Four server engines speak the same protocol with different strictness `[DESIGN-CRITICAL if we write our own client]`

| Engine | Stack | Used by | `numwant` | Max offers forwarded per announce | Answers | Notable |
|---|---|---|---|---|---|---|
| `bittorrent-tracker` 11.2.3 (reference) | Node + `ws` ^8.17 | self-hosters; historically btorrent/openwebtorrent | ignored: `numwant = min(offers.length, 82)` (`MAX_ANNOUNCE_PEERS = 82`) | 82 | forwarded to any `to_peer_id` still in the swarm; **not validated** against issued offers | scrape works; **scrape with no `info_hash` returns every swarm** (enumerable); no ping; no swarm pruning |
| `aquatic_ws` (aquatic v0.9.0, tag 2024-04-03; master pushed 2026-07-13) | Rust, glommio/io_uring, **Linux >= 5.8** | webtorrent.dev, ftorrent | ignored (`offers.len()`) | `max_offers` default **10** | only for offers it forwarded and younger than `max_offer_age` (120 s); else error "Could not find the offer corresponding to your answer. It may have expired." | strict parsing: **`offer_id` must be exactly 20 bytes** or `{"failure reason":"Invalid request"}` (issue #525); no full scrape; `max_scrape_torrents` 255 |
| `wt-tracker` (Novage; TS + uWebSockets.js v20.71; Node >= 22.18) | Node | appears to be openwebtorrent (**inference**: `uwebsockets: 20` header + `/stats.json` schema with `servers[].webSocketsCount`) | **honoured**: `min(peers-1, offers.length, maxOffers, numwant)`; if `numwant` is not an integer the offers are silently ignored | `maxOffers` default **20** | only to peers in swarm | `idleTimeout`, `allowOrigins`/`denyOrigins`; peers dropped after `2 x announceInterval` silence |
| `wt-tracker-rust` (Novage; Rust, own RFC 6455 impl + rustls) | Rust | tracker.novage.com.ua (since Oct 2026) | as wt-tracker | prod `maxOffers 10` | | built-in TLS with SIGHUP reload, `websocketsAccess.allowOrigins`; no tagged release yet |

There is **no formal spec**: the bittorrent-tracker README says "WebTorrent trackers (BEP forthcoming)"; in issue #525 (2024-08-18) the maintainer ThaUnknown answered "its not a bug, since there's no specification to follow".
**Practical rule for a hand-written client:** always send 20-char `info_hash`/`peer_id`/`offer_id`, and set `numwant = offers.length` (integer).
**Confidence:** high (source + live tests) except the openwebtorrent=wt-tracker attribution (medium, inferred).
**Sources:** https://raw.githubusercontent.com/webtorrent/bittorrent-tracker/master/{server.js,lib/server/parse-websocket.js,lib/server/swarm.js,lib/common.js} ; https://raw.githubusercontent.com/greatest-ape/aquatic/master/crates/ws/README.md , `crates/ws/src/config.rs`, `crates/ws_protocol/src/incoming/announce.rs`, `crates/ws/src/workers/swarm/storage.rs` ; https://raw.githubusercontent.com/Novage/wt-tracker/master/src/fast-tracker.ts and `README.md` ; https://raw.githubusercontent.com/Novage/wt-tracker-rust/main/README.md ; https://github.com/webtorrent/bittorrent-tracker/issues/525. **Date:** code as of 2026-10-14.

### F7. Wire format (as implemented by all four engines) `[DESIGN-CRITICAL]`

All messages are JSON text frames. `info_hash`, `peer_id`, `offer_id`, `to_peer_id` are **20-character "binary strings"** (each char code 0-255; WebTorrent uses `hex2bin(sha1)`), v1 SHA-1 only.

```jsonc
// client -> tracker: announce (optionally with offers)
{"action":"announce","info_hash":"<20 chars>","peer_id":"<20 chars>","uploaded":0,"downloaded":0,"left":0,
 "event":"started" /* | "update" | "completed" | "stopped" */,
 "numwant":5,"offers":[{"offer_id":"<20 chars>","offer":{"type":"offer","sdp":"..."}}]}
// tracker -> client: announce response
{"action":"announce","interval":120,"info_hash":"<20 chars>","complete":0,"incomplete":1}
// tracker -> a random OTHER peer in the swarm: relayed offer
{"action":"announce","info_hash":"...","offer_id":"...","peer_id":"<offerer>","offer":{"type":"offer","sdp":"..."}}
// callee -> tracker: answer
{"action":"announce","info_hash":"...","peer_id":"<callee>","to_peer_id":"<offerer>","offer_id":"...","answer":{"type":"answer","sdp":"..."}}
// tracker -> offerer: relayed answer
{"action":"announce","info_hash":"...","offer_id":"...","peer_id":"<callee>","answer":{"type":"answer","sdp":"..."}}
// scrape (not supported by openwebtorrent: socket is closed)
{"action":"scrape","info_hash":["<20 chars>", "..."]}  ->  {"action":"scrape","files":{"<20 chars>":{"complete":0,"incomplete":0,"downloaded":0}}}
// errors
{"failure reason":"..."}
```
The tracker is a pure rendezvous: it stores `(info_hash, peer_id) -> websocket`, picks random other peers, forwards SDP blobs, and drops the peer when its socket closes (bittorrent-tracker: immediate synthetic `stopped` on close; also LRU eviction after 20 min). **Any 20-char string works as a swarm ID**; I verified that random, never-published infohashes are accepted by all four live trackers (so a custom "rendezvous ID" for the blockchain gossip room is possible). Trackers also see the peer's IP and (inside SDP) its ICE candidates.
**Confidence:** high. **Sources:** `parse-websocket.js`, `server.js` (lines 211-315), `lib/client/websocket-tracker.js` (bittorrent-tracker master, 2026-10-14); aquatic `announce.rs`; live relay tests. **Date:** 2026-10-14.

### F8. Intervals, timeouts and peer lifetimes (server side) `[DESIGN-CRITICAL]`

| Setting | bittorrent-tracker 11.2.3 | aquatic_ws (defaults) | wt-tracker (JS) | Live observed |
|---|---|---|---|---|
| Interval told to WS clients | `ceil(intervalMs/1000/5)`; `intervalMs` default 10 min => **120 s** (CLI `--interval` ms, default 600000) | `peer_announce_interval` **120** | `announceInterval` (code default 20, sample 120) | 120 (webtorrent.dev, ftorrent, openwebtorrent), **180** (novage; its install guide sets `announceInterval: 180`) |
| Peer expiry | LRU per swarm: `peersCacheLength` **1000** peers, `peersCacheTtl` **20 min**; immediate removal when the socket closes | `max_peer_age` 180 (ftorrent sets 240); cleaned every 30 s | silent for `2 x announceInterval` | - |
| Offer lifetime | client destroys unanswered offers after `OFFER_TIMEOUT` **50 s** | `max_offer_age` **120 s**, answers rejected after | - | - |
| Idle connection | **none** (no ping/pong in server code) | `max_connection_idle` 180 ("no responses sent for this long") | `idleTimeout` (sample 240) | closed after ~125 s (openwebtorrent), ~134 s (webtorrent.dev), ~184 s (ftorrent) |
| Message size | `ws` default `maxPayload` **100 MiB** (not overridden) | 64 KiB message / 16 KiB frame | `maxPayloadLength` 65536 | - |

Client side (bittorrent-tracker `websocket-tracker.js`, used by WebTorrent): `DEFAULT_ANNOUNCE_INTERVAL` = **30 s** until the first response, then the server's `interval` (or `min interval`); `OFFER_TIMEOUT` 50 s; trickle ICE **off** (`trickle:false`), so each offer needs complete ICE gathering (simple-peer `ICECOMPLETE_TIMEOUT` 5 s). Trystero (torrent strategy): announces every 10 s at start, then follows the tracker `interval` clamped to [10 s, 120 s]; passive/dormant rooms every 120 s; offers retained 120 s.
**Confidence:** high (code + live). **Sources:** bittorrent-tracker `server.js` (lines 42-44, 253-254), `lib/server/swarm.js` (lines 17-20), `lib/client/websocket-tracker.js` (lines 16-19, 436), `tracker.js`; https://raw.githubusercontent.com/greatest-ape/aquatic/master/crates/ws/src/config.rs ; https://raw.githubusercontent.com/Novage/wt-tracker/master/src/fast-tracker.ts and `sample/config.json` ; https://raw.githubusercontent.com/ThaUnknown/simple-peer/master/lite.js ; Trystero torrent `index.ts` ; probes. **Date:** 2026-10-14.

### F9. How many peers can one announce introduce? `[DESIGN-CRITICAL]`

**Claim.** One announce introduces `min(client offers, server cap, other peers in swarm)` peers; in practice **at most 5 per tracker per announce from a stock WebTorrent browser client**, and the server side is not the bottleneck.

| Layer | Value | Evidence |
|---|---|---|
| WebTorrent 3.0.21 -> bittorrent-tracker 11.2.3 client | `numwant = min(opts.numwant (default 50), 5)`; one fresh `RTCPeerConnection` per offer ("Limit the number of offers that are generated, since it can be slow") | `websocket-tracker.js` line 60-61 |
| P2P Media Loader 4.0.0 | `webRtcOffersCount` default 5; `webRtcOfferTimeoutMs` 50000; `webRtcIceGatheringTimeoutMs` 5000; `webRtcConnectionTimeoutMs` 15000; `p2pMaxPeers` 50 | `lib/types.d.ts` |
| Trystero 0.26.0 torrent strategy | `offersPerAnnounce = 1`, `numwant = 3`; offers created on demand (0.26.0 "instead of keeping prewarmed peer connections") | `index.ts`, CHANGELOG |
| Server cap, measured (14 receivers, 14 offers) | webtorrent.dev **10**, ftorrent **10**, novage **10**, openwebtorrent **14** (>= 14) | `offercap.py`, 2026-10-14 |
| Server cap, source | bittorrent-tracker 82; aquatic `max_offers` 10; wt-tracker `maxOffers` 20 (novage prod 10) | code/configs |

Consequences: (a) offers are generated **per tracker**, so T trackers x 5 offers = **5T `RTCPeerConnection`s every announce cycle** (3 trackers = 15, 4 trackers = 20), each living up to 50 s if unanswered - heavy on phones and wasteful in small swarms; (b) each announce picks random *existing* peers, so in a swarm of N peers announcing every 120 s with 5 offers each, a given peer receives about 5 inbound offers per interval on average (my derivation, **low** confidence as a number, but the mechanism is in the code); (c) discovery is symmetric but event-driven: a lone first visitor sees nobody, and is connected only when a later visitor announces with offers (the tracker relays that offer to the first visitor, who answers); (d) with aquatic-family servers an answer is only accepted for an offer the tracker actually forwarded and within 120 s.
**Confidence:** high (code + measurement). **Sources:** as in the table. **Date:** 2026-10-14.

### F10. Idle closes, keepalive and reconnect behaviour `[DESIGN-CRITICAL]`

**Claim.** In one 230 s run per tracker (announce once, then silence), trackers closed my socket at ~125 s (openwebtorrent), ~134 s (webtorrent.dev) and ~184 s (ftorrent); novage stayed open for the whole 235 s (it may ping; my client auto-answers pings, so inconclusive). Closures were abrupt (EOF, no Close frame). The stock announce cadence is 120 s, which leaves **almost no slack on openwebtorrent/webtorrent.dev**: one late timer (backgrounded tab, throttled timers) and the socket is gone. After a close the stock client does **not** reconnect at once: `RECONNECT_MINIMUM 10 s`, `RECONNECT_MAXIMUM 1 h`, `RECONNECT_VARIANCE 5 min`, `ms = floor(random()*300000) + min(2^retries * 10 s, 1 h)`; `announce()` is a no-op while `reconnecting`. So a dropped phone tab can vanish from the swarm for minutes. Cloudflare documents that it "will close a WebSocket connection when no data is transmitted in either direction for a period of time" (duration unstated) and recommends client heartbeats; nginx closes after 60 s by default (F15).
**Confidence:** high for measured values; medium for the explanation (CDN vs tracker setting not separable). **Sources:** `idle_test.py` run 2026-10-15 00:03-00:07Z; bittorrent-tracker `websocket-tracker.js` lines 16-18, 41, 344-356; https://developers.cloudflare.com/network/websockets/ ; https://nginx.org/en/docs/http/websocket.html. **Date:** 2026-10-14/15.

### F11. Scale of the public trackers (live)

| Tracker | Live figure | Source |
|---|---|---|
| tracker.openwebtorrent.com | **264,806** WebSockets; **2,186,045** peer entries; **352,129** torrents; RSS 4.04 GB (about 15 KB per socket all-in) | `/stats.json` 2026-10-14 23:53Z |
| tracker.webtorrent.dev | last 24 h: peers min 64,213 / max 174,034 (66,427 at 23:56Z); torrents 32,839-66,696; 56 k-186 k requests/min; 113 k-460 k responses/min | embedded Prometheus series on https://webtorrent.dev/ |
| tracker.novage.com.ua | **88,692** WebSockets (+117 on :8080), 77,058 peers, 30,510 torrents, RSS 1.69 GB (about 19 KB per socket all-in), uptime 190,602 s, 2 workers | `/stats.json` 2026-10-15 00:06Z; its README claims 5-9 KiB/connection and 590-690 MiB at 42-47 k peers - observed is higher |
| open.ftorrent.com | WS: 132,948 (IPv4) + 61,932 (IPv6) offers relayed in last 24 h; 99.99% uptime; whole host about 1 GB RAM at 77 M mostly-UDP/HTTP requests/day (measured 2026-06-04) | https://open.ftorrent.com/page.json ; https://docs.ftorrent.com/tracker-load.html |

**Confidence:** high (operator-published, read live). Note these are *connections/peer entries*, not unique users. **Date:** 2026-10-14/15.

### F12. Rate limits and abuse policies of public trackers `[DESIGN-CRITICAL]`

**Claim.** No numeric rate limit or abuse policy is published by openwebtorrent, webtorrent.dev or novage. What exists:
- **Implicit protocol limits:** aquatic 64 KiB message / 16 KiB frame, 10 offers, 255 scrape hashes; wt-tracker `maxPayloadLength` 65536 and `maxOffers`; bittorrent-tracker none (100 MiB `ws` default).
- **open.ftorrent.com circuit breaker** (documented, "Created 2026-May, last reviewed 2026-Jul"): six services (udp/http/ws x v4/v6) metered on rolling 24 h served counts; thresholds in `gauge.py`: udp 600 M, http 200 M, **ws4 / ws6 200,000,000 relayed offers each**; when exceeded the service is paused **24 h** and answered with **HTTP 503 + `Retry-After: 86400`** from HAProxy; the operators report that shedding load *raised* load (whole swarm retried immediately, each retry a fresh TLS handshake). Current WS usage is about 0.1% of the threshold.
- **Origin allowlists:** files.fm (F3); wt-tracker(-rust) support `allowOrigins`/`denyOrigins`/`denyEmptyOrigin`; novage production has no such list (my `example.org` Origin was accepted).
- **Info-hash allowlists:** PeerTube trackers; aquatic `access_list` (allow/deny info hashes), bittorrent-tracker `filter()` hook.
- **Observed:** 14 simultaneous connections from one IP were accepted by all four; ~2.3 KB announce messages accepted; no 429s or bans in a few dozen short sessions.
- Cloudflare-fronted openwebtorrent may apply WAF/rate rules I could not observe (**unverified**).
- No tracker authenticates anyone: any client can create swarms and join any swarm whose 20-char ID it knows; there is no namespace ownership.

**Confidence:** high for documented/observed items; low for "no hidden limits". **Sources:** https://raw.githubusercontent.com/zootella/ftorrent/master/open/breaker/README.md , `open/gauge/src/gauge.py` (`SERVICE_BREAKERS`, `COOL_DURATION`), `open/docker/aquatic-ws.toml` ; aquatic `config.rs` ; wt-tracker `README.md`, `sample/config.json` ; probes. **Date:** 2026-05..2026-10-14.

### F13. Self-hosting `bittorrent-tracker` with WebSocket support

**Claim.** It works with one command, but it is the weakest of the four engines and needs hardening for anything public.
- **Package status:** `bittorrent-tracker` **11.2.3** (npm 2026-05-25; previous 11.2.2 2025-09-06, 11.2.1 2025-01-19). MIT, ESM, `engines.node >= 16`, `ws ^8.17.0` (npm `ws` latest 8.22.0). Repo `webtorrent/bittorrent-tracker`: last push 2026-09-04 (CI/dependency bumps only), 17 open issues/PRs per the GitHub API, not archived => maintenance mode. webtorrent 3.0.21 pins exactly 11.2.3.
- **Run (WS only):** `npm i -g bittorrent-tracker@11.2.3 && bittorrent-tracker --ws --port 8000 --trust-proxy`. Flags (from `bin/cmd.js`): `--ws`, `--http`, `--udp` (none given = all three), `-p/--port` (default 8000), `--trust-proxy`, `--interval <ms>` (default 600000 => WS clients told 120 s), `--stats` (default true), `-q/-s`. With only `--ws` it still creates an internal HTTP server for the upgrade and serves `GET /stats` and `/stats.json` (peer counts and **client names/versions**); every other path is `404`. (Disable stats with minimist's `--no-stats` - convention, **untested here**.)
- **Hardened programmatic server** (the CLI cannot set these; derived from `server.js`, **not run here** - no Node on this machine, Docker daemon was stopped):
  ```js
  import { Server } from 'bittorrent-tracker/server'
  const server = new Server({
    udp: false, http: false, stats: true,
    ws: { maxPayload: 64 * 1024 },        // ws default is 104857600 (100 MiB); server.js does not override it
    trustProxy: true,                     // only if bound to 127.0.0.1 behind Caddy/nginx
    interval: 600000,                     // WS interval = interval/1000/5 = 120 s
    peersCacheLength: 1000, peersCacheTtl: 20 * 60 * 1000,  // per-swarm LRU defaults
    filter: (infoHash, params, cb) => cb(null)             // allow/deny hook; cb(new Error('...')) to refuse
  })
  server.on('warning', () => {}); server.on('error', console.error)
  server.listen(8000, '127.0.0.1')
  ```
- **Resource needs:** 2020 measurement in issue #354: about **12.8 KB per connection** (3.2 KB with uws); the same issue says openwebtorrent ran multiple processes and went "from 50k peers (one process) to 100k"; single Node process is CPU/RAM bound. Order of magnitude for us (my arithmetic, **low** confidence): 1,000 concurrent peers ~ 13 MB of per-connection state plus Node's baseline; any 256-512 MB VM is enough for demo-scale traffic. Novage measured its own Node/uWS tracker at 19-34 KiB per connection and the ftorrent operators claim single-threaded Node "tops out around 600 connections per second" (vendor claims about a competing stack).
- **Defects/limits that matter in production (verified in current code):** (1) `Server.torrents` entries are never deleted (grep: no `delete this.torrents`), issue #164 "Tracker server should prune old torrents and swarm" is open since 2016 (reporter: openwebtorrent's long-running trackers were "full of peers who left ungracefully") => memory grows with distinct infohashes ever announced; (2) no WS ping/pong anywhere in server code => half-open sockets linger until TCP/proxy timeouts, peers up to 20 min; (3) per-swarm LRU caps at 1000 peers; (4) `ws` `maxPayload` 100 MiB => memory DoS from one client; (5) `scrape` without `info_hash` returns all swarms; (6) `trustProxy` trusts `X-Forwarded-For` blindly; (7) answers are routed to any peer id in the swarm without checking the offer.
**Confidence:** high for code-derived facts; medium for resource figures (2020 data, vendor comparisons). **Sources:** https://raw.githubusercontent.com/webtorrent/bittorrent-tracker/master/{package.json,server.js,bin/cmd.js,README.md,CHANGELOG.md} ; https://registry.npmjs.org/bittorrent-tracker ; https://api.github.com/repos/webtorrent/bittorrent-tracker (2026-10-14) ; issues #164, #354, #525 ; https://github.com/websockets/ws/blob/master/doc/ws.md (`maxPayload` "Defaults to 104857600 (100 MiB)"). **Date:** 2026-10-14 (issue #354: 2020; #164: 2016).

### F14. Better self-host engines (aquatic_ws, wt-tracker, wt-tracker-rust)

- **aquatic_ws** (Rust, Apache-2.0; tag v0.9.0 dated 2024-04-03; master pushed 2026-07-13 with unreleased ws changes; 628 stars, 15 open issues/PRs; "High-performance WebTorrent tracker for Linux 5.8 or later"; "has not been tested as much as aquatic_udp, but likely works fine in production"; known user webtorrent.dev). Needs io_uring (glommio) and a raised memlock limit (`LimitMEMLOCK=262144000`); `socket_workers`/`swarm_workers` = 1 each for 1-7 cores; built-in TLS expects **DER** cert/key (`tls_certificate_path`, `tls_private_key_path`, reloaded on SIGUSR1) or a reverse proxy that preserves IP family (IPv4 clients -> IPv4 upstream, IPv6 -> IPv6; **no `X-Forwarded-For` support**); `access_list` (info-hash allow/deny, reloaded on SIGUSR1); Prometheus endpoint; `GET /health` (not with built-in TLS). ftorrent's Dockerfile pins **Rust 1.85** because v0.9.0's metrics dependency does not compile on Rust >= 1.93, and needs a custom seccomp profile for io_uring in Docker. Platforms without io_uring (macOS, Windows, gVisor-type sandboxes - the last one **unverified**) cannot run it.
- **wt-tracker** (Novage; TypeScript + uWebSockets.js v20.71; Node >= 22.18): "handles up to 20k WebSocket Secure peers on a VPS with only 2 GiB memory and 1 virtual CPU" (vendor claim); `/stats.json`; origin allow/deny lists; README now says "We recommend wt-tracker-rust ... for new deployments".
- **wt-tracker-rust** (Novage; Apache-2.0; same `config.json` and byte-identical replies, differential-tested): "in production since October 2026 at wss://tracker.novage.com.ua (Oracle Cloud Ampere A1, 2 cores, Always Free), with up to 51k concurrent peers so far" (live stats on 2026-10-15: 88,692 sockets). Claims **0.35 cores / 590 MiB at ~42 k connections vs aquatic_ws 1.46 cores / 1.9 GiB** on the same host (vendor comparison; observed RSS today is 1.69 GB at 88.7 k sockets). Built-in rustls TLS with SIGHUP reload, `websocketsAccess.allowOrigins`, Prometheus `/metrics`. No GitHub release yet, brand-new => treat as early-stage. Its Oracle guide says to use **stateless** security-list rules because stateful ones fill Oracle's connection-tracking table at about 40 k peers and silently drop new connections (SSH included).
  Reference production config (from the guide): `{"tracker":{"maxOffers":10,"announceInterval":180},"websockets":{"path":"/*","maxPayloadLength":65536,"idleTimeout":190,"compression":1,"compressOutgoingMinSize":256}}`, egress budget "about 100k peers at ~38 B/s each" inside Oracle's 10 TB/month.
- **ftorrent's published aquatic_ws config** (deviations from defaults): `max_peer_age` 240, `enable_http_health_checks` true, Prometheus on; `max_offers` 10, `peer_announce_interval` 120, `max_connection_idle` 180 (defaults).
**Confidence:** high for the configs/quotes; medium for performance comparisons (competitor-authored). **Sources:** https://raw.githubusercontent.com/greatest-ape/aquatic/master/{crates/ws/README.md,crates/ws/src/config.rs,CHANGELOG.md} ; https://raw.githubusercontent.com/zootella/ftorrent/master/open/docker/{aquatic-ws.toml,Dockerfile.ws} ; https://raw.githubusercontent.com/Novage/wt-tracker-rust/main/{README.md,docs/install-oracle-ampere-a1.md} ; https://raw.githubusercontent.com/Novage/wt-tracker/master/README.md ; https://tracker.novage.com.ua/stats.json ; https://docs.ftorrent.com/software-selections.html. **Date:** 2026-10-14.

### F15. TLS and reverse proxies in front of a tracker

- Pages on https can only open `wss://` (mixed content blocks `ws://`), with a valid hostname certificate; no raw IPs. Observed chains (all verified OK on macOS trust store; **iOS/Android trust stores not tested**): leaf -> Let's Encrypt `YR1`/`YE1` -> `ISRG Root YR`/`YE` (cross-signed by `ISRG Root X1`/`X2`, valid to 2032-09-02). Leaf `notBefore` dates of 2026-08-25, 09-07, 10-03 (and Cloudflare 09-29) show certificates are being renewed on schedule.
- **Caddy:** `tracker.example.com { reverse_proxy 127.0.0.1:8000 }` is enough: automatic HTTPS, WebSocket proxying built in, sets/appends `X-Forwarded-For` (ignores client-supplied values unless `trusted_proxies`); `stream_timeout` default none; **a config reload forcibly closes WebSockets** unless `stream_close_delay` is set. (Snippet derived from docs; **untested here**.)
- **nginx:** needs `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` (`proxy_http_version 1.1` only before nginx 1.29.7) and **`proxy_read_timeout` above the announce interval**: nginx's docs: "By default, the connection will be closed if the proxied server does not transmit any data within 60 seconds" - with a 120 s announce interval and a server that never pings, stock nginx would drop every tracker socket each minute.
- **HAProxy** (ftorrent, production) terminates TLS and routes WS by `Upgrade` header; Caddy serves the dashboard.
- **Cloudflare in front** (openwebtorrent does this): WebSockets on all plans, idle timeout unstated ("will close a WebSocket connection when no data is transmitted in either direction for a period of time"), deploys may terminate sockets, no stated concurrent-connection cap. The origin sees Cloudflare IPs unless `trustProxy`/`CF-Connecting-IP` is handled.
- `bittorrent-tracker` has no built-in TLS (plain `http` server); aquatic and wt-tracker(-rust) have it.
**Confidence:** high for quotes; medium for untested snippets. **Sources:** https://nginx.org/en/docs/http/websocket.html ; https://caddyserver.com/docs/caddyfile/directives/reverse_proxy ; https://developers.cloudflare.com/network/websockets/ ; `openssl s_client -showcerts` runs 2026-10-14; https://raw.githubusercontent.com/zootella/ftorrent/master/open/breaker/README.md. **Date:** 2026-10-14 (docs undated).

### F16. Free-tier hosting for an always-on WS tracker `[DESIGN-CRITICAL for the "own tracker" option]`

| Platform | What the official doc says (read 2026-10-14) | Fit |
|---|---|---|
| **Oracle Cloud Always Free** | `VM.Standard.A1.Flex`: "first 1,500 OCPU hours and 9,000 GB hours per month ... For Always Free tenancies, this is equivalent to **2 OCPUs and 12 GB**" (single instance or two x 1 OCPU); up to two `VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB, 50 Mbps); **10 TB/month outbound**; 200 GB block+boot; home region only; "Out of host capacity" possible; PAYG upgrade keeps Always Free resources free. **Idle reclamation:** instance deemed idle if over 7 days CPU p95 < 20% and network < 20% and (A1 only) memory < 20% => "may be reclaimed". Outbound TCP 25 blocked. | **Best fit.** novage runs 88.7 k WebSockets on this tier. A near-idle tracker could trip the reclamation rule (mitigate with a cron busy-loop or by paying for PAYG - **unverified** whether either avoids reclamation). My recollection of older Oracle documentation is 4 OCPU / 24 GB (not re-verified this session); today's page says 2 / 12, and wt-tracker-rust's guide also says 2 OCPU / 12 GB. |
| **Cloudflare Workers + Durable Objects** | Free plan: DO available, **SQLite-backed only**; 100,000 requests/day; 13,000 GB-s duration/day; incoming WS messages billed 20:1 (100 messages = 5 requests), outgoing and protocol pings free, connection = 1 request; hibernation => no duration charge while idle; soft limit 1,000 req/s per object; 32 MiB max received message; code deploys disconnect all WebSockets. Workers Free: 10 ms CPU per HTTP request, 128 MB per isolate. | Possible, **not proven** (see F17). |
| **Fly.io** | "New organizations don't have a free tier or a monthly free usage allowance." Trial: up to 2 h of Machine runtime or 7 days. Smallest machine (shared-cpu-1x 256 MB) **$2.19/month**; egress $0.02/GB (NA/EU), $0.04/GB (APAC/SA), $0.12/GB (Africa/India); dedicated IPv4 $2/month; shared IPv4 and IPv6 free. Plans discontinued in Oct 2024 keep their old allowances. | Cheap, not free. |
| **Render Free web service** | 750 instance-hours/month; spins down after **15 min without inbound traffic** (explicitly "both HTTP requests and WebSocket messages from existing connections"), ~1 min to spin up; "Do not use them for production"; no persistent disk; may be restarted at any time; may be suspended for high service-initiated traffic. | Poor: cold start = first visitor's WS fails then waits the 10 s + U(0, 5 min) reconnect backoff. |
| **Google Cloud** | Compute: one non-preemptible e2-micro/month in us-west1, us-central1 or us-east1; 30 GB-months disk; **1 GB/month** outbound from North America. Cloud Run: 2 M requests, 360,000 GB-s, 180,000 vCPU-s per month, 1 GB egress. | Egress far too small (~38 B/s per peer = ~100 MB per peer-month). |
| Koyeb, Railway, Heroku, AWS free tier | **Unverified.** Search results conflict on Koyeb (reports of an acquisition by Mistral AI on 2026-02-17 and of the free tier being removed or card-gated); Heroku had no free tier after 2022 (older knowledge). | n/a |

**Confidence:** high for Oracle/Cloudflare/Fly/Render/GCP (official docs); low for the "unverified" row. **Sources:** https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (fetched twice, raw text confirmed) ; https://developers.cloudflare.com/durable-objects/platform/pricing/ , /limits/ , https://developers.cloudflare.com/workers/platform/limits/ ; https://docs.fly.io/about/pricing ; https://render.com/docs/free ; https://docs.cloud.google.com/free/docs/free-cloud-features. **Date:** read 2026-10-14; Cloudflare pricing page says "Last updated Sep 30, 2026"; Fly/Render/Oracle pages carry no date.

### F17. Can a Cloudflare Worker be a WebTorrent WS tracker?

**Claim.** Not with a plain Worker; **yes in principle with a Durable Object**, but no public implementation of the WebTorrent tracker protocol exists that I could find, so it would be our own prototype.
- A plain Worker can terminate a WebSocket, but each isolate is independent and any colo can serve the next request, so peers of one swarm would not share state. A Durable Object is a single-threaded rendezvous with a name (e.g. the swarm ID), WebSocket Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, `ctx.getWebSockets()`), per-socket `serializeAttachment` (max 16,384 bytes) to restore peer state after eviction (in-memory state resets on hibernation), automatic ping/pong that does not wake the object.
- Search found only partial matches: `cf-feditorrent` ("WebSocket-based BitTorrent tracker via Cloudflare Durable Objects" in `src/tracker-do.ts`, 0 stars, 10 commits, no protocol docs), `cf-http-tracker` (HTTP only, one DO per torrent), `weblink-ws-worker` (room signaling). **None implements announce/offer/answer for `wss://` WebTorrent clients as far as I can verify.**
- **Design constraint:** one WebSocket terminates in exactly one DO, but the stock WebTorrent client multiplexes all torrents of a tracker URL over one socket. Per-swarm DOs therefore need a per-swarm URL (e.g. `wss://t.example.workers.dev/<infohash>`) - feasible because the loader controls `tr=` - or one global DO (soft limit 1,000 req/s, shared memory).
- **Free-plan arithmetic (mine, low confidence):** an always-open tab sends 1 announce + about 5 answers per 120 s => ~180 incoming messages/hour => ~216 billed requests/day (20:1) => the 100 k/day Free budget carries **~460 always-on tabs/day**, or on the order of 80 k short (3 min) visits/day. Duration is not binding with hibernation. A Cloudflare Community post (about 3 days before 2026-10-14) reports Free-tier DO calls failing at ~64 k billed requests, i.e. enforcement may not match the documented 20:1 - **unverified, user report only**.
**Confidence:** high for platform facts; low for feasibility numbers. **Sources:** the three Cloudflare doc pages above + https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ; https://github.com/manalejandro/cf-feditorrent ; https://github.com/yanshiqwq/cf-http-tracker ; https://github.com/99percentpeople/weblink-ws-worker (search hits only) ; https://community.cloudflare.com/t/durable-objects-free-quota-block-below-100k-after-websocket-20-1-adjustment/967650 (search hit only). **Date:** 2026-10-14.

### F18. Alternative signaling #1: Nostr relays (Trystero's default strategy) - verified live

**Claim.** Public Nostr relays work today as a free WebRTC signaling bus with no tracker involved, via ephemeral events.
- **Mechanism (Trystero 0.26.0 `packages/nostr/src/index.ts`):** each room topic maps to `kind = 20000 + (hash(topic) mod 10000)` (NIP-01 ephemeral range, not stored), tag `["x", topic]`, subscription `{kinds:[kind], since: now, "#x":[topic]}` (up to 250 topics per REQ); events signed with a throw-away BIP-340 key; peers announce on join and re-announce slowly (`steadyAnnounceIntervalMs` 60 s). Default relays = 29 URLs, **5 are used per app** (`defaultRedundancy = 5`, list shuffled deterministically by `appId`). Rate-limited `OK false "rate-limited:..."` replies trigger per-relay backoff (max 15 min). SDP payloads are encrypted by default with a key derived from appId+roomId (README: a relay operator can reverse it; pass `password` for a real secret).
- **Live test (my `nostrprobe.py`):** 6/6 relays accepted an ephemeral event from a random key with no auth/payment and echoed it to a subscriber: nos.lol (strfry 1.1.3) OK 112 ms / echo 210 ms; relay.nostrmap.net (strfry) 117 / 213 ms; 0x-nostr-relay.fly.dev (nostr-rs-relay 0.9.0) 95 / 95 ms; relay.bullishbounty.com (nostream 2.1.0) 142 / 142 ms; relay.piazza.today (Ditto) 99 / 99 ms; relay.nostr.dev.br (nostr-rs-relay 0.10.0) 102 / 102 ms; WS connect 315-587 ms.
- **NIP-11 sweep of all 29 default relays:** 26 returned a parseable info document; 1 malformed JSON (`nostr.christiansass.de`), 1 HTML error page (`nostr.robosats.org`), 1 no response (`bendernostur.duckdns.org:8443`). Software: mostly strfry, plus nostr-rs-relay, nostream, Ditto, custom. Advertised limits where present: `max_message_length` 65,536-4,000,000 (strfry 131,072), `max_subscriptions` 10-5,000 (strfry 20); none advertised `auth_required` or `payment_required` = true.
- **Trystero's own assessment (README):** Nostr has "hundreds of active relays", is the default, and the other strategies are recommended "in the order of MQTT, BitTorrent, and IPFS, based on robustness" (they "have far less relay redundancy than Nostr"). CHANGELOG: relay lists were pruned/updated in 0.20.1 (2025-02-15), 0.21.8 (2025-09-03), 0.23.0/0.23.1 (2026-03/04, "Removed dead default relays"), 0.25.4 (2026-08-30), 0.26.0 (2026-10-04).
**Confidence:** high (live E2E + source). **Caveat:** relays are independent; acceptance of ephemeral kinds, rate limits and PoW/auth rules can change without notice. **Sources:** https://raw.githubusercontent.com/dmotz/trystero/main/packages/nostr/src/index.ts , `README.md`, `CHANGELOG.md` ; `nostrprobe.py`; NIP-11 documents fetched from each relay root with `Accept: application/nostr+json`. **Date:** 2026-10-14.

### F19. Alternative signaling #2: public MQTT brokers over wss - verified live

**Claim.** Four public brokers work for pub/sub signaling today, with explicit "testing only" terms.
- Trystero 0.26.0 MQTT defaults (`defaultRedundancy = 4`): `wss://broker.emqx.io:8084/mqtt`, `wss://public:public@public.cloud.shiftr.io`, `wss://broker.hivemq.com:8884/mqtt`, `wss://test.mosquitto.org:8081/mqtt`.
- **Live (my `mqttprobe.py`, MQTT 3.1.1, subprotocol `mqtt`):** all four returned CONNACK 0, SUBACK, and echoed my own QoS-0 publish: EMQX 68 ms (connect 392 ms), Mosquitto 85 ms (457 ms), HiveMQ 106 ms (387 ms; reached via DoH-resolved IP because my local resolver returns `0.0.0.0` for `broker.hivemq.com`), shiftr 110 ms (726 ms).
- **Terms:** Mosquitto - "provided as a service for the community to do testing ... You are free to use it for any application, but please do not abuse or rely upon it for anything of importance"; "websockets and TLS support are the most likely to be unavailable"; unauthenticated clients may publish to every topic and subscribe to all but `#`; no stated rate/size limits. HiveMQ - "The broker is public and shared, so it is not intended for private or production data." EMQX - "Free public MQTT broker ... to prototype, learn, and test MQTT"; no limits stated on the page (cloud upsell: "EMQX Cloud free with 1M session min/month"). Topics are world-readable.
**Confidence:** high for liveness; medium for policy (marketing pages, undated). **Sources:** https://raw.githubusercontent.com/dmotz/trystero/main/packages/mqtt/src/index.ts ; https://test.mosquitto.org/ ; https://www.hivemq.com/mqtt/public-mqtt-broker/ ; https://www.emqx.com/en/mqtt/public-mqtt5-broker ; `mqttprobe.py`. **Date:** 2026-10-14.

### F20. Other signaling options

- **Trystero `ws-relay`** (package added in Trystero 0.24.0, 2026-04-27; limits added in 0.26.0): a tiny pub/sub relay you host on Node/Bun/Deno (`createWsRelayServer({port})`); defaults `maxPayload` 1 MiB, `maxTopicLength` 256, `maxSubscriptionsPerSocket` 128, `maxSubscriptions` 10,000 (0.26.0 changelog: "configurable topic and subscription limits to prevent resource exhaustion"). No public default servers - the page must pass `relayConfig.urls`. Not speaking the WebTorrent tracker protocol (so WebTorrent cannot use it), but fine for our own gossip room.
- **Firebase / Supabase** strategies: need our own project (BaaS, free tiers) - a backend in all but name; **not evaluated**. **IPFS** strategy: "now reliably working" since 0.22.0 (2025-10-11), heavier; **not evaluated**.
- **PeerJS Cloud** (`0.peerjs.com`): alive (HTTP 200 JSON, Cloudflare); peerjs.com says "Use our free cloud server or host your own PeerServer" but documents no limits/uptime; `peer` (PeerServer) npm 1.0.2 last modified 2024-05-04. Centralised single operator - lowest priority.
- **Torrent peer exchange / DHT:** not available to WebRTC peers in browsers ("WebTorrent does not support UDP/TCP peers in browser"); tracker (or the alternatives above) is the only bootstrap channel for a browser-only swarm.
**Confidence:** medium-high. **Sources:** https://raw.githubusercontent.com/dmotz/trystero/main/README.md , `packages/ws-relay/src/server.ts`, `CHANGELOG.md` ; https://peerjs.com/ ; https://0.peerjs.com/ ; https://registry.npmjs.org/peer. **Date:** 2026-10-14.

### F21. WebRTC connectivity defaults (what the tracker does NOT solve)

simple-peer (`@thaunknown/simple-peer` 10.1.2, npm 2026-07-25) defaults: `iceServers: [{urls:['stun:stun.l.google.com:19302','stun:global.stun.twilio.com:3478']}]`, `sdpSemantics:'unified-plan'`, **no TURN**; trickle off in the tracker client; `ICECOMPLETE_TIMEOUT` 5 s. Trystero's README tells apps that fail across some ISP pairs to add a TURN server (it cites Cloudflare TURN's free tier of "1,000 GB traffic per month" and Open Relay; **I did not verify those offers**). Override in WebTorrent via `new WebTorrent({ tracker: { rtcConfig: { iceServers: [...] } } })`. Whether mobile carrier CGNAT/symmetric NAT breaks STUN-only connections for our users is **unverified** here (cross-topic).
**Confidence:** high for defaults. **Sources:** https://raw.githubusercontent.com/ThaUnknown/simple-peer/master/lite.js (lines 11, 877-889) ; Trystero README (TURN section). **Date:** 2026-10-14.

### F22. Browser/mobile aspects relevant to tracker connections

- WebSocket and RTCPeerConnection are not the compatibility bottleneck: caniuse data file shows 97.49% global usage with full WebSocket support and 97.26% for WebRTC peer connections (first full support - WebSocket: iOS Safari 6.0, Safari 7, Chrome 16, Firefox 11, Edge 12, Samsung Internet 4; WebRTC: iOS Safari 11.0, Safari 11, Chrome 23, Firefox 22, Edge 79, Samsung Internet 4; the file tracks Android Chrome 154 and Android Firefox 157). Data-file date not recorded.
- A browser WebSocket gives JS no HTTP status: a `403` (files.fm), `503` (ftorrent breaker) or failed TLS all look like `onerror` + close code 1006.
- **Backgrounded mobile tabs:** multiple independent project reports describe iOS Safari freezing/killing a backgrounded tab's socket without a `close` event, timers suspended, and the usual fix = reconnect on `visibilitychange`/`pageshow` plus an application-level ping to detect zombie sockets (trpc#4078, Apple Developer Forums thread 716118 and several PRs). All anecdotal; **no official WebKit documentation found**. Combined with F10 (125-184 s idle closes) and the stock 10 s + U(0, 5 min) reconnect, expect mobile peers to drop off trackers often.
**Confidence:** high for caniuse numbers; medium for mobile-background behaviour (consistent anecdotes). **Sources:** https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/websockets.json , `rtcpeerconnection.json` ; https://github.com/trpc/trpc/issues/4078 ; https://developer.apple.com/forums/thread/716118 ; https://github.com/JollyGrin/unbrewed-p2p/pull/865 (search hits). **Date:** 2026-10-14.

### F23. Security and privacy properties of tracker-based signaling

- Operators see: your IP, the infohash (= site identity), a random-per-session `peer_id`, and the SDP (ICE candidates, usually including your public IP via STUN; mDNS-obfuscated host candidates). Any peer in the swarm learns your IP once connected. bittorrent-tracker lets anyone enumerate all infohashes on an instance (scrape without `info_hash`); aquatic disallows full scrapes.
- No authentication or namespace ownership: anyone who knows the 20-char ID can announce, send offers (spam RTCPeerConnections to peers) and occupy swarm slots. A page must cap pending offers/peers locally and treat all messages as hostile.
- Third-party operators can drop or reorder messages or shut down at will (btorrent.xyz -> 127.0.0.1; ftorrent 24 h `503`).
**Confidence:** high (follows from code/protocol). **Sources:** F6/F7 sources. **Date:** 2026-10-14.

---

## Recommendations for our design

**R1. Ship our own tracker list; do not inherit anyone's defaults.** `[DESIGN-CRITICAL]` Put the same ordered list in (a) the magnet `tr=` parameters and (b) loader code as fallback, and have every peer announce to **all** entries (peers that share no tracker never find each other; mixing custom and default lists splits matchmaking - Trystero users reported exactly this, gritos#51 / formulita#8, search hits). Start with:
`wss://tracker.webtorrent.dev`, `wss://tracker.openwebtorrent.com`, `wss://tracker.novage.com.ua` (+ `wss://open.ftorrent.com` as an optional 4th, + our own tracker, R6). That is four independent operators and infrastructures (Hetzner, Cloudflare-proxied, Oracle, colo). Exclude `btorrent.xyz`, `fastcast.nz`, `files.fm`, anything `ws://`, anything on a non-443 port, and PeerTube trackers.

**R2. Budget offers per tracker.** `[DESIGN-CRITICAL for mobile]` Stock WebTorrent creates up to 5 `RTCPeerConnection`s per tracker per announce (5T per cycle). Pass `tracker: { getAnnounceOpts: () => ({ numwant: 3 }) }` (or 2 on phones; heuristic, **untested**) so the browser creates 2-3 offers per tracker. Servers accept 10+, so nothing is lost on the server side; duplicate introductions across trackers are wasted work.

**R3. Keepalive and fast reconnect.** `[DESIGN-CRITICAL]` Measured idle closes are 125-184 s against a 120 s announce interval. Plan on (a) a lightweight keepalive announce (`event:"update"`, `numwant:0`, no offers) every ~60 s per tracker socket while the page is visible; (b) on `visibilitychange`->visible, `pageshow`, `online`: probe each socket, and if closed/zombie, tear the tracker client down and create a fresh one immediately (torrent-discovery's `updatePort()` recreates the tracker client; this internal hook is **untested** for that purpose) instead of waiting out the stock `10 s + U(0, 5 min)` backoff; (c) our own reconnect: exponential 1 s -> 60 s with full jitter, per tracker, plus a per-tracker circuit breaker (a `503` means "stay away for hours", F12).

**R4. Make the tracker list updatable without redeploying the loader.** Carry it in the DNS TXT/config next to the magnet (a magnet with `xt` + 6-char `dn` + four percent-encoded `tr=wss://...` entries is **220 bytes**, 187 with three trackers, 196 with four unencoded - fits one 255-byte TXT string; adding `ws=`/`xs=` or a long `dn` will not). At boot probe candidates in parallel (3 s timeout: connect, send announce with `numwant:0`, expect a response with `interval`), keep the first 3 that answer plus our own, cache the result in `localStorage` as a per-viewer convenience only. **Do not use `scrape` for health checks** (openwebtorrent closes the socket).

**R5. Add a second, independent discovery plane for the gossip/blockchain room.** `[DESIGN-CRITICAL]` Trackers are the only way to bootstrap the *torrent* swarm, but the chain network can also find peers through Nostr or MQTT, which were verified live and cost nothing. Suggested: a Trystero room whose ID is `sha1("magnet-web/chain/v1/" + infohash)` on a pinned list of 5 verified Nostr relays (nos.lol, relay.nostrmap.net, 0x-nostr-relay.fly.dev, relay.bullishbounty.com, relay.nostr.dev.br; pass `relayConfig.urls`, because with `urls` *all* are used), with MQTT (`broker.emqx.io`, `test.mosquitto.org`, `broker.hivemq.com`) as a third fallback. Alternative with less tracker load: run the chain gossip over the torrent swarm's own wires (BEP-10 extension) and use the Nostr room only for bootstrap/fallback - an architecture-phase decision; both are supported by the findings.

**R6. Run one tracker of our own (optional but recommended for the example).** Cheapest durable option: **Oracle Always Free A1** (2 OCPU/12 GB, 10 TB egress) in the home region with **stateless** security-list rules, `tracker.<our-domain>` A record, Let's Encrypt. Engine: for the demo, `bittorrent-tracker` 11.2.3 via the hardened wrapper in F13 behind Caddy (`reverse_proxy 127.0.0.1:8000`; set `stream_close_delay`); for longevity prefer `aquatic_ws` (older, runs webtorrent.dev) or `wt-tracker-rust` (runs novage, newest). Add it as an extra `tr=` entry, never as the only one. Keep a tiny cron/healthcheck so Oracle's idle-reclamation rule (7 days of CPU p95 < 20% **and** network < 20% **and** memory < 20%) is not our silent failure mode; consider PAYG upgrade (Always Free resources stay free) - whether either prevents reclamation is **unverified**. Cloudflare Workers + Durable Objects is a possible zero-server variant but needs our own protocol implementation and is unproven (F17) - prototype only if "no server of any kind" is a hard requirement.

**R7. If we write our own tracker client (for the chain room), follow the strictest server.** 20-char strings for `info_hash`/`peer_id`/`offer_id`/`to_peer_id`; `numwant = offers.length` as an integer; <= 10 offers per announce and <= ~40 KiB per message (aquatic 64 KiB limit); random 20-char `offer_id`s; answer within 50 s; handle `failure reason`; ignore messages whose `info_hash` does not match; reuse one socket per tracker URL across rooms (as WebTorrent's socket pool does).

**R8. Treat every peer and operator as hostile and observing.** `[DESIGN-CRITICAL]` Cap pending offers (e.g. <= 20 live `RTCPeerConnection`s), cap total peers (P2P Media Loader uses `p2pMaxPeers` 50 with a 1.5x hard limit), validate message sizes, sign chain entries and verify torrent content by piece hashes/signed manifest; assume tracker/relay operators can log (IP, infohash, SDP); use Trystero's `password` option for the Nostr/MQTT room if SDP confidentiality from relay operators matters.

**R9. Monitoring.** Re-run `labs/02-wss-trackers-probes/wsprobe.py` + `relaytest.py` on a schedule (GitHub Actions cron) and fail loudly when fewer than 3 trackers pass; alert on any new `403`/`503`. The ecosystem lost `btorrent.xyz` and `fastcast.nz` silently; `create-torrent` and Trystero still ship dead entries.

**R10. Test matrix before launch (not done here):** real iOS Safari, Android Chrome, Samsung Internet, Firefox, Brave, Edge, each with tab-background/foreground and screen-lock cycles, on Wi-Fi and a CGNAT mobile carrier, with and without a DNS blocklist resolver.

---

## Gotchas

1. **Dead entries are still shipped.** `create-torrent` 6.1.3 default list, WebTorrent docs' sample magnet, Trystero 0.26.0's 4th/5th entries, and many community lists contain `tracker.btorrent.xyz` (A = 127.0.0.1) and/or `fastcast.nz` (NXDOMAIN) or `tracker.files.fm:7073` (403 for foreign origins).
2. **Local DNS blocklists can sinkhole tracker/broker names** (my resolver turned `broker.hivemq.com` into `0.0.0.0` and caused a false "dead" result). A visitor behind such a resolver loses that endpoint with no JS-visible reason.
3. **Server implementations differ:** aquatic requires 20-byte `offer_id` and validates answers against forwarded offers; wt-tracker honours `numwant` and silently ignores offers if it is not an integer; bittorrent-tracker ignores `numwant` and does not validate answers; openwebtorrent closes the socket on `scrape`.
4. **Offers multiply per tracker** (5 x trackers per cycle); unanswered offers live 50 s.
5. **Idle sockets are cut at ~125-184 s** by the live trackers/CDN; nginx cuts at 60 s by default; the reference server never pings.
6. **Stock reconnect is slow:** `10 s x 2^retries + U(0, 5 min)`, and `announce()` is a no-op while reconnecting.
7. **bittorrent-tracker server defects:** no swarm pruning (issue open since 2016), 1000-peer LRU per swarm, 20 min ghost peers, `ws` `maxPayload` 100 MiB, scrape-all enumerates swarms, `--trust-proxy` trusts any `X-Forwarded-For` (bind to loopback). The CLI cannot set `maxPayload`/`peersCache*`; use the API.
8. **aquatic_ws:** Linux >= 5.8 only (io_uring), memlock limit required, DER certs for built-in TLS, no `X-Forwarded-For` (proxy must preserve IP family), v0.9.0 does not compile on Rust >= 1.93 (ftorrent pins 1.85), Docker needs a custom seccomp profile; last tagged release 2024-04-03.
9. **wt-tracker-rust is weeks old** (production since Oct 2026, no GitHub release); its performance numbers are the author's; observed RSS today (1.69 GB at 88.7 k sockets) is higher than its README's 5-9 KiB/connection.
10. **Oracle Always Free:** use stateless rules (stateful ones silently drop new connections at ~40 k peers), home-region only, "Out of host capacity" errors happen, idle instances can be reclaimed (7-day CPU/network/memory < 20% rule), outbound TCP 25 blocked; today's A1 allowance is 2 OCPU / 12 GB.
11. **Cloudflare DO:** deploys disconnect all WebSockets; hibernation resets in-memory state (attachments max 16,384 bytes); incoming WS messages are billed 20:1 and a user reports Free-tier cut-offs below the documented limit; one socket = one DO.
12. **Render Free** sleeps after 15 min without inbound traffic; **Fly.io** has no free tier for new orgs; **GCP e2-micro** includes 1 GB/month egress only.
13. **Caddy reload closes all WebSockets** unless `stream_close_delay`; **nginx** needs `proxy_read_timeout` > announce interval and Upgrade headers.
14. **The browser hides HTTP errors:** 403/503/TLS failures all surface as close code 1006; a 24 h `503` (ftorrent breaker) looks like any outage.
15. **Retry storms:** ftorrent observed that rejecting traffic raised load as clients retried at once. Use jittered exponential backoff and a per-tracker breaker.
16. **Public MQTT/Nostr terms are "testing" terms:** Mosquitto says websockets/TLS are "the most likely to be unavailable"; MQTT topics are world-readable; Nostr relays can rate-limit or change accepted kinds.
17. **SDP leaks IPs to the signaling medium;** Trystero's default SDP key is derivable from appId + roomId.
18. **STUN only by default** (Google + Twilio); no TURN; CGNAT/symmetric NAT success is unverified.
19. **Background tabs on iOS** may lose sockets silently (anecdotal); timer-driven keepalives pause while suspended.
20. **Trailing slashes in tracker URLs:** bittorrent-tracker strips a trailing `/` from announce URLs and de-duplicates the list (`client.js` lines 72-80); keep one canonical spelling in the magnet and the loader so socket pooling and dedupe behave.
21. **ftorrent's docs are AI-assisted** (header: "Prepared by Claude Code using Opus 4.7") - useful, but numbers are operator claims; the one I re-verified in raw HTML (HAProxy 2.8.16, Ubuntu 24.04 bare metal, 77,077,797 requests/24 h) matched.
22. **Using trackers as a generic rendezvous service** (random infohashes with no real torrent) is what Trystero does openly, and the ftorrent operator's GitHub user (zootella) is credited in Trystero's 0.25.3 changelog for the default entry (so at least that operator welcomes it); I found no operator text that explicitly forbids or permits it (openwebtorrent: "free for anyone to use").
23. **`ws://` and non-443 ports** fail on https pages (mixed content) and on many corporate/mobile networks (the latter unverified).
24. **Not tested:** real browsers, long-run stability, per-IP rate limits, heavy load. Everything about phones is inferred.

---

## Open questions

1. How do iOS Safari (incl. Lockdown Mode), Android Chrome, Samsung Internet and Brave behave for tracker sockets across background/foreground and screen lock? Are there per-tab caps on `RTCPeerConnection`s that 15-20 offers per cycle would hit?
2. Does Oracle reclaim a lightly-loaded A1 that hosts only a small tracker, and does a PAYG upgrade or a cron busy-loop prevent it?
3. Can a Durable-Object tracker be built within the Free plan, and is the documented 20:1 WS billing what is actually enforced on Free? (One unverified forum report says otherwise.)
4. What is `tracker.openwebtorrent.com` really running and who operates it today (its site was last modified 2023-07-06), and does Cloudflare apply WAF/rate rules to it? Why does it drop `scrape`?
5. Why is `tracker.novage.com.ua` absent from ngosang's bot-maintained list although it works? Does the bot's WS probe require a path such as `/announce`?
6. Will aquatic get a new tagged release (its master carries unreleased ws changes since 2024-04) or will wt-tracker-rust displace it?
7. How long will the current four survive? (Evidence of attrition: btorrent.xyz, fastcast.nz, webtorrent.io, sloppyta, manager.v6.navy, ghostchu, ws.peer.ooo, dnlab.net, abiir.top all gone.) Do we want a written agreement or at least a courtesy note to operators before depending on them?
8. Do mobile CGNAT carriers break STUN-only WebRTC for our users, and do we need a free TURN (Cloudflare TURN is claimed by Trystero's README to have a 1,000 GB/month free tier - unverified)?
9. Is it better to run chain gossip over torrent wires (BEP-10) or in a separate tracker/Nostr room? Needs a prototype; trackers support either.
10. Real-world per-IP connection limits and abuse thresholds of the public trackers (I only opened <= 15 sockets per tracker).

---

## Sources read

Pages marked **[S]** were returned through the fetch tool's summarising model and not re-read raw; load-bearing numbers from them are flagged medium confidence. Everything else was read raw (curl) on 2026-10-14/15. Search-result pages were used only for discovery.

**Tracker implementations and clients**
- https://github.com/webtorrent/bittorrent-tracker - raw `package.json`, `README.md`, `CHANGELOG.md`, `server.js`, `client.js`, `bin/cmd.js`, `lib/common.js`, `lib/server/{parse-websocket,swarm}.js`, `lib/client/{websocket-tracker,tracker}.js` (master); GitHub API repo/commits/releases; issues #164, #199, #288, #310, #354, #525 (+comments); https://registry.npmjs.org/bittorrent-tracker
- https://github.com/webtorrent/webtorrent - raw `package.json` (3.0.21), `index.js`, `lib/torrent.js`, `docs/api.md`, `README.md`; https://github.com/webtorrent/webtorrent/issues/957 **[S]**
- https://github.com/webtorrent/create-torrent - raw `index.js`, `README.md`, `package.json` (6.1.3); https://github.com/webtorrent/torrent-discovery `index.js`; https://github.com/ThaUnknown/simple-peer `lite.js`; npm registry for webtorrent, create-torrent, torrent-discovery, parse-torrent, magnet-uri, @thaunknown/simple-peer
- https://github.com/greatest-ape/aquatic - raw `crates/ws/README.md`, `crates/ws/src/config.rs`, `crates/ws_protocol/src/incoming/announce.rs`, `crates/ws/src/workers/swarm/storage.rs`, `CHANGELOG.md`; GitHub API repo/commits/tags
- https://github.com/Novage/wt-tracker - raw `README.md`, `package.json`, `sample/config.json`, `src/{fast-tracker,uws-tracker,tracker}.ts`; https://github.com/Novage/wt-tracker-rust - raw `README.md`, `docs/install-oracle-ampere-a1.md`; https://github.com/Novage/wt-tracker-rust page **[S]**
- https://github.com/zootella/ftorrent - raw `open/docker/aquatic-ws.toml`, `open/docker/Dockerfile.ws`, `open/breaker/README.md`, `open/gauge/README.md`, `open/gauge/src/gauge.py`; https://docs.ftorrent.com/tracker-load.html and /software-selections.html (raw HTML, key numbers re-checked) and **[S]** summaries
- https://github.com/websockets/ws `doc/ws.md`; https://registry.npmjs.org/ws

**Live tracker pages and stats**
- https://tracker.openwebtorrent.com/stats.json ; https://openwebtorrent.com/ ; https://webtorrent.dev/ (embedded Prometheus series) ; https://tracker.novage.com.ua/ and /stats.json ; https://open.ftorrent.com/page.json ; https://btorrent.xyz/
- https://cloudflare-dns.com/dns-query and https://dns.google/resolve (DoH JSON) ; Team Cymru ASN DNS ; `openssl s_client` on tracker hosts

**Lists and defaults**
- https://github.com/ngosang/trackerslist (raw `trackers_all_ws.txt`, `blacklist.txt`, `README.md`, commit API) ; https://github.com/XIU2/TrackersListCollection `all.txt`, https://github.com/DeSireFire/animeTrackerList `AT_all.txt`, https://cf.trackerslist.com/all.txt (discovery of extra wss names)
- https://github.com/dmotz/trystero - raw `README.md`, `CHANGELOG.md`, `packages/{torrent,nostr,mqtt,core,ws-relay}/src/*`; https://registry.npmjs.org/trystero ; commits page **[S]**
- https://cdn.jsdelivr.net/npm/p2p-media-loader-core@4.0.0/README.md and `lib/types.d.ts` ; https://registry.npmjs.org/p2p-media-loader-core

**Hosting and infrastructure docs**
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (raw text confirmed)
- https://developers.cloudflare.com/durable-objects/platform/pricing/ **[S]**, /platform/limits/ **[S]**, /best-practices/websockets/ **[S]** ; https://developers.cloudflare.com/workers/platform/limits/ **[S]** ; https://developers.cloudflare.com/network/websockets/ **[S]**
- https://docs.fly.io/about/pricing **[S]** ; https://render.com/docs/free **[S]** ; https://docs.cloud.google.com/free/docs/free-cloud-features **[S]**
- https://nginx.org/en/docs/http/websocket.html **[S]** (verbatim quotes returned) ; https://caddyserver.com/docs/caddyfile/directives/reverse_proxy **[S]**
- Cloudflare-Workers tracker candidates (search hits + one page): https://github.com/manalejandro/cf-feditorrent **[S]**, https://github.com/yanshiqwq/cf-http-tracker , https://github.com/99percentpeople/weblink-ws-worker , https://community.cloudflare.com/t/durable-objects-free-quota-block-below-100k-after-websocket-20-1-adjustment/967650

**Alternatives and browsers**
- https://test.mosquitto.org/ **[S]** ; https://www.emqx.com/en/mqtt/public-mqtt5-broker **[S]** ; https://www.hivemq.com/mqtt/public-mqtt-broker/ (raw) ; https://peerjs.com/ **[S]**, https://0.peerjs.com/ , https://registry.npmjs.org/peer
- https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/websockets.json and `rtcpeerconnection.json`
- Mobile background-socket anecdotes (search hits, not read in full): https://github.com/trpc/trpc/issues/4078 , https://developer.apple.com/forums/thread/716118 , https://github.com/JollyGrin/unbrewed-p2p/pull/865 , https://github.com/MongooseMoo/react-client/pull/159
- Trystero default-list third-party notes (search hits only): https://github.com/juliangt/gritos/issues/51 , https://github.com/juliangt/formulita/issues/8

**My probes (2026-10-14 23:48Z - 2026-10-15 00:40Z):** `docs/research/labs/02-wss-trackers-probes/{wsprobe,relaytest,offercap,idle_test,nostrprobe,mqttprobe}.py`.
