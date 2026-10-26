# Review: distributed systems and P2P realism (magnet-web v0.1)

Reviewed: `docs/ARCHITECTURE.md`, `docs/INTERFACES.md` (both in full) and the vendored packages the design
depends on (`webtorrent@3.0.21`, `bittorrent-tracker@11`, `bittorrent-protocol`, `speed-limiter`,
`@thaunknown/simple-peer`, `torrent-discovery`). `src/` is still empty, so every finding is against the
contracts, with file/section and the exact change to make. Date: 2026-10-14.

## 0. Verdict

Four contract-level defects would make the product fail in its *most common* operating condition, not in
corner cases:

1. **A magnet-only pointer cannot start from the web seed when no other visitor is online.** BEP 19 web
   seeds carry data, not the info dict; webtorrent attaches web seeds only after metadata arrives
   (`lib/torrent.js` `_onMetadata`). For a small site "no other visitor online" is the normal state, so the
   headline promise ("reachable from the web seed when nobody is online") is false as specified. Fix is one
   pointer field (`xs=`), §3 B1.
2. **The first owner tombstone makes the chain unsyncable for every future first-time visitor.** Tombstoning
   rewrites `op`, so `h` no longer recomputes and peers "never re-fetch" it; a newcomer who needs that block
   as a `prev` holds everything after it as orphans forever. §3 B2.
3. **`client.throttleUpload(0)` stalls every outbound byte on every wire, including the web-seed wire.** The
   policy uses it for cellular and for the hidden pause. A cellular visitor could not even send the BitTorrent
   handshake, so no peer and no web seed would ever deliver a piece; only the cache would work. §3 B3.
4. **Head-list sync breaks past ~240 heads (attacker-trivial) and bootstraps a deep DAG one round trip per
   depth level.** §3 B4.

All four have cheap fixes inside the existing module boundaries. The remaining findings are about honesty and
bounding: the hashcash is a nuisance fee, not a defence; `maxConns` has no effect on WebRTC; without TURN a
known class of visitors never reaches a peer; storage caps are 100x too generous for phones; and "blockchain"
over-promises. Proposed wording is in §6.

## 1. Facts verified in the vendored code (evidence for the findings)

| Where | Fact |
|---|---|
| `bittorrent-tracker/lib/client/websocket-tracker.js` | `numwant = Math.min(opts.numwant, 5)`; `OFFER_TIMEOUT = 50 s`; `_createPeer` uses `trickle: false`; reconnect `min(2^retries x 10 s, 1 h) + U(0, 5 min)`; `DEFAULT_ANNOUNCE_INTERVAL = 30 s` only applies if the server sends no interval. |
| `torrent-discovery/index.js:31,180` | Announce interval is 15 min until the first tracker response overrides it. |
| `bittorrent-tracker/server.js:512-535` | WS response `interval = intervalMs / 5` (2 min with the 10 min default). Each offer `i` is relayed to `peers[i]`, where `peers` = up to `numwant` *random* swarm members (`swarm._getPeers`, excluding self). |
| `bittorrent-tracker/lib/server/swarm.js` | Per-infohash LRU of 1 000 peers, 20 min TTL; socket close emits `stopped` for every infohash on that socket. |
| `@thaunknown/simple-peer/lite.js:11` | `ICECOMPLETE_TIMEOUT = 5 s`: with trickle off, an offer/answer is sent when ICE gathering completes or after 5 s. |
| `webtorrent/lib/peer.js:9-10` | WebRTC connect timeout 25 s, handshake timeout 25 s. |
| `webtorrent/lib/peer.js` `setThrottlePipes`, `createWebSeedPeer` | `wire -> throttleGroups.up.throttle() -> conn` for **every** peer type, web seed included. All outbound bytes (handshake, interested, request, keep-alive, extended) pass through the upload throttle. |
| `speed-limiter/lib/throttle.js` `_processChunk` | `while (rate === 0 ...) await wait(1000)`: rate 0 means "stop processing chunks", not "unlimited". |
| `webtorrent/lib/torrent.js` `pause()` / `_addPeer` | `pause()` only sets a flag so new peers are rejected; existing wires keep flowing; tracker announces continue. |
| `webtorrent/lib/torrent.js` `_drain` | Gated on `typeof net.connect === 'function'`, which is false in the browser, and WebRTC peers never enter `_queue`. **`client.maxConns` does nothing for WebRTC wires.** |
| `webtorrent/lib/torrent.js:147,1463,1793-1879` | Upload slots from `opts.uploads` (default 10). `wire.once('interested', () => wire.unchoke())` is unconditional; `_rechoke` runs every 10 s and chokes everything outside the slots. `alwaysChokeSeeders` defaults to true. `seedOutgoingConnections` defaults to true. Seeder-to-seeder wires are kept open (needed for gossip). |
| `webtorrent/lib/torrent.js:375,484-550` | Magnet `xs=` with an http(s) URL is fetched in parallel with discovery and accepted only if its infohash matches. |
| `webtorrent/lib/torrent.js:576-581` | Web seeds are added inside `_onMetadata`, i.e. never before the info dict is known. |
| `webtorrent/lib/webconn.js` | Accepts any `res.ok` (200 or 206). One HTTP request per file intersecting the piece. On error: `donthave` then `have` again after 10 s (infinite retry). Per-request timeout 60 s. |
| `bittorrent-protocol/index.js` `_onMessageLength`, `_write` | No upper bound on the declared message length; the parser buffers until `length` bytes arrived and re-concatenates the buffer on every write. Keep-alive every 55 s; no inbound idle timeout. |
| `ut_metadata/index.js:10` | Metadata capped at 10 MB. |
| `webtorrent/lib/torrent.js:143` | Default piece strategy is `'sequential'`, not rarest-first. |

## 2. Swarm formation and time-to-first-byte

**How a swarm actually forms.** A tab announces once at `add` and then every tracker interval (2 min on
`bittorrent-tracker`, public trackers vary). Every announce generates **5 fresh offers** (5 new
`RTCPeerConnection`s, ICE gathering, up to 5 s each when STUN is slow) that the tracker relays to **5 random
swarm members**; answers come back the same way. A newcomer therefore gets at most 5 outgoing attempts per
interval plus whatever offers other members happen to aim at it (`5/(N-1)` per other announce). Failed offers
linger 50 s. With N <= 6 the graph is complete after one round; with N >= 10 it is a random graph of
out-degree 5 per round, which is well connected. Beyond 1 000 members per infohash the default tracker LRU
starts evicting, which only causes churn in the tracker's view.

**Cost of announcing in an empty swarm.** The 5 offers are generated whether or not anyone is there: ~150
`RTCPeerConnection`s per hour per tab, each with STUN traffic. On a phone this is the dominant idle cost of
"seeding" a site nobody visits. `torrent.pause()` does **not** stop it (B3, B16).

**Timeline for a first visit with N >= 1 peers online (no cache):**

| Step | Typical | p90 / failure mode |
|---|---|---|
| Shell (loader ~40 KB + webtorrent 223 KB min, ~90 KB gz total) | 0.4-1.0 s on 4G | - |
| DoH TXT (two resolvers in parallel) | 80-300 ms | 4 s timeout where DoH is blocked (corporate, IR/CN, some ISPs) |
| Tracker WebSocket (DNS+TCP+TLS+upgrade) | 150-400 ms | public trackers 0.5-2 s or down |
| Offer generation (5 x ICE, trickle off) | 100-500 ms | **5 s** when STUN unreachable / UDP filtered |
| Relay, answer, remote ICE, DTLS | 300-800 ms | +5 s remote ICE timeout; **never** for symmetric-NAT pairs (no TURN) |
| BT handshake, ext handshake, ut_metadata, bitfield, first pieces | 100-300 ms | - |
| **Peer path total (after shell)** | **1.5-3 s** | **6-12 s; a share of pairs never connect** |
| Web seed path with `xs=` (torrent fetch + 4 parallel range GETs) | **0.3-0.6 s** | host without Range support: never (B11) |

The spike's "~170 ms tab to tab" is a loopback number; it says nothing about NAT traversal or tracker latency
and should be labelled as such wherever it is quoted.

**Visitor-count regimes.** Expected concurrent visitors `E[N] = visits_per_day x mean_dwell_s / 86 400`, and
with Poisson arrivals `P(you are alone) = e^-E[N]`:

| Site | E[N] | Alone on arrival | What P2P delivers |
|---|---|---|---|
| 100 visits/day, 60 s dwell | 0.07 | 93 % | Nothing; web seed does all the work |
| 1 000 visits/day, 60 s | 0.7 | 50 % | Occasional second source; chain gossip only half the time |
| 10 000 visits/day, 120 s | 14 | 0 % | Real egress offload; swarm health needs B8 and rarest-first |

Conclusion for the docs and the UI: peers do not improve TTFB for small sites (the web seed is 5x faster at
p50 and 20x at p90). What peers buy is **host egress reduction at scale and a mirror while visitors overlap**.
"Visitors seed while the tab is visible" (G3) plus median dwell times of under a minute means the swarm of a
small site is empty most of the time. State this in README and in the status bar ("you are the only visitor
online; loading from the web seed").

## 3. Findings (ranked; B = blocker, M = major, m = minor)

### B1. Magnet-only pointers cannot bootstrap from the web seed (N = 0 case)
**Where:** ARCHITECTURE §0, §5 step 4, §4 grammar; INTERFACES `src/common/pointer.js`,
`src/loader/torrent.js`, `tools/publish.mjs`.
**Problem:** Web seeds need the info dict first (`_onMetadata` is where `addWebSeed` runs). With only a
magnet and no peer online, `download()` waits `noPeersMs` (60 s) and rejects `E_NO_PEERS` even though the web
seed is up. Every first visit to a quiet site fails.
**Change:**
- §4 grammar: add `xs=<https url of the .torrent>`; `publish.mjs` writes `site.torrent` into the web-seed
  layout as `<ws base>/<name>.torrent` and sets `xs=` to it by default whenever `--ws` is given
  (`webseed-layout.txt` documents both keys). `magnetFromRecord` emits `xs=`; webtorrent fetches it itself
  (`_getMetadataFromServer`) and verifies the infohash, so no loader code path changes beyond passing it through.
- `TorrentManager.download`: start the web seed and the trackers at the same time (webtorrent does once `xs`
  resolves); surface `source: 'webseed'` within the first second. Keep `E_NO_PEERS` only when there is no
  `xs`/`ws`.
- Hub bare-magnet with neither `xs` nor `ws`: show the exact text "This link has no web seed or torrent URL.
  It only loads while another visitor is online." instead of a 60 s spinner.
- CORS: the `.torrent` object needs the same `Access-Control-Allow-Origin: *` rule as the site files.
- Test: E2E case "no seeder page, web seed only" must render.

### B2. Tombstones break sync for every future newcomer
**Where:** ARCHITECTURE §6.4 (tombstone), §6.6 ("hash will no longer recompute ... re-fetched from peers
never"); INTERFACES `block.js`, `state.js`, `stores.js`, `gossip.js`, `node.js`.
**Problem:** The tombstoned shell fails `h` recomputation, so it is never served to or accepted by a node that
does not already have it. A new visitor WANTs a head, walks `prev`, reaches the tombstoned hash, and can never
resolve it: the whole subgraph after the first moderated post stays in the orphan pool. One moderation action
by the owner permanently blinds all later first-time visitors to everything written after it.
**Change (payload outside the hash):**
```
Entry e  = { v:1, site, author, seq, prev, ts, op, nonce }
op put    = { t:'put', k, vh }        vh = hex(sha256(utf8(canonical(value))))
op append = { t:'append', l, vh }     op profile = { t:'profile', vh }
Block     = { e, h, s, v? }           v = the JSON value; absent = redacted
validateBlock: if v present: sha256(canonical(v)) === e.op.vh and bytes(v) <= policy.maxValueBytes.
               A block without v is structurally valid.
reduce:        a block without v is a no-op for kv/lists/profiles but keeps its DAG position.
tombstone(h):  nodes delete v for h, never request or relay v for h, answer WANT with the redacted block.
gossip:        WANT { h:[...], v?:true }. A node holding a redacted block with no matching tombstone requests
               { h, v:true } from other peers (bounded like orphan requests) until a v matching vh arrives.
LIMITS:        maxBlockBytes applies to canonical(e) + canonical(v).
```
This keeps `prev`, `author`, `k`, `l` and `t` inside the hash (so a malicious peer cannot forge causality by
"redacting"), makes redaction a pure availability property, and lets every node verify every block forever.
Test: node A has 50 blocks incl. a tombstoned one; fresh node B syncs to equal `root` (see B4) and renders the
same state.

### B3. `throttleUpload(0)` stalls all outbound bytes, web seed included
**Where:** ARCHITECTURE §8 ("Pause = torrent.pause() + client.throttleUpload(0)", cellular row
`uploadLimit 0 (download only)`); INTERFACES `policy.js`, `torrent.js`.
**Problem:** The upload throttle sits between *our* wire and *every* conn (`setThrottlePipes`, also called by
`createWebSeedPeer`). `speed-limiter` treats rate 0 as "stop processing". Consequences: on cellular the loader
cannot send a handshake, an `interested`, a `request`, a HELLO or a WANT to anyone, including the web seed, so
nothing but the cache ever renders. On the hidden pause, keep-alives and gossip from this node stop too, and
every queued frame is buffered in memory until resume.
**Change:**
- Never call `throttleUpload(0)`. Uploads off = `client.add(..., { uploads: 0 })` when known at start;
  at runtime `torrent._rechokeNumSlots = 0; torrent.wires.forEach(w => w.choke())` and, in the `'wire'`
  handler, `wire.on('interested', () => { if (!uploadsEnabled) setTimeout(() => wire.choke(), 0) })` because
  webtorrent unchokes once on first `interested` regardless of slots (`torrent.js:1463`). `choke()` drops the
  peer's pending requests, so no piece bytes leave; handshake, gossip and downloads continue.
- Rate shaping only with `throttleUpload(bps)` for `bps >= 32768`, and document that it also delays gossip
  frames and keep-alives (a 16 KiB frame at 32 KiB/s = 0.5 s). `throttleUpload(-1)` disables shaping.
- Hidden pause = `torrent.pause()` (no new peers) + uploads off. After the hidden budget (desktop 10 min)
  call `client.destroy()`; on visible, recreate via `seedFromCache` (instant) which also stops the 5-offers-per-
  interval churn and resets tracker backoff (`pause()` alone keeps announcing).
- Unit test: with uploads off, (a) an in-memory peer still completes a full block sync in both directions,
  (b) a web-seed download still completes.

### B4. Head-list sync does not scale: HELLO overflow and O(depth) bootstrap
**Where:** ARCHITECTURE §6.5; INTERFACES `gossip.js`, `dag.js`, `node.js`.
**Problem:** (a) HELLO carries every head. Heads are unbounded by construction: any writer can mint parallel
heads (`prev: [genesis]` repeatedly) and honest writers merge at most 7 per write. Past ~240 heads (64-hex
each) HELLO exceeds the 16 KiB frame and is dropped by every receiver: **sync is dead for that site** until
someone merges heads, which nobody can do faster than an attacker creates them. (b) Bootstrap walks
`heads -> WANT -> orphan -> WANT prev` one layer per round trip: a 5 000-deep guestbook on a 100 ms RTT is
8+ minutes before anything renders. (c) Signature verification at bootstrap is 1-3 ms per block (WebCrypto
P-256 verify, worse on phones): 5 000 blocks = 5-15 s on a phone even with perfect networking.
**Change (depth-window reconciliation; works because every node computes identical depths):**
```
HELLO { site, owner, n, d: maxDepth, root: hex(sha256(sorted h, joined)), heads: <=32 by (depth desc, h asc) }
SYNC  { from, to, w: hex(sha256(sorted h with from<=depth<=to)) }        windows of 64 depth levels
  -> responder: window digest equal   -> { from, to, same:true }
                window <= 64 blocks   -> BLOCKS in (depth,h) order, last frame { from, to, done:true }
                window  > 64 blocks   -> INV { from, to, h:[...] } pages; requester WANTs the misses
Requester: if root differs, sweep windows 0..max(d_mine,d_peer), 2 in flight per peer, windows assigned
           round-robin across peers that advertise the same root; WANT stays for single misses.
```
- `heads` in HELLO are now advisory (fast path for the common "one new block" case); never a frame > 15 KiB
  (leave headroom for the 6-byte extended header).
- Verify signatures in a worker pool; render the site before chain sync; show "verifying N blocks".
- `dag.depth` must be iterative (a 50 000-long linear chain overflows a recursive implementation).
- Implementation note: Kahn's with a `(depth, h)` min-heap is exactly "sort by `(depth, h)`" (a block's
  prevs always have strictly smaller depth, so depth order is a topological order). Implement `order()` as
  that sort; it is simpler and property-testable.

### M5. Chain identity is not bound to the owner key: same site, divergent databases
**Where:** ARCHITECTURE §4 (chain id defaults), §6.4 (`policy` only if `author === ownerPub`), §6.5
(`site` mismatch).
**Problem:** A domain visitor has `chain = host:example.com` and an `ownerPub`; a hub visitor who arrived by
bare magnet has `chain = btih:<hex>` and `ownerPub = null`. Two different databases for one site. Worse, two
nodes on the *same* chain id with different `ownerPub` views (TOFU accepted vs refused, or no owner at all)
reduce the same block set to different states because policy and tombstone rights depend on `ownerPub`.
Deterministic merge then no longer implies convergence.
**Change:** derive the id from the owner: signed record => `chain = 'mw1:' + b64url(sha256(ownerPub + '|' +
(record.chain || scope))).slice(0, 27)`; unsigned => `btih:<hex>` with `ownerPub = null` and a permanent
"unmoderated data" badge. Put `owner` in HELLO and ignore peers whose `(site, owner)` pair differs. Publish
`chain=` in every generated pointer so versions and mirrors stay on one chain.

### M6. Policy and ordering games: insertion at any depth
**Where:** ARCHITECTURE §6.3-6.4; INTERFACES `state.js`, `node.js`.
**Problem:** Nothing forces a new block to reference *current* heads. Anyone can reference old blocks and land
at any depth position, so: `writers:'owner'` is bypassable forever by writing "before" the policy block; list
spam can be inserted into the past; LWW on a key can be flipped retroactively for any depth above the
attacker's chosen position; grinding `h` (already paid for by PoW) decides same-depth ties. Also an author's
two successive posts can be displayed out of order if the second does not reference the first.
**Change:**
- Owner `policy` blocks get `fence: true|false`. Rule: a non-owner block is effective only if it descends
  from the fenced owner policy block that is latest in total order (if any). Non-descendants are no-ops and may
  be dropped at ingest once the fence is known. Document the cost: a fence invalidates concurrent writes made
  before their authors saw it; owners fence when locking down, not for routine policy edits.
- `prev` selection in `node.js`: always include the author's own last block and the known max-depth head;
  fill the remaining slots with the oldest heads (lowest depth, then `h`) so stragglers get merged.
- Keys starting with `_` are owner-only in `reduce` (cheap namespace for notices/config without a fence).
- SDK/UI: lists ordered by total order; never by `ts`. Document same-depth ties as hash-decided.

### M7. PoW is not a defence, and the storage caps are 100x too large for the threat
**Where:** ARCHITECTURE §6.1 ("sub-second on phones"), §6.6 (50 000 blocks), §13 "Peer DoS", §6.2 rate limit.
**Problem:** 14 bits = 16 k SHA-256. In a worker via `crypto.subtle.digest` (one promise per hash) that is
0.3-0.8 s on a laptop and 1-4 s on a mid-range phone, not "sub-second". Native code does 10-50 MH/s per core:
14 bits costs ~1 ms, so one laptop mints ~1 000 blocks/s. At `maxBlockBytes` 16 KiB that is 16 MiB/s of
valid, signed, PoW'd blocks replicated into every visitor's IndexedDB; the 50 000-block cap (**800 MiB**) is
reached in under a minute, and `writers:'owner'` sites still *store* non-owner blocks by design. The per-author
"rate limit" is local receipt-time throttling; it slows ingestion but bounds nothing (blocks are re-requested
later) and must not be presented as a ledger rule.
**Change:**
- Mine with an inline JS/wasm SHA-256 (0.2-2 MH/s), keep WebCrypto for verification; set `bits` 16 for
  non-owner blocks, owner blocks exempt (signature suffices). Write in docs and UI: "the hashcash is a spam
  *fee* for scripts, not a security boundary".
- Cap by bytes, not count: `policy.maxChainBytes` default 8 MiB (owner may raise to 64 MiB),
  `maxBlockBytes` 4 096, `maxValueBytes` 2 048. Past the cap nodes stop ingesting and the UI says so.
- Deterministic per-author quotas in total order: first `policy.perAuthor.blocks` (200) and
  `perAuthor.bytes` (256 KiB) of each author count; the rest are no-ops and prunable. Keys are free, so add
  owner op `{ t:'ban', author }`: all blocks by that author become no-ops and their payloads are dropped
  (redaction per B2), plus `allow` deltas (`{ t:'allow', add:[], remove:[] }`) so allowlists outgrow one block.
- Rename "rate limit" to "ingress throttle" in §6.2 and the SDK error `E_RATE` docs.
- Honest sentence for README: "An open-writer site can be spammed by anyone willing to run a script; the
  owner's tools are allowlist, ban, fence and byte caps."

### M8. `maxConns` is a no-op for WebRTC wires
**Where:** ARCHITECTURE §8 table (30/10/6); INTERFACES `torrent.js` (`policy.maxConns`).
**Problem:** `_drain` only gates TCP/uTP dial-outs (`net.connect`), absent in browsers; every relayed
offer/answer becomes a wire. A busy swarm gives a phone 30+ `RTCPeerConnection`s.
**Change:** enforce in `TorrentManager` on `torrent.on('wire')`: if `torrent.wires.length > policy.maxConns`
destroy the new wire, but keep at least 2 wires when we are a seeder so gossip has a transport. Still pass
`maxConns` to the client for the Node pin. Disclose that each announce still opens 5 short-lived connections.

### M9. No TURN means a known class of visitors never reaches a peer; the spike does not cover it
**Where:** ARCHITECTURE §0 ("public STUN servers"), §1 spike claim, §12 E2E plan, §13.
**Problem:** STUN-only ICE fails between symmetric NATs and across CGNAT (most mobile carriers) and wherever
UDP is filtered (many offices). Industry numbers for TURN necessity are 5-15 % of all pairs and far higher for
phone-on-LTE pairs. With trickle disabled, each offer also waits up to 5 s when STUN is slow. The two-tabs-on-
one-machine spike exercises none of this.
**Change:** document TURN as out of scope for v1 and the web seed as mandatory for any site that must load
("peers are an accelerator and a mirror; the web seed is availability"). Status bar: "N peer connections
failed (NAT); loading from web seed". Add a manual pre-release gate to §12: phone on LTE vs laptop on home
Wi-Fi, both directions, record connect rate. Keep `xs`/`ws` in every published pointer.

### M10. Unbounded message length below our frame cap (peer memory DoS)
**Where:** ARCHITECTURE §13 "Peer DoS: frame size cap 16 KiB".
**Problem:** `bittorrent-protocol` buffers a message until the declared length arrived with no upper bound,
re-concatenating on every write. A peer declares `0xFFFFFFFF` and streams; the tab buffers hundreds of MB
before our `onMessage` ever runs. Our 16 KiB cap is enforced one layer too high.
**Change:** (1) runtime watchdog in the `'wire'` handler: every second, `if (wire._parserSize > 262144)
wire.destroy()` (largest legitimate message is a 128 KiB block + 13 B); (2) file an upstream issue; (3)
optionally patch at build (`build.mjs`) if the bundle is built from source. Add to §13.

### M11. Web seed hosts that ignore `Range` loop forever; the SW must never intercept web-seed traffic
**Where:** ARCHITECTURE §1, §7 fetch routing; INTERFACES `sw.js`, `tools/publish.mjs`, DEPLOY.
**Problem:** `webconn` accepts status 200 as success, so a host that returns the whole file yields wrong
bytes for every piece, each piece fails its hash, `donthave` fires, and it retries every 10 s forever while the
UI shows a web seed that never delivers. Direct S3 is HTTP/1.1 (6 connections), and multi-file torrents issue
one request per file per piece, so a 50-small-file site serialises badly. If someone points `ws=` at the loader
origin, the SW's "cache first" rule answers range requests from cache.
**Change:** `tools/check-webseed.mjs` (also `publish.mjs --verify-ws`): `GET` with `Range: bytes=0-0`,
require 206 + `Accept-Ranges: bytes` + the CORS headers; loader: one same probe before `client.add`; on 200
drop `ws` and show "web seed misconfigured (no Range support)". SW: pass through any request carrying a
`Range` header, never cache 206 responses, reserve `/ws/` on the loader origin. DEPLOY: put CloudFront (HTTP/2)
in front of S3.

### M12. The policy table assumes background execution that mobile browsers do not grant
**Where:** ARCHITECTURE §8 table rows "seed when hidden" and "chain gossip when hidden: yes"; §5 step 8
(`pagehide` flush).
**Problem:** iOS Safari suspends page JS and WebRTC within seconds of the tab or app going to background;
Android Chrome throttles timers to once per minute after 5 minutes hidden and freezes or discards tabs under
memory pressure. "Gossip when hidden" is not available on phones, and a `pagehide` flush is not reliable there.
Any write batched until `pagehide` can be lost.
**Change:** persistence is write-through: a block is in IndexedDB before `ingest` resolves, before it is
relayed and before `put()` returns to the SDK; `visibilitychange -> hidden` flushes `meta`. Table: mobile
rows become "seed when hidden: no (platform suspends)", "gossip when hidden: no"; desktop "yes, up to 10 min,
then destroy client" (see B3).

### M13. Chain durability has no web-seed equivalent; sequential visitors never sync
**Where:** ARCHITECTURE §0, G4 ("every visitor is a node"), §10 `pin.mjs`; user requirement "visitors keep
the chain alive by their visit".
**Problem:** Site files have a durability floor (web seed). The chain's floor is "someone with a copy is
online now", which for small sites is nobody (§2). Visitor A writes at 09:00, leaves; visitor B at 10:00 sees
an empty guestbook. `pin.mjs` is an always-on server by another name.
**Change:** pointer field `cs=<https url>` for a gzip JSON export (the existing export format); `tools/
snapshot.mjs` writes it (from a pinned node, or the owner's browser "export" button) and the owner uploads it
next to the web seed; loader fetches `cs` after render, `node.ingest()` merges it (cap 8 MiB). README text:
"Writes made since the last snapshot exist only on the devices that saw them. If your site depends on its
data, run `pin.mjs` or refresh the snapshot regularly."

### M14. Budgets and relay rules as written ban honest peers and slow propagation
**Where:** ARCHITECTURE §6.5 ("> 64 KiB/s sustained ... ignored", "ANN", "WANT ... deduped").
**Problem:** The peer that bootstraps you sends your whole chain at full speed; a 10 MB chain at 64 KiB/s is
160 s, so the honest sync peer gets banned mid-sync. ANN semantics are unspecified: if ANN carries full blocks
to all peers and every peer forwards, each node receives each block `peers` times (10x on desktop; 72 MB/h
for a 1 block/s site on a phone); if nobody forwards, propagation across a non-clique swarm is 30 s per hop
and E2E test (2) only passes between directly connected tabs. "Deduped" WANT is ambiguous: if every peer that
HELLOs is asked, bootstrap downloads are multiplied by the peer count.
**Change:** split budgets: unsolicited frames 64 KiB/s per peer; solicited (replies to our WANT/SYNC) up to
1 MiB/s per peer and bounded by `maxChainBytes`. ANN carries hashes only (`{ h:[...] }`), sent to all other
peers on first acceptance; receivers WANT unknown hashes. In-flight table `h -> { peer, t }`: one peer per hash,
10 s then the next peer. Orphan pool: 256 per peer, 2 000 global, evict oldest per peer; WANT a missing `prev`
from the sender of the orphan first.

### M15. IndexedDB growth, eviction and identity loss are unbounded or unhandled
**Where:** ARCHITECTURE §6.6, §8 `maxSiteBytes`, §6.1 identity; INTERFACES `cache.js` (`estimateUsage`).
**Problem:** No global budget and no eviction: hub mode accumulates sites until `QuotaExceededError`; the
chain store allows 800 MiB (M7). iOS evicts all site storage (IndexedDB, Cache, SW registration and the
non-extractable identity key) after 7 days without interaction unless the page is installed; Chrome and
Firefox evict under pressure unless `navigator.storage.persist()` is granted. Losing the key loses authorship:
the visitor can no longer tombstone their own posts and appears as a new author.
**Change:** `limits.storageBudget` 512 MiB desktop / 128 MiB mobile with LRU eviction of sites by last visit
(never the current one); `maxChainBytes` as in M7; request `persist()` after consent and show the result;
show `estimateUsage()` in Settings. Document identity loss plainly ("your posting identity lives in this
browser; clearing site data or 7 days without visiting on iOS discards it") and schedule a v2 recovery phrase.

### m16. Failure matrix, tracker backoff and announcing while paused
**Where:** ARCHITECTURE §5 (error messages), §4 source order, §8.
**Problem:** The doc does not state what happens per failed dependency, DoH is the only first-visit source on
a plain domain (so a blocked resolver = no site), and after a tracker outage a long-lived tab waits up to 1 h
(+5 min jitter) to reconnect. `torrent.pause()` keeps announcing and minting 5 offers per interval.
**Change:** always ship the `<meta name="mw-pointer">` at deploy time (DNS is the *update* channel, not the
bootstrap); add a third CORS-capable JSON resolver after verifying it (AdGuard `dns.adguard-dns.com/resolve`,
NextDNS `dns.nextdns.io` are candidates; keep the `[RESEARCH-PENDING]`); on `online` and on visible-after-
hidden recreate the client (B3) so tracker backoff restarts; show swarm size from the announce response
(`complete`/`incomplete`) so "nobody online" is explicit. Matrix for §5:

| Down | First visit | Returning visitor | UI text |
|---|---|---|---|
| Static host | nothing loads | SW serves shell + cached site | - |
| All trackers | no peers; `xs`+`ws` still load | + cache | "Peer discovery unavailable; loading from web seed" |
| STUN | LAN peers only | - | counts as failed peer connections |
| DoH (both) | meta or cached pointer; else fail | cache | "Cannot resolve pointer (DNS over HTTPS blocked)" |
| Web seed | peers only; N = 0 fails | cache | "Nobody online to serve this site right now" |

### m17. Clock assumptions, `seq`, pointer expiry
**Where:** ARCHITECTURE §4 (`exp`, 24 h skew), §6.1 (`seq`, `ts`), §9 (`newestFirst`).
**Problem:** `seq` per author is undefined (not ordered, not validated: either noise or an accidental ordering
dependency). `newestFirst` must not mean "by `ts`" (authors lie; clocks skew). A forgotten `exp` re-sign kills
a site for every visitor after the DNS cache turns over.
**Change:** `seq` = informational author counter, never validated, never affects order (or drop it). Lists
and "newest" are by total order; UI shows `ts` as "claimed". `publish.mjs` default: no `exp`, or 365 days with
a UI warning 30 days before; TXT TTL 300 s so updates propagate within the 10 min re-check.

### m18. Re-seeding determinism details
**Where:** ARCHITECTURE §5 step 4 (`BlobChunkStore` + `skipVerify`), §11 hub mode; INTERFACES
`blob-chunk-store.js`, `cache.js`.
**Problem:** Piece math must follow the file order and offsets of the stored `.torrent`, not the manifest's
sorted paths (they coincide for `publish.mjs` output only); third-party torrents loaded in hub mode may carry
padding files (`attr` `p`, `.pad/`); `skipVerify` serves whatever IndexedDB holds, so a corrupted cache seeds
bad pieces until downloaders ban it.
**Change:** build `BlobChunkStore` from `parseTorrent(torrentFile).files`; treat pad files as zero-filled and
never store or serve them as site files; verify one random piece on load and the rest at idle, `deleteSite`
on mismatch.

### m20. Several tabs of one site should share one swarm node
**Where:** ARCHITECTURE §5; INTERFACES `torrent.js`.
**Problem:** Each tab is a separate peer that connects to its siblings through the tracker and seeds twice.
**Change:** `navigator.locks.request('mw-swarm-' + btih, ...)` elects one leader per origin; followers get
state via `BroadcastChannel`. Universal since Safari 15.4.

### M21. "Blockchain" is not a defensible name for what this is
See §6 for the exact wording to put in README, the status bar, `package.json` and the SDK docs.

## 4. Chain convergence: what holds and where it breaks

**What holds.** With `order = sort by (depth, h)` and a pure reducer, any two nodes with the *same block set
and the same `ownerPub`* compute the same state. The property test in §12 proves exactly that and should stay.

**What does not follow from it.**
- *Same block set* is only reached if sync completes: B2 (tombstones) and B4 (head overflow, bootstrap depth)
  are the two ways it never does.
- *Same `ownerPub`* is not guaranteed today: M5.
- *Convergence is not stability.* A late block at depth `d` re-sorts among depth-`d` blocks and can flip any
  LWW outcome whose last write was at depth `>= d` relative to it, and inserts list items into the past. That is
  correct behaviour for an eventually consistent log, but "height" is not a version number and the UI must not
  imply finality. Show `n` and a short `root` id so two visitors can see that they are in sync.
- *Deterministic does not mean fair.* Same-depth ties go to the larger `h` (grindable); depth position is the
  author's choice (M6).
- *Orphan floods* are bounded only by PoW cost and pool size; with 14 bits an attacker fills the pool at
  ~1 000 orphans/s per core (M7, M14).
- *Reducer budget.* "< 50 ms for 5 000 blocks" is realistic for the reduce step; it is signature verification
  (1-3 ms each, 2-5 ms on phones) that dominates bootstrap. Verify in a worker pool (B4).
- *Deep DAGs.* Depth must be computed iteratively; a 50 000-block linear chain overflows recursion.

## 5. Gossip and storage numbers for phones

- HELLO (~0.65 KB) every 30 s to 10 peers: 0.2 KB/s, under 1 MB/hour. Fine.
- One guestbook post (~1 KB signed JSON): with hash-only ANN + single WANT, ~1 KB + 100 B x peers per node.
  With full-block flooding it is `peers` x block size; at 1 block/s on 10 peers that is 72 MB/hour. Hence M14.
- First sync of a 5 000-post chain is ~5 MB on every new device, before rendering anything useful; on
  `saveData`/cellular sync should stop at 2 MiB and ask. Hence the byte caps in M7 and `cs=` in M13.
- Storage: 800 MiB chain allowance vs. Safari's eviction behaviour and 24-48 MiB site caps makes no sense;
  M7/M15 bring the chain to 8 MiB default.

## 6. Is it a blockchain? Proposed wording

What is specified is a **per-site, author-signed, hash-linked append-only log replicated by gossip and merged
by a deterministic order**: a signed Merkle-DAG log in the family of Merkle-CRDTs (Sanjuan, Poyhtari,
Teixeira, Psaras, 2020), OrbitDB/ipfs-log, Secure Scuttlebutt feeds and Hypercore. It has no consensus, no
finality, no sybil resistance beyond owner policy, no token and no guarantee that two visitors see the same
"latest" at the same moment. The hashcash is a spam fee, not proof-of-work consensus. Calling it a blockchain
in the UI would mislead the one person who asked for a blockchain, because the properties they will assume
(global agreement, finality, "the network keeps it alive") are exactly the ones it lacks.

Use these strings verbatim:

- **Technical name (docs, code, `package.json` description):** "site ledger: a signed Merkle-DAG log
  (hash-linked, author-signed, peer-replicated, deterministically merged; no mining, no consensus, no
  finality)".
- **Status bar / first-run notice:** "Shared site data is a peer-replicated signed log. Every visitor keeps
  and verifies a copy; nobody can forge or silently rewrite entries. There is no mining and no global
  'latest': visitors may briefly see different states and converge automatically."
- **README, 'What it is not':** "Not a cryptocurrency chain. No proof-of-work consensus (the small hashcash is
  a spam fee). No finality: a late entry can change what 'latest' means. No availability when nobody with a
  copy is online: the static host's snapshot is the durability floor. No anonymity: peers see each other's IP
  addresses."
- **Answer to 'visitors keep the chain alive by their visit':** "Each visit replicates the log to one more
  device and serves it to others while the tab is open. Availability at any moment equals 'someone with a copy
  is online right now', which for small sites is usually nobody, so the web seed and snapshot on the static
  host remain the floor, and a pinned node is what makes the log always-on."

## 7. Tests to add to §12

1. Web seed only (no seeder page): hub and per-domain render via `xs` within 3 s.
2. Tombstone, then fresh node: equal `root` and equal state after sync (B2).
3. 300 artificial heads: HELLO stays under 15 KiB and a fresh node still syncs (B4).
4. 5 000-block linear chain: fresh node syncs in O(blocks/64) frames, not O(depth) round trips, with a
   measured wall-clock budget (B4).
5. Uploads off / cellular profile: peer download, web-seed download and bidirectional gossip all complete (B3).
6. 40 wires offered to a mobile-profile node: at most 10 stay open (M8).
7. Fenced policy: a non-owner block referencing pre-fence heads is a no-op on every node (M6).
8. Peer declaring a 4 GiB message is dropped within 1 s and memory stays flat (M10).
9. Manual gate: LTE phone vs Wi-Fi laptop connect rate in both directions (M9).

## 8. Not verified in this review

- Public tracker intervals and uptime; the swarm numbers assume `bittorrent-tracker` defaults.
- CORS/JSON support of third DoH resolvers (left as `[RESEARCH-PENDING]`).
- Exact WebCrypto hash and verify throughput per device class; the ranges above are from typical published
  measurements, not measured here. Measure in the PoW worker and print the number in the debug panel.
- Browser-specific storage quotas and the current iOS eviction window (7 days is the documented ITP rule;
  installed web apps are exempt).
