# w2b-03 - TURN and connectivity at scale: how many visitors fail P2P, and what to do

> **STATUS: FINAL (2026-10-17).** Companion lab and re-runnable scripts: `docs/research/labs/w2b-03-turn-connectivity-lab/`.

- **Topic:** connectivity for a static, backend-less WebTorrent-over-WebRTC website loader (magnet-web): published success/failure data, NAT/CGNAT/IPv6 reality, TURN providers (Cloudflare Realtime, Metered Open Relay, Twilio, others) and self-hosted coturn, owner-supplied TURN credentials in the pointer record, relay-only policy, browser IP handling, data-channel throughput on mobile, and how the loader should measure and show connectivity.
- **Research date:** 2026-10-17. "Current" means that date. Sources are 2024-2026 unless flagged `[OLD: year]`.
- **Run note (resumed after an interruption):** `docs/research/w2b-03-turn-connectivity.md` did not exist at the start and the scratchpad held only another topic's notes, so this run started clean from the project state and the earlier wave's `03-webrtc-nat-privacy.md`. The shared WebSearch budget (200 per turn, all agents) ran out after 12 searches of mine; the 13th was refused. From then on I used only **direct fetches of known primary URLs**; I did not work around the limit. Things that would have needed a search are listed under Open questions (for example: Daily.co's own relay statistics, a Cloudflare spending-cap page, Metered's terms of service).
- **What is new relative to `03-webrtc-nat-privacy.md` (2026-10-14):** (1) own loopback experiments on the project's pinned stack (Chromium 156.0.8078.4, Playwright WebKit 27.2, `@thaunknown/simple-peer` 10.1.2, `bittorrent-tracker` 11.2.3, `webtorrent` 3.0.21), reproducible from `docs/research/labs/w2b-03-turn-connectivity-lab/`; (2) Cloudflare TURN pages not read before (analytics, credential tagging, custom domains, feature matrix, terms of service); (3) a cost model; (4) coturn's July-September 2026 security record; (5) APNIC IPv6 numbers for named mobile carriers; (6) the Snowflake paper's NAT-compatibility matrix; (7) the owner-supplied-credential threat model; (8) a tested browser-only NAT-hardness probe.
- **Companion files:** lab = `docs/research/labs/w2b-03-turn-connectivity-lab/` (fake STUN/TURN servers, probe page, runner, results JSON, cost model; `run-lab.sh` re-runs everything on loopback only). Overlapping siblings: `w2b-04-observability-no-backend.md` (telemetry/diagnostics design; independently measured the same 39.9 s dead-STUN timeout), `w2b-06-abuse-legal-ops.md` (recipients register; STUN/tracker operators), `03-webrtc-nat-privacy.md` (baseline facts, carried over and not re-read are listed in Appendix D).
- **Confidence scale:** **high** = read in a primary source and/or reproduced here; **medium** = one good source, a vendor page extracted by a summarising fetch (all prices and plan limits are medium: they change), or an inference from primary facts; **low** = secondary or unsourced. Anything I could not verify is marked **unverified**. `[DESIGN-CRITICAL]` = would change the architecture or a compatibility promise if wrong. "Inference" always means my reasoning, not a source's statement. Quoted strings from pages read through the summarising fetch tool are "as extracted" and may differ in minor wording from the page; verbatim reads (markdown or text downloaded and grepped) were done for the Cloudflare Realtime docs and terms, the Metered docs, the Snowflake PDF, RFC 8656, the libwebrtc and Tailscale sources, and the `node_modules` sources.

---

## Summary

1. **Nobody has published a rigorous, recent measurement of how many browser WebRTC data-channel pairs need a relay `[DESIGN-CRITICAL]`.** The only first-party datapoint with a sample is old: callstats.io via webrtcHacks (published 2016-04-08, data Jan 2015-Feb 2016): **22 %** of conferences needed a relay and about **9 %** needed relay over TCP [OLD: 2016]. Everything newer is an estimate: Twilio "around 85 %" solved by STUN alone (undated marketing page), Enable Security "roughly 5-30 %" (2026-02, unsourced), Fora Soft "15-25 %" (2026-10-12, explicitly its own estimate). Non-WebRTC but rigorous: libp2p DCUtR **70 % +/- 7.1 %** conditional hole-punch success over 4.4 M attempts (arXiv 2025-10-31, IMC '26), and Tailscale "well north of 90 %" direct (2025-10-15) using tricks browsers cannot use. **Plan for 10-30 % of peer pairs needing a relay or a non-WebRTC path, much more for UDP-blocked or policy-restricted visitors, and replace the guess with the loader's own telemetry.** I found no Daily.co, Twilio-Video or LiveKit measurement.
2. **Failure is a property of the pair, not of the visitor `[DESIGN-CRITICAL]`.** The Tor Snowflake paper (USENIX Security 2024) gives the STUN-only compatibility matrix: a pair fails if and only if one side has endpoint-dependent (ED, "symmetric") mapping and the other has ED mapping or address-and-port-dependent filtering. An easy-NAT or public-IP peer therefore connects to everybody. Snowflake keeps connectivity high (average **1.01 rendezvous attempts** per client in March 2024) although "unrestricted proxies are a relatively small fraction" of the pool, because its broker matches by NAT type. **Consequence: one or two always-on seeders on public IPv4/IPv6 addresses work like free TURN servers for hard-NAT visitors.**
3. **TURN is an optimisation here, never a correctness requirement, and relaying bulk bytes rarely pays `[DESIGN-CRITICAL]`.** The web seed is the correctness path. Cloudflare TURN costs $0.05/GB after 1,000 GB/month (billed on bytes sent to the TURN client); CloudFront costs $0.085/GB after the first TB (1 TB/month free); Cloudflare Pages' limits page states no bandwidth charge or cap, and GitHub Pages has a 100 GB/month soft limit instead of a price. Relaying a byte through TURN costs about as much as fetching it from a CDN, and nothing when the host's egress is free. Relay the control plane (chain gossip, requests) and let bulk bytes come from the web seed when the only peer path is a relay. Cost model: Appendix C.
4. **Cloudflare TURN cannot be used from a static page without a secret-holder, and its terms are ambiguous for this use `[DESIGN-CRITICAL]`.** TURN keys "cannot be used as credentials"; every client needs a short-lived credential (max 48 h, 96-hex username + 96-hex credential) minted with a server-held bearer token; there is no static-credential option. The service-specific terms license Realtime "to enable video call functionality for your Internet Properties"; they say nothing about relaying data-channel traffic for website delivery, allow Cloudflare to limit "concurrent video calls", and make the customer "solely responsible for all content transmitted". No spending cap is documented in the pages I read. A Worker that mints credentials fits the free plan (100,000 requests/day), but it is a (tiny) backend of ours.
5. **Alternatives, with the catches:** Metered Open Relay: 20 GB/month free, a credential-scoped `apiKey` documented as "safe for front-end use", recommended rotation 48 h / 24 h by a scheduled back-end job, new credentials take up to 2 minutes to propagate, quota-per-project controls only on Business/Enterprise. ExpressTURN: free plan "limited to 1000 GB of traffic per month" with static long-term username/password (TCP/UDP 3478 only on free), terms of service almost empty. Twilio: $0.40/GB (US West, Germany) to $0.80/GB, no free TURN, token TTL max 24 h. Xirsys: free tier 500 MB hard cap. Self-hosted coturn: no published benchmark, NIC-bound, and a heavy 2026 security record (ten advisories on the first of three advisory pages, published 2026-07-24 to 2026-08-05, three of them High; coturn 4.18.0, listed as "08 Sep" with no year on the releases page (2026 inferred), removed three flags).
6. **The pinned stack turns a dead ICE server into a 5-second stall on every announce (measured) `[DESIGN-CRITICAL]`.** `bittorrent-tracker` creates tracker peers with `trickle: false` and waits for **all** (up to 5) offers before announcing; `simple-peer` releases an offer on gathering-complete or **5 s** after the first candidate. In Chromium 156 a blackholed TURN (UDP or TCP) or a closed UDP port keeps `iceGatheringState` at `gathering` for **39.95 s**; a simple-peer offer took **5003 ms** (vs 124 ms with a working TURN). Cloudflare's own docs warn about the same effect for non-trickle ICE (the alternate port 53 URL). Gate TURN behind a probe, trim the URL list, and shorten the timeout.
7. **Every RTCPeerConnection with a TURN URL allocates (measured).** Chromium 156 and WebKit 27.2 sent Binding + Allocate (401) + Allocate (authenticated) + Refresh(0) per connection per TURN/UDP URL, even though host/srflx candidates would have sufficed. WebTorrent creates up to 5 offer connections per tracker every 30 s: with 2 trackers and 1,000 concurrent visitors that is about **333 new connections/s and ~1,300 TURN requests/s** if TURN is on for everyone (model, Appendix C). Make TURN **adaptive**: only visitors whose probe says "hard NAT" or "UDP blocked" add TURN, and only when needed.
8. **Hard NAT is detectable in the browser with no backend (measured and sourced).** Two STUN servers on different IPs give two server-reflexive candidates with different ports when mapping varies by destination; identical mappings collapse into one candidate. Verified with fake servers in Chromium 156 (mDNS default and disabled) and WebKit 27.2; same logic as Tailscale's `netcheck` `MappingVariesByDestIP`. A reference probe (`connectivity-probe.js`, tested on loopback fakes) classified easy/hard in 116-131 ms in Chromium 156, hard in 159-224 ms and "easy, probable" in ~0.8 s in WebKit 27.2, and gives up at its 2.5 s budget when UDP is dead. It cannot see filtering type, IPv6 capability without AAAA-capable STUN hosts, or any server-side NAT test (Snowflake needs a central test peer for proxies).
9. **IPv6 helps mobile most (APNIC Labs, 2026-10-16, 30-day average):** world 43.6 % IPv6-capable; T-Mobile USA 94.3 %, Verizon Wireless 94.8 %, Jio 96.1 %, Rogers 90.8 %, AT&T Mobility 87.0 % (small sample), Telus 83.6 %, Bell Canada 10.4 %. No measurement of the effect on ICE success exists in what I could read; Cloudflare and Google STUN/TURN hostnames have AAAA records, Twilio's and Metered's do not.
10. **UDP-disabled browsers need TCP/TLS TURN or nothing (measured).** With Chromium's `disable_non_proxied_udp` policy (the policy Brave and several extensions expose), Chromium 156 produced no host and no srflx candidates, and only TURN-over-TCP relay candidates; UDP TURN gave nothing. Include one `turns:...:443` URL if TURN is offered at all.
11. **Owner-supplied credentials in the signed pointer: do not `[DESIGN-CRITICAL]`.** The record is public, cached by DNS TTLs (Cloudflare DNS minimum 60 s per `05-doh-dns-txt.md`), limited to 255-byte strings and about 1,200 bytes per RRset in practice, and any rotation would force re-signing with the owner key. Put credentials in a separate same-origin document (`/.well-known/...`) refreshed by a scheduled job, signed pointer carries at most a flag, hub-mode and unsigned pointers ignore it, and run a budget fuse (analytics poll + revoke). Treat the credential as public by design: the protection is the provider quota, the TTL and monitoring (RFC 8656 section 21; Enable Security 2026; Cloudflare's "monitor for credential abuse").
12. **Relay-only privacy mode costs 3-7x more relayed bytes than ICE-decides and has a dead-TURN failure mode (measured).** With `iceTransportPolicy: "relay"` and a dead TURN, a simple-peer offer arrived after **39.95 s** with zero candidate lines (the 5 s timer only starts at the first candidate); with no TURN configured it is emitted at once but contains no candidates. At 3 MB/visit and 50 % peer-sourced, relay-only relays ~1.55 MB/visit ($77.50 per extra million visits at Cloudflare rates) versus ~0.23-0.47 MB when only failing pairs relay.
13. **Data channels are dcSCTP-only now, and the processing ceiling is far above mobile networks.** libwebrtc `main` creates only `DcSctpTransport`; defaults: packet MTU 1191 B, 5 MiB receive window, initial congestion window 10 MTUs, heartbeat 30 s, message interleaving off. Measured loopback ceiling in headless Chromium 156: 16-64 KiB messages reach **~31-33 MB/s (~263 Mbps in the reference run)**; 1 KiB messages are load-sensitive (21.8 and 3.9 MB/s in two runs). Cloudflare limits a single allocation to roughly 50-100 Mbps and 5-10 kpps. Real mobile throughput is loss/RTT-limited and was not measured here.
14. **Diagnostics:** `icecandidateerror` is Baseline since April 2026 (Chrome 77, Safari 14.1, Firefox 150). Code 701 means no host candidate can reach the server. Use "STUN OK = at least one srflx; TURN OK = at least one relay candidate; UDP blocked = no srflx and no relay within the budget" and show NAT class, IPv6, selected-pair type, relay share. Telemetry design is in `w2b-04`.

---

## Findings

Each finding: claim, confidence, design-critical flag, evidence, sources with the source's date. Source ids `[S#]` are resolved with full URLs in Appendix A. `F-xx` numbers are stable references used by the recommendations.

### A. How many visitors fail P2P

**F-01. No rigorous recent public measurement of browser-WebRTC relay share exists; the circulating figures are vendor estimates or 2016 data, clustering at 10-30 % of sessions for consumer traffic.**
- Confidence: medium that the cluster is right; low for any single number. Design-critical: **yes** (a non-WebRTC path for failing pairs is mandatory; the project's own telemetry must replace the guess).
- Evidence:
  - callstats.io data published by webrtcHacks on **2016-04-08** (period Jan 2015-Feb 2016, 100+ customers, "billions of minutes"): "22% of the conferences need some kind of TURN relay server"; "About 9% of the conferences required TCP"; "most failures (85%) come from the inability of an endpoint to traverse NATs or firewalls". The unit is a *conference*, not a connection, and some customers deployed no TCP/TLS relay, so failures are partly a deployment artefact [S31] [OLD: 2016].
  - No Jitter (2016-06-06), same speaker: "Of those failed calls, 22% required some form of media relay" - a different statement (share of *failed* calls), which shows how the headline number got garbled [S32] [OLD: 2016].
  - Tsahi Levent-Levi, discuss-webrtc thread started 2018-06-20: large vendors he spoke to report about 20 % relay traffic, some over 30 %, depending heavily on where customers are and how they connect (paraphrase); the thread's "30 %" came from a 2017 callstats post [S33] [OLD: 2018].
  - Twilio's STUN/TURN page (undated, footer 2026): "around 85% of the time that's all you need to get your media to flow directly" [S17].
  - Enable Security, 2026-02-12: "TURN is used in roughly 5-30% of WebRTC sessions, depending on network and NAT conditions" (no source given) [S36].
  - Fora Soft, 2026-10-12: "roughly 15 to 25 percent of sessions fall back to TURN", "close to 100%" for AI voice agents and IoT behind carrier-grade NAT; the article does not tie the figure to a measurement [S34].
  - Cloudflare publishes no relay-share figure either: its TURN launch blog (2024-09-25), overview and FAQ contain none [S9][S1][S2].
  - Not found (search budget exhausted, so not proven absent): any first-party Daily.co, Twilio Video or LiveKit measurement. LiveKit's docs only state the fallback order (UDP, TCP, then TURN) and how to force relay (search-result level, not fetched).
- Reading: the planning range is **10-30 % of peer pairs** for consumer populations, higher for corporate networks and CGNAT-heavy mobile populations, and nearly 100 % for UDP-blocked visitors. These are hypotheses to be replaced by the loader's own funnel (R-10).

**F-02. The best modern hole-punching numbers are not WebRTC: libp2p DCUtR reports 70 % +/- 7.1 % (conditional); Tailscale reports "well north of 90 %" direct using tricks browsers cannot use.**
- Confidence: high that the sources say this (abstracts re-read today); medium as proxies. Design-critical: no (context for expectations).
- Evidence:
  - arXiv 2510.27500 v1 (submitted 2025-10-31): "over 4.4 million traversal attempts", "85,000+ distinct networks", "167 countries", "a contemporary baseline success rate of 70% +/- 7.1%" for the hole-punching stage, "statistically indistinguishable" for TCP and QUIC. The IMC '26 version (arXiv 2604.12484, submitted 2026-04-14, ACM IMC 2026-10-12..16 in Karlsruhe) states the rate is conditional on relay reservation and public-address discovery succeeding, and that 97.6 % of successes happen on the first attempt. Neither abstract mentions IPv6, mobile or NAT types [S27].
  - Tailscale, 2025-10-15: "Internal metrics" put direct NAT traversal "well north of 90%" in typical conditions; symmetric NAT is "the biggest culprit"; cloud NAT gateways "prioritize scalability and security over hole-punching friendliness" [S28]. Tailscale's 2020 post explains that for two hard NATs it needs about 170,000 probes per side for a 99.9 % chance [S29] [OLD: 2020]; browsers expose no socket control, so they cannot do this (inference).
- Reading: a browser-only system should expect to land below Tailscale's number and cannot be compared with DCUtR without a NAT-type breakdown (none published).

**F-03. STUN-only compatibility is a pairwise matrix; easy-NAT and public peers connect with everybody; NAT-aware matching keeps a mostly-restricted pool usable (Snowflake, USENIX Security 2024).**
- Confidence: high (paper read; table and quotes). Design-critical: **yes** (justifies public always-on seeders as universal peers and a NAT-class probe).
- Evidence: Table 1 of the paper, "assuming the use of STUN only (no fallback to TURN)": "The incompatible cases are when one peer has ED mapping and the other has ED mapping or AP filtering" (ED = endpoint-dependent, AP = address-and-port-dependent). My rendering:

  | peer A \ peer B | EI mapping, EI/AO filtering | EI mapping, AP filtering | ED mapping ("symmetric") |
  |---|---|---|---|
  | EI mapping, EI/AO filtering | connects | connects | connects |
  | EI mapping, AP filtering | connects | connects | **fails** |
  | ED mapping | connects | **fails** | **fails** |

  Snowflake clients self-assess with the RFC 5780 NAT-behaviour-discovery feature of STUN; **proxies written in JavaScript cannot, "because the necessary STUN features are not exposed to JavaScript"**, so Snowflake runs "a centralized, always-on WebRTC testing peer behind a simulated NAT with endpoint-dependent mapping" (technique adopted from MassBrowser) and the broker "avoids making matches that would require TURN". "Unrestricted proxies are a relatively small fraction of the proxy population" (Figure 3), yet "as of March 2024, the average client needs 1.01 rendezvous attempts to find a compatible proxy" [S26].
- Inference for magnet-web: our trackers cannot match peers, but (a) a visitor can classify itself (F-20), (b) a few always-on public seeders are compatible with every visitor, and (c) a hard-NAT visitor needs a relay only to reach port-restricted or hard peers, not to reach public ones.

**F-04. Swarm size, not NAT, decides first: most sites have almost no concurrent visitors, so P2P usually finds no peer and the web seed or an always-on seeder is the baseline.**
- Confidence: medium (arithmetic on assumed arrivals; real traffic is bursty). Design-critical: **yes** (sets expectations for what TURN can add).
- Arithmetic (Little's law, average concurrency = visits per second x dwell seconds; 60 s dwell, uniform arrivals - both assumptions): 1,000 visits/day -> **0.7** concurrent; 10,000/day -> **6.9**; 100,000/day -> **69**; 1,000,000/day -> **694**.
- Pair-failure bounds from F-03 (inference): if a share *h* of peers has ED mapping, the fraction of random pairs that fail without a relay is at least h^2 and at most 2h - h^2 (every other peer filtering by port). For h = 0.2 that is 4-36 %; for h = 0.4, 16-64 %. If failures were independent per pair, the chance that a visitor has *no* usable peer among n is p^n: for p = 0.2, n = 3 -> 0.8 %; for p = 0.36, n = 3 -> 4.7 %, n = 1 -> 20-36 %. Independence is generous: a hard-NAT visitor fails with *all* hard peers at once.

**F-05. Cellular networks: CGNAT is ubiquitous and often endpoint-dependent, but there is no fresh public percentage (the last numbers are from 2014-2016).**
- Confidence: medium. Design-critical: **yes** (mobile-to-mobile IPv4 pairs frequently need a relay or IPv6).
- Evidence: Cloudflare (2025-10-29, modified 2026-07-15) built a CGNAT detector (traceroutes through `100.64.0.0/10` from more than 9,000 RIPE Atlas probes; a labelled set of more than 200K CGNAT IPs; classifier accuracy 0.98) and says CGNAT is "common in mobile networks" and heavy in Africa, South Asia and parts of Central and Southeast Asia, but **publishes no prevalence share** [S12]. Tailscale (2025-10-15) lists carrier-grade NAT gateways as typically symmetric with short port timeouts, without numbers [S28]. The quantitative figures remain Richter et al., IMC 2016 (more than 90 % of cellular ASes use CGN; about 40 % of cellular CGNs symmetric), carried over from `03` and not re-read [OLD: 2016].
- The only 2024 deployment data on the NAT mix of browser/WebRTC volunteers is Snowflake's: restricted proxies (endpoint-dependent mapping, or mapping unknown) far outnumber unrestricted ones ("Unrestricted proxies are a relatively small fraction of the proxy population", Figure 3), but the paper prints no percentage and its "restricted" class also contains unknowns [S26].
- I could not find a 2024-2026 study of cellular NAT mapping behaviour (the one search for it returned only the 2011 Tribler study, not opened, and forum posts).

**F-06. IPv6 is now the majority at the big mobile carriers, which makes mobile-to-mobile direct paths plausible; the effect on ICE success is unmeasured in what I could read.**
- Confidence: high for the adoption numbers (primary APNIC series, fetched today); low for any success-rate effect. Design-critical: no (opportunity, not a dependency).
- Evidence: APNIC Labs per-economy and per-AS series `https://stats.labs.apnic.net/cgi-bin/json-table-v6.pl?x=<CC or CC+ASN>`, latest point 2026-10-16, 30-day smoothing, "IPv6 capable %" / "IPv6 preferred %" [S35]:

  | Population | capable | preferred | note |
  |---|---|---|---|
  | World (XA) | 43.6 | 40.9 | |
  | United States | 62.0 | 59.9 | |
  | Canada | 45.1 | 43.4 | |
  | India | 76.4 | 73.9 | |
  | Germany / France / United Kingdom | 72.7 / 85.7 / 54.3 | 70.6 / 84.8 / 53.4 | |
  | Brazil / Japan | 59.6 / 62.0 | 58.2 / 59.6 | |
  | AS21928 T-Mobile USA | 94.3 | 93.2 | mobile |
  | AS6167 Verizon Wireless | 94.8 | 93.8 | mobile |
  | AS20057 AT&T Mobility | 87.0 | 86.0 | only 6,797 samples (30-day mean): low weight |
  | AS55836 Reliance Jio | 96.1 | 93.7 | mobile |
  | AS812 Rogers | 90.8 | 89.2 | mixed fixed + mobile |
  | AS852 Telus | 83.6 | 79.6 | mixed |
  | AS577 Bell Canada | 10.4 | 8.9 | mixed; very low |

  "Capable" means the measured client fetched an IPv6-only object; it does not say how the carrier handles inbound IPv6 or whether the device has a *global* IPv6 address (T-Mobile US is IPv6-only with 464XLAT, per the ISOC case study seen in a search result, not fetched).
- Inference: two independent IPv6-capable endpoints could connect over IPv6 without NAT, but stateful firewalls still need the simultaneous-open pinhole that ICE creates, and an enterprise firewall can block it (Tailscale 2020: "IPv6 isn't *yet* the solution to our problems" [S29] [OLD: 2020]). If capability were independent, a random pair is both-IPv6 with probability p^2: world 0.44^2 = **19 %**, United States 0.62^2 = **38 %**, two users on T-Mobile, Verizon or Jio about 0.94-0.96 squared = **89-91 %**.
- DNS facts that matter for gathering over IPv6 (Cloudflare DoH, 2026-10-17): `stun.cloudflare.com` AAAA `2606:4700:49::`, `stun.l.google.com` AAAA `2001:4860:4864:5:8000::1`, `turn.cloudflare.com` AAAA `2a06:98c1:3200::1`; `global.stun.twilio.com`, `global.turn.twilio.com`, `global.relay.metered.ca` and `stun.relay.metered.ca` have **no AAAA record** (CNAME chains to IPv4-only names) [S49]. Cloudflare TURN accepts IPv6 clients but "does not issue relay addresses in IPv6" [S2], so a relay is always reachable over IPv4 only (what an IPv6-only NAT64 peer can do with it is unverified).

**F-07. Visitors under a UDP-disabled WebRTC policy can only use TURN over TCP/TLS (measured), and no TURN means zero candidates.**
- Confidence: high (reproduced, Chromium 156). Design-critical: **yes** for the TURN URL list (one `turns:` URL on 443 is mandatory if TURN is offered).
- Evidence: with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (the Chromium value of `chrome.privacy` `webRTCIPHandlingPolicy: "disable_non_proxied_udp"`, which Brave's "Disable non-proxied UDP" corresponds to per `03`): no host candidate, no srflx candidate, `turn:...?transport=udp` yields nothing, `turn:...?transport=tcp` yields a relay candidate with `relayProtocol: "tcp"` after 67-68 ms (loopback); with no TURN the SDP contains no candidate line at all (458 bytes). Gathering completes in ~120 ms because there is nothing to wait for [S51] (`results/res-noudp.json`). The value list of the policy comes from the Chrome extension API page [S45]; Brave's default policy remains unresolved: `brave_profile_prefs.cc` on `master` (2026-10-17) sets no default for the WebRTC IP-handling pref (it only sets WebRTC log prefs) [S46], which weakly supports "Chromium default" over the wiki's claim in `03` F-24.
- Prevalence of such visitors is unknown.

### B. TURN providers, pricing and credentials

**F-08. Cloudflare Realtime TURN: endpoints, price, limits and relay properties (docs pages updated 2026-04 to 2026-10).**
- Confidence: high (the Cloudflare Realtime TURN pages were read as markdown today; prices are vendor-page medium by the scale above). Design-critical: **yes**.
- Endpoints (overview table) [S1]: STUN `stun.cloudflare.com` 3478/udp; TURN `turn.cloudflare.com` UDP 3478 (alt 443), TCP 3478 (alt 80), TLS 5349 (alt 443). The service runs in "all of the 330 cities where Cloudflare has data centers", "approximately 95% of the Internet-connected population globally is within approximately 50ms" of a location (blog 2024-09-25, modified 2026-07-15) [S9]. Excludes Cloudflare's China Network [S2].
- Price [S2][S8]: "$0.05 per GB", billed on "data sent from the Cloudflare edge to the TURN client ... including TURN overhead, following successful authentication"; client-to-server traffic is free; TURN-to-SFU/Stream traffic is not charged; "The first 1,000 GB each month is free. SFU and TURN share this allowance" (pricing page updated 2026-09-22). The overview page [S1] still says TURN is "free of charge when used together with the Realtime SFU" and otherwise "$0.05/real-time GB outbound"; the FAQ and pricing page are the more specific and are used here. STUN at `stun.cloudflare.com` is "free and unlimited" [S2].
- Per-allocation limits [S1]: "Unique IP address you can communicate with per relay allocation (>5 new IP/sec)", packet rate ">5-10 kpps", data rate ">50-100 Mbps"; "Each limit is for a single TURN allocation (single TURN user) and not account wide"; exceeding them "will result in packet drops".
- Relay properties [S2][S7]: relay addresses are IPv4 only (`REQUESTED-ADDRESS-FAMILY` ignored); "Realtime does not implement RFC6062" (no TCP allocations to peers); `CreatePermission`/`ChannelBind` are denied for private ranges (loopback, link-local, multicast) and BYOIP; no RFC 7635 OAuth; STUN ORIGIN and ALPN (RFC 7443) supported. Firewall allow-list: `2a06:98c1:3200::1`, `2606:4700:48::1`, `141.101.90.1`, `162.159.207.1`; without an enterprise contract the DNS answers of `turn.cloudflare.com` must be watched and the list updated "within 14 days". "TURN allocations may be disrupted" by maintenance or topology change, so "ICE restart support by clients is highly recommended".
- Custom hostname: a CNAME to `turn.cloudflare.com` works for UDP and TCP, not TLS; no extra charge [S6].

**F-09. Cloudflare credentials: a server-held secret is required, there is no static option, and the documented lifetimes are inconsistent.**
- Confidence: high for the quoted rules; medium for the effective TTL cap. Design-critical: **yes** (breaks "no backend of ours" unless a scheduled job or a Worker is accepted).
- Evidence [S3][S2][S4]:
  - "Cloudflare will issue TURN keys, but these keys cannot be used as credentials with `turn.cloudflare.com`." "A TURN key is a long-term secret that allows you to generate unlimited, shorter lived TURN credentials"; "keep your TURN key on the server side (don't share it with the browser/app)".
  - `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers`, header `Authorization: Bearer $TURN_KEY_API_TOKEN`, body `{"ttl": 86400}` -> **201** with `iceServers`: one STUN entry and one TURN entry whose `urls` are `turn:turn.cloudflare.com:3478?transport=udp`, `:443?transport=udp`, `:3478?transport=tcp`, `:80?transport=tcp`, `turns:...:5349?transport=tcp`, `turns:...:443?transport=tcp`; in the example `username` and `credential` are **96 hex characters each**.
  - Note in the page: "The alternate port 53 is known to be blocked by web browsers, and the TURN URL will time out if used in browsers. If you are using trickle ICE, this will not cause issues. **Without trickle ICE you might want to filter out the URL with port 53 to avoid waiting for a timeout.**" (our tracker peers are non-trickle; see F-21).
  - FAQ: "You can set a expiration time for a credential up to 48 hours in the future"; but the replacement guide's example uses `"ttl": 864000` (10 days) on `.../credentials/generate` together with `"customIdentifier": "user4523958"`. **Which is enforced is unverified.** After expiry mid-session "Cloudflare Realtime will immediately stop billing ... After a short delay, the connection will be disconnected."
  - Revocation: `POST .../credentials/$USERNAME/revoke` -> 204. Up to **1,000 TURN keys** per account, unlimited credentials per key; `customIdentifier` tagging per credential "to aggregate usage"; "If you share TURN credentials with end users, credential abuse is possible. You can monitor for abuse by tagging each credential with custom identifiers and monitoring for top custom identifiers ... via the GraphQL analytics API."
  - Issuance etiquette: "There is no defined limit for credential issuance. Start at 500 credentials/sec and scale up linearly. **Ensure you use more than 50% of the issued credentials.**" -> mint lazily, not on every page load.
  - Refresh in session: `RTCPeerConnection.setConfiguration()` (Chrome 48, Firefox 99, Safari 11 per BCD [S43]).
  - Analytics [S5] (page updated 2026-06-03): GraphQL only (`https://api.cloudflare.com/client/v4/graphql`, token permission "Account Analytics"), dataset `callsTurnUsageAdaptiveGroups`, metrics `egressBytes`, `ingressBytes`, `concurrentConnections`, dimensions time buckets, datacenter, `keyId`, `customIdentifier`, `username`; usage visible "in 30 seconds"; adaptive sampling, so per-customer billing queries must be one query per customer [S4].

**F-10. Cloudflare's terms license Realtime "to enable video call functionality"; relaying a website-delivery data channel is not addressed `[DESIGN-CRITICAL]`.**
- Confidence: high that the text says this (read verbatim from the HTML); medium on the legal reading; no spend cap found. Design-critical: **yes** (a suspension or a "no" answer removes the cheapest provider).
- Evidence: Service-Specific Terms, Developer Platform page (fetched 2026-10-17; the fetch tool reported "September 28, 2026" as last-updated) [S10]. Section "Cloudflare Realtime": "you may use Cloudflare Realtime, including relevant APIs, SDKs and documentation, to enable video call functionality for your Internet Properties"; Cloudflare "may, with or without notice ... temporarily limit the number of concurrent video calls that you or your End Users may conduct ... including ... if processing such video calls would put an undue burden on the Cloudflare network"; "You may not use Cloudflare Realtime to operate or enable any telecommunications service"; content "illegal or harmful may be blocked or removed", including content that "infringes on another person's intellectual property rights"; "You will remain solely responsible for all content transmitted using Cloudflare Realtime." Nothing mentions TURN, data channels, peer-to-peer file sharing or BitTorrent-style traffic.
- No hard spending cap, per-key rate limit or acceptable-use text for file sharing appears on any Realtime page I read (overview, FAQ, credentials, analytics, matrix, pricing). Account-level billing alerts probably exist but were not checked (unverified).
- Reading: using it for chain gossip and site bytes is arguably outside "video call functionality"; ask Cloudflare in writing (or buy an enterprise plan) before making it a default (R-09).

**F-11. A credential-minting Worker is nearly free, but it is a backend of ours.**
- Confidence: high for the quotas (page updated 2026-10-02); medium for sufficiency. Design-critical: no.
- Evidence [S11]: Workers Free = 100,000 requests/day, 10 ms CPU per invocation; Paid = $5/month minimum, 10 million requests included, $0.30 per extra million, 30 million CPU-ms included. A mint request is one subrequest to `rtc.live.cloudflare.com`. `w2b-04` (F37) notes the Free quota is shared with Pages Functions. The Worker must protect its own endpoint (Enable Security: "Unprotected credential endpoints are the core risk" [S36]) - for an anonymous public site the available controls are per-IP rate limits and short TTLs, not authentication.

**F-12. Metered Open Relay: 20 GB/month free; a credential-scoped `apiKey` is documented as safe for front-end use; rotation, propagation and plan caps are the catches.**
- Confidence: high for the docs; **unverified**: behaviour at quota exhaustion, terms of service (the guessed `/terms-of-service` URL returned 404). Design-critical: **yes** (the only provider whose docs endorse client-side credential fetching).
- Evidence [S13][S14]: "The TURN Server provides 20 GB of free TURN Usage every month"; sign-up and an API key are required; `GET https://<app>.metered.live/api/v1/turn/credentials?apiKey=API_KEY` returns the ICE array; ports 80 and 443, UDP/TCP/TLS; "No bandwidth caps per allocation". Free plan = `standard.relay.metered.ca` only; regions are paid. Key types: `secretKey` ("Never expose it in front-end code"), credential-scoped `apiKey` ("safe for front-end use ... used only with the Get Credential API"), `projectApiKey`. Credentials can carry `expiryInSeconds` (**hard cutoff, also for calls in progress**); recommended scheme "48 hour lifetime, rotated every 24 hours" by "a scheduled back-end job"; "One credential can serve many calls - no need for per-call or per-user credentials"; **a new credential "takes up to 2 minutes" to propagate** ("an authenticated Allocate can be rejected and no relay candidate is gathered"); leak response = disable or delete that `username`, create a replacement, expect up to 2 minutes; every plan caps simultaneously active credentials (value not stated; "403 Maximum credential limit reached"); **Projects with per-project `quotaInBytes` and `quotaExceededAction` (disable | notify | none) are Business/Enterprise only**; several usage endpoints return errors on the free plan. `staticauth.openrelay.metered.ca` with the published secret `openrelayprojectsecret` exists for Nextcloud/Matrix-style static auth - a public secret, so no private quota.

**F-13. Twilio Network Traversal Service: $0.40-$0.80/GB, no free TURN, token TTL capped at 24 h (resolves an open question in `03`).**
- Confidence: high (two Twilio pages today). Design-critical: no.
- Evidence [S15][S16]: TURN US West (Northern California) and Europe (Germany) $0.400/GB; Singapore, Mumbai, Tokyo $0.600; Sydney, Sao Paulo $0.800; STUN free; no free allowance stated; "Prices are billed in megabyte" (unit unclear); "subject to change". Token: `POST /2010-04-01/Accounts/{AccountSid}/Tokens.json` authenticated with an API key and secret; `Ttl` default 86400 s and "configurable up to 24 hours"; response `ice_servers` with `global.turn.twilio.com` 3478 udp/tcp and 443 tcp. Tokens are "a secure way to create communication sessions ... without exposing credentials in a client-side environment" - the *token* is client-safe, the minting call is not.

**F-14. Other free or cheap TURN options exist but are thin: Xirsys' free tier is a 500 MB hard cap; ExpressTURN offers 1,000 GB/month with static credentials and almost no terms.**
- Confidence: medium (marketing pages; no SLA text; terms read only for ExpressTURN). Design-critical: no.
- Evidence: Xirsys [S18] (copyright 2026): free developer plan after a 30-day trial = 500 MB TURN "hard cap", 2 channels, 1 testing region; Basic $39/month (50 GB, $0.50/GB over), Standard $99 (150 GB, $0.40), Pro $199 (500 GB, $0.20), Elite $499 (2 TB, $0.09); static TURN credentials on all paid plans. ExpressTURN [S19]: free plan "limited to 1000 GB of traffic per month" (TCP and UDP 3478 + STUN), Premium $9/month with 5,000 GB, ports 80/443 and TURNS on Premium; username/password long-term credentials refreshable in the dashboard, shared-secret temporary credentials on Premium; its terms say only "use the Service only for lawful purposes", the company may "terminate your use of the Service at any time, with or without notice" and "modify or discontinue the Service" - no mention of file sharing, bandwidth or fair use, no effective date.

**F-15. No provider offers anonymous TURN, so any credential shipped to a browser is shared and public by construction; vendors and RFC 8656 treat abuse as expected.**
- Confidence: high. Design-critical: **yes**.
- Evidence: RFC 8656 section 21.1.1 (unauthorized allocations "to mask their true identity" or "to utilize the services of a TURN server without paying for them" are prevented by the long-term credential mechanism) and 21.3.1 (RECOMMENDS per-username bandwidth limits and per-username allocation limits) [S41]; Enable Security 2026-02-25: "Without authentication, anyone can obtain valid TURN credentials, which makes TURN's own authentication ineffective"; anonymous public systems "get less benefit from this control" [S36]; Cloudflare: "credential abuse is possible" when sharing credentials [S4]; Metered: one shared credential for many calls and a leak procedure [S14]. In every model the protection is therefore the **provider-side quota, a short lifetime, and monitoring with a kill switch**, not secrecy.

**F-16. Provider comparison (all prices USD, read 2026-10-17).**

  | Provider | Free tier | Price beyond | Client credential model | Max credential life | Static credentials? | Hostname AAAA | Terms note |
  |---|---|---|---|---|---|---|---|
  | Cloudflare Realtime TURN | 1,000 GB/mo (shared with SFU); STUN free | $0.05/GB egress | server mints per client (bearer token) | 48 h per FAQ (10-day example exists) | **no** | yes (client side); relay IPv4 only | "video call functionality"; no cap found |
  | Metered Open Relay | 20 GB/mo | paid plans (not read) | credential + client-safe `apiKey`; scheduled rotation advised | optional `expiryInSeconds` (advised 172,800 s) | yes | no | not found (404) |
  | Twilio NTS | none for TURN; STUN free | $0.40-$0.80/GB | server mints token (API key) | 24 h | no | no | not read |
  | Xirsys | 500 MB hard cap | $0.50-$0.09/GB by plan | static on paid | n/a | paid only | unverified | not read |
  | ExpressTURN | 1,000 GB/mo (TCP/UDP 3478) | Premium $9/mo incl. 5,000 GB | long-term user/password | n/a | yes | unverified | minimal |
  | Self-hosted coturn | n/a | VPS, e.g. DigitalOcean $6/mo with 1,000 GiB | any | any | yes | yes | your own |

### C. Self-hosted coturn: sizing, security, cost

**F-17. There is no published coturn benchmark; the evidence is rules of thumb, and the binding limits are the NIC and the monthly transfer, not CPU.**
- Confidence: medium-low. Design-critical: no.
- Evidence: coturn wiki "TURN Performance and Load Balance" (marked outdated, no measured numbers): threads "close to number of CPUs", "an allocation usually stays within the same thread", at least one file descriptor per allocation, `-m 0` / `--relay-threads=0` with **one instance per CPU core** "probably the best scalability option", load balancing by a network balancer (must pin the client IP), round-robin DNS, or `ALTERNATE-SERVER`, which WebRTC clients cannot use [S38]. A secondary production guide (undated; no hardware, no benchmark): the NIC is the binding limit, about 200-300 concurrently relayed 1.5-2.5 Mbps video streams saturate 1 Gbps (its own estimate), relay ports 49152-65535 give 16,384 ports, the packaged `LimitNOFILE=1024` reportedly fails at "a few hundred sessions", `verbose` logs grow by gigabytes per day [S39]. STUNner's open-source TURN publishes no per-core number (a 10 Gbps/core figure belongs to its enterprise eBPF engine; search-result level only); eturnal's README makes no performance claim [S40].
- Capacity arithmetic for magnet-web (inference): a 1 Gbps NIC at 60 % utilisation relays ~600 Mbps = 75 MB/s ~ 6.5 TB/day, so the monthly transfer allowance runs out first. At 0.465 MB relayed per visit (3 MB site, 50 % peer-sourced, 30 % relay share) a DigitalOcean $6 droplet (1,000 GiB = 1,074 GB included) covers ~2.3 M visits/month and Hetzner's 20 TB plans ~43 M. The unmeasured risk is **allocation churn** (F-22): no source sizes coturn for hundreds of new allocations per second.

**F-18. coturn's 2026 security record is heavy; a public TURN server is a proxy that must be isolated, patched and quota-limited.**
- Confidence: high (advisory pages and release page read today). Design-critical: **yes** if self-hosting is the answer to F-10.
- Evidence [S37]: the advisories page (page 1 of 3, 2026-10-17) lists ten advisories published 2026-07-24 to 2026-08-05. **High:** DTLS per-peer SSL allocated before the cookie is verified (spoofed-source DoS); MOBILITY-TICKET session-resume authorization bypass (cross-user allocation takeover); pre-auth heap disclosure in the ACME redirect handler. **Moderate:** the IPv6 `addr_less_eq()` flaw that lets an authenticated client bypass `denied-peer-ip`/`allowed-peer-ip` ranges (CVE-2026-73213, GHSA-4v97-rxjj-4f99; affected <= 4.15.0, fixed 4.16.0; workaround "enforce relay egress restrictions outside Coturn"), mobility disconnects bypassing allocation quotas, chained mobility resumes exhausting memory, `even-port` stalling the server, multiplex-peer demux growth, a uint16 truncation enabling TCP framing bypass. **Low:** STUN attributes after MESSAGE-INTEGRITY are processed. Releases: 4.17.1 (07 Aug), 4.17.2 (08 Aug; fixed outgoing UDP TTL pinned to 1), **4.18.0 (08 Sep; removes `--drop-invalid-packets`, `--no-dtls`, `--no-cli`; hardening for IPv6 relayed addresses and oversized attributes)**; the page shows no year, 2026 is inferred from the advisory dates.
- Enable Security (2026-02-12): TURN servers "are also powerful proxies that hackers have been abusing since at least 2017"; Slack's TURN servers reached internal services and the AWS metadata service (HackerOne, $3,500); TURN relays of Zoom and Teams carried command-and-control traffic (Black Hat/DEF CON 2025 research); coturn CVE-2018-4056 (9.8), CVE-2020-26262 (fixed 4.5.2), CVE-2026-27624 (7.2, IPv4-mapped IPv6 bypass, fixed 4.9.0); TURN amplification is "low single digits" [S36].
- Hardening template (Enable Security's coturn guide; assumes 4.18.0; front matter 2026-02-25, changelog to 2026-09-29) [S36]: `no-tcp-relay`; `no-multicast-peers`; `denied-peer-ip` for `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `::1`, `::ffff:0.0.0.0-::ffff:255.255.255.255`, `64:ff9b::/96`, `fc00::/7`, `fe80::/10` and more (full list in the guide); `user-quota=100`, `total-quota=10000`, `max-allocate-lifetime=3600`, `stale-nonce=600`, `max-bps` and `bps-capacity` from real NIC capacity; `min-port=49152`, `max-port=65535`; `secure-stun` "breaks standard ICE"; source-IP network limits (UDP 3478: 200 packets/s with burst 400; TCP 3478: 30 new connections per 60 s) tested against large NATs "(hotels, campuses, mobile carriers)" [S36].
- Shared-credential implication (inference): `user-quota` and `max-bps` count per *username*. One static credential for every visitor turns them into one global limit (or, if raised, removes the per-user protection); `total-quota` and `bps-capacity` are server-wide, so setting them too low lets one credentialed user block everyone else (the guide's point, paraphrased).

**F-19. Hosting price points (read 2026-10-17).**
- Confidence: medium (vendor pages; Hetzner prices not captured). Design-critical: no.
- Evidence [S20][S21][S22]: DigitalOcean basic droplets $4 (500 GiB transfer), $6 (1,000 GiB), $12 (2,000 GiB), $18 (2 vCPU, 3,000 GiB), $24 (4,000 GiB); inbound free; overage rate not on the page. Hetzner EU "regular performance" plans include 20 TB/month (US 1-5 TB, Singapore 0.5-5 TB); the fetch could not read prices (JS-rendered). Oracle Always Free: 10 TB/month outbound, A1.Flex up to 2 OCPUs + 12 GB (bandwidth scales with OCPUs), two AMD micro VMs with "up to 50 Mbps", idle-instance reclamation (95th-percentile CPU, network and, on A1, memory below 20 % over 7 days), home region only.
- Break-even (arithmetic): Cloudflare TURN costs more than a $6 droplet only once relayed volume passes ~1,120 GB/month (1,000 GB free + $6 / $0.05), and the droplet's 1,000 GiB inclusion is then nearly exhausted; below 1 TB/month Cloudflare is free. Self-hosting wins on terms-of-service clarity and on volumes beyond a few TB, not on small-scale cost.

### D. Behaviour of the pinned stack (measured 2026-10-17)

Setup: Chromium 156.0.8078.4 (Playwright chromium-1248, headless, macOS 27.0 arm64) and Playwright WebKit 27.2; Firefox failed to launch in this sandbox. Fake STUN/TURN servers listen on 127.0.0.1 only. `@thaunknown/simple-peer` 10.1.2 `lite.js` is bundled and used with `trickle: false`, as `bittorrent-tracker` does. Details and raw JSON: Appendix B and `docs/research/labs/w2b-03-turn-connectivity-lab/`.

**F-20. Browser-only hard-NAT detection works: one server-reflexive candidate per distinct reflexive address, so two STUN servers expose destination-dependent mapping.**
- Confidence: high (source read and reproduced in two engines). Design-critical: **yes**.
- Evidence: libwebrtc `UDPPort::OnStunBindingRequestSucceeded` (main, fetched 2026-10-17) adds a srflx candidate per STUN server unless the same reflected address is already present ("if the same address has been added by another STUN server, then discarding the stun address") [S44]. Reproduced: STUN A + C (same mapping) -> **1** srflx; STUN A + B (B reflects port + 1000) -> **2** srflx with the same IP, different ports and `candidate.url` naming each server; in Chromium 156 with mDNS default (host candidate `<uuid>.local`, `relatedAddress` `0.0.0.0:0`) and with mDNS off, and in WebKit 27.2. Precedent: Tailscale `netcheck.go` sets `MappingVariesByDestIP` when the IPv4 reflexive address differs between STUN servers ("whether STUN results depend which STUN server you're talking to (on IPv4)") and leaves IPv6 as a TODO [S30]; Snowflake clients use RFC 5780 discovery and its JavaScript proxies a central test peer [S26].
- Reference probe `connectivity-probe.js` (lab; one throw-away connection, never waits for `complete`), results `results/res-probe.json`: Chromium easy-mapping 121-130 ms, hard 116-124 ms, TURN relay candidate 55-70 ms, blackholed STUN classified `udp-blocked-or-no-stun` at its 2.5 s budget, `disable_non_proxied_udp` classified the same in ~125 ms, TURN/TCP-only reachable classified `relay-only-reachable`; WebKit hard 159-224 ms, easy only "probable" after a 600 ms confirm window (~0.8 s) because gathering never completes there (F-24).
- Limits: needs two STUN servers on different IPs reachable over UDP; sees mapping, not filtering (a port-restricted easy NAT still fails against a hard peer, F-03); one identical reflexive address cannot tell "both answered the same" from "the second server is silent" until gathering completes (Chromium) or the confirm window passes; IPv6 mapping is not tested; IPv6 reachability needs AAAA-capable STUN hosts (F-06).

**F-21. A dead ICE server stalls every announce by 5 s, and a plain wait for `iceGatheringState === "complete"` would stall ~40 s `[DESIGN-CRITICAL]`.**
- Confidence: high. Design-critical: **yes** (time-to-first-peer, and any TURN rollout).
- Code facts (read in `node_modules`, 2026-10-17) [S48]: `bittorrent-tracker` 11.2.3 `lib/client/websocket-tracker.js` creates peers with `{ trickle: false, config: client._rtcConfig, wrtc }`; `announce()` sets `numwant = Math.min(opts.numwant, 5)` and `_generateOffers` calls back only when **all** offers have emitted `signal`; `DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000`; `OFFER_TIMEOUT = 50 * 1000`. `@thaunknown/simple-peer` 10.1.2 `lite.js`: `ICECOMPLETE_TIMEOUT = 5 * 1000`, started "as soon as we've received one valid candidate", the offer goes out on the null candidate or on that timeout, and `iceCompleteTimeout` is a constructor option that `bittorrent-tracker` never passes. The project passes `rtcConfig: { iceServers: config.stun }` (`src/loader/torrent.js:223`).
- Measured (Chromium 156, `results/res-full.json`, `res-long-*.json`): working servers: offer ready in 120-129 ms (no servers 120, STUN 125, TURN/UDP 124, TURN UDP+TCP 129). **TURN/UDP blackholed: 5003 ms with `iceTimeout` true; a six-URL Cloudflare-style list with dead members: 5002 ms.** `iceGatheringState` itself stayed `gathering` for **39.95 s** (UDP blackhole, TCP blackhole, closed UDP port), then `icecandidateerror` 701 "STUN binding request timed out." and "TURN allocate request timed out."; a closed **TCP** port fails fast (701 "Failed to establish connection" at 119 ms). The host candidate arrives after 2-3 ms. `w2b-04` measured the same 39.9 s independently [S50].
- Consequence: one bad URL in `iceServers` (a dead TURN, a credential that cannot allocate, Cloudflare's port-53 URL) delays *every* announce, i.e. first-peer discovery, by 5 s.

**F-22. Each connection with a TURN URL allocates, whether or not it needs the relay; WebTorrent's offer churn multiplies this.**
- Confidence: high for the per-connection sequence (two engines), medium for the load model. Design-critical: **yes** (credential and allocation load, provider limits, cost of "TURN for everyone").
- Evidence: fake-TURN log, 10 sequential connections per engine, one `turn:...?transport=udp` URL: each connection used its own UDP socket and sent **Binding, Allocate (no auth, answered 401), Allocate (authenticated), Refresh (lifetime 0, on close)** = 4 requests; over TCP: Allocate, Allocate (authenticated), Refresh = 3. Identical in Chromium 156 and WebKit 27.2. Relay candidates arrive 55-70 ms after the start (libwebrtc `pc/peer_connection.cc` calls `set_step_delay(kMinimumStepDelay)` = 50 ms, so relay allocation starts 50 ms after UDP/STUN, plus two round trips) [S44]. A connection with two URLs (UDP and TCP) obtained two relay candidates, i.e. two allocations.
- Load model (Appendix C): each visitor creates 5 offers x 2 announces/min x T trackers = 10T connections/min; T = 2 and 1,000 concurrent visitors -> **333 new connections/s = 1,333 TURN requests/s** (plus answerer-side connections, which also gather); 10,000 visitors -> 13,333/s; T = 4 doubles it. Most are the eager unanswered offers `w2b-04` observed (11 connections created, 2 connected). Cloudflare states no allocation-rate limit (only the per-allocation limits and the credential-issuance guidance, F-09).
- ICE server count: the W3C spec says the limit is implementation-defined and "MUST be at least 32"; libwebrtc truncates TURN servers above `kMaxTurnServers` (constant not found in the files fetched) [S42][S44]. Each URL is a separate allocation.

**F-23. Candidate and SDP overhead is small: about 128 bytes per added candidate, five offers per announce.**
- Confidence: high (measured). Design-critical: no.
- Evidence (offer SDP bytes, Chromium 156, simple-peer): no servers 543; STUN 672; TURN/UDP 801; TURN UDP + TCP 929. A Cloudflare-style list with three working members would add ~380 B per offer, ~1.9 KB per announce. The reference tracker server accepts messages up to 100 MiB (`maxPayload` in `bittorrent-tracker/server.js`); limits of public WSS trackers are unknown.

**F-24. WebKit 27.2 (Playwright, headless) never reaches gathering "complete" and exposes no host candidates; non-trickle offers wait the full 5 s, or never appear with no STUN. Unverified on real Safari.**
- Confidence: medium (reproduced, but headless Playwright WebKit on macOS is not Safari on iOS). Design-critical: **yes if it holds on devices** (iOS cannot be skipped).
- Evidence: in every scenario, including 70 s waits with no servers and with STUN A + B, `iceGatheringState` stayed `gathering`; no `host` candidate in any scenario; srflx and relay candidates did arrive (A + B gave two srflx; TURN/UDP gave a relay). simple-peer offers: no servers -> **no offer in 20 s** (zero candidates, so the 5 s timer never starts); STUN -> 5004 ms (`iceTimeout`); TURN/UDP OK -> 5004 ms; six-URL mix -> 5019 ms; UDP + TCP OK -> 5011 ms; TURN blackhole -> no offer in 20 s. The loopback data-channel test could not open (no host candidates). Probable cause (inference): mDNS host-name registration cannot finish in this sandbox; real Safari talks to mDNSResponder and exposes `.local` host candidates (WebKit source in `03` F-20).
- Consequence: never ship a configuration with zero STUN servers, never depend on `complete`, and measure offer latency on a real iPhone before trusting any ICE tuning (Q-04).

**F-25. Relay-only (`iceTransportPolicy: "relay"`) fails slowly when TURN is dead: the offer arrives after ~40 s with no candidates (measured).**
- Confidence: high (Chromium 156). Design-critical: no (an opt-in mode), but it dictates the guard in R-12.
- Evidence (`results/res-peer-relay.json`): relay + working TURN -> offer in 125 ms with 1 candidate; relay + no servers -> offer in 122 ms with **0** candidate lines (useless but not hanging); relay + TURN/UDP blackholed -> offer in **39,953 ms**, 0 candidate lines, `iceTimeout` false (the 5 s timer never starts because no candidate ever arrives). Candidates in relay mode carry `relatedAddress` `0.0.0.0:0`, i.e. nothing about the host leaks into the SDP.

### E. Owner-supplied TURN credentials (`turn=`, `turnu=`, `turnp=`) in the pointer

**F-26. The signed DNS pointer is a poor carrier for credentials: size, TTL, re-signing and visibility all work against it.**
- Confidence: medium-high (design arithmetic on documented constraints). Design-critical: **yes** (changes the pointer grammar proposal).
- Constraints from the project and its DNS research: the pointer is one `key=value; ...` string whose `sig` covers every other pair; `seq` must increase and `exp` is optional (`docs/ARCHITECTURE.md` section 4); TXT strings are at most 255 bytes, the whole RRset should stay under ~1,200 bytes, Cloudflare DNS minimum TTL is 60 s (30 s Enterprise, Auto = 300 s) (`05-doh-dns-txt.md` F7 and provider table) [S50].
- Arithmetic (computed here): a realistic signed pointer (btih, `dn`, `ws`, two `tr`, `chain`, `max`, `owner` 87 chars, `seq`, `exp`, `sig` 86 chars) is **418 bytes**. A Cloudflare credential pair (96 + 96 hex characters) plus one `turns:` URL adds 258 bytes -> **676**; two URLs -> **726** (three TXT strings). It fits, but every rotation (Cloudflare 48 h, Metered 48 h / 24 h, Twilio 24 h) means a new `seq` and a new signature, so **the owner's signing key would have to live in the rotation job** - the key whose compromise defeats the whole trust model - or rotation stays manual. Resolver caches keep old answers for the TTL, and the loader's last-known-good cache (IndexedDB) would keep serving expired credentials offline.
- Visibility: pointers also arrive as URL fragments or `?mw=` links, which land in browser history, screenshots and extensions.
- Alignment with `w2b-04` F40 ("do not add a `tel=` field to the pointer grammar ... in hub mode it would turn every pointer into a tracking-pixel vector"): the pointer can already name third-party trackers (`tr=`), so a `turn=` URL without credentials is the same class of disclosure; credentials are different because they are secrets that cost money and carry the owner's liability.

**F-27. Threat model for credentials that every visitor can read.**
- Confidence: high for the threats (RFC 8656 section 21, Enable Security 2026, Cloudflare docs); medium for the ranking. Design-critical: **yes**.
- Threats and what bounds them: (1) **bandwidth theft / bill exhaustion** - Cloudflare has no documented cap (F-10), Metered and ExpressTURN are bounded by their free quotas (20 GB, 1,000 GB) and then unknown behaviour; (2) **open proxy / SSRF** into private networks - only for self-hosted servers (Cloudflare denies private ranges and has no RFC 6062; coturn needs the deny-list and, per the 2026 advisory, an egress firewall outside coturn); (3) **anonymous relaying of attacks or command-and-control** (RFC 8656 section 21.3.2; Enable Security) - abuse complaints reach the credential owner; (4) **quota starvation** - one shared username shares `user-quota`/`max-bps`; (5) **allocation exhaustion** by a malicious client; (6) **credential persistence** in caches and history; (7) **liability** - "solely responsible for all content transmitted" (Cloudflare terms, F-10).
- Mitigations with evidence: short TTL (Cloudflare 48 h, Twilio 24 h, Metered advises 48 h rotated every 24 h); separate TURN key per site/environment (Cloudflare allows 1,000 keys) and `customIdentifier` per site; revoke endpoint (Cloudflare) or disable/delete the `username` (Metered; up to 2 minutes to take effect); usage polling (Cloudflare GraphQL, Metered `current_usage`); network-level per-source limits (self-hosted); never expose the account secret; log source IP and permissions (RFC 8656 section 21.3.2).

**F-28. Credential-delivery options and what each costs.**
- Confidence: medium (synthesis of F-09..F-16, F-26, F-27). Design-critical: **yes**.

  | Tier | Mechanism | Runtime backend of ours? | Secret holder | Abuse window | Catches |
  |---|---|---|---|---|---|
  | T0 | no TURN; web seed + public seeders | no | - | - | hard-vs-hard visitors rely on the web seed |
  | T1 | static public credential (Metered credential, ExpressTURN user/password, self-hosted static) in a same-origin JSON document | no | none (public by design) | until manual rotation | bounded only by the provider's quota; terms unknown (Metered, ExpressTURN) |
  | T2 | scheduled job mints short-lived credentials (Cloudflare `ttl` up to 172,800 s, Metered 48 h / 24 h) and rewrites the JSON | no runtime server; a CI/cron job holds the secret | CI secret store | <= TTL (<= 48 h) | needs the budget fuse (R-08); Metered credentials must be published >= 2 min before use; Cloudflare ToS question |
  | T3 | edge function mints a per-visitor credential (short TTL, per-IP rate limit), lazily | yes (tiny) | Worker secret | TTL | Cloudflare asks that >50 % of issued credentials be used; endpoint itself needs abuse control |
  | T4 | self-hosted coturn with a shared REST secret, minted by the same function | yes | the function | TTL | hardening (F-18), patching, egress firewall |
  | T5 | visitor enters their own TURN in Settings | no | the visitor | n/a | for privacy-mode and enterprise users |

- Delivery format (recommended in R-07): a separate document at `/.well-known/mw-ice.json` on the site's own host (same-origin in per-domain mode; fetched over TLS from the pointer's host in hub mode with consent), not a signed-pointer field. The document is untrusted input: allow only `stun:`/`stuns:`/`turn:`/`turns:` URLs, at most 4, no credentials inside URLs, length limits, `expires` honoured, `urls` filtered to the transports in F-07. A delegated "ICE signer" key is possible but unnecessary: TLS to the site's own host already authenticates the document as much as it authenticates the loader shell in per-domain mode.

### F. Cost and the relay-only policy

**F-29. Cost model: relayed bytes per visit, free-tier coverage and cost per extra million visits (assumption-driven; provider prices are measured).**
- Confidence: medium (inputs are assumptions; arithmetic is exact; prices from vendor pages). Design-critical: no.
- Assumptions: bytes pulled per visit S; peer-sourced fraction f; relay share r (pairs that cannot connect directly); chain gossip 50 KB per visit (the figure used in `03` R-04); a relayed byte is billed once at the receiving relay client (Cloudflare bills edge-to-client bytes; ingress is free). Policy A = ICE decides (relay only failing pairs); B = control-plane only (relay gossip, bulk from the web seed); C = relay-only privacy mode. `costmodel.py` in the lab reproduces the table.

  | site MB | peer-sourced | policy | relay share | relayed KB/visit | visits/month inside Cloudflare's free 1,000 GB | Cloudflare $ per extra 1M visits | Twilio $ per 1M visits |
  |---|---|---|---|---|---|---|---|
  | 1 | 50 % | A | 15 % | 82 | 12.1 M | $4.12 | $33.00 |
  | 1 | 50 % | A | 30 % | 165 | 6.1 M | $8.25 | $66.00 |
  | 3 | 10 % | A | 30 % | 105 | 9.5 M | $5.25 | $42.00 |
  | 3 | 50 % | A | 15 % | 232 | 4.3 M | $11.62 | $93.00 |
  | 3 | 50 % | A | 30 % | 465 | 2.15 M | $23.25 | $186.00 |
  | 3 | 50 % | B | 30 % | 15 | 66.7 M | $0.75 | $6.00 |
  | 3 | 50 % | C (relay-only) | 100 % | 1,550 | 0.65 M | $77.50 | $620.00 |
  | 3 | 90 % | C | 100 % | 2,750 | 0.36 M | $137.50 | $1,100.00 |
  | 10 | 50 % | A | 30 % | 1,515 | 0.66 M | $75.75 | $606.00 |
  | 10 | 50 % | C | 100 % | 5,050 | 0.20 M | $252.50 | $2,020.00 |

**F-30. Relaying bulk bytes rarely beats fetching them from the web seed; TURN spend is justified for the control plane and for sites with no web seed.**
- Confidence: medium (arithmetic on vendor prices). Design-critical: **yes** (it decides what is relayed).
- Evidence: pulling 3 MB with 50 % peer-sourced is 1,500 GB per million visits; at CloudFront's $0.085/GB (after the free 1 TB, `pay-as-you-go` page) that offload is worth ~$128 per million visits, at S3/CloudFront alike; on Cloudflare Pages (no bandwidth charge stated on its limits page) or GitHub Pages (100 GB/month soft limit instead of a price) it is worth ~$0 in cash. The same traffic relayed costs $11.62-$23.25 per extra million visits under policy A (Cloudflare) and $77.50 under C, i.e. policy C consumes ~60 % of the offload value on CloudFront and exceeds it on free hosts; Twilio ($0.40/GB) costs more than the CDN for any relayed bulk. [S23][S24][S25]
- Inference: with a web seed available, a relayed peer is worth keeping for gossip and for requests that the web seed cannot serve (small swarms), but bulk pieces should come from the web seed (R-06).

**F-31. Relay-only mode: what it hides, what it costs, what it needs.**
- Confidence: high for semantics (spec, measured); medium for cost. Design-critical: no (optional mode).
- Evidence: MDN/W3C: `iceTransportPolicy: "relay"` restricts ICE to relay candidates [S42]; measured: SDP carries only relay candidates, `relatedAddress` `0.0.0.0:0` (F-25), and a dead TURN means a ~40 s candidate-less offer. The remote peer sees the relay's address instead of the visitor's; the TURN operator, the tracker and the STUN server still see the visitor's IP; the operator sees both endpoints (Cloudflare: "the only information Cloudflare processes ... is the metadata necessary for establishing and maintaining the relay connection", i.e. IP addresses, ports and timing; content is DTLS-encrypted [S2]). Cost: policy C row of F-29 (3.3x to 6.7x the relayed bytes of policy A at 3 MB / 50 %). Cloudflare's per-allocation limits (50-100 Mbps, 5-10 kpps) are not binding for site loads. The operator belongs in the recipients register of the privacy notice (`w2b-06` R16).

### G. IP handling and mDNS: what changed or was re-measured

**F-32. Browser facts re-checked on 2026-10-17 (delta over `03`).**
- Confidence: high where measured or read; the LNA item is unverified for today. Design-critical: no.
- Measured, Chromium 156: with defaults the host candidate is `<uuid>.local` and srflx candidates (A and B above) carry `relatedAddress` `0.0.0.0:0`; `--disable-features=WebRtcHideLocalIpsWithMdns` still exposes the raw LAN address (192.168.x.x) in 156 (test harness relies on it). The NAT probe is unaffected by mDNS because it compares srflx candidates only.
- `icecandidateerror`: Chrome 77, Safari 14.1, **Firefox 150** (MDN BCD, MDN page "Baseline 2026 / Newly available, since April 2026"); `hostCandidate` member Chrome only [S43]. Use a timing/stats fallback for older Firefox.
- `chrome.privacy` `webRTCIPHandlingPolicy` values: `default`, `default_public_and_private_interfaces`, `default_public_interface_only`, `disable_non_proxied_udp` (Chrome 48+; default `default`) [S45]. Brave's default remains unresolved (F-07).
- Chrome Local Network Access: the Chrome developer blog text I could read still lists WebRTC as "not yet gated" and says Chrome intends to "ship Local Network Access for WebSockets, WebTransport, and WebRTC connections soon"; prompts for `fetch()`, subresources and iframes were slated for Chrome 142. The page is undated; **whether WebRTC is gated in the Chrome versions shipping on 2026-10-17 is unverified** [S45].

### H. Data-channel throughput

**F-33. libwebrtc now has only dcSCTP; its defaults and my loopback ceiling bound what a data channel can do, and mobile networks, not the stack, are the limit.**
- Confidence: high for defaults and loopback numbers; low for mobile rates (not measured). Design-critical: no.
- Evidence [S44]: `media/sctp/sctp_transport_factory.cc` creates only `DcSctpTransport` (usrsctp is no longer in libwebrtc `main`); `net/dcsctp/public/dcsctp_options.h` defaults: SCTP packet MTU 1191 bytes (excluding DTLS/UDP/IP), `max_message_size` 256 KiB, receive window 5 MiB, send buffer 2,000,000 bytes (the transport overrides it; `03` F-26), initial congestion window 10 MTUs, minimum 4 MTUs, `max_burst` 4, RTO initial 500 ms / min 400 ms / max 60 s, delayed ACK 200 ms, heartbeat 30 s, `max_retransmissions` 10, message interleaving off. Chromium and WebKit use this code; Firefox's data-channel stack was not read here.
- Measured (Chromium 156, headless, same-page loopback, 32 MiB per size, bufferedAmount high 1 MiB / low 256 KiB, `results/res-full.json`): 1 KiB messages 21.8 MB/s (183 Mbps; load-sensitive, 3.9 MB/s in a busy repeat run, Appendix B4); 4 KiB 28.7 MB/s (241 Mbps); **16 KiB 31.4 MB/s (263 Mbps)**; 64 KiB 31.5 MB/s (264 Mbps); 256 KiB 29.6 MB/s (248 Mbps); channel open 17 ms; ping-pong p50 0.1 ms, p95 0.2 ms; `maxMessageSize` 262144. The ceiling is processing-bound and far above cellular rates; the WebKit run could not connect on loopback (F-24).
- Relay path: Cloudflare's 5-10 kpps per allocation with ~1.2 KB SCTP packets is ~6-12 MB/s, consistent with its 50-100 Mbps statement (arithmetic) [S1].
- Mobile estimate (inference, not measured): a single association with Reno-like congestion control is roughly bounded by 1.22 x MTU / (RTT x sqrt(loss)) (Mathis et al.): at MTU 1191 B and RTT 60 ms, loss 0.01 % -> ~19 Mbps, 0.05 % -> ~8.7 Mbps, 0.5 % -> ~2.7 Mbps; double the RTT halves each figure. dcSCTP's actual congestion algorithm was not read, so treat these as orders of magnitude. For a 3 MB site the time is dominated by connection setup, not throughput.
- Setup cost (inference from the protocol stack): signalling over WSS, ICE checks, DTLS handshake, SCTP INIT and the data-channel open add several round trips (roughly 6-8) before the first byte, so 0.4-1 s at 60-120 ms RTT, more via a relay detour; loopback open took 17 ms, so CPU is not the issue.
- Mobile keep-alive (inference): ICE consent checks run every ~4-6 s (RFC 7675, `03` F-28) and cellular CGN mapping timeouts have a median of 65 s (Richter 2016, carried), so idle connections cost radio wake-ups; the architecture's cellular policy (6 connections, no upload) is consistent with that.

### I. Measuring and showing connectivity

**F-34. What the browser exposes is enough to build the funnel and the verdicts; the missing pieces are filtering type, remote IPs (by design) and, in older Firefox, error events.**
- Confidence: high for API facts; medium for the verdict rules. Design-critical: no.
- Evidence [S42][S43][S50]: `getStats()` candidate stats expose `candidateType`, `protocol`, `relayProtocol` (local relay candidates), `url` (local srflx/relay only); remote candidate `address` is `null` until the page supplies it via `addIceCandidate()`; `networkType` is deprecated for privacy. Pair stats: `state`, `nominated`, `currentRoundTripTime`, `availableOutgoingBitrate`, `bytesSent`/`bytesReceived`, `requestsSent`/`responsesReceived`, `consentRequestsSent`. Transport stats: `selectedCandidatePairId`, `selectedCandidatePairChanges`, `iceState`, `dtlsState`. `icecandidateerror` gives `errorCode` (a STUN/TURN response code, or 701 "no host candidate can reach the server"), `url`, `errorText` (observed texts: "STUN binding request timed out.", "TURN allocate request timed out.", "Failed to establish connection"). `w2b-04` measured `getStats()` at a median 0.3-0.6 ms for 10-30 connections (39-117 KB full, 3-10 KB projected).
- Verdict rules (consistent with `w2b-04` F7, plus measured behaviour): STUN OK = at least one srflx; STUN broken = no srflx and at least one 701; TURN OK = at least one relay candidate within the budget; UDP blocked = no srflx and no UDP relay within the budget (a UDP blackhole reports 701 only after ~40 s, so the budget is the signal); NAT class from F-20; IPv6 = a srflx candidate from an IPv6 STUN server; selected pair = the candidate-pair behind `selectedCandidatePairId`.
- Cross-reference: storage, ring buffer, export bundle, opt-in beacon (endpoint set at build time, never by the pointer) and privacy treatment are specified in `w2b-04`; this document only adds the connectivity fields (R-10).

---

## Recommendations for magnet-web

Priority P0 = do before any TURN rollout or before production; P1 = production-readiness; P2 = hardening; P3 = watch. Effort S = under a day, M = a few days, L = more. "Why" lists the findings.

**R-01. [P0, S] Declare TURN optional and ship with it off.** The web seed is the correctness path for every visitor (WebRTC absent, UDP blocked, hard NAT, tiny swarm); P2P and any relay only widen the offload. Default `ice.turn = []`; the UI shows "direct peers / relayed peers / web seed only". Why: F-01, F-04, F-30, F-07.

**R-02. [P0, M] Make a dead ICE server impossible to feel.**
- (a) Probe-before-use: only servers that answered in the probe (R-04) enter the shared `rtcConfig`.
- (b) Trim: at most two TURN URLs - `turn:<host>:3478?transport=udp` and `turns:<host>:443?transport=tcp` - never Cloudflare's port-53 URL, no duplicate transports (each URL is a separate allocation, F-22).
- (c) Cut the offer timeout: `docs/ARCHITECTURE.md` section 10 has `build.mjs` copy the prebuilt `webtorrent.min.js`, so this means bundling webtorrent from source with an esbuild alias for `@thaunknown/simple-peer/lite.js` (or a patched copy of the constant) so `ICECOMPLETE_TIMEOUT` is **1.5-2 s** instead of 5 s; keep it a single tunable. Alternative without a rebuild: install, before importing the bundle, an `RTCPeerConnection` subclass that dispatches the end-of-candidates event 1.5 s after the first candidate (the bundle captures the global at module init, see `w2b-04` F4). Trade-off: a relay candidate that arrives later is missing from that offer; measured local arrival is 55-70 ms and TURN/TLS needs ~4 round trips (inference), so 1.5-2 s covers 300 ms RTT links.
- (d) Keep at least one STUN server in every configuration (F-24).
- Acceptance: with the lab's blackholed TURN, `runPeer` offer-ready time <= 2 s in Chromium; same on a real iPhone (Q-04). Why: F-21, F-24, F-09.

**R-03. [P0, S] STUN list: two operators on different IPs, UDP.** `stun:stun.cloudflare.com:3478` (documented "free and unlimited", has AAAA) and `stun:stun.l.google.com:19302` (AAAA; no published terms, `03` F-07); optionally `global.stun.twilio.com:3478` (free, IPv4-only). Two distinct servers are what make the NAT probe possible. Why: F-20, F-06, F-24.

**R-04. [P0, M] Add a boot-time connectivity probe.** Port the lab's `connectivity-probe.js` to `src/loader/connectivity.js`: one throw-away `RTCPeerConnection`, two STUN URLs (+ the TURN entries when configured), 2.5 s budget, never waits for `complete`, runs in parallel with pointer resolution, never blocks rendering. Output: `cls` in {`easy-mapping`, `easy-probable`, `hard`, `udp-blocked-or-no-stun`, `relay-only-reachable`, `unknown-single-stun`, `no-webrtc`}, `ipv6Srflx`, `turnOk`, `tRelay`, errors with codes. Acceptance: the lab scenarios produce the documented classes in Chromium and WebKit; add Firefox 150+ to the lab when it launches (Q-07). Why: F-20, F-21, F-34.

**R-05. [P1, M] NAT-adaptive TURN with late binding.** Create one shared `rtcConfig` object, pass it as `tracker.rtcConfig`, and mutate `rtcConfig.iceServers` in place later: object identity survives `webtorrent/index.js` (`this.tracker = opts.tracker`), `lib/torrent.js` (`Object.assign({}, this.client.tracker, ...)`), `torrent-discovery` (`Object.assign` twice) and `bittorrent-tracker/client.js:59` (`this._rtcConfig = opts.rtcConfig`), and `simple-peer` copies it per connection (`Object.assign({}, Peer.config, opts.config)`), so only *new* connections see the change (read in source; behaviour not run end-to-end). Rules: probe class `hard`, `udp-blocked-or-no-stun` or `relay-only-reachable` -> add TURN (UDP + TLS; TLS only when UDP is blocked); `easy-*` -> STUN only; `unknown-*` -> STUN only and escalate if, after ~20 s, trackers report peers but none connected. Mint or fetch credentials only at that moment (Cloudflare: use >50 % of issued credentials). One-sided TURN should suffice because TURN permissions match the peer's IP, not its port (RFC 8656 section 3.3; inference to be tested, R-13). Expected effect: TURN allocations drop from every connection to the hard/blocked share of visitors (F-22). Why: F-22, F-09, F-03, F-26.

**R-06. [P1, M] Relayed peers carry the control plane; bulk comes from the web seed.** When the selected pair is `relay` on either side, allow chain gossip and small requests, cap bulk piece traffic on that peer (start: 512 KiB per session, 0 if a web seed is up), and count `relayBytes` for the budget. Detect the pair through the `RTCPeerConnection` wrapper (`w2b-04` F4) and `getStats()` (`selectedCandidatePairId`; `getSelectedCandidatePair()` is Firefox 154+, `03` F-18). Why: F-30, F-29.

**R-07. [P1, S] Deliver credentials outside the signed pointer.** Fetch `/.well-known/mw-ice.json` from the site's own host only when the probe says TURN is needed (404 = no TURN), after the consent card; in hub mode only for the host the pointer names, never from an unsigned or `#magnet:` pointer. Schema (validated, untrusted): `{ "v": 1, "expires": <unix s>, "iceServers": [ { "urls": [ ... ], "username": "...", "credential": "..." } ], "budget": { "relayedBytesPerSession": 5242880 } }`; allow only `stun:`, `stuns:`, `turn:`, `turns:` URLs, at most 4, lengths capped, no credentials inside URLs, `expires` honoured, refresh before expiry (`setConfiguration()` is not reachable through simple-peer, so new connections pick up the new `rtcConfig`). Do not add `turn=`, `turnu=`, `turnp=` to the pointer grammar (F-26). Why: F-26, F-27, F-28.

**R-08. [P1, M] Budget fuse and abuse monitoring.** A scheduled job (GitHub Actions cron, minimum 5 min, with a dead-man's-switch as in `w2b-04` F20-F24; or a Cloudflare Cron Trigger) that (1) reads usage - Cloudflare GraphQL `callsTurnUsageAdaptiveGroups` (`egressBytes`, `concurrentConnections` by `keyId`/`customIdentifier`) or Metered `current_usage`; (2) compares with a daily and monthly budget; (3) on breach revokes the live credential (`POST .../credentials/$USERNAME/revoke`; Metered: disable the `username`; allow up to 2 min) and stops publishing new ones; (4) alerts. Use one TURN key per site/environment (Cloudflare allows 1,000), tag credentials with `customIdentifier`, and set provider-side alerts. Why: F-09, F-15, F-27.

**R-09. [P1, S] Terms and privacy gate before any default provider.** Get written confirmation that relaying WebRTC data-channel traffic for website delivery is allowed (Cloudflare's Realtime terms license "video call functionality"); otherwise use a provider whose terms permit it, or self-host (R-15). Add the TURN operator to the recipients register and the consent card next to trackers and STUN servers (`w2b-06` R16); say that the operator sees both endpoints' IP addresses and timing but not content. Why: F-10, F-14, F-31.

**R-10. [P1, M] Connectivity section of the diagnostics panel and the (opt-in) bundle.** Fields: `net.cls`, `net.ipv6Srflx`, `net.stunOk` (>= 1 srflx), `net.turn` (configured / ok / ms / protocol, last 701 text), `pairs` (counts by selected-pair local type, remote type, `relayProtocol`; never remote IPs), funnel (offers sent, answers received, ICE connected, channel open, first piece), timings (first srflx, relay, offer ready, connected, open), failure taxonomy (`no-srflx`, `stun-701`, `turn-701`, `turn-auth` for 300-699 codes, `dtls-failed`, `timeout`, `no-webrtc`, `lockdown`), `webseedOnly`. Visitor strings: "Direct", "Relayed (udp/tcp/tls)", "Web seed only", "Your network: easy / hard / UDP blocked". Aggregation without a backend, retention and the beacon rules are in `w2b-04`; this telemetry is what answers Q-01. Why: F-34, F-01.

**R-11. [P1, M] Run one or two public always-on seeders.** Two VMs at different providers with public IPv4 (+ IPv6) and inbound UDP open, running the planned `tools/pin.mjs` (`docs/ARCHITECTURE.md` section 10). They are "easy" peers for every hard-NAT visitor (F-03), the baseline for tiny swarms (F-04), and free of relay billing. Cheapest known options (F-19): Oracle Always Free (10 TB/month outbound; reclaims idle instances), DigitalOcean $6 (1,000 GiB), Hetzner EU (20 TB; price not captured). Verify with the probe that the seeder's candidates are public, and log the share of connections served by seeders. Why: F-03, F-04, F-19.

**R-12. [P2, S] Relay-only privacy mode, guarded.** Offer only when the probe shows a working TURN; set `iceTransportPolicy: "relay"` on the shared config; give up after 3 s without a relay candidate (otherwise the offer arrives after ~40 s and is empty, F-25); show the cost and bandwidth caveat and the operator disclosure; never enable it from a pointer. Why: F-25, F-31, F-29.

**R-13. [P2, M] Connectivity tests in CI.** Move the lab to `test/e2e/connectivity/` and extend it with a real coturn container in Linux network namespaces: hard NAT (suggested: `iptables ... MASQUERADE --random-fully`; the flag was not verified here), UDP blocked (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`), **one-sided TURN** (R-05 assumption), credential expiry mid-session, dead-TURN offer latency, Firefox 150+, nightly. Why: F-20..F-25.

**R-14. [P2, S] Real-device checks.** iPhone Safari (does gathering complete, offer latency, host candidates), Android Chrome, Samsung Internet, Firefox for Android, Brave default policy (Q-05), a carrier with CGNAT. Extend the test matrix of `03` R-13. Why: F-24, F-07, F-05.

**R-15. [P2, M] Self-hosted coturn profile for owners who cannot use a vendor.** coturn >= 4.18.0; the hardening block of F-18 (`no-tcp-relay`, `denied-peer-ip` list, quotas, ports); an egress firewall outside coturn (the CVE-2026-73213 workaround); source-IP network limits; logging of source and permissions (RFC 8656 section 21.3.2); a patch cadence tied to the GitHub advisories feed. Why: F-18, F-17, F-10.

**R-16. [P3, S] Watch list.** Chrome Local Network Access for WebRTC (Q-06), Cloudflare Realtime pricing/terms pages (updated 2026-09-22 and 2026-09-28), coturn advisories, APNIC IPv6 numbers each quarter, Firefox `icecandidateerror` adoption.

**R-17. [P3, M] NAT-aware peer preference.** Advertise the visitor's probe class in the chain extension handshake and prefer "easy" peers for requests (the Snowflake idea, F-03). Only if R-10 telemetry shows relay-bound pairs dominate.

### Which tier for which site (heuristic)

| Site profile | Recommended connectivity setup |
|---|---|
| Hobby site, fewer than ~7 concurrent visitors on average | T0 (no TURN) + 1 public seeder + web seed (R-01, R-11) |
| Medium site, tens of concurrent visitors, consumer audience | T0 + 2 public seeders + probe + two STUN (R-03, R-04, R-11); T1 only if telemetry shows many stranded visitors |
| Large site or corporate/CGNAT-heavy audience | T2 with a vendor whose terms allow it, or self-hosted coturn (T2/T4), adaptive TURN (R-05), budget fuse (R-08) |
| Privacy-first deployment | T5 (visitor's own TURN) + guarded relay-only mode (R-12) |

### Next actions (ordered)

1. R-03 and R-02(d): fix the STUN list and make sure no configuration has zero STUN servers.
2. R-02(a)-(c): offer-latency fix (alias or subclass) and a lab check that a blackholed TURN costs <= 2 s.
3. R-04: probe in the loader, class shown in the status line.
4. R-10 and `w2b-04`: connectivity fields in the diagnostics panel; collect real numbers (answers Q-01).
5. R-11: stand up one public seeder; confirm it shows up as an "easy" peer.
6. R-09: ask the TURN vendor the terms question and update the recipients register.
7. R-05, R-07, R-08 only after steps 1-6 show that stranded or relayed visitors matter.

---

## Gotchas

- **G-01. Dead ICE servers are expensive in different ways:** UDP blackhole or closed UDP port -> gathering stays `gathering` ~40 s and a non-trickle offer waits 5 s; closed TCP port -> fast `701`. A single bad URL delays every announce (F-21).
- **G-02. Cloudflare's own note about port 53:** browsers block it, "the TURN URL will time out", and without trickle ICE you should filter it out. Our tracker peers are non-trickle. The 2026 example list shows six URLs without 53, but the warning remains in the page (F-09).
- **G-03. Cloudflare relays are IPv4-only and do not implement RFC 6062;** `CreatePermission` to private ranges is denied. IPv6 clients reach the service over IPv6 but get IPv4 relay addresses. Behaviour for IPv6-only (NAT64) peers is unverified (Q-12).
- **G-04. Credentials expire hard.** Cloudflare disconnects "after a short delay" and stops billing; Metered cuts immediately, calls in progress included. simple-peer cannot ICE-restart or call `setConfiguration()`, so long-lived relayed connections will drop at expiry and must be rebuilt (R-07).
- **G-05. Propagation delay:** Metered credentials take up to 2 minutes to work ("no relay candidate is gathered"); never mint at visit time. Cloudflare asks that >50 % of issued credentials be used, which also argues for lazy minting.
- **G-06. Cloudflare documentation disagrees with itself:** FAQ "up to 48 hours" vs `"ttl": 864000` in the replacement guide; overview "free when used with the SFU" vs FAQ/pricing "first 1,000 GB free" (F-08, F-09).
- **G-07. Terms:** Cloudflare Realtime is licensed "to enable video call functionality"; Cloudflare may limit concurrent calls and the customer is "solely responsible for all content transmitted" (F-10). Metered's terms could not be read (404), ExpressTURN's are minimal.
- **G-08. A shared credential shares quotas:** `user-quota`, `max-bps` and Cloudflare's per-allocation limits apply per username/allocation; one static credential for all visitors makes per-user limits global (F-18).
- **G-09. coturn operations:** 4.18.0 removed `--no-cli`, `--no-dtls`, `--drop-invalid-packets` (old guides break) and changed the log format; `denied-peer-ip=::0` blocks all relaying; `secure-stun` breaks standard ICE; IPv6 range rules were bypassable up to 4.15.0 (CVE-2026-73213); the packaged `LimitNOFILE=1024` reportedly fails at a few hundred sessions; `verbose` logs grow by gigabytes (F-17, F-18).
- **G-10. One slow offer slows the announce:** `_generateOffers` waits for all (up to 5) offers; one stalled connection holds the other four (F-21).
- **G-11. Identical reflexive addresses collapse into one candidate,** so "second STUN server silent" and "same mapping" look alike until gathering completes; the probe reports `easy-probable` after a confirm window (F-20).
- **G-12. The probe sees mapping, not filtering.** An easy-mapping, port-restricted visitor still fails against a hard peer unless that peer uses TURN (F-03).
- **G-13. Do not use `iceCandidatePoolSize` > 0 with metered TURN** (inference: pooled connections pre-gather candidates, including relay allocations; the spec default is 0 and the value cannot change after `setLocalDescription`).
- **G-14. WebKit under Playwright never completes gathering and shows no host candidates;** real Safari is untested here (F-24, Q-04).
- **G-15. Firefox could not be launched in this sandbox,** so no Firefox numbers exist in this document; Firefox below 150 has no `icecandidateerror` (F-32).
- **G-16. A resolver can erase IPv6:** on the research machine `dig AAAA` returned "AAAA queries have been locally blocked by dnscrypt-proxy". Browsers resolve STUN/TURN names through the OS resolver, so IPv6 srflx and IPv6 TURN reachability depend on it (observed, 2026-10-17).
- **G-17. Not every TURN/STUN hostname has AAAA:** Twilio's and Metered's do not (F-06).
- **G-18. Credentials in links:** fragments and `?mw=` pointers persist in history, screenshots and extensions; in hub mode ignore ICE material from unsigned pointers (R-07).
- **G-19. APNIC "IPv6 capable" is not "has a global IPv6 address and an open path";** the AT&T Mobility sample is 6,797 users; AS-level rows mix fixed and mobile (F-06).
- **G-20. Old numbers:** the 22 % relay share (2016), the cellular NAT mix (2014-2016) and Tailscale's 2020 post are dated; do not quote them as current (F-01, F-05).
- **G-21. Relay-only plus a dead TURN yields an empty offer after ~40 s** (F-25).
- **G-22. All measured timings come from loopback fakes.** They prove protocol and stack behaviour (request sequences, timeouts, candidate de-duplication, offer waiting), not real-network latency, real NAT behaviour or real TURN capacity (Appendix B).
- **G-23. Billing granularity:** Cloudflare bills edge-to-client bytes including TURN overhead; relay-only on both sides bills each direction once at its receiver; analytics use adaptive sampling, so per-customer billing must be one query per customer (F-09).
- **G-24. Always-on seeders on free tiers can be reclaimed:** Oracle reclaims instances that stay below 20 % CPU/network over 7 days (F-19); give the seeder real work or accept re-provisioning.

---

## Open questions

1. **Q-01. What is this app's real relay share and stranded-visitor share,** by device class, browser and network pair? No public dataset exists; R-10 telemetry is the answer.
2. **Q-02. Do Cloudflare, Metered, Twilio or ExpressTURN permit relaying WebRTC data-channel traffic for website delivery?** Does Cloudflare offer any hard spend cap? What does Metered do at 20 GB? (Terms page 404, no cap documented, ExpressTURN terms silent.)
3. **Q-03. Is Cloudflare's effective credential cap 48 h (FAQ) or at least 10 days (example)?**
4. **Q-04. On a real iPhone and Mac Safari: does ICE gathering complete, are `.local` host candidates produced, what is the offer latency with `trickle: false`?** (Playwright WebKit says: never completes, no host candidates.)
5. **Q-05. Brave's default WebRTC IP-handling policy** (wiki vs code; `brave_profile_prefs.cc` sets none).
6. **Q-06. Is WebRTC gated by Chrome's Local Network Access permission in the Chrome versions shipping now?** (The Chrome blog text still says "not yet", undated.)
7. **Q-07. Firefox:** one srflx per STUN server? Allocation sequence? `icecandidateerror` on 150+? (Launch failed here.)
8. **Q-08. Does a one-sided TURN relay connect a hard-NAT visitor to a port-restricted easy peer in browsers?** RFC 8656 section 3.3 (permissions by IP) suggests yes; needs a real coturn e2e (R-13).
9. **Q-09. How many allocations per second can coturn (or a vendor) absorb?** No benchmark found; Cloudflare states no allocation-rate limit.
10. **Q-10. What are the 2024-2026 CGNAT and symmetric-NAT shares on mobile carriers, and what does IPv6 do to ICE success?** No public study found.
11. **Q-11. Daily.co, Twilio Video and LiveKit first-party relay statistics** (not found; search budget ran out).
12. **Q-12. IPv6-only (NAT64/464XLAT) visitors with IPv4-only relay addresses:** which pairs work?
13. **Q-13. How many visitors need TURN over TLS on 443 (corporate proxies, port filtering),** and does it pass through HTTP proxies in each browser? Not measured.
14. **Q-14. Message-size limits of public WSS trackers** with larger SDP (relay candidates add ~128 B each).
15. **Q-15. Missing price points:** Hetzner plan prices (JS-rendered page), DigitalOcean overage rate, Metered paid plans.
16. **Q-16. dcSCTP's congestion-control algorithm and Firefox's data-channel stack,** needed to turn the Mathis estimate into a real mobile-throughput model; and real mobile measurements.

---

## Appendix A - Sources actually read (2026-10-17 unless stated)

Cloudflare (docs read as markdown via `.../index.md` unless noted; "updated" is the page's own date):
- [S1] https://developers.cloudflare.com/realtime/turn/ (overview; undated)
- [S2] https://developers.cloudflare.com/realtime/turn/faq/ (updated 2026-07-14)
- [S3] https://developers.cloudflare.com/realtime/turn/generate-credentials/ (updated 2026-09-25)
- [S4] https://developers.cloudflare.com/realtime/turn/replacing-existing/ (updated 2026-06-05)
- [S5] https://developers.cloudflare.com/realtime/turn/analytics/ (updated 2026-06-03)
- [S6] https://developers.cloudflare.com/realtime/turn/custom-domains/ (updated 2026-09-25)
- [S7] https://developers.cloudflare.com/realtime/turn/rfc-matrix/ (updated 2026-04-21)
- [S8] https://developers.cloudflare.com/realtime/sfu/pricing/ (updated 2026-09-22; HTML); also https://developers.cloudflare.com/realtime/sfu/platform/limits/ (updated 2026-10-06; SFU-only, not used)
- [S9] https://blog.cloudflare.com/webrtc-turn-using-anycast/ (published 2024-09-25; modified 2026-07-15)
- [S10] https://www.cloudflare.com/service-specific-terms-developer-platform/ (Realtime section read verbatim from the HTML; fetch tool reported "September 28, 2026")
- [S11] https://developers.cloudflare.com/workers/platform/pricing/ (updated 2026-10-02)
- [S12] https://blog.cloudflare.com/detecting-cgn-to-reduce-collateral-damage/ (published 2025-10-29; modified 2026-07-15)
- [S25] https://developers.cloudflare.com/pages/platform/limits/

Other providers and hosting:
- [S13] https://www.metered.ca/tools/openrelay/ (footer 2026); [S14] https://www.metered.ca/docs/llms-turn-server.txt ; https://www.metered.ca/terms-of-service returned 404
- [S15] https://www.twilio.com/en-us/stun-turn/pricing ; [S16] https://www.twilio.com/docs/stun-turn/api ; [S17] https://www.twilio.com/en-us/stun-turn
- [S18] https://xirsys.com/pricing/ ; [S19] https://www.expressturn.com/ and https://www.expressturn.com/terms
- [S20] https://www.digitalocean.com/pricing/droplets ; [S21] https://www.hetzner.com/cloud/regular-performance/ (prices not captured; https://www.hetzner.com/cloud/ had none) ; [S22] https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (https://www.oracle.com/cloud/free/ returned 403)
- [S23] https://aws.amazon.com/cloudfront/pricing/ and https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ ; [S24] https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits

Measurements, papers, articles:
- [S26] https://www.usenix.org/system/files/usenixsecurity24-bocovich.pdf (Snowflake, USENIX Security 2024-08-14..16; PDF text extracted; https://www.bamsoftware.com/papers/snowflake/ returned 403)
- [S27] https://arxiv.org/abs/2510.27500 (submitted 2025-10-31) ; https://arxiv.org/abs/2604.12484 (submitted 2026-04-14; IMC '26)
- [S28] https://tailscale.com/blog/nat-traversal-improvements-pt-1 (2025-10-15) ; [S29] https://tailscale.com/blog/how-nat-traversal-works (2020-08-21) [OLD: 2020] ; [S30] https://raw.githubusercontent.com/tailscale/tailscale/main/net/netcheck/netcheck.go
- [S31] https://webrtchacks.com/usage-stats/ (2016-04-08) [OLD: 2016] ; [S32] https://www.nojitter.com/know-where-turn-when-deploying-webrtc (2016-06-06) [OLD: 2016] ; [S33] https://groups.google.com/g/discuss-webrtc/c/5d_EJwM6iJM (thread 2018-06-20..25) [OLD: 2018] ; [S34] https://www.forasoft.com/learn/video-streaming/articles-streaming/turn-bandwidth-calculator (2026-10-12; "last verified 2026-05-31")
- [S35] APNIC Labs: https://stats.labs.apnic.net/cgi-bin/json-table-v6.pl?x=XA, `US`, `CA`, `IN`, `DE`, `FR`, `GB`, `BR`, `JP`, `US21928`, `US6167`, `US20057`, `CA812`, `CA577`, `CA852`, `IN55836` (data point 2026-10-16); page https://stats.labs.apnic.net/ipv6/AS21928
- [S36] Enable Security: https://www.enablesecurity.com/blog/turn-server-security-threats/ (2026-02-12) ; https://www.enablesecurity.com/blog/turn-security-best-practices/ (2026-02-25) ; https://www.enablesecurity.com/blog/coturn-security-configuration-guide/ (2026-02-25, changelog 2026-09-29)
- [S37] https://github.com/coturn/coturn/security/advisories (page 1) ; https://github.com/coturn/coturn/security/advisories/GHSA-4v97-rxjj-4f99 ; https://github.com/coturn/coturn/releases (the GitHub REST API returned 403: rate limit)
- [S38] https://github.com/coturn/coturn/wiki/TURN-Performance-and-Load-Balance (marked outdated) ; [S39] https://www.real-time-media-architecture.com/webrtc-protocol-stack-signaling-servers/turn-server-configuration-auth/configuring-coturn-for-production-turn-relay/ (undated) ; [S40] https://github.com/processone/eturnal

Specifications, browser documentation, code:
- [S41] https://www.rfc-editor.org/rfc/rfc8656.txt (read: sections 3.3, 7.2, 21). RFC 4787, 5780, 6092, 8445, 8489 were downloaded but not used.
- [S42] https://w3c.github.io/webrtc-pc/ (first 100,000 characters) ; https://w3c.github.io/webrtc-stats/ (first 100,000 characters)
- [S43] https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnectionIceErrorEvent ; https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidateStats ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/RTCPeerConnectionIceErrorEvent.json ; .../api/RTCPeerConnection.json
- [S44] libwebrtc `main` via https://webrtc.googlesource.com/src/+/refs/heads/main/<path>?format=TEXT : `p2p/base/stun_port.cc`, `p2p/client/basic_port_allocator.cc`, `p2p/base/port_allocator.h`, `p2p/base/turn_port.cc`, `pc/peer_connection.cc`, `pc/ice_server_parsing.cc` and `.h`, `api/peer_connection_interface.h`, `net/dcsctp/public/dcsctp_options.h`, `media/sctp/sctp_transport_factory.cc`, `media/sctp/dcsctp_transport.cc`
- [S45] https://developer.chrome.com/blog/local-network-access (undated) ; https://developer.chrome.com/docs/extensions/reference/api/privacy ; https://developer.chrome.com/docs/web-platform/local-network-access returned 404
- [S46] https://raw.githubusercontent.com/brave/brave-core/master/browser/brave_profile_prefs.cc ; [S47] https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/faq.md (no TURN content)
- [S48] project sources: `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `src/loader/config.js`, `src/loader/torrent.js`; `node_modules/` `webtorrent` 3.0.21 (`index.js`, `lib/torrent.js`), `torrent-discovery/index.js`, `bittorrent-tracker` 11.2.3 (`client.js`, `lib/client/websocket-tracker.js`, `server.js`), `@thaunknown/simple-peer` 10.1.2 (`lite.js`)
- [S49] DNS-over-HTTPS AAAA lookups through https://cloudflare-dns.com/dns-query for `stun.cloudflare.com`, `stun.l.google.com`, `global.stun.twilio.com`, `turn.cloudflare.com`, `global.turn.twilio.com`, `global.relay.metered.ca`, `stun.relay.metered.ca`
- [S50] sibling documents: `docs/research/03-webrtc-nat-privacy.md` (read), `05-doh-dns-txt.md` (F7, provider table), `w2b-04-observability-no-backend.md` (summary and F7/F8/F40), `w2b-06-abuse-legal-ops.md` (recipients register, R16)
- [S51] own lab: `docs/research/labs/w2b-03-turn-connectivity-lab/` (Appendix B)
- Tried and unavailable: https://metrics.torproject.org/ Snowflake CSVs (404), https://www.speedtest.net/global-index (blocked), libp2p documentation pages (404), a Medium article by l7mp (403), https://www.oracle.com/cloud/free/ (403), GitHub REST API (403, rate limit), https://www.forasoft.com via curl (403; read through the fetch tool).

## Appendix B - Experiments (loopback only; re-run with `docs/research/labs/w2b-03-turn-connectivity-lab/run-lab.sh`)

Environment: macOS 27.0 arm64; Node 24.22.0; Playwright 1.64.1 with Chromium 156.0.8078.4 (Chrome for Testing, headless) and WebKit 27.2 (headless); Firefox 1555 failed to launch ("Failed to launch the browser process"). `fake_ice.py` listens on 127.0.0.1 only: STUN A (34780, reflects the source port), STUN B (34781, reflects source port + 1000, emulating destination-dependent mapping), STUN C (34782, same as A), TURN (34790 UDP and TCP: 401 challenge, then success with a fake relay address and HMAC-SHA1 integrity), a black hole (34791 UDP/TCP), and a deliberately closed port (34792). The simple-peer tests bundle `@thaunknown/simple-peer/lite.js` 10.1.2 with esbuild and use `trickle: false`. The Chromium runs pass `--disable-features=WebRtcHideLocalIpsWithMdns` unless stated.

**B1. ICE gathering, Chromium 156 (`results/res-full.json`, `res-long-*.json`, `res-mdns.json`, `res-noudp.json`)**

| Scenario | Gathering complete | Candidates / notes |
|---|---|---|
| no servers | 118 ms | host only; offer SDP 565 B |
| STUN A | 119 ms | host + srflx |
| STUN A + C (same mapping) | 122 ms | host + **1** srflx |
| STUN A + B (mapping varies) | 123 ms | host + **2** srflx (same IP, ports differ by 1000); mDNS default: host `<uuid>.local`, srflx `relatedAddress` 0.0.0.0:0 |
| TURN/UDP OK | 125 ms | host + srflx (url = the TURN host) + relay at 58 ms |
| TURN/TCP OK | 126 ms | host + relay (`relayProtocol` tcp) at 58 ms |
| TURN UDP + TCP URLs OK | 129 ms | host + srflx + 2 relay (two allocations); SDP 952 B |
| TURN/UDP blackhole, TURN/TCP blackhole, closed UDP port | **39,948-39,958 ms** | host at 2-3 ms; 701 "STUN binding request timed out." / "TURN allocate request timed out." at ~39.9 s |
| closed TCP port | 126 ms | 701 "Failed to establish connection" |
| `iceTransportPolicy: relay` + TURN OK | 128 ms | one relay candidate, `relatedAddress` 0.0.0.0:0 |
| `iceTransportPolicy: relay`, no servers | 116 ms | zero candidates |
| `disable_non_proxied_udp` policy | 117-132 ms | no host, no srflx; TURN/TCP relay at 67-68 ms; UDP TURN nothing |

**B2. simple-peer offer-ready time (`trickle: false`)**

| Scenario | Chromium 156 | WebKit 27.2 |
|---|---|---|
| no servers | 120 ms | no offer in 20 s (zero candidates) |
| STUN A | 125 ms | 5004 ms (`iceTimeout`) |
| TURN/UDP OK | 124 ms | 5004 ms |
| TURN/UDP blackhole | **5003 ms** (`iceTimeout`) | no offer in 20 s |
| six URLs, dead members | 5002 ms | 5019 ms |
| UDP + TCP URLs OK | 129 ms | 5011 ms |
| relay policy + TURN OK / no servers / TURN blackhole | 125 ms / 122 ms (0 candidates) / **39,953 ms** (0 candidates) | 5061 ms / no offer in 20 s / no offer in 60 s (repeat run, `results/res-full-rerun.json`) |

**B3. TURN server messages per connection (10 sequential connections per engine):** UDP URL: Binding, Allocate (401), Allocate (authenticated), Refresh (lifetime 0 at close) = 4, in both engines; TCP URL: Allocate, Allocate (authenticated), Refresh = 3.

**B4. Loopback data-channel throughput, Chromium 156 (`results/res-full.json`):** 32 MiB per message size, high water 1 MiB, low water 256 KiB: 1 KiB 21.8 MB/s (183 Mbps); 4 KiB 28.7 (241); 16 KiB 31.4 (263); 64 KiB 31.5 (264); 256 KiB 29.6 (248); channel open 17 ms; 200 ping-pongs p50 0.1 ms, p95 0.2 ms, max 4.8 ms. WebKit: no loopback connection (no host candidates). A full repeat through `run-lab.sh` (`results/res-full-rerun.json`) reproduced the other numbers within a few ms (blackholed-TURN offer 5002 ms, relay policy + blackholed TURN 39,951 ms, gathering complete at 39,952 ms) and gave 4 KiB 30.4, 16 KiB 32.1, 64 KiB 32.7, 256 KiB 33.5 MB/s; the 1 KiB figure is load-sensitive (3.9 MB/s in the repeat while the machine was busy, 21.8 MB/s in the reference run).

**B5. Reference probe `connectivity-probe.js` (`results/res-probe.json`):** Chromium (flag off and mDNS default): easy (A + C) `easy-mapping` 121-130 ms; hard (A + B) `hard` 116-124 ms; single STUN `unknown-single-stun`; blackholed STUNs `udp-blocked-or-no-stun` at 2.5 s; hard + TURN OK `hard` with relay at 55-70 ms; easy + dead TURN `easy-probable` at 2.5 s (no relay); easy + closed TCP TURN `easy-mapping` with a 701. `disable_non_proxied_udp`: every STUN scenario `udp-blocked-or-no-stun` in ~125 ms; STUN A+B + TURN/TCP OK `relay-only-reachable` at 123 ms. WebKit: hard 159-224 ms; easy `easy-probable` ~0.8 s; blackholed STUNs at 2.5 s.

**B6. Not done:** Firefox (would not launch); any real network, NAT or carrier; a real coturn or vendor TURN; real Safari or iOS; mobile throughput; one-sided-TURN behaviour. The fakes validate request sequences, timeouts, candidate de-duplication and offer waiting only.

## Appendix C - Cost model (`labs/w2b-03-turn-connectivity-lab/costmodel.py`)

Formulas: relayed bytes per visit = policy A: (S x f + g) x r; policy B: g x r; policy C: S x f + g, with S = site bytes pulled per visit, f = peer-sourced fraction, r = relay share, g = 50 KB chain gossip (assumption). Billed volume = relayed bytes received by relay clients (Cloudflare: edge-to-client bytes including TURN overhead, ingress free). Provider prices: Cloudflare $0.05/GB after 1,000 GB/month; Twilio $0.40/GB (US West, Germany). The F-29 table is a subset of the script output.

Offload value per 1M visits (3 MB site): 10 % peer-sourced = 300 GB -> $26 at CloudFront's $0.085/GB; 50 % = 1,500 GB -> $128; 90 % = 2,700 GB -> $230; on Cloudflare Pages or GitHub Pages the cash value is ~0.

Allocation churn if TURN is configured on every connection (measured 4 requests per connection per TURN/UDP URL; 5 offers x 2 announces/min per tracker; answerer-side connections not included):

| Trackers | Concurrent visitors | New connections/s | TURN requests/s |
|---|---|---|---|
| 2 | 100 | 33 | 133 |
| 2 | 1,000 | 333 | 1,333 |
| 2 | 10,000 | 3,333 | 13,333 |
| 4 | 100 | 67 | 267 |
| 4 | 1,000 | 667 | 2,667 |
| 4 | 10,000 | 6,667 | 26,667 |

Break-even: a $6 DigitalOcean droplet (1,000 GiB included) beats Cloudflare's price only above ~1,120 GB/month relayed; a $24 droplet (4,000 GiB) above ~1,480 GB/month.

## Appendix D - Carried over from `03-webrtc-nat-privacy.md` and not re-read this session

Richter et al., IMC 2016 (CGN in more than 90 % of cellular ASes; about 40 % symmetric among cellular CGNs; UDP mapping timeouts: cellular median 65 s) [OLD: 2016]; the IPv8 four-carrier test (2023); Tailscale's port-spraying arithmetic is re-read here but the 2020 date stands; the mDNS draft (Chrome saw a 2 % relative ICE-success drop with mDNS on both sides); RFC 7675 consent freshness (4-6 s checks, 30 s expiry); Safari Lockdown Mode disabling `RTCPeerConnection`; Brave's wiki claim about "Disable non-proxied UDP" defaults (partly contradicted by `brave_profile_prefs.cc`, F-07); Firefox for Android mDNS (bug 1581947); libwebrtc's 16 MiB data-channel queue and the 256 KiB message size; Chromium's 500-connection and WebKit's 256-socket caps; iOS and Android background behaviour of data channels. None of these changed the findings above; treat them with the confidence given in `03`.
