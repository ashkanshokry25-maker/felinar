# W1 part B digest: prior art, mobile, magnet links, hosting, threats, signaling, toolchain

Digest date: 2026-10-19. Sources: wave-1 research files dated 2026-10-17. Internal engineering document, not
user-facing copy; it follows the wording rules of DESIGN-REVIEW section 4 (no em dashes, straight quotes).

## 0. Scope, sources, precedence

| File (`docs/research/`) | Size | Status | Contributes |
|---|---|---|---|
| `w1-07-prior-art.md` | 99 KB | final | why websites-by-hash systems stalled; what to copy and avoid |
| `w1-07-prior-art-VERIFY.md` | 65 KB | final | 8 design-critical claims re-checked: 2 confirmed, 6 nuanced, 0 refuted; SW takedown experiment |
| `w1-08-mobile-constraints.md` | 102 KB | final | lifecycle, memory, storage, polyfills, Mobile policy v1, minimum-browser matrix |
| `w1-09-protocol-handler-magnet.md` | 65 KB | final | `magnet:` handling, support matrix, link forms, QR, share target |
| `w1-09-protocol-handler-magnet-VERIFY.md` | 54 KB | final | 8 claims: 4 confirmed, 4 nuanced, 0 refuted |
| `w1-10-static-hosting-bootstrap.md` | 106 KB | final | hosts, web-seed CORS/Range/compression, SRI, CSP, caching, cost, phone demos |
| `w1-11-security-threats.md` | 109 KB | final | assets, adversaries, threats T1-T24, P0-P3 mitigations, legal summary |
| `w1-12-signaling-libs.md` | 90 KB | final | signaling libraries, wire-extension behaviour, rendezvous-swarm decision |
| `w1-13-toolchain.md` | 15 KB | **checkpoint draft**; the promised final version was never written | executed facts: create-torrent, magnet-uri, own bundle, Node seeder, Playwright, tracker server, padding |

**Missing topic.** Topic 14 (ops, legal, economics) was never researched in wave 1. Legal statements here
come only from w1-11 §D and scattered points in w1-07 and w1-10; economics only from the w1-10 §J cost model
and the w1-07 F12-F13 history of paid persistence. Wave-2 files on nearby ground exist
(`w2b-06-abuse-legal-ops.md`, `w2a-07-hosting-cost-bandwidth.md`, `w2c-07-incentives-economics.md`) but
are outside this digest and were not read for it.

**Method.** For each file: Summary, recommendations, gotchas and open questions, then specific findings
where cited. One local check was added on 2026-10-19: the vendored
`node_modules/webtorrent/dist/webtorrent.min.js` (3.0.21) contains 0 `BigInt64Array`, 1 `BigInt(`, and one each of `toBase64`, `toHex`,
`fromHex`; the source of `uint8-util` 2.3.2 does use `BigInt64Array` (used in 4.3 C10).

**Citation form.** `w1-10 F12` = finding F12 of that file; `§` = section heading; `R`, `R-`, `REC-` = that
file's recommendation IDs; `VERIFY` = the matching -VERIFY file; `ARCH` = docs/ARCHITECTURE.md v0.2;
`DR n` = item n of docs/review/DESIGN-REVIEW.md; `Bnn` = recommendation in section 3 of this digest.

**Precedence when sources disagree** (applied in 4.3):
1. A -VERIFY file beats its first pass.
2. An executed experiment beats spec reading, which beats vendor docs and secondary sources.
3. The topic-owner file beats a passing remark elsewhere (mobile numbers: w1-08; hosting: w1-10;
   security: w1-11; signaling: w1-12; executed toolchain facts: w1-13).
4. For a timing that bounds a safety mechanism (kill-switch reach, teardown), plan with the conservative
   figure until re-tested.
5. ARCH and DR stay normative. Where research contradicts them this digest names the amendment; product
   trade-offs are flagged as owner decisions, not settled here.

**Evidence limits shared by every file.** No real phone was used. Firefox never ran (Playwright Firefox 157
exits with "Could not find profile folder" on this Mac). Playwright WebKit 27.2 runs pages and Service
Workers but gathers no ICE candidates here, so there is no WebKit WebRTC result. All WebRTC timings are
loopback. The shared web-search budget ran out in every session, so open-ended searches are missing.

## 1. Executive verdict

1. **The web seed is the floor and peers are the accelerator.** Every stalled precedent (ZeroNet,
   Maelstrom, Beaker, PeerWeb, the paid pinning services) lacked always-on seeding; what survived (PeerTube's
   HLS plus P2P Media Loader, Shipyard's GitHub Pages plus CI) is origin-first. Make `ws=` and `xs=`
   mandatory in `publish`, race web seed and peers from t=0, document a pinner (w1-07 F21, R1, R2).
2. **Most static hosts break a stock WebTorrent web seed, in two independent ways.** WebTorrent's
   `Cache-Control` and `user-agent` headers force a CORS preflight that GitHub Pages (405), Netlify,
   Vercel, jsDelivr and cdnjs fail; and GitHub Pages and jsDelivr apply `Range` to compressed bytes, which
   WebTorrent turns into silent piece-hash failures (w1-10 Summary 2-5, F12). Stripping the two headers in
   our own bundle removed every preflight in Chromium 156 and WebKit 27.2 (w1-13 checkpoint 2).
3. **The origin is the only isolation boundary.** No sandbox variant isolates Service-Worker-served sites;
   one origin per untrusted site is where every serious gateway converged. The shared-origin hub is a demo,
   the v0.1 `SANDBOX_HUB`/`HUB_CSP` flags still in `src/` must go, and a multi-publisher hub needs a
   wildcard PSL entry on a separate registrable domain, although the PSL is not universal practice
   (w1-11 F1-F4, R2, R3; w1-07 F23; VERIFY claim 7).
4. **Only a new 200 worker script reaches an installed Service Worker.** Edge 404/410/5xx answers leave
   installed workers running and only stop new installs; a replacement or self-unregistering worker evicts
   at the next update check, for visitors who return online. DR 20's kill switch is right; its reach is
   limited and must be documented (w1-07 VERIFY claim 8, tested in Chromium and WebKit).
5. **Phones share only while visible, and iOS reports nothing about network, battery or memory.**
   Default to download-only on any network not proven unmetered, rebuild the client (not `resume()`) after
   more than 10 s hidden, cap mobile sites at 48 MiB (24 MiB metered), and treat Safari tab storage,
   identity key included, as a cache (ITP; `persist()` resolves false). ARCH §8 needs amending
   (w1-08 Summary 2-6, Mobile policy v1).
6. **The vendored WebTorrent cannot be constructed on about 8.5 % of web traffic** without the ES2026
   `Uint8Array` base64/hex methods; a 2.4 KB polyfill passing 78/78 test262 cases fixes it (P0). DR 16's
   declared floor (iOS/Safari 15.4, Chromium 110, Firefox 115 ESR) stands; test Tier 1 at iOS 16.4 and
   Samsung Internet 21; keep ECDSA P-256 keys (w1-08 F-03 to F-06, F-24, matrix).
7. **Signaling: keep `mw_chain1` on WebTorrent wires and add a bare-infohash rendezvous swarm.**
   Metadata-less wires work (15/15 local, 18/20 on live trackers); the one-piece anchor torrent of ARCH
   §5.5 fails when peers join together (0/15 local, 0/10 live) and never pairs on
   `tracker.openwebtorrent.com`. No Trystero, P2PT, bugout, upstream simple-peer, js-libp2p or Hyperswarm
   in v1. Enforce WebRTC connection caps ourselves, set `reqq`, never `throttleUpload(0)` (w1-12 F32).
8. **The security P0 list is short and concrete.** Read the wire length prefix unsigned and cap it before
   buffering (worst case 2 GiB-1, not 4 GiB); salt the redaction commitment before `block.js` freezes;
   keep key export and consent grant out of the site-callable SDK; give multi-publisher hubs a denylist
   and a takedown process. Bind the SHA-256 `files.json` to the signed pointer, because a SHA-1
   chosen-prefix collision now costs about $10k (w1-11 §4 P0, F7-F12, F28-F30, F38).
9. **`magnet:` links can be claimed only on desktop Chromium-family browsers and desktop Firefox.** The
   universal form is `https://<hub>/#btih:<hex>` plus a paste box and a QR code. `/#%s` keeps the magnet
   out of HTTP requests and host logs, but the Service Worker and any redirect target still see it
   (w1-09 Summary 2-5; VERIFY claims 5-8).
10. **Biggest unknowns:** real devices, Firefox, WebKit WebRTC, WAN timings, and the never-researched
    topic 14, so consent, takedown and the hub operator's role still need counsel. w1-13 is a draft.

## 2. Decisions

### 2.1 Decisions table

| Decision | Evidence | Source file § |
|---|---|---|
| D1. `ws=` and `xs=` are mandatory in `publish`; `--peers-only` prints "only loads while another visitor is online". | Every stalled system lacked always-on seeders; survivors are origin-first (PeerTube 6.0.0 removed its WebTorrent player; P2P Media Loader rides on HLS). | w1-07 F1, F5, F12, F21, §6 R1; VERIFY claim 4; DR 13 |
| D2. Fetch the routing manifest and entry HTML from the web seed at t=0, in parallel with the announce; never block first paint on discovery. | Beaker and PeerWeb first paint stalled on "Connecting to peers". | w1-07 F5, F19, §6 R2 |
| D3. Web-seed HTTP contract: OPTIONS 2xx with `Access-Control-Allow-Origin: *`, `-Methods: GET, HEAD, OPTIONS`, `-Headers: *` (or `range, cache-control, user-agent`), `-Max-Age`; `206` with identity bytes; no redirects; a missing path answers 403/404, never the SPA shell. | S3 `AllowedHeaders: ["Range"]` fails every request; Range over gzip bytes on GitHub Pages and jsDelivr; WebTorrent accepts any 2xx without checking `Content-Range`. | w1-10 Summary 2-4, F8-F12, REC-1 |
| D4. Web-seed stores: R2 on a custom domain, B2 behind Cloudflare (terms caveat), S3 + CloudFront with compression off. GitHub Pages, Netlify, Vercel, jsDelivr and cdnjs are unsupported as cross-origin seeds; a same-origin seed only if the seed doctor passes. | Measured OPTIONS and Range behaviour; zero-egress stores win the cost model by one to two orders of magnitude. | w1-10 F12, F20-F23, F34, REC-3 |
| D5. Bundle WebTorrent ourselves into the SRI-checked loader with four hash-asserted, exactly-once patches: length cap; drop `Cache-Control` and `user-agent` in `webconn.js`; drop `user-agent` in `_getMetadataFromServer` and in parse-torrent `remote()`. | `import()` has no integrity option; the patched bundle gave zero preflights in Chromium 156 and WebKit 27.2 and still transferred a torrent; with stubs it is 219-226 KB raw against the official 223 KB. | w1-10 F28-F29, REC-5, REC-7; w1-13 checkpoint 2 |
| D6. Shell layout: root `index.html`, `404.html`, `/mw-sw.js`, manifest `no-cache` and invalidated on deploy; everything else under `/v/<build-id>/` as `immutable`; precache in normal cache mode; required and optional precache lists. | CDN edges hold stale workers (24 h CloudFront default); `cache:'reload'` doubles first-visit shell; a missing required asset breaks offline silently. | w1-10 F31-F33, REC-6; DR 20 (worker name) |
| D7. One origin per untrusted site; the shared-origin hub is a localhost demo or single-publisher mode behind the gate. | Sandbox flags cannot isolate SW-served content; `allow-scripts allow-same-origin` is inert; ZeroNet and PeerWeb paid for shared origins. | w1-11 F1-F3, F5; w1-07 F2, F19, F23; DR 6 |
| D8. Multi-publisher hubs: site origins on a separate registrable domain, wildcard PSL entry (MUST), wildcard certificate on a host with wildcard routing, no cookies on the apex. | Without the PSL, sibling subdomains are same-site; one reported site can get the whole domain flagged. | w1-11 F3-F4, R3; w1-10 F24-F25; w1-07 VERIFY claim 7 |
| D9. Hub labels: one DNS label of at most 63 octets; base32 (52 chars) of the full 32-byte digest; never hex of 32 bytes. | RFC 1035 limit; ar.io's 52-char labels are production proof; IPFS answers HTTP 400 above 63. | w1-07 F23, R4; VERIFY claim 7 |
| D10. Kill switch = a 200 self-unregistering `/mw-sw.js` through the update path; an edge 404/410/451 only stops new installs. | Experiment in Chromium 156 and WebKit 27.2; IPFS removed its worker TTL in July 2026. | w1-07 VERIFY claim 8; DR 20; w1-11 F37 |
| D11. Ledger rendezvous = bare infohash `sha1("mw-ledger/1/" + ledgerId)` announced with `left: 1`, never seeded; the one-piece anchor torrent is dropped. | 15/15 local, 18/20 live; the one-piece torrent connected 0/15 and 0/10 when joining together and never on openwebtorrent. DR S1 already allowed this if wires stay open; they do (140 s idle). | w1-12 F20-F25, R1-R2; DR S1, DR §6 |
| D12. Gossip stays on `mw_chain1` over content and rendezvous wires; no Trystero, P2PT, bugout, upstream simple-peer, js-libp2p or Hyperswarm in v1; a Nostr plane is an optional P2 adapter. | Trystero 0.26.0 changed its wire format and has no room cap; bugout is abandoned; browser libp2p needs relay servers at 2x WebTorrent's size; `dht-relay` archived 2026-10-15. | w1-12 F1-F12, F28-F32 |
| D13. The loader enforces WebRTC connection caps in the `wire` handler and advertises `reqq`; uploads off = choke lock; never `throttleUpload(0)`. | `maxConns: 2` still gave 4 wires; rate 0 froze 0/30 frames on every wire of the client; head-of-line p50 0.5-0.7 s and p99 up to 4.3 s without `reqq`; median 3-14 ms with it. | w1-12 F15-F18; ARCH §1 |
| D14. Wire length prefix read unsigned and capped at 256 KiB before buffering; buffer watchdog; `ut_metadata.cancel()` on rendezvous wires. | A `0x7FFFFFFF` prefix gives quadratic CPU and 8 GiB RSS; a hostile `metadata_size` costs 10 MB and 1,833 requests per wire. | w1-11 F11-F12; w1-12 F14, F20a |
| D15. Bind `/.mw/files.json` SHA-256 to the signed pointer (`fj=`) and verify files against it. | SHA-1 chosen-prefix about $10k; webtorrent has no BEP 52. | w1-11 F7-F10, R10 |
| D16. Salted redaction commitment; salt dropped with the payload; never reuse the Hashcash nonce. | EDPB 02/2025 v2: a hash of personal data is personal data; an unsalted hash is not sufficient. | w1-11 F28-F30, R4 |
| D17. The site-callable SDK has no `identity.export`, `identity.import` or `consent.accept`; loader-owned UI only. | In per-domain and drop-in modes site code runs with loader privilege. | w1-11 F38, R5 |
| D18. Consent before the first announce also covers the DoH lookup (or an explicit `dns=1`). | DoH sends the visitor IP and the hostname to a third party outside the gate. | w1-11 F18, F32, R6 |
| D19. Pointer authenticity = owner signature + pin; on a first visit, `<meta>` and DNS carrying different owner keys is a hard stop. | `AD` means something only over a secure channel to a trusted resolver. | w1-11 F31-F32, R13 |
| D20. Mobile: download-only unless proven unmetered; opt-in sharing per origin; rebuild after more than 10 s hidden; explicit memory-bounded store; 48/24 MiB caps. | iOS gives no signals; suspension within 5-20 s; tracker reconnect median 171 s; peak memory 2.7x site size. | w1-08 F-07 to F-17, F-31, §Mobile policy v1 |
| D21. Browser floor = DR 16 (iOS/Safari 15.4, Chromium 110, Firefox 115 ESR) with base64/hex and `AbortSignal.timeout` polyfills first in `boot.js`; Tier 1 tests on iOS 16.4, Chromium 110, Firefox 115 ESR, Samsung Internet 21. | Construction fails without the methods; the polyfill passes 78/78 test262 cases on V8 and JavaScriptCore. | w1-08 Summary 1, 9, R-01, §Minimum-browser matrix; DR 16 |
| D22. Keep ECDSA P-256 identity keys; no X25519 keys in IndexedDB without a wrapped-JWK fallback. | Ed25519 needs iOS 17, Chrome 137, Samsung 30; X25519 fails the IndexedDB round trip in WebKit (bug 312279). | w1-08 F-24, F-32, R-07 |
| D23. Magnet links: universal form `https://<hub>/#btih:<hex>`; handler template `/#%s`; opt-in registration only on the hub apex, on desktop, from a click; never auto-load. | Only desktop Chromium-family and Firefox support the API; Firefox Android has a no-op method; the fragment stays out of requests but not out of the SW. | w1-09 §2, F1-F9, F19-F20; VERIFY claims 5-8; w1-11 T2 |
| D24. Phone demos only over HTTPS or localhost forwarding, with the tracker proxied as `wss://` on the same server; agent-run tests stay on 127.0.0.1. | LAN `http://` is not a secure context (no SW, no `crypto.subtle`); DEV-NETWORK policy. | w1-10 F35-F37; docs/DEV-NETWORK.md |

### 2.2 Prior-art lessons, one line each

| System | Lesson for magnet-web | Source |
|---|---|---|
| ZeroNet | A shared local origin plus wrapper produced repeated sandbox escapes, and "visitors host everything" plus a central ID issuer (ZeroID) invited spam; use per-site origins, bounded hosting, per-site keys. | w1-07 F1-F3; VERIFY claim 6 (at least nine labelled security entries 2016-2019, at most five are wrapper escapes; creator active until 2020-12/2021-01) |
| Project Maelstrom | A custom browser that seeded invisibly, with no update path, died with its funding; no install, visible seeding, mutable pointer. | w1-07 F4 |
| Beaker / Dat | Its own post-mortem: no stickiness, slow first paint, nobody online, "don't bloat your MVP"; measure first paint and keep the loader small. | w1-07 F5; VERIFY claim 5 (the 100k-user ceiling is a guess about local indexers) |
| Pear / Holepunch | The answer to "nobody online" is always-on "blind peers"; that is our pinner. | w1-07 F6 |
| Brave native `ipfs://` | Used by under 0.1 % and removed in 2024 (three stated reasons); do not invest in native-protocol UX. | w1-07 F7; VERIFY claim 1 |
| IPFS public gateways | Traffic came through HTTPS, yet 9.4 % of requests were browsers loading pages and 67.4 % automated clients (3-day vendor sample); an open hub becomes a free CDN unless rate-limited. | w1-07 F9; VERIFY claim 1 |
| IPFS SW gateway (inbrowser.link) | Static bootstrap + SW + in-browser verification + one origin per site works technically and is fragile organisationally (sponsor ended 2026-09-30); it never seeds and has no WebRTC, so it is no precedent for the P2P half. | w1-07 F8, F10; VERIFY claims 2-3 |
| Paid persistence (Skynet, Cloudflare gateway, Scaleway, NFT.Storage, Fleek, Shipyard) | Hosted persistence keeps closing; keep the owner's own static host in the loop. | w1-07 F12; VERIFY claim 4 (dates are announcement or transition dates) |
| Gateway abuse (Fleek, Skynet, Shipyard) | Shared gateway domains attract phishing; hubs need abuse operations from day one. | w1-07 F11, F13; VERIFY claim 8 (figures are scoped vendor telemetry) |
| Arweave + ar.io | Pay-once immutable storage (about US$82/GiB retail incl. fees) behind a resolver you must trust; copy the base32 sandbox labels and Wayfinder's fail-open/fail-closed vocabulary. | w1-07 F14; VERIFY claims 4, 7 |
| Swarm | Postage stamps expire like rent; no browser-resident node. | w1-07 F15 |
| ENS + eth.limo, DNSLink | A resolving gateway is a trusted middlebox (5 min cache, HTTP 451 takedowns); copy DNSLink's TXT rules: dedicated `_name`, ignore bad records, deterministic sort, CNAME delegation, about 60 s TTL. | w1-07 F16 |
| Peergos | Needs a server per user; outside our model. | w1-07 F17 |
| Freenet / Hyphanet | Local node plus a hosted on-ramp that its authors call a trust trade-off; alpha. | w1-07 F18 |
| peercloud (2015) | CSP-sandbox opaque origins break cookies and XHR; no WebRTC in a SW means a tab must stay open. | w1-07 F19; VERIFY claim 7 |
| Planktos (2017-18) | Hobby SW loader, no streaming or sharding, "not recommended for production". | w1-07 F19 |
| PeerWeb (2025-26) | Our shape: a same-origin iframe plus DOMPurify is not isolation; demos stuck on "Connecting to peers"; one tab reportedly reached about 15 GB. | w1-07 F19 |
| Bugout / P2PT / Trystero | Same gossip idea; default endpoints died (`hub.bugout.link`, `tracker.btorrent.xyz`) and WebTorrent 2.x broke bugout; never depend on one free sponsored endpoint. | w1-07 F20; w1-12 F9-F11 |
| PeerTube WebTorrent player | Removed in 6.0.0 ("the P2P aspect ... is not really used"); P2P lives on under HLS with the origin first. | w1-07 F21 |
| nsite (NIP-5A, draft) | Signed manifest plus hash-addressed blobs, but only server gateways exist; copy the order-independent aggregate hash. | w1-07 F22 |
| instant.io, qBittorrent WebUI | Both register a `magnet` handler with a fragment template; instant.io's register-on-every-load is the anti-pattern. | w1-09 F22; VERIFY claim 5 |

### 2.3 Mobile policy: ARCH v0.2 §8 against w1-08 Mobile policy v1

w1-08 classes: `desktop`, `mobileUnmetered` (Chromium reports wifi or ethernet), `mobileUnknown` (iOS,
Firefox Android, most WebViews), `mobileMetered` (cellular, bluetooth, other, mixed, none, or `saveData`).
ARCH has three columns (desktop; Wi-Fi confirmed; unknown, cellular or saveData).

| Setting | ARCH v0.2 §8 | w1-08 v1 (desktop / unmetered / unknown / metered) | Digest call |
|---|---|---|---|
| maxConns (content wires) | 30 / 10 / 6 | 30 / 8 / 6 / 4 | w1-08 (each connection adds ICE consent timers, F-13); rendezvous wires come on top (w1-12 R4: 6/9 desktop, 3/5 mobile), so the combined budget is open (6.1) |
| tracker `numwant`; tracker URLs | not set (default 5) | 5 / 3 / 3 / 2; at most 2 trackers on mobile | w1-08, with w1-12 R7: on mobile pick 2 trackers that pair seeders |
| Upload default | on 1 MiB/s / on 256 KiB/s / off until "Share on this network" | on 1 MiB/s / off (on only while charging) / off / off | w1-08 on evidence (Delivery Optimization defaults, no iOS signals); **owner decision**. w1-08's least-bad alternative: on at 32 KiB/s with 8 MiB per visit while visible |
| Upload after opt-in | shaping only at 32 KiB/s or more | 128 KiB/s; not offered on metered (Advanced override) | w1-08 |
| Upload budget per visit / month | none | none / 64 MiB / 64 MiB / 0, and 256 MiB per origin per month on mobile | w1-08, P2 (proposal, not measurement) |
| maxSiteBytes | 128 / 48 / 24 MiB | 128 / 48 (64 if `deviceMemory >= 4`) / 48 / 24 MiB | w1-08 (peak about 95 MB + 2.7x site size, F-17) |
| Ask before downloading more than | no | never / never / 16 MiB / 8 MiB | w1-08 |
| Hidden | desktop keeps seeding (destroy after 10 min hidden on battery); mobile destroys the client | desktop unchanged; mobile locks uploads at once | either; keep ARCH's flush of `meta` on hidden |
| Rebuild on return | visible after more than 60 s, `online`, `pageshow.persisted` | visible after more than 10 s, `online`, `pageshow.persisted`; never `tracker.update()` | w1-08 (iOS suspends within 5-20 s; reconnect waits `10 s x 2^n + U(0, 5 min)`) |
| Site cache budget | 512 MiB desktop / 128 MiB mobile | 1 GiB / 256 / 256 / 128 MiB | keep ARCH (w1-08 says its numbers are defaults, not evidence) |
| Ledger load budget | 50,000 blocks; `maxChainBytes` for snapshots | `maxLoadedBytes` 128 MiB desktop / 32 MiB mobile, newest first | add w1-08's (50,000 x 16 KiB = 781 MiB, past an iPhone's about 1.5 GB tab limit) |
| `persist()` | requested after consent | only from a user gesture; false in every Safari tab | request from the consent click; never at load for stored consent (Firefox prompts) |

Wording knock-on: DR 4.5's notice says "On Wi-Fi your browser also shares this site's files". Under w1-08
that is false on phones by default; the phone line in DR 4.3 ("On mobile data: downloading only. Tap to
share.") would need a variant for unknown networks.

## 3. Prioritised recommendations (merged and deduplicated)

Priority: P0 = before any public build or before the named interface freezes; P1 = before calling v1
production-ready; P2 = soon after; P3 = optional or watch. Effort (digest scale): S = up to a day, M = two
days to a week, L = more. w1-07 used a coarser scale (S = days, M = 1-3 weeks); its items were converted.
Where sources gave different priorities for the same work, the higher one wins unless the row says why not.

### P0

| ID | Eff | Recommendation | Justifying file(s) |
|---|---|---|---|
| B01 | S-M | **Wire guard.** Wrap `_onMessageLength` per wire before the handshake completes (or patch it in our bundle, B14): read the prefix unsigned (`>>> 0`), destroy above 256 KiB before buffering; buffer watchdog above the cap (digest call 512 KiB, see 4.3 C13) with a unit test that fails if the private `_bufferSize` disappears; `wire.ut_metadata.cancel()` on rendezvous wires; attach `mw_chain1` only to `webrtc` wires and send only when `peerExtendedMapping.mw_chain1` exists; frames at most 15 KiB. Replace the "4 GiB" tests (ARCH §12 test 11) with `0x7FFFFFFF`, `0xFFFFFFFF` and a 300 KiB message; assert destroy within 1 s, flat heap, bounded CPU. Report upstream privately first (no advisory exists). | w1-11 F11-F12, R1, R21; w1-12 F13-F14, F20a, R5; w1-13 checkpoint 2 |
| B02 | M | **Connection and upload discipline.** Soft and hard caps per swarm in the `wire` handler after the extended handshake (content from policy; rendezvous 6/9 desktop, 3/5 mobile), lowest score dropped first, `numwant` driven to 0 at the soft cap, peers counted by unique `peerId` excluding web seeds. Uploads off = choke lock; never `throttleUpload(0)` or `uploadLimit: 0`; test that gossip flows at 256 KiB/s and while paused. | w1-12 F15, F18, F27, R4, R6; ARCH §1, §8; DR 19 |
| B03 | S-M | **Ledger rendezvous swarm.** `client.add(sha1hex("mw-ledger/1/" + ledgerId), { announce: <the site torrent's exact list>, getAnnounceOpts: () => ({ left: 1, numwant: clamp(soft - wires, 0, 3) }) })`, never seeded; 0-1.5 s join jitter; glare watchdog (peers exist but no wire after 20 s: re-announce with jitter, at most 3 times; also when a wire closes below the soft cap); `reqq` on content wires `clamp(round(limitBps * 0.25 / 16384), 4, 32)`, 8 on rendezvous wires; bulk `BLOCKS` only on rendezvous wires. Rewrite ARCH §5.5, close ARCH §14 and DR §6 items. | w1-12 F16-F17, F19-F25, R1-R3; DR S1 |
| B04 | M | **Web-seed contract, seed doctor, host policy.** Publish D3's contract with exact JSON for S3, R2, B2, CloudFront and say `["Range"]` fails. `tools/check-webseed.mjs` plus a once-per-session loader probe: OPTIONS with `Access-Control-Request-Headers: cache-control,range,user-agent`; ranged GET with `Accept-Encoding: gzip, br` must give 206, no `Content-Encoding`, `Content-Range` total = file length; no redirect; missing path 403/404; also probe the `xs=` `.torrent` URL with WebKit's header set. A failing seed is not added, the UI names the failed check, and a dead seed is marked after the first CORS failure instead of the per-piece 10 s retry loop. Host policy as D4. | w1-10 F8-F12, F20-F23, REC-1 to REC-3; w1-13 xs table; w1-11 R26 |
| B05 | M | **Cold start and availability.** `publish.mjs` refuses a pointer without both `ws=` and `xs=` unless `--peers-only`; the loader races web seed and peers from t=0, stays web-seed-only if no peer within 3 s, and exposes source, TTFB and first paint in `site.info()`; document the pinner (`pin.mjs`) and three always-on options. Node 24 + webtorrent 3.0.21 seeds browsers without extra packages, but Node-side signalling costs a fixed 5.0 s per offer and glare (#401) dropped the working connection in the lab, so test the pinner's pairing before relying on it. Depends on B04. | w1-07 F5, F19, F21, R1, R2; w1-13 Node seeder; DR 13 |
| B06 | S | **Polyfills and floor.** Install the base64/hex polyfill and `AbortSignal.timeout` first in `boot.js`, self-test with w1-08's vectors, fail like a missing feature; record DR 16's floor and w1-08's Tier 1 matrix in `config.js` and README; the vendored or self-built bundle must pass esbuild at the declared target plus an API grep list that includes `BigInt64Array` (absent from the official bundle, present in `uint8-util` source). | w1-08 F-03 to F-06, R-01; DR 16; local grep (section 0) |
| B07 | M | **Mobile defaults and lifecycle.** The four-class classifier (drop `mozConnection`/`webkitConnection`); uploads off by default on every mobile class with a per-origin opt-in (pending the owner decision in 2.3); on hidden record the time and lock uploads; on visible after more than 10 s, `online` or `pageshow.persisted` destroy and rebuild the client (fresh tracker client) and re-attach the ledger node, rendezvous swarm included; never use `tracker.update()` as recovery; compare timestamps, never timers. | w1-08 F-07 to F-15, F-31, R-02, R-03; ARCH §8 |
| B08 | S | **Honesty copy, one pass.** Mobile: "Sharing only while this page is open and on screen"; no offline promise on iOS ("saved on this device until Safari clears it"). Magnet links: "Opt-in on desktop Chrome, Edge, Brave and Firefox only; never on iOS, Android or Safari. Share `https://<hub>/#btih:...` links; they work everywhere." Availability: "available whenever your web seed or a pinner is up; peers add speed". Demos: HTTPS or localhost forwarding only (fix ARCH §11). Never "uncensorable" or "impossible to shut down". Reuse DR §4 strings where they exist. | w1-08 R-04; w1-09 R1; w1-07 R1(c), §4 Avoid 5; w1-10 F35, REC-4; DR §4 |
| B09 | S | **Remove the v0.1 hub flags.** Delete `SANDBOX_HUB` and `HUB_CSP` (`allow-scripts allow-same-origin`); shared-origin hub only as a localhost demo or single-publisher mode behind the gate, never auto-loading from `#magnet:`, `?mw=` or the handler. This also removes the hosted-site `registerProtocolHandler` exposure. | w1-11 F1-F2, F6, R2; w1-09 F19, VERIFY §9 item 6; DR 6 |
| B10 | M | **Launch conditions for a multi-publisher hub** (skip if none ships in v1). Separate registrable domain for site origins; wildcard PSL entry submitted early; no apex cookies; wildcard certificate on CloudFront/ACM, Vercel or a Cloudflare Worker route; refuse IP-literal and non-label hosts; a unit test that every hub label is one DNS label of at most 63 octets, base32 for 32-byte ids. Abuse operations: double-hashed denylist over label and btih checked at the gate and at boot, gate shows `ws=`/`xs=` hosts, report link, abuse contact, `security.txt`, written takedown process, rate limits for non-browser clients, a cost model before opening the hub, counsel review. w1-07 R6 was P1; folded here because w1-11 R7 makes hub abuse operations P0. | w1-11 F3-F4, F20-F21, R3, R7; w1-07 F9, F11, F23, R4-R6; VERIFY claims 7-8; w1-10 F24-F25 |
| B11 | S | **Kill switch with honest reach.** Keep DR 20's self-unregistering `/mw-sw.js`; add an unregister URL parameter; test as VERIFY did (200 replacement evicts; 404/410/5xx never evict; first installs fail on 410). Document reach: returning visitors who navigate online, at the next update check (plan for up to 24 h, 4.3 C2). Hub per-label workers must re-fetch code the hub controls (shim plus apex worker). Re-test after every hosting change (the IPFS Pages move silently dropped edge enforcement). | w1-07 VERIFY claim 8, §10; w1-07 R5(a); DR 20; w1-11 F37 |
| B12 | S-M | **Interface freezes.** Before `block.js` freezes: `vh = sha256("mw-vh-v1\n" + z + canonical(v))` with a fresh 128-bit `z` carried beside `v` and dropped with it on tombstone; tests that a stub reveals nothing guessable without `z`. Before the SDK freezes: remove `identity.export`, `identity.import`, `consent.accept` from site-callable `window.mw`; loader-owned UI (closed shadow root, `isTrusted`, transient activation); add `mw.consent.request()`. | w1-11 F28-F30, F38, R4, R5 |
| B13 | S | **Arrival safety minimum.** Confirm that `parseFragment` (app.js) decodes once and only for encoded-scheme fragments (VERIFY says it did at 2026-10-17 18:06 ET) and keep tests for handler-built links, literal links, a tracker with `?key=a&b=c`, and encoded `=`/`%`. Nothing that arrives by fragment, handler, share target or paste loads without an explicit click. | w1-09 F3-F4, R2; VERIFY claims 3-4; w1-11 T2, R2 |

### P1

| ID | Eff | Recommendation | Justifying file(s) |
|---|---|---|---|
| B14 | M | **Own WebTorrent bundle.** esbuild with the package `browser` map applied globally, `path-esm`, `process-fast`, `events` installed, stubs for create-torrent, `lib/server.js`, fsa-chunk-store; the four exactly-once patches of D5 with input and output sha384 asserted; target = declared floor; bundled into `loader.js` so one SRI-checked file covers it. Effect: zero preflights in Chromium and WebKit, and WebKit `xs=` works against hosts that only send `ACAO: *`. Propose the header change upstream. | w1-10 F28-F29, REC-5, REC-7; w1-13 checkpoint 2 |
| B15 | M | **Versioned shell.** D6 layout; required vs optional precache; `build.mjs --host=<aws, cloudflare, ghpages, netlify, vercel>` writes header and redirect files from one source; explicit `Content-Type` on upload (a `binary/octet-stream` worker is rejected); invalidate root paths. | w1-10 F31-F33, REC-6; DR 20 |
| B16 | M | **Reference AWS deployment.** Private bucket with Block Public Access and versioning, OAC, CloudFront behaviours and Function, ACM in us-east-1 (apex + wildcard), Route 53, response-headers policy, optional `seed.` distribution; state that nothing was tested end to end. | w1-10 F1-F7, REC-8 |
| B17 | S | **Harden `publish.mjs`.** Pass create-torrent an explicit sorted file array (directory input drops every dot-path, `.mw/` and `.well-known/` included); exempt `.mw/` and `.well-known/` from the dotfile ignore list; pinned non-zero `creationDate` as a `Date`; never set `private` (even `false` changes the infohash); always pass an explicit tracker list (the default includes the dead `tracker.btorrent.xyz`); reject paths with `#`, `?`, `%`, backslash, control characters, edge spaces; torrent name `<dn>-<8 hex>` so seed objects can be `immutable` (this conflicts with ARCH §3.4.1 "fixed `name`" if that means constant across versions, see 4.3 C23); print upload commands with immutable headers and the next `check-webseed` command. | w1-13 create-torrent; w1-10 F8, REC-9; ARCH §10 |
| B18 | M | **Pointer integrity and keys (before the v1 grammar ships).** `fj=` with first-serve verification of `files.json` and each file; `rot` input `"mw-rot-v1\n" + scope + "\n" + old + "\n" + new + "\n" + seq`; pre-rotation `nk=` in pointer and genesis; `keygen.mjs --recovery`. | w1-11 F7-F10, F24, F26-F27, R10-R12 |
| B19 | S-M | **Verified serving (ARCH 7.1/7.3 as written).** `frame-ancestors`, 302 for top-level `/_mw/s/...`, `sha1(bencode(info)) === btih` and every piece verified before first serve or upload; E2E: a flipped byte in IndexedDB triggers `deleteSite`. | w1-11 R14 |
| B20 | S | **Consent completeness.** D18; consent stored per origin with timestamp and notice version, revocable; equal-weight first-layer choices pending counsel; `persist()` only from a gesture. | w1-11 F16-F18, F32, R6; w1-08 F-21, R-08 |
| B21 | M | **Peer abuse controls.** Upload request queue cap per wire (64-128), request rate limit, wires per IP and per /24; poisoned-piece attribution with 3 strikes per session and a web-seed preference after 2. | w1-11 F13, R8, R9 |
| B22 | M | **Mobile memory and storage path.** Explicit chunk store (never fsa-chunk-store), per-file Blobs on `file.on('done')`, caps from 2.3, `maxLoadedBytes` for the ledger, IndexedDB wrapper (short transactions, reopen on close, retry once, commit before hidden), Safari private-session probe with an ArrayBuffer fallback and a "Private window" message. | w1-08 F-16 to F-23, F-32, R-05, R-06, R-09, R-21 |
| B23 | M | **Identity durability.** Export and import of the P-256 identity in loader-owned UI only (B12); "first time on this device" when a pin is missing; device test of the non-extractable key round trip; iOS Home Screen hint after a first successful load. | w1-08 F-20 to F-24, R-07, R-08; w1-11 R5 |
| B24 | S-M | **Degraded path.** Select degraded mode when `!('serviceWorker' in navigator)` OR `navigator.serviceWorker.ready` has not resolved within a timeout (with SWs blocked the API exists and `register()` resolves); "Open in Safari / Chrome" with a one-line cause; UA hints only for wording. | w1-08 F-25, F-26, F-28, R-10; w1-13 Playwright facts; DR 17 |
| B25 | S-M | **Link UX and fragment hygiene.** Paste box and Paste button on the hub landing; arrival interstitial (name, btih, tracker hosts, `ws`/`xs` hosts, size, `index.html` present, explicit "Open as website") with a "not a website torrent" path that never sets `location = 'magnet:...'`; the SW never logs, caches by or forwards a full navigation `request.url`; no redirects in front of the hub (fragments survive redirects). | w1-09 F18-F20, R3, R5; VERIFY claim 5; w1-11 F21, F33 |
| B26 | S | **Manifest CI guard.** Derive `scope`, `start_url` and handler URL from one deploy base; root-relative or absolute `protocol_handlers` URLs (relative ones resolve against the manifest URL); fail CI on any `Page.getAppManifest` error. | w1-09 F11, R6; VERIFY §9 item 2 |
| B27 | S | **Third-party endpoint monitoring.** Scheduled Node probes (never a browser on the dev machine) of trackers (liveness and seeder-pairing scenarios S1-S5), STUN and DoH JSON; open an issue on change; keep at least 3 per class and at least 2 trackers that pair seeders; UI "discovery degraded" below 2 answering trackers. The e9-style live browser test needs a runner outside DEV-NETWORK's scope. | w1-07 F8, F20, F25, R3; w1-12 F21, F25, R7; DEV-NETWORK.md |
| B28 | S | **Frame versioning that never disconnects.** Byte 0 = type, byte 1 = generation; unknown generations ignored without a strike; keep `mw_chain1`, reserve `mw_chain2`. | w1-12 F4, F11, R8 |
| B29 | M | **Regression suite from the labs.** w1-12 e1, e1x, e3 (reduced), e4, e5, e7, e8, e11, e12; w1-08 polyfill vectors and the WebKit non-persistent-context case; w1-10 broken-seed fixtures (gzip ranges, 200 ignoring Range, SPA 200, 301, no ACAH); w1-07 VERIFY's SW takedown lab; the IPFS SW gateway bug list (never HTTP-cache 5xx or 206, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, Range and Save As, missing precache = 404); 8-hour soak with a heap threshold. WebRTC cases in Chromium only (no ICE in Playwright WebKit here). | w1-12 R9; w1-08 R-01, R-21; w1-10 REC-1, REC-2; w1-07 R8, R9; VERIFY §8; w1-13 |
| B30 | S-M | **Supply chain.** `ignore-scripts`, `npm ci`, `build.lock.json` pins (webtorrent 3.0.21, bittorrent-protocol 5.0.9); CI fails when the set of packages with install scripts changes; `overrides: { "node-datachannel": "0.33.4" }` for Node seeding (0.32.3's install script uses deprecated prebuild-install); document `ip@2.0.1` (Node tools only; do not downgrade webtorrent) and `ip-set`'s preinstall `npx only-allow pnpm`. | w1-11 F36, R15, gotchas 18-19; w1-13 node-datachannel |
| B31 | S-M | **HTTPS dev tooling.** `dev-server.mjs --https` reverse-proxying `/tracker` as a WebSocket; `npm run demo` prints Android USB forwarding and mkcert steps; tunnels and tailnet serving are owner-run, never agent-run. | w1-10 F35-F37, REC-4; w1-13 tracker TLS; DEV-NETWORK.md |
| B32 | M-L | **One-command migration.** `npx magnet-web publish ./dist --domain example.com`, a GitHub Action around publish and check-webseed, DNS writers for Cloudflare and Route 53 with restricted tokens and a CNAME-delegated `_magnet` record, PR-preview pointers, torrent creation in the owner's CI. | w1-07 F12, F14, F16, R7 |
| B33 | S | **Normative doc amendments in one PR.** ARCH §1 (BigInt64Array, fsa-chunk-store range, 31-bit length, preflight facts, `maxConns`, HOL, `reqq`), §5.5, §8 (2.3), §11, §12 test 11, §13 (shell integrity, meta CSP limits), §14; INTERFACES `addAnchor`, `wire-ext.js`; DR §6 items; browser-mobile review m7(b) (Brave no longer ships WebTorrent). | w1-10 App F; w1-11 §7; w1-12 R12; w1-08 App B; VERIFY (w1-07) §9; VERIFY (w1-09) §11 |

### P2

| ID | Eff | Recommendation | Justifying file(s) |
|---|---|---|---|
| B34 | M | **Optional Nostr discovery plane** (lazy, only when the rendezvous swarm has 0 wires after 20 s or every tracker socket failed; pinned `@trystero-p2p/nostr@0.26.0` or an own 200-line NIP-01 client; SDP wrapped with a key derived from the owner public key; local relay in CI). Record the "no" decisions with revisit triggers. | w1-12 F28, R10, R11 |
| B35 | S | **Mobile refinements.** Battery-aware sharing on Chromium (`!charging && level < 0.30` disables), upload budgets, `numwant` 3/2, at most 2 trackers, `connection.change` reactions, publish-time mobile budget lint (total, five largest files, class fit). | w1-08 R-11 to R-14, R-20 |
| B36 | L | **Prioritised partial download.** Deselect everything, mark the entry set critical, render when it verifies, fetch the rest on demand through the SW Range path. | w1-08 R-19 |
| B37 | M | **Real-device matrix and per-release manual QA.** iPhones on iOS 16.x to 27, iPad, Android 2-3 GB RAM and recent, Samsung 29/30, Firefox Android, Brave Android, in-app browsers; installed-PWA protocol launch; Firefox 160 "Never allow"; QR scans. | w1-08 R-15, Q-01 to Q-11; w1-09 R15 |
| B38 | S-M | **Hosting recipes and checks.** Per-host recipes; base-path support or an explicit "root only" rule; hub and per-domain CSP profiles with a conformance test (drop the `new Function` probe); `tools/verify-deploy.mjs`; wildcard hub guide. | w1-10 REC-11 to REC-15 |
| B39 | L | **Evaluate a single-file archive layout** (`v=mw2`): one web-seed URL, no per-file preflights, no path encoding, octet-stream outside compression lists. Changes the pointer grammar; first test whether GitHub Pages compresses `.tar`/`.bin`. | w1-10 REC-10 |
| B40 | M | **Security hardening batch.** Channel-disagreement banner on pinned scopes; external canary comparing served files with the signed release manifest; three-valued gossip admission with advertised limits and a 24 h future-`ts` admission window; torrent path validator (reject `..`, absolute paths, backslashes, control characters, case or NFC duplicates, depth over 32, `_mw/*`, and any `.mw/*` except the reserved `files.json` and `site.json`); upstream PRs; DPIA template; relay-only privacy mode once TURN exists; Firefox and Safari reruns; isolated libtorrent 2.1 evaluation. | w1-11 R13, R16, R17, R21-R25, R29 |
| B41 | S-M | **Magnet extras.** `share_target` GET at `/_mw/share`; "Show QR code" (`<origin>/#btih:<40 hex>` is QR version 5 at ECC M; generate locally); publisher snippet `mw-links.js`; opt-in "Open magnet links with this site" on the hub apex only, desktop only, feature test plus mobile exclusion, apex router to per-site origins; diagnostics line. The opt-in control was P1 in w1-09; lowered (4.3 C19). | w1-09 F16-F17, R4, R7-R11; VERIFY claim 8; w1-07 F7, R15 |
| B42 | S | **Prior-art follow-ups.** First-visit weight budget against the IPFS SW gateway's about 322 KB per origin; governance (two maintainers, permissive licence, reproducible build, continuity page); documented ledger ceilings and an owner-signed `archivedBefore` watermark. | w1-07 R10, R12, R13 |

### P3

| ID | Eff | Recommendation | Justifying file(s) |
|---|---|---|---|
| B43 | S | Order-independent routing-manifest hash and named snapshots (NIP-5A pattern). | w1-07 R14 |
| B44 | S | Opt-in Screen Wake Lock while sharing; `freeze`/`resume` on Chromium; telemetry-free diagnostics panel with "Copy report". | w1-08 R-16 to R-18 |
| B45 | S-M | `.torrent` `file_handlers` (desktop Chromium, verify the parser first); `launch_handler` only with a `launchQueue` consumer; optional `x.mw=1` marker. | w1-09 R12-R14 |
| B46 | S-M | Cost guardrails (budgets alarm, WAF rate rule, keep `max=`); watch list (`Integrity-Policy`, signature-based SRI, Trusted Types, WAICT); shell-hash pinning through the pointer, pending a decision. | w1-10 REC-16 to REC-18, F38 |
| B47 | S-L | Clock-skew tolerance for `exp`; optional opaque-origin "untrusted preview"; WebAuthn P-256 pointer signing and PRF-wrapped keys; threshold owner keys; watch list. | w1-11 R18-R20, R27, R28 |
| B48 | L | Peer-assisted signaling over `mw_chain1` (signed offers, TTL, rate limits, anti-amplification); design note first. | w1-12 R13 |

## 4. Verified, refuted and nuanced claims

No claim in either -VERIFY file was refuted. Nuanced = the facts hold but a statement was mis-scoped or an
inference was presented as a finding, so a downstream document changes.

### 4.1 `w1-07-prior-art-VERIFY.md` (8 claims: 2 confirmed, 6 nuanced)

| # | Claim | Verdict | Correction | Consequence |
|---|---|---|---|---|
| 1 | Local software stayed niche: Brave under 0.1 %; gateway traffic 9.4 % browsers, 67.4 % automated | confirmed | Brave's blog says "deprecated", its changelog "removed" (v1.69.153, 2024-08-22), with three reasons, not one; the split is a 3-day, abuse-filtered, heuristic sample; 614M requests/day is a 2025 headline (an IPFS post of 2026-08-25 says about 250M); "local software means niche" is an inference from four cases | none; "no install" stands |
| 2 | ipfs.io/dweb.link moved to a SW gateway, the strongest precedent for magnet-web | nuanced | precedent for SW + client verification + origin per site only: the gateway has no WebRTC, never seeds, and fetches from HTTPS/WSS/WebTransport providers; "100 %" appears only in a forum post | never cite it as P2P precedent |
| 3 | Shipyard's funding ended; infrastructure and maintainers lost; SW gateway still ships | nuanced | ceasing operation was an announced intention; on 2026-10-17 everything still answered; libp2p bootstrap `_dnsaddr` now points at `*.bootstrap.ipni.io`; current operator unknown; Kubo and Boxo READMEs say "no dedicated maintainer" | dependencies change hands quietly: B27 |
| 4 | Availability is the dominant, paid failure mode; the web seed is the floor | nuanced | Skynet, Cloudflare and NFT.Storage dates are announcement or transition dates, not outages; Arweave about US$82/GiB is ArDrive Turbo's retail quote incl. fees (protocol price about US$52); "dominant" was not measured | B05 stands; say "in every case examined" |
| 5 | Beaker post-mortem | confirmed | add scope: "(say) 100k" is a guess about local indexers; the author puts product-market fit first | B42 ledger ceilings |
| 6 | ZeroNet: six fixes from one design cause; creator silent after 2019; last fork standing | nuanced | at least nine labelled security entries 2016-2019; at most five fit the shared-origin wrapper; creator committed until 2020-12-03 and merged until 2021-01-25; EpixNet is an active successor | conclusion stands, attribution weaker |
| 7 | One origin per site via single label + wildcard TLS + PSL is settled | nuanced | every fact holds, but the PSL is not universal (ar.io and nsite hosts are not listed); NIP-5A is a draft; BEP 52 allows a 20-byte truncated infohash (40 hex fits); the IPFS spec answers HTTP 400 above 63 characters; PSL submitter continuity is a risk | keep base32 of the full digest (D9); never call the PSL universal |
| 8 | Edge takedown cannot reach installed SWs; abuse figures; in-SW revocation needed | nuanced | a new 200 worker script evicts at the next update check (tested, Chromium and WebKit); 404/410/5xx never evict; first installs fail on 410; IPFS removed its worker TTL (PR #1147, 2026-07-06) and costed an in-worker denylist at 2.5-4.3 MiB without building it; moving to Cloudflare Pages silently dropped its edge enforcement; Safari ITP can delete registrations; the Cofense and Netcraft figures are scoped vendor telemetry | D10, B11; hub revocation list optional and small |

### 4.2 `w1-09-protocol-handler-magnet-VERIFY.md` (8 claims: 4 confirmed, 4 nuanced)

| # | Claim | Verdict | Correction | Consequence |
|---|---|---|---|---|
| 1 | `magnet` is safelisted; other names need `web+` plus ASCII letters | confirmed | Chromium's list is a 10-scheme superset of the spec; matching is case-insensitive; Brave re-run with 57 cases matches Chromium | none |
| 2 | Handler URL rules | confirmed | in an insecure context the method is absent (no SecurityError); relative templates resolve against the document base or, in a manifest, the manifest URL; `%s` in userinfo is accepted; Firefox checks the scheme last | B26 |
| 3 | `%s` replaced once with `encodeURIComponent`-equivalent encoding; decode once | confirmed | re-proved against Chromium's escape table; decode-once returns the engine-normalized magnet | none |
| 4 | Literal `#magnet:?...` links with encoded characters are over-decoded | nuanced | in the project parser only encoded `&` and `%XX` corrupt; in magnet-uri 7.0.10 an encoded `=` silently drops the tracker and an encoded lone `%` throws `URIError`; `detectMode` is gone and `parseFragment` (app.js, 2026-10-17 18:06 ET) already decodes once | B13 |
| 5 | `/#%s` keeps the magnet out of HTTP requests and logs | nuanced | true for the request line, Referer and host logs (Chromium 156, WebKit 27.2), but the SW sees the fragment in a navigation `request.url`, redirects carry it to the target's scripts, and extensions and history see it; qBittorrent's move to the hash was the author's preference, not a privacy decision | B25 |
| 6 | Web-handler support matrix | nuanced | Chromium on Android has the API compiled out; Firefox Android has a no-op method; EU alternative-engine iOS browsers unverified; Edge and other Chromium browsers not run | 5.1 |
| 7 | Safari/WebKit has no `registerProtocolHandler` | confirmed | also true of the shipping system WebKit (Safari 27.0.1 engine); WebKit deleted its module on 2019-03-25 | none |
| 8 | Firefox for Android does not support it | nuanced | functionally true, but `typeof navigator.registerProtocolHandler === 'function'` there, and the call does nothing | B41: feature test plus mobile exclusion |

Outside the eight claims: Chrome Platform Status says the API needs transient user activation, so w1-09
F6's "no user-activation check" sentence is unverified (calling only from a click is right either way); the
sandboxed-iframe exposure (F19) reproduced in Chromium 156 and Brave 155.

### 4.3 Contradictions between files, and which source wins

| # | Topic | Conflict | Winner and reason | Action |
|---|---|---|---|---|
| C1 | Installed-SW takedown | w1-07 Summary 7 and F11 "cannot reach" vs w1-07 VERIFY claim 8 | VERIFY (experiment in two engines; rule 1) | B11 |
| C2 | SW update-check timing | w1-11 F37 "checked on navigation" vs w1-07 VERIFY 8.2 step B (no `/mw-sw.js` request on a plain reload inside 24 h, Chromium 156 and WebKit 27.2) | unresolved as fact; plan with VERIFY's conservative reach (rule 4) | B11; question 6.2 |
| C3 | Fragment and the SW | w1-09 F13 "the SW only sees the path" vs VERIFY claim 5 | VERIFY (observed in both engines) | B25 |
| C4 | Handler feature test | w1-09 R4 (`typeof === 'function'`) vs VERIFY claim 8 | VERIFY | B41 |
| C5 | Fragment decode | w1-09 R2 (`detectMode()` in render.js) vs VERIFY claim 4 | VERIFY (newer tree state) | B13 |
| C6 | Ledger anchor | ARCH §5.5, §14 and DR S1 (one-piece anchor torrent; bare infohash only if wires stay open) vs w1-12 F20-F25 | w1-12 (measured locally and on four live trackers); DR S1's condition is met; use the versioned name `mw-ledger/1/` | B03, B33 |
| C7 | Mobile upload default | ARCH §8 (on at 256 KiB/s on confirmed Wi-Fi) vs w1-08 (off unless charging; opt-in 128 KiB/s) | w1-08 on evidence (rule 3); owner decision | 2.3, B07 |
| C8 | Rebuild threshold | ARCH §8 (more than 60 s hidden) vs w1-08 R-03 (more than 10 s) | w1-08 (iOS suspends within 5-20 s) | B07 |
| C9 | Mobile caps | ARCH §8 (`maxConns` 10/6; 24 MiB on unknown networks) vs w1-08 (8/6/4; 48 MiB on unknown with a 16 MiB ask) | w1-08 (topic owner, memory measured) | 2.3 |
| C10 | Floor and `BigInt64Array` | ARCH §1 and DR 16 ("uses `BigInt64Array`"; floor 15.4/110/115) vs w1-08 (absent from the bundle; hard floor 14.5/80/78) | fact: w1-08 (confirmed by the 2026-10-19 grep), but `uint8-util` source uses it, so a self-built bundle may include it; floor: DR 16 stays (normative and inside w1-08's band) | B06, B33 |
| C11 | fsa-chunk-store polyfill range | ARCH §1 (Safari 15.2-18.1) vs w1-08 (`createWritable` is Safari 26, so 15.2-25.x) | w1-08 (BCD); no design change, ARCH already bans the default store | B33 |
| C12 | Wire length worst case | DR 10, ARCH §1 and §12 test 11 (any 32-bit length, 4 GiB) vs w1-11 F11 (signed read: `0x7FFFFFFF` buffers; `0x80000000` and above desync as keep-alives) | w1-11 (source and PoC; w1-12 F14 agrees) | B01 |
| C13 | Buffer watchdog threshold | w1-12 R5 (256 KiB, every 2 s) vs w1-11 R1 (about 512 KiB) | digest judgement: about 512 KiB checked periodically, with w1-12's field-presence test; a watchdog equal to the cap leaves no headroom for a maximal frame plus the next chunk | B01 |
| C14 | Upload rate in the `reqq` formula | w1-12 R3 ("256 KiB/s mobile default") vs w1-08 (128 KiB/s after opt-in) | w1-08; the formula still clamps to `reqq` 4 | none |
| C15 | Web-seed preflight remedy | w1-10 (set `MaxAgeSeconds`; Firefox/WebKit untested) vs w1-13 (Chromium sent one preflight per GET despite `Max-Age: 600`; WebKit preflights `xs=` for `user-agent`; the header strip gives zero preflights in both) | w1-13 (executed in two engines; rule 2); DR §6's Firefox `user-agent` question is now answered for WebKit only | B04, B14 |
| C16 | WebKit e2e acceptance | w1-10 REC-4 (Chromium and WebKit tabs exchange the site) vs w1-13 (no ICE candidates in Playwright WebKit here) | w1-13 | B29 |
| C17 | Degraded-mode detection | w1-08 R-10 (API absent) vs w1-13 (with SWs blocked the API exists and `ready` never resolves) | combine both checks with a timeout | B24 |
| C18 | Bugout as a pattern | w1-07 §5 (reuse its signed wire-extension gossip) vs w1-12 F11 (unsigned handshake keys, floods unvalidated packets, complete-torrent rendezvous fails) | w1-12 (code and lab; rule 3) | copy the idea, not the code |
| C19 | Native-protocol investment | w1-07 R15 (nothing beyond the PWA entry) vs w1-09 R4 (opt-in control, P1) | w1-09 on mechanism, w1-07 on priority: build it at P2 | B41 |
| C20 | Pinner seeding stack | w1-07 R1 ("if a Node WebRTC shim proves stable") vs w1-13 (WebRTC built into webtorrent 3.0.21 on Node 24; 5.0 s per offer; glare caveat) | w1-13 (executed) | B05, B30 |
| C21 | `.mw/` inside torrents | ARCH §10 ignore list ("dotfiles") and create-torrent directory input (drops dot-paths) vs ARCH §3.4.1 and w1-11 R10 (`.mw/files.json` must be in the torrent); w1-11 R25 rejects top-level `.mw` | internal inconsistency, not a source conflict: exempt the reserved `.mw` files, pass an explicit file list, validator accepts exactly those files | B17, B40 |
| C22 | Mobile tracker count | w1-12 R7 (at least 3, of which 2 pair seeders) vs w1-08 R-13 (at most 2 on mobile) | compatible: w1-12 already allows 2 on mobile; pick two that pair seeders | B27 |
| C23 | Torrent `name` across versions | ARCH §3.4.1 and §10 ("fixed `name`") vs w1-10 REC-9 (`<dn>-<first 8 hex of the content hash>`) | owner decision: a versioned name gives `immutable` web-seed caching but re-uploads every file per version; a constant name allows incremental uploads but needs revalidation | B17 |

## 5. Constraints discovered

### 5.1 Compatibility

Minimum-browser matrix (w1-08 §Minimum-browser matrix, with DR 16's declared floor added):

| Engine | Refuse below (w1-08 hard floor) | Declared floor (DR 16) | Tier 1 tested (w1-08) | Native base64/hex | Global traffic below Tier 1 (caniuse 2026-10-13) |
|---|---|---|---|---|---|
| iOS / iPadOS (every iOS browser is WebKit) | 14.5 | 15.4 | 16.4 | 18.2 | 0.40 % (2.7 % of iOS Safari) |
| macOS Safari | 14.1 | 15.4 | 16.4 | 18.2 | 0.14 % |
| Chromium: Chrome, Edge, Android Chrome, WebView, Brave | 80 | 110 | 110 | 140 | Chrome desktop 1.23 %, Edge 0.04 % |
| Firefox desktop and Android | 78 | 115 ESR | 115 ESR | 133 | 0.01 % |
| Samsung Internet | 13.0 (Blink 83) | 21 (Chromium 110) | 21.0 | 30.0 | 0.01 % |

Without the polyfill about 8.5 % of global traffic fails in `new WebTorrent()` (iOS Safari below 18.2 alone
is 1.10 %). Unlisted engines (UC, QQ, stock Android, unmapped Opera) are best effort.

Feature floors and platform rules:
- **WebCrypto:** keep ECDSA P-256; Ed25519 needs Safari 17, Chrome 137, Firefox 129, Samsung 30; X25519
  keys fail an IndexedDB round trip in WebKit (w1-08 F-24, F-32).
- **Integrity:** import-map `integrity` Chrome 127, Firefox 138, Safari 18; `modulepreload` integrity
  Chrome 66, Firefox 115, Safari 17; iOS 16 has neither; `import()`, `serviceWorker.register()` and
  `new Worker()` have no integrity option; signature-based SRI is Chrome 141 only (w1-10 F28; w1-11 F34-F35).
- **Protocol handlers:** `registerProtocolHandler('magnet')` on desktop Chrome 30+, Edge 79+, Brave and
  Firefox only; absent in Safari and every iOS browser, compiled out of Android Chromium, a no-op on Firefox
  Android; manifest `protocol_handlers` only for an installed PWA on desktop Chrome/Edge 96+; `share_target`
  needs an installed app on Android or ChromeOS and delivers links in `text`/`title` (w1-09 §2, F11-F16;
  VERIFY claims 6-8).
- **Signals:** iOS will never expose Network Information, Battery or Device Memory; Firefox Android removed
  `navigator.connection` in 99; Safari 26 masks some APIs for known fingerprinting scripts (w1-08 F-14,
  F-15, G-10).
- **Storage:** `persist()` false in Safari tabs, a prompt in Firefox, silent in Chromium; ITP deletes all
  script-writable storage, SW registrations included, after 7 days without interaction (trunk: 30
  operating days; shipping value unknown); Home Screen apps exempt; Safari private sessions: OPFS throws and
  IndexedDB rejects Blob/File values; `estimate()` is fuzzed on Safari (w1-08 F-19 to F-22, F-32).
- **Service Workers absent:** generic in-app WKWebViews, Lockdown Mode (no RTCPeerConnection either),
  Firefox private windows before 140; Android WebView hosts may lack DOM storage; non-WebKit iPhone engines
  allowed in the EU and Japan, none shipped per OWA (w1-08 F-25, F-26, F-28, G-17, G-18).
- **bfcache:** Chrome and Firefox refuse pages with an open RTCPeerConnection; Safari restores them with
  dead sockets (w1-08 F-11).
- **Secure context:** `http://192.168.x.x` gives no SW and no `crypto.subtle`, so WebTorrent cannot hash
  pieces (w1-10 F35).
- **Data channel:** an extension frame whose payload plus 1 byte exceeds 262,144 bytes silently kills a
  Chromium WebRTC connection (w1-12 gotcha 2).
- **Samsung Internet:** UA reports `Chrome/143.0.0.0` beside `SamsungBrowser/30.0`; gate on the Samsung
  version (w1-08 G-12).

### 5.2 Hosting facts

| Topic | Fact | Source |
|---|---|---|
| AWS S3 | Website endpoints are HTTP-only. Use a private REST bucket + CloudFront OAC + ACM in us-east-1 + a CloudFront Function for SPA fallback; custom error responses are distribution-wide and turn missing web-seed objects into `200 text/html`; behind OAC a missing key answers 403 | w1-10 F1-F4, gotchas 5-6 |
| CloudFront | `CORS-With-Preflight` sets no `Access-Control-Allow-Headers`; the cache does not vary on Origin unless configured; flat-rate plans reserve custom response-header policies for Business and Premium | w1-10 F5-F6 |
| Preflight | `Range: bytes=N-M` alone is CORS-safelisted; WebTorrent's `Cache-Control: no-store` and `user-agent` force preflights; a preflight cannot be redirected | w1-10 F9-F10; w1-11 F33; w1-13 |
| Compression | Browsers always send `Accept-Encoding`; GitHub Pages (gzip) and jsDelivr (br) answer ranges over compressed bytes with 206; cdnjs ignores Range; unpkg, Netlify and Vercel returned identity 206; CloudFront documents the hazard | w1-10 F12-F13 |
| GitHub Pages | Fine for the shell. OPTIONS 405; no custom headers (no HSTS, nosniff, CSP); fixed `max-age=600`; SPA fallback is an HTTP 404; 1 GB site, 100 GB/month soft limit; no commercial use; no wildcard custom domains; project sites (`/repo/`) break root-absolute URLs. After the B14 header strip, GET answers with `ACAO: *` pass CORS, but gzip ranges still break text files, so a GitHub Pages web seed needs another host, or B39 if GitHub Pages leaves `.tar` uncompressed (untested) | w1-10 F14-F16, REC-7 |
| Cloudflare | Pages and Workers Custom Domains take no wildcards; Worker routes (`*.hub.example/*`) with proxied wildcard DNS work on all plans; a top-level `404.html` disables Pages SPA mode | w1-10 F17-F19, F24 |
| R2 | Zero egress; `r2.dev` is rate-limited, development only; caching and WAF need a custom domain in the same account; `AllowedHeaders: ["*"]` is undocumented, so list headers | w1-10 F20 |
| B2 | $6.95/TB-month, free egress through partner CDNs; Cloudflare's CDN terms make a Free zone proxying large files a policy risk | w1-10 F21-F22 |
| Netlify, Vercel | Netlify Free about 15 GB/month; Vercel Hobby non-commercial; both failed the stock preflight on the deployments measured | w1-10 F23 |
| Wildcards and PSL | Wildcard origins: CloudFront + ACM, Vercel, Cloudflare Worker routes; not Pages or GitHub Pages; Netlify unverified; a wildcard covers one label, not the apex. PSL: 2+ years of registration, a `_psl` TXT that must stay, no expedite, unknown propagation | w1-10 F24-F25; w1-11 gotcha 6 |
| CSP | A `<meta>` CSP cannot carry `frame-ancestors`, `report-uri` or `sandbox`; `connect-src` needs both `https:` and `wss:`; an inline import map needs a hash; WebRTC is outside CSP | w1-10 F26-F27 |
| Caching | Root files `no-cache` and invalidated (CloudFront: 1,000 free invalidations per month); edges otherwise hold a stale worker; IPFS hit a reload loop from a stale CDN copy | w1-10 F31-F32 |
| Cost (model, 10k visits/day) | Shell 30-40 GB and 3-4 M requests per month: $0 to about $20 anywhere. A 5 MB site, every visit cold, 0 % P2P is about 1.5 TB/month: CloudFront PAYG about $49, R2 about $1.4, B2 + Cloudflare about $0, Vercel Pro about $105, Netlify or Amplify about $220. Per-file preflights add 33 % requests; the `cache:'reload'` precache doubles the first-visit shell | w1-10 F34, App C |
| Trust root | The static host and CDN are the trusted computing base on first visit and at every SW update; no browser-native mechanism pins a SW-hosted loader in 2026 | w1-10 F38; w1-11 F34-F35 |
| Phone demos | Android USB forwarding to localhost; mkcert CA on the phone (never share the root key); Tailscale Serve; Cloudflare quick tunnel (200 in-flight cap, no SSE, new origin per run); ngrok Free worst (1 GB, 20k requests, interstitial); tracker as `wss://` via a `/tracker` proxy | w1-10 F36-F37 |
| Prior art | Shipyard moved 15+ project sites from Fleek to GitHub Pages with CI-built CIDs and DNSLink; the IPFS SW gateway costs about 322 KB per new origin | w1-07 F10, F12, F21 |
| Own tracker | bittorrent-tracker 11.2.3: about 17 KB per connection (235 MB RSS at 10k); 10k peers at the 120 s WS interval use about 1 % of one core; TLS without a proxy via `ws: { noServer: true }` | w1-13 checkpoint 3 |

### 5.3 Operational

- **Network policy (binding).** Everything an agent runs stays on 127.0.0.1: Chromium through
  `chromiumArgs()`, WebKit only on `http://127.0.0.1` URLs, remote probes only in Node from
  `check-site`, `check-webseed` and `pin`. So w1-12's e9 live-tracker browser test and w1-07/w1-12's
  endpoint probes need Node or a separate runner, and tunnel or tailnet demos are owner-run
  (docs/DEV-NETWORK.md).
- **Playwright on this Mac.** Firefox 157 does not launch; WebKit 27.2 gathers no ICE; with SWs blocked
  `register()` resolves and `ready` never does; `context.serviceWorkers()` sees Chromium workers only;
  tab-to-tab WebRTC needs `--disable-features=WebRtcHideLocalIpsWithMdns`; own-LAN-IP origins time out
  (w1-13; w1-12 method).
- **node:test on Node 24.22.** `node --test test/unit` fails (directories are not walked); use globs and
  always pass `--test-timeout` and `--test-force-exit` (one file hung 3 to 21 minutes) (w1-13).
- **Node WebRTC.** WebTorrent pins node-datachannel ^0.32.3, whose install script uses deprecated
  prebuild-install and is skipped under `ignore-scripts`, npm 11 defaults, Deno and pnpm 10; an override to
  0.33.4 works. Deno 2.9.7 needs `--allow-scripts=npm:node-datachannel` and `--allow-ffi`. Node-side
  signalling costs 5.0 s per offer; webtorrent-hybrid is deprecated (w1-13).
- **create-torrent 6.1.3.** Infohash depends on file order, `name`, piece length, `private` (even
  `false`), `info` extras; not on dates, comments, trackers or URL list. `creationDate` of `0` or
  `new Date(0)` is silently replaced by now, and a plain number is read as milliseconds. Directory input
  drops every dot-path and uses `readdir` order. Piece length is 16 KiB below 16 MiB, 256 KiB at 256 MiB,
  capped at 4 MiB (w1-13).
- **magnet-uri 7.0.10 / parse-torrent 11.0.24.** Case-sensitive (`MAGNET:?XT=` parses to nothing); no
  infohash validation (39 hex characters decode as base32 into a wrong, valid-looking hash); unencoded `=`
  or `&` inside a value drops it silently; `x.pe` is not decoded; parse-torrent rejects v2-only `urn:btmh:` magnets
  (w1-13; w1-09 VERIFY claim 4).
- **Client behaviour (webtorrent 3.0.21).** `maxConns` ignored for WebRTC; throttle is client-global and
  rate 0 freezes handshakes; a metadata-less torrent announces `left` as `null`, which the reference
  tracker reads as a seeder; two clients in a page share tracker sockets; peers' `reqq` is honoured;
  per-torrent `getAnnounceOpts` is marked "consider deprecating" (w1-12 F15-F19, gotchas 3, 11).
- **Trackers.** Live: `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua`,
  `open.ftorrent.com`; openwebtorrent does not pair two seeders. Servers close idle sockets after
  125-185 s; the client then waits `10 s x 2^n + U(0, 5 min)` and ignores announces (median 171 s
  measured). Default `numwant` 5 costs about 17 messages per 120 s per visitor per swarm per tracker
  (w1-12 F25-F26; w1-08 F-12; ARCH §1).
- **Reference tracker server.** Ignores `numwant` and forwards up to 82 offers; relays answers with an
  unvalidated `offer_id`; `scrape` without an infohash lists every swarm; default `ws` `maxPayload`
  accepted 1 MB (set 65,536); per-swarm LRU of 1,000 peers; `filter()` refuses an announce without
  creating the swarm (w1-13 checkpoint 3).
- **BEP 47 padding.** create-torrent emits none; WebTorrent treats `.pad/<n>` as ordinary files fetched
  from the web seed and never completes if the host answers 404; servers must clamp ranges past a file's
  end. Cross-version piece reuse: 16 KiB pieces 6.1 % unpadded, 83.1 % padding big files (+8.9 % size);
  256 KiB pieces 0 % and 30.8 % (+12.4 %) (w1-13).
- **Third-party churn.** Defaults rot silently (create-torrent's default list includes the dead
  `tracker.btorrent.xyz`; `hub.bugout.link` has no DNS); IPFS infrastructure changed hands during the
  research (w1-07 VERIFY §10; w1-12 F11; w1-13).

### 5.4 Threat-model inputs

- **Assets (w1-11 §2.1):** A1 code integrity at an origin; A2 owner root key; A3 visitor identity key and
  local data; A4 visitor network identity (IP plus infohash = who reads what); A5 availability; A6 ledger
  integrity and moderation authority; A7 loader-domain reputation; A8 legal position of owners, hub
  operators, visitors.
- **Adversaries (§2.2):** malicious peer or Sybil; malicious tracker, STUN, DoH or web-seed operator;
  on-path or DNS attacker; malicious publisher or contributor; compromised host, CDN or DNS account;
  compromised owner key; XSS in a legitimate site; supply-chain attacker; right-holder monitoring swarms;
  regulator or abuse reporter.
- **Trust boundaries (§2.3):** the origin is the security principal; in per-domain and drop-in modes site
  code holds loader privilege; peers are hostile by default; a tracker can MITM DTLS through SDP, so
  integrity comes from hashes and signatures and confidentiality is never claimed (F15); DNS TXT is an
  unsigned channel whose authority is the owner signature.
- **Catalogue priorities (§2.4):** P0 T1 (shared origin), T2 (drive-by load), T3 (wire length), T18
  (illegal content seeded by visitors), T22 (redaction obligations, design); P1 T4-T9, T11-T13, T16, T17,
  T19, T21, T23, T24; P2 T10, T20; P3 T14, T15.
- **Inputs from the other files, not in w1-11's catalogue:**
  - Installed workers survive edge refusals; only a 200 script evicts; ITP may delete registrations
    (w1-07 VERIFY claim 8) -> reach of T20 mitigations.
  - Fragments reach the SW, redirect targets, extensions and history (w1-09 VERIFY claim 5) -> T17.
  - A hosted site on a shared origin can register itself as the `magnet` handler (w1-09 F19) -> T1.
  - The rendezvous infohash is guessable for any known domain (a label, not a secret); hostile
    `metadata_size`; eclipse with 6 slots unmodelled (w1-12 F20a, F22, F27) -> T6.
  - Tracker servers relay unvalidated answers and enumerate swarms through `scrape` (w1-13) -> T15, T17.
  - Silent loss of the identity and TOFU pin on Safari makes "first visit on this device" routine, which
    weakens pin warnings (w1-08 F-20; G-01) -> T11, T13.
  - Shared-domain phishing history (w1-07 F11) -> T23; contributor bait-and-switch (w1-11 F8) -> T16.
  - Install scripts: 6 of 251 locked packages, including `ip-set`'s preinstall `npx only-allow pnpm`
    (w1-11 F36) -> T19.

### 5.5 Legal (topic 14 was never researched)

Nothing below is legal advice, and no file in this set was reviewed by counsel. w1-11 itself asks for
counsel review of the consent and takedown design per jurisdiction.
- **IP addresses are personal data** for an operator with legal means to identify the visitor (GDPR
  Recital 30; CJEU Breyer C-582/14). Trackers see IP, infohash and SDP; peers and STUN see the IP; the DoH
  resolver sees IP and hostname; the web-seed host sees IP and `Origin` (w1-11 F16).
- **Uploading pieces is "making available to the public"** even when the pieces are unusable alone (CJEU
  Mircom C-597/19), a holding the Court tied to an informed user; right-holders may record swarm IPs
  where national law allows. A download-only visitor (choke lock) is outside the uploading holding but
  still exposes the IP (w1-11 F17).
- **ePrivacy Art. 5(3)** (EDPB Guidelines 2/2023) reaches an entity that instructs a device through a
  protocol to send IP or session identifiers; peer sharing is the part that most needs consent, and the
  DoH lookup currently runs outside the gate (w1-11 F18).
- **Hashes and deletion** (EDPB Guidelines 02/2025 v2): a hash of personal data is personal data and an
  unsalted hash is not sufficient; deletion in a replicated log is a request honoured by cooperating
  copies, so never promise erasure (w1-11 F29-F30, gotcha 15).
- **Hub-by-magnet** makes visitors redistribute arbitrary content; the only levers are an allow-list, a
  denylist at the gate and at boot, a report channel and a takedown process; none is a safe harbour (w1-11
  F20-F21; w1-07 F11). Shared gateways are phishing magnets (scoped figures in 4.1 claim 8).
- **Host terms:** GitHub Pages forbids commercial use; Vercel Hobby is non-commercial; Cloudflare's CDN
  terms restrict large files on non-Developer-Platform plans; whether hosts' acceptable-use terms allow a
  site whose visitors re-serve its content was not read (w1-10 F14, F21, F23, Q13).
- **Copy discipline:** do not copy webtorrent.io's VPN statements (w1-11 F19); DR 4.5's "There's no private
  mode" text is accurate; never "uncensorable" or "impossible to shut down" (w1-07 §4 Avoid 5; DR 4.2).

## 6. Open questions

### 6.1 Needs a real device or a real network
1. iOS teardown time for an RTCDataChannel after `hidden` on iOS 16.4-26; Android screen-off survival at 1,
   5, 15 minutes (w1-08 Q-01, Q-02).
2. Memory on real phones (iPhone SE class, a 2 GB Android) to replace the desktop proxy (w1-08 Q-11).
3. A realistic first-paint budget on LTE, and how much faster a peer-assisted load is than web-seed-only
   for a small site with few visitors (w1-07 Q2, Q4).
4. WAN behaviour of the head-of-line and `reqq` numbers (all loopback); the `reqq` 64 outlier (w1-12 Q1,
   Q2).
5. Combined mobile peer budget: 4-8 content wires plus 3-5 rendezvous wires, and the battery cost of idle
   rendezvous connections (w1-12 Q11; w1-08 F-13).
6. Does the pinner pair reliably with browsers on a real network given the 5.0 s Node offer cost and glare
   (w1-13)?

### 6.2 Needs a browser or account not available here
7. Firefox, all of it: `user-agent` in preflights, metadata-less wires, `persist()` on Android, the opaque
   frame and Range experiments, test262 for the polyfill (w1-08 Q-08; w1-11 Q1; w1-12 Q3; DR §6).
8. SW update-check timing on stable browsers: does every in-scope navigation check, or only a stale
   registration (4.3 C2)? Decides how fast the kill switch reaches returning visitors.
9. ITP window in shipping Safari (7 or 30 operating days); `persist()` in Home Screen apps and other iOS
   browsers; key round trip on iOS 16.4-18 (w1-08 Q-03 to Q-05).
10. Installed-PWA protocol launch: is the `#...` fragment kept (w1-09 Q1)? If not, only `?mw=%s` remains,
    which leaks the infohash to host logs.
11. R2 custom domain: identity 206 under `Accept-Encoding: gzip, br`, and `AllowedHeaders: ["*"]`; Cloudflare
    Pages fallback status, OPTIONS and Range; whether GitHub Pages compresses `.tar`/`.bin`; CloudFront
    header policies on Function responses (w1-10 Q1, Q4-Q6).
12. Apex SW bundle re-downloaded per PSL-listed subdomain (w1-07 Q3); PSL propagation time and acceptance
    of user-controlled children (w1-10 Q9; w1-11 Q3).

### 6.3 Owner decisions
13. Mobile sharing default on confirmed Wi-Fi: ARCH (on, 256 KiB/s), w1-08 (off unless charging, opt-in
    128 KiB/s) or w1-08's alternative (on at 32 KiB/s, 8 MiB per visit while visible); then the DR 4.3/4.5
    phone wording (2.3).
14. Is a multi-publisher hub in v1 at all, given B10's launch conditions (PSL, denylist, takedown, counsel)?
15. Adopt BEP 47 padding for cross-version piece reuse? It requires web seeds to serve `.pad/*` and the path
    validator to accept them (5.3).
16. Single-file archive layout (`v=mw2`) to escape host compression and per-file preflights (B39)?
17. Offer the opt-in magnet handler at all (B41, 4.3 C19)?
18. Ship the Nostr plane (B34)? Depends on how often all public trackers are down at once (w1-12 Q6).
19. Shell-hash pinning through the pointer or DNS (w1-10 REC-18, F38)?
20. Torrent `name` per version (immutable web-seed caching) or constant (incremental uploads)? (4.3 C23)

### 6.4 Legal, ops, economics (topic 14 never researched)
21. Consent sufficiency per jurisdiction: is a non-blocking notice with [OK] enough, must [Host only] be
    equally prominent, may DoH run before consent, and is the hub operator a controller, joint controller
    or host (w1-11 Q7, Q8)?
22. Legal basis for HTTP 451 takedowns by hub operators, and Safe Browsing's treatment of PSL-listed hub
    subdomains (w1-07 Q10).
23. Host acceptable-use terms for visitor re-serving; the Cloudflare large-file clause for Free zones
    (w1-10 F21, Q13).
24. Who pays for always-on availability (web seed, pinner, trackers) over years; paid persistence services
    kept closing (w1-07 F12). Not modelled beyond the w1-10 cost table.

### 6.5 Upstream and third parties
25. Will webtorrent keep per-torrent `getAnnounceOpts` and accept `maxMessageLength`, a request-queue cap
    and a hash-failure attribution hook (w1-12 Q9; w1-11 R21)?
26. Which software runs `tracker.openwebtorrent.com`, and will its seeder filtering change (w1-12 Q4)?
27. Does libtorrent 2.1's WebRTC interoperate with browser WebTorrent, which would give owners a native
    pinner (w1-11 Q4)?
28. Are SHA-1 chosen-prefix collisions practical against web assets in 256 KiB pieces (w1-11 Q6)? Moot once
    `fj=` ships.

## Appendix: source coverage

| Source file | Used in |
|---|---|
| `w1-07-prior-art.md` | 1, 2.1, 2.2, 3 (B05, B08, B10, B11, B27, B29, B32, B41-B43), 5.2, 5.4, 5.5, 6 |
| `w1-07-prior-art-VERIFY.md` | 1, 2.1, 2.2, 3 (B10, B11, B29), 4.1, 4.3 (C1, C2), 5.3, 5.4 |
| `w1-08-mobile-constraints.md` | 1, 2.1, 2.3, 3 (B06, B07, B08, B22-B24, B35-B37, B44), 4.3 (C7-C11, C14, C17), 5.1, 5.4, 6 |
| `w1-09-protocol-handler-magnet.md` | 1, 2.1, 2.2, 3 (B08, B09, B13, B25, B26, B41, B45), 4.3 (C3-C5, C19), 5.1, 6 |
| `w1-09-protocol-handler-magnet-VERIFY.md` | 2.1, 3 (B13, B25, B26, B41), 4.2, 4.3 (C3-C5), 5.1, 5.4 |
| `w1-10-static-hosting-bootstrap.md` | 1, 2.1, 3 (B04, B14-B17, B31, B38, B39, B46), 4.3 (C15, C16, C23), 5.1, 5.2, 5.5, 6 |
| `w1-11-security-threats.md` | 1, 2.1, 3 (B01, B09, B10, B12, B18-B21, B30, B40, B47), 4.3 (C2, C12, C13, C21), 5.4, 5.5, 6 |
| `w1-12-signaling-libs.md` | 1, 2.1, 2.3, 3 (B01-B03, B27-B29, B34, B48), 4.3 (C6, C13, C14, C18, C22), 5.3, 6 |
| `w1-13-toolchain.md` (draft) | 1, 2.1, 3 (B04-B06, B14, B17, B24, B29-B31), 4.3 (C15-C17, C20, C21), 5.2, 5.3, 6 |
