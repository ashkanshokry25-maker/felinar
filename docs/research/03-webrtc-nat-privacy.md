# 03 - WebRTC connectivity, NAT traversal, TURN and privacy

- Research date: 2026-10-14. "Current" means as of that date.
- Project: serverless "magnet-link web" system (static loader + WebTorrent over WebRTC + a replicated signed log over the same peer connections).
- Method: WebSearch (extended mode for niche facts), WebFetch of official docs/specs/vendor pages, and direct reads of browser source files (libwebrtc, Chromium/Blink, WebKit, Gecko/mozilla-central, brave-core), because limits and defaults are only authoritative in code. Downloaded files were kept in an isolated scratch directory and only grepped/read, never executed.
- Confidence: **high** = primary source (spec, vendor doc, source code) read directly, or two independent sources agree. **medium** = one good source, or sources partly conflict. **low** = single secondary/anecdotal source, or my own inference (always labelled "inference").
- **design_critical = yes** means: if the claim is wrong, the architecture changes.
- Age flag: [OLD: year] marks non-normative sources older than 2024 (the brief asked for 2024-2026 where possible). Standards (RFC 7675, 8828, 8831, the mDNS draft) are old but normative and are cited by date without the flag.

## Summary

1. **Direct P2P is probabilistic and nobody has published a rigorous browser-WebRTC number.** Vendor/consultant estimates put relayed sessions at roughly 10-25 % for consumer traffic (Twilio: STUN alone suffices "around 85 %" of the time; GetStream, citing unlinked Chrome UMA data: 75-80 % direct; Tsahi Levent-Levi: "0-50 %", large vendors ~20 %) and 40-60 % behind corporate firewalls (unsourced). Plan for 15-30 % of peer pairs needing a relay or a non-WebRTC fallback, and measure your own with `getStats()`.
2. **Cellular is the worst case.** Richter et al. (IMC 2016) [OLD: 2016]: carrier-grade NAT in more than 90 % of cellular ASes; mapping behaviour bimodal (about 40 % symmetric, 20 % full cone); "major cellular networks in the US" symmetric. A 2023 test of four Dutch carriers had one symmetric carrier (hole punching failed). Browser ICE cannot do the port spraying Tailscale describes (about 170,000 probes per side to beat two hard NATs), so symmetric-vs-symmetric pairs need TURN. IPv6 (50.1 % of Google traffic on 2026-03-28) removes NAT for IPv6-to-IPv6 pairs.
3. **The only large open hole-punching study** (libp2p DCUtR; data Dec 2022; paper 2025, IMC '26 version April 2026) reports 70 % +/- 7.1 % *conditional* success. It is not WebRTC, has no mobile/NAT-type breakdown, and is biased toward success. Do not read it as "70 % of mobile WebRTC pairs connect".
4. **STUN**: `stun.cloudflare.com:3478` (UDP only) is documented "free and unlimited"; Twilio `global.stun.twilio.com:3478` is free; Google `stun.l.google.com:19302` has no published terms (only a 2014 forum post by Justin Uberti: free for development, no SLA, run your own for commercial apps) [OLD: 2014]. Every STUN operator sees every visitor's public IP.
5. **TURN**: Cloudflare Realtime TURN = 1,000 GB/month free (shared with its SFU; pricing page "last updated Sep 22, 2026"), then $0.05/GB egress. Metered Open Relay = 20 GB/month free, sign-up + API key. Twilio = $0.40/GB (US West/Europe), $0.60 (Asia), $0.80 (Sydney, Sao Paulo), no free tier listed.
6. **Time-limited TURN credentials cannot be minted securely without something that holds a secret.** Cloudflare and Twilio both say mint on a server; the TURN REST scheme is an HMAC with a shared secret. Backend-free options: Metered's credential-scoped `apiKey` (documented as "safe for front-end use"; abuse bounded by the quota), or a scheduled CI job that mints 48-hour credentials and republishes a static `ice.json`. A stateless edge function is the only clean answer and is technically a (tiny) backend.
7. **Privacy**: mDNS hides only private LAN addresses. Peers always learn your public IP (server-reflexive candidates); so do STUN servers and trackers. `iceTransportPolicy: "relay"` hides your IP from peers but not from the TURN operator, and it spends relay bandwidth. A visible disclosure is required.
8. **Browser hazards**: Safari/WebKit **Lockdown Mode disables `RTCPeerConnection`** (and, per WebKit's preference table, Service Workers and IndexedDB - verify on device). Brave Tor windows throw `NotAllowedError` on `new RTCPeerConnection`. Brave's "Disable non-proxied UDP" policy removes UDP P2P. Tor Browser disables WebRTC. Firefox for Android only got mDNS host-address obfuscation recently (bug 1581947, target Firefox 149).
9. **Data channels**: Chrome and Safari advertise `max-message-size` 256 KiB (libwebrtc `kSctpSendBufferSize`); Firefox accepts up to 1 GiB - 1 locally but assumes 64 KiB if the remote omits the attribute; the usable size is the minimum of both. RFC 8831 says limit messages to 16 KB unless message interleaving is available. Chrome and Safari throw `OperationError` when `bufferedAmount` + new data would exceed 16 MiB.
10. **Connection counts**: Chromium hard-caps live `RTCPeerConnection`s at 500 per renderer; WebKit closes the oldest RTC socket once a web process holds more than 256. No published mobile benchmark exists. WebTorrent defaults to 55 connections per torrent; bittorrent-tracker creates up to 5 new `RTCPeerConnection`s per announce per tracker every 30 s.
11. **Mobile lifecycle**: on iOS, data-only WebRTC does not survive backgrounding or screen lock (Apple DTS: once suspended "all low-level networking stops"; WebKit gives the web process a 20 s prepare-to-suspend window). On Android Chrome, timer throttling and (desktop) freezing exempt pages with an open data channel, but the OS can still doze/kill the process - undocumented for this case. Firefox for Android: minimum 15-minute timer delay in inactive tabs and may unload them. **A visit helps the swarm and the chain only while the tab is foregrounded.**
12. **Architecture constraints**: `RTCPeerConnection` is `[Exposed=Window]` only (no workers, no service workers). `RTCDataChannel` is transferable to dedicated workers (Chrome 130+, Firefox 144+, Safari 15+). CSP has no WebRTC directive, so hosted-site code can always open its own peer connections.

### Worst-critic sanity check on the original idea

- "Every visitor keeps the chain alive": only while the tab is foregrounded. On iOS that ends within seconds of locking the screen; on Android it is undocumented. A chain that relies on phones as persistent nodes will have no persistent nodes.
- "Works on all major browsers": not in Safari Lockdown Mode, Tor Browser, Brave Tor windows, Brave with the UDP-blocking policy, or on UDP-blocked corporate networks. These users need a web-seed-only mode.
- "No backend": true for the loader and the data, false for secure TURN credentials unless a public-by-design key or a tiny edge function is accepted.
- "Visiting a site is private": false. Visiting means joining a public swarm, so IP plus infohash is visible to peers, trackers and STUN operators.
- "Hosted sites are sandboxed": CSP cannot block WebRTC, so hosted-site code can open its own peer connections.

## Findings

Each finding: claim, confidence, design-critical flag, evidence, sources with the source's date.

### A. Connection success without TURN

**F-01. No rigorous public measurement of browser-WebRTC direct-connect rates exists; the circulating figures are vendor/consultant estimates clustering at 10-25 % relayed (consumer), much higher in enterprise.**
- Confidence: medium that the estimates cluster there; low for any single number. Design-critical: **yes** (a fallback path for failing pairs is mandatory).
- Evidence:
  - Twilio marketing page: STUN is enough "around 85% of the time"; TURN needed for "symmetric NATs and other enterprise grade firewall scenarios". Undated, page footer 2026.
  - GetStream: "In open-internet consumer traffic, direct connections (host + server-reflexive) succeed in roughly 75-80% of sessions; the remaining 20-25% require a relay", attributed to "Chrome usage metrics analysis (UMA) data" with no link or date.
  - BlogGeek.me (post dated 2025-11-10; comments 2020-2023): "common lore ... around 80%"; Tsahi Levent-Levi 2022-03-02: "I've seen anything between 0-50% of TURN relay ... For most of the industry, I think 30% is a tad high"; 2020-08-03: "If this is over 20-30%, I'd try to figure out why". A commenter cites a callstats.io post (2017) for "30% of peers connected through TURN" (second-hand, unverified) [OLD: 2017]. Two commenters report "quite a lot" falling back to relay on mobile networks (2020, 2023); Tim Panton (2020-10-18): viewing a stream from an iPhone "over 4g, you probably need TURN".
  - Search-level only (not read in full): developer guides claim 10-20 % overall and 40-60 % behind corporate firewalls; no data given.
  - I searched for published Chrome UMA / Firefox telemetry on candidate-pair types and found none. The "86 % direct / 14 % TURN" figure sometimes attributed to Justin Uberti (Google I/O 2013) could not be verified and is **not used**.
- Sources: https://www.twilio.com/en-us/stun-turn ; https://getstream.io/resources/projects/webrtc/advanced/stun-turn/ ; https://bloggeek.me/webrtc-turn/ (2025-11-10).

**F-02. The largest open NAT hole-punching measurement (libp2p DCUtR in IPFS) reports 70 % +/- 7.1 % conditional success; it is not WebRTC, has no mobile/NAT-type breakdown, and is biased toward success.**
- Confidence: high that the paper says this; medium as a proxy for WebRTC. Design-critical: no (context only).
- Evidence: campaign 2022-12-01 to 2023-01-01; abstract: over 4.4 M traversal attempts from 85,000+ networks in 167 countries (the paper elsewhere says 6.25 M hole punches over 212 API keys; 4.43 M after network attribution). 70 % +/- 7.1 % is *conditional* on relay reservation and public-address discovery succeeding (about 29 % of data points failed earlier stages and are excluded); the +/- is the spread of a line of best fit over per-network daily rates, not a standard confidence interval. TCP and QUIC both about 70 %. 97.6 % of successes on the first attempt. Not reported: mobile/cellular, IPv4 vs IPv6, NAT mapping/filtering type; CGNAT cannot be distinguished (section 4.3.1). Limitations stated: volunteers more technical, honeypot only sees peers reachable via relay, so success may be inflated. The authors' own IMC '26 abstract repeats "conditional".
- Sources: https://arxiv.org/html/2510.27500v1 (2025-10) ; https://arxiv.org/abs/2604.12484 and https://arxiv.org/html/2604.12484v1 (submitted 2026-04-14; ACM IMC '26, 2026-10-12..16). Full text also read via pdftotext.

**F-03. Cellular networks overwhelmingly use CGN and a large share of cellular CGNs use symmetric (endpoint-dependent) mapping, which breaks STUN-only hole punching. Data are old.**
- Confidence: high that the paper states it; medium on current relevance [OLD: 2016]. Design-critical: **yes** (mobile-to-mobile pairs commonly need TURN).
- Evidence (Richter et al., "A Multi-perspective Analysis of Carrier-Grade NAT Deployment", ACM IMC 2016, Nov 14-16 2016; data from Netalyzr sessions since 2014 and a BitTorrent-DHT crawl of 2016-03): more than 17 % of eyeball ASes and more than 90 % of cellular ASes rely on CGN. Home CPE NATs: under 2 % symmetric. 11 % of non-cellular CGN ASes have symmetric as their most permissive type. Cellular: "a bimodal outcome, with a large fraction of both restrictive (40% symmetric) and permissive (20% full cone) NAT types ... major cellular networks in the US deploying CGNs with symmetric mapping types." UDP mapping timeouts: cellular CGN median 65 s, non-cellular CGN 35 s (relevant to keepalives; ICE consent checks every 4-6 s keep mappings alive). The paper notes the IETF lists endpoint-independent mapping as the first CGN requirement, which symmetric NATs violate.
- Sources: https://www.prichter.com/imc176-richterA.pdf (2016-11; read via pdftotext) ; arXiv mirror https://arxiv.org/pdf/1605.05606 (appeared in search).

**F-04. A small 2023 four-carrier experiment found one of four Dutch carriers symmetric and unpuncturable.**
- Confidence: low-medium (4 SIMs, one country, one moment, student project). Design-critical: no (anecdote supporting F-03).
- Evidence: IPv8 hole punching between phones on 5G SIMs of T-Mobile NL, Lebara, Lyca Mobile and Vodafone NL: Lyca failed ("IPv8 was unable to penetrate the Symmetric NAT that Lyca has in place"); the other three connected to each other (Table II).
- Source: https://arxiv.org/pdf/2311.04658 (v2, 2023-11-15; TU Delft; read via pdftotext) [OLD: 2023].

**F-05. Symmetric ("hard", endpoint-dependent) NAT defeats STUN-only traversal; beating two hard NATs needs port spraying that browser ICE does not do.**
- Confidence: medium-high. Design-critical: **yes**.
- Evidence (Tailscale, 2020-08-21): hard NATs create a different mapping per destination; "hard NATs tend to be office routers or cloud NAT gateways ... home routers tend to be easy NATs"; with CGNAT "hairpinning becomes vital"; one hard + one easy side needs port guessing; both hard needs about 170,000 probes from each side for 99.9 % (birthday paradox, 256 ports on the hard side); after 20 s the chance is 0.01 %. The post says WebRTC "uses this bag of tricks" and describes ICE as "try everything at once, and pick the best thing that works" but does not claim ICE sprays ports. **Inference:** browsers expose no socket/port control, so they cannot implement the spraying; therefore symmetric-vs-symmetric (and symmetric-vs-port-restricted) pairs fail without TURN. The "one hard side works only if the easy side filters by address only" rule is standard NAT-classification behaviour (RFC 4787 style), not re-measured here.
- Source: https://tailscale.com/blog/how-nat-traversal-works (2020-08-21) [OLD: 2020].

**F-06. IPv6 reduces NAT dependence; global IPv6 share crossed 50 % of Google traffic in 2026.**
- Confidence: medium. Design-critical: no.
- Evidence: Google 50.1 % IPv6 traffic on 2026-03-28 (up from 46.33 % a year earlier); Cloudflare Radar 40.1 % of HTTP requests; APNIC Labs 43.13 % of networks IPv6-capable (The Register, 2026-04-17). Internet Society Pulse (search-level): France 73 %, India 72 %, Saudi Arabia 65 %. No verified per-carrier figures (T-Mobile, Verizon, Jio) found. **Inference:** two IPv6 hosts can connect without NAT, but stateful firewalls still require ICE-initiated pinholes, so success is not guaranteed.
- Sources: https://www.theregister.com/2026/04/17/ipv6_50_percent_google/ ; https://pulse.internetsociety.org/blog/18-years-later-ipv6-reaches-majority (search snippet only).

### B. Public STUN servers

**F-07. Google's public STUN (`stun.l.google.com:19302`) has no published terms or SLA; the only statement is a 2014 forum post.**
- Confidence: high that no official terms were found; low that the 2014 statement is still current. Design-critical: no.
- Evidence: Justin Uberti (Google), 2014-06-18: "The Google STUN server is something you can freely use for development purposes ... there is no SLA ... If you are deploying a commercial application, you should plan to deploy your own STUN/TURN servers." Alternates `stun1`-`stun4.l.google.com:19302` appear in third-party lists (not confirmed on a Google page). A 2020 GitHub issue (search snippet only) reports one IP behind the hostname mishandled STUN.
- Source: https://groups.google.com/g/discuss-webrtc/c/shcPIaPxwo8/m/F8Vc8QlIyn0J (2014-06-18) [OLD: 2014].

**F-08. Cloudflare STUN: `stun.cloudflare.com:3478/udp`, "free and unlimited"; UDP only.**
- Confidence: high. Design-critical: no.
- Evidence: Cloudflare TURN FAQ: "Cloudflare's STUN service at `stun.cloudflare.com` is free and unlimited." The overview table lists STUN over UDP 3478 only (no TCP/TLS STUN, no alternate port). The TURN host `turn.cloudflare.com` also answers STUN binding requests but the docs do not say that traffic is free.
- Sources: https://developers.cloudflare.com/realtime/turn/faq/ ; https://developers.cloudflare.com/realtime/turn/ (both undated, current 2026-10-14).

**F-09. Twilio STUN `global.stun.twilio.com:3478` is free in all regions.**
- Confidence: high (pricing page) / medium (no separate ToS read). Design-critical: no.
- Source: https://www.twilio.com/en-us/stun-turn/pricing (footer 2026; "subject to change") ; https://www.twilio.com/docs/stun-turn (dateModified 2026-10-08).

**F-10. The default WebTorrent browser stack ships STUN-only (Google + Twilio STUN, no TURN), so a failed hole punch means no connection.**
- Confidence: high. Design-critical: **yes** (confirms we must add our own fallback/TURN story).
- Evidence: simple-peer 9.11.1 README default `config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }] }`; `@thaunknown/simple-peer` 10.1.2 (the fork WebTorrent 3.0.21 depends on, latest on npm) README is identical. bittorrent-tracker README exposes `rtcConfig: {}` for overrides. WebTorrent API doc: `maxConns` default 55, `webSeeds` default true (BEP19), `maxWebConns` default 4. simple-peer's data path sets `MAX_BUFFERED_AMOUNT = 64 * 1024` and `bufferedAmountLowThreshold` to that value.
- Sources: https://raw.githubusercontent.com/feross/simple-peer/master/README.md ; https://raw.githubusercontent.com/thaunknown/simple-peer/master/README.md and `lite.js` ; https://raw.githubusercontent.com/webtorrent/webtorrent/master/package.json (v3.0.21) and `docs/api.md` ; https://raw.githubusercontent.com/webtorrent/bittorrent-tracker/master/README.md (all read 2026-10-14).

### C. TURN: free/cheap options and credentials

**F-11. Cloudflare Realtime TURN: 1,000 GB/month free (shared with the SFU), then $0.05/GB egress; credentials must be minted with a server-side token and last at most 48 hours.**
- Confidence: high (three Cloudflare pages agree; one page's wording is older). Design-critical: **yes**.
- Endpoints (overview table): STUN `stun.cloudflare.com:3478/udp`; TURN `turn.cloudflare.com` UDP 3478 (alt 443), TCP 3478 (alt 80), TLS 5349 (alt 443). TLS 1.1/1.2/1.3.
- Price: "$0.05 per GB of data used", billed on bytes sent from the Cloudflare edge to the TURN client (including TURN overhead, after authentication); ingress free; TURN-to-SFU/Stream traffic not double charged. SFU pricing page (last updated 2026-09-22): "The first 1,000 GB each month is free ... SFU and TURN share this allowance; they do not have independent free tiers." The older-style TURN overview sentence ("free of charge when used together with the Realtime SFU", otherwise $0.05/GB) is less precise; the FAQ says "There is a free tier of 1,000 GB before any charges start". GA announcement 2024-09-25 (search snippet): service runs in all Cloudflare cities.
- Credentials: `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers`, header `Authorization: Bearer $TURN_KEY_API_TOKEN`, body `{"ttl": 86400}`; 201 response contains `iceServers` (STUN URL plus `turn:`/`turns:` URLs, `username`, `credential`). FAQ: expiry "up to 48 hours in the future ... a new credential must be generated at least every 48 hours"; expired in-use credentials are cut off "after a short delay". Revoke: `POST .../credentials/$USERNAME/revoke` returns 204. Docs: "You should keep your TURN key on the server side (don't share it with the browser/app)." `setConfiguration()` can refresh credentials mid-session. "There is no defined limit for credential issuance" (guidance: ramp from 500/s).
- Per-allocation limits (packet drops above): more than 5 new IPs/s, 5-10 kpps, 50-100 Mbps. Relay denies CreatePermission/ChannelBind to private IP ranges and BYOIP. Firewalled clients should allowlist 2a06:98c1:3200::1, 2606:4700:48::1, 141.101.90.1, 162.159.207.1 and track DNS changes within 14 days.
- Not found: any hard spend cap, per-key rate limiting, or acceptable-use terms about file sharing/BitTorrent.
- Sources: https://developers.cloudflare.com/realtime/turn/ ; https://developers.cloudflare.com/realtime/turn/faq/ ; https://developers.cloudflare.com/realtime/turn/generate-credentials/ ; https://developers.cloudflare.com/realtime/sfu/pricing (updated 2026-09-22) ; https://blog.cloudflare.com/webrtc-turn-using-anycast (2024-09-25, snippet only).

**F-12. Metered Open Relay: 20 GB/month free with sign-up; the credential-scoped `apiKey` is documented as safe for front-end use, the `secretKey` is not.**
- Confidence: high for the quoted docs; medium for behaviour at quota exhaustion (undocumented). Design-critical: **yes** (only provider found whose docs endorse client-side credential fetching).
- Evidence: Open Relay page (footer 2026): "The TURN Server provides 20 GB of free TURN Usage every month"; "you need to sign-up for a free account and obtain your API Key"; REST `https://<app>.metered.live/api/v1/turn/credentials?apiKey=API_KEY`; ports 80 and 443; TCP+UDP; TURNS with TLS. Docs (llms-turn-server.txt): `secretKey` "account-scoped, server-side only ... Never expose it in front-end code"; `apiKey` "credential-scoped, safe for front-end use"; credential `expiryInSeconds` is a "hard cutoff ... including for calls already in progress"; recommended lifetime 48 h rotated every 24 h; new credentials take "up to 2 minutes" to propagate; free plan only `standard.relay.metered.ca` (regions are paid); "No bandwidth caps per allocation". Static-auth host `staticauth.openrelay.metered.ca` with the published secret `openrelayprojectsecret` exists for Nextcloud/Matrix-style setups (a public secret, so not a private quota).
- Conflicts: a DEV article claims 50 GB/month; every Metered page says 20 GB, so 50 GB is treated as outdated.
- Not found: Metered terms/acceptable-use text (BitTorrent/file sharing), paid per-GB prices, what happens when 20 GB is exhausted.
- Sources: https://www.metered.ca/tools/openrelay/ ; https://www.metered.ca/docs/llms-turn-server.txt ; https://www.metered.ca/docs/turn-server-service/overview (all current 2026-10-14).

**F-13. Twilio Network Traversal: STUN free; TURN $0.40/GB (US West, Germany), $0.60 (Singapore, Mumbai, Tokyo), $0.80 (Sydney, Sao Paulo); no free tier; tokens need an API key and server-side minting; default TTL 24 h.**
- Confidence: high. Design-critical: no (most expensive of the three).
- Evidence: pricing page lists the per-GB rates, "billed in megabyte" (unreconciled with per-GB rates), "subject to change", no free tier for TURN. Docs: POST `https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Tokens.json` authenticated with an API key SID/secret; "make this request only from your server"; "Unless you lower the duration, Network Traversal Service Tokens last 24 hours"; maximum TTL not stated. TURN: `global.turn.twilio.com:3478` (udp/tcp) and `:443?transport=tcp`.
- Sources: https://www.twilio.com/en-us/stun-turn/pricing (2026) ; https://www.twilio.com/docs/stun-turn (dateModified 2026-10-08).

**F-14. Time-limited TURN credentials cannot be minted safely without something that holds a secret; the options are a public-by-design key (Metered), build-time/CI minting, or a tiny edge function.**
- Confidence: high that a secret holder is required; medium on the option analysis (my synthesis). Design-critical: **yes**.
- Evidence: the TURN REST scheme (draft-uberti-behave-turn-rest-00, Justin Uberti, 2013-07-15, expired individual draft - not endorsed by the IETF, but it is what coturn-style deployments and Cloudflare's response format follow) sets username to `<expiry-unix-time>[:userid]` and password to `base64(hmac(secret, username))`, with the secret shared between the web service and the TURN server and `ttl` recommended at 86400 s. Anyone who knows the secret can mint credentials forever, so it cannot live in client code. Cloudflare ("keep your TURN key on the server side") and Twilio ("only from your server") say the same.
- Options (no provider offers anonymous unauthenticated TURN; Cloudflare's own docs imply authentication is required):

| Option | Runtime backend of ours? | What the client holds | Abuse exposure | Notes |
|---|---|---|---|---|
| A. Metered credential-scoped `apiKey` fetched by the loader | no | public-by-design key | anyone can drain the 20 GB/month | free; exhaustion behaviour undocumented; fits "no backend" |
| B. Scheduled CI job mints Cloudflare credential (ttl up to 172800 s = 48 h) every 12-24 h and republishes static `ice.json` | no (secret lives in CI) | a shared credential, public for up to 48 h | anyone can use it until expiry; revoke endpoint exists; free 1,000 GB then $0.05/GB; no hard cap found | needs billing alert; credential rotation must be seamless (clients should refetch before expiry) |
| C. Stateless edge function (Cloudflare Worker, Lambda) mints a short-TTL credential per visitor | yes, but tiny and DB-less | per-visitor credential | can add per-IP rate limit | the only design where the token never ships; literal violation of "no backend" - owner decision |
| D. Self-hosted coturn with `use-auth-secret` | yes (a VM) | per-visitor credential via the same function | per-user limits possible | contradicts the serverless goal |
| E. No TURN | no | nothing | none | failing pairs rely on web-seed fallback (see R-01) |

- Sources: https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00 (2013-07-15) [OLD: 2013] ; Cloudflare/Twilio/Metered pages in F-11..F-13.

### D. Relay policy, mDNS and what peers learn

**F-15. `iceTransportPolicy: "relay"` makes the browser use only relayed candidates: the remote peer sees the TURN server's address instead of yours, the TURN operator sees both endpoints, and every byte is metered.**
- Confidence: high. Design-critical: no (an optional privacy mode).
- Evidence: MDN: `"all"` (default) vs `"relay"`: "Only ICE candidates whose IP addresses are being relayed, such as those being passed through a TURN server, will be considered." `iceCandidatePoolSize` default 0. Firefox has an equivalent pref `media.peerconnection.ice.relay_only` (default false). The mDNS draft says an agent "MUST NOT form candidate pairs between its own relay candidates and remote mDNS candidates" so relay-only on our side pairs only with the remote's srflx/relay candidates. Relay-only without a working TURN server yields zero candidates and no connection.
- Sources: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection (current) ; https://rtcweb-wg.github.io/mdns-ice-candidates/draft-ietf-rtcweb-mdns-ice-candidates.html ; https://hg.mozilla.org/mozilla-central/raw-file/tip/modules/libpref/init/all.js.

**F-16. mDNS replaces private host-candidate IPs with `<uuid>.local` unless camera/mic permission was granted; it does not hide the public IP, and it can reduce same-LAN connectivity.**
- Confidence: high. Design-critical: **yes** (disclosure wording; LAN-peer expectations).
- Evidence:
  - Draft (draft-ietf-rtcweb-mdns-ice-candidates, updates RFC 8839, still an Internet-Draft in the working-group rendering): host IP replaced by a v4 UUID + `.local`; server-reflexive candidates are always generated; "an address that is already exposed to the Internet does not need to be protected by mDNS, as it can be trivially observed by the web server or remote endpoint"; implementations MAY leave IPv6 unconcealed; "a direct connection is still possible, but only if at least one side can properly resolve the provided mDNS candidates"; Chrome testing saw ICE success drop 2 % (relative) with mDNS on both sides, attributed mainly to failed hairpinning.
  - Chrome: PSA 2019-08-13: "expected to fully roll out in August 2019 as part of the Chrome 76 release" [OLD: 2019], "except those that have getUserMedia permissions", "mDNS does not work in all situations" (mDNS disabled or too many hops -> fallback to STUN, which may fail).
  - Firefox desktop: 74.0 (first offered 2020-03-10): "support for mDNS ICE". **Firefox for Android: Bugzilla 1581947 "Support mDNS hostname obfuscation on Android" is RESOLVED FIXED (target 149); commit "Enabling mDNS obfuscate host address by default for all platforms". The canonical mozilla-central `all.js` has `media.peerconnection.ice.obfuscate_host_addresses` = true with no Android exception.** Firefox 149.0 shipped 2026-03-24; its release notes do not mention it. Correction note: the gecko-dev GitHub mirror I read first still showed `false` on Android (stale); always use hg.mozilla.org for Gecko.
  - Safari/WebKit: see F-20.
  - Samsung Internet: Chromium-based; Samsung's enterprise-policy page references the Chromium flag `enable-webrtc-hide-local-ips-with-mdns`; no Samsung-specific WebRTC behaviour found.
- Sources: https://rtcweb-wg.github.io/mdns-ice-candidates/draft-ietf-rtcweb-mdns-ice-candidates.html ; https://groups.google.com/a/chromium.org/g/blink-dev/c/z5hSy6Rf_aE/m/amoojRkSAgAJ (2019-08-13) ; https://www.firefox.com/en-US/firefox/74.0/releasenotes/ (2020-03-10) ; https://bugzilla.mozilla.org/show_bug.cgi?id=1581947 ; https://www.firefox.com/en-US/firefox/149.0/releasenotes/ (2026-03-24) ; https://developer.samsung.com/browser/policy/web-rtc-local-ips-allowed-urls.html (snippet only).

**F-17. Whatever the browser, peers, STUN servers and trackers learn your public IP; VPN/proxy users may be exposed by split tunnelling or STUN bypass.**
- Confidence: high for peers/STUN/trackers; medium for the rest. Design-critical: **yes** (the loader must disclose this before connecting).
- Evidence: RFC 8828 modes: Mode 1 enumerate all interfaces (needs consent); Mode 2 default route plus associated private addresses (default "when user consent has not been obtained, Mode 2 SHOULD be used"); Mode 3 default route only, no private addresses; Mode 4 force proxy. Section 3: with a split-tunnel VPN, WebRTC "can reveal the VPN's public address alongside the ISP address" (called the most significant concern); with direct Internet access allowed, "WebRTC's STUN checks will bypass the proxy and reveal the public IP address". Signalling carries candidates: bittorrent-tracker's `websocket-tracker.js` puts generated offers (`params.offers`) into the announce message, so a WebSocket-tracker operator sees SDP with candidate addresses plus the infohash. **Inference (standard WebRTC behaviour, stats fields not re-verified here):** loader JS can read remote candidates through ICE events and `getStats()`, so a modified client or a hosted-site script that shares the loader's origin can harvest the IPs of everyone in the swarm. The IP + infohash pair tells any swarm member who is viewing which site.
- Sources: https://www.rfc-editor.org/rfc/rfc8828.html ; https://raw.githubusercontent.com/webtorrent/bittorrent-tracker/master/lib/client/websocket-tracker.js (v11.2.3).

### E. Browser-specific behaviour

**F-18. Support baseline: every target browser has unprefixed WebRTC data channels for years; a few APIs we would like are newer.**
- Confidence: high. Design-critical: no (but dictates feature-detect fallbacks).
- Evidence (MDN browser-compat-data and caniuse JSON read 2026-10-14; Edge/Samsung/Opera/Android Chrome mirror Chromium):

| API | Chrome | Firefox | Safari / iOS |
|---|---|---|---|
| `RTCPeerConnection` (unprefixed) | 56 | 44 | 11 |
| `RTCDataChannel` | 24 | 22 | 11 |
| `bufferedAmountLowThreshold` | 46 | 44 | 11 |
| `RTCPeerConnection.sctp` + `RTCSctpTransport.maxMessageSize` | 76 | 113 | 15.4 |
| `connectionState` | 72 | 113 | 11 |
| `restartIce()` | 77 | 70 | 14.1 |
| `setConfiguration()` (refresh TURN credentials) | 48 | 99 | 11 |
| `RTCIceTransport.getSelectedCandidatePair()` | 75 | 154 | 16.4 |
| Transferable `RTCDataChannel` | 130 | 144 | 15 |
| Screen Wake Lock (caniuse; Edge 84, Samsung Internet 14.0) | 84 | 126 | 16.4 |

  Legacy (EdgeHTML) Edge had no `RTCDataChannel`; Edge 79+ is Chromium. caniuse first-supported for `RTCPeerConnection`: Samsung Internet 4.0. Because `getSelectedCandidatePair()` reached Firefox only in 154, use `getStats()` for candidate-type telemetry.
- Sources: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/RTCPeerConnection.json , `RTCDataChannel.json`, `RTCSctpTransport.json`, `RTCIceTransport.json` ; https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/rtcpeerconnection.json and `wake-lock.json`.

**F-19. Chromium family (Chrome, Edge, Samsung Internet, Brave): mDNS since Chrome 76; pages with an open data channel are exempt from intensive timer throttling and from discard/Energy-Saver freezing.**
- Confidence: high for the documented exemptions; platform scope for Energy Saver freezing not stated. Design-critical: no.
- Evidence: Chrome 88 timer-throttling post (Jan 2021): intensive throttling (timers once per minute) needs "WebRTC is not in use", defined as "an RTCPeerConnection with an 'open' RTCDataChannel or a 'live' MediaStreamTrack"; MDN `setTimeout` repeats this. Page Lifecycle doc: hidden pages using WebRTC "won't be discarded" except under extreme resource constraints. Chrome Energy Saver freezing (Chrome 133, Feb 2025; post dated 2025-01-20): a group is frozen only if hidden and silent for over five minutes and CPU-intensive, and it must not provide audio/video conferencing - detected via microphone, camera, capture, "or an RTCPeerConnection with an 'open' RTCDataChannel or a 'live' MediaStreamTrack"; also exempt: Web USB/Bluetooth/HID/Serial, Web Locks or IndexedDB connections that block others. The post does not say whether it applies on Android. Chrome 57-era note (2017, search snippet) said Android already heavily throttles or kills background tabs, except those with audio or real-time connections [OLD: 2017].
- Sources: https://developer.chrome.com/blog/timer-throttling-in-chrome-88 (2021-01) ; https://developer.chrome.com/docs/web-platform/page-lifecycle-api ; https://developer.chrome.com/blog/freezing-on-energy-saver (2025-01-20) ; https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout .

**F-20. Safari/WebKit (all iOS browsers share this engine): ICE candidate filtering with mDNS is on by default; host candidates are exposed only after camera/mic permission; data-channel-only pages therefore get `.local` host candidates plus srflx/relay.**
- Confidence: high for current code; medium for history and for stable-release version numbers. Design-critical: **yes** (affects LAN peers and iOS reliability).
- Evidence (WebKit main, fetched 2026-10-14): `WebKit::LibWebRTCProvider` sets `m_supportsMDNS = true`; `PeerConnectionBackend` constructor sets `m_shouldFilterICECandidates = page->webRTCProvider().isSupportingMDNS()`; preference `ICECandidateFilteringEnabled` defaults to true; `RTCController::disableICECandidateFilteringForDocument` turns filtering off per origin (used when capture permission is granted); a debug assertion states that with filtering on every candidate is `.local`, `srflx` or `relay`. History [OLD: 2017-2018]: WebKit blog 2017-07-03 (Safari 11): "WebKit only exposes Server Reflexive and TURN ICE candidates ... When access is granted, WebKit will expose host ICE candidates"; "RTCPeerConnection and RTCDataChannel are available in any web view" (camera/mic are Safari-only). WebKit bug 174500 (reported 2017-07-14 by Lennart Grahl, RESOLVED FIXED 2018-06-07): data-channel-only apps had no host candidates; mDNS-UUID host names introduced as an experiment in r230290/r230307 (April 2018), "behind a runtime flag, off by default" in June 2018. Safari Technology Preview 54 and 74 notes list MDNS ICE candidate support (search snippet only). A Chromium PSA of Aug 2019 says Safari already supports mDNS (secondary). The first stable Safari/iOS release with mDNS on by default was not pinned. A webrtcHacks Safari guide (2018-09-07) notes iOS data channels worked but "local ICE candidates are missing by default, which breaks examples that send data between two peer connections on one device" [OLD: 2018].
- Socket cap: see F-31.
- Sources: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/mediastream/PeerConnectionBackend.cpp ; .../RTCController.cpp ; .../Source/WebKit/WebProcess/Network/webrtc/LibWebRTCProvider.cpp ; .../Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml ; https://webkit.org/blog/7763/a-closer-look-into-webrtc/ (2017-07-03) ; https://bugs.webkit.org/show_bug.cgi?id=174500 and `186302` ; https://webrtchacks.com/guide-to-safari-webrtc/ (2018-09-07).

**F-21. Safari Lockdown Mode disables `RTCPeerConnection` (WebKit source, independent tests) and, per WebKit's preference table, also Service Workers, IndexedDB, Cache API, Web Locks and WebTransport. The loader cannot run in Lockdown Mode unless the site is excluded.**
- Confidence: high for WebRTC; medium for the others (flag present in source; practical effect not device-tested). Design-critical: **yes**.
- Evidence: in WebKit main `UnifiedWebPreferences.yaml` (49 preferences flagged `disableInLockdownMode: true`; the file's last change at fetch time was commit f199f49 dated 2026-10-14) the entries include `PeerConnectionEnabled` ("WebRTC Peer Connection - Enable RTCPeerConnection"), `MediaDevicesEnabled`, `ServiceWorkersEnabled`, `ServiceWorkerInstallEventEnabled`, `ServiceWorkerNavigationPreloadEnabled`, `IndexedDBAPIEnabled` (status "embedder"), `CacheAPIEnabled`, `WebLocksAPIEnabled`, `WebTransportEnabled`, `WebGLEnabled`, `WebGPUEnabled`, `WebAudioEnabled`, `FileSystemEnabled`, `PushAPIEnabled`, `NotificationsEnabled`, `WebCodecsVideoEnabled`. Not in the list: `BroadcastChannelEnabled`, WebSocket. Independent confirmation: sevarg.net (iPadOS 16.0 beta, 2022-07-20): "WebRTC Data Channel, WebRTC getUserMedia, WebRTC Peer Connections" disabled; alexi.sh (updated 2026-06-08) lists RTCDataChannel and says Lockdown Mode was further hardened in iOS 17/18 [OLD: 2022 test]. Apple's support page (published 2026-09-14) says only that "Certain complex web technologies are blocked" and does not enumerate them. Per-site exclusion exists: iPhone/iPad Page Menu > Website Settings > turn off Lockdown Mode, or Settings > Privacy & Security > Lockdown Mode > Customize Web Sites; Mac Safari: the site's Settings > deselect "Enable Lockdown Mode".
- **Inference:** with `PeerConnectionEnabled` false the global `RTCPeerConnection` is absent, so `typeof RTCPeerConnection === "undefined"` plus `!("serviceWorker" in navigator)` is the detection signal; not device-tested here.
- Sources: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml (2026-10-14) ; https://support.apple.com/en-us/105120 (2026-09-14) ; https://www.sevarg.net/2022/07/20/ios16-lockdown-mode-browser-analysis/ ; https://alexi.sh/posts/lockdown-jsc .

**F-22. iCloud Private Relay interacted badly with WebRTC in 2021 (STUN revealed the real public IP); Apple said iOS 15.1 fixed it; one 2026 comment claims it regressed (unverified).**
- Confidence: low-medium. Design-critical: no.
- Source: https://webrtchacks.com/apples-not-so-private-relay-fails-with-webrtc/ (2021-09-27, updated for iOS 15.1 on 2021-10-27; comment dated 2026-04-14) [OLD: 2021].

**F-23. Firefox: mDNS on (desktop 74, Android per bug 1581947), ICE-TCP candidates enabled, 1 GiB local message limit, 2048 SCTP streams; Tor Browser turns WebRTC off.**
- Confidence: high (mozilla-central tip). Design-critical: no.
- Evidence (mozilla-central tip `all.js` / `DataChannelProtocol.h`, read 2026-10-14): `media.peerconnection.ice.tcp` = true; `ice.relay_only`, `ice.default_address_only`, `ice.no_host`, `ice.proxy_only*`, `turn.disable` all false; `default_iceservers` = "[]"; `use_document_iceservers` = true; `WEBRTC_DATACHANNEL_STREAMS_DEFAULT` and `MAX_NUM_STREAMS` = 2048; `WEBRTC_DATACHANNEL_MAX_MESSAGE_SIZE_LOCAL` = 1073741823; `..._REMOTE_DEFAULT` = 65536; `..._REMOTE` = 2147483637. Mozilla blog (2017-11-03) [OLD: 2017]: Firefox 57 added end-of-record handling so it "now supports receiving up to 1 GiB messages"; sending more than the peer allows throws `TypeError`. Tor Browser: profile sets `media.peerconnection.enabled` = false (search snippet of 2023 commits; whether `RTCDataChannel` is still exposed was not determined).
- Sources: https://hg.mozilla.org/mozilla-central/raw-file/tip/modules/libpref/init/all.js ; https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/sctp/datachannel/DataChannelProtocol.h ; https://blog.mozilla.org/webrtc/large-data-channel-messages/ (2017-11-03) ; https://archive.torproject.org/websites/lists.torproject.org/pipermail/tor-commits/2023-August/243975.html (snippet only).

**F-24. Brave: documentation and code disagree about the default WebRTC IP-handling policy; Tor windows block `RTCPeerConnection` outright; "Disable non-proxied UDP" would break UDP P2P.**
- Confidence: medium (conflict unresolved). Design-critical: **yes** (Brave is a required target).
- Evidence: Brave wiki "WebRTC Custom Settings" lists four policies: Default ("WebRTC has the right to enumerate all interfaces and bind them to discover public interfaces"), Default Public And Private Interfaces (default route; exposes the associated private address), Default Public Interface Only (default route; "doesn't expose any local addresses"), Disable Non-Proxied UDP ("WebRTC should only use TCP to contact peers or servers unless the proxy server supports UDP"). It states Default applies when Fingerprinting Protection is off (not Tor), and "Disable Non-Proxied UDP is the default when Fingerprinting Protection is on and when you are using a Tor tab". The Fingerprinting Protections wiki page (last edited 2026-01-07) never mentions WebRTC. brave-core code (Sourcegraph, repo last fetched 2026-10-14 20:00 ET, non-exhaustive search): `kWebRTCIPHandlingPolicy` is touched only by the settings handler, the Android pref bridge, the prefs allow-list and `TorProfileManager::InitTorProfileUserPrefs` (sets `blink::kWebRTCIPHandlingDisableNonProxiedUdp`); I found no code tying the Shields fingerprinting level to the policy. A Brave patch to Blink's `rtc_peer_connection.cc` makes the constructor throw `NotAllowedError` ("RTCPeerConnection is not allowed") in Tor contexts and in the AI-chat code sandbox, with the comment "CSP cannot block WebRTC (ICE uses UDP)". Community posts (2019-2022, non-authoritative): the uBlock Origin option "Prevent WebRTC from leaking local IP addresses" used to force this setting (uBlock's wiki says the option was removed from desktop in v1.38 and remains on Android Firefox); users report "Disable non-proxied UDP" makes WebRTC fail unless a proxy is used.
- **Resolution status:** unresolved. If the wiki is right, default Brave blocks UDP P2P and our data channels would depend on TURN over TCP/TLS; if the code search is right, default is Chromium's `default`. Test on a real Brave (desktop and Android) before launch; Brave on iOS uses WebKit (inference).
- "Default Public Interface Only" hides local addresses (no host candidates), so same-LAN peers lose the host path and need NAT hairpinning through their public addresses, or TURN.
- Sources: https://github.com/brave/brave-browser/wiki/WebRTC-Custom-Settings ; https://github.com/brave/brave-browser/wiki/Fingerprinting-Protections (2026-01-07) ; https://raw.githubusercontent.com/brave/brave-core/master/chromium_src/third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc ; https://raw.githubusercontent.com/brave/brave-core/master/browser/tor/tor_profile_manager.cc ; Sourcegraph stream search over brave/brave-core (2026-10-14 ET) ; https://community.brave.app/t/choosing-the-webrtc-ip-handling-policy-help-required-please/377955 (2022-04) ; https://github.com/gorhill/uBlock/wiki/Prevent-WebRTC-from-leaking-local-IP-address .

### F. RTCDataChannel limits, backpressure, SCTP negotiation

**F-25. Message size: Chrome/Edge/Samsung and Safari advertise 256 KiB, Firefox accepts about 1 GiB locally but assumes 64 KiB when the remote omits `a=max-message-size`; the usable size is the minimum of both sides. RFC 8831 still says to keep messages to 16 KB unless interleaving is available.**
- Confidence: high (source code + specs; two engines cross-checked by the independent MDN text). Design-critical: **yes** (message framing).
- Evidence:

| Engine | Local `max-message-size` advertised/accepted | Assumed if remote omits it | Where |
|---|---|---|---|
| Chromium (libwebrtc) | 262144 = `kSctpSendBufferSize` (`256 * 1024`) | RFC 8841 default 64 KiB | `api/sctp_transport_interface.h`; `pc/media_session.cc` calls `set_max_message_size(kSctpSendBufferSize)` and answers with `min(offer, kSctpSendBufferSize)` |
| WebKit (libwebrtc copy) | 262144 (identical constant) | same | WebKit `Source/ThirdParty/libwebrtc/.../sctp_transport_interface.h` |
| Gecko | `WEBRTC_DATACHANNEL_MAX_MESSAGE_SIZE_LOCAL` = 1073741823 | `..._REMOTE_DEFAULT` = 65536; remote values above 2147483637 are clamped | mozilla-central `DataChannelProtocol.h` |

  Negotiation (libwebrtc `pc/sdp_offer_answer.cc` ~5933-5946): remote value 0 ("any size") means use our own; otherwise `min(local, remote)`. Gecko likewise caps sends at the remote value and `send()` throws `TypeError` when exceeded (Blink also throws `TypeError: Trying to send message larger than max-message-size`). RFC 8841 (via MDN): "If the max-message-size attribute is not present in the SDP, a default value of 64 kilobytes is assumed. A value of 0 indicates that the endpoint can handle messages of any size". RFC 8831 section 6.6: "the sender SHOULD limit the maximum message size to 16 KB to avoid monopolization" as long as message interleaving (RFC 8260) is not supported. MDN (page modified 2026-06-22): "most modern browsers support sending messages of at least 256 kilobytes", but large messages cause head-of-line blocking across channels without interleaving. Read the negotiated value with `pc.sctp.maxMessageSize` (Chrome 76, Firefox 113, Safari 15.4); older browsers require parsing the remote SDP (Mozilla's example defaults to 65535). A secondary slide deck (tested on Chrome 134) lists Chrome 256 KiB, Firefox 1 GiB, Safari 256 KiB, consistent with the code. A historic Firefox-to-Chrome pairing negotiating 16 KiB is mentioned in a webrtc-adapter note (search snippet) [OLD].
- Sources: https://webrtc.googlesource.com/src/+/refs/heads/main/api/sctp_transport_interface.h , `pc/media_session.cc`, `pc/sdp_offer_answer.cc` ; https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/sctp/datachannel/DataChannelProtocol.h ; https://www.rfc-editor.org/rfc/rfc8831.html (Jan 2021) ; https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels (2026-06-22) ; https://blog.mozilla.org/webrtc/large-data-channel-messages/ (2017-11-03).

**F-26. Backpressure: Chrome and Safari throw `OperationError` when `bufferedAmount` + the new message would exceed 16 MiB; `bufferedamountlow` fires on the downward crossing of `bufferedAmountLowThreshold` (default 0).**
- Confidence: high. Design-critical: **yes** (a sender without backpressure will throw or stall).
- Evidence: libwebrtc `DataChannelInterface::MaxSendQueueSize()` returns `16 * 1024 * 1024` (also in WebKit's copy); Blink `RTCDataChannel::ValidateSendLength` throws `TypeError` for length > maxMessageSize and `OperationError` "RTCDataChannel send queue is full" when `buffered_amount_ + length > MaxSendQueueSize()`; WebKit `RTCDataChannel.cpp` throws `OperationError` "Trying to send too much data" via `computeNewBufferedAmount` against the same 16 MiB; WebKit fires `bufferedamountlow` when the amount goes from above the threshold to at or below it. libwebrtc also caps queued *received* data at 16 MiB (`kMaxQueuedReceivedDataBytes`). dcSCTP itself has an unbounded send buffer (`max_send_buffer_size = SIZE_MAX`), so the 16 MiB limit is enforced at the data-channel layer. MDN: closing a channel does not reset `bufferedAmount`. simple-peer's pattern: threshold and high-water both 64 KiB. A simple-peer issue (feross/simple-peer #895, search snippet) reports "send queue is full" when streaming 240 MB without waiting, and a stall near 80 MB when sending only from `bufferedamountlow` (anecdotal; cause not established).
- Sources: https://webrtc.googlesource.com/src/+/refs/heads/main/api/data_channel_interface.cc ; https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/peerconnection/rtc_data_channel.cc ; https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/mediastream/RTCDataChannel.cpp ; https://webrtc.googlesource.com/src/+/refs/heads/main/pc/sctp_data_channel.cc , `media/sctp/dcsctp_transport.cc` ; https://raw.githubusercontent.com/thaunknown/simple-peer/master/lite.js ; https://github.com/feross/simple-peer/issues/895 (snippet only).

**F-27. Channels per connection: the protocol allows 65535 SCTP streams; implementations differ and a 2021 desktop test found far fewer in practice. Without interleaving, one bulk transfer delays every other channel on the same association.**
- Confidence: medium. Design-critical: no.
- Evidence: RFC 8831 section 6.2: streams negotiated at association setup "SHOULD be 65535"; libwebrtc `kMaxSctpStreams = 65535` and `max_sctp_streams` defaults to it; Gecko `MAX_NUM_STREAMS` = 2048. TensorWorks (2021-02-05, Chrome 87 / Firefox 83 on Windows and Linux, loopback): maximum data channels per peer connection 512 (Chrome) and 128 (Firefox), failing gracefully; resource limits often hit first [OLD: 2021, and Firefox's current constant is 2048, so its figure is likely outdated]. HOL blocking: see F-25.
- Sources: https://www.rfc-editor.org/rfc/rfc8831.html ; https://tensorworks.com.au/blog/webrtc-stream-limits-investigation/ (2021-02-05).

**F-28. ICE consent freshness: checks every 4-6 s, consent expires after 30 s without a valid response, after which the endpoint must stop sending until ICE restarts.**
- Confidence: high (RFC 7675). Design-critical: no, but it bounds how long dead mobile peers look alive.
- Evidence: RFC 7675 section 5/5.1: "Consent expires after 30 seconds"; interval randomised 0.8-1.2 x 5 s; implementations MUST NOT check less often than every 4 s; after expiry "the endpoint MUST cease transmission on that 5-tuple" and needs a new session or ICE restart. RFC 8831 section 5: the ICE/UDP layer handles IP address changes without DTLS/SCTP involvement. **Inference:** a suspended phone looks "connected" to its peers for up to about 30 s; a resumed tab must restart ICE or reconnect.
- Source: https://www.rfc-editor.org/rfc/rfc7675.html .

**F-29. Real-world libraries cluster at 16-64 KiB per message; none send near the 256 KiB maximum.**
- Confidence: medium. Design-critical: no.
- Evidence: p2p-media-loader-core (the P2P layer used with PeerTube-style players; search-level README): `webRtcMaxMessageSize` default `64 * 1024 - 1`, "Set it to 16KiB for older browsers support". simple-peer: 64 KiB buffer threshold. BitTorrent request blocks are conventionally 16 KiB (**inference** from the protocol convention; not re-verified in this run).
- Source: https://app.unpkg.com/p2p-media-loader-core@3.0.1/files/README.md (search result; not opened in full) ; https://raw.githubusercontent.com/thaunknown/simple-peer/master/lite.js .

**F-30. One developer reported in Nov 2025 that data-channel transfers of "a few MB" stall on iPhone Safari; WebKit engineers called it "an implementation restriction or a bug".**
- Confidence: low (single anecdotal report, no iOS version, no repro). Design-critical: no (watch item).
- Source: https://lists.w3.org/Archives/Public/public-webrtc/2025Nov/0024.html (2025-11-28; quoted replies from Youenn Fablet and Tim Panton).

### G. How many connections per tab

**F-31. Hard caps exist but are far above what a phone can sustain: Chromium 500 live `RTCPeerConnection`s per renderer and 3000 P2P sockets; WebKit closes the oldest RTC socket above 256 per web process. No published mobile benchmark of a practical number was found.**
- Confidence: high for the caps (source); low for any "practical" number. Design-critical: **yes** (Safari cap interacts with our peer count).
- Evidence: Blink `rtc_peer_connection.cc`: "The maximum number of PeerConnections that can exist simultaneously. `const int64_t kMaxPeerConnections = 500;`" - constructor throws `Cannot create so many PeerConnections` when the live counter exceeds it. Chromium network service `services/network/p2p/socket_manager.cc`: `kMaxSimultaneousSockets = 3000` ("Trouble has been seen on Linux at 3479 sockets in test, so leave a margin"). WebKit `NetworkRTCProvider.h`: `maxSockets { 256 }`, and `NetworkConnectionToWebProcess` lazily creates one `NetworkRTCProvider` per web-process connection (so the cap is per web process); `addSocket` logs "too many sockets, closing <id>" and closes the first entry of an ordered map (the lowest identifier, i.e. the oldest if ids are monotonic - **inference**), which silently breaks that connection. **Inference:** each peer connection opens roughly one UDP socket per local network (IPv4, IPv6, cellular, ...) plus TURN/TCP sockets, so about 50-100 connections is the realistic Safari ceiling per tab (the per-connection socket count was not measured). Gecko: no explicit peer-connection cap found in the prefs I read (not exhaustively searched). Edge/Samsung Internet inherit Chromium.
- Sources: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc ; https://chromium.googlesource.com/chromium/src/+/refs/heads/main/services/network/p2p/socket_manager.cc ; https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/NetworkProcess/webrtc/NetworkRTCProvider.h and `.cpp` (all fetched 2026-10-14).

**F-32. WebTorrent's tracker client generates one `RTCPeerConnection` per offer, up to 5 offers per announce, every 30 s, with a 50 s offer timeout; this is the practical source of connection pressure on phones.**
- Confidence: high. Design-critical: **yes**.
- Evidence: bittorrent-tracker 11.2.3 `websocket-tracker.js`: `numwant = Math.min(opts.numwant, 5)` ("Limit the number of offers that are generated, since it can be slow"), `OFFER_TIMEOUT = 50 * 1000`, `DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000`, each offer creates `_createPeer({ initiator: true })`. WebTorrent 3.0.21 defaults: `maxConns` 55 per torrent, `webSeeds` true. WebTorrent issue #1349 (opened 2018-04-09, still open): "Failed to construct 'RTCPeerConnection': Cannot create so many PeerConnections" after about 6 active torrents on Chrome 65; reporters saw up to 44 connections in `chrome://webrtc-internals`; a commenter blamed a Chrome 65 candidate-GC leak (Chromium bug 825576); mitigation was `numwant=5` and nulling closed peers [OLD: 2018]. Arithmetic: 3 trackers x 1 torrent = up to 15 new connections every 30 s, and in the worst case up to 30 can be pending at once (10 per tracker: two overlapping announces of 5 offers, given the 50 s timeout and 30 s interval).
- Sources: https://raw.githubusercontent.com/webtorrent/bittorrent-tracker/master/lib/client/websocket-tracker.js ; https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/api.md ; https://github.com/webtorrent/webtorrent/issues/1349 (2018-04-09) .

### H. Mobile lifecycle: backgrounding and screen lock

**F-33. iOS: data-only WebRTC does not survive backgrounding or screen lock; WebKit grants the web process about 20 s to wind down; there is no web-platform workaround other than staying visible.**
- Confidence: medium-high that it dies; low on exact timing (not measured, no official Safari-specific document). Design-critical: **yes** (a mobile visitor contributes only while the tab is foregrounded).
- Evidence:
  1. Apple DTS (Quinn, Apple Developer Forums, Sep 2025, "Recommended" answer, native-app context): "(almost) everything works like it does in the foreground as long as your app is running. Once your app gets suspended, however, all low-level networking stops"; "If a UIApplication background task, or indeed any other subsystem, keeps your app from suspending, networking will work just fine." Footnote: with the screen locked "the device might eventually get around to turning off Wi-Fi". Search-level: other DTS answers say the key factor "is not foreground/background but running/suspended".
  2. Apple Developer Forums, Feb 2025 (no replies): "in iOS Safari, these technologies [WebRTC, Web Audio] are suspended as soon as the screen locks or Safari goes into the background" (a developer's claim, not Apple's).
  3. WebKit `ProcessThrottler.cpp` (main): `processSuspensionTimeout { 20_s }` - when the process should be suspended it is first sent a prepare-to-suspend message and given a timer "so it can't stay running in the background for too long"; `removeAllAssertionsTimeout { 4_min }` for dropping a near-suspended assertion; `processAssertionCacheLifetime { 1_s }`. These are UI-process policy; iOS performs the actual suspension; the semantics of "near-suspended" were not documented in what I read.
  4. WebKit bugs: 226620 (mic capture stops when a WKWebView app backgrounds; closed "configuration changed" - only audio-background-mode apps keep capture), 231105 (AudioContext suspended on background; iOS part split into a follow-up). Neither covers data channels.
  5. Search-level developer reports: WebSocket objects after screen lock can report `readyState` open while `send()`/`close()` do nothing (graphql-ws discussion #290); one developer write-up says iOS often closes the socket of a background page after about a minute, though it varies (paraphrase of a search snippet, not a measurement).
  6. Screen Wake Lock works on iOS Safari 16.4+ but is released when the page is hidden and must be re-acquired on `visibilitychange` (reading-based notes in a third-party issue; consistent with the API design).
  7. Memory: a third-party write-up (reading-based, "not measured yet") quotes about 1.5-3 GB before Safari reloads a tab on recent iPhones; low confidence.
- Sources: https://developer.apple.com/forums/thread/799259 (Sep 2025) ; https://developer.apple.com/forums/thread/774239 (Feb 2025) ; https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/ProcessThrottler.cpp ; https://bugs.webkit.org/show_bug.cgi?id=226620 and `231105` ; https://github.com/enisdenjo/graphql-ws/discussions/290 (snippet only) ; https://github.com/Nehanth/pooled/issues/207 (2026, low confidence).

**F-34. Android Chrome/Chromium: documented exemptions cover pages with an open data channel, but no authoritative source or measurement says what happens to an open data channel when the screen locks; Doze can suspend all network access.**
- Confidence: high for the documented facts, low for actual behaviour. Design-critical: **yes**.
- Evidence: Chrome documents (F-19) exemptions from intensive throttling, discarding and Energy-Saver freezing for pages with an open data channel; the freezing post does not say whether Android is covered. Android Doze (developer.android.com): "If a user leaves a device unplugged and stationary for a period of time, with the screen off, the device enters Doze mode"; in Doze the system "Suspends network access" except in periodic maintenance windows that become rarer over time; App Standby: idle apps get network access "about once a day"; foreground services are not listed as an exemption. A 2026 project issue (swarmllm #44) lists Android Chrome as "untested", i.e. I found no public field data. No evidence about Samsung Internet specifically.
- Sources: https://developer.android.com/training/monitoring-device-state/doze-standby ; https://developer.chrome.com/blog/freezing-on-energy-saver ; https://github.com/Nehanth/swarmllm/issues/44 (2026-09).

**F-35. Firefox for Android applies a 15-minute minimum timer delay to inactive tabs and "may unload them entirely"; desktop Firefox 1 s.**
- Confidence: high (MDN). Design-critical: **yes** (timer-based heartbeats and reconnect logic will not run).
- Source: https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout (current).

**F-36. `visibilityState` becomes `hidden` when the tab is backgrounded, the window is minimised, or "the device's screen is off", so `visibilitychange` is the portable cue for "we are about to lose connectivity".**
- Confidence: high. Design-critical: no.
- Source: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API (current). The page does not contain the often-quoted advice to prefer `visibilitychange` over `unload` on mobile.

### I. Architecture constraints from the WebRTC platform

**F-37. `RTCPeerConnection` exists only on the window; it is absent in workers and service workers. `RTCDataChannel` can be transferred to dedicated workers (Chrome 130, Firefox 144, Safari 15), and per WebKit's position also to service workers - but Chromium says it may never support service workers.**
- Confidence: high for the spec exposure and BCD versions; medium for the Safari service-worker transfer claim (second-hand from a Blink intent thread). Design-critical: **yes**.
- Evidence: W3C WebRTC editor's draft (fetched 2026-10-14): `[Exposed=Window] interface RTCPeerConnection`, `RTCSctpTransport`, `RTCIceTransport`; `[Exposed=(Window,DedicatedWorker), Transferable] interface RTCDataChannel`. Chromium issue 40251342 "Using WebRTC inside Service Worker" and w3c/webrtc-extensions #77 "Create RTCPeerConnections in workers" (search snippets: not shipped). Blink intent to ship (thread 2024-08-14): "Shipping on desktop 130 / Android 130"; Chromium is "only looking to add transfers to DedicatedWorkers"; service workers "would require significant architectural changes ... and might never be supported"; WebKit "supports transfers to DedicatedWorkers and to ServiceWorkers"; the thread calls the divergence "an interoperability risk". Firefox: bug 1209163 RESOLVED FIXED for 144, release-noted (the 2024 thread's "no signal" for Gecko is superseded).
- Consequence: the Service Worker that serves the site cannot own WebTorrent's peers; it must ask a controlling page (or a dedicated worker holding a transferred channel) for bytes via `postMessage`/`MessageChannel`.
- Sources: https://w3c.github.io/webrtc-pc/ (fetched 2026-10-14) ; https://issues.chromium.org/issues/40251342 and https://github.com/w3c/webrtc-extensions/issues/77 (snippets) ; https://www.mail-archive.com/blink-dev@chromium.org/msg11145.html (2024-08-14) ; https://bugzilla.mozilla.org/show_bug.cgi?id=1209163 ; BCD `RTCDataChannel.transferable`.

**F-38. CSP cannot restrict WebRTC, so a hosted (untrusted) site can always open its own peer connections: it learns the visitor's public IP via any STUN server, and can exfiltrate data to an arbitrary peer, regardless of `connect-src`.**
- Confidence: medium (absence of a directive in BCD plus Brave's engineering comment; exfiltration over WebRTC is a known technique, not re-tested). Design-critical: **yes** for the threat model.
- Evidence: MDN browser-compat-data lists no `webrtc` CSP directive (only `connect-src`, `sandbox`, etc. matched my search of the directive list). Brave's source comment: "CSP cannot block WebRTC (ICE uses UDP)". I found no iframe `sandbox` token or Permissions-Policy feature that disables `RTCPeerConnection`.
- Sources: https://raw.githubusercontent.com/mdn/browser-compat-data/main/http/headers/Content-Security-Policy.json ; Brave patch (F-24).

**F-39. Chrome 142 (late Oct 2025) added a Local Network Access permission prompt; the standards explainer says local WebRTC connections should be gated too, but whether that shipped is unconfirmed.**
- Confidence: low. Design-critical: no (watch item; could show a surprise prompt to visitors with LAN peers).
- Evidence: WICG explainer: "Local connection attempts that use WebRTC should also be gated behind the Local Network Access permission prompt." Secondary sources disagree on whether WebRTC is gated yet; Chrome 142 gating of fetch to loopback/private/`.local` targets is described by several vendor notes (search snippets).
- Sources: https://github.com/WICG/local-network-access/blob/main/explainer.md ; https://docs.beyondidentity.com/docs/resources/announcements/chrome-browser (snippet only).

## Recommendations for our design

Numbers marked (heuristic) are my engineering judgement, not sourced limits.

**R-01. Make WebRTC an accelerator, never the only path.** Every site and the database snapshot must have at least one non-WebRTC route: an HTTPS web seed (WebTorrent `webSeeds` is on by default, BEP19) on the static host or a second CDN, plus a read-only HTTPS snapshot of the log. Show the user a state line ("direct peers n / relayed m / web-seed only"). Rationale: F-01..F-05, F-10, F-21, F-24, F-33.

**R-02. ICE server list lives in a small config file the loader fetches at startup** (`ice.json`, not baked into the loader), default `stun:stun.cloudflare.com:3478` first, `stun:stun.l.google.com:19302` and `stun:global.stun.twilio.com:3478` as alternates (heuristic: at most three STUN URLs to keep candidate gathering short). Let users switch STUN off (LAN-only and relay-only modes). Disclose that the STUN operators see visitor IPs (F-07..F-09, F-17).

**R-03. TURN: choose a tier deliberately; never ship a secret.**
- Tier 0 (MVP): no TURN; failing pairs fall back to the web seed (R-01).
- Tier 1 (no backend of ours): Metered Open Relay credential-scoped `apiKey` in `ice.json` (20 GB/month free; abuse bounded by the quota), and/or a scheduled CI job that mints a Cloudflare TURN credential with `ttl` up to 172800 s every 12-24 h and republishes `ice.json` (1,000 GB/month free, then $0.05/GB; set a billing alert; use the revoke endpoint if scraped). Clients refetch `ice.json` before the 48 h limit and call `setConfiguration()` (Firefox 99+) or restart ICE.
- Tier 2: a ~30-line stateless edge function that mints per-visitor short-TTL credentials. Only design where the token never ships; it is a backend component, so it needs an explicit owner decision.
- Never put a Cloudflare TURN key/API token, Twilio auth token/API-key secret, or Metered `secretKey` in the loader (F-11..F-14).

**R-04. Treat relayed peers as control-only.** After a connection is up, read the selected candidate pair with `getStats()` (portable; `getSelectedCandidatePair()` is Firefox 154+). If either side is `relay`, use that peer for gossip and small messages only and fetch bulk pieces from the web seed. Illustrative cost arithmetic (assumptions: 20 % of connections relayed, 3 MB pulled from peers per visit, so 0.6 MB relayed per visit; decimal GB): Cloudflare free tier covers about 1.67 M visits/month and costs $30 per further million; Metered's 20 GB covers about 33,000 visits/month; Twilio costs about $240 per million visits. If only gossip (about 50 KB per visit) is relayed, the same free tiers cover 20 M and 400 k visits/month. These are arithmetic on assumed inputs, not measurements.

**R-05. Offer an opt-in "relay-only" privacy mode** (`iceTransportPolicy: "relay"`) only when a TURN tier is configured; explain that it hides your IP from peers but not from the relay operator or the tracker, and that it uses the shared relay budget (F-15).

**R-06. Data-channel framing and backpressure.**
- Application messages at most 16 KiB (RFC 8831 guidance; matches BitTorrent block size, **inference**); never exceed `min(pc.sctp?.maxMessageSize ?? 65535, 65535)` in any case. Use at most one reliable ordered channel for control/gossip and keep bulk pieces to a few in flight per peer so bulk transfers cannot delay gossip (F-25, F-27).
- Set `bufferedAmountLowThreshold` to 256 KiB, stop sending above 1 MiB buffered, resume on `bufferedamountlow`; wrap every `send()` in try/catch (`OperationError` when the 16 MiB queue is full, `TypeError` when above the negotiated maximum) (F-26). simple-peer's 64 KiB is also reasonable.
- Add an application-level ping every 10-15 s and treat a peer as dead after 2-3 misses; ICE consent can keep a dead peer "connected" for up to 30 s (F-28).

**R-07. Cap connections and pending offers.** Heuristic starting points: mobile 6-12 live peers, desktop up to WebTorrent's 55; never above about 50 in Safari (F-31); at most 2 trackers on mobile (each announce adds up to 5 new connections, F-32); close and null connections that fail ICE within 15-20 s; back off on `Cannot create so many PeerConnections`. Raise limits only after device testing.

**R-08. Lifecycle handling for phones.**
- On `visibilitychange` to `hidden` (also fires when the screen turns off): tell peers you are leaving, stop advertising as a seeder, stop sending.
- On `visible` / `pageshow`: check `connectionState` (use `iceConnectionState` on Firefox below 113), call `pc.restartIce()` (Chrome 77, Firefox 70, Safari 14.1) or re-announce to trackers and rebuild peers; refresh the log from a peer or the HTTPS snapshot (F-33..F-36).
- Offer an opt-in Screen Wake Lock for people who want to keep helping (Chrome/Edge 84, Safari 16.4, Firefox 126, Samsung 14); it only works while visible and costs battery.
- Do not rely on `setInterval` in background tabs (Firefox Android: 15 minutes; Chrome exempts WebRTC pages but not guaranteed on Android).
- Product consequence: "every visitor keeps the chain alive" is true only for foregrounded tabs; design liveness around desktops and web seeds, and treat phones as short-lived peers.

**R-09. Keep WebRTC on the page; use workers only through transferred channels.** Create `RTCPeerConnection`s on the main thread; if the data plane moves off-thread, transfer open `RTCDataChannel`s to a dedicated worker with feature detection and a main-thread fallback (Chrome 130+, Firefox 144+, Safari 15+). The Service Worker proxies requests to the controlling page via `MessageChannel`; it must not assume it can hold peers (F-37).

**R-10. Feature-detect and degrade with specific messages.**

| Observation | Likely cause | Action |
|---|---|---|
| `typeof RTCPeerConnection === "undefined"` | Safari Lockdown Mode, Tor Browser, very old browser | explain; for Lockdown Mode show the per-site exclusion steps; run in web-seed-only mode |
| `navigator.serviceWorker` missing | Lockdown Mode, private/blocked contexts | same as above |
| `new RTCPeerConnection()` throws `NotAllowedError` | Brave Tor window | web-seed-only mode |
| No srflx/relay candidate within about 5 s, `iceConnectionState` -> `failed` | UDP blocked, Brave "Disable non-proxied UDP", corporate firewall | suggest TURN-over-TLS config if available; else web-seed-only |
| `pc.sctp` undefined | Firefox below 113, Safari below 15.4 | assume 64 KiB limit; keep 16 KiB messages |

The site must still render in web-seed-only mode, so WebRTC is never a hard dependency for reading (F-21, F-24, F-23).

**R-11. Privacy disclosure (first load, plus a persistent link).** Draft for legal review (not legal advice):
> "This page loads websites from other visitors' browsers and keeps a shared database the same way. It uses BitTorrent over WebRTC to do that. To connect you to other visitors, your browser talks to third-party STUN servers (Cloudflare and Google by default) and to a tracker. Here is what that means for you. The other visitors you connect to can see your public IP address, and they can see that you are viewing this site. The tracker and the STUN servers see your IP address too. Most current browsers hide your private network address from peers, but none of them can hide your public one. A VPN or proxy might not cover WebRTC in some browsers. While this tab is open and visible, your device uploads data to other visitors, which uses your bandwidth and battery. You can switch to web-seed-only mode, where you connect to no peers at all, or to relay-only mode, where peers cannot see your IP but the relay operator can. Sites you open here can run code in your browser, including code that makes its own peer connections."

**R-12. Threat model for hosted sites.** Assume hosted-site JavaScript can use WebRTC regardless of CSP (F-38): it can learn the visitor IP and exfiltrate data over a data channel. Keep the loader's peer list, signing keys and IndexedDB out of the hosted site's reach (separate origin or an opaque-origin sandbox), and do not expose raw remote candidate addresses to hosted code.

**R-13. Test matrix and telemetry.**
- Devices/browsers: iPhone Safari (current iOS), iOS Chrome/Firefox/Brave (all WebKit), Android Chrome, Samsung Internet, Firefox for Android (149+), Brave (desktop, Android), desktop Chrome, Edge, Firefox, Safari.
- Network pairs: same Wi-Fi; different Wi-Fi; LTE/5G vs Wi-Fi; LTE vs LTE on different carriers (include a known-symmetric carrier if one can be found); IPv6-only/NAT64; corporate UDP-blocked; VPN full and split tunnel.
- Settings: Lockdown Mode on/off, Brave Shields standard/strict and each WebRTC policy, Firefox strict tracking protection, uBlock Origin, Tor Browser.
- Instrument, locally and opt-in aggregated: selected candidate-pair local/remote types, time-to-connect, failure reason, background-resume outcome. This yields the project's own relay share, which no public dataset provides (F-01).

**R-14. Next actions (ordered).**
1. Decide the TURN tier (0, 1, 2) and the web-seed fallback location.
2. Build a small connectivity-probe page (STUN-only, optional TURN) and run the R-13 matrix on real phones, especially LTE-to-LTE and iOS resume behaviour.
3. Test Brave's default WebRTC policy and Lockdown Mode behaviour on real devices to close the open questions below.
4. Finalise message framing/backpressure parameters (R-06) and peer caps (R-07) from that data.
5. Have the disclosure text (R-11) reviewed before launch.

## Gotchas

- **G-01. Lockdown Mode (Safari):** no `RTCPeerConnection`, and per WebKit's table no Service Workers or IndexedDB either; per-site exclusion is the only way in. Testers running Lockdown Mode will need the exclusion (F-21).
- **G-02. Brave:** docs say fingerprinting-protection-on defaults to "Disable non-proxied UDP"; code search found no such link; unresolved. Tor windows throw `NotAllowedError` (F-24).
- **G-03. Firefox Android:** mDNS was only recently enabled (bug 1581947, target 149) and timers in inactive tabs are clamped to 15 minutes (F-16, F-35). Do not trust the gecko-dev GitHub mirror for prefs - it was stale.
- **G-04. mDNS side effects:** `.local` names need multicast; guest/enterprise Wi-Fi often blocks it, and then same-LAN peers need NAT hairpinning or TURN (F-16). "Default public interface only" removes host candidates entirely (F-24).
- **G-05. Public IP is never hidden** by mDNS; peers, STUN servers and trackers all see it; split-tunnel VPNs can leak (F-17).
- **G-06. iOS:** a suspended tab looks connected to peers for up to about 30 s; sockets may report open but be dead; a Nov 2025 report says multi-MB data-channel transfers stall on Safari/iOS (F-28, F-30, F-33).
- **G-07. Android:** background behaviour of an open data channel is undocumented; Doze can suspend network access when the device is idle, unplugged and screen-off (F-34).
- **G-08. Connection caps:** Chromium 500 `RTCPeerConnection`s; WebKit silently closes the oldest RTC socket above 256; tracker offers create many short-lived connections (F-31, F-32).
- **G-09. Credentials expire hard:** Cloudflare (max 48 h) and Metered (`expiryInSeconds` is a hard cutoff, new credentials take up to 2 minutes to propagate) cut off in-use credentials; refresh early (F-11, F-12).
- **G-10. Billing details:** Cloudflare bills egress from the relay to the client, shares the 1,000 GB with its SFU, and the TURN overview page's older wording ("free when used with the SFU") differs from the FAQ and the 2026-09-22 pricing page; Twilio's pricing page says billed "in megabyte" but lists per-GB prices (F-11, F-13).
- **G-11. Relay terms unknown:** I did not find Cloudflare/Metered/Twilio acceptable-use text on file sharing/BitTorrent-style traffic; check before relying on them.
- **G-12. API availability:** `RTCPeerConnection` absent in workers/service workers; `connectionState` missing on Firefox below 113; `pc.sctp` missing below Chrome 76 / Firefox 113 / Safari 15.4 (F-18, F-37).
- **G-13. CSP and `sandbox` cannot stop hosted-site WebRTC** (F-38).
- **G-14. Chrome 142+ Local Network Access prompts** might appear for LAN peers if WebRTC gating ships (F-39).
- **G-15. iCloud Private Relay** interacted badly with WebRTC in 2021 (fixed in iOS 15.1 per the author; a 2026 comment claims regression) (F-22).
- **G-16. Old numbers:** the cellular NAT mapping data are from 2014-2016; the 2020 Tailscale post and the 2014 Google STUN statement are also dated; do not quote them as current rates.

## Open questions

1. What is the real relay share for this app, split by device class (iOS, Android, desktop) and network pair? No public dataset exists; needs R-13 telemetry.
2. Brave default policy: does the Shields fingerprinting level actually change the WebRTC IP-handling policy in current Brave (wiki says yes, code search says no)? Needs a real Brave test.
3. How long does an open data channel survive on iOS Safari after lock/background (seconds? up to the 4-minute near-suspended window?) in current iOS? Not measured anywhere I found.
4. What does Android Chrome / Samsung Internet / Firefox Android do to an open data channel on screen lock, with and without Wake Lock, Doze, battery saver? No authoritative source found.
5. Does Chrome's Local Network Access gating apply to WebRTC today, and does it prompt for mDNS/host-candidate LAN peers?
6. Which stable Safari/iOS release first enabled mDNS ICE candidates by default (STP 54-74 era, 2018-2019)? Not pinned.
7. Is `IndexedDB` actually unavailable in Safari Lockdown Mode (WebKit flags it `disableInLockdownMode` with status "embedder")? Needs a device test; it would break the persisted-chain design for those users.
8. Do Cloudflare/Metered/Twilio terms allow BitTorrent-style relayed traffic? Does Metered's free plan hard-stop at 20 GB? Does Cloudflare offer any hard spend cap? Does Twilio impose a maximum TTL?
9. Does Tor Browser 15 expose `RTCDataChannel` at all (profile sets `media.peerconnection.enabled` false)?
10. Practical maximum simultaneous peers on mid-range Android and older iPhones (CPU/battery/memory)? No benchmark found; the only caps found are Chromium 500 PCs / 3000 sockets and WebKit 256 sockets.
11. What is Firefox's behaviour under `privacy.resistFingerprinting` and Enhanced Tracking Protection strict for WebRTC? Not researched.
12. Does iCloud Private Relay still leak the real IP via WebRTC STUN in current iOS (2026 comment claims so)?
13. Current iOS behaviour of third-party iOS browsers (Chrome/Brave/Firefox on WebKit) under Lockdown Mode and Private Relay was not checked.

## Verification tail

- **Verified directly (primary source read this session):** Cloudflare, Twilio and Metered pricing and credential docs; libwebrtc, Blink, WebKit, mozilla-central and brave-core source for limits and defaults; RFC 7675, 8828, 8831 and the mDNS draft; Chrome and Android lifecycle docs; MDN compat data and caniuse; the three NAT measurement papers (full text extracted).
- **Not verified (nothing was run on a real device or network):** iOS and Android background survival of an open data channel; Brave's actual default policy; Lockdown Mode behaviour on device; mDNS on Firefox for Android in a shipped build; Chrome Local Network Access behaviour for WebRTC; provider terms of service; this app's real relay share.
- **Assumed or inferred (each labelled "inference" above):** browser ICE cannot port-spray; sockets per peer connection; IPv6 pinhole behaviour; the Safari service-worker channel transfer; that WebKit's debug assertions reflect release behaviour.

## Appendix A - Sources actually read (2026-10-14 unless stated)

Primary/spec/vendor documents:
- https://developers.cloudflare.com/realtime/turn/ ; /turn/faq/ ; /turn/generate-credentials/ ; https://developers.cloudflare.com/realtime/sfu/pricing (page: updated 2026-09-22)
- https://www.metered.ca/tools/openrelay/ ; https://www.metered.ca/docs/llms-turn-server.txt ; https://www.metered.ca/docs/turn-server-service/overview
- https://www.twilio.com/docs/stun-turn (dateModified 2026-10-08) ; https://www.twilio.com/en-us/stun-turn/pricing ; https://www.twilio.com/en-us/stun-turn
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels (2026-06-22) ; .../RTCSctpTransport/maxMessageSize ; .../RTCPeerConnection/RTCPeerConnection ; .../Window/setTimeout ; .../Page_Visibility_API
- https://www.rfc-editor.org/rfc/rfc8831.html (2021-01) ; /rfc8828.html ; /rfc7675.html ; https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00 (2013) ; https://rtcweb-wg.github.io/mdns-ice-candidates/draft-ietf-rtcweb-mdns-ice-candidates.html ; https://w3c.github.io/webrtc-pc/ (IDL read via curl)
- https://blog.mozilla.org/webrtc/large-data-channel-messages/ (2017-11-03) ; https://groups.google.com/a/chromium.org/g/blink-dev/c/z5hSy6Rf_aE/m/amoojRkSAgAJ (2019-08-13) ; https://www.mail-archive.com/blink-dev@chromium.org/msg11145.html (2024-08)
- https://www.firefox.com/en-US/firefox/74.0/releasenotes/ ; /149.0/releasenotes/ ; https://bugzilla.mozilla.org/show_bug.cgi?id=1581947 ; .../show_bug.cgi?id=1209163
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88 ; https://developer.chrome.com/docs/web-platform/page-lifecycle-api ; https://developer.chrome.com/blog/freezing-on-energy-saver (2025-01-20) ; https://developer.android.com/training/monitoring-device-state/doze-standby
- https://developer.apple.com/forums/thread/799259 (2025-09) ; https://developer.apple.com/forums/thread/774239 (2025-02) ; https://support.apple.com/en-us/105120 (2026-09-14) ; https://bugs.webkit.org/show_bug.cgi?id=174500 , 186302 , 226620 , 231105 , 175014 ; https://webkit.org/blog/7763/a-closer-look-into-webrtc/ (2017-07-03)
- https://github.com/brave/brave-browser/wiki/WebRTC-Custom-Settings ; .../wiki/Fingerprinting-Protections (2026-01-07) ; https://community.brave.app/t/choosing-the-webrtc-ip-handling-policy-help-required-please/377955 (2022)
- https://github.com/gorhill/uBlock/wiki/Prevent-WebRTC-from-leaking-local-IP-address ; https://github.com/WICG/local-network-access (explainer.md)

Source code read (raw files, grepped only):
- libwebrtc: https://webrtc.googlesource.com/src/+/refs/heads/main/ : `api/sctp_transport_interface.h`, `api/data_channel_interface.cc`, `pc/sdp_offer_answer.cc`, `pc/media_session.cc`, `pc/sctp_data_channel.cc`, `media/sctp/dcsctp_transport.cc`, `api/peer_connection_interface.h`
- Chromium: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ : `third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc`, `.../rtc_data_channel.cc`, `services/network/p2p/socket_manager.cc`
- WebKit (https://raw.githubusercontent.com/WebKit/WebKit/main/): `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`, `Source/WebCore/Modules/mediastream/{PeerConnectionBackend,RTCController,RTCDataChannel,RTCPeerConnection}.cpp`, `Source/WebCore/platform/mediastream/WebRTCProvider.{h,cpp}`, `Source/WebKit/WebProcess/Network/webrtc/LibWebRTCProvider.cpp`, `Source/WebKit/NetworkProcess/webrtc/NetworkRTCProvider.{h,cpp}`, `Source/WebKit/NetworkProcess/NetworkConnectionToWebProcess.{h,cpp}`, `Source/WebKit/UIProcess/ProcessThrottler.cpp`, `Source/ThirdParty/libwebrtc/Source/webrtc/api/{sctp_transport_interface.h,data_channel_interface.cc}`
- Gecko (canonical): https://hg.mozilla.org/mozilla-central/raw-file/tip/modules/libpref/init/all.js and `netwerk/sctp/datachannel/DataChannelProtocol.h` (the gecko-dev GitHub mirror was stale and was not relied upon)
- brave-core: `chromium_src/third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc`, `browser/tor/tor_profile_manager.cc`, Sourcegraph stream search over brave/brave-core (repo last fetched 2026-10-14 20:00 ET)
- WebTorrent stack: https://raw.githubusercontent.com/webtorrent/webtorrent/master/{package.json,docs/api.md} (v3.0.21), `.../bittorrent-tracker/master/{README.md,lib/client/websocket-tracker.js,package.json}` (v11.2.3), `.../feross/simple-peer/master/README.md` (9.11.1), `.../thaunknown/simple-peer/master/{README.md,lite.js}` (10.1.2)
- Compat data: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/{RTCPeerConnection,RTCDataChannel,RTCSctpTransport,RTCIceTransport}.json and `http/headers/Content-Security-Policy.json` ; https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/{rtcpeerconnection,wake-lock}.json

Papers and measurements:
- https://arxiv.org/html/2510.27500v1 ; https://arxiv.org/abs/2604.12484 ; https://arxiv.org/html/2604.12484v1 ; PDF text of arXiv 2604.12484, https://www.prichter.com/imc176-richterA.pdf , https://arxiv.org/pdf/2311.04658
- https://tailscale.com/blog/how-nat-traversal-works (2020-08-21) ; https://tensorworks.com.au/blog/webrtc-stream-limits-investigation/ (2021-02-05)
- https://getstream.io/resources/projects/webrtc/advanced/stun-turn/ ; https://bloggeek.me/webrtc-turn/ (2025-11-10) ; https://groups.google.com/g/discuss-webrtc/c/shcPIaPxwo8/m/F8Vc8QlIyn0J (2014-06-18)
- https://www.theregister.com/2026/04/17/ipv6_50_percent_google/ ; https://www.sevarg.net/2022/07/20/ios16-lockdown-mode-browser-analysis/ ; https://alexi.sh/posts/lockdown-jsc (2026-06-08) ; https://webrtchacks.com/guide-to-safari-webrtc/ (2018-09-07) ; https://webrtchacks.com/apples-not-so-private-relay-fails-with-webrtc/ (2021-09-27)
- https://lists.w3.org/Archives/Public/public-webrtc/2025Nov/0024.html ; https://github.com/webtorrent/webtorrent/issues/1349 ; https://github.com/Nehanth/pooled/issues/207 and https://github.com/Nehanth/swarmllm/issues/44 (third-party notes, low confidence)

Search-result snippets only (not opened; used for context, labelled "snippet only" above): Cloudflare TURN GA blog (2024-09-25), Internet Society Pulse IPv6 post, Twilio/Forasoft/DEV relay-share guides, graphql-ws discussion #290, simple-peer #895, Samsung Internet policy page, p2p-media-loader README, Tor Browser 2023 commit archives, Chromium issue 40251342, w3c/webrtc-extensions #77, Beyond Identity Chrome 142 LNA note, WebKit STP 54/74 release notes.

## Appendix B - Claims checked and corrected or discarded

- "86 % direct / 14 % TURN (Uberti, Google I/O 2013)": not verifiable; discarded.
- Metered "50 GB/month" (DEV article): contradicted by Metered's own pages (20 GB); discarded.
- Gecko Android mDNS pref `false`: came from the stale gecko-dev mirror; mozilla-central tip and bug 1581947 say enabled; corrected.
- Brave wiki default vs brave-core code: left as an open conflict (F-24).
- Cloudflare TURN "free when used with SFU" (overview page) vs "1,000 GB free tier" (FAQ, pricing page updated 2026-09-22): the latter is used.
- Chromium 500-PeerConnection cap, first seen in an old WebKit-era diff and a forum answer: re-verified in current Blink source (`kMaxPeerConnections = 500`).
- Chrome 16 MiB send queue and Safari/Chrome 256 KiB message size, first seen in secondary posts: verified in libwebrtc and WebKit sources.
- GetStream "Chrome UMA 75-80 % direct": kept only as an unlinked vendor claim.
- Pending-offer arithmetic in F-32 corrected from 25 to 30 during drafting.
