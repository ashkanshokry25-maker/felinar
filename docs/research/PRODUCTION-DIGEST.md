# Production digest: wave 2b (trackers, connectivity, ledger durability, observability, security, abuse and legal)

- **Date:** 2026-10-19. The inputs were written on 2026-10-17; the source tree was re-read on 2026-10-19 where this digest says "tree".
- **Status:** synthesis for the editor of ARCHITECTURE v0.3. Nothing here is normative until it is merged into `docs/ARCHITECTURE.md` or `docs/INTERFACES.md`. Wording follows `docs/review/DESIGN-REVIEW.md` section 4 (the product term is "site ledger"; none of the marketing terms DR 4.2 bans is used). Legal material is a summary of research notes, **not legal advice**; every template in section 9 is a draft for counsel.
- **How to read:** sections 1-6 are the digest the brief asked for; 7-10 are the operational add-ons (deployments, observability plan, ops and legal checklist, the Nostr decision); 11 covers the missing performance topic.

## 0. Sources, coverage and precedence

### 0.1 Source keys

| Key | File (in `docs/research/`) | Scope | Checked by |
|---|---|---|---|
| 01 | `w2b-01-tracker-resilience.md` (evidence: `labs/w2b-01-tracker-resilience-ref/`) | WebSocket tracker resilience, self-hosting, reference deployment, Durable Object prototype | not verified |
| 02 | `w2b-02-nostr-durability.md` (probes: `labs/w2b-02-probes/`) | Nostr relays and Blossom for ledger durability, cold start and signaling | not verified |
| 03 | `w2b-03-turn-connectivity.md` (lab: `labs/w2b-03-turn-connectivity-lab/`) | how many visitors fail P2P, TURN, the connectivity probe | not verified |
| 04 | `w2b-04-observability-no-backend.md` | diagnostics, canaries, opt-in telemetry | 04V |
| 04V | `w2b-04-observability-no-backend-VERIFY.md` | 8 claims: 3 confirmed, 5 nuanced, 0 refuted | |
| 05 | `w2b-05-security-hardening-prod.md` (probes: `labs/w2b-05-probes/`) | loader integrity, owner keys, kill switch, SW update safety, supply chain, wire cap | not verified |
| 06 | `w2b-06-abuse-legal-ops.md` | abuse, legal and privacy operations | 06V |
| 06V | `w2b-06-abuse-legal-ops-VERIFY.md` | 8 claims: 3 confirmed, 5 nuanced, 0 refuted | |
| ARCH, INTF, DR | `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md` v0.2, `docs/review/DESIGN-REVIEW.md` | normative documents and the review that produced them | |

Citation style: "01 F7" = finding F7 of file 01; "01 R4" = its recommendation R4; "05 3.3" = section 3.3; "06 B3" = Appendix B item B3; "04V claim 3" = claim 3 of the VERIFY file; "ARCH 8" = section 8 of ARCHITECTURE.md; "DR S7" = DESIGN-REVIEW item S7.

### 0.2 Coverage and shared limits

- **Missing topic: 07 performance engineering.** There is no `w2b-07-*.md` report. `docs/research/labs/w2b-07-perf-lab/` holds scripts and raw outputs (a cold peer-to-peer load timeline with link emulation, bundle evaluation cost, ICE gathering, IndexedDB, `RTCPeerConnection` cost, SHA-1 throughput, a bundle size breakdown) that no report has reviewed; this digest cites none of their numbers. Section 11 states the latency model the architecture implies, as a placeholder to measure.
- **Limits shared by all six reports:** the shared WebSearch budget ran out during each run, so later sources are direct fetches of named primary URLs; Firefox was never exercised (Playwright's Firefox build did not start on the macOS 27 host, or was not installed); "WebKit" means Playwright WebKit 27.2, mostly on loopback; no real phones; one network vantage point; vendor prices and plan limits were read on 2026-10-17 and carry medium confidence.
- **No research run published anything or sent a message on Ash's behalf.** Probes were small and mostly read-only: 01 and 04 sent short `numwant: 0` announce probes (01 also a few offer-relay tests in private random swarms) to the public trackers; 02 sent no Nostr events and uploaded nothing; 05 did not send its disclosure email. Every remaining outbound step is collected in 6.3 for Ash's decision.

### 0.3 Which source wins when files disagree

1. A VERIFY file beats the file it checked, for the claims it checked: it re-read the primary sources later the same day.
2. A measurement on the pinned stack beats documentation, a review note or an earlier wave (example: 05's npm experiment beats DR S7).
3. The tree (read 2026-10-19) beats any report's description of the tree.
4. ARCH v0.2 and DR win on constants and on what is already decided; a report wins where it measured a defect in ARCH or DR, and that becomes a proposed amendment.
5. When two reports design the same thing, the report whose topic it is wins and the other's evidence is folded in (02 over 01 on Nostr; 05 over 06 on the kill-state token; 06 over 05 on legal triggers).
6. On legal readings the conservative engineering default stands until counsel answers, but the text must not attribute it to a regulator (04V claim 7, 06V claim 8).

Every contradiction found and its resolution is listed in 4.3.

## 1. Executive verdict

1. **v1 can be production-ready with no backend of ours because the web seed is the correctness path.** With `ws=` and `xs=` in the pointer, the test site loaded in 18-85 ms (loopback) under dead, black-holed, mute, alive-but-empty, NXDOMAIN or absent trackers in Chromium and WebKit; without `xs=` nothing loaded (01 F10). Peers, TURN, relays and blob mirrors are offload and resilience, never correctness.
2. **The P0 list is long but small-grained.** The 20 merged P0 items (section 3) are 9 S, 2 S-M and 9 M, with nothing L. The only L-size launch blocker, the signed client denylist (06 R3), gates a public hub, not a per-domain release.
3. **Tracker resilience is won in the client; one own tracker on a neutral hostname is cheap insurance.** The four public trackers passed every counted sample (16 of 16 each) and 24 of 24 relay tests but publish no SLA or abuse policy, and HaGeZi Anti-Piracy blocks all four by hostname (01 F1, F2). After a 2-second tracker blip the stock client stays away for a median 174 s (max 306 s); a reconnect shim brings it back in 1-2 s; a count-aware announce policy creates 0 instead of 45 `RTCPeerConnection`s per 30 s while alone (01 F7). The stock tracker server exits on one malformed message; the hardened wrapper fixes that and runs for $0-7 a month (01 F3, F4).
4. **Plan for 10-30% of peer pairs needing a relay, and ship TURN off.** No rigorous recent public measurement exists; the only first-party figure with a sample (22%) is from 2016 (03 F-01). Failure belongs to the pair, so one or two always-on seeders on public addresses act as free relays for hard-NAT visitors (03 F-03). The urgent fix is cheaper than TURN: one dead ICE server stalls every non-trickle offer by 5 s and holds gathering for about 40 s (03 F-21).
5. **Observability: Plan Z (zero servers of our own, about $0 a month) is enough for v1.** Browsers hide WebSocket failure reasons from scripts by specification, so the in-page panel says *what* failed and external probes say *why* (04 F6, 04V claim 1). Visitor telemetry never goes on the site ledger (04 F32, 04V claim 5). An optional beacon is P2, opt-in, and its endpoint comes only from build configuration (04 R14, 04V claim 8).
6. **Security: the static host stays the trust root on every visit; add detection and fail-closed levers, not a self-check.** A hostile host can serve clean bytes to a self-check and different bytes to the page, and the browser's SW update fetch bypasses every service worker (05 F1, F9). Before the first release: reserve a fail-closed `st` pointer key, make SW installs atomic and navigations fail open, publish the kill-switch runbook (healthy again about 3 s after the next navigation in Chromium), and test the wire cap with `0x7FFFFFFF` (05 R1-R6).
7. **Abuse and legal: liability attaches to services, not to hashes, and the hub is the exposed surface.** Before launch: a first-run card with a real refusal and a versioned consent record, a withdrawal that purges every stored version, a privacy notice with a recipients register, a notice-and-action runbook with a measured time-to-block; before a public hub, also a signed double-hashed denylist and a gate-only hub apex with no directory (06 R1-R8). A hub apex shares Safe Browsing fate across all its labels, and a Public Suffix List entry does not isolate labels in Chromium or Firefox lookups (06V claim 7).
8. **Ledger durability: host snapshot plus pin node is the v1.0 floor; Nostr and Blossom mirroring is v1.x and pinner-published only** (section 10). Relays are an untrusted, lossy cache: `OK true` is not a storage receipt, relay lists lose 40-60% of members within months, and no write was ever tested (02 F11, F14, F36).
9. **The two VERIFY passes refuted nothing but returned ten "nuanced" verdicts that change numbers or wording, and the reports found three defects in ARCH v0.2 and one in DR:** the 90-second `scrape` keepalive (ARCH 8), the `0xFFFFFFFF` wire test (ARCH 12 test 11), keeping the previous version after a legal withdrawal (ARCH 5.8), and "`allowScripts` is inert" (DR S7) (section 4.3).
10. **The biggest unknowns need data or a person, not more desk research:** the real relay and stranded-visitor share (answer it with the diagnostics panel), real iOS, Android and Firefox behaviour (untested in every file), Nostr write acceptance (needs an approved test), counsel's answers on consent and hub status, and topic 07 performance.

## 2. Decisions table

Each row is a proposed decision for ARCH v0.3 with its evidence. "Tree" notes come from reading the source on 2026-10-19.

| # | Decision | Evidence | Source file § |
|---|---|---|---|
| D1 | Every production pointer carries `ws=` and `xs=`; "all trackers failed" is a status ("Peers unavailable, loading from the web seed"), never `E_NO_PEERS`. | Loads in 18-85 ms (loopback) under six tracker failure modes with both keys; nothing loads without `xs=`; `xs=` without `ws=` stalls after metadata. ARCH 5.4 already limits `E_NO_PEERS` to pointers with neither key. | 01 F10, R2 |
| D2 | `.torrent` files and snapshots are fetched with a header-free `fetch(url)` and checked by us (`sha1(info) == btih`); web-seed requests carry only `Range`. | WebTorrent 3.0.21 sends `Cache-Control` and `user-agent`; Chromium preflights the first, WebKit also the second; servers with explicit allow-header lists fail (`blossom.jumble.social` failed in Chromium). Tree: `_fetchTorrent` and `fetchSnapshot` are already header-free; cross-origin web-seed requests still carry WebTorrent's headers because the SW never touches cross-origin requests (`src/sw/core.js` routing note). | 02 F30, R1, R2 |
| D3 | Tracker list: own neutral-host tracker(s) first (`rtc.<domain>`), then `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua`, optionally `open.ftorrent.com`; the same list for every peer; never hostnames containing `tracker`, `torrent`, `peer` or `bt`, never free dynamic-DNS suffixes. | 16 of 16 counted soak samples per public tracker; all four on HaGeZi Anti-Piracy, two on BlockListProject "torrent"; a hostname under our own domain is on no list checked. Tree: `CONFIG.trackers` already lists the four live trackers (04V cross-cutting 5). | 01 F1, F2, R1, R6, R7 |
| D4 | Never operate the stock `bittorrent-tracker` server; any tracker we run uses the hardened wrapper with an infohash allow-list. | `offers:[null]` exits the stock 11.2.3 process; no ping; 100 MiB frames accepted; unbounded swarms and backlog; `/stats` blocks the event loop. | 01 F3, R3, Gotchas 1-5 |
| D5 | Tracker keepalive is a zero-offer announce (`numwant: 0`) at most every 55 s, plus a per-instance reconnect shim (500 ms + jitter) and a `kick()` on `visibilitychange`, `pageshow` and `online`; it is not a `scrape` every 90 s. | `tracker.openwebtorrent.com` closes the socket on `scrape`; public trackers close idle sockets after 125-188 s; stock reconnect median 174 s against 1-2 s with the shim. Amends ARCH 8 and `CONFIG.wire.keepaliveScrapeMs`. | 01 F7, R4; 04 F27 |
| D6 | TURN is off in v1. No `turn=`, `turnu=` or `turnp=` in the pointer grammar; if TURN is added later, credentials come from same-origin `/.well-known/mw-ice.json`, after consent, only when the connectivity probe asks for it. | The web seed is the correctness path; relaying a byte costs about as much as serving it from a CDN; pointers are public, cached per DNS TTL, limited to 255-byte strings and need re-signing to rotate. Matches DR section 3 (TURN is "LATER / v2"). | 03 F-26, F-30, R-01, R-07 |
| D7 | Every configuration has at least two STUN servers from different operators and never zero. Keep the tree's Cloudflare + Twilio pair for v1. | Two servers on different IPs make the NAT probe possible; WebKit with zero ICE servers emits no offer at all. `stun.l.google.com` (03's suggested second server) is on BlockListProject "tracking"; Twilio has no AAAA record, so IPv6 classification needs a second AAAA-capable server later. | 03 F-06, F-20, F-24, R-03; 01 F2 |
| D8 | Probe-gate ICE servers, allow at most two TURN URLs, and cut the non-trickle offer timeout to 1.5-2 s (esbuild alias, or an `RTCPeerConnection` subclass installed before the bundle loads). | A blackholed TURN or closed UDP port holds gathering for 39.95 s and a simple-peer offer for 5,003 ms (124 ms with a working TURN). | 03 F-21, R-02, R-04 |
| D9 | No telemetry by default. An optional beacon's endpoint comes only from a build-time constant (absent = no code path), never from a pointer, `<meta>`, fragment or SDK message, and never from or onto the site ledger. | A beacon adds a payload the consent gate does not describe and makes the loader operator the instructing party (EDPB 2/2023 para 34). The default `writers:'owner'` already rejects visitor blocks; on open ledgers reports would be stored forever and fill the 8 MiB cap. | 04 F32, F40, R14; 04V claims 5, 8 |
| D10 | Diagnostics instrument at the platform boundary: constructor wrappers for `WebSocket` and `RTCPeerConnection` in `boot.js` before the WebTorrent import, prototype hooks as a fallback, `fetch` traffic seen through Resource Timing or the SW, and an "instrumentation blind" self-test. | Wrappers installed after the import saw 0 sockets and 0 PCs; prototype hooks installed after it saw 1 and 11; the bundle also captures `self.fetch` at module init. | 04 F4, R1; 04V claim 2 |
| D11 | Canaries run on GitHub Actions with a Healthchecks.io dead-man's switch; the grace period for the 30-minute probe is at least 60 min. | Scheduled runs started 5-60 min late with outliers up to 238 min; schedules auto-disable after 60 days without repository activity; only the missing success ping (or a second scheduler) catches a silent stop. | 04 F20, F24, R4; 04V claim 3 |
| D12 | The static host stays the declared trust root. No "integrity verified" badge; a pointer-bound release manifest (`rel=`) plus an external canary is detection, called a consistency check. | A host can tell `<script>`, `import()`, page `fetch()` and the SW update fetch apart by `Sec-Fetch-*` headers and cloak; there is no SRI for SW scripts; WAICT and Isolated Web Apps are not shippable to consumers in 2026. | 05 F1, F2, F4, F9, R1(c), R10 |
| D13 | Reserve `st` in the v1 pointer grammar before the first release: absent or `ok` = active; any other value (canonical: `withdrawn`) = stop, purge every stored version of the scope, stop seeding (fail closed). A withdrawal record also sets `btih` to 40 zeros so loaders that predate `st` fail closed, and may carry `why` and `ct`. Only a signed record from the pinned owner (or with a valid `rot`) with a higher `seq` sets or clears it. | Loaders already in caches cannot learn new semantics later; a zero `btih` leaves old loaders nothing to fetch once the higher `seq` has superseded their cache. Token `ok` (05) wins over `active` (06): with "unknown = stop", the active token is a compatibility promise and must be unique. | 05 R6, 3.2, 3.3; 06 R2, B9 |
| D14 | Unknown `alg` = invalid signature. Hardware signing is `alg=sshsig-es256` (OpenSSH `ssh-keygen -Y sign`, checked by a ~50-line WebCrypto verifier); plain ECDSA P-256 stays the default; WebAuthn PRF is never the root identity. | Real SSHSIG and WebAuthn ES256 signatures verified with WebCrypto; WebAuthn Level 3 is a Recommendation (2026-08-25) but PRF support is uneven and vendor-measured; the `sign` extension is an unmerged draft. | 05 F10-F14, R7, R14 |
| D15 | Service Worker: the critical precache (index, boot, loader, sdk, core) installs atomically with `Request.integrity` (HTML best-effort); every navigation falls back to `fetch()` and then an offline page; the deploy checker asserts `/mw-sw.js` answers 200 with no redirect, a JavaScript MIME type and `no-cache`. | A redirect, an HTML fallback or a stale edge silently keeps the previous (possibly hostile) worker; a rejecting navigation handler bricks navigations until a fixed worker installs. | 05 F25-F27, R2, R3, Gotchas 5-7 |
| D16 | Keep the 256 KiB wire message cap, read the length unsigned, fail closed if the patch point disappears, and test with both `0x7FFFFFFF` and `0xFFFFFFFF`. | `bittorrent-protocol` 5.0.9 buffers announced lengths up to `0x7FFFFFFF` (128 MiB of 16 KiB writes took 44.6-76.6 s and 8.4-8.5 GiB RSS in Node) and reads `0xFFFFFFFF` as a keep-alive, so ARCH 12 test 11 as written would not notice a broken cap. | 05 F41, R1(b), R5 |
| D17 | Supply chain: npm >= 11.19 with `allowScripts` (a working default-deny), `ignore-scripts=true`, `min-release-age=7`, `save-exact`, and `npm audit signatures` in CI. | A planted `postinstall` was blocked by default; 36 of 177 production packages have provenance and `@thaunknown/simple-peer` is not among them; `webtorrent@3.0.21` has SLSA provenance but no committed lockfile, so it is attested, not reproducible. Tree: `.npmrc` has `ignore-scripts=true` only. | 05 F34-F37, R9, R12 |
| D18 | Consent: whenever a web seed exists the first-run card offers `[Share and load]` and `[Load from host only]` on the same layer; the choice is stored as `{consentVersion, choice, day, scope}` and re-asked when text, recipients or retention change; `consent=gate` is the documented default for sites with personal data or an EEA, UK or Quebec audience; a CMP bridge (`data-mw-consent="external"`); no tracker socket, peer connection, relay or blob-host request before a choice. | Today's notice has `[Settings] [OK]` and no refusal on the same layer. EDPB 2/2023 brings tracker WebSockets and peer connections into the Art. 5(3) analysis (paras 24-25, 33-34, 42); applying it to SW storage and peer upload is our inference. Behaviour comes from 06; the final strings belong to the DR editor (4.3, C18). | 06 R1, F15-F21; 04V claim 7; 06V claim 8 |
| D19 | Hub: the apex serves the gate only; no directory, search or "recent sites"; allowlist mode by default; the shared-origin hub is refused on public hostnames by a build flag; per-site registrable domains (per-domain or drop-in mode) or several hub apex domains are the structural reputation defence; a PSL entry is for cookie and storage isolation only. | Ziggo: indexing plus a search engine is a communication to the public; Safe Browsing strips the fragment, so one listing of the hub's domain covers every label; Chromium and Firefox ignore private PSL entries when building lookups. | 06 R4, F5, F11; 06V claim 7 (E9, E11) |
| D20 | Before a public hub: a client denylist, signed (P-256), with monotonic `seq` and `exp`, entries keyed by hashed `btih`, host, label and per-file SHA-256, enforced before network I/O and before serve, upload and render; a failed fetch keeps the last good list and never blocks an unlisted site. | Re-packing changes the infohash, so the per-file hash is the second key; WebTorrent does not implement BEP 52's per-file root, so the separate per-file SHA-256 stays. | 06 R3, F10; 06V claim 6 (E8) |
| D21 | Nostr relays and Blossom servers are an optional, untrusted cache behind peer gossip and the host snapshot: dedicated event kinds (never 30078 or 78); the ledger keeps its P-256 keys and blocks travel inside events signed by throw-away secp256k1 keys; timing per section 10. | WebCrypto has no secp256k1; JS Schnorr verification is 15-30x slower than WebCrypto P-256 (9-21 s for a ledger at the 8 MiB cap); NIP-78 is private app data that relays SHOULD gate behind AUTH. | 02 Summary 1, 6, 7; F16-F19; R3 |
| D22 | No Trystero and no Nostr signaling in v1.0; a second discovery plane, if built, is an own minimal client, off by default, after consent (v2, as DR section 3 already says). | Trystero's Nostr strategy is 27.7 KB gzip, its default SDP key is derivable by relay operators, and its shipped relay lists keep only 38-58% of members over months; the neutral-host tracker (D3) already answers DNS block lists. Feasibility is shown: 11 of 12 relays passed an ephemeral round trip. | 02 F11, F24, F26, R13; 01 F8 |
| D23 | Observability v1 is Plan Z; Plan W (one Worker) is P2, opt-in, run by whoever deploys the loader. | Plan Z answers "is it up", "is anyone seeding", "does a cold load work" and "why can't this visitor load"; Plan W only adds field data that no canary sees. | 04 "The two plans", decision table |
| D24 | Health signals: a `status.json` signed with a canary key (never the owner key) on GitHub Pages or the web seed, advisory only; no DNS health record; on the ledger at most a reserved `_health` key written by a pin-node moderator key (P3). | GitHub Pages answers with `access-control-allow-origin: *`; a TXT record needs DNS-API credentials in CI and costs every visitor a DoH query; `_`-prefixed keys are owner and moderator only (ARCH 6.5). | 04 F41-F44, R17, R18; 04V claim 5 |
| D25 | Anyone who runs a hub or hosts third-party bytes registers a DMCA agent and runs `abuse@`, `dmca@`, `privacy@`, `security@` and `/.well-known/security.txt` before launch; a code-only maintainer does it later (P2). | DMCA s.512 relief needs a designated agent; RFC 2142 requires `abuse@`; DSA Arts. 11-14 and 16-18 still apply to micro and small providers. | 06 R5; 06V claim 2 |

## 3. Prioritised recommendations (merged and deduplicated)

**Tiers.** P0 = blocks the first production release (per-domain and drop-in sites). P0-hub = additionally blocks running a public hub or hosting third-party bytes. P1 = needed for a credible launch and sustained operation. P2 = first quarter in production. P3 = optional, or only on evidence. The six reports use slightly different P0 triggers (05 and 06 tie P0 to "the first public release or the migrate-your-site launch"); this digest maps them onto the tiers above.

**Effort.** Letters are copied from the source; where merged items disagree the larger one is kept. The scales differ a little by file (S = under one or two days, M = one day to two weeks, L = more). "Tree" notes record what already exists in the source as read on 2026-10-19.

### 3.1 P0

| ID | What to build or change | Effort | Justifying file | Merged from, tree status |
|---|---|---|---|---|
| P0-1 | `ws=` and `xs=` mandatory in production pointers (`publish.mjs`, `pointer.js` `magnetFromRecord`, DEPLOY); web-seed CORS: `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: *` (an explicit list must name `range`, `cache-control` and `user-agent`, C21), `Expose-Headers: Content-Range, Content-Length, Accept-Ranges`; status "Peers unavailable, loading from the web seed"; add 01's degrade scenarios to the e2e suite. | S | 01 F10 | 01 R2. Tree: `publish.mjs` already emits S3 CORS with `AllowedHeaders: *`. |
| P0-2 | `Range`-only web-seed requests: a replacement `WebConn`, or a Service Worker route that re-issues cross-origin web-seed fetches (today the SW leaves every cross-origin request alone). | S | 02 F30 | 02 R1, R2. Tree: header-free `.torrent` and snapshot fetches already exist; `check-webseed.mjs` already preflights `cache-control, range, user-agent`. |
| P0-3 | Tracker client shim (`tracker-shim.js`): per-instance reconnect override (500 ms + U(0, min(60 s, 1 s x 2^retries))), `numwant: 0` keepalive announce at most every 55 s replacing the `scrape` keepalive, `kick()` on `visibilitychange`, `pageshow`, `online`; pin `webtorrent@3.0.21`; keep `e2e/reconnect.mjs` as the regression test. | M | 01 F7 | 01 R4; amends ARCH 8 (C2). Tree: `torrent.js` switches a tracker to zero-offer announces only after a `scrape` has closed its socket once. |
| P0-4 | Any tracker we operate runs the hardened wrapper: message validation, `maxPayload` 64 KiB, offers <= 10, SDP <= 16 KiB, one `peer_id` per socket, per-IP quotas, 256 KiB output backlog per socket, server ping every 30 s, allow-list or explicit `OPEN=1`, Origin allow-list, metrics, SIGTERM drain. | S-M | 01 F3 | 01 R3. Tree: `tools/tracker.mjs` validates offers, caps payload at 128 KiB and refuses to start without `--allow` or `--open`; it has no ping, backlog cap, per-IP quota or metrics. |
| P0-5 | Release gate on tracker health: a CI announce probe against the default list that fails when fewer than 3 trackers pass while online. | S | 04 F27 | 04 R7; 01 R1. Tree: dead entries already removed; no CI workflow exists yet (`.github/` holds templates and Dependabot only). |
| P0-6 | ICE hygiene: TURN off (`ice.turn = []`); at least two STUN servers from different operators, never zero; probe-before-use; at most two TURN URLs if any; non-trickle offer timeout 1.5-2 s. | M | 03 F-21, F-24 | 03 R-01, R-02, R-03 |
| P0-7 | Boot-time connectivity probe `src/loader/connectivity.js`: one throw-away PC, two STUN URLs, 2.5 s budget, in parallel with pointer resolution, never blocks rendering; classes `easy-mapping`, `easy-probable`, `hard`, `udp-blocked-or-no-stun`, `relay-only-reachable`, `unknown-single-stun`, `no-webrtc`. | M | 03 F-20 | 03 R-04 |
| P0-8 | `diag.js`: boundary wrappers (D10), PC classification (only `negotiating -> failed` counts as an ICE failure), `performance.mark` timeline, diagnosis rows evaluated at 3 s and 5 s; exportable redacted bundle `mw-diag/1` (<= 64 KiB) plus a last-session summary written on `visibilitychange`. | M | 04 F1-F10 | 04 R1, R2; 04V claim 2; DR S5 |
| P0-9 | One probe library for publisher preflight, CI canary and `health.html`: extend `tools/check-site.mjs` with piece SHA-1 sampling, STUN binding (skippable), `swarm.seeders` (seeders on >= 2 trackers; `scrape` informational only), torrent and pointer consistency, JSON status output, and the SW deploy contract (200, no redirect, JavaScript MIME, `no-cache`, byte equality across two resolutions; CloudFront minimum TTL 0; invalidation step). | M | 04 F20-F29; 05 F25, F26 | 04 R3 (`verify.mjs`); 05 R2; DR S13. Tree: `check-site.mjs` already checks the page and SRI, the meta and DNS pointer, `xs`, `ws` OPTIONS and Range, a tracker announce plus `scrape`, `cs`, and an optional headless render: extend it, do not fork it. |
| P0-10 | Probe canary on GitHub Actions every 30 min at non-round minutes, Healthchecks start, success and fail pings with grace >= 60 min, `status.json` committed only when it changes, one Issue after two failed runs. | S | 04 F20-F24 | 04 R4; 04V claim 3. Sketch in 8.2. |
| P0-11 | Pin-node heartbeat to Healthchecks every 60 s (period 2 min, grace 5 min; `/fail` on crash, disconnect, `renderOk === false` or `seeding === false`) and the independent `swarm.seeders` alarm. | S | 04 F24, F28 | 04 R6. Tree: `pin.mjs` logs status every 60 s but sends no heartbeat. Deployment in 7.2. |
| P0-12 | Correct three statements: `allowScripts` is a working default-deny (DR S7, `docs/review/security.md` M10); the wire test uses `0x7FFFFFFF` as well as `0xFFFFFFFF` (ARCH 12 test 11, `security.md` B4); README and CRITIQUE say that a page cannot verify itself and that the SW gives consistency and offline use, not protection from a hostile host. | S | 05 F1, F34, F41 | 05 R1 |
| P0-13 | Atomic SW install (`Request.integrity` for the critical JS and CSS; HTML best-effort because some hosts rewrite it) and fail-open navigation (`fetch(request)`, then an offline page); delete the half-filled cache when an install fails. | S-M | 05 F25, F27 | 05 R3 |
| P0-14 | Kill-switch runbook with measured numbers (deploy `mw-sw-kill.js` as `/mw-sw.js`, purge the CDN, the first navigation is still broken and the page is healthy about 3 s later in Chromium, tell people to wait rather than reload repeatedly); `Clear-Site-Data: "storage"` as the documented last resort, stating that it deletes ledger identity keys, pins and caches; a drill every release. | S | 05 F20, F21, F24 | 05 R4, R18; 06 R13 (drill) |
| P0-15 | Wire cap hardening: read the length unsigned, destroy the wire and show a debug-panel error if `_onMessageLength` is missing at runtime, unit-test against the real bundle, keep `wire-length-regress.mjs` as a regression test; prepare the upstream patch (sending it needs Ash, 6.3). | S | 05 F39-F42 | 05 R5 |
| P0-16 | Pointer grammar before the first release: `st` (D13), `ct` (abuse and legal contact), `lg` (privacy and terms page), `aud` (`general`, `kids`, `sensitive`), `why` on withdrawals; `publish.mjs --withdraw`; on a withdrawal or a denylist hit keep no stored version (amends ARCH 5.8). | M | 05 F22, F23; 06 section 4 (levels L0, L2) | 05 R6; 06 R2 |
| P0-17 | Consent per D18: same-layer refusal, versioned consent record, re-ask on change, CMP bridge, `consent=gate` documented default for personal data or EEA, UK or Quebec audiences; no region inference from the browser. | M | 06 F15-F21 | 06 R1; 04V cross-cutting 4 |
| P0-18 | Privacy package `docs/PRIVACY.md`: controller per deployment type, purposes and bases, a recipients register (static host, web-seed host, trackers, STUN, DoH resolvers, other visitors; TURN operator, relays and blob hosts when enabled), retention, rights, breach contacts, children; DPIA for hubs and larger owners; Quebec PIA when Quebec residents are served. Template in 9.2. | M | 06 F18, F21 | 06 R6, R16; 02 R10; 03 R-09 |
| P0-19 | Notice-and-action runbook `docs/ABUSE-RUNBOOK.md` (06 Appendix A), `/report` intake, case log, statement-of-reasons template, and a takedown drill in the ARCH 12 release gate: time from a test notice to (a) denylist published, (b) a running loader stops seeding, (c) the hub gate refusing; targets: P0-class notices under 60 min, P2-class under 24 h. Per-domain owners measure (b) through a withdrawal; (a) and (c) apply once a hub exists. | M | 06 F27, F31 | 06 R7 |
| P0-20 | "Owner duties" section in DEPLOY.md (publisher, controller, UK OSA provider with open writing, no personal data in keys or values, moderation policy, `ct=`, owner key off browsers, how to withdraw); `publish.mjs` warns on `writers:'open'` without `ct`. | S | 06 F9, F19 | 06 R8 |

### 3.2 P0-hub

| ID | What to build or change | Effort | Justifying file | Merged from |
|---|---|---|---|---|
| H-1 | Signed, double-hashed client denylist (D20) with governance: every entry has a `ref`, host-level entries need a second reviewer, every change is logged; no CSAM content hashes in public lists. | L | 06 F10, F28 | 06 R3; 06V claim 6 |
| H-2 | Hub hardening (D19), a "Report this site" link in the hub banner, Search Console and Safe Browsing monitoring, a `--demo-hub` build flag that refuses the shared-origin hub on anything but localhost and RFC 1918 addresses. | M | 06 F5, F11 | 06 R4 with 06V E9, E11 |
| H-3 | Operator registrations and mailboxes: DMCA designated agent, `abuse@`, `dmca@`, `privacy@`, `security@`, `security.txt`; EU legal representative, GDPR Art. 27 representative and TCO contact point when they apply. | S | 06 F2, F3, F30 | 06 R5 (P2 for a code-only maintainer) |

### 3.3 P1

| ID | What | Effort | Justifying file | Merged from |
|---|---|---|---|---|
| P1-1 | Count-aware probe-then-offer announce policy (`numwant: 0` first; 3 offers only while connected peers < min(2, others reported)); at most 4-5 trackers. | S-M | 01 F7 | 01 R5 |
| P1-2 | Own tracker on a neutral hostname (7.1), first in `tr=`; optional second tracker on Cloudflare Durable Objects for a separate failure domain; `ALLOW_FILE` in production. | M | 01 F2-F6 | 01 R6 |
| P1-3 | Daily CI check of every default hostname against browser and DNS block lists; fail on any hit. | S | 01 F2 | 01 R7 |
| P1-4 | Monitoring of any tracker we run: Prometheus rules, external announce-and-relay probe every 5-10 min with a heartbeat, web-seed Range and CORS probe. | S-M | 01 F9 | 01 R8; uses the P0-9 library |
| P1-5 | One or two always-on seeders with public addresses at different providers (pin nodes, 7.2); confirm with the probe that they classify as "easy" and log the share of connections they serve. | M | 03 F-03, F-04, F-19 | 03 R-11; 04 R6 |
| P1-6 | Connectivity fields in the panel and bundle: `net.cls`, IPv6 srflx, STUN and TURN state, selected pairs by candidate type (never remote IPs), the offer-to-first-piece funnel, a failure taxonomy; visitor strings "Direct", "Relayed", "Web seed only". | M | 03 F-34 | 03 R-10; 04 R1, R2, R8 |
| P1-7 | Hourly Playwright E2E canary reading the diagnostics snapshot: web-seed-only cold start, warm repeat, peers-only against the pin node, offline reload, two-context ledger write. | M | 04 F20-F22 | 04 R5 |
| P1-8 | Local-first RUM and Settings > Diagnostics: time-to-site-visible by source, time-to-first-wire, offload ratio, 30-day aggregates in IndexedDB; no `web-vitals` in the loader (it cannot see the iframe); an opt-in `mw.vitals` inside the site frame later. | M | 04 F13 | 04 R8; 04V claim 4 |
| P1-9 | SW miss ring as migration help: "Requests your site made that the torrent cannot answer" (`api`, `asset`, `font`, `map`); `Server-Timing` on synthesized responses. | S-M | 04 F14 | 04 R9 |
| P1-10 | Error reporter with a closed vocabulary and 8-hex fingerprints; local only unless Plan W is opted into. | S | 04 F12 | 04 R10 |
| P1-11 | `health.html`: the visitor-run checker (tracker announce, STUN srflx, DoH quorum, web-seed Range and CORS, SW and storage state) with "Copy bundle". | S-M | 04 F18, F29 | 04 R11 |
| P1-12 | `docs/OPERATIONS.md`: alert policy, SLO proposals, one-line runbooks, and the egress allow-list test as the primary proof of "no analytics" (8.4). | S | 04 F38, F40 | 04 R12; 04V claim 8 |
| P1-13 | Publish gate and rollback: `publish.mjs --verify` runs the probe library against the staged site before DNS changes and prints the exact rollback (re-publish the previous signed `seq`). | S | 04 F20-F23 | 04 R13 |
| P1-14 | Hardware-backed owner signing: `alg=sshsig-es256` and `alg=sk-es256`, `tools/sign-pointer.mjs` around `ssh-keygen -Y sign`, `keygen.mjs --sk`, test vectors from real OpenSSH output; a hardware test on the owner's Token2 key before any DEPLOY claim (needs Ash). | M | 05 F12-F14 | 05 R7 |
| P1-15 | Rotation and recovery: `rot` countersigned by the new key, `nk` pre-rotation commitment, a visible "pending key change" hold-down for DNS-only key changes (length is Ash's decision, 6.3). | M | 05 F16, F19 | 05 R8 |
| P1-16 | Supply-chain configuration and CI tripwires per D17, plus `npm install-scripts ls` compared with a committed set and the `build.lock.json` check. | S | 05 F33-F35 | 05 R9 |
| P1-17 | Release manifest `dist/release.json` in WAICT shape bound to the pointer by `rel=`; an external canary from at least two networks sending browser-like `Sec-Fetch-Dest: script` and `Service-Worker: script`. | M | 05 F1, F4 | 05 R10 |
| P1-18 | Header and CSP hygiene: SW-added `Permissions-Policy`; header allow-list for `/.mw/site.json`; import-map `integrity` for the WebTorrent bundle (not together with `Integrity-Policy` while Safari 26 blocks it); Trusted Types report-only trial. | S-M | 05 F2, F3, F7, F28-F32 | 05 R11 (P1-P2) |
| P1-19 | Signed, attested releases of magnet-web itself (GitHub artifact attestations, maintainer-signed `SHA256SUMS`, `build.lock.json` with sha256 and sha384 of the vendored bundle). | M | 05 F36-F38 | 05 R12 (P1-P2) |
| P1-20 | Cross-engine CI for the SW probes and the E2E canary (Firefox, WebKit), results in `docs/DEMO-RESULTS.md`. | S | 05 F20, F24, F25, F32 | 05 R17; 04 R16 (P2 part) |
| P1-21 | Legal operations set: Canada notice-and-notice forwarder; CSAM, terrorist-content and imminent-harm playbook with a one-hour path; moderator console with sealed (encrypted) reports; transparency page; infrastructure separation and vendor register; audience flags (`aud=kids` forces host-only); legal migration checklist for existing sites. | S to M each | 06 F8, F13, F24-F28, F32 | 06 R9-R15 (R16, recipients, is in P0-18; R13's drill is in P0-14) |
| P1-22 | Ledger durability v1.x set, in the order of section 10: Blossom upload with repeatable `xs=` and `cs=`, weekly blob keep-alive, then (after the approved write test) dedicated kinds, pointer fields `np` and `rl`, relay list management, pinner mirror mode, the client read path, disclosure text and relay and blob checks in `check-site.mjs`. | S to M each | 02 F11, F14, F23, F29, F30, F36 | 02 R3-R11, R14. 02 ranks R3 (kinds) P0; it moves to P1 here because nothing publishes to relays before it. |
| P1-23 | TURN tier, **only if P1-6 shows stranded visitors matter**: NAT-adaptive TURN with late binding through one shared `rtcConfig`; relayed peers carry the control plane only (bulk from the web seed); credentials from `/.well-known/mw-ice.json`; a budget fuse that revokes credentials on breach; written confirmation from the vendor that relaying data-channel traffic for website delivery is allowed (needs Ash). | M each | 03 F-09, F-22, F-26, F-29 | 03 R-05 to R-09 (P1 in 03, gated by its own "next actions" step 7) |

### 3.4 P2

| ID | What | Effort | Justifying file | Merged from |
|---|---|---|---|---|
| P2-1 | Boot-time tracker probe (parallel `numwant: 0` announce, 3 s timeout) with per-tracker status in the panel; a `trackers-version` in the pointer so list changes are signed updates. | S | 01 F1, F9 | 01 R10, R11 |
| P2-2 | Courtesy contact with the four public tracker operators (load, abuse contact, possible sponsorship); outbound, needs Ash. | S | 01 F1 | 01 R12 |
| P2-3 | Explicit chunk store on WebKit: the default OPFS store failed with `UnknownError` on the first web-seed piece in Playwright WebKit 27.2. | M | 01 F10 | 01 R13 |
| P2-4 | Guarded relay-only privacy mode; connectivity CI with a real coturn in network namespaces; real-device checks; a self-hosted coturn profile (>= 4.18.0, hardening block, egress firewall). | S to M | 03 F-17, F-18, F-25 | 03 R-12 to R-15 |
| P2-5 | Plan W opt-in telemetry (8.3): build-time switch, closed schema, delta counters, same-origin `/_t` collector, public summary with k >= 20. | M | 04 F16-F19, F35-F37 | 04 R14 |
| P2-6 | CDN-log variant for AWS-style hosts; a quarterly real-device run (iOS Safari, Android Chrome, Samsung Internet, Brave) using `health.html` bundles; signed `status.json` optionally read by the loader (`ck=` key, a placeholder name). | S, M, M | 04 F39, F41 | 04 R15-R17 (R16's cross-engine CI is in P1-20) |
| P2-7 | k-of-n owner signatures as a list (not FROST); `alg=webauthn-es256` for passkey-only owners; unsigned-link hardening; optional freshness key `fk=`. | M, M, S, S | 05 F15-F18, F43 | 05 R13-R16 |
| P2-8 | "What this device shares" panel; append-only moderation audit log with statements of reasons; counsel package, operating entity and insurance; ToS role clauses; jurisdiction decisions. | M to S | 06 F6, F9, F21 | 06 R17-R21 |
| P2-9 | Negentropy (NIP-77) for returning visitors and pinner repair, lazy-loaded. | M | 02 F22 | 02 R12 |

### 3.5 P3

| ID | What | Effort | Justifying file | Merged from |
|---|---|---|---|---|
| P3-1 | Other tracker engines (`aquatic_ws`, `wt-tracker-rust`) only above about 20k sockets per host; upstream fixes to `bittorrent-tracker` (needs Ash for the outbound part). | S | 01 F3 | 01 R14, R15 |
| P3-2 | NAT-aware peer preference; connectivity watch list. | M, S | 03 F-03 | 03 R-16, R-17 |
| P3-3 | Reserved `_health` key on the ledger written by a pin-node moderator key; local DP or DAP only on evidence; CloudWatch Synthetics profile for AWS-hosted sites. | M, L, S | 04 F30, F34, F44 | 04 R18-R20; 04V claims 5, 6 |
| P3-4 | Navigation preload; an own reproducible WebTorrent bundle if upstream stays unreproducible; security watch list. | S, L, S | 05 F27, F36 | 05 R19-R21 |
| P3-5 | Legal watch list; optional PDQ perceptual-hash check; counter-notice and appeals tooling. | S, M, S | 06 F25, F28 | 06 R22-R24 |
| P3-6 | Nostr signaling plane (own client, default off; v2 per D22); visitor publishing to relays (v2, open ledgers only); nsite export; blob-seed adapter for multi-file torrents; owner-run relay recipe; native secp256k1 identity. | M to L | 02 F24-F26, F31, F32 | 02 R7 (publishing part), R13, R15-R18; 01 R9. 02 ranks R13 P2 and 01 ranks R9 P1; both move to v2 per D22 and DR section 3. |

## 4. Verified versus nuanced or refuted claims

Neither VERIFY pass refuted a claim as a whole. Ten claims came back "nuanced": true in substance, with a number, quote or inference that must change. Files 01, 02, 03 and 05 have no VERIFY pass; their measured claims carry the confidence their authors gave them, and section 4.3 records where later evidence overrides them.

### 4.1 `w2b-04-observability-no-backend-VERIFY.md` (04V)

| # | Claim in 04 | Verdict | Correction | What it changes here |
|---|---|---|---|---|
| 1 | Page scripts cannot see why a WebSocket failed (F6) | confirmed | The spec quote was trimmed (seven situations, "in preparation for an attack"); a Playwright or CDP harness in the same engine can read the reason; locally decided failures (CSP, malformed URL) are visible; timing is only a weak hint; `WebSocketStream` is no better. | The Node probe (P0-9) and the browser canary (P1-7) are complementary, not redundant. |
| 2 | Wrappers must be installed before `import()` of WebTorrent (F4) | nuanced | Only constructor-replacing wrappers must precede the import; prototype hooks installed afterwards saw 1 WebSocket and 11 PCs (with lower timing fidelity); the bundle also captures `self.fetch` at init (web-seed and `xs=` traffic); the shipped asset path is `/_mw/webtorrent.min.js`. | D10; P0-8 adds the prototype fallback, a `fetch` view and a self-test. |
| 3 | GitHub Actions `schedule` semantics (F20) | nuanced | "Odd minutes" is not in the docs; observed lateness median 5-16 min, maximum 35-238 min, no missed slot in 450; notifications go to the workflow's current actor (creator, last cron editor, re-enabler or default-branch changer); schedules also stop when that actor is deprovisioned by an EMU identity provider; "only reliable alarm" is too strong (a second scheduler also works). | D11: Healthchecks grace >= 60 min for the 30-minute probe. |
| 4 | Web Vitals libraries cannot see inside the iframe (F13) | confirmed | Addition: a sub-frame can report to its parent; cross-origin frames cannot be measured from outside. | P1-8 (opt-in `mw.vitals` runs inside the site frame). |
| 5 | Visitor telemetry must not ride on the site ledger (F32) | nuanced | 04 used superseded ARCH v0.1 constants. v0.2: 16 PoW bits, an 8 MiB `maxChainBytes` cap (replacing the 50,000-block cap) and default `writers:'owner'`, which rejects visitor blocks outright. An honest 16-bit mint of a real 394-528 B header takes 39-49 ms with 5 Workers on an M3 in Chromium 156 (not 1.2 ms); a native attacker needs 56.8 ms per 16-bit block, so filling 8 MiB takes about 13 min on one core; phone figures are unmeasured. A `_health` aggregate should be a reserved key written by a pin-node moderator key. | D9 stands on stronger grounds; D24; latency anchors in section 11. |
| 6 | DAP/Prio is not a finished standard (F34) | confirmed | The VDAF layer is also unfinished (draft rev 22, IRSG review); Janus and `divviup-ts` are maintained; the second aggregator may be a partner. | P3-3 unchanged. |
| 7 | EDPB 2/2023 paras 53 and 55 make opt-in the default for any beacon (F36) | nuanced | Quotes and numbering are exact, but the EDPB says consent is not systematically required (paras 40, 56); CNIL exempts strictly limited, anonymous audience and performance measurement (about 13-month tracker life, at most 25-month retention); the Digital Omnibus proposal (a new GDPR Art. 88a) is still in committee; paras 24-25, 33-34 and 42 put tracker WebSockets and peer connections themselves in scope. | Opt-in stays the conservative engineering default for Plan W; D18 (consent before the first announce is load-bearing). |
| 8 | The telemetry endpoint must come only from build config (F40) | nuanced | Pointers already name publisher-chosen endpoints (`tr`, `ws`, `xs`, `cs`), so the "tracking-pixel vector" rationale overstates; the better grounds are an undescribed payload and the loader operator becoming the instructing party (EDPB para 34); ARCH 4 says unknown keys are "kept (and signed)", not "ignored"; "0 `sendBeacon`" cannot prove "no egress"; `config.js` is a frozen runtime module, so build-time elimination needs an esbuild `--define` constant, which does not exist yet. | D9; the egress allow-list test becomes the primary assertion (P1-12, 8.4). |

Cross-cutting findings of 04V that this digest adopts: (1) the stale ledger constants also appear in `w2c-05-testing-qa-production.md` line 28 ("the default 14-bit hashcash"), outside this digest's scope, flagged for that file's owner; (2) three init-time captures (`RTCPeerConnection`, `WebSocket`, `fetch`), not two; (3) a real browser harness sees failure reasons the page cannot; (4) EDPB scope covers the peer-to-peer core, not only a beacon; (5) the dead-tracker defect in `config.js` was already fixed.

### 4.2 `w2b-06-abuse-legal-ops-VERIFY.md` (06V)

| # | Claim in 06 | Verdict | Correction | What it changes here |
|---|---|---|---|---|
| 1 | US contributory liability needs intent (Cox v. Sony, 2026-03-25, No. 24-171) | confirmed | "Risk shifts to direct and vicarious theories" is inference; cite the Supreme Court PDF (the FindLaw copy sits behind a Cloudflare challenge); the Sotomayor concurrence notes exposure remains for services designed or promoted as infringement-friendly. | Neutral marketing and examples are a legal control (5.3). |
| 2 | DSA relief for micro and small providers is partial | confirmed | Art. 19(1) keeps Art. 24(3); Art. 17 statements of reasons apply only where contact details are known (Art. 17(2)); Art. 18 is limited to threats to life or safety; the first harmonised transparency cycle is calendar 2026, report due by 2027-02-28. | H-3, P1-21 dates. |
| 3 | CJEU Ziggo (2017) and YouTube/Cyando (2021) | confirmed | Ziggo is fact-bound; Cyando expressly excludes Art. 17 of Directive 2019/790; GS Media (profit-motivated links, knowledge presumed) is the closer analogue for a pointer hub. | D19 (no directory, search or curation at the hub). |
| 4 | Mircom (C-597/19): seeding is "making available"; being "duly informed" makes it deliberate; no safe harbour for end users | nuanced | The "deliberate" holding is conditional on informed, active subscription and left to the national court; "no safe harbour for end users" is not in the judgment (inference). | The consent card still informs visitors (D18); bound what browsers seed rather than hide it. |
| 5 | Canada: notice-and-notice, hosting carve-out, "enabler offence" | nuanced | s.27(2.3) is a civil infringement, not an offence; s.31.1(6) also removes hosting protection; s.41.26 duties do not bind information location tools (s.41.27: injunction-only relief, 30-day window); enabler damages are deemed commercial ($500-$20,000 per work, s.38.1(1.11)); the $100-$5,000 band is for non-commercial infringers such as visitors. | P1-21 Canada forwarder; wording in 5.3. |
| 6 | Hash denylists (Kubo/NOpfs, USENIX 2024 IPFS study) | nuanced | Listed public gateways blocked about 54% (Fig. 18, read by eye, +/- 2 points), not "under 20%"; the 97.4% figure came from a 100-CID phishing sample; BEP 52 defines a re-pack-stable per-file root but WebTorrent does not implement it; Kubo's maintainers prefer an allowlist where the content set is known. | D20 keeps the separate per-file SHA-256 key; hub allowlist mode by default (D19). |
| 7 | Safe Browsing strips the fragment and matches host suffix and path prefix; PSL effect untested | nuanced | The cited page documents the deprecated v4 API; v5 builds the host chain from the eTLD+1; Chromium (`EXCLUDE_PRIVATE_REGISTRIES`) and Firefox do not use private PSL entries, so PSL-listing the hub apex does not stop a parent listing from matching every label; the PSL also declines "workaround" entries and small projects. | D19: structural defence is per-site registrable domains or several hub apexes; PSL only for storage isolation. |
| 8 | EDPB 2/2023 covers SW cache, IndexedDB and upload of stored pieces "in terms" | nuanced | Every quote verifies, but the guidelines never name Service Workers, Cache Storage, IndexedDB, WebRTC or P2P (0 hits); applying paras 36-38, 44 and 53 to them is our inference; para 25 brings ad-hoc networks of as few as two peers into scope. | D18 text says "our reading", not "the EDPB says". |

06V's edits E1-E11 (its section 11) are adopted wherever this digest repeats the affected statement.

### 4.3 Contradictions between files, ARCH and the tree, and which wins

| # | Topic | Position A | Position B | Winner and action |
|---|---|---|---|---|
| C1 | Dead trackers in `config.js` | 01 F1/R1 and 04 F5/R7: `CONFIG.trackers` still lists `tracker.btorrent.xyz` and `tracker.files.fm:7073` | 04V cross-cutting 5: already fixed | Tree (2026-10-19): the four live public trackers are listed. Remaining work: own tracker first (P1-2) and the CI gate (P0-5). |
| C2 | Tracker keepalive | ARCH 8 and `CONFIG.wire.keepaliveScrapeMs` = 90000: a `scrape` every 90 s | 01 F7/R4 and 04 F27: `scrape` makes `tracker.openwebtorrent.com` close the socket; keepalive must be a `numwant: 0` announce at most every 55 s | 01 (measured). Amend ARCH 8. Tree: `torrent.js` learns per tracker and switches to zero-offer announces after a scrape-close, so the residual cost is one forced disconnect per such tracker per engine instance, followed by the stock reconnect delay (10 s + U(0, 5 min), 01 runbook item 6) until P0-3 lands. |
| C3 | Ledger constants | 04 F32 and Summary 6: 14 bits, 50,000-block cap, open writers, 1.2 ms mint | 04V claim 5 and ARCH v0.2 6.1: 16 bits, 8 MiB `maxChainBytes`, `writers:'owner'`, 39-49 ms mint | ARCH v0.2 and 04V. |
| C4 | Instrumentation order | 04 F4: wrappers "must" precede the import | 04V claim 2: only constructor wrappers must; prototype hooks work late; `fetch` is a third capture | 04V (D10). |
| C5 | Cron cadence and alarm | 04 F20 and R4: "odd minutes", "the only reliable alarm", grace 15 min | 04V claim 3: lateness 5-60 min with multi-hour outliers; grace >= 60 min; a second scheduler is also reliable | 04V (D11). |
| C6 | Basis for an opt-in beacon | 04 F36: "opt-in consent is therefore the safe default" | 04V claim 7: the EDPB leaves exemptions case by case; CNIL has an exemption | 04V for the wording; the design (opt-in, off by default) stays as the conservative engineering default. |
| C7 | Why the endpoint is build-only | 04 F40: a pointer `tel=` makes "every pointer a tracking-pixel vector"; unknown keys "ignored" | 04V claim 8: pointers already carry endpoints; unknown keys are "kept (and signed)"; the egress test is the primary proof | 04V: rule unchanged, rationale replaced. |
| C8 | `_health` aggregate | 04 F44 and R18: readers keep items with `author == owner`, written by "a real visitor holding the owner identity" | 04V claim 5 and ARCH 6.2: a reserved `_health` key written by a pin-node moderator key; the owner key never enters a browser | 04V and ARCH. |
| C9 | Hub reputation defence | 06 R4 and Summary 10: PSL listing plus monitoring | 06V claim 7: PSL does not isolate labels in Chromium or Firefox lookups | 06V (E9, E11). |
| C10 | Canada "enabler" | 06 Summary 3 and F8: an "enabler offence" | 06V claim 5: civil infringement, damages deemed commercial | 06V (E1-E3). |
| C11 | Mircom | 06 Summary 5: "No safe harbour exists for end users" | 06V claim 4: not in the judgment; the holding is conditional | 06V (E7). |
| C12 | EDPB and browser storage | 06 F15: "the EDPB says so in terms" | 06V claim 8: the technologies are never named | 06V (E10). |
| C13 | IPFS gateway filtering | 06 F10: other gateways filter "under 20%" | 06V claim 6: listed public gateways about 54%; 97.4% from 100 phishing CIDs | 06V (E8). |
| C14 | npm `allowScripts` | DR S7 and `docs/review/security.md` M10: the key is inert | 05 F34: a working default-deny on npm 11.19.1, verified with a planted `postinstall` | 05 (experiment). Correct DR S7 (P0-12). |
| C15 | Wire-cap test value | ARCH 12 test 11 and `security.md` B4: a "4 GiB" message (`0xFFFFFFFF`) | 05 F41: `0xFFFFFFFF` is a keep-alive in `bittorrent-protocol` 5.0.9; the attack needs a length <= `0x7FFFFFFF` | 05. Test both values (D16). |
| C16 | Versions kept after removal | ARCH 5.8: keep the current version and the previous one | 06 R2: on a withdrawal or a denylist hit keep none (the previous version may be the one complained about) | 06 for withdrawals and denylist hits; ARCH 5.8 stays for ordinary updates. |
| C17 | Kill-state token | 05 R6: `st` absent or `ok`; `kill`; unknown value = kill | 06 R2 and B9: `st=active` or `withdrawn`, zero `btih` | Merged (D13): 05's semantics and `ok`; 06's `withdrawn`, zero `btih`, `why`, `ct`. Tools never emit `active`. |
| C18 | First-run consent strings | DR 4.5 (strings declared final) and ARCH 8: a non-blocking notice with `[Settings] [OK]` | 06 R1 and B1: a same-layer refusal, `[Share and load]` `[Load from host only]` | 06 on behaviour (pending counsel); the DR editor owns the final strings and must apply DR section 4 (for example DR 4.3 forbids promising offline use on iOS, which B1's "works offline" does; 9.2 adjusts it). |
| C19 | Nostr signaling | 01 R9 (P1) and Summary 12: Trystero's Nostr strategy over >= 7 pinned relays, "Nostr room for the chain" in v1 | 02 R13 (P2): own minimal client, default off; Trystero's SDP key is derivable by relays. DR section 3: v2 | 02 and DR (D22); 01 F8 kept as feasibility evidence. |
| C20 | STUN servers | 03 R-03: Cloudflare + Google (both AAAA), Twilio optional | 01 F2: `stun.l.google.com` is on BlockListProject "tracking". Tree: Cloudflare + Twilio | Tree for v1 (two operators, published terms; Twilio was not covered by 01's block-list check); revisit when IPv6 classification matters, since it needs two AAAA-capable servers and Twilio has none (03 F-06). |
| C21 | Web-seed CORS allow-list | 01 R2: `Access-Control-Allow-Headers: range, cache-control` | 02 F30: WebKit also preflights `user-agent`, even for the `xs=` fetch, so an explicit list without it fails on iOS and Safari | 02 (measured in Chromium and WebKit). Answer `*` or list all three; the tree already agrees (`publish.mjs` emits `AllowedHeaders: *`; `check-webseed.mjs` requires `cache-control`, `range` and `user-agent`). |

## 5. Constraints discovered

### 5.1 Compatibility (browsers, protocol, grammar)

- **Pointer grammar.** Unknown keys are kept and signed (ARCH 4), so new keys are backward compatible but new *semantics* are not: `st` must be in the grammar and in the loader before the first release (05 R6). TXT strings are at most 255 bytes and an RRset is about 1,200 bytes in practice; `nk` + `rel` + `st` add about 100 characters and `sshsig-es256` replaces an 86-character `sig` with about 350 (05 3.2; 03 F-26).
- **Web-seed CORS.** WebKit adds `user-agent` to the preflight, even for the `xs=` fetch made by WebTorrent; Chromium preflights `Cache-Control`; a server that ignores `Range` answers 200 with the full body and the piece hash fails (02 F30, Gotchas 17-18, 26).
- **BEP 19 and Blossom.** A web-seed URL is used literally only for single-file torrents; Blossom's flat `/<sha256>` namespace cannot serve a multi-file torrent without a Service Worker adapter and a signed path manifest (02 F31).
- **WebTorrent internals.** The reconnect and keepalive shims patch per-instance internals of `webtorrent@3.0.21`: pin the version and keep `e2e/reconnect.mjs` as a tripwire (01 R4, Q10). The bundle captures `RTCPeerConnection`, `WebSocket` and `fetch` at module init (04V claim 2).
- **simple-peer limits.** Tracker peers are non-trickle and `_generateOffers` waits for all offers, so one stalled PC delays the announce (03 G-10); simple-peer cannot ICE-restart or call `setConfiguration()`, so relayed connections drop when TURN credentials expire (03 G-04).
- **WebKit (Playwright 27.2).** The default OPFS chunk store failed with `UnknownError` on the first web-seed piece (01 Gotcha 9); ICE gathering never completes, no host candidates appear, and with zero ICE servers no offer is emitted (03 F-24). Real Safari is untested in every file.
- **What pages cannot see.** WebSocket and `fetch` failure causes are hidden from scripts (04 F6); `getStats()` exposes addresses and must be redacted in one place (04 F8, Gotcha 5); `web-vitals` cannot see inside the iframe while CrUX folds iframe content into the page (04 F13, Gotcha 17).
- **Meta CSP.** A `<meta>` CSP cannot carry `frame-ancestors`, `sandbox`, reporting or report-only; a SW-injected `frame-ancestors 'none'` is enforced by Chromium (05 F28, F32; 04 F12).
- **Safari 26 and import maps.** `Integrity-Policy: blocked-destinations=(script)` blocks import-mapped modules; do not combine the two yet (05 Gotcha 8).
- **Crypto availability.** WebCrypto has no secp256k1 (02 F16); WebCrypto Ed25519 starts at Chrome 137, Firefox 129 and Safari 17, above the declared floor of Safari 15.4, Chromium 110 and Firefox 115 (05 F15; ARCH 5.1).
- **Lifecycle.** `unload` is gone in Chrome 155+; `sendBeacon()` returning `true` means queued, not delivered; a JSON `Blob` beacon forces a preflight, so send `text/plain` (04 Gotcha 7).
- **Destructive levers.** `Clear-Site-Data: "storage"` deletes every IndexedDB database of the origin, including ledger identity keys and pins; Lockdown Mode, private windows and in-app WebViews may have no Service Worker, so none of the SW safety nets exist there (05 Gotchas 3, 18).

### 5.2 Operational

- **GitHub Actions schedules** start 5-60 min late with multi-hour outliers, auto-disable after 60 days without repository activity (what counts is undocumented), notify one actor, and bill each job rounded up to a whole minute; private repositories fit a 30-minute probe but not a 15-minute one (04 F20, F21; 04V claim 3).
- **Healthchecks.io** UUID pings are rate-limited silently (`200 OK (rate limited)`); the ping URL is a secret because anyone holding it can mark the check healthy (04 Gotcha 9).
- **Oracle Always Free** reclaims an A1 instance after 7 days with CPU p95, network and memory all under 20%, and can fail with "out of host capacity" (01 Gotcha 12; 03 G-24).
- **Caddy 2.11.7:** `caddy reload` closes every WebSocket after 71 ms unless `stream_close_delay` is set, and then only after the delay; nested `servers { metrics }` is deprecated (01 F5).
- **Cloudflare Durable Objects:** one socket terminates in one object (the swarm goes into the URL); deploys disconnect every socket; hibernation drops in-memory state; incoming messages are billed 20:1 (01 F6, Gotcha 10).
- **CDN and host behaviour:** a CloudFront minimum TTL overrides origin `no-cache` for `/mw-sw.js`; a host SPA fallback or a redirect for a missing `/mw-sw.js` silently pins the old worker; navigations less than about 2 s apart starve Chromium's SW update check (05 Gotchas 4-6).
- **DNS block lists:** HaGeZi Anti-Piracy blocks all four public trackers; BlockListProject "torrent" blocks openwebtorrent and novage; HaGeZi Light and up block the public MQTT brokers; BlockListProject "tracking" blocks `stun.l.google.com`; EasyPrivacy blocks third-party WebSockets to `duckdns.org` (01 F2).
- **Public trackers are volunteers** with no SLA or abuse policy; probe politely (one connection each, `numwant: 0`, `stopped` after the announce, an identifiable peer-id prefix); `scrape` is not a liveness test (01 F1; 04 F27, Gotchas 11, 26).
- **TURN vendors:** Cloudflare needs a server-held bearer token to mint short-lived credentials (its own pages disagree on the lifetime) and licenses Realtime "to enable video call functionality"; Metered credentials take up to 2 min to work; the first of coturn's three advisory pages alone lists ten advisories published between 2026-07-24 and 2026-08-05, three of them High (03 F-09, F-10, F-12, F-18, G-05 to G-09).
- **Nostr and Blossom:** about 22% of relays reject strangers by design and 27.5% sit behind Cloudflare; `limit` is clamped to 500 without a completeness hint; `OK true` can mean dropped; per-IP write limits (a README sample says 8 events per minute; production values unknown) would make mirroring a 10k-block ledger take about 21 hours per relay; Blossom prunes unaccessed blobs (1 week on reference defaults, 60 days on 24242.io) (02 F7-F14, F29, F35).
- **Canary vantage:** a GitHub runner sits in a datacenter with a clean NAT, so it cannot see CGNAT, carrier NAT, iOS suspension or corporate UDP blocks; outbound UDP to STUN from GitHub runners is unverified (04 F29, Gotchas 13-14).
- **Vendor numbers move:** every price and limit here was read on 2026-10-17 at medium confidence; Cloudflare Workers Logs pricing changes on 2026-12-01 (04 F37).

### 5.3 Legal (summaries of the research, not legal advice)

- **US:** contributory liability requires intent (Cox v. Sony, 2026-03-25); inducement through marketing or a service tailored or promoted for infringement remains; DMCA s.512 still governs monetary relief and needs a designated agent, notice-and-takedown and a repeat-infringer policy; the counter-notice restore window is 10-14 business days (06 F1, F2, Gotcha 6; 06V claim 1).
- **EU:** knowledge plus expeditious action (DSA Art. 6); micro and small providers still owe Arts. 11-14 and 16-18; terrorist content must come down within one hour of a removal order (Reg. 2021/784 Art. 3(3)); e-evidence representatives have been due since 2026-08-18 (06 F3, F27; 06V claim 2).
- **EU privacy:** IP addresses are personal data and the party whose code makes the browser send them is a (joint) controller for that transmission (Fashion ID); EDPB 2/2023 brings tracker sockets and peer connections into the Art. 5(3) analysis; whether SW caching is "strictly necessary" and whether peer upload needs consent are open (06 F15, F16, F18; 04V claim 7; 06V claim 8). CNIL exempts strictly limited anonymous audience measurement, which fits Plan W's shape in France; other member states were not checked (04V claim 7).
- **Canada:** notice-and-notice (forward "as soon as feasible", keep identifying records 6 months, $5,000-$10,000 statutory damages for failing the duty); the enabler provision is civil with damages deemed commercial; Quebec requires nothing pre-selected and a privacy impact assessment (06 F8, F21, R9; 06V claim 5).
- **Visitors who seed** "make available" when duly informed (conditional, per 06V); statutory damages range from US $750-$30,000 per work to Canada's $100-$5,000 in total for non-commercial infringement (06 F6; 06V claims 4, 5).
- **Mandatory reporting:** US 18 U.S.C. 2258A on actual knowledge (no duty to scan; preserve 1 year); Canada's mandatory-reporting Act (21-day preservation today); hash matching is possible only where bytes are handled: the web seed, a CDN, a pin or seedbox service (06 F25, F26, F28).
- **Reputation:** Safe Browsing strips the fragment, so a hub can be flagged only per host or parent domain; a PSL entry does not change Chromium or Firefox lookups (06 F11; 06V claim 7).
- **Words are a legal control:** "uncensorable", "cannot be taken down" and piracy-flavoured examples feed inducement theories; DR 4.2 already bans them (06 Gotcha 15).
- **Relay and Blossom copies** are outside the owner's control; NIP-09 deletion works only for the signing key, so moderated ledgers may publish to relays only through an owner-controlled pinner key (02 F34).
- **Children:** IPs are COPPA "personal information"; child-directed sites should run host-only (06 F24, R14).

## 6. Open questions

### 6.1 Answer with data, not research

1. The real relay share and stranded-visitor share by device, browser and network pair (03 Q-01): answer with the P1-6 diagnostics and, if adopted, Plan W.
2. Real-device behaviour: iOS Safari (ICE gathering, `.local` candidates, offer latency with `trickle: false`, SW update timing, the 7-day eviction), Android Chrome and Samsung Internet across background, foreground and screen lock, and Firefox desktop and Android for everything (01 Q1-Q2; 03 Q-04, Q-07; 04 Q6; 05 Q4).
3. Whether Oracle reclaims a lightly loaded A1 that hosts only a tracker or a pin node (01 Q3, open for two waves).
4. The Durable Object tracker on Cloudflare's production edge: hibernation timing, latency, deploy-time disconnect scale, Free-plan enforcement of the 20:1 billing rule (01 Q4).
5. How many visitors sit behind DNS filtering that blocks the public trackers, and how corporate gateways classify `rtc.<domain>` (01 Q8-Q9).
6. Outbound UDP from GitHub-hosted runners; whether a workflow's own commits reset the 60-day auto-disable (04 Q1-Q2).
7. Browser memory under an unbounded buffered wire message (05 Q11); `getStats()` cost on a low-end phone (04 Q5); PoW mint time on a mid-range Android (04V claim 5).
8. Nostr write acceptance and per-IP write limits, retention of custom regular kinds, uptime over time, correlated failure of Cloudflare-hosted relays (02 open questions 1-4, 13).
9. One-sided TURN between a hard-NAT visitor and a port-restricted peer; coturn allocation rate; IPv6-only visitors with IPv4-only relays (03 Q-08, Q-09, Q-12).
10. Every stage of the latency model in section 11 (topic 07).

### 6.2 Need a vendor or counsel answer

1. Do Cloudflare, Metered, Twilio or ExpressTURN allow relaying data-channel traffic for website delivery; is there a hard spend cap; what is Cloudflare's real credential lifetime (03 Q-02, Q-03)?
2. The counsel package (06 section 7): operating entity and insurance; whether the two-action card plus withdrawal in Settings meets ePrivacy Art. 5(3), GDPR consent, PECR Sch. A1 and Quebec s.8.1 and s.9.1; controller allocation with tracker and STUN operators (Art. 26 arrangements); OSA and DSA provider status of an owner with `writers:'owner'` versus `open`; DMCA repeat-infringer wording keyed on owner key and contact; EU representative scope; NCMEC registration for a hub that never holds bytes; Quebec PIA scope.
3. Who is the DSA "provider" of an owner-moderated ledger, and does a hub that stores nothing but makes browsers fetch and render third-party content fit Arts. 4-6 (06 section 7: no authority found)?
4. Does Google apply PSL logic server-side when listing; how do Safari and Edge SmartScreen scope a listing (06V claim 7)?
5. Relay operators' terms on non-social, machine-generated kinds and their practice on notices about a ledger tag or blob hash (02 Q7, Q14).
6. The public tracker operators' real per-IP limits and whether they accept the expected load (01 Q5).

### 6.3 Need Ash (decisions and every outbound step; nothing below has been done)

1. Approve or decline the coordinated disclosure email to the `bittorrent-protocol` maintainer (05 R5) and the crash report to `bittorrent-tracker` (01 R3, R15).
2. Approve or decline the Nostr write-acceptance test (02 R14: one throw-away key, 20 relays, at most 3 events each with a 1-hour expiry, then NIP-09 deletes, then a paced burst on 3 relays) and the public NIP pull request for dedicated kinds (02 R3).
3. Approve or decline the TURN-terms question to a vendor (03 R-09) and the courtesy contact with the four public tracker operators (01 R12).
4. Allow a hands-on test of the Token2 key with `ssh-keygen -t ecdsa-sk` (a touch is required; no key material leaves the device), and an inspection of its PIV and OpenPGP applets (05 Q3).
5. Choose the hold-down length for DNS-only key changes (RFC 5011 uses 30 days or the TTL) and whether the pending key renders content meanwhile (05 Q2).
6. Decide offline versus kill: does a cached record N days past `exp`, or any cached `st` stop value, fail closed, and what is N (05 Q1)? May a pointer-level kill redact ledger payloads on visitors' devices, and who besides the owner may authorise it (05 Q8)?
7. Distribute our own releases through npm with trusted publishing, or only as signed GitHub releases (05 Q9)?
8. Is a PRF-wrapped encrypted backup of the owner key wanted for v1 (05 Q7)?

### 6.4 For the ARCH editor

1. The pointer key that carries the canary public key (`ck=` is a placeholder) and who owns the grammar (04 Q14).
2. Whether `_`-prefixed list names, not only keys, are owner and moderator only (04V claim 5).
3. The final hub-mode iframe sandbox: can hosted code reach `parent` (it decides whether `__mwDiag` may exist there) (04 Q12)?
4. The header allow-list for `/.mw/site.json` (05 Q12); `release.json` as the WAICT shape or our own plus a converter (05 Q6).
5. Fork and vendor a patched `bittorrent-tracker` client (a 20-line change) instead of shimming internals (01 Q10)?

## 7. Reference deployments

### 7.1 Reference tracker deployment

Source: 01 "Reference tracker deployment" and F3-F6, F9; every file named below is in `docs/research/labs/w2b-01-tracker-resilience-ref/`. Status: a research artefact, tested as listed, **not security-audited**, and not yet wired into `tools/tracker.mjs` (P0-4, P1-2).

```
visitor --443/tcp+udp--> Caddy 2.11.7 (TLS, HTTP/2 and HTTP/3, ACME) --127.0.0.1:8000--> tracker.mjs (Node 24, bittorrent-tracker 11.2.3 + guards)
                          |  /healthz, static answer, IP-masked JSON access log           |  127.0.0.1:9464/metrics (loopback only)
                          +-- admin 127.0.0.1:2019/metrics                                +-- JSON logs to journald
```

| Component | Key settings | Tested |
|---|---|---|
| `tracker/tracker.mjs` (416 lines; pins `bittorrent-tracker` 11.2.3, `ws` 8.22.0, `prom-client` 15.1.3) | everything in P0-4, plus idle close at 2.75x the announce interval, empty-swarm GC, `scrape` off, SIGTERM drain (close 1001 spread over 5 s, exit 0), refuses to start with neither `ALLOW_FILE` nor `OPEN=1` | 16 black-box tests on macOS 27 and inside Ubuntu 24.04.5 |
| `deploy/Caddyfile` | neutral hostname; only WebSocket upgrades reach the tracker; `stream_close_delay 30s` and `grace_period 30s`; `/healthz`; HSTS; access log masked to IPv4 /24 and IPv6 /48, `X-Forwarded-For` and cookies removed, 7-day retention; global `metrics` | `caddy validate`; behaviour tests (`caddytest/run.mjs`); real ACME issuance not tested |
| `deploy/magnet-tracker.service` | user `mwtracker`; `LimitNOFILE=1048576`; `MemoryHigh=1200M`, `MemoryMax=1600M`; `SystemCallFilter=@system-service` minus `@privileged @resources`; empty capability set; `ProtectSystem=strict`; `MemoryDenyWriteExecute` off (V8's JIT needs it); `Restart=always`; `ExecReload` sends SIGHUP (allow-list reload) | Ubuntu 24.04.5 arm64, systemd 255: `systemd-analyze security` 3.3 "OK"; end to end over TLS through Caddy (upgrade 45 ms, announce and relay pass) |
| `monitoring/` | Prometheus scrape config; 11 alert rules (down, restart loop, uncaught exception, no clients, near cap, event-loop lag, RSS, reject and refusal spikes, WebSocket probe, certificate expiry); a GitHub Actions example for the external probe | `promtool` 3.15.0: config and rules valid; alert logic not exercised |
| `probes/check_trackers.py` | DNS, TCP, TLS, upgrade, a `numwant: 0` announce and an optional two-peer offer-answer relay; pings a heartbeat only on success | run against the four public trackers and the reference tracker |
| `deploy/Dockerfile`, `fly.toml`, `cloud-init.yaml` | container; Fly.io with `type = "connections"`, autostop off, `TRUST_ANY_PROXY` and `CLIENT_IP_HEADER=fly-client-ip`; Ubuntu bootstrap | not tested |

Environment (`deploy/env.example`, defaults from 01's configuration reference):

```
HOST=127.0.0.1
PORT=8000
METRICS_PORT=9464
ANNOUNCE_INTERVAL_S=120
ALLOW_FILE=/etc/magnet-tracker/allow.txt
ALLOW_ORIGINS=https://example.com,https://www.example.com
MAX_CONNECTIONS=20000
MAX_CONN_PER_IP=200
PING_INTERVAL_S=30
LOG_LEVEL=info
```

The allow file holds one 40-hex infohash per line: every published version's `btih` plus the ledger anchor torrent's infohash (ARCH 5.5). Update it on every publish (SIGHUP reloads it); `OPEN=1` is for demos only. `ALLOW_ORIGINS` stops other websites from using the tracker, not non-browser clients. Keep `MAX_CONN_PER_IP` generous because offices and CGNAT share addresses.

| Capacity and cost | Value | Source |
|---|---|---|
| Memory | about 25 KiB RSS per socket plus a ~70 MB base: 20,000 sockets is about 0.57 GB; on Linux 10,200 idle sockets used 287 MB RSS | 01 F3, runbook item 8, reference table |
| CPU | 4,002 sockets announcing once a second used 0.81 core (102 microseconds per message); one core saturates near 15-23k announces/s (each fanning out 5 offers) | 01 F3, reference table |
| Expected load | 10-1,400 concurrent sockets for small sites | 01 F3 |
| Egress | about 50 B/s per socket with the stock 5 offers per 120 s announce; about 1 B/s with the count-aware policy (P1-1) | 01 runbook item 8 |
| Hosting | Oracle Always Free A1 $0 (2 OCPU, 12 GB, 10 TB/month egress, idle reclaim, home region only); DigitalOcean $4-6; Fly.io $2.19-6.70 plus $0.02/GB; Hetzner EU with >= 20 TB included (price not retrieved) | 01 F4 and decision table |

Runbook (condensed from 01):
1. **Provision** an Oracle Always Free A1 (stateless security-list rules for 22, 80 and 443, TCP and UDP 443) or any Ubuntu 24.04 VPS; DNS A and AAAA for a neutral hostname `rtc.<domain>`; a CAA record.
2. **Install** Node 24.22.0 from the official tarball (verify the SHA-256), Caddy from its official apt repository, the `mwtracker` user, files under `/opt/magnet-tracker`, `npm ci --omit=dev --ignore-scripts`.
3. **Start** with `systemctl enable --now magnet-tracker caddy`; verify from another machine: `python3 -I probes/check_trackers.py --relay wss://rtc.<domain>`.
4. **Publish** `tr=wss://rtc.<domain>` first in the signed pointer, then the public trackers (D3).
5. **Observe** with Prometheus and the rules, the external probe every 5-10 min feeding a heartbeat monitor, and the daily block-list check (P1-3).
6. **Upgrade** with `systemctl restart magnet-tracker` (drains in 5 s, exits 0). Clients with the stock reconnect come back after 10 s + U(0, 5 min), with the P0-3 shim after about a second. Avoid `caddy reload` at peak; certificate renewal needs no reload.
7. **Incidents:** event-loop lag: read `rate(mwt_messages_total)` and `mwt_messages_rejected_total{reason}` before raising `RATE_*`; memory growth: `mwt_connections_closed_total{reason="backlog"}`, lower `BUFFER_LIMIT`; abuse: set `ALLOW_ORIGINS`, move from `OPEN=1` to `ALLOW_FILE`, or put Cloudflare in front (the server ping covers its unstated WebSocket idle timeout); crash loop: `journalctl -u magnet-tracker` and `mwt_uncaught_exceptions_total`, then report the message shape upstream (needs Ash, 6.3).

**Optional second tracker on a separate failure domain** (01 F6): a Cloudflare Worker with one Durable Object per swarm (`cf-do/`, about 110 lines; 8 of 8 checks in local `workerd`; two real WebTorrent pages connected through it). The swarm goes into the URL, with a capability token from `publish.mjs` so strangers cannot create rooms on our bill: `tr=wss://<worker>/<btih>?k=<HMAC(secret, btih)>`. Cost is about $5 a month up to roughly 2.5 M visits a month and about $8.5 at 10 M. Every deploy disconnects every socket, so it needs the P0-3 reconnect shim; production edge behaviour is untested (01 Q4).

**Disclosure:** a tracker operator sees visitor IP addresses, the swarm id and SDP; list it in the recipients register and never log infohash plus IP (06 R16, A5).

**Gap between this reference and the tree's `tools/tracker.mjs`:** the tree validates offers (closing the `offers:[null]` crash), caps payloads at 128 KiB, caps the number of swarms, forgets empty swarms every 5 min in `--open` mode and refuses to start without `--allow` or `--open`; it has no server ping or idle close, no per-socket backlog cap, no per-IP connection quota or rate limit, no Origin allow-list and no metrics.

### 7.2 Pin-node deployment

A pin node is `tools/pin.mjs` (already in the tree) running unattended: it keeps the real loader open in Playwright Chromium. It has four roles:
1. **Always-online copy** of the files and the site ledger, so a site with no visitors still has a peer (ARCH 10; DR S2).
2. **"Easy" peer for hard-NAT visitors:** a public address with inbound UDP is compatible with every visitor, which makes it a free substitute for TURN (03 F-03, R-11).
3. **Snapshot writer** for `cs=` (`--snapshot <file> --snapshot-every <seconds>`), the ledger durability floor (DR S2).
4. **Later key holder (v1.x):** the pinner key `np` that mirrors to relays and Blossom (02 R6; section 10) and a moderator key that may write `_health` (P3-3). The owner key never lives here (ARCH 6.2).

| Item | Setting | Source |
|---|---|---|
| Hosts | two VMs at different providers, public IPv4 (and IPv6), inbound UDP open | 03 R-11 |
| Candidates | Oracle Always Free A1 (give it real work or accept re-provisioning, because idle instances are reclaimed); DigitalOcean $6 (1,000 GiB); Hetzner EU (20 TB; price not captured) | 03 F-19, G-24 |
| Process | `node tools/pin.mjs https://<site>/ --headless --profile /var/lib/mw-pin/<host> --interval 60 --snapshot /var/lib/mw-pin/ledger.json.gz --snapshot-every 600` under systemd with `Restart=always`; `pin.mjs` itself restarts Chromium with a 5 s backoff that doubles to at most 5 min | tree (`tools/pin.mjs`) |
| Snapshot publication | copy the snapshot to the URL that `cs=` names (on the web-seed host or by a sync job; the sync step is not in the tree) | DR S2 |
| Consent | the tool accepts the notice or gate once; the persistent profile keeps the choice | tree |
| Heartbeat | Healthchecks ping every 60 s with `{ peers, wires, seeding, uploadedDelta, chainHeight, uptimeS, renderOk }`; `/fail` on page crash, browser disconnect, `renderOk === false` or `seeding === false`; period 2 min, grace 5 min (not in the tree yet) | 04 R6 (P0-11) |
| Independent signal | the canary's `swarm.seeders` check: at least one seeder on at least two trackers for the real infohash ("I am alive" from the pin, "the world can see me" from the trackers) | 04 R3 item 7, R6 |
| Verification | run the connectivity probe on the pin host, confirm an easy class with public candidates, and log the share of connections the pin serves | 03 R-11 |
| Second vantage | the pin host can also run the E2E canary profiles against the public URL from a non-Azure network, reporting to its own Healthchecks check | 04 R6 |
| Network policy | `pin.mjs` is one of the tools allowed to reach the internet; it prints what it will contact before it starts and the tests never run it | `docs/DEV-NETWORK.md` |

Limits: the pin sees visitors' IP addresses like any peer; a pin *service* for other people's sites is a hosting-like role (screening such as PhotoDNA and notice handling apply, 06 role map and R10); the peers-only canary profile must point at the pin node and run separately from the web-seed-only profile, so a canary that seeds itself cannot hide a broken peer path (04 Gotcha 15); the Chromium process cost per pinned site is unmeasured (topic 07).

## 8. Observability plan

### 8.1 Principles

1. **Split by vantage point.** The page can say *what* failed; only an external probe or a same-engine harness can say *why*; real visitors' networks are visible only through `health.html` bundles or opt-in field data (04 F6, F29; 04V claim 1).
2. **Instrument the platform boundary** (D10), not library internals, and diagnose within 5 s (DR S5).
3. **Nothing leaves the device by default,** and the proof is a network test, not a grep (8.4).
4. **No visitor telemetry on the site ledger;** health aggregates only from owner or moderator keys (D9, D24).
5. **Every scheduled job has a dead-man's switch** with a grace period sized to its scheduler's lateness (D11).

### 8.2 Plan Z: zero servers of our own (v1)

"Zero servers of our own" still relies on the static host, GitHub's runners, Healthchecks.io and public trackers; none of them is a backend we operate (DR 4.2: the accurate phrase is "no backend").

| Layer | Component | Runs on | Cost | Cadence | Output |
|---|---|---|---|---|---|
| Visitor | `diag.js`, bundle export, Settings > Diagnostics, `health.html` (P0-8, P1-8, P1-11) | the visitor's browser | $0 | continuous or on demand | local only |
| Publisher | probe library preflight and publish gate (P0-9, P1-13) | publisher laptop or CI | $0 | per publish | exit code, JSON |
| Probe canary | `canary-probe.yml` (P0-10) | GitHub Actions, public monitor repo | $0 | every 30 min | Healthchecks, Issue, `status.json` |
| E2E canary | `canary-e2e.yml` (P1-7) | GitHub Actions | $0 (public repo) | hourly | artifacts, Healthchecks |
| Seeding | pin heartbeat and `swarm.seeders` (P0-11) | pin host and probe | $0 plus the pin VM (7.2) | 60 s and 30 min | page |
| Dead-man's switch | Healthchecks.io free tier (20 checks; this plan uses 4-6) | SaaS | $0 | n/a | e-mail or chat |
| Status | `status.json` signed with the canary key, on GitHub Pages (04 Appendix C shape) | GitHub Pages | $0 | 30 min | public, CORS `*`, "unknown" when older than 2 h |
| Optional | UptimeRobot or Better Stack HTTP checks of the static host and the age of `status.json` | SaaS | $0 | 5 min | a second vantage |

A private monitor repository fits 30-minute probes and a 2-hourly E2E run in about 2,520 billed minutes a month (04 "Plan Z").

**Diagnosis rows** shown to visitors (04 R1; evaluated at 3 s, 5 s, then every 5 s; thresholds are proposals to tune on the first two weeks of data; final strings belong to the DR editor):

| Condition | Visitor sees | Owner hint |
|---|---|---|
| no tracker socket opened while `navigator.onLine` | "Cannot reach any tracker (your browser does not say why)." | run the tracker probe |
| a tracker answers but reports only us; no wires | "Tracker reachable; no other visitor is online yet." | start a pin node; add `ws=` |
| others reported, answers received, PCs negotiating > 10 s, no wires | "Other visitors exist but a direct connection failed (network or NAT)." | consider the TURN tier (P1-23) |
| gathering > 5 s, or a 701 error and no srflx candidate | "A STUN server is unreachable." | prune the STUN list |
| wires, no bytes after 10 s, every peer choking | "Connected, but peers are not sending." | check the upload policy |
| web seed configured, 0 web-seed bytes after 5 s | "Web seed unreachable (CORS, DNS, TLS or blocked; the browser hides which)." | run the web-seed probe |
| `received - downloaded` > 5% of `received` | "Some peers sent corrupt data." | |
| SW not controlling after the wait | "Limited mode: no Service Worker." | |
| storage use > 80% of quota, or not persisted on WebKit | "Browser storage is nearly full / may be cleared." | |

**Alert policy and SLO proposals** (04 R12; not evidence-based, adopt then tune): two consecutive failures before any page. *Page:* static host down; web seed down **and** `swarm.seeders` failing; pointer invalid or `exp` under 3 days; pin heartbeat missing. *Notify:* one tracker down, STUN degraded, DoH resolvers disagree, TLS certificate under 14 days. *Digest:* p75 time-to-visible regresses more than 50% week over week. SLOs: cold web-seed render succeeds in 99% of canary runs over 30 days; at least one seeder on at least two trackers 99.5% of the time; pointer `exp` never under 14 days.

**Probe workflow sketch** (from 04 R4 with the 04V claim 3 corrections; untested; pin third-party actions by commit SHA):

```yaml
# .github/workflows/canary-probe.yml in a public monitor repository
name: canary-probe
on:
  schedule:
    - cron: '7,37 * * * *'   # avoid round minutes, but expect runs 5-60 min late anyway
  workflow_dispatch: {}
concurrency:
  group: canary-probe
  cancel-in-progress: false
jobs:
  probe:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version: 24 }
      - run: curl -fsS -m 10 --retry 3 "https://hc-ping.com/${{ secrets.HC_UUID }}/start"
      - run: node tools/check-site.mjs "https://example.org/" --json > result.json
      - if: success()
        run: curl -fsS -m 10 --retry 3 --data-binary @result.json "https://hc-ping.com/${{ secrets.HC_UUID }}"
      - if: failure()
        run: curl -fsS -m 10 --retry 3 --data-binary @result.json "https://hc-ping.com/${{ secrets.HC_UUID }}/fail"
# Healthchecks: period 30 min, grace >= 60 min (04V claim 3). Still to add (04 R4): sign status.json with
# the canary key and commit it to a `status` branch only when it changed; open one Issue after two failed runs;
# a monthly real commit to the repository against the 60-day auto-disable.
```

`check-site.mjs` is one of the three tools `docs/DEV-NETWORK.md` allows to reach the internet; running it from CI against the live site is its intended use.

### 8.3 Plan W: one Worker (P2, opt-in, operated by whoever deploys the loader)

Everything in Plan Z, plus:

| Layer | Component | Cost | Notes |
|---|---|---|---|
| Beacon | same-origin `/_t` route (Pages Function or Worker) | $0 below about 20,000 beacons a day (Workers Free: 100,000 requests a day, shared with all Functions) | same origin keeps `connect-src 'self'`; fail open |
| Storage | Workers Analytics Engine | not billed yet; Free 100,000 data points a day, 3-month retention | 250 data points per invocation |
| Summary | `GET /_t/summary.json` with k >= 20 suppression and a 5-minute cache | $0 | public, no raw rows |
| Edge probe | Worker Cron Trigger running tracker announce probes | $0 (5 triggers per account) | no UDP, so no STUN; a third vantage and an independent scheduler (04V claim 3) |
| Logs | Workers Logs | Free 200,000 events a day, 3-day retention | new Observability pricing from 2026-12-01 |
| Upgrade | Workers Paid | $5 a month minimum | 10 M requests a month, longer retention |

**Switch:** an esbuild `--define` constant set at deploy time; when it is empty the telemetry module is dead-code eliminated and no UI appears (the Element precedent, 04 F16). **Consent:** a Settings toggle "Help improve reliability", off by default, with "What is sent?" showing the exact last payload and naming the endpoint host and its operator; hidden when Global Privacy Control or Do Not Track is set; no banner in the first-run flow.

**Payload** (04 R14): at most 1 KB, sent as `text/plain` (no preflight), once per session at the first terminal state or on `visibilitychange: hidden`, sampled at `p = min(1, 20000 / dailyVisits)`, no retry, no spool. Closed fields only: schema version and `BUILD_ID`; mode; source (cache, peers, web seed, mixed); rendered and error code; log2-bucketed timings (pointer, first wire, metadata, done, visible); small capped counts (trackers ok and total, offers, wires, failed PCs); STUN verdict; selected-pair class (for example `hs`, `sr`); network, device and engine class; log2-bucketed bytes from peers, from the web seed and uploaded. **Never sent:** IP address (the network path still shows it to the operator), user agent, URLs or paths, keys, peer ids, timestamps, free text, any persistent id. The collector rejects unknown fields and out-of-range values, always answers 204, does not log `cf-connecting-ip`, sits behind a rate-limit rule, and keeps a `telemetry.schema.json` registry with per-field expiry. Every number is a hint: no alert may depend on it (local-DP style aggregates are poisonable, 04 F31).

**Honest wording** (draft from 04 "Plan W"; legal review pending):
- README and DEPLOY: "magnet-web has no required backend and ships with no telemetry. A site operator may add a reliability-statistics endpoint when building the loader. If they do, the loader asks you first, shows the exact data, and sends nothing until you opt in. The endpoint is chosen by the operator who deployed the loader, never by a site's address record."
- Settings: "Help improve reliability. Send an anonymous connection report to `<host>` (operated by `<operator>`) once per visit: whether the site loaded, rounded timings, whether peers could connect, your browser engine and device class. It does not include your address, pages you viewed or any identifier, although the network path still shows your IP address to the operator when your browser connects. [What is sent?] Off by default."

Opt-in is the conservative engineering default; CNIL's exemption for strictly limited anonymous measurement may fit in France, and other member states were not checked (04V claim 7).

### 8.4 Decisions and the proof of "no analytics"

| Question | Answer |
|---|---|
| Can v1 ship with Plan Z alone? | Yes (04 decision table). |
| What does Plan W buy? | Field data on NAT, CGNAT and iOS outcomes that no canary can see (03 Q-01). |
| Is Plan W required for "production-ready"? | No: P2, and only when an operator wants field data. |
| Visitor telemetry on the site ledger? | No (D9). |
| A DNS health record? | No (D24). |
| Local differential privacy or DAP? | Not in v1 (04 F30, F34; 04V claim 6). |

**Egress allow-list test** (P1-12; the primary assertion per 04V claim 8): drive the built loader in Playwright with telemetry unset and fail on any request, WebSocket or RTC destination outside {loader origin, pointer-listed trackers, web seed, `xs`, DoH resolvers, STUN}; keep "no `sendBeacon`, `XMLHttpRequest` or `new Image` in the default build" as a cheap second check. The shell CSP allows `https:` and `wss:` in `connect-src` (ARCH 13) because pointer-chosen hosts are unknown at build time, so the test, not the CSP, is the proof. Under `docs/DEV-NETWORK.md` the test runs against a loopback fixture with `chromiumArgs()`: attempted requests are still observable even though no remote host resolves.

## 9. Operations and legal checklist, with template snippets

Everything in this section is a draft for review by counsel in the jurisdictions where the deployment operates; **it is not legal advice** (06 header, Appendix B). Who: **O** = a site owner on their own domain, **H** = a hub operator or anyone hosting third-party bytes, **P** = project maintainers.

### 9.1 Checklist

**Before launch** (06 Appendix A1 with the 06V corrections)

| Item | Who | Source |
|---|---|---|
| Operating entity chosen (not an individual); counsel engaged; insurance quote requested | H | 06 A1, R19 |
| Mailboxes live and monitored: `abuse@`, `privacy@`, `security@`, plus `dmca@` for H; a test message to each acknowledged by a human within one business day | O, H | 06 A1, F30 |
| `/.well-known/security.txt` with `Contact`, `Expires` (under one year), `Canonical`, `Policy` (RFC 9116) | O, H, P | 06 B10 |
| US: DMCA designated agent registered and its contact published, with a renewal reminder (the three-year validity and the fee come from a 2019 source, 06 Gotcha 5; confirm with the Copyright Office) | H | 06 R5 |
| Terms and acceptable use (06 B4), copyright and abuse policy with repeat-infringer and counter-notice sections (06 B5), privacy notice (9.2 b), transparency page (06 B8), children statement; linked from the card, gate, Settings and footer | H; O at least the privacy notice and a contact | 06 A1 |
| If the service reaches the EU: authority and recipient contact points with languages, a legal representative if established outside the EU, terms that describe moderation tools and the complaint route | H | 06 A1; 06V claim 2 |
| Hub: allowlist mode, gate-only apex, no directory or search, wildcard certificate, Search Console and Safe Browsing monitoring, "Report this site" in the banner; PSL only for storage isolation | H | 06 R4; 06V claim 7 |
| Denylist: signing key generated offline, public key pinned in the loader build, publish procedure rehearsed, second reviewer for host-level entries | H | 06 R3 |
| Consent: card text reviewed by counsel; `consentVersion` set; CMP bridge documented | O, H, P | 06 R1 |
| DPIA, records of processing and recipients register; a Quebec privacy impact assessment when Quebec residents are served | O above a modest audience; H | 06 R6 |
| Every tracker and STUN operator (and TURN, relay and blob-host operators when enabled) appears in the recipients register; a change means a new `consentVersion` | O, H, P | 06 R16; 02 R10; 03 R-09 |
| `ct=` and `lg=` in the signed pointer; keep `writers:'owner'` unless the owner accepts the duties of a provider of user posting | O | 06 R2, R8 |
| Contacts directory: NCMEC CyberTipline (US) or the Canadian designated organization and police liaison; IWF or the national INHOPE hotline; the EU terrorist-content authority; the data-protection authority; counsel on call | H | 06 A1 |
| Drills measured and written to `docs/DEMO-RESULTS.md`: takedown (P0-class under 60 min, P2-class under 24 h) and kill switch (P0-14) | O, H, P | 06 R7; 05 R4, R18 |
| Safety protocol for harmful material: nobody opens suspected CSAM to check it, nobody reviews alone | H | 06 A1, R10 |

**Recurring** (06 A2)

| Cadence | Task |
|---|---|
| Daily | Triage `abuse@` and `dmca@`; acknowledge within one business day. |
| Weekly | Review open cases and denylist changes; check Safe Browsing and Search Console status. |
| Monthly | Denylist expiry and false-positive review; vendor abuse-policy check; back up the case log. |
| Quarterly | Privacy review (a tracker or STUN change means a new `consentVersion`); kill-switch drill; contacts check. |
| Yearly | Transparency report for the prior calendar year by the end of February (first DSA-harmonised cycle: calendar 2026, due by 2027-02-28); DMCA agent renewal check; refresh `security.txt` `Expires`; counsel review of terms, policies and the DPIA. |
| On event | New law or case; a new tracker, STUN or hosting vendor; a new target jurisdiction; any incident. |

**Notice handling** (06 A3)

| Class | Examples | Acknowledge | Act |
|---|---|---|---|
| P0 | CSAM, terrorist content, imminent threat to life or safety | within 1 hour | block (gate, pointer, denylist) within 1 hour of a credible report; report to the authority the same day; never open or copy the material; EU removal orders: one hour |
| P1 | court or regulator order; law-enforcement request | same business day | by the order's deadline; tell the issuing authority what was done; counsel before any disclosure of user data |
| P2 | copyright, phishing and malware, privacy erasure, defamation | within 1 business day | phishing and malware within 24 h, others within 2 business days; statement of reasons to the owner; counter-notice route open |
| P3 | terms violations, spam | within 3 business days | within 5 business days |

Steps for every notice: log it (case id, UTC time, channel, the raw notice with its SHA-256); acknowledge; validate (act first on any credible P0 report); identify the tuple (hub label or host, `btih`, file path, ledger block hash; no tuple, no action); pick the narrowest lever (owner contact, gate, denylist, host action, ledger moderation); apply it and record the denylist `ref` and `seq`; tell the owner with a statement of reasons; run the counter-notice route (US: restore after 10-14 business days unless suit is filed; Canada: record only); close with the time to act. Escalate to counsel on any order, law-enforcement contact, CSAM or terror case, request to identify visitors, threatened litigation, or repeated bulk or abusive notices.

**Retention** (06 A5): CyberTipline report contents at least 1 year (18 U.S.C. 2258A(h)); Canadian reported data 21 days (1 year once 2026 c. 19 is in force); Canadian notice-and-notice identifying records 6 months (1 year if proceedings are notified); case files 3 years after closure (suggested); operator access logs 7-30 days or none, disclosed (suggested); tracker logs: none, never infohash plus IP (suggested); consent records on the visitor's device only.

### 9.2 Template snippets

Replace every `<placeholder>`. Every factual sentence must be true for the deployment. Strings shown to visitors must pass DR section 4. The texts below are 06 Appendix B verbatim except where a change is called out.

**(a) First-run consent card** (06 B1, one change)

> **This site is delivered peer-to-peer.**
>
> If you choose to share, your browser connects to other visitors and to connection servers run by third parties. They can see your IP address and that you are viewing this site, and anyone who knows this site's address can join and see who is online. While this page is open your browser may upload this site's files and posts to other visitors, which uses bandwidth and battery. This site also keeps its files and settings on this device so it loads faster next time (on iPhone and iPad, until Safari clears them).
>
> You can load the site from its host only, with no peer connections, and change your mind any time in Settings.
>
> **[Share and load]  [Load from host only]**  [Settings]  [Privacy and contact]

Change: 06 B1 ends the storage sentence with "so it loads faster and works offline"; DR 4.3 forbids promising offline use on iOS. When relay or blob mirrors are enabled (section 10), add: "Public relays and file hosts used as backup can see your IP address, the address of this site and which ledger you read." (02 R10). On mobile data sharing stays off until the visitor turns it on (DR 4.3). Settings strings stay as in DR 4.5.

**(b) Privacy notice skeleton** (06 B3, condensed; two changes)

1. **Who we are.** `<Entity>`, `<postal address>`, `<privacy@...>`. Privacy lead: `<name or role>`. EU or UK representative, if any: `<name, address>`. Quebec person in charge of personal information: `<name, contact>`.
2. **What this service does.** It loads `<site>` from other visitors' browsers and from `<host>`, and keeps a shared message log (the site ledger) for the site.
3. **Who receives your data, and why.**

| Recipient | What they see | Why | Basis | Kept |
|---|---|---|---|---|
| `<Static host>` | IP address, requested URL, browser details | serve the loader and files | necessity to provide the site; security | `<N days>` or none |
| `<Web-seed host>` | IP address, requested byte ranges | serve files when no peers are online | same | `<N days>` or none |
| Connection servers (WebSocket trackers) `<names>` | IP address, the site's infohash, time | introduce you to other visitors | your consent | set by the operator: `<link>` |
| STUN servers `<names>` | IP address | work out how peers can reach you | your consent | set by the operator: `<link>` |
| DNS-over-HTTPS resolver `<name>` | IP address and the name `_magnet.<your site>` | look up the site's pointer | `<basis>` | set by the operator: `<link>` |
| Other visitors | IP address, that you view this site, your posting key and posts, the files you upload | share the site and its log | your consent | until they delete it |
| The site owner | posts you write | run the site | your request | as the site states |
| Only if enabled: TURN relay operator `<name>` | both ends' IP addresses and timing, not content | relay a connection your network blocks | your consent | `<link>` |
| Only if enabled: public relays and file hosts `<names>` | IP address, this site's address, which ledger you read | keep backup copies of the log | your consent | set by each operator |

4. **What is stored on your device.** The loader (a service worker), the site's files, a cached pointer, your sharing choice and its version, and, only if you write, a signing key. To delete: Settings, Forget this site, or clear site data.
5. **Your choice.** Peer connections and sharing happen only if you choose "Share and load". You can withdraw at any time in Settings. "Load from host only" never connects you to peers.
6. **Public by design.** Posts and your posting key are visible to everyone in the swarm and are copied by other visitors. You can delete your own posts, and cooperating visitors will remove them, but we cannot force every copy to be deleted.
7. **Others may record IP addresses.** Anyone can join a swarm and record the addresses they see. We do not control this.
8. **Children.** `<Not directed to children / child-directed sites run host-only>`.
9. **Transfers.** `<Where hosts, trackers, STUN servers and resolvers are, and the transfer mechanism>`.
10. **Your rights.** Access, correction, erasure, objection, withdrawal of consent, and a complaint to `<supervisory authority>`. Contact `<privacy@...>`.
11. **Changes.** If this notice or the recipients change, we ask for your choice again.

Changes: the DoH row adds "IP address" (06 B3 lists only the name; DR 4.4 says the service "sees the site's name and the visitor's IP address"); the two "only if enabled" rows are new (03 R-09, 02 R10, 02 F33). Whether consent or an exemption is the right basis for each row is a counsel question (6.2 item 2; 04V claim 7; 06V claim 8).

**(c) What a visitor sees after a withdrawal or a block** (06 B2)

> **This content is no longer available here.**
>
> Reason: `<reason code in plain words>`. Reference: `<case or notice id>`.
>
> Your browser has stopped sharing it and has deleted its copy. Other visitors or other software may still hold copies that we cannot reach.
>
> If you think this is a mistake, contact `<ct>`. [Appeal]

**(d) Signed withdrawal record** (06 B9 reconciled with D13)

```
v=mw1; btih=0000000000000000000000000000000000000000; st=withdrawn; why=copyright;
ct=mailto:abuse@example.com; owner=<b64url P-256 key>; seq=<n+1>; exp=<unix>; sig=<...>
```

New loaders purge every stored version for the scope and stop seeding; loaders that predate `st` cannot fetch the zero infohash; devices that stay offline keep their copy until they reconnect (06 section 4, L0).

**(e) Denylist file** (`/_mw/deny.json`, ECDSA P-256 signature over the canonical JSON; 06 B9)

```json
{ "v": 1, "seq": 42, "exp": 1792000000, "entries": [
  { "k": "btih",  "h": "<sha256 of lowercase btih>",     "r": "copyright", "ref": "case-2026-0113", "t": 1791000000 },
  { "k": "file",  "h": "<sha256 of file bytes>",          "r": "malware",   "ref": "case-2026-0120", "t": 1791100000 },
  { "k": "label", "h": "<sha256 of lowercase hub label>", "r": "phishing",  "ref": "case-2026-0121", "t": 1791200000 } ],
  "sig": "<b64url>" }
```

**(f) What a notice must contain** (06 B5, condensed): the sender's physical or electronic signature; the work and the sender's right in it; where the material is (hub address or label, infohash, file path, and the block hash for a ledger post; a title alone is not enough); name, address and email; a good-faith statement that the use is not authorised; a statement under penalty of perjury that the notice is accurate and the sender is authorised; for the EU, a substantiated explanation of why the content is illegal. Notices containing a settlement offer or a demand for payment or personal information do not comply with Canadian rules and may be returned.

**(g) Replies** (06 B6)

> **Acknowledgement.** "We received your notice on `<date>` (case `<id>`). We will review it and tell you what we decide. If anything required is missing we will say what."

> **Deficient notice.** "We could not act on notice `<id>` because it does not yet identify `<missing item>`. We need the hub address or label, the infohash, and the file path or post hash. A work title on its own does not let us find content."

> **Counter-notice received.** "We received your counter-notice on `<date>`. We have sent it to the claimant. Unless they tell us they have started court action, we will restore access between `<date range>`."

**(h) `security.txt`** (06 B10)

```
Contact: mailto:security@example.com
Expires: 2027-06-30T00:00:00.000Z
Preferred-Languages: en, fr
Canonical: https://example.com/.well-known/security.txt
Policy: https://example.com/legal/security
```

**(i) README paragraph on takedown** (06 B11; part of the honesty layer, DR 24)

> There is no central place to delete a site. To remove content, the owner publishes a withdrawal; loaders that see it stop sharing and delete their copy, and gateways keep a signed block list that loaders honour. Devices that are offline keep their copy until they reconnect. Software that ignores these signals can still hold and share the files, and the same files can be published again under a new address. Peers, trackers and STUN servers can see visitors' IP addresses. We do not promote this service for infringing use.

## 10. Decision: Nostr mirroring for ledger durability

**Decision: v1.x, not v1.0 and not v2. It comes in two steps after the first release, it is pinner-published only, and the loader treats it as an untrusted cache. Visitor publishing to relays and Nostr signaling stay v2.**

**v1.0 floor (already specified, unchanged):** gossip among visitors, the host snapshot named by `cs=` (written by `pin.mjs --snapshot` or `tools/snapshot.mjs`; DR S2's acceptance is "a fresh visitor with no peers online sees every entry up to the snapshot"), and the pin nodes of 7.2. Nothing in v1.0 contacts a relay or a Blossom server.

**Step 1, v1.1: blob plane (P1).** `publish.mjs --blossom` uploads `site.torrent` and the ledger snapshot to at least three Blossom servers running different software (BUD-02, then BUD-04 mirrors), writes repeatable `xs=` and `cs=` lines, and a weekly keep-alive job re-mirrors any copy that returns 404 (02 R4, R5). The loader races two `cs` URLs with a header-free fetch and checks `sha256` when the URL names it (02 design sketch, step 2). Preconditions: P0-2, disclosure text (9.2 a and b), servers chosen by software and plan because free tiers may refuse `.torrent` or `.gz` files (02 F29, Gotcha 16), and `cs` made repeatable in the pointer grammar (02 R9).

**Step 2, v1.2: pinner relay plane (P1).** A pinner key `np` (secp256k1, a 0600 file on the pin host, never in a browser) publishes, for each ledger, one addressable checkpoint and the recent tail as wrapper events in dedicated kinds to at least five relays at each relay's tolerated pace, verifies by read-back after 60 s and repairs coverage (02 R6). The loader gets an optional read path: authors-first `REQ` filtered by `np`, a budgeted open supplement, and a completeness statement against the checkpoint ("in sync with checkpoint (height n)" or "n blocks behind", never "complete"), behind a Settings toggle "Use public relays as backup" that is off in drop-in mode and on in shell mode only after consent (02 R7, F33). **Entry criteria, all required:** (1) the write-acceptance test (02 R14) has been approved by Ash and run, and shows enough relays storing a 1.5-6 KB regular-kind wrapper from an unknown key; (2) dedicated kinds are drafted (the public NIP pull request also needs Ash) and used behind a config constant until accepted (02 R3); (3) relay-list management runs in CI before every release (02 R8); (4) pointer fields `np` and optional `rl` have signing vectors (02 R9); (5) relay and blob checks are in `check-site.mjs` (02 R11). **Acceptance** (02 R4, R6, R7): three blob servers of different software hold the files and deleting one copy still loads the site; after 24 h at least three relays return the full tail by `authors:[np]`; with every peer and tracker blocked, a fresh browser shows the pinner-published ledger from relays plus snapshot within 10 s on broadband; killing every relay changes nothing else.

**v2 (or never):** visitor publishing with throw-away keys, only for `writers:'open'` ledgers whose owners accept that relay copies persist (02 F34); Nostr signaling (D22); negentropy (02 R12; DR section 3); native secp256k1 identities (02 R18); nsite export and the multi-file blob-seed adapter (02 R15, R16).

| Evidence for doing it in v1.x | Source |
|---|---|
| Every block is already self-authenticating (hash, hashcash, signature), so commodity storage cannot corrupt the ledger; losing a relay or the pinner key changes speed and completeness, never integrity. | 02 Summary 1, design sketch failure table |
| A snapshot is about 3.1-3.9 MiB gzip at the 8 MiB cap, against 15.8-21.1 MB fetched event by event; relays need to carry only the pointer to the newest snapshot and the tail. | 02 F23 |
| Safari's 7-day eviction of script storage means returning iOS visitors need a cheap rebuild path that does not depend on the host alone. | 02 F23; DR 4.3 |
| Blossom fits immutable bulk: 5 of 6 public servers passed a real-browser Range fetch in Chromium; costs run from $0 free tiers to $18 a year. | 02 F29, F30, F35 |
| Large open relays serve custom kinds and large events today; replaceable events 365-409 days old exist on all five relays probed; a wrapper event (~1.5 KB typical, ~6 KB worst case) fits every relay found. | 02 F10, F12, Summary 5 |
| New pointer keys are kept and signed by v1 loaders, so both steps ship after v1.0 without breaking cached loaders. | ARCH 4; 02 R9 |
| It does not collide with DR's v2 list: the checkpoint here is an advisory pointer to a snapshot, verified by recomputing `root` from blocks, not the pruning checkpoint DR defers, and it serves durability, not discovery. | DR section 3; 02 design sketch step 6 |

| Evidence against doing it in v1.0 | Source |
|---|---|
| No write was ever performed: acceptance, rate limits and `OK` texts are unmeasured, and `OK true` can mean dropped (strfry `shadowReject`). | 02 F14, F36 |
| About 22% of relays reject strangers by design and 27.5% sit behind Cloudflare, so five relays are not five failure domains. | 02 F7, Gotcha 10 |
| Relay lists rot: only 38-58% of older Trystero lists still answer, so a hardcoded list fails within months. | 02 F11 |
| `limit` is clamped to 500 silently and EOSE gives no completeness hint; open `#t` reads are floodable. | 02 F13, F21 |
| Blossom retention is operator policy: 1 week unaccessed on reference defaults, 60 days on 24242.io. | 02 F29 |
| Kinds 30078 and 78 are the wrong container and new kinds need a public submission. | 02 F2, R3 |
| Relays learn the visitor's IP address, the page's `Origin`, the ledger id and timing; relay copies are outside the owner's takedown reach unless only a pinner key publishes. | 02 F33, F34 |
| The v1.0 floor already meets DR S2's acceptance without any relay. | DR S2 |

Cost: $0 with public relays and free Blossom tiers; about $18 a year for a paid relay plus Blossom plan; an owner-run strfry relay on Oracle Always Free costs $0 and is the only way to guarantee write acceptance and retention (untested here; 02 R17, F35). Public relays never receive bulk history: at a README-sample limit of 8 events a minute, a 10k-block ledger would take about 21 hours per relay, so history travels in the snapshot (02 F35).

## 11. Missing topic 07: performance engineering (placeholder latency model)

No `w2b-07` report exists. The raw material in `docs/research/labs/w2b-07-perf-lab/` (`p2p-timeline.mjs`, `eval-cost.mjs`, `ice-gather*.mjs`, `idb-bench.mjs`, `pc-cost.mjs`, `sha1-bench.mjs`, `sourcemap-breakdown.mjs`, outputs in `out/`) has not been reviewed, and nothing below cites it. The model below is what the architecture and the tree imply; every "unmeasured" cell is a measurement for topic 07.

### 11.1 Cold first visit (shell mode, per-domain, signed `<meta>` pointer, `ws=` and `xs=`, notice consent)

`T_visible = T_nav + T_boot + T_sw + T_ptr + T_ledger_open + T_xs + T_fill + T_store + T_mount`

| Stage | What happens | Bound or anchor today | Status |
|---|---|---|---|
| `T_nav` | DNS, TCP, TLS and HTML from the static host | host and network dependent | unmeasured |
| `T_boot` | `boot.js` feature checks, polyfills and CSP; `import('/_mw/loader.js')`; the WebTorrent bundle (222,929 bytes, 04V claim 8) is parsed and evaluated | none | unmeasured |
| `T_sw` | register `/mw-sw.js` and await `ready` (cap 15 s, `CONFIG.timeouts.swReadyMs`); shell mode reloads once if still uncontrolled (ARCH 5.2) | cap 15 s, plus one reload in the worst case | unmeasured on a first visit |
| `T_ptr` | parse the `<meta>` record and verify one P-256 signature (WebCrypto verifies about 18-19k per second on an M3, 02 F18); with a `<meta>` record, DoH is the update channel and does not block; a DNS-only pointer adds sequential DoH lookups (4 s cap per resolver, `CONFIG.timeouts.dohMs`, three resolvers) | under a millisecond with `<meta>`; up to about 12 s worst case for DNS-only | typical DoH latency unmeasured |
| `T_ledger_open` | the ledger node must open before the torrent is added, so its wire extension is ready (`app.js`, bounded by `CONFIG.ledger.nodeOpenMs` = 5 s) | cap 5 s | unmeasured |
| `T_xs` | fetch the `.torrent` from the host and check its infohash (cap 10 s, `CONFIG.timeouts.xsMs`) | one request | unmeasured |
| `T_fill` | bytes arrive from the web seed (starts at once, before consent) and from peers (only after consent: tracker connect 228-669 ms to the public four, 04 F27; announce; offer and answer relay; ICE; non-trickle offers wait for gathering or 5 s, and a dead ICE URL makes every offer wait 5 s, 03 F-21) | loopback: 18-85 ms for 01's fixture with `xs=` and `ws=` under failing trackers (01 F10); ARCH 12 E2E 7 targets a cold start within 3 s on loopback | real networks unmeasured |
| `T_store` | one Blob per file on `done`, then one IndexedDB transaction with every file (ARCH 5.4) | none | unmeasured |
| `T_mount` | iframe navigation through the SW; per-file piece verification (SHA-1) before the first serve (ARCH 7.3) | none | unmeasured |

**Properties that follow from the design (to confirm by measurement):**
1. **Mount waits for every file.** ARCH 5.4 writes all files in one transaction "when all files are done" and only then mounts; streaming before completion is v2 (DR section 3). Cold time-to-visible therefore grows with total site size, up to `maxSiteBytes` (128 MiB desktop, 48 MiB mobile on Wi-Fi, 24 MiB on cellular; ARCH 8), and the web seed alone sets the floor whenever no peer is faster.
2. **Peers help a cold first visit mostly with offload, not latency** (inference): they start only after consent and after the first wire, while the web seed starts at once, so on small sites the web seed usually finishes first.
3. **Failure paths dominate perceived latency:** a dead or slow ICE server adds 5 s to every non-trickle offer, and a tracker blip costs a median 174 s of tracker absence with the stock client (03 F-21; 01 F7). P0-3 and P0-6 are performance work as much as resilience work.
4. **A repeat visit needs no network to render:** verify `sha1(info)` once, mount immediately, verify each file before its first serve (ARCH 5.4).

### 11.2 Other paths

| Path | Model | Anchor |
|---|---|---|
| Repeat visit | `T_nav` (or the SW cache) + `T_boot` + infohash check + mount | 04 R5 proposes canary limits, not evidence: warm <= 2 s, offline reload <= 3 s, cold web seed <= 10 s (fail above 30 s) |
| Site update | pointer re-check per DNS TTL (at least 5 min) and on focus, then "Update available: reload" | ARCH 5.8 |
| Recovery from a bad SW deploy | next navigation, the browser's update check about 2 s later, install | healthy about 3 s after the next navigation in Chromium (05 F21, F24); Firefox and WebKit unmeasured |
| Ledger cold start | render first, then one snapshot GET (about 3.1-3.9 MiB gzip at the 8 MiB cap), P-256 verification in a two-worker pool (`CONFIG.ledger.verifierPoolSize`) | 02 F23; phone throughput unmeasured |
| Ledger write | 16-bit PoW mint: 39-49 ms with 5 Workers and 174-283 ms with 1 Worker on an M3 in Chromium 156 | 04V claim 5; phones unmeasured |
| Ledger propagation | gossip to other tabs and peers | unit test: A-B-C relay within 2 s; E2E: an entry shows in another tab within 10 s (ARCH 12) |
| Diagnosis | failure text on screen | within 5 s (DR S5; `CONFIG.ui.diagnoseAfterMs` = 5000) |

### 11.3 What topic 07 must measure

- p50 and p95 for every stage of 11.1, from the `performance.mark` timeline of P0-8 (`mw:boot`, `mw:sw-ready`, `mw:pointer`, `mw:first-wire`, `mw:metadata`, `mw:done`, `mw:saved`, `mw:site-visible`).
- A matrix: site sizes of 1, 10, 48 and 128 MiB; cold, warm and offline; web seed only, peers only and mixed; Chromium, WebKit and Firefox; desktop broadband, a mid-range Android phone on LTE, an iPhone on Wi-Fi.
- Unit costs: bundle parse and evaluation on a mid-range phone, `RTCPeerConnection` creation, SHA-1 throughput, IndexedDB Blob writes, PoW minting on phones, `getStats()`.
- Budgets set after measuring, not before: time-to-site-visible for cold web-seed loads by site size, the offload ratio at which peers pay for their latency, and a JavaScript byte budget for the loader.
