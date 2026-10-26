# 12 - Signaling libraries and wire-extension messaging (Trystero, P2PT, bugout, simple-peer, libp2p, Hyperswarm)

- **Topic:** Trystero 0.26.0, P2PT, bugout, simple-peer / @thaunknown/simple-peer, the WebTorrent wire-extension API and its throttle / head-of-line behaviour, Nostr and MQTT as signaling fallbacks, Hyperswarm in browsers, js-libp2p in browsers, and the "rendezvous torrent" trick for the ledger gossip.
- **Research date:** 2026-10-17 (work ran roughly 20:40Z to 22:00Z, i.e. 16:40 to 18:00 local ET). Sources are 2024-2026 unless flagged **[old]**.
- **Tool note (read this):** the WebSearch budget of the session ran out (200 calls shared by all agents) before I could use it, so **no search-engine result is used anywhere**. Every claim comes from a direct read of a primary source (raw GitHub files, GitHub pages, the npm registry, NIP texts), a live probe, or a lab run. Where a search would have been the only way to learn something, it is listed under "Open questions".
- **Confidence scale:** high = read in primary source and/or reproduced in the lab or live; medium = one good source or consistent inference; low = anecdote, vendor claim or my own estimate. Anything not verified is marked **unverified**.
- **`[DESIGN-CRITICAL]`** marks findings that would change the architecture or a compatibility promise if wrong.
- **Reproducible evidence (nothing is vendored):** `docs/research/labs/12-signaling-lab/` holds `lab.mjs` + `page-lib.js` (Playwright 1.64.1 + Chromium 156.0.8078.4, a local `bittorrent-tracker` 11.2.3, two to five pages on 127.0.0.1) and `seedertest.py` (stdlib-only live tracker probe, same method as `02-wss-trackers-probes`). Result files are in `labs/12-signaling-lab/results/*.json`. Run: `PATH=$HOME/.local/share/node/current/bin:$PATH node lab.mjs e1 e1x:rv:sim:15 e3:off e3:off:r16 e4 e5 e7 e8 e10 e11` (e6 needs `TRYSTERO_BUNDLE=<iife bundle>`, e9 needs `E9_URLS=wss://...`). On this Mac use `/usr/bin/python3` for the probes (the Homebrew python3 appears to be blocked by the application firewall: every connect timed out, while the system python connected at once).
- **Source IDs** such as [T3] or [W2] are defined at the end of the file; the JSON summary carries full URLs.

---

## Summary

1. **Verdict.** Keep the ledger gossip as a BEP-10 extension (`mw_chain1`) on WebTorrent wires, exactly as the architecture says, and heal the "ledger splits across site versions" problem (DESIGN-REVIEW S1) with a **bare-infohash rendezvous swarm** `sha1("mw-ledger/1/" + ledgerId)` joined in the same WebTorrent client. Do **not** put Trystero, P2PT, bugout, upstream simple-peer, js-libp2p or Hyperswarm into v1. A Nostr-backed second discovery plane is a reasonable P2 add-on (lazy-loaded, pinned), not a dependency of the happy path.
2. **The open question in DESIGN-REVIEW section 6 ("does WebTorrent keep metadata-less wires open?") is answered: yes.** webtorrent 3.0.21 + Chromium 156: two pages that `client.add()` a bare 40-hex infohash get a `webrtc` wire in 151 ms on a local tracker (15/15 trials, p50 160 ms), the extended handshake lands 1 ms later, 60/60 extension round trips (p50 0.7 ms, p99 1.2 ms), and the wire is still open and answering after 140 s idle. On the four live public trackers the same trick connected in 18 of 20 trials (0.46 to 1.26 s); both misses were one transient outage of `tracker.novage.com.ua` in the first run (it connected 2/2 on the rerun and 2/2 in the full second run). [E1][E9]
3. **The "one-piece anchor torrent" fallback in S1 is the worse design `[DESIGN-CRITICAL]`.** A complete torrent announces `completed` (no offers) and then `started` with `left=0`. Two peers starting together **never connect (0 of 15 locally; 0 of 10 on live trackers)** because their offers cross and WebTorrent drops both as "duplicate" peers; started 0.3 to 0.6 s apart it works locally (15/15) and on three of the four live trackers, but **`tracker.openwebtorrent.com` (the biggest, 287k open sockets today) does not forward offers between two seeders at all** (4 of 4 raw probes, 2 of 2 end-to-end trials). The bare infohash announces `left=null` in a single atomic `started` announce, which all four trackers treat as a leecher and which cannot glare. [E1x][E2][E9][SEED][TR3]
4. **Head-of-line blocking on the shared wire is real and large `[DESIGN-CRITICAL]`.** An extension frame sent on the *same* wire that is uploading pieces waits behind the leecher's request pipeline, which WebTorrent sizes in **time** (0.5 to 1 s of current speed), not bytes: unthrottled loopback, p50 **529 to 657 ms**, p90 2.5 to 3.2 s, p99 3.4 to 4.3 s (idle: 0.7 ms). The same frames on a **separate rendezvous wire to the same peer** see 0.6 to 17 ms even during the transfer. Advertising `reqq` (a standard BEP-10 handshake field that WebTorrent honours) from the uploader cut the shared-wire median to 3.2 to 14 ms for `reqq` 8 to 32 and to a deterministic `reqq x 16 KiB / uplink` when the uplink is the bottleneck (241 ms at 1 MiB/s with `reqq` 16). [E3]
5. **Throttle semantics (source + lab).** The upload throttle sits in every wire's pipeline (`wire -> throttle -> conn`) and is **client-global**: `throttleUpload(0)` froze handshake, requests and extension frames on a rendezvous wire of the same client (0 of 30 delivered) while a wire of a **second client in the same page** was untouched (30/30, p50 0.8 ms); on `throttleUpload(-1)` the backlog was delivered in order, no loss, first frame after 623 ms (the limiter polls a zero rate once per second). Finite rates (1 MiB/s, 256 KiB/s) did **not** delay small frames on other wires (p50 0.6 ms). [E4][W1][W3]
6. **Three loader-side hazards the spec omits or gets wrong.** (a) `maxConns` is **not enforced for WebRTC peers**: 5 pages with `maxConns: 2` each held 4 wires (source: the cap only gates the TCP/uTP `_drain` queue). (b) `bittorrent-protocol@5.0.9` has **no inbound message-length cap**: a peer that announces a 2 GiB-1 message and streams 16 MiB makes the wire buffer all 16 MiB with no disconnect. (c) On a metadata-less swarm every wire runs `ut_metadata.fetch()`, so a peer that advertises `metadata_size = 10,000,000` made the honest side allocate 10 MB and send 1,833 requests; `wire.ut_metadata.cancel()` in the `wire` listener reduced that to 0. The loader must enforce caps and add a buffer watchdog itself. [E5][E7][E12][W1][W2]
7. **Trystero 0.26.0 (2026-10-04)** is alive (2.8k stars, 21k npm downloads/week, 6 releases in 4.5 months) but is a poor *dependency for a compatibility promise*: 0.23, 0.24, 0.25 and 0.26 each carried breaking changes (0.26.0 **changed the action wire format: "upgrade all peers"**), it disconnects peers on a protocol-version mismatch, it has **no room-size cap** (every peer connects to every peer; issue #141), and its issue tracker acknowledges partial meshes (#161, #151) and a page-global relay-config bug (#207) as open problems. It adds 65 KB min / 23 KB gzip (torrent strategy) or 75 KB / 27 KB (default Nostr strategy) and one extra `RTCPeerConnection` per peer. It works against our local tracker (153 ms to first peer) and suffers the same HOL (p50 1.5 and 3.0 s in two runs for a small action behind a 128 MiB transfer). [T1][T2][T9][E6]
8. **P2PT, bugout, upstream simple-peer are effectively dead ends for us.** P2PT 1.6.2 (2025-09-08; 72 downloads/week) is ~380 lines over `WebSocketTracker`, with **no STUN by default** and no peer authentication (open issue since 2020). bugout 0.0.13 (2022-06-21; 23 downloads/week) pins webtorrent ^1.0.2, its default trackers are dead (`hub.bugout.link` has no DNS record, `tracker.btorrent.xyz` resolves to 127.0.0.1) or filter seeders (`openwebtorrent`), and it re-broadcasts unvalidated packets. Upstream `simple-peer` 9.11.1 is from 2022-02; WebTorrent 3.0.21 and bittorrent-tracker 11.2.3 already depend on the maintained fork `@thaunknown/simple-peer` 10.1.2 (2026-07-25). [P1][B1][SP2]
9. **Nostr and MQTT remain the best tracker-less fallbacks.** Today (2026-10-17) 13 of 13 sampled Trystero default Nostr relays accepted an ephemeral kind 20000-29999 event and echoed it (16 to 4,010 ms; one issued a NIP-42 `AUTH` challenge but accepted); NIP-01 defines these kinds as "not expected to be stored". MQTT results are in 02 (4/4 brokers). [N1][N4]
10. **Hyperswarm and js-libp2p are not browser-only stacks.** `@hyperswarm/dht-relay` (the only browser route; README: "experimental. Do not use it in production") was **archived by its owner on 2026-10-15**; `hyperswarm-web` is from 2022 and is configured with lists of your own HyperswarmServer proxy and signal URLs. js-libp2p 3.4.0 / `@libp2p/webrtc` 7.0.0 (both released today) do browser-to-browser WebRTC only through a **circuit-relay-v2 server that cannot run in a browser**, with a minimal browser node of 457 KB min / 133 KB gzip (2x webtorrent). Both contradict goal G7 (no backend of ours). [H1][H2][LP1][LP2][LP3]
11. **Tracker load is controllable.** A default WebTorrent announce carries up to 5 offers and costs up to about 17 tracker messages per 120 s per visitor per torrent per tracker; per-torrent `getAnnounceOpts` (`numwant`, `left`) works in 3.0.21 (verified: `numwant: 2` gave 2 offers, `numwant: 0` gave none). With `numwant` driven to 0 once the target degree is reached, the rendezvous swarm costs about 2 messages per 120 s per visitor per tracker. [W4][E8]
12. **What is not verified:** real WAN / mobile behaviour of any number above (all lab numbers are loopback, one Chromium build), Safari and Firefox data-channel limits, why `reqq` 64 showed a multi-second tail in one run, the software version behind `tracker.openwebtorrent.com`, and whether any public libp2p relay would serve third-party browser apps.

---

## Method and evidence log

What I ran, so a reviewer can tell evidence from inference:

- **Source reading (installed from the npm registry into this repo's `node_modules`, versions in `package.json`):** `webtorrent` 3.0.21 (`index.js`, `lib/torrent.js`, `lib/peer.js`, `lib/webconn.js`), `bittorrent-protocol` 5.0.9, `speed-limiter` 1.0.2, `ut_metadata` 5.0.1, `bittorrent-tracker` 11.2.3 (client `websocket-tracker.js`; server `server.js`, `lib/server/swarm.js`, `parse-websocket.js`), `@thaunknown/simple-peer` 10.1.2 `lite.js`. Trystero 0.26.0 `packages/*/src` (all files downloaded; torrent, nostr, mqtt, ipfs and core `strategy`, `topic-strategy`, `peer`, `crypto`, `data-limits`, `utils` read in full, `action-wire`, `handshake`, `shared-peer` in part), P2PT `src/p2pt.js`, bugout `index.js`, Novage `wt-tracker` `fast-tracker.ts`, aquatic `crates/ws/.../storage.rs` were fetched raw from GitHub `main` / `master` on 2026-10-17.
- **Lab (loopback, Chromium 156.0.8078.4 headless, 2 pages unless noted, STUN disabled, `--disable-features=WebRtcHideLocalIpsWithMdns`):** e1 metadata-less rendezvous + 140 s soak, e1x glare matrix (4 x 15 trials), e2 bugout-style seeded identifier, e3 head-of-line matrix (uplink: unlimited, 8 MiB/s, 1 MiB/s, 256 KiB/s x `reqq` none/8/16/32/64; 64 to 128 MiB content; a ping every ~30 ms per path, about 215 to 560 pings per path per run), e4 throttle, e5 `maxConns`, e6 Trystero 0.26.0 torrent strategy, e7 inbound length, e8 `getAnnounceOpts`, e9 live trackers, e10 `peerId` across torrents, e11 version split. Known lab artefact: Chromium occasionally stalls a page main thread for about 1 s (seen once as a single 1,005 ms outlier on both paths in an idle test); I did not filter it out.
- **Live probes (own scripts, private random swarms, closed immediately):** `seedertest.py` against the four live trackers (5 scenarios x 4), 3 extra repeats on `tracker.openwebtorrent.com`, e9 (2 full runs + 2 partial reruns; each trial = two local pages, one announce each with up to 5 real WebRTC offers, on a random infohash), `nostrprobe.py` from topic 02 on 13 relays, DNS / WS checks of bugout's default hosts, `tracker.openwebtorrent.com/stats.json`.
- **Not run:** anything on a real phone, any real WAN path (all RTTs are loopback), Safari or Firefox, any TURN scenario, any test of Trystero's Nostr / MQTT strategies (only its torrent strategy, against a local tracker).
- **Load placed on third parties:** at most about 70 short announces on random infohashes per tracker over the whole session, 13 single-event Nostr probes, plus the page loads of GitHub / npm. Nothing was published to a real swarm or site.

---

## Findings

### F0. Status board (all rows read on 2026-10-17)

| Library | npm latest | Published | Repo activity | npm downloads / week (2026-10-06..12) | Reading |
|---|---|---|---|---|---|
| `trystero` (+ `@trystero-p2p/*`) | 0.26.0 | 2026-10-04 | pushed 2026-10-05; 2,794 stars, 161 forks, 7 open issues | 21,449 (`trystero`), 17,084 (`nostr`), 1,609 (`torrent`) | active, high API churn |
| `p2pt` | 1.6.2 | 2025-09-08 | last commit 2025-09-08 (after a gap from 2024-02); 651 stars; 6 open issues | 72 | low-maintenance |
| `bugout` | 0.0.13 | 2022-06-21 **[old]** | last commit 2024-05-08 (CI only); 638 stars; 11 open issues | 23 | abandoned |
| `simple-peer` (feross) | 9.11.1 | 2022-02-17 **[old]** | not archived; 97 open issues, 31 open PRs | 336,668 | stale, still huge install base |
| `@thaunknown/simple-peer` | 10.1.2 | 2026-07-25 | commits 2026-07-25, 2026-05-21, 2026-01-15, 2025-08-14 | 21,089 | maintained fork; what WebTorrent uses |
| `webtorrent` | 3.0.21 | 2026-07-27 | (topic 01) | 25,620 | |
| `bittorrent-protocol` | 5.0.9 | 2026-07-27 | | | |
| `libp2p` / `@libp2p/webrtc` | 3.4.0 / 7.0.0 | both 2026-10-17 | monorepo, daily releases | 125,437 / 21,533 | very active |
| `hyperswarm` | 4.17.2 | 2026-09-22 | active (Holepunch) | 25,941 | not a browser stack |
| `@hyperswarm/dht-relay` | 0.4.3 | 2023-10-30 | last commit 2025-11-01; **archived 2026-10-15** | 2,956 | dead end for browsers |
| `hyperswarm-web` | 2.2.0 | 2022-02-15 **[old]** | no archive banner; 10 open issues | 200 | dead |

Sources: [T8][T10][T11][P2][B2][SP1][SP2][H3][LP5]. Downloads are popularity hints only (CI and mirror installs inflate them). Confidence: high.

### A. Trystero

#### F1. Trystero is alive, MIT, split into scoped packages; the default import is Nostr, not torrent

- npm `trystero` 0.26.0 (2026-10-04; 80 versions; created 2020-10-26) depends only on `@trystero-p2p/nostr` 0.26.0. Scoped packages `@trystero-p2p/{core,nostr,torrent,mqtt,supabase,firebase,ipfs,ws-relay}` are all 0.26.0. The split happened in 0.23.0 (2026-03-23, "biggest update since initial release", internals rewritten); `trystero/<strategy>` imports are deprecated compatibility entry points; `ws-relay` arrived in 0.24.0 (2026-04-27).
- Release train: 0.25.0 (05-25), 0.25.1 (05-26), 0.25.2 (06-11), 0.25.3 (07-13), 0.25.4 (08-30), 0.26.0 (10-04). Commit 2026-10-05 "added changelog".
- Since 0.21.0-beta.1 (2025-02-23) it no longer uses simple-peer ("mostly unmaintained and showing its age"); it has its own `RTCPeerConnection` layer (`packages/core/src/peer.ts`).

**Confidence:** high. **Sources:** [T2][T7][T8][T10]. **Source date:** 2026-10-17 (read live).

#### F2. Strategies, default relay lists and how many are used `[DESIGN-CRITICAL for anyone copying the lists]`

| Strategy (package) | Signaling medium | Default list in 0.26.0 | Used per app | Notes |
|---|---|---|---|---|
| torrent (`@trystero-p2p/torrent`) | WebTorrent WS trackers | `open.ftorrent.com`, `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.btorrent.xyz`, `tracker.files.fm:7073/announce` | **first 3** (`defaultRedundancy = 3`, no shuffle) | 4th is dead (A record 127.0.0.1) and 5th is Origin-locked (403), per topic 02; the 3 used are the live ones. Trickle ICE off. |
| nostr (`@trystero-p2p/nostr`, default of `trystero`) | Nostr relays, ephemeral events | 29 relays | **5**, order shuffled deterministically by `appId` | event kind = 20000 + (sum of the topic's char codes mod 10,000), tag `["x", topic]`, filter `{kinds, since: now, "#x": [topic]}`, up to 250 topics per REQ; throw-away BIP-340 key (`@noble/secp256k1`) |
| mqtt (`@trystero-p2p/mqtt`) | MQTT 3.1.1/5 over wss | `broker.emqx.io:8084`, `public.cloud.shiftr.io`, `broker.hivemq.com:8884`, `test.mosquitto.org:8081` | all 4 | pulls the `mqtt` package: 404 KB min / 126 KB gzip bundle |
| supabase / firebase | your own BaaS project | none | n/a | `appId` is your project URL / `databaseURL` |
| "ipfs" (`@trystero-p2p/ipfs`) | **Waku** light node (lightPush + filter, ephemeral content topics `/trystero-<topic>/0/msg/json`) | Waku default bootstrap | n/a | the name is historical: the 0.26.0 source imports `@waku/sdk ^0.0.36`, no IPFS code; liveness of the Waku network **unverified** |
| ws-relay (`@trystero-p2p/ws-relay`) | your own tiny pub/sub WS relay (`createWsRelayServer`) | none | n/a | defaults from topic 02: maxPayload 1 MiB, 128 subscriptions per socket |

README ranking of robustness: Nostr, then MQTT, BitTorrent, IPFS. **Confidence:** high (source). **Sources:** [T3][T4][T5][T6][T1]; liveness facts from topic 02 (`02-wss-trackers.md` F1, F3, F18, F19). **Source date:** 2026-10-17.

#### F3. How the "serverless" signaling works, what a relay sees, and what is (not) encrypted

- Topics: `rootTopic = sha1("Trystero@" + appId + "@" + roomId)`, `selfTopic = sha1("Trystero@" + appId + "@" + roomId + "@" + selfId)`. Here `sha1()` is **not** a 20-byte digest: it is `bytes.map(b => b.toString(36)).join('')`; the torrent strategy slices it to 20 characters and sends that 20-character `[0-9a-z]` string as the tracker `info_hash` (so a Trystero room cannot collide with a real torrent infohash except by chance). Example captured in the lab: `34633674366d363436723365346736613431316c` = ASCII `4c6t6m646r3e4g6a411l`.
- A joining peer announces on the root topic (torrent: one announce with 1 offer, `numwant: 3`, no `event`, no `left`; Nostr/MQTT: a presence message carrying `peerId`); offers and answers are then exchanged on each peer's **self topic** (Nostr/MQTT) or via the tracker's `to_peer_id` routing (torrent). Cadence: three warm-up re-announces after 233, 533 and 1,333 ms, one recovery pulse 5.3 s later, then every 60 s for the topic strategies (Nostr / MQTT / Waku); the torrent strategy follows the tracker's `interval` clamped to 10 to 120 s (10 s until the first response); dormant `passive` rooms announce as seeders (`left: 0`, no offers) every 120 s.
- **Signaling encryption:** offers and answers are AES-GCM encrypted with a key = SHA-256(`password:appId:roomId`) (`password` defaults to the empty string), 16 random IV bytes. Without a `password` any relay operator who knows `appId` and `roomId` can decrypt (the README says so); with a `password` the key is only a single SHA-256, so a low-entropy password is brute-forceable offline from captured signaling. Inside SDP are the peers' IPs (topic 02, gotcha 17).
- **Authentication:** none by default. `selfId` is 20 characters from `Math.random()` (not a CSPRNG) and is a plain claim; the optional `onPeerHandshake(peerId, send, receive, isInitiator)` hook (since 0.23.0) lets an app run its own challenge before a peer becomes visible (timeout `handshakeTimeoutMs`, default 10 s). Data in flight is protected only by WebRTC's DTLS.
- ICE: defaults `stun:stun.l.google.com:19302`, `stun1.`, `stun2.` and `stun:stun.cloudflare.com:3478`; **no TURN by default** (`turnConfig` adds one; the README names Cloudflare's 1,000 GB/month free TURN tier, **unverified** here); ICE gathering timeout 15 s; reconnect backoff for relay sockets 3.3 s doubling to 60 s with jitter, paused while `navigator.onLine` is false.

**Confidence:** high (source). **Sources:** [T1][T3][T4][T7]. **Source date:** 2026-10-17.

#### F4. Data plane: one ordered channel, 16 KiB frames, hard limits, and a wire-format version that disconnects mismatched peers `[DESIGN-CRITICAL]`

- One data channel per `RTCPeerConnection`, label `data`, default (ordered, reliable) options; `bufferedAmountLowThreshold = 0xffff`; sends wait for `bufferedamountlow` (10 s timeout, then the peer is failed).
- Limits in `data-limits.ts` / `action-wire.ts`: action frame 16 KiB, room envelope + 3 + up to 128 B token, chunk payload 16,370 B, action id 1 to 32 UTF-8 bytes, 64 queued frames before handlers exist, 10 s pending-data timeout, 120 s transfer timeout, 1 MiB control backlog, `maxReceiveBytes` default 256 MiB per room (new in 0.26.0, listed as breaking).
- Framing versions: action frames `version = 2`, room envelope 1, presence frame 2. A frame with the wrong version triggers `failPeer("incompatible action protocol version")` and a disconnect. 0.26.0's changelog: "The action wire format has changed internally. Upgrade all peers communicating with each other to the latest package version." Our loader is a long-lived static asset that browsers and service workers cache, so **two loader generations built on different Trystero minors would not talk to each other**.

**Confidence:** high. **Sources:** [T2][T7]. **Source date:** 2026-10-17.

#### F5. Full mesh, no room cap, and open topology bugs

- No peer cap exists in core (no `maxPeers`/limit option; searched all of `packages/core/src`). Issue #141 "Room Size Limit" (opened 2025-09-10): "every peer connects to each other"; maintainer reply 2026-10-04: "This isn't straightforward because there's no central server keeping track of an official count of room members"; suggested workaround: count `onPeerJoin`/`onPeerLeave` and throw in `onPeerHandshake` (example limit 5).
- #161 "Peer Assisted Signalling" (2026-04-03): the author is "running into situations where rooms with 3+ members form partial meshes" (Alice and Bob each reach Charlie, never each other); a prototype of peers bridging SDP for each other is announced, no design given, no maintainer reply. #151 (2026-02-10): "some connections fail to establish for some peers" on shared networks; maintainer (2026-03-23): configure TURN; mesh routing "no concrete plans yet". #100 (2025-01-21): using several strategies at once is not supported, no maintainer reply. #207 (2026-10-07): a room joined while another is open **ignores its own `relayConfig`** (source: `strategy.ts` runs `init(config)` once, guarded by a module-level `didInit`).
- Connection sharing: since 0.23.0 one `RTCPeerConnection` is reused when the same remote peer appears in several rooms (of the same Trystero strategy instance).

**Confidence:** high. **Sources:** [T9][T7]. **Source date:** 2026-10-17.

#### F6. Cost of adding Trystero, measured

| Bundle (esbuild 0.28.2, ESM, minified, browser, tree-shaken, no splitting) | min | gzip -9 |
|---|---|---|
| `@trystero-p2p/torrent` | 64,927 B | 23,006 B |
| `@trystero-p2p/nostr` (= `trystero` default) | 75,112 B | 27,425 B |
| `@trystero-p2p/ws-relay` | 63,430 B | 22,349 B |
| `@trystero-p2p/mqtt` | 403,634 B | 126,458 B |
| for scale: `webtorrent.min.js` 3.0.21 | about 223,000 B | (topic 01) |

Each remote peer costs one more `RTCPeerConnection` (Chromium allows 500 per renderer, WebKit closes the oldest RTC socket beyond 256 per web process; topic 03 F-31 and F-32), and the torrent strategy opens its **own** WebSocket to each tracker (it does not use `bittorrent-tracker`'s socket pool) and announces a second infohash with `numwant: 3`, 1 offer. **Confidence:** high (measured / source). **Sources:** [T3][T7][M1]. **Source date:** 2026-10-17.

#### F7. Measured behaviour against our local tracker (e6, loopback, Chromium 156)

- Time to first `onPeerJoin`: **151 ms and 153 ms** (two runs; WebTorrent bare infohash: 151 ms). Idle round trip of a small action: p50 0.4 to 0.7 ms, p99 0.6 to 2.2 ms (150 samples).
- While one peer sent a **128 MiB binary action**, a small action sent every 10 ms had p50 **1.5 s and 3.0 s** (two runs), p99 3.5 and 5.0 s (400 samples): the same single-channel HOL as WebTorrent (F16), here mostly receiver-side backlog. The receiver got all 134,217,728 bytes.
- Announce shape observed on the tracker: `numwant 3`, one offer, no `event`, no `left` (the reference tracker records such a peer as a leecher: `Number(undefined)` is NaN, mapped to Infinity).

**Confidence:** high for the numbers, low for generalising them (loopback). **Sources:** lab `results/e6.json`, [T3]. **Source date:** 2026-10-17.

#### F8. Mobile and hostile-NAT behaviour: no claims anywhere; treat as equal to WebTorrent's WebRTC limits

README, CHANGELOG, the 7 open issues and the project site https://trystero.dev make no mobile or Safari statement, state no peers-per-room limit and make no production-readiness claim. Trystero depends on persistent WebSockets plus `RTCPeerConnection`, so the iOS / Android background-suspension and carrier-NAT findings of topic 03 apply unchanged. The README's remedy for "some ISP pairs cannot connect" is a TURN server. **Confidence:** medium (absence of evidence plus architecture). **Unverified:** behaviour on real phones. **Sources:** [T1][T2][T9][T12]. **Source date:** 2026-10-17.

### B. P2PT

#### F9. P2PT is a ~380-line wrapper that uses the tracker as a signaling bus; it has two traps

- 1.6.2 (2025-09-08), 14 versions since 2020-04-27 (1.5.1 on 2021-12-24, then 1.6.0 to 1.6.2 on 2025-09-05 to 09-08 after a modernisation: vite, `WebSocketTracker` used directly, handler for `@thaunknown/simple-peer`'s `disconnect` event). Dependencies: `bittorrent-tracker ^11.2.2`, `uint8-util`. 651 stars, 72 downloads/week.
- **Rendezvous = SHA-1 of the identifier string used as a real 20-byte infohash** (`hash(identifierString, 'hex')`, `uint8-util` default algorithm `sha-1`) - the same trick this project needs, in use since 2020. It announces with `numwant 50`.
- **Chunking:** messages are JSON-stringified and split into **16,000-character** pieces, each wrapped as `"^" + JSON.stringify({id, msg, c, last, o})`; reassembly keys on a random message id in an unbounded `msgChunks` map (a peer that never sends `last` grows it forever); strings only, no binary.
- **Trap 1:** `this._rtcConfig = { iceServers: [] }` in the constructor and that config is what `WebSocketTracker` hands to simple-peer, so by default **there is no STUN** and only same-LAN or public-IP peers can connect (per source; not exercised here).
- **Trap 2:** no peer authentication; open issue #9 "Man in the middle attack warnings" (2020, 10 comments) - maintainer: "MITM is a sure possibility with public WebTorrent trackers like with WebRTC signalling servers"; no fix. Open #34: public trackers are low quality.

**Confidence:** high (source). **Sources:** [P1][P2][P3]. **Source date:** 2026-10-17; library design from 2020 **[old]**.

### C. bugout

#### F10. bugout's design: signed, optionally encrypted RPC flooded over a WebTorrent extension, with the swarm formed by a tiny deterministic torrent

- Rendezvous: `wt.seed(File([identifier], identifier), { name: identifier, announce })` - every node **seeds** the identical one-file torrent named and filled with the identifier (`identifier` = a shared string, or the server's address = `bs58check(0x55 || ripemd160(sha512(pubkey)))`). Same idea as S1's anchor torrent.
- Transport: `wire.use()` an extension named `bo_channel`; `wire.extendedHandshake` carries `id`, `pk`, `ek`; `wire.extended("bo_channel", packet)` is sent only to wires whose `peerExtendedHandshake.m.bo_channel` is set (the right gate). Packets are `bencode({ s: ed25519 detached signature, p: bencode({ t: ms timestamp, i: identifier, pk, ek, n: 8 random bytes, y: type, ... }) })`; types: `m` message (signed, plaintext), `r` RPC call, `rr` RPC response (both `nacl.box`-sealed to the peer's session key `ek`), `p` ping, `x` leave.
- Controls: identifier must match, signature must verify, `t + 5 min > now` (replay window, `PEERTIMEOUT`), dedupe by `sha512` hash in a `seen` map. RPC callbacks live in a `callbacks` map keyed by an 8-byte nonce and are never expired (open issue #4).

**Confidence:** high (source). **Sources:** [B1]. **Source date:** read 2026-10-17; code from 2018-2022 **[old]**.

#### F11. bugout is unmaintained, its defaults are dead or hostile, and three of its choices are anti-patterns for us `[DESIGN-CRITICAL as evidence against the "complete anchor torrent"]`

- 0.0.13 (2022-06-21, 13 releases), last repo commit 2024-05-08 (a CI workflow), 23 downloads/week, 11 open issues, depends on `webtorrent ^1.0.2` (2019-era API), README: "pre-alpha quality".
- Default trackers `hub.bugout.link` (**no DNS record** - `gaierror`/NXDOMAIN on 2026-10-17), `tracker.openwebtorrent.com` (alive, but see F25: it does not pair two seeders), `tracker.btorrent.xyz` (A record 127.0.0.1, topic 02). Issue #43 (opened 2021-03-09) already shows it: a user wrote on 2021-03-25 that using `wss://tracker.openwebtorrent.com` "doesn't create a complete connection, but doesn't give any errors. But if I use on wss://hub.bugout.link, it'll create a connection between users ... Otherwise, it'll never complete the connection and no other users will enter the room", and the maintainer had answered "it appears the bugout webtorrent tracker server is overloaded. This is a problem with centralized tracker servers." (Verbatim from the issue page HTML.)
- Anti-patterns visible in `onMessage`: (1) **every first-seen raw packet is re-broadcast to all wires even if validation failed** ("TODO: block flooders"), an amplification primitive; (2) the extended handshake carries `pk`/`ek` **unsigned** ("TODO: sign handshake to prove key custody"); (3) `seen` is never pruned. Issue #10 (2019) asked for a shared-secret option; still open.

**Confidence:** high. **Sources:** [B1][B3][B4], DNS / WS check on 2026-10-17, topic 02 F1. **Source date:** 2026-10-17.

### D. simple-peer

#### F12. Use WebTorrent's bundled `@thaunknown/simple-peer`; never add upstream `simple-peer`

- Upstream `simple-peer` 9.11.1 is from 2022-02-17 (97 open issues, 31 PRs, no archive banner, 336k downloads/week). The fork `@thaunknown/simple-peer` 10.1.2 (2026-07-25) "does away with node:stream and node:buffer in favor of streamx and Uint8Array", ships `lite.js` (no MediaStream code), is "fully backwards compatible" per its README, and has monthly-to-quarterly dependency commits (2026-07-25, 05-21, 01-15, 2025-08-14 "feat: connect and disconnect events"). webtorrent 3.0.21 depends on `^10.1.2`, bittorrent-tracker 11.2.3 on `^10.0.8`.
- Behaviour that matters for the wire layer (read in `lite.js`): data channel created with default options (reliable, ordered; `Peer.channelConfig = {}`); `_write` calls `channel.send` first and only then applies backpressure when `bufferedAmount > 64 KiB` (`MAX_BUFFERED_AMOUNT`), resuming at `bufferedamountlow` with the threshold also 64 KiB; default ICE servers `stun:stun.l.google.com:19302`, `stun:global.stun.twilio.com:3478`, no TURN; `ICECOMPLETE_TIMEOUT` 5 s.

**Confidence:** high. **Sources:** [SP1][SP2][SP3]. **Source date:** 2026-10-17.

### E. The WebTorrent wire-extension channel: API, limits, throttle, head-of-line blocking

#### F13. API contract, ordering and wire enumeration (re-verified from source; matches topic 01 F23)

- `torrent.on('wire', (wire, addr) => wire.use(Ext))`; `Ext` is a class whose **prototype** carries `name` (`use()` throws otherwise); it is constructed as `new Ext(wire)` and also exposed as `wire[name]`. Optional hooks: `onHandshake(infoHashHex, peerIdHex, extensions)` (runs right after the BitTorrent handshake), `onExtendedHandshake(dict)` (only if the peer's `m` map contains our name; strings arrive as `Uint8Array`), `onMessage(Uint8Array)`. There is no `send`: `wire.extended(nameOrId, Uint8Array | bencodable)` (typed arrays go out raw, anything else is bencoded) and it **throws `Unrecognized extension`** unless the peer advertised the name, so gate on `wire.peerExtendedMapping[name]`.
- Ids are assigned by `use()` order per wire. Lab: `ut_metadata = 1`, `lt_donthave = 2`, our extension `= 3` (browser builds exclude `ut_pex`).
- Order of events in `Torrent._onWire`: push to `torrent.wires`, piece-timeout, `setKeepAlive(true)` (a keep-alive every 55 s), `ut_metadata`, `lt_donthave`, then `emit('wire')`; `bittorrent-protocol` sends our extended handshake only after that handler returned and never re-sends it. So `use()` and any custom handshake field (`wire.extendedHandshake.reqq`, a protocol version, ...) must be set **synchronously inside the `wire` listener**, and that listener must be attached synchronously on the `Torrent` returned by `client.add()` (topic 01 F23; ARCHITECTURE section 1).
- Enumeration and detection: `torrent.wires` (includes web-seed wires; `torrent.numPeers === wires.length`), `client.torrents`; `wire.type` is `'webrtc'` or `'webSeed'` (TCP / uTP types exist only in Node). A web-seed wire is a real `Wire` whose remote end is `WebConn`, which advertises only `lt_donthave`, so `peerExtendedMapping.mw_chain1` is `undefined` there (the gate above skips it). `wire.peerId` is the remote **client's** id (`-WW0300-` + 12 random chars, hex-encoded) and is **identical on every torrent of that client** (lab e10: the content wire and the rendezvous wire of the same pair had the same `peerId`), so it is the correct dedupe key across swarms.

**Confidence:** high. **Sources:** [W1][W2], topic 01 F23, lab e1/e10. **Source date:** 2026-10-17.

#### F14. Size limits, and an unbounded inbound length `[DESIGN-CRITICAL for the wire adapter]`

- Outbound: `wire.extended()` pushes the 5-byte message header and then `[extId, payload]` as two stream chunks, each becoming its own `channel.send`. Topic 01 F24 measured the Chromium cap: payload + 1 byte must be at most 262,144; one byte more destroys the connection **silently** (simple-peer `__destroy`). My first e7 attempt (a raw 512 KiB push) killed the wire the same way, an independent confirmation. Safari advertises 256 KiB; Firefox accepts about 1 GiB locally but assumes 64 KiB when the remote omits `a=max-message-size` (topic 03 F-25). The architecture rule (frames at most 15 to 16 KiB) is right.
- Inbound: `bittorrent-protocol@5.0.9` reads a 4-byte length (`_onMessageLength`) and then waits for that many bytes with **no maximum** (`_parse(length, ...)`), appending every chunk to `_buffer` with a `concat` per write. Lab e7: a peer sent the header `0x7fffffff` and then 16 MiB in 64 KiB pushes; the receiver's `wire._bufferSize` reached **16 MiB**, `_parserSize` stayed 2,147,483,647, the wire was **not** destroyed and no event-loop stall above 2 ms was seen. Only `request` messages are bounded (`MAX_BLOCK_LENGTH` 128 KiB). One hostile wire can therefore pin up to about 2 GiB of tab memory, and this is independent of anything in our gossip layer because it happens before `onMessage`.

**Confidence:** high (source + lab). **Sources:** [W2][W1], lab e7, topic 01 F24, topic 03 F-25. **Source date:** 2026-10-17.

#### F15. The upload throttle sits in every wire's pipeline, is client-global, and finite rates do not delay small frames on other wires `[DESIGN-CRITICAL]`

- Source: `Peer.setThrottlePipes()` builds `pipeline(conn, down.throttle(), Transform(download), wire, up.throttle(), Transform(upload), conn)` for every peer; `client.throttleGroups = { down, up }` are client-wide `ThrottleGroup`s from `speed-limiter` 1.0.2 holding **one `TokenBucket(rate, rate, 'second')` shared by all wires of the client**. `Throttle._processChunk` slices each write into `max(floor(rate / 10), 1)`-byte pieces and **while the group is enabled and its rate is 0 it sleeps in a `wait(1000)` loop** (so a freeze is released within up to 1 s); otherwise it takes tokens with `tryRemoveTokens` or waits in `removeTokens`. `throttleUpload(-1)` disables the group, `0` freezes it.
- Therefore `throttleUpload(0)` / `uploadLimit: 0` stops *everything a wire emits*: BitTorrent handshake, extended handshake, `request` / `have` / `bitfield`, keep-alives and extension frames (topic 01 F25 measured 0 of 15 gossip frames delivered, and a downloader with `uploadLimit: 0` never fetched metadata).
- Lab e4 (rendezvous wires, two clients per page): baseline p50 0.8 ms on both; with `throttleUpload(0)` on client `c` the rendezvous wire of `c` delivered **0 of 30** pings, the rendezvous wire of the second client `g` in the same page delivered **30 of 30** (p50 0.8 ms); after `throttleUpload(-1)` the first delayed pong arrived after **623 ms**, all 30 arrived in order with no loss (RTT 1.1 to 4.0 s, i.e. queued time).
- Finite rates do not hurt other wires: with the *content* client throttled to 8 MiB/s, 1 MiB/s and 256 KiB/s, ping RTT on the rendezvous wire of the **same client** stayed p50 0.7 / 0.6 / 0.6 ms (p99 17.2 / 3.4 / 2.4 ms) while the same frames on the bulk wire waited 0.74 to 0.9 s (F16). Small writes get tokens immediately; the bulk wire is the one that waits.
- `torrent.pause()` does not touch uploads or extension traffic (topic 01 F25). The repo already does the right thing (`lockWire`: choke + shadowed `unchoke`); the spec text "pause = pause + throttleUpload(0)" is the remaining fix (DESIGN-REVIEW item 19).

**Confidence:** high. **Sources:** [W1][W3], topic 01 F25, lab e4/e3. **Source date:** 2026-10-17.

#### F16. Extension frames on a wire that is also carrying pieces wait about half a second to a second or more; a separate wire to the same peer does not `[DESIGN-CRITICAL]`

Method: two pages on loopback, page A seeds 64 or 128 MiB, page B downloads it; page A sends a 64-byte ping every ~30 ms on each of three paths (the content wire; a rendezvous wire of the same client; a rendezvous wire of a second client) and B echoes it. 215 to 560 pings per path per run. Idle baseline: p50 0.6 to 0.7 ms on every path. The transfer is JS-bound (12 to 20 MiB/s: piece SHA-1, `MemStore` copies), so these are *queueing* delays inside WebTorrent, not link delays.

Unthrottled (content wire, ping RTT in ms):

| `reqq` advertised by the uploader | runs | p50 | p90 | p99 | transfer |
|---|---|---|---|---|---|
| none (default) | 3 | 657 / 529 / 559 | 2,807 / 2,526 / 3,183 | 4,303 / 3,364 / 4,109 | 12.2 to 15.2 MiB/s |
| 64 | 1 | 39 | 3,429 | 4,326 | 12.8 |
| 32 | 1 | 14 | 19 | 20 | 20.0 |
| 16 | 3 | 6.3 / 3.5 / 8.1 | 9.9 / 9.8 / 14.5 | 10.4 / 11.6 / 19.2 | 13.1 to 16.0 |
| 8 | 1 | 3.2 | 7.5 | 113 | 11.6 |

The rendezvous wire in the same runs: p50 9.6 to 17.3 ms with no `reqq` (main-thread contention from hashing in both pages, not queueing), 0.9 to 12.2 ms with `reqq`.

Throttled uplink on the uploader (finite shared token bucket), content wire p50 / p90 / p99 in ms, with the rendezvous wire of the same client in brackets:

| uplink | no `reqq` | `reqq` 16 |
|---|---|---|
| 8 MiB/s | 738 / 3,115 / 4,342 (rv p50 0.7, p99 17) | not run |
| 1 MiB/s | 811 / 1,047 / 1,254 (rv p50 0.6, p99 3.4) | **241** / 249 / 251 (rv p50 0.5, p99 1.6) |
| 256 KiB/s | 905 / 1,154 / 1,321 (rv p50 0.6, p99 2.4) | 814 / 972 / 1,012 (rv p50 0.6, p99 1.4) |

Model that fits every row: the leecher sizes its request pipeline in **time**, `length = 2 + ceil(duration * downloadSpeed / 16 KiB)` with `duration` 0.5 s (minimum) to 1 s (maximum) (`getBlockPipelineLength`), so the number of 16 KiB blocks queued *ahead* of an extension frame is about 0.5 to 1 s of the current transfer rate, whatever the bandwidth; the uploader's `wire` write queue has no backpressure (`_push` ignores `push()`'s return value), so all of it sits in front of the frame. With `reqq` the queue is bounded in bytes: 16 blocks = 256 KiB, which drains in 0.25 s at 1 MiB/s (measured 0.241 s) and 1.0 s at 256 KiB/s (measured 0.81 s). One run (`reqq` 64) had a multi-second tail I cannot explain; it is listed under open questions. A real link adds at most the data channel's own queue (about 64 KiB + one message, `MAX_BUFFERED_AMOUNT`) divided by the link rate; that part was **not measurable on loopback**.

**Confidence:** high for the mechanism and the order of magnitude; medium for absolute numbers (one machine, one browser, loopback). **Sources:** lab `results/e3-*.json`, [W1] (`getBlockPipelineLength`, `PIPELINE_*_DURATION`), [W2], [SP3]. **Source date:** 2026-10-17.

#### F17. `reqq` is the lever: a standard BEP-10 handshake field that WebTorrent honours but never sets

- BEP 10 defines `reqq` in the extended handshake: "An integer, the number of outstanding request messages this client supports without dropping any. The default in in libtorrent is 250." [W6] WebTorrent reads the **remote** peer's `peerExtendedHandshake.reqq` in `getBlockPipelineLength` (`length = Math.min(length, reqq)`) and sets no default itself (grep of `webtorrent`, `bittorrent-protocol`: only that one use). So the **uploader** advertises it by setting `wire.extendedHandshake.reqq = N` inside the `wire` listener, before the extended handshake goes out; our own loader is the uploader for every visitor that downloads from it.
- Cost: per-wire throughput is capped at about `reqq * 16 KiB / RTT` (256 KiB per RTT at `reqq` 16: 5 MB/s at 50 ms RTT, 2.5 MB/s at 100 ms). A rule that targets roughly 250 ms of added gossip latency while keeping the cap above the policy rate: `reqq = clamp(round(uploadLimit_Bps * 0.25 / 16384), 4, 32)` (1 MiB/s gives 16, 256 KiB/s gives 4, unlimited gives 32). **Derived, not measured on a WAN.**
- Only protects frames that share a wire with piece traffic; the separate rendezvous wire (F20) does not need it.

**Confidence:** high (mechanism, loopback effect), medium (tuning rule). **Sources:** [W1], lab e3. **Source date:** 2026-10-17.

#### F18. `maxConns` is not enforced for WebRTC peers `[DESIGN-CRITICAL for the policy table]`

`Torrent._addPeer` registers any `simple-peer` object it is given with no count check; `maxConns` is only read in `_drain()` (the TCP / uTP connect queue, which does not exist in browsers). Incoming offers are answered unconditionally by the tracker client (`_onAnnounceResponse` creates a peer for every `offer`). Lab e5: five pages in one swarm, `new WebTorrent({ maxConns: 2 })`, 25 s: **every page held 4 wires** (`client.maxConns` read back as 2). Consistent with the open upstream issue #703 listed in topic 01 F27. So the mobile / cellular rows of ARCHITECTURE section 8 (`maxConns` 10 / 6) do nothing for WebRTC unless the loader destroys surplus wires itself and lowers `numwant` (F19).

**Confidence:** high. **Sources:** [W1][W4], lab e5, topic 01 F25/F27. **Source date:** 2026-10-17.

#### F19. The tracker client: what the loader can and cannot steer

- Outbound offers per announce: `numwant = min(opts.numwant, 5)`, one `RTCPeerConnection` per offer, `OFFER_TIMEOUT` 50 s, default announce interval 30 s until the server's `interval` (120 s on every live public tracker, topic 02) takes over; reconnect after a tracker socket closes uses `min(2^retries * 10 s, 1 h) + U(0, 5 min)`. All torrents and clients in a page share **one WebSocket per tracker URL** (module-level `socketPool`).
- Announce parameters: `Torrent._startDiscovery` builds `{ uploaded, downloaded, left: max(this.length - this.downloaded, 0) }`, then merges the client's `tracker.getAnnounceOpts()`, then the **per-torrent** `opts.getAnnounceOpts()` (a source comment says "TODO: consider deprecating"). For a torrent without metadata `this.length` is `undefined`, so `left` is NaN and goes out as JSON `null` (lab e1 shows `"left": null`). Lab e8: `client.add(infohash, { announce, getAnnounceOpts: () => ({ numwant: 2, left: 1 }) })` sent `numwant 2`, `left 1`, 2 offers; after setting `numwant: 0` and `torrent.discovery.tracker.update()` the next announce carried `numwant 0` and no offers.
- Duplicate peers: `Torrent._addPeer` drops a peer whose remote id is already in `_peers` (log line "ignoring peer: duplicate") and destroys the new connection. This is the glare problem of F24.

**Confidence:** high. **Sources:** [W4][W1], lab e1/e8. **Source date:** 2026-10-17.

### F. The rendezvous torrent for the ledger gossip

#### F20. A bare-infohash torrent is a working, cheap rendezvous point in webtorrent 3.0.21 `[DESIGN-CRITICAL]` (settles DESIGN-REVIEW section 6)

- Call: `client.add("<40 lowercase hex>", { announce: exactTrackerList })` and, synchronously, `torrent.on('wire', w => w.use(Ext))`. No metadata exists anywhere, ever: `torrent.ready` stays `false`, `torrent.metadata` null, `torrent.length` undefined. `ut_metadata` merely emits the warning "Peer does not have metadata" on each new wire (no fetch loop); `_onWireWithMetadata` (bitfield, interest, choke timers, request pipeline) never runs, so the wire carries only the two handshakes, a keep-alive every 55 s and our frames. Handshake plus extended handshake cost about 124 bytes per side (the lab counter read 4,324 bytes sent after 60 pings of 70 bytes each).
- Lab, local reference tracker, Chromium 156: first wire after **151 ms** (`e1`); 15 of 15 trials connected when both pages joined in the same tick (p50 160 ms, max 188 ms) and 15 of 15 when B joined 300 ms after A (p50 466 ms including the 300 ms); extended handshake 1 ms after attach; ping / pong over the extension 60 of 60, **p50 0.7 ms, p99 1.2 ms**; after a **140 s idle soak** the wire was still open and 40 of 40 pings were answered (p50 1.0 ms), with 3 announce-type messages sent by the page in that time (the initial `started`, one answer, and one `update` at the 120 s interval).
- Version split healed (`e11`): page A seeds `site-v1.bin`, page B seeds a different `site-v2.bin` (different infohashes, 0 wires between them); both join `sha1("mw-ledger/1/host:example.test")` = `58e05aa5...e9e2` and are connected in **151 ms**, ping p50 0.8 ms. This is S1's acceptance check ("a tab on version A and a tab on version B exchange an entry within 10 s") at the transport level.
- Safety of the namespace: `ut_metadata` accepts metadata only if `hash(metadata) === infoHash`, so nobody can inject a different torrent under our rendezvous hash without a SHA-1 second preimage.

**Confidence:** high (lab, one browser, loopback). **Sources:** lab `results/e1.json`, `e1-soak.json`, `e1x-rv-*.json`, `e11.json`; [W1][W5]. **Source date:** 2026-10-17.

#### F20a. A hostile peer can make every metadata-less wire fetch 10 MB of junk; one line stops it `[DESIGN-CRITICAL for the rendezvous design]`

`Torrent._onWire` calls `wire.ut_metadata.fetch()` on every wire of a torrent that has no metadata, which is *permanently* true for the bare-infohash swarm. `ut_metadata` believes any `metadata_size` up to `MAX_METADATA_SIZE` (10 MB) that the peer puts in its extended handshake, allocates `new Uint8Array(size)` and requests all `ceil(size / 16 KiB)` pieces, re-requesting on every `reject` until `remainingRejects` (2 x pieces) is used up. Lab e12: page A advertised `metadata_size = 10,000,000` and rejected the requests; the honest page B **allocated 10,000,000 bytes and sent 1,833 `ut_metadata` request messages**. With `wire.ut_metadata.cancel()` called synchronously in the `wire` listener (the same place as `wire.use(Ext)`), B sent **0 requests and allocated 0 bytes**, and the wire still worked. Hash verification (`setMetadata`) would reject the junk eventually, but only after the memory and bandwidth were spent, and each hostile wire can repeat it.

**Confidence:** high (source + lab). **Sources:** [W5][W1], lab `results/e12.json`, `e12-cancel.json`. **Source date:** 2026-10-17.

#### F21. It also works end to end through the four live public trackers `[DESIGN-CRITICAL]`

Two local pages, a random private infohash per trial, ICE over loopback, so this measures **tracker signaling only** (connect times include the WebSocket connect, announce, offer relay, answer relay and ICE). Two full runs, plus one reconnect rerun for `novage` and one for `ftorrent` (rv = bare infohash, `left=null`; seed = bugout-style complete one-file torrent, `left=0`; sim = both join in the same tick; stag = B joins 0.6 s after A):

| Tracker (software per topic 02) | rv sim | rv stag | seed sim | seed stag |
|---|---|---|---|---|
| `tracker.webtorrent.dev` (aquatic) | 1,206 / 1,258 ms | 1,113 / 1,112 ms | none / none | 1,116 / 1,114 ms |
| `tracker.openwebtorrent.com` (uWebSockets, Cloudflare) | 757 / 759 ms | 758 / 759 ms | none / none | **none / none** |
| `open.ftorrent.com` (aquatic) | 455 / 507 / 506 ms | 458 / 468 / 464 ms | none / none / none | none (flake) / 527 / 464 ms |
| `tracker.novage.com.ua` (wt-tracker-rust) | none (outage) / 705 / 720 ms | none (outage) / 715 / 710 ms | none / none / none | none (outage) / 716 / 716 ms |

(each cell lists runs in order: first run, second run, rerun). Bare infohash: **18 of 20 trials connected, the 2 misses being a single `novage` outage during the first run**; seeded complete torrent: **0 of 10 when started together**, and staggered it failed 2 of 2 on `openwebtorrent`. Connect times: about 0.5 s on `open.ftorrent.com`, 0.7 to 0.76 s on `openwebtorrent` and `novage`, 1.1 to 1.26 s on `webtorrent.dev` (probably distance and ICE gathering; the cause was not investigated).

**Confidence:** high for "works today"; medium for stability over time (runs 20 minutes apart; third-party volunteers). **Sources:** lab `results/e9-run2.json`; the first run and the reruns are preserved in `results/NOTES.txt`; topic 02 F1. **Source date:** 2026-10-17.

#### F22. Namespace: derive from a versioned string; keep the ledger id, not the site version, in it

- Use `rv = hex(sha1("mw-ledger/1/" + ledgerId))` as the infohash. The leading `1` pins the gossip protocol generation (same role as the extension name `mw_chain1`), so a future incompatible generation lives in a different swarm instead of wasting connection slots on peers that cannot talk to it. `ledgerId` is the pointer's `chain=` value, defaulting to `host:<hostname>` (ARCHITECTURE section 4).
- P2PT (`sha-1` of an identifier, since 2020) and Trystero (20 base36 characters of a SHA-1) show that trackers accept arbitrary 20-byte values with no torrent behind them; the reference tracker only checks that `info_hash` is a 20-character string (`parse-websocket.js`), and all four live trackers accepted our random infohashes.
- Privacy: the trackers learn which ledger a visitor joins, exactly as they already learn the content infohash; the hash is guessable for any known domain, so it is a rendezvous label, not a secret.

**Confidence:** high for feasibility, medium for the version-in-hash recommendation (a design choice). **Sources:** [P1][T3][W4][TR1][TR2]. **Source date:** 2026-10-17.

#### F23. The "one-piece anchor torrent" (DESIGN-REVIEW S1 fallback; also bugout's design) is the worse variant `[DESIGN-CRITICAL]`

- Building it works and is deterministic: two pages `client.seed(new File([ident], ident), { name: ident })` produce the same infohash (`8951d924...afdd94` for a 29-byte identifier; `length 29`, `pieceLength 16384`; `name` = identifier).
- But a seeded torrent is complete the instant it exists, so the client sends **`completed` (no offers) first and then `started` with `left=0`** (lab: `"event":"completed","left":0,"numwant":50` then `"event":"started","left":0,"numwant":5` with 5 offers). Consequences measured: **0 of 15 trials connected when both pages started together** (`e1x seed/sim`; 12 s timeout), 15 of 15 when B started 0.3 s later (p50 469 ms); on live trackers 0 of 10 together, and on `openwebtorrent` never, even staggered (F21, F25).
- bugout hit the same wall in the wild: a 2021-03-25 comment on its issue #43 reports that peers on `tracker.openwebtorrent.com` never complete a connection while its own `hub.bugout.link` tracker (a plain bittorrent-tracker without a seeder filter) works (F11); my 2026 measurements reproduce the `openwebtorrent` half of that.

**Confidence:** high. **Sources:** lab `results/e1x-seed-sim.json`, `e1x-seed-stag.json`, `e2.json`, `e9-run2.json`; [B1][B3]. **Source date:** 2026-10-17.

#### F24. Why it fails: crossed offers ("glare") are not resolved by WebTorrent `[DESIGN-CRITICAL]`

Debug trace of the failing case (`webtorrent:torrent`, `bittorrent-tracker:websocket-tracker`): both pages register at the tracker (`completed`), then each page's `started` announce reaches the tracker while the other peer is already registered, so **each page receives the other's offer** ("creating peer (from remote offer)") and answers it, then receives the answer to its own offer. `Torrent._addPeer` sees a peer with the same remote id already in `_peers` and logs `ignoring peer: duplicate`, destroying the new `simple-peer`. Each side thus keeps the answerer-side connection and destroys the initiator-side one, so the two surviving `RTCPeerConnection`s are not a pair; after 10 to 15 s they die with "Connection failed". Nothing retries until the next announce (120 s).

The bare-infohash path avoids this because it sends **one atomic announce** (`started` with offers): the tracker processes announces one at a time, so the second announcer's offers reach the first but not the reverse. Crossing is still possible in principle (both peers unconnected and re-announcing within one round trip, for example after a tracker outage), so the loader should detect "tracker says peers exist but 0 wires after 20 s" and re-announce with jitter.

**Confidence:** high (reproduced 0/15 and 0/10; trace read). **Sources:** lab e2 debug log, `e1x-*`, [W1] (`_addPeer`), [W4]. **Source date:** 2026-10-17.

#### F25. Tracker pairing semantics differ: at least one big tracker does not introduce two seeders `[DESIGN-CRITICAL]`

- Raw probe (`seedertest.py`, two fake peers in a random private swarm, A announces first with no offers, B announces with one mock offer; does the tracker forward B's offer to A?):

| Scenario | webtorrent.dev | openwebtorrent.com | open.ftorrent.com | novage |
|---|---|---|---|---|
| S1 both `left: 0` (seeder + seeder) | forwarded 107 ms | **not forwarded** (also 3 repeats: 4 of 4 not forwarded) | forwarded 37 ms | forwarded 85 ms |
| S2 A seeder, B leecher | yes | yes | yes | yes |
| S3 A leecher, B seeder | yes | yes | yes | yes |
| S4 `left` key omitted (Trystero style) | yes | yes | yes | yes |
| S5 `left: null` (WebTorrent without metadata) | yes | yes | yes | yes |

- Code reading: the reference `bittorrent-tracker` 11.2.3 parses `Number(params.left)`, with NaN mapped to Infinity, so `null` becomes **0** (a seeder!) and `undefined` becomes Infinity; `_getPeers` has no seeder filter. `wt-tracker` master: `isPeerCompleted = completed || json.left === 0` (strict), offers go to random peers regardless of status. aquatic master: `PeerStatus::Seeding` only for `Some(0)`, offers go to random peers. Neither explains the `openwebtorrent` result, so the **deployed** software there differs from the public `wt-tracker` master (its `/stats.json` has the wt-tracker schema: 264,581 torrents, 883,684 peers, 287,233 WebSockets at 2026-10-17 21:24Z); the exact version is **unknown**.
- Practical rule: a peer must never announce `left=0` on a swarm whose purpose is peer-to-peer messaging between equals; announce a positive `left` (F19: `getAnnounceOpts: () => ({ left: 1 })`) so every tracker implementation treats the peer as a leecher. This is also what makes `null` vs `0` irrelevant.
- Side effect for the **content** swarm: once everyone in a version swarm is a seeder, `openwebtorrent` introduces them only to newly arrived leechers; the other three trackers keep pairing seeders. Another reason to use at least three trackers (topic 02 R1).

**Confidence:** high for the measurements; medium for the cause. **Sources:** `seedertest.py` output saved as `results/seedertest-2026-10-17.jsonl`, [W4][TR1][TR2][TR3]. **Source date:** 2026-10-17.

#### F26. Tracker load model

Message count per announce that carries `k` offers (all offers answered, upper bound): 1 announce in + 1 response out + `k` offers out + `k` answers in + `k` answers out = `2 + 3k` (17 for `k = 5`, 8 for `k = 2`, 5 for `k = 1` as Trystero does, 2 for `k = 0`). At the live trackers' interval of 120 s (180 s on novage):

| `numwant` per announce | messages / visitor / tracker / swarm / s | offers relayed / visitor / day |
|---|---|---|
| 5 (WebTorrent default) | 0.142 | 3,600 |
| 2 | 0.067 | 1,440 |
| 1 (Trystero torrent) | 0.042 | 720 |
| 0 (saturated) | 0.017 | 0 |

Example: 10,000 concurrent visitors, each in one content swarm and one rendezvous swarm, every tracker listing both: default `k = 5` both: 2,833 messages/s per tracker and 72 M offers/day (36% of the 200 M/day circuit breaker that `ftorrent` publishes, topic 02); content at `k = 5` and rendezvous driven to `k = 0` after saturation: 1,583 messages/s and 36 M offers/day (18%). Each offer also costs the *visitor* one `RTCPeerConnection` created and, if unanswered, destroyed after 50 s (topic 03 F-32). Server caps seen in code: reference tracker 1,000 peers per swarm with a 20-minute TTL (oldest evicted), `wt-tracker` `maxOffers` 20 per announce, aquatic `max_offers` (config).

**Confidence:** medium (derived from client / server code constants and the observed message shapes; not measured on a tracker under load). **Sources:** [W4][TR1][TR2], topic 02 F1/F6. **Source date:** 2026-10-17.

#### F27. Degree, caps and eclipse exposure of the rendezvous swarm (design reasoning, not measured)

- A gossip overlay needs a connected random graph with degree of about 4 to 6 to flood quickly (diameter about `log N`); ledger frames are tiny, so 6 desktop / 3 mobile rendezvous wires are enough. At the same time each wire is a full `RTCPeerConnection` (ICE + DTLS + SCTP keep-alives), so the cap protects mobile (topic 03 F-31 / F-32: 500 per renderer on Chromium, 256 per web process on WebKit, up to 5 new connections per announce per tracker).
- Because `maxConns` is ignored (F18) the loader must (a) drive `numwant` to 0 at the soft cap, (b) accept up to a hard cap of about 1.5x the soft cap, and (c) destroy surplus wires after the handshake, oldest or lowest-scoring first. With all nodes at 0 offers per announce the graph stops churning; newcomers still connect because their offers go to random existing members.
- **Eclipse / Sybil:** anyone can join the rendezvous swarm by knowing the ledger id, and a handful of hostile peers can fill a small number of slots. Blocks are signed, hash-linked and rate-limited (ARCHITECTURE section 6), so hostile peers can withhold but not forge; mitigations are (i) rotate the lowest-value wire periodically, (ii) prefer peers that delivered valid blocks, (iii) keep gossip on the content-swarm wires too, (iv) the snapshot URL `cs` as a durability floor (DESIGN-REVIEW S2). Identity of a wire is only `peerId` (a random string chosen by the peer).

**Confidence:** medium-low (reasoning from measured primitives). **Sources:** F18, F19, topic 03 F-31/F-32, `docs/review/security.md` (Sybil rows). **Source date:** 2026-10-17.

### G. Fallback signaling planes

#### F28. Nostr relays work today as a free-for-all rendezvous bus; NIP-01 and NIP-11 give the rules

- **Spec (read 2026-10-17):** NIP-01: kinds 20000 to 29999 are *ephemeral* - "not expected to be stored by relays"; `OK` replies carry a machine-readable prefix (`duplicate`, `pow`, `blocked`, `rate-limited`, `invalid`, `restricted`, `mute`, `error`; `mute:` means "no one was listening to your ephemeral event"); relays "MAY limit number of connections from specific IP". NIP-11 advertises `max_message_length`, `max_subscriptions`, `max_subid_length`, `max_limit`, `min_pow_difficulty`, `auth_required`, `payment_required`, `restricted_writes`, `created_at_lower_limit` / `upper_limit`. NIP-42 `AUTH` is optional and may be demanded per relay.
- **Live probe today (`nostrprobe.py` from topic 02, a random BIP-340 key, one ephemeral event per relay, REQ filter on tag `x`):** **13 of 13** relays from Trystero's default list accepted the event and echoed it to a second subscription: `cdn.satellite.earth` 16 ms (it sent a NIP-42 `AUTH` challenge but still accepted), `nostr.red5d.dev` 65 ms, `0x-nostr-relay.fly.dev` 95 ms, `relay.nostr.dev.br` 106 ms, `relay.piazza.today` 107 ms, `relay.layer.systems` 124 ms, `relay.grigic.org` 135 ms, `relay.bullishbounty.com` 140 ms, `nos.lol` 166 ms, `relay.degmods.com` 208 ms, `relay.nostrmap.net` 219 ms, `relay.routstr.com` 326 ms, `nostr.rblb.it` 4,010 ms (WS connect 173 to 677 ms). Topic 02 (2026-10-14): 6 of 6 and a NIP-11 sweep of 29 relays (26 parseable; none `auth_required` or `payment_required`; `max_message_length` 65,536 to 4,000,000).
- **How Trystero copes:** 5 relays per app (deterministic shuffle by `appId`), per-relay backoff on `rate-limited:` (60 s doubling to 15 min), permanent retirement of a relay on `blocked:`, `restricted:`, `auth-required:` or `pow:` replies, `since: now` filters (relay clock skew matters), subscription retries every 5.3 s.
- **Verdict for magnet-web:** independent of trackers (different operators, different software), small payloads (an AES-GCM-wrapped SDP, typically 1 to 3 KB, not measured here), no cost; weaknesses: volunteer infrastructure, no SLA, relays may start requiring PoW / auth / payment at any time, and every relay sees the (hashed) room topic and the IPs inside SDP unless a `password` is set.

**Confidence:** high (spec + live), medium (longevity). **Sources:** [N1][N2][N3][N4], [T4], topic 02 F18. **Source date:** 2026-10-17.

#### F29. MQTT and the other Trystero media: nothing new to add

MQTT over wss: 4 of 4 public brokers worked on 2026-10-14 (topic 02 F19) but their own pages say "testing only" (Mosquitto: "please do not abuse or rely upon it"; HiveMQ: "not intended for private or production data"), and the Trystero MQTT package costs 126 KB gzip. Supabase / Firebase are backends of someone's account (against G7). The "ipfs" strategy is Waku and was not exercised. **Confidence:** medium. **Sources:** topic 02, [T5][T6]. **Source date:** 2026-10-14 / 2026-10-17.

### H. Heavier alternatives

#### F30. Hyperswarm / Holepunch: there is no maintained browser path

- Core packages are very active (`hyperswarm` 4.17.2 on 2026-09-22, `hyperdht` 6.34.1 on 2026-10-05, `hypercore` 11.39.0 on 2026-10-14) but target Bare, Node and Pear (topic 06 F33).
- `@hyperswarm/dht-relay` is the only browser route: the browser speaks a relay protocol (messages `connect`, `open`, `data`, `lookup`, `announce`, ...) over a WebSocket to a server that runs the real HyperDHT, and data streams are relayed *through* that server (custodial modes even hand the secret key to the relay). README: "This project is still experimental. **Do not use it in production**." Last npm release 0.4.3 (2023-10-30); last commits 2025-11-01; **the repository shows "This repository was archived by the owner on Oct 15, 2026. It is now read-only."** (read twice, 2026-10-17). 2,956 downloads/week.
- `hyperswarm-web` 2.2.0 (2022-02-15) **[old]**: configured with lists of `bootstrap` (HyperswarmServer), `wsProxy` and `webrtcBootstrap` (signal servers) and "Without [STUN/TURN] the connection is limited to local peers"; built on hyperswarm v1-era `@geut/discovery-swarm-webrtc` and `hyperswarm-proxy-ws`; 200 downloads/week.

**Confidence:** high. **Sources:** [H1][H2][H3], topic 06 F33. **Source date:** 2026-10-17.

#### F31. js-libp2p in the browser: capable, but it needs servers we would have to run, and it is twice WebTorrent's size

- Versions today: `libp2p` 3.4.0, `@libp2p/webrtc` 7.0.0, `@libp2p/circuit-relay-v2` 4.2.15, `@libp2p/websockets` 10.1.23, `@libp2p/webtransport` 6.0.42, `@libp2p/gossipsub` 17.1.4 (new package since 2025-09), all published 2026-10-17; `helia` 7.1.16 (2026-09-29). 125,437 (`libp2p`) and 21,533 (`@libp2p/webrtc`) downloads/week.
- Browser-to-browser ("private-to-private") WebRTC is specified (libp2p WebRTC spec r0, 2023-04-12, Candidate Recommendation) and the `@libp2p/webrtc` README says "**WebRTC requires use of a relay to connect two nodes. The listener first discovers a relay server and makes a reservation, then the dialer can connect via the relayed address.**" and, for circuit relay, "`circuitRelayServer` ... **will not work in browsers**". WebRTC-Direct needs a server with a public UDP port ("Browsers cannot listen on WebRTC Direct addresses"), and its v1 handshake relies on SDP munging that "browsers are removing the ability to do" (v2 does not; go-libp2p supports it from v0.49.0).
- Relay defaults in js-libp2p: duration limit 2 minutes and data limit 128 KiB per relayed connection (`DEFAULT_DURATION_LIMIT`, `DEFAULT_DATA_LIMIT`), `MAX_CONNECTIONS` 300, reservation TTL 2 h; the circuit-relay-v2 spec itself defines no defaults; it says limited relays and slot reservations let relays "effectively manage their resources and provide service at a small scale" and that v1 relays were "an expensive proposition requiring dedicated hosts". A relay therefore only signals; data goes peer to peer afterwards (topic 03 F-02: the largest open hole-punching study reports 70% +/- 7.1% success, not WebRTC-specific).
- Size (esbuild 0.28.2, same settings as F6): a minimal browser node (WebSockets + WebRTC + circuit-relay transport + noise + yamux + identify) = **457,114 B min / 132,887 B gzip**; with gossipsub = 564,669 B / 158,700 B gzip - about 2x `webtorrent.min.js` (about 223 KB) before any application code.
- The `universal-connectivity` demo lists the JS browser peer's transports as WebTransport, WebRTC and WebRTC-direct and names only the public bootstrap nodes as infrastructure; discovery there is by PeerID through the DHT or an explicit multiaddr. I could not read `docs.libp2p.io` (every URL tried returned 404 on 2026-10-17). Whether any **public** relay serves arbitrary third-party browser apps is **unverified**; `@libp2p/auto-tls` (certificates for WSS on public IPs) was not evaluated.

**Confidence:** high for the library facts and sizes; low for relay availability. **Sources:** [LP1][LP2][LP3][LP4][LP5][LP6][M1]. **Source date:** 2026-10-17.

### I. Decision

#### F32. Reuse the swarm wires (plus a bare-infohash rendezvous swarm) rather than a separate Trystero room `[DESIGN-CRITICAL]`

| Criterion | Gossip on content wires only | + bare-infohash rendezvous swarm (recommended) | Separate Trystero room (torrent) | Separate Trystero room (Nostr) |
|---|---|---|---|---|
| New runtime dependency | none | none | +65 KB min / 23 KB gz | +75 KB / 27 KB gz |
| Extra `RTCPeerConnection`s per remote peer | 0 | +1, capped at about 6 | +1, **uncapped mesh** (issue #141) | same |
| Visitors of different site versions meet | **no** | **yes** (F20, e11) | yes | yes |
| Frames queue behind piece data | yes, 0.5 to 3 s (F16) | no on the rv wire; bounded on content wires with `reqq` | no if the room carries no bulk | same |
| Survives all WS trackers down | no | no | no (same trackers) | **yes** (Nostr relays) |
| Wire-format / API stability we control | ours (`mw_chain1`) | ours | **Trystero's; broke in 0.26.0** (F4) | same |
| Extra tracker load | 0 | +1 swarm (`numwant` steerable, F26) | +1 swarm, 1 offer / announce, own WebSocket | none |
| Peer authentication | ours (signed blocks) | ours | none, `onPeerHandshake` hook | same |
| Works with `throttleUpload` / pause | only if rate is not 0 | same, plus unaffected by finite rates | independent of the torrent client | same |

Recommendation: attach `mw_chain1` to **both** the content wires and the rendezvous wires with one adapter (the `Gossip` class already treats a peer as `{ id, send(u8) }`); treat the rendezvous swarm as the primary bulk-sync path and the content wires as an opportunistic bonus with `reqq` set; keep Trystero out of the happy path and, if a tracker-independent plane is wanted, add it later as a lazily loaded adapter over Nostr (F28) behind the same `peer` interface.

**Confidence:** high on the measured rows, medium on the weighting. **Sources:** F4, F5, F6, F16, F20, F26, F28. **Source date:** 2026-10-17.


---

## Concrete recommendations for magnet-web

Effort: S = up to 1 day, M = 2 to 4 days, L = more than a week. Priorities: P0 = fix before the first public build, P1 = before calling it production, P2 = valuable, P3 = later. File names refer to the current tree (`src/loader/torrent.js`, `src/chain/wire-ext.js`, `src/chain/gossip.js`, `src/loader/policy.js`) and to `docs/ARCHITECTURE.md` v0.2.

| ID | Prio | Effort | What to build or change | Evidence | Acceptance check |
|---|---|---|---|---|---|
| R1 | P0 | S | **Replace the one-piece "anchor torrent" with a bare-infohash rendezvous swarm.** In `TorrentManager.addAnchor(ledgerId, trackers)`: `rv = hex(sha1("mw-ledger/1/" + ledgerId))`, `client.add(rv, { announce: <same exact tracker list as the site torrent>, getAnnounceOpts })`; never `seed()` it, never let it complete. Attach `mw_chain1` in the same tick as `client.add()` returns. Rewrite ARCHITECTURE section 5.5 (it currently specifies the one-piece torrent built with `buildSingleFileTorrent` and a preloaded store) and mark the section 14 / DESIGN-REVIEW section 6 open item ("metadata-less wires ... fallback: the one-piece torrent") as resolved; keep `buildSingleFileTorrent` only for tests and `tools/`. | F20, F21, F23, F24, F25 | Playwright test = lab `e11`: two tabs on different site versions get a rendezvous wire in under 2 s on a local tracker; `e1x rv/sim` 15 of 15. |
| R2 | P0 | S | **Announce discipline on the rendezvous swarm:** per-torrent `getAnnounceOpts: () => ({ left: 1, numwant: clamp(softCap - rvWires, 0, 3) })` (explicit `left: 1`, never NaN / null / 0); random 0 to 1.5 s jitter before the first announce; glare watchdog: if no rv wire exists 20 s after an announce whose response shows other peers (`complete + incomplete > 1`), call `torrent.discovery.tracker.update()` after a 0 to 3 s jitter, at most 3 times, then fall back to the normal 120 s cadence; also call `update()` (with jitter) when a wire closes and the count falls below the soft cap, because an announce with `numwant: 0` leaves the next 120 s without new offers. If the per-torrent option is ever removed, use a closure in `client.tracker.getAnnounceOpts` keyed by infohash. | F19, F24, F25, F26 (lab `e8`) | Lab `e8`-style unit: announce payload shows `left 1`, `numwant` follows the wire count and reaches 0 at the soft cap. |
| R3 | P0 | S | **Cut head-of-line delay on content wires with `reqq`:** inside the `wire` listener set `wire.extendedHandshake.reqq = clamp(round(uploadLimitBps * 0.25 / 16384), 4, 32)` (32 when unlimited, 16 at the 1 MiB/s desktop default, 4 at the 256 KiB/s mobile default) before the extended handshake leaves; on the rendezvous wires set 8 (only gossip travels there). Keep frames at most 15 KiB; send only `HELLO` / `ANN` / small `WANT` on content wires and reserve bulk `BLOCKS` for rendezvous wires. | F16, F17 | Lab `e3` variants as an e2e test: ext RTT p99 under 100 ms on a content wire during a 64 MiB transfer (measured 10 to 20 ms with `reqq` 16 to 32; 3.4 to 4.3 s without). |
| R4 | P0 | M | **Enforce connection caps ourselves** (WebTorrent does not for WebRTC): in `TorrentManager._onWire` keep per-swarm soft and hard caps (rendezvous 6 / 9 desktop, 3 / 5 mobile; content from `policy.maxConns`), destroy surplus wires right after the extended handshake (lowest score first: no valid block yet, then newest), rotate the lowest-scoring rendezvous wire every 5 minutes, drive `numwant` to 0 at the soft cap, and count peers by unique `wire.peerId` excluding `webSeed` in the UI. Fix the ARCHITECTURE section 8 table text ("maxConns" is a client option that WebRTC ignores). | F18, F27 | Lab `e5` as an e2e test: 5 tabs, caps 2 / 3, steady state never above 3 wires per tab. |
| R5 | P0 | S | **Harden `wire-ext.js`:** attach only when `wire.type === 'webrtc'`; send only when `wire.peerExtendedMapping.mw_chain1`; ignore frames before `onExtendedHandshake`; in the `wire` listener also call `wire.ut_metadata.cancel()` on rendezvous wires; add a 2 s watchdog that destroys any wire with `wire._bufferSize > 256 KiB` (private field: add a unit test that fails if it disappears and pin `webtorrent` 3.0.21 / `bittorrent-protocol` 5.0.9 in `build.lock.json`); per-wire inbound byte budget and strike counter as already specified; bounded `seen` / orphan caches; dedupe a remote seen on both swarms by `wire.peerId` and send bulk frames on one wire only. | F13, F14, F20a (lab `e7`, `e12`) | Lab `e7` and `e12` as tests: a 16 MiB bogus message is cut at 256 KiB; a hostile `metadata_size` costs 0 bytes on a rendezvous wire. |
| R6 | P0 | S | **Never `throttleUpload(0)` / `uploadLimit: 0`; keep the choke lock.** Rewrite the ARCHITECTURE section 8 sentence "pause = torrent.pause() + throttleUpload(0)" (DESIGN-REVIEW item 19 already lists it); add a test that gossip frames flow under `throttleUpload(262144)` and while paused. If a hard "send nothing" mode is ever wanted, that mode must close the rendezvous wires explicitly, not freeze the client. | F15 | Lab `e4` as test: 0 of 30 with rate 0 is documented as the forbidden case; 30 of 30 with 262,144. |
| R7 | P1 | S | **Tracker policy for the rendezvous swarm:** the same exact list as the site torrent (identical for every peer), at least 3 trackers of which at least 2 pair seeders (today `webtorrent.dev`, `open.ftorrent.com`, `tracker.novage.com.ua`; `openwebtorrent` does not), at most 2 on mobile; weekly CI job that runs the `labs/12-signaling-lab/seedertest.py` scenarios S1 to S5 and the `e9`-style live rendezvous test and opens an issue when the pairing semantics or liveness change (extends topic 02 R9). | F21, F25 | CI job green; red when a tracker stops forwarding `left: 1` offers. |
| R8 | P1 | S | **Frame versioning that never disconnects:** first byte = frame type, second byte = protocol generation; unknown generations are ignored (not an error, not a strike); keep the extension name `mw_chain1` for generation 1 and reserve `mw_chain2` for the next. This is the lesson of Trystero 0.26.0 (a version mismatch disconnects) and bugout (unsigned handshake). | F4, F11 | Unit test: a generation-9 frame is dropped silently and the wire stays up. |
| R9 | P1 | M | **Turn the lab into regression tests** (`test/e2e`, Playwright, local tracker): `e1`, `e1x`, `e3` (a reduced run), `e4`, `e5`, `e7`, `e8`, `e11`, `e12`. They are the guard rails for every WebTorrent upgrade (bare-infohash wires, `reqq` honoured, `maxConns` ignored, `_bufferSize` present, `getAnnounceOpts` honoured). | all lab findings | Suite runs in under 3 minutes in CI with `--disable-features=WebRtcHideLocalIpsWithMdns`. |
| R10 | P2 | M | **Optional second discovery plane over Nostr** (topic 02 R5): lazy `import()` only when the rendezvous swarm has 0 wires 20 s after start or every tracker socket failed; either pinned `@trystero-p2p/nostr@0.26.0` (+27 KB gzip, loaded on demand) or an own client of about 200 lines (NIP-01 `EVENT` / `REQ`, ephemeral kind 20000 + n, tag `x`, BIP-340 via `@noble/secp256k1`); SDP wrapped with a key derived from the **owner public key**, not just the ledger id; adapter exposes `{ id, send(u8) }` to the existing `Gossip`; admission via `onPeerHandshake` / an own challenge bound to the ledger; same soft cap as R4. Test against a local relay (`@trystero-p2p/ws-relay` or strfry), never against public relays in CI. | F5, F28 | A tab with all trackers blocked still finds a peer through the relay in under 10 s; CI uses the local relay. |
| R11 | P2 | S | **Record the "no" decisions** with revisit triggers in `docs/CRITIQUE.md` / `DEPLOY.md`: P2PT, bugout, upstream simple-peer, Hyperswarm (`hyperswarm-web`, `dht-relay` archived 2026-10-15), js-libp2p (revisit only if an owner-run relay becomes acceptable, i.e. goal G7 changes), Trystero as primary transport (revisit at a release that declares a stable wire format and a room cap). | F9 to F12, F30 to F32 | Document merged. |
| R12 | P2 | S | **Update the normative docs:** ARCHITECTURE section 1 facts (bare-infohash rendezvous works; `maxConns` ignored; HOL numbers; `reqq`; unbounded inbound length; `ut_metadata` hostile size), section 5.5, 6.6, 8 and 14; INTERFACES `addAnchor`, `wire-ext.js`; DESIGN-REVIEW section 6 (item resolved). | F13 to F27 | Docs diff reviewed. |
| R13 | P3 | L | **Peer-assisted signaling over `mw_chain1`** (relay SDP offers / answers between peers that share a neighbour) to repair partial meshes and survive tracker outages. Precedent: libp2p private-to-private (a relay carries the SDP, then drops out) and Trystero issue #161 (announced, unshipped). Needs signed offers (ledger identity), a TTL, per-peer rate limits and an anti-amplification rule. | F5, F31 | Design note first; prototype behind a flag. |

Sketch of the code R1, R2, R3 and R5 touch (not tested as written):

```js
// src/loader/torrent.js, TorrentManager.addAnchor(ledgerId, trackers)
const rv = await sha1hex(`mw-ledger/1/${ledgerId}`)        // 40 hex chars; not a torrent, never seeded
const t = this.client.add(rv, {
  announce: trackers,                                     // identical list to the site torrent
  getAnnounceOpts: () => ({ left: 1, numwant: Math.max(0, Math.min(3, this.rvSoft - this.rvWires())) })
})
t.on('wire', wire => {                                    // synchronous, same tick as wire.use()
  wire.ut_metadata.cancel()                               // F20a
  wire.extendedHandshake.reqq = 8                         // F17
  this._emit('wire', { wire, swarm: 'rv' })               // chain adapter calls wire.use(WireExt) here
})
// content torrent wires: wire.extendedHandshake.reqq = reqqFor(policy.uploadLimit)
```

---

## Gotchas

1. `wire.extended(name, ...)` throws `Unrecognized extension` unless the peer advertised `name`; a web-seed wire never does. Gate every send on `wire.peerExtendedMapping`.
2. An extension frame whose payload + 1 byte exceeds 262,144 destroys the Chromium WebRTC connection silently (topic 01 F24; reproduced by accident in e7).
3. WebTorrent announces `left = NaN`, serialised as JSON `null`, for a torrent without metadata: the reference tracker turns that into 0 (seeder), `wt-tracker` and aquatic treat it as a leecher. Always override with an explicit `left: 1`.
4. `tracker.openwebtorrent.com` does not forward offers between two seeders; bugout-style complete torrents therefore never pair there.
5. A complete torrent announces `completed` and then `started`; two peers starting together cross offers and WebTorrent logs only `ignoring peer: duplicate` while destroying the useful connections.
6. `maxConns` has no effect on WebRTC peers; `torrent.numPeers` and `wires.length` include web seeds.
7. `throttleUpload(0)` freezes **every** wire of the client, including handshakes; release takes up to 1 s (the limiter polls once per second). Finite rates never delayed small frames on other wires.
8. A leecher's request pipeline is sized in time (0.5 to 1 s of speed), so an extension frame behind piece data waits roughly that long unless the uploader advertises `reqq`.
9. `bittorrent-protocol` 5.0.9 buffers an announced inbound message of any length (up to 2 GiB) with one `concat` per chunk; the `_bufferSize` watchdog depends on a private field.
10. A metadata-less swarm makes every wire run `ut_metadata.fetch()`; a hostile `metadata_size` of 10 MB costs 10 MB and about 1,800 messages per wire unless `wire.ut_metadata.cancel()` is called in the `wire` listener.
11. Two `WebTorrent` clients in one page share one tracker WebSocket per URL (`socketPool`) but use different peer ids; the reference tracker's close handler stops only the first id, leaving stale peers until its 20-minute LRU expires. A second client is therefore not a free isolation trick.
12. Trystero: `trystero` means the **Nostr** strategy; `trystero/torrent` imports are deprecated in favour of `@trystero-p2p/torrent`; the first `joinRoom` in a page fixes the relay set for all later rooms (#207); `makeAction` returns an object since 0.25 and handler setters became properties; the action frame version byte disconnects mismatched peers; `selfId` comes from `Math.random()`; the default SDP key is derivable; there is no room cap; the torrent strategy opens its own WebSockets and announces a second 20-character base36 "infohash"; the 4th and 5th default trackers are dead or Origin-locked; the "ipfs" strategy is Waku.
13. P2PT: empty `iceServers` by default (no STUN), unbounded chunk reassembly map, strings only, no peer authentication; it listens for simple-peer `close` and `disconnect` (the fork emits `disconnect`).
14. bugout: default trackers dead (`hub.bugout.link` has no DNS record, `tracker.btorrent.xyz` is 127.0.0.1) or seeder-filtering; unsigned handshake keys; re-broadcasts invalid packets; `seen` and RPC callback maps never pruned; depends on `webtorrent ^1.0.2`.
15. The tracker WebSocket is closed by the servers after about 125 to 185 s of silence (topic 02); the stock client then waits `10 s + U(0, 5 min)`, so *discovery* can pause for minutes while established wires keep working.
16. Lab artefacts to remember: loopback only, STUN disabled, headless Chromium needs `--disable-features=WebRtcHideLocalIpsWithMdns`, the transfer is JS-bound (12 to 20 MiB/s), and one idle test showed a single 1,005 ms main-thread stall on both paths.
17. Nostr: `since: now` filters depend on relay clocks; a relay may answer `AUTH`, `pow:` or `blocked:` at any time; ephemeral events are not stored, so a late subscriber sees nothing and must re-announce.
18. js-libp2p: `circuitRelayServer` cannot run in a browser; WebRTC-Direct v1 uses SDP munging that browsers are removing; `docs.libp2p.io` returned 404 for every URL tried on 2026-10-17.

---

## Open questions

1. **Real links.** How much does the data channel's own queue (about 64 KiB + one message) add over a 1 to 10 Mbps WAN or a phone, and does `reqq` 16 still saturate a 100 ms RTT path (the model says 2.5 MB/s)? Needs `tc netem` or a device lab; nothing here was measured off loopback.
2. **`reqq` 64 outlier.** One run showed p50 39 ms but p90 3.4 s while `reqq` 32 and 16 were clean. Repeat at least 5 times per setting and check which side stalls.
3. **Safari and Firefox.** Do metadata-less wires stay open, is `reqq` honoured (same JS, so likely), what are the real `maxMessageSize` values, and what happens to the rendezvous wires on iOS background (topic 03 F-33 says data-only WebRTC does not survive)?
4. **Which software runs `tracker.openwebtorrent.com`?** The public `wt-tracker` master does not filter seeders, yet the deployment does not forward seeder-to-seeder offers (4 of 4 raw probes). Ask the operator or watch for changes; the weekly probe in R7 covers drift.
5. **Degree and cap for the rendezvous swarm** for N from 10 to 10,000 visitors, and how many hostile peers it takes to eclipse a visitor with 6 slots (simulation, then a test with the real adapter).
6. **Is a tracker-independent plane worth shipping?** Needs monitoring data on how often all public trackers are down at once (topic 02 R9) before R10 leaves P2.
7. **Trystero:** re-check when a release declares a stable wire format, a room cap or peer-assisted signaling (#161); verify whether the Waku-based "ipfs" strategy is alive; test the Nostr and MQTT strategies end to end (only the torrent strategy was run here).
8. **js-libp2p:** does any public relay accept third-party browser apps, and what does `@libp2p/auto-tls` change for browser-reachable servers? (Unverified; the docs site was unreachable.)
9. **`getAnnounceOpts` per torrent** is marked "TODO: consider deprecating" in webtorrent's source; confirm it survives the next minor, otherwise use the client-level closure.
10. **Hostile `reqq`:** a peer that advertises `reqq: 1` throttles *our* download from it (we honour peers' values); is a per-peer minimum worth enforcing for the content swarm? (Not tested.)
11. **Battery cost** of 3 to 6 idle rendezvous `RTCPeerConnection`s on a phone (keep-alives every 55 s plus ICE consent checks every 4 to 6 s, topic 03 F-28): unmeasured.

---

## Sources read (all fetched or queried on 2026-10-17 unless noted)

**Trystero**
- [T1] https://raw.githubusercontent.com/dmotz/trystero/main/README.md
- [T2] https://raw.githubusercontent.com/dmotz/trystero/main/CHANGELOG.md
- [T3] https://raw.githubusercontent.com/dmotz/trystero/main/packages/torrent/src/index.ts
- [T4] https://raw.githubusercontent.com/dmotz/trystero/main/packages/nostr/src/index.ts
- [T5] https://raw.githubusercontent.com/dmotz/trystero/main/packages/mqtt/src/index.ts
- [T6] https://raw.githubusercontent.com/dmotz/trystero/main/packages/ipfs/src/index.ts and `packages/ipfs/package.json`
- [T7] https://raw.githubusercontent.com/dmotz/trystero/main/packages/core/src/{strategy,topic-strategy,peer,crypto,data-limits,utils,action-wire,handshake,shared-peer}.ts (and the file list from https://api.github.com/repos/dmotz/trystero/git/trees/main?recursive=1)
- [T8] https://registry.npmjs.org/trystero and https://registry.npmjs.org/@trystero-p2p%2F{core,nostr,torrent,mqtt,supabase,firebase,ipfs,ws-relay}
- [T9] https://github.com/dmotz/trystero/issues , /issues/141 , /issues/100 , /issues/207 , /issues/161 , /issues/151
- [T10] https://api.github.com/repos/dmotz/trystero and `/commits?per_page=8`
- [T12] https://trystero.dev
- [T11] https://api.npmjs.org/downloads/point/last-week/{trystero,@trystero-p2p/torrent,@trystero-p2p/nostr,p2pt,bugout,simple-peer,@thaunknown/simple-peer,webtorrent,bittorrent-tracker,libp2p,@libp2p/webrtc,hyperswarm,@hyperswarm/dht-relay,hyperswarm-web}

**P2PT, bugout, simple-peer**
- [P1] https://raw.githubusercontent.com/subins2000/p2pt/master/{README.md,api-docs.md,package.json,src/p2pt.js}
- [P2] https://registry.npmjs.org/p2pt ; https://api.github.com/repos/subins2000/p2pt and `/commits?per_page=10`
- [P3] https://github.com/subins2000/p2pt/issues , /issues/9
- [B1] https://raw.githubusercontent.com/chr15m/bugout/master/{README.md,index.js,package.json}
- [B2] https://registry.npmjs.org/bugout ; https://api.github.com/repos/chr15m/bugout and `/commits?per_page=8`
- [B3] https://github.com/chr15m/bugout/issues , /issues/43
- [B4] own DNS / WebSocket check of `hub.bugout.link`, `bugout.network`, `tracker.btorrent.xyz` (2026-10-17)
- [SP1] https://github.com/feross/simple-peer ; https://github.com/ThaUnknown/simple-peer ; https://github.com/ThaUnknown/simple-peer/commits/master
- [SP2] https://registry.npmjs.org/simple-peer ; https://registry.npmjs.org/@thaunknown%2Fsimple-peer
- [SP3] `node_modules/@thaunknown/simple-peer/lite.js` (10.1.2, from the npm registry)

**WebTorrent stack and trackers**
- [W1] `node_modules/webtorrent` 3.0.21 (`index.js`, `lib/torrent.js`, `lib/peer.js`, `lib/webconn.js`); https://registry.npmjs.org/webtorrent
- [W2] `node_modules/bittorrent-protocol` 5.0.9 (`index.js`)
- [W3] `node_modules/speed-limiter` 1.0.2 (`lib/throttle.js`, `lib/throttle-group.js`)
- [W4] `node_modules/bittorrent-tracker` 11.2.3 (`lib/client/websocket-tracker.js`, `server.js`, `lib/server/swarm.js`, `lib/server/parse-websocket.js`, `lib/common.js`)
- [W5] `node_modules/ut_metadata` 5.0.1 (`index.js`)
- [W6] https://www.bittorrent.org/beps/bep_0010.html
- [TR1] https://raw.githubusercontent.com/Novage/wt-tracker/master/src/fast-tracker.ts and `README.md`
- [TR2] https://raw.githubusercontent.com/greatest-ape/aquatic/master/crates/ws/src/workers/swarm/storage.rs
- [TR3] https://tracker.openwebtorrent.com/stats.json (2026-10-17 21:24Z)

**Nostr**
- [N1] https://raw.githubusercontent.com/nostr-protocol/nips/master/01.md
- [N2] https://raw.githubusercontent.com/nostr-protocol/nips/master/11.md
- [N3] https://raw.githubusercontent.com/nostr-protocol/nips/master/42.md
- [N4] own probe: `docs/research/labs/02-wss-trackers-probes/nostrprobe.py` on 13 relays, 2026-10-17

**libp2p and Hyperswarm**
- [LP1] https://raw.githubusercontent.com/libp2p/js-libp2p/main/packages/transport-webrtc/README.md
- [LP2] https://raw.githubusercontent.com/libp2p/js-libp2p/main/packages/transport-circuit-relay-v2/README.md and `src/constants.ts`
- [LP3] https://raw.githubusercontent.com/libp2p/specs/master/webrtc/webrtc.md ; https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md
- [LP4] https://github.com/libp2p/universal-connectivity (https://docs.libp2p.io/ pages returned 404)
- [LP5] https://registry.npmjs.org/{libp2p,@libp2p/webrtc,@libp2p/circuit-relay-v2,@libp2p/websockets,@libp2p/webtransport,@libp2p/gossipsub,@libp2p/auto-tls,@libp2p/dcutr,helia}
- [LP6] https://raw.githubusercontent.com/libp2p/js-libp2p/main/README.md
- [H1] https://raw.githubusercontent.com/holepunchto/hyperswarm-dht-relay/main/README.md ; https://github.com/holepunchto/hyperswarm-dht-relay (archived banner) and `/commits/main`
- [H2] https://raw.githubusercontent.com/RangerMauve/hyperswarm-web/master/README.md ; https://github.com/RangerMauve/hyperswarm-web
- [H3] https://registry.npmjs.org/{hyperswarm,hyperdht,hypercore,@hyperswarm/dht-relay,hyperswarm-web,@hyperswarm/secret-stream}

**Own measurements**
- [M1] bundle sizes: esbuild 0.28.2 `--bundle --minify --format=esm --platform=browser` on `@trystero-p2p/{torrent,nostr,mqtt,ws-relay}@0.26.0` and on a minimal `libp2p@3.4.0` node (scratch directories, `npm install --ignore-scripts`)
- [E1] `labs/12-signaling-lab/results/e1.json`, `e1-soak.json`, `e11.json`; [E1x] `e1x-*.json`; [E2] `e2.json`; [E3] `e3-*.json`; [E4] `e4.json`; [E5] `e5.json`; [E6] `e6.json`; [E7] `e7.json`; [E8] `e8.json`; [E9] `e9.json`, `e9-run2.json`; [E10] `e10.json`; [E12] `e12.json`, `e12-cancel.json`; [SEED] `labs/12-signaling-lab/seedertest.py` output of 2026-10-17 (4 trackers x 5 scenarios + 4 repeats); `diag.json`
- Prior work in this repo: `docs/research/01-webtorrent-browser.md` (F23 to F27), `02-wss-trackers.md` (F1 to F22), `03-webrtc-nat-privacy.md` (F-02, F-25, F-28, F-31 to F-33), `06-browser-chain-vs-crdt.md` (F33, F55), `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md`, `docs/review/DESIGN-REVIEW.md` (S1, section 6), `docs/review/security.md`.
