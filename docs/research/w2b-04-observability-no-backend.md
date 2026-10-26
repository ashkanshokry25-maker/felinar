# w2b-04 - Observability without a backend: diagnostics, canaries, opt-in telemetry

> **Status: complete (resumed run, 2026-10-17).** Written in appended chunks so an interruption could not lose work; every number below was re-checked against the saved probe output or the cited source.

- **Topic:** how a static, backend-less P2P website loader (magnet-web) can be diagnosed, monitored and measured in production: in-page diagnostics and debug bundle, synthetic canaries, external uptime checks, privacy-preserving aggregate metrics (including "through the chain"), an optional opt-in beacon, Web Vitals, error reporting without PII, health records, alerting. Two plans: zero servers, and one Worker.
- **Research date:** 2026-10-17. Every fetch, probe and experiment ran the same day. Sources are 2024-2026 unless flagged `(OLD)`.
- **Run note (resumed after an interruption):** the earlier attempt left nothing on disk (no partial file, empty scratchpad), so this run started clean. Part-way through, the shared WebSearch budget ran out ("limit: 200 WebSearch calls per turn, shared by every agent"); after that only **direct primary-source fetches** were possible. Items that would have needed a search are listed under Open questions. I did not work around the limit.
- **Companion files:** probe and experiment scripts are in `docs/research/labs/w2b-04-probes/` (re-runnable, Node >= 22, Playwright from the repo's `node_modules`). Related documents: `02-wss-trackers.md` (tracker facts), `03-webrtc-nat-privacy.md` (R-13 asks for exactly the opt-in connectivity telemetry designed here), `05-doh-dns-txt.md` (DoH harness and "check my record" page), `review/requirements-fidelity.md` m5 (live diagnosis within 5 s), `review/security.md` M6 (trackers are already a third-party beacon). Sibling wave-2 drafts that overlap: `w2b-01-tracker-resilience.md` (tracker monitoring detail), `w2a-06-cicd-automation.md` (publishing workflows). This document defines the cross-cutting observability design and defers tracker-specific monitoring detail to w2b-01.
- **Confidence scale:** **high** = read in a primary source and/or reproduced here; **medium** = one good source, or a vendor page extracted by a summarising fetch (all prices and plan limits are medium: they change); **low** = inference or secondary. Anything not verified is marked **unverified**. `[DESIGN-CRITICAL]` = would change the architecture or a compatibility promise if wrong.

---

## Summary

1. **Observability has to be split by vantage point, because the browser deliberately hides the reasons.** The WHATWG WebSockets Standard says user agents "must not convey any failure information to scripts" that would let a script tell DNS failure, refused connection, TLS failure and non-WebSocket server apart (F6). So the in-page panel can say "tracker unreachable" but never why; the why comes only from external probes. I reproduced those probes today: all four live public trackers pass a WebSocket **announce** probe (connect 228-669 ms over two runs; interval 120/120/120/180 s), `tracker.openwebtorrent.com` **fails a scrape probe** while announcing fine (so scrape is not a liveness test), 3/3 public STUN servers answer a hand-written UDP Binding Request in 109-133 ms, and the two unusable trackers still in `src/loader/config.js` (one with dead DNS, one origin-allowlisted) fail to open (F27).

2. **Instrument at the platform boundary, not inside libraries, and mind the ordering `[DESIGN-CRITICAL]`.** A proof of concept in Chromium 156 wrapped `WebSocket` and `RTCPeerConnection` and captured tracker announce/response payloads (`complete`, `incomplete`, `interval`), offers sent, and ICE state transitions for a real webtorrent 3.0.21 transfer. The wrappers only work if installed **before** `import('/webtorrent.min.js')` executes, because the bundle captures the globals at module-init (`Me = window.RTCPeerConnection || ...`, `const _WebSocket = ... WebSocket`): installed after, the same transfer succeeded but the wrappers saw **0 sockets and 0 peer connections** (F4). In that 2-peer run 11 `RTCPeerConnection`s were created and only 2 connected, because the tracker client eagerly creates unanswered offers: PC count is not peer count.

3. **Exportable debug bundle: do what Element Web does, locally.** Element monkey-patches `console`, keeps a ring buffer in IndexedDB (flush 30 s; 5 MB, or 100 MB if under 24 h of logs), falls back to memory when IndexedDB is unavailable, can build a `rageshake.tar` download with no network, and disables bug-report upload entirely unless the deployer sets `bug_report_endpoint_url` (value `"local"` = download only) (F15, F16). Measured here: `getStats()` over 30 live peer connections takes a median 0.5-0.6 ms and serialises to 117 KB in full but about 10 KB when projected to selected pair + transport + data channel, so a bundle stays under 64 KiB.

4. **ICE/STUN diagnostics need a rule, not raw events (measured).** `icecandidateerror` is now Baseline (Firefox 150, April 2026; Chrome 77; Safari 14.1). In Chromium 156 a blackholed STUN server produced code 701 "STUN binding request timed out" only after **39.9 s** and held `gathering-complete` back that long, although the server-reflexive candidate from a good server arrived at **26 ms**; a hostname-lookup 701 appeared next to a successful srflx from the same server. Tracker-created peers use `trickle: false`, so each offer waits for gathering or simple-peer's 5 s `iceTimeout`. Rule: "STUN OK" = at least one `srflx` candidate; "STUN broken" = no `srflx` and at least one 701 (F7).

5. **Canaries: GitHub Actions cron is enough for v1 if you respect its semantics.** Minimum interval 5 min, runs only on the default branch, can be delayed or dropped under load ("High load times include the start of every hour"), is **auto-disabled after 60 days without repository activity in public repos**, and notifies only "the user who last modified the cron syntax". Billing rounds each job up to a whole minute; public repos are free; private repos get 2,000 (Free) or 3,000 (Pro/Team) minutes, so a Node-only probe job fits at a 30-minute cadence (1,440 min/month) but not at 15 minutes (2,880) (F20, F21). Pair every scheduled job with a **dead-man's-switch** (Healthchecks.io: free 20 checks, <= 5 pings/min/check, first 100 kB of a POST body stored) so a silently disabled schedule pages you (F24).

6. **Do not put visitor telemetry on the chain `[DESIGN-CRITICAL]`.** Chain writers are cheap to mint (14-bit Hashcash is about 16k hashes; the per-author rate limit is evaded by a fresh key per report), every node would store every report forever (cap 50,000 blocks on load), and local-DP estimators are poisonable by fake users (Cao, Jia, Gong, USENIX Security 2021). What the chain *can* carry safely is an **owner-signed `_health` aggregate** written by the pin node and read only when `author == owner` (F32, F44).

7. **If you want local differential privacy anyway, the arithmetic is unforgiving (computed here, validated by Monte Carlo).** Binary randomized response at epsilon = ln 3 needs about 1,400 reports for +/-5 percentage points (95%) on a 20% rate, about 8,700 for +/-2 pp; with 100 reports the interval is +/-18.7 pp. For an 8-way failure-reason histogram the same epsilon gives +/-31.9 pp at n = 100 and +/-10.1 pp at n = 1,000 (F30). For a collector the user already trusts (the site owner), bucketing + no identifiers + k-thresholding beats LDP on accuracy and is what PeerTube and Element ship (F17, F16).

8. **Optional beacon: present it the way Element does, and never let a pointer choose the endpoint `[DESIGN-CRITICAL]`.** Element's analytics are "deemed impossible and the user won't be asked to opt in" when the deployer config lacks the analytics section; Do Not Track is honoured; the consent dialog names the analytics owner. Copy that: endpoint set at **build/deploy time** by the publisher, absent = no code path (verify with a build assertion), default off, "what will be sent" preview, honour GPC/DNT. Do not add a `tel=` field to the pointer grammar: a signed pointer is publisher-controlled content, and in hub mode it would turn every pointer into a tracking-pixel vector (F40).

9. **One Worker is affordable, but its quota is shared.** Workers Free = 100,000 requests/day (shared with Pages Functions; static assets stay free and unlimited), 10 ms CPU, 50 subrequests, 5 Cron Triggers per account; Analytics Engine = 250 data points/invocation, 3-month retention, not billed yet (page updated 2026-04-23); Workers Logs = 200k events/day with 3-day retention on Free, and Cloudflare Observability pricing applies from **2026-12-01** (F37). A same-origin `/_t` route keeps `connect-src 'self'` and survives ad-blockers better than a cross-origin beacon.

10. **Web Vitals are blind to the site inside the iframe `[DESIGN-CRITICAL for the RUM design]`.** The `web-vitals` library (npm 6.2.3, 2026-10-05, about 3 kB brotli) states its APIs "have no visibility into `<iframe>` content (not even same-origin iframes)"; Chrome's field data (CrUX) *does* fold iframe content into the top-level page. So in-page RUM of the loader shell measures the wrong thing; measure the milestones that matter with User Timing marks (time-to-site-visible, offload ratio), and run `web-vitals` inside the site frame only if the SDK relays results to the host (F13).

11. **Health records: a signed `status.json` on GitHub Pages or the web seed, not DNS.** GitHub Pages answers with `access-control-allow-origin: *` and `cache-control: max-age=600` (verified live on 2026-10-17), so any loader origin can fetch it. A `_magnet-health` TXT record needs DNS-API credentials in CI, is cached per TTL by every resolver, costs every visitor an extra DoH query, and is public; rate limits are *not* the obstacle (Cloudflare 1,200 requests/5 min/user) (F41-F43).

12. **EU law applies to client-side telemetry even when the data is generated locally.** EDPB Guidelines 2/2023 v2.0 (adopted 2024-10-07) para 53: code that sends locally produced information back to a server constitutes "gaining of access to information already stored" under Art. 5(3) ePrivacy; para 55 covers IP addresses. Opt-in consent is therefore the safe default; this is not legal advice (F36).

13. **Two plans.** *Zero servers:* local panel + bundle, `tools/verify.mjs`, GitHub Actions probe (30 min) and Playwright E2E (60 min), Healthchecks.io dead-man's-switch and alerts, signed `status.json` on GitHub Pages, pin-node heartbeat, tracker swarm-size time series via announce/scrape. About $0/month on a public repo. *One Worker:* the same plus a same-origin `/_t` collector (closed schema, delta counters, Analytics Engine, public k >= 20 summary) and an edge cron probe; about $0/month below roughly 20,000 beacons/day, $5/month Workers Paid above that or for longer retention.

14. **Builds on, does not duplicate, earlier research.** The ordering gotcha, the `received - downloaded` waste metric, the signed-status schema, the build-time elimination of telemetry code and the migration-diagnostics ("unresolved requests") panel are new to this wave; the live-tracker facts reconfirm `02-wss-trackers.md` F1 three days later.

---

## Method and evidence log

| # | What was done | Result (2026-10-17) | Where |
|---|---|---|---|
| E1 | Read the shipped code and docs: `ARCHITECTURE.md`, `INTERFACES.md`, `src/loader/{ui,torrent,config,policy}.js`, prior research 02/03/05, reviews | Existing: 300-line debug log ring, `status` events, `Export chain`; no structured diagnostics, bundle, canary or telemetry | repo |
| E2 | Read installed dependency source: webtorrent 3.0.21, bittorrent-tracker 11.2.3, `@thaunknown/simple-peer` lite, `@thaunknown/simple-websocket`, bittorrent-protocol 5.0.9, torrent-discovery | Event names, stats fields, `trickle:false`, `ICECOMPLETE_TIMEOUT = 5000`, module-init global capture, tracker `update` payload, WS `scrape` support, `/stats.json` | `node_modules/` |
| E3 | STUN Binding probe via `node:dgram` | 3/3 OK (109-133 ms) | `labs/w2b-04-probes/stun-probe.mjs` |
| E4 | WS tracker announce + scrape probe, Node global WebSocket | 4/4 announce OK; openwebtorrent scrape fails; btorrent.xyz fails (plus files.fm: not probe-able without an Origin header) | `labs/w2b-04-probes/ws-tracker-probe.mjs` |
| E5 | Chromium 156 ICE/STUN gathering: IP-literal vs hostname vs blackhole `192.0.2.1`; plus a same-page loopback pair per engine | srflx at 17-29 ms; blackhole 701 at 39.9 s; hostname 701 next to a working srflx; loopback connected in 24 ms with 701s arriving after gathering-complete | `labs/w2b-04-probes/rtc-ice-gather.mjs`, `rtc-loopback-stats.mjs` |
| E6 | Chromium 156 `getStats()` cost and size, 10 and 30 loopback PCs | median 0.2-0.3 / 0.5-0.6 ms; 39 / 117 KB full; 3.4 / 10.4 KB projected | `labs/w2b-04-probes/rtc-stats-cost.mjs` |
| E7 | Boundary-wrapper PoC with real webtorrent 3.0.21 + local `bittorrent-tracker` server, wrappers installed before vs after the import | before: 1 WS, 11 PCs, tracker payloads captured; after: 0 WS, 0 PCs | `labs/w2b-04-probes/boundary-wrappers-poc/` |
| E8 | Local-DP accuracy tables (closed-form) and Monte Carlo check of the formulas | Binary RR formula 3.02 pp vs simulated 3.00-3.04 pp; GRR formula needs `+ f(1-f)/n` for the finite-population term | `labs/w2b-04-probes/ldp.py` |
| E9 | MDN browser-compat-data 8.1.6 (npm tarball) queried for 40+ APIs | Support matrix used throughout | scratch (reproducible via npm) |
| E10 | `curl -I` on GitHub Pages and raw.githubusercontent.com | `access-control-allow-origin: *`; `cache-control: max-age=600` / `300` | live |
| E11 | Direct fetches of primary sources (docs, specs, vendor pages, repos) | See "Sources read" | end of file |
| E12 | Playwright WebKit 27.2 / Firefox (Nightly build 1555) | WebKit: same-page loopback WebRTC did not connect in 15 s (cause not isolated); Firefox failed to start on this macOS 27 host ("Could not find profile folder"); neither investigated | `labs/w2b-04-probes/rtc-loopback-stats.mjs` |

## Findings

Format per finding: claim, **Confidence**, **Sources**, **Source date**. File and line references are to the installed versions (webtorrent 3.0.21, bittorrent-tracker 11.2.3, bittorrent-protocol 5.0.9, `@thaunknown/simple-peer` lite, `@thaunknown/simple-websocket`, torrent-discovery) under `node_modules/`.

### A. What the shipped stack already lets us observe

#### F1. The public stats surface of webtorrent 3.0.21 is enough for a first panel; one derived metric is missing from the docs
Torrent events documented upstream: `infoHash`, `metadata`, `ready`, `done`, `download`, `upload`, `wire`, `noPeers` ("Emitted every couple of seconds when no peers have been found"), `warning`, `error`, `verified`. In code there are more: `trackerAnnounce` (no payload; `lib/torrent.js:437-439`), `invalidPeer`, `blockedPeer`, `hotswap`, `idle`, and a `warning` "Piece N failed verification" (`lib/torrent.js:2011`). Torrent properties: `numPeers`, `received` ("including invalid data"), `downloaded` (verified), `uploaded`, `downloadSpeed`, `uploadSpeed`, `progress`, `ratio`, `timeRemaining`. Wire fields (bittorrent-protocol `index.js:92-134, 135-136`): `type` (`'webrtc'|'tcpIncoming'|'tcpOutgoing'|'webSeed'`), `peerChoking`, `amChoking`, `peerInterested`, `amInterested`, `requests`, `peerRequests`, `uploaded`, `downloaded`, `uploadSpeed()`, `downloadSpeed()`, `peerExtendedHandshake`. **Derived, not documented:** `received - downloaded` = bytes wasted on pieces that failed verification, a per-torrent "bad peer" indicator; `peerBytes / (peerBytes + webseedBytes)` = offload ratio (the loader already tracks both in `torrent.js:_onWire`).
**Confidence:** high. **Sources:** local `node_modules` as cited; https://github.com/webtorrent/webtorrent/blob/master/docs/api.md (read 2026-10-17). **Source date:** installed 2026-07-27 (webtorrent 3.0.21 publish date from npm); docs read live.

#### F2. Tracker responses never reach the torrent API; they live one layer down, and the hook point appears late
`torrent-discovery` re-emits only `trackerAnnounce` (no payload) and forwards `warning`/`error`/`peer` (`torrent-discovery/index.js:176-180`). The real payload is the bittorrent-tracker client's `update` event: `Object.assign({}, data, { announce: <url>, infoHash })` including `complete`, `incomplete`, `interval` (`lib/client/websocket-tracker.js:245-269`); `failure reason` becomes a `warning` (`:250`); scrape replies become `scrape` events (`:326`). The tracker client exists only after `torrent.discovery` is created in `_startDiscovery()` (`lib/torrent.js:380-421`), which runs after `_onListening()`, so a hook attached after `client.add()` returns can miss the first announce. Reconnect backoff is `min(2^retries x 10 s, 1 h) + U(0, 5 min)` (`websocket-tracker.js:16-18, 345`), and offers expire after 50 s (`:19`).
**Confidence:** high. **Sources:** local source as cited. **Source date:** 2026-05-25 (bittorrent-tracker 11.2.3).

#### F3. simple-peer (lite) gives two ICE hooks and explicitly ignores the one we want
Events: `iceStateChange(iceConnectionState, iceGatheringState)` (`lite.js:573`) and `iceTimeout` (`:464-476`); method `getStats(cb)` (`:587`). Peers created by the tracker client use `trickle: false` (`websocket-tracker.js:404-410`), so an offer is not emitted until gathering completes or `ICECOMPLETE_TIMEOUT = 5 * 1000` ms elapses (`lite.js:11`). The source says "Other spec events, unused by this implementation: onconnectionstatechange, onicecandidateerror, ..." (`lite.js:154-159`). Consequence: STUN/TURN error detail (F7) cannot come from the library; it needs the platform event.
**Confidence:** high. **Sources:** local source. **Source date:** installed 2026-10-14.

#### F4. `[DESIGN-CRITICAL]` The bundle captures `RTCPeerConnection` and `WebSocket` at module-init, so any wrapper must be installed first
`dist/webtorrent.min.js` evaluates `Ne = "undefined" != typeof window ? window : self, Me = Ne.RTCPeerConnection || Ne.mozRTCPeerConnection || Ne.webkitRTCPeerConnection` at the top level; `@thaunknown/simple-websocket/index.js:12` does `const _WebSocket = typeof ws !== 'function' ? WebSocket : ws`. `simple-peer` lite ignores `opts.wrtc` (it constructs the module-level `RTCPeerConnection`, `lite.js:121`). **Reproduced:** with real webtorrent 3.0.21 and a local tracker (E7), subclass wrappers installed before the dynamic import recorded 1 WebSocket (open in 3-4 ms; `in: announce 6, offer 1, answer 1`; `out: announce 5, offersSent 10`; tracker payloads `complete/incomplete/interval`) and 11 `RTCPeerConnection`s; wrappers installed after the import recorded **0 and 0** while the transfer still completed (`done: true`, 1 `webrtc` wire). Failure is silent. Also observed: of the 11 PCs only 2 reached `checking > connected`; the other 9 are unanswered tracker offers (5 per announce per client), so "PC count" and "failed ICE" must exclude PCs that never received a remote description.
**Confidence:** high (source + reproduced twice in Chromium 156.0.8078.4). **Sources:** local source; `labs/w2b-04-probes/boundary-wrappers-poc/` (`run.mjs both`). **Source date:** 2026-10-17 (run).

#### F5. What the repo already has, and one live defect a canary would have caught
Existing: a 300-line debug ring (`ui.js:156-157, 302-307`, `getLog()` at `:352`; `config.js ui.maxDebugLines = 300`), `status` CustomEvents (`torrent.js:216`), handlers for `noPeers`/`trackerAnnounce`/`warning` that only write status text (`torrent.js:250-252`), `window` `error`/`unhandledrejection` listeners that only call `S.log` (`app.js:839-842`), a "Show debug log" toggle and "Export chain (JSON)". Missing: structured state, ICE/tracker/SW/storage views, a diagnosis line, a debug-bundle export, any probe or canary. Defect: the placeholder `CONFIG.trackers` still lists `wss://tracker.btorrent.xyz` (DNS A = 127.0.0.1 per `02-wss-trackers.md` F1) and `wss://tracker.files.fm:7073/announce` (HTTP 403 unless `Origin: https://files.fm`); today's probe (E4) shows btorrent.xyz failing to open, and the files.fm entry fails with a plain `ws-error` from Node (no Origin). A two-line tracker canary (R7) catches this class of drift.
**Confidence:** high. **Sources:** repo files as cited; `docs/research/02-wss-trackers.md` F1; E4. **Source date:** 2026-10-14 (repo), 2026-10-17 (probe).

### B. What the browser lets a page see (and what it hides)

#### F6. `[DESIGN-CRITICAL]` WebSocket failure reasons are hidden from scripts by specification
WHATWG WebSockets Standard: for the listed failure cases "the WebSocket connection close code would be 1006", and "User agents must not convey any failure information to scripts" that would let a script distinguish unresolvable hosts, refused connections, TLS failures and non-WebSocket servers, because "Allowing a script to distinguish these cases would allow a script to probe the user's local network." MDN's `error` event is "A generic `Event`" and `CloseEvent.code` 1006 means "closed abnormally (that is, with no close frame being sent)". The same masking applies to `fetch()` network errors (an opaque `TypeError`); that second point is from general knowledge of the Fetch model, not re-read here. **Consequence for design:** the in-page diagnosis can classify "tracker never opened / closed with 1006", and can show *which* tracker and *when*, but cannot say DNS vs TLS vs 403 vs CORS. Only an external probe (Node, CI, pin node) can, which is why canaries are not optional.
**Confidence:** high (spec text read). **Sources:** https://websockets.spec.whatwg.org/ ; https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/error_event ; https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code (all read 2026-10-17). **Source date:** living standards, read 2026-10-17.

#### F7. ICE/STUN: `icecandidateerror` is now Baseline, but it is noisy; the decisive signal is the presence of a `srflx` candidate (measured)
Support (MDN BCD 8.1.6): Chrome 77, Edge 79, **Firefox 150**, Safari 14.1, iOS 14.5, Samsung Internet 12; MDN labels it "Baseline 2026 Newly available. Since April 2026". Error code 701 means the candidate could not reach the STUN/TURN server. **Measured in Chromium 156.0.8078.4** (E5, run twice): (A) a good STUN by IP literal gave a `srflx` candidate at **26-29 ms**, while a blackholed server (`192.0.2.1`) raised 701 "STUN binding request timed out." only at **39,885-39,892 ms** and `gathering-complete` was delayed until then; (B) STUN by hostname raised 701 "STUN host lookup received error." at 105-107 ms **and still produced a `srflx` at 110-114 ms** (cause not isolated; plausibly one address family failing to resolve on this host's dnscrypt-proxy setup, so environment-specific); (C) the same server by IP literal: no error. In a first experiment the same-page loopback pair connected in 24 ms over `host` candidates even though 701s fired, and the 701s arrived *after* `gathering-complete` (107 ms vs 23 ms), so listeners must stay attached past gathering. **Rule for the panel:** STUN is OK if >= 1 `srflx` is seen; STUN is broken if 0 `srflx` and >= 1 code 701; gathering that exceeds 5 s means at least one dead server in `iceServers` (with `trickle:false` peers each offer then waits the 5 s `iceTimeout`, F3). `RTCIceCandidatePairStats`/selected pair types tell relay vs direct once connected (F8). `RTCPeerConnectionIceErrorEvent.address` is a *local* interface address: do not log it.
**Confidence:** high for the measurements (reproducible, scripts saved); medium for generalising to other resolvers/OSes. **Sources:** https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/icecandidateerror_event (read 2026-10-17); MDN BCD 8.1.6 (npm); `labs/w2b-04-probes/rtc-ice-gather.mjs`. **Source date:** 2026-10-17.

#### F8. `getStats()` is universal and cheap, but it leaks addresses; budget and redact
`RTCPeerConnection.getStats` is supported everywhere (Chrome 24, Firefox 27, Safari 11). W3C WebRTC Statistics (Candidate Recommendation Draft, 25 Sep 2025): "By default, the user agent MUST leave the address member as `null`" for remote candidates, but may expose it later; `RTCIceCandidatePairStats` carries `state`, `nominated`, `bytesSent/Received`, `currentRoundTripTime`, `availableOutgoingBitrate`, `requestsSent/responsesReceived`, `consentRequestsSent`; `RTCTransportStats` carries `iceState`, `dtlsState`, `selectedCandidatePairId`, `selectedCandidatePairChanges`. **Measured (Chromium 156, loopback, E6):** on a connected pair, candidate stats *did* expose `address` on both local and remote candidates (2 address fields per report), so redaction is mandatory in any export. Cost: `Promise.all(getStats())` over 10 PCs median 0.2-0.3 ms, over 30 PCs median 0.5-0.6 ms (p90 1.4-1.5 ms, max 1.6-4 ms) in two runs; JSON size 39 KB (10 PCs) and 117 KB (30 PCs) in full (about 3.9 KB per PC, 93 distinct stat fields) versus 3.4 KB and 10.4 KB when projected to transport + data channel + nominated pair. On a throttled phone these numbers will be worse (unverified); poll only while the panel is open, at >= 5 s intervals, and keep only the projection in the bundle.
**Confidence:** high (spec + measurement), medium for mobile. **Sources:** https://www.w3.org/TR/webrtc-stats/ (read 2026-10-17); MDN BCD 8.1.6; `labs/w2b-04-probes/rtc-stats-cost.mjs`. **Source date:** spec 2025-09-25; measurement 2026-10-17.

#### F9. Lifecycle and beacon facts that constrain when a report can be sent
Chrome's `unload` deprecation is **complete** ("This deprecation is now complete in Chrome"; 100% of page loads from Chrome 155, 2026-10-06, after 1% at Chrome 146 on 2026-03-10); alternatives: `visibilitychange` ("Consider the hidden state the last reliable time to save app and user data") and `pagehide`; `unload` may still fire on iOS. MDN: `sendBeacon()` queues at most **64 KiB (65,536 bytes)** total, returns `true` only for "queued", is Baseline since April 2018, and the recommended trigger is `visibilitychange` (avoid `pagehide`/`unload`). Per the W3C Beacon spec (Candidate Recommendation Draft, 2022-08-03), a non-CORS-safelisted `Content-Type` forces a CORS preflight ("Otherwise, a CORS preflight is made"), so send `text/plain` or a safelisted type to avoid it. `fetch(..., { keepalive: true })` is the alternative when a response is needed (Firefox 133+, Chrome 66, Safari 13). `ReportingObserver`, `PerformanceObserver.supportedEntryTypes` and `CompressionStream` (Chrome 80, Firefox 113, Safari 16.4) are available for the bundle path.
**Confidence:** high. **Sources:** https://developer.chrome.com/docs/web-platform/deprecating-unload ; https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon ; https://www.w3.org/TR/beacon/ ; MDN BCD 8.1.6 (all read 2026-10-17). **Source date:** 2026-10 (Chrome), 2022-08-03 (Beacon CRD, OLD but current text).

#### F10. Storage state must be part of every diagnosis because Safari evicts
`StorageManager.estimate()` Chrome 61, Firefox 57, **Safari 17**; `persist()/persisted()` Chrome 55, Firefox 57, **Safari 15.2**. WebKit (2023-08-10, Safari 17): origin quota up to 60% of disk for browser apps (15% for other apps), best-effort by default, LRU eviction, `persist()` "granted ... based on heuristics like whether the website is opened as a Home Screen Web App". WebKit (2020-03-24, OLD): ITP deletes script-writable storage (IndexedDB, LocalStorage, Service Worker registrations and caches) "after seven days of Safari use without user interaction on the site"; Home Screen web apps "have their own counter of days of use". The 2023 storage-policy post gives no duration for idle-site eviction, so the 7-day figure is the documented bound for Safari tabs (also quoted in `04-service-worker-serving.md` F21) until re-verified on current Safari. Element's bug report records `storageManager_persisted`, `_quota`, `_usage` and every `usageDetails` key when present. So a diagnostic ring persisted to IndexedDB is best-effort on iOS Safari tabs and the bundle must say `persisted: false` plainly (already consistent with `review/browser-mobile.md` M1).
**Confidence:** high. **Sources:** https://webkit.org/blog/14403/updates-to-storage-policy/ ; https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ; Element `submit-rageshake.ts` (below); MDN BCD 8.1.6. **Source date:** 2023-08-10; 2020-03-24 (OLD).

#### F11. Several useful classification inputs are Chromium-only; plan for "unknown"
Network Information API (`navigator.connection`, `effectiveType`, `saveData`): Chrome 61 / Samsung Internet; **removed from Firefox** (desktop 32, Android 99); **never in Safari**. `navigator.deviceMemory`: Chromium only, coarse (from Chrome 147 reports 2, 4, 8, 16, 32 on desktop; 1, 2, 4, 8 on Android). `navigator.userAgentData`: Chromium only (experimental). `navigator.globalPrivacyControl`: Firefox 120 / Android 122 only in BCD (Chrome, Safari: no; GPC-native browsers such as Brave/DuckDuckGo are not tracked in BCD, unverified). `navigator.doNotTrack` is deprecated but still present. `src/loader/policy.js` already reads `navigator.connection`; every metric derived from it must carry an explicit `unknown` bucket. Engine class should come from feature detection, not UA parsing.
**Confidence:** high. **Sources:** MDN BCD 8.1.6 (queried 2026-10-17). **Source date:** BCD 8.1.6.

#### F12. Error plumbing: the shell's meta CSP cannot report, but the DOM event can
CSP3: for a policy delivered in a `<meta>` element "Neither are the `report-uri`, `frame-ancestors`, and `sandbox` directives" supported, and "The Content-Security-Policy-Report-Only header is not supported inside a meta element" (the text does not mention `report-to`; treat it as unsupported, unverified). MDN: the meta option "does not support all CSP features" and recommends the Reporting API (`Reporting-Endpoints` header + `report-to`) for violation reports. Header-based reporting needs response headers: GitHub Pages cannot set them; S3+CloudFront (response headers policy) and Cloudflare Pages (`_headers`) can (the last two stated from general knowledge, not re-verified). Support: `Reporting-Endpoints` Chrome 96, Firefox 130, Safari 16.4; CSP `report-to` Chrome 70, Firefox 149, Safari 16.4; NEL Chromium only. Since `ARCHITECTURE.md` section 13 specifies a **meta** CSP, use the DOM `securitypolicyviolation` event (Chrome 76, Firefox 93, Safari 15.4) to feed violations into the local diagnostics instead.
**Confidence:** high for the spec statements and support numbers; medium for host capabilities. **Sources:** https://www.w3.org/TR/CSP3/ ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP ; MDN BCD 8.1.6. **Source date:** CSP3 living draft read 2026-10-17.

#### F13. `[DESIGN-CRITICAL for the RUM design]` Web Vitals libraries cannot see the site inside the iframe
`web-vitals` is at **6.2.3 (npm, 2026-10-05)**; v6.0.0 (2026-07-21) added Soft Navigation support; the README (my first fetch of the GitHub page still showed `web-vitals@5` CDN examples) says "tiny (~3K, brotli'd)" and "The primary limitation of these APIs is they have no visibility into `<iframe>` content (not even same-origin iframes)"; same-origin frames need the library in every frame and `postMessage` to the parent. Browser support per README: `onCLS` Chromium only; `onINP`, `onLCP`, `onFCP`, `onTTFB` Chromium, Firefox, Safari (BCD: `PerformanceEventTiming` and `LargestContentfulPaint` reach Safari at **26.2**, Firefox 89/122). The attribution build adds about 1.5K brotli. Field data differs: Chrome UX Report says "Pages included as iframes are not reported on separately in CrUX, but do contribute to the metrics of the top-level page", and web.dev says "The API does not consider elements within iframes but the metric does". Consequences: (1) in-page `web-vitals` on the loader shell would report the shell's own paints, not the site; (2) CrUX/Search Console will score shell + iframe together, including the P2P load time on first visit; (3) the useful RUM signal is custom User Timing: `mw:pointer`, `mw:first-wire`, `mw:metadata`, `mw:done`, `mw:site-visible` and offload ratio; (4) the SDK can offer opt-in `mw.vitals` that runs `web-vitals` inside the site frame and relays to the host over the existing MessageChannel (cost about 3 kB brotli, only for sites that opt in).
**Confidence:** high. **Sources:** https://raw.githubusercontent.com/GoogleChrome/web-vitals/main/README.md and `/CHANGELOG.md`; npm registry `web-vitals` (6.2.3, published 2026-10-05T10:03:40Z); https://developer.chrome.com/docs/crux/methodology ; https://web.dev/articles/lcp (all read 2026-10-17). **Source date:** 2026-07 to 2026-10.

#### F14. A Service Worker can annotate every response with `Server-Timing`
`Server-Timing` / `PerformanceResourceTiming.serverTiming` are Baseline (Chrome 65, Firefox 61, Safari 16.4). The SW already synthesises headers (`ARCHITECTURE.md` section 7); adding `Server-Timing: idb;dur=<ms>, src;desc="idb"` costs nothing and shows up in DevTools and in the site's own RUM. Small, but it makes "how much time did the loader add to this asset" answerable by the site owner without our telemetry.
**Confidence:** high for support; the design use is an inference. **Sources:** MDN BCD 8.1.6. **Source date:** 2026-10-17.

### C. Precedents for in-page diagnostics, exportable bundles and gated telemetry

#### F15. Element Web's "rageshake": the reference design for a local, exportable, ring-buffered debug log
`apps/web/src/rageshake/rageshake.ts` (element-web `develop`): it monkey-patches the global `console` ("preferable to having a log library because we can catch logs by other libraries more easily"), persists lines to **IndexedDB** (database `logs`), flushes every `FLUSH_RATE_MS = 30 * 1000`, keeps `MAX_LOG_SIZE = 5 MB` of recent data (or `MAX_LOG_SIZE_24H = 100 MB` when there are less than 24 hours of logs), tags lines with a per-tab/session id that is a timestamp, purges old lines on startup, and **falls back to in-memory** because "IndexedDB does not work in incognito mode ... the logs will still be stored in-memory, so can still be submitted". `submit-rageshake.ts` builds the report: app version, `user_agent`, `navigator.storage.persisted()`, `estimate()` quota/usage and each `usageDetails` key when present, missing-feature list, and the logs gzipped with `pako`; `downloadBugReport()` assembles the same content into a tarball and downloads `rageshake.tar` locally ("causes the browser to download the files locally"). Mapping to magnet-web: keep the existing 300-line ring, add structured state (F1-F8), persist only the last session summary on `visibilitychange: hidden` (F9), fall back to memory, export gzip JSON locally.
**Confidence:** high (source read). **Sources:** https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/src/rageshake/rageshake.ts ; https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/src/rageshake/submit-rageshake.ts (read 2026-10-17). **Source date:** copyright 2024; `develop` read 2026-10-17.

#### F16. Element also shows how to present optional upload/analytics honestly when the project runs no backend
`docs/config.md`: `bug_report_endpoint_url` - "When not present in the config, the app will disable all rageshake functionality. Set to `https://rageshakes.element.io/api/submit` to submit rageshakes to us, or use your own rageshake server. You may also set the value to `"local"` if you wish to only store logs locally, in order to download them for debugging." Sentry is optional (`sentry.dsn`). Analytics: PostHog needs `api_host` and `project_api_key`; "When these configuration options are not present, analytics are deemed impossible and the user won't be asked to opt in to the system"; `analytics_owner` is "the company name used in dialogs talking about analytics ... useful when the provider of analytics is different from the provider of the Element instance"; `privacy_policy_url` links the policy. `PosthogAnalytics.ts`: "If Posthog isn't configured in `config.json`, events are not sent. If Do Not Track is enabled, events are not sent (... `respect_dnt`) ... If both flags are false or not set, events are not sent"; `autocapture: false`, `capture_pageview: false`; the current URL is sent only after `getRedactedCurrentLocation()` replaces unknown screen names with `<redacted_screen_name>` (allowlist, not blocklist). This is the closest existing answer to "optional telemetry in a static app whose authors run no server": the *deployer* supplies the endpoint, absence removes the feature (and the consent prompt), "local" is a first-class mode, the consent dialog names who receives the data.
**Confidence:** high. **Sources:** https://raw.githubusercontent.com/element-hq/element-web/develop/docs/config.md ; https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/src/PosthogAnalytics.ts (read 2026-10-17). **Source date:** `develop` 2026-10-17.

#### F17. PeerTube ships P2P-specific QoE metrics with a closed schema, delta counters, and the switch on the server side
OpenAPI `POST /api/v1/metrics/playback` ("These metrics are exposed by OpenTelemetry metrics exporter if enabled") takes `PlaybackMetricCreate`: `playerMode` (`p2p-media-loader` | `web-video`), `resolution`, `fps`, `p2pEnabled`, `p2pPeers` ("P2P peers connected (doesn't include WebSeed peers)"), `resolutionChanges`, `bufferStalled`, `errors`, `downloadedBytesP2P`, `downloadedBytesHTTP`, `uploadedBytesP2P` (each "since the last metric creation"), `videoId`. No user id, no IP in the schema. Server default config: `open_telemetry.metrics.enabled: false`, `playback_stats_interval: '15 seconds'` ("How often viewers send playback stats to server"), Prometheus exporter bound to `127.0.0.1:9091`. PeerTube 3.2 added a "stats for nerds" player context-menu category; PeerTube 8.0 (release 9 Dec 2025, "Video player redesign", Lucide theme) moved P2P information behind that menu (secondary sources; the 8.0.0 release notes I read confirm the redesign but do not mention stats). This is the direct precedent for magnet-web's connectivity report: bytes by source, peers, errors, per-interval deltas, no identifiers, off unless the operator enables it.
**Confidence:** high for schema/config (primary); medium for the 3.2/8.0 UI statements. **Sources:** https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/support/doc/api/openapi.yaml ; https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/config/default.yaml ; https://github.com/Chocobozzz/PeerTube/releases/tag/v8.0.0 (read 2026-10-17); search-result snippets (alternativeto.net 2025-12, next.ink 3.2). **Source date:** `develop` 2026-10-17; 8.0.0 on 9 Dec 2025.

#### F18. IPFS shows the "static checker page" pattern: the visitor's own browser is the probe
`ipfs.github.io/public-gateway-checker` is a static site on GitHub Pages; `src/Cors.ts` calls `fetch(gateway + '/ipfs/' + HASH_TO_TEST + '?now=...#x-ipfs-companion-no-redirect')` from the visitor's browser and passes only if the body equals the expected string (`HASH_STRING === text.trim()`), also detecting cross-domain redirects; `Checker.ts` staggers checks by 100 ms per gateway. No backend. Its value is exactly the vantage point: it tests reachability *and CORS* from the viewer's network. The IPFS Service Worker Gateway README states "verifying hashes in the user's browser", offers `?ipfs-sw-unregister=true` as a debugging hook, and I found no telemetry statement on that page.
**Confidence:** high (source read). **Sources:** https://raw.githubusercontent.com/ipfs/public-gateway-checker/main/src/Cors.ts and `src/Checker.ts` ; https://github.com/ipfs/public-gateway-checker ; https://github.com/ipfs/service-worker-gateway (read 2026-10-17). **Source date:** `main` 2026-10-17.

#### F19. Mozilla Glean gives the discipline: closed metric registry, mandatory review, expiry, bounded spool, debug tag
"Any new data collection requires documentation and data-review." Each metric declares `description`, `notification_emails`, `bugs`, `data_reviews`, `expires`; "set the `expires` parameter to disable the metric at the earliest possible time"; expired metrics "automatically stop collecting data" and need another review to continue. Pings: pending pings are stored on disk; if storage exceeds **10 MB or 250 pending pings** the oldest are deleted; "Only up to 15 ping submissions every 60 seconds are allowed" (40 for the JavaScript SDK); a request may be up to 1 MB after compression; a debug tag sends `X-Debug-Id` so the ping appears in a Debug View; deletion-request pings are exempt from quotas. Adopt: a `telemetry.schema.json` registry with `expires`, a unit test that rejects unregistered fields, a "preview what would be sent" view; skip the on-disk spool (drop on failure).
**Confidence:** high. **Sources:** https://mozilla.github.io/glean/book/user/metrics/adding-new-metrics.html ; https://mozilla.github.io/glean/book/user/pings/index.html (read 2026-10-17). **Source date:** current docs, read 2026-10-17.

### D. Synthetic canaries and external monitoring

#### F20. `[DESIGN-CRITICAL for relying on cron]` GitHub Actions `schedule` semantics
"The shortest interval you can run scheduled workflows is once every 5 minutes." "Scheduled workflows run on the latest commit on the default branch." "The `schedule` event can be delayed during periods of high loads ... High load times include the start of every hour. To decrease the chance of delay, schedule your workflow to run at a different time of the hour." "If the load is sufficiently high enough, some queued jobs may be dropped." "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." "Notifications for scheduled workflows are sent to the user who last modified the cron syntax in the workflow file." Runs in UTC by default. Consequences: use odd minutes (for example `7,37 * * * *`); never treat a missing run as proof of health (hence the dead-man's-switch, F24); expect gaps; a monitor repo that nobody edits will go silent after 60 days unless something counts as activity (whether the Action's own commits count: **unverified**; the community "keepalive" workaround: not verified here); the failure e-mail goes to one person (the last cron editor), so route alerts elsewhere.
**Confidence:** high (quoted from the docs). **Sources:** https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows (read 2026-10-17, twice). **Source date:** current docs.

#### F21. Billing: public repos free, private repos small, every job rounds up to a whole minute
Standard GitHub-hosted runners are free for public repositories. Private-repo included minutes: GitHub Free 2,000; Pro 3,000; Team 3,000; Enterprise Cloud 50,000. Linux 2-core x64 list price $0.006/minute (arm64 $0.005). "GitHub rounds the minutes and partial minutes each job uses up to the nearest whole minute." The Dec 2025 plan to charge $0.002/min for *self-hosted* runners from 2026-03-01 was postponed (secondary sources: socket.dev, tenki.cloud; GitHub's billing page I read lists self-hosted as free), and hosted prices fell by up to 39% on 2026-01-01 (also secondary). Computed budget (30-day month; assumes a Node-only probe job bills 1 minute, a Playwright E2E job 3 minutes because the browser must be installed each run, since Playwright advises against caching binaries):

| Job | Cadence | Runs/day | Billed min / month | vs 2,000 free (private) |
|---|---|---|---|---|
| Node probe (1 min) | 5 min | 288 | 8,640 | 432% |
| Node probe | 10 min | 144 | 4,320 | 216% |
| Node probe | 15 min | 96 | 2,880 | 144% |
| Node probe | **30 min** | 48 | **1,440** | 72% |
| Node probe | 60 min | 24 | 720 | 36% |
| Playwright E2E (3 min) | 60 min | 24 | 2,160 | 108% |
| Playwright E2E | 120 min | 12 | 1,080 | 54% |
| Probe 15 min + E2E 60 min | combined | | 5,040 | 252% (about $18/month overage at list price) |
| Probe 30 min + E2E 120 min | combined | | 2,520 | fits Pro/Team (3,000) |

Conclusion: keep the monitor repo **public** (nothing in it is secret; Actions secrets stay secret) and the cost is zero at any cadence the 5-minute floor allows; if it must be private, 30-minute probes + 2-hour E2E fit a Pro/Team allowance.
**Confidence:** high for quoted GitHub figures; medium for the postponement (secondary sources); the 1-min/3-min job durations are estimates. **Sources:** https://docs.github.com/en/billing/concepts/product-billing/github-actions ; https://docs.github.com/en/billing/reference/actions-minute-multipliers ; https://socket.dev/blog/github-actions-pricing-whiplash and https://tenki.cloud/blog/github-actions-runner-pricing-2026 (search snippets only). **Source date:** docs read 2026-10-17.

#### F22. Playwright in CI: what it implies for cost and flakiness
Playwright docs: "Caching browser binaries is not recommended" (restore takes about as long as the download; Linux OS dependencies cannot be cached); the GitHub Actions example runs `npx playwright install --with-deps` on `ubuntu-latest`; "We recommend setting workers to 1 in CI"; headless is the default. The repo pins `playwright ^1.64.1` (npm latest 1.64.1, 2026-10-14), while AWS CloudWatch Synthetics' newest Playwright runtime bundles **1.63.0** and Chromium 153 (F26): scripts should not use APIs newer than the AWS runtime if both hosts are wanted. The project's own E2E needs `--disable-features=WebRtcHideLocalIpsWithMdns` for same-machine WebRTC (ARCHITECTURE section 1), and the same flag is needed for the canary's two-context chain test.
**Confidence:** high. **Sources:** https://playwright.dev/docs/ci (read 2026-10-17); npm registry. **Source date:** 2026-10.

#### F23. Upptime proves the zero-server monitor-and-status-page pattern; "git scraping" is the free time-series store
Upptime: "Every 5 minutes, a workflow visits your website to make sure it's up"; response times are committed to git (trend graphs from history); outages become GitHub Issues (opened, assigned, commented, closed on recovery); the status page is on GitHub Pages (Svelte/Sapper) reading the repo through the GitHub API; "completely free if you're already using GitHub since there's no external server or subscription needed"; data lives in the repo ("gone if you delete the repo"). It is alive: the repo's commit list shows commits dated 2026-10-17 and a dependency bump to `@upptime v1.46.0` dated 2026-10-14. Simon Willison's "git scraping" (2020-10-09, OLD) is the underlying idea: a scheduled job fetches data and commits only when it changed, so history is a free diff database. Adapt, do not adopt wholesale: Upptime checks HTTP endpoints; magnet-web needs tracker/STUN/DoH/web-seed/pointer probes, but its issue-per-incident and status-page-on-Pages mechanics are directly reusable.
**Confidence:** high. **Sources:** https://github.com/upptime/upptime and `/commits/master` ; https://simonwillison.net/2020/Oct/9/git-scraping/ (read 2026-10-17). **Source date:** 2026-10-17; 2020-10-09 (OLD).

#### F24. Healthchecks.io is the right dead-man's-switch: precise API, generous free tier
Ping URLs: `https://hc-ping.com/<uuid>` (success), `/start`, `/fail`, `/log`, `/<exit-status 0-255>` (0 = success), or slug form `https://hc-ping.com/<ping-key>/<slug>` (`?create=1` auto-creates, returns 201); `rid=<uuid>` links start and finish to compute duration. Methods HEAD, GET, POST; for POST "the first 100 kB for each received ping" of a UTF-8 body is stored. "Please do not ping a single check more than 5 times per minute" (UUID endpoints answer `200 OK (rate limited)`, slug endpoints `429`). Plans (2026-10-17): Hobbyist free = 20 jobs, 100 log entries per job; Business $20/month ($192/year) = 100 jobs, 1,000 log entries, 50 SMS/WhatsApp and 20 phone-call credits; free Business plan for open-source projects and nonprofits on request. Notifications named on the pages I read: e-mail, Slack, Pushover, PagerDuty/Splunk On-Call/Opsgenie/PagerTree, SMS/WhatsApp/phone (paid quotas); the full integration list page returned 404, so Telegram/ntfy/Discord/Matrix support is **unverified**. Use: a 30-minute probe sends `/start` then success/`/fail` with the JSON summary as body; the check's period 30 min + grace 15 min pages if GitHub stops running the schedule.
**Confidence:** high for API; medium for plan details. **Sources:** https://healthchecks.io/docs/http_api/ ; https://healthchecks.io/pricing/ ; https://healthchecks.io/docs/configuring_notifications/ (read 2026-10-17). **Source date:** 2026-10-17.

#### F25. Hosted active monitors exist; none is required, none should be the only check (vendor pages, volatile)
As read on 2026-10-17: **Better Stack** free = "10 monitors & heartbeats", 1 status page, Slack and e-mail only, "Free for personal projects"; paid check frequency "up to 30 seconds"; **UptimeRobot** Free = 50 monitors at a 5-minute interval, 1 basic status page, "Good for hobby and non-profit projects", Solo $9/month for 60-second checks; **Checkly** Hobby = 1,000 browser/Playwright check runs and 10,000 API check runs per month (hard caps), uptime monitors every 2 minutes at best, e-mail/Slack/webhook alerts, Starter $24/month (3,000 browser runs). They add independent vantage points and a status page; none runs WebRTC/STUN/tracker protocol checks, so they supplement the Node/Playwright canaries (HTTP checks of the static host, `status.json` freshness, TLS expiry), they do not replace them. Tracker-specific monitoring detail: see sibling `w2b-01-tracker-resilience.md`.
**Confidence:** medium (extracted by a summarising fetch; prices move). **Sources:** https://betterstack.com/pricing ; https://uptimerobot.com/pricing/ ; https://www.checklyhq.com/pricing/ (read 2026-10-17). **Source date:** 2026-10-17.

#### F26. AWS-hosted sites can run the canary inside AWS with CloudWatch Synthetics (Playwright runtime), at small cost
Runtime `syn-nodejs-playwright-9.0` = Lambda Node.js 22.x, Playwright **1.63.0**, Chromium **153.0.8010.36**, Firefox 155.0; multi-location canaries since 7.0 ("Run the same canary across multiple AWS Regions from a single point of management"); namespace `@aws/synthetics-playwright` from 5.1. Pricing example (US East): **$0.0012 per canary run**, plus Lambda ($0.2 per 1M requests + $0.000016667/GB-s), CloudWatch Logs ($0.5/GB collected), S3, alarms ($0.10 each) and metrics; the free-tier table lists "100 canary runs per month". Computed run fees only: every 5 min = 8,640 runs = $10.37/month; 15 min $3.46; 30 min $1.73; 60 min $0.86. Unverified: whether Chromium-in-Lambda can complete ICE/STUN (Lambda UDP egress); treat it as a static-host + DoH + web-seed + render canary, not a WebRTC canary, until proven.
**Confidence:** high for runtime facts and price example; low for WebRTC-in-Lambda (untested). **Sources:** https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Library_nodejs_playwright.html ; https://aws.amazon.com/cloudwatch/pricing/ (read 2026-10-17). **Source date:** 2026-10.

#### F27. Live probes today reproduce the tracker facts of 2026-10-14 and add two protocol lessons
Announce probe (E4; WS connect + announce with random infohash, `numwant: 0`, `offers: []`, then `stopped`): `tracker.webtorrent.dev` ok (connect 653-669 ms, reply 775-778 ms, `interval` 120); `tracker.openwebtorrent.com` ok (347-383 / 466-503 ms, 120); `open.ftorrent.com` ok (228-331 / 268-371 ms, 120); `tracker.novage.com.ua` ok (380-467 / 470-552 ms, **180**); reply keys `action,complete,incomplete,info_hash,interval`. **Scrape** probe: ok on webtorrent.dev, ftorrent, novage; **fails on `tracker.openwebtorrent.com`** (socket error after open), exactly as `02-wss-trackers.md` F1 recorded. `tracker.btorrent.xyz` and `tracker.files.fm:7073` fail to open (the latter needs an Origin header Node cannot set). STUN Binding probe (E3): `stun.cloudflare.com:3478` 112-133 ms, `stun.l.google.com:19302` 109-113 ms, `global.stun.twilio.com:3478` 122-126 ms, all `0x0101` success with `XOR-MAPPED-ADDRESS` (IPv4). Lessons: (1) **announce, not scrape, is the liveness probe**; (2) an announce probe on a *real* infohash registers the prober as a leecher until `stopped` is processed, so `incomplete` must be read as "minus the prober" and scrape preferred where it works; (3) the prober needs no Origin trick except for origin-allowlisted trackers, which should not be in the default list anyway.
**Confidence:** high (reproduced twice). **Sources:** `labs/w2b-04-probes/ws-tracker-probe.mjs`, `stun-probe.mjs`; `docs/research/02-wss-trackers.md` F1. **Source date:** 2026-10-17 (re-run from the saved scripts).

#### F28. Swarm size is observable without any client change, from three places
(a) WS `scrape` returns `files[<binary infohash>] = { complete, incomplete, downloaded }` plus `flags.min_request_interval` (bittorrent-tracker `server.js _onScrape`; `downloaded` is "only a lower-bound", equal to `complete`). (b) The `bittorrent-tracker` HTTP server serves `/stats` and `/stats.json` by default (`stats !== false`) with `torrents`, `activeTorrents`, `peersAll`, `peersSeederOnly`, `peersLeecherOnly`, `peersSeederAndLeecher`, `peersIPv4`, `peersIPv6`, `clients`; `tracker.openwebtorrent.com` and `tracker.novage.com.ua` publish `/stats.json`, `open.ftorrent.com` a `/page.json` (per `02-wss-trackers.md` F11). (c) Any announce reply carries `complete/incomplete`. The most important single availability signal for a P2P site is **"number of seeders >= 1 on >= 2 trackers"** (is anyone, for example the pin node, actually serving the content?). Caveat: bittorrent-tracker never prunes swarms (`Server.torrents` entries are never deleted; issue #164 open since 2016, per `02-wss-trackers.md` F13), so `incomplete` can be stale on self-hosted instances.
**Confidence:** high (source) / medium (public stats endpoints, from earlier research). **Sources:** local `bittorrent-tracker/server.js:142-265, 696-745`; `docs/research/02-wss-trackers.md`. **Source date:** 2026-05-25 (11.2.3); 2026-10-14.

#### F29. The canary's vantage point is a cloud datacenter, which is not the visitor
GitHub's docs: "GitHub hosts Linux and Windows runners on virtual machines in Microsoft Azure"; "Each standard runner is a new VM"; inbound ICMP is blocked. The page I read does not state whether runner addresses are static or where the ranges are published (I could not confirm via the API: unauthenticated `api.github.com` calls from this host were rate-limited), and it says nothing about UDP egress, so the STUN probe on GitHub runners is **unverified** (it works from a residential Mac, E3). A canary therefore proves "the system works from a datacenter with a clean NAT"; it cannot see CGNAT, carrier-grade symmetric NAT, iOS background suspension or corporate UDP blocking, which `03-webrtc-nat-privacy.md` R-13 identifies as the unknowns. That gap is the *only* legitimate reason for opt-in field telemetry (Plan W) and for the visitor-run `health.html` (R11).
**Confidence:** high for the quotes; the conclusion is inference. **Sources:** https://docs.github.com/en/actions/concepts/runners/github-hosted-runners (read 2026-10-17); `docs/research/03-webrtc-nat-privacy.md` R-13. **Source date:** 2026-10-17.

### E. Aggregate metrics, local differential privacy, and why not on the chain

#### F30. Local differential privacy needs far more reports than most sites will have (computed here; formulas validated by Monte Carlo)
Binary randomized response (Warner 1965) with truth probability `p = e^eps/(1+e^eps)`: estimator `(lambda_hat - (1-p)) / (2p-1)`, variance `lambda(1-lambda) / (n (2p-1)^2)`. Generalized RR over `k` categories: `p = e^eps/(e^eps+k-1)`, `q = 1/(e^eps+k-1)`; noise variance `q(1-q)/(n(p-q)^2) + f(1-p-q)/(n(p-q))`, plus `f(1-f)/n` for a freshly sampled population (the Monte Carlo showed the noise-only formula under-reports by exactly that term). 95% confidence half-width, percentage points:

| Estimand | eps | n = 100 | n = 1,000 | n = 10,000 | n = 100,000 |
|---|---|---|---|---|---|
| Binary, true rate 20% | ln 3 = 1.10 (p = 0.75) | 18.70 | 5.91 | 1.87 | 0.59 |
| Binary, true rate 20% | 2.0 (p = 0.881) | 11.45 | 3.62 | 1.14 | 0.36 |
| Binary, true rate 20% | 4.0 (p = 0.982) | 8.29 | 2.62 | 0.83 | 0.26 |
| Binary, true rate 5% (rare failure) | ln 3 | 17.50 | 5.54 | 1.75 | 0.55 |
| Binary, true rate 5% | 4.0 | 5.05 | 1.60 | 0.51 | 0.16 |
| 8-way histogram, one category at 10% | ln 3 (p = 0.300) | 31.85 | 10.07 | 3.18 | 1.01 |
| 8-way histogram, one category at 10% | 2.0 | 14.02 | 4.43 | 1.40 | 0.44 |
| 8-way histogram, one category at 10% | 4.0 | 6.85 | 2.17 | 0.69 | 0.22 |
| 8-way, no privacy noise (sampling only) | n/a | 5.88 | 1.86 | 0.59 | 0.19 |

Reports needed for +/-5 pp on a 20% rate: 1,398 (eps = ln 3), 524 (eps = 2), 275 (eps = 4), versus 246 with no noise; for +/-2 pp: 8,740 / 3,275 / 1,719. Monte Carlo (1,500 trials, n = 1,000): simulated SD 3.04 pp vs formula 3.02 pp (eps = ln 3), 1.83 vs 1.85 (eps = 2). Meaning: a site with 100 opted-in sessions a week learns nothing at eps = ln 3 (+/-18.7 pp), and one with 1,000 resolves only coarse differences. A guarantee also assumes reports are unlinkable; if the same user can be recognised, repeated fresh randomisation can be averaged out (the reason RAPPOR uses memoised "permanent" randomisation; general knowledge, not re-verified in the abstract I read).
**Confidence:** high (closed forms + simulation). **Sources:** `labs/w2b-04-probes/ldp.py` (`python3 -I ldp.py --simulate`). **Source date:** 2026-10-17.

#### F31. Local-DP aggregates are poisonable by fake users
Cao, Jia and Gong (USENIX Security 2021; arXiv 1911.02046, v2 2020-12-09): "an attacker can inject fake users into an LDP protocol" so that it "estimates high frequencies for arbitrary attacker-chosen items or identifies them as heavy hitters" (frequency estimation and heavy-hitter identification). Any open collector (a Worker, or the chain) is exposed to this; the defence is not more noise but bounding each source's influence and treating the metric as a hint (R14).
**Confidence:** high for the stated result. **Sources:** https://arxiv.org/abs/1911.02046 (read 2026-10-17). **Source date:** 2020-12-09 / USENIX 2021 (OLD but the standard reference).

#### F32. `[DESIGN-CRITICAL]` Visitor telemetry on the site chain fails on cost, capacity, privacy and abuse
From `ARCHITECTURE.md` section 6: Hashcash default **14 bits** (about 16k SHA-256 evaluations); rate limit is per **author key** by local receipt time (`n: 30` per `perMs: 600000`); startup loads all blocks with a **50,000** cap; each block carries its author's public key and an ECDSA signature; tombstones only by the owner or the block's author; every node stores and re-gossips everything. Using `06-browser-chain-vs-crdt.md` F10 (a 5-worker M3 browser is about 1/1,650 of one RTX 4090 at about 2.2x10^10 SHA-256/s, so about 1.3x10^7 H/s), minting one valid 14-bit block costs about 16,384 / 1.3x10^7 = **1.2 ms** on a desktop (about 36 ms on a phone at the extrapolated 0.46 MH/s from the same table): Hashcash does not limit a flood, and a fresh throw-away key per report defeats the per-author limit. A report block is roughly 0.5-0.7 KB (author 87 chars, signature 86, hash 64, `prev` 64-512, op, site id, nonce, JSON overhead; my estimate), so 50,000 telemetry blocks would be about 25-35 MB of IndexedDB on every visitor's device and would crowd out the guestbook-style data the chain exists for. Reports would be public to every visitor forever, timing and gossip path link a report to the peer that relayed it, and F31 applies. `06-browser-chain-vs-crdt.md` already lists "unique-visitor counts" among the things this kind of log does **not** fit (summary item 3). **Conclusion:** do not carry visitor telemetry on the site chain. The safe chain use is an **owner-authored aggregate** (F44).
**Confidence:** high for the cited design constants; medium for the byte estimate (not measured); the conclusion is design inference. **Sources:** `docs/ARCHITECTURE.md` sections 6.1-6.6; `docs/research/06-browser-chain-vs-crdt.md` F10; F31. **Source date:** 2026-10-14 (design), 2026-10-17 (analysis).

#### F33. The canonical LDP deployments are old but instructive on defaults
Apple, "Learning with Privacy at Scale" (2017-12-06, OLD): local differential privacy, "the server never sees or receives raw data"; per-event epsilon = 4 for both the emoji and the Safari-domain use cases; "we set a limit on the number of privatized records that can be transmitted daily for each use case" (number not published); "designed to be opt-in and transparent ... No data is recorded or transmitted before the user explicitly chooses". RAPPOR (Erlingsson, Pihur, Korolova; CCS 2014, arXiv 1407.6981, OLD): randomized response applied "in a novel manner" for client statistics. Take-aways for magnet-web: opt-in before anything is recorded, a daily cap per use case, and single-digit epsilon only with large populations.
**Confidence:** high. **Sources:** https://machinelearning.apple.com/research/learning-with-privacy-at-scale ; https://arxiv.org/abs/1407.6981 (read 2026-10-17). **Source date:** 2017-12-06; 2014-08-25 (both OLD).

#### F34. `[DESIGN-CRITICAL: do not architect around it]` Prio/DAP aggregation is not a finished standard and needs two aggregators
`draft-ietf-ppm-dap` is at **revision 19 (2026-07-06)**, "Active Internet-Draft", WG state "WG Consensus: Waiting for Write-Up", IESG state "I-D Exists", "Intended RFC status: (None)"; open item "Revised I-D Needed - Issue raised by WGLC"; not an RFC on 2026-10-17. Divvi Up (ISRG) operates DAP aggregators; in the Firefox deployment (blog 2023-10-12, OLD) metrics are split between a Divvi Up aggregator and one run by Mozilla, i.e. a subscriber must run or find a second non-colluding aggregator. Cloudflare's Rust DAP implementation `daphne` implements draft-09 and the repository was **archived (read-only) on 2026-06-03**. So "one Worker as a DAP aggregator" has no maintained implementation. Revisit when (a) an RFC exists, (b) a maintained Worker-friendly aggregator exists, (c) volume justifies it.
**Confidence:** high. **Sources:** https://datatracker.ietf.org/doc/draft-ietf-ppm-dap/ ; https://divviup.org/blog/divvi-up-in-firefox/ ; https://github.com/cloudflare/daphne (read 2026-10-17); search snippet for the June 2026 WG minutes (second WGLC). **Source date:** 2026-07-06; 2023-10-12 (OLD); 2026-06-03.

#### F35. ID-less counting has two precedents; the second needs no identifier at all
Plausible: the unique-visitor identifier is `hash(daily_salt + website_domain + ip_address + user_agent)`, "The salt is rotated and deleted every 24 hours", "Raw IP addresses and User-Agent data are never stored", "We do not generate persistent identifiers" (a server-side promise that clients cannot verify). PeerTube (F17) counts nothing per viewer: the player sends *delta counters since its last report* and the server adds them. For magnet-web the second model is preferable (no uniques needed; sessions, bytes by source and failure codes are sums).
**Confidence:** high. **Sources:** https://plausible.io/data-policy (read 2026-10-17); F17. **Source date:** current policy page.

#### F36. EU ePrivacy Art. 5(3) covers client-side code that sends locally produced data to a server
EDPB Guidelines 2/2023 on the technical scope of Art. 5(3) ePrivacy, **Version 2.0, adopted 7 October 2024** (EDPB page: final version 16 October 2024). Para 53: if "the processed information is made available to a third-party, for example sent back over the network to a server, such an operation (instructed by the entity producing the client-side code distributed on the user terminal equipment) would constitute a 'gaining of access to information already stored'. The fact that this information is being produced locally does not preclude the application of Article 5(3) ePD." Para 55: IP addresses fall in scope when they originate from the user's terminal equipment (a static outbound IPv4 from a router, IPv6) unless the entity can ensure otherwise. Para 40/56: the guidelines do not analyse the exemptions; each case must be assessed for consent or an exemption. Consequence: opt-in consent before any beacon is the defensible default; "strictly necessary" arguments for field telemetry are weak. **Not legal advice**; the abuse/legal wave owns this question.
**Confidence:** high for the quoted text; legal conclusion out of scope. **Sources:** https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en ; the PDF `edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf` (text extracted and read 2026-10-17). **Source date:** 2024-10-07 / 2024-10-16.

### F. The optional Worker, the CDN alternative, and where the endpoint may come from

#### F37. Cloudflare free-tier limits that shape a "one Worker" plan (verified 2026-10-17)
Workers **Free**: 100,000 requests/day (Error 1027 when exceeded; resets 00:00 UTC; "fail open" bypasses the Worker, "fail closed" shows the error), **10 ms CPU per invocation**, 50 subrequests, 100 Workers, **5 Cron Triggers per account** (Paid 250), 6 simultaneous outgoing connections per request, scheduled handlers max wall time 15 minutes. **Paid**: $5/month minimum, 10M requests and 30M CPU-ms included, then $0.30 per extra million requests and $0.02 per extra million CPU-ms. Pages Functions "are billed as Cloudflare Workers requests" and share the 100,000/day Free quota, but "requests to static assets are free and unlimited". **Workers Analytics Engine**: max **250** data points per invocation, 20 blobs + 20 doubles per point, index <= 96 bytes, blobs <= 16 KB total, retention three months; "Currently, you will not be billed" (page updated 2026-04-23); listed future prices Paid 10M points/month included then $0.25 per million, 1M read queries then $1.00 per million; Free 100,000 points/day and 10,000 read queries/day. **Workers Logs**: Free 200,000 events/day with 3-day retention, Paid 20M/month with 7-day retention; "Starting December 1, 2026, Workers Logs will use Cloudflare Observability pricing instead". Capacity: at 1 beacon per session, 10,000 visits/day uses 10% of the Free quota; 50,000 uses 50%; 3 beacons/visit at 50,000 visits exceeds it (150%). Sample so that beacons stay <= 20,000/day: `p = min(1, 20000 / dailyVisits)`.
**Confidence:** high (docs read), medium for forward-looking billing. **Sources:** https://developers.cloudflare.com/workers/platform/limits/ ; https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/analytics/analytics-engine/limits/ and `/pricing/` ; https://developers.cloudflare.com/pages/functions/pricing/ ; https://developers.cloudflare.com/workers/configuration/cron-triggers/ (read 2026-10-17). **Source date:** 2026-04-23 (Analytics Engine pricing page) to 2026-10-17.

#### F38. Cloudflare Web Analytics is a third-party script; it conflicts with the shell's CSP and its "no third-party scripts" promise
Cloudflare Web Analytics: a JavaScript snippet (a "beacon") "collects metrics using the Performance API"; "free, privacy-first analytics"; "does not collect or use your visitors' personal data"; works "without changing your DNS or using Cloudflare's proxy"; for proxied sites automatic injection is "enabled by default" (with an "excluding visitor data in the EU" mode); for Pages projects it is added "on the next deployment". `ARCHITECTURE.md` section 13 specifies `script-src 'self'`, SRI-pinned bundles and "no analytics, no third-party scripts". An auto-injected Cloudflare tag would be blocked by that CSP or, if the CSP were loosened, would break the promise. Verdict: keep Web Analytics off for the loader origin; use the first-party beacon (Plan W) or nothing.
**Confidence:** high for the docs; the conflict is a direct reading of the project's own spec. **Sources:** https://developers.cloudflare.com/web-analytics/about/ and `/get-started/` (read 2026-10-17); `docs/ARCHITECTURE.md` section 13. **Source date:** 2026-10-17.

#### F39. A CDN access log can be the collector: "no code of ours" (design inference over verified facts)
CloudFront standard logging (v2) delivers to CloudWatch Logs, Data Firehose or S3 with **selectable fields**; available fields include `cs-uri-query`, `x-edge-result-type`, `c-country`, `time-taken`, `cs(User-Agent)`, `c-ip`; "CloudFront doesn't charge for enabling standard logs" (destination charges apply); setting changes "take effect within 12 hours". So `GET /_t?<closed-schema query>` against the existing distribution (answered `204` by a CloudFront Function or simply `403/404`) lands in the operator's own logs, and the operator can **omit `c-ip` and `cs(User-Agent)`** from the selected fields, which a Worker cannot offer. Same trick without any beacon: **boot-failure rate** = 1 - (requests for `/loader.js` / requests for `/index.html`) in the same logs, because `boot.js` only imports `loader.js` after feature detection passes (biased by caching, bots and prefetch; heuristic, **unverified** in practice). GitHub Pages offers no logs, so this path is for S3/CloudFront (and similar) deployments. EDPB para 53 (F36) covers any client-side code that sends such data to a server, and para 47-51 treat URL and pixel tracking as in scope of Art. 5(3), so this path still needs opt-in.
**Confidence:** high for the CloudFront facts; medium/low for the heuristic. **Sources:** https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html (read 2026-10-17). **Source date:** current docs (examples dated 2024-11).

#### F40. `[DESIGN-CRITICAL: compatibility promise]` A telemetry endpoint must never come from a pointer record
`ARCHITECTURE.md` section 4 says unknown pointer keys are ignored, section 3 defines hub mode (many unrelated sites on one loader origin) and `review/security.md` M6 already notes that default trackers are "functionally a third-party analytics beacon on every page view". A `tel=<url>` field in a signed pointer would let any publisher make every visitor's loader send reports to an endpoint the *loader operator* never chose (in hub mode) and would add a second IP-exposing third party that the visitor cannot see in advance. Element's design is the counter-example: the endpoint comes from the deployer's `config.json` (F16). Rule: telemetry URL only in the loader build/config (`config.js`, replaced at deploy time), never in the pointer, `<meta>`, URL fragment or SDK message. Corollary: "per-site" telemetry for a per-domain deployment is just the deployer's own build.
**Confidence:** high that it is the safer design (spec + review evidence); it is an inference, not a measured fact. **Sources:** `docs/ARCHITECTURE.md` sections 3-4; `docs/review/security.md` M6; F16. **Source date:** 2026-10-14 / 2026-10-17.

### G. Health records and status files

#### F41. A signed `status.json` can be served from GitHub Pages or the web seed with no extra infrastructure
Verified live on 2026-10-17: `https://ipfs.github.io/public-gateway-checker/` answers `HTTP/2 200` with `access-control-allow-origin: *` and `cache-control: max-age=600`; `raw.githubusercontent.com` answers `access-control-allow-origin: *`, `cache-control: max-age=300`, `x-content-type-options: nosniff`. So a loader on any origin can `fetch()` a status file from the monitor repo's Pages site; the web seed already needs CORS (ARCHITECTURE section 1) so `/.well-known/magnet-web/status.json` there is also fetchable. Signing with a **canary key** (a dedicated ECDSA P-256 key held as a CI secret, public half published in the repo and optionally in the pointer) gives integrity and freshness (`generated`, `seq`) but not trust: anyone who controls the repo or CI can forge it, so the loader must treat status as an **advisory hint** (banner, probe ordering) and never as a gate, and must treat a stale file as "unknown", not "down". Do not sign it with the owner key (that key is the root of trust for the pointer and moderation).
**Confidence:** high for the headers; the trust analysis is inference. **Sources:** `curl -I` on both hosts (2026-10-17); `docs/ARCHITECTURE.md` section 1. **Source date:** 2026-10-17.

#### F42. There is a de-facto JSON shape for health documents, but it is an expired draft
`draft-inadarei-api-health-check-06` ("Health Check Response Format for HTTP APIs", latest revision 2021-10-16, expired individual draft, no IETF standing): media type `application/health+json`; required `status` = `pass`/`warn`/`fail` (aliases ok/up, error/down; HTTP 2xx-3xx for pass/warn, 4xx-5xx for fail); optional `version`, `releaseId`, `notes`, `output` (omit on pass), `checks`, `links`, `serviceId`, `description`; SHOULD carry a freshness lifetime such as `Cache-Control: max-age=3600`. Use the shape (it is widely recognised) but call it a convention, not a standard.
**Confidence:** high. **Sources:** https://datatracker.ietf.org/doc/draft-inadarei-api-health-check/ and `/doc/html/draft-inadarei-api-health-check-06` (read 2026-10-17). **Source date:** 2021-10-16 (OLD).

#### F43. A `_magnet-health` DNS TXT record is feasible but a poor fit
Rate limits are not the obstacle: Cloudflare API "1,200 requests per five minute period per user"; Route 53 throttles per account and rejects overlapping changes with `PriorRequestNotComplete`. The real costs: (1) a DNS-edit credential must live in CI (a blast radius far larger than the Healthchecks ping URL); (2) every resolver caches per TTL, so health would lag by TTL and the quorum logic of `05-doh-dns-txt.md` would have to be applied to a second record; (3) every visitor would pay an extra DoH query, leaking one more label to Cloudflare and Google, against `review/security.md` M6; (4) TXT strings are limited to 255-byte chunks, forcing a compact bitmask format; (5) the record is public and permanent in passive DNS. A status file (F41) and the chain aggregate (F44) have none of these costs. Recommendation: do not build it.
**Confidence:** medium-high (limits read; the cost analysis is inference). **Sources:** https://developers.cloudflare.com/fundamentals/api/reference/limits/ ; https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html (read 2026-10-17); `docs/research/05-doh-dns-txt.md`; `docs/review/security.md` M6. **Source date:** 2026-10-17.

#### F44. The chain can safely carry an owner-signed status aggregate (design inference)
The pin node (a real visitor holding the owner identity) can append `{ t: 'append', l: '_health', v: { ... } }` hourly. Because `writers: 'open'` lets anyone append to any list, readers must **filter by `author === ownerPub`**; the state reducer already exposes `Item.author` for lists (ARCHITECTURE section 6.4). Payload: counts and booleans only (trackers ok/total, seeders seen, web seed ok, pointer days to expiry, chain height). Benefit: health replicates to every visitor and survives a web-seed or status-host outage, and costs one small block per hour (about 8,760 blocks/year; compactable by owner tombstones). Limit: it is visible only to someone who already loaded the site, so it complements, not replaces, F41.
**Confidence:** medium (consistent with the documented data model; not implemented or tested). **Sources:** `docs/ARCHITECTURE.md` sections 6.1, 6.4. **Source date:** 2026-10-14.

---

## Concrete recommendations for magnet-web

Priority: **P0** = needed before calling it production-ready; **P1** = needed for sustained operation; **P2** = valuable, can follow; **P3** = only on evidence. Effort: **S** < 2 days, **M** 2-6 days, **L** > 1 week. "Evidence" cites the findings above. Thresholds marked *proposal* are mine and should be tuned on the first two weeks of data.

### R1 (P0, M): `src/loader/diag.js` - platform-boundary instrumentation plus a diagnosis engine
- **Install wrappers in `boot.js`**, before anything that can import webtorrent: subclass `WebSocket` and `RTCPeerConnection` (skeleton in Appendix A). Every listener is wrapped in `try/catch`; wrappers only push into bounded rings (max 200 PCs, 20 sockets); they **never read SDP or offer/answer bodies** (IPs, ufrags, fingerprints) and never touch the network. Record: WS open/close time and code (1006 means "reason hidden", F6), message **actions and counts**, tracker numeric fields (`complete`, `incomplete`, `interval`) and `failure reason` (<= 80 chars); PC creation, whether a remote description was ever set, `iceconnectionstatechange`/`icegatheringstatechange` timings, `icecandidateerror` (code, text, URL host only), candidate type counts, and on demand the selected pair type via `getStats()` (F4, F7, F8).
- **Classify PCs**: `offer-pending` (never got a remote description; includes the 5 eager offers per announce, expire at 50 s), `negotiating`, `connected`, `failed`, `closed`. Only `negotiating -> failed` counts as an ICE failure (E7: 9 of 11 PCs were unanswered offers).
- **Hook only public torrent API** for the rest: `wire` (type, bytes), `noPeers`, `warning`, `done`, `download`, plus `received - downloaded` and `peerBytes/webseedBytes` (F1). Do not reach into `torrent.discovery.tracker` (F2); the WebSocket wrapper already sees every tracker reply.
- **Timeline** with `performance.mark('mw:boot' | 'mw:sw-ready' | 'mw:pointer' | 'mw:first-wire' | 'mw:metadata' | 'mw:done' | 'mw:saved' | 'mw:site-visible')`.
- **Diagnosis within 5 s** (closes `review/requirements-fidelity.md` m5). Evaluate at t = 3 s, 5 s, then every 5 s (*proposal*):

| # | Condition | Visitor sees | Owner hint |
|---|---|---|---|
| 1 | no tracker socket reached `open`, `navigator.onLine` true | "Cannot reach any tracker (your browser does not say why)." | run `verify.mjs` `trackers.announce` |
| 2 | >= 1 tracker open, announce replies show only us (`complete + incomplete <= 1`), 0 wires | "Tracker reachable; no other visitor is online yet." | start a pin node / add `ws=` |
| 3 | replies show other peers, answers received, PCs in `negotiating` > 10 s, 0 wires | "Other visitors exist but a direct connection failed (network or NAT)." + STUN verdict | consider the TURN tier (`03` R-14) |
| 4 | gathering > 5 s, or >= 1 code 701 and 0 `srflx` | "A STUN server is unreachable." | prune `CONFIG.stun` (F7) |
| 5 | wires > 0, 0 bytes after 10 s, every `peerChoking` | "Connected, but peers are not sending." | check upload policy |
| 6 | web seed configured, 0 web-seed bytes after 5 s | "Web seed unreachable (CORS, DNS, TLS or blocked; the browser hides which)." | `verify.mjs` `webseed.http` |
| 7 | `received - downloaded` > 5% of `received` | "Some peers sent corrupt data." | |
| 8 | SW not controlling after `swMs` | "Limited mode: no Service Worker." | |
| 9 | storage `usage/quota` > 0.8, or `persisted === false` on WebKit | "Browser storage is nearly full / may be cleared." | F10 |

- **Interface**: `createDiag({ win })` reads the rings that `boot.js` hands over (a non-enumerable `window.__mwBoundary`; the rings contain no IPs by construction, Appendix A) and returns `{ snapshot(), diagnose(), subscribe(fn) }`, passed to `ui.js` by closure. A canary-only global `window.__mwDiag` exists **only** when `localStorage['mw:diag'] === '1'` (the canary sets it with `addInitScript`; production code path is otherwise identical) and returns **already redacted** data, because hosted same-origin site code can also reach `parent` (see Gotchas).
- **Tests**: unit tests with fake `WebSocket`/`RTCPeerConnection` classes; an E2E assertion that `snapshot().pcs.created > 0` once a peer exists (this fails loudly if someone moves the webtorrent import ahead of the wrappers: F4); a bounded-memory test.
- **Evidence:** F1-F8, E7. **Done when:** a Chromium run of `boundary-wrappers-poc` is reproduced by the real loader.

### R2 (P0, S-M): Exportable debug bundle (schema `mw-diag/1`) plus last-session summary
- Contents (all redacted; target <= 64 KiB uncompressed, measured headroom in F8): `build` (loader version, `BUILD_ID`, SW id, webtorrent version), `env` (engine by feature detection, major version, mobile flag, `online`, connection class or `unknown`, hardware concurrency bucket, feature flags from `boot.js`), `site` (mode, pointer source, signed/pinned, `seq`, `exp` as days remaining, owner fingerprint 8 hex, `btih`), `timeline`, `doh` (per resolver: status, ms, `AD`, TTL, agree), `trackers` (per host: state, connect ms, announces, last reply fields, failures, close codes, retries), `ice` (STUN verdict, error list, PC class counts, selected pairs by type with RTT and byte totals), `pieces` (piece count and length, verified count from `verified` events, failed-verification warnings, `received` vs `downloaded`, hotswap count, outstanding requests and choke state summarised per wire, never per-peer ids), `peers` (wires, web seeds, bytes by source, uploaded, wasted), `webseed` (host only, HTTP result), `storage` (`estimate`, `usageDetails` if present, `persisted`, IndexedDB names, Cache Storage keys), `sw` (scope, state, controller, update found, last 20 SW errors), `chain` (height, heads, orphans, rejected-by-reason counters, peers with `mw_chain`, PoW bits and measured mining ms), `errors` (code, count, first/last), `csp` (directive + blocked host + count), `log` (last 300 lines).
- **Redaction pipeline (always on, before any copy/export)**: IPv4/IPv6 regexes, `*.local`, ICE ufrag/pwd, DTLS fingerprints, SDP lines, URLs reduced to origin host, peer ids truncated to 8 hex, no private keys (identity as short id only), no site file paths (only counts and `kind`), no `userAgent` string except in the user-initiated export (F11).
- **Delivery**: `CompressionStream('gzip')` to a `Blob`, download `mw-diag-<btih8>-<yyyymmddThhmmZ>.json.gz`; "Copy" as base64url(gzip) for chat or an issue; "Copy diagnosis" (<= 10 text lines); a static `diag.html` viewer that decodes and renders it; a GitHub issue form with a bundle textarea (GitHub's issue-body limit is about 64k characters: **unverified here**, so keep the base64 under 40 KB).
- **Persistence**: on `visibilitychange` -> `hidden` (never `unload`, F9) write a <= 8 KB "last session summary" to IndexedDB `mw-diag`; on next load offer "the last visit ended with X"; expire after 7 days; ignore all failures; keep an in-memory fallback (F15, F10).
- **Evidence:** F8, F9, F10, F15. **Done when:** a golden-file test proves no IP, `.local`, ufrag or fingerprint survives; bundle < 64 KiB with 30 PCs; round-trips through `diag.html`.

### R3 (P0, M): `tools/verify.mjs` - one probe library used by publisher preflight, CI canary and `health.html`
Stable check ids, each `{ id, ok, ms, detail }`, JSON on stdout, exit 0/1 (and `--strict` to fail on warnings), `--status-out status.json`, `--hc <ping url>`:
1. `pointer.doh`: `_magnet.<host>` TXT through the quorum resolver from `05-doh-dns-txt.md` Appendix A (Cloudflare + Google JSON), parse, **verify the signature with the scope**, `seq` not below the published expectation, resolver agreement, `AD` flag recorded; `exp` horizon: warn < 14 days, fail < 3 days (*proposal*).
2. `pointer.meta`: shell `<meta name="mw-pointer">` equals DNS when both are used.
3. `host.static`: `/`, `/loader.js`, `/sw.js`, `/webtorrent.min.js` return 200 with the right MIME; bytes match the SRI hashes in `index.html`; deep link returns the shell; TLS certificate >= 14 days from expiry.
4. `webseed.http`: HEAD + `Range` GET for the first file and the last piece: `206`, `Content-Range`, `Accept-Ranges: bytes`; CORS headers with `Origin: https://<site>` per `ARCHITECTURE.md` section 1 (`Access-Control-Allow-Origin`, expose `Content-Range, Content-Length, Accept-Ranges`, allow `Range`).
5. `webseed.piece`: fetch 3 random pieces by range and compare SHA-1 with `site.torrent` (a true integrity audit of what visitors will download).
6. `trackers.announce` (`ws-tracker-probe.mjs` logic, F27): per tracker ok/ms/interval; **fail when < 3 of the configured trackers pass** (as `02` R9); `trackers.scrape` is informational only.
7. `swarm.seeders`: seeders >= 1 on >= 2 trackers for the real infohash (scrape; announce minus self where scrape is unsupported, F27-F28).
8. `stun.binding` (`stun-probe.mjs` logic): >= 2 STUN servers answer; skippable with `--no-udp` (GitHub-runner UDP is unverified, F29).
9. `torrent.consistent`: the `.torrent` infohash equals the pointer `btih` (catches a stale pointer after a publish).

Also the publisher's "doctor" for **migrating an existing site**: add `--site <dir>` to flag absolute `/api/...` fetches, root-absolute asset paths outside the torrent, a site-owned Service Worker at the same scope (conflicts with the loader's SW), mixed content, and files above the size caps. Browser build: the same modules minus `node:dgram` power `health.html` (R11).
- **Evidence:** F20-F29, `02` R9, `05` rec. 11. **Done when:** `node tools/verify.mjs --host example.org` returns exit 0 against the example deployment and non-zero when any one check is sabotaged (wrong CORS, expired `exp`, killed tracker).

### R4 (P0, S): Probe workflow in a public monitor repo (GitHub Actions)
- `.github/workflows/canary-probe.yml`: `on: schedule: - cron: '7,37 * * * *'` plus `workflow_dispatch` (odd minutes avoid the top-of-hour load, F20); Node 24; `concurrency` group so runs never overlap; job `timeout-minutes: 5`; run `node tools/verify.mjs --json --retries 1 --status-out status.json`.
- **Dead-man's-switch**: `curl -fsS https://hc-ping.com/$HC_UUID/start`, then success or `/fail` with the JSON as POST body (<= 100 kB stored, F24). Healthchecks period 30 min, grace 15 min.
- **Time series by git scraping** (F23): commit `status.json` to branch `status` only when it changed; publish via GitHub Pages (CORS `*`, F41).
- **Incidents**: after two consecutive failed runs open (or comment on) one GitHub Issue labelled `canary`; close on recovery (Upptime pattern).
- **Expiry alerts**: `pointer.exp` < 14 days = warn issue, < 3 days = Healthchecks `/fail`.
- Secrets: `HC_UUID`, and a dedicated **canary signing key** for `status.json` (never the owner key). Repo public (F21); nothing sensitive is stored.
- **Evidence:** F20, F21, F23, F24, F41. **Done when:** disabling the workflow produces a Healthchecks alert within 45 minutes.

### R5 (P1, M): Playwright E2E canary, hourly, reading `window.__mwDiag`
`canary-e2e.yml` cron `23 * * * *`; `npx playwright install --with-deps chromium`; `workers: 1`, `retries: 1`; Chromium launched with `--disable-features=WebRtcHideLocalIpsWithMdns` (needed for same-machine WebRTC, F22). Profiles: (a) cold start, **web-seed-only**; (b) warm repeat visit expecting `source: cache`; (c) **peers-only** against the pin node (magnet without `ws`); (d) offline reload via `context.setOffline(true)`; (e) two contexts, write in one and read in the other, equal chain heights. Assertions come from the diagnostics snapshot (render ok, `mw:site-visible` time, source, `pcs.connected`, rejected-block counters). *Proposed* limits to tune: cold web-seed <= 10 s (fail > 30 s), warm <= 2 s, offline reload <= 3 s. On failure upload the bundle JSON, screenshot and trace as artifacts and `/fail` the Healthchecks check. Never assert on UI strings (use the snapshot).
- **Evidence:** F20-F22; `ARCHITECTURE.md` section 12. **Done when:** a deliberately broken web seed (wrong CORS) turns profile (a) red with the diagnosis "Web seed unreachable" in the artifact.

### R6 (P0, S): Pin-node heartbeat and seeder-presence alarm
`tools/pin.mjs` (the Playwright "durable visitor") sends a Healthchecks ping every 60 s with a JSON body `{ peers, wires, seeding, uploadedDelta, chainHeight, uptimeS, renderOk }`, `/fail` on page crash (`page.on('crash')`), `browser.on('disconnected')`, `renderOk === false` or `seeding === false`; check period 2 min, grace 5 min. The external `swarm.seeders` check (R3 #7) independently alarms when no tracker lists a seeder. Two separate signals matter: the pin node says "I am alive", the trackers say "the world can see me". The same host can also run the R5 E2E profiles against the public URL on a timer, as a second vantage point on a different network and provider than GitHub's Azure runners, reporting to its own Healthchecks check.
- **Evidence:** F24, F28. **Done when:** killing the pin process pages within 7 minutes and the probe shows `swarm.seeders` failing.

### R7 (P0, S): Fix the shipped tracker list and gate releases on tracker health
Remove `wss://tracker.btorrent.xyz` and `wss://tracker.files.fm:7073/announce` from `CONFIG.trackers` (F5; decision belongs to `02` R-list / `w2b-01`), keep >= 3 trackers that pass `wsAnnounce` (F27), and add a CI step that runs the announce probe against the default list (warn when the network is unavailable, fail when < 3 pass online).
- **Evidence:** F5, F27, `02-wss-trackers.md` F1. **Done when:** CI fails if a default tracker is replaced by a dead hostname.

### R8 (P1, M): Local-first RUM and a Settings -> Diagnostics page (no network)
Use User Timing marks (R1) to compute per-session **time-to-site-visible** (split by `source`: cache / peers / web seed), **time-to-first-wire**, **offload ratio** (`peerBytes / total`), outcome and error code; store daily aggregates in IndexedDB `mw-diag` (log2 buckets, counts by outcome x source) for 30 days (best-effort on Safari, F10); show p50/p75, the last 10 sessions and "Export". Do **not** ship `web-vitals` in the loader (it cannot see the iframe, F13). Offer an opt-in `mw.vitals` in the SDK later: it runs `web-vitals` inside the site frame and relays over the existing MessageChannel (about 3 kB brotli; the site chooses).
- **Evidence:** F13, F10. **Done when:** a repeat visit shows source `cache` with a measured time-to-visible and the panel lists both visits.

### R9 (P1, S-M): Service-worker diagnostics that double as migration help
The SW keeps a ring of up to 100 misses `{ kind: api | asset | font | map | other, method, status, count }` (full paths stay local; the bundle gets `kind` and a hash), posts them to clients at a rate limit, and adds `Server-Timing: idb;dur=<ms>` to synthesised responses (F14). The panel section "Requests your site made that the torrent cannot answer" is the most useful single screen for an *existing website* being migrated (dynamic `/api/` calls, root-absolute assets, missing fonts).
- **Evidence:** F14; goal (1) of this wave. **Done when:** a site calling `fetch('/api/x')` shows an `api` miss with a migration hint.

### R10 (P1, S): Error reporter with a closed vocabulary (local; reported only via R14 if opted in)
Map every failure to a code from a registry (`E_*` plus internal codes such as `tracker_all_down`, `ice_stun_dead`, `idb_quota`, `sw_unavailable`, `webseed_unreachable`, `pointer_expired_cached`); unexpected exceptions get a fingerprint `sha256(name|code|top frame file:line:col normalised|BUILD_ID)` truncated to 8 hex; message text, URLs and stacks never leave the local bundle. Listen to `securitypolicyviolation` (meta CSP cannot `report-to`, F12), `error` and `unhandledrejection` (already wired to `S.log`, F5). Ship the sourcemap only to maintainers (BUILD_ID names the release).
- **Evidence:** F12, F16, F17, F19. **Done when:** a thrown test error yields one counted fingerprint and no message text outside the local bundle.

### R11 (P1, S-M): `health.html` - the visitor-run checker (IPFS public-gateway-checker pattern)
A static page on the loader origin that runs the browser-capable subset of `verify.mjs` from the visitor's own network: tracker WS announce (open/ok/interval, with the "reason hidden" caveat), STUN `srflx` presence and `icecandidateerror` list, DoH quorum for the site's `_magnet.` record (shared with `05` rec. 11 "check my record"), web seed Range + CORS, Service Worker / IndexedDB / storage state; then a diagnosis and "Copy bundle". It is the only place where a **mobile or residential vantage point** enters the picture without any telemetry (F18, F29).
- **Evidence:** F18, F29, `05` rec. 11. **Done when:** the page distinguishes "tracker reachable" from "tracker blocked" on a network that blocks `wss:` to one tracker.

### R12 (P1, S): `docs/OPERATIONS.md` - alert policy, SLOs, runbooks, and the egress-allowlist test
- **Alert policy**: two consecutive failures before any page; severities - *page*: static host down, web seed down **and** `swarm.seeders` fail, pointer invalid or `exp` < 3 days, pin heartbeat missing; *notify*: one tracker down, STUN degraded, DoH resolvers disagree, TLS < 14 days; *digest*: p75 time-to-visible regression > 50% week over week. A "canary of the canary" (Healthchecks) is mandatory. Mitigate the 60-day auto-disable (F20) by detection (the dead-man's-switch) plus a monthly real commit.
- **SLO proposals** (not evidence-based; adopt, then tune): cold web-seed render succeeds 99% of canary runs per 30 days; seeders >= 1 on >= 2 trackers 99.5%; `exp` horizon never below 14 days.
- **Runbooks** one line each: tracker down -> `w2b-01`; pointer expiring -> re-sign and re-publish; web seed 403 -> fix CORS (`Access-Control-Expose-Headers`); pin down -> restart and re-check `swarm.seeders`.
- **Egress-allowlist test** (protects the "no analytics" promise, F38, F40): a Playwright run with request logging asserts the loader contacts only the static host, configured trackers, STUN, DoH resolvers and the web seed; and a build assertion that the default `dist/` contains no `sendBeacon` (R14 uses build-time elimination).
- **Evidence:** F20, F24, F38, F40.

### R13 (P1, S): Publish gate and rollback
`tools/publish.mjs --verify` runs `verify.mjs` against the staged site (web seed + pointer, waiting out DNS TTL), triggers `workflow_dispatch` of the probe and E2E canaries, and prints the exact rollback (re-publish the previous signed `seq`). Pairs with `w2a-06-cicd-automation.md`.
- **Evidence:** F20-F23. **Done when:** publishing a site with a mismatched `btih` fails before DNS is changed.

### R14 (P2, M): Opt-in connectivity telemetry v1 (Plan W) - closed schema, delta counters, build-time switch
- **Switch**: esbuild `define` constant (for example `MW_TELEMETRY_URL`) set at deploy time; when empty the telemetry module is dead-code-eliminated (Element: "analytics are deemed impossible and the user won't be asked to opt in", F16). CI asserts `! grep -R sendBeacon dist/` for the default build (feasible today: `webtorrent.min.js` contains 0 occurrences and `src/` has none).
- **Consent**: Settings toggle "Help improve reliability" **off by default**, a link "What is sent?" showing the exact JSON for the last session (Glean "debug view" idea, F19), names the endpoint host and the `analytics_owner`; hidden entirely when `navigator.globalPrivacyControl` or Do Not Track is set (F11). No consent banner in the first-run flow (avoids fatigue); the existing P2P notice is unchanged.
- **Payload** (<= 1 KB, `text/plain` to avoid a preflight, F9; one per session at the first terminal state or `visibilitychange: hidden`; sampled with `p = min(1, 20000 / dailyVisits)`; no retry, no spool):

| Field | Values (closed) |
|---|---|
| `v`, `b` | schema version 1; `BUILD_ID` (8 hex) |
| `m` | `d` per-domain, `h` hub |
| `s` | `c` cache, `p` peers, `w` web seed, `x` mixed |
| `o`, `e` | rendered 0/1; error code from the registry or null |
| `t.ptr`, `t.wire`, `t.meta`, `t.done`, `t.vis` | log2 bucket of milliseconds (0-15) |
| `n.trk_ok`, `n.trk_n`, `n.offers`, `n.wires`, `n.pcs_fail` | small integers capped at 15 |
| `i` | STUN verdict `ok` / `part` / `none` (F7) |
| `p` | selected pair class: unordered pair of candidate-type initials (h host, s srflx, p prflx, r relay), for example `hh`, `hs`, `ss`, `sr`, or `na` |
| `u`, `d`, `g` | network `wifi`/`cell`/`unk` (Chromium only otherwise `unk`), device `desk`/`mob`, engine `ch`/`ge`/`wk` by feature detection |
| `bp`, `bw`, `bu` | log2 bucket of bytes from peers, from web seed, uploaded |

  Never sent: IP (the network path still shows it to the CDN/Worker operator), user agent, URLs or paths, identity keys, peer ids, timestamps, any free text, any persistent id.
- **Collector** (Cloudflare Pages Function or a Worker route `/_t/*`, same origin so `connect-src 'self'` is unchanged, F37): reject unknown fields and out-of-range values, `204` always, write `writeDataPoint({ indexes: [day], blobs: [enum fields], doubles: [counts] })` to Analytics Engine, do not log `cf-connecting-ip`; public `GET /_t/summary.json` with **k >= 20** suppression and `Cache-Control: max-age=300`; a Cloudflare rate-limit rule on `/_t`. Treat every number as a hint (F31): no alert may depend on it.
- **Endpoint source**: loader build config only, never pointer/meta/fragment/SDK (F40). Registry file `telemetry.schema.json` with per-field `expires` (Glean, F19) and a unit test that rejects unregistered fields.
- **Law/UX**: this is the consent-first design F36 points to; legal review is the abuse/legal wave's job.
- **Evidence:** F16, F17, F19, F31, F35-F37, F40. **Done when:** with the switch empty the egress test (R12) shows no request to any other host; with it set and consent off, none either.

### R15 (P2, S): CDN-log variant for AWS-style deployments
Document (DEPLOY.md) the "no code of ours" path: CloudFront standard logging v2 to S3, **select fields without `c-ip` and `cs(User-Agent)`**, a `GET /_t?...` answered by a CloudFront Function, queries in Athena; and the boot-failure heuristic `loader.js` / `index.html` request ratio (label it a heuristic). Still opt-in (F36, F39).

### R16 (P2, M): Cross-engine canary and a real-device matrix
Add Firefox and WebKit projects to the E2E canary on Linux CI, but note E12: on this macOS 27 host Playwright WebKit 27.2 did not connect a same-page loopback pair in 15 s (cause not isolated) and Playwright's Firefox failed to launch, so Linux CI behaviour is **unproven**; keep the real-device checklist from `03` R-13 (iOS Safari, Android Chrome, Samsung Internet, Brave) as a quarterly manual run using `health.html` bundles.

### R17 (P2, M): Signed `status.json` on the web seed or Pages, optionally consumed by the loader
Schema in Appendix C (`application/health+json` shape, F42), signed with the **canary key** (F41), written by R4. Loader (optional): fetch `<ws base>/.well-known/magnet-web/status.json` (same host as the pointer's `ws=`, so no new third party), verify against an optional pointer key `ck=<b64url pub>` (unknown keys are ignored by old loaders, so compatible), show a "degraded" banner, order trackers by recent success, and say "status unknown" when older than 2 hours. Advisory only; never a gate.

### R18 (P3, M): Owner-signed `_health` aggregate on the chain
Pin node appends hourly `{ trackersOk, trackersTotal, seedersSeen, webSeedOk, pointerDaysLeft, height }` to list `_health`; the UI reads only items whose `author === ownerPub` (F44).

### R19 (P3, L): Local DP or DAP only on evidence
Revisit when all hold: >= 10,000 opted-in reports/week, the collector is untrusted by the user, and (for DAP) an RFC plus a maintained aggregator exist (F30, F34). Otherwise R14's bucketing is more accurate.

### R20 (P3, S): CloudWatch Synthetics profile for AWS-hosted sites
Static host + DoH + web seed + render canary (not WebRTC until proven, F26): $0.86 / $1.73 / $3.46 per month in run fees at 60 / 30 / 15 minutes plus Lambda, Logs and S3.

---

## The two plans

### Plan Z - zero servers of ours (what v1 should ship)

| Layer | Component | Runs on | Cost | Cadence | Output / alert |
|---|---|---|---|---|---|
| Visitor | `diag.js`, bundle export, Settings -> Diagnostics, `health.html` (R1, R2, R8, R11) | the visitor's browser | $0 | continuous / on demand | local only |
| Publisher | `tools/verify.mjs` preflight + publish gate (R3, R13) | publisher laptop or CI | $0 | per publish | exit code, JSON |
| Probe canary | `canary-probe.yml` (R4) | GitHub Actions, public repo | $0 | every 30 min at :07/:37 | Healthchecks + Issue + `status.json` |
| E2E canary | `canary-e2e.yml` (R5) | GitHub Actions | $0 (public) | hourly at :23 | artifacts + Healthchecks |
| Seeding | pin heartbeat + `swarm.seeders` (R6) | pin host + probe | $0 | 60 s / 30 min | page |
| Dead-man's-switch | Healthchecks.io Hobbyist (20 checks) | SaaS | $0 | n/a | e-mail / Slack |
| Status | `status.json` on GitHub Pages (R4, R17) | GitHub Pages | $0 | 30 min | public, CORS `*` |
| Optional | UptimeRobot (50 monitors / 5 min) or Better Stack (10 monitors) HTTP checks of the static host and `status.json` age | SaaS | $0 | 5 min | second vantage |

Checks used on Healthchecks: probe, E2E, pin (1-3), optional status-age = 4-6 of 20. Everything is replaceable commodity infrastructure, consistent with G7. If the repo must be private, use 30-minute probes and 2-hour E2E (2,520 billed minutes/month, F21).

### Plan W - one Worker (adds field data; opt-in; deployer-operated)

Everything in Plan Z, plus:

| Layer | Component | Runs on | Cost | Notes |
|---|---|---|---|---|
| Beacon | `/_t` Pages Function or Worker route (R14) | Cloudflare | $0 below about 20,000 beacons/day (Free: 100,000 requests/day shared with all Functions) | static assets stay free; if a Worker route is used, choose fail-open |
| Storage | Workers Analytics Engine | Cloudflare | not billed yet; Free 100,000 points/day, 3-month retention | 250 points per invocation max |
| Summary | `GET /_t/summary.json`, k >= 20, 5-minute cache | Cloudflare | $0 | public, no raw rows |
| Edge probe | Worker Cron Trigger (5 free per account) running tracker WS announce probes | Cloudflare edge | $0 | no UDP, so no STUN; a third vantage |
| Logs | Workers Logs | Cloudflare | Free 200,000 events/day, 3-day retention | new Observability pricing from 2026-12-01 |
| Upgrade | Workers Paid | Cloudflare | $5/month minimum | 10M requests/month, longer retention, 250 Cron Triggers |

**How to present "no backend of ours" honestly** (draft for legal review; wording follows Element's pattern, F16):
- README/DEPLOY: "magnet-web has no required backend and ships with no telemetry. A site operator may add a reliability-statistics endpoint when building the loader. If they do, the loader asks you first, shows the exact data, and sends nothing until you opt in. The endpoint is chosen by the operator who deployed the loader, never by a site's address record."
- Settings text: "Help improve reliability. Send an anonymous connection report to `<host>` (operated by `<analytics_owner>`) once per visit: whether the site loaded, rounded timings, whether peers could connect, your browser engine and device class. It does not include your address, pages you viewed or any identifier, although the network path still shows your IP address to the operator when your browser connects. [What is sent?] Off by default."
- Disclose in the same place that trackers, STUN servers and DoH resolvers already see the visitor's IP regardless (`review/security.md` M6); the beacon adds one more party, which is why it is opt-in and operator-chosen.

### Decision table

| Question | Answer |
|---|---|
| Can v1 ship with Plan Z alone? | Yes. It covers "is it up", "is anyone seeding", "does a cold load work", "why can't this visitor load". |
| What does Plan W buy? | Field data on NAT/CGNAT/iOS outcomes (`03` R-13), which no canary can see. |
| Is Plan W required for production-ready? | No. P2, only when the operator wants field data. |
| Should visitor telemetry use the chain? | No (F32). |
| DNS health record? | No (F43). |
| LDP/DAP? | Not in v1 (F30, F34). |

---

## Gotchas

1. **Wrapper ordering is silent.** If anything evaluates `webtorrent.min.js` before the `WebSocket`/`RTCPeerConnection` wrappers exist, diagnostics show 0 sockets and 0 PCs while the site still loads (F4, E7). Guard with an E2E assertion (`pcs.created > 0`) and a unit test on `boot.js` order.
2. **Browsers hide failure reasons.** WebSocket (and `fetch`) failures carry no cause by specification (F6). Never promise "DNS vs TLS vs CORS" in the UI; say "reason hidden by your browser" and point to `health.html` or the canary.
3. **PC count is not peer count.** The tracker client creates up to 5 offers per announce per client and 9 of 11 PCs in the PoC never left `new` (F4). Count ICE failures only for PCs that received a remote description.
4. **`icecandidateerror` is noisy.** It can arrive after `gathering-complete`, and a hostname-lookup 701 appeared next to a working `srflx` (F7). Decide on `srflx` presence, not on the first error. A single dead STUN server delayed gathering to 39.9 s in Chromium 156 and costs each `trickle:false` offer the 5 s `iceTimeout`.
5. **`getStats()` leaks addresses** even on remote candidates in Chromium 156 (F8). Redact in one place, always. Also: same-origin hosted site code can reach `parent`, so anything exposed on `window` must already be redacted (a hub-mode iframe with `allow-same-origin` is the worst case; the final sandbox decision belongs to the security wave).
6. **Chromium-only signals** (`navigator.connection`, `deviceMemory`, `userAgentData`) and the Safari `StorageManager`/eviction rules mean every bucket needs `unknown` (F10, F11).
7. **Lifecycle:** `unload` is gone in Chrome 155+ and unreliable on mobile; use `visibilitychange`. `sendBeacon()` returning `true` means queued, not delivered; the queue is 64 KiB. A JSON `Blob` beacon forces a CORS preflight; send `text/plain` (F9).
8. **GitHub cron is best-effort.** Delays (worst at the top of the hour), dropped jobs under load, auto-disable after 60 days without repository activity in public repos, failure e-mail to the last editor of the cron line only (F20). The only reliable alarm is a missing success ping.
9. **Healthchecks UUID pings are rate-limited silently** (`200 OK (rate limited)`, F24): a flapping job can look healthy. Cap pings at <= 5/min/check, prefer slug endpoints (they return `429`), and treat the ping URL as a secret (Actions secret): anyone who has it can mark the check healthy.
10. **Billed minutes round up per job**, and Playwright discourages caching browsers (F21, F22): ten 20-second jobs bill ten minutes. Merge checks into one job; keep the monitor repo public.
11. **Scrape is not liveness** (`tracker.openwebtorrent.com` announces but closes on scrape, F27), and an announce probe on the real infohash adds the prober as a leecher until `stopped` is processed.
12. **Node's `WebSocket` cannot send `Origin`**, so origin-allowlisted trackers (`tracker.files.fm:7073`) cannot be probed that way - and should not be defaults anyway (F5).
13. **STUN/UDP from GitHub runners is unverified** (F29). Make the UDP check skippable (`--no-udp`) until one real run proves it; do not let a missing UDP path page anyone.
14. **A green canary is not a happy user.** It runs from an Azure datacenter with a clean NAT (F29). It cannot see CGNAT, carrier NAT, iOS background suspension or corporate UDP blocks; keep `health.html` and the quarterly real-device run.
15. **Do not let the canary be the only seeder it tests.** If the E2E canary loads from a swarm in which the canary itself is the sole peer, a broken P2P path stays green. Run web-seed-only and peers-only profiles separately, with the peers-only profile pointed at the pin node.
16. **Safari may delete the diagnostic ring** (7-day rule for Safari tabs, F10), and `persisted: false` is normal there. Persist only the small last-session summary and never rely on it for incident forensics.
17. **Lighthouse/CrUX will score the shell plus the iframe together** (F13), including P2P load time on a first visit, while in-page `web-vitals` sees only the shell. Say so in the docs so publishers are not surprised by Search Console.
18. **Meta CSP cannot send reports** (`report-uri` unsupported, `report-to` unspecified), and Report-Only is unavailable in `<meta>` (F12). Use the DOM `securitypolicyviolation` event.
19. **Pointer-supplied telemetry URLs would be a tracking vector** (F40). Do not add `tel=`; do not read an endpoint from `<meta>` or the fragment either.
20. **Local DP is not magic:** it needs unlinkable reports and a trustworthy randomiser, costs about 1.1x (eps = 4) to 5.7x (eps = ln 3) more samples than plain counting for a binary rate and about 29x for an 8-way histogram at eps = ln 3 (F30), and is poisonable (F31). A Worker collector must assume junk and rate-limit.
21. **Opt-in telemetry has survivorship bias:** visitors whose page never booted (Lockdown Mode, old browsers, in-app browsers) cannot opt in or report; only the CDN-log heuristic (F39) hints at them.
22. **`status.json` is advisory.** Whoever controls the repo or CI can forge it (F41). Do not gate loading on it; treat stale as "unknown".
23. **Vendor numbers move.** Every price and plan limit here was read on 2026-10-17 from summarising fetches (medium confidence). Workers Logs pricing changes on 2026-12-01; Analytics Engine billing is announced as "in the coming months" (F37).
24. **Tool versions drift:** the repo's Playwright is 1.64.1 while AWS Synthetics' newest Playwright runtime bundles 1.63.0 (F22, F26); keep canary scripts to the common subset.
25. **All cron times are UTC** (GitHub, Cloudflare); convert when reading alert times.
26. **Probe hygiene:** public trackers are volunteers (`02` F4); probe politely (one connection each, 30-minute cadence, no offers, `stopped` after announce) and identify the prober in the peer id prefix (`-MWC001-` in the saved probe).

---

## Open questions

1. Does a commit made by the monitor workflow itself (GITHUB_TOKEN) count as "repository activity" for the 60-day auto-disable? Not verified (search budget exhausted; the docs sentence does not define activity). Test: let a public repo idle with only bot commits and watch for 60 days, or add the monthly real commit anyway.
2. Do GitHub-hosted runners allow outbound UDP to STUN servers? Unverified (F29). One workflow run settles it.
3. Can Chromium inside CloudWatch Synthetics complete ICE/STUN (Lambda UDP egress)? Untested (F26).
4. What opt-in rate should a small static site expect? Unknown; it decides whether Plan W is worth building (F30 shows what the numbers need to be).
5. What does `getStats()` cost on a low-end phone? Measured only on an M3 desktop (F8).
6. Why did Playwright WebKit 27.2 not connect a same-page loopback pair in 15 s, and why did Playwright's Firefox (Nightly build 1555) fail with "Could not find profile folder" on this macOS 27 host? Neither investigated (E12); the answer determines whether a Linux-CI cross-engine canary is feasible.
7. Does `report-to` work in a `<meta>` CSP? The CSP3 text I read lists `report-uri`, `frame-ancestors`, `sandbox` and the Report-Only header only (F12).
8. What is GitHub's maximum issue-body length (believed about 65,536 characters; unverified)? It sets the bundle copy size.
9. Which notification integrations does Healthchecks.io really offer (Telegram, ntfy, Discord, Matrix)? The integrations page returned 404 (F24).
10. How do iOS/Android in-app browsers (Facebook, Instagram, TikTok webviews) behave with `boot.js`, the Service Worker and WebRTC? Unmeasured; relevant to the boot-failure heuristic (F39).
11. How much does a throttled phone slow Hashcash minting (F32 uses the extrapolated 0.46 MH/s)? Matters only if the owner-signed `_health` aggregate (R18) is built.
12. Will the final iframe sandbox allow hosted code to reach `parent` in hub mode? Decides whether `__mwDiag` may exist there at all (Gotcha 5).
13. Does Cloudflare's rate-limiting rule set on the Free plan allow a rule on `/_t`? Not read; the collector must not depend on it.
14. Which pointer key carries the canary public key (`ck=` is my placeholder) and who owns the pointer grammar (R17)?
15. How large is the real schedule jitter of GitHub cron for this repo? Measure for two weeks by storing `scheduled_at` vs `started_at` in `status.json`.
16. Legal basis for the beacon in CA/EU/UK, and whether an IP address visible to the Worker operator needs more than the disclosure drafted above (F36 is not legal advice; belongs to the abuse/legal wave).
17. Is the Analytics Engine SQL query path (API token, Grafana) acceptable for a zero-ops dashboard? Not read; `summary.json` is the fallback.
18. Search-dependent facts I could not re-check after the budget ran out: GitHub issue-body limit; community "keepalive" workflows; Healthchecks integration list; Tor Metrics' noise/rounding design (the pages I fetched did not describe it); rtcstats-js's wrapping mechanism.

---

## Appendix A - boundary wrapper skeleton for `boot.js` (derived from the tested PoC)

```js
// boot.js (classic script, ES2017 syntax). MUST run before anything imports webtorrent (F4).
// Observers only: bounded rings, try/catch everywhere, no network, never read SDP/offer/answer bodies.
// The rings hold no IP addresses by construction (configured tracker/STUN hostnames, counts, timings), so handing them to
// loader.js through a non-enumerable property is acceptable; getStats() output is only read inside the redaction pipeline.
// Helpers safeHost / hostOf / countType are omitted here (each is 2-4 lines).
(function installBoundaryWrappers (win) {
  var diag = { t0: performance.now(), ws: [], pc: [] }
  try { Object.defineProperty(win, '__mwBoundary', { value: diag, enumerable: false }) } catch (_) {}
  var T = function () { return Math.round(performance.now() - diag.t0) }
  var ring = function (arr, rec, max) { arr.push(rec); if (arr.length > max) arr.shift(); return rec }
  try {
    var NativeWS = win.WebSocket
    win.WebSocket = class extends NativeWS {
      constructor (u, p) {
        super(u, p)
        var rec = ring(diag.ws, { host: safeHost(u), createdAt: T(), in: {}, out: {}, tracker: [] }, 20)
        try {
          this.addEventListener('open', function () { rec.openAt = T() })
          this.addEventListener('close', function (e) { rec.closeAt = T(); rec.code = e.code }) // 1006 = reason hidden (F6)
          this.addEventListener('message', function (ev) { /* parse JSON; count action; keep complete/incomplete/interval/'failure reason'(<=80) */ })
        } catch (_) {}
      }
    }
    var NativePC = win.RTCPeerConnection
    win.RTCPeerConnection = class extends NativePC {
      constructor (cfg) {
        super(cfg)
        var rec = ring(diag.pc, { createdAt: T(), hasRemote: false, ice: [], gather: [], cand: {}, errors: [] }, 200)
        try {
          this.addEventListener('iceconnectionstatechange', () => rec.ice.push([this.iceConnectionState, T()]))
          this.addEventListener('icegatheringstatechange', () => rec.gather.push([this.iceGatheringState, T()]))
          this.addEventListener('icecandidate', (e) => { if (e.candidate) countType(rec.cand, e.candidate.candidate) }) // type only, never the candidate string
          this.addEventListener('icecandidateerror', (e) => rec.errors.push({ code: e.errorCode, host: hostOf(e.url), at: T() })) // not e.address (local IP)
          const srd = this.setRemoteDescription.bind(this)
          this.setRemoteDescription = function () { rec.hasRemote = true; return srd.apply(null, arguments) } // offer-pending vs negotiating
        } catch (_) {}
      }
    }
  } catch (_) { /* a wrapper bug must never break loading */ }
})(window)
```

Test that proves it: `node docs/research/labs/w2b-04-probes/boundary-wrappers-poc/run.mjs both` (before: 1 WS and 11 PCs; after: 0 and 0).

## Appendix B - illustrative debug bundle (`mw-diag/1`), values invented, shape proposed

```json
{
  "schema": "mw-diag/1", "generatedAt": "2026-10-17T21:30:00Z",
  "build": { "loader": "0.1.0", "buildId": "3fa9c2d1", "sw": "3fa9c2d1", "webtorrent": "3.0.21" },
  "env": { "engine": "chromium", "major": 156, "mobile": false, "online": true, "conn": "unknown", "cores": 8, "features": { "sw": true, "idb": true, "rtc": true, "compression": true } },
  "site": { "mode": "per-domain", "pointer": "dns", "signed": true, "pinned": true, "seq": 7, "expDays": 41, "owner": "a1b2c3d4", "btih": "3a1b...", "files": 14, "bytes": 1843200 },
  "timeline": { "boot": 0, "swReady": 412, "pointer": 655, "firstWire": 1930, "metadata": 2010, "done": 3490, "siteVisible": 3620 },
  "doh": [ { "r": "cloudflare", "ok": true, "ms": 88, "ad": true, "ttl": 300 }, { "r": "google", "ok": true, "ms": 121, "ad": true, "ttl": 300 } ],
  "trackers": [ { "host": "tracker.webtorrent.dev", "state": "open", "connectMs": 214, "announces": 3, "last": { "complete": 3, "incomplete": 1, "interval": 120 }, "closeCodes": [], "retries": 0 } ],
  "ice": { "stun": "ok", "gatherMsP50": 140, "errors": [ { "code": 701, "host": "stun.example", "n": 1 } ], "pcs": { "created": 11, "offerPending": 9, "negotiating": 0, "connected": 2, "failed": 0 }, "selected": [ { "local": "host", "remote": "srflx", "proto": "udp", "rttMs": 34, "in": 1048576, "out": 20480 } ] },
  "pieces": { "count": 8, "length": 262144, "verified": 8, "failedVerification": 0, "received": 1843200, "downloaded": 1843200, "hotswaps": 0, "choked": 0, "outstanding": 0 },
  "peers": { "wires": 2, "webseeds": 1, "bytesPeers": 1200000, "bytesWebSeed": 643200, "uploaded": 20480, "wasted": 0 },
  "storage": { "usage": 7340032, "quota": 2147483648, "persisted": false, "idb": ["mw-sites", "mw-chain-host:example.org"] },
  "sw": { "scope": "/", "state": "activated", "controller": true, "errors": [] },
  "chain": { "height": 118, "heads": 2, "orphans": 0, "rejected": { "pow": 0, "sig": 0, "policy": 0, "rate": 0 }, "powBits": 14, "powMsP50": 2 },
  "errors": [], "csp": [], "log": ["...last 300 redacted lines..."]
}
```

## Appendix C - illustrative `status.json` (health+json shape, signed with the canary key)

```json
{
  "status": "pass",
  "version": "1", "releaseId": "3fa9c2d1", "serviceId": "example.org",
  "generated": "2026-10-17T21:37:07Z", "scheduledAt": "2026-10-17T21:37:00Z", "seq": 1042,
  "checks": {
    "pointer:doh": [ { "status": "pass", "observedValue": 41, "observedUnit": "days-to-exp" } ],
    "trackers:announce": [ { "status": "pass", "observedValue": 4, "observedUnit": "of 4" } ],
    "swarm:seeders": [ { "status": "pass", "observedValue": 2, "observedUnit": "trackers with seeders" } ],
    "webseed:piece": [ { "status": "pass", "observedValue": 3, "observedUnit": "pieces verified" } ],
    "stun:binding": [ { "status": "warn", "output": "skipped (--no-udp)" } ]
  },
  "links": { "self": "https://example.github.io/monitor/status.json" },
  "sig": { "alg": "ES256", "kid": "canary-2026-10", "value": "<b64url r||s over the canonical JSON without sig>" }
}
```
`Cache-Control` is whatever Pages sends (`max-age=600` observed). Consumers treat `generated` older than 2 hours as "unknown" (R17).

---

## Sources read

**Primary documentation and specifications (all read 2026-10-17 unless noted)**
- GitHub Docs: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows ; https://docs.github.com/en/billing/concepts/product-billing/github-actions ; https://docs.github.com/en/billing/reference/actions-minute-multipliers ; https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
- Healthchecks.io: https://healthchecks.io/docs/http_api/ ; https://healthchecks.io/pricing/ ; https://healthchecks.io/docs/configuring_notifications/ ; https://healthchecks.io/integrations/ (HTTP 404)
- Better Stack https://betterstack.com/pricing ; UptimeRobot https://uptimerobot.com/pricing/ ; Checkly https://www.checklyhq.com/pricing/
- AWS: https://aws.amazon.com/cloudwatch/pricing/ ; https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Library_nodejs_playwright.html ; https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html ; https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html
- Cloudflare: https://developers.cloudflare.com/workers/platform/limits/ ; https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/analytics/analytics-engine/limits/ ; https://developers.cloudflare.com/analytics/analytics-engine/pricing/ ; https://developers.cloudflare.com/web-analytics/about/ ; https://developers.cloudflare.com/web-analytics/get-started/ ; https://developers.cloudflare.com/pages/functions/pricing/ ; https://developers.cloudflare.com/workers/configuration/cron-triggers/ ; https://developers.cloudflare.com/fundamentals/api/reference/limits/
- Playwright: https://playwright.dev/docs/ci
- web-vitals: https://github.com/GoogleChrome/web-vitals ; https://raw.githubusercontent.com/GoogleChrome/web-vitals/main/README.md ; https://raw.githubusercontent.com/GoogleChrome/web-vitals/main/CHANGELOG.md ; https://github.com/GoogleChrome/web-vitals/releases (empty page)
- WebTorrent API: https://github.com/webtorrent/webtorrent/blob/master/docs/api.md
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon ; .../RTCPeerConnection/icecandidateerror_event ; .../WebSocket/error_event ; .../CloseEvent/code ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP ; MDN browser-compat-data 8.1.6 (npm tarball `@mdn/browser-compat-data`, queried locally)
- W3C / WHATWG: https://www.w3.org/TR/webrtc-stats/ (CRD 2025-09-25) ; https://www.w3.org/TR/beacon/ (CRD 2022-08-03) ; https://www.w3.org/TR/CSP3/ ; https://websockets.spec.whatwg.org/
- Chrome / web.dev: https://developer.chrome.com/docs/web-platform/deprecating-unload ; https://developer.chrome.com/docs/crux/methodology ; https://web.dev/articles/lcp
- WebKit: https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10) ; https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24, OLD)
- IETF: https://datatracker.ietf.org/doc/draft-ietf-ppm-dap/ (rev 19, 2026-07-06) ; https://datatracker.ietf.org/doc/draft-inadarei-api-health-check/ and https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check-06 (2021, OLD)
- EDPB: https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en ; PDF `https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf` (v2.0, adopted 2024-10-07)

**Code and project repositories read**
- Element Web (`develop`): https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/src/rageshake/rageshake.ts ; .../apps/web/src/rageshake/submit-rageshake.ts ; .../docs/config.md ; .../apps/web/src/PosthogAnalytics.ts
- PeerTube: https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/support/doc/api/openapi.yaml ; https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/config/default.yaml ; https://github.com/Chocobozzz/PeerTube/releases/tag/v8.0.0 ; https://docs.joinpeertube.org/api-rest-reference.html (page truncated; the OpenAPI file was used instead)
- IPFS: https://github.com/ipfs/public-gateway-checker ; raw `src/Checker.ts`, `src/Cors.ts`, `README.md` ; https://github.com/ipfs/service-worker-gateway
- Upptime: https://github.com/upptime/upptime ; https://github.com/upptime/upptime/commits/master ; Simon Willison https://simonwillison.net/2020/Oct/9/git-scraping/ (OLD)
- rtcstats: https://github.com/rtcstats/rtcstats (README read; maintained; no claim relies on it)
- Cloudflare Daphne: https://github.com/cloudflare/daphne (archived 2026-06-03)
- Mozilla Glean: https://mozilla.github.io/glean/book/user/metrics/adding-new-metrics.html ; https://mozilla.github.io/glean/book/user/pings/index.html
- Plausible: https://plausible.io/data-policy
- Divvi Up: https://divviup.org/blog/divvi-up-in-firefox/ (2023-10-12, OLD)
- Papers: https://arxiv.org/abs/1407.6981 (RAPPOR, 2014, OLD) ; https://arxiv.org/abs/1911.02046 (poisoning LDP, 2020-12) ; https://machinelearning.apple.com/research/learning-with-privacy-at-scale (2017-12-06, OLD)
- npm registry metadata (2026-10-17): web-vitals 6.2.3, webtorrent 3.0.21, bittorrent-tracker 11.2.3, playwright / @playwright/test 1.64.1, @sentry/browser 11.8.0, @mozilla/glean 5.0.10, stun 2.1.0 (last published 2019), @cloudflare/workers-types 5.20261016.1
- Tor Metrics pages (https://metrics.torproject.org/onionperf-latencies.html, .../hidserv-rend-relayed-cells.html): read, no usable claim (they do not describe noise/rounding)

**Live checks and probes**
- `curl -I` https://ipfs.github.io/public-gateway-checker/ and https://raw.githubusercontent.com/ipfs/public-gateway-checker/main/README.md (headers quoted in F41)
- STUN, WS tracker, Chromium ICE/getStats and boundary-wrapper experiments: `docs/research/labs/w2b-04-probes/`

**Search-result snippets only (not opened; lower weight)**
- GitHub Actions self-hosted runner charge postponement: https://socket.dev/blog/github-actions-pricing-whiplash ; https://tenki.cloud/blog/github-actions-runner-pricing-2026
- PeerTube "stats for nerds": https://next.ink/brief-article/peertube-3-2-des-ameliorations-ergonomiques-et-un-peu-partout/ ; https://alternativeto.net/news/2025/12/peertube-v8-launches-with-redesigned-video-player-collaborative-channel-management-and-more
- DAP working-group minutes (second WGLC): http://ietfminutes.org/minutes/2026-06-29/ppm.html
- CloudWatch Synthetics pricing explainers (cubeapm.com, signoz.io, awsfundamentals.com) - superseded by the AWS pages above

**Local sources**
- Repo: `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `src/loader/{ui,torrent,config,policy,app}.js`, `docs/research/{02-wss-trackers,03-webrtc-nat-privacy,04-service-worker-serving,05-doh-dns-txt,06-browser-chain-vs-crdt}.md`, `docs/review/{requirements-fidelity,security,browser-mobile,distributed-systems}.md`, sibling drafts `w2b-01-tracker-resilience.md` and `w2a-06-cicd-automation.md`
- Installed packages: `webtorrent@3.0.21`, `bittorrent-tracker@11.2.3`, `bittorrent-protocol@5.0.9`, `torrent-discovery`, `@thaunknown/simple-peer` (lite), `@thaunknown/simple-websocket`

