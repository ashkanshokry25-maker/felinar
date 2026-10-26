# W1 part A digest: research 01-06 (WebTorrent, trackers, WebRTC, Service Worker, DoH, site ledger)

Date: 2026-10-19. Status: research digest for the RESEARCH-DIGEST synthesis, not normative. The normative
documents are `docs/ARCHITECTURE.md` v0.2 (ARCH; "ARCH 8" means its section 8), `docs/INTERFACES.md` v0.2 and
`docs/review/DESIGN-REVIEW.md` (cited as "item N" for its numbered items and "section N" for its sections).
Research files are cited as R01-R06 plus their own finding ids (F, R, G, Q).

**Sources covered** (all in `docs/research/`, all dated 2026-10-14):

| Tag | File | Evidence base | Lab or experiment folder |
|---|---|---|---|
| R01 | `01-webtorrent-browser.md` | npm tarball source, 12 executed experiments (headless Brave 155 = Chromium 155) | `labs/01-webtorrent-lab/` (`results/report-e1..e12.json`) |
| R02 | `02-wss-trackers.md` | live protocol probes of public trackers, Nostr and MQTT; server source | `labs/02-wss-trackers-probes/` (6 stdlib Python probes; numbers are in R02 F1-F12, no stored results) |
| R03 | `03-webrtc-nat-privacy.md` | libwebrtc, Blink, WebKit, Gecko and brave-core source; vendor pricing; NAT papers | none (own "Verification tail" and Appendix B) |
| R04 | `04-service-worker-serving.md` | specs, WPT, engine source, Chromium 156 experiments | `labs/04-sw-experiment/` (`RUN.txt`, `results-chromium-156-2026-10-14.txt`, tests A-E) |
| R05 | `05-doh-dns-txt.md` | curl and real-browser (Brave 155) DoH probes, reference code (32/32 checks) | Appendix A (code) and B (run log) inside the file |
| R06 | `06-browser-chain-vs-crdt.md` | registries, repos, papers, Chromium 155 Worker benchmarks on an M3 | Appendix A (raw numbers) and B (calibration page) inside the file |

`labs/12-signaling-lab/` belongs to `w1-12-signaling-libs.md` and is out of scope; its results are cited only where they correct or
re-confirm R02 (4.2 row 2, 4.3, P1-4, question 14).

**VERIFY material.** No `-VERIFY` file exists for 01-06. Section 4 therefore uses (a) each file's own executed checks,
(b) the wave-2 VERIFY files that re-test claims originating in 01-06 (`w2b-04-observability-no-backend-VERIFY.md`,
`w2c-02-chain-production-features-VERIFY.md`, `w2c-03-identity-ux-VERIFY.md`, `w2c-06-standards-and-ecosystem-VERIFY.md`),
(c) explicit corrections in `w2b-01-tracker-resilience.md` and `w1-12-signaling-libs.md`, (d) DESIGN-REVIEW item 16, and
(e) one read-only local check made for this digest on 2026-10-19 (no network, no browser).

**Precedence when sources disagree.** (1) Executed measurement beats source reading, which beats vendor docs, which beat
blogs. (2) The file dedicated to a topic beats a passing remark in another file. (3) A later re-measurement of the same
question beats an earlier one. (4) Where ARCH v0.2 has already decided, the decision stands; this digest flags only where
research evidence contradicts it (marked CONFLICT in 4.1).

---

## 1. Executive verdict

1. The engine is `webtorrent@3.0.21` (npm `latest`, 2026-07-27; still latest on 2026-10-17), vendored as the exact ES-module
   `dist/webtorrent.min.js` (222,929 B; 64.4 KB gzip; 55.9 KB brotli). In browsers it is WebRTC-only, finds peers only
   through `wss://` trackers and web seeds, and supports BitTorrent v1 (SHA-1 `btih`) only (R01 summary 1-4, F1-F9).
2. A site loads with nobody else online when the pointer carries `xs=` (the `.torrent` URL) and `ws=` (the web seed):
   metadata and data arrived in 205 ms in the lab, while `ws=` alone never got metadata. The web seed must answer a real
   CORS preflight (`cache-control`, `range`) and return `206` (R01 F10, lab e3).
3. The stock `client.createServer()` Service Worker cannot render a website (CSP `frame-ancestors 'none'`, documents
   forced to download, 0/120 correct answers once a second tab is open). Use our own SW and a same-URL, same-origin
   iframe. The origin is the only isolation boundary: frames sandboxed without `allow-same-origin` bypass the SW in
   Chrome 155, Firefox 158 and Safari 27 (R01 F18-F20; R04 summary 2-4, F11, F12).
4. Four public `wss://` trackers passed a full offer/answer relay test on 2026-10-14: `tracker.webtorrent.dev`,
   `tracker.openwebtorrent.com`, `tracker.novage.com.ua`, `open.ftorrent.com`. None has an SLA, idle sockets are cut
   after 125-185 s, ten historic tracker hosts are dead and `tracker.files.fm` is origin-locked. Ship one identical ordered list in the signed
   pointer, plus the owner's own tracker (R02 summary 1-7, R1).
5. Direct WebRTC is probabilistic: plan for 15-30 % of peer pairs needing a relay, with cellular CGNAT the worst case,
   while the default stack is STUN-only. WebRTC is an accelerator; the web seed is the floor (R03 summary 1-3, F-10, R-01).
6. There is no private mode. Peers, trackers and STUN operators see each visitor's public IP and the infohash; mDNS hides
   only LAN addresses; CSP cannot stop hosted-site code from opening its own peer connections. Disclosure and consent
   must come before the first announce (R03 summary 7, F-17, F-38; R02 F23).
7. Platform holes are large and need degraded paths: Safari Lockdown Mode removes `RTCPeerConnection`, Service Workers and
   the Cache API; WKWebView in-app browsers have no SW; Tor Browser and Brave Tor windows have no WebRTC; iOS stops
   WebRTC within seconds of backgrounding; Firefox private windows have SWs only from Firefox 140 (R03 F-21, F-24,
   F-33; R04 F15).
8. Page JS can read a DNS pointer only through CORS-enabled DoH: Cloudflare, Google and dns.sb (JSON and wire), plus
   AliDNS, Control D and DNS4EU in limited forms. Quad9, NextDNS, AdGuard, Mullvad and OpenDNS are unusable. The resolver
   sees the hostname and the visitor IP, Google forwards the visitor /24 unless told not to, and DNSSEC `AD` exists for
   only about 4-5 % of .com zones (R05 summary 1-7).
9. A browser proof-of-work "blockchain" is unsound (one RTX 4090 is about 1,650x a 5-Worker M3 browser) and no browser
   chain client can host application data. The right primitive is the site ledger: a signed, hash-linked op-DAG with
   deterministic order, owner moderation and no consensus, built in-house, with gossip on BEP-10 extensions of the
   torrent's own wires (R06 summary 1-4, 9; F55).
10. The weakest links are iOS persistence (WebKit CryptoKey/IndexedDB bugs, the 7-day script-storage deletion,
    all-or-nothing eviction), hashcash being only a fee, and availability when no peer is online. ARCH v0.2 adopted almost
    all of the above; the one research-backed conflict left is the tracker keepalive (`scrape` every 90 s), see 4.1 row 14
    (R06 summary 5-7, 10; R02 F1, R4).

---

## 2. Decisions table

### 2.1 Libraries, formats, browser mechanics

| # | Decision | Evidence | Source file section | Status in v0.2 |
|---|---|---|---|---|
| D1 | Pin `webtorrent@3.0.21`; copy `dist/webtorrent.min.js` out of the sha512-checked tarball; SRI `sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7`; never `@latest`, the README URL, or esm.sh | README's `cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js` serves v1.9.7 (895,775 B UMD with a `window.WebTorrent` global); esm.sh serves its own rebuild; jsDelivr, unpkg and the tarball are byte-identical; no `window.WebTorrent` in 3.x | R01 F1, F2, 3.2 #14 | Adopted (ARCH 1); local sha256 matches R01 (4.3) |
| D2 | Do not use `client.createServer()` or `sw.min.js`; write our own classic-script SW at the origin root, `updateViaCache: 'none'`, JS MIME, `no-cache` | Stock responses carry `frame-ancestors 'none'`; `destination === 'document'` gets a `DOWNLOAD` attachment; broadcast-to-all-windows race; `!req?.type === 'webtorrent'` precedence bug; Firefox 5 s stream cut; module SWs need Firefox 147+ | R01 F17-F21; R04 F7, F8, R3 | Adopted (`/mw-sw.js`, ARCH 5.2, 7.1) |
| D3 | Shell mode = top-level loader shell plus a full-viewport same-URL same-origin iframe; the SW dispatches on `request.destination` (`document` to shell, `iframe` to site) | Works in Chromium 156 including after a hard reload; the address bar keeps the real site URL | R04 R2, F12, F23 (lab D, E) | Adopted (ARCH 3.1, 7.2) |
| D4 | No `sandbox` without `allow-same-origin` on a SW-served frame; isolate untrusted sites only by origin | WPT `sandboxed-iframe-fetch-event` 29/29 on Chrome 155, Firefox 158, Safari 27; labs: the opaque frame goes to the network and `navigator.serviceWorker` throws | R04 F11, R1; R01 F18.3, F20 | Adopted (ARCH 1, 3.2, 3.3); hub label from the ledger id, not the btih (4.1 row 7) |
| D5 | Own the chunk store: never the default OPFS `fsa-chunk-store@1.3.0`, never `idb-chunk-store@1.0.1`, never an OPFS directory named `chunks` | Importing the bundle deletes OPFS `chunks` (lab e6); `getDirectory()` throws in Firefox private windows; idb-chunk-store needs a global `Buffer` and its read callback never fires (lab e9); a 25-line Uint8Array IDB store re-added a torrent in 52 ms (lab e8) | R01 F11-F14, 3.2 #3 | Adopted as own `MemoryChunkStore` plus Blobs we keep (ARCH 1) |
| D6 | v1-only torrents; reject `btmh`-only pointers; filter `.pad/` entries; deterministic publishing (sorted paths, `fullPath`, `name`, explicit `pieceLength`, `announce: []`, explicit `urlList`, no `private` in `info`, pinned `creationDate`) | BEP 52 not implemented (#1117 open since 2017); `btmh`-only gives `Invalid torrent identifier` (lab e3); file order and `private` change the infohash, dates, announce and url-list do not | R01 F9, F22, 3.2 #6 | Adopted (ARCH 1, `publish.mjs`) |
| D7 | The pointer carries `xs=`, `ws=` and the full `tr=` list; the loader merges `tr=`, never strips it | `ws=` only: 0 peers and no metadata after 6 s; `ws=` plus `xs=`: done in 205 ms; the browser build has no other discovery | R01 F10, 3.2 #4; R02 R1 | Adopted (ARCH 0, 4) |
| D8 | Web-seed host contract: `Access-Control-Allow-Origin: *`; `OPTIONS` answered with `Allow-Methods: GET, HEAD` and `Allow-Headers` covering `cache-control` and `range` (or `*`); `Max-Age`; `Range` answered with `206` + `Content-Range` | No CORS or ACAO only: 0 bytes; full answer: 300,000 B in 204 ms (lab e3); Chromium preflights `cache-control`; Firefox and Safari may add `user-agent` (unverified) | R01 F10, 3.2 #5 | Adopted (DESIGN-REVIEW item 14, `Allow-Headers: *`) |
| D9 | "Uploads off" = choke lock; never `uploadLimit: 0` or `throttleUpload(0)`; `torrent.pause()` is not "stop uploading" | The throttle sits in front of every outbound byte: a downloader with `uploadLimit: 0` never got metadata in 10 s, 512 B/s finished in 732 ms (lab e12); `throttleUpload(0)` delivered 0 of 15 gossip frames (lab e10) | R01 F25, 3.2 #9 | Adopted (ARCH 1, 8; shaping only at 32 KiB/s or more) |
| D10 | Wire extension: `wire.use()` inside a `'wire'` listener attached synchronously to the `Torrent` returned by `client.add()`, plus a walk of `torrent.wires`; send only once `peerExtendedMapping[name]` exists; gossip frames at most 16 KiB | The extended handshake is sent once; Chromium silently kills the connection at 262,144 B including the id byte (lab e4); Firefox assumes 64 KiB when the remote omits `max-message-size`; RFC 8831 says 16 KB | R01 F23, F24; R03 F-25, R-06 | Adopted: `mw_chain1`, frames at most 15 KiB, wires that declare more than 256 KiB are destroyed (ARCH 6.6, 13) |
| D11 | Download the whole torrent (no select or deselect); drive progress from events; cap size on `'metadata'` | #3083 shared-piece hang; #3104 null piece | R01 F16, 3.2 #7 | Adopted (`maxSiteBytes`, ARCH 8) |
| D12 | `RTCPeerConnection` lives on the page main thread; the SW relays to the page over `MessageChannel`; open data channels may move only to dedicated workers | `[Exposed=Window]`; measured absent in Chromium dedicated Workers; transferable `RTCDataChannel` Chrome 130, Firefox 144, Safari 15 | R03 F-37, R-09; R04 F16; R06 F24 | Adopted |
| D13 | Site ledger = signed hash-linked op-DAG, deterministic order, owner moderation ordered by the owner's sequence (never timestamps), no consensus; never called "blockchain" | PoW chains need an honest hash majority; browser chain clients (Helios 0.12.0, Lodestar light-client 1.43.0, smoldot 3.7.0) verify someone else's chain through servers; OrbitDB oplog, Merkle-CRDTs and Byzantine Eventual Consistency are the models | R06 summary 1-3, 3.1 | Adopted (ARCH 6; DESIGN-REVIEW section 4.1) |
| D14 | Build the ledger in-house; OrbitDB 4.0.0, Peerbit 5.4.10, Yjs + y-webrtc 10.3.0, automerge-repo, Gun, Hypercore, SSB are design references only | OrbitDB needs Helia + libp2p and a relay; y-webrtc last released 2023-12-28 and all 3 default signaling servers are dead; automerge-repo `latest` tag = 2.6.0-alpha.3 with no WebRTC adapter; the Hyperswarm browser relay says "Do not use it in production" | R06 2.5, F18-F33 | Adopted (`src/chain/*`) |
| D15 | Signed bytes are RFC 8785 canonical JSON; hash and verify the bytes as received; never derive ids from signatures | Safari's Ed25519 signatures are randomized; re-serialisation breaks hashes; JCS rejects lone surrogates, NaN and integers beyond 2^53 | R06 F42-F46 | Adopted (`canonical.js`, `h = sha256(canonical(e))`) |
| D16 | Signature algorithm | R06 recommends Ed25519 (WebCrypto Chrome/Edge/WebView 137, Firefox 129, Safari 17, Samsung Internet 30) with `@noble/ed25519` 3.2.0 as fallback; R06 F50 calls P-256 the universal fallback (Chrome 37, Firefox 34, Safari 7; verify about half as fast) | R06 F45-F50 | Changed: ECDSA P-256 for owners, authors and pointers (ARCH 4, 6.1); Ed25519 deferred (DESIGN-REVIEW section 3) |
| D17 | Identity key in its own IndexedDB store, round-trip self-tested at creation, JWK or seed fallback, export and import; call `navigator.storage.persist()` | WebKit 177350 (CryptoKey inside an indexed record), 312279 (non-extractable X25519 comes back `null`), iOS ECDSA `DataCloneError` reports (open-chat #9343) | R06 F51-F53, 3.1.8 | Adopted (ARCH 6.1) |
| D18 | One engine per origin: elect a leader with Web Locks plus BroadcastChannel | `SharedWorker` absent on Samsung Internet and only from Chrome Android 148; stock-SW tab race; the OPFS `chunks` wipe hits every tab | R06 F24; R04 G19, G21; R01 F19 | Adopted (ARCH 5.9) |
| D19 | Hashcash is a fee: synchronous JS SHA-256 in Workers (not a `crypto.subtle.digest` loop), target committed in the entry, default 16 bits, mined only after Submit with progress and cancel | The WebCrypto loop is 4.6x slower on an M3; naive phone loops run about 40-120 kH/s; one GPU mints about 3x10^5 entries/s at 16 bits | R06 F36-F41, 3.1.6 | Adopted (16 bits, DESIGN-REVIEW item 4; ARCH 6.1) |
| D20 | Boot checks: secure context, dynamic `import()`, `crypto.subtle`, `BigInt`, `ReadableStream`, IndexedDB; `RTCPeerConnection` and `serviceWorker` are soft checks that select host-only or degraded mode | Torrent SHA-1 hashing uses `crypto.subtle` with no JS fallback; `ws://` trackers are skipped on https pages; Lockdown, WKWebView, Tor | R01 F5, 3.2 #13; R03 R-10; R04 R6, R7 | Adopted (ARCH 5.1, 7.4) |
| D21 | Phone lifecycle: on hidden stop advertising or destroy the client; on `pageshow` (persisted), visible or `online` rebuild the client and re-announce; never rely on `beforeunload` or `unload` | iOS suspends WebRTC after about a 20 s prepare-to-suspend window; Firefox Android clamps timers to 15 min; stock tracker backoff is 10 s + U(0, 5 min) | R01 3.2 #10; R03 F-33 to F-36, R-08; R02 R3 | Adopted (ARCH 8) |

### 2.2 Endpoints: use and avoid

| Kind | Use | Avoid (reason) | Source | Status in v0.2 |
|---|---|---|---|---|
| WebTorrent CDN (only if not self-hosted) | `https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js`, `https://unpkg.com/webtorrent@3.0.21/dist/webtorrent.min.js` (both ACAO `*`) | any `@latest` path (v1.9.7); paths without `/dist/` (404); esm.sh (rebuild plus `process` polyfill); a SW script cannot come from a CDN | R01 F2 | Self-hosted vendored copy |
| WSS trackers | `wss://tracker.webtorrent.dev` (aquatic, Hetzner, interval 120 s), `wss://tracker.openwebtorrent.com` (Cloudflare-proxied, 120 s), `wss://tracker.novage.com.ua` (wt-tracker-rust on Oracle A1, 180 s), `wss://open.ftorrent.com` (aquatic v0.9.0, US colo, 120 s), plus the owner's own | `tracker.btorrent.xyz` (A = 127.0.0.1), `tracker.fastcast.nz` (NXDOMAIN), `tracker.webtorrent.io`, `tracker.sloppyta.co`, `tracker.manager.v6.navy`, `tracker.ghostchu-services.top`, `ws.peer.ooo`, `tracker.dnlab.net`, `qot.abiir.top`, the Heroku host; `tracker.files.fm:7073` (403 unless `Origin: https://files.fm`); PeerTube trackers (registered torrents only); any `ws://` or non-443 port | R02 F1-F3, R1; R01 F8 | `CONFIG.trackers` = the four (INTERFACES); production pointer = owner tracker plus two public (DESIGN-REVIEW item 15) |
| Own tracker | `aquatic_ws` (Linux >= 5.8) or `wt-tracker` / `wt-tracker-rust`; demo: `bittorrent-tracker` 11.2.3 behind Caddy; host: Oracle Always Free A1 (2 OCPU / 12 GB, 10 TB/month egress) with stateless rules | Render Free (sleeps after 15 min), Fly.io (no free tier for new orgs; smallest machine $2.19/month), GCP e2-micro (1 GB/month egress); Cloudflare Durable Objects only as a prototype | R02 F13-F17, R6 | DESIGN-REVIEW item 15 (owner's `aquatic_ws` or `wt-tracker`) |
| STUN | `stun:stun.cloudflare.com:3478` (documented "free and unlimited", UDP only), `stun:global.stun.twilio.com:3478` (free) | `stun:stun.l.google.com:19302` (no published terms; 2014 statement: development use, no SLA); more than 3 STUN URLs | R03 F-07 to F-09, R-02 | Adopted (`CONFIG.stun`) |
| TURN | none in v1. Options measured on paper: Metered Open Relay (20 GB/month free, front-end `apiKey`), Cloudflare Realtime TURN (1,000 GB/month free shared with its SFU, then $0.05/GB; credentials at most 48 h, minted with a secret), Twilio ($0.40-0.80/GB) | any TURN secret in the loader | R03 F-11 to F-14, R-03 | "No relay (TURN) servers" (DESIGN-REVIEW section 4.5) |
| DoH from page JS | Cloudflare `https://cloudflare-dns.com/dns-query?name=<n>&type=TXT` with `Accept: application/dns-json`; dns.sb `https://doh.sb/dns-query` (browser-tested; aliases `doh.dns.sb`, `dns.sb`); Google `https://dns.google/resolve?...&edns_client_subnet=0.0.0.0/0` (GET, no extra headers); `https://1.1.1.1/dns-query` as a bootstrap fallback | Quad9 (JSON retired 2025-05-05; its HTTP/3 path sends no CORS headers), NextDNS, AdGuard, Mullvad, OpenDNS, DNSPod (no CORS); AliDNS for DNSSEC (`AD` always false); POST or custom headers on Google; `cd=1` anywhere | R05 F1, F4, R2-R4 | Sequential Cloudflare, then dns.sb (`doh.dns.sb`), then Google; 4 s timeout; `mw-doh` override (INTERFACES `doh.js`) |
| Second signaling plane (optional) | Nostr relays `nos.lol`, `relay.nostrmap.net`, `0x-nostr-relay.fly.dev`, `relay.bullishbounty.com`, `relay.nostr.dev.br` through Trystero 0.26.0 `relayConfig.urls`; MQTT `broker.emqx.io`, `test.mosquitto.org`, `broker.hivemq.com` last | Trystero's 4th and 5th default torrent trackers (dead, origin-locked); MQTT brokers sit on DNS block lists (w2b-01) | R02 F18, F19, R5 | Not adopted (gossip rides torrent wires) |

---

## 3. Prioritised recommendations (merged and deduplicated across 01-06)

Effort: S = hours to a day, M = days, L = a week or more, or device work.

| ID | Recommendation | Effort | Justifying file(s) | Status in v0.2 |
|---|---|---|---|---|
| **P0-1** | **Fix the tracker keepalive.** `tracker.openwebtorrent.com` closes the socket on `scrape` with no reply (R01 F8; R02 F1, R4), so the 90 s `scrape` keepalive (ARCH 1 and 8, INTERFACES `keepaliveScrapeMs: 90000`, DESIGN-REVIEW item 15) would drop one of the four default sockets every 90 s and push it into the stock reconnect backoff. Use an offer-free keepalive announce with `numwant: 0` (R02 R3 as refined by w2b-01 correction 5), or skip `scrape` for trackers that close on it. Prove it with a Node probe, not a browser. | S | R02 F1, R3, R4; R01 F8 | CONFLICT |
| **P0-2** | **Host-only floor everywhere:** every pointer has `xs=` and `ws=`; the web-seed CORS and `206` contract (D8); a degraded no-SW renderer and a host-only no-WebRTC mode, each with the specific reason shown (Lockdown Mode, WKWebView, Tor, Brave Tor window, UDP blocked). | M | R01 F10; R03 R-01, R-10; R04 R7 | Adopted (ARCH 0, 5.1, 7.4); keep as a release gate |
| **P0-3** | **Own SW, done safely:** same-URL iframe, origin-only isolation, never an opaque sandbox; answer every navigation within about 25 s (interstitial while waiting; Firefox unregisters a SW after 3 navigation faults); keep-alive ping at most every 20 s while streaming; no required state in SW memory; `206` ranges and an own MIME table; versioned SW-page protocol, reload-loop guard, kill switch, `no-cache` on `index.html` and the SW. | M | R01 F17-F20; R04 R1-R6, F13, F17, F18, F20 | Adopted (ARCH 5.2, 7.1; DESIGN-REVIEW item 17, 20) |
| **P0-4** | **Engine traps:** never `uploadLimit: 0` or `throttleUpload(0)` (choke lock instead); never the default chunk store; gossip frames at most 16 KiB with an inbound message-length cap. | S | R01 F12-F14, F24, F25; R03 R-06 | Adopted (15 KiB frames, 256 KiB wire cap) |
| **P0-5** | **Polyfills before the bundle:** guarded `Uint8Array.prototype.toHex/toBase64`, `Uint8Array.fromHex/fromBase64` and `AbortSignal.timeout`, self-tested; floor Safari/iOS 15.4, Chromium 110, Firefox 115 ESR. R01 F4's floor is wrong without them (4.2 row 1). | S | DESIGN-REVIEW item 16; R01 F4 | Adopted; keep the Accept test (Chromium with the four methods deleted completes a download) |
| **P0-6** | **Multi-string TXT.** A signed `v=mw1` pointer is about 515 B even with short URLs (estimate for this digest: 40-hex btih, short `xs` and `ws`, 3 trackers, 87-char owner key, 64-hex `gen`, `seq`, `exp`, 86-char `sig`), so it always spans 3 or more DNS strings. Reassemble per R05 F3 (Cloudflare returns `"a" "b"`, quoted and split mid-token; Google and dns.sb return the joined text; never join with a space); keep the RRset under about 1,200 B; ship publisher snippets for multi-string values (Route 53 `"p1" "p2"`, Terraform AWS `"p1\"\"p2"`, Cloudflare auto-splits). | S | R05 F3, F7, G3, G11, G12 | Partly: `resolveTxt` returns `strings[]`; the join rule and publisher docs are not specified |
| **P0-7** | **Consent before the first tracker or peer connection;** a host-only choice; no privacy claim anywhere. | S | R03 F-17, F-38, R-11; R02 F23; R05 F13 | Adopted (DESIGN-REVIEW section 4.5, ARCH 8) |
| P1-1 | **Offer and connection budgets:** `getAnnounceOpts: () => ({ numwant: 3 })` (2 on phones; heuristic); cap live `RTCPeerConnection`s (mobile 6-12, desktop at most 55, Safari at most about 50); drop peers whose ICE fails within 15-20 s; back off on "Cannot create so many PeerConnections". | S | R02 R2, R8; R03 R-07, F-31, F-32 | Wire cap 30/10/6 adopted; `numwant` not specified |
| P1-2 | **Reconnect discipline:** rebuild discovery on visible, `pageshow` and `online` (adopted); add per-tracker jittered exponential backoff (1 s to 60 s) and a circuit breaker (a `503` with `Retry-After` means hours; ftorrent's breaker trips at 200 M offers per 24 h). Page JS sees 403, 503 and TLS failures only as close code 1006. | S | R02 R3, F12, G14, G15 | Partly |
| P1-3 | **Data-channel liveness and backpressure:** application ping every 10-15 s, dead after 2-3 misses (ICE consent can keep a dead peer "connected" for 30 s); `bufferedAmountLowThreshold` 256 KiB, pause above 1 MiB; `try/catch` around `send()` (`OperationError` at 16 MiB queued, `TypeError` above the negotiated size). | S | R03 F-26, F-28, R-06 | Partly (`wire.setKeepAlive(true)`, 60 s timeout) |
| P1-4 | **Ledger gossip reachability:** keep at least two trackers that pair seeders in every pointer. Ledger gossip rides torrent wires (R06 F55, R01 3.2 #8), but `tracker.openwebtorrent.com` never forwards offers between two seeders and simultaneous seeders' offers cross (w1-12 F21, F25), so completed visitors may never meet through it. | S | R06 F55; R01 3.2 #8; w1-12 (cross-part) | Open |
| P1-5 | **DoH hygiene:** GET with only `Accept`; Google `edns_client_subnet=0.0.0.0/0`; never `cd=1`; read the JSON body regardless of `r.ok` (dns.sb returns HTTP 503 for SERVFAIL); `Status` 3 or a missing `Answer` key means not found; CNAME-only answers mean not found; compare names case-insensitively without the trailing dot; TTL-aware cache plus a 30-60 s negative cache; `referrerPolicy: 'no-referrer'`, `credentials: 'omit'`; the SW must not intercept DoH fetches. Use the browser-tested `doh.sb` hostname or add `doh.dns.sb` to the canary. | S | R05 F2-F4, F12-F14, R2, R6, R9, R10, G1-G9 | Mostly adopted; `doh.dns.sb` alias not browser-tested by R05 |
| P1-6 | **iOS persistence:** key self-test with fallback and export; `persist()`; Add to Home Screen advice; never promise offline use on iOS; warn about the 7-day deletion. | M | R06 F25, F51-F53; R04 F21; R01 F30 | Adopted (ARCH 6.1; DESIGN-REVIEW section 4.3) |
| P1-7 | **Canaries without browsers:** scheduled Node checks of tracker liveness and relay (fail below 3 passing; alert on any new 403 or 503), DoH CORS and HTTP/3 status per endpoint, web-seed CORS and `Range`; run only from `tools/check-site.mjs`, `tools/check-webseed.mjs` or CI, per `docs/DEV-NETWORK.md`. | M | R02 R9; R05 R13; R01 3.2 #12 | Tools exist; schedule not specified |
| P1-8 | **Real-device release matrix:** iOS Safari (tab, private, Home Screen, Lockdown on and off), iOS Chrome and Brave (WebKit), Android Chrome, Samsung Internet, Firefox 158, ESR 140, private and Android 149+, Brave (Shields levels, Tor window), Safari 27 on macOS. Cases: SW control and sandbox, hard reload, idle kill, stream keep-alive, `Range` seeking, web-seed preflight, frames of 1-256 KiB, key round-trip, 7-day persistence, background and lock resume, LTE-to-LTE. | L | R01 3.2 #15; R02 R10; R03 R-13; R04 R9; R05 R13; R06 3.1.11 | DESIGN-REVIEW item 25 release gate |
| P2-1 | **Measure before buying relays:** opt-in candidate-pair telemetry via `getStats()` to learn the real relay share; then decide a TURN tier. If Tier 1: a CI-minted `ice.json` (Cloudflare TURN, TTL at most 48 h, billing alert, revoke if scraped) or a Metered `apiKey`; relayed peers carry gossip only and bulk comes from the web seed; a relay-only privacy mode exists only with TURN. | L | R03 R-03 to R-05, R-13, F-11 to F-15 | Not planned for v1 |
| P2-2 | **Own tracker in production pointers** (`aquatic_ws` or `wt-tracker-rust`; Caddy `stream_close_delay`; stateless Oracle rules; a health check against idle reclamation); start from w2b-01's `tracker/tracker.mjs`, not R02 F13's wrapper. | M | R02 R6, F13-F16, G7-G13; w2b-01 correction 1 | DESIGN-REVIEW item 15 |
| P2-3 | **Second discovery plane for the ledger only** (a Trystero Nostr room `sha1("magnet-web/chain/v1/" + infohash)` on 5 pinned relays; MQTT last), only if wire-only gossip fails P1-4. | M | R02 R5, F18, F19 | Not adopted |
| P2-4 | **Wire-format DoH** (RFC 8484 GET `?dns=`, ID 0, EDNS0 1232, DO=1 for `AD`) as a second parser, as Cloudflare recommends for critical use. | S | R05 F2, R3, Appendix A.2 | Not adopted |
| P2-5 | **`_magnet` governance:** a one-page spec and an IANA Expert Review request for `TXT _magnet`; talk to the btlink author about one shared label. | S | R05 F8-F10, R12; w2c-06-VERIFY claim 2 | Open |
| P2-6 | **Production hubs:** one origin per site (label from the ledger id), wildcard TLS, a Public Suffix List entry. | L | R04 R1, Q7; R06 3.1.1; DESIGN-REVIEW item 6 | Specified, not built |
| P3-1 | **Naming:** `KayleePop/magnet-web` (MIT; same SW + iframe + WebTorrent idea; last commit 2022-12-14) already exists; namespace npm and GitHub identifiers. | S | R04 F3, R10 | Open |
| P3-2 | **Ed25519 identities** (algorithm-tagged, strict verification pre-checks because of ZIP 215 disagreements) only if P-256 persistence fails on devices. | M | R06 F45-F50 | Deferred (DESIGN-REVIEW section 3) |
| P3-3 | **Cloudflare Workers plus Durable Objects tracker** prototype (no machine to run). | L | R02 F17; w2b-01 correction 2 | Not planned |
| P3-4 | **Opt-in Screen Wake Lock** for visitors who want to keep seeding (Chrome/Edge 84, Safari 16.4, Firefox 126, Samsung Internet 14). | S | R03 R-08, F-18 | Not planned |
| P3-5 | **COOP/COEP per document** only when a hosted site needs cross-origin isolation (`require-corp` on Safari; one extra reload). | M | R04 R8, F19 | Not planned |
| P3-6 | **Do not pursue now:** browser-side DNSSEC validation (no maintained library; 4-5 % of .com signed), ENS or an L2 as the root of trust through Helios or Lodestar (needs RPC servers), negentropy packaging (v0.2 has its own depth-window digests). | - | R05 Q7; R06 F1-F4, F54, Q10, Q14 | - |

---

## 4. Verified vs refuted or nuanced claims

### 4.1 Contradictions between the six files, and which source wins

| # | Topic | One file says | Another file says | Winner and why |
|---|---|---|---|---|
| 1 | Live trackers | R01 F8: three live (openwebtorrent, webtorrent.dev, novage); `btorrent.xyz` "TCP connect error"; files.fm 403 "to a non-browser handshake" | R02 F1-F3: four live, adding `open.ftorrent.com`; `btorrent.xyz` resolves to 127.0.0.1; files.fm answers 403 to every Origin except `https://files.fm` | R02: dedicated topic, offer/answer relay test, five Origin variants. R01 says it did not review R02. |
| 2 | Announce cadence | R03 summary 10 and F-32: up to 5 new `RTCPeerConnection`s per tracker "every 30 s", worst case 30 pending for 3 trackers | R02 F8: 30 s is the client default only until the first response; live servers answer `interval` 120 s (180 s on novage) | R02 (code plus live). Steady state is 5 offers per tracker per 120-180 s; R03's figure is an upper bound for the first minute or for frequent re-announces. |
| 3 | Lockdown Mode scope | R01 F28 and summary 12: SW, Cache API, Web Locks off; RTCDataChannel and WASM only "reportedly"; R06 summary 10: "may disable JIT, WASM, WebRTC" | R03 F-21: `PeerConnectionEnabled` plus 48 other prefs flagged `disableInLockdownMode` in WebKit main (2026-10-14), including SW, IndexedDB (status "embedder"), Cache API, Web Locks, WebTransport; R04 F15: WebKit 16.4 notes list SW, Cache API, CacheStorage, Web Locks | R03 for WebRTC (engine source plus two independent tests), R04 for SW and Cache (Apple primary). IndexedDB unresolved until a device test. All four agree that only the per-site exclusion helps. |
| 4 | Firefox private-window SW | R01 F30: "fixed in Firefox 138/139 per Bugzilla 1320796, unverified" | R04 F15: Firefox 140.0 release notes (2025-06-24); landed in 139 and was disabled again (bug 1967568); MDN BCD's "139" is wrong; ESR 128 never | R04 (release notes plus bugs); DESIGN-REVIEW and ARCH 1 use 140. |
| 5 | Default store on Safari < 26 | R01 F12: the bundled `createWritable` polyfill runs before `SUPPORTS_FSA` is evaluated, so Safari 15.2-25 take the OPFS path (inference from module order) | R04 F14b and R4: Safari < 26 runs RAM-only | R01 (source order). ARCH 1, re-verified 2026-10-17, describes the polyfill on Safari 15.2-18.1 as a module Worker per write. Moot: v0.2 never uses the default store. |
| 6 | Isolation by sandbox | R06 3.1.9 and R03 R-12: an opaque-origin sandboxed iframe with a narrow `postMessage` API is an acceptable boundary | R04 F11, R1 and R01 F18.3, F20: opaque frames are not SW-controlled and their navigation bypasses the SW (WPT 29/29; both labs) | R04 and R01 (measured). R06 flagged the conflict itself (Q7). Only a separate origin isolates. |
| 7 | Hub subdomain label | R04 R1: `https://<base32 infohash>.hub.example/` | R06 3.1.1: the database id must stay stable across releases while the infohash changes on every publish | R06's principle. DESIGN-REVIEW item 6 uses `label = base32(sha256(ledgerId))[0:32]`, with `base32(btih)` only for bare magnets. |
| 8 | Gossip frame size | R06 3.1.7: messages up to 64 KiB | R01 F24, R03 R-06: at most 16 KiB (Chromium hard cap 262,144 B; Firefox assumes 64 KiB; RFC 8831) | R01 and R03 (measured plus spec). v0.2 uses 15 KiB. |
| 9 | Discovery planes | R02 R5: add a Nostr or MQTT room as an independent second plane for the ledger | R06 F55 and R01 3.2 #8: gossip rides BEP-10 on torrent wires; no second signaling plane | R06 and R01 for v1 (fewer third parties, nothing new to disclose); R02 R5 stays a fallback (P2-3). R02 itself rates the wire option as equally supported. |
| 10 | Trackers per phone | R02 R1: every peer announces to every entry (peers that share no tracker never meet) | R03 R-07: at most 2 trackers on mobile | Compatible if phones use the first two entries of the same ordered list and lower `numwant` (R02 R2), while desktops announce to all. This reconciliation is the digest's inference, untested. |
| 11 | STUN set | R01 3.2 #11: two vendors; WebTorrent default is Google plus Twilio | R03 R-02: Cloudflare first; Google and Twilio as alternates; at most three | R03 (terms evidence F-07 to F-09). v0.2 dropped Google entirely. |
| 12 | DoH integrity model | R05 R2: 2-of-3 quorum with early exit; distinct valid answers mean conflict | ARCH 4 and INTERFACES `doh.js`: sequential, first success; integrity from the owner's P-256 signature, TOFU pin, `seq` and `exp` | v0.2 decision. A resolver can only withhold or replay, and replay is bounded by `seq` and `exp`. The quorum still matters for unsigned bare-magnet records. |
| 13 | Signature algorithm | R06 F45-F49: Ed25519 with a noble fallback | R06 F50: P-256 is the universal fallback | v0.2 decision: P-256 (no fallback library; works on Chrome < 137, Samsung Internet <= 29, iOS 16). Ed25519 later. |
| 14 | Tracker keepalive | R02 R3: offer-free keepalive announce about every 60 s; R02 R4 and R01 F8: never `scrape` (openwebtorrent closes the socket) | ARCH 1 and 8, INTERFACES `keepaliveScrapeMs: 90000`, DESIGN-REVIEW item 15: `scrape` every 90 s | **CONFLICT.** The research measurement wins on the fact; v0.2 needs P0-1. The DESIGN-REVIEW Accept test (at least one socket still open after 30 idle minutes) would pass anyway, so tests would not catch it. |

### 4.2 Refuted or nuanced by later verification

| # | Original claim | Verdict | Correction | Verified in |
|---|---|---|---|---|
| 1 | R01 F4: the bundle uses no post-2022 APIs; run floor Chrome/Edge 103 (124), Firefox 100, Safari/iOS 16.0, Samsung Internet 27 | **Refuted** | The bundle calls `e.toHex()` and `e.toBase64()` unguarded, and `Uint8Array.fromHex()` for hex strings longer than 64 chars (uint8-util); these need Chrome/Edge 140, Firefox 133, Safari 18.2. With guarded polyfills v0.2 declares Safari/iOS 15.4, Chromium 110, Firefox 115 ESR. Local check on 2026-10-19: `node_modules/webtorrent/dist/webtorrent.min.js` (3.0.21; sha256 `db4dca98cd135c732eeffdede3cf5f8febd0585a0eba4dc4d1effa1b901f4c3d`, the same bytes R01 hashed) contains one of each call. | DESIGN-REVIEW item 16; ARCH 1, 5.1; this digest |
| 2 | R02 F1: all four trackers "pass a full signaling test" | **Nuanced** | True for leecher offers. `tracker.openwebtorrent.com` does not forward offers between two seeders (4/4 raw probes, 2/2 end-to-end), and two seeders started together never connect on any tracker (0/10 live) because their offers cross. All four still made rendezvous connections on 2026-10-17 (18/20; the misses were one novage outage). | w1-12 summary 3, F21, F25, e9 |
| 3 | R02 F13: the "hardened programmatic server" snippet | **Refuted** | It imported `{ Server }` (a default export) and left the crash, ping, backlog, scrape and swarm-count defects open; superseded by `labs/w2b-01-tracker-resilience-ref/tracker/tracker.mjs`. | w2b-01 correction 1 |
| 4 | R02 F17: no public WebTorrent-protocol Durable Object tracker exists | **Refuted** | `manalejandro/cf-feditorrent` is a partial one; w2b-01 built a prototype in `cf-do/`. | w2b-01 correction 2 |
| 5 | R02 R5, F19: public MQTT brokers as the third fallback plane | **Nuanced** | MQTT brokers are on mainstream DNS block lists. | w2b-01 correction 4 |
| 6 | R02 R3: keepalive announce | **Refined** | Keepalive announces must carry `numwant: 0`; changing cadence and reconnect needs per-instance patches of internal objects. | w2b-01 correction 5 |
| 7 | R02 G14: 403, 503 and TLS failures all look like close code 1006 to the page | **Confirmed, refined** | Eleven failure classes all reached page script as a generic `error` plus `close(1006)` in Chromium 156 and WebKit 27.2; a Playwright harness (`socketerror`) or a Node probe can read the reason, page script cannot. | w2b-04-VERIFY claim 1 |
| 8 | R05 F9: IANA underscored registry "69 entries, 16 of type TXT" | **Refuted (count only)** | 72 records, 17 TXT (R05 left out `_dmarc`). Still true: `_magnet`, `_btlink`, `_dnslink` and `_atproto` are unregistered; `_x402` was registered 2026-08-11 on a draft that is now at -03. | w2c-06-VERIFY claim 2 |
| 9 | R01 F1, F9, F10: 3.0.21 is latest; BEP 52 not implemented; `xs=` fetch checks the infohash | **Confirmed** | Still latest on 2026-10-17; a non-matching `xs` torrent is dropped with a `warning` (not an error) and the client continues with trackers and `ut_metadata`; "maintenance mode" is an inference, so say "dependency-bump cadence". | w2c-06-VERIFY claim 7 |
| 10 | R06 F10 and summary 7: 1.3x10^7 H/s with 5 Workers on an M3 (about 1 ms per 14-bit mint) | **Nuanced** | Those rates are for 43-byte single-block preimages. v0.2 hashes the whole canonical header (394-528 B, 7-9 SHA-256 compressions): a 16-bit mint takes 38.8-48.8 ms with 5 Workers in Chromium 156 (48-69 ms in WebKit 27.2) and 174-283 ms with 1 Worker in Chromium (201-234 ms in WebKit); a WebCrypto loop on WebKit takes 0.8-1.0 s. One native core fills the 8 MiB cap at 16 bits in about 13 min. Phone figures are unmeasured. "Hashcash does not stop a flood" is confirmed. | w2b-04-VERIFY claim 5, corrections 2-3 |
| 11 | R06 F47: WebCrypto ECDSA P-256 verify 15.0-15.4k/s | **Nuanced** | Chromium-only. WebKit 27.2 is about 1.5x slower (8.8-9.9k/s); through the 2-worker pool the 8 MiB default (15.8k-22.0k blocks) needs 1.1-1.9 s on an M3; phones unmeasured. | w2c-02-VERIFY claim 5 |
| 12 | R06 3.1.2-3.1.3: strict per-author `s` and equivocation rule 7 (two ops with the same `(a, s)` hide all later ops) | **Nuanced** | Reusing one key on several devices (a recovery-phrase restore) would freeze that identity for good, as SSB and Manyverse describe ("irrecoverably stuck"). v0.2 made `seq` informational, so clones are harmless for validity. Do not bring back rule 7 without per-device keys. | w2c-03-VERIFY claim 6 |
| 13 | R06 F51 and 3.1.9: a non-extractable key is usable by any same-origin script | **Confirmed, stronger** | Re-run in Chromium 156 and WebKit 27.2: a forged signature verifies under the visitor's key, and the key object can even be structured-cloned to another origin. | w2c-03-VERIFY claim 1 |
| 14 | R06 F25, R04 F21, R01 F30: Safari deletes script-writable storage after 7 days without interaction | **Nuanced** | The clock counts 7 days of Safari use without interaction, applies only while Prevent Cross-Site Tracking is on, and its unit is the registrable domain; `persist()` returned false even in a persistent profile. | w2c-03-VERIFY claim 2 |
| 15 | R06 F52: iOS `DataCloneError` reports for ECDSA keys | **Nuanced** | October rate is 7-15 a day; the cause is an unverified hypothesis; Playwright's default WebKit context is incognito-like and a persistent WebKit profile round-trips keys across restarts; a new variant has `indexedDB` missing entirely. | w2c-03-VERIFY claim 3 |
| 16 | R06 F45: Ed25519 in WebCrypto in every major engine | **Confirmed** | Engine support confirmed; P-256 is not the only curve in WebAuthn, VC or did:key ecosystems. | w2c-03-VERIFY claim 4 |

### 4.3 Claims verified by execution or a second primary source

| Claim | How it was verified | Source |
|---|---|---|
| Stock SW multi-tab race: 0/120 correct once a second same-origin tab exists | lab e2 (`statuses: {"404": 120}`) | R01 F19 |
| `ws=`-only never gets metadata; `ws` plus `xs` completes in 205 ms; ACAO-only seeds give 0 bytes; `btmh`-only gives `Invalid torrent identifier` | lab e3 | R01 F9, F10 |
| An extended message of 262,144 B (plus the id byte) silently destroys the Chromium connection; 262,143 B arrives | lab e4 | R01 F24 |
| `uploadLimit: 0` blocks metadata; 512 B/s completes in 732 ms; `throttleUpload(0)` delivers 0 of 15 frames until restored | labs e10, e12 | R01 F25 |
| Importing the bundle deletes OPFS `chunks`; `torrent.destroy()` keeps data; re-add from OPFS in 53 ms | lab e6 | R01 F12 |
| `idb-chunk-store` without `Buffer`: the read callback is never invoked | lab e9 | R01 F13 |
| Custom SW from Cache Storage: 100/100 with a second tab; the lab SW answered a `Range` request with 200 (production must return 206) | lab e7 | R01 F20 |
| SW: opaque sandbox not controlled (`SecurityError`); idle SW killed within 85 s; a page-fed 120 s stream with 40 s gaps survives; same-URL dispatch works; a hard reload bypasses only the top-level document | `labs/04-sw-experiment/results-chromium-156-2026-10-14.txt` | R04 F23 |
| DoH CORS matrix; TXT normaliser gives byte-identical sets across 5 retrieval paths for 8 names; 32/32 checks | Brave 155 runs (Appendix A, B) | R05 F1, F3 |
| Chromium 500 `RTCPeerConnection` cap, 16 MiB send queue, 256 KiB message size | re-read in current Blink, libwebrtc and WebKit sources | R03 Appendix B |
| Corrected inside R03 before publication: Metered free tier is 20 GB (not 50); Firefox Android mDNS is enabled (the gecko-dev mirror was stale); Cloudflare TURN free tier is 1,000 GB (pricing page 2026-09-22); "86 % direct" (2013) discarded | primary vendor pages and mozilla-central | R03 Appendix B |
| Every live tracker answered a real announce and relayed an offer and answer between two fake peers | `labs/02-wss-trackers-probes/relaytest.py`; re-confirmed 2026-10-17 by w1-12 e9 | R02 F1 |

---

## 5. Constraints discovered

### 5.1 Compatibility (browser facts with versions)

| Fact | Consequence | Source |
|---|---|---|
| Secure context required: torrent SHA-1 hashing uses `crypto.subtle` with no JS fallback; SWs need HTTPS or localhost; `bittorrent-tracker` silently skips `ws://` trackers on https pages | HTTPS static host is mandatory; `wss://` only | R01 F5 |
| WebTorrent 3.0.21 parse floor Chrome/Edge 85, Firefox 79, Safari/iOS 14.1; run floor without polyfills Chrome/Edge 140, Firefox 133, Safari 18.2 (`Uint8Array` hex/base64); `AbortSignal.timeout` Chrome 124 (103 partial), Firefox 100, Safari 16, Samsung 27; a missing `AbortSignal.timeout` makes every web-seed request fail silently | Polyfill first; v0.2 floor Safari/iOS 15.4, Chromium 110, Firefox 115 ESR | R01 F4; DESIGN-REVIEW item 16 |
| OPFS `getDirectory` Chrome 86, Firefox 111, Safari 15.2; native `createWritable` Safari 26 (earlier: blob module-Worker polyfill, needs `worker-src blob:`); `getDirectory()` throws in Firefox private windows | Own chunk store | R01 F4, F12, F14 |
| SW: Chrome 45, Firefox 44, Safari 11.1, iOS 11.3; Firefox private windows from 140 (ESR 128 never); module SWs Firefox 147+; SW static routing only Chrome 123 and Safari 27; transferable `ReadableStream` Chrome 87, Firefox 103, Safari 27; `Client.frameType` Chrome 43, Firefox 44, Safari 11.1; `WindowClient.ancestorOrigins` Safari 16+ only | Classic SW; keep the MessageChannel protocol for iOS 26 and older | R04 F15, F22, R3, G20, G22 |
| SW lifetime: Chromium 30 s idle, 5 min per event, an open stream keeps it alive; Firefox about 30 s plus 30 s, no keep-alive for open streams (bug 1302715), unregisters after 3 navigation faults; WebKit lifetime follows clients, 10 s delay, network fallback after 70 s for a SW-handled main-document navigation | No state in SW memory; ping at most every 20 s; answer navigations in under 25 s | R04 F13, R5 |
| Frames sandboxed without `allow-same-origin` are not SW-controlled (Chrome 155, Firefox 158, Safari 27) | Origin-only isolation | R04 F11 |
| WebRTC APIs: `RTCPeerConnection` Chrome 56, Firefox 44, Safari 11; `pc.sctp` and `maxMessageSize` Chrome 76, Firefox 113, Safari 15.4; `connectionState` Firefox 113; `restartIce()` Chrome 77, Firefox 70, Safari 14.1; `setConfiguration()` Firefox 99; `getSelectedCandidatePair()` Chrome 75, Firefox 154, Safari 16.4; none of them in workers or SWs | Feature-detect; use `getStats()` for candidate types | R03 F-18, F-37 |
| Data channels: Chrome and Safari advertise 256 KiB max message; Firefox accepts about 1 GiB locally but assumes 64 KiB when the remote omits the attribute; Chrome and Safari throw `OperationError` past 16 MiB `bufferedAmount` | 16 KiB frames | R03 F-25, F-26 |
| Caps: Chromium 500 live `RTCPeerConnection`s per renderer and 3,000 P2P sockets; WebKit closes the oldest RTC socket above 256 per web process; WebTorrent `maxConns` 55 limits only TCP dials, not WebRTC wires | Own wire cap in the `'wire'` handler | R03 F-31; ARCH 1 |
| mDNS host-candidate hiding: Chrome 76, Firefox desktop 74, Firefox Android from 149 (bug 1581947), Safari on by default; Chrome 142+ Local Network Access prompts may affect LAN peers | Headless tab-to-tab tests need `--disable-features=WebRtcHideLocalIpsWithMdns` | R03 F-16, F-19, F-20, F-23, F-39 |
| Safari Lockdown Mode: no `RTCPeerConnection`, no SW, no Cache API or CacheStorage, no Web Locks; IndexedDB flagged in source but not device-tested; WASM blocked even with a site exception since iOS 17.4 (WebKit 273824) | Host-only or degraded mode plus "Turn off Lockdown Mode for this website" | R03 F-21; R04 F15; R06 F26 |
| WKWebView in-app browsers have no SW (Apple, Feb 2025); App-Bound Domains allow at most 10 domains; iOS third-party browsers get SWs through the browser entitlement | Degraded mode or "open in Safari" | R01 F29; R04 F15 |
| Tor Browser: no WebRTC and no SW; Brave Tor windows throw `NotAllowedError` on `new RTCPeerConnection`; Brave's "Disable non-proxied UDP" removes UDP P2P; Brave hides host candidates and randomizes `hardwareConcurrency` | Host-only mode; cap worker pools explicitly | R03 F-24; R01 F32; R06 F28 |
| Ed25519 WebCrypto: Chrome/Edge/WebView 137, Firefox 129 (130 is X25519), Safari 17, Samsung Internet 30 (29 lacks it); P-256 since Chrome 37, Firefox 34, Safari 7; Safari Ed25519 signatures are randomized; `SubtleCrypto.supports()` only in Chrome 155 (experimental) | P-256 in v0.2; feature-detect with `generateKey` | R06 F45-F50 |
| `SharedWorker` only from Chrome Android 148 and absent on Samsung Internet; the Page Lifecycle `freeze` event is Chrome-only | Web Locks plus BroadcastChannel | R06 F22, F24 |
| Storage: Safari deletes IndexedDB, SW registrations and Cache after 7 days of Safari use without interaction (Home Screen apps exempt; their storage is separate from Safari; since iOS 26 Home Screen sites open as web apps by default); eviction removes the whole origin at once; Chromium headless quota 2 GiB with `persisted()` false; Firefox best-effort limit min(10 % of disk, 10 GiB) | `persist()`, identity export, Home Screen advice | R01 F12, F30; R04 F21; R06 F25 |
| Mobile lifecycle: iOS stops data-only WebRTC on background or lock; Android Chrome exempts pages with an open data channel from intensive throttling but Doze can still cut the network; Firefox Android clamps inactive-tab timers to 15 min and may unload the tab | Phones are foreground-only peers | R03 F-33 to F-36 |
| Safari probes media with `Range: bytes=0-1`; `Cache.put` rejects 206; `new Response(string)` is `text/plain`; `mime/lite` has no `.ico`, `.m3u8`, `.eot`, `.flac`, `.jxl`, `.srt`; Chromium leaks URL fragments into `event.request.url` on reload | Own MIME table, Blob slicing, strip `url.hash` | R04 F17, F18, G12 |

### 5.2 Operational

- **No SLA anywhere.** Trackers are volunteer or small-company services (R02 F4); Google STUN has only a 2014 forum statement
  (R03 F-07); Cloudflare DoH has no SLA and "limited" support, Google DoH has no SLA and about 1,500 QPS per IPv4 address
  or IPv6 /64 with 429 and `Retry-After` (R05 F6). Attrition is real: ten tracker hostnames died (R02 F1).
- **Tracker sockets:** idle closes after about 125 s (openwebtorrent), 134 s (webtorrent.dev), 184 s (ftorrent); nginx
  defaults to 60 s; the stock client reconnects after `10 s x 2^retries + U(0, 5 min)` and `announce()` is a no-op
  meanwhile; local DNS block lists can sinkhole tracker or broker names (R02 F10, G2, G5, G6).
- **Offer cost:** up to 5 `RTCPeerConnection`s per tracker per announce, trickle ICE off (each offer waits for full
  gathering, 5 s ICE timeout), about 5 s extra on UDP-blocked networks, offers expire after 50 s (R01 F7; R02 F8, F9).
- **Relays:** without TURN, failing pairs load from the host. TURN credentials expire hard (Cloudflare at most 48 h;
  Metered `expiryInSeconds` is a hard cutoff and new credentials take up to 2 min to propagate) (R03 G-09).
- **DNS:** create the TXT record before anyone visits (negative caching lasts min(SOA TTL, MINIMUM), measured 300-1,800 s);
  minimum TTL is 60 s on Cloudflare (30 s on Enterprise) and typically 600 s on Porkbun; Route 53 values reach 4,000
  characters in strings of at most 255; the Terraform AWS provider adds the outer quotes itself; enterprise networks
  block DoH hostnames; the first lookup costs 100-460 ms cold and 2-20 ms warm from one vantage point (R05 F7, F11, F12,
  F15, F16).
- **Static host:** the SW script must come from the page origin with a JS MIME type and a short cache; S3 website error
  documents answer 404, so an SPA-style fallback must return 200; purge CDN caches on deploy (a stale CDN copy bricked
  the IPFS SW gateway, issue #1155, July 2026) (R04 G13, G14, R6).
- **Self-hosted tracker:** `bittorrent-tracker` 11.2.3 never prunes swarms, never pings, accepts 100 MiB messages, keeps a
  1,000-peer LRU and trusts any `X-Forwarded-For` with `--trust-proxy`; `aquatic_ws` needs Linux >= 5.8, a memlock limit
  and (v0.9.0) Rust < 1.93; Oracle Always Free needs stateless rules (stateful ones drop new connections at about 40 k
  peers) and reclaims instances idle for 7 days (CPU p95, network and memory all under 20 %); Caddy reloads close all
  WebSockets unless `stream_close_delay` is set (R02 F13-F16, G7-G13).
- **Inbound wire memory:** `bittorrent-protocol` buffers any declared 32-bit message length with no cap (found after R01;
  ARCH 1 and 13 cap it at 256 KiB per wire).
- **Developer-machine network policy:** the research harnesses predate `docs/DEV-NETWORK.md`.
  `labs/01-webtorrent-lab/run-page.sh` launches the user's own Brave by default, without `--host-resolver-rules` (its WebRTC
  pages already pass `iceServers: []`); `labs/04-sw-experiment/server.mjs` launches whatever Chromium binary it is given,
  also without `chromiumArgs()`; the `labs/02-wss-trackers-probes/*.py` scripts contact public trackers, Nostr relays and
  MQTT brokers. Any re-run must launch Playwright Chromium with `chromiumArgs()` from `test/e2e/browser-args.mjs`, keep
  `iceServers: []` for loopback tests, and leave remote probes to the Node tools.

### 5.3 Legal and policy

- **Redistribution:** every visitor relays the site's files and other people's ledger entries while the page is open;
  liability and takedown were not researched in 01-06 (R06 3.2 #12, Q12; covered later by `w2b-06-abuse-legal-ops.md`).
- **Personal data exposure:** visitor IP and infohash reach peers, trackers, STUN operators and the DoH provider; Google
  DoH forwards the visitor's /24 to authoritative servers unless `edns_client_subnet=0.0.0.0/0` (R05 F13; R03 F-17).
  R03 R-11 drafted a disclosure "for legal review"; the final strings are DESIGN-REVIEW section 4.5.
- **Third-party terms:** no tracker operator publishes an abuse policy or forbids using trackers as a generic rendezvous
  (openwebtorrent: "free for anyone to use"); ftorrent publishes a circuit breaker (24 h of `503` above 200 M relayed
  offers per rolling 24 h) (R02 F4, F12, G22). Google STUN: free "for development purposes", commercial apps should
  "deploy your own" (2014). Cloudflare, Metered and Twilio acceptable-use terms for BitTorrent-style relayed traffic
  were not found (R03 G-11). Cloudflare and Google DoH terms do not forbid embedding but promise nothing (R05 F6).
- **Licences and provenance:** `webtorrent` is MIT with npm provenance (R01 F1); `@noble/ed25519` 3.x is not independently
  audited (v1 was, Cure53 2022) (R06 F49); smoldot is GPL-3.0-or-later with a Classpath exception, relevant only if a
  chain client were bundled (R06 G18); the ftorrent tracker is GPL-3.0 but is operated, not shipped (R02 F4).
- **Integrity:** BitTorrent v1 relies on SHA-1. Chosen-prefix collisions are practical (about 45k USD in 2020), so only
  the publisher could craft two contents for one infohash; a third party needs a second preimage (R01 F9).
- **Naming and registries:** `KayleePop/magnet-web` (MIT) already uses this name for the same idea (R04 F3); `_magnet`
  is not in the IANA underscored-names registry, whose bar is Expert Review (R05 F9, F10; w2c-06-VERIFY).

---

## 6. Open questions

Marked (device) when only real phones or browsers can answer; (local) when a 127.0.0.1 Playwright test can.

1. Does the 90 s `scrape` keepalive make `tracker.openwebtorrent.com` drop the socket every time, and what is the cheapest
   offer-free keepalive the stock client can send? (Node probe; R01 F8, R02 F1, R3; w2b-01 correction 5)
2. What is the real relay share by device class and network pair (iOS, Android, desktop; LTE-to-LTE; CGNAT), and so is a
   TURN tier needed? (device; R03 Q1, Q8; R02 Q8)
3. Lockdown Mode on iOS 26 and macOS 27: is IndexedDB off, do SWs "register with cut powers", and does the per-site
   exclusion restore WebRTC, SW and WASM? (device; R03 Q7; R04 Q1; R06 Q5; R01 F28)
4. How long do an open data channel and a tracker socket survive iOS background or lock, and does a Home Screen web app
   differ? (device; R03 Q3; R04 Q1; R06 Q4; R02 Q1)
5. What do Android Chrome, Samsung Internet and Firefox Android do to an open data channel on screen lock, with and
   without Wake Lock, Doze and battery saver? (device; R03 Q4)
6. Firefox and Safari SW timing: limit for a pending `respondWith`, streams without pings, hard-reload behaviour for
   iframes, `cancel()` propagation, first-visit iframe control, `resultingClientId`. (local and device; R04 Q1, Q2;
   DESIGN-REVIEW section 6)
7. Firefox and Safari extended-message limits in practice, and their web-seed preflight header sets (does `user-agent`
   join?). (local; R01 F10, F24)
8. Does a non-extractable P-256 key (v0.2) round-trip IndexedDB on real iOS 17, 18 and 26 in normal, private and Home
   Screen contexts, and what causes the iOS `DataCloneError`? (device; R06 Q1; DESIGN-REVIEW section 6)
9. Does Brave's Shields fingerprinting level change its WebRTC IP-handling policy (the wiki says yes, the code says no)?
   (device; R03 Q2)
10. Is Quad9's missing CORS on HTTP/3 intentional, and will it be fixed? (R05 Q2)
11. What are the rate limits and embedding terms of dns.sb, Control D, DNS4EU, AliDNS and Cloudflare at popular-site
    scale, and how does Google's per-IP limit behave behind mobile CGNAT? (R05 Q5, Q12)
12. Which iOS third-party browsers expose `navigator.serviceWorker` on iOS 26 and 27, and what do Samsung Internet Secret
    mode, Edge InPrivate and Brave private windows do? (device; R04 Q3, Q4)
13. Do the v0.2 validity rules satisfy Byzantine Eventual Consistency (model check), how do peers detect divergence, and
    what are realistic entries per site, bytes per entry and IndexedDB throughput on iOS? (R06 Q9, Q11, Q16)
14. Which swarm carries ledger gossip across releases: peers of the current site torrent only, or a stable rendezvous
    swarm derived from the ledger id? (R06 Q6; w1-12 measured crossed-offer problems with a one-piece anchor torrent)
15. What do a 16-bit mint over a 394-528 B header cost (median, p95, thermal throttling) on a mid-range Android phone and
    an older iPhone? (device; R06 Q3; w2b-04-VERIFY claim 5)
16. Does Oracle reclaim a lightly loaded tracker VM, and is the Cloudflare Durable Objects Free tier enforced as
    documented? (R02 Q2, Q3)
17. How long will the four public trackers survive, should operators get a courtesy note, and why is novage missing from
    ngosang's list? (R02 Q5, Q7)
18. Does iCloud Private Relay still leak the real IP through WebRTC STUN on current iOS? (device; R03 Q12)
19. Does Safari's 7-day rule apply unchanged in Safari 18, 26 and 27 (w2c-03-VERIFY adds: only while Prevent
    Cross-Site Tracking is on, per registrable domain)? (device; R06 Q17; R04 Q10)
20. Would a no-SW fallback renderer be worth more than "open in Safari" for Lockdown, Tor, in-app and old Firefox
    private windows? v0.2 already has a degraded mode; scope is the open part. (R04 Q9)
