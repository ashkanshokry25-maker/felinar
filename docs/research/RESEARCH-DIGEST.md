# Research digest, wave 1: foundations (topics 01-14)

Date: 2026-10-19. Status: research digest, not normative. This is the single wave-1 digest. It merges
`_w1-part-a.md` ("part A": files 01-06, dated 2026-10-14) and `_w1-part-b.md` ("part B": files w1-07 to
w1-13, dated 2026-10-17), removes duplicates, resolves the contradictions between the two halves and between
their sources (section 4.1), and keeps every source citation of both. The normative documents are
`docs/ARCHITECTURE.md` v0.2 (ARCH), `docs/INTERFACES.md` v0.2 (INTERFACES) and `docs/review/DESIGN-REVIEW.md` (DR).
Internal engineering document, not user-facing copy; it follows DR §4's wording rules (no em dashes, straight quotes, "site ledger").
The other three digests cover wave 2: `MIGRATION-DIGEST.md` (2a), `PRODUCTION-DIGEST.md` (2b) and
`IMPROVEMENTS-DIGEST.md` (2c). `README.md` in this folder indexes every research file.

## 0. Scope, sources, precedence

### 0.1 Sources

| Tag | File (`docs/research/`) | Date | Status | Evidence base | Lab or experiment folder | Second pass |
|---|---|---|---|---|---|---|
| R01 | `01-webtorrent-browser.md` | 2026-10-14 | final | npm tarball source, 12 executed experiments (headless Brave 155 = Chromium 155) | `labs/01-webtorrent-lab/` (`results/report-e1..e12.json`) | none; claims re-tested by DR 16 and `w2c-06-standards-and-ecosystem-VERIFY.md` claim 7 |
| R02 | `02-wss-trackers.md` | 2026-10-14 | final | live protocol probes of public trackers, Nostr and MQTT; server source | `labs/02-wss-trackers-probes/` (6 stdlib Python probes; numbers are in R02 F1-F12, no stored results) | none; corrected by `w2b-01-tracker-resilience.md` corrections 1-5 and by w1-12 |
| R03 | `03-webrtc-nat-privacy.md` | 2026-10-14 | final | libwebrtc, Blink, WebKit, Gecko and brave-core source; vendor pricing; NAT papers | none (own "Verification tail" and Appendix B) | none; relay range refined by `w2b-03-turn-connectivity.md` F-01 |
| R04 | `04-service-worker-serving.md` | 2026-10-14 | final | specs, WPT, engine source, Chromium 156 experiments | `labs/04-sw-experiment/` (`RUN.txt`, `results-chromium-156-2026-10-14.txt`, tests A-E) | none |
| R05 | `05-doh-dns-txt.md` | 2026-10-14 | final | curl and real-browser (Brave 155) DoH probes, reference code (32/32 checks) | Appendix A (code) and B (run log) inside the file | none; registry count corrected by `w2c-06-standards-and-ecosystem-VERIFY.md` claim 2 |
| R06 | `06-browser-chain-vs-crdt.md` | 2026-10-14 | final | registries, repos, papers, Chromium 155 Worker benchmarks on an M3 | Appendix A (raw numbers) and B (calibration page) inside the file | none; re-tested by `w2b-04-observability-no-backend-VERIFY.md` claim 5, `w2c-02-chain-production-features-VERIFY.md` claim 5, `w2c-03-identity-ux-VERIFY.md` claims 1-4 and 6 |
| w1-07 | `w1-07-prior-art.md` | 2026-10-17 | final | why websites-by-hash systems stalled; what to copy and avoid | none | `w1-07-prior-art-VERIFY.md` |
| w1-07 VERIFY | `w1-07-prior-art-VERIFY.md` | 2026-10-17 | final | 8 design-critical claims re-checked: 2 confirmed, 6 nuanced, 0 refuted; SW takedown experiment | `labs/w1-07-verify-lab/` (`sw-takedown/`) | - |
| w1-08 | `w1-08-mobile-constraints.md` | 2026-10-17 | final | lifecycle, memory, storage, polyfills, Mobile policy v1, minimum-browser matrix; Chromium 156 and Playwright WebKit 27.2 runs | `labs/w1-08-mobile-lab/` | none; hard floor corrected in 4.1 row 27 |
| w1-09 | `w1-09-protocol-handler-magnet.md` | 2026-10-17 | final | `magnet:` handling, support matrix, link forms, QR, share target | `labs/w1-09-lab/` | `w1-09-protocol-handler-magnet-VERIFY.md` |
| w1-09 VERIFY | `w1-09-protocol-handler-magnet-VERIFY.md` | 2026-10-17 | final | 8 claims: 4 confirmed, 4 nuanced, 0 refuted | `labs/w1-09-verify-lab/` | - |
| w1-10 | `w1-10-static-hosting-bootstrap.md` | 2026-10-17 | final | hosts, web-seed CORS/Range/compression, SRI, CSP, caching, cost, phone demos; curl probes of live hosts | none (appendices inside) | none; F12 superseded for browsers by `w2a-07-hosting-cost-bandwidth.md` F1 and Appendix C |
| w1-11 | `w1-11-security-threats.md` | 2026-10-17 | final | assets, adversaries, threats T1-T24, P0-P3 mitigations, legal summary | `labs/w1-11-opaque-frame-lab/` | none; F11-F13 confirmed by `w2b-05-security-hardening-prod.md` F41 and `w2c-05-testing-qa-production.md` Summary 2; F4 nuanced by `w2b-06-abuse-legal-ops-VERIFY.md` claim 7 |
| w1-12 | `w1-12-signaling-libs.md` | 2026-10-17 | final | signaling libraries, wire-extension behaviour, rendezvous-swarm decision | `labs/12-signaling-lab/` | none |
| w1-13 | `w1-13-toolchain.md` | 2026-10-17 | **checkpoint draft**; the promised final version was never written | executed facts: create-torrent, magnet-uri, own bundle, Node seeder, Playwright, tracker server, padding | `labs/w1-13-lab/` | none |

**Missing topic.** Topic 14 ("Operational reality: PeerTube lessons, CDN-P2P hybrids, consent, costs") was never
researched in wave 1. Legal statements here come only from w1-11 §D and scattered points in w1-07, w1-10, R02, R03,
R05 and R06; economics only from the w1-10 §J cost model and the w1-07 F12-F13 history of paid persistence. Wave-2
files on nearby ground (`w2b-06-abuse-legal-ops.md`, `w2a-07-hosting-cost-bandwidth.md`,
`w2c-07-incentives-economics.md`) are digested in `PRODUCTION-DIGEST.md`, `MIGRATION-DIGEST.md` and
`IMPROVEMENTS-DIGEST.md`; this digest cites them only where they correct a wave-1 claim.

**Verification gap.** The wave-1 run was meant to verify 01-06 as well. No `-VERIFY` file exists for 01-06, w1-08,
w1-10, w1-11, w1-12 or w1-13. Section 4 therefore uses (a) each file's own executed checks, (b) the two wave-1 VERIFY
files, (c) wave-2 files that explicitly re-test or supersede a wave-1 claim (0.2), (d) DR item 16, and (e) the local
checks listed in 0.2.

### 0.2 Later material and local checks used

- **Later files, only where they correct or re-test a wave-1 claim:** `w2b-01-tracker-resilience.md` corrections 1-5
  (R02); `w2b-04-observability-no-backend-VERIFY.md` claims 1 and 5; `w2c-02-chain-production-features-VERIFY.md`
  claim 5; `w2c-03-identity-ux-VERIFY.md` claims 1-4 and 6; `w2c-06-standards-and-ecosystem-VERIFY.md` claims 2 and
  7; `w2a-07-hosting-cost-bandwidth.md` F1, F4, F5, F7-F9, F14, F20, F23, Q1, R1, R2, R9 and Appendices C-D (w1-10); `w2a-06-cicd-automation.md`
  Summary 2 (pointer size); `w2b-03-turn-connectivity.md` F-01 (R03); `w2b-05-security-hardening-prod.md` F41 and
  `w2c-05-testing-qa-production.md` Summary 2 (w1-11); `w2b-06-abuse-legal-ops-VERIFY.md` claim 7 (w1-11 F4);
  `w2c-04-hub-gateway-operations.md` Summary 3 (hub labels). Everything else in wave 2 is in the wave-2 digests.
- **Local, read-only checks (no network, no browser), 2026-10-19:**
  1. `node_modules/webtorrent/dist/webtorrent.min.js` (3.0.21) has sha256
     `db4dca98cd135c732eeffdede3cf5f8febd0585a0eba4dc4d1effa1b901f4c3d`, the bytes R01 hashed. It contains one each of
     `toHex`, `toBase64` and `fromHex` calls, 0 `BigInt64Array` and 1 `BigInt(`; the source of `uint8-util` 2.3.2 does
     use `BigInt64Array`.
  2. The same bundle contains one `??=` (logical assignment, Chrome 85, Firefox 79, Safari 14). esbuild 0.28.2 with
     `--target=chrome80,firefox78,safari14.1 --log-level=warning` exits 0 with no diagnostic and lowers it away
     (0 occurrences in the output). Used in 4.1 row 27.
  3. Tree reads ("tree" below): `src/loader/torrent.js` switches a tracker that closes within 5 s of a `scrape` to a
     `numwant: 0` announce; the v0.1 `SANDBOX_HUB` and `HUB_CSP` flags are absent from `src/` (`src/loader/render.js`
     keeps a `hub-shared` sandbox string for ARCH §3.3's demo); `src/sdk/sdk.js` still exposes `identity.export`,
     `identity.import` and `consent.accept` to site code.

### 0.3 Citation form

`R01`-`R06` = the 2026-10-14 files, with their own finding ids (`R02 F1`, `R03 F-07`, `R03 R-02`, `R04 G13`, `R05 Q2`,
`R01 3.2 #4` = item 4 of R01 section 3.2). `w1-07`-`w1-13` = the 2026-10-17 files (`w1-10 F12`, `w1-08 R-01`,
`w1-10 REC-5`, `w1-08 G-12`); `w1-07 VERIFY claim 8` = claim 8 of that VERIFY file. `§` = a section heading of the
cited file. `ARCH §8` = section 8 of ARCHITECTURE.md v0.2; `DR 16` = numbered item 16 of DESIGN-REVIEW, `DR §4.5` =
its section 4.5, `DR S1` = its item S1. Wave-2 files are cited by prefix (`w2a-07 F1`). Ids `D1`-`D38` (section 2)
and `P0-1` to `P3-11` (section 3) belong to this digest.

### 0.4 Precedence when sources disagree (applied in 4.1)

1. A -VERIFY file beats its first pass, and a later re-measurement of the same question beats an earlier one.
2. An executed experiment beats source reading, which beats vendor docs, which beat blogs and secondary sources. A
   measurement counts only for what it measured (example: a silent esbuild target run is not a parse test, 4.1 row 27).
3. The topic-owner file beats a passing remark elsewhere: trackers R02 (later w2b-01); WebRTC and relays R03 (later
   w2b-03); Service Worker R04; DoH R05; site ledger R06; mobile numbers w1-08; hosting w1-10 (later w2a-07); security
   w1-11; signaling w1-12; executed toolchain facts w1-13.
4. For a timing that bounds a safety mechanism (kill-switch reach, teardown), plan with the conservative figure until
   re-tested.
5. ARCH v0.2 and DR stay normative. Where research contradicts them on evidence, this digest names the amendment
   (marked CONFLICT); product trade-offs are flagged as owner decisions, not settled here.
6. Merging recommendations: where the two halves or their sources gave the same work different priorities, the higher
   priority wins unless the row says why not. One effort scale: S = up to a day; M = two days to a week; L = more
   than a week, or real-device work. (w1-07 used S = days, M = 1-3 weeks; its items were converted.)

### 0.5 Evidence limits shared by every file

No real phone was used. Firefox never ran: R01 downloaded Firefox 158 but could not mount it, and in every
2026-10-17 session Playwright Firefox 157 exited with "Could not find profile folder" on this Mac; Firefox and Safari
statements in R04 come from WPT and engine source. Playwright WebKit 27.2 runs pages and Service Workers but gathers
no ICE candidates here, so there is no WebKit WebRTC result. All WebRTC timings are loopback. The shared web-search
budget ran out in every 2026-10-17 session, so open-ended searches are missing. The 01-06 harnesses predate
`docs/DEV-NETWORK.md` (5.3).

---

## 1. Executive verdict

1. **The engine is `webtorrent@3.0.21`: browser-side it is WebRTC-only, BitTorrent v1 only, and it needs two
   polyfills first.** It has been npm `latest` since 2026-07-27 and still was on 2026-10-17. The exact ES-module
   `dist/webtorrent.min.js` (222,929 B; 64.4 KB gzip; 55.9 KB brotli) finds peers only through `wss://` trackers and
   web seeds and supports SHA-1 `btih` only (R01 summary 1-4, F1-F9). It calls the ES2026 `Uint8Array` base64/hex
   methods unguarded, so without a 2.4 KB polyfill (78/78 test262 cases) `new WebTorrent()` fails on about 8.5 % of
   global traffic. DR 16's declared floor (iOS/Safari 15.4, Chromium 110, Firefox 115 ESR) stands, and keeping ECDSA
   P-256 keys fits it (w1-08 F-03 to F-06, F-24, matrix; DR 16; 4.3 row 1).
2. **The web seed is the floor; peers are the accelerator.** With `xs=` (the `.torrent` URL) and `ws=` in the pointer,
   metadata and data arrived in 205 ms with nobody else online; `ws=` alone never got metadata (R01 F10, lab e3).
   Every stalled precedent (ZeroNet, Maelstrom, Beaker, PeerWeb, the paid pinning services) lacked always-on seeding;
   what survived (PeerTube's HLS plus P2P Media Loader, Shipyard's GitHub Pages plus CI) is origin-first (w1-07 F21,
   R1, R2). Direct WebRTC is probabilistic: plan for 15-30 % of peer pairs needing a relay, cellular CGNAT worst, with a
   STUN-only default (R03 summary 1-3, F-10, R-01; w2b-03 F-01 later puts the consumer band at 10-30 %). Make `ws=` and
   `xs=` mandatory in `publish`, race web seed and peers from t=0, and document a pinner.
3. **WebTorrent's own request headers, not the hosts, break most web seeds.** Its `Cache-Control` and `user-agent`
   headers force a CORS preflight on every piece request, which GitHub Pages (405), Netlify, Vercel, jsDelivr and
   cdnjs failed on the deployments measured (w1-10 Summary 2-5, F8-F12). Stripping both in our own bundle removed every
   preflight in Chromium 156 and WebKit 27.2 (w1-13 checkpoint 2) and raised usable hosts from 6 to 13 of 24 (w2a-07
   Appendix C, which promotes the strip to P0). w1-10's second hazard, `Range` cut from compressed bytes, does not occur
   in browsers, which send `Accept-Encoding: identity` with `Range` (w2a-07 F1 supersedes w1-10 F12); what remains are
   hosts that ignore `Range` (cdnjs, Cloudflare Pages) or cut it from a compressed stream (jsDelivr), and WebTorrent
   accepts any 2xx without checking `Content-Range`. A web seed must answer a real preflight and return `206` with
   identity bytes (R01 F10; w1-10 F8-F12).
4. **Own the Service Worker; the origin is the only isolation boundary; only a new 200 worker script reaches installed
   workers.** The stock `client.createServer()` SW cannot render a website (CSP `frame-ancestors 'none'`, documents
   forced to download, 0/120 correct answers once a second tab is open); use our own SW and a same-URL, same-origin
   iframe (R01 F18-F20; R04 summary 2-4, F11, F12). Frames sandboxed without `allow-same-origin` bypass the SW in Chrome
   155, Firefox 158 and Safari 27, and `allow-scripts allow-same-origin` is inert, so one origin per untrusted site is
   where every serious gateway converged; a multi-publisher hub needs its site origins on a separate registrable domain
   with a wildcard PSL entry (w1-11 F1-F4, R2, R3; w1-07 F23; w1-07 VERIFY claim 7), and the PSL entry does not stop a
   Safe Browsing listing of the parent from covering every label (w2b-06-VERIFY claim 7). Edge 404/410/5xx answers
   leave installed workers running; a replacement or self-unregistering worker evicts at the next update check, for
   visitors who return online. DR 20's kill switch is right; its reach is limited and must be documented (w1-07 VERIFY
   claim 8, tested in Chromium and WebKit).
5. **Discovery: four public trackers, one ordered list, and a rendezvous swarm for the site ledger.**
   `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua` and `open.ftorrent.com` passed a full
   offer/answer relay on 2026-10-14; none has an SLA, idle sockets are cut after 125-185 s, ten historic hosts are dead
   and `tracker.files.fm` is origin-locked (R02 summary 1-7, R1). Ship one identical ordered list in the signed pointer
   plus the owner's own tracker. Keep ledger gossip on `mw_chain1` over WebTorrent wires and add a bare-infohash
   rendezvous swarm: metadata-less wires worked 15/15 locally and 18/20 on live trackers, while ARCH §5.5's one-piece
   anchor torrent failed when peers joined together (0/15 local, 0/10 live) and never paired on
   `tracker.openwebtorrent.com`. No Trystero, P2PT, bugout, upstream simple-peer, js-libp2p or Hyperswarm in v1; enforce
   WebRTC connection caps ourselves, set `reqq`, never `throttleUpload(0)` (w1-12 F20-F25, F32).
6. **There is no private mode, and consent must come before the first announce and the first DoH lookup.** Peers,
   trackers and STUN operators see each visitor's public IP and the infohash; mDNS hides only LAN addresses; CSP
   cannot stop hosted-site code from opening its own peer connections (R03 summary 7, F-17, F-38; R02 F23). Page JS can
   read a DNS pointer only through CORS-enabled DoH: Cloudflare, Google and dns.sb (JSON and wire), plus AliDNS,
   Control D and DNS4EU in limited forms; Quad9, NextDNS, AdGuard, Mullvad and OpenDNS are unusable. The resolver sees
   the hostname and the visitor IP, Google forwards the visitor /24 unless told not to, and DNSSEC `AD` exists for only
   about 4-5 % of .com zones (R05 summary 1-7), so the consent gate must also cover the DoH lookup (w1-11 F18, F32).
7. **Phones share only while visible, and several platforms need a degraded path.** iOS reports nothing about network,
   battery or memory: default to download-only on any network not proven unmetered, rebuild the client (not
   `resume()`) after more than 10 s hidden, cap mobile sites at 48 MiB (24 MiB metered), and treat Safari tab storage,
   identity key included, as a cache (ITP; `persist()` resolves false); ARCH §8 needs amending (w1-08 Summary 2-6,
   Mobile policy v1). Safari Lockdown Mode removes `RTCPeerConnection`, Service Workers and the Cache API; WKWebView
   in-app browsers have no SW; Tor Browser and Brave Tor windows have no WebRTC; iOS stops WebRTC within seconds of
   backgrounding; Firefox private windows have SWs only from Firefox 140 (R03 F-21, F-24, F-33; R04 F15).
8. **The site ledger is the right primitive, and the security P0 list is short and concrete.** A browser proof-of-work
   "blockchain" is unsound (one RTX 4090 is about 1,650x a 5-Worker M3 browser) and no browser chain client can host
   application data; build a signed, hash-linked op-DAG with deterministic order, owner moderation and no consensus,
   in-house, gossiped on BEP-10 extensions of the torrent's own wires (R06 summary 1-4, 9; F55). Hashcash is only a fee.
   Before freezes: read the wire length prefix unsigned and cap it before buffering (worst case 2 GiB-1, not 4 GiB);
   salt the redaction commitment before `block.js` freezes; keep key export and the consent grant out of the
   site-callable SDK; give multi-publisher hubs a denylist and a takedown process; bind the SHA-256 `files.json` to the
   signed pointer, because a SHA-1 chosen-prefix collision now costs on the order of $10k and anyone who contributes
   bytes can prepare a bait-and-switch pair (w1-11 §4 P0, F7-F12, F28-F30, F38).
9. **`magnet:` links can be claimed only on desktop Chromium-family browsers and desktop Firefox.** The universal form
   is `https://<hub>/#btih:<hex>` plus a paste box and a QR code. `/#%s` keeps the magnet out of HTTP requests and host
   logs, but the Service Worker and any redirect target still see it (w1-09 Summary 2-5; w1-09 VERIFY claims 5-8).
10. **v0.2 adopted most of this, but eight research-backed amendments are open, and the biggest unknowns need devices or
    counsel.** Open: the 90 s `scrape` keepalive (`tracker.openwebtorrent.com` closes the socket on `scrape`), the
    anchor torrent (ARCH §5.5), the mobile defaults (§8), the hard floor and preflight facts (§1), the "4 GiB" wire test
    (§12 test 11), the unsalted `vh` (§6.1), site-callable consent and identity export (§3.4.9, §9), and the demo wording
    (§11) (4.1; P1-24). The weakest links are iOS persistence (WebKit CryptoKey/IndexedDB bugs, the 7-day deletion,
    all-or-nothing eviction), hashcash being only a fee, and availability when no peer is online (R06 summary 5-7, 10).
    Unknowns: real devices, Firefox, WebKit WebRTC, WAN timings, and the never-researched topic 14, so consent,
    takedown and the hub operator's role still need counsel. w1-13 is a draft.

---

## 2. Decisions

### 2.1 Decisions table

"Status in v0.2" compares the decision with ARCH v0.2, INTERFACES v0.2 and DR. "New" means the v0.2 text does not
contain it; the recommendation that carries it is named.

#### 2.1.1 Engine, publishing and the web seed

| # | Decision | Evidence | Source file § | Status in v0.2 |
|---|---|---|---|---|
| D1 | Pin `webtorrent@3.0.21` from the sha512-checked tarball; vendor `dist/webtorrent.min.js` with SRI `sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7`; never `@latest`, the README URL, or esm.sh | README's `cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js` serves v1.9.7 (895,775 B UMD with a `window.WebTorrent` global); esm.sh serves its own rebuild; jsDelivr, unpkg and the tarball are byte-identical; no `window.WebTorrent` in 3.x | R01 F1, F2, 3.2 #14 | Adopted (ARCH §1); local sha256 matches R01 (0.2) |
| D2 | Ship WebTorrent inside our own SRI-checked loader bundle with four hash-asserted, exactly-once patches: wire length cap; drop `Cache-Control` and `user-agent` in `webconn.js`; drop `user-agent` in `_getMetadataFromServer` and in parse-torrent `remote()` | `import()` has no integrity option; the patched bundle gave zero preflights in Chromium 156 and WebKit 27.2 and still transferred a torrent; with stubs it is 219-226 KB raw against the official 223 KB; the header strip raises usable web-seed hosts from 6 to 13 of 24 | w1-10 F28-F29, REC-5, REC-7; w1-13 checkpoint 2; w2a-07 R1, Appendix C | New: header strip P0-9, full bundle P1-1; until then D1's vendored file |
| D3 | BitTorrent v1 only; reject `btmh`-only pointers; filter `.pad/` entries | BEP 52 not implemented (#1117 open since 2017-04-26); `btmh`-only gives `Invalid torrent identifier` (lab e3); parse-torrent rejects v2-only `urn:btmh:` magnets; WebTorrent fetches `.pad/<n>` as ordinary files and never completes if the host answers 404 | R01 F9, F22, 3.2 #6; w1-13 (magnet-uri, BEP 47) | Adopted (ARCH §1) |
| D4 | Deterministic publishing: an explicit sorted file array (never directory input), `fullPath`, `name`, explicit `pieceLength`, explicit `announce` (v0.2 passes `[]`) and `urlList`, no `private` key in `info` (even `false` changes the infohash), a pinned non-zero `creationDate` passed as a `Date`; exempt the reserved `.mw/` files and `.well-known/` from the dotfile filter | File order, `name`, piece length, `private` and `info` extras change the infohash; dates, comments, trackers and the URL list do not; directory input drops every dot-path and uses `readdir` order; `creationDate` of `0` or `new Date(0)` is silently replaced by now and a plain number is read as milliseconds; create-torrent's default tracker list includes the dead `tracker.btorrent.xyz` | R01 F22, 3.2 #6; w1-13 create-torrent; w1-10 F8, REC-9 | Adopted in principle (ARCH §10, `publish.mjs`); dot-path and `Date` handling are new (P1-4); torrent `name` across versions is an owner decision (4.1 row 39) |
| D5 | Every pointer carries `xs=`, `ws=` and the full `tr=` list, and the loader merges `tr=`, never strips it; `publish` refuses a pointer without `ws=` and `xs=` unless `--peers-only`, which prints "only loads while another visitor is online"; the loader fetches the routing manifest and entry HTML from the web seed at t=0, in parallel with the announce, and never blocks first paint on discovery | `ws=` only: 0 peers and no metadata after 6 s; `ws=` plus `xs=`: done in 205 ms; the browser build has no other discovery; Beaker and PeerWeb first paint stalled on "Connecting to peers"; every stalled system lacked always-on seeders, and survivors are origin-first (PeerTube 6.0.0 removed its WebTorrent player; P2P Media Loader rides on HLS) | R01 F10, 3.2 #4; R02 R1; w1-07 F1, F5, F12, F19, F21, §6 R1, R2; w1-07 VERIFY claim 4; DR 13 | `xs=`, `ws=`, `tr=` adopted (ARCH §0, §4); the publish refusal and the t=0 race are new (P0-2) |
| D6 | Web-seed HTTP contract: `OPTIONS` answers 2xx with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD` (w1-10 also lists `OPTIONS`), `Access-Control-Allow-Headers: *` (or at least `range, cache-control, user-agent`) and `Access-Control-Max-Age`; a ranged `GET` answers `206` with identity bytes, a `Content-Range` whose total equals the file length and no `Content-Encoding`; no redirects; a missing path answers 403 or 404, never the SPA shell | No CORS, or ACAO only: 0 bytes; full answer: 300,000 B in 204 ms (lab e3); Chromium preflights `cache-control`; WebKit also sends `user-agent` in the preflight of the `xs=` fetch (w1-13); S3 `AllowedHeaders: ["Range"]` fails every request; WebTorrent accepts any 2xx body without checking `Content-Range`; a preflight cannot be redirected | R01 F10, 3.2 #5; w1-10 Summary 2-4, F8-F12, REC-1; w1-11 F33; w1-13 `xs=` table; w2a-07 F1 | Adopted (DR 14, `Allow-Headers: *`); assertions P0-3 |
| D7 | Web-seed hosts: R2 on a custom domain, B2 behind Cloudflare (terms caveat), S3 + CloudFront; never cdnjs (ignores `Range`), Cloudflare Pages (documents 200 for every `Range`) or jsDelivr (cuts the range from the brotli stream and labels it identity). GitHub Pages, Netlify and Vercel fail the stock preflight; once the client sends no non-safelisted header (D2), GitHub Pages' `ACAO: *` GETs pass CORS and its ranges are correct in browsers, so it becomes a candidate if the seed doctor passes and its terms allow the use (5.5) | Measured `OPTIONS` and `Range` behaviour on live hosts; zero-egress stores win the cost model by one to two orders of magnitude; browser matrix of 24 hosts | w1-10 F12, F20-F23, F34, REC-3, REC-7; w2a-07 F1, Appendix C; current host matrix: `MIGRATION-DIGEST.md` §11 | New (deploy guidance; P0-3, P2-8) |
| D8 | "Uploads off" = choke lock; never `uploadLimit: 0` or `throttleUpload(0)`; `torrent.pause()` is not "stop uploading"; the throttle is client-global | The throttle sits in front of every outbound byte: a downloader with `uploadLimit: 0` never got metadata in 10 s, 512 B/s finished in 732 ms (lab e12); `throttleUpload(0)` delivered 0 of 15 gossip frames (lab e10) and froze 0 of 30 frames on every wire of the client | R01 F25, 3.2 #9; w1-12 F15, F18, R6 | Adopted (ARCH §1, §8; shaping only at 32 KiB/s or more; P0-6) |
| D9 | Own the chunk store: `MemoryChunkStore` plus Blobs we keep; never the default OPFS `fsa-chunk-store@1.3.0`, never `idb-chunk-store@1.0.1`, never an OPFS directory named `chunks`; on phones an explicit memory-bounded store | Importing the bundle deletes OPFS `chunks` (lab e6); `getDirectory()` throws in Firefox private windows; idb-chunk-store needs a global `Buffer` and its read callback never fires (lab e9); a 25-line Uint8Array IndexedDB store re-added a torrent in 52 ms (lab e8); peak memory about 95 MB + 2.7x site size | R01 F11-F14, 3.2 #3; w1-08 F-16, F-17 | Adopted (ARCH §1); mobile path P1-13 |
| D10 | Download the whole torrent (no select or deselect); drive progress from events; cap size on `'metadata'` | #3083 shared-piece hang; #3104 null piece | R01 F16, 3.2 #7 | Adopted (`maxSiteBytes`, ARCH §8); partial download P2-7 |

#### 2.1.2 Serving, origins, shell and updates

| # | Decision | Evidence | Source file § | Status in v0.2 |
|---|---|---|---|---|
| D11 | Never `client.createServer()` or `sw.min.js`; our own classic-script SW at the origin root, `updateViaCache: 'none'`, JS MIME, `no-cache` | Stock responses carry `frame-ancestors 'none'`; `destination === 'document'` gets a `DOWNLOAD` attachment; broadcast-to-all-windows race (0/120 with a second tab, lab e2); `!req?.type === 'webtorrent'` precedence bug; Firefox 5 s stream cut; module SWs need Firefox 147+ | R01 F17-F21; R04 F7, F8, R3 | Adopted (`/mw-sw.js`, ARCH §5.2, §7.1; P0-4) |
| D12 | Shell mode = top-level loader shell plus a full-viewport same-URL same-origin iframe; the SW dispatches on `request.destination` (`document` to shell, `iframe` to site) | Works in Chromium 156 including after a hard reload; the address bar keeps the real site URL | R04 R2, F12, F23 (lab D, E) | Adopted (ARCH §3.1, §7.2) |
| D13 | Isolate untrusted sites only by origin: no `sandbox` without `allow-same-origin` on a SW-served frame; one origin per untrusted site; the shared-origin hub is a localhost demo or single-publisher mode behind the gate | WPT `sandboxed-iframe-fetch-event` 29/29 on Chrome 155, Firefox 158, Safari 27; labs: the opaque frame goes to the network and `navigator.serviceWorker` throws; `allow-scripts allow-same-origin` is inert; ZeroNet and PeerWeb paid for shared origins | R04 F11, R1; R01 F18.3, F20; w1-11 F1-F3, F5; w1-07 F2, F19, F23; DR 6 | Adopted (ARCH §1, §3.2, §3.3); tree: v0.1 flags removed (0.2, P0-12) |
| D14 | Multi-publisher hubs: site origins on a separate registrable domain, a wildcard PSL entry (MUST), a wildcard certificate on a host with wildcard routing, no cookies on the apex; the PSL entry isolates cookies and storage but not Safe Browsing reputation, so abuse operations are part of the launch | Without the PSL, sibling subdomains are same-site (cookie tossing); a shared domain concentrates reputation risk (w1-11 F4, medium confidence); Chromium and Firefox do not use private-section PSL entries in Safe Browsing lookups, so a parent listing covers every label | w1-11 F3-F4, R3; w1-10 F24-F25; w1-07 VERIFY claim 7; w2b-06-VERIFY claim 7 | ARCH §3.2 says the hub "should" be on the PSL; MUST, the separate domain and the Safe Browsing caveat are new (P0-13) |
| D15 | Hub labels: one DNS label of at most 63 octets, base32, never hex of a 32-byte digest; `label = base32(sha256(ledgerId))[0:32]` for signed pointers (stable across releases) and `base32(btih)` (32 chars) for bare magnets | RFC 1035 limit; 32 bytes = 64 hex > 63; full base32 of 32 bytes is 52 chars (ar.io's sandbox labels); IPFS answers HTTP 400 above 63; the ledger id must stay stable while the infohash changes on every publish; 32 base32 chars = 160 bits with one canonical spelling | w1-07 F23, R4; w1-07 VERIFY claim 7; R04 R1; R06 3.1.1; DR 6; w2c-04 Summary 3 | Adopted (ARCH §3.2, DR 6); 32 chars kept (4.1 row 9) |
| D16 | Shell layout: root `index.html`, `404.html`, `/mw-sw.js` and the manifest `no-cache` and invalidated on deploy; everything else under `/v/<build-id>/` as `immutable`; precache in normal cache mode; required and optional precache lists; the SW script from the page origin with a JS MIME type | CDN edges hold stale workers (24 h CloudFront default); `cache:'reload'` doubles the first-visit shell; a missing required asset breaks offline silently; a stale CDN copy bricked the IPFS SW gateway (issue #1155, July 2026) | w1-10 F31-F33, REC-6; R04 G13, G14, R6; DR 20 | Partly (ARCH §13 "immutable versioned assets"; DR 20); layout P1-2 |
| D17 | Kill switch = a 200 self-unregistering `/mw-sw.js` delivered through the update path; an edge 404/410/451 only stops new installs | Experiment in Chromium 156 and WebKit 27.2; IPFS removed its worker TTL in July 2026 | w1-07 VERIFY claim 8; w1-11 F37; DR 20 | Adopted (DR 20); reach documentation P0-4 |
| D18 | One engine per origin: elect a leader with Web Locks plus BroadcastChannel | `SharedWorker` absent on Samsung Internet and only from Chrome Android 148; stock-SW tab race; the OPFS `chunks` wipe hits every tab | R06 F24; R04 G19, G21; R01 F19 | Adopted (ARCH §5.9) |
| D19 | Boot checks: secure context, dynamic `import()`, `crypto.subtle`, `BigInt`, `ReadableStream`, IndexedDB are hard; `RTCPeerConnection` and `serviceWorker` are soft checks that select host-only or degraded mode; degraded mode also when `navigator.serviceWorker.ready` has not resolved within a timeout | Torrent SHA-1 hashing uses `crypto.subtle` with no JS fallback; `ws://` trackers are skipped on https pages; Lockdown Mode, WKWebView, Tor; with SWs blocked the API exists, `register()` resolves and `ready` never does | R01 F5, 3.2 #13; R03 R-10; R04 R6, R7; w1-08 F-25, F-26, F-28, R-10; w1-13 Playwright facts | Adopted (ARCH §5.1, §7.4); the `ready` timeout is new (P0-2) |
| D20 | Browser floor = DR 16 (iOS/Safari 15.4, Chromium 110, Firefox 115 ESR) with the base64/hex and `AbortSignal.timeout` polyfills first in `boot.js`; Tier 1 tests on iOS 16.4, Chromium 110, Firefox 115 ESR, Samsung Internet 21 | Construction fails without the methods; the polyfill passes 78/78 test262 cases on V8 and JavaScriptCore; a missing `AbortSignal.timeout` makes every web-seed request fail silently | w1-08 Summary 1, 9, R-01, §Minimum-browser matrix; R01 F4; DR 16 | Adopted (DR 16, ARCH §5.1); the "refuse below" floor is corrected in 4.1 row 27 (P0-7) |

#### 2.1.3 Peers, signaling and the site ledger

| # | Decision | Evidence | Source file § | Status in v0.2 |
|---|---|---|---|---|
| D21 | `RTCPeerConnection` lives on the page main thread; the SW relays to the page over `MessageChannel`; open data channels may move only to dedicated workers | `[Exposed=Window]`; measured absent in Chromium dedicated Workers; transferable `RTCDataChannel` Chrome 130, Firefox 144, Safari 15 | R03 F-37, R-09; R04 F16; R06 F24 | Adopted |
| D22 | Wire extension: `wire.use()` inside a `'wire'` listener attached synchronously to the `Torrent` returned by `client.add()`, plus a walk of `torrent.wires`; attach `mw_chain1` only to `webrtc` wires; send only once `peerExtendedMapping.mw_chain1` exists; gossip frames at most 15 KiB | The extended handshake is sent once; in Chromium an extended message whose payload plus the 1-byte extension id exceeds 262,144 B silently destroys the connection (a 262,143 B payload arrives; lab e4); Firefox assumes 64 KiB when the remote omits `max-message-size`; RFC 8831 says 16 KB | R01 F23, F24; R03 F-25, R-06; w1-12 gotcha 2, R5 | Adopted (`mw_chain1`, frames at most 15 KiB; ARCH §6.6, §13; P0-5) |
| D23 | Read the wire length prefix unsigned and cap it at 256 KiB before buffering; a buffer watchdog; `ut_metadata.cancel()` on rendezvous wires | `bittorrent-protocol` reads the prefix as a signed 32-bit integer: `0x7FFFFFFF` gives quadratic CPU and 8 GiB RSS, `0x80000000` and above desync as keep-alives; a hostile `metadata_size` costs 10 MB and 1,833 requests per wire | w1-11 F11-F12; w1-12 F14, F20a; confirmed by w2b-05 F41 and w2c-05 Summary 2 | 256 KiB cap adopted (ARCH §1, §13); unsigned read and test cases new; ARCH §12 test 11 says "4 GiB" (P0-5) |
| D24 | Enforce WebRTC connection caps in the `'wire'` handler (WebTorrent `maxConns` limits only TCP dials) and advertise `reqq` | `maxConns: 2` still gave 4 wires; head-of-line p50 0.5-0.7 s and p99 up to 4.3 s without `reqq`, median 3-14 ms with it; Chromium allows 500 live `RTCPeerConnection`s per renderer | w1-12 F15-F18; R03 F-31; ARCH §1 | Wire cap adopted (30/10/6, ARCH §8); `reqq` and per-swarm caps new (P0-6, P1-9) |
| D25 | Site ledger = signed hash-linked op-DAG, deterministic order, owner moderation ordered by the owner's sequence (never timestamps), no consensus, never called "blockchain"; built in-house; OrbitDB 4.0.0, Peerbit 5.4.10, Yjs + y-webrtc 10.3.0, automerge-repo, Gun, Hypercore and SSB are design references only | PoW chains need an honest hash majority; browser chain clients (Helios 0.12.0, Lodestar light-client 1.43.0, smoldot 3.7.0) verify someone else's chain through servers; OrbitDB oplog, Merkle-CRDTs and Byzantine Eventual Consistency are the models; OrbitDB needs Helia + libp2p and a relay; y-webrtc last released 2023-12-28 and all 3 default signaling servers are dead; automerge-repo `latest` tag = 2.6.0-alpha.3 with no WebRTC adapter; the Hyperswarm browser relay says "Do not use it in production" | R06 summary 1-3, 3.1, 2.5, F18-F33 | Adopted (ARCH §6; DR §4.1; `src/chain/*`) |
| D26 | Ledger rendezvous = bare infohash `sha1("mw-ledger/1/" + ledgerId)` announced with `left: 1`, never seeded; drop the one-piece anchor torrent; gossip rides `mw_chain1` on content and rendezvous wires | Metadata-less wires: 15/15 local, 18/20 live (the misses were one novage outage); the one-piece torrent connected 0/15 and 0/10 when peers joined together and never on `tracker.openwebtorrent.com`, which does not forward offers between two seeders; wires stay open (140 s idle), which is DR S1's condition | w1-12 F20-F25, R1-R2; R06 F55; R01 3.2 #8; DR S1, DR §6 | CONFLICT with ARCH §5.5, §14 and INTERFACES `addAnchor` (4.1 row 22; P0-11) |
| D27 | No second discovery plane in v1: no Trystero, P2PT, bugout, upstream simple-peer, js-libp2p or Hyperswarm; a Nostr plane is an optional P2 adapter; never MQTT | Trystero 0.26.0 changed its wire format and has no room cap; bugout is abandoned; browser libp2p needs relay servers at 2x WebTorrent's size; `dht-relay` archived 2026-10-15; Trystero's 4th and 5th default torrent trackers are dead or origin-locked; public MQTT brokers sit on DNS block lists | w1-12 F1-F12, F28-F32; R02 F18, F19, R5; w2b-01 correction 4 | Not adopted, consistent with v0.2 (gossip rides torrent wires; P2-3) |
| D28 | Signed bytes are RFC 8785 canonical JSON; hash and verify the bytes as received; never derive ids from signatures | Safari's Ed25519 signatures are randomized; re-serialisation breaks hashes; JCS rejects lone surrogates, NaN and integers beyond 2^53 | R06 F42-F46 | Adopted (`canonical.js`, `h = sha256(canonical(e))`) |
| D29 | ECDSA P-256 for owners, authors and pointers; no X25519 keys in IndexedDB without a wrapped-JWK fallback; Ed25519 later | R06 recommended Ed25519 (WebCrypto Chrome/Edge/WebView 137, Firefox 129, Safari 17, Samsung Internet 30) with `@noble/ed25519` 3.2.0 as fallback; R06 F50 calls P-256 the universal fallback (Chrome 37, Firefox 34, Safari 7; verify about half as fast); P-256 needs no fallback library and works on Chrome < 137, Samsung Internet <= 29 and iOS 16; X25519 fails the IndexedDB round trip in WebKit (bug 312279) | R06 F45-F50; w1-08 F-24, F-32, R-07 | Changed from R06: P-256 (ARCH §4, §6.1); Ed25519 deferred (DR §3; P3-2) |
| D30 | Hashcash is a fee: synchronous JS SHA-256 in Workers (not a `crypto.subtle.digest` loop), target committed in the entry, default 16 bits, mined only after Submit with progress and cancel | The WebCrypto loop is 4.6x slower on an M3; naive phone loops run about 40-120 kH/s; one GPU mints about 3x10^5 entries/s at 16 bits; a 16-bit mint over v0.2's header takes 38.8-48.8 ms with 5 Workers in Chromium 156 | R06 F36-F41, 3.1.6; w2b-04-VERIFY claim 5 | Adopted (16 bits, DR 4; ARCH §6.1) |
| D31 | Salted redaction commitment: `vh = sha256("mw-vh-v1\n" + z + canonical(v))` with a fresh 128-bit `z` carried beside `v` and dropped with it on tombstone; never reuse the Hashcash nonce | EDPB Guidelines 02/2025 v2: a hash of personal data is personal data, and an unsalted hash is not sufficient | w1-11 F28-F30, R4 | CONFLICT with ARCH §6.1 (`vh = hex(sha256(utf8(canonical(v))))`, unsalted); amend before `block.js` freezes (P0-14) |

#### 2.1.4 Identity, consent, pointer and links

| # | Decision | Evidence | Source file § | Status in v0.2 |
|---|---|---|---|---|
| D32 | Identity key in its own IndexedDB store, round-trip self-tested at creation, JWK or seed fallback; `navigator.storage.persist()` requested from the consent click; export and import only in loader-owned UI (closed shadow root, `isTrusted`, transient activation); the site-callable SDK has no `identity.export`, `identity.import` or `consent.accept` and gains `mw.consent.request()` | WebKit 177350 (CryptoKey inside an indexed record), 312279 (non-extractable X25519 comes back `null`), iOS ECDSA `DataCloneError` reports (open-chat #9343); in per-domain and drop-in modes site code runs with loader privilege; a non-extractable key is usable, and can even be structured-cloned to another origin, by any same-origin script | R06 F51-F53, 3.1.8; w1-11 F38, R5; w2c-03-VERIFY claim 1 | Key storage adopted (ARCH §6.1); the SDK restriction is a CONFLICT with ARCH §3.4.9 (a drop-in site "calls `mw.consent.accept()`") and §9; the tree still exposes all three calls (P0-14, P1-14) |
| D33 | Consent before the first tracker or peer connection and before the DoH lookup (or an explicit `dns=1`); a host-only choice; no privacy claim anywhere | Peers, trackers and STUN operators see each visitor's public IP and the infohash; mDNS hides only LAN addresses; CSP cannot stop hosted-site code from opening its own peer connections; DoH sends the visitor IP and the hostname to a third party outside the gate | R03 F-17, F-38, R-11; R02 F23; R05 F13; w1-11 F18, F32, R6 | Adopted for trackers and peers (DR §4.5, ARCH §8); the DoH part is new (P0-10, P1-7) |
| D34 | Pointer authenticity = owner P-256 signature + TOFU pin + `seq` + `exp`; resolvers queried sequentially (Cloudflare, then dns.sb, then Google; 4 s timeout; `mw-doh` override); on a first visit, `<meta>` and DNS carrying different owner keys is a hard stop; DNSSEC `AD` is informational | A resolver can only withhold or replay, and replay is bounded by `seq` and `exp`; `AD` means something only over a secure channel to a trusted resolver; about 4-5 % of .com zones are signed | R05 R2, summary 1-7; w1-11 F31-F32, R13; ARCH §4; INTERFACES `doh.js` | Adopted except the first-visit hard stop (P2-10); DoH hygiene P1-12 |
| D35 | Bind the SHA-256 list `/.mw/files.json` to the signed pointer (`fj=`) and verify files against it | A SHA-1 chosen-prefix collision costs on the order of $10k (2025 re-estimate); anyone who contributes bytes to a published torrent can prepare a bait-and-switch pair; webtorrent has no BEP 52 | w1-11 F7-F10, R10; R01 F9 | New: ARCH §3.4.1 and §10 write `files.json` but use it only for cross-version reuse (P1-5) |
| D36 | Magnet links: universal form `https://<hub>/#btih:<hex>`; handler template `/#%s`; opt-in registration only on the hub apex, on desktop, from a click; never auto-load | Only desktop Chromium-family browsers and Firefox support the API; Firefox Android has a no-op method; Android Chromium has it compiled out; Safari and every iOS browser lack it; the fragment stays out of requests but not out of the SW | w1-09 §2, F1-F9, F19-F20; w1-09 VERIFY claims 5-8; w1-11 T2 | Link form adopted (ARCH §3.3); the protocol handler is LATER (DR §3; P0-15, P1-15, P2-11) |
| D37 | Phone demos only over HTTPS or localhost forwarding, with the tracker proxied as `wss://` on the same server; agent-run tests stay on 127.0.0.1 | LAN `http://` is not a secure context (no SW, no `crypto.subtle`, so WebTorrent cannot hash pieces); DEV-NETWORK policy | w1-10 F35-F37; `docs/DEV-NETWORK.md` | Partly (`dev-server --tls` uses mkcert, ARCH §10); ARCH §11 wording P1-21, P1-24 |
| D38 | Phones: download-only unless the network is proven unmetered; opt-in sharing per origin; on hidden record the time and lock uploads (ARCH: mobile destroys the client); on visible after more than 10 s, `online` or `pageshow.persisted`, destroy and rebuild the client and re-announce; never `tracker.update()`, `beforeunload` or `unload`; explicit memory-bounded store; 48/24 MiB caps | iOS gives no network, battery or memory signals; iOS suspends WebRTC within 5-20 s (after about a 20 s prepare-to-suspend window); stock tracker backoff is `10 s x 2^n + U(0, 5 min)`, median 171 s measured; Firefox Android clamps timers to 15 min; peak memory 2.7x site size | w1-08 F-07 to F-17, F-31, §Mobile policy v1; R01 3.2 #10; R03 F-33 to F-36, R-08; R02 R3 | Lifecycle triggers adopted (ARCH §8); the 10 s threshold, upload default and caps are a CONFLICT with ARCH §8 (2.4; 4.1 rows 23-25; P0-16) |

### 2.2 Endpoints: use and avoid

| Kind | Use | Avoid (reason) | Source | Status in v0.2 |
|---|---|---|---|---|
| WebTorrent CDN (only if not self-hosted) | `https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js`, `https://unpkg.com/webtorrent@3.0.21/dist/webtorrent.min.js` (both ACAO `*`) | any `@latest` path (v1.9.7); paths without `/dist/` (404); esm.sh (rebuild plus `process` polyfill); a SW script cannot come from a CDN | R01 F2 | Self-hosted vendored copy |
| WSS trackers | `wss://tracker.webtorrent.dev` (aquatic, Hetzner, interval 120 s), `wss://tracker.openwebtorrent.com` (Cloudflare-proxied, 120 s; does not pair two seeders), `wss://tracker.novage.com.ua` (wt-tracker-rust on Oracle A1, 180 s), `wss://open.ftorrent.com` (aquatic v0.9.0, US colo, 120 s), plus the owner's own; at least two trackers that pair seeders in every pointer | `tracker.btorrent.xyz` (A = 127.0.0.1), `tracker.fastcast.nz` (NXDOMAIN), `tracker.webtorrent.io`, `tracker.sloppyta.co`, `tracker.manager.v6.navy`, `tracker.ghostchu-services.top`, `ws.peer.ooo`, `tracker.dnlab.net`, `qot.abiir.top`, the Heroku host; `tracker.files.fm:7073` (403 unless `Origin: https://files.fm`); PeerTube trackers (registered torrents only); any `ws://` or non-443 port | R02 F1-F3, R1; R01 F8; w1-12 F21, F25, R7 | `CONFIG.trackers` = the four (INTERFACES); production pointer = owner tracker plus two public (DR 15) |
| Own tracker | `aquatic_ws` (Linux >= 5.8) or `wt-tracker` / `wt-tracker-rust`; demo: `bittorrent-tracker` 11.2.3 behind Caddy, or with TLS and no proxy via `ws: { noServer: true }`; start from w2b-01's `tracker/tracker.mjs`; host: Oracle Always Free A1 (2 OCPU / 12 GB, 10 TB/month egress) with stateless rules | Render Free (sleeps after 15 min), Fly.io (no free tier for new orgs; smallest machine $2.19/month), GCP e2-micro (1 GB/month egress); Cloudflare Durable Objects only as a prototype; R02 F13's "hardened" snippet (4.3 row 3) | R02 F13-F17, R6; w1-13 checkpoint 3; w2b-01 correction 1 | DR 15 (owner's `aquatic_ws` or `wt-tracker`) |
| STUN | `stun:stun.cloudflare.com:3478` (documented "free and unlimited", UDP only), `stun:global.stun.twilio.com:3478` (free) | `stun:stun.l.google.com:19302` (no published terms; 2014 statement: development use, no SLA); more than 3 STUN URLs | R03 F-07 to F-09, R-02 | Adopted (`CONFIG.stun`) |
| TURN | none in v1. Options measured on paper: Metered Open Relay (20 GB/month free, front-end `apiKey`), Cloudflare Realtime TURN (1,000 GB/month free shared with its SFU, then $0.05/GB; credentials at most 48 h, minted with a secret), Twilio ($0.40-0.80/GB) | any TURN secret in the loader | R03 F-11 to F-14, R-03 | "No relay (TURN) servers" (DR §4.5) |
| DoH from page JS | Cloudflare `https://cloudflare-dns.com/dns-query?name=<n>&type=TXT` with `Accept: application/dns-json`; dns.sb `https://doh.sb/dns-query` (browser-tested; aliases `doh.dns.sb`, `dns.sb`); Google `https://dns.google/resolve?...&edns_client_subnet=0.0.0.0/0` (GET, no extra headers); `https://1.1.1.1/dns-query` as a bootstrap fallback | Quad9 (JSON retired 2025-05-05; its HTTP/3 path sends no CORS headers), NextDNS, AdGuard, Mullvad, OpenDNS, DNSPod (no CORS); AliDNS for DNSSEC (`AD` always false); POST or custom headers on Google; `cd=1` anywhere | R05 F1, F4, R2-R4 | Sequential Cloudflare, then dns.sb (`doh.dns.sb`), then Google; 4 s timeout; `mw-doh` override (INTERFACES `doh.js`) |
| Second signaling plane (optional, P2) | Nostr only, lazily: relays `nos.lol`, `relay.nostrmap.net`, `0x-nostr-relay.fly.dev`, `relay.bullishbounty.com`, `relay.nostr.dev.br` through an own NIP-01 client or a pinned `@trystero-p2p/nostr@0.26.0` | MQTT `broker.emqx.io`, `test.mosquitto.org`, `broker.hivemq.com` (DNS block lists); Trystero's 4th and 5th default torrent trackers (dead, origin-locked); full Trystero in v1 (wire-format change, no room cap) | R02 F18, F19, R5; w1-12 F28, R10, R11; w2b-01 correction 4 | Not adopted (gossip rides torrent wires; P2-3) |
| Web-seed hosts | R2 on a custom domain; B2 behind Cloudflare; S3 + CloudFront; GitHub Pages only with the header strip and a passing seed doctor | cdnjs (200 for `Range`), Cloudflare Pages (200 for `Range`), jsDelivr (wrong bytes for ranges); Netlify and Vercel with the stock request (preflight fails); R2's `r2.dev` (rate-limited, development only) | w1-10 F12, F20-F23, REC-3; w2a-07 F1, Appendix C; `MIGRATION-DIGEST.md` §11 | New (D7; P0-3) |

### 2.3 Prior-art lessons, one line each

| System | Lesson for magnet-web | Source |
|---|---|---|
| ZeroNet | A shared local origin plus wrapper produced repeated sandbox escapes, and "visitors host everything" plus a central ID issuer (ZeroID) invited spam; use per-site origins, bounded hosting, per-site keys. | w1-07 F1-F3; w1-07 VERIFY claim 6 (at least nine labelled security entries 2016-2019, at most five are wrapper escapes; creator active until 2020-12/2021-01) |
| Project Maelstrom | A custom browser that seeded invisibly, with no update path, died with its funding; no install, visible seeding, mutable pointer. | w1-07 F4 |
| Beaker / Dat | Its own post-mortem: no stickiness, slow first paint, nobody online, "don't bloat your MVP"; measure first paint and keep the loader small. | w1-07 F5; w1-07 VERIFY claim 5 (the 100k-user ceiling is a guess about local indexers) |
| Pear / Holepunch | The answer to "nobody online" is always-on "blind peers"; that is our pinner. | w1-07 F6 |
| Brave native `ipfs://` | Used by under 0.1 % and removed in 2024 (three stated reasons); do not invest in native-protocol UX. | w1-07 F7; w1-07 VERIFY claim 1 |
| IPFS public gateways | Traffic came through HTTPS, yet 9.4 % of requests were browsers loading pages and 67.4 % automated clients (3-day vendor sample); an open hub becomes a free CDN unless rate-limited. | w1-07 F9; w1-07 VERIFY claim 1 |
| IPFS SW gateway (inbrowser.link) | Static bootstrap + SW + in-browser verification + one origin per site works technically and is fragile organisationally (sponsor ended 2026-09-30); a stale CDN copy of its worker bricked it (issue #1155, July 2026); it never seeds and has no WebRTC, so it is no precedent for the P2P half. | w1-07 F8, F10; w1-07 VERIFY claims 2-3; R04 G13, G14 |
| Paid persistence (Skynet, Cloudflare gateway, Scaleway, NFT.Storage, Fleek, Shipyard) | Hosted persistence keeps closing; keep the owner's own static host in the loop. | w1-07 F12; w1-07 VERIFY claim 4 (dates are announcement or transition dates) |
| Gateway abuse (Fleek, Skynet, Shipyard) | Shared gateway domains attract phishing; hubs need abuse operations from day one. | w1-07 F11, F13; w1-07 VERIFY claim 8 (figures are scoped vendor telemetry) |
| Arweave + ar.io | Pay-once immutable storage (about US$82/GiB retail incl. fees) behind a resolver you must trust; copy the base32 sandbox labels and Wayfinder's fail-open/fail-closed vocabulary. | w1-07 F14; w1-07 VERIFY claims 4, 7 |
| Swarm | Postage stamps expire like rent; no browser-resident node. | w1-07 F15 |
| ENS + eth.limo, DNSLink | A resolving gateway is a trusted middlebox (5 min cache, HTTP 451 takedowns); copy DNSLink's TXT rules: dedicated `_name`, ignore bad records, deterministic sort, CNAME delegation, about 60 s TTL. | w1-07 F16 |
| Peergos | Needs a server per user; outside our model. | w1-07 F17 |
| Freenet / Hyphanet | Local node plus a hosted on-ramp that its authors call a trust trade-off; alpha. | w1-07 F18 |
| peercloud (2015) | CSP-sandbox opaque origins break cookies and XHR; no WebRTC in a SW means a tab must stay open. | w1-07 F19; w1-07 VERIFY claim 7 |
| Planktos (2017-18) | Hobby SW loader, no streaming or sharding, "not recommended for production". | w1-07 F19 |
| PeerWeb (2025-26) | Our shape: a same-origin iframe plus DOMPurify is not isolation; demos stuck on "Connecting to peers"; one tab reportedly reached about 15 GB. | w1-07 F19 |
| `KayleePop/magnet-web` | MIT, same SW + iframe + WebTorrent idea and the same name, last commit 2022-12-14; namespace npm and GitHub identifiers. | R04 F3, R10 |
| Bugout / P2PT / Trystero | Same gossip idea; default endpoints died (`hub.bugout.link`, `tracker.btorrent.xyz`) and WebTorrent 2.x broke bugout; never depend on one free sponsored endpoint; copy bugout's idea, not its code (4.1 row 35). | w1-07 F20; w1-12 F9-F11 |
| PeerTube WebTorrent player | Removed in 6.0.0 ("the P2P aspect ... is not really used"); P2P lives on under HLS with the origin first. | w1-07 F21 |
| nsite (NIP-5A, draft) | Signed manifest plus hash-addressed blobs, but only server gateways exist; copy the order-independent aggregate hash. | w1-07 F22 |
| instant.io, qBittorrent WebUI | Both register a `magnet` handler with a fragment template; instant.io's register-on-every-load is the anti-pattern. | w1-09 F22; w1-09 VERIFY claim 5 |

### 2.4 Mobile policy: ARCH v0.2 §8 against w1-08 Mobile policy v1

w1-08 classes: `desktop`, `mobileUnmetered` (Chromium reports wifi or ethernet), `mobileUnknown` (iOS, Firefox
Android, most WebViews), `mobileMetered` (cellular, bluetooth, other, mixed, none, or `saveData`). ARCH has three
columns (desktop; Wi-Fi confirmed; unknown, cellular or `saveData`).

| Setting | ARCH v0.2 §8 | w1-08 v1 (desktop / unmetered / unknown / metered) | Digest call |
|---|---|---|---|
| maxConns (content wires) | 30 / 10 / 6 | 30 / 8 / 6 / 4 | w1-08 (each connection adds ICE consent timers, F-13); rendezvous wires come on top (w1-12 R4: 6/9 desktop, 3/5 mobile), so the combined budget is open (6.2 question 9) |
| tracker `numwant`; tracker URLs | not set (default 5) | 5 / 3 / 3 / 2; at most 2 trackers on mobile | Mobile: w1-08, with phones using the first two entries of the shared ordered list, both seeder-pairing (w1-12 R7; 4.1 row 12). Desktop: 3 (R02 R2, the tracker-cost owner; heuristic); all classes drop to 0 at the soft cap (P0-6) |
| Upload default | on 1 MiB/s / on 256 KiB/s / off until "Share on this network" | on 1 MiB/s / off (on only while charging) / off / off | w1-08 on evidence (Delivery Optimization defaults, no iOS signals); **owner decision**. w1-08's least-bad alternative: on at 32 KiB/s with 8 MiB per visit while visible |
| Upload after opt-in | shaping only at 32 KiB/s or more | 128 KiB/s; not offered on metered (Advanced override) | w1-08 |
| Upload budget per visit / month | none | none / 64 MiB / 64 MiB / 0, and 256 MiB per origin per month on mobile | w1-08, P2-6 (proposal, not measurement) |
| maxSiteBytes | 128 / 48 / 24 MiB | 128 / 48 (64 if `deviceMemory >= 4`) / 48 / 24 MiB | w1-08 (peak about 95 MB + 2.7x site size, F-17) |
| Ask before downloading more than | no | never / never / 16 MiB / 8 MiB | w1-08 |
| Hidden | desktop keeps seeding (destroy after 10 min hidden on battery); mobile destroys the client | desktop unchanged; mobile locks uploads at once | either; keep ARCH's flush of `meta` on hidden |
| Rebuild on return | visible after more than 60 s, `online`, `pageshow.persisted` | visible after more than 10 s, `online`, `pageshow.persisted`; never `tracker.update()` | w1-08 (iOS suspends within 5-20 s; reconnect waits `10 s x 2^n + U(0, 5 min)`) |
| Site cache budget | 512 MiB desktop / 128 MiB mobile | 1 GiB / 256 / 256 / 128 MiB | keep ARCH (w1-08 says its numbers are defaults, not evidence) |
| Ledger load budget | 50,000 blocks; `maxChainBytes` for snapshots | `maxLoadedBytes` 128 MiB desktop / 32 MiB mobile, newest first | add w1-08's (50,000 x 16 KiB = 781 MiB, past an iPhone's about 1.5 GB tab limit) |
| `persist()` | requested after consent | only from a user gesture; false in every Safari tab | request from the consent click; never at load for stored consent (Firefox prompts) |

Wording knock-on: DR §4.5's notice says "On Wi-Fi your browser also shares this site's files". Under w1-08 that is
false on phones by default; the phone line in DR §4.3 ("On mobile data: downloading only. Tap to share.") would need a
variant for unknown networks.

---

## 3. Prioritised recommendations (merged and deduplicated)

Priority: P0 = before any public build or before the named interface freezes; P1 = before calling v1
production-ready; P2 = soon after; P3 = optional or watch. Effort and merge rule as in 0.4 rule 6. The two halves
contributed 27 and 48 items; after merging duplicates there are 63.

### P0

| ID | Eff | Recommendation | Justifying file(s) | Status in v0.2 |
|---|---|---|---|---|
| P0-1 | S | **Fix the tracker keepalive.** `tracker.openwebtorrent.com` closes the socket on `scrape` with no reply (R01 F8; R02 F1, R4), so the 90 s `scrape` keepalive would drop one of the four default sockets every 90 s and push it into the stock reconnect backoff. Use an offer-free keepalive announce with `numwant: 0` (R02 R3 as refined by w2b-01 correction 5), or skip `scrape` for trackers that close on it. Prove it with a Node probe, not a browser. The tree already learns per tracker (a socket that closes within 5 s of a `scrape` switches to a `numwant: 0` announce), so each session still loses that socket once and the spec text is unchanged. | R02 F1, R3, R4; R01 F8; w2b-01 correction 5 | CONFLICT: ARCH §1, §8, INTERFACES `keepaliveScrapeMs: 90000`, DR 15 |
| P0-2 | M | **The web seed is the floor: cold start, availability and degraded paths.** `publish.mjs` refuses a pointer without both `ws=` and `xs=` unless `--peers-only`; the loader races web seed and peers from t=0, stays web-seed-only if no peer arrives within 3 s, and exposes source, TTFB and first paint in `site.info()`. A degraded no-SW renderer and a host-only no-WebRTC mode, each with the specific reason shown (Lockdown Mode, WKWebView, Tor, Brave Tor window, UDP blocked); select degraded mode when `!('serviceWorker' in navigator)` or when `navigator.serviceWorker.ready` has not resolved within a timeout; "Open in Safari / Chrome" with a one-line cause; UA hints only for wording. Document the pinner (`pin.mjs`) and three always-on options: Node 24 + webtorrent 3.0.21 seeds browsers without extra packages, but Node-side signalling costs a fixed 5.0 s per offer and glare (#401) dropped the working connection in the lab, so test the pinner's pairing before relying on it. Depends on P0-3. Part B ranked the detection rule P1; it is folded in at P0 (0.4 rule 6). | R01 F10; R03 R-01, R-10; R04 R7; w1-07 F5, F19, F21, R1, R2; w1-08 F-25, F-26, F-28, R-10; w1-13 Node seeder, Playwright facts; DR 13, DR 17 | Partly (ARCH §0, §5.1, §7.4); the publish refusal, the 3 s rule and the `ready` timeout are new; keep as a release gate |
| P0-3 | M | **Web-seed contract, seed doctor, host policy.** Publish D6's contract with exact JSON for S3, R2, B2 and CloudFront and say `["Range"]` fails. `tools/check-webseed.mjs` plus a once-per-session loader probe: `OPTIONS` with `Access-Control-Request-Headers: cache-control,range,user-agent` (pass with the stock client, or pass only with the patched client of P0-9); a ranged `GET` sent the way browsers send it (`Range` with `Accept-Encoding: identity`) must give 206, no `Content-Encoding`, a `Content-Range` total equal to the file length, a body of the requested length, and a piece-aligned range that matches the torrent's piece hash; no redirect (or a target that also sends ACAO); a missing path answers 403 or 404; also probe the `xs=` `.torrent` URL with WebKit's header set. Fixtures: GitHub Pages stock preflight (405), Cloudflare Pages (200 for `Range`), jsDelivr (206 with wrong bytes). A failing seed is not added, the UI names the failed check, and a dead seed is marked after the first CORS failure instead of the per-piece 10 s retry loop. Host policy as D7. w1-10's ranged check with `Accept-Encoding: gzip, br` tests what curl sees, not a browser; keep it only as a non-browser warning (4.1 row 32). | w1-10 F8-F12, F20-F23, REC-1 to REC-3; w1-13 `xs=` table; w1-11 R26; w2a-07 F1, R2, Appendix C-D | `check-webseed.mjs` exists (ARCH §10, INTERFACES); the assertion set is new |
| P0-4 | M | **Own SW, done safely, with an honest kill switch.** Same-URL iframe, origin-only isolation, never an opaque sandbox; answer every navigation within about 25 s (interstitial while waiting; Firefox unregisters a SW after 3 navigation faults); keep-alive ping at most every 20 s while streaming; no required state in SW memory; `206` ranges and an own MIME table; versioned SW-page protocol, reload-loop guard, `no-cache` on `index.html` and the SW. Keep DR 20's self-unregistering `/mw-sw.js`, add an unregister URL parameter, and test it as w1-07 VERIFY did (a 200 replacement evicts; 404/410/5xx never evict; first installs fail on 410). Document the reach: returning visitors who navigate online, at the next update check (plan for up to 24 h, 4.1 row 18). Hub per-label workers must re-fetch code the hub controls (shim plus apex worker). Re-test after every hosting change (the IPFS move to Cloudflare Pages silently dropped its edge enforcement). | R01 F17-F20; R04 R1-R6, F13, F17, F18, F20; w1-07 VERIFY claim 8, §10; w1-07 R5(a); w1-11 F37; DR 17, DR 20 | Adopted (ARCH §5.2, §7.1; DR 17, 20); reach documentation and the unregister parameter are new |
| P0-5 | S-M | **Wire guard.** Wrap `_onMessageLength` per wire before the handshake completes (or patch it in our bundle, P1-1): read the prefix unsigned (`>>> 0`) and destroy above 256 KiB before buffering; a buffer watchdog above the cap (about 512 KiB, checked periodically, 4.1 row 29) with a unit test that fails if the private `_bufferSize` disappears; `wire.ut_metadata.cancel()` on rendezvous wires; attach `mw_chain1` only to `webrtc` wires and send only when `peerExtendedMapping.mw_chain1` exists; frames at most 15 KiB (D22). Replace the "4 GiB" test (ARCH §12 test 11) with `0x7FFFFFFF`, `0xFFFFFFFF` and a 300 KiB message; assert destroy within 1 s, a flat heap and bounded CPU. Report upstream privately first (no advisory exists). | w1-11 F11-F12, R1, R21; w1-12 F13-F14, F20a, R5; w1-13 checkpoint 2; R01 F23, F24; R03 R-06; w2b-05 F41 | 256 KiB cap and 15 KiB frames adopted (ARCH §1, §13); unsigned read and test cases are amendments |
| P0-6 | M | **Connection and upload discipline.** Soft and hard caps per swarm in the `wire` handler after the extended handshake (content wires from policy; rendezvous 6/9 desktop, 3/5 mobile), lowest score dropped first, `numwant` driven to 0 at the soft cap, peers counted by unique `peerId` excluding web seeds. Uploads off = choke lock; never `throttleUpload(0)` or `uploadLimit: 0`; test that gossip flows at 256 KiB/s and while paused. Never the default chunk store (D9). | w1-12 F15, F18, F27, R4, R6; R01 F12-F14, F25; ARCH §1, §8; DR 19 | Wire cap 30/10/6 and choke lock adopted (ARCH §1, §8); per-swarm soft caps and rendezvous budgets are new |
| P0-7 | S | **Polyfills and floor.** Install guarded `Uint8Array.prototype.toHex/toBase64`, `Uint8Array.fromHex/fromBase64` and `AbortSignal.timeout` first in `boot.js`; self-test with w1-08's vectors and fail like a missing feature; record DR 16's floor and w1-08's Tier 1 matrix in `config.js` and README; keep the Accept test (Chromium with the four methods deleted completes a download). The vendored or self-built bundle must pass a syntax check at the declared target plus an API grep list that includes `BigInt64Array` (absent from the official bundle, present in `uint8-util` source). Do not use an esbuild target run as that check: it passed a bundle containing `??=` because esbuild lowers syntax it can transform; use a parser limited to the target's syntax or a syntax grep, and set the "refuse below" gate to Chromium 85 and Firefox 79 (4.1 row 27). | DR 16; R01 F4; w1-08 F-03 to F-06, R-01; local checks (0.2) | Adopted (DR 16, ARCH §5.1); the hard-floor correction is new |
| P0-8 | S | **Multi-string TXT.** A signed `v=mw1` pointer is about 515 B even with short URLs (the estimate made for `_w1-part-a.md`: 40-hex btih, short `xs` and `ws`, 3 trackers, 87-char owner key, 64-hex `gen`, `seq`, `exp`, 86-char `sig`), so it spans 3 or more DNS strings; w2a-06 measured 246-487 B for the grammar it read, still 2 strings (4.1 row 41). Reassemble per R05 F3 (Cloudflare returns `"a" "b"`, quoted and split mid-token; Google and dns.sb return the joined text; never join with a space); keep the RRset under about 1,200 B; ship publisher snippets for multi-string values (Route 53 `"p1" "p2"`, Terraform AWS `"p1\"\"p2"`, Cloudflare auto-splits). | R05 F3, F7, G3, G11, G12; w2a-06 Summary 2 | Partly: `resolveTxt` returns `strings[]`; the join rule and publisher docs are not specified |
| P0-9 | S | **Patched web-seed request.** Remove `Cache-Control` and `user-agent` from WebTorrent's web-seed and `.torrent` requests (keep `cache: 'no-store'`, which does not trigger a preflight) in our own bundle (P1-1) or, until it lands, as a hash-asserted patch of the vendored file (digest call); propose the change upstream. It removed every preflight in Chromium 156 and WebKit 27.2 and raises usable hosts from 6 to 13 of 24. w1-10 ranked it P1; w2a-07 promoted it to P0 on its 24-host data. | w1-10 F9-F10, F28-F29, REC-5, REC-7; w1-13 checkpoint 2; w2a-07 R1, Appendix C-D | New (ARCH §1 still says every request is preflighted) |
| P0-10 | S | **Consent gate and honest copy.** Consent before the first tracker or peer connection and before the DoH lookup (or an explicit `dns=1`); a host-only choice; no privacy claim anywhere. One copy pass: mobile "Sharing only while this page is open and on screen"; no offline promise on iOS ("saved on this device until Safari clears it"); magnet links "Opt-in on desktop Chrome, Edge, Brave and Firefox only; never on iOS, Android or Safari. Share `https://<hub>/#btih:...` links; they work everywhere."; availability "available whenever your web seed or a pinner is up; peers add speed"; demos over HTTPS or localhost forwarding only (fix ARCH §11); never "uncensorable" or "impossible to shut down" (nor DR §4.2's banned list); reuse DR §4 strings where they exist. | R03 F-17, F-38, R-11; R02 F23; R05 F13; w1-11 F18, F32, R6; w1-08 R-04; w1-09 R1; w1-07 R1(c), §4 Avoid 5; w1-10 F35, REC-4; DR §4 | Adopted for trackers and peers (DR §4.5, ARCH §8); the DoH part and the copy pass are new |
| P0-11 | S-M | **Ledger rendezvous swarm.** `client.add(sha1hex("mw-ledger/1/" + ledgerId), { announce: <the site torrent's exact list>, getAnnounceOpts: () => ({ left: 1, numwant: clamp(soft - wires, 0, 3) }) })`, never seeded; 0-1.5 s join jitter; a glare watchdog (peers exist but no wire after 20 s: re-announce with jitter, at most 3 times; also when a wire closes below the soft cap); `reqq` on content wires `clamp(round(limitBps * 0.25 / 16384), 4, 32)`, 8 on rendezvous wires; bulk `BLOCKS` only on rendezvous wires. Rendezvous peers announce as leechers, and the rendezvous connected on all four live trackers (18/20), so this also settles part A's concern that completed visitors might never meet through `tracker.openwebtorrent.com` (R06 F55); still keep two seeder-pairing trackers per pointer (P1-17). Rewrite ARCH §5.5, close ARCH §14 and the DR §6 items. | w1-12 F16-F17, F19-F25, R1-R3; R06 F55; R01 3.2 #8; DR S1 | CONFLICT with ARCH §5.5 (anchor torrent) and INTERFACES `addAnchor` |
| P0-12 | S | **Remove the v0.1 hub flags.** Delete `SANDBOX_HUB` and `HUB_CSP` (`allow-scripts allow-same-origin`); the shared-origin hub only as a localhost demo or single-publisher mode behind the gate, never auto-loading from `#magnet:`, `?mw=` or the handler. This also removes the hosted-site `registerProtocolHandler` exposure. | w1-11 F1-F2, F6, R2; w1-09 F19; w1-09 VERIFY §9 item 6; DR 6 | Tree: both flags are gone; `render.js` keeps a `hub-shared` sandbox for ARCH §3.3's demo; the "never auto-load" rule was not checked |
| P0-13 | M | **Multi-publisher hub: launch conditions** (skip if none ships in v1; building the production hub itself is L). Site origins on a separate registrable domain; wildcard PSL entry submitted early; no apex cookies; wildcard certificate on CloudFront/ACM, Vercel or a Cloudflare Worker route; labels from the ledger id (D15); refuse IP-literal and non-label hosts; a unit test that every hub label is one DNS label of at most 63 octets and never hex of a 32-byte digest. Abuse operations: double-hashed denylist over label and btih checked at the gate and at boot, the gate shows `ws=`/`xs=` hosts, report link, abuse contact, `security.txt`, a written takedown process, rate limits for non-browser clients, a cost model before opening the hub, counsel review. The PSL entry does not shield the hub from a Safe Browsing listing of the parent, so the abuse program is not optional. Priorities: w1-07 R6 said P1 and part A's production-hub item said P2; w1-11 R7 makes hub abuse operations P0 for any hub that ships. | w1-11 F3-F4, F20-F21, R3, R7; w1-07 F9, F11, F23, R4-R6; w1-07 VERIFY claims 7-8; w1-10 F24-F25; R04 R1, Q7; R06 3.1.1; DR 6; w2b-06-VERIFY claim 7 | Specified, not built (ARCH §3.2; DR 6); abuse operations are new |
| P0-14 | S-M | **Interface freezes.** Before `block.js` freezes: the salted `vh` of D31, with tests that a stub reveals nothing guessable without `z`. Before the SDK freezes: remove `identity.export`, `identity.import` and `consent.accept` from site-callable `window.mw`; loader-owned UI (closed shadow root, `isTrusted`, transient activation); add `mw.consent.request()`. | w1-11 F28-F30, F38, R4, R5 | CONFLICT with ARCH §6.1 (unsalted `vh`), §3.4.9 and §9 (site-callable consent); the tree still exposes all three calls |
| P0-15 | S | **Arrival safety minimum.** Confirm that `parseFragment` (`app.js`) decodes once and only for encoded-scheme fragments (w1-09 VERIFY says it did at 2026-10-17 18:06 ET) and keep tests for handler-built links, literal links, a tracker with `?key=a&b=c`, and encoded `=` and `%`. Nothing that arrives by fragment, handler, share target or paste loads without an explicit click. | w1-09 F3-F4, R2; w1-09 VERIFY claims 3-4; w1-11 T2, R2 | Partly in the tree per w1-09 VERIFY |
| P0-16 | M | **Mobile defaults and lifecycle.** The four-class classifier (drop `mozConnection`/`webkitConnection`); uploads off by default on every mobile class with a per-origin opt-in (pending the owner decision in 2.4); on hidden record the time and lock uploads; on visible after more than 10 s, `online` or `pageshow.persisted` destroy and rebuild the client (fresh tracker client) and re-attach the ledger node, rendezvous swarm included; never use `tracker.update()` as recovery; compare timestamps, never timers; never rely on `beforeunload` or `unload`. | w1-08 F-07 to F-15, F-31, R-02, R-03; R01 3.2 #10; R03 F-33 to F-36, R-08; R02 R3; ARCH §8 | Triggers adopted (ARCH §8); the 10 s threshold and the upload default are a CONFLICT with ARCH §8 |

### P1

| ID | Eff | Recommendation | Justifying file(s) | Status in v0.2 |
|---|---|---|---|---|
| P1-1 | M | **Own WebTorrent bundle.** esbuild with the package `browser` map applied globally, `path-esm`, `process-fast` and `events` installed, stubs for create-torrent, `lib/server.js` and fsa-chunk-store; the four exactly-once patches of D2 with input and output sha384 asserted; target = declared floor; bundled into `loader.js` so one SRI-checked file covers it. Effect: zero preflights in Chromium and WebKit, and WebKit `xs=` works against hosts that only send `ACAO: *`. Propose the header change upstream. | w1-10 F28-F29, REC-5, REC-7; w1-13 checkpoint 2 | New (ARCH §1 vendors the official `dist`) |
| P1-2 | M | **Versioned shell.** D16's layout; required vs optional precache; `build.mjs --host=<aws, cloudflare, ghpages, netlify, vercel>` writes header and redirect files from one source; explicit `Content-Type` on upload (a `binary/octet-stream` worker is rejected); invalidate the root paths and purge CDN caches on every deploy. | w1-10 F31-F33, REC-6; R04 G13, G14, R6; DR 20 | Partly (ARCH §13; DR 20) |
| P1-3 | M | **Reference AWS deployment.** Private bucket with Block Public Access and versioning, OAC, CloudFront behaviours and a Function (SPA fallback for navigations only, so missing web-seed objects stay 403/404), ACM in us-east-1 (apex + wildcard), Route 53, a response-headers policy, an optional `seed.` distribution; state that nothing was tested end to end. | w1-10 F1-F7, REC-8, gotchas 5-6 | New |
| P1-4 | S | **Harden `publish.mjs`.** D4 in full: an explicit sorted file array (directory input drops every dot-path, `.mw/` and `.well-known/` included); exempt `.mw/` and `.well-known/` from the dotfile ignore list; a pinned non-zero `creationDate` as a `Date`; never set `private`; always pass an explicit tracker list; reject paths with `#`, `?`, `%`, backslash, control characters or edge spaces; torrent name `<dn>-<8 hex>` so seed objects can be `immutable` (conflicts with ARCH §3.4.1 "fixed `name`" if that means constant across versions; owner decision, 4.1 row 39); print upload commands with immutable headers and the next `check-webseed` command. | w1-13 create-torrent; w1-10 F8, REC-9; R01 F22, 3.2 #6; ARCH §10 | Partly (ARCH §10) |
| P1-5 | M | **Pointer integrity and keys (before the v1 grammar ships).** `fj=` with first-serve verification of `files.json` and each file; `rot` input `"mw-rot-v1\n" + scope + "\n" + old + "\n" + new + "\n" + seq`; pre-rotation `nk=` in pointer and genesis; `keygen.mjs --recovery`. | w1-11 F7-F10, F24, F26-F27, R10-R12 | New (`rot=` exists in ARCH §4 without this input format; no `fj=`, no `nk=`) |
| P1-6 | S-M | **Verified serving (ARCH §7.1 and §7.3 as written).** `frame-ancestors`, 302 for top-level `/_mw/s/...`, `sha1(bencode(info)) === btih` and every piece verified before first serve or upload; E2E: a flipped byte in IndexedDB triggers `deleteSite`. | w1-11 R14 | Specified (ARCH §7.1, §7.3); implement and test |
| P1-7 | S | **Consent completeness.** Consent stored per origin with timestamp and notice version, revocable; equal-weight first-layer choices pending counsel; `persist()` only from a gesture (the consent click), never at load for stored consent (Firefox prompts). | w1-11 F16-F17, R6; w1-08 F-21, R-08 | Partly (ARCH §8 requests `persist()` after consent) |
| P1-8 | M | **Peer abuse controls.** An upload request queue cap per wire (64-128), a request rate limit, wires per IP and per /24; poisoned-piece attribution with 3 strikes per session and a web-seed preference after 2. | w1-11 F13, R8, R9 | New |
| P1-9 | S | **Offer and connection budgets.** `getAnnounceOpts` sets `numwant` per class: 3 on desktop (R02 R2, heuristic), 3 on unmetered and unknown mobile networks and 2 on metered (w1-08), 0 at the soft cap (P0-6); phones announce to at most 2 trackers, the first two entries of the shared ordered list, both seeder-pairing (4.1 row 12); cap live `RTCPeerConnection`s (mobile 6-12, desktop at most 55, Safari at most about 50); drop peers whose ICE fails within 15-20 s; back off on "Cannot create so many PeerConnections". Part B ranked the `numwant` values P2; part A's P1 wins (0.4 rule 6). | R02 R1, R2, R8; R03 R-07, F-31, F-32; w1-08 R-13; w1-12 R7 | Wire cap adopted; `numwant` and tracker count per class are new |
| P1-10 | S | **Reconnect discipline.** Rebuild discovery on visible, `pageshow` and `online` (adopted); add per-tracker jittered exponential backoff (1 s to 60 s) and a circuit breaker (a `503` with `Retry-After` means hours; ftorrent's breaker trips at 200 M offers per 24 h). Page JS sees 403, 503 and TLS failures only as close code 1006. | R02 R3, F12, G14, G15; w2b-04-VERIFY claim 1 | Partly |
| P1-11 | S | **Data-channel liveness and backpressure.** Application ping every 10-15 s, dead after 2-3 misses (ICE consent can keep a dead peer "connected" for 30 s); `bufferedAmountLowThreshold` 256 KiB, pause above 1 MiB; `try/catch` around `send()` (`OperationError` at 16 MiB queued, `TypeError` above the negotiated size). | R03 F-26, F-28, R-06 | Partly (`wire.setKeepAlive(true)`, 60 s timeout) |
| P1-12 | S | **DoH hygiene.** GET with only `Accept`; Google `edns_client_subnet=0.0.0.0/0`; never `cd=1`; read the JSON body regardless of `r.ok` (dns.sb returns HTTP 503 for SERVFAIL); `Status` 3 or a missing `Answer` key means not found; CNAME-only answers mean not found; compare names case-insensitively without the trailing dot; a TTL-aware cache plus a 30-60 s negative cache; `referrerPolicy: 'no-referrer'`, `credentials: 'omit'`; the SW must not intercept DoH fetches. Use the browser-tested `doh.sb` hostname or add `doh.dns.sb` to the canary. | R05 F2-F4, F12-F14, R2, R6, R9, R10, G1-G9 | Mostly adopted; the `doh.dns.sb` alias was not browser-tested by R05 |
| P1-13 | M | **Mobile memory and storage path.** An explicit chunk store (never fsa-chunk-store), per-file Blobs on `file.on('done')`, caps from 2.4, `maxLoadedBytes` for the site ledger, an IndexedDB wrapper (short transactions, reopen on close, retry once, commit before hidden), a Safari private-session probe with an ArrayBuffer fallback and a "Private window" message. | w1-08 F-16 to F-23, F-32, R-05, R-06, R-09, R-21 | Partly (own store adopted, ARCH §1); the rest is new |
| P1-14 | M | **Identity durability and iOS persistence.** Key self-test with fallback; export and import of the P-256 identity in loader-owned UI only (P0-14); "first time on this device" when a pin is missing; `persist()` from the consent click; Add to Home Screen advice and an iOS Home Screen hint after a first successful load; never promise offline use on iOS; warn about the 7-day deletion; a device test of the non-extractable key round trip. | R06 F25, F51-F53; R04 F21; R01 F30; w1-08 F-20 to F-24, R-07, R-08; w1-11 R5; w2c-03-VERIFY claims 2-3 | Partly (ARCH §6.1; DR §4.3) |
| P1-15 | S-M | **Link UX and fragment hygiene.** A paste box and Paste button on the hub landing; an arrival interstitial (name, btih, tracker hosts, `ws`/`xs` hosts, size, `index.html` present, an explicit "Open as website") with a "not a website torrent" path that never sets `location = 'magnet:...'`; the SW never logs, caches by or forwards a full navigation `request.url`; no redirects in front of the hub (fragments survive redirects). | w1-09 F18-F20, R3, R5; w1-09 VERIFY claim 5; w1-11 F21, F33 | New |
| P1-16 | S | **Manifest CI guard.** Derive `scope`, `start_url` and the handler URL from one deploy base; root-relative or absolute `protocol_handlers` URLs (relative ones resolve against the manifest URL); fail CI on any `Page.getAppManifest` error. | w1-09 F11, R6; w1-09 VERIFY §9 item 2 | New |
| P1-17 | M | **Third-party endpoint monitoring and canaries.** Scheduled Node checks (never a browser on the dev machine) of trackers (liveness, relay, and the seeder-pairing scenarios S1-S5; fail below 3 passing; alert on any new 403 or 503), STUN, DoH CORS and HTTP/3 status per endpoint, and web-seed CORS and `Range`; run only from `tools/check-site.mjs`, `tools/check-webseed.mjs` or CI, per `docs/DEV-NETWORK.md`; open an issue on change; keep at least 3 endpoints per class and at least 2 trackers that pair seeders in every pointer; UI "discovery degraded" below 2 answering trackers. The e9-style live browser test needs a runner outside DEV-NETWORK's scope. | R02 R9; R05 R13; R01 3.2 #12; R06 F55; w1-07 F8, F20, F25, R3; w1-12 F21, F25, R7; `docs/DEV-NETWORK.md` | Tools exist; schedule and thresholds not specified |
| P1-18 | S | **Frame versioning that never disconnects.** Byte 0 = type, byte 1 = generation; unknown generations ignored without a strike; keep `mw_chain1`, reserve `mw_chain2`. | w1-12 F4, F11, R8 | New |
| P1-19 | M | **Regression suite from the labs.** w1-12 e1, e1x, e3 (reduced), e4, e5, e7, e8, e11, e12; w1-08 polyfill vectors and the WebKit non-persistent-context case; w1-10 broken-seed fixtures (200 ignoring `Range`, SPA 200, 301, no ACAH, and a 206 with wrong bytes as jsDelivr returns); w1-07 VERIFY's SW takedown lab; the IPFS SW gateway bug list (never HTTP-cache 5xx or 206, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, Range and Save As, missing precache = 404); an 8-hour soak with a heap threshold. WebRTC cases in Chromium only (no ICE in Playwright WebKit here). | w1-12 R9; w1-08 R-01, R-21; w1-10 REC-1, REC-2; w1-07 R8, R9; w1-07 VERIFY §8; w1-13; w2a-07 F1 | New |
| P1-20 | S-M | **Supply chain.** `ignore-scripts`, `npm ci`, `build.lock.json` pins (webtorrent 3.0.21, bittorrent-protocol 5.0.9); CI fails when the set of packages with install scripts changes; `overrides: { "node-datachannel": "0.33.4" }` for Node seeding (0.32.3's install script uses deprecated prebuild-install); document `ip@2.0.1` (Node tools only; do not downgrade webtorrent) and `ip-set`'s preinstall `npx only-allow pnpm`. | w1-11 F36, R15, gotchas 18-19; w1-13 node-datachannel | Partly (ARCH §13: `ignore-scripts`, `build.lock.json`) |
| P1-21 | S-M | **HTTPS dev tooling.** `dev-server.mjs --https` reverse-proxying `/tracker` as a WebSocket; `npm run demo` prints Android USB forwarding and mkcert steps; tunnels and tailnet serving are owner-run, never agent-run. | w1-10 F35-F37, REC-4; w1-13 tracker TLS; `docs/DEV-NETWORK.md` | Partly (`dev-server --tls`, ARCH §10) |
| P1-22 | M-L | **One-command migration.** `npx magnet-web publish ./dist --domain example.com`, a GitHub Action around publish and check-webseed, DNS writers for Cloudflare and Route 53 with restricted tokens and a CNAME-delegated `_magnet` record, PR-preview pointers, torrent creation in the owner's CI. | w1-07 F12, F14, F16, R7 | New (wave 2a extends it: `MIGRATION-DIGEST.md` §10) |
| P1-23 | L | **Real-device release matrix and per-release manual QA.** iOS Safari (tab, private, Home Screen, Lockdown on and off) on iOS 16.x to 27 and iPad; iOS Chrome and Brave (WebKit); Android Chrome on a 2-3 GB RAM phone and a recent one; Samsung Internet 29/30; Firefox 158, ESR 140, private and Android 149+; Brave (Shields levels, Tor window, Android); in-app browsers; Safari 27 on macOS. Cases: SW control and sandbox, hard reload, idle kill, stream keep-alive, `Range` seeking, web-seed preflight, frames of 1-256 KiB, key round trip, 7-day persistence, background and lock resume, LTE-to-LTE, installed-PWA protocol launch, Firefox 160 "Never allow", QR scans. w1-08 and w1-09 ranked this P2; part A's P1 wins (0.4 rule 6). | R01 3.2 #15; R02 R10; R03 R-13; R04 R9; R05 R13; R06 3.1.11; w1-08 R-15, Q-01 to Q-11; w1-09 R15 | DR 25 release gate |
| P1-24 | S | **Normative doc amendments in one PR.** ARCH §1 (`BigInt64Array`, the fsa-chunk-store range 15.2-25.x, the 31-bit length, preflight facts and the header strip, `maxConns`, head-of-line, `reqq`, the hard floor), §1 and §8 with INTERFACES `keepaliveScrapeMs` (P0-1), §3.4.9 and §9 (P0-14), §5.5 (P0-11), §6.1 `vh` (P0-14), §8 (2.4), §11, §12 test 11, §13 (shell integrity, `<meta>` CSP limits), §14; INTERFACES `addAnchor`, `wire-ext.js` and the `resolveTxt` join rule (P0-8); the DR §6 items; browser-mobile review m7(b) (Brave no longer ships WebTorrent). | w1-10 App F; w1-11 §7; w1-12 R12; w1-08 App B; w1-07 VERIFY §9; w1-09 VERIFY §11; this digest 4.1 | Open |

### P2

| ID | Eff | Recommendation | Justifying file(s) | Status in v0.2 |
|---|---|---|---|---|
| P2-1 | L | **Measure before buying relays.** Opt-in candidate-pair telemetry via `getStats()` to learn the real relay share; then decide a TURN tier. If Tier 1: a CI-minted `ice.json` (Cloudflare TURN, TTL at most 48 h, billing alert, revoke if scraped) or a Metered `apiKey`; relayed peers carry gossip only and bulk comes from the web seed; a relay-only privacy mode exists only with TURN. | R03 R-03 to R-05, R-13, F-11 to F-15; w2b-03 F-01 | Not planned for v1 |
| P2-2 | M | **Own tracker in production pointers** (`aquatic_ws` or `wt-tracker-rust`; Caddy `stream_close_delay`; stateless Oracle rules; a health check against idle reclamation). Start from w2b-01's `tracker/tracker.mjs`, not R02 F13's wrapper; if `bittorrent-tracker` is used, set `ws` `maxPayload` to 65,536 and know its defects (5.3). | R02 R6, F13-F16, G7-G13; w2b-01 correction 1; w1-13 checkpoint 3 | DR 15 |
| P2-3 | M | **Optional Nostr discovery plane for the site ledger only**, only if wire-only gossip fails in the field: lazy (only when the rendezvous swarm has 0 wires after 20 s or every tracker socket failed); an own 200-line NIP-01 client or a pinned `@trystero-p2p/nostr@0.26.0`; the room derived from the ledger id (digest inference: R02 R5 used `sha1("magnet-web/chain/v1/" + infohash)`, but the infohash changes on every publish, R06 3.1.1); SDP wrapped with a key derived from the owner public key; the 5 pinned relays of 2.2; a local relay in CI; no MQTT. Record the "no" decisions with revisit triggers. | R02 R5, F18, F19; w1-12 F28, R10, R11; w2b-01 correction 4 | Not adopted |
| P2-4 | S | **Wire-format DoH** (RFC 8484 GET `?dns=`, ID 0, EDNS0 1232, DO=1 for `AD`) as a second parser, as Cloudflare recommends for critical use. | R05 F2, R3, Appendix A.2 | Not adopted |
| P2-5 | S | **`_magnet` governance.** A one-page spec and an IANA Expert Review request for `TXT _magnet`; talk to the btlink author about one shared label. | R05 F8-F10, R12; w2c-06-VERIFY claim 2 | Open |
| P2-6 | S | **Mobile refinements.** Battery-aware sharing on Chromium (`!charging && level < 0.30` disables), upload budgets (2.4), `connection.change` reactions, a publish-time mobile budget lint (total, five largest files, class fit). | w1-08 R-11, R-12, R-14, R-20 | New |
| P2-7 | L | **Prioritised partial download.** Deselect everything, mark the entry set critical, render when it verifies, fetch the rest on demand through the SW `Range` path. | w1-08 R-19 | New (DR §3 lists streaming before completion as v2) |
| P2-8 | S-M | **Hosting recipes and checks.** Per-host recipes; base-path support or an explicit "root only" rule; hub and per-domain CSP profiles with a conformance test (drop the `new Function` probe); `tools/verify-deploy.mjs`; a wildcard hub guide. | w1-10 REC-11 to REC-15 | New |
| P2-9 | L | **Evaluate a single-file archive layout** (`v=mw2`): one web-seed URL, no per-file preflights (P0-9 also removes them), no path encoding, octet-stream outside compression lists, and fewer requests (a cold visit costs P + F - 1 range GETs on per-request-priced hosts). Changes the pointer grammar. w1-10's compression motive is gone for browsers (4.1 row 32). | w1-10 REC-10; w2a-07 F1, F4 | New |
| P2-10 | M | **Security hardening batch.** A channel-disagreement banner on pinned scopes and the first-visit hard stop of D34; an external canary comparing served files with the signed release manifest; three-valued gossip admission with advertised limits and a 24 h future-`ts` admission window; a torrent path validator (reject `..`, absolute paths, backslashes, control characters, case or NFC duplicates, depth over 32, `_mw/*`, and any `.mw/*` except the reserved `files.json` and `site.json`); upstream PRs; a DPIA template; a relay-only privacy mode once TURN exists; Firefox and Safari reruns; an isolated libtorrent 2.1 evaluation. | w1-11 R13, R16, R17, R21-R25, R29 | New |
| P2-11 | S-M | **Magnet extras.** `share_target` GET at `/_mw/share`; "Show QR code" (`<origin>/#btih:<40 hex>` is QR version 5 at ECC M; generated locally); a publisher snippet `mw-links.js`; an opt-in "Open magnet links with this site" on the hub apex only, desktop only, with a feature test plus a mobile exclusion and an apex router to per-site origins; a diagnostics line. w1-09 ranked the opt-in control P1; lowered here (4.1 row 36). | w1-09 F16-F17, R4, R7-R11; w1-09 VERIFY claim 8; w1-07 F7, R15 | LATER (DR §3) |
| P2-12 | S | **Prior-art follow-ups.** A first-visit weight budget against the IPFS SW gateway's about 322 KB per origin; governance (two maintainers, a permissive licence, a reproducible build, a continuity page); documented site-ledger ceilings and an owner-signed `archivedBefore` watermark. | w1-07 R10, R12, R13 | New |

### P3

| ID | Eff | Recommendation | Justifying file(s) | Status in v0.2 |
|---|---|---|---|---|
| P3-1 | S | **Naming.** `KayleePop/magnet-web` (MIT; same SW + iframe + WebTorrent idea; last commit 2022-12-14) already exists; namespace npm and GitHub identifiers. | R04 F3, R10 | Open |
| P3-2 | M | **Ed25519 identities** (algorithm-tagged, strict verification pre-checks because of ZIP 215 disagreements) only if P-256 persistence fails on devices. | R06 F45-F50 | Deferred (DR §3) |
| P3-3 | L | **Cloudflare Workers plus Durable Objects tracker** prototype (no machine to run). | R02 F17; w2b-01 correction 2 | Not planned |
| P3-4 | S | **Opt-in Screen Wake Lock while sharing** (Chrome/Edge 84, Safari 16.4, Firefox 126, Samsung Internet 14); `freeze`/`resume` on Chromium; a telemetry-free diagnostics panel with "Copy report". | R03 R-08, F-18; w1-08 R-16 to R-18 | Not planned |
| P3-5 | M | **COOP/COEP per document** only when a hosted site needs cross-origin isolation (`require-corp` on Safari; one extra reload). | R04 R8, F19 | Not planned |
| P3-6 | S | Order-independent routing-manifest hash and named snapshots (NIP-5A pattern). | w1-07 R14 | New |
| P3-7 | S-M | `.torrent` `file_handlers` (desktop Chromium; verify the parser first); `launch_handler` only with a `launchQueue` consumer; an optional `x.mw=1` marker. | w1-09 R12-R14 | New |
| P3-8 | S-M | Cost guardrails (budget alarm, WAF rate rule, keep `max=`); watch list (`Integrity-Policy`, signature-based SRI, Trusted Types, WAICT); shell-hash pinning through the pointer, pending a decision (6.4 question 29). | w1-10 REC-16 to REC-18, F38 | New |
| P3-9 | S-L | Clock-skew tolerance for `exp`; an optional opaque-origin "untrusted preview"; WebAuthn P-256 pointer signing and PRF-wrapped keys; threshold owner keys; a watch list. | w1-11 R18-R20, R27, R28 | New |
| P3-10 | L | Peer-assisted signaling over `mw_chain1` (signed offers, TTL, rate limits, anti-amplification); a design note first. | w1-12 R13 | New |
| P3-11 | - | **Do not pursue now:** browser-side DNSSEC validation (no maintained library; 4-5 % of .com signed), ENS or an L2 as the root of trust through Helios or Lodestar (needs RPC servers), negentropy packaging (v0.2 has its own depth-window digests). | R05 Q7; R06 F1-F4, F54, Q10, Q14 | - |

---

## 4. Verified, refuted and nuanced claims

No claim in either wave-1 VERIFY file was refuted. "Nuanced" means the facts hold but a statement was mis-scoped or
an inference was presented as a finding, so a downstream document changes.

### 4.1 Contradictions, and which source wins

Rows 1-16 come mainly from files 01-06, rows 17-39 mainly from w1-07 to w1-13; rows 9, 11, 13, 27, 32, 40 and 41 are
contradictions between the two halves, or with later files, that neither part resolved.

| # | Topic | One source says | Another source says | Winner and why | Action |
|---|---|---|---|---|---|
| 1 | Tracker keepalive | R02 R3: an offer-free keepalive announce about every 60 s; R02 R4 and R01 F8: never `scrape` (openwebtorrent closes the socket) | ARCH §1 and §8, INTERFACES `keepaliveScrapeMs: 90000`, DR 15: `scrape` every 90 s | **CONFLICT.** The research measurement wins on the fact. The DR Accept test (at least one socket still open after 30 idle minutes) would pass anyway, so tests would not catch it; the tree's fallback (0.2) limits the damage to one drop per session. `PRODUCTION-DIGEST.md` lists the same defect | P0-1 |
| 2 | Live trackers | R01 F8: three live (openwebtorrent, webtorrent.dev, novage); `btorrent.xyz` "TCP connect error"; files.fm 403 "to a non-browser handshake" | R02 F1-F3: four live, adding `open.ftorrent.com`; `btorrent.xyz` resolves to 127.0.0.1; files.fm answers 403 to every Origin except `https://files.fm` | R02: dedicated topic, offer/answer relay test, five Origin variants. R01 says it did not review R02 | 2.2 |
| 3 | Announce cadence | R03 summary 10 and F-32: up to 5 new `RTCPeerConnection`s per tracker "every 30 s", worst case 30 pending for 3 trackers | R02 F8: 30 s is the client default only until the first response; live servers answer `interval` 120 s (180 s on novage) | R02 (code plus live). Steady state is 5 offers per tracker per 120-180 s; R03's figure is an upper bound for the first minute or for frequent re-announces | P1-9 |
| 4 | Lockdown Mode scope | R01 F28 and summary 12: SW, Cache API, Web Locks off; RTCDataChannel and WASM only "reportedly"; R06 summary 10: "may disable JIT, WASM, WebRTC" | R03 F-21: `PeerConnectionEnabled` plus 48 other prefs flagged `disableInLockdownMode` in WebKit main (2026-10-14), including SW, IndexedDB (status "embedder"), Cache API, Web Locks, WebTransport; R04 F15: WebKit 16.4 notes list SW, Cache API, CacheStorage, Web Locks | R03 for WebRTC (engine source plus two independent tests), R04 for SW and Cache (Apple primary). IndexedDB unresolved until a device test. All four agree that only the per-site exclusion helps | 5.1; 6.2 question 5 |
| 5 | Firefox private-window SW | R01 F30: "fixed in Firefox 138/139 per Bugzilla 1320796, unverified" | R04 F15: Firefox 140.0 release notes (2025-06-24); landed in 139 and was disabled again (bug 1967568); MDN BCD's "139" is wrong; ESR 128 never | R04 (release notes plus bugs); DR and ARCH §1 use 140 | 5.1 |
| 6 | Default chunk store on Safari < 26 | R01 F12: the bundled `createWritable` polyfill runs before `SUPPORTS_FSA` is evaluated, so Safari 15.2-25 take the OPFS path (inference from module order); ARCH §1 (re-verified 2026-10-17): the polyfill runs on Safari 15.2-18.1 as a module Worker per write | R04 F14b and R4: Safari < 26 runs RAM-only; w1-08: native `createWritable` is Safari 26 (BCD), so 15.2-25.x take the polyfill path | R01 and w1-08 (source order plus BCD); R04's RAM-only claim and ARCH §1's 18.1 bound are superseded. Moot for behaviour: v0.2 never uses the default store | P1-24 (ARCH §1 wording) |
| 7 | Isolation by sandbox | R06 3.1.9 and R03 R-12: an opaque-origin sandboxed iframe with a narrow `postMessage` API is an acceptable boundary | R04 F11, R1 and R01 F18.3, F20: opaque frames are not SW-controlled and their navigation bypasses the SW (WPT 29/29; both labs); w1-11 F1-F2 (own lab) | R04, R01 and w1-11 (measured). R06 flagged the conflict itself (Q7). Only a separate origin isolates | D13 |
| 8 | Gossip frame size | R06 3.1.7: messages up to 64 KiB | R01 F24, R03 R-06: at most 16 KiB (Chromium hard cap 262,144 B including the extension id byte; Firefox assumes 64 KiB; RFC 8831); w1-12 gotcha 2 re-observed the cap by accident | R01 and R03 (measured plus spec). v0.2 uses 15 KiB | D22 |
| 9 | Hub label: source and length | R04 R1: `https://<base32 infohash>.hub.example/`; w1-07 R4 and w1-07 VERIFY claim 7: base32 of the full 32-byte digest (52 chars) "if collision resistance matters"; part B carried "52 chars" as the decision | R06 3.1.1: the database id must stay stable across releases while the infohash changes on every publish; ARCH §3.2 and DR 6: `label = base32(sha256(ledgerId))[0:32]`, `base32(btih)` only for bare magnets; w2c-04 Summary 3: the 32-char grammar is sound (160 bits, one canonical spelling) | ARCH and DR 6 (normative), backed by R06's principle and w2c-04. w1-07 R4's binding rules are "one label of at most 63 octets, never hex"; 52 is the length of a full digest, not a requirement. Isolation needs second-preimage resistance, which 160 bits gives; a 160-bit collision only lets one publisher put two of its own sites on one origin (digest judgement) | D15; P0-13 |
| 10 | Discovery planes | R02 R5: add a Nostr or MQTT room as an independent second plane for the ledger | R06 F55 and R01 3.2 #8: gossip rides BEP-10 on torrent wires; no second signaling plane; w1-12 confirms wires work (rows 22, 11) | R06, R01 and w1-12 for v1 (fewer third parties, nothing new to disclose). R02 itself rates the wire option as equally supported; a second plane stays a P2 fallback | D27; P2-3 |
| 11 | Second-plane implementation | R02 R5, F18, F19 (as `_w1-part-a.md` P2-3 proposed): a Trystero 0.26.0 room `sha1("magnet-web/chain/v1/" + infohash)` on 5 pinned Nostr relays, MQTT last | w1-12 F28, R10, R11: Trystero 0.26.0 changed its wire format and has no room cap; use an own NIP-01 client or the pinned Nostr strategy package, lazily; w2b-01 correction 4: MQTT brokers sit on DNS block lists | w1-12 (signaling topic owner, later, code read). Drop MQTT; derive the room from the ledger id rather than the infohash, which changes on every publish (digest inference from R06 3.1.1) | P2-3 |
| 12 | Trackers per phone | R02 R1: every peer announces to every entry (peers that share no tracker never meet); w1-12 R7: at least 3 trackers, of which 2 pair seeders | R03 R-07 and w1-08 R-13: at most 2 trackers on mobile | Compatible: phones use the first two entries of the same ordered list and a lower `numwant` (R02 R2), desktops announce to all, and the first two entries must both pair seeders (so `tracker.openwebtorrent.com` is never one of them). Digest inference, untested | P1-9; P1-17 |
| 13 | Desktop `numwant` | R02 R2: `numwant: 3` (2 on phones; heuristic) | w1-08 Mobile policy v1: 5 on desktop (the library default), 3/3/2 on mobile | R02 for desktop (tracker-cost topic owner; w1-08 restates the default there), w1-08 for mobile. Both are heuristics; P0-6 drives `numwant` to 0 at the soft cap anyway | 2.4; P1-9 |
| 14 | STUN set | R01 3.2 #11: two vendors; WebTorrent default is Google plus Twilio | R03 R-02: Cloudflare first; Google and Twilio as alternates; at most three | R03 (terms evidence F-07 to F-09). v0.2 dropped Google entirely | 2.2 |
| 15 | DoH integrity model | R05 R2: 2-of-3 quorum with early exit; distinct valid answers mean conflict | ARCH §4 and INTERFACES `doh.js`: sequential, first success; integrity from the owner's P-256 signature, TOFU pin, `seq` and `exp` | v0.2 decision. A resolver can only withhold or replay, and replay is bounded by `seq` and `exp`. The quorum still matters for unsigned bare-magnet records | D34 |
| 16 | Signature algorithm | R06 F45-F49: Ed25519 with a noble fallback | R06 F50: P-256 is the universal fallback; w1-08 F-24, F-32: Ed25519 needs iOS 17, Chrome 137, Samsung 30 | v0.2 decision: P-256 (no fallback library; works on Chrome < 137, Samsung Internet <= 29, iOS 16). Ed25519 later | D29; P3-2 |
| 17 | Installed-SW takedown | w1-07 Summary 7 and F11: an edge takedown "cannot reach" installed workers | w1-07 VERIFY claim 8: a 200 replacement evicts at the next update check | VERIFY (experiment in two engines; 0.4 rule 1) | D17; P0-4 |
| 18 | SW update-check timing | w1-11 F37: checked on navigation | w1-07 VERIFY 8.2 step B: no `/mw-sw.js` request on a plain reload inside 24 h (Chromium 156 and WebKit 27.2) | Unresolved as fact; plan with VERIFY's conservative reach (0.4 rule 4) | P0-4; 6.3 question 19 |
| 19 | Fragment and the SW | w1-09 F13: the SW only sees the path | w1-09 VERIFY claim 5: the SW sees the fragment in a navigation `request.url` | VERIFY (observed in both engines) | P1-15 |
| 20 | Handler feature test | w1-09 R4: `typeof navigator.registerProtocolHandler === 'function'` | w1-09 VERIFY claim 8: true on Firefox Android, where the call does nothing | VERIFY | P2-11 |
| 21 | Fragment decode | w1-09 R2: `detectMode()` in `render.js` | w1-09 VERIFY claim 4: `detectMode` is gone; `parseFragment` (`app.js`) already decodes once | VERIFY (newer tree state) | P0-15 |
| 22 | Ledger anchor | ARCH §5.5, §14 and DR S1: a one-piece anchor torrent; a bare infohash only if wires stay open | w1-12 F20-F25: bare-infohash rendezvous works (15/15 local, 18/20 live); the anchor fails when peers join together (0/15, 0/10) and never pairs on openwebtorrent; wires stay open | w1-12 (measured locally and on four live trackers); DR S1's condition is met; use the versioned name `mw-ledger/1/`. This also answers R06 Q6 (which swarm carries gossip across releases) | D26; P0-11; P1-24 |
| 23 | Mobile upload default | ARCH §8: on at 256 KiB/s on confirmed Wi-Fi | w1-08: off unless charging; opt-in 128 KiB/s | w1-08 on evidence (0.4 rule 3); owner decision | 2.4; P0-16; 6.4 question 23 |
| 24 | Rebuild threshold | ARCH §8: more than 60 s hidden | w1-08 R-03: more than 10 s | w1-08 (iOS suspends within 5-20 s) | P0-16 |
| 25 | Mobile caps | ARCH §8: `maxConns` 10/6; 24 MiB on unknown networks | w1-08: 8/6/4; 48 MiB on unknown with a 16 MiB ask | w1-08 (topic owner, memory measured) | 2.4 |
| 26 | Floor and `BigInt64Array` | ARCH §1 and DR 16: the bundle "uses `BigInt64Array`"; floor 15.4/110/115 | w1-08: absent from the bundle; hard floor 14.5/80/78 | Fact: w1-08 (confirmed by the 2026-10-19 grep), but `uint8-util` source uses it, so a self-built bundle may include it. Floor: DR 16 stays (normative); for the hard floor see row 27 | P0-7; P1-24 |
| 27 | Hard ("refuse below") floor | R01 F4: parse floor Chrome/Edge 85, Firefox 79, Safari/iOS 14.1 (derived from syntax, APIs and BCD; labelled inference) | w1-08 F-06 and matrix: the bundle's esbuild syntax floor is "clean for Safari 14.1, Chrome 80, Firefox 78", so refuse below iOS 14.5, macOS Safari 14.1, Chromium 80, Firefox 78, Samsung 13.0 (Blink 83) | R01 for the unmodified bundle. Local check (0.2): the vendored bundle contains one `??=` (logical assignment: Chrome 85, Firefox 79, Safari 14), and esbuild 0.28.2 at `chrome80,firefox78,safari14.1` exits 0 without a diagnostic and lowers it, so w1-08's silent run was not a parse test (0.4 rule 2). Refuse below Chromium 85, Firefox 79 and the first Samsung Internet release on Chromium 85 or later (13.x is Blink 83; mapping not checked here); iOS 14.5 and macOS Safari 14.1 stand. DR 16's declared floor is unaffected; an own bundle built at the declared target lowers the syntax anyway | P0-7; 5.1 |
| 28 | Wire length worst case | DR 10, ARCH §1 and §12 test 11: any 32-bit length, 4 GiB | w1-11 F11: a signed read; `0x7FFFFFFF` buffers, `0x80000000` and above desync as keep-alives | w1-11 (source and PoC; w1-12 F14 agrees; later confirmed by w2b-05 F41 and w2c-05 Summary 2) | D23; P0-5 |
| 29 | Buffer watchdog threshold | w1-12 R5: 256 KiB, every 2 s | w1-11 R1: about 512 KiB | Digest judgement: about 512 KiB checked periodically, with w1-12's field-presence test; a watchdog equal to the cap leaves no headroom for a maximal frame plus the next chunk | P0-5 |
| 30 | Upload rate in the `reqq` formula | w1-12 R3: "256 KiB/s mobile default" | w1-08: 128 KiB/s after opt-in | w1-08; the formula still clamps to `reqq` 4 | none |
| 31 | Web-seed preflight remedy | w1-10: set `MaxAgeSeconds` (Firefox and WebKit untested); `_w1-part-a.md` D8: Firefox and Safari "may add `user-agent`" (unverified) | w1-13: Chromium sent one preflight per GET despite `Max-Age: 600`; WebKit preflights `xs=` for `user-agent`; the header strip gives zero preflights in both | w1-13 (executed in two engines; 0.4 rule 2); DR §6's `user-agent` question is answered for WebKit only | P0-3; P0-9; P1-1 |
| 32 | `Range` over compressed bytes | w1-10 Summary 4, F12: GitHub Pages (gzip) and jsDelivr (br) apply `Range` to compressed bytes, which WebTorrent turns into silent piece-hash failures (curl probes with `Accept-Encoding: gzip, br`) | w2a-07 F1 and Appendix C (**SUPERSEDES** for browsers): the Fetch Standard appends `Accept-Encoding: identity` to any request with `Range`; measured in Chromium 156 and WebKit 27.2 against GitHub Pages, raw.githubusercontent.com and unpkg (identity 206) | w2a-07 (later, browser measurement, explicit supersession). Keep w1-10's finding as a non-browser warning. Still broken in browsers: jsDelivr (206 cut from the brotli stream, labelled identity), cdnjs and Cloudflare Pages (200 for `Range`) | D7; P0-3; P2-9; 5.2 |
| 33 | WebKit e2e acceptance | w1-10 REC-4: Chromium and WebKit tabs exchange the site | w1-13: no ICE candidates in Playwright WebKit here | w1-13 | P1-19 |
| 34 | Degraded-mode detection | w1-08 R-10: the API is absent | w1-13: with SWs blocked the API exists and `ready` never resolves | Combine both checks with a timeout | D19; P0-2 |
| 35 | Bugout as a pattern | w1-07 §5: reuse its signed wire-extension gossip | w1-12 F11: unsigned handshake keys, floods unvalidated packets, complete-torrent rendezvous fails | w1-12 (code and lab; 0.4 rule 3) | Copy the idea, not the code (2.3) |
| 36 | Native-protocol investment | w1-07 R15: nothing beyond the PWA entry | w1-09 R4: an opt-in control at P1 | w1-09 on mechanism, w1-07 on priority: build it at P2 | P2-11 |
| 37 | Pinner seeding stack | w1-07 R1: "if a Node WebRTC shim proves stable" | w1-13: WebRTC is built into webtorrent 3.0.21 on Node 24; 5.0 s per offer; glare caveat | w1-13 (executed) | P0-2; P1-20 |
| 38 | `.mw/` inside torrents | ARCH §10's ignore list ("dotfiles") and create-torrent directory input (drops dot-paths) | ARCH §3.4.1 and w1-11 R10: `.mw/files.json` must be in the torrent; w1-11 R25 rejects a top-level `.mw` | Internal inconsistency, not a source conflict: exempt the reserved `.mw` files, pass an explicit file list, the validator accepts exactly those files | P1-4; P2-10 |
| 39 | Torrent `name` across versions | ARCH §3.4.1 and §10: a "fixed `name`" | w1-10 REC-9: `<dn>-<first 8 hex of the content hash>` | Owner decision: a versioned name gives `immutable` web-seed caching but re-uploads every file per version; a constant name allows incremental uploads but needs revalidation | P1-4; 6.4 question 30 |
| 40 | SHA-1 collision cost and who can exploit it | R01 F9: chosen-prefix collisions cost about 45k USD (2020); only the publisher could craft two contents for one infohash; a third party needs a second preimage | w1-11 F7-F8: about 45k USD at 2020 prices, now on the order of $10k (2025 re-estimate, order of magnitude only); anyone who contributes bytes to a published torrent (an avatar, a vendored asset, a theme) can prepare a bait-and-switch pair; second preimages remain out of reach | w1-11 (security topic owner, later, same sources plus the 2025 estimate) | D35; P1-5 |
| 41 | Signed pointer size | `_w1-part-a.md` P0-6: about 515 B for a v0.2 pointer with short URLs (an estimate), so 3 or more TXT strings | w2a-06 Summary 2: 246-487 B measured, so 2 strings is the normal case | No conflict on the rule: multi-string handling is mandatory either way. The numbers differ by grammar (w2a-06 read ARCH v0.1 §4, per `MIGRATION-DIGEST.md`) and by URL lengths; measure with the v0.2 grammar | P0-8 |

The amendments that follow for ARCH, INTERFACES and DR are collected in P1-24.

### 4.2 Second-pass checks of wave-1 files

#### 4.2.1 `w1-07-prior-art-VERIFY.md` (8 claims: 2 confirmed, 6 nuanced, 0 refuted)

| # | Claim | Verdict | Correction | Consequence |
|---|---|---|---|---|
| 1 | Local software stayed niche: Brave under 0.1 %; gateway traffic 9.4 % browsers, 67.4 % automated | confirmed | Brave's blog says "deprecated", its changelog "removed" (v1.69.153, 2024-08-22), with three reasons, not one; the split is a 3-day, abuse-filtered, heuristic sample; 614M requests/day is a 2025 headline (an IPFS post of 2026-08-25 says about 250M); "local software means niche" is an inference from four cases | none; "no install" stands |
| 2 | ipfs.io/dweb.link moved to a SW gateway, the strongest precedent for magnet-web | nuanced | Precedent for SW + client verification + origin per site only: the gateway has no WebRTC, never seeds, and fetches from HTTPS/WSS/WebTransport providers; "100 %" appears only in a forum post | never cite it as P2P precedent |
| 3 | Shipyard's funding ended; infrastructure and maintainers lost; SW gateway still ships | nuanced | Ceasing operation was an announced intention; on 2026-10-17 everything still answered; libp2p bootstrap `_dnsaddr` now points at `*.bootstrap.ipni.io`; current operator unknown; Kubo and Boxo READMEs say "no dedicated maintainer" | dependencies change hands quietly: P1-17 |
| 4 | Availability is the dominant, paid failure mode; the web seed is the floor | nuanced | Skynet, Cloudflare and NFT.Storage dates are announcement or transition dates, not outages; Arweave about US$82/GiB is ArDrive Turbo's retail quote incl. fees (protocol price about US$52); "dominant" was not measured | P0-2 stands; say "in every case examined" |
| 5 | Beaker post-mortem | confirmed | Add scope: "(say) 100k" is a guess about local indexers; the author puts product-market fit first | P2-12 ledger ceilings |
| 6 | ZeroNet: six fixes from one design cause; creator silent after 2019; last fork standing | nuanced | At least nine labelled security entries 2016-2019; at most five fit the shared-origin wrapper; creator committed until 2020-12-03 and merged until 2021-01-25; EpixNet is an active successor | conclusion stands, attribution weaker |
| 7 | One origin per site via single label + wildcard TLS + PSL is settled | nuanced | Every fact holds, but the PSL is not universal (ar.io and nsite hosts are not listed); NIP-5A is a draft; BEP 52 allows a 20-byte truncated infohash (40 hex fits); the IPFS spec answers HTTP 400 above 63 characters; PSL submitter continuity is a risk | one base32 label per site (D15; v0.2's 32 chars stand, 4.1 row 9); never call the PSL universal |
| 8 | Edge takedown cannot reach installed SWs; abuse figures; in-SW revocation needed | nuanced | A new 200 worker script evicts at the next update check (tested, Chromium and WebKit); 404/410/5xx never evict; first installs fail on 410; IPFS removed its worker TTL (PR #1147, 2026-07-06) and costed an in-worker denylist at 2.5-4.3 MiB without building it; moving to Cloudflare Pages silently dropped its edge enforcement; Safari ITP can delete registrations; the Cofense and Netcraft figures are scoped vendor telemetry | D17, P0-4; a hub revocation list is optional and small |

#### 4.2.2 `w1-09-protocol-handler-magnet-VERIFY.md` (8 claims: 4 confirmed, 4 nuanced, 0 refuted)

| # | Claim | Verdict | Correction | Consequence |
|---|---|---|---|---|
| 1 | `magnet` is safelisted; other names need `web+` plus ASCII letters | confirmed | Chromium's list is a 10-scheme superset of the spec; matching is case-insensitive; a Brave re-run with 57 cases matches Chromium | none |
| 2 | Handler URL rules | confirmed | In an insecure context the method is absent (no SecurityError); relative templates resolve against the document base or, in a manifest, the manifest URL; `%s` in userinfo is accepted; Firefox checks the scheme last | P1-16 |
| 3 | `%s` replaced once with `encodeURIComponent`-equivalent encoding; decode once | confirmed | Re-proved against Chromium's escape table; decode-once returns the engine-normalized magnet | none |
| 4 | Literal `#magnet:?...` links with encoded characters are over-decoded | nuanced | In the project parser only encoded `&` and `%XX` corrupt; in magnet-uri 7.0.10 an encoded `=` silently drops the tracker and an encoded lone `%` throws `URIError`; `detectMode` is gone and `parseFragment` (`app.js`, 2026-10-17 18:06 ET) already decodes once | P0-15 |
| 5 | `/#%s` keeps the magnet out of HTTP requests and logs | nuanced | True for the request line, Referer and host logs (Chromium 156, WebKit 27.2), but the SW sees the fragment in a navigation `request.url`, redirects carry it to the target's scripts, and extensions and history see it; qBittorrent's move to the hash was the author's preference, not a privacy decision | P1-15 |
| 6 | Web-handler support matrix | nuanced | Chromium on Android has the API compiled out; Firefox Android has a no-op method; EU alternative-engine iOS browsers unverified; Edge and other Chromium browsers not run | 5.1 |
| 7 | Safari/WebKit has no `registerProtocolHandler` | confirmed | Also true of the shipping system WebKit (Safari 27.0.1 engine); WebKit deleted its module on 2019-03-25 | none |
| 8 | Firefox for Android does not support it | nuanced | Functionally true, but `typeof navigator.registerProtocolHandler === 'function'` there, and the call does nothing | P2-11: feature test plus mobile exclusion |

Outside the eight claims: Chrome Platform Status says the API needs transient user activation, so w1-09 F6's "no
user-activation check" sentence is unverified (calling only from a click is right either way); the sandboxed-iframe
exposure (w1-09 F19) reproduced in Chromium 156 and Brave 155.

### 4.3 Corrections from later files (01-06, w1-08 and w1-10 to w1-13 have no VERIFY of their own)

| # | Original claim | Verdict | Correction | Verified in |
|---|---|---|---|---|
| 1 | R01 F4: the bundle uses no post-2022 APIs; run floor Chrome/Edge 103 (124), Firefox 100, Safari/iOS 16.0, Samsung Internet 27 | **Refuted** | The bundle calls `e.toHex()` and `e.toBase64()` unguarded, and `Uint8Array.fromHex()` for hex strings longer than 64 chars (uint8-util); these need Chrome/Edge 140, Firefox 133, Safari 18.2. With guarded polyfills v0.2 declares Safari/iOS 15.4, Chromium 110, Firefox 115 ESR. The local check of 2026-10-19 found one of each call in the vendored 3.0.21 bundle (sha256 as in 0.2). R01's separate parse floor still stands (4.1 row 27) | DR 16; ARCH §1, §5.1; w1-08 F-03 to F-06; this digest |
| 2 | R02 F1: all four trackers "pass a full signaling test" | **Nuanced** | True for leecher offers. `tracker.openwebtorrent.com` does not forward offers between two seeders (4/4 raw probes, 2/2 end-to-end), and two seeders started together never connect on any tracker (0/10 live) because their offers cross. All four still made rendezvous connections on 2026-10-17 (18/20; the misses were one novage outage) | w1-12 summary 3, F21, F25, e9 |
| 3 | R02 F13: the "hardened programmatic server" snippet | **Refuted** | It imported `{ Server }` (a default export) and left the crash, ping, backlog, scrape and swarm-count defects open; superseded by `labs/w2b-01-tracker-resilience-ref/tracker/tracker.mjs` | w2b-01 correction 1 |
| 4 | R02 F17: no public WebTorrent-protocol Durable Object tracker exists | **Refuted** | `manalejandro/cf-feditorrent` is a partial one; w2b-01 built a prototype in `cf-do/` | w2b-01 correction 2 |
| 5 | R02 R5, F19: public MQTT brokers as the third fallback plane | **Nuanced** | MQTT brokers are on mainstream DNS block lists | w2b-01 correction 4 |
| 6 | R02 R3: keepalive announce | **Refined** | Keepalive announces must carry `numwant: 0`; changing cadence and reconnect needs per-instance patches of internal objects | w2b-01 correction 5 |
| 7 | R02 G14: 403, 503 and TLS failures all look like close code 1006 to the page | **Confirmed, refined** | Eleven failure classes all reached page script as a generic `error` plus `close(1006)` in Chromium 156 and WebKit 27.2; a Playwright harness (`socketerror`) or a Node probe can read the reason, page script cannot | w2b-04-VERIFY claim 1 |
| 8 | R05 F9: IANA underscored registry "69 entries, 16 of type TXT" | **Refuted (count only)** | 72 records, 17 TXT (R05 left out `_dmarc`). Still true: `_magnet`, `_btlink`, `_dnslink` and `_atproto` are unregistered; `_x402` was registered 2026-08-11 on a draft that is now at -03 | w2c-06-VERIFY claim 2 |
| 9 | R01 F1, F9, F10: 3.0.21 is latest; BEP 52 not implemented; the `xs=` fetch checks the infohash | **Confirmed** | Still latest on 2026-10-17; a non-matching `xs` torrent is dropped with a `warning` (not an error) and the client continues with trackers and `ut_metadata`; "maintenance mode" is an inference, so say "dependency-bump cadence" | w2c-06-VERIFY claim 7 |
| 10 | R06 F10 and summary 7: 1.3x10^7 H/s with 5 Workers on an M3 (about 1 ms per 14-bit mint) | **Nuanced** | Those rates are for 43-byte single-block preimages. v0.2 hashes the whole canonical header (394-528 B, 7-9 SHA-256 compressions): a 16-bit mint takes 38.8-48.8 ms with 5 Workers in Chromium 156 (48-69 ms in WebKit 27.2) and 174-283 ms with 1 Worker in Chromium (201-234 ms in WebKit); a WebCrypto loop on WebKit takes 0.8-1.0 s. One native core fills the 8 MiB cap at 16 bits in about 13 min. Phone figures are unmeasured. "Hashcash does not stop a flood" is confirmed | w2b-04-VERIFY claim 5, corrections 2-3 |
| 11 | R06 F47: WebCrypto ECDSA P-256 verify 15.0-15.4k/s | **Nuanced** | Chromium-only. WebKit 27.2 is about 1.5x slower (8.8-9.9k/s); through the 2-worker pool the 8 MiB default (15.8k-22.0k blocks) needs 1.1-1.9 s on an M3; phones unmeasured | w2c-02-VERIFY claim 5 |
| 12 | R06 3.1.2-3.1.3: strict per-author `s` and equivocation rule 7 (two ops with the same `(a, s)` hide all later ops) | **Nuanced** | Reusing one key on several devices (a recovery-phrase restore) would freeze that identity for good, as SSB and Manyverse describe ("irrecoverably stuck"). v0.2 made `seq` informational, so clones are harmless for validity. Do not bring back rule 7 without per-device keys | w2c-03-VERIFY claim 6 |
| 13 | R06 F51 and 3.1.9: a non-extractable key is usable by any same-origin script | **Confirmed, stronger** | Re-run in Chromium 156 and WebKit 27.2: a forged signature verifies under the visitor's key, and the key object can even be structured-cloned to another origin | w2c-03-VERIFY claim 1 |
| 14 | R06 F25, R04 F21, R01 F30: Safari deletes script-writable storage after 7 days without interaction | **Nuanced** | The clock counts 7 days of Safari use without interaction, applies only while Prevent Cross-Site Tracking is on, and its unit is the registrable domain; `persist()` returned false even in a persistent profile. w1-08 adds that WebKit trunk counts 30 operating days and the shipping value is unknown | w2c-03-VERIFY claim 2; w1-08 F-19 to F-22 |
| 15 | R06 F52: iOS `DataCloneError` reports for ECDSA keys | **Nuanced** | October rate is 7-15 a day; the cause is an unverified hypothesis; Playwright's default WebKit context is incognito-like and a persistent WebKit profile round-trips keys across restarts; a new variant has `indexedDB` missing entirely | w2c-03-VERIFY claim 3 |
| 16 | R06 F45: Ed25519 in WebCrypto in every major engine | **Confirmed** | Engine support confirmed; P-256 is not the only curve in WebAuthn, VC or did:key ecosystems | w2c-03-VERIFY claim 4 |
| 17 | R03 summary 1: plan for 15-30 % of peer pairs needing a relay | **Refined** | The circulating figures are vendor estimates or 2016 data; the only first-party sample is 22 % of conferences (callstats.io, 2016). Planning range 10-30 % of peer pairs for consumer traffic, higher for corporate networks and CGNAT-heavy mobile, nearly 100 % for UDP-blocked visitors; failure belongs to the pair. Replace with the loader's own funnel | w2b-03 F-01 |
| 18 | w1-10 Summary 4, F12: `Range` applied to compressed bytes | **Superseded for browsers** | See 4.1 row 32 | w2a-07 F1, Appendix C |
| 19 | w1-10 REC-7: strip the two non-safelisted headers (P1) | **Confirmed, promoted** | `cache: 'no-store'` plus `Range` does not preflight; usable hosts rise from 6 to 13 of 24; promoted to P0 | w2a-07 R1, Appendix C |
| 20 | w1-10 F23, F34: Vercel Pro includes 1 TB then $0.15/GB and 10 M requests; the 10k-visits/day cost table | **Superseded / refined** | Vercel moved to Flat Rate CDN tiers (Pro includes 1 M requests and 1 TB; $20/month 10 M and 50 TB; $100/month 50 M; $300/month 150 M; on-demand $0.15-0.35/GB and $2.00-3.20 per M); the cost table gains the web-seed fan-out of P + F - 1 range GETs (plus F preflights) per cold visit, so request-priced rows rise for many-file layouts | w2a-07 F5, F14, F20, Appendix C |
| 21 | w1-10 F13, F20: Cloudflare's compression and `Range` behaviour unknown; R2 `Range` through a custom domain unknown | **Answered / partly answered** | Cloudflare documents that it ignores `Range` when it must decompress and fetches 1 MiB aligned ranges from the origin; Pages documents 200 for `Range`; R2's S3 API implements `Range` and the edge behaviour is documented, not exercised | w2a-07 F7, F8, Q1 |
| 22 | w1-11 F11-F13: unbounded wire length prefix | **Confirmed** | Measured in Node: `0xFFFFFFFF` takes the keep-alive branch and buffers nothing; the worst case is `0x7FFFFFFF`; the "4 GiB" wording of ARCH §12 test 11 is wrong | w2b-05 F41; w2c-05 Summary 2 |
| 23 | w1-11 F4: one reported site can get a whole shared loader domain flagged; PSL separation is the remedy (medium confidence) | **Nuanced** | Safe Browsing mechanics hold, but Chromium and Firefox source show private-section PSL entries are not used, so PSL-listing the hub does not stop a parent listing from covering every label | w2b-06-VERIFY claim 7 |
| 24 | w1-07 F21 lesson: small-site peer density is near zero | **Quantified** | A model gives 0 % of a 5 MB site's first-visit bytes from peers at any traffic level under the race policy | w2a-07 F23 |

### 4.4 Claims verified by execution or a second primary source

| Claim | How it was verified | Source |
|---|---|---|
| Stock SW multi-tab race: 0/120 correct once a second same-origin tab exists | lab e2 (`statuses: {"404": 120}`) | R01 F19 |
| `ws=`-only never gets metadata; `ws` plus `xs` completes in 205 ms; ACAO-only seeds give 0 bytes; `btmh`-only gives `Invalid torrent identifier` | lab e3 | R01 F9, F10 |
| An extended message of 262,144 B payload (262,145 B with the id byte) silently destroys the Chromium connection; a 262,143 B payload arrives | lab e4; re-observed by accident in w1-12 e7 | R01 F24; w1-12 gotcha 2 |
| `uploadLimit: 0` blocks metadata; 512 B/s completes in 732 ms; `throttleUpload(0)` delivers 0 of 15 frames until restored | labs e10, e12 | R01 F25 |
| Rate 0 froze 0 of 30 frames on every wire of the client; 30 of 30 at 262,144 B/s | `labs/12-signaling-lab/` e4 | w1-12 F15, R6 |
| Metadata-less rendezvous wires 15/15 local and 18/20 on four live trackers; the one-piece anchor 0/15 and 0/10 when peers join together | `labs/12-signaling-lab/` (local runs, e9 live); `seedertest.py` | w1-12 F20-F25 |
| Head-of-line delay p50 0.5-0.7 s and p99 up to 4.3 s without `reqq`; median 3-14 ms with it | `labs/12-signaling-lab/` (loopback) | w1-12 F16-F17 |
| Importing the bundle deletes OPFS `chunks`; `torrent.destroy()` keeps data; re-add from OPFS in 53 ms | lab e6 | R01 F12 |
| `idb-chunk-store` without `Buffer`: the read callback is never invoked | lab e9 | R01 F13 |
| Custom SW from Cache Storage: 100/100 with a second tab; the lab SW answered a `Range` request with 200 (production must return 206) | lab e7 | R01 F20 |
| SW: opaque sandbox not controlled (`SecurityError`); idle SW killed within 85 s; a page-fed 120 s stream with 40 s gaps survives; same-URL dispatch works; a hard reload bypasses only the top-level document | `labs/04-sw-experiment/results-chromium-156-2026-10-14.txt` | R04 F23 |
| An attribute-sandboxed `allow-scripts` frame gets zero fetch events and is not a SW client; a CSP-header sandbox lets the SW answer the navigation but the page is uncontrolled | `labs/w1-11-opaque-frame-lab/` | w1-11 F1-F2 |
| A `0x7FFFFFFF` length prefix gives quadratic CPU and 8 GiB RSS | w1-11 PoC; re-run in Node by w2b-05 | w1-11 F11-F12; w2b-05 F41 |
| A 200 replacement `/mw-sw.js` evicts an installed worker at the next update check; 404/410/5xx never evict; first installs fail on 410 | `labs/w1-07-verify-lab/sw-takedown/` (Chromium 156, WebKit 27.2) | w1-07 VERIFY claim 8 |
| `magnet` safelisting and handler URL rules; the SW sees the fragment of a navigation | `labs/w1-09-verify-lab/` (57 cases on Brave match Chromium; Chromium 156 and WebKit 27.2) | w1-09 VERIFY claims 1-2, 5 |
| The base64/hex polyfill passes 78/78 test262 cases on V8 and JavaScriptCore; `AbortSignal.timeout` polyfill aborts with `TimeoutError` | `labs/w1-08-mobile-lab/` (`run-t262.mjs`) | w1-08 F-03 to F-06, R-01 |
| The header-stripped own bundle gives zero preflights in Chromium 156 and WebKit 27.2 and still transfers a torrent; 219-226 KB raw | `labs/w1-13-lab/` (`b1-build.mjs`, esbuild 0.28.2) | w1-13 checkpoint 2 |
| Node 24 + webtorrent 3.0.21 seeds a browser with no extra packages; Node-side signalling costs 5.0 s per offer; glare (#401) dropped the working connection | `labs/w1-13-lab/` | w1-13 checkpoint 2 |
| DoH CORS matrix; the TXT normaliser gives byte-identical sets across 5 retrieval paths for 8 names; 32/32 checks | Brave 155 runs (R05 Appendix A, B) | R05 F1, F3 |
| Chromium 500 `RTCPeerConnection` cap, 16 MiB send queue, 256 KiB message size | re-read in current Blink, libwebrtc and WebKit sources | R03 Appendix B |
| Corrected inside R03 before publication: the Metered free tier is 20 GB (not 50); Firefox Android mDNS is enabled (the gecko-dev mirror was stale); the Cloudflare TURN free tier is 1,000 GB (pricing page 2026-09-22); "86 % direct" (2013) discarded | primary vendor pages and mozilla-central | R03 Appendix B |
| Every live tracker answered a real announce and relayed an offer and an answer between two fake peers | `labs/02-wss-trackers-probes/relaytest.py`; re-confirmed 2026-10-17 by w1-12 e9 | R02 F1 |

---

## 5. Constraints discovered

### 5.1 Compatibility

#### 5.1.1 Minimum-browser matrix

w1-08 §Minimum-browser matrix, with DR 16's declared floor added and the hard floor corrected for the unmodified
vendored bundle (4.1 row 27; w1-08's original values in brackets):

| Engine | Refuse below (hard floor) | Declared floor (DR 16) | Tier 1 tested (w1-08) | Native base64/hex | Global traffic below Tier 1 (caniuse 2026-10-13) |
|---|---|---|---|---|---|
| iOS / iPadOS (every iOS browser is WebKit) | 14.5 | 15.4 | 16.4 | 18.2 | 0.40 % (2.7 % of iOS Safari) |
| macOS Safari | 14.1 | 15.4 | 16.4 | 18.2 | 0.14 % |
| Chromium: Chrome, Edge, Android Chrome, WebView, Brave | 85 [w1-08: 80] | 110 | 110 | 140 | Chrome desktop 1.23 %, Edge 0.04 % |
| Firefox desktop and Android | 79 [w1-08: 78] | 115 ESR | 115 ESR | 133 | 0.01 % |
| Samsung Internet | first release on Chromium 85 or later [w1-08: 13.0 (Blink 83)] | 21 (Chromium 110) | 21.0 | 30.0 | 0.01 % |

Without the polyfill about 8.5 % of global traffic fails in `new WebTorrent()` (iOS Safari below 18.2 alone is
1.10 %). Unlisted engines (UC, QQ, stock Android, unmapped Opera) are best effort.

#### 5.1.2 Browser facts with versions

| Fact | Consequence | Source |
|---|---|---|
| Secure context required: torrent SHA-1 hashing uses `crypto.subtle` with no JS fallback; SWs need HTTPS or localhost; `bittorrent-tracker` silently skips `ws://` trackers on https pages; `http://192.168.x.x` gives no SW and no `crypto.subtle` | HTTPS static host is mandatory; `wss://` only; phone demos over HTTPS or localhost forwarding (D37) | R01 F5; w1-10 F35 |
| WebTorrent 3.0.21 parse floor Chrome/Edge 85, Firefox 79, Safari/iOS 14.1 (class fields, `??=`); run floor without polyfills Chrome/Edge 140, Firefox 133, Safari 18.2 (`Uint8Array` hex/base64); `AbortSignal.timeout` Chrome 124 (103-123 abort with `AbortError` instead of `TimeoutError`, harmless here), Firefox 100, Safari 16, Samsung 27, and a missing `AbortSignal.timeout` makes every web-seed request fail silently; `crypto.randomUUID` only in the OPFS default store name; `BigInt` once (bencode); no `structuredClone`, `.at(`, `findLast` or `BigInt64Array` in the bundle | Polyfill first; v0.2 floor Safari/iOS 15.4, Chromium 110, Firefox 115 ESR | R01 F4; w1-08 F-03 to F-06; DR 16; 4.1 rows 26-27 |
| OPFS `getDirectory` Chrome 86, Firefox 111, Safari 15.2; native `createWritable` Safari 26 (earlier: a blob module-Worker polyfill that needs `worker-src blob:`); `getDirectory()` throws in Firefox private windows; in Safari private sessions OPFS throws and IndexedDB rejects Blob/File values | Own chunk store; a private-session probe with an ArrayBuffer fallback (P1-13) | R01 F4, F12, F14; w1-08 F-19 to F-22 |
| SW: Chrome 45, Firefox 44, Safari 11.1, iOS 11.3; Firefox private windows from 140 (ESR 128 never); module SWs Firefox 147+; SW static routing only Chrome 123 and Safari 27; transferable `ReadableStream` Chrome 87, Firefox 103, Safari 27; `Client.frameType` Chrome 43, Firefox 44, Safari 11.1; `WindowClient.ancestorOrigins` Safari 16+ only | Classic SW; keep the MessageChannel protocol for iOS 26 and older | R04 F15, F22, R3, G20, G22 |
| SWs absent: generic in-app WKWebViews (Apple, Feb 2025; App-Bound Domains allow at most 10 domains; iOS third-party browsers get SWs through the browser entitlement), Lockdown Mode, Firefox private windows before 140; Android WebView hosts may lack DOM storage; non-WebKit iPhone engines are allowed in the EU and Japan, none shipped per OWA | Degraded mode or "open in Safari" (P0-2) | R01 F29; R04 F15; w1-08 F-25, F-26, F-28, G-17, G-18 |
| SW lifetime: Chromium 30 s idle, 5 min per event, an open stream keeps it alive; Firefox about 30 s plus 30 s, no keep-alive for open streams (bug 1302715), unregisters after 3 navigation faults; WebKit lifetime follows clients, 10 s delay, network fallback after 70 s for a SW-handled main-document navigation | No state in SW memory; ping at most every 20 s; answer navigations in under 25 s | R04 F13, R5 |
| Frames sandboxed without `allow-same-origin` are not SW-controlled (Chrome 155, Firefox 158, Safari 27) | Origin-only isolation | R04 F11; w1-11 F2 |
| WebRTC APIs: `RTCPeerConnection` Chrome 56, Firefox 44, Safari 11; `pc.sctp` and `maxMessageSize` Chrome 76, Firefox 113, Safari 15.4; `connectionState` Firefox 113; `restartIce()` Chrome 77, Firefox 70, Safari 14.1; `setConfiguration()` Firefox 99; `getSelectedCandidatePair()` Chrome 75, Firefox 154, Safari 16.4; none of them in workers or SWs | Feature-detect; use `getStats()` for candidate types | R03 F-18, F-37 |
| Data channels: Chrome and Safari advertise 256 KiB max message, and in Chromium an extension frame whose payload plus 1 byte exceeds 262,144 B silently kills the connection; Firefox accepts about 1 GiB locally but assumes 64 KiB when the remote omits the attribute; Chrome and Safari throw `OperationError` past 16 MiB `bufferedAmount` | 16 KiB frames (v0.2: 15 KiB) | R03 F-25, F-26; R01 F24; w1-12 gotcha 2 |
| Caps: Chromium 500 live `RTCPeerConnection`s per renderer and 3,000 P2P sockets; WebKit closes the oldest RTC socket above 256 per web process; WebTorrent `maxConns` 55 limits only TCP dials, not WebRTC wires (`maxConns: 2` still gave 4 wires) | Own wire cap in the `'wire'` handler | R03 F-31; w1-12 F18; ARCH §1 |
| mDNS host-candidate hiding: Chrome 76, Firefox desktop 74, Firefox Android from 149 (bug 1581947), Safari on by default; Chrome 142+ Local Network Access prompts may affect LAN peers | Headless tab-to-tab tests need `--disable-features=WebRtcHideLocalIpsWithMdns` | R03 F-16, F-19, F-20, F-23, F-39 |
| Safari Lockdown Mode: no `RTCPeerConnection`, no SW, no Cache API or CacheStorage, no Web Locks; IndexedDB flagged in source but not device-tested; WASM blocked even with a site exception since iOS 17.4 (WebKit 273824) | Host-only or degraded mode plus "Turn off Lockdown Mode for this website" | R03 F-21; R04 F15; R06 F26 |
| Tor Browser: no WebRTC and no SW; Brave Tor windows throw `NotAllowedError` on `new RTCPeerConnection`; Brave's "Disable non-proxied UDP" removes UDP P2P; Brave hides host candidates and randomizes `hardwareConcurrency` | Host-only mode; cap worker pools explicitly | R03 F-24; R01 F32; R06 F28 |
| Ed25519 WebCrypto: Chrome/Edge/WebView 137, Firefox 129 (130 is X25519), Safari 17, Samsung Internet 30 (29 lacks it); P-256 since Chrome 37, Firefox 34, Safari 7; Safari Ed25519 signatures are randomized; `SubtleCrypto.supports()` only in Chrome 155 (experimental); X25519 keys fail an IndexedDB round trip in WebKit | P-256 in v0.2; feature-detect with `generateKey` | R06 F45-F50; w1-08 F-24, F-32 |
| Integrity: import-map `integrity` Chrome 127, Firefox 138, Safari 18; `modulepreload` integrity Chrome 66, Firefox 115, Safari 17; iOS 16 has neither; `import()`, `serviceWorker.register()` and `new Worker()` have no integrity option; signature-based SRI is Chrome 141 only | Bundle WebTorrent into the SRI-checked loader (D2); the static host stays the trust root (5.2) | w1-10 F28; w1-11 F34-F35 |
| `SharedWorker` only from Chrome Android 148 and absent on Samsung Internet; the Page Lifecycle `freeze` event is Chrome-only | Web Locks plus BroadcastChannel | R06 F22, F24 |
| Storage: Safari deletes IndexedDB, SW registrations and Cache after 7 days of Safari use without interaction, only while Prevent Cross-Site Tracking is on, per registrable domain (WebKit trunk counts 30 operating days; the shipping value is unknown); Home Screen apps are exempt and their storage is separate from Safari (since iOS 26 Home Screen sites open as web apps by default); eviction removes the whole origin at once; `persist()` is false in Safari tabs, a prompt in Firefox, silent in Chromium; `estimate()` is fuzzed on Safari; Chromium headless quota 2 GiB with `persisted()` false; Firefox best-effort limit min(10 % of disk, 10 GiB) | `persist()` from a gesture, identity export, Home Screen advice (P1-14) | R01 F12, F30; R04 F21; R06 F25; w1-08 F-19 to F-22, F-32; w2c-03-VERIFY claim 2 |
| Signals: iOS will never expose Network Information, Battery or Device Memory; Firefox Android removed `navigator.connection` in 99; Safari 26 masks some APIs for known fingerprinting scripts | The four-class classifier treats iOS as "unknown" (P0-16) | w1-08 F-14, F-15, G-10 |
| Mobile lifecycle: iOS stops data-only WebRTC on background or lock; Android Chrome exempts pages with an open data channel from intensive throttling but Doze can still cut the network; Firefox Android clamps inactive-tab timers to 15 min and may unload the tab | Phones are foreground-only peers | R03 F-33 to F-36 |
| bfcache: Chrome and Firefox refuse pages with an open `RTCPeerConnection`; Safari restores them with dead sockets | Rebuild on `pageshow.persisted` (D38) | w1-08 F-11 |
| Protocol handlers: `registerProtocolHandler('magnet')` on desktop Chrome 30+, Edge 79+, Brave and Firefox only; absent in Safari and every iOS browser, compiled out of Android Chromium, a no-op on Firefox Android; manifest `protocol_handlers` only for an installed PWA on desktop Chrome/Edge 96+; `share_target` needs an installed app on Android or ChromeOS and delivers links in `text`/`title` | D36; P2-11 | w1-09 §2, F11-F16; w1-09 VERIFY claims 6-8 |
| Safari probes media with `Range: bytes=0-1`; `Cache.put` rejects 206; `new Response(string)` is `text/plain`; `mime/lite` has no `.ico`, `.m3u8`, `.eot`, `.flac`, `.jxl`, `.srt`; Chromium leaks URL fragments into `event.request.url` on reload | Own MIME table, Blob slicing, strip `url.hash` | R04 F17, F18, G12 |
| Samsung Internet's UA reports `Chrome/143.0.0.0` beside `SamsungBrowser/30.0` | Gate on the Samsung version | w1-08 G-12 |

### 5.2 Hosting facts

| Topic | Fact | Source |
|---|---|---|
| AWS S3 | Website endpoints are HTTP-only. Use a private REST bucket + CloudFront OAC + ACM in us-east-1 + a CloudFront Function for the SPA fallback; custom error responses are distribution-wide and turn missing web-seed objects into `200 text/html`; behind OAC a missing key answers 403. S3 website error documents answer 404, so a shell's SPA-style fallback must return 200, but only for navigations | w1-10 F1-F4, gotchas 5-6; R04 G13, G14 |
| CloudFront | `CORS-With-Preflight` sets no `Access-Control-Allow-Headers`; the cache does not vary on Origin unless configured; flat-rate plans reserve custom response-header policies for Business and Premium (with the header strip, the managed `SimpleCORS` policy is enough, w2a-07 R9) | w1-10 F5-F6; w2a-07 Appendix C |
| Preflight | `Range: bytes=N-M` alone is CORS-safelisted; WebTorrent's `Cache-Control: no-store` and `user-agent` force preflights; a preflight cannot be redirected; `cache: 'no-store'` set as a fetch option does not | w1-10 F9-F10; w1-11 F33; w1-13; w2a-07 Appendix D |
| Compression | Browsers send `Accept-Encoding: identity` with `Range` (Fetch Standard), so ranges are not cut from compressed bytes in browsers: GitHub Pages, raw.githubusercontent.com and unpkg returned identity 206 in Chromium 156 and WebKit 27.2. Still broken in browsers: jsDelivr (206 cut from the brotli stream, labelled identity), cdnjs (200 for `Range`), Cloudflare Pages (documents 200 for `Range`). A non-browser client sending `Accept-Encoding: gzip, br` still sees w1-10's result (GitHub Pages and jsDelivr answer ranges over compressed bytes with 206; unpkg, Netlify and Vercel returned identity 206); CloudFront documents the hazard | w1-10 F12-F13; w2a-07 F1 (supersedes w1-10 F12 for browsers), F7-F8 |
| GitHub Pages | Fine for the shell. `OPTIONS` 405; no custom headers (no HSTS, nosniff, CSP); fixed `max-age=600`; the SPA fallback is an HTTP 404; 1 GB site, 100 GB/month soft limit; no commercial use; no wildcard custom domains; project sites (`/repo/`) break root-absolute URLs. After the header strip its `ACAO: *` GETs pass CORS and its ranges are correct in browsers, so it can serve as a web seed if the seed doctor passes and the use is non-commercial | w1-10 F14-F16, REC-7; w2a-07 F1 |
| Cloudflare | Pages and Workers Custom Domains take no wildcards; Worker routes (`*.hub.example/*`) with proxied wildcard DNS work on all plans; a top-level `404.html` disables Pages SPA mode | w1-10 F17-F19, F24 |
| R2 | Zero egress; `r2.dev` is rate-limited, development only; caching and WAF need a custom domain in the same account; `AllowedHeaders: ["*"]` is undocumented, so list headers | w1-10 F20 |
| B2 | $6.95/TB-month, free egress through partner CDNs; Cloudflare's CDN terms make a Free zone proxying large files a policy risk | w1-10 F21-F22; w2a-07 F9 (confirmed, guide updated 2026-06-26) |
| Netlify, Vercel | Netlify Free about 15 GB/month; Vercel Hobby non-commercial; both failed the stock preflight on the deployments measured; Vercel's paid plans moved to Flat Rate CDN tiers (4.3 row 20) | w1-10 F23; w2a-07 F14 |
| Wildcards and PSL | Wildcard origins: CloudFront + ACM, Vercel, Cloudflare Worker routes; not Pages or GitHub Pages; Netlify unverified; a wildcard covers one label, not the apex. PSL: 2+ years of registration, a `_psl` TXT that must stay, no expedite, unknown propagation; a PSL entry does not stop a Safe Browsing listing of the parent from covering every label | w1-10 F24-F25; w1-11 gotcha 6; w2b-06-VERIFY claim 7 |
| CSP | A `<meta>` CSP cannot carry `frame-ancestors`, `report-uri` or `sandbox`; `connect-src` needs both `https:` and `wss:`; an inline import map needs a hash; WebRTC is outside CSP | w1-10 F26-F27; R03 F-38 |
| Caching | The SW script must come from the page origin with a JS MIME type and a short cache; root files `no-cache` and invalidated (CloudFront: 1,000 free invalidations per month); edges otherwise hold a stale worker; purge CDN caches on deploy (a stale CDN copy bricked the IPFS SW gateway, issue #1155, July 2026) | w1-10 F31-F32; R04 G13, G14, R6 |
| Cost (model, 10k visits/day) | Shell 30-40 GB and 3-4 M requests per month: $0 to about $20 anywhere. A 5 MB site, every visit cold, 0 % P2P is about 1.5 TB/month: CloudFront PAYG about $49, R2 about $1.4, B2 + Cloudflare about $0, Vercel Pro about $105, Netlify or Amplify about $220. Per-file preflights add 33 % requests; the `cache:'reload'` precache doubles the first-visit shell. w2a-07 refines these rows (4.3 row 20); use `MIGRATION-DIGEST.md` §11 for current prices | w1-10 F34, App C; w2a-07 F5, F20 |
| Trust root | The static host and CDN are the trusted computing base on first visit and at every SW update; no browser-native mechanism pins a SW-hosted loader in 2026 | w1-10 F38; w1-11 F34-F35 |
| Phone demos | Android USB forwarding to localhost; a mkcert CA on the phone (never share the root key); Tailscale Serve; Cloudflare quick tunnel (200 in-flight cap, no SSE, a new origin per run); ngrok Free worst (1 GB, 20k requests, interstitial); tracker as `wss://` via a `/tracker` proxy | w1-10 F36-F37 |
| Prior art | Shipyard moved 15+ project sites from Fleek to GitHub Pages with CI-built CIDs and DNSLink; the IPFS SW gateway costs about 322 KB per new origin | w1-07 F10, F12, F21 |
| Own tracker capacity | `bittorrent-tracker` 11.2.3: about 17 KB per connection (235 MB RSS at 10k); 10k peers at the 120 s WS interval use about 1 % of one core; TLS without a proxy via `ws: { noServer: true }` | w1-13 checkpoint 3 |

### 5.3 Operational

- **No SLA anywhere.** Trackers are volunteer or small-company services (R02 F4); Google STUN has only a 2014 forum
  statement (R03 F-07); Cloudflare DoH has no SLA and "limited" support, Google DoH has no SLA and about 1,500 QPS per
  IPv4 address or IPv6 /64 with 429 and `Retry-After` (R05 F6). Attrition is real: ten tracker hostnames died (R02
  F1), and defaults rot silently (create-torrent's default list includes the dead `tracker.btorrent.xyz`;
  `hub.bugout.link` has no DNS); IPFS infrastructure changed hands during the research (w1-07 VERIFY §10; w1-12 F11;
  w1-13).
- **Trackers.** Live: `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua`,
  `open.ftorrent.com`; openwebtorrent does not pair two seeders. Idle sockets close after about 125 s
  (openwebtorrent), 134 s (webtorrent.dev) and 184 s (ftorrent); nginx defaults to 60 s. The stock client then
  reconnects after `10 s x 2^retries + U(0, 5 min)` (median 171 s measured) and `announce()` is a no-op meanwhile;
  local DNS block lists can sinkhole tracker or broker names. Default `numwant` 5 costs about 17 messages per 120 s
  per visitor per swarm per tracker (R02 F10, G2, G5, G6; w1-08 F-12; w1-12 F25-F26; ARCH §1).
- **Offer cost.** Up to 5 `RTCPeerConnection`s per tracker per announce, trickle ICE off (each offer waits for full
  gathering, 5 s ICE timeout), about 5 s extra on UDP-blocked networks, offers expire after 50 s (R01 F7; R02 F8, F9).
- **Relays.** Without TURN, failing pairs load from the host. TURN credentials expire hard (Cloudflare at most 48 h;
  Metered `expiryInSeconds` is a hard cutoff and new credentials take up to 2 min to propagate) (R03 G-09).
- **DNS.** Create the TXT record before anyone visits (negative caching lasts min(SOA TTL, MINIMUM), measured
  300-1,800 s); the minimum TTL is 60 s on Cloudflare (30 s on Enterprise) and typically 600 s on Porkbun; Route 53
  values reach 4,000 characters in strings of at most 255; the Terraform AWS provider adds the outer quotes itself;
  enterprise networks block DoH hostnames; the first lookup costs 100-460 ms cold and 2-20 ms warm from one vantage
  point (R05 F7, F11, F12, F15, F16).
- **Tracker server software.** `bittorrent-tracker` 11.2.3 never prunes swarms, never pings, accepts messages up to
  100 MiB (w1-13 confirmed that the default `ws` `maxPayload` accepted a 1 MB message; set 65,536), keeps a
  per-swarm LRU of 1,000 peers, trusts any `X-Forwarded-For` with `--trust-proxy`, ignores `numwant` and forwards up
  to 82 offers, relays answers with an unvalidated `offer_id`, lists every swarm on a `scrape` without an infohash,
  and `filter()` refuses an announce without creating the swarm. `aquatic_ws` needs Linux >= 5.8, a memlock limit
  and (v0.9.0) Rust < 1.93. Oracle Always Free needs stateless rules (stateful ones drop new connections at about
  40 k peers) and reclaims instances idle for 7 days (CPU p95, network and memory all under 20 %). Caddy reloads close
  all WebSockets unless `stream_close_delay` is set (R02 F13-F16, G7-G13; w1-13 checkpoint 3).
- **Inbound wire memory.** `bittorrent-protocol` reads the 32-bit length prefix as signed and buffers any declared
  length with no cap (found after R01; ARCH §1 and §13 cap it at 256 KiB per wire; P0-5 fixes the read) (w1-11 F11).
- **Client behaviour (webtorrent 3.0.21).** `maxConns` is ignored for WebRTC; the throttle is client-global and rate
  0 freezes handshakes; a metadata-less torrent announces `left` as `null`, which the reference tracker reads as a
  seeder; two clients in a page share tracker sockets; peers' `reqq` is honoured; per-torrent `getAnnounceOpts` is
  marked "consider deprecating" (w1-12 F15-F19, gotchas 3, 11).
- **create-torrent 6.1.3.** The infohash depends on file order, `name`, piece length, `private` (even `false`) and
  `info` extras; not on dates, comments, trackers or the URL list. A `creationDate` of `0` or `new Date(0)` is
  silently replaced by now, and a plain number is read as milliseconds. Directory input drops every dot-path and uses
  `readdir` order. Piece length is 16 KiB below 16 MiB, 256 KiB at 256 MiB, capped at 4 MiB (w1-13).
- **magnet-uri 7.0.10 / parse-torrent 11.0.24.** Case-sensitive (`MAGNET:?XT=` parses to nothing); no infohash
  validation (39 hex characters decode as base32 into a wrong, valid-looking hash); an unencoded `=` or `&` inside a
  value drops it silently; `x.pe` is not decoded; parse-torrent rejects v2-only `urn:btmh:` magnets (w1-13; w1-09
  VERIFY claim 4).
- **BEP 47 padding.** create-torrent emits none; WebTorrent treats `.pad/<n>` as ordinary files fetched from the web
  seed and never completes if the host answers 404; servers must clamp ranges past a file's end. Cross-version piece
  reuse: 16 KiB pieces 6.1 % unpadded, 83.1 % padding big files (+8.9 % size); 256 KiB pieces 0 % and 30.8 %
  (+12.4 %) (w1-13).
- **Node WebRTC.** WebTorrent pins node-datachannel ^0.32.3, whose install script uses deprecated prebuild-install
  and is skipped under `ignore-scripts`, npm 11 defaults, Deno and pnpm 10; an override to 0.33.4 works. Deno 2.9.7
  needs `--allow-scripts=npm:node-datachannel` and `--allow-ffi`. Node-side signalling costs 5.0 s per offer;
  webtorrent-hybrid is deprecated (w1-13).
- **node:test on Node 24.22.** `node --test test/unit` fails (directories are not walked); use globs and always pass
  `--test-timeout` and `--test-force-exit` (one file hung 3 to 21 minutes) (w1-13).
- **Playwright on this Mac.** Firefox 157 does not launch; WebKit 27.2 gathers no ICE; with SWs blocked `register()`
  resolves and `ready` never does; `context.serviceWorkers()` sees Chromium workers only; tab-to-tab WebRTC needs
  `--disable-features=WebRtcHideLocalIpsWithMdns`; own-LAN-IP origins time out (w1-13; w1-12 method).
- **Network policy (binding).** Everything an agent runs stays on 127.0.0.1: Chromium through `chromiumArgs()` from
  `test/e2e/browser-args.mjs`, WebKit only on `http://127.0.0.1` URLs, `iceServers: []` for loopback tests, and remote
  probes only in Node from `tools/check-site.mjs`, `tools/check-webseed.mjs` and `pin.mjs`. The research harnesses
  predate `docs/DEV-NETWORK.md`: `labs/01-webtorrent-lab/run-page.sh` launches the user's own Brave by default, without
  `--host-resolver-rules` (its WebRTC pages already pass `iceServers: []`); `labs/04-sw-experiment/server.mjs` launches
  whatever Chromium binary it is given, also without `chromiumArgs()`; the `labs/02-wss-trackers-probes/*.py` scripts
  contact public trackers, Nostr relays and MQTT brokers. Any re-run must follow the policy, so w1-12's e9 live-tracker
  browser test and the w1-07 and w1-12 endpoint probes need Node or a separate runner, and tunnel or tailnet demos are
  owner-run (`docs/DEV-NETWORK.md`).

### 5.4 Threat-model inputs

- **Assets (w1-11 §2.1):** A1 code integrity at an origin; A2 owner root key; A3 visitor identity key and local data;
  A4 visitor network identity (IP plus infohash = who reads what); A5 availability; A6 site-ledger integrity and
  moderation authority; A7 loader-domain reputation; A8 legal position of owners, hub operators and visitors.
- **Adversaries (§2.2):** malicious peer or Sybil; malicious tracker, STUN, DoH or web-seed operator; on-path or DNS
  attacker; malicious publisher or contributor; compromised host, CDN or DNS account; compromised owner key; XSS in a
  legitimate site; supply-chain attacker; right-holder monitoring swarms; regulator or abuse reporter.
- **Trust boundaries (§2.3):** the origin is the security principal; in per-domain and drop-in modes site code holds
  loader privilege; peers are hostile by default; a tracker can MITM DTLS through SDP, so integrity comes from hashes
  and signatures and confidentiality is never claimed (w1-11 F15); DNS TXT is an unsigned channel whose authority is
  the owner signature.
- **Catalogue priorities (§2.4):** P0 T1 (shared origin), T2 (drive-by load), T3 (wire length), T18 (illegal content
  seeded by visitors), T22 (redaction obligations, design); P1 T4-T9, T11-T13, T16, T17, T19, T21, T23, T24; P2 T10,
  T20; P3 T14, T15.
- **Inputs from the other wave-1 files, not in w1-11's catalogue:**
  - Installed workers survive edge refusals; only a 200 script evicts; ITP may delete registrations (w1-07 VERIFY
    claim 8) -> reach of T20 mitigations.
  - Fragments reach the SW, redirect targets, extensions and history (w1-09 VERIFY claim 5) -> T17.
  - A hosted site on a shared origin can register itself as the `magnet` handler (w1-09 F19) -> T1.
  - The rendezvous infohash is guessable for any known domain (a label, not a secret); a hostile `metadata_size`;
    eclipse with 6 slots is unmodelled (w1-12 F20a, F22, F27) -> T6.
  - Tracker servers relay unvalidated answers and enumerate swarms through `scrape` (w1-13) -> T15, T17.
  - Silent loss of the identity and the TOFU pin on Safari makes "first visit on this device" routine, which weakens
    pin warnings (w1-08 F-20; G-01) -> T11, T13.
  - Shared-domain phishing history (w1-07 F11) -> T23; contributor bait-and-switch (w1-11 F8) -> T16.
  - Install scripts: 6 of 251 locked packages, including `ip-set`'s preinstall `npx only-allow pnpm` (w1-11 F36) ->
    T19.
  - Visitor IP and infohash reach peers, trackers and STUN operators, and the hostname reaches the DoH provider; mDNS
    hides only LAN addresses; CSP cannot stop hosted-site code from opening its own peer connections (R03 F-17,
    F-38; R05 F13) -> A4.
  - A non-extractable key is usable by any same-origin script and can be structured-cloned to another origin (R06
    F51; w2c-03-VERIFY claim 1) -> A3.
  - BitTorrent v1 integrity rests on SHA-1: chosen-prefix collisions cost on the order of $10k (about 45k USD in
    2020), so whoever controls bytes inside a torrent can prepare two contents for one infohash, while a third party
    without such access still needs a second preimage (R01 F9; w1-11 F7-F8) -> A1, T16.
  - A PSL entry does not shield a hub from a Safe Browsing listing of the parent (w2b-06-VERIFY claim 7) -> A7.

### 5.5 Legal and policy (topic 14 was never researched)

Nothing below is legal advice, and no file in this set was reviewed by counsel. w1-11 itself asks for counsel review
of the consent and takedown design per jurisdiction.

- **IP addresses are personal data** for an operator with legal means to identify the visitor (GDPR Recital 30; CJEU
  Breyer C-582/14). Trackers see IP, infohash and SDP; peers and STUN see the IP; the DoH resolver sees IP and
  hostname, and Google DoH forwards the visitor's /24 to authoritative servers unless `edns_client_subnet=0.0.0.0/0`;
  the web-seed host sees IP and `Origin` (w1-11 F16; R05 F13; R03 F-17). R03 R-11 drafted a disclosure "for legal
  review"; the final strings are DR §4.5.
- **Redistribution.** Every visitor relays the site's files and other people's site-ledger entries while the page is
  open (R06 3.2 #12, Q12). Uploading pieces is "making available to the public" even when the pieces are unusable
  alone (CJEU Mircom C-597/19), a holding the Court tied to an informed user; right-holders may record swarm IPs where
  national law allows. A download-only visitor (choke lock) is outside the uploading holding but still exposes the
  IP (w1-11 F17). Liability and takedown were not researched in 01-06; `w2b-06-abuse-legal-ops.md` covers them later.
- **ePrivacy Art. 5(3)** (EDPB Guidelines 2/2023) reaches an entity that instructs a device through a protocol to send
  IP or session identifiers; peer sharing is the part that most needs consent, and the DoH lookup currently runs
  outside the gate (w1-11 F18).
- **Hashes and deletion** (EDPB Guidelines 02/2025 v2): a hash of personal data is personal data and an unsalted hash
  is not sufficient; deletion in a replicated log is a request honoured by cooperating copies, so never promise
  erasure (w1-11 F29-F30, gotcha 15).
- **Hub-by-magnet** makes visitors redistribute arbitrary content; the only levers are an allow-list, a denylist at
  the gate and at boot, a report channel and a takedown process; none is a safe harbour (w1-11 F20-F21; w1-07 F11).
  Shared gateways are phishing magnets (scoped figures in 4.2.1 claim 8).
- **Third-party terms.** No tracker operator publishes an abuse policy or forbids using trackers as a generic
  rendezvous (openwebtorrent: "free for anyone to use"); ftorrent publishes a circuit breaker (24 h of `503` above
  200 M relayed offers per rolling 24 h) (R02 F4, F12, G22). Google STUN: free "for development purposes", commercial
  apps should "deploy your own" (2014). Cloudflare, Metered and Twilio acceptable-use terms for BitTorrent-style
  relayed traffic were not found (R03 G-11). Cloudflare and Google DoH terms do not forbid embedding but promise
  nothing (R05 F6).
- **Host terms.** GitHub Pages forbids commercial use; Vercel Hobby is non-commercial; Cloudflare's CDN terms
  restrict large files on non-Developer-Platform plans; whether hosts' acceptable-use terms allow a site whose
  visitors re-serve its content was not read (w1-10 F14, F21, F23, Q13).
- **Licences and provenance.** `webtorrent` is MIT with npm provenance (R01 F1); `@noble/ed25519` 3.x is not
  independently audited (v1 was, Cure53 2022) (R06 F49); smoldot is GPL-3.0-or-later with a Classpath exception,
  relevant only if a chain client were bundled (R06 G18); the ftorrent tracker is GPL-3.0 but is operated, not shipped
  (R02 F4).
- **Naming and registries.** `KayleePop/magnet-web` (MIT) already uses this name for the same idea (R04 F3); `_magnet`
  is not in the IANA underscored-names registry, whose bar is Expert Review (R05 F9, F10; w2c-06-VERIFY claim 2).
- **Copy discipline.** Do not copy webtorrent.io's VPN statements (w1-11 F19); DR §4.5's "There's no private mode"
  text is accurate; never "uncensorable" or "impossible to shut down" (w1-07 §4 Avoid 5), nor DR §4.2's banned terms
  ("serverless", "no servers", "unstoppable", "censorship-resistant", "fully decentralized").

---

## 6. Open questions

Numbered once across all groups. "(device)" = only real phones or browsers can answer it.

**Answered by wave-1 or later evidence, so not repeated below:** which swarm carries site-ledger gossip across
releases (R06 Q6): the bare-infohash rendezvous swarm (w1-12 F20-F25; 4.1 row 22); whether WebKit adds `user-agent`
to the web-seed preflight: yes for the `xs=` fetch (w1-13; Firefox stays open, question 17); whether hosts cut browser
ranges from compressed bytes: no, except jsDelivr (w2a-07 F1; 4.1 row 32); the hub label length: v0.2's 32
characters stand (w2c-04 Summary 3; 4.1 row 9).

### 6.1 Answerable locally (a Node probe or a 127.0.0.1 test)

1. Does the 90 s `scrape` keepalive make `tracker.openwebtorrent.com` drop the socket every time, and what is the
   cheapest offer-free keepalive the stock client can send? (Node probe; R01 F8, R02 F1, R3; w2b-01 correction 5;
   P0-1)
2. Do the v0.2 validity rules satisfy Byzantine Eventual Consistency (model check), how do peers detect divergence,
   and what are realistic entries per site, bytes per entry and IndexedDB throughput on iOS (device for the last)?
   (R06 Q9, Q11, Q16)

### 6.2 Needs a real device or a real network

3. What is the real relay share by device class and network pair (iOS, Android, desktop; LTE-to-LTE; CGNAT), and so
   is a TURN tier needed? (device; R03 Q1, Q8; R02 Q8; w2b-03 F-01)
4. How long do an open data channel and a tracker socket survive `hidden` on iOS 16.4-26, and does a Home Screen web
   app differ? What do Android Chrome, Samsung Internet and Firefox Android do to an open data channel on screen lock
   at 1, 5 and 15 minutes, with and without Wake Lock, Doze and battery saver? (device; R03 Q3, Q4; R04 Q1; R06 Q4;
   R02 Q1; w1-08 Q-01, Q-02)
5. Lockdown Mode on iOS 26 and macOS 27: is IndexedDB off, do SWs "register with cut powers", and does the per-site
   exclusion restore WebRTC, SW and WASM? (device; R03 Q7; R04 Q1; R06 Q5; R01 F28)
6. Memory on real phones (an iPhone SE class device, a 2 GB Android) to replace the desktop proxy. (device; w1-08 Q-11)
7. Does a non-extractable P-256 key (v0.2) round-trip IndexedDB on real iOS 16.4-18 and 26 in normal, private and
   Home Screen contexts, and what causes the iOS `DataCloneError`? (device; R06 Q1; w1-08 Q-05; DR §6;
   w2c-03-VERIFY claim 3)
8. What is the ITP window in shipping Safari 18, 26 and 27 (7 days of use, or WebKit trunk's 30 operating days; only
   while Prevent Cross-Site Tracking is on; per registrable domain), and what does `persist()` do in Home Screen apps
   and other iOS browsers? (device; R06 Q17; R04 Q10; w1-08 Q-03, Q-04; w2c-03-VERIFY claim 2)
9. The combined mobile peer budget: 4-8 content wires plus 3-5 rendezvous wires, and the battery cost of idle
   rendezvous connections. (device; w1-12 Q11; w1-08 F-13)
10. What does a 16-bit mint over a 394-528 B header cost (median, p95, thermal throttling) on a mid-range Android phone
    and an older iPhone? (device; R06 Q3; w2b-04-VERIFY claim 5)
11. A realistic first-paint budget on LTE, and how much faster a peer-assisted load is than web-seed-only for a small
    site with few visitors (w2a-07 F23's model predicts about 0 % peer bytes for a 5 MB site). (device; w1-07 Q2, Q4)
12. WAN behaviour of the head-of-line and `reqq` numbers (all loopback), and the `reqq` 64 outlier. (w1-12 Q1, Q2)
13. Does the pinner pair reliably with browsers on a real network, given the 5.0 s Node offer cost and glare? (w1-13)
14. Does iCloud Private Relay still leak the real IP through WebRTC STUN on current iOS? (device; R03 Q12)
15. Does Brave's Shields fingerprinting level change its WebRTC IP-handling policy (the wiki says yes, the code says
    no)? (device; R03 Q2)
16. Which iOS third-party browsers expose `navigator.serviceWorker` on iOS 26 and 27, and what do Samsung Internet
    Secret mode, Edge InPrivate and Brave private windows do? (device; R04 Q3, Q4)

### 6.3 Needs a browser, account or harness not available here

17. Firefox, all of it: `user-agent` in web-seed preflights, extended-message limits in practice, metadata-less
    wires, `persist()` on Android, the opaque-frame and `Range` experiments, test262 for the polyfill. (R01 F10, F24;
    w1-08 Q-08; w1-11 Q1; w1-12 Q3; DR §6)
18. Firefox and Safari SW timing: the limit for a pending `respondWith`, streams without pings, hard-reload behaviour
    for iframes, `cancel()` propagation, first-visit iframe control, `resultingClientId`. (local and device; R04 Q1,
    Q2; DR §6)
19. SW update-check timing on stable browsers: does every in-scope navigation check, or only a stale registration
    (4.1 row 18)? It decides how fast the kill switch reaches returning visitors.
20. Installed-PWA protocol launch: is the `#...` fragment kept (w1-09 Q1)? If not, only `?mw=%s` remains, which leaks
    the infohash to host logs.
21. R2 on a custom domain: identity 206 for browser `Range` requests and whether `AllowedHeaders: ["*"]` works
    (partly answered: R2's S3 API implements `Range`, the edge behaviour is documented, not exercised, w2a-07 Q1);
    Cloudflare Pages fallback status and `OPTIONS` (its `Range` answer is a documented 200, w2a-07 F8); CloudFront
    header policies on Function responses. The w1-10 question whether GitHub Pages compresses `.tar`/`.bin` is moot
    for browsers (4.1 row 32). (w1-10 Q1, Q4-Q6)
22. Is the apex SW bundle re-downloaded per PSL-listed subdomain (w1-07 Q3)? What are PSL propagation time and the
    acceptance of user-controlled children? (w1-10 Q9; w1-11 Q3)

### 6.4 Owner decisions

23. Mobile sharing default on confirmed Wi-Fi: ARCH (on, 256 KiB/s), w1-08 (off unless charging, opt-in 128 KiB/s) or
    w1-08's alternative (on at 32 KiB/s, 8 MiB per visit while visible); then the DR §4.3 and §4.5 phone wording (2.4).
24. Is a multi-publisher hub in v1 at all, given P0-13's launch conditions (PSL, denylist, takedown, counsel)?
25. Adopt BEP 47 padding for cross-version piece reuse? It requires web seeds to serve `.pad/*` and the path
    validator to accept them (5.3).
26. A single-file archive layout (`v=mw2`) for fewer requests and no per-file preflights (P2-9)?
27. Offer the opt-in magnet handler at all (P2-11; 4.1 row 36)?
28. Ship the Nostr plane (P2-3)? It depends on how often all public trackers are down at once (w1-12 Q6).
29. Shell-hash pinning through the pointer or DNS (w1-10 REC-18, F38)?
30. Torrent `name` per version (`immutable` web-seed caching) or constant (incremental uploads)? (4.1 row 39)
31. Which TURN tier, if any, once telemetry measures the relay share (P2-1; question 3)?
32. Is a no-SW fallback renderer worth more than "open in Safari" for Lockdown, Tor, in-app and old Firefox private
    windows? v0.2 already has a degraded mode; scope is the open part. (R04 Q9)

### 6.5 Legal, ops, economics (topic 14 never researched)

33. Consent sufficiency per jurisdiction: is a non-blocking notice with [OK] enough, must [Host only] be equally
    prominent, may DoH run before consent, and is the hub operator a controller, a joint controller or a host?
    (w1-11 Q7, Q8)
34. The legal basis for HTTP 451 takedowns by hub operators, and Safe Browsing's treatment of PSL-listed hub
    subdomains (w1-07 Q10); the second half is partly answered: Chromium and Firefox do not use private-section PSL
    entries in Safe Browsing lookups (w2b-06-VERIFY claim 7).
35. Host acceptable-use terms for visitor re-serving; the Cloudflare large-file clause for Free zones. (w1-10 F21,
    Q13)
36. Do Cloudflare's, Metered's and Twilio's acceptable-use terms allow BitTorrent-style relayed traffic? (R03 G-11)
37. What are the rate limits and embedding terms of dns.sb, Control D, DNS4EU, AliDNS and Cloudflare at popular-site
    scale, and how does Google's per-IP limit behave behind mobile CGNAT? (R05 Q5, Q12)
38. Who pays for always-on availability (web seed, pinner, trackers) over years? Paid persistence services kept
    closing (w1-07 F12); wave 1 modelled nothing beyond the w1-10 cost table (later: `w2a-07-hosting-cost-bandwidth.md`
    and `w2c-07-incentives-economics.md`).

### 6.6 Upstream and third parties

39. Will webtorrent keep per-torrent `getAnnounceOpts` and accept `maxMessageLength`, a request-queue cap and a
    hash-failure attribution hook? (w1-12 Q9; w1-11 R21)
40. Which software runs `tracker.openwebtorrent.com`, and will its seeder filtering change? (w1-12 Q4) Partly
    answered: w2b-01 correction 3 strengthens R02 F6's inference that it runs wt-tracker (its `/stats.json` `memory`
    object has the keys of Node's `process.memoryUsage()`); the `OpenWebTorrent/openwebtorrent-tracker` repository is an
    unmaintained C++ project (last push 2021-06-27), not what runs there. The seeder-filtering question stays open.
41. How long will the four public trackers survive, should operators get a courtesy note, and why is novage missing
    from ngosang's list? (R02 Q5, Q7)
42. Does Oracle reclaim a lightly loaded tracker VM, and is the Cloudflare Durable Objects Free tier enforced as
    documented? (R02 Q2, Q3)
43. Is Quad9's missing CORS on HTTP/3 intentional, and will it be fixed? (R05 Q2)
44. Does libtorrent 2.1's WebRTC interoperate with browser WebTorrent, which would give owners a native pinner?
    (w1-11 Q4)
45. Are SHA-1 chosen-prefix collisions practical against web assets laid out in 256 KiB pieces? (w1-11 Q6) Moot once
    `fj=` ships.


---

## Appendix: source coverage

Where each wave-1 file is cited in this digest (generated from the text on 2026-10-19). Decision ids, recommendation
ids, 4.1 row numbers and question numbers are listed where a file is cited inside them.

| Source file | Cited in |
|---|---|
| `01-webtorrent-browser.md` (R01) | 0; 1; 2.1 (D1, D3, D4, D5, D6, D8, D9, D10, D11, D13, D18, D19, D20, D22, D26, D35, D38); 2.2; 3 (P0-1, P0-2, P0-4, P0-5, P0-6, P0-7, P0-11, P0-16, P1-4, P1-14, P1-17, P1-23); 4.1 (rows 1, 2, 4, 5, 6, 7, 8, 10, 14, 27, 40); 4.3; 4.4; 5.1; 5.3; 5.4; 5.5; 6 (questions 1, 5, 17) |
| `02-wss-trackers.md` (R02) | 0; 1; 2.1 (D5, D27, D33, D38); 2.2; 2.4; 3 (P0-1, P0-10, P0-16, P1-9, P1-10, P1-17, P1-23, P2-2, P2-3, P3-3); 4.1 (rows 1, 2, 3, 10, 11, 12, 13); 4.3; 4.4; 5.3; 5.5; 6 (questions 1, 3, 4, 40, 41, 42) |
| `03-webrtc-nat-privacy.md` (R03) | 0; 1; 2.1 (D19, D21, D22, D24, D33, D38); 2.2; 3 (P0-2, P0-5, P0-10, P0-16, P1-9, P1-11, P1-23, P2-1, P3-4); 4.1 (rows 3, 4, 7, 8, 12, 14); 4.3; 4.4; 5.1; 5.2; 5.3; 5.4; 5.5; 6 (questions 3, 4, 5, 14, 15, 36) |
| `04-service-worker-serving.md` (R04) | 0; 1; 2.1 (D11, D12, D13, D15, D16, D18, D19, D21); 2.3; 3 (P0-2, P0-4, P0-13, P1-2, P1-14, P1-23, P3-1, P3-5); 4.1 (rows 4, 5, 6, 7, 9); 4.3; 4.4; 5.1; 5.2; 5.3; 5.5; 6 (questions 4, 5, 8, 16, 18, 32) |
| `05-doh-dns-txt.md` (R05) | 0; 1; 2.1 (D33, D34); 2.2; 3 (P0-8, P0-10, P1-12, P1-17, P1-23, P2-4, P2-5, P3-11); 4.1 (rows 15); 4.3; 4.4; 5.3; 5.4; 5.5; 6 (questions 37, 43) |
| `06-browser-chain-vs-crdt.md` (R06) | 0; 1; 2.1 (D15, D18, D21, D25, D26, D28, D29, D30, D32); 3 (P0-11, P0-13, P1-14, P1-17, P1-23, P2-3, P3-2, P3-11); 4.1 (rows 4, 7, 8, 9, 10, 11, 16, 22); 4.3; 5.1; 5.4; 5.5; 6 (questions 2, 4, 5, 7, 8, 10) |
| `w1-07-prior-art.md` | 0; 1; 2.1 (D5, D13, D15); 2.3; 3 (P0-2, P0-4, P0-10, P0-13, P1-17, P1-19, P1-22, P2-11, P2-12, P3-6); 4.1 (rows 9, 17, 35, 36, 37); 4.3; 4.4; 5.2; 5.3; 5.4; 5.5; 6 (questions 11, 22, 34, 38) |
| `w1-07-prior-art-VERIFY.md` | 0; 1; 2.1 (D5, D14, D15, D17); 2.3; 3 (P0-4, P0-13, P1-19, P1-24); 4.1 (rows 9, 17, 18); 4.2; 4.4; 5.3; 5.4 |
| `w1-08-mobile-constraints.md` | 0; 1; 2.1 (D9, D19, D20, D29, D38); 2.4; 3 (P0-2, P0-7, P0-10, P0-16, P1-7, P1-9, P1-13, P1-14, P1-19, P1-23, P1-24, P2-6, P2-7, P3-4); 4.1 (rows 6, 12, 13, 16, 23, 24, 25, 26, 27, 30, 34); 4.3; 4.4; 5.1; 5.3; 5.4; 6 (questions 4, 6, 7, 8, 9, 17, 23) |
| `w1-09-protocol-handler-magnet.md` | 0; 1; 2.1 (D36); 2.3; 3 (P0-10, P0-12, P0-15, P1-15, P1-16, P1-23, P2-11, P3-7); 4.1 (rows 19, 20, 21, 36); 4.2; 5.1; 5.3; 5.4; 6 (questions 20) |
| `w1-09-protocol-handler-magnet-VERIFY.md` | 0; 1; 2.1 (D36); 2.3; 3 (P0-12, P0-15, P1-15, P1-16, P1-24, P2-11); 4.1 (rows 19, 20, 21); 4.2; 4.4; 5.1; 5.4 |
| `w1-10-static-hosting-bootstrap.md` | 0; 1; 2.1 (D2, D4, D6, D7, D14, D16, D37); 2.2; 3 (P0-3, P0-9, P0-10, P0-13, P1-1, P1-2, P1-3, P1-4, P1-19, P1-21, P1-24, P2-8, P2-9, P3-8); 4.1 (rows 31, 32, 33, 39); 4.3; 5.1; 5.2; 5.5; 6 (questions 21, 22, 29, 35, 38) |
| `w1-11-security-threats.md` | 0; 1; 2.1 (D6, D13, D14, D17, D23, D31, D32, D33, D34, D35, D36); 3 (P0-3, P0-4, P0-5, P0-10, P0-12, P0-13, P0-14, P0-15, P1-5, P1-6, P1-7, P1-8, P1-14, P1-15, P1-20, P1-24, P2-10, P3-9); 4.1 (rows 7, 18, 28, 29, 38, 40); 4.3; 4.4; 5.1; 5.2; 5.3; 5.4; 5.5; 6 (questions 17, 22, 33, 39, 44, 45) |
| `w1-12-signaling-libs.md` | 0; 1; 2.1 (D8, D22, D23, D24, D26, D27); 2.2; 2.3; 2.4; 3 (P0-5, P0-6, P0-11, P1-9, P1-17, P1-18, P1-19, P1-24, P2-3, P3-10); 4.1 (rows 8, 10, 11, 12, 22, 28, 29, 30, 35); 4.3; 4.4; 5.1; 5.3; 5.4; 6 (questions 9, 12, 17, 28, 39, 40) |
| `w1-13-toolchain.md` (draft) | 0; 1; 2.1 (D2, D3, D4, D6, D19); 2.2; 3 (P0-2, P0-3, P0-5, P0-9, P1-1, P1-4, P1-19, P1-20, P1-21, P2-2); 4.1 (rows 31, 33, 34, 37); 4.4; 5.2; 5.3; 5.4; 6 (questions 13) |
